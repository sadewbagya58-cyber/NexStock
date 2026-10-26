-- ============================================================================
-- NexStock Milestone 0 Foundation Migration — 0001_shared_foundation_rls.sql
-- TARGET ENGINE: PostgreSQL 15+ / Supabase SQL Editor (Step 1 of 2)
-- Specification Reference: NEX-DOC-04, NEX-DOC-05, NEX-DOC-07, NEX-DOC-08
-- ============================================================================
-- Properties:
--   1. Pure PostgreSQL SQL (no SQLite PRAGMA, AUTOINCREMENT, or STRICT syntax).
--   2. Reproducible and idempotent (safe to rerun).
--   3. Separates privileged schema migration owner from runtime role `nexstock_app_user`.
--   4. Enforces NOBYPASSRLS on `nexstock_app_user`.
--   5. Enforces fail-closed transaction-scoped RLS (`app.current_tenant_id`).
-- ============================================================================

-- 1. Create or verify non-superuser runtime role with NOBYPASSRLS (Supabase-compatible)
-- Note: In managed PostgreSQL (e.g. Supabase), the migration role (`postgres`) has CREATEROLE
-- but is not a PostgreSQL SUPERUSER (`rolsuper = false`). In PostgreSQL's `AlterRole` (user.c),
-- passing `SUPERUSER`/`NOSUPERUSER` or `BYPASSRLS`/`NOBYPASSRLS` to `ALTER ROLE` is restricted
-- to `rolsuper = true` and raises `42501: permission denied to alter role`.
-- `CREATE ROLE ... NOLOGIN` defaults to `NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`.
DO $$
DECLARE
  v_is_super boolean;
  v_can_login boolean;
  v_create_db boolean;
  v_create_role boolean;
  v_bypass_rls boolean;
  v_caller_is_super boolean;
BEGIN
  SELECT rolsuper INTO v_caller_is_super
  FROM pg_roles
  WHERE rolname = current_user;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexstock_app_user') THEN
    CREATE ROLE nexstock_app_user NOLOGIN;
  ELSE
    SELECT rolsuper, rolcanlogin, rolcreatedb, rolcreaterole, rolbypassrls
      INTO v_is_super, v_can_login, v_create_db, v_create_role, v_bypass_rls
    FROM pg_roles
    WHERE rolname = 'nexstock_app_user';

    IF v_can_login THEN
      ALTER ROLE nexstock_app_user NOLOGIN;
    END IF;

    IF v_create_db THEN
      ALTER ROLE nexstock_app_user NOCREATEDB;
    END IF;

    IF v_create_role THEN
      ALTER ROLE nexstock_app_user NOCREATEROLE;
    END IF;

    IF (v_is_super OR v_bypass_rls) THEN
      IF v_caller_is_super THEN
        ALTER ROLE nexstock_app_user NOSUPERUSER NOBYPASSRLS;
      ELSE
        RAISE EXCEPTION 'SECURITY_INVARIANT_VIOLATION: Existing role "nexstock_app_user" has rolsuper=% or rolbypassrls=%, and current_user "%" is not a superuser to revoke them.', v_is_super, v_bypass_rls, current_user;
      END IF;
    END IF;
  END IF;

  -- Post-condition security assertion: verify `nexstock_app_user` enforces RLS and least privilege
  IF NOT EXISTS (
    SELECT 1
    FROM pg_roles
    WHERE rolname = 'nexstock_app_user'
      AND rolsuper = false
      AND rolbypassrls = false
      AND rolcreatedb = false
      AND rolcreaterole = false
      AND rolcanlogin = false
  ) THEN
    RAISE EXCEPTION 'SECURITY_INVARIANT_VIOLATION: Role "nexstock_app_user" failed post-condition security check (must be NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS).';
  END IF;

  -- Ensure the migration/connection role (e.g. Supabase `postgres`) is a member of `nexstock_app_user`
  -- so transaction-scoped `SET LOCAL ROLE nexstock_app_user` is permitted.
  IF NOT pg_has_role(current_user, 'nexstock_app_user', 'MEMBER') THEN
    EXECUTE format('GRANT nexstock_app_user TO %I', current_user);
  END IF;
END
$$;

-- 2. Fail-Closed Session Context Helper Functions (NEX-DOC-05 Section 2)
CREATE OR REPLACE FUNCTION app_current_tenant_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_tenant_id', true), '')::uuid;
$$;

CREATE OR REPLACE FUNCTION app_current_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_user_id', true), '')::uuid;
$$;

-- 3. Immutable Ledger / Audit Table Trigger Function
CREATE OR REPLACE FUNCTION prevent_immutable_row_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'IMMUTABLE_TABLE_VIOLATION: Rows in table "%" are append-only and cannot be updated or deleted.', TG_TABLE_NAME;
END;
$$;

-- 4. SHARED Table: idempotency_keys (NEX-DOC-07 Section 3.2)
CREATE TABLE IF NOT EXISTS idempotency_keys (
  tenant_id uuid NOT NULL,
  idempotency_key uuid NOT NULL,
  actor_user_id uuid NOT NULL,
  endpoint text NOT NULL,
  request_hash char(64) NOT NULL,
  status text NOT NULL CHECK (status IN ('PROCESSING', 'COMPLETED')),
  response_status_code integer,
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, idempotency_key)
);

ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_keys FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON idempotency_keys;
CREATE POLICY tenant_isolation_policy ON idempotency_keys
  AS PERMISSIVE
  FOR ALL
  TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

-- 5. SHARED Table: outbox_events (NEX-DOC-02 Section 4.2 & NEX-DOC-03)
CREATE TABLE IF NOT EXISTS outbox_events (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  event_type text NOT NULL,
  payload_json jsonb NOT NULL,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PROCESSED', 'FAILED')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  processed_at timestamptz,
  PRIMARY KEY (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS idx_outbox_events_pending
  ON outbox_events (tenant_id, created_at ASC)
  WHERE status = 'PENDING';

ALTER TABLE outbox_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON outbox_events;
CREATE POLICY tenant_isolation_policy ON outbox_events
  AS PERMISSIVE
  FOR ALL
  TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

-- 6. SHARED Table: audit_logs (Strict Append-Only)
CREATE TABLE IF NOT EXISTS audit_logs (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  actor_user_id uuid NOT NULL,
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id uuid NOT NULL,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  trace_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_tenant_created
  ON audit_logs (tenant_id, id DESC);

DROP TRIGGER IF EXISTS audit_logs_immutable_trg ON audit_logs;
CREATE TRIGGER audit_logs_immutable_trg
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW
  EXECUTE FUNCTION prevent_immutable_row_mutation();

ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON audit_logs;
CREATE POLICY tenant_isolation_policy ON audit_logs
  AS PERMISSIVE
  FOR ALL
  TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

-- 7. SYNC Foundation Table: sync_command_log (NEX-DOC-08 Section 6.1)
CREATE TABLE IF NOT EXISTS sync_command_log (
  tenant_id uuid NOT NULL,
  command_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  device_id uuid NOT NULL,
  actor_user_id uuid NOT NULL,
  local_seq integer NOT NULL CHECK (local_seq >= 1),
  command_type text NOT NULL,
  status text NOT NULL CHECK (status IN ('APPLIED', 'APPLIED_WITH_CONFLICT_FLAG', 'QUARANTINED')),
  conflict_code text,
  response_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, command_id)
);

ALTER TABLE sync_command_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_command_log FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON sync_command_log;
CREATE POLICY tenant_isolation_policy ON sync_command_log
  AS PERMISSIVE
  FOR ALL
  TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

-- 8. SYNC Foundation Table: sync_conflicts (NEX-DOC-08 Section 5 & 6.3)
CREATE TABLE IF NOT EXISTS sync_conflicts (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  device_id uuid NOT NULL,
  command_id uuid NOT NULL,
  conflict_type text NOT NULL,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'QUARANTINED', 'RESOLVED', 'DISMISSED')),
  details_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  resolved_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, command_id) REFERENCES sync_command_log (tenant_id, command_id)
);

ALTER TABLE sync_conflicts ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_conflicts FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON sync_conflicts;
CREATE POLICY tenant_isolation_policy ON sync_conflicts
  AS PERMISSIVE
  FOR ALL
  TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

-- 9. Least-Privilege Grants to Runtime Role (`nexstock_app_user`)
GRANT USAGE ON SCHEMA public TO nexstock_app_user;
GRANT EXECUTE ON FUNCTION app_current_tenant_id() TO nexstock_app_user;
GRANT EXECUTE ON FUNCTION app_current_user_id() TO nexstock_app_user;

GRANT SELECT, INSERT, UPDATE ON TABLE idempotency_keys TO nexstock_app_user;
GRANT SELECT, INSERT, UPDATE ON TABLE outbox_events TO nexstock_app_user;
GRANT SELECT, INSERT ON TABLE audit_logs TO nexstock_app_user;
GRANT SELECT, INSERT, UPDATE ON TABLE sync_command_log TO nexstock_app_user;
GRANT SELECT, INSERT, UPDATE ON TABLE sync_conflicts TO nexstock_app_user;

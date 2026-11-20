-- ============================================================================
-- Migration 0030: Phase 10.5–10.9 — Subscription Enforcement, Platform Super
-- Admin Governance, MFA & Roles, Business Notifications, Plan Config Versioning,
-- SaaS Analytics Indexes, Monitoring Alerts & Backup Verification Ledger.
--
-- IMPORTANT:
-- - Additive & idempotent against existing Production schema (0001..0029).
-- - Preserves HR/Payroll V2 tables untouched.
-- - Enforces DB-backed Platform Admin roles, RLS isolation, and append-only
--   immutable platform_audit_logs (`prevent_immutable_row_mutation`).
-- ============================================================================

DO $$
DECLARE
  v_0029_applied integer;
BEGIN
  SELECT COUNT(*) INTO v_0029_applied FROM schema_migrations WHERE version = 29;
  IF v_0029_applied = 0 THEN
    RAISE EXCEPTION 'MIGRATION_ORDER_ERROR: Migration 0030 requires Migration 0029 to be applied first.';
  END IF;
END $$;

-- ============================================================================
-- 1. CENTRAL SUPPORT METADATA ON PLATFORM SETTINGS
-- ============================================================================

ALTER TABLE subscription_platform_settings
  ADD COLUMN IF NOT EXISTS support_email text NOT NULL DEFAULT 'support@nexstock.app',
  ADD COLUMN IF NOT EXISTS support_phone text NOT NULL DEFAULT '+94 11 200 0000',
  ADD COLUMN IF NOT EXISTS support_hours text NOT NULL DEFAULT 'Mon-Sat 08:30-18:00 IST';

-- ============================================================================
-- 2. PLATFORM ADMIN ACCOUNTS, ROLES & TOTP/MFA GOVERNANCE
-- ============================================================================

CREATE TABLE IF NOT EXISTS platform_admin_accounts (
  user_id uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  email text NOT NULL,
  platform_role text NOT NULL DEFAULT 'SUPER_ADMIN'
    CHECK (platform_role IN ('SUPER_ADMIN', 'BILLING_ADMIN', 'SUPPORT_ADMIN', 'ANALYST')),
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'SUSPENDED')),
  mfa_enforced boolean NOT NULL DEFAULT false,
  totp_enabled boolean NOT NULL DEFAULT false,
  totp_secret_base32 text,
  mfa_verified_until timestamptz,
  last_login_at timestamptz,
  created_by_user_id uuid REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- Seed DB-backed role rows for existing platform_admin users ONLY
INSERT INTO platform_admin_accounts (
  user_id, email, platform_role, status, mfa_enforced, totp_enabled
)
SELECT
  u.id,
  u.email,
  'SUPER_ADMIN',
  'ACTIVE',
  false,
  false
FROM users u
WHERE u.is_platform_admin = true
ON CONFLICT (user_id) DO NOTHING;

ALTER TABLE platform_admin_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_admin_accounts FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS platform_admin_accounts_self_or_admin ON platform_admin_accounts;
CREATE POLICY platform_admin_accounts_self_or_admin ON platform_admin_accounts
  AS PERMISSIVE
  FOR SELECT
  TO nexstock_app_user
  USING (user_id = app_current_user_id() OR app_is_platform_admin());

DROP POLICY IF EXISTS platform_admin_accounts_admin_write ON platform_admin_accounts;
CREATE POLICY platform_admin_accounts_admin_write ON platform_admin_accounts
  AS PERMISSIVE
  FOR ALL
  TO nexstock_app_user
  USING (app_is_platform_admin())
  WITH CHECK (app_is_platform_admin());

GRANT SELECT, INSERT, UPDATE ON TABLE platform_admin_accounts TO nexstock_app_user;

-- ============================================================================
-- 3. SUBSCRIPTION LIFECYCLE NOTIFICATIONS (DE-DUPLICATED PER TENANT)
-- ============================================================================

CREATE TABLE IF NOT EXISTS subscription_notifications (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  subscription_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type IN (
    'TRIAL_STARTED',
    'TRIAL_ENDING_SOON',
    'RENEWAL_APPROACHING',
    'PAYMENT_SUBMITTED',
    'PAYMENT_VERIFIED',
    'PAYMENT_REJECTED',
    'SUBSCRIPTION_UPGRADED',
    'DOWNGRADE_SCHEDULED',
    'DOWNGRADE_APPROACHING',
    'SUBSCRIPTION_EXPIRED',
    'GRACE_PERIOD_STARTED',
    'READ_ONLY_ACTIVATED',
    'RENEWAL_COMPLETED',
    'SUBSCRIPTION_SUSPENDED',
    'SUBSCRIPTION_RESTORED'
  )),
  dedupe_key text,
  severity text NOT NULL DEFAULT 'INFO'
    CHECK (severity IN ('INFO', 'WARNING', 'CRITICAL', 'SUCCESS')),
  title text NOT NULL,
  message text NOT NULL,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_read boolean NOT NULL DEFAULT false,
  read_at timestamptz,
  read_by_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, dedupe_key),
  FOREIGN KEY (tenant_id, subscription_id)
    REFERENCES tenant_subscriptions (tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sub_notifications_tenant_created
  ON subscription_notifications (tenant_id, is_read, created_at DESC);

ALTER TABLE subscription_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription_notifications FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON subscription_notifications;
CREATE POLICY tenant_isolation_policy ON subscription_notifications
  AS PERMISSIVE
  FOR ALL
  TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id() OR app_is_platform_admin())
  WITH CHECK (tenant_id = app_current_tenant_id() OR app_is_platform_admin());

GRANT SELECT, INSERT, UPDATE ON TABLE subscription_notifications TO nexstock_app_user;

-- ============================================================================
-- 4. PLAN CONFIG VERSION HISTORY (TRACEABILITY WITHOUT REWRITING PAST INVOICES)
-- ============================================================================

CREATE TABLE IF NOT EXISTS subscription_plan_config_history (
  id uuid PRIMARY KEY,
  plan_id uuid NOT NULL REFERENCES subscription_plans (id) ON DELETE CASCADE,
  plan_code text NOT NULL,
  version integer NOT NULL,
  changed_by_user_id uuid NOT NULL,
  previous_config_json jsonb NOT NULL,
  new_config_json jsonb NOT NULL,
  change_reason text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS idx_sub_plan_config_history_plan_created
  ON subscription_plan_config_history (plan_code, created_at DESC);

ALTER TABLE subscription_plan_config_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription_plan_config_history FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sub_plan_config_history_admin_only ON subscription_plan_config_history;
CREATE POLICY sub_plan_config_history_admin_only ON subscription_plan_config_history
  AS PERMISSIVE
  FOR ALL
  TO nexstock_app_user
  USING (app_is_platform_admin())
  WITH CHECK (app_is_platform_admin());

GRANT SELECT, INSERT ON TABLE subscription_plan_config_history TO nexstock_app_user;

-- ============================================================================
-- 5. IMMUTABLE PLATFORM AUDIT LOGS (CROSS-TENANT PRIVILEGED ACTIONS)
-- ============================================================================

CREATE TABLE IF NOT EXISTS platform_audit_logs (
  id uuid PRIMARY KEY,
  actor_user_id uuid NOT NULL,
  actor_role text NOT NULL,
  target_tenant_id uuid,
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id text NOT NULL,
  previous_state_json jsonb,
  new_state_json jsonb,
  correlation_id text NOT NULL,
  ip_address text,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS idx_platform_audit_logs_created
  ON platform_audit_logs (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_platform_audit_logs_tenant
  ON platform_audit_logs (target_tenant_id, created_at DESC);

DROP TRIGGER IF EXISTS platform_audit_logs_immutable_trg ON platform_audit_logs;
CREATE TRIGGER platform_audit_logs_immutable_trg
  BEFORE UPDATE OR DELETE ON platform_audit_logs
  FOR EACH ROW
  EXECUTE FUNCTION prevent_immutable_row_mutation();

ALTER TABLE platform_audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_audit_logs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS platform_audit_logs_admin_only ON platform_audit_logs;
CREATE POLICY platform_audit_logs_admin_only ON platform_audit_logs
  AS PERMISSIVE
  FOR ALL
  TO nexstock_app_user
  USING (app_is_platform_admin())
  WITH CHECK (app_is_platform_admin());

GRANT SELECT, INSERT ON TABLE platform_audit_logs TO nexstock_app_user;

-- ============================================================================
-- 6. PLATFORM SYSTEM ALERTS & BACKUP/INTEGRITY VERIFICATION LEDGER
-- ============================================================================

CREATE TABLE IF NOT EXISTS platform_system_alerts (
  id uuid PRIMARY KEY,
  event_category text NOT NULL CHECK (event_category IN (
    'LIFECYCLE_FAILURE',
    'PAYMENT_VERIFICATION_FAILURE',
    'WEBHOOK_FAILURE',
    'RENEWAL_FAILURE',
    'UNAUTHORIZED_ACCESS',
    'AUDIT_FAILURE',
    'BACKUP_FAILURE',
    'SYNC_ERROR',
    'DB_ERROR'
  )),
  severity text NOT NULL DEFAULT 'WARNING'
    CHECK (severity IN ('INFO', 'WARNING', 'CRITICAL')),
  status text NOT NULL DEFAULT 'OPEN'
    CHECK (status IN ('OPEN', 'ACKNOWLEDGED', 'RESOLVED')),
  tenant_id uuid,
  summary text NOT NULL,
  details_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  trace_id text,
  resolved_by_user_id uuid,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS idx_platform_system_alerts_status_created
  ON platform_system_alerts (status, created_at DESC);

ALTER TABLE platform_system_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_system_alerts FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS platform_system_alerts_admin_policy ON platform_system_alerts;
CREATE POLICY platform_system_alerts_admin_policy ON platform_system_alerts
  AS PERMISSIVE
  FOR ALL
  TO nexstock_app_user
  USING (app_is_platform_admin())
  WITH CHECK (app_is_platform_admin());

-- Allow runtime non-admin error hooks to record sanitized alerts safely without seeing other rows
DROP POLICY IF EXISTS platform_system_alerts_insert_hook ON platform_system_alerts;
CREATE POLICY platform_system_alerts_insert_hook ON platform_system_alerts
  AS PERMISSIVE
  FOR INSERT
  TO nexstock_app_user
  WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE ON TABLE platform_system_alerts TO nexstock_app_user;

CREATE TABLE IF NOT EXISTS backup_verification_runs (
  id uuid PRIMARY KEY,
  trigger_type text NOT NULL DEFAULT 'MANUAL_CHECK'
    CHECK (trigger_type IN ('MANUAL_CHECK', 'SCHEDULED_CHECK', 'SNAPSHOT_EXPORT')),
  triggered_by_user_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('VERIFIED', 'WARNING', 'FAILED')),
  tables_verified integer NOT NULL DEFAULT 0,
  rls_policies_verified integer NOT NULL DEFAULT 0,
  ledger_checks_passed boolean NOT NULL DEFAULT true,
  checksum_sha256 text NOT NULL,
  duration_ms integer NOT NULL DEFAULT 0,
  findings_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS idx_backup_verification_runs_created
  ON backup_verification_runs (created_at DESC);

ALTER TABLE backup_verification_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE backup_verification_runs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS backup_verification_runs_admin_only ON backup_verification_runs;
CREATE POLICY backup_verification_runs_admin_only ON backup_verification_runs
  AS PERMISSIVE
  FOR ALL
  TO nexstock_app_user
  USING (app_is_platform_admin())
  WITH CHECK (app_is_platform_admin());

GRANT SELECT, INSERT ON TABLE backup_verification_runs TO nexstock_app_user;

-- ============================================================================
-- 7. PERFORMANCE INDEXES FOR SAAS ANALYTICS & CROSS-TENANT GOVERNANCE
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_tenants_status_created
  ON tenants (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_tenant_subscriptions_status_plan
  ON tenant_subscriptions (status, plan_id);

CREATE INDEX IF NOT EXISTS idx_subscription_payments_paid_created
  ON subscription_payments (paid_at DESC);

-- Ensure platform admin can read tenant_memberships & branches & usage tables in Super Admin detail inspection
DROP POLICY IF EXISTS tenant_isolation_policy ON branches;
CREATE POLICY tenant_isolation_policy ON branches
  AS PERMISSIVE
  FOR ALL
  TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id() OR app_is_platform_admin())
  WITH CHECK (tenant_id = app_current_tenant_id() OR app_is_platform_admin());

DROP POLICY IF EXISTS tenant_isolation_policy ON tenant_memberships;
CREATE POLICY tenant_isolation_policy ON tenant_memberships
  AS PERMISSIVE
  FOR ALL
  TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id() OR user_id = app_current_user_id() OR app_is_platform_admin())
  WITH CHECK (tenant_id = app_current_tenant_id() OR app_is_platform_admin());

DROP POLICY IF EXISTS tenant_isolation_policy ON products;
CREATE POLICY tenant_isolation_policy ON products
  AS PERMISSIVE
  FOR ALL
  TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id() OR app_is_platform_admin())
  WITH CHECK (tenant_id = app_current_tenant_id() OR app_is_platform_admin());

DROP POLICY IF EXISTS tenant_isolation_policy ON product_media_assets;
CREATE POLICY tenant_isolation_policy ON product_media_assets
  AS PERMISSIVE
  FOR ALL
  TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id() OR app_is_platform_admin())
  WITH CHECK (tenant_id = app_current_tenant_id() OR app_is_platform_admin());

DROP POLICY IF EXISTS tenant_isolation_policy ON employee_documents;
CREATE POLICY tenant_isolation_policy ON employee_documents
  AS PERMISSIVE
  FOR ALL
  TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id() OR app_is_platform_admin())
  WITH CHECK (tenant_id = app_current_tenant_id() OR app_is_platform_admin());

DROP POLICY IF EXISTS tenant_isolation_policy ON expense_attachments;
CREATE POLICY tenant_isolation_policy ON expense_attachments
  AS PERMISSIVE
  FOR ALL
  TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id() OR app_is_platform_admin())
  WITH CHECK (tenant_id = app_current_tenant_id() OR app_is_platform_admin());

-- Also ensure Platform Admin can read stock_ledger_entries & sales_invoices cleanly for monitoring/verification
DROP POLICY IF EXISTS tenant_isolation_policy ON stock_ledger_entries;
CREATE POLICY tenant_isolation_policy ON stock_ledger_entries
  AS PERMISSIVE
  FOR ALL
  TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id() OR app_is_platform_admin())
  WITH CHECK (tenant_id = app_current_tenant_id() OR app_is_platform_admin());

-- Allow verified Platform Super Admins (`app_is_platform_admin()`) to provision secondary platform admins
-- while preserving strict self-elevation protection for non-admin users.
DROP POLICY IF EXISTS users_update_policy ON users;
CREATE POLICY users_update_policy ON users
  AS PERMISSIVE
  FOR UPDATE
  TO nexstock_app_user
  USING (
    app_is_platform_admin()
    OR id = app_current_user_id()
    OR (
      current_setting('request.jwt.claim.sub', true) IS NOT NULL
      AND id = NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid
    )
  )
  WITH CHECK (
    app_is_platform_admin()
    OR (
      is_platform_admin = false
      AND (
        id = app_current_user_id()
        OR (
          current_setting('request.jwt.claim.sub', true) IS NOT NULL
          AND id = NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid
        )
      )
    )
  );

-- ============================================================================
-- 8. REGISTER MIGRATION 30
-- ============================================================================

INSERT INTO schema_migrations (version, name, filename)
VALUES (
  30,
  '0030_phase10_5_9_enforcement_admin_analytics_security',
  '0030_phase10_5_9_enforcement_admin_analytics_security.sql'
)
ON CONFLICT (version) DO NOTHING;

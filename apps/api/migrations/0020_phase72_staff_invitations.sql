-- ============================================================================
-- NexStock Phase 7.2 Migration — 0020_phase72_staff_invitations.sql
-- TARGET ENGINE: PostgreSQL 15+ / Supabase SQL Editor
-- PREREQUISITE: Must be executed AFTER 0019_phase74_customer_credit.sql
-- Modules Covered: IAM, Staff Invitations, Account Provisioning, Employee Linking
-- Specification Reference: Phase 7.2 Advanced RBAC & Staff Authentication
-- ============================================================================

-- 1. Create tenant_invitations Table
CREATE TABLE IF NOT EXISTS tenant_invitations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  email text NOT NULL,
  role_code text NOT NULL DEFAULT 'STAFF',
  employee_id uuid REFERENCES employees (id) ON DELETE SET NULL,
  token_hash text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'ACCEPTED', 'EXPIRED', 'CANCELLED', 'FAILED')),
  invited_by_user_id uuid NOT NULL REFERENCES users (id),
  accepted_by_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- 2. Indexes
-- Ensure only one active PENDING invitation exists per tenant and email
CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_invitations_tenant_email_pending
  ON tenant_invitations (tenant_id, lower(email))
  WHERE status = 'PENDING';

CREATE INDEX IF NOT EXISTS idx_tenant_invitations_token_hash
  ON tenant_invitations (token_hash);

CREATE INDEX IF NOT EXISTS idx_tenant_invitations_tenant_status
  ON tenant_invitations (tenant_id, status);

CREATE INDEX IF NOT EXISTS idx_tenant_invitations_employee_id
  ON tenant_invitations (employee_id);

-- 3. Row Level Security
ALTER TABLE tenant_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_invitations FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON tenant_invitations;
CREATE POLICY tenant_isolation_policy ON tenant_invitations
  AS PERMISSIVE
  FOR ALL
  TO nexstock_app_user
  USING (
    tenant_id = app_current_tenant_id()
    OR app_current_tenant_id() IS NULL
  )
  WITH CHECK (
    tenant_id = app_current_tenant_id()
    OR app_current_tenant_id() IS NULL
  );

-- 4. Permissions
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE tenant_invitations TO nexstock_app_user;
GRANT DELETE ON TABLE tenant_memberships TO nexstock_app_user;

-- 5. Record completion of Migration 0020
INSERT INTO schema_migrations (version, name, filename)
VALUES (20, '0020_phase72_staff_invitations', '0020_phase72_staff_invitations.sql')
ON CONFLICT (version) DO UPDATE
  SET applied_at = clock_timestamp(),
      applied_by = current_user;

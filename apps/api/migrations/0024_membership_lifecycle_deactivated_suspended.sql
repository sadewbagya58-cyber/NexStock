-- ============================================================================
-- NexStock Migration - 0024_membership_lifecycle_deactivated_suspended.sql
-- TARGET ENGINE: PostgreSQL 15+ / Supabase SQL Editor
-- PREREQUISITE: Must be executed AFTER 0023_phase72_membership_revocation_lifecycle.sql
-- Modules Covered: IAM (Membership Lifecycle: ACTIVE, DEACTIVATED, SUSPENDED, REVOKED)
-- Specification Reference: BUG-067 & BUG-076 Remediation
-- ============================================================================

-- Preflight Check: Sequential migration verification
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = 23) THEN
    RAISE EXCEPTION 'MIGRATION_SEQUENCE_ERROR: Migration 0023 must be applied before 0024.';
  END IF;
END $$;

-- 1. Update status check constraint on tenant_memberships to include DEACTIVATED and SUSPENDED
ALTER TABLE tenant_memberships
  DROP CONSTRAINT IF EXISTS tenant_memberships_status_check;

ALTER TABLE tenant_memberships
  ADD CONSTRAINT tenant_memberships_status_check
  CHECK (status IN ('INVITED', 'ACTIVE', 'DISABLED', 'DEACTIVATED', 'SUSPENDED', 'REVOKED'));

-- 2. Add suspension_reason column to tenant_memberships if not already present
ALTER TABLE tenant_memberships
  ADD COLUMN IF NOT EXISTS suspension_reason text;

-- 3. Ensure partial unique index exists to allow multiple historical REVOKED memberships
-- while strictly enforcing at most one active/non-revoked membership per user per tenant
ALTER TABLE tenant_memberships
  DROP CONSTRAINT IF EXISTS tenant_memberships_tenant_id_user_id_key;

CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_memberships_unique_active_user
  ON tenant_memberships (tenant_id, user_id)
  WHERE status != 'REVOKED';

-- 4. Update user_tenants_select_policy on tenants to allow users to view tenants
-- where they hold any membership record (including DEACTIVATED, SUSPENDED, REVOKED)
-- so GET /v1/auth/me can discover membership status instead of showing onboarding wizard
DROP POLICY IF EXISTS user_tenants_select_policy ON tenants;
CREATE POLICY user_tenants_select_policy ON tenants
  AS PERMISSIVE
  FOR SELECT
  TO nexstock_app_user
  USING (
    EXISTS (
      SELECT 1 FROM tenant_memberships tm
      WHERE tm.tenant_id = tenants.id
        AND tm.user_id = app_current_user_id()
    )
  );

-- 5. Record migration execution in schema_migrations
INSERT INTO schema_migrations (version, name, filename)
VALUES (24, '0024_membership_lifecycle_deactivated_suspended', '0024_membership_lifecycle_deactivated_suspended.sql')
ON CONFLICT (version) DO NOTHING;

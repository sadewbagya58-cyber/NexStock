-- ============================================================================
-- NexStock Phase 7.2 Migration - 0023_phase72_membership_revocation_lifecycle.sql
-- TARGET ENGINE: PostgreSQL 15+ / Supabase SQL Editor
-- PREREQUISITE: Must be executed AFTER 0022_category_color_and_staff_role.sql
-- Modules Covered: IAM (Staff Account Revocation & Re-invitation Lifecycle, Audit Preservation)
-- Specification Reference: BUG-067 Remediation
-- ============================================================================

-- Preflight Check: Sequential migration verification
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = 22) THEN
    RAISE EXCEPTION 'MIGRATION_SEQUENCE_ERROR: Migration 0022 must be applied before 0023.';
  END IF;
END $$;

-- 1. Update status check constraint on tenant_memberships to allow 'REVOKED'
ALTER TABLE tenant_memberships
  DROP CONSTRAINT IF EXISTS tenant_memberships_status_check;

ALTER TABLE tenant_memberships
  ADD CONSTRAINT tenant_memberships_status_check
  CHECK (status IN ('INVITED', 'ACTIVE', 'DISABLED', 'REVOKED'));

-- 2. Replace rigid UNIQUE (tenant_id, user_id) with partial unique index
-- This allows historical preserved REVOKED membership records while preventing duplicate ACTIVE memberships
ALTER TABLE tenant_memberships
  DROP CONSTRAINT IF EXISTS tenant_memberships_tenant_id_user_id_key;

CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_memberships_unique_active_user
  ON tenant_memberships (tenant_id, user_id)
  WHERE status != 'REVOKED';

-- 3. Record migration execution in schema_migrations
INSERT INTO schema_migrations (version, name, filename)
VALUES (23, '0023_phase72_membership_revocation_lifecycle', '0023_phase72_membership_revocation_lifecycle.sql')
ON CONFLICT (version) DO NOTHING;

-- ============================================================================
-- NexStock Phase 7.2 Migration - 0021_phase72_staff_invitation_code_redesign.sql
-- TARGET ENGINE: PostgreSQL 15+ / Supabase SQL Editor
-- PREREQUISITE: Must be executed AFTER 0020_phase72_staff_invitations.sql
-- Modules Covered: IAM, Staff 4-Digit Access Code, RLS Tightening & Brute-Force Defense
-- Specification Reference: Phase 7.2 Staff Invitation Redesign + BUG-052 Fix
-- ============================================================================

-- Preflight Check: Sequential migration verification
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = 20) THEN
    RAISE EXCEPTION 'MIGRATION_SEQUENCE_ERROR: Migration 0020 must be applied before 0021.';
  END IF;
END $$;

-- 1. Add Code Encryption and Brute-Force Protection Columns
ALTER TABLE tenant_invitations
  ADD COLUMN IF NOT EXISTS code_encrypted text,
  ADD COLUMN IF NOT EXISTS failed_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS locked_until timestamptz;

-- 2. Enforce Strict Tenant Isolation on tenant_invitations (Eliminate NULL-context bypass)
ALTER TABLE tenant_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_invitations FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON tenant_invitations;
CREATE POLICY tenant_isolation_policy ON tenant_invitations
  AS PERMISSIVE
  FOR ALL
  TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

-- 3. Security Definer Function for Unauthenticated Code Lookup
-- Allows public verification of 4-digit code hash without weakening tenant isolation RLS
CREATE OR REPLACE FUNCTION public.lookup_invitation_by_code_hash(p_token_hash text)
RETURNS TABLE (
  id uuid,
  tenant_id uuid,
  email text,
  role_code text,
  employee_id uuid,
  status text,
  expires_at timestamptz,
  failed_attempts int,
  locked_until timestamptz,
  tenant_name text,
  employee_name text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    i.id,
    i.tenant_id,
    i.email,
    i.role_code,
    i.employee_id,
    i.status,
    i.expires_at,
    i.failed_attempts,
    i.locked_until,
    t.legal_name as tenant_name,
    e.display_name as employee_name
  FROM tenant_invitations i
  INNER JOIN tenants t ON t.id = i.tenant_id
  LEFT JOIN employees e ON e.id = i.employee_id
  WHERE i.token_hash = p_token_hash;
END;
$$;

GRANT EXECUTE ON FUNCTION public.lookup_invitation_by_code_hash(text) TO nexstock_app_user;

-- 4. Security Definer Function for Recording Failed Attempts & Lockout
CREATE OR REPLACE FUNCTION public.record_invitation_failed_attempt(p_invitation_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE tenant_invitations
  SET
    failed_attempts = failed_attempts + 1,
    locked_until = CASE
      WHEN failed_attempts + 1 >= 5 THEN clock_timestamp() + INTERVAL '1 hour'
      ELSE locked_until
    END,
    status = CASE
      WHEN failed_attempts + 1 >= 10 THEN 'FAILED'
      ELSE status
    END,
    updated_at = clock_timestamp()
  WHERE id = p_invitation_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.record_invitation_failed_attempt(uuid) TO nexstock_app_user;

-- 5. Record completion of Migration 0021
INSERT INTO schema_migrations (version, name, filename)
VALUES (21, '0021_phase72_staff_invitation_code_redesign', '0021_phase72_staff_invitation_code_redesign.sql')
ON CONFLICT (version) DO UPDATE
  SET applied_at = clock_timestamp(),
      applied_by = current_user;

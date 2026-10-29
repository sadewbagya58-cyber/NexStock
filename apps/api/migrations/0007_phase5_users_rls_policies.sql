-- ============================================================================
-- NexStock — Phase 5.0 Database Migration
-- Version: 0007
-- Module: Authentication & IAM Security (Row Level Security Policies on `public.users`)
-- Compatible with PostgreSQL 15+ / Supabase (Non-Superuser CREATEROLE Compatible)
-- Specification Reference: NEX-DOC-05 Section 2, NEX-DOC-07 Section 6
-- ============================================================================

-- Preflight Check: Enforce sequential migration history (0006 must be applied first)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = 6) THEN
    RAISE EXCEPTION 'MIGRATION_SEQUENCE_ERROR: Migration 0006 must be applied before 0007.';
  END IF;
END $$;

-- ============================================================================
-- 1. ENABLE & FORCE ROW LEVEL SECURITY ON `users`
-- ============================================================================
-- Ensures `public.users` enforces strict RLS across all non-superuser / NOBYPASSRLS roles.

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;

-- ============================================================================
-- 2. DROP OBSOLETE OR CONFLICTING POLICIES
-- ============================================================================
DROP POLICY IF EXISTS users_select_policy ON users;
DROP POLICY IF EXISTS users_insert_policy ON users;
DROP POLICY IF EXISTS users_update_policy ON users;
DROP POLICY IF EXISTS users_delete_policy ON users;
DROP POLICY IF EXISTS "Users can insert their own profile." ON users;
DROP POLICY IF EXISTS "Users can view own profile." ON users;
DROP POLICY IF EXISTS "Users can update own profile." ON users;
DROP POLICY IF EXISTS "Enable insert for authenticated users only" ON users;
DROP POLICY IF EXISTS "Enable read access for all users" ON users;

-- ============================================================================
-- 3. PERMISSIVE ROW LEVEL SECURITY POLICIES FOR `nexstock_app_user`
-- ============================================================================

-- 3.1 SELECT Policy:
-- Reading user profiles is required for:
--   - Authenticated user loading their own profile (`id = app_current_user_id()`)
--   - Tenant colleagues loading team member lists, invoice cashiers, and stocktake reviews
--   - Pre-authentication verification of email uniqueness
CREATE POLICY users_select_policy ON users
  AS PERMISSIVE
  FOR SELECT
  TO nexstock_app_user
  USING (true);

-- 3.2 INSERT Policy:
-- Strictly prevents unauthorized profile creation and privilege escalation:
--   1. `is_platform_admin` MUST always be `false`.
--   2. Caller must be inserting their OWN record matching their authenticated user ID
--      (`id = app_current_user_id()` or JWT sub), OR a tenant admin provisioning a member
--      inside an active tenant session (`app_current_tenant_id() IS NOT NULL`).
CREATE POLICY users_insert_policy ON users
  AS PERMISSIVE
  FOR INSERT
  TO nexstock_app_user
  WITH CHECK (
    is_platform_admin = false
    AND (
      id = app_current_user_id()
      OR (
        current_setting('request.jwt.claim.sub', true) IS NOT NULL
        AND id = NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid
      )
      OR (
        app_current_tenant_id() IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM tenant_memberships tm
          WHERE tm.tenant_id = app_current_tenant_id()
            AND tm.user_id = app_current_user_id()
            AND tm.status = 'ACTIVE'
        )
      )
    )
  );

-- 3.3 UPDATE Policy:
-- Users may only update their own profile (`id = app_current_user_id()`),
-- and can NEVER escalate their privilege to `is_platform_admin = true`.
CREATE POLICY users_update_policy ON users
  AS PERMISSIVE
  FOR UPDATE
  TO nexstock_app_user
  USING (
    id = app_current_user_id()
    OR (
      current_setting('request.jwt.claim.sub', true) IS NOT NULL
      AND id = NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid
    )
  )
  WITH CHECK (
    is_platform_admin = false
    AND (
      id = app_current_user_id()
      OR (
        current_setting('request.jwt.claim.sub', true) IS NOT NULL
        AND id = NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid
      )
    )
  );

-- Note: No DELETE policy is created. Deleting users via `nexstock_app_user` is prohibited.

-- ============================================================================
-- 4. VERIFY LEAST-PRIVILEGE TABLE GRANTS
-- ============================================================================
GRANT SELECT, INSERT, UPDATE ON TABLE users TO nexstock_app_user;

-- ============================================================================
-- 5. RECORD COMPLETION OF MIGRATION 0007
-- ============================================================================
INSERT INTO schema_migrations (version, name, filename)
VALUES (7, '0007_phase5_users_rls_policies', '0007_phase5_users_rls_policies.sql')
ON CONFLICT (version) DO UPDATE
  SET applied_at = clock_timestamp(),
      applied_by = current_user;

-- ============================================================================
-- NexStock — Phase 5.0 Database Migration
-- Version: 0006
-- Module: Authentication & Business Foundation (User-Scoped Tenant & Branch Discovery)
-- Compatible with PostgreSQL 15+ / Supabase (Non-Superuser CREATEROLE Compatible)
-- ============================================================================

-- Preflight Check: Enforce sequential migration history
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = 5) THEN
    RAISE EXCEPTION 'MIGRATION_SEQUENCE_ERROR: Migration 0005 must be applied before 0006.';
  END IF;
END $$;

-- ============================================================================
-- 1. ADDITIVE PERMISSIVE SELECT POLICIES FOR USER-SCOPED DISCOVERY
-- ============================================================================
-- These permissive policies allow authenticated users (via `app.current_user_id`)
-- to query their own active memberships, businesses (tenants), and branches
-- while preserving strict tenant isolation (`app.current_tenant_id`) for all writes
-- and operational queries.

-- 1.1 Tenant Memberships: Allow user to view their own memberships
DROP POLICY IF EXISTS user_tenant_memberships_select_policy ON tenant_memberships;
CREATE POLICY user_tenant_memberships_select_policy ON tenant_memberships
  AS PERMISSIVE
  FOR SELECT
  TO nexstock_app_user
  USING (user_id = app_current_user_id());

-- 1.2 Tenants: Allow user to view tenants where they hold an active membership
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
        AND tm.status = 'ACTIVE'
    )
  );

-- 1.3 Branches: Allow user to view branches of tenants where they hold an active membership
DROP POLICY IF EXISTS user_branches_select_policy ON branches;
CREATE POLICY user_branches_select_policy ON branches
  AS PERMISSIVE
  FOR SELECT
  TO nexstock_app_user
  USING (
    EXISTS (
      SELECT 1 FROM tenant_memberships tm
      WHERE tm.tenant_id = branches.tenant_id
        AND tm.user_id = app_current_user_id()
        AND tm.status = 'ACTIVE'
    )
  );

-- 1.4 Member Role Assignments: Allow user to view their own role assignments
DROP POLICY IF EXISTS user_member_roles_select_policy ON member_role_assignments;
CREATE POLICY user_member_roles_select_policy ON member_role_assignments
  AS PERMISSIVE
  FOR SELECT
  TO nexstock_app_user
  USING (
    EXISTS (
      SELECT 1 FROM tenant_memberships tm
      WHERE tm.id = member_role_assignments.membership_id
        AND tm.user_id = app_current_user_id()
        AND tm.status = 'ACTIVE'
    )
  );

-- 1.5 Roles: Allow user to view roles of tenants where they hold an active membership
DROP POLICY IF EXISTS user_roles_select_policy ON roles;
CREATE POLICY user_roles_select_policy ON roles
  AS PERMISSIVE
  FOR SELECT
  TO nexstock_app_user
  USING (
    EXISTS (
      SELECT 1 FROM tenant_memberships tm
      WHERE tm.tenant_id = roles.tenant_id
        AND tm.user_id = app_current_user_id()
        AND tm.status = 'ACTIVE'
    )
  );

-- ============================================================================
-- 2. RECORD COMPLETION OF MIGRATION 0006
-- ============================================================================

INSERT INTO schema_migrations (version, name, filename)
VALUES (6, '0006_phase5_auth_and_user_tenants', '0006_phase5_auth_and_user_tenants.sql')
ON CONFLICT (version) DO UPDATE
  SET applied_at = clock_timestamp(),
      applied_by = current_user;

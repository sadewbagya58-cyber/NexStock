-- ============================================================================
-- NexStock Phase 7 Migration - 0022_category_color_and_staff_role.sql
-- TARGET ENGINE: PostgreSQL 15+ / Supabase SQL Editor
-- PREREQUISITE: Must be executed AFTER 0021_phase72_staff_invitation_code_redesign.sql
-- Modules Covered: CAT (Category Color Coding), INV (Variable Batch Selling Price),
--                  IAM (STAFF System Role Seeding & Backfill across Tenants)
-- ============================================================================

-- Preflight Check: Sequential migration verification
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = 21) THEN
    RAISE EXCEPTION 'MIGRATION_SEQUENCE_ERROR: Migration 0021 must be applied before 0022.';
  END IF;
END $$;

-- 1. Add color column to categories table for visual POS navigation & catalog organization
ALTER TABLE categories
  ADD COLUMN IF NOT EXISTS color text DEFAULT '#6366f1';

-- 2. Add selling_price column to inventory_batches table for batch-specific variable pricing
ALTER TABLE inventory_batches
  ADD COLUMN IF NOT EXISTS selling_price numeric(19, 4);

-- 3. Backfill STAFF System Role and Permissions across all existing tenants
DO $$
DECLARE
  r_tenant RECORD;
  v_staff_role_id uuid;
  v_perm text;
  v_perms text[] := ARRAY[
    'dash:view',
    'hrm:attendance:self',
    'hrm:leave:self',
    'hrm:schedule:read',
    'hrm:holiday:read'
  ];
BEGIN
  FOR r_tenant IN SELECT id FROM tenants LOOP
    SELECT id INTO v_staff_role_id
    FROM roles
    WHERE tenant_id = r_tenant.id AND code = 'STAFF';

    IF v_staff_role_id IS NULL THEN
      v_staff_role_id := gen_random_uuid();
      INSERT INTO roles (
        id,
        tenant_id,
        code,
        name,
        description,
        is_system_role,
        created_at,
        updated_at
      )
      VALUES (
        v_staff_role_id,
        r_tenant.id,
        'STAFF',
        'Staff Employee',
        'Standard employee account with self-service access to personal attendance, work schedule, holidays, and leave requests.',
        true,
        clock_timestamp(),
        clock_timestamp()
      );
    END IF;

    FOREACH v_perm IN ARRAY v_perms LOOP
      INSERT INTO role_permissions (
        id,
        tenant_id,
        role_id,
        permission_key,
        created_at
      )
      VALUES (
        gen_random_uuid(),
        r_tenant.id,
        v_staff_role_id,
        v_perm,
        clock_timestamp()
      )
      ON CONFLICT DO NOTHING;
    END LOOP;
  END LOOP;
END $$;

-- 4. Record completion of Migration 0022
INSERT INTO schema_migrations (version, name, filename)
VALUES (22, '0022_category_color_and_staff_role', '0022_category_color_and_staff_role.sql')
ON CONFLICT (version) DO NOTHING;

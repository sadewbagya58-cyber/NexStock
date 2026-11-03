-- ============================================================================
-- NexStock — Migration 0015: Phase 7.1 Role Permissions & Warehouse Access Sync
-- Modules: IAM / HRM / ORG / PAYROLL (BUG-034, BUG-035, BUG-036)
-- ============================================================================

-- Backfill missing HRM & Payroll permissions for all existing built-in system roles
-- across all existing tenants in the database.
DO $$
DECLARE
  r_role RECORD;
  v_perm text;
  v_perms text[];
BEGIN
  FOR r_role IN
    SELECT id, tenant_id, code
    FROM roles
    WHERE code IN ('TENANT_OWNER', 'ORG_ADMIN', 'ACCOUNTANT', 'BRANCH_MANAGER')
  LOOP
    IF r_role.code IN ('TENANT_OWNER', 'ORG_ADMIN') THEN
      v_perms := ARRAY[
        'hrm:employee:read', 'hrm:employee:manage',
        'hrm:document:read', 'hrm:document:manage',
        'hrm:salary:read', 'hrm:salary:manage',
        'hrm:payroll:read', 'hrm:payroll:process',
        'hrm:payroll:approve', 'hrm:payroll:pay'
      ];
    ELSIF r_role.code = 'ACCOUNTANT' THEN
      v_perms := ARRAY[
        'hrm:employee:read',
        'hrm:salary:read', 'hrm:salary:manage',
        'hrm:payroll:read', 'hrm:payroll:process',
        'hrm:payroll:approve', 'hrm:payroll:pay'
      ];
    ELSIF r_role.code = 'BRANCH_MANAGER' THEN
      v_perms := ARRAY[
        'hrm:employee:read'
      ];
    ELSE
      v_perms := ARRAY[]::text[];
    END IF;

    FOREACH v_perm IN ARRAY v_perms
    LOOP
      INSERT INTO role_permissions (id, tenant_id, role_id, permission_key)
      VALUES (
        gen_random_uuid(),
        r_role.tenant_id,
        r_role.id,
        v_perm
      )
      ON CONFLICT (tenant_id, role_id, permission_key) DO NOTHING;
    END LOOP;
  END LOOP;
END $$;

-- Record completion of Migration 0015
INSERT INTO schema_migrations (version, name, filename)
VALUES (15, '0015_phase7_role_permissions_sync', '0015_phase7_role_permissions_sync.sql')
ON CONFLICT (version) DO UPDATE
  SET applied_at = clock_timestamp(),
      applied_by = current_user;

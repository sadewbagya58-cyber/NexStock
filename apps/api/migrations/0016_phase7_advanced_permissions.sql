-- Migration 0016: Phase 7.2 Advanced Permissions & Role Management
-- Adds description and updated_at to roles, seeds system role descriptions, and adds performance indexes

-- 1. Add description and updated_at to roles table
ALTER TABLE roles ADD COLUMN IF NOT EXISTS description text;
ALTER TABLE roles ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT clock_timestamp();

-- 2. Populate descriptive metadata for default system roles
UPDATE roles
SET description = 'Full organization control with unrestricted access across all branches, warehouses, payroll, and settings.'
WHERE code = 'TENANT_OWNER' AND (description IS NULL OR description = '');

UPDATE roles
SET description = 'Administrative access to manage inventory, catalog, sales, staff, and operations without subscription payment recording.'
WHERE code = 'ORG_ADMIN' AND (description IS NULL OR description = '');

UPDATE roles
SET description = 'Location-scoped operational management for store branches, local inventory, POS registers, and staff directory.'
WHERE code = 'BRANCH_MANAGER' AND (description IS NULL OR description = '');

UPDATE roles
SET description = 'Frontline point-of-sale operator permitted to open/close assigned registers, process customer sales, and take payments.'
WHERE code = 'CASHIER' AND (description IS NULL OR description = '');

UPDATE roles
SET description = 'Warehouse logistics operator responsible for stock movement receipts, dispatch transfers, counts, and bin tracking.'
WHERE code = 'WAREHOUSE_CLERK' AND (description IS NULL OR description = '');

UPDATE roles
SET description = 'Procurement coordinator managing supplier relationships, purchase orders, and stock intake catalog items.'
WHERE code = 'PURCHASER' AND (description IS NULL OR description = '');

UPDATE roles
SET description = 'Financial controller managing compensation plans, payroll calculation runs, disbursements, and accounting reports.'
WHERE code = 'ACCOUNTANT' AND (description IS NULL OR description = '');

-- 3. Optimization indexes for fast role and permission resolution
CREATE INDEX IF NOT EXISTS idx_roles_tenant_system ON roles (tenant_id, is_system_role);
CREATE INDEX IF NOT EXISTS idx_member_role_assignments_lookup ON member_role_assignments (tenant_id, membership_id, role_id);
CREATE INDEX IF NOT EXISTS idx_role_permissions_lookup ON role_permissions (tenant_id, role_id, permission_key);
CREATE INDEX IF NOT EXISTS idx_member_location_scopes_lookup ON member_location_scopes (tenant_id, membership_id);

-- 4. Grant DELETE privilege on roles to nexstock_app_user for custom role deletion
GRANT DELETE ON TABLE roles TO nexstock_app_user;

-- 5. Record completion of Migration 0016
INSERT INTO schema_migrations (version, name, filename)
VALUES (16, '0016_phase7_advanced_permissions', '0016_phase7_advanced_permissions.sql')
ON CONFLICT (version) DO NOTHING;

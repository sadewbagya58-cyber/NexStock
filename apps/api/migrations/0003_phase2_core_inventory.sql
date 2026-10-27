-- ============================================================================
-- NexStock Phase 2 Core Inventory Migration — 0003_phase2_core_inventory.sql
-- TARGET ENGINE: PostgreSQL 15+ / Supabase SQL Editor (Step 3 of 3)
-- PREREQUISITE: Must be executed AFTER `0001_shared_foundation_rls.sql`
--               and `0002_milestone1_iam_org_sub_i18n.sql`
-- Modules Covered: CAT (Categories, Products, Barcodes, UoM Conversions),
--                  PUR (Suppliers, Supplier Products),
--                  INV (Immutable Stock Ledger Entries, Inventory Balances)
-- Specification Reference: NEX-DOC-03, NEX-DOC-04, NEX-DOC-05, NEX-DOC-06, NEX-DOC-07
-- ============================================================================
-- Properties:
--   1. Pure PostgreSQL SQL (no SQLite PRAGMA, AUTOINCREMENT, or STRICT syntax).
--   2. Reproducible and idempotent (safe to rerun).
--   3. Enforces composite foreign keys (tenant_id, id) across all tenant tables.
--   4. Enables & forces PostgreSQL Row Level Security (RLS) on all tenant tables.
--   5. Enforces append-only immutability on `stock_ledger_entries` and ledger-backed
--      integrity on `inventory_balances`.
--   6. Grants least-privilege access to `nexstock_app_user` (NOBYPASSRLS).
-- ============================================================================

-- 1. Preflight Prerequisite Verification: Ensure Migrations 0001 and 0002 completed first
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_roles
    WHERE rolname = 'nexstock_app_user'
      AND rolsuper = false
      AND rolbypassrls = false
  ) THEN
    RAISE EXCEPTION 'MIGRATION_ORDER_ERROR: Role "nexstock_app_user" (with NOSUPERUSER and NOBYPASSRLS) does not exist. Execute 0001 and 0002 before 0003_phase2_core_inventory.sql.';
  END IF;

  IF to_regclass('public.schema_migrations') IS NULL THEN
    RAISE EXCEPTION 'MIGRATION_ORDER_ERROR: Table "schema_migrations" does not exist. Execute 0001 and 0002 before 0003_phase2_core_inventory.sql.';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM schema_migrations
    WHERE version = 1
      AND name = '0001_shared_foundation_rls'
  ) OR NOT EXISTS (
    SELECT 1
    FROM schema_migrations
    WHERE version = 2
      AND name = '0002_milestone1_iam_org_sub_i18n'
  ) THEN
    RAISE EXCEPTION 'MIGRATION_ORDER_ERROR: Prerequisite migrations 0001 and 0002 are not recorded in schema_migrations. Execute 0001 and 0002 before 0003_phase2_core_inventory.sql.';
  END IF;

  IF (
    SELECT count(*)
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname IN ('tenants', 'branches', 'warehouses', 'tax_groups', 'roles', 'role_permissions')
      AND c.relrowsecurity = true
      AND c.relforcerowsecurity = true
  ) < 6 THEN
    RAISE EXCEPTION 'MIGRATION_ORDER_ERROR: Phase 1 tables from 0002_milestone1_iam_org_sub_i18n.sql are missing or do not have FORCE ROW LEVEL SECURITY enabled.';
  END IF;
END
$$;

-- 2. Backfill Phase 2 RBAC Permissions for Any Already-Onboarded Tenants
DO $$
DECLARE
  r_role RECORD;
  v_perm text;
  v_perms text[];
BEGIN
  FOR r_role IN
    SELECT tenant_id, id, code
    FROM roles
    WHERE is_system_role = true
  LOOP
    IF r_role.code IN ('TENANT_OWNER', 'ORG_ADMIN', 'BRANCH_MANAGER') THEN
      v_perms := ARRAY[
        'cat:category:read',
        'cat:category:manage',
        'cat:product:read',
        'cat:product:manage',
        'pur:supplier:read',
        'pur:supplier:manage',
        'inv:balance:read',
        'inv:movement:read',
        'inv:movement:post',
        'inv:movement:reverse'
      ];
    ELSIF r_role.code = 'CASHIER' THEN
      v_perms := ARRAY[
        'cat:category:read',
        'cat:product:read',
        'inv:balance:read'
      ];
    ELSIF r_role.code = 'WAREHOUSE_CLERK' THEN
      v_perms := ARRAY[
        'cat:category:read',
        'cat:product:read',
        'pur:supplier:read',
        'inv:balance:read',
        'inv:movement:read',
        'inv:movement:post'
      ];
    ELSIF r_role.code = 'PURCHASER' THEN
      v_perms := ARRAY[
        'cat:category:read',
        'cat:category:manage',
        'cat:product:read',
        'cat:product:manage',
        'pur:supplier:read',
        'pur:supplier:manage',
        'inv:balance:read',
        'inv:movement:read'
      ];
    ELSIF r_role.code = 'ACCOUNTANT' THEN
      v_perms := ARRAY[
        'cat:category:read',
        'cat:product:read',
        'pur:supplier:read',
        'inv:balance:read',
        'inv:movement:read'
      ];
    ELSE
      v_perms := ARRAY[]::text[];
    END IF;

    FOREACH v_perm IN ARRAY v_perms
    LOOP
      INSERT INTO role_permissions (id, tenant_id, role_id, permission_key)
      VALUES (
        md5(r_role.tenant_id::text || ':' || r_role.id::text || ':' || v_perm)::uuid,
        r_role.tenant_id,
        r_role.id,
        v_perm
      )
      ON CONFLICT (tenant_id, role_id, permission_key) DO NOTHING;
    END LOOP;
  END LOOP;
END
$$;

-- 3. Trigger Helper: Prevent Accidental Hard Deletion of Master Data Records
CREATE OR REPLACE FUNCTION prevent_master_record_hard_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'HARD_DELETE_FORBIDDEN: Rows in master table "%" cannot be hard-deleted; transition status to ARCHIVED instead.', TG_TABLE_NAME;
END;
$$;

-- ============================================================================
-- MODULE 1: CAT (Categories, Products, Barcodes, UoM Conversions)
-- ============================================================================

CREATE TABLE IF NOT EXISTS categories (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  parent_id uuid,
  name text NOT NULL CHECK (btrim(name) <> ''),
  description text,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  sync_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  archived_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, parent_id) REFERENCES categories (tenant_id, id),
  CHECK (parent_id IS NULL OR parent_id <> id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_categories_tenant_parent_name_unique
  ON categories (
    tenant_id,
    COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid),
    lower(btrim(name))
  );

CREATE INDEX IF NOT EXISTS idx_categories_tenant_parent
  ON categories (tenant_id, parent_id);

DROP TRIGGER IF EXISTS categories_no_hard_delete_trg ON categories;
CREATE TRIGGER categories_no_hard_delete_trg
  BEFORE DELETE ON categories
  FOR EACH ROW
  EXECUTE FUNCTION prevent_master_record_hard_delete();

ALTER TABLE categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE categories FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON categories;
CREATE POLICY tenant_isolation_policy ON categories
  AS PERMISSIVE
  FOR ALL
  TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

CREATE TABLE IF NOT EXISTS products (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  sku text NOT NULL CHECK (btrim(sku) <> ''),
  name text NOT NULL CHECK (btrim(name) <> ''),
  description text,
  product_type text NOT NULL DEFAULT 'STANDARD' CHECK (product_type IN ('STANDARD', 'SERVICE', 'BUNDLE')),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  category_id uuid,
  base_uom text NOT NULL CHECK (btrim(base_uom) <> ''),
  purchase_cost numeric(19, 4) NOT NULL DEFAULT 0 CHECK (purchase_cost >= 0),
  selling_price numeric(19, 4) NOT NULL DEFAULT 0 CHECK (selling_price >= 0),
  tax_group_id uuid,
  track_inventory boolean NOT NULL DEFAULT true,
  reorder_point numeric(18, 6) NOT NULL DEFAULT 0 CHECK (reorder_point >= 0),
  reorder_qty numeric(18, 6) NOT NULL DEFAULT 0 CHECK (reorder_qty >= 0),
  image_url text,
  image_alt text,
  primary_barcode text,
  sync_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  archived_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, sku),
  FOREIGN KEY (tenant_id, category_id) REFERENCES categories (tenant_id, id),
  FOREIGN KEY (tenant_id, tax_group_id) REFERENCES tax_groups (tenant_id, id),
  CHECK (product_type <> 'SERVICE' OR track_inventory = false)
);

CREATE INDEX IF NOT EXISTS idx_products_tenant_category
  ON products (tenant_id, category_id);

CREATE INDEX IF NOT EXISTS idx_products_tenant_status_name
  ON products (tenant_id, status, name);

DROP TRIGGER IF EXISTS products_no_hard_delete_trg ON products;
CREATE TRIGGER products_no_hard_delete_trg
  BEFORE DELETE ON products
  FOR EACH ROW
  EXECUTE FUNCTION prevent_master_record_hard_delete();

ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE products FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON products;
CREATE POLICY tenant_isolation_policy ON products
  AS PERMISSIVE
  FOR ALL
  TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

CREATE TABLE IF NOT EXISTS product_barcodes (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  product_id uuid NOT NULL,
  barcode text NOT NULL CHECK (btrim(barcode) <> ''),
  barcode_type text NOT NULL DEFAULT 'CODE128' CHECK (barcode_type IN ('EAN13', 'UPCA', 'CODE128', 'QR', 'CUSTOM')),
  uom_code text NOT NULL CHECK (btrim(uom_code) <> ''),
  is_primary boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, barcode),
  FOREIGN KEY (tenant_id, product_id) REFERENCES products (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS idx_product_barcodes_product
  ON product_barcodes (tenant_id, product_id);

ALTER TABLE product_barcodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_barcodes FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON product_barcodes;
CREATE POLICY tenant_isolation_policy ON product_barcodes
  AS PERMISSIVE
  FOR ALL
  TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

CREATE TABLE IF NOT EXISTS product_unit_conversions (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  product_id uuid NOT NULL,
  uom_code text NOT NULL CHECK (btrim(uom_code) <> ''),
  uom_name text NOT NULL CHECK (btrim(uom_name) <> ''),
  conversion_factor_to_base numeric(18, 6) NOT NULL CHECK (conversion_factor_to_base > 0),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, product_id, uom_code),
  FOREIGN KEY (tenant_id, product_id) REFERENCES products (tenant_id, id)
);

ALTER TABLE product_unit_conversions ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_unit_conversions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON product_unit_conversions;
CREATE POLICY tenant_isolation_policy ON product_unit_conversions
  AS PERMISSIVE
  FOR ALL
  TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

-- ============================================================================
-- MODULE 2: PUR (Suppliers & Supplier Product Relationships)
-- ============================================================================

CREATE TABLE IF NOT EXISTS suppliers (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  code text NOT NULL CHECK (btrim(code) <> ''),
  business_name text NOT NULL CHECK (btrim(business_name) <> ''),
  contact_person text,
  email text,
  phone text,
  address text,
  tax_registration_number text,
  notes text,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  sync_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  archived_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, code)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_suppliers_tenant_tax_reg_unique
  ON suppliers (tenant_id, lower(btrim(tax_registration_number)))
  WHERE tax_registration_number IS NOT NULL;

DROP TRIGGER IF EXISTS suppliers_no_hard_delete_trg ON suppliers;
CREATE TRIGGER suppliers_no_hard_delete_trg
  BEFORE DELETE ON suppliers
  FOR EACH ROW
  EXECUTE FUNCTION prevent_master_record_hard_delete();

ALTER TABLE suppliers ENABLE ROW LEVEL SECURITY;
ALTER TABLE suppliers FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON suppliers;
CREATE POLICY tenant_isolation_policy ON suppliers
  AS PERMISSIVE
  FOR ALL
  TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

CREATE TABLE IF NOT EXISTS supplier_products (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  supplier_id uuid NOT NULL,
  product_id uuid NOT NULL,
  supplier_sku text,
  supplier_product_name text,
  unit_cost numeric(19, 4) CHECK (unit_cost IS NULL OR unit_cost >= 0),
  currency_code char(3) REFERENCES currencies (code),
  minimum_order_qty numeric(18, 6) CHECK (minimum_order_qty IS NULL OR minimum_order_qty > 0),
  lead_time_days integer CHECK (lead_time_days IS NULL OR lead_time_days >= 0),
  is_preferred boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, supplier_id, product_id),
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES suppliers (tenant_id, id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES products (tenant_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_supplier_products_sku_unique
  ON supplier_products (tenant_id, supplier_id, upper(btrim(supplier_sku)))
  WHERE supplier_sku IS NOT NULL;

ALTER TABLE supplier_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_products FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON supplier_products;
CREATE POLICY tenant_isolation_policy ON supplier_products
  AS PERMISSIVE
  FOR ALL
  TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

-- ============================================================================
-- MODULE 3: INV (Immutable Stock Movement Ledger & Inventory Balances)
-- ============================================================================

CREATE TABLE IF NOT EXISTS stock_ledger_entries (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  branch_id uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  product_id uuid NOT NULL,
  supplier_id uuid,
  movement_type text NOT NULL CHECK (
    movement_type IN (
      'OPENING_STOCK',
      'STOCK_IN',
      'STOCK_OUT',
      'ADJUSTMENT_POSITIVE',
      'ADJUSTMENT_NEGATIVE',
      'CORRECTION_REVERSAL',
      'CUSTOMER_RETURN_RESTOCK',
      'SUPPLIER_RETURN'
    )
  ),
  uom_code text NOT NULL CHECK (btrim(uom_code) <> ''),
  input_qty numeric(18, 6) NOT NULL CHECK (input_qty <> 0),
  conversion_factor_to_base numeric(18, 6) NOT NULL DEFAULT 1.000000 CHECK (conversion_factor_to_base > 0),
  qty_delta numeric(18, 6) NOT NULL CHECK (qty_delta <> 0),
  balance_before numeric(18, 6) NOT NULL,
  balance_after numeric(18, 6) NOT NULL,
  unit_cost numeric(19, 4) NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
  reference_type text,
  reference_id text,
  reversed_entry_id uuid,
  reason text,
  negative_stock_override_applied boolean NOT NULL DEFAULT false,
  actor_user_id uuid NOT NULL REFERENCES users (id),
  idempotency_key uuid NOT NULL,
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id),
  FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouses (tenant_id, id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES products (tenant_id, id),
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES suppliers (tenant_id, id),
  FOREIGN KEY (tenant_id, reversed_entry_id) REFERENCES stock_ledger_entries (tenant_id, id),
  CHECK (
    (
      movement_type IN ('OPENING_STOCK', 'STOCK_IN', 'ADJUSTMENT_POSITIVE', 'CUSTOMER_RETURN_RESTOCK')
      AND qty_delta > 0
      AND input_qty > 0
    )
    OR (
      movement_type IN ('STOCK_OUT', 'ADJUSTMENT_NEGATIVE', 'SUPPLIER_RETURN')
      AND qty_delta < 0
      AND input_qty < 0
    )
    OR (
      movement_type = 'CORRECTION_REVERSAL'
      AND qty_delta <> 0
      AND input_qty <> 0
      AND reversed_entry_id IS NOT NULL
      AND btrim(COALESCE(reason, '')) <> ''
    )
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_stock_ledger_reversed_entry_unique
  ON stock_ledger_entries (tenant_id, reversed_entry_id)
  WHERE reversed_entry_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_stock_ledger_warehouse_product_chronological
  ON stock_ledger_entries (tenant_id, warehouse_id, product_id, id DESC);

DROP TRIGGER IF EXISTS stock_ledger_entries_immutable_trg ON stock_ledger_entries;
CREATE TRIGGER stock_ledger_entries_immutable_trg
  BEFORE UPDATE OR DELETE ON stock_ledger_entries
  FOR EACH ROW
  EXECUTE FUNCTION prevent_immutable_row_mutation();

ALTER TABLE stock_ledger_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_ledger_entries FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON stock_ledger_entries;
CREATE POLICY tenant_isolation_policy ON stock_ledger_entries
  AS PERMISSIVE
  FOR ALL
  TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

CREATE TABLE IF NOT EXISTS inventory_balances (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  branch_id uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  product_id uuid NOT NULL,
  uom_code text NOT NULL CHECK (btrim(uom_code) <> ''),
  qty_on_hand numeric(18, 6) NOT NULL DEFAULT 0,
  qty_reserved numeric(18, 6) NOT NULL DEFAULT 0 CHECK (qty_reserved >= 0),
  qty_in_transit numeric(18, 6) NOT NULL DEFAULT 0 CHECK (qty_in_transit >= 0),
  qty_damaged numeric(18, 6) NOT NULL DEFAULT 0 CHECK (qty_damaged >= 0),
  moving_avg_cost numeric(19, 4) NOT NULL DEFAULT 0 CHECK (moving_avg_cost >= 0),
  total_inventory_value numeric(19, 4) NOT NULL DEFAULT 0,
  last_ledger_entry_id uuid NOT NULL,
  last_movement_at timestamptz NOT NULL,
  sync_version bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, warehouse_id, product_id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id),
  FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouses (tenant_id, id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES products (tenant_id, id),
  FOREIGN KEY (tenant_id, last_ledger_entry_id) REFERENCES stock_ledger_entries (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS idx_inventory_balances_branch_warehouse
  ON inventory_balances (tenant_id, branch_id, warehouse_id);

-- Database-Level Guard: Prevent Direct Balance Manipulation Bypassing `stock_ledger_entries`
CREATE OR REPLACE FUNCTION enforce_inventory_balance_ledger_integrity() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_ledger_balance_after numeric(18, 6);
BEGIN
  SELECT balance_after INTO v_ledger_balance_after
  FROM stock_ledger_entries
  WHERE tenant_id = NEW.tenant_id
    AND id = NEW.last_ledger_entry_id
    AND warehouse_id = NEW.warehouse_id
    AND product_id = NEW.product_id;

  IF v_ledger_balance_after IS NULL THEN
    RAISE EXCEPTION 'BALANCE_LEDGER_INVARIANT_VIOLATION: inventory_balances row for product "%" in warehouse "%" must reference a valid stock_ledger_entries row for the same (tenant_id, warehouse_id, product_id).', NEW.product_id, NEW.warehouse_id;
  END IF;

  IF NEW.qty_on_hand <> v_ledger_balance_after THEN
    RAISE EXCEPTION 'BALANCE_LEDGER_INVARIANT_VIOLATION: Direct balance manipulation rejected. inventory_balances.qty_on_hand (%) does not match stock_ledger_entries.balance_after (%) for entry "%".', NEW.qty_on_hand, v_ledger_balance_after, NEW.last_ledger_entry_id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS inventory_balances_ledger_integrity_trg ON inventory_balances;
CREATE TRIGGER inventory_balances_ledger_integrity_trg
  BEFORE INSERT OR UPDATE ON inventory_balances
  FOR EACH ROW
  EXECUTE FUNCTION enforce_inventory_balance_ledger_integrity();

DROP TRIGGER IF EXISTS inventory_balances_no_hard_delete_trg ON inventory_balances;
CREATE TRIGGER inventory_balances_no_hard_delete_trg
  BEFORE DELETE ON inventory_balances
  FOR EACH ROW
  EXECUTE FUNCTION prevent_master_record_hard_delete();

ALTER TABLE inventory_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_balances FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON inventory_balances;
CREATE POLICY tenant_isolation_policy ON inventory_balances
  AS PERMISSIVE
  FOR ALL
  TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

-- ============================================================================
-- Least-Privilege Grants to Runtime Role (`nexstock_app_user`)
-- ============================================================================

GRANT EXECUTE ON FUNCTION prevent_master_record_hard_delete() TO nexstock_app_user;
GRANT EXECUTE ON FUNCTION enforce_inventory_balance_ledger_integrity() TO nexstock_app_user;

GRANT SELECT, INSERT, UPDATE ON TABLE categories TO nexstock_app_user;
GRANT SELECT, INSERT, UPDATE ON TABLE products TO nexstock_app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE product_barcodes TO nexstock_app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE product_unit_conversions TO nexstock_app_user;
GRANT SELECT, INSERT, UPDATE ON TABLE suppliers TO nexstock_app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE supplier_products TO nexstock_app_user;
GRANT SELECT, INSERT ON TABLE stock_ledger_entries TO nexstock_app_user;
GRANT SELECT, INSERT, UPDATE ON TABLE inventory_balances TO nexstock_app_user;

-- Record completion of Migration 0003
INSERT INTO schema_migrations (version, name, filename)
VALUES (3, '0003_phase2_core_inventory', '0003_phase2_core_inventory.sql')
ON CONFLICT (version) DO UPDATE
  SET applied_at = clock_timestamp(),
      applied_by = current_user;

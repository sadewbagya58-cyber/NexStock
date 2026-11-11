-- ============================================================================
-- NexStock Migration - 0025_uom_foundation_and_variable_products.sql
-- TARGET ENGINE: PostgreSQL 15+ / Supabase SQL Editor
-- PREREQUISITE: Must be executed AFTER 0024_membership_lifecycle_deactivated_suspended.sql
-- Modules Covered: CAT (Units of Measure, Variable-Quantity Product Config),
--                  PUR (Purchase Orders, Goods Receipts, Supplier Returns),
--                  INV (Ledger entry_source),
--                  POS (Invoice Line UOM & Proportionate Price Snapshots, Returns)
-- Specification Reference: UOM-01..UOM-07, BUG-084
-- ============================================================================

-- Preflight Check: Sequential migration verification
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = 24) THEN
    RAISE EXCEPTION 'MIGRATION_SEQUENCE_ERROR: Migration 0024 must be applied before 0025.';
  END IF;
END $$;

-- ============================================================================
-- 1. CANONICAL UNITS OF MEASURE REFERENCE CATALOG (`units_of_measure`)
-- ============================================================================

CREATE TABLE IF NOT EXISTS units_of_measure (
  code text PRIMARY KEY CHECK (btrim(code) <> '' AND code = upper(btrim(code))),
  name text NOT NULL CHECK (btrim(name) <> ''),
  category text NOT NULL CHECK (category IN ('WEIGHT', 'VOLUME', 'COUNT', 'LENGTH')),
  base_unit_code text NOT NULL CHECK (btrim(base_unit_code) <> '' AND base_unit_code = upper(btrim(base_unit_code))),
  conversion_to_base numeric(18, 6) NOT NULL CHECK (conversion_to_base > 0),
  decimal_precision smallint NOT NULL DEFAULT 3 CHECK (decimal_precision >= 0 AND decimal_precision <= 6),
  is_fractional boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

ALTER TABLE units_of_measure ENABLE ROW LEVEL SECURITY;
ALTER TABLE units_of_measure FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS units_of_measure_select_policy ON units_of_measure;
CREATE POLICY units_of_measure_select_policy ON units_of_measure
  AS PERMISSIVE
  FOR SELECT
  TO nexstock_app_user
  USING (true);

GRANT SELECT ON TABLE units_of_measure TO nexstock_app_user;

INSERT INTO units_of_measure (
  code, name, category, base_unit_code, conversion_to_base, decimal_precision, is_fractional, is_active
) VALUES
  ('KG', 'Kilogram', 'WEIGHT', 'KG', 1.000000, 3, true, true),
  ('G', 'Gram', 'WEIGHT', 'KG', 0.001000, 3, true, true),
  ('MG', 'Milligram', 'WEIGHT', 'KG', 0.000001, 0, false, true),
  ('L', 'Liter', 'VOLUME', 'L', 1.000000, 3, true, true),
  ('ML', 'Milliliter', 'VOLUME', 'L', 0.001000, 2, true, true),
  ('M', 'Meter', 'LENGTH', 'M', 1.000000, 3, true, true),
  ('CM', 'Centimeter', 'LENGTH', 'M', 0.010000, 2, true, true),
  ('MM', 'Millimeter', 'LENGTH', 'M', 0.001000, 0, false, true),
  ('PCS', 'Pieces', 'COUNT', 'PCS', 1.000000, 0, false, true),
  ('UNIT', 'Unit', 'COUNT', 'PCS', 1.000000, 0, false, true),
  ('DOZEN', 'Dozen (12 pcs)', 'COUNT', 'PCS', 12.000000, 0, false, true),
  ('PACK', 'Pack', 'COUNT', 'PCS', 1.000000, 0, false, true),
  ('BOX', 'Box', 'COUNT', 'PCS', 1.000000, 0, false, true),
  ('BAG', 'Bag', 'COUNT', 'PCS', 1.000000, 0, false, true)
ON CONFLICT (code) DO UPDATE
  SET name = EXCLUDED.name,
      category = EXCLUDED.category,
      base_unit_code = EXCLUDED.base_unit_code,
      conversion_to_base = EXCLUDED.conversion_to_base,
      decimal_precision = EXCLUDED.decimal_precision,
      is_fractional = EXCLUDED.is_fractional,
      is_active = EXCLUDED.is_active;

-- ============================================================================
-- 2. BACKWARD-COMPATIBLE PRODUCT UOM & VARIABLE QUANTITY EXTENSIONS
-- ============================================================================

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS product_qty_mode text NOT NULL DEFAULT 'STANDARD'
    CHECK (product_qty_mode IN ('STANDARD', 'VARIABLE')),
  ADD COLUMN IF NOT EXISTS measurement_category text
    CHECK (measurement_category IS NULL OR measurement_category IN ('WEIGHT', 'VOLUME', 'COUNT', 'LENGTH')),
  ADD COLUMN IF NOT EXISTS purchase_uom text,
  ADD COLUMN IF NOT EXISTS price_uom text,
  ADD COLUMN IF NOT EXISTS allowed_selling_uoms jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS qty_decimal_precision smallint NOT NULL DEFAULT 0
    CHECK (qty_decimal_precision >= 0 AND qty_decimal_precision <= 6),
  ADD COLUMN IF NOT EXISTS featured_pos boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS density_g_per_ml numeric(18, 6)
    CHECK (density_g_per_ml IS NULL OR density_g_per_ml > 0);

CREATE INDEX IF NOT EXISTS idx_products_tenant_qty_mode_featured
  ON products (tenant_id, product_qty_mode, featured_pos)
  WHERE status = 'ACTIVE';

-- ============================================================================
-- 3. IMMUTABLE LEDGER & POS LINE SNAPSHOT METADATA EXTENSIONS
-- ============================================================================
-- NOTE: Adding columns with constant defaults or nullable definitions avoids
-- firing row-level UPDATE immutability triggers on existing historical rows.

ALTER TABLE stock_ledger_entries
  ADD COLUMN IF NOT EXISTS entry_source text NOT NULL DEFAULT 'MANUAL'
    CHECK (
      entry_source IN (
        'OPENING_BALANCE',
        'PURCHASE_RECEIPT',
        'POS_SALE',
        'POS_VOID',
        'CUSTOMER_RETURN',
        'SUPPLIER_RETURN',
        'STOCKTAKE',
        'MANUAL',
        'MANUAL_WEIGHT',
        'SCALE_WEIGHT',
        'SYSTEM_REVERSAL'
      )
    );

ALTER TABLE sales_invoice_lines
  ADD COLUMN IF NOT EXISTS original_entered_qty numeric(18, 6),
  ADD COLUMN IF NOT EXISTS original_uom_code text,
  ADD COLUMN IF NOT EXISTS conversion_factor_to_base numeric(18, 6),
  ADD COLUMN IF NOT EXISTS normalized_base_qty numeric(18, 6),
  ADD COLUMN IF NOT EXISTS price_uom text,
  ADD COLUMN IF NOT EXISTS price_per_price_uom numeric(19, 4),
  ADD COLUMN IF NOT EXISTS entry_source text NOT NULL DEFAULT 'MANUAL'
    CHECK (
      entry_source IN (
        'BARCODE_SCAN',
        'MANUAL',
        'MANUAL_WEIGHT',
        'SCALE_WEIGHT',
        'QUICK_PICK',
        'API'
      )
    );

-- ============================================================================
-- 4. PURCHASING & GOODS RECEIVING TABLES (`purchase_orders`, `goods_receipts`)
-- ============================================================================

CREATE TABLE IF NOT EXISTS purchase_orders (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  branch_id uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  supplier_id uuid NOT NULL,
  po_number text NOT NULL CHECK (btrim(po_number) <> ''),
  status text NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT', 'APPROVED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED')),
  currency_code char(3) NOT NULL REFERENCES currencies (code),
  total_amount numeric(19, 4) NOT NULL DEFAULT 0.0000 CHECK (total_amount >= 0),
  notes text,
  expected_at timestamptz,
  created_by_user_id uuid NOT NULL REFERENCES users (id),
  approved_by_user_id uuid REFERENCES users (id),
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, po_number),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id),
  FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouses (tenant_id, id),
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES suppliers (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS idx_purchase_orders_tenant_status
  ON purchase_orders (tenant_id, status, created_at DESC);

ALTER TABLE purchase_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_orders FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON purchase_orders;
CREATE POLICY tenant_isolation_policy ON purchase_orders
  AS PERMISSIVE
  FOR ALL
  TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

GRANT SELECT, INSERT, UPDATE ON TABLE purchase_orders TO nexstock_app_user;

CREATE TABLE IF NOT EXISTS purchase_order_lines (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  purchase_order_id uuid NOT NULL,
  line_number integer NOT NULL CHECK (line_number >= 1),
  product_id uuid NOT NULL,
  ordered_uom text NOT NULL CHECK (btrim(ordered_uom) <> ''),
  ordered_qty numeric(18, 6) NOT NULL CHECK (ordered_qty > 0),
  conversion_factor_to_base numeric(18, 6) NOT NULL CHECK (conversion_factor_to_base > 0),
  normalized_base_qty numeric(18, 6) NOT NULL CHECK (normalized_base_qty > 0),
  received_base_qty numeric(18, 6) NOT NULL DEFAULT 0.000000 CHECK (received_base_qty >= 0),
  unit_cost numeric(19, 4) NOT NULL CHECK (unit_cost >= 0),
  line_total numeric(19, 4) NOT NULL CHECK (line_total >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, purchase_order_id, line_number),
  FOREIGN KEY (tenant_id, purchase_order_id) REFERENCES purchase_orders (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, product_id) REFERENCES products (tenant_id, id)
);

ALTER TABLE purchase_order_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_order_lines FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON purchase_order_lines;
CREATE POLICY tenant_isolation_policy ON purchase_order_lines
  AS PERMISSIVE
  FOR ALL
  TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

GRANT SELECT, INSERT, UPDATE ON TABLE purchase_order_lines TO nexstock_app_user;

CREATE TABLE IF NOT EXISTS goods_receipts (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  purchase_order_id uuid,
  supplier_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  grn_number text NOT NULL CHECK (btrim(grn_number) <> ''),
  status text NOT NULL DEFAULT 'POSTED' CHECK (status IN ('POSTED', 'CANCELLED')),
  currency_code char(3) NOT NULL REFERENCES currencies (code),
  total_cost numeric(19, 4) NOT NULL DEFAULT 0.0000 CHECK (total_cost >= 0),
  notes text,
  received_by_user_id uuid NOT NULL REFERENCES users (id),
  idempotency_key uuid NOT NULL,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, grn_number),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, purchase_order_id) REFERENCES purchase_orders (tenant_id, id),
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES suppliers (tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id),
  FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouses (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS idx_goods_receipts_tenant_created
  ON goods_receipts (tenant_id, created_at DESC);

ALTER TABLE goods_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE goods_receipts FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON goods_receipts;
CREATE POLICY tenant_isolation_policy ON goods_receipts
  AS PERMISSIVE
  FOR ALL
  TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

GRANT SELECT, INSERT, UPDATE ON TABLE goods_receipts TO nexstock_app_user;

CREATE TABLE IF NOT EXISTS goods_receipt_lines (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  goods_receipt_id uuid NOT NULL,
  purchase_order_line_id uuid,
  line_number integer NOT NULL CHECK (line_number >= 1),
  product_id uuid NOT NULL,
  received_uom text NOT NULL CHECK (btrim(received_uom) <> ''),
  received_qty numeric(18, 6) NOT NULL CHECK (received_qty > 0),
  conversion_factor_to_base numeric(18, 6) NOT NULL CHECK (conversion_factor_to_base > 0),
  normalized_base_qty numeric(18, 6) NOT NULL CHECK (normalized_base_qty > 0),
  unit_cost_per_received_uom numeric(19, 4) NOT NULL CHECK (unit_cost_per_received_uom >= 0),
  unit_cost_per_base_uom numeric(19, 4) NOT NULL CHECK (unit_cost_per_base_uom >= 0),
  line_total_cost numeric(19, 4) NOT NULL CHECK (line_total_cost >= 0),
  batch_number text,
  expiry_date date,
  ledger_entry_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, goods_receipt_id, line_number),
  FOREIGN KEY (tenant_id, goods_receipt_id) REFERENCES goods_receipts (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, purchase_order_line_id) REFERENCES purchase_order_lines (tenant_id, id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES products (tenant_id, id),
  FOREIGN KEY (tenant_id, ledger_entry_id) REFERENCES stock_ledger_entries (tenant_id, id)
);

ALTER TABLE goods_receipt_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE goods_receipt_lines FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON goods_receipt_lines;
CREATE POLICY tenant_isolation_policy ON goods_receipt_lines
  AS PERMISSIVE
  FOR ALL
  TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

GRANT SELECT, INSERT ON TABLE goods_receipt_lines TO nexstock_app_user;

CREATE TABLE IF NOT EXISTS supplier_returns (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  supplier_id uuid NOT NULL,
  goods_receipt_id uuid,
  branch_id uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  return_number text NOT NULL CHECK (btrim(return_number) <> ''),
  product_id uuid NOT NULL,
  return_uom text NOT NULL CHECK (btrim(return_uom) <> ''),
  return_qty numeric(18, 6) NOT NULL CHECK (return_qty > 0),
  conversion_factor_to_base numeric(18, 6) NOT NULL CHECK (conversion_factor_to_base > 0),
  normalized_base_qty numeric(18, 6) NOT NULL CHECK (normalized_base_qty > 0),
  unit_cost numeric(19, 4) NOT NULL CHECK (unit_cost >= 0),
  total_cost numeric(19, 4) NOT NULL CHECK (total_cost >= 0),
  reason text NOT NULL CHECK (btrim(reason) <> ''),
  ledger_entry_id uuid,
  created_by_user_id uuid NOT NULL REFERENCES users (id),
  idempotency_key uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, return_number),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES suppliers (tenant_id, id),
  FOREIGN KEY (tenant_id, goods_receipt_id) REFERENCES goods_receipts (tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id),
  FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouses (tenant_id, id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES products (tenant_id, id),
  FOREIGN KEY (tenant_id, ledger_entry_id) REFERENCES stock_ledger_entries (tenant_id, id)
);

ALTER TABLE supplier_returns ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_returns FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON supplier_returns;
CREATE POLICY tenant_isolation_policy ON supplier_returns
  AS PERMISSIVE
  FOR ALL
  TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

GRANT SELECT, INSERT ON TABLE supplier_returns TO nexstock_app_user;

-- ============================================================================
-- 5. POS CUSTOMER RETURNS TABLES (Partial / UOM-Aware Return Snapshots)
-- ============================================================================

CREATE TABLE IF NOT EXISTS pos_returns (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  invoice_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  return_number text NOT NULL CHECK (btrim(return_number) <> ''),
  reason text NOT NULL CHECK (btrim(reason) <> ''),
  refund_method text NOT NULL CHECK (refund_method IN ('CASH', 'CARD', 'CREDIT_ADJUSTMENT', 'OTHER')),
  total_refund_amount numeric(19, 4) NOT NULL CHECK (total_refund_amount >= 0),
  currency_code char(3) NOT NULL REFERENCES currencies (code),
  created_by_user_id uuid NOT NULL REFERENCES users (id),
  idempotency_key uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, return_number),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES sales_invoices (tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id),
  FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouses (tenant_id, id)
);

ALTER TABLE pos_returns ENABLE ROW LEVEL SECURITY;
ALTER TABLE pos_returns FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON pos_returns;
CREATE POLICY tenant_isolation_policy ON pos_returns
  AS PERMISSIVE
  FOR ALL
  TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

GRANT SELECT, INSERT ON TABLE pos_returns TO nexstock_app_user;

CREATE TABLE IF NOT EXISTS pos_return_lines (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  pos_return_id uuid NOT NULL,
  invoice_line_id uuid NOT NULL,
  product_id uuid NOT NULL,
  return_uom text NOT NULL CHECK (btrim(return_uom) <> ''),
  return_qty numeric(18, 6) NOT NULL CHECK (return_qty > 0),
  conversion_factor_to_base numeric(18, 6) NOT NULL CHECK (conversion_factor_to_base > 0),
  normalized_base_qty numeric(18, 6) NOT NULL CHECK (normalized_base_qty > 0),
  restock_condition text NOT NULL DEFAULT 'RESELLABLE' CHECK (restock_condition IN ('RESELLABLE', 'DAMAGED')),
  unit_price numeric(19, 4) NOT NULL CHECK (unit_price >= 0),
  refund_amount numeric(19, 4) NOT NULL CHECK (refund_amount >= 0),
  ledger_entry_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, pos_return_id) REFERENCES pos_returns (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, invoice_line_id) REFERENCES sales_invoice_lines (tenant_id, id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES products (tenant_id, id),
  FOREIGN KEY (tenant_id, ledger_entry_id) REFERENCES stock_ledger_entries (tenant_id, id)
);

ALTER TABLE pos_return_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE pos_return_lines FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON pos_return_lines;
CREATE POLICY tenant_isolation_policy ON pos_return_lines
  AS PERMISSIVE
  FOR ALL
  TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

GRANT SELECT, INSERT ON TABLE pos_return_lines TO nexstock_app_user;

-- ============================================================================
-- 6. RBAC PERMISSIONS BACKFILL FOR UOM, PURCHASING & RETURNS
-- ============================================================================

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
    IF r_role.code IN ('TENANT_OWNER', 'ORG_ADMIN') THEN
      v_perms := ARRAY[
        'cat:uom:read',
        'pur:po:read',
        'pur:po:manage',
        'pur:grn:post',
        'pur:return:post',
        'pos:sale:return'
      ];
    ELSIF r_role.code = 'BRANCH_MANAGER' THEN
      v_perms := ARRAY[
        'cat:uom:read',
        'pur:po:read',
        'pur:po:manage',
        'pur:grn:post',
        'pur:return:post',
        'pos:sale:return'
      ];
    ELSIF r_role.code = 'PURCHASER' THEN
      v_perms := ARRAY[
        'cat:uom:read',
        'pur:po:read',
        'pur:po:manage',
        'pur:grn:post',
        'pur:return:post'
      ];
    ELSIF r_role.code = 'WAREHOUSE_CLERK' THEN
      v_perms := ARRAY[
        'cat:uom:read',
        'pur:po:read',
        'pur:grn:post',
        'pur:return:post'
      ];
    ELSIF r_role.code = 'CASHIER' THEN
      v_perms := ARRAY[
        'cat:uom:read',
        'pos:sale:return'
      ];
    ELSIF r_role.code = 'ACCOUNTANT' THEN
      v_perms := ARRAY[
        'cat:uom:read',
        'pur:po:read'
      ];
    ELSE
      v_perms := ARRAY[]::text[];
    END IF;

    FOREACH v_perm IN ARRAY v_perms LOOP
      INSERT INTO role_permissions (
        id, tenant_id, role_id, permission_key, created_at
      )
      VALUES (
        gen_random_uuid(),
        r_role.tenant_id,
        r_role.id,
        v_perm,
        clock_timestamp()
      )
      ON CONFLICT DO NOTHING;
    END LOOP;
  END LOOP;
END $$;

-- ============================================================================
-- 7. RECORD COMPLETION OF MIGRATION 0025
-- ============================================================================

INSERT INTO schema_migrations (version, name, filename)
VALUES (25, '0025_uom_foundation_and_variable_products', '0025_uom_foundation_and_variable_products.sql')
ON CONFLICT (version) DO NOTHING;

-- ============================================================================
-- NexStock Migration - 0032_smart_stock_intake_and_barcodes.sql
-- TARGET ENGINE: PostgreSQL 15+ / Supabase SQL Editor
-- PREREQUISITE: Must be executed AFTER 0031_qa_master_enhancements.sql
-- Covers:
--   1. Unified Stock Intake References / Inventory Layers (`stock_intake_lots`)
--   2. Smart Stock Configuration Change Detection & Review Alerts (`stock_config_alerts`)
--   3. Centralized Product Barcode Registry Extensions (intake/batch/package/price-source mappings)
--   4. Multi-UoM Package Selling Price Support on `product_unit_conversions`
--   5. POS Sales, Returns, Transfers & Ledger Intake Reference Traceability
--   6. Safe Historical Aggregate & FIFO Cost Layer Backfill
-- ============================================================================

DO $$
DECLARE
  v_0031_applied integer;
BEGIN
  SELECT COUNT(*) INTO v_0031_applied FROM schema_migrations WHERE version = 31;
  IF v_0031_applied = 0 THEN
    RAISE EXCEPTION 'MIGRATION_ORDER_ERROR: Migration 0032 requires Migration 0031 to be applied first.';
  END IF;
END $$;

-- ============================================================================
-- 1. UNIFIED STOCK INTAKE REFERENCES / INVENTORY LAYERS (`stock_intake_lots`)
-- ============================================================================

CREATE TABLE IF NOT EXISTS stock_intake_lots (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  branch_id uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  product_id uuid NOT NULL,
  batch_id uuid,
  ledger_entry_id uuid,
  supplier_id uuid,
  intake_code text NOT NULL CHECK (btrim(intake_code) <> ''),
  source_method text NOT NULL CHECK (
    source_method IN (
      'GRN',
      'OPENING_STOCK',
      'STOCK_IN',
      'ADJUSTMENT_POSITIVE',
      'STOCKTAKE',
      'TRANSFER_IN',
      'LEGACY_BACKFILL',
      'FIFO_LAYER_BACKFILL'
    )
  ),
  source_reference_type text,
  source_reference_id text,
  received_uom text NOT NULL CHECK (btrim(received_uom) <> ''),
  received_qty numeric(19, 6) NOT NULL CHECK (received_qty > 0),
  conversion_factor_to_base numeric(19, 6) NOT NULL DEFAULT 1.000000 CHECK (conversion_factor_to_base > 0),
  base_qty_received numeric(19, 6) NOT NULL CHECK (base_qty_received > 0),
  base_qty_remaining numeric(19, 6) NOT NULL CHECK (base_qty_remaining >= 0),
  base_qty_reserved numeric(19, 6) NOT NULL DEFAULT 0.000000 CHECK (base_qty_reserved >= 0),
  purchase_cost_per_received_uom numeric(19, 4) NOT NULL DEFAULT 0.0000 CHECK (purchase_cost_per_received_uom >= 0),
  purchase_cost_per_base_uom numeric(19, 4) NOT NULL DEFAULT 0.0000 CHECK (purchase_cost_per_base_uom >= 0),
  pricing_mode text NOT NULL DEFAULT 'INHERIT_PRODUCT' CHECK (
    pricing_mode IN ('INHERIT_PRODUCT', 'INHERIT_BRANCH', 'INTAKE_SPECIFIC')
  ),
  selling_uom text NOT NULL CHECK (btrim(selling_uom) <> ''),
  selling_price numeric(19, 4) CHECK (selling_price IS NULL OR selling_price >= 0),
  min_selling_price numeric(19, 4) CHECK (min_selling_price IS NULL OR min_selling_price >= 0),
  max_discount_pct numeric(5, 2) CHECK (max_discount_pct IS NULL OR (max_discount_pct >= 0 AND max_discount_pct <= 100)),
  currency_code text NOT NULL DEFAULT 'LKR' CHECK (char_length(currency_code) = 3),
  is_legacy_aggregate boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (
    status IN ('ACTIVE', 'DEPLETED', 'INACTIVE', 'REVERSED')
  ),
  config_snapshot_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  notes text,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by_user_id uuid REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, intake_code),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouses (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, product_id) REFERENCES products (tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_stock_intake_lots_lookup
  ON stock_intake_lots (tenant_id, product_id, warehouse_id, status, received_at ASC);

CREATE INDEX IF NOT EXISTS idx_stock_intake_lots_ledger
  ON stock_intake_lots (tenant_id, ledger_entry_id)
  WHERE ledger_entry_id IS NOT NULL;

ALTER TABLE stock_intake_lots ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_intake_lots FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON stock_intake_lots;
CREATE POLICY tenant_isolation_policy ON stock_intake_lots
  AS PERMISSIVE
  FOR ALL
  TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id() OR app_is_platform_admin())
  WITH CHECK (tenant_id = app_current_tenant_id() OR app_is_platform_admin());

GRANT SELECT, INSERT, UPDATE ON TABLE stock_intake_lots TO nexstock_app_user;

-- ============================================================================
-- 2. SMART STOCK CONFIGURATION CHANGE ALERTS (`stock_config_alerts`)
-- ============================================================================

CREATE TABLE IF NOT EXISTS stock_config_alerts (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  branch_id uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  product_id uuid NOT NULL,
  stock_intake_lot_id uuid,
  batch_id uuid,
  ledger_entry_id uuid,
  price_suggestion_id uuid,
  source_method text NOT NULL,
  source_event_key text NOT NULL CHECK (btrim(source_event_key) <> ''),
  severity text NOT NULL CHECK (severity IN ('INFO', 'WARNING', 'CONFLICT')),
  change_types_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  previous_config_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  incoming_config_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  summary text NOT NULL,
  impact_explanation text NOT NULL,
  recommended_action text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'RESOLVED', 'DISMISSED')),
  resolution_action text CHECK (
    resolution_action IS NULL OR resolution_action IN (
      'KEEP_GLOBAL_PRICE',
      'SET_INTAKE_SPECIFIC_PRICE',
      'CREATE_INTAKE_BARCODE',
      'UPDATE_GLOBAL_WITH_APPROVAL',
      'UPDATE_UOM_CONVERSION',
      'DISMISS'
    )
  ),
  resolution_notes text,
  resolution_payload_json jsonb,
  created_by_user_id uuid REFERENCES users (id),
  resolved_by_user_id uuid REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  resolved_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, source_event_key),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouses (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, product_id) REFERENCES products (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, stock_intake_lot_id) REFERENCES stock_intake_lots (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS idx_stock_config_alerts_lookup
  ON stock_config_alerts (tenant_id, status, severity, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_stock_config_alerts_product
  ON stock_config_alerts (tenant_id, product_id, status, created_at DESC);

ALTER TABLE stock_config_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_config_alerts FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON stock_config_alerts;
CREATE POLICY tenant_isolation_policy ON stock_config_alerts
  AS PERMISSIVE
  FOR ALL
  TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id() OR app_is_platform_admin())
  WITH CHECK (tenant_id = app_current_tenant_id() OR app_is_platform_admin());

GRANT SELECT, INSERT, UPDATE ON TABLE stock_config_alerts TO nexstock_app_user;

-- ============================================================================
-- 3. CENTRALIZED PRODUCT BARCODE EXTENSIONS & PACKAGE UOM PRICING
-- ============================================================================

ALTER TABLE product_barcodes
  ADD COLUMN IF NOT EXISTS stock_intake_lot_id uuid,
  ADD COLUMN IF NOT EXISTS batch_id uuid,
  ADD COLUMN IF NOT EXISTS branch_id uuid,
  ADD COLUMN IF NOT EXISTS warehouse_id uuid,
  ADD COLUMN IF NOT EXISTS conversion_factor_to_base numeric(19, 6)
    CHECK (conversion_factor_to_base IS NULL OR conversion_factor_to_base > 0),
  ADD COLUMN IF NOT EXISTS price_source_mode text NOT NULL DEFAULT 'INHERIT'
    CHECK (price_source_mode IN ('INHERIT', 'INTAKE_SPECIFIC', 'BATCH_SPECIFIC', 'PACKAGE_EXPLICIT')),
  ADD COLUMN IF NOT EXISTS selling_price_override numeric(19, 4)
    CHECK (selling_price_override IS NULL OR selling_price_override >= 0),
  ADD COLUMN IF NOT EXISTS label_note text,
  ADD COLUMN IF NOT EXISTS deactivated_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_product_barcodes_intake_lot
  ON product_barcodes (tenant_id, stock_intake_lot_id)
  WHERE stock_intake_lot_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_product_barcodes_batch
  ON product_barcodes (tenant_id, batch_id)
  WHERE batch_id IS NOT NULL;

ALTER TABLE product_unit_conversions
  ADD COLUMN IF NOT EXISTS selling_price numeric(19, 4)
    CHECK (selling_price IS NULL OR selling_price >= 0);

-- ============================================================================
-- 4. LEDGER, POS SALES, RETURNS & TRANSFERS INTAKE TRACEABILITY
-- ============================================================================

ALTER TABLE stock_ledger_entries
  ADD COLUMN IF NOT EXISTS stock_intake_lot_id uuid;

ALTER TABLE sales_invoice_lines
  ADD COLUMN IF NOT EXISTS stock_intake_lot_id uuid,
  ADD COLUMN IF NOT EXISTS intake_code_snapshot text,
  ADD COLUMN IF NOT EXISTS scanned_barcode text;

ALTER TABLE pos_return_lines
  ADD COLUMN IF NOT EXISTS stock_intake_lot_id uuid;

ALTER TABLE stock_transfer_lines
  ADD COLUMN IF NOT EXISTS source_intake_lot_id uuid,
  ADD COLUMN IF NOT EXISTS destination_intake_lot_id uuid;

-- ============================================================================
-- 5. HONEST HISTORICAL BACKFILL (OPEN FIFO COST LAYERS & LEGACY AGGREGATE)
-- ============================================================================

-- 5A. Backfill open non-batch FIFO cost layers 1:1 into `stock_intake_lots`
INSERT INTO stock_intake_lots (
  id,
  tenant_id,
  branch_id,
  warehouse_id,
  product_id,
  batch_id,
  ledger_entry_id,
  supplier_id,
  intake_code,
  source_method,
  source_reference_type,
  source_reference_id,
  received_uom,
  received_qty,
  conversion_factor_to_base,
  base_qty_received,
  base_qty_remaining,
  base_qty_reserved,
  purchase_cost_per_received_uom,
  purchase_cost_per_base_uom,
  pricing_mode,
  selling_uom,
  selling_price,
  currency_code,
  is_legacy_aggregate,
  status,
  config_snapshot_json,
  notes,
  received_at,
  created_at,
  updated_at
)
SELECT
  icl.id,
  icl.tenant_id,
  w.branch_id,
  icl.warehouse_id,
  icl.product_id,
  NULL,
  icl.ledger_entry_id,
  NULL,
  'INT-FIFO-' || upper(substr(replace(icl.id::text, '-', ''), 1, 10)),
  'FIFO_LAYER_BACKFILL',
  'FIFO_COST_LAYER',
  icl.id::text,
  p.base_uom,
  icl.received_qty,
  1.000000,
  icl.received_qty,
  icl.remaining_qty,
  0.000000,
  icl.unit_cost,
  icl.unit_cost,
  'INHERIT_PRODUCT',
  p.base_uom,
  p.selling_price,
  COALESCE(NULLIF(btrim(icl.currency_code), ''), 'LKR'),
  false,
  CASE WHEN icl.remaining_qty > 0 THEN 'ACTIVE' ELSE 'DEPLETED' END,
  jsonb_build_object(
    'baseUom', p.base_uom,
    'priceUom', COALESCE(p.price_uom, p.base_uom),
    'purchaseCost', p.purchase_cost,
    'sellingPrice', p.selling_price,
    'backfillSource', 'inventory_cost_layers'
  ),
  'Backfilled from existing open FIFO cost layer',
  icl.layer_date,
  icl.created_at,
  icl.updated_at
FROM inventory_cost_layers icl
INNER JOIN products p
  ON p.tenant_id = icl.tenant_id AND p.id = icl.product_id
INNER JOIN warehouses w
  ON w.tenant_id = icl.tenant_id AND w.id = icl.warehouse_id
WHERE icl.batch_id IS NULL
  AND p.tracking_mode = 'NONE'
  AND icl.remaining_qty > 0
ON CONFLICT DO NOTHING;

-- 5B. Backfill remaining unallocated aggregate balances for non-batch/non-serial (`NONE`) products
INSERT INTO stock_intake_lots (
  id,
  tenant_id,
  branch_id,
  warehouse_id,
  product_id,
  batch_id,
  ledger_entry_id,
  supplier_id,
  intake_code,
  source_method,
  source_reference_type,
  source_reference_id,
  received_uom,
  received_qty,
  conversion_factor_to_base,
  base_qty_received,
  base_qty_remaining,
  base_qty_reserved,
  purchase_cost_per_received_uom,
  purchase_cost_per_base_uom,
  pricing_mode,
  selling_uom,
  selling_price,
  currency_code,
  is_legacy_aggregate,
  status,
  config_snapshot_json,
  notes,
  received_at,
  created_at,
  updated_at
)
SELECT
  ib.id,
  ib.tenant_id,
  ib.branch_id,
  ib.warehouse_id,
  ib.product_id,
  NULL,
  ib.last_ledger_entry_id,
  NULL,
  'INT-LEG-' || upper(substr(replace(ib.id::text, '-', ''), 1, 10)),
  'LEGACY_BACKFILL',
  'INVENTORY_BALANCE',
  ib.id::text,
  p.base_uom,
  ib.qty_on_hand - COALESCE(existing_lots.allocated_qty, 0),
  1.000000,
  ib.qty_on_hand - COALESCE(existing_lots.allocated_qty, 0),
  ib.qty_on_hand - COALESCE(existing_lots.allocated_qty, 0),
  0.000000,
  COALESCE(ib.moving_avg_cost, p.purchase_cost, 0.0000),
  COALESCE(ib.moving_avg_cost, p.purchase_cost, 0.0000),
  'INHERIT_PRODUCT',
  p.base_uom,
  p.selling_price,
  COALESCE(t.base_currency, 'LKR'),
  true,
  'ACTIVE',
  jsonb_build_object(
    'baseUom', p.base_uom,
    'priceUom', COALESCE(p.price_uom, p.base_uom),
    'purchaseCost', COALESCE(ib.moving_avg_cost, p.purchase_cost, 0.0000),
    'sellingPrice', p.selling_price,
    'isLegacyAggregate', true
  ),
  'Pre-existing aggregate warehouse balance (no fabricated receipt metadata)',
  COALESCE(ib.last_movement_at, ib.updated_at, clock_timestamp()),
  COALESCE(ib.updated_at, clock_timestamp()),
  COALESCE(ib.updated_at, clock_timestamp())
FROM inventory_balances ib
INNER JOIN products p
  ON p.tenant_id = ib.tenant_id AND p.id = ib.product_id
INNER JOIN tenants t
  ON t.id = ib.tenant_id
LEFT JOIN (
  SELECT
    tenant_id,
    warehouse_id,
    product_id,
    SUM(base_qty_remaining) AS allocated_qty
  FROM stock_intake_lots
  WHERE status = 'ACTIVE'
  GROUP BY tenant_id, warehouse_id, product_id
) existing_lots
  ON existing_lots.tenant_id = ib.tenant_id
  AND existing_lots.warehouse_id = ib.warehouse_id
  AND existing_lots.product_id = ib.product_id
WHERE p.tracking_mode = 'NONE'
  AND ib.qty_on_hand > COALESCE(existing_lots.allocated_qty, 0)
ON CONFLICT DO NOTHING;

-- ============================================================================
-- 6. REGISTER MIGRATION 32
-- ============================================================================

INSERT INTO schema_migrations (version, name, filename)
VALUES (
  32,
  '0032_smart_stock_intake_and_barcodes',
  '0032_smart_stock_intake_and_barcodes.sql'
)
ON CONFLICT (version) DO NOTHING;

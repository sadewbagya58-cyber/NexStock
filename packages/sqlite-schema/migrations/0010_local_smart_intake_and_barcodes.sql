-- ============================================================================
-- NexStock — Local SQLite Schema Migration (Tauri Desktop & Mobile)
-- Version: 0010
-- Module: Smart Stock Intake Lots, Barcode Intake/Package Mappings & Sales Traceability
-- Note: Uses STRICT companion tables so migrations remain 100% idempotent when
--       re-executed directly.
-- ============================================================================

CREATE TABLE IF NOT EXISTS local_stock_intake_lots (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  warehouse_id TEXT NOT NULL,
  product_id TEXT NOT NULL REFERENCES local_products (id) ON DELETE CASCADE,
  batch_id TEXT,
  intake_code TEXT NOT NULL,
  source_method TEXT NOT NULL,
  received_uom TEXT NOT NULL,
  received_qty TEXT NOT NULL,
  conversion_factor_to_base TEXT NOT NULL DEFAULT '1.000000',
  base_qty_received TEXT NOT NULL,
  base_qty_remaining TEXT NOT NULL,
  purchase_cost_per_base_uom TEXT NOT NULL DEFAULT '0.0000',
  pricing_mode TEXT NOT NULL DEFAULT 'INHERIT_PRODUCT'
    CHECK (pricing_mode IN ('INHERIT_PRODUCT', 'INHERIT_BRANCH', 'INTAKE_SPECIFIC')),
  selling_uom TEXT NOT NULL,
  selling_price TEXT,
  is_legacy_aggregate INTEGER NOT NULL DEFAULT 0 CHECK (is_legacy_aggregate IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'DEPLETED', 'INACTIVE', 'REVERSED')),
  received_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, intake_code)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_local_stock_intake_lots_lookup
  ON local_stock_intake_lots (tenant_id, warehouse_id, product_id, status, received_at ASC);

CREATE TABLE IF NOT EXISTS local_barcode_intake_mappings (
  barcode_id TEXT PRIMARY KEY REFERENCES local_product_barcodes (id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  barcode TEXT NOT NULL,
  uom_code TEXT NOT NULL,
  stock_intake_lot_id TEXT,
  batch_id TEXT,
  conversion_factor_to_base TEXT,
  price_source_mode TEXT NOT NULL DEFAULT 'INHERIT'
    CHECK (price_source_mode IN ('INHERIT', 'INTAKE_SPECIFIC', 'BATCH_SPECIFIC', 'PACKAGE_EXPLICIT')),
  selling_price_override TEXT,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_local_barcode_intake_lookup
  ON local_barcode_intake_mappings (tenant_id, barcode, is_active);

CREATE TABLE IF NOT EXISTS local_uom_package_pricing (
  conversion_id TEXT PRIMARY KEY REFERENCES local_product_unit_conversions (id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  uom_code TEXT NOT NULL,
  selling_price TEXT,
  is_default_purchasing INTEGER NOT NULL DEFAULT 0 CHECK (is_default_purchasing IN (0, 1)),
  is_default_selling INTEGER NOT NULL DEFAULT 0 CHECK (is_default_selling IN (0, 1)),
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS local_sales_line_intake_links (
  line_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  invoice_id TEXT NOT NULL,
  stock_intake_lot_id TEXT,
  intake_code_snapshot TEXT,
  selling_uom TEXT NOT NULL,
  conversion_factor_to_base TEXT NOT NULL DEFAULT '1.000000',
  normalized_base_qty TEXT NOT NULL,
  scanned_barcode TEXT,
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_local_sales_line_intake_invoice
  ON local_sales_line_intake_links (tenant_id, invoice_id, line_id);

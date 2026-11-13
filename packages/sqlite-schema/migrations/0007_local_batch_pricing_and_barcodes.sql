-- ============================================================================
-- NexStock — Local SQLite Schema Migration (Tauri Desktop & Mobile)
-- Version: 0007
-- Module: Advanced Batch Pricing, Hybrid Internal Barcodes & Offline Print Queue
-- Note: Uses STRICT companion tables so migrations remain 100% idempotent when
--       re-executed directly (consistent with 0005_local_uom_and_variable_products.sql).
-- ============================================================================

CREATE TABLE IF NOT EXISTS local_tenant_branding (
  tenant_id TEXT PRIMARY KEY,
  shop_display_name TEXT,
  logo_url TEXT,
  batch_pricing_fallback_policy TEXT NOT NULL DEFAULT 'ALLOW_PRODUCT_FALLBACK'
    CHECK (batch_pricing_fallback_policy IN ('BLOCK_MISSING', 'ALLOW_PRODUCT_FALLBACK')),
  default_batch_allocation_policy TEXT NOT NULL DEFAULT 'FEFO'
    CHECK (default_batch_allocation_policy IN ('FEFO', 'FIFO')),
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS local_product_batch_policies (
  product_id TEXT PRIMARY KEY REFERENCES local_products (id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL,
  allocation_policy TEXT NOT NULL DEFAULT 'FEFO'
    CHECK (allocation_policy IN ('FEFO', 'FIFO', 'MANUAL')),
  require_batch_selling_price INTEGER NOT NULL DEFAULT 0 CHECK (require_batch_selling_price IN (0, 1)),
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS local_batch_pricing_profiles (
  tenant_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  warehouse_id TEXT NOT NULL,
  branch_id TEXT,
  batch_number TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'QUARANTINED', 'EXPIRED', 'INACTIVE', 'DAMAGED', 'DEPLETED')),
  reserved_quantity TEXT NOT NULL DEFAULT '0.000000',
  available_quantity TEXT NOT NULL DEFAULT '0.000000',
  selling_price TEXT,
  min_selling_price TEXT,
  max_discount_pct TEXT,
  batch_pricing_mode TEXT NOT NULL DEFAULT 'EXPLICIT'
    CHECK (batch_pricing_mode IN ('EXPLICIT', 'INHERIT_PRODUCT')),
  internal_barcode TEXT,
  internal_barcode_type TEXT NOT NULL DEFAULT 'CODE128'
    CHECK (internal_barcode_type IN ('CODE128', 'GS1_128')),
  sync_version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, batch_id),
  FOREIGN KEY (tenant_id, batch_id) REFERENCES local_inventory_batches (tenant_id, id) ON DELETE CASCADE
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_local_batches_internal_barcode
  ON local_batch_pricing_profiles (tenant_id, internal_barcode)
  WHERE internal_barcode IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_local_batch_pricing_lookup
  ON local_batch_pricing_profiles (tenant_id, warehouse_id, product_id, status);

CREATE TABLE IF NOT EXISTS local_sales_line_batch_links (
  line_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  invoice_id TEXT NOT NULL,
  batch_id TEXT,
  serial_id TEXT,
  unit_cost_snapshot TEXT NOT NULL DEFAULT '0.0000',
  selling_price_snapshot TEXT NOT NULL DEFAULT '0.0000',
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_local_sales_line_batch_invoice
  ON local_sales_line_batch_links (tenant_id, invoice_id, line_id);

CREATE TABLE IF NOT EXISTS local_batch_barcode_print_queue (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  branch_id TEXT,
  product_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  barcode_value TEXT NOT NULL,
  label_format TEXT NOT NULL CHECK (
    label_format IN (
      'THERMAL_40X30',
      'THERMAL_50X30',
      'THERMAL_50X40',
      'THERMAL_58',
      'THERMAL_80',
      'A4_SHEET'
    )
  ),
  print_quantity INTEGER NOT NULL CHECK (print_quantity > 0),
  is_reprint INTEGER NOT NULL DEFAULT 0 CHECK (is_reprint IN (0, 1)),
  printed_by_user_id TEXT NOT NULL,
  printed_at TEXT NOT NULL,
  synced INTEGER NOT NULL DEFAULT 0 CHECK (synced IN (0, 1))
) STRICT;

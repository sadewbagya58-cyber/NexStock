-- ============================================================================
-- NexStock — Local SQLite Schema Migration (Tauri Desktop & Flutter Mobile)
-- Version: 0005
-- Module: Units of Measure & Variable Quantity Products (Offline Mirror)
-- ============================================================================

CREATE TABLE IF NOT EXISTS local_units_of_measure (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('WEIGHT', 'VOLUME', 'COUNT', 'LENGTH')),
  base_unit_code TEXT NOT NULL,
  conversion_to_base_micro INTEGER NOT NULL CHECK (conversion_to_base_micro > 0), -- 10^-6 scale
  decimal_precision INTEGER NOT NULL DEFAULT 3,
  is_fractional INTEGER NOT NULL DEFAULT 0 CHECK (is_fractional IN (0, 1)),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1))
) STRICT;

INSERT OR IGNORE INTO local_units_of_measure (
  code, name, category, base_unit_code, conversion_to_base_micro, decimal_precision, is_fractional, is_active
) VALUES
  ('KG', 'Kilogram', 'WEIGHT', 'KG', 1000000, 3, 1, 1),
  ('G', 'Gram', 'WEIGHT', 'KG', 1000, 3, 1, 1),
  ('MG', 'Milligram', 'WEIGHT', 'KG', 1, 0, 0, 1),
  ('L', 'Liter', 'VOLUME', 'L', 1000000, 3, 1, 1),
  ('ML', 'Milliliter', 'VOLUME', 'L', 1000, 2, 1, 1),
  ('M', 'Meter', 'LENGTH', 'M', 1000000, 3, 1, 1),
  ('CM', 'Centimeter', 'LENGTH', 'M', 10000, 2, 1, 1),
  ('MM', 'Millimeter', 'LENGTH', 'M', 1000, 0, 0, 1),
  ('PCS', 'Pieces', 'COUNT', 'PCS', 1000000, 0, 0, 1),
  ('UNIT', 'Unit', 'COUNT', 'PCS', 1000000, 0, 0, 1),
  ('DOZEN', 'Dozen (12 pcs)', 'COUNT', 'PCS', 12000000, 0, 0, 1),
  ('PACK', 'Pack', 'COUNT', 'PCS', 1000000, 0, 0, 1),
  ('BOX', 'Box', 'COUNT', 'PCS', 1000000, 0, 0, 1),
  ('BAG', 'Bag', 'COUNT', 'PCS', 1000000, 0, 0, 1);

-- Extension table avoids non-idempotent ALTER TABLE ADD COLUMN in SQLite scripts
CREATE TABLE IF NOT EXISTS local_product_uom_configs (
  product_id TEXT PRIMARY KEY REFERENCES local_products (id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL,
  product_qty_mode TEXT NOT NULL DEFAULT 'STANDARD' CHECK (product_qty_mode IN ('STANDARD', 'VARIABLE')),
  measurement_category TEXT CHECK (measurement_category IS NULL OR measurement_category IN ('WEIGHT', 'VOLUME', 'COUNT', 'LENGTH')),
  purchase_uom TEXT,
  price_uom TEXT,
  allowed_selling_uoms_json TEXT NOT NULL DEFAULT '[]',
  qty_decimal_precision INTEGER NOT NULL DEFAULT 0 CHECK (qty_decimal_precision >= 0 AND qty_decimal_precision <= 6),
  featured_pos INTEGER NOT NULL DEFAULT 0 CHECK (featured_pos IN (0, 1)),
  density_g_per_ml_micro INTEGER CHECK (density_g_per_ml_micro IS NULL OR density_g_per_ml_micro > 0),
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_local_product_uom_featured
  ON local_product_uom_configs (tenant_id, product_qty_mode, featured_pos);

CREATE TABLE IF NOT EXISTS local_sales_line_uom_snapshots (
  line_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  invoice_id TEXT NOT NULL,
  original_entered_qty TEXT NOT NULL,
  original_uom_code TEXT NOT NULL,
  conversion_factor_to_base TEXT NOT NULL,
  normalized_base_qty TEXT NOT NULL,
  price_uom TEXT NOT NULL,
  price_per_price_uom TEXT NOT NULL,
  entry_source TEXT NOT NULL DEFAULT 'MANUAL',
  created_at TEXT NOT NULL
) STRICT;

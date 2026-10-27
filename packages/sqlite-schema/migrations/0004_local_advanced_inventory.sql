-- ============================================================================
-- NexStock — Local SQLite Schema Migration (Tauri Desktop & Flutter Mobile)
-- Version: 0004
-- Module: Advanced Inventory (Batches, Expiry, Serials, Costing & Stocktakes)
-- ============================================================================

CREATE TABLE IF NOT EXISTS local_inventory_batches (
  id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  warehouse_id TEXT NOT NULL,
  batch_number TEXT NOT NULL,
  supplier_id TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'QUARANTINED', 'DEPLETED')),
  received_date TEXT NOT NULL,
  manufacturing_date TEXT,
  expiry_date TEXT,
  initial_quantity TEXT NOT NULL,
  current_quantity TEXT NOT NULL DEFAULT '0.000000',
  unit_cost TEXT NOT NULL DEFAULT '0.0000',
  currency_code TEXT NOT NULL,
  quarantine_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, product_id, warehouse_id, batch_number)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_local_batches_lookup
  ON local_inventory_batches (tenant_id, warehouse_id, product_id, status);

CREATE TABLE IF NOT EXISTS local_inventory_serials (
  id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  batch_id TEXT,
  warehouse_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  serial_number TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'IN_STOCK'
    CHECK (status IN ('IN_STOCK', 'RESERVED', 'SOLD', 'RETURNED', 'QUARANTINED', 'DAMAGED', 'WRITTEN_OFF')),
  unit_cost TEXT NOT NULL DEFAULT '0.0000',
  currency_code TEXT NOT NULL,
  received_at TEXT NOT NULL,
  sold_at TEXT,
  last_movement_id TEXT,
  last_sale_invoice_id TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, product_id, serial_number)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_local_serials_lookup
  ON local_inventory_serials (tenant_id, product_id, status);

CREATE TABLE IF NOT EXISTS local_inventory_cost_layers (
  id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  warehouse_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  batch_id TEXT,
  ledger_entry_id TEXT NOT NULL,
  layer_date TEXT NOT NULL,
  received_qty TEXT NOT NULL,
  remaining_qty TEXT NOT NULL,
  unit_cost TEXT NOT NULL,
  currency_code TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'DEPLETED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_local_cost_layers_open
  ON local_inventory_cost_layers (tenant_id, warehouse_id, product_id, status);

CREATE TABLE IF NOT EXISTS local_stocktake_sessions (
  id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  count_number TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  warehouse_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('FULL_WAREHOUSE', 'CATEGORY', 'PARTIAL')),
  category_id TEXT,
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT', 'IN_PROGRESS', 'SUBMITTED', 'APPROVED', 'REJECTED', 'POSTED')),
  started_at TEXT,
  completed_at TEXT,
  counted_by_user_id TEXT,
  reviewed_by_user_id TEXT,
  rejection_reason TEXT,
  notes TEXT,
  sync_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, count_number)
) STRICT;

CREATE TABLE IF NOT EXISTS local_stocktake_lines (
  id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  batch_id TEXT,
  expected_qty TEXT NOT NULL,
  counted_qty TEXT,
  variance_qty TEXT,
  unit_cost TEXT NOT NULL DEFAULT '0.0000',
  variance_value TEXT NOT NULL DEFAULT '0.0000',
  adjustment_movement_id TEXT,
  notes TEXT,
  PRIMARY KEY (tenant_id, id)
) STRICT;

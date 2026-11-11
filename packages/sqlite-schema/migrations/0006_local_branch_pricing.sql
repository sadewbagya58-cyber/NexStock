-- ============================================================================
-- NexStock — Local SQLite Schema Migration (Tauri Desktop & Flutter Mobile)
-- Version: 0006
-- Module: Branch-Specific Approved Selling Prices & Discount Policy Mirror
-- Note: Offline POS uses synchronized approved prices ONLY; price approvals are server-only.
-- ============================================================================

CREATE TABLE IF NOT EXISTS local_product_branch_prices (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  product_id TEXT NOT NULL REFERENCES local_products (id) ON DELETE CASCADE,
  branch_id TEXT NOT NULL,
  selling_price_scaled INTEGER NOT NULL CHECK (selling_price_scaled >= 0), -- Scale 10^-4
  min_selling_price_scaled INTEGER CHECK (min_selling_price_scaled IS NULL OR min_selling_price_scaled >= 0),
  max_discount_pct_x100 INTEGER CHECK (max_discount_pct_x100 IS NULL OR (max_discount_pct_x100 >= 0 AND max_discount_pct_x100 <= 10000)),
  effective_date TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  sync_version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, product_id, branch_id)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_local_branch_prices_lookup
  ON local_product_branch_prices (tenant_id, branch_id, is_active, effective_date);

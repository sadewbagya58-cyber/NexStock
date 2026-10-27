-- ============================================================================
-- NexStock — Local SQLite Schema Migration (Tauri Desktop & Flutter Mobile)
-- Version: 0003
-- Module: POS & Billing Offline Store
-- ============================================================================

CREATE TABLE IF NOT EXISTS local_pos_shifts (
  id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  register_id TEXT NOT NULL,
  opened_by_user_id TEXT NOT NULL,
  closed_by_user_id TEXT,
  currency_code TEXT NOT NULL,
  opening_cash_float TEXT NOT NULL DEFAULT '0.0000',
  expected_closing_cash TEXT NOT NULL DEFAULT '0.0000',
  counted_closing_cash TEXT,
  cash_variance TEXT,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED')),
  opened_at TEXT NOT NULL,
  closed_at TEXT,
  notes TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (tenant_id, id)
) STRICT;

CREATE TABLE IF NOT EXISTS local_sales_invoices (
  id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  warehouse_id TEXT NOT NULL,
  register_id TEXT NOT NULL,
  shift_id TEXT,
  customer_id TEXT,
  cashier_user_id TEXT NOT NULL,
  invoice_number TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'COMPLETED' CHECK (status IN ('COMPLETED', 'VOIDED')),
  currency_code TEXT NOT NULL,
  exchange_rate_to_base TEXT NOT NULL DEFAULT '1.00000000',
  subtotal_amount TEXT NOT NULL,
  discount_amount TEXT NOT NULL DEFAULT '0.0000',
  tax_amount TEXT NOT NULL DEFAULT '0.0000',
  rounding_adjustment TEXT NOT NULL DEFAULT '0.0000',
  grand_total TEXT NOT NULL,
  total_paid TEXT NOT NULL,
  change_given TEXT NOT NULL DEFAULT '0.0000',
  customer_name TEXT,
  notes TEXT,
  voided_at TEXT,
  void_reason TEXT,
  voided_by_user_id TEXT,
  idempotency_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, invoice_number),
  UNIQUE (tenant_id, idempotency_key)
) STRICT;

CREATE TABLE IF NOT EXISTS local_sales_invoice_lines (
  id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  invoice_id TEXT NOT NULL,
  line_number INTEGER NOT NULL CHECK (line_number >= 1),
  product_id TEXT NOT NULL,
  sku TEXT NOT NULL,
  product_name TEXT NOT NULL,
  uom_code TEXT NOT NULL,
  quantity TEXT NOT NULL,
  unit_price TEXT NOT NULL,
  discount_amount TEXT NOT NULL DEFAULT '0.0000',
  tax_amount TEXT NOT NULL DEFAULT '0.0000',
  line_total TEXT NOT NULL,
  tax_rate_snapshot TEXT NOT NULL DEFAULT '{}',
  unit_cost_snapshot TEXT NOT NULL DEFAULT '0.0000',
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, invoice_id, line_number)
) STRICT;

CREATE TABLE IF NOT EXISTS local_sales_payments (
  id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  invoice_id TEXT NOT NULL,
  payment_method TEXT NOT NULL CHECK (payment_method IN ('CASH', 'CARD', 'OTHER')),
  amount TEXT NOT NULL,
  currency_code TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'COMPLETED' CHECK (status IN ('COMPLETED', 'VOIDED')),
  tendered_amount TEXT NOT NULL,
  change_amount TEXT NOT NULL DEFAULT '0.0000',
  card_reference TEXT,
  card_last_four TEXT,
  notes TEXT,
  recorded_by_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
) STRICT;

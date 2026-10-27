-- ============================================================================
-- NexStock — Phase 3 Database Migration
-- Version: 0004
-- Module: POS & Billing (Registers, Shifts, Sales Invoices, Lines, Payments)
-- Compatible with PostgreSQL 15+ / Supabase (Non-Superuser CREATEROLE Compatible)
-- ============================================================================

-- Preflight Checks
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = 3) THEN
    RAISE EXCEPTION 'MIGRATION_SEQUENCE_ERROR: Migration 0003 must be applied before 0004.';
  END IF;
END $$;

-- ============================================================================
-- 1. POS SHIFTS / CASHIER SESSIONS TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS pos_shifts (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  branch_id uuid NOT NULL,
  register_id uuid NOT NULL,
  opened_by_user_id uuid NOT NULL REFERENCES users (id),
  closed_by_user_id uuid REFERENCES users (id),
  currency_code text NOT NULL CHECK (char_length(currency_code) = 3),
  opening_cash_float numeric(19, 4) NOT NULL DEFAULT 0.0000 CHECK (opening_cash_float >= 0),
  expected_closing_cash numeric(19, 4) NOT NULL DEFAULT 0.0000,
  counted_closing_cash numeric(19, 4),
  cash_variance numeric(19, 4),
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED')),
  opened_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  closed_at timestamptz,
  notes text,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id),
  FOREIGN KEY (tenant_id, register_id) REFERENCES pos_registers (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS idx_pos_shifts_register_status
  ON pos_shifts (tenant_id, register_id, status);

ALTER TABLE pos_shifts ENABLE ROW LEVEL SECURITY;
ALTER TABLE pos_shifts FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON pos_shifts;
CREATE POLICY tenant_isolation_policy ON pos_shifts
  AS PERMISSIVE
  FOR ALL
  TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

-- ============================================================================
-- 2. SALES INVOICES TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS sales_invoices (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  branch_id uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  register_id uuid NOT NULL,
  shift_id uuid,
  customer_id uuid,
  cashier_user_id uuid NOT NULL REFERENCES users (id),
  invoice_number text NOT NULL,
  status text NOT NULL DEFAULT 'COMPLETED' CHECK (status IN ('COMPLETED', 'VOIDED')),
  currency_code text NOT NULL CHECK (char_length(currency_code) = 3),
  exchange_rate_to_base numeric(18, 8) NOT NULL DEFAULT 1.00000000 CHECK (exchange_rate_to_base > 0),
  subtotal_amount numeric(19, 4) NOT NULL CHECK (subtotal_amount >= 0),
  discount_amount numeric(19, 4) NOT NULL DEFAULT 0.0000 CHECK (discount_amount >= 0),
  tax_amount numeric(19, 4) NOT NULL DEFAULT 0.0000 CHECK (tax_amount >= 0),
  rounding_adjustment numeric(19, 4) NOT NULL DEFAULT 0.0000,
  grand_total numeric(19, 4) NOT NULL CHECK (grand_total >= 0),
  total_paid numeric(19, 4) NOT NULL CHECK (total_paid >= 0),
  change_given numeric(19, 4) NOT NULL DEFAULT 0.0000 CHECK (change_given >= 0),
  customer_name text,
  notes text,
  voided_at timestamptz,
  void_reason text,
  voided_by_user_id uuid REFERENCES users (id),
  idempotency_key uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, invoice_number),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id),
  FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouses (tenant_id, id),
  FOREIGN KEY (tenant_id, register_id) REFERENCES pos_registers (tenant_id, id),
  FOREIGN KEY (tenant_id, shift_id) REFERENCES pos_shifts (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS idx_sales_invoices_branch_created
  ON sales_invoices (tenant_id, branch_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_sales_invoices_register_created
  ON sales_invoices (tenant_id, register_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_sales_invoices_cashier_created
  ON sales_invoices (tenant_id, cashier_user_id, created_at DESC);

ALTER TABLE sales_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_invoices FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON sales_invoices;
CREATE POLICY tenant_isolation_policy ON sales_invoices
  AS PERMISSIVE
  FOR ALL
  TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

-- ============================================================================
-- 3. SALES INVOICE LINES TABLE (Immutable Historical Line Snapshot)
-- ============================================================================

CREATE TABLE IF NOT EXISTS sales_invoice_lines (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  invoice_id uuid NOT NULL,
  line_number integer NOT NULL CHECK (line_number >= 1),
  product_id uuid NOT NULL,
  sku text NOT NULL,
  product_name text NOT NULL,
  uom_code text NOT NULL CHECK (btrim(uom_code) <> ''),
  quantity numeric(18, 6) NOT NULL CHECK (quantity > 0),
  unit_price numeric(19, 4) NOT NULL CHECK (unit_price >= 0),
  discount_amount numeric(19, 4) NOT NULL DEFAULT 0.0000 CHECK (discount_amount >= 0),
  tax_amount numeric(19, 4) NOT NULL DEFAULT 0.0000 CHECK (tax_amount >= 0),
  line_total numeric(19, 4) NOT NULL CHECK (line_total >= 0),
  tax_rate_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  unit_cost_snapshot numeric(19, 4) NOT NULL DEFAULT 0.0000,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, invoice_id, line_number),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES sales_invoices (tenant_id, id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES products (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS idx_sales_invoice_lines_product
  ON sales_invoice_lines (tenant_id, product_id);

ALTER TABLE sales_invoice_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_invoice_lines FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON sales_invoice_lines;
CREATE POLICY tenant_isolation_policy ON sales_invoice_lines
  AS PERMISSIVE
  FOR ALL
  TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

-- ============================================================================
-- 4. SALES PAYMENTS TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS sales_payments (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  invoice_id uuid NOT NULL,
  payment_method text NOT NULL CHECK (payment_method IN ('CASH', 'CARD', 'OTHER')),
  amount numeric(19, 4) NOT NULL CHECK (amount > 0),
  currency_code text NOT NULL CHECK (char_length(currency_code) = 3),
  status text NOT NULL DEFAULT 'COMPLETED' CHECK (status IN ('COMPLETED', 'VOIDED')),
  tendered_amount numeric(19, 4) NOT NULL CHECK (tendered_amount >= 0),
  change_amount numeric(19, 4) NOT NULL DEFAULT 0.0000 CHECK (change_amount >= 0),
  card_reference text,
  card_last_four text CHECK (card_last_four IS NULL OR char_length(card_last_four) = 4),
  notes text,
  recorded_by_user_id uuid NOT NULL REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES sales_invoices (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS idx_sales_payments_invoice
  ON sales_payments (tenant_id, invoice_id);

ALTER TABLE sales_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_payments FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON sales_payments;
CREATE POLICY tenant_isolation_policy ON sales_payments
  AS PERMISSIVE
  FOR ALL
  TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

-- ============================================================================
-- 5. IMMUTABILITY & AUDIT TRIGGERS
-- ============================================================================

-- Guard 1: Hard Deletes Forbidden on Sales and Payments
CREATE OR REPLACE FUNCTION prevent_sales_record_hard_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'HARD_DELETE_FORBIDDEN: Rows in financial sales table "%" cannot be hard-deleted. Use VOID lifecycle state instead.', TG_TABLE_NAME;
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_hard_delete_sales_invoices ON sales_invoices;
CREATE TRIGGER trg_prevent_hard_delete_sales_invoices
  BEFORE DELETE ON sales_invoices
  FOR EACH ROW
  EXECUTE FUNCTION prevent_sales_record_hard_delete();

DROP TRIGGER IF EXISTS trg_prevent_hard_delete_sales_invoice_lines ON sales_invoice_lines;
CREATE TRIGGER trg_prevent_hard_delete_sales_invoice_lines
  BEFORE DELETE ON sales_invoice_lines
  FOR EACH ROW
  EXECUTE FUNCTION prevent_sales_record_hard_delete();

DROP TRIGGER IF EXISTS trg_prevent_hard_delete_sales_payments ON sales_payments;
CREATE TRIGGER trg_prevent_hard_delete_sales_payments
  BEFORE DELETE ON sales_payments
  FOR EACH ROW
  EXECUTE FUNCTION prevent_sales_record_hard_delete();

-- Guard 2: Line Item Snapshots are strictly immutable (No UPDATE allowed)
CREATE OR REPLACE FUNCTION prevent_sales_line_item_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'IMMUTABLE_TABLE_VIOLATION: sales_invoice_lines row "%" cannot be updated once recorded.', OLD.id;
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_update_sales_invoice_lines ON sales_invoice_lines;
CREATE TRIGGER trg_prevent_update_sales_invoice_lines
  BEFORE UPDATE ON sales_invoice_lines
  FOR EACH ROW
  EXECUTE FUNCTION prevent_sales_line_item_update();

-- ============================================================================
-- 6. RBAC PERMISSIONS BACKFILL FOR POS
-- ============================================================================

DO $$
DECLARE
  r_role RECORD;
  v_perm text;
  v_perms text[];
BEGIN
  FOR r_role IN SELECT id, tenant_id, code FROM roles LOOP
    IF r_role.code IN ('OWNER', 'ADMIN', 'INVENTORY_MANAGER') THEN
      v_perms := ARRAY[
        'pos:register:read',
        'pos:shift:open',
        'pos:shift:close',
        'pos:sale:create',
        'pos:sale:read',
        'pos:sale:void',
        'pos:payment:create'
      ];
    ELSIF r_role.code = 'CASHIER' THEN
      v_perms := ARRAY[
        'pos:register:read',
        'pos:shift:open',
        'pos:shift:close',
        'pos:sale:create',
        'pos:sale:read',
        'pos:payment:create'
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

-- ============================================================================
-- 7. APPLICATION USER GRANTS
-- ============================================================================

GRANT SELECT, INSERT, UPDATE ON TABLE pos_shifts TO nexstock_app_user;
GRANT SELECT, INSERT, UPDATE ON TABLE sales_invoices TO nexstock_app_user;
GRANT SELECT, INSERT ON TABLE sales_invoice_lines TO nexstock_app_user;
GRANT SELECT, INSERT, UPDATE ON TABLE sales_payments TO nexstock_app_user;

-- Record completion of Migration 0004
INSERT INTO schema_migrations (version, name, filename)
VALUES (4, '0004_phase3_pos_and_billing', '0004_phase3_pos_and_billing.sql')
ON CONFLICT (version) DO UPDATE
  SET applied_at = clock_timestamp(),
      filename = EXCLUDED.filename;

-- ============================================================================
-- NexStock — PostgreSQL Migration 0034
-- Module: Waste Log & Inventory Loss Management + Return Disposition Integration
-- Notes:
--   - 100% idempotent and RLS-enforced via (tenant_id) composite keys.
--   - Integrates with `stock_ledger_entries` via movement_type='WASTE_OUT' &
--     entry_source='WASTE', never creating a parallel stock balance cache.
--   - Extends `pos_return_lines` & adds `pos_return_dispositions` to track
--     partial RESTOCK / WASTE / PENDING_INSPECTION splits with zero double-deduction.
-- ============================================================================

DO $$
BEGIN
  IF to_regclass('public.product_branch_assignments') IS NULL THEN
    RAISE EXCEPTION 'MIGRATION_ORDER_ERROR: 0033_branch_catalog_isolation_and_customer_address must be applied before 0034';
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 1. Extend Stock Ledger Constraints for WASTE_OUT & entry_source = WASTE
-- ----------------------------------------------------------------------------

DO $$
DECLARE
  v_con RECORD;
BEGIN
  FOR v_con IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'stock_ledger_entries'::regclass
      AND contype = 'c'
      AND (
        pg_get_constraintdef(oid) ~ 'movement_type'
        OR pg_get_constraintdef(oid) ~ 'entry_source'
      )
  LOOP
    EXECUTE format('ALTER TABLE stock_ledger_entries DROP CONSTRAINT IF EXISTS %I', v_con.conname);
  END LOOP;
END $$;

ALTER TABLE stock_ledger_entries
  ADD CONSTRAINT stock_ledger_entries_movement_type_check
    CHECK (
      movement_type IN (
        'OPENING_STOCK',
        'STOCK_IN',
        'STOCK_OUT',
        'ADJUSTMENT_POSITIVE',
        'ADJUSTMENT_NEGATIVE',
        'WASTE_OUT',
        'CORRECTION_REVERSAL',
        'CUSTOMER_RETURN_RESTOCK',
        'SUPPLIER_RETURN',
        'TRANSFER_OUT',
        'TRANSFER_IN'
      )
    ),
  ADD CONSTRAINT stock_ledger_entries_sign_check
    CHECK (
      (
        movement_type IN ('OPENING_STOCK', 'STOCK_IN', 'ADJUSTMENT_POSITIVE', 'CUSTOMER_RETURN_RESTOCK', 'TRANSFER_IN')
        AND qty_delta > 0
        AND input_qty > 0
      )
      OR (
        movement_type IN ('STOCK_OUT', 'ADJUSTMENT_NEGATIVE', 'WASTE_OUT', 'SUPPLIER_RETURN', 'TRANSFER_OUT')
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
    ),
  ADD CONSTRAINT stock_ledger_entries_entry_source_check
    CHECK (
      entry_source IN (
        'OPENING_BALANCE',
        'PURCHASE_RECEIPT',
        'POS_SALE',
        'POS_VOID',
        'CUSTOMER_RETURN',
        'SUPPLIER_RETURN',
        'STOCKTAKE',
        'STOCK_TRANSFER',
        'UOM_CORRECTION',
        'WASTE',
        'MANUAL',
        'MANUAL_WEIGHT',
        'SCALE_WEIGHT',
        'SYSTEM_REVERSAL'
      )
    );

-- ----------------------------------------------------------------------------
-- 2. Configurable Waste Reasons
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS waste_reasons (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  code text NOT NULL CHECK (btrim(code) <> ''),
  name text NOT NULL CHECK (btrim(name) <> ''),
  description text,
  is_system_default boolean NOT NULL DEFAULT false,
  requires_description boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 100,
  created_by_user_id uuid REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, code)
);

CREATE INDEX IF NOT EXISTS idx_waste_reasons_tenant_active
  ON waste_reasons (tenant_id, is_active, sort_order, code);

ALTER TABLE waste_reasons ENABLE ROW LEVEL SECURITY;
ALTER TABLE waste_reasons FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON waste_reasons;
CREATE POLICY tenant_isolation_policy ON waste_reasons
  AS PERMISSIVE
  FOR ALL
  TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

GRANT SELECT, INSERT, UPDATE ON TABLE waste_reasons TO nexstock_app_user;

-- Seed default waste reasons for all pre-existing tenants
INSERT INTO waste_reasons (
  id,
  tenant_id,
  code,
  name,
  description,
  is_system_default,
  requires_description,
  is_active,
  sort_order
)
SELECT
  gen_random_uuid(),
  t.id,
  r.code,
  r.name,
  r.description,
  true,
  r.requires_description,
  true,
  r.sort_order
FROM tenants t
CROSS JOIN (
  VALUES
    ('EXPIRED', 'Expired', 'Inventory passed expiration / best-before date', false, 10),
    ('DAMAGED', 'Damaged', 'Physically damaged, crushed, broken, or torn goods', false, 20),
    ('SPOILED', 'Spoiled', 'Perishable spoilage, rot, or temperature excursion loss', false, 30),
    ('LOST_MISSING', 'Lost/Missing', 'Unaccounted shrinkage, misplaced or missing items', false, 40),
    ('CONTAMINATED', 'Contaminated', 'Chemical, pest, moisture, or hygiene contamination', false, 50),
    ('PRODUCTION_WASTE', 'Production Waste', 'Trim, prep, repacking, or processing discard', false, 60),
    ('INTERNAL_CONSUMPTION', 'Internal Consumption', 'Staff/store sample, demonstration, or internal use', false, 70),
    ('THEFT_SUSPECTED_LOSS', 'Theft/Suspected Loss', 'Suspected pilferage or unexplained theft loss', false, 80),
    ('OTHER', 'Other', 'Other specified inventory loss (requires description)', true, 90)
) AS r(code, name, description, requires_description, sort_order)
ON CONFLICT (tenant_id, code) DO NOTHING;

-- ----------------------------------------------------------------------------
-- 3. Waste Logs Header & Item Lines
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS waste_logs (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  waste_number text NOT NULL CHECK (btrim(waste_number) <> ''),
  branch_id uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  source_type text NOT NULL DEFAULT 'MANUAL'
    CHECK (source_type IN ('MANUAL', 'CUSTOMER_RETURN')),
  source_reference_id uuid,
  status text NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT', 'CONFIRMED', 'CANCELLED', 'REVERSED')),
  reason_id uuid NOT NULL,
  reason_code text NOT NULL CHECK (btrim(reason_code) <> ''),
  reason_name text NOT NULL CHECK (btrim(reason_name) <> ''),
  description text,
  currency_code char(3) NOT NULL REFERENCES currencies (code),
  total_base_qty numeric(18, 6) NOT NULL DEFAULT 0 CHECK (total_base_qty >= 0),
  total_cost numeric(19, 4) NOT NULL DEFAULT 0 CHECK (total_cost >= 0),
  sync_command_id uuid,
  created_by_user_id uuid NOT NULL REFERENCES users (id),
  confirmed_by_user_id uuid REFERENCES users (id),
  confirmed_at timestamptz,
  cancelled_by_user_id uuid REFERENCES users (id),
  cancelled_at timestamptz,
  reversed_by_user_id uuid REFERENCES users (id),
  reversed_at timestamptz,
  reversal_reason text,
  idempotency_key uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, waste_number),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id),
  FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouses (tenant_id, id),
  FOREIGN KEY (tenant_id, reason_id) REFERENCES waste_reasons (tenant_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_waste_logs_sync_command_unique
  ON waste_logs (tenant_id, sync_command_id)
  WHERE sync_command_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_waste_logs_tenant_status_created
  ON waste_logs (tenant_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_waste_logs_tenant_branch_created
  ON waste_logs (tenant_id, branch_id, warehouse_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_waste_logs_source_ref
  ON waste_logs (tenant_id, source_type, source_reference_id)
  WHERE source_reference_id IS NOT NULL;

ALTER TABLE waste_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE waste_logs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON waste_logs;
CREATE POLICY tenant_isolation_policy ON waste_logs
  AS PERMISSIVE
  FOR ALL
  TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

GRANT SELECT, INSERT, UPDATE ON TABLE waste_logs TO nexstock_app_user;

CREATE TABLE IF NOT EXISTS waste_log_lines (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  waste_log_id uuid NOT NULL,
  line_number integer NOT NULL CHECK (line_number >= 1),
  product_id uuid NOT NULL,
  batch_id uuid,
  serial_id uuid,
  stock_intake_lot_id uuid,
  pos_return_line_id uuid,
  sales_invoice_id uuid,
  sales_invoice_line_id uuid,
  waste_uom text NOT NULL CHECK (btrim(waste_uom) <> ''),
  waste_qty numeric(18, 6) NOT NULL CHECK (waste_qty > 0),
  conversion_factor_to_base numeric(18, 6) NOT NULL CHECK (conversion_factor_to_base > 0),
  normalized_base_qty numeric(18, 6) NOT NULL CHECK (normalized_base_qty > 0),
  deducted_from_on_hand boolean NOT NULL DEFAULT true,
  valuation_method_snapshot text NOT NULL DEFAULT 'MOVING_AVG'
    CHECK (valuation_method_snapshot IN ('MOVING_AVG', 'FIFO')),
  unit_cost_snapshot numeric(19, 4) NOT NULL DEFAULT 0 CHECK (unit_cost_snapshot >= 0),
  total_cost_snapshot numeric(19, 4) NOT NULL DEFAULT 0 CHECK (total_cost_snapshot >= 0),
  consumed_cost_layers_json jsonb,
  prior_batch_status text,
  prior_serial_status text,
  ledger_entry_id uuid,
  reversal_ledger_entry_id uuid,
  notes text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, waste_log_id, line_number),
  FOREIGN KEY (tenant_id, waste_log_id) REFERENCES waste_logs (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, product_id) REFERENCES products (tenant_id, id),
  FOREIGN KEY (tenant_id, batch_id) REFERENCES inventory_batches (tenant_id, id),
  FOREIGN KEY (tenant_id, serial_id) REFERENCES inventory_serials (tenant_id, id),
  FOREIGN KEY (tenant_id, ledger_entry_id) REFERENCES stock_ledger_entries (tenant_id, id),
  FOREIGN KEY (tenant_id, reversal_ledger_entry_id) REFERENCES stock_ledger_entries (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS idx_waste_log_lines_waste_log
  ON waste_log_lines (tenant_id, waste_log_id, line_number);

CREATE INDEX IF NOT EXISTS idx_waste_log_lines_product
  ON waste_log_lines (tenant_id, product_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_waste_log_lines_return_line
  ON waste_log_lines (tenant_id, pos_return_line_id)
  WHERE pos_return_line_id IS NOT NULL;

ALTER TABLE waste_log_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE waste_log_lines FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON waste_log_lines;
CREATE POLICY tenant_isolation_policy ON waste_log_lines
  AS PERMISSIVE
  FOR ALL
  TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE waste_log_lines TO nexstock_app_user;

-- ----------------------------------------------------------------------------
-- 4. Customer Return Disposition Tracking (Prevent Double Deduction)
-- ----------------------------------------------------------------------------

ALTER TABLE pos_return_lines
  ADD COLUMN IF NOT EXISTS disposition_status text NOT NULL DEFAULT 'RESTOCKED'
    CHECK (disposition_status IN ('PENDING_INSPECTION', 'PARTIAL', 'RESTOCKED', 'WASTED', 'MIXED', 'DAMAGED_UNPOSTED'));

ALTER TABLE pos_return_lines
  ADD COLUMN IF NOT EXISTS restocked_base_qty numeric(18, 6) NOT NULL DEFAULT 0 CHECK (restocked_base_qty >= 0);

ALTER TABLE pos_return_lines
  ADD COLUMN IF NOT EXISTS wasted_base_qty numeric(18, 6) NOT NULL DEFAULT 0 CHECK (wasted_base_qty >= 0);

ALTER TABLE pos_return_lines
  ADD COLUMN IF NOT EXISTS pending_base_qty numeric(18, 6) NOT NULL DEFAULT 0 CHECK (pending_base_qty >= 0);

ALTER TABLE pos_return_lines
  ADD COLUMN IF NOT EXISTS waste_log_id uuid;

UPDATE pos_return_lines
SET
  restocked_base_qty = CASE WHEN restock_condition = 'RESELLABLE' THEN normalized_base_qty ELSE 0 END,
  wasted_base_qty = 0,
  pending_base_qty = 0,
  disposition_status = CASE WHEN restock_condition = 'RESELLABLE' THEN 'RESTOCKED' ELSE 'DAMAGED_UNPOSTED' END
WHERE restocked_base_qty = 0 AND wasted_base_qty = 0 AND pending_base_qty = 0;

GRANT SELECT, INSERT, UPDATE ON TABLE pos_return_lines TO nexstock_app_user;

CREATE TABLE IF NOT EXISTS pos_return_dispositions (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  pos_return_id uuid NOT NULL,
  pos_return_line_id uuid NOT NULL,
  disposition_type text NOT NULL CHECK (disposition_type IN ('RESTOCK', 'WASTE')),
  quantity numeric(18, 6) NOT NULL CHECK (quantity > 0),
  uom_code text NOT NULL CHECK (btrim(uom_code) <> ''),
  normalized_base_qty numeric(18, 6) NOT NULL CHECK (normalized_base_qty > 0),
  from_restocked_stock boolean NOT NULL DEFAULT false,
  waste_log_id uuid,
  ledger_entry_id uuid,
  reason_code text,
  notes text,
  actor_user_id uuid NOT NULL REFERENCES users (id),
  idempotency_key uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, pos_return_id) REFERENCES pos_returns (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, pos_return_line_id) REFERENCES pos_return_lines (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, waste_log_id) REFERENCES waste_logs (tenant_id, id),
  FOREIGN KEY (tenant_id, ledger_entry_id) REFERENCES stock_ledger_entries (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS idx_pos_return_dispositions_return_line
  ON pos_return_dispositions (tenant_id, pos_return_line_id, created_at ASC);

ALTER TABLE pos_return_dispositions ENABLE ROW LEVEL SECURITY;
ALTER TABLE pos_return_dispositions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON pos_return_dispositions;
CREATE POLICY tenant_isolation_policy ON pos_return_dispositions
  AS PERMISSIVE
  FOR ALL
  TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

GRANT SELECT, INSERT ON TABLE pos_return_dispositions TO nexstock_app_user;

-- ============================================================================
-- 5. REGISTER MIGRATION 34
-- ============================================================================

INSERT INTO schema_migrations (version, name, filename)
VALUES (
  34,
  '0034_waste_log_management',
  '0034_waste_log_management.sql'
)
ON CONFLICT (version) DO NOTHING;

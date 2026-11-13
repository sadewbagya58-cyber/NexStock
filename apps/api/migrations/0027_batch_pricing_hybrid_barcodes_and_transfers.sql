-- ============================================================================
-- NexStock Migration - 0027_batch_pricing_hybrid_barcodes_and_transfers.sql
-- TARGET ENGINE: PostgreSQL 15+ / Supabase SQL Editor
-- PREREQUISITE: Must be executed AFTER 0026_smart_pricing_management.sql
-- Modules Covered: ORG (Shop Branding), CAT (Batch Allocation / UOM),
--                  INV (Batch Pricing, Hybrid Internal Barcodes, Transfers),
--                  PUR (GRN Batch Intake), POS (Batch Returns)
-- ============================================================================

-- Preflight Check: Sequential migration verification
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = 26) THEN
    RAISE EXCEPTION 'MIGRATION_SEQUENCE_ERROR: Migration 0026 must be applied before 0027.';
  END IF;
END $$;

-- ============================================================================
-- 1. TENANT SHOP BRANDING FOR THERMAL LABELS & RECEIPTS (`tenants`)
-- ============================================================================

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS shop_display_name text,
  ADD COLUMN IF NOT EXISTS logo_url text;

-- ============================================================================
-- 2. PRICING & PRODUCT POLICY EXTENSIONS (`pricing_settings`, `products`)
-- ============================================================================

ALTER TABLE pricing_settings
  ADD COLUMN IF NOT EXISTS batch_pricing_fallback_policy text NOT NULL DEFAULT 'ALLOW_PRODUCT_FALLBACK'
    CHECK (batch_pricing_fallback_policy IN ('BLOCK_MISSING', 'ALLOW_PRODUCT_FALLBACK')),
  ADD COLUMN IF NOT EXISTS default_batch_allocation_policy text NOT NULL DEFAULT 'FEFO'
    CHECK (default_batch_allocation_policy IN ('FEFO', 'FIFO'));

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS allocation_policy text NOT NULL DEFAULT 'FEFO'
    CHECK (allocation_policy IN ('FEFO', 'FIFO', 'MANUAL')),
  ADD COLUMN IF NOT EXISTS require_batch_selling_price boolean NOT NULL DEFAULT false;

-- ============================================================================
-- 3. BATCH PRICING, RESERVED QTY & HYBRID INTERNAL BARCODES (`inventory_batches`)
-- ============================================================================

ALTER TABLE inventory_batches
  ADD COLUMN IF NOT EXISTS branch_id uuid,
  ADD COLUMN IF NOT EXISTS reserved_quantity numeric(18, 6) NOT NULL DEFAULT 0
    CHECK (reserved_quantity >= 0),
  ADD COLUMN IF NOT EXISTS internal_barcode text,
  ADD COLUMN IF NOT EXISTS internal_barcode_type text NOT NULL DEFAULT 'CODE128'
    CHECK (internal_barcode_type IN ('CODE128', 'GS1_128')),
  ADD COLUMN IF NOT EXISTS goods_receipt_id uuid,
  ADD COLUMN IF NOT EXISTS goods_receipt_line_id uuid,
  ADD COLUMN IF NOT EXISTS min_selling_price numeric(19, 4)
    CHECK (min_selling_price IS NULL OR min_selling_price >= 0),
  ADD COLUMN IF NOT EXISTS max_discount_pct numeric(5, 2)
    CHECK (max_discount_pct IS NULL OR (max_discount_pct >= 0 AND max_discount_pct <= 100)),
  ADD COLUMN IF NOT EXISTS batch_pricing_mode text NOT NULL DEFAULT 'EXPLICIT'
    CHECK (batch_pricing_mode IN ('EXPLICIT', 'INHERIT_PRODUCT'));

-- Backfill branch_id from warehouses for any pre-0027 rows
UPDATE inventory_batches b
SET branch_id = w.branch_id
FROM warehouses w
WHERE w.tenant_id = b.tenant_id
  AND w.id = b.warehouse_id
  AND b.branch_id IS NULL;

-- Backfill legacy null-price batches to INHERIT_PRODUCT so existing inventories respect fallback policy
UPDATE inventory_batches
SET batch_pricing_mode = 'INHERIT_PRODUCT'
WHERE selling_price IS NULL
  AND batch_pricing_mode = 'EXPLICIT';

DO $$
DECLARE
  v_con RECORD;
BEGIN
  FOR v_con IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'inventory_batches'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ~ 'status'
  LOOP
    EXECUTE format('ALTER TABLE inventory_batches DROP CONSTRAINT IF EXISTS %I', v_con.conname);
  END LOOP;
END $$;

ALTER TABLE inventory_batches
  ADD CONSTRAINT inventory_batches_status_check
  CHECK (status IN ('ACTIVE', 'QUARANTINED', 'EXPIRED', 'INACTIVE', 'DAMAGED', 'DEPLETED'));

CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_batches_internal_barcode_unique
  ON inventory_batches (tenant_id, internal_barcode)
  WHERE internal_barcode IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_inventory_batches_branch_lookup
  ON inventory_batches (tenant_id, branch_id, product_id, status);

-- ============================================================================
-- 4. IMMUTABLE BATCH PRICE HISTORY LEDGER (`batch_price_history`)
-- ============================================================================

CREATE TABLE IF NOT EXISTS batch_price_history (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  branch_id uuid,
  product_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  previous_price numeric(19, 4),
  new_price numeric(19, 4) NOT NULL CHECK (new_price >= 0),
  cost_snapshot numeric(19, 4) NOT NULL DEFAULT 0 CHECK (cost_snapshot >= 0),
  change_type text NOT NULL CHECK (
    change_type IN ('GRN_INTAKE', 'MANUAL_UPDATE', 'SMART_PRICING_APPROVAL', 'POS_OVERRIDE', 'REVERSAL')
  ),
  suggestion_id uuid,
  reason text NOT NULL CHECK (btrim(reason) <> ''),
  actor_user_id uuid NOT NULL REFERENCES users (id),
  approver_user_id uuid REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES products (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, batch_id) REFERENCES inventory_batches (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id),
  FOREIGN KEY (tenant_id, suggestion_id) REFERENCES price_suggestions (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS idx_batch_price_history_lookup
  ON batch_price_history (tenant_id, batch_id, created_at DESC);

DROP TRIGGER IF EXISTS batch_price_history_immutable_trg ON batch_price_history;
CREATE TRIGGER batch_price_history_immutable_trg
  BEFORE UPDATE OR DELETE ON batch_price_history
  FOR EACH ROW
  EXECUTE FUNCTION prevent_immutable_row_mutation();

ALTER TABLE batch_price_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE batch_price_history FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON batch_price_history;
CREATE POLICY tenant_isolation_policy ON batch_price_history
  AS PERMISSIVE
  FOR ALL
  TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

GRANT SELECT, INSERT ON TABLE batch_price_history TO nexstock_app_user;

-- ============================================================================
-- 5. IMMUTABLE BATCH BARCODE PRINT & REPRINT AUDIT (`batch_barcode_print_logs`)
-- ============================================================================

CREATE TABLE IF NOT EXISTS batch_barcode_print_logs (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  branch_id uuid,
  product_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  barcode_value text NOT NULL CHECK (btrim(barcode_value) <> ''),
  label_format text NOT NULL CHECK (
    label_format IN (
      'THERMAL_40X30',
      'THERMAL_50X30',
      'THERMAL_50X40',
      'THERMAL_58',
      'THERMAL_80',
      'A4_SHEET'
    )
  ),
  print_quantity integer NOT NULL CHECK (print_quantity > 0),
  is_reprint boolean NOT NULL DEFAULT false,
  printed_by_user_id uuid NOT NULL REFERENCES users (id),
  printed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES products (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, batch_id) REFERENCES inventory_batches (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS idx_batch_barcode_print_logs_lookup
  ON batch_barcode_print_logs (tenant_id, batch_id, printed_at DESC);

DROP TRIGGER IF EXISTS batch_barcode_print_logs_immutable_trg ON batch_barcode_print_logs;
CREATE TRIGGER batch_barcode_print_logs_immutable_trg
  BEFORE UPDATE OR DELETE ON batch_barcode_print_logs
  FOR EACH ROW
  EXECUTE FUNCTION prevent_immutable_row_mutation();

ALTER TABLE batch_barcode_print_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE batch_barcode_print_logs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON batch_barcode_print_logs;
CREATE POLICY tenant_isolation_policy ON batch_barcode_print_logs
  AS PERMISSIVE
  FOR ALL
  TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

GRANT SELECT, INSERT ON TABLE batch_barcode_print_logs TO nexstock_app_user;

-- ============================================================================
-- 6. EXTEND GRN LINES, POS RETURN LINES & SMART PRICING SCOPE
-- ============================================================================

ALTER TABLE goods_receipt_lines
  ADD COLUMN IF NOT EXISTS batch_id uuid,
  ADD COLUMN IF NOT EXISTS manufacturing_date date,
  ADD COLUMN IF NOT EXISTS selling_price numeric(19, 4)
    CHECK (selling_price IS NULL OR selling_price >= 0);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'goods_receipt_lines_batch_fk'
  ) THEN
    ALTER TABLE goods_receipt_lines
      ADD CONSTRAINT goods_receipt_lines_batch_fk
      FOREIGN KEY (tenant_id, batch_id) REFERENCES inventory_batches (tenant_id, id);
  END IF;
END $$;

ALTER TABLE pos_return_lines
  ADD COLUMN IF NOT EXISTS batch_id uuid,
  ADD COLUMN IF NOT EXISTS serial_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pos_return_lines_batch_fk'
  ) THEN
    ALTER TABLE pos_return_lines
      ADD CONSTRAINT pos_return_lines_batch_fk
      FOREIGN KEY (tenant_id, batch_id) REFERENCES inventory_batches (tenant_id, id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pos_return_lines_serial_fk'
  ) THEN
    ALTER TABLE pos_return_lines
      ADD CONSTRAINT pos_return_lines_serial_fk
      FOREIGN KEY (tenant_id, serial_id) REFERENCES inventory_serials (tenant_id, id);
  END IF;
END $$;

ALTER TABLE price_suggestions
  ADD COLUMN IF NOT EXISTS batch_id uuid;

DO $$
DECLARE
  v_con RECORD;
BEGIN
  FOR v_con IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'price_suggestions'::regclass
      AND contype = 'c'
      AND (pg_get_constraintdef(oid) ~ 'scope' OR pg_get_constraintdef(oid) ~ 'branch_id')
  LOOP
    EXECUTE format('ALTER TABLE price_suggestions DROP CONSTRAINT IF EXISTS %I', v_con.conname);
  END LOOP;
END $$;

ALTER TABLE price_suggestions
  ADD CONSTRAINT price_suggestions_scope_check
    CHECK (scope IN ('GLOBAL', 'BRANCH', 'BATCH')),
  ADD CONSTRAINT price_suggestions_scope_target_check
    CHECK (
      (scope = 'GLOBAL' AND branch_id IS NULL AND batch_id IS NULL)
      OR (scope = 'BRANCH' AND branch_id IS NOT NULL)
      OR (scope = 'BATCH' AND batch_id IS NOT NULL)
    );

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'price_suggestions_batch_fk'
  ) THEN
    ALTER TABLE price_suggestions
      ADD CONSTRAINT price_suggestions_batch_fk
      FOREIGN KEY (tenant_id, batch_id) REFERENCES inventory_batches (tenant_id, id) ON DELETE CASCADE;
  END IF;
END $$;

ALTER TABLE product_price_history
  ADD COLUMN IF NOT EXISTS batch_id uuid;

DO $$
DECLARE
  v_con RECORD;
BEGIN
  FOR v_con IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'product_price_history'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ~ 'scope'
  LOOP
    EXECUTE format('ALTER TABLE product_price_history DROP CONSTRAINT IF EXISTS %I', v_con.conname);
  END LOOP;
END $$;

ALTER TABLE product_price_history
  ADD CONSTRAINT product_price_history_scope_check
  CHECK (scope IN ('GLOBAL', 'BRANCH', 'BATCH'));

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'product_price_history_batch_fk'
  ) THEN
    ALTER TABLE product_price_history
      ADD CONSTRAINT product_price_history_batch_fk
      FOREIGN KEY (tenant_id, batch_id) REFERENCES inventory_batches (tenant_id, id);
  END IF;
END $$;

-- ============================================================================
-- 7. STOCK LEDGER TRANSFER & UOM REBASE TYPES + INTER-WAREHOUSE TRANSFERS
-- ============================================================================

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
        movement_type IN ('STOCK_OUT', 'ADJUSTMENT_NEGATIVE', 'SUPPLIER_RETURN', 'TRANSFER_OUT')
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
        'MANUAL',
        'MANUAL_WEIGHT',
        'SCALE_WEIGHT',
        'SYSTEM_REVERSAL'
      )
    );

CREATE TABLE IF NOT EXISTS stock_transfers (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  transfer_number text NOT NULL CHECK (btrim(transfer_number) <> ''),
  source_branch_id uuid NOT NULL,
  source_warehouse_id uuid NOT NULL,
  destination_branch_id uuid NOT NULL,
  destination_warehouse_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT', 'IN_TRANSIT', 'RECEIVED', 'CANCELLED')),
  notes text,
  created_by_user_id uuid NOT NULL REFERENCES users (id),
  dispatched_by_user_id uuid REFERENCES users (id),
  received_by_user_id uuid REFERENCES users (id),
  dispatched_at timestamptz,
  received_at timestamptz,
  idempotency_key uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, transfer_number),
  CHECK (source_warehouse_id <> destination_warehouse_id),
  FOREIGN KEY (tenant_id, source_branch_id) REFERENCES branches (tenant_id, id),
  FOREIGN KEY (tenant_id, source_warehouse_id) REFERENCES warehouses (tenant_id, id),
  FOREIGN KEY (tenant_id, destination_branch_id) REFERENCES branches (tenant_id, id),
  FOREIGN KEY (tenant_id, destination_warehouse_id) REFERENCES warehouses (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS idx_stock_transfers_lookup
  ON stock_transfers (tenant_id, status, created_at DESC);

ALTER TABLE stock_transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_transfers FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON stock_transfers;
CREATE POLICY tenant_isolation_policy ON stock_transfers
  AS PERMISSIVE
  FOR ALL
  TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

GRANT SELECT, INSERT, UPDATE ON TABLE stock_transfers TO nexstock_app_user;

CREATE TABLE IF NOT EXISTS stock_transfer_lines (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  transfer_id uuid NOT NULL,
  line_number integer NOT NULL CHECK (line_number >= 1),
  product_id uuid NOT NULL,
  source_batch_id uuid,
  destination_batch_id uuid,
  serial_id uuid,
  uom_code text NOT NULL CHECK (btrim(uom_code) <> ''),
  requested_qty numeric(18, 6) NOT NULL CHECK (requested_qty > 0),
  dispatched_qty numeric(18, 6) CHECK (dispatched_qty IS NULL OR dispatched_qty > 0),
  received_qty numeric(18, 6) CHECK (received_qty IS NULL OR received_qty >= 0),
  transfer_unit_cost numeric(19, 4) NOT NULL DEFAULT 0 CHECK (transfer_unit_cost >= 0),
  transfer_selling_price numeric(19, 4) CHECK (transfer_selling_price IS NULL OR transfer_selling_price >= 0),
  expiry_date date,
  batch_number_snapshot text,
  dispatch_ledger_entry_id uuid,
  receive_ledger_entry_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, transfer_id, line_number),
  FOREIGN KEY (tenant_id, transfer_id) REFERENCES stock_transfers (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, product_id) REFERENCES products (tenant_id, id),
  FOREIGN KEY (tenant_id, source_batch_id) REFERENCES inventory_batches (tenant_id, id),
  FOREIGN KEY (tenant_id, destination_batch_id) REFERENCES inventory_batches (tenant_id, id),
  FOREIGN KEY (tenant_id, serial_id) REFERENCES inventory_serials (tenant_id, id),
  FOREIGN KEY (tenant_id, dispatch_ledger_entry_id) REFERENCES stock_ledger_entries (tenant_id, id),
  FOREIGN KEY (tenant_id, receive_ledger_entry_id) REFERENCES stock_ledger_entries (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS idx_stock_transfer_lines_transfer
  ON stock_transfer_lines (tenant_id, transfer_id);

ALTER TABLE stock_transfer_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_transfer_lines FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON stock_transfer_lines;
CREATE POLICY tenant_isolation_policy ON stock_transfer_lines
  AS PERMISSIVE
  FOR ALL
  TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

GRANT SELECT, INSERT, UPDATE ON TABLE stock_transfer_lines TO nexstock_app_user;

-- ============================================================================
-- 8. RECORD COMPLETION OF MIGRATION 0027
-- ============================================================================

INSERT INTO schema_migrations (version, name, filename)
VALUES (27, '0027_batch_pricing_hybrid_barcodes_and_transfers', '0027_batch_pricing_hybrid_barcodes_and_transfers.sql')
ON CONFLICT (version) DO NOTHING;

-- ============================================================================
-- NexStock — Phase 4 Database Migration
-- Version: 0005
-- Module: Advanced Inventory (Batches, Expiry, Serials, Costing Layers, Stocktakes)
-- Compatible with PostgreSQL 15+ / Supabase (Non-Superuser CREATEROLE Compatible)
-- ============================================================================

-- Preflight Check: Enforce sequential migration history
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = 4) THEN
    RAISE EXCEPTION 'MIGRATION_SEQUENCE_ERROR: Migration 0004 must be applied before 0005.';
  END IF;
END $$;

-- ============================================================================
-- 1. EXTEND PRODUCTS TABLE FOR TRACKING MODE & VALUATION METHOD
-- ============================================================================

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS tracking_mode text NOT NULL DEFAULT 'NONE'
    CHECK (tracking_mode IN ('NONE', 'BATCH', 'BATCH_EXPIRY', 'SERIAL')),
  ADD COLUMN IF NOT EXISTS valuation_method text NOT NULL DEFAULT 'MOVING_AVG'
    CHECK (valuation_method IN ('MOVING_AVG', 'FIFO'));

-- ============================================================================
-- 2. INVENTORY BATCHES / LOT TRACKING TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS inventory_batches (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  product_id uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  batch_number text NOT NULL CHECK (btrim(batch_number) <> ''),
  supplier_id uuid,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'QUARANTINED', 'DEPLETED')),
  received_date date NOT NULL DEFAULT CURRENT_DATE,
  manufacturing_date date,
  expiry_date date,
  initial_quantity numeric(18, 6) NOT NULL CHECK (initial_quantity >= 0),
  current_quantity numeric(18, 6) NOT NULL DEFAULT 0 CHECK (current_quantity >= 0),
  unit_cost numeric(19, 4) NOT NULL DEFAULT 0.0000 CHECK (unit_cost >= 0),
  currency_code text NOT NULL CHECK (char_length(currency_code) = 3),
  quarantine_reason text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, product_id, warehouse_id, batch_number),
  FOREIGN KEY (tenant_id, product_id) REFERENCES products (tenant_id, id),
  FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouses (tenant_id, id),
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES suppliers (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS idx_inventory_batches_lookup
  ON inventory_batches (tenant_id, warehouse_id, product_id, status);

CREATE INDEX IF NOT EXISTS idx_inventory_batches_expiry
  ON inventory_batches (tenant_id, expiry_date, status);

ALTER TABLE inventory_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_batches FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON inventory_batches;
CREATE POLICY tenant_isolation_policy ON inventory_batches
  AS PERMISSIVE
  FOR ALL
  TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

-- ============================================================================
-- 3. INVENTORY SERIALS TABLE & TRANSITION AUDIT LOG
-- ============================================================================

CREATE TABLE IF NOT EXISTS inventory_serials (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  product_id uuid NOT NULL,
  batch_id uuid,
  warehouse_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  serial_number text NOT NULL CHECK (btrim(serial_number) <> ''),
  status text NOT NULL DEFAULT 'IN_STOCK'
    CHECK (status IN ('IN_STOCK', 'RESERVED', 'SOLD', 'RETURNED', 'QUARANTINED', 'DAMAGED', 'WRITTEN_OFF')),
  unit_cost numeric(19, 4) NOT NULL DEFAULT 0.0000 CHECK (unit_cost >= 0),
  currency_code text NOT NULL CHECK (char_length(currency_code) = 3),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  sold_at timestamptz,
  last_movement_id uuid,
  last_sale_invoice_id uuid,
  notes text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, product_id, serial_number),
  FOREIGN KEY (tenant_id, product_id) REFERENCES products (tenant_id, id),
  FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouses (tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id),
  FOREIGN KEY (tenant_id, batch_id) REFERENCES inventory_batches (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS idx_inventory_serials_lookup
  ON inventory_serials (tenant_id, product_id, status);

CREATE INDEX IF NOT EXISTS idx_inventory_serials_warehouse
  ON inventory_serials (tenant_id, warehouse_id, status);

CREATE INDEX IF NOT EXISTS idx_inventory_serials_number
  ON inventory_serials (tenant_id, serial_number);

ALTER TABLE inventory_serials ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_serials FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON inventory_serials;
CREATE POLICY tenant_isolation_policy ON inventory_serials
  AS PERMISSIVE
  FOR ALL
  TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

-- Serial status transitions log
CREATE TABLE IF NOT EXISTS inventory_serial_transitions (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  serial_id uuid NOT NULL,
  from_status text NOT NULL,
  to_status text NOT NULL,
  reference_type text,
  reference_id text,
  actor_user_id uuid NOT NULL REFERENCES users (id),
  notes text,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, serial_id) REFERENCES inventory_serials (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS idx_serial_transitions_serial
  ON inventory_serial_transitions (tenant_id, serial_id, occurred_at);

ALTER TABLE inventory_serial_transitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_serial_transitions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON inventory_serial_transitions;
CREATE POLICY tenant_isolation_policy ON inventory_serial_transitions
  AS PERMISSIVE
  FOR ALL
  TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

-- ============================================================================
-- 4. INVENTORY FIFO COST LAYERS TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS inventory_cost_layers (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  warehouse_id uuid NOT NULL,
  product_id uuid NOT NULL,
  batch_id uuid,
  ledger_entry_id uuid NOT NULL,
  layer_date timestamptz NOT NULL DEFAULT clock_timestamp(),
  received_qty numeric(18, 6) NOT NULL CHECK (received_qty > 0),
  remaining_qty numeric(18, 6) NOT NULL CHECK (remaining_qty >= 0),
  unit_cost numeric(19, 4) NOT NULL CHECK (unit_cost >= 0),
  currency_code text NOT NULL CHECK (char_length(currency_code) = 3),
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'DEPLETED')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouses (tenant_id, id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES products (tenant_id, id),
  FOREIGN KEY (tenant_id, batch_id) REFERENCES inventory_batches (tenant_id, id),
  FOREIGN KEY (tenant_id, ledger_entry_id) REFERENCES stock_ledger_entries (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS idx_cost_layers_open_fifo
  ON inventory_cost_layers (tenant_id, warehouse_id, product_id, status, layer_date);

ALTER TABLE inventory_cost_layers ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_cost_layers FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON inventory_cost_layers;
CREATE POLICY tenant_isolation_policy ON inventory_cost_layers
  AS PERMISSIVE
  FOR ALL
  TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

-- ============================================================================
-- 5. LINK BATCH & SERIAL TO STOCK LEDGER AND SALES INVOICE LINES
-- ============================================================================

ALTER TABLE stock_ledger_entries
  ADD COLUMN IF NOT EXISTS batch_id uuid,
  ADD COLUMN IF NOT EXISTS serial_id uuid,
  ADD COLUMN IF NOT EXISTS total_cost_delta numeric(19, 4) NOT NULL DEFAULT 0.0000;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'stock_ledger_entries_batch_fk'
  ) THEN
    ALTER TABLE stock_ledger_entries
      ADD CONSTRAINT stock_ledger_entries_batch_fk
      FOREIGN KEY (tenant_id, batch_id) REFERENCES inventory_batches (tenant_id, id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'stock_ledger_entries_serial_fk'
  ) THEN
    ALTER TABLE stock_ledger_entries
      ADD CONSTRAINT stock_ledger_entries_serial_fk
      FOREIGN KEY (tenant_id, serial_id) REFERENCES inventory_serials (tenant_id, id);
  END IF;
END $$;

ALTER TABLE sales_invoice_lines
  ADD COLUMN IF NOT EXISTS batch_id uuid,
  ADD COLUMN IF NOT EXISTS serial_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'sales_invoice_lines_batch_fk'
  ) THEN
    ALTER TABLE sales_invoice_lines
      ADD CONSTRAINT sales_invoice_lines_batch_fk
      FOREIGN KEY (tenant_id, batch_id) REFERENCES inventory_batches (tenant_id, id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'sales_invoice_lines_serial_fk'
  ) THEN
    ALTER TABLE sales_invoice_lines
      ADD CONSTRAINT sales_invoice_lines_serial_fk
      FOREIGN KEY (tenant_id, serial_id) REFERENCES inventory_serials (tenant_id, id);
  END IF;
END $$;

-- ============================================================================
-- 6. STOCKTAKE SESSIONS & LINES (STOCK COUNTS & VARIANCE REVIEW)
-- ============================================================================

CREATE TABLE IF NOT EXISTS stocktake_sessions (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  count_number text NOT NULL CHECK (btrim(count_number) <> ''),
  branch_id uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  scope text NOT NULL CHECK (scope IN ('FULL_WAREHOUSE', 'CATEGORY', 'PARTIAL')),
  category_id uuid,
  status text NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT', 'IN_PROGRESS', 'SUBMITTED', 'APPROVED', 'REJECTED', 'POSTED')),
  started_at timestamptz,
  completed_at timestamptz,
  counted_by_user_id uuid REFERENCES users (id),
  reviewed_by_user_id uuid REFERENCES users (id),
  rejection_reason text,
  notes text,
  sync_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, count_number),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id),
  FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouses (tenant_id, id),
  FOREIGN KEY (tenant_id, category_id) REFERENCES categories (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS idx_stocktake_sessions_lookup
  ON stocktake_sessions (tenant_id, warehouse_id, status);

ALTER TABLE stocktake_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE stocktake_sessions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON stocktake_sessions;
CREATE POLICY tenant_isolation_policy ON stocktake_sessions
  AS PERMISSIVE
  FOR ALL
  TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

CREATE TABLE IF NOT EXISTS stocktake_lines (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  session_id uuid NOT NULL,
  product_id uuid NOT NULL,
  batch_id uuid,
  expected_qty numeric(18, 6) NOT NULL CHECK (expected_qty >= 0),
  counted_qty numeric(18, 6) CHECK (counted_qty >= 0),
  variance_qty numeric(18, 6),
  unit_cost numeric(19, 4) NOT NULL DEFAULT 0.0000 CHECK (unit_cost >= 0),
  variance_value numeric(19, 4) NOT NULL DEFAULT 0.0000,
  adjustment_movement_id uuid,
  notes text,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, session_id) REFERENCES stocktake_sessions (tenant_id, id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES products (tenant_id, id),
  FOREIGN KEY (tenant_id, batch_id) REFERENCES inventory_batches (tenant_id, id),
  FOREIGN KEY (tenant_id, adjustment_movement_id) REFERENCES stock_ledger_entries (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS idx_stocktake_lines_session
  ON stocktake_lines (tenant_id, session_id);

ALTER TABLE stocktake_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE stocktake_lines FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON stocktake_lines;
CREATE POLICY tenant_isolation_policy ON stocktake_lines
  AS PERMISSIVE
  FOR ALL
  TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

-- ============================================================================
-- 7. PHASE 4 ROLE PERMISSIONS BACKFILL
-- ============================================================================

-- Backfill role permissions for existing roles in all tenants
DO $$
DECLARE
  v_perm text;
  v_role RECORD;
BEGIN
  FOR v_role IN
    SELECT id, tenant_id, code FROM roles
  LOOP
    IF v_role.code IN ('TENANT_OWNER', 'ORG_ADMIN') THEN
      FOREACH v_perm IN ARRAY ARRAY[
        'inv:batch:read', 'inv:batch:manage',
        'inv:serial:read', 'inv:serial:manage',
        'inv:costing:read',
        'inv:count:read', 'inv:count:create', 'inv:count:submit', 'inv:count:approve', 'inv:count:post'
      ] LOOP
        INSERT INTO role_permissions (id, tenant_id, role_id, permission_key)
        VALUES (gen_random_uuid(), v_role.tenant_id, v_role.id, v_perm)
        ON CONFLICT (tenant_id, role_id, permission_key) DO NOTHING;
      END LOOP;
    ELSIF v_role.code = 'BRANCH_MANAGER' THEN
      FOREACH v_perm IN ARRAY ARRAY[
        'inv:batch:read', 'inv:batch:manage',
        'inv:serial:read', 'inv:serial:manage',
        'inv:costing:read',
        'inv:count:read', 'inv:count:create', 'inv:count:submit', 'inv:count:approve', 'inv:count:post'
      ] LOOP
        INSERT INTO role_permissions (id, tenant_id, role_id, permission_key)
        VALUES (gen_random_uuid(), v_role.tenant_id, v_role.id, v_perm)
        ON CONFLICT (tenant_id, role_id, permission_key) DO NOTHING;
      END LOOP;
    ELSIF v_role.code = 'WAREHOUSE_CLERK' THEN
      FOREACH v_perm IN ARRAY ARRAY[
        'inv:batch:read', 'inv:batch:manage',
        'inv:serial:read', 'inv:serial:manage',
        'inv:count:read', 'inv:count:create', 'inv:count:submit'
      ] LOOP
        INSERT INTO role_permissions (id, tenant_id, role_id, permission_key)
        VALUES (gen_random_uuid(), v_role.tenant_id, v_role.id, v_perm)
        ON CONFLICT (tenant_id, role_id, permission_key) DO NOTHING;
      END LOOP;
    ELSIF v_role.code = 'PURCHASER' THEN
      FOREACH v_perm IN ARRAY ARRAY[
        'inv:batch:read', 'inv:batch:manage',
        'inv:serial:read',
        'inv:costing:read'
      ] LOOP
        INSERT INTO role_permissions (id, tenant_id, role_id, permission_key)
        VALUES (gen_random_uuid(), v_role.tenant_id, v_role.id, v_perm)
        ON CONFLICT (tenant_id, role_id, permission_key) DO NOTHING;
      END LOOP;
    ELSIF v_role.code = 'ACCOUNTANT' THEN
      FOREACH v_perm IN ARRAY ARRAY[
        'inv:batch:read',
        'inv:serial:read',
        'inv:costing:read',
        'inv:count:read', 'inv:count:approve'
      ] LOOP
        INSERT INTO role_permissions (id, tenant_id, role_id, permission_key)
        VALUES (gen_random_uuid(), v_role.tenant_id, v_role.id, v_perm)
        ON CONFLICT (tenant_id, role_id, permission_key) DO NOTHING;
      END LOOP;
    ELSIF v_role.code = 'CASHIER' THEN
      FOREACH v_perm IN ARRAY ARRAY[
        'inv:batch:read',
        'inv:serial:read'
      ] LOOP
        INSERT INTO role_permissions (id, tenant_id, role_id, permission_key)
        VALUES (gen_random_uuid(), v_role.tenant_id, v_role.id, v_perm)
        ON CONFLICT (tenant_id, role_id, permission_key) DO NOTHING;
      END LOOP;
    END IF;
  END LOOP;
END $$;

-- ============================================================================
-- 8. GRANT PRIVILEGES TO RUNTIME APP ROLE
-- ============================================================================

GRANT SELECT, INSERT, UPDATE ON TABLE inventory_batches TO nexstock_app_user;
GRANT SELECT, INSERT, UPDATE ON TABLE inventory_serials TO nexstock_app_user;
GRANT SELECT, INSERT ON TABLE inventory_serial_transitions TO nexstock_app_user;
GRANT SELECT, INSERT, UPDATE ON TABLE inventory_cost_layers TO nexstock_app_user;
GRANT SELECT, INSERT, UPDATE ON TABLE stocktake_sessions TO nexstock_app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE stocktake_lines TO nexstock_app_user;

-- ============================================================================
-- 9. RECORD SCHEMA MIGRATION VERSION
-- ============================================================================

INSERT INTO schema_migrations (version, name, filename)
VALUES (5, '0005_phase4_advanced_inventory', '0005_phase4_advanced_inventory.sql')
ON CONFLICT (version) DO NOTHING;

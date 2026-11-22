-- ============================================================================
-- NexStock Migration - 0031_qa_master_enhancements.sql
-- TARGET ENGINE: PostgreSQL 15+ / Supabase SQL Editor
-- PREREQUISITE: Must be executed AFTER 0030_phase10_5_9_enforcement_admin_analytics_security.sql
-- Covers:
--   1. Platform Super Admin 2FA policy enforcement & compromised pre-fix secret invalidation
--   2. Product unit conversion default purchasing/selling flags
--   3. Serial-level inventory stock intake groups, unique serial barcodes & print logs
--   4. Sales invoice line serial group & barcode snapshot columns
--   5. Smart Stock Receiving & Pricing market price & MAC comparison columns
--   6. Starter Batch & Expiry core entitlements + Customer-facing "Pro" plan naming
-- ============================================================================

DO $$
DECLARE
  v_0030_applied integer;
BEGIN
  SELECT COUNT(*) INTO v_0030_applied FROM schema_migrations WHERE version = 30;
  IF v_0030_applied = 0 THEN
    RAISE EXCEPTION 'MIGRATION_ORDER_ERROR: Migration 0031 requires Migration 0030 to be applied first.';
  END IF;
END $$;

-- ============================================================================
-- 1. PLATFORM SUPER ADMIN 2FA ENFORCEMENT & COMPROMISED SECRET RESET
-- ============================================================================

UPDATE platform_admin_accounts
SET
  totp_enabled = false,
  totp_secret_base32 = NULL,
  mfa_verified_until = NULL,
  mfa_enforced = true,
  updated_at = clock_timestamp()
WHERE platform_role = 'SUPER_ADMIN'
  AND mfa_enforced = false;

-- ============================================================================
-- 2. PRODUCT UNIT CONVERSION DEFAULTS & TENANT ONBOARDING IDEMPOTENCY
-- ============================================================================

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS onboarding_idempotency_key text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_tenants_onboarding_idempotency_key
  ON tenants (onboarding_idempotency_key)
  WHERE onboarding_idempotency_key IS NOT NULL;

ALTER TABLE product_unit_conversions
  ADD COLUMN IF NOT EXISTS is_default_purchasing boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_default_selling boolean NOT NULL DEFAULT false;

-- ============================================================================
-- 3. SERIAL STOCK INTAKE GROUPS & INDIVIDUAL SERIAL BARCODES
-- ============================================================================

CREATE TABLE IF NOT EXISTS serial_stock_groups (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  branch_id uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  product_id uuid NOT NULL,
  supplier_id uuid,
  goods_receipt_id uuid,
  group_code text NOT NULL CHECK (btrim(group_code) <> ''),
  purchase_cost numeric(19, 4) NOT NULL DEFAULT 0.0000 CHECK (purchase_cost >= 0),
  selling_price numeric(19, 4) NOT NULL DEFAULT 0.0000 CHECK (selling_price >= 0),
  currency_code text NOT NULL CHECK (char_length(currency_code) = 3),
  initial_quantity integer NOT NULL CHECK (initial_quantity > 0),
  remaining_quantity integer NOT NULL CHECK (remaining_quantity >= 0),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  notes text,
  created_by_user_id uuid REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, group_code),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id),
  FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouses (tenant_id, id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES products (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS idx_serial_stock_groups_lookup
  ON serial_stock_groups (tenant_id, product_id, warehouse_id, received_at DESC);

ALTER TABLE serial_stock_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE serial_stock_groups FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON serial_stock_groups;
CREATE POLICY tenant_isolation_policy ON serial_stock_groups
  AS PERMISSIVE
  FOR ALL
  TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id() OR app_is_platform_admin())
  WITH CHECK (tenant_id = app_current_tenant_id() OR app_is_platform_admin());

GRANT SELECT, INSERT, UPDATE ON TABLE serial_stock_groups TO nexstock_app_user;

ALTER TABLE inventory_serials
  ADD COLUMN IF NOT EXISTS serial_group_id uuid,
  ADD COLUMN IF NOT EXISTS internal_barcode text,
  ADD COLUMN IF NOT EXISTS selling_price numeric(19, 4)
    CHECK (selling_price IS NULL OR selling_price >= 0),
  ADD COLUMN IF NOT EXISTS label_print_count integer NOT NULL DEFAULT 0
    CHECK (label_print_count >= 0),
  ADD COLUMN IF NOT EXISTS last_label_printed_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'inventory_serials_group_fk'
  ) THEN
    ALTER TABLE inventory_serials
      ADD CONSTRAINT inventory_serials_group_fk
      FOREIGN KEY (tenant_id, serial_group_id) REFERENCES serial_stock_groups (tenant_id, id);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_serials_internal_barcode_unique
  ON inventory_serials (tenant_id, internal_barcode)
  WHERE internal_barcode IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_inventory_serials_group_lookup
  ON inventory_serials (tenant_id, serial_group_id)
  WHERE serial_group_id IS NOT NULL;

-- Immutable Serial Barcode Print & Reprint Audit Log
CREATE TABLE IF NOT EXISTS serial_barcode_print_logs (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  branch_id uuid,
  product_id uuid NOT NULL,
  serial_group_id uuid,
  serial_id uuid NOT NULL,
  internal_barcode text NOT NULL CHECK (btrim(internal_barcode) <> ''),
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
  is_reprint boolean NOT NULL DEFAULT false,
  printed_by_user_id uuid NOT NULL REFERENCES users (id),
  printed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES products (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, serial_id) REFERENCES inventory_serials (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, serial_group_id) REFERENCES serial_stock_groups (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS idx_serial_barcode_print_logs_lookup
  ON serial_barcode_print_logs (tenant_id, serial_id, printed_at DESC);

DROP TRIGGER IF EXISTS serial_barcode_print_logs_immutable_trg ON serial_barcode_print_logs;
CREATE TRIGGER serial_barcode_print_logs_immutable_trg
  BEFORE UPDATE OR DELETE ON serial_barcode_print_logs
  FOR EACH ROW
  EXECUTE FUNCTION prevent_immutable_row_mutation();

ALTER TABLE serial_barcode_print_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE serial_barcode_print_logs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON serial_barcode_print_logs;
CREATE POLICY tenant_isolation_policy ON serial_barcode_print_logs
  AS PERMISSIVE
  FOR ALL
  TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id() OR app_is_platform_admin())
  WITH CHECK (tenant_id = app_current_tenant_id() OR app_is_platform_admin());

GRANT SELECT, INSERT ON TABLE serial_barcode_print_logs TO nexstock_app_user;

-- ============================================================================
-- 4. SALES INVOICE LINES SERIAL GROUP SNAPSHOT
-- ============================================================================

ALTER TABLE sales_invoice_lines
  ADD COLUMN IF NOT EXISTS serial_group_id uuid,
  ADD COLUMN IF NOT EXISTS serial_number text,
  ADD COLUMN IF NOT EXISTS serial_internal_barcode text;

-- ============================================================================
-- 5. SMART PRICING MARKET PRICE & MAC SNAPSHOTS
-- ============================================================================

ALTER TABLE price_suggestions
  ADD COLUMN IF NOT EXISTS market_price numeric(19, 4)
    CHECK (market_price IS NULL OR market_price >= 0),
  ADD COLUMN IF NOT EXISTS market_price_source text,
  ADD COLUMN IF NOT EXISTS incoming_purchase_cost numeric(19, 4)
    CHECK (incoming_purchase_cost IS NULL OR incoming_purchase_cost >= 0),
  ADD COLUMN IF NOT EXISTS moving_avg_cost numeric(19, 4)
    CHECK (moving_avg_cost IS NULL OR moving_avg_cost >= 0);

-- ============================================================================
-- 6. BATCH & EXPIRY ENTITLEMENTS ON STARTER + "PRO" PLAN NAMING
-- ============================================================================

UPDATE subscription_plans
SET
  features_json = COALESCE(features_json, '{}'::jsonb) || '{"batchTracking": true, "expiryTracking": true, "fefoFifoAllocation": true}'::jsonb,
  updated_at = clock_timestamp()
WHERE code = 'STARTER';

UPDATE subscription_plans
SET
  name = 'Pro',
  description = 'Multi-branch operations, Desktop & Mobile Offline POS, stock transfers, API access, and serial tracking.',
  updated_at = clock_timestamp()
WHERE code = 'PROFESSIONAL';

UPDATE subscription_plans
SET
  description = 'Legacy internal alias aligned with Pro tier.',
  updated_at = clock_timestamp()
WHERE code = 'GROWTH';

-- ============================================================================
-- 7. REGISTER MIGRATION 31
-- ============================================================================

INSERT INTO schema_migrations (version, name, filename)
VALUES (
  31,
  '0031_qa_master_enhancements',
  '0031_qa_master_enhancements.sql'
)
ON CONFLICT (version) DO NOTHING;

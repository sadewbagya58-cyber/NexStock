-- ============================================================================
-- NexStock — Migration 0011: Phase 6 Universal Barcode Management
-- Module: CAT / POS / SETTINGS
-- Symbologies: EAN13, EAN8, UPCA, UPCE, CODE128, CODE39, ITF, QR, CUSTOM
-- ============================================================================

-- 1. Extend product_barcodes table with is_active, updated_at, and expanded symbologies
ALTER TABLE product_barcodes
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT clock_timestamp();

ALTER TABLE product_barcodes
  DROP CONSTRAINT IF EXISTS product_barcodes_barcode_type_check;

ALTER TABLE product_barcodes
  ADD CONSTRAINT product_barcodes_barcode_type_check
  CHECK (barcode_type IN ('EAN13', 'EAN8', 'UPCA', 'UPCE', 'CODE128', 'CODE39', 'ITF', 'QR', 'CUSTOM'));

CREATE INDEX IF NOT EXISTS idx_product_barcodes_active_lookup
  ON product_barcodes (tenant_id, barcode)
  WHERE is_active = true;

-- 2. Tenant Barcode & POS Scanner Settings Table
CREATE TABLE IF NOT EXISTS tenant_barcode_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenants (id) ON DELETE CASCADE,
  barcode_management_enabled boolean NOT NULL DEFAULT true,
  internal_generation_enabled boolean NOT NULL DEFAULT true,
  internal_prefix text NOT NULL DEFAULT 'NB' CHECK (btrim(internal_prefix) <> ''),
  labels_enabled boolean NOT NULL DEFAULT true,
  hardware_scanner_enabled boolean NOT NULL DEFAULT true,
  camera_scanner_enabled boolean NOT NULL DEFAULT true,
  auto_add_to_cart boolean NOT NULL DEFAULT true,
  increment_on_duplicate boolean NOT NULL DEFAULT true,
  unknown_barcode_action text NOT NULL DEFAULT 'PROMPT' CHECK (unknown_barcode_action IN ('PROMPT', 'IGNORE', 'MANUAL_SEARCH')),
  default_scan_mode text NOT NULL DEFAULT 'HARDWARE' CHECK (default_scan_mode IN ('HARDWARE', 'CAMERA', 'MANUAL')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

ALTER TABLE tenant_barcode_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_barcode_settings FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON tenant_barcode_settings;
CREATE POLICY tenant_isolation_policy ON tenant_barcode_settings
  AS PERMISSIVE FOR ALL TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

GRANT SELECT, INSERT, UPDATE ON TABLE tenant_barcode_settings TO nexstock_app_user;

-- Record completion of Migration 0011
INSERT INTO schema_migrations (version, name, filename)
VALUES (11, '0011_phase6_barcode_management', '0011_phase6_barcode_management.sql')
ON CONFLICT (version) DO UPDATE
  SET applied_at = clock_timestamp(),
      applied_by = current_user;

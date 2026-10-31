-- ============================================================================
-- NexStock — Migration 0012: Phase 6 Product Images & Media Storage
-- Module: CAT / POS / MEDIA
-- Formats: image/jpeg, image/png, image/webp (max 5MB)
-- ============================================================================

-- 1. Ensure product table has image_url and image_alt columns
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS image_url text,
  ADD COLUMN IF NOT EXISTS image_alt text;

-- 2. Tenant-Isolated Product Media Assets Table
CREATE TABLE IF NOT EXISTS product_media_assets (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  file_name text NOT NULL,
  mime_type text NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp')),
  file_size integer NOT NULL CHECK (file_size > 0),
  storage_path text NOT NULL,
  data_base64 text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS idx_product_media_assets_tenant
  ON product_media_assets (tenant_id, id);

ALTER TABLE product_media_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_media_assets FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON product_media_assets;
CREATE POLICY tenant_isolation_policy ON product_media_assets
  AS PERMISSIVE FOR ALL TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE product_media_assets TO nexstock_app_user;

-- Record completion of Migration 0012
INSERT INTO schema_migrations (version, name, filename)
VALUES (12, '0012_phase6_product_images', '0012_phase6_product_images.sql')
ON CONFLICT (version) DO UPDATE
  SET applied_at = clock_timestamp(),
      applied_by = current_user;

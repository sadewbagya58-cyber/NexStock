-- ============================================================================
-- NexStock — PostgreSQL Migration 0033
-- Module: Branch-Level Data Isolation (DI-001) & Customer Structured Address (6.1)
-- Notes:
--   - 100% idempotent (safe to re-run cleanly).
--   - Respects composite primary keys (tenant_id, id) on branches, categories, products.
--   - Backfills existing historical products/categories to their observed active
--     branches (or earliest branch if never transacted), so newly created branches
--     always begin with a clean, empty catalog.
-- ============================================================================

-- Prerequisite check
DO $$
BEGIN
  IF to_regclass('public.stock_intake_lots') IS NULL THEN
    RAISE EXCEPTION 'MIGRATION_ORDER_ERROR: 0032_smart_stock_intake_and_barcodes must be applied before 0033';
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 1. Origin Branch Ownership on Categories & Products
-- ----------------------------------------------------------------------------

ALTER TABLE categories
  ADD COLUMN IF NOT EXISTS origin_branch_id uuid;

DO $$
BEGIN
  ALTER TABLE categories
    ADD CONSTRAINT categories_origin_branch_fk
    FOREIGN KEY (tenant_id, origin_branch_id)
    REFERENCES branches (tenant_id, id)
    ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS origin_branch_id uuid;

DO $$
BEGIN
  ALTER TABLE products
    ADD CONSTRAINT products_origin_branch_fk
    FOREIGN KEY (tenant_id, origin_branch_id)
    REFERENCES branches (tenant_id, id)
    ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Drop tenant-global SKU / Barcode / Category name unique constraints so
-- independent branches can manage independent catalogs safely.
DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'public.products'::regclass
      AND contype = 'u'
  LOOP
    EXECUTE format('ALTER TABLE public.products DROP CONSTRAINT IF EXISTS %I', c.conname);
  END LOOP;

  FOR c IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'public.product_barcodes'::regclass
      AND contype = 'u'
  LOOP
    EXECUTE format('ALTER TABLE public.product_barcodes DROP CONSTRAINT IF EXISTS %I', c.conname);
  END LOOP;
END $$;

DROP INDEX IF EXISTS idx_categories_tenant_parent_name_unique;

CREATE UNIQUE INDEX IF NOT EXISTS idx_categories_tenant_branch_parent_name_unique
  ON categories (
    tenant_id,
    COALESCE(origin_branch_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid),
    lower(btrim(name))
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_products_tenant_branch_sku_unique
  ON products (
    tenant_id,
    COALESCE(origin_branch_id, '00000000-0000-0000-0000-000000000000'::uuid),
    upper(btrim(sku))
  );

CREATE INDEX IF NOT EXISTS idx_products_tenant_origin_branch
  ON products (tenant_id, origin_branch_id, status);

CREATE UNIQUE INDEX IF NOT EXISTS idx_product_barcodes_tenant_branch_barcode_unique
  ON product_barcodes (
    tenant_id,
    COALESCE(branch_id, '00000000-0000-0000-0000-000000000000'::uuid),
    barcode
  );

-- ----------------------------------------------------------------------------
-- 2. Branch Visibility / Assignment Tables (Product & Category Isolation)
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS product_branch_assignments (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  product_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  assignment_source text NOT NULL DEFAULT 'CREATED'
    CHECK (assignment_source IN ('CREATED', 'STOCK_MOVEMENT', 'GRN', 'TRANSFER_IN', 'MANUAL_ASSIGN', 'LEGACY_BACKFILL')),
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, product_id, branch_id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES products (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_product_branch_assignments_branch
  ON product_branch_assignments (tenant_id, branch_id, status, product_id);

CREATE INDEX IF NOT EXISTS idx_product_branch_assignments_product
  ON product_branch_assignments (tenant_id, product_id, status);

ALTER TABLE product_branch_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_branch_assignments FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON product_branch_assignments;
CREATE POLICY tenant_isolation_policy ON product_branch_assignments
  AS PERMISSIVE
  FOR ALL
  TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE product_branch_assignments TO nexstock_app_user;

CREATE TABLE IF NOT EXISTS category_branch_assignments (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  category_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, category_id, branch_id),
  FOREIGN KEY (tenant_id, category_id) REFERENCES categories (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_category_branch_assignments_branch
  ON category_branch_assignments (tenant_id, branch_id, status, category_id);

ALTER TABLE category_branch_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE category_branch_assignments FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON category_branch_assignments;
CREATE POLICY tenant_isolation_policy ON category_branch_assignments
  AS PERMISSIVE
  FOR ALL
  TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE category_branch_assignments TO nexstock_app_user;

-- ----------------------------------------------------------------------------
-- 3. Historical Backfill for Existing Product & Category Branch Assignments
-- ----------------------------------------------------------------------------

-- 3A: Enroll products in branches where they have real operational records
INSERT INTO product_branch_assignments (
  tenant_id,
  product_id,
  branch_id,
  assignment_source,
  status
)
SELECT DISTINCT src.tenant_id, src.product_id, src.branch_id, 'LEGACY_BACKFILL', 'ACTIVE'
FROM (
  SELECT tenant_id, product_id, branch_id FROM inventory_balances
  UNION
  SELECT tenant_id, product_id, branch_id FROM stock_ledger_entries
  UNION
  SELECT gr.tenant_id, grl.product_id, gr.branch_id
  FROM goods_receipt_lines grl
  JOIN goods_receipts gr ON gr.tenant_id = grl.tenant_id AND gr.id = grl.goods_receipt_id
  UNION
  SELECT si.tenant_id, sil.product_id, si.branch_id
  FROM sales_invoice_lines sil
  JOIN sales_invoices si ON si.tenant_id = sil.tenant_id AND si.id = sil.invoice_id
  UNION
  SELECT tenant_id, product_id, branch_id FROM product_branch_prices
) src
JOIN products p ON p.tenant_id = src.tenant_id AND p.id = src.product_id
JOIN branches b ON b.tenant_id = src.tenant_id AND b.id = src.branch_id
ON CONFLICT (tenant_id, product_id, branch_id) DO NOTHING;

-- 3B: Any pre-existing product without any transaction history is assigned ONLY
-- to its tenant's earliest active branch (never leaked to newer empty branches)
INSERT INTO product_branch_assignments (
  tenant_id,
  product_id,
  branch_id,
  assignment_source,
  status
)
SELECT p.tenant_id, p.id, first_b.id, 'LEGACY_BACKFILL', p.status
FROM products p
JOIN LATERAL (
  SELECT b.id
  FROM branches b
  WHERE b.tenant_id = p.tenant_id
  ORDER BY b.created_at ASC, b.id ASC
  LIMIT 1
) first_b ON true
WHERE NOT EXISTS (
  SELECT 1
  FROM product_branch_assignments pba
  WHERE pba.tenant_id = p.tenant_id
    AND pba.product_id = p.id
)
ON CONFLICT (tenant_id, product_id, branch_id) DO NOTHING;

UPDATE products p
SET origin_branch_id = (
  SELECT pba.branch_id
  FROM product_branch_assignments pba
  WHERE pba.tenant_id = p.tenant_id
    AND pba.product_id = p.id
  ORDER BY pba.created_at ASC, pba.id ASC
  LIMIT 1
)
WHERE p.origin_branch_id IS NULL
  AND EXISTS (
    SELECT 1
    FROM product_branch_assignments pba
    WHERE pba.tenant_id = p.tenant_id
      AND pba.product_id = p.id
  );

-- 3C: Backfill category branch assignments from assigned products or earliest branch
INSERT INTO category_branch_assignments (
  tenant_id,
  category_id,
  branch_id,
  status
)
SELECT DISTINCT p.tenant_id, p.category_id, pba.branch_id, 'ACTIVE'
FROM product_branch_assignments pba
JOIN products p ON p.tenant_id = pba.tenant_id AND p.id = pba.product_id
WHERE p.category_id IS NOT NULL
ON CONFLICT (tenant_id, category_id, branch_id) DO NOTHING;

INSERT INTO category_branch_assignments (
  tenant_id,
  category_id,
  branch_id,
  status
)
SELECT c.tenant_id, c.id, first_b.id, c.status
FROM categories c
JOIN LATERAL (
  SELECT b.id
  FROM branches b
  WHERE b.tenant_id = c.tenant_id
  ORDER BY b.created_at ASC, b.id ASC
  LIMIT 1
) first_b ON true
WHERE NOT EXISTS (
  SELECT 1
  FROM category_branch_assignments cba
  WHERE cba.tenant_id = c.tenant_id
    AND cba.category_id = c.id
)
ON CONFLICT (tenant_id, category_id, branch_id) DO NOTHING;

UPDATE categories c
SET origin_branch_id = (
  SELECT cba.branch_id
  FROM category_branch_assignments cba
  WHERE cba.tenant_id = c.tenant_id
    AND cba.category_id = c.id
  ORDER BY cba.created_at ASC, cba.id ASC
  LIMIT 1
)
WHERE c.origin_branch_id IS NULL
  AND EXISTS (
    SELECT 1
    FROM category_branch_assignments cba
    WHERE cba.tenant_id = c.tenant_id
      AND cba.category_id = c.id
  );

-- ----------------------------------------------------------------------------
-- 4. Structured Customer Address Columns (Section 6.1: City & Postal Code)
-- ----------------------------------------------------------------------------

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS address_line1 text;

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS city text;

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS postal_code text;

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS company_name text;

-- Non-destructive backfill from legacy concatenated comma-separated address
UPDATE customers
SET
  address_line1 = CASE
    WHEN address_line1 IS NOT NULL THEN address_line1
    WHEN address IS NOT NULL AND array_length(string_to_array(address, ','), 1) >= 3 THEN NULLIF(btrim((string_to_array(address, ','))[1]), '')
    WHEN address IS NOT NULL AND array_length(string_to_array(address, ','), 1) = 2 THEN
      CASE
        WHEN btrim((string_to_array(address, ','))[2]) ~ '^\d{3,10}$' THEN NULL
        ELSE NULLIF(btrim((string_to_array(address, ','))[1]), '')
      END
    ELSE NULLIF(btrim(address), '')
  END,
  city = CASE
    WHEN city IS NOT NULL THEN city
    WHEN address IS NOT NULL AND array_length(string_to_array(address, ','), 1) >= 3 THEN NULLIF(btrim((string_to_array(address, ','))[array_length(string_to_array(address, ','), 1) - 1]), '')
    WHEN address IS NOT NULL AND array_length(string_to_array(address, ','), 1) = 2 THEN
      CASE
        WHEN btrim((string_to_array(address, ','))[2]) ~ '^\d{3,10}$' THEN NULLIF(btrim((string_to_array(address, ','))[1]), '')
        ELSE NULLIF(btrim((string_to_array(address, ','))[2]), '')
      END
    ELSE NULL
  END,
  postal_code = CASE
    WHEN postal_code IS NOT NULL THEN postal_code
    WHEN address IS NOT NULL AND array_length(string_to_array(address, ','), 1) >= 2 AND btrim((string_to_array(address, ','))[array_length(string_to_array(address, ','), 1)]) ~ '^\d{3,10}$'
      THEN NULLIF(btrim((string_to_array(address, ','))[array_length(string_to_array(address, ','), 1)]), '')
    ELSE NULL
  END
WHERE address IS NOT NULL
  AND btrim(address) <> ''
  AND (city IS NULL AND postal_code IS NULL AND address_line1 IS NULL);

-- ============================================================================
-- 4. REGISTER MIGRATION 33
-- ============================================================================

INSERT INTO schema_migrations (version, name, filename)
VALUES (
  33,
  '0033_branch_catalog_isolation_and_customer_address',
  '0033_branch_catalog_isolation_and_customer_address.sql'
)
ON CONFLICT (version) DO NOTHING;

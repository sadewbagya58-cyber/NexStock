-- ============================================================================
-- NexStock Canonical Local SQLite Schema — Migration 0002 (Phase 2 Core Inventory)
-- TARGET ENGINE: SQLite 3.37+ ONLY (Tauri Desktop & Flutter Mobile Offline DB)
-- ============================================================================
-- WARNING: DO NOT EXECUTE THIS FILE IN POSTGRESQL OR SUPABASE SQL EDITOR!
-- This script contains SQLite-specific `STRICT` tables intended exclusively
-- for local edge device storage on Tauri Desktop and Flutter Mobile.
--
-- For PostgreSQL / Supabase migrations, use ONLY the files under:
--   1. apps/api/migrations/0001_shared_foundation_rls.sql
--   2. apps/api/migrations/0002_milestone1_iam_org_sub_i18n.sql
--   3. apps/api/migrations/0003_phase2_core_inventory.sql
-- ============================================================================

-- 1. Synced Categories Read-Model (Server-Authoritative)
CREATE TABLE IF NOT EXISTS local_categories (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  parent_id TEXT,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  sync_version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_local_categories_parent
  ON local_categories (tenant_id, parent_id);

-- 2. Synced Products Read-Model (Server-Authoritative; fixed-point scaled integers)
CREATE TABLE IF NOT EXISTS local_products (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  sku TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  product_type TEXT NOT NULL CHECK (product_type IN ('STANDARD', 'SERVICE', 'BUNDLE')),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  category_id TEXT,
  base_uom TEXT NOT NULL,
  purchase_cost_scaled INTEGER NOT NULL DEFAULT 0, -- Scale 10^-4
  selling_price_scaled INTEGER NOT NULL DEFAULT 0, -- Scale 10^-4
  tax_group_id TEXT,
  track_inventory INTEGER NOT NULL DEFAULT 1 CHECK (track_inventory IN (0, 1)),
  reorder_point_micro INTEGER NOT NULL DEFAULT 0,  -- Scale 10^-6
  reorder_qty_micro INTEGER NOT NULL DEFAULT 0,    -- Scale 10^-6
  primary_barcode TEXT,
  sync_version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, sku)
) STRICT;

-- 3. Synced Product Barcodes Read-Model (Instant Offline Barcode Scan Lookup)
CREATE TABLE IF NOT EXISTS local_product_barcodes (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  product_id TEXT NOT NULL REFERENCES local_products (id) ON DELETE CASCADE,
  barcode TEXT NOT NULL,
  barcode_type TEXT NOT NULL CHECK (barcode_type IN ('EAN13', 'UPCA', 'CODE128', 'QR', 'CUSTOM')),
  uom_code TEXT NOT NULL,
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  UNIQUE (tenant_id, barcode)
) STRICT;

-- 4. Synced Product UoM Conversions Read-Model (10^-6 micro-unit factor)
CREATE TABLE IF NOT EXISTS local_product_unit_conversions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  product_id TEXT NOT NULL REFERENCES local_products (id) ON DELETE CASCADE,
  uom_code TEXT NOT NULL,
  uom_name TEXT NOT NULL,
  conversion_factor_micro INTEGER NOT NULL CHECK (conversion_factor_micro > 0),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  UNIQUE (tenant_id, product_id, uom_code)
) STRICT;

-- 5. Synced Suppliers Read-Model (For Offline GRN / Receiving Reference)
CREATE TABLE IF NOT EXISTS local_suppliers (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  code TEXT NOT NULL,
  business_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  sync_version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, code)
) STRICT;

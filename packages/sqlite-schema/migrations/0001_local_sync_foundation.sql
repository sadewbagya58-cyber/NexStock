-- ============================================================================
-- NexStock Canonical Local SQLite Schema — Migration 0001
-- TARGET ENGINE: SQLite 3.37+ ONLY (Tauri Desktop & Flutter Mobile Offline DB)
-- ============================================================================
-- WARNING: DO NOT EXECUTE THIS FILE IN POSTGRESQL OR SUPABASE SQL EDITOR!
-- This script contains SQLite-specific statements (`PRAGMA`, `AUTOINCREMENT`,
-- and `STRICT` tables) intended exclusively for local edge device storage.
--
-- For PostgreSQL / Supabase migrations, use ONLY the files under:
--   1. apps/api/migrations/0001_shared_foundation_rls.sql
--   2. apps/api/migrations/0002_milestone1_iam_org_sub_i18n.sql
-- ============================================================================

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- 1. Single-Tenant Device Binding Metadata (NEX-DOC-05 Section 5)
CREATE TABLE IF NOT EXISTS local_device_metadata (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  tenant_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  warehouse_id TEXT NOT NULL,
  register_id TEXT,
  device_id TEXT NOT NULL,
  enrolled_at TEXT NOT NULL,
  offline_auth_expires_at TEXT NOT NULL
) STRICT;

-- 2. Ordered Idempotent Offline Command Outbox (NEX-DOC-08 Section 3.1)
CREATE TABLE IF NOT EXISTS local_sync_outbox (
  local_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  command_id TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  command_type TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'IN_FLIGHT', 'SYNCED', 'QUARANTINED')),
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  server_ack_at TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS idx_local_sync_outbox_status_seq
  ON local_sync_outbox (status, local_seq ASC);

-- 3. Downstream Delta Pull Watermarks (NEX-DOC-08 Section 3.1)
CREATE TABLE IF NOT EXISTS local_sync_watermarks (
  stream_name TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  last_pulled_sync_version INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
) STRICT;

-- 4. Optimistic Local Inventory Balance Projection (Micro-Units = 10^-6 Base UoM)
CREATE TABLE IF NOT EXISTS local_inventory_balances (
  tenant_id TEXT NOT NULL,
  warehouse_id TEXT NOT NULL,
  variant_id TEXT NOT NULL,
  server_qty_on_hand_micro INTEGER NOT NULL DEFAULT 0,
  server_qty_reserved_micro INTEGER NOT NULL DEFAULT 0,
  local_pending_qty_delta_micro INTEGER NOT NULL DEFAULT 0,
  server_sync_version INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, warehouse_id, variant_id)
) STRICT;

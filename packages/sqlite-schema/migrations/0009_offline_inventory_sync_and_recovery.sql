-- ============================================================================
-- NexStock — Canonical Local SQLite Schema Migration (Desktop & Mobile)
-- Version: 0009
-- Module: Phase 9.5–9.9 Offline Inventory, Sync Conflicts, Security & Recovery
-- ============================================================================

CREATE TABLE IF NOT EXISTS local_inventory_movements_queue (
  id TEXT NOT NULL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  warehouse_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  product_sku TEXT,
  product_name TEXT,
  batch_id TEXT,
  serial_id TEXT,
  entry_kind TEXT NOT NULL CHECK (entry_kind IN ('ADJUSTMENT', 'MOVEMENT', 'SERIAL_OP')),
  movement_type TEXT NOT NULL,
  uom_code TEXT NOT NULL DEFAULT 'EA',
  input_qty_micro INTEGER NOT NULL,
  qty_delta_micro INTEGER NOT NULL,
  reason TEXT,
  notes TEXT,
  actor_user_id TEXT NOT NULL,
  outbox_command_id TEXT NOT NULL UNIQUE,
  sync_state TEXT NOT NULL DEFAULT 'PENDING_SYNC'
    CHECK (sync_state IN ('LOCAL_SAVED', 'PENDING_SYNC', 'SYNC_IN_FLIGHT', 'SERVER_CONFIRMED', 'CONFLICT_FLAGGED', 'QUARANTINED')),
  server_reference_id TEXT,
  conflict_reason TEXT,
  created_at TEXT NOT NULL,
  synced_at TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS idx_local_inv_movements_branch_state
  ON local_inventory_movements_queue (tenant_id, branch_id, sync_state, created_at DESC);

CREATE TABLE IF NOT EXISTS local_stock_transfers (
  id TEXT NOT NULL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  source_branch_id TEXT NOT NULL,
  source_warehouse_id TEXT NOT NULL,
  destination_branch_id TEXT NOT NULL,
  destination_warehouse_id TEXT,
  notes TEXT,
  lines_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'TRANSFER_REQUEST_PENDING'
    CHECK (status IN ('TRANSFER_REQUEST_PENDING', 'SERVER_CONFIRMED', 'CONFLICT_FLAGGED', 'QUARANTINED')),
  sync_state TEXT NOT NULL DEFAULT 'PENDING_SYNC'
    CHECK (sync_state IN ('LOCAL_SAVED', 'PENDING_SYNC', 'SYNC_IN_FLIGHT', 'SERVER_CONFIRMED', 'CONFLICT_FLAGGED', 'QUARANTINED')),
  outbox_command_id TEXT NOT NULL UNIQUE,
  server_transfer_id TEXT,
  server_transfer_number TEXT,
  conflict_reason TEXT,
  actor_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  synced_at TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS idx_local_stock_transfers_branch
  ON local_stock_transfers (tenant_id, source_branch_id, sync_state, created_at DESC);

CREATE TABLE IF NOT EXISTS local_sync_conflicts (
  id TEXT NOT NULL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  command_type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  local_reference_id TEXT,
  local_reference_number TEXT,
  conflict_code TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN'
    CHECK (status IN ('OPEN', 'QUARANTINED', 'RESOLVED', 'DISMISSED')),
  details_json TEXT NOT NULL DEFAULT '{}',
  original_payload_json TEXT NOT NULL DEFAULT '{}',
  resolution_action TEXT,
  resolution_notes TEXT,
  resolved_by_user_id TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_local_sync_conflicts_command
  ON local_sync_conflicts (tenant_id, command_id);

CREATE INDEX IF NOT EXISTS idx_local_sync_conflicts_status
  ON local_sync_conflicts (tenant_id, branch_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS local_device_security_state (
  singleton_id INTEGER NOT NULL PRIMARY KEY CHECK (singleton_id = 1),
  tenant_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'REVOKED', 'EXPIRED')),
  revoked_reason TEXT,
  last_verified_at TEXT NOT NULL,
  last_sync_attempt_at TEXT,
  last_sync_success_at TEXT,
  last_sync_error TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS local_recovery_backups_meta (
  id TEXT NOT NULL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  checksum_sha256 TEXT NOT NULL,
  record_counts_json TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

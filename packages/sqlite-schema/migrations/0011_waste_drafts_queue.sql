-- ============================================================================
-- NexStock — Canonical Local SQLite Schema Migration (Desktop & Mobile)
-- Version: 0011
-- Module: Offline Waste Draft Queue
-- ============================================================================

CREATE TABLE IF NOT EXISTS local_waste_drafts_queue (
  id TEXT NOT NULL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  warehouse_id TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  description TEXT,
  lines_json TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  outbox_command_id TEXT NOT NULL UNIQUE,
  sync_state TEXT NOT NULL DEFAULT 'PENDING_SYNC'
    CHECK (sync_state IN ('LOCAL_SAVED', 'PENDING_SYNC', 'SYNC_IN_FLIGHT', 'SERVER_CONFIRMED', 'CONFLICT_FLAGGED', 'QUARANTINED')),
  server_waste_log_id TEXT,
  server_waste_number TEXT,
  conflict_reason TEXT,
  created_at TEXT NOT NULL,
  synced_at TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS idx_local_waste_drafts_branch_state
  ON local_waste_drafts_queue (tenant_id, branch_id, sync_state, created_at DESC);

-- ============================================================================
-- NexStock — Canonical Local SQLite Schema Migration (Desktop & Mobile)
-- Version: 0008
-- Module: Phase 9.1 & 9.2 Offline Foundation, Local POS Master Data & Recovery
-- ============================================================================

CREATE TABLE IF NOT EXISTS local_customers (
  id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  customer_number TEXT NOT NULL,
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE', 'ARCHIVED')),
  sync_version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_local_customers_lookup
  ON local_customers (tenant_id, status, name);

CREATE TABLE IF NOT EXISTS local_branches (
  id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  is_main_branch INTEGER NOT NULL DEFAULT 0 CHECK (is_main_branch IN (0, 1)),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  default_warehouse_id TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
) STRICT;

CREATE TABLE IF NOT EXISTS local_warehouses (
  id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  branch_id TEXT,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  allow_negative_stock INTEGER NOT NULL DEFAULT 0 CHECK (allow_negative_stock IN (0, 1)),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
) STRICT;

CREATE TABLE IF NOT EXISTS local_pos_registers (
  id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  warehouse_id TEXT NOT NULL,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
) STRICT;

CREATE TABLE IF NOT EXISTS local_tax_groups (
  id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
) STRICT;

CREATE TABLE IF NOT EXISTS local_tax_rates (
  id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  tax_group_id TEXT NOT NULL,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  rate_percentage TEXT NOT NULL,
  is_compound INTEGER NOT NULL DEFAULT 0 CHECK (is_compound IN (0, 1)),
  priority INTEGER NOT NULL DEFAULT 1,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_local_tax_rates_group
  ON local_tax_rates (tenant_id, tax_group_id, priority ASC);

CREATE TABLE IF NOT EXISTS local_device_permissions (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  client_platform TEXT NOT NULL,
  all_locations_access INTEGER NOT NULL DEFAULT 0 CHECK (all_locations_access IN (0, 1)),
  allowed_branch_ids_json TEXT NOT NULL DEFAULT '[]',
  role_codes_json TEXT NOT NULL DEFAULT '[]',
  permissions_json TEXT NOT NULL DEFAULT '[]',
  offline_auth_expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, user_id)
) STRICT;

CREATE TABLE IF NOT EXISTS local_pos_draft_carts (
  id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  register_id TEXT,
  customer_id TEXT,
  customer_name TEXT,
  cart_lines_json TEXT NOT NULL DEFAULT '[]',
  notes TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, branch_id, user_id)
) STRICT;

CREATE TABLE IF NOT EXISTS local_sales_invoice_sync_meta (
  tenant_id TEXT NOT NULL,
  invoice_id TEXT NOT NULL,
  sync_state TEXT NOT NULL DEFAULT 'PENDING_SYNC' CHECK (
    sync_state IN (
      'LOCAL_SAVED',
      'PENDING_SYNC',
      'SYNC_IN_FLIGHT',
      'SERVER_CONFIRMED',
      'CONFLICT_FLAGGED',
      'QUARANTINED'
    )
  ),
  outbox_command_id TEXT,
  server_invoice_id TEXT,
  server_invoice_number TEXT,
  server_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (server_confirmed IN (0, 1)),
  conflict_reason TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, invoice_id)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_local_sales_sync_state
  ON local_sales_invoice_sync_meta (tenant_id, sync_state, updated_at DESC);

CREATE TABLE IF NOT EXISTS local_snapshot_freshness (
  tenant_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  last_successful_refresh_at TEXT NOT NULL,
  snapshot_version INTEGER NOT NULL DEFAULT 1,
  counts_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, branch_id)
) STRICT;

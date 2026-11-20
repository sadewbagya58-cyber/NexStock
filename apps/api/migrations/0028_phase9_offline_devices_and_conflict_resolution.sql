-- ============================================================================
-- NexStock Migration - 0028_phase9_offline_devices_and_conflict_resolution.sql
-- TARGET ENGINE: PostgreSQL 15+ / Supabase SQL Editor
-- PREREQUISITE: Must be executed AFTER 0027_batch_pricing_hybrid_barcodes_and_transfers.sql
-- Modules Covered: SYNC (Device Enrollment & Revocation, Conflict Resolution Trail)
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = 27) THEN
    RAISE EXCEPTION 'MIGRATION_SEQUENCE_ERROR: Migration 0027 must be applied before 0028.';
  END IF;
END $$;

-- ============================================================================
-- 1. EXTEND `sync_conflicts` WITH AUDITABLE RESOLUTION METADATA
-- ============================================================================

ALTER TABLE sync_conflicts
  ADD COLUMN IF NOT EXISTS command_type text,
  ADD COLUMN IF NOT EXISTS original_payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS resolution_action text,
  ADD COLUMN IF NOT EXISTS resolution_notes text,
  ADD COLUMN IF NOT EXISTS resolved_by_user_id uuid;

CREATE INDEX IF NOT EXISTS idx_sync_conflicts_tenant_status
  ON sync_conflicts (tenant_id, branch_id, status, created_at DESC);

-- ============================================================================
-- 2. OFFLINE DEVICE ENROLLMENT & REVOCATION TABLE (`offline_devices`)
-- ============================================================================

CREATE TABLE IF NOT EXISTS offline_devices (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  user_id uuid NOT NULL,
  client_platform text NOT NULL CHECK (client_platform IN ('WEB_BROWSER', 'TAURI_DESKTOP', 'MOBILE_APP', 'MOBILE_PWA', 'FLUTTER_MOBILE')),
  device_name text,
  app_version text,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'REVOKED')),
  revoked_reason text,
  revoked_by_user_id uuid,
  revoked_at timestamptz,
  enrolled_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS idx_offline_devices_branch_status
  ON offline_devices (tenant_id, branch_id, status, last_seen_at DESC);

ALTER TABLE offline_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE offline_devices FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON offline_devices;
CREATE POLICY tenant_isolation_policy ON offline_devices
  AS PERMISSIVE
  FOR ALL
  TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

GRANT SELECT, INSERT, UPDATE ON TABLE offline_devices TO nexstock_app_user;

-- ============================================================================
-- 3. RECORD COMPLETION OF MIGRATION 0028
-- ============================================================================

INSERT INTO schema_migrations (version, name, filename)
VALUES (28, '0028_phase9_offline_devices_and_conflict_resolution', '0028_phase9_offline_devices_and_conflict_resolution.sql')
ON CONFLICT (version) DO NOTHING;

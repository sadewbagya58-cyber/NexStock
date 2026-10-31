-- ============================================================================
-- NexStock — Migration 0013: Phase 6 Barcode Primary Invariant & Unique Index
-- ============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS idx_product_barcodes_one_primary
  ON product_barcodes (tenant_id, product_id)
  WHERE is_primary = true;

-- Record completion of Migration 0013
INSERT INTO schema_migrations (version, name, filename)
VALUES (13, '0013_phase6_barcode_integrity', '0013_phase6_barcode_integrity.sql')
ON CONFLICT (version) DO UPDATE
  SET applied_at = clock_timestamp(),
      applied_by = current_user;

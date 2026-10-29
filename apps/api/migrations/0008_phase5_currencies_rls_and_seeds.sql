-- ============================================================================
-- NexStock — Phase 5.0 Database Migration
-- Version: 0008
-- Module: Internationalization & Security (Currencies RLS Policy & Reference Seeds)
-- Compatible with PostgreSQL 15+ / Supabase (Non-Superuser CREATEROLE Compatible)
-- Specification Reference: NEX-DOC-01, NEX-DOC-02, NEX-DOC-05
-- ============================================================================

-- Preflight Check: Enforce sequential migration history (0007 must be applied first)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = 7) THEN
    RAISE EXCEPTION 'MIGRATION_SEQUENCE_ERROR: Migration 0007 must be applied before 0008.';
  END IF;
END $$;

-- ============================================================================
-- 1. ROW LEVEL SECURITY ON `currencies`
-- ============================================================================
-- Standardizes `public.currencies` with strict Row Level Security while ensuring
-- `nexstock_app_user` can read all active currencies without restriction.

ALTER TABLE currencies ENABLE ROW LEVEL SECURITY;
ALTER TABLE currencies FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS currencies_select_policy ON currencies;
CREATE POLICY currencies_select_policy ON currencies
  AS PERMISSIVE
  FOR SELECT
  TO nexstock_app_user
  USING (true);

-- Ensure explicit SELECT grant on currencies table to application role
GRANT SELECT ON TABLE currencies TO nexstock_app_user;

-- ============================================================================
-- 2. IDEMPOTENT REFERENCE CURRENCY SEEDS
-- ============================================================================
-- Guarantees all 11 supported currencies are present, active, and have valid metadata.

INSERT INTO currencies (code, name, symbol, minor_units, is_active) VALUES
  ('USD', 'US Dollar', '$', 2, true),
  ('LKR', 'Sri Lankan Rupee', 'Rs.', 2, true),
  ('EUR', 'Euro', '€', 2, true),
  ('GBP', 'Pound Sterling', '£', 2, true),
  ('INR', 'Indian Rupee', '₹', 2, true),
  ('AED', 'UAE Dirham', 'AED', 2, true),
  ('SGD', 'Singapore Dollar', 'S$', 2, true),
  ('AUD', 'Australian Dollar', 'A$', 2, true),
  ('JPY', 'Japanese Yen', '¥', 0, true),
  ('KWD', 'Kuwaiti Dinar', 'KD', 3, true),
  ('BHD', 'Bahraini Dinar', 'BD', 3, true)
ON CONFLICT (code) DO UPDATE
  SET is_active = true,
      name = EXCLUDED.name,
      symbol = EXCLUDED.symbol,
      minor_units = EXCLUDED.minor_units;

-- ============================================================================
-- 3. RECORD COMPLETION OF MIGRATION 0008
-- ============================================================================

INSERT INTO schema_migrations (version, name, filename)
VALUES (8, '0008_phase5_currencies_rls_and_seeds', '0008_phase5_currencies_rls_and_seeds.sql')
ON CONFLICT (version) DO UPDATE
  SET applied_at = clock_timestamp(),
      applied_by = current_user;

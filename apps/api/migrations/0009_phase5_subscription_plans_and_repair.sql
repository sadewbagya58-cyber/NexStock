-- ============================================================================
-- NexStock — Phase 5.1 Database Migration
-- Version: 0009
-- Module: Subscription & Multi-Tenant Entitlement (Plans RLS & Tenant Subscription Repair)
-- Compatible with PostgreSQL 15+ / Supabase (Non-Superuser CREATEROLE Compatible)
-- Specification Reference: NEX-DOC-01, NEX-DOC-02, NEX-DOC-05
-- ============================================================================

-- Preflight Check: Enforce sequential migration history (0008 must be applied first)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = 8) THEN
    RAISE EXCEPTION 'MIGRATION_SEQUENCE_ERROR: Migration 0008 must be applied before 0009.';
  END IF;
END $$;

-- ============================================================================
-- 1. ROW LEVEL SECURITY ON `subscription_plans`
-- ============================================================================
-- Standardizes `public.subscription_plans` with strict Row Level Security while
-- ensuring the application role `nexstock_app_user` can read all active plans.

ALTER TABLE subscription_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription_plans FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS subscription_plans_select_policy ON subscription_plans;
CREATE POLICY subscription_plans_select_policy ON subscription_plans
  AS PERMISSIVE
  FOR SELECT
  TO nexstock_app_user
  USING (true);

-- Ensure explicit SELECT grant on subscription_plans to application role
GRANT SELECT ON TABLE subscription_plans TO nexstock_app_user;

-- ============================================================================
-- 2. IDEMPOTENT REFERENCE SUBSCRIPTION PLANS
-- ============================================================================
-- Guarantees standard subscription tiers (STARTER, GROWTH, ENTERPRISE) are seeded,
-- active, and contain canonical entitlement limits.

INSERT INTO subscription_plans (
  id, code, name, max_branches, max_warehouses, max_registers, max_users, monthly_price_amount, currency_code, features_json, is_active
) VALUES
  ('0192b400-0000-7000-8000-000000000001', 'STARTER', 'Starter Plan', 1, 2, 2, 5, 29.0000, 'USD', '{"multiCurrency":false,"batchTracking":false}'::jsonb, true),
  ('0192b400-0000-7000-8000-000000000002', 'GROWTH', 'Growth Plan', 5, 10, 15, 25, 99.0000, 'USD', '{"multiCurrency":true,"batchTracking":true}'::jsonb, true),
  ('0192b400-0000-7000-8000-000000000003', 'ENTERPRISE', 'Enterprise Plan', 100, 200, 500, 1000, 299.0000, 'USD', '{"multiCurrency":true,"batchTracking":true}'::jsonb, true)
ON CONFLICT (code) DO UPDATE
  SET is_active = true,
      name = EXCLUDED.name,
      max_branches = EXCLUDED.max_branches,
      max_warehouses = EXCLUDED.max_warehouses,
      max_registers = EXCLUDED.max_registers,
      max_users = EXCLUDED.max_users,
      monthly_price_amount = EXCLUDED.monthly_price_amount,
      currency_code = EXCLUDED.currency_code,
      features_json = EXCLUDED.features_json;

-- ============================================================================
-- 3. IDEMPOTENT DATA REPAIR: PROVISION MISSING SUBSCRIPTIONS FOR ACTIVE TENANTS
-- ============================================================================
-- For any tenant created without a subscription record, provision a default
-- STARTER trial subscription (14-day trial) and align lifecycle status.

INSERT INTO tenant_subscriptions (
  id,
  tenant_id,
  plan_id,
  billing_mode,
  provider_code,
  status,
  trial_ends_at,
  current_period_start,
  current_period_end,
  allow_admin_override,
  override_reason,
  updated_at
)
SELECT
  gen_random_uuid(),
  t.id,
  '0192b400-0000-7000-8000-000000000001',
  'ADMIN_PROVISIONED',
  'MANUAL_ADMIN',
  'TRIALING',
  clock_timestamp() + interval '14 days',
  clock_timestamp(),
  clock_timestamp() + interval '14 days',
  false,
  'Phase 5.1 idempotent data repair: provision missing STARTER trial',
  clock_timestamp()
FROM tenants t
WHERE NOT EXISTS (
  SELECT 1 FROM tenant_subscriptions ts WHERE ts.tenant_id = t.id
);

-- Synchronize tenants whose status is empty or misaligned
UPDATE tenants
SET status = 'TRIALING',
    updated_at = clock_timestamp()
WHERE (status IS NULL OR status = '')
  AND id IN (SELECT tenant_id FROM tenant_subscriptions WHERE status = 'TRIALING');

-- ============================================================================
-- 4. RECORD COMPLETION OF MIGRATION 0009
-- ============================================================================

INSERT INTO schema_migrations (version, name, filename)
VALUES (9, '0009_phase5_subscription_plans_and_repair', '0009_phase5_subscription_plans_and_repair.sql')
ON CONFLICT (version) DO UPDATE
  SET applied_at = clock_timestamp(),
      applied_by = current_user;

-- ============================================================================
-- NexStock Migration - 0029_phase10_subscription_plans_lifecycle_billing.sql
-- TARGET ENGINE: PostgreSQL 15+ / Supabase SQL Editor
-- PREREQUISITE: Must be executed AFTER 0028_phase9_offline_devices_and_conflict_resolution.sql
-- Modules Covered: SUB (Phase 10.1 Plans & Pricing, 10.2 Entitlements & Quotas,
--                  10.3 Lifecycle & Grace Period, 10.4 Bank & Online Billing)
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = 28) THEN
    RAISE EXCEPTION 'MIGRATION_SEQUENCE_ERROR: Migration 0028 must be applied before 0029.';
  END IF;
END $$;

-- Helper function: platform admin context (strictly set only after DB verification of users.is_platform_admin = true)
CREATE OR REPLACE FUNCTION app_is_platform_admin() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(current_setting('app.is_platform_admin', true), 'false') = 'true';
$$;

GRANT EXECUTE ON FUNCTION app_is_platform_admin() TO nexstock_app_user;

-- ============================================================================
-- 1. EXTEND `subscription_plans` WITH CONFIGURABLE PRICING, LIMITS & MATRIX
-- ============================================================================

ALTER TABLE subscription_plans
  ADD COLUMN IF NOT EXISTS description text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS display_order integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS is_public boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS is_custom_pricing boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS annual_discount_pct numeric(5, 2) NOT NULL DEFAULT 15.00
    CHECK (annual_discount_pct >= 0 AND annual_discount_pct <= 100),
  ADD COLUMN IF NOT EXISTS additional_branch_monthly_fee numeric(19, 4)
    CHECK (additional_branch_monthly_fee IS NULL OR additional_branch_monthly_fee >= 0),
  ADD COLUMN IF NOT EXISTS max_products integer NOT NULL DEFAULT 2500
    CHECK (max_products >= 1),
  ADD COLUMN IF NOT EXISTS max_storage_mb integer NOT NULL DEFAULT 10240
    CHECK (max_storage_mb >= 1),
  ADD COLUMN IF NOT EXISTS trial_days integer NOT NULL DEFAULT 30
    CHECK (trial_days >= 0),
  ADD COLUMN IF NOT EXISTS support_level text NOT NULL DEFAULT 'Email Support',
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT clock_timestamp();

DROP POLICY IF EXISTS subscription_plans_platform_admin_update ON subscription_plans;
CREATE POLICY subscription_plans_platform_admin_update ON subscription_plans
  AS PERMISSIVE
  FOR UPDATE
  TO nexstock_app_user
  USING (app_is_platform_admin())
  WITH CHECK (app_is_platform_admin());

GRANT UPDATE ON TABLE subscription_plans TO nexstock_app_user;

INSERT INTO subscription_plans (
  id, code, name, description, display_order, is_public, is_custom_pricing,
  max_branches, max_warehouses, max_registers, max_users, max_products, max_storage_mb,
  monthly_price_amount, annual_discount_pct, additional_branch_monthly_fee,
  currency_code, trial_days, support_level, features_json, is_active, version
) VALUES
  (
    '0192b400-0000-7000-8000-000000000001',
    'STARTER',
    'Starter',
    'Essential online POS, inventory control, customer credit, and basic reports for single-store businesses.',
    1, true, false,
    1, 2, 2, 3, 2500, 10240,
    2990.0000, 15.00, 750.0000,
    'LKR', 30, 'Email Support',
    '{
      "onlinePos": true,
      "onlineInventory": true,
      "desktopOfflinePos": false,
      "mobileOfflinePos": false,
      "offlineInventory": false,
      "basicReports": true,
      "advancedReports": false,
      "multiBranchComparison": false,
      "customReports": false,
      "customerDirectory": true,
      "customerProfiles": true,
      "customerSearch": true,
      "basicPurchaseHistory": true,
      "advancedPurchaseHistory": false,
      "basicCustomerCredit": true,
      "advancedCustomerCredit": false,
      "customerAnalytics": false,
      "apiAccess": false,
      "basicCsvExport": true,
      "basicPdfExport": true,
      "excelExport": false,
      "advancedExport": false,
      "customReportExport": false,
      "basicInventory": true,
      "fifoMacCosting": true,
      "basicStockMovementHistory": true,
      "batchTracking": false,
      "expiryTracking": false,
      "serialTracking": false,
      "fefoFifoAllocation": false,
      "advancedMovementHistory": false,
      "customInventoryFeatures": false,
      "basicPos": true,
      "advancedPos": false,
      "cashPayment": true,
      "advancedReturns": false,
      "advancedCheckout": false,
      "customPosCapabilities": false,
      "posPaymentCash": true,
      "posPaymentCard": false,
      "posPaymentBankTransfer": false,
      "posPaymentSplit": false,
      "posPaymentCustom": false,
      "barcodeFull": true,
      "supplierDirectory": true,
      "basicPurchaseOrders": true,
      "goodsReceiving": true,
      "advancedPurchasing": false,
      "supplierPerformance": false,
      "purchaseAnalytics": false,
      "customPurchaseWorkflows": false,
      "multiBranchManagement": false,
      "stockTransfers": false,
      "advancedMultiBranch": false,
      "basicStockAdjustments": true,
      "advancedStockAdjustments": false,
      "advancedAdjustmentReports": false,
      "basicUom": true,
      "advancedUom": false,
      "advancedVariableQty": false,
      "productCategoriesFull": true,
      "basicNotifications": true,
      "basicAlerts": true,
      "advancedAlerts": false,
      "customNotifications": false,
      "notificationAutomation": false,
      "basicBackup": true,
      "advancedRecovery": false,
      "automatedBackup": false,
      "advancedDisasterRecovery": false,
      "basicEmployeeManagement": true,
      "basicRoles": true,
      "advancedPermissions": false,
      "customRoles": false,
      "advancedAccessPolicies": false,
      "multiCurrency": false,
      "hrm": false
    }'::jsonb,
    true, 2
  ),
  (
    '0192b400-0000-7000-8000-000000000004',
    'PROFESSIONAL',
    'Professional',
    'Multi-branch operations, Desktop & Mobile Offline POS, batch/expiry/serial tracking, transfers, and advanced analytics.',
    2, true, false,
    5, 25, 50, 15, 25000, 51200,
    5990.0000, 15.00, 500.0000,
    'LKR', 30, 'Priority Support',
    '{
      "onlinePos": true,
      "onlineInventory": true,
      "desktopOfflinePos": true,
      "mobileOfflinePos": true,
      "offlineInventory": true,
      "basicReports": true,
      "advancedReports": true,
      "multiBranchComparison": true,
      "customReports": false,
      "customerDirectory": true,
      "customerProfiles": true,
      "customerSearch": true,
      "basicPurchaseHistory": true,
      "advancedPurchaseHistory": true,
      "basicCustomerCredit": true,
      "advancedCustomerCredit": true,
      "customerAnalytics": true,
      "apiAccess": true,
      "basicCsvExport": true,
      "basicPdfExport": true,
      "excelExport": true,
      "advancedExport": true,
      "customReportExport": false,
      "basicInventory": true,
      "fifoMacCosting": true,
      "basicStockMovementHistory": true,
      "batchTracking": true,
      "expiryTracking": true,
      "serialTracking": true,
      "fefoFifoAllocation": true,
      "advancedMovementHistory": true,
      "customInventoryFeatures": false,
      "basicPos": true,
      "advancedPos": true,
      "cashPayment": true,
      "advancedReturns": true,
      "advancedCheckout": true,
      "customPosCapabilities": false,
      "posPaymentCash": true,
      "posPaymentCard": true,
      "posPaymentBankTransfer": true,
      "posPaymentSplit": true,
      "posPaymentCustom": false,
      "barcodeFull": true,
      "supplierDirectory": true,
      "basicPurchaseOrders": true,
      "goodsReceiving": true,
      "advancedPurchasing": true,
      "supplierPerformance": true,
      "purchaseAnalytics": true,
      "customPurchaseWorkflows": false,
      "multiBranchManagement": true,
      "stockTransfers": true,
      "advancedMultiBranch": false,
      "basicStockAdjustments": true,
      "advancedStockAdjustments": true,
      "advancedAdjustmentReports": true,
      "basicUom": true,
      "advancedUom": true,
      "advancedVariableQty": true,
      "productCategoriesFull": true,
      "basicNotifications": true,
      "basicAlerts": true,
      "advancedAlerts": true,
      "customNotifications": false,
      "notificationAutomation": false,
      "basicBackup": true,
      "advancedRecovery": true,
      "automatedBackup": false,
      "advancedDisasterRecovery": false,
      "basicEmployeeManagement": true,
      "basicRoles": true,
      "advancedPermissions": true,
      "customRoles": false,
      "advancedAccessPolicies": false,
      "multiCurrency": true,
      "hrm": false
    }'::jsonb,
    true, 2
  ),
  (
    '0192b400-0000-7000-8000-000000000003',
    'ENTERPRISE',
    'Enterprise',
    'Custom multi-branch quotas, custom reports, custom roles, automated backups, and dedicated SLA support.',
    3, true, true,
    100, 200, 500, 1000, 1000000, 512000,
    0.0000, 0.00, NULL,
    'LKR', 30, 'Dedicated Support + SLA',
    '{
      "onlinePos": true,
      "onlineInventory": true,
      "desktopOfflinePos": true,
      "mobileOfflinePos": true,
      "offlineInventory": true,
      "basicReports": true,
      "advancedReports": true,
      "multiBranchComparison": true,
      "customReports": true,
      "customerDirectory": true,
      "customerProfiles": true,
      "customerSearch": true,
      "basicPurchaseHistory": true,
      "advancedPurchaseHistory": true,
      "basicCustomerCredit": true,
      "advancedCustomerCredit": true,
      "customerAnalytics": true,
      "apiAccess": true,
      "basicCsvExport": true,
      "basicPdfExport": true,
      "excelExport": true,
      "advancedExport": true,
      "customReportExport": true,
      "basicInventory": true,
      "fifoMacCosting": true,
      "basicStockMovementHistory": true,
      "batchTracking": true,
      "expiryTracking": true,
      "serialTracking": true,
      "fefoFifoAllocation": true,
      "advancedMovementHistory": true,
      "customInventoryFeatures": true,
      "basicPos": true,
      "advancedPos": true,
      "cashPayment": true,
      "advancedReturns": true,
      "advancedCheckout": true,
      "customPosCapabilities": true,
      "posPaymentCash": true,
      "posPaymentCard": true,
      "posPaymentBankTransfer": true,
      "posPaymentSplit": true,
      "posPaymentCustom": true,
      "barcodeFull": true,
      "supplierDirectory": true,
      "basicPurchaseOrders": true,
      "goodsReceiving": true,
      "advancedPurchasing": true,
      "supplierPerformance": true,
      "purchaseAnalytics": true,
      "customPurchaseWorkflows": true,
      "multiBranchManagement": true,
      "stockTransfers": true,
      "advancedMultiBranch": true,
      "basicStockAdjustments": true,
      "advancedStockAdjustments": true,
      "advancedAdjustmentReports": true,
      "basicUom": true,
      "advancedUom": true,
      "advancedVariableQty": true,
      "productCategoriesFull": true,
      "basicNotifications": true,
      "basicAlerts": true,
      "advancedAlerts": true,
      "customNotifications": true,
      "notificationAutomation": true,
      "basicBackup": true,
      "advancedRecovery": true,
      "automatedBackup": true,
      "advancedDisasterRecovery": true,
      "basicEmployeeManagement": true,
      "basicRoles": true,
      "advancedPermissions": true,
      "customRoles": true,
      "advancedAccessPolicies": true,
      "multiCurrency": true,
      "hrm": false
    }'::jsonb,
    true, 2
  ),
  (
    '0192b400-0000-7000-8000-000000000002',
    'GROWTH',
    'Growth Plan (Legacy Alias)',
    'Legacy internal alias aligned with Professional tier.',
    99, false, false,
    5, 25, 50, 15, 25000, 51200,
    5990.0000, 15.00, 500.0000,
    'LKR', 30, 'Priority Support',
    '{
      "onlinePos": true,
      "onlineInventory": true,
      "desktopOfflinePos": true,
      "mobileOfflinePos": true,
      "offlineInventory": true,
      "basicReports": true,
      "advancedReports": true,
      "multiBranchComparison": true,
      "customReports": false,
      "batchTracking": true,
      "expiryTracking": true,
      "serialTracking": true,
      "fefoFifoAllocation": true,
      "multiBranchManagement": true,
      "stockTransfers": true,
      "multiCurrency": true,
      "hrm": false
    }'::jsonb,
    true, 2
  )
ON CONFLICT (code) DO UPDATE
  SET name = EXCLUDED.name,
      description = EXCLUDED.description,
      display_order = EXCLUDED.display_order,
      is_public = EXCLUDED.is_public,
      is_custom_pricing = EXCLUDED.is_custom_pricing,
      max_branches = EXCLUDED.max_branches,
      max_warehouses = EXCLUDED.max_warehouses,
      max_registers = EXCLUDED.max_registers,
      max_users = EXCLUDED.max_users,
      max_products = EXCLUDED.max_products,
      max_storage_mb = EXCLUDED.max_storage_mb,
      monthly_price_amount = EXCLUDED.monthly_price_amount,
      annual_discount_pct = EXCLUDED.annual_discount_pct,
      additional_branch_monthly_fee = EXCLUDED.additional_branch_monthly_fee,
      currency_code = EXCLUDED.currency_code,
      trial_days = EXCLUDED.trial_days,
      support_level = EXCLUDED.support_level,
      features_json = EXCLUDED.features_json,
      is_active = EXCLUDED.is_active,
      version = EXCLUDED.version,
      updated_at = clock_timestamp();

-- ============================================================================
-- 2. EXPAND SUBSCRIPTION LIFECYCLE STATUS CONSTRAINTS & METADATA
-- ============================================================================

DO $$
DECLARE
  v_con RECORD;
BEGIN
  FOR v_con IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'tenants'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ~ 'status'
  LOOP
    EXECUTE format('ALTER TABLE tenants DROP CONSTRAINT IF EXISTS %I', v_con.conname);
  END LOOP;

  FOR v_con IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'tenant_subscriptions'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ~ 'status'
  LOOP
    EXECUTE format('ALTER TABLE tenant_subscriptions DROP CONSTRAINT IF EXISTS %I', v_con.conname);
  END LOOP;
END $$;

ALTER TABLE tenants
  ADD CONSTRAINT tenants_status_check
  CHECK (status IN (
    'TRIALING', 'ACTIVE', 'PENDING_PAYMENT', 'PAYMENT_VERIFICATION_REQUIRED',
    'RENEWAL_DUE', 'GRACE_PERIOD', 'EXPIRED', 'READ_ONLY',
    'PAST_DUE', 'SUSPENDED', 'CANCELLED'
  ));

ALTER TABLE tenant_subscriptions
  ADD CONSTRAINT tenant_subscriptions_status_check
  CHECK (status IN (
    'TRIALING', 'ACTIVE', 'PENDING_PAYMENT', 'PAYMENT_VERIFICATION_REQUIRED',
    'RENEWAL_DUE', 'GRACE_PERIOD', 'EXPIRED', 'READ_ONLY',
    'PAST_DUE', 'SUSPENDED', 'CANCELLED'
  ));

ALTER TABLE tenant_subscriptions
  ADD COLUMN IF NOT EXISTS billing_cycle text NOT NULL DEFAULT 'MONTHLY'
    CHECK (billing_cycle IN ('MONTHLY', 'ANNUAL')),
  ADD COLUMN IF NOT EXISTS trial_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS trial_converted_at timestamptz,
  ADD COLUMN IF NOT EXISTS grace_period_ends_at timestamptz,
  ADD COLUMN IF NOT EXISTS read_only_entered_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz,
  ADD COLUMN IF NOT EXISTS scheduled_plan_id uuid REFERENCES subscription_plans (id),
  ADD COLUMN IF NOT EXISTS scheduled_billing_cycle text
    CHECK (scheduled_billing_cycle IS NULL OR scheduled_billing_cycle IN ('MONTHLY', 'ANNUAL')),
  ADD COLUMN IF NOT EXISTS scheduled_change_effective_at timestamptz,
  ADD COLUMN IF NOT EXISTS additional_branch_slots integer NOT NULL DEFAULT 0
    CHECK (additional_branch_slots >= 0),
  ADD COLUMN IF NOT EXISTS custom_monthly_price numeric(19, 4)
    CHECK (custom_monthly_price IS NULL OR custom_monthly_price >= 0),
  ADD COLUMN IF NOT EXISTS custom_limits_json jsonb,
  ADD COLUMN IF NOT EXISTS custom_features_json jsonb;

DROP POLICY IF EXISTS tenant_isolation_policy ON tenant_subscriptions;
CREATE POLICY tenant_isolation_policy ON tenant_subscriptions
  AS PERMISSIVE
  FOR ALL
  TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id() OR app_is_platform_admin())
  WITH CHECK (tenant_id = app_current_tenant_id() OR app_is_platform_admin());

DROP POLICY IF EXISTS tenant_isolation_policy ON tenants;
CREATE POLICY tenant_isolation_policy ON tenants
  AS PERMISSIVE
  FOR ALL
  TO nexstock_app_user
  USING (id = app_current_tenant_id() OR app_is_platform_admin())
  WITH CHECK (id = app_current_tenant_id() OR app_is_platform_admin());

-- ============================================================================
-- 3. EXTEND `subscription_invoices` FOR CYCLES, PRORATION & UPGRADES
-- ============================================================================

ALTER TABLE subscription_invoices
  ADD COLUMN IF NOT EXISTS billing_cycle text NOT NULL DEFAULT 'MONTHLY'
    CHECK (billing_cycle IN ('MONTHLY', 'ANNUAL')),
  ADD COLUMN IF NOT EXISTS invoice_type text NOT NULL DEFAULT 'PLAN_SUBSCRIPTION'
    CHECK (invoice_type IN ('PLAN_SUBSCRIPTION', 'TRIAL_CONVERSION', 'UPGRADE', 'RENEWAL', 'BRANCH_ADDON', 'CUSTOM')),
  ADD COLUMN IF NOT EXISTS target_plan_id uuid REFERENCES subscription_plans (id),
  ADD COLUMN IF NOT EXISTS target_billing_cycle text
    CHECK (target_billing_cycle IS NULL OR target_billing_cycle IN ('MONTHLY', 'ANNUAL')),
  ADD COLUMN IF NOT EXISTS branch_addon_qty integer NOT NULL DEFAULT 0 CHECK (branch_addon_qty >= 0),
  ADD COLUMN IF NOT EXISTS plan_amount numeric(19, 4) NOT NULL DEFAULT 0 CHECK (plan_amount >= 0),
  ADD COLUMN IF NOT EXISTS discount_amount numeric(19, 4) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
  ADD COLUMN IF NOT EXISTS addon_amount numeric(19, 4) NOT NULL DEFAULT 0 CHECK (addon_amount >= 0),
  ADD COLUMN IF NOT EXISTS proration_amount numeric(19, 4) NOT NULL DEFAULT 0 CHECK (proration_amount >= 0),
  ADD COLUMN IF NOT EXISTS notes text,
  ADD COLUMN IF NOT EXISTS paid_at timestamptz;

DROP POLICY IF EXISTS tenant_isolation_policy ON subscription_invoices;
CREATE POLICY tenant_isolation_policy ON subscription_invoices
  AS PERMISSIVE
  FOR ALL
  TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id() OR app_is_platform_admin())
  WITH CHECK (tenant_id = app_current_tenant_id() OR app_is_platform_admin());

DROP POLICY IF EXISTS tenant_isolation_policy ON subscription_payments;
CREATE POLICY tenant_isolation_policy ON subscription_payments
  AS PERMISSIVE
  FOR ALL
  TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id() OR app_is_platform_admin())
  WITH CHECK (tenant_id = app_current_tenant_id() OR app_is_platform_admin());

-- ============================================================================
-- 4. SUBSCRIPTION PLAN HISTORY & BRANCH ADD-ONS TABLES
-- ============================================================================

CREATE TABLE IF NOT EXISTS subscription_plan_history (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  subscription_id uuid NOT NULL,
  change_type text NOT NULL CHECK (change_type IN (
    'TRIAL_STARTED', 'TRIAL_CONVERTED', 'UPGRADED', 'DOWNGRADE_SCHEDULED',
    'DOWNGRADE_APPLIED', 'DOWNGRADE_CANCELLED', 'RENEWED',
    'BRANCH_ADDON_PURCHASED', 'STATUS_CHANGED', 'LIFECYCLE_OVERRIDE'
  )),
  from_plan_id uuid REFERENCES subscription_plans (id),
  to_plan_id uuid REFERENCES subscription_plans (id),
  from_status text,
  to_status text,
  billing_cycle text NOT NULL DEFAULT 'MONTHLY' CHECK (billing_cycle IN ('MONTHLY', 'ANNUAL')),
  effective_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor_user_id uuid NOT NULL,
  notes text,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, subscription_id) REFERENCES tenant_subscriptions (tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sub_plan_history_tenant_created
  ON subscription_plan_history (tenant_id, created_at DESC);

ALTER TABLE subscription_plan_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription_plan_history FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON subscription_plan_history;
CREATE POLICY tenant_isolation_policy ON subscription_plan_history
  AS PERMISSIVE
  FOR ALL
  TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id() OR app_is_platform_admin())
  WITH CHECK (tenant_id = app_current_tenant_id() OR app_is_platform_admin());

GRANT SELECT, INSERT ON TABLE subscription_plan_history TO nexstock_app_user;

CREATE TABLE IF NOT EXISTS subscription_branch_addons (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  subscription_id uuid NOT NULL,
  invoice_id uuid,
  quantity integer NOT NULL CHECK (quantity >= 1),
  unit_monthly_price numeric(19, 4) NOT NULL CHECK (unit_monthly_price >= 0),
  prorated_amount numeric(19, 4) NOT NULL CHECK (prorated_amount >= 0),
  currency_code char(3) NOT NULL REFERENCES currencies (code),
  billing_cycle text NOT NULL CHECK (billing_cycle IN ('MONTHLY', 'ANNUAL')),
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'PENDING_PAYMENT' CHECK (status IN ('PENDING_PAYMENT', 'ACTIVE', 'CANCELLED')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, subscription_id) REFERENCES tenant_subscriptions (tenant_id, id) ON DELETE CASCADE
);

ALTER TABLE subscription_branch_addons ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription_branch_addons FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON subscription_branch_addons;
CREATE POLICY tenant_isolation_policy ON subscription_branch_addons
  AS PERMISSIVE
  FOR ALL
  TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id() OR app_is_platform_admin())
  WITH CHECK (tenant_id = app_current_tenant_id() OR app_is_platform_admin());

GRANT SELECT, INSERT, UPDATE ON TABLE subscription_branch_addons TO nexstock_app_user;

-- ============================================================================
-- 5. CENTRAL PLATFORM BANK & BILLING SETTINGS (`subscription_platform_settings`)
-- ============================================================================

CREATE TABLE IF NOT EXISTS subscription_platform_settings (
  singleton_id integer PRIMARY KEY CHECK (singleton_id = 1),
  manual_bank_transfer_enabled boolean NOT NULL DEFAULT true,
  bank_account_name text NOT NULL,
  bank_name text NOT NULL,
  bank_branch text NOT NULL,
  bank_account_number text NOT NULL,
  bank_instructions text NOT NULL,
  online_gateway_enabled boolean NOT NULL DEFAULT false,
  online_gateway_provider text NOT NULL DEFAULT 'PAYHERE_LK'
    CHECK (online_gateway_provider IN ('PAYHERE_LK', 'STRIPE', 'PADDLE')),
  super_admin_email text NOT NULL DEFAULT 'sadewbagya58@gmail.com',
  grace_period_days integer NOT NULL DEFAULT 7 CHECK (grace_period_days >= 1),
  trial_days_default integer NOT NULL DEFAULT 30 CHECK (trial_days_default >= 1),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_by_user_id uuid
);

INSERT INTO subscription_platform_settings (
  singleton_id, manual_bank_transfer_enabled,
  bank_account_name, bank_name, bank_branch, bank_account_number, bank_instructions,
  online_gateway_enabled, online_gateway_provider,
  super_admin_email, grace_period_days, trial_days_default
) VALUES (
  1,
  true,
  'W.Swarnalatha',
  'People''s Bank',
  'Bingiriya Branch',
  '172200270058302',
  'Transfer the exact invoice amount in LKR and include your invoice or business reference number. Upload a clear bank slip or online transfer screenshot for verification.',
  false,
  'PAYHERE_LK',
  'sadewbagya58@gmail.com',
  7,
  30
)
ON CONFLICT (singleton_id) DO NOTHING;

ALTER TABLE subscription_platform_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription_platform_settings FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sub_platform_settings_read ON subscription_platform_settings;
CREATE POLICY sub_platform_settings_read ON subscription_platform_settings
  AS PERMISSIVE
  FOR SELECT
  TO nexstock_app_user
  USING (true);

DROP POLICY IF EXISTS sub_platform_settings_admin_update ON subscription_platform_settings;
CREATE POLICY sub_platform_settings_admin_update ON subscription_platform_settings
  AS PERMISSIVE
  FOR UPDATE
  TO nexstock_app_user
  USING (app_is_platform_admin())
  WITH CHECK (app_is_platform_admin());

GRANT SELECT, UPDATE ON TABLE subscription_platform_settings TO nexstock_app_user;

-- Bootstrap flag only if the designated initial Super Admin user record already exists
UPDATE users
SET is_platform_admin = true,
    updated_at = clock_timestamp()
WHERE LOWER(email) = 'sadewbagya58@gmail.com'
  AND is_platform_admin = false;

-- ============================================================================
-- 6. PRIVATE PAYMENT SUBMISSIONS, RECEIPT PROOFS & WEBHOOK IDEMPOTENCY
-- ============================================================================

CREATE TABLE IF NOT EXISTS subscription_payment_submissions (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  subscription_id uuid NOT NULL,
  invoice_id uuid NOT NULL,
  target_plan_id uuid NOT NULL REFERENCES subscription_plans (id),
  target_billing_cycle text NOT NULL CHECK (target_billing_cycle IN ('MONTHLY', 'ANNUAL')),
  payment_channel text NOT NULL CHECK (payment_channel IN ('MANUAL_BANK_TRANSFER', 'ONLINE_GATEWAY')),
  gateway_provider text CHECK (gateway_provider IS NULL OR gateway_provider IN ('PAYHERE_LK', 'STRIPE', 'PADDLE')),
  expected_amount numeric(19, 4) NOT NULL CHECK (expected_amount > 0),
  submitted_amount numeric(19, 4) NOT NULL CHECK (submitted_amount > 0),
  currency_code char(3) NOT NULL REFERENCES currencies (code),
  payment_reference text NOT NULL,
  submission_notes text,
  proof_storage_key text,
  proof_file_name text,
  proof_mime_type text,
  proof_file_size integer CHECK (proof_file_size IS NULL OR proof_file_size > 0),
  proof_data_bytea bytea,
  status text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'SUBMITTED', 'UNDER_REVIEW', 'VERIFIED', 'REJECTED', 'FAILED')),
  submitted_by_user_id uuid NOT NULL,
  submitted_at timestamptz,
  reviewed_by_user_id uuid,
  reviewed_at timestamptz,
  rejection_reason text,
  gateway_transaction_id text,
  gateway_payload_json jsonb,
  verified_payment_id uuid,
  idempotency_key text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, subscription_id) REFERENCES tenant_subscriptions (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES subscription_invoices (tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sub_payment_submissions_status
  ON subscription_payment_submissions (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_sub_payment_submissions_tenant
  ON subscription_payment_submissions (tenant_id, created_at DESC);

ALTER TABLE subscription_payment_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription_payment_submissions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON subscription_payment_submissions;
CREATE POLICY tenant_isolation_policy ON subscription_payment_submissions
  AS PERMISSIVE
  FOR ALL
  TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id() OR app_is_platform_admin())
  WITH CHECK (tenant_id = app_current_tenant_id() OR app_is_platform_admin());

GRANT SELECT, INSERT, UPDATE ON TABLE subscription_payment_submissions TO nexstock_app_user;

CREATE TABLE IF NOT EXISTS subscription_gateway_webhook_logs (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  provider_code text NOT NULL CHECK (provider_code IN ('PAYHERE_LK', 'STRIPE', 'PADDLE')),
  provider_event_id text NOT NULL,
  submission_id uuid NOT NULL,
  gateway_transaction_id text NOT NULL,
  event_status text NOT NULL,
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  processed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (provider_code, provider_event_id)
);

ALTER TABLE subscription_gateway_webhook_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription_gateway_webhook_logs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON subscription_gateway_webhook_logs;
CREATE POLICY tenant_isolation_policy ON subscription_gateway_webhook_logs
  AS PERMISSIVE
  FOR ALL
  TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id() OR app_is_platform_admin())
  WITH CHECK (tenant_id = app_current_tenant_id() OR app_is_platform_admin());

GRANT SELECT, INSERT ON TABLE subscription_gateway_webhook_logs TO nexstock_app_user;

-- Also permit Platform Admin verification audit/outbox writes when strictly inside verified Platform Admin transaction
DROP POLICY IF EXISTS tenant_isolation_policy ON audit_logs;
CREATE POLICY tenant_isolation_policy ON audit_logs
  AS PERMISSIVE
  FOR ALL
  TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id() OR app_is_platform_admin())
  WITH CHECK (tenant_id = app_current_tenant_id() OR app_is_platform_admin());

DROP POLICY IF EXISTS tenant_isolation_policy ON outbox_events;
CREATE POLICY tenant_isolation_policy ON outbox_events
  AS PERMISSIVE
  FOR ALL
  TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id() OR app_is_platform_admin())
  WITH CHECK (tenant_id = app_current_tenant_id() OR app_is_platform_admin());

-- ============================================================================
-- 7. RECORD COMPLETION OF MIGRATION 0029
-- ============================================================================

INSERT INTO schema_migrations (version, name, filename)
VALUES (29, '0029_phase10_subscription_plans_lifecycle_billing', '0029_phase10_subscription_plans_lifecycle_billing.sql')
ON CONFLICT (version) DO UPDATE
  SET applied_at = clock_timestamp(),
      applied_by = current_user;

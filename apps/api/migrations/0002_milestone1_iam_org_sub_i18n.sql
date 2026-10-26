-- ============================================================================
-- NexStock Milestone 1 Migration — 0002_milestone1_iam_org_sub_i18n.sql
-- TARGET ENGINE: PostgreSQL 15+ / Supabase SQL Editor (Step 2 of 2)
-- PREREQUISITE: Must be executed AFTER `0001_shared_foundation_rls.sql`
-- Modules Covered: I18N, SUB, ORG, IAM
-- Specification Reference: NEX-DOC-03, NEX-DOC-04, NEX-DOC-05, NEX-DOC-06
-- ============================================================================
-- Properties:
--   1. Pure PostgreSQL SQL (no SQLite PRAGMA, AUTOINCREMENT, or STRICT syntax).
--   2. Reproducible and idempotent (safe to rerun).
--   3. Enforces composite foreign keys (tenant_id, id) across all tenant tables.
--   4. Enables & forces PostgreSQL Row Level Security (RLS) on all tenant tables.
--   5. Grants least-privilege access to `nexstock_app_user` (NOBYPASSRLS).
-- ============================================================================

-- Preflight Prerequisite Verification: Ensure `0001_shared_foundation_rls.sql` completed in full first
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_roles
    WHERE rolname = 'nexstock_app_user'
      AND rolsuper = false
      AND rolbypassrls = false
  ) THEN
    RAISE EXCEPTION 'MIGRATION_ORDER_ERROR: Role "nexstock_app_user" (with NOSUPERUSER and NOBYPASSRLS) does not exist. Execute apps/api/migrations/0001_shared_foundation_rls.sql before 0002_milestone1_iam_org_sub_i18n.sql.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'app_current_tenant_id') THEN
    RAISE EXCEPTION 'MIGRATION_ORDER_ERROR: Function "app_current_tenant_id()" does not exist. Execute apps/api/migrations/0001_shared_foundation_rls.sql before 0002_milestone1_iam_org_sub_i18n.sql.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'prevent_immutable_row_mutation') THEN
    RAISE EXCEPTION 'MIGRATION_ORDER_ERROR: Function "prevent_immutable_row_mutation()" does not exist. Execute apps/api/migrations/0001_shared_foundation_rls.sql before 0002_milestone1_iam_org_sub_i18n.sql.';
  END IF;

  IF (
    SELECT count(*)
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname IN ('idempotency_keys', 'outbox_events', 'audit_logs', 'sync_command_log', 'sync_conflicts')
      AND c.relrowsecurity = true
      AND c.relforcerowsecurity = true
  ) < 5 THEN
    RAISE EXCEPTION 'MIGRATION_ORDER_ERROR: Foundation tables from 0001_shared_foundation_rls.sql are missing or do not have FORCE ROW LEVEL SECURITY enabled.';
  END IF;

  IF NOT has_table_privilege('nexstock_app_user', 'public.sync_conflicts', 'SELECT') THEN
    RAISE EXCEPTION 'MIGRATION_ORDER_ERROR: Final grants from 0001_shared_foundation_rls.sql have not been applied to "nexstock_app_user".';
  END IF;
END
$$;

-- ============================================================================
-- MODULE 1: I18N (Currencies, Exchange Rates, Taxes, Localization Settings)
-- ============================================================================

CREATE TABLE IF NOT EXISTS currencies (
  code char(3) PRIMARY KEY,
  name text NOT NULL,
  symbol text NOT NULL,
  minor_units smallint NOT NULL CHECK (minor_units IN (0, 2, 3)),
  is_active boolean NOT NULL DEFAULT true
);

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
ON CONFLICT (code) DO NOTHING;

-- ============================================================================
-- MODULE 2: ORG (Tenants, Branches, Warehouses, Links, POS Registers)
-- ============================================================================

CREATE TABLE IF NOT EXISTS tenants (
  id uuid PRIMARY KEY,
  slug text NOT NULL UNIQUE,
  legal_name text NOT NULL,
  base_currency char(3) NOT NULL REFERENCES currencies (code),
  default_locale text NOT NULL DEFAULT 'en-US',
  default_timezone text NOT NULL DEFAULT 'UTC',
  country_code char(2) NOT NULL DEFAULT 'US',
  status text NOT NULL DEFAULT 'TRIALING' CHECK (status IN ('TRIALING', 'ACTIVE', 'PAST_DUE', 'GRACE_PERIOD', 'SUSPENDED', 'CANCELLED')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON tenants;
CREATE POLICY tenant_isolation_policy ON tenants
  AS PERMISSIVE
  FOR ALL
  TO nexstock_app_user
  USING (id = app_current_tenant_id())
  WITH CHECK (id = app_current_tenant_id());

CREATE TABLE IF NOT EXISTS branches (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  code text NOT NULL,
  name text NOT NULL,
  timezone text NOT NULL,
  country_code char(2) NOT NULL,
  default_warehouse_id uuid,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, code)
);

ALTER TABLE branches ENABLE ROW LEVEL SECURITY;
ALTER TABLE branches FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON branches;
CREATE POLICY tenant_isolation_policy ON branches
  AS PERMISSIVE
  FOR ALL
  TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

CREATE TABLE IF NOT EXISTS warehouses (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  branch_id uuid,
  code text NOT NULL,
  name text NOT NULL,
  allow_negative_stock boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id)
);

ALTER TABLE warehouses ENABLE ROW LEVEL SECURITY;
ALTER TABLE warehouses FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON warehouses;
CREATE POLICY tenant_isolation_policy ON warehouses
  AS PERMISSIVE
  FOR ALL
  TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

CREATE TABLE IF NOT EXISTS branch_warehouse_links (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  is_primary boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, branch_id, warehouse_id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id),
  FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouses (tenant_id, id)
);

ALTER TABLE branch_warehouse_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE branch_warehouse_links FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON branch_warehouse_links;
CREATE POLICY tenant_isolation_policy ON branch_warehouse_links
  AS PERMISSIVE
  FOR ALL
  TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

CREATE TABLE IF NOT EXISTS pos_registers (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  last_invoice_seq bigint NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, branch_id, code),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id),
  FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouses (tenant_id, id)
);

ALTER TABLE pos_registers ENABLE ROW LEVEL SECURITY;
ALTER TABLE pos_registers FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON pos_registers;
CREATE POLICY tenant_isolation_policy ON pos_registers
  AS PERMISSIVE
  FOR ALL
  TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

-- ============================================================================
-- I18N Tenant-Scoped Tables (Referencing tenants)
-- ============================================================================

CREATE TABLE IF NOT EXISTS tenant_localization_settings (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  locale text NOT NULL DEFAULT 'en-US',
  timezone text NOT NULL DEFAULT 'UTC',
  date_format text NOT NULL DEFAULT 'YYYY-MM-DD',
  number_format text NOT NULL DEFAULT '1,234.56',
  currency_display_mode text NOT NULL DEFAULT 'SYMBOL' CHECK (currency_display_mode IN ('SYMBOL', 'ISO_CODE', 'SYMBOL_AND_CODE')),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id)
);

ALTER TABLE tenant_localization_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_localization_settings FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON tenant_localization_settings;
CREATE POLICY tenant_isolation_policy ON tenant_localization_settings
  AS PERMISSIVE
  FOR ALL
  TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

CREATE TABLE IF NOT EXISTS tenant_exchange_rates (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  source_currency char(3) NOT NULL REFERENCES currencies (code),
  target_currency char(3) NOT NULL REFERENCES currencies (code),
  rate numeric(18, 8) NOT NULL CHECK (rate > 0),
  effective_from timestamptz NOT NULL,
  created_by_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS idx_tenant_exchange_rates_lookup
  ON tenant_exchange_rates (tenant_id, source_currency, target_currency, effective_from DESC);

ALTER TABLE tenant_exchange_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_exchange_rates FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON tenant_exchange_rates;
CREATE POLICY tenant_isolation_policy ON tenant_exchange_rates
  AS PERMISSIVE
  FOR ALL
  TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

CREATE TABLE IF NOT EXISTS tax_groups (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  code text NOT NULL,
  name text NOT NULL,
  country_code char(2) NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, code)
);

ALTER TABLE tax_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE tax_groups FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON tax_groups;
CREATE POLICY tenant_isolation_policy ON tax_groups
  AS PERMISSIVE
  FOR ALL
  TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

CREATE TABLE IF NOT EXISTS tax_rates (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  tax_group_id uuid NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  rate_percentage numeric(10, 4) NOT NULL CHECK (rate_percentage >= 0),
  is_compound boolean NOT NULL DEFAULT false,
  priority integer NOT NULL DEFAULT 1,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, tax_group_id, code),
  FOREIGN KEY (tenant_id, tax_group_id) REFERENCES tax_groups (tenant_id, id)
);

ALTER TABLE tax_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE tax_rates FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON tax_rates;
CREATE POLICY tenant_isolation_policy ON tax_rates
  AS PERMISSIVE
  FOR ALL
  TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

-- ============================================================================
-- MODULE 3: SUB (Subscription Plans, Tenant Subscriptions, Invoices, Payments)
-- ============================================================================

CREATE TABLE IF NOT EXISTS subscription_plans (
  id uuid PRIMARY KEY,
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  max_branches integer NOT NULL CHECK (max_branches >= 1),
  max_warehouses integer NOT NULL CHECK (max_warehouses >= 1),
  max_registers integer NOT NULL CHECK (max_registers >= 1),
  max_users integer NOT NULL CHECK (max_users >= 1),
  monthly_price_amount numeric(19, 4) NOT NULL CHECK (monthly_price_amount >= 0),
  currency_code char(3) NOT NULL REFERENCES currencies (code),
  features_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

INSERT INTO subscription_plans (
  id, code, name, max_branches, max_warehouses, max_registers, max_users, monthly_price_amount, currency_code, features_json, is_active
) VALUES
  ('0192b400-0000-7000-8000-000000000001', 'STARTER', 'Starter Plan', 1, 2, 2, 5, '29.0000', 'USD', '{"multiCurrency":false,"batchTracking":false}'::jsonb, true),
  ('0192b400-0000-7000-8000-000000000002', 'GROWTH', 'Growth Plan', 5, 10, 15, 25, '99.0000', 'USD', '{"multiCurrency":true,"batchTracking":true}'::jsonb, true),
  ('0192b400-0000-7000-8000-000000000003', 'ENTERPRISE', 'Enterprise Plan', 100, 200, 500, 1000, '299.0000', 'USD', '{"multiCurrency":true,"batchTracking":true}'::jsonb, true)
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS tenant_subscriptions (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  plan_id uuid NOT NULL REFERENCES subscription_plans (id),
  billing_mode text NOT NULL DEFAULT 'ADMIN_PROVISIONED' CHECK (billing_mode IN ('ADMIN_PROVISIONED', 'EXTERNAL_PROVIDER')),
  provider_code text NOT NULL DEFAULT 'MANUAL_ADMIN' CHECK (provider_code IN ('MANUAL_ADMIN', 'PAYHERE_LK', 'STRIPE', 'PADDLE')),
  status text NOT NULL CHECK (status IN ('TRIALING', 'ACTIVE', 'PAST_DUE', 'GRACE_PERIOD', 'SUSPENDED', 'CANCELLED')),
  trial_ends_at timestamptz,
  current_period_start timestamptz NOT NULL,
  current_period_end timestamptz NOT NULL,
  allow_admin_override boolean NOT NULL DEFAULT false,
  override_reason text,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id)
);

ALTER TABLE tenant_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_subscriptions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON tenant_subscriptions;
CREATE POLICY tenant_isolation_policy ON tenant_subscriptions
  AS PERMISSIVE
  FOR ALL
  TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

CREATE TABLE IF NOT EXISTS subscription_invoices (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  subscription_id uuid NOT NULL,
  invoice_number text NOT NULL,
  currency_code char(3) NOT NULL REFERENCES currencies (code),
  total_amount numeric(19, 4) NOT NULL CHECK (total_amount >= 0),
  amount_paid numeric(19, 4) NOT NULL DEFAULT 0 CHECK (amount_paid >= 0),
  status text NOT NULL CHECK (status IN ('DRAFT', 'OPEN', 'PAID', 'PAST_DUE', 'VOID')),
  due_date date NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, invoice_number),
  FOREIGN KEY (tenant_id, subscription_id) REFERENCES tenant_subscriptions (tenant_id, id)
);

ALTER TABLE subscription_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription_invoices FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON subscription_invoices;
CREATE POLICY tenant_isolation_policy ON subscription_invoices
  AS PERMISSIVE
  FOR ALL
  TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

CREATE TABLE IF NOT EXISTS subscription_payments (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  subscription_invoice_id uuid NOT NULL,
  currency_code char(3) NOT NULL REFERENCES currencies (code),
  amount numeric(19, 4) NOT NULL CHECK (amount > 0),
  payment_method text NOT NULL CHECK (payment_method IN ('BANK_TRANSFER', 'MANUAL_RECEIPT', 'CHEQUE', 'EXTERNAL_GATEWAY_REF')),
  reference_number text NOT NULL,
  recorded_by_user_id uuid NOT NULL,
  paid_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, subscription_invoice_id) REFERENCES subscription_invoices (tenant_id, id)
);

ALTER TABLE subscription_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription_payments FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON subscription_payments;
CREATE POLICY tenant_isolation_policy ON subscription_payments
  AS PERMISSIVE
  FOR ALL
  TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

-- ============================================================================
-- MODULE 4: IAM (Users, Memberships, Roles, Permissions, Location Scopes)
-- ============================================================================

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE,
  full_name text NOT NULL,
  is_platform_admin boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS tenant_memberships (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  user_id uuid NOT NULL REFERENCES users (id),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('INVITED', 'ACTIVE', 'DISABLED')),
  all_locations_access boolean NOT NULL DEFAULT false,
  pin_hash text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, user_id)
);

ALTER TABLE tenant_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_memberships FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON tenant_memberships;
CREATE POLICY tenant_isolation_policy ON tenant_memberships
  AS PERMISSIVE
  FOR ALL
  TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

CREATE TABLE IF NOT EXISTS roles (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  code text NOT NULL,
  name text NOT NULL,
  is_system_role boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, code)
);

ALTER TABLE roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE roles FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON roles;
CREATE POLICY tenant_isolation_policy ON roles
  AS PERMISSIVE
  FOR ALL
  TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

CREATE TABLE IF NOT EXISTS role_permissions (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  role_id uuid NOT NULL,
  permission_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, role_id, permission_key),
  FOREIGN KEY (tenant_id, role_id) REFERENCES roles (tenant_id, id)
);

ALTER TABLE role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_permissions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON role_permissions;
CREATE POLICY tenant_isolation_policy ON role_permissions
  AS PERMISSIVE
  FOR ALL
  TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

CREATE TABLE IF NOT EXISTS member_role_assignments (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  role_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, membership_id, role_id),
  FOREIGN KEY (tenant_id, membership_id) REFERENCES tenant_memberships (tenant_id, id),
  FOREIGN KEY (tenant_id, role_id) REFERENCES roles (tenant_id, id)
);

ALTER TABLE member_role_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE member_role_assignments FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON member_role_assignments;
CREATE POLICY tenant_isolation_policy ON member_role_assignments
  AS PERMISSIVE
  FOR ALL
  TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

CREATE TABLE IF NOT EXISTS member_location_scopes (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  branch_id uuid,
  warehouse_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, membership_id) REFERENCES tenant_memberships (tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id),
  FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouses (tenant_id, id),
  CHECK (branch_id IS NOT NULL OR warehouse_id IS NOT NULL)
);

ALTER TABLE member_location_scopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE member_location_scopes FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON member_location_scopes;
CREATE POLICY tenant_isolation_policy ON member_location_scopes
  AS PERMISSIVE
  FOR ALL
  TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

CREATE TABLE IF NOT EXISTS supervisor_override_logs (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  actor_user_id uuid NOT NULL,
  supervisor_user_id uuid NOT NULL,
  permission_key text NOT NULL,
  action_description text NOT NULL,
  resource_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id)
);

DROP TRIGGER IF EXISTS supervisor_override_logs_immutable_trg ON supervisor_override_logs;
CREATE TRIGGER supervisor_override_logs_immutable_trg
  BEFORE UPDATE OR DELETE ON supervisor_override_logs
  FOR EACH ROW
  EXECUTE FUNCTION prevent_immutable_row_mutation();

ALTER TABLE supervisor_override_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE supervisor_override_logs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON supervisor_override_logs;
CREATE POLICY tenant_isolation_policy ON supervisor_override_logs
  AS PERMISSIVE
  FOR ALL
  TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

-- ============================================================================
-- Least-Privilege Grants to Runtime Role (`nexstock_app_user`)
-- ============================================================================

GRANT SELECT ON TABLE currencies TO nexstock_app_user;
GRANT SELECT, INSERT, UPDATE ON TABLE subscription_plans TO nexstock_app_user;
GRANT SELECT, INSERT, UPDATE ON TABLE tenants TO nexstock_app_user;
GRANT SELECT, INSERT, UPDATE ON TABLE branches TO nexstock_app_user;
GRANT SELECT, INSERT, UPDATE ON TABLE warehouses TO nexstock_app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE branch_warehouse_links TO nexstock_app_user;
GRANT SELECT, INSERT, UPDATE ON TABLE pos_registers TO nexstock_app_user;
GRANT SELECT, INSERT, UPDATE ON TABLE tenant_localization_settings TO nexstock_app_user;
GRANT SELECT, INSERT ON TABLE tenant_exchange_rates TO nexstock_app_user;
GRANT SELECT, INSERT, UPDATE ON TABLE tax_groups TO nexstock_app_user;
GRANT SELECT, INSERT, UPDATE ON TABLE tax_rates TO nexstock_app_user;
GRANT SELECT, INSERT, UPDATE ON TABLE tenant_subscriptions TO nexstock_app_user;
GRANT SELECT, INSERT, UPDATE ON TABLE subscription_invoices TO nexstock_app_user;
GRANT SELECT, INSERT ON TABLE subscription_payments TO nexstock_app_user;
GRANT SELECT, INSERT, UPDATE ON TABLE users TO nexstock_app_user;
GRANT SELECT, INSERT, UPDATE ON TABLE tenant_memberships TO nexstock_app_user;
GRANT SELECT, INSERT, UPDATE ON TABLE roles TO nexstock_app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE role_permissions TO nexstock_app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE member_role_assignments TO nexstock_app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE member_location_scopes TO nexstock_app_user;
GRANT SELECT, INSERT ON TABLE supervisor_override_logs TO nexstock_app_user;

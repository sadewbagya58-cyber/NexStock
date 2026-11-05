-- ============================================================================
-- NexStock — Migration 0019: Phase 7.4 Customer Credit Management System
-- Modules: CUSTOMERS / CREDIT ACCOUNTS / CREDIT LEDGER / PAYMENTS & ALLOCATIONS
--          INTEREST & LATE FEES / COLLECTIONS & WRITEOFFS / CREDIT NOTES
-- ============================================================================

-- 0. Update sales_payments check constraint to support CREDIT, BANK_TRANSFER, CHEQUE
ALTER TABLE sales_payments DROP CONSTRAINT IF EXISTS sales_payments_payment_method_check;
ALTER TABLE sales_payments ADD CONSTRAINT sales_payments_payment_method_check
  CHECK (payment_method IN ('CASH', 'CARD', 'OTHER', 'CREDIT', 'BANK_TRANSFER', 'CHEQUE'));

-- 1. Customers Table (Master Customer Registry)
CREATE TABLE IF NOT EXISTS customers (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  customer_number text NOT NULL,
  name text NOT NULL,
  email text,
  phone text,
  address text,
  tax_id text,
  notes text,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE', 'ARCHIVED')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_customers_tenant_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_customers_tenant_number UNIQUE (tenant_id, customer_number)
);

CREATE INDEX IF NOT EXISTS idx_customers_tenant_name ON customers (tenant_id, name);
CREATE INDEX IF NOT EXISTS idx_customers_tenant_phone ON customers (tenant_id, phone);

ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON customers;
CREATE POLICY tenant_isolation_policy ON customers
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE customers TO nexstock_app_user;

-- 2. Customer Credit Settings Table (Organization Policy)
CREATE TABLE IF NOT EXISTS customer_credit_settings (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  default_credit_limit numeric(19, 4) NOT NULL DEFAULT 50000.0000 CHECK (default_credit_limit >= 0),
  default_credit_terms text NOT NULL DEFAULT 'NET_30'
    CHECK (default_credit_terms IN ('IMMEDIATE', 'NET_7', 'NET_14', 'NET_30', 'NET_60', 'NET_90', 'CUSTOM')),
  default_custom_days integer DEFAULT 30 CHECK (default_custom_days IS NULL OR default_custom_days >= 0),
  approval_policy text NOT NULL DEFAULT 'AUTO_WITHIN_LIMIT'
    CHECK (approval_policy IN ('AUTO_WITHIN_LIMIT', 'ALWAYS_REQUIRE_APPROVAL', 'THRESHOLD_REQUIRED', 'OVERRIDE_ONLY')),
  approval_threshold_amount numeric(19, 4) NOT NULL DEFAULT 100000.0000 CHECK (approval_threshold_amount >= 0),
  require_approval_for_overrides boolean NOT NULL DEFAULT true,
  require_approval_for_adjustments boolean NOT NULL DEFAULT true,
  interest_enabled boolean NOT NULL DEFAULT false,
  interest_calculation_mode text NOT NULL DEFAULT 'MONTHLY'
    CHECK (interest_calculation_mode IN ('DAILY', 'MONTHLY', 'ANNUAL', 'FIXED')),
  interest_rate_percentage numeric(8, 4) NOT NULL DEFAULT 2.0000 CHECK (interest_rate_percentage >= 0),
  interest_grace_period_days integer NOT NULL DEFAULT 5 CHECK (interest_grace_period_days >= 0),
  compounding_enabled boolean NOT NULL DEFAULT false,
  late_fee_enabled boolean NOT NULL DEFAULT false,
  late_fee_type text NOT NULL DEFAULT 'FIXED'
    CHECK (late_fee_type IN ('FIXED', 'PERCENTAGE', 'PER_DAY')),
  late_fee_amount numeric(19, 4) NOT NULL DEFAULT 500.0000 CHECK (late_fee_amount >= 0),
  late_fee_percentage numeric(8, 4) NOT NULL DEFAULT 1.0000 CHECK (late_fee_percentage >= 0),
  late_fee_grace_period_days integer NOT NULL DEFAULT 7 CHECK (late_fee_grace_period_days >= 0),
  late_fee_max_amount numeric(19, 4) NOT NULL DEFAULT 5000.0000 CHECK (late_fee_max_amount >= 0),
  auto_hold_enabled boolean NOT NULL DEFAULT true,
  auto_hold_max_overdue_days integer NOT NULL DEFAULT 60 CHECK (auto_hold_max_overdue_days >= 0),
  auto_hold_max_overdue_amount numeric(19, 4) NOT NULL DEFAULT 50000.0000 CHECK (auto_hold_max_overdue_amount >= 0),
  auto_hold_utilization_threshold numeric(5, 2) NOT NULL DEFAULT 100.00 CHECK (auto_hold_utilization_threshold >= 0),
  currency_code text NOT NULL DEFAULT 'LKR' CHECK (currency_code = 'LKR'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_credit_settings_tenant UNIQUE (tenant_id)
);

ALTER TABLE customer_credit_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_credit_settings FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON customer_credit_settings;
CREATE POLICY tenant_isolation_policy ON customer_credit_settings
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE customer_credit_settings TO nexstock_app_user;

-- 3. Customer Credit Accounts Table
CREATE TABLE IF NOT EXISTS customer_credit_accounts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  customer_id uuid NOT NULL,
  account_number text NOT NULL,
  credit_limit numeric(19, 4) NOT NULL DEFAULT 0.0000 CHECK (credit_limit >= 0),
  current_balance numeric(19, 4) NOT NULL DEFAULT 0.0000 CHECK (current_balance >= 0),
  available_credit numeric(19, 4) NOT NULL DEFAULT 0.0000 CHECK (available_credit >= 0),
  total_credit_sales numeric(19, 4) NOT NULL DEFAULT 0.0000 CHECK (total_credit_sales >= 0),
  total_payments numeric(19, 4) NOT NULL DEFAULT 0.0000 CHECK (total_payments >= 0),
  total_interest_charged numeric(19, 4) NOT NULL DEFAULT 0.0000 CHECK (total_interest_charged >= 0),
  total_late_fees numeric(19, 4) NOT NULL DEFAULT 0.0000 CHECK (total_late_fees >= 0),
  total_written_off numeric(19, 4) NOT NULL DEFAULT 0.0000 CHECK (total_written_off >= 0),
  unallocated_payment_balance numeric(19, 4) NOT NULL DEFAULT 0.0000 CHECK (unallocated_payment_balance >= 0),
  credit_terms text NOT NULL DEFAULT 'NET_30'
    CHECK (credit_terms IN ('IMMEDIATE', 'NET_7', 'NET_14', 'NET_30', 'NET_60', 'NET_90', 'CUSTOM')),
  custom_term_days integer CHECK (custom_term_days IS NULL OR custom_term_days >= 0),
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'ON_HOLD', 'SUSPENDED', 'BLOCKED', 'CLOSED')),
  hold_reason text,
  held_at timestamptz,
  held_by_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  risk_classification text NOT NULL DEFAULT 'LOW_RISK'
    CHECK (risk_classification IN ('LOW_RISK', 'MEDIUM_RISK', 'HIGH_RISK', 'CRITICAL_RISK')),
  branch_id uuid,
  currency_code text NOT NULL DEFAULT 'LKR' CHECK (currency_code = 'LKR'),
  opened_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  closed_at timestamptz,
  closed_by_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  created_by_user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_credit_accounts_tenant_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_credit_accounts_tenant_number UNIQUE (tenant_id, account_number),
  CONSTRAINT uq_credit_accounts_tenant_customer UNIQUE (tenant_id, customer_id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_credit_accounts_tenant_status ON customer_credit_accounts (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_credit_accounts_tenant_risk ON customer_credit_accounts (tenant_id, risk_classification);

ALTER TABLE customer_credit_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_credit_accounts FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON customer_credit_accounts;
CREATE POLICY tenant_isolation_policy ON customer_credit_accounts
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE customer_credit_accounts TO nexstock_app_user;

-- 4. Customer Credit Limit History Table
CREATE TABLE IF NOT EXISTS customer_credit_limit_history (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  account_id uuid NOT NULL,
  previous_limit numeric(19, 4) NOT NULL,
  new_limit numeric(19, 4) NOT NULL,
  change_type text NOT NULL
    CHECK (change_type IN ('INITIAL', 'INCREASE', 'DECREASE', 'TEMPORARY_OVERRIDE', 'RESTORE')),
  reason text NOT NULL,
  effective_date date NOT NULL DEFAULT CURRENT_DATE,
  expiry_date date,
  requested_by_user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  approved_by_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  approval_status text NOT NULL DEFAULT 'APPROVED'
    CHECK (approval_status IN ('PENDING', 'APPROVED', 'REJECTED')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, account_id) REFERENCES customer_credit_accounts (tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_credit_limit_history_account ON customer_credit_limit_history (tenant_id, account_id, created_at DESC);

ALTER TABLE customer_credit_limit_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_credit_limit_history FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON customer_credit_limit_history;
CREATE POLICY tenant_isolation_policy ON customer_credit_limit_history
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE customer_credit_limit_history TO nexstock_app_user;

-- 5. Customer Credit Ledger Transactions Table (Single Source of Truth)
CREATE TABLE IF NOT EXISTS customer_credit_transactions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  account_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  branch_id uuid,
  transaction_reference text NOT NULL,
  transaction_type text NOT NULL CHECK (transaction_type IN (
    'OPENING_BALANCE', 'CREDIT_SALE', 'PAYMENT', 'SALES_RETURN',
    'CREDIT_NOTE', 'DEBIT_NOTE', 'INTEREST_CHARGE', 'LATE_FEE',
    'ADJUSTMENT_DEBIT', 'ADJUSTMENT_CREDIT', 'PAYMENT_REVERSAL',
    'CREDIT_REVERSAL', 'WRITE_OFF', 'ADVANCE_PAYMENT'
  )),
  entry_direction text NOT NULL CHECK (entry_direction IN ('DEBIT', 'CREDIT')),
  amount numeric(19, 4) NOT NULL CHECK (amount > 0),
  currency_code text NOT NULL DEFAULT 'LKR' CHECK (currency_code = 'LKR'),
  balance_after numeric(19, 4) NOT NULL CHECK (balance_after >= 0),
  unpaid_amount numeric(19, 4) NOT NULL DEFAULT 0.0000 CHECK (unpaid_amount >= 0),
  transaction_date date NOT NULL DEFAULT CURRENT_DATE,
  posting_date timestamptz NOT NULL DEFAULT clock_timestamp(),
  due_date date,
  source_reference_type text NOT NULL,
  source_reference_id uuid,
  source_reference_number text,
  description text NOT NULL,
  created_by_user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  approval_id uuid,
  reversal_of_transaction_id uuid,
  is_reversed boolean NOT NULL DEFAULT false,
  reversed_at timestamptz,
  reversed_by_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_credit_transactions_tenant_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_credit_transactions_tenant_ref UNIQUE (tenant_id, transaction_reference),
  FOREIGN KEY (tenant_id, account_id) REFERENCES customer_credit_accounts (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_credit_tx_tenant_account ON customer_credit_transactions (tenant_id, account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_credit_tx_tenant_type ON customer_credit_transactions (tenant_id, transaction_type);
CREATE INDEX IF NOT EXISTS idx_credit_tx_tenant_posting ON customer_credit_transactions (tenant_id, posting_date DESC);
CREATE INDEX IF NOT EXISTS idx_credit_tx_tenant_due ON customer_credit_transactions (tenant_id, due_date) WHERE unpaid_amount > 0;

ALTER TABLE customer_credit_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_credit_transactions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON customer_credit_transactions;
CREATE POLICY tenant_isolation_policy ON customer_credit_transactions
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE customer_credit_transactions TO nexstock_app_user;

-- Ledger Hard-Delete Guard Trigger
DROP TRIGGER IF EXISTS trg_prevent_hard_delete_credit_transactions ON customer_credit_transactions;
CREATE TRIGGER trg_prevent_hard_delete_credit_transactions
  BEFORE DELETE ON customer_credit_transactions
  FOR EACH ROW
  EXECUTE FUNCTION prevent_sales_record_hard_delete();

-- 6. Customer Credit Payments Table
CREATE TABLE IF NOT EXISTS customer_credit_payments (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  account_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  payment_reference text NOT NULL,
  receipt_number text NOT NULL,
  amount numeric(19, 4) NOT NULL CHECK (amount > 0),
  allocated_amount numeric(19, 4) NOT NULL DEFAULT 0.0000 CHECK (allocated_amount >= 0),
  unallocated_amount numeric(19, 4) NOT NULL DEFAULT 0.0000 CHECK (unallocated_amount >= 0),
  currency_code text NOT NULL DEFAULT 'LKR' CHECK (currency_code = 'LKR'),
  payment_date date NOT NULL DEFAULT CURRENT_DATE,
  payment_method text NOT NULL
    CHECK (payment_method IN ('CASH', 'BANK_TRANSFER', 'CARD', 'CHEQUE', 'OTHER')),
  external_reference text,
  branch_id uuid,
  received_by_user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'COMPLETED'
    CHECK (status IN ('COMPLETED', 'REVERSED')),
  reversal_reason text,
  reversed_at timestamptz,
  reversed_by_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  notes text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_credit_payments_tenant_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_credit_payments_tenant_ref UNIQUE (tenant_id, payment_reference),
  CONSTRAINT uq_credit_payments_tenant_rcp UNIQUE (tenant_id, receipt_number),
  FOREIGN KEY (tenant_id, account_id) REFERENCES customer_credit_accounts (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_credit_payments_tenant_account ON customer_credit_payments (tenant_id, account_id, payment_date DESC);

ALTER TABLE customer_credit_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_credit_payments FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON customer_credit_payments;
CREATE POLICY tenant_isolation_policy ON customer_credit_payments
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE customer_credit_payments TO nexstock_app_user;

DROP TRIGGER IF EXISTS trg_prevent_hard_delete_credit_payments ON customer_credit_payments;
CREATE TRIGGER trg_prevent_hard_delete_credit_payments
  BEFORE DELETE ON customer_credit_payments
  FOR EACH ROW
  EXECUTE FUNCTION prevent_sales_record_hard_delete();

-- 7. Customer Credit Allocations Table
CREATE TABLE IF NOT EXISTS customer_credit_allocations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  payment_id uuid NOT NULL,
  invoice_id uuid,
  transaction_id uuid NOT NULL,
  amount numeric(19, 4) NOT NULL CHECK (amount > 0),
  allocated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  allocated_by_user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'REVERSED')),
  reversal_reason text,
  reversed_at timestamptz,
  reversed_by_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  FOREIGN KEY (tenant_id, payment_id) REFERENCES customer_credit_payments (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, transaction_id) REFERENCES customer_credit_transactions (tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_credit_alloc_payment ON customer_credit_allocations (tenant_id, payment_id);
CREATE INDEX IF NOT EXISTS idx_credit_alloc_transaction ON customer_credit_allocations (tenant_id, transaction_id);

ALTER TABLE customer_credit_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_credit_allocations FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON customer_credit_allocations;
CREATE POLICY tenant_isolation_policy ON customer_credit_allocations
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE customer_credit_allocations TO nexstock_app_user;

-- 8. Customer Credit Approvals Table
CREATE TABLE IF NOT EXISTS customer_credit_approvals (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  approval_type text NOT NULL
    CHECK (approval_type IN ('CREDIT_SALE', 'LIMIT_CHANGE', 'LIMIT_OVERRIDE', 'MANUAL_ADJUSTMENT', 'INTEREST_WAIVER', 'WRITE_OFF')),
  reference_id uuid,
  account_id uuid NOT NULL,
  requested_by_user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  approved_by_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
  requested_amount numeric(19, 4),
  reason text NOT NULL,
  rejection_reason text,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, account_id) REFERENCES customer_credit_accounts (tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_credit_approvals_tenant_status ON customer_credit_approvals (tenant_id, status);

ALTER TABLE customer_credit_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_credit_approvals FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON customer_credit_approvals;
CREATE POLICY tenant_isolation_policy ON customer_credit_approvals
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE customer_credit_approvals TO nexstock_app_user;

-- 9. Customer Credit Interest Entries Table
CREATE TABLE IF NOT EXISTS customer_credit_interest_entries (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  account_id uuid NOT NULL,
  transaction_id uuid,
  source_invoice_id uuid,
  calculation_period_start date NOT NULL,
  calculation_period_end date NOT NULL,
  eligible_principal numeric(19, 4) NOT NULL CHECK (eligible_principal >= 0),
  rate_percentage numeric(8, 4) NOT NULL,
  calculation_mode text NOT NULL,
  calculated_amount numeric(19, 4) NOT NULL CHECK (calculated_amount >= 0),
  status text NOT NULL DEFAULT 'POSTED'
    CHECK (status IN ('POSTED', 'WAIVED', 'REVERSED')),
  waiver_reason text,
  waived_by_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  waived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, account_id) REFERENCES customer_credit_accounts (tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_credit_interest_account ON customer_credit_interest_entries (tenant_id, account_id, calculation_period_end DESC);

ALTER TABLE customer_credit_interest_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_credit_interest_entries FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON customer_credit_interest_entries;
CREATE POLICY tenant_isolation_policy ON customer_credit_interest_entries
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE customer_credit_interest_entries TO nexstock_app_user;

-- 10. Customer Credit Late Fee Entries Table
CREATE TABLE IF NOT EXISTS customer_credit_late_fee_entries (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  account_id uuid NOT NULL,
  transaction_id uuid,
  source_invoice_id uuid,
  fee_type text NOT NULL,
  overdue_days integer NOT NULL,
  fee_amount numeric(19, 4) NOT NULL CHECK (fee_amount >= 0),
  status text NOT NULL DEFAULT 'POSTED'
    CHECK (status IN ('POSTED', 'WAIVED', 'REVERSED')),
  waiver_reason text,
  waived_by_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  waived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, account_id) REFERENCES customer_credit_accounts (tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_credit_late_fees_account ON customer_credit_late_fee_entries (tenant_id, account_id, created_at DESC);

ALTER TABLE customer_credit_late_fee_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_credit_late_fee_entries FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON customer_credit_late_fee_entries;
CREATE POLICY tenant_isolation_policy ON customer_credit_late_fee_entries
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE customer_credit_late_fee_entries TO nexstock_app_user;

-- 11. Customer Credit Collections Table
CREATE TABLE IF NOT EXISTS customer_credit_collections (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  account_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  follow_up_date date NOT NULL DEFAULT CURRENT_DATE,
  collector_user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  contact_method text NOT NULL
    CHECK (contact_method IN ('PHONE', 'VISIT', 'EMAIL', 'MESSAGE', 'OTHER')),
  contact_person text,
  notes text NOT NULL,
  promise_to_pay_date date,
  promise_amount numeric(19, 4),
  outcome text NOT NULL
    CHECK (outcome IN ('PROMISED_TO_PAY', 'DISPUTED', 'UNREACHABLE', 'REFUSED', 'FOLLOW_UP_REQUIRED', 'PAID', 'OTHER')),
  next_follow_up_date date,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, account_id) REFERENCES customer_credit_accounts (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_credit_collections_account ON customer_credit_collections (tenant_id, account_id, follow_up_date DESC);
CREATE INDEX IF NOT EXISTS idx_credit_collections_promise ON customer_credit_collections (tenant_id, promise_to_pay_date) WHERE promise_to_pay_date IS NOT NULL;

ALTER TABLE customer_credit_collections ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_credit_collections FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON customer_credit_collections;
CREATE POLICY tenant_isolation_policy ON customer_credit_collections
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE customer_credit_collections TO nexstock_app_user;

-- 12. Customer Credit Write-offs Table
CREATE TABLE IF NOT EXISTS customer_credit_writeoffs (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  account_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  transaction_id uuid NOT NULL,
  original_outstanding numeric(19, 4) NOT NULL,
  writeoff_amount numeric(19, 4) NOT NULL CHECK (writeoff_amount > 0),
  remaining_balance numeric(19, 4) NOT NULL CHECK (remaining_balance >= 0),
  reason text NOT NULL,
  supporting_notes text,
  approved_by_user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, account_id) REFERENCES customer_credit_accounts (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, transaction_id) REFERENCES customer_credit_transactions (tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_credit_writeoffs_account ON customer_credit_writeoffs (tenant_id, account_id);

ALTER TABLE customer_credit_writeoffs ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_credit_writeoffs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON customer_credit_writeoffs;
CREATE POLICY tenant_isolation_policy ON customer_credit_writeoffs
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE customer_credit_writeoffs TO nexstock_app_user;

-- 13. Customer Credit Notes Table
CREATE TABLE IF NOT EXISTS customer_credit_notes (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  account_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  transaction_id uuid NOT NULL,
  note_number text NOT NULL,
  note_type text NOT NULL
    CHECK (note_type IN ('CREDIT_NOTE', 'DEBIT_NOTE', 'ADJUSTMENT')),
  amount numeric(19, 4) NOT NULL CHECK (amount > 0),
  reason text NOT NULL,
  reference_invoice_id uuid,
  approved_by_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  created_by_user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_credit_notes_tenant_number UNIQUE (tenant_id, note_number),
  FOREIGN KEY (tenant_id, account_id) REFERENCES customer_credit_accounts (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, transaction_id) REFERENCES customer_credit_transactions (tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_credit_notes_account ON customer_credit_notes (tenant_id, account_id);

ALTER TABLE customer_credit_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_credit_notes FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON customer_credit_notes;
CREATE POLICY tenant_isolation_policy ON customer_credit_notes
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE customer_credit_notes TO nexstock_app_user;

-- 14. Record completion of Migration 0019
INSERT INTO schema_migrations (version, name, filename)
VALUES (19, '0019_phase74_customer_credit', '0019_phase74_customer_credit.sql')
ON CONFLICT (version) DO UPDATE
  SET applied_at = clock_timestamp(),
      applied_by = current_user;

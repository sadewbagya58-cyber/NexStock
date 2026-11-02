-- ============================================================================
-- NexStock — Migration 0014: Phase 7.1 Employee Management & Flexible Payroll
-- Modules: HRM / PAYROLL / DOCUMENTS / SALARY
-- ============================================================================

-- 1. Employees Table
CREATE TABLE IF NOT EXISTS employees (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  employee_code text NOT NULL,
  first_name text NOT NULL,
  last_name text NOT NULL,
  display_name text NOT NULL,
  email text,
  phone text,
  national_id text,
  gender text,
  date_of_birth date,
  joined_date date NOT NULL,
  designation text NOT NULL,
  department text NOT NULL,
  employment_status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (employment_status IN ('ACTIVE', 'PROBATION', 'INACTIVE', 'SUSPENDED', 'TERMINATED')),
  payroll_frequency text NOT NULL DEFAULT 'MONTHLY'
    CHECK (payroll_frequency IN ('MONTHLY', 'WEEKLY', 'DAILY')),
  primary_branch_id uuid,
  primary_warehouse_id uuid,
  linked_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  avatar_url text,
  bank_name text,
  bank_account_number text,
  bank_branch text,
  epf_number text,
  address_line1 text,
  address_line2 text,
  city text,
  emergency_contact_name text,
  emergency_contact_phone text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_employees_tenant_code UNIQUE (tenant_id, employee_code),
  FOREIGN KEY (tenant_id, primary_branch_id) REFERENCES branches (tenant_id, id) ON DELETE SET NULL,
  FOREIGN KEY (tenant_id, primary_warehouse_id) REFERENCES warehouses (tenant_id, id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_employees_tenant_status
  ON employees (tenant_id, employment_status);
CREATE INDEX IF NOT EXISTS idx_employees_tenant_branch
  ON employees (tenant_id, primary_branch_id);
CREATE INDEX IF NOT EXISTS idx_employees_tenant_user
  ON employees (tenant_id, linked_user_id);

ALTER TABLE employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE employees FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON employees;
CREATE POLICY tenant_isolation_policy ON employees
  AS PERMISSIVE FOR ALL TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE employees TO nexstock_app_user;

-- 2. Employee Branch Assignments Table
CREATE TABLE IF NOT EXISTS employee_branch_assignments (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
  branch_id uuid NOT NULL,
  is_primary boolean NOT NULL DEFAULT false,
  assigned_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_employee_branch UNIQUE (tenant_id, employee_id, branch_id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_employee_branch_tenant_emp
  ON employee_branch_assignments (tenant_id, employee_id);

ALTER TABLE employee_branch_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_branch_assignments FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON employee_branch_assignments;
CREATE POLICY tenant_isolation_policy ON employee_branch_assignments
  AS PERMISSIVE FOR ALL TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE employee_branch_assignments TO nexstock_app_user;

-- 3. Employee Warehouse Assignments Table
CREATE TABLE IF NOT EXISTS employee_warehouse_assignments (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
  warehouse_id uuid NOT NULL,
  is_primary boolean NOT NULL DEFAULT false,
  assigned_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_employee_warehouse UNIQUE (tenant_id, employee_id, warehouse_id),
  FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouses (tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_employee_warehouse_tenant_emp
  ON employee_warehouse_assignments (tenant_id, employee_id);

ALTER TABLE employee_warehouse_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_warehouse_assignments FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON employee_warehouse_assignments;
CREATE POLICY tenant_isolation_policy ON employee_warehouse_assignments
  AS PERMISSIVE FOR ALL TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE employee_warehouse_assignments TO nexstock_app_user;

-- 4. Employee Documents Table
CREATE TABLE IF NOT EXISTS employee_documents (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
  document_category text NOT NULL
    CHECK (document_category IN ('NIC_PASSPORT', 'CONTRACT', 'CERTIFICATE', 'RESUME', 'OTHER')),
  document_title text NOT NULL,
  file_name text NOT NULL,
  file_size integer NOT NULL CHECK (file_size > 0),
  mime_type text NOT NULL,
  storage_path text NOT NULL,
  data_base64 text NOT NULL,
  uploaded_by_user_id uuid NOT NULL REFERENCES users (id),
  notes text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS idx_employee_documents_tenant_emp
  ON employee_documents (tenant_id, employee_id);

ALTER TABLE employee_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_documents FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON employee_documents;
CREATE POLICY tenant_isolation_policy ON employee_documents
  AS PERMISSIVE FOR ALL TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE employee_documents TO nexstock_app_user;

-- 5. Employee Salary Structures Table
CREATE TABLE IF NOT EXISTS employee_salary_structures (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
  effective_from date NOT NULL,
  basic_salary numeric(19, 4) NOT NULL CHECK (basic_salary >= 0),
  currency_code text NOT NULL REFERENCES currencies (code),
  payment_method text NOT NULL DEFAULT 'BANK_TRANSFER'
    CHECK (payment_method IN ('BANK_TRANSFER', 'CASH', 'CHEQUE')),
  is_active boolean NOT NULL DEFAULT true,
  notes text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS idx_salary_structures_tenant_emp
  ON employee_salary_structures (tenant_id, employee_id, is_active);

ALTER TABLE employee_salary_structures ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_salary_structures FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON employee_salary_structures;
CREATE POLICY tenant_isolation_policy ON employee_salary_structures
  AS PERMISSIVE FOR ALL TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE employee_salary_structures TO nexstock_app_user;

-- 6. Employee Salary Components Table
CREATE TABLE IF NOT EXISTS employee_salary_components (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  structure_id uuid NOT NULL REFERENCES employee_salary_structures (id) ON DELETE CASCADE,
  component_type text NOT NULL CHECK (component_type IN ('EARNING', 'DEDUCTION')),
  component_name text NOT NULL,
  calculation_type text NOT NULL CHECK (calculation_type IN ('FIXED_AMOUNT', 'PERCENTAGE_OF_BASIC')),
  component_value numeric(19, 4) NOT NULL CHECK (component_value >= 0),
  is_taxable boolean NOT NULL DEFAULT true,
  is_statutory boolean NOT NULL DEFAULT false,
  is_enabled boolean NOT NULL DEFAULT true
);

CREATE INDEX IF NOT EXISTS idx_salary_components_tenant_structure
  ON employee_salary_components (tenant_id, structure_id);

ALTER TABLE employee_salary_components ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_salary_components FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON employee_salary_components;
CREATE POLICY tenant_isolation_policy ON employee_salary_components
  AS PERMISSIVE FOR ALL TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE employee_salary_components TO nexstock_app_user;

-- 7. Payroll Runs Table
CREATE TABLE IF NOT EXISTS payroll_runs (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  run_number text NOT NULL,
  frequency text NOT NULL CHECK (frequency IN ('MONTHLY', 'WEEKLY', 'DAILY')),
  period_start date NOT NULL,
  period_end date NOT NULL,
  payment_date date NOT NULL,
  currency_code text NOT NULL REFERENCES currencies (code),
  status text NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'PARTIALLY_PAID', 'PAID', 'CANCELLED')),
  total_gross_pay numeric(19, 4) NOT NULL DEFAULT 0.0000,
  total_deductions numeric(19, 4) NOT NULL DEFAULT 0.0000,
  total_net_pay numeric(19, 4) NOT NULL DEFAULT 0.0000,
  total_paid_amount numeric(19, 4) NOT NULL DEFAULT 0.0000,
  employee_count integer NOT NULL DEFAULT 0,
  created_by_user_id uuid NOT NULL REFERENCES users (id),
  approved_by_user_id uuid REFERENCES users (id),
  approved_at timestamptz,
  notes text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_payroll_runs_tenant_number UNIQUE (tenant_id, run_number)
);

CREATE INDEX IF NOT EXISTS idx_payroll_runs_tenant_status
  ON payroll_runs (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_payroll_runs_tenant_freq_period
  ON payroll_runs (tenant_id, frequency, period_start, period_end);

ALTER TABLE payroll_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_runs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON payroll_runs;
CREATE POLICY tenant_isolation_policy ON payroll_runs
  AS PERMISSIVE FOR ALL TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE payroll_runs TO nexstock_app_user;

-- 8. Payroll Items Table
CREATE TABLE IF NOT EXISTS payroll_items (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  payroll_run_id uuid NOT NULL REFERENCES payroll_runs (id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES employees (id) ON DELETE RESTRICT,
  basic_salary numeric(19, 4) NOT NULL DEFAULT 0.0000,
  allowances_total numeric(19, 4) NOT NULL DEFAULT 0.0000,
  overtime_hours numeric(18, 4) NOT NULL DEFAULT 0.0000,
  overtime_pay numeric(19, 4) NOT NULL DEFAULT 0.0000,
  bonus_pay numeric(19, 4) NOT NULL DEFAULT 0.0000,
  commissions_pay numeric(19, 4) NOT NULL DEFAULT 0.0000,
  gross_pay numeric(19, 4) NOT NULL DEFAULT 0.0000,
  deductions_total numeric(19, 4) NOT NULL DEFAULT 0.0000,
  net_pay numeric(19, 4) NOT NULL DEFAULT 0.0000,
  paid_amount numeric(19, 4) NOT NULL DEFAULT 0.0000,
  payment_status text NOT NULL DEFAULT 'UNPAID'
    CHECK (payment_status IN ('UNPAID', 'PARTIALLY_PAID', 'PAID')),
  components_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb,
  notes text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_payroll_items_tenant_run_emp UNIQUE (tenant_id, payroll_run_id, employee_id)
);

CREATE INDEX IF NOT EXISTS idx_payroll_items_tenant_run
  ON payroll_items (tenant_id, payroll_run_id);
CREATE INDEX IF NOT EXISTS idx_payroll_items_tenant_employee
  ON payroll_items (tenant_id, employee_id);

ALTER TABLE payroll_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_items FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON payroll_items;
CREATE POLICY tenant_isolation_policy ON payroll_items
  AS PERMISSIVE FOR ALL TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE payroll_items TO nexstock_app_user;

-- 9. Payroll Payments Table
CREATE TABLE IF NOT EXISTS payroll_payments (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  payroll_run_id uuid NOT NULL REFERENCES payroll_runs (id) ON DELETE RESTRICT,
  payroll_item_id uuid NOT NULL REFERENCES payroll_items (id) ON DELETE RESTRICT,
  employee_id uuid NOT NULL REFERENCES employees (id) ON DELETE RESTRICT,
  payment_method text NOT NULL CHECK (payment_method IN ('CASH', 'BANK_TRANSFER', 'CHEQUE')),
  payment_amount numeric(19, 4) NOT NULL CHECK (payment_amount > 0),
  currency_code text NOT NULL REFERENCES currencies (code),
  payment_date date NOT NULL,
  reference_number text,
  recorded_by_user_id uuid NOT NULL REFERENCES users (id),
  notes text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS idx_payroll_payments_tenant_run
  ON payroll_payments (tenant_id, payroll_run_id);
CREATE INDEX IF NOT EXISTS idx_payroll_payments_tenant_item
  ON payroll_payments (tenant_id, payroll_item_id);
CREATE INDEX IF NOT EXISTS idx_payroll_payments_tenant_employee
  ON payroll_payments (tenant_id, employee_id);

ALTER TABLE payroll_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_payments FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON payroll_payments;
CREATE POLICY tenant_isolation_policy ON payroll_payments
  AS PERMISSIVE FOR ALL TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE payroll_payments TO nexstock_app_user;

-- Record completion of Migration 0014
INSERT INTO schema_migrations (version, name, filename)
VALUES (14, '0014_phase7_employees_and_payroll', '0014_phase7_employees_and_payroll.sql')
ON CONFLICT (version) DO UPDATE
  SET applied_at = clock_timestamp(),
      applied_by = current_user;

-- ============================================================================
-- NexStock — Migration 0018: Phase 7.3 Expenses Management
-- Modules: EXPENSES / CATEGORIES / WORKFLOW / PAYMENTS / ATTACHMENTS
-- ============================================================================

-- 1. Expense Categories Table
CREATE TABLE IF NOT EXISTS expense_categories (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  description text,
  is_active boolean NOT NULL DEFAULT true,
  is_system_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_expense_categories_tenant_code UNIQUE (tenant_id, code)
);

CREATE INDEX IF NOT EXISTS idx_expense_categories_tenant_active
  ON expense_categories (tenant_id, is_active);

ALTER TABLE expense_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE expense_categories FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON expense_categories;
CREATE POLICY tenant_isolation_policy ON expense_categories
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE expense_categories TO nexstock_app_user;

-- 2. Expense Records Table
CREATE TABLE IF NOT EXISTS expenses (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  reference_number text NOT NULL,
  title text NOT NULL,
  description text,
  category_id uuid NOT NULL REFERENCES expense_categories (id) ON DELETE RESTRICT,
  amount numeric(15, 4) NOT NULL CHECK (amount > 0),
  currency_code text NOT NULL,
  expense_date date NOT NULL,
  vendor_payee text,
  payment_method text NOT NULL DEFAULT 'CASH'
    CHECK (payment_method IN ('CASH', 'BANK_TRANSFER', 'CARD', 'CHEQUE', 'OTHER')),
  branch_id uuid,
  status text NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'PAID')),
  rejection_reason text,
  created_by_user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  submitted_at timestamptz,
  submitted_by_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  approved_at timestamptz,
  approved_by_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  rejected_at timestamptz,
  rejected_by_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  paid_at timestamptz,
  paid_by_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  payment_reference text,
  payment_notes text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_expenses_tenant_reference UNIQUE (tenant_id, reference_number),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_expenses_tenant_date
  ON expenses (tenant_id, expense_date DESC);
CREATE INDEX IF NOT EXISTS idx_expenses_tenant_status
  ON expenses (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_expenses_tenant_category
  ON expenses (tenant_id, category_id);
CREATE INDEX IF NOT EXISTS idx_expenses_tenant_branch
  ON expenses (tenant_id, branch_id);

ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE expenses FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON expenses;
CREATE POLICY tenant_isolation_policy ON expenses
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE expenses TO nexstock_app_user;

-- 3. Expense Attachments Table
CREATE TABLE IF NOT EXISTS expense_attachments (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  expense_id uuid NOT NULL REFERENCES expenses (id) ON DELETE CASCADE,
  file_name text NOT NULL,
  file_size_bytes integer NOT NULL CHECK (file_size_bytes > 0 AND file_size_bytes <= 10485760),
  mime_type text NOT NULL,
  storage_path text NOT NULL,
  data_base64 text NOT NULL,
  uploaded_by_user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS idx_expense_attachments_expense
  ON expense_attachments (tenant_id, expense_id);

ALTER TABLE expense_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE expense_attachments FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON expense_attachments;
CREATE POLICY tenant_isolation_policy ON expense_attachments
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE expense_attachments TO nexstock_app_user;

-- 4. Seed Default Expense Categories for Existing Tenants
DO $$
DECLARE
  r_tenant RECORD;
  v_cat RECORD;
BEGIN
  FOR r_tenant IN SELECT id FROM tenants LOOP
    FOR v_cat IN SELECT * FROM (VALUES
      ('RENT', 'Rent', 'Office, warehouse, or store rental expenses'),
      ('ELECTRICITY', 'Electricity & Utilities', 'Power and electricity utility bills'),
      ('WATER', 'Water Supply', 'Water utility charges'),
      ('INTERNET', 'Internet & Telecom', 'Broadband, cellular, and telephone communication bills'),
      ('TRANSPORT', 'Transport & Travel', 'Delivery, freight, fuel, and travel expenses'),
      ('SALARIES_WAGES', 'Salaries & Wages', 'Direct temporary and contract labor payments'),
      ('MAINTENANCE', 'Repairs & Maintenance', 'Equipment and building repair costs'),
      ('OFFICE_SUPPLIES', 'Office Supplies', 'Stationery, packaging, and consumable materials'),
      ('MARKETING', 'Advertising & Marketing', 'Promotional campaigns, branding, and ads'),
      ('OTHER_EXPENSES', 'Other Expenses', 'Miscellaneous operating expenses')
    ) AS t(code, name, description)
    LOOP
      INSERT INTO expense_categories (id, tenant_id, code, name, description, is_active, is_system_default)
      VALUES (gen_random_uuid(), r_tenant.id, v_cat.code, v_cat.name, v_cat.description, true, true)
      ON CONFLICT (tenant_id, code) DO NOTHING;
    END LOOP;
  END LOOP;
END $$;

-- 5. Record completion of Migration 0018
INSERT INTO schema_migrations (version, name, filename)
VALUES (18, '0018_phase73_expenses_management', '0018_phase73_expenses_management.sql')
ON CONFLICT (version) DO UPDATE
  SET applied_at = clock_timestamp(),
      applied_by = current_user;

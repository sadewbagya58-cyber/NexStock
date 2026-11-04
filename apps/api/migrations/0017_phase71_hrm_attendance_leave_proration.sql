-- ============================================================================
-- NexStock — Migration 0017: Phase 7.1 Attendance, Leave, Work Schedules, Holidays & Proration
-- Modules: HRM / ATTENDANCE / LEAVE / SCHEDULES / HOLIDAYS / PAYROLL_SETTINGS (BUG-049, BUG-051)
-- ============================================================================

-- 1. Extend Employees Table with Address District, Postal Code, and Leaving Date (BUG-049)
ALTER TABLE employees ADD COLUMN IF NOT EXISTS district text;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS postal_code text;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS leaving_date date;

-- 2. Extend Payroll Items Table with Calculation Breakdown JSON
ALTER TABLE payroll_items ADD COLUMN IF NOT EXISTS calculation_breakdown jsonb NOT NULL DEFAULT '{}'::jsonb;

-- 3. Extend Employee Salary Components Table with Proration Rule
ALTER TABLE employee_salary_components ADD COLUMN IF NOT EXISTS proration_rule text NOT NULL DEFAULT 'PRORATE'
  CHECK (proration_rule IN ('PRORATE', 'FULL'));

-- 4. Employee Work Schedules Table
CREATE TABLE IF NOT EXISTS employee_work_schedules (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
  shift_name text NOT NULL DEFAULT 'General Shift',
  shift_type text NOT NULL DEFAULT 'DAY'
    CHECK (shift_type IN ('DAY', 'NIGHT', 'ROTATING')),
  shift_start_time text NOT NULL DEFAULT '09:00',
  shift_end_time text NOT NULL DEFAULT '17:00',
  break_duration_minutes integer NOT NULL DEFAULT 60 CHECK (break_duration_minutes >= 0),
  monday_working boolean NOT NULL DEFAULT true,
  tuesday_working boolean NOT NULL DEFAULT true,
  wednesday_working boolean NOT NULL DEFAULT true,
  thursday_working boolean NOT NULL DEFAULT true,
  friday_working boolean NOT NULL DEFAULT true,
  saturday_working boolean NOT NULL DEFAULT false,
  sunday_working boolean NOT NULL DEFAULT false,
  effective_from date NOT NULL,
  effective_to date,
  is_active boolean NOT NULL DEFAULT true,
  notes text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS idx_work_schedules_tenant_emp
  ON employee_work_schedules (tenant_id, employee_id, effective_from);

ALTER TABLE employee_work_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_work_schedules FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON employee_work_schedules;
CREATE POLICY tenant_isolation_policy ON employee_work_schedules
  AS PERMISSIVE FOR ALL TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE employee_work_schedules TO nexstock_app_user;

-- 5. Employee Attendance Table
CREATE TABLE IF NOT EXISTS employee_attendance (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
  attendance_date date NOT NULL,
  check_in_time timestamptz,
  check_out_time timestamptz,
  status text NOT NULL DEFAULT 'PRESENT'
    CHECK (status IN ('PRESENT', 'ABSENT', 'LATE', 'HALF_DAY', 'PAID_LEAVE', 'NO_PAY_LEAVE', 'WEEKLY_OFF', 'PUBLIC_HOLIDAY')),
  latitude numeric(10, 7),
  longitude numeric(10, 7),
  gps_verified boolean NOT NULL DEFAULT false,
  notes text,
  is_manual boolean NOT NULL DEFAULT false,
  adjustment_reason text,
  adjusted_by_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_attendance_emp_date UNIQUE (tenant_id, employee_id, attendance_date)
);

CREATE INDEX IF NOT EXISTS idx_attendance_tenant_emp_date
  ON employee_attendance (tenant_id, employee_id, attendance_date);
CREATE INDEX IF NOT EXISTS idx_attendance_tenant_date
  ON employee_attendance (tenant_id, attendance_date);

ALTER TABLE employee_attendance ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_attendance FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON employee_attendance;
CREATE POLICY tenant_isolation_policy ON employee_attendance
  AS PERMISSIVE FOR ALL TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE employee_attendance TO nexstock_app_user;

-- 6. Employee Leave Requests Table
CREATE TABLE IF NOT EXISTS employee_leave_requests (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
  leave_type text NOT NULL
    CHECK (leave_type IN ('ANNUAL', 'CASUAL', 'SICK', 'NO_PAY', 'HALF_DAY', 'SPECIAL')),
  start_date date NOT NULL,
  end_date date NOT NULL,
  days_count numeric(5, 2) NOT NULL CHECK (days_count > 0),
  is_half_day boolean NOT NULL DEFAULT false,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED')),
  requested_by_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  reviewed_by_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  review_notes text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS idx_leave_requests_tenant_emp
  ON employee_leave_requests (tenant_id, employee_id, status);
CREATE INDEX IF NOT EXISTS idx_leave_requests_tenant_status
  ON employee_leave_requests (tenant_id, status);

ALTER TABLE employee_leave_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_leave_requests FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON employee_leave_requests;
CREATE POLICY tenant_isolation_policy ON employee_leave_requests
  AS PERMISSIVE FOR ALL TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE employee_leave_requests TO nexstock_app_user;

-- 7. Employee Leave Balances Table
CREATE TABLE IF NOT EXISTS employee_leave_balances (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
  year integer NOT NULL CHECK (year >= 2000 AND year <= 2100),
  leave_type text NOT NULL
    CHECK (leave_type IN ('ANNUAL', 'CASUAL', 'SICK', 'NO_PAY', 'HALF_DAY', 'SPECIAL')),
  annual_entitlement numeric(5, 2) NOT NULL DEFAULT 14.00 CHECK (annual_entitlement >= 0),
  used_days numeric(5, 2) NOT NULL DEFAULT 0.00 CHECK (used_days >= 0),
  pending_days numeric(5, 2) NOT NULL DEFAULT 0.00 CHECK (pending_days >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_leave_balances_emp_year_type UNIQUE (tenant_id, employee_id, year, leave_type)
);

CREATE INDEX IF NOT EXISTS idx_leave_balances_tenant_emp
  ON employee_leave_balances (tenant_id, employee_id, year);

ALTER TABLE employee_leave_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_leave_balances FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON employee_leave_balances;
CREATE POLICY tenant_isolation_policy ON employee_leave_balances
  AS PERMISSIVE FOR ALL TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE employee_leave_balances TO nexstock_app_user;

-- 8. Organization Holidays Table
CREATE TABLE IF NOT EXISTS org_holidays (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  holiday_date date NOT NULL,
  name text NOT NULL,
  holiday_type text NOT NULL DEFAULT 'PUBLIC'
    CHECK (holiday_type IN ('PUBLIC', 'ORG', 'SPECIAL')),
  is_recurring boolean NOT NULL DEFAULT false,
  notes text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_org_holidays_tenant_date UNIQUE (tenant_id, holiday_date)
);

CREATE INDEX IF NOT EXISTS idx_org_holidays_tenant_date
  ON org_holidays (tenant_id, holiday_date);

ALTER TABLE org_holidays ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_holidays FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON org_holidays;
CREATE POLICY tenant_isolation_policy ON org_holidays
  AS PERMISSIVE FOR ALL TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE org_holidays TO nexstock_app_user;

-- 9. Organization Payroll Settings Table
CREATE TABLE IF NOT EXISTS org_payroll_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenants (id) ON DELETE CASCADE,
  proration_method text NOT NULL DEFAULT 'CALENDAR_DAYS'
    CHECK (proration_method IN ('CALENDAR_DAYS', 'WORKING_DAYS', 'FIXED_30_DAYS')),
  gps_attendance_enabled boolean NOT NULL DEFAULT false,
  allowance_proration_policy text NOT NULL DEFAULT 'PRORATE'
    CHECK (allowance_proration_policy IN ('PRORATE', 'FULL')),
  workplace_latitude numeric(10, 7),
  workplace_longitude numeric(10, 7),
  geofence_radius_meters integer NOT NULL DEFAULT 500 CHECK (geofence_radius_meters > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

ALTER TABLE org_payroll_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_payroll_settings FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON org_payroll_settings;
CREATE POLICY tenant_isolation_policy ON org_payroll_settings
  AS PERMISSIVE FOR ALL TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE org_payroll_settings TO nexstock_app_user;

-- 10. Synchronize System Role Permissions for Phase 7.1 Attendance & Leave
DO $$
DECLARE
  r_role RECORD;
  v_perm text;
  v_perms text[];
BEGIN
  FOR r_role IN
    SELECT id, tenant_id, code
    FROM roles
    WHERE code IN ('TENANT_OWNER', 'ORG_ADMIN', 'ACCOUNTANT', 'BRANCH_MANAGER', 'CASHIER', 'WAREHOUSE_CLERK', 'PURCHASER')
  LOOP
    IF r_role.code IN ('TENANT_OWNER', 'ORG_ADMIN') THEN
      v_perms := ARRAY[
        'hrm:attendance:read', 'hrm:attendance:manage', 'hrm:attendance:self',
        'hrm:leave:read', 'hrm:leave:manage', 'hrm:leave:approve', 'hrm:leave:self',
        'hrm:schedule:read', 'hrm:schedule:manage',
        'hrm:holiday:read', 'hrm:holiday:manage',
        'hrm:settings:read', 'hrm:settings:manage'
      ];
    ELSIF r_role.code = 'BRANCH_MANAGER' THEN
      v_perms := ARRAY[
        'hrm:attendance:read', 'hrm:attendance:manage', 'hrm:attendance:self',
        'hrm:leave:read', 'hrm:leave:manage', 'hrm:leave:approve', 'hrm:leave:self',
        'hrm:schedule:read',
        'hrm:holiday:read'
      ];
    ELSIF r_role.code = 'ACCOUNTANT' THEN
      v_perms := ARRAY[
        'hrm:attendance:read', 'hrm:attendance:self',
        'hrm:leave:read', 'hrm:leave:self',
        'hrm:schedule:read',
        'hrm:holiday:read',
        'hrm:settings:read'
      ];
    ELSE
      v_perms := ARRAY[
        'hrm:attendance:self',
        'hrm:leave:self'
      ];
    END IF;

    FOREACH v_perm IN ARRAY v_perms
    LOOP
      INSERT INTO role_permissions (id, tenant_id, role_id, permission_key)
      VALUES (
        gen_random_uuid(),
        r_role.tenant_id,
        r_role.id,
        v_perm
      )
      ON CONFLICT (tenant_id, role_id, permission_key) DO NOTHING;
    END LOOP;
  END LOOP;
END $$;

-- Record completion of Migration 0017
INSERT INTO schema_migrations (version, name, filename)
VALUES (17, '0017_phase71_hrm_attendance_leave_proration', '0017_phase71_hrm_attendance_leave_proration.sql')
ON CONFLICT (version) DO UPDATE
  SET applied_at = clock_timestamp(),
      applied_by = current_user;

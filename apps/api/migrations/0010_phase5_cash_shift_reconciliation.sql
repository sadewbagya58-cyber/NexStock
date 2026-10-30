-- ============================================================================
-- Migration 0010: Cash Shift Reconciliation & Cash Adjustments
-- ============================================================================

CREATE TABLE IF NOT EXISTS pos_cash_adjustments (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  branch_id uuid NOT NULL,
  register_id uuid NOT NULL,
  shift_id uuid NOT NULL,
  adjustment_type text NOT NULL CHECK (adjustment_type IN ('CASH_IN', 'CASH_OUT', 'CASH_REFUND')),
  amount numeric(19, 4) NOT NULL CHECK (amount > 0),
  currency_code text NOT NULL CHECK (char_length(currency_code) = 3),
  reason text NOT NULL,
  performed_by_user_id uuid NOT NULL REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id),
  FOREIGN KEY (tenant_id, register_id) REFERENCES pos_registers (tenant_id, id),
  FOREIGN KEY (tenant_id, shift_id) REFERENCES pos_shifts (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS idx_pos_cash_adjustments_shift
  ON pos_cash_adjustments (tenant_id, shift_id, adjustment_type);

ALTER TABLE pos_cash_adjustments ENABLE ROW LEVEL SECURITY;
ALTER TABLE pos_cash_adjustments FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON pos_cash_adjustments;
CREATE POLICY tenant_isolation_policy ON pos_cash_adjustments
  AS PERMISSIVE
  FOR ALL
  TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

GRANT SELECT, INSERT, UPDATE ON TABLE pos_cash_adjustments TO nexstock_app_user;

INSERT INTO schema_migrations (version, name, filename)
VALUES (10, '0010_phase5_cash_shift_reconciliation', '0010_phase5_cash_shift_reconciliation.sql')
ON CONFLICT (version) DO UPDATE
  SET applied_at = clock_timestamp(),
      filename = EXCLUDED.filename;

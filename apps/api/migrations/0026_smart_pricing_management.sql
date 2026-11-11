-- ============================================================================
-- NexStock Migration - 0026_smart_pricing_management.sql
-- TARGET ENGINE: PostgreSQL 15+ / Supabase SQL Editor
-- PREREQUISITE: Must be executed AFTER 0025_uom_foundation_and_variable_products.sql
-- Modules Covered: CAT (Smart Pricing Settings, Product Pricing Rules,
--                  Global/Branch Overrides, Price Suggestions, Price History)
-- Specification Reference: PRICE-01..PRICE-20
-- ============================================================================

-- Preflight Check: Sequential migration verification
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = 25) THEN
    RAISE EXCEPTION 'MIGRATION_SEQUENCE_ERROR: Migration 0025 must be applied before 0026.';
  END IF;
END $$;

-- ============================================================================
-- 1. TENANT PRICING SETTINGS & APPROVAL WORKFLOW POLICY (`pricing_settings`)
-- ============================================================================

CREATE TABLE IF NOT EXISTS pricing_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenants (id) ON DELETE CASCADE,
  default_pricing_method text NOT NULL DEFAULT 'PROFIT_MARGIN'
    CHECK (default_pricing_method IN ('PROFIT_MARGIN', 'COST_MARKUP')),
  default_target_percentage numeric(8, 2) NOT NULL DEFAULT 25.00
    CHECK (default_target_percentage >= 0),
  default_cost_basis text NOT NULL DEFAULT 'MOVING_AVERAGE_COST'
    CHECK (default_cost_basis IN ('LAST_PURCHASE_COST', 'MOVING_AVERAGE_COST', 'HIGHEST_RECENT_COST')),
  default_rounding_rule text NOT NULL DEFAULT 'NEAREST_0_01'
    CHECK (default_rounding_rule IN (
      'NONE', 'NEAREST_0_01', 'NEAREST_0_50', 'NEAREST_1', 'NEAREST_5', 'NEAREST_10',
      'CEIL_0_50', 'CEIL_1', 'CEIL_5', 'CEIL_10'
    )),
  default_min_margin_pct numeric(8, 2) NOT NULL DEFAULT 10.00,
  default_max_discount_pct numeric(8, 2) NOT NULL DEFAULT 20.00
    CHECK (default_max_discount_pct >= 0 AND default_max_discount_pct <= 100),
  branch_approval_policy text NOT NULL DEFAULT 'OWNER_ADMIN_ONLY'
    CHECK (branch_approval_policy IN ('OWNER_ADMIN_ONLY', 'BRANCH_MANAGER_OWN_BRANCH')),
  allow_self_approval boolean NOT NULL DEFAULT false,
  auto_create_suggestions_on_cost_change boolean NOT NULL DEFAULT true,
  auto_create_suggestions_on_cost_decrease boolean NOT NULL DEFAULT true,
  updated_by_user_id uuid REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (NOT (default_pricing_method = 'PROFIT_MARGIN' AND default_target_percentage >= 100))
);

ALTER TABLE pricing_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE pricing_settings FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON pricing_settings;
CREATE POLICY tenant_isolation_policy ON pricing_settings
  AS PERMISSIVE
  FOR ALL
  TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

GRANT SELECT, INSERT, UPDATE ON TABLE pricing_settings TO nexstock_app_user;

-- Seed defaults for all existing tenants idempotently
INSERT INTO pricing_settings (tenant_id)
SELECT id FROM tenants
ON CONFLICT (tenant_id) DO NOTHING;

-- ============================================================================
-- 2. PRODUCT PRICING RULES (`product_pricing_rules`)
-- ============================================================================

CREATE TABLE IF NOT EXISTS product_pricing_rules (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  product_id uuid NOT NULL,
  pricing_method text NOT NULL DEFAULT 'PROFIT_MARGIN'
    CHECK (pricing_method IN ('PROFIT_MARGIN', 'COST_MARKUP')),
  target_percentage numeric(8, 2) NOT NULL DEFAULT 25.00
    CHECK (target_percentage >= 0),
  cost_basis text NOT NULL DEFAULT 'MOVING_AVERAGE_COST'
    CHECK (cost_basis IN ('LAST_PURCHASE_COST', 'MOVING_AVERAGE_COST', 'HIGHEST_RECENT_COST')),
  rounding_rule text NOT NULL DEFAULT 'NEAREST_0_01'
    CHECK (rounding_rule IN (
      'NONE', 'NEAREST_0_01', 'NEAREST_0_50', 'NEAREST_1', 'NEAREST_5', 'NEAREST_10',
      'CEIL_0_50', 'CEIL_1', 'CEIL_5', 'CEIL_10'
    )),
  min_selling_price numeric(19, 4)
    CHECK (min_selling_price IS NULL OR min_selling_price >= 0),
  min_margin_pct numeric(8, 2),
  max_discount_pct numeric(8, 2)
    CHECK (max_discount_pct IS NULL OR (max_discount_pct >= 0 AND max_discount_pct <= 100)),
  suggestions_enabled boolean NOT NULL DEFAULT true,
  effective_date date NOT NULL DEFAULT CURRENT_DATE,
  updated_by_user_id uuid REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, product_id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES products (tenant_id, id) ON DELETE CASCADE,
  CHECK (NOT (pricing_method = 'PROFIT_MARGIN' AND target_percentage >= 100))
);

ALTER TABLE product_pricing_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_pricing_rules FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON product_pricing_rules;
CREATE POLICY tenant_isolation_policy ON product_pricing_rules
  AS PERMISSIVE
  FOR ALL
  TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

GRANT SELECT, INSERT, UPDATE ON TABLE product_pricing_rules TO nexstock_app_user;

-- ============================================================================
-- 3. BRANCH-SPECIFIC APPROVED SELLING PRICE OVERRIDES (`product_branch_prices`)
-- ============================================================================

CREATE TABLE IF NOT EXISTS product_branch_prices (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  product_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  selling_price numeric(19, 4) NOT NULL CHECK (selling_price >= 0),
  pricing_method text NOT NULL DEFAULT 'PROFIT_MARGIN'
    CHECK (pricing_method IN ('PROFIT_MARGIN', 'COST_MARKUP')),
  target_percentage numeric(8, 2),
  rounding_rule text NOT NULL DEFAULT 'NEAREST_0_01'
    CHECK (rounding_rule IN (
      'NONE', 'NEAREST_0_01', 'NEAREST_0_50', 'NEAREST_1', 'NEAREST_5', 'NEAREST_10',
      'CEIL_0_50', 'CEIL_1', 'CEIL_5', 'CEIL_10'
    )),
  min_selling_price numeric(19, 4)
    CHECK (min_selling_price IS NULL OR min_selling_price >= 0),
  max_discount_pct numeric(8, 2)
    CHECK (max_discount_pct IS NULL OR (max_discount_pct >= 0 AND max_discount_pct <= 100)),
  effective_date date NOT NULL DEFAULT CURRENT_DATE,
  is_active boolean NOT NULL DEFAULT true,
  needs_review boolean NOT NULL DEFAULT false,
  review_reason text,
  approved_by_user_id uuid REFERENCES users (id),
  approved_at timestamptz,
  sync_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, product_id, branch_id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES products (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_product_branch_prices_lookup
  ON product_branch_prices (tenant_id, branch_id, is_active, effective_date);

CREATE INDEX IF NOT EXISTS idx_product_branch_prices_review
  ON product_branch_prices (tenant_id, needs_review)
  WHERE needs_review = true;

ALTER TABLE product_branch_prices ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_branch_prices FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON product_branch_prices;
CREATE POLICY tenant_isolation_policy ON product_branch_prices
  AS PERMISSIVE
  FOR ALL
  TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE product_branch_prices TO nexstock_app_user;

-- ============================================================================
-- 4. PRICE SUGGESTIONS & APPROVAL QUEUE (`price_suggestions`)
-- ============================================================================

CREATE TABLE IF NOT EXISTS price_suggestions (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  product_id uuid NOT NULL,
  scope text NOT NULL CHECK (scope IN ('GLOBAL', 'BRANCH')),
  branch_id uuid,
  source_event_type text NOT NULL CHECK (source_event_type IN (
    'GRN_POSTED', 'COST_EDIT', 'STOCK_MOVEMENT', 'BRANCH_PROPOSAL', 'GLOBAL_RULE_CHANGE', 'MANUAL_RECALC'
  )),
  source_event_key text,
  cost_change_direction text NOT NULL CHECK (cost_change_direction IN ('INCREASE', 'DECREASE', 'UNCHANGED')),
  old_cost numeric(19, 4) NOT NULL CHECK (old_cost >= 0),
  new_cost numeric(19, 4) NOT NULL CHECK (new_cost >= 0),
  cost_basis text NOT NULL CHECK (cost_basis IN ('LAST_PURCHASE_COST', 'MOVING_AVERAGE_COST', 'HIGHEST_RECENT_COST')),
  current_selling_price numeric(19, 4) NOT NULL CHECK (current_selling_price >= 0),
  suggested_selling_price numeric(19, 4) NOT NULL CHECK (suggested_selling_price >= 0),
  final_approved_price numeric(19, 4),
  pricing_method text NOT NULL CHECK (pricing_method IN ('PROFIT_MARGIN', 'COST_MARKUP')),
  target_percentage numeric(8, 2) NOT NULL CHECK (target_percentage >= 0),
  rounding_rule text NOT NULL CHECK (rounding_rule IN (
    'NONE', 'NEAREST_0_01', 'NEAREST_0_50', 'NEAREST_1', 'NEAREST_5', 'NEAREST_10',
    'CEIL_0_50', 'CEIL_1', 'CEIL_5', 'CEIL_10'
  )),
  reason text NOT NULL CHECK (btrim(reason) <> ''),
  effective_date date NOT NULL DEFAULT CURRENT_DATE,
  status text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'APPROVED', 'MODIFIED_APPROVED', 'REJECTED', 'DEFERRED', 'SUPERSEDED')),
  created_by_user_id uuid NOT NULL REFERENCES users (id),
  reviewed_by_user_id uuid REFERENCES users (id),
  review_notes text,
  deferred_until date,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  reviewed_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES products (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id) ON DELETE CASCADE,
  CHECK ((scope = 'GLOBAL' AND branch_id IS NULL) OR (scope = 'BRANCH' AND branch_id IS NOT NULL))
);

-- Prevent duplicate PENDING suggestions for the same cost-change event
CREATE UNIQUE INDEX IF NOT EXISTS uq_price_suggestions_pending_event
  ON price_suggestions (tenant_id, source_event_key)
  WHERE status = 'PENDING' AND source_event_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_price_suggestions_tenant_status
  ON price_suggestions (tenant_id, status, scope, created_at DESC);

ALTER TABLE price_suggestions ENABLE ROW LEVEL SECURITY;
ALTER TABLE price_suggestions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON price_suggestions;
CREATE POLICY tenant_isolation_policy ON price_suggestions
  AS PERMISSIVE
  FOR ALL
  TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

GRANT SELECT, INSERT, UPDATE ON TABLE price_suggestions TO nexstock_app_user;

-- ============================================================================
-- 5. APPEND-ONLY PRODUCT PRICE HISTORY LEDGER (`product_price_history`)
-- ============================================================================

CREATE TABLE IF NOT EXISTS product_price_history (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  product_id uuid NOT NULL,
  scope text NOT NULL CHECK (scope IN ('GLOBAL', 'BRANCH')),
  branch_id uuid,
  suggestion_id uuid,
  previous_price numeric(19, 4) NOT NULL CHECK (previous_price >= 0),
  new_price numeric(19, 4) NOT NULL CHECK (new_price >= 0),
  cost_snapshot numeric(19, 4) NOT NULL CHECK (cost_snapshot >= 0),
  pricing_method text CHECK (pricing_method IS NULL OR pricing_method IN ('PROFIT_MARGIN', 'COST_MARKUP')),
  target_percentage numeric(8, 2),
  rounding_rule text,
  reason text NOT NULL CHECK (btrim(reason) <> ''),
  actor_user_id uuid NOT NULL REFERENCES users (id),
  approver_user_id uuid NOT NULL REFERENCES users (id),
  effective_date date NOT NULL DEFAULT CURRENT_DATE,
  approved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES products (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id),
  FOREIGN KEY (tenant_id, suggestion_id) REFERENCES price_suggestions (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS idx_product_price_history_lookup
  ON product_price_history (tenant_id, product_id, created_at DESC);

ALTER TABLE product_price_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_price_history FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON product_price_history;
CREATE POLICY tenant_isolation_policy ON product_price_history
  AS PERMISSIVE
  FOR ALL
  TO nexstock_app_user
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

-- Append-only ledger: only SELECT & INSERT granted to nexstock_app_user
GRANT SELECT, INSERT ON TABLE product_price_history TO nexstock_app_user;

-- ============================================================================
-- 6. BACKFILL SMART PRICING RBAC PERMISSIONS FOR ALL SYSTEM ROLES
-- ============================================================================

DO $$
DECLARE
  r_role RECORD;
  v_perm text;
  v_perms text[];
BEGIN
  FOR r_role IN
    SELECT tenant_id, id, code
    FROM roles
    WHERE is_system_role = true
  LOOP
    IF r_role.code IN ('TENANT_OWNER', 'ORG_ADMIN') THEN
      v_perms := ARRAY[
        'cat:pricing:read',
        'cat:pricing:suggest',
        'cat:pricing:approve_global',
        'cat:pricing:approve_branch',
        'cat:pricing:policy_manage'
      ];
    ELSIF r_role.code = 'BRANCH_MANAGER' THEN
      v_perms := ARRAY[
        'cat:pricing:read',
        'cat:pricing:suggest',
        'cat:pricing:approve_branch'
      ];
    ELSIF r_role.code = 'PURCHASER' THEN
      v_perms := ARRAY[
        'cat:pricing:read',
        'cat:pricing:suggest'
      ];
    ELSIF r_role.code = 'ACCOUNTANT' THEN
      v_perms := ARRAY[
        'cat:pricing:read'
      ];
    ELSE
      v_perms := ARRAY[]::text[];
    END IF;

    FOREACH v_perm IN ARRAY v_perms LOOP
      INSERT INTO role_permissions (
        id, tenant_id, role_id, permission_key, created_at
      )
      VALUES (
        gen_random_uuid(),
        r_role.tenant_id,
        r_role.id,
        v_perm,
        clock_timestamp()
      )
      ON CONFLICT DO NOTHING;
    END LOOP;
  END LOOP;
END $$;

-- ============================================================================
-- 7. RECORD COMPLETION OF MIGRATION 0026
-- ============================================================================

INSERT INTO schema_migrations (version, name, filename)
VALUES (26, '0026_smart_pricing_management', '0026_smart_pricing_management.sql')
ON CONFLICT (version) DO NOTHING;

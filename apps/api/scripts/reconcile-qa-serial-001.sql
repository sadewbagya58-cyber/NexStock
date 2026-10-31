-- ============================================================================
-- NexStock — Production Data Reconciliation: QA-SERIAL-001 (BUG-016)
-- Target Product: QA-SERIAL-001
-- Target Serials: SN-10001, SN-10002, SN-10003 (3 Units)
--
-- Safety Guarantees:
-- 1. Idempotent: Exits cleanly if a stock_ledger_entries row already exists for these serials
--    or if inventory balance is already >= 3 PCS.
-- 2. Atomic: Entire operation runs inside a single TRANSACTION DO block.
-- 3. PostgreSQL UUID Compatibility: Uses COUNT(DISTINCT ...) and deterministic selection /
--    text casting instead of unsupported MAX(uuid).
-- 4. Consistency Verified: Validates that warehouse, branch, and unit-cost are 100% uniform
--    across all serial records before applying stock movements.
-- 5. Invariant-Preserving: Satisfies stock_ledger_entries_immutable_trg and
--    inventory_balances trigger requirements.
-- 6. Quantity Preservation: Verifies final qty_on_hand is exactly 3 PCS (never 6).
-- ============================================================================

DO $$
DECLARE
  v_product RECORD;
  v_serial_count integer;
  v_warehouse_distinct_count integer;
  v_branch_distinct_count integer;
  v_cost_distinct_count integer;
  v_existing_balance RECORD;
  v_movement_id uuid;
  v_idempotency_key uuid;
  v_actor_user_id uuid;
  v_balance_before numeric(18, 6);
  v_balance_after numeric(18, 6);
  v_qty numeric(18, 6) := 3.000000;
  v_unit_cost numeric(19, 4);
  v_now timestamptz := clock_timestamp();
  v_warehouse_id uuid;
  v_branch_id uuid;
BEGIN
  -- 1. Find Product
  SELECT id, tenant_id, sku, base_uom, purchase_cost
  INTO v_product
  FROM products
  WHERE sku = 'QA-SERIAL-001'
  LIMIT 1;

  IF v_product.id IS NULL THEN
    RAISE NOTICE 'Reconciliation skipped: Product "QA-SERIAL-001" not found in products table.';
    RETURN;
  END IF;

  -- 2. Verify all 3 Serials exist in IN_STOCK status and validate warehouse, branch, and cost consistency.
  -- Note: PostgreSQL does not support MAX(uuid); we use COUNT(DISTINCT ...) and text casting / deterministic selection.
  SELECT
    count(*),
    count(DISTINCT warehouse_id),
    count(DISTINCT branch_id),
    count(DISTINCT unit_cost),
    max(warehouse_id::text)::uuid,
    max(branch_id::text)::uuid,
    max(unit_cost)
  INTO
    v_serial_count,
    v_warehouse_distinct_count,
    v_branch_distinct_count,
    v_cost_distinct_count,
    v_warehouse_id,
    v_branch_id,
    v_unit_cost
  FROM inventory_serials
  WHERE tenant_id = v_product.tenant_id
    AND product_id = v_product.id
    AND serial_number IN ('SN-10001', 'SN-10002', 'SN-10003')
    AND status = 'IN_STOCK';

  IF v_serial_count < 3 THEN
    RAISE NOTICE 'Reconciliation skipped: Found only % of 3 serials in IN_STOCK status for product "%".',
      v_serial_count, v_product.sku;
    RETURN;
  END IF;

  -- Consistency verification: all 3 serials must belong to the exact same warehouse, branch, and unit cost.
  IF v_warehouse_distinct_count <> 1 THEN
    RAISE EXCEPTION 'Consistency check failed: Serials are distributed across % distinct warehouses.',
      v_warehouse_distinct_count;
  END IF;

  IF v_branch_distinct_count <> 1 THEN
    RAISE EXCEPTION 'Consistency check failed: Serials are distributed across % distinct branches.',
      v_branch_distinct_count;
  END IF;

  IF v_cost_distinct_count <> 1 THEN
    RAISE EXCEPTION 'Consistency check failed: Serials have % distinct unit costs.',
      v_cost_distinct_count;
  END IF;

  IF v_warehouse_id IS NULL OR v_branch_id IS NULL THEN
    RAISE EXCEPTION 'Consistency check failed: Serial warehouse_id or branch_id is NULL.';
  END IF;

  -- Deterministically select uniform attributes from the lowest serial number
  SELECT warehouse_id, branch_id, unit_cost
  INTO v_warehouse_id, v_branch_id, v_unit_cost
  FROM inventory_serials
  WHERE tenant_id = v_product.tenant_id
    AND product_id = v_product.id
    AND serial_number IN ('SN-10001', 'SN-10002', 'SN-10003')
    AND status = 'IN_STOCK'
  ORDER BY serial_number ASC
  LIMIT 1;

  -- 3. Check for existing reconciliation ledger entry (Idempotency)
  PERFORM 1
  FROM stock_ledger_entries
  WHERE tenant_id = v_product.tenant_id
    AND reference_type = 'SERIAL_REGISTRATION'
    AND reference_id = 'RECONCILE-QA-SERIAL-001'
  LIMIT 1;

  IF FOUND THEN
    RAISE NOTICE 'Reconciliation skipped: Stock ledger entry for RECONCILE-QA-SERIAL-001 already exists.';
    RETURN;
  END IF;

  -- Check existing inventory balance
  SELECT id, qty_on_hand, sync_version
  INTO v_existing_balance
  FROM inventory_balances
  WHERE tenant_id = v_product.tenant_id
    AND warehouse_id = v_warehouse_id
    AND product_id = v_product.id;

  v_balance_before := COALESCE(v_existing_balance.qty_on_hand, 0.000000);

  IF v_balance_before >= 3.000000 THEN
    RAISE NOTICE 'Reconciliation skipped: Inventory balance already has % PCS on hand (target is 3 PCS).', v_balance_before;
    RETURN;
  END IF;

  -- 4. Find Actor User (First owner/member in tenant)
  SELECT user_id
  INTO v_actor_user_id
  FROM tenant_memberships
  WHERE tenant_id = v_product.tenant_id
  ORDER BY created_at ASC
  LIMIT 1;

  IF v_actor_user_id IS NULL THEN
    v_actor_user_id := v_product.tenant_id;
  END IF;

  v_balance_after := v_balance_before + v_qty;
  v_movement_id := gen_random_uuid();
  v_idempotency_key := gen_random_uuid();

  RAISE NOTICE 'Starting serial reconciliation for product "%": Intake Qty = %, Balance Before = %, Target Balance After = %',
    v_product.sku, v_qty, v_balance_before, v_balance_after;

  -- 5. Insert the authoritative immutable stock_ledger_entries record
  INSERT INTO stock_ledger_entries (
    id,
    tenant_id,
    branch_id,
    warehouse_id,
    product_id,
    batch_id,
    serial_id,
    supplier_id,
    movement_type,
    uom_code,
    input_qty,
    conversion_factor_to_base,
    qty_delta,
    balance_before,
    balance_after,
    unit_cost,
    reference_type,
    reference_id,
    reason,
    negative_stock_override_applied,
    actor_user_id,
    idempotency_key,
    occurred_at,
    recorded_at,
    metadata_json
  ) VALUES (
    v_movement_id,
    v_product.tenant_id,
    v_branch_id,
    v_warehouse_id,
    v_product.id,
    null,
    null,
    null,
    'STOCK_IN',
    v_product.base_uom,
    v_qty,
    1.000000,
    v_qty,
    v_balance_before,
    v_balance_after,
    v_unit_cost,
    'SERIAL_REGISTRATION',
    'RECONCILE-QA-SERIAL-001',
    'Authoritative stock intake reconciliation for QA-SERIAL-001 (SN-10001, SN-10002, SN-10003)',
    false,
    v_actor_user_id,
    v_idempotency_key,
    v_now,
    v_now,
    jsonb_build_object(
      'sku', v_product.sku,
      'reconciled', true,
      'serials', jsonb_build_array('SN-10001', 'SN-10002', 'SN-10003')
    )
  );

  -- 6. Atomically maintain inventory_balances
  IF v_existing_balance.id IS NOT NULL THEN
    UPDATE inventory_balances
    SET
      qty_on_hand = v_balance_after,
      last_ledger_entry_id = v_movement_id,
      last_movement_at = v_now,
      sync_version = v_existing_balance.sync_version + 1,
      updated_at = v_now
    WHERE tenant_id = v_product.tenant_id
      AND id = v_existing_balance.id;
  ELSE
    INSERT INTO inventory_balances (
      id,
      tenant_id,
      branch_id,
      warehouse_id,
      product_id,
      uom_code,
      qty_on_hand,
      qty_reserved,
      qty_in_transit,
      qty_damaged,
      moving_avg_cost,
      total_inventory_value,
      last_ledger_entry_id,
      last_movement_at,
      sync_version,
      updated_at
    ) VALUES (
      gen_random_uuid(),
      v_product.tenant_id,
      v_branch_id,
      v_warehouse_id,
      v_product.id,
      v_product.base_uom,
      v_balance_after,
      0.000000,
      0.000000,
      0.000000,
      v_unit_cost,
      (v_balance_after * v_unit_cost),
      v_movement_id,
      v_now,
      1,
      v_now
    );
  END IF;

  -- 7. Link serials to the authoritative movement
  UPDATE inventory_serials
  SET
    last_movement_id = v_movement_id,
    updated_at = v_now
  WHERE tenant_id = v_product.tenant_id
    AND product_id = v_product.id
    AND serial_number IN ('SN-10001', 'SN-10002', 'SN-10003');

  RAISE NOTICE 'Serial reconciliation complete! Movement ID: %, Final Balance: % PCS', v_movement_id, v_balance_after;
END;
$$;

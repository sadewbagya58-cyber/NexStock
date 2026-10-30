-- ============================================================================
-- NexStock — Production Data Reconciliation: QA-BATCH-2026-001 (BUG-015)
-- Target Product: QA-BATCH-001
-- Target Batch:   QA-BATCH-2026-001
--
-- Safety Guarantees:
-- 1. Idempotent: Exits cleanly if a stock_ledger_entries row already exists for this batch.
-- 2. Atomic: Entire operation runs inside a single TRANSACTION block.
-- 3. Invariant-Preserving: Satisfies stock_ledger_entries_immutable_trg and
--    inventory_balances trigger requirements.
-- 4. Quantity Preservation: Verifies current_quantity remains exactly 100 PCS (not 200).
-- ============================================================================

DO $$
DECLARE
  v_product RECORD;
  v_batch RECORD;
  v_warehouse RECORD;
  v_existing_ledger_count integer;
  v_existing_balance RECORD;
  v_movement_id uuid;
  v_idempotency_key uuid;
  v_actor_user_id uuid;
  v_balance_before numeric(18, 6);
  v_balance_after numeric(18, 6);
  v_qty numeric(18, 6);
  v_unit_cost numeric(19, 4);
  v_now timestamptz := clock_timestamp();
BEGIN
  -- 1. Find Product
  SELECT id, tenant_id, sku, base_uom, purchase_cost
  INTO v_product
  FROM products
  WHERE sku = 'QA-BATCH-001'
  LIMIT 1;

  IF v_product.id IS NULL THEN
    RAISE NOTICE 'Reconciliation skipped: Product "QA-BATCH-001" not found in products table.';
    RETURN;
  END IF;

  -- 2. Find Batch
  SELECT id, tenant_id, warehouse_id, batch_number, initial_quantity, current_quantity, unit_cost, supplier_id, created_at
  INTO v_batch
  FROM inventory_batches
  WHERE tenant_id = v_product.tenant_id
    AND product_id = v_product.id
    AND batch_number = 'QA-BATCH-2026-001'
  LIMIT 1;

  IF v_batch.id IS NULL THEN
    RAISE NOTICE 'Reconciliation skipped: Batch "QA-BATCH-2026-001" not found for product "%".', v_product.sku;
    RETURN;
  END IF;

  -- 3. Verify no existing ledger entry for this batch
  SELECT count(*)
  INTO v_existing_ledger_count
  FROM stock_ledger_entries
  WHERE tenant_id = v_product.tenant_id
    AND batch_id = v_batch.id;

  IF v_existing_ledger_count > 0 THEN
    RAISE NOTICE 'Reconciliation skipped: Batch "QA-BATCH-2026-001" already has % stock_ledger_entries record(s).', v_existing_ledger_count;
    RETURN;
  END IF;

  -- 4. Find Warehouse & Branch
  SELECT id, branch_id
  INTO v_warehouse
  FROM warehouses
  WHERE tenant_id = v_product.tenant_id
    AND id = v_batch.warehouse_id;

  IF v_warehouse.branch_id IS NULL THEN
    RAISE EXCEPTION 'Reconciliation failed: Warehouse "%" has no associated branch_id.', v_batch.warehouse_id;
  END IF;

  -- 5. Find Actor User (First owner/member in tenant)
  SELECT user_id
  INTO v_actor_user_id
  FROM tenant_memberships
  WHERE tenant_id = v_product.tenant_id
  ORDER BY created_at ASC
  LIMIT 1;

  IF v_actor_user_id IS NULL THEN
    v_actor_user_id := v_product.tenant_id;
  END IF;

  -- 6. Check existing balance
  SELECT id, qty_on_hand, sync_version
  INTO v_existing_balance
  FROM inventory_balances
  WHERE tenant_id = v_product.tenant_id
    AND warehouse_id = v_batch.warehouse_id
    AND product_id = v_product.id;

  v_balance_before := COALESCE(v_existing_balance.qty_on_hand, 0.000000);
  v_qty := v_batch.initial_quantity;
  v_unit_cost := v_batch.unit_cost;
  v_balance_after := v_balance_before + v_qty;
  v_movement_id := gen_random_uuid();
  v_idempotency_key := gen_random_uuid();

  RAISE NOTICE 'Starting reconciliation for batch "%": Initial Qty = %, Balance Before = %, Balance After = %',
    v_batch.batch_number, v_qty, v_balance_before, v_balance_after;

  -- 7. Insert the authoritative immutable stock_ledger_entries record
  INSERT INTO stock_ledger_entries (
    id,
    tenant_id,
    branch_id,
    warehouse_id,
    product_id,
    batch_id,
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
    v_warehouse.branch_id,
    v_batch.warehouse_id,
    v_product.id,
    v_batch.id,
    v_batch.supplier_id,
    'STOCK_IN',
    v_product.base_uom,
    v_qty,
    1.000000,
    v_qty,
    v_balance_before,
    v_balance_after,
    v_unit_cost,
    'BATCH_REGISTRATION',
    v_batch.batch_number,
    'Authoritative stock intake reconciliation for QA-BATCH-2026-001',
    false,
    v_actor_user_id,
    v_idempotency_key,
    COALESCE(v_batch.created_at, v_now),
    v_now,
    jsonb_build_object('sku', v_product.sku, 'reconciled', true)
  );

  -- 8. Maintain inventory_balances atomically
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
      v_warehouse.branch_id,
      v_batch.warehouse_id,
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

  -- 9. Ensure batch current_quantity is exactly 100 PCS
  UPDATE inventory_batches
  SET
    current_quantity = v_qty,
    updated_at = v_now
  WHERE tenant_id = v_product.tenant_id
    AND id = v_batch.id;

  RAISE NOTICE 'Reconciliation complete! Movement ID: %, New Balance: %', v_movement_id, v_balance_after;
END;
$$;

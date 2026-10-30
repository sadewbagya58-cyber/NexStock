import type {
  InventoryBalanceResponse,
  InventoryReconciliationDiscrepancy,
  InventoryReconciliationResponse,
  ListInventoryBalancesQuery,
  ListStockMovementsQuery,
  PostStockMovementRequest,
  ReverseStockMovementRequest,
  StockAlertState,
  StockMovementResponse,
  StockMovementType,
} from '@nexstock/contracts';
import {
  Money,
  Quantity,
  QUANTITY_SCALE_FACTOR,
  divideAndRoundBigInt,
  applyMacReceipt,
  applyMacOutboundIssue,
  consumeFifoCostLayers,
  type FifoCostLayer,
} from '@nexstock/domain-core';
import { sql } from 'kysely';

export * from './batch.service.js';
export * from './serial.service.js';
export * from './costing.service.js';
export * from './stocktake.service.js';
import {
  type CursorPaginatedResult,
  resolveProductForInventory,
} from '../../cat/index.js';
import { assertAuthorized } from '../../iam/index.js';
import {
  AppError,
  type TenantTransactionContext,
  appendAuditLog,
  enqueueOutboxEvent,
  generateUuidV7,
} from '../../shared/index.js';
import { assertSubscriptionEntitlement } from '../../sub/index.js';

const INBOUND_MOVEMENT_TYPES = new Set<StockMovementType>([
  'OPENING_STOCK',
  'STOCK_IN',
  'ADJUSTMENT_POSITIVE',
  'CUSTOMER_RETURN_RESTOCK',
]);

const OUTBOUND_MOVEMENT_TYPES = new Set<StockMovementType>([
  'STOCK_OUT',
  'ADJUSTMENT_NEGATIVE',
  'SUPPLIER_RETURN',
]);

async function getTenantBaseCurrency(
  trx: TenantTransactionContext,
): Promise<string> {
  const tenant = await trx.db
    .selectFrom('tenants')
    .select(['base_currency'])
    .where('id', '=', trx.tenantId)
    .executeTakeFirst();

  return tenant?.base_currency?.trim() ?? 'USD';
}

function mapStockMovementRow(
  row: {
    id: string;
    tenant_id: string;
    branch_id: string;
    warehouse_id: string;
    product_id: string;
    product_sku?: string | null;
    product_name?: string | null;
    batch_id?: string | null;
    serial_id?: string | null;
    supplier_id: string | null;
    movement_type: StockMovementType;
    uom_code: string;
    input_qty: string;
    conversion_factor_to_base: string;
    qty_delta: string;
    balance_before: string;
    balance_after: string;
    unit_cost: string;
    total_cost_delta?: string | null;
    reference_type: string | null;
    reference_id: string | null;
    reversed_entry_id: string | null;
    reason: string | null;
    negative_stock_override_applied: boolean;
    actor_user_id: string;
    idempotency_key: string;
    occurred_at: Date | string;
    recorded_at: Date | string;
  },
  baseCurrency: string,
): StockMovementResponse {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    branchId: row.branch_id,
    warehouseId: row.warehouse_id,
    productId: row.product_id,
    productSku: row.product_sku ?? null,
    productName: row.product_name ?? null,
    batchId: row.batch_id ?? null,
    serialId: row.serial_id ?? null,
    supplierId: row.supplier_id,
    movementType: row.movement_type,
    uomCode: row.uom_code,
    inputQty: Quantity.fromDecimalString(String(row.input_qty)).toDecimalString(),
    conversionFactorToBase: Quantity.fromDecimalString(
      String(row.conversion_factor_to_base),
    ).toDecimalString(),
    qtyDelta: Quantity.fromDecimalString(String(row.qty_delta)).toDecimalString(),
    quantity: Quantity.fromDecimalString(String(row.qty_delta)).toDecimalString(),
    balanceBefore: Quantity.fromDecimalString(
      String(row.balance_before),
    ).toDecimalString(),
    balanceAfter: Quantity.fromDecimalString(
      String(row.balance_after),
    ).toDecimalString(),
    unitCost: Money.fromDecimalString(
      String(row.unit_cost),
      baseCurrency,
    ).toDecimalString(),
    ...(row.total_cost_delta
      ? {
          totalCostDelta: Money.fromDecimalString(
            String(row.total_cost_delta),
            baseCurrency,
          ).toDecimalString(),
        }
      : {}),
    referenceType: row.reference_type,
    referenceId: row.reference_id,
    reversedEntryId: row.reversed_entry_id,
    reason: row.reason,
    notes: row.reason,
    negativeStockOverrideApplied: row.negative_stock_override_applied,
    actorUserId: row.actor_user_id,
    idempotencyKey: row.idempotency_key,
    occurredAt: new Date(row.occurred_at).toISOString(),
    recordedAt: new Date(row.recorded_at).toISOString(),
    createdAt: new Date(row.occurred_at).toISOString(),
  };
}

async function verifyBranchAndWarehouseRelationship(
  trx: TenantTransactionContext,
  branchId: string,
  warehouseId: string,
): Promise<{
  readonly warehouseId: string;
  readonly branchId: string;
  readonly allowNegativeStock: boolean;
}> {
  const branch = await trx.db
    .selectFrom('branches')
    .select(['id', 'is_active'])
    .where('id', '=', branchId)
    .executeTakeFirst();

  if (!branch || !branch.is_active) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'ERR_NOT_FOUND',
      title: 'Branch Not Found',
      detail: `Active branch "${branchId}" was not found in tenant "${trx.tenantId}".`,
    });
  }

  const warehouse = await trx.db
    .selectFrom('warehouses')
    .select(['id', 'branch_id', 'allow_negative_stock', 'is_active'])
    .where('id', '=', warehouseId)
    .executeTakeFirst();

  if (!warehouse || !warehouse.is_active) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'ERR_NOT_FOUND',
      title: 'Warehouse Not Found',
      detail: `Active warehouse "${warehouseId}" was not found in tenant "${trx.tenantId}".`,
    });
  }

  let belongsToBranch = warehouse.branch_id === branchId;
  if (!belongsToBranch) {
    const link = await trx.db
      .selectFrom('branch_warehouse_links')
      .select(['id'])
      .where('tenant_id', '=', trx.tenantId)
      .where('branch_id', '=', branchId)
      .where('warehouse_id', '=', warehouseId)
      .executeTakeFirst();
    belongsToBranch = Boolean(link);
  }

  if (!belongsToBranch) {
    throw new AppError({
      statusCode: 400,
      errorCode: 'ERR_VALIDATION_FAILED',
      title: 'Warehouse Not Linked to Branch',
      detail: `Warehouse "${warehouseId}" does not belong to branch "${branchId}".`,
    });
  }

  return {
    warehouseId: warehouse.id,
    branchId: branch.id,
    allowNegativeStock: warehouse.allow_negative_stock,
  };
}

/**
 * Acquires a transaction-scoped PostgreSQL advisory lock on `(tenantId, warehouseId, productId)`
 * and locks any existing `inventory_balances` row (`FOR UPDATE`), guaranteeing strict
 * concurrency serialization even when the balance row does not yet exist.
 */
async function lockWarehouseProductBalance(
  trx: TenantTransactionContext,
  warehouseId: string,
  productId: string,
) {
  const lockKey = `${trx.tenantId}:${warehouseId}:${productId}`;
  await sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`.execute(trx.db);

  return trx.db
    .selectFrom('inventory_balances')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('warehouse_id', '=', warehouseId)
    .where('product_id', '=', productId)
    .forUpdate()
    .executeTakeFirst();
}

export async function postStockMovement(
  trx: TenantTransactionContext,
  idempotencyKey: string,
  input: PostStockMovementRequest,
  options?: { readonly skipPermissionCheck?: boolean },
): Promise<StockMovementResponse> {
  if (!options?.skipPermissionCheck) {
    await assertAuthorized(trx, {
      permission: 'inv:movement:post',
      branchId: input.branchId,
      warehouseId: input.warehouseId,
    });
  }

  await assertSubscriptionEntitlement(trx, {
    requireWriteAccess: true,
  });

  const warehouseMeta = await verifyBranchAndWarehouseRelationship(
    trx,
    input.branchId,
    input.warehouseId,
  );

  const product = await resolveProductForInventory(trx, input.productId);
  if (product.status !== 'ACTIVE') {
    throw new AppError({
      statusCode: 409,
      errorCode: 'INV_PRODUCT_ARCHIVED',
      title: 'Product Is Archived',
      detail: `Stock movements cannot be posted for archived product "${product.sku}".`,
    });
  }

  if (!product.trackInventory) {
    throw new AppError({
      statusCode: 422,
      errorCode: 'INV_PRODUCT_NOT_TRACKABLE',
      title: 'Product Does Not Track Stock',
      detail: `Product "${product.sku}" (${product.productType}) is configured with trackInventory=false.`,
    });
  }

  const supplierId = input.supplierId ?? null;
  if (supplierId) {
    const supplierRow = await trx.db
      .selectFrom('suppliers')
      .select(['id', 'status'])
      .where('id', '=', supplierId)
      .executeTakeFirst();

    if (!supplierRow) {
      throw new AppError({
        statusCode: 404,
        errorCode: 'ERR_NOT_FOUND',
        title: 'Supplier Not Found',
        detail: `Supplier "${supplierId}" was not found in tenant "${trx.tenantId}".`,
      });
    }
  }

  // Parse and validate fixed-point quantity
  let inputQty: Quantity;
  try {
    inputQty = Quantity.fromDecimalString(input.quantity);
  } catch {
    throw new AppError({
      statusCode: 422,
      errorCode: 'INV_INVALID_MOVEMENT_QUANTITY',
      title: 'Invalid Movement Quantity',
      detail: `Quantity "${input.quantity}" is not a valid fixed-point quantity.`,
    });
  }

  if (inputQty.isZero()) {
    throw new AppError({
      statusCode: 422,
      errorCode: 'INV_INVALID_MOVEMENT_QUANTITY',
      title: 'Zero Movement Quantity Forbidden',
      detail: 'Stock movement quantity cannot be zero.',
    });
  }

  if (INBOUND_MOVEMENT_TYPES.has(input.movementType) && !inputQty.isPositive()) {
    throw new AppError({
      statusCode: 422,
      errorCode: 'INV_INVALID_MOVEMENT_QUANTITY',
      title: 'Invalid Quantity Sign for Inbound Movement',
      detail: `Movement type "${input.movementType}" requires a strictly positive quantity (> 0), but received "${input.quantity}".`,
    });
  }

  if (OUTBOUND_MOVEMENT_TYPES.has(input.movementType) && !inputQty.isNegative()) {
    throw new AppError({
      statusCode: 422,
      errorCode: 'INV_INVALID_MOVEMENT_QUANTITY',
      title: 'Invalid Quantity Sign for Outbound Movement',
      detail: `Movement type "${input.movementType}" requires a strictly negative quantity (< 0), but received "${input.quantity}".`,
    });
  }

  const movementReason = (input.reason ?? input.notes)?.trim() || null;

  if (
    (input.movementType === 'ADJUSTMENT_POSITIVE' ||
      input.movementType === 'ADJUSTMENT_NEGATIVE') &&
    (!movementReason || movementReason.length < 3)
  ) {
    throw new AppError({
      statusCode: 400,
      errorCode: 'ERR_VALIDATION_FAILED',
      title: 'Adjustment Reason Required',
      detail: `Stock adjustment movements require an auditable reason of at least 3 characters.`,
    });
  }

  const uomCode = (input.uomCode ?? product.baseUom).trim().toUpperCase();
  const conversionFactorStr = product.unitConversions.get(uomCode);
  if (!conversionFactorStr) {
    throw new AppError({
      statusCode: 400,
      errorCode: 'CAT_INVALID_UOM_CONVERSION',
      title: 'Unsupported Unit of Measure',
      detail: `UoM "${uomCode}" is not configured for product "${product.sku}" (baseUom: "${product.baseUom}").`,
    });
  }

  const qtyDelta = inputQty.convertUsingFactor(conversionFactorStr);
  if (qtyDelta.isZero()) {
    throw new AppError({
      statusCode: 422,
      errorCode: 'INV_INVALID_MOVEMENT_QUANTITY',
      title: 'Converted Quantity Rounds to Zero',
      detail: 'Converted base UoM quantity delta cannot be zero.',
    });
  }

  const baseCurrency = await getTenantBaseCurrency(trx);
  const unitCostMoney = Money.fromDecimalString(
    input.unitCost ?? product.purchaseCost,
    baseCurrency,
  );
  if (unitCostMoney.isNegative()) {
    throw new AppError({
      statusCode: 400,
      errorCode: 'ERR_VALIDATION_FAILED',
      title: 'Negative Unit Cost Forbidden',
      detail: 'Movement unitCost cannot be negative.',
    });
  }

  // Serialize concurrent movements on (tenant, warehouse, product)
  const existingBalance = await lockWarehouseProductBalance(
    trx,
    input.warehouseId,
    input.productId,
  );

  const balanceBefore = existingBalance
    ? Quantity.fromDecimalString(String(existingBalance.qty_on_hand))
    : Quantity.zero();
  const balanceAfter = balanceBefore.add(qtyDelta);

  let negativeStockOverrideApplied = false;

  // Validate and handle Batch Tracking if applicable
  const batchRow = input.batchId
    ? await trx.db
        .selectFrom('inventory_batches')
        .selectAll()
        .where('tenant_id', '=', trx.tenantId)
        .where('id', '=', input.batchId)
        .where('warehouse_id', '=', input.warehouseId)
        .where('product_id', '=', input.productId)
        .forUpdate()
        .executeTakeFirst()
    : undefined;

  if (input.batchId) {
    if (!batchRow) {
      throw new AppError({
        statusCode: 404,
        errorCode: 'INV_BATCH_NOT_FOUND',
        title: 'Batch Not Found',
        detail: `Batch "${input.batchId}" not found for product "${product.sku}" in warehouse "${input.warehouseId}".`,
      });
    }

    if (batchRow.status === 'QUARANTINED') {
      throw new AppError({
        statusCode: 409,
        errorCode: 'INV_BATCH_QUARANTINED',
        title: 'Batch Is Quarantined',
        detail: `Cannot post movements for quarantined batch "${batchRow.batch_number}". Reason: ${batchRow.quarantine_reason ?? 'Under inspection'}.`,
      });
    }

    if (qtyDelta.isNegative()) {
      if (product.trackingMode === 'BATCH_EXPIRY' && batchRow.expiry_date) {
        const expDateStr = new Date(batchRow.expiry_date).toISOString().slice(0, 10);
        const todayStr = new Date().toISOString().slice(0, 10);
        if (expDateStr < todayStr && !negativeStockOverrideApplied) {
          throw new AppError({
            statusCode: 409,
            errorCode: 'INV_BATCH_EXPIRED',
            title: 'Batch Has Expired',
            detail: `Cannot issue from expired batch "${batchRow.batch_number}" (expiry date: ${expDateStr}).`,
          });
        }
      }

      const currentBatchQty = Quantity.fromDecimalString(
        String(batchRow.current_quantity),
      );
      const needed = qtyDelta.abs();
      if (currentBatchQty.compare(needed) < 0 && !negativeStockOverrideApplied) {
        throw new AppError({
          statusCode: 409,
          errorCode: 'INV_INSUFFICIENT_BATCH_STOCK',
          title: 'Insufficient Batch Stock',
          detail: `Batch "${batchRow.batch_number}" has ${currentBatchQty.toDecimalString()} available, but ${needed.toDecimalString()} requested.`,
        });
      }
    }
  }

  // Validate and handle Serial Tracking if applicable
  const serialRow = input.serialId
    ? await trx.db
        .selectFrom('inventory_serials')
        .selectAll()
        .where('tenant_id', '=', trx.tenantId)
        .where('id', '=', input.serialId)
        .where('product_id', '=', input.productId)
        .forUpdate()
        .executeTakeFirst()
    : undefined;

  if (input.serialId) {
    if (!serialRow) {
      throw new AppError({
        statusCode: 404,
        errorCode: 'INV_SERIAL_NOT_FOUND',
        title: 'Serial Number Not Found',
        detail: `Serial "${input.serialId}" not found for product "${product.sku}".`,
      });
    }

    if (qtyDelta.isNegative()) {
      if (serialRow.status !== 'IN_STOCK' && !negativeStockOverrideApplied) {
        throw new AppError({
          statusCode: 409,
          errorCode: 'INV_SERIAL_NOT_AVAILABLE',
          title: 'Serial Number Not Available',
          detail: `Serial "${serialRow.serial_number}" is currently "${serialRow.status}" and cannot be issued.`,
        });
      }
    }
  }

  // Enforce server-side negative-stock policy
  if (qtyDelta.isNegative() && balanceAfter.isNegative()) {
    if (!warehouseMeta.allowNegativeStock) {
      if (!input.allowNegativeStockOverride) {
        throw new AppError({
          statusCode: 409,
          errorCode: 'INV_INSUFFICIENT_AVAILABLE_STOCK',
          title: 'Insufficient Available Stock',
          detail: `Warehouse "${input.warehouseId}" has ${balanceBefore.toDecimalString()} ${product.baseUom} on hand for product "${product.sku}", which is insufficient for outbound delta ${qtyDelta.toDecimalString()} ${product.baseUom}.`,
          extensions: {
            warehouseId: input.warehouseId,
            productId: input.productId,
            availableQty: balanceBefore.toDecimalString(),
            requestedDelta: qtyDelta.toDecimalString(),
          },
        });
      }

      // Privileged negative-stock override requires `inv:movement:reverse` and an explicit overrideReason
      await assertAuthorized(trx, {
        permission: 'inv:movement:reverse',
        branchId: input.branchId,
        warehouseId: input.warehouseId,
      });

      const overrideReason = input.overrideReason?.trim() ?? '';
      if (overrideReason.length < 5) {
        throw new AppError({
          statusCode: 400,
          errorCode: 'ERR_VALIDATION_FAILED',
          title: 'Negative Stock Override Reason Required',
          detail:
            'Enabling allowNegativeStockOverride requires an explicit overrideReason of at least 5 characters.',
        });
      }

      negativeStockOverrideApplied = true;
    }
  }

  const movementId = generateUuidV7();
  const now = new Date();
  const occurredAt = input.occurredAt ? new Date(input.occurredAt) : now;
  const reason =
    input.overrideReason?.trim() || movementReason;

  // Costing & Valuation computation (FIFO vs Moving Average Cost)
  let unitCostSnapshot = unitCostMoney;
  let totalCostDelta = unitCostMoney.multiplyByQuantity(qtyDelta);
  let nextMovingAvgCost = unitCostMoney;
  let nextTotalInventoryValue = unitCostMoney.multiplyByQuantity(
    balanceAfter.isNegative() ? Quantity.zero() : balanceAfter,
  );
  let updatedFifoLayers: readonly FifoCostLayer[] = [];

  if (product.valuationMethod === 'FIFO') {
    if (qtyDelta.isPositive()) {
      totalCostDelta = unitCostMoney.multiplyByQuantity(qtyDelta);
      const existingTotalVal = existingBalance
        ? Money.fromDecimalString(
            String(existingBalance.total_inventory_value),
            baseCurrency,
          )
        : Money.zero(baseCurrency);
      nextTotalInventoryValue = existingTotalVal.add(totalCostDelta);
      nextMovingAvgCost = balanceAfter.isPositive()
        ? Money.fromScaledUnits(
            divideAndRoundBigInt(
              nextTotalInventoryValue.scaledUnits * QUANTITY_SCALE_FACTOR,
              balanceAfter.microUnits,
              'HALF_EVEN',
            ),
            baseCurrency,
          )
        : unitCostMoney;
    } else {
      const openLayers = await trx.db
        .selectFrom('inventory_cost_layers')
        .selectAll()
        .where('tenant_id', '=', trx.tenantId)
        .where('warehouse_id', '=', input.warehouseId)
        .where('product_id', '=', input.productId)
        .where('status', '=', 'OPEN')
        .orderBy('layer_date', 'asc')
        .orderBy('created_at', 'asc')
        .forUpdate()
        .execute();

      const fifoLayers: FifoCostLayer[] = openLayers.map((l) => ({
        layerId: l.id,
        batchId: l.batch_id ?? '',
        remainingQty: Quantity.fromDecimalString(String(l.remaining_qty)),
        unitCost: Money.fromDecimalString(String(l.unit_cost), baseCurrency),
      }));

      const consumption = consumeFifoCostLayers({
        layers: fifoLayers,
        qtyToConsume: qtyDelta.abs(),
        fallbackUnitCost: unitCostMoney,
        allowNegativeStock:
          warehouseMeta.allowNegativeStock || negativeStockOverrideApplied,
      });

      updatedFifoLayers = consumption.updatedLayers;
      totalCostDelta = consumption.totalCogs.negate();
      unitCostSnapshot = consumption.effectiveUnitCostSnapshot;

      const existingTotalVal = existingBalance
        ? Money.fromDecimalString(
            String(existingBalance.total_inventory_value),
            baseCurrency,
          )
        : Money.zero(baseCurrency);
      nextTotalInventoryValue = existingTotalVal.subtract(consumption.totalCogs);
      if (nextTotalInventoryValue.isNegative()) {
        nextTotalInventoryValue = Money.zero(baseCurrency);
      }
      nextMovingAvgCost = balanceAfter.isPositive()
        ? Money.fromScaledUnits(
            divideAndRoundBigInt(
              nextTotalInventoryValue.scaledUnits * QUANTITY_SCALE_FACTOR,
              balanceAfter.microUnits,
              'HALF_EVEN',
            ),
            baseCurrency,
          )
        : unitCostMoney;
    }
  } else {
    // MOVING_AVG
    const currentMac = existingBalance
      ? Money.fromDecimalString(
          String(existingBalance.moving_avg_cost),
          baseCurrency,
        )
      : unitCostMoney;
    const currentTotalVal = existingBalance
      ? Money.fromDecimalString(
          String(existingBalance.total_inventory_value),
          baseCurrency,
        )
      : Money.zero(baseCurrency);

    if (qtyDelta.isPositive()) {
      const macResult = applyMacReceipt({
        currentState: {
          qtyOnHand: balanceBefore,
          movingAvgCost: currentMac,
          totalInventoryValue: currentTotalVal,
        },
        qtyReceived: qtyDelta,
        receiptUnitCost: unitCostMoney,
      });
      nextMovingAvgCost = macResult.newState.movingAvgCost;
      nextTotalInventoryValue = macResult.newState.totalInventoryValue;
      totalCostDelta = macResult.inventoryAssetCostDelta;
    } else {
      const issueResult = applyMacOutboundIssue({
        currentState: {
          qtyOnHand: balanceBefore,
          movingAvgCost: currentMac,
          totalInventoryValue: currentTotalVal,
        },
        qtyIssued: qtyDelta.abs(),
        allowNegativeStock:
          warehouseMeta.allowNegativeStock || negativeStockOverrideApplied,
      });
      nextMovingAvgCost = issueResult.newState.movingAvgCost;
      nextTotalInventoryValue = issueResult.newState.totalInventoryValue;
      totalCostDelta = issueResult.inventoryAssetCostDelta;
      unitCostSnapshot = issueResult.unitCostSnapshot;
    }
  }

  // 1. Insert immutable ledger entry FIRST so `inventory_balances_ledger_integrity_trg` succeeds
  await trx.db
    .insertInto('stock_ledger_entries')
    .values({
      id: movementId,
      tenant_id: trx.tenantId,
      branch_id: input.branchId,
      warehouse_id: input.warehouseId,
      product_id: input.productId,
      batch_id: input.batchId ?? null,
      serial_id: input.serialId ?? null,
      supplier_id: supplierId,
      movement_type: input.movementType,
      uom_code: uomCode,
      input_qty: inputQty.toDecimalString(),
      conversion_factor_to_base: conversionFactorStr,
      qty_delta: qtyDelta.toDecimalString(),
      balance_before: balanceBefore.toDecimalString(),
      balance_after: balanceAfter.toDecimalString(),
      unit_cost: unitCostSnapshot.toDecimalString(),
      total_cost_delta: totalCostDelta.toDecimalString(),
      reference_type: input.referenceType?.trim() || null,
      reference_id: input.referenceId?.trim() || null,
      reversed_entry_id: null,
      reason,
      negative_stock_override_applied: negativeStockOverrideApplied,
      actor_user_id: trx.userId,
      idempotency_key: idempotencyKey,
      occurred_at: occurredAt,
      recorded_at: now,
      metadata_json: {
        sku: product.sku,
        baseUom: product.baseUom,
      },
    })
    .execute();

  // 2. Atomically maintain `inventory_balances` row
  if (existingBalance) {
    const nextSyncVersion = Number(existingBalance.sync_version) + 1;
    await trx.db
      .updateTable('inventory_balances')
      .set({
        qty_on_hand: balanceAfter.toDecimalString(),
        moving_avg_cost: nextMovingAvgCost.toDecimalString(),
        total_inventory_value: nextTotalInventoryValue.toDecimalString(),
        last_ledger_entry_id: movementId,
        last_movement_at: occurredAt,
        sync_version: nextSyncVersion,
        updated_at: now,
      })
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', existingBalance.id)
      .execute();
  } else {
    await trx.db
      .insertInto('inventory_balances')
      .values({
        id: generateUuidV7(),
        tenant_id: trx.tenantId,
        branch_id: input.branchId,
        warehouse_id: input.warehouseId,
        product_id: input.productId,
        uom_code: product.baseUom,
        qty_on_hand: balanceAfter.toDecimalString(),
        qty_reserved: Quantity.zero().toDecimalString(),
        qty_in_transit: Quantity.zero().toDecimalString(),
        qty_damaged: Quantity.zero().toDecimalString(),
        moving_avg_cost: nextMovingAvgCost.toDecimalString(),
        total_inventory_value: nextTotalInventoryValue.toDecimalString(),
        last_ledger_entry_id: movementId,
        last_movement_at: occurredAt,
        sync_version: 1,
        updated_at: now,
      })
      .execute();
  }

  // 3. Update FIFO cost layers
  if (product.valuationMethod === 'FIFO') {
    if (qtyDelta.isPositive()) {
      await trx.db
        .insertInto('inventory_cost_layers')
        .values({
          id: generateUuidV7(),
          tenant_id: trx.tenantId,
          warehouse_id: input.warehouseId,
          product_id: input.productId,
          batch_id: input.batchId ?? null,
          ledger_entry_id: movementId,
          layer_date: occurredAt,
          received_qty: qtyDelta.toDecimalString(),
          remaining_qty: qtyDelta.toDecimalString(),
          unit_cost: unitCostMoney.toDecimalString(),
          currency_code: baseCurrency,
          status: 'OPEN',
          created_at: now,
          updated_at: now,
        })
        .execute();
    } else {
      for (const layer of updatedFifoLayers) {
        await trx.db
          .updateTable('inventory_cost_layers')
          .set({
            remaining_qty: layer.remainingQty.toDecimalString(),
            status: layer.remainingQty.isZero() ? 'DEPLETED' : 'OPEN',
            updated_at: now,
          })
          .where('tenant_id', '=', trx.tenantId)
          .where('id', '=', layer.layerId)
          .execute();
      }
    }
  }

  // 4. Update Batch current_quantity
  if (batchRow) {
    if (qtyDelta.isPositive()) {
      const currentBatchQty = Quantity.fromDecimalString(
        String(batchRow.current_quantity),
      );
      const newBatchQty = currentBatchQty.add(qtyDelta);
      await trx.db
        .updateTable('inventory_batches')
        .set({
          current_quantity: newBatchQty.toDecimalString(),
          status: 'ACTIVE',
          updated_at: now,
        })
        .where('tenant_id', '=', trx.tenantId)
        .where('id', '=', batchRow.id)
        .execute();
    } else {
      const currentBatchQty = Quantity.fromDecimalString(
        String(batchRow.current_quantity),
      );
      const newBatchQty = currentBatchQty.subtract(qtyDelta.abs());
      const finalQty = newBatchQty.isNegative() ? Quantity.zero() : newBatchQty;
      await trx.db
        .updateTable('inventory_batches')
        .set({
          current_quantity: finalQty.toDecimalString(),
          status: finalQty.isZero() ? 'DEPLETED' : 'ACTIVE',
          updated_at: now,
        })
        .where('tenant_id', '=', trx.tenantId)
        .where('id', '=', batchRow.id)
        .execute();
    }
  }

  // 5. Update Serial status and audit transition
  if (serialRow) {
    if (qtyDelta.isNegative()) {
      const nextStatus =
        input.movementType === 'STOCK_OUT' ? 'SOLD' : 'WRITTEN_OFF';
      await trx.db
        .updateTable('inventory_serials')
        .set({
          status: nextStatus,
          sold_at: nextStatus === 'SOLD' ? now : serialRow.sold_at,
          last_movement_id: movementId,
          updated_at: now,
        })
        .where('tenant_id', '=', trx.tenantId)
        .where('id', '=', serialRow.id)
        .execute();

      await trx.db
        .insertInto('inventory_serial_transitions')
        .values({
          id: generateUuidV7(),
          tenant_id: trx.tenantId,
          serial_id: serialRow.id,
          from_status: serialRow.status,
          to_status: nextStatus,
          reference_type: 'STOCK_MOVEMENT',
          reference_id: movementId,
          actor_user_id: trx.userId,
          notes: reason ?? `Movement ${input.movementType}`,
          occurred_at: now,
        })
        .execute();
    } else {
      await trx.db
        .updateTable('inventory_serials')
        .set({
          status: 'IN_STOCK',
          last_movement_id: movementId,
          updated_at: now,
        })
        .where('tenant_id', '=', trx.tenantId)
        .where('id', '=', serialRow.id)
        .execute();

      await trx.db
        .insertInto('inventory_serial_transitions')
        .values({
          id: generateUuidV7(),
          tenant_id: trx.tenantId,
          serial_id: serialRow.id,
          from_status: serialRow.status,
          to_status: 'IN_STOCK',
          reference_type: 'STOCK_MOVEMENT',
          reference_id: movementId,
          actor_user_id: trx.userId,
          notes: reason ?? `Movement ${input.movementType}`,
          occurred_at: now,
        })
        .execute();
    }
  }

  await appendAuditLog(trx, {
    action: negativeStockOverrideApplied
      ? 'INV_NEGATIVE_STOCK_OVERRIDE_APPLIED'
      : 'INV_STOCK_MOVEMENT_POSTED',
    resourceType: 'STOCK_LEDGER_ENTRY',
    resourceId: movementId,
    metadata: {
      branchId: input.branchId,
      warehouseId: input.warehouseId,
      productId: input.productId,
      supplierId,
      movementType: input.movementType,
      uomCode,
      inputQty: inputQty.toDecimalString(),
      qtyDelta: qtyDelta.toDecimalString(),
      balanceBefore: balanceBefore.toDecimalString(),
      balanceAfter: balanceAfter.toDecimalString(),
      reason,
      negativeStockOverrideApplied,
    },
  });

  await enqueueOutboxEvent(trx, {
    aggregateType: 'INVENTORY_BALANCE',
    aggregateId: input.productId,
    eventType: 'STOCK_BALANCE_CHANGED',
    payload: {
      movementId,
      branchId: input.branchId,
      warehouseId: input.warehouseId,
      productId: input.productId,
      qtyDelta: qtyDelta.toDecimalString(),
      balanceAfter: balanceAfter.toDecimalString(),
    },
  });

  const inserted = await trx.db
    .selectFrom('stock_ledger_entries')
    .selectAll()
    .where('id', '=', movementId)
    .executeTakeFirstOrThrow();

  return mapStockMovementRow(
    {
      ...inserted,
      product_sku: product.sku,
      product_name: product.name,
    },
    baseCurrency,
  );
}

export async function reverseStockMovement(
  trx: TenantTransactionContext,
  movementIdToReverse: string,
  idempotencyKey: string,
  input: ReverseStockMovementRequest,
): Promise<StockMovementResponse> {
  const original = await trx.db
    .selectFrom('stock_ledger_entries')
    .selectAll()
    .where('id', '=', movementIdToReverse)
    .executeTakeFirst();

  if (!original) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'ERR_NOT_FOUND',
      title: 'Stock Movement Not Found',
      detail: `Stock movement "${movementIdToReverse}" was not found in tenant "${trx.tenantId}".`,
    });
  }

  await assertAuthorized(trx, {
    permission: 'inv:movement:reverse',
    branchId: original.branch_id,
    warehouseId: original.warehouse_id,
  });

  await assertSubscriptionEntitlement(trx, {
    requireWriteAccess: true,
  });

  const reason = input.reason.trim();
  if (reason.length < 5) {
    throw new AppError({
      statusCode: 400,
      errorCode: 'ERR_VALIDATION_FAILED',
      title: 'Reversal Reason Required',
      detail: 'Reversing a stock movement requires a reason of at least 5 characters.',
    });
  }

  if (
    original.movement_type === 'CORRECTION_REVERSAL' ||
    original.reversed_entry_id !== null
  ) {
    throw new AppError({
      statusCode: 409,
      errorCode: 'INV_MOVEMENT_ALREADY_REVERSED',
      title: 'Cannot Reverse a Reversal Entry',
      detail: `Stock movement "${original.id}" is already a reversal entry and cannot be reversed.`,
    });
  }

  // Check if already reversed
  const alreadyReversed = await trx.db
    .selectFrom('stock_ledger_entries')
    .select(['id'])
    .where('tenant_id', '=', trx.tenantId)
    .where('reversed_entry_id', '=', original.id)
    .executeTakeFirst();

  if (alreadyReversed) {
    throw new AppError({
      statusCode: 409,
      errorCode: 'INV_MOVEMENT_ALREADY_REVERSED',
      title: 'Stock Movement Already Reversed',
      detail: `Stock movement "${original.id}" has already been reversed by entry "${alreadyReversed.id}".`,
    });
  }

  const warehouseMeta = await verifyBranchAndWarehouseRelationship(
    trx,
    original.branch_id,
    original.warehouse_id,
  );
  const product = await resolveProductForInventory(trx, original.product_id);
  const baseCurrency = await getTenantBaseCurrency(trx);

  const existingBalance = await lockWarehouseProductBalance(
    trx,
    original.warehouse_id,
    original.product_id,
  );

  const originalInputQty = Quantity.fromDecimalString(
    String(original.input_qty),
  );
  const originalQtyDelta = Quantity.fromDecimalString(
    String(original.qty_delta),
  );
  const reversalInputQty = originalInputQty.negate();
  const reversalQtyDelta = originalQtyDelta.negate();

  const balanceBefore = existingBalance
    ? Quantity.fromDecimalString(String(existingBalance.qty_on_hand))
    : Quantity.zero();
  const balanceAfter = balanceBefore.add(reversalQtyDelta);

  let negativeStockOverrideApplied = false;
  if (reversalQtyDelta.isNegative() && balanceAfter.isNegative()) {
    if (!warehouseMeta.allowNegativeStock) {
      if (!input.allowNegativeStockOverride) {
        throw new AppError({
          statusCode: 409,
          errorCode: 'INV_INSUFFICIENT_AVAILABLE_STOCK',
          title: 'Insufficient Available Stock for Reversal',
          detail: `Reversing movement "${original.id}" would reduce stock in warehouse "${original.warehouse_id}" to ${balanceAfter.toDecimalString()} ${product.baseUom}.`,
        });
      }
      negativeStockOverrideApplied = true;
    }
  }

  const reversalId = generateUuidV7();
  const now = new Date();
  const occurredAt = input.occurredAt ? new Date(input.occurredAt) : now;
  const unitCostMoney = Money.fromDecimalString(
    String(original.unit_cost),
    baseCurrency,
  );

  await trx.db
    .insertInto('stock_ledger_entries')
    .values({
      id: reversalId,
      tenant_id: trx.tenantId,
      branch_id: original.branch_id,
      warehouse_id: original.warehouse_id,
      product_id: original.product_id,
      batch_id: original.batch_id ?? null,
      serial_id: original.serial_id ?? null,
      supplier_id: original.supplier_id,
      movement_type: 'CORRECTION_REVERSAL',
      uom_code: original.uom_code,
      input_qty: reversalInputQty.toDecimalString(),
      conversion_factor_to_base: String(original.conversion_factor_to_base),
      qty_delta: reversalQtyDelta.toDecimalString(),
      balance_before: balanceBefore.toDecimalString(),
      balance_after: balanceAfter.toDecimalString(),
      unit_cost: unitCostMoney.toDecimalString(),
      total_cost_delta: original.total_cost_delta
        ? Money.fromDecimalString(
            String(original.total_cost_delta),
            baseCurrency,
          )
            .negate()
            .toDecimalString()
        : '0.0000',
      reference_type: 'REVERSAL',
      reference_id: original.id,
      reversed_entry_id: original.id,
      reason,
      negative_stock_override_applied: negativeStockOverrideApplied,
      actor_user_id: trx.userId,
      idempotency_key: idempotencyKey,
      occurred_at: occurredAt,
      recorded_at: now,
      metadata_json: {
        reversedMovementType: original.movement_type,
        reversedMovementId: original.id,
      },
    })
    .execute();

  const totalValue = unitCostMoney.multiplyByQuantity(
    balanceAfter.isNegative() ? Quantity.zero() : balanceAfter,
  );

  if (existingBalance) {
    const nextSyncVersion = Number(existingBalance.sync_version) + 1;
    await trx.db
      .updateTable('inventory_balances')
      .set({
        qty_on_hand: balanceAfter.toDecimalString(),
        total_inventory_value: totalValue.toDecimalString(),
        last_ledger_entry_id: reversalId,
        last_movement_at: occurredAt,
        sync_version: nextSyncVersion,
        updated_at: now,
      })
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', existingBalance.id)
      .execute();
  }

  // Restore Batch quantity on reversal if batch_id was present
  if (original.batch_id) {
    const bRow = await trx.db
      .selectFrom('inventory_batches')
      .select(['id', 'current_quantity'])
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', original.batch_id)
      .forUpdate()
      .executeTakeFirst();

    if (bRow) {
      const cur = Quantity.fromDecimalString(String(bRow.current_quantity));
      const nextBatchQty = cur.add(reversalQtyDelta);
      const finalQty = nextBatchQty.isNegative() ? Quantity.zero() : nextBatchQty;
      await trx.db
        .updateTable('inventory_batches')
        .set({
          current_quantity: finalQty.toDecimalString(),
          status: finalQty.isZero() ? 'DEPLETED' : 'ACTIVE',
          updated_at: now,
        })
        .where('tenant_id', '=', trx.tenantId)
        .where('id', '=', bRow.id)
        .execute();
    }
  }

  // Restore Serial status on reversal if serial_id was present
  if (original.serial_id) {
    const sRow = await trx.db
      .selectFrom('inventory_serials')
      .select(['id', 'status'])
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', original.serial_id)
      .forUpdate()
      .executeTakeFirst();

    if (sRow) {
      const restoredStatus = reversalQtyDelta.isPositive() ? 'IN_STOCK' : 'SOLD';
      await trx.db
        .updateTable('inventory_serials')
        .set({
          status: restoredStatus,
          last_movement_id: reversalId,
          sold_at: restoredStatus === 'IN_STOCK' ? null : now,
          updated_at: now,
        })
        .where('tenant_id', '=', trx.tenantId)
        .where('id', '=', sRow.id)
        .execute();

      await trx.db
        .insertInto('inventory_serial_transitions')
        .values({
          id: generateUuidV7(),
          tenant_id: trx.tenantId,
          serial_id: sRow.id,
          from_status: sRow.status,
          to_status: restoredStatus,
          reference_type: 'MOVEMENT_REVERSAL',
          reference_id: reversalId,
          actor_user_id: trx.userId,
          notes: `Reversal of movement ${original.id}`,
          occurred_at: now,
        })
        .execute();
    }
  }

  await appendAuditLog(trx, {
    action: 'INV_STOCK_MOVEMENT_REVERSED',
    resourceType: 'STOCK_LEDGER_ENTRY',
    resourceId: reversalId,
    metadata: {
      reversedEntryId: original.id,
      branchId: original.branch_id,
      warehouseId: original.warehouse_id,
      productId: original.product_id,
      reversalQtyDelta: reversalQtyDelta.toDecimalString(),
      balanceBefore: balanceBefore.toDecimalString(),
      balanceAfter: balanceAfter.toDecimalString(),
      reason,
    },
  });

  const inserted = await trx.db
    .selectFrom('stock_ledger_entries')
    .selectAll()
    .where('id', '=', reversalId)
    .executeTakeFirstOrThrow();

  return mapStockMovementRow(
    {
      ...inserted,
      product_sku: product.sku,
      product_name: product.name,
    },
    baseCurrency,
  );
}

export async function getStockMovementById(
  trx: TenantTransactionContext,
  movementId: string,
): Promise<StockMovementResponse> {
  const row = await trx.db
    .selectFrom('stock_ledger_entries')
    .leftJoin('products', (join) =>
      join
        .onRef('stock_ledger_entries.tenant_id', '=', 'products.tenant_id')
        .onRef('stock_ledger_entries.product_id', '=', 'products.id'),
    )
    .select([
      'stock_ledger_entries.id as id',
      'stock_ledger_entries.tenant_id as tenant_id',
      'stock_ledger_entries.branch_id as branch_id',
      'stock_ledger_entries.warehouse_id as warehouse_id',
      'stock_ledger_entries.product_id as product_id',
      'products.sku as product_sku',
      'products.name as product_name',
      'stock_ledger_entries.batch_id as batch_id',
      'stock_ledger_entries.serial_id as serial_id',
      'stock_ledger_entries.supplier_id as supplier_id',
      'stock_ledger_entries.movement_type as movement_type',
      'stock_ledger_entries.uom_code as uom_code',
      'stock_ledger_entries.input_qty as input_qty',
      'stock_ledger_entries.conversion_factor_to_base as conversion_factor_to_base',
      'stock_ledger_entries.qty_delta as qty_delta',
      'stock_ledger_entries.balance_before as balance_before',
      'stock_ledger_entries.balance_after as balance_after',
      'stock_ledger_entries.unit_cost as unit_cost',
      'stock_ledger_entries.total_cost_delta as total_cost_delta',
      'stock_ledger_entries.reference_type as reference_type',
      'stock_ledger_entries.reference_id as reference_id',
      'stock_ledger_entries.reversed_entry_id as reversed_entry_id',
      'stock_ledger_entries.reason as reason',
      'stock_ledger_entries.negative_stock_override_applied as negative_stock_override_applied',
      'stock_ledger_entries.actor_user_id as actor_user_id',
      'stock_ledger_entries.idempotency_key as idempotency_key',
      'stock_ledger_entries.occurred_at as occurred_at',
      'stock_ledger_entries.recorded_at as recorded_at',
    ])
    .where('stock_ledger_entries.id', '=', movementId)
    .executeTakeFirst();

  if (!row) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'ERR_NOT_FOUND',
      title: 'Stock Movement Not Found',
      detail: `Stock movement "${movementId}" was not found.`,
    });
  }

  await assertAuthorized(trx, {
    permission: 'inv:movement:read',
    branchId: row.branch_id,
    warehouseId: row.warehouse_id,
  });

  await assertSubscriptionEntitlement(trx, {
    requireWriteAccess: false,
  });

  const baseCurrency = await getTenantBaseCurrency(trx);
  return mapStockMovementRow(row, baseCurrency);
}

export async function listStockMovements(
  trx: TenantTransactionContext,
  query: ListStockMovementsQuery,
): Promise<CursorPaginatedResult<StockMovementResponse>> {
  const authCtx = await assertAuthorized(trx, {
    permission: 'inv:movement:read',
    ...(query.branchId ? { branchId: query.branchId } : {}),
    ...(query.warehouseId ? { warehouseId: query.warehouseId } : {}),
  });

  await assertSubscriptionEntitlement(trx, {
    requireWriteAccess: false,
  });

  const limit = Math.min(Math.max(Number(query.limit ?? 50), 1), 100);
  const baseCurrency = await getTenantBaseCurrency(trx);

  let dbQuery = trx.db
    .selectFrom('stock_ledger_entries')
    .leftJoin('products', (join) =>
      join
        .onRef('stock_ledger_entries.tenant_id', '=', 'products.tenant_id')
        .onRef('stock_ledger_entries.product_id', '=', 'products.id'),
    )
    .select([
      'stock_ledger_entries.id as id',
      'stock_ledger_entries.tenant_id as tenant_id',
      'stock_ledger_entries.branch_id as branch_id',
      'stock_ledger_entries.warehouse_id as warehouse_id',
      'stock_ledger_entries.product_id as product_id',
      'products.sku as product_sku',
      'products.name as product_name',
      'stock_ledger_entries.batch_id as batch_id',
      'stock_ledger_entries.serial_id as serial_id',
      'stock_ledger_entries.supplier_id as supplier_id',
      'stock_ledger_entries.movement_type as movement_type',
      'stock_ledger_entries.uom_code as uom_code',
      'stock_ledger_entries.input_qty as input_qty',
      'stock_ledger_entries.conversion_factor_to_base as conversion_factor_to_base',
      'stock_ledger_entries.qty_delta as qty_delta',
      'stock_ledger_entries.balance_before as balance_before',
      'stock_ledger_entries.balance_after as balance_after',
      'stock_ledger_entries.unit_cost as unit_cost',
      'stock_ledger_entries.total_cost_delta as total_cost_delta',
      'stock_ledger_entries.reference_type as reference_type',
      'stock_ledger_entries.reference_id as reference_id',
      'stock_ledger_entries.reversed_entry_id as reversed_entry_id',
      'stock_ledger_entries.reason as reason',
      'stock_ledger_entries.negative_stock_override_applied as negative_stock_override_applied',
      'stock_ledger_entries.actor_user_id as actor_user_id',
      'stock_ledger_entries.idempotency_key as idempotency_key',
      'stock_ledger_entries.occurred_at as occurred_at',
      'stock_ledger_entries.recorded_at as recorded_at',
    ])
    .orderBy('stock_ledger_entries.id', 'desc');

  if (query.branchId) {
    dbQuery = dbQuery.where('stock_ledger_entries.branch_id', '=', query.branchId);
  }
  if (query.warehouseId) {
    dbQuery = dbQuery.where('stock_ledger_entries.warehouse_id', '=', query.warehouseId);
  }
  if (query.productId) {
    dbQuery = dbQuery.where('stock_ledger_entries.product_id', '=', query.productId);
  }
  if (query.supplierId) {
    dbQuery = dbQuery.where('stock_ledger_entries.supplier_id', '=', query.supplierId);
  }
  if (query.movementType) {
    dbQuery = dbQuery.where('stock_ledger_entries.movement_type', '=', query.movementType);
  }
  if (query.cursor) {
    dbQuery = dbQuery.where('stock_ledger_entries.id', '<', query.cursor);
  }

  if (!authCtx.allLocationsAccess) {
    const allowedWh = [...authCtx.allowedWarehouseIds];
    if (allowedWh.length === 0) {
      return {
        data: [],
        pageInfo: { hasNextPage: false, nextCursor: null },
      };
    }
    dbQuery = dbQuery.where('stock_ledger_entries.warehouse_id', 'in', allowedWh);
  }

  const rows = await dbQuery.limit(limit + 1).execute();
  const pageRows = rows.slice(0, limit);
  const hasNextPage = rows.length > limit;
  const nextCursor =
    hasNextPage && pageRows.length > 0
      ? pageRows[pageRows.length - 1]!.id
      : null;

  return {
    data: pageRows.map((r) => mapStockMovementRow(r, baseCurrency)),
    pageInfo: {
      hasNextPage,
      nextCursor,
    },
  };
}

// ============================================================================
// Inventory Balances & Ledger Reconciliation (Section 4E)
// ============================================================================

export function computeStockAlertState(params: {
  readonly qtyOnHand: Quantity;
  readonly reorderPoint: Quantity;
}): {
  readonly isZeroStock: boolean;
  readonly isLowStock: boolean;
  readonly stockState: StockAlertState;
} {
  if (params.qtyOnHand.isNegative()) {
    return {
      isZeroStock: false,
      isLowStock: true,
      stockState: 'NEGATIVE_STOCK',
    };
  }
  if (params.qtyOnHand.isZero()) {
    return {
      isZeroStock: true,
      isLowStock: params.reorderPoint.isPositive(),
      stockState: 'ZERO_STOCK',
    };
  }
  if (
    params.reorderPoint.isPositive() &&
    params.qtyOnHand.compare(params.reorderPoint) <= 0
  ) {
    return {
      isZeroStock: false,
      isLowStock: true,
      stockState: 'LOW_STOCK',
    };
  }
  return {
    isZeroStock: false,
    isLowStock: false,
    stockState: 'OK',
  };
}

export async function listInventoryBalances(
  trx: TenantTransactionContext,
  query: ListInventoryBalancesQuery,
): Promise<CursorPaginatedResult<InventoryBalanceResponse>> {
  const authCtx = await assertAuthorized(trx, {
    permission: 'inv:balance:read',
    ...(query.branchId ? { branchId: query.branchId } : {}),
    ...(query.warehouseId ? { warehouseId: query.warehouseId } : {}),
  });

  await assertSubscriptionEntitlement(trx, {
    requireWriteAccess: false,
  });

  const limit = Math.min(Math.max(Number(query.limit ?? 50), 1), 100);
  const baseCurrency = await getTenantBaseCurrency(trx);
  const includeZeroStock = query.includeZeroStock !== 'false';

  let dbQuery = trx.db
    .selectFrom('inventory_balances')
    .innerJoin('products', (join) =>
      join
        .onRef('products.tenant_id', '=', 'inventory_balances.tenant_id')
        .onRef('products.id', '=', 'inventory_balances.product_id'),
    )
    .select([
      'inventory_balances.id as id',
      'inventory_balances.tenant_id as tenant_id',
      'inventory_balances.branch_id as branch_id',
      'inventory_balances.warehouse_id as warehouse_id',
      'inventory_balances.product_id as product_id',
      'inventory_balances.uom_code as uom_code',
      'inventory_balances.qty_on_hand as qty_on_hand',
      'inventory_balances.qty_reserved as qty_reserved',
      'inventory_balances.qty_in_transit as qty_in_transit',
      'inventory_balances.qty_damaged as qty_damaged',
      'inventory_balances.moving_avg_cost as moving_avg_cost',
      'inventory_balances.total_inventory_value as total_inventory_value',
      'inventory_balances.last_ledger_entry_id as last_ledger_entry_id',
      'inventory_balances.last_movement_at as last_movement_at',
      'inventory_balances.sync_version as sync_version',
      'products.sku as sku',
      'products.name as product_name',
      'products.reorder_point as reorder_point',
      'products.reorder_qty as reorder_qty',
    ])
    .orderBy('inventory_balances.id', 'asc');

  if (query.branchId) {
    dbQuery = dbQuery.where(
      'inventory_balances.branch_id',
      '=',
      query.branchId,
    );
  }
  if (query.warehouseId) {
    dbQuery = dbQuery.where(
      'inventory_balances.warehouse_id',
      '=',
      query.warehouseId,
    );
  }
  if (query.productId) {
    dbQuery = dbQuery.where(
      'inventory_balances.product_id',
      '=',
      query.productId,
    );
  }
  if (query.cursor) {
    dbQuery = dbQuery.where('inventory_balances.id', '>', query.cursor);
  }

  if (!authCtx.allLocationsAccess) {
    const allowedWh = [...authCtx.allowedWarehouseIds];
    if (allowedWh.length === 0) {
      return {
        data: [],
        pageInfo: { hasNextPage: false, nextCursor: null },
      };
    }
    dbQuery = dbQuery.where(
      'inventory_balances.warehouse_id',
      'in',
      allowedWh,
    );
  }

  const rows = await dbQuery.execute();
  const searchLower = query.search?.trim().toLowerCase();

  const mapped: InventoryBalanceResponse[] = [];
  for (const r of rows) {
    if (
      searchLower &&
      !r.sku.toLowerCase().includes(searchLower) &&
      !r.product_name.toLowerCase().includes(searchLower)
    ) {
      continue;
    }

    const qtyOnHand = Quantity.fromDecimalString(String(r.qty_on_hand));
    const qtyReserved = Quantity.fromDecimalString(String(r.qty_reserved));
    const qtyInTransit = Quantity.fromDecimalString(String(r.qty_in_transit));
    const qtyDamaged = Quantity.fromDecimalString(String(r.qty_damaged));
    const availableQty = qtyOnHand.subtract(qtyReserved);
    const reorderPoint = Quantity.fromDecimalString(String(r.reorder_point));
    const reorderQty = Quantity.fromDecimalString(String(r.reorder_qty));

    const alert = computeStockAlertState({ qtyOnHand, reorderPoint });

    if (!includeZeroStock && alert.isZeroStock) {
      continue;
    }
    if (
      query.stockState &&
      query.stockState !== 'ALL' &&
      alert.stockState !== query.stockState
    ) {
      continue;
    }

    mapped.push({
      id: r.id,
      tenantId: r.tenant_id,
      branchId: r.branch_id,
      warehouseId: r.warehouse_id,
      productId: r.product_id,
      sku: r.sku,
      productName: r.product_name,
      uomCode: r.uom_code,
      qtyOnHand: qtyOnHand.toDecimalString(),
      qtyReserved: qtyReserved.toDecimalString(),
      qtyInTransit: qtyInTransit.toDecimalString(),
      qtyDamaged: qtyDamaged.toDecimalString(),
      availableQty: availableQty.toDecimalString(),
      reorderPoint: reorderPoint.toDecimalString(),
      reorderQty: reorderQty.toDecimalString(),
      isZeroStock: alert.isZeroStock,
      isLowStock: alert.isLowStock,
      stockState: alert.stockState,
      movingAvgCost: Money.fromDecimalString(
        String(r.moving_avg_cost),
        baseCurrency,
      ).toDecimalString(),
      totalInventoryValue: Money.fromDecimalString(
        String(r.total_inventory_value),
        baseCurrency,
      ).toDecimalString(),
      lastLedgerEntryId: r.last_ledger_entry_id,
      lastMovementAt: new Date(r.last_movement_at).toISOString(),
      syncVersion: Number(r.sync_version),
    });
  }

  const pageRows = mapped.slice(0, limit);
  const hasNextPage = mapped.length > limit;
  const nextCursor =
    hasNextPage && pageRows.length > 0
      ? pageRows[pageRows.length - 1]!.id
      : null;

  return {
    data: pageRows,
    pageInfo: {
      hasNextPage,
      nextCursor,
    },
  };
}

/**
 * Reconciles materialized `inventory_balances` against the authoritative
 * `stock_ledger_entries` history using fixed-point `Quantity` arithmetic.
 */
export async function reconcileInventoryBalances(
  trx: TenantTransactionContext,
  options?: {
    readonly branchId?: string | undefined;
    readonly warehouseId?: string | undefined;
    readonly productId?: string | undefined;
  },
): Promise<InventoryReconciliationResponse> {
  const authCtx = await assertAuthorized(trx, {
    permission: 'inv:balance:read',
    ...(options?.branchId ? { branchId: options.branchId } : {}),
    ...(options?.warehouseId ? { warehouseId: options.warehouseId } : {}),
  });

  await assertSubscriptionEntitlement(trx, {
    requireWriteAccess: false,
  });

  let balanceQuery = trx.db.selectFrom('inventory_balances').selectAll();
  let ledgerQuery = trx.db
    .selectFrom('stock_ledger_entries')
    .select(['id', 'warehouse_id', 'product_id', 'qty_delta'])
    .orderBy('id', 'asc');

  if (options?.branchId) {
    balanceQuery = balanceQuery.where('branch_id', '=', options.branchId);
    ledgerQuery = ledgerQuery.where('branch_id', '=', options.branchId);
  }
  if (options?.warehouseId) {
    balanceQuery = balanceQuery.where('warehouse_id', '=', options.warehouseId);
    ledgerQuery = ledgerQuery.where('warehouse_id', '=', options.warehouseId);
  }
  if (options?.productId) {
    balanceQuery = balanceQuery.where('product_id', '=', options.productId);
    ledgerQuery = ledgerQuery.where('product_id', '=', options.productId);
  }

  if (!authCtx.allLocationsAccess) {
    const allowedWh = [...authCtx.allowedWarehouseIds];
    if (allowedWh.length === 0) {
      return {
        isConsistent: true,
        checkedBalancesCount: 0,
        checkedLedgerGroupsCount: 0,
        discrepancies: [],
      };
    }
    balanceQuery = balanceQuery.where('warehouse_id', 'in', allowedWh);
    ledgerQuery = ledgerQuery.where('warehouse_id', 'in', allowedWh);
  }

  const balanceRows = await balanceQuery.execute();
  const ledgerRows = await ledgerQuery.execute();

  const ledgerAgg = new Map<
    string,
    {
      warehouseId: string;
      productId: string;
      sumQty: Quantity;
      latestEntryId: string;
    }
  >();

  for (const l of ledgerRows) {
    const key = `${l.warehouse_id}:${l.product_id}`;
    const delta = Quantity.fromDecimalString(String(l.qty_delta));
    const current = ledgerAgg.get(key);
    if (!current) {
      ledgerAgg.set(key, {
        warehouseId: l.warehouse_id,
        productId: l.product_id,
        sumQty: delta,
        latestEntryId: l.id,
      });
    } else {
      ledgerAgg.set(key, {
        warehouseId: l.warehouse_id,
        productId: l.product_id,
        sumQty: current.sumQty.add(delta),
        latestEntryId: l.id,
      });
    }
  }

  const balanceMap = new Map<
    string,
    {
      warehouseId: string;
      productId: string;
      qtyOnHand: Quantity;
      lastEntryId: string;
    }
  >();

  for (const b of balanceRows) {
    const key = `${b.warehouse_id}:${b.product_id}`;
    balanceMap.set(key, {
      warehouseId: b.warehouse_id,
      productId: b.product_id,
      qtyOnHand: Quantity.fromDecimalString(String(b.qty_on_hand)),
      lastEntryId: b.last_ledger_entry_id,
    });
  }

  const allKeys = new Set<string>([...ledgerAgg.keys(), ...balanceMap.keys()]);
  const discrepancies: InventoryReconciliationDiscrepancy[] = [];

  for (const key of allKeys) {
    const ledger = ledgerAgg.get(key);
    const balance = balanceMap.get(key);
    const warehouseId = ledger?.warehouseId ?? balance!.warehouseId;
    const productId = ledger?.productId ?? balance!.productId;
    const ledgerSum = ledger?.sumQty ?? Quantity.zero();
    const balanceQty = balance?.qtyOnHand ?? Quantity.zero();
    const diff = balanceQty.subtract(ledgerSum);

    if (
      !diff.isZero() ||
      (balance?.lastEntryId ?? null) !== (ledger?.latestEntryId ?? null)
    ) {
      discrepancies.push({
        warehouseId,
        productId,
        balanceQtyOnHand: balanceQty.toDecimalString(),
        ledgerSumQtyDelta: ledgerSum.toDecimalString(),
        differenceQty: diff.toDecimalString(),
        balanceLastEntryId: balance?.lastEntryId ?? null,
        ledgerLatestEntryId: ledger?.latestEntryId ?? null,
      });
    }
  }

  return {
    isConsistent: discrepancies.length === 0,
    checkedBalancesCount: balanceRows.length,
    checkedLedgerGroupsCount: ledgerAgg.size,
    discrepancies,
  };
}

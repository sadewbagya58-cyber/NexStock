import type {
  BatchExpiryStatus,
  BatchResponse,
  BatchStatus,
  CreateBatchRequest,
  CurrencyCode,
  FefoBatchAllocation,
  FefoSelectionResponse,
  ListBatchesQuery,
} from '@nexstock/contracts';
import { Money, Quantity } from '@nexstock/domain-core';
import type { Selectable } from 'kysely';
import type { CursorPaginatedResult } from '../../cat/index.js';
import { assertAuthorized } from '../../iam/index.js';
import {
  AppError,
  type InventoryBatchesTable,
  type TenantTransactionContext,
  appendAuditLog,
  generateUuidV7,
} from '../../shared/index.js';
import { assertSubscriptionEntitlement } from '../../sub/index.js';

export function calculateBatchExpiryStatus(
  expiryDate: string | Date | null | undefined,
  warningDays = 30,
): BatchExpiryStatus {
  if (!expiryDate) {
    return 'VALID';
  }

  const expDateStr =
    typeof expiryDate === 'string'
      ? expiryDate.slice(0, 10)
      : expiryDate.toISOString().slice(0, 10);

  const todayStr = new Date().toISOString().slice(0, 10);
  if (expDateStr < todayStr) {
    return 'EXPIRED';
  }

  const expTime = new Date(`${expDateStr}T00:00:00Z`).getTime();
  const todayTime = new Date(`${todayStr}T00:00:00Z`).getTime();
  const daysDiff = Math.ceil((expTime - todayTime) / (1000 * 60 * 60 * 24));

  if (daysDiff <= warningDays) {
    return 'EXPIRING_SOON';
  }

  return 'VALID';
}

function mapBatchRow(
  row: Selectable<InventoryBatchesTable>,
  baseCurrency: string,
): BatchResponse {
  const expiryDateStr = row.expiry_date
    ? new Date(row.expiry_date).toISOString().slice(0, 10)
    : null;

  const manufacturingDateStr = row.manufacturing_date
    ? new Date(row.manufacturing_date).toISOString().slice(0, 10)
    : null;

  const receivedDateStr = new Date(row.received_date).toISOString().slice(0, 10);

  return {
    id: row.id,
    tenantId: row.tenant_id,
    productId: row.product_id,
    warehouseId: row.warehouse_id,
    batchNumber: row.batch_number,
    supplierId: row.supplier_id,
    status: row.status as BatchStatus,
    receivedDate: receivedDateStr,
    manufacturingDate: manufacturingDateStr,
    expiryDate: expiryDateStr,
    initialQuantity: Quantity.fromDecimalString(
      String(row.initial_quantity),
    ).toDecimalString(),
    currentQuantity: Quantity.fromDecimalString(
      String(row.current_quantity),
    ).toDecimalString(),
    unitCost: Money.fromDecimalString(
      String(row.unit_cost),
      row.currency_code || baseCurrency,
    ).toDecimalString(),
    currencyCode: (row.currency_code || baseCurrency) as CurrencyCode,
    expiryStatus: calculateBatchExpiryStatus(expiryDateStr),
    quarantineReason: row.quarantine_reason,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

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

export async function createBatch(
  trx: TenantTransactionContext,
  input: CreateBatchRequest,
): Promise<BatchResponse> {
  await assertAuthorized(trx, {
    permission: 'inv:batch:manage',
    warehouseId: input.warehouseId,
  });

  await assertSubscriptionEntitlement(trx, {
    requireWriteAccess: true,
  });

  const product = await trx.db
    .selectFrom('products')
    .select(['id', 'sku', 'track_inventory', 'tracking_mode', 'status'])
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', input.productId)
    .executeTakeFirst();

  if (!product || product.status !== 'ACTIVE') {
    throw new AppError({
      statusCode: 404,
      errorCode: 'ERR_NOT_FOUND',
      title: 'Active Product Not Found',
      detail: `Active product "${input.productId}" not found.`,
    });
  }

  if (
    product.tracking_mode !== 'BATCH' &&
    product.tracking_mode !== 'BATCH_EXPIRY'
  ) {
    throw new AppError({
      statusCode: 422,
      errorCode: 'INV_PRODUCT_NOT_BATCH_TRACKED',
      title: 'Product Is Not Batch Tracked',
      detail: `Product "${product.sku}" is configured with tracking_mode="${product.tracking_mode}". It must be BATCH or BATCH_EXPIRY.`,
    });
  }

  const warehouse = await trx.db
    .selectFrom('warehouses')
    .select(['id', 'is_active'])
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', input.warehouseId)
    .executeTakeFirst();

  if (!warehouse || !warehouse.is_active) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'ERR_NOT_FOUND',
      title: 'Active Warehouse Not Found',
      detail: `Active warehouse "${input.warehouseId}" not found.`,
    });
  }

  const batchNumber = input.batchNumber.trim().toUpperCase();
  if (!batchNumber) {
    throw new AppError({
      statusCode: 400,
      errorCode: 'ERR_VALIDATION_FAILED',
      title: 'Invalid Batch Number',
      detail: 'Batch number cannot be blank.',
    });
  }

  const existingBatch = await trx.db
    .selectFrom('inventory_batches')
    .select(['id'])
    .where('tenant_id', '=', trx.tenantId)
    .where('warehouse_id', '=', input.warehouseId)
    .where('product_id', '=', input.productId)
    .where('batch_number', '=', batchNumber)
    .executeTakeFirst();

  if (existingBatch) {
    throw new AppError({
      statusCode: 409,
      errorCode: 'INV_BATCH_DUPLICATE_NUMBER',
      title: 'Duplicate Batch Number',
      detail: `Batch number "${batchNumber}" already exists for this product in this warehouse.`,
    });
  }

  const baseCurrency = await getTenantBaseCurrency(trx);
  const currency = input.currencyCode ?? baseCurrency;
  const initialQty = Quantity.fromDecimalString(input.initialQuantity);
  if (initialQty.isNegative()) {
    throw new AppError({
      statusCode: 400,
      errorCode: 'ERR_VALIDATION_FAILED',
      title: 'Invalid Initial Quantity',
      detail: 'Initial batch quantity cannot be negative.',
    });
  }

  const unitCostMoney = Money.fromDecimalString(input.unitCost, currency);
  if (unitCostMoney.isNegative()) {
    throw new AppError({
      statusCode: 400,
      errorCode: 'ERR_VALIDATION_FAILED',
      title: 'Invalid Unit Cost',
      detail: 'Batch unit cost cannot be negative.',
    });
  }

  const batchId = generateUuidV7();
  const now = new Date();
  const receivedDate = input.receivedDate || now.toISOString().slice(0, 10);

  await trx.db
    .insertInto('inventory_batches')
    .values({
      id: batchId,
      tenant_id: trx.tenantId,
      product_id: input.productId,
      warehouse_id: input.warehouseId,
      batch_number: batchNumber,
      supplier_id: input.supplierId ?? null,
      status: 'ACTIVE',
      received_date: receivedDate,
      manufacturing_date: input.manufacturingDate ?? null,
      expiry_date: input.expiryDate ?? null,
      initial_quantity: initialQty.toDecimalString(),
      current_quantity: initialQty.toDecimalString(),
      unit_cost: unitCostMoney.toDecimalString(),
      currency_code: currency,
      quarantine_reason: null,
      created_at: now,
      updated_at: now,
    })
    .execute();

  await appendAuditLog(trx, {
    action: 'INV_BATCH_CREATED',
    resourceType: 'INVENTORY_BATCH',
    resourceId: batchId,
    metadata: {
      productId: input.productId,
      warehouseId: input.warehouseId,
      batchNumber,
      initialQuantity: initialQty.toDecimalString(),
      expiryDate: input.expiryDate ?? null,
    },
  });

  const inserted = await trx.db
    .selectFrom('inventory_batches')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', batchId)
    .executeTakeFirstOrThrow();

  return mapBatchRow(inserted, baseCurrency);
}

export async function getBatchById(
  trx: TenantTransactionContext,
  batchId: string,
): Promise<BatchResponse> {
  const row = await trx.db
    .selectFrom('inventory_batches')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', batchId)
    .executeTakeFirst();

  if (!row) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'ERR_NOT_FOUND',
      title: 'Batch Not Found',
      detail: `Batch "${batchId}" was not found.`,
    });
  }

  await assertAuthorized(trx, {
    permission: 'inv:batch:read',
    warehouseId: row.warehouse_id,
  });

  const baseCurrency = await getTenantBaseCurrency(trx);
  return mapBatchRow(row, baseCurrency);
}

export async function listBatches(
  trx: TenantTransactionContext,
  query: ListBatchesQuery,
): Promise<CursorPaginatedResult<BatchResponse>> {
  await assertAuthorized(trx, {
    permission: 'inv:batch:read',
    ...(query.warehouseId ? { warehouseId: query.warehouseId } : {}),
  });

  const limit = Math.min(Math.max(Number(query.limit ?? 50), 1), 100);
  const baseCurrency = await getTenantBaseCurrency(trx);

  let dbQuery = trx.db
    .selectFrom('inventory_batches')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId);

  if (query.productId) {
    dbQuery = dbQuery.where('product_id', '=', query.productId);
  }
  if (query.warehouseId) {
    dbQuery = dbQuery.where('warehouse_id', '=', query.warehouseId);
  }
  if (query.status) {
    dbQuery = dbQuery.where('status', '=', query.status);
  }
  if (query.search) {
    const s = `%${query.search.trim().toUpperCase()}%`;
    dbQuery = dbQuery.where('batch_number', 'like', s);
  }
  if (query.cursor) {
    dbQuery = dbQuery.where('id', '<', query.cursor);
  }

  const rows = await dbQuery
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(limit + 1)
    .execute();

  const hasNextPage = rows.length > limit;
  const items = hasNextPage ? rows.slice(0, limit) : rows;
  const nextCursor =
    hasNextPage && items.length > 0 ? items[items.length - 1]!.id : null;

  let mapped = items.map((r) => mapBatchRow(r, baseCurrency));

  // Dynamic filter on expiryStatus if requested
  if (query.expiryStatus) {
    mapped = mapped.filter((b) => b.expiryStatus === query.expiryStatus);
  }
  if (query.expiringWithinDays) {
    mapped = mapped.filter((b) => {
      if (!b.expiryDate) return false;
      const days = Math.ceil(
        (new Date(b.expiryDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24),
      );
      return days >= 0 && days <= query.expiringWithinDays!;
    });
  }

  return {
    data: mapped,
    pageInfo: {
      hasNextPage,
      nextCursor,
    },
  };
}

export async function quarantineBatch(
  trx: TenantTransactionContext,
  batchId: string,
  reason: string,
): Promise<BatchResponse> {
  const batch = await trx.db
    .selectFrom('inventory_batches')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', batchId)
    .forUpdate()
    .executeTakeFirst();

  if (!batch) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'ERR_NOT_FOUND',
      title: 'Batch Not Found',
      detail: `Batch "${batchId}" was not found.`,
    });
  }

  await assertAuthorized(trx, {
    permission: 'inv:batch:manage',
    warehouseId: batch.warehouse_id,
  });

  const trimmedReason = reason.trim();
  if (trimmedReason.length < 3) {
    throw new AppError({
      statusCode: 400,
      errorCode: 'ERR_VALIDATION_FAILED',
      title: 'Quarantine Reason Required',
      detail: 'Quarantine reason must be at least 3 characters.',
    });
  }

  const now = new Date();
  await trx.db
    .updateTable('inventory_batches')
    .set({
      status: 'QUARANTINED',
      quarantine_reason: trimmedReason,
      updated_at: now,
    })
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', batchId)
    .execute();

  await appendAuditLog(trx, {
    action: 'INV_BATCH_QUARANTINED',
    resourceType: 'INVENTORY_BATCH',
    resourceId: batchId,
    metadata: {
      batchNumber: batch.batch_number,
      reason: trimmedReason,
    },
  });

  const updated = await trx.db
    .selectFrom('inventory_batches')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', batchId)
    .executeTakeFirstOrThrow();

  const baseCurrency = await getTenantBaseCurrency(trx);
  return mapBatchRow(updated, baseCurrency);
}

export async function releaseBatch(
  trx: TenantTransactionContext,
  batchId: string,
  reason?: string,
): Promise<BatchResponse> {
  const batch = await trx.db
    .selectFrom('inventory_batches')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', batchId)
    .forUpdate()
    .executeTakeFirst();

  if (!batch) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'ERR_NOT_FOUND',
      title: 'Batch Not Found',
      detail: `Batch "${batchId}" was not found.`,
    });
  }

  await assertAuthorized(trx, {
    permission: 'inv:batch:manage',
    warehouseId: batch.warehouse_id,
  });

  const now = new Date();
  const nextStatus =
    Quantity.fromDecimalString(String(batch.current_quantity)).compare(
      Quantity.zero(),
    ) <= 0
      ? 'DEPLETED'
      : 'ACTIVE';

  await trx.db
    .updateTable('inventory_batches')
    .set({
      status: nextStatus,
      quarantine_reason: null,
      updated_at: now,
    })
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', batchId)
    .execute();

  await appendAuditLog(trx, {
    action: 'INV_BATCH_RELEASED',
    resourceType: 'INVENTORY_BATCH',
    resourceId: batchId,
    metadata: {
      batchNumber: batch.batch_number,
      releaseReason: reason ?? 'Quarantine released by supervisor',
      restoredStatus: nextStatus,
    },
  });

  const updated = await trx.db
    .selectFrom('inventory_batches')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', batchId)
    .executeTakeFirstOrThrow();

  const baseCurrency = await getTenantBaseCurrency(trx);
  return mapBatchRow(updated, baseCurrency);
}

export async function selectFefoBatches(
  trx: TenantTransactionContext,
  input: {
    readonly warehouseId: string;
    readonly productId: string;
    readonly requiredQuantity: string;
    readonly allowExpiringSoon?: boolean;
  },
): Promise<FefoSelectionResponse> {
  await assertAuthorized(trx, {
    permission: 'inv:batch:read',
    warehouseId: input.warehouseId,
  });

  const reqQty = Quantity.fromDecimalString(input.requiredQuantity);
  if (!reqQty.isPositive()) {
    throw new AppError({
      statusCode: 400,
      errorCode: 'ERR_VALIDATION_FAILED',
      title: 'Invalid Required Quantity',
      detail: 'Required quantity must be strictly greater than zero.',
    });
  }

  const baseCurrency = await getTenantBaseCurrency(trx);

  // Active batches with current_quantity > 0 ordered by expiry_date ASC NULLS LAST, received_date ASC
  const candidateRows = await trx.db
    .selectFrom('inventory_batches')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('warehouse_id', '=', input.warehouseId)
    .where('product_id', '=', input.productId)
    .where('status', '=', 'ACTIVE')
    .orderBy('expiry_date', 'asc')
    .orderBy('received_date', 'asc')
    .orderBy('created_at', 'asc')
    .execute();

  const todayStr = new Date().toISOString().slice(0, 10);
  let remainingNeeded = reqQty;
  let totalFulfilled = Quantity.zero();
  const allocations: FefoBatchAllocation[] = [];

  for (const row of candidateRows) {
    if (remainingNeeded.isZero() || remainingNeeded.isNegative()) {
      break;
    }

    const currentQty = Quantity.fromDecimalString(String(row.current_quantity));
    if (!currentQty.isPositive()) {
      continue;
    }

    const expRaw: unknown = row.expiry_date;
    const expiryStr = expRaw
      ? typeof expRaw === 'string'
        ? expRaw.slice(0, 10)
        : (expRaw as Date).toISOString().slice(0, 10)
      : null;

    // Filter out strictly expired batches
    if (expiryStr && expiryStr < todayStr) {
      continue;
    }

    const allocQty =
      currentQty.compare(remainingNeeded) <= 0 ? currentQty : remainingNeeded;

    allocations.push({
      batchId: row.id,
      batchNumber: row.batch_number,
      expiryDate: expiryStr,
      availableQty: currentQty.toDecimalString(),
      allocatedQty: allocQty.toDecimalString(),
      unitCost: Money.fromDecimalString(
        String(row.unit_cost),
        row.currency_code || baseCurrency,
      ).toDecimalString(),
    });

    totalFulfilled = totalFulfilled.add(allocQty);
    remainingNeeded = remainingNeeded.subtract(allocQty);
  }

  const unfulfilledQty = remainingNeeded.isPositive()
    ? remainingNeeded
    : Quantity.zero();

  return {
    productId: input.productId,
    warehouseId: input.warehouseId,
    requestedQty: reqQty.toDecimalString(),
    fulfilledQty: totalFulfilled.toDecimalString(),
    unfulfilledQty: unfulfilledQty.toDecimalString(),
    isFullyFulfilled: unfulfilledQty.isZero(),
    allocations,
  };
}

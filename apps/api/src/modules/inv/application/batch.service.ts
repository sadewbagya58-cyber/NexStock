import type {
  BatchAllocationPolicy,
  BatchBarcodePrintLogRequest,
  BatchBarcodePrintLogResponse,
  BatchExpiryStatus,
  BatchHistoryResponse,
  BatchPriceHistoryEntry,
  BatchPricingMode,
  BatchResponse,
  BatchStatus,
  CreateBatchRequest,
  CurrencyCode,
  FefoBatchAllocation,
  FefoSelectionResponse,
  GenerateBatchBarcodeRequest,
  GenerateBatchBarcodeResponse,
  ListBatchesQuery,
  LotConflictPolicy,
  ResolveBarcodeRequest,
  ResolveBarcodeResponse,
  StockMovementType,
  UpdateBatchPricingRequest,
} from '@nexstock/contracts';
import {
  Money,
  Quantity,
  buildInternalBatchBarcodeValue,
  normalizeBarcodeCandidates,
  parseGs1Barcode,
  resolveEffectiveBatchPrice,
} from '@nexstock/domain-core';
import { type Selectable, sql } from 'kysely';
import {
  type CursorPaginatedResult,
  assertBarcodeGloballyUniqueAcrossEntities,
} from '../../cat/index.js';
import { assertAuthorized } from '../../iam/index.js';
import {
  AppError,
  type InventoryBatchesTable,
  type TenantTransactionContext,
  appendAuditLog,
  generateUuidV7,
} from '../../shared/index.js';
import { assertSubscriptionEntitlement } from '../../sub/index.js';
import { postStockMovement } from './inv.service.js';

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
  const ccy = row.currency_code || baseCurrency;
  const currentQty = Quantity.fromDecimalString(String(row.current_quantity));
  const reservedQty = Quantity.fromDecimalString(
    String(row.reserved_quantity ?? '0.000000'),
  );
  const availableQty = currentQty.subtract(reservedQty);
  const clampedAvailable = availableQty.isNegative()
    ? Quantity.zero()
    : availableQty;

  return {
    id: row.id,
    tenantId: row.tenant_id,
    branchId: row.branch_id ?? null,
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
    currentQuantity: currentQty.toDecimalString(),
    reservedQuantity: reservedQty.toDecimalString(),
    availableQuantity: clampedAvailable.toDecimalString(),
    unitCost: Money.fromDecimalString(String(row.unit_cost), ccy).toDecimalString(),
    sellingPrice:
      row.selling_price != null
        ? Money.fromDecimalString(String(row.selling_price), ccy).toDecimalString()
        : null,
    minSellingPrice:
      row.min_selling_price != null
        ? Money.fromDecimalString(String(row.min_selling_price), ccy).toDecimalString()
        : null,
    maxDiscountPct: row.max_discount_pct != null ? String(row.max_discount_pct) : null,
    batchPricingMode: (row.batch_pricing_mode ?? 'EXPLICIT') as BatchPricingMode,
    internalBarcode: row.internal_barcode ?? null,
    internalBarcodeType: row.internal_barcode_type ?? 'CODE128',
    currencyCode: ccy as CurrencyCode,
    expiryStatus: calculateBatchExpiryStatus(expiryDateStr),
    quarantineReason: row.quarantine_reason,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export async function generateUniqueInternalBatchBarcodeValue(
  trx: TenantTransactionContext,
  prefix = 'NB-B',
): Promise<string> {
  for (let attempt = 0; attempt < 15; attempt++) {
    const suffix = `${Date.now().toString(36).toUpperCase().slice(-5)}${Math.random()
      .toString(36)
      .substring(2, 6)
      .toUpperCase()}`;
    const candidate = buildInternalBatchBarcodeValue(suffix, prefix);
    try {
      await assertBarcodeGloballyUniqueAcrossEntities(trx, candidate);
      return candidate;
    } catch {
      // Retry on rare collision
    }
  }
  const fallback = buildInternalBatchBarcodeValue(
    generateUuidV7().replace(/-/g, '').slice(-10).toUpperCase(),
    prefix,
  );
  await assertBarcodeGloballyUniqueAcrossEntities(trx, fallback);
  return fallback;
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
  _idempotencyKey?: string,
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
    .select([
      'id',
      'sku',
      'track_inventory',
      'tracking_mode',
      'status',
      'base_uom',
      'purchase_cost',
    ])
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

  if (!product.track_inventory) {
    throw new AppError({
      statusCode: 422,
      errorCode: 'INV_PRODUCT_NOT_TRACKABLE',
      title: 'Product Does Not Track Stock',
      detail: `Product "${product.sku}" is configured with track_inventory=false.`,
    });
  }

  const warehouse = await trx.db
    .selectFrom('warehouses')
    .select(['id', 'branch_id', 'is_active'])
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

  let resolvedBranchId = input.branchId ?? warehouse.branch_id;
  if (!resolvedBranchId) {
    const link = await trx.db
      .selectFrom('branch_warehouse_links')
      .select(['branch_id'])
      .where('tenant_id', '=', trx.tenantId)
      .where('warehouse_id', '=', input.warehouseId)
      .executeTakeFirst();
    resolvedBranchId = link?.branch_id ?? null;
  }

  if (!resolvedBranchId) {
    throw new AppError({
      statusCode: 400,
      errorCode: 'ERR_VALIDATION_FAILED',
      title: 'Warehouse Branch Unresolved',
      detail: `Warehouse "${input.warehouseId}" is not associated with any active branch.`,
    });
  }

  if (input.branchId) {
    let belongsToBranch = warehouse.branch_id === input.branchId;
    if (!belongsToBranch) {
      const link = await trx.db
        .selectFrom('branch_warehouse_links')
        .select(['id'])
        .where('tenant_id', '=', trx.tenantId)
        .where('branch_id', '=', input.branchId)
        .where('warehouse_id', '=', input.warehouseId)
        .executeTakeFirst();
      belongsToBranch = Boolean(link);
    }
    if (!belongsToBranch) {
      throw new AppError({
        statusCode: 400,
        errorCode: 'ERR_VALIDATION_FAILED',
        title: 'Warehouse Not Linked to Branch',
        detail: `Warehouse "${input.warehouseId}" does not belong to branch "${input.branchId}".`,
      });
    }
  }

  if (input.supplierId) {
    const supplierRow = await trx.db
      .selectFrom('suppliers')
      .select(['id', 'status'])
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', input.supplierId)
      .executeTakeFirst();

    if (!supplierRow) {
      throw new AppError({
        statusCode: 404,
        errorCode: 'ERR_NOT_FOUND',
        title: 'Supplier Not Found',
        detail: `Supplier "${input.supplierId}" was not found in tenant "${trx.tenantId}".`,
      });
    }
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

  let internalBarcode: string;
  if (input.internalBarcode?.trim()) {
    internalBarcode = input.internalBarcode.trim().toUpperCase();
    await assertBarcodeGloballyUniqueAcrossEntities(trx, internalBarcode);
  } else {
    internalBarcode = await generateUniqueInternalBatchBarcodeValue(trx);
  }

  const normalizedSellingPrice =
    input.sellingPrice != null
      ? Money.fromDecimalString(input.sellingPrice, currency).toDecimalString()
      : null;
  const normalizedMinSellingPrice =
    input.minSellingPrice != null
      ? Money.fromDecimalString(input.minSellingPrice, currency).toDecimalString()
      : null;

  if (
    normalizedSellingPrice != null &&
    normalizedMinSellingPrice != null &&
    Money.fromDecimalString(normalizedSellingPrice, currency).compare(
      Money.fromDecimalString(normalizedMinSellingPrice, currency),
    ) < 0
  ) {
    throw new AppError({
      statusCode: 422,
      errorCode: 'PRICING_MIN_PRICE_VIOLATION',
      title: 'Batch Price Below Minimum Floor',
      detail: `Selling price "${normalizedSellingPrice}" cannot be below minimum selling price "${normalizedMinSellingPrice}".`,
    });
  }

  // Initialize batch with 0 current_quantity so postStockMovement atomically increments it to initialQuantity
  await trx.db
    .insertInto('inventory_batches')
    .values({
      id: batchId,
      tenant_id: trx.tenantId,
      branch_id: resolvedBranchId,
      product_id: input.productId,
      warehouse_id: input.warehouseId,
      batch_number: batchNumber,
      supplier_id: input.supplierId ?? null,
      status: 'ACTIVE',
      received_date: receivedDate,
      manufacturing_date: input.manufacturingDate ?? null,
      expiry_date: input.expiryDate ?? null,
      initial_quantity: initialQty.toDecimalString(),
      current_quantity: Quantity.zero().toDecimalString(),
      reserved_quantity: Quantity.zero().toDecimalString(),
      unit_cost: unitCostMoney.toDecimalString(),
      selling_price: normalizedSellingPrice,
      min_selling_price: normalizedMinSellingPrice,
      max_discount_pct: input.maxDiscountPct ?? null,
      batch_pricing_mode:
        input.batchPricingMode ??
        (normalizedSellingPrice != null ? 'EXPLICIT' : 'INHERIT_PRODUCT'),
      internal_barcode: internalBarcode,
      internal_barcode_type: 'CODE128',
      currency_code: currency,
      quarantine_reason: null,
      created_at: now,
      updated_at: now,
    })
    .execute();

  if (normalizedSellingPrice != null) {
    await trx.db
      .insertInto('batch_price_history')
      .values({
        id: generateUuidV7(),
        tenant_id: trx.tenantId,
        branch_id: resolvedBranchId,
        product_id: input.productId,
        batch_id: batchId,
        previous_price: null,
        new_price: normalizedSellingPrice,
        cost_snapshot: unitCostMoney.toDecimalString(),
        change_type: 'MANUAL_UPDATE',
        suggestion_id: null,
        reason: 'Initial batch registration price',
        actor_user_id: trx.userId,
        approver_user_id: trx.userId,
        created_at: now,
      })
      .execute();
  }

  if (initialQty.isPositive()) {
    const movementKey = generateUuidV7();

    await postStockMovement(
      trx,
      movementKey,
      {
        branchId: resolvedBranchId,
        warehouseId: input.warehouseId,
        productId: input.productId,
        batchId,
        movementType: 'STOCK_IN',
        quantity: initialQty.toDecimalString(),
        uomCode: product.base_uom,
        unitCost: unitCostMoney.toDecimalString(),
        referenceType: 'BATCH_REGISTRATION',
        referenceId: batchNumber,
        reason: 'Initial batch registration intake',
        supplierId: input.supplierId ?? null,
      },
      { skipPermissionCheck: true },
    );
  }

  await appendAuditLog(trx, {
    action: 'INV_BATCH_CREATED',
    resourceType: 'INVENTORY_BATCH',
    resourceId: batchId,
    metadata: {
      productId: input.productId,
      warehouseId: input.warehouseId,
      branchId: resolvedBranchId,
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

  if (query.branchId) {
    dbQuery = dbQuery.where('branch_id', '=', query.branchId);
  }
  if (query.productId) {
    dbQuery = dbQuery.where('product_id', '=', query.productId);
  }
  if (query.warehouseId) {
    dbQuery = dbQuery.where('warehouse_id', '=', query.warehouseId);
  }
  if (query.status) {
    dbQuery = dbQuery.where('status', '=', query.status);
  }
  if (query.missingPriceOnly === true || query.missingPriceOnly === 'true') {
    dbQuery = dbQuery.where('selling_price', 'is', null);
  }
  if (query.search) {
    const s = `%${query.search.trim().toUpperCase()}%`;
    dbQuery = dbQuery.where((eb) =>
      eb.or([
        eb('batch_number', 'like', s),
        eb('internal_barcode', 'like', s),
      ]),
    );
  }

  const todayDate = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
  const soonDate = new Date(
    `${new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)}T00:00:00.000Z`,
  );

  if (query.expiryStatus === 'EXPIRED') {
    dbQuery = dbQuery
      .where('expiry_date', 'is not', null)
      .where('expiry_date', '<', todayDate);
  } else if (query.expiryStatus === 'EXPIRING_SOON') {
    dbQuery = dbQuery
      .where('expiry_date', 'is not', null)
      .where('expiry_date', '>=', todayDate)
      .where('expiry_date', '<=', soonDate);
  } else if (query.expiryStatus === 'VALID') {
    dbQuery = dbQuery.where((eb) =>
      eb.or([eb('expiry_date', 'is', null), eb('expiry_date', '>', soonDate)]),
    );
  }

  if (query.expiringWithinDays) {
    const endWindowDate = new Date(
      `${new Date(Date.now() + query.expiringWithinDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)}T00:00:00.000Z`,
    );
    dbQuery = dbQuery
      .where('expiry_date', 'is not', null)
      .where('expiry_date', '>=', todayDate)
      .where('expiry_date', '<=', endWindowDate);
  }

  if (query.cursor) {
    let cursorCreatedAt: Date | null = null;
    let cursorId: string = query.cursor;
    if (query.cursor.includes('|')) {
      const [tsPart, idPart] = query.cursor.split('|');
      if (tsPart && idPart) {
        const parsedDate = new Date(tsPart);
        if (!Number.isNaN(parsedDate.getTime())) {
          cursorCreatedAt = parsedDate;
          cursorId = idPart;
        }
      }
    } else {
      const cursorRow = await trx.db
        .selectFrom('inventory_batches')
        .select(['created_at', 'id'])
        .where('tenant_id', '=', trx.tenantId)
        .where('id', '=', query.cursor)
        .executeTakeFirst();
      if (cursorRow) {
        cursorCreatedAt = new Date(cursorRow.created_at);
        cursorId = cursorRow.id;
      }
    }

    if (cursorCreatedAt) {
      const tsIso = cursorCreatedAt.toISOString();
      dbQuery = dbQuery.where(
        sql<boolean>`(created_at, id) < (${tsIso}::timestamptz, ${cursorId}::uuid)`,
      );
    } else {
      dbQuery = dbQuery.where('id', '<', query.cursor);
    }
  }

  const rows = await dbQuery
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(limit + 1)
    .execute();

  const hasNextPage = rows.length > limit;
  const items = hasNextPage ? rows.slice(0, limit) : rows;
  const lastItem = hasNextPage && items.length > 0 ? items[items.length - 1] : null;
  const nextCursor = lastItem
    ? `${new Date(lastItem.created_at).toISOString()}|${lastItem.id}`
    : null;

  const mapped = items.map((r) => mapBatchRow(r, baseCurrency));

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
    readonly allocationPolicyOverride?: BatchAllocationPolicy;
    readonly skipPermissionCheck?: boolean;
  },
): Promise<FefoSelectionResponse> {
  if (!input.skipPermissionCheck) {
    await assertAuthorized(trx, {
      permission: 'inv:batch:read',
      warehouseId: input.warehouseId,
    });
  }

  const reqQty = Quantity.fromDecimalString(input.requiredQuantity);
  if (!reqQty.isPositive()) {
    throw new AppError({
      statusCode: 400,
      errorCode: 'ERR_VALIDATION_FAILED',
      title: 'Invalid Required Quantity',
      detail: 'Required quantity must be strictly greater than zero.',
    });
  }

  const [baseCurrency, productRow, pricingSettingsRow] = await Promise.all([
    getTenantBaseCurrency(trx),
    trx.db
      .selectFrom('products')
      .select(['allocation_policy'])
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', input.productId)
      .executeTakeFirst(),
    trx.db
      .selectFrom('pricing_settings')
      .select(['default_batch_allocation_policy'])
      .where('tenant_id', '=', trx.tenantId)
      .executeTakeFirst(),
  ]);

  const allocationPolicy: BatchAllocationPolicy =
    input.allocationPolicyOverride ??
    (productRow?.allocation_policy as BatchAllocationPolicy | undefined) ??
    (pricingSettingsRow?.default_batch_allocation_policy as BatchAllocationPolicy | undefined) ??
    'FEFO';

  // Active batches with available quantity > 0 ordered by configured allocation policy
  let batchQuery = trx.db
    .selectFrom('inventory_batches')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('warehouse_id', '=', input.warehouseId)
    .where('product_id', '=', input.productId)
    .where('status', '=', 'ACTIVE');

  if (allocationPolicy === 'FIFO') {
    batchQuery = batchQuery
      .orderBy('received_date', 'asc')
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc');
  } else {
    batchQuery = batchQuery
      .orderBy(sql`expiry_date ASC NULLS LAST`)
      .orderBy('received_date', 'asc')
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc');
  }

  const candidateRows = await batchQuery.execute();

  const todayStr = new Date().toISOString().slice(0, 10);
  let remainingNeeded = reqQty;
  let totalFulfilled = Quantity.zero();
  const allocations: FefoBatchAllocation[] = [];

  for (const row of candidateRows) {
    if (remainingNeeded.isZero() || remainingNeeded.isNegative()) {
      break;
    }

    const currentQty = Quantity.fromDecimalString(String(row.current_quantity));
    const reservedQty = Quantity.fromDecimalString(
      String(row.reserved_quantity ?? '0.000000'),
    );
    const availableQty = currentQty.subtract(reservedQty);
    if (!availableQty.isPositive()) {
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
      availableQty.compare(remainingNeeded) <= 0 ? availableQty : remainingNeeded;

    allocations.push({
      batchId: row.id,
      batchNumber: row.batch_number,
      internalBarcode: row.internal_barcode ?? null,
      expiryDate: expiryStr,
      availableQty: availableQty.toDecimalString(),
      reservedQty: reservedQty.toDecimalString(),
      allocatedQty: allocQty.toDecimalString(),
      unitCost: Money.fromDecimalString(
        String(row.unit_cost),
        row.currency_code || baseCurrency,
      ).toDecimalString(),
      sellingPrice: row.selling_price
        ? Money.fromDecimalString(
            String(row.selling_price),
            row.currency_code || baseCurrency,
          ).toDecimalString()
        : null,
      batchPricingMode: (row.batch_pricing_mode ?? 'EXPLICIT') as BatchPricingMode,
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
    allocationPolicy,
    requestedQty: reqQty.toDecimalString(),
    fulfilledQty: totalFulfilled.toDecimalString(),
    unfulfilledQty: unfulfilledQty.toDecimalString(),
    isFullyFulfilled: unfulfilledQty.isZero(),
    allocations,
  };
}

/**
 * Registers or resolves an existing warehouse batch during Goods Receipt without
 * requiring standalone `inv:batch:manage` when the caller already passed `pur:grn:post`.
 * Initializes `current_quantity = 0.000000` when newly created so the subsequent
 * `postStockMovement` call atomically increments `current_quantity`.
 */
export async function ensureBatchForGoodsReceipt(
  trx: TenantTransactionContext,
  params: {
    readonly productId: string;
    readonly warehouseId: string;
    readonly branchId?: string | null;
    readonly supplierId?: string | null;
    readonly batchNumber: string;
    readonly manufacturingDate?: string | null;
    readonly expiryDate?: string | null;
    readonly receivedQtyBase: string;
    readonly unitCostPerBaseUom: string;
    readonly sellingPrice?: string | null;
    readonly minSellingPrice?: string | null;
    readonly maxDiscountPct?: string | null;
    readonly batchPricingMode?: BatchPricingMode;
    readonly currencyCode: string;
    readonly receivedDate?: string;
    readonly goodsReceiptId?: string | null;
    readonly goodsReceiptLineId?: string | null;
    readonly lotConflictPolicy?: LotConflictPolicy;
  },
): Promise<{
  readonly batchId: string;
  readonly created: boolean;
  readonly resolvedBatchNumber: string;
  readonly internalBarcode: string;
  readonly lotConflictResolution: 'NONE' | 'SUFFIXED' | 'OVERRIDDEN';
}> {
  let batchNumber = params.batchNumber.trim().toUpperCase();
  if (!batchNumber) {
    throw new AppError({
      statusCode: 400,
      errorCode: 'ERR_VALIDATION_FAILED',
      title: 'Invalid Batch Number',
      detail: 'Batch number cannot be blank.',
    });
  }

  let resolvedBranchId = params.branchId ?? null;
  if (!resolvedBranchId) {
    const wh = await trx.db
      .selectFrom('warehouses')
      .select(['branch_id'])
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', params.warehouseId)
      .executeTakeFirst();
    resolvedBranchId = wh?.branch_id ?? null;
  }

  const incomingCost = Money.fromDecimalString(
    params.unitCostPerBaseUom,
    params.currencyCode,
  ).toDecimalString();
  const incomingSellingPrice =
    params.sellingPrice != null
      ? Money.fromDecimalString(params.sellingPrice, params.currencyCode).toDecimalString()
      : null;
  const incomingMinSellingPrice =
    params.minSellingPrice != null
      ? Money.fromDecimalString(params.minSellingPrice, params.currencyCode).toDecimalString()
      : null;
  const incomingExpiry = params.expiryDate ? params.expiryDate.slice(0, 10) : null;

  if (
    incomingSellingPrice != null &&
    incomingMinSellingPrice != null &&
    Money.fromDecimalString(incomingSellingPrice, params.currencyCode).compare(
      Money.fromDecimalString(incomingMinSellingPrice, params.currencyCode),
    ) < 0
  ) {
    throw new AppError({
      statusCode: 422,
      errorCode: 'PRICING_MIN_PRICE_VIOLATION',
      title: 'Batch Price Below Minimum Floor',
      detail: `GRN selling price "${incomingSellingPrice}" is below minimum selling price "${incomingMinSellingPrice}".`,
    });
  }

  const existing = await trx.db
    .selectFrom('inventory_batches')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('warehouse_id', '=', params.warehouseId)
    .where('product_id', '=', params.productId)
    .where('batch_number', '=', batchNumber)
    .forUpdate()
    .executeTakeFirst();

  const now = new Date();

  if (existing) {
    const existingCost = Money.fromDecimalString(
      String(existing.unit_cost),
      params.currencyCode,
    ).toDecimalString();
    const existingExpiry = existing.expiry_date
      ? new Date(existing.expiry_date).toISOString().slice(0, 10)
      : null;
    const existingPrice =
      existing.selling_price != null
        ? Money.fromDecimalString(String(existing.selling_price), params.currencyCode).toDecimalString()
        : null;

    const costConflict = existingCost !== incomingCost;
    const expiryConflict =
      incomingExpiry !== null &&
      existingExpiry !== null &&
      existingExpiry !== incomingExpiry;
    const supplierConflict =
      params.supplierId != null &&
      existing.supplier_id != null &&
      existing.supplier_id !== params.supplierId;
    const priceConflict =
      incomingSellingPrice !== null &&
      existingPrice !== null &&
      existingPrice !== incomingSellingPrice;

    const hasConflict =
      costConflict || expiryConflict || supplierConflict || priceConflict;

    const policy: LotConflictPolicy = params.lotConflictPolicy ?? 'REJECT';

    if (hasConflict && policy === 'REJECT') {
      throw new AppError({
        statusCode: 409,
        errorCode: 'PUR_BATCH_LOT_CONFLICT',
        title: 'Duplicate Lot With Conflicting Terms',
        detail: `Batch "${batchNumber}" already exists with different cost/expiry/price/supplier. Choose CREATE_NEW_LOT_SUFFIX or MANAGER_OVERRIDE.`,
        extensions: {
          batchId: existing.id,
          batchNumber,
          existing: {
            unitCost: existingCost,
            sellingPrice: existingPrice,
            expiryDate: existingExpiry,
            supplierId: existing.supplier_id,
          },
          incoming: {
            unitCost: incomingCost,
            sellingPrice: incomingSellingPrice,
            expiryDate: incomingExpiry,
            supplierId: params.supplierId ?? null,
          },
        },
      });
    }

    if (hasConflict && policy === 'CREATE_NEW_LOT_SUFFIX') {
      let suffixIndex = 2;
      let candidateLot = `${batchNumber}-${String(suffixIndex).padStart(2, '0')}`;
      while (suffixIndex < 100) {
        const collision = await trx.db
          .selectFrom('inventory_batches')
          .select(['id'])
          .where('tenant_id', '=', trx.tenantId)
          .where('warehouse_id', '=', params.warehouseId)
          .where('product_id', '=', params.productId)
          .where('batch_number', '=', candidateLot)
          .executeTakeFirst();
        if (!collision) {
          break;
        }
        suffixIndex += 1;
        candidateLot = `${batchNumber}-${String(suffixIndex).padStart(2, '0')}`;
      }
      batchNumber = candidateLot;
      // Fall through to creating the suffixed batch below
    } else if (hasConflict && policy === 'MANAGER_OVERRIDE') {
      await assertAuthorized(trx, {
        permission: 'inv:batch:manage',
        warehouseId: params.warehouseId,
      });

      const barcode =
        existing.internal_barcode ??
        (await generateUniqueInternalBatchBarcodeValue(trx));
      const nextInitial = Quantity.fromDecimalString(
        String(existing.initial_quantity),
      ).add(Quantity.fromDecimalString(params.receivedQtyBase));

      await trx.db
        .updateTable('inventory_batches')
        .set({
          initial_quantity: nextInitial.toDecimalString(),
          unit_cost: incomingCost,
          ...(incomingExpiry !== null ? { expiry_date: incomingExpiry } : {}),
          ...(params.manufacturingDate !== undefined
            ? { manufacturing_date: params.manufacturingDate }
            : {}),
          ...(params.supplierId !== undefined ? { supplier_id: params.supplierId } : {}),
          ...(incomingSellingPrice !== null ? { selling_price: incomingSellingPrice } : {}),
          ...(incomingMinSellingPrice !== null
            ? { min_selling_price: incomingMinSellingPrice }
            : {}),
          ...(params.maxDiscountPct !== undefined
            ? { max_discount_pct: params.maxDiscountPct }
            : {}),
          ...(params.batchPricingMode !== undefined
            ? { batch_pricing_mode: params.batchPricingMode }
            : {}),
          internal_barcode: barcode,
          internal_barcode_type: existing.internal_barcode_type ?? 'CODE128',
          status: 'ACTIVE',
          updated_at: now,
        })
        .where('tenant_id', '=', trx.tenantId)
        .where('id', '=', existing.id)
        .execute();

      if (incomingSellingPrice !== null && incomingSellingPrice !== existingPrice) {
        await trx.db
          .insertInto('batch_price_history')
          .values({
            id: generateUuidV7(),
            tenant_id: trx.tenantId,
            branch_id: resolvedBranchId,
            product_id: params.productId,
            batch_id: existing.id,
            previous_price: existingPrice,
            new_price: incomingSellingPrice,
            cost_snapshot: incomingCost,
            change_type: 'MANUAL_UPDATE',
            suggestion_id: null,
            reason: `GRN lot conflict manager override for ${batchNumber}`,
            actor_user_id: trx.userId,
            approver_user_id: trx.userId,
            created_at: now,
          })
          .execute();
      }

      await appendAuditLog(trx, {
        action: 'PUR_BATCH_LOT_OVERRIDDEN',
        resourceType: 'INVENTORY_BATCH',
        resourceId: existing.id,
        metadata: {
          batchNumber,
          previousCost: existingCost,
          newCost: incomingCost,
          previousPrice: existingPrice,
          newPrice: incomingSellingPrice,
          previousExpiry: existingExpiry,
          newExpiry: incomingExpiry,
        },
      });

      return {
        batchId: existing.id,
        created: false,
        resolvedBatchNumber: batchNumber,
        internalBarcode: barcode,
        lotConflictResolution: 'OVERRIDDEN',
      };
    } else {
      // Compatible lot top-up
      const barcode =
        existing.internal_barcode ??
        (await generateUniqueInternalBatchBarcodeValue(trx));
      const nextInitial = Quantity.fromDecimalString(
        String(existing.initial_quantity),
      ).add(Quantity.fromDecimalString(params.receivedQtyBase));

      const assignMissingPrice =
        existingPrice === null && incomingSellingPrice !== null;

      await trx.db
        .updateTable('inventory_batches')
        .set({
          initial_quantity: nextInitial.toDecimalString(),
          internal_barcode: barcode,
          internal_barcode_type: existing.internal_barcode_type ?? 'CODE128',
          ...(assignMissingPrice ? { selling_price: incomingSellingPrice } : {}),
          status: 'ACTIVE',
          updated_at: now,
        })
        .where('tenant_id', '=', trx.tenantId)
        .where('id', '=', existing.id)
        .execute();

      if (assignMissingPrice && incomingSellingPrice !== null) {
        await trx.db
          .insertInto('batch_price_history')
          .values({
            id: generateUuidV7(),
            tenant_id: trx.tenantId,
            branch_id: resolvedBranchId,
            product_id: params.productId,
            batch_id: existing.id,
            previous_price: null,
            new_price: incomingSellingPrice,
            cost_snapshot: incomingCost,
            change_type: 'GRN_INTAKE',
            suggestion_id: null,
            reason: 'Price assigned during GRN replenishment',
            actor_user_id: trx.userId,
            approver_user_id: trx.userId,
            created_at: now,
          })
          .execute();
      }

      return {
        batchId: existing.id,
        created: false,
        resolvedBatchNumber: batchNumber,
        internalBarcode: barcode,
        lotConflictResolution: 'NONE',
      };
    }
  }

  const batchId = generateUuidV7();
  const internalBarcode = await generateUniqueInternalBatchBarcodeValue(trx);
  const wasSuffixed = Boolean(existing);

  await trx.db
    .insertInto('inventory_batches')
    .values({
      id: batchId,
      tenant_id: trx.tenantId,
      branch_id: resolvedBranchId,
      product_id: params.productId,
      warehouse_id: params.warehouseId,
      batch_number: batchNumber,
      supplier_id: params.supplierId ?? null,
      status: 'ACTIVE',
      received_date: params.receivedDate ?? now.toISOString().slice(0, 10),
      manufacturing_date: params.manufacturingDate ?? null,
      expiry_date: incomingExpiry,
      initial_quantity: Quantity.fromDecimalString(params.receivedQtyBase).toDecimalString(),
      current_quantity: Quantity.zero().toDecimalString(),
      reserved_quantity: Quantity.zero().toDecimalString(),
      unit_cost: incomingCost,
      selling_price: incomingSellingPrice,
      min_selling_price: incomingMinSellingPrice,
      max_discount_pct: params.maxDiscountPct ?? null,
      batch_pricing_mode:
        params.batchPricingMode ??
        (incomingSellingPrice != null ? 'EXPLICIT' : 'INHERIT_PRODUCT'),
      internal_barcode: internalBarcode,
      internal_barcode_type: 'CODE128',
      goods_receipt_id: params.goodsReceiptId ?? null,
      goods_receipt_line_id: params.goodsReceiptLineId ?? null,
      currency_code: params.currencyCode,
      quarantine_reason: null,
      created_at: now,
      updated_at: now,
    })
    .execute();

  if (incomingSellingPrice != null) {
    await trx.db
      .insertInto('batch_price_history')
      .values({
        id: generateUuidV7(),
        tenant_id: trx.tenantId,
        branch_id: resolvedBranchId,
        product_id: params.productId,
        batch_id: batchId,
        previous_price: null,
        new_price: incomingSellingPrice,
        cost_snapshot: incomingCost,
        change_type: 'GRN_INTAKE',
        suggestion_id: null,
        reason: wasSuffixed
          ? `New suffixed lot ${batchNumber} received via GRN`
          : 'Initial GRN batch intake price',
        actor_user_id: trx.userId,
        approver_user_id: trx.userId,
        created_at: now,
      })
      .execute();
  }

  return {
    batchId,
    created: true,
    resolvedBatchNumber: batchNumber,
    internalBarcode,
    lotConflictResolution: wasSuffixed ? 'SUFFIXED' : 'NONE',
  };
}

export async function updateBatchPricing(
  trx: TenantTransactionContext,
  batchId: string,
  input: UpdateBatchPricingRequest,
): Promise<BatchResponse> {
  const existing = await trx.db
    .selectFrom('inventory_batches')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', batchId)
    .forUpdate()
    .executeTakeFirst();

  if (!existing) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'INV_BATCH_NOT_FOUND',
      title: 'Batch Not Found',
      detail: `Batch "${batchId}" was not found.`,
    });
  }

  await assertAuthorized(trx, {
    permission: 'inv:batch:manage',
    warehouseId: existing.warehouse_id,
  });

  const baseCurrency = await getTenantBaseCurrency(trx);
  const ccy = existing.currency_code || baseCurrency;
  const nextSellingPrice =
    input.sellingPrice !== null
      ? Money.fromDecimalString(input.sellingPrice, ccy).toDecimalString()
      : null;
  const nextMinSellingPrice =
    input.minSellingPrice !== undefined
      ? input.minSellingPrice !== null
        ? Money.fromDecimalString(input.minSellingPrice, ccy).toDecimalString()
        : null
      : existing.min_selling_price != null
        ? Money.fromDecimalString(String(existing.min_selling_price), ccy).toDecimalString()
        : null;

  if (
    nextSellingPrice !== null &&
    nextMinSellingPrice !== null &&
    Money.fromDecimalString(nextSellingPrice, ccy).compare(
      Money.fromDecimalString(nextMinSellingPrice, ccy),
    ) < 0
  ) {
    throw new AppError({
      statusCode: 422,
      errorCode: 'PRICING_MIN_PRICE_VIOLATION',
      title: 'Batch Price Below Minimum Floor',
      detail: `Selling price "${nextSellingPrice}" violates minimum floor "${nextMinSellingPrice}".`,
    });
  }

  const now = new Date();
  await trx.db
    .updateTable('inventory_batches')
    .set({
      selling_price: nextSellingPrice,
      min_selling_price: nextMinSellingPrice,
      ...(input.maxDiscountPct !== undefined
        ? { max_discount_pct: input.maxDiscountPct }
        : {}),
      ...(input.batchPricingMode !== undefined
        ? { batch_pricing_mode: input.batchPricingMode }
        : {}),
      updated_at: now,
    })
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', batchId)
    .execute();

  if (nextSellingPrice !== null) {
    await trx.db
      .insertInto('batch_price_history')
      .values({
        id: generateUuidV7(),
        tenant_id: trx.tenantId,
        branch_id: existing.branch_id ?? null,
        product_id: existing.product_id,
        batch_id: batchId,
        previous_price:
          existing.selling_price != null
            ? Money.fromDecimalString(String(existing.selling_price), ccy).toDecimalString()
            : null,
        new_price: nextSellingPrice,
        cost_snapshot: Money.fromDecimalString(String(existing.unit_cost), ccy).toDecimalString(),
        change_type:
          input.changeSource === 'SMART_PRICING_APPLIED'
            ? 'SMART_PRICING_APPROVAL'
            : 'MANUAL_UPDATE',
        suggestion_id: null,
        reason: input.reason?.trim() || 'Manual batch selling price update',
        actor_user_id: trx.userId,
        approver_user_id: trx.userId,
        created_at: now,
      })
      .execute();
  }

  await appendAuditLog(trx, {
    action: 'INV_BATCH_PRICING_UPDATED',
    resourceType: 'INVENTORY_BATCH',
    resourceId: batchId,
    metadata: {
      oldSellingPrice: existing.selling_price,
      newSellingPrice: nextSellingPrice,
      changeSource: input.changeSource ?? 'MANUAL_UPDATE',
      reason: input.reason ?? null,
    },
  });

  const updated = await trx.db
    .selectFrom('inventory_batches')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', batchId)
    .executeTakeFirstOrThrow();

  return mapBatchRow(updated, baseCurrency);
}

export async function generateBatchBarcode(
  trx: TenantTransactionContext,
  batchId: string,
  input?: GenerateBatchBarcodeRequest,
): Promise<GenerateBatchBarcodeResponse> {
  const existing = await trx.db
    .selectFrom('inventory_batches')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', batchId)
    .forUpdate()
    .executeTakeFirst();

  if (!existing) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'INV_BATCH_NOT_FOUND',
      title: 'Batch Not Found',
      detail: `Batch "${batchId}" was not found.`,
    });
  }

  await assertAuthorized(trx, {
    permission: 'inv:batch:manage',
    warehouseId: existing.warehouse_id,
  });

  if (existing.internal_barcode && !input?.forceRegenerate) {
    return {
      batchId,
      internalBarcode: existing.internal_barcode,
      internalBarcodeType: existing.internal_barcode_type ?? 'CODE128',
      alreadyExisted: true,
    };
  }

  const prefix = input?.prefix?.trim().toUpperCase() || 'NB-B';
  const symbology = input?.symbology ?? 'CODE128';
  const internalBarcode = await generateUniqueInternalBatchBarcodeValue(trx, prefix);
  const now = new Date();

  await trx.db
    .updateTable('inventory_batches')
    .set({
      internal_barcode: internalBarcode,
      internal_barcode_type: symbology,
      updated_at: now,
    })
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', batchId)
    .execute();

  await appendAuditLog(trx, {
    action: 'INV_BATCH_BARCODE_GENERATED',
    resourceType: 'INVENTORY_BATCH',
    resourceId: batchId,
    metadata: {
      batchNumber: existing.batch_number,
      internalBarcode,
      symbology,
      regenerated: Boolean(existing.internal_barcode),
    },
  });

  return {
    batchId,
    internalBarcode,
    internalBarcodeType: symbology,
    alreadyExisted: false,
  };
}

export async function recordBatchBarcodePrintLog(
  trx: TenantTransactionContext,
  batchId: string,
  input: BatchBarcodePrintLogRequest,
): Promise<BatchBarcodePrintLogResponse> {
  const batch = await trx.db
    .selectFrom('inventory_batches')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', batchId)
    .executeTakeFirst();

  if (!batch) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'INV_BATCH_NOT_FOUND',
      title: 'Batch Not Found',
      detail: `Batch "${batchId}" was not found.`,
    });
  }

  await assertAuthorized(trx, {
    permission: 'inv:batch:read',
    warehouseId: batch.warehouse_id,
  });

  let barcodeValue = batch.internal_barcode;
  if (!barcodeValue) {
    barcodeValue = await generateUniqueInternalBatchBarcodeValue(trx);
    await trx.db
      .updateTable('inventory_batches')
      .set({
        internal_barcode: barcodeValue,
        internal_barcode_type: 'CODE128',
        updated_at: new Date(),
      })
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', batchId)
      .execute();
  }

  const id = generateUuidV7();
  const now = new Date();
  const printReason = input.printReason ?? 'REPRINT';
  const dbFormatMap = {
    '40x30': 'THERMAL_40X30',
    '50x30': 'THERMAL_50X30',
    '50x40': 'THERMAL_50X40',
    '58mm': 'THERMAL_58',
    '80mm': 'THERMAL_80',
    A4: 'A4_SHEET',
  } as const;
  const dbLabelFormat = dbFormatMap[input.labelFormat];

  await trx.db
    .insertInto('batch_barcode_print_logs')
    .values({
      id,
      tenant_id: trx.tenantId,
      branch_id: batch.branch_id ?? null,
      product_id: batch.product_id,
      batch_id: batchId,
      barcode_value: barcodeValue,
      label_format: dbLabelFormat,
      print_quantity: input.copies,
      is_reprint: printReason !== 'INITIAL_RECEIVE',
      printed_by_user_id: trx.userId,
      printed_at: now,
    })
    .execute();

  await appendAuditLog(trx, {
    action: 'INV_BATCH_BARCODE_PRINTED',
    resourceType: 'INVENTORY_BATCH',
    resourceId: batchId,
    metadata: {
      barcodeValue,
      labelFormat: input.labelFormat,
      dbLabelFormat,
      copies: input.copies,
      printReason,
      printerName: input.printerName ?? null,
      deviceId: input.deviceId ?? null,
    },
  });

  return {
    id,
    tenantId: trx.tenantId,
    batchId,
    barcodeValue,
    labelFormat: input.labelFormat,
    copies: input.copies,
    printedBy: trx.userId,
    printerName: input.printerName ?? null,
    printReason,
    deviceId: input.deviceId ?? null,
    printedAt: now.toISOString(),
  };
}

export async function getBatchHistory(
  trx: TenantTransactionContext,
  batchId: string,
): Promise<BatchHistoryResponse> {
  const batchRow = await trx.db
    .selectFrom('inventory_batches')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', batchId)
    .executeTakeFirst();

  if (!batchRow) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'INV_BATCH_NOT_FOUND',
      title: 'Batch Not Found',
      detail: `Batch "${batchId}" was not found.`,
    });
  }

  await assertAuthorized(trx, {
    permission: 'inv:batch:read',
    warehouseId: batchRow.warehouse_id,
  });

  const [baseCurrency, priceHistoryRows, printLogRows, ledgerRows] = await Promise.all([
    getTenantBaseCurrency(trx),
    trx.db
      .selectFrom('batch_price_history')
      .selectAll()
      .where('tenant_id', '=', trx.tenantId)
      .where('batch_id', '=', batchId)
      .orderBy('created_at', 'desc')
      .execute(),
    trx.db
      .selectFrom('batch_barcode_print_logs')
      .selectAll()
      .where('tenant_id', '=', trx.tenantId)
      .where('batch_id', '=', batchId)
      .orderBy('printed_at', 'desc')
      .execute(),
    trx.db
      .selectFrom('stock_ledger_entries')
      .selectAll()
      .where('tenant_id', '=', trx.tenantId)
      .where('batch_id', '=', batchId)
      .orderBy('occurred_at', 'desc')
      .limit(100)
      .execute(),
  ]);

  const ccy = batchRow.currency_code || baseCurrency;

  const priceHistory: BatchPriceHistoryEntry[] = priceHistoryRows.map((p) => ({
    id: p.id,
    oldSellingPrice:
      p.previous_price != null
        ? Money.fromDecimalString(String(p.previous_price), ccy).toDecimalString()
        : null,
    newSellingPrice:
      p.new_price != null
        ? Money.fromDecimalString(String(p.new_price), ccy).toDecimalString()
        : null,
    oldMinSellingPrice: null,
    newMinSellingPrice: null,
    changeSource: p.change_type,
    reason: p.reason,
    changedBy: p.actor_user_id,
    changedAt: new Date(p.created_at).toISOString(),
  }));

  const printLogs: BatchBarcodePrintLogResponse[] = printLogRows.map((l) => ({
    id: l.id,
    tenantId: l.tenant_id,
    batchId: l.batch_id,
    barcodeValue: l.barcode_value,
    labelFormat: l.label_format,
    copies: Number(l.print_quantity),
    printedBy: l.printed_by_user_id,
    printerName: null,
    printReason: l.is_reprint ? 'REPRINT' : 'INITIAL_RECEIVE',
    deviceId: null,
    printedAt: new Date(l.printed_at).toISOString(),
  }));

  const stockMovements = ledgerRows.map((m) => ({
    id: m.id,
    movementType: m.movement_type as StockMovementType,
    quantityDelta: Quantity.fromDecimalString(String(m.qty_delta)).toDecimalString(),
    unitCost: Money.fromDecimalString(String(m.unit_cost), ccy).toDecimalString(),
    totalCostDelta: Money.fromDecimalString(String(m.total_cost_delta), ccy).toDecimalString(),
    referenceType: m.reference_type ?? 'MANUAL',
    referenceId: m.reference_id ?? m.id,
    notes: m.reason ?? null,
    createdAt: new Date(m.occurred_at).toISOString(),
  }));

  return {
    batch: mapBatchRow(batchRow, baseCurrency),
    priceHistory,
    printLogs,
    stockMovements,
  };
}

export async function resolveHybridBarcode(
  trx: TenantTransactionContext,
  input: ResolveBarcodeRequest,
): Promise<ResolveBarcodeResponse> {
  await assertAuthorized(trx, {
    permission: 'cat:product:read',
    ...(input.warehouseId ? { warehouseId: input.warehouseId } : {}),
  });

  const baseCurrency = await getTenantBaseCurrency(trx);
  const gs1 = parseGs1Barcode(input.rawBarcode);
  const normalizedBarcode = input.rawBarcode.trim();
  const pricingSettingsRow = await trx.db
    .selectFrom('pricing_settings')
    .select(['batch_pricing_fallback_policy', 'default_batch_allocation_policy'])
    .where('tenant_id', '=', trx.tenantId)
    .executeTakeFirst();

  const tenantFallbackPolicy =
    (pricingSettingsRow?.batch_pricing_fallback_policy as
      | 'BLOCK_MISSING'
      | 'ALLOW_PRODUCT_FALLBACK'
      | undefined) ?? 'ALLOW_PRODUCT_FALLBACK';

  function mapResolvedPriceSource(
    res: ReturnType<typeof resolveEffectiveBatchPrice>,
  ): {
    effectiveUnitPrice: string | null;
    priceSource: ResolveBarcodeResponse['priceSource'];
    requiresPricePrompt: boolean;
    missingPriceBlocked: boolean;
  } {
    if (!res.ok) {
      return {
        effectiveUnitPrice: null,
        priceSource: 'MISSING_BLOCKED',
        requiresPricePrompt: true,
        missingPriceBlocked: true,
      };
    }
    const sourceMap: Record<
      Extract<ReturnType<typeof resolveEffectiveBatchPrice>, { ok: true }>['source'],
      ResolveBarcodeResponse['priceSource']
    > = {
      EXPLICIT_BATCH_PRICE: 'BATCH_EXPLICIT',
      POS_BATCH_OVERRIDE: 'BATCH_EXPLICIT',
      BRANCH_DEFAULT_FALLBACK: 'BRANCH_OVERRIDE',
      PRODUCT_DEFAULT_FALLBACK: 'PRODUCT_FALLBACK',
    };
    return {
      effectiveUnitPrice: res.resolvedPrice,
      priceSource: sourceMap[res.source],
      requiresPricePrompt: false,
      missingPriceBlocked: false,
    };
  }

  const todayStr = new Date().toISOString().slice(0, 10);

  async function resolveProductEffectivePriceContext(
    productId: string,
    _globalSellingPrice: string,
  ): Promise<{ branchSellingPrice: string | null }> {
    if (!input.branchId) {
      return { branchSellingPrice: null };
    }
    const branchOverride = await trx.db
      .selectFrom('product_branch_prices')
      .select(['selling_price'])
      .where('tenant_id', '=', trx.tenantId)
      .where('branch_id', '=', input.branchId)
      .where('product_id', '=', productId)
      .where('is_active', '=', true)
      .executeTakeFirst();
    return {
      branchSellingPrice:
        branchOverride?.selling_price != null
          ? Money.fromDecimalString(
              String(branchOverride.selling_price),
              baseCurrency,
            ).toDecimalString()
          : null,
    };
  }

  async function resolveTargetWarehouseId(): Promise<string | null> {
    if (input.warehouseId) return input.warehouseId;
    if (input.branchId) {
      const wh = await trx.db
        .selectFrom('warehouses')
        .select(['id'])
        .where('tenant_id', '=', trx.tenantId)
        .where('branch_id', '=', input.branchId)
        .where('is_active', '=', true)
        .executeTakeFirst();
      return wh?.id ?? null;
    }
    return null;
  }

  async function resolveProductAvailableBalance(
    productId: string,
    trackInventory: boolean,
    targetWarehouseId: string | null,
  ): Promise<string> {
    if (!trackInventory) return '0.000000';
    if (targetWarehouseId) {
      const balRow = await trx.db
        .selectFrom('inventory_balances')
        .select(['qty_on_hand', 'qty_reserved'])
        .where('tenant_id', '=', trx.tenantId)
        .where('warehouse_id', '=', targetWarehouseId)
        .where('product_id', '=', productId)
        .executeTakeFirst();
      if (!balRow) return '0.000000';
      const onHand = Quantity.fromDecimalString(String(balRow.qty_on_hand));
      const reserved = Quantity.fromDecimalString(
        String(balRow.qty_reserved ?? '0.000000'),
      );
      const diff = onHand.subtract(reserved);
      return (diff.isPositive() ? diff : Quantity.zero()).toDecimalString();
    }

    const balRows = await trx.db
      .selectFrom('inventory_balances')
      .select(['qty_on_hand', 'qty_reserved'])
      .where('tenant_id', '=', trx.tenantId)
      .where('product_id', '=', productId)
      .execute();
    let total = Quantity.zero();
    for (const b of balRows) {
      const onHand = Quantity.fromDecimalString(String(b.qty_on_hand));
      const reserved = Quantity.fromDecimalString(
        String(b.qty_reserved ?? '0.000000'),
      );
      const diff = onHand.subtract(reserved);
      if (diff.isPositive()) {
        total = total.add(diff);
      }
    }
    return total.toDecimalString();
  }

  function mapProductSummary(
    prod: {
      id: string;
      sku: string;
      name: string;
      base_uom: string;
      tracking_mode: string;
      track_inventory?: boolean;
      product_qty_mode?: string | null;
      allocation_policy: string;
      require_batch_selling_price: boolean;
      selling_price: string;
      primary_barcode: string | null;
    },
    availableQuantityStr = '0.000000',
  ) {
    return {
      id: prod.id,
      sku: prod.sku,
      name: prod.name,
      baseUom: prod.base_uom,
      trackingMode: prod.tracking_mode as 'NONE' | 'BATCH' | 'BATCH_EXPIRY' | 'SERIAL',
      trackInventory: prod.track_inventory !== false,
      productQtyMode: (prod.product_qty_mode ?? 'STANDARD') as 'STANDARD' | 'VARIABLE',
      availableQuantity: availableQuantityStr,
      allocationPolicy: (prod.allocation_policy ?? 'FEFO') as BatchAllocationPolicy,
      requireBatchSellingPrice: Boolean(prod.require_batch_selling_price),
      sellingPrice: Money.fromDecimalString(
        String(prod.selling_price),
        baseCurrency,
      ).toDecimalString(),
      primaryBarcode: prod.primary_barcode,
    };
  }

  async function buildExactBatchResponse(
    matchedBy: 'INTERNAL_BATCH' | 'GS1_BATCH_AND_PRODUCT',
    batchRow: Selectable<InventoryBatchesTable>,
  ): Promise<ResolveBarcodeResponse> {
    const productRow = await trx.db
      .selectFrom('products')
      .selectAll()
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', batchRow.product_id)
      .executeTakeFirstOrThrow();

    const mappedBatch = mapBatchRow(batchRow, baseCurrency);
    const { branchSellingPrice } = await resolveProductEffectivePriceContext(
      productRow.id,
      String(productRow.selling_price),
    );

    let blockedReason: string | null = null;
    if (input.branchId && batchRow.branch_id && batchRow.branch_id !== input.branchId) {
      blockedReason = 'BATCH_WRONG_BRANCH';
    } else if (
      input.warehouseId &&
      batchRow.warehouse_id !== input.warehouseId
    ) {
      blockedReason = 'BATCH_WRONG_WAREHOUSE';
    } else if (batchRow.status !== 'ACTIVE') {
      blockedReason = `BATCH_${batchRow.status}`;
    } else if (mappedBatch.expiryDate && mappedBatch.expiryDate < todayStr) {
      blockedReason = 'BATCH_EXPIRED';
    } else if (!Quantity.fromDecimalString(mappedBatch.availableQuantity ?? '0').isPositive()) {
      blockedReason = 'BATCH_INSUFFICIENT_STOCK';
    }

    const priceResolution = resolveEffectiveBatchPrice({
      batchNumber: mappedBatch.batchNumber,
      batchSellingPrice: mappedBatch.sellingPrice ?? null,
      batchMinSellingPrice: mappedBatch.minSellingPrice ?? null,
      batchMaxDiscountPct: mappedBatch.maxDiscountPct ?? null,
      batchPricingMode: mappedBatch.batchPricingMode ?? 'EXPLICIT',
      productSellingPrice: Money.fromDecimalString(
        String(productRow.selling_price),
        baseCurrency,
      ).toDecimalString(),
      productMinSellingPrice: null,
      productMaxDiscountPct: null,
      branchSellingPrice,
      fallbackPolicy: tenantFallbackPolicy,
      requireBatchSellingPrice: Boolean(productRow.require_batch_selling_price),
      currencyCode: baseCurrency,
    });

    const mappedPrice = mapResolvedPriceSource(priceResolution);

    if (!blockedReason && mappedPrice.missingPriceBlocked) {
      blockedReason = 'BATCH_PRICE_REQUIRED';
    }

    const batchAvailStr = mappedBatch.availableQuantity ?? mappedBatch.currentQuantity;

    return {
      matchedBy,
      rawBarcode: input.rawBarcode,
      normalizedBarcode: batchRow.internal_barcode ?? normalizedBarcode,
      isExactBatchLocked: true,
      gs1Parsed: {
        isGs1: gs1.isGs1,
        gtin: gs1.gtin14 ?? null,
        batchNumber: gs1.batchNumber ?? null,
        expiryDate: gs1.expiryDate ?? null,
        serialNumber: gs1.serialNumber ?? null,
      },
      product: mapProductSummary(productRow, batchAvailStr),
      exactBatch: mappedBatch,
      availableQuantityTotal: batchAvailStr,
      effectiveUnitPrice: mappedPrice.effectiveUnitPrice,
      priceSource: mappedPrice.priceSource,
      requiresPricePrompt: mappedPrice.requiresPricePrompt,
      blockedReason,
      fefoPreview: [
        {
          batchId: mappedBatch.id,
          batchNumber: mappedBatch.batchNumber,
          internalBarcode: mappedBatch.internalBarcode ?? null,
          expiryDate: mappedBatch.expiryDate,
          availableQty: batchAvailStr,
          reservedQty: mappedBatch.reservedQuantity ?? '0.000000',
          allocatedQty: input.requestedQty ?? '1.000000',
          unitCost: mappedBatch.unitCost,
          sellingPrice: mappedBatch.sellingPrice ?? null,
          batchPricingMode: mappedBatch.batchPricingMode ?? 'EXPLICIT',
        },
      ],
    };
  }

  // Priority 1: Exact internal batch barcode
  const upperNormalized = normalizedBarcode.toUpperCase();
  const internalBatchMatch = await trx.db
    .selectFrom('inventory_batches')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where((eb) =>
      eb.or([
        eb('internal_barcode', '=', normalizedBarcode),
        eb('internal_barcode', '=', upperNormalized),
      ]),
    )
    .executeTakeFirst();

  if (internalBatchMatch) {
    return buildExactBatchResponse('INTERNAL_BATCH', internalBatchMatch);
  }

  // Helper to lookup product by barcode candidates
  async function findProductByBarcodeCandidates(candidates: readonly string[]) {
    if (candidates.length === 0) return undefined;
    const expanded = [
      ...new Set(
        candidates.flatMap((c) => [c, c.toUpperCase(), c.toLowerCase()]),
      ),
    ];
    const pbMatch = await trx.db
      .selectFrom('product_barcodes')
      .select(['product_id', 'barcode'])
      .where('tenant_id', '=', trx.tenantId)
      .where('is_active', '=', true)
      .where('barcode', 'in', expanded)
      .executeTakeFirst();
    if (pbMatch) {
      return trx.db
        .selectFrom('products')
        .selectAll()
        .where('tenant_id', '=', trx.tenantId)
        .where('id', '=', pbMatch.product_id)
        .executeTakeFirst();
    }
    return trx.db
      .selectFrom('products')
      .selectAll()
      .where('tenant_id', '=', trx.tenantId)
      .where('primary_barcode', 'in', expanded)
      .executeTakeFirst();
  }

  // Helper to build product-barcode match + optional FEFO/FIFO preview
  async function buildProductMatchResponse(
    matchedBy: 'GS1_PRODUCT_ONLY' | 'MANUFACTURER_PRODUCT_BARCODE' | 'SKU',
    productRow: NonNullable<Awaited<ReturnType<typeof findProductByBarcodeCandidates>>>,
    matchedBarcodeText: string,
  ): Promise<ResolveBarcodeResponse> {
    const targetWarehouseId = await resolveTargetWarehouseId();
    const balanceAvailStr = await resolveProductAvailableBalance(
      productRow.id,
      Boolean(productRow.track_inventory),
      targetWarehouseId,
    );
    let availableQuantityTotal = balanceAvailStr;

    const baseProductSummary = mapProductSummary(productRow, availableQuantityTotal);
    const { branchSellingPrice } = await resolveProductEffectivePriceContext(
      productRow.id,
      String(productRow.selling_price),
    );

    let fefoPreview: FefoBatchAllocation[] = [];
    let effectiveUnitPrice: string | null =
      branchSellingPrice ?? baseProductSummary.sellingPrice;
    let priceSource: ResolveBarcodeResponse['priceSource'] = branchSellingPrice
      ? 'BRANCH_OVERRIDE'
      : 'GLOBAL_PRODUCT';
    let requiresPricePrompt = false;
    let blockedReason: string | null = null;

    if (
      (productRow.tracking_mode === 'BATCH' ||
        productRow.tracking_mode === 'BATCH_EXPIRY') &&
      targetWarehouseId
    ) {
      const fefo = await selectFefoBatches(trx, {
        warehouseId: targetWarehouseId,
        productId: productRow.id,
        requiredQuantity: input.requestedQty ?? '1',
        skipPermissionCheck: true,
      });
      fefoPreview = fefo.allocations;

      if (fefo.allocations.length > 0) {
        const allActiveBatches = await trx.db
          .selectFrom('inventory_batches')
          .select(['current_quantity', 'reserved_quantity', 'expiry_date'])
          .where('tenant_id', '=', trx.tenantId)
          .where('warehouse_id', '=', targetWarehouseId)
          .where('product_id', '=', productRow.id)
          .where('status', '=', 'ACTIVE')
          .execute();
        let batchAvailSum = Quantity.zero();
        for (const b of allActiveBatches) {
          const expRaw: unknown = b.expiry_date;
          const expStr = expRaw
            ? typeof expRaw === 'string'
              ? expRaw.slice(0, 10)
              : (expRaw as Date).toISOString().slice(0, 10)
            : null;
          if (expStr && expStr < todayStr) continue;
          const cur = Quantity.fromDecimalString(String(b.current_quantity));
          const res = Quantity.fromDecimalString(
            String(b.reserved_quantity ?? '0.000000'),
          );
          const diff = cur.subtract(res);
          if (diff.isPositive()) {
            batchAvailSum = batchAvailSum.add(diff);
          }
        }
        availableQuantityTotal = batchAvailSum.toDecimalString();

        const primaryAlloc = fefo.allocations[0]!;
        const priceResolution = resolveEffectiveBatchPrice({
          batchNumber: primaryAlloc.batchNumber,
          batchSellingPrice: primaryAlloc.sellingPrice ?? null,
          batchPricingMode: primaryAlloc.batchPricingMode ?? 'EXPLICIT',
          productSellingPrice: baseProductSummary.sellingPrice,
          productMinSellingPrice: null,
          productMaxDiscountPct: null,
          branchSellingPrice,
          fallbackPolicy: tenantFallbackPolicy,
          requireBatchSellingPrice: baseProductSummary.requireBatchSellingPrice,
          currencyCode: baseCurrency,
        });
        const mappedPrice = mapResolvedPriceSource(priceResolution);
        effectiveUnitPrice = mappedPrice.effectiveUnitPrice;
        priceSource = mappedPrice.priceSource;
        requiresPricePrompt = mappedPrice.requiresPricePrompt;
        if (mappedPrice.missingPriceBlocked) {
          blockedReason = 'BATCH_PRICE_REQUIRED';
        }
      } else {
        const warehouseBatchRows = await trx.db
          .selectFrom('inventory_batches')
          .select(['id'])
          .where('tenant_id', '=', trx.tenantId)
          .where('warehouse_id', '=', targetWarehouseId)
          .where('product_id', '=', productRow.id)
          .limit(1)
          .execute();

        if (
          warehouseBatchRows.length === 0 &&
          (!productRow.track_inventory ||
            Quantity.fromDecimalString(balanceAvailStr).isPositive())
        ) {
          // Product has unbatched stock in inventory_balances and zero batch records
          blockedReason = null;
          availableQuantityTotal = balanceAvailStr;
        } else {
          blockedReason = 'NO_ELIGIBLE_BATCH_AVAILABLE';
          availableQuantityTotal = '0.000000';
        }
      }
    }

    const productSummary = mapProductSummary(productRow, availableQuantityTotal);

    return {
      matchedBy,
      rawBarcode: input.rawBarcode,
      normalizedBarcode: matchedBarcodeText,
      isExactBatchLocked: false,
      gs1Parsed: {
        isGs1: gs1.isGs1,
        gtin: gs1.gtin14 ?? null,
        batchNumber: gs1.batchNumber ?? null,
        expiryDate: gs1.expiryDate ?? null,
        serialNumber: gs1.serialNumber ?? null,
      },
      product: productSummary,
      exactBatch: null,
      availableQuantityTotal,
      effectiveUnitPrice,
      priceSource,
      requiresPricePrompt,
      blockedReason,
      fefoPreview,
    };
  }

  // Priority 2: GS1 composite barcode
  if (gs1.isGs1 && gs1.gtin14) {
    const gtinCandidates = normalizeBarcodeCandidates(gs1.gtin14);
    const gs1Product = await findProductByBarcodeCandidates(gtinCandidates);
    if (gs1Product) {
      if (gs1.batchNumber) {
        let batchLookup = trx.db
          .selectFrom('inventory_batches')
          .selectAll()
          .where('tenant_id', '=', trx.tenantId)
          .where('product_id', '=', gs1Product.id)
          .where('batch_number', '=', gs1.batchNumber.toUpperCase());
        if (input.warehouseId) {
          batchLookup = batchLookup.where('warehouse_id', '=', input.warehouseId);
        } else if (input.branchId) {
          batchLookup = batchLookup.where('branch_id', '=', input.branchId);
        }
        const gs1Batch = await batchLookup.executeTakeFirst();
        if (gs1Batch) {
          return buildExactBatchResponse('GS1_BATCH_AND_PRODUCT', gs1Batch);
        }
      }
      return buildProductMatchResponse(
        'GS1_PRODUCT_ONLY',
        gs1Product,
        gs1.gtin14,
      );
    }
  }

  // Priority 3: Standard manufacturer product barcode
  const candidates = normalizeBarcodeCandidates(input.rawBarcode);
  const productMatch = await findProductByBarcodeCandidates(candidates);
  if (productMatch) {
    return buildProductMatchResponse(
      'MANUFACTURER_PRODUCT_BARCODE',
      productMatch,
      candidates[0] ?? normalizedBarcode,
    );
  }

  // Priority 4: Serial number or SKU
  const serialMatch = await trx.db
    .selectFrom('inventory_serials')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('serial_number', '=', normalizedBarcode)
    .executeTakeFirst();

  if (serialMatch) {
    const serialProduct = await trx.db
      .selectFrom('products')
      .selectAll()
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', serialMatch.product_id)
      .executeTakeFirstOrThrow();

    const { branchSellingPrice } = await resolveProductEffectivePriceContext(
      serialProduct.id,
      String(serialProduct.selling_price),
    );
    const serialBlocked =
      serialMatch.status !== 'IN_STOCK' ? `SERIAL_${serialMatch.status}` : null;
    const serialAvailStr =
      serialMatch.status === 'IN_STOCK' ? '1.000000' : '0.000000';
    return {
      matchedBy: 'SERIAL_NUMBER',
      rawBarcode: input.rawBarcode,
      normalizedBarcode: serialMatch.serial_number,
      isExactBatchLocked: false,
      gs1Parsed: {
        isGs1: gs1.isGs1,
        gtin: gs1.gtin14 ?? null,
        batchNumber: gs1.batchNumber ?? null,
        expiryDate: gs1.expiryDate ?? null,
        serialNumber: serialMatch.serial_number,
      },
      product: mapProductSummary(serialProduct, serialAvailStr),
      exactBatch: null,
      availableQuantityTotal: serialAvailStr,
      effectiveUnitPrice:
        branchSellingPrice ??
        Money.fromDecimalString(
          String(serialProduct.selling_price),
          baseCurrency,
        ).toDecimalString(),
      priceSource: branchSellingPrice ? 'BRANCH_OVERRIDE' : 'GLOBAL_PRODUCT',
      requiresPricePrompt: false,
      blockedReason: serialBlocked,
      fefoPreview: [],
    };
  }

  const skuMatch = await trx.db
    .selectFrom('products')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where((eb) =>
      eb.or([
        eb('sku', '=', normalizedBarcode),
        eb('sku', '=', upperNormalized),
      ]),
    )
    .executeTakeFirst();

  if (skuMatch) {
    return buildProductMatchResponse('SKU', skuMatch, skuMatch.sku);
  }

  return {
    matchedBy: 'UNRESOLVED',
    rawBarcode: input.rawBarcode,
    normalizedBarcode,
    isExactBatchLocked: false,
    gs1Parsed: {
      isGs1: gs1.isGs1,
      gtin: gs1.gtin14 ?? null,
      batchNumber: gs1.batchNumber ?? null,
      expiryDate: gs1.expiryDate ?? null,
      serialNumber: gs1.serialNumber ?? null,
    },
    product: null,
    exactBatch: null,
    availableQuantityTotal: '0.000000',
    effectiveUnitPrice: null,
    priceSource: null,
    requiresPricePrompt: false,
    blockedReason: null,
    fefoPreview: [],
  };
}

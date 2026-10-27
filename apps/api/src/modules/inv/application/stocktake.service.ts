import type {
  CreateStocktakeSessionRequest,
  ListStocktakeSessionsQuery,
  RecordStocktakeCountRequest,
  ReviewStocktakeRequest,
  StocktakeLineResponse,
  StocktakeScope,
  StocktakeSessionResponse,
  StocktakeStatus,
} from '@nexstock/contracts';
import { Money, Quantity } from '@nexstock/domain-core';
import type { Selectable } from 'kysely';
import type { CursorPaginatedResult } from '../../cat/index.js';
import { assertAuthorized } from '../../iam/index.js';
import {
  AppError,
  type StocktakeSessionsTable,
  type TenantTransactionContext,
  appendAuditLog,
  generateUuidV7,
} from '../../shared/index.js';
import { assertSubscriptionEntitlement } from '../../sub/index.js';
import { postStockMovement } from './inv.service.js';

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

function generateStocktakeCountNumber(): string {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `STK-${yyyy}${mm}${dd}-${rand}`;
}

async function mapStocktakeSession(
  trx: TenantTransactionContext,
  session: Selectable<StocktakeSessionsTable>,
  includeLines = true,
): Promise<StocktakeSessionResponse> {
  const baseCurrency = await getTenantBaseCurrency(trx);

  let lines: StocktakeLineResponse[] | undefined = undefined;
  let totalLinesCount = 0;
  let discrepantLinesCount = 0;
  let totalVariance = Money.zero(baseCurrency);

  const lineRows = await trx.db
    .selectFrom('stocktake_lines')
    .innerJoin('products', 'products.id', 'stocktake_lines.product_id')
    .leftJoin('inventory_batches', 'inventory_batches.id', 'stocktake_lines.batch_id')
    .select([
      'stocktake_lines.id',
      'stocktake_lines.product_id',
      'products.sku as product_sku',
      'products.name as product_name',
      'stocktake_lines.batch_id',
      'inventory_batches.batch_number as batch_number',
      'stocktake_lines.expected_qty',
      'stocktake_lines.counted_qty',
      'stocktake_lines.variance_qty',
      'stocktake_lines.unit_cost',
      'stocktake_lines.variance_value',
      'stocktake_lines.adjustment_movement_id',
      'stocktake_lines.notes',
    ])
    .where('stocktake_lines.tenant_id', '=', trx.tenantId)
    .where('stocktake_lines.session_id', '=', session.id)
    .orderBy('products.sku', 'asc')
    .execute();

  totalLinesCount = lineRows.length;

  for (const l of lineRows) {
    const varValue = Money.fromDecimalString(
      String(l.variance_value ?? '0.0000'),
      baseCurrency,
    );
    totalVariance = totalVariance.add(varValue);

    if (l.variance_qty && !Quantity.fromDecimalString(String(l.variance_qty)).isZero()) {
      discrepantLinesCount++;
    }
  }

  if (includeLines) {
    lines = lineRows.map((l) => ({
      id: l.id,
      productId: l.product_id,
      productSku: l.product_sku,
      productName: l.product_name,
      batchId: l.batch_id,
      batchNumber: l.batch_number,
      expectedQty: Quantity.fromDecimalString(String(l.expected_qty)).toDecimalString(),
      countedQty: l.counted_qty
        ? Quantity.fromDecimalString(String(l.counted_qty)).toDecimalString()
        : null,
      varianceQty: l.variance_qty
        ? Quantity.fromDecimalString(String(l.variance_qty)).toDecimalString()
        : null,
      unitCost: Money.fromDecimalString(
        String(l.unit_cost),
        baseCurrency,
      ).toDecimalString(),
      varianceValue: Money.fromDecimalString(
        String(l.variance_value ?? '0.0000'),
        baseCurrency,
      ).toDecimalString(),
      adjustmentMovementId: l.adjustment_movement_id,
      notes: l.notes,
    }));
  }

  return {
    id: session.id,
    countNumber: session.count_number,
    branchId: session.branch_id,
    warehouseId: session.warehouse_id,
    scope: session.scope as StocktakeScope,
    categoryId: session.category_id,
    status: session.status as StocktakeStatus,
    startedAt: session.started_at ? new Date(session.started_at).toISOString() : null,
    completedAt: session.completed_at
      ? new Date(session.completed_at).toISOString()
      : null,
    countedByUserId: session.counted_by_user_id,
    reviewedByUserId: session.reviewed_by_user_id,
    rejectionReason: session.rejection_reason,
    notes: session.notes,
    totalLinesCount,
    discrepantLinesCount,
    totalVarianceValue: totalVariance.toDecimalString(),
    ...(lines ? { lines } : {}),
    createdAt: new Date(session.created_at).toISOString(),
    updatedAt: new Date(session.updated_at).toISOString(),
  };
}

export async function createStocktakeSession(
  trx: TenantTransactionContext,
  input: CreateStocktakeSessionRequest,
): Promise<StocktakeSessionResponse> {
  await assertAuthorized(trx, {
    permission: 'inv:count:create',
    branchId: input.branchId,
    warehouseId: input.warehouseId,
  });

  await assertSubscriptionEntitlement(trx, {
    requireWriteAccess: true,
  });

  const warehouse = await trx.db
    .selectFrom('warehouses')
    .select(['id', 'is_active', 'branch_id'])
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

  // Determine candidate products to snapshot
  let productsQuery = trx.db
    .selectFrom('products')
    .select(['id', 'sku', 'name', 'purchase_cost', 'base_uom'])
    .where('tenant_id', '=', trx.tenantId)
    .where('status', '=', 'ACTIVE')
    .where('track_inventory', '=', true);

  if (input.scope === 'CATEGORY') {
    if (!input.categoryId) {
      throw new AppError({
        statusCode: 400,
        errorCode: 'ERR_VALIDATION_FAILED',
        title: 'Category Required',
        detail: 'Stocktake with scope="CATEGORY" requires a valid categoryId.',
      });
    }
    productsQuery = productsQuery.where('category_id', '=', input.categoryId);
  } else if (input.scope === 'PARTIAL') {
    if (!input.productIds || input.productIds.length === 0) {
      throw new AppError({
        statusCode: 400,
        errorCode: 'ERR_VALIDATION_FAILED',
        title: 'Product IDs Required',
        detail: 'Stocktake with scope="PARTIAL" requires at least one productId in productIds.',
      });
    }
    productsQuery = productsQuery.where('id', 'in', input.productIds);
  }

  const products = await productsQuery.execute();
  if (products.length === 0) {
    throw new AppError({
      statusCode: 422,
      errorCode: 'INV_STOCKTAKE_NO_ELIGIBLE_PRODUCTS',
      title: 'No Eligible Products in Scope',
      detail: 'No active stock-tracked products matched the specified stocktake scope.',
    });
  }

  // Fetch balances for these products in this warehouse
  const productIds = products.map((p) => p.id);
  const balances = await trx.db
    .selectFrom('inventory_balances')
    .select(['product_id', 'qty_on_hand', 'moving_avg_cost'])
    .where('tenant_id', '=', trx.tenantId)
    .where('warehouse_id', '=', input.warehouseId)
    .where('product_id', 'in', productIds)
    .execute();

  const balanceMap = new Map<string, { qty: string; cost: string }>();
  for (const b of balances) {
    balanceMap.set(b.product_id, {
      qty: String(b.qty_on_hand),
      cost: String(b.moving_avg_cost),
    });
  }

  const sessionId = generateUuidV7();
  const countNumber = generateStocktakeCountNumber();
  const now = new Date();

  await trx.db
    .insertInto('stocktake_sessions')
    .values({
      id: sessionId,
      tenant_id: trx.tenantId,
      count_number: countNumber,
      branch_id: input.branchId,
      warehouse_id: input.warehouseId,
      scope: input.scope,
      category_id: input.categoryId ?? null,
      status: 'DRAFT',
      started_at: now,
      completed_at: null,
      counted_by_user_id: null,
      reviewed_by_user_id: null,
      rejection_reason: null,
      notes: input.notes?.trim() ?? null,
      sync_version: 1,
      created_at: now,
      updated_at: now,
    })
    .execute();

  for (const p of products) {
    const bal = balanceMap.get(p.id);
    const expectedQty = bal
      ? Quantity.fromDecimalString(bal.qty).toDecimalString()
      : '0.000000';
    const unitCost = bal ? bal.cost : String(p.purchase_cost);

    await trx.db
      .insertInto('stocktake_lines')
      .values({
        id: generateUuidV7(),
        tenant_id: trx.tenantId,
        session_id: sessionId,
        product_id: p.id,
        batch_id: null,
        expected_qty: expectedQty,
        counted_qty: null,
        variance_qty: null,
        unit_cost: unitCost,
        variance_value: '0.0000',
        adjustment_movement_id: null,
        notes: null,
      })
      .execute();
  }

  await appendAuditLog(trx, {
    action: 'INV_STOCKTAKE_SESSION_CREATED',
    resourceType: 'STOCKTAKE_SESSION',
    resourceId: sessionId,
    metadata: {
      countNumber,
      warehouseId: input.warehouseId,
      branchId: input.branchId,
      scope: input.scope,
      totalLines: products.length,
    },
  });

  const sessionRow = await trx.db
    .selectFrom('stocktake_sessions')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', sessionId)
    .executeTakeFirstOrThrow();

  return mapStocktakeSession(trx, sessionRow, true);
}

export async function getStocktakeSessionById(
  trx: TenantTransactionContext,
  sessionId: string,
): Promise<StocktakeSessionResponse> {
  const sessionRow = await trx.db
    .selectFrom('stocktake_sessions')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', sessionId)
    .executeTakeFirst();

  if (!sessionRow) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'ERR_NOT_FOUND',
      title: 'Stocktake Session Not Found',
      detail: `Stocktake session "${sessionId}" was not found.`,
    });
  }

  await assertAuthorized(trx, {
    permission: 'inv:count:read',
    branchId: sessionRow.branch_id,
    warehouseId: sessionRow.warehouse_id,
  });

  return mapStocktakeSession(trx, sessionRow, true);
}

export async function listStocktakeSessions(
  trx: TenantTransactionContext,
  query: ListStocktakeSessionsQuery,
): Promise<CursorPaginatedResult<StocktakeSessionResponse>> {
  await assertAuthorized(trx, {
    permission: 'inv:count:read',
    ...(query.warehouseId ? { warehouseId: query.warehouseId } : {}),
  });

  const limit = Math.min(Math.max(Number(query.limit ?? 50), 1), 100);

  let dbQuery = trx.db
    .selectFrom('stocktake_sessions')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId);

  if (query.warehouseId) {
    dbQuery = dbQuery.where('warehouse_id', '=', query.warehouseId);
  }
  if (query.status) {
    dbQuery = dbQuery.where('status', '=', query.status);
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

  const data: StocktakeSessionResponse[] = [];
  for (const r of items) {
    data.push(await mapStocktakeSession(trx, r, false));
  }

  return {
    data,
    pageInfo: {
      hasNextPage,
      nextCursor,
    },
  };
}

export async function recordStocktakeCounts(
  trx: TenantTransactionContext,
  sessionId: string,
  input: RecordStocktakeCountRequest,
): Promise<StocktakeSessionResponse> {
  const session = await trx.db
    .selectFrom('stocktake_sessions')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', sessionId)
    .forUpdate()
    .executeTakeFirst();

  if (!session) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'ERR_NOT_FOUND',
      title: 'Stocktake Session Not Found',
      detail: `Stocktake session "${sessionId}" was not found.`,
    });
  }

  await assertAuthorized(trx, {
    permission: 'inv:count:create',
    branchId: session.branch_id,
    warehouseId: session.warehouse_id,
  });

  if (session.status !== 'DRAFT' && session.status !== 'IN_PROGRESS') {
    throw new AppError({
      statusCode: 409,
      errorCode: 'INV_STOCKTAKE_NOT_EDITABLE',
      title: 'Stocktake Session Cannot Be Modified',
      detail: `Cannot record counts for session in status "${session.status}". Only DRAFT or IN_PROGRESS can be modified.`,
    });
  }

  const baseCurrency = await getTenantBaseCurrency(trx);
  const now = new Date();

  for (const lineInput of input.lines) {
    const countedQty = Quantity.fromDecimalString(lineInput.countedQty);
    if (countedQty.isNegative()) {
      throw new AppError({
        statusCode: 400,
        errorCode: 'ERR_VALIDATION_FAILED',
        title: 'Negative Counted Quantity Forbidden',
        detail: 'Counted quantity cannot be negative.',
      });
    }

    const lineRow = await trx.db
      .selectFrom('stocktake_lines')
      .selectAll()
      .where('tenant_id', '=', trx.tenantId)
      .where('session_id', '=', sessionId)
      .where('product_id', '=', lineInput.productId)
      .forUpdate()
      .executeTakeFirst();

    if (!lineRow) {
      continue;
    }

    const expectedQty = Quantity.fromDecimalString(String(lineRow.expected_qty));
    const varianceQty = countedQty.subtract(expectedQty);
    const unitCostMoney = Money.fromDecimalString(
      String(lineRow.unit_cost),
      baseCurrency,
    );
    const varianceValue = unitCostMoney.multiplyByQuantity(varianceQty);

    await trx.db
      .updateTable('stocktake_lines')
      .set({
        counted_qty: countedQty.toDecimalString(),
        variance_qty: varianceQty.toDecimalString(),
        variance_value: varianceValue.toDecimalString(),
        notes: lineInput.notes?.trim() ?? lineRow.notes,
      })
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', lineRow.id)
      .execute();
  }

  await trx.db
    .updateTable('stocktake_sessions')
    .set({
      status: 'IN_PROGRESS',
      counted_by_user_id: trx.userId,
      updated_at: now,
    })
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', sessionId)
    .execute();

  const updatedSession = await trx.db
    .selectFrom('stocktake_sessions')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', sessionId)
    .executeTakeFirstOrThrow();

  return mapStocktakeSession(trx, updatedSession, true);
}

export async function submitStocktakeSession(
  trx: TenantTransactionContext,
  sessionId: string,
): Promise<StocktakeSessionResponse> {
  const session = await trx.db
    .selectFrom('stocktake_sessions')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', sessionId)
    .forUpdate()
    .executeTakeFirst();

  if (!session) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'ERR_NOT_FOUND',
      title: 'Stocktake Session Not Found',
      detail: `Stocktake session "${sessionId}" was not found.`,
    });
  }

  await assertAuthorized(trx, {
    permission: 'inv:count:submit',
    branchId: session.branch_id,
    warehouseId: session.warehouse_id,
  });

  if (session.status !== 'DRAFT' && session.status !== 'IN_PROGRESS') {
    throw new AppError({
      statusCode: 409,
      errorCode: 'INV_STOCKTAKE_NOT_EDITABLE',
      title: 'Cannot Submit Stocktake',
      detail: `Session in status "${session.status}" cannot be submitted. Only DRAFT or IN_PROGRESS sessions can be submitted.`,
    });
  }

  const now = new Date();
  await trx.db
    .updateTable('stocktake_sessions')
    .set({
      status: 'SUBMITTED',
      counted_by_user_id: session.counted_by_user_id ?? trx.userId,
      updated_at: now,
    })
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', sessionId)
    .execute();

  await appendAuditLog(trx, {
    action: 'INV_STOCKTAKE_SUBMITTED',
    resourceType: 'STOCKTAKE_SESSION',
    resourceId: sessionId,
    metadata: {
      countNumber: session.count_number,
      countedByUserId: trx.userId,
    },
  });

  const updated = await trx.db
    .selectFrom('stocktake_sessions')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', sessionId)
    .executeTakeFirstOrThrow();

  return mapStocktakeSession(trx, updated, true);
}

export async function reviewStocktakeSession(
  trx: TenantTransactionContext,
  sessionId: string,
  input: ReviewStocktakeRequest,
): Promise<StocktakeSessionResponse> {
  const session = await trx.db
    .selectFrom('stocktake_sessions')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', sessionId)
    .forUpdate()
    .executeTakeFirst();

  if (!session) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'ERR_NOT_FOUND',
      title: 'Stocktake Session Not Found',
      detail: `Stocktake session "${sessionId}" was not found.`,
    });
  }

  await assertAuthorized(trx, {
    permission: 'inv:count:approve',
    branchId: session.branch_id,
    warehouseId: session.warehouse_id,
  });

  if (session.status !== 'SUBMITTED') {
    throw new AppError({
      statusCode: 409,
      errorCode: 'INV_STOCKTAKE_NOT_SUBMITTED',
      title: 'Stocktake Session Not Ready for Review',
      detail: `Only SUBMITTED sessions can be approved or rejected. Current status: "${session.status}".`,
    });
  }

  const now = new Date();

  if (input.action === 'APPROVE') {
    await trx.db
      .updateTable('stocktake_sessions')
      .set({
        status: 'APPROVED',
        reviewed_by_user_id: trx.userId,
        rejection_reason: null,
        updated_at: now,
      })
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', sessionId)
      .execute();

    await appendAuditLog(trx, {
      action: 'INV_STOCKTAKE_APPROVED',
      resourceType: 'STOCKTAKE_SESSION',
      resourceId: sessionId,
      metadata: {
        countNumber: session.count_number,
        reviewedByUserId: trx.userId,
      },
    });
  } else {
    const rejReason = input.rejectionReason?.trim();
    if (!rejReason || rejReason.length < 3) {
      throw new AppError({
        statusCode: 400,
        errorCode: 'ERR_VALIDATION_FAILED',
        title: 'Rejection Reason Required',
        detail: 'A rejection reason of at least 3 characters is required when rejecting a stocktake session.',
      });
    }

    await trx.db
      .updateTable('stocktake_sessions')
      .set({
        status: 'REJECTED',
        reviewed_by_user_id: trx.userId,
        rejection_reason: rejReason,
        updated_at: now,
      })
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', sessionId)
      .execute();

    await appendAuditLog(trx, {
      action: 'INV_STOCKTAKE_REJECTED',
      resourceType: 'STOCKTAKE_SESSION',
      resourceId: sessionId,
      metadata: {
        countNumber: session.count_number,
        reviewedByUserId: trx.userId,
        rejectionReason: rejReason,
      },
    });
  }

  const updated = await trx.db
    .selectFrom('stocktake_sessions')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', sessionId)
    .executeTakeFirstOrThrow();

  return mapStocktakeSession(trx, updated, true);
}

export async function postStocktakeAdjustments(
  trx: TenantTransactionContext,
  sessionId: string,
): Promise<StocktakeSessionResponse> {
  const session = await trx.db
    .selectFrom('stocktake_sessions')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', sessionId)
    .forUpdate()
    .executeTakeFirst();

  if (!session) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'ERR_NOT_FOUND',
      title: 'Stocktake Session Not Found',
      detail: `Stocktake session "${sessionId}" was not found.`,
    });
  }

  await assertAuthorized(trx, {
    permission: 'inv:count:post',
    branchId: session.branch_id,
    warehouseId: session.warehouse_id,
  });

  if (session.status === 'POSTED') {
    throw new AppError({
      statusCode: 409,
      errorCode: 'INV_STOCKTAKE_ALREADY_POSTED',
      title: 'Stocktake Already Posted',
      detail: `Stocktake session "${session.count_number}" has already been posted to the stock ledger.`,
    });
  }

  if (session.status !== 'APPROVED') {
    throw new AppError({
      statusCode: 409,
      errorCode: 'INV_STOCKTAKE_NOT_APPROVED',
      title: 'Stocktake Session Not Approved',
      detail: `Stocktake session "${session.count_number}" must be in APPROVED status before adjustments can be posted. Current status: "${session.status}".`,
    });
  }

  const lines = await trx.db
    .selectFrom('stocktake_lines')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('session_id', '=', sessionId)
    .forUpdate()
    .execute();

  const now = new Date();

  for (const line of lines) {
    if (!line.variance_qty) {
      continue;
    }
    const variance = Quantity.fromDecimalString(String(line.variance_qty));
    if (variance.isZero()) {
      continue;
    }

    const idempotencyKey = generateUuidV7();
    const isPositive = variance.isPositive();
    const movementType = isPositive ? 'ADJUSTMENT_POSITIVE' : 'ADJUSTMENT_NEGATIVE';
    const absQty = variance.abs();

    const movement = await postStockMovement(
      trx,
      idempotencyKey,
      {
        branchId: session.branch_id,
        warehouseId: session.warehouse_id,
        productId: line.product_id,
        movementType,
        quantity: isPositive ? absQty.toDecimalString() : absQty.negate().toDecimalString(),
        unitCost: String(line.unit_cost),
        reason: `Stocktake Reconciliation (${session.count_number})`,
        referenceType: 'STOCKTAKE',
        referenceId: sessionId,
        allowNegativeStockOverride: !isPositive,
        overrideReason: !isPositive
          ? `Stocktake reconciliation negative variance for ${session.count_number}`
          : null,
      },
      { skipPermissionCheck: true },
    );

    await trx.db
      .updateTable('stocktake_lines')
      .set({
        adjustment_movement_id: movement.id,
      })
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', line.id)
      .execute();
  }

  await trx.db
    .updateTable('stocktake_sessions')
    .set({
      status: 'POSTED',
      completed_at: now,
      updated_at: now,
    })
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', sessionId)
    .execute();

  await appendAuditLog(trx, {
    action: 'INV_STOCKTAKE_POSTED',
    resourceType: 'STOCKTAKE_SESSION',
    resourceId: sessionId,
    metadata: {
      countNumber: session.count_number,
      postedByUserId: trx.userId,
    },
  });

  const updatedSession = await trx.db
    .selectFrom('stocktake_sessions')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', sessionId)
    .executeTakeFirstOrThrow();

  return mapStocktakeSession(trx, updatedSession, true);
}

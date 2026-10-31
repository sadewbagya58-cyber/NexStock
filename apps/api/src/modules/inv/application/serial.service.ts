import type {
  CurrencyCode,
  ListSerialsQuery,
  RegisterSerialStockRequest,
  SerialResponse,
  SerialStatus,
  TransitionSerialStatusRequest,
} from '@nexstock/contracts';
import { Money, Quantity } from '@nexstock/domain-core';
import type { Selectable } from 'kysely';
import type { CursorPaginatedResult } from '../../cat/index.js';
import { assertAuthorized } from '../../iam/index.js';
import {
  AppError,
  type InventorySerialsTable,
  type TenantTransactionContext,
  appendAuditLog,
  generateUuidV7,
} from '../../shared/index.js';
import { assertSubscriptionEntitlement } from '../../sub/index.js';
import { postStockMovement } from './inv.service.js';

const ALLOWED_TRANSITIONS: Record<SerialStatus, ReadonlySet<SerialStatus>> = {
  IN_STOCK: new Set(['RESERVED', 'SOLD', 'QUARANTINED', 'DAMAGED', 'WRITTEN_OFF']),
  RESERVED: new Set(['IN_STOCK', 'SOLD']),
  SOLD: new Set(['RETURNED']),
  RETURNED: new Set(['IN_STOCK', 'QUARANTINED', 'DAMAGED', 'WRITTEN_OFF']),
  QUARANTINED: new Set(['IN_STOCK', 'DAMAGED', 'WRITTEN_OFF']),
  DAMAGED: new Set(['IN_STOCK', 'WRITTEN_OFF']),
  WRITTEN_OFF: new Set([]),
};

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

function mapSerialRow(
  row: Selectable<InventorySerialsTable>,
  baseCurrency: string,
): SerialResponse {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    productId: row.product_id,
    batchId: row.batch_id,
    warehouseId: row.warehouse_id,
    branchId: row.branch_id,
    serialNumber: row.serial_number,
    status: row.status as SerialStatus,
    unitCost: Money.fromDecimalString(
      String(row.unit_cost),
      row.currency_code || baseCurrency,
    ).toDecimalString(),
    currencyCode: (row.currency_code || baseCurrency) as CurrencyCode,
    receivedAt: new Date(row.received_at).toISOString(),
    soldAt: row.sold_at ? new Date(row.sold_at).toISOString() : null,
    lastMovementId: row.last_movement_id,
    lastSaleInvoiceId: row.last_sale_invoice_id,
    notes: row.notes,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export async function registerSerialStock(
  trx: TenantTransactionContext,
  idempotencyKey: string,
  input: RegisterSerialStockRequest,
): Promise<SerialResponse[]> {
  await assertAuthorized(trx, {
    permission: 'inv:serial:manage',
    branchId: input.branchId,
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

  if (product.tracking_mode !== 'SERIAL') {
    throw new AppError({
      statusCode: 422,
      errorCode: 'INV_PRODUCT_NOT_SERIAL_TRACKED',
      title: 'Product Is Not Serial Tracked',
      detail: `Product "${product.sku}" is configured with tracking_mode="${product.tracking_mode}". It must be SERIAL.`,
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

  if (input.batchId) {
    const batchRow = await trx.db
      .selectFrom('inventory_batches')
      .select(['id', 'status', 'warehouse_id'])
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', input.batchId)
      .where('product_id', '=', input.productId)
      .executeTakeFirst();

    if (!batchRow) {
      throw new AppError({
        statusCode: 404,
        errorCode: 'ERR_NOT_FOUND',
        title: 'Batch Not Found',
        detail: `Batch "${input.batchId}" not found for product "${product.sku}".`,
      });
    }
    if (batchRow.warehouse_id !== input.warehouseId) {
      throw new AppError({
        statusCode: 400,
        errorCode: 'ERR_VALIDATION_FAILED',
        title: 'Batch Warehouse Mismatch',
        detail: `Batch "${input.batchId}" belongs to warehouse "${batchRow.warehouse_id}", not "${input.warehouseId}".`,
      });
    }
  }

  // Validate serial numbers array
  const rawSerials = input.serialNumbers.map((s) => s.trim().toUpperCase());
  if (rawSerials.length === 0 || rawSerials.some((s) => !s)) {
    throw new AppError({
      statusCode: 400,
      errorCode: 'ERR_VALIDATION_FAILED',
      title: 'Invalid Serial Numbers',
      detail: 'Serial numbers array cannot be empty or contain blank entries.',
    });
  }

  const uniqueSerials = Array.from(new Set(rawSerials));
  if (uniqueSerials.length !== rawSerials.length) {
    throw new AppError({
      statusCode: 400,
      errorCode: 'ERR_VALIDATION_FAILED',
      title: 'Duplicate Serial Numbers in Request',
      detail: 'Request contains duplicate serial numbers in the array.',
    });
  }

  // Check uniqueness against existing database serials for this product in tenant
  const existingRows = await trx.db
    .selectFrom('inventory_serials')
    .select(['serial_number'])
    .where('tenant_id', '=', trx.tenantId)
    .where('product_id', '=', input.productId)
    .where('serial_number', 'in', uniqueSerials)
    .execute();

  if (existingRows.length > 0) {
    throw new AppError({
      statusCode: 409,
      errorCode: 'INV_SERIAL_DUPLICATE',
      title: 'Duplicate Serial Number Detected',
      detail: `Serial number "${existingRows[0]!.serial_number}" already exists for product "${product.sku}".`,
      extensions: {
        conflictingSerials: existingRows.map((r) => r.serial_number),
      },
    });
  }

  const baseCurrency = await getTenantBaseCurrency(trx);
  const unitCostMoney = Money.fromDecimalString(input.unitCost, baseCurrency);
  if (unitCostMoney.isNegative()) {
    throw new AppError({
      statusCode: 400,
      errorCode: 'ERR_VALIDATION_FAILED',
      title: 'Negative Unit Cost Forbidden',
      detail: 'Unit cost cannot be negative.',
    });
  }

  // Post the authoritative STOCK_IN movement for the batch of serials
  const intakeQty = Quantity.fromInteger(uniqueSerials.length);
  const movementKey = generateUuidV7();

  const movement = await postStockMovement(
    trx,
    movementKey,
    {
      branchId: input.branchId,
      warehouseId: input.warehouseId,
      productId: input.productId,
      batchId: input.batchId ?? null,
      movementType: 'STOCK_IN',
      quantity: intakeQty.toDecimalString(),
      uomCode: product.base_uom,
      unitCost: unitCostMoney.toDecimalString(),
      referenceType: 'SERIAL_REGISTRATION',
      referenceId: idempotencyKey,
      reason:
        input.notes?.trim() ||
        `Initial serial registration intake (${uniqueSerials.length} units)`,
      supplierId: input.supplierId ?? null,
    },
    { skipPermissionCheck: true },
  );

  const now = new Date();
  const createdSerials: SerialResponse[] = [];

  for (const sNum of uniqueSerials) {
    const serialId = generateUuidV7();
    await trx.db
      .insertInto('inventory_serials')
      .values({
        id: serialId,
        tenant_id: trx.tenantId,
        product_id: input.productId,
        batch_id: input.batchId ?? null,
        warehouse_id: input.warehouseId,
        branch_id: input.branchId,
        serial_number: sNum,
        status: 'IN_STOCK',
        unit_cost: unitCostMoney.toDecimalString(),
        currency_code: baseCurrency,
        received_at: now,
        sold_at: null,
        last_movement_id: movement.id,
        last_sale_invoice_id: null,
        notes: input.notes ?? null,
        created_at: now,
        updated_at: now,
      })
      .execute();

    await trx.db
      .insertInto('inventory_serial_transitions')
      .values({
        id: generateUuidV7(),
        tenant_id: trx.tenantId,
        serial_id: serialId,
        from_status: 'NONE',
        to_status: 'IN_STOCK',
        reference_type: 'INITIAL_REGISTRATION',
        reference_id: movement.id,
        actor_user_id: trx.userId,
        notes: input.notes ?? 'Initial Serial Registration',
        occurred_at: now,
      })
      .execute();

    createdSerials.push({
      id: serialId,
      tenantId: trx.tenantId,
      productId: input.productId,
      batchId: input.batchId ?? null,
      warehouseId: input.warehouseId,
      branchId: input.branchId,
      serialNumber: sNum,
      status: 'IN_STOCK',
      unitCost: unitCostMoney.toDecimalString(),
      currencyCode: baseCurrency as CurrencyCode,
      receivedAt: now.toISOString(),
      soldAt: null,
      lastMovementId: movement.id,
      lastSaleInvoiceId: null,
      notes: input.notes ?? null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
  }

  await appendAuditLog(trx, {
    action: 'INV_SERIALS_REGISTERED',
    resourceType: 'INVENTORY_SERIAL',
    resourceId: createdSerials[0]!.id,
    metadata: {
      productId: input.productId,
      warehouseId: input.warehouseId,
      branchId: input.branchId,
      count: uniqueSerials.length,
      sampleSerials: uniqueSerials.slice(0, 5),
      movementId: movement.id,
    },
  });

  return createdSerials;
}

export async function getSerialById(
  trx: TenantTransactionContext,
  serialId: string,
): Promise<SerialResponse> {
  const row = await trx.db
    .selectFrom('inventory_serials')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', serialId)
    .executeTakeFirst();

  if (!row) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'ERR_NOT_FOUND',
      title: 'Serial Number Not Found',
      detail: `Serial "${serialId}" was not found.`,
    });
  }

  await assertAuthorized(trx, {
    permission: 'inv:serial:read',
    warehouseId: row.warehouse_id,
    branchId: row.branch_id,
  });

  const baseCurrency = await getTenantBaseCurrency(trx);
  return mapSerialRow(row, baseCurrency);
}

export async function getSerialByNumber(
  trx: TenantTransactionContext,
  productId: string,
  serialNumber: string,
): Promise<SerialResponse> {
  const sNum = serialNumber.trim().toUpperCase();
  const row = await trx.db
    .selectFrom('inventory_serials')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('product_id', '=', productId)
    .where('serial_number', '=', sNum)
    .executeTakeFirst();

  if (!row) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'ERR_NOT_FOUND',
      title: 'Serial Number Not Found',
      detail: `Serial number "${sNum}" not found for product "${productId}".`,
    });
  }

  await assertAuthorized(trx, {
    permission: 'inv:serial:read',
    warehouseId: row.warehouse_id,
    branchId: row.branch_id,
  });

  const baseCurrency = await getTenantBaseCurrency(trx);
  return mapSerialRow(row, baseCurrency);
}

export async function listSerials(
  trx: TenantTransactionContext,
  query: ListSerialsQuery,
): Promise<CursorPaginatedResult<SerialResponse>> {
  await assertAuthorized(trx, {
    permission: 'inv:serial:read',
    ...(query.warehouseId ? { warehouseId: query.warehouseId } : {}),
    ...(query.branchId ? { branchId: query.branchId } : {}),
  });

  const limit = Math.min(Math.max(Number(query.limit ?? 50), 1), 100);
  const baseCurrency = await getTenantBaseCurrency(trx);

  let dbQuery = trx.db
    .selectFrom('inventory_serials')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId);

  if (query.productId) {
    dbQuery = dbQuery.where('product_id', '=', query.productId);
  }
  if (query.warehouseId) {
    dbQuery = dbQuery.where('warehouse_id', '=', query.warehouseId);
  }
  if (query.branchId) {
    dbQuery = dbQuery.where('branch_id', '=', query.branchId);
  }
  if (query.status) {
    dbQuery = dbQuery.where('status', '=', query.status);
  }
  if (query.serialNumber) {
    const s = `%${query.serialNumber.trim().toUpperCase()}%`;
    dbQuery = dbQuery.where('serial_number', 'like', s);
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

  return {
    data: items.map((r) => mapSerialRow(r, baseCurrency)),
    pageInfo: {
      hasNextPage,
      nextCursor,
    },
  };
}

export async function transitionSerialStatus(
  trx: TenantTransactionContext,
  serialId: string,
  input: TransitionSerialStatusRequest,
): Promise<SerialResponse> {
  const serial = await trx.db
    .selectFrom('inventory_serials')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', serialId)
    .forUpdate()
    .executeTakeFirst();

  if (!serial) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'ERR_NOT_FOUND',
      title: 'Serial Not Found',
      detail: `Serial "${serialId}" was not found.`,
    });
  }

  await assertAuthorized(trx, {
    permission: 'inv:serial:manage',
    warehouseId: serial.warehouse_id,
    branchId: serial.branch_id,
  });

  const currentStatus = serial.status as SerialStatus;
  const targetStatus = input.toStatus;

  if (currentStatus === targetStatus) {
    const baseCurrency = await getTenantBaseCurrency(trx);
    return mapSerialRow(serial, baseCurrency);
  }

  const allowedNext = ALLOWED_TRANSITIONS[currentStatus];
  if (!allowedNext || !allowedNext.has(targetStatus)) {
    throw new AppError({
      statusCode: 409,
      errorCode: 'INV_SERIAL_INVALID_TRANSITION',
      title: 'Invalid Serial Status Transition',
      detail: `Cannot transition serial "${serial.serial_number}" from "${currentStatus}" to "${targetStatus}".`,
      extensions: {
        currentStatus,
        targetStatus,
        allowedStatuses: allowedNext ? Array.from(allowedNext) : [],
      },
    });
  }

  const reason = input.reason.trim();
  if (reason.length < 3) {
    throw new AppError({
      statusCode: 400,
      errorCode: 'ERR_VALIDATION_FAILED',
      title: 'Transition Reason Required',
      detail: 'Status transition reason must be at least 3 characters.',
    });
  }

  const now = new Date();
  await trx.db
    .updateTable('inventory_serials')
    .set({
      status: targetStatus,
      sold_at: targetStatus === 'SOLD' ? now : serial.sold_at,
      updated_at: now,
    })
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', serialId)
    .execute();

  await trx.db
    .insertInto('inventory_serial_transitions')
    .values({
      id: generateUuidV7(),
      tenant_id: trx.tenantId,
      serial_id: serialId,
      from_status: currentStatus,
      to_status: targetStatus,
      reference_type: 'MANUAL_TRANSITION',
      reference_id: null,
      actor_user_id: trx.userId,
      notes: reason,
      occurred_at: now,
    })
    .execute();

  await appendAuditLog(trx, {
    action: 'INV_SERIAL_STATUS_TRANSITIONED',
    resourceType: 'INVENTORY_SERIAL',
    resourceId: serialId,
    metadata: {
      serialNumber: serial.serial_number,
      fromStatus: currentStatus,
      toStatus: targetStatus,
      reason,
    },
  });

  const updated = await trx.db
    .selectFrom('inventory_serials')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', serialId)
    .executeTakeFirstOrThrow();

  const baseCurrency = await getTenantBaseCurrency(trx);
  return mapSerialRow(updated, baseCurrency);
}

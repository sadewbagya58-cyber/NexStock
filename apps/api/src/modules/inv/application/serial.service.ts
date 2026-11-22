import { randomBytes } from 'node:crypto';
import type {
  CurrencyCode,
  ListSerialStockGroupsQuery,
  ListSerialsQuery,
  PrintSerialGroupBarcodesRequest,
  RegisterSerialStockRequest,
  SerialResponse,
  SerialStatus,
  SerialStockGroupResponse,
  TransitionSerialStatusRequest,
} from '@nexstock/contracts';
import { Money, Quantity } from '@nexstock/domain-core';
import { type Selectable, sql } from 'kysely';
import type { CursorPaginatedResult } from '../../cat/index.js';
import { assertAuthorized } from '../../iam/index.js';
import {
  AppError,
  type InventorySerialsTable,
  type SerialStockGroupsTable,
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
  groupMeta?: { groupCode: string | null; sellingPrice: string | null },
): SerialResponse {
  const currency = (row.currency_code || baseCurrency) as CurrencyCode;
  const effectiveSelling =
    row.selling_price !== null && row.selling_price !== undefined
      ? Money.fromDecimalString(String(row.selling_price), currency).toDecimalString()
      : groupMeta?.sellingPrice ?? null;

  return {
    id: row.id,
    tenantId: row.tenant_id,
    productId: row.product_id,
    batchId: row.batch_id,
    serialGroupId: row.serial_group_id ?? null,
    groupCode: groupMeta?.groupCode ?? null,
    warehouseId: row.warehouse_id,
    branchId: row.branch_id,
    serialNumber: row.serial_number,
    internalBarcode: row.internal_barcode ?? null,
    status: row.status as SerialStatus,
    unitCost: Money.fromDecimalString(
      String(row.unit_cost),
      currency,
    ).toDecimalString(),
    sellingPrice: effectiveSelling,
    currencyCode: currency,
    labelPrintCount: Number(row.label_print_count ?? 0),
    lastLabelPrintedAt: row.last_label_printed_at
      ? new Date(row.last_label_printed_at).toISOString()
      : null,
    receivedAt: new Date(row.received_at).toISOString(),
    soldAt: row.sold_at ? new Date(row.sold_at).toISOString() : null,
    lastMovementId: row.last_movement_id,
    lastSaleInvoiceId: row.last_sale_invoice_id,
    notes: row.notes,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function mapSerialStockGroupRow(
  row: Selectable<SerialStockGroupsTable>,
  baseCurrency: string,
  extra?: {
    productSku?: string;
    productName?: string;
    serials?: SerialResponse[];
  },
): SerialStockGroupResponse {
  const currency = (row.currency_code || baseCurrency) as CurrencyCode;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    branchId: row.branch_id,
    warehouseId: row.warehouse_id,
    productId: row.product_id,
    ...(extra?.productSku !== undefined ? { productSku: extra.productSku } : {}),
    ...(extra?.productName !== undefined ? { productName: extra.productName } : {}),
    supplierId: row.supplier_id,
    goodsReceiptId: row.goods_receipt_id,
    groupCode: row.group_code,
    purchaseCost: Money.fromDecimalString(
      String(row.purchase_cost),
      currency,
    ).toDecimalString(),
    sellingPrice: Money.fromDecimalString(
      String(row.selling_price),
      currency,
    ).toDecimalString(),
    currencyCode: currency,
    initialQuantity: Number(row.initial_quantity),
    remainingQuantity: Number(row.remaining_quantity),
    receivedAt: new Date(row.received_at).toISOString(),
    notes: row.notes,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    ...(extra?.serials !== undefined ? { serials: extra.serials } : {}),
  };
}

/**
 * Generates collision-free tenant-scoped `NB-S...` internal barcodes for serial units.
 */
async function allocateUniqueSerialInternalBarcodes(
  trx: TenantTransactionContext,
  count: number,
): Promise<string[]> {
  if (count <= 0) {
    return [];
  }

  const allocated: string[] = [];
  const sessionSeen = new Set<string>();

  while (allocated.length < count) {
    const needed = count - allocated.length;
    const batchSize = Math.max(needed * 2, 8);
    const candidates: string[] = [];

    for (let i = 0; i < batchSize; i++) {
      const candidate = `NB-S${randomBytes(6).toString('hex').toUpperCase()}`;
      if (!sessionSeen.has(candidate)) {
        candidates.push(candidate);
      }
    }

    if (candidates.length === 0) {
      continue;
    }

    const [serialConflicts, productBarcodeConflicts, primaryConflicts, batchConflicts] =
      await Promise.all([
        trx.db
          .selectFrom('inventory_serials')
          .select(['internal_barcode'])
          .where('tenant_id', '=', trx.tenantId)
          .where('internal_barcode', 'in', candidates)
          .execute(),
        trx.db
          .selectFrom('product_barcodes')
          .select(['barcode'])
          .where('tenant_id', '=', trx.tenantId)
          .where('barcode', 'in', candidates)
          .execute(),
        trx.db
          .selectFrom('products')
          .select(['primary_barcode'])
          .where('tenant_id', '=', trx.tenantId)
          .where('primary_barcode', 'in', candidates)
          .execute(),
        trx.db
          .selectFrom('inventory_batches')
          .select(['internal_barcode'])
          .where('tenant_id', '=', trx.tenantId)
          .where('internal_barcode', 'in', candidates)
          .execute(),
      ]);

    const taken = new Set<string>();
    for (const r of serialConflicts) {
      if (r.internal_barcode) taken.add(r.internal_barcode);
    }
    for (const r of productBarcodeConflicts) {
      taken.add(r.barcode);
    }
    for (const r of primaryConflicts) {
      if (r.primary_barcode) taken.add(r.primary_barcode);
    }
    for (const r of batchConflicts) {
      if (r.internal_barcode) taken.add(r.internal_barcode);
    }

    for (const candidate of candidates) {
      if (!taken.has(candidate) && !sessionSeen.has(candidate)) {
        sessionSeen.add(candidate);
        allocated.push(candidate);
        if (allocated.length === count) {
          break;
        }
      }
    }
  }

  return allocated;
}

async function loadGroupMetaById(
  trx: TenantTransactionContext,
  groupIds: readonly string[],
  baseCurrency: string,
): Promise<Map<string, { groupCode: string; sellingPrice: string }>> {
  const map = new Map<string, { groupCode: string; sellingPrice: string }>();
  if (groupIds.length === 0) {
    return map;
  }
  const rows = await trx.db
    .selectFrom('serial_stock_groups')
    .select(['id', 'group_code', 'selling_price', 'currency_code'])
    .where('tenant_id', '=', trx.tenantId)
    .where('id', 'in', [...groupIds])
    .execute();

  for (const r of rows) {
    const currency = r.currency_code || baseCurrency;
    map.set(r.id, {
      groupCode: r.group_code,
      sellingPrice: Money.fromDecimalString(
        String(r.selling_price),
        currency,
      ).toDecimalString(),
    });
  }
  return map;
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
      'selling_price',
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

  const effectiveSellingRaw =
    input.sellingPrice !== undefined
      ? input.sellingPrice
      : String(product.selling_price ?? '0');
  const sellingPriceMoney = Money.fromDecimalString(
    effectiveSellingRaw,
    baseCurrency,
  );
  if (sellingPriceMoney.isNegative()) {
    throw new AppError({
      statusCode: 400,
      errorCode: 'ERR_VALIDATION_FAILED',
      title: 'Negative Selling Price Forbidden',
      detail: 'Selling price cannot be negative.',
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
  const serialGroupId = generateUuidV7();
  const requestedGroupCode = input.groupCode?.trim().toUpperCase();
  const groupCode =
    requestedGroupCode && requestedGroupCode.length > 0
      ? requestedGroupCode
      : `SG-${now.toISOString().slice(0, 10).replace(/-/g, '')}-${serialGroupId.replace(/-/g, '').slice(-6).toUpperCase()}`;

  const existingGroupCode = await trx.db
    .selectFrom('serial_stock_groups')
    .select(['id'])
    .where('tenant_id', '=', trx.tenantId)
    .where('group_code', '=', groupCode)
    .executeTakeFirst();
  if (existingGroupCode) {
    throw new AppError({
      statusCode: 409,
      errorCode: 'INV_SERIAL_GROUP_DUPLICATE',
      title: 'Duplicate Serial Stock Group Code',
      detail: `Serial stock group code "${groupCode}" already exists.`,
    });
  }

  await trx.db
    .insertInto('serial_stock_groups')
    .values({
      id: serialGroupId,
      tenant_id: trx.tenantId,
      branch_id: input.branchId,
      warehouse_id: input.warehouseId,
      product_id: input.productId,
      supplier_id: input.supplierId ?? null,
      goods_receipt_id: null,
      group_code: groupCode,
      purchase_cost: unitCostMoney.toDecimalString(),
      selling_price: sellingPriceMoney.toDecimalString(),
      currency_code: baseCurrency,
      initial_quantity: uniqueSerials.length,
      remaining_quantity: uniqueSerials.length,
      received_at: now,
      notes: input.notes?.trim() || null,
      created_by_user_id: trx.userId,
      created_at: now,
      updated_at: now,
    })
    .execute();

  const shouldGenerateBarcodes = input.generateBarcodes !== false;
  const generatedBarcodes = shouldGenerateBarcodes
    ? await allocateUniqueSerialInternalBarcodes(trx, uniqueSerials.length)
    : [];

  const createdSerials: SerialResponse[] = [];

  for (let idx = 0; idx < uniqueSerials.length; idx++) {
    const sNum = uniqueSerials[idx]!;
    const internalBarcode = generatedBarcodes[idx] ?? null;
    const serialId = generateUuidV7();
    await trx.db
      .insertInto('inventory_serials')
      .values({
        id: serialId,
        tenant_id: trx.tenantId,
        product_id: input.productId,
        batch_id: input.batchId ?? null,
        serial_group_id: serialGroupId,
        warehouse_id: input.warehouseId,
        branch_id: input.branchId,
        serial_number: sNum,
        internal_barcode: internalBarcode,
        status: 'IN_STOCK',
        unit_cost: unitCostMoney.toDecimalString(),
        selling_price: sellingPriceMoney.toDecimalString(),
        currency_code: baseCurrency,
        label_print_count: 0,
        last_label_printed_at: null,
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
      serialGroupId,
      groupCode,
      warehouseId: input.warehouseId,
      branchId: input.branchId,
      serialNumber: sNum,
      internalBarcode,
      status: 'IN_STOCK',
      unitCost: unitCostMoney.toDecimalString(),
      sellingPrice: sellingPriceMoney.toDecimalString(),
      currencyCode: baseCurrency as CurrencyCode,
      labelPrintCount: 0,
      lastLabelPrintedAt: null,
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
      serialGroupId,
      groupCode,
      productId: input.productId,
      warehouseId: input.warehouseId,
      branchId: input.branchId,
      count: uniqueSerials.length,
      purchaseCost: unitCostMoney.toDecimalString(),
      sellingPrice: sellingPriceMoney.toDecimalString(),
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
  const groupMetaMap = row.serial_group_id
    ? await loadGroupMetaById(trx, [row.serial_group_id], baseCurrency)
    : undefined;
  return mapSerialRow(
    row,
    baseCurrency,
    row.serial_group_id ? groupMetaMap?.get(row.serial_group_id) : undefined,
  );
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
  const groupMetaMap = row.serial_group_id
    ? await loadGroupMetaById(trx, [row.serial_group_id], baseCurrency)
    : undefined;
  return mapSerialRow(
    row,
    baseCurrency,
    row.serial_group_id ? groupMetaMap?.get(row.serial_group_id) : undefined,
  );
}

export async function listSerials(
  trx: TenantTransactionContext,
  query: ListSerialsQuery,
): Promise<CursorPaginatedResult<SerialResponse>> {
  const authCtx = await assertAuthorized(trx, {
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

  if (!authCtx.allLocationsAccess) {
    const allowedWh = [...authCtx.allowedWarehouseIds];
    const allowedBr = [...authCtx.allowedBranchIds];
    if (allowedWh.length === 0 && allowedBr.length === 0) {
      return {
        data: [],
        pageInfo: { hasNextPage: false, nextCursor: null },
      };
    }
    dbQuery = dbQuery.where((eb) =>
      eb.or([
        ...(allowedWh.length > 0 ? [eb('warehouse_id', 'in', allowedWh)] : []),
        ...(allowedBr.length > 0 ? [eb('branch_id', 'in', allowedBr)] : []),
      ]),
    );
  }

  if (query.productId) {
    dbQuery = dbQuery.where('product_id', '=', query.productId);
  }
  if (query.serialGroupId) {
    dbQuery = dbQuery.where('serial_group_id', '=', query.serialGroupId);
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

  const groupIds = Array.from(
    new Set(
      items
        .map((r) => r.serial_group_id)
        .filter((id): id is string => Boolean(id)),
    ),
  );
  const groupMetaMap = await loadGroupMetaById(trx, groupIds, baseCurrency);

  return {
    data: items.map((r) =>
      mapSerialRow(
        r,
        baseCurrency,
        r.serial_group_id ? groupMetaMap.get(r.serial_group_id) : undefined,
      ),
    ),
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

  if (serial.serial_group_id) {
    if (currentStatus === 'IN_STOCK' && targetStatus !== 'IN_STOCK') {
      await trx.db
        .updateTable('serial_stock_groups')
        .set({
          remaining_quantity: sql`GREATEST(remaining_quantity - 1, 0)`,
          updated_at: now,
        })
        .where('tenant_id', '=', trx.tenantId)
        .where('id', '=', serial.serial_group_id)
        .execute();
    } else if (currentStatus !== 'IN_STOCK' && targetStatus === 'IN_STOCK') {
      await trx.db
        .updateTable('serial_stock_groups')
        .set({
          remaining_quantity: sql`LEAST(remaining_quantity + 1, initial_quantity)`,
          updated_at: now,
        })
        .where('tenant_id', '=', trx.tenantId)
        .where('id', '=', serial.serial_group_id)
        .execute();
    }
  }

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
  const groupMetaMap = updated.serial_group_id
    ? await loadGroupMetaById(trx, [updated.serial_group_id], baseCurrency)
    : undefined;
  return mapSerialRow(
    updated,
    baseCurrency,
    updated.serial_group_id ? groupMetaMap?.get(updated.serial_group_id) : undefined,
  );
}

export async function listSerialStockGroups(
  trx: TenantTransactionContext,
  query: ListSerialStockGroupsQuery,
): Promise<CursorPaginatedResult<SerialStockGroupResponse>> {
  const authCtx = await assertAuthorized(trx, {
    permission: 'inv:serial:read',
    ...(query.warehouseId ? { warehouseId: query.warehouseId } : {}),
    ...(query.branchId ? { branchId: query.branchId } : {}),
  });

  const limit = Math.min(Math.max(Number(query.limit ?? 50), 1), 100);
  const baseCurrency = await getTenantBaseCurrency(trx);

  let dbQuery = trx.db
    .selectFrom('serial_stock_groups')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId);

  if (!authCtx.allLocationsAccess) {
    const allowedWh = [...authCtx.allowedWarehouseIds];
    const allowedBr = [...authCtx.allowedBranchIds];
    if (allowedWh.length === 0 && allowedBr.length === 0) {
      return {
        data: [],
        pageInfo: { hasNextPage: false, nextCursor: null },
      };
    }
    dbQuery = dbQuery.where((eb) =>
      eb.or([
        ...(allowedWh.length > 0 ? [eb('warehouse_id', 'in', allowedWh)] : []),
        ...(allowedBr.length > 0 ? [eb('branch_id', 'in', allowedBr)] : []),
      ]),
    );
  }

  if (query.productId) {
    dbQuery = dbQuery.where('product_id', '=', query.productId);
  }
  if (query.warehouseId) {
    dbQuery = dbQuery.where('warehouse_id', '=', query.warehouseId);
  }
  if (query.branchId) {
    dbQuery = dbQuery.where('branch_id', '=', query.branchId);
  }
  if (query.inStockOnly === 'true') {
    dbQuery = dbQuery.where('remaining_quantity', '>', 0);
  }
  if (query.cursor) {
    dbQuery = dbQuery.where('id', '<', query.cursor);
  }

  const rows = await dbQuery
    .orderBy('received_at', 'desc')
    .orderBy('id', 'desc')
    .limit(limit + 1)
    .execute();

  const hasNextPage = rows.length > limit;
  const items = hasNextPage ? rows.slice(0, limit) : rows;
  const nextCursor =
    hasNextPage && items.length > 0 ? items[items.length - 1]!.id : null;

  if (items.length === 0) {
    return {
      data: [],
      pageInfo: { hasNextPage: false, nextCursor: null },
    };
  }

  const productIds = Array.from(new Set(items.map((r) => r.product_id)));
  const productRows = await trx.db
    .selectFrom('products')
    .select(['id', 'sku', 'name'])
    .where('tenant_id', '=', trx.tenantId)
    .where('id', 'in', productIds)
    .execute();
  const productMap = new Map(productRows.map((p) => [p.id, p]));

  const serialsByGroup = new Map<string, SerialResponse[]>();
  if (query.includeSerials !== 'false') {
    const groupIds = items.map((r) => r.id);
    const serialRows = await trx.db
      .selectFrom('inventory_serials')
      .selectAll()
      .where('tenant_id', '=', trx.tenantId)
      .where('serial_group_id', 'in', groupIds)
      .orderBy('serial_number', 'asc')
      .execute();

    const groupMeta = new Map(
      items.map((g) => [
        g.id,
        {
          groupCode: g.group_code,
          sellingPrice: Money.fromDecimalString(
            String(g.selling_price),
            g.currency_code || baseCurrency,
          ).toDecimalString(),
        },
      ]),
    );

    for (const s of serialRows) {
      if (!s.serial_group_id) continue;
      const list = serialsByGroup.get(s.serial_group_id) ?? [];
      list.push(mapSerialRow(s, baseCurrency, groupMeta.get(s.serial_group_id)));
      serialsByGroup.set(s.serial_group_id, list);
    }
  }

  return {
    data: items.map((r) => {
      const prod = productMap.get(r.product_id);
      return mapSerialStockGroupRow(r, baseCurrency, {
        ...(prod ? { productSku: prod.sku, productName: prod.name } : {}),
        ...(query.includeSerials !== 'false'
          ? { serials: serialsByGroup.get(r.id) ?? [] }
          : {}),
      });
    }),
    pageInfo: {
      hasNextPage,
      nextCursor,
    },
  };
}

export async function getSerialStockGroupById(
  trx: TenantTransactionContext,
  groupId: string,
): Promise<SerialStockGroupResponse> {
  const row = await trx.db
    .selectFrom('serial_stock_groups')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', groupId)
    .executeTakeFirst();

  if (!row) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'ERR_NOT_FOUND',
      title: 'Serial Stock Group Not Found',
      detail: `Serial stock group "${groupId}" was not found.`,
    });
  }

  await assertAuthorized(trx, {
    permission: 'inv:serial:read',
    branchId: row.branch_id,
    warehouseId: row.warehouse_id,
  });

  const baseCurrency = await getTenantBaseCurrency(trx);
  const [prod, serialRows] = await Promise.all([
    trx.db
      .selectFrom('products')
      .select(['id', 'sku', 'name'])
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', row.product_id)
      .executeTakeFirst(),
    trx.db
      .selectFrom('inventory_serials')
      .selectAll()
      .where('tenant_id', '=', trx.tenantId)
      .where('serial_group_id', '=', row.id)
      .orderBy('serial_number', 'asc')
      .execute(),
  ]);

  const groupMeta = {
    groupCode: row.group_code,
    sellingPrice: Money.fromDecimalString(
      String(row.selling_price),
      row.currency_code || baseCurrency,
    ).toDecimalString(),
  };

  return mapSerialStockGroupRow(row, baseCurrency, {
    ...(prod ? { productSku: prod.sku, productName: prod.name } : {}),
    serials: serialRows.map((s) => mapSerialRow(s, baseCurrency, groupMeta)),
  });
}

export async function generateSerialBarcodesForGroup(
  trx: TenantTransactionContext,
  groupId: string,
): Promise<SerialStockGroupResponse> {
  const group = await trx.db
    .selectFrom('serial_stock_groups')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', groupId)
    .forUpdate()
    .executeTakeFirst();

  if (!group) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'ERR_NOT_FOUND',
      title: 'Serial Stock Group Not Found',
      detail: `Serial stock group "${groupId}" was not found.`,
    });
  }

  await assertAuthorized(trx, {
    permission: 'inv:serial:manage',
    branchId: group.branch_id,
    warehouseId: group.warehouse_id,
  });

  await assertSubscriptionEntitlement(trx, { requireWriteAccess: true });

  const generatedCount = await generateSerialBarcodesForGroupIfMissing(
    trx,
    group.id,
  );
  if (generatedCount > 0) {
    await appendAuditLog(trx, {
      action: 'INV_SERIAL_BARCODES_GENERATED',
      resourceType: 'SERIAL_STOCK_GROUP',
      resourceId: group.id,
      metadata: {
        groupCode: group.group_code,
        generatedCount,
      },
    });
  }

  return getSerialStockGroupById(trx, group.id);
}

export async function generateBarcodeForSerial(
  trx: TenantTransactionContext,
  serialId: string,
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
    branchId: serial.branch_id,
    warehouseId: serial.warehouse_id,
  });

  await assertSubscriptionEntitlement(trx, { requireWriteAccess: true });

  let effectiveRow = serial;
  if (!serial.internal_barcode) {
    const [newCode] = await allocateUniqueSerialInternalBarcodes(trx, 1);
    const now = new Date();
    await trx.db
      .updateTable('inventory_serials')
      .set({
        internal_barcode: newCode!,
        updated_at: now,
      })
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', serial.id)
      .execute();

    effectiveRow = await trx.db
      .selectFrom('inventory_serials')
      .selectAll()
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', serial.id)
      .executeTakeFirstOrThrow();

    await appendAuditLog(trx, {
      action: 'INV_SERIAL_BARCODE_GENERATED',
      resourceType: 'INVENTORY_SERIAL',
      resourceId: serial.id,
      metadata: {
        serialNumber: serial.serial_number,
        internalBarcode: newCode!,
      },
    });
  }

  const baseCurrency = await getTenantBaseCurrency(trx);
  const groupMetaMap = effectiveRow.serial_group_id
    ? await loadGroupMetaById(trx, [effectiveRow.serial_group_id], baseCurrency)
    : undefined;
  return mapSerialRow(
    effectiveRow,
    baseCurrency,
    effectiveRow.serial_group_id
      ? groupMetaMap?.get(effectiveRow.serial_group_id)
      : undefined,
  );
}

export async function recordSerialGroupPrintLog(
  trx: TenantTransactionContext,
  groupId: string,
  input: PrintSerialGroupBarcodesRequest,
): Promise<SerialStockGroupResponse> {
  const group = await trx.db
    .selectFrom('serial_stock_groups')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', groupId)
    .executeTakeFirst();

  if (!group) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'ERR_NOT_FOUND',
      title: 'Serial Stock Group Not Found',
      detail: `Serial stock group "${groupId}" was not found.`,
    });
  }

  await assertAuthorized(trx, {
    permission: 'inv:serial:read',
    branchId: group.branch_id,
    warehouseId: group.warehouse_id,
  });

  // Ensure every serial in group has an immutable internal barcode first
  await generateSerialBarcodesForGroupIfMissing(trx, group.id);

  let targetQuery = trx.db
    .selectFrom('inventory_serials')
    .select(['id', 'serial_number', 'internal_barcode', 'label_print_count'])
    .where('tenant_id', '=', trx.tenantId)
    .where('serial_group_id', '=', group.id);

  if (input.serialIds && input.serialIds.length > 0) {
    targetQuery = targetQuery.where('id', 'in', input.serialIds);
  }

  const targets = await targetQuery.execute();
  if (targets.length === 0) {
    throw new AppError({
      statusCode: 400,
      errorCode: 'ERR_VALIDATION_FAILED',
      title: 'No Matching Serials Selected',
      detail: 'Select at least one serial in this stock group to print labels.',
    });
  }

  const now = new Date();
  for (const t of targets) {
    const printCount = Number(t.label_print_count ?? 0);
    await trx.db
      .insertInto('serial_barcode_print_logs')
      .values({
        id: generateUuidV7(),
        tenant_id: trx.tenantId,
        branch_id: group.branch_id,
        product_id: group.product_id,
        serial_group_id: group.id,
        serial_id: t.id,
        internal_barcode: t.internal_barcode!,
        label_format: input.format,
        is_reprint: printCount > 0,
        printed_by_user_id: trx.userId,
        printed_at: now,
      })
      .execute();

    await trx.db
      .updateTable('inventory_serials')
      .set({
        label_print_count: printCount + 1,
        last_label_printed_at: now,
        updated_at: now,
      })
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', t.id)
      .execute();
  }

  await appendAuditLog(trx, {
    action: 'INV_SERIAL_LABELS_PRINTED',
    resourceType: 'SERIAL_STOCK_GROUP',
    resourceId: group.id,
    metadata: {
      groupCode: group.group_code,
      format: input.format,
      printedCount: targets.length,
    },
  });

  return getSerialStockGroupById(trx, group.id);
}

async function generateSerialBarcodesForGroupIfMissing(
  trx: TenantTransactionContext,
  groupId: string,
): Promise<number> {
  const missingRows = await trx.db
    .selectFrom('inventory_serials')
    .select(['id'])
    .where('tenant_id', '=', trx.tenantId)
    .where('serial_group_id', '=', groupId)
    .where('internal_barcode', 'is', null)
    .orderBy('serial_number', 'asc')
    .execute();

  if (missingRows.length === 0) {
    return 0;
  }

  const newCodes = await allocateUniqueSerialInternalBarcodes(trx, missingRows.length);
  const now = new Date();
  for (let i = 0; i < missingRows.length; i++) {
    await trx.db
      .updateTable('inventory_serials')
      .set({
        internal_barcode: newCodes[i]!,
        updated_at: now,
      })
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', missingRows[i]!.id)
      .execute();
  }
  return missingRows.length;
}

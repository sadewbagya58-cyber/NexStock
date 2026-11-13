import type {
  CreateStockTransferRequest,
  ListStockTransfersQuery,
  ReceiveStockTransferRequest,
  StockTransferLineResponse,
  StockTransferListResponse,
  StockTransferResponse,
  StockTransferStatus,
} from '@nexstock/contracts';
import { Money, Quantity } from '@nexstock/domain-core';
import type { Selectable } from 'kysely';
import { assertAuthorized } from '../../iam/index.js';
import {
  AppError,
  type StockTransferLinesTable,
  type StockTransfersTable,
  type TenantTransactionContext,
  appendAuditLog,
  generateUuidV7,
} from '../../shared/index.js';
import { assertSubscriptionEntitlement } from '../../sub/index.js';
import {
  generateUniqueInternalBatchBarcodeValue,
  selectFefoBatches,
} from './batch.service.js';
import { postStockMovement } from './inv.service.js';

async function getTenantBaseCurrency(trx: TenantTransactionContext): Promise<string> {
  const tenant = await trx.db
    .selectFrom('tenants')
    .select(['base_currency'])
    .where('id', '=', trx.tenantId)
    .executeTakeFirst();
  return tenant?.base_currency?.trim() ?? 'USD';
}

function mapTransferLineRow(
  row: Selectable<StockTransferLinesTable>,
  baseCurrency: string,
): StockTransferLineResponse {
  return {
    id: row.id,
    lineNumber: row.line_number,
    productId: row.product_id,
    sourceBatchId: row.source_batch_id,
    destinationBatchId: row.destination_batch_id,
    quantityRequested: Quantity.fromDecimalString(
      String(row.requested_qty),
    ).toDecimalString(),
    quantityDispatched: Quantity.fromDecimalString(
      String(row.dispatched_qty ?? '0.000000'),
    ).toDecimalString(),
    quantityReceived: Quantity.fromDecimalString(
      String(row.received_qty ?? '0.000000'),
    ).toDecimalString(),
    unitCostSnapshot: Money.fromDecimalString(
      String(row.transfer_unit_cost),
      baseCurrency,
    ).toDecimalString(),
    sellingPriceSnapshot:
      row.transfer_selling_price != null
        ? Money.fromDecimalString(
            String(row.transfer_selling_price),
            baseCurrency,
          ).toDecimalString()
        : null,
    expiryDateSnapshot: row.expiry_date
      ? new Date(row.expiry_date).toISOString().slice(0, 10)
      : null,
    batchNumberSnapshot: row.batch_number_snapshot,
    notes: null,
  };
}

function mapTransferRow(
  row: Selectable<StockTransfersTable>,
  lines: readonly Selectable<StockTransferLinesTable>[],
  baseCurrency: string,
): StockTransferResponse {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    transferNumber: row.transfer_number,
    sourceBranchId: row.source_branch_id,
    sourceWarehouseId: row.source_warehouse_id,
    destinationBranchId: row.destination_branch_id,
    destinationWarehouseId: row.destination_warehouse_id,
    status: row.status as StockTransferStatus,
    notes: row.notes,
    dispatchedBy: row.dispatched_by_user_id,
    dispatchedAt: row.dispatched_at
      ? new Date(row.dispatched_at).toISOString()
      : null,
    receivedBy: row.received_by_user_id,
    receivedAt: row.received_at
      ? new Date(row.received_at).toISOString()
      : null,
    createdBy: row.created_by_user_id,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    lines: lines.map((l) => mapTransferLineRow(l, baseCurrency)),
  };
}

async function assertWarehouseBelongsToBranch(
  trx: TenantTransactionContext,
  warehouseId: string,
  branchId: string,
  label: string,
): Promise<void> {
  const warehouse = await trx.db
    .selectFrom('warehouses')
    .select(['id', 'branch_id', 'is_active'])
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', warehouseId)
    .executeTakeFirst();

  if (!warehouse || !warehouse.is_active) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'ERR_NOT_FOUND',
      title: `${label} Warehouse Not Found`,
      detail: `Active ${label.toLowerCase()} warehouse "${warehouseId}" not found.`,
    });
  }

  let linked = warehouse.branch_id === branchId;
  if (!linked) {
    const link = await trx.db
      .selectFrom('branch_warehouse_links')
      .select(['id'])
      .where('tenant_id', '=', trx.tenantId)
      .where('branch_id', '=', branchId)
      .where('warehouse_id', '=', warehouseId)
      .executeTakeFirst();
    linked = Boolean(link);
  }

  if (!linked) {
    throw new AppError({
      statusCode: 422,
      errorCode: 'INV_BRANCH_WAREHOUSE_MISMATCH',
      title: 'Branch Warehouse Mismatch',
      detail: `${label} warehouse "${warehouseId}" does not belong to branch "${branchId}".`,
    });
  }
}

export async function createStockTransfer(
  trx: TenantTransactionContext,
  input: CreateStockTransferRequest,
  idempotencyKey?: string,
): Promise<StockTransferResponse> {
  await assertAuthorized(trx, {
    permission: 'inv:movement:post',
    branchId: input.sourceBranchId,
    warehouseId: input.sourceWarehouseId,
  });

  await assertSubscriptionEntitlement(trx, { requireWriteAccess: true });

  if (input.sourceWarehouseId === input.destinationWarehouseId) {
    throw new AppError({
      statusCode: 422,
      errorCode: 'INV_TRANSFER_BRANCH_CONFLICT',
      title: 'Identical Source and Destination Warehouse',
      detail: 'Source warehouse and destination warehouse cannot be the same.',
    });
  }

  await Promise.all([
    assertWarehouseBelongsToBranch(
      trx,
      input.sourceWarehouseId,
      input.sourceBranchId,
      'Source',
    ),
    assertWarehouseBelongsToBranch(
      trx,
      input.destinationWarehouseId,
      input.destinationBranchId,
      'Destination',
    ),
  ]);

  const baseCurrency = await getTenantBaseCurrency(trx);
  const transferId = generateUuidV7();
  const now = new Date();
  const dateStamp = now.toISOString().slice(0, 10).replace(/-/g, '');
  const transferNumber = `TRF-${dateStamp}-${transferId.replace(/-/g, '').slice(-6).toUpperCase()}`;

  await trx.db
    .insertInto('stock_transfers')
    .values({
      id: transferId,
      tenant_id: trx.tenantId,
      transfer_number: transferNumber,
      source_branch_id: input.sourceBranchId,
      source_warehouse_id: input.sourceWarehouseId,
      destination_branch_id: input.destinationBranchId,
      destination_warehouse_id: input.destinationWarehouseId,
      status: 'DRAFT',
      notes: input.notes ?? null,
      created_by_user_id: trx.userId,
      dispatched_by_user_id: null,
      received_by_user_id: null,
      dispatched_at: null,
      received_at: null,
      idempotency_key: idempotencyKey ?? null,
      created_at: now,
      updated_at: now,
    })
    .execute();

  let lineNum = 1;
  const todayStr = now.toISOString().slice(0, 10);

  for (const reqLine of input.lines) {
    const reqQty = Quantity.fromDecimalString(reqLine.quantity);
    if (!reqQty.isPositive()) {
      throw new AppError({
        statusCode: 400,
        errorCode: 'ERR_VALIDATION_FAILED',
        title: 'Invalid Transfer Quantity',
        detail: 'Transfer line quantity must be greater than zero.',
      });
    }

    const product = await trx.db
      .selectFrom('products')
      .select([
        'id',
        'sku',
        'name',
        'base_uom',
        'tracking_mode',
        'purchase_cost',
        'selling_price',
        'status',
      ])
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', reqLine.productId)
      .executeTakeFirst();

    if (!product || product.status !== 'ACTIVE') {
      throw new AppError({
        statusCode: 404,
        errorCode: 'ERR_NOT_FOUND',
        title: 'Active Product Not Found',
        detail: `Active product "${reqLine.productId}" not found.`,
      });
    }

    const isBatchTracked =
      product.tracking_mode === 'BATCH' || product.tracking_mode === 'BATCH_EXPIRY';

    if (reqLine.sourceBatchId) {
      const batch = await trx.db
        .selectFrom('inventory_batches')
        .selectAll()
        .where('tenant_id', '=', trx.tenantId)
        .where('warehouse_id', '=', input.sourceWarehouseId)
        .where('product_id', '=', reqLine.productId)
        .where('id', '=', reqLine.sourceBatchId)
        .executeTakeFirst();

      if (!batch) {
        throw new AppError({
          statusCode: 404,
          errorCode: 'INV_BATCH_NOT_FOUND',
          title: 'Source Batch Not Found',
          detail: `Batch "${reqLine.sourceBatchId}" not found in source warehouse.`,
        });
      }

      if (batch.status !== 'ACTIVE') {
        throw new AppError({
          statusCode: 409,
          errorCode:
            batch.status === 'EXPIRED'
              ? 'POS_BATCH_EXPIRED'
              : 'POS_BATCH_NOT_AVAILABLE',
          title: 'Source Batch Not Transferable',
          detail: `Batch "${batch.batch_number}" has status "${batch.status}" and cannot be transferred.`,
        });
      }

      const expStr = batch.expiry_date
        ? new Date(batch.expiry_date).toISOString().slice(0, 10)
        : null;
      if (expStr && expStr < todayStr) {
        throw new AppError({
          statusCode: 409,
          errorCode: 'POS_BATCH_EXPIRED',
          title: 'Expired Batch Cannot Be Transferred',
          detail: `Batch "${batch.batch_number}" expired on ${expStr}.`,
        });
      }

      const available = Quantity.fromDecimalString(
        String(batch.current_quantity),
      ).subtract(Quantity.fromDecimalString(String(batch.reserved_quantity ?? '0')));
      if (available.compare(reqQty) < 0) {
        throw new AppError({
          statusCode: 409,
          errorCode: 'INV_INSUFFICIENT_BATCH_STOCK',
          title: 'Insufficient Source Batch Stock',
          detail: `Batch "${batch.batch_number}" has ${available.toDecimalString()} available, requested ${reqQty.toDecimalString()}.`,
        });
      }

      await trx.db
        .insertInto('stock_transfer_lines')
        .values({
          id: generateUuidV7(),
          tenant_id: trx.tenantId,
          transfer_id: transferId,
          line_number: lineNum++,
          product_id: reqLine.productId,
          source_batch_id: batch.id,
          destination_batch_id: null,
          serial_id: null,
          uom_code: product.base_uom,
          requested_qty: reqQty.toDecimalString(),
          dispatched_qty: null,
          received_qty: null,
          transfer_unit_cost: Money.fromDecimalString(
            String(batch.unit_cost),
            baseCurrency,
          ).toDecimalString(),
          transfer_selling_price:
            batch.selling_price != null
              ? Money.fromDecimalString(
                  String(batch.selling_price),
                  baseCurrency,
                ).toDecimalString()
              : null,
          expiry_date: expStr,
          batch_number_snapshot: batch.batch_number,
          dispatch_ledger_entry_id: null,
          receive_ledger_entry_id: null,
          created_at: now,
        })
        .execute();
    } else if (isBatchTracked) {
      const allocation = await selectFefoBatches(trx, {
        warehouseId: input.sourceWarehouseId,
        productId: reqLine.productId,
        requiredQuantity: reqQty.toDecimalString(),
        skipPermissionCheck: true,
      });

      if (!allocation.isFullyFulfilled || allocation.allocations.length === 0) {
        throw new AppError({
          statusCode: 409,
          errorCode: 'INV_INSUFFICIENT_BATCH_STOCK',
          title: 'Insufficient Eligible Batch Stock',
          detail: `Product "${product.sku}" only has ${allocation.fulfilledQty} eligible batch stock in source warehouse; requested ${reqQty.toDecimalString()}.`,
        });
      }

      for (const slice of allocation.allocations) {
        await trx.db
          .insertInto('stock_transfer_lines')
          .values({
            id: generateUuidV7(),
            tenant_id: trx.tenantId,
            transfer_id: transferId,
            line_number: lineNum++,
            product_id: reqLine.productId,
            source_batch_id: slice.batchId,
            destination_batch_id: null,
            serial_id: null,
            uom_code: product.base_uom,
            requested_qty: slice.allocatedQty,
            dispatched_qty: null,
            received_qty: null,
            transfer_unit_cost: slice.unitCost,
            transfer_selling_price: slice.sellingPrice ?? null,
            expiry_date: slice.expiryDate,
            batch_number_snapshot: slice.batchNumber,
            dispatch_ledger_entry_id: null,
            receive_ledger_entry_id: null,
            created_at: now,
          })
          .execute();
      }
    } else {
      const srcBal = await trx.db
        .selectFrom('inventory_balances')
        .select(['qty_on_hand', 'moving_avg_cost'])
        .where('tenant_id', '=', trx.tenantId)
        .where('warehouse_id', '=', input.sourceWarehouseId)
        .where('product_id', '=', reqLine.productId)
        .executeTakeFirst();

      const onHand = Quantity.fromDecimalString(String(srcBal?.qty_on_hand ?? '0'));
      if (onHand.compare(reqQty) < 0) {
        throw new AppError({
          statusCode: 409,
          errorCode: 'INV_INSUFFICIENT_AVAILABLE_STOCK',
          title: 'Insufficient Stock',
          detail: `Product "${product.sku}" has ${onHand.toDecimalString()} in source warehouse; requested ${reqQty.toDecimalString()}.`,
        });
      }

      const unitCost = Money.fromDecimalString(
        String(srcBal?.moving_avg_cost ?? product.purchase_cost),
        baseCurrency,
      ).toDecimalString();

      await trx.db
        .insertInto('stock_transfer_lines')
        .values({
          id: generateUuidV7(),
          tenant_id: trx.tenantId,
          transfer_id: transferId,
          line_number: lineNum++,
          product_id: reqLine.productId,
          source_batch_id: null,
          destination_batch_id: null,
          serial_id: null,
          uom_code: product.base_uom,
          requested_qty: reqQty.toDecimalString(),
          dispatched_qty: null,
          received_qty: null,
          transfer_unit_cost: unitCost,
          transfer_selling_price: Money.fromDecimalString(
            String(product.selling_price),
            baseCurrency,
          ).toDecimalString(),
          expiry_date: null,
          batch_number_snapshot: null,
          dispatch_ledger_entry_id: null,
          receive_ledger_entry_id: null,
          created_at: now,
        })
        .execute();
    }
  }

  await appendAuditLog(trx, {
    action: 'INV_TRANSFER_CREATED',
    resourceType: 'STOCK_TRANSFER',
    resourceId: transferId,
    metadata: {
      transferNumber,
      sourceBranchId: input.sourceBranchId,
      sourceWarehouseId: input.sourceWarehouseId,
      destinationBranchId: input.destinationBranchId,
      destinationWarehouseId: input.destinationWarehouseId,
    },
  });

  return getStockTransferById(trx, transferId);
}

export async function getStockTransferById(
  trx: TenantTransactionContext,
  transferId: string,
): Promise<StockTransferResponse> {
  await assertAuthorized(trx, { permission: 'inv:movement:read' });

  const row = await trx.db
    .selectFrom('stock_transfers')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', transferId)
    .executeTakeFirst();

  if (!row) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'INV_TRANSFER_NOT_FOUND',
      title: 'Stock Transfer Not Found',
      detail: `Stock transfer "${transferId}" was not found.`,
    });
  }

  const [baseCurrency, lines] = await Promise.all([
    getTenantBaseCurrency(trx),
    trx.db
      .selectFrom('stock_transfer_lines')
      .selectAll()
      .where('tenant_id', '=', trx.tenantId)
      .where('transfer_id', '=', transferId)
      .orderBy('line_number', 'asc')
      .execute(),
  ]);

  return mapTransferRow(row, lines, baseCurrency);
}

export async function listStockTransfers(
  trx: TenantTransactionContext,
  query: ListStockTransfersQuery,
): Promise<StockTransferListResponse> {
  await assertAuthorized(trx, { permission: 'inv:movement:read' });

  const limit = Math.min(Math.max(Number(query.limit ?? 50), 1), 100);
  let dbQuery = trx.db
    .selectFrom('stock_transfers')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId);

  if (query.status) {
    dbQuery = dbQuery.where('status', '=', query.status);
  }
  if (query.sourceBranchId) {
    dbQuery = dbQuery.where('source_branch_id', '=', query.sourceBranchId);
  }
  if (query.destinationBranchId) {
    dbQuery = dbQuery.where('destination_branch_id', '=', query.destinationBranchId);
  }

  const rows = await dbQuery
    .orderBy('created_at', 'desc')
    .limit(limit)
    .execute();

  if (rows.length === 0) {
    return { items: [] };
  }

  const baseCurrency = await getTenantBaseCurrency(trx);
  const transferIds = rows.map((r) => r.id);
  const allLines = await trx.db
    .selectFrom('stock_transfer_lines')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('transfer_id', 'in', transferIds)
    .orderBy('line_number', 'asc')
    .execute();

  const linesByTransfer = new Map<string, Selectable<StockTransferLinesTable>[]>();
  for (const line of allLines) {
    const existing = linesByTransfer.get(line.transfer_id) ?? [];
    existing.push(line);
    linesByTransfer.set(line.transfer_id, existing);
  }

  return {
    items: rows.map((r) =>
      mapTransferRow(r, linesByTransfer.get(r.id) ?? [], baseCurrency),
    ),
  };
}

export async function dispatchStockTransfer(
  trx: TenantTransactionContext,
  transferId: string,
): Promise<StockTransferResponse> {
  const transfer = await trx.db
    .selectFrom('stock_transfers')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', transferId)
    .forUpdate()
    .executeTakeFirst();

  if (!transfer) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'INV_TRANSFER_NOT_FOUND',
      title: 'Stock Transfer Not Found',
      detail: `Stock transfer "${transferId}" was not found.`,
    });
  }

  await assertAuthorized(trx, {
    permission: 'inv:movement:post',
    branchId: transfer.source_branch_id,
    warehouseId: transfer.source_warehouse_id,
  });

  if (transfer.status !== 'DRAFT') {
    throw new AppError({
      statusCode: 409,
      errorCode: 'INV_TRANSFER_INVALID_STATUS',
      title: 'Transfer Cannot Be Dispatched',
      detail: `Transfer "${transfer.transfer_number}" is "${transfer.status}", expected "DRAFT".`,
    });
  }

  const lines = await trx.db
    .selectFrom('stock_transfer_lines')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('transfer_id', '=', transferId)
    .orderBy('line_number', 'asc')
    .execute();

  const now = new Date();
  for (const line of lines) {
    const reqQty = Quantity.fromDecimalString(String(line.requested_qty));
    const movement = await postStockMovement(
      trx,
      generateUuidV7(),
      {
        branchId: transfer.source_branch_id,
        warehouseId: transfer.source_warehouse_id,
        productId: line.product_id,
        batchId: line.source_batch_id,
        movementType: 'TRANSFER_OUT',
        quantity: reqQty.negate().toDecimalString(),
        uomCode: line.uom_code,
        unitCost: String(line.transfer_unit_cost),
        referenceType: 'STOCK_TRANSFER',
        referenceId: transfer.transfer_number,
        reason: `Stock transfer dispatch ${transfer.transfer_number} -> branch ${transfer.destination_branch_id}`,
      },
      { skipPermissionCheck: true },
    );

    await trx.db
      .updateTable('stock_transfer_lines')
      .set({
        dispatched_qty: reqQty.toDecimalString(),
        dispatch_ledger_entry_id: movement.id,
      })
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', line.id)
      .execute();
  }

  await trx.db
    .updateTable('stock_transfers')
    .set({
      status: 'IN_TRANSIT',
      dispatched_by_user_id: trx.userId,
      dispatched_at: now,
      updated_at: now,
    })
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', transferId)
    .execute();

  await appendAuditLog(trx, {
    action: 'INV_TRANSFER_DISPATCHED',
    resourceType: 'STOCK_TRANSFER',
    resourceId: transferId,
    metadata: { transferNumber: transfer.transfer_number, lineCount: lines.length },
  });

  return getStockTransferById(trx, transferId);
}

export async function receiveStockTransfer(
  trx: TenantTransactionContext,
  transferId: string,
  input?: ReceiveStockTransferRequest,
): Promise<StockTransferResponse> {
  const transfer = await trx.db
    .selectFrom('stock_transfers')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', transferId)
    .forUpdate()
    .executeTakeFirst();

  if (!transfer) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'INV_TRANSFER_NOT_FOUND',
      title: 'Stock Transfer Not Found',
      detail: `Stock transfer "${transferId}" was not found.`,
    });
  }

  await assertAuthorized(trx, {
    permission: 'inv:movement:post',
    branchId: transfer.destination_branch_id,
    warehouseId: transfer.destination_warehouse_id,
  });

  if (transfer.status !== 'IN_TRANSIT') {
    throw new AppError({
      statusCode: 409,
      errorCode: 'INV_TRANSFER_INVALID_STATUS',
      title: 'Transfer Cannot Be Received',
      detail: `Transfer "${transfer.transfer_number}" is "${transfer.status}", expected "IN_TRANSIT".`,
    });
  }

  const [baseCurrency, lines] = await Promise.all([
    getTenantBaseCurrency(trx),
    trx.db
      .selectFrom('stock_transfer_lines')
      .selectAll()
      .where('tenant_id', '=', trx.tenantId)
      .where('transfer_id', '=', transferId)
      .orderBy('line_number', 'asc')
      .execute(),
  ]);

  const overrideMap = new Map<string, string>();
  for (const item of input?.lines ?? []) {
    overrideMap.set(item.lineId, item.quantityReceived);
  }

  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);

  for (const line of lines) {
    const dispatchedQty = Quantity.fromDecimalString(
      String(line.dispatched_qty ?? line.requested_qty),
    );
    const receiveQtyStr = overrideMap.get(line.id) ?? dispatchedQty.toDecimalString();
    const receiveQty = Quantity.fromDecimalString(receiveQtyStr);

    if (!receiveQty.isPositive() || receiveQty.compare(dispatchedQty) > 0) {
      throw new AppError({
        statusCode: 422,
        errorCode: 'ERR_VALIDATION_FAILED',
        title: 'Invalid Transfer Receive Quantity',
        detail: `Receive quantity (${receiveQty.toDecimalString()}) must be > 0 and <= dispatched quantity (${dispatchedQty.toDecimalString()}).`,
      });
    }

    let destinationBatchId: string | null = null;
    if (line.source_batch_id || line.batch_number_snapshot) {
      const srcBatch = line.source_batch_id
        ? await trx.db
            .selectFrom('inventory_batches')
            .selectAll()
            .where('tenant_id', '=', trx.tenantId)
            .where('id', '=', line.source_batch_id)
            .executeTakeFirst()
        : undefined;

      const batchNum =
        srcBatch?.batch_number ??
        line.batch_number_snapshot ??
        `TRF-${transfer.transfer_number.slice(-6)}-${line.line_number}`;

      const existingDestBatch = await trx.db
        .selectFrom('inventory_batches')
        .selectAll()
        .where('tenant_id', '=', trx.tenantId)
        .where('warehouse_id', '=', transfer.destination_warehouse_id)
        .where('product_id', '=', line.product_id)
        .where('batch_number', '=', batchNum)
        .forUpdate()
        .executeTakeFirst();

      const preservedCost = Money.fromDecimalString(
        String(line.transfer_unit_cost),
        srcBatch?.currency_code ?? baseCurrency,
      ).toDecimalString();
      const preservedPrice =
        srcBatch?.selling_price != null
          ? Money.fromDecimalString(
              String(srcBatch.selling_price),
              srcBatch.currency_code ?? baseCurrency,
            ).toDecimalString()
          : line.transfer_selling_price != null
            ? Money.fromDecimalString(
                String(line.transfer_selling_price),
                baseCurrency,
              ).toDecimalString()
            : null;
      const preservedMinPrice =
        srcBatch?.min_selling_price != null
          ? Money.fromDecimalString(
              String(srcBatch.min_selling_price),
              srcBatch.currency_code ?? baseCurrency,
            ).toDecimalString()
          : null;

      if (existingDestBatch) {
        destinationBatchId = existingDestBatch.id;
        const nextInitial = Quantity.fromDecimalString(
          String(existingDestBatch.initial_quantity),
        ).add(receiveQty);
        await trx.db
          .updateTable('inventory_batches')
          .set({
            initial_quantity: nextInitial.toDecimalString(),
            ...(existingDestBatch.selling_price == null && preservedPrice != null
              ? { selling_price: preservedPrice }
              : {}),
            status: 'ACTIVE',
            updated_at: now,
          })
          .where('tenant_id', '=', trx.tenantId)
          .where('id', '=', existingDestBatch.id)
          .execute();
      } else {
        destinationBatchId = generateUuidV7();
        const destInternalBarcode = await generateUniqueInternalBatchBarcodeValue(trx);
        const expDate = srcBatch?.expiry_date
          ? new Date(srcBatch.expiry_date).toISOString().slice(0, 10)
          : line.expiry_date
            ? new Date(line.expiry_date).toISOString().slice(0, 10)
            : null;
        const mfgDate = srcBatch?.manufacturing_date
          ? new Date(srcBatch.manufacturing_date).toISOString().slice(0, 10)
          : null;

        await trx.db
          .insertInto('inventory_batches')
          .values({
            id: destinationBatchId,
            tenant_id: trx.tenantId,
            branch_id: transfer.destination_branch_id,
            product_id: line.product_id,
            warehouse_id: transfer.destination_warehouse_id,
            batch_number: batchNum,
            supplier_id: srcBatch?.supplier_id ?? null,
            status: 'ACTIVE',
            received_date: todayStr,
            manufacturing_date: mfgDate,
            expiry_date: expDate,
            initial_quantity: receiveQty.toDecimalString(),
            current_quantity: Quantity.zero().toDecimalString(),
            reserved_quantity: Quantity.zero().toDecimalString(),
            unit_cost: preservedCost,
            selling_price: preservedPrice,
            min_selling_price: preservedMinPrice,
            max_discount_pct: srcBatch?.max_discount_pct ?? null,
            batch_pricing_mode: srcBatch?.batch_pricing_mode ?? 'EXPLICIT',
            internal_barcode: destInternalBarcode,
            internal_barcode_type: 'CODE128',
            currency_code: srcBatch?.currency_code ?? baseCurrency,
            quarantine_reason: null,
            created_at: now,
            updated_at: now,
          })
          .execute();

        if (preservedPrice != null) {
          await trx.db
            .insertInto('batch_price_history')
            .values({
              id: generateUuidV7(),
              tenant_id: trx.tenantId,
              branch_id: transfer.destination_branch_id,
              product_id: line.product_id,
              batch_id: destinationBatchId,
              previous_price: null,
              new_price: preservedPrice,
              cost_snapshot: preservedCost,
              change_type: 'MANUAL_UPDATE',
              suggestion_id: null,
              reason: `Stock transfer receipt ${transfer.transfer_number} price preservation`,
              actor_user_id: trx.userId,
              approver_user_id: trx.userId,
              created_at: now,
            })
            .execute();
        }
      }
    }

    const movement = await postStockMovement(
      trx,
      generateUuidV7(),
      {
        branchId: transfer.destination_branch_id,
        warehouseId: transfer.destination_warehouse_id,
        productId: line.product_id,
        batchId: destinationBatchId,
        movementType: 'TRANSFER_IN',
        quantity: receiveQty.toDecimalString(),
        uomCode: line.uom_code,
        unitCost: String(line.transfer_unit_cost),
        referenceType: 'STOCK_TRANSFER',
        referenceId: transfer.transfer_number,
        reason: input?.notes
          ? `Transfer receipt ${transfer.transfer_number}: ${input.notes}`
          : `Stock transfer receipt ${transfer.transfer_number} <- branch ${transfer.source_branch_id}`,
      },
      { skipPermissionCheck: true },
    );

    await trx.db
      .updateTable('stock_transfer_lines')
      .set({
        destination_batch_id: destinationBatchId,
        received_qty: receiveQty.toDecimalString(),
        receive_ledger_entry_id: movement.id,
      })
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', line.id)
      .execute();
  }

  await trx.db
    .updateTable('stock_transfers')
    .set({
      status: 'RECEIVED',
      received_by_user_id: trx.userId,
      received_at: now,
      notes: input?.notes ?? transfer.notes,
      updated_at: now,
    })
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', transferId)
    .execute();

  await appendAuditLog(trx, {
    action: 'INV_TRANSFER_RECEIVED',
    resourceType: 'STOCK_TRANSFER',
    resourceId: transferId,
    metadata: { transferNumber: transfer.transfer_number, lineCount: lines.length },
  });

  return getStockTransferById(trx, transferId);
}

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

async function resolveBranchDefaultWarehouseId(
  trx: TenantTransactionContext,
  branchId: string,
  providedWarehouseId: string | undefined,
  label: string,
): Promise<{
  readonly warehouseId: string;
  readonly branchName: string;
  readonly branchCode: string;
}> {
  const branch = await trx.db
    .selectFrom('branches')
    .select(['id', 'code', 'name', 'default_warehouse_id', 'is_active'])
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', branchId)
    .executeTakeFirst();

  if (!branch) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'ERR_NOT_FOUND',
      title: `${label} Branch Not Found`,
      detail: `${label} branch "${branchId}" was not found.`,
    });
  }

  if (!branch.is_active) {
    throw new AppError({
      statusCode: 409,
      errorCode: 'ERR_CONFLICT',
      title: `${label} Branch Is Archived`,
      detail: `Archived branch "${branch.name}" (${branch.code}) cannot be used for stock transfers.`,
    });
  }

  if (providedWarehouseId) {
    await assertWarehouseBelongsToBranch(trx, providedWarehouseId, branchId, label);
    return {
      warehouseId: providedWarehouseId,
      branchName: branch.name,
      branchCode: branch.code,
    };
  }

  if (branch.default_warehouse_id) {
    const wh = await trx.db
      .selectFrom('warehouses')
      .select(['id', 'is_active'])
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', branch.default_warehouse_id)
      .executeTakeFirst();
    if (wh && wh.is_active) {
      return {
        warehouseId: wh.id,
        branchName: branch.name,
        branchCode: branch.code,
      };
    }
  }

  const linkedWh = await trx.db
    .selectFrom('warehouses')
    .select(['id'])
    .where('tenant_id', '=', trx.tenantId)
    .where('branch_id', '=', branchId)
    .where('is_active', '=', true)
    .orderBy('created_at', 'asc')
    .executeTakeFirst();

  if (!linkedWh) {
    throw new AppError({
      statusCode: 409,
      errorCode: 'ERR_CONFLICT',
      title: `No Active Warehouse For ${label} Branch`,
      detail: `${label} branch "${branch.name}" does not have an active default warehouse.`,
    });
  }

  await trx.db
    .updateTable('branches')
    .set({ default_warehouse_id: linkedWh.id, updated_at: new Date() })
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', branchId)
    .execute();

  return {
    warehouseId: linkedWh.id,
    branchName: branch.name,
    branchCode: branch.code,
  };
}

interface TransferEnrichmentLookups {
  readonly branches: ReadonlyMap<string, { code: string; name: string }>;
  readonly warehouses: ReadonlyMap<string, { code: string; name: string }>;
  readonly products: ReadonlyMap<string, { sku: string; name: string }>;
  readonly serials: ReadonlyMap<string, string>;
  readonly users: ReadonlyMap<string, string>;
}

async function loadTransferEnrichments(
  trx: TenantTransactionContext,
  transfers: readonly Selectable<StockTransfersTable>[],
  lines: readonly Selectable<StockTransferLinesTable>[],
): Promise<TransferEnrichmentLookups> {
  const branchIds = new Set<string>();
  const warehouseIds = new Set<string>();
  const userIds = new Set<string>();
  for (const t of transfers) {
    branchIds.add(t.source_branch_id);
    branchIds.add(t.destination_branch_id);
    warehouseIds.add(t.source_warehouse_id);
    warehouseIds.add(t.destination_warehouse_id);
    if (t.created_by_user_id) userIds.add(t.created_by_user_id);
  }

  const productIds = new Set<string>();
  const serialIds = new Set<string>();
  for (const l of lines) {
    productIds.add(l.product_id);
    if (l.serial_id) serialIds.add(l.serial_id);
  }

  const [branchRows, whRows, productRows, serialRows, userRows] = await Promise.all([
    branchIds.size > 0
      ? trx.db
          .selectFrom('branches')
          .select(['id', 'code', 'name'])
          .where('tenant_id', '=', trx.tenantId)
          .where('id', 'in', [...branchIds])
          .execute()
      : [],
    warehouseIds.size > 0
      ? trx.db
          .selectFrom('warehouses')
          .select(['id', 'code', 'name'])
          .where('tenant_id', '=', trx.tenantId)
          .where('id', 'in', [...warehouseIds])
          .execute()
      : [],
    productIds.size > 0
      ? trx.db
          .selectFrom('products')
          .select(['id', 'sku', 'name'])
          .where('tenant_id', '=', trx.tenantId)
          .where('id', 'in', [...productIds])
          .execute()
      : [],
    serialIds.size > 0
      ? trx.db
          .selectFrom('inventory_serials')
          .select(['id', 'serial_number'])
          .where('tenant_id', '=', trx.tenantId)
          .where('id', 'in', [...serialIds])
          .execute()
      : [],
    userIds.size > 0
      ? trx.db
          .selectFrom('users')
          .select(['id', 'full_name', 'email'])
          .where('id', 'in', [...userIds])
          .execute()
      : [],
  ]);

  return {
    branches: new Map(branchRows.map((b) => [b.id, { code: b.code, name: b.name }])),
    warehouses: new Map(whRows.map((w) => [w.id, { code: w.code, name: w.name }])),
    products: new Map(productRows.map((p) => [p.id, { sku: p.sku, name: p.name }])),
    serials: new Map(serialRows.map((s) => [s.id, s.serial_number])),
    users: new Map(
      userRows.map((u) => [u.id, u.full_name || u.email || u.id]),
    ),
  };
}

function mapTransferLineRow(
  row: Selectable<StockTransferLinesTable>,
  baseCurrency: string,
  lookups?: TransferEnrichmentLookups,
): StockTransferLineResponse {
  const prod = lookups?.products.get(row.product_id);
  const reqStr = Quantity.fromDecimalString(
    String(row.requested_qty),
  ).toDecimalString();
  return {
    id: row.id,
    lineNumber: row.line_number,
    productId: row.product_id,
    productSku: prod?.sku ?? null,
    productName: prod?.name ?? null,
    uomCode: row.uom_code ?? null,
    sourceBatchId: row.source_batch_id,
    destinationBatchId: row.destination_batch_id,
    serialId: row.serial_id ?? null,
    serialNumber: row.serial_id ? (lookups?.serials.get(row.serial_id) ?? null) : null,
    quantity: reqStr,
    quantityRequested: reqStr,
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
  lookups?: TransferEnrichmentLookups,
): StockTransferResponse {
  const srcBranch = lookups?.branches.get(row.source_branch_id);
  const dstBranch = lookups?.branches.get(row.destination_branch_id);
  const srcWh = lookups?.warehouses.get(row.source_warehouse_id);
  const dstWh = lookups?.warehouses.get(row.destination_warehouse_id);

  return {
    id: row.id,
    tenantId: row.tenant_id,
    transferNumber: row.transfer_number,
    sourceBranchId: row.source_branch_id,
    sourceBranchCode: srcBranch?.code ?? null,
    sourceBranchName: srcBranch?.name ?? null,
    sourceWarehouseId: row.source_warehouse_id,
    sourceWarehouseName: srcWh?.name ?? null,
    destinationBranchId: row.destination_branch_id,
    destinationBranchCode: dstBranch?.code ?? null,
    destinationBranchName: dstBranch?.name ?? null,
    destinationWarehouseId: row.destination_warehouse_id,
    destinationWarehouseName: dstWh?.name ?? null,
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
    createdByName: row.created_by_user_id
      ? (lookups?.users.get(row.created_by_user_id) ?? null)
      : null,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    lines: lines.map((l) => mapTransferLineRow(l, baseCurrency, lookups)),
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
  if (input.sourceBranchId === input.destinationBranchId) {
    throw new AppError({
      statusCode: 422,
      errorCode: 'INV_TRANSFER_BRANCH_CONFLICT',
      title: 'Identical Source and Destination Branch',
      detail: 'Source branch and destination branch must be different.',
    });
  }

  const [sourceResolved, destResolved] = await Promise.all([
    resolveBranchDefaultWarehouseId(
      trx,
      input.sourceBranchId,
      input.sourceWarehouseId,
      'Source',
    ),
    resolveBranchDefaultWarehouseId(
      trx,
      input.destinationBranchId,
      input.destinationWarehouseId,
      'Destination',
    ),
  ]);

  const sourceWarehouseId = sourceResolved.warehouseId;
  const destinationWarehouseId = destResolved.warehouseId;

  await assertAuthorized(trx, {
    permission: 'inv:movement:post',
    branchId: input.sourceBranchId,
    warehouseId: sourceWarehouseId,
  });

  if (input.autoComplete) {
    await assertAuthorized(trx, {
      permission: 'inv:movement:post',
      branchId: input.destinationBranchId,
      warehouseId: destinationWarehouseId,
    });
  }

  await assertSubscriptionEntitlement(trx, { requireWriteAccess: true });

  if (sourceWarehouseId === destinationWarehouseId) {
    throw new AppError({
      statusCode: 422,
      errorCode: 'INV_TRANSFER_BRANCH_CONFLICT',
      title: 'Identical Source and Destination Warehouse',
      detail: 'Source warehouse and destination warehouse cannot be the same.',
    });
  }

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
      source_warehouse_id: sourceWarehouseId,
      destination_branch_id: input.destinationBranchId,
      destination_warehouse_id: destinationWarehouseId,
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
    const isSerialTracked = product.tracking_mode === 'SERIAL';

    if (isSerialTracked) {
      const oneUnit = Quantity.fromDecimalString('1.000000');
      const countBig = reqQty.microUnits / oneUnit.microUnits;
      if (reqQty.microUnits % oneUnit.microUnits !== 0n || countBig < 1n) {
        throw new AppError({
          statusCode: 422,
          errorCode: 'ERR_VALIDATION_FAILED',
          title: 'Integer Quantity Required For Serialized Product',
          detail: `Product "${product.sku}" is serial-tracked and requires a whole-number transfer quantity.`,
        });
      }
      const neededCount = Number(countBig);

      let selectedSerials;
      if (reqLine.serialIds && reqLine.serialIds.length > 0) {
        if (reqLine.serialIds.length !== neededCount) {
          throw new AppError({
            statusCode: 422,
            errorCode: 'ERR_VALIDATION_FAILED',
            title: 'Serial Count Mismatch',
            detail: `Selected ${reqLine.serialIds.length} serial numbers but transfer quantity is ${neededCount}.`,
          });
        }
        selectedSerials = await trx.db
          .selectFrom('inventory_serials')
          .selectAll()
          .where('tenant_id', '=', trx.tenantId)
          .where('warehouse_id', '=', sourceWarehouseId)
          .where('product_id', '=', reqLine.productId)
          .where('status', '=', 'IN_STOCK')
          .where('id', 'in', reqLine.serialIds)
          .forUpdate()
          .execute();
      } else {
        selectedSerials = await trx.db
          .selectFrom('inventory_serials')
          .selectAll()
          .where('tenant_id', '=', trx.tenantId)
          .where('warehouse_id', '=', sourceWarehouseId)
          .where('product_id', '=', reqLine.productId)
          .where('status', '=', 'IN_STOCK')
          .orderBy('received_at', 'asc')
          .orderBy('id', 'asc')
          .limit(neededCount)
          .forUpdate()
          .execute();
      }

      if (selectedSerials.length < neededCount) {
        throw new AppError({
          statusCode: 409,
          errorCode: 'INV_INSUFFICIENT_AVAILABLE_STOCK',
          title: 'Insufficient Available Serials',
          detail: `Product "${product.sku}" only has ${selectedSerials.length} in-stock serial numbers in source branch "${sourceResolved.branchName}"; requested ${neededCount}.`,
        });
      }

      for (const serial of selectedSerials) {
        await trx.db
          .insertInto('stock_transfer_lines')
          .values({
            id: generateUuidV7(),
            tenant_id: trx.tenantId,
            transfer_id: transferId,
            line_number: lineNum++,
            product_id: reqLine.productId,
            source_batch_id: serial.batch_id ?? null,
            destination_batch_id: null,
            serial_id: serial.id,
            uom_code: product.base_uom,
            requested_qty: '1.000000',
            dispatched_qty: null,
            received_qty: null,
            transfer_unit_cost: Money.fromDecimalString(
              String(serial.unit_cost),
              baseCurrency,
            ).toDecimalString(),
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
    } else if (reqLine.sourceBatchId) {
      const batch = await trx.db
        .selectFrom('inventory_batches')
        .selectAll()
        .where('tenant_id', '=', trx.tenantId)
        .where('warehouse_id', '=', sourceWarehouseId)
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
        warehouseId: sourceWarehouseId,
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
        .select(['qty_on_hand', 'qty_reserved', 'moving_avg_cost'])
        .where('tenant_id', '=', trx.tenantId)
        .where('warehouse_id', '=', sourceWarehouseId)
        .where('product_id', '=', reqLine.productId)
        .executeTakeFirst();

      const onHand = Quantity.fromDecimalString(String(srcBal?.qty_on_hand ?? '0'));
      const reserved = Quantity.fromDecimalString(String(srcBal?.qty_reserved ?? '0'));
      const available = onHand.subtract(reserved);
      if (available.compare(reqQty) < 0) {
        throw new AppError({
          statusCode: 409,
          errorCode: 'INV_INSUFFICIENT_AVAILABLE_STOCK',
          title: 'Insufficient Stock',
          detail: `Product "${product.sku}" has ${available.toDecimalString()} available in source branch "${sourceResolved.branchName}"; requested ${reqQty.toDecimalString()}.`,
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
      sourceWarehouseId,
      destinationBranchId: input.destinationBranchId,
      destinationWarehouseId,
      autoComplete: Boolean(input.autoComplete),
    },
  });

  if (input.autoComplete) {
    await dispatchStockTransfer(trx, transferId);
    return receiveStockTransfer(trx, transferId, {
      notes: input.notes ?? null,
    });
  }

  return getStockTransferById(trx, transferId);
}

export async function getStockTransferById(
  trx: TenantTransactionContext,
  transferId: string,
): Promise<StockTransferResponse> {
  const authCtx = await assertAuthorized(trx, { permission: 'inv:movement:read' });

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

  if (!authCtx.allLocationsAccess) {
    const canSeeSource = authCtx.allowedBranchIds.has(row.source_branch_id);
    const canSeeDest = authCtx.allowedBranchIds.has(row.destination_branch_id);
    if (!canSeeSource && !canSeeDest) {
      throw new AppError({
        statusCode: 403,
        errorCode: 'IAM_LOCATION_SCOPE_DENIED',
        title: 'Location Scope Access Denied',
        detail: `User is not authorized to view stock transfer "${row.transfer_number}".`,
      });
    }
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

  const lookups = await loadTransferEnrichments(trx, [row], lines);
  return mapTransferRow(row, lines, baseCurrency, lookups);
}

export async function listStockTransfers(
  trx: TenantTransactionContext,
  query: ListStockTransfersQuery,
): Promise<StockTransferListResponse> {
  const authCtx = await assertAuthorized(trx, { permission: 'inv:movement:read' });

  if (!authCtx.allLocationsAccess) {
    if (query.branchId && !authCtx.allowedBranchIds.has(query.branchId)) {
      throw new AppError({
        statusCode: 403,
        errorCode: 'IAM_LOCATION_SCOPE_DENIED',
        title: 'Location Scope Access Denied',
        detail: `User is not authorized to query transfers for branch "${query.branchId}".`,
      });
    }
    if (
      query.sourceBranchId &&
      !authCtx.allowedBranchIds.has(query.sourceBranchId)
    ) {
      throw new AppError({
        statusCode: 403,
        errorCode: 'IAM_LOCATION_SCOPE_DENIED',
        title: 'Location Scope Access Denied',
        detail: `User is not authorized to query transfers from branch "${query.sourceBranchId}".`,
      });
    }
    if (
      query.destinationBranchId &&
      !authCtx.allowedBranchIds.has(query.destinationBranchId)
    ) {
      throw new AppError({
        statusCode: 403,
        errorCode: 'IAM_LOCATION_SCOPE_DENIED',
        title: 'Location Scope Access Denied',
        detail: `User is not authorized to query transfers to branch "${query.destinationBranchId}".`,
      });
    }
  }

  const limit = Math.min(Math.max(Number(query.limit ?? 50), 1), 100);
  let dbQuery = trx.db
    .selectFrom('stock_transfers')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId);

  if (!authCtx.allLocationsAccess) {
    const allowedBranches = [...authCtx.allowedBranchIds];
    if (allowedBranches.length === 0) {
      return { items: [] };
    }
    dbQuery = dbQuery.where((eb) =>
      eb.or([
        eb('source_branch_id', 'in', allowedBranches),
        eb('destination_branch_id', 'in', allowedBranches),
      ]),
    );
  }

  if (query.status) {
    dbQuery = dbQuery.where('status', '=', query.status);
  }
  if (query.branchId) {
    const bid = query.branchId;
    dbQuery = dbQuery.where((eb) =>
      eb.or([
        eb('source_branch_id', '=', bid),
        eb('destination_branch_id', '=', bid),
      ]),
    );
  }
  if (query.sourceBranchId) {
    dbQuery = dbQuery.where('source_branch_id', '=', query.sourceBranchId);
  }
  if (query.destinationBranchId) {
    dbQuery = dbQuery.where('destination_branch_id', '=', query.destinationBranchId);
  }
  if (query.productId) {
    const matchingTransferIds = await trx.db
      .selectFrom('stock_transfer_lines')
      .select('transfer_id')
      .where('tenant_id', '=', trx.tenantId)
      .where('product_id', '=', query.productId)
      .execute();
    const ids = matchingTransferIds.map((m) => m.transfer_id);
    if (ids.length === 0) {
      return { items: [] };
    }
    dbQuery = dbQuery.where('id', 'in', ids);
  }
  if (query.search && query.search.trim().length > 0) {
    const pattern = `%${query.search.trim().toUpperCase()}%`;
    dbQuery = dbQuery.where('transfer_number', 'ilike', pattern);
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

  const lookups = await loadTransferEnrichments(trx, rows, allLines);

  const linesByTransfer = new Map<string, Selectable<StockTransferLinesTable>[]>();
  for (const line of allLines) {
    const existing = linesByTransfer.get(line.transfer_id) ?? [];
    existing.push(line);
    linesByTransfer.set(line.transfer_id, existing);
  }

  return {
    items: rows.map((r) =>
      mapTransferRow(r, linesByTransfer.get(r.id) ?? [], baseCurrency, lookups),
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
        serialId: line.serial_id ?? null,
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
        transfer_unit_cost: movement.unitCost,
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
        serialId: line.serial_id ?? null,
        movementType: 'TRANSFER_IN',
        quantity: receiveQty.toDecimalString(),
        uomCode: line.uom_code,
        unitCost: String(line.transfer_unit_cost),
        sellingPrice:
          line.transfer_selling_price != null
            ? String(line.transfer_selling_price)
            : null,
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
        destination_intake_lot_id: movement.stockIntakeLotId ?? null,
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

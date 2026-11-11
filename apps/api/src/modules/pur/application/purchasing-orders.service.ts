import crypto from 'node:crypto';
import type {
  CreateGoodsReceiptRequest,
  CreatePurchaseOrderRequest,
  CreateSupplierReturnRequest,
  GoodsReceiptLineResponse,
  GoodsReceiptResponse,
  PurchaseOrderLineResponse,
  PurchaseOrderResponse,
  SupplierReturnResponse,
} from '@nexstock/contracts';
import {
  Money,
  Quantity,
  UomConversionError,
  convertQuantityBetweenUoms,
  divideAndRoundBigInt,
} from '@nexstock/domain-core';
import {
  resolveProductForInventory,
  triggerCostChangeSuggestionIfApplicable,
} from '../../cat/index.js';
import { assertAuthorized } from '../../iam/index.js';
import { ensureBatchForGoodsReceipt, postStockMovement } from '../../inv/index.js';
import {
  AppError,
  type TenantTransactionContext,
  appendAuditLog,
  enqueueOutboxEvent,
  generateUuidV7,
} from '../../shared/index.js';
import { assertSubscriptionEntitlement } from '../../sub/index.js';

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

function generateDocumentNumber(prefix: string): string {
  const stamp = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  const rand = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `${prefix}-${stamp}-${rand}`;
}

async function verifySupplierBranchWarehouse(
  trx: TenantTransactionContext,
  supplierId: string,
  branchId: string,
  warehouseId: string,
): Promise<{ readonly supplierName: string }> {
  const [supplier, branch, warehouse] = await Promise.all([
    trx.db
      .selectFrom('suppliers')
      .select(['id', 'business_name', 'status'])
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', supplierId)
      .executeTakeFirst(),
    trx.db
      .selectFrom('branches')
      .select(['id', 'is_active'])
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', branchId)
      .executeTakeFirst(),
    trx.db
      .selectFrom('warehouses')
      .select(['id', 'branch_id', 'is_active'])
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', warehouseId)
      .executeTakeFirst(),
  ]);

  if (!supplier || supplier.status !== 'ACTIVE') {
    throw new AppError({
      statusCode: 404,
      errorCode: 'ERR_NOT_FOUND',
      title: 'Active Supplier Not Found',
      detail: `Active supplier "${supplierId}" was not found.`,
    });
  }
  if (!branch || !branch.is_active) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'ERR_NOT_FOUND',
      title: 'Active Branch Not Found',
      detail: `Active branch "${branchId}" was not found.`,
    });
  }
  if (!warehouse || !warehouse.is_active) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'ERR_NOT_FOUND',
      title: 'Active Warehouse Not Found',
      detail: `Active warehouse "${warehouseId}" was not found.`,
    });
  }

  let linked = warehouse.branch_id === branchId;
  if (!linked) {
    const linkRow = await trx.db
      .selectFrom('branch_warehouse_links')
      .select(['branch_id'])
      .where('tenant_id', '=', trx.tenantId)
      .where('branch_id', '=', branchId)
      .where('warehouse_id', '=', warehouseId)
      .executeTakeFirst();
    linked = Boolean(linkRow);
  }
  if (!linked) {
    throw new AppError({
      statusCode: 400,
      errorCode: 'INV_BRANCH_WAREHOUSE_MISMATCH',
      title: 'Branch/Warehouse Mismatch',
      detail: `Warehouse "${warehouseId}" is not linked to branch "${branchId}".`,
    });
  }

  return { supplierName: supplier.business_name };
}

function buildCustomConversions(
  map: ReadonlyMap<string, string>,
): Array<{ uomCode: string; conversionFactorToBase: string }> {
  return [...map.entries()].map(([uomCode, conversionFactorToBase]) => ({
    uomCode,
    conversionFactorToBase,
  }));
}

async function hydratePurchaseOrders(
  trx: TenantTransactionContext,
  orders: ReadonlyArray<{
    id: string;
    tenant_id: string;
    branch_id: string;
    warehouse_id: string;
    supplier_id: string;
    po_number: string;
    status: 'DRAFT' | 'APPROVED' | 'PARTIALLY_RECEIVED' | 'RECEIVED' | 'CANCELLED';
    currency_code: string;
    total_amount: string;
    notes: string | null;
    expected_at: Date | null;
    created_at: Date;
    updated_at: Date;
  }>,
): Promise<PurchaseOrderResponse[]> {
  if (orders.length === 0) return [];
  const orderIds = orders.map((o) => o.id);
  const supplierIds = [...new Set(orders.map((o) => o.supplier_id))];

  const [lineRows, supplierRows] = await Promise.all([
    trx.db
      .selectFrom('purchase_order_lines')
      .leftJoin('products', (join) =>
        join
          .onRef('purchase_order_lines.tenant_id', '=', 'products.tenant_id')
          .onRef('purchase_order_lines.product_id', '=', 'products.id'),
      )
      .select([
        'purchase_order_lines.id as id',
        'purchase_order_lines.purchase_order_id as purchase_order_id',
        'purchase_order_lines.line_number as line_number',
        'purchase_order_lines.product_id as product_id',
        'products.name as product_name',
        'products.sku as sku',
        'purchase_order_lines.ordered_uom as ordered_uom',
        'purchase_order_lines.ordered_qty as ordered_qty',
        'purchase_order_lines.conversion_factor_to_base as conversion_factor_to_base',
        'purchase_order_lines.normalized_base_qty as normalized_base_qty',
        'purchase_order_lines.received_base_qty as received_base_qty',
        'purchase_order_lines.unit_cost as unit_cost',
        'purchase_order_lines.line_total as line_total',
      ])
      .where('purchase_order_lines.tenant_id', '=', trx.tenantId)
      .where('purchase_order_lines.purchase_order_id', 'in', orderIds)
      .orderBy('purchase_order_lines.line_number', 'asc')
      .execute(),
    trx.db
      .selectFrom('suppliers')
      .select(['id', 'business_name'])
      .where('tenant_id', '=', trx.tenantId)
      .where('id', 'in', supplierIds)
      .execute(),
  ]);

  const supplierMap = new Map(supplierRows.map((s) => [s.id, s.business_name]));
  const linesByPo = new Map<string, PurchaseOrderLineResponse[]>();

  for (const l of lineRows) {
    const orderCurrency =
      orders.find((o) => o.id === l.purchase_order_id)?.currency_code ?? 'USD';
    const arr = linesByPo.get(l.purchase_order_id) ?? [];
    arr.push({
      id: l.id,
      lineNumber: l.line_number,
      productId: l.product_id,
      ...(l.product_name ? { productName: l.product_name } : {}),
      ...(l.sku ? { sku: l.sku } : {}),
      orderedUom: l.ordered_uom,
      orderedQty: Quantity.fromDecimalString(String(l.ordered_qty)).toDecimalString(),
      conversionFactorToBase: Quantity.fromDecimalString(
        String(l.conversion_factor_to_base),
      ).toDecimalString(),
      normalizedBaseQty: Quantity.fromDecimalString(
        String(l.normalized_base_qty),
      ).toDecimalString(),
      receivedBaseQty: Quantity.fromDecimalString(
        String(l.received_base_qty),
      ).toDecimalString(),
      unitCost: Money.fromDecimalString(String(l.unit_cost), orderCurrency).toDecimalString(),
      lineTotal: Money.fromDecimalString(String(l.line_total), orderCurrency).toDecimalString(),
    });
    linesByPo.set(l.purchase_order_id, arr);
  }

  return orders.map((o) => {
    const supName = supplierMap.get(o.supplier_id);
    return {
      id: o.id,
      tenantId: o.tenant_id,
      branchId: o.branch_id,
      warehouseId: o.warehouse_id,
      supplierId: o.supplier_id,
      ...(supName ? { supplierName: supName } : {}),
      poNumber: o.po_number,
    status: o.status,
    currencyCode: o.currency_code,
    totalAmount: Money.fromDecimalString(String(o.total_amount), o.currency_code).toDecimalString(),
    notes: o.notes,
    expectedAt: o.expected_at ? new Date(o.expected_at).toISOString() : null,
    createdAt: new Date(o.created_at).toISOString(),
    updatedAt: new Date(o.updated_at).toISOString(),
    lines: linesByPo.get(o.id) ?? [],
  };
  });
}

export async function createPurchaseOrder(
  trx: TenantTransactionContext,
  input: CreatePurchaseOrderRequest,
): Promise<PurchaseOrderResponse> {
  await assertAuthorized(trx, {
    permission: 'pur:po:manage',
    branchId: input.branchId,
    warehouseId: input.warehouseId,
  });
  await assertSubscriptionEntitlement(trx, { requireWriteAccess: true });

  await verifySupplierBranchWarehouse(
    trx,
    input.supplierId,
    input.branchId,
    input.warehouseId,
  );
  const currencyCode = await getTenantBaseCurrency(trx);
  const poId = generateUuidV7();
  const poNumber = generateDocumentNumber('PO');
  const now = new Date();

  const preparedLines: Array<{
    id: string;
    lineNumber: number;
    productId: string;
    orderedUom: string;
    orderedQty: Quantity;
    conversionFactorToBase: string;
    normalizedBaseQty: Quantity;
    unitCost: Money;
    lineTotal: Money;
  }> = [];

  let grandTotal = Money.zero(currencyCode);

  for (let i = 0; i < input.lines.length; i += 1) {
    const line = input.lines[i]!;
    const product = await resolveProductForInventory(trx, line.productId);
    if (product.status !== 'ACTIVE' || product.productType !== 'STANDARD') {
      throw new AppError({
        statusCode: 422,
        errorCode: 'PUR_PRODUCT_NOT_ELIGIBLE',
        title: 'Product Not Eligible for Purchase Order',
        detail: `Product "${product.sku}" must be ACTIVE and STANDARD.`,
      });
    }

    const orderedQty = Quantity.fromDecimalString(line.orderedQty);
    if (!orderedQty.isPositive()) {
      throw new AppError({
        statusCode: 400,
        errorCode: 'ERR_VALIDATION_FAILED',
        title: 'Invalid Purchase Order Quantity',
        detail: 'Ordered quantity must be greater than zero.',
      });
    }

    const orderedUom = (line.orderedUom ?? product.purchaseUom ?? product.baseUom)
      .trim()
      .toUpperCase();
    let conversion: { convertedQuantity: Quantity; factorDecimal6: string };
    try {
      conversion = convertQuantityBetweenUoms({
        quantity: orderedQty.toDecimalString(),
        fromUom: orderedUom,
        toUom: product.baseUom,
        productBaseUom: product.baseUom,
        customConversions: buildCustomConversions(product.unitConversions),
        densityGPerMl: product.densityGPerMl,
      });
    } catch (err) {
      if (err instanceof UomConversionError) {
        throw new AppError({
          statusCode: 400,
          errorCode: 'CAT_INVALID_UOM_CONVERSION',
          title: 'Incompatible Purchase UoM',
          detail: err.message,
        });
      }
      throw err;
    }

    const unitCost = Money.fromDecimalString(line.unitCost, currencyCode);
    if (unitCost.isNegative()) {
      throw new AppError({
        statusCode: 400,
        errorCode: 'ERR_VALIDATION_FAILED',
        title: 'Negative Unit Cost',
        detail: 'Purchase unit cost cannot be negative.',
      });
    }
    const lineTotal = unitCost.multiplyByQuantity(orderedQty);
    grandTotal = grandTotal.add(lineTotal);

    preparedLines.push({
      id: generateUuidV7(),
      lineNumber: i + 1,
      productId: product.id,
      orderedUom,
      orderedQty,
      conversionFactorToBase: conversion.factorDecimal6,
      normalizedBaseQty: conversion.convertedQuantity,
      unitCost,
      lineTotal,
    });
  }

  const initialStatus = input.approveImmediately ? 'APPROVED' : 'DRAFT';
  await trx.db
    .insertInto('purchase_orders')
    .values({
      id: poId,
      tenant_id: trx.tenantId,
      branch_id: input.branchId,
      warehouse_id: input.warehouseId,
      supplier_id: input.supplierId,
      po_number: poNumber,
      status: initialStatus,
      currency_code: currencyCode,
      total_amount: grandTotal.toDecimalString(),
      notes: input.notes?.trim() ?? null,
      expected_at: input.expectedAt ? new Date(input.expectedAt) : null,
      created_by_user_id: trx.userId,
      approved_by_user_id: input.approveImmediately ? trx.userId : null,
      approved_at: input.approveImmediately ? now : null,
      created_at: now,
      updated_at: now,
    })
    .execute();

  for (const line of preparedLines) {
    await trx.db
      .insertInto('purchase_order_lines')
      .values({
        id: line.id,
        tenant_id: trx.tenantId,
        purchase_order_id: poId,
        line_number: line.lineNumber,
        product_id: line.productId,
        ordered_uom: line.orderedUom,
        ordered_qty: line.orderedQty.toDecimalString(),
        conversion_factor_to_base: line.conversionFactorToBase,
        normalized_base_qty: line.normalizedBaseQty.toDecimalString(),
        received_base_qty: Quantity.zero().toDecimalString(),
        unit_cost: line.unitCost.toDecimalString(),
        line_total: line.lineTotal.toDecimalString(),
        created_at: now,
      })
      .execute();
  }

  await appendAuditLog(trx, {
    action: 'PUR_ORDER_CREATED',
    resourceType: 'PURCHASE_ORDER',
    resourceId: poId,
    metadata: {
      poNumber,
      supplierId: input.supplierId,
      status: initialStatus,
      totalAmount: grandTotal.toDecimalString(),
    },
  });

  const row = await trx.db
    .selectFrom('purchase_orders')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', poId)
    .executeTakeFirstOrThrow();

  const [hydrated] = await hydratePurchaseOrders(trx, [row]);
  return hydrated!;
}

export async function approvePurchaseOrder(
  trx: TenantTransactionContext,
  purchaseOrderId: string,
): Promise<PurchaseOrderResponse> {
  const po = await trx.db
    .selectFrom('purchase_orders')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', purchaseOrderId)
    .forUpdate()
    .executeTakeFirst();

  if (!po) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'ERR_NOT_FOUND',
      title: 'Purchase Order Not Found',
      detail: `Purchase order "${purchaseOrderId}" was not found.`,
    });
  }

  await assertAuthorized(trx, {
    permission: 'pur:po:manage',
    branchId: po.branch_id,
    warehouseId: po.warehouse_id,
  });

  if (po.status !== 'DRAFT' && po.status !== 'APPROVED') {
    throw new AppError({
      statusCode: 409,
      errorCode: 'PUR_INVALID_STATUS_TRANSITION',
      title: 'Cannot Approve Purchase Order',
      detail: `Purchase order "${po.po_number}" is in status "${po.status}".`,
    });
  }

  if (po.status === 'DRAFT') {
    const now = new Date();
    await trx.db
      .updateTable('purchase_orders')
      .set({
        status: 'APPROVED',
        approved_by_user_id: trx.userId,
        approved_at: now,
        updated_at: now,
      })
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', po.id)
      .execute();

    await appendAuditLog(trx, {
      action: 'PUR_ORDER_APPROVED',
      resourceType: 'PURCHASE_ORDER',
      resourceId: po.id,
      metadata: { poNumber: po.po_number },
    });
  }

  const updated = await trx.db
    .selectFrom('purchase_orders')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', po.id)
    .executeTakeFirstOrThrow();

  const [hydrated] = await hydratePurchaseOrders(trx, [updated]);
  return hydrated!;
}

export async function listPurchaseOrders(
  trx: TenantTransactionContext,
  query: { branchId?: string; status?: string; limit?: number },
): Promise<PurchaseOrderResponse[]> {
  const authCtx = await assertAuthorized(trx, {
    permission: 'pur:po:read',
    ...(query.branchId ? { branchId: query.branchId } : {}),
  });
  await assertSubscriptionEntitlement(trx, { requireWriteAccess: false });

  const limit = Math.min(Math.max(Number(query.limit ?? 50), 1), 100);
  let dbQuery = trx.db
    .selectFrom('purchase_orders')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .orderBy('created_at', 'desc')
    .limit(limit);

  if (query.branchId) {
    dbQuery = dbQuery.where('branch_id', '=', query.branchId);
  }
  if (query.status) {
    dbQuery = dbQuery.where(
      'status',
      '=',
      query.status as 'DRAFT' | 'APPROVED' | 'PARTIALLY_RECEIVED' | 'RECEIVED' | 'CANCELLED',
    );
  }
  if (!authCtx.allLocationsAccess) {
    const allowedBranches = [...authCtx.allowedBranchIds];
    if (allowedBranches.length === 0) return [];
    dbQuery = dbQuery.where('branch_id', 'in', allowedBranches);
  }

  const rows = await dbQuery.execute();
  return hydratePurchaseOrders(trx, rows);
}

export async function postGoodsReceipt(
  trx: TenantTransactionContext,
  idempotencyKey: string,
  input: CreateGoodsReceiptRequest,
): Promise<GoodsReceiptResponse> {
  await assertAuthorized(trx, {
    permission: 'pur:grn:post',
    branchId: input.branchId,
    warehouseId: input.warehouseId,
  });
  await assertSubscriptionEntitlement(trx, { requireWriteAccess: true });

  await verifySupplierBranchWarehouse(
    trx,
    input.supplierId,
    input.branchId,
    input.warehouseId,
  );

  const currencyCode = await getTenantBaseCurrency(trx);
  const grnId = generateUuidV7();
  const grnNumber = generateDocumentNumber('GRN');
  const receivedAt = input.receivedAt ? new Date(input.receivedAt) : new Date();
  const now = new Date();

  let linkedPo: { id: string; status: string; po_number: string } | undefined;
  if (input.purchaseOrderId) {
    const poRow = await trx.db
      .selectFrom('purchase_orders')
      .selectAll()
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', input.purchaseOrderId)
      .forUpdate()
      .executeTakeFirst();

    if (!poRow) {
      throw new AppError({
        statusCode: 404,
        errorCode: 'ERR_NOT_FOUND',
        title: 'Purchase Order Not Found',
        detail: `Purchase order "${input.purchaseOrderId}" was not found.`,
      });
    }
    if (
      poRow.supplier_id !== input.supplierId ||
      poRow.branch_id !== input.branchId ||
      poRow.warehouse_id !== input.warehouseId
    ) {
      throw new AppError({
        statusCode: 400,
        errorCode: 'PUR_GRN_PO_MISMATCH',
        title: 'Goods Receipt Does Not Match Purchase Order',
        detail: 'Supplier, branch, and warehouse on the goods receipt must match the purchase order.',
      });
    }
    if (poRow.status !== 'APPROVED' && poRow.status !== 'PARTIALLY_RECEIVED') {
      throw new AppError({
        statusCode: 409,
        errorCode: 'PUR_ORDER_NOT_RECEIVABLE',
        title: 'Purchase Order Not Ready for Receiving',
        detail: `Purchase order "${poRow.po_number}" must be APPROVED or PARTIALLY_RECEIVED (current: "${poRow.status}").`,
      });
    }
    linkedPo = poRow;
  }

  // Insert GRN header first (referenced by goods_receipt_lines FK); update total_cost at end
  await trx.db
    .insertInto('goods_receipts')
    .values({
      id: grnId,
      tenant_id: trx.tenantId,
      purchase_order_id: input.purchaseOrderId ?? null,
      supplier_id: input.supplierId,
      branch_id: input.branchId,
      warehouse_id: input.warehouseId,
      grn_number: grnNumber,
      status: 'POSTED',
      currency_code: currencyCode,
      total_cost: Money.zero(currencyCode).toDecimalString(),
      notes: input.notes?.trim() ?? null,
      received_by_user_id: trx.userId,
      idempotency_key: idempotencyKey,
      received_at: receivedAt,
      created_at: now,
    })
    .execute();

  let grandTotalCost = Money.zero(currencyCode);
  const lineResponses: GoodsReceiptLineResponse[] = [];

  for (let i = 0; i < input.lines.length; i += 1) {
    const line = input.lines[i]!;
    const product = await resolveProductForInventory(trx, line.productId);
    if (product.status !== 'ACTIVE' || product.productType !== 'STANDARD') {
      throw new AppError({
        statusCode: 422,
        errorCode: 'PUR_PRODUCT_NOT_ELIGIBLE',
        title: 'Product Not Eligible for Goods Receipt',
        detail: `Product "${product.sku}" must be ACTIVE and STANDARD.`,
      });
    }

    const receivedQty = Quantity.fromDecimalString(line.receivedQty);
    if (!receivedQty.isPositive()) {
      throw new AppError({
        statusCode: 400,
        errorCode: 'ERR_VALIDATION_FAILED',
        title: 'Invalid Received Quantity',
        detail: 'Received quantity must be greater than zero.',
      });
    }

    const receivedUom = (line.receivedUom ?? product.purchaseUom ?? product.baseUom)
      .trim()
      .toUpperCase();

    let conv: {
      convertedQuantity: Quantity;
      factorDecimal6: string;
      numerator: bigint;
      denominator: bigint;
    };
    try {
      conv = convertQuantityBetweenUoms({
        quantity: receivedQty.toDecimalString(),
        fromUom: receivedUom,
        toUom: product.baseUom,
        productBaseUom: product.baseUom,
        customConversions: buildCustomConversions(product.unitConversions),
        densityGPerMl: product.densityGPerMl,
      });
    } catch (err) {
      if (err instanceof UomConversionError) {
        throw new AppError({
          statusCode: 400,
          errorCode: 'CAT_INVALID_UOM_CONVERSION',
          title: 'Incompatible Goods Receipt UoM',
          detail: err.message,
        });
      }
      throw err;
    }

    const unitCostPerReceived = Money.fromDecimalString(line.unitCost, currencyCode);
    if (unitCostPerReceived.isNegative()) {
      throw new AppError({
        statusCode: 400,
        errorCode: 'ERR_VALIDATION_FAILED',
        title: 'Negative Unit Cost',
        detail: 'Goods receipt unit cost cannot be negative.',
      });
    }

    // cost_per_base = cost_per_received / (numerator / denominator)
    const unitCostPerBaseScaled = divideAndRoundBigInt(
      unitCostPerReceived.scaledUnits * conv.denominator,
      conv.numerator,
      'HALF_EVEN',
    );
    const unitCostPerBase = Money.fromScaledUnits(unitCostPerBaseScaled, currencyCode);
    const lineTotalCost = unitCostPerReceived.multiplyByQuantity(receivedQty);
    grandTotalCost = grandTotalCost.add(lineTotalCost);

    let batchId: string | null = null;
    if (
      product.trackingMode === 'BATCH' ||
      product.trackingMode === 'BATCH_EXPIRY' ||
      line.batchNumber
    ) {
      if (
        (product.trackingMode === 'BATCH' || product.trackingMode === 'BATCH_EXPIRY') &&
        !line.batchNumber?.trim()
      ) {
        throw new AppError({
          statusCode: 422,
          errorCode: 'INV_BATCH_REQUIRED',
          title: 'Batch Number Required',
          detail: `Product "${product.sku}" uses trackingMode="${product.trackingMode}" and requires batchNumber on receipt.`,
        });
      }
      if (product.trackingMode === 'BATCH_EXPIRY' && !line.expiryDate) {
        throw new AppError({
          statusCode: 422,
          errorCode: 'INV_BATCH_EXPIRY_REQUIRED',
          title: 'Batch Expiry Date Required',
          detail: `Product "${product.sku}" uses BATCH_EXPIRY and requires expiryDate on receipt.`,
        });
      }
      if (line.batchNumber?.trim()) {
        const batchRes = await ensureBatchForGoodsReceipt(trx, {
          productId: product.id,
          warehouseId: input.warehouseId,
          supplierId: input.supplierId,
          batchNumber: line.batchNumber.trim(),
          expiryDate: line.expiryDate ?? null,
          receivedQtyBase: conv.convertedQuantity.toDecimalString(),
          unitCostPerBaseUom: unitCostPerBase.toDecimalString(),
          currencyCode,
          receivedDate: receivedAt.toISOString().slice(0, 10),
        });
        batchId = batchRes.batchId;
      }
    }

    const ledgerRes = await postStockMovement(
      trx,
      generateUuidV7(),
      {
        branchId: input.branchId,
        warehouseId: input.warehouseId,
        productId: product.id,
        ...(batchId ? { batchId } : {}),
        supplierId: input.supplierId,
        movementType: 'STOCK_IN',
        uomCode: receivedUom,
        quantity: receivedQty.toDecimalString(),
        unitCost: unitCostPerBase.toDecimalString(),
        referenceType: 'GOODS_RECEIPT',
        referenceId: grnId,
        entrySource: 'PURCHASE_RECEIPT',
        reason: `Goods Receipt ${grnNumber}`,
        occurredAt: receivedAt.toISOString(),
      },
      { skipPermissionCheck: true },
    );

    // Update product last purchase cost (in base_uom) without modifying active selling_price
    await trx.db
      .updateTable('products')
      .set({
        purchase_cost: unitCostPerBase.toDecimalString(),
        sync_version: Number(
          (
            await trx.db
              .selectFrom('products')
              .select(['sync_version'])
              .where('tenant_id', '=', trx.tenantId)
              .where('id', '=', product.id)
              .executeTakeFirstOrThrow()
          ).sync_version,
        ) + 1,
        updated_at: now,
      })
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', product.id)
      .execute();

    await triggerCostChangeSuggestionIfApplicable(trx, {
      productId: product.id,
      oldCost: product.purchaseCost,
      newCost: unitCostPerBase.toDecimalString(),
      sourceEventType: 'GRN_POSTED',
      sourceEventKey: `GRN:${grnId}:${product.id}`,
      reason: `Goods Receipt ${grnNumber} (${unitCostPerBase.toDecimalString()}/${product.baseUom})`,
      scopeBranchId: input.branchId,
    });

    if (line.purchaseOrderLineId && linkedPo) {
      const poLine = await trx.db
        .selectFrom('purchase_order_lines')
        .selectAll()
        .where('tenant_id', '=', trx.tenantId)
        .where('purchase_order_id', '=', linkedPo.id)
        .where('id', '=', line.purchaseOrderLineId)
        .forUpdate()
        .executeTakeFirst();

      if (!poLine) {
        throw new AppError({
          statusCode: 404,
          errorCode: 'ERR_NOT_FOUND',
          title: 'Purchase Order Line Not Found',
          detail: `Purchase order line "${line.purchaseOrderLineId}" was not found on PO "${linkedPo.po_number}".`,
        });
      }

      const nextReceivedBase = Quantity.fromDecimalString(
        String(poLine.received_base_qty),
      ).add(conv.convertedQuantity);

      await trx.db
        .updateTable('purchase_order_lines')
        .set({
          received_base_qty: nextReceivedBase.toDecimalString(),
        })
        .where('tenant_id', '=', trx.tenantId)
        .where('id', '=', poLine.id)
        .execute();
    }

    const grnLineId = generateUuidV7();
    await trx.db
      .insertInto('goods_receipt_lines')
      .values({
        id: grnLineId,
        tenant_id: trx.tenantId,
        goods_receipt_id: grnId,
        purchase_order_line_id: line.purchaseOrderLineId ?? null,
        line_number: i + 1,
        product_id: product.id,
        received_uom: receivedUom,
        received_qty: receivedQty.toDecimalString(),
        conversion_factor_to_base: conv.factorDecimal6,
        normalized_base_qty: conv.convertedQuantity.toDecimalString(),
        unit_cost_per_received_uom: unitCostPerReceived.toDecimalString(),
        unit_cost_per_base_uom: unitCostPerBase.toDecimalString(),
        line_total_cost: lineTotalCost.toDecimalString(),
        batch_number: line.batchNumber?.trim() || null,
        expiry_date: line.expiryDate ?? null,
        ledger_entry_id: ledgerRes.id,
        created_at: now,
      })
      .execute();

    lineResponses.push({
      id: grnLineId,
      lineNumber: i + 1,
      purchaseOrderLineId: line.purchaseOrderLineId ?? null,
      productId: product.id,
      receivedUom,
      receivedQty: receivedQty.toDecimalString(),
      conversionFactorToBase: conv.factorDecimal6,
      normalizedBaseQty: conv.convertedQuantity.toDecimalString(),
      unitCostPerReceivedUom: unitCostPerReceived.toDecimalString(),
      unitCostPerBaseUom: unitCostPerBase.toDecimalString(),
      lineTotalCost: lineTotalCost.toDecimalString(),
      batchNumber: line.batchNumber?.trim() || null,
      expiryDate: line.expiryDate ?? null,
      ledgerEntryId: ledgerRes.id,
    });
  }

  await trx.db
    .updateTable('goods_receipts')
    .set({
      total_cost: grandTotalCost.toDecimalString(),
    })
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', grnId)
    .execute();

  if (linkedPo) {
    const poLinesAfter = await trx.db
      .selectFrom('purchase_order_lines')
      .select(['normalized_base_qty', 'received_base_qty'])
      .where('tenant_id', '=', trx.tenantId)
      .where('purchase_order_id', '=', linkedPo.id)
      .execute();

    const allReceived = poLinesAfter.every(
      (pl) =>
        Quantity.fromDecimalString(String(pl.received_base_qty)).compare(
          Quantity.fromDecimalString(String(pl.normalized_base_qty)),
        ) >= 0,
    );
    await trx.db
      .updateTable('purchase_orders')
      .set({
        status: allReceived ? 'RECEIVED' : 'PARTIALLY_RECEIVED',
        updated_at: now,
      })
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', linkedPo.id)
      .execute();
  }

  await appendAuditLog(trx, {
    action: 'PUR_GOODS_RECEIPT_POSTED',
    resourceType: 'GOODS_RECEIPT',
    resourceId: grnId,
    metadata: {
      grnNumber,
      purchaseOrderId: input.purchaseOrderId ?? null,
      totalCost: grandTotalCost.toDecimalString(),
      lineCount: lineResponses.length,
    },
  });

  await enqueueOutboxEvent(trx, {
    aggregateType: 'GOODS_RECEIPT',
    aggregateId: grnId,
    eventType: 'GOODS_RECEIPT_POSTED',
    payload: {
      grnId,
      grnNumber,
      branchId: input.branchId,
      warehouseId: input.warehouseId,
    },
  });

  return {
    id: grnId,
    tenantId: trx.tenantId,
    purchaseOrderId: input.purchaseOrderId ?? null,
    supplierId: input.supplierId,
    branchId: input.branchId,
    warehouseId: input.warehouseId,
    grnNumber,
    status: 'POSTED',
    currencyCode,
    totalCost: grandTotalCost.toDecimalString(),
    notes: input.notes?.trim() ?? null,
    receivedAt: receivedAt.toISOString(),
    createdAt: now.toISOString(),
    lines: lineResponses,
  };
}

export async function listGoodsReceipts(
  trx: TenantTransactionContext,
  query: { branchId?: string; warehouseId?: string; limit?: number },
): Promise<GoodsReceiptResponse[]> {
  const authCtx = await assertAuthorized(trx, {
    permission: 'pur:po:read',
    ...(query.branchId ? { branchId: query.branchId } : {}),
    ...(query.warehouseId ? { warehouseId: query.warehouseId } : {}),
  });
  await assertSubscriptionEntitlement(trx, { requireWriteAccess: false });

  const limit = Math.min(Math.max(Number(query.limit ?? 50), 1), 100);
  let dbQuery = trx.db
    .selectFrom('goods_receipts')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .orderBy('created_at', 'desc')
    .limit(limit);

  if (query.branchId) {
    dbQuery = dbQuery.where('branch_id', '=', query.branchId);
  }
  if (query.warehouseId) {
    dbQuery = dbQuery.where('warehouse_id', '=', query.warehouseId);
  }
  if (!authCtx.allLocationsAccess) {
    const allowedBranches = [...authCtx.allowedBranchIds];
    if (allowedBranches.length === 0) return [];
    dbQuery = dbQuery.where('branch_id', 'in', allowedBranches);
  }

  const rows = await dbQuery.execute();
  if (rows.length === 0) return [];

  const grnIds = rows.map((r) => r.id);
  const lineRows = await trx.db
    .selectFrom('goods_receipt_lines')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('goods_receipt_id', 'in', grnIds)
    .orderBy('line_number', 'asc')
    .execute();

  const linesByGrn = new Map<string, GoodsReceiptLineResponse[]>();
  const currencyMap = new Map(rows.map((r) => [r.id, r.currency_code]));
  for (const l of lineRows) {
    const ccy = currencyMap.get(l.goods_receipt_id) ?? 'USD';
    const arr = linesByGrn.get(l.goods_receipt_id) ?? [];
    arr.push({
      id: l.id,
      lineNumber: l.line_number,
      purchaseOrderLineId: l.purchase_order_line_id,
      productId: l.product_id,
      receivedUom: l.received_uom,
      receivedQty: Quantity.fromDecimalString(String(l.received_qty)).toDecimalString(),
      conversionFactorToBase: Quantity.fromDecimalString(
        String(l.conversion_factor_to_base),
      ).toDecimalString(),
      normalizedBaseQty: Quantity.fromDecimalString(
        String(l.normalized_base_qty),
      ).toDecimalString(),
      unitCostPerReceivedUom: Money.fromDecimalString(
        String(l.unit_cost_per_received_uom),
        ccy,
      ).toDecimalString(),
      unitCostPerBaseUom: Money.fromDecimalString(
        String(l.unit_cost_per_base_uom),
        ccy,
      ).toDecimalString(),
      lineTotalCost: Money.fromDecimalString(String(l.line_total_cost), ccy).toDecimalString(),
      batchNumber: l.batch_number,
      expiryDate: l.expiry_date
        ? new Date(l.expiry_date).toISOString().slice(0, 10)
        : null,
      ledgerEntryId: l.ledger_entry_id,
    });
    linesByGrn.set(l.goods_receipt_id, arr);
  }

  return rows.map((r) => ({
    id: r.id,
    tenantId: r.tenant_id,
    purchaseOrderId: r.purchase_order_id,
    supplierId: r.supplier_id,
    branchId: r.branch_id,
    warehouseId: r.warehouse_id,
    grnNumber: r.grn_number,
    status: r.status,
    currencyCode: r.currency_code,
    totalCost: Money.fromDecimalString(String(r.total_cost), r.currency_code).toDecimalString(),
    notes: r.notes,
    receivedAt: new Date(r.received_at).toISOString(),
    createdAt: new Date(r.created_at).toISOString(),
    lines: linesByGrn.get(r.id) ?? [],
  }));
}

export async function createSupplierReturn(
  trx: TenantTransactionContext,
  idempotencyKey: string,
  input: CreateSupplierReturnRequest,
): Promise<SupplierReturnResponse> {
  await assertAuthorized(trx, {
    permission: 'pur:return:post',
    branchId: input.branchId,
    warehouseId: input.warehouseId,
  });
  await assertSubscriptionEntitlement(trx, { requireWriteAccess: true });

  await verifySupplierBranchWarehouse(
    trx,
    input.supplierId,
    input.branchId,
    input.warehouseId,
  );
  const product = await resolveProductForInventory(trx, input.productId);
  if (product.status !== 'ACTIVE' || product.productType !== 'STANDARD') {
    throw new AppError({
      statusCode: 422,
      errorCode: 'PUR_PRODUCT_NOT_ELIGIBLE',
      title: 'Product Not Eligible for Supplier Return',
      detail: `Product "${product.sku}" must be ACTIVE and STANDARD.`,
    });
  }

  const currencyCode = await getTenantBaseCurrency(trx);
  const returnQty = Quantity.fromDecimalString(input.returnQty);
  if (!returnQty.isPositive()) {
    throw new AppError({
      statusCode: 400,
      errorCode: 'ERR_VALIDATION_FAILED',
      title: 'Invalid Supplier Return Quantity',
      detail: 'Return quantity must be greater than zero.',
    });
  }

  const returnUom = (input.returnUom ?? product.purchaseUom ?? product.baseUom)
    .trim()
    .toUpperCase();

  let conv: {
    convertedQuantity: Quantity;
    factorDecimal6: string;
    numerator: bigint;
    denominator: bigint;
  };
  try {
    conv = convertQuantityBetweenUoms({
      quantity: returnQty.toDecimalString(),
      fromUom: returnUom,
      toUom: product.baseUom,
      productBaseUom: product.baseUom,
      customConversions: buildCustomConversions(product.unitConversions),
      densityGPerMl: product.densityGPerMl,
    });
  } catch (err) {
    if (err instanceof UomConversionError) {
      throw new AppError({
        statusCode: 400,
        errorCode: 'CAT_INVALID_UOM_CONVERSION',
        title: 'Incompatible Supplier Return UoM',
        detail: err.message,
      });
    }
    throw err;
  }

  const unitCostPerBase = input.unitCost
    ? Money.fromScaledUnits(
        divideAndRoundBigInt(
          Money.fromDecimalString(input.unitCost, currencyCode).scaledUnits * conv.denominator,
          conv.numerator,
          'HALF_EVEN',
        ),
        currencyCode,
      )
    : Money.fromDecimalString(product.purchaseCost, currencyCode);

  const returnId = generateUuidV7();
  const returnNumber = generateDocumentNumber('SRTN');
  const now = new Date();

  const ledgerEntry = await postStockMovement(
    trx,
    generateUuidV7(),
    {
      branchId: input.branchId,
      warehouseId: input.warehouseId,
      productId: product.id,
      supplierId: input.supplierId,
      movementType: 'SUPPLIER_RETURN',
      uomCode: returnUom,
      quantity: returnQty.negate().toDecimalString(),
      unitCost: unitCostPerBase.toDecimalString(),
      referenceType: 'SUPPLIER_RETURN',
      referenceId: returnId,
      entrySource: 'SUPPLIER_RETURN',
      reason: input.reason.trim(),
    },
    { skipPermissionCheck: true },
  );

  const totalCost = unitCostPerBase.multiplyByQuantity(conv.convertedQuantity);

  await trx.db
    .insertInto('supplier_returns')
    .values({
      id: returnId,
      tenant_id: trx.tenantId,
      supplier_id: input.supplierId,
      goods_receipt_id: input.goodsReceiptId ?? null,
      branch_id: input.branchId,
      warehouse_id: input.warehouseId,
      return_number: returnNumber,
      product_id: product.id,
      return_uom: returnUom,
      return_qty: returnQty.toDecimalString(),
      conversion_factor_to_base: conv.factorDecimal6,
      normalized_base_qty: conv.convertedQuantity.toDecimalString(),
      unit_cost: unitCostPerBase.toDecimalString(),
      total_cost: totalCost.toDecimalString(),
      reason: input.reason.trim(),
      ledger_entry_id: ledgerEntry.id,
      created_by_user_id: trx.userId,
      idempotency_key: idempotencyKey,
      created_at: now,
    })
    .execute();

  await appendAuditLog(trx, {
    action: 'PUR_SUPPLIER_RETURN_POSTED',
    resourceType: 'SUPPLIER_RETURN',
    resourceId: returnId,
    metadata: {
      returnNumber,
      productId: product.id,
      returnUom,
      returnQty: returnQty.toDecimalString(),
      normalizedBaseQty: conv.convertedQuantity.toDecimalString(),
    },
  });

  return {
    id: returnId,
    tenantId: trx.tenantId,
    supplierId: input.supplierId,
    goodsReceiptId: input.goodsReceiptId ?? null,
    branchId: input.branchId,
    warehouseId: input.warehouseId,
    returnNumber,
    productId: product.id,
    returnUom,
    returnQty: returnQty.toDecimalString(),
    conversionFactorToBase: conv.factorDecimal6,
    normalizedBaseQty: conv.convertedQuantity.toDecimalString(),
    unitCost: unitCostPerBase.toDecimalString(),
    totalCost: totalCost.toDecimalString(),
    reason: input.reason.trim(),
    ledgerEntryId: ledgerEntry.id,
    createdAt: now.toISOString(),
  };
}

export async function listSupplierReturns(
  trx: TenantTransactionContext,
  query: { branchId?: string; limit?: number },
): Promise<SupplierReturnResponse[]> {
  const authCtx = await assertAuthorized(trx, {
    permission: 'pur:po:read',
    ...(query.branchId ? { branchId: query.branchId } : {}),
  });
  await assertSubscriptionEntitlement(trx, { requireWriteAccess: false });

  const limit = Math.min(Math.max(Number(query.limit ?? 50), 1), 100);
  const currencyCode = await getTenantBaseCurrency(trx);
  let dbQuery = trx.db
    .selectFrom('supplier_returns')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .orderBy('created_at', 'desc')
    .limit(limit);

  if (query.branchId) {
    dbQuery = dbQuery.where('branch_id', '=', query.branchId);
  }
  if (!authCtx.allLocationsAccess) {
    const allowedBranches = [...authCtx.allowedBranchIds];
    if (allowedBranches.length === 0) return [];
    dbQuery = dbQuery.where('branch_id', 'in', allowedBranches);
  }

  const rows = await dbQuery.execute();
  return rows.map((r) => ({
    id: r.id,
    tenantId: r.tenant_id,
    supplierId: r.supplier_id,
    goodsReceiptId: r.goods_receipt_id,
    branchId: r.branch_id,
    warehouseId: r.warehouse_id,
    returnNumber: r.return_number,
    productId: r.product_id,
    returnUom: r.return_uom,
    returnQty: Quantity.fromDecimalString(String(r.return_qty)).toDecimalString(),
    conversionFactorToBase: Quantity.fromDecimalString(
      String(r.conversion_factor_to_base),
    ).toDecimalString(),
    normalizedBaseQty: Quantity.fromDecimalString(
      String(r.normalized_base_qty),
    ).toDecimalString(),
    unitCost: Money.fromDecimalString(String(r.unit_cost), currencyCode).toDecimalString(),
    totalCost: Money.fromDecimalString(String(r.total_cost), currencyCode).toDecimalString(),
    reason: r.reason,
    ledgerEntryId: r.ledger_entry_id,
    createdAt: new Date(r.created_at).toISOString(),
  }));
}

import {
  type ClosePosShiftRequest,
  type CreatePosSaleRequest,
  type ListPosRegistersQuery,
  type ListSalesQuery,
  type OpenPosShiftRequest,
  type PosProductItemResponse,
  type PosProductSearchQuery,
  type PosRegisterSummaryResponse,
  type PosShiftResponse,
  type ReceiptResponse,
  type SalesInvoiceResponse,
  type VoidSaleRequest,
} from '@nexstock/contracts';
import {
  Money,
  Quantity,
  calculateLinePricingAndTax,
} from '@nexstock/domain-core';
import { assertAuthorized } from '../../iam/index.js';
import { postStockMovement } from '../../inv/index.js';
import {
  AppError,
  type TenantTransactionContext,
  appendAuditLog,
  enqueueOutboxEvent,
  generateUuidV7,
} from '../../shared/index.js';
import { assertSubscriptionEntitlement } from '../../sub/index.js';
import { formatReceiptData } from '../domain/receipt-formatter.js';

// ============================================================================
// 1. POS REGISTERS
// ============================================================================

export async function listAuthorizedRegisters(
  trx: TenantTransactionContext,
  query: ListPosRegistersQuery,
): Promise<PosRegisterSummaryResponse[]> {
  await assertAuthorized(trx, {
    permission: 'pos:register:read',
    branchId: query.branchId,
  });

  let dbQuery = trx.db
    .selectFrom('pos_registers')
    .select(['id', 'branch_id', 'warehouse_id', 'code', 'name', 'is_active'])
    .where('tenant_id', '=', trx.tenantId);

  if (query.branchId) {
    dbQuery = dbQuery.where('branch_id', '=', query.branchId);
  }

  const rows = await dbQuery.orderBy('code', 'asc').execute();

  return rows.map((r) => ({
    id: r.id,
    branchId: r.branch_id,
    warehouseId: r.warehouse_id,
    code: r.code,
    name: r.name,
    isActive: r.is_active,
  }));
}

// ============================================================================
// 2. POS SHIFTS / CASHIER SESSIONS
// ============================================================================

export async function openPosShift(
  trx: TenantTransactionContext,
  input: OpenPosShiftRequest,
): Promise<PosShiftResponse> {
  const register = await trx.db
    .selectFrom('pos_registers')
    .select(['id', 'branch_id', 'warehouse_id', 'code', 'name', 'is_active'])
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', input.registerId)
    .executeTakeFirst();

  if (!register) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'POS_REGISTER_NOT_FOUND',
      title: 'POS Register Not Found',
      detail: `POS Register "${input.registerId}" was not found in tenant "${trx.tenantId}".`,
    });
  }

  if (!register.is_active) {
    throw new AppError({
      statusCode: 409,
      errorCode: 'POS_REGISTER_INACTIVE',
      title: 'POS Register Inactive',
      detail: `POS Register "${register.code}" is disabled.`,
    });
  }

  await assertAuthorized(trx, {
    permission: 'pos:shift:open',
    branchId: register.branch_id,
    warehouseId: register.warehouse_id,
  });

  await assertSubscriptionEntitlement(trx, { requireWriteAccess: true });

  // Check if an OPEN shift already exists for this register
  const existingShift = await trx.db
    .selectFrom('pos_shifts')
    .select(['id'])
    .where('tenant_id', '=', trx.tenantId)
    .where('register_id', '=', input.registerId)
    .where('status', '=', 'OPEN')
    .executeTakeFirst();

  if (existingShift) {
    throw new AppError({
      statusCode: 409,
      errorCode: 'POS_SHIFT_ALREADY_OPEN',
      title: 'Active Shift Already Open',
      detail: `An active cashier shift is already open for register "${register.code}". Close it before opening a new one.`,
    });
  }

  const tenant = await trx.db
    .selectFrom('tenants')
    .select(['base_currency'])
    .where('id', '=', trx.tenantId)
    .executeTakeFirstOrThrow();

  const openingFloatMoney = Money.fromDecimalString(
    input.openingCashFloat,
    tenant.base_currency,
  );
  if (openingFloatMoney.isNegative()) {
    throw new AppError({
      statusCode: 400,
      errorCode: 'ERR_VALIDATION_FAILED',
      title: 'Negative Opening Float Forbidden',
      detail: 'Opening cash float cannot be negative.',
    });
  }

  const shiftId = generateUuidV7();
  const shiftRow = await trx.db
    .insertInto('pos_shifts')
    .values({
      id: shiftId,
      tenant_id: trx.tenantId,
      branch_id: register.branch_id,
      register_id: register.id,
      opened_by_user_id: trx.userId,
      closed_by_user_id: null,
      currency_code: tenant.base_currency,
      opening_cash_float: openingFloatMoney.toDecimalString(),
      expected_closing_cash: openingFloatMoney.toDecimalString(),
      counted_closing_cash: null,
      cash_variance: null,
      status: 'OPEN',
      notes: input.notes?.trim() || null,
      metadata_json: JSON.stringify({ traceId: trx.tenantContext.traceId }),
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  await appendAuditLog(trx, {
    action: 'pos:shift:open',
    resourceType: 'pos_shifts',
    resourceId: shiftId,
    metadata: {
      registerId: register.id,
      openingCashFloat: openingFloatMoney.toDecimalString(),
    },
  });

  return {
    id: shiftRow.id,
    branchId: shiftRow.branch_id,
    registerId: shiftRow.register_id,
    openedByUserId: shiftRow.opened_by_user_id,
    closedByUserId: shiftRow.closed_by_user_id,
    currencyCode: shiftRow.currency_code,
    openingCashFloat: Money.fromDecimalString(
      shiftRow.opening_cash_float,
      shiftRow.currency_code,
    ).toDecimalString(),
    expectedClosingCash: Money.fromDecimalString(
      shiftRow.expected_closing_cash,
      shiftRow.currency_code,
    ).toDecimalString(),
    countedClosingCash: shiftRow.counted_closing_cash
      ? Money.fromDecimalString(
          shiftRow.counted_closing_cash,
          shiftRow.currency_code,
        ).toDecimalString()
      : null,
    cashVariance: shiftRow.cash_variance
      ? Money.fromDecimalString(
          shiftRow.cash_variance,
          shiftRow.currency_code,
        ).toDecimalString()
      : null,
    status: shiftRow.status,
    openedAt: shiftRow.opened_at.toISOString(),
    closedAt: shiftRow.closed_at
      ? (shiftRow.closed_at as Date).toISOString()
      : null,
    notes: shiftRow.notes,
  };
}

export async function closePosShift(
  trx: TenantTransactionContext,
  shiftId: string,
  input: ClosePosShiftRequest,
): Promise<PosShiftResponse> {
  const shift = await trx.db
    .selectFrom('pos_shifts')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', shiftId)
    .forUpdate()
    .executeTakeFirst();

  if (!shift) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'POS_SHIFT_NOT_FOUND',
      title: 'Shift Not Found',
      detail: `POS Shift "${shiftId}" was not found in tenant "${trx.tenantId}".`,
    });
  }

  if (shift.status === 'CLOSED') {
    throw new AppError({
      statusCode: 409,
      errorCode: 'POS_SHIFT_ALREADY_CLOSED',
      title: 'Shift Already Closed',
      detail: `POS Shift "${shiftId}" is already closed.`,
    });
  }

  await assertAuthorized(trx, {
    permission: 'pos:shift:close',
    branchId: shift.branch_id,
  });

  await assertSubscriptionEntitlement(trx, { requireWriteAccess: true });

  // Compute total cash received during this shift from completed sales
  const cashPayments = await trx.db
    .selectFrom('sales_payments')
    .innerJoin('sales_invoices', (join) =>
      join
        .onRef('sales_payments.tenant_id', '=', 'sales_invoices.tenant_id')
        .onRef('sales_payments.invoice_id', '=', 'sales_invoices.id'),
    )
    .select(['sales_payments.amount', 'sales_payments.change_amount'])
    .where('sales_invoices.tenant_id', '=', trx.tenantId)
    .where('sales_invoices.shift_id', '=', shiftId)
    .where('sales_invoices.status', '=', 'COMPLETED')
    .where('sales_payments.payment_method', '=', 'CASH')
    .where('sales_payments.status', '=', 'COMPLETED')
    .execute();

  let netCashSales = Money.zero(shift.currency_code);
  for (const cp of cashPayments) {
    const paidMoney = Money.fromDecimalString(cp.amount, shift.currency_code);
    netCashSales = netCashSales.add(paidMoney);
  }

  const openingFloatMoney = Money.fromDecimalString(
    shift.opening_cash_float,
    shift.currency_code,
  );
  const expectedClosingCashMoney = openingFloatMoney.add(netCashSales);
  const countedClosingCashMoney = Money.fromDecimalString(
    input.countedClosingCash,
    shift.currency_code,
  );
  const cashVarianceMoney = countedClosingCashMoney.subtract(
    expectedClosingCashMoney,
  );

  const updatedShift = await trx.db
    .updateTable('pos_shifts')
    .set({
      status: 'CLOSED',
      closed_by_user_id: trx.userId,
      closed_at: new Date(),
      expected_closing_cash: expectedClosingCashMoney.toDecimalString(),
      counted_closing_cash: countedClosingCashMoney.toDecimalString(),
      cash_variance: cashVarianceMoney.toDecimalString(),
      notes: input.notes?.trim() ?? shift.notes,
    })
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', shiftId)
    .returningAll()
    .executeTakeFirstOrThrow();

  await appendAuditLog(trx, {
    action: 'pos:shift:close',
    resourceType: 'pos_shifts',
    resourceId: shiftId,
    metadata: {
      expectedClosingCash: expectedClosingCashMoney.toDecimalString(),
      countedClosingCash: countedClosingCashMoney.toDecimalString(),
      variance: cashVarianceMoney.toDecimalString(),
    },
  });

  await enqueueOutboxEvent(trx, {
    eventType: 'PosShiftClosedEvent',
    aggregateType: 'pos_shifts',
    aggregateId: shiftId,
    payload: {
      shiftId,
      registerId: shift.register_id,
      expectedClosingCash: expectedClosingCashMoney.toDecimalString(),
      countedClosingCash: countedClosingCashMoney.toDecimalString(),
      cashVariance: cashVarianceMoney.toDecimalString(),
    },
  });

  return {
    id: updatedShift.id,
    branchId: updatedShift.branch_id,
    registerId: updatedShift.register_id,
    openedByUserId: updatedShift.opened_by_user_id,
    closedByUserId: updatedShift.closed_by_user_id,
    currencyCode: updatedShift.currency_code,
    openingCashFloat: Money.fromDecimalString(
      updatedShift.opening_cash_float,
      updatedShift.currency_code,
    ).toDecimalString(),
    expectedClosingCash: Money.fromDecimalString(
      updatedShift.expected_closing_cash,
      updatedShift.currency_code,
    ).toDecimalString(),
    countedClosingCash: updatedShift.counted_closing_cash
      ? Money.fromDecimalString(
          updatedShift.counted_closing_cash,
          updatedShift.currency_code,
        ).toDecimalString()
      : null,
    cashVariance: updatedShift.cash_variance
      ? Money.fromDecimalString(
          updatedShift.cash_variance,
          updatedShift.currency_code,
        ).toDecimalString()
      : null,
    status: updatedShift.status,
    openedAt: updatedShift.opened_at.toISOString(),
    closedAt: updatedShift.closed_at
      ? (updatedShift.closed_at as Date).toISOString()
      : null,
    notes: updatedShift.notes,
  };
}

export async function getActivePosShift(
  trx: TenantTransactionContext,
  registerId: string,
): Promise<PosShiftResponse | null> {
  const register = await trx.db
    .selectFrom('pos_registers')
    .select(['id', 'branch_id', 'warehouse_id', 'code'])
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', registerId)
    .executeTakeFirst();

  if (!register) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'POS_REGISTER_NOT_FOUND',
      title: 'POS Register Not Found',
      detail: `POS Register "${registerId}" was not found.`,
    });
  }

  await assertAuthorized(trx, {
    permission: 'pos:register:read',
    branchId: register.branch_id,
    warehouseId: register.warehouse_id,
  });

  const shiftRow = await trx.db
    .selectFrom('pos_shifts')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('register_id', '=', registerId)
    .where('status', '=', 'OPEN')
    .executeTakeFirst();

  if (!shiftRow) {
    return null;
  }

  return {
    id: shiftRow.id,
    branchId: shiftRow.branch_id,
    registerId: shiftRow.register_id,
    openedByUserId: shiftRow.opened_by_user_id,
    closedByUserId: shiftRow.closed_by_user_id,
    currencyCode: shiftRow.currency_code,
    openingCashFloat: Money.fromDecimalString(
      shiftRow.opening_cash_float,
      shiftRow.currency_code,
    ).toDecimalString(),
    expectedClosingCash: Money.fromDecimalString(
      shiftRow.expected_closing_cash,
      shiftRow.currency_code,
    ).toDecimalString(),
    countedClosingCash: shiftRow.counted_closing_cash
      ? Money.fromDecimalString(
          shiftRow.counted_closing_cash,
          shiftRow.currency_code,
        ).toDecimalString()
      : null,
    cashVariance: shiftRow.cash_variance
      ? Money.fromDecimalString(
          shiftRow.cash_variance,
          shiftRow.currency_code,
        ).toDecimalString()
      : null,
    status: shiftRow.status,
    openedAt: shiftRow.opened_at.toISOString(),
    closedAt: shiftRow.closed_at
      ? (shiftRow.closed_at as Date).toISOString()
      : null,
    notes: shiftRow.notes,
  };
}

// ============================================================================
// 3. PRODUCT DISCOVERY FOR CHECKOUT
// ============================================================================

export async function searchPosProducts(
  trx: TenantTransactionContext,
  query: PosProductSearchQuery,
): Promise<PosProductItemResponse[]> {
  await assertAuthorized(trx, {
    permission: 'pos:sale:create',
    warehouseId: query.warehouseId,
  });

  const limit = Math.min(Math.max(Number(query.limit ?? 25), 1), 100);

  let dbQuery = trx.db
    .selectFrom('products')
    .leftJoin('categories', (join) =>
      join
        .onRef('products.tenant_id', '=', 'categories.tenant_id')
        .onRef('products.category_id', '=', 'categories.id'),
    )
    .leftJoin('inventory_balances', (join) =>
      join
        .onRef('products.tenant_id', '=', 'inventory_balances.tenant_id')
        .onRef('products.id', '=', 'inventory_balances.product_id')
        .on('inventory_balances.warehouse_id', '=', query.warehouseId),
    )
    .select([
      'products.id as product_id',
      'products.sku as sku',
      'products.name as name',
      'products.product_type as product_type',
      'products.base_uom as base_uom',
      'products.selling_price as selling_price',
      'products.track_inventory as track_inventory',
      'categories.name as category_name',
      'inventory_balances.qty_on_hand as qty_on_hand',
      'inventory_balances.qty_reserved as qty_reserved',
    ])
    .where('products.tenant_id', '=', trx.tenantId)
    .where('products.status', '=', 'ACTIVE');

  if (query.categoryId) {
    dbQuery = dbQuery.where('products.category_id', '=', query.categoryId);
  }

  // Exact barcode match search takes highest precedence
  if (query.barcode) {
    const trimmedBarcode = query.barcode.trim();
    const barcodeMatches = await trx.db
      .selectFrom('product_barcodes')
      .select(['product_id'])
      .where('tenant_id', '=', trx.tenantId)
      .where('barcode', '=', trimmedBarcode)
      .execute();

    if (barcodeMatches.length > 0) {
      const productIds = barcodeMatches.map((b) => b.product_id);
      dbQuery = dbQuery.where('products.id', 'in', productIds);
    } else {
      // Also try matching SKU directly
      dbQuery = dbQuery.where((eb) =>
        eb.or([
          eb('products.sku', '=', trimmedBarcode),
          eb('products.name', 'ilike', `%${trimmedBarcode}%`),
        ]),
      );
    }
  } else if (query.q) {
    const trimmedQ = query.q.trim();
    const matchedBarcodeProductIds = await trx.db
      .selectFrom('product_barcodes')
      .select(['product_id'])
      .where('tenant_id', '=', trx.tenantId)
      .where('barcode', 'ilike', `%${trimmedQ}%`)
      .execute();

    const matchedIds = matchedBarcodeProductIds.map((b) => b.product_id);

    dbQuery = dbQuery.where((eb) => {
      const conditions = [
        eb('products.sku', 'ilike', `%${trimmedQ}%`),
        eb('products.name', 'ilike', `%${trimmedQ}%`),
      ];
      if (matchedIds.length > 0) {
        conditions.push(eb('products.id', 'in', matchedIds));
      }
      return eb.or(conditions);
    });
  }

  const rows = await dbQuery.orderBy('products.name', 'asc').limit(limit).execute();

  if (rows.length === 0) {
    return [];
  }

  const productIds = rows.map((r) => r.product_id);
  const barcodes = await trx.db
    .selectFrom('product_barcodes')
    .select(['product_id', 'barcode'])
    .where('tenant_id', '=', trx.tenantId)
    .where('product_id', 'in', productIds)
    .execute();

  const barcodesByProduct = new Map<string, string[]>();
  for (const b of barcodes) {
    const list = barcodesByProduct.get(b.product_id) ?? [];
    list.push(b.barcode);
    barcodesByProduct.set(b.product_id, list);
  }

  return rows.map((r) => {
    let availableQtyStr = '0.000000';
    if (r.track_inventory && r.qty_on_hand) {
      const onHand = Quantity.fromDecimalString(r.qty_on_hand);
      const reserved = Quantity.fromDecimalString(r.qty_reserved ?? '0.000000');
      availableQtyStr = onHand.subtract(reserved).toDecimalString();
    }

    return {
      id: r.product_id,
      sku: r.sku,
      name: r.name,
      productType: r.product_type as 'STANDARD' | 'SERVICE',
      baseUom: r.base_uom,
      retailPrice: Money.fromDecimalString(r.selling_price, 'USD').toDecimalString(),
      trackInventory: r.track_inventory,
      availableQuantity: availableQtyStr,
      barcodes: barcodesByProduct.get(r.product_id) ?? [],
      categoryName: r.category_name ?? null,
    };
  });
}

// ============================================================================
// 4. CHECKOUT AND SALE CREATION (ATOMIC SERVER-SIDE TRANSACTION)
// ============================================================================

export async function checkoutSale(
  trx: TenantTransactionContext,
  idempotencyKey: string,
  input: CreatePosSaleRequest,
): Promise<SalesInvoiceResponse> {
  await assertSubscriptionEntitlement(trx, { requireWriteAccess: true });

  const register = await trx.db
    .selectFrom('pos_registers')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', input.registerId)
    .forUpdate()
    .executeTakeFirst();

  if (!register) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'POS_REGISTER_NOT_FOUND',
      title: 'POS Register Not Found',
      detail: `Register "${input.registerId}" was not found.`,
    });
  }

  if (!register.is_active) {
    throw new AppError({
      statusCode: 409,
      errorCode: 'POS_REGISTER_INACTIVE',
      title: 'POS Register Inactive',
      detail: `Register "${register.code}" is disabled.`,
    });
  }

  await assertAuthorized(trx, {
    permission: 'pos:sale:create',
    branchId: register.branch_id,
    warehouseId: register.warehouse_id,
  });

  if (input.lines.length === 0) {
    throw new AppError({
      statusCode: 422,
      errorCode: 'POS_CART_EMPTY',
      title: 'Cart Is Empty',
      detail: 'Cannot complete checkout with an empty cart.',
    });
  }

  // Validate active shift if provided
  if (input.shiftId) {
    const shift = await trx.db
      .selectFrom('pos_shifts')
      .select(['id', 'register_id', 'status'])
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', input.shiftId)
      .executeTakeFirst();

    if (!shift || shift.register_id !== register.id || shift.status !== 'OPEN') {
      throw new AppError({
        statusCode: 409,
        errorCode: 'POS_SHIFT_NOT_OPEN',
        title: 'POS Shift Not Open',
        detail: `The specified shift "${input.shiftId}" is not currently open for register "${register.code}".`,
      });
    }
  }

  // Tenant base currency
  const tenant = await trx.db
    .selectFrom('tenants')
    .select(['base_currency', 'legal_name'])
    .where('id', '=', trx.tenantId)
    .executeTakeFirstOrThrow();

  const currencyCode = tenant.base_currency;

  // Increment sequential invoice number concurrency-safely
  const nextSeq = BigInt(register.last_invoice_seq) + 1n;
  await trx.db
    .updateTable('pos_registers')
    .set({ last_invoice_seq: Number(nextSeq) })
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', register.id)
    .execute();

  const invoiceNumber = `${register.code}-${nextSeq.toString().padStart(6, '0')}`;
  const saleId = generateUuidV7();

  // Resolve Products & Calculate Line Totals
  const processedLines: Array<{
    readonly lineNumber: number;
    readonly productId: string;
    readonly sku: string;
    readonly productName: string;
    readonly uomCode: string;
    readonly quantity: Quantity;
    readonly unitPrice: Money;
    readonly discountAmount: Money;
    readonly taxAmount: Money;
    readonly lineTotal: Money;
    readonly trackInventory: boolean;
    readonly unitCostSnapshot: string;
  }> = [];

  let subtotalAccumulator = Money.zero(currencyCode);
  let totalLineDiscounts = Money.zero(currencyCode);
  let totalTaxes = Money.zero(currencyCode);

  for (let idx = 0; idx < input.lines.length; idx++) {
    const lineItem = input.lines[idx]!;
    const lineNumber = idx + 1;

    let lineQty: Quantity;
    try {
      lineQty = Quantity.fromDecimalString(lineItem.quantity);
    } catch {
      throw new AppError({
        statusCode: 422,
        errorCode: 'INV_INVALID_MOVEMENT_QUANTITY',
        title: 'Invalid Line Quantity',
        detail: `Quantity "${lineItem.quantity}" is invalid.`,
      });
    }

    if (!lineQty.isPositive()) {
      throw new AppError({
        statusCode: 422,
        errorCode: 'INV_INVALID_MOVEMENT_QUANTITY',
        title: 'Invalid Line Quantity',
        detail: `Line item quantity must be strictly positive (> 0).`,
      });
    }

    const product = await trx.db
      .selectFrom('products')
      .selectAll()
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', lineItem.productId)
      .executeTakeFirst();

    if (!product) {
      throw new AppError({
        statusCode: 404,
        errorCode: 'ERR_NOT_FOUND',
        title: 'Product Not Found',
        detail: `Product "${lineItem.productId}" was not found.`,
      });
    }

    if (product.status !== 'ACTIVE') {
      throw new AppError({
        statusCode: 409,
        errorCode: 'INV_PRODUCT_ARCHIVED',
        title: 'Product Archived',
        detail: `Product "${product.sku}" is archived and cannot be sold.`,
      });
    }

    const uomCode = (lineItem.uomCode ?? product.base_uom).trim().toUpperCase();
    let conversionFactorToBase: Quantity | null = null;
    if (uomCode !== product.base_uom) {
      const conv = await trx.db
        .selectFrom('product_unit_conversions')
        .select(['conversion_factor_to_base'])
        .where('tenant_id', '=', trx.tenantId)
        .where('product_id', '=', product.id)
        .where('uom_code', '=', uomCode)
        .executeTakeFirst();

      if (!conv) {
        throw new AppError({
          statusCode: 400,
          errorCode: 'CAT_INVALID_UOM_CONVERSION',
          title: 'Unsupported UoM',
          detail: `Unit of measure "${uomCode}" is not configured for product "${product.sku}".`,
        });
      }

      conversionFactorToBase = Quantity.fromDecimalString(
        conv.conversion_factor_to_base,
      );
    }

    // Money calculation
    let unitPriceMoney = Money.fromDecimalString(
      product.selling_price,
      currencyCode,
    );

    if (conversionFactorToBase) {
      unitPriceMoney = unitPriceMoney.multiplyByQuantity(conversionFactorToBase);
    }

    let lineDiscountMoney = Money.zero(currencyCode);
    if (lineItem.discountAmount) {
      lineDiscountMoney = Money.fromDecimalString(
        lineItem.discountAmount,
        currencyCode,
      );
      if (lineDiscountMoney.isNegative()) {
        throw new AppError({
          statusCode: 400,
          errorCode: 'ERR_VALIDATION_FAILED',
          title: 'Invalid Line Discount',
          detail: 'Line discount cannot be negative.',
        });
      }
    }

    let lineTaxRules: Array<{
      taxRateId: string;
      name: string;
      ratePercentage: string;
      isCompound: boolean;
    }> = [];

    if (product.tax_group_id) {
      const taxRates = await trx.db
        .selectFrom('tax_rates')
        .selectAll()
        .where('tenant_id', '=', trx.tenantId)
        .where('tax_group_id', '=', product.tax_group_id)
        .where('is_active', '=', true)
        .orderBy('priority', 'asc')
        .execute();

      lineTaxRules = taxRates.map((r) => ({
        taxRateId: r.id,
        name: r.name,
        ratePercentage: r.rate_percentage,
        isCompound: r.is_compound,
      }));
    }

    let lineCalc;
    try {
      lineCalc = calculateLinePricingAndTax({
        unitPrice: unitPriceMoney,
        quantity: lineQty,
        lineDiscount: lineDiscountMoney,
        isTaxInclusive: false,
        taxRules: lineTaxRules,
      });
    } catch (err: unknown) {
      throw new AppError({
        statusCode: 400,
        errorCode: 'ERR_VALIDATION_FAILED',
        title: 'Line Price Calculation Error',
        detail: (err as Error).message,
      });
    }

    subtotalAccumulator = subtotalAccumulator.add(lineCalc.grossLineAmount);
    totalLineDiscounts = totalLineDiscounts.add(lineCalc.discountAmount);
    totalTaxes = totalTaxes.add(lineCalc.totalTaxAmount);

    processedLines.push({
      lineNumber,
      productId: product.id,
      sku: product.sku,
      productName: product.name,
      uomCode,
      quantity: lineQty,
      unitPrice: unitPriceMoney,
      discountAmount: lineCalc.discountAmount,
      taxAmount: lineCalc.totalTaxAmount,
      lineTotal: lineCalc.lineTotalWithTax,
      trackInventory: product.track_inventory,
      unitCostSnapshot: product.purchase_cost,
    });
  }

  // Order level discount
  let orderDiscountMoney = Money.zero(currencyCode);
  if (input.orderDiscountAmount) {
    orderDiscountMoney = Money.fromDecimalString(
      input.orderDiscountAmount,
      currencyCode,
    );
    if (orderDiscountMoney.isNegative()) {
      throw new AppError({
        statusCode: 400,
        errorCode: 'ERR_VALIDATION_FAILED',
        title: 'Negative Order Discount Forbidden',
        detail: 'Order discount cannot be negative.',
      });
    }

    // Require OWNER or ADMIN for order-level discounts
    const userRole = await trx.db
      .selectFrom('member_role_assignments')
      .innerJoin('roles', (join) =>
        join
          .onRef('member_role_assignments.tenant_id', '=', 'roles.tenant_id')
          .onRef('member_role_assignments.role_id', '=', 'roles.id'),
      )
      .select(['roles.code'])
      .where('member_role_assignments.tenant_id', '=', trx.tenantId)
      .where('member_role_assignments.membership_id', '=', trx.userId)
      .execute();

    const isPrivileged = userRole.some(
      (r) => r.code === 'OWNER' || r.code === 'ADMIN',
    );
    if (!isPrivileged) {
      throw new AppError({
        statusCode: 403,
        errorCode: 'POS_UNAUTHORIZED_DISCOUNT',
        title: 'Unauthorized Order Discount',
        detail: 'Cashiers are not permitted to apply arbitrary order discounts without supervisor authorization.',
      });
    }
  }

  const totalDiscountMoney = totalLineDiscounts.add(orderDiscountMoney);
  const netSubtotalMoney = subtotalAccumulator.subtract(totalDiscountMoney);
  const grandTotalMoney = netSubtotalMoney.add(totalTaxes);

  // Validate Payments
  if (input.payments.length === 0) {
    throw new AppError({
      statusCode: 422,
      errorCode: 'POS_INSUFFICIENT_PAYMENT',
      title: 'Payment Required',
      detail: 'At least one payment method is required to complete the sale.',
    });
  }

  let totalPaidMoney = Money.zero(currencyCode);
  let totalTenderedMoney = Money.zero(currencyCode);
  let totalChangeGivenMoney = Money.zero(currencyCode);

  for (const pay of input.payments) {
    const payAmount = Money.fromDecimalString(pay.amount, currencyCode);
    const payTendered = Money.fromDecimalString(pay.tenderedAmount, currencyCode);

    if (!payAmount.isPositive()) {
      throw new AppError({
        statusCode: 400,
        errorCode: 'ERR_VALIDATION_FAILED',
        title: 'Invalid Payment Amount',
        detail: 'Payment amount must be strictly positive.',
      });
    }

    if (pay.paymentMethod === 'CASH') {
      if (payTendered.compare(payAmount) < 0) {
        throw new AppError({
          statusCode: 422,
          errorCode: 'POS_INSUFFICIENT_PAYMENT',
          title: 'Insufficient Cash Tendered',
          detail: `Tendered amount "${payTendered.toDecimalString()}" is less than payment amount "${payAmount.toDecimalString()}".`,
        });
      }
      const changeDue = payTendered.subtract(payAmount);
      totalChangeGivenMoney = totalChangeGivenMoney.add(changeDue);
    } else {
      // CARD or OTHER: tendered must equal amount
      if (!payTendered.equals(payAmount)) {
        throw new AppError({
          statusCode: 400,
          errorCode: 'ERR_VALIDATION_FAILED',
          title: 'Non-Cash Tender Mismatch',
          detail: 'For non-cash payments, tendered amount must equal the payment amount.',
        });
      }
    }

    totalPaidMoney = totalPaidMoney.add(payAmount);
    totalTenderedMoney = totalTenderedMoney.add(payTendered);
  }

  if (totalPaidMoney.compare(grandTotalMoney) < 0) {
    throw new AppError({
      statusCode: 422,
      errorCode: 'POS_INSUFFICIENT_PAYMENT',
      title: 'Insufficient Total Payment',
      detail: `Total paid "${totalPaidMoney.toDecimalString()}" is less than grand total "${grandTotalMoney.toDecimalString()}".`,
    });
  }

  // 5. ATOMIC INVENTORY DEDUCTIONS
  // For each trackable product, deduct stock via the established immutable ledger
  for (const line of processedLines) {
    if (line.trackInventory) {
      const deductionQtyStr = `-${line.quantity.toDecimalString()}`;
      const lineMoveIdempotencyKey = generateUuidV7();

      await postStockMovement(
        trx,
        lineMoveIdempotencyKey,
        {
          branchId: register.branch_id,
          warehouseId: register.warehouse_id,
          productId: line.productId,
          movementType: 'STOCK_OUT',
          quantity: deductionQtyStr,
          uomCode: line.uomCode,
          unitCost: line.unitCostSnapshot,
          referenceType: 'POS_SALE',
          referenceId: saleId,
          allowNegativeStockOverride: input.allowNegativeStockOverride ?? false,
          overrideReason: input.overrideReason ?? null,
        },
        { skipPermissionCheck: true },
      );
    }
  }

  // 6. INSERT SALE HEADER
  const invoiceRow = await trx.db
    .insertInto('sales_invoices')
    .values({
      id: saleId,
      tenant_id: trx.tenantId,
      branch_id: register.branch_id,
      warehouse_id: register.warehouse_id,
      register_id: register.id,
      shift_id: input.shiftId ?? null,
      customer_id: null,
      cashier_user_id: trx.userId,
      invoice_number: invoiceNumber,
      status: 'COMPLETED',
      currency_code: currencyCode,
      exchange_rate_to_base: '1.00000000',
      subtotal_amount: subtotalAccumulator.toDecimalString(),
      discount_amount: totalDiscountMoney.toDecimalString(),
      tax_amount: totalTaxes.toDecimalString(),
      rounding_adjustment: '0.0000',
      grand_total: grandTotalMoney.toDecimalString(),
      total_paid: totalPaidMoney.toDecimalString(),
      change_given: totalChangeGivenMoney.toDecimalString(),
      customer_name: input.customerName?.trim() || null,
      notes: input.notes?.trim() || null,
      voided_at: null,
      void_reason: null,
      voided_by_user_id: null,
      idempotency_key: idempotencyKey,
      metadata_json: JSON.stringify({ traceId: trx.tenantContext.traceId }),
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  // 7. INSERT IMMUTABLE LINE SNAPSHOTS
  const lineResponses: Array<{
    id: string;
    lineNumber: number;
    productId: string;
    sku: string;
    productName: string;
    uomCode: string;
    quantity: string;
    unitPrice: string;
    discountAmount: string;
    taxAmount: string;
    lineTotal: string;
  }> = [];

  for (const line of processedLines) {
    const lineId = generateUuidV7();
    await trx.db
      .insertInto('sales_invoice_lines')
      .values({
        id: lineId,
        tenant_id: trx.tenantId,
        invoice_id: saleId,
        line_number: line.lineNumber,
        product_id: line.productId,
        sku: line.sku,
        product_name: line.productName,
        uom_code: line.uomCode,
        quantity: line.quantity.toDecimalString(),
        unit_price: line.unitPrice.toDecimalString(),
        discount_amount: line.discountAmount.toDecimalString(),
        tax_amount: line.taxAmount.toDecimalString(),
        line_total: line.lineTotal.toDecimalString(),
        tax_rate_snapshot: JSON.stringify({}),
        unit_cost_snapshot: line.unitCostSnapshot,
      })
      .execute();

    lineResponses.push({
      id: lineId,
      lineNumber: line.lineNumber,
      productId: line.productId,
      sku: line.sku,
      productName: line.productName,
      uomCode: line.uomCode,
      quantity: line.quantity.toDecimalString(),
      unitPrice: line.unitPrice.toDecimalString(),
      discountAmount: line.discountAmount.toDecimalString(),
      taxAmount: line.taxAmount.toDecimalString(),
      lineTotal: line.lineTotal.toDecimalString(),
    });
  }

  // 8. INSERT PAYMENT RECORDS
  const paymentResponses: Array<{
    id: string;
    paymentMethod: 'CASH' | 'CARD' | 'OTHER';
    amount: string;
    currencyCode: string;
    status: 'COMPLETED' | 'VOIDED';
    tenderedAmount: string;
    changeAmount: string;
    cardReference: string | null;
    cardLastFour: string | null;
    createdAt: string;
  }> = [];

  for (const pay of input.payments) {
    const paymentId = generateUuidV7();
    const payAmountMoney = Money.fromDecimalString(pay.amount, currencyCode);
    const payTenderedMoney = Money.fromDecimalString(pay.tenderedAmount, currencyCode);
    const changeDueMoney =
      pay.paymentMethod === 'CASH'
        ? payTenderedMoney.subtract(payAmountMoney)
        : Money.zero(currencyCode);

    const payRow = await trx.db
      .insertInto('sales_payments')
      .values({
        id: paymentId,
        tenant_id: trx.tenantId,
        invoice_id: saleId,
        payment_method: pay.paymentMethod,
        amount: payAmountMoney.toDecimalString(),
        currency_code: currencyCode,
        status: 'COMPLETED',
        tendered_amount: payTenderedMoney.toDecimalString(),
        change_amount: changeDueMoney.toDecimalString(),
        card_reference: pay.cardReference?.trim() || null,
        card_last_four: pay.cardLastFour?.trim() || null,
        notes: pay.notes?.trim() || null,
        recorded_by_user_id: trx.userId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    paymentResponses.push({
      id: payRow.id,
      paymentMethod: payRow.payment_method,
      amount: Money.fromDecimalString(payRow.amount, currencyCode).toDecimalString(),
      currencyCode: payRow.currency_code,
      status: payRow.status,
      tenderedAmount: Money.fromDecimalString(
        payRow.tendered_amount,
        currencyCode,
      ).toDecimalString(),
      changeAmount: Money.fromDecimalString(
        payRow.change_amount,
        currencyCode,
      ).toDecimalString(),
      cardReference: payRow.card_reference,
      cardLastFour: payRow.card_last_four,
      createdAt: payRow.created_at.toISOString(),
    });
  }

  // 9. AUDIT LOG & OUTBOX EVENT
  await appendAuditLog(trx, {
    action: 'pos:sale:create',
    resourceType: 'sales_invoices',
    resourceId: saleId,
    metadata: {
      invoiceNumber,
      grandTotal: grandTotalMoney.toDecimalString(),
      lineCount: processedLines.length,
    },
  });

  await enqueueOutboxEvent(trx, {
    eventType: 'PosSaleCompletedEvent',
    aggregateType: 'sales_invoices',
    aggregateId: saleId,
    payload: {
      invoiceId: saleId,
      invoiceNumber,
      grandTotal: grandTotalMoney.toDecimalString(),
      cashierUserId: trx.userId,
    },
  });

  return {
    id: invoiceRow.id,
    invoiceNumber: invoiceRow.invoice_number,
    status: invoiceRow.status,
    branchId: invoiceRow.branch_id,
    warehouseId: invoiceRow.warehouse_id,
    registerId: invoiceRow.register_id,
    shiftId: invoiceRow.shift_id,
    cashierUserId: invoiceRow.cashier_user_id,
    customerName: invoiceRow.customer_name,
    currencyCode: invoiceRow.currency_code,
    subtotalAmount: Money.fromDecimalString(
      invoiceRow.subtotal_amount,
      currencyCode,
    ).toDecimalString(),
    discountAmount: Money.fromDecimalString(
      invoiceRow.discount_amount,
      currencyCode,
    ).toDecimalString(),
    taxAmount: Money.fromDecimalString(
      invoiceRow.tax_amount,
      currencyCode,
    ).toDecimalString(),
    roundingAdjustment: Money.fromDecimalString(
      invoiceRow.rounding_adjustment,
      currencyCode,
    ).toDecimalString(),
    grandTotal: Money.fromDecimalString(
      invoiceRow.grand_total,
      currencyCode,
    ).toDecimalString(),
    totalPaid: Money.fromDecimalString(
      invoiceRow.total_paid,
      currencyCode,
    ).toDecimalString(),
    changeGiven: Money.fromDecimalString(
      invoiceRow.change_given,
      currencyCode,
    ).toDecimalString(),
    createdAt: invoiceRow.created_at.toISOString(),
    voidedAt: invoiceRow.voided_at
      ? (invoiceRow.voided_at as Date).toISOString()
      : null,
    voidReason: invoiceRow.void_reason,
    lines: lineResponses,
    payments: paymentResponses,
  };
}

// ============================================================================
// 5. SALE VOID & COMPENSATING RESTOCK
// ============================================================================

export async function voidSale(
  trx: TenantTransactionContext,
  saleId: string,
  input: VoidSaleRequest,
): Promise<SalesInvoiceResponse> {
  await assertSubscriptionEntitlement(trx, { requireWriteAccess: true });

  const sale = await trx.db
    .selectFrom('sales_invoices')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', saleId)
    .forUpdate()
    .executeTakeFirst();

  if (!sale) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'POS_SALE_NOT_FOUND',
      title: 'Sale Not Found',
      detail: `Sales invoice "${saleId}" was not found.`,
    });
  }

  if (sale.status === 'VOIDED') {
    throw new AppError({
      statusCode: 409,
      errorCode: 'POS_SALE_ALREADY_VOIDED',
      title: 'Sale Already Voided',
      detail: `Sales invoice "${sale.invoice_number}" is already voided.`,
    });
  }

  await assertAuthorized(trx, {
    permission: 'pos:sale:void',
    branchId: sale.branch_id,
    warehouseId: sale.warehouse_id,
  });

  const lines = await trx.db
    .selectFrom('sales_invoice_lines')
    .innerJoin('products', (join) =>
      join
        .onRef('sales_invoice_lines.tenant_id', '=', 'products.tenant_id')
        .onRef('sales_invoice_lines.product_id', '=', 'products.id'),
    )
    .select([
      'sales_invoice_lines.id',
      'sales_invoice_lines.line_number',
      'sales_invoice_lines.product_id',
      'sales_invoice_lines.sku',
      'sales_invoice_lines.product_name',
      'sales_invoice_lines.uom_code',
      'sales_invoice_lines.quantity',
      'sales_invoice_lines.unit_price',
      'sales_invoice_lines.discount_amount',
      'sales_invoice_lines.tax_amount',
      'sales_invoice_lines.line_total',
      'sales_invoice_lines.unit_cost_snapshot',
      'products.track_inventory',
    ])
    .where('sales_invoice_lines.tenant_id', '=', trx.tenantId)
    .where('sales_invoice_lines.invoice_id', '=', saleId)
    .orderBy('sales_invoice_lines.line_number', 'asc')
    .execute();

  // Restock each trackable line item via CUSTOMER_RETURN_RESTOCK
  for (const line of lines) {
    if (line.track_inventory) {
      const restockIdempotencyKey = generateUuidV7();
      await postStockMovement(
        trx,
        restockIdempotencyKey,
        {
          branchId: sale.branch_id,
          warehouseId: sale.warehouse_id,
          productId: line.product_id,
          movementType: 'CUSTOMER_RETURN_RESTOCK',
          quantity: line.quantity,
          uomCode: line.uom_code,
          unitCost: line.unit_cost_snapshot,
          referenceType: 'POS_SALE_VOID',
          referenceId: saleId,
          reason: `Void invoice ${sale.invoice_number}: ${input.reason}`,
        },
        { skipPermissionCheck: true },
      );
    }
  }

  const voidDate = new Date();
  const updatedSale = await trx.db
    .updateTable('sales_invoices')
    .set({
      status: 'VOIDED',
      voided_at: voidDate,
      void_reason: input.reason.trim(),
      voided_by_user_id: trx.userId,
    })
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', saleId)
    .returningAll()
    .executeTakeFirstOrThrow();

  await trx.db
    .updateTable('sales_payments')
    .set({ status: 'VOIDED' })
    .where('tenant_id', '=', trx.tenantId)
    .where('invoice_id', '=', saleId)
    .execute();

  const payments = await trx.db
    .selectFrom('sales_payments')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('invoice_id', '=', saleId)
    .execute();

  await appendAuditLog(trx, {
    action: 'pos:sale:void',
    resourceType: 'sales_invoices',
    resourceId: saleId,
    metadata: {
      invoiceNumber: sale.invoice_number,
      reason: input.reason,
    },
  });

  return {
    id: updatedSale.id,
    invoiceNumber: updatedSale.invoice_number,
    status: updatedSale.status,
    branchId: updatedSale.branch_id,
    warehouseId: updatedSale.warehouse_id,
    registerId: updatedSale.register_id,
    shiftId: updatedSale.shift_id,
    cashierUserId: updatedSale.cashier_user_id,
    customerName: updatedSale.customer_name,
    currencyCode: updatedSale.currency_code,
    subtotalAmount: Money.fromDecimalString(
      updatedSale.subtotal_amount,
      updatedSale.currency_code,
    ).toDecimalString(),
    discountAmount: Money.fromDecimalString(
      updatedSale.discount_amount,
      updatedSale.currency_code,
    ).toDecimalString(),
    taxAmount: Money.fromDecimalString(
      updatedSale.tax_amount,
      updatedSale.currency_code,
    ).toDecimalString(),
    roundingAdjustment: Money.fromDecimalString(
      updatedSale.rounding_adjustment,
      updatedSale.currency_code,
    ).toDecimalString(),
    grandTotal: Money.fromDecimalString(
      updatedSale.grand_total,
      updatedSale.currency_code,
    ).toDecimalString(),
    totalPaid: Money.fromDecimalString(
      updatedSale.total_paid,
      updatedSale.currency_code,
    ).toDecimalString(),
    changeGiven: Money.fromDecimalString(
      updatedSale.change_given,
      updatedSale.currency_code,
    ).toDecimalString(),
    createdAt: updatedSale.created_at.toISOString(),
    voidedAt: updatedSale.voided_at
      ? (updatedSale.voided_at as Date).toISOString()
      : null,
    voidReason: updatedSale.void_reason,
    lines: lines.map((l) => ({
      id: l.id,
      lineNumber: l.line_number,
      productId: l.product_id,
      sku: l.sku,
      productName: l.product_name,
      uomCode: l.uom_code,
      quantity: l.quantity,
      unitPrice: Money.fromDecimalString(
        l.unit_price,
        updatedSale.currency_code,
      ).toDecimalString(),
      discountAmount: Money.fromDecimalString(
        l.discount_amount,
        updatedSale.currency_code,
      ).toDecimalString(),
      taxAmount: Money.fromDecimalString(
        l.tax_amount,
        updatedSale.currency_code,
      ).toDecimalString(),
      lineTotal: Money.fromDecimalString(
        l.line_total,
        updatedSale.currency_code,
      ).toDecimalString(),
    })),
    payments: payments.map((p) => ({
      id: p.id,
      paymentMethod: p.payment_method,
      amount: Money.fromDecimalString(
        p.amount,
        updatedSale.currency_code,
      ).toDecimalString(),
      currencyCode: p.currency_code,
      status: p.status,
      tenderedAmount: Money.fromDecimalString(
        p.tendered_amount,
        updatedSale.currency_code,
      ).toDecimalString(),
      changeAmount: Money.fromDecimalString(
        p.change_amount,
        updatedSale.currency_code,
      ).toDecimalString(),
      cardReference: p.card_reference,
      cardLastFour: p.card_last_four,
      createdAt: p.created_at.toISOString(),
    })),
  };
}

// ============================================================================
// 6. SALE DETAIL & SALES HISTORY
// ============================================================================

export async function getSaleById(
  trx: TenantTransactionContext,
  saleId: string,
): Promise<SalesInvoiceResponse> {
  const sale = await trx.db
    .selectFrom('sales_invoices')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', saleId)
    .executeTakeFirst();

  if (!sale) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'POS_SALE_NOT_FOUND',
      title: 'Sale Not Found',
      detail: `Sales invoice "${saleId}" was not found.`,
    });
  }

  await assertAuthorized(trx, {
    permission: 'pos:sale:read',
    branchId: sale.branch_id,
    warehouseId: sale.warehouse_id,
  });

  const lines = await trx.db
    .selectFrom('sales_invoice_lines')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('invoice_id', '=', saleId)
    .orderBy('line_number', 'asc')
    .execute();

  const payments = await trx.db
    .selectFrom('sales_payments')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('invoice_id', '=', saleId)
    .execute();

  return {
    id: sale.id,
    invoiceNumber: sale.invoice_number,
    status: sale.status,
    branchId: sale.branch_id,
    warehouseId: sale.warehouse_id,
    registerId: sale.register_id,
    shiftId: sale.shift_id,
    cashierUserId: sale.cashier_user_id,
    customerName: sale.customer_name,
    currencyCode: sale.currency_code,
    subtotalAmount: Money.fromDecimalString(
      sale.subtotal_amount,
      sale.currency_code,
    ).toDecimalString(),
    discountAmount: Money.fromDecimalString(
      sale.discount_amount,
      sale.currency_code,
    ).toDecimalString(),
    taxAmount: Money.fromDecimalString(
      sale.tax_amount,
      sale.currency_code,
    ).toDecimalString(),
    roundingAdjustment: Money.fromDecimalString(
      sale.rounding_adjustment,
      sale.currency_code,
    ).toDecimalString(),
    grandTotal: Money.fromDecimalString(
      sale.grand_total,
      sale.currency_code,
    ).toDecimalString(),
    totalPaid: Money.fromDecimalString(
      sale.total_paid,
      sale.currency_code,
    ).toDecimalString(),
    changeGiven: Money.fromDecimalString(
      sale.change_given,
      sale.currency_code,
    ).toDecimalString(),
    createdAt: sale.created_at.toISOString(),
    voidedAt: sale.voided_at ? (sale.voided_at as Date).toISOString() : null,
    voidReason: sale.void_reason,
    lines: lines.map((l) => ({
      id: l.id,
      lineNumber: l.line_number,
      productId: l.product_id,
      sku: l.sku,
      productName: l.product_name,
      uomCode: l.uom_code,
      quantity: l.quantity,
      unitPrice: Money.fromDecimalString(
        l.unit_price,
        sale.currency_code,
      ).toDecimalString(),
      discountAmount: Money.fromDecimalString(
        l.discount_amount,
        sale.currency_code,
      ).toDecimalString(),
      taxAmount: Money.fromDecimalString(
        l.tax_amount,
        sale.currency_code,
      ).toDecimalString(),
      lineTotal: Money.fromDecimalString(
        l.line_total,
        sale.currency_code,
      ).toDecimalString(),
    })),
    payments: payments.map((p) => ({
      id: p.id,
      paymentMethod: p.payment_method,
      amount: Money.fromDecimalString(
        p.amount,
        sale.currency_code,
      ).toDecimalString(),
      currencyCode: p.currency_code,
      status: p.status,
      tenderedAmount: Money.fromDecimalString(
        p.tendered_amount,
        sale.currency_code,
      ).toDecimalString(),
      changeAmount: Money.fromDecimalString(
        p.change_amount,
        sale.currency_code,
      ).toDecimalString(),
      cardReference: p.card_reference,
      cardLastFour: p.card_last_four,
      createdAt: p.created_at.toISOString(),
    })),
  };
}

export async function listSales(
  trx: TenantTransactionContext,
  query: ListSalesQuery,
): Promise<SalesInvoiceResponse[]> {
  await assertAuthorized(trx, {
    permission: 'pos:sale:read',
  });

  const limit = Math.min(Math.max(Number(query.limit ?? 25), 1), 100);

  let dbQuery = trx.db
    .selectFrom('sales_invoices')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId);

  if (query.registerId) {
    dbQuery = dbQuery.where('register_id', '=', query.registerId);
  }

  if (query.status) {
    dbQuery = dbQuery.where('status', '=', query.status);
  }

  if (query.startDate) {
    dbQuery = dbQuery.where('created_at', '>=', new Date(query.startDate));
  }

  if (query.endDate) {
    dbQuery = dbQuery.where('created_at', '<=', new Date(query.endDate));
  }

  const sales = await dbQuery
    .orderBy('created_at', 'desc')
    .limit(limit)
    .execute();

  if (sales.length === 0) {
    return [];
  }

  const saleIds = sales.map((s) => s.id);
  const allLines = await trx.db
    .selectFrom('sales_invoice_lines')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('invoice_id', 'in', saleIds)
    .orderBy('line_number', 'asc')
    .execute();

  const allPayments = await trx.db
    .selectFrom('sales_payments')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('invoice_id', 'in', saleIds)
    .execute();

  const linesByInvoice = new Map<string, typeof allLines>();
  for (const l of allLines) {
    const list = linesByInvoice.get(l.invoice_id) ?? [];
    list.push(l);
    linesByInvoice.set(l.invoice_id, list);
  }

  const paymentsByInvoice = new Map<string, typeof allPayments>();
  for (const p of allPayments) {
    const list = paymentsByInvoice.get(p.invoice_id) ?? [];
    list.push(p);
    paymentsByInvoice.set(p.invoice_id, list);
  }

  return sales.map((sale) => {
    const lines = linesByInvoice.get(sale.id) ?? [];
    const payments = paymentsByInvoice.get(sale.id) ?? [];

    return {
      id: sale.id,
      invoiceNumber: sale.invoice_number,
      status: sale.status,
      branchId: sale.branch_id,
      warehouseId: sale.warehouse_id,
      registerId: sale.register_id,
      shiftId: sale.shift_id,
      cashierUserId: sale.cashier_user_id,
      customerName: sale.customer_name,
      currencyCode: sale.currency_code,
      subtotalAmount: Money.fromDecimalString(
        sale.subtotal_amount,
        sale.currency_code,
      ).toDecimalString(),
      discountAmount: Money.fromDecimalString(
        sale.discount_amount,
        sale.currency_code,
      ).toDecimalString(),
      taxAmount: Money.fromDecimalString(
        sale.tax_amount,
        sale.currency_code,
      ).toDecimalString(),
      roundingAdjustment: Money.fromDecimalString(
        sale.rounding_adjustment,
        sale.currency_code,
      ).toDecimalString(),
      grandTotal: Money.fromDecimalString(
        sale.grand_total,
        sale.currency_code,
      ).toDecimalString(),
      totalPaid: Money.fromDecimalString(
        sale.total_paid,
        sale.currency_code,
      ).toDecimalString(),
      changeGiven: Money.fromDecimalString(
        sale.change_given,
        sale.currency_code,
      ).toDecimalString(),
      createdAt: sale.created_at.toISOString(),
      voidedAt: sale.voided_at ? (sale.voided_at as Date).toISOString() : null,
      voidReason: sale.void_reason,
      lines: lines.map((l) => ({
        id: l.id,
        lineNumber: l.line_number,
        productId: l.product_id,
        sku: l.sku,
        productName: l.product_name,
        uomCode: l.uom_code,
        quantity: l.quantity,
        unitPrice: Money.fromDecimalString(
          l.unit_price,
          sale.currency_code,
        ).toDecimalString(),
        discountAmount: Money.fromDecimalString(
          l.discount_amount,
          sale.currency_code,
        ).toDecimalString(),
        taxAmount: Money.fromDecimalString(
          l.tax_amount,
          sale.currency_code,
        ).toDecimalString(),
        lineTotal: Money.fromDecimalString(
          l.line_total,
          sale.currency_code,
        ).toDecimalString(),
      })),
      payments: payments.map((p) => ({
        id: p.id,
        paymentMethod: p.payment_method,
        amount: Money.fromDecimalString(
          p.amount,
          sale.currency_code,
        ).toDecimalString(),
        currencyCode: p.currency_code,
        status: p.status,
        tenderedAmount: Money.fromDecimalString(
          p.tendered_amount,
          sale.currency_code,
        ).toDecimalString(),
        changeAmount: Money.fromDecimalString(
          p.change_amount,
          sale.currency_code,
        ).toDecimalString(),
        cardReference: p.card_reference,
        cardLastFour: p.card_last_four,
        createdAt: p.created_at.toISOString(),
      })),
    };
  });
}

// ============================================================================
// 7. PRINTABLE RECEIPT DATA GENERATION
// ============================================================================

export async function getReceiptData(
  trx: TenantTransactionContext,
  saleId: string,
): Promise<ReceiptResponse> {
  const sale = await trx.db
    .selectFrom('sales_invoices')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', saleId)
    .executeTakeFirst();

  if (!sale) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'POS_SALE_NOT_FOUND',
      title: 'Sale Not Found',
      detail: `Sales invoice "${saleId}" was not found.`,
    });
  }

  await assertAuthorized(trx, {
    permission: 'pos:sale:read',
    branchId: sale.branch_id,
    warehouseId: sale.warehouse_id,
  });

  const tenant = await trx.db
    .selectFrom('tenants')
    .select(['legal_name'])
    .where('id', '=', trx.tenantId)
    .executeTakeFirstOrThrow();

  const branch = await trx.db
    .selectFrom('branches')
    .select(['name'])
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', sale.branch_id)
    .executeTakeFirstOrThrow();

  const register = await trx.db
    .selectFrom('pos_registers')
    .select(['code'])
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', sale.register_id)
    .executeTakeFirstOrThrow();

  const cashier = await trx.db
    .selectFrom('users')
    .select(['full_name'])
    .where('id', '=', sale.cashier_user_id)
    .executeTakeFirstOrThrow();

  const localization = await trx.db
    .selectFrom('tenant_localization_settings')
    .select(['timezone', 'locale'])
    .where('tenant_id', '=', trx.tenantId)
    .executeTakeFirst();

  const lines = await trx.db
    .selectFrom('sales_invoice_lines')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('invoice_id', '=', saleId)
    .orderBy('line_number', 'asc')
    .execute();

  const payments = await trx.db
    .selectFrom('sales_payments')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('invoice_id', '=', saleId)
    .execute();

  return formatReceiptData({
    businessName: tenant.legal_name,
    branchName: branch.name,
    registerCode: register.code,
    invoiceNumber: sale.invoice_number,
    cashierName: cashier.full_name,
    createdAt: sale.created_at,
    timezone: localization?.timezone,
    locale: localization?.locale,
    currencyCode: sale.currency_code,
    lines: lines.map((l) => ({
      sku: l.sku,
      name: l.product_name,
      quantity: l.quantity,
      uomCode: l.uom_code,
      unitPrice: Money.fromDecimalString(
        l.unit_price,
        sale.currency_code,
      ).toDecimalString(),
      discountAmount: Money.fromDecimalString(
        l.discount_amount,
        sale.currency_code,
      ).toDecimalString(),
      taxAmount: Money.fromDecimalString(
        l.tax_amount,
        sale.currency_code,
      ).toDecimalString(),
      lineTotal: Money.fromDecimalString(
        l.line_total,
        sale.currency_code,
      ).toDecimalString(),
    })),
    subtotalAmount: Money.fromDecimalString(
      sale.subtotal_amount,
      sale.currency_code,
    ).toDecimalString(),
    discountAmount: Money.fromDecimalString(
      sale.discount_amount,
      sale.currency_code,
    ).toDecimalString(),
    taxAmount: Money.fromDecimalString(
      sale.tax_amount,
      sale.currency_code,
    ).toDecimalString(),
    grandTotal: Money.fromDecimalString(
      sale.grand_total,
      sale.currency_code,
    ).toDecimalString(),
    payments: payments.map((p) => ({
      method: p.payment_method,
      amount: Money.fromDecimalString(
        p.amount,
        sale.currency_code,
      ).toDecimalString(),
      tenderedAmount: Money.fromDecimalString(
        p.tendered_amount,
        sale.currency_code,
      ).toDecimalString(),
      changeAmount: Money.fromDecimalString(
        p.change_amount,
        sale.currency_code,
      ).toDecimalString(),
    })),
    changeGiven: Money.fromDecimalString(
      sale.change_given,
      sale.currency_code,
    ).toDecimalString(),
    notes: sale.notes,
  });
}

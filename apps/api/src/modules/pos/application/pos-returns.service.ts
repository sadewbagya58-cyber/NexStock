import crypto from 'node:crypto';
import type {
  CreatePosReturnRequest,
  PosReturnLineResponse,
  PosReturnResponse,
} from '@nexstock/contracts';
import {
  Money,
  QUANTITY_SCALE_FACTOR,
  Quantity,
  UomConversionError,
  convertQuantityBetweenUoms,
  divideAndRoundBigInt,
} from '@nexstock/domain-core';
import { resolveProductForInventory } from '../../cat/index.js';
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

function generateReturnNumber(): string {
  const stamp = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  const rand = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `RTN-${stamp}-${rand}`;
}

export async function createPosReturn(
  trx: TenantTransactionContext,
  idempotencyKey: string,
  saleId: string,
  input: CreatePosReturnRequest,
): Promise<PosReturnResponse> {
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

  await assertAuthorized(trx, {
    permission: 'pos:sale:return',
    branchId: sale.branch_id,
    warehouseId: sale.warehouse_id,
  });
  await assertSubscriptionEntitlement(trx, { requireWriteAccess: true });

  if (sale.status !== 'COMPLETED') {
    throw new AppError({
      statusCode: 409,
      errorCode: 'POS_SALE_ALREADY_VOIDED',
      title: 'Cannot Return Non-Completed Sale',
      detail: `Sales invoice "${sale.invoice_number}" has status "${sale.status}" and cannot be returned.`,
    });
  }

  const invoiceLines = await trx.db
    .selectFrom('sales_invoice_lines')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('invoice_id', '=', saleId)
    .execute();

  const invLineMap = new Map(invoiceLines.map((l) => [l.id, l]));

  // Aggregate prior returned base quantities per invoice_line_id to enforce cumulative limit
  const existingReturnRows = await trx.db
    .selectFrom('pos_return_lines')
    .innerJoin('pos_returns', (join) =>
      join
        .onRef('pos_return_lines.tenant_id', '=', 'pos_returns.tenant_id')
        .onRef('pos_return_lines.pos_return_id', '=', 'pos_returns.id'),
    )
    .select([
      'pos_return_lines.invoice_line_id as invoice_line_id',
      'pos_return_lines.normalized_base_qty as normalized_base_qty',
    ])
    .where('pos_return_lines.tenant_id', '=', trx.tenantId)
    .where('pos_returns.invoice_id', '=', saleId)
    .execute();

  const returnedBaseByLine = new Map<string, Quantity>();
  for (const r of existingReturnRows) {
    const prev = returnedBaseByLine.get(r.invoice_line_id) ?? Quantity.zero();
    returnedBaseByLine.set(
      r.invoice_line_id,
      prev.add(Quantity.fromDecimalString(String(r.normalized_base_qty))),
    );
  }

  const currencyCode = sale.currency_code;
  const posReturnId = generateUuidV7();
  const returnNumber = generateReturnNumber();
  const now = new Date();
  const reason = input.reason.trim();

  // Prepare & validate every return line before inserting parent/children
  const preparedLines: Array<{
    invoiceLine: (typeof invoiceLines)[number];
    returnUom: string;
    returnQty: Quantity;
    conversionFactorToBase: string;
    normalizedBaseQty: Quantity;
    restockCondition: 'RESELLABLE' | 'DAMAGED';
    unitPrice: Money;
    refundAmount: Money;
    trackInventory: boolean;
  }> = [];

  let totalRefund = Money.zero(currencyCode);

  for (const lineInput of input.lines) {
    const invLine = invLineMap.get(lineInput.invoiceLineId);
    if (!invLine) {
      throw new AppError({
        statusCode: 404,
        errorCode: 'ERR_NOT_FOUND',
        title: 'Invoice Line Not Found',
        detail: `Invoice line "${lineInput.invoiceLineId}" was not found on invoice "${sale.invoice_number}".`,
      });
    }

    const returnQty = Quantity.fromDecimalString(lineInput.returnQty);
    if (!returnQty.isPositive()) {
      throw new AppError({
        statusCode: 400,
        errorCode: 'ERR_VALIDATION_FAILED',
        title: 'Invalid Return Quantity',
        detail: 'Return quantity must be greater than zero.',
      });
    }

    const product = await resolveProductForInventory(trx, invLine.product_id);
    const returnUom = (lineInput.returnUom ?? invLine.uom_code)
      .trim()
      .toUpperCase();

    const customConversions = [...product.unitConversions.entries()].map(
      ([uomCode, conversionFactorToBase]) => ({ uomCode, conversionFactorToBase }),
    );

    let conv: {
      convertedQuantity: Quantity;
      factorDecimal6: string;
    };
    try {
      conv = convertQuantityBetweenUoms({
        quantity: returnQty.toDecimalString(),
        fromUom: returnUom,
        toUom: product.baseUom,
        productBaseUom: product.baseUom,
        customConversions,
        densityGPerMl: product.densityGPerMl,
      });
    } catch (err) {
      if (err instanceof UomConversionError) {
        throw new AppError({
          statusCode: 400,
          errorCode: 'CAT_INVALID_UOM_CONVERSION',
          title: 'Incompatible Return UoM',
          detail: err.message,
        });
      }
      throw err;
    }

    // Also compute sold quantity in base UoM cleanly (handles both legacy rows and Phase 3 snapshots)
    let soldBaseQty: Quantity;
    if (invLine.normalized_base_qty) {
      soldBaseQty = Quantity.fromDecimalString(String(invLine.normalized_base_qty));
    } else {
      const fallbackConv = convertQuantityBetweenUoms({
        quantity: String(invLine.quantity),
        fromUom: invLine.uom_code,
        toUom: product.baseUom,
        productBaseUom: product.baseUom,
        customConversions,
        densityGPerMl: product.densityGPerMl,
      });
      soldBaseQty = fallbackConv.convertedQuantity;
    }

    const alreadyReturned = returnedBaseByLine.get(invLine.id) ?? Quantity.zero();
    const newCumulativeReturned = alreadyReturned.add(conv.convertedQuantity);
    if (newCumulativeReturned.compare(soldBaseQty) > 0) {
      throw new AppError({
        statusCode: 409,
        errorCode: 'POS_RETURN_EXCEEDS_SOLD_QTY',
        title: 'Return Quantity Exceeds Remaining Returnable Balance',
        detail: `Line "${invLine.product_name}" sold ${soldBaseQty.toDecimalString()} ${product.baseUom}, already returned ${alreadyReturned.toDecimalString()}, cannot return additional ${conv.convertedQuantity.toDecimalString()} ${product.baseUom}.`,
      });
    }
    returnedBaseByLine.set(invLine.id, newCumulativeReturned);

    // Prorate exact refund from original invoice line total
    const origLineTotal = Money.fromDecimalString(String(invLine.line_total), currencyCode);
    const refundScaled = divideAndRoundBigInt(
      origLineTotal.scaledUnits * conv.convertedQuantity.microUnits,
      soldBaseQty.microUnits,
      'HALF_EVEN',
    );
    const refundAmount = Money.fromScaledUnits(refundScaled, currencyCode).roundToCurrencyMinorUnits('HALF_EVEN');
    const unitPriceScaled = divideAndRoundBigInt(
      refundAmount.scaledUnits * QUANTITY_SCALE_FACTOR,
      returnQty.microUnits,
      'HALF_EVEN',
    );
    const unitPrice = Money.fromScaledUnits(unitPriceScaled, currencyCode);

    totalRefund = totalRefund.add(refundAmount);
    preparedLines.push({
      invoiceLine: invLine,
      returnUom,
      returnQty,
      conversionFactorToBase: conv.factorDecimal6,
      normalizedBaseQty: conv.convertedQuantity,
      restockCondition: lineInput.restockCondition ?? 'RESELLABLE',
      unitPrice,
      refundAmount,
      trackInventory: product.trackInventory,
    });
  }

  await trx.db
    .insertInto('pos_returns')
    .values({
      id: posReturnId,
      tenant_id: trx.tenantId,
      invoice_id: sale.id,
      branch_id: sale.branch_id,
      warehouse_id: sale.warehouse_id,
      return_number: returnNumber,
      reason,
      refund_method: input.refundMethod,
      total_refund_amount: totalRefund.toDecimalString(),
      currency_code: currencyCode,
      created_by_user_id: trx.userId,
      idempotency_key: idempotencyKey,
      created_at: now,
    })
    .execute();

  const responseLines: PosReturnLineResponse[] = [];

  const todayStr = new Date().toISOString().slice(0, 10);

  for (const line of preparedLines) {
    let ledgerEntryId: string | null = null;
    let returnedBatchNumber: string | null = null;

    if (line.invoiceLine.batch_id) {
      const origBatch = await trx.db
        .selectFrom('inventory_batches')
        .select(['id', 'batch_number', 'status', 'expiry_date'])
        .where('tenant_id', '=', trx.tenantId)
        .where('id', '=', line.invoiceLine.batch_id)
        .executeTakeFirst();

      if (origBatch) {
        returnedBatchNumber = origBatch.batch_number;
        const expStr = origBatch.expiry_date
          ? new Date(origBatch.expiry_date).toISOString().slice(0, 10)
          : null;
        const isExpiredBatch =
          origBatch.status === 'EXPIRED' || Boolean(expStr && expStr < todayStr);

        if (isExpiredBatch && line.restockCondition === 'RESELLABLE') {
          throw new AppError({
            statusCode: 409,
            errorCode: 'POS_EXPIRED_BATCH_RESTOCK_BLOCKED',
            title: 'Expired Batch Cannot Be Restocked As Sellable',
            detail: `Batch "${origBatch.batch_number}" is expired${expStr ? ` (expiry: ${expStr})` : ''} and cannot be restocked as RESELLABLE/ACTIVE inventory. Process return with restockCondition='DAMAGED' instead.`,
          });
        }
      }
    }

    if (line.restockCondition === 'RESELLABLE' && line.trackInventory) {
      const ledger = await postStockMovement(
        trx,
        generateUuidV7(),
        {
          branchId: sale.branch_id,
          warehouseId: sale.warehouse_id,
          productId: line.invoiceLine.product_id,
          batchId: line.invoiceLine.batch_id ?? null,
          serialId: line.invoiceLine.serial_id ?? null,
          movementType: 'CUSTOMER_RETURN_RESTOCK',
          uomCode: line.returnUom,
          quantity: line.returnQty.toDecimalString(),
          unitCost: line.invoiceLine.unit_cost_snapshot,
          referenceType: 'POS_RETURN',
          referenceId: posReturnId,
          entrySource: 'CUSTOMER_RETURN',
          reason: `Customer Return ${returnNumber}: ${reason}`,
        },
        { skipPermissionCheck: true },
      );
      ledgerEntryId = ledger.id;
    }

    const retLineId = generateUuidV7();
    await trx.db
      .insertInto('pos_return_lines')
      .values({
        id: retLineId,
        tenant_id: trx.tenantId,
        pos_return_id: posReturnId,
        invoice_line_id: line.invoiceLine.id,
        product_id: line.invoiceLine.product_id,
        batch_id: line.invoiceLine.batch_id ?? null,
        serial_id: line.invoiceLine.serial_id ?? null,
        return_uom: line.returnUom,
        return_qty: line.returnQty.toDecimalString(),
        conversion_factor_to_base: line.conversionFactorToBase,
        normalized_base_qty: line.normalizedBaseQty.toDecimalString(),
        restock_condition: line.restockCondition,
        unit_price: line.unitPrice.toDecimalString(),
        refund_amount: line.refundAmount.toDecimalString(),
        ledger_entry_id: ledgerEntryId,
        created_at: now,
      })
      .execute();

    responseLines.push({
      id: retLineId,
      invoiceLineId: line.invoiceLine.id,
      productId: line.invoiceLine.product_id,
      returnUom: line.returnUom,
      returnQty: line.returnQty.toDecimalString(),
      conversionFactorToBase: line.conversionFactorToBase,
      normalizedBaseQty: line.normalizedBaseQty.toDecimalString(),
      restockCondition: line.restockCondition,
      unitPrice: line.unitPrice.toDecimalString(),
      refundAmount: line.refundAmount.toDecimalString(),
      batchId: line.invoiceLine.batch_id ?? null,
      batchNumber: returnedBatchNumber,
      serialId: line.invoiceLine.serial_id ?? null,
      ledgerEntryId,
    });
  }

  await appendAuditLog(trx, {
    action: 'POS_SALE_RETURN_POSTED',
    resourceType: 'POS_RETURN',
    resourceId: posReturnId,
    metadata: {
      returnNumber,
      invoiceId: sale.id,
      invoiceNumber: sale.invoice_number,
      refundMethod: input.refundMethod,
      totalRefundAmount: totalRefund.toDecimalString(),
      lineCount: responseLines.length,
    },
  });

  await enqueueOutboxEvent(trx, {
    aggregateType: 'POS_RETURN',
    aggregateId: posReturnId,
    eventType: 'POS_RETURN_POSTED',
    payload: {
      posReturnId,
      returnNumber,
      invoiceId: sale.id,
      branchId: sale.branch_id,
      warehouseId: sale.warehouse_id,
    },
  });

  return {
    id: posReturnId,
    tenantId: trx.tenantId,
    invoiceId: sale.id,
    branchId: sale.branch_id,
    warehouseId: sale.warehouse_id,
    returnNumber,
    reason,
    refundMethod: input.refundMethod,
    totalRefundAmount: totalRefund.toDecimalString(),
    currencyCode,
    createdAt: now.toISOString(),
    lines: responseLines,
  };
}

export async function listPosReturnsForSale(
  trx: TenantTransactionContext,
  saleId: string,
): Promise<PosReturnResponse[]> {
  const sale = await trx.db
    .selectFrom('sales_invoices')
    .select(['id', 'branch_id', 'warehouse_id'])
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

  const rows = await trx.db
    .selectFrom('pos_returns')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('invoice_id', '=', saleId)
    .orderBy('created_at', 'desc')
    .execute();

  if (rows.length === 0) return [];

  const returnIds = rows.map((r) => r.id);
  const lineRows = await trx.db
    .selectFrom('pos_return_lines')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('pos_return_id', 'in', returnIds)
    .execute();

  const ccyMap = new Map(rows.map((r) => [r.id, r.currency_code]));
  const linesByRet = new Map<string, PosReturnLineResponse[]>();
  for (const l of lineRows) {
    const ccy = ccyMap.get(l.pos_return_id) ?? 'USD';
    const arr = linesByRet.get(l.pos_return_id) ?? [];
    arr.push({
      id: l.id,
      invoiceLineId: l.invoice_line_id,
      productId: l.product_id,
      returnUom: l.return_uom,
      returnQty: Quantity.fromDecimalString(String(l.return_qty)).toDecimalString(),
      conversionFactorToBase: Quantity.fromDecimalString(
        String(l.conversion_factor_to_base),
      ).toDecimalString(),
      normalizedBaseQty: Quantity.fromDecimalString(
        String(l.normalized_base_qty),
      ).toDecimalString(),
      restockCondition: l.restock_condition,
      unitPrice: Money.fromDecimalString(String(l.unit_price), ccy).toDecimalString(),
      refundAmount: Money.fromDecimalString(String(l.refund_amount), ccy).toDecimalString(),
      batchId: l.batch_id ?? null,
      serialId: l.serial_id ?? null,
      ledgerEntryId: l.ledger_entry_id,
    });
    linesByRet.set(l.pos_return_id, arr);
  }

  return rows.map((r) => ({
    id: r.id,
    tenantId: r.tenant_id,
    invoiceId: r.invoice_id,
    branchId: r.branch_id,
    warehouseId: r.warehouse_id,
    returnNumber: r.return_number,
    reason: r.reason,
    refundMethod: r.refund_method,
    totalRefundAmount: Money.fromDecimalString(
      String(r.total_refund_amount),
      r.currency_code,
    ).toDecimalString(),
    currencyCode: r.currency_code,
    createdAt: new Date(r.created_at).toISOString(),
    lines: linesByRet.get(r.id) ?? [],
  }));
}

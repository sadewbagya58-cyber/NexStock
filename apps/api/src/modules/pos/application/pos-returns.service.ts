import crypto from 'node:crypto';
import type {
  ApplyPosReturnDispositionsRequest,
  CreatePosReturnRequest,
  PosReturnDispositionStatus,
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
import {
  createReturnLinkedWasteLog,
  postStockMovement,
} from '../../inv/index.js';
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

function computeLineDispositionStatus(
  restocked: Quantity,
  wasted: Quantity,
  pending: Quantity,
): PosReturnDispositionStatus {
  if (pending.isPositive()) {
    return restocked.isPositive() || wasted.isPositive()
      ? 'PARTIAL'
      : 'PENDING_INSPECTION';
  }
  if (restocked.isPositive() && wasted.isPositive()) return 'MIXED';
  if (restocked.isPositive()) return 'RESTOCKED';
  if (wasted.isPositive()) return 'WASTED';
  return 'DAMAGED_UNPOSTED';
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

  const preparedLines: Array<{
    invoiceLine: (typeof invoiceLines)[number];
    productName: string;
    productSku: string;
    baseUom: string;
    returnUom: string;
    returnQty: Quantity;
    conversionFactorToBase: string;
    normalizedBaseQty: Quantity;
    restockCondition: 'RESELLABLE' | 'DAMAGED';
    dispositionMode: 'RESTOCK' | 'WASTE' | 'PENDING_INSPECTION' | 'SPLIT';
    restockUomQty: Quantity;
    restockBaseQty: Quantity;
    wasteUomQty: Quantity;
    wasteBaseQty: Quantity;
    pendingBaseQty: Quantity;
    wasteReasonCode: string | null;
    wasteDescription: string | null;
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
    const returnUom = (lineInput.returnUom ?? invLine.uom_code).trim().toUpperCase();
    const customConversions = [...product.unitConversions.entries()].map(
      ([uomCode, conversionFactorToBase]) => ({ uomCode, conversionFactorToBase }),
    );

    const convertQty = (qtyStr: string) =>
      convertQuantityBetweenUoms({
        quantity: qtyStr,
        fromUom: returnUom,
        toUom: product.baseUom,
        productBaseUom: product.baseUom,
        customConversions,
        densityGPerMl: product.densityGPerMl,
      });

    let conv: { convertedQuantity: Quantity; factorDecimal6: string };
    try {
      conv = convertQty(returnQty.toDecimalString());
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

    // Resolve disposition split cleanly without breaking legacy `restockCondition` callers
    const explicitMode = lineInput.dispositionMode;
    const legacyCondition = lineInput.restockCondition ?? 'RESELLABLE';
    let dispositionMode: 'RESTOCK' | 'WASTE' | 'PENDING_INSPECTION' | 'SPLIT' =
      explicitMode ??
      (legacyCondition === 'DAMAGED'
        ? 'WASTE'
        : legacyCondition === 'PENDING_INSPECTION'
          ? 'PENDING_INSPECTION'
          : 'RESTOCK');

    let restockUomQty = Quantity.zero();
    let wasteUomQty = Quantity.zero();
    let restockBaseQty = Quantity.zero();
    let wasteBaseQty = Quantity.zero();
    let pendingBaseQty = Quantity.zero();

    if (lineInput.restockQty !== undefined || lineInput.wasteQty !== undefined) {
      restockUomQty = Quantity.fromDecimalString(lineInput.restockQty ?? '0.000000');
      wasteUomQty = Quantity.fromDecimalString(lineInput.wasteQty ?? '0.000000');
      if (restockUomQty.isNegative() || wasteUomQty.isNegative()) {
        throw new AppError({
          statusCode: 400,
          errorCode: 'ERR_VALIDATION_FAILED',
          title: 'Invalid Disposition Quantities',
          detail: 'Restock and waste quantities cannot be negative.',
        });
      }
      const sumDisposed = restockUomQty.add(wasteUomQty);
      if (sumDisposed.compare(returnQty) > 0) {
        throw new AppError({
          statusCode: 409,
          errorCode: 'POS_RETURN_DISPOSITION_EXCEEDS_QTY',
          title: 'Disposition Exceeds Returned Quantity',
          detail: `Restock (${restockUomQty.toDecimalString()}) + Waste (${wasteUomQty.toDecimalString()}) exceeds returned qty (${returnQty.toDecimalString()}).`,
        });
      }
      restockBaseQty = restockUomQty.isPositive() ? convertQty(restockUomQty.toDecimalString()).convertedQuantity : Quantity.zero();
      wasteBaseQty = wasteUomQty.isPositive() ? convertQty(wasteUomQty.toDecimalString()).convertedQuantity : Quantity.zero();
      pendingBaseQty = conv.convertedQuantity.subtract(restockBaseQty).subtract(wasteBaseQty);
      if (pendingBaseQty.isNegative()) pendingBaseQty = Quantity.zero();
      dispositionMode =
        restockBaseQty.isPositive() && wasteBaseQty.isPositive()
          ? 'SPLIT'
          : wasteBaseQty.isPositive() && !pendingBaseQty.isPositive() && !restockBaseQty.isPositive()
            ? 'WASTE'
            : restockBaseQty.isPositive() && !pendingBaseQty.isPositive() && !wasteBaseQty.isPositive()
              ? 'RESTOCK'
              : pendingBaseQty.equals(conv.convertedQuantity)
                ? 'PENDING_INSPECTION'
                : 'SPLIT';
    } else if (dispositionMode === 'RESTOCK') {
      restockUomQty = returnQty;
      restockBaseQty = conv.convertedQuantity;
    } else if (dispositionMode === 'WASTE') {
      wasteUomQty = returnQty;
      wasteBaseQty = conv.convertedQuantity;
    } else {
      pendingBaseQty = conv.convertedQuantity;
    }

    const effectiveCondition: 'RESELLABLE' | 'DAMAGED' =
      wasteBaseQty.isPositive() && !restockBaseQty.isPositive()
        ? 'DAMAGED'
        : legacyCondition === 'DAMAGED'
          ? 'DAMAGED'
          : 'RESELLABLE';

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
      productName: product.name,
      productSku: product.sku,
      baseUom: product.baseUom,
      returnUom,
      returnQty,
      conversionFactorToBase: conv.factorDecimal6,
      normalizedBaseQty: conv.convertedQuantity,
      restockCondition: effectiveCondition,
      dispositionMode,
      restockUomQty,
      restockBaseQty,
      wasteUomQty,
      wasteBaseQty,
      pendingBaseQty,
      wasteReasonCode: lineInput.wasteReasonCode?.trim() || null,
      wasteDescription: lineInput.wasteDescription?.trim() || null,
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

  const todayStr = new Date().toISOString().slice(0, 10);
  const wasteLineQueue: Array<{
    posReturnLineId: string;
    line: (typeof preparedLines)[number];
  }> = [];
  const lineDraftResults: Array<{
    retLineId: string;
    line: (typeof preparedLines)[number];
    ledgerEntryId: string | null;
    returnedBatchNumber: string | null;
    dispositionStatus: PosReturnDispositionStatus;
  }> = [];

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

        if (isExpiredBatch && line.restockBaseQty.isPositive()) {
          throw new AppError({
            statusCode: 409,
            errorCode: 'POS_EXPIRED_BATCH_RESTOCK_BLOCKED',
            title: 'Expired Batch Cannot Be Restocked As Sellable',
            detail: `Batch "${origBatch.batch_number}" is expired${expStr ? ` (expiry: ${expStr})` : ''} and cannot be restocked as RESELLABLE/ACTIVE inventory. Process return with restockCondition='DAMAGED' or WASTE disposition instead.`,
          });
        }
      }
    }

    if (line.restockBaseQty.isPositive() && line.trackInventory) {
      const ledger = await postStockMovement(
        trx,
        generateUuidV7(),
        {
          branchId: sale.branch_id,
          warehouseId: sale.warehouse_id,
          productId: line.invoiceLine.product_id,
          batchId: line.invoiceLine.batch_id ?? null,
          serialId: line.invoiceLine.serial_id ?? null,
          stockIntakeLotId: line.invoiceLine.stock_intake_lot_id ?? null,
          movementType: 'CUSTOMER_RETURN_RESTOCK',
          uomCode: line.returnUom,
          quantity: line.restockUomQty.toDecimalString(),
          unitCost: line.invoiceLine.unit_cost_snapshot,
          referenceType: 'POS_RETURN',
          referenceId: posReturnId,
          entrySource: 'CUSTOMER_RETURN',
          reason: `Customer Return ${returnNumber}: ${reason}`,
        },
        { skipPermissionCheck: true },
      );
      ledgerEntryId = ledger.id;
    } else if (line.pendingBaseQty.isPositive() && line.invoiceLine.serial_id) {
      // Returned pending inspection: mark serial RETURNED without adding back to qty_on_hand yet
      const ser = await trx.db
        .selectFrom('inventory_serials')
        .select(['id', 'status'])
        .where('tenant_id', '=', trx.tenantId)
        .where('id', '=', line.invoiceLine.serial_id)
        .forUpdate()
        .executeTakeFirst();
      if (ser && ser.status === 'SOLD') {
        await trx.db
          .updateTable('inventory_serials')
          .set({ status: 'RETURNED', updated_at: now })
          .where('tenant_id', '=', trx.tenantId)
          .where('id', '=', ser.id)
          .execute();
        await trx.db
          .insertInto('inventory_serial_transitions')
          .values({
            id: generateUuidV7(),
            tenant_id: trx.tenantId,
            serial_id: ser.id,
            from_status: ser.status,
            to_status: 'RETURNED',
            reference_type: 'POS_RETURN_INSPECTION',
            reference_id: posReturnId,
            actor_user_id: trx.userId,
            notes: `Return ${returnNumber} awaiting inspection`,
            occurred_at: now,
          })
          .execute();
      }
    }

    const dispositionStatus = computeLineDispositionStatus(
      line.restockBaseQty,
      line.wasteBaseQty,
      line.pendingBaseQty,
    );

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
        stock_intake_lot_id: line.invoiceLine.stock_intake_lot_id ?? null,
        return_uom: line.returnUom,
        return_qty: line.returnQty.toDecimalString(),
        conversion_factor_to_base: line.conversionFactorToBase,
        normalized_base_qty: line.normalizedBaseQty.toDecimalString(),
        restock_condition: line.restockCondition,
        unit_price: line.unitPrice.toDecimalString(),
        refund_amount: line.refundAmount.toDecimalString(),
        ledger_entry_id: ledgerEntryId,
        disposition_status: dispositionStatus,
        restocked_base_qty: line.restockBaseQty.toDecimalString(),
        wasted_base_qty: line.wasteBaseQty.toDecimalString(),
        pending_base_qty: line.pendingBaseQty.toDecimalString(),
        waste_log_id: null,
        created_at: now,
      })
      .execute();

    if (line.restockBaseQty.isPositive()) {
      await trx.db
        .insertInto('pos_return_dispositions')
        .values({
          id: generateUuidV7(),
          tenant_id: trx.tenantId,
          pos_return_id: posReturnId,
          pos_return_line_id: retLineId,
          disposition_type: 'RESTOCK',
          quantity: line.restockUomQty.toDecimalString(),
          uom_code: line.returnUom,
          normalized_base_qty: line.restockBaseQty.toDecimalString(),
          from_restocked_stock: false,
          waste_log_id: null,
          ledger_entry_id: ledgerEntryId,
          reason_code: null,
          notes: reason,
          actor_user_id: trx.userId,
          idempotency_key: idempotencyKey,
          created_at: now,
        })
        .execute();
    }

    if (line.wasteBaseQty.isPositive()) {
      wasteLineQueue.push({ posReturnLineId: retLineId, line });
    }

    lineDraftResults.push({
      retLineId,
      line,
      ledgerEntryId,
      returnedBatchNumber,
      dispositionStatus,
    });
  }

  let createdWasteLogId: string | null = null;
  if (wasteLineQueue.length > 0) {
    const firstCustomReason = wasteLineQueue.find((w) => w.line.wasteReasonCode)?.line.wasteReasonCode;
    const firstDesc = wasteLineQueue.find((w) => w.line.wasteDescription)?.line.wasteDescription;
    // All items wasted directly at return time NEVER entered sellable stock (`deductFromOnHand: false`),
    // eliminating any risk of double deduction!
    const wasteLog = await createReturnLinkedWasteLog(trx, {
      branchId: sale.branch_id,
      warehouseId: sale.warehouse_id,
      posReturnId,
      posReturnNumber: returnNumber,
      reasonCode: firstCustomReason ?? 'DAMAGED',
      description: firstDesc ?? `Customer Return ${returnNumber}: ${reason}`,
      currencyCode,
      idempotencyKey: generateUuidV7(),
      lines: wasteLineQueue.map(({ posReturnLineId, line }) => ({
        posReturnLineId,
        salesInvoiceId: sale.id,
        salesInvoiceLineId: line.invoiceLine.id,
        productId: line.invoiceLine.product_id,
        batchId: line.invoiceLine.batch_id ?? null,
        serialId: line.invoiceLine.serial_id ?? null,
        stockIntakeLotId: line.invoiceLine.stock_intake_lot_id ?? null,
        wasteUom: line.returnUom,
        wasteQty: line.wasteUomQty.toDecimalString(),
        conversionFactorToBase: line.conversionFactorToBase,
        normalizedBaseQty: line.wasteBaseQty.toDecimalString(),
        unitCostPerBase: String(line.invoiceLine.unit_cost_snapshot),
        deductFromOnHand: false,
        notes: line.wasteDescription ?? reason,
      })),
    });
    createdWasteLogId = wasteLog.id;

    for (const w of wasteLineQueue) {
      await trx.db
        .updateTable('pos_return_lines')
        .set({ waste_log_id: createdWasteLogId })
        .where('tenant_id', '=', trx.tenantId)
        .where('id', '=', w.posReturnLineId)
        .execute();

      await trx.db
        .insertInto('pos_return_dispositions')
        .values({
          id: generateUuidV7(),
          tenant_id: trx.tenantId,
          pos_return_id: posReturnId,
          pos_return_line_id: w.posReturnLineId,
          disposition_type: 'WASTE',
          quantity: w.line.wasteUomQty.toDecimalString(),
          uom_code: w.line.returnUom,
          normalized_base_qty: w.line.wasteBaseQty.toDecimalString(),
          from_restocked_stock: false,
          waste_log_id: createdWasteLogId,
          ledger_entry_id: null,
          reason_code: wasteLog.reasonCode,
          notes: w.line.wasteDescription ?? reason,
          actor_user_id: trx.userId,
          idempotency_key: idempotencyKey,
          created_at: now,
        })
        .execute();
    }
  }

  const responseLines: PosReturnLineResponse[] = lineDraftResults.map((d) => ({
    id: d.retLineId,
    invoiceLineId: d.line.invoiceLine.id,
    productId: d.line.invoiceLine.product_id,
    productName: d.line.productName,
    productSku: d.line.productSku,
    baseUom: d.line.baseUom,
    returnUom: d.line.returnUom,
    returnQty: d.line.returnQty.toDecimalString(),
    conversionFactorToBase: d.line.conversionFactorToBase,
    normalizedBaseQty: d.line.normalizedBaseQty.toDecimalString(),
    restockCondition: d.line.restockCondition,
    dispositionStatus: d.dispositionStatus,
    restockedBaseQty: d.line.restockBaseQty.toDecimalString(),
    wastedBaseQty: d.line.wasteBaseQty.toDecimalString(),
    pendingBaseQty: d.line.pendingBaseQty.toDecimalString(),
    wasteLogId: d.line.wasteBaseQty.isPositive() ? createdWasteLogId : null,
    unitPrice: d.line.unitPrice.toDecimalString(),
    refundAmount: d.line.refundAmount.toDecimalString(),
    batchId: d.line.invoiceLine.batch_id ?? null,
    batchNumber: d.returnedBatchNumber,
    serialId: d.line.invoiceLine.serial_id ?? null,
    ledgerEntryId: d.ledgerEntryId,
  }));

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
      linkedWasteLogId: createdWasteLogId,
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
      linkedWasteLogId: createdWasteLogId,
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
    ...(createdWasteLogId ? { wasteLogIds: [createdWasteLogId] } : { wasteLogIds: [] }),
  };
}

/**
 * Resolves partial/pending return dispositions OR converts previously restocked return units
 * into confirmed Waste Log records without double-deducting inventory.
 */
export async function applyPosReturnDispositions(
  trx: TenantTransactionContext,
  idempotencyKey: string,
  returnId: string,
  input: ApplyPosReturnDispositionsRequest,
): Promise<PosReturnResponse> {
  const retRow = await trx.db
    .selectFrom('pos_returns')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', returnId)
    .executeTakeFirst();

  if (!retRow) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'POS_RETURN_NOT_FOUND',
      title: 'Customer Return Not Found',
      detail: `Customer return "${returnId}" was not found.`,
    });
  }

  await assertAuthorized(trx, {
    permission: 'pos:sale:return',
    branchId: retRow.branch_id,
    warehouseId: retRow.warehouse_id,
  });
  await assertSubscriptionEntitlement(trx, { requireWriteAccess: true });

  const retLineRows = await trx.db
    .selectFrom('pos_return_lines')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('pos_return_id', '=', returnId)
    .forUpdate()
    .execute();
  const retLineMap = new Map(retLineRows.map((l) => [l.id, l]));

  const invLineRows = await trx.db
    .selectFrom('sales_invoice_lines')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('invoice_id', '=', retRow.invoice_id)
    .execute();
  const invLineMap = new Map(invLineRows.map((l) => [l.id, l]));

  const now = new Date();
  const pendingWasteFromUnrestocked: Array<{
    posReturnLineId: string;
    salesInvoiceId: string;
    salesInvoiceLineId: string;
    productId: string;
    batchId: string | null;
    serialId: string | null;
    stockIntakeLotId: string | null;
    wasteUom: string;
    wasteQty: string;
    conversionFactorToBase: string;
    normalizedBaseQty: string;
    unitCostPerBase: string;
    deductFromOnHand: boolean;
    reasonCode: string | null;
    notes: string | null;
  }> = [];
  const wasteFromAlreadyRestocked: typeof pendingWasteFromUnrestocked = [];

  for (const item of input.dispositions) {
    const retLine = retLineMap.get(item.posReturnLineId);
    if (!retLine) {
      throw new AppError({
        statusCode: 404,
        errorCode: 'ERR_NOT_FOUND',
        title: 'Return Line Not Found',
        detail: `Return line "${item.posReturnLineId}" was not found on return "${retRow.return_number}".`,
      });
    }
    const invLine = invLineMap.get(retLine.invoice_line_id);
    if (!invLine) {
      throw new AppError({
        statusCode: 404,
        errorCode: 'ERR_NOT_FOUND',
        title: 'Source Invoice Line Not Found',
        detail: `Invoice line "${retLine.invoice_line_id}" was not found.`,
      });
    }

    const product = await resolveProductForInventory(trx, retLine.product_id);
    const uomCode = (item.uomCode?.trim() || retLine.return_uom).toUpperCase();
    const customConversions = [...product.unitConversions.entries()].map(
      ([c, conversionFactorToBase]) => ({ uomCode: c, conversionFactorToBase }),
    );
    const convertUom = (qtyStr: string) =>
      convertQuantityBetweenUoms({
        quantity: qtyStr,
        fromUom: uomCode,
        toUom: product.baseUom,
        productBaseUom: product.baseUom,
        customConversions,
        densityGPerMl: product.densityGPerMl,
      });

    const reqRestock = Quantity.fromDecimalString(item.restockQty ?? '0.000000');
    const reqWaste = Quantity.fromDecimalString(item.wasteQty ?? '0.000000');
    if (reqRestock.isNegative() || reqWaste.isNegative() || (!reqRestock.isPositive() && !reqWaste.isPositive())) {
      throw new AppError({
        statusCode: 400,
        errorCode: 'ERR_VALIDATION_FAILED',
        title: 'Invalid Disposition Request',
        detail: 'Provide a strictly positive restockQty or wasteQty.',
      });
    }

    const restockConv = reqRestock.isPositive() ? convertUom(reqRestock.toDecimalString()) : { convertedQuantity: Quantity.zero(), factorDecimal6: retLine.conversion_factor_to_base };
    const wasteConv = reqWaste.isPositive() ? convertUom(reqWaste.toDecimalString()) : { convertedQuantity: Quantity.zero(), factorDecimal6: retLine.conversion_factor_to_base };

    let curRestocked = Quantity.fromDecimalString(String(retLine.restocked_base_qty ?? '0'));
    let curWasted = Quantity.fromDecimalString(String(retLine.wasted_base_qty ?? '0'));
    let curPending = Quantity.fromDecimalString(String(retLine.pending_base_qty ?? '0'));

    if (restockConv.convertedQuantity.compare(curPending) > 0) {
      throw new AppError({
        statusCode: 409,
        errorCode: 'POS_RETURN_DISPOSITION_EXCEEDS_PENDING',
        title: 'Restock Exceeds Pending Inspection Quantity',
        detail: `Only ${curPending.toDecimalString()} ${product.baseUom} remaining pending on return line "${product.sku}".`,
      });
    }

    // 1. Apply RESTOCK from pending inspection pool -> adds to sellable qty_on_hand
    let restockLedgerId: string | null = null;
    if (restockConv.convertedQuantity.isPositive()) {
      if (retLine.batch_id) {
        const b = await trx.db
          .selectFrom('inventory_batches')
          .select(['status', 'expiry_date', 'batch_number'])
          .where('tenant_id', '=', trx.tenantId)
          .where('id', '=', retLine.batch_id)
          .executeTakeFirst();
        const today = new Date().toISOString().slice(0, 10);
        const expStr = b?.expiry_date ? new Date(b.expiry_date).toISOString().slice(0, 10) : null;
        if (b && (b.status === 'EXPIRED' || (expStr && expStr < today))) {
          throw new AppError({
            statusCode: 409,
            errorCode: 'POS_EXPIRED_BATCH_RESTOCK_BLOCKED',
            title: 'Expired Batch Cannot Be Restocked',
            detail: `Batch "${b.batch_number}" is expired and must be disposed as WASTE.`,
          });
        }
      }
      if (product.trackInventory) {
        const ledger = await postStockMovement(
          trx,
          generateUuidV7(),
          {
            branchId: retRow.branch_id,
            warehouseId: retRow.warehouse_id,
            productId: retLine.product_id,
            batchId: retLine.batch_id ?? null,
            serialId: retLine.serial_id ?? null,
            stockIntakeLotId: retLine.stock_intake_lot_id ?? null,
            movementType: 'CUSTOMER_RETURN_RESTOCK',
            uomCode,
            quantity: reqRestock.toDecimalString(),
            unitCost: invLine.unit_cost_snapshot,
            referenceType: 'POS_RETURN',
            referenceId: retRow.id,
            entrySource: 'CUSTOMER_RETURN',
            reason: `Return ${retRow.return_number} inspection RESTOCK`,
          },
          { skipPermissionCheck: true },
        );
        restockLedgerId = ledger.id;
      }

      curRestocked = curRestocked.add(restockConv.convertedQuantity);
      curPending = curPending.subtract(restockConv.convertedQuantity);

      await trx.db
        .insertInto('pos_return_dispositions')
        .values({
          id: generateUuidV7(),
          tenant_id: trx.tenantId,
          pos_return_id: retRow.id,
          pos_return_line_id: retLine.id,
          disposition_type: 'RESTOCK',
          quantity: reqRestock.toDecimalString(),
          uom_code: uomCode,
          normalized_base_qty: restockConv.convertedQuantity.toDecimalString(),
          from_restocked_stock: false,
          waste_log_id: null,
          ledger_entry_id: restockLedgerId,
          reason_code: null,
          notes: item.notes?.trim() ?? null,
          actor_user_id: trx.userId,
          idempotency_key: idempotencyKey,
          created_at: now,
        })
        .execute();
    }

    // 2. Apply WASTE: first consume remaining `curPending` (deductFromOnHand = false),
    // then any remainder from previously restocked `curRestocked` (deductFromOnHand = true -> WASTE_OUT!).
    if (wasteConv.convertedQuantity.isPositive()) {
      const maxWasteable = curPending.add(curRestocked);
      if (wasteConv.convertedQuantity.compare(maxWasteable) > 0) {
        throw new AppError({
          statusCode: 409,
          errorCode: 'POS_RETURN_DISPOSITION_EXCEEDS_QTY',
          title: 'Waste Exceeds Available Return Quantity',
          detail: `Maximum wasteable balance on this return line is ${maxWasteable.toDecimalString()} ${product.baseUom}.`,
        });
      }

      const fromPendingBase =
        wasteConv.convertedQuantity.compare(curPending) <= 0
          ? wasteConv.convertedQuantity
          : curPending;
      const fromRestockedBase = wasteConv.convertedQuantity.subtract(fromPendingBase);

      if (fromPendingBase.isPositive()) {
        curPending = curPending.subtract(fromPendingBase);
        curWasted = curWasted.add(fromPendingBase);
        pendingWasteFromUnrestocked.push({
          posReturnLineId: retLine.id,
          salesInvoiceId: retRow.invoice_id,
          salesInvoiceLineId: invLine.id,
          productId: retLine.product_id,
          batchId: retLine.batch_id ?? null,
          serialId: retLine.serial_id ?? null,
          stockIntakeLotId: retLine.stock_intake_lot_id ?? null,
          wasteUom: product.baseUom,
          wasteQty: fromPendingBase.toDecimalString(),
          conversionFactorToBase: '1.000000',
          normalizedBaseQty: fromPendingBase.toDecimalString(),
          unitCostPerBase: String(invLine.unit_cost_snapshot),
          deductFromOnHand: false,
          reasonCode: item.wasteReasonCode?.trim() ?? null,
          notes: item.wasteDescription?.trim() ?? item.notes?.trim() ?? null,
        });
      }

      if (fromRestockedBase.isPositive()) {
        curRestocked = curRestocked.subtract(fromRestockedBase);
        curWasted = curWasted.add(fromRestockedBase);
        wasteFromAlreadyRestocked.push({
          posReturnLineId: retLine.id,
          salesInvoiceId: retRow.invoice_id,
          salesInvoiceLineId: invLine.id,
          productId: retLine.product_id,
          batchId: retLine.batch_id ?? null,
          serialId: retLine.serial_id ?? null,
          stockIntakeLotId: retLine.stock_intake_lot_id ?? null,
          wasteUom: product.baseUom,
          wasteQty: fromRestockedBase.toDecimalString(),
          conversionFactorToBase: '1.000000',
          normalizedBaseQty: fromRestockedBase.toDecimalString(),
          unitCostPerBase: String(invLine.unit_cost_snapshot),
          deductFromOnHand: true,
          reasonCode: item.wasteReasonCode?.trim() ?? null,
          notes: item.wasteDescription?.trim() ?? item.notes?.trim() ?? null,
        });
      }
    }

    const nextStatus = computeLineDispositionStatus(curRestocked, curWasted, curPending);
    await trx.db
      .updateTable('pos_return_lines')
      .set({
        restocked_base_qty: curRestocked.toDecimalString(),
        wasted_base_qty: curWasted.toDecimalString(),
        pending_base_qty: curPending.toDecimalString(),
        disposition_status: nextStatus,
        ...(restockLedgerId ? { ledger_entry_id: restockLedgerId } : {}),
      })
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', retLine.id)
      .execute();

    // Sync local map in case same line appears twice in payload
    retLine.restocked_base_qty = curRestocked.toDecimalString();
    retLine.wasted_base_qty = curWasted.toDecimalString();
    retLine.pending_base_qty = curPending.toDecimalString();
  }

  const allWasteEntries = [...pendingWasteFromUnrestocked, ...wasteFromAlreadyRestocked];
  if (allWasteEntries.length > 0) {
    const firstReason = allWasteEntries.find((w) => w.reasonCode)?.reasonCode;
    const firstNote = allWasteEntries.find((w) => w.notes)?.notes;
    const wl = await createReturnLinkedWasteLog(trx, {
      branchId: retRow.branch_id,
      warehouseId: retRow.warehouse_id,
      posReturnId: retRow.id,
      posReturnNumber: retRow.return_number,
      reasonCode: firstReason ?? 'DAMAGED',
      description: firstNote ?? `Return ${retRow.return_number} inspection waste`,
      currencyCode: retRow.currency_code,
      idempotencyKey: generateUuidV7(),
      lines: allWasteEntries,
    });

    for (const w of allWasteEntries) {
      const matchedLine = wl.lines.find((wlLine) => wlLine.posReturnLineId === w.posReturnLineId);
      await trx.db
        .updateTable('pos_return_lines')
        .set({ waste_log_id: wl.id })
        .where('tenant_id', '=', trx.tenantId)
        .where('id', '=', w.posReturnLineId)
        .execute();

      await trx.db
        .insertInto('pos_return_dispositions')
        .values({
          id: generateUuidV7(),
          tenant_id: trx.tenantId,
          pos_return_id: retRow.id,
          pos_return_line_id: w.posReturnLineId,
          disposition_type: 'WASTE',
          quantity: w.wasteQty,
          uom_code: w.wasteUom,
          normalized_base_qty: w.normalizedBaseQty,
          from_restocked_stock: w.deductFromOnHand,
          waste_log_id: wl.id,
          ledger_entry_id: matchedLine?.ledgerEntryId ?? null,
          reason_code: wl.reasonCode,
          notes: w.notes,
          actor_user_id: trx.userId,
          idempotency_key: idempotencyKey,
          created_at: now,
        })
        .execute();
    }
  }

  await appendAuditLog(trx, {
    action: 'POS_RETURN_DISPOSITION_APPLIED',
    resourceType: 'POS_RETURN',
    resourceId: retRow.id,
    metadata: {
      returnNumber: retRow.return_number,
      dispositionCount: input.dispositions.length,
    },
  });

  const refreshed = await listPosReturnsForSale(trx, retRow.invoice_id);
  return refreshed.find((r) => r.id === retRow.id)!;
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
    .leftJoin('products', (join) =>
      join
        .onRef('pos_return_lines.tenant_id', '=', 'products.tenant_id')
        .onRef('pos_return_lines.product_id', '=', 'products.id'),
    )
    .leftJoin('inventory_batches', (join) =>
      join
        .onRef('pos_return_lines.tenant_id', '=', 'inventory_batches.tenant_id')
        .onRef('pos_return_lines.batch_id', '=', 'inventory_batches.id'),
    )
    .select([
      'pos_return_lines.id',
      'pos_return_lines.pos_return_id',
      'pos_return_lines.invoice_line_id',
      'pos_return_lines.product_id',
      'products.name as product_name',
      'products.sku as product_sku',
      'products.base_uom as base_uom',
      'pos_return_lines.return_uom',
      'pos_return_lines.return_qty',
      'pos_return_lines.conversion_factor_to_base',
      'pos_return_lines.normalized_base_qty',
      'pos_return_lines.restock_condition',
      'pos_return_lines.disposition_status',
      'pos_return_lines.restocked_base_qty',
      'pos_return_lines.wasted_base_qty',
      'pos_return_lines.pending_base_qty',
      'pos_return_lines.waste_log_id',
      'pos_return_lines.unit_price',
      'pos_return_lines.refund_amount',
      'pos_return_lines.batch_id',
      'inventory_batches.batch_number',
      'pos_return_lines.serial_id',
      'pos_return_lines.ledger_entry_id',
    ])
    .where('pos_return_lines.tenant_id', '=', trx.tenantId)
    .where('pos_return_lines.pos_return_id', 'in', returnIds)
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
      ...(l.product_name ? { productName: l.product_name } : {}),
      ...(l.product_sku ? { productSku: l.product_sku } : {}),
      ...(l.base_uom ? { baseUom: l.base_uom } : {}),
      returnUom: l.return_uom,
      returnQty: Quantity.fromDecimalString(String(l.return_qty)).toDecimalString(),
      conversionFactorToBase: Quantity.fromDecimalString(
        String(l.conversion_factor_to_base),
      ).toDecimalString(),
      normalizedBaseQty: Quantity.fromDecimalString(
        String(l.normalized_base_qty),
      ).toDecimalString(),
      restockCondition: l.restock_condition,
      dispositionStatus: (l.disposition_status ?? (l.restock_condition === 'RESELLABLE' ? 'RESTOCKED' : 'DAMAGED_UNPOSTED')) as PosReturnDispositionStatus,
      restockedBaseQty: Quantity.fromDecimalString(String(l.restocked_base_qty ?? '0')).toDecimalString(),
      wastedBaseQty: Quantity.fromDecimalString(String(l.wasted_base_qty ?? '0')).toDecimalString(),
      pendingBaseQty: Quantity.fromDecimalString(String(l.pending_base_qty ?? '0')).toDecimalString(),
      wasteLogId: l.waste_log_id ?? null,
      unitPrice: Money.fromDecimalString(String(l.unit_price), ccy).toDecimalString(),
      refundAmount: Money.fromDecimalString(String(l.refund_amount), ccy).toDecimalString(),
      batchId: l.batch_id ?? null,
      batchNumber: l.batch_number ?? null,
      serialId: l.serial_id ?? null,
      ledgerEntryId: l.ledger_entry_id,
    });
    linesByRet.set(l.pos_return_id, arr);
  }

  return rows.map((r) => {
    const rLines = linesByRet.get(r.id) ?? [];
    const wIds = Array.from(
      new Set(
        rLines
          .map((rl) => rl.wasteLogId)
          .filter((x): x is string => typeof x === 'string' && x.length > 0),
      ),
    );
    return {
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
      lines: rLines,
      wasteLogIds: wIds,
    };
  });
}

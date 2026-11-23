import { randomUUID } from 'node:crypto';
import type {
  OfflineDataFreshness,
  OfflineDeviceContext,
  OfflineLocalInvoice,
  SyncCatalogPricingResponse,
} from '@nexstock/contracts';
import {
  calculateLinePricingAndTax,
  Money,
  Quantity,
  type TaxRuleInput,
} from '@nexstock/domain-core';
import {
  assertOfflineSecurityAndCapability,
  OfflineEngineError,
} from './capability-policy.js';
import type {
  OfflineBarcodeLookupResult,
  OfflineCartLineInput,
  OfflineCartTotalsSummary,
  OfflineCashCheckoutInput,
  OfflineCategoryRecord,
  OfflineCompletedSaleResult,
  OfflineComputedCartLine,
  OfflineCustomerRecord,
  OfflineDraftCartRecord,
  OfflineOutboxCommandRecord,
  OfflineProductRecord,
  OfflineStoragePort,
} from './types.js';

export class OfflinePosEngine {
  constructor(
    private readonly storage: OfflineStoragePort,
    private readonly currencyCodeFallback = 'LKR',
  ) {}

  async bindDeviceSession(ctx: OfflineDeviceContext): Promise<void> {
    await this.storage.saveDeviceContext(ctx);
  }

  async ingestServerSnapshot(params: {
    readonly tenantId: string;
    readonly branchId: string;
    readonly snapshot: SyncCatalogPricingResponse;
  }): Promise<{ savedProducts: number; savedCustomers: number; savedBatches: number; syncedAt: string }> {
    const devCtx = await this.storage.getDeviceContext();
    assertOfflineSecurityAndCapability({
      operation: 'POS_SEARCH_CATALOG',
      isOnline: true,
      deviceContext: devCtx,
      tenantId: params.tenantId,
      branchId: params.branchId,
      requiredPermission: 'pos:sale:create',
    });

    if (params.snapshot.tenantId !== params.tenantId) {
      throw new OfflineEngineError(
        'OFFLINE_TENANT_ISOLATION_DENIED',
        'Snapshot tenantId does not match bound tenant context.',
        403,
      );
    }

    return this.storage.saveSyncSnapshot(params);
  }

  async getDataFreshness(params: {
    readonly tenantId: string;
    readonly branchId: string;
    readonly isOnline: boolean;
    readonly staleAfterMinutes?: number;
  }): Promise<OfflineDataFreshness> {
    const devCtx = await this.storage.getDeviceContext();
    assertOfflineSecurityAndCapability({
      operation: 'POS_SEARCH_CATALOG',
      isOnline: params.isOnline,
      deviceContext: devCtx,
      tenantId: params.tenantId,
      branchId: params.branchId,
    });
    return this.storage.getDataFreshness(params);
  }

  async listCategories(params: {
    readonly tenantId: string;
    readonly branchId: string;
    readonly isOnline: boolean;
  }): Promise<readonly OfflineCategoryRecord[]> {
    const devCtx = await this.storage.getDeviceContext();
    assertOfflineSecurityAndCapability({
      operation: 'POS_SEARCH_CATALOG',
      isOnline: params.isOnline,
      deviceContext: devCtx,
      tenantId: params.tenantId,
      branchId: params.branchId,
    });
    return this.storage.listCategories(params.tenantId);
  }

  async searchProducts(params: {
    readonly tenantId: string;
    readonly branchId: string;
    readonly warehouseId: string;
    readonly query?: string;
    readonly categoryId?: string | null;
    readonly limit?: number;
    readonly isOnline: boolean;
  }): Promise<readonly OfflineProductRecord[]> {
    const devCtx = await this.storage.getDeviceContext();
    assertOfflineSecurityAndCapability({
      operation: 'POS_SEARCH_CATALOG',
      isOnline: params.isOnline,
      deviceContext: devCtx,
      tenantId: params.tenantId,
      branchId: params.branchId,
      requiredPermission: 'pos:sale:create',
    });
    return this.storage.searchProducts(params);
  }

  async scanBarcode(params: {
    readonly tenantId: string;
    readonly branchId: string;
    readonly warehouseId: string;
    readonly code: string;
    readonly isOnline: boolean;
  }): Promise<OfflineBarcodeLookupResult> {
    const devCtx = await this.storage.getDeviceContext();
    assertOfflineSecurityAndCapability({
      operation: 'POS_SCAN_BARCODE',
      isOnline: params.isOnline,
      deviceContext: devCtx,
      tenantId: params.tenantId,
      branchId: params.branchId,
      requiredPermission: 'pos:sale:create',
    });
    return this.storage.resolveBarcode(params);
  }

  async listCustomers(params: {
    readonly tenantId: string;
    readonly branchId: string;
    readonly query?: string;
    readonly limit?: number;
    readonly isOnline: boolean;
  }): Promise<readonly OfflineCustomerRecord[]> {
    const devCtx = await this.storage.getDeviceContext();
    assertOfflineSecurityAndCapability({
      operation: 'POS_CART_MANAGE',
      isOnline: params.isOnline,
      deviceContext: devCtx,
      tenantId: params.tenantId,
      branchId: params.branchId,
      requiredPermission: 'pos:sale:create',
    });
    return this.storage.listCustomers(params);
  }

  async calculateCart(params: {
    readonly tenantId: string;
    readonly branchId: string;
    readonly warehouseId: string;
    readonly currencyCode?: string;
    readonly lines: readonly OfflineCartLineInput[];
    readonly isOnline: boolean;
  }): Promise<OfflineCartTotalsSummary> {
    const devCtx = await this.storage.getDeviceContext();
    assertOfflineSecurityAndCapability({
      operation: 'POS_CART_MANAGE',
      isOnline: params.isOnline,
      deviceContext: devCtx,
      tenantId: params.tenantId,
      branchId: params.branchId,
      requiredPermission: 'pos:sale:create',
    });

    const currencyCode = params.currencyCode ?? this.currencyCodeFallback;
    let subtotal = Money.zero(currencyCode);
    let totalDiscount = Money.zero(currencyCode);
    let totalTax = Money.zero(currencyCode);
    let grandTotal = Money.zero(currencyCode);
    const computedLines: OfflineComputedCartLine[] = [];

    for (let i = 0; i < params.lines.length; i++) {
      const lineInput = params.lines[i]!;
      const prod = await this.storage.getProductById({
        tenantId: params.tenantId,
        branchId: params.branchId,
        warehouseId: params.warehouseId,
        productId: lineInput.productId,
      });
      if (!prod) {
        throw new OfflineEngineError(
          'OFFLINE_PRODUCT_NOT_FOUND',
          `Product "${lineInput.productId}" is not available in local offline catalog.`,
          404,
        );
      }

      const enteredQty = Quantity.fromDecimalString(lineInput.quantity);
      if (!enteredQty.isPositive()) {
        throw new OfflineEngineError(
          'OFFLINE_INVALID_QUANTITY',
          `Quantity must be greater than zero for "${prod.name}".`,
          400,
        );
      }

      const uomCode = (lineInput.uomCode ?? prod.baseUom).toUpperCase();
      let convFactor = Quantity.fromInteger(1);
      let explicitPackagePrice: string | null = null;
      if (uomCode !== prod.baseUom.toUpperCase()) {
        const convs = await this.storage.getProductUnitConversions({
          tenantId: params.tenantId,
          productId: prod.id,
        });
        const matchConv = convs.find((c) => c.uomCode.toUpperCase() === uomCode);
        if (!matchConv) {
          throw new OfflineEngineError(
            'OFFLINE_INVALID_UOM',
            `Unit "${uomCode}" is not configured for "${prod.name}".`,
            400,
          );
        }
        convFactor = Quantity.fromDecimalString(matchConv.conversionFactorToBase);
        explicitPackagePrice = matchConv.sellingPrice ?? null;
      }

      const baseQty =
        uomCode === prod.baseUom.toUpperCase()
          ? enteredQty
          : enteredQty.convertUsingFactor(convFactor.toDecimalString());

      // Batch selection & costing resolution (preserve FEFO/FIFO & batch pricing)
      let selectedBatchId: string | null = lineInput.batchId ?? null;
      let selectedBatchNumber: string | null = null;
      let resolvedUnitPriceStr = prod.effectivePrice;
      let resolvedUnitCostStr = prod.movingAvgCost || prod.purchaseCost;

      if (prod.trackingMode === 'BATCH' || prod.trackingMode === 'BATCH_EXPIRY') {
        const batches = await this.storage.listBatchesForProduct({
          tenantId: params.tenantId,
          warehouseId: params.warehouseId,
          productId: prod.id,
        });
        const todayIso = new Date().toISOString().slice(0, 10);
        const eligible = batches
          .filter(
            (b) =>
              b.status === 'ACTIVE' &&
              (!b.expiryDate || b.expiryDate >= todayIso) &&
              Quantity.fromDecimalString(b.availableQuantity).isPositive(),
          )
          .sort((a, b) => {
            if (prod.allocationPolicy === 'FIFO') {
              return a.receivedDate.localeCompare(b.receivedDate);
            }
            const ea = a.expiryDate ?? '9999-12-31';
            const eb = b.expiryDate ?? '9999-12-31';
            if (ea !== eb) return ea.localeCompare(eb);
            return a.receivedDate.localeCompare(b.receivedDate);
          });

        const chosen = selectedBatchId
          ? batches.find((b) => b.batchId === selectedBatchId)
          : eligible[0];

        if (!chosen) {
          throw new OfflineEngineError(
            'OFFLINE_BATCH_UNAVAILABLE',
            `No active non-expired batch available offline for "${prod.name}".`,
            422,
          );
        }
        if (chosen.expiryDate && chosen.expiryDate < todayIso) {
          throw new OfflineEngineError(
            'OFFLINE_BATCH_EXPIRED',
            `Batch "${chosen.batchNumber}" for "${prod.name}" is expired (${chosen.expiryDate}) and cannot be sold.`,
            422,
          );
        }

        selectedBatchId = chosen.batchId;
        selectedBatchNumber = chosen.batchNumber;
        resolvedUnitCostStr = chosen.unitCost;
        if (chosen.batchPricingMode === 'EXPLICIT' && chosen.sellingPrice) {
          resolvedUnitPriceStr = chosen.sellingPrice;
        }
      }

      let isPricePerSellingUom = false;
      if (lineInput.overrideSellingPrice) {
        resolvedUnitPriceStr = lineInput.overrideSellingPrice;
        isPricePerSellingUom = uomCode !== prod.baseUom.toUpperCase();
      } else if (explicitPackagePrice) {
        resolvedUnitPriceStr = explicitPackagePrice;
        isPricePerSellingUom = true;
      }

      const unitPrice = Money.fromDecimalString(resolvedUnitPriceStr, currencyCode);
      const lineDisc = lineInput.lineDiscount
        ? Money.fromDecimalString(lineInput.lineDiscount, currencyCode)
        : Money.zero(currencyCode);

      // Price floor & max discount validation using synchronized approved policy
      if (prod.minSellingPrice) {
        const minPrice = Money.fromDecimalString(prod.minSellingPrice, currencyCode);
        const effectiveMin = isPricePerSellingUom
          ? minPrice.multiplyByQuantity(convFactor)
          : minPrice;
        if (unitPrice.compare(effectiveMin) < 0) {
          throw new OfflineEngineError(
            'OFFLINE_PRICE_BELOW_MIN',
            `Unit price for "${prod.name}" cannot be below approved minimum (${effectiveMin.toDecimalString()}).`,
            422,
          );
        }
      }

      const rawTaxRates = prod.taxGroupId
        ? await this.storage.getTaxRatesForGroup({
            tenantId: params.tenantId,
            taxGroupId: prod.taxGroupId,
          })
        : [];
      const taxRules: TaxRuleInput[] = rawTaxRates.map((tr) => ({
        taxRateId: tr.id,
        name: tr.name,
        ratePercentage: tr.ratePercentage,
        isCompound: tr.isCompound,
      }));

      // Note: convert price per base UoM cleanly when UoM differs from priceUom
      const lineCalc = calculateLinePricingAndTax({
        unitPrice,
        quantity: isPricePerSellingUom ? enteredQty : baseQty,
        lineDiscount: lineDisc,
        isTaxInclusive: false,
        taxRules,
      });

      if (prod.maxDiscountPct && lineCalc.grossLineAmount.isPositive()) {
        const maxPctNum = Number.parseFloat(prod.maxDiscountPct);
        const appliedPct =
          (Number.parseFloat(lineCalc.discountAmount.toDecimalString()) /
            Number.parseFloat(lineCalc.grossLineAmount.toDecimalString())) *
          100;
        if (Number.isFinite(maxPctNum) && appliedPct > maxPctNum + 0.01) {
          throw new OfflineEngineError(
            'OFFLINE_DISCOUNT_EXCEEDS_MAX',
            `Discount (${appliedPct.toFixed(2)}%) exceeds maximum allowed (${prod.maxDiscountPct}%) for "${prod.name}".`,
            422,
          );
        }
      }

      subtotal = subtotal.add(lineCalc.grossLineAmount);
      totalDiscount = totalDiscount.add(lineCalc.discountAmount);
      totalTax = totalTax.add(lineCalc.totalTaxAmount);
      grandTotal = grandTotal.add(lineCalc.lineTotalWithTax);

      computedLines.push({
        lineNumber: i + 1,
        productId: prod.id,
        sku: prod.sku,
        productName: prod.name,
        batchId: selectedBatchId,
        batchNumber: selectedBatchNumber,
        serialId: lineInput.serialId ?? null,
        stockIntakeLotId: lineInput.stockIntakeLotId ?? null,
        intakeCode: lineInput.intakeCode ?? null,
        scannedBarcode: lineInput.scannedBarcode ?? null,
        uomCode,
        enteredQty: enteredQty.toDecimalString(),
        conversionFactorToBase: convFactor.toDecimalString(),
        normalizedBaseQty: baseQty.toDecimalString(),
        unitPrice: unitPrice.toDecimalString(),
        unitCostSnapshot: resolvedUnitCostStr || '0.0000',
        grossAmount: lineCalc.grossLineAmount.toDecimalString(),
        discountAmount: lineCalc.discountAmount.toDecimalString(),
        netTaxableAmount: lineCalc.netTaxableAmount.toDecimalString(),
        taxAmount: lineCalc.totalTaxAmount.toDecimalString(),
        lineTotal: lineCalc.lineTotalWithTax.toDecimalString(),
        taxRulesApplied: lineCalc.taxes.map((t) => ({
          taxRateId: t.taxRateId,
          name: t.name,
          ratePercentage: t.ratePercentage,
          taxAmount: t.taxAmount.toDecimalString(),
        })),
        entrySource: lineInput.entrySource ?? 'MANUAL',
      });
    }

    return {
      currencyCode,
      subtotalAmount: subtotal.toDecimalString(),
      discountAmount: totalDiscount.toDecimalString(),
      taxAmount: totalTax.toDecimalString(),
      grandTotal: grandTotal.toDecimalString(),
      lines: computedLines,
    };
  }

  async saveDraftCart(params: {
    readonly tenantId: string;
    readonly branchId: string;
    readonly userId: string;
    readonly registerId: string | null;
    readonly customerId: string | null;
    readonly customerName: string | null;
    readonly lines: readonly OfflineCartLineInput[];
    readonly notes?: string | null;
    readonly isOnline: boolean;
  }): Promise<OfflineDraftCartRecord> {
    const devCtx = await this.storage.getDeviceContext();
    assertOfflineSecurityAndCapability({
      operation: 'POS_CART_MANAGE',
      isOnline: params.isOnline,
      deviceContext: devCtx,
      tenantId: params.tenantId,
      branchId: params.branchId,
      requiredPermission: 'pos:sale:create',
    });
    const draft: OfflineDraftCartRecord = {
      id: randomUUID(),
      tenantId: params.tenantId,
      branchId: params.branchId,
      userId: params.userId,
      registerId: params.registerId,
      customerId: params.customerId,
      customerName: params.customerName,
      lines: params.lines,
      notes: params.notes ?? null,
      updatedAt: new Date().toISOString(),
    };
    await this.storage.saveDraftCart(draft);
    return draft;
  }

  async recoverSessionState(params: {
    readonly tenantId: string;
    readonly branchId: string;
    readonly userId: string;
    readonly isOnline: boolean;
  }): Promise<{
    readonly deviceContext: OfflineDeviceContext;
    readonly draftCart: OfflineDraftCartRecord | null;
    readonly localInvoices: readonly OfflineLocalInvoice[];
    readonly pendingOutbox: readonly OfflineOutboxCommandRecord[];
  }> {
    const rawCtx = await this.storage.getDeviceContext();
    const deviceContext = assertOfflineSecurityAndCapability({
      operation: 'POS_RECOVERY',
      isOnline: params.isOnline,
      deviceContext: rawCtx,
      tenantId: params.tenantId,
      branchId: params.branchId,
      requiredPermission: 'pos:sale:create',
    });

    const [draftCart, localInvoices, pendingOutbox] = await Promise.all([
      this.storage.loadDraftCart({
        tenantId: params.tenantId,
        branchId: params.branchId,
        userId: params.userId,
      }),
      this.storage.listLocalInvoices({
        tenantId: params.tenantId,
        branchId: params.branchId,
        limit: 100,
      }),
      this.storage.listPendingOutboxCommands({
        tenantId: params.tenantId,
        limit: 100,
      }),
    ]);

    return {
      deviceContext,
      draftCart,
      localInvoices,
      pendingOutbox,
    };
  }

  async recordOfflineCashSale(params: {
    readonly tenantId: string;
    readonly branchId: string;
    readonly warehouseId: string;
    readonly currencyCode: string;
    readonly input: OfflineCashCheckoutInput;
  }): Promise<OfflineCompletedSaleResult> {
    const devCtx = await this.storage.getDeviceContext();
    if (params.input.paymentMethod !== 'CASH') {
      assertOfflineSecurityAndCapability({
        operation:
          params.input.paymentMethod === 'CREDIT' || params.input.paymentMethod === 'SPLIT_CASH_CREDIT'
            ? 'POS_CREDIT_CHECKOUT'
            : 'POS_CARD_GATEWAY',
        isOnline: params.input.isOnline,
        deviceContext: devCtx,
        tenantId: params.tenantId,
        branchId: params.branchId,
        requiredPermission: 'pos:sale:create',
      });
      throw new OfflineEngineError(
        'OFFLINE_ONLINE_ONLY_BLOCKED',
        `${params.input.paymentMethod} payments require live online verification and cannot be completed in the offline queue.`,
        422,
      );
    }

    const secState = await this.storage.getDeviceSecurityState?.({
      tenantId: params.tenantId,
    });
    const authorizedCtx = assertOfflineSecurityAndCapability({
      operation: 'POS_CASH_CHECKOUT',
      isOnline: params.input.isOnline,
      deviceContext: devCtx,
      tenantId: params.tenantId,
      branchId: params.branchId,
      requiredPermission: 'pos:sale:create',
      deviceSecurityStatus: secState?.status ?? null,
    });

    if (params.input.lines.length === 0) {
      throw new OfflineEngineError('POS_CART_EMPTY', 'Cart cannot be empty.', 422);
    }

    const totals = await this.calculateCart({
      tenantId: params.tenantId,
      branchId: params.branchId,
      warehouseId: params.warehouseId,
      currencyCode: params.currencyCode,
      lines: params.input.lines,
      isOnline: params.input.isOnline,
    });

    const grandTotalMoney = Money.fromDecimalString(totals.grandTotal, params.currencyCode);
    const tenderedMoney = Money.fromDecimalString(
      params.input.tenderedAmount,
      params.currencyCode,
    );
    if (tenderedMoney.compare(grandTotalMoney) < 0) {
      throw new OfflineEngineError(
        'OFFLINE_INSUFFICIENT_CASH_TENDERED',
        `Tendered cash (${tenderedMoney.toDecimalString()}) cannot be less than grand total (${grandTotalMoney.toDecimalString()}).`,
        422,
      );
    }

    const changeMoney = tenderedMoney.subtract(grandTotalMoney);
    const now = new Date().toISOString();
    const invoiceId = randomUUID();
    const commandId = randomUUID();
    const invoiceNumber = `OFF-${invoiceId.replace(/-/g, '').slice(0, 10).toUpperCase()}`;

    const invoice: OfflineLocalInvoice = {
      invoiceId,
      tenantId: params.tenantId,
      branchId: params.branchId,
      warehouseId: params.warehouseId,
      registerId: params.input.registerId,
      shiftId: params.input.shiftId,
      customerId: params.input.customerId ?? null,
      customerName: params.input.customerName ?? null,
      cashierUserId: authorizedCtx.actorUserId,
      invoiceNumber,
      currencyCode: params.currencyCode,
      subtotalAmount: totals.subtotalAmount,
      discountAmount: totals.discountAmount,
      taxAmount: totals.taxAmount,
      grandTotal: totals.grandTotal,
      totalPaid: totals.grandTotal,
      changeGiven: changeMoney.toDecimalString(),
      syncState: 'PENDING_SYNC',
      serverConfirmed: false,
      outboxCommandId: commandId,
      conflictReason: null,
      createdAt: now,
    };

    const outboxPayload: Record<string, unknown> = {
      registerId: params.input.registerId,
      shiftId: params.input.shiftId,
      customerId: params.input.customerId ?? null,
      customerName: params.input.customerName ?? null,
      lines: totals.lines.map((l) => ({
        productId: l.productId,
        ...(l.batchId ? { batchId: l.batchId } : {}),
        ...(l.serialId ? { serialId: l.serialId } : {}),
        ...(l.stockIntakeLotId ? { stockIntakeLotId: l.stockIntakeLotId } : {}),
        ...(l.scannedBarcode ? { scannedBarcode: l.scannedBarcode } : {}),
        quantity: l.enteredQty,
        uomCode: l.uomCode,
        entrySource: l.entrySource,
        unitPrice: l.unitPrice,
      })),
      payments: [
        {
          paymentMethod: 'CASH',
          amount: totals.grandTotal,
          tenderedAmount: tenderedMoney.toDecimalString(),
        },
      ],
      offlineInvoiceNumber: invoiceNumber,
      offlineMode: true,
      validationPolicy: 'OPTION_A_SERVER_VALIDATION_ON_SYNC',
    };

    const { localSeq } = await this.storage.commitOfflineCashSale({
      invoice,
      lines: totals.lines,
      tenderedAmount: tenderedMoney.toDecimalString(),
      outboxCommandId: commandId,
      outboxPayload,
      stockDeductions: totals.lines.map((l) => ({
        productId: l.productId,
        warehouseId: params.warehouseId,
        baseQtyDelta: l.normalizedBaseQty,
        batchId: l.batchId,
        serialId: l.serialId,
      })),
    });

    await this.storage.clearDraftCart({
      tenantId: params.tenantId,
      branchId: params.branchId,
      userId: authorizedCtx.actorUserId,
    });

    return {
      invoice,
      lines: totals.lines,
      outboxCommandId: commandId,
      localSeq,
      syncState: 'PENDING_SYNC',
      serverConfirmed: false,
      receiptPayload: {
        invoiceNumber,
        syncBadge: 'PENDING_SYNC',
        issuedAt: now,
        branchId: params.branchId,
        registerId: params.input.registerId,
        customerName: params.input.customerName ?? null,
        currencyCode: params.currencyCode,
        subtotalAmount: totals.subtotalAmount,
        discountAmount: totals.discountAmount,
        taxAmount: totals.taxAmount,
        grandTotal: totals.grandTotal,
        tenderedAmount: tenderedMoney.toDecimalString(),
        changeGiven: changeMoney.toDecimalString(),
        lines: totals.lines,
      },
    };
  }
}

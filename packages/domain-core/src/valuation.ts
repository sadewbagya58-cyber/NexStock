import { Money } from './money.js';
import { Quantity, QUANTITY_SCALE_FACTOR } from './quantity.js';
import { type RoundingMode, divideAndRoundBigInt } from './rounding.js';

/**
 * Explicit Accounting & Valuation Business Policies (NEX-DOC-04 Section 4 & UD-03).
 * Flagged items below require sign-off from a qualified Chartered Accountant / CPA
 * for specific regional tax jurisdictions (e.g., Sri Lanka IRD SLFRS/LKAS 2, IFRS IAS 2, US GAAP).
 */
export interface AccountingPolicyFlag {
  readonly policyId: string;
  readonly title: string;
  readonly implementedRule: string;
  readonly requiresSpecialistReviewFor: string;
}

export const ACCOUNTING_POLICIES_REQUIRING_SPECIALIST_REVIEW: readonly AccountingPolicyFlag[] =
  [
    {
      policyId: 'ACC-POL-01',
      title: 'Offline Negative-Stock Replenishment Price Variance Recognition',
      implementedRule:
        'When offline POS sales drive qty_on_hand < 0 at historical MAC_old and a subsequent purchase receipt arrives at C_in != MAC_old, historical posted POS invoices are NOT retroactively restated. Instead, the cost delta on the deficit quantity Q_deficit * (C_in - MAC_old) is posted immediately to 5150 Purchase Price Variance / COGS Adjustment in the current open accounting period.',
      requiresSpecialistReviewFor:
        'Confirm whether local statutory reporting requires presenting 5150 inside Cost of Sales (COGS) vs. Operating Expenses on the statutory Income Statement.',
    },
    {
      policyId: 'ACC-POL-02',
      title: 'Post-Sale Landed Cost & Supplier Bill Variance Split',
      implementedRule:
        'When a Landed Cost Voucher (freight/customs duty) or Supplier Bill price variance is posted after part of the GRN receipt has already been sold, only the share corresponding to remaining_qty still on hand is capitalized into 1300 Inventory Asset (COST_REVALUATION), while the share corresponding to already-sold units is expensed immediately to 5150 Purchase Price Variance / COGS Adjustment.',
      requiresSpecialistReviewFor:
        'Verify customs duty capitalization rules and import VAT input-credit eligibility vs. landed cost capitalization under local tax law (e.g., Sri Lanka VAT / SSCL / PAL).',
    },
    {
      policyId: 'ACC-POL-03',
      title: 'Damaged Customer Returns (WRITE_OFF_DAMAGED) Tax & COGS Treatment',
      implementedRule:
        'A customer return marked WRITE_OFF_DAMAGED reverses Sales Revenue (4050) and Sales Tax Payable (2200), credits Original COGS (5100), and debits Damaged Stock Write-Off Expense (5200) while incrementing non-sellable qty_damaged (zero addition to 1300 Sellable Inventory Asset).',
      requiresSpecialistReviewFor:
        'Verify credit note time limits for output VAT/GST adjustment and required statutory destruction certificates for claiming damaged stock tax deductions.',
    },
    {
      policyId: 'ACC-POL-04',
      title:
        'Late Offline Sync Across Locked Accounting Periods (Period Cut-Off)',
      implementedRule:
        'If an offline device syncs a transaction whose physical occurred_at timestamp falls inside a CLOSED/LOCKED accounting period, operational ledgers preserve occurred_at for audit, while the financial journal entry posts on the first day of the earliest OPEN period.',
      requiresSpecialistReviewFor:
        'Confirm grace-window policy before locking monthly VAT/GST tax filing periods when offline terminals have pending outbox queues.',
    },
  ];

export interface MacBalanceState {
  readonly qtyOnHand: Quantity;
  readonly movingAvgCost: Money;
  readonly totalInventoryValue: Money;
}

export interface MacReceiptResult {
  readonly previousState: MacBalanceState;
  readonly newState: MacBalanceState;
  /**
   * Total cost of the received goods (qtyReceived * receiptUnitCost).
   */
  readonly totalReceiptCost: Money;
  /**
   * Amount added to `1300 Inventory Asset` in `stock_ledger_entries.total_cost_delta`.
   */
  readonly inventoryAssetCostDelta: Money;
  /**
   * Non-zero only when recovering from `qtyOnHand < 0` and `receiptUnitCost != oldMAC`.
   * Positive = additional COGS/PPV debit; Negative = COGS/PPV credit.
   */
  readonly negativeStockPpvAmount: Money;
  readonly deficitQuantityCovered: Quantity;
  readonly surplusQuantityAdded: Quantity;
}

/**
 * Applies a positive stock receipt (+qtyReceived at receiptUnitCost) to a Moving Average Cost (MAC) balance,
 * including deterministic handling of negative-stock recovery per UD-03.
 */
export function applyMacReceipt(params: {
  readonly currentState: MacBalanceState;
  readonly qtyReceived: Quantity;
  readonly receiptUnitCost: Money;
  readonly roundingMode?: RoundingMode;
}): MacReceiptResult {
  const roundingMode = params.roundingMode ?? 'HALF_EVEN';
  const { currentState, qtyReceived, receiptUnitCost } = params;
  const currency = currentState.movingAvgCost.currencyCode;

  if (!qtyReceived.isPositive()) {
    throw new RangeError('Receipt quantity must be strictly positive.');
  }
  if (receiptUnitCost.isNegative()) {
    throw new RangeError('Receipt unit cost cannot be negative.');
  }

  const totalReceiptCost = receiptUnitCost.multiplyByQuantity(
    qtyReceived,
    roundingMode,
  );
  const newQtyOnHand = currentState.qtyOnHand.add(qtyReceived);

  // Case 1: Standard positive or zero starting inventory (`qtyOnHand >= 0`)
  if (!currentState.qtyOnHand.isNegative()) {
    const newTotalValue =
      currentState.totalInventoryValue.add(totalReceiptCost);
    const newMacScaled = divideAndRoundBigInt(
      newTotalValue.scaledUnits * QUANTITY_SCALE_FACTOR,
      newQtyOnHand.microUnits,
      roundingMode,
    );
    const newMac = Money.fromScaledUnits(newMacScaled, currency);

    return {
      previousState: currentState,
      newState: {
        qtyOnHand: newQtyOnHand,
        movingAvgCost: newMac,
        totalInventoryValue: newTotalValue,
      },
      totalReceiptCost,
      inventoryAssetCostDelta: totalReceiptCost,
      negativeStockPpvAmount: Money.zero(currency),
      deficitQuantityCovered: Quantity.zero(),
      surplusQuantityAdded: qtyReceived,
    };
  }

  // Case 2: Recovering from Negative Inventory (`qtyOnHand < 0`) caused by offline POS sales
  const absDeficit = currentState.qtyOnHand.abs();
  const deficitQuantityCovered =
    qtyReceived.compare(absDeficit) <= 0 ? qtyReceived : absDeficit;
  const surplusQuantityAdded = qtyReceived.subtract(deficitQuantityCovered);

  // Deficit was originally credited from Inventory Asset at old MAC (leaving negative totalInventoryValue).
  // The value required to clear `deficitQuantityCovered` at old MAC:
  const deficitBookValueCleared = deficitQuantityCovered.equals(absDeficit)
    ? currentState.totalInventoryValue.abs()
    : currentState.movingAvgCost.multiplyByQuantity(
        deficitQuantityCovered,
        roundingMode,
      );

  const deficitActualReceiptCost = receiptUnitCost.multiplyByQuantity(
    deficitQuantityCovered,
    roundingMode,
  );

  // Variance on the already-sold deficit units: Actual Receipt Cost - Old MAC Book Value
  const negativeStockPpvAmount = deficitActualReceiptCost.subtract(
    deficitBookValueCleared,
  );

  if (surplusQuantityAdded.isPositive()) {
    // Stock transitions from negative to positive (> 0):
    // Surplus units are valued at `receiptUnitCost`.
    const newTotalValue = receiptUnitCost.multiplyByQuantity(
      surplusQuantityAdded,
      roundingMode,
    );
    const inventoryAssetCostDelta = newTotalValue.subtract(
      currentState.totalInventoryValue,
    );

    return {
      previousState: currentState,
      newState: {
        qtyOnHand: newQtyOnHand,
        movingAvgCost: receiptUnitCost,
        totalInventoryValue: newTotalValue,
      },
      totalReceiptCost,
      inventoryAssetCostDelta,
      negativeStockPpvAmount,
      deficitQuantityCovered,
      surplusQuantityAdded,
    };
  }

  // Stock remains negative or reaches exactly 0 (`newQtyOnHand <= 0`):
  const newTotalValue = newQtyOnHand.isZero()
    ? Money.zero(currency)
    : currentState.totalInventoryValue.add(deficitBookValueCleared);
  const inventoryAssetCostDelta = newTotalValue.subtract(
    currentState.totalInventoryValue,
  );
  // Keep receiptUnitCost as updated reference MAC if reaching 0, or keep old MAC while still negative
  const newMac = newQtyOnHand.isZero()
    ? receiptUnitCost
    : currentState.movingAvgCost;

  return {
    previousState: currentState,
    newState: {
      qtyOnHand: newQtyOnHand,
      movingAvgCost: newMac,
      totalInventoryValue: newTotalValue,
    },
    totalReceiptCost,
    inventoryAssetCostDelta,
    negativeStockPpvAmount,
    deficitQuantityCovered,
    surplusQuantityAdded: Quantity.zero(),
  };
}

export interface MacIssueResult {
  readonly previousState: MacBalanceState;
  readonly newState: MacBalanceState;
  readonly unitCostSnapshot: Money;
  readonly cogsAmount: Money;
  readonly inventoryAssetCostDelta: Money; // Negative (credit to Inventory Asset)
  readonly droveStockNegative: boolean;
}

/**
 * Applies an outbound stock deduction (-qtyIssued) under Moving Average Cost (MAC).
 */
export function applyMacOutboundIssue(params: {
  readonly currentState: MacBalanceState;
  readonly qtyIssued: Quantity;
  readonly allowNegativeStock: boolean;
  readonly roundingMode?: RoundingMode;
}): MacIssueResult {
  const roundingMode = params.roundingMode ?? 'HALF_EVEN';
  const { currentState, qtyIssued, allowNegativeStock } = params;
  const currency = currentState.movingAvgCost.currencyCode;

  if (!qtyIssued.isPositive()) {
    throw new RangeError('Outbound issue quantity must be strictly positive.');
  }

  const newQtyOnHand = currentState.qtyOnHand.subtract(qtyIssued);
  if (newQtyOnHand.isNegative() && !allowNegativeStock) {
    throw new Error(
      `INV_INSUFFICIENT_AVAILABLE_STOCK: Cannot issue ${qtyIssued.toDecimalString()} when on-hand is ${currentState.qtyOnHand.toDecimalString()} and negative stock is disallowed.`,
    );
  }

  let cogsAmount: Money;
  let newTotalValue: Money;

  if (newQtyOnHand.isZero() && currentState.qtyOnHand.isPositive()) {
    // Absorb any sub-cent rounding residual when exhausting positive stock to zero
    cogsAmount = currentState.totalInventoryValue;
    newTotalValue = Money.zero(currency);
  } else {
    cogsAmount = currentState.movingAvgCost.multiplyByQuantity(
      qtyIssued,
      roundingMode,
    );
    newTotalValue = currentState.totalInventoryValue.subtract(cogsAmount);
  }

  return {
    previousState: currentState,
    newState: {
      qtyOnHand: newQtyOnHand,
      movingAvgCost: currentState.movingAvgCost,
      totalInventoryValue: newTotalValue,
    },
    unitCostSnapshot: currentState.movingAvgCost,
    cogsAmount,
    inventoryAssetCostDelta: cogsAmount.negate(),
    droveStockNegative: newQtyOnHand.isNegative(),
  };
}

export interface FifoCostLayer {
  readonly layerId: string;
  readonly batchId: string;
  readonly remainingQty: Quantity;
  readonly unitCost: Money;
}

export interface ConsumedFifoLayerSlice {
  readonly layerId: string;
  readonly batchId: string;
  readonly qtyConsumed: Quantity;
  readonly unitCost: Money;
  readonly layerCostTotal: Money;
}

export interface FifoConsumptionResult {
  readonly updatedLayers: readonly FifoCostLayer[];
  readonly consumedSlices: readonly ConsumedFifoLayerSlice[];
  readonly uncoveredNegativeQty: Quantity;
  readonly totalCogs: Money;
  readonly effectiveUnitCostSnapshot: Money;
}

/**
 * Consumes quantity from chronological FIFO cost layers (`UD-03`).
 */
export function consumeFifoCostLayers(params: {
  readonly layers: readonly FifoCostLayer[];
  readonly qtyToConsume: Quantity;
  readonly fallbackUnitCost: Money;
  readonly allowNegativeStock: boolean;
  readonly roundingMode?: RoundingMode;
}): FifoConsumptionResult {
  const roundingMode = params.roundingMode ?? 'HALF_EVEN';
  const currency = params.fallbackUnitCost.currencyCode;

  if (!params.qtyToConsume.isPositive()) {
    throw new RangeError('Quantity to consume must be strictly positive.');
  }

  let remainingToFulfill = params.qtyToConsume;
  const updatedLayers: FifoCostLayer[] = [];
  const consumedSlices: ConsumedFifoLayerSlice[] = [];
  let totalCogs = Money.zero(currency);

  for (const layer of params.layers) {
    if (remainingToFulfill.isZero() || layer.remainingQty.isZero()) {
      updatedLayers.push(layer);
      continue;
    }

    const takeQty =
      layer.remainingQty.compare(remainingToFulfill) <= 0
        ? layer.remainingQty
        : remainingToFulfill;

    const sliceCost = layer.unitCost.multiplyByQuantity(takeQty, roundingMode);
    totalCogs = totalCogs.add(sliceCost);
    remainingToFulfill = remainingToFulfill.subtract(takeQty);

    consumedSlices.push({
      layerId: layer.layerId,
      batchId: layer.batchId,
      qtyConsumed: takeQty,
      unitCost: layer.unitCost,
      layerCostTotal: sliceCost,
    });

    updatedLayers.push({
      ...layer,
      remainingQty: layer.remainingQty.subtract(takeQty),
    });
  }

  if (remainingToFulfill.isPositive()) {
    if (!params.allowNegativeStock) {
      throw new Error(
        `INV_INSUFFICIENT_BATCH_STOCK: Uncovered quantity ${remainingToFulfill.toDecimalString()} exceeds available FIFO layers.`,
      );
    }
    const fallbackCost = params.fallbackUnitCost.multiplyByQuantity(
      remainingToFulfill,
      roundingMode,
    );
    totalCogs = totalCogs.add(fallbackCost);
  }

  const effectiveUnitCostScaled = divideAndRoundBigInt(
    totalCogs.scaledUnits * QUANTITY_SCALE_FACTOR,
    params.qtyToConsume.microUnits,
    roundingMode,
  );

  return {
    updatedLayers,
    consumedSlices,
    uncoveredNegativeQty: remainingToFulfill,
    totalCogs,
    effectiveUnitCostSnapshot: Money.fromScaledUnits(
      effectiveUnitCostScaled,
      currency,
    ),
  };
}

export interface PostReceiptCostAdjustmentResult {
  readonly totalAdjustmentAmount: Money;
  readonly remainingQtyOnHandFromReceipt: Quantity;
  readonly alreadyDisposedQty: Quantity;
  /**
   * Amount capitalized into `1300 Inventory Asset` via `COST_REVALUATION` ledger entry.
   */
  readonly capitalizedInventoryDelta: Money;
  /**
   * Amount expensed immediately to `5150 Purchase Price Variance / COGS Adjustment`
   * because those units already left stock (preserving historical immutability).
   */
  readonly expensedPpvDelta: Money;
  readonly journalLines: readonly JournalPostingLine[];
}

export interface JournalPostingLine {
  readonly accountCode:
    | '1010_CASH_ON_HAND'
    | '1300_INVENTORY_ASSET'
    | '2100_ACCOUNTS_PAYABLE'
    | '2110_GRNI_CLEARING'
    | '2200_SALES_TAX_PAYABLE'
    | '4000_SALES_REVENUE'
    | '4050_SALES_RETURNS'
    | '5100_COGS'
    | '5150_PURCHASE_PRICE_VARIANCE'
    | '5200_DAMAGED_STOCK_WRITEOFF';
  readonly debit: Money;
  readonly credit: Money;
}

/**
 * Allocates a post-receipt cost adjustment (Landed Cost Voucher or Supplier Bill price variance)
 * between units still in stock (`capitalizedInventoryDelta`) and units already sold (`expensedPpvDelta`)
 * without retroactively altering historical sales (`UD-03`).
 */
export function allocatePostReceiptCostAdjustment(params: {
  readonly originalReceivedQty: Quantity;
  readonly remainingQtyFromReceipt: Quantity;
  readonly totalCostAdjustment: Money;
  readonly creditAccount?: '2100_ACCOUNTS_PAYABLE' | '2110_GRNI_CLEARING';
  readonly roundingMode?: RoundingMode;
}): PostReceiptCostAdjustmentResult {
  const roundingMode = params.roundingMode ?? 'HALF_EVEN';
  const {
    originalReceivedQty,
    remainingQtyFromReceipt,
    totalCostAdjustment,
  } = params;
  const currency = totalCostAdjustment.currencyCode;

  if (!originalReceivedQty.isPositive()) {
    throw new RangeError('Original received quantity must be positive.');
  }
  if (
    remainingQtyFromReceipt.isNegative() ||
    remainingQtyFromReceipt.compare(originalReceivedQty) > 0
  ) {
    throw new RangeError(
      'Remaining quantity from receipt must be between 0 and originalReceivedQty.',
    );
  }

  const alreadyDisposedQty = originalReceivedQty.subtract(
    remainingQtyFromReceipt,
  );

  const capitalizedScaled = divideAndRoundBigInt(
    totalCostAdjustment.scaledUnits * remainingQtyFromReceipt.microUnits,
    originalReceivedQty.microUnits,
    roundingMode,
  );
  const capitalizedInventoryDelta = Money.fromScaledUnits(
    capitalizedScaled,
    currency,
  );
  const expensedPpvDelta = totalCostAdjustment.subtract(
    capitalizedInventoryDelta,
  );

  const creditAccount = params.creditAccount ?? '2100_ACCOUNTS_PAYABLE';
  const journalLines: JournalPostingLine[] = [];

  if (!capitalizedInventoryDelta.isZero()) {
    journalLines.push({
      accountCode: '1300_INVENTORY_ASSET',
      debit: capitalizedInventoryDelta.isPositive()
        ? capitalizedInventoryDelta
        : Money.zero(currency),
      credit: capitalizedInventoryDelta.isNegative()
        ? capitalizedInventoryDelta.abs()
        : Money.zero(currency),
    });
  }

  if (!expensedPpvDelta.isZero()) {
    journalLines.push({
      accountCode: '5150_PURCHASE_PRICE_VARIANCE',
      debit: expensedPpvDelta.isPositive()
        ? expensedPpvDelta
        : Money.zero(currency),
      credit: expensedPpvDelta.isNegative()
        ? expensedPpvDelta.abs()
        : Money.zero(currency),
    });
  }

  if (!totalCostAdjustment.isZero()) {
    journalLines.push({
      accountCode: creditAccount,
      debit: totalCostAdjustment.isNegative()
        ? totalCostAdjustment.abs()
        : Money.zero(currency),
      credit: totalCostAdjustment.isPositive()
        ? totalCostAdjustment
        : Money.zero(currency),
    });
  }

  return {
    totalAdjustmentAmount: totalCostAdjustment,
    remainingQtyOnHandFromReceipt: remainingQtyFromReceipt,
    alreadyDisposedQty,
    capitalizedInventoryDelta,
    expensedPpvDelta,
    journalLines,
  };
}

export interface SalesReturnValuationResult {
  readonly returnCondition: 'RESTOCK_SELLABLE' | 'WRITE_OFF_DAMAGED';
  readonly updatedMacState: MacBalanceState;
  readonly sellableInventoryDeltaQty: Quantity;
  readonly damagedInventoryDeltaQty: Quantity;
  readonly inventoryAssetCostDelta: Money;
  readonly damagedWriteOffExpense: Money;
  readonly journalLines: readonly JournalPostingLine[];
}

/**
 * Computes inventory valuation and balanced journal postings for a customer sales return (`UD-03`).
 */
export function calculateSalesReturnImpact(params: {
  readonly currentState: MacBalanceState;
  readonly returnQty: Quantity;
  readonly capturedSaleUnitCost: Money;
  readonly netRevenueRefund: Money;
  readonly taxRefund: Money;
  readonly returnCondition: 'RESTOCK_SELLABLE' | 'WRITE_OFF_DAMAGED';
  readonly roundingMode?: RoundingMode;
}): SalesReturnValuationResult {
  const roundingMode = params.roundingMode ?? 'HALF_EVEN';
  const currency = params.currentState.movingAvgCost.currencyCode;
  const totalCustomerRefund = params.netRevenueRefund.add(params.taxRefund);
  const originalCogsReversed = params.capturedSaleUnitCost.multiplyByQuantity(
    params.returnQty,
    roundingMode,
  );

  if (params.returnCondition === 'RESTOCK_SELLABLE') {
    const receipt = applyMacReceipt({
      currentState: params.currentState,
      qtyReceived: params.returnQty,
      receiptUnitCost: params.capturedSaleUnitCost,
      roundingMode,
    });

    const journalLines: JournalPostingLine[] = [
      {
        accountCode: '4050_SALES_RETURNS',
        debit: params.netRevenueRefund,
        credit: Money.zero(currency),
      },
      ...(params.taxRefund.isPositive()
        ? [
            {
              accountCode: '2200_SALES_TAX_PAYABLE' as const,
              debit: params.taxRefund,
              credit: Money.zero(currency),
            },
          ]
        : []),
      {
        accountCode: '1010_CASH_ON_HAND',
        debit: Money.zero(currency),
        credit: totalCustomerRefund,
      },
      {
        accountCode: '1300_INVENTORY_ASSET',
        debit: receipt.inventoryAssetCostDelta,
        credit: Money.zero(currency),
      },
      ...(receipt.negativeStockPpvAmount.isZero()
        ? []
        : [
            {
              accountCode: '5150_PURCHASE_PRICE_VARIANCE' as const,
              debit: receipt.negativeStockPpvAmount.isPositive()
                ? receipt.negativeStockPpvAmount
                : Money.zero(currency),
              credit: receipt.negativeStockPpvAmount.isNegative()
                ? receipt.negativeStockPpvAmount.abs()
                : Money.zero(currency),
            },
          ]),
      {
        accountCode: '5100_COGS',
        debit: Money.zero(currency),
        credit: originalCogsReversed,
      },
    ];

    return {
      returnCondition: 'RESTOCK_SELLABLE',
      updatedMacState: receipt.newState,
      sellableInventoryDeltaQty: params.returnQty,
      damagedInventoryDeltaQty: Quantity.zero(),
      inventoryAssetCostDelta: receipt.inventoryAssetCostDelta,
      damagedWriteOffExpense: Money.zero(currency),
      journalLines,
    };
  }

  // WRITE_OFF_DAMAGED: Does not enter sellable Inventory Asset; routes cost to 5200_DAMAGED_STOCK_WRITEOFF
  const journalLines: JournalPostingLine[] = [
    {
      accountCode: '4050_SALES_RETURNS',
      debit: params.netRevenueRefund,
      credit: Money.zero(currency),
    },
    ...(params.taxRefund.isPositive()
      ? [
          {
            accountCode: '2200_SALES_TAX_PAYABLE' as const,
            debit: params.taxRefund,
            credit: Money.zero(currency),
          },
        ]
      : []),
    {
      accountCode: '1010_CASH_ON_HAND',
      debit: Money.zero(currency),
      credit: totalCustomerRefund,
    },
    {
      accountCode: '5200_DAMAGED_STOCK_WRITEOFF',
      debit: originalCogsReversed,
      credit: Money.zero(currency),
    },
    {
      accountCode: '5100_COGS',
      debit: Money.zero(currency),
      credit: originalCogsReversed,
    },
  ];

  return {
    returnCondition: 'WRITE_OFF_DAMAGED',
    updatedMacState: params.currentState,
    sellableInventoryDeltaQty: Quantity.zero(),
    damagedInventoryDeltaQty: params.returnQty,
    inventoryAssetCostDelta: Money.zero(currency),
    damagedWriteOffExpense: originalCogsReversed,
    journalLines,
  };
}

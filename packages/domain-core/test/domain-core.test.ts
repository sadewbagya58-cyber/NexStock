import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ACCOUNTING_POLICIES_REQUIRING_SPECIALIST_REVIEW,
  type FifoCostLayer,
  type JournalPostingLine,
  Money,
  Quantity,
  type RoundingMode,
  allocatePostReceiptCostAdjustment,
  applyMacOutboundIssue,
  applyMacReceipt,
  calculateLinePricingAndTax,
  calculateSalesReturnImpact,
  consumeFifoCostLayers,
} from '../src/index.js';

const currentDir = dirname(fileURLToPath(import.meta.url));
const vectorsPath = resolve(
  currentDir,
  '../test-vectors/calculation-vectors.json',
);
const testVectors = JSON.parse(readFileSync(vectorsPath, 'utf-8'));

function assertBalancedJournal(
  lines: readonly JournalPostingLine[],
  currency: string,
): void {
  let debitSum = Money.zero(currency);
  let creditSum = Money.zero(currency);
  for (const line of lines) {
    expect(line.debit.isNegative()).toBe(false);
    expect(line.credit.isNegative()).toBe(false);
    // A single line cannot have both positive debit and positive credit
    expect(line.debit.isPositive() && line.credit.isPositive()).toBe(false);
    debitSum = debitSum.add(line.debit);
    creditSum = creditSum.add(line.credit);
  }
  expect(debitSum.toDecimalString()).toBe(creditSum.toDecimalString());
}

describe('@nexstock/domain-core — Fixed-Point Money, Quantity, Tax & Valuation', () => {
  describe('Canonical JSON Test Vectors (TypeScript Execution)', () => {
    it('passes all rounding vectors (HALF_EVEN, HALF_UP, 0/2/3 decimal currencies)', () => {
      for (const vec of testVectors.roundingVectors) {
        const money = Money.fromDecimalString(
          vec.input,
          vec.currency,
          vec.roundingMode as RoundingMode,
        );
        expect(money.toDecimalString(), vec.id).toBe(vec.expectedScaled4);
        expect(
          money.toCurrencyDecimalString(vec.roundingMode as RoundingMode),
          vec.id,
        ).toBe(vec.expectedMinorString);
      }
    });

    it('passes all tax calculation vectors (exclusive, inclusive, compound)', () => {
      for (const vec of testVectors.taxVectors) {
        const result = calculateLinePricingAndTax({
          unitPrice: Money.fromDecimalString(vec.unitPrice, vec.currency),
          quantity: Quantity.fromDecimalString(vec.quantity),
          lineDiscount: Money.fromDecimalString(vec.lineDiscount, vec.currency),
          isTaxInclusive: vec.isTaxInclusive,
          taxRules: vec.taxRules,
        });
        expect(result.netTaxableAmount.toDecimalString(), vec.id).toBe(
          vec.expectedNetTaxable,
        );
        expect(result.totalTaxAmount.toDecimalString(), vec.id).toBe(
          vec.expectedTotalTax,
        );
        expect(result.lineTotalWithTax.toDecimalString(), vec.id).toBe(
          vec.expectedLineTotalWithTax,
        );
      }
    });

    it('passes MAC positive receipt, negative-stock recovery, and landed cost vectors', () => {
      const macPos = testVectors.valuationVectors.macPositiveReceipt;
      const posResult = applyMacReceipt({
        currentState: {
          qtyOnHand: Quantity.fromDecimalString(macPos.initialQty),
          movingAvgCost: Money.fromDecimalString(
            macPos.initialMac,
            macPos.currency,
          ),
          totalInventoryValue: Money.fromDecimalString(
            macPos.initialTotalValue,
            macPos.currency,
          ),
        },
        qtyReceived: Quantity.fromDecimalString(macPos.receiptQty),
        receiptUnitCost: Money.fromDecimalString(
          macPos.receiptUnitCost,
          macPos.currency,
        ),
      });
      expect(posResult.newState.qtyOnHand.toDecimalString()).toBe(
        macPos.expectedNewQty,
      );
      expect(posResult.newState.movingAvgCost.toDecimalString()).toBe(
        macPos.expectedNewMac,
      );
      expect(posResult.newState.totalInventoryValue.toDecimalString()).toBe(
        macPos.expectedNewTotalValue,
      );
      expect(posResult.negativeStockPpvAmount.toDecimalString()).toBe(
        macPos.expectedPpv,
      );

      const macNeg = testVectors.valuationVectors.macNegativeStockRecovery;
      const negResult = applyMacReceipt({
        currentState: {
          qtyOnHand: Quantity.fromDecimalString(macNeg.initialQty),
          movingAvgCost: Money.fromDecimalString(
            macNeg.initialMac,
            macNeg.currency,
          ),
          totalInventoryValue: Money.fromDecimalString(
            macNeg.initialTotalValue,
            macNeg.currency,
          ),
        },
        qtyReceived: Quantity.fromDecimalString(macNeg.receiptQty),
        receiptUnitCost: Money.fromDecimalString(
          macNeg.receiptUnitCost,
          macNeg.currency,
        ),
      });
      expect(negResult.newState.qtyOnHand.toDecimalString()).toBe(
        macNeg.expectedNewQty,
      );
      expect(negResult.newState.movingAvgCost.toDecimalString()).toBe(
        macNeg.expectedNewMac,
      );
      expect(negResult.newState.totalInventoryValue.toDecimalString()).toBe(
        macNeg.expectedNewTotalValue,
      );
      expect(negResult.inventoryAssetCostDelta.toDecimalString()).toBe(
        macNeg.expectedInventoryAssetDelta,
      );
      expect(negResult.negativeStockPpvAmount.toDecimalString()).toBe(
        macNeg.expectedNegativeStockPpv,
      );
      expect(negResult.deficitQuantityCovered.toDecimalString()).toBe(
        macNeg.expectedDeficitCovered,
      );
      expect(negResult.surplusQuantityAdded.toDecimalString()).toBe(
        macNeg.expectedSurplusAdded,
      );

      const lc = testVectors.valuationVectors.postReceiptLandedCostSplit;
      const lcResult = allocatePostReceiptCostAdjustment({
        originalReceivedQty: Quantity.fromDecimalString(lc.originalReceivedQty),
        remainingQtyFromReceipt: Quantity.fromDecimalString(
          lc.remainingQtyFromReceipt,
        ),
        totalCostAdjustment: Money.fromDecimalString(
          lc.totalCostAdjustment,
          lc.currency,
        ),
      });
      expect(lcResult.capitalizedInventoryDelta.toDecimalString()).toBe(
        lc.expectedCapitalizedInventoryDelta,
      );
      expect(lcResult.expensedPpvDelta.toDecimalString()).toBe(
        lc.expectedExpensedPpvDelta,
      );
      assertBalancedJournal(lcResult.journalLines, lc.currency);
    });
  });

  describe('Money & Quantity Precision Invariants (No IEEE 754 Drift)', () => {
    it('adds 0.1 + 0.2 exactly without floating-point drift', () => {
      const a = Money.fromDecimalString('0.1000', 'USD');
      const b = Money.fromDecimalString('0.2000', 'USD');
      expect(a.add(b).toDecimalString()).toBe('0.3000');
    });

    it('allocates $100.00 across [1, 1, 1] weights without losing a single cent ($33.34 + $33.33 + $33.33)', () => {
      const hundred = Money.fromDecimalString('100.0000', 'USD');
      const shares = hundred.allocateByWeights([1n, 1n, 1n]);
      expect(shares.map((s) => s.toCurrencyDecimalString())).toEqual([
        '33.34',
        '33.33',
        '33.33',
      ]);
      const sum = shares.reduce((acc, s) => acc.add(s), Money.zero('USD'));
      expect(sum.toDecimalString()).toBe('100.0000');
    });

    it('prevents combining different currencies without explicit exchange rate conversion', () => {
      const usd = Money.fromDecimalString('10.0000', 'USD');
      const lkr = Money.fromDecimalString('3000.0000', 'LKR');
      expect(() => usd.add(lkr)).toThrow(/Currency mismatch/);

      const convertedToLkr = usd.convertCurrency('LKR', '298.50000000');
      expect(convertedToLkr.currencyCode).toBe('LKR');
      expect(convertedToLkr.toDecimalString()).toBe('2985.0000');
    });

    it('converts fractional quantities using UoM conversion factors accurately', () => {
      const boxes = Quantity.fromDecimalString('2.500000');
      const pieces = boxes.convertUsingFactor('12.000000');
      expect(pieces.toDecimalString()).toBe('30.000000');
    });
  });

  describe('Inventory Valuation Edge Cases (UD-03)', () => {
    it('absorbs sub-cent residual into final outbound issue when positive stock reaches zero', () => {
      // Suppose 3 units on hand have totalInventoryValue = $10.0000, MAC = $3.3333
      const state0 = {
        qtyOnHand: Quantity.fromDecimalString('3.000000'),
        movingAvgCost: Money.fromDecimalString('3.3333', 'USD'),
        totalInventoryValue: Money.fromDecimalString('10.0000', 'USD'),
      };
      // Issue 2 units -> COGS = $6.6666, remaining value = $3.3334
      const issue1 = applyMacOutboundIssue({
        currentState: state0,
        qtyIssued: Quantity.fromDecimalString('2.000000'),
        allowNegativeStock: false,
      });
      expect(issue1.cogsAmount.toDecimalString()).toBe('6.6666');
      expect(issue1.newState.totalInventoryValue.toDecimalString()).toBe(
        '3.3334',
      );

      // Issue final 1 unit -> must absorb residual so totalInventoryValue === 0.0000!
      const issue2 = applyMacOutboundIssue({
        currentState: issue1.newState,
        qtyIssued: Quantity.fromDecimalString('1.000000'),
        allowNegativeStock: false,
      });
      expect(issue2.cogsAmount.toDecimalString()).toBe('3.3334');
      expect(issue2.newState.qtyOnHand.toDecimalString()).toBe('0.000000');
      expect(issue2.newState.totalInventoryValue.toDecimalString()).toBe(
        '0.0000',
      );
    });

    it('consumes FIFO batch cost layers chronologically across multiple layers', () => {
      const layers: FifoCostLayer[] = [
        {
          layerId: 'layer-1',
          batchId: 'batch-A',
          remainingQty: Quantity.fromDecimalString('5.000000'),
          unitCost: Money.fromDecimalString('8.0000', 'USD'),
        },
        {
          layerId: 'layer-2',
          batchId: 'batch-B',
          remainingQty: Quantity.fromDecimalString('5.000000'),
          unitCost: Money.fromDecimalString('10.0000', 'USD'),
        },
      ];

      const result = consumeFifoCostLayers({
        layers,
        qtyToConsume: Quantity.fromDecimalString('7.000000'),
        fallbackUnitCost: Money.fromDecimalString('10.0000', 'USD'),
        allowNegativeStock: false,
      });

      // 5 * $8.00 + 2 * $10.00 = $60.0000
      expect(result.totalCogs.toDecimalString()).toBe('60.0000');
      expect(result.updatedLayers[0]?.remainingQty.toDecimalString()).toBe(
        '0.000000',
      );
      expect(result.updatedLayers[1]?.remainingQty.toDecimalString()).toBe(
        '3.000000',
      );
      expect(result.uncoveredNegativeQty.toDecimalString()).toBe('0.000000');
    });

    it('handles customer returns for both RESTOCK_SELLABLE and WRITE_OFF_DAMAGED with balanced journals', () => {
      const baseState = {
        qtyOnHand: Quantity.fromDecimalString('10.000000'),
        movingAvgCost: Money.fromDecimalString('10.0000', 'USD'),
        totalInventoryValue: Money.fromDecimalString('100.0000', 'USD'),
      };

      const restockReturn = calculateSalesReturnImpact({
        currentState: baseState,
        returnQty: Quantity.fromDecimalString('2.000000'),
        capturedSaleUnitCost: Money.fromDecimalString('10.0000', 'USD'),
        netRevenueRefund: Money.fromDecimalString('30.0000', 'USD'),
        taxRefund: Money.fromDecimalString('5.4000', 'USD'),
        returnCondition: 'RESTOCK_SELLABLE',
      });
      expect(restockReturn.updatedMacState.qtyOnHand.toDecimalString()).toBe(
        '12.000000',
      );
      expect(restockReturn.inventoryAssetCostDelta.toDecimalString()).toBe(
        '20.0000',
      );
      assertBalancedJournal(restockReturn.journalLines, 'USD');

      const damagedReturn = calculateSalesReturnImpact({
        currentState: baseState,
        returnQty: Quantity.fromDecimalString('2.000000'),
        capturedSaleUnitCost: Money.fromDecimalString('10.0000', 'USD'),
        netRevenueRefund: Money.fromDecimalString('30.0000', 'USD'),
        taxRefund: Money.fromDecimalString('5.4000', 'USD'),
        returnCondition: 'WRITE_OFF_DAMAGED',
      });
      // Sellable stock does not increase for damaged return
      expect(damagedReturn.updatedMacState.qtyOnHand.toDecimalString()).toBe(
        '10.000000',
      );
      expect(damagedReturn.damagedInventoryDeltaQty.toDecimalString()).toBe(
        '2.000000',
      );
      expect(damagedReturn.damagedWriteOffExpense.toDecimalString()).toBe(
        '20.0000',
      );
      assertBalancedJournal(damagedReturn.journalLines, 'USD');
    });

    it('documents explicit accounting policy flags requiring specialist review', () => {
      expect(
        ACCOUNTING_POLICIES_REQUIRING_SPECIALIST_REVIEW.length,
      ).toBeGreaterThanOrEqual(4);
      expect(
        ACCOUNTING_POLICIES_REQUIRING_SPECIALIST_REVIEW.map((p) => p.policyId),
      ).toEqual(['ACC-POL-01', 'ACC-POL-02', 'ACC-POL-03', 'ACC-POL-04']);
    });
  });
});

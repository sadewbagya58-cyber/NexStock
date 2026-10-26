import { Money } from './money.js';
import { type Quantity } from './quantity.js';
import {
  type RoundingMode,
  divideAndRoundBigInt,
  parseDecimalStringToScaledBigInt,
} from './rounding.js';

/**
 * Tax rate scale: 6 decimal places for percentage rates (e.g. "18.0000" % => 0.180000).
 * 100% = 100_000_000n scaled percentage units.
 */
const PERCENTAGE_RATE_SCALE = 4;
const ONE_HUNDRED_PERCENT_SCALED = 1_000_000n; // 100.0000 %

export interface TaxRuleInput {
  readonly taxRateId: string;
  readonly name: string;
  /**
   * Percentage string (e.g. "18.0000" for 18% VAT, "2.5000" for 2.5% SSCL).
   */
  readonly ratePercentage: string;
  /**
   * If true, this tax is calculated on (netAmount + sum of prior non-compound taxes).
   * Note: Tax-inclusive extraction with compound taxes is rejected unless rates are non-compound
   * or sequentially ordered.
   */
  readonly isCompound: boolean;
}

export interface TaxComponentBreakdown {
  readonly taxRateId: string;
  readonly name: string;
  readonly ratePercentage: string;
  readonly taxableBase: Money;
  readonly taxAmount: Money;
}

export interface LineTaxCalculationResult {
  readonly grossLineAmount: Money;
  readonly discountAmount: Money;
  readonly netTaxableAmount: Money;
  readonly totalTaxAmount: Money;
  readonly lineTotalWithTax: Money;
  readonly taxes: readonly TaxComponentBreakdown[];
}

export function calculateLinePricingAndTax(params: {
  readonly unitPrice: Money;
  readonly quantity: Quantity;
  readonly lineDiscount?: Money;
  readonly isTaxInclusive: boolean;
  readonly taxRules: readonly TaxRuleInput[];
  readonly roundingMode?: RoundingMode;
}): LineTaxCalculationResult {
  const roundingMode = params.roundingMode ?? 'HALF_EVEN';
  const currency = params.unitPrice.currencyCode;

  const grossLineAmount = params.unitPrice
    .multiplyByQuantity(params.quantity, roundingMode)
    .roundToCurrencyMinorUnits(roundingMode);

  const discountAmount = (
    params.lineDiscount ?? Money.zero(currency)
  ).roundToCurrencyMinorUnits(roundingMode);
  if (discountAmount.isNegative()) {
    throw new RangeError('Line discount amount cannot be negative.');
  }
  if (discountAmount.compare(grossLineAmount) > 0) {
    throw new RangeError(
      'Line discount amount cannot exceed gross line amount.',
    );
  }

  const discountedLineAmount = grossLineAmount.subtract(discountAmount);

  if (params.taxRules.length === 0) {
    return {
      grossLineAmount,
      discountAmount,
      netTaxableAmount: discountedLineAmount,
      totalTaxAmount: Money.zero(currency),
      lineTotalWithTax: discountedLineAmount,
      taxes: [],
    };
  }

  const parsedRules = params.taxRules.map((rule) => {
    const rateScaled = parseDecimalStringToScaledBigInt(
      rule.ratePercentage,
      PERCENTAGE_RATE_SCALE,
      roundingMode,
    );
    if (rateScaled < 0n) {
      throw new RangeError(
        `Tax rate "${rule.name}" cannot be negative (${rule.ratePercentage}).`,
      );
    }
    return { ...rule, rateScaled };
  });

  if (!params.isTaxInclusive) {
    // Tax-Exclusive Calculation
    const netTaxableAmount = discountedLineAmount;
    const taxes: TaxComponentBreakdown[] = [];
    let accumulatedNonCompoundTax = Money.zero(currency);
    let totalTaxAmount = Money.zero(currency);

    for (const rule of parsedRules) {
      const taxableBase = rule.isCompound
        ? netTaxableAmount.add(accumulatedNonCompoundTax)
        : netTaxableAmount;

      const rawTaxScaled = divideAndRoundBigInt(
        taxableBase.scaledUnits * rule.rateScaled,
        ONE_HUNDRED_PERCENT_SCALED,
        roundingMode,
      );
      const taxAmount = Money.fromScaledUnits(
        rawTaxScaled,
        currency,
      ).roundToCurrencyMinorUnits(roundingMode);

      taxes.push({
        taxRateId: rule.taxRateId,
        name: rule.name,
        ratePercentage: rule.ratePercentage,
        taxableBase,
        taxAmount,
      });

      if (!rule.isCompound) {
        accumulatedNonCompoundTax = accumulatedNonCompoundTax.add(taxAmount);
      }
      totalTaxAmount = totalTaxAmount.add(taxAmount);
    }

    return {
      grossLineAmount,
      discountAmount,
      netTaxableAmount,
      totalTaxAmount,
      lineTotalWithTax: netTaxableAmount.add(totalTaxAmount),
      taxes,
    };
  }

  // Tax-Inclusive Calculation: discountedLineAmount already includes all taxes.
  // Effective multiplier M (scaled by ONE_HUNDRED_PERCENT_SCALED):
  // Let base = 100%, nonCompoundSum = sum(r_non_compound), compound applies on (1 + nonCompoundSum)
  let nonCompoundRateSum = 0n;
  for (const r of parsedRules) {
    if (!r.isCompound) {
      nonCompoundRateSum += r.rateScaled;
    }
  }

  let effectiveTotalRateScaled = nonCompoundRateSum;
  const nonCompoundFactor = ONE_HUNDRED_PERCENT_SCALED + nonCompoundRateSum;

  for (const r of parsedRules) {
    if (r.isCompound) {
      const effectiveCompoundRate = divideAndRoundBigInt(
        nonCompoundFactor * r.rateScaled,
        ONE_HUNDRED_PERCENT_SCALED,
        roundingMode,
      );
      effectiveTotalRateScaled += effectiveCompoundRate;
    }
  }

  const denominator = ONE_HUNDRED_PERCENT_SCALED + effectiveTotalRateScaled;
  const rawNetScaled = divideAndRoundBigInt(
    discountedLineAmount.scaledUnits * ONE_HUNDRED_PERCENT_SCALED,
    denominator,
    roundingMode,
  );
  const netTaxableAmount = Money.fromScaledUnits(
    rawNetScaled,
    currency,
  ).roundToCurrencyMinorUnits(roundingMode);
  const totalTaxToExtract = discountedLineAmount.subtract(netTaxableAmount);

  // Allocate totalTaxToExtract across tax rules so sum(taxes) === totalTaxToExtract without penny drift
  const weights = parsedRules.map((r) =>
    r.isCompound
      ? divideAndRoundBigInt(
          nonCompoundFactor * r.rateScaled,
          ONE_HUNDRED_PERCENT_SCALED,
          roundingMode,
        )
      : r.rateScaled,
  );

  const allocatedTaxes = totalTaxToExtract.allocateByWeights(
    weights,
    roundingMode,
  );
  let nonCompoundTaxSum = Money.zero(currency);
  const taxes: TaxComponentBreakdown[] = [];

  for (let i = 0; i < parsedRules.length; i++) {
    const rule = parsedRules[i]!;
    const taxAmount = allocatedTaxes[i]!;
    const taxableBase = rule.isCompound
      ? netTaxableAmount.add(nonCompoundTaxSum)
      : netTaxableAmount;

    taxes.push({
      taxRateId: rule.taxRateId,
      name: rule.name,
      ratePercentage: rule.ratePercentage,
      taxableBase,
      taxAmount,
    });

    if (!rule.isCompound) {
      nonCompoundTaxSum = nonCompoundTaxSum.add(taxAmount);
    }
  }

  return {
    grossLineAmount,
    discountAmount,
    netTaxableAmount,
    totalTaxAmount: totalTaxToExtract,
    lineTotalWithTax: discountedLineAmount,
    taxes,
  };
}

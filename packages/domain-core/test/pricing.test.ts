import { describe, expect, it } from 'vitest';
import {
  applyPricingRoundingRule,
  calculateSuggestedSellingPrice,
  computeActualMarginPct,
  computeActualMarkupPct,
  evaluateMarginHealth,
  PricingCalculationError,
  validateDiscountAgainstPolicy,
} from '../src/pricing.js';

describe('@nexstock/domain-core — Smart Pricing Engine', () => {
  it('computes PROFIT_MARGIN via Cost / (1 - Rate) without confusing with COST_MARKUP', () => {
    // Example from spec: Cost 100, Target Margin 25% -> 133.3333 (133.33 with NEAREST_0_01)
    const marginUnrounded = calculateSuggestedSellingPrice({
      cost: '100.0000',
      currencyCode: 'LKR',
      pricingMethod: 'PROFIT_MARGIN',
      targetPercentage: '25.00',
      roundingRule: 'NONE',
    });
    expect(marginUnrounded.suggestedPrice).toBe('133.3333');

    const marginCents = calculateSuggestedSellingPrice({
      cost: '100.0000',
      currencyCode: 'LKR',
      pricingMethod: 'PROFIT_MARGIN',
      targetPercentage: '25.00',
      roundingRule: 'NEAREST_0_01',
    });
    expect(marginCents.suggestedPrice).toBe('133.3300');
    expect(marginCents.finalMarginPct).toBe('25.00');

    // Cost Markup: Cost * (1 + Rate) -> 100 * 1.25 = 125.0000
    const markupRes = calculateSuggestedSellingPrice({
      cost: '100.0000',
      currencyCode: 'LKR',
      pricingMethod: 'COST_MARKUP',
      targetPercentage: '25.00',
      roundingRule: 'NONE',
    });
    expect(markupRes.suggestedPrice).toBe('125.0000');
    expect(markupRes.finalMarkupPct).toBe('25.00');
    expect(markupRes.finalMarginPct).toBe('20.00');
  });

  it('rejects PROFIT_MARGIN >= 100% while permitting COST_MARKUP >= 100%', () => {
    expect(() =>
      calculateSuggestedSellingPrice({
        cost: '100.0000',
        currencyCode: 'LKR',
        pricingMethod: 'PROFIT_MARGIN',
        targetPercentage: '100.00',
      }),
    ).toThrow(PricingCalculationError);

    expect(() =>
      calculateSuggestedSellingPrice({
        cost: '100.0000',
        currencyCode: 'LKR',
        pricingMethod: 'PROFIT_MARGIN',
        targetPercentage: '110.00',
      }),
    ).toThrow(/strictly less than 100%/);

    const highMarkup = calculateSuggestedSellingPrice({
      cost: '100.0000',
      currencyCode: 'LKR',
      pricingMethod: 'COST_MARKUP',
      targetPercentage: '150.00',
    });
    expect(highMarkup.suggestedPrice).toBe('250.0000');
  });

  it('applies rounding rules and clamps up to minSellingPrice floor', () => {
    expect(applyPricingRoundingRule(1_333_333n, 'NEAREST_1')).toBe(1_330_000n);
    expect(applyPricingRoundingRule(1_333_333n, 'CEIL_1')).toBe(1_340_000n);
    expect(applyPricingRoundingRule(1_333_333n, 'NEAREST_5')).toBe(1_350_000n);
    expect(applyPricingRoundingRule(1_333_333n, 'CEIL_10')).toBe(1_400_000n);
    expect(applyPricingRoundingRule(1_332_000n, 'NEAREST_0_50')).toBe(1_330_000n);
    expect(applyPricingRoundingRule(1_333_000n, 'NEAREST_0_50')).toBe(1_335_000n);

    const clamped = calculateSuggestedSellingPrice({
      cost: '100.0000',
      currencyCode: 'LKR',
      pricingMethod: 'COST_MARKUP',
      targetPercentage: '10.00',
      roundingRule: 'NEAREST_1',
      minSellingPrice: '118.0000',
    });
    expect(clamped.roundedPrice).toBe('110.0000');
    expect(clamped.suggestedPrice).toBe('118.0000');
    expect(clamped.clampedToMinPrice).toBe(true);
  });

  it('evaluates margin health, negative margins, and max discount / floor policies', () => {
    expect(
      computeActualMarginPct({
        cost: '120.0000',
        sellingPrice: '100.0000',
        currencyCode: 'LKR',
      }),
    ).toBe('-20.00');

    expect(
      computeActualMarkupPct({
        cost: '100.0000',
        sellingPrice: '150.0000',
        currencyCode: 'LKR',
      }),
    ).toBe('50.00');

    const health = evaluateMarginHealth({
      cost: '100.0000',
      sellingPrice: '105.0000',
      currencyCode: 'LKR',
      minMarginPct: '10.00',
      minSellingPrice: '110.0000',
    });
    expect(health.isZeroOrNegativeMargin).toBe(false);
    expect(health.isLowMargin).toBe(true);
    expect(health.isBelowMinSellingPrice).toBe(true);

    const negHealth = evaluateMarginHealth({
      cost: '100.0000',
      sellingPrice: '100.0000',
      currencyCode: 'LKR',
    });
    expect(negHealth.isZeroOrNegativeMargin).toBe(true);

    const badDiscountPct = validateDiscountAgainstPolicy({
      grossLineTotal: '1000.0000',
      discountAmount: '150.0000',
      baseQty: '1.000000',
      maxDiscountPct: '10.00',
      minSellingPrice: '800.0000',
      currencyCode: 'LKR',
    });
    expect(badDiscountPct.allowed).toBe(false);
    expect(badDiscountPct.appliedDiscountPct).toBe('15.00');

    const badFloor = validateDiscountAgainstPolicy({
      grossLineTotal: '1000.0000',
      discountAmount: '80.0000',
      baseQty: '1.000000',
      maxDiscountPct: '20.00',
      minSellingPrice: '950.0000',
      currencyCode: 'LKR',
    });
    expect(badFloor.allowed).toBe(false);
    expect(badFloor.reason).toContain('minimum selling price floor');
  });
});

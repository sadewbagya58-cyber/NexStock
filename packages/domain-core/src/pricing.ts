import { Money } from './money.js';
import {
  divideAndRoundBigInt,
  formatScaledBigIntToDecimalString,
  parseDecimalStringToScaledBigInt,
} from './rounding.js';

export type PricingMethod = 'PROFIT_MARGIN' | 'COST_MARKUP';

export type PricingCostBasis =
  | 'LAST_PURCHASE_COST'
  | 'MOVING_AVERAGE_COST'
  | 'HIGHEST_RECENT_COST';

export type PricingRoundingRule =
  | 'NONE'
  | 'NEAREST_0_01'
  | 'NEAREST_0_50'
  | 'NEAREST_1'
  | 'NEAREST_5'
  | 'NEAREST_10'
  | 'CEIL_0_50'
  | 'CEIL_1'
  | 'CEIL_5'
  | 'CEIL_10';

export type PricingErrorCode =
  | 'PRICING_INVALID_COST'
  | 'PRICING_INVALID_MARGIN_RATE'
  | 'PRICING_INVALID_MARKUP_RATE'
  | 'PRICING_INVALID_DISCOUNT_PCT'
  | 'PRICING_MIN_PRICE_VIOLATION';

export class PricingCalculationError extends Error {
  public readonly code: PricingErrorCode;

  public constructor(code: PricingErrorCode, message: string) {
    super(message);
    this.name = 'PricingCalculationError';
    this.code = code;
  }
}

const MONEY_SCALE_FACTOR = 10_000n;
const PCT_SCALE = 4;
const PCT_100_SCALED = 1_000_000n; // 100.0000% = 1_000_000n
const PCT_OUTPUT_SCALE = 2;

function roundNearestMultiple(value: bigint, step: bigint): bigint {
  if (step <= 0n) return value;
  const quotient = divideAndRoundBigInt(value, step, 'HALF_UP');
  return quotient * step;
}

function ceilMultiple(value: bigint, step: bigint): bigint {
  if (step <= 0n || value <= 0n) return value;
  const remainder = value % step;
  if (remainder === 0n) return value;
  return value + (step - remainder);
}

/**
 * Applies a configured price rounding rule to a Money value represented in 10^-4 scaled bigint units.
 */
export function applyPricingRoundingRule(
  priceScaledUnits: bigint,
  rule: PricingRoundingRule = 'NONE',
): bigint {
  switch (rule) {
    case 'NONE':
      return priceScaledUnits;
    case 'NEAREST_0_01':
      return roundNearestMultiple(priceScaledUnits, 100n);
    case 'NEAREST_0_50':
      return roundNearestMultiple(priceScaledUnits, 5_000n);
    case 'NEAREST_1':
      return roundNearestMultiple(priceScaledUnits, MONEY_SCALE_FACTOR);
    case 'NEAREST_5':
      return roundNearestMultiple(priceScaledUnits, 5n * MONEY_SCALE_FACTOR);
    case 'NEAREST_10':
      return roundNearestMultiple(priceScaledUnits, 10n * MONEY_SCALE_FACTOR);
    case 'CEIL_0_50':
      return ceilMultiple(priceScaledUnits, 5_000n);
    case 'CEIL_1':
      return ceilMultiple(priceScaledUnits, MONEY_SCALE_FACTOR);
    case 'CEIL_5':
      return ceilMultiple(priceScaledUnits, 5n * MONEY_SCALE_FACTOR);
    case 'CEIL_10':
      return ceilMultiple(priceScaledUnits, 10n * MONEY_SCALE_FACTOR);
    default:
      return priceScaledUnits;
  }
}

function formatScaledPctTo2Decimals(pctScaled4: bigint): string {
  const scaled2 = divideAndRoundBigInt(pctScaled4, 100n, 'HALF_EVEN');
  return formatScaledBigIntToDecimalString(scaled2, PCT_OUTPUT_SCALE);
}

/**
 * Computes exact Profit Margin % = ((SellingPrice - Cost) / SellingPrice) * 100.
 */
export function computeActualMarginPct(params: {
  readonly cost: string;
  readonly sellingPrice: string;
  readonly currencyCode: string;
}): string {
  const costMoney = Money.fromDecimalString(params.cost, params.currencyCode);
  const priceMoney = Money.fromDecimalString(
    params.sellingPrice,
    params.currencyCode,
  );

  if (priceMoney.scaledUnits === 0n) {
    if (costMoney.scaledUnits === 0n) return '0.00';
    return costMoney.scaledUnits > 0n ? '-100.00' : '100.00';
  }

  const profitScaled = priceMoney.scaledUnits - costMoney.scaledUnits;
  // Return scaled by 10^2 (e.g. 2500 -> "25.00")
  const pctScaled2 = divideAndRoundBigInt(
    profitScaled * 10_000n,
    priceMoney.scaledUnits,
    'HALF_EVEN',
  );
  return formatScaledBigIntToDecimalString(pctScaled2, PCT_OUTPUT_SCALE);
}

/**
 * Computes exact Cost Markup % = ((SellingPrice - Cost) / Cost) * 100.
 */
export function computeActualMarkupPct(params: {
  readonly cost: string;
  readonly sellingPrice: string;
  readonly currencyCode: string;
}): string {
  const costMoney = Money.fromDecimalString(params.cost, params.currencyCode);
  const priceMoney = Money.fromDecimalString(
    params.sellingPrice,
    params.currencyCode,
  );

  if (costMoney.scaledUnits === 0n) {
    return priceMoney.scaledUnits > 0n ? '100.00' : '0.00';
  }

  const profitScaled = priceMoney.scaledUnits - costMoney.scaledUnits;
  const pctScaled2 = divideAndRoundBigInt(
    profitScaled * 10_000n,
    costMoney.scaledUnits,
    'HALF_EVEN',
  );
  return formatScaledBigIntToDecimalString(pctScaled2, PCT_OUTPUT_SCALE);
}

export interface SuggestedPriceCalculationResult {
  readonly cost: string;
  readonly pricingMethod: PricingMethod;
  readonly targetPercentage: string;
  readonly roundingRule: PricingRoundingRule;
  readonly unroundedPrice: string;
  readonly roundedPrice: string;
  readonly suggestedPrice: string;
  readonly clampedToMinPrice: boolean;
  readonly finalMarginPct: string;
  readonly finalMarkupPct: string;
}

/**
 * Computes a deterministic suggested selling price using pure BigInt fixed-point arithmetic:
 * - PROFIT_MARGIN: Selling Price = Cost / (1 - Margin Rate), strictly rejecting Margin Rate >= 100%
 * - COST_MARKUP:   Selling Price = Cost * (1 + Markup Rate)
 * Applies configured rounding rule and optional minimum selling price floor.
 */
export function calculateSuggestedSellingPrice(params: {
  readonly cost: string;
  readonly currencyCode: string;
  readonly pricingMethod: PricingMethod;
  readonly targetPercentage: string;
  readonly roundingRule?: PricingRoundingRule;
  readonly minSellingPrice?: string | null;
}): SuggestedPriceCalculationResult {
  const costMoney = Money.fromDecimalString(params.cost, params.currencyCode);
  if (costMoney.isNegative()) {
    throw new PricingCalculationError(
      'PRICING_INVALID_COST',
      'Product cost cannot be negative when calculating suggested selling price.',
    );
  }

  let pctScaled4: bigint;
  try {
    pctScaled4 = parseDecimalStringToScaledBigInt(
      params.targetPercentage,
      PCT_SCALE,
      'HALF_EVEN',
    );
  } catch {
    throw new PricingCalculationError(
      params.pricingMethod === 'PROFIT_MARGIN'
        ? 'PRICING_INVALID_MARGIN_RATE'
        : 'PRICING_INVALID_MARKUP_RATE',
      `Invalid target percentage "${params.targetPercentage}".`,
    );
  }

  if (pctScaled4 < 0n) {
    throw new PricingCalculationError(
      params.pricingMethod === 'PROFIT_MARGIN'
        ? 'PRICING_INVALID_MARGIN_RATE'
        : 'PRICING_INVALID_MARKUP_RATE',
      'Target percentage cannot be negative.',
    );
  }

  let unroundedScaled: bigint;
  if (params.pricingMethod === 'PROFIT_MARGIN') {
    if (pctScaled4 >= PCT_100_SCALED) {
      throw new PricingCalculationError(
        'PRICING_INVALID_MARGIN_RATE',
        `Profit margin percentage (${params.targetPercentage}%) must be strictly less than 100%.`,
      );
    }
    const denominator = PCT_100_SCALED - pctScaled4;
    unroundedScaled = divideAndRoundBigInt(
      costMoney.scaledUnits * PCT_100_SCALED,
      denominator,
      'HALF_EVEN',
    );
  } else {
    const multiplierScaled = PCT_100_SCALED + pctScaled4;
    unroundedScaled = divideAndRoundBigInt(
      costMoney.scaledUnits * multiplierScaled,
      PCT_100_SCALED,
      'HALF_EVEN',
    );
  }

  const rule = params.roundingRule ?? 'NONE';
  const roundedScaled = applyPricingRoundingRule(unroundedScaled, rule);

  let finalScaled = roundedScaled;
  let clampedToMinPrice = false;
  if (params.minSellingPrice) {
    const minPriceMoney = Money.fromDecimalString(
      params.minSellingPrice,
      params.currencyCode,
    );
    if (minPriceMoney.scaledUnits > finalScaled) {
      finalScaled = minPriceMoney.scaledUnits;
      clampedToMinPrice = true;
    }
  }

  const unroundedPrice = Money.fromScaledUnits(
    unroundedScaled,
    params.currencyCode,
  ).toDecimalString();
  const roundedPrice = Money.fromScaledUnits(
    roundedScaled,
    params.currencyCode,
  ).toDecimalString();
  const suggestedPrice = Money.fromScaledUnits(
    finalScaled,
    params.currencyCode,
  ).toDecimalString();

  return {
    cost: costMoney.toDecimalString(),
    pricingMethod: params.pricingMethod,
    targetPercentage: formatScaledPctTo2Decimals(pctScaled4),
    roundingRule: rule,
    unroundedPrice,
    roundedPrice,
    suggestedPrice,
    clampedToMinPrice,
    finalMarginPct: computeActualMarginPct({
      cost: costMoney.toDecimalString(),
      sellingPrice: suggestedPrice,
      currencyCode: params.currencyCode,
    }),
    finalMarkupPct: computeActualMarkupPct({
      cost: costMoney.toDecimalString(),
      sellingPrice: suggestedPrice,
      currencyCode: params.currencyCode,
    }),
  };
}

export interface MarginHealthEvaluation {
  readonly actualMarginPct: string;
  readonly actualMarkupPct: string;
  readonly isZeroOrNegativeMargin: boolean;
  readonly isBelowMinSellingPrice: boolean;
  readonly isLowMargin: boolean;
}

export function evaluateMarginHealth(params: {
  readonly cost: string;
  readonly sellingPrice: string;
  readonly currencyCode: string;
  readonly minMarginPct?: string | null;
  readonly minSellingPrice?: string | null;
}): MarginHealthEvaluation {
  const costMoney = Money.fromDecimalString(params.cost, params.currencyCode);
  const priceMoney = Money.fromDecimalString(
    params.sellingPrice,
    params.currencyCode,
  );
  const actualMarginPct = computeActualMarginPct({
    cost: costMoney.toDecimalString(),
    sellingPrice: priceMoney.toDecimalString(),
    currencyCode: params.currencyCode,
  });
  const actualMarkupPct = computeActualMarkupPct({
    cost: costMoney.toDecimalString(),
    sellingPrice: priceMoney.toDecimalString(),
    currencyCode: params.currencyCode,
  });

  const isZeroOrNegativeMargin =
    priceMoney.scaledUnits <= costMoney.scaledUnits;

  let isBelowMinSellingPrice = false;
  if (params.minSellingPrice) {
    const minPrice = Money.fromDecimalString(
      params.minSellingPrice,
      params.currencyCode,
    );
    isBelowMinSellingPrice = priceMoney.scaledUnits < minPrice.scaledUnits;
  }

  let isLowMargin = false;
  if (params.minMarginPct) {
    const marginScaled2 = parseDecimalStringToScaledBigInt(
      actualMarginPct,
      PCT_OUTPUT_SCALE,
      'HALF_EVEN',
    );
    const minMarginScaled2 = parseDecimalStringToScaledBigInt(
      params.minMarginPct,
      PCT_OUTPUT_SCALE,
      'HALF_EVEN',
    );
    isLowMargin = marginScaled2 < minMarginScaled2;
  }

  return {
    actualMarginPct,
    actualMarkupPct,
    isZeroOrNegativeMargin,
    isBelowMinSellingPrice,
    isLowMargin,
  };
}

/**
 * Validates a line/order discount against product max_discount_pct and min_selling_price policies.
 */
export function validateDiscountAgainstPolicy(params: {
  readonly grossLineTotal: string;
  readonly discountAmount: string;
  readonly baseQty?: string;
  readonly maxDiscountPct?: string | null;
  readonly minSellingPrice?: string | null;
  readonly currencyCode: string;
}): {
  readonly allowed: boolean;
  readonly appliedDiscountPct: string;
  readonly reason?: string;
} {
  const grossMoney = Money.fromDecimalString(
    params.grossLineTotal,
    params.currencyCode,
  );
  const discountMoney = Money.fromDecimalString(
    params.discountAmount,
    params.currencyCode,
  );

  if (discountMoney.scaledUnits <= 0n || grossMoney.scaledUnits <= 0n) {
    return { allowed: true, appliedDiscountPct: '0.00' };
  }

  const appliedPctScaled2 = divideAndRoundBigInt(
    discountMoney.scaledUnits * 10_000n,
    grossMoney.scaledUnits,
    'HALF_EVEN',
  );
  const appliedDiscountPct = formatScaledBigIntToDecimalString(
    appliedPctScaled2,
    PCT_OUTPUT_SCALE,
  );

  if (params.maxDiscountPct !== undefined && params.maxDiscountPct !== null) {
    const maxPctScaled2 = parseDecimalStringToScaledBigInt(
      params.maxDiscountPct,
      PCT_OUTPUT_SCALE,
      'HALF_EVEN',
    );
    if (appliedPctScaled2 > maxPctScaled2) {
      return {
        allowed: false,
        appliedDiscountPct,
        reason: `Discount of ${appliedDiscountPct}% exceeds maximum allowed discount policy (${formatScaledBigIntToDecimalString(maxPctScaled2, PCT_OUTPUT_SCALE)}%).`,
      };
    }
  }

  if (
    params.minSellingPrice &&
    params.baseQty
  ) {
    const qtyScaled6 = parseDecimalStringToScaledBigInt(params.baseQty, 6);
    if (qtyScaled6 > 0n) {
      const minTotalScaled = divideAndRoundBigInt(
        Money.fromDecimalString(params.minSellingPrice, params.currencyCode)
          .scaledUnits * qtyScaled6,
        1_000_000n,
        'HALF_EVEN',
      );
      const netLineScaled = grossMoney.scaledUnits - discountMoney.scaledUnits;
      if (netLineScaled < minTotalScaled) {
        return {
          allowed: false,
          appliedDiscountPct,
          reason: `Net discounted line total (${Money.fromScaledUnits(netLineScaled, params.currencyCode).toDecimalString()}) falls below minimum selling price floor.`,
        };
      }
    }
  }

  return { allowed: true, appliedDiscountPct };
}

export type BatchPricingMode = 'EXPLICIT' | 'INHERIT_PRODUCT';
export type BatchPricingFallbackPolicy = 'BLOCK_MISSING' | 'ALLOW_PRODUCT_FALLBACK';

export type BatchPriceResolutionResult =
  | {
      readonly ok: true;
      readonly resolvedPrice: string;
      readonly source:
        | 'EXPLICIT_BATCH_PRICE'
        | 'POS_BATCH_OVERRIDE'
        | 'BRANCH_DEFAULT_FALLBACK'
        | 'PRODUCT_DEFAULT_FALLBACK';
      readonly minSellingPrice: string | null;
      readonly maxDiscountPct: string | null;
    }
  | {
      readonly ok: false;
      readonly errorCode:
        | 'POS_BATCH_PRICE_REQUIRED'
        | 'BATCH_MIN_PRICE_VIOLATION';
      readonly reason: string;
    };

/**
 * Resolves the authoritative selling price for a batch-tracked stock unit
 * enforcing the exact 4-level NexStock Batch Pricing Precedence Chain:
 *  1. Authorized POS/Supervisor Batch Price Override (bounded by floor)
 *  2. Approved Explicit Batch Selling Price (`inventory_batches.selling_price`)
 *  3. Restricted Product/Branch Default Fallback (ONLY when `INHERIT_PRODUCT` + `ALLOW_PRODUCT_FALLBACK` + `!requireBatchSellingPrice`)
 *  4. Mandatory Missing Batch Price Block (`POS_BATCH_PRICE_REQUIRED`)
 */
export function resolveEffectiveBatchPrice(params: {
  readonly batchNumber: string;
  readonly batchSellingPrice?: string | null;
  readonly batchMinSellingPrice?: string | null;
  readonly batchMaxDiscountPct?: string | null;
  readonly batchPricingMode?: BatchPricingMode | null;
  readonly productSellingPrice?: string | null;
  readonly productMinSellingPrice?: string | null;
  readonly productMaxDiscountPct?: string | null;
  readonly branchSellingPrice?: string | null;
  readonly branchMinSellingPrice?: string | null;
  readonly branchMaxDiscountPct?: string | null;
  readonly fallbackPolicy?: BatchPricingFallbackPolicy | null;
  readonly requireBatchSellingPrice?: boolean | null;
  readonly overrideSellingPrice?: string | null;
  readonly overrideAuthorized?: boolean;
  readonly currencyCode: string;
}): BatchPriceResolutionResult {
  const effectiveMinFloor =
    params.batchMinSellingPrice ??
    params.branchMinSellingPrice ??
    params.productMinSellingPrice ??
    null;

  const effectiveMaxDiscountPct =
    params.batchMaxDiscountPct ??
    params.branchMaxDiscountPct ??
    params.productMaxDiscountPct ??
    null;

  // Level 2: Authorized Batch Override (checked against min selling price floor)
  if (
    params.overrideAuthorized &&
    params.overrideSellingPrice !== undefined &&
    params.overrideSellingPrice !== null
  ) {
    const overrideMoney = Money.fromDecimalString(
      params.overrideSellingPrice,
      params.currencyCode,
    );
    if (overrideMoney.scaledUnits <= 0n) {
      return {
        ok: false,
        errorCode: 'POS_BATCH_PRICE_REQUIRED',
        reason: `Batch ${params.batchNumber} override selling price must be strictly positive.`,
      };
    }
    if (effectiveMinFloor !== null) {
      const floorMoney = Money.fromDecimalString(
        effectiveMinFloor,
        params.currencyCode,
      );
      if (overrideMoney.scaledUnits < floorMoney.scaledUnits) {
        return {
          ok: false,
          errorCode: 'BATCH_MIN_PRICE_VIOLATION',
          reason: `Override price (${overrideMoney.toDecimalString()}) for batch ${params.batchNumber} is below minimum floor (${floorMoney.toDecimalString()}).`,
        };
      }
    }
    return {
      ok: true,
      resolvedPrice: overrideMoney.toDecimalString(),
      source: 'POS_BATCH_OVERRIDE',
      minSellingPrice: effectiveMinFloor,
      maxDiscountPct: effectiveMaxDiscountPct,
    };
  }

  // Level 1: Explicit Batch Selling Price
  const mode: BatchPricingMode = params.batchPricingMode ?? 'EXPLICIT';
  if (
    params.batchSellingPrice !== undefined &&
    params.batchSellingPrice !== null &&
    params.batchSellingPrice.trim() !== ''
  ) {
    const batchMoney = Money.fromDecimalString(
      params.batchSellingPrice,
      params.currencyCode,
    );
    if (batchMoney.scaledUnits > 0n) {
      return {
        ok: true,
        resolvedPrice: batchMoney.toDecimalString(),
        source: 'EXPLICIT_BATCH_PRICE',
        minSellingPrice: effectiveMinFloor,
        maxDiscountPct: effectiveMaxDiscountPct,
      };
    }
  }

  // Level 3: Restricted Product / Branch Fallback
  const fallbackPolicy: BatchPricingFallbackPolicy =
    params.fallbackPolicy ?? 'ALLOW_PRODUCT_FALLBACK';
  const requireBatchPrice = Boolean(params.requireBatchSellingPrice);

  if (
    mode === 'INHERIT_PRODUCT' &&
    fallbackPolicy === 'ALLOW_PRODUCT_FALLBACK' &&
    !requireBatchPrice
  ) {
    if (
      params.branchSellingPrice !== undefined &&
      params.branchSellingPrice !== null &&
      params.branchSellingPrice.trim() !== ''
    ) {
      const branchMoney = Money.fromDecimalString(
        params.branchSellingPrice,
        params.currencyCode,
      );
      if (branchMoney.scaledUnits > 0n) {
        return {
          ok: true,
          resolvedPrice: branchMoney.toDecimalString(),
          source: 'BRANCH_DEFAULT_FALLBACK',
          minSellingPrice: effectiveMinFloor,
          maxDiscountPct: effectiveMaxDiscountPct,
        };
      }
    }

    if (
      params.productSellingPrice !== undefined &&
      params.productSellingPrice !== null &&
      params.productSellingPrice.trim() !== ''
    ) {
      const productMoney = Money.fromDecimalString(
        params.productSellingPrice,
        params.currencyCode,
      );
      if (productMoney.scaledUnits > 0n) {
        return {
          ok: true,
          resolvedPrice: productMoney.toDecimalString(),
          source: 'PRODUCT_DEFAULT_FALLBACK',
          minSellingPrice: effectiveMinFloor,
          maxDiscountPct: effectiveMaxDiscountPct,
        };
      }
    }
  }

  // Level 4: Mandatory Missing Batch Price Block
  return {
    ok: false,
    errorCode: 'POS_BATCH_PRICE_REQUIRED',
    reason: `Batch ${params.batchNumber} has no approved selling price configured.`,
  };
}

import { Money } from './money.js';
import { QUANTITY_SCALE, QUANTITY_SCALE_FACTOR, Quantity } from './quantity.js';
import {
  type RoundingMode,
  divideAndRoundBigInt,
  formatScaledBigIntToDecimalString,
  parseDecimalStringToScaledBigInt,
} from './rounding.js';

export type MeasurementCategory = 'WEIGHT' | 'VOLUME' | 'COUNT' | 'LENGTH';

export interface UomDefinition {
  readonly code: string;
  readonly name: string;
  readonly category: MeasurementCategory;
  readonly baseUnitCode: string;
  /** Ratio in base-unit terms expressed at 10^-6 scale (e.g., G -> KG = 1000n micro = 0.001 KG) */
  readonly conversionToBaseMicro: bigint;
  readonly decimalPrecision: number;
  readonly isFractional: boolean;
}

export const CANONICAL_UOM_CATALOG: Readonly<Record<string, UomDefinition>> = {
  KG: {
    code: 'KG',
    name: 'Kilogram',
    category: 'WEIGHT',
    baseUnitCode: 'KG',
    conversionToBaseMicro: 1_000_000n,
    decimalPrecision: 3,
    isFractional: true,
  },
  G: {
    code: 'G',
    name: 'Gram',
    category: 'WEIGHT',
    baseUnitCode: 'KG',
    conversionToBaseMicro: 1_000n,
    decimalPrecision: 3,
    isFractional: true,
  },
  MG: {
    code: 'MG',
    name: 'Milligram',
    category: 'WEIGHT',
    baseUnitCode: 'KG',
    conversionToBaseMicro: 1n,
    decimalPrecision: 0,
    isFractional: false,
  },
  L: {
    code: 'L',
    name: 'Liter',
    category: 'VOLUME',
    baseUnitCode: 'L',
    conversionToBaseMicro: 1_000_000n,
    decimalPrecision: 3,
    isFractional: true,
  },
  ML: {
    code: 'ML',
    name: 'Milliliter',
    category: 'VOLUME',
    baseUnitCode: 'L',
    conversionToBaseMicro: 1_000n,
    decimalPrecision: 2,
    isFractional: true,
  },
  M: {
    code: 'M',
    name: 'Meter',
    category: 'LENGTH',
    baseUnitCode: 'M',
    conversionToBaseMicro: 1_000_000n,
    decimalPrecision: 3,
    isFractional: true,
  },
  CM: {
    code: 'CM',
    name: 'Centimeter',
    category: 'LENGTH',
    baseUnitCode: 'M',
    conversionToBaseMicro: 10_000n,
    decimalPrecision: 2,
    isFractional: true,
  },
  MM: {
    code: 'MM',
    name: 'Millimeter',
    category: 'LENGTH',
    baseUnitCode: 'M',
    conversionToBaseMicro: 1_000n,
    decimalPrecision: 0,
    isFractional: false,
  },
  PCS: {
    code: 'PCS',
    name: 'Pieces',
    category: 'COUNT',
    baseUnitCode: 'PCS',
    conversionToBaseMicro: 1_000_000n,
    decimalPrecision: 0,
    isFractional: false,
  },
  UNIT: {
    code: 'UNIT',
    name: 'Unit',
    category: 'COUNT',
    baseUnitCode: 'PCS',
    conversionToBaseMicro: 1_000_000n,
    decimalPrecision: 0,
    isFractional: false,
  },
  DOZEN: {
    code: 'DOZEN',
    name: 'Dozen (12 pcs)',
    category: 'COUNT',
    baseUnitCode: 'PCS',
    conversionToBaseMicro: 12_000_000n,
    decimalPrecision: 0,
    isFractional: false,
  },
  PACK: {
    code: 'PACK',
    name: 'Pack',
    category: 'COUNT',
    baseUnitCode: 'PCS',
    conversionToBaseMicro: 1_000_000n,
    decimalPrecision: 0,
    isFractional: false,
  },
  BOX: {
    code: 'BOX',
    name: 'Box',
    category: 'COUNT',
    baseUnitCode: 'PCS',
    conversionToBaseMicro: 1_000_000n,
    decimalPrecision: 0,
    isFractional: false,
  },
  BAG: {
    code: 'BAG',
    name: 'Bag',
    category: 'COUNT',
    baseUnitCode: 'PCS',
    conversionToBaseMicro: 1_000_000n,
    decimalPrecision: 0,
    isFractional: false,
  },
};

export interface ProductUomConversionInput {
  readonly uomCode: string;
  readonly conversionFactorToBase: string;
}

export class UomConversionError extends Error {
  readonly code:
    | 'UOM_CROSS_DIMENSION_REJECTED'
    | 'UOM_CONVERSION_NOT_FOUND'
    | 'UOM_INVALID_QUANTITY';

  constructor(
    code:
      | 'UOM_CROSS_DIMENSION_REJECTED'
      | 'UOM_CONVERSION_NOT_FOUND'
      | 'UOM_INVALID_QUANTITY',
    message: string,
  ) {
    super(message);
    this.name = 'UomConversionError';
    this.code = code;
  }
}

function normalizeCode(uom: string): string {
  return uom.trim().toUpperCase();
}

/**
 * Resolves the exact rational conversion ratio (`numerator / denominator`) from `fromUom` to `toUom`.
 * Strictly enforces dimensional compatibility (`WEIGHT` <-> `WEIGHT`, `VOLUME` <-> `VOLUME`, `LENGTH` <-> `LENGTH`,
 * `COUNT` <-> `COUNT`). Cross-dimension `WEIGHT` <-> `VOLUME` is rejected unless `densityGPerMl` is explicitly
 * provided by the product configuration.
 *
 * Product-specific `product_unit_conversions` (`productBaseUom` + custom pack/bag/box ratios) take precedence
 * when mapping custom packaging units to the product base UOM.
 */
export function resolveUomRationalFactor(params: {
  readonly fromUom: string;
  readonly toUom: string;
  readonly productBaseUom?: string;
  readonly customConversions?: readonly ProductUomConversionInput[];
  readonly densityGPerMl?: string | null;
}): {
  readonly numerator: bigint;
  readonly denominator: bigint;
  readonly factorDecimal6: string;
} {
  const fromCode = normalizeCode(params.fromUom);
  const toCode = normalizeCode(params.toUom);

  if (fromCode === toCode) {
    return {
      numerator: 1n,
      denominator: 1n,
      factorDecimal6: '1.000000',
    };
  }

  const productBase = params.productBaseUom
    ? normalizeCode(params.productBaseUom)
    : undefined;

  // Check product-specific conversions when converting to/from productBase
  if (productBase && params.customConversions && params.customConversions.length > 0) {
    const customMap = new Map<string, bigint>();
    customMap.set(productBase, QUANTITY_SCALE_FACTOR);
    for (const c of params.customConversions) {
      const code = normalizeCode(c.uomCode);
      const factorMicro = parseDecimalStringToScaledBigInt(
        c.conversionFactorToBase,
        QUANTITY_SCALE,
      );
      if (factorMicro > 0n) {
        customMap.set(code, factorMicro);
      }
    }

    const fromCustom = customMap.get(fromCode);
    const toCustom = customMap.get(toCode);
    if (fromCustom !== undefined && toCustom !== undefined) {
      // If both units are in canonical catalog with distinct categories (unless one is non-standard like BAG/BOX),
      // enforce dimension safety first!
      const defFrom = CANONICAL_UOM_CATALOG[fromCode];
      const defTo = CANONICAL_UOM_CATALOG[toCode];
      if (
        defFrom &&
        defTo &&
        defFrom.category !== defTo.category &&
        !isPackagingCountOverride(fromCode) &&
        !isPackagingCountOverride(toCode)
      ) {
        // Explicit custom conversion overrides only apply for packaging or when density is enabled
        if (
          !(
            params.densityGPerMl &&
            isWeightVolumePair(defFrom.category, defTo.category)
          )
        ) {
          throw new UomConversionError(
            'UOM_CROSS_DIMENSION_REJECTED',
            `Cannot convert incompatible dimensions from ${fromCode} (${defFrom.category}) to ${toCode} (${defTo.category}) without explicit density configuration.`,
          );
        }
      }
      const scaledFactor = divideAndRoundBigInt(
        fromCustom * QUANTITY_SCALE_FACTOR,
        toCustom,
        'HALF_EVEN',
      );
      return {
        numerator: fromCustom,
        denominator: toCustom,
        factorDecimal6: formatScaledBigIntToDecimalString(
          scaledFactor,
          QUANTITY_SCALE,
        ),
      };
    }

    // Chained lookup: e.g. fromCode in canonical catalog -> productBase -> toCode custom (or reverse)
    if (fromCode !== productBase && toCode === productBase && fromCustom !== undefined) {
      return {
        numerator: fromCustom,
        denominator: QUANTITY_SCALE_FACTOR,
        factorDecimal6: formatScaledBigIntToDecimalString(
          fromCustom,
          QUANTITY_SCALE,
        ),
      };
    }
  }

  const defFrom = CANONICAL_UOM_CATALOG[fromCode];
  const defTo = CANONICAL_UOM_CATALOG[toCode];

  if (!defFrom || !defTo) {
    throw new UomConversionError(
      'UOM_CONVERSION_NOT_FOUND',
      `No unit conversion configured between "${fromCode}" and "${toCode}".`,
    );
  }

  if (defFrom.category === defTo.category) {
    // Same physical dimension (KG/G/MG, L/ML, M/CM/MM, PCS/UNIT/DOZEN/...)
    const numerator = defFrom.conversionToBaseMicro;
    const denominator = defTo.conversionToBaseMicro;
    const scaled = divideAndRoundBigInt(
      numerator * QUANTITY_SCALE_FACTOR,
      denominator,
      'HALF_EVEN',
    );
    return {
      numerator,
      denominator,
      factorDecimal6: formatScaledBigIntToDecimalString(scaled, QUANTITY_SCALE),
    };
  }

  // Cross-dimension conversion (only allowed for WEIGHT <-> VOLUME with positive density g/mL)
  if (
    params.densityGPerMl &&
    isWeightVolumePair(defFrom.category, defTo.category)
  ) {
    const densityMicro = parseDecimalStringToScaledBigInt(
      params.densityGPerMl,
      QUANTITY_SCALE,
    );
    if (densityMicro <= 0n) {
      throw new UomConversionError(
        'UOM_INVALID_QUANTITY',
        'Density (g/mL) must be strictly positive.',
      );
    }
    // Recall: 1 KG = 1000 G, 1 L = 1000 ML, and density (g/mL) == (kg/L) numerically!
    // If from=WEIGHT and to=VOLUME: vol_L = weight_kg / density_kg_per_L
    // numerator/denominator = (fromToKg / (toToL * density))
    let numerator: bigint;
    let denominator: bigint;
    if (defFrom.category === 'WEIGHT' && defTo.category === 'VOLUME') {
      numerator = defFrom.conversionToBaseMicro * QUANTITY_SCALE_FACTOR;
      denominator = defTo.conversionToBaseMicro * densityMicro;
    } else {
      // VOLUME -> WEIGHT: weight_kg = vol_L * density_kg_per_L
      numerator = defFrom.conversionToBaseMicro * densityMicro;
      denominator = defTo.conversionToBaseMicro * QUANTITY_SCALE_FACTOR;
    }
    const scaled = divideAndRoundBigInt(
      numerator * QUANTITY_SCALE_FACTOR,
      denominator,
      'HALF_EVEN',
    );
    return {
      numerator,
      denominator,
      factorDecimal6: formatScaledBigIntToDecimalString(scaled, QUANTITY_SCALE),
    };
  }

  throw new UomConversionError(
    'UOM_CROSS_DIMENSION_REJECTED',
    `Incompatible unit dimensions: cannot convert "${fromCode}" (${defFrom.category}) to "${toCode}" (${defTo.category}).`,
  );
}

function isPackagingCountOverride(code: string): boolean {
  return code === 'BAG' || code === 'BOX' || code === 'PACK';
}

function isWeightVolumePair(
  a: MeasurementCategory,
  b: MeasurementCategory,
): boolean {
  return (a === 'WEIGHT' && b === 'VOLUME') || (a === 'VOLUME' && b === 'WEIGHT');
}

export function convertQuantityBetweenUoms(params: {
  readonly quantity: string;
  readonly fromUom: string;
  readonly toUom: string;
  readonly productBaseUom?: string;
  readonly customConversions?: readonly ProductUomConversionInput[];
  readonly densityGPerMl?: string | null;
  readonly roundingMode?: RoundingMode;
}): {
  readonly convertedQuantity: Quantity;
  readonly factorDecimal6: string;
  readonly numerator: bigint;
  readonly denominator: bigint;
} {
  const qty = Quantity.fromDecimalString(
    params.quantity,
    params.roundingMode ?? 'HALF_EVEN',
  );
  const ratio = resolveUomRationalFactor({
    fromUom: params.fromUom,
    toUom: params.toUom,
    ...(params.productBaseUom !== undefined
      ? { productBaseUom: params.productBaseUom }
      : {}),
    ...(params.customConversions !== undefined
      ? { customConversions: params.customConversions }
      : {}),
    ...(params.densityGPerMl !== undefined
      ? { densityGPerMl: params.densityGPerMl }
      : {}),
  });

  const convertedMicro = divideAndRoundBigInt(
    qty.microUnits * ratio.numerator,
    ratio.denominator,
    params.roundingMode ?? 'HALF_EVEN',
  );

  return {
    convertedQuantity: Quantity.fromMicroUnits(convertedMicro),
    factorDecimal6: ratio.factorDecimal6,
    numerator: ratio.numerator,
    denominator: ratio.denominator,
  };
}

/**
 * Computes proportionate price-per-selling-UOM and exact rational line subtotal
 * when a product is priced per `priceUom` (e.g. LKR 263.0000 / KG) and sold in `sellingUom` (e.g. 750 G).
 */
export function computeProportionateUnitPriceAndTotal(params: {
  readonly sellingPricePerPriceUom: string;
  readonly priceUom: string;
  readonly enteredQty: string;
  readonly sellingUom: string;
  readonly currencyCode: string;
  readonly productBaseUom?: string;
  readonly customConversions?: readonly ProductUomConversionInput[];
  readonly densityGPerMl?: string | null;
  readonly roundingMode?: RoundingMode;
}): {
  readonly unitPriceInSellingUom: Money;
  readonly effectiveLineSubtotal: Money;
  readonly qtyInPriceUom: Quantity;
  readonly ratioToPriceUomDecimal6: string;
} {
  const mode = params.roundingMode ?? 'HALF_EVEN';
  const basePrice = Money.fromDecimalString(
    params.sellingPricePerPriceUom,
    params.currencyCode,
    mode,
  );
  const conv = convertQuantityBetweenUoms({
    quantity: params.enteredQty,
    fromUom: params.sellingUom,
    toUom: params.priceUom,
    ...(params.productBaseUom !== undefined
      ? { productBaseUom: params.productBaseUom }
      : {}),
    ...(params.customConversions !== undefined
      ? { customConversions: params.customConversions }
      : {}),
    ...(params.densityGPerMl !== undefined
      ? { densityGPerMl: params.densityGPerMl }
      : {}),
    roundingMode: mode,
  });

  const unitPriceScaled = divideAndRoundBigInt(
    basePrice.scaledUnits * conv.numerator,
    conv.denominator,
    mode,
  );
  const qty = Quantity.fromDecimalString(params.enteredQty, mode);
  const lineSubtotalScaled = divideAndRoundBigInt(
    basePrice.scaledUnits * qty.microUnits * conv.numerator,
    QUANTITY_SCALE_FACTOR * conv.denominator,
    mode,
  );

  return {
    unitPriceInSellingUom: Money.fromScaledUnits(
      unitPriceScaled,
      basePrice.currencyCode,
    ),
    effectiveLineSubtotal: Money.fromScaledUnits(
      lineSubtotalScaled,
      basePrice.currencyCode,
    ),
    qtyInPriceUom: conv.convertedQuantity,
    ratioToPriceUomDecimal6: conv.factorDecimal6,
  };
}

/**
 * Formats decimal quantities cleanly for display (e.g. "2.500000" -> "2.5", "0.750000" -> "0.75", "3.000000" -> "3"),
 * optionally keeping up to `maxDecimals` fractional digits without integer truncation (fixes BUG-084).
 */
export function formatQuantityForDisplay(
  value: string | number,
  maxDecimals = 3,
): string {
  const qty = Quantity.fromDecimalString(String(value));
  const full = qty.toDecimalString(); // 6 decimals
  const [intPart, rawFrac = ''] = full.split('.');
  const clamped = rawFrac.slice(0, Math.max(0, Math.min(6, maxDecimals)));
  const trimmed = clamped.replace(/0+$/, '');
  return trimmed.length > 0 ? `${intPart}.${trimmed}` : (intPart ?? '0');
}

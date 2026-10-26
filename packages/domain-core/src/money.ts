import { type Quantity, QUANTITY_SCALE_FACTOR } from './quantity.js';
import {
  type RoundingMode,
  divideAndRoundBigInt,
  formatScaledBigIntToDecimalString,
  parseDecimalStringToScaledBigInt,
} from './rounding.js';

/**
 * Money internal scale: 4 decimal places (10_000 scaled units = 1.0000 major currency unit).
 * Matches PostgreSQL NUMERIC(19, 4) for unit costs, tax calculations, and ledger totals.
 */
export const MONEY_INTERNAL_SCALE = 4;
export const MONEY_SCALE_FACTOR = 10_000n;
export const EXCHANGE_RATE_SCALE = 8;
export const EXCHANGE_RATE_SCALE_FACTOR = 100_000_000n;

export interface CurrencyDefinition {
  readonly code: string;
  readonly minorUnits: 0 | 2 | 3;
  readonly name: string;
}

export const SUPPORTED_CURRENCIES: Readonly<
  Record<string, CurrencyDefinition>
> = {
  USD: { code: 'USD', minorUnits: 2, name: 'US Dollar' },
  LKR: { code: 'LKR', minorUnits: 2, name: 'Sri Lankan Rupee' },
  EUR: { code: 'EUR', minorUnits: 2, name: 'Euro' },
  GBP: { code: 'GBP', minorUnits: 2, name: 'Pound Sterling' },
  INR: { code: 'INR', minorUnits: 2, name: 'Indian Rupee' },
  AED: { code: 'AED', minorUnits: 2, name: 'UAE Dirham' },
  SGD: { code: 'SGD', minorUnits: 2, name: 'Singapore Dollar' },
  AUD: { code: 'AUD', minorUnits: 2, name: 'Australian Dollar' },
  JPY: { code: 'JPY', minorUnits: 0, name: 'Japanese Yen' },
  KRW: { code: 'KRW', minorUnits: 0, name: 'South Korean Won' },
  KWD: { code: 'KWD', minorUnits: 3, name: 'Kuwaiti Dinar' },
  BHD: { code: 'BHD', minorUnits: 3, name: 'Bahraini Dinar' },
  OMR: { code: 'OMR', minorUnits: 3, name: 'Omani Rial' },
};

export function getCurrencyDefinition(
  currencyCode: string,
): CurrencyDefinition {
  const normalized = currencyCode.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(normalized)) {
    throw new RangeError(`Invalid ISO 4217 currency code "${currencyCode}".`);
  }
  return (
    SUPPORTED_CURRENCIES[normalized] ?? {
      code: normalized,
      minorUnits: 2,
      name: normalized,
    }
  );
}

export class Money {
  readonly scaledUnits: bigint; // Scale = 4 (1/10,000 of major unit)
  readonly currencyCode: string;

  private constructor(scaledUnits: bigint, currencyCode: string) {
    this.scaledUnits = scaledUnits;
    this.currencyCode = getCurrencyDefinition(currencyCode).code;
  }

  static zero(currencyCode: string): Money {
    return new Money(0n, currencyCode);
  }

  static fromScaledUnits(scaledUnits: bigint, currencyCode: string): Money {
    return new Money(scaledUnits, currencyCode);
  }

  static fromMinorUnits(
    minorUnits: bigint | number,
    currencyCode: string,
  ): Money {
    if (typeof minorUnits === 'number' && !Number.isSafeInteger(minorUnits)) {
      throw new RangeError(
        'Money.fromMinorUnits only accepts safe integers or bigint.',
      );
    }
    const def = getCurrencyDefinition(currencyCode);
    const scaleDiff = MONEY_INTERNAL_SCALE - def.minorUnits;
    const multiplier = 10n ** BigInt(scaleDiff);
    return new Money(BigInt(minorUnits) * multiplier, def.code);
  }

  static fromDecimalString(
    decimalStr: string,
    currencyCode: string,
    roundingMode: RoundingMode = 'HALF_EVEN',
  ): Money {
    const def = getCurrencyDefinition(currencyCode);
    const scaled = parseDecimalStringToScaledBigInt(
      decimalStr,
      MONEY_INTERNAL_SCALE,
      roundingMode,
    );
    return new Money(scaled, def.code);
  }

  private assertSameCurrency(other: Money): void {
    if (this.currencyCode !== other.currencyCode) {
      throw new Error(
        `Currency mismatch: cannot combine ${this.currencyCode} and ${other.currencyCode} without explicit exchange rate conversion.`,
      );
    }
  }

  isZero(): boolean {
    return this.scaledUnits === 0n;
  }

  isPositive(): boolean {
    return this.scaledUnits > 0n;
  }

  isNegative(): boolean {
    return this.scaledUnits < 0n;
  }

  abs(): Money {
    return new Money(
      this.scaledUnits < 0n ? -this.scaledUnits : this.scaledUnits,
      this.currencyCode,
    );
  }

  negate(): Money {
    return new Money(-this.scaledUnits, this.currencyCode);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.scaledUnits + other.scaledUnits, this.currencyCode);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.scaledUnits - other.scaledUnits, this.currencyCode);
  }

  equals(other: Money): boolean {
    return (
      this.currencyCode === other.currencyCode &&
      this.scaledUnits === other.scaledUnits
    );
  }

  compare(other: Money): -1 | 0 | 1 {
    this.assertSameCurrency(other);
    if (this.scaledUnits < other.scaledUnits) return -1;
    if (this.scaledUnits > other.scaledUnits) return 1;
    return 0;
  }

  /**
   * Multiplies this unit price/cost by a fixed-point `Quantity` and rounds to 4 decimal places.
   */
  multiplyByQuantity(
    quantity: Quantity,
    roundingMode: RoundingMode = 'HALF_EVEN',
  ): Money {
    const product = divideAndRoundBigInt(
      this.scaledUnits * quantity.microUnits,
      QUANTITY_SCALE_FACTOR,
      roundingMode,
    );
    return new Money(product, this.currencyCode);
  }

  /**
   * Rounds the internal 4-decimal amount to the currency's physical/payable minor units
   * (e.g. 2 decimals for USD/LKR/EUR, 0 decimals for JPY, 3 decimals for KWD/BHD).
   */
  roundToCurrencyMinorUnits(roundingMode: RoundingMode = 'HALF_EVEN'): Money {
    const def = getCurrencyDefinition(this.currencyCode);
    const scaleDiff = MONEY_INTERNAL_SCALE - def.minorUnits;
    const divisor = 10n ** BigInt(scaleDiff);
    const minor = divideAndRoundBigInt(this.scaledUnits, divisor, roundingMode);
    return new Money(minor * divisor, this.currencyCode);
  }

  /**
   * Returns the integer minor units (e.g. cents/paisa/fils) after rounding to currency minor units.
   */
  toMinorUnits(roundingMode: RoundingMode = 'HALF_EVEN'): bigint {
    const def = getCurrencyDefinition(this.currencyCode);
    const scaleDiff = MONEY_INTERNAL_SCALE - def.minorUnits;
    const divisor = 10n ** BigInt(scaleDiff);
    return divideAndRoundBigInt(this.scaledUnits, divisor, roundingMode);
  }

  /**
   * Converts this monetary amount into `targetCurrency` using an 8-decimal fixed-point exchange rate string.
   */
  convertCurrency(
    targetCurrency: string,
    exchangeRateDecimalStr: string,
    roundingMode: RoundingMode = 'HALF_EVEN',
  ): Money {
    const rateScaled = parseDecimalStringToScaledBigInt(
      exchangeRateDecimalStr,
      EXCHANGE_RATE_SCALE,
      roundingMode,
    );
    if (rateScaled <= 0n) {
      throw new RangeError('Exchange rate must be strictly positive.');
    }
    const converted = divideAndRoundBigInt(
      this.scaledUnits * rateScaled,
      EXCHANGE_RATE_SCALE_FACTOR,
      roundingMode,
    );
    return new Money(converted, targetCurrency);
  }

  /**
   * Allocates this Money amount across weighted shares (at minor-unit precision)
   * guaranteeing that the sum of allocated shares equals `this.roundToCurrencyMinorUnits()`
   * with zero lost pennies.
   */
  allocateByWeights(
    weights: readonly bigint[],
    roundingMode: RoundingMode = 'HALF_EVEN',
  ): Money[] {
    if (weights.length === 0) {
      throw new RangeError('Weights array must not be empty.');
    }
    let totalWeight = 0n;
    for (const w of weights) {
      if (w < 0n) {
        throw new RangeError('Allocation weights cannot be negative.');
      }
      totalWeight += w;
    }
    if (totalWeight === 0n) {
      throw new RangeError('Sum of allocation weights must be > 0.');
    }

    const totalMinor = this.toMinorUnits(roundingMode);
    const sharesMinor: bigint[] = [];
    let allocatedSum = 0n;

    for (const w of weights) {
      const share = (totalMinor * w) / totalWeight;
      sharesMinor.push(share);
      allocatedSum += share;
    }

    let remainder = totalMinor - allocatedSum;
    const step = remainder >= 0n ? 1n : -1n;
    let idx = 0;
    while (remainder !== 0n) {
      if ((weights[idx] ?? 0n) > 0n) {
        sharesMinor[idx] = (sharesMinor[idx] ?? 0n) + step;
        remainder -= step;
      }
      idx = (idx + 1) % sharesMinor.length;
    }

    return sharesMinor.map((minor) =>
      Money.fromMinorUnits(minor, this.currencyCode),
    );
  }

  /**
   * Canonical 4-decimal string matching PostgreSQL NUMERIC(19, 4) (e.g. "124.5000").
   */
  toDecimalString(): string {
    return formatScaledBigIntToDecimalString(
      this.scaledUnits,
      MONEY_INTERNAL_SCALE,
    );
  }

  /**
   * Currency-minor-unit formatted string (e.g. "124.50" for USD/LKR, "125" for JPY, "124.500" for KWD).
   */
  toCurrencyDecimalString(roundingMode: RoundingMode = 'HALF_EVEN'): string {
    const def = getCurrencyDefinition(this.currencyCode);
    const minor = this.toMinorUnits(roundingMode);
    return formatScaledBigIntToDecimalString(minor, def.minorUnits);
  }
}

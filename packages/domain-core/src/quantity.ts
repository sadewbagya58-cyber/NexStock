import {
  type RoundingMode,
  divideAndRoundBigInt,
  formatScaledBigIntToDecimalString,
  parseDecimalStringToScaledBigInt,
} from './rounding.js';

/**
 * Quantity internal scale: 6 decimal places (1_000_000 micro-units = 1.000000 base UoM).
 * Matches PostgreSQL NUMERIC(18, 6) and SQLite STRICT integer micro-units.
 */
export const QUANTITY_SCALE = 6;
export const QUANTITY_SCALE_FACTOR = 1_000_000n;

export class Quantity {
  readonly microUnits: bigint;

  private constructor(microUnits: bigint) {
    this.microUnits = microUnits;
  }

  static zero(): Quantity {
    return new Quantity(0n);
  }

  static fromMicroUnits(microUnits: bigint): Quantity {
    return new Quantity(microUnits);
  }

  static fromInteger(wholeUnits: bigint | number): Quantity {
    if (typeof wholeUnits === 'number' && !Number.isSafeInteger(wholeUnits)) {
      throw new RangeError(
        'Quantity.fromInteger only accepts safe integers or bigint; use Quantity.fromDecimalString for fractional quantities.',
      );
    }
    return new Quantity(BigInt(wholeUnits) * QUANTITY_SCALE_FACTOR);
  }

  static fromDecimalString(
    decimalStr: string,
    roundingMode: RoundingMode = 'HALF_EVEN',
  ): Quantity {
    return new Quantity(
      parseDecimalStringToScaledBigInt(decimalStr, QUANTITY_SCALE, roundingMode),
    );
  }

  isZero(): boolean {
    return this.microUnits === 0n;
  }

  isPositive(): boolean {
    return this.microUnits > 0n;
  }

  isNegative(): boolean {
    return this.microUnits < 0n;
  }

  abs(): Quantity {
    return new Quantity(
      this.microUnits < 0n ? -this.microUnits : this.microUnits,
    );
  }

  negate(): Quantity {
    return new Quantity(-this.microUnits);
  }

  add(other: Quantity): Quantity {
    return new Quantity(this.microUnits + other.microUnits);
  }

  subtract(other: Quantity): Quantity {
    return new Quantity(this.microUnits - other.microUnits);
  }

  equals(other: Quantity): boolean {
    return this.microUnits === other.microUnits;
  }

  compare(other: Quantity): -1 | 0 | 1 {
    if (this.microUnits < other.microUnits) return -1;
    if (this.microUnits > other.microUnits) return 1;
    return 0;
  }

  /**
   * Converts this quantity to base UoM using a fixed-point conversion factor
   * (e.g. "12.000000" for 1 Box = 12 Pieces, or rational numerator/denominator).
   */
  convertUsingFactor(
    factorDecimalString: string,
    roundingMode: RoundingMode = 'HALF_EVEN',
  ): Quantity {
    const factorScaled = parseDecimalStringToScaledBigInt(
      factorDecimalString,
      QUANTITY_SCALE,
      roundingMode,
    );
    if (factorScaled <= 0n) {
      throw new RangeError('UoM conversion factor must be strictly positive.');
    }
    const converted = divideAndRoundBigInt(
      this.microUnits * factorScaled,
      QUANTITY_SCALE_FACTOR,
      roundingMode,
    );
    return new Quantity(converted);
  }

  toDecimalString(): string {
    return formatScaledBigIntToDecimalString(this.microUnits, QUANTITY_SCALE);
  }
}

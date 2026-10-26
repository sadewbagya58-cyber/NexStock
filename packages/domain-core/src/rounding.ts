/**
 * Pure BigInt Fixed-Point Rounding & Scaling Utilities.
 * Zero JavaScript IEEE 754 floating-point arithmetic is used anywhere in this module.
 */

export type RoundingMode = 'HALF_EVEN' | 'HALF_UP';

/**
 * Divides `numerator` by a positive `denominator` using pure BigInt integer arithmetic
 * and rounds the quotient according to `roundingMode`.
 */
export function divideAndRoundBigInt(
  numerator: bigint,
  denominator: bigint,
  roundingMode: RoundingMode = 'HALF_EVEN',
): bigint {
  if (denominator <= 0n) {
    throw new RangeError('Denominator must be a strictly positive bigint.');
  }
  if (numerator === 0n) {
    return 0n;
  }

  const isNegative = numerator < 0n;
  const absNum = isNegative ? -numerator : numerator;

  const quotient = absNum / denominator;
  const remainder = absNum % denominator;

  if (remainder === 0n) {
    return isNegative ? -quotient : quotient;
  }

  const twiceRemainder = remainder * 2n;
  let roundUp = false;

  if (twiceRemainder > denominator) {
    roundUp = true;
  } else if (twiceRemainder < denominator) {
    roundUp = false;
  } else {
    // Exact tie (0.5)
    if (roundingMode === 'HALF_UP') {
      roundUp = true;
    } else {
      // HALF_EVEN (Banker's Rounding): round to nearest even integer
      roundUp = quotient % 2n !== 0n;
    }
  }

  const roundedAbs = roundUp ? quotient + 1n : quotient;
  return isNegative ? -roundedAbs : roundedAbs;
}

/**
 * Parses a canonical decimal string (e.g. "124.50", "-10.1250") into a scaled bigint
 * with `targetScale` fractional digits without using parseFloat or Number().
 */
export function parseDecimalStringToScaledBigInt(
  input: string,
  targetScale: number,
  roundingMode: RoundingMode = 'HALF_EVEN',
): bigint {
  const trimmed = input.trim();
  const match = trimmed.match(/^([+-])?(\d+)(?:\.(\d+))?$/);
  if (!match) {
    throw new SyntaxError(
      `Invalid fixed-point decimal string "${input}". Expected canonical decimal digits (no scientific notation or floats).`,
    );
  }

  const sign = match[1] === '-' ? -1n : 1n;
  const intPart = match[2] ?? '0';
  const fracPart = match[3] ?? '';

  if (fracPart.length <= targetScale) {
    const paddedFrac = fracPart.padEnd(targetScale, '0');
    const combined = BigInt(intPart + paddedFrac);
    return combined === 0n ? 0n : sign * combined;
  }

  // More fractional digits than targetScale -> round deterministically using BigInt
  const extraDigits = fracPart.length - targetScale;
  const divisor = 10n ** BigInt(extraDigits);
  const rawUnrounded = sign * BigInt(intPart + fracPart);
  return divideAndRoundBigInt(rawUnrounded, divisor, roundingMode);
}

/**
 * Formats a scaled bigint into a canonical fixed-point decimal string with `scale` fractional digits.
 */
export function formatScaledBigIntToDecimalString(
  scaledValue: bigint,
  scale: number,
): string {
  const isNegative = scaledValue < 0n;
  const absVal = isNegative ? -scaledValue : scaledValue;
  const signPrefix = isNegative ? '-' : '';

  if (scale === 0) {
    return `${signPrefix}${absVal.toString()}`;
  }

  const rawStr = absVal.toString().padStart(scale + 1, '0');
  const splitIndex = rawStr.length - scale;
  const intPart = rawStr.slice(0, splitIndex);
  const fracPart = rawStr.slice(splitIndex);
  return `${signPrefix}${intPart}.${fracPart}`;
}

import { describe, expect, it } from 'vitest';
import {
  UomConversionError,
  computeProportionateUnitPriceAndTotal,
  convertQuantityBetweenUoms,
  formatQuantityForDisplay,
} from '../src/index.js';

describe('@nexstock/domain-core — UOM Foundation & Variable Quantity Arithmetic (UOM-02, BUG-084)', () => {
  it('converts KG <-> G <-> MG cleanly using exact BigInt arithmetic', () => {
    const gToKg = convertQuantityBetweenUoms({
      quantity: '750',
      fromUom: 'G',
      toUom: 'KG',
    });
    expect(gToKg.convertedQuantity.toDecimalString()).toBe('0.750000');
    expect(gToKg.factorDecimal6).toBe('0.001000');

    const kgToG = convertQuantityBetweenUoms({
      quantity: '2.5',
      fromUom: 'KG',
      toUom: 'G',
    });
    expect(kgToG.convertedQuantity.toDecimalString()).toBe('2500.000000');

    const mgToG = convertQuantityBetweenUoms({
      quantity: '500',
      fromUom: 'MG',
      toUom: 'G',
    });
    expect(mgToG.convertedQuantity.toDecimalString()).toBe('0.500000');
  });

  it('converts L <-> ML, M <-> CM <-> MM, and DOZEN <-> PCS cleanly', () => {
    expect(
      convertQuantityBetweenUoms({
        quantity: '250',
        fromUom: 'ML',
        toUom: 'L',
      }).convertedQuantity.toDecimalString(),
    ).toBe('0.250000');

    expect(
      convertQuantityBetweenUoms({
        quantity: '150',
        fromUom: 'CM',
        toUom: 'M',
      }).convertedQuantity.toDecimalString(),
    ).toBe('1.500000');

    expect(
      convertQuantityBetweenUoms({
        quantity: '2',
        fromUom: 'DOZEN',
        toUom: 'PCS',
      }).convertedQuantity.toDecimalString(),
    ).toBe('24.000000');
  });

  it('rejects cross-dimension WEIGHT <-> VOLUME conversions unless densityGPerMl is explicitly configured', () => {
    expect(() =>
      convertQuantityBetweenUoms({
        quantity: '500',
        fromUom: 'G',
        toUom: 'L',
      }),
    ).toThrow(UomConversionError);

    // Explicit density = 1.030000 g/mL (e.g., milk: 1030 G -> 1.000000 L)
    const milkVol = convertQuantityBetweenUoms({
      quantity: '1030',
      fromUom: 'G',
      toUom: 'L',
      densityGPerMl: '1.030000',
    });
    expect(milkVol.convertedQuantity.toDecimalString()).toBe('1.000000');
  });

  it('calculates exact proportionate pricing for variable weight/volume POS lines', () => {
    // 750 G x LKR 260 / KG = LKR 195.00
    const rice = computeProportionateUnitPriceAndTotal({
      sellingPricePerPriceUom: '260.0000',
      priceUom: 'KG',
      enteredQty: '750',
      sellingUom: 'G',
      currencyCode: 'LKR',
    });
    expect(rice.qtyInPriceUom.toDecimalString()).toBe('0.750000');
    expect(rice.unitPriceInSellingUom.toDecimalString()).toBe('0.2600');
    expect(rice.effectiveLineSubtotal.toDecimalString()).toBe('195.0000');

    // 750 G x LKR 263 / KG = LKR 197.25
    const riceRepriced = computeProportionateUnitPriceAndTotal({
      sellingPricePerPriceUom: '263.0000',
      priceUom: 'KG',
      enteredQty: '750',
      sellingUom: 'G',
      currencyCode: 'LKR',
    });
    expect(riceRepriced.effectiveLineSubtotal.toDecimalString()).toBe('197.2500');
  });

  it('formats fractional quantities cleanly without integer rounding (BUG-084: 2.5 KG != 3 KG)', () => {
    expect(formatQuantityForDisplay('2.500000')).toBe('2.5');
    expect(formatQuantityForDisplay('0.750000')).toBe('0.75');
    expect(formatQuantityForDisplay('2.000000')).toBe('2');
    expect(formatQuantityForDisplay('0.125000')).toBe('0.125');
  });
});

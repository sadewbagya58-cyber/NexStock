import { describe, expect, it } from 'vitest';
import {
  buildInternalBatchBarcodeValue,
  classifyBarcodeKind,
  normalizeBarcodeCandidates,
  parseGs1Barcode,
  parseGs1DateYyMmDd,
  resolveEffectiveBatchPrice,
} from '../src/index.js';

describe('@nexstock/domain-core — GS1 & Hybrid Barcode Parser', () => {
  it('parses binary FNC1 GS1-128 barcodes with AIM ]C1 prefix, GTIN-14, Lot (10), Expiry (17), and Serial (21)', () => {
    const raw = ']C1010490123456789410LOT-A2026\u001d1727020021SN9988';
    const parsed = parseGs1Barcode(raw);

    expect(parsed.isGs1).toBe(true);
    expect(parsed.symbologyIdentifier).toBe(']C1');
    expect(parsed.gtin14).toBe('04901234567894');
    expect(parsed.candidateBarcodes).toContain('04901234567894');
    expect(parsed.candidateBarcodes).toContain('4901234567894'); // EAN-13
    expect(parsed.batchNumber).toBe('LOT-A2026');
    expect(parsed.expiryDate).toBe('2027-02-28'); // day '00' => last day of Feb 2027
    expect(parsed.serialNumber).toBe('SN9988');
    expect(classifyBarcodeKind(raw)).toBe('GS1_COMPOSITE');
  });

  it('handles leap year day 00 expiry dates and HRI parenthesized GS1 strings', () => {
    expect(parseGs1DateYyMmDd('280200')).toBe('2028-02-29'); // 2028 leap year
    expect(parseGs1DateYyMmDd('271301')).toBeNull(); // invalid month

    const hri = '(01)00012345678905(17)261130(10)SOAP-A';
    const parsed = parseGs1Barcode(hri);
    expect(parsed.isGs1).toBe(true);
    expect(parsed.gtin14).toBe('00012345678905');
    expect(parsed.candidateBarcodes).toContain('012345678905'); // UPC-A 12 digits
    expect(parsed.expiryDate).toBe('2026-11-30');
    expect(parsed.batchNumber).toBe('SOAP-A');
  });

  it('distinguishes internal NexStock batch barcodes vs plain EAN-13 vs GS1', () => {
    const internal = buildInternalBatchBarcodeValue('019a4f8b-1234-7abc-9000-001122334455');
    expect(internal).toBe('NB-B001122334455');
    expect(classifyBarcodeKind(internal)).toBe('INTERNAL_BATCH');
    expect(parseGs1Barcode(internal).isGs1).toBe(false);

    expect(classifyBarcodeKind('4791000123456')).toBe('PLAIN_BARCODE');
    expect(normalizeBarcodeCandidates('4791000123456')).toEqual([
      '4791000123456',
      '04791000123456',
    ]);
  });
});

describe('@nexstock/domain-core — Batch Pricing Precedence Resolver', () => {
  it('prefers explicit batch price over product/branch prices (One Product, Multiple Batches)', () => {
    const soapA = resolveEffectiveBatchPrice({
      batchNumber: 'SOAP-A',
      batchSellingPrice: '150.0000',
      batchPricingMode: 'EXPLICIT',
      productSellingPrice: '160.0000',
      branchSellingPrice: '165.0000',
      fallbackPolicy: 'ALLOW_PRODUCT_FALLBACK',
      currencyCode: 'LKR',
    });
    expect(soapA.ok).toBe(true);
    if (soapA.ok) {
      expect(soapA.resolvedPrice).toBe('150.0000');
      expect(soapA.source).toBe('EXPLICIT_BATCH_PRICE');
    }

    const soapB = resolveEffectiveBatchPrice({
      batchNumber: 'SOAP-B',
      batchSellingPrice: '180.0000',
      batchPricingMode: 'EXPLICIT',
      productSellingPrice: '160.0000',
      branchSellingPrice: '165.0000',
      fallbackPolicy: 'BLOCK_MISSING',
      currencyCode: 'LKR',
    });
    expect(soapB.ok).toBe(true);
    if (soapB.ok) {
      expect(soapB.resolvedPrice).toBe('180.0000');
      expect(soapB.source).toBe('EXPLICIT_BATCH_PRICE');
    }
  });

  it('enforces supervisor override against batch min_selling_price floor', () => {
    const blocked = resolveEffectiveBatchPrice({
      batchNumber: 'SOAP-B',
      batchSellingPrice: '180.0000',
      batchMinSellingPrice: '155.0000',
      overrideSellingPrice: '140.0000',
      overrideAuthorized: true,
      currencyCode: 'LKR',
    });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.errorCode).toBe('BATCH_MIN_PRICE_VIOLATION');
    }

    const approved = resolveEffectiveBatchPrice({
      batchNumber: 'SOAP-B',
      batchSellingPrice: '180.0000',
      batchMinSellingPrice: '155.0000',
      overrideSellingPrice: '160.0000',
      overrideAuthorized: true,
      currencyCode: 'LKR',
    });
    expect(approved.ok).toBe(true);
    if (approved.ok) {
      expect(approved.resolvedPrice).toBe('160.0000');
      expect(approved.source).toBe('POS_BATCH_OVERRIDE');
    }
  });

  it('allows fallback ONLY for INHERIT_PRODUCT + ALLOW_PRODUCT_FALLBACK + !requireBatchSellingPrice, otherwise blocks 422', () => {
    const allowedFallback = resolveEffectiveBatchPrice({
      batchNumber: 'LEGACY-01',
      batchSellingPrice: null,
      batchPricingMode: 'INHERIT_PRODUCT',
      productSellingPrice: '150.0000',
      branchSellingPrice: '155.0000',
      fallbackPolicy: 'ALLOW_PRODUCT_FALLBACK',
      requireBatchSellingPrice: false,
      currencyCode: 'LKR',
    });
    expect(allowedFallback.ok).toBe(true);
    if (allowedFallback.ok) {
      expect(allowedFallback.resolvedPrice).toBe('155.0000');
      expect(allowedFallback.source).toBe('BRANCH_DEFAULT_FALLBACK');
    }

    const blockedStrictTenant = resolveEffectiveBatchPrice({
      batchNumber: 'NEW-01',
      batchSellingPrice: null,
      batchPricingMode: 'INHERIT_PRODUCT',
      productSellingPrice: '150.0000',
      fallbackPolicy: 'BLOCK_MISSING',
      currencyCode: 'LKR',
    });
    expect(blockedStrictTenant.ok).toBe(false);
    if (!blockedStrictTenant.ok) {
      expect(blockedStrictTenant.errorCode).toBe('POS_BATCH_PRICE_REQUIRED');
    }

    const blockedExplicitNull = resolveEffectiveBatchPrice({
      batchNumber: 'EXPLICIT-NULL',
      batchSellingPrice: null,
      batchPricingMode: 'EXPLICIT',
      productSellingPrice: '150.0000',
      fallbackPolicy: 'ALLOW_PRODUCT_FALLBACK',
      currencyCode: 'LKR',
    });
    expect(blockedExplicitNull.ok).toBe(false);
    if (!blockedExplicitNull.ok) {
      expect(blockedExplicitNull.errorCode).toBe('POS_BATCH_PRICE_REQUIRED');
    }
  });
});

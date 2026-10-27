import { Value } from '@sinclair/typebox/value';
import { describe, expect, it } from 'vitest';
import {
  CreateProductRequestSchema,
  CurrencyCodeSchema,
  DecimalMoneyStringSchema,
  DecimalQuantityStringSchema,
  PostStockMovementRequestSchema,
  ProblemDetailsSchema,
  SyncPushBatchRequestSchema,
  UuidSchema,
} from '../src/index.js';

describe('@nexstock/contracts — TypeBox Wire Schema Validation', () => {
  it('accepts valid UUIDv7 strings and rejects malformed UUIDs', () => {
    expect(Value.Check(UuidSchema, '0192b4a0-1c2b-7000-8000-000000000001')).toBe(
      true,
    );
    expect(Value.Check(UuidSchema, 'not-a-uuid')).toBe(false);
  });

  it('enforces canonical fixed-point decimal strings and rejects numbers/floats for money and quantities', () => {
    expect(Value.Check(DecimalMoneyStringSchema, '124.5000')).toBe(true);
    expect(Value.Check(DecimalMoneyStringSchema, '-10.25')).toBe(true);
    expect(Value.Check(DecimalMoneyStringSchema, 124.5)).toBe(false);
    expect(Value.Check(DecimalMoneyStringSchema, '124.50009')).toBe(false); // > 4 decimals

    expect(Value.Check(DecimalQuantityStringSchema, '2.500000')).toBe(true);
    expect(Value.Check(DecimalQuantityStringSchema, 2.5)).toBe(false);
    expect(Value.Check(CurrencyCodeSchema, 'LKR')).toBe(true);
    expect(Value.Check(CurrencyCodeSchema, 'lkr')).toBe(false);
  });

  it('validates RFC 9457 ProblemDetails and SyncPushBatchRequest schemas', () => {
    const problem = {
      type: 'https://api.nexstock.io/errors/insufficient-available-stock',
      title: 'Insufficient Available Stock',
      status: 409,
      detail: 'Warehouse WH-MAIN has 0 units.',
      errorCode: 'INV_INSUFFICIENT_AVAILABLE_STOCK',
      traceId: 'req_0192b4a0',
    };
    expect(Value.Check(ProblemDetailsSchema, problem)).toBe(true);

    const syncBatch = {
      deviceId: '0192b4a0-1c2b-7000-8000-000000000001',
      branchId: '0192b4a0-1c2b-7000-8000-000000000002',
      commands: [
        {
          localSeq: 1,
          commandId: '0192b4a0-1c2b-7000-8000-000000000003',
          tenantId: '0192b4a0-1c2b-7000-8000-000000000004',
          branchId: '0192b4a0-1c2b-7000-8000-000000000002',
          deviceId: '0192b4a0-1c2b-7000-8000-000000000001',
          actorUserId: '0192b4a0-1c2b-7000-8000-000000000005',
          commandType: 'POS_RECORD_SALE',
          schemaVersion: 1,
          occurredAt: '2026-10-26T07:00:00.000Z',
          payload: { invoiceNumber: 'NYC01-REG01-20261026-000001' },
        },
      ],
    };
    expect(Value.Check(SyncPushBatchRequestSchema, syncBatch)).toBe(true);
  });

  it('validates Phase 2 product and stock movement wire contracts', () => {
    expect(
      Value.Check(CreateProductRequestSchema, {
        sku: 'SKU-TEA-001',
        name: 'Ceylon Black Tea 500g',
        baseUom: 'PCS',
        purchaseCost: '450.0000',
        sellingPrice: '650.0000',
        trackInventory: true,
        primaryBarcode: '4791000000012',
        unitConversions: [
          {
            uomCode: 'BOX',
            uomName: 'Box of 12',
            conversionFactorToBase: '12.000000',
          },
        ],
      }),
    ).toBe(true);

    // Reject float numbers on purchaseCost
    expect(
      Value.Check(CreateProductRequestSchema, {
        sku: 'SKU-TEA-001',
        name: 'Ceylon Black Tea 500g',
        baseUom: 'PCS',
        purchaseCost: 450,
        sellingPrice: '650.0000',
      }),
    ).toBe(false);

    expect(
      Value.Check(PostStockMovementRequestSchema, {
        branchId: '0192b4a0-1c2b-7000-8000-000000000001',
        warehouseId: '0192b4a0-1c2b-7000-8000-000000000002',
        productId: '0192b4a0-1c2b-7000-8000-000000000003',
        movementType: 'OPENING_STOCK',
        quantity: '25.000000',
        unitCost: '450.0000',
      }),
    ).toBe(true);
  });
});

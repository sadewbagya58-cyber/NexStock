import { randomUUID, type KeyObject, generateKeyPairSync, sign } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  DEFAULT_SUPABASE_JWT_AUDIENCE,
  DEFAULT_SUPABASE_JWT_ISSUER,
  StaticJwksProvider,
  type SupabaseJwk,
  buildApp,
  generateUuidV7,
  provisionTenantMember,
  withTenantTransaction,
} from '../src/index.js';
import {
  createTestPostgresHarness,
  type TestPostgresHarness,
} from './helpers/pglite-kysely.js';

interface TestEs256KeyMaterial {
  readonly kid: string;
  readonly privateKey: KeyObject;
  readonly publicJwk: SupabaseJwk;
}

type AppInstance = Awaited<ReturnType<typeof buildApp>>;

function createTestEs256KeyMaterial(kid: string): TestEs256KeyMaterial {
  const { publicKey, privateKey } = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
  });
  const exported = publicKey.export({ format: 'jwk' });
  return {
    kid,
    privateKey,
    publicJwk: {
      ...exported,
      kty: 'EC',
      crv: 'P-256',
      alg: 'ES256',
      use: 'sig',
      kid,
    },
  };
}

function signEs256Jwt(
  keyMaterial: TestEs256KeyMaterial,
  payload: Record<string, unknown>,
): string {
  const header = { alg: 'ES256', typ: 'JWT', kid: keyMaterial.kid };
  const headerB64 = Buffer.from(JSON.stringify(header), 'utf-8').toString('base64url');
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64url');
  const signingInput = Buffer.from(`${headerB64}.${payloadB64}`, 'utf-8');
  const signature = sign('sha256', signingInput, {
    key: keyMaterial.privateKey,
    dsaEncoding: 'ieee-p1363',
  });
  return `${headerB64}.${payloadB64}.${signature.toString('base64url')}`;
}

describe('@nexstock/api — BUG-084 Fractional Qty, UOM Engine, Variable-Qty POS, Purchasing & Returns (Phase 3)', () => {
  let harness: TestPostgresHarness;
  let app: AppInstance;

  const TENANT_ID = '0192f000-0000-7000-8000-000000000001';
  const OWNER_USER_ID = '0192f000-0000-7000-8000-000000000002';
  const CASHIER_USER_ID = '0192f000-0000-7000-8000-000000000003';

  const primaryKey = createTestEs256KeyMaterial('test-key-uom-phase3');
  const jwksProvider = new StaticJwksProvider({ keys: [primaryKey.publicJwk] });
  const nowSeconds = Math.floor(Date.now() / 1000);

  function issueToken(userId: string, email: string): string {
    return signEs256Jwt(primaryKey, {
      iss: DEFAULT_SUPABASE_JWT_ISSUER,
      aud: DEFAULT_SUPABASE_JWT_AUDIENCE,
      sub: userId,
      email,
      iat: nowSeconds - 60,
      nbf: nowSeconds - 60,
      exp: nowSeconds + 3600,
    });
  }

  let ownerToken: string;
  let cashierToken: string;
  let branchId: string;
  let warehouseId: string;
  let registerId: string;
  let shiftId: string;
  let supplierId: string;

  let sambaRiceId: string;
  let oilProductId: string;
  let batchSugarId: string;

  const authHeaders = (token: string, extra?: Record<string, string>) => ({
    authorization: `Bearer ${token}`,
    'x-tenant-id': TENANT_ID,
    'content-type': 'application/json',
    ...extra,
  });

  beforeAll(async () => {
    harness = await createTestPostgresHarness();
    ownerToken = issueToken(OWNER_USER_ID, 'owner@uom-phase3.test');
    cashierToken = issueToken(CASHIER_USER_ID, 'cashier@uom-phase3.test');

    app = await buildApp({ db: harness.db, jwksProvider });

    const onboardRes = await app.inject({
      method: 'POST',
      url: '/v1/org/tenants/onboard',
      headers: authHeaders(ownerToken),
      payload: {
        slug: 'lanka-grocers-uom',
        legalName: 'Lanka Fresh Grocers Ltd',
        baseCurrency: 'LKR',
        defaultLocale: 'en-US',
        defaultTimezone: 'Asia/Colombo',
        countryCode: 'LK',
        ownerEmail: 'owner@uom-phase3.test',
        ownerFullName: 'Store Owner',
        planCode: 'GROWTH',
      },
    });
    expect(onboardRes.statusCode).toBe(201);

    const branchRes = await app.inject({
      method: 'POST',
      url: '/v1/org/branches',
      headers: authHeaders(ownerToken),
      payload: {
        code: 'BR-COL-01',
        name: 'Colombo Flagship',
        timezone: 'Asia/Colombo',
        countryCode: 'LK',
      },
    });
    expect(branchRes.statusCode).toBe(201);
    branchId = branchRes.json().id;

    await withTenantTransaction(
      harness.db,
      { tenantId: TENANT_ID, userId: OWNER_USER_ID, traceId: 'seed_cashier_p3' },
      async (trx) => {
        await provisionTenantMember(trx, {
          userId: CASHIER_USER_ID,
          email: 'cashier@uom-phase3.test',
          fullName: 'Front Cashier',
          roleCodes: ['CASHIER'],
          allLocationsAccess: true,
          status: 'ACTIVE',
        });
      },
    );

    const whRes = await app.inject({
      method: 'POST',
      url: '/v1/org/warehouses',
      headers: authHeaders(ownerToken),
      payload: {
        branchId,
        code: 'WH-COL-01',
        name: 'Main Store Warehouse',
        allowNegativeStock: false,
      },
    });
    expect(whRes.statusCode).toBe(201);
    warehouseId = whRes.json().id;

    registerId = generateUuidV7();
    await withTenantTransaction(
      harness.db,
      { tenantId: TENANT_ID, userId: OWNER_USER_ID, traceId: 'seed_reg_p3' },
      async (trx) => {
        await trx.db
          .insertInto('pos_registers')
          .values({
            id: registerId,
            tenant_id: TENANT_ID,
            branch_id: branchId,
            warehouse_id: warehouseId,
            code: 'REG-P3-01',
            name: 'Counter 1',
            last_invoice_seq: 0,
            is_active: true,
          })
          .execute();
      },
    );

    const shiftRes = await app.inject({
      method: 'POST',
      url: '/v1/pos/shifts',
      headers: authHeaders(cashierToken),
      payload: { registerId, openingCashFloat: '2000.0000' },
    });
    expect(shiftRes.statusCode).toBe(201);
    shiftId = shiftRes.json().id;

    const suppRes = await app.inject({
      method: 'POST',
      url: '/v1/suppliers',
      headers: authHeaders(ownerToken),
      payload: {
        code: 'SUP-MILL-01',
        businessName: 'Araliya Rice Mills',
      },
    });
    expect(suppRes.statusCode).toBe(201);
    supplierId = suppRes.json().id;
  });

  afterAll(async () => {
    if (app) await app.close();
    if (harness?.db) await harness.db.destroy();
  });

  it('UOM-02: GET /v1/uom/units returns seeded measurement units across WEIGHT, VOLUME, LENGTH, COUNT', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/uom/units',
      headers: authHeaders(ownerToken),
    });
    expect(res.statusCode).toBe(200);
    const units = res.json() as Array<{ code: string; category: string }>;
    const codes = new Set(units.map((u) => u.code));
    expect(codes.has('KG')).toBe(true);
    expect(codes.has('G')).toBe(true);
    expect(codes.has('L')).toBe(true);
    expect(codes.has('ML')).toBe(true);
    expect(codes.has('M')).toBe(true);
    expect(codes.has('CM')).toBe(true);
    expect(codes.has('PCS')).toBe(true);
    expect(codes.has('BAG')).toBe(true);
  });

  it('UOM-03 & BUG-084: creates a Variable-Qty product without barcode, posts 2.5 KG + 500 G Stock In, and preserves exact fractional balance (never rounded)', async () => {
    const prodRes = await app.inject({
      method: 'POST',
      url: '/v1/products',
      headers: authHeaders(ownerToken, { 'idempotency-key': randomUUID() }),
      payload: {
        sku: 'RICE-SAMBA-BULK',
        name: 'Samba Rice',
        baseUom: 'KG',
        productQtyMode: 'VARIABLE',
        measurementCategory: 'WEIGHT',
        purchaseUom: 'BAG',
        priceUom: 'KG',
        allowedSellingUoms: ['KG', 'G'],
        qtyDecimalPrecision: 3,
        featuredPos: true,
        purchaseCost: '220.0000',
        sellingPrice: '260.0000',
        trackInventory: true,
        unitConversions: [
          {
            uomCode: 'BAG',
            uomName: '25 KG Bag',
            conversionFactorToBase: '25.000000',
          },
        ],
      },
    });
    expect(prodRes.statusCode).toBe(201);
    const product = prodRes.json();
    sambaRiceId = product.id;
    expect(product.productQtyMode).toBe('VARIABLE');
    expect(product.featuredPos).toBe(true);
    expect(product.primaryBarcode).toBeNull();
    expect(product.allowedSellingUoms).toEqual(['KG', 'G']);

    // BUG-084: Stock In 2.5 KG -> exact balance 2.500000 (never 3!)
    const m1 = await app.inject({
      method: 'POST',
      url: '/v1/inventory/movements',
      headers: authHeaders(ownerToken, { 'idempotency-key': randomUUID() }),
      payload: {
        branchId,
        warehouseId,
        productId: sambaRiceId,
        movementType: 'STOCK_IN',
        quantity: '2.500000',
        uomCode: 'KG',
        unitCost: '220.0000',
        entrySource: 'MANUAL_WEIGHT',
        reason: 'Fractional Stock In BUG-084 test',
      },
    });
    expect(m1.statusCode).toBe(201);
    expect(m1.json().qtyDelta).toBe('2.500000');
    expect(m1.json().balanceAfter).toBe('2.500000');
    expect(m1.json().entrySource).toBe('MANUAL_WEIGHT');

    // Add 500 G -> converts to +0.500000 KG -> balanceAfter 3.000000 KG
    const m2 = await app.inject({
      method: 'POST',
      url: '/v1/inventory/movements',
      headers: authHeaders(ownerToken, { 'idempotency-key': randomUUID() }),
      payload: {
        branchId,
        warehouseId,
        productId: sambaRiceId,
        movementType: 'STOCK_IN',
        quantity: '500.000000',
        uomCode: 'G',
        unitCost: '0.2200',
        reason: '500 G top up',
      },
    });
    expect(m2.statusCode).toBe(201);
    expect(m2.json().qtyDelta).toBe('0.500000');
    expect(m2.json().balanceAfter).toBe('3.000000');

    // Also add 0.25 KG -> balance becomes 3.250000 and check /v1/inventory/balances preserves decimals!
    const m3 = await app.inject({
      method: 'POST',
      url: '/v1/inventory/movements',
      headers: authHeaders(ownerToken, { 'idempotency-key': randomUUID() }),
      payload: {
        branchId,
        warehouseId,
        productId: sambaRiceId,
        movementType: 'STOCK_IN',
        quantity: '0.250000',
        uomCode: 'KG',
        unitCost: '220.0000',
      },
    });
    expect(m3.statusCode).toBe(201);

    const balRes = await app.inject({
      method: 'GET',
      url: `/v1/inventory/balances?warehouseId=${warehouseId}&productId=${sambaRiceId}`,
      headers: authHeaders(ownerToken),
    });
    expect(balRes.statusCode).toBe(200);
    expect(balRes.json().data[0].qtyOnHand).toBe('3.250000');
  });

  it('UOM-02: rejects incompatible Weight <-> Volume movement without density, and allows conversion when densityGPerMl is configured', async () => {
    // Reject 1 L on WEIGHT product Samba Rice (no density)
    const badRes = await app.inject({
      method: 'POST',
      url: '/v1/inventory/movements',
      headers: authHeaders(ownerToken, { 'idempotency-key': randomUUID() }),
      payload: {
        branchId,
        warehouseId,
        productId: sambaRiceId,
        movementType: 'STOCK_IN',
        quantity: '1.000000',
        uomCode: 'L',
        unitCost: '200.0000',
      },
    });
    expect(badRes.statusCode).toBe(400);
    expect(badRes.json().errorCode).toBe('CAT_INVALID_UOM_CONVERSION');
    expect(badRes.json().detail).toContain('Incompatible unit dimensions');

    // Create Cooking Oil with densityGPerMl = 0.920000 -> 1000 ML = 0.92 KG (when base = KG)
    const oilRes = await app.inject({
      method: 'POST',
      url: '/v1/products',
      headers: authHeaders(ownerToken, { 'idempotency-key': randomUUID() }),
      payload: {
        sku: 'OIL-COCONUT-BULK',
        name: 'Coconut Oil',
        baseUom: 'KG',
        productQtyMode: 'VARIABLE',
        measurementCategory: 'WEIGHT',
        priceUom: 'KG',
        allowedSellingUoms: ['KG', 'G', 'L', 'ML'],
        densityGPerMl: '0.920000',
        featuredPos: true,
        purchaseCost: '700.0000',
        sellingPrice: '900.0000',
        trackInventory: true,
      },
    });
    expect(oilRes.statusCode).toBe(201);
    oilProductId = oilRes.json().id;

    const okVolMove = await app.inject({
      method: 'POST',
      url: '/v1/inventory/movements',
      headers: authHeaders(ownerToken, { 'idempotency-key': randomUUID() }),
      payload: {
        branchId,
        warehouseId,
        productId: oilProductId,
        movementType: 'STOCK_IN',
        quantity: '1.000000',
        uomCode: 'L',
        unitCost: '644.0000',
      },
    });
    expect(okVolMove.statusCode).toBe(201);
    expect(okVolMove.json().qtyDelta).toBe('0.920000');
  });

  it('UOM-04: PO in BAG -> Approve -> Goods Receipt (GRN) in BAG with MAC/Batch updates & without silently overwriting sellingPrice, plus Supplier Return in G', async () => {
    // Create BATCH tracked variable sugar (Base KG, Purchase BAG=50 KG)
    const sugarRes = await app.inject({
      method: 'POST',
      url: '/v1/products',
      headers: authHeaders(ownerToken, { 'idempotency-key': randomUUID() }),
      payload: {
        sku: 'SUGAR-BROWN-BATCH',
        name: 'Brown Sugar',
        trackingMode: 'BATCH',
        baseUom: 'KG',
        productQtyMode: 'VARIABLE',
        measurementCategory: 'WEIGHT',
        purchaseUom: 'BAG',
        priceUom: 'KG',
        allowedSellingUoms: ['KG', 'G'],
        featuredPos: true,
        purchaseCost: '200.0000',
        sellingPrice: '280.0000',
        trackInventory: true,
        unitConversions: [
          { uomCode: 'BAG', uomName: '50 KG Bag', conversionFactorToBase: '50.000000' },
        ],
      },
    });
    expect(sugarRes.statusCode).toBe(201);
    batchSugarId = sugarRes.json().id;

    // 1. Create DRAFT PO: 1 BAG @ LKR 12,000/BAG (= 240/KG), plus approve
    const poRes = await app.inject({
      method: 'POST',
      url: '/v1/purchase-orders',
      headers: authHeaders(ownerToken, { 'idempotency-key': randomUUID() }),
      payload: {
        branchId,
        warehouseId,
        supplierId,
        approveImmediately: false,
        lines: [
          {
            productId: batchSugarId,
            orderedUom: 'BAG',
            orderedQty: '1.000000',
            unitCost: '12000.0000',
          },
        ],
      },
    });
    expect(poRes.statusCode).toBe(201);
    const po = poRes.json();
    expect(po.status).toBe('DRAFT');
    expect(po.lines[0].normalizedBaseQty).toBe('50.000000');

    const appRes = await app.inject({
      method: 'POST',
      url: `/v1/purchase-orders/${po.id}/approve`,
      headers: authHeaders(ownerToken),
      payload: {},
    });
    expect(appRes.statusCode).toBe(200);
    expect(appRes.json().status).toBe('APPROVED');

    // 2. Receive GRN: 1 BAG @ 12,500/BAG -> 50 KG @ 250.00/KG + batch + expiry
    const grnRes = await app.inject({
      method: 'POST',
      url: '/v1/goods-receipts',
      headers: authHeaders(ownerToken, { 'idempotency-key': randomUUID() }),
      payload: {
        purchaseOrderId: po.id,
        supplierId,
        branchId,
        warehouseId,
        lines: [
          {
            purchaseOrderLineId: po.lines[0].id,
            productId: batchSugarId,
            receivedUom: 'BAG',
            receivedQty: '1.000000',
            unitCost: '12500.0000',
            batchNumber: 'BATCH-SUG-2026A',
            expiryDate: '2027-12-31',
          },
        ],
      },
    });
    expect(grnRes.statusCode).toBe(201);
    const grn = grnRes.json();
    expect(grn.lines[0].normalizedBaseQty).toBe('50.000000');
    expect(grn.lines[0].unitCostPerBaseUom).toBe('250.0000');

    // Selling price MUST NOT be silently overwritten when cost increases! Cost updates cleanly.
    const sugarAfterRes = await app.inject({
      method: 'GET',
      url: `/v1/products/${batchSugarId}`,
      headers: authHeaders(ownerToken),
    });
    expect(sugarAfterRes.statusCode).toBe(200);
    expect(sugarAfterRes.json().sellingPrice).toBe('280.0000');
    expect(sugarAfterRes.json().purchaseCost).toBe('250.0000');

    // Supplier Return of 500 G -> -0.500000 KG -> balance becomes 49.500000 KG
    const suppRetRes = await app.inject({
      method: 'POST',
      url: '/v1/supplier-returns',
      headers: authHeaders(ownerToken, { 'idempotency-key': randomUUID() }),
      payload: {
        supplierId,
        goodsReceiptId: grn.id,
        branchId,
        warehouseId,
        productId: batchSugarId,
        returnUom: 'G',
        returnQty: '500.000000',
        reason: 'Damaged sugar bag seam',
      },
    });
    expect(suppRetRes.statusCode).toBe(201);
    expect(suppRetRes.json().normalizedBaseQty).toBe('0.500000');

    const balAfter = await app.inject({
      method: 'GET',
      url: `/v1/inventory/balances?warehouseId=${warehouseId}&productId=${batchSugarId}`,
      headers: authHeaders(ownerToken),
    });
    expect(balAfter.json().data[0].qtyOnHand).toBe('49.500000');
  });

  it('UOM-05 & UOM-07: POS featured Weighed Products lookup, proportionate G/KG checkout, receipt snapshot, and partial UOM Customer Return (RESELLABLE vs DAMAGED)', async () => {
    // 1. Search featured variable items in POS
    const searchRes = await app.inject({
      method: 'GET',
      url: `/v1/pos/products/search?warehouseId=${warehouseId}&featuredOnly=true&qtyMode=VARIABLE`,
      headers: authHeaders(cashierToken),
    });
    expect(searchRes.statusCode).toBe(200);
    const items = searchRes.json() as Array<{ id: string; productQtyMode: string }>;
    expect(items.some((i) => i.id === sambaRiceId)).toBe(true);

    // 2. Samba Rice currently has 3.25 KG on hand @ LKR 260.00 / KG.
    // Sell 750 G -> 0.75 KG * 260 = 195.00 AND 1.25 KG -> 1.25 * 260 = 325.00
    const saleRes = await app.inject({
      method: 'POST',
      url: '/v1/pos/sales',
      headers: authHeaders(cashierToken, { 'idempotency-key': randomUUID() }),
      payload: {
        registerId,
        shiftId,
        lines: [
          {
            productId: sambaRiceId,
            quantity: '750.000000',
            uomCode: 'G',
            entrySource: 'MANUAL_WEIGHT',
          },
        ],
        payments: [
          {
            paymentMethod: 'CASH',
            amount: '195.0000',
            tenderedAmount: '200.0000',
          },
        ],
      },
    });
    expect(saleRes.statusCode).toBe(201);
    const sale = saleRes.json();
    expect(sale.grandTotal).toBe('195.0000');
    expect(sale.lines[0].originalEnteredQty).toBe('750.000000');
    expect(sale.lines[0].originalUomCode).toBe('G');
    expect(sale.lines[0].normalizedBaseQty).toBe('0.750000');
    expect(sale.lines[0].priceUom).toBe('KG');
    expect(sale.lines[0].pricePerPriceUom).toBe('260.0000');
    expect(sale.lines[0].entrySource).toBe('MANUAL_WEIGHT');

    // Remaining Samba Rice stock should now be 3.25 - 0.75 = 2.500000 KG
    const balMid = await app.inject({
      method: 'GET',
      url: `/v1/inventory/balances?warehouseId=${warehouseId}&productId=${sambaRiceId}`,
      headers: authHeaders(ownerToken),
    });
    expect(balMid.json().data[0].qtyOnHand).toBe('2.500000');

    // Trying to sell 3 KG (more than 2.5 KG available) MUST fail with 409 Insufficient Stock!
    const overSell = await app.inject({
      method: 'POST',
      url: '/v1/pos/sales',
      headers: authHeaders(cashierToken, { 'idempotency-key': randomUUID() }),
      payload: {
        registerId,
        shiftId,
        lines: [{ productId: sambaRiceId, quantity: '3000.000000', uomCode: 'G' }],
        payments: [{ paymentMethod: 'CASH', amount: '780.0000', tenderedAmount: '780.0000' }],
      },
    });
    expect(overSell.statusCode).toBe(409);

    // Check receipt snapshot endpoint
    const recRes = await app.inject({
      method: 'GET',
      url: `/v1/pos/sales/${sale.id}/receipt`,
      headers: authHeaders(cashierToken),
    });
    expect(recRes.statusCode).toBe(200);
    const receipt = recRes.json();
    expect(receipt.lines[0].originalEnteredQty).toBe('750.000000');
    expect(receipt.lines[0].originalUomCode).toBe('G');
    expect(receipt.lines[0].pricePerPriceUom).toBe('260.0000');
    expect(receipt.lines[0].priceUom).toBe('KG');

    // 3. Partial UOM Customer Return (RESELLABLE): return 250 G from 750 G sold -> refund 65.00, restocks +0.25 KG (2.5 -> 2.75 KG)
    const ret1Res = await app.inject({
      method: 'POST',
      url: `/v1/pos/sales/${sale.id}/returns`,
      headers: authHeaders(cashierToken, { 'idempotency-key': randomUUID() }),
      payload: {
        reason: 'Customer needed only 500g',
        refundMethod: 'CASH',
        lines: [
          {
            invoiceLineId: sale.lines[0].id,
            returnQty: '250.000000',
            returnUom: 'G',
            restockCondition: 'RESELLABLE',
          },
        ],
      },
    });
    expect(ret1Res.statusCode).toBe(201);
    expect(ret1Res.json().totalRefundAmount).toBe('65.0000');
    expect(ret1Res.json().lines[0].normalizedBaseQty).toBe('0.250000');

    const balAfterRet1 = await app.inject({
      method: 'GET',
      url: `/v1/inventory/balances?warehouseId=${warehouseId}&productId=${sambaRiceId}`,
      headers: authHeaders(ownerToken),
    });
    expect(balAfterRet1.json().data[0].qtyOnHand).toBe('2.750000');

    // 4. Second partial return (DAMAGED): return 0.25 KG -> refund 65.00, balance stays 2.750000 KG (does NOT restock damaged food!)
    const ret2Res = await app.inject({
      method: 'POST',
      url: `/v1/pos/sales/${sale.id}/returns`,
      headers: authHeaders(cashierToken, { 'idempotency-key': randomUUID() }),
      payload: {
        reason: 'Torn bag after purchase',
        refundMethod: 'CASH',
        lines: [
          {
            invoiceLineId: sale.lines[0].id,
            returnQty: '0.250000',
            returnUom: 'KG',
            restockCondition: 'DAMAGED',
          },
        ],
      },
    });
    expect(ret2Res.statusCode).toBe(201);

    const balAfterRet2 = await app.inject({
      method: 'GET',
      url: `/v1/inventory/balances?warehouseId=${warehouseId}&productId=${sambaRiceId}`,
      headers: authHeaders(ownerToken),
    });
    expect(balAfterRet2.json().data[0].qtyOnHand).toBe('2.750000');

    // 5. Third return exceeding cumulative sold base qty (500G already returned + 300G > 750G) MUST be rejected!
    const retOverflow = await app.inject({
      method: 'POST',
      url: `/v1/pos/sales/${sale.id}/returns`,
      headers: authHeaders(cashierToken, { 'idempotency-key': randomUUID() }),
      payload: {
        reason: 'Over-return attempt',
        refundMethod: 'CASH',
        lines: [
          {
            invoiceLineId: sale.lines[0].id,
            returnQty: '300.000000',
            returnUom: 'G',
            restockCondition: 'RESELLABLE',
          },
        ],
      },
    });
    expect(retOverflow.statusCode).toBe(409);
  });
});

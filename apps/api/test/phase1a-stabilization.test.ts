import { type KeyObject, generateKeyPairSync, sign } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

describe('@nexstock/api — Phase 1A Stabilization Verification (BUG-087, BUG-089, BUG-094, BUG-095, BUG-096, BUG-097)', () => {
  let harness: TestPostgresHarness;
  let app: AppInstance;

  const TENANT_ID = '0192f100-0000-7000-8000-000000000001';
  const OWNER_USER_ID = '0192f100-0000-7000-8000-000000000002';
  const MANAGER_USER_ID = '0192f100-0000-7000-8000-000000000003';
  const CASHIER_USER_ID = '0192f100-0000-7000-8000-000000000004';

  const primaryKey = createTestEs256KeyMaterial('phase1a-test-key');
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
  let managerToken: string;
  let cashierToken: string;

  let branchId: string;
  let warehouseId: string;
  let registerAId: string;
  let registerBId: string;
  let shiftAId: string;

  let standardProductId: string;
  let weightedProductId: string;
  let batchFifoProductId: string;
  let customerId: string;

  const authHeaders = (token: string, extra?: Record<string, string>) => ({
    authorization: `Bearer ${token}`,
    'x-tenant-id': TENANT_ID,
    'content-type': 'application/json',
    ...extra,
  });

  const idemHeaders = (token: string) =>
    authHeaders(token, { 'idempotency-key': generateUuidV7() });

  beforeAll(async () => {
    harness = await createTestPostgresHarness();
    ownerToken = issueToken(OWNER_USER_ID, 'owner@phase1a.test');
    managerToken = issueToken(MANAGER_USER_ID, 'manager@phase1a.test');
    cashierToken = issueToken(CASHIER_USER_ID, 'cashier@phase1a.test');

    app = await buildApp({ db: harness.db, jwksProvider });

    const onboardRes = await app.inject({
      method: 'POST',
      url: '/v1/org/tenants/onboard',
      headers: authHeaders(ownerToken),
      payload: {
        slug: 'phase1a-stab-retail',
        legalName: 'Phase 1A Retail Ltd',
        baseCurrency: 'LKR',
        defaultLocale: 'en-US',
        defaultTimezone: 'Asia/Colombo',
        countryCode: 'LK',
        ownerEmail: 'owner@phase1a.test',
        ownerFullName: 'Owner Phase1A',
        planCode: 'GROWTH',
      },
    });
    expect(onboardRes.statusCode).toBe(201);

    const branchRes = await app.inject({
      method: 'POST',
      url: '/v1/org/branches',
      headers: authHeaders(ownerToken),
      payload: {
        code: 'BR-P1A',
        name: 'Colombo Flagship',
        timezone: 'Asia/Colombo',
        countryCode: 'LK',
      },
    });
    expect(branchRes.statusCode).toBe(201);
    branchId = branchRes.json().id;

    const whRes = await app.inject({
      method: 'POST',
      url: '/v1/org/warehouses',
      headers: authHeaders(ownerToken),
      payload: {
        branchId,
        code: 'WH-P1A',
        name: 'Colombo Central WH',
        allowNegativeStock: false,
      },
    });
    expect(whRes.statusCode).toBe(201);
    warehouseId = whRes.json().id;

    await withTenantTransaction(
      harness.db,
      { tenantId: TENANT_ID, userId: OWNER_USER_ID, traceId: 'seed_p1a_staff' },
      async (trx) => {
        await provisionTenantMember(trx, {
          userId: MANAGER_USER_ID,
          email: 'manager@phase1a.test',
          fullName: 'Supervisor Manager',
          roleCodes: ['BRANCH_MANAGER'],
          allLocationsAccess: true,
          status: 'ACTIVE',
        });
        await provisionTenantMember(trx, {
          userId: CASHIER_USER_ID,
          email: 'cashier@phase1a.test',
          fullName: 'Frontline Cashier',
          roleCodes: ['CASHIER'],
          allLocationsAccess: true,
          status: 'ACTIVE',
        });
      },
    );

    const regARes = await app.inject({
      method: 'POST',
      url: '/v1/pos/registers',
      headers: authHeaders(ownerToken),
      payload: { branchId, warehouseId, code: 'REG-P1A-01', name: 'Register 01' },
    });
    expect(regARes.statusCode).toBe(201);
    registerAId = regARes.json().id;

    const regBRes = await app.inject({
      method: 'POST',
      url: '/v1/pos/registers',
      headers: authHeaders(ownerToken),
      payload: { branchId, warehouseId, code: 'REG-P1A-02', name: 'Register 02' },
    });
    expect(regBRes.statusCode).toBe(201);
    registerBId = regBRes.json().id;

    const shiftRes = await app.inject({
      method: 'POST',
      url: '/v1/pos/shifts',
      headers: idemHeaders(cashierToken),
      payload: { registerId: registerAId, openingCashFloat: '1000.0000' },
    });
    expect(shiftRes.statusCode).toBe(201);
    shiftAId = shiftRes.json().id;

    const stdProdRes = await app.inject({
      method: 'POST',
      url: '/v1/products',
      headers: authHeaders(ownerToken),
      payload: {
        sku: 'SOAP-STD-P1A',
        name: 'Standard Herbal Soap',
        baseUom: 'PCS',
        purchaseCost: '100.0000',
        sellingPrice: '200.0000',
        imageUrl: '/v1/media/soap.png',
        trackInventory: true,
        trackingMode: 'NONE',
        valuationMethod: 'MOVING_AVG',
      },
    });
    expect(stdProdRes.statusCode).toBe(201);
    standardProductId = stdProdRes.json().id;

    const wtProdRes = await app.inject({
      method: 'POST',
      url: '/v1/products',
      headers: authHeaders(ownerToken),
      payload: {
        sku: 'SUGAR-KG-P1A',
        name: 'Brown Cane Sugar',
        baseUom: 'KG',
        purchaseUom: 'KG',
        priceUom: 'KG',
        productQtyMode: 'VARIABLE',
        measurementCategory: 'WEIGHT',
        allowedSellingUoms: ['KG', 'G'],
        qtyDecimalPrecision: 3,
        featuredPos: true,
        purchaseCost: '300.0000',
        sellingPrice: '450.0000',
        trackInventory: true,
        trackingMode: 'NONE',
        valuationMethod: 'MOVING_AVG',
      },
    });
    expect(wtProdRes.statusCode).toBe(201);
    weightedProductId = wtProdRes.json().id;

    const batchProdRes = await app.inject({
      method: 'POST',
      url: '/v1/products',
      headers: authHeaders(ownerToken),
      payload: {
        sku: 'FIFO-MED-P1A',
        name: 'Batch FIFO Medicine',
        baseUom: 'PCS',
        purchaseCost: '100.0000',
        sellingPrice: '220.0000',
        trackInventory: true,
        trackingMode: 'BATCH_EXPIRY',
        valuationMethod: 'FIFO',
      },
    });
    expect(batchProdRes.statusCode).toBe(201);
    batchFifoProductId = batchProdRes.json().id;

    const custRes = await app.inject({
      method: 'POST',
      url: '/v1/customers',
      headers: authHeaders(ownerToken),
      payload: { name: 'Credit Test Buyer', phone: '0770001122' },
    });
    expect(custRes.statusCode).toBe(201);
    customerId = custRes.json().id;

    const creditRes = await app.inject({
      method: 'POST',
      url: '/v1/credit/accounts',
      headers: authHeaders(ownerToken),
      payload: {
        customerId,
        creditLimit: '300.0000',
        creditTerms: 'NET_30',
      },
    });
    expect(creditRes.statusCode).toBe(201);
  });

  afterAll(async () => {
    await app.close();
    if (harness?.db) await harness.db.destroy();
  });

  it('BUG-087: GET /v1/inventory/balances returns baseUom, imageUrl, warehouseName, and branchName', async () => {
    const moveRes = await app.inject({
      method: 'POST',
      url: '/v1/inventory/movements',
      headers: idemHeaders(ownerToken),
      payload: {
        branchId,
        warehouseId,
        productId: standardProductId,
        movementType: 'OPENING_STOCK',
        quantity: '25.000000',
        uomCode: 'PCS',
        unitCost: '100.0000',
      },
    });
    expect(moveRes.statusCode).toBe(201);

    const balRes = await app.inject({
      method: 'GET',
      url: `/v1/inventory/balances?warehouseId=${warehouseId}&productId=${standardProductId}`,
      headers: authHeaders(cashierToken),
    });
    expect(balRes.statusCode).toBe(200);
    const items = balRes.json().data as Array<Record<string, unknown>>;
    expect(items.length).toBe(1);
    expect(items[0]!.baseUom).toBe('PCS');
    expect(items[0]!.imageUrl).toBe('/v1/media/soap.png');
    expect(items[0]!.warehouseName).toBe('Colombo Central WH');
    expect(items[0]!.branchName).toBe('Colombo Flagship');
  });

  it('BUG-089: Active shift lookup by registerId distinguishes active register from idle register', async () => {
    const activeRes = await app.inject({
      method: 'GET',
      url: `/v1/pos/shifts/active?registerId=${registerAId}`,
      headers: authHeaders(cashierToken),
    });
    expect(activeRes.statusCode).toBe(200);
    expect(activeRes.json().registerId).toBe(registerAId);

    const idleRes = await app.inject({
      method: 'GET',
      url: `/v1/pos/shifts/active?registerId=${registerBId}`,
      headers: authHeaders(cashierToken),
    });
    expect(idleRes.statusCode).toBe(404);
    expect(idleRes.json().errorCode).toBe('POS_NO_ACTIVE_SHIFT');
  });

  it('BUG-094 & BUG-095: STOCK_CHANGED emits warehouseId, signed base-UOM qtyDelta, and authoritative balanceAfter across movements and POS sales', async () => {
    // 1. STOCK_IN on weighted KG product (+10 KG)
    const inRes = await app.inject({
      method: 'POST',
      url: '/v1/inventory/movements',
      headers: idemHeaders(ownerToken),
      payload: {
        branchId,
        warehouseId,
        productId: weightedProductId,
        movementType: 'STOCK_IN',
        quantity: '10.000000',
        uomCode: 'KG',
        unitCost: '300.0000',
      },
    });
    expect(inRes.statusCode).toBe(201);

    // 2. POS Sale in selling-UOM 500 G -> base UOM delta must be -0.500000 KG, balanceAfter = 9.500000
    const saleRes = await app.inject({
      method: 'POST',
      url: '/v1/pos/sales',
      headers: idemHeaders(cashierToken),
      payload: {
        registerId: registerAId,
        shiftId: shiftAId,
        lines: [
          {
            productId: weightedProductId,
            quantity: '500.000000',
            uomCode: 'G',
          },
        ],
        payments: [
          {
            paymentMethod: 'CASH',
            amount: '225.0000',
            tenderedAmount: '250.0000',
          },
        ],
      },
    });
    expect(saleRes.statusCode).toBe(201);
    const saleId = saleRes.json().id;

    const pollRes = await app.inject({
      method: 'GET',
      url: `/v1/realtime/poll?branchId=${branchId}`,
      headers: authHeaders(cashierToken),
    });
    expect(pollRes.statusCode).toBe(200);
    const events = (pollRes.json().events as Array<{
      id: string;
      eventType: string;
      data: {
        warehouseId?: string;
        saleId?: string;
        qtyDelta?: string;
        balanceAfter?: string;
        productId?: string;
        lines?: Array<{
          productId: string;
          qtyDelta?: string;
          balanceAfter?: string;
        }>;
      };
    }>).filter((e) => e.eventType === 'STOCK_CHANGED');

    const inboundEv = events.find(
      (e) => e.data.productId === weightedProductId && e.data.qtyDelta === '10.000000',
    );
    expect(inboundEv).toBeDefined();
    expect(inboundEv!.data.warehouseId).toBe(warehouseId);
    expect(inboundEv!.data.balanceAfter).toBe('10.000000');

    const saleEv = events.find((e) => e.data.saleId === saleId);
    expect(saleEv).toBeDefined();
    expect(saleEv!.data.warehouseId).toBe(warehouseId);
    expect(saleEv!.data.lines![0]!.qtyDelta).toBe('-0.500000');
    expect(saleEv!.data.lines![0]!.balanceAfter).toBe('9.500000');
  });

  it('BUG-096: Resolves TENANT_OWNER / BRANCH_MANAGER roles accurately for POS order discount and credit limit overrides', async () => {
    // 1. Cashier rejected on arbitrary order discount
    const cashierDiscRes = await app.inject({
      method: 'POST',
      url: '/v1/pos/sales',
      headers: idemHeaders(cashierToken),
      payload: {
        registerId: registerAId,
        shiftId: shiftAId,
        lines: [{ productId: standardProductId, quantity: '1.000000', uomCode: 'PCS' }],
        orderDiscountAmount: '10.0000',
        payments: [{ paymentMethod: 'CASH', amount: '190.0000', tenderedAmount: '200.0000' }],
      },
    });
    expect(cashierDiscRes.statusCode).toBe(403);
    expect(cashierDiscRes.json().errorCode).toBe('POS_UNAUTHORIZED_DISCOUNT');

    // 2. Branch Manager allowed for order discount (failed previously due to OWNER/ADMIN check + wrong membership column)
    const managerDiscRes = await app.inject({
      method: 'POST',
      url: '/v1/pos/sales',
      headers: idemHeaders(managerToken),
      payload: {
        registerId: registerAId,
        shiftId: shiftAId,
        lines: [{ productId: standardProductId, quantity: '1.000000', uomCode: 'PCS' }],
        orderDiscountAmount: '10.0000',
        payments: [{ paymentMethod: 'CASH', amount: '190.0000', tenderedAmount: '200.0000' }],
      },
    });
    expect(managerDiscRes.statusCode).toBe(201);

    // 3. Cashier rejected on credit limit exceeded (2 x 200 = 400 > 300 limit)
    const cashierCreditRes = await app.inject({
      method: 'POST',
      url: '/v1/pos/sales',
      headers: idemHeaders(cashierToken),
      payload: {
        registerId: registerAId,
        shiftId: shiftAId,
        customerId,
        lines: [{ productId: standardProductId, quantity: '2.000000', uomCode: 'PCS' }],
        payments: [{ paymentMethod: 'CREDIT', amount: '400.0000', tenderedAmount: '400.0000' }],
      },
    });
    expect(cashierCreditRes.statusCode).toBe(409);
    expect(cashierCreditRes.json().errorCode).toBe('CREDIT_LIMIT_EXCEEDED');

    // 4. Tenant Owner allowed to override credit limit via resolved role code TENANT_OWNER
    const ownerCreditRes = await app.inject({
      method: 'POST',
      url: '/v1/pos/sales',
      headers: idemHeaders(ownerToken),
      payload: {
        registerId: registerAId,
        shiftId: shiftAId,
        customerId,
        lines: [{ productId: standardProductId, quantity: '2.000000', uomCode: 'PCS' }],
        payments: [{ paymentMethod: 'CREDIT', amount: '400.0000', tenderedAmount: '400.0000' }],
      },
    });
    expect(ownerCreditRes.statusCode).toBe(201);
  });

  it('BUG-097: FIFO outbound consumption filters by batch_id and movement reversal restores consumed FIFO layers & asset valuation', async () => {
    // Receive Batch A (5 @ 100) and Batch B (5 @ 150)
    const batchARes = await app.inject({
      method: 'POST',
      url: '/v1/inventory/batches',
      headers: idemHeaders(ownerToken),
      payload: {
        branchId,
        warehouseId,
        productId: batchFifoProductId,
        batchNumber: 'LOT-FIFO-A',
        initialQuantity: '5.000000',
        unitCost: '100.0000',
        receivedDate: '2026-01-01',
        expiryDate: '2028-01-01',
      },
    });
    expect(batchARes.statusCode).toBe(201);
    const batchAId = batchARes.json().id;

    const batchBRes = await app.inject({
      method: 'POST',
      url: '/v1/inventory/batches',
      headers: idemHeaders(ownerToken),
      payload: {
        branchId,
        warehouseId,
        productId: batchFifoProductId,
        batchNumber: 'LOT-FIFO-B',
        initialQuantity: '5.000000',
        unitCost: '150.0000',
        receivedDate: '2026-01-02',
        expiryDate: '2027-06-01',
      },
    });
    expect(batchBRes.statusCode).toBe(201);
    const batchBId = batchBRes.json().id;

    // Issue 2 PCS explicitly from Batch B -> MUST consume Batch B's 150.0000 cost layer (not Batch A's 100.0000!)
    const outRes = await app.inject({
      method: 'POST',
      url: '/v1/inventory/movements',
      headers: idemHeaders(ownerToken),
      payload: {
        branchId,
        warehouseId,
        productId: batchFifoProductId,
        batchId: batchBId,
        movementType: 'STOCK_OUT',
        quantity: '-2.000000',
        uomCode: 'PCS',
        unitCost: '150.0000',
        reason: 'Dispatch batch B',
      },
    });
    expect(outRes.statusCode).toBe(201);
    const outMove = outRes.json();
    expect(outMove.unitCost).toBe('150.0000');
    expect(outMove.totalCostDelta).toBe('-300.0000');

    // Inspect layers: Batch A layer remains untouched at 5.000000; Batch B layer is down to 3.000000
    const layersBeforeRevRes = await app.inject({
      method: 'GET',
      url: `/v1/inventory/cost-layers?warehouseId=${warehouseId}&productId=${batchFifoProductId}`,
      headers: authHeaders(ownerToken),
    });
    expect(layersBeforeRevRes.statusCode).toBe(200);
    const layersBeforeRev = layersBeforeRevRes.json() as Array<{
      batchId: string | null;
      remainingQty: string;
      status: string;
    }>;
    const layerA1 = layersBeforeRev.find((l) => l.batchId === batchAId);
    const layerB1 = layersBeforeRev.find((l) => l.batchId === batchBId);
    expect(layerA1!.remainingQty).toBe('5.000000');
    expect(layerB1!.remainingQty).toBe('3.000000');

    // Reverse the Batch B outbound movement -> MUST restore Batch B cost layer to 5.000000 and total asset value to 1250.0000
    const revRes = await app.inject({
      method: 'POST',
      url: `/v1/inventory/movements/${outMove.id}/reverse`,
      headers: idemHeaders(ownerToken),
      payload: { reason: 'Undo accidental dispatch of batch B' },
    });
    expect(revRes.statusCode).toBe(201);

    const layersAfterRevRes = await app.inject({
      method: 'GET',
      url: `/v1/inventory/cost-layers?warehouseId=${warehouseId}&productId=${batchFifoProductId}`,
      headers: authHeaders(ownerToken),
    });
    expect(layersAfterRevRes.statusCode).toBe(200);
    const layersAfterRev = layersAfterRevRes.json() as Array<{
      batchId: string | null;
      remainingQty: string;
      status: string;
    }>;
    const layerBAfter = layersAfterRev.find((l) => l.batchId === batchBId);
    expect(layerBAfter!.remainingQty).toBe('5.000000');
    expect(layerBAfter!.status).toBe('OPEN');

    const balAfterRevRes = await app.inject({
      method: 'GET',
      url: `/v1/inventory/balances?warehouseId=${warehouseId}&productId=${batchFifoProductId}`,
      headers: authHeaders(ownerToken),
    });
    expect(balAfterRevRes.statusCode).toBe(200);
    const balRow = balAfterRevRes.json().data[0];
    expect(balRow.qtyOnHand).toBe('10.000000');
    expect(balRow.totalInventoryValue).toBe('1250.0000');
  });
});

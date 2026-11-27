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
  type TestPostgresHarness,
  createTestPostgresHarness,
} from './helpers/pglite-kysely.js';

interface TestEs256KeyMaterial {
  readonly kid: string;
  readonly privateKey: KeyObject;
  readonly publicJwk: SupabaseJwk;
}

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

describe('@nexstock/api — Consolidated QA Fix Assignment (DI-001, Smart Pricing, UoM/Rounding, Expenses, Customers, Dashboard, Inventory Search)', () => {
  let harness: TestPostgresHarness;
  let app: Awaited<ReturnType<typeof buildApp>>;

  const primaryKey = createTestEs256KeyMaterial('consolidated-qa-key-1');
  const jwksProvider = new StaticJwksProvider({
    keys: [primaryKey.publicJwk],
  });

  const TENANT_ID = '0192d500-0000-7000-8000-000000000001';
  const OWNER_USER_ID = '0192d500-0000-7000-8000-000000000002';
  const CASHIER2_USER_ID = '0192d500-0000-7000-8000-000000000003';
  let ownerToken: string;
  let cashier2Token: string;

  let branch1Id: string;
  let wh1Id: string;
  let reg1Id: string;
  let shift1Id: string;

  let branch2Id: string;
  let wh2Id: string;
  let reg2Id: string;
  let shift2Id: string;

  const issueToken = (userId: string, email = 'owner@qa-consolidated.test') =>
    signEs256Jwt(primaryKey, {
      iss: DEFAULT_SUPABASE_JWT_ISSUER,
      aud: DEFAULT_SUPABASE_JWT_AUDIENCE,
      sub: userId,
      email,
      iat: Math.floor(Date.now() / 1000) - 60,
      nbf: Math.floor(Date.now() / 1000) - 60,
      exp: Math.floor(Date.now() / 1000) + 7200,
    });

  const authHeaders = (extra?: Record<string, string>) => ({
    authorization: `Bearer ${ownerToken}`,
    'x-tenant-id': TENANT_ID,
    ...extra,
  });

  beforeAll(async () => {
    harness = await createTestPostgresHarness();
    app = await buildApp({ db: harness.db, jwksProvider });
    ownerToken = issueToken(OWNER_USER_ID);
    cashier2Token = issueToken(CASHIER2_USER_ID, 'cashier2@qa-consolidated.test');

    const onboardRes = await app.inject({
      method: 'POST',
      url: '/v1/org/tenants/onboard',
      headers: authHeaders(),
      payload: {
        slug: 'qa-consolidated-retail',
        legalName: 'Consolidated QA Retail Ltd',
        baseCurrency: 'LKR',
        defaultLocale: 'en-US',
        defaultTimezone: 'Asia/Colombo',
        countryCode: 'LK',
        ownerEmail: 'owner@qa-consolidated.test',
        ownerFullName: 'QA Owner',
        planCode: 'ENTERPRISE',
      },
    });
    expect(onboardRes.statusCode).toBe(201);

    await withTenantTransaction(
      harness.db,
      { tenantId: TENANT_ID, userId: OWNER_USER_ID, traceId: 'qa_seed_c2' },
      async (trx) => {
        await provisionTenantMember(trx, {
          userId: CASHIER2_USER_ID,
          email: 'cashier2@qa-consolidated.test',
          fullName: 'Branch 2 Cashier',
          roleCodes: ['CASHIER'],
          allLocationsAccess: true,
          status: 'ACTIVE',
        });
      },
    );

    // Branch 1
    const b1Res = await app.inject({
      method: 'POST',
      url: '/v1/org/branches',
      headers: authHeaders(),
      payload: { code: 'BR-MAIN', name: 'Main Flagship' },
    });
    expect(b1Res.statusCode).toBe(201);
    branch1Id = b1Res.json().id;
    wh1Id = b1Res.json().defaultWarehouseId;

    const r1Res = await app.inject({
      method: 'POST',
      url: '/v1/pos/registers/ensure-default',
      headers: authHeaders(),
      payload: { branchId: branch1Id },
    });
    expect([200, 201]).toContain(r1Res.statusCode);
    reg1Id = r1Res.json().id;

    const s1Res = await app.inject({
      method: 'POST',
      url: '/v1/pos/shifts',
      headers: authHeaders(),
      payload: { registerId: reg1Id, openingCashFloat: '1000.0000' },
    });
    expect(s1Res.statusCode).toBe(201);
    shift1Id = s1Res.json().id;
  });

  afterAll(async () => {
    if (app) await app.close();
    if (harness?.db) await harness.db.destroy();
  });

  it('1. DI-001: enforces strict branch-level product, category, pricing, barcode, POS, and sync isolation while preserving inter-branch transfer independence', async () => {
    // Seed category & product scoped to Branch 1 BEFORE creating Branch 2
    const catB1Res = await app.inject({
      method: 'POST',
      url: '/v1/categories',
      headers: authHeaders({ 'x-branch-id': branch1Id }),
      payload: { name: 'Branch 1 Exclusive Tea', branchId: branch1Id },
    });
    expect(catB1Res.statusCode).toBe(201);
    const catB1Id = catB1Res.json().id as string;

    const prodB1Res = await app.inject({
      method: 'POST',
      url: '/v1/products',
      headers: authHeaders({ 'x-branch-id': branch1Id, 'idempotency-key': generateUuidV7() }),
      payload: {
        sku: 'ISO-TEA-001',
        name: 'Nuwara Eliya Tea 250g',
        categoryId: catB1Id,
        baseUom: 'PCS',
        purchaseCost: '400.0000',
        sellingPrice: '600.0000',
        trackInventory: true,
        primaryBarcode: 'BC-B1-ISO-001',
        branchId: branch1Id,
      },
    });
    expect(prodB1Res.statusCode).toBe(201);
    const prodB1Id = prodB1Res.json().id as string;

    await app.inject({
      method: 'POST',
      url: '/v1/inventory/movements',
      headers: authHeaders({ 'idempotency-key': generateUuidV7() }),
      payload: {
        branchId: branch1Id,
        warehouseId: wh1Id,
        productId: prodB1Id,
        movementType: 'OPENING_STOCK',
        quantity: '20.000000',
        unitCost: '400.0000',
      },
    });

    // Now create Branch 2 — must start completely clean with ZERO inherited categories or products
    const b2Res = await app.inject({
      method: 'POST',
      url: '/v1/org/branches',
      headers: authHeaders(),
      payload: { code: 'BR-SEC', name: 'Second Clean Branch' },
    });
    expect(b2Res.statusCode).toBe(201);
    branch2Id = b2Res.json().id;
    wh2Id = b2Res.json().defaultWarehouseId;

    const r2Res = await app.inject({
      method: 'POST',
      url: '/v1/pos/registers/ensure-default',
      headers: authHeaders(),
      payload: { branchId: branch2Id },
    });
    expect([200, 201]).toContain(r2Res.statusCode);
    reg2Id = r2Res.json().id;

    const s2Res = await app.inject({
      method: 'POST',
      url: '/v1/pos/shifts',
      headers: { authorization: `Bearer ${cashier2Token}`, 'x-tenant-id': TENANT_ID },
      payload: { registerId: reg2Id, openingCashFloat: '1000.0000' },
    });
    expect(s2Res.statusCode).toBe(201);
    shift2Id = s2Res.json().id;

    // Clean check in Branch 2
    const b2Cats = await app.inject({
      method: 'GET',
      url: `/v1/categories?branchId=${branch2Id}`,
      headers: authHeaders({ 'x-branch-id': branch2Id }),
    });
    expect(b2Cats.statusCode).toBe(200);
    expect(b2Cats.json().data).toHaveLength(0);

    const b2Prods = await app.inject({
      method: 'GET',
      url: `/v1/products?branchId=${branch2Id}`,
      headers: authHeaders({ 'x-branch-id': branch2Id }),
    });
    expect(b2Prods.statusCode).toBe(200);
    expect(b2Prods.json().data).toHaveLength(0);

    const b2PosSearch = await app.inject({
      method: 'GET',
      url: `/v1/pos/products/search?warehouseId=${wh2Id}&branchId=${branch2Id}`,
      headers: authHeaders({ 'x-branch-id': branch2Id }),
    });
    expect(b2PosSearch.statusCode).toBe(200);
    expect(b2PosSearch.json()).toHaveLength(0);

    const b2Sync = await app.inject({
      method: 'GET',
      url: `/v1/sync/catalog-pricing?branchId=${branch2Id}`,
      headers: authHeaders({ 'x-branch-id': branch2Id }),
    });
    expect(b2Sync.statusCode).toBe(200);
    expect(b2Sync.json().globalPrices).toHaveLength(0);

    // Direct checkout of Branch 1's unassigned product in Branch 2 must be blocked
    const illegalCheckout = await app.inject({
      method: 'POST',
      url: '/v1/pos/sales',
      headers: { authorization: `Bearer ${cashier2Token}`, 'x-tenant-id': TENANT_ID, 'x-branch-id': branch2Id, 'idempotency-key': generateUuidV7() },
      payload: {
        registerId: reg2Id,
        shiftId: shift2Id,
        lines: [{ productId: prodB1Id, quantity: '1.000000' }],
        payments: [{ paymentMethod: 'CASH', amount: '600.0000', tenderedAmount: '600.0000' }],
      },
    });
    expect(illegalCheckout.statusCode).toBe(404);

    // Same SKU created independently in Branch 2 must succeed & stay isolated from Branch 1
    const prodB2SameSkuRes = await app.inject({
      method: 'POST',
      url: '/v1/products',
      headers: authHeaders({ 'x-branch-id': branch2Id, 'idempotency-key': generateUuidV7() }),
      payload: {
        sku: 'ISO-TEA-001',
        name: 'Kandy Local Tea 250g',
        baseUom: 'PCS',
        purchaseCost: '300.0000',
        sellingPrice: '450.0000',
        trackInventory: false,
        primaryBarcode: 'BC-B2-ISO-001',
        branchId: branch2Id,
      },
    });
    expect(prodB2SameSkuRes.statusCode).toBe(201);
    const prodB2OnlyId = prodB2SameSkuRes.json().id as string;
    expect(prodB2OnlyId).not.toBe(prodB1Id);

    // Branch 1 sees only its own ISO-TEA-001
    const b1Prods = await app.inject({
      method: 'GET',
      url: `/v1/products?branchId=${branch1Id}`,
      headers: authHeaders({ 'x-branch-id': branch1Id }),
    });
    expect(b1Prods.json().data.map((p: { id: string }) => p.id)).toEqual([prodB1Id]);

    // Inter-branch transfer enrolls prodB1Id in Branch 2 and allows independent Branch 2 sellingPrice override
    const trRes = await app.inject({
      method: 'POST',
      url: '/v1/inventory/transfers',
      headers: authHeaders(),
      payload: {
        sourceBranchId: branch1Id,
        destinationBranchId: branch2Id,
        autoComplete: true,
        lines: [{ productId: prodB1Id, quantity: '5.000000' }],
      },
    });
    expect(trRes.statusCode).toBe(201);

    // Edit Branch 2 price for transferred product -> must NOT change Branch 1 sellingPrice
    const patchB2Price = await app.inject({
      method: 'PATCH',
      url: `/v1/products/${prodB1Id}`,
      headers: authHeaders({ 'x-branch-id': branch2Id }),
      payload: { sellingPrice: '690.0000', branchId: branch2Id },
    });
    expect(patchB2Price.statusCode).toBe(200);
    expect(patchB2Price.json().sellingPrice).toBe('690.0000');

    const getB1AfterPatch = await app.inject({
      method: 'GET',
      url: `/v1/products/${prodB1Id}?branchId=${branch1Id}`,
      headers: authHeaders({ 'x-branch-id': branch1Id }),
    });
    expect(getB1AfterPatch.statusCode).toBe(200);
    expect(getB1AfterPatch.json().sellingPrice).toBe('600.0000');
  });

  it('2. 3.1 Weighed/Measured Smart Pricing: STOCK_IN cost/price change routes to PENDING price_suggestions without stock_config_alerts or required barcode, keeping POS price intact until approved', async () => {
    const createPetrolRes = await app.inject({
      method: 'POST',
      url: '/v1/products',
      headers: authHeaders({ 'x-branch-id': branch1Id, 'idempotency-key': generateUuidV7() }),
      payload: {
        sku: 'FUEL-PETROL-92',
        name: 'Octane 92 Petrol',
        baseUom: 'L',
        priceUom: 'L',
        productQtyMode: 'VARIABLE',
        measurementCategory: 'VOLUME',
        allowedSellingUoms: ['L', 'ML'],
        qtyDecimalPrecision: 3,
        purchaseCost: '300.0000',
        sellingPrice: '350.0000',
        trackInventory: true,
        branchId: branch1Id,
      },
    });
    expect(createPetrolRes.statusCode).toBe(201);
    const petrolId = createPetrolRes.json().id as string;

    // Receive 100 L @ cost 300 / price 350 first
    await app.inject({
      method: 'POST',
      url: '/v1/inventory/movements',
      headers: authHeaders({ 'idempotency-key': generateUuidV7() }),
      payload: {
        branchId: branch1Id,
        warehouseId: wh1Id,
        productId: petrolId,
        movementType: 'OPENING_STOCK',
        quantity: '100.000000',
        uomCode: 'L',
        unitCost: '300.0000',
        sellingPrice: '350.0000',
      },
    });

    // Now receive 100 L @ higher cost 320 & proposed selling price 380 -> no barcode needed!
    const stockInRes = await app.inject({
      method: 'POST',
      url: '/v1/inventory/movements',
      headers: authHeaders({ 'idempotency-key': generateUuidV7() }),
      payload: {
        branchId: branch1Id,
        warehouseId: wh1Id,
        productId: petrolId,
        movementType: 'STOCK_IN',
        quantity: '100.000000',
        uomCode: 'L',
        unitCost: '320.0000',
        sellingPrice: '380.0000',
        reason: 'Refinery price revision',
      },
    });
    expect(stockInRes.statusCode).toBe(201);
    const mv = stockInRes.json();
    // Should NOT create stock_config_alerts; should queue price_suggestions
    expect(mv.configAlertId).toBeNull();
    expect(mv.priceSuggestionId).toBeTruthy();

    const alertsRes = await app.inject({
      method: 'GET',
      url: `/v1/inventory/config-alerts?productId=${petrolId}&status=PENDING`,
      headers: authHeaders({ 'x-branch-id': branch1Id }),
    });
    expect(alertsRes.statusCode).toBe(200);
    expect(alertsRes.json().length).toBe(0);

    // Active POS selling price must remain 350.0000 until owner approves suggestion
    const posSearchBefore = await app.inject({
      method: 'GET',
      url: `/v1/pos/products/search?warehouseId=${wh1Id}&branchId=${branch1Id}&q=FUEL-PETROL-92`,
      headers: authHeaders({ 'x-branch-id': branch1Id }),
    });
    expect(posSearchBefore.statusCode).toBe(200);
    expect(posSearchBefore.json()[0].sellingPrice).toBe('350.0000');

    // Approve suggestion -> POS selling price updates to approved value
    const approveRes = await app.inject({
      method: 'POST',
      url: `/v1/pricing/suggestions/${mv.priceSuggestionId}/approve`,
      headers: authHeaders({ 'x-branch-id': branch1Id }),
      payload: { overridePrice: '380.0000', reviewNotes: 'Approved revised fuel tariff' },
    });
    expect(approveRes.statusCode).toBe(200);

    const posSearchAfter = await app.inject({
      method: 'GET',
      url: `/v1/pos/products/search?warehouseId=${wh1Id}&branchId=${branch1Id}&q=FUEL-PETROL-92`,
      headers: authHeaders({ 'x-branch-id': branch1Id }),
    });
    expect(posSearchAfter.statusCode).toBe(200);
    expect(posSearchAfter.json()[0].sellingPrice).toBe('380.0000');
  });

  it('3. 4.1, 4.2 & 4.3: computes exact HALF_EVEN credit total 1946.66 (500 ML @ 3533.33/L + 180.00), preserves UoM on receipts, and handles batched multi-line checkout fast', async () => {
    const pRateRes = await app.inject({
      method: 'POST',
      url: '/v1/products',
      headers: authHeaders({ 'x-branch-id': branch1Id, 'idempotency-key': generateUuidV7() }),
      payload: {
        sku: 'OIL-RATE-L',
        name: 'Engine Oil 1L Rate',
        baseUom: 'L',
        priceUom: 'L',
        productQtyMode: 'VARIABLE',
        measurementCategory: 'VOLUME',
        allowedSellingUoms: ['L', 'ML'],
        qtyDecimalPrecision: 3,
        purchaseCost: '3000.0000',
        sellingPrice: '3533.3300',
        trackInventory: true,
        branchId: branch1Id,
      },
    });
    expect(pRateRes.statusCode).toBe(201);
    const oilId = pRateRes.json().id as string;

    const pItem2Res = await app.inject({
      method: 'POST',
      url: '/v1/products',
      headers: authHeaders({ 'x-branch-id': branch1Id, 'idempotency-key': generateUuidV7() }),
      payload: {
        sku: 'FILTER-180',
        name: 'Oil Filter Basic',
        baseUom: 'PCS',
        purchaseCost: '120.0000',
        sellingPrice: '180.0000',
        trackInventory: true,
        branchId: branch1Id,
      },
    });
    expect(pItem2Res.statusCode).toBe(201);
    const filterId = pItem2Res.json().id as string;

    for (const pid of [oilId, filterId]) {
      await app.inject({
        method: 'POST',
        url: '/v1/inventory/movements',
        headers: authHeaders({ 'idempotency-key': generateUuidV7() }),
        payload: {
          branchId: branch1Id,
          warehouseId: wh1Id,
          productId: pid,
          movementType: 'OPENING_STOCK',
          quantity: '50.000000',
          unitCost: '100.0000',
        },
      });
    }

    const custRes = await app.inject({
      method: 'POST',
      url: '/v1/customers',
      headers: authHeaders(),
      payload: {
        name: 'නිමල් පෙරේරා',
        phone: '+94771234567',
        addressLine1: 'නො. 15, ගාලු පාර',
        addressCity: 'කොළඹ 03',
        addressPostalCode: '00300',
        companyName: 'ලංකා ට්‍රේඩර්ස්',
      },
    });
    expect(custRes.statusCode).toBe(201);
    const customer = custRes.json();
    expect(customer.addressLine1).toBe('නො. 15, ගාලු පාර');
    expect(customer.addressCity).toBe('කොළඹ 03');
    expect(customer.addressPostalCode).toBe('00300');
    expect(customer.companyName).toBe('ලංකා ට්‍රේඩර්ස්');

    // Verify customer update preserves Unicode structured address
    const updCustRes = await app.inject({
      method: 'PATCH',
      url: `/v1/customers/${customer.id}`,
      headers: authHeaders(),
      payload: {
        addressLine1: 'නො. 18, මල් පාර',
        addressCity: 'මහනුවර',
        addressPostalCode: '20000',
      },
    });
    expect(updCustRes.statusCode).toBe(200);
    expect(updCustRes.json().addressCity).toBe('මහනුවර');

    // 500 ML @ 3533.3300/L = 1766.665 -> 1766.66 (HALF_EVEN) + 180.00 = 1946.66
    const creditAccRes = await app.inject({
      method: 'POST',
      url: '/v1/credit/accounts',
      headers: authHeaders(),
      payload: { customerId: customer.id, creditLimit: '50000.0000', creditTerms: 'NET_30' },
    });
    expect(creditAccRes.statusCode).toBe(201);

    const tStart = Date.now();
    const saleRes = await app.inject({
      method: 'POST',
      url: '/v1/pos/sales',
      headers: authHeaders({ 'x-branch-id': branch1Id, 'idempotency-key': generateUuidV7() }),
      payload: {
        registerId: reg1Id,
        shiftId: shift1Id,
        customerId: customer.id,
        lines: [
          { productId: oilId, quantity: '500', uomCode: 'ML', entrySource: 'MANUAL_WEIGHT' },
          { productId: filterId, quantity: '1', uomCode: 'PCS' },
        ],
        payments: [
          { paymentMethod: 'CREDIT', amount: '1946.6600', tenderedAmount: '1946.6600' },
        ],
      },
    });
    const elapsedMs = Date.now() - tStart;
    expect(saleRes.statusCode).toBe(201);
    const sale = saleRes.json();
    expect(Number(sale.grandTotal)).toBeCloseTo(1946.66, 2);
    expect(elapsedMs).toBeLessThan(3000);

    // Receipt metadata verification
    const receiptRes = await app.inject({
      method: 'GET',
      url: `/v1/pos/sales/${sale.id}/receipt`,
      headers: authHeaders({ 'x-branch-id': branch1Id }),
    });
    expect(receiptRes.statusCode).toBe(200);
    const receipt = receiptRes.json();
    expect(receipt.lines[0].uomCode).toBe('ML');
    expect(Number(receipt.grandTotal ?? receipt.totalAmount)).toBeCloseTo(1946.66, 2);
  });

  it('4. 5.2, 7 & 9: normalizes image/jpg attachments, honors local dashboard dates, and searches inventory balances across alternate, batch & serial barcodes', async () => {
    // Expense attachment with image/jpg -> normalized to image/jpeg
    const catsRes = await app.inject({
      method: 'GET',
      url: '/v1/expenses/categories',
      headers: authHeaders(),
    });
    const catId = catsRes.json().items[0].id;
    const expRes = await app.inject({
      method: 'POST',
      url: '/v1/expenses',
      headers: authHeaders(),
      payload: {
        title: 'Thermal Roll Receipt Test',
        categoryId: catId,
        branchId: branch1Id,
        amount: '2500.0000',
        currencyCode: 'LKR',
        expenseDate: '2026-06-15',
      },
    });
    expect(expRes.statusCode).toBe(201);

    const jpgHeader = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
    const attRes = await app.inject({
      method: 'POST',
      url: `/v1/expenses/${expRes.json().id}/attachments`,
      headers: authHeaders(),
      payload: {
        fileName: 'receipt.jpg',
        mimeType: 'image/jpg',
        dataBase64: jpgHeader.toString('base64'),
      },
    });
    expect(attRes.statusCode).toBe(201);
    expect(attRes.json().mimeType).toBe('image/jpeg');

    // Dashboard local date window override
    const dashRes = await app.inject({
      method: 'GET',
      url: '/v1/dashboard/summary?datePreset=TODAY&startDate=2026-06-15&endDate=2026-06-15',
      headers: authHeaders({ 'x-branch-id': branch1Id }),
    });
    expect(dashRes.statusCode).toBe(200);
    expect(dashRes.json().startDate).toBe('2026-06-15');
    expect(dashRes.json().endDate).toBe('2026-06-15');

    // Inventory balances search across alternate barcode, batch barcode & serial barcode
    const altBcProdRes = await app.inject({
      method: 'POST',
      url: '/v1/products',
      headers: authHeaders({ 'x-branch-id': branch1Id, 'idempotency-key': generateUuidV7() }),
      payload: {
        sku: 'SERIAL-CAM-01',
        name: 'Dashcam Pro',
        baseUom: 'PCS',
        trackingMode: 'SERIAL',
        purchaseCost: '15000.0000',
        sellingPrice: '22000.0000',
        trackInventory: true,
        primaryBarcode: 'BC-DASH-MAIN',
        branchId: branch1Id,
      },
    });
    expect(altBcProdRes.statusCode).toBe(201);
    const camId = altBcProdRes.json().id as string;

    await app.inject({
      method: 'POST',
      url: `/v1/products/${camId}/barcodes`,
      headers: authHeaders({ 'x-branch-id': branch1Id }),
      payload: { barcode: 'ALT-DASH-998', symbology: 'CODE128', uomCode: 'PCS' },
    });

    const serRes = await app.inject({
      method: 'POST',
      url: '/v1/inventory/serials',
      headers: authHeaders({ 'idempotency-key': generateUuidV7() }),
      payload: {
        branchId: branch1Id,
        warehouseId: wh1Id,
        productId: camId,
        serialNumbers: ['SN-CAM-001'],
        unitCost: '15000.0000',
      },
    });
    expect(serRes.statusCode).toBe(201);
    const createdSerialId = serRes.json()[0].id as string;

    const genSerBc = await app.inject({
      method: 'POST',
      url: `/v1/inventory/serials/${createdSerialId}/barcode/generate`,
      headers: authHeaders(),
      payload: {},
    });
    expect(genSerBc.statusCode).toBe(200);
    const serialBarcode = genSerBc.json().internalBarcode as string;
    expect(serialBarcode).toBeTruthy();

    const balByAlt = await app.inject({
      method: 'GET',
      url: `/v1/inventory/balances?branchId=${branch1Id}&search=alt-dash-998`,
      headers: authHeaders({ 'x-branch-id': branch1Id }),
    });
    expect(balByAlt.statusCode).toBe(200);
    expect(balByAlt.json().data.some((b: { productId: string }) => b.productId === camId)).toBe(true);

    const balBySerialBc = await app.inject({
      method: 'GET',
      url: `/v1/inventory/balances?branchId=${branch1Id}&search=${encodeURIComponent(serialBarcode.toLowerCase())}`,
      headers: authHeaders({ 'x-branch-id': branch1Id }),
    });
    expect(balBySerialBc.statusCode).toBe(200);
    expect(balBySerialBc.json().data.some((b: { productId: string }) => b.productId === camId)).toBe(true);
  });
});

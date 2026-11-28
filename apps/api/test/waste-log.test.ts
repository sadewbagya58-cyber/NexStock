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

describe('@nexstock/api — Waste Log & Inventory Loss Management (Phases 2–9 QA)', () => {
  let harness: TestPostgresHarness;
  let app: Awaited<ReturnType<typeof buildApp>>;

  const primaryKey = createTestEs256KeyMaterial('waste-log-qa-key-1');
  const jwksProvider = new StaticJwksProvider({
    keys: [primaryKey.publicJwk],
  });

  const TENANT_A = '0192e100-0000-7000-8000-000000000001';
  const TENANT_B = '0192e200-0000-7000-8000-000000000001';
  const OWNER_A = '0192e100-0000-7000-8000-000000000002';
  const CASHIER_A = '0192e100-0000-7000-8000-000000000003';
  const ACCOUNTANT_A = '0192e100-0000-7000-8000-000000000004';
  const BRANCH1_CLERK_A = '0192e100-0000-7000-8000-000000000005';
  const OWNER_B = '0192e200-0000-7000-8000-000000000002';

  let ownerAToken: string;
  let cashierAToken: string;
  let accountantAToken: string;
  let clerkB1Token: string;
  let ownerBToken: string;

  let branch1Id: string;
  let wh1Id: string;
  let reg1Id: string;
  let shift1Id: string;

  let branch2Id: string;
  let wh2Id: string;

  let catId: string;
  let fifoProdId: string;
  let macWeightProdId: string;
  let batchProdId: string;
  let serialProdId: string;
  let returnProdId: string;

  const issueToken = (userId: string, email: string) =>
    signEs256Jwt(primaryKey, {
      iss: DEFAULT_SUPABASE_JWT_ISSUER,
      aud: DEFAULT_SUPABASE_JWT_AUDIENCE,
      sub: userId,
      email,
      iat: Math.floor(Date.now() / 1000) - 60,
      nbf: Math.floor(Date.now() / 1000) - 60,
      exp: Math.floor(Date.now() / 1000) + 7200,
    });

  const headersA = (token = ownerAToken, extra?: Record<string, string>) => ({
    authorization: `Bearer ${token}`,
    'x-tenant-id': TENANT_A,
    ...extra,
  });

  beforeAll(async () => {
    harness = await createTestPostgresHarness();
    app = await buildApp({ db: harness.db, jwksProvider });
    ownerAToken = issueToken(OWNER_A, 'owner-a@waste-qa.test');
    cashierAToken = issueToken(CASHIER_A, 'cashier-a@waste-qa.test');
    accountantAToken = issueToken(ACCOUNTANT_A, 'accountant-a@waste-qa.test');
    clerkB1Token = issueToken(BRANCH1_CLERK_A, 'clerk-b1@waste-qa.test');
    ownerBToken = issueToken(OWNER_B, 'owner-b@waste-qa.test');

    // Onboard Tenant A
    const obA = await app.inject({
      method: 'POST',
      url: '/v1/org/tenants/onboard',
      headers: headersA(),
      payload: {
        slug: 'waste-qa-alpha',
        legalName: 'Waste QA Alpha Ltd',
        baseCurrency: 'LKR',
        defaultLocale: 'en-US',
        defaultTimezone: 'Asia/Colombo',
        countryCode: 'LK',
        ownerEmail: 'owner-a@waste-qa.test',
        ownerFullName: 'Alpha Owner',
        planCode: 'ENTERPRISE',
      },
    });
    expect(obA.statusCode).toBe(201);

    // Onboard Tenant B (for cross-tenant isolation test)
    const obB = await app.inject({
      method: 'POST',
      url: '/v1/org/tenants/onboard',
      headers: { authorization: `Bearer ${ownerBToken}`, 'x-tenant-id': TENANT_B },
      payload: {
        slug: 'waste-qa-beta',
        legalName: 'Waste QA Beta Ltd',
        baseCurrency: 'USD',
        ownerEmail: 'owner-b@waste-qa.test',
        ownerFullName: 'Beta Owner',
        planCode: 'ENTERPRISE',
      },
    });
    expect(obB.statusCode).toBe(201);

    // Create Branches 1 & 2 under Tenant A
    const b1 = await app.inject({
      method: 'POST',
      url: '/v1/org/branches',
      headers: headersA(),
      payload: { code: 'BR-W1', name: 'Main Waste Flagship' },
    });
    expect(b1.statusCode).toBe(201);
    branch1Id = b1.json().id;
    wh1Id = b1.json().defaultWarehouseId;

    const b2 = await app.inject({
      method: 'POST',
      url: '/v1/org/branches',
      headers: headersA(),
      payload: { code: 'BR-W2', name: 'Secondary Branch' },
    });
    expect(b2.statusCode).toBe(201);
    branch2Id = b2.json().id;
    wh2Id = b2.json().defaultWarehouseId;

    // Provision Cashier, Accountant, and Branch-1-Scoped Warehouse Clerk
    await withTenantTransaction(
      harness.db,
      { tenantId: TENANT_A, userId: OWNER_A, traceId: 'seed_roles' },
      async (trx) => {
        await provisionTenantMember(trx, {
          userId: CASHIER_A,
          email: 'cashier-a@waste-qa.test',
          fullName: 'Alpha Cashier',
          roleCodes: ['CASHIER'],
          allLocationsAccess: true,
          status: 'ACTIVE',
        });
        await provisionTenantMember(trx, {
          userId: ACCOUNTANT_A,
          email: 'accountant-a@waste-qa.test',
          fullName: 'Alpha Accountant',
          roleCodes: ['ACCOUNTANT'],
          allLocationsAccess: true,
          status: 'ACTIVE',
        });
        await provisionTenantMember(trx, {
          userId: BRANCH1_CLERK_A,
          email: 'clerk-b1@waste-qa.test',
          fullName: 'Branch 1 Clerk',
          roleCodes: ['WAREHOUSE_CLERK'],
          allLocationsAccess: false,
          branchIds: [branch1Id],
          warehouseIds: [wh1Id],
          status: 'ACTIVE',
        });
      },
    );

    // Ensure register & open shift on Branch 1
    const regRes = await app.inject({
      method: 'POST',
      url: '/v1/pos/registers/ensure-default',
      headers: headersA(),
      payload: { branchId: branch1Id },
    });
    reg1Id = regRes.json().id;

    const shiftRes = await app.inject({
      method: 'POST',
      url: '/v1/pos/shifts',
      headers: headersA(),
      payload: { registerId: reg1Id, openingCashFloat: '500.0000' },
    });
    shift1Id = shiftRes.json().id;

    // Create category & products on Branch 1
    const catRes = await app.inject({
      method: 'POST',
      url: '/v1/categories',
      headers: headersA(ownerAToken, { 'x-branch-id': branch1Id }),
      payload: { name: 'QA Waste Goods', branchId: branch1Id },
    });
    catId = catRes.json().id;

    // 1) FIFO product
    const pFifo = await app.inject({
      method: 'POST',
      url: '/v1/products',
      headers: headersA(ownerAToken, { 'x-branch-id': branch1Id, 'idempotency-key': generateUuidV7() }),
      payload: {
        sku: 'WST-FIFO-001',
        name: 'Artisan Olive Oil Bottle',
        categoryId: catId,
        baseUom: 'PCS',
        valuationMethod: 'FIFO',
        purchaseCost: '100.0000',
        sellingPrice: '200.0000',
        trackInventory: true,
        primaryBarcode: '600111000001',
        branchId: branch1Id,
      },
    });
    expect(pFifo.statusCode).toBe(201);
    fifoProdId = pFifo.json().id;

    // 2) MAC Variable-weight KG product
    const pMac = await app.inject({
      method: 'POST',
      url: '/v1/products',
      headers: headersA(ownerAToken, { 'x-branch-id': branch1Id, 'idempotency-key': generateUuidV7() }),
      payload: {
        sku: 'WST-MAC-KG',
        name: 'Organic Loose Beans',
        categoryId: catId,
        baseUom: 'KG',
        productQtyMode: 'VARIABLE',
        measurementCategory: 'WEIGHT',
        allowedSellingUoms: ['KG', 'G'],
        qtyDecimalPrecision: 3,
        valuationMethod: 'MOVING_AVG',
        purchaseCost: '800.0000',
        sellingPrice: '1200.0000',
        trackInventory: true,
        branchId: branch1Id,
      },
    });
    expect(pMac.statusCode).toBe(201);
    macWeightProdId = pMac.json().id;

    // 3) Batch & Expiry product
    const pBatch = await app.inject({
      method: 'POST',
      url: '/v1/products',
      headers: headersA(ownerAToken, { 'x-branch-id': branch1Id, 'idempotency-key': generateUuidV7() }),
      payload: {
        sku: 'WST-BATCH-001',
        name: 'Fresh Milk 1L',
        categoryId: catId,
        baseUom: 'PCS',
        trackingMode: 'BATCH_EXPIRY',
        valuationMethod: 'MOVING_AVG',
        purchaseCost: '250.0000',
        sellingPrice: '400.0000',
        trackInventory: true,
        branchId: branch1Id,
      },
    });
    expect(pBatch.statusCode).toBe(201);
    batchProdId = pBatch.json().id;

    // 4) Serial product
    const pSer = await app.inject({
      method: 'POST',
      url: '/v1/products',
      headers: headersA(ownerAToken, { 'x-branch-id': branch1Id, 'idempotency-key': generateUuidV7() }),
      payload: {
        sku: 'WST-SER-001',
        name: 'Barcode Scanner Hardware',
        categoryId: catId,
        baseUom: 'PCS',
        trackingMode: 'SERIAL',
        valuationMethod: 'MOVING_AVG',
        purchaseCost: '5000.0000',
        sellingPrice: '8500.0000',
        trackInventory: true,
        branchId: branch1Id,
      },
    });
    expect(pSer.statusCode).toBe(201);
    serialProdId = pSer.json().id;

    // 5) Customer Return test product
    const pRet = await app.inject({
      method: 'POST',
      url: '/v1/products',
      headers: headersA(ownerAToken, { 'x-branch-id': branch1Id, 'idempotency-key': generateUuidV7() }),
      payload: {
        sku: 'WST-RET-001',
        name: 'Ceramic Plate Set',
        categoryId: catId,
        baseUom: 'PCS',
        valuationMethod: 'MOVING_AVG',
        purchaseCost: '300.0000',
        sellingPrice: '550.0000',
        trackInventory: true,
        branchId: branch1Id,
      },
    });
    expect(pRet.statusCode).toBe(201);
    returnProdId = pRet.json().id;
  });

  afterAll(async () => {
    if (app) await app.close();
    if (harness?.db) await harness.db.destroy();
  });

  it('1. Default 9 waste reasons, OTHER mandatory description, and custom reason CRUD', async () => {
    const listRes = await app.inject({
      method: 'GET',
      url: '/v1/inventory/waste-reasons',
      headers: headersA(),
    });
    expect(listRes.statusCode).toBe(200);
    const reasons = listRes.json() as Array<{ code: string; name: string; requiresDescription: boolean }>;
    const codes = reasons.map((r) => r.code);
    for (const c of [
      'EXPIRED',
      'DAMAGED',
      'SPOILED',
      'LOST_MISSING',
      'CONTAMINATED',
      'PRODUCTION_WASTE',
      'INTERNAL_CONSUMPTION',
      'THEFT_SUSPECTED_LOSS',
      'OTHER',
    ]) {
      expect(codes).toContain(c);
    }
    expect(reasons.find((r) => r.code === 'OTHER')?.requiresDescription).toBe(true);

    // Seed 5 units of fifoProdId so we can validate OTHER description requirement
    await app.inject({
      method: 'POST',
      url: '/v1/inventory/movements',
      headers: headersA(ownerAToken, { 'idempotency-key': generateUuidV7() }),
      payload: {
        branchId: branch1Id,
        warehouseId: wh1Id,
        productId: fifoProdId,
        movementType: 'STOCK_IN',
        quantity: '4.000000',
        unitCost: '100.0000',
      },
    });
    await app.inject({
      method: 'POST',
      url: '/v1/inventory/movements',
      headers: headersA(ownerAToken, { 'idempotency-key': generateUuidV7() }),
      payload: {
        branchId: branch1Id,
        warehouseId: wh1Id,
        productId: fifoProdId,
        movementType: 'STOCK_IN',
        quantity: '6.000000',
        unitCost: '150.0000',
      },
    });

    // OTHER without description must be rejected
    const missingDescRes = await app.inject({
      method: 'POST',
      url: '/v1/inventory/waste-logs',
      headers: headersA(ownerAToken, { 'idempotency-key': generateUuidV7() }),
      payload: {
        branchId: branch1Id,
        warehouseId: wh1Id,
        reasonCode: 'OTHER',
        lines: [{ productId: fifoProdId, wasteQty: '1.000000' }],
      },
    });
    expect(missingDescRes.statusCode).toBe(422);
    expect(missingDescRes.json().errorCode).toBe('INV_WASTE_DESCRIPTION_REQUIRED');

    // Create custom reason & update it
    const createCustom = await app.inject({
      method: 'POST',
      url: '/v1/inventory/waste-reasons',
      headers: headersA(),
      payload: {
        code: 'TRANSIT_BREAKAGE',
        name: 'Transit Breakage',
        description: 'Broken inside internal delivery crate',
        requiresDescription: false,
      },
    });
    expect(createCustom.statusCode).toBe(201);
    const customId = createCustom.json().id;

    const patchCustom = await app.inject({
      method: 'PATCH',
      url: `/v1/inventory/waste-reasons/${customId}`,
      headers: headersA(),
      payload: { isActive: false },
    });
    expect(patchCustom.statusCode).toBe(200);
    expect(patchCustom.json().isActive).toBe(false);
  });

  it('2. Manual Draft -> Confirm lifecycle, Multi-layer FIFO cost snapshot, idempotency, shortage check, & cost-override block', async () => {
    // Attempt manual cost override -> TypeBox additionalProperties: false blocks arbitrary unitCost field!
    const overrideRes = await app.inject({
      method: 'POST',
      url: '/v1/inventory/waste-logs',
      headers: headersA(ownerAToken, { 'idempotency-key': generateUuidV7() }),
      payload: {
        branchId: branch1Id,
        warehouseId: wh1Id,
        reasonCode: 'DAMAGED',
        lines: [{ productId: fifoProdId, wasteQty: '1.000000', unitCost: '1.0000' }],
      },
    });
    expect(overrideRes.statusCode).toBe(400);

    // Cost preview across 2 FIFO layers: 4 @ 100.0000 + 2 @ 150.0000 = 700.0000 total!
    const previewRes = await app.inject({
      method: 'POST',
      url: '/v1/inventory/waste-logs/preview-cost',
      headers: headersA(),
      payload: {
        branchId: branch1Id,
        warehouseId: wh1Id,
        lines: [{ productId: fifoProdId, wasteQty: '6.000000' }],
      },
    });
    expect(previewRes.statusCode).toBe(200);
    expect(previewRes.json().totalEstimatedCost).toBe('700.0000');

    // Save as DRAFT (stock must remain 10.000000, ZERO ledger entry yet)
    const draftKey = generateUuidV7();
    const draftRes = await app.inject({
      method: 'POST',
      url: '/v1/inventory/waste-logs',
      headers: headersA(ownerAToken, { 'idempotency-key': draftKey }),
      payload: {
        branchId: branch1Id,
        warehouseId: wh1Id,
        reasonCode: 'DAMAGED',
        description: 'Shelf collapse damaged 6 bottles',
        confirmImmediately: false,
        lines: [{ productId: fifoProdId, wasteQty: '6.000000' }],
      },
    });
    expect(draftRes.statusCode).toBe(201);
    const draftLog = draftRes.json();
    expect(draftLog.status).toBe('DRAFT');
    expect(draftLog.lines[0].ledgerEntryId).toBeNull();

    // Check balance unchanged before confirmation
    const balBefore = await app.inject({
      method: 'GET',
      url: `/v1/inventory/balances?warehouseId=${wh1Id}&productId=${fifoProdId}`,
      headers: headersA(),
    });
    expect(balBefore.json().data[0].qtyOnHand).toBe('10.000000');

    // Confirm draft with idempotency replay protection
    const confirmKey = generateUuidV7();
    const confirmRes = await app.inject({
      method: 'POST',
      url: `/v1/inventory/waste-logs/${draftLog.id}/confirm`,
      headers: headersA(ownerAToken, { 'idempotency-key': confirmKey }),
    });
    expect(confirmRes.statusCode).toBe(200);
    const confirmed = confirmRes.json();
    expect(confirmed.status).toBe('CONFIRMED');
    expect(confirmed.totalCost).toBe('700.0000');
    expect(confirmed.lines[0].ledgerEntryId).toBeTruthy();

    // Replaying exact same confirm idempotency-key replays safely without second deduction
    const replayConfirm = await app.inject({
      method: 'POST',
      url: `/v1/inventory/waste-logs/${draftLog.id}/confirm`,
      headers: headersA(ownerAToken, { 'idempotency-key': confirmKey }),
    });
    expect(replayConfirm.statusCode).toBe(200);
    expect(replayConfirm.headers['x-idempotent-replayed']).toBe('true');

    // Verify ledger entry & balance reduced to 4.000000
    const balAfter = await app.inject({
      method: 'GET',
      url: `/v1/inventory/balances?warehouseId=${wh1Id}&productId=${fifoProdId}`,
      headers: headersA(),
    });
    expect(balAfter.json().data[0].qtyOnHand).toBe('4.000000');

    const movRes = await app.inject({
      method: 'GET',
      url: `/v1/inventory/movements/${confirmed.lines[0].ledgerEntryId}`,
      headers: headersA(),
    });
    expect(movRes.statusCode).toBe(200);
    expect(movRes.json().movementType).toBe('WASTE_OUT');
    expect(movRes.json().entrySource).toBe('WASTE');

    // Subsequent cost increase (new stock @ 300) does NOT mutate historical confirmed cost snapshot (700.0000)
    await app.inject({
      method: 'POST',
      url: '/v1/inventory/movements',
      headers: headersA(ownerAToken, { 'idempotency-key': generateUuidV7() }),
      payload: {
        branchId: branch1Id,
        warehouseId: wh1Id,
        productId: fifoProdId,
        movementType: 'STOCK_IN',
        quantity: '2.000000',
        unitCost: '300.0000',
      },
    });
    const fetchHistorical = await app.inject({
      method: 'GET',
      url: `/v1/inventory/waste-logs/${draftLog.id}`,
      headers: headersA(),
    });
    expect(fetchHistorical.json().totalCost).toBe('700.0000');

    // Shortage check (only 6 units left, attempting 20 -> rejected cleanly without mutating stock)
    const shortageRes = await app.inject({
      method: 'POST',
      url: '/v1/inventory/waste-logs',
      headers: headersA(ownerAToken, { 'idempotency-key': generateUuidV7() }),
      payload: {
        branchId: branch1Id,
        warehouseId: wh1Id,
        reasonCode: 'DAMAGED',
        confirmImmediately: true,
        lines: [{ productId: fifoProdId, wasteQty: '20.000000' }],
      },
    });
    expect(shortageRes.statusCode).toBe(409);
  });

  it('3. UoM conversion (500 G of KG MAC product), expired/quarantined batch write-off, and serialized item write-off', async () => {
    // Receive 2.000 KG @ 800.0000/KG
    await app.inject({
      method: 'POST',
      url: '/v1/inventory/movements',
      headers: headersA(ownerAToken, { 'idempotency-key': generateUuidV7() }),
      payload: {
        branchId: branch1Id,
        warehouseId: wh1Id,
        productId: macWeightProdId,
        movementType: 'STOCK_IN',
        quantity: '2.000000',
        uomCode: 'KG',
        unitCost: '800.0000',
      },
    });

    // Waste 500 G -> 0.500000 KG -> cost = 400.0000
    const uomWaste = await app.inject({
      method: 'POST',
      url: '/v1/inventory/waste-logs',
      headers: headersA(ownerAToken, { 'idempotency-key': generateUuidV7() }),
      payload: {
        branchId: branch1Id,
        warehouseId: wh1Id,
        reasonCode: 'SPOILED',
        confirmImmediately: true,
        lines: [{ productId: macWeightProdId, wasteQty: '500.000000', uomCode: 'G' }],
      },
    });
    expect(uomWaste.statusCode).toBe(201);
    const uomBody = uomWaste.json();
    expect(uomBody.lines[0].normalizedBaseQty).toBe('0.500000');
    expect(uomBody.lines[0].totalCostSnapshot).toBe('400.0000');

    const macBal = await app.inject({
      method: 'GET',
      url: `/v1/inventory/balances?warehouseId=${wh1Id}&productId=${macWeightProdId}`,
      headers: headersA(),
    });
    expect(macBal.json().data[0].qtyOnHand).toBe('1.500000');

    // Create batch & mark QUARANTINED, then write off 3 units via WASTE_OUT cleanly
    const batchRes = await app.inject({
      method: 'POST',
      url: '/v1/inventory/batches',
      headers: headersA(),
      payload: {
        branchId: branch1Id,
        warehouseId: wh1Id,
        productId: batchProdId,
        batchNumber: 'MILK-EXP-01',
        expiryDate: '2026-01-01',
        initialQuantity: '5.000000',
        unitCost: '250.0000',
      },
    });
    expect(batchRes.statusCode).toBe(201);
    const batchId = batchRes.json().id;

    const qRes = await app.inject({
      method: 'POST',
      url: `/v1/inventory/batches/${batchId}/quarantine`,
      headers: headersA(),
      payload: { reason: 'Past expiry inspection hold' },
    });
    expect(qRes.statusCode).toBe(200);

    const batchWaste = await app.inject({
      method: 'POST',
      url: '/v1/inventory/waste-logs',
      headers: headersA(ownerAToken, { 'idempotency-key': generateUuidV7() }),
      payload: {
        branchId: branch1Id,
        warehouseId: wh1Id,
        reasonCode: 'EXPIRED',
        confirmImmediately: true,
        lines: [{ productId: batchProdId, batchId, wasteQty: '3.000000' }],
      },
    });
    expect(batchWaste.statusCode).toBe(201);
    expect(batchWaste.json().totalCost).toBe('750.0000');

    const batchAfter = await app.inject({
      method: 'GET',
      url: `/v1/inventory/batches/${batchId}`,
      headers: headersA(),
    });
    expect(batchAfter.json().currentQuantity).toBe('2.000000');
    expect(['EXPIRED', 'QUARANTINED']).toContain(batchAfter.json().status);

    // Serialized item write-off -> WRITTEN_OFF status
    const serReg = await app.inject({
      method: 'POST',
      url: '/v1/inventory/serials',
      headers: headersA(ownerAToken, { 'idempotency-key': generateUuidV7() }),
      payload: {
        branchId: branch1Id,
        warehouseId: wh1Id,
        productId: serialProdId,
        serialNumbers: ['SN-WST-1001', 'SN-WST-1002'],
        unitCost: '5000.0000',
      },
    });
    expect(serReg.statusCode).toBe(201);
    const serId = serReg.json()[0].id;

    const serWaste = await app.inject({
      method: 'POST',
      url: '/v1/inventory/waste-logs',
      headers: headersA(ownerAToken, { 'idempotency-key': generateUuidV7() }),
      payload: {
        branchId: branch1Id,
        warehouseId: wh1Id,
        reasonCode: 'CONTAMINATED',
        confirmImmediately: true,
        lines: [{ productId: serialProdId, serialId: serId, wasteQty: '1.000000' }],
      },
    });
    expect(serWaste.statusCode).toBe(201);
    expect(serWaste.json().totalCost).toBe('5000.0000');

    const serGet = await app.inject({
      method: 'GET',
      url: `/v1/inventory/serials/${serId}`,
      headers: headersA(),
    });
    expect(serGet.json().status).toBe('WRITTEN_OFF');
  });

  it('4. Customer Return split (7 Restock + 3 Waste -> ZERO double deduction), Pending Hold inspection, post-restock WASTE_OUT, & voidSale block', async () => {
    // Seed 20 units @ 300.0000
    await app.inject({
      method: 'POST',
      url: '/v1/inventory/movements',
      headers: headersA(ownerAToken, { 'idempotency-key': generateUuidV7() }),
      payload: {
        branchId: branch1Id,
        warehouseId: wh1Id,
        productId: returnProdId,
        movementType: 'STOCK_IN',
        quantity: '20.000000',
        unitCost: '300.0000',
      },
    });

    // Sell 15 units @ 550.0000 -> remaining balance becomes 5
    const saleRes = await app.inject({
      method: 'POST',
      url: '/v1/pos/sales',
      headers: headersA(ownerAToken, { 'idempotency-key': generateUuidV7() }),
      payload: {
        registerId: reg1Id,
        shiftId: shift1Id,
        lines: [{ productId: returnProdId, quantity: '15.000000', uomCode: 'PCS' }],
        payments: [{ paymentMethod: 'CASH', amount: '8250.0000', tenderedAmount: '8250.0000' }],
      },
    });
    expect(saleRes.statusCode).toBe(201);
    const saleId = saleRes.json().id;
    const invoiceLineId = saleRes.json().lines[0].id;

    // Return 10 units as Split: 7 Restock + 3 Waste!
    const splitRet = await app.inject({
      method: 'POST',
      url: `/v1/pos/sales/${saleId}/returns`,
      headers: headersA(ownerAToken, { 'idempotency-key': generateUuidV7() }),
      payload: {
        reason: '7 boxes sealed, 3 crushed in transit',
        refundMethod: 'CASH',
        lines: [
          {
            invoiceLineId,
            returnQty: '10.000000',
            restockCondition: 'RESELLABLE',
            restockQty: '7.000000',
            wasteQty: '3.000000',
            wasteReasonCode: 'DAMAGED',
            wasteDescription: '3 ceramic sets cracked on arrival',
          },
        ],
      },
    });
    expect(splitRet.statusCode).toBe(201);
    const splitBody = splitRet.json();
    expect(splitBody.wasteLogIds.length).toBe(1);

    // Balance was 5 -> ONLY +7 restocked = 12.000000 (3 damaged were NEVER restocked, so NEVER double-deducted!)
    const balAfterSplit = await app.inject({
      method: 'GET',
      url: `/v1/inventory/balances?warehouseId=${wh1Id}&productId=${returnProdId}`,
      headers: headersA(),
    });
    expect(balAfterSplit.json().data[0].qtyOnHand).toBe('12.000000');

    // Check generated customer-return waste log details (deductedFromOnHand = false, cost = 3 * 300 = 900.0000)
    const custWasteGet = await app.inject({
      method: 'GET',
      url: `/v1/inventory/waste-logs/${splitBody.wasteLogIds[0]}`,
      headers: headersA(),
    });
    expect(custWasteGet.statusCode).toBe(200);
    expect(custWasteGet.json().sourceType).toBe('CUSTOMER_RETURN');
    expect(custWasteGet.json().status).toBe('CONFIRMED');
    expect(custWasteGet.json().totalCost).toBe('900.0000');
    expect(custWasteGet.json().lines[0].deductedFromOnHand).toBe(false);
    expect(custWasteGet.json().lines[0].ledgerEntryId).toBeNull();

    // Now test PENDING_INSPECTION hold -> late disposition & post-restock waste on remaining 5 returned units
    const holdRet = await app.inject({
      method: 'POST',
      url: `/v1/pos/sales/${saleId}/returns`,
      headers: headersA(ownerAToken, { 'idempotency-key': generateUuidV7() }),
      payload: {
        reason: 'Hold 5 sets for supervisor inspection',
        refundMethod: 'CASH',
        lines: [
          {
            invoiceLineId,
            returnQty: '5.000000',
            restockCondition: 'PENDING_INSPECTION',
            restockQty: '0.000000',
            wasteQty: '0.000000',
          },
        ],
      },
    });
    expect(holdRet.statusCode).toBe(201);
    const holdReturnId = holdRet.json().id;
    const holdReturnLineId = holdRet.json().lines[0].id;

    // Inspect pending: 3 Restock + 2 Waste
    const dispRes = await app.inject({
      method: 'POST',
      url: `/v1/pos/returns/${holdReturnId}/dispositions`,
      headers: headersA(ownerAToken, { 'idempotency-key': generateUuidV7() }),
      payload: {
        dispositions: [
          {
            posReturnLineId: holdReturnLineId,
            restockQty: '3.000000',
            wasteQty: '2.000000',
            wasteReasonCode: 'DAMAGED',
          },
        ],
      },
    });
    expect(dispRes.statusCode).toBe(200);

    // Balance should now be 12 + 3 = 15.000000
    const balAfterHoldDisp = await app.inject({
      method: 'GET',
      url: `/v1/inventory/balances?warehouseId=${wh1Id}&productId=${returnProdId}`,
      headers: headersA(),
    });
    expect(balAfterHoldDisp.json().data[0].qtyOnHand).toBe('15.000000');

    // Later discover 1 of those previously restocked 3 units was chipped -> convert restocked to waste (DOES post WASTE_OUT -1 -> 14!)
    const postRestockWaste = await app.inject({
      method: 'POST',
      url: `/v1/pos/returns/${holdReturnId}/dispositions`,
      headers: headersA(ownerAToken, { 'idempotency-key': generateUuidV7() }),
      payload: {
        dispositions: [
          {
            posReturnLineId: holdReturnLineId,
            wasteQty: '1.000000',
            wasteReasonCode: 'DAMAGED',
            wasteDescription: 'Chipped rim found after restock',
          },
        ],
      },
    });
    expect(postRestockWaste.statusCode).toBe(200);
    const balAfterPostRestock = await app.inject({
      method: 'GET',
      url: `/v1/inventory/balances?warehouseId=${wh1Id}&productId=${returnProdId}`,
      headers: headersA(),
    });
    expect(balAfterPostRestock.json().data[0].qtyOnHand).toBe('14.000000');

    // voidSale must be BLOCKED when invoice already has customer returns!
    const voidBlocked = await app.inject({
      method: 'POST',
      url: `/v1/pos/sales/${saleId}/void`,
      headers: headersA(ownerAToken, { 'idempotency-key': generateUuidV7() }),
      payload: { reason: 'Should fail because returns exist' },
    });
    expect(voidBlocked.statusCode).toBe(409);
    expect(voidBlocked.json().errorCode).toBe('POS_SALE_HAS_RETURNS');
  });

  it('5. Draft cancellation, confirmed reversal (CORRECTION_REVERSAL), RBAC, isolation, offline INV_CREATE_WASTE_DRAFT sync, P&L & CSV formula-escape export', async () => {
    // Cashier can create draft (201) but CANNOT confirm (403) or manage reasons (403)
    const cashierDraft = await app.inject({
      method: 'POST',
      url: '/v1/inventory/waste-logs',
      headers: headersA(cashierAToken, { 'idempotency-key': generateUuidV7() }),
      payload: {
        branchId: branch1Id,
        warehouseId: wh1Id,
        reasonCode: 'DAMAGED',
        description: '=CMD() cashier note for CSV formula test',
        confirmImmediately: false,
        lines: [{ productId: fifoProdId, wasteQty: '1.000000' }],
      },
    });
    expect(cashierDraft.statusCode).toBe(201);
    const draftId = cashierDraft.json().id;

    const cashierConfirmForbidden = await app.inject({
      method: 'POST',
      url: `/v1/inventory/waste-logs/${draftId}/confirm`,
      headers: headersA(cashierAToken, { 'idempotency-key': generateUuidV7() }),
    });
    expect(cashierConfirmForbidden.statusCode).toBe(403);

    const cashierReasonForbidden = await app.inject({
      method: 'POST',
      url: '/v1/inventory/waste-reasons',
      headers: headersA(cashierAToken),
      payload: { code: 'HACKED', name: 'Hacked Reason' },
    });
    expect(cashierReasonForbidden.statusCode).toBe(403);

    // Branch-scoped clerk cannot access Branch 2 waste dashboard
    const clerkB2Denied = await app.inject({
      method: 'GET',
      url: `/v1/inventory/waste-logs/dashboard?branchId=${branch2Id}&warehouseId=${wh2Id}`,
      headers: headersA(clerkB1Token),
    });
    expect(clerkB2Denied.statusCode).toBe(403);

    // Cross-tenant isolation: Tenant B cannot read Tenant A waste log
    const tenantBReadA = await app.inject({
      method: 'GET',
      url: `/v1/inventory/waste-logs/${draftId}`,
      headers: { authorization: `Bearer ${ownerBToken}`, 'x-tenant-id': TENANT_B },
    });
    expect([403, 404]).toContain(tenantBReadA.statusCode);

    // Owner confirms cashierDraft -> balance reduces by 1 -> then reverses it -> stock & cost totals restore!
    const confirmDraftRes = await app.inject({
      method: 'POST',
      url: `/v1/inventory/waste-logs/${draftId}/confirm`,
      headers: headersA(ownerAToken, { 'idempotency-key': generateUuidV7() }),
    });
    expect(confirmDraftRes.statusCode).toBe(200);
    const balMid = await app.inject({
      method: 'GET',
      url: `/v1/inventory/balances?warehouseId=${wh1Id}&productId=${fifoProdId}`,
      headers: headersA(),
    });
    expect(balMid.json().data[0].qtyOnHand).toBe('5.000000');

    // Cannot cancel an already CONFIRMED log
    const cancelConfirmed = await app.inject({
      method: 'POST',
      url: `/v1/inventory/waste-logs/${draftId}/cancel`,
      headers: headersA(),
    });
    expect(cancelConfirmed.statusCode).toBe(409);

    // Reverse CONFIRMED log -> stock restores to 6.000000, status becomes REVERSED
    const reverseRes = await app.inject({
      method: 'POST',
      url: `/v1/inventory/waste-logs/${draftId}/reverse`,
      headers: headersA(),
      payload: { reason: 'QA test reversal verification' },
    });
    expect(reverseRes.statusCode).toBe(200);
    expect(reverseRes.json().status).toBe('REVERSED');
    expect(reverseRes.json().lines[0].reversalLedgerEntryId).toBeTruthy();

    const balRestored = await app.inject({
      method: 'GET',
      url: `/v1/inventory/balances?warehouseId=${wh1Id}&productId=${fifoProdId}`,
      headers: headersA(),
    });
    expect(balRestored.json().data[0].qtyOnHand).toBe('6.000000');

    // Offline Sync: INV_CREATE_WASTE_DRAFT creates DRAFT cleanly without mutating stock, idempotent on replay
    const devId = generateUuidV7();
    await app.inject({
      method: 'POST',
      url: '/v1/sync/devices/enroll',
      headers: headersA(),
      payload: { deviceId: devId, branchId: branch1Id, clientPlatform: 'MOBILE_PWA', deviceName: 'QA Offline Device' },
    });
    const cmdId = generateUuidV7();
    const syncRes = await app.inject({
      method: 'POST',
      url: '/v1/sync/push',
      headers: headersA(),
      payload: {
        deviceId: devId,
        branchId: branch1Id,
        commands: [
          {
            localSeq: 1,
            commandId: cmdId,
            tenantId: TENANT_A,
            branchId: branch1Id,
            deviceId: devId,
            actorUserId: OWNER_A,
            commandType: 'INV_CREATE_WASTE_DRAFT',
            schemaVersion: 1,
            occurredAt: new Date().toISOString(),
            payload: {
              branchId: branch1Id,
              warehouseId: wh1Id,
              reasonCode: 'SPOILED',
              description: 'Synced offline spoilage draft',
              lines: [{ productId: fifoProdId, wasteQty: '1.000000' }],
            },
          },
        ],
      },
    });
    expect(syncRes.statusCode).toBe(200);
    expect(syncRes.json().receipts[0].status).toBe('APPLIED');
    const syncedWasteId = syncRes.json().receipts[0].serverReferenceId;
    const syncedGet = await app.inject({
      method: 'GET',
      url: `/v1/inventory/waste-logs/${syncedWasteId}`,
      headers: headersA(),
    });
    expect(syncedGet.json().status).toBe('DRAFT');

    // Balance untouched by offline DRAFT (still 6.000000)
    const balStillUnchanged = await app.inject({
      method: 'GET',
      url: `/v1/inventory/balances?warehouseId=${wh1Id}&productId=${fifoProdId}`,
      headers: headersA(),
    });
    expect(balStillUnchanged.json().data[0].qtyOnHand).toBe('6.000000');

    // Confirm dashboard totals & P&L integration (excludes reversed/draft logs!)
    // Confirmed logs: 700 (fifo) + 400 (mac) + 750 (batch) + 5000 (serial) + 900 (ret1) + 600 (ret2 2*300) + 300 (ret2 post-restock 1*300) = 8650.0000!
    const dashRes = await app.inject({
      method: 'GET',
      url: `/v1/inventory/waste-logs/dashboard?branchId=${branch1Id}`,
      headers: headersA(),
    });
    expect(dashRes.statusCode).toBe(200);
    expect(dashRes.json().kpis.totalWasteCost).toBe('8650.0000');

    // Accountant can view PROFITABILITY business report & confirmedWasteCost matches 8650.0000, and export CSV safely
    const today = new Date().toISOString().slice(0, 10);
    const bizRep = await app.inject({
      method: 'GET',
      url: `/v1/reports/business?category=PROFITABILITY&branchId=${branch1Id}&startDate=${today}&endDate=${today}`,
      headers: headersA(accountantAToken),
    });
    expect(bizRep.statusCode).toBe(200);
    expect(bizRep.json().profitability.summary.confirmedWasteCost).toBe('8650.0000');

    const expRes = await app.inject({
      method: 'GET',
      url: `/v1/inventory/waste-logs/export?branchId=${branch1Id}`,
      headers: headersA(accountantAToken),
    });
    expect(expRes.statusCode).toBe(200);
    expect(expRes.headers['content-type']).toContain('text/csv');
    expect(expRes.body).toContain('8650.0000');
  });
});

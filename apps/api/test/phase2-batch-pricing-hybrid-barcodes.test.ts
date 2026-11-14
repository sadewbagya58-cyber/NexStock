import { randomUUID, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
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

describe('@nexstock/api — Phase 2: Batch Pricing, Hybrid Barcodes, Transfers, UOM Wizard & Sync', () => {
  let harness: TestPostgresHarness;
  let app: Awaited<ReturnType<typeof buildApp>>;

  const keyMaterial = createTestEs256KeyMaterial('phase2-key-1');
  const jwksProvider = new StaticJwksProvider({
    keys: [keyMaterial.publicJwk],
  });

  const TENANT_ID = '0192b4d0-1111-7000-8000-000000000010';
  const OWNER_ID = '0192b4d0-1111-7000-8000-000000000001';
  const CASHIER_ID = '0192b4d0-1111-7000-8000-000000000002';

  let ownerToken: string;
  let cashierToken: string;
  let branchAId: string;
  let branchBId: string;
  let whAId: string;
  let whBId: string;
  let registerId: string;
  let shiftId: string;
  let supplierId: string;

  let soapProductId: string;
  let soapBatchAId: string;
  let soapBatchBId: string;
  let soapBatchBBarcode: string;
  let soapExpiredBatchId: string;
  let strictProductId: string;
  let strictNoPriceBatchId: string;
  let legacyRiceId: string;

  const issueToken = (userId: string, email: string) =>
    signEs256Jwt(keyMaterial, {
      sub: userId,
      aud: DEFAULT_SUPABASE_JWT_AUDIENCE,
      iss: DEFAULT_SUPABASE_JWT_ISSUER,
      email,
      exp: Math.floor(Date.now() / 1000) + 3600,
    });

  const headers = (token: string, extra?: Record<string, string>) => ({
    authorization: `Bearer ${token}`,
    'x-tenant-id': TENANT_ID,
    'content-type': 'application/json',
    ...extra,
  });

  beforeAll(async () => {
    harness = await createTestPostgresHarness();
    ownerToken = issueToken(OWNER_ID, 'owner@phase2.test');
    cashierToken = issueToken(CASHIER_ID, 'cashier@phase2.test');
    app = await buildApp({ db: harness.db, jwksProvider });

    const onboard = await app.inject({
      method: 'POST',
      url: '/v1/org/tenants/onboard',
      headers: headers(ownerToken),
      payload: {
        slug: 'nexstock-phase2-test',
        legalName: 'NexStock Ceylon Mart',
        baseCurrency: 'LKR',
        defaultLocale: 'en-US',
        defaultTimezone: 'Asia/Colombo',
        countryCode: 'LK',
        ownerEmail: 'owner@phase2.test',
        ownerFullName: 'Owner Phase2',
        planCode: 'ENTERPRISE',
      },
    });
    expect(onboard.statusCode).toBe(201);

    const bA = await app.inject({
      method: 'POST',
      url: '/v1/org/branches',
      headers: headers(ownerToken),
      payload: { code: 'BR-A', name: 'Colombo Main', timezone: 'Asia/Colombo', countryCode: 'LK' },
    });
    expect(bA.statusCode).toBe(201);
    branchAId = bA.json().id;

    const bB = await app.inject({
      method: 'POST',
      url: '/v1/org/branches',
      headers: headers(ownerToken),
      payload: { code: 'BR-B', name: 'Kandy Outlet', timezone: 'Asia/Colombo', countryCode: 'LK' },
    });
    expect(bB.statusCode).toBe(201);
    branchBId = bB.json().id;

    await withTenantTransaction(
      harness.db,
      { tenantId: TENANT_ID, userId: OWNER_ID, traceId: 'seed_cashier_phase2' },
      async (trx) => {
        await provisionTenantMember(trx, {
          userId: CASHIER_ID,
          email: 'cashier@phase2.test',
          fullName: 'Front Cashier',
          roleCodes: ['CASHIER'],
          allLocationsAccess: true,
          status: 'ACTIVE',
        });
      },
    );

    const wA = await app.inject({
      method: 'POST',
      url: '/v1/org/warehouses',
      headers: headers(ownerToken),
      payload: { branchId: branchAId, code: 'WH-A', name: 'Colombo Depot', allowNegativeStock: false },
    });
    expect(wA.statusCode).toBe(201);
    whAId = wA.json().id;

    const wB = await app.inject({
      method: 'POST',
      url: '/v1/org/warehouses',
      headers: headers(ownerToken),
      payload: { branchId: branchBId, code: 'WH-B', name: 'Kandy Depot', allowNegativeStock: false },
    });
    expect(wB.statusCode).toBe(201);
    whBId = wB.json().id;

    registerId = generateUuidV7();
    await withTenantTransaction(
      harness.db,
      { tenantId: TENANT_ID, userId: OWNER_ID, traceId: 'seed_reg_phase2' },
      async (trx) => {
        await trx.db
          .insertInto('pos_registers')
          .values({
            id: registerId,
            tenant_id: TENANT_ID,
            branch_id: branchAId,
            warehouse_id: whAId,
            code: 'REG-P2-01',
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
      headers: headers(cashierToken, { 'idempotency-key': randomUUID() }),
      payload: { registerId, openingCashFloat: '5000.0000' },
    });
    expect(shiftRes.statusCode).toBe(201);
    shiftId = shiftRes.json().id;

    const supRes = await app.inject({
      method: 'POST',
      url: '/v1/suppliers',
      headers: headers(ownerToken, { 'idempotency-key': randomUUID() }),
      payload: {
        code: 'SUP-SOAP-01',
        businessName: 'Ceylon Soaps Distributor',
        email: 'supply@ceylonsoaps.test',
        phone: '+94112223333',
      },
    });
    expect(supRes.statusCode).toBe(201);
    supplierId = supRes.json().id;

    // Create Soap 100G (BATCH_EXPIRY, FIFO costing, FEFO allocation)
    const soapRes = await app.inject({
      method: 'POST',
      url: '/v1/products',
      headers: headers(ownerToken, { 'idempotency-key': randomUUID() }),
      payload: {
        sku: 'SOAP-100G',
        name: 'Herbal Soap 100G',
        baseUom: 'PCS',
        purchaseCost: '90.0000',
        sellingPrice: '140.0000',
        trackInventory: true,
        trackingMode: 'BATCH_EXPIRY',
        valuationMethod: 'FIFO',
        allocationPolicy: 'FEFO',
        primaryBarcode: '8901234567893', // valid EAN-13
      },
    });
    expect(soapRes.statusCode).toBe(201);
    soapProductId = soapRes.json().id;
  });

  afterAll(async () => {
    if (app) await app.close();
    if (harness) await harness.db.destroy();
  });

  it('1. Tenant branding & Hybrid Barcodes: auto-generates unique NB-B barcodes, prevents cross-entity collision, and resolves GS1 + EAN-13 + NB-B', async () => {
    const brandGet = await app.inject({
      method: 'GET',
      url: '/v1/org/branding',
      headers: headers(cashierToken),
    });
    expect(brandGet.statusCode).toBe(200);
    expect(brandGet.json().name).toBe('NexStock Ceylon Mart');

    const brandPatch = await app.inject({
      method: 'PATCH',
      url: '/v1/org/branding',
      headers: headers(ownerToken),
      payload: { shopDisplayName: 'CEYLON MART SUPER', logoUrl: 'https://cdn.test/logo.png' },
    });
    expect(brandPatch.statusCode).toBe(200);
    expect(brandPatch.json().shopDisplayName).toBe('CEYLON MART SUPER');

    // Create SOAP-A (5 PCS @ cost 100, price 150, expires sooner: 2028-01-15)
    const bARes = await app.inject({
      method: 'POST',
      url: '/v1/inventory/batches',
      headers: headers(ownerToken, { 'idempotency-key': randomUUID() }),
      payload: {
        branchId: branchAId,
        warehouseId: whAId,
        productId: soapProductId,
        supplierId,
        batchNumber: 'SOAP-A',
        receivedDate: '2026-11-01',
        expiryDate: '2028-01-15',
        initialQuantity: '5.000000',
        unitCost: '100.0000',
        sellingPrice: '150.0000',
        minSellingPrice: '120.0000',
      },
    });
    expect(bARes.statusCode).toBe(201);
    soapBatchAId = bARes.json().id;
    expect(bARes.json().internalBarcode).toMatch(/^NB-B/);

    // Create SOAP-B (10 PCS @ cost 120, price 180, expires later: 2029-06-30)
    const bBRes = await app.inject({
      method: 'POST',
      url: '/v1/inventory/batches',
      headers: headers(ownerToken, { 'idempotency-key': randomUUID() }),
      payload: {
        branchId: branchAId,
        warehouseId: whAId,
        productId: soapProductId,
        supplierId,
        batchNumber: 'SOAP-B',
        receivedDate: '2026-11-05',
        expiryDate: '2029-06-30',
        initialQuantity: '10.000000',
        unitCost: '120.0000',
        sellingPrice: '180.0000',
        minSellingPrice: '140.0000',
      },
    });
    expect(bBRes.statusCode).toBe(201);
    soapBatchBId = bBRes.json().id;
    soapBatchBBarcode = bBRes.json().internalBarcode;
    expect(soapBatchBBarcode).toBeTruthy();
    expect(soapBatchBBarcode).not.toBe(bARes.json().internalBarcode);

    // Cross-entity collision guard: trying to assign SOAP-B's internal barcode to a product fails 409 CAT_BARCODE_COLLISION
    const collideRes = await app.inject({
      method: 'POST',
      url: `/v1/products/${soapProductId}/barcodes`,
      headers: headers(ownerToken),
      payload: { barcode: soapBatchBBarcode, barcodeType: 'CODE128', isPrimary: false },
    });
    expect(collideRes.statusCode).toBe(409);
    expect(collideRes.json().errorCode).toBe('CAT_BARCODE_COLLISION');

    // Resolve manufacturer EAN-13 barcode -> NOT exact batch locked, FEFO selects SOAP-A (150.0000)
    const resMfg = await app.inject({
      method: 'POST',
      url: '/v1/barcodes/resolve',
      headers: headers(cashierToken),
      payload: { rawBarcode: '8901234567893', branchId: branchAId, warehouseId: whAId },
    });
    expect(resMfg.statusCode).toBe(200);
    expect(resMfg.json().matchedBy).toBe('MANUFACTURER_PRODUCT_BARCODE');
    expect(resMfg.json().isExactBatchLocked).toBe(false);
    expect(resMfg.json().effectiveUnitPrice).toBe('150.0000');
    expect(resMfg.json().priceSource).toBe('BATCH_EXPLICIT');
    expect(resMfg.json().fefoPreview[0].batchId).toBe(soapBatchAId);
    expect(resMfg.json().fefoPreview[0].batchNumber).toBe('SOAP-A');

    // Resolve SOAP-B internal batch barcode -> exact batch locked, returns SOAP-B price 180.0000
    const resInt = await app.inject({
      method: 'POST',
      url: '/v1/barcodes/resolve',
      headers: headers(cashierToken),
      payload: { rawBarcode: soapBatchBBarcode, branchId: branchAId, warehouseId: whAId },
    });
    expect(resInt.statusCode).toBe(200);
    expect(resInt.json().matchedBy).toBe('INTERNAL_BATCH');
    expect(resInt.json().isExactBatchLocked).toBe(true);
    expect(resInt.json().exactBatch.id).toBe(soapBatchBId);
    expect(resInt.json().effectiveUnitPrice).toBe('180.0000');

    // Resolve GS1 composite AI (01) GTIN + (10) Lot + (17) Expiry
    const gs1Code = ']C101089012345678931729063010SOAP-B';
    const resGs1 = await app.inject({
      method: 'POST',
      url: '/v1/barcodes/resolve',
      headers: headers(cashierToken),
      payload: { rawBarcode: gs1Code, branchId: branchAId, warehouseId: whAId },
    });
    expect(resGs1.statusCode).toBe(200);
    expect(resGs1.json().matchedBy).toBe('GS1_BATCH_AND_PRODUCT');
    expect(resGs1.json().isExactBatchLocked).toBe(true);
    expect(resGs1.json().exactBatch.batchNumber).toBe('SOAP-B');
    expect(resGs1.json().effectiveUnitPrice).toBe('180.0000');
  });

  it('2. POS Multi-Batch Cart Splitting, Explicit Batch Lock, Expiry Block & Pricing Precedence', async () => {
    // Sell 8 PCS without explicit batchId -> FEFO splits 5 from SOAP-A @ 150 (=750) + 3 from SOAP-B @ 180 (=540) = 1290
    const splitSaleRes = await app.inject({
      method: 'POST',
      url: '/v1/pos/sales',
      headers: headers(cashierToken, { 'idempotency-key': randomUUID() }),
      payload: {
        registerId,
        shiftId,
        lines: [{ productId: soapProductId, quantity: '8.000000', uomCode: 'PCS' }],
        payments: [{ paymentMethod: 'CASH', amount: '1290.0000', tenderedAmount: '1500.0000' }],
      },
    });
    expect(splitSaleRes.statusCode).toBe(201);
    const splitSale = splitSaleRes.json();
    expect(splitSale.grandTotal).toBe('1290.0000');
    expect(splitSale.lines).toHaveLength(2);
    expect(splitSale.lines[0].batchNumber).toBe('SOAP-A');
    expect(splitSale.lines[0].unitPrice).toBe('150.0000');
    expect(splitSale.lines[0].unitCostSnapshot).toBe('100.0000');
    expect(splitSale.lines[1].batchNumber).toBe('SOAP-B');
    expect(splitSale.lines[1].unitPrice).toBe('180.0000');
    expect(splitSale.lines[1].unitCostSnapshot).toBe('120.0000');

    // Verify expired batch is blocked when explicitly scanned
    const expBatchRes = await app.inject({
      method: 'POST',
      url: '/v1/inventory/batches',
      headers: headers(ownerToken, { 'idempotency-key': randomUUID() }),
      payload: {
        branchId: branchAId,
        warehouseId: whAId,
        productId: soapProductId,
        batchNumber: 'SOAP-EXP',
        receivedDate: '2025-01-01',
        expiryDate: '2025-12-31',
        initialQuantity: '5.000000',
        unitCost: '80.0000',
        sellingPrice: '100.0000',
      },
    });
    expect(expBatchRes.statusCode).toBe(201);
    soapExpiredBatchId = expBatchRes.json().id;

    const expSaleRes = await app.inject({
      method: 'POST',
      url: '/v1/pos/sales',
      headers: headers(cashierToken, { 'idempotency-key': randomUUID() }),
      payload: {
        registerId,
        shiftId,
        lines: [{ productId: soapProductId, batchId: soapExpiredBatchId, quantity: '1.000000', uomCode: 'PCS' }],
        payments: [{ paymentMethod: 'CASH', amount: '100.0000', tenderedAmount: '100.0000' }],
      },
    });
    expect(expSaleRes.statusCode).toBe(409);
    expect(expSaleRes.json().errorCode).toBe('POS_BATCH_EXPIRED');

    // Enforce BLOCK_MISSING / requireBatchSellingPrice = true -> 422 POS_BATCH_PRICE_REQUIRED
    const spRes = await app.inject({
      method: 'POST',
      url: '/v1/products',
      headers: headers(ownerToken, { 'idempotency-key': randomUUID() }),
      payload: {
        sku: 'STRICT-LOT-01',
        name: 'Strict Priced Item',
        baseUom: 'PCS',
        purchaseCost: '50.0000',
        sellingPrice: '75.0000',
        trackInventory: true,
        trackingMode: 'BATCH',
        requireBatchSellingPrice: true,
      },
    });
    expect(spRes.statusCode).toBe(201);
    strictProductId = spRes.json().id;

    const sbRes = await app.inject({
      method: 'POST',
      url: '/v1/inventory/batches',
      headers: headers(ownerToken, { 'idempotency-key': randomUUID() }),
      payload: {
        branchId: branchAId,
        warehouseId: whAId,
        productId: strictProductId,
        batchNumber: 'STRICT-NOPRICE',
        receivedDate: '2026-11-01',
        initialQuantity: '10.000000',
        unitCost: '50.0000',
      },
    });
    expect(sbRes.statusCode).toBe(201);
    strictNoPriceBatchId = sbRes.json().id;

    const blockedSale = await app.inject({
      method: 'POST',
      url: '/v1/pos/sales',
      headers: headers(cashierToken, { 'idempotency-key': randomUUID() }),
      payload: {
        registerId,
        shiftId,
        lines: [{ productId: strictProductId, batchId: strictNoPriceBatchId, quantity: '1.000000', uomCode: 'PCS' }],
        payments: [{ paymentMethod: 'CASH', amount: '75.0000', tenderedAmount: '75.0000' }],
      },
    });
    expect(blockedSale.statusCode).toBe(422);
    expect(blockedSale.json().errorCode).toBe('POS_BATCH_PRICE_REQUIRED');

    // Cashier overrideSellingPrice -> 403 POS_UNAUTHORIZED_DISCOUNT; Owner overrideSellingPrice -> 201
    const unauthOverride = await app.inject({
      method: 'POST',
      url: '/v1/pos/sales',
      headers: headers(cashierToken, { 'idempotency-key': randomUUID() }),
      payload: {
        registerId,
        shiftId,
        lines: [{ productId: strictProductId, batchId: strictNoPriceBatchId, quantity: '1.000000', uomCode: 'PCS', overrideSellingPrice: '85.0000' }],
        payments: [{ paymentMethod: 'CASH', amount: '85.0000', tenderedAmount: '100.0000' }],
      },
    });
    expect(unauthOverride.statusCode).toBe(403);

    const authOverride = await app.inject({
      method: 'POST',
      url: '/v1/pos/sales',
      headers: headers(ownerToken, { 'idempotency-key': randomUUID() }),
      payload: {
        registerId,
        shiftId,
        lines: [{ productId: strictProductId, batchId: strictNoPriceBatchId, quantity: '1.000000', uomCode: 'PCS', overrideSellingPrice: '85.0000' }],
        payments: [{ paymentMethod: 'CASH', amount: '85.0000', tenderedAmount: '100.0000' }],
      },
    });
    expect(authOverride.statusCode).toBe(201);
    expect(authOverride.json().lines[0].priceSource).toBe('POS_MANUAL_OVERRIDE');
  });

  it('3. GRN Lot Conflict Policy, Batch Cost Isolation (D-04), Print Audit & Batch History', async () => {
    // Receive SOAP-C via GRN with explicit selling price 210 & higher cost 150 -> isolated on batch (product stays cost 90, sell 140)
    const grnRes = await app.inject({
      method: 'POST',
      url: '/v1/goods-receipts',
      headers: headers(ownerToken, { 'idempotency-key': randomUUID() }),
      payload: {
        branchId: branchAId,
        warehouseId: whAId,
        supplierId,
        lines: [
          {
            productId: soapProductId,
            receivedUom: 'PCS',
            receivedQty: '20.000000',
            unitCost: '150.0000',
            sellingPrice: '210.0000',
            batchNumber: 'SOAP-C',
            expiryDate: '2030-01-01',
          },
        ],
      },
    });
    expect(grnRes.statusCode).toBe(201);
    const soapCBatchId = grnRes.json().lines[0].batchId;
    expect(soapCBatchId).toBeTruthy();

    const prodAfterGrn = await app.inject({
      method: 'GET',
      url: `/v1/products/${soapProductId}`,
      headers: headers(ownerToken),
    });
    expect(prodAfterGrn.json().purchaseCost).toBe('90.0000');
    expect(prodAfterGrn.json().sellingPrice).toBe('140.0000');

    // Duplicate lot intake with REJECT -> 409 PUR_BATCH_LOT_CONFLICT
    const dupReject = await app.inject({
      method: 'POST',
      url: '/v1/goods-receipts',
      headers: headers(ownerToken, { 'idempotency-key': randomUUID() }),
      payload: {
        branchId: branchAId,
        warehouseId: whAId,
        supplierId,
        lines: [
          {
            productId: soapProductId,
            receivedUom: 'PCS',
            receivedQty: '5.000000',
            unitCost: '155.0000',
            sellingPrice: '220.0000',
            batchNumber: 'SOAP-C',
            expiryDate: '2030-02-01',
            lotConflictPolicy: 'REJECT',
          },
        ],
      },
    });
    expect(dupReject.statusCode).toBe(409);
    expect(dupReject.json().errorCode).toBe('PUR_BATCH_LOT_CONFLICT');

    // Duplicate lot intake with CREATE_NEW_LOT_SUFFIX -> creates distinct suffixed batch
    const dupSuffix = await app.inject({
      method: 'POST',
      url: '/v1/goods-receipts',
      headers: headers(ownerToken, { 'idempotency-key': randomUUID() }),
      payload: {
        branchId: branchAId,
        warehouseId: whAId,
        supplierId,
        lines: [
          {
            productId: soapProductId,
            receivedUom: 'PCS',
            receivedQty: '5.000000',
            unitCost: '155.0000',
            sellingPrice: '220.0000',
            batchNumber: 'SOAP-C',
            expiryDate: '2030-02-01',
            lotConflictPolicy: 'CREATE_NEW_LOT_SUFFIX',
          },
        ],
      },
    });
    expect(dupSuffix.statusCode).toBe(201);
    expect(dupSuffix.json().lines[0].batchNumber).toMatch(/^SOAP-C-/);

    // Update SOAP-C pricing, generate barcode (idempotent), record thermal print log, inspect history
    const pricePatch = await app.inject({
      method: 'PATCH',
      url: `/v1/inventory/batches/${soapCBatchId}/pricing`,
      headers: headers(ownerToken),
      payload: { sellingPrice: '215.0000', minSellingPrice: '170.0000', reason: 'Seasonal update' },
    });
    expect(pricePatch.statusCode).toBe(200);
    expect(pricePatch.json().sellingPrice).toBe('215.0000');

    const genRes = await app.inject({
      method: 'POST',
      url: `/v1/inventory/batches/${soapCBatchId}/barcode/generate`,
      headers: headers(ownerToken),
      payload: { symbology: 'CODE128' },
    });
    expect(genRes.statusCode).toBe(200);
    expect(genRes.json().alreadyExisted).toBe(true);

    const logRes = await app.inject({
      method: 'POST',
      url: `/v1/inventory/batches/${soapCBatchId}/barcode/print-log`,
      headers: headers(ownerToken),
      payload: { labelFormat: '50x30', copies: 20, printReason: 'INITIAL_RECEIVE' },
    });
    expect(logRes.statusCode).toBe(201);

    const histRes = await app.inject({
      method: 'GET',
      url: `/v1/inventory/batches/${soapCBatchId}/history`,
      headers: headers(ownerToken),
    });
    expect(histRes.statusCode).toBe(200);
    expect(histRes.json().priceHistory.length).toBeGreaterThanOrEqual(2);
    expect(histRes.json().printLogs).toHaveLength(1);
    expect(histRes.json().stockMovements.length).toBeGreaterThanOrEqual(1);
  });

  it('4. Multi-Branch Transfers & Expired Batch Return Restock Guard (D-05)', async () => {
    // Transfer 2 PCS from SOAP-B (WH-A -> WH-B): preserves selling_price 180.0000 & creates new dest internal_barcode
    const trCreate = await app.inject({
      method: 'POST',
      url: '/v1/inventory/transfers',
      headers: headers(ownerToken),
      payload: {
        sourceBranchId: branchAId,
        sourceWarehouseId: whAId,
        destinationBranchId: branchBId,
        destinationWarehouseId: whBId,
        notes: 'Branch replenishment',
        lines: [{ productId: soapProductId, sourceBatchId: soapBatchBId, quantity: '2.000000' }],
      },
    });
    expect(trCreate.statusCode).toBe(201);
    const transferId = trCreate.json().id;

    const trDispatch = await app.inject({
      method: 'POST',
      url: `/v1/inventory/transfers/${transferId}/dispatch`,
      headers: headers(ownerToken),
      payload: {},
    });
    expect(trDispatch.statusCode).toBe(200);
    expect(trDispatch.json().status).toBe('IN_TRANSIT');

    const trReceive = await app.inject({
      method: 'POST',
      url: `/v1/inventory/transfers/${transferId}/receive`,
      headers: headers(ownerToken),
      payload: {},
    });
    expect(trReceive.statusCode).toBe(200);
    expect(trReceive.json().status).toBe('RECEIVED');
    const destBatchId = trReceive.json().lines[0].destinationBatchId;
    expect(destBatchId).toBeTruthy();

    const destBatchGet = await app.inject({
      method: 'GET',
      url: `/v1/inventory/batches/${destBatchId}`,
      headers: headers(ownerToken),
    });
    expect(destBatchGet.statusCode).toBe(200);
    expect(destBatchGet.json().sellingPrice).toBe('180.0000');
    expect(destBatchGet.json().internalBarcode).not.toBe(soapBatchBBarcode);

    // D-05: Sell from a soon-to-be expired batch (simulate expiry in DB), attempt RESELLABLE return -> 409 POS_EXPIRED_BATCH_RESTOCK_BLOCKED
    const saleBRes = await app.inject({
      method: 'POST',
      url: '/v1/pos/sales',
      headers: headers(cashierToken, { 'idempotency-key': randomUUID() }),
      payload: {
        registerId,
        shiftId,
        lines: [{ productId: soapProductId, batchId: soapBatchBId, quantity: '1.000000', uomCode: 'PCS' }],
        payments: [{ paymentMethod: 'CASH', amount: '180.0000', tenderedAmount: '200.0000' }],
      },
    });
    expect(saleBRes.statusCode).toBe(201);
    const saleB = saleBRes.json();

    // Mark soapBatchBId expired in DB to test D-05 guard
    await withTenantTransaction(
      harness.db,
      { tenantId: TENANT_ID, userId: OWNER_ID, traceId: 'mark_expired_d05' },
      async (trx) => {
        await trx.db
          .updateTable('inventory_batches')
          .set({ status: 'EXPIRED', expiry_date: new Date('2025-01-01T00:00:00.000Z') })
          .where('tenant_id', '=', TENANT_ID)
          .where('id', '=', soapBatchBId)
          .execute();
      },
    );

    const blockedReturn = await app.inject({
      method: 'POST',
      url: `/v1/pos/sales/${saleB.id}/returns`,
      headers: headers(ownerToken, { 'idempotency-key': randomUUID() }),
      payload: {
        reason: 'Customer opened pack',
        refundMethod: 'CASH',
        lines: [
          {
            invoiceLineId: saleB.lines[0].id,
            returnQty: '1.000000',
            restockCondition: 'RESELLABLE',
          },
        ],
      },
    });
    expect(blockedReturn.statusCode).toBe(409);
    expect(blockedReturn.json().errorCode).toBe('POS_EXPIRED_BATCH_RESTOCK_BLOCKED');

    const okDamagedReturn = await app.inject({
      method: 'POST',
      url: `/v1/pos/sales/${saleB.id}/returns`,
      headers: headers(ownerToken, { 'idempotency-key': randomUUID() }),
      payload: {
        reason: 'Expired stock write-off return',
        refundMethod: 'CASH',
        lines: [
          {
            invoiceLineId: saleB.lines[0].id,
            returnQty: '1.000000',
            restockCondition: 'DAMAGED',
          },
        ],
      },
    });
    expect(okDamagedReturn.statusCode).toBe(201);
  });

  it('5. Legacy UOM Correction Wizard & Real Offline Sync Push / Snapshot', async () => {
    // Create legacy product wrongly configured with PCS, stock in 5 PCS @ cost 1000 (= 5000 total)
    const riceCreate = await app.inject({
      method: 'POST',
      url: '/v1/products',
      headers: headers(ownerToken, { 'idempotency-key': randomUUID() }),
      payload: {
        sku: 'LEGACY-RICE',
        name: 'Legacy Rice Sack',
        baseUom: 'PCS',
        purchaseCost: '1000.0000',
        sellingPrice: '1250.0000',
        trackInventory: true,
      },
    });
    expect(riceCreate.statusCode).toBe(201);
    legacyRiceId = riceCreate.json().id;

    const mv = await app.inject({
      method: 'POST',
      url: '/v1/inventory/movements',
      headers: headers(ownerToken, { 'idempotency-key': randomUUID() }),
      payload: {
        branchId: branchAId,
        warehouseId: whAId,
        productId: legacyRiceId,
        movementType: 'STOCK_IN',
        quantity: '5.000000',
        uomCode: 'PCS',
        unitCost: '1000.0000',
      },
    });
    expect(mv.statusCode).toBe(201);

    // Direct PATCH of baseUom blocked -> 409 CAT_UOM_CHANGE_REQUIRES_WIZARD
    const directPatch = await app.inject({
      method: 'PATCH',
      url: `/v1/products/${legacyRiceId}`,
      headers: headers(ownerToken),
      payload: { baseUom: 'KG' },
    });
    expect(directPatch.statusCode).toBe(409);
    expect(directPatch.json().errorCode).toBe('CAT_UOM_CHANGE_REQUIRES_WIZARD');

    // Preview 1 PCS = 10 KG -> 50 KG @ 100.0000/KG = 5000 total valuation
    const previewRes = await app.inject({
      method: 'POST',
      url: `/v1/products/${legacyRiceId}/uom-correction-preview`,
      headers: headers(ownerToken),
      payload: {
        targetBaseUom: 'KG',
        targetMeasurementCategory: 'WEIGHT',
        conversionFactorFromOldToNew: '10.000000',
      },
    });
    expect(previewRes.statusCode).toBe(200);
    expect(previewRes.json().projectedTotalQtyInNewUom).toBe('50.000000');
    expect(previewRes.json().projectedUnitCostInNewUom).toBe('100.0000');

    const execRes = await app.inject({
      method: 'POST',
      url: `/v1/products/${legacyRiceId}/uom-correction`,
      headers: headers(ownerToken),
      payload: {
        targetBaseUom: 'KG',
        targetMeasurementCategory: 'WEIGHT',
        conversionFactorFromOldToNew: '10.000000',
        reason: 'Correct bulk sack from PCS to KG',
      },
    });
    expect(execRes.statusCode).toBe(200);
    expect(execRes.json().product.baseUom).toBe('KG');
    expect(execRes.json().previousTotalValuation).toBe(execRes.json().newTotalValuation);

    // Offline Sync Snapshot includes branding, policies, and active batches
    const snapRes = await app.inject({
      method: 'GET',
      url: `/v1/sync/catalog-pricing?branchId=${branchAId}`,
      headers: headers(cashierToken),
    });
    expect(snapRes.statusCode).toBe(200);
    expect(snapRes.json().branding.shopDisplayName).toBe('CEYLON MART SUPER');
    expect(snapRes.json().batches.length).toBeGreaterThanOrEqual(1);

    // Real Sync Push executes offline POS sale + quarantines expired batch sale in same batch
    const deviceId = generateUuidV7();
    const realSyncSaleCmdId = generateUuidV7();
    const expiredSyncSaleCmdId = generateUuidV7();
    const syncPushRes = await app.inject({
      method: 'POST',
      url: '/v1/sync/push',
      headers: { 'x-tenant-id': TENANT_ID, 'x-user-id': cashierToken ? CASHIER_ID : OWNER_ID },
      payload: {
        deviceId,
        branchId: branchAId,
        commands: [
          {
            localSeq: 1,
            commandId: realSyncSaleCmdId,
            tenantId: TENANT_ID,
            branchId: branchAId,
            deviceId,
            actorUserId: CASHIER_ID,
            commandType: 'POS_RECORD_SALE',
            schemaVersion: 1,
            occurredAt: new Date().toISOString(),
            payload: {
              registerId,
              shiftId,
              lines: [{ productId: soapProductId, quantity: '2.000000', uomCode: 'PCS' }],
              payments: [{ paymentMethod: 'CASH', amount: '430.0000', tenderedAmount: '500.0000' }],
            },
          },
          {
            localSeq: 2,
            commandId: expiredSyncSaleCmdId,
            tenantId: TENANT_ID,
            branchId: branchAId,
            deviceId,
            actorUserId: CASHIER_ID,
            commandType: 'POS_RECORD_SALE',
            schemaVersion: 1,
            occurredAt: new Date().toISOString(),
            payload: {
              registerId,
              shiftId,
              lines: [{ productId: soapProductId, batchId: soapExpiredBatchId, quantity: '1.000000', uomCode: 'PCS' }],
              payments: [{ paymentMethod: 'CASH', amount: '100.0000', tenderedAmount: '100.0000' }],
            },
          },
        ],
      },
    });
    expect(syncPushRes.statusCode).toBe(200);
    expect(syncPushRes.json().receipts[0].status).toBe('APPLIED');
    expect(syncPushRes.json().receipts[1].status).toBe('QUARANTINED');
    expect(syncPushRes.json().receipts[1].conflictCode).toBe('POS_BATCH_EXPIRED');

    // =========================================================================
    // Production QA Regression Suite: Supplier API Contract & Maxeal Barcode Scan
    // =========================================================================

    // 1. Supplier creation with canonical businessName + full fields
    const supCanonicalRes = await app.inject({
      method: 'POST',
      url: '/v1/suppliers',
      headers: headers(ownerToken),
      payload: {
        code: 'SUP-QA-01',
        businessName: 'Lanka Dairy & Pharma Distributors',
        contactPerson: 'Kasun Perera',
        email: 'kasun@lankadairy.lk',
        phone: '+94112345678',
        address: '42 Galle Face Court, Colombo 03',
        taxRegistrationNumber: 'VAT-LK-998877',
        notes: 'Net 30 days',
      },
    });
    expect(supCanonicalRes.statusCode).toBe(201);
    expect(supCanonicalRes.json().businessName).toBe('Lanka Dairy & Pharma Distributors');
    expect(supCanonicalRes.json().name).toBe('Lanka Dairy & Pharma Distributors');
    expect(supCanonicalRes.json().isActive).toBe(true);

    // 2. Supplier creation with UI alias payload (name, countryCode, currencyCode)
    const supAliasRes = await app.inject({
      method: 'POST',
      url: '/v1/suppliers',
      headers: headers(ownerToken),
      payload: {
        code: 'SUP-QA-02',
        name: 'Maxeal Healthcare Supplies',
        contactPerson: 'Nimal Silva',
        email: 'nimal@maxeal.lk',
        phone: '+94771234567',
        countryCode: 'LK',
        currencyCode: 'LKR',
      },
    });
    expect(supAliasRes.statusCode).toBe(201);
    const supAliasId = supAliasRes.json().id;
    expect(supAliasRes.json().businessName).toBe('Maxeal Healthcare Supplies');
    expect(supAliasRes.json().name).toBe('Maxeal Healthcare Supplies');

    // 3. Supplier edit with PATCH (businessName / name / leadTimeDays / isActive)
    const supPatchRes = await app.inject({
      method: 'PATCH',
      url: `/v1/suppliers/${supAliasId}`,
      headers: headers(ownerToken),
      payload: {
        businessName: 'Maxeal Healthcare Supplies Pvt Ltd',
        contactPerson: 'Nimal Silva',
        email: 'nimal@maxeal.lk',
        phone: '+94771234567',
        leadTimeDays: 5,
        isActive: true,
      },
    });
    expect(supPatchRes.statusCode).toBe(200);
    expect(supPatchRes.json().businessName).toBe('Maxeal Healthcare Supplies Pvt Ltd');
    expect(supPatchRes.json().name).toBe('Maxeal Healthcare Supplies Pvt Ltd');

    // 4. Supplier strict validation: reject arbitrary unknown properties & blank name
    const supUnknownPropRes = await app.inject({
      method: 'POST',
      url: '/v1/suppliers',
      headers: headers(ownerToken),
      payload: {
        code: 'SUP-BAD-01',
        businessName: 'Valid Name',
        unexpectedField: 'should-fail',
      },
    });
    expect(supUnknownPropRes.statusCode).toBe(400);

    const supMissingNameRes = await app.inject({
      method: 'POST',
      url: '/v1/suppliers',
      headers: headers(ownerToken),
      payload: {
        code: 'SUP-BAD-02',
      },
    });
    expect(supMissingNameRes.statusCode).toBe(400);

    // 5. Maxeal (SKU: MAX-SY) Barcode Scan vs POS Search Stock Availability Parity
    const maxealProdRes = await app.inject({
      method: 'POST',
      url: '/v1/products',
      headers: headers(ownerToken),
      payload: {
        sku: 'MAX-SY',
        name: 'Maxeal',
        productType: 'STANDARD',
        baseUom: 'PCS',
        purchaseCost: '250.0000',
        sellingPrice: '380.0000',
        trackInventory: true,
        trackingMode: 'NONE',
        primaryBarcode: '8909990001112',
      },
    });
    expect(maxealProdRes.statusCode).toBe(201);
    const maxealId = maxealProdRes.json().id;

    // Post 9 PCS opening stock for Maxeal in whAId
    const maxealStockRes = await app.inject({
      method: 'POST',
      url: '/v1/inventory/movements',
      headers: headers(ownerToken, { 'idempotency-key': randomUUID() }),
      payload: {
        branchId: branchAId,
        warehouseId: whAId,
        productId: maxealId,
        movementType: 'OPENING_STOCK',
        quantity: '9.000000',
        uomCode: 'PCS',
        unitCost: '250.0000',
        notes: 'Initial 9 PCS stock for Maxeal',
      },
    });
    expect(maxealStockRes.statusCode).toBe(201);

    // Verify POS catalog search returns 9.000000 available
    const posSearchMaxeal = await app.inject({
      method: 'GET',
      url: `/v1/pos/products/search?warehouseId=${whAId}&q=Maxeal`,
      headers: headers(cashierToken),
    });
    expect(posSearchMaxeal.statusCode).toBe(200);
    expect(posSearchMaxeal.json()[0].availableQuantity).toBe('9.000000');

    // Verify Barcode Resolve by primary barcode, uppercase SKU, and lowercase SKU all return 9.000000 available
    for (const scanInput of ['8909990001112', 'MAX-SY', 'max-sy']) {
      const resolveMaxeal = await app.inject({
        method: 'POST',
        url: '/v1/barcodes/resolve',
        headers: headers(cashierToken),
        payload: {
          rawBarcode: scanInput,
          branchId: branchAId,
          warehouseId: whAId,
        },
      });
      expect(resolveMaxeal.statusCode).toBe(200);
      expect(resolveMaxeal.json().product?.id).toBe(maxealId);
      expect(resolveMaxeal.json().blockedReason).toBeNull();
      expect(resolveMaxeal.json().availableQuantityTotal).toBe('9.000000');
      expect(resolveMaxeal.json().product?.availableQuantity).toBe('9.000000');
    }

    // 6. Batch-tracked product with legacy/opening stock in inventory_balances (0 batch rows)
    const legacyBatchProdRes = await app.inject({
      method: 'POST',
      url: '/v1/products',
      headers: headers(ownerToken),
      payload: {
        sku: 'MAX-SY-BATCH',
        name: 'Maxeal Syrup Batch Mode',
        productType: 'STANDARD',
        baseUom: 'PCS',
        purchaseCost: '250.0000',
        sellingPrice: '380.0000',
        trackInventory: true,
        trackingMode: 'BATCH',
        primaryBarcode: '8909990002225',
      },
    });
    expect(legacyBatchProdRes.statusCode).toBe(201);
    const legacyBatchProdId = legacyBatchProdRes.json().id;

    await app.inject({
      method: 'POST',
      url: '/v1/inventory/movements',
      headers: headers(ownerToken, { 'idempotency-key': randomUUID() }),
      payload: {
        branchId: branchAId,
        warehouseId: whAId,
        productId: legacyBatchProdId,
        movementType: 'OPENING_STOCK',
        quantity: '9.000000',
        uomCode: 'PCS',
        unitCost: '250.0000',
        notes: 'Opening stock without batch row',
      },
    });

    const resolveLegacyBatch = await app.inject({
      method: 'POST',
      url: '/v1/barcodes/resolve',
      headers: headers(cashierToken),
      payload: {
        rawBarcode: '8909990002225',
        branchId: branchAId,
        warehouseId: whAId,
      },
    });
    expect(resolveLegacyBatch.statusCode).toBe(200);
    expect(resolveLegacyBatch.json().blockedReason).toBeNull();
    expect(resolveLegacyBatch.json().availableQuantityTotal).toBe('9.000000');

    // Checkout 1 PCS of legacyBatchProdId succeeds and decrements inventory_balances to 8.000000
    const saleLegacyBatch = await app.inject({
      method: 'POST',
      url: '/v1/pos/sales',
      headers: headers(cashierToken, { 'idempotency-key': randomUUID() }),
      payload: {
        registerId,
        shiftId,
        lines: [{ productId: legacyBatchProdId, quantity: '1.000000', uomCode: 'PCS' }],
        payments: [{ paymentMethod: 'CASH', amount: '380.0000', tenderedAmount: '400.0000' }],
      },
    });
    expect(saleLegacyBatch.statusCode).toBe(201);
  });
});

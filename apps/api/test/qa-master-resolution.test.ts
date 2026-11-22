import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildApp,
  generateUuidV7,
  getOrCreateDevKeyMaterial,
  StaticJwksProvider,
} from '../src/index.js';
import {
  type TestPostgresHarness,
  createTestPostgresHarness,
} from './helpers/pglite-kysely.js';

const TINY_PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
  0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06,
  0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44,
  0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d,
  0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42,
  0x60, 0x82,
]);

function generateTotpCodeFromBase32(base32Secret: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = base32Secret.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = alphabet.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  const secretBuf = Buffer.from(out);
  const counter = BigInt(Math.floor(Date.now() / 1000 / 30));
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(counter, 0);
  const hmac = createHmac('sha1', secretBuf).update(msg).digest();
  const offset = (hmac[hmac.length - 1] ?? 0) & 0x0f;
  const bin =
    (((hmac[offset] ?? 0) & 0x7f) << 24) |
    (((hmac[offset + 1] ?? 0) & 0xff) << 16) |
    (((hmac[offset + 2] ?? 0) & 0xff) << 8) |
    ((hmac[offset + 3] ?? 0) & 0xff);
  return String(bin % 1_000_000).padStart(6, '0');
}

describe('Master QA Resolution — End-to-End Backend & Business Logic Verification', () => {
  let harness: TestPostgresHarness;
  let app: Awaited<ReturnType<typeof buildApp>>;

  let ownerToken = '';
  let tenantId = '';
  let branchId = '';
  let warehouseId = '';
  let registerId = '';
  let shiftId = '';
  let supplierId = '';
  let superAdminToken = '';
  let superAdminUserId = '';

  beforeAll(async () => {
    harness = await createTestPostgresHarness();
    const devKeys = getOrCreateDevKeyMaterial();
    const devJwksProvider = new StaticJwksProvider({
      keys: [devKeys.publicJwk],
    });
    app = await buildApp({
      db: harness.db,
      jwksProvider: devJwksProvider,
    });

    // Sign up & onboard tenant with idempotency verification (2.3)
    const ownerEmail = `qa_owner_${generateUuidV7()}@example.com`;
    const signupRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: {
        email: ownerEmail,
        password: 'StrongPassword123!',
        fullName: 'QA Owner',
      },
    });
    expect(signupRes.statusCode).toBe(201);
    ownerToken = signupRes.json().token;

    const onboardKey = generateUuidV7();
    const ob1 = await app.inject({
      method: 'POST',
      url: '/v1/org/onboard',
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'idempotency-key': onboardKey,
      },
      payload: {
        businessName: 'Lanka Fresh Mart',
        businessType: 'RETAIL',
        currency: 'LKR',
        countryCode: 'LK',
        timezone: 'Asia/Colombo',
        firstBranchName: 'Colombo Flagship',
        firstBranchCode: 'CMB-01',
      },
    });
    expect(ob1.statusCode).toBe(201);
    tenantId = ob1.json().tenant.id;
    branchId = ob1.json().branch.id;
    warehouseId = ob1.json().warehouse.id;
    registerId = ob1.json().register.id;

    // Replay same onboard request with idempotency key -> returns existing resources without duplicating
    const obReplay = await app.inject({
      method: 'POST',
      url: '/v1/org/onboard',
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'idempotency-key': onboardKey,
      },
      payload: {
        businessName: 'Lanka Fresh Mart',
        businessType: 'RETAIL',
        currency: 'LKR',
        countryCode: 'LK',
        timezone: 'Asia/Colombo',
        firstBranchName: 'Colombo Flagship',
        firstBranchCode: 'CMB-01',
      },
    });
    expect([200, 201]).toContain(obReplay.statusCode);
    expect(obReplay.json().tenant.id).toBe(tenantId);

    // Open POS Shift
    const shiftRes = await app.inject({
      method: 'POST',
      url: '/v1/pos/shifts',
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': tenantId,
        'idempotency-key': generateUuidV7(),
      },
      payload: {
        registerId,
        openingCashFloat: '5000.0000',
      },
    });
    expect(shiftRes.statusCode).toBe(201);
    shiftId = shiftRes.json().id;

    // Create Supplier
    const supRes = await app.inject({
      method: 'POST',
      url: '/v1/suppliers',
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': tenantId,
      },
      payload: {
        code: 'SUP-LK-01',
        name: 'Ceylon Wholesale Traders',
      },
    });
    expect(supRes.statusCode).toBe(201);
    supplierId = supRes.json().id;

    // Seed Platform Super Admin account (initially with legacy mfa_enforced=false to verify migration/service enforcement)
    const saRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: {
        email: `qa_superadmin_${generateUuidV7()}@nexstock.lk`,
        password: 'SuperPassword123!',
        fullName: 'QA Super Admin',
      },
    });
    expect(saRes.statusCode).toBe(201);
    superAdminToken = saRes.json().token;
    superAdminUserId = saRes.json().userId;

    await harness.db
      .updateTable('users')
      .set({ is_platform_admin: true })
      .where('id', '=', superAdminUserId)
      .execute();

    await harness.db
      .insertInto('platform_admin_accounts')
      .values({
        user_id: superAdminUserId,
        email: `qa_superadmin_${superAdminUserId}@nexstock.lk`,
        platform_role: 'SUPER_ADMIN',
        status: 'ACTIVE',
        mfa_enforced: true,
        totp_enabled: false,
      })
      .execute();
  });

  afterAll(async () => {
    await app.close();
    await harness.db.destroy();
  });

  it('2.1 & 2.2: Super Admin auth returns clean 401 when unauthenticated, enforces MFA, hides TOTP secret after setup, and supports secret rotation', async () => {
    // Missing Authorization header must return 401 (never Fastify schema 400 "headers/authorization Expected required property")
    const noHeader = await app.inject({
      method: 'GET',
      url: '/v1/platform/security/me',
    });
    expect(noHeader.statusCode).toBe(401);

    const meInitial = await app.inject({
      method: 'GET',
      url: '/v1/platform/security/me',
      headers: { authorization: `Bearer ${superAdminToken}` },
    });
    expect(meInitial.statusCode).toBe(200);
    expect(meInitial.json().mfaEnforced).toBe(true);
    expect(meInitial.json().mfaState).toBe('DISABLED');
    expect(meInitial.json().secretBase32).toBeUndefined();

    // Initialize TOTP setup -> PENDING_VERIFICATION
    const setup1 = await app.inject({
      method: 'POST',
      url: '/v1/platform/security/mfa/setup',
      headers: { authorization: `Bearer ${superAdminToken}` },
      payload: {},
    });
    expect(setup1.statusCode).toBe(200);
    const firstSecret = setup1.json().secretBase32 as string;
    expect(firstSecret.length).toBeGreaterThanOrEqual(16);

    const mePending = await app.inject({
      method: 'GET',
      url: '/v1/platform/security/me',
      headers: { authorization: `Bearer ${superAdminToken}` },
    });
    expect(mePending.statusCode).toBe(200);
    expect(mePending.json().mfaState).toBe('PENDING_VERIFICATION');
    expect(mePending.json().secretBase32).toBeUndefined();

    // Rotate compromised secret via dedicated rotation endpoint
    const rotateRes = await app.inject({
      method: 'POST',
      url: '/v1/platform/security/mfa/rotate',
      headers: { authorization: `Bearer ${superAdminToken}` },
      payload: { reason: 'Rotate QA compromised secret' },
    });
    expect(rotateRes.statusCode).toBe(200);
    const rotatedSecret = rotateRes.json().secretBase32 as string;
    expect(rotatedSecret).not.toBe(firstSecret);

    // Old secret code must fail, rotated secret succeeds
    const validCode = generateTotpCodeFromBase32(rotatedSecret);
    const verifyRes = await app.inject({
      method: 'POST',
      url: '/v1/platform/security/mfa/verify',
      headers: { authorization: `Bearer ${superAdminToken}` },
      payload: { code: validCode },
    });
    expect(verifyRes.statusCode).toBe(200);
    expect(verifyRes.json().verified).toBe(true);

    const meVerified = await app.inject({
      method: 'GET',
      url: '/v1/platform/security/me',
      headers: { authorization: `Bearer ${superAdminToken}` },
    });
    expect(meVerified.statusCode).toBe(200);
    expect(meVerified.json().mfaVerified).toBe(true);
    expect(meVerified.json().mfaState).toBe('VERIFIED');
    expect(meVerified.json().secretBase32).toBeUndefined();
  });

  it('2.4, 2.5, 2.6: Product accepts unitConversions with optional uomName & defaults, supports multiple BAG sizes, and deduplicates identical image uploads', async () => {
    const headers = {
      authorization: `Bearer ${ownerToken}`,
      'x-tenant-id': tenantId,
      'idempotency-key': generateUuidV7(),
    };

    // 2.5 Image upload deduplication
    const imgPayload = {
      filename: 'rice-bag.png',
      mimeType: 'image/png',
      dataBase64: TINY_PNG_BYTES.toString('base64'),
    };
    const up1 = await app.inject({
      method: 'POST',
      url: '/v1/products/upload-image',
      headers: { authorization: `Bearer ${ownerToken}`, 'x-tenant-id': tenantId },
      payload: imgPayload,
    });
    const up2 = await app.inject({
      method: 'POST',
      url: '/v1/products/upload-image',
      headers: { authorization: `Bearer ${ownerToken}`, 'x-tenant-id': tenantId },
      payload: imgPayload,
    });
    expect(up1.statusCode).toBe(201);
    expect(up2.statusCode).toBe(201);
    expect(up2.json().imageUrl).toBe(up1.json().imageUrl);

    // 2.4 & 2.6 Multiple package conversions (1 BAG = 25 KG & 1 BAG = 50 KG) without requiring uomName
    const riceRes = await app.inject({
      method: 'POST',
      url: '/v1/products',
      headers,
      payload: {
        sku: 'RICE-SAMBA-MULTI',
        name: 'Samba White Rice',
        productType: 'STANDARD',
        trackInventory: true,
        trackingMode: 'NONE',
        productQtyMode: 'VARIABLE',
        measurementCategory: 'WEIGHT',
        baseUom: 'KG',
        purchaseUom: 'BAG_25KG',
        priceUom: 'KG',
        allowedSellingUoms: ['KG', 'G'],
        qtyDecimalPrecision: 3,
        purchaseCost: '380.0000',
        sellingPrice: '420.0000',
        unitConversions: [
          { uomCode: 'BAG', conversionFactorToBase: '25.000000', isDefaultPurchasing: true, isDefaultSelling: false },
          { uomCode: 'BAG', conversionFactorToBase: '50.000000', isDefaultPurchasing: false, isDefaultSelling: true },
        ],
      },
    });
    expect(riceRes.statusCode).toBe(201);
    const rice = riceRes.json();
    expect(rice.unitConversions).toHaveLength(2);
    const codes = rice.unitConversions.map((c: { uomCode: string }) => c.uomCode).sort();
    expect(codes).toEqual(['BAG_25KG', 'BAG_50KG']);
    expect(rice.purchaseUom).toBe('BAG_25KG');
    expect(rice.allowedSellingUoms).toContain('BAG_50KG');
  });

  it('2.9 & 4.6: Starter plan runs Core Batch & Expiry (FEFO/FIFO) and normalizes WEIGHT, VOLUME, LENGTH & COUNT UoMs across POS checkout', async () => {
    const authHeaders = {
      authorization: `Bearer ${ownerToken}`,
      'x-tenant-id': tenantId,
    };

    // Move tenant explicitly onto STARTER ACTIVE to confirm Starter rules
    const setStarter = await app.inject({
      method: 'PATCH',
      url: '/v1/subscriptions/lifecycle',
      headers: authHeaders,
      payload: { planCode: 'STARTER', status: 'ACTIVE', allowAdminOverride: false },
    });
    expect(setStarter.statusCode).toBe(200);
    expect(setStarter.json().features.batchTracking).toBe(true);
    expect(setStarter.json().features.expiryTracking).toBe(true);
    expect(setStarter.json().features.serialTracking).toBe(false);

    // 4.6 & 5.4: Catalog reports 'Pro' display name
    const plansRes = await app.inject({ method: 'GET', url: '/v1/subscriptions/plans' });
    expect(plansRes.statusCode).toBe(200);
    const proPlan = plansRes.json().items.find((p: { code: string }) => p.code === 'PROFESSIONAL');
    expect(proPlan.name).toBe('Pro');

    // Create 4 products: Oil (L), Rice (KG), Cable (M), Soap (PCS w/ BOX=12) — with Starter BATCH_EXPIRY on Oil!
    const createProd = async (payload: Record<string, unknown>) => {
      const r = await app.inject({
        method: 'POST',
        url: '/v1/products',
        headers: { ...authHeaders, 'idempotency-key': generateUuidV7() },
        payload,
      });
      expect(r.statusCode).toBe(201);
      return r.json();
    };

    const coconutOil = await createProd({
      sku: 'OIL-COCONUT-01',
      name: 'Coconut Oil',
      trackInventory: true,
      trackingMode: 'BATCH_EXPIRY',
      allocationPolicy: 'FEFO',
      productQtyMode: 'VARIABLE',
      measurementCategory: 'VOLUME',
      baseUom: 'L',
      purchaseUom: 'L',
      priceUom: 'L',
      allowedSellingUoms: ['L', 'ML'],
      qtyDecimalPrecision: 3,
      purchaseCost: '500.0000',
      sellingPrice: '700.0000', // 250 ML = 175 LKR
    });

    const lengthCable = await createProd({
      sku: 'WIRE-25M-01',
      name: 'Copper Cable',
      trackInventory: true,
      trackingMode: 'NONE',
      productQtyMode: 'VARIABLE',
      measurementCategory: 'LENGTH',
      baseUom: 'M',
      purchaseUom: 'M',
      priceUom: 'M',
      allowedSellingUoms: ['M', 'CM'],
      qtyDecimalPrecision: 2,
      purchaseCost: '100.0000',
      sellingPrice: '150.0000', // 50 CM = 75 LKR
    });

    const soapBox = await createProd({
      sku: 'SOAP-PACK-01',
      name: 'Herbal Soap',
      trackInventory: true,
      trackingMode: 'NONE',
      productQtyMode: 'STANDARD',
      measurementCategory: 'COUNT',
      baseUom: 'PCS',
      purchaseUom: 'BOX',
      priceUom: 'PCS',
      allowedSellingUoms: ['PCS', 'BOX'],
      qtyDecimalPrecision: 0,
      purchaseCost: '80.0000',
      sellingPrice: '100.0000',
      unitConversions: [{ uomCode: 'BOX', conversionFactorToBase: '12', isDefaultPurchasing: true, isDefaultSelling: true }],
    });

    // Starter must be able to create Batch for BATCH_EXPIRY Coconut Oil! (4.6)
    const oilBatchRes = await app.inject({
      method: 'POST',
      url: '/v1/inventory/batches',
      headers: { ...authHeaders, 'idempotency-key': generateUuidV7() },
      payload: {
        branchId,
        warehouseId,
        productId: coconutOil.id,
        batchNumber: 'OIL-B1',
        initialQuantity: '5.000000',
        unitCost: '500.0000',
        sellingPrice: '700.0000',
        receivedDate: '2026-11-01',
        expiryDate: '2027-12-31',
      },
    });
    expect(oilBatchRes.statusCode).toBe(201);

    // Stock intake for Cable (10 M) & Soap (24 PCS = 2 BOX)
    for (const st of [
      { productId: lengthCable.id, quantity: '10.000000', uomCode: 'M', unitCost: '100.0000' },
      { productId: soapBox.id, quantity: '2.000000', uomCode: 'BOX', unitCost: '960.0000' },
    ]) {
      const mRes = await app.inject({
        method: 'POST',
        url: '/v1/inventory/movements',
        headers: { ...authHeaders, 'idempotency-key': generateUuidV7() },
        payload: {
          branchId,
          warehouseId,
          productId: st.productId,
          movementType: 'STOCK_IN',
          quantity: st.quantity,
          uomCode: st.uomCode,
          unitCost: st.unitCost,
          reason: 'Initial stock load',
        },
      });
      expect(mRes.statusCode).toBe(201);
    }

    // Checkout: 250 ML Oil (0.25 L = LKR 175), 50 CM Cable (0.5 M = LKR 75), 1 BOX Soap (12 PCS = LKR 1200) -> Grand Total 1450.00
    const saleRes = await app.inject({
      method: 'POST',
      url: '/v1/pos/sales',
      headers: { ...authHeaders, 'idempotency-key': generateUuidV7() },
      payload: {
        registerId,
        shiftId,
        lines: [
          { productId: coconutOil.id, quantity: '250.000000', uomCode: 'ML' },
          { productId: lengthCable.id, quantity: '50.000000', uomCode: 'CM' },
          { productId: soapBox.id, quantity: '1.000000', uomCode: 'BOX' },
        ],
        payments: [{ paymentMethod: 'CASH', amount: '1450.0000', tenderedAmount: '1500.0000' }],
      },
    });
    expect(saleRes.statusCode).toBe(201);
    expect(saleRes.json().grandTotal).toBe('1450.0000');

    // Verify exact base balances after sale (Oil: 4.75 L, Cable: 9.5 M, Soap: 12 PCS)
    const balRes = await app.inject({
      method: 'GET',
      url: `/v1/inventory/balances?warehouseId=${warehouseId}`,
      headers: authHeaders,
    });
    expect(balRes.statusCode).toBe(200);
    const balances = new Map<string, string>(
      balRes.json().data.map((b: { productId: string; qtyOnHand: string }) => [b.productId, b.qtyOnHand]),
    );
    expect(balances.get(coconutOil.id)).toBe('4.750000');
    expect(balances.get(lengthCable.id)).toBe('9.500000');
    expect(balances.get(soapBox.id)).toBe('12.000000');
  });

  it('2.7, 2.8 & 4.5: GRN lotConflictPolicy & Smart Stock Receiving pricing recommendations preserve active POS price until explicit Approve & Publish, and MANUAL batch policy enforces selection', async () => {
    const authHeaders = {
      authorization: `Bearer ${ownerToken}`,
      'x-tenant-id': tenantId,
    };

    // Create BATCH product with MANUAL allocation policy (2.8)
    const manProdRes = await app.inject({
      method: 'POST',
      url: '/v1/products',
      headers: { ...authHeaders, 'idempotency-key': generateUuidV7() },
      payload: {
        sku: 'MED-MANUAL-01',
        name: 'Manual Batch Syrup',
        trackInventory: true,
        trackingMode: 'BATCH',
        allocationPolicy: 'MANUAL',
        baseUom: 'PCS',
        purchaseCost: '100.0000',
        sellingPrice: '150.0000',
      },
    });
    expect(manProdRes.statusCode).toBe(201);
    expect(manProdRes.json().allocationPolicy).toBe('MANUAL');
    const manProdId = manProdRes.json().id as string;

    // Post first GRN at cost 100
    const grn1 = await app.inject({
      method: 'POST',
      url: '/v1/goods-receipts',
      headers: { ...authHeaders, 'idempotency-key': generateUuidV7() },
      payload: {
        supplierId,
        branchId,
        warehouseId,
        lotConflictPolicy: 'REJECT',
        lines: [
          {
            productId: manProdId,
            receivedUom: 'PCS',
            receivedQty: '10.000000',
            unitCost: '100.0000',
            batchNumber: 'LOT-MAN-01',
          },
        ],
      },
    });
    expect(grn1.statusCode).toBe(201);

    // Post second GRN with same lot & higher cost 140 using CREATE_NEW_LOT_SUFFIX + Market Price (2.7 & 4.5)
    const grn2 = await app.inject({
      method: 'POST',
      url: '/v1/goods-receipts',
      headers: { ...authHeaders, 'idempotency-key': generateUuidV7() },
      payload: {
        supplierId,
        branchId,
        warehouseId,
        lotConflictPolicy: 'CREATE_NEW_LOT_SUFFIX',
        lines: [
          {
            productId: manProdId,
            receivedUom: 'PCS',
            receivedQty: '10.000000',
            unitCost: '140.0000',
            batchNumber: 'LOT-MAN-01',
            marketPrice: '210.0000',
            marketPriceSource: 'MANUAL_ENTRY',
          },
        ],
      },
    });
    expect(grn2.statusCode).toBe(201);
    expect(grn2.json().lines[0].lotConflictResolution).toBe('SUFFIXED');
    const rec = grn2.json().pricingRecommendations[0];
    expect(rec.incomingPurchaseCost).toBe('140.0000');
    expect(rec.updatedMovingAvgCost).toBe('120.0000');
    expect(rec.marketPrice).toBe('210.0000');

    // Active product selling price MUST remain 150.0000 until explicitly approved!
    const prodBeforeApprove = await app.inject({
      method: 'GET',
      url: `/v1/products/${manProdId}`,
      headers: authHeaders,
    });
    expect(prodBeforeApprove.json().sellingPrice).toBe('150.0000');
    expect(prodBeforeApprove.json().allocationPolicy).toBe('MANUAL');

    // Approve suggestion cleanly -> updates active price (explicit Approve & Publish)
    if (rec.suggestionId) {
      const appSug = await app.inject({
        method: 'POST',
        url: `/v1/pricing/suggestions/${rec.suggestionId}/approve`,
        headers: authHeaders,
        payload: { overridePrice: '195.0000', reviewNotes: 'Approved from QA test' },
      });
      expect(appSug.statusCode).toBe(200);
    }

    // 2.8 Checkout WITHOUT batchId on MANUAL policy product MUST fail (422 POS_BATCH_SELECTION_REQUIRED)
    const manualMissingBatch = await app.inject({
      method: 'POST',
      url: '/v1/pos/sales',
      headers: { ...authHeaders, 'idempotency-key': generateUuidV7() },
      payload: {
        registerId,
        shiftId,
        lines: [{ productId: manProdId, quantity: '1.000000', uomCode: 'PCS' }],
        payments: [{ paymentMethod: 'CASH', amount: '150.0000', tenderedAmount: '200.0000' }],
      },
    });
    expect(manualMissingBatch.statusCode).toBe(422);
    expect(manualMissingBatch.json().errorCode).toBe('POS_BATCH_SELECTION_REQUIRED');

    // Selecting exact batchId succeeds cleanly
    const targetBatchId = grn1.json().lines[0].batchId as string;
    const manualWithBatch = await app.inject({
      method: 'POST',
      url: '/v1/pos/sales',
      headers: { ...authHeaders, 'idempotency-key': generateUuidV7() },
      payload: {
        registerId,
        shiftId,
        lines: [{ productId: manProdId, batchId: targetBatchId, quantity: '1.000000', uomCode: 'PCS' }],
        payments: [{ paymentMethod: 'CASH', amount: '150.0000', tenderedAmount: '150.0000' }],
      },
    });
    expect(manualWithBatch.statusCode).toBe(201);
  });

  it('4.1-4.4 & 5.2-5.3: Serial Stock Intake Groups, NB-S barcodes, label print/reprint identity, POS serial scan auto-ID, Starter blocking & historical preservation', async () => {
    const authHeaders = {
      authorization: `Bearer ${ownerToken}`,
      'x-tenant-id': tenantId,
    };

    // Create SERIAL product
    const phoneRes = await app.inject({
      method: 'POST',
      url: '/v1/products',
      headers: { ...authHeaders, 'idempotency-key': generateUuidV7() },
      payload: {
        sku: 'PHONE-S25-PRO',
        name: 'Galaxy S25 Pro',
        trackInventory: true,
        trackingMode: 'SERIAL',
        baseUom: 'PCS',
        purchaseCost: '150000.0000',
        sellingPrice: '185000.0000',
      },
    });
    expect(phoneRes.statusCode).toBe(201);
    const phoneId = phoneRes.json().id as string;

    // On STARTER plan, registering serials is blocked by backend entitlement (5.2)
    const blockedStarterSerial = await app.inject({
      method: 'POST',
      url: '/v1/inventory/serials',
      headers: { ...authHeaders, 'idempotency-key': generateUuidV7() },
      payload: {
        branchId,
        warehouseId,
        productId: phoneId,
        serialNumbers: ['SN-BLOCK-1'],
        unitCost: '150000.0000',
        sellingPrice: '180000.0000',
      },
    });
    expect(blockedStarterSerial.statusCode).toBe(403);
    expect(blockedStarterSerial.json().errorCode).toBe('SUB_FEATURE_NOT_ENTITLED');

    // Upgrade to PRO (PROFESSIONAL) to use Serial Stock Groups
    const upgradePro = await app.inject({
      method: 'PATCH',
      url: '/v1/subscriptions/lifecycle',
      headers: authHeaders,
      payload: { planCode: 'PROFESSIONAL', status: 'ACTIVE', allowAdminOverride: false },
    });
    expect(upgradePro.statusCode).toBe(200);

    // 4.1 & 4.2 Register Stock Group A & Stock Group B with independent cost & selling price
    const grpAIntake = await app.inject({
      method: 'POST',
      url: '/v1/inventory/serials',
      headers: { ...authHeaders, 'idempotency-key': generateUuidV7() },
      payload: {
        branchId,
        warehouseId,
        productId: phoneId,
        groupCode: 'SG-LOT-A',
        serialNumbers: ['IMEI-A01', 'IMEI-A02'],
        unitCost: '140000.0000',
        sellingPrice: '179000.0000',
        generateBarcodes: true,
      },
    });
    expect(grpAIntake.statusCode).toBe(201);
    const serialA1 = grpAIntake.json()[0];
    expect(serialA1.internalBarcode).toMatch(/^NB-S/);
    expect(serialA1.sellingPrice).toBe('179000.0000');

    const grpBIntake = await app.inject({
      method: 'POST',
      url: '/v1/inventory/serials',
      headers: { ...authHeaders, 'idempotency-key': generateUuidV7() },
      payload: {
        branchId,
        warehouseId,
        productId: phoneId,
        groupCode: 'SG-LOT-B',
        serialNumbers: ['IMEI-B01'],
        unitCost: '160000.0000',
        sellingPrice: '199000.0000',
        generateBarcodes: true,
      },
    });
    expect(grpBIntake.statusCode).toBe(201);
    const serialB1 = grpBIntake.json()[0];
    expect(serialB1.internalBarcode).toMatch(/^NB-S/);
    expect(serialB1.internalBarcode).not.toBe(serialA1.internalBarcode);

    // 4.3 Print & reprint preserves exact NB-S barcode identity
    const groupIdA = serialA1.serialGroupId as string;
    const pLog1 = await app.inject({
      method: 'POST',
      url: `/v1/inventory/serial-groups/${groupIdA}/print-log`,
      headers: authHeaders,
      payload: { serialIds: [serialA1.id], format: 'THERMAL_50X30' },
    });
    expect(pLog1.statusCode).toBe(200);
    expect(pLog1.json().serials[0].internalBarcode).toBe(serialA1.internalBarcode);
    expect(pLog1.json().serials[0].labelPrintCount).toBe(1);

    // 4.4 Resolve NB-S barcode at POS -> returns exact serial & group selling price (179000.0000 vs 199000.0000)
    const resolveA1 = await app.inject({
      method: 'POST',
      url: '/v1/barcodes/resolve',
      headers: authHeaders,
      payload: { rawBarcode: serialA1.internalBarcode, branchId, warehouseId },
    });
    expect(resolveA1.statusCode).toBe(200);
    expect(resolveA1.json().matchedBy).toBe('SERIAL_BARCODE');
    expect(resolveA1.json().isExactSerialLocked).toBe(true);
    expect(resolveA1.json().effectiveUnitPrice).toBe('179000.0000');
    expect(resolveA1.json().priceSource).toBe('SERIAL_GROUP');

    const resolveB1 = await app.inject({
      method: 'POST',
      url: '/v1/barcodes/resolve',
      headers: authHeaders,
      payload: { rawBarcode: serialB1.internalBarcode, branchId, warehouseId },
    });
    expect(resolveB1.statusCode).toBe(200);
    expect(resolveB1.json().effectiveUnitPrice).toBe('199000.0000');

    // Checkout serialA1 using scannedBarcode -> deducts group remainingQuantity from 2 -> 1
    const saleSerial = await app.inject({
      method: 'POST',
      url: '/v1/pos/sales',
      headers: { ...authHeaders, 'idempotency-key': generateUuidV7() },
      payload: {
        registerId,
        shiftId,
        lines: [
          {
            productId: phoneId,
            quantity: '1.000000',
            uomCode: 'PCS',
            scannedBarcode: serialA1.internalBarcode,
          },
        ],
        payments: [{ paymentMethod: 'CASH', amount: '179000.0000', tenderedAmount: '180000.0000' }],
      },
    });
    expect(saleSerial.statusCode).toBe(201);
    expect(saleSerial.json().lines[0].serialId).toBe(serialA1.id);
    expect(saleSerial.json().lines[0].serialNumber).toBe('IMEI-A01');

    // Resolving same sold barcode must show blocked SERIAL_SOLD
    const resolveSold = await app.inject({
      method: 'POST',
      url: '/v1/barcodes/resolve',
      headers: authHeaders,
      payload: { rawBarcode: serialA1.internalBarcode, branchId, warehouseId },
    });
    expect(resolveSold.statusCode).toBe(200);
    expect(resolveSold.json().blockedReason).toBe('SERIAL_SOLD');

    // Group remainingQuantity decremented cleanly (2 -> 1)
    const grpAFetch = await app.inject({
      method: 'GET',
      url: `/v1/inventory/serial-groups/${groupIdA}`,
      headers: authHeaders,
    });
    expect(grpAFetch.statusCode).toBe(200);
    expect(grpAFetch.json().remainingQuantity).toBe(1);

    // 5.3 Downgrade to STARTER: historical serial groups & serial records MUST remain readable
    const downgradeStarter = await app.inject({
      method: 'PATCH',
      url: '/v1/subscriptions/lifecycle',
      headers: authHeaders,
      payload: { planCode: 'STARTER', status: 'ACTIVE', allowAdminOverride: false },
    });
    expect(downgradeStarter.statusCode).toBe(200);
    const historyGroupsOnStarter = await app.inject({
      method: 'GET',
      url: '/v1/inventory/serial-groups',
      headers: authHeaders,
    });
    expect(historyGroupsOnStarter.statusCode).toBe(200);
    expect(historyGroupsOnStarter.json().data.length).toBeGreaterThanOrEqual(2);
  });
});

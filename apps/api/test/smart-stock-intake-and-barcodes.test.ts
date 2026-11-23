import { type KeyObject, generateKeyPairSync, sign } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_SUPABASE_JWT_AUDIENCE,
  DEFAULT_SUPABASE_JWT_ISSUER,
  StaticJwksProvider,
  type SupabaseJwk,
  buildApp,
  generateUuidV7,
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
  const header = {
    alg: 'ES256',
    typ: 'JWT',
    kid: keyMaterial.kid,
  };
  const headerB64 = Buffer.from(JSON.stringify(header), 'utf-8').toString('base64url');
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64url');
  const signingInput = Buffer.from(`${headerB64}.${payloadB64}`, 'utf-8');
  const signature = sign('sha256', signingInput, {
    key: keyMaterial.privateKey,
    dsaEncoding: 'ieee-p1363',
  });
  return `${headerB64}.${payloadB64}.${signature.toString('base64url')}`;
}

describe('NexStock — Smart Stock Change Detection, Unified Stock Intake Layers, Advanced Barcode Management & Multi-UoM POS Suite', () => {
  let harness: TestPostgresHarness;
  let app: Awaited<ReturnType<typeof buildApp>>;

  const primaryKey = createTestEs256KeyMaterial('01f76c4b-9743-48ad-bed6-a9c89dc99cc2');
  const jwksProvider = new StaticJwksProvider({
    keys: [primaryKey.publicJwk],
  });

  const ownerUserId = '0192b4a0-8888-7000-8000-000000000001';
  let ownerToken: string;
  let tenantId: string;
  let branchId: string;
  let warehouseId: string;
  let registerId: string;
  let shiftId: string;

  function issueToken(userId: string, email = 'owner@nexstock.test'): string {
    const nowSeconds = Math.floor(Date.now() / 1000);
    return signEs256Jwt(primaryKey, {
      iss: DEFAULT_SUPABASE_JWT_ISSUER,
      aud: DEFAULT_SUPABASE_JWT_AUDIENCE,
      sub: userId,
      email,
      iat: nowSeconds - 60,
      nbf: nowSeconds - 60,
      exp: nowSeconds + 7200,
    });
  }

  beforeAll(async () => {
    harness = await createTestPostgresHarness();
    app = await buildApp({
      db: harness.db,
      jwksProvider,
    });
    ownerToken = issueToken(ownerUserId);

    const onboardRes = await app.inject({
      method: 'POST',
      url: '/v1/org/onboard',
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'idempotency-key': generateUuidV7(),
      },
      payload: {
        businessName: 'NexStock Smart Inventory Mart',
        businessType: 'RETAIL',
        countryCode: 'LK',
        currency: 'LKR',
        timezone: 'Asia/Colombo',
        firstBranchName: 'Colombo Main Branch',
        firstBranchCode: 'CMB-01',
      },
    });
    expect(onboardRes.statusCode).toBe(201);
    const onboardBody = onboardRes.json();
    tenantId = onboardBody.tenant.id;
    branchId = onboardBody.branch.id;
    warehouseId = onboardBody.warehouse.id;

    // Ensure default POS register & open active shift
    const regRes = await app.inject({
      method: 'POST',
      url: '/v1/pos/registers/ensure-default',
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': tenantId,
      },
      payload: {
        branchId,
      },
    });
    expect([200, 201]).toContain(regRes.statusCode);
    registerId = regRes.json().id;

    const shiftRes = await app.inject({
      method: 'POST',
      url: '/v1/pos/shifts',
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': tenantId,
      },
      payload: {
        registerId,
        openingCashFloat: '5000.0000',
      },
    });
    expect(shiftRes.statusCode).toBe(201);
    shiftId = shiftRes.json().id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('1. Tracks stock intake layers across receipts, detects cost/price changes without silently overwriting global POS price, suppresses noise on identical replenishment, and resolves alerts into intake-specific barcodes', async () => {
    // 1. Create product with initial purchase cost LKR 100 and global selling price LKR 150
    const createProdRes = await app.inject({
      method: 'POST',
      url: '/v1/products',
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': tenantId,
        'idempotency-key': generateUuidV7(),
      },
      payload: {
        sku: 'SMART-TEA-001',
        name: 'Ceylon Gold Tea 200g',
        baseUom: 'PCS',
        purchaseCost: '100.0000',
        sellingPrice: '150.0000',
        trackInventory: true,
        trackingMode: 'NONE',
        primaryBarcode: 'BC-TEA-GLOBAL',
      },
    });
    expect(createProdRes.statusCode).toBe(201);
    const product = createProdRes.json();
    const productId = product.id as string;

    // 2. Receive 100 PCS via OPENING_STOCK @ cost 100 / price 150
    const move1Res = await app.inject({
      method: 'POST',
      url: '/v1/inventory/movements',
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': tenantId,
        'idempotency-key': generateUuidV7(),
      },
      payload: {
        branchId,
        warehouseId,
        productId,
        movementType: 'OPENING_STOCK',
        quantity: '100.000000',
        uomCode: 'PCS',
        unitCost: '100.0000',
        sellingPrice: '150.0000',
        reason: 'Initial opening stock @ 100 cost / 150 price',
      },
    });
    expect(move1Res.statusCode).toBe(201);
    const move1 = move1Res.json();
    expect(move1.stockIntakeLotId).toBeTruthy();
    expect(move1.intakeCode).toMatch(/^INT-/);
    // Identical to product baseline (cost 100, price 150) -> no noisy alert
    expect(move1.configAlertId).toBeNull();
    const lot1Id = move1.stockIntakeLotId as string;

    // 3. Receive identical replenishment of 20 PCS via STOCK_IN @ cost 100 / price 150 -> noise suppressed!
    const move2Res = await app.inject({
      method: 'POST',
      url: '/v1/inventory/movements',
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': tenantId,
        'idempotency-key': generateUuidV7(),
      },
      payload: {
        branchId,
        warehouseId,
        productId,
        movementType: 'STOCK_IN',
        quantity: '20.000000',
        uomCode: 'PCS',
        unitCost: '100.0000',
        sellingPrice: '150.0000',
        reason: 'Identical replenishment',
      },
    });
    expect(move2Res.statusCode).toBe(201);
    expect(move2Res.json().configAlertId).toBeNull();

    // 4. Receive new stock of 50 PCS via STOCK_IN @ cost 120 and new selling price 180
    const move3Res = await app.inject({
      method: 'POST',
      url: '/v1/inventory/movements',
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': tenantId,
        'idempotency-key': generateUuidV7(),
      },
      payload: {
        branchId,
        warehouseId,
        productId,
        movementType: 'STOCK_IN',
        quantity: '50.000000',
        uomCode: 'PCS',
        unitCost: '120.0000',
        sellingPrice: '180.0000',
        reason: 'New shipment with higher cost 120 and selling price 180',
      },
    });
    expect(move3Res.statusCode).toBe(201);
    const move3 = move3Res.json();
    expect(move3.stockIntakeLotId).toBeTruthy();
    expect(move3.configAlertId).toBeTruthy();
    const lot3Id = move3.stockIntakeLotId as string;
    const alertId = move3.configAlertId as string;

    // 5. Verify global product selling price was NOT silently overwritten (still 150.0000)
    const getProdRes = await app.inject({
      method: 'GET',
      url: `/v1/products/${productId}`,
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': tenantId,
      },
    });
    expect(getProdRes.statusCode).toBe(200);
    expect(getProdRes.json().sellingPrice).toBe('150.0000');

    // 6. Inspect the generated Smart Stock Configuration Alert
    const alertsRes = await app.inject({
      method: 'GET',
      url: `/v1/inventory/config-alerts?productId=${productId}&status=PENDING`,
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': tenantId,
      },
    });
    expect(alertsRes.statusCode).toBe(200);
    const alerts = alertsRes.json();
    expect(alerts.length).toBe(1);
    expect(alerts[0].id).toBe(alertId);
    expect(alerts[0].severity).toBe('CONFLICT');
    expect(alerts[0].changeTypes).toEqual(
      expect.arrayContaining([
        'PURCHASE_COST_CHANGED',
        'SELLING_PRICE_CHANGED',
        'BARCODE_MAPPING_CONFLICT',
      ]),
    );
    expect(alerts[0].previousConfig.sellingPrice).toBe('150.0000');
    expect(alerts[0].incomingConfig.purchaseCostPerBaseUom).toBe('120.0000');
    expect(alerts[0].incomingConfig.sellingPrice).toBe('180.0000');

    // 7. Resolve the alert via CREATE_INTAKE_BARCODE for Lot 3 @ LKR 180
    const resolveRes = await app.inject({
      method: 'POST',
      url: `/v1/inventory/config-alerts/${alertId}/resolve`,
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': tenantId,
      },
      payload: {
        action: 'CREATE_INTAKE_BARCODE',
        sellingPrice: '180.0000',
        barcode: 'BC-TEA-LOT3-180',
        notes: 'Separate barcode for LKR 180 stock layer',
      },
    });
    expect(resolveRes.statusCode).toBe(200);
    expect(resolveRes.json().status).toBe('RESOLVED');
    expect(resolveRes.json().resolutionAction).toBe('CREATE_INTAKE_BARCODE');

    // 8. Also register an explicit intake barcode for Lot 1 @ LKR 150 via Centralized Barcode Management
    const addLot1BcRes = await app.inject({
      method: 'POST',
      url: `/v1/products/${productId}/barcodes`,
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': tenantId,
      },
      payload: {
        barcode: 'BC-TEA-LOT1-150',
        symbology: 'CODE128',
        uomCode: 'PCS',
        stockIntakeLotId: lot1Id,
        priceSourceMode: 'INTAKE_SPECIFIC',
        sellingPriceOverride: '150.0000',
        isPrimary: false,
        isActive: true,
      },
    });
    expect(addLot1BcRes.statusCode).toBe(201);
    const lot1BarcodeId = addLot1BcRes.json().id as string;

    // Verify duplicate barcode rejection
    const dupBcRes = await app.inject({
      method: 'POST',
      url: `/v1/products/${productId}/barcodes`,
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': tenantId,
      },
      payload: {
        barcode: 'BC-TEA-LOT3-180',
        symbology: 'CODE128',
      },
    });
    expect(dupBcRes.statusCode).toBe(409);

    // 9. Test barcode deactivation & POS rejection of inactive barcode
    const deactRes = await app.inject({
      method: 'PATCH',
      url: `/v1/products/${productId}/barcodes/${lot1BarcodeId}`,
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': tenantId,
      },
      payload: {
        isActive: false,
      },
    });
    expect(deactRes.statusCode).toBe(200);
    expect(deactRes.json().isActive).toBe(false);

    const resolveInactiveRes = await app.inject({
      method: 'POST',
      url: '/v1/barcodes/resolve',
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': tenantId,
      },
      payload: {
        rawBarcode: 'BC-TEA-LOT1-150',
        branchId,
        warehouseId,
      },
    });
    expect(resolveInactiveRes.statusCode).toBe(200);
    expect(resolveInactiveRes.json().blockedReason).toBe('BARCODE_INACTIVE');

    // Reactivate BC-TEA-LOT1-150
    const reactRes = await app.inject({
      method: 'PATCH',
      url: `/v1/products/${productId}/barcodes/${lot1BarcodeId}`,
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': tenantId,
      },
      payload: {
        isActive: true,
      },
    });
    expect(reactRes.statusCode).toBe(200);
    expect(reactRes.json().isActive).toBe(true);

    // 10. Resolve both intake barcodes in POS and verify distinct prices & locked intake lots
    const resLot1 = await app.inject({
      method: 'POST',
      url: '/v1/barcodes/resolve',
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': tenantId,
      },
      payload: {
        rawBarcode: 'BC-TEA-LOT1-150',
        branchId,
        warehouseId,
      },
    });
    expect(resLot1.statusCode).toBe(200);
    expect(resLot1.json().isExactIntakeLotLocked).toBe(true);
    expect(resLot1.json().exactIntakeLot.id).toBe(lot1Id);
    expect(resLot1.json().effectiveUnitPrice).toBe('150.0000');

    const resLot3 = await app.inject({
      method: 'POST',
      url: '/v1/barcodes/resolve',
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': tenantId,
      },
      payload: {
        rawBarcode: 'BC-TEA-LOT3-180',
        branchId,
        warehouseId,
      },
    });
    expect(resLot3.statusCode).toBe(200);
    expect(resLot3.json().isExactIntakeLotLocked).toBe(true);
    expect(resLot3.json().exactIntakeLot.id).toBe(lot3Id);
    expect(resLot3.json().effectiveUnitPrice).toBe('180.0000');

    // 11. Checkout a single POS sale containing both Lot 1 (2 PCS @ 150) and Lot 3 (3 PCS @ 180)
    // Total = (2 * 150) + (3 * 180) = 300 + 540 = 840.0000
    const saleRes = await app.inject({
      method: 'POST',
      url: '/v1/pos/sales',
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': tenantId,
        'idempotency-key': generateUuidV7(),
      },
      payload: {
        registerId,
        shiftId,
        lines: [
          {
            productId,
            stockIntakeLotId: lot1Id,
            scannedBarcode: 'BC-TEA-LOT1-150',
            quantity: '2.000000',
            uomCode: 'PCS',
            entrySource: 'BARCODE_SCAN',
          },
          {
            productId,
            stockIntakeLotId: lot3Id,
            scannedBarcode: 'BC-TEA-LOT3-180',
            quantity: '3.000000',
            uomCode: 'PCS',
            entrySource: 'BARCODE_SCAN',
          },
        ],
        payments: [
          {
            paymentMethod: 'CASH',
            amount: '840.0000',
            tenderedAmount: '1000.0000',
          },
        ],
      },
    });
    expect(saleRes.statusCode).toBe(201);
    const sale = saleRes.json();
    expect(sale.grandTotal).toBe('840.0000');
    expect(sale.lines).toHaveLength(2);
    expect(sale.lines[0].unitPrice).toBe('150.0000');
    expect(sale.lines[0].stockIntakeLotId).toBe(lot1Id);
    expect(sale.lines[0].scannedBarcode).toBe('BC-TEA-LOT1-150');
    expect(sale.lines[1].unitPrice).toBe('180.0000');
    expect(sale.lines[1].stockIntakeLotId).toBe(lot3Id);
    expect(sale.lines[1].scannedBarcode).toBe('BC-TEA-LOT3-180');

    // 12. Verify hard-deletion of a barcode referenced in historical sales is blocked (409 CAT_BARCODE_IN_USE_DEACTIVATE_ONLY)
    const delInUseRes = await app.inject({
      method: 'DELETE',
      url: `/v1/products/${productId}/barcodes/${lot1BarcodeId}`,
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': tenantId,
      },
    });
    expect(delInUseRes.statusCode).toBe(409);
    expect(delInUseRes.json().errorCode).toBe('CAT_BARCODE_IN_USE_DEACTIVATE_ONLY');

    // 13. Verify exact stock intake lot deductions (Lot 1: 100 -> 98, Lot 3: 50 -> 47)
    const lotsAfterSaleRes = await app.inject({
      method: 'GET',
      url: `/v1/inventory/intake-lots?productId=${productId}`,
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': tenantId,
      },
    });
    expect(lotsAfterSaleRes.statusCode).toBe(200);
    const lotsAfterSale = lotsAfterSaleRes.json() as Array<{ id: string; baseQtyRemaining: string }>;
    expect(lotsAfterSale.find((l) => l.id === lot1Id)?.baseQtyRemaining).toBe('98.000000');
    expect(lotsAfterSale.find((l) => l.id === lot3Id)?.baseQtyRemaining).toBe('47.000000');

    // 14. Process a customer return of 1 PCS from Line 2 (Lot 3) -> restores Lot 3 to 48.000000
    const returnRes = await app.inject({
      method: 'POST',
      url: `/v1/pos/sales/${sale.id}/returns`,
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': tenantId,
        'idempotency-key': generateUuidV7(),
      },
      payload: {
        reason: 'Customer returned 1 unit from Lot 3',
        refundMethod: 'CASH',
        lines: [
          {
            invoiceLineId: sale.lines[1].id,
            returnQty: '1.000000',
          },
        ],
      },
    });
    expect(returnRes.statusCode).toBe(201);

    const lotsAfterReturnRes = await app.inject({
      method: 'GET',
      url: `/v1/inventory/intake-lots?productId=${productId}`,
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': tenantId,
      },
    });
    const lotsAfterReturn = lotsAfterReturnRes.json() as Array<{ id: string; baseQtyRemaining: string }>;
    expect(lotsAfterReturn.find((l) => l.id === lot3Id)?.baseQtyRemaining).toBe('48.000000');

    // 15. Attempt to sell 49 PCS from Lot 3 (only 48 remaining) -> must reject with 409 POS_INTAKE_LOT_EXHAUSTED (no silent substitution!)
    const overSellLot3Res = await app.inject({
      method: 'POST',
      url: '/v1/pos/sales',
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': tenantId,
        'idempotency-key': generateUuidV7(),
      },
      payload: {
        registerId,
        shiftId,
        lines: [
          {
            productId,
            stockIntakeLotId: lot3Id,
            scannedBarcode: 'BC-TEA-LOT3-180',
            quantity: '49.000000',
            uomCode: 'PCS',
            entrySource: 'BARCODE_SCAN',
          },
        ],
        payments: [
          {
            paymentMethod: 'CASH',
            amount: '8820.0000',
            tenderedAmount: '9000.0000',
          },
        ],
      },
    });
    expect(overSellLot3Res.statusCode).toBe(409);
    expect(overSellLot3Res.json().errorCode).toBe('POS_INTAKE_LOT_EXHAUSTED');
  });

  it('2. Resolves TEST-RICE-001 Multi-UoM (base PCS, 1 BAG = 25 PCS) across stock intake, package barcode scanning, POS selling, and 25 PCS inventory deduction', async () => {
    // 1. Create TEST-RICE-001 with baseUom PCS, 1 BAG = 25 PCS, and explicit package selling price LKR 3600 per BAG (vs 150/PCS)
    const createRiceRes = await app.inject({
      method: 'POST',
      url: '/v1/products',
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': tenantId,
        'idempotency-key': generateUuidV7(),
      },
      payload: {
        sku: 'TEST-RICE-001',
        name: 'Samba Rice Premium',
        baseUom: 'PCS',
        purchaseUom: 'BAG',
        priceUom: 'PCS',
        allowedSellingUoms: ['PCS', 'BAG'],
        purchaseCost: '100.0000',
        sellingPrice: '150.0000',
        trackInventory: true,
        trackingMode: 'NONE',
        primaryBarcode: 'BC-RICE-PCS',
        unitConversions: [
          {
            uomCode: 'BAG',
            uomName: 'Bag of 25 PCS',
            conversionFactorToBase: '25.000000',
            sellingPrice: '3600.0000',
            isDefaultPurchasing: true,
            isDefaultSelling: true,
          },
        ],
      },
    });
    expect(createRiceRes.statusCode).toBe(201);
    const rice = createRiceRes.json();
    const riceId = rice.id as string;
    expect(rice.allowedSellingUoms).toEqual(expect.arrayContaining(['PCS', 'BAG']));
    expect(rice.unitConversions[0].uomCode).toBe('BAG');
    expect(rice.unitConversions[0].conversionFactorToBase).toBe('25.000000');
    expect(rice.unitConversions[0].sellingPrice).toBe('3600.0000');

    // 2. Receive 4 BAG (= 100 PCS) into stock
    const moveRiceRes = await app.inject({
      method: 'POST',
      url: '/v1/inventory/movements',
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': tenantId,
        'idempotency-key': generateUuidV7(),
      },
      payload: {
        branchId,
        warehouseId,
        productId: riceId,
        movementType: 'STOCK_IN',
        quantity: '4.000000',
        uomCode: 'BAG',
        unitCost: '100.0000',
        reason: 'Received 4 Bags (100 PCS)',
      },
    });
    expect(moveRiceRes.statusCode).toBe(201);
    expect(moveRiceRes.json().qtyDelta).toBe('100.000000');
    expect(moveRiceRes.json().balanceAfter).toBe('100.000000');
    const riceIntakeLotId = moveRiceRes.json().stockIntakeLotId as string;

    // 3. Register a package barcode for BAG (`BC-RICE-BAG-25`)
    const bagBcRes = await app.inject({
      method: 'POST',
      url: `/v1/products/${riceId}/barcodes`,
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': tenantId,
      },
      payload: {
        barcode: 'BC-RICE-BAG-25',
        symbology: 'CODE128',
        uomCode: 'BAG',
        priceSourceMode: 'PACKAGE_EXPLICIT',
        isPrimary: false,
        isActive: true,
      },
    });
    expect(bagBcRes.statusCode).toBe(201);
    expect(bagBcRes.json().uomCode).toBe('BAG');
    expect(bagBcRes.json().conversionFactorToBase).toBe('25.000000');
    expect(bagBcRes.json().effectiveSellingPrice).toBe('3600.0000');

    // 4. Scan BC-RICE-BAG-25 in POS barcode resolver -> resolves selling UoM = BAG, factor = 25, price = 3600.0000
    const resolveBagRes = await app.inject({
      method: 'POST',
      url: '/v1/barcodes/resolve',
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': tenantId,
      },
      payload: {
        rawBarcode: 'BC-RICE-BAG-25',
        branchId,
        warehouseId,
      },
    });
    expect(resolveBagRes.statusCode).toBe(200);
    const resolvedBag = resolveBagRes.json();
    expect(resolvedBag.resolvedSellingUom).toBe('BAG');
    expect(resolvedBag.resolvedConversionFactorToBase).toBe('25.000000');
    expect(resolvedBag.effectiveUnitPrice).toBe('3600.0000');

    // 5. Checkout 1 BAG + 5 PCS of TEST-RICE-001 in POS
    // 1 BAG @ 3600.0000 + 5 PCS @ 150.0000 = 3600 + 750 = 4350.0000
    // Total base inventory deduction = 25 PCS + 5 PCS = 30 PCS (remaining = 70 PCS)
    const riceSaleRes = await app.inject({
      method: 'POST',
      url: '/v1/pos/sales',
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': tenantId,
        'idempotency-key': generateUuidV7(),
      },
      payload: {
        registerId,
        shiftId,
        lines: [
          {
            productId: riceId,
            scannedBarcode: 'BC-RICE-BAG-25',
            quantity: '1.000000',
            uomCode: 'BAG',
            entrySource: 'BARCODE_SCAN',
          },
          {
            productId: riceId,
            scannedBarcode: 'BC-RICE-PCS',
            quantity: '5.000000',
            uomCode: 'PCS',
            entrySource: 'BARCODE_SCAN',
          },
        ],
        payments: [
          {
            paymentMethod: 'CASH',
            amount: '4350.0000',
            tenderedAmount: '5000.0000',
          },
        ],
      },
    });
    expect(riceSaleRes.statusCode).toBe(201);
    const riceSale = riceSaleRes.json();
    expect(riceSale.grandTotal).toBe('4350.0000');
    expect(riceSale.lines[0].uomCode).toBe('BAG');
    expect(riceSale.lines[0].quantity).toBe('1.000000');
    expect(riceSale.lines[0].conversionFactorToBase).toBe('25.000000');
    expect(riceSale.lines[0].normalizedBaseQty).toBe('25.000000');
    expect(riceSale.lines[0].unitPrice).toBe('3600.0000');
    expect(riceSale.lines[1].uomCode).toBe('PCS');
    expect(riceSale.lines[1].quantity).toBe('5.000000');
    expect(riceSale.lines[1].normalizedBaseQty).toBe('5.000000');
    expect(riceSale.lines[1].unitPrice).toBe('150.0000');

    // 6. Verify warehouse balance is now exactly 70.000000 PCS (100 - 25 - 5) and intake lot remaining is 70.000000 PCS
    const balRes = await app.inject({
      method: 'GET',
      url: `/v1/inventory/balances?warehouseId=${warehouseId}&productId=${riceId}`,
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': tenantId,
      },
    });
    expect(balRes.statusCode).toBe(200);
    const balItems = balRes.json().data ?? balRes.json();
    expect(balItems[0].qtyOnHand).toBe('70.000000');

    const riceLotsRes = await app.inject({
      method: 'GET',
      url: `/v1/inventory/intake-lots?productId=${riceId}`,
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': tenantId,
      },
    });
    expect(riceLotsRes.statusCode).toBe(200);
    expect(riceLotsRes.json().find((l: { id: string }) => l.id === riceIntakeLotId).baseQtyRemaining).toBe('70.000000');

    // 7. Verify Offline Sync Catalog Pricing Snapshot includes intakeLots, extended barcodes, and package sellingPrice
    const syncSnapRes = await app.inject({
      method: 'GET',
      url: `/v1/sync/catalog-pricing?branchId=${branchId}`,
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': tenantId,
      },
    });
    expect(syncSnapRes.statusCode).toBe(200);
    const snap = syncSnapRes.json();
    expect(Array.isArray(snap.intakeLots)).toBe(true);
    expect(snap.intakeLots.some((l: { id: string }) => l.id === riceIntakeLotId)).toBe(true);
    expect(
      snap.barcodes.some(
        (b: { barcode: string; uomCode: string }) =>
          b.barcode === 'BC-RICE-BAG-25' && b.uomCode === 'BAG',
      ),
    ).toBe(true);
    expect(
      snap.unitConversions.some(
        (u: { productId: string; uomCode: string; sellingPrice: string }) =>
          u.productId === riceId && u.uomCode === 'BAG' && u.sellingPrice === '3600.0000',
      ),
    ).toBe(true);
  });
});

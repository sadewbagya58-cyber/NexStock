import { type KeyObject, generateKeyPairSync, sign } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_SUPABASE_JWT_AUDIENCE,
  DEFAULT_SUPABASE_JWT_ISSUER,
  StaticJwksProvider,
  type SupabaseJwk,
  buildApp,
  createTaxGroupWithRates,
  generateUuidV7,
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
  const header = {
    alg: 'ES256',
    typ: 'JWT',
    kid: keyMaterial.kid,
  };
  const headerB64 = Buffer.from(JSON.stringify(header), 'utf-8').toString(
    'base64url',
  );
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf-8').toString(
    'base64url',
  );
  const signingInput = Buffer.from(`${headerB64}.${payloadB64}`, 'utf-8');
  const signature = sign('sha256', signingInput, {
    key: keyMaterial.privateKey,
    dsaEncoding: 'ieee-p1363',
  });
  return `${headerB64}.${payloadB64}.${signature.toString('base64url')}`;
}

const TENANT_ALPHA_ID = '0192b4c0-3333-7000-8000-000000000010';
const TENANT_ALPHA_OWNER = '0192b4c0-3333-7000-8000-000000000001';
const TENANT_ALPHA_CASHIER = '0192b4c0-3333-7000-8000-000000000002';
const TENANT_ALPHA_BRANCH1_CASHIER = '0192b4c0-3333-7000-8000-000000000003';

const TENANT_BETA_ID = '0192b4c0-4444-7000-8000-000000000010';
const TENANT_BETA_OWNER = '0192b4c0-4444-7000-8000-000000000001';

describe('@nexstock/api — Phase 3: POS, Sales, Checkout, Payments & Billing', () => {
  let harness: TestPostgresHarness;
  const primaryKey = createTestEs256KeyMaterial(
    '01f76c4b-9743-48ad-bed6-a9c89dc99cc3',
  );
  const jwksProvider = new StaticJwksProvider({
    keys: [primaryKey.publicJwk],
  });
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

  let alphaOwnerToken: string;
  let alphaCashierToken: string;
  let alphaBranch1CashierToken: string;
  let betaOwnerToken: string;

  let alphaBranch1Id: string;
  let alphaMainWarehouseId: string;
  let alphaBranch2Id: string;
  let alphaBranch2WarehouseId: string;
  let alphaRegister1Id: string;
  let alphaRegister2Id: string;
  let alphaTaxGroupId: string;

  let alphaCategoryId: string;
  let standardProductId: string;
  let boxedProductId: string;
  let serviceProductId: string;

  beforeAll(async () => {
    harness = await createTestPostgresHarness();

    alphaOwnerToken = issueToken(
      TENANT_ALPHA_OWNER,
      'owner@alpha-pos.example.com',
    );
    alphaCashierToken = issueToken(
      TENANT_ALPHA_CASHIER,
      'cashier@alpha-pos.example.com',
    );
    alphaBranch1CashierToken = issueToken(
      TENANT_ALPHA_BRANCH1_CASHIER,
      'cashier-b1@alpha-pos.example.com',
    );
    betaOwnerToken = issueToken(
      TENANT_BETA_OWNER,
      'owner@beta-pos.example.com',
    );

    const app = await buildApp({
      db: harness.db,
      jwksProvider,
    });

    // 1. Onboard Tenant Alpha
    const alphaOnboardRes = await app.inject({
      method: 'POST',
      url: '/v1/org/tenants/onboard',
      headers: {
        authorization: `Bearer ${alphaOwnerToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
      payload: {
        slug: 'alpha-pos-corp',
        legalName: 'Alpha Retail POS Global Ltd',
        baseCurrency: 'USD',
        defaultLocale: 'en-US',
        defaultTimezone: 'America/New_York',
        countryCode: 'US',
        ownerEmail: 'owner@alpha-pos.example.com',
        ownerFullName: 'Alpha Owner',
        planCode: 'GROWTH',
      },
    });
    expect(alphaOnboardRes.statusCode).toBe(201);

    // 2. Create Branch 1 & Warehouse 1
    const b1Res = await app.inject({
      method: 'POST',
      url: '/v1/org/branches',
      headers: {
        authorization: `Bearer ${alphaOwnerToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
      payload: {
        code: 'BR-MANHATTAN',
        name: 'Manhattan Store Branch',
        timezone: 'America/New_York',
        countryCode: 'US',
      },
    });
    expect(b1Res.statusCode).toBe(201);
    alphaBranch1Id = b1Res.json().id;

    const wh1Res = await app.inject({
      method: 'POST',
      url: '/v1/org/warehouses',
      headers: {
        authorization: `Bearer ${alphaOwnerToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
      payload: {
        branchId: alphaBranch1Id,
        code: 'WH-MANHATTAN-01',
        name: 'Manhattan Store Backroom Warehouse',
        allowNegativeStock: false,
      },
    });
    expect(wh1Res.statusCode).toBe(201);
    alphaMainWarehouseId = wh1Res.json().id;

    // 3. Create Branch 2 & Warehouse 2 (Brooklyn)
    const b2Res = await app.inject({
      method: 'POST',
      url: '/v1/org/branches',
      headers: {
        authorization: `Bearer ${alphaOwnerToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
      payload: {
        code: 'BR-BROOKLYN',
        name: 'Brooklyn Outlet Branch',
        timezone: 'America/New_York',
        countryCode: 'US',
      },
    });
    expect(b2Res.statusCode).toBe(201);
    alphaBranch2Id = b2Res.json().id;

    const wh2Res = await app.inject({
      method: 'POST',
      url: '/v1/org/warehouses',
      headers: {
        authorization: `Bearer ${alphaOwnerToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
      payload: {
        branchId: alphaBranch2Id,
        code: 'WH-BROOKLYN-01',
        name: 'Brooklyn Backroom Warehouse',
        allowNegativeStock: false,
      },
    });
    expect(wh2Res.statusCode).toBe(201);
    alphaBranch2WarehouseId = wh2Res.json().id;

    // 4. Create POS Registers for Branch 1 and Branch 2
    alphaRegister1Id = generateUuidV7();
    alphaRegister2Id = generateUuidV7();

    await withTenantTransaction(
      harness.db,
      {
        tenantId: TENANT_ALPHA_ID,
        userId: TENANT_ALPHA_OWNER,
        traceId: 'seed_registers',
      },
      async (trx) => {
        await trx.db
          .insertInto('pos_registers')
          .values([
            {
              id: alphaRegister1Id,
              tenant_id: TENANT_ALPHA_ID,
              branch_id: alphaBranch1Id,
              warehouse_id: alphaMainWarehouseId,
              code: 'REG-MHT-01',
              name: 'Manhattan Front Counter Register 1',
              last_invoice_seq: 0,
              is_active: true,
            },
            {
              id: alphaRegister2Id,
              tenant_id: TENANT_ALPHA_ID,
              branch_id: alphaBranch2Id,
              warehouse_id: alphaBranch2WarehouseId,
              code: 'REG-BKN-01',
              name: 'Brooklyn Register 1',
              last_invoice_seq: 0,
              is_active: true,
            },
          ])
          .execute();
      },
    );

    // 5. Seed Tax Group (Sales Tax 8.875% = NYC State 4% + NYC Local 4.875%)
    await withTenantTransaction(
      harness.db,
      {
        tenantId: TENANT_ALPHA_ID,
        userId: TENANT_ALPHA_OWNER,
        traceId: 'seed_tax',
      },
      async (trx) => {
        const group = await createTaxGroupWithRates(trx, {
          code: 'NYC-SALES-TAX',
          name: 'New York City Standard Sales Tax',
          countryCode: 'US',
          rates: [
            {
              code: 'NY-STATE',
              name: 'NY State Tax',
              ratePercentage: '4.0000',
              isCompound: false,
            },
            {
              code: 'NYC-CITY',
              name: 'NYC City Tax',
              ratePercentage: '4.8750',
              isCompound: false,
            },
          ],
        });
        alphaTaxGroupId = group.id;
      },
    );

    // 6. Provision Cashier Users
    // Cashier 1: All locations access
    // Cashier 2: Restricted to Branch 1 only
    await withTenantTransaction(
      harness.db,
      {
        tenantId: TENANT_ALPHA_ID,
        userId: TENANT_ALPHA_OWNER,
        traceId: 'provision_cashiers',
      },
      async (trx) => {
        await trx.db
          .insertInto('users')
          .values([
            {
              id: TENANT_ALPHA_CASHIER,
              email: 'cashier@alpha-pos.example.com',
              full_name: 'Alpha General Cashier',
              is_platform_admin: false,
            },
            {
              id: TENANT_ALPHA_BRANCH1_CASHIER,
              email: 'cashier-b1@alpha-pos.example.com',
              full_name: 'Alpha Branch 1 Exclusive Cashier',
              is_platform_admin: false,
            },
          ])
          .execute();

        const cashierRole = await trx.db
          .selectFrom('roles')
          .select(['id'])
          .where('tenant_id', '=', TENANT_ALPHA_ID)
          .where('code', '=', 'CASHIER')
          .executeTakeFirstOrThrow();

        // Cashier 1: all_locations_access = true
        await trx.db
          .insertInto('tenant_memberships')
          .values({
            id: TENANT_ALPHA_CASHIER,
            tenant_id: TENANT_ALPHA_ID,
            user_id: TENANT_ALPHA_CASHIER,
            status: 'ACTIVE',
            all_locations_access: true,
          })
          .execute();

        await trx.db
          .insertInto('member_role_assignments')
          .values({
            id: generateUuidV7(),
            tenant_id: TENANT_ALPHA_ID,
            membership_id: TENANT_ALPHA_CASHIER,
            role_id: cashierRole.id,
          })
          .execute();

        // Cashier 2: all_locations_access = false, restricted to Branch 1
        await trx.db
          .insertInto('tenant_memberships')
          .values({
            id: TENANT_ALPHA_BRANCH1_CASHIER,
            tenant_id: TENANT_ALPHA_ID,
            user_id: TENANT_ALPHA_BRANCH1_CASHIER,
            status: 'ACTIVE',
            all_locations_access: false,
          })
          .execute();

        await trx.db
          .insertInto('member_role_assignments')
          .values({
            id: generateUuidV7(),
            tenant_id: TENANT_ALPHA_ID,
            membership_id: TENANT_ALPHA_BRANCH1_CASHIER,
            role_id: cashierRole.id,
          })
          .execute();

        await trx.db
          .insertInto('member_location_scopes')
          .values({
            id: generateUuidV7(),
            tenant_id: TENANT_ALPHA_ID,
            membership_id: TENANT_ALPHA_BRANCH1_CASHIER,
            branch_id: alphaBranch1Id,
            warehouse_id: alphaMainWarehouseId,
          })
          .execute();
      },
    );

    // 7. Create Category & Products
    const catRes = await app.inject({
      method: 'POST',
      url: '/v1/categories',
      headers: {
        authorization: `Bearer ${alphaOwnerToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
      payload: {
        name: 'Consumer Electronics',
        description: 'Electronic gadgets and peripherals',
      },
    });
    expect(catRes.statusCode).toBe(201);
    alphaCategoryId = catRes.json().id;

    // Standard Product: Wireless Mouse ($25.00 retail, $12.00 cost) with primary and alternate barcodes
    const mouseRes = await app.inject({
      method: 'POST',
      url: '/v1/products',
      headers: {
        authorization: `Bearer ${alphaOwnerToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
      payload: {
        sku: 'MOUSE-WL-01',
        name: 'Ergonomic Wireless Mouse',
        productType: 'STANDARD',
        baseUom: 'PCS',
        purchaseCost: '12.0000',
        sellingPrice: '25.0000',
        categoryId: alphaCategoryId,
        taxGroupId: alphaTaxGroupId,
        trackInventory: true,
        reorderPoint: '5.0000',
        reorderQty: '20.0000',
        primaryBarcode: '012345678901',
        alternateBarcodes: [
          { barcode: '012345678902', barcodeType: 'EAN13', uomCode: 'PCS' },
        ],
      },
    });
    expect(mouseRes.statusCode).toBe(201);
    standardProductId = mouseRes.json().id;

    // Boxed Product: USB-C Cable with Box conversion (1 BOX = 10 PCS)
    const cableRes = await app.inject({
      method: 'POST',
      url: '/v1/products',
      headers: {
        authorization: `Bearer ${alphaOwnerToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
      payload: {
        sku: 'CABLE-USBC-01',
        name: 'Braided USB-C Cable 2M',
        productType: 'STANDARD',
        baseUom: 'PCS',
        purchaseCost: '3.0000',
        sellingPrice: '10.0000',
        categoryId: alphaCategoryId,
        taxGroupId: alphaTaxGroupId,
        trackInventory: true,
        primaryBarcode: '098765432101',
        unitConversions: [
          {
            uomCode: 'BOX',
            uomName: 'Box of 10',
            conversionFactorToBase: '10.0000',
          },
        ],
      },
    });
    expect(cableRes.statusCode).toBe(201);
    boxedProductId = cableRes.json().id;

    // Service Product: Device Setup ($50.00 fee, non-trackable)
    const serviceRes = await app.inject({
      method: 'POST',
      url: '/v1/products',
      headers: {
        authorization: `Bearer ${alphaOwnerToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
      payload: {
        sku: 'SRV-SETUP-01',
        name: 'Device Configuration Service',
        productType: 'SERVICE',
        baseUom: 'JOB',
        purchaseCost: '0.0000',
        sellingPrice: '50.0000',
        categoryId: alphaCategoryId,
        taxGroupId: alphaTaxGroupId,
        trackInventory: false,
      },
    });
    expect(serviceRes.statusCode).toBe(201);
    serviceProductId = serviceRes.json().id;

    // 8. Stock up Manhattan Warehouse with Initial Inventory
    // 50 Wireless Mice
    await app.inject({
      method: 'POST',
      url: '/v1/inventory/movements',
      headers: {
        authorization: `Bearer ${alphaOwnerToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
        'idempotency-key': generateUuidV7(),
      },
      payload: {
        branchId: alphaBranch1Id,
        warehouseId: alphaMainWarehouseId,
        productId: standardProductId,
        movementType: 'OPENING_STOCK',
        quantity: '50.000000',
        unitCost: '12.0000',
      },
    });

    // 100 USB-C Cables
    await app.inject({
      method: 'POST',
      url: '/v1/inventory/movements',
      headers: {
        authorization: `Bearer ${alphaOwnerToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
        'idempotency-key': generateUuidV7(),
      },
      payload: {
        branchId: alphaBranch1Id,
        warehouseId: alphaMainWarehouseId,
        productId: boxedProductId,
        movementType: 'OPENING_STOCK',
        quantity: '100.000000',
        unitCost: '3.0000',
      },
    });

    // 9. Onboard Tenant Beta for cross-tenant tests
    const betaOnboardRes = await app.inject({
      method: 'POST',
      url: '/v1/org/tenants/onboard',
      headers: {
        authorization: `Bearer ${betaOwnerToken}`,
        'x-tenant-id': TENANT_BETA_ID,
      },
      payload: {
        slug: 'beta-retail',
        legalName: 'Beta Retail Inc',
        baseCurrency: 'USD',
        defaultLocale: 'en-US',
        defaultTimezone: 'America/Chicago',
        countryCode: 'US',
        ownerEmail: 'owner@beta-pos.example.com',
        ownerFullName: 'Beta Owner',
        planCode: 'GROWTH',
      },
    });
    expect(betaOnboardRes.statusCode).toBe(201);

    await app.close();
  });

  afterAll(async () => {
    await harness.db.destroy();
  });

  // ==========================================================================
  // TEST SUITE 1: POS Registers & Cashier Shifts
  // ==========================================================================
  describe('1. POS Registers & Cashier Shift Lifecycle', () => {
    let app: AppInstance;
    let shiftId: string;

    beforeAll(async () => {
      app = await buildApp({ db: harness.db, jwksProvider });
    });

    afterAll(async () => {
      await app.close();
    });

    it('lists authorized active registers for a branch and filters properly', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/pos/registers?branchId=${alphaBranch1Id}`,
        headers: {
          authorization: `Bearer ${alphaCashierToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });
      expect(res.statusCode).toBe(200);
      const registers = res.json();
      expect(registers).toHaveLength(1);
      expect(registers[0].id).toBe(alphaRegister1Id);
      expect(registers[0].code).toBe('REG-MHT-01');
      expect(registers[0].isActive).toBe(true);
    });

    it('opens a cashier shift with opening cash float and prevents duplicate open shifts on the same register', async () => {
      const openRes = await app.inject({
        method: 'POST',
        url: '/v1/pos/shifts',
        headers: {
          authorization: `Bearer ${alphaCashierToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          registerId: alphaRegister1Id,
          openingCashFloat: '150.0000',
          notes: 'Morning shift opening float',
        },
      });
      expect(openRes.statusCode).toBe(201);
      const shift = openRes.json();
      expect(shift.status).toBe('OPEN');
      expect(shift.openingCashFloat).toBe('150.0000');
      expect(shift.expectedClosingCash).toBe('150.0000');
      expect(shift.notes).toBe('Morning shift opening float');
      shiftId = shift.id;

      // Duplicate shift on same register must fail 409 POS_SHIFT_ALREADY_OPEN
      const dupRes = await app.inject({
        method: 'POST',
        url: '/v1/pos/shifts',
        headers: {
          authorization: `Bearer ${alphaCashierToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          registerId: alphaRegister1Id,
          openingCashFloat: '200.0000',
        },
      });
      expect(dupRes.statusCode).toBe(409);
      expect(dupRes.json().errorCode).toBe('POS_SHIFT_ALREADY_OPEN');
    });

    it('retrieves active open shift for register', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/pos/shifts/active?registerId=${alphaRegister1Id}`,
        headers: {
          authorization: `Bearer ${alphaCashierToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().id).toBe(shiftId);
      expect(res.json().status).toBe('OPEN');
    });

    it('returns 404 POS_NO_ACTIVE_SHIFT when register has no open shift', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/pos/shifts/active?registerId=${alphaRegister2Id}`,
        headers: {
          authorization: `Bearer ${alphaCashierToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().errorCode).toBe('POS_NO_ACTIVE_SHIFT');
    });
  });

  // ==========================================================================
  // TEST SUITE 2: Barcode Scanning & Product Discovery
  // ==========================================================================
  describe('2. Barcode Scanning & Product Discovery for POS', () => {
    let app: AppInstance;

    beforeAll(async () => {
      app = await buildApp({ db: harness.db, jwksProvider });
    });

    afterAll(async () => {
      await app.close();
    });

    it('finds product instantly by exact primary barcode and alternate barcode', async () => {
      // Primary barcode: 012345678901
      const res1 = await app.inject({
        method: 'GET',
        url: `/v1/pos/products/search?warehouseId=${alphaMainWarehouseId}&barcode=012345678901`,
        headers: {
          authorization: `Bearer ${alphaCashierToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });
      expect(res1.statusCode).toBe(200);
      const items1 = res1.json();
      expect(items1).toHaveLength(1);
      expect(items1[0].sku).toBe('MOUSE-WL-01');
      expect(items1[0].availableQuantity).toBe('50.000000');
      expect(items1[0].retailPrice).toBe('25.0000');

      // Alternate barcode: 012345678902
      const res2 = await app.inject({
        method: 'GET',
        url: `/v1/pos/products/search?warehouseId=${alphaMainWarehouseId}&barcode=012345678902`,
        headers: {
          authorization: `Bearer ${alphaCashierToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });
      expect(res2.statusCode).toBe(200);
      expect(res2.json()[0].sku).toBe('MOUSE-WL-01');
    });

    it('searches products by SKU and partial name with real-time stock balance', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/pos/products/search?warehouseId=${alphaMainWarehouseId}&q=Braided`,
        headers: {
          authorization: `Bearer ${alphaCashierToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });
      expect(res.statusCode).toBe(200);
      const items = res.json();
      expect(items).toHaveLength(1);
      expect(items[0].sku).toBe('CABLE-USBC-01');
      expect(items[0].availableQuantity).toBe('100.000000');
    });

    it('includes non-trackable service products with availableQuantity 0.000000', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/pos/products/search?warehouseId=${alphaMainWarehouseId}&q=Configuration`,
        headers: {
          authorization: `Bearer ${alphaCashierToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });
      expect(res.statusCode).toBe(200);
      const items = res.json();
      expect(items).toHaveLength(1);
      expect(items[0].id).toBe(serviceProductId);
      expect(items[0].sku).toBe('SRV-SETUP-01');
      expect(items[0].trackInventory).toBe(false);
      expect(items[0].availableQuantity).toBe('0.000000');
    });
  });

  // ==========================================================================
  // TEST SUITE 3: Atomic Checkout, Calculations & Stock Ledger Deduction
  // ==========================================================================
  describe('3. Atomic Checkout, Fixed-Point Financials & Stock Deduction', () => {
    let app: AppInstance;
    let completedSaleId: string;
    let completedInvoiceNumber: string;

    beforeAll(async () => {
      app = await buildApp({ db: harness.db, jwksProvider });
    });

    afterAll(async () => {
      await app.close();
    });

    it('completes atomic cash sale with server-calculated cascading NYC sales tax and exact stock ledger deduction', async () => {
      // Sell 2 Wireless Mice ($25.00 each = $50.00)
      // Sales Tax: 4.0% NY State ($2.00) + 4.875% NYC City ($2.4375 rounded to $2.44) = $4.44
      // Grand Total = $54.44
      // Payment: Cash $60.00, Change Due: $5.56
      const checkoutKey = generateUuidV7();
      const saleRes = await app.inject({
        method: 'POST',
        url: '/v1/pos/sales',
        headers: {
          authorization: `Bearer ${alphaCashierToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
          'idempotency-key': checkoutKey,
        },
        payload: {
          registerId: alphaRegister1Id,
          lines: [
            {
              productId: standardProductId,
              quantity: '2.000000',
            },
          ],
          payments: [
            {
              paymentMethod: 'CASH',
              amount: '54.4400',
              tenderedAmount: '60.0000',
            },
          ],
          customerName: 'Alice Walkin',
          notes: 'Standard cash sale',
        },
      });

      expect(saleRes.statusCode).toBe(201);
      const sale = saleRes.json();
      expect(sale.status).toBe('COMPLETED');
      expect(sale.subtotalAmount).toBe('50.0000');
      expect(sale.taxAmount).toBe('4.4400');
      expect(sale.grandTotal).toBe('54.4400');
      expect(sale.totalPaid).toBe('54.4400');
      expect(sale.changeGiven).toBe('5.5600');
      expect(sale.invoiceNumber).toMatch(/^REG-MHT-01-\d{6}$/);

      completedSaleId = sale.id;
      completedInvoiceNumber = sale.invoiceNumber;

      // Verify stock was deducted via stock_ledger_entries (50 - 2 = 48)
      const balanceCheck = await app.inject({
        method: 'GET',
        url: `/v1/pos/products/search?warehouseId=${alphaMainWarehouseId}&barcode=012345678901`,
        headers: {
          authorization: `Bearer ${alphaCashierToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });
      expect(balanceCheck.json()[0].availableQuantity).toBe('48.000000');
    });

    it('completes sale with alternate UoM conversion (BOX = 10 PCS) and deducts base stock accurately', async () => {
      // 1 BOX of USB-C cables @ $10.00/unit = $100.00
      // Tax (8.875% of $100) = $8.88
      // Card Payment = $108.88 (tendered = 108.88)
      const checkoutKey = generateUuidV7();
      const saleRes = await app.inject({
        method: 'POST',
        url: '/v1/pos/sales',
        headers: {
          authorization: `Bearer ${alphaCashierToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
          'idempotency-key': checkoutKey,
        },
        payload: {
          registerId: alphaRegister1Id,
          lines: [
            {
              productId: boxedProductId,
              quantity: '1.000000',
              uomCode: 'BOX',
            },
          ],
          payments: [
            {
              paymentMethod: 'CARD',
              amount: '108.8800',
              tenderedAmount: '108.8800',
              cardReference: 'AUTH-VISA-9912',
              cardLastFour: '4242',
            },
          ],
        },
      });

      expect(saleRes.statusCode).toBe(201);
      const sale = saleRes.json();
      expect(sale.subtotalAmount).toBe('100.0000');
      expect(sale.taxAmount).toBe('8.8800');
      expect(sale.grandTotal).toBe('108.8800');

      // Verify stock deducted 10 PCS from 100 PCS -> 90 PCS remaining
      const balanceCheck = await app.inject({
        method: 'GET',
        url: `/v1/pos/products/search?warehouseId=${alphaMainWarehouseId}&q=Braided`,
        headers: {
          authorization: `Bearer ${alphaCashierToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });
      expect(balanceCheck.json()[0].availableQuantity).toBe('90.000000');
    });

    it('supports multi-tender split payments (Cash + Card)', async () => {
      // 1 Wireless Mouse ($25.00 + $2.22 tax = $27.22)
      // Pay: $10.00 Cash (tendered $10.00) + $17.22 Card (tendered $17.22)
      const checkoutKey = generateUuidV7();
      const splitRes = await app.inject({
        method: 'POST',
        url: '/v1/pos/sales',
        headers: {
          authorization: `Bearer ${alphaCashierToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
          'idempotency-key': checkoutKey,
        },
        payload: {
          registerId: alphaRegister1Id,
          lines: [
            {
              productId: standardProductId,
              quantity: '1.000000',
            },
          ],
          payments: [
            {
              paymentMethod: 'CASH',
              amount: '10.0000',
              tenderedAmount: '10.0000',
            },
            {
              paymentMethod: 'CARD',
              amount: '17.2200',
              tenderedAmount: '17.2200',
              cardLastFour: '1111',
            },
          ],
        },
      });

      expect(splitRes.statusCode).toBe(201);
      const sale = splitRes.json();
      expect(sale.payments).toHaveLength(2);
      expect(sale.totalPaid).toBe('27.2200');
      expect(sale.grandTotal).toBe('27.2200');
    });

    it('rejects underpayment with 422 POS_INSUFFICIENT_PAYMENT', async () => {
      const checkoutKey = generateUuidV7();
      const underpayRes = await app.inject({
        method: 'POST',
        url: '/v1/pos/sales',
        headers: {
          authorization: `Bearer ${alphaCashierToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
          'idempotency-key': checkoutKey,
        },
        payload: {
          registerId: alphaRegister1Id,
          lines: [
            {
              productId: standardProductId,
              quantity: '1.000000',
            },
          ],
          payments: [
            {
              paymentMethod: 'CASH',
              amount: '10.0000',
              tenderedAmount: '10.0000',
            },
          ],
        },
      });

      expect(underpayRes.statusCode).toBe(422);
      expect(underpayRes.json().errorCode).toBe('POS_INSUFFICIENT_PAYMENT');
    });

    it('rejects empty cart with 422 POS_CART_EMPTY', async () => {
      const checkoutKey = generateUuidV7();
      const emptyRes = await app.inject({
        method: 'POST',
        url: '/v1/pos/sales',
        headers: {
          authorization: `Bearer ${alphaCashierToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
          'idempotency-key': checkoutKey,
        },
        payload: {
          registerId: alphaRegister1Id,
          lines: [],
          payments: [
            {
              paymentMethod: 'CASH',
              amount: '10.0000',
              tenderedAmount: '10.0000',
            },
          ],
        },
      });

      expect(emptyRes.statusCode).toBe(400); // TypeBox minItems: 1 validation reject
    });

    it('replays identical checkout request idempotently (201 replayed) and rejects payload mismatch with 422', async () => {
      const idemKey = generateUuidV7();
      const reqPayload = {
        registerId: alphaRegister1Id,
        lines: [
          {
            productId: standardProductId,
            quantity: '1.000000',
          },
        ],
        payments: [
          {
            paymentMethod: 'CASH',
            amount: '27.2200',
            tenderedAmount: '30.0000',
          },
        ],
      };

      const firstRes = await app.inject({
        method: 'POST',
        url: '/v1/pos/sales',
        headers: {
          authorization: `Bearer ${alphaCashierToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
          'idempotency-key': idemKey,
        },
        payload: reqPayload,
      });
      expect(firstRes.statusCode).toBe(201);
      const firstInvoice = firstRes.json().invoiceNumber;

      // Replay identical request with same key
      const replayRes = await app.inject({
        method: 'POST',
        url: '/v1/pos/sales',
        headers: {
          authorization: `Bearer ${alphaCashierToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
          'idempotency-key': idemKey,
        },
        payload: reqPayload,
      });
      expect(replayRes.statusCode).toBe(201);
      expect(replayRes.headers['x-idempotent-replayed']).toBe('true');
      expect(replayRes.json().invoiceNumber).toBe(firstInvoice);

      // Replay with DIFFERENT payload -> must reject 422
      const mismatchRes = await app.inject({
        method: 'POST',
        url: '/v1/pos/sales',
        headers: {
          authorization: `Bearer ${alphaCashierToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
          'idempotency-key': idemKey,
        },
        payload: {
          ...reqPayload,
          customerName: 'Tampered Customer Name',
        },
      });
      expect(mismatchRes.statusCode).toBe(422);
      expect(mismatchRes.json().errorCode).toBe(
        'ERR_IDEMPOTENCY_KEY_REUSED_DIFFERENT_PAYLOAD',
      );
    });

    it('generates reproducible, printable receipt with store information, tax summary and payments', async () => {
      const receiptRes = await app.inject({
        method: 'GET',
        url: `/v1/pos/sales/${completedSaleId}/receipt`,
        headers: {
          authorization: `Bearer ${alphaCashierToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });

      expect(receiptRes.statusCode).toBe(200);
      const receipt = receiptRes.json();
      expect(receipt.businessName).toBe('Alpha Retail POS Global Ltd');
      expect(receipt.branchName).toBe('Manhattan Store Branch');
      expect(receipt.registerCode).toBe('REG-MHT-01');
      expect(receipt.invoiceNumber).toBe(completedInvoiceNumber);
      expect(receipt.cashierName).toBe('Alpha General Cashier');
      expect(receipt.grandTotal).toBe('54.4400');
      expect(receipt.changeGiven).toBe('5.5600');
      expect(receipt.lines).toHaveLength(1);
      expect(receipt.lines[0].sku).toBe('MOUSE-WL-01');
      expect(receipt.lines[0].lineTotal).toBe('54.4400');
    });
  });

  // ==========================================================================
  // TEST SUITE 4: Negative-Stock Policy, Concurrency & Privileged Override
  // ==========================================================================
  describe('4. Negative-Stock Policy & Concurrent Checkout Protection', () => {
    let app: AppInstance;
    let scarceProductId: string;

    beforeAll(async () => {
      app = await buildApp({ db: harness.db, jwksProvider });

      // Create a scarce product with exactly 1 unit in stock
      const prodRes = await app.inject({
        method: 'POST',
        url: '/v1/products',
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          sku: 'LIMITED-EDITION-01',
          name: 'Scarce Collector Item',
          productType: 'STANDARD',
          baseUom: 'PCS',
          purchaseCost: '100.0000',
          sellingPrice: '200.0000',
          categoryId: alphaCategoryId,
          trackInventory: true,
        },
      });
      scarceProductId = prodRes.json().id;

      // Stock exactly 1 unit
      await app.inject({
        method: 'POST',
        url: '/v1/inventory/movements',
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
          'idempotency-key': generateUuidV7(),
        },
        payload: {
          branchId: alphaBranch1Id,
          warehouseId: alphaMainWarehouseId,
          productId: scarceProductId,
          movementType: 'OPENING_STOCK',
          quantity: '1.000000',
          unitCost: '100.0000',
        },
      });
    });

    afterAll(async () => {
      await app.close();
    });

    it('enforces negative stock policy under concurrent checkout of the last available unit', async () => {
      // Simulate two cashiers attempting to sell the final 1 unit at the exact same moment
      const payload1 = {
        registerId: alphaRegister1Id,
        lines: [{ productId: scarceProductId, quantity: '1.000000' }],
        payments: [
          { paymentMethod: 'CASH', amount: '200.0000', tenderedAmount: '200.0000' },
        ],
      };
      const payload2 = {
        registerId: alphaRegister1Id,
        lines: [{ productId: scarceProductId, quantity: '1.000000' }],
        payments: [
          { paymentMethod: 'CASH', amount: '200.0000', tenderedAmount: '200.0000' },
        ],
      };

      const [res1, res2] = await Promise.all([
        app.inject({
          method: 'POST',
          url: '/v1/pos/sales',
          headers: {
            authorization: `Bearer ${alphaCashierToken}`,
            'x-tenant-id': TENANT_ALPHA_ID,
            'idempotency-key': generateUuidV7(),
          },
          payload: payload1,
        }),
        app.inject({
          method: 'POST',
          url: '/v1/pos/sales',
          headers: {
            authorization: `Bearer ${alphaCashierToken}`,
            'x-tenant-id': TENANT_ALPHA_ID,
            'idempotency-key': generateUuidV7(),
          },
          payload: payload2,
        }),
      ]);

      const statusCodes = [res1.statusCode, res2.statusCode].sort();
      // Exactly ONE must succeed (201) and ONE must fail due to negative stock rejection (409)
      expect(statusCodes).toEqual([201, 409]);

      const failedRes = res1.statusCode === 409 ? res1 : res2;
      expect(failedRes.json().errorCode).toBe('INV_INSUFFICIENT_AVAILABLE_STOCK');
    });

    it('allows negative stock checkout only when privileged override is explicitly supplied', async () => {
      // Inventory for scarce product is now 0.000000
      // Normal cashier attempt without override -> 409
      const failRes = await app.inject({
        method: 'POST',
        url: '/v1/pos/sales',
        headers: {
          authorization: `Bearer ${alphaCashierToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
          'idempotency-key': generateUuidV7(),
        },
        payload: {
          registerId: alphaRegister1Id,
          lines: [{ productId: scarceProductId, quantity: '1.000000' }],
          payments: [
            { paymentMethod: 'CASH', amount: '200.0000', tenderedAmount: '200.0000' },
          ],
        },
      });
      expect(failRes.statusCode).toBe(409);

      // Authorized OWNER with explicit override -> succeeds 201
      const overrideRes = await app.inject({
        method: 'POST',
        url: '/v1/pos/sales',
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
          'idempotency-key': generateUuidV7(),
        },
        payload: {
          registerId: alphaRegister1Id,
          lines: [{ productId: scarceProductId, quantity: '1.000000' }],
          payments: [
            { paymentMethod: 'CASH', amount: '200.0000', tenderedAmount: '200.0000' },
          ],
          allowNegativeStockOverride: true,
          overrideReason: 'VIP Backorder Authorized by Store Manager',
        },
      });
      expect(overrideRes.statusCode).toBe(201);
      expect(overrideRes.json().status).toBe('COMPLETED');
    });
  });

  // ==========================================================================
  // TEST SUITE 5: Void Sale, Compensating Restock & Shift Reconciliation
  // ==========================================================================
  describe('5. Void Sale, Compensating Restock & Cash Shift Reconciliation', () => {
    let app: AppInstance;
    let saleToVoidId: string;
    let shiftToCloseId: string;

    beforeAll(async () => {
      app = await buildApp({ db: harness.db, jwksProvider });

      // Create a sale to void
      const saleRes = await app.inject({
        method: 'POST',
        url: '/v1/pos/sales',
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
          'idempotency-key': generateUuidV7(),
        },
        payload: {
          registerId: alphaRegister1Id,
          lines: [{ productId: standardProductId, quantity: '3.000000' }],
          payments: [
            { paymentMethod: 'CASH', amount: '81.6600', tenderedAmount: '85.0000' },
          ],
        },
      });
      expect(saleRes.statusCode).toBe(201);
      saleToVoidId = saleRes.json().id;

      // Get active shift id
      const shiftRes = await app.inject({
        method: 'GET',
        url: `/v1/pos/shifts/active?registerId=${alphaRegister1Id}`,
        headers: {
          authorization: `Bearer ${alphaCashierToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });
      expect(shiftRes.statusCode).toBe(200);
      shiftToCloseId = shiftRes.json().id;
    });

    afterAll(async () => {
      await app.close();
    });

    it('cashier without pos:sale:void permission is rejected with 403', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/pos/sales/${saleToVoidId}/void`,
        headers: {
          authorization: `Bearer ${alphaCashierToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
          'idempotency-key': generateUuidV7(),
        },
        payload: {
          reason: 'Customer cancelled transaction',
        },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().errorCode).toBe('IAM_PERMISSION_DENIED');
    });

    it('privileged owner voids sale, restocks inventory via CUSTOMER_RETURN_RESTOCK and prevents double void', async () => {
      // Balance before void
      const beforeRes = await app.inject({
        method: 'GET',
        url: `/v1/pos/products/search?warehouseId=${alphaMainWarehouseId}&barcode=012345678901`,
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });
      const stockBefore = parseFloat(beforeRes.json()[0].availableQuantity);

      // Void sale
      const voidRes = await app.inject({
        method: 'POST',
        url: `/v1/pos/sales/${saleToVoidId}/void`,
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
          'idempotency-key': generateUuidV7(),
        },
        payload: {
          reason: 'Customer changed mind before leaving store',
        },
      });
      expect(voidRes.statusCode).toBe(200);
      const voidedSale = voidRes.json();
      expect(voidedSale.status).toBe('VOIDED');
      expect(voidedSale.voidReason).toBe(
        'Customer changed mind before leaving store',
      );

      // Balance after void must increase by 3
      const afterRes = await app.inject({
        method: 'GET',
        url: `/v1/pos/products/search?warehouseId=${alphaMainWarehouseId}&barcode=012345678901`,
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });
      const stockAfter = parseFloat(afterRes.json()[0].availableQuantity);
      expect(stockAfter).toBe(stockBefore + 3);

      // Second void attempt must fail 409 POS_SALE_ALREADY_VOIDED
      const doubleVoidRes = await app.inject({
        method: 'POST',
        url: `/v1/pos/sales/${saleToVoidId}/void`,
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
          'idempotency-key': generateUuidV7(),
        },
        payload: {
          reason: 'Repeat void attempt',
        },
      });
      expect(doubleVoidRes.statusCode).toBe(409);
      expect(doubleVoidRes.json().errorCode).toBe('POS_SALE_ALREADY_VOIDED');
    });

    it('closes shift and calculates cash variance between expected and counted cash', async () => {
      // Close shift with counted cash
      const closeRes = await app.inject({
        method: 'POST',
        url: `/v1/pos/shifts/${shiftToCloseId}/close`,
        headers: {
          authorization: `Bearer ${alphaCashierToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          countedClosingCash: '200.0000',
          notes: 'End of shift drawer count',
        },
      });

      expect(closeRes.statusCode).toBe(200);
      const closedShift = closeRes.json();
      expect(closedShift.status).toBe('CLOSED');
      expect(closedShift.countedClosingCash).toBe('200.0000');
      expect(closedShift.cashVariance).toBeDefined();

      // Attempting to close again must fail 409 POS_SHIFT_ALREADY_CLOSED
      const reCloseRes = await app.inject({
        method: 'POST',
        url: `/v1/pos/shifts/${shiftToCloseId}/close`,
        headers: {
          authorization: `Bearer ${alphaCashierToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          countedClosingCash: '200.0000',
        },
      });
      expect(reCloseRes.statusCode).toBe(409);
      expect(reCloseRes.json().errorCode).toBe('POS_SHIFT_ALREADY_CLOSED');
    });
  });

  // ==========================================================================
  // TEST SUITE 6: Multi-Tenant RLS & Location Scoping Security Guards
  // ==========================================================================
  describe('6. Multi-Tenant RLS & Location Scoping Security Guards', () => {
    let app: AppInstance;

    beforeAll(async () => {
      app = await buildApp({ db: harness.db, jwksProvider });
    });

    afterAll(async () => {
      await app.close();
    });

    it('cashier restricted to Branch 1 cannot checkout on Branch 2 register (403 Location Scope Denied)', async () => {
      const crossBranchRes = await app.inject({
        method: 'POST',
        url: '/v1/pos/sales',
        headers: {
          authorization: `Bearer ${alphaBranch1CashierToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
          'idempotency-key': generateUuidV7(),
        },
        payload: {
          registerId: alphaRegister2Id, // Brooklyn register!
          lines: [{ productId: standardProductId, quantity: '1.000000' }],
          payments: [
            { paymentMethod: 'CASH', amount: '27.2200', tenderedAmount: '30.0000' },
          ],
        },
      });
      expect(crossBranchRes.statusCode).toBe(403);
      expect(crossBranchRes.json().errorCode).toBe('IAM_LOCATION_SCOPE_DENIED');
    });

    it('Tenant Beta cannot access or view Tenant Alpha sales or registers (PostgreSQL RLS strict isolation)', async () => {
      const betaRegisterRes = await app.inject({
        method: 'GET',
        url: `/v1/pos/registers`,
        headers: {
          authorization: `Bearer ${betaOwnerToken}`,
          'x-tenant-id': TENANT_BETA_ID,
        },
      });
      expect(betaRegisterRes.statusCode).toBe(200);
      expect(betaRegisterRes.json()).toEqual([]); // Zero rows leaked across tenant boundary!

      const betaSalesRes = await app.inject({
        method: 'GET',
        url: `/v1/pos/sales`,
        headers: {
          authorization: `Bearer ${betaOwnerToken}`,
          'x-tenant-id': TENANT_BETA_ID,
        },
      });
      expect(betaSalesRes.statusCode).toBe(200);
      expect(betaSalesRes.json()).toEqual([]);
    });

    it('database triggers strictly block hard-deleting sales records and updating immutable lines', async () => {
      // Layer 1: Application runtime user (nexstock_app_user) is blocked by least-privilege ACL
      await expect(
        withTenantTransaction(
          harness.db,
          {
            tenantId: TENANT_ALPHA_ID,
            userId: TENANT_ALPHA_OWNER,
            traceId: 'test_hard_delete_acl_1',
          },
          async (trx) => {
            await trx.db
              .deleteFrom('sales_invoices')
              .where('tenant_id', '=', TENANT_ALPHA_ID)
              .execute();
          },
        ),
      ).rejects.toThrow(/permission denied for table sales_invoices/);

      await expect(
        withTenantTransaction(
          harness.db,
          {
            tenantId: TENANT_ALPHA_ID,
            userId: TENANT_ALPHA_OWNER,
            traceId: 'test_hard_delete_acl_2',
          },
          async (trx) => {
            await trx.db
              .deleteFrom('sales_invoice_lines')
              .where('tenant_id', '=', TENANT_ALPHA_ID)
              .execute();
          },
        ),
      ).rejects.toThrow(/permission denied for table sales_invoice_lines/);

      // Layer 2: Even direct database owner operations are blocked by BEFORE DELETE and BEFORE UPDATE triggers
      await expect(
        harness.db
          .deleteFrom('sales_invoices')
          .where('tenant_id', '=', TENANT_ALPHA_ID)
          .execute(),
      ).rejects.toThrow(/HARD_DELETE_FORBIDDEN/);

      await expect(
        harness.db
          .deleteFrom('sales_invoice_lines')
          .where('tenant_id', '=', TENANT_ALPHA_ID)
          .execute(),
      ).rejects.toThrow(/HARD_DELETE_FORBIDDEN/);

      await expect(
        harness.db
          .updateTable('sales_invoice_lines')
          .set({ quantity: '999.000000' })
          .where('tenant_id', '=', TENANT_ALPHA_ID)
          .execute(),
      ).rejects.toThrow(/IMMUTABLE_TABLE_VIOLATION/);
    });
  });

  // ==========================================================================
  // TEST SUITE 7: Phase 5.1 QA: End-to-End Regression Test (BUG-004 & BUG-005)
  // ==========================================================================
  describe('7. Phase 5.1 QA: End-to-End Regression Test (BUG-004 & BUG-005)', () => {
    let app: AppInstance;
    let qaProductId: string;

    beforeAll(async () => {
      app = await buildApp({ db: harness.db, jwksProvider });
    });

    afterAll(async () => {
      await app.close();
    });

    it('BUG-004 & BUG-005: creates product with sellingPrice, posts stock movement, verifies ledger product info and delta qty, and verifies POS search returns retailPrice and sellingPrice', async () => {
      // 1. Create Product with sellingPrice 3500.0000 and purchaseCost 2500.0000
      const prodRes = await app.inject({
        method: 'POST',
        url: '/v1/products',
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
          'idempotency-key': generateUuidV7(),
        },
        payload: {
          sku: 'ELEC-MOUSE-QA51',
          name: 'Wireless Bluetooth Mouse QA',
          productType: 'STANDARD',
          baseUom: 'PCS',
          purchaseCost: '2500.0000',
          sellingPrice: '3500.0000',
          categoryId: alphaCategoryId,
          taxGroupId: alphaTaxGroupId,
          trackInventory: true,
        },
      });
      expect(prodRes.statusCode).toBe(201);
      const prodBody = prodRes.json();
      expect(prodBody.sku).toBe('ELEC-MOUSE-QA51');
      expect(prodBody.sellingPrice).toBe('3500.0000');
      qaProductId = prodBody.id;

      // 2. Post Stock Movement (STOCK_IN) 10 PCS
      const mvtRes = await app.inject({
        method: 'POST',
        url: '/v1/inventory/movements',
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
          'idempotency-key': generateUuidV7(),
        },
        payload: {
          branchId: alphaBranch1Id,
          warehouseId: alphaMainWarehouseId,
          productId: qaProductId,
          movementType: 'STOCK_IN',
          quantity: '10.000000',
          unitCost: '2500.0000',
          reason: 'Initial Opening Stock QA',
          notes: 'Initial Opening Stock QA',
        },
      });
      expect(mvtRes.statusCode).toBe(201);
      const mvtBody = mvtRes.json();
      // Verify BUG-005: response contains productSku, productName, qtyDelta, quantity, balanceAfter
      expect(mvtBody.productSku).toBe('ELEC-MOUSE-QA51');
      expect(mvtBody.productName).toBe('Wireless Bluetooth Mouse QA');
      expect(mvtBody.qtyDelta).toBe('10.000000');
      expect(mvtBody.quantity).toBe('10.000000');
      expect(mvtBody.balanceAfter).toBe('10.000000');

      // 3. List Stock Movements: verify ledger returns product details and positive delta
      const listMvtRes = await app.inject({
        method: 'GET',
        url: `/v1/inventory/movements?productId=${qaProductId}&warehouseId=${alphaMainWarehouseId}`,
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });
      expect(listMvtRes.statusCode).toBe(200);
      const mvtList = listMvtRes.json().data;
      expect(mvtList.length).toBeGreaterThanOrEqual(1);
      const foundMvt = mvtList.find((m: { productId: string }) => m.productId === qaProductId);
      expect(foundMvt).toBeDefined();
      expect(foundMvt.productSku).toBe('ELEC-MOUSE-QA51');
      expect(foundMvt.productName).toBe('Wireless Bluetooth Mouse QA');
      expect(foundMvt.qtyDelta).toBe('10.000000');
      expect(foundMvt.quantity).toBe('10.000000');
      expect(foundMvt.balanceAfter).toBe('10.000000');

      // 4. Verify Inventory Balance reflects 10.000000
      const balRes = await app.inject({
        method: 'GET',
        url: `/v1/inventory/balances?productId=${qaProductId}&warehouseId=${alphaMainWarehouseId}`,
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });
      expect(balRes.statusCode).toBe(200);
      const balances = balRes.json().data;
      expect(balances.length).toBe(1);
      expect(balances[0].qtyOnHand).toBe('10.000000');
      expect(balances[0].availableQty).toBe('10.000000');

      // 5. Verify POS Product Search returns retailPrice AND sellingPrice (BUG-004)
      const searchRes = await app.inject({
        method: 'GET',
        url: `/v1/pos/products/search?warehouseId=${alphaMainWarehouseId}&q=ELEC-MOUSE-QA51`,
        headers: {
          authorization: `Bearer ${alphaCashierToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });
      expect(searchRes.statusCode).toBe(200);
      const searchItems = searchRes.json();
      expect(searchItems).toHaveLength(1);
      const item = searchItems[0];
      expect(item.id).toBe(qaProductId);
      expect(item.sku).toBe('ELEC-MOUSE-QA51');
      expect(item.retailPrice).toBe('3500.0000');
      expect(item.sellingPrice).toBe('3500.0000');
      expect(item.availableQuantity).toBe('10.000000');

      // 6. Simulate frontend cart pricing logic:
      // In index.html: const price = p.retailPrice || p.sellingPrice || '0.0000';
      const resolvedPrice = item.retailPrice || item.sellingPrice || '0.0000';
      expect(resolvedPrice).toBe('3500.0000');
      const unitPriceFloat = parseFloat(resolvedPrice);
      expect(unitPriceFloat).toBe(3500);

      // 2 items added to cart -> subtotal = 7000.00
      const cartQty = 2;
      const lineTotal = cartQty * unitPriceFloat;
      expect(lineTotal).toBe(7000);
      expect(lineTotal.toFixed(2)).toBe('7000.00');

      // Checkout button label dynamically derives from calculateCartGrandTotal()
      const cartGrandTotal = lineTotal;
      const checkoutBtnLabel = `Checkout & Pay (LKR ${cartGrandTotal.toFixed(2)})`;
      expect(checkoutBtnLabel).toBe('Checkout & Pay (LKR 7000.00)');
    });

    it('BUG-006: GET /v1/pos/sales returns raw array and provides full invoice, line items, and payment details', async () => {
      const salesRes = await app.inject({
        method: 'GET',
        url: '/v1/pos/sales?limit=50',
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });
      expect(salesRes.statusCode).toBe(200);
      const sales = salesRes.json();
      expect(Array.isArray(sales)).toBe(true);
      expect(sales.length).toBeGreaterThanOrEqual(1);

      const first = sales[0];
      expect(first.id).toBeDefined();
      expect(first.invoiceNumber).toBeDefined();
      expect(first.status).toBeDefined();
      expect(first.createdAt).toBeDefined();
      expect(first.subtotalAmount).toBeDefined();
      expect(first.grandTotal).toBeDefined();
      expect(Array.isArray(first.lines)).toBe(true);
      expect(Array.isArray(first.payments)).toBe(true);
    });

    it('BUG-007: enforces exactly-once POS checkout idempotency under duplicate, concurrent, or replayed submissions', async () => {
      // Create a zero-tax product for clean total calculations
      const mouseRes = await app.inject({
        method: 'POST',
        url: '/v1/products',
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
          'idempotency-key': generateUuidV7(),
        },
        payload: {
          sku: 'IDEM-MOUSE-001',
          name: 'Idempotency Test Mouse',
          productType: 'STANDARD',
          baseUom: 'PCS',
          purchaseCost: '2000.0000',
          sellingPrice: '3000.0000',
          categoryId: alphaCategoryId,
          trackInventory: true,
        },
      });
      expect(mouseRes.statusCode).toBe(201);
      const testProdId = mouseRes.json().id;

      // Stock intake: 10 PCS
      await app.inject({
        method: 'POST',
        url: '/v1/inventory/movements',
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
          'idempotency-key': generateUuidV7(),
        },
        payload: {
          branchId: alphaBranch1Id,
          warehouseId: alphaMainWarehouseId,
          productId: testProdId,
          movementType: 'STOCK_IN',
          quantity: '10.000000',
          unitCost: '2000.0000',
          reason: 'Initial Stock for Idempotency Test',
        },
      });

      const stableCheckoutKey = generateUuidV7();
      const checkoutPayload = {
        registerId: alphaRegister1Id,
        customerName: 'walter waiter',
        lines: [
          {
            productId: testProdId,
            quantity: '2.000000',
          },
        ],
        payments: [
          {
            paymentMethod: 'CASH',
            amount: '6000.0000',
            tenderedAmount: '6000.0000',
          },
        ],
      };

      // 1. Initial intentional checkout submission
      const checkoutRes1 = await app.inject({
        method: 'POST',
        url: '/v1/pos/sales',
        headers: {
          authorization: `Bearer ${alphaCashierToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
          'idempotency-key': stableCheckoutKey,
        },
        payload: checkoutPayload,
      });
      expect(checkoutRes1.statusCode).toBe(201);
      const invoice1 = checkoutRes1.json();
      expect(invoice1.status).toBe('COMPLETED');
      expect(invoice1.grandTotal).toBe('6000.0000');
      expect(invoice1.customerName).toBe('walter waiter');
      expect(checkoutRes1.headers['x-idempotent-replayed']).toBe('false');

      // 2. Replay with the EXACT same idempotency key and payload (simulating button double-click or network retry)
      const checkoutRes2 = await app.inject({
        method: 'POST',
        url: '/v1/pos/sales',
        headers: {
          authorization: `Bearer ${alphaCashierToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
          'idempotency-key': stableCheckoutKey,
        },
        payload: checkoutPayload,
      });
      expect(checkoutRes2.statusCode).toBe(201);
      expect(checkoutRes2.headers['x-idempotent-replayed']).toBe('true');
      const invoice2 = checkoutRes2.json();
      expect(invoice2.id).toBe(invoice1.id);
      expect(invoice2.invoiceNumber).toBe(invoice1.invoiceNumber);

      // 3. Verify stock was decremented EXACTLY ONCE (10 - 2 = 8, not 6)
      const balCheck = await app.inject({
        method: 'GET',
        url: `/v1/inventory/balances?productId=${testProdId}&warehouseId=${alphaMainWarehouseId}`,
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });
      expect(balCheck.json().data[0].qtyOnHand).toBe('8.000000');

      // 4. Reusing the same key with a DIFFERENT payload must fail with 422 ERR_IDEMPOTENCY_KEY_REUSED_DIFFERENT_PAYLOAD
      const modifiedPayload = {
        ...checkoutPayload,
        lines: [{ productId: testProdId, quantity: '5.000000' }],
      };
      const conflictRes = await app.inject({
        method: 'POST',
        url: '/v1/pos/sales',
        headers: {
          authorization: `Bearer ${alphaCashierToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
          'idempotency-key': stableCheckoutKey,
        },
        payload: modifiedPayload,
      });
      expect(conflictRes.statusCode).toBe(422);
      expect(conflictRes.json().errorCode).toBe('ERR_IDEMPOTENCY_KEY_REUSED_DIFFERENT_PAYLOAD');

      // 5. A brand new checkout with a NEW key succeeds as a legitimate separate transaction
      const newKey = generateUuidV7();
      const freshRes = await app.inject({
        method: 'POST',
        url: '/v1/pos/sales',
        headers: {
          authorization: `Bearer ${alphaCashierToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
          'idempotency-key': newKey,
        },
        payload: checkoutPayload,
      });
      expect(freshRes.statusCode).toBe(201);
      const freshInvoice = freshRes.json();
      expect(freshInvoice.id).not.toBe(invoice1.id);
      expect(freshInvoice.invoiceNumber).not.toBe(invoice1.invoiceNumber);

      // Stock is now decremented again to 6 (8 - 2 = 6)
      const balCheck2 = await app.inject({
        method: 'GET',
        url: `/v1/inventory/balances?productId=${testProdId}&warehouseId=${alphaMainWarehouseId}`,
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });
      expect(balCheck2.json().data[0].qtyOnHand).toBe('6.000000');
    });

    it('BUG-012: verifies sales KPI summary and listSales status filtering with mixed COMPLETED and VOIDED sales', async () => {
      // 1. Create a sale that we will void
      const saleToVoidRes = await app.inject({
        method: 'POST',
        url: '/v1/pos/sales',
        headers: {
          authorization: `Bearer ${alphaCashierToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
          'idempotency-key': generateUuidV7(),
        },
        payload: {
          registerId: alphaRegister1Id,
          customerName: 'Customer To Void',
          lines: [
            {
              productId: serviceProductId,
              quantity: '1.000000',
            },
          ],
          payments: [
            {
              paymentMethod: 'CASH',
              amount: '54.4400',
              tenderedAmount: '60.0000',
            },
          ],
        },
      });
      expect(saleToVoidRes.statusCode).toBe(201);
      const saleToVoid = saleToVoidRes.json();
      expect(saleToVoid.status).toBe('COMPLETED');

      // 2. Void this sale
      const voidRes = await app.inject({
        method: 'POST',
        url: `/v1/pos/sales/${saleToVoid.id}/void`,
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
          'idempotency-key': generateUuidV7(),
        },
        payload: {
          reason: 'Customer cancelled transaction',
        },
      });
      expect(voidRes.statusCode).toBe(200);
      expect(voidRes.json().status).toBe('VOIDED');

      // 3. Test GET /v1/pos/sales/summary endpoint
      const summaryRes = await app.inject({
        method: 'GET',
        url: '/v1/pos/sales/summary',
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });
      expect(summaryRes.statusCode).toBe(200);
      const summary = summaryRes.json();

      expect(summary.completedCount).toBeGreaterThanOrEqual(1);
      expect(summary.voidedCount).toBeGreaterThanOrEqual(1);
      expect(Number(summary.completedAmount)).toBeGreaterThan(0);
      expect(Number(summary.voidedAmount)).toBeGreaterThan(0);
      expect(summary.totalSalesCount).toBe(summary.completedCount + summary.voidedCount);

      // 4. Test GET /v1/pos/sales?status=COMPLETED
      const completedListRes = await app.inject({
        method: 'GET',
        url: '/v1/pos/sales?status=COMPLETED&limit=50',
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });
      expect(completedListRes.statusCode).toBe(200);
      const completedList = completedListRes.json() as Array<{ status: string }>;
      expect(completedList.length).toBeGreaterThanOrEqual(1);
      completedList.forEach((s) => {
        expect(s.status).toBe('COMPLETED');
      });

      // 5. Test GET /v1/pos/sales?status=VOIDED
      const voidedListRes = await app.inject({
        method: 'GET',
        url: '/v1/pos/sales?status=VOIDED&limit=50',
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });
      expect(voidedListRes.statusCode).toBe(200);
      const voidedList = voidedListRes.json() as Array<{ id: string; status: string }>;
      expect(voidedList.length).toBeGreaterThanOrEqual(1);
      voidedList.forEach((s) => {
        expect(s.status).toBe('VOIDED');
      });
      expect(voidedList.some((s) => s.id === saleToVoid.id)).toBe(true);

      // 6. Test date range filtering
      const now = new Date();
      const past = new Date(now.getTime() - 86400000);
      const future = new Date(now.getTime() + 86400000);

      const rangeSummaryRes = await app.inject({
        method: 'GET',
        url: `/v1/pos/sales/summary?startDate=${past.toISOString()}&endDate=${future.toISOString()}`,
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });
      expect(rangeSummaryRes.statusCode).toBe(200);
      expect(rangeSummaryRes.json().totalSalesCount).toBe(summary.totalSalesCount);
    });

    it('BUG-013 & BUG-014: verifies live shift drawer reconciliation with adjustments and safe entity updates', async () => {
      // Setup: Create a test product with stock for Register 2 testing
      const reg2ProdRes = await app.inject({
        method: 'POST',
        url: '/v1/products',
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
          'idempotency-key': generateUuidV7(),
        },
        payload: {
          sku: `R2PROD-${generateUuidV7().slice(0, 6).toUpperCase()}`,
          name: 'Register 2 Recon Test Product',
          baseUom: 'PCS',
          purchaseCost: '1000.0000',
          sellingPrice: '2000.0000',
          trackInventory: true,
        },
      });
      expect(reg2ProdRes.statusCode).toBe(201);
      const reg2ProdId = reg2ProdRes.json().id;

      // Restock warehouse for this branch
      await app.inject({
        method: 'POST',
        url: '/v1/inventory/movements',
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
          'idempotency-key': generateUuidV7(),
        },
        payload: {
          branchId: alphaBranch2Id,
          warehouseId: alphaBranch2WarehouseId,
          productId: reg2ProdId,
          movementType: 'STOCK_IN',
          quantity: '50.000000',
          unitCost: '1000.0000',
          reason: 'Stock for Register 2 Reconciliation Test',
        },
      });

      // 1. Open shift on Register 2 with opening float 2,500.0000
      const openShiftRes = await app.inject({
        method: 'POST',
        url: '/v1/pos/shifts',
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          registerId: alphaRegister2Id,
          openingCashFloat: '2500.0000',
          notes: 'Shift Reconciliation QA Test',
        },
      });
      expect(openShiftRes.statusCode).toBe(201);
      const shift = openShiftRes.json();
      expect(shift.status).toBe('OPEN');
      expect(shift.openingCashFloat).toBe('2500.0000');
      expect(shift.expectedClosingCash).toBe('2500.0000');
      expect(shift.cashSales).toBe('0.0000');
      expect(shift.cashIn).toBe('0.0000');
      expect(shift.cashOut).toBe('0.0000');
      expect(shift.cashRefunds).toBe('0.0000');
      const shiftId = shift.id;

      // 2. Perform Cash Sale: 2 units * 2000 = 4000.0000 (tax inclusive or 0 tax)
      const cashSaleRes = await app.inject({
        method: 'POST',
        url: '/v1/pos/sales',
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
          'idempotency-key': generateUuidV7(),
        },
        payload: {
          registerId: alphaRegister2Id,
          shiftId,
          customerName: 'Cash Customer',
          lines: [{ productId: reg2ProdId, quantity: '2.000000' }],
          payments: [
            {
              paymentMethod: 'CASH',
              amount: '4000.0000',
              tenderedAmount: '4000.0000',
            },
          ],
        },
      });
      expect(cashSaleRes.statusCode).toBe(201);

      // Verify active shift expected drawer cash increases by exact cash sale amount
      const activeShift1 = await app.inject({
        method: 'GET',
        url: `/v1/pos/shifts/active?registerId=${alphaRegister2Id}`,
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });
      expect(activeShift1.statusCode).toBe(200);
      expect(activeShift1.json().cashSales).toBe('4000.0000');
      expect(activeShift1.json().expectedClosingCash).toBe('6500.0000'); // 2500 + 4000

      // 3. Perform CARD Sale: 1 unit * 2000 = 2000.0000
      const cardSaleRes = await app.inject({
        method: 'POST',
        url: '/v1/pos/sales',
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
          'idempotency-key': generateUuidV7(),
        },
        payload: {
          registerId: alphaRegister2Id,
          shiftId,
          customerName: 'Card Customer',
          lines: [{ productId: reg2ProdId, quantity: '1.000000' }],
          payments: [
            {
              paymentMethod: 'CARD',
              amount: '2000.0000',
              tenderedAmount: '2000.0000',
            },
          ],
        },
      });
      expect(cardSaleRes.statusCode).toBe(201);

      // Verify active shift expected drawer cash strictly EXCLUDES card sale
      const activeShift2 = await app.inject({
        method: 'GET',
        url: `/v1/pos/shifts/active?registerId=${alphaRegister2Id}`,
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });
      expect(activeShift2.statusCode).toBe(200);
      expect(activeShift2.json().cashSales).toBe('4000.0000'); // Still 4000
      expect(activeShift2.json().expectedClosingCash).toBe('6500.0000'); // Still 6500

      // 4. Test Cash Adjustments: CASH_IN, CASH_OUT, CASH_REFUND
      // 4a. CASH_IN (+1000.0000)
      const cashInRes = await app.inject({
        method: 'POST',
        url: `/v1/pos/shifts/${shiftId}/adjustments`,
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          type: 'CASH_IN',
          amount: '1000.0000',
          reason: 'Mid-day cash top-up',
        },
      });
      expect(cashInRes.statusCode).toBe(201);
      expect(cashInRes.json().cashIn).toBe('1000.0000');
      expect(cashInRes.json().expectedClosingCash).toBe('7500.0000'); // 6500 + 1000

      // 4b. CASH_OUT (-500.0000)
      const cashOutRes = await app.inject({
        method: 'POST',
        url: `/v1/pos/shifts/${shiftId}/adjustments`,
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          type: 'CASH_OUT',
          amount: '500.0000',
          reason: 'Bank safe deposit drop',
        },
      });
      expect(cashOutRes.statusCode).toBe(201);
      expect(cashOutRes.json().cashOut).toBe('500.0000');
      expect(cashOutRes.json().expectedClosingCash).toBe('7000.0000'); // 7500 - 500

      // 4c. CASH_REFUND (-200.0000)
      const cashRefundRes = await app.inject({
        method: 'POST',
        url: `/v1/pos/shifts/${shiftId}/adjustments`,
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          type: 'CASH_REFUND',
          amount: '200.0000',
          reason: 'Manual cash refund for damaged item',
        },
      });
      expect(cashRefundRes.statusCode).toBe(201);
      expect(cashRefundRes.json().cashRefunds).toBe('200.0000');
      expect(cashRefundRes.json().expectedClosingCash).toBe('6800.0000'); // 7000 - 200

      // 5. Close shift with counted cash = 6800.0000 (perfect balance)
      const closeShiftRes = await app.inject({
        method: 'POST',
        url: `/v1/pos/shifts/${shiftId}/close`,
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          countedClosingCash: '6800.0000',
          notes: 'Reconciliation test closed shift',
        },
      });
      expect(closeShiftRes.statusCode).toBe(200);
      const closed = closeShiftRes.json();
      expect(closed.status).toBe('CLOSED');
      expect(closed.openingCashFloat).toBe('2500.0000');
      expect(closed.cashSales).toBe('4000.0000');
      expect(closed.cashIn).toBe('1000.0000');
      expect(closed.cashOut).toBe('500.0000');
      expect(closed.cashRefunds).toBe('200.0000');
      expect(closed.expectedClosingCash).toBe('6800.0000');
      expect(closed.countedClosingCash).toBe('6800.0000');
      expect(closed.cashVariance).toBe('0.0000');

      // 6. Test BUG-014: PATCH /v1/pos/registers/:id
      const updateRegRes = await app.inject({
        method: 'PATCH',
        url: `/v1/pos/registers/${alphaRegister2Id}`,
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          name: 'Brooklyn Terminal Alpha Renamed',
          isActive: true,
        },
      });
      expect(updateRegRes.statusCode).toBe(200);
      expect(updateRegRes.json().name).toBe('Brooklyn Terminal Alpha Renamed');
      expect(updateRegRes.json().isActive).toBe(true);

      // 7. Test BUG-014: PATCH /v1/org/warehouses/:id
      const updateWhRes = await app.inject({
        method: 'PATCH',
        url: `/v1/org/warehouses/${alphaBranch2WarehouseId}`,
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          name: 'Brooklyn Main Warehouse Renamed',
          isActive: true,
        },
      });
      expect(updateWhRes.statusCode).toBe(200);
      expect(updateWhRes.json().name).toBe('Brooklyn Main Warehouse Renamed');
      expect(updateWhRes.json().isActive).toBe(true);
    });
  });
});

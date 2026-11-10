import { type KeyObject, generateKeyPairSync, sign } from 'node:crypto';
import { describe, it, expect, beforeAll } from 'vitest';
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

describe('@nexstock/api — Production Remediation & Master Feature Verification', () => {
  let harness: TestPostgresHarness;
  let app: AppInstance;

  const TENANT_ID = '0192e000-0000-7000-8000-000000000001';
  const OWNER_USER_ID = '0192e000-0000-7000-8000-000000000002';
  const CASHIER_USER_ID = '0192e000-0000-7000-8000-000000000003';
  const MANAGER_USER_ID = '0192e000-0000-7000-8000-000000000004';

  const primaryKey = createTestEs256KeyMaterial('test-key-remediation-master');
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

  let ownerToken: string;
  let cashierToken: string;
  let managerToken: string;
  let branchId: string;
  let warehouseId: string;
  let registerId: string;
  let productId: string;

  beforeAll(async () => {
    harness = await createTestPostgresHarness();
    app = await buildApp({
      db: harness.db,
      jwksProvider,
    });

    ownerToken = issueToken(OWNER_USER_ID, 'owner@remediation.com');
    cashierToken = issueToken(CASHIER_USER_ID, 'cashier@remediation.com');
    managerToken = issueToken(MANAGER_USER_ID, 'manager@remediation.com');

    // 1. Onboard Tenant
    const onboardRes = await app.inject({
      method: 'POST',
      url: '/v1/org/tenants/onboard',
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': TENANT_ID,
      },
      payload: {
        slug: 'remediation-store',
        legalName: 'Remediation Master Retail Store',
        baseCurrency: 'LKR',
        defaultLocale: 'en-US',
        defaultTimezone: 'Asia/Colombo',
        countryCode: 'LK',
        ownerEmail: 'owner@remediation.com',
        ownerFullName: 'Business Owner',
        planCode: 'GROWTH',
      },
    });
    expect(onboardRes.statusCode).toBe(201);

    // 2. Create Branch
    const branchRes = await app.inject({
      method: 'POST',
      url: '/v1/org/branches',
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': TENANT_ID,
      },
      payload: {
        code: 'BR-FLAGSHIP',
        name: 'Flagship Branch',
        timezone: 'Asia/Colombo',
        countryCode: 'LK',
      },
    });
    expect(branchRes.statusCode).toBe(201);
    branchId = branchRes.json().id;

    // 3. Create Warehouse
    const whRes = await app.inject({
      method: 'POST',
      url: '/v1/org/warehouses',
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': TENANT_ID,
      },
      payload: {
        branchId,
        code: 'WH-MAIN',
        name: 'Main Retail Store Floor',
        allowNegativeStock: false,
      },
    });
    expect(whRes.statusCode).toBe(201);
    warehouseId = whRes.json().id;

    // 4. Provision Manager and Cashier members
    await withTenantTransaction(
      harness.db,
      { tenantId: TENANT_ID, userId: OWNER_USER_ID, traceId: 'init_members' },
      async (trx) => {
        await provisionTenantMember(trx, {
          userId: MANAGER_USER_ID,
          email: 'manager@remediation.com',
          fullName: 'Store Manager',
          roleCodes: ['BRANCH_MANAGER'],
          allLocationsAccess: true,
        });

        await provisionTenantMember(trx, {
          userId: CASHIER_USER_ID,
          email: 'cashier@remediation.com',
          fullName: 'Front Cashier',
          roleCodes: ['CASHIER'],
          allLocationsAccess: true,
        });
      },
    );
  });

  // =========================================================================
  // Phase A2: BUG-060 Self-Healing Staff Role
  // =========================================================================
  it('Phase A2 (BUG-060): POST /v1/iam/invitations/staff auto-seeds STAFF role if missing', async () => {
    // Delete STAFF role and permissions from DB to simulate legacy tenant
    await withTenantTransaction(
      harness.db,
      { tenantId: TENANT_ID, userId: OWNER_USER_ID, traceId: 'del_staff' },
      async (trx) => {
        const staffRole = await trx
          .selectFrom('roles')
          .where('tenant_id', '=', TENANT_ID)
          .where('code', '=', 'STAFF')
          .select(['id'])
          .executeTakeFirst();
        if (staffRole) {
          await trx
            .deleteFrom('role_permissions')
            .where('tenant_id', '=', TENANT_ID)
            .where('role_id', '=', staffRole.id)
            .execute();
          await trx
            .deleteFrom('roles')
            .where('tenant_id', '=', TENANT_ID)
            .where('id', '=', staffRole.id)
            .execute();
        }
      },
    );

    const res = await app.inject({
      method: 'POST',
      url: '/v1/iam/invitations',
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': TENANT_ID,
      },
      payload: {
        email: 'staff.invitee@remediation.com',
        roleCode: 'STAFF',
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.roleCode).toBe('STAFF');
    expect(body.invitationCode).toBeDefined();

    // Verify STAFF role was dynamically re-seeded
    await withTenantTransaction(
      harness.db,
      { tenantId: TENANT_ID, userId: OWNER_USER_ID, traceId: 'chk_staff' },
      async (trx) => {
        const staffRole = await trx.selectFrom('roles').where('tenant_id', '=', TENANT_ID).where('code', '=', 'STAFF').selectAll().executeTakeFirst();
        expect(staffRole).toBeDefined();
      },
    );
  });

  // =========================================================================
  // Phase F1: Category Color Coding
  // =========================================================================
  it('Phase F1: POST /v1/categories supports color and PATCH /v1/categories/:id updates color', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/v1/categories',
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': TENANT_ID,
      },
      payload: {
        name: 'Beverages & Soft Drinks',
        description: 'Chilled drinks and refreshments',
        color: '#10b981',
      },
    });

    expect(createRes.statusCode).toBe(201);
    const cat = createRes.json();
    expect(cat.name).toBe('Beverages & Soft Drinks');
    expect(cat.color).toBe('#10b981');

    // Update color
    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/v1/categories/${cat.id}`,
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': TENANT_ID,
      },
      payload: {
        color: '#3b82f6',
      },
    });

    expect(patchRes.statusCode).toBe(200);
    const updated = patchRes.json();
    expect(updated.color).toBe('#3b82f6');
  });

  // =========================================================================
  // Phase C3: POS Register Creation
  // =========================================================================
  it('Phase C3: POST /v1/pos/registers creates a new terminal and GET /v1/pos/registers lists it', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/pos/registers',
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': TENANT_ID,
      },
      payload: {
        branchId,
        code: 'REG-FRONT-01',
        name: 'Front Counter Station 1',
      },
    });

    expect(res.statusCode).toBe(201);
    const reg = res.json();
    expect(reg.code).toBe('REG-FRONT-01');
    expect(reg.name).toBe('Front Counter Station 1');
    registerId = reg.id;

    // List registers
    const listRes = await app.inject({
      method: 'GET',
      url: `/v1/pos/registers?branchId=${encodeURIComponent(branchId)}`,
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': TENANT_ID,
      },
    });

    expect(listRes.statusCode).toBe(200);
    const registers = listRes.json();
    const found = registers.find((r: { id: string }) => r.id === registerId);
    expect(found).toBeDefined();
    expect(found.code).toBe('REG-FRONT-01');
  });

  // =========================================================================
  // Phase D1: Customer Creation Contract Validation
  // =========================================================================
  let customerId: string;
  it('Phase D1: POST /v1/customers accepts addressLine1, addressCity, companyName, isActive', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/customers',
      headers: {
        authorization: `Bearer ${cashierToken}`,
        'x-tenant-id': TENANT_ID,
      },
      payload: {
        name: 'Lanka Logistics Ltd',
        companyName: 'Lanka Logistics (Pvt) Ltd',
        email: 'billing@lankalogistics.lk',
        phone: '+94771234567',
        addressLine1: 'No. 123 Galle Road',
        addressCity: 'Colombo',
        addressPostalCode: '00300',
        isActive: true,
      },
    });

    expect(res.statusCode).toBe(201);
    const cust = res.json();
    expect(cust.name).toBe('Lanka Logistics Ltd');
    expect(cust.notes).toContain('Lanka Logistics (Pvt) Ltd');
    expect(cust.address).toContain('No. 123 Galle Road');
    expect(cust.status).toBe('ACTIVE');
    customerId = cust.id;
  });

  // =========================================================================
  // Phase G1: Variable Batch Selling Price
  // =========================================================================
  it('Phase G1: POST /v1/inventory/batches accepts and persists sellingPrice', async () => {
    // First create a batch-tracked product
    const prodRes = await app.inject({
      method: 'POST',
      url: '/v1/products',
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': TENANT_ID,
      },
      payload: {
        sku: 'MILK-1L-FRESH',
        name: 'Fresh Dairy Milk 1L',
        baseUom: 'L',
        purchaseCost: '350.0000',
        sellingPrice: '450.0000',
        trackingMode: 'BATCH',
      },
    });
    expect(prodRes.statusCode).toBe(201);
    productId = prodRes.json().id;

    // Create Batch with specific sellingPrice
    const batchRes = await app.inject({
      method: 'POST',
      url: '/v1/inventory/batches',
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': TENANT_ID,
        'idempotency-key': generateUuidV7(),
      },
      payload: {
        branchId,
        warehouseId,
        productId,
        batchNumber: 'LOT-MILK-2026-A',
        initialQuantity: '50.000000',
        unitCost: '340.0000',
        sellingPrice: '480.0000',
        receivedDate: '2026-11-09',
        expiryDate: '2026-12-09',
      },
    });

    expect(batchRes.statusCode).toBe(201);
    const batch = batchRes.json();
    expect(batch.batchNumber).toBe('LOT-MILK-2026-A');
    expect(batch.sellingPrice).toBe('480.0000');
    expect(batch.unitCost).toBe('340.0000');
  });

  // =========================================================================
  // Phase C1 & C2: Shift Ownership, Admin Override & Shift History
  // =========================================================================
  let shiftId: string;
  it('Phase C1 & C2: Shift Open by Cashier, Admin Override Force Close by Manager, and Shift History listing', async () => {
    // 1. Cashier opens shift
    const openRes = await app.inject({
      method: 'POST',
      url: '/v1/pos/shifts',
      headers: {
        authorization: `Bearer ${cashierToken}`,
        'x-tenant-id': TENANT_ID,
      },
      payload: {
        registerId,
        openingCashFloat: '5000.0000',
        notes: 'Morning shift float',
      },
    });

    expect(openRes.statusCode).toBe(201);
    const shift = openRes.json();
    expect(shift.status).toBe('OPEN');
    shiftId = shift.id;

    // 2. Active shift query as Manager shows openedByOtherCashier = true and cashier name
    const activeRes = await app.inject({
      method: 'GET',
      url: `/v1/pos/shifts/active?registerId=${encodeURIComponent(registerId)}`,
      headers: {
        authorization: `Bearer ${managerToken}`,
        'x-tenant-id': TENANT_ID,
      },
    });

    expect(activeRes.statusCode).toBe(200);
    const active = activeRes.json();
    expect(active.openedByOtherCashier).toBe(true);
    expect(active.openedByUserName).toBe('Front Cashier');

    // 3. Manager attempts closing WITHOUT adminOverride -> blocked
    const closeBlockedRes = await app.inject({
      method: 'POST',
      url: `/v1/pos/shifts/${shiftId}/close`,
      headers: {
        authorization: `Bearer ${managerToken}`,
        'x-tenant-id': TENANT_ID,
      },
      payload: {
        countedClosingCash: '5000.0000',
      },
    });
    expect(closeBlockedRes.statusCode).toBe(400);

    // 4. Manager closes WITH adminOverride and overrideReason
    const closeSuccessRes = await app.inject({
      method: 'POST',
      url: `/v1/pos/shifts/${shiftId}/close`,
      headers: {
        authorization: `Bearer ${managerToken}`,
        'x-tenant-id': TENANT_ID,
      },
      payload: {
        countedClosingCash: '5000.0000',
        adminOverride: true,
        overrideReason: 'Emergency register handover requested by store supervisor',
      },
    });

    expect(closeSuccessRes.statusCode).toBe(200);
    const closed = closeSuccessRes.json();
    expect(closed.status).toBe('CLOSED');

    // 5. Query shift history via GET /v1/pos/shifts
    const historyRes = await app.inject({
      method: 'GET',
      url: '/v1/pos/shifts?limit=10',
      headers: {
        authorization: `Bearer ${managerToken}`,
        'x-tenant-id': TENANT_ID,
      },
    });

    expect(historyRes.statusCode).toBe(200);
    const history = historyRes.json();
    const foundShift = history.find((s: { id: string }) => s.id === shiftId);
    expect(foundShift).toBeDefined();
    expect(foundShift.status).toBe('CLOSED');
    expect(foundShift.openedByUserName).toBe('Front Cashier');
    expect(foundShift.closedByUserName).toBe('Store Manager');
  });

  // =========================================================================
  // Phase D3: POS Multi-Tender Split Payment (Cash + Credit)
  // =========================================================================
  it('Phase D3: POS Multi-Tender Split Payment processes Cash + Credit successfully', async () => {
    // 1. Open credit account for customer
    const accRes = await app.inject({
      method: 'POST',
      url: '/v1/credit/accounts',
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': TENANT_ID,
      },
      payload: {
        customerId,
        creditLimit: '10000.0000',
        creditTerms: 'NET_30',
      },
    });
    expect(accRes.statusCode).toBe(201);

    // 2. Open a new shift for cashier
    const shiftRes = await app.inject({
      method: 'POST',
      url: '/v1/pos/shifts',
      headers: {
        authorization: `Bearer ${cashierToken}`,
        'x-tenant-id': TENANT_ID,
      },
      payload: {
        registerId,
        openingCashFloat: '2000.0000',
      },
    });
    expect(shiftRes.statusCode).toBe(201);
    const activeShiftId = shiftRes.json().id;

    // 3. Execute Split Payment sale: 2 units of Milk (2 * 480 = 960 LKR from batch selling price)
    // 400 LKR Cash + 560 LKR Credit
    const saleRes = await app.inject({
      method: 'POST',
      url: '/v1/pos/sales',
      headers: {
        authorization: `Bearer ${cashierToken}`,
        'x-tenant-id': TENANT_ID,
        'idempotency-key': generateUuidV7(),
      },
      payload: {
        registerId,
        shiftId: activeShiftId,
        customerId,
        customerName: 'Lanka Logistics Ltd',
        lines: [
          {
            productId,
            quantity: '2.000000',
            uomCode: 'L',
          },
        ],
        payments: [
          {
            paymentMethod: 'CASH',
            amount: '400.0000',
            tenderedAmount: '500.0000', // 100 LKR change
          },
          {
            paymentMethod: 'CREDIT',
            amount: '560.0000',
            tenderedAmount: '560.0000',
          },
        ],
      },
    });

    expect(saleRes.statusCode).toBe(201);
    const sale = saleRes.json();
    expect(sale.grandTotal).toBe('960.0000');
    expect(sale.invoiceNumber).toBeDefined();

    // Verify payments recorded on receipt/sale
    const receiptRes = await app.inject({
      method: 'GET',
      url: `/v1/pos/sales/${sale.id}/receipt`,
      headers: {
        authorization: `Bearer ${cashierToken}`,
        'x-tenant-id': TENANT_ID,
      },
    });

    expect(receiptRes.statusCode).toBe(200);
    const receipt = receiptRes.json();
    expect(receipt.payments).toHaveLength(2);
    const cashPay = receipt.payments.find((p: { method: string }) => p.method === 'CASH');
    const creditPay = receipt.payments.find((p: { method: string }) => p.method === 'CREDIT');
    expect(cashPay).toBeDefined();
    expect(cashPay.amount).toBe('400.0000');
    expect(creditPay).toBeDefined();
    expect(creditPay.amount).toBe('560.0000');

    // 4. Verify Customer Credit account balance increased by 560
    const custAccountRes = await app.inject({
      method: 'GET',
      url: `/v1/credit/accounts?customerId=${encodeURIComponent(customerId)}`,
      headers: {
        authorization: `Bearer ${cashierToken}`,
        'x-tenant-id': TENANT_ID,
      },
    });
    expect(custAccountRes.statusCode).toBe(200);
    const account = custAccountRes.json().items[0];
    expect(parseFloat(account.currentBalance)).toBe(560);
    expect(parseFloat(account.availableCredit)).toBe(9440);
  });
});

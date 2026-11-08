delete process.env.NEXSTOCK_ENABLE_V2_HRM;

import { type KeyObject, generateKeyPairSync, sign } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_SUPABASE_JWT_AUDIENCE,
  DEFAULT_SUPABASE_JWT_ISSUER,
  StaticJwksProvider,
  type SupabaseJwk,
  buildApp,
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

describe('NexStock V1 — HR & Self-Service Module Protection & V2 Premium Readiness', () => {
  let harness: TestPostgresHarness;
  let app: AppInstance;

  const TENANT_V1_ID = '0192b4c0-0000-7000-8000-000000000010';
  const OWNER_USER_ID = '0192b4c0-0000-7000-8000-000000000011';
  const STAFF_USER_ID = '0192b4c0-0000-7000-8000-000000000012';
  const CASHIER_USER_ID = '0192b4c0-0000-7000-8000-000000000013';

  const primaryKey = createTestEs256KeyMaterial('v1-protection-es256-key');
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
  let staffToken: string;
  let cashierToken: string;
  let branchId: string;
  let registerId: string;

  beforeAll(async () => {
    delete process.env.NEXSTOCK_ENABLE_V2_HRM;

    harness = await createTestPostgresHarness();
    ownerToken = issueToken(OWNER_USER_ID, 'owner@v1company.com');
    staffToken = issueToken(STAFF_USER_ID, 'staff@v1company.com');
    cashierToken = issueToken(CASHIER_USER_ID, 'cashier@v1company.com');

    app = await buildApp({
      db: harness.db,
      jwksProvider,
    });

    // 1. Onboard V1 Tenant with standard V1 GROWTH plan
    const onboardRes = await app.inject({
      method: 'POST',
      url: '/v1/org/tenants/onboard',
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': TENANT_V1_ID,
      },
      payload: {
        slug: 'v1-company',
        legalName: 'V1 Retail Company',
        baseCurrency: 'USD',
        defaultLocale: 'en-US',
        defaultTimezone: 'America/New_York',
        countryCode: 'US',
        ownerEmail: 'owner@v1company.com',
        ownerFullName: 'V1 Owner',
        planCode: 'GROWTH',
      },
    });
    expect(onboardRes.statusCode).toBe(201);

    // 2. Provision Staff & Cashier Members in IAM
    await withTenantTransaction(
      harness.db,
      { tenantId: TENANT_V1_ID, userId: OWNER_USER_ID, traceId: 'trace-v1-members' },
      async (trx) => {
        await provisionTenantMember(trx, {
          userId: STAFF_USER_ID,
          email: 'staff@v1company.com',
          fullName: 'V1 Staff Member',
          roleCodes: ['STAFF'],
          allLocationsAccess: true,
        });

        await provisionTenantMember(trx, {
          userId: CASHIER_USER_ID,
          email: 'cashier@v1company.com',
          fullName: 'V1 Cashier',
          roleCodes: ['CASHIER'],
          allLocationsAccess: true,
        });
      },
    );

    // 3. Create branch and warehouse for POS testing
    const branchRes = await app.inject({
      method: 'POST',
      url: '/v1/org/branches',
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': TENANT_V1_ID,
      },
      payload: {
        name: 'Main Retail Store',
        code: 'MAIN-01',
        countryCode: 'US',
        timezone: 'America/New_York',
      },
    });
    expect(branchRes.statusCode).toBe(201);
    branchId = branchRes.json().id;

    const whRes = await app.inject({
      method: 'POST',
      url: '/v1/org/warehouses',
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': TENANT_V1_ID,
      },
      payload: {
        branchId,
        name: 'Main Retail WH',
        code: 'WH-MAIN',
        allowNegativeStock: false,
      },
    });
    expect(whRes.statusCode).toBe(201);
    const warehouseId = whRes.json().id;

    registerId = '00000000-0000-0000-0000-000000000701';
    await withTenantTransaction(
      harness.db,
      {
        tenantId: TENANT_V1_ID,
        userId: OWNER_USER_ID,
        traceId: 'seed-pos-register',
      },
      async (trx) => {
        await trx.db
          .insertInto('pos_registers')
          .values({
            id: registerId,
            tenant_id: TENANT_V1_ID,
            branch_id: branchId,
            warehouse_id: warehouseId,
            code: 'REG-01',
            name: 'Front Checkout 1',
            last_invoice_seq: 0,
            is_active: true,
          })
          .execute();
      },
    );
  }, 60_000);

  afterAll(async () => {
    if (app) await app.close();
    if (harness) await harness.db.destroy();
  });

  describe('1. Direct HR API Route Protection (V1 Gating)', () => {
    it('rejects POST /v1/employees with 403 SUB_FEATURE_NOT_ENTITLED', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/employees',
        headers: {
          authorization: `Bearer ${ownerToken}`,
          'x-tenant-id': TENANT_V1_ID,
        },
        payload: {
          employeeCode: 'EMP-V1-001',
          firstName: 'John',
          lastName: 'Doe',
          email: 'john@v1company.com',
          joinedDate: '2026-01-15',
          designation: 'Sales Rep',
          department: 'Sales',
          employmentStatus: 'ACTIVE',
        },
      });

      expect(res.statusCode).toBe(403);
      const body = res.json();
      expect(body.errorCode).toBe('SUB_FEATURE_NOT_ENTITLED');
      expect(body.title).toBe('Feature Not Entitled');
      expect(body.detail).toContain('HR & Self-Service module is not included in your NexStock V1 subscription');
      expect(body.extensions?.module).toBe('HRM');
      expect(body.extensions?.upgradeRequired).toBe(true);
    });

    it('rejects GET /v1/employees with 403 SUB_FEATURE_NOT_ENTITLED', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/employees',
        headers: {
          authorization: `Bearer ${ownerToken}`,
          'x-tenant-id': TENANT_V1_ID,
        },
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().errorCode).toBe('SUB_FEATURE_NOT_ENTITLED');
    });

    it('rejects GET /v1/employees/me with 403 SUB_FEATURE_NOT_ENTITLED for staff user', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/employees/me',
        headers: {
          authorization: `Bearer ${staffToken}`,
          'x-tenant-id': TENANT_V1_ID,
        },
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().errorCode).toBe('SUB_FEATURE_NOT_ENTITLED');
    });

    it('rejects POST /v1/attendance/check-in with 403 SUB_FEATURE_NOT_ENTITLED', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/attendance/check-in',
        headers: {
          authorization: `Bearer ${staffToken}`,
          'x-tenant-id': TENANT_V1_ID,
        },
        payload: {},
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().errorCode).toBe('SUB_FEATURE_NOT_ENTITLED');
    });

    it('rejects GET /v1/attendance/records with 403 SUB_FEATURE_NOT_ENTITLED', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/attendance/records?date=2026-11-08',
        headers: {
          authorization: `Bearer ${ownerToken}`,
          'x-tenant-id': TENANT_V1_ID,
        },
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().errorCode).toBe('SUB_FEATURE_NOT_ENTITLED');
    });

    it('rejects POST /v1/leaves/requests with 403 SUB_FEATURE_NOT_ENTITLED', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/leaves/requests',
        headers: {
          authorization: `Bearer ${staffToken}`,
          'x-tenant-id': TENANT_V1_ID,
        },
        payload: {
          leaveType: 'CASUAL',
          startDate: '2026-11-15',
          endDate: '2026-11-16',
          daysCount: 2,
          reason: 'Personal affairs',
        },
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().errorCode).toBe('SUB_FEATURE_NOT_ENTITLED');
    });

    it('rejects POST /v1/payroll/runs with 403 SUB_FEATURE_NOT_ENTITLED', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/payroll/runs',
        headers: {
          authorization: `Bearer ${ownerToken}`,
          'x-tenant-id': TENANT_V1_ID,
        },
        payload: {
          frequency: 'MONTHLY',
          periodStart: '2026-11-01',
          periodEnd: '2026-11-30',
          paymentDate: '2026-12-05',
          currencyCode: 'USD',
          notes: 'November payroll',
        },
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().errorCode).toBe('SUB_FEATURE_NOT_ENTITLED');
    });

    it('rejects GET /v1/org/holidays with 403 SUB_FEATURE_NOT_ENTITLED', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/org/holidays',
        headers: {
          authorization: `Bearer ${ownerToken}`,
          'x-tenant-id': TENANT_V1_ID,
        },
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().errorCode).toBe('SUB_FEATURE_NOT_ENTITLED');
    });

    it('rejects GET /v1/org/payroll-settings with 403 SUB_FEATURE_NOT_ENTITLED', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/org/payroll-settings',
        headers: {
          authorization: `Bearer ${ownerToken}`,
          'x-tenant-id': TENANT_V1_ID,
        },
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().errorCode).toBe('SUB_FEATURE_NOT_ENTITLED');
    });
  });

  describe('2. Preservation of Phase 7.2 Organization Features & V1 Core Modules', () => {
    it('allows listing members via GET /v1/iam/members in V1', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/iam/members',
        headers: {
          authorization: `Bearer ${ownerToken}`,
          'x-tenant-id': TENANT_V1_ID,
        },
      });

      expect(res.statusCode).toBe(200);
      const members = res.json();
      expect(Array.isArray(members)).toBe(true);
      expect(members.length).toBeGreaterThanOrEqual(2);
    });

    it('allows issuing staff invitations via POST /v1/iam/invitations with 4-digit code in V1', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/iam/invitations',
        headers: {
          authorization: `Bearer ${ownerToken}`,
          'x-tenant-id': TENANT_V1_ID,
        },
        payload: {
          email: 'newcashier@v1company.com',
          roleCode: 'CASHIER',
        },
      });

      expect(res.statusCode).toBe(201);
      const inv = res.json();
      expect(inv.email).toBe('newcashier@v1company.com');
      expect(inv.roleCode).toBe('CASHIER');
      expect(inv.status).toBe('PENDING');
      expect(typeof inv.invitationCode).toBe('string');
      expect(inv.invitationCode.length).toBe(4);
    });

    it('allows listing roles via GET /v1/iam/roles in V1', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/iam/roles',
        headers: {
          authorization: `Bearer ${ownerToken}`,
          'x-tenant-id': TENANT_V1_ID,
        },
      });

      expect(res.statusCode).toBe(200);
      const roles = res.json();
      expect(Array.isArray(roles)).toBe(true);
      const codes = roles.map((r: { code: string }) => r.code);
      expect(codes).toContain('STAFF');
      expect(codes).toContain('CASHIER');
      expect(codes).toContain('TENANT_OWNER');
    });

    it('allows creating and listing products in Catalog & Inventory in V1', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/v1/products',
        headers: {
          authorization: `Bearer ${ownerToken}`,
          'x-tenant-id': TENANT_V1_ID,
        },
        payload: {
          sku: 'SKU-V1-PROD-01',
          name: 'V1 Standard Retail Item',
          primaryBarcode: 'NB-V1-10001',
          productType: 'STANDARD',
          baseUom: 'PCS',
          purchaseCost: '10.0000',
          sellingPrice: '19.9900',
        },
      });
      expect(createRes.statusCode).toBe(201);

      const listRes = await app.inject({
        method: 'GET',
        url: '/v1/products',
        headers: {
          authorization: `Bearer ${ownerToken}`,
          'x-tenant-id': TENANT_V1_ID,
        },
      });
      expect(listRes.statusCode).toBe(200);
      expect(listRes.json().data.length).toBeGreaterThanOrEqual(1);
    });

    it('allows POS register shifts and sales operations in V1', async () => {
      const shiftRes = await app.inject({
        method: 'POST',
        url: '/v1/pos/shifts',
        headers: {
          authorization: `Bearer ${cashierToken}`,
          'x-tenant-id': TENANT_V1_ID,
        },
        payload: {
          registerId,
          openingCashFloat: '100.0000',
        },
      });
      expect(shiftRes.statusCode).toBe(201);
      expect(shiftRes.json().status).toBe('OPEN');

      const activeRes = await app.inject({
        method: 'GET',
        url: `/v1/pos/shifts/active?registerId=${registerId}`,
        headers: {
          authorization: `Bearer ${cashierToken}`,
          'x-tenant-id': TENANT_V1_ID,
        },
      });
      expect(activeRes.statusCode).toBe(200);
      expect(activeRes.json().status).toBe('OPEN');
    });

    it('allows Expense recording and reporting in V1', async () => {
      const catRes = await app.inject({
        method: 'POST',
        url: '/v1/expenses/categories',
        headers: {
          authorization: `Bearer ${ownerToken}`,
          'x-tenant-id': TENANT_V1_ID,
        },
        payload: {
          name: 'Store Utilities',
          code: 'UTIL-01',
          description: 'Electricity & water',
        },
      });
      expect(catRes.statusCode).toBe(201);
      const catId = catRes.json().id;

      const expRes = await app.inject({
        method: 'POST',
        url: '/v1/expenses',
        headers: {
          authorization: `Bearer ${ownerToken}`,
          'x-tenant-id': TENANT_V1_ID,
        },
        payload: {
          categoryId: catId,
          expenseDate: '2026-11-08',
          amount: '150.0000',
          currencyCode: 'USD',
          vendorPayee: 'Power Grid Co',
          title: 'November Electric Bill',
          paymentMethod: 'CASH',
        },
      });
      expect(expRes.statusCode).toBe(201);
      expect(expRes.json().title).toBe('November Electric Bill');
    });
  });

  describe('3. V2 Premium Readiness — Seamless Reactivation via Subscription Entitlement', () => {
    it('activates HR & Self-Service when administrative override is granted on subscription', async () => {
      // 1. Verify before override: POST /v1/employees returns 403
      const preRes = await app.inject({
        method: 'GET',
        url: '/v1/employees',
        headers: {
          authorization: `Bearer ${ownerToken}`,
          'x-tenant-id': TENANT_V1_ID,
        },
      });
      expect(preRes.statusCode).toBe(403);

      // 2. Grant administrative override (V2 Premium Add-on / Early Access)
      const overrideRes = await app.inject({
        method: 'PATCH',
        url: '/v1/subscriptions/lifecycle',
        headers: {
          authorization: `Bearer ${ownerToken}`,
          'x-tenant-id': TENANT_V1_ID,
        },
        payload: {
          allowAdminOverride: true,
          overrideReason: 'V2 HR & Self-Service Premium Early Access Trial',
        },
      });
      expect(overrideRes.statusCode).toBe(200);
      expect(overrideRes.json().allowAdminOverride).toBe(true);

      // 3. Immediately after override: GET /v1/employees succeeds (200)
      const postGetRes = await app.inject({
        method: 'GET',
        url: '/v1/employees',
        headers: {
          authorization: `Bearer ${ownerToken}`,
          'x-tenant-id': TENANT_V1_ID,
        },
      });
      expect(postGetRes.statusCode).toBe(200);
      expect(Array.isArray(postGetRes.json().items)).toBe(true);

      // 4. Create Employee now succeeds (201)
      const postCreateRes = await app.inject({
        method: 'POST',
        url: '/v1/employees',
        headers: {
          authorization: `Bearer ${ownerToken}`,
          'x-tenant-id': TENANT_V1_ID,
        },
        payload: {
          employeeCode: 'EMP-V2-001',
          firstName: 'Alice',
          lastName: 'Smith',
          email: 'alice@v1company.com',
          joinedDate: '2026-02-01',
          designation: 'Floor Manager',
          department: 'Management',
          employmentStatus: 'ACTIVE',
        },
      });
      expect(postCreateRes.statusCode).toBe(201);
      expect(postCreateRes.json().employeeCode).toBe('EMP-V2-001');

      // 5. Revoking override immediately re-locks the module
      const revokeRes = await app.inject({
        method: 'PATCH',
        url: '/v1/subscriptions/lifecycle',
        headers: {
          authorization: `Bearer ${ownerToken}`,
          'x-tenant-id': TENANT_V1_ID,
        },
        payload: {
          allowAdminOverride: false,
          overrideReason: null,
        },
      });
      expect(revokeRes.statusCode).toBe(200);
      expect(revokeRes.json().allowAdminOverride).toBe(false);

      const relockRes = await app.inject({
        method: 'GET',
        url: '/v1/employees',
        headers: {
          authorization: `Bearer ${ownerToken}`,
          'x-tenant-id': TENANT_V1_ID,
        },
      });
      expect(relockRes.statusCode).toBe(403);
      expect(relockRes.json().errorCode).toBe('SUB_FEATURE_NOT_ENTITLED');
    });
  });
});

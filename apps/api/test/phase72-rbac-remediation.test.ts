import { type KeyObject, generateKeyPairSync, sign } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  DEFAULT_SUPABASE_JWT_AUDIENCE,
  DEFAULT_SUPABASE_JWT_ISSUER,
  StaticJwksProvider,
  type SupabaseJwk,
  buildApp,
  getOrCreateDevKeyMaterial,
  withTenantTransaction,
  generateUuidV7,
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

describe('@nexstock/api — Phase 7.2: RBAC UI & Permission Experience Remediation', () => {
  let harness: TestPostgresHarness;
  let app: AppInstance;

  const TENANT_ID = '0192b4c0-0000-7000-8000-0000000000d1';
  const OWNER_USER_ID = '0192b4c0-0000-7000-8000-0000000000d2';
  const CASHIER_1_USER_ID = '0192b4c0-0000-7000-8000-0000000000d3';
  const CASHIER_2_USER_ID = '0192b4c0-0000-7000-8000-0000000000d4';
  const STAFF_USER_ID = '0192b4c0-0000-7000-8000-0000000000d5';
  const CUSTOM_USER_ID = '0192b4c0-0000-7000-8000-0000000000d6';

  let ownerToken: string;
  let cashier1Token: string;
  let cashier2Token: string;
  let staffToken: string;
  let customUserToken: string;

  let branch1Id: string;
  let branch2Id: string;
  let warehouse1Id: string;
  let warehouse2Id: string;
  let register1Id: string;
  let register2Id: string;

  let activeShift1Id: string;

  const primaryKey = createTestEs256KeyMaterial('01f76c4b-9743-48ad-bed6-a9c89dc99cc8');
  const devKeyMaterial = getOrCreateDevKeyMaterial();
  const jwksProvider = new StaticJwksProvider({
    keys: [primaryKey.publicJwk, devKeyMaterial.publicJwk],
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

  beforeAll(async () => {
    harness = await createTestPostgresHarness();
    app = await buildApp({
      db: harness.db,
      jwksProvider,
    });

    ownerToken = issueToken(OWNER_USER_ID, 'owner@rbac-corp.test');
    cashier1Token = issueToken(CASHIER_1_USER_ID, 'cashier1@rbac-corp.test');
    cashier2Token = issueToken(CASHIER_2_USER_ID, 'cashier2@rbac-corp.test');
    staffToken = issueToken(STAFF_USER_ID, 'staff@rbac-corp.test');
    customUserToken = issueToken(CUSTOM_USER_ID, 'custom@rbac-corp.test');

    // 1. Onboard primary tenant
    const onboardRes = await app.inject({
      method: 'POST',
      url: '/v1/org/tenants/onboard',
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': TENANT_ID,
      },
      payload: {
        slug: 'rbac-remediation-corp',
        legalName: 'RBAC Remediation Corp',
        baseCurrency: 'LKR',
        defaultLocale: 'en-US',
        defaultTimezone: 'Asia/Colombo',
        countryCode: 'LK',
        ownerEmail: 'owner@rbac-corp.test',
        ownerFullName: 'RBAC Owner',
        planCode: 'GROWTH',
      },
    });
    expect(onboardRes.statusCode).toBe(201);

    // 2. Create Branch 1
    const b1Res = await app.inject({
      method: 'POST',
      url: '/v1/org/branches',
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': TENANT_ID,
      },
      payload: {
        code: 'BR-MAIN',
        name: 'Main HQ Branch',
        timezone: 'Asia/Colombo',
        countryCode: 'LK',
      },
    });
    expect(b1Res.statusCode).toBe(201);
    branch1Id = b1Res.json().id;

    // Create Branch 2
    const b2Res = await app.inject({
      method: 'POST',
      url: '/v1/org/branches',
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': TENANT_ID,
      },
      payload: {
        code: 'BR-SUBURB',
        name: 'Suburb Branch',
        timezone: 'Asia/Colombo',
        countryCode: 'LK',
      },
    });
    expect(b2Res.statusCode).toBe(201);
    branch2Id = b2Res.json().id;

    // Create Warehouse 1
    const wh1Res = await app.inject({
      method: 'POST',
      url: '/v1/org/warehouses',
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': TENANT_ID,
      },
      payload: {
        branchId: branch1Id,
        code: 'WH-MAIN-01',
        name: 'Main Warehouse',
        allowNegativeStock: false,
      },
    });
    expect(wh1Res.statusCode).toBe(201);
    warehouse1Id = wh1Res.json().id;

    // Create Warehouse 2
    const wh2Res = await app.inject({
      method: 'POST',
      url: '/v1/org/warehouses',
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': TENANT_ID,
      },
      payload: {
        branchId: branch2Id,
        code: 'WH-SUBURB-01',
        name: 'Suburb Warehouse',
        allowNegativeStock: false,
      },
    });
    expect(wh2Res.statusCode).toBe(201);
    warehouse2Id = wh2Res.json().id;

    // Seed Registers
    register1Id = generateUuidV7();
    register2Id = generateUuidV7();
    await withTenantTransaction(
      harness.db,
      {
        tenantId: TENANT_ID,
        userId: OWNER_USER_ID,
        traceId: 'seed_registers',
      },
      async (trx) => {
        await trx.db
          .insertInto('pos_registers')
          .values([
            {
              id: register1Id,
              tenant_id: TENANT_ID,
              branch_id: branch1Id,
              warehouse_id: warehouse1Id,
              code: 'REG-MAIN-01',
              name: 'Main Front Register',
              last_invoice_seq: 0,
              is_active: true,
            },
            {
              id: register2Id,
              tenant_id: TENANT_ID,
              branch_id: branch2Id,
              warehouse_id: warehouse2Id,
              code: 'REG-SUB-01',
              name: 'Suburb Front Register',
              last_invoice_seq: 0,
              is_active: true,
            },
          ])
          .execute();
      },
    );

    // 3. Provision Users and Memberships
    await withTenantTransaction(
      harness.db,
      {
        tenantId: TENANT_ID,
        userId: OWNER_USER_ID,
        traceId: 'seed_memberships',
      },
      async (trx) => {
        // Create users
        await trx.db
          .insertInto('users')
          .values([
            {
              id: CASHIER_1_USER_ID,
              email: 'cashier1@rbac-corp.test',
              full_name: 'Cashier One',
              is_platform_admin: false,
            },
            {
              id: CASHIER_2_USER_ID,
              email: 'cashier2@rbac-corp.test',
              full_name: 'Cashier Two',
              is_platform_admin: false,
            },
            {
              id: STAFF_USER_ID,
              email: 'staff@rbac-corp.test',
              full_name: 'General Staff',
              is_platform_admin: false,
            },
            {
              id: CUSTOM_USER_ID,
              email: 'custom@rbac-corp.test',
              full_name: 'Custom Auditor',
              is_platform_admin: false,
            },
          ])
          .execute();

        // Get system roles
        const cashierRole = await trx.db
          .selectFrom('roles')
          .select(['id'])
          .where('tenant_id', '=', TENANT_ID)
          .where('code', '=', 'CASHIER')
          .executeTakeFirstOrThrow();

        const staffRole = await trx.db
          .selectFrom('roles')
          .select(['id'])
          .where('tenant_id', '=', TENANT_ID)
          .where('code', '=', 'STAFF')
          .executeTakeFirstOrThrow();

        // Create Custom Role
        const customRoleId = generateUuidV7();
        await trx.db
          .insertInto('roles')
          .values({
            id: customRoleId,
            tenant_id: TENANT_ID,
            code: 'AUDITOR',
            name: 'Auditor',
            description: 'Read-only financial auditor',
            is_system_role: false,
          })
          .execute();

        // Grant 3 permissions to AUDITOR
        await trx.db
          .insertInto('role_permissions')
          .values([
            { id: generateUuidV7(), tenant_id: TENANT_ID, role_id: customRoleId, permission_key: 'dash:view' },
            { id: generateUuidV7(), tenant_id: TENANT_ID, role_id: customRoleId, permission_key: 'exp:expense:read' },
            { id: generateUuidV7(), tenant_id: TENANT_ID, role_id: customRoleId, permission_key: 'hrm:employee:read' },
          ])
          .execute();

        // Memberships:
        // Cashier 1: all_locations_access = true
        await trx.db
          .insertInto('tenant_memberships')
          .values({
            id: CASHIER_1_USER_ID,
            tenant_id: TENANT_ID,
            user_id: CASHIER_1_USER_ID,
            status: 'ACTIVE',
            all_locations_access: true,
          })
          .execute();

        await trx.db
          .insertInto('member_role_assignments')
          .values({
            id: generateUuidV7(),
            tenant_id: TENANT_ID,
            membership_id: CASHIER_1_USER_ID,
            role_id: cashierRole.id,
          })
          .execute();

        // Cashier 2: all_locations_access = true
        await trx.db
          .insertInto('tenant_memberships')
          .values({
            id: CASHIER_2_USER_ID,
            tenant_id: TENANT_ID,
            user_id: CASHIER_2_USER_ID,
            status: 'ACTIVE',
            all_locations_access: true,
          })
          .execute();

        await trx.db
          .insertInto('member_role_assignments')
          .values({
            id: generateUuidV7(),
            tenant_id: TENANT_ID,
            membership_id: CASHIER_2_USER_ID,
            role_id: cashierRole.id,
          })
          .execute();

        // Staff: all_locations_access = true
        await trx.db
          .insertInto('tenant_memberships')
          .values({
            id: STAFF_USER_ID,
            tenant_id: TENANT_ID,
            user_id: STAFF_USER_ID,
            status: 'ACTIVE',
            all_locations_access: true,
          })
          .execute();

        await trx.db
          .insertInto('member_role_assignments')
          .values({
            id: generateUuidV7(),
            tenant_id: TENANT_ID,
            membership_id: STAFF_USER_ID,
            role_id: staffRole.id,
          })
          .execute();

        // Custom User: all_locations_access = false, scoped to branch1
        await trx.db
          .insertInto('tenant_memberships')
          .values({
            id: CUSTOM_USER_ID,
            tenant_id: TENANT_ID,
            user_id: CUSTOM_USER_ID,
            status: 'ACTIVE',
            all_locations_access: false,
          })
          .execute();

        await trx.db
          .insertInto('member_role_assignments')
          .values({
            id: generateUuidV7(),
            tenant_id: TENANT_ID,
            membership_id: CUSTOM_USER_ID,
            role_id: customRoleId,
          })
          .execute();

        await trx.db
          .insertInto('member_location_scopes')
          .values({
            id: generateUuidV7(),
            tenant_id: TENANT_ID,
            membership_id: CUSTOM_USER_ID,
            branch_id: branch1Id,
            warehouse_id: warehouse1Id,
          })
          .execute();
      },
    );
  }, 60_000);

  afterAll(async () => {
    if (app) await app.close();
    if (harness) await harness.db.destroy();
  });

  describe('1. GET /v1/iam/members/me & Effective Permissions', () => {
    it('returns full administrative permissions and allLocationsAccess: true for TENANT_OWNER', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/iam/members/me',
        headers: {
          authorization: `Bearer ${ownerToken}`,
          'x-tenant-id': TENANT_ID,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.role).toBe('TENANT_OWNER');
      expect(body.roles).toContain('TENANT_OWNER');
      expect(body.allLocationsAccess).toBe(true);
      expect(body.allowedBranchIds).toBeNull();
      expect(body.allowedWarehouseIds).toBeNull();

      // Owner has unrestricted system catalog permissions
      expect(body.permissions).toContain('dash:view');
      expect(body.permissions).toContain('cat:product:manage');
      expect(body.permissions).toContain('hrm:payroll:process');
      expect(body.permissions).toContain('iam:member:manage');
      expect(body.permissions).toContain('pos:shift:open');
      expect(body.permissions).toContain('pos:sale:void');
      expect(body.permissions).toContain('exp:expense:create');
    });

    it('returns Cashier permissions including dash:view and POS, while strictly excluding management modules', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/iam/members/me',
        headers: {
          authorization: `Bearer ${cashier1Token}`,
          'x-tenant-id': TENANT_ID,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.role).toBe('CASHIER');
      expect(body.roles).toContain('CASHIER');

      // Allowed Cashier permissions
      expect(body.permissions).toContain('dash:view');
      expect(body.permissions).toContain('pos:shift:open');
      expect(body.permissions).toContain('pos:shift:close');
      expect(body.permissions).toContain('pos:sale:create');
      expect(body.permissions).toContain('pos:sale:read');
      expect(body.permissions).toContain('pos:register:read');
      expect(body.permissions).toContain('cat:product:read');
      expect(body.permissions).toContain('hrm:attendance:self');
      expect(body.permissions).toContain('hrm:leave:self');

      // Strictly hidden/forbidden management permissions
      expect(body.permissions).not.toContain('cat:product:manage');
      expect(body.permissions).not.toContain('hrm:payroll:process');
      expect(body.permissions).not.toContain('hrm:employee:manage');
      expect(body.permissions).not.toContain('iam:member:manage');
      expect(body.permissions).not.toContain('pos:sale:void');
      expect(body.permissions).not.toContain('exp:category:manage');
      expect(body.permissions).not.toContain('exp:expense:approve');
      expect(body.permissions).not.toContain('org:branch:manage');
    });

    it('returns Staff permissions strictly limited to self-service', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/iam/members/me',
        headers: {
          authorization: `Bearer ${staffToken}`,
          'x-tenant-id': TENANT_ID,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.role).toBe('STAFF');
      expect(body.roles).toContain('STAFF');

      // Staff allowed self-service
      expect(body.permissions).toContain('dash:view');
      expect(body.permissions).toContain('hrm:attendance:self');
      expect(body.permissions).toContain('hrm:leave:self');
      expect(body.permissions).toContain('hrm:schedule:read');
      expect(body.permissions).toContain('hrm:holiday:read');

      // Staff forbidden POS & Management
      expect(body.permissions).not.toContain('pos:shift:open');
      expect(body.permissions).not.toContain('pos:sale:create');
      expect(body.permissions).not.toContain('cat:product:manage');
      expect(body.permissions).not.toContain('hrm:payroll:process');
      expect(body.permissions).not.toContain('iam:member:manage');
    });

    it('returns dynamic effective permissions for custom role and respects location scope', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/iam/members/me',
        headers: {
          authorization: `Bearer ${customUserToken}`,
          'x-tenant-id': TENANT_ID,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.role).toBe('AUDITOR');
      expect(body.roles).toContain('AUDITOR');
      expect(body.allLocationsAccess).toBe(false);
      expect(body.allowedBranchIds).toEqual([branch1Id]);
      expect(body.allowedWarehouseIds).toEqual([warehouse1Id]);

      // Exactly the assigned custom permissions
      expect(body.permissions).toEqual(
        expect.arrayContaining(['dash:view', 'exp:expense:read', 'hrm:employee:read']),
      );
      expect(body.permissions).toHaveLength(3);
      expect(body.permissions).not.toContain('exp:expense:create');
      expect(body.permissions).not.toContain('cat:product:manage');
    });
  });

  describe('2. Cashier Shift Ownership, Collisions & Float Concealment', () => {
    it('Cashier 1 opens shift on Register 1 successfully', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/pos/shifts',
        headers: {
          authorization: `Bearer ${cashier1Token}`,
          'x-tenant-id': TENANT_ID,
        },
        payload: {
          registerId: register1Id,
          openingCashFloat: '150.0000',
          notes: 'Cashier 1 morning shift',
        },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.status).toBe('OPEN');
      expect(body.registerId).toBe(register1Id);
      expect(body.openedByUserId).toBe(CASHIER_1_USER_ID);
      activeShift1Id = body.id;
    });

    it('Cashier 1 cannot open a second concurrent shift on Register 2 (409 POS_CASHIER_SHIFT_ALREADY_OPEN)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/pos/shifts',
        headers: {
          authorization: `Bearer ${cashier1Token}`,
          'x-tenant-id': TENANT_ID,
        },
        payload: {
          registerId: register2Id,
          openingCashFloat: '100.0000',
          notes: 'Attempting concurrent shift on register 2',
        },
      });

      expect(res.statusCode).toBe(409);
      const body = res.json();
      expect(body.errorCode).toBe('POS_CASHIER_SHIFT_ALREADY_OPEN');
      expect(body.detail).toContain('already have an active shift open');
    });

    it('Cashier 1 querying own active shift sees full reconciliation financials', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/pos/shifts/active?registerId=${register1Id}`,
        headers: {
          authorization: `Bearer ${cashier1Token}`,
          'x-tenant-id': TENANT_ID,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.id).toBe(activeShift1Id);
      expect(body.isOwnShift).toBe(true);
      expect(body.openedByOtherCashier).toBe(false);
      expect(body.openingCashFloat).toBe('150.0000');
      expect(body.expectedClosingCash).toBe('150.0000');
    });

    it('Cashier 2 querying Register 1 active shift receives concealed totals (openedByOtherCashier: true)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/pos/shifts/active?registerId=${register1Id}`,
        headers: {
          authorization: `Bearer ${cashier2Token}`,
          'x-tenant-id': TENANT_ID,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.id).toBe(activeShift1Id);
      expect(body.isOwnShift).toBe(false);
      expect(body.openedByOtherCashier).toBe(true);

      // Financials masked to zero to prevent drawer snooping
      expect(body.openingCashFloat).toBe('0.00');
      expect(body.cashSales).toBe('0.00');
      expect(body.cashIn).toBe('0.00');
      expect(body.cashOut).toBe('0.00');
      expect(body.expectedClosingCash).toBe('0.00');
    });

    it('Cashier 2 attempting cash adjustment on Cashier 1 shift is blocked (403 POS_SHIFT_CLOSE_UNAUTHORIZED)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/pos/shifts/${activeShift1Id}/adjustments`,
        headers: {
          authorization: `Bearer ${cashier2Token}`,
          'x-tenant-id': TENANT_ID,
        },
        payload: {
          type: 'CASH_IN',
          amount: '50.0000',
          reason: 'Unauthorized float top-up',
        },
      });

      expect(res.statusCode).toBe(403);
      const body = res.json();
      expect(body.errorCode).toBe('POS_SHIFT_CLOSE_UNAUTHORIZED');
      expect(body.detail).toContain('Only the cashier who opened this shift or an authorized manager may record cash adjustments');
    });

    it('Cashier 2 attempting to close Cashier 1 shift is blocked (403 POS_SHIFT_CLOSE_UNAUTHORIZED)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/pos/shifts/${activeShift1Id}/close`,
        headers: {
          authorization: `Bearer ${cashier2Token}`,
          'x-tenant-id': TENANT_ID,
        },
        payload: {
          countedClosingCash: '150.0000',
          notes: 'Attempting to close another cashier shift',
        },
      });

      expect(res.statusCode).toBe(403);
      const body = res.json();
      expect(body.errorCode).toBe('POS_SHIFT_CLOSE_UNAUTHORIZED');
      expect(body.detail).toContain('Only the cashier who opened this shift or an authorized manager may close it');
    });

    it('Owner/Manager CAN close Cashier 1 active shift via manager override', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/pos/shifts/${activeShift1Id}/close`,
        headers: {
          authorization: `Bearer ${ownerToken}`,
          'x-tenant-id': TENANT_ID,
        },
        payload: {
          countedClosingCash: '150.0000',
          notes: 'Manager closing shift at end of day',
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.id).toBe(activeShift1Id);
      expect(body.status).toBe('CLOSED');
      expect(body.closedByUserId).toBe(OWNER_USER_ID);
      expect(body.cashVariance).toBe('0.0000');
    });
  });

  describe('3. Error Message Sanitization & No Raw UUID Leaks', () => {
    it('Permission denied 403 displays friendly message without leaking raw user UUIDs', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/products',
        headers: {
          authorization: `Bearer ${cashier1Token}`,
          'x-tenant-id': TENANT_ID,
        },
        payload: {
          sku: 'SKU-FORBIDDEN-01',
          name: 'Forbidden Product',
          baseUom: 'UNIT',
          purchaseCost: '50.0000',
          sellingPrice: '100.0000',
        },
      });

      expect(res.statusCode).toBe(403);
      const body = res.json();
      expect(body.errorCode).toBe('IAM_PERMISSION_DENIED');
      expect(body.detail).toContain('cat:product:manage');
      expect(body.detail).not.toContain(CASHIER_1_USER_ID);
    });

    it('Staff attempting POS shift creation returns friendly 403 error', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/pos/shifts',
        headers: {
          authorization: `Bearer ${staffToken}`,
          'x-tenant-id': TENANT_ID,
        },
        payload: {
          registerId: register1Id,
          openingCashFloat: '100.0000',
        },
      });

      expect(res.statusCode).toBe(403);
      const body = res.json();
      expect(body.errorCode).toBe('IAM_PERMISSION_DENIED');
      expect(body.detail).toContain('pos:shift:open');
      expect(body.detail).not.toContain(STAFF_USER_ID);
    });
  });
});

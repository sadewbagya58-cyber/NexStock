process.env.NEXSTOCK_ENABLE_V2_HRM = 'true';
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

describe('@nexstock/api — Phase 7 QA Remediation: BUG-058, BUG-054, BUG-055', () => {
  let harness: TestPostgresHarness;
  let app: AppInstance;

  const TENANT_ID = '0192b4c0-0000-7000-8000-000000000001';
  const OWNER_USER_ID = '0192b4c0-0000-7000-8000-000000000002';
  const CASHIER_USER_ID = '0192b4c0-0000-7000-8000-000000000003';
  const OTHER_USER_ID = '0192b4c0-0000-7000-8000-000000000004';
  const STAFF_USER_ID = '0192b4c0-0000-7000-8000-000000000005';
  const STAFF2_USER_ID = '0192b4c0-0000-7000-8000-000000000006';

  const primaryKey = createTestEs256KeyMaterial(
    '01f76c4b-9743-48ad-bed6-a9c89dc99cc8',
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

  let ownerToken: string;
  let cashierToken: string;
  let otherToken: string;
  let staffToken: string;
  let staff2Token: string;
  let branchId: string;
  let warehouseId: string;
  const registerId = generateUuidV7();
  let staffEmployeeId: string;
  let staff2EmployeeId: string;

  beforeAll(async () => {
    harness = await createTestPostgresHarness();

    ownerToken = issueToken(OWNER_USER_ID, 'owner@remediation-qa.example.com');
    cashierToken = issueToken(
      CASHIER_USER_ID,
      'cashier@remediation-qa.example.com',
    );
    otherToken = issueToken(OTHER_USER_ID, 'other@remediation-qa.example.com');
    staffToken = issueToken(STAFF_USER_ID, 'staff@remediation-qa.example.com');
    staff2Token = issueToken(STAFF2_USER_ID, 'staff2@remediation-qa.example.com');

    app = await buildApp({
      db: harness.db,
      jwksProvider,
    });

    // 1. Onboard Tenant
    const onboardRes = await app.inject({
      method: 'POST',
      url: '/v1/org/tenants/onboard',
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': TENANT_ID,
      },
      payload: {
        slug: 'remediation-qa',
        legalName: 'Remediation QA Inc',
        baseCurrency: 'USD',
        defaultLocale: 'en-US',
        defaultTimezone: 'America/New_York',
        countryCode: 'US',
        ownerEmail: 'owner@remediation-qa.example.com',
        ownerFullName: 'QA Owner',
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
        name: 'Main Remediation Store',
        code: 'MAIN-REM',
        timezone: 'America/New_York',
        countryCode: 'US',
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
        name: 'Main REM WH',
        code: 'WH-REM',
        allowNegativeStock: false,
      },
    });
    expect(whRes.statusCode).toBe(201);
    warehouseId = whRes.json().id;

    // 4. Provision Register & Cashiers
    await withTenantTransaction(
      harness.db,
      {
        tenantId: TENANT_ID,
        userId: OWNER_USER_ID,
        traceId: 'seed-pos-setup',
      },
      async (trx) => {
        await trx.db
          .insertInto('pos_registers')
          .values({
            id: registerId,
            tenant_id: TENANT_ID,
            branch_id: branchId,
            warehouse_id: warehouseId,
            code: 'REG-REM-1',
            name: 'Checkout Counter 1',
            last_invoice_seq: 0,
            is_active: true,
          })
          .execute();

        await provisionTenantMember(trx, {
          userId: CASHIER_USER_ID,
          email: 'cashier@remediation-qa.example.com',
          fullName: 'Main Cashier',
          roleCodes: ['CASHIER'],
          allLocationsAccess: true,
        });

        await provisionTenantMember(trx, {
          userId: OTHER_USER_ID,
          email: 'other@remediation-qa.example.com',
          fullName: 'Other Cashier',
          roleCodes: ['CASHIER'],
          allLocationsAccess: true,
        });

        await provisionTenantMember(trx, {
          userId: STAFF_USER_ID,
          email: 'staff@remediation-qa.example.com',
          fullName: 'Staff One',
          roleCodes: ['STAFF'],
          allLocationsAccess: false,
        });

        await provisionTenantMember(trx, {
          userId: STAFF2_USER_ID,
          email: 'staff2@remediation-qa.example.com',
          fullName: 'Staff Two',
          roleCodes: ['STAFF'],
          allLocationsAccess: false,
        });
      },
    );

    // 5. Create Employees linked to Staff users
    const emp1Res = await app.inject({
      method: 'POST',
      url: '/v1/employees',
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': TENANT_ID,
      },
      payload: {
        employeeCode: 'EMP-STF-01',
        firstName: 'Staff',
        lastName: 'Member',
        email: 'staff@remediation-qa.example.com',
        joinedDate: '2026-01-15',
        linkedUserId: STAFF_USER_ID,
        designation: 'Store Associate',
        department: 'Operations',
        primaryBranchId: branchId,
      },
    });
    expect(emp1Res.statusCode).toBe(201);
    staffEmployeeId = emp1Res.json().id;

    const emp2Res = await app.inject({
      method: 'POST',
      url: '/v1/employees',
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': TENANT_ID,
      },
      payload: {
        employeeCode: 'EMP-STF-02',
        firstName: 'Staff2',
        lastName: 'Member',
        email: 'staff2@remediation-qa.example.com',
        joinedDate: '2026-01-15',
        linkedUserId: STAFF2_USER_ID,
        designation: 'Inventory Clerk',
        department: 'Warehouse',
        primaryBranchId: branchId,
      },
    });
    expect(emp2Res.statusCode).toBe(201);
    staff2EmployeeId = emp2Res.json().id;
  }, 60_000);

  afterAll(async () => {
    if (app) await app.close();
    if (harness) await harness.db.destroy();
  });

  describe('BUG-058: Organization Holiday Creation API Validation & Recurring Holidays', () => {
    it('creates a holiday with standard "name" property', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/org/holidays',
        headers: {
          authorization: `Bearer ${ownerToken}`,
          'x-tenant-id': TENANT_ID,
        },
        payload: {
          holidayDate: '2026-12-25',
          name: 'Christmas Day',
          holidayType: 'PUBLIC',
          isRecurring: true,
        },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.name).toBe('Christmas Day');
      expect(body.holidayDate).toBe('2026-12-25');
      expect(body.isRecurring).toBe(true);
    });

    it('creates a holiday with frontend alias "holidayName" property', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/org/holidays',
        headers: {
          authorization: `Bearer ${ownerToken}`,
          'x-tenant-id': TENANT_ID,
        },
        payload: {
          holidayDate: '2026-01-01',
          holidayName: "New Year's Day",
          isRecurring: true,
        },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.name).toBe("New Year's Day");
      expect(body.holidayDate).toBe('2026-01-01');
      expect(body.isRecurring).toBe(true);
    });

    it('rejects duplicate holiday on same date with 409 Conflict', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/org/holidays',
        headers: {
          authorization: `Bearer ${ownerToken}`,
          'x-tenant-id': TENANT_ID,
        },
        payload: {
          holidayDate: '2026-12-25',
          name: 'Duplicate Christmas',
        },
      });

      expect(res.statusCode).toBe(409);
      expect(res.json().errorCode).toBe('HRM_HOLIDAY_EXISTS');
    });

    it('rejects empty holiday name with 400 Bad Request', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/org/holidays',
        headers: {
          authorization: `Bearer ${ownerToken}`,
          'x-tenant-id': TENANT_ID,
        },
        payload: {
          holidayDate: '2026-07-04',
          name: '   ',
        },
      });

      expect(res.statusCode).toBe(400);
    });

    it('lists holidays including recurring holidays across query years', async () => {
      const listRes2026 = await app.inject({
        method: 'GET',
        url: '/v1/org/holidays?year=2026',
        headers: {
          authorization: `Bearer ${ownerToken}`,
          'x-tenant-id': TENANT_ID,
        },
      });

      expect(listRes2026.statusCode).toBe(200);
      const items2026 = listRes2026.json().items;
      expect(items2026.length).toBeGreaterThanOrEqual(2);

      // Query future year 2027: recurring holidays must still appear!
      const listRes2027 = await app.inject({
        method: 'GET',
        url: '/v1/org/holidays?year=2027',
        headers: {
          authorization: `Bearer ${ownerToken}`,
          'x-tenant-id': TENANT_ID,
        },
      });

      expect(listRes2027.statusCode).toBe(200);
      const items2027 = listRes2027.json().items;
      const recurring = items2027.filter((h: { isRecurring: boolean }) => h.isRecurring);
      expect(recurring.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('BUG-054: GPS Geofencing Settings & Proration Enums Compatibility', () => {
    it('accepts and normalizes SCHEDULED_WORKING_DAYS, PRORATE_ALL and overtimeHourlyMultiplier', async () => {
      const updateRes = await app.inject({
        method: 'PATCH',
        url: '/v1/org/payroll-settings',
        headers: {
          authorization: `Bearer ${ownerToken}`,
          'x-tenant-id': TENANT_ID,
        },
        payload: {
          prorationMethod: 'SCHEDULED_WORKING_DAYS',
          allowanceProrationPolicy: 'PRORATE_ALL',
          defaultProrationRule: 'SCHEDULED_WORKING_DAYS',
          overtimeHourlyMultiplier: 1.5,
          gpsAttendanceEnabled: true,
          workplaceLatitude: 6.9271,
          workplaceLongitude: 79.8612,
          geofenceRadiusMeters: 150,
        },
      });

      expect(updateRes.statusCode).toBe(200);
      const body = updateRes.json();
      expect(body.prorationMethod).toBe('WORKING_DAYS');
      expect(body.allowanceProrationPolicy).toBe('PRORATE');
      expect(body.gpsAttendanceEnabled).toBe(true);
      expect(body.workplaceLatitude).toBe(6.9271);
      expect(body.workplaceLongitude).toBe(79.8612);
      expect(body.geofenceRadiusMeters).toBe(150);
    });

    it('accepts BASIC_ONLY and normalizes to FULL', async () => {
      const updateRes = await app.inject({
        method: 'PATCH',
        url: '/v1/org/payroll-settings',
        headers: {
          authorization: `Bearer ${ownerToken}`,
          'x-tenant-id': TENANT_ID,
        },
        payload: {
          prorationMethod: 'CALENDAR_DAYS',
          allowanceProrationPolicy: 'BASIC_ONLY',
        },
      });

      expect(updateRes.statusCode).toBe(200);
      const body = updateRes.json();
      expect(body.prorationMethod).toBe('CALENDAR_DAYS');
      expect(body.allowanceProrationPolicy).toBe('FULL');
    });
  });

  describe('BUG-055: Intermittent POS Cashier Shift Status & Active Shift Resolution', () => {
    let openShiftId: string;

    it('opens a POS shift on the register by Cashier', async () => {
      const openRes = await app.inject({
        method: 'POST',
        url: '/v1/pos/shifts',
        headers: {
          authorization: `Bearer ${cashierToken}`,
          'x-tenant-id': TENANT_ID,
        },
        payload: {
          registerId,
          openingCashFloat: '100.0000',
        },
      });

      expect(openRes.statusCode).toBe(201);
      openShiftId = openRes.json().id;
      expect(openRes.json().status).toBe('OPEN');
    });

    it('resolves active shift with registerId query param', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/pos/shifts/active?registerId=${registerId}`,
        headers: {
          authorization: `Bearer ${cashierToken}`,
          'x-tenant-id': TENANT_ID,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.id).toBe(openShiftId);
      expect(body.status).toBe('OPEN');
    });

    it('resolves active shift WITHOUT registerId query param for the calling cashier', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/pos/shifts/active',
        headers: {
          authorization: `Bearer ${cashierToken}`,
          'x-tenant-id': TENANT_ID,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.id).toBe(openShiftId);
      expect(body.status).toBe('OPEN');
      expect(body.openedByUserId).toBe(CASHIER_USER_ID);
    });

    it('returns 404 when querying without registerId for a user with NO active open shift', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/pos/shifts/active',
        headers: {
          authorization: `Bearer ${otherToken}`,
          'x-tenant-id': TENANT_ID,
        },
      });

      expect(res.statusCode).toBe(404);
      expect(res.json().errorCode).toBe('POS_NO_ACTIVE_SHIFT');
    });

    it('closes the shift and then returns 404 on subsequent active shift queries', async () => {
      const closeRes = await app.inject({
        method: 'POST',
        url: `/v1/pos/shifts/${openShiftId}/close`,
        headers: {
          authorization: `Bearer ${cashierToken}`,
          'x-tenant-id': TENANT_ID,
        },
        payload: {
          countedClosingCash: '100.0000',
        },
      });

      expect(closeRes.statusCode).toBe(200);
      expect(closeRes.json().status).toBe('CLOSED');

      const activeRes = await app.inject({
        method: 'GET',
        url: '/v1/pos/shifts/active',
        headers: {
          authorization: `Bearer ${cashierToken}`,
          'x-tenant-id': TENANT_ID,
        },
      });

      expect(activeRes.statusCode).toBe(404);
    });
  });

  describe('BUG-059: Staff Self-Service Scoped Access & Permission Ownership Hardening', () => {
    it('resolves own employee profile via GET /v1/employees/me for linked Staff user', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/employees/me',
        headers: {
          authorization: `Bearer ${staffToken}`,
          'x-tenant-id': TENANT_ID,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.id).toBe(staffEmployeeId);
      expect(body.employeeCode).toBe('EMP-STF-01');
      expect(body.designation).toBe('Store Associate');
    });

    it('returns 404 HRM_STAFF_ACCOUNT_NOT_LINKED via GET /v1/employees/me for unlinked user', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/employees/me',
        headers: {
          authorization: `Bearer ${otherToken}`,
          'x-tenant-id': TENANT_ID,
        },
      });

      expect(res.statusCode).toBe(404);
      expect(res.json().errorCode).toBe('HRM_STAFF_ACCOUNT_NOT_LINKED');
    });

    it('allows Staff user to view their own profile via GET /v1/employees/:employeeId/profile', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/employees/${staffEmployeeId}/profile`,
        headers: {
          authorization: `Bearer ${staffToken}`,
          'x-tenant-id': TENANT_ID,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.employee.id).toBe(staffEmployeeId);
      expect(body.activeSalaryStructure).toBeNull();
      expect(body.documents).toEqual([]);
    });

    it('strictly forbids Staff user from viewing another employee profile (403 HRM_UNAUTHORIZED_EMPLOYEE_ACCESS)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/employees/${staff2EmployeeId}/profile`,
        headers: {
          authorization: `Bearer ${staffToken}`,
          'x-tenant-id': TENANT_ID,
        },
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().errorCode).toBe('HRM_UNAUTHORIZED_EMPLOYEE_ACCESS');
    });

    it('allows Staff2 user to view their own profile but strictly forbids viewing Staff1 profile', async () => {
      const ownRes = await app.inject({
        method: 'GET',
        url: `/v1/employees/${staff2EmployeeId}/profile`,
        headers: {
          authorization: `Bearer ${staff2Token}`,
          'x-tenant-id': TENANT_ID,
        },
      });
      expect(ownRes.statusCode).toBe(200);
      expect(ownRes.json().employee.id).toBe(staff2EmployeeId);

      const forbiddenRes = await app.inject({
        method: 'GET',
        url: `/v1/employees/${staffEmployeeId}/profile`,
        headers: {
          authorization: `Bearer ${staff2Token}`,
          'x-tenant-id': TENANT_ID,
        },
      });
      expect(forbiddenRes.statusCode).toBe(403);
      expect(forbiddenRes.json().errorCode).toBe('HRM_UNAUTHORIZED_EMPLOYEE_ACCESS');
    });

    it('allows Staff user to view their own active work schedule', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/employees/${staffEmployeeId}/work-schedules/active`,
        headers: {
          authorization: `Bearer ${staffToken}`,
          'x-tenant-id': TENANT_ID,
        },
      });

      // No schedule set yet, so null is returned with 200
      expect(res.statusCode).toBe(200);
    });

    it('strictly forbids Staff user from viewing another employee work schedule (403 HRM_UNAUTHORIZED_EMPLOYEE_ACCESS)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/employees/${staff2EmployeeId}/work-schedules/active`,
        headers: {
          authorization: `Bearer ${staffToken}`,
          'x-tenant-id': TENANT_ID,
        },
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().errorCode).toBe('HRM_UNAUTHORIZED_EMPLOYEE_ACCESS');
    });

    it('allows Staff user to submit a self-service leave request (defaults to own employee ID)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/leaves/requests',
        headers: {
          authorization: `Bearer ${staffToken}`,
          'x-tenant-id': TENANT_ID,
        },
        payload: {
          leaveType: 'CASUAL',
          startDate: '2026-12-01',
          endDate: '2026-12-02',
          daysCount: 2,
          reason: 'Family event attendance',
        },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.employeeId).toBe(staffEmployeeId);
      expect(body.status).toBe('PENDING');
      expect(body.daysCount).toBe(2);
    });

    it('strictly rejects Staff user submitting leave request for another employee (403 ERR_FORBIDDEN)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/leaves/requests',
        headers: {
          authorization: `Bearer ${staffToken}`,
          'x-tenant-id': TENANT_ID,
        },
        payload: {
          employeeId: staff2EmployeeId,
          leaveType: 'CASUAL',
          startDate: '2026-12-05',
          endDate: '2026-12-05',
          daysCount: 1,
          reason: 'Attempting to request on behalf of peer',
        },
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().errorCode).toBe('ERR_FORBIDDEN');
    });

    it('allows Staff user to view their own leave balances', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/leaves/balances/${staffEmployeeId}`,
        headers: {
          authorization: `Bearer ${staffToken}`,
          'x-tenant-id': TENANT_ID,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(Array.isArray(body.items)).toBe(true);
      expect(body.items.length).toBeGreaterThan(0);
      expect(body.items[0].employeeId).toBe(staffEmployeeId);
    });

    it('strictly forbids Staff user from viewing another employee leave balances (403 HRM_UNAUTHORIZED_EMPLOYEE_ACCESS)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/leaves/balances/${staff2EmployeeId}`,
        headers: {
          authorization: `Bearer ${staffToken}`,
          'x-tenant-id': TENANT_ID,
        },
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().errorCode).toBe('HRM_UNAUTHORIZED_EMPLOYEE_ACCESS');
    });
  });
});

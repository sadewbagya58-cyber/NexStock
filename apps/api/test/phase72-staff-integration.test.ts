import { type KeyObject, generateKeyPairSync, sign } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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

describe('@nexstock/api — Phase 7.2: Staff Authentication, RBAC, Work Schedules (BUG-052), Attendance Records (BUG-053), and Self-Service Access (BUG-050)', () => {
  let harness: TestPostgresHarness;
  let app: AppInstance;

  const TENANT_ID = '0192b4c0-0000-7000-8000-000000000011';
  const OWNER_USER_ID = '0192b4c0-0000-7000-8000-000000000012';
  const MANAGER_USER_ID = '0192b4c0-0000-7000-8000-000000000013';
  const CASHIER_USER_ID = '0192b4c0-0000-7000-8000-000000000014';
  const STAFF_USER_1_ID = '0192b4c0-0000-7000-8000-000000000015';
  const STAFF_USER_2_ID = '0192b4c0-0000-7000-8000-000000000016';
  const STAFF_USER_3_ID = '0192b4c0-0000-7000-8000-000000000017';
  const UNLINKED_USER_ID = '0192b4c0-0000-7000-8000-000000000018';

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
  let managerToken: string;
  let cashierToken: string;
  let staffToken1: string;
  let staffToken2: string;
  let staffToken3: string;
  let unlinkedToken: string;

  let emp1Id: string;
  let emp2Id: string;
  let emp3Id: string;

  beforeAll(async () => {
    harness = await createTestPostgresHarness();
    app = await buildApp({
      db: harness.db,
      jwksProvider,
    });

    ownerToken = issueToken(OWNER_USER_ID, 'owner@nexstock-corp.com');
    managerToken = issueToken(MANAGER_USER_ID, 'manager@nexstock-corp.com');
    cashierToken = issueToken(CASHIER_USER_ID, 'cashier@nexstock-corp.com');
    staffToken1 = issueToken(STAFF_USER_1_ID, 'staff1@nexstock-corp.com');
    staffToken2 = issueToken(STAFF_USER_2_ID, 'staff2@nexstock-corp.com');
    staffToken3 = issueToken(STAFF_USER_3_ID, 'staff3@nexstock-corp.com');
    unlinkedToken = issueToken(UNLINKED_USER_ID, 'unlinked@nexstock-corp.com');

    // 1. Onboard Tenant
    const onboardRes = await app.inject({
      method: 'POST',
      url: '/v1/org/tenants/onboard',
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': TENANT_ID,
      },
      payload: {
        slug: 'nexstock-corp-qa',
        legalName: 'NexStock Corp — Integrated QA Tenant',
        baseCurrency: 'LKR',
        defaultLocale: 'en-US',
        defaultTimezone: 'Asia/Colombo',
        countryCode: 'LK',
        ownerEmail: 'owner@nexstock-corp.com',
        ownerFullName: 'Saman Jayasuriya (Owner)',
        planCode: 'GROWTH',
      },
    });
    expect(onboardRes.statusCode).toBe(201);

    // 2. Create Branch & Warehouse
    const branchRes = await app.inject({
      method: 'POST',
      url: '/v1/org/branches',
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': TENANT_ID,
      },
      payload: {
        code: 'CMB-HQ',
        name: 'Colombo Headquarters',
        timezone: 'Asia/Colombo',
        countryCode: 'LK',
      },
    });
    expect(branchRes.statusCode).toBe(201);
    const branchId = branchRes.json().id;

    const whRes = await app.inject({
      method: 'POST',
      url: '/v1/org/warehouses',
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': TENANT_ID,
      },
      payload: {
        code: 'CMB-WH-01',
        name: 'Colombo Central Distribution',
        branchId,
        allowNegativeStock: false,
      },
    });
    expect(whRes.statusCode).toBe(201);

    // 3. Provision Tenant Members with Roles
    await withTenantTransaction(
      harness.db,
      { tenantId: TENANT_ID, userId: OWNER_USER_ID, traceId: 'init-members' },
      async (trx) => {
        await provisionTenantMember(trx, {
          userId: MANAGER_USER_ID,
          email: 'manager@nexstock-corp.com',
          fullName: 'Bandara Silva (Manager)',
          roleCodes: ['BRANCH_MANAGER'],
          allLocationsAccess: true,
        });

        await provisionTenantMember(trx, {
          userId: CASHIER_USER_ID,
          email: 'cashier@nexstock-corp.com',
          fullName: 'Priyantha Kumara (Cashier)',
          roleCodes: ['CASHIER'],
          allLocationsAccess: false,
          branchIds: [branchId],
        });

        await provisionTenantMember(trx, {
          userId: STAFF_USER_1_ID,
          email: 'staff1@nexstock-corp.com',
          fullName: 'QA Phase71 Test01',
          roleCodes: ['STAFF'],
          allLocationsAccess: true,
        });

        await provisionTenantMember(trx, {
          userId: STAFF_USER_2_ID,
          email: 'staff2@nexstock-corp.com',
          fullName: 'Nimal Fernando',
          roleCodes: ['STAFF'],
          allLocationsAccess: true,
        });

        await provisionTenantMember(trx, {
          userId: STAFF_USER_3_ID,
          email: 'staff3@nexstock-corp.com',
          fullName: 'Kasun Perera',
          roleCodes: ['STAFF'],
          allLocationsAccess: true,
        });

        await provisionTenantMember(trx, {
          userId: UNLINKED_USER_ID,
          email: 'unlinked@nexstock-corp.com',
          fullName: 'Unlinked Member',
          roleCodes: ['STAFF'],
          allLocationsAccess: true,
        });
      },
    );
  }, 60_000);

  afterAll(async () => {
    if (app) await app.close();
    if (harness) await harness.db.destroy();
  });

  describe('1. BUG-052: Work Schedule Validation Fix & Independent Employee Schedules', () => {
    it('creates three distinct employee records for production QA configuration', async () => {
      // Employee 1: QA Phase71 Test01
      const res1 = await app.inject({
        method: 'POST',
        url: '/v1/employees',
        headers: {
          authorization: `Bearer ${ownerToken}`,
          'x-tenant-id': TENANT_ID,
        },
        payload: {
          employeeCode: 'EMP-QA-001',
          firstName: 'QA',
          lastName: 'Phase71 Test01',
          designation: 'Senior Test Automation Engineer',
          department: 'Quality Assurance',
          joinedDate: '2026-01-15',
          email: 'staff1@nexstock-corp.com',
          addressLine1: 'No. 12, Galle Road',
          city: 'Colombo',
        },
      });
      expect(res1.statusCode).toBe(201);
      emp1Id = res1.json().id;

      // Employee 2: Nimal Fernando
      const res2 = await app.inject({
        method: 'POST',
        url: '/v1/employees',
        headers: {
          authorization: `Bearer ${ownerToken}`,
          'x-tenant-id': TENANT_ID,
        },
        payload: {
          employeeCode: 'EMP-QA-002',
          firstName: 'Nimal',
          lastName: 'Fernando',
          designation: 'Warehouse Shift Supervisor',
          department: 'Logistics',
          joinedDate: '2026-02-01',
          email: 'staff2@nexstock-corp.com',
          addressLine1: 'No. 45, Kandy Road',
          city: 'Kelaniya',
        },
      });
      expect(res2.statusCode).toBe(201);
      emp2Id = res2.json().id;

      // Employee 3: Kasun Perera
      const res3 = await app.inject({
        method: 'POST',
        url: '/v1/employees',
        headers: {
          authorization: `Bearer ${ownerToken}`,
          'x-tenant-id': TENANT_ID,
        },
        payload: {
          employeeCode: 'EMP-QA-003',
          firstName: 'Kasun',
          lastName: 'Perera',
          designation: 'Customer Service Representative',
          department: 'Operations',
          joinedDate: '2026-03-01',
          email: 'staff3@nexstock-corp.com',
          addressLine1: 'No. 78, High Level Road',
          city: 'Nugegoda',
        },
      });
      expect(res3.statusCode).toBe(201);
      emp3Id = res3.json().id;
    });

    it('BUG-052: accepts isMondayWorking..isSundayWorking in work schedule creation without Ajv validation failure', async () => {
      // Schedule A for Employee 1: Weekday Shift (Mon–Fri 09:00–18:00)
      const res = await app.inject({
        method: 'POST',
        url: `/v1/employees/${emp1Id}/work-schedules`,
        headers: {
          authorization: `Bearer ${ownerToken}`,
          'x-tenant-id': TENANT_ID,
        },
        payload: {
          shiftName: 'Weekday Shift (Mon–Fri)',
          shiftType: 'DAY',
          shiftStartTime: '09:00:00',
          shiftEndTime: '18:00:00',
          breakDurationMinutes: 60,
          isMondayWorking: true,
          isTuesdayWorking: true,
          isWednesdayWorking: true,
          isThursdayWorking: true,
          isFridayWorking: true,
          isSaturdayWorking: false,
          isSundayWorking: false,
          effectiveFrom: '2026-01-01',
        },
      });

      expect(res.statusCode).toBe(201);
      const sched = res.json();
      expect(sched.shiftName).toBe('Weekday Shift (Mon–Fri)');
      expect(sched.isMondayWorking).toBe(true);
      expect(sched.mondayWorking).toBe(true);
      expect(sched.isFridayWorking).toBe(true);
      expect(sched.fridayWorking).toBe(true);
      expect(sched.isSaturdayWorking).toBe(false);
      expect(sched.saturdayWorking).toBe(false);
      expect(sched.isSundayWorking).toBe(false);
      expect(sched.sundayWorking).toBe(false);
    });

    it('configures Schedule B for Employee 2: Six Day Shift (Mon–Sat 08:00–17:00)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/employees/${emp2Id}/work-schedules`,
        headers: {
          authorization: `Bearer ${ownerToken}`,
          'x-tenant-id': TENANT_ID,
        },
        payload: {
          shiftName: 'Six Day Shift (Mon–Sat)',
          shiftType: 'DAY',
          shiftStartTime: '08:00:00',
          shiftEndTime: '17:00:00',
          breakDurationMinutes: 60,
          mondayWorking: true,
          isMondayWorking: true,
          tuesdayWorking: true,
          isTuesdayWorking: true,
          wednesdayWorking: true,
          isWednesdayWorking: true,
          thursdayWorking: true,
          isThursdayWorking: true,
          fridayWorking: true,
          isFridayWorking: true,
          saturdayWorking: true,
          isSaturdayWorking: true,
          sundayWorking: false,
          isSundayWorking: false,
          effectiveFrom: '2026-02-01',
        },
      });

      expect(res.statusCode).toBe(201);
      const sched = res.json();
      expect(sched.shiftName).toBe('Six Day Shift (Mon–Sat)');
      expect(sched.saturdayWorking).toBe(true);
      expect(sched.isSaturdayWorking).toBe(true);
      expect(sched.sundayWorking).toBe(false);
      expect(sched.isSundayWorking).toBe(false);
    });

    it('configures Schedule C for Employee 3: Sunday to Friday Shift (Sun–Fri 10:00–18:00, Saturday Off)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/employees/${emp3Id}/work-schedules`,
        headers: {
          authorization: `Bearer ${ownerToken}`,
          'x-tenant-id': TENANT_ID,
        },
        payload: {
          shiftName: 'Sunday to Friday Shift',
          shiftType: 'DAY',
          shiftStartTime: '10:00:00',
          shiftEndTime: '18:00:00',
          breakDurationMinutes: 60,
          isMondayWorking: true,
          isTuesdayWorking: true,
          isWednesdayWorking: true,
          isThursdayWorking: true,
          isFridayWorking: true,
          isSaturdayWorking: false,
          isSundayWorking: true,
          effectiveFrom: '2026-03-01',
        },
      });

      expect(res.statusCode).toBe(201);
      const sched = res.json();
      expect(sched.shiftName).toBe('Sunday to Friday Shift');
      expect(sched.saturdayWorking).toBe(false);
      expect(sched.isSaturdayWorking).toBe(false);
      expect(sched.sundayWorking).toBe(true);
      expect(sched.isSundayWorking).toBe(true);
    });

    it('verifies independent active schedules for all three employees', async () => {
      const [s1, s2, s3] = await Promise.all([
        app.inject({
          method: 'GET',
          url: `/v1/employees/${emp1Id}/work-schedules/active`,
          headers: {
            authorization: `Bearer ${ownerToken}`,
            'x-tenant-id': TENANT_ID,
          },
        }),
        app.inject({
          method: 'GET',
          url: `/v1/employees/${emp2Id}/work-schedules/active`,
          headers: {
            authorization: `Bearer ${ownerToken}`,
            'x-tenant-id': TENANT_ID,
          },
        }),
        app.inject({
          method: 'GET',
          url: `/v1/employees/${emp3Id}/work-schedules/active`,
          headers: {
            authorization: `Bearer ${ownerToken}`,
            'x-tenant-id': TENANT_ID,
          },
        }),
      ]);

      expect(s1.statusCode).toBe(200);
      expect(s2.statusCode).toBe(200);
      expect(s3.statusCode).toBe(200);

      // Verify Employee 1 (Saturday off, Sunday off)
      expect(s1.json().shiftStartTime).toBe('09:00:00');
      expect(s1.json().isSaturdayWorking).toBe(false);
      expect(s1.json().isSundayWorking).toBe(false);

      // Verify Employee 2 (Saturday working, Sunday off)
      expect(s2.json().shiftStartTime).toBe('08:00:00');
      expect(s2.json().isSaturdayWorking).toBe(true);
      expect(s2.json().isSundayWorking).toBe(false);

      // Verify Employee 3 (Saturday off, Sunday working)
      expect(s3.json().shiftStartTime).toBe('10:00:00');
      expect(s3.json().isSaturdayWorking).toBe(false);
      expect(s3.json().isSundayWorking).toBe(true);
    });
  });

  describe('2. BUG-050 & BUG-053: Staff Linking, Self-Service Me Endpoint, and Attendance Records Route', () => {
    it('links staff users to their corresponding employee records', async () => {
      const link1 = await app.inject({
        method: 'POST',
        url: `/v1/employees/${emp1Id}/link-user`,
        headers: {
          authorization: `Bearer ${ownerToken}`,
          'x-tenant-id': TENANT_ID,
        },
        payload: { userId: STAFF_USER_1_ID },
      });
      expect(link1.statusCode).toBe(200);
      expect(link1.json().linkedUserId).toBe(STAFF_USER_1_ID);

      const link2 = await app.inject({
        method: 'POST',
        url: `/v1/employees/${emp2Id}/link-user`,
        headers: {
          authorization: `Bearer ${ownerToken}`,
          'x-tenant-id': TENANT_ID,
        },
        payload: { userId: STAFF_USER_2_ID },
      });
      expect(link2.statusCode).toBe(200);
      expect(link2.json().linkedUserId).toBe(STAFF_USER_2_ID);

      const link3 = await app.inject({
        method: 'POST',
        url: `/v1/employees/${emp3Id}/link-user`,
        headers: {
          authorization: `Bearer ${ownerToken}`,
          'x-tenant-id': TENANT_ID,
        },
        payload: { userId: STAFF_USER_3_ID },
      });
      expect(link3.statusCode).toBe(200);
      expect(link3.json().linkedUserId).toBe(STAFF_USER_3_ID);
    });

    it('BUG-050: GET /v1/employees/me returns linked employee profile for authenticated staff user', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/employees/me',
        headers: {
          authorization: `Bearer ${staffToken1}`,
          'x-tenant-id': TENANT_ID,
        },
      });

      expect(res.statusCode).toBe(200);
      const profile = res.json();
      expect(profile.id).toBe(emp1Id);
      expect(profile.employeeCode).toBe('EMP-QA-001');
      expect(profile.displayName).toBe('QA Phase71 Test01');
      expect(profile.linkedUserId).toBe(STAFF_USER_1_ID);
    });

    it('BUG-050: GET /v1/employees/me returns 404 with HRM_STAFF_ACCOUNT_NOT_LINKED for unlinked user', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/employees/me',
        headers: {
          authorization: `Bearer ${unlinkedToken}`,
          'x-tenant-id': TENANT_ID,
        },
      });

      expect(res.statusCode).toBe(404);
      expect(res.json().errorCode).toBe('HRM_STAFF_ACCOUNT_NOT_LINKED');
    });

    it('performs self-service check-in as Staff User 1', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/attendance/check-in',
        headers: {
          authorization: `Bearer ${staffToken1}`,
          'x-tenant-id': TENANT_ID,
        },
        payload: {
          notes: 'Standard morning clock in',
        },
      });

      expect(res.statusCode).toBe(200);
      const rec = res.json();
      expect(rec.employeeId).toBe(emp1Id);
      expect(['PRESENT', 'LATE']).toContain(rec.status);
      expect(rec.checkInTime).toBeDefined();
    });

    it('performs self-service check-out as Staff User 1', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/attendance/check-out',
        headers: {
          authorization: `Bearer ${staffToken1}`,
          'x-tenant-id': TENANT_ID,
        },
        payload: {
          notes: 'Completed day shift',
        },
      });

      expect(res.statusCode).toBe(200);
      const rec = res.json();
      expect(rec.employeeId).toBe(emp1Id);
      expect(rec.checkOutTime).toBeDefined();
    });

    it('performs self-service check-in for Staff 2 (Nimal Fernando) and Staff 3 (Kasun Perera)', async () => {
      const res2 = await app.inject({
        method: 'POST',
        url: '/v1/attendance/check-in',
        headers: {
          authorization: `Bearer ${staffToken2}`,
          'x-tenant-id': TENANT_ID,
        },
        payload: { notes: 'Shift B start' },
      });
      expect(res2.statusCode).toBe(200);
      expect(res2.json().employeeId).toBe(emp2Id);

      const res3 = await app.inject({
        method: 'POST',
        url: '/v1/attendance/check-in',
        headers: {
          authorization: `Bearer ${staffToken3}`,
          'x-tenant-id': TENANT_ID,
        },
        payload: { notes: 'Shift C start' },
      });
      expect(res3.statusCode).toBe(200);
      expect(res3.json().employeeId).toBe(emp3Id);
    });

    it('verifies Cashier user can access self-service attendance check-in route', async () => {
      // Cashier is unlinked to employee profile initially, so it returns 403 HRM_STAFF_ACCOUNT_NOT_LINKED
      const res = await app.inject({
        method: 'POST',
        url: '/v1/attendance/check-in',
        headers: {
          authorization: `Bearer ${cashierToken}`,
          'x-tenant-id': TENANT_ID,
        },
        payload: {},
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().errorCode).toBe('HRM_STAFF_ACCOUNT_NOT_LINKED');
    });

    it('BUG-053: GET /v1/attendance/records is registered, supports limit & offset, and returns attendance records', async () => {
      const todayStr = new Date().toISOString().substring(0, 10);

      // Query through the exact endpoint requested by the frontend
      const res = await app.inject({
        method: 'GET',
        url: `/v1/attendance/records?date=${todayStr}&limit=100`,
        headers: {
          authorization: `Bearer ${ownerToken}`,
          'x-tenant-id': TENANT_ID,
        },
      });

      expect(res.statusCode).toBe(200);
      const data = res.json();
      expect(Array.isArray(data.items)).toBe(true);
      expect(data.items.length).toBeGreaterThanOrEqual(1);

      const found = data.items.find((r: { employeeId: string }) => r.employeeId === emp1Id);
      expect(found).toBeDefined();
      expect(found.employeeCode).toBe('EMP-QA-001');
      expect(found.isManualEntry).toBe(false);
      expect(found.isManual).toBe(false);
    });

    it('BUG-053: GET /v1/attendance/records supports pagination limit=1 offset=0', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/attendance/records?limit=1&offset=0',
        headers: {
          authorization: `Bearer ${ownerToken}`,
          'x-tenant-id': TENANT_ID,
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().items.length).toBe(1);
    });

    it('verifies staff self-service isolation: Staff User 1 viewing attendance only sees own records', async () => {
      // Record manual attendance for employee 2 by manager
      await app.inject({
        method: 'POST',
        url: '/v1/attendance/manual',
        headers: {
          authorization: `Bearer ${managerToken}`,
          'x-tenant-id': TENANT_ID,
        },
        payload: {
          employeeId: emp2Id,
          attendanceDate: new Date().toISOString().substring(0, 10),
          status: 'PRESENT',
          adjustmentReason: 'Field shift record',
        },
      });

      // Staff User 1 queries attendance records
      const res = await app.inject({
        method: 'GET',
        url: '/v1/attendance/records',
        headers: {
          authorization: `Bearer ${staffToken1}`,
          'x-tenant-id': TENANT_ID,
        },
      });

      expect(res.statusCode).toBe(200);
      const items = res.json().items;
      // All items returned must belong exclusively to emp1Id
      for (const item of items) {
        expect(item.employeeId).toBe(emp1Id);
      }
    });

    it('allows Staff User 1 to submit self-service leave request without admin privileges', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/leaves/requests',
        headers: {
          authorization: `Bearer ${staffToken1}`,
          'x-tenant-id': TENANT_ID,
        },
        payload: {
          leaveType: 'CASUAL',
          startDate: '2026-11-20',
          endDate: '2026-11-21',
          daysCount: 2,
          reason: 'Personal family commitment',
        },
      });

      expect(res.statusCode).toBe(201);
      const req = res.json();
      expect(req.employeeId).toBe(emp1Id);
      expect(req.status).toBe('PENDING');
      expect(req.leaveType).toBe('CASUAL');
    });

    it('rejects staff user attempting to request leave for another employee ID with 403 Forbidden', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/leaves/requests',
        headers: {
          authorization: `Bearer ${staffToken1}`,
          'x-tenant-id': TENANT_ID,
        },
        payload: {
          employeeId: emp2Id, // Another employee
          leaveType: 'CASUAL',
          startDate: '2026-12-01',
          endDate: '2026-12-02',
          daysCount: 2,
          reason: 'Unauthorized proxy leave request',
        },
      });

      expect(res.statusCode).toBe(403);
    });

    it('RBAC Enforcement: rejects staff user attempting to run payroll runs with 403 Forbidden', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/payroll/runs',
        headers: {
          authorization: `Bearer ${staffToken1}`,
          'x-tenant-id': TENANT_ID,
        },
        payload: {
          frequency: 'MONTHLY',
          periodStart: '2026-11-01',
          periodEnd: '2026-11-30',
          paymentDate: '2026-11-30',
          currencyCode: 'LKR',
        },
      });

      expect(res.statusCode).toBe(403);
    });

    it('RBAC Enforcement: rejects staff user attempting to create new employee records with 403 Forbidden', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/employees',
        headers: {
          authorization: `Bearer ${staffToken1}`,
          'x-tenant-id': TENANT_ID,
        },
        payload: {
          employeeCode: 'EMP-UNAUTH-01',
          firstName: 'Intruder',
          lastName: 'Record',
          designation: 'Hacker',
          department: 'Security',
          joinedDate: '2026-11-01',
        },
      });

      expect(res.statusCode).toBe(403);
    });

    it('RBAC Enforcement: rejects staff user accessing another employee profile with 403 Forbidden', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/employees/${emp2Id}`,
        headers: {
          authorization: `Bearer ${staffToken1}`,
          'x-tenant-id': TENANT_ID,
        },
      });

      expect(res.statusCode).toBe(403);
    });

    it('allows staff user to fetch their own employee profile via GET /v1/employees/:id', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/employees/${emp1Id}`,
        headers: {
          authorization: `Bearer ${staffToken1}`,
          'x-tenant-id': TENANT_ID,
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().id).toBe(emp1Id);
    });
  });
});

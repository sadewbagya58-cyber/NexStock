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

describe('@nexstock/api — Phase 7.1: Employee Address (BUG-049), Schedules, Attendance, Leaves, and Proration (BUG-051)', () => {
  let harness: TestPostgresHarness;
  let app: AppInstance;

  const TENANT_ALPHA_ID = '0192b4c0-0000-7000-8000-000000000001';
  const TENANT_ALPHA_OWNER = '0192b4c0-0000-7000-8000-000000000002';
  const TENANT_BETA_ID = '0192b4c0-0000-7000-8000-000000000003';
  const TENANT_BETA_OWNER = '0192b4c0-0000-7000-8000-000000000004';
  const STAFF_USER_ID = '0192b4c0-0000-7000-8000-000000000005';
  const STAFF_GPS_USER_ID = '0192b4c0-0000-7000-8000-000000000006';

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

  let alphaOwnerToken: string;
  let betaOwnerToken: string;
  let staffToken: string;
  let staffGpsToken: string;
  let alphaBranchId: string;
  let alphaWarehouseId: string;

  beforeAll(async () => {
    harness = await createTestPostgresHarness();

    alphaOwnerToken = issueToken(
      TENANT_ALPHA_OWNER,
      'owner@alpha-hrm.example.com',
    );
    betaOwnerToken = issueToken(
      TENANT_BETA_OWNER,
      'owner@beta-hrm.example.com',
    );
    staffToken = issueToken(
      STAFF_USER_ID,
      'staff@alpha-hrm.example.com',
    );
    staffGpsToken = issueToken(
      STAFF_GPS_USER_ID,
      'staff-gps@alpha-hrm.example.com',
    );

    app = await buildApp({
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
        slug: 'alpha-phase71',
        legalName: 'Alpha Phase 7.1 Inc',
        baseCurrency: 'USD',
        defaultLocale: 'en-US',
        defaultTimezone: 'America/New_York',
        countryCode: 'US',
        ownerEmail: 'owner@alpha-hrm.example.com',
        ownerFullName: 'Alpha Owner',
        planCode: 'GROWTH',
      },
    });
    expect(alphaOnboardRes.statusCode).toBe(201);

    // 2. Onboard Tenant Beta for cross-tenant isolation testing
    const betaOnboardRes = await app.inject({
      method: 'POST',
      url: '/v1/org/tenants/onboard',
      headers: {
        authorization: `Bearer ${betaOwnerToken}`,
        'x-tenant-id': TENANT_BETA_ID,
      },
      payload: {
        slug: 'beta-phase71',
        legalName: 'Beta Phase 7.1 Inc',
        baseCurrency: 'USD',
        defaultLocale: 'en-US',
        defaultTimezone: 'America/New_York',
        countryCode: 'US',
        ownerEmail: 'owner@beta-hrm.example.com',
        ownerFullName: 'Beta Owner',
        planCode: 'GROWTH',
      },
    });
    expect(betaOnboardRes.statusCode).toBe(201);

    // 3. Create branch and warehouse for Alpha
    const branchRes = await app.inject({
      method: 'POST',
      url: '/v1/org/branches',
      headers: {
        authorization: `Bearer ${alphaOwnerToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
      payload: {
        code: 'BR-01',
        name: 'Alpha HQ',
        timezone: 'America/New_York',
        countryCode: 'US',
      },
    });
    expect(branchRes.statusCode).toBe(201);
    alphaBranchId = branchRes.json().id;

    const whRes = await app.inject({
      method: 'POST',
      url: '/v1/org/warehouses',
      headers: {
        authorization: `Bearer ${alphaOwnerToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
      payload: {
        code: 'WH-01',
        name: 'Main Storage',
        branchId: alphaBranchId,
        allowNegativeStock: false,
      },
    });
    expect(whRes.statusCode).toBe(201);
    alphaWarehouseId = whRes.json().id;

    // Provision staff users in tenant Alpha
    await withTenantTransaction(
      harness.db,
      {
        tenantId: TENANT_ALPHA_ID,
        userId: TENANT_ALPHA_OWNER,
        traceId: 'trace-test-setup-01',
      },
      async (trx) => {
        await provisionTenantMember(trx, {
          userId: STAFF_USER_ID,
          email: 'staff@alpha-hrm.example.com',
          fullName: 'John Staff Doe',
          roleCodes: ['CASHIER'],
          allLocationsAccess: true,
        });
        await provisionTenantMember(trx, {
          userId: STAFF_GPS_USER_ID,
          email: 'staff-gps@alpha-hrm.example.com',
          fullName: 'GPS Staff Runner',
          roleCodes: ['CASHIER'],
          allLocationsAccess: true,
        });
      },
    );
  }, 60_000);

  afterAll(async () => {
    if (app) await app.close();
    if (harness) await harness.db.destroy();
  });

  // ==========================================================================
  // Section 1: BUG-049 — Employee Address Fields in Creation & Profile
  // ==========================================================================
  let employeeId: string;

  it('1.1 Creates employee with complete address fields (BUG-049)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/employees',
      headers: {
        authorization: `Bearer ${alphaOwnerToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
      payload: {
        employeeCode: 'EMP-701',
        firstName: 'John',
        lastName: 'Doe',
        displayName: 'John Doe',
        email: 'john.doe@alpha.example.com',
        phone: '+1-555-1234',
        nationalId: 'NIC-701001',
        gender: 'Male',
        dateOfBirth: '1990-01-01',
        joinedDate: '2026-03-01',
        designation: 'Inventory Specialist',
        department: 'Operations',
        employmentStatus: 'ACTIVE',
        payrollFrequency: 'MONTHLY',
        primaryBranchId: alphaBranchId,
        primaryWarehouseId: alphaWarehouseId,
        // BUG-049 Address Fields:
        addressLine1: '456 Innovation Way',
        addressLine2: 'Floor 3, Suite 300',
        city: 'New York',
        district: 'Manhattan',
        postalCode: '10001',
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toBeDefined();
    expect(body.employeeCode).toBe('EMP-701');
    expect(body.addressLine1).toBe('456 Innovation Way');
    expect(body.addressLine2).toBe('Floor 3, Suite 300');
    expect(body.city).toBe('New York');
    expect(body.district).toBe('Manhattan');
    expect(body.postalCode).toBe('10001');

    employeeId = body.id;
  });

  it('1.2 Fetches employee profile and verifies address fields are present', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/employees/${employeeId}`,
      headers: {
        authorization: `Bearer ${alphaOwnerToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.addressLine1).toBe('456 Innovation Way');
    expect(body.addressLine2).toBe('Floor 3, Suite 300');
    expect(body.city).toBe('New York');
    expect(body.district).toBe('Manhattan');
    expect(body.postalCode).toBe('10001');
  });

  it('1.3 Updates employee address via PATCH /v1/employees/:id', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/employees/${employeeId}`,
      headers: {
        authorization: `Bearer ${alphaOwnerToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
      payload: {
        addressLine1: '789 Updated Boulevard',
        addressLine2: 'Apt 12B',
        city: 'Brooklyn',
        district: 'Kings County',
        postalCode: '11201',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.addressLine1).toBe('789 Updated Boulevard');
    expect(body.addressLine2).toBe('Apt 12B');
    expect(body.city).toBe('Brooklyn');
    expect(body.district).toBe('Kings County');
    expect(body.postalCode).toBe('11201');
  });

  it('1.4 Creates an employee without optional address fields (backward compatibility)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/employees',
      headers: {
        authorization: `Bearer ${alphaOwnerToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
      payload: {
        employeeCode: 'EMP-702',
        firstName: 'Jane',
        lastName: 'Smith',
        joinedDate: '2026-03-01',
        designation: 'Cashier',
        department: 'Sales',
        payrollFrequency: 'MONTHLY',
        addressLine1: '100 Simple Street',
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.addressLine1).toBe('100 Simple Street');
    expect(body.addressLine2).toBeNull();
    expect(body.district).toBeNull();
    expect(body.postalCode).toBeNull();
  });

  // ==========================================================================
  // Section 2: Individual Employee Work Schedules
  // ==========================================================================
  it('2.1 Configures individual work schedule for employee', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/employees/${employeeId}/work-schedules`,
      headers: {
        authorization: `Bearer ${alphaOwnerToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
      payload: {
        shiftName: '4-Day Operations Shift',
        shiftType: 'DAY',
        shiftStartTime: '08:30',
        shiftEndTime: '17:30',
        breakDurationMinutes: 60,
        mondayWorking: true,
        tuesdayWorking: true,
        wednesdayWorking: true,
        thursdayWorking: true,
        fridayWorking: false, // Off Friday
        saturdayWorking: false, // Off Saturday
        sundayWorking: false, // Off Sunday
        effectiveFrom: '2026-01-01',
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.shiftName).toBe('4-Day Operations Shift');
    expect(body.mondayWorking).toBe(true);
    expect(body.fridayWorking).toBe(false);
    expect(body.isActive).toBe(true);
  });

  it('2.2 Retrieves active work schedule for employee', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/employees/${employeeId}/work-schedules/active`,
      headers: {
        authorization: `Bearer ${alphaOwnerToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.shiftName).toBe('4-Day Operations Shift');
    expect(body.shiftStartTime).toBe('08:30');
    expect(body.shiftEndTime).toBe('17:30');
    expect(body.breakDurationMinutes).toBe(60);
  });

  it('2.3 Lists work schedule history for employee', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/employees/${employeeId}/work-schedules`,
      headers: {
        authorization: `Bearer ${alphaOwnerToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.length).toBeGreaterThanOrEqual(1);
    expect(body[0].employeeId).toBe(employeeId);
  });

  // ==========================================================================
  // Section 3: Staff Account Linking, Check-In, Check-Out, and GPS Geofence
  // ==========================================================================
  it('3.1 Links employee to staff user account for self-service', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/employees/${employeeId}/link-user`,
      headers: {
        authorization: `Bearer ${alphaOwnerToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
      payload: {
        userId: STAFF_USER_ID,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().linkedUserId).toBe(STAFF_USER_ID);
  });

  it('3.2 Staff performs self-service check-in with server timestamp', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/attendance/check-in',
      headers: {
        authorization: `Bearer ${staffToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.employeeId).toBe(employeeId);
    expect(body.checkInTime).toBeDefined();
    expect(body.checkOutTime).toBeNull();
    expect(['PRESENT', 'LATE']).toContain(body.status);
  });

  it('3.3 Prevents duplicate check-in on the same day', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/attendance/check-in',
      headers: {
        authorization: `Bearer ${staffToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
      payload: {},
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().errorCode).toBe('HRM_ALREADY_CHECKED_IN');
  });

  it('3.4 Staff performs self-service check-out', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/attendance/check-out',
      headers: {
        authorization: `Bearer ${staffToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.employeeId).toBe(employeeId);
    expect(body.checkOutTime).toBeDefined();
  });

  it('3.5 Configures organization GPS attendance geofencing', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/org/payroll-settings',
      headers: {
        authorization: `Bearer ${alphaOwnerToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
      payload: {
        gpsAttendanceEnabled: true,
        workplaceLatitude: 6.9271,
        workplaceLongitude: 79.8612,
        geofenceRadiusMeters: 500, // 500 meters
        prorationMethod: 'CALENDAR_DAYS',
        allowanceProrationPolicy: 'PRORATE',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.gpsAttendanceEnabled).toBe(true);
    expect(body.geofenceRadiusMeters).toBe(500);
  });

  it('3.6 Rejects check-in without GPS coordinates when GPS verification is enabled', async () => {
    // Create an employee for GPS runner and link to STAFF_GPS_USER_ID
    const empGpsRes = await app.inject({
      method: 'POST',
      url: '/v1/employees',
      headers: {
        authorization: `Bearer ${alphaOwnerToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
      payload: {
        employeeCode: 'EMP-703',
        firstName: 'GPS',
        lastName: 'Tester',
        joinedDate: '2026-03-01',
        designation: 'Driver',
        department: 'Logistics',
        payrollFrequency: 'MONTHLY',
        addressLine1: 'GPS Road',
      },
    });
    const gpsEmpId = empGpsRes.json().id;

    await app.inject({
      method: 'POST',
      url: `/v1/employees/${gpsEmpId}/link-user`,
      headers: {
        authorization: `Bearer ${alphaOwnerToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
      payload: {
        userId: STAFF_GPS_USER_ID,
      },
    });

    // Check-in without GPS coordinates
    const checkInRes = await app.inject({
      method: 'POST',
      url: '/v1/attendance/check-in',
      headers: {
        authorization: `Bearer ${staffGpsToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
      payload: {},
    });

    expect(checkInRes.statusCode).toBe(400);
    expect(checkInRes.json().errorCode).toBe('HRM_GPS_REQUIRED');

    // Check-in with coordinates outside 500m geofence (e.g. 10km away: lat 7.0271)
    const outsideRes = await app.inject({
      method: 'POST',
      url: '/v1/attendance/check-in',
      headers: {
        authorization: `Bearer ${staffGpsToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
      payload: {
        latitude: 7.0271,
        longitude: 79.8612,
      },
    });

    expect(outsideRes.statusCode).toBe(400);
    expect(outsideRes.json().errorCode).toBe('HRM_GEOFENCE_FAILED');

    // Check-in within geofence (e.g. 10 meters away: lat 6.9271, lon 79.8612)
    const insideRes = await app.inject({
      method: 'POST',
      url: '/v1/attendance/check-in',
      headers: {
        authorization: `Bearer ${staffGpsToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
      payload: {
        latitude: 6.9271,
        longitude: 79.8612,
      },
    });

    expect(insideRes.statusCode).toBe(200);
    expect(insideRes.json().gpsVerified).toBe(true);
  });

  // ==========================================================================
  // Section 4: Leave Management, Approvals, and Balance Deductions
  // ==========================================================================
  let leaveRequestId: string;

  it('4.1 Staff submits leave request', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/leaves/requests',
      headers: {
        authorization: `Bearer ${staffToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
      payload: {
        leaveType: 'CASUAL',
        startDate: '2026-03-23',
        endDate: '2026-03-24',
        daysCount: 2,
        reason: 'Personal family matter',
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.employeeId).toBe(employeeId);
    expect(body.leaveType).toBe('CASUAL');
    expect(body.daysCount).toBe(2);
    expect(body.status).toBe('PENDING');

    leaveRequestId = body.id;
  });

  it('4.2 Manager approves leave request and deducts leave balance', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/leaves/requests/${leaveRequestId}/review`,
      headers: {
        authorization: `Bearer ${alphaOwnerToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
      payload: {
        status: 'APPROVED',
        reviewNotes: 'Approved by manager',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('APPROVED');
    expect(body.reviewedByUserId).toBe(TENANT_ALPHA_OWNER);
    expect(body.reviewedAt).toBeDefined();

    // Check balances
    const balRes = await app.inject({
      method: 'GET',
      url: `/v1/leaves/balances/${employeeId}?year=2026`,
      headers: {
        authorization: `Bearer ${alphaOwnerToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
    });

    expect(balRes.statusCode).toBe(200);
    const balances = balRes.json().items;
    const casualBal = balances.find((b: { leaveType: string; usedDays: number; remainingDays: number }) => b.leaveType === 'CASUAL');
    expect(casualBal).toBeDefined();
    // Default 7 casual days minus 2 = 5
    expect(casualBal.usedDays).toBe(2);
    expect(casualBal.remainingDays).toBe(5);
  });

  // ==========================================================================
  // Section 5: Organization Holidays
  // ==========================================================================
  let holidayId: string;

  it('5.1 Creates organization holiday', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/org/holidays',
      headers: {
        authorization: `Bearer ${alphaOwnerToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
      payload: {
        name: 'Spring Company Day',
        holidayDate: '2026-03-27',
        holidayType: 'ORG',
        isRecurring: false,
        notes: 'Annual team outing',
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.name).toBe('Spring Company Day');
    expect(body.holidayDate).toBe('2026-03-27');
    holidayId = body.id;
  });

  it('5.2 Lists organization holidays', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/org/holidays?year=2026',
      headers: {
        authorization: `Bearer ${alphaOwnerToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items.length).toBeGreaterThanOrEqual(1);
    expect(body.items.some((h: { id: string }) => h.id === holidayId)).toBe(true);
  });

  // ==========================================================================
  // Section 6: Salary Proration Engine (BUG-051 Remediation)
  // ==========================================================================
  it('6.1 Prorates salary for mid-month hire under CALENDAR_DAYS mode', async () => {
    // Create an employee joining mid-month on 2026-03-16 (16 days out of 31 in March)
    const empRes = await app.inject({
      method: 'POST',
      url: '/v1/employees',
      headers: {
        authorization: `Bearer ${alphaOwnerToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
      payload: {
        employeeCode: 'EMP-PRORATE-01',
        firstName: 'Charlie',
        lastName: 'MidMonth',
        joinedDate: '2026-03-16',
        designation: 'Engineer',
        department: 'Operations',
        payrollFrequency: 'MONTHLY',
        addressLine1: '321 Pkwy',
      },
    });
    expect(empRes.statusCode).toBe(201);
    const midEmpId = empRes.json().id;

    // Assign salary structure: Basic = 3100.0000 (100 per day in March 31-day month)
    const structRes = await app.inject({
      method: 'POST',
      url: `/v1/employees/${midEmpId}/salary-structure`,
      headers: {
        authorization: `Bearer ${alphaOwnerToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
      payload: {
        basicSalary: '3100.0000',
        currencyCode: 'USD',
        effectiveFrom: '2026-03-16',
        components: [
          {
            componentName: 'Housing Allowance',
            componentType: 'EARNING',
            calculationType: 'FIXED_AMOUNT',
            componentValue: '310.0000',
            isTaxable: true,
            isStatutory: false,
            prorationRule: 'PRORATE',
          },
        ],
      },
    });
    expect(structRes.statusCode).toBe(201);

    // Calculate payroll run for March 2026
    const runRes = await app.inject({
      method: 'POST',
      url: '/v1/payroll/runs',
      headers: {
        authorization: `Bearer ${alphaOwnerToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
      payload: {
        frequency: 'MONTHLY',
        periodStart: '2026-03-01',
        periodEnd: '2026-03-31',
        paymentDate: '2026-04-05',
        currencyCode: 'USD',
        notes: 'March 2026 Payroll with Proration',
      },
    });

    expect(runRes.statusCode).toBe(201);
    const runBody = runRes.json();
    const item = runBody.items.find((i: { employeeId: string; basicSalary: string; allowancesTotal: string; grossPay: string }) => i.employeeId === midEmpId);
    expect(item).toBeDefined();

    // Verification of calculation breakdown:
    // March has 31 calendar days.
    // Charlie joined March 16 -> eligible days = 16 (March 16 to 31).
    // Proration factor = 16 / 31 = 0.51612903...
    // Prorated Basic = 3100 * (16 / 31) = 1600.0000
    // Prorated Housing Allowance = 310 * (16 / 31) = 160.0000
    expect(item.basicSalary).toBe('1600.0000');
    expect(item.allowancesTotal).toBe('160.0000');
    expect(item.grossPay).toBe('1760.0000');

    // Check transparent calculation breakdown
    expect(item.calculationBreakdown).toBeDefined();
    expect(item.calculationBreakdown.prorationMode).toBe('CALENDAR_DAYS');
    expect(item.calculationBreakdown.totalCalendarDays).toBe(31);
    expect(item.calculationBreakdown.eligibleEmploymentDays).toBe(16);
    expect(item.calculationBreakdown.originalBasicSalary).toBe('3100.0000');
    expect(item.calculationBreakdown.proratedBasicSalary).toBe('1600.0000');
  });

  // ==========================================================================
  // Section 7: Pre-Calculation Payroll Validation
  // ==========================================================================
  it('7.1 Pre-run payroll validation detects missing salary plan or incomplete data', async () => {
    // Create an employee without salary plan
    await app.inject({
      method: 'POST',
      url: '/v1/employees',
      headers: {
        authorization: `Bearer ${alphaOwnerToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
      payload: {
        employeeCode: 'EMP-NO-SALARY',
        firstName: 'No',
        lastName: 'Salary',
        joinedDate: '2026-04-01',
        designation: 'Intern',
        department: 'Operations',
        payrollFrequency: 'MONTHLY',
        addressLine1: 'No Plan Way',
      },
    });

    const valRes = await app.inject({
      method: 'POST',
      url: '/v1/payroll/runs/validate-pre-run',
      headers: {
        authorization: `Bearer ${alphaOwnerToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
      payload: {
        frequency: 'MONTHLY',
        periodStart: '2026-04-01',
        periodEnd: '2026-04-30',
        paymentDate: '2026-05-05',
        currencyCode: 'USD',
      },
    });

    expect(valRes.statusCode).toBe(200);
    const body = valRes.json();
    expect(body.isValid).toBe(false);
    expect(body.issues.length).toBeGreaterThan(0);
    expect(body.issues.some((i: { type: string }) => i.type === 'MISSING_SALARY_STRUCTURE')).toBe(true);
  });

  // ==========================================================================
  // Section 8: Cross-Tenant Isolation
  // ==========================================================================
  it('8.1 Tenant Beta cannot access Tenant Alpha attendance or employee schedules', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/employees/${employeeId}/work-schedules`,
      headers: {
        authorization: `Bearer ${betaOwnerToken}`,
        'x-tenant-id': TENANT_BETA_ID,
      },
    });

    // Cross-tenant access must return empty list (isolated by tenant_id) or 403
    if (res.statusCode === 200) {
      expect(res.json().length).toBe(0);
    } else {
      expect([403, 404]).toContain(res.statusCode);
    }
  });
});

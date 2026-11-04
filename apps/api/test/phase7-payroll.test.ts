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

const TENANT_ALPHA_ID = '0192b4c0-7777-7000-8000-000000000070';
const TENANT_ALPHA_OWNER = '0192b4c0-7777-7000-8000-000000000071';
const TENANT_ALPHA_STAFF = '0192b4c0-7777-7000-8000-000000000072';

const TENANT_BETA_ID = '0192b4c0-8888-7000-8000-000000000070';
const TENANT_BETA_OWNER = '0192b4c0-8888-7000-8000-000000000071';

describe('@nexstock/api — Phase 7.1: Employee Management & Flexible Payroll Engine', () => {
  let harness: TestPostgresHarness;
  let app: AppInstance;

  const primaryKey = createTestEs256KeyMaterial(
    '01f76c4b-9743-48ad-bed6-a9c89dc99cc7',
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
  let cashierToken: string;
  let accountantToken: string;
  let alphaBranchId: string;
  let alphaWarehouseId: string;

  const CASHIER_USER_ID = '0192b4c0-7777-7000-8000-000000000088';
  const ACCOUNTANT_USER_ID = '0192b4c0-7777-7000-8000-000000000099';

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
        slug: 'alpha-hrm',
        legalName: 'Alpha Enterprises Inc',
        baseCurrency: 'USD',
        defaultLocale: 'en-US',
        defaultTimezone: 'America/New_York',
        countryCode: 'US',
        ownerEmail: 'owner@alpha-hrm.example.com',
        ownerFullName: 'Alpha HRM Admin',
        planCode: 'GROWTH',
      },
    });
    expect(alphaOnboardRes.statusCode).toBe(201);

    // 2. Onboard Tenant Beta
    const betaOnboardRes = await app.inject({
      method: 'POST',
      url: '/v1/org/tenants/onboard',
      headers: {
        authorization: `Bearer ${betaOwnerToken}`,
        'x-tenant-id': TENANT_BETA_ID,
      },
      payload: {
        slug: 'beta-hrm',
        legalName: 'Beta Logistics LLC',
        baseCurrency: 'USD',
        defaultLocale: 'en-US',
        defaultTimezone: 'America/New_York',
        countryCode: 'US',
        ownerEmail: 'owner@beta-hrm.example.com',
        ownerFullName: 'Beta Logistics Owner',
        planCode: 'GROWTH',
      },
    });
    expect(betaOnboardRes.statusCode).toBe(201);

    // 3. Create Alpha Branch & Warehouse
    const branchRes = await app.inject({
      method: 'POST',
      url: '/v1/org/branches',
      headers: {
        authorization: `Bearer ${alphaOwnerToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
      payload: {
        code: 'AHQ-01',
        name: 'Alpha HQ Branch',
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
        branchId: alphaBranchId,
        code: 'AWH-01',
        name: 'Alpha Central Depot',
        allowNegativeStock: false,
      },
    });
    expect(whRes.statusCode).toBe(201);
    alphaWarehouseId = whRes.json().id;

    // 4. Create dummy staff user in Tenant Alpha
    await harness.db
      .insertInto('users')
      .values({
        id: TENANT_ALPHA_STAFF,
        email: 'staff@alpha-hrm.example.com',
        full_name: 'John Staff Doe',
      })
      .execute();
  });

  afterAll(async () => {
    if (app) await app.close();
    if (harness) await harness.db.destroy();
  });

  // ==========================================================================
  // Module 1: Employee Directory & Profiles
  // ==========================================================================
  let employeeAId: string;
  let employeeBId: string;

  it('1.1 Creates an employee with branch and warehouse assignments', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/employees',
      headers: {
        authorization: `Bearer ${alphaOwnerToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
      payload: {
        employeeCode: 'EMP-001',
        firstName: 'Alice',
        lastName: 'Smith',
        displayName: 'Alice Smith',
        email: 'alice.smith@alpha.example.com',
        phone: '+1-555-0199',
        nationalId: 'NIC-99887766V',
        gender: 'Female',
        dateOfBirth: '1992-05-14',
        joinedDate: '2023-01-15',
        designation: 'Senior Accountant',
        department: 'Finance',
        employmentStatus: 'ACTIVE',
        payrollFrequency: 'MONTHLY',
        primaryBranchId: alphaBranchId,
        primaryWarehouseId: alphaWarehouseId,
        bankName: 'Bank of America',
        bankAccountNumber: '9876543210',
        bankBranch: 'Downtown',
        epfNumber: 'EPF-FIN-001',
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toBeDefined();
    expect(body.employeeCode).toBe('EMP-001');
    expect(body.displayName).toBe('Alice Smith');
    expect(body.department).toBe('Finance');
    expect(body.designation).toBe('Senior Accountant');
    expect(body.payrollFrequency).toBe('MONTHLY');
    expect(body.employmentStatus).toBe('ACTIVE');
    expect(body.branchIds).toContain(alphaBranchId);
    expect(body.warehouseIds).toContain(alphaWarehouseId);

    employeeAId = body.id;
  }, 60_000);

  it('1.2 Rejects duplicate employee code in same tenant', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/employees',
      headers: {
        authorization: `Bearer ${alphaOwnerToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
      payload: {
        employeeCode: 'EMP-001',
        firstName: 'Alice',
        lastName: 'Duplicate',
        joinedDate: '2023-01-15',
        designation: 'Accountant',
        department: 'Finance',
      },
    });

    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.errorCode).toBe('HRM_DUPLICATE_EMPLOYEE_CODE');
  });

  it('1.3 Creates a second employee with WEEKLY frequency', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/employees',
      headers: {
        authorization: `Bearer ${alphaOwnerToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
      payload: {
        employeeCode: 'EMP-002',
        firstName: 'Bob',
        lastName: 'Jones',
        joinedDate: '2023-06-01',
        designation: 'Warehouse Operator',
        department: 'Logistics',
        payrollFrequency: 'WEEKLY',
      },
    });

    expect(res.statusCode).toBe(201);
    employeeBId = res.json().id;
  });

  it('1.4 Updates employee details and status', async () => {
    const updateRes = await app.inject({
      method: 'PATCH',
      url: `/v1/employees/${employeeAId}`,
      headers: {
        authorization: `Bearer ${alphaOwnerToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
      payload: {
        phone: '+1-555-9999',
        notes: 'Promoted in Q2',
      },
    });
    expect(updateRes.statusCode).toBe(200);
    expect(updateRes.json().phone).toBe('+1-555-9999');
    expect(updateRes.json().notes).toBe('Promoted in Q2');

    // Update status to PROBATION
    const statusRes = await app.inject({
      method: 'POST',
      url: `/v1/employees/${employeeAId}/status`,
      headers: {
        authorization: `Bearer ${alphaOwnerToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
      payload: {
        status: 'PROBATION',
        reason: 'Performance evaluation period',
      },
    });
    expect(statusRes.statusCode).toBe(200);
    expect(statusRes.json().employmentStatus).toBe('PROBATION');

    // Reset status to ACTIVE
    await app.inject({
      method: 'POST',
      url: `/v1/employees/${employeeAId}/status`,
      headers: {
        authorization: `Bearer ${alphaOwnerToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
      payload: { status: 'ACTIVE' },
    });
  });

  it('1.5 Links and unlinks system user account', async () => {
    const linkRes = await app.inject({
      method: 'POST',
      url: `/v1/employees/${employeeAId}/link-user`,
      headers: {
        authorization: `Bearer ${alphaOwnerToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
      payload: {
        userId: TENANT_ALPHA_STAFF,
      },
    });
    expect(linkRes.statusCode).toBe(200);
    expect(linkRes.json().linkedUserId).toBe(TENANT_ALPHA_STAFF);

    // Attempting to link same user to EMP-002 must return 409
    const conflictRes = await app.inject({
      method: 'POST',
      url: `/v1/employees/${employeeBId}/link-user`,
      headers: {
        authorization: `Bearer ${alphaOwnerToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
      payload: {
        userId: TENANT_ALPHA_STAFF,
      },
    });
    expect(conflictRes.statusCode).toBe(409);
    expect(conflictRes.json().errorCode).toBe('HRM_USER_ALREADY_LINKED');

    // Unlink user from EMP-001
    const unlinkRes = await app.inject({
      method: 'POST',
      url: `/v1/employees/${employeeAId}/link-user`,
      headers: {
        authorization: `Bearer ${alphaOwnerToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
      payload: {
        userId: null,
      },
    });
    expect(unlinkRes.statusCode).toBe(200);
    expect(unlinkRes.json().linkedUserId).toBeNull();
  });

  it('1.6 Lists employees with search and department filtering', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/employees?search=Alice&department=Finance',
      headers: {
        authorization: `Bearer ${alphaOwnerToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items.length).toBe(1);
    expect(body.items[0].employeeCode).toBe('EMP-001');
    expect(body.total).toBe(1);
  });

  // ==========================================================================
  // Module 2: Document Management (MIME & Magic Bytes Verification)
  // ==========================================================================
  let documentId: string;

  it('2.1 Uploads valid PDF document and validates magic bytes', async () => {
    // Valid PDF starts with %PDF-1.4 ...
    const pdfBuffer = Buffer.from('%PDF-1.4\n%âãÏÓ\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF');
    const res = await app.inject({
      method: 'POST',
      url: `/v1/employees/${employeeAId}/documents`,
      headers: {
        authorization: `Bearer ${alphaOwnerToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
      payload: {
        documentCategory: 'NIC_PASSPORT',
        documentTitle: 'National ID Card Copy',
        fileName: 'national_id_scan.pdf',
        mimeType: 'application/pdf',
        dataBase64: pdfBuffer.toString('base64'),
        notes: 'Verified against original',
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toBeDefined();
    expect(body.documentCategory).toBe('NIC_PASSPORT');
    expect(body.fileName).toBe('national_id_scan.pdf');
    expect(body.fileSize).toBe(pdfBuffer.length);
    documentId = body.id;
  });

  it('2.2 Rejects corrupted document content with mismatched magic bytes', async () => {
    // Content is fake text, not a real PDF
    const fakeBuffer = Buffer.from('NOT_A_REAL_PDF_HEADER');
    const res = await app.inject({
      method: 'POST',
      url: `/v1/employees/${employeeAId}/documents`,
      headers: {
        authorization: `Bearer ${alphaOwnerToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
      payload: {
        documentCategory: 'CONTRACT',
        documentTitle: 'Employment Contract',
        fileName: 'contract.pdf',
        mimeType: 'application/pdf',
        dataBase64: fakeBuffer.toString('base64'),
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().errorCode).toBe('HRM_INVALID_DOCUMENT_TYPE');
  });

  it('2.3 Rejects unsupported file MIME type', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/employees/${employeeAId}/documents`,
      headers: {
        authorization: `Bearer ${alphaOwnerToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
      payload: {
        documentCategory: 'OTHER',
        documentTitle: 'Executable File',
        fileName: 'malicious.exe',
        mimeType: 'application/x-msdownload',
        dataBase64: Buffer.from('MZ...').toString('base64'),
      },
    });

    expect(res.statusCode).toBe(415);
    expect(res.json().errorCode).toBe('HRM_INVALID_DOCUMENT_TYPE');
  });

  it('2.4 Lists employee documents and downloads content', async () => {
    const listRes = await app.inject({
      method: 'GET',
      url: `/v1/employees/${employeeAId}/documents`,
      headers: {
        authorization: `Bearer ${alphaOwnerToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
    });
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json().length).toBeGreaterThanOrEqual(1);

    const contentRes = await app.inject({
      method: 'GET',
      url: `/v1/employees/${employeeAId}/documents/${documentId}/content`,
      headers: {
        authorization: `Bearer ${alphaOwnerToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
    });
    expect(contentRes.statusCode).toBe(200);
    const content = contentRes.json();
    expect(content.fileName).toBe('national_id_scan.pdf');
    expect(content.mimeType).toBe('application/pdf');
    expect(content.dataBase64).toBeDefined();
  });

  // ==========================================================================
  // Module 3: Flexible Salary Structures
  // ==========================================================================
  it('3.1 Creates salary structure with fixed and percentage components', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/employees/${employeeAId}/salary-structure`,
      headers: {
        authorization: `Bearer ${alphaOwnerToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
      payload: {
        effectiveFrom: '2023-01-01',
        basicSalary: '4000.0000',
        currencyCode: 'USD',
        paymentMethod: 'BANK_TRANSFER',
        notes: 'Initial salary plan',
        components: [
          {
            componentType: 'EARNING',
            componentName: 'Housing Allowance',
            calculationType: 'FIXED_AMOUNT',
            componentValue: '500.0000',
            isTaxable: true,
            isStatutory: false,
          },
          {
            componentType: 'EARNING',
            componentName: 'Transport Allowance',
            calculationType: 'PERCENTAGE_OF_BASIC',
            componentValue: '10.0000', // 10% of 4000 = 400.0000
            isTaxable: false,
            isStatutory: false,
          },
          {
            componentType: 'DEDUCTION',
            componentName: 'EPF Employee',
            calculationType: 'PERCENTAGE_OF_BASIC',
            componentValue: '8.0000', // 8% of 4000 = 320.0000
            isTaxable: false,
            isStatutory: true,
          },
          {
            componentType: 'DEDUCTION',
            componentName: 'Medical Insurance',
            calculationType: 'FIXED_AMOUNT',
            componentValue: '80.0000',
            isTaxable: false,
            isStatutory: false,
          },
        ],
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.basicSalary).toBe('4000.0000');
    expect(body.components.length).toBe(4);
    expect(body.isActive).toBe(true);

    // Also set salary structure for Bob (EMP-002)
    const bobRes = await app.inject({
      method: 'POST',
      url: `/v1/employees/${employeeBId}/salary-structure`,
      headers: {
        authorization: `Bearer ${alphaOwnerToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
      payload: {
        effectiveFrom: '2023-06-01',
        basicSalary: '800.0000',
        currencyCode: 'USD',
        paymentMethod: 'CASH',
        components: [],
      },
    });
    expect(bobRes.statusCode).toBe(201);
  });

  it('3.2 Retrieves active salary structure and full profile', async () => {
    const profileRes = await app.inject({
      method: 'GET',
      url: `/v1/employees/${employeeAId}/profile`,
      headers: {
        authorization: `Bearer ${alphaOwnerToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
    });
    expect(profileRes.statusCode).toBe(200);
    const profile = profileRes.json();
    expect(profile.employee.employeeCode).toBe('EMP-001');
    expect(profile.activeSalaryStructure).not.toBeNull();
    expect(profile.activeSalaryStructure.basicSalary).toBe('4000.0000');
    expect(profile.documents.length).toBeGreaterThanOrEqual(1);
    expect(profile.recentActivity).toBeDefined();
  });

  // ==========================================================================
  // Module 4: Payroll Run Calculation, Adjustments, Approval & Payments
  // ==========================================================================
  let payrollRunId: string;
  let payrollItemId: string;

  it('4.1 Creates MONTHLY payroll run with exact Money calculations', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/payroll/runs',
      headers: {
        authorization: `Bearer ${alphaOwnerToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
      payload: {
        frequency: 'MONTHLY',
        periodStart: '2023-01-01',
        periodEnd: '2023-01-31',
        paymentDate: '2023-02-05',
        currencyCode: 'USD',
        notes: 'January 2023 Monthly Payroll',
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.runNumber).toBeDefined();
    expect(body.frequency).toBe('MONTHLY');
    expect(body.status).toBe('DRAFT');
    expect(body.employeeCount).toBe(1); // Only Alice is MONTHLY

    // Alice's line item:
    // Basic = 4000.0000
    // Housing Allowance = 500.0000
    // Transport Allowance (10%) = 400.0000
    // Total Allowances = 900.0000
    // Gross Pay = 4900.0000
    // EPF Employee (8%) = 320.0000
    // Medical Insurance = 80.0000
    // Total Deductions = 400.0000
    // Net Pay = 4500.0000
    expect(body.totalGrossPay).toBe('4900.0000');
    expect(body.totalDeductions).toBe('400.0000');
    expect(body.totalNetPay).toBe('4500.0000');
    expect(body.totalPaidAmount).toBe('0.0000');

    const item = body.items[0];
    expect(item.employeeCode).toBe('EMP-001');
    expect(item.basicSalary).toBe('4000.0000');
    expect(item.allowancesTotal).toBe('900.0000');
    expect(item.grossPay).toBe('4900.0000');
    expect(item.deductionsTotal).toBe('400.0000');
    expect(item.netPay).toBe('4500.0000');
    expect(item.paymentStatus).toBe('UNPAID');

    payrollRunId = body.id;
    payrollItemId = item.id;
  });

  it('4.2 Updates payroll item adjustments in DRAFT state', async () => {
    // Add 10 hrs overtime @ 250.0000, plus 150.0000 bonus
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/payroll/runs/${payrollRunId}/items/${payrollItemId}`,
      headers: {
        authorization: `Bearer ${alphaOwnerToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
      payload: {
        overtimeHours: '10.0000',
        overtimePay: '250.0000',
        bonusPay: '150.0000',
        notes: 'Project completion incentive',
      },
    });

    expect(res.statusCode).toBe(200);
    const item = res.json();
    expect(item.overtimeHours).toBe('10.0000');
    expect(item.overtimePay).toBe('250.0000');
    expect(item.bonusPay).toBe('150.0000');

    // New Gross = 4900 + 250 + 150 = 5300.0000
    // Deductions = 400.0000
    // New Net = 4900.0000
    expect(item.grossPay).toBe('5300.0000');
    expect(item.netPay).toBe('4900.0000');

    // Verify run totals updated
    const runRes = await app.inject({
      method: 'GET',
      url: `/v1/payroll/runs/${payrollRunId}`,
      headers: {
        authorization: `Bearer ${alphaOwnerToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
    });
    expect(runRes.json().totalGrossPay).toBe('5300.0000');
    expect(runRes.json().totalNetPay).toBe('4900.0000');
  });

  it('4.3 Submits for approval and approves payroll run (BUG-046: handles JSON payload without empty body error)', async () => {
    const submitRes = await app.inject({
      method: 'POST',
      url: `/v1/payroll/runs/${payrollRunId}/submit`,
      headers: {
        authorization: `Bearer ${alphaOwnerToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
        'content-type': 'application/json',
      },
      payload: {},
    });
    expect(submitRes.statusCode).toBe(200);
    expect(submitRes.json().status).toBe('PENDING_APPROVAL');

    const approveRes = await app.inject({
      method: 'POST',
      url: `/v1/payroll/runs/${payrollRunId}/approve`,
      headers: {
        authorization: `Bearer ${alphaOwnerToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
        'content-type': 'application/json',
      },
      payload: { notes: 'Approved for disbursement' },
    });
    expect(approveRes.statusCode).toBe(200);
    expect(approveRes.json().status).toBe('APPROVED');
    expect(approveRes.json().approvedByUserId).toBe(TENANT_ALPHA_OWNER);
    expect(approveRes.json().approvedAt).toBeDefined();
  });

  it('4.4 Rejects modifying items once run is APPROVED (Immutability)', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/payroll/runs/${payrollRunId}/items/${payrollItemId}`,
      headers: {
        authorization: `Bearer ${alphaOwnerToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
      payload: {
        bonusPay: '999.0000',
      },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().errorCode).toBe('HRM_PAYROLL_RUN_IMMUTABLE');
  });

  it('4.5 Records partial payment and verifies balance due tracking', async () => {
    // Total Net is 4900.0000. Pay 2000.0000
    const payment1Res = await app.inject({
      method: 'POST',
      url: `/v1/payroll/runs/${payrollRunId}/payments`,
      headers: {
        authorization: `Bearer ${alphaOwnerToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
      payload: {
        itemId: payrollItemId,
        paymentMethod: 'BANK_TRANSFER',
        paymentAmount: '2000.0000',
        currencyCode: 'USD',
        paymentDate: '2023-02-05',
        referenceNumber: 'TXN-PAY-001',
      },
    });

    expect(payment1Res.statusCode).toBe(201);
    expect(payment1Res.json().paymentAmount).toBe('2000.0000');

    // Run status should now be PARTIALLY_PAID
    const runRes = await app.inject({
      method: 'GET',
      url: `/v1/payroll/runs/${payrollRunId}`,
      headers: {
        authorization: `Bearer ${alphaOwnerToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
    });
    expect(runRes.json().status).toBe('PARTIALLY_PAID');
    expect(runRes.json().totalPaidAmount).toBe('2000.0000');
    expect(runRes.json().items[0].paymentStatus).toBe('PARTIALLY_PAID');
  });

  it('4.6 Rejects overpayment exceeding remaining balance', async () => {
    // Remaining balance is 4900 - 2000 = 2900.0000
    // Attempting to pay 3000.0000 must fail
    const overpayRes = await app.inject({
      method: 'POST',
      url: `/v1/payroll/runs/${payrollRunId}/payments`,
      headers: {
        authorization: `Bearer ${alphaOwnerToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
      payload: {
        itemId: payrollItemId,
        paymentMethod: 'BANK_TRANSFER',
        paymentAmount: '3000.0000',
        currencyCode: 'USD',
        paymentDate: '2023-02-05',
      },
    });

    expect(overpayRes.statusCode).toBe(400);
    expect(overpayRes.json().errorCode).toBe('HRM_OVERPAYMENT_NOT_ALLOWED');
  });

  it('4.7 Records remaining payment and transitions item and run to PAID', async () => {
    const payment2Res = await app.inject({
      method: 'POST',
      url: `/v1/payroll/runs/${payrollRunId}/payments`,
      headers: {
        authorization: `Bearer ${alphaOwnerToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
      payload: {
        itemId: payrollItemId,
        paymentMethod: 'BANK_TRANSFER',
        paymentAmount: '2900.0000',
        currencyCode: 'USD',
        paymentDate: '2023-02-06',
        referenceNumber: 'TXN-PAY-002',
      },
    });

    expect(payment2Res.statusCode).toBe(201);

    const runRes = await app.inject({
      method: 'GET',
      url: `/v1/payroll/runs/${payrollRunId}`,
      headers: {
        authorization: `Bearer ${alphaOwnerToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
    });
    expect(runRes.json().status).toBe('PAID');
    expect(runRes.json().totalPaidAmount).toBe('4900.0000');
    expect(runRes.json().items[0].paymentStatus).toBe('PAID');
  });

  // ==========================================================================
  // Module 5: Payslip Generation & Reports
  // ==========================================================================
  it('5.1 Generates detailed printable payslip', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/payroll/runs/${payrollRunId}/payslips/${employeeAId}`,
      headers: {
        authorization: `Bearer ${alphaOwnerToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
    });

    expect(res.statusCode).toBe(200);
    const slip = res.json();
    expect(slip.tenantName).toBe('Alpha Enterprises Inc');
    expect(slip.employee.fullName).toBe('Alice Smith');
    expect(slip.employee.designation).toBe('Senior Accountant');
    expect(slip.earningsBreakdown.length).toBeGreaterThan(1);
    expect(slip.deductionsBreakdown.length).toBeGreaterThan(1);
    expect(slip.item.grossPay).toBe('5300.0000');
    expect(slip.item.netPay).toBe('4900.0000');
    expect(slip.item.paymentStatus).toBe('PAID');
  });

  it('5.2 Generates payroll summary report with department breakdowns', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/payroll/reports/summary',
      headers: {
        authorization: `Bearer ${alphaOwnerToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
    });

    expect(res.statusCode).toBe(200);
    const report = res.json();
    expect(report.runsCount).toBe(1);
    expect(report.totalGross).toBe('5300.0000');
    expect(report.totalNet).toBe('4900.0000');
    expect(report.totalPaid).toBe('4900.0000');
    expect(report.totalUnpaid).toBe('0.0000');
    expect(report.byDepartment.some((d: { department: string }) => d.department === 'Finance')).toBe(true);
  });

  // ==========================================================================
  // Module 6: Strict Multi-Tenant Isolation
  // ==========================================================================
  it('6.1 Prevents cross-tenant access to employees and payroll runs', async () => {
    // Tenant Beta tries to access Tenant Alpha's employee
    const empRes = await app.inject({
      method: 'GET',
      url: `/v1/employees/${employeeAId}`,
      headers: {
        authorization: `Bearer ${betaOwnerToken}`,
        'x-tenant-id': TENANT_BETA_ID,
      },
    });
    expect(empRes.statusCode).toBe(404);

    // Tenant Beta tries to access Tenant Alpha's payroll run
    const runRes = await app.inject({
      method: 'GET',
      url: `/v1/payroll/runs/${payrollRunId}`,
      headers: {
        authorization: `Bearer ${betaOwnerToken}`,
        'x-tenant-id': TENANT_BETA_ID,
      },
    });
    expect(runRes.statusCode).toBe(404);
  });

  // ==========================================================================
  // Module 7: Phase 7.1 QA Remediation (BUG-034, BUG-035, BUG-036)
  // ==========================================================================
  describe('7. QA Remediation: Permissions, Reports & Warehouse Discovery', () => {
    beforeAll(async () => {
      // 1. Create cashier and accountant users in database
      await harness.db
        .insertInto('users')
        .values([
          {
            id: CASHIER_USER_ID,
            email: 'cashier@alpha-hrm.example.com',
            full_name: 'Alpha POS Cashier',
          },
          {
            id: ACCOUNTANT_USER_ID,
            email: 'accountant@alpha-hrm.example.com',
            full_name: 'Alpha Staff Accountant',
          },
        ])
        .execute();

      // 2. Provision tenant memberships with respective system roles
      await withTenantTransaction(
        harness.db,
        {
          tenantId: TENANT_ALPHA_ID,
          userId: TENANT_ALPHA_OWNER,
          traceId: generateUuidV7(),
        },
        async (trx) => {
          await provisionTenantMember(trx, {
            userId: CASHIER_USER_ID,
            email: 'cashier@alpha-hrm.example.com',
            fullName: 'Alpha POS Cashier',
            roleCodes: ['CASHIER'],
            allLocationsAccess: false,
            branchIds: [alphaBranchId],
          });

          await provisionTenantMember(trx, {
            userId: ACCOUNTANT_USER_ID,
            email: 'accountant@alpha-hrm.example.com',
            fullName: 'Alpha Staff Accountant',
            roleCodes: ['ACCOUNTANT'],
            allLocationsAccess: true,
          });
        },
      );

      // 3. Issue valid asymmetric ES256 Bearer JWTs
      cashierToken = issueToken(CASHIER_USER_ID, 'cashier@alpha-hrm.example.com');
      accountantToken = issueToken(ACCOUNTANT_USER_ID, 'accountant@alpha-hrm.example.com');
    }, 60_000);

    it('BUG-034: enforces employee permissions (Owner/Accountant allowed, Cashier rejected) and auto-heals legacy tenant permissions', async () => {
      // 1. Cashier lacks hrm:employee:read -> 403 Forbidden
      const cashierReadRes = await app.inject({
        method: 'GET',
        url: '/v1/employees',
        headers: {
          authorization: `Bearer ${cashierToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });
      expect(cashierReadRes.statusCode).toBe(403);
      expect(cashierReadRes.json().errorCode).toBe('IAM_PERMISSION_DENIED');
      expect(cashierReadRes.json().detail).toContain('hrm:employee:read');

      // 2. Cashier lacks hrm:employee:manage -> 403 Forbidden
      const cashierCreateRes = await app.inject({
        method: 'POST',
        url: '/v1/employees',
        headers: {
          authorization: `Bearer ${cashierToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          employeeCode: 'EMP-UNAUTH',
          firstName: 'Unauthorized',
          lastName: 'Cashier',
          designation: 'Clerk',
          department: 'Sales',
          joinedDate: '2026-01-01',
        },
      });
      expect(cashierCreateRes.statusCode).toBe(403);
      expect(cashierCreateRes.json().errorCode).toBe('IAM_PERMISSION_DENIED');

      // 3. Accountant has hrm:employee:read -> 200 OK
      const accountantReadRes = await app.inject({
        method: 'GET',
        url: '/v1/employees',
        headers: {
          authorization: `Bearer ${accountantToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });
      expect(accountantReadRes.statusCode).toBe(200);

      // 4. Simulate legacy tenant with missing role_permissions in database
      // Delete all hrm:* permissions for TENANT_OWNER role in Tenant Alpha
      const ownerRole = await harness.db
        .selectFrom('roles')
        .select(['id'])
        .where('tenant_id', '=', TENANT_ALPHA_ID)
        .where('code', '=', 'TENANT_OWNER')
        .executeTakeFirst();
      expect(ownerRole).toBeDefined();

      await harness.db
        .deleteFrom('role_permissions')
        .where('tenant_id', '=', TENANT_ALPHA_ID)
        .where('role_id', '=', ownerRole!.id)
        .where('permission_key', 'like', 'hrm:%')
        .execute();

      // Verify permissions are gone from database
      const deletedPerms = await harness.db
        .selectFrom('role_permissions')
        .select(['permission_key'])
        .where('tenant_id', '=', TENANT_ALPHA_ID)
        .where('role_id', '=', ownerRole!.id)
        .where('permission_key', 'like', 'hrm:%')
        .execute();
      expect(deletedPerms.length).toBe(0);

      // Call GET /v1/employees as Owner -> must succeed and self-heal missing permissions in DB!
      const ownerHealedRes = await app.inject({
        method: 'GET',
        url: '/v1/employees',
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });
      expect(ownerHealedRes.statusCode).toBe(200);

      // Verify permissions were automatically restored into the database
      const restoredPerms = await harness.db
        .selectFrom('role_permissions')
        .select(['permission_key'])
        .where('tenant_id', '=', TENANT_ALPHA_ID)
        .where('role_id', '=', ownerRole!.id)
        .where('permission_key', 'like', 'hrm:%')
        .execute();
      expect(restoredPerms.length).toBeGreaterThan(0);
    });

    it('BUG-035: authorizes Owner and Accountant to read payroll reports, while rejecting Cashier', async () => {
      // 1. Owner can access payroll summary reports
      const ownerReportRes = await app.inject({
        method: 'GET',
        url: '/v1/payroll/reports/summary',
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });
      expect(ownerReportRes.statusCode).toBe(200);
      expect(ownerReportRes.json().totalGross).toBeDefined();

      // 2. Accountant can access payroll summary reports
      const accountantReportRes = await app.inject({
        method: 'GET',
        url: '/v1/payroll/reports/summary',
        headers: {
          authorization: `Bearer ${accountantToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });
      expect(accountantReportRes.statusCode).toBe(200);
      expect(accountantReportRes.json().totalGross).toBeDefined();

      // 3. Cashier lacks hrm:payroll:read -> 403 Forbidden
      const cashierReportRes = await app.inject({
        method: 'GET',
        url: '/v1/payroll/reports/summary',
        headers: {
          authorization: `Bearer ${cashierToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });
      expect(cashierReportRes.statusCode).toBe(403);
      expect(cashierReportRes.json().errorCode).toBe('IAM_PERMISSION_DENIED');
      expect(cashierReportRes.json().detail).toContain('hrm:payroll:read');

      // 4. Cashier cannot access payroll runs
      const cashierRunsRes = await app.inject({
        method: 'GET',
        url: '/v1/payroll/runs',
        headers: {
          authorization: `Bearer ${cashierToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });
      expect(cashierRunsRes.statusCode).toBe(403);
      expect(cashierRunsRes.json().errorCode).toBe('IAM_PERMISSION_DENIED');

      // 5. Accountant cannot perform employee administrative updates (least-privilege check)
      const accountantUpdateEmpRes = await app.inject({
        method: 'PATCH',
        url: `/v1/employees/${employeeAId}`,
        headers: {
          authorization: `Bearer ${accountantToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          designation: 'Unauthorized Modification',
        },
      });
      expect(accountantUpdateEmpRes.statusCode).toBe(403);
      expect(accountantUpdateEmpRes.json().errorCode).toBe('IAM_PERMISSION_DENIED');
      expect(accountantUpdateEmpRes.json().detail).toContain('hrm:employee:manage');
    });

    it('BUG-036: GET /v1/org/warehouses returns tenant warehouses, supports branch filtering, and isolates cross-tenant access', async () => {
      // 1. GET /v1/org/warehouses returns all warehouses for tenant
      const whListRes = await app.inject({
        method: 'GET',
        url: '/v1/org/warehouses',
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });
      expect(whListRes.statusCode).toBe(200);
      const whList = whListRes.json();
      expect(Array.isArray(whList.items)).toBe(true);
      expect(whList.items.length).toBeGreaterThan(0);
      expect(whList.items.some((w: { id: string }) => w.id === alphaWarehouseId)).toBe(true);

      // 2. GET /v1/org/warehouses with valid branchId filter
      const whFilteredRes = await app.inject({
        method: 'GET',
        url: `/v1/org/warehouses?branchId=${alphaBranchId}`,
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });
      expect(whFilteredRes.statusCode).toBe(200);
      const filteredList = whFilteredRes.json();
      expect(filteredList.items.length).toBeGreaterThan(0);
      expect(filteredList.items[0].id).toBe(alphaWarehouseId);

      // 3. GET /v1/org/warehouses with non-matching branchId returns empty items list
      const nonMatchingBranchId = '0192b4c0-9999-7000-8000-000000000099';
      const emptyBranchRes = await app.inject({
        method: 'GET',
        url: `/v1/org/warehouses?branchId=${nonMatchingBranchId}`,
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });
      expect(emptyBranchRes.statusCode).toBe(200);
      expect(emptyBranchRes.json().items).toEqual([]);

      // 4. GET /v1/org/warehouses/:warehouseId retrieves specific warehouse
      const singleWhRes = await app.inject({
        method: 'GET',
        url: `/v1/org/warehouses/${alphaWarehouseId}`,
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });
      expect(singleWhRes.statusCode).toBe(200);
      expect(singleWhRes.json().id).toBe(alphaWarehouseId);
      expect(singleWhRes.json().code).toBe('AWH-01');
      expect(singleWhRes.json().name).toBe('Alpha Central Depot');

      // 5. Cross-tenant warehouse access is rejected (strict tenant isolation)
      const crossTenantWhRes = await app.inject({
        method: 'GET',
        url: `/v1/org/warehouses/${alphaWarehouseId}`,
        headers: {
          authorization: `Bearer ${betaOwnerToken}`,
          'x-tenant-id': TENANT_BETA_ID,
        },
      });
      expect(crossTenantWhRes.statusCode).toBe(404);
    });
  });

  // ==========================================================================
  // 8. Phase 7.1 QA Remediation Regression Tests (BUG-038 & Optional Fields)
  // ==========================================================================
  describe('8. Phase 7.1 QA Remediation (BUG-038: Optional Fields Handling)', () => {
    it('8.1 BUG-038: updates employee with null, empty, and undefined optional fields without 400 validation error', async () => {
      // 1. Create employee with optional fields populated
      const createRes = await app.inject({
        method: 'POST',
        url: '/v1/employees',
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          employeeCode: 'EMP-OPT-01',
          firstName: 'Alice',
          lastName: 'Optional',
          designation: 'Staff Analyst',
          department: 'Operations',
          joinedDate: '2026-03-01',
          nationalId: 'NIC-987654321',
          bankName: 'Alpha Commercial Bank',
          bankAccountNumber: 'ACC-11223344',
          epfNumber: 'EPF-998877',
          addressLine1: '123 Enterprise Avenue',
          notes: 'Initial employee notes',
          primaryBranchId: alphaBranchId,
          primaryWarehouseId: alphaWarehouseId,
        },
      });
      expect(createRes.statusCode).toBe(201);
      const empId = createRes.json().id;
      expect(createRes.json().nationalId).toBe('NIC-987654321');
      expect(createRes.json().bankName).toBe('Alpha Commercial Bank');

      // 2. PATCH with optional fields explicitly set to null (unsetting them) - MUST SUCCEED (BUG-038)
      const patchNullRes = await app.inject({
        method: 'PATCH',
        url: `/v1/employees/${empId}`,
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          nationalId: null,
          bankName: null,
          bankAccountNumber: null,
          epfNumber: null,
          addressLine1: null,
          notes: null,
          primaryBranchId: null,
          primaryWarehouseId: null,
        },
      });
      expect(patchNullRes.statusCode).toBe(200);
      const updatedNull = patchNullRes.json();
      expect(updatedNull.nationalId).toBeNull();
      expect(updatedNull.bankName).toBeNull();
      expect(updatedNull.bankAccountNumber).toBeNull();
      expect(updatedNull.epfNumber).toBeNull();
      expect(updatedNull.addressLine1).toBeNull();
      expect(updatedNull.notes).toBeNull();
      expect(updatedNull.primaryBranchId).toBeNull();
      expect(updatedNull.primaryWarehouseId).toBeNull();
      // Required and untouched fields are preserved
      expect(updatedNull.firstName).toBe('Alice');
      expect(updatedNull.lastName).toBe('Optional');
      expect(updatedNull.employeeCode).toBe('EMP-OPT-01');

      // 3. PATCH with empty string "" optional fields - normalized to null and succeeds
      const patchEmptyStrRes = await app.inject({
        method: 'PATCH',
        url: `/v1/employees/${empId}`,
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          nationalId: '',
          bankName: '',
          notes: '',
        },
      });
      expect(patchEmptyStrRes.statusCode).toBe(200);
      expect(patchEmptyStrRes.json().nationalId).toBeNull();

      // 4. PATCH with partial update (only changing designation) - preserves all existing fields
      const patchPartialRes = await app.inject({
        method: 'PATCH',
        url: `/v1/employees/${empId}`,
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          designation: 'Senior Lead Analyst',
        },
      });
      expect(patchPartialRes.statusCode).toBe(200);
      expect(patchPartialRes.json().designation).toBe('Senior Lead Analyst');
      expect(patchPartialRes.json().department).toBe('Operations');
    });

    it('8.2 BUG-038: rejects invalid employee updates with missing required fields or malformed data', async () => {
      const getRes = await app.inject({
        method: 'GET',
        url: '/v1/employees?limit=1',
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });
      const empId = getRes.json().items[0].id;

      // 1. Cannot set required string to empty minLength violation
      const invalidRes = await app.inject({
        method: 'PATCH',
        url: `/v1/employees/${empId}`,
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          firstName: '',
        },
      });
      expect(invalidRes.statusCode).toBe(400);

      // 2. Cannot send unknown unexpected property (strict additionalProperties: false)
      const extraPropRes = await app.inject({
        method: 'PATCH',
        url: `/v1/employees/${empId}`,
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          unknownField: 'malicious-data',
        },
      });
      expect(extraPropRes.statusCode).toBe(400);
    });
  });

  // ==========================================================================
  // 9. Phase 7.2: Advanced Permissions & Granular Role Management Integration
  // ==========================================================================
  describe('9. Phase 7.2: Advanced Permissions & Granular Role Management', () => {
    let customRoleId: string;
    let cashierMembershipId: string;

    it('9.1 Permissions Catalog: GET /v1/iam/permissions returns 20 modules with structured actions', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/iam/permissions',
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });

      expect(res.statusCode).toBe(200);
      const catalog = res.json();
      expect(catalog.modules.length).toBeGreaterThanOrEqual(20);
      expect(catalog.allKeys.length).toBeGreaterThanOrEqual(50);

      // Check key modules
      const moduleNames = catalog.modules.map((m: { module: string }) => m.module);
      expect(moduleNames).toContain('Dashboard');
      expect(moduleNames).toContain('Products');
      expect(moduleNames).toContain('POS Checkout');
      expect(moduleNames).toContain('Employees');
      expect(moduleNames).toContain('Payroll');
      expect(moduleNames).toContain('Organization Settings');

      // Verify permission item attributes
      const dashModule = catalog.modules.find((m: { module: string }) => m.module === 'Dashboard');
      expect(dashModule.permissions[0].key).toBe('dash:view');
      expect(dashModule.permissions[0].action).toBe('View');
      expect(dashModule.permissions[0].name).toBe('View Dashboard');
    });

    it('9.2 List Roles: GET /v1/iam/roles returns system and custom roles with member counts', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/iam/roles',
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });

      expect(res.statusCode).toBe(200);
      const roles = res.json();
      expect(roles.length).toBeGreaterThanOrEqual(7);

      const ownerRole = roles.find((r: { code: string }) => r.code === 'TENANT_OWNER');
      expect(ownerRole).toBeDefined();
      expect(ownerRole.isSystemRole).toBe(true);
      expect(ownerRole.memberCount).toBeGreaterThanOrEqual(1);
      expect(ownerRole.description).toBeTruthy();
    });

    it('9.3 Create Custom Role: POST /v1/iam/roles creates role and prevents privilege escalation', async () => {
      // 1. Cashier attempts to create a role (fails - lacks iam:role:manage)
      const unauthRes = await app.inject({
        method: 'POST',
        url: '/v1/iam/roles',
        headers: {
          authorization: `Bearer ${cashierToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          code: 'TEST_UNAUTH_ROLE',
          name: 'Unauthorized Role',
          permissions: ['cat:product:read'],
        },
      });
      expect(unauthRes.statusCode).toBe(403);

      // 2. Attempting to use a reserved system role code is rejected (422)
      const reservedRes = await app.inject({
        method: 'POST',
        url: '/v1/iam/roles',
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          code: 'TENANT_OWNER',
          name: 'Fake Owner',
          permissions: ['cat:product:read'],
        },
      });
      expect(reservedRes.statusCode).toBe(422);

      // 3. Accountant attempts to create a role with sub:subscription:manage (Privilege Escalation Denial)
      // Note: Accountant has iam:member:manage? Wait, Accountant does NOT have iam:role:manage.
      // But if an actor with iam:role:manage tries to grant permissions they don't possess:
      // Let's create custom role as Tenant Owner (who possesses all permissions) -> SUCCEEDS
      const createRes = await app.inject({
        method: 'POST',
        url: '/v1/iam/roles',
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          code: 'STOCK_SUPERVISOR',
          name: 'Stock Inventory Supervisor',
          description: 'Specialized role for inventory auditing and count verification.',
          permissions: [
            'cat:product:read',
            'inv:balance:read',
            'inv:movement:read',
            'inv:count:read',
            'inv:count:approve',
          ],
        },
      });
      expect(createRes.statusCode).toBe(201);
      customRoleId = createRes.json().id;
      expect(createRes.json().code).toBe('STOCK_SUPERVISOR');
      expect(createRes.json().isSystemRole).toBe(false);
      expect(createRes.json().permissions).toHaveLength(5);
      expect(createRes.json().permissions).toContain('inv:count:approve');

      // 4. Duplicate role code is rejected with 409
      const dupRes = await app.inject({
        method: 'POST',
        url: '/v1/iam/roles',
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          code: 'STOCK_SUPERVISOR',
          name: 'Another Supervisor',
          permissions: ['cat:product:read'],
        },
      });
      expect(dupRes.statusCode).toBe(409);
    });

    it('9.4 Built-in System Role Protection: rejects modification and deletion of system roles (403)', async () => {
      // Find TENANT_OWNER role ID
      const rolesRes = await app.inject({
        method: 'GET',
        url: '/v1/iam/roles',
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });
      const ownerRole = rolesRes.json().find((r: { code: string }) => r.code === 'TENANT_OWNER');

      // 1. Attempting to PATCH built-in system role throws 403 IAM_SYSTEM_ROLE_PROTECTED
      const patchSysRes = await app.inject({
        method: 'PATCH',
        url: `/v1/iam/roles/${ownerRole.id}`,
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          name: 'Hacked Owner',
        },
      });
      expect(patchSysRes.statusCode).toBe(403);
      expect(patchSysRes.json().errorCode).toBe('IAM_SYSTEM_ROLE_PROTECTED');

      // 2. Attempting to DELETE built-in system role throws 403 IAM_SYSTEM_ROLE_PROTECTED
      const deleteSysRes = await app.inject({
        method: 'DELETE',
        url: `/v1/iam/roles/${ownerRole.id}`,
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });
      expect(deleteSysRes.statusCode).toBe(403);
      expect(deleteSysRes.json().errorCode).toBe('IAM_SYSTEM_ROLE_PROTECTED');
    });

    it('9.5 Edit & Manage Custom Role: PATCH updates permissions and details', async () => {
      // 1. Update custom role name and add a new permission
      const updateRes = await app.inject({
        method: 'PATCH',
        url: `/v1/iam/roles/${customRoleId}`,
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          name: 'Senior Stock Supervisor',
          permissions: [
            'cat:product:read',
            'inv:balance:read',
            'inv:movement:read',
            'inv:count:read',
            'inv:count:approve',
            'inv:count:post', // added permission
          ],
        },
      });
      expect(updateRes.statusCode).toBe(200);
      expect(updateRes.json().name).toBe('Senior Stock Supervisor');
      expect(updateRes.json().permissions).toHaveLength(6);
      expect(updateRes.json().permissions).toContain('inv:count:post');

      // 2. GET /v1/iam/roles/:roleId verifies persistence
      const getDetailRes = await app.inject({
        method: 'GET',
        url: `/v1/iam/roles/${customRoleId}`,
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });
      expect(getDetailRes.statusCode).toBe(200);
      expect(getDetailRes.json().name).toBe('Senior Stock Supervisor');
      expect(getDetailRes.json().permissions).toContain('inv:count:post');
    });

    it('9.6 Member Role Management: lists members and assigns custom roles', async () => {
      // 1. GET /v1/iam/members
      const membersRes = await app.inject({
        method: 'GET',
        url: '/v1/iam/members',
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });
      expect(membersRes.statusCode).toBe(200);
      const members = membersRes.json();
      expect(members.length).toBeGreaterThanOrEqual(1);

      // Find Cashier member
      const cashierMember = members.find((m: { email: string }) => m.email.includes('cashier'));
      expect(cashierMember).toBeDefined();
      cashierMembershipId = cashierMember.id;

      // 2. Assign custom role alongside existing CASHIER role
      // Fetch CASHIER role id
      const rolesRes = await app.inject({
        method: 'GET',
        url: '/v1/iam/roles',
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });
      const cashierRoleId = rolesRes.json().find((r: { code: string }) => r.code === 'CASHIER').id;

      const assignRes = await app.inject({
        method: 'PUT',
        url: `/v1/iam/members/${cashierMembershipId}/roles`,
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          roleIds: [cashierRoleId, customRoleId],
        },
      });
      expect(assignRes.statusCode).toBe(200);
      const updatedMember = assignRes.json();
      expect(updatedMember.roles).toHaveLength(2);
      const assignedCodes = updatedMember.roles.map((r: { code: string }) => r.code);
      expect(assignedCodes).toContain('CASHIER');
      expect(assignedCodes).toContain('STOCK_SUPERVISOR');
    });

    it('9.7 Last Tenant Owner Protection: rejects stripping sole Tenant Owner role (422)', async () => {
      // Find Owner member
      const membersRes = await app.inject({
        method: 'GET',
        url: '/v1/iam/members',
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });
      const ownerMember = membersRes.json().find((m: { roles: Array<{ code: string }> }) =>
        m.roles.some((r) => r.code === 'TENANT_OWNER'),
      );
      expect(ownerMember).toBeDefined();

      // Attempt to replace Owner roles with only customRoleId
      const stripOwnerRes = await app.inject({
        method: 'PUT',
        url: `/v1/iam/members/${ownerMember.id}/roles`,
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          roleIds: [customRoleId], // Removing TENANT_OWNER
        },
      });
      expect(stripOwnerRes.statusCode).toBe(422);
      expect(stripOwnerRes.json().errorCode).toBe('IAM_CANNOT_REMOVE_LAST_OWNER');
    });

    it('9.8 Role Deletion In-Use Protection: prevents deleting role assigned to active members (409)', async () => {
      // Custom role is assigned to Cashier member
      const deleteInUseRes = await app.inject({
        method: 'DELETE',
        url: `/v1/iam/roles/${customRoleId}`,
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });
      expect(deleteInUseRes.statusCode).toBe(409);
      expect(deleteInUseRes.json().errorCode).toBe('IAM_ROLE_IN_USE');
    });

    it('9.9 Location Scope Management: updates member location access and enforces restrictions', async () => {
      // 1. Update Cashier to restricted scope (only alphaBranchId and alphaWarehouseId)
      const updateScopeRes = await app.inject({
        method: 'PUT',
        url: `/v1/iam/members/${cashierMembershipId}/location-scopes`,
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          allLocationsAccess: false,
          branchIds: [alphaBranchId],
          warehouseIds: [alphaWarehouseId],
        },
      });
      expect(updateScopeRes.statusCode).toBe(200);
      expect(updateScopeRes.json().allLocationsAccess).toBe(false);
      expect(updateScopeRes.json().locationScopes.branchIds).toContain(alphaBranchId);

      // 2. Restore organization-wide scope
      const restoreScopeRes = await app.inject({
        method: 'PUT',
        url: `/v1/iam/members/${cashierMembershipId}/location-scopes`,
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          allLocationsAccess: true,
        },
      });
      expect(restoreScopeRes.statusCode).toBe(200);
      expect(restoreScopeRes.json().allLocationsAccess).toBe(true);
    });

    it('9.10 Unassign and Clean Deletion: unassigns role and successfully deletes custom role', async () => {
      // 1. Remove custom role from cashier member
      const unassignRes = await app.inject({
        method: 'DELETE',
        url: `/v1/iam/members/${cashierMembershipId}/roles/${customRoleId}`,
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });
      expect(unassignRes.statusCode).toBe(200);
      expect(unassignRes.json().roles.some((r: { id: string }) => r.id === customRoleId)).toBe(false);

      // 2. DELETE custom role now succeeds cleanly
      const deleteRes = await app.inject({
        method: 'DELETE',
        url: `/v1/iam/roles/${customRoleId}`,
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });
      expect(deleteRes.statusCode).toBe(200);
      expect(deleteRes.json().success).toBe(true);
      expect(deleteRes.json().roleId).toBe(customRoleId);

      // 3. GET /v1/iam/roles/:roleId now returns 404
      const getRes = await app.inject({
        method: 'GET',
        url: `/v1/iam/roles/${customRoleId}`,
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });
      expect(getRes.statusCode).toBe(404);
    });

    it('9.11 Cross-Tenant Role Isolation: Tenant A cannot access or mutate Tenant B roles', async () => {
      // Beta Tenant Owner attempts to fetch an Alpha role
      const alphaRolesRes = await app.inject({
        method: 'GET',
        url: '/v1/iam/roles',
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });
      const alphaRole = alphaRolesRes.json()[0];

      const crossTenantRes = await app.inject({
        method: 'GET',
        url: `/v1/iam/roles/${alphaRole.id}`,
        headers: {
          authorization: `Bearer ${betaOwnerToken}`,
          'x-tenant-id': TENANT_BETA_ID,
        },
      });
      expect(crossTenantRes.statusCode).toBe(404);
    });
  });
});

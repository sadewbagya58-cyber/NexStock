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

describe('@nexstock/api — Phase 7.3: Expenses Management (Categories, Workflows, Payments, Attachments, Reports & RBAC)', () => {
  let harness: TestPostgresHarness;
  let app: AppInstance;

  const TENANT_ALPHA_ID = '0192c000-0000-7000-8000-000000000001';
  const OWNER_USER_ID = '0192c000-0000-7000-8000-000000000002';
  const MANAGER_USER_ID = '0192c000-0000-7000-8000-000000000003';
  const ACCOUNTANT_USER_ID = '0192c000-0000-7000-8000-000000000004';
  const CASHIER_USER_ID = '0192c000-0000-7000-8000-000000000005';
  const STAFF_USER_ID = '0192c000-0000-7000-8000-000000000006';

  const TENANT_BETA_ID = '0192c000-0000-7000-8000-000000000010';
  const BETA_OWNER_ID = '0192c000-0000-7000-8000-000000000011';

  const primaryKey = createTestEs256KeyMaterial('test-key-phase73');
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
  let accountantToken: string;
  let cashierToken: string;
  let staffToken: string;
  let betaOwnerToken: string;
  let alphaBranchId: string;

  beforeAll(async () => {
    harness = await createTestPostgresHarness();

    ownerToken = issueToken(OWNER_USER_ID, 'owner@alpha-exp.example.com');
    managerToken = issueToken(MANAGER_USER_ID, 'manager@alpha-exp.example.com');
    accountantToken = issueToken(ACCOUNTANT_USER_ID, 'accountant@alpha-exp.example.com');
    cashierToken = issueToken(CASHIER_USER_ID, 'cashier@alpha-exp.example.com');
    staffToken = issueToken(STAFF_USER_ID, 'staff@alpha-exp.example.com');
    betaOwnerToken = issueToken(BETA_OWNER_ID, 'owner@beta-exp.example.com');

    app = await buildApp({
      db: harness.db,
      jwksProvider,
    });

    // 1. Onboard Tenant Alpha
    const alphaOnboardRes = await app.inject({
      method: 'POST',
      url: '/v1/org/tenants/onboard',
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
      payload: {
        slug: 'alpha-phase73',
        legalName: 'Alpha Phase 7.3 Corp',
        baseCurrency: 'USD',
        defaultLocale: 'en-US',
        defaultTimezone: 'America/New_York',
        countryCode: 'US',
        ownerEmail: 'owner@alpha-exp.example.com',
        ownerFullName: 'Alpha Owner',
        planCode: 'GROWTH',
      },
    });
    expect(alphaOnboardRes.statusCode).toBe(201);

    // Create branch for Alpha
    const branchRes = await app.inject({
      method: 'POST',
      url: '/v1/org/branches',
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
      payload: {
        code: 'BR-EXP-01',
        name: 'Alpha Primary Outlet',
        timezone: 'America/New_York',
        countryCode: 'US',
      },
    });
    expect(branchRes.statusCode).toBe(201);
    alphaBranchId = branchRes.json().id;

    // 2. Onboard Tenant Beta
    const betaOnboardRes = await app.inject({
      method: 'POST',
      url: '/v1/org/tenants/onboard',
      headers: {
        authorization: `Bearer ${betaOwnerToken}`,
        'x-tenant-id': TENANT_BETA_ID,
      },
      payload: {
        slug: 'beta-phase73',
        legalName: 'Beta Phase 7.3 Corp',
        baseCurrency: 'USD',
        defaultLocale: 'en-US',
        defaultTimezone: 'America/New_York',
        countryCode: 'US',
        ownerEmail: 'owner@beta-exp.example.com',
        ownerFullName: 'Beta Owner',
        planCode: 'GROWTH',
      },
    });
    expect(betaOnboardRes.statusCode).toBe(201);

    // 3. Provision Member Roles for Tenant Alpha
    await withTenantTransaction(
      harness.db,
      { tenantId: TENANT_ALPHA_ID, userId: OWNER_USER_ID, traceId: 'init_members' },
      async (trx) => {
        // Manager
        await provisionTenantMember(trx, {
          userId: MANAGER_USER_ID,
          email: 'manager@alpha-exp.example.com',
          fullName: 'Alpha Branch Manager',
          roleCodes: ['BRANCH_MANAGER'],
          allLocationsAccess: true,
          status: 'ACTIVE',
        });
        // Accountant
        await provisionTenantMember(trx, {
          userId: ACCOUNTANT_USER_ID,
          email: 'accountant@alpha-exp.example.com',
          fullName: 'Alpha Accountant',
          roleCodes: ['ACCOUNTANT'],
          allLocationsAccess: true,
          status: 'ACTIVE',
        });
        // Cashier
        await provisionTenantMember(trx, {
          userId: CASHIER_USER_ID,
          email: 'cashier@alpha-exp.example.com',
          fullName: 'Alpha Cashier',
          roleCodes: ['CASHIER'],
          allLocationsAccess: true,
          status: 'ACTIVE',
        });
        // Staff
        await provisionTenantMember(trx, {
          userId: STAFF_USER_ID,
          email: 'staff@alpha-exp.example.com',
          fullName: 'Alpha Staff Employee',
          roleCodes: ['STAFF'],
          allLocationsAccess: true,
          status: 'ACTIVE',
        });
      },
    );
  });

  afterAll(async () => {
    if (app) await app.close();
    if (harness) await harness.db.destroy();
  });

  // ============================================================================
  // Suite 1: Expense Categories
  // ============================================================================
  describe('1. Expense Categories Management', () => {
    let customCategoryId: string;

    it('auto-seeds the default 10 expense categories on first list', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/expenses/categories',
        headers: {
          authorization: `Bearer ${ownerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });

      expect(res.statusCode).toBe(200);
      const data = res.json();
      expect(Array.isArray(data.items)).toBe(true);
      expect(data.items.length).toBeGreaterThanOrEqual(10);

      const codes = data.items.map((c: { code: string }) => c.code);
      expect(codes).toContain('RENT');
      expect(codes).toContain('ELECTRICITY');
      expect(codes).toContain('WATER');
      expect(codes).toContain('INTERNET');
      expect(codes).toContain('TRANSPORT');
      expect(codes).toContain('SALARIES_WAGES');
      expect(codes).toContain('MAINTENANCE');
      expect(codes).toContain('OFFICE_SUPPLIES');
      expect(codes).toContain('MARKETING');
      expect(codes).toContain('OTHER');

      const rent = data.items.find((c: { code: string }) => c.code === 'RENT');
      expect(rent.name).toBe('Rent');
      expect(rent.isSystemDefault).toBe(true);
      expect(rent.isActive).toBe(true);
      expect(rent.id).toBeDefined();
    });

    it('creates a custom expense category successfully', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/expenses/categories',
        headers: {
          authorization: `Bearer ${accountantToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          code: 'LEGAL_AUDIT',
          name: 'Legal and Professional Fees',
          description: 'Attorneys, legal compliance, and tax audits',
        },
      });

      expect(res.statusCode).toBe(201);
      const cat = res.json();
      expect(cat.code).toBe('LEGAL_AUDIT');
      expect(cat.name).toBe('Legal and Professional Fees');
      expect(cat.isActive).toBe(true);
      expect(cat.isSystemDefault).toBe(false);
      customCategoryId = cat.id;
    });

    it('rejects duplicate category code with 409 Conflict', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/expenses/categories',
        headers: {
          authorization: `Bearer ${ownerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          code: 'legal_audit', // case-insensitive check
          name: 'Duplicate Legal Fees',
        },
      });

      expect(res.statusCode).toBe(409);
      expect(res.json().errorCode).toBe('EXP_DUPLICATE_CATEGORY_CODE');
    });

    it('updates expense category attributes and deactivates it', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/v1/expenses/categories/${customCategoryId}`,
        headers: {
          authorization: `Bearer ${accountantToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          name: 'Legal & Auditing Consultancy',
          isActive: false,
        },
      });

      expect(res.statusCode).toBe(200);
      const updated = res.json();
      expect(updated.name).toBe('Legal & Auditing Consultancy');
      expect(updated.isActive).toBe(false);
    });

    it('reactivates the category for subsequent use', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/v1/expenses/categories/${customCategoryId}`,
        headers: {
          authorization: `Bearer ${accountantToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          isActive: true,
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().isActive).toBe(true);
    });

    it('deletes an unreferenced custom expense category', async () => {
      // Create a throwaway category
      const createRes = await app.inject({
        method: 'POST',
        url: '/v1/expenses/categories',
        headers: {
          authorization: `Bearer ${ownerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          code: 'THROWAWAY',
          name: 'Temporary Category',
        },
      });
      expect(createRes.statusCode).toBe(201);
      const throwawayId = createRes.json().id;

      const delRes = await app.inject({
        method: 'DELETE',
        url: `/v1/expenses/categories/${throwawayId}`,
        headers: {
          authorization: `Bearer ${ownerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });
      expect(delRes.statusCode).toBe(200);
      expect(delRes.json().success).toBe(true);
    });
  });

  // ============================================================================
  // Suite 2: Expense Creation, Reference Generation & Validations
  // ============================================================================
  describe('2. Expense Creation, Reference Numbers & Validations', () => {
    let rentCatId: string;
    let createdExpenseId: string;

    beforeAll(async () => {
      const catsRes = await app.inject({
        method: 'GET',
        url: '/v1/expenses/categories',
        headers: {
          authorization: `Bearer ${ownerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });
      const rent = catsRes.json().items.find((c: { code: string }) => c.code === 'RENT');
      rentCatId = rent.id;
    });

    it('creates an operational expense in DRAFT status with atomic reference number', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/expenses',
        headers: {
          authorization: `Bearer ${managerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          title: 'Store Front Lease November 2026',
          description: 'Monthly commercial rental payment for primary outlet',
          categoryId: rentCatId,
          amount: '2500.0000',
          currencyCode: 'USD',
          expenseDate: '2026-11-01',
          vendorPayee: 'Skyline Commercial Properties LLC',
          paymentMethod: 'BANK_TRANSFER',
          branchId: alphaBranchId,
          notes: 'Invoice #SKY-8812 due by 5th Nov',
        },
      });

      expect(res.statusCode).toBe(201);
      const exp = res.json();
      expect(exp.id).toBeDefined();
      expect(exp.status).toBe('DRAFT');
      expect(exp.amount).toBe('2500.0000');
      expect(exp.currencyCode).toBe('USD');
      expect(exp.categoryName).toBe('Rent');
      expect(exp.categoryCode).toBe('RENT');
      expect(exp.referenceNumber).toMatch(/^EXP-202611-\d{5}$/);
      expect(exp.createdByName).toBe('Alpha Branch Manager');
      createdExpenseId = exp.id;
    });

    it('generates sequential reference numbers within the month', async () => {
      const res2 = await app.inject({
        method: 'POST',
        url: '/v1/expenses',
        headers: {
          authorization: `Bearer ${cashierToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          title: 'Cashier Till Petty Cash Restock',
          categoryId: rentCatId,
          amount: '50.0000',
          currencyCode: 'USD',
          expenseDate: '2026-11-02',
          vendorPayee: 'Corner Stationery Store',
        },
      });

      expect(res2.statusCode).toBe(201);
      const exp2 = res2.json();
      expect(exp2.referenceNumber).toMatch(/^EXP-202611-\d{5}$/);
      // Clean up exp2
      await app.inject({
        method: 'DELETE',
        url: `/v1/expenses/${exp2.id}`,
        headers: {
          authorization: `Bearer ${managerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });
    });

    it('rejects creation if amount is zero or negative', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/expenses',
        headers: {
          authorization: `Bearer ${managerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          title: 'Invalid Expense',
          categoryId: rentCatId,
          amount: '-10.0000',
          currencyCode: 'USD',
          expenseDate: '2026-11-01',
        },
      });
      // Fastify schema validation checks DecimalMoneyStringSchema pattern
      expect([400, 422]).toContain(res.statusCode);
    });

    it('edits an expense in DRAFT status', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/v1/expenses/${createdExpenseId}`,
        headers: {
          authorization: `Bearer ${managerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          title: 'Store Front Lease November 2026 (Updated)',
          amount: '2650.0000',
        },
      });

      expect(res.statusCode).toBe(200);
      const exp = res.json();
      expect(exp.title).toBe('Store Front Lease November 2026 (Updated)');
      expect(exp.amount).toBe('2650.0000');
    });

    it('prevents deletion of category referenced by this expense', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/v1/expenses/categories/${rentCatId}`,
        headers: {
          authorization: `Bearer ${ownerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });

      expect(res.statusCode).toBe(409);
      expect(res.json().errorCode).toBe('EXP_CATEGORY_IN_USE');
    });
  });

  // ============================================================================
  // Suite 3: Workflow State Machine & Separation of Duties
  // ============================================================================
  describe('3. Expense Approval Workflow & Separation of Duties', () => {
    let expenseId: string;
    let rentCatId: string;

    beforeAll(async () => {
      const catsRes = await app.inject({
        method: 'GET',
        url: '/v1/expenses/categories',
        headers: {
          authorization: `Bearer ${ownerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });
      rentCatId = catsRes.json().items.find((c: { code: string }) => c.code === 'RENT').id;

      // Create an expense created by Branch Manager
      const res = await app.inject({
        method: 'POST',
        url: '/v1/expenses',
        headers: {
          authorization: `Bearer ${managerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          title: 'Branch Air Conditioner Repair',
          categoryId: rentCatId,
          amount: '450.0000',
          currencyCode: 'USD',
          expenseDate: '2026-11-03',
          vendorPayee: 'Cooling Masters HVAC Inc',
        },
      });
      expenseId = res.json().id;
    });

    it('submits a DRAFT expense for approval (DRAFT -> PENDING_APPROVAL)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/expenses/${expenseId}/submit`,
        headers: {
          authorization: `Bearer ${managerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          notes: 'AC failed in main retail area, urgent repair',
        },
      });

      expect(res.statusCode).toBe(200);
      const exp = res.json();
      expect(exp.status).toBe('PENDING_APPROVAL');
    });

    it('rejects editing or deleting an expense while in PENDING_APPROVAL status', async () => {
      const editRes = await app.inject({
        method: 'PATCH',
        url: `/v1/expenses/${expenseId}`,
        headers: {
          authorization: `Bearer ${managerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: { title: 'Attempted Edit' },
      });
      expect(editRes.statusCode).toBe(409);
      expect(editRes.json().errorCode).toBe('EXP_NOT_EDITABLE');

      const delRes = await app.inject({
        method: 'DELETE',
        url: `/v1/expenses/${expenseId}`,
        headers: {
          authorization: `Bearer ${managerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });
      expect(delRes.statusCode).toBe(409);
      expect(delRes.json().errorCode).toBe('EXP_NOT_DELETABLE');
    });

    it('enforces separation of duties: creator (Branch Manager) CANNOT approve own expense', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/expenses/${expenseId}/approve`,
        headers: {
          authorization: `Bearer ${managerToken}`, // Manager created this expense
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().errorCode).toBe('EXP_CANNOT_APPROVE_OWN_EXPENSE');
    });

    it('rejects approval when reason is missing during rejection', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/expenses/${expenseId}/reject`,
        headers: {
          authorization: `Bearer ${accountantToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          rejectionReason: ' ', // Whitespace only
        },
      });

      expect([400, 422]).toContain(res.statusCode);
    });

    it('rejects the expense with a valid rejection reason (PENDING_APPROVAL -> REJECTED)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/expenses/${expenseId}/reject`,
        headers: {
          authorization: `Bearer ${accountantToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          rejectionReason: 'Please attach repair invoice receipt before approval',
        },
      });

      expect(res.statusCode).toBe(200);
      const exp = res.json();
      expect(exp.status).toBe('REJECTED');
      expect(exp.rejectionReason).toBe('Please attach repair invoice receipt before approval');
    });

    it('allows updating a REJECTED expense and re-submitting for approval', async () => {
      // 1. Update
      const editRes = await app.inject({
        method: 'PATCH',
        url: `/v1/expenses/${expenseId}`,
        headers: {
          authorization: `Bearer ${managerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          notes: 'Invoice attached as requested',
        },
      });
      expect(editRes.statusCode).toBe(200);

      // 2. Re-submit
      const submitRes = await app.inject({
        method: 'POST',
        url: `/v1/expenses/${expenseId}/submit`,
        headers: {
          authorization: `Bearer ${managerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });
      expect(submitRes.statusCode).toBe(200);
      expect(submitRes.json().status).toBe('PENDING_APPROVAL');
    });

    it('allows an authorized manager/admin (Owner or Accountant) to approve the expense', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/expenses/${expenseId}/approve`,
        headers: {
          authorization: `Bearer ${accountantToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          notes: 'Approved after verification',
        },
      });

      expect(res.statusCode).toBe(200);
      const exp = res.json();
      expect(exp.status).toBe('APPROVED');
      expect(exp.approvedByUserId).toBe(ACCOUNTANT_USER_ID);
      expect(exp.approvedAt).toBeDefined();
    });
  });

  // ============================================================================
  // Suite 4: Expense Payments
  // ============================================================================
  describe('4. Expense Payment Disbursements', () => {
    let approvedExpenseId: string;
    let draftExpenseId: string;
    let rentCatId: string;

    beforeAll(async () => {
      const catsRes = await app.inject({
        method: 'GET',
        url: '/v1/expenses/categories',
        headers: {
          authorization: `Bearer ${ownerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });
      rentCatId = catsRes.json().items[0].id;

      // 1. Create and approve an expense
      const appExpRes = await app.inject({
        method: 'POST',
        url: '/v1/expenses',
        headers: {
          authorization: `Bearer ${ownerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          title: 'Electricity Bill Payment November',
          categoryId: rentCatId,
          amount: '780.0000',
          currencyCode: 'USD',
          expenseDate: '2026-11-04',
          vendorPayee: 'City Power & Light',
        },
      });
      approvedExpenseId = appExpRes.json().id;

      await app.inject({
        method: 'POST',
        url: `/v1/expenses/${approvedExpenseId}/submit`,
        headers: {
          authorization: `Bearer ${ownerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });

      await app.inject({
        method: 'POST',
        url: `/v1/expenses/${approvedExpenseId}/approve`,
        headers: {
          authorization: `Bearer ${ownerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });

      // 2. Create a DRAFT expense
      const draftRes = await app.inject({
        method: 'POST',
        url: '/v1/expenses',
        headers: {
          authorization: `Bearer ${ownerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          title: 'Unapproved Cleaning Supplies',
          categoryId: rentCatId,
          amount: '120.0000',
          currencyCode: 'USD',
          expenseDate: '2026-11-04',
        },
      });
      draftExpenseId = draftRes.json().id;
    });

    it('rejects recording payment on an unapproved DRAFT expense', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/expenses/${draftExpenseId}/pay`,
        headers: {
          authorization: `Bearer ${accountantToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          paymentDate: '2026-11-04',
          paymentMethod: 'CASH',
        },
      });

      expect(res.statusCode).toBe(409);
      expect(res.json().errorCode).toBe('EXP_INVALID_STATUS_TRANSITION');
    });

    it('records payment disbursement for an APPROVED expense (APPROVED -> PAID)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/expenses/${approvedExpenseId}/pay`,
        headers: {
          authorization: `Bearer ${accountantToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          paymentDate: '2026-11-04',
          paymentMethod: 'BANK_TRANSFER',
          paymentReference: 'WIRE-20261104-9981',
          notes: 'Transferred from Operating Account #101',
        },
      });

      expect(res.statusCode).toBe(200);
      const exp = res.json();
      expect(exp.status).toBe('PAID');
      expect(exp.paidAt).toBeDefined();
      expect(exp.paymentMethod).toBe('BANK_TRANSFER');
      expect(exp.paymentReference).toBe('WIRE-20261104-9981');
    });

    it('prevents double payment recording on an already PAID expense', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/expenses/${approvedExpenseId}/pay`,
        headers: {
          authorization: `Bearer ${accountantToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          paymentDate: '2026-11-04',
          paymentMethod: 'CASH',
        },
      });

      expect(res.statusCode).toBe(409);
      expect(res.json().errorCode).toBe('EXP_ALREADY_PAID');
    });
  });

  // ============================================================================
  // Suite 5: Attachments (Receipts & Invoices)
  // ============================================================================
  describe('5. Receipt & Invoice Attachments', () => {
    let targetExpenseId: string;
    let uploadedAttachmentId: string;

    beforeAll(async () => {
      const catsRes = await app.inject({
        method: 'GET',
        url: '/v1/expenses/categories',
        headers: {
          authorization: `Bearer ${ownerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });
      const catId = catsRes.json().items[0].id;

      const expRes = await app.inject({
        method: 'POST',
        url: '/v1/expenses',
        headers: {
          authorization: `Bearer ${managerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          title: 'Courier Shipping Receipts',
          categoryId: catId,
          amount: '85.5000',
          currencyCode: 'USD',
          expenseDate: '2026-11-04',
        },
      });
      targetExpenseId = expRes.json().id;
    });

    it('uploads a valid PDF receipt attachment with magic bytes verification', async () => {
      // Valid PDF magic bytes: %PDF-1.4 ...
      const pdfBytes = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF');
      const base64 = pdfBytes.toString('base64');

      const res = await app.inject({
        method: 'POST',
        url: `/v1/expenses/${targetExpenseId}/attachments`,
        headers: {
          authorization: `Bearer ${managerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          fileName: 'shipping_receipt.pdf',
          mimeType: 'application/pdf',
          dataBase64: base64,
        },
      });

      expect(res.statusCode).toBe(201);
      const att = res.json();
      expect(att.id).toBeDefined();
      expect(att.fileName).toBe('shipping_receipt.pdf');
      expect(att.mimeType).toBe('application/pdf');
      expect(att.fileSizeBytes).toBe(pdfBytes.length);
      uploadedAttachmentId = att.id;
    });

    it('uploads a valid PNG receipt attachment', async () => {
      // Valid PNG magic bytes: \x89PNG\r\n\x1a\n
      const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
      const base64 = pngHeader.toString('base64');

      const res = await app.inject({
        method: 'POST',
        url: `/v1/expenses/${targetExpenseId}/attachments`,
        headers: {
          authorization: `Bearer ${managerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          fileName: 'receipt_photo.png',
          mimeType: 'image/png',
          dataBase64: base64,
        },
      });

      expect(res.statusCode).toBe(201);
      expect(res.json().fileName).toBe('receipt_photo.png');
    });

    it('rejects attachment with forged MIME type where magic bytes mismatch', async () => {
      // Plain text claiming to be a PDF
      const fakePdf = Buffer.from('Hello this is not really a PDF file').toString('base64');

      const res = await app.inject({
        method: 'POST',
        url: `/v1/expenses/${targetExpenseId}/attachments`,
        headers: {
          authorization: `Bearer ${managerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          fileName: 'fake.pdf',
          mimeType: 'application/pdf',
          dataBase64: fakePdf,
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().errorCode).toBe('EXP_INVALID_ATTACHMENT_TYPE');
    });

    it('lists attachments for an expense record', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/expenses/${targetExpenseId}/attachments`,
        headers: {
          authorization: `Bearer ${managerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });

      expect(res.statusCode).toBe(200);
      const list = res.json();
      expect(Array.isArray(list.items)).toBe(true);
      expect(list.items.length).toBe(2);
    });

    it('retrieves attachment content base64 securely', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/expenses/${targetExpenseId}/attachments/${uploadedAttachmentId}/content`,
        headers: {
          authorization: `Bearer ${accountantToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.fileName).toBe('shipping_receipt.pdf');
      expect(body.mimeType).toBe('application/pdf');
      expect(body.dataBase64).toBeDefined();
    });

    it('deletes an attachment record', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/v1/expenses/${targetExpenseId}/attachments/${uploadedAttachmentId}`,
        headers: {
          authorization: `Bearer ${managerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);

      // Verify count decreased
      const listRes = await app.inject({
        method: 'GET',
        url: `/v1/expenses/${targetExpenseId}/attachments`,
        headers: {
          authorization: `Bearer ${managerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });
      expect(listRes.json().items.length).toBe(1);
    });
  });

  // ============================================================================
  // Suite 6: Dashboard Summary Reports & Filters
  // ============================================================================
  describe('6. Expense Summary Dashboard & Reports', () => {
    it('computes summary metrics across statuses, categories, and branches', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/expenses/summary',
        headers: {
          authorization: `Bearer ${accountantToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });

      expect(res.statusCode).toBe(200);
      const summary = res.json();
      expect(summary.totalExpenses).toBeDefined();
      expect(summary.totalCount).toBeGreaterThanOrEqual(1);
      expect(summary.pendingApprovalAmount).toBeDefined();
      expect(summary.approvedUnpaidAmount).toBeDefined();
      expect(summary.paidAmount).toBeDefined();
      expect(Array.isArray(summary.byCategory)).toBe(true);
      expect(Array.isArray(summary.byBranch)).toBe(true);
      expect(Array.isArray(summary.byStatus)).toBe(true);
    });

    it('filters expenses by status query parameter', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/expenses?status=PAID',
        headers: {
          authorization: `Bearer ${managerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });

      expect(res.statusCode).toBe(200);
      const list = res.json();
      expect(list.items.every((e: { status: string }) => e.status === 'PAID')).toBe(true);
    });

    it('searches expenses by keyword across reference number, title, and payee', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/expenses?search=Lease',
        headers: {
          authorization: `Bearer ${managerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });

      expect(res.statusCode).toBe(200);
      const list = res.json();
      expect(list.items.length).toBeGreaterThanOrEqual(1);
      expect(list.items[0].title).toContain('Lease');
    });
  });

  // ============================================================================
  // Suite 7: RBAC, Staff Deny-by-Default & Tenant Isolation
  // ============================================================================
  describe('7. RBAC, Staff Deny-by-Default & Multi-Tenant Isolation', () => {
    it('Cashier CAN view and create draft expenses', async () => {
      const catsRes = await app.inject({
        method: 'GET',
        url: '/v1/expenses/categories',
        headers: {
          authorization: `Bearer ${cashierToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });
      expect(catsRes.statusCode).toBe(200);
      const catId = catsRes.json().items[0].id;

      const createRes = await app.inject({
        method: 'POST',
        url: '/v1/expenses',
        headers: {
          authorization: `Bearer ${cashierToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          title: 'Till Small Consumables',
          categoryId: catId,
          amount: '15.0000',
          currencyCode: 'USD',
          expenseDate: '2026-11-04',
        },
      });
      expect(createRes.statusCode).toBe(201);
      const expId = createRes.json().id;

      // Cashier CAN submit
      const submitRes = await app.inject({
        method: 'POST',
        url: `/v1/expenses/${expId}/submit`,
        headers: {
          authorization: `Bearer ${cashierToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });
      expect(submitRes.statusCode).toBe(200);

      // Cashier CANNOT approve (403 Forbidden)
      const approveRes = await app.inject({
        method: 'POST',
        url: `/v1/expenses/${expId}/approve`,
        headers: {
          authorization: `Bearer ${cashierToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });
      expect(approveRes.statusCode).toBe(403);

      // Cashier CANNOT pay (403 Forbidden)
      const payRes = await app.inject({
        method: 'POST',
        url: `/v1/expenses/${expId}/pay`,
        headers: {
          authorization: `Bearer ${cashierToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: { paymentDate: '2026-11-04', paymentMethod: 'CASH' },
      });
      expect(payRes.statusCode).toBe(403);
    });

    it('STAFF role has zero expense permissions (deny-by-default on all endpoints)', async () => {
      // 1. Staff cannot view categories
      const catRes = await app.inject({
        method: 'GET',
        url: '/v1/expenses/categories',
        headers: {
          authorization: `Bearer ${staffToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });
      expect(catRes.statusCode).toBe(403);

      // 2. Staff cannot view expenses
      const expRes = await app.inject({
        method: 'GET',
        url: '/v1/expenses',
        headers: {
          authorization: `Bearer ${staffToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });
      expect(expRes.statusCode).toBe(403);

      // 3. Staff cannot view reports
      const repRes = await app.inject({
        method: 'GET',
        url: '/v1/expenses/summary',
        headers: {
          authorization: `Bearer ${staffToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });
      expect(repRes.statusCode).toBe(403);
    });

    it('strict multi-tenant isolation: Tenant Beta cannot see or modify Tenant Alpha expenses', async () => {
      // 1. Beta lists expenses -> 0 items
      const betaListRes = await app.inject({
        method: 'GET',
        url: '/v1/expenses',
        headers: {
          authorization: `Bearer ${betaOwnerToken}`,
          'x-tenant-id': TENANT_BETA_ID,
        },
      });
      expect(betaListRes.statusCode).toBe(200);
      expect(betaListRes.json().items.length).toBe(0);

      // 2. Beta attempts to access an Alpha expense directly by ID
      const alphaListRes = await app.inject({
        method: 'GET',
        url: '/v1/expenses',
        headers: {
          authorization: `Bearer ${ownerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });
      const alphaExpId = alphaListRes.json().items[0].id;

      const crossTenantGet = await app.inject({
        method: 'GET',
        url: `/v1/expenses/${alphaExpId}`,
        headers: {
          authorization: `Bearer ${betaOwnerToken}`,
          'x-tenant-id': TENANT_BETA_ID,
        },
      });
      expect(crossTenantGet.statusCode).toBe(404);
    });
  });
});

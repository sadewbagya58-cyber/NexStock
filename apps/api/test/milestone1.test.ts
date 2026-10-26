import {
  type KeyObject,
  createHmac,
  generateKeyPairSync,
  sign,
} from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_SUPABASE_JWKS_URL,
  DEFAULT_SUPABASE_JWT_AUDIENCE,
  DEFAULT_SUPABASE_JWT_ISSUER,
  I18N_COMPLIANCE_DECISIONS_FOR_REVIEW,
  StaticJwksProvider,
  type SupabaseJwk,
  buildApp,
  calculateTaxForTaxGroup,
  createPosRegister,
  createTaxGroupWithRates,
  generateUuidV7,
  listSupportedCurrencies,
  updateSubscriptionLifecycleAndOverride,
  verifySupabaseJwt,
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
  headerOverrides?: Record<string, unknown>,
): string {
  const header = {
    alg: 'ES256',
    typ: 'JWT',
    kid: keyMaterial.kid,
    ...headerOverrides,
  };
  const headerB64 = Buffer.from(JSON.stringify(header), 'utf-8').toString(
    'base64url',
  );
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf-8').toString(
    'base64url',
  );
  const signingInput = Buffer.from(`${headerB64}.${payloadB64}`, 'utf-8');
  const signature = sign(
    'sha256',
    signingInput,
    { key: keyMaterial.privateKey, dsaEncoding: 'ieee-p1363' },
  );
  return `${headerB64}.${payloadB64}.${signature.toString('base64url')}`;
}

function signHs256Jwt(
  secret: string,
  payload: Record<string, unknown>,
): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const headerB64 = Buffer.from(JSON.stringify(header), 'utf-8').toString(
    'base64url',
  );
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf-8').toString(
    'base64url',
  );
  const signingInput = Buffer.from(`${headerB64}.${payloadB64}`, 'utf-8');
  const signature = createHmac('sha256', secret).update(signingInput).digest();
  return `${headerB64}.${payloadB64}.${signature.toString('base64url')}`;
}

describe('Milestone 1 — IAM, ORG, SUB, and I18N Integration Suite', () => {
  let harness: TestPostgresHarness;
  const primaryKey = createTestEs256KeyMaterial(
    '01f76c4b-9743-48ad-bed6-a9c89dc99cc2',
  );
  const wrongKey = createTestEs256KeyMaterial(
    '01f76c4b-9743-48ad-bed6-a9c89dc99cc2',
  );
  const jwksProvider = new StaticJwksProvider({
    keys: [primaryKey.publicJwk],
  });

  const nowSeconds = Math.floor(Date.now() / 1000);

  function issueValidTokenForUser(
    userId: string,
    email = 'owner@nexstock.example',
    extraClaims: Record<string, unknown> = {},
  ): string {
    return signEs256Jwt(primaryKey, {
      iss: DEFAULT_SUPABASE_JWT_ISSUER,
      aud: DEFAULT_SUPABASE_JWT_AUDIENCE,
      sub: userId,
      email,
      iat: nowSeconds - 60,
      nbf: nowSeconds - 60,
      exp: nowSeconds + 3600,
      ...extraClaims,
    });
  }

  beforeEach(async () => {
    harness = await createTestPostgresHarness();
  });

  afterEach(async () => {
    await harness.db.destroy();
  });

  it('verifies asymmetric ES256 Supabase JWTs and rejects expired, malformed, tampered, wrong-issuer, and disallowed-algorithm tokens', async () => {
    expect(DEFAULT_SUPABASE_JWKS_URL).toBe(
      'https://tokylhdgzyoxiqwvncis.supabase.co/auth/v1/.well-known/jwks.json',
    );

    const userId = '0192b4a0-1111-7000-8000-000000000001';
    const validToken = issueValidTokenForUser(userId, 'alice@nexstock.io', {
      // Untrusted client claims that must not grant tenant/role authority by themselves
      role: 'TENANT_OWNER',
      tenant_id: '0192b4a0-9999-7000-8000-999999999999',
    });

    const verified = await verifySupabaseJwt(
      `Bearer ${validToken}`,
      jwksProvider,
      {
        expectedIssuer: DEFAULT_SUPABASE_JWT_ISSUER,
        expectedAudience: DEFAULT_SUPABASE_JWT_AUDIENCE,
      },
    );
    expect(verified.userId).toBe(userId);
    expect(verified.algorithm).toBe('ES256');
    expect(verified.keyId).toBe('01f76c4b-9743-48ad-bed6-a9c89dc99cc2');

    // 1. Missing token
    await expect(
      verifySupabaseJwt(undefined, jwksProvider, {
        expectedIssuer: DEFAULT_SUPABASE_JWT_ISSUER,
        expectedAudience: DEFAULT_SUPABASE_JWT_AUDIENCE,
      }),
    ).rejects.toMatchObject({
      statusCode: 401,
      errorCode: 'IAM_UNAUTHENTICATED_TOKEN',
      extensions: { reasonCode: 'MISSING_TOKEN' },
    });

    // 2. Malformed token
    await expect(
      verifySupabaseJwt('Bearer not.a.valid.jwt.token', jwksProvider, {
        expectedIssuer: DEFAULT_SUPABASE_JWT_ISSUER,
        expectedAudience: DEFAULT_SUPABASE_JWT_AUDIENCE,
      }),
    ).rejects.toMatchObject({
      statusCode: 401,
      errorCode: 'IAM_UNAUTHENTICATED_TOKEN',
      extensions: { reasonCode: 'MALFORMED_JWT' },
    });

    // 3. Expired token
    const expiredToken = signEs256Jwt(primaryKey, {
      iss: DEFAULT_SUPABASE_JWT_ISSUER,
      aud: DEFAULT_SUPABASE_JWT_AUDIENCE,
      sub: userId,
      exp: nowSeconds - 120,
    });
    await expect(
      verifySupabaseJwt(expiredToken, jwksProvider, {
        expectedIssuer: DEFAULT_SUPABASE_JWT_ISSUER,
        expectedAudience: DEFAULT_SUPABASE_JWT_AUDIENCE,
      }),
    ).rejects.toMatchObject({
      statusCode: 401,
      errorCode: 'IAM_UNAUTHENTICATED_TOKEN',
      extensions: { reasonCode: 'TOKEN_EXPIRED' },
    });

    // 4. Invalid signature (signed with wrong EC key)
    const wrongSigToken = signEs256Jwt(wrongKey, {
      iss: DEFAULT_SUPABASE_JWT_ISSUER,
      aud: DEFAULT_SUPABASE_JWT_AUDIENCE,
      sub: userId,
      exp: nowSeconds + 3600,
    });
    await expect(
      verifySupabaseJwt(wrongSigToken, jwksProvider, {
        expectedIssuer: DEFAULT_SUPABASE_JWT_ISSUER,
        expectedAudience: DEFAULT_SUPABASE_JWT_AUDIENCE,
      }),
    ).rejects.toMatchObject({
      statusCode: 401,
      errorCode: 'IAM_UNAUTHENTICATED_TOKEN',
      extensions: { reasonCode: 'INVALID_SIGNATURE' },
    });

    // 5. Wrong issuer
    const wrongIssuerToken = signEs256Jwt(primaryKey, {
      iss: 'https://evil.example.com/auth/v1',
      aud: DEFAULT_SUPABASE_JWT_AUDIENCE,
      sub: userId,
      exp: nowSeconds + 3600,
    });
    await expect(
      verifySupabaseJwt(wrongIssuerToken, jwksProvider, {
        expectedIssuer: DEFAULT_SUPABASE_JWT_ISSUER,
        expectedAudience: DEFAULT_SUPABASE_JWT_AUDIENCE,
      }),
    ).rejects.toMatchObject({
      statusCode: 401,
      errorCode: 'IAM_UNAUTHENTICATED_TOKEN',
      extensions: { reasonCode: 'INVALID_ISSUER' },
    });

    // 6. Disallowed HS256 when legacy fallback is not enabled
    const hs256Token = signHs256Jwt('legacy-test-secret-not-for-prod', {
      iss: DEFAULT_SUPABASE_JWT_ISSUER,
      aud: DEFAULT_SUPABASE_JWT_AUDIENCE,
      sub: userId,
      exp: nowSeconds + 3600,
    });
    await expect(
      verifySupabaseJwt(hs256Token, jwksProvider, {
        expectedIssuer: DEFAULT_SUPABASE_JWT_ISSUER,
        expectedAudience: DEFAULT_SUPABASE_JWT_AUDIENCE,
      }),
    ).rejects.toMatchObject({
      statusCode: 401,
      errorCode: 'IAM_UNAUTHENTICATED_TOKEN',
      extensions: { reasonCode: 'DISALLOWED_ALGORITHM' },
    });

    // Documented fallback works ONLY when legacyHs256SharedSecret is explicitly configured
    const hs256Verified = await verifySupabaseJwt(hs256Token, jwksProvider, {
      expectedIssuer: DEFAULT_SUPABASE_JWT_ISSUER,
      expectedAudience: DEFAULT_SUPABASE_JWT_AUDIENCE,
      legacyHs256SharedSecret: 'legacy-test-secret-not-for-prod',
    });
    expect(hs256Verified.algorithm).toBe('HS256');
    expect(hs256Verified.userId).toBe(userId);
  });

  it('enforces cross-tenant RLS isolation and 3-dimensional branch/warehouse location scope authorization', async () => {
    const app = await buildApp({ db: harness.db, jwksProvider });

    const tenantAId = '0192b4a0-aaaa-7000-8000-000000000001';
    const ownerAId = '0192b4a0-aaaa-7000-8000-000000000002';
    const branch1ManagerId = '0192b4a0-aaaa-7000-8000-000000000003';
    const cashierId = '0192b4a0-aaaa-7000-8000-000000000004';

    const tenantBId = '0192b4a0-bbbb-7000-8000-000000000001';
    const ownerBId = '0192b4a0-bbbb-7000-8000-000000000002';

    const ownerAToken = issueValidTokenForUser(
      ownerAId,
      'owner-a@nexstock.example',
    );
    const ownerBToken = issueValidTokenForUser(
      ownerBId,
      'owner-b@nexstock.example',
    );

    // Onboard Tenant A on GROWTH plan (up to 5 branches)
    const onboardARes = await app.inject({
      method: 'POST',
      url: '/v1/org/tenants/onboard',
      headers: {
        authorization: `Bearer ${ownerAToken}`,
        'x-tenant-id': tenantAId,
      },
      payload: {
        slug: 'ceylon-retail-a',
        legalName: 'Ceylon Retail Group (Pvt) Ltd',
        baseCurrency: 'LKR',
        defaultLocale: 'en-LK',
        defaultTimezone: 'Asia/Colombo',
        countryCode: 'LK',
        ownerEmail: 'owner-a@nexstock.example',
        ownerFullName: 'Owner A',
        planCode: 'GROWTH',
      },
    });
    expect(onboardARes.statusCode).toBe(201);

    // Onboard Tenant B on GROWTH plan
    const onboardBRes = await app.inject({
      method: 'POST',
      url: '/v1/org/tenants/onboard',
      headers: {
        authorization: `Bearer ${ownerBToken}`,
        'x-tenant-id': tenantBId,
      },
      payload: {
        slug: 'pacific-traders-b',
        legalName: 'Pacific Traders Inc',
        baseCurrency: 'USD',
        ownerEmail: 'owner-b@nexstock.example',
        ownerFullName: 'Owner B',
        planCode: 'GROWTH',
      },
    });
    expect(onboardBRes.statusCode).toBe(201);

    // Create Branch 1 and Branch 2 in Tenant A
    const branch1Res = await app.inject({
      method: 'POST',
      url: '/v1/org/branches',
      headers: {
        authorization: `Bearer ${ownerAToken}`,
        'x-tenant-id': tenantAId,
      },
      payload: {
        code: 'CMB-01',
        name: 'Colombo Flagship Branch',
        timezone: 'Asia/Colombo',
        countryCode: 'LK',
      },
    });
    expect(branch1Res.statusCode).toBe(201);
    const branch1 = branch1Res.json<{ id: string; code: string }>();

    const branch2Res = await app.inject({
      method: 'POST',
      url: '/v1/org/branches',
      headers: {
        authorization: `Bearer ${ownerAToken}`,
        'x-tenant-id': tenantAId,
      },
      payload: {
        code: 'KDY-02',
        name: 'Kandy City Branch',
        timezone: 'Asia/Colombo',
        countryCode: 'LK',
      },
    });
    expect(branch2Res.statusCode).toBe(201);
    const branch2 = branch2Res.json<{ id: string; code: string }>();

    // Cross-Tenant Check 1: Owner B attempting to access Tenant A with valid JWT is rejected (no membership in Tenant A)
    const crossTenantAttackRes = await app.inject({
      method: 'GET',
      url: '/v1/org/branches',
      headers: {
        authorization: `Bearer ${ownerBToken}`,
        'x-tenant-id': tenantAId,
      },
    });
    expect(crossTenantAttackRes.statusCode).toBe(403);
    expect(crossTenantAttackRes.json()).toMatchObject({
      errorCode: 'IAM_TENANT_MEMBERSHIP_REQUIRED',
    });

    // Cross-Tenant Check 2: Owner B querying branches in Tenant B sees 0 branches (RLS isolates Tenant A's branches)
    const tenantBBranchesRes = await app.inject({
      method: 'GET',
      url: '/v1/org/branches',
      headers: {
        authorization: `Bearer ${ownerBToken}`,
        'x-tenant-id': tenantBId,
      },
    });
    expect(tenantBBranchesRes.statusCode).toBe(200);
    expect(tenantBBranchesRes.json<{ items: unknown[] }>().items).toHaveLength(
      0,
    );

    // Provision a Branch Manager in Tenant A scoped ONLY to Branch 1 (`allLocationsAccess: false`)
    const provisionMgrRes = await app.inject({
      method: 'POST',
      url: '/v1/iam/members',
      headers: {
        authorization: `Bearer ${ownerAToken}`,
        'x-tenant-id': tenantAId,
      },
      payload: {
        userId: branch1ManagerId,
        email: 'mgr-cmb@nexstock.example',
        fullName: 'Colombo Branch Manager',
        roleCodes: ['BRANCH_MANAGER'],
        allLocationsAccess: false,
        branchIds: [branch1.id],
      },
    });
    expect(provisionMgrRes.statusCode).toBe(201);

    const mgrToken = issueValidTokenForUser(
      branch1ManagerId,
      'mgr-cmb@nexstock.example',
    );

    // Branch 1 Manager listing branches only sees Branch 1 (Branch 2 is filtered out by location scope)
    const mgrListRes = await app.inject({
      method: 'GET',
      url: '/v1/org/branches',
      headers: {
        authorization: `Bearer ${mgrToken}`,
        'x-tenant-id': tenantAId,
      },
    });
    expect(mgrListRes.statusCode).toBe(200);
    const mgrBranches = mgrListRes.json<{ items: { id: string }[] }>().items;
    expect(mgrBranches).toHaveLength(1);
    expect(mgrBranches[0]?.id).toBe(branch1.id);

    // Branch 1 Manager can update Branch 1 and create a warehouse under Branch 1
    const mgrUpdateBranch1 = await app.inject({
      method: 'PATCH',
      url: `/v1/org/branches/${branch1.id}`,
      headers: {
        authorization: `Bearer ${mgrToken}`,
        'x-tenant-id': tenantAId,
      },
      payload: { name: 'Colombo Flagship HQ' },
    });
    expect(mgrUpdateBranch1.statusCode).toBe(200);

    const mgrCreateWh1 = await app.inject({
      method: 'POST',
      url: '/v1/org/warehouses',
      headers: {
        authorization: `Bearer ${mgrToken}`,
        'x-tenant-id': tenantAId,
      },
      payload: {
        branchId: branch1.id,
        code: 'WH-CMB-MAIN',
        name: 'Colombo Main Stockroom',
        allowNegativeStock: false,
      },
    });
    expect(mgrCreateWh1.statusCode).toBe(201);
    const wh1 = mgrCreateWh1.json<{ id: string }>();

    // Branch 1 Manager can also create a POS register in Branch 1
    await withTenantTransaction(
      harness.db,
      {
        tenantId: tenantAId,
        userId: branch1ManagerId,
        traceId: generateUuidV7(),
      },
      async (trx) => {
        const reg = await createPosRegister(trx, {
          branchId: branch1.id,
          warehouseId: wh1.id,
          code: 'REG-01',
          name: 'Front Counter 1',
        });
        expect(reg.code).toBe('REG-01');
      },
    );

    // Cross-Branch Isolation Check: Branch 1 Manager is strictly blocked from reading or mutating Branch 2!
    const mgrReadBranch2 = await app.inject({
      method: 'GET',
      url: `/v1/org/branches/${branch2.id}`,
      headers: {
        authorization: `Bearer ${mgrToken}`,
        'x-tenant-id': tenantAId,
      },
    });
    expect(mgrReadBranch2.statusCode).toBe(403);
    expect(mgrReadBranch2.json()).toMatchObject({
      errorCode: 'IAM_LOCATION_SCOPE_DENIED',
    });

    const mgrMutateBranch2 = await app.inject({
      method: 'PATCH',
      url: `/v1/org/branches/${branch2.id}`,
      headers: {
        authorization: `Bearer ${mgrToken}`,
        'x-tenant-id': tenantAId,
      },
      payload: { name: 'Unauthorized Rename' },
    });
    expect(mgrMutateBranch2.statusCode).toBe(403);
    expect(mgrMutateBranch2.json()).toMatchObject({
      errorCode: 'IAM_LOCATION_SCOPE_DENIED',
    });

    const mgrCreateWhOnBranch2 = await app.inject({
      method: 'POST',
      url: '/v1/org/warehouses',
      headers: {
        authorization: `Bearer ${mgrToken}`,
        'x-tenant-id': tenantAId,
      },
      payload: {
        branchId: branch2.id,
        code: 'WH-KDY-UNAUTH',
        name: 'Unauthorized Warehouse',
        allowNegativeStock: false,
      },
    });
    expect(mgrCreateWhOnBranch2.statusCode).toBe(403);
    expect(mgrCreateWhOnBranch2.json()).toMatchObject({
      errorCode: 'IAM_LOCATION_SCOPE_DENIED',
    });

    // Permission Check: Provision a Cashier on Branch 1; Cashier can read Branch 1 but cannot update it
    await app.inject({
      method: 'POST',
      url: '/v1/iam/members',
      headers: {
        authorization: `Bearer ${ownerAToken}`,
        'x-tenant-id': tenantAId,
      },
      payload: {
        userId: cashierId,
        email: 'cashier1@nexstock.example',
        fullName: 'Cashier One',
        roleCodes: ['CASHIER'],
        allLocationsAccess: false,
        branchIds: [branch1.id],
      },
    });
    const cashierToken = issueValidTokenForUser(
      cashierId,
      'cashier1@nexstock.example',
    );

    const cashierReadBranch1 = await app.inject({
      method: 'GET',
      url: `/v1/org/branches/${branch1.id}`,
      headers: {
        authorization: `Bearer ${cashierToken}`,
        'x-tenant-id': tenantAId,
      },
    });
    expect(cashierReadBranch1.statusCode).toBe(200);

    const cashierUpdateBranch1 = await app.inject({
      method: 'PATCH',
      url: `/v1/org/branches/${branch1.id}`,
      headers: {
        authorization: `Bearer ${cashierToken}`,
        'x-tenant-id': tenantAId,
      },
      payload: { name: 'Cashier Rename Attempt' },
    });
    expect(cashierUpdateBranch1.statusCode).toBe(403);
    expect(cashierUpdateBranch1.json()).toMatchObject({
      errorCode: 'IAM_PERMISSION_DENIED',
    });

    await app.close();
  });

  it('enforces subscription plan quotas, trial expiration, suspended status, admin overrides, and manual invoice/payment settlement', async () => {
    const app = await buildApp({ db: harness.db, jwksProvider });

    const tenantId = '0192b4a0-cccc-7000-8000-000000000001';
    const ownerId = '0192b4a0-cccc-7000-8000-000000000002';
    const ownerToken = issueValidTokenForUser(
      ownerId,
      'starter-owner@nexstock.example',
    );

    // 1. Onboard on STARTER plan (max_branches = 1, max_warehouses = 2)
    const onboardRes = await app.inject({
      method: 'POST',
      url: '/v1/org/tenants/onboard',
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': tenantId,
      },
      payload: {
        slug: 'starter-shop',
        legalName: 'Starter Shop Pvt Ltd',
        baseCurrency: 'USD',
        ownerEmail: 'starter-owner@nexstock.example',
        ownerFullName: 'Starter Owner',
        planCode: 'STARTER',
      },
    });
    expect(onboardRes.statusCode).toBe(201);

    // Creating 1st branch succeeds on STARTER plan
    const firstBranchRes = await app.inject({
      method: 'POST',
      url: '/v1/org/branches',
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': tenantId,
      },
      payload: {
        code: 'BR-01',
        name: 'Primary Branch',
        timezone: 'UTC',
        countryCode: 'US',
      },
    });
    expect(firstBranchRes.statusCode).toBe(201);
    const firstBranch = firstBranchRes.json<{ id: string }>();

    // Creating 2nd branch on STARTER plan is rejected with 403 SUB_QUOTA_EXCEEDED
    const secondBranchRes = await app.inject({
      method: 'POST',
      url: '/v1/org/branches',
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': tenantId,
      },
      payload: {
        code: 'BR-02',
        name: 'Second Branch Exceeding Starter Limit',
        timezone: 'UTC',
        countryCode: 'US',
      },
    });
    expect(secondBranchRes.statusCode).toBe(403);
    expect(secondBranchRes.json()).toMatchObject({
      errorCode: 'SUB_QUOTA_EXCEEDED',
    });

    // 2. Simulate Trial Expiration (trial_ends_at in the past)
    await withTenantTransaction(
      harness.db,
      { tenantId, userId: ownerId, traceId: generateUuidV7() },
      async (trx) => {
        await updateSubscriptionLifecycleAndOverride(trx, {
          status: 'TRIALING',
          trialEndsAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
        });
      },
    );

    const expiredTrialWriteRes = await app.inject({
      method: 'PATCH',
      url: `/v1/org/branches/${firstBranch.id}`,
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': tenantId,
      },
      payload: { name: 'Blocked By Expired Trial' },
    });
    expect(expiredTrialWriteRes.statusCode).toBe(403);
    expect(expiredTrialWriteRes.json()).toMatchObject({
      errorCode: 'SUB_TRIAL_EXPIRED',
    });

    // 3. Simulate SUSPENDED Subscription
    await withTenantTransaction(
      harness.db,
      { tenantId, userId: ownerId, traceId: generateUuidV7() },
      async (trx) => {
        await updateSubscriptionLifecycleAndOverride(trx, {
          status: 'SUSPENDED',
        });
      },
    );

    const suspendedReadRes = await app.inject({
      method: 'GET',
      url: '/v1/org/branches',
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': tenantId,
      },
    });
    expect(suspendedReadRes.statusCode).toBe(403);
    expect(suspendedReadRes.json()).toMatchObject({
      errorCode: 'SUB_SUBSCRIPTION_INACTIVE',
    });

    // 4. Authorized Admin Override permits access even while SUSPENDED or over quota
    await withTenantTransaction(
      harness.db,
      { tenantId, userId: ownerId, traceId: generateUuidV7() },
      async (trx) => {
        await updateSubscriptionLifecycleAndOverride(trx, {
          allowAdminOverride: true,
          overrideReason:
            'Verified wire transfer receipt pending bank clearance (#OVR-101)',
        });
      },
    );

    const overrideBranchCreateRes = await app.inject({
      method: 'POST',
      url: '/v1/org/branches',
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': tenantId,
      },
      payload: {
        code: 'BR-02',
        name: 'Second Branch Permitted By Admin Override',
        timezone: 'UTC',
        countryCode: 'US',
      },
    });
    expect(overrideBranchCreateRes.statusCode).toBe(201);

    // 5. Clear override, upgrade to GROWTH in PAST_DUE state, issue invoice, and record payment to reactivate
    await withTenantTransaction(
      harness.db,
      { tenantId, userId: ownerId, traceId: generateUuidV7() },
      async (trx) => {
        await updateSubscriptionLifecycleAndOverride(trx, {
          planCode: 'GROWTH',
          status: 'PAST_DUE',
          allowAdminOverride: false,
          overrideReason: null,
        });
      },
    );

    const issueInvoiceRes = await app.inject({
      method: 'POST',
      url: '/v1/subscriptions/invoices',
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': tenantId,
      },
      payload: {
        invoiceNumber: 'INV-SUB-2026-0001',
        currencyCode: 'USD',
        totalAmount: '99.0000',
        dueDate: '2026-11-15',
      },
    });
    expect(issueInvoiceRes.statusCode).toBe(201);
    const issuedInvoice = issueInvoiceRes.json<{ id: string; status: string }>();
    expect(issuedInvoice.status).toBe('OPEN');

    const recordPaymentRes = await app.inject({
      method: 'POST',
      url: `/v1/subscriptions/invoices/${issuedInvoice.id}/payments`,
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': tenantId,
      },
      payload: {
        currencyCode: 'USD',
        amount: '99.0000',
        paymentMethod: 'BANK_TRANSFER',
        referenceNumber: 'SLIPS-20261026-88991',
      },
    });
    expect(recordPaymentRes.statusCode).toBe(201);
    expect(recordPaymentRes.json()).toMatchObject({
      subscriptionStatus: 'ACTIVE',
      invoice: {
        id: issuedInvoice.id,
        status: 'PAID',
        totalAmount: '99.0000',
        amountPaid: '99.0000',
      },
    });

    await app.close();
  });

  it('manages I18N localization settings, fixed-point multi-currency exchange rates, and configurable cascading tax groups', async () => {
    const app = await buildApp({ db: harness.db, jwksProvider });

    const tenantId = '0192b4a0-dddd-7000-8000-000000000001';
    const ownerId = '0192b4a0-dddd-7000-8000-000000000002';
    const ownerToken = issueValidTokenForUser(
      ownerId,
      'i18n-owner@nexstock.example',
    );

    await app.inject({
      method: 'POST',
      url: '/v1/org/tenants/onboard',
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': tenantId,
      },
      payload: {
        slug: 'global-merchants',
        legalName: 'Global Merchants Lanka Ltd',
        baseCurrency: 'LKR',
        defaultLocale: 'si-LK',
        defaultTimezone: 'Asia/Colombo',
        countryCode: 'LK',
        ownerEmail: 'i18n-owner@nexstock.example',
        ownerFullName: 'I18N Owner',
        planCode: 'ENTERPRISE',
      },
    });

    // 1. Update Localization Settings
    const locRes = await app.inject({
      method: 'PUT',
      url: '/v1/i18n/localization',
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': tenantId,
      },
      payload: {
        locale: 'si-LK',
        timezone: 'Asia/Colombo',
        dateFormat: 'DD/MM/YYYY',
        numberFormat: '1,234.56',
        currencyDisplayMode: 'SYMBOL_AND_CODE',
      },
    });
    expect(locRes.statusCode).toBe(200);
    expect(locRes.json()).toMatchObject({
      locale: 'si-LK',
      timezone: 'Asia/Colombo',
      currencyDisplayMode: 'SYMBOL_AND_CODE',
    });

    // 2. Record 8-decimal Exchange Rate (1 USD = 298.75000000 LKR)
    const fxRes = await app.inject({
      method: 'POST',
      url: '/v1/i18n/exchange-rates',
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': tenantId,
      },
      payload: {
        sourceCurrency: 'USD',
        targetCurrency: 'LKR',
        rate: '298.75000000',
        effectiveFrom: '2026-01-01T00:00:00Z',
      },
    });
    expect(fxRes.statusCode).toBe(201);

    // 3. Convert 125.5000 USD -> LKR via fixed-point Money
    const convertRes = await app.inject({
      method: 'POST',
      url: '/v1/i18n/convert',
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': tenantId,
      },
      payload: {
        amount: '125.5000',
        sourceCurrency: 'USD',
        targetCurrency: 'LKR',
      },
    });
    expect(convertRes.statusCode).toBe(200);
    expect(convertRes.json()).toEqual({
      sourceAmount: '125.5000',
      sourceCurrency: 'USD',
      targetAmount: '37493.1250',
      targetCurrencyMinorString: '37493.12',
      targetCurrency: 'LKR',
      appliedRate: '298.75000000',
    });

    // 4. Configurable Tax Group & Cascading Tax Calculation + Documented Compliance Review Flags
    expect(I18N_COMPLIANCE_DECISIONS_FOR_REVIEW.length).toBeGreaterThanOrEqual(
      2,
    );

    await withTenantTransaction(
      harness.db,
      { tenantId, userId: ownerId, traceId: generateUuidV7() },
      async (trx) => {
        const currencies = await listSupportedCurrencies(trx);
        expect(currencies.some((c) => c.code === 'LKR')).toBe(true);
        expect(currencies.some((c) => c.code === 'KWD' && c.minorUnits === 3)).toBe(
          true,
        );

        const taxGroup = await createTaxGroupWithRates(trx, {
          code: 'STANDARD-INDIRECT-TAX',
          name: 'Configurable Cascading Indirect Tax Group',
          countryCode: 'LK',
          rates: [
            {
              code: 'LEVY-A',
              name: 'Primary Turnover Levy (2.5%)',
              ratePercentage: '2.5000',
              isCompound: false,
              priority: 1,
            },
            {
              code: 'VAT-STD',
              name: 'Value Added Tax (18% Compound)',
              ratePercentage: '18.0000',
              isCompound: true,
              priority: 2,
            },
          ],
        });

        const taxCalc = await calculateTaxForTaxGroup(trx, {
          taxGroupId: taxGroup.id,
          unitPrice: '1000.0000',
          quantity: '1.000000',
          currencyCode: 'LKR',
          isTaxInclusive: false,
        });

        // 1000.00 + 25.00 (2.5%) = 1025.00 taxable base for compound 18% VAT -> 184.50 -> Total Tax = 209.5000, Total = 1209.5000
        expect(taxCalc.netTaxableAmount).toBe('1000.0000');
        expect(taxCalc.totalTaxAmount).toBe('209.5000');
        expect(taxCalc.lineTotalWithTax).toBe('1209.5000');
      },
    );

    await app.close();
  });
});

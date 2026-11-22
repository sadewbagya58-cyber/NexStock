import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildApp,
  evaluateSubscriptionLifecycle,
  generateUuidV7,
  getOrCreateDevKeyMaterial,
  StaticJwksProvider,
  withTenantTransaction,
} from '../src/index.js';
import {
  type TestPostgresHarness,
  createTestPostgresHarness,
} from './helpers/pglite-kysely.js';

// Minimal valid 1x1 PNG image bytes
const TINY_PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
  0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06,
  0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44,
  0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d,
  0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42,
  0x60, 0x82,
]);

function generateTotpCode(base32Secret: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = base32Secret.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = alphabet.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000 / 30)), 0);
  const hmac = createHmac('sha1', Buffer.from(out)).update(msg).digest();
  const offset = (hmac[hmac.length - 1] ?? 0) & 0x0f;
  const bin =
    (((hmac[offset] ?? 0) & 0x7f) << 24) |
    (((hmac[offset + 1] ?? 0) & 0xff) << 16) |
    (((hmac[offset + 2] ?? 0) & 0xff) << 8) |
    ((hmac[offset + 3] ?? 0) & 0xff);
  return String(bin % 1_000_000).padStart(6, '0');
}

describe('Phase 10.1-10.4 — SaaS Subscription Plans, Entitlements, Lifecycle & Hybrid Billing', () => {
  let harness: TestPostgresHarness;
  let devJwksProvider: StaticJwksProvider;
  let app: Awaited<ReturnType<typeof buildApp>>;

  let ownerAToken = '';
  let ownerAId = '';
  let tenantAId = '';
  let tenantAMainBranchId = '';

  let ownerBToken = '';
  let ownerBId = '';
  let tenantBId = '';

  let regularUserToken = '';
  let platformAdminToken = '';
  let platformAdminId = '';

  beforeAll(async () => {
    harness = await createTestPostgresHarness();
    const devKeys = getOrCreateDevKeyMaterial();
    devJwksProvider = new StaticJwksProvider({
      keys: [devKeys.publicJwk],
    });
    app = await buildApp({
      db: harness.db,
      jwksProvider: devJwksProvider,
    });

    // Sign up Business A owner & onboard Tenant A
    const signupA = await app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: {
        email: `owner_a_${generateUuidV7()}@example.com`,
        password: 'StrongPassword123!',
        fullName: 'Tenant A Owner',
      },
    });
    expect(signupA.statusCode).toBe(201);
    ownerAToken = signupA.json().token;
    ownerAId = signupA.json().userId;

    const onboardA = await app.inject({
      method: 'POST',
      url: '/v1/org/onboard',
      headers: { authorization: `Bearer ${ownerAToken}` },
      payload: {
        businessName: 'Lanka Traders Pvt Ltd',
        businessType: 'RETAIL',
        currency: 'LKR',
        firstBranchName: 'Colombo Main',
        firstBranchCode: 'CMB-01',
        countryCode: 'LK',
      },
    });
    expect(onboardA.statusCode).toBe(201);
    tenantAId = onboardA.json().tenant.id;
    tenantAMainBranchId = onboardA.json().branch.id;

    // Sign up Business B owner & onboard Tenant B (for cross-tenant isolation tests)
    const signupB = await app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: {
        email: `owner_b_${generateUuidV7()}@example.com`,
        password: 'StrongPassword123!',
        fullName: 'Tenant B Owner',
      },
    });
    expect(signupB.statusCode).toBe(201);
    ownerBToken = signupB.json().token;
    ownerBId = signupB.json().userId;

    const onboardB = await app.inject({
      method: 'POST',
      url: '/v1/org/onboard',
      headers: { authorization: `Bearer ${ownerBToken}` },
      payload: {
        businessName: 'Kandy Mart',
        businessType: 'RETAIL',
        currency: 'LKR',
        firstBranchName: 'Kandy HQ',
        firstBranchCode: 'KDY-01',
        countryCode: 'LK',
      },
    });
    expect(onboardB.statusCode).toBe(201);
    tenantBId = onboardB.json().tenant.id;

    // Non-admin user claiming platform operations (must fail 403)
    const signupRegular = await app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: {
        email: `nonadmin_${generateUuidV7()}@example.com`,
        password: 'StrongPassword123!',
        fullName: 'Unauthorized User',
      },
    });
    expect(signupRegular.statusCode).toBe(201);
    regularUserToken = signupRegular.json().token;

    // Seed initial Platform Admin identity & flag strictly in DB
    const signupAdmin = await app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: {
        email: 'sadewbagya58@gmail.com',
        password: 'SuperAdminPassword123!',
        fullName: 'NexStock Platform Admin',
      },
    });
    expect(signupAdmin.statusCode).toBe(201);
    platformAdminToken = signupAdmin.json().token;
    platformAdminId = signupAdmin.json().userId;

    // Verify default signup does NOT automatically elevate even sadewbagya58@gmail.com until DB flag is set
    const beforeFlagCheck = await app.inject({
      method: 'GET',
      url: '/v1/platform/subscriptions/payments',
      headers: { authorization: `Bearer ${platformAdminToken}` },
    });
    expect(beforeFlagCheck.statusCode).toBe(403);
    expect(beforeFlagCheck.json().errorCode).toBe('SUB_PLATFORM_ADMIN_REQUIRED');

    // Explicitly set is_platform_admin = true in users table
    await harness.db
      .updateTable('users')
      .set({ is_platform_admin: true })
      .where('id', '=', platformAdminId)
      .execute();

    // Complete enforced Super Admin 2FA enrollment & verification
    const mfaSetupRes = await app.inject({
      method: 'POST',
      url: '/v1/platform/security/mfa/setup',
      headers: { authorization: `Bearer ${platformAdminToken}` },
      payload: {},
    });
    expect(mfaSetupRes.statusCode).toBe(200);
    const totpCode = generateTotpCode(mfaSetupRes.json().secretBase32 as string);
    const mfaVerifyRes = await app.inject({
      method: 'POST',
      url: '/v1/platform/security/mfa/verify',
      headers: { authorization: `Bearer ${platformAdminToken}` },
      payload: { code: totpCode },
    });
    expect(mfaVerifyRes.statusCode).toBe(200);
  });

  afterAll(async () => {
    delete process.env.NEXSTOCK_STRIPE_WEBHOOK_SECRET;
    await app.close();
    await harness.db.destroy();
  });

  it('10.1 Plan Catalog exposes Starter/Professional/Enterprise in LKR with hidden GROWTH compatibility and exact fixed-point quotes', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/subscriptions/plans',
    });
    expect(res.statusCode).toBe(200);
    const items = res.json().items as Array<Record<string, unknown>>;
    expect(items.map((p) => p.code)).toEqual([
      'STARTER',
      'PROFESSIONAL',
      'ENTERPRISE',
    ]);

    const starter = items.find((p) => p.code === 'STARTER')!;
    expect(starter.monthlyPriceAmount).toBe('2990.0000');
    expect(starter.annualDiscountPct).toBe('15.00');
    expect(starter.annualMonthlyEquivalent).toBe('2541.5000');
    expect(starter.additionalBranchMonthlyFee).toBe('750.0000');
    expect((starter.limits as Record<string, number>).maxBranches).toBe(1);
    expect((starter.limits as Record<string, number>).maxUsers).toBe(3);
    expect((starter.limits as Record<string, number>).maxProducts).toBe(2500);
    expect((starter.limits as Record<string, number>).maxStorageMb).toBe(10240);
    expect(starter.trialDays).toBe(30);
    expect((starter.features as Record<string, boolean>).loyaltyProgram).toBeUndefined();
    expect((starter.features as Record<string, boolean>).hrm).toBe(false);
    expect((starter.features as Record<string, boolean>).desktopOfflinePos).toBe(false);
    expect((starter.features as Record<string, boolean>).multiBranchManagement).toBe(false);
    expect((starter.features as Record<string, boolean>).apiAccess).toBe(false);
    expect((starter.features as Record<string, boolean>).posPaymentCash).toBe(true);
    expect((starter.features as Record<string, boolean>).posPaymentCard).toBe(false);
    expect((starter.features as Record<string, boolean>).barcodeFull).toBe(true);

    const pro = items.find((p) => p.code === 'PROFESSIONAL')!;
    expect(pro.monthlyPriceAmount).toBe('5990.0000');
    expect(pro.annualDiscountPct).toBe('15.00');
    expect(pro.additionalBranchMonthlyFee).toBe('500.0000');
    expect((pro.limits as Record<string, number>).maxBranches).toBe(5);
    expect((pro.limits as Record<string, number>).maxUsers).toBe(15);
    expect((pro.limits as Record<string, number>).maxProducts).toBe(25000);
    expect((pro.limits as Record<string, number>).maxStorageMb).toBe(51200);
    expect((pro.features as Record<string, boolean>).desktopOfflinePos).toBe(true);
    expect((pro.features as Record<string, boolean>).mobileOfflinePos).toBe(true);
    expect((pro.features as Record<string, boolean>).multiBranchManagement).toBe(true);
    expect((pro.features as Record<string, boolean>).stockTransfers).toBe(true);
    expect((pro.features as Record<string, boolean>).apiAccess).toBe(true);
    expect((pro.features as Record<string, boolean>).posPaymentCard).toBe(true);
    expect((pro.features as Record<string, boolean>).batchTracking).toBe(true);
    expect((pro.features as Record<string, boolean>).loyaltyProgram).toBeUndefined();

    // Hidden GROWTH alias still resolves when includeHidden=true
    const hiddenRes = await app.inject({
      method: 'GET',
      url: '/v1/subscriptions/plans?includeHidden=true',
    });
    expect(
      (hiddenRes.json().items as Array<{ code: string }>).some(
        (p) => p.code === 'GROWTH',
      ),
    ).toBe(true);

    // Pricing quote verification
    const annualQuote = await app.inject({
      method: 'POST',
      url: '/v1/subscriptions/calculate-pricing',
      payload: {
        planCode: 'STARTER',
        billingCycle: 'ANNUAL',
        additionalBranchCount: 0,
      },
    });
    expect(annualQuote.statusCode).toBe(200);
    expect(annualQuote.json()).toMatchObject({
      currencyCode: 'LKR',
      planCycleGrossAmount: '35880.0000',
      annualDiscountAmount: '5382.0000',
      planCycleNetAmount: '30498.0000',
      totalDueNow: '30498.0000',
    });

    const proProratedQuote = await app.inject({
      method: 'POST',
      url: '/v1/subscriptions/calculate-pricing',
      payload: {
        planCode: 'STARTER',
        billingCycle: 'MONTHLY',
        additionalBranchCount: 1,
        prorateBranchDaysRemaining: 15,
        prorateCycleTotalDays: 30,
      },
    });
    expect(proProratedQuote.statusCode).toBe(200);
    expect(proProratedQuote.json().proratedAdditionalBranchAmount).toBe('375.0000');
    expect(proProratedQuote.json().totalDueNow).toBe('3365.0000');
  });

  it('10.1 & 10.3 Free Trial defaults to 30 days on onboard and prevents starting duplicate free trials', async () => {
    const entRes = await app.inject({
      method: 'GET',
      url: '/v1/subscriptions/entitlement',
      headers: {
        authorization: `Bearer ${ownerAToken}`,
        'x-tenant-id': tenantAId,
      },
    });
    expect(entRes.statusCode).toBe(200);
    expect(entRes.json().status).toBe('TRIALING');
    expect(entRes.json().planCode).toBe('STARTER');
    expect(entRes.json().limits.maxBranches).toBe(1);

    const usageTrialRes = await app.inject({
      method: 'GET',
      url: '/v1/subscriptions/usage',
      headers: {
        authorization: `Bearer ${ownerAToken}`,
        'x-tenant-id': tenantAId,
      },
    });
    expect(usageTrialRes.statusCode).toBe(200);
    expect(usageTrialRes.json().trialDaysRemaining).toBeGreaterThanOrEqual(29);

    // Attempting to start a second free trial must be rejected
    const dupTrial = await app.inject({
      method: 'POST',
      url: '/v1/subscriptions/trial/start',
      headers: {
        authorization: `Bearer ${ownerAToken}`,
        'x-tenant-id': tenantAId,
      },
      payload: { planCode: 'STARTER' },
    });
    expect(dupTrial.statusCode).toBe(409);
    expect(dupTrial.json().errorCode).toBe('SUB_TRIAL_ALREADY_USED');
  });

  it('10.2 & 10.4 Starter limits, multi-branch quota, extra branch add-on without feature unlock, and private Bank Transfer approval workflow', async () => {
    // Check central bank settings match required initial configuration
    const bankRes = await app.inject({
      method: 'GET',
      url: '/v1/subscriptions/bank-settings',
    });
    expect(bankRes.statusCode).toBe(200);
    expect(bankRes.json()).toMatchObject({
      bankAccountName: 'W.Swarnalatha',
      bankName: "People's Bank",
      bankBranch: 'Bingiriya Branch',
      bankAccountNumber: '172200270058302',
    });

    // Move Tenant A onto STARTER ACTIVE so Starter quotas & Starter feature restrictions are active
    const patchStarter = await app.inject({
      method: 'PATCH',
      url: '/v1/subscriptions/lifecycle',
      headers: {
        authorization: `Bearer ${ownerAToken}`,
        'x-tenant-id': tenantAId,
      },
      payload: {
        planCode: 'STARTER',
        status: 'ACTIVE',
        allowAdminOverride: false,
      },
    });
    expect(patchStarter.statusCode).toBe(200);
    expect(patchStarter.json().planCode).toBe('STARTER');
    expect(patchStarter.json().limits.maxBranches).toBe(1);
    expect(patchStarter.json().limits.maxUsers).toBe(3);

    // 1. Feature matrix check: Starter blocks Offline Device Enrollment and Stock Transfers
    const enrollDenied = await app.inject({
      method: 'POST',
      url: '/v1/sync/devices/enroll',
      headers: {
        authorization: `Bearer ${ownerAToken}`,
        'x-tenant-id': tenantAId,
      },
      payload: {
        deviceId: generateUuidV7(),
        branchId: tenantAMainBranchId,
        clientPlatform: 'TAURI_DESKTOP',
        deviceName: 'Counter PC',
      },
    });
    expect(enrollDenied.statusCode).toBe(403);
    expect(enrollDenied.json().errorCode).toBe('SUB_FEATURE_NOT_ENTITLED');

    // 2. Branch quota check: Starter (1 branch max) blocks creating 2nd branch
    const branchDenied = await app.inject({
      method: 'POST',
      url: '/v1/org/branches',
      headers: {
        authorization: `Bearer ${ownerAToken}`,
        'x-tenant-id': tenantAId,
        'idempotency-key': generateUuidV7(),
      },
      payload: {
        code: 'GALLE-02',
        name: 'Galle Branch',
      },
    });
    expect(branchDenied.statusCode).toBe(403);
    expect(branchDenied.json().errorCode).toBe('SUB_QUOTA_EXCEEDED');

    // 3. Extra Branch Add-On checkout on Starter (prorated) -> does NOT increment branches until verified paid!
    const addonCheckout = await app.inject({
      method: 'POST',
      url: '/v1/subscriptions/branch-addons/checkout',
      headers: {
        authorization: `Bearer ${ownerAToken}`,
        'x-tenant-id': tenantAId,
      },
      payload: { additionalBranches: 1 },
    });
    expect(addonCheckout.statusCode).toBe(201);
    const addonInvoiceId = addonCheckout.json().invoiceId as string;

    // Upload fake bytes -> must reject cleanly
    const badProofRes = await app.inject({
      method: 'POST',
      url: '/v1/subscriptions/payments/bank-transfer',
      headers: {
        authorization: `Bearer ${ownerAToken}`,
        'x-tenant-id': tenantAId,
        'idempotency-key': generateUuidV7(),
      },
      payload: {
        invoiceId: addonInvoiceId,
        paymentReference: 'REF-BAD-001',
        proofFileName: 'fake.png',
        proofMimeType: 'image/png',
        proofDataBase64: Buffer.from('not-a-valid-png').toString('base64'),
      },
    });
    expect(badProofRes.statusCode).toBe(400);

    // Valid PNG receipt submission for add-on
    const addonSubRes = await app.inject({
      method: 'POST',
      url: '/v1/subscriptions/payments/bank-transfer',
      headers: {
        authorization: `Bearer ${ownerAToken}`,
        'x-tenant-id': tenantAId,
        'idempotency-key': generateUuidV7(),
      },
      payload: {
        invoiceId: addonInvoiceId,
        paymentReference: 'PB-ADDON-7788',
        proofFileName: 'addon-slip.png',
        proofMimeType: 'image/png',
        proofDataBase64: TINY_PNG_BYTES.toString('base64'),
      },
    });
    expect(addonSubRes.statusCode).toBe(201);
    const addonSubId = addonSubRes.json().id as string;
    expect(addonSubRes.json().status).toBe('SUBMITTED');

    // Verify branch limit is STILL 1 BEFORE Platform Admin approval
    const entBeforeApprove = await app.inject({
      method: 'GET',
      url: '/v1/subscriptions/entitlement',
      headers: {
        authorization: `Bearer ${ownerAToken}`,
        'x-tenant-id': tenantAId,
      },
    });
    expect(entBeforeApprove.json().limits.maxBranches).toBe(1);

    // Regular non-admin cannot approve
    const unauthApprove = await app.inject({
      method: 'POST',
      url: `/v1/platform/subscriptions/payments/${addonSubId}/verify`,
      headers: { authorization: `Bearer ${regularUserToken}` },
      payload: { decision: 'APPROVE' },
    });
    expect(unauthApprove.statusCode).toBe(403);
    expect(unauthApprove.json().errorCode).toBe('SUB_PLATFORM_ADMIN_REQUIRED');

    // Platform Admin rejects first -> Tenant sees rejection reason -> Resubmits -> Admin approves
    const rejectRes = await app.inject({
      method: 'POST',
      url: `/v1/platform/subscriptions/payments/${addonSubId}/verify`,
      headers: { authorization: `Bearer ${platformAdminToken}` },
      payload: {
        decision: 'REJECT',
        rejectionReason: 'Slip reference illegible please re-upload',
      },
    });
    expect(rejectRes.statusCode).toBe(200);
    expect(rejectRes.json().submission.status).toBe('REJECTED');

    const resubmitRes = await app.inject({
      method: 'POST',
      url: '/v1/subscriptions/payments/bank-transfer',
      headers: {
        authorization: `Bearer ${ownerAToken}`,
        'x-tenant-id': tenantAId,
        'idempotency-key': generateUuidV7(),
      },
      payload: {
        invoiceId: addonInvoiceId,
        paymentReference: 'PB-ADDON-7788-CLEAR',
        proofFileName: 'addon-slip-clear.png',
        proofMimeType: 'image/png',
        proofDataBase64: TINY_PNG_BYTES.toString('base64'),
        resubmitSubmissionId: addonSubId,
      },
    });
    expect(resubmitRes.statusCode).toBe(201);
    expect(resubmitRes.json().status).toBe('SUBMITTED');

    // Cross-tenant access to proof MUST be denied!
    const crossTenantProof = await app.inject({
      method: 'GET',
      url: `/v1/subscriptions/payments/${addonSubId}/proof`,
      headers: {
        authorization: `Bearer ${ownerBToken}`,
        'x-tenant-id': tenantBId,
      },
    });
    expect(crossTenantProof.statusCode).toBe(404);

    // Owning tenant & Platform Admin CAN download private proof bytes
    const ownerProof = await app.inject({
      method: 'GET',
      url: `/v1/subscriptions/payments/${addonSubId}/proof`,
      headers: {
        authorization: `Bearer ${ownerAToken}`,
        'x-tenant-id': tenantAId,
      },
    });
    expect(ownerProof.statusCode).toBe(200);
    expect(ownerProof.headers['cache-control']).toBe('no-store');
    expect(ownerProof.rawPayload.equals(TINY_PNG_BYTES)).toBe(true);

    const adminProof = await app.inject({
      method: 'GET',
      url: `/v1/platform/subscriptions/payments/${addonSubId}/proof`,
      headers: { authorization: `Bearer ${platformAdminToken}` },
    });
    expect(adminProof.statusCode).toBe(200);
    expect(adminProof.rawPayload.equals(TINY_PNG_BYTES)).toBe(true);

    // Platform Admin approves resubmission
    const approveAddonRes = await app.inject({
      method: 'POST',
      url: `/v1/platform/subscriptions/payments/${addonSubId}/verify`,
      headers: { authorization: `Bearer ${platformAdminToken}` },
      payload: { decision: 'APPROVE' },
    });
    expect(approveAddonRes.statusCode).toBe(200);
    expect(approveAddonRes.json().submission.status).toBe('VERIFIED');

    // Preventing double-approval on verified submission
    const doubleApprove = await app.inject({
      method: 'POST',
      url: `/v1/platform/subscriptions/payments/${addonSubId}/verify`,
      headers: { authorization: `Bearer ${platformAdminToken}` },
      payload: { decision: 'APPROVE' },
    });
    expect(doubleApprove.statusCode).toBe(409);
    expect(doubleApprove.json().errorCode).toBe('SUB_PAYMENT_ALREADY_VERIFIED');

    // Branch quota increased to 2, AND extra branch still does NOT unlock multi-branch transfers / offline POS on Starter!
    const createBranch2 = await app.inject({
      method: 'POST',
      url: '/v1/org/branches',
      headers: {
        authorization: `Bearer ${ownerAToken}`,
        'x-tenant-id': tenantAId,
        'idempotency-key': generateUuidV7(),
      },
      payload: {
        code: 'GALLE-02',
        name: 'Galle Branch',
      },
    });
    expect(createBranch2.statusCode).toBe(201);

    const stillDeniedOffline = await app.inject({
      method: 'POST',
      url: '/v1/sync/devices/enroll',
      headers: {
        authorization: `Bearer ${ownerAToken}`,
        'x-tenant-id': tenantAId,
      },
      payload: {
        deviceId: generateUuidV7(),
        branchId: tenantAMainBranchId,
        clientPlatform: 'TAURI_DESKTOP',
        deviceName: 'Still Blocked On Starter',
      },
    });
    expect(stillDeniedOffline.statusCode).toBe(403);
    expect(stillDeniedOffline.json().errorCode).toBe('SUB_FEATURE_NOT_ENTITLED');
  });

  it('10.2 & 10.3 Usage counting, Storage & SKU quota enforcement, Upgrade Activation, Downgrade Scheduling, and Grace Period transitions', async () => {
    // Check live usage after 2 branches created
    const usageRes = await app.inject({
      method: 'GET',
      url: '/v1/subscriptions/usage',
      headers: {
        authorization: `Bearer ${ownerAToken}`,
        'x-tenant-id': tenantAId,
      },
    });
    expect(usageRes.statusCode).toBe(200);
    expect(usageRes.json()).toMatchObject({
      planCode: 'STARTER',
      activeBranchesCount: 2,
      includedBranches: 1,
      additionalBranchSlots: 1,
      effectiveMaxBranches: 2,
      distinctActiveUsersCount: 1,
      maxUsers: 3,
    });

    // Create a product & upload tiny PNG -> storage usage increases accurately
    const prodRes = await app.inject({
      method: 'POST',
      url: '/v1/products',
      headers: {
        authorization: `Bearer ${ownerAToken}`,
        'x-tenant-id': tenantAId,
        'idempotency-key': generateUuidV7(),
      },
      payload: {
        sku: 'SKU-TEST-001',
        name: 'Ceylon Tea 100g',
        baseUom: 'PCS',
        purchaseCost: '250.0000',
        sellingPrice: '400.0000',
      },
    });
    expect(prodRes.statusCode).toBe(201);
    expect(prodRes.json().id).toBeTruthy();

    const imgUpload = await app.inject({
      method: 'POST',
      url: '/v1/products/upload-image',
      headers: {
        authorization: `Bearer ${ownerAToken}`,
        'x-tenant-id': tenantAId,
      },
      payload: {
        filename: 'tea.png',
        mimeType: 'image/png',
        dataBase64: TINY_PNG_BYTES.toString('base64'),
      },
    });
    expect(imgUpload.statusCode).toBe(201);

    // Temporarily tighten custom maxProducts=1 & maxStorageMb=0 via DB to test product & storage hard guards without deleting existing assets
    await harness.db
      .updateTable('tenant_subscriptions')
      .set({
        custom_limits_json: JSON.stringify({ maxProducts: 1, maxStorageMb: 0 }),
      })
      .where('tenant_id', '=', tenantAId)
      .execute();

    const prodOverQuota = await app.inject({
      method: 'POST',
      url: '/v1/products',
      headers: {
        authorization: `Bearer ${ownerAToken}`,
        'x-tenant-id': tenantAId,
        'idempotency-key': generateUuidV7(),
      },
      payload: {
        sku: 'SKU-OVER-QUOTA',
        name: 'Blocked Product',
        baseUom: 'PCS',
        purchaseCost: '100.0000',
        sellingPrice: '200.0000',
      },
    });
    expect(prodOverQuota.statusCode).toBe(403);
    expect(prodOverQuota.json().errorCode).toBe('SUB_QUOTA_EXCEEDED');

    const imgOverQuota = await app.inject({
      method: 'POST',
      url: '/v1/products/upload-image',
      headers: {
        authorization: `Bearer ${ownerAToken}`,
        'x-tenant-id': tenantAId,
      },
      payload: {
        filename: 'blocked.jpg',
        mimeType: 'image/jpeg',
        dataBase64: Buffer.from([
          0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
          0x01, 0x00, 0x00, 0x01,
        ]).toString('base64'),
      },
    });
    expect(imgOverQuota.statusCode).toBe(403);
    expect(imgOverQuota.json().errorCode).toBe('SUB_QUOTA_EXCEEDED');

    // Clear test custom limit override before upgrade test
    await harness.db
      .updateTable('tenant_subscriptions')
      .set({ custom_limits_json: null })
      .where('tenant_id', '=', tenantAId)
      .execute();

    // Initiate Upgrade Checkout to PROFESSIONAL ANNUAL
    const upgCheckout = await app.inject({
      method: 'POST',
      url: '/v1/subscriptions/checkout/upgrade',
      headers: {
        authorization: `Bearer ${ownerAToken}`,
        'x-tenant-id': tenantAId,
      },
      payload: {
        targetPlanCode: 'PROFESSIONAL',
        billingCycle: 'ANNUAL',
      },
    });
    expect(upgCheckout.statusCode).toBe(201);
    const upgInvoiceId = upgCheckout.json().invoice.id as string;
    const upgTotalDue = upgCheckout.json().invoice.totalAmount as string;

    // Must STILL be STARTER before payment settlement!
    const beforePayEnt = await app.inject({
      method: 'GET',
      url: '/v1/subscriptions/entitlement',
      headers: {
        authorization: `Bearer ${ownerAToken}`,
        'x-tenant-id': tenantAId,
      },
    });
    expect(beforePayEnt.json().planCode).toBe('STARTER');

    // Online Gateway without secret safely returns GATEWAY_CONFIGURATION_REQUIRED without activating!
    const unconfGw = await app.inject({
      method: 'POST',
      url: '/v1/subscriptions/checkout/online',
      headers: {
        authorization: `Bearer ${ownerAToken}`,
        'x-tenant-id': tenantAId,
      },
      payload: {
        invoiceId: upgInvoiceId,
        providerCode: 'STRIPE',
      },
    });
    expect(unconfGw.statusCode).toBe(201);
    expect(unconfGw.json().mode).toBe('GATEWAY_CONFIGURATION_REQUIRED');
    expect(unconfGw.json().configured).toBe(false);

    // Configure STRIPE test webhook secret & test signature + amount + idempotency
    const testSecret = 'whsec_test_nexstock_phase10_secret';
    process.env.NEXSTOCK_STRIPE_WEBHOOK_SECRET = testSecret;
    const gwSession = await app.inject({
      method: 'POST',
      url: '/v1/subscriptions/checkout/online',
      headers: {
        authorization: `Bearer ${ownerAToken}`,
        'x-tenant-id': tenantAId,
      },
      payload: {
        invoiceId: upgInvoiceId,
        providerCode: 'STRIPE',
      },
    });
    expect(gwSession.json().configured).toBe(true);
    const gwSubmissionId = gwSession.json().submissionId as string;

    // Invalid webhook signature -> 401
    const badSigPayload = {
      providerEventId: 'evt_bad_sig_01',
      tenantId: tenantAId,
      submissionId: gwSubmissionId,
      gatewayTransactionId: 'pi_test_01',
      status: 'VERIFIED',
      paidAmount: upgTotalDue,
      currencyCode: 'LKR',
    };
    const badSigRes = await app.inject({
      method: 'POST',
      url: '/v1/subscriptions/webhooks/STRIPE',
      headers: { 'x-gateway-signature': 'deadbeef' },
      payload: badSigPayload,
    });
    expect(badSigRes.statusCode).toBe(401);
    expect(badSigRes.json().errorCode).toBe('SUB_WEBHOOK_SIGNATURE_INVALID');

    // Underpaid amount -> 422
    const underpaidPayload = {
      providerEventId: 'evt_underpaid_01',
      tenantId: tenantAId,
      submissionId: gwSubmissionId,
      gatewayTransactionId: 'pi_test_02',
      status: 'VERIFIED',
      paidAmount: '100.0000',
      currencyCode: 'LKR',
    };
    const underpaidSig = createHmac('sha256', testSecret)
      .update(JSON.stringify(underpaidPayload), 'utf-8')
      .digest('hex');
    const underpaidRes = await app.inject({
      method: 'POST',
      url: '/v1/subscriptions/webhooks/STRIPE',
      headers: { 'x-gateway-signature': underpaidSig },
      payload: underpaidPayload,
    });
    expect(underpaidRes.statusCode).toBe(422);
    expect(underpaidRes.json().errorCode).toBe('SUB_PAYMENT_AMOUNT_MISMATCH');

    // Valid webhook -> activates PROFESSIONAL immediately!
    const validPayload = {
      providerEventId: 'evt_paid_success_01',
      tenantId: tenantAId,
      submissionId: gwSubmissionId,
      gatewayTransactionId: 'pi_test_success_01',
      status: 'VERIFIED',
      paidAmount: upgTotalDue,
      currencyCode: 'LKR',
    };
    const validSig = createHmac('sha256', testSecret)
      .update(JSON.stringify(validPayload), 'utf-8')
      .digest('hex');
    const validRes = await app.inject({
      method: 'POST',
      url: '/v1/subscriptions/webhooks/STRIPE',
      headers: { 'x-gateway-signature': validSig },
      payload: validPayload,
    });
    expect(validRes.statusCode).toBe(200);
    expect(validRes.json()).toMatchObject({
      duplicate: false,
      status: 'ACTIVE',
    });

    // Duplicate webhook replay -> idempotent no-op!
    const replayRes = await app.inject({
      method: 'POST',
      url: '/v1/subscriptions/webhooks/STRIPE',
      headers: { 'x-gateway-signature': validSig },
      payload: validPayload,
    });
    expect(replayRes.statusCode).toBe(200);
    expect(replayRes.json().duplicate).toBe(true);

    // Offline enrollment now succeeds immediately on PROFESSIONAL!
    const enrollOk = await app.inject({
      method: 'POST',
      url: '/v1/sync/devices/enroll',
      headers: {
        authorization: `Bearer ${ownerAToken}`,
        'x-tenant-id': tenantAId,
      },
      payload: {
        deviceId: generateUuidV7(),
        branchId: tenantAMainBranchId,
        clientPlatform: 'TAURI_DESKTOP',
        deviceName: 'Counter Pro PC',
      },
    });
    expect(enrollOk.statusCode).toBe(200);

    // Schedule Downgrade -> does NOT downgrade immediately; Cancel restores cleanly
    const schedDown = await app.inject({
      method: 'POST',
      url: '/v1/subscriptions/downgrade/schedule',
      headers: {
        authorization: `Bearer ${ownerAToken}`,
        'x-tenant-id': tenantAId,
      },
      payload: { targetPlanCode: 'STARTER', reason: 'Seasonal reduction' },
    });
    expect(schedDown.statusCode).toBe(200);
    expect(schedDown.json().planCode).toBe('PROFESSIONAL');
    expect(schedDown.json().scheduledDowngradePlanCode).toBe('STARTER');

    const cancelDown = await app.inject({
      method: 'POST',
      url: '/v1/subscriptions/downgrade/cancel',
      headers: {
        authorization: `Bearer ${ownerAToken}`,
        'x-tenant-id': tenantAId,
      },
    });
    expect(cancelDown.statusCode).toBe(200);
    expect(cancelDown.json().scheduledDowngradePlanCode).toBeNull();

    // 7-day post-expiry Grace Period & Read-Only lifecycle transitions on Tenant B
    const nowPlus32d = new Date(Date.now() + 32 * 86_400_000);
    const inGrace = await withTenantTransaction(
      harness.db,
      { tenantId: tenantBId, userId: ownerBId, traceId: 'test-grace' },
      (trx) => evaluateSubscriptionLifecycle(trx, nowPlus32d),
    );
    expect(inGrace.status).toBe('GRACE_PERIOD');

    const nowPlus40d = new Date(Date.now() + 40 * 86_400_000);
    const inReadOnly = await withTenantTransaction(
      harness.db,
      { tenantId: tenantBId, userId: ownerBId, traceId: 'test-readonly' },
      (trx) => evaluateSubscriptionLifecycle(trx, nowPlus40d),
    );
    expect(inReadOnly.status).toBe('READ_ONLY');

    // Platform Admin configurability: update Starter discount & Bank Instructions
    const updBank = await app.inject({
      method: 'PATCH',
      url: '/v1/platform/subscriptions/settings',
      headers: { authorization: `Bearer ${platformAdminToken}` },
      payload: {
        bankInstructions: 'Include Business Name + Invoice Ref in remarks.',
      },
    });
    expect(updBank.statusCode).toBe(200);
    expect(updBank.json().bankInstructions).toBe(
      'Include Business Name + Invoice Ref in remarks.',
    );

    const updPlan = await app.inject({
      method: 'PATCH',
      url: '/v1/platform/subscriptions/plans/STARTER',
      headers: { authorization: `Bearer ${platformAdminToken}` },
      payload: {
        annualDiscountPct: '20.00',
      },
    });
    expect(updPlan.statusCode).toBe(200);
    expect(updPlan.json().annualDiscountPct).toBe('20.00');

    // Also silence unused var check while confirming ownerAId exists
    expect(ownerAId).toBeTruthy();
  });
});

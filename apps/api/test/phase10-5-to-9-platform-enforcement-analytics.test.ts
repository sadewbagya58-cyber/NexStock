import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
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

const TINY_PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
  0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06,
  0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44,
  0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d,
  0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42,
  0x60, 0x82,
]);

function generateTotpCodeFromBase32(base32Secret: string): string {
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
  const secretBuf = Buffer.from(out);
  const counter = BigInt(Math.floor(Date.now() / 1000 / 30));
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(counter, 0);
  const hmac = createHmac('sha1', secretBuf).update(msg).digest();
  const offset = (hmac[hmac.length - 1] ?? 0) & 0x0f;
  const bin =
    (((hmac[offset] ?? 0) & 0x7f) << 24) |
    (((hmac[offset + 1] ?? 0) & 0xff) << 16) |
    (((hmac[offset + 2] ?? 0) & 0xff) << 8) |
    ((hmac[offset + 3] ?? 0) & 0xff);
  return String(bin % 1_000_000).padStart(6, '0');
}

describe('Phase 10.5-10.9 — Subscription Enforcement, Platform Super Admin, Business Portal, SaaS Analytics & Security', () => {
  let harness: TestPostgresHarness;
  let app: Awaited<ReturnType<typeof buildApp>>;

  let ownerAToken = '';
  let ownerAId = '';
  let tenantAId = '';
  let tenantAMainBranchId = '';
  let tenantAWhId = '';
  let tenantACatId = '';
  let tenantAProdId = '';

  let ownerBToken = '';
  let tenantBId = '';

  let platformAdminToken = '';
  let platformAdminId = '';
  let financeAdminToken = '';
  let financeAdminEmail = '';

  beforeAll(async () => {
    harness = await createTestPostgresHarness();
    const devKeys = getOrCreateDevKeyMaterial();
    const devJwksProvider = new StaticJwksProvider({ keys: [devKeys.publicJwk] });
    app = await buildApp({ db: harness.db, jwksProvider: devJwksProvider });

    // Onboard Tenant A (Owner A)
    const sA = await app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: {
        email: `owner_a_105_${generateUuidV7()}@example.com`,
        password: 'StrongPassword123!',
        fullName: 'Phase 10.5 Owner A',
      },
    });
    expect(sA.statusCode).toBe(201);
    ownerAToken = sA.json().token;
    ownerAId = sA.json().userId;

    const obA = await app.inject({
      method: 'POST',
      url: '/v1/org/onboard',
      headers: { authorization: `Bearer ${ownerAToken}` },
      payload: {
        businessName: 'Colombo Electronics Co',
        businessType: 'RETAIL',
        currency: 'LKR',
        firstBranchName: 'Fort Main',
        firstBranchCode: 'FRT-01',
        countryCode: 'LK',
      },
    });
    expect(obA.statusCode).toBe(201);
    tenantAId = obA.json().tenant.id;
    tenantAMainBranchId = obA.json().branch.id;
    tenantAWhId = obA.json().warehouse.id;

    // Seed category & product for Tenant A while ACTIVE/TRIALING
    const catRes = await app.inject({
      method: 'POST',
      url: '/v1/categories',
      headers: {
        authorization: `Bearer ${ownerAToken}`,
        'x-tenant-id': tenantAId,
      },
      payload: { name: 'Electronics' },
    });
    expect(catRes.statusCode).toBe(201);
    tenantACatId = catRes.json().id;

    const prodRes = await app.inject({
      method: 'POST',
      url: '/v1/products',
      headers: {
        authorization: `Bearer ${ownerAToken}`,
        'x-tenant-id': tenantAId,
        'idempotency-key': generateUuidV7(),
      },
      payload: {
        categoryId: tenantACatId,
        sku: 'ELEC-001',
        name: 'LED Monitor 24',
        baseUom: 'PCS',
        purchaseCost: '25000.0000',
        sellingPrice: '34000.0000',
        trackInventory: true,
      },
    });
    expect(prodRes.statusCode).toBe(201);
    tenantAProdId = prodRes.json().id;

    // Onboard Tenant B
    const sB = await app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: {
        email: `owner_b_105_${generateUuidV7()}@example.com`,
        password: 'StrongPassword123!',
        fullName: 'Phase 10.5 Owner B',
      },
    });
    expect(sB.statusCode).toBe(201);
    ownerBToken = sB.json().token;

    const obB = await app.inject({
      method: 'POST',
      url: '/v1/org/onboard',
      headers: { authorization: `Bearer ${ownerBToken}` },
      payload: {
        businessName: 'Galle Hardware Ltd',
        businessType: 'RETAIL',
        currency: 'LKR',
        firstBranchName: 'Galle Main',
        firstBranchCode: 'GAL-01',
        countryCode: 'LK',
      },
    });
    expect(obB.statusCode).toBe(201);
    tenantBId = obB.json().tenant.id;

    // Seed Platform Super Admin: sadewbagya58@gmail.com
    const sAdmin = await app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: {
        email: 'sadewbagya58@gmail.com',
        password: 'SuperAdminPassword123!',
        fullName: 'Sadew Platform Owner',
      },
    });
    expect(sAdmin.statusCode).toBe(201);
    platformAdminToken = sAdmin.json().token;
    platformAdminId = sAdmin.json().userId;

    await harness.db
      .updateTable('users')
      .set({ is_platform_admin: true })
      .where('id', '=', platformAdminId)
      .execute();

    await harness.db
      .insertInto('platform_admin_accounts')
      .values({
        user_id: platformAdminId,
        email: 'sadewbagya58@gmail.com',
        platform_role: 'SUPER_ADMIN',
        status: 'ACTIVE',
        mfa_enforced: true,
        totp_enabled: false,
      })
      .onConflict((oc) => oc.column('user_id').doNothing())
      .execute();

    // Seed secondary user for Finance Reviewer provisioning tests
    financeAdminEmail = `finance_${generateUuidV7()}@nexstock.lk`;
    const sFin = await app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: {
        email: financeAdminEmail,
        password: 'FinancePassword123!',
        fullName: 'Finance Reviewer',
      },
    });
    expect(sFin.statusCode).toBe(201);
    financeAdminToken = sFin.json().token;
  });

  afterAll(async () => {
    await app.close();
    await harness.db.destroy();
  });

  it('10.6 & 10.9 Security Boundaries, MFA Step-Up Verification, Unauthorized Access Alerts & RBAC', async () => {
    // 1. /v1/auth/me reflects DB-backed Platform Admin metadata cleanly
    const adminMe = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { authorization: `Bearer ${platformAdminToken}` },
    });
    expect(adminMe.statusCode).toBe(200);
    expect(adminMe.json().user.isPlatformAdmin).toBe(true);
    expect(adminMe.json().user.platformRole).toBe('SUPER_ADMIN');

    // Business Owner has isPlatformAdmin = false and MUST NOT access any platform endpoint
    const ownerMe = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { authorization: `Bearer ${ownerAToken}` },
    });
    expect(ownerMe.json().user.isPlatformAdmin).toBe(false);

    const unauthOverview = await app.inject({
      method: 'GET',
      url: '/v1/platform/analytics/overview',
      headers: { authorization: `Bearer ${ownerAToken}` },
    });
    expect(unauthOverview.statusCode).toBe(403);
    expect(unauthOverview.json().errorCode).toBe('SUB_PLATFORM_ADMIN_REQUIRED');

    // 2. MFA step-up blocks sensitive mutations when mfa_enforced=true and unverified
    const blockedBeforeMfa = await app.inject({
      method: 'POST',
      url: `/v1/platform/businesses/${tenantBId}/suspend`,
      headers: { authorization: `Bearer ${platformAdminToken}` },
      payload: { reason: 'Attempt without MFA step-up' },
    });
    expect(blockedBeforeMfa.statusCode).toBe(403);
    expect(blockedBeforeMfa.json().errorCode).toBe('SUB_PLATFORM_MFA_REQUIRED');

    // 3. Setup & Verify real RFC 6238 TOTP authenticator flow
    const setupRes = await app.inject({
      method: 'POST',
      url: '/v1/platform/security/mfa/setup',
      headers: { authorization: `Bearer ${platformAdminToken}` },
      payload: {},
    });
    expect(setupRes.statusCode).toBe(200);
    const totpSecret = setupRes.json().secretBase32 as string;
    expect(totpSecret.length).toBeGreaterThanOrEqual(16);

    const invalidVerify = await app.inject({
      method: 'POST',
      url: '/v1/platform/security/mfa/verify',
      headers: { authorization: `Bearer ${platformAdminToken}` },
      payload: { code: '000000' },
    });
    // Unless astronomically unlucky 000000 collides, should reject with 401
    if (generateTotpCodeFromBase32(totpSecret) !== '000000') {
      expect(invalidVerify.statusCode).toBe(401);
    }

    const validCode = generateTotpCodeFromBase32(totpSecret);
    const verifyRes = await app.inject({
      method: 'POST',
      url: '/v1/platform/security/mfa/verify',
      headers: { authorization: `Bearer ${platformAdminToken}` },
      payload: { code: validCode },
    });
    expect(verifyRes.statusCode).toBe(200);
    expect(verifyRes.json().verified).toBe(true);

    // 4. Provision BILLING_ADMIN and verify role scoping (Billing cannot suspend business)
    const provisionFin = await app.inject({
      method: 'POST',
      url: '/v1/platform/security/admins',
      headers: { authorization: `Bearer ${platformAdminToken}` },
      payload: {
        email: financeAdminEmail,
        platformRole: 'BILLING_ADMIN',
        mfaEnforced: false,
      },
    });
    expect(provisionFin.statusCode).toBe(201);

    const finCanViewPayments = await app.inject({
      method: 'GET',
      url: '/v1/platform/subscriptions/payments',
      headers: { authorization: `Bearer ${financeAdminToken}` },
    });
    expect(finCanViewPayments.statusCode).toBe(200);

    const finCannotSuspendBiz = await app.inject({
      method: 'POST',
      url: `/v1/platform/businesses/${tenantBId}/suspend`,
      headers: { authorization: `Bearer ${financeAdminToken}` },
      payload: { reason: 'Finance should not suspend business' },
    });
    expect(finCannotSuspendBiz.statusCode).toBe(403);

    // 5. Verify system monitoring alert was recorded cleanly for the unauthorized admin attempt
    const alertsRes = await app.inject({
      method: 'GET',
      url: '/v1/platform/monitoring/alerts',
      headers: { authorization: `Bearer ${platformAdminToken}` },
    });
    expect(alertsRes.statusCode).toBe(200);
    const alertCategories = (
      alertsRes.json().items as Array<{ eventCategory: string }>
    ).map((a) => a.eventCategory);
    expect(alertCategories).toContain('UNAUTHORIZED_ACCESS');

    // 6. Verify PostgreSQL immutability trigger on platform_audit_logs
    await expect(
      sql`UPDATE platform_audit_logs SET action = 'TAMPERED'`.execute(harness.db),
    ).rejects.toThrow(/append-only|IMMUTABLE|cannot UPDATE/i);
  });

  it('10.5 Deterministic 7-Day Grace Period -> Read-Only Mode Enforcement, Portal Reads, Notifications & Renewal Restoration', async () => {
    // 1. Set Tenant A period end to 2 days ago (within 7-day grace period)
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    await harness.db
      .updateTable('tenant_subscriptions')
      .set({
        status: 'ACTIVE',
        current_period_start: new Date(Date.now() - 32 * 24 * 60 * 60 * 1000),
        current_period_end: twoDaysAgo,
        grace_period_ends_at: null,
        read_only_entered_at: null,
      })
      .where('tenant_id', '=', tenantAId)
      .execute();

    // Call evaluateSubscriptionLifecycle TWICE -> must anchor grace_period_ends_at deterministically
    const eval1 = await withTenantTransaction(
      harness.db,
      { tenantId: tenantAId, userId: ownerAId, traceId: 'test-eval-1' },
      (trx) => evaluateSubscriptionLifecycle(trx),
    );
    expect(eval1.status).toBe('GRACE_PERIOD');
    expect(eval1.gracePeriodEndsAt).toBeTruthy();

    const eval2 = await withTenantTransaction(
      harness.db,
      { tenantId: tenantAId, userId: ownerAId, traceId: 'test-eval-2' },
      (trx) => evaluateSubscriptionLifecycle(trx),
    );
    expect(eval2.status).toBe('GRACE_PERIOD');
    expect(eval2.gracePeriodEndsAt).toBe(eval1.gracePeriodEndsAt);

    // During GRACE_PERIOD, writes are still allowed
    const branchReadDuringGrace = await app.inject({
      method: 'GET',
      url: '/v1/org/branches',
      headers: { authorization: `Bearer ${ownerAToken}`, 'x-tenant-id': tenantAId },
    });
    expect(branchReadDuringGrace.statusCode).toBe(200);

    // 2. Fast-forward grace_period_ends_at into the past -> triggers deterministic READ_ONLY mode
    await harness.db
      .updateTable('tenant_subscriptions')
      .set({
        grace_period_ends_at: new Date(Date.now() - 60 * 1000),
      })
      .where('tenant_id', '=', tenantAId)
      .execute();

    const entReadOnly = await app.inject({
      method: 'GET',
      url: '/v1/subscriptions/entitlement',
      headers: { authorization: `Bearer ${ownerAToken}`, 'x-tenant-id': tenantAId },
    });
    expect(entReadOnly.statusCode).toBe(200);
    expect(entReadOnly.json().status).toBe('READ_ONLY');

    // Notifications center emits de-duplicated lifecycle notification
    const notifsRes = await app.inject({
      method: 'GET',
      url: '/v1/subscriptions/notifications',
      headers: { authorization: `Bearer ${ownerAToken}`, 'x-tenant-id': tenantAId },
    });
    expect(notifsRes.statusCode).toBe(200);
    const notifItems = notifsRes.json().items as Array<{
      id: string;
      eventType: string;
      isRead: boolean;
    }>;
    expect(notifItems.some((n) => n.eventType === 'READ_ONLY_ACTIVATED')).toBe(true);

    // Mark notification as read
    const targetNotifId = notifItems[0]!.id;
    const markRead = await app.inject({
      method: 'POST',
      url: `/v1/subscriptions/notifications/${targetNotifId}/read`,
      headers: { authorization: `Bearer ${ownerAToken}`, 'x-tenant-id': tenantAId },
      payload: {},
    });
    expect(markRead.statusCode).toBe(200);

    // 3. In READ_ONLY mode, ALL business mutations MUST be rejected 403 SUB_READ_ONLY_MODE
    const createProdBlocked = await app.inject({
      method: 'POST',
      url: '/v1/products',
      headers: {
        authorization: `Bearer ${ownerAToken}`,
        'x-tenant-id': tenantAId,
        'idempotency-key': generateUuidV7(),
      },
      payload: {
        categoryId: tenantACatId,
        sku: 'BLK-001',
        name: 'Blocked Product',
        baseUom: 'PCS',
        purchaseCost: '100.0000',
        sellingPrice: '150.0000',
        trackInventory: true,
      },
    });
    expect(createProdBlocked.statusCode).toBe(403);
    expect(createProdBlocked.json().errorCode).toBe('SUB_READ_ONLY_MODE');

    const createExpCatBlocked = await app.inject({
      method: 'POST',
      url: '/v1/expenses/categories',
      headers: { authorization: `Bearer ${ownerAToken}`, 'x-tenant-id': tenantAId },
      payload: { code: 'RENT_RO', name: 'Rent Blocked' },
    });
    expect(createExpCatBlocked.statusCode).toBe(403);
    expect(createExpCatBlocked.json().errorCode).toBe('SUB_READ_ONLY_MODE');

    const createCustBlocked = await app.inject({
      method: 'POST',
      url: '/v1/customers',
      headers: {
        authorization: `Bearer ${ownerAToken}`,
        'x-tenant-id': tenantAId,
        'idempotency-key': generateUuidV7(),
      },
      payload: { name: 'Blocked Customer' },
    });
    expect(createCustBlocked.statusCode).toBe(403);
    expect(createCustBlocked.json().errorCode).toBe('SUB_READ_ONLY_MODE');

    const updateTenantBlocked = await app.inject({
      method: 'PATCH',
      url: '/v1/org/branding',
      headers: { authorization: `Bearer ${ownerAToken}`, 'x-tenant-id': tenantAId },
      payload: { shopDisplayName: 'Should Block' },
    });
    expect(updateTenantBlocked.statusCode).toBe(403);
    expect(updateTenantBlocked.json().errorCode).toBe('SUB_READ_ONLY_MODE');

    // Offline Sync push in READ_ONLY quarantines blocked sales without deleting local transactions;
    // sync pull delivers authoritative READ_ONLY subscriptionState to Desktop/Mobile!
    const deviceReg = await app.inject({
      method: 'POST',
      url: '/v1/sync/devices/register',
      headers: { authorization: `Bearer ${ownerAToken}`, 'x-tenant-id': tenantAId },
      payload: {
        clientPlatform: 'TAURI_DESKTOP',
        deviceName: 'Till-01',
        branchId: tenantAMainBranchId,
        warehouseId: tenantAWhId,
      },
    });
    // Device registration on READ_ONLY or STARTER: pull still works on registered device OR let's register via DB if needed:
    let devId = '';
    if (deviceReg.statusCode === 200 || deviceReg.statusCode === 201) {
      devId = deviceReg.json().deviceId;
    } else {
      devId = generateUuidV7();
      await harness.db
        .insertInto('offline_devices')
        .values({
          id: devId,
          tenant_id: tenantAId,
          branch_id: tenantAMainBranchId,
          user_id: ownerAId,
          client_platform: 'TAURI_DESKTOP',
          device_name: 'Till-01',
          status: 'ACTIVE',
          app_version: '1.0.0',
        })
        .execute();
    }

    const pullRes = await app.inject({
      method: 'GET',
      url: `/v1/sync/pull?deviceId=${devId}`,
      headers: { authorization: `Bearer ${ownerAToken}`, 'x-tenant-id': tenantAId },
    });
    expect(pullRes.statusCode).toBe(200);
    expect(pullRes.json().subscriptionState.status).toBe('READ_ONLY');
    expect(pullRes.json().subscriptionState.isReadOnly).toBe(true);

    const blockedOfflineSaleCmdId = generateUuidV7();
    const pushRes = await app.inject({
      method: 'POST',
      url: '/v1/sync/push',
      headers: { authorization: `Bearer ${ownerAToken}`, 'x-tenant-id': tenantAId },
      payload: {
        deviceId: devId,
        branchId: tenantAMainBranchId,
        commands: [
          {
            localSeq: 1,
            commandId: blockedOfflineSaleCmdId,
            tenantId: tenantAId,
            branchId: tenantAMainBranchId,
            deviceId: devId,
            actorUserId: ownerAId,
            commandType: 'POS_RECORD_SALE',
            schemaVersion: 1,
            occurredAt: new Date().toISOString(),
            payload: {
              items: [{ productId: tenantAProdId, quantity: '1' }],
              payments: [{ paymentMethod: 'CASH', amount: '34000.0000' }],
            },
          },
        ],
      },
    });
    expect(pushRes.statusCode).toBe(200);
    expect(pushRes.json().receipts[0].status).toBe('QUARANTINED');
    expect(pushRes.json().receipts[0].conflictId).toBeTruthy();
    // Unsynced sale is preserved safely in sync_conflicts (never silently deleted)
    const conflictsRes = await app.inject({
      method: 'GET',
      url: '/v1/sync/conflicts',
      headers: { authorization: `Bearer ${ownerAToken}`, 'x-tenant-id': tenantAId },
    });
    expect(conflictsRes.statusCode).toBe(200);
    const conflictRows = Array.isArray(conflictsRes.json())
      ? (conflictsRes.json() as Array<{ id: string }>)
      : ((conflictsRes.json().items ?? []) as Array<{ id: string }>);
    expect(
      conflictRows.some((c) => c.id === pushRes.json().receipts[0].conflictId),
    ).toBe(true);

    // 4. READS, Reports, CSV Export, Support & Renewal billing MUST remain allowed in READ_ONLY mode
    const readProds = await app.inject({
      method: 'GET',
      url: '/v1/products',
      headers: { authorization: `Bearer ${ownerAToken}`, 'x-tenant-id': tenantAId },
    });
    expect(readProds.statusCode).toBe(200);

    const exportCsv = await app.inject({
      method: 'GET',
      url: '/v1/reports/business/export',
      headers: { authorization: `Bearer ${ownerAToken}`, 'x-tenant-id': tenantAId },
    });
    expect(exportCsv.statusCode).toBe(200);
    expect(exportCsv.headers['content-type']).toContain('text/csv');

    const supportRes = await app.inject({
      method: 'GET',
      url: '/v1/subscriptions/support',
      headers: { authorization: `Bearer ${ownerAToken}`, 'x-tenant-id': tenantAId },
    });
    expect(supportRes.statusCode).toBe(200);
    expect(supportRes.json().planCode).toBe('STARTER');

    // 5. Business generates Renewal Invoice -> Submits Bank Transfer Proof (MUST still stay READ_ONLY until verified!)
    const renInvRes = await app.inject({
      method: 'POST',
      url: '/v1/subscriptions/renewals/invoice',
      headers: { authorization: `Bearer ${ownerAToken}`, 'x-tenant-id': tenantAId },
      payload: {},
    });
    expect([200, 201]).toContain(renInvRes.statusCode);
    const renInvoiceId = (renInvRes.json().invoiceId ?? renInvRes.json().invoice?.id ?? renInvRes.json().id) as string;

    const slipSubRes = await app.inject({
      method: 'POST',
      url: '/v1/subscriptions/payments/bank-transfer',
      headers: {
        authorization: `Bearer ${ownerAToken}`,
        'x-tenant-id': tenantAId,
        'idempotency-key': generateUuidV7(),
      },
      payload: {
        invoiceId: renInvoiceId,
        paymentReference: 'PB-RENEWAL-001',
        proofFileName: 'renewal-slip.png',
        proofMimeType: 'image/png',
        proofDataBase64: TINY_PNG_BYTES.toString('base64'),
      },
    });
    expect(slipSubRes.statusCode).toBe(201);
    const renSubmissionId = slipSubRes.json().id as string;

    // Crucial Security Check: submitting unverified manual slip MUST NOT unlock write operations in READ_ONLY!
    const stillBlockedAfterSlipUpload = await app.inject({
      method: 'POST',
      url: '/v1/expenses/categories',
      headers: { authorization: `Bearer ${ownerAToken}`, 'x-tenant-id': tenantAId },
      payload: { code: 'RENT_STILL_BLOCKED', name: 'Blocked Until Verified' },
    });
    expect(stillBlockedAfterSlipUpload.statusCode).toBe(403);
    expect(stillBlockedAfterSlipUpload.json().errorCode).toBe('SUB_READ_ONLY_MODE');

    // 6. Platform Admin verifies payment -> RESTORES full write access immediately!
    const verifyPay = await app.inject({
      method: 'POST',
      url: `/v1/platform/subscriptions/payments/${renSubmissionId}/verify`,
      headers: { authorization: `Bearer ${platformAdminToken}` },
      payload: { decision: 'APPROVE' },
    });
    expect(verifyPay.statusCode).toBe(200);

    // Double-approval check MUST be rejected
    const doubleApprove = await app.inject({
      method: 'POST',
      url: `/v1/platform/subscriptions/payments/${renSubmissionId}/verify`,
      headers: { authorization: `Bearer ${platformAdminToken}` },
      payload: { decision: 'APPROVE' },
    });
    expect(doubleApprove.statusCode).toBe(409);

    const restoredEnt = await app.inject({
      method: 'GET',
      url: '/v1/subscriptions/entitlement',
      headers: { authorization: `Bearer ${ownerAToken}`, 'x-tenant-id': tenantAId },
    });
    expect(restoredEnt.statusCode).toBe(200);
    expect(restoredEnt.json().status).toBe('ACTIVE');

    const writeWorksAfterRenewal = await app.inject({
      method: 'POST',
      url: '/v1/expenses/categories',
      headers: { authorization: `Bearer ${ownerAToken}`, 'x-tenant-id': tenantAId },
      payload: { code: 'UTILITIES_OK', name: 'Utilities Restored' },
    });
    expect(writeWorksAfterRenewal.statusCode).toBe(201);
  });

  it('10.6, 10.7, 10.8 & 10.9 Business Suspend/Restore, Custom Enterprise Override, Plan Versioning, Accurate MRR/Revenue Analytics & Backup Verification', async () => {
    // 1. Admin creates a second pending bank transfer submission for Tenant B (unverified — MUST NOT count toward collected revenue!)
    const upBRes = await app.inject({
      method: 'POST',
      url: '/v1/subscriptions/checkout/upgrade',
      headers: { authorization: `Bearer ${ownerBToken}`, 'x-tenant-id': tenantBId },
      payload: { targetPlanCode: 'PROFESSIONAL', billingCycle: 'MONTHLY' },
    });
    expect([200, 201]).toContain(upBRes.statusCode);
    const invBId = upBRes.json().invoice.id as string;

    const slipB = await app.inject({
      method: 'POST',
      url: '/v1/subscriptions/payments/bank-transfer',
      headers: {
        authorization: `Bearer ${ownerBToken}`,
        'x-tenant-id': tenantBId,
        'idempotency-key': generateUuidV7(),
      },
      payload: {
        invoiceId: invBId,
        paymentReference: 'PB-PENDING-B-999',
        proofFileName: 'pending.png',
        proofMimeType: 'image/png',
        proofDataBase64: TINY_PNG_BYTES.toString('base64'),
      },
    });
    expect(slipB.statusCode).toBe(201);

    // 2. Plan Versioning update (starter price increase for new customers MUST NOT alter already-paid Tenant A invoice!)
    const patchPlan = await app.inject({
      method: 'PATCH',
      url: '/v1/platform/subscriptions/plans/STARTER',
      headers: { authorization: `Bearer ${platformAdminToken}` },
      payload: {
        monthlyPriceAmount: '3490.0000',
        changeReason: 'Annual inflation adjustment test',
      },
    });
    expect(patchPlan.statusCode).toBe(200);

    const planHist = await app.inject({
      method: 'GET',
      url: '/v1/platform/subscriptions/plans/history',
      headers: { authorization: `Bearer ${platformAdminToken}` },
    });
    expect(planHist.statusCode).toBe(200);
    expect(planHist.json().items.length).toBeGreaterThanOrEqual(1);

    // 3. Business directory, inspection, Suspend & Restore + Custom Enterprise Override
    const listBiz = await app.inject({
      method: 'GET',
      url: '/v1/platform/businesses?search=Colombo',
      headers: { authorization: `Bearer ${platformAdminToken}` },
    });
    expect(listBiz.statusCode).toBe(200);
    expect(
      (listBiz.json().items as Array<{ tenantId: string }>).some(
        (b) => b.tenantId === tenantAId,
      ),
    ).toBe(true);

    const bizDetail = await app.inject({
      method: 'GET',
      url: `/v1/platform/businesses/${tenantAId}`,
      headers: { authorization: `Bearer ${platformAdminToken}` },
    });
    expect(bizDetail.statusCode).toBe(200);
    expect(bizDetail.json().branches.length).toBeGreaterThanOrEqual(1);

    const suspRes = await app.inject({
      method: 'POST',
      url: `/v1/platform/businesses/${tenantBId}/suspend`,
      headers: { authorization: `Bearer ${platformAdminToken}` },
      payload: { reason: 'Compliance verification hold' },
    });
    expect(suspRes.statusCode).toBe(200);

    const restRes = await app.inject({
      method: 'POST',
      url: `/v1/platform/businesses/${tenantBId}/restore`,
      headers: { authorization: `Bearer ${platformAdminToken}` },
      payload: {
        targetStatus: 'ACTIVE',
        reason: 'Compliance verified & cleared',
      },
    });
    expect(restRes.statusCode).toBe(200);

    const ovRes = await app.inject({
      method: 'POST',
      url: `/v1/platform/businesses/${tenantBId}/subscription/override`,
      headers: { authorization: `Bearer ${platformAdminToken}` },
      payload: {
        planCode: 'ENTERPRISE',
        status: 'ACTIVE',
        billingCycle: 'ANNUAL',
        extendDays: 365,
        customMonthlyPrice: '25000.0000',
        customMaxBranches: 40,
        customMaxUsers: 200,
        reason: 'Enterprise SLA commercial agreement',
      },
    });
    expect(ovRes.statusCode).toBe(200);

    // Tenant B support tier reflects ENTERPRISE dedicated support!
    const supB = await app.inject({
      method: 'GET',
      url: '/v1/subscriptions/support',
      headers: { authorization: `Bearer ${ownerBToken}`, 'x-tenant-id': tenantBId },
    });
    expect(supB.statusCode).toBe(200);
    expect(supB.json().planCode).toBe('ENTERPRISE');

    // 4. SaaS Analytics Overview (verifies collected revenue EXCLUDES Tenant B's unverified pending LKR 5990 slip!)
    const analyticsRes = await app.inject({
      method: 'GET',
      url: '/v1/platform/analytics/overview',
      headers: { authorization: `Bearer ${platformAdminToken}` },
    });
    expect(analyticsRes.statusCode).toBe(200);
    const analytics = analyticsRes.json();
    expect(analytics.businessKpis.totalBusinesses).toBeGreaterThanOrEqual(2);
    // Only Tenant A's verified payment (2990.0000) was settled before price bump!
    expect(Number(analytics.revenueKpis.totalVerifiedRevenueAmount)).toBeCloseTo(2990, 2);
    expect(Number(analytics.revenueKpis.pendingVerificationAmount)).toBeCloseTo(5990, 2);
    expect(Number(analytics.revenueKpis.mrrAmount)).toBeGreaterThan(2990);

    // Analytics CSV Export
    const csvAnalytics = await app.inject({
      method: 'GET',
      url: '/v1/platform/analytics/export',
      headers: { authorization: `Bearer ${platformAdminToken}` },
    });
    expect(csvAnalytics.statusCode).toBe(200);
    expect(csvAnalytics.body).toContain('"Metric Category","Metric Name","Value"');
    expect(csvAnalytics.body).toContain('"Total Verified Revenue (All Time)","2990.0000"');
    expect(csvAnalytics.body).toContain('"Pending Verification Amount","5990.0000"');
    expect(csvAnalytics.body).toContain('"MRR","28490.0000"');

    // 5. Platform Audit Logs & Real Database/RLS/Ledger Backup Verification
    const auditLogsRes = await app.inject({
      method: 'GET',
      url: '/v1/platform/audit-logs?limit=50',
      headers: { authorization: `Bearer ${platformAdminToken}` },
    });
    expect(auditLogsRes.statusCode).toBe(200);
    const actions = (auditLogsRes.json().items as Array<{ action: string }>).map(
      (a) => a.action,
    );
    expect(actions).toContain('PLATFORM_BUSINESS_SUSPENDED');
    expect(actions).toContain('PLATFORM_BUSINESS_RESTORED');
    expect(actions).toContain('PLATFORM_SUBSCRIPTION_OVERRIDE');
    expect(actions).toContain('PLATFORM_PLAN_CONFIG_UPDATED');
    expect(actions).toContain('PLATFORM_PAYMENT_APPROVED');

    const backupRun = await app.inject({
      method: 'POST',
      url: '/v1/platform/backups/verify',
      headers: { authorization: `Bearer ${platformAdminToken}` },
      payload: { triggerType: 'MANUAL_CHECK' },
    });
    expect(backupRun.statusCode).toBe(201);
    const runData = backupRun.json().run ?? backupRun.json();
    expect(runData.tablesVerified).toBeGreaterThan(10);
    expect(runData.rlsPoliciesVerified).toBeGreaterThan(10);
    expect(runData.ledgerChecksPassed).toBe(true);
    expect(runData.status).toBe('VERIFIED');
  });
});

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type {
  PlatformAnalyticsQuery,
  PlatformProvisionAdminRequest,
  PlatformRestoreBusinessRequest,
  PlatformSubscriptionOverrideRequest,
  PlatformUpdateAdminRequest,
} from '@nexstock/contracts';
import { type Kysely, sql } from 'kysely';
import { Money } from '@nexstock/domain-core';
import {
  AppError,
  type NexStockDatabase,
  type TenantTransactionContext,
  generateUuidV7,
  withAppUserTransaction,
} from '../../shared/index.js';
import { getTenantSubscriptionEntitlement } from './sub.service.js';
import {
  calculateTenantStorageUsageBytes,
  getTenantSubscriptionUsage,
} from './billing.service.js';

// ============================================================================
// RFC 6238 TOTP & Base32 Helpers (MFA for Platform Super Admin)
// ============================================================================

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function encodeBase32(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

function decodeBase32(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function generateTotpCodeForStep(secretBase32: string, stepCounter: number): string {
  const key = decodeBase32(secretBase32);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(stepCounter), 0);
  const hmac = createHmac('sha1', key).update(msg).digest();
  const offset = (hmac[hmac.length - 1] ?? 0) & 0x0f;
  const codeInt =
    (((hmac[offset] ?? 0) & 0x7f) << 24) |
    (((hmac[offset + 1] ?? 0) & 0xff) << 16) |
    (((hmac[offset + 2] ?? 0) & 0xff) << 8) |
    ((hmac[offset + 3] ?? 0) & 0xff);
  return String(codeInt % 1_000_000).padStart(6, '0');
}

export function verifyTotpCode(
  secretBase32: string,
  submittedCode: string,
  nowMs = Date.now(),
): boolean {
  const currentStep = Math.floor(nowMs / 30_000);
  const submittedBuf = Buffer.from(submittedCode.trim(), 'utf-8');
  for (const delta of [-1, 0, 1]) {
    const expected = generateTotpCodeForStep(secretBase32, currentStep + delta);
    const expectedBuf = Buffer.from(expected, 'utf-8');
    if (
      submittedBuf.length === expectedBuf.length &&
      timingSafeEqual(submittedBuf, expectedBuf)
    ) {
      return true;
    }
  }
  return false;
}

// ============================================================================
// Immutable Platform Audit Logger & Safe System Monitoring Alert Hook
// ============================================================================

export async function recordPlatformAudit(
  trx: TenantTransactionContext,
  params: {
    readonly targetTenantId?: string | null | undefined;
    readonly action: string;
    readonly resourceType: string;
    readonly resourceId: string;
    readonly previousState?: Record<string, unknown> | null | undefined;
    readonly newState?: Record<string, unknown> | null | undefined;
    readonly metadata?: Record<string, unknown> | undefined;
    readonly ipAddress?: string | null | undefined;
  },
): Promise<string> {
  const id = generateUuidV7();
  await trx.db
    .insertInto('platform_audit_logs')
    .values({
      id,
      actor_user_id: trx.userId,
      actor_role: trx.platformRole ?? 'SUPER_ADMIN',
      target_tenant_id: params.targetTenantId ?? null,
      action: params.action,
      resource_type: params.resourceType,
      resource_id: params.resourceId,
      previous_state_json: params.previousState
        ? JSON.stringify(params.previousState)
        : null,
      new_state_json: params.newState ? JSON.stringify(params.newState) : null,
      correlation_id: trx.tenantContext.traceId,
      ip_address: params.ipAddress ?? null,
      metadata_json: JSON.stringify(params.metadata ?? {}),
    })
    .execute();
  return id;
}

export async function recordSystemAlertSafe(
  db: Kysely<NexStockDatabase>,
  params: {
    readonly eventCategory:
      | 'LIFECYCLE_FAILURE'
      | 'PAYMENT_VERIFICATION_FAILURE'
      | 'WEBHOOK_FAILURE'
      | 'RENEWAL_FAILURE'
      | 'UNAUTHORIZED_ACCESS'
      | 'AUDIT_FAILURE'
      | 'BACKUP_FAILURE'
      | 'SYNC_ERROR'
      | 'DB_ERROR';
    readonly severity: 'INFO' | 'WARNING' | 'CRITICAL';
    readonly tenantId?: string | null | undefined;
    readonly summary: string;
    readonly details?: Record<string, unknown> | undefined;
    readonly traceId?: string | undefined;
  },
): Promise<void> {
  try {
    await withAppUserTransaction(
      db,
      { traceId: params.traceId },
      async (trx) => {
        await trx
          .insertInto('platform_system_alerts')
          .values({
            id: generateUuidV7(),
            event_category: params.eventCategory,
            severity: params.severity,
            status: 'OPEN',
            tenant_id: params.tenantId ?? null,
            summary: params.summary.slice(0, 400),
            details_json: JSON.stringify(params.details ?? {}),
            trace_id: params.traceId ?? null,
          })
          .execute();
      },
    );
  } catch {
    // Non-blocking safeguard: alert persistence must never mask primary domain errors
  }
}

// ============================================================================
// Platform Super Admin Security, Roles & TOTP MFA Management
// ============================================================================

export async function getPlatformAdminSecurityProfile(
  trx: TenantTransactionContext,
) {
  const userRow = await trx.db
    .selectFrom('users')
    .select(['id', 'email', 'full_name', 'is_platform_admin'])
    .where('id', '=', trx.userId)
    .executeTakeFirstOrThrow();

  let acct = await trx.db
    .selectFrom('platform_admin_accounts')
    .select([
      'user_id',
      'platform_role',
      'status',
      'mfa_enforced',
      'totp_enabled',
      'mfa_verified_until',
      'last_login_at',
      'created_at',
    ])
    .where('user_id', '=', trx.userId)
    .executeTakeFirst();

  if (!acct && userRow.is_platform_admin) {
    acct = await trx.db
      .insertInto('platform_admin_accounts')
      .values({
        user_id: userRow.id,
        email: userRow.email,
        platform_role: 'SUPER_ADMIN',
        status: 'ACTIVE',
        mfa_enforced: false,
        totp_enabled: false,
      })
      .onConflict((oc) => oc.column('user_id').doNothing())
      .returning([
        'user_id',
        'platform_role',
        'status',
        'mfa_enforced',
        'totp_enabled',
        'mfa_verified_until',
        'last_login_at',
        'created_at',
      ])
      .executeTakeFirst();
  }

  const mfaStepUpActive = Boolean(
    acct?.mfa_verified_until &&
      new Date(acct.mfa_verified_until).getTime() > Date.now(),
  );

  return {
    userId: userRow.id,
    email: userRow.email,
    fullName: userRow.full_name,
    platformRole: acct?.platform_role ?? 'SUPER_ADMIN',
    status: acct?.status ?? 'ACTIVE',
    mfaEnforced: Boolean(acct?.mfa_enforced),
    totpEnabled: Boolean(acct?.totp_enabled),
    mfaStepUpActive,
    mfaVerifiedUntil: acct?.mfa_verified_until
      ? new Date(acct.mfa_verified_until).toISOString()
      : null,
  };
}

export async function setupPlatformAdminTotp(trx: TenantTransactionContext) {
  const userRow = await trx.db
    .selectFrom('users')
    .select(['id', 'email'])
    .where('id', '=', trx.userId)
    .executeTakeFirstOrThrow();

  const secretBase32 = encodeBase32(randomBytes(20));
  const now = new Date();

  const existing = await trx.db
    .selectFrom('platform_admin_accounts')
    .select(['user_id'])
    .where('user_id', '=', trx.userId)
    .executeTakeFirst();

  if (existing) {
    await trx.db
      .updateTable('platform_admin_accounts')
      .set({
        totp_secret_base32: secretBase32,
        totp_enabled: false,
        updated_at: now,
      })
      .where('user_id', '=', trx.userId)
      .execute();
  } else {
    await trx.db
      .insertInto('platform_admin_accounts')
      .values({
        user_id: trx.userId,
        email: userRow.email,
        platform_role: trx.platformRole ?? 'SUPER_ADMIN',
        status: 'ACTIVE',
        totp_secret_base32: secretBase32,
        totp_enabled: false,
        mfa_enforced: false,
      })
      .execute();
  }

  await recordPlatformAudit(trx, {
    action: 'PLATFORM_MFA_TOTP_INITIATED',
    resourceType: 'PLATFORM_ADMIN_ACCOUNT',
    resourceId: trx.userId,
    metadata: { email: userRow.email },
  });

  const otpauthUri = `otpauth://totp/NexStock%20Platform:${encodeURIComponent(userRow.email)}?secret=${secretBase32}&issuer=NexStock%20Platform&algorithm=SHA1&digits=6&period=30`;

  return {
    secretBase32,
    otpauthUri,
    totpEnabled: false,
  };
}

export async function verifyPlatformAdminTotp(
  trx: TenantTransactionContext,
  code: string,
) {
  const acct = await trx.db
    .selectFrom('platform_admin_accounts')
    .select(['user_id', 'totp_secret_base32', 'totp_enabled', 'mfa_enforced'])
    .where('user_id', '=', trx.userId)
    .executeTakeFirst();

  if (!acct || !acct.totp_secret_base32) {
    throw new AppError({
      statusCode: 400,
      errorCode: 'ERR_VALIDATION_FAILED',
      title: 'TOTP Not Enrolled',
      detail: 'Enroll a TOTP secret first using MFA setup.',
    });
  }

  if (!verifyTotpCode(acct.totp_secret_base32, code)) {
    throw new AppError({
      statusCode: 401,
      errorCode: 'SUB_PLATFORM_MFA_REQUIRED',
      title: 'Invalid MFA Verification Code',
      detail: 'The 6-digit authenticator verification code is invalid or expired.',
    });
  }

  const now = new Date();
  const verifiedUntil = new Date(now.getTime() + 30 * 60_000);

  await trx.db
    .updateTable('platform_admin_accounts')
    .set({
      totp_enabled: true,
      mfa_enforced: true,
      mfa_verified_until: verifiedUntil,
      last_login_at: now,
      updated_at: now,
    })
    .where('user_id', '=', trx.userId)
    .execute();

  await recordPlatformAudit(trx, {
    action: 'PLATFORM_MFA_STEP_UP_VERIFIED',
    resourceType: 'PLATFORM_ADMIN_ACCOUNT',
    resourceId: trx.userId,
    newState: {
      totpEnabled: true,
      mfaEnforced: true,
      mfaVerifiedUntil: verifiedUntil.toISOString(),
    },
  });

  return {
    verified: true,
    totpEnabled: true,
    mfaEnforced: true,
    mfaVerifiedUntil: verifiedUntil.toISOString(),
  };
}

export async function listPlatformAdminAccounts(trx: TenantTransactionContext) {
  const rows = await trx.db
    .selectFrom('platform_admin_accounts')
    .innerJoin('users', 'users.id', 'platform_admin_accounts.user_id')
    .select([
      'platform_admin_accounts.user_id',
      'users.email',
      'users.full_name',
      'platform_admin_accounts.platform_role',
      'platform_admin_accounts.status',
      'platform_admin_accounts.mfa_enforced',
      'platform_admin_accounts.totp_enabled',
      'platform_admin_accounts.created_at',
      'platform_admin_accounts.updated_at',
    ])
    .orderBy('platform_admin_accounts.created_at', 'asc')
    .execute();

  return rows.map((r) => ({
    userId: r.user_id,
    email: r.email,
    fullName: r.full_name,
    platformRole: r.platform_role,
    status: r.status,
    mfaEnforced: r.mfa_enforced,
    totpEnabled: r.totp_enabled,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  }));
}

export async function provisionPlatformAdminAccount(
  trx: TenantTransactionContext,
  input: PlatformProvisionAdminRequest,
) {
  const normalizedEmail = input.email.trim().toLowerCase();
  const targetUser = await trx.db
    .selectFrom('users')
    .select(['id', 'email', 'full_name', 'is_platform_admin'])
    .where('email', '=', normalizedEmail)
    .executeTakeFirst();

  if (!targetUser) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'ERR_NOT_FOUND',
      title: 'Registered User Not Found',
      detail: `No registered NexStock user account exists for "${normalizedEmail}". The user must sign up first.`,
    });
  }

  const now = new Date();
  await trx.db
    .updateTable('users')
    .set({ is_platform_admin: true, updated_at: now })
    .where('id', '=', targetUser.id)
    .execute();

  const existing = await trx.db
    .selectFrom('platform_admin_accounts')
    .select(['user_id', 'platform_role', 'status'])
    .where('user_id', '=', targetUser.id)
    .executeTakeFirst();

  if (existing) {
    await trx.db
      .updateTable('platform_admin_accounts')
      .set({
        platform_role: input.platformRole,
        status: 'ACTIVE',
        ...(input.mfaEnforced !== undefined
          ? { mfa_enforced: input.mfaEnforced }
          : {}),
        updated_at: now,
      })
      .where('user_id', '=', targetUser.id)
      .execute();
  } else {
    await trx.db
      .insertInto('platform_admin_accounts')
      .values({
        user_id: targetUser.id,
        email: targetUser.email,
        platform_role: input.platformRole,
        status: 'ACTIVE',
        mfa_enforced: input.mfaEnforced ?? false,
        totp_enabled: false,
        created_by_user_id: trx.userId,
      })
      .execute();
  }

  await recordPlatformAudit(trx, {
    action: 'PLATFORM_ADMIN_PROVISIONED',
    resourceType: 'PLATFORM_ADMIN_ACCOUNT',
    resourceId: targetUser.id,
    previousState: existing ?? null,
    newState: {
      email: targetUser.email,
      platformRole: input.platformRole,
      status: 'ACTIVE',
      mfaEnforced: input.mfaEnforced ?? false,
    },
  });

  return listPlatformAdminAccounts(trx);
}

export async function updatePlatformAdminAccount(
  trx: TenantTransactionContext,
  targetUserId: string,
  input: PlatformUpdateAdminRequest,
) {
  const existing = await trx.db
    .selectFrom('platform_admin_accounts')
    .selectAll()
    .where('user_id', '=', targetUserId)
    .executeTakeFirst();

  if (!existing) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'ERR_NOT_FOUND',
      title: 'Platform Admin Account Not Found',
      detail: `Platform Admin "${targetUserId}" not found.`,
    });
  }

  if (targetUserId === trx.userId && input.status === 'SUSPENDED') {
    throw new AppError({
      statusCode: 409,
      errorCode: 'ERR_CONFLICT',
      title: 'Cannot Suspend Own Admin Session',
      detail: 'You cannot suspend your own currently active Super Admin account.',
    });
  }

  const now = new Date();
  await trx.db
    .updateTable('platform_admin_accounts')
    .set({
      ...(input.platformRole ? { platform_role: input.platformRole } : {}),
      ...(input.status ? { status: input.status } : {}),
      ...(input.mfaEnforced !== undefined ? { mfa_enforced: input.mfaEnforced } : {}),
      updated_at: now,
    })
    .where('user_id', '=', targetUserId)
    .execute();

  if (input.status) {
    await trx.db
      .updateTable('users')
      .set({ is_platform_admin: input.status === 'ACTIVE', updated_at: now })
      .where('id', '=', targetUserId)
      .execute();
  }

  await recordPlatformAudit(trx, {
    action: 'PLATFORM_ADMIN_UPDATED',
    resourceType: 'PLATFORM_ADMIN_ACCOUNT',
    resourceId: targetUserId,
    previousState: {
      platformRole: existing.platform_role,
      status: existing.status,
      mfaEnforced: existing.mfa_enforced,
    },
    newState: {
      platformRole: input.platformRole ?? existing.platform_role,
      status: input.status ?? existing.status,
      mfaEnforced: input.mfaEnforced ?? existing.mfa_enforced,
    },
  });

  return listPlatformAdminAccounts(trx);
}

// ============================================================================
// Platform Super Admin Business Management & Subscription Override (10.6.3/4)
// ============================================================================

export async function listPlatformBusinesses(
  trx: TenantTransactionContext,
  query: {
    readonly search?: string | undefined;
    readonly status?: string | undefined;
    readonly planCode?: string | undefined;
    readonly limit?: number | undefined;
    readonly offset?: number | undefined;
  } = {},
) {
  const limit = Math.min(100, Math.max(1, query.limit ?? 25));
  const offset = Math.max(0, query.offset ?? 0);

  let q = trx.db
    .selectFrom('tenants')
    .innerJoin(
      'tenant_subscriptions',
      'tenant_subscriptions.tenant_id',
      'tenants.id',
    )
    .innerJoin(
      'subscription_plans',
      'subscription_plans.id',
      'tenant_subscriptions.plan_id',
    )
    .select([
      'tenants.id as tenant_id',
      'tenants.slug',
      'tenants.legal_name',
      'tenants.base_currency',
      'tenants.country_code',
      'tenants.status as tenant_status',
      'tenants.created_at as tenant_created_at',
      'tenant_subscriptions.id as subscription_id',
      'tenant_subscriptions.status as subscription_status',
      'tenant_subscriptions.billing_cycle',
      'tenant_subscriptions.trial_started_at',
      'tenant_subscriptions.trial_ends_at',
      'tenant_subscriptions.current_period_start',
      'tenant_subscriptions.current_period_end',
      'tenant_subscriptions.grace_period_ends_at',
      'tenant_subscriptions.additional_branch_slots',
      'tenant_subscriptions.custom_monthly_price',
      'tenant_subscriptions.allow_admin_override',
      'subscription_plans.code as plan_code',
      'subscription_plans.name as plan_name',
      'subscription_plans.monthly_price_amount',
      'subscription_plans.annual_discount_pct',
      'subscription_plans.additional_branch_monthly_fee',
    ]);

  if (query.status) {
    q = q.where('tenant_subscriptions.status', '=', query.status as never);
  }
  if (query.planCode) {
    q = q.where('subscription_plans.code', '=', query.planCode.toUpperCase());
  }
  if (query.search && query.search.trim().length > 0) {
    const pattern = `%${query.search.trim().toLowerCase()}%`;
    q = q.where((eb) =>
      eb.or([
        eb(sql`LOWER(tenants.legal_name)`, 'like', pattern),
        eb(sql`LOWER(tenants.slug)`, 'like', pattern),
      ]),
    );
  }

  const allMatching = await q
    .orderBy('tenants.created_at', 'desc')
    .limit(limit)
    .offset(offset)
    .execute();

  const tenantIds = allMatching.map((r) => r.tenant_id);
  const [branchCounts, userCounts] =
    tenantIds.length > 0
      ? await Promise.all([
          trx.db
            .selectFrom('branches')
            .select(['tenant_id', sql<string>`COUNT(*)`.as('cnt')])
            .where('tenant_id', 'in', tenantIds)
            .where('is_active', '=', true)
            .groupBy('tenant_id')
            .execute(),
          trx.db
            .selectFrom('tenant_memberships')
            .select(['tenant_id', sql<string>`COUNT(DISTINCT user_id)`.as('cnt')])
            .where('tenant_id', 'in', tenantIds)
            .where('status', '=', 'ACTIVE')
            .groupBy('tenant_id')
            .execute(),
        ])
      : [[], []];

  const branchMap = new Map(
    branchCounts.map((b) => [b.tenant_id, Number(b.cnt) || 0]),
  );
  const userMap = new Map(
    userCounts.map((u) => [u.tenant_id, Number(u.cnt) || 0]),
  );

  return {
    limit,
    offset,
    items: allMatching.map((r) => ({
      tenantId: r.tenant_id,
      slug: r.slug,
      legalName: r.legal_name,
      tenantStatus: r.tenant_status,
      baseCurrency: r.base_currency,
      countryCode: r.country_code,
      subscriptionId: r.subscription_id,
      planCode: r.plan_code,
      planName: r.plan_name,
      status: r.subscription_status,
      subscriptionStatus: r.subscription_status,
      billingCycle: r.billing_cycle,
      activeBranchesCount: branchMap.get(r.tenant_id) ?? 0,
      distinctUsersCount: userMap.get(r.tenant_id) ?? 0,
      additionalBranchSlots: r.additional_branch_slots ?? 0,
      customMonthlyPrice: r.custom_monthly_price,
      allowAdminOverride: r.allow_admin_override,
      trialEndsAt: r.trial_ends_at
        ? new Date(r.trial_ends_at).toISOString()
        : null,
      currentPeriodEnd: new Date(r.current_period_end).toISOString(),
      gracePeriodEndsAt: r.grace_period_ends_at
        ? new Date(r.grace_period_ends_at).toISOString()
        : null,
      createdAt: new Date(r.tenant_created_at).toISOString(),
    })),
  };
}

export async function getPlatformBusinessDetail(
  trx: TenantTransactionContext,
  targetTenantId: string,
) {
  const tenant = await trx.db
    .selectFrom('tenants')
    .selectAll()
    .where('id', '=', targetTenantId)
    .executeTakeFirst();

  if (!tenant) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'ERR_NOT_FOUND',
      title: 'Business Not Found',
      detail: `Business "${targetTenantId}" was not found.`,
    });
  }

  // Create a scoped tenant context copy targeting targetTenantId under Platform Admin RLS
  const scopedTrx: TenantTransactionContext = Object.assign(trx, {
    tenantId: targetTenantId,
    tenantContext: {
      ...trx.tenantContext,
      tenantId: targetTenantId,
    },
  });

  const [
    entitlement,
    usage,
    branches,
    invoices,
    submissions,
    planHistory,
    auditLogs,
    storageBytes,
  ] = await Promise.all([
    getTenantSubscriptionEntitlement(scopedTrx),
    getTenantSubscriptionUsage(scopedTrx),
    trx.db
      .selectFrom('branches')
      .select(['id', 'code', 'name', 'timezone', 'country_code', 'is_active'])
      .where('tenant_id', '=', targetTenantId)
      .orderBy('created_at', 'asc')
      .orderBy('name', 'asc')
      .execute(),
    trx.db
      .selectFrom('subscription_invoices')
      .selectAll()
      .where('tenant_id', '=', targetTenantId)
      .orderBy('issued_at', 'desc')
      .limit(25)
      .execute(),
    trx.db
      .selectFrom('subscription_payment_submissions')
      .select([
        'id',
        'invoice_id',
        'payment_channel',
        'gateway_provider',
        'expected_amount',
        'submitted_amount',
        'currency_code',
        'payment_reference',
        'proof_file_name',
        'status',
        'rejection_reason',
        'submitted_at',
        'reviewed_at',
        'created_at',
      ])
      .where('tenant_id', '=', targetTenantId)
      .orderBy('created_at', 'desc')
      .limit(25)
      .execute(),
    trx.db
      .selectFrom('subscription_plan_history')
      .selectAll()
      .where('tenant_id', '=', targetTenantId)
      .orderBy('created_at', 'desc')
      .limit(30)
      .execute(),
    trx.db
      .selectFrom('platform_audit_logs')
      .selectAll()
      .where('target_tenant_id', '=', targetTenantId)
      .orderBy('created_at', 'desc')
      .limit(30)
      .execute(),
    calculateTenantStorageUsageBytes(scopedTrx),
  ]);

  return {
    business: {
      tenantId: tenant.id,
      slug: tenant.slug,
      legalName: tenant.legal_name,
      baseCurrency: tenant.base_currency,
      countryCode: tenant.country_code,
      status: tenant.status,
      createdAt: new Date(tenant.created_at).toISOString(),
    },
    entitlement,
    usage: {
      ...usage,
      usedStorageBytes: storageBytes,
    },
    branches: branches.map((b, idx) => ({
      id: b.id,
      code: b.code,
      name: b.name,
      timezone: b.timezone,
      countryCode: b.country_code,
      isMainBranch: idx === 0,
      isActive: Boolean(b.is_active),
    })),
    invoices: invoices.map((i) => ({
      id: i.id,
      invoiceNumber: i.invoice_number,
      invoiceType: i.invoice_type,
      billingCycle: i.billing_cycle,
      totalAmount: i.total_amount,
      amountPaid: i.amount_paid,
      currencyCode: i.currency_code,
      status: i.status,
      dueDate: i.due_date,
      paidAt: i.paid_at ? new Date(i.paid_at).toISOString() : null,
    })),
    submissions: submissions.map((s) => ({
      id: s.id,
      invoiceId: s.invoice_id,
      paymentChannel: s.payment_channel,
      gatewayProvider: s.gateway_provider,
      expectedAmount: s.expected_amount,
      currencyCode: s.currency_code,
      paymentReference: s.payment_reference,
      proofFileName: s.proof_file_name,
      status: s.status,
      rejectionReason: s.rejection_reason,
      createdAt: new Date(s.created_at).toISOString(),
    })),
    planHistory: planHistory.map((h) => ({
      id: h.id,
      changeType: h.change_type,
      fromStatus: h.from_status,
      toStatus: h.to_status,
      billingCycle: h.billing_cycle,
      notes: h.notes,
      effectiveAt: new Date(h.effective_at).toISOString(),
    })),
    platformAuditLogs: auditLogs.map((a) => ({
      id: a.id,
      action: a.action,
      actorRole: a.actor_role,
      resourceType: a.resource_type,
      previousState: a.previous_state_json,
      newState: a.new_state_json,
      createdAt: new Date(a.created_at).toISOString(),
    })),
  };
}

export async function suspendPlatformBusiness(
  trx: TenantTransactionContext,
  targetTenantId: string,
  reason: string,
) {
  const tenant = await trx.db
    .selectFrom('tenants')
    .select(['id', 'legal_name', 'status'])
    .where('id', '=', targetTenantId)
    .executeTakeFirst();
  if (!tenant) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'ERR_NOT_FOUND',
      title: 'Business Not Found',
      detail: `Business "${targetTenantId}" not found.`,
    });
  }

  const subRow = await trx.db
    .selectFrom('tenant_subscriptions')
    .select(['id', 'plan_id', 'status', 'billing_cycle'])
    .where('tenant_id', '=', targetTenantId)
    .executeTakeFirstOrThrow();

  const now = new Date();
  await trx.db
    .updateTable('tenants')
    .set({ status: 'SUSPENDED', updated_at: now })
    .where('id', '=', targetTenantId)
    .execute();

  await trx.db
    .updateTable('tenant_subscriptions')
    .set({
      status: 'SUSPENDED',
      override_reason: reason.trim(),
      updated_at: now,
    })
    .where('tenant_id', '=', targetTenantId)
    .where('id', '=', subRow.id)
    .execute();

  await trx.db
    .insertInto('subscription_plan_history')
    .values({
      id: generateUuidV7(),
      tenant_id: targetTenantId,
      subscription_id: subRow.id,
      change_type: 'STATUS_CHANGED',
      from_plan_id: subRow.plan_id,
      to_plan_id: subRow.plan_id,
      from_status: subRow.status,
      to_status: 'SUSPENDED',
      billing_cycle: subRow.billing_cycle,
      effective_at: now,
      actor_user_id: trx.userId,
      notes: `Platform Super Admin suspended business: ${reason.trim()}`,
      metadata_json: JSON.stringify({ platformAdminAction: true }),
    })
    .execute();

  await trx.db
    .insertInto('subscription_notifications')
    .values({
      id: generateUuidV7(),
      tenant_id: targetTenantId,
      subscription_id: subRow.id,
      event_type: 'SUBSCRIPTION_SUSPENDED',
      dedupe_key: `SUSPENDED:${now.toISOString().slice(0, 16)}:${subRow.id}`,
      severity: 'CRITICAL',
      title: 'Business Account Suspended',
      message: `Account suspended by Platform Administration: ${reason.trim()}`,
      metadata_json: JSON.stringify({ reason: reason.trim() }),
    })
    .onConflict((oc) => oc.columns(['tenant_id', 'dedupe_key']).doNothing())
    .execute();

  await recordPlatformAudit(trx, {
    targetTenantId,
    action: 'PLATFORM_BUSINESS_SUSPENDED',
    resourceType: 'TENANT',
    resourceId: targetTenantId,
    previousState: { status: subRow.status },
    newState: { status: 'SUSPENDED', reason: reason.trim() },
  });

  return { tenantId: targetTenantId, status: 'SUSPENDED', reason: reason.trim() };
}

export async function restorePlatformBusiness(
  trx: TenantTransactionContext,
  targetTenantId: string,
  input: PlatformRestoreBusinessRequest,
) {
  const subRow = await trx.db
    .selectFrom('tenant_subscriptions')
    .select(['id', 'plan_id', 'status', 'billing_cycle'])
    .where('tenant_id', '=', targetTenantId)
    .executeTakeFirst();

  if (!subRow) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'ERR_NOT_FOUND',
      title: 'Subscription Not Found',
      detail: `Subscription for business "${targetTenantId}" not found.`,
    });
  }

  const now = new Date();
  await trx.db
    .updateTable('tenants')
    .set({ status: input.targetStatus, updated_at: now })
    .where('id', '=', targetTenantId)
    .execute();

  await trx.db
    .updateTable('tenant_subscriptions')
    .set({
      status: input.targetStatus,
      override_reason: input.reason.trim(),
      updated_at: now,
    })
    .where('tenant_id', '=', targetTenantId)
    .where('id', '=', subRow.id)
    .execute();

  await trx.db
    .insertInto('subscription_plan_history')
    .values({
      id: generateUuidV7(),
      tenant_id: targetTenantId,
      subscription_id: subRow.id,
      change_type: 'STATUS_CHANGED',
      from_plan_id: subRow.plan_id,
      to_plan_id: subRow.plan_id,
      from_status: subRow.status,
      to_status: input.targetStatus,
      billing_cycle: subRow.billing_cycle,
      effective_at: now,
      actor_user_id: trx.userId,
      notes: `Platform Super Admin restored business (${input.targetStatus}): ${input.reason.trim()}`,
      metadata_json: JSON.stringify({ platformAdminAction: true }),
    })
    .execute();

  await trx.db
    .insertInto('subscription_notifications')
    .values({
      id: generateUuidV7(),
      tenant_id: targetTenantId,
      subscription_id: subRow.id,
      event_type: 'SUBSCRIPTION_RESTORED',
      dedupe_key: `RESTORED:${now.toISOString().slice(0, 16)}:${subRow.id}`,
      severity: 'SUCCESS',
      title: 'Business Access Restored',
      message: `Your subscription access was restored to ${input.targetStatus}: ${input.reason.trim()}`,
      metadata_json: JSON.stringify({ targetStatus: input.targetStatus }),
    })
    .onConflict((oc) => oc.columns(['tenant_id', 'dedupe_key']).doNothing())
    .execute();

  await recordPlatformAudit(trx, {
    targetTenantId,
    action: 'PLATFORM_BUSINESS_RESTORED',
    resourceType: 'TENANT',
    resourceId: targetTenantId,
    previousState: { status: subRow.status },
    newState: { status: input.targetStatus, reason: input.reason.trim() },
  });

  return {
    tenantId: targetTenantId,
    status: input.targetStatus,
    reason: input.reason.trim(),
  };
}

export async function adminOverrideBusinessSubscription(
  trx: TenantTransactionContext,
  targetTenantId: string,
  input: PlatformSubscriptionOverrideRequest,
) {
  const existing = await trx.db
    .selectFrom('tenant_subscriptions')
    .selectAll()
    .where('tenant_id', '=', targetTenantId)
    .executeTakeFirst();

  if (!existing) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'ERR_NOT_FOUND',
      title: 'Subscription Not Found',
      detail: `Subscription for business "${targetTenantId}" not found.`,
    });
  }

  let nextPlanId = existing.plan_id;
  if (input.planCode) {
    const plan = await trx.db
      .selectFrom('subscription_plans')
      .select(['id'])
      .where('code', '=', input.planCode.toUpperCase())
      .executeTakeFirst();
    if (!plan) {
      throw new AppError({
        statusCode: 404,
        errorCode: 'ERR_NOT_FOUND',
        title: 'Plan Not Found',
        detail: `Subscription plan "${input.planCode}" not found.`,
      });
    }
    nextPlanId = plan.id;
  }

  const now = new Date();
  let nextPeriodEnd = new Date(existing.current_period_end);
  if (input.extendDays) {
    const baseMs = Math.max(now.getTime(), nextPeriodEnd.getTime());
    nextPeriodEnd = new Date(baseMs + input.extendDays * 86_400_000);
  }

  let nextGraceEnd = existing.grace_period_ends_at
    ? new Date(existing.grace_period_ends_at)
    : null;
  if (input.extendGraceDays) {
    const baseGraceMs = Math.max(
      now.getTime(),
      nextGraceEnd?.getTime() ?? nextPeriodEnd.getTime(),
    );
    nextGraceEnd = new Date(baseGraceMs + input.extendGraceDays * 86_400_000);
  }

  const existingCustomLimits =
    existing.custom_limits_json && typeof existing.custom_limits_json === 'object'
      ? ({ ...(existing.custom_limits_json as Record<string, unknown>) } as Record<
          string,
          number | null
        >)
      : ({} as Record<string, number | null>);

  if (input.customMaxBranches !== undefined) {
    if (input.customMaxBranches === null) delete existingCustomLimits.maxBranches;
    else existingCustomLimits.maxBranches = input.customMaxBranches;
  }
  if (input.customMaxUsers !== undefined) {
    if (input.customMaxUsers === null) delete existingCustomLimits.maxUsers;
    else existingCustomLimits.maxUsers = input.customMaxUsers;
  }
  if (input.customMaxProducts !== undefined) {
    if (input.customMaxProducts === null) delete existingCustomLimits.maxProducts;
    else existingCustomLimits.maxProducts = input.customMaxProducts;
  }
  if (input.customMaxStorageMb !== undefined) {
    if (input.customMaxStorageMb === null) delete existingCustomLimits.maxStorageMb;
    else existingCustomLimits.maxStorageMb = input.customMaxStorageMb;
  }

  const nextStatus = input.status ?? existing.status;
  const nextCycle = input.billingCycle ?? existing.billing_cycle;

  await trx.db
    .updateTable('tenant_subscriptions')
    .set({
      plan_id: nextPlanId,
      status: nextStatus,
      billing_cycle: nextCycle,
      current_period_end: nextPeriodEnd,
      grace_period_ends_at: nextGraceEnd,
      ...(input.additionalBranchSlots !== undefined
        ? { additional_branch_slots: input.additionalBranchSlots }
        : {}),
      ...(input.customMonthlyPrice !== undefined
        ? { custom_monthly_price: input.customMonthlyPrice }
        : {}),
      custom_limits_json:
        Object.keys(existingCustomLimits).length > 0
          ? JSON.stringify(existingCustomLimits)
          : null,
      ...(input.allowAdminOverride !== undefined
        ? { allow_admin_override: input.allowAdminOverride }
        : {}),
      override_reason: input.reason.trim(),
      updated_at: now,
    })
    .where('tenant_id', '=', targetTenantId)
    .where('id', '=', existing.id)
    .execute();

  await trx.db
    .updateTable('tenants')
    .set({ status: nextStatus, updated_at: now })
    .where('id', '=', targetTenantId)
    .execute();

  await trx.db
    .insertInto('subscription_plan_history')
    .values({
      id: generateUuidV7(),
      tenant_id: targetTenantId,
      subscription_id: existing.id,
      change_type: 'LIFECYCLE_OVERRIDE',
      from_plan_id: existing.plan_id,
      to_plan_id: nextPlanId,
      from_status: existing.status,
      to_status: nextStatus,
      billing_cycle: nextCycle,
      effective_at: now,
      actor_user_id: trx.userId,
      notes: input.reason.trim(),
      metadata_json: JSON.stringify({
        extendDays: input.extendDays ?? null,
        extendGraceDays: input.extendGraceDays ?? null,
        customMonthlyPrice: input.customMonthlyPrice ?? existing.custom_monthly_price,
      }),
    })
    .execute();

  await recordPlatformAudit(trx, {
    targetTenantId,
    action: 'PLATFORM_SUBSCRIPTION_OVERRIDE',
    resourceType: 'TENANT_SUBSCRIPTION',
    resourceId: existing.id,
    previousState: {
      planId: existing.plan_id,
      status: existing.status,
      billingCycle: existing.billing_cycle,
      additionalBranchSlots: existing.additional_branch_slots,
      customMonthlyPrice: existing.custom_monthly_price,
    },
    newState: {
      planId: nextPlanId,
      status: nextStatus,
      billingCycle: nextCycle,
      additionalBranchSlots:
        input.additionalBranchSlots ?? existing.additional_branch_slots,
      customMonthlyPrice:
        input.customMonthlyPrice !== undefined
          ? input.customMonthlyPrice
          : existing.custom_monthly_price,
      reason: input.reason.trim(),
    },
  });

  const scopedTrx: TenantTransactionContext = Object.assign(trx, {
    tenantId: targetTenantId,
    tenantContext: { ...trx.tenantContext, tenantId: targetTenantId },
  });
  scopedTrx._trxCache?.delete(`subEntitlement:${targetTenantId}`);
  return getTenantSubscriptionEntitlement(scopedTrx);
}

// ============================================================================
// SaaS Analytics & Verified Revenue Reports (10.6.2 & 10.8)
// ============================================================================

export async function getPlatformAnalyticsOverview(
  trx: TenantTransactionContext,
  query: PlatformAnalyticsQuery = {},
) {
  const now = new Date();
  const endTs = query.endDate
    ? new Date(`${query.endDate}T23:59:59.999Z`)
    : now;
  const startTs = query.startDate
    ? new Date(`${query.startDate}T00:00:00.000Z`)
    : new Date(now.getTime() - 180 * 86_400_000);
  const currentMonthStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
  );

  const [tenants, subs, plans, payments, submissions, invoices, historyRows] =
    await Promise.all([
      trx.db
        .selectFrom('tenants')
        .select(['id', 'legal_name', 'status', 'created_at'])
        .execute(),
      trx.db
        .selectFrom('tenant_subscriptions')
        .selectAll()
        .execute(),
      trx.db.selectFrom('subscription_plans').selectAll().execute(),
      trx.db.selectFrom('subscription_payments').selectAll().execute(),
      trx.db
        .selectFrom('subscription_payment_submissions')
        .select([
          'id',
          'tenant_id',
          'invoice_id',
          'expected_amount',
          'currency_code',
          'status',
          'created_at',
        ])
        .execute(),
      trx.db
        .selectFrom('subscription_invoices')
        .select([
          'id',
          'tenant_id',
          'invoice_type',
          'billing_cycle',
          'target_plan_id',
          'total_amount',
          'status',
          'paid_at',
          'issued_at',
        ])
        .execute(),
      trx.db
        .selectFrom('subscription_plan_history')
        .select([
          'tenant_id',
          'change_type',
          'to_plan_id',
          'from_status',
          'to_status',
          'created_at',
        ])
        .execute(),
    ]);

  const planById = new Map(plans.map((p) => [p.id, p]));
  const subByTenant = new Map(subs.map((s) => [s.tenant_id, s]));
  const invoiceById = new Map(invoices.map((i) => [i.id, i]));

  // Apply optional planCode / status filters cleanly across tenants & subscriptions
  const matchingTenants = tenants.filter((t) => {
    const s = subByTenant.get(t.id);
    if (!s) return !query.planCode && !query.status;
    const p = planById.get(s.plan_id);
    if (query.planCode && p?.code !== query.planCode) return false;
    if (query.status && s.status !== query.status) return false;
    return true;
  });
  const matchingTenantSet = new Set(matchingTenants.map((t) => t.id));

  let activeBusinesses = 0;
  let trialBusinesses = 0;
  let paidBusinesses = 0;
  let pendingPaymentBusinesses = 0;
  let expiredOrReadOnlyBusinesses = 0;
  let cancelledBusinesses = 0;
  let suspendedBusinesses = 0;
  let scheduledDowngradesCount = 0;
  let newRegistrationsInRange = 0;

  let mrrMicro = 0n;
  const planDistMap = new Map<
    string,
    { planCode: string; planName: string; count: number; activePaidCount: number; mrrMicro: bigint }
  >();

  for (const p of plans) {
    if (p.is_public) {
      planDistMap.set(p.code, {
        planCode: p.code,
        planName: p.name,
        count: 0,
        activePaidCount: 0,
        mrrMicro: 0n,
      });
    }
  }

  for (const t of matchingTenants) {
    const createdAt = new Date(t.created_at);
    if (createdAt >= startTs && createdAt <= endTs) {
      newRegistrationsInRange += 1;
    }

    const s = subByTenant.get(t.id);
    if (!s) continue;
    const plan = planById.get(s.plan_id);
    const planCode = plan?.code ?? 'UNKNOWN';
    const planName = plan?.name ?? planCode;

    let dist = planDistMap.get(planCode);
    if (!dist) {
      dist = { planCode, planName, count: 0, activePaidCount: 0, mrrMicro: 0n };
      planDistMap.set(planCode, dist);
    }
    dist.count += 1;

    if (s.scheduled_plan_id) {
      scheduledDowngradesCount += 1;
    }

    if (s.status === 'ACTIVE') {
      activeBusinesses += 1;
      paidBusinesses += 1;
      dist.activePaidCount += 1;

      const baseMonthlyStr =
        s.custom_monthly_price ?? plan?.monthly_price_amount ?? '0.0000';
      const baseMonthlyMicro = Money.fromDecimalString(
        String(baseMonthlyStr),
        'LKR',
      ).toMinorUnits();
      let subMonthlyContribution = baseMonthlyMicro;
      if (s.billing_cycle === 'ANNUAL') {
        const discountPct = Number.parseFloat(
          String(plan?.annual_discount_pct ?? '0'),
        ) || 0;
        const bp = BigInt(Math.round(discountPct * 100));
        const annualNetMicro =
          baseMonthlyMicro * 12n - (baseMonthlyMicro * 12n * bp) / 10000n;
        subMonthlyContribution = annualNetMicro / 12n;
      }

      const extraBranches = BigInt(Math.max(0, s.additional_branch_slots ?? 0));
      if (extraBranches > 0n && plan?.additional_branch_monthly_fee) {
        const feeMicro = Money.fromDecimalString(
          String(plan.additional_branch_monthly_fee),
          'LKR',
        ).toMinorUnits();
        subMonthlyContribution += feeMicro * extraBranches;
      }

      mrrMicro += subMonthlyContribution;
      dist.mrrMicro += subMonthlyContribution;
    } else if (s.status === 'TRIALING') {
      trialBusinesses += 1;
      activeBusinesses += 1;
    } else if (
      s.status === 'PENDING_PAYMENT' ||
      s.status === 'PAYMENT_VERIFICATION_REQUIRED'
    ) {
      pendingPaymentBusinesses += 1;
    } else if (
      s.status === 'GRACE_PERIOD' ||
      s.status === 'EXPIRED' ||
      s.status === 'READ_ONLY' ||
      s.status === 'RENEWAL_DUE' ||
      s.status === 'PAST_DUE'
    ) {
      expiredOrReadOnlyBusinesses += 1;
    } else if (s.status === 'CANCELLED') {
      cancelledBusinesses += 1;
    } else if (s.status === 'SUSPENDED') {
      suspendedBusinesses += 1;
    }
  }

  // Strictly sum ONLY verified `subscription_payments` records (NEVER unverified bank slips!)
  let totalVerifiedRevenueMicro = 0n;
  let collectedRevenueInRangeMicro = 0n;
  let currentMonthRevenueMicro = 0n;
  let monthlyCycleRevenueMicro = 0n;
  let annualCycleRevenueMicro = 0n;
  let branchAddonRevenueMicro = 0n;

  const revByPlanMap = new Map<string, bigint>();
  const monthlyBucketMap = new Map<
    string,
    { month: string; newBusinesses: number; verifiedRevenueMicro: bigint; churnedCount: number }
  >();

  const ensureBucket = (d: Date) => {
    const key = d.toISOString().slice(0, 7);
    let b = monthlyBucketMap.get(key);
    if (!b) {
      b = { month: key, newBusinesses: 0, verifiedRevenueMicro: 0n, churnedCount: 0 };
      monthlyBucketMap.set(key, b);
    }
    return b;
  };

  for (const t of matchingTenants) {
    const d = new Date(t.created_at);
    if (d >= startTs && d <= endTs) {
      ensureBucket(d).newBusinesses += 1;
    }
  }

  for (const pay of payments) {
    if (!matchingTenantSet.has(pay.tenant_id)) continue;
    const paidAt = new Date(pay.paid_at);
    const amtMicro = Money.fromDecimalString(
      String(pay.amount),
      pay.currency_code || 'LKR',
    ).toMinorUnits();
    totalVerifiedRevenueMicro += amtMicro;

    if (paidAt >= currentMonthStart) {
      currentMonthRevenueMicro += amtMicro;
    }

    if (paidAt >= startTs && paidAt <= endTs) {
      collectedRevenueInRangeMicro += amtMicro;
      ensureBucket(paidAt).verifiedRevenueMicro += amtMicro;

      const inv = invoiceById.get(pay.subscription_invoice_id);
      if (inv?.invoice_type === 'BRANCH_ADDON') {
        branchAddonRevenueMicro += amtMicro;
      }
      if (inv?.billing_cycle === 'ANNUAL') {
        annualCycleRevenueMicro += amtMicro;
      } else {
        monthlyCycleRevenueMicro += amtMicro;
      }
      const p = inv?.target_plan_id ? planById.get(inv.target_plan_id) : undefined;
      const pCode = p?.code ?? 'OTHER';
      revByPlanMap.set(pCode, (revByPlanMap.get(pCode) ?? 0n) + amtMicro);
    }
  }

  // Strictly separate pending & failed/rejected amounts from collected revenue
  let pendingVerificationAmountMicro = 0n;
  let failedOrRejectedAmountMicro = 0n;
  let submittedCount = 0;
  let verifiedSubmissionCount = 0;
  let rejectedSubmissionCount = 0;

  for (const sub of submissions) {
    if (!matchingTenantSet.has(sub.tenant_id)) continue;
    const amtMicro = Money.fromDecimalString(
      String(sub.expected_amount),
      sub.currency_code || 'LKR',
    ).toMinorUnits();
    if (sub.status === 'SUBMITTED' || sub.status === 'UNDER_REVIEW' || sub.status === 'PENDING') {
      pendingVerificationAmountMicro += amtMicro;
      submittedCount += 1;
    } else if (sub.status === 'REJECTED' || sub.status === 'FAILED') {
      failedOrRejectedAmountMicro += amtMicro;
      rejectedSubmissionCount += 1;
    } else if (sub.status === 'VERIFIED') {
      verifiedSubmissionCount += 1;
    }
  }

  // Trial conversion & Churn analytics
  const trialStartedTenants = new Set<string>();
  const convertedTenants = new Set<string>();
  const upgradedCountTenants = new Set<string>();
  const churnedTenants = new Set<string>();
  let upgradeEventsCount = 0;
  let renewalEventsCount = 0;

  for (const h of historyRows) {
    if (!matchingTenantSet.has(h.tenant_id)) continue;
    const createdAt = new Date(h.created_at);
    if (h.change_type === 'TRIAL_STARTED') {
      trialStartedTenants.add(h.tenant_id);
    } else if (h.change_type === 'TRIAL_CONVERTED') {
      convertedTenants.add(h.tenant_id);
      trialStartedTenants.add(h.tenant_id);
    } else if (h.change_type === 'UPGRADED') {
      upgradedCountTenants.add(h.tenant_id);
      if (createdAt >= startTs && createdAt <= endTs) {
        upgradeEventsCount += 1;
      }
    } else if (h.change_type === 'RENEWED' && createdAt >= startTs && createdAt <= endTs) {
      renewalEventsCount += 1;
    }
    if (
      h.change_type === 'STATUS_CHANGED' &&
      (h.to_status === 'CANCELLED' || h.to_status === 'READ_ONLY' || h.to_status === 'SUSPENDED')
    ) {
      churnedTenants.add(h.tenant_id);
      if (createdAt >= startTs && createdAt <= endTs) {
        ensureBucket(createdAt).churnedCount += 1;
      }
    }
  }

  // Also include tenants directly on trial or converted in `tenant_subscriptions`
  for (const t of matchingTenants) {
    const s = subByTenant.get(t.id);
    if (s?.trial_started_at) trialStartedTenants.add(t.id);
    if (s?.trial_converted_at) convertedTenants.add(t.id);
    if (s && (s.status === 'CANCELLED' || s.status === 'EXPIRED' || s.status === 'READ_ONLY')) {
      churnedTenants.add(t.id);
    }
  }

  const totalTrialsCount = trialStartedTenants.size;
  const completedOrEndedTrials = Array.from(trialStartedTenants).filter((tid) => {
    const s = subByTenant.get(tid);
    return s && s.status !== 'TRIALING';
  }).length;
  const convertedCount = convertedTenants.size;
  const trialConversionRatePct =
    totalTrialsCount > 0
      ? Math.round((convertedCount / totalTrialsCount) * 10000) / 100
      : 0;
  const trialAbandonmentCount = Math.max(0, completedOrEndedTrials - convertedCount);

  const denominatorBusinesses = Math.max(1, matchingTenants.length);
  const businessChurnRatePct =
    Math.round((churnedTenants.size / denominatorBusinesses) * 10000) / 100;

  const fmtLkr = (micro: bigint) =>
    Money.fromMinorUnits(micro, 'LKR').toDecimalString();

  const monthlySeries = Array.from(monthlyBucketMap.values()).sort((a, b) =>
    a.month.localeCompare(b.month),
  );

  return {
    filters: {
      startDate: startTs.toISOString().slice(0, 10),
      endDate: endTs.toISOString().slice(0, 10),
      planCode: query.planCode ?? null,
      status: query.status ?? null,
    },
    businessKpis: {
      totalBusinesses: matchingTenants.length,
      activeBusinesses,
      trialBusinesses,
      paidBusinesses,
      pendingPaymentBusinesses,
      expiredOrReadOnlyBusinesses,
      cancelledBusinesses,
      suspendedBusinesses,
      newRegistrationsInRange,
    },
    subscriptionKpis: {
      activeSubscriptions: activeBusinesses,
      trialSubscriptions: trialBusinesses,
      expiredSubscriptions: expiredOrReadOnlyBusinesses,
      cancelledSubscriptions: cancelledBusinesses,
      scheduledDowngradesCount,
      upgradeEventsCount,
      renewalEventsCount,
    },
    revenueKpis: {
      currencyCode: 'LKR',
      mrrAmount: fmtLkr(mrrMicro),
      arrAmount: fmtLkr(mrrMicro * 12n),
      totalVerifiedRevenueAmount: fmtLkr(totalVerifiedRevenueMicro),
      collectedRevenueInRangeAmount: fmtLkr(collectedRevenueInRangeMicro),
      currentMonthRevenueAmount: fmtLkr(currentMonthRevenueMicro),
      monthlyCycleRevenueAmount: fmtLkr(monthlyCycleRevenueMicro),
      annualCycleRevenueAmount: fmtLkr(annualCycleRevenueMicro),
      branchAddonRevenueAmount: fmtLkr(branchAddonRevenueMicro),
      pendingVerificationAmount: fmtLkr(pendingVerificationAmountMicro),
      failedOrRejectedAmount: fmtLkr(failedOrRejectedAmountMicro),
      methodology:
        'MRR normalizes active paying monthly/annual recurring LKR revenue plus active branch add-ons; Verified Revenue counts strictly settled subscription_payments rows and excludes pending/rejected transfers or duplicate webhooks.',
    },
    paymentSummary: {
      pendingReviewCount: submittedCount,
      verifiedCount: verifiedSubmissionCount,
      rejectedOrFailedCount: rejectedSubmissionCount,
    },
    trialAnalytics: {
      totalTrialsStarted: totalTrialsCount,
      activeTrials: trialBusinesses,
      completedOrEndedTrials,
      convertedToPaidCount: convertedCount,
      trialAbandonmentCount,
      trialConversionRatePct,
    },
    churnAnalytics: {
      cancellationsCount: cancelledBusinesses,
      churnedOrExpiredCount: churnedTenants.size,
      businessChurnRatePct,
      methodology:
        'Business churn rate divides distinct cancelled/expired/read-only/suspended businesses by total matching businesses in cohort.',
    },
    planDistribution: Array.from(planDistMap.values()).map((d) => ({
      planCode: d.planCode,
      planName: d.planName,
      businessesCount: d.count,
      activePaidCount: d.activePaidCount,
      mrrAmount: fmtLkr(d.mrrMicro),
      verifiedRevenueInRangeAmount: fmtLkr(revByPlanMap.get(d.planCode) ?? 0n),
    })),
    monthlyTrends: monthlySeries.map((b) => ({
      month: b.month,
      newBusinesses: b.newBusinesses,
      verifiedRevenueAmount: fmtLkr(b.verifiedRevenueMicro),
      churnedBusinesses: b.churnedCount,
    })),
  };
}

function csvSafeCell(val: unknown): string {
  const s = String(val ?? '');
  const guarded = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${guarded.replace(/"/g, '""')}"`;
}

export async function exportPlatformAnalyticsCsv(
  trx: TenantTransactionContext,
  query: PlatformAnalyticsQuery = {},
): Promise<string> {
  const overview = await getPlatformAnalyticsOverview(trx, query);
  const rows: string[][] = [
    ['Metric Category', 'Metric Name', 'Value', 'Notes / Window'],
    ['Business', 'Total Businesses', String(overview.businessKpis.totalBusinesses), `${overview.filters.startDate} to ${overview.filters.endDate}`],
    ['Business', 'Active Businesses', String(overview.businessKpis.activeBusinesses), 'ACTIVE + TRIALING'],
    ['Business', 'Trial Businesses', String(overview.businessKpis.trialBusinesses), 'TRIALING'],
    ['Business', 'Paid Businesses', String(overview.businessKpis.paidBusinesses), 'ACTIVE'],
    ['Business', 'Pending Payment Businesses', String(overview.businessKpis.pendingPaymentBusinesses), 'PENDING_PAYMENT / PAYMENT_VERIFICATION_REQUIRED'],
    ['Business', 'Expired / Read-Only / Grace', String(overview.businessKpis.expiredOrReadOnlyBusinesses), 'EXPIRED / READ_ONLY / GRACE_PERIOD'],
    ['Business', 'Suspended Businesses', String(overview.businessKpis.suspendedBusinesses), 'SUSPENDED'],
    ['Revenue (LKR)', 'MRR', overview.revenueKpis.mrrAmount, 'Monthly Recurring Revenue'],
    ['Revenue (LKR)', 'ARR', overview.revenueKpis.arrAmount, 'Annual Recurring Revenue (12x MRR)'],
    ['Revenue (LKR)', 'Total Verified Revenue (All Time)', overview.revenueKpis.totalVerifiedRevenueAmount, 'Settled payments only'],
    ['Revenue (LKR)', 'Collected Revenue (In Range)', overview.revenueKpis.collectedRevenueInRangeAmount, `${overview.filters.startDate} to ${overview.filters.endDate}`],
    ['Revenue (LKR)', 'Current Month Verified Revenue', overview.revenueKpis.currentMonthRevenueAmount, 'Current UTC month'],
    ['Revenue (LKR)', 'Branch Add-On Revenue (In Range)', overview.revenueKpis.branchAddonRevenueAmount, 'BRANCH_ADDON settled'],
    ['Revenue (LKR)', 'Pending Verification Amount', overview.revenueKpis.pendingVerificationAmount, 'Excluded from collected revenue'],
    ['Revenue (LKR)', 'Rejected / Failed Amount', overview.revenueKpis.failedOrRejectedAmount, 'Excluded from collected revenue'],
    ['Trial & Conversion', 'Total Trials Started', String(overview.trialAnalytics.totalTrialsStarted), 'Cohort total'],
    ['Trial & Conversion', 'Converted To Paid', String(overview.trialAnalytics.convertedToPaidCount), 'TRIAL_CONVERTED'],
    ['Trial & Conversion', 'Trial Conversion Rate (%)', String(overview.trialAnalytics.trialConversionRatePct), '%'],
    ['Churn', 'Churned / Expired Businesses', String(overview.churnAnalytics.churnedOrExpiredCount), 'CANCELLED / EXPIRED / READ_ONLY / SUSPENDED'],
    ['Churn', 'Business Churn Rate (%)', String(overview.churnAnalytics.businessChurnRatePct), '%'],
  ];

  for (const p of overview.planDistribution) {
    rows.push([
      'Plan Breakdown',
      p.planCode,
      String(p.businessesCount),
      `Paid: ${p.activePaidCount} | MRR LKR ${p.mrrAmount} | Verified Rev LKR ${p.verifiedRevenueInRangeAmount}`,
    ]);
  }

  return rows.map((r) => r.map(csvSafeCell).join(',')).join('\r\n');
}

// ============================================================================
// Audit Logs Explorer, System Alerts & Real Backup Integrity Verification
// ============================================================================

export async function listPlatformAuditLogs(
  trx: TenantTransactionContext,
  query: {
    readonly tenantId?: string | undefined;
    readonly action?: string | undefined;
    readonly limit?: number | undefined;
    readonly offset?: number | undefined;
  } = {},
) {
  const limit = Math.min(100, Math.max(1, query.limit ?? 40));
  const offset = Math.max(0, query.offset ?? 0);

  let platQ = trx.db.selectFrom('platform_audit_logs').selectAll();
  if (query.tenantId) {
    platQ = platQ.where('target_tenant_id', '=', query.tenantId);
  }
  if (query.action && query.action.trim()) {
    platQ = platQ.where(
      sql`LOWER(action)`,
      'like',
      `%${query.action.trim().toLowerCase()}%`,
    );
  }
  const platformLogs = await platQ
    .orderBy('created_at', 'desc')
    .limit(limit)
    .offset(offset)
    .execute();

  let tenantAuditLogs: Array<{
    id: string;
    tenantId: string;
    actorUserId: string;
    action: string;
    resourceType: string;
    resourceId: string;
    metadataJson: unknown;
    traceId: string;
    createdAt: string;
  }> = [];

  if (query.tenantId) {
    const tRows = await trx.db
      .selectFrom('audit_logs')
      .selectAll()
      .where('tenant_id', '=', query.tenantId)
      .orderBy('created_at', 'desc')
      .limit(30)
      .execute();
    tenantAuditLogs = tRows.map((r) => ({
      id: r.id,
      tenantId: r.tenant_id,
      actorUserId: r.actor_user_id,
      action: r.action,
      resourceType: r.resource_type,
      resourceId: r.resource_id,
      metadataJson: r.metadata_json,
      traceId: r.trace_id,
      createdAt: new Date(r.created_at).toISOString(),
    }));
  }

  return {
    items: platformLogs.map((r) => ({
      id: r.id,
      actorUserId: r.actor_user_id,
      actorRole: r.actor_role,
      targetTenantId: r.target_tenant_id,
      action: r.action,
      resourceType: r.resource_type,
      resourceId: r.resource_id,
      previousState: r.previous_state_json,
      newState: r.new_state_json,
      correlationId: r.correlation_id,
      metadata: r.metadata_json,
      createdAt: new Date(r.created_at).toISOString(),
    })),
    tenantAuditLogs,
  };
}

export async function listPlatformSystemAlerts(
  trx: TenantTransactionContext,
  statusFilter?: string,
) {
  let q = trx.db.selectFrom('platform_system_alerts').selectAll();
  if (statusFilter) {
    q = q.where('status', '=', statusFilter as never);
  }
  const rows = await q.orderBy('created_at', 'desc').limit(100).execute();
  return {
    items: rows.map((r) => ({
      id: r.id,
      eventCategory: r.event_category,
      severity: r.severity,
      status: r.status,
      tenantId: r.tenant_id,
      summary: r.summary,
      details: r.details_json,
      traceId: r.trace_id,
      resolvedByUserId: r.resolved_by_user_id,
      resolvedAt: r.resolved_at ? new Date(r.resolved_at).toISOString() : null,
      createdAt: new Date(r.created_at).toISOString(),
    })),
  };
}

export async function resolvePlatformSystemAlert(
  trx: TenantTransactionContext,
  alertId: string,
) {
  const updated = await trx.db
    .updateTable('platform_system_alerts')
    .set({
      status: 'RESOLVED',
      resolved_by_user_id: trx.userId,
      resolved_at: new Date(),
    })
    .where('id', '=', alertId)
    .returningAll()
    .executeTakeFirst();

  if (!updated) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'ERR_NOT_FOUND',
      title: 'System Alert Not Found',
      detail: `System alert "${alertId}" not found.`,
    });
  }

  await recordPlatformAudit(trx, {
    targetTenantId: updated.tenant_id,
    action: 'PLATFORM_ALERT_RESOLVED',
    resourceType: 'PLATFORM_SYSTEM_ALERT',
    resourceId: alertId,
    newState: { status: 'RESOLVED' },
  });

  return {
    id: updated.id,
    status: updated.status,
    resolvedAt: updated.resolved_at
      ? new Date(updated.resolved_at).toISOString()
      : null,
  };
}

export async function runBackupAndIntegrityVerification(
  trx: TenantTransactionContext,
  triggerType: 'MANUAL_CHECK' | 'SCHEDULED_CHECK' | 'SNAPSHOT_EXPORT' = 'MANUAL_CHECK',
) {
  const startedMs = Date.now();

  const [rlsTablesRes, policiesRes, migCountRes, tenantsCountRes, orphanInvRes, unbalancedRes] =
    await Promise.all([
      sql<{ cnt: string }>`
        SELECT COUNT(*) AS cnt FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity = true
      `.execute(trx.db),
      sql<{ cnt: string }>`
        SELECT COUNT(*) AS cnt FROM pg_policies WHERE schemaname = 'public'
      `.execute(trx.db),
      sql<{ max_ver: number }>`
        SELECT COALESCE(MAX(version), 0) AS max_ver FROM schema_migrations
      `.execute(trx.db),
      trx.db
        .selectFrom('tenants')
        .select(sql<string>`COUNT(*)`.as('cnt'))
        .executeTakeFirst(),
      sql<{ cnt: string }>`
        SELECT COUNT(*) AS cnt FROM tenants t
        WHERE NOT EXISTS (
          SELECT 1 FROM tenant_subscriptions ts WHERE ts.tenant_id = t.id
        )
      `.execute(trx.db),
      sql<{ cnt: string }>`
        SELECT COUNT(*) AS cnt FROM subscription_invoices si
        WHERE si.status = 'PAID'
          AND NOT EXISTS (
            SELECT 1 FROM subscription_payments sp
            WHERE sp.tenant_id = si.tenant_id AND sp.subscription_invoice_id = si.id
          )
      `.execute(trx.db),
    ]);

  const tablesVerified = Number(rlsTablesRes.rows[0]?.cnt ?? 0);
  const policiesVerified = Number(policiesRes.rows[0]?.cnt ?? 0);
  const maxSchemaVersion = Number(migCountRes.rows[0]?.max_ver ?? 0);
  const tenantsCount = Number(tenantsCountRes?.cnt ?? 0);
  const missingSubTenants = Number(orphanInvRes.rows[0]?.cnt ?? 0);
  const paidInvoicesWithoutPayment = Number(unbalancedRes.rows[0]?.cnt ?? 0);

  const ledgerChecksPassed =
    missingSubTenants === 0 && paidInvoicesWithoutPayment === 0;
  const status: 'VERIFIED' | 'WARNING' | 'FAILED' =
    tablesVerified > 0 && policiesVerified > 0 && ledgerChecksPassed
      ? 'VERIFIED'
      : 'WARNING';

  const findings = {
    schemaVersion: maxSchemaVersion,
    rlsProtectedTables: tablesVerified,
    rlsPolicies: policiesVerified,
    tenantsCount,
    tenantsMissingSubscription: missingSubTenants,
    paidInvoicesWithoutPaymentRecord: paidInvoicesWithoutPayment,
    verifiedAt: new Date().toISOString(),
  };

  const checksumSha256 = createHash('sha256')
    .update(JSON.stringify(findings))
    .digest('hex');

  const durationMs = Math.max(1, Date.now() - startedMs);
  const runId = generateUuidV7();

  await trx.db
    .insertInto('backup_verification_runs')
    .values({
      id: runId,
      trigger_type: triggerType,
      triggered_by_user_id: trx.userId,
      status,
      tables_verified: tablesVerified,
      rls_policies_verified: policiesVerified,
      ledger_checks_passed: ledgerChecksPassed,
      checksum_sha256: checksumSha256,
      duration_ms: durationMs,
      findings_json: JSON.stringify(findings),
    })
    .execute();

  await recordPlatformAudit(trx, {
    action: 'PLATFORM_BACKUP_INTEGRITY_VERIFIED',
    resourceType: 'BACKUP_VERIFICATION_RUN',
    resourceId: runId,
    newState: { status, tablesVerified, policiesVerified, ledgerChecksPassed, checksumSha256 },
  });

  return {
    id: runId,
    triggerType,
    status,
    tablesVerified,
    rlsPoliciesVerified: policiesVerified,
    ledgerChecksPassed,
    checksumSha256,
    durationMs,
    findings,
    createdAt: new Date().toISOString(),
  };
}

export async function listBackupVerificationRuns(trx: TenantTransactionContext) {
  const rows = await trx.db
    .selectFrom('backup_verification_runs')
    .selectAll()
    .orderBy('created_at', 'desc')
    .limit(20)
    .execute();

  return {
    items: rows.map((r) => ({
      id: r.id,
      triggerType: r.trigger_type,
      triggeredByUserId: r.triggered_by_user_id,
      status: r.status,
      tablesVerified: r.tables_verified,
      rlsPoliciesVerified: r.rls_policies_verified,
      ledgerChecksPassed: r.ledger_checks_passed,
      checksumSha256: r.checksum_sha256,
      durationMs: r.duration_ms,
      findings: r.findings_json,
      createdAt: new Date(r.created_at).toISOString(),
    })),
  };
}

import { Money } from '@nexstock/domain-core';
import {
  AppError,
  type TenantLifecycleStatus,
  type TenantTransactionContext,
  appendAuditLog,
  enqueueOutboxEvent,
  generateUuidV7,
} from '../../shared/index.js';
import {
  mergePlanAndCustomFeatures,
  assertValidLifecycleTransition,
} from '../domain/entitlement-matrix.js';

export type SubscriptionPlanCode =
  | 'STARTER'
  | 'PROFESSIONAL'
  | 'GROWTH'
  | 'ENTERPRISE';
export type SubscriptionQuotaResource =
  | 'BRANCH'
  | 'WAREHOUSE'
  | 'REGISTER'
  | 'USER'
  | 'PRODUCT'
  | 'STORAGE_MB';
export type PlatformModule = 'HRM' | 'EXPENSES' | 'CUSTOMER_CREDIT';

export interface SubscriptionFeaturesDto {
  readonly hrm: boolean;
  readonly multiCurrency: boolean;
  readonly batchTracking: boolean;
  readonly [key: string]: boolean;
}

export interface SubscriptionEntitlementDto {
  readonly subscriptionId: string;
  readonly tenantId: string;
  readonly planId: string;
  readonly planCode: string;
  readonly planName: string;
  readonly status: TenantLifecycleStatus;
  readonly billingMode: 'ADMIN_PROVISIONED' | 'EXTERNAL_PROVIDER';
  readonly providerCode: 'MANUAL_ADMIN' | 'PAYHERE_LK' | 'STRIPE' | 'PADDLE';
  readonly billingCycle: 'MONTHLY' | 'ANNUAL';
  readonly isCustomPricing: boolean;
  readonly trialStartedAt: string | null;
  readonly trialEndsAt: string | null;
  readonly trialConvertedAt: string | null;
  readonly currentPeriodStart: string;
  readonly currentPeriodEnd: string;
  readonly gracePeriodEndsAt: string | null;
  readonly readOnlyEnteredAt: string | null;
  readonly additionalBranchSlots: number;
  readonly scheduledDowngradePlanCode: string | null;
  readonly scheduledDowngradeBillingCycle: 'MONTHLY' | 'ANNUAL' | null;
  readonly scheduledDowngradeEffectiveAt: string | null;
  readonly allowAdminOverride: boolean;
  readonly overrideReason: string | null;
  readonly limits: {
    readonly maxBranches: number;
    readonly includedBranches: number;
    readonly maxWarehouses: number;
    readonly maxRegisters: number;
    readonly maxUsers: number;
    readonly maxProducts: number;
    readonly maxStorageMb: number;
  };
  readonly features: SubscriptionFeaturesDto;
}

function parseCustomLimits(raw: unknown): Record<string, number> {
  let obj: Record<string, unknown> = {};
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      obj = {};
    }
  } else if (raw && typeof raw === 'object') {
    obj = raw as Record<string, unknown>;
  }
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
      out[k] = Math.floor(v);
    }
  }
  return out;
}

function toFeaturesDto(params: {
  readonly planCode: string;
  readonly rawPlanFeaturesJson: unknown;
  readonly rawCustomFeaturesJson?: unknown;
}): SubscriptionFeaturesDto {
  const merged = mergePlanAndCustomFeatures(params);
  return {
    ...merged,
    hrm: Boolean(merged.hrm),
    multiCurrency: Boolean(merged.multiCurrency),
    batchTracking: Boolean(merged.batchTracking),
  };
}

export interface SubscriptionInvoiceDto {
  readonly id: string;
  readonly tenantId: string;
  readonly subscriptionId: string;
  readonly invoiceNumber: string;
  readonly currencyCode: string;
  readonly totalAmount: string;
  readonly amountPaid: string;
  readonly status: 'DRAFT' | 'OPEN' | 'PAID' | 'PAST_DUE' | 'VOID';
  readonly dueDate: string;
}

/**
 * Provider-Neutral Subscription Billing Port (ADR UD-05).
 * Decouples NexStock's entitlement and invoice engine from any mandatory external gateway.
 */
export interface SubscriptionBillingPort {
  readonly providerCode: 'MANUAL_ADMIN' | 'PAYHERE_LK' | 'STRIPE' | 'PADDLE';
  recordVerifiedPayment(
    trx: TenantTransactionContext,
    input: {
      readonly invoiceId: string;
      readonly currencyCode: string;
      readonly amount: string;
      readonly paymentMethod:
        | 'BANK_TRANSFER'
        | 'MANUAL_RECEIPT'
        | 'CHEQUE'
        | 'EXTERNAL_GATEWAY_REF';
      readonly referenceNumber: string;
    },
  ): Promise<{
    readonly paymentId: string;
    readonly invoice: SubscriptionInvoiceDto;
    readonly subscriptionStatus: TenantLifecycleStatus;
  }>;
}

export async function provisionTenantSubscription(
  trx: TenantTransactionContext,
  input: {
    readonly planCode: SubscriptionPlanCode;
    readonly status?: TenantLifecycleStatus | undefined;
    readonly trialDays?: number | undefined;
    readonly now?: Date | undefined;
  },
): Promise<SubscriptionEntitlementDto> {
  const plan = await trx.db
    .selectFrom('subscription_plans')
    .select([
      'id',
      'code',
      'name',
      'is_custom_pricing',
      'max_branches',
      'max_warehouses',
      'max_registers',
      'max_users',
      'max_products',
      'max_storage_mb',
      'trial_days',
      'features_json',
    ])
    .where('code', '=', input.planCode)
    .where('is_active', '=', true)
    .executeTakeFirst();

  if (!plan) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'ERR_NOT_FOUND',
      title: 'Subscription Plan Not Found',
      detail: `Active subscription plan "${input.planCode}" was not found.`,
    });
  }

  const now = input.now ?? new Date();
  const status = input.status ?? 'TRIALING';
  const trialDays = input.trialDays ?? plan.trial_days ?? 30;
  const trialStartedAt = status === 'TRIALING' ? now : null;
  const trialEndsAt =
    status === 'TRIALING'
      ? new Date(now.getTime() + trialDays * 24 * 60 * 60 * 1000)
      : null;
  const currentPeriodEnd =
    trialEndsAt ?? new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  const existing = await trx.db
    .selectFrom('tenant_subscriptions')
    .select(['id'])
    .where('tenant_id', '=', trx.tenantId)
    .executeTakeFirst();

  const subscriptionId = existing?.id ?? generateUuidV7();

  await trx.db
    .insertInto('tenant_subscriptions')
    .values({
      id: subscriptionId,
      tenant_id: trx.tenantId,
      plan_id: plan.id,
      billing_mode: 'ADMIN_PROVISIONED',
      provider_code: 'MANUAL_ADMIN',
      billing_cycle: 'MONTHLY',
      status,
      trial_started_at: trialStartedAt,
      trial_ends_at: trialEndsAt,
      trial_converted_at: null,
      current_period_start: now,
      current_period_end: currentPeriodEnd,
      grace_period_ends_at: null,
      read_only_entered_at: null,
      cancelled_at: null,
      scheduled_plan_id: null,
      scheduled_billing_cycle: null,
      scheduled_change_effective_at: null,
      additional_branch_slots: 0,
      custom_monthly_price: null,
      custom_limits_json: null,
      custom_features_json: null,
      allow_admin_override: false,
      override_reason: null,
      updated_at: now,
    })
    .onConflict((oc) =>
      oc.column('tenant_id').doUpdateSet({
        plan_id: plan.id,
        status,
        trial_started_at: trialStartedAt,
        trial_ends_at: trialEndsAt,
        current_period_start: now,
        current_period_end: currentPeriodEnd,
        updated_at: now,
      }),
    )
    .execute();

  await trx.db
    .insertInto('subscription_plan_history')
    .values({
      id: generateUuidV7(),
      tenant_id: trx.tenantId,
      subscription_id: subscriptionId,
      change_type: status === 'TRIALING' ? 'TRIAL_STARTED' : 'STATUS_CHANGED',
      from_plan_id: null,
      to_plan_id: plan.id,
      from_status: null,
      to_status: status,
      billing_cycle: 'MONTHLY',
      effective_at: now,
      actor_user_id: trx.userId,
      notes: status === 'TRIALING' ? `${trialDays}-day free trial started` : 'Subscription provisioned',
      metadata_json: JSON.stringify({ planCode: plan.code, trialDays }),
    })
    .execute();

  // Synchronize tenant lifecycle status
  await trx.db
    .updateTable('tenants')
    .set({ status, updated_at: now })
    .where('id', '=', trx.tenantId)
    .execute();

  await appendAuditLog(trx, {
    action: 'SUB_SUBSCRIPTION_PROVISIONED',
    resourceType: 'TENANT_SUBSCRIPTION',
    resourceId: subscriptionId,
    metadata: {
      planCode: plan.code,
      status,
      trialEndsAt: trialEndsAt ? trialEndsAt.toISOString() : null,
    },
  });

  const entitlement: SubscriptionEntitlementDto = {
    subscriptionId,
    tenantId: trx.tenantId,
    planId: plan.id,
    planCode: plan.code,
    planName: plan.name,
    status,
    billingMode: 'ADMIN_PROVISIONED',
    providerCode: 'MANUAL_ADMIN',
    billingCycle: 'MONTHLY',
    isCustomPricing: plan.is_custom_pricing,
    trialStartedAt: trialStartedAt ? trialStartedAt.toISOString() : null,
    trialEndsAt: trialEndsAt ? trialEndsAt.toISOString() : null,
    trialConvertedAt: null,
    currentPeriodStart: now.toISOString(),
    currentPeriodEnd: currentPeriodEnd.toISOString(),
    gracePeriodEndsAt: null,
    readOnlyEnteredAt: null,
    additionalBranchSlots: 0,
    scheduledDowngradePlanCode: null,
    scheduledDowngradeBillingCycle: null,
    scheduledDowngradeEffectiveAt: null,
    allowAdminOverride: false,
    overrideReason: null,
    limits: {
      maxBranches: plan.max_branches,
      includedBranches: plan.max_branches,
      maxWarehouses: plan.max_warehouses,
      maxRegisters: plan.max_registers,
      maxUsers: plan.max_users,
      maxProducts: plan.max_products,
      maxStorageMb: plan.max_storage_mb,
    },
    features: toFeaturesDto({
      planCode: plan.code,
      rawPlanFeaturesJson: plan.features_json,
    }),
  };
  trx._trxCache?.set(`subEntitlement:${trx.tenantId}`, entitlement);
  return entitlement;
}

export async function getTenantSubscriptionEntitlement(
  trx: TenantTransactionContext,
): Promise<SubscriptionEntitlementDto> {
  const cacheKey = `subEntitlement:${trx.tenantId}`;
  const cached = trx._trxCache?.get(cacheKey) as SubscriptionEntitlementDto | undefined;
  if (cached) {
    return cached;
  }

  const selectSubscriptionEntitlementRow = () =>
    trx.db
      .selectFrom('tenant_subscriptions')
      .innerJoin(
        'subscription_plans',
        'subscription_plans.id',
        'tenant_subscriptions.plan_id',
      )
      .leftJoin(
        'subscription_plans as sched_plan',
        'sched_plan.id',
        'tenant_subscriptions.scheduled_plan_id',
      )
      .select([
        'tenant_subscriptions.id as subscription_id',
        'tenant_subscriptions.tenant_id as tenant_id',
        'tenant_subscriptions.plan_id as plan_id',
        'tenant_subscriptions.billing_mode as billing_mode',
        'tenant_subscriptions.provider_code as provider_code',
        'tenant_subscriptions.billing_cycle as billing_cycle',
        'tenant_subscriptions.status as status',
        'tenant_subscriptions.trial_started_at as trial_started_at',
        'tenant_subscriptions.trial_ends_at as trial_ends_at',
        'tenant_subscriptions.trial_converted_at as trial_converted_at',
        'tenant_subscriptions.current_period_start as current_period_start',
        'tenant_subscriptions.current_period_end as current_period_end',
        'tenant_subscriptions.grace_period_ends_at as grace_period_ends_at',
        'tenant_subscriptions.read_only_entered_at as read_only_entered_at',
        'tenant_subscriptions.additional_branch_slots as additional_branch_slots',
        'tenant_subscriptions.scheduled_billing_cycle as scheduled_billing_cycle',
        'tenant_subscriptions.scheduled_change_effective_at as scheduled_change_effective_at',
        'tenant_subscriptions.custom_limits_json as custom_limits_json',
        'tenant_subscriptions.custom_features_json as custom_features_json',
        'tenant_subscriptions.allow_admin_override as allow_admin_override',
        'tenant_subscriptions.override_reason as override_reason',
        'subscription_plans.code as plan_code',
        'subscription_plans.name as plan_name',
        'subscription_plans.is_custom_pricing as is_custom_pricing',
        'subscription_plans.max_branches as max_branches',
        'subscription_plans.max_warehouses as max_warehouses',
        'subscription_plans.max_registers as max_registers',
        'subscription_plans.max_users as max_users',
        'subscription_plans.max_products as max_products',
        'subscription_plans.max_storage_mb as max_storage_mb',
        'subscription_plans.features_json as features_json',
        'sched_plan.code as scheduled_plan_code',
      ])
      .where('tenant_subscriptions.tenant_id', '=', trx.tenantId)
      .executeTakeFirst();

  let row = await selectSubscriptionEntitlementRow();

  if (!row) {
    // Attempt lazy self-healing: verify if this tenant organization exists in public.tenants
    const tenant = await trx.db
      .selectFrom('tenants')
      .select(['id', 'status', 'created_at'])
      .where('id', '=', trx.tenantId)
      .executeTakeFirst();

    if (tenant) {
      const starterPlan = await trx.db
        .selectFrom('subscription_plans')
        .select(['id', 'trial_days'])
        .where('code', '=', 'STARTER')
        .where('is_active', '=', true)
        .executeTakeFirst();

      if (starterPlan) {
        const now = new Date();
        const trialDays = starterPlan.trial_days ?? 30;
        const tenantCreatedAt = tenant.created_at
          ? new Date(tenant.created_at)
          : now;
        const trialEndsAt = new Date(
          Math.max(
            now.getTime() + trialDays * 86400 * 1000,
            tenantCreatedAt.getTime() + trialDays * 86400 * 1000,
          ),
        );
        const currentPeriodEnd = trialEndsAt;

        await trx.db
          .insertInto('tenant_subscriptions')
          .values({
            id: generateUuidV7(),
            tenant_id: trx.tenantId,
            plan_id: starterPlan.id,
            billing_mode: 'ADMIN_PROVISIONED',
            provider_code: 'MANUAL_ADMIN',
            billing_cycle: 'MONTHLY',
            status: 'TRIALING',
            trial_started_at: now,
            trial_ends_at: trialEndsAt,
            current_period_start: now,
            current_period_end: currentPeriodEnd,
            allow_admin_override: false,
            override_reason:
              'Self-healed missing subscription during entitlement resolution',
            updated_at: now,
          })
          .onConflict((oc) =>
            oc.column('tenant_id').doUpdateSet({
              plan_id: starterPlan.id,
              status: 'TRIALING',
              trial_ends_at: trialEndsAt,
              current_period_start: now,
              current_period_end: currentPeriodEnd,
              updated_at: now,
            }),
          )
          .execute();

        if (tenant.status !== 'TRIALING' && tenant.status !== 'ACTIVE') {
          await trx.db
            .updateTable('tenants')
            .set({ status: 'TRIALING', updated_at: now })
            .where('id', '=', trx.tenantId)
            .execute();
        }

        row = await selectSubscriptionEntitlementRow();
      }
    }
  }

  if (!row) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'ERR_NOT_FOUND',
      title: 'Tenant Subscription Not Found',
      detail: `No subscription record found for tenant "${trx.tenantId}".`,
    });
  }

  const customLimits = parseCustomLimits(row.custom_limits_json);
  const includedBranches = customLimits.maxBranches ?? row.max_branches;
  const addonBranches = row.additional_branch_slots ?? 0;

  const entitlement: SubscriptionEntitlementDto = {
    subscriptionId: row.subscription_id,
    tenantId: row.tenant_id,
    planId: row.plan_id,
    planCode: row.plan_code,
    planName: row.plan_name,
    status: row.status,
    billingMode: row.billing_mode,
    providerCode: row.provider_code,
    billingCycle: row.billing_cycle ?? 'MONTHLY',
    isCustomPricing: Boolean(row.is_custom_pricing),
    trialStartedAt: row.trial_started_at
      ? new Date(row.trial_started_at).toISOString()
      : null,
    trialEndsAt: row.trial_ends_at
      ? new Date(row.trial_ends_at).toISOString()
      : null,
    trialConvertedAt: row.trial_converted_at
      ? new Date(row.trial_converted_at).toISOString()
      : null,
    currentPeriodStart: new Date(row.current_period_start).toISOString(),
    currentPeriodEnd: new Date(row.current_period_end).toISOString(),
    gracePeriodEndsAt: row.grace_period_ends_at
      ? new Date(row.grace_period_ends_at).toISOString()
      : null,
    readOnlyEnteredAt: row.read_only_entered_at
      ? new Date(row.read_only_entered_at).toISOString()
      : null,
    additionalBranchSlots: addonBranches,
    scheduledDowngradePlanCode: row.scheduled_plan_code ?? null,
    scheduledDowngradeBillingCycle: row.scheduled_billing_cycle ?? null,
    scheduledDowngradeEffectiveAt: row.scheduled_change_effective_at
      ? new Date(row.scheduled_change_effective_at).toISOString()
      : null,
    allowAdminOverride: row.allow_admin_override,
    overrideReason: row.override_reason,
    limits: {
      maxBranches: includedBranches + addonBranches,
      includedBranches,
      maxWarehouses: customLimits.maxWarehouses ?? row.max_warehouses + addonBranches * 2,
      maxRegisters: customLimits.maxRegisters ?? row.max_registers + addonBranches * 2,
      maxUsers: customLimits.maxUsers ?? row.max_users,
      maxProducts: customLimits.maxProducts ?? row.max_products,
      maxStorageMb: customLimits.maxStorageMb ?? row.max_storage_mb,
    },
    features: toFeaturesDto({
      planCode: row.plan_code,
      rawPlanFeaturesJson: row.features_json,
      rawCustomFeaturesJson: row.custom_features_json,
    }),
  };
  trx._trxCache?.set(cacheKey, entitlement);
  return entitlement;
}

export async function updateSubscriptionLifecycleAndOverride(
  trx: TenantTransactionContext,
  input: {
    readonly status?: TenantLifecycleStatus | undefined;
    readonly planCode?: SubscriptionPlanCode | undefined;
    readonly trialEndsAt?: Date | null | undefined;
    readonly allowAdminOverride?: boolean | undefined;
    readonly overrideReason?: string | null | undefined;
  },
): Promise<SubscriptionEntitlementDto> {
  const current = await getTenantSubscriptionEntitlement(trx);

  let nextPlanId = current.planId;
  if (input.planCode) {
    const planRow = await trx.db
      .selectFrom('subscription_plans')
      .select(['id'])
      .where('code', '=', input.planCode)
      .executeTakeFirst();
    if (!planRow) {
      throw new AppError({
        statusCode: 404,
        errorCode: 'ERR_NOT_FOUND',
        title: 'Subscription Plan Not Found',
        detail: `Plan "${input.planCode}" was not found.`,
      });
    }
    nextPlanId = planRow.id;
  }

  const nextStatus = input.status ?? current.status;
  if (input.status && input.status !== current.status) {
    assertValidLifecycleTransition(current.status, input.status);
  }
  const nextAllowOverride =
    input.allowAdminOverride ?? current.allowAdminOverride;
  const nextOverrideReason =
    input.overrideReason !== undefined
      ? input.overrideReason
      : current.overrideReason;

  if (
    nextAllowOverride &&
    (!nextOverrideReason || nextOverrideReason.trim().length < 5)
  ) {
    throw new AppError({
      statusCode: 400,
      errorCode: 'ERR_VALIDATION_FAILED',
      title: 'Administrative Override Reason Required',
      detail:
        'Enabling allowAdminOverride requires a non-empty recorded overrideReason (minimum 5 characters).',
    });
  }

  const nextTrialEndsAt =
    input.trialEndsAt !== undefined
      ? input.trialEndsAt
      : current.trialEndsAt
        ? new Date(current.trialEndsAt)
        : null;

  await trx.db
    .updateTable('tenant_subscriptions')
    .set({
      plan_id: nextPlanId,
      status: nextStatus,
      trial_ends_at: nextTrialEndsAt,
      allow_admin_override: nextAllowOverride,
      override_reason: nextOverrideReason,
      updated_at: new Date(),
    })
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', current.subscriptionId)
    .execute();

  await trx.db
    .updateTable('tenants')
    .set({ status: nextStatus, updated_at: new Date() })
    .where('id', '=', trx.tenantId)
    .execute();

  await appendAuditLog(trx, {
    action: 'SUB_LIFECYCLE_OR_OVERRIDE_UPDATED',
    resourceType: 'TENANT_SUBSCRIPTION',
    resourceId: current.subscriptionId,
    metadata: {
      previousStatus: current.status,
      nextStatus,
      allowAdminOverride: nextAllowOverride,
      overrideReason: nextOverrideReason,
    },
  });

  trx._trxCache?.delete(`subEntitlement:${trx.tenantId}`);
  return getTenantSubscriptionEntitlement(trx);
}

/**
 * Enforces server-side subscription lifecycle entitlement and plan quota checks (Section 5.3).
 *
 * Rules:
 * 1. If `allow_admin_override = true` (with documented `override_reason`), bypasses lifecycle/quota blocks.
 * 2. If `status === 'TRIALING'` and `now > trial_ends_at`, blocks mutations with `403 SUB_TRIAL_EXPIRED`.
 * 3. If `status` is `'SUSPENDED'`, `'CANCELLED'`, or `'PAST_DUE'` (for write operations), blocks with `403 SUB_SUBSCRIPTION_INACTIVE`.
 * 4. If `quotaCheck` is supplied and `currentCount >= planLimit`, blocks with `403 SUB_QUOTA_EXCEEDED`.
 */
export async function assertSubscriptionEntitlement(
  trx: TenantTransactionContext,
  options: {
    readonly requireWriteAccess: boolean;
    readonly now?: Date | undefined;
    readonly quotaCheck?:
      | {
          readonly resource: SubscriptionQuotaResource;
          readonly currentActiveCount: number;
        }
      | undefined;
  },
): Promise<SubscriptionEntitlementDto> {
  const entitlement = await getTenantSubscriptionEntitlement(trx);

  if (entitlement.allowAdminOverride) {
    return entitlement;
  }

  const now = options.now ?? new Date();

  if (entitlement.status === 'TRIALING' && entitlement.trialEndsAt) {
    const trialEnd = new Date(entitlement.trialEndsAt);
    if (now.getTime() > trialEnd.getTime() && options.requireWriteAccess) {
      throw new AppError({
        statusCode: 403,
        errorCode: 'SUB_TRIAL_EXPIRED',
        title: 'Subscription Trial Expired',
        detail: `Tenant trial expired at ${entitlement.trialEndsAt}. Upgrade or record a subscription payment to continue write operations.`,
        extensions: {
          trialEndsAt: entitlement.trialEndsAt,
          status: entitlement.status,
        },
      });
    }
  }

  const blockedStatusesForWrite: readonly TenantLifecycleStatus[] = [
    'SUSPENDED',
    'CANCELLED',
    'PAST_DUE',
    'EXPIRED',
    'READ_ONLY',
  ];
  const blockedStatusesForRead: readonly TenantLifecycleStatus[] = [
    'SUSPENDED',
    'CANCELLED',
  ];

  const isBlocked = options.requireWriteAccess
    ? blockedStatusesForWrite.includes(entitlement.status)
    : blockedStatusesForRead.includes(entitlement.status);

  if (isBlocked) {
    if (
      options.requireWriteAccess &&
      (entitlement.status === 'READ_ONLY' || entitlement.status === 'EXPIRED')
    ) {
      throw new AppError({
        statusCode: 403,
        errorCode: 'SUB_READ_ONLY_MODE',
        title: 'Subscription in Read-Only Mode',
        detail: `Tenant subscription status is "${entitlement.status}". Existing records, analytics, exports, and renewal payments remain available, while write mutations are blocked until renewal.`,
        extensions: { status: entitlement.status, readOnly: true },
      });
    }
    throw new AppError({
      statusCode: 403,
      errorCode: 'SUB_SUBSCRIPTION_INACTIVE',
      title: 'Subscription Inactive or Suspended',
      detail: `Tenant subscription status is "${entitlement.status}" and does not permit this operation.`,
      extensions: { status: entitlement.status },
    });
  }

  if (options.quotaCheck) {
    const { resource, currentActiveCount } = options.quotaCheck;
    const limitMap: Record<SubscriptionQuotaResource, number> = {
      BRANCH: entitlement.limits.maxBranches,
      WAREHOUSE: entitlement.limits.maxWarehouses,
      REGISTER: entitlement.limits.maxRegisters,
      USER: entitlement.limits.maxUsers,
      PRODUCT: entitlement.limits.maxProducts,
      STORAGE_MB: entitlement.limits.maxStorageMb,
    };
    const maxAllowed = limitMap[resource];

    if (currentActiveCount >= maxAllowed) {
      throw new AppError({
        statusCode: 403,
        errorCode: 'SUB_QUOTA_EXCEEDED',
        title: 'Subscription Plan Quota Exceeded',
        detail: `Plan "${entitlement.planCode}" allows at most ${String(maxAllowed)} ${resource.toLowerCase().replace(/_/g, ' ')}(s); current usage is ${String(currentActiveCount)}.`,
        extensions: {
          planCode: entitlement.planCode,
          resource,
          maxAllowed,
          currentActiveCount,
        },
      });
    }
  }

  return entitlement;
}

/**
 * Asserts module entitlement for a tenant.
 *
 * In NexStock V1, HR & Self-Service is hidden from the customer experience and preserved for V2 Premium.
 * A tenant is entitled to access the HRM module if:
 * 1. Global V2 flag is enabled (`NEXSTOCK_ENABLE_V2_HRM=true`), OR
 * 2. Subscription has an active administrative override (`allowAdminOverride = true`), OR
 * 3. Subscription plan includes the feature (`features.hrm = true`).
 *
 * If not entitled, rejects with 403 Forbidden Problem Details (SUB_FEATURE_NOT_ENTITLED).
 */
export async function assertModuleEntitlement(
  trx: TenantTransactionContext,
  module: PlatformModule,
): Promise<SubscriptionEntitlementDto> {
  const entitlement = await getTenantSubscriptionEntitlement(trx);

  if (module === 'HRM') {
    const isV2HrmGloballyEnabled = process.env.NEXSTOCK_ENABLE_V2_HRM === 'true';
    const isEntitled =
      isV2HrmGloballyEnabled ||
      entitlement.allowAdminOverride ||
      Boolean(entitlement.features?.hrm);

    if (!isEntitled) {
      throw new AppError({
        statusCode: 403,
        errorCode: 'SUB_FEATURE_NOT_ENTITLED',
        title: 'Feature Not Entitled',
        detail:
          'The HR & Self-Service module is not included in your NexStock V1 subscription. This module is available as a V2 Premium Add-on.',
        extensions: {
          module: 'HRM',
          version: 'V1',
          planCode: entitlement.planCode,
          upgradeRequired: true,
        },
      });
    }
  }

  return entitlement;
}

/**
 * Enforces plan-level boolean feature entitlement checks (Phase 10.2 Feature Matrix).
 * Bypasses only when `allow_admin_override = true` or `features[featureKey] === true`.
 */
export async function assertFeatureEntitlement(
  trx: TenantTransactionContext,
  featureKey: string,
  detailMessage?: string,
): Promise<SubscriptionEntitlementDto> {
  const entitlement = await getTenantSubscriptionEntitlement(trx);
  if (entitlement.allowAdminOverride || Boolean(entitlement.features?.[featureKey])) {
    return entitlement;
  }

  throw new AppError({
    statusCode: 403,
    errorCode: 'SUB_FEATURE_NOT_ENTITLED',
    title: 'Feature Upgrade Required',
    detail:
      detailMessage ??
      `Feature "${featureKey}" is not included in your current "${entitlement.planName}" plan.`,
    extensions: {
      featureKey,
      planCode: entitlement.planCode,
      upgradeRequired: true,
    },
  });
}

export async function issueSubscriptionInvoice(
  trx: TenantTransactionContext,
  input: {
    readonly invoiceNumber: string;
    readonly currencyCode: string;
    readonly totalAmount: string;
    readonly dueDate: string;
  },
): Promise<SubscriptionInvoiceDto> {
  const entitlement = await getTenantSubscriptionEntitlement(trx);
  const currencyCode = input.currencyCode.trim().toUpperCase();
  const totalMoney = Money.fromDecimalString(input.totalAmount, currencyCode);

  if (!totalMoney.isPositive()) {
    throw new AppError({
      statusCode: 400,
      errorCode: 'ERR_VALIDATION_FAILED',
      title: 'Invalid Invoice Total',
      detail: 'Subscription invoice total amount must be strictly positive.',
    });
  }

  const invoiceId = generateUuidV7();
  const zeroMoney = Money.zero(currencyCode);

  await trx.db
    .insertInto('subscription_invoices')
    .values({
      id: invoiceId,
      tenant_id: trx.tenantId,
      subscription_id: entitlement.subscriptionId,
      invoice_number: input.invoiceNumber,
      currency_code: currencyCode,
      total_amount: totalMoney.toDecimalString(),
      amount_paid: zeroMoney.toDecimalString(),
      status: 'OPEN',
      due_date: input.dueDate,
    })
    .execute();

  await appendAuditLog(trx, {
    action: 'SUB_INVOICE_ISSUED',
    resourceType: 'SUBSCRIPTION_INVOICE',
    resourceId: invoiceId,
    metadata: {
      invoiceNumber: input.invoiceNumber,
      currencyCode,
      totalAmount: totalMoney.toDecimalString(),
    },
  });

  return {
    id: invoiceId,
    tenantId: trx.tenantId,
    subscriptionId: entitlement.subscriptionId,
    invoiceNumber: input.invoiceNumber,
    currencyCode,
    totalAmount: totalMoney.toDecimalString(),
    amountPaid: zeroMoney.toDecimalString(),
    status: 'OPEN',
    dueDate: input.dueDate,
  };
}

/**
 * Default Manual/Admin Subscription Billing Adapter (`UD-05`).
 * Records verified bank transfer / manual receipt payments using fixed-point `Money`
 * and transitions the invoice to `PAID` and the tenant subscription to `ACTIVE` when settled.
 */
export class ManualAdminBillingAdapter implements SubscriptionBillingPort {
  readonly providerCode = 'MANUAL_ADMIN' as const;

  async recordVerifiedPayment(
    trx: TenantTransactionContext,
    input: {
      readonly invoiceId: string;
      readonly currencyCode: string;
      readonly amount: string;
      readonly paymentMethod:
        | 'BANK_TRANSFER'
        | 'MANUAL_RECEIPT'
        | 'CHEQUE'
        | 'EXTERNAL_GATEWAY_REF';
      readonly referenceNumber: string;
    },
  ): Promise<{
    readonly paymentId: string;
    readonly invoice: SubscriptionInvoiceDto;
    readonly subscriptionStatus: TenantLifecycleStatus;
  }> {
    const invoiceRow = await trx.db
      .selectFrom('subscription_invoices')
      .select([
        'id',
        'tenant_id',
        'subscription_id',
        'invoice_number',
        'currency_code',
        'total_amount',
        'amount_paid',
        'status',
        'due_date',
      ])
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', input.invoiceId)
      .executeTakeFirst();

    if (!invoiceRow) {
      throw new AppError({
        statusCode: 404,
        errorCode: 'ERR_NOT_FOUND',
        title: 'Subscription Invoice Not Found',
        detail: `Subscription invoice "${input.invoiceId}" was not found.`,
      });
    }

    const invoiceCurrency = invoiceRow.currency_code.trim().toUpperCase();
    const paymentCurrency = input.currencyCode.trim().toUpperCase();
    if (invoiceCurrency !== paymentCurrency) {
      throw new AppError({
        statusCode: 400,
        errorCode: 'ERR_VALIDATION_FAILED',
        title: 'Invoice Currency Mismatch',
        detail: `Payment currency "${paymentCurrency}" does not match invoice currency "${invoiceCurrency}".`,
      });
    }

    const paymentMoney = Money.fromDecimalString(input.amount, invoiceCurrency);
    if (!paymentMoney.isPositive()) {
      throw new AppError({
        statusCode: 400,
        errorCode: 'ERR_VALIDATION_FAILED',
        title: 'Invalid Payment Amount',
        detail: 'Subscription payment amount must be strictly positive.',
      });
    }

    const totalMoney = Money.fromDecimalString(
      String(invoiceRow.total_amount),
      invoiceCurrency,
    );
    const currentPaidMoney = Money.fromDecimalString(
      String(invoiceRow.amount_paid),
      invoiceCurrency,
    );
    const updatedPaidMoney = currentPaidMoney.add(paymentMoney);

    const paymentId = generateUuidV7();
    await trx.db
      .insertInto('subscription_payments')
      .values({
        id: paymentId,
        tenant_id: trx.tenantId,
        subscription_invoice_id: invoiceRow.id,
        currency_code: invoiceCurrency,
        amount: paymentMoney.toDecimalString(),
        payment_method: input.paymentMethod,
        reference_number: input.referenceNumber,
        recorded_by_user_id: trx.userId,
      })
      .execute();

    const nextInvoiceStatus =
      updatedPaidMoney.compare(totalMoney) >= 0 ? 'PAID' : 'OPEN';

    await trx.db
      .updateTable('subscription_invoices')
      .set({
        amount_paid: updatedPaidMoney.toDecimalString(),
        status: nextInvoiceStatus,
      })
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', invoiceRow.id)
      .execute();

    let subscriptionStatus: TenantLifecycleStatus = 'ACTIVE';
    if (nextInvoiceStatus === 'PAID') {
      const now = new Date();
      const nextPeriodEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
      await trx.db
        .updateTable('tenant_subscriptions')
        .set({
          status: 'ACTIVE',
          current_period_start: now,
          current_period_end: nextPeriodEnd,
          updated_at: now,
        })
        .where('tenant_id', '=', trx.tenantId)
        .where('id', '=', invoiceRow.subscription_id)
        .execute();

      await trx.db
        .updateTable('tenants')
        .set({ status: 'ACTIVE', updated_at: now })
        .where('id', '=', trx.tenantId)
        .execute();
    } else {
      const currentEnt = await getTenantSubscriptionEntitlement(trx);
      subscriptionStatus = currentEnt.status;
    }

    await appendAuditLog(trx, {
      action: 'SUB_PAYMENT_RECORDED',
      resourceType: 'SUBSCRIPTION_PAYMENT',
      resourceId: paymentId,
      metadata: {
        invoiceId: invoiceRow.id,
        amount: paymentMoney.toDecimalString(),
        currencyCode: invoiceCurrency,
        paymentMethod: input.paymentMethod,
        referenceNumber: input.referenceNumber,
        nextInvoiceStatus,
      },
    });

    await enqueueOutboxEvent(trx, {
      aggregateType: 'SUBSCRIPTION_INVOICE',
      aggregateId: invoiceRow.id,
      eventType: 'SUBSCRIPTION_PAYMENT_RECORDED',
      payload: {
        paymentId,
        invoiceId: invoiceRow.id,
        nextInvoiceStatus,
        subscriptionStatus,
      },
    });

    const dueDateStr =
      invoiceRow.due_date instanceof Date
        ? invoiceRow.due_date.toISOString().slice(0, 10)
        : String(invoiceRow.due_date).slice(0, 10);

    return {
      paymentId,
      invoice: {
        id: invoiceRow.id,
        tenantId: invoiceRow.tenant_id,
        subscriptionId: invoiceRow.subscription_id,
        invoiceNumber: invoiceRow.invoice_number,
        currencyCode: invoiceCurrency,
        totalAmount: totalMoney.toDecimalString(),
        amountPaid: updatedPaidMoney.toDecimalString(),
        status: nextInvoiceStatus,
        dueDate: dueDateStr,
      },
      subscriptionStatus,
    };
  }
}

export const defaultManualBillingAdapter = new ManualAdminBillingAdapter();

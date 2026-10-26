import { Money } from '@nexstock/domain-core';
import {
  AppError,
  type TenantLifecycleStatus,
  type TenantTransactionContext,
  appendAuditLog,
  enqueueOutboxEvent,
  generateUuidV7,
} from '../../shared/index.js';

export type SubscriptionPlanCode = 'STARTER' | 'GROWTH' | 'ENTERPRISE';
export type SubscriptionQuotaResource =
  | 'BRANCH'
  | 'WAREHOUSE'
  | 'REGISTER'
  | 'USER';

export interface SubscriptionEntitlementDto {
  readonly subscriptionId: string;
  readonly tenantId: string;
  readonly planId: string;
  readonly planCode: string;
  readonly planName: string;
  readonly status: TenantLifecycleStatus;
  readonly billingMode: 'ADMIN_PROVISIONED' | 'EXTERNAL_PROVIDER';
  readonly providerCode: 'MANUAL_ADMIN' | 'PAYHERE_LK' | 'STRIPE' | 'PADDLE';
  readonly trialEndsAt: string | null;
  readonly currentPeriodStart: string;
  readonly currentPeriodEnd: string;
  readonly allowAdminOverride: boolean;
  readonly overrideReason: string | null;
  readonly limits: {
    readonly maxBranches: number;
    readonly maxWarehouses: number;
    readonly maxRegisters: number;
    readonly maxUsers: number;
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
      'max_branches',
      'max_warehouses',
      'max_registers',
      'max_users',
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
  const trialDays = input.trialDays ?? 14;
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

  if (existing) {
    await trx.db
      .updateTable('tenant_subscriptions')
      .set({
        plan_id: plan.id,
        status,
        trial_ends_at: trialEndsAt,
        current_period_start: now,
        current_period_end: currentPeriodEnd,
        updated_at: now,
      })
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', subscriptionId)
      .execute();
  } else {
    await trx.db
      .insertInto('tenant_subscriptions')
      .values({
        id: subscriptionId,
        tenant_id: trx.tenantId,
        plan_id: plan.id,
        billing_mode: 'ADMIN_PROVISIONED',
        provider_code: 'MANUAL_ADMIN',
        status,
        trial_ends_at: trialEndsAt,
        current_period_start: now,
        current_period_end: currentPeriodEnd,
        allow_admin_override: false,
        override_reason: null,
      })
      .execute();
  }

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

  return {
    subscriptionId,
    tenantId: trx.tenantId,
    planId: plan.id,
    planCode: plan.code,
    planName: plan.name,
    status,
    billingMode: 'ADMIN_PROVISIONED',
    providerCode: 'MANUAL_ADMIN',
    trialEndsAt: trialEndsAt ? trialEndsAt.toISOString() : null,
    currentPeriodStart: now.toISOString(),
    currentPeriodEnd: currentPeriodEnd.toISOString(),
    allowAdminOverride: false,
    overrideReason: null,
    limits: {
      maxBranches: plan.max_branches,
      maxWarehouses: plan.max_warehouses,
      maxRegisters: plan.max_registers,
      maxUsers: plan.max_users,
    },
  };
}

export async function getTenantSubscriptionEntitlement(
  trx: TenantTransactionContext,
): Promise<SubscriptionEntitlementDto> {
  const row = await trx.db
    .selectFrom('tenant_subscriptions')
    .innerJoin(
      'subscription_plans',
      'subscription_plans.id',
      'tenant_subscriptions.plan_id',
    )
    .select([
      'tenant_subscriptions.id as subscription_id',
      'tenant_subscriptions.tenant_id as tenant_id',
      'tenant_subscriptions.plan_id as plan_id',
      'tenant_subscriptions.billing_mode as billing_mode',
      'tenant_subscriptions.provider_code as provider_code',
      'tenant_subscriptions.status as status',
      'tenant_subscriptions.trial_ends_at as trial_ends_at',
      'tenant_subscriptions.current_period_start as current_period_start',
      'tenant_subscriptions.current_period_end as current_period_end',
      'tenant_subscriptions.allow_admin_override as allow_admin_override',
      'tenant_subscriptions.override_reason as override_reason',
      'subscription_plans.code as plan_code',
      'subscription_plans.name as plan_name',
      'subscription_plans.max_branches as max_branches',
      'subscription_plans.max_warehouses as max_warehouses',
      'subscription_plans.max_registers as max_registers',
      'subscription_plans.max_users as max_users',
    ])
    .where('tenant_subscriptions.tenant_id', '=', trx.tenantId)
    .executeTakeFirst();

  if (!row) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'ERR_NOT_FOUND',
      title: 'Tenant Subscription Not Found',
      detail: `No subscription record found for tenant "${trx.tenantId}".`,
    });
  }

  return {
    subscriptionId: row.subscription_id,
    tenantId: row.tenant_id,
    planId: row.plan_id,
    planCode: row.plan_code,
    planName: row.plan_name,
    status: row.status,
    billingMode: row.billing_mode,
    providerCode: row.provider_code,
    trialEndsAt: row.trial_ends_at
      ? new Date(row.trial_ends_at).toISOString()
      : null,
    currentPeriodStart: new Date(row.current_period_start).toISOString(),
    currentPeriodEnd: new Date(row.current_period_end).toISOString(),
    allowAdminOverride: row.allow_admin_override,
    overrideReason: row.override_reason,
    limits: {
      maxBranches: row.max_branches,
      maxWarehouses: row.max_warehouses,
      maxRegisters: row.max_registers,
      maxUsers: row.max_users,
    },
  };
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
  const nextAllowOverride =
    input.allowAdminOverride ?? current.allowAdminOverride;
  const nextOverrideReason =
    input.overrideReason !== undefined
      ? input.overrideReason
      : current.overrideReason;
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
  ];
  const blockedStatusesForRead: readonly TenantLifecycleStatus[] = [
    'SUSPENDED',
    'CANCELLED',
  ];

  const isBlocked = options.requireWriteAccess
    ? blockedStatusesForWrite.includes(entitlement.status)
    : blockedStatusesForRead.includes(entitlement.status);

  if (isBlocked) {
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
    };
    const maxAllowed = limitMap[resource];

    if (currentActiveCount >= maxAllowed) {
      throw new AppError({
        statusCode: 403,
        errorCode: 'SUB_QUOTA_EXCEEDED',
        title: 'Subscription Plan Quota Exceeded',
        detail: `Plan "${entitlement.planCode}" allows at most ${String(maxAllowed)} ${resource.toLowerCase()}(s); current active count is ${String(currentActiveCount)}.`,
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

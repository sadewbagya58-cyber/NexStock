import type {
  CalculateSubscriptionPricingRequest,
  OnlineGatewayCheckoutRequest,
  OnlineGatewayWebhookRequest,
  PaymentSubmissionStatus,
  PurchaseBranchAddonRequest,
  ScheduleDowngradeRequest,
  StartFreeTrialRequest,
  SubmitManualBankTransferRequest,
  SubscriptionBankSettingsResponse,
  SubscriptionBillingCycle,
  SubscriptionNotificationResponse,
  SubscriptionNotificationSeverity,
  SubscriptionPaymentSubmissionResponse,
  SubscriptionPlanCatalogItem,
  SubscriptionPricingQuoteResponse,
  SubscriptionUsageSummary,
  UpdatePlatformBankSettingsRequest,
  UpdatePlatformPlanConfigRequest,
  UpgradeCheckoutRequest,
  VerifyPaymentSubmissionRequest,
} from '@nexstock/contracts';
import { Money } from '@nexstock/domain-core';
import { type Transaction, sql } from 'kysely';
import {
  AppError,
  type NexStockDatabase,
  type TenantTransactionContext,
  appendAuditLog,
  enqueueOutboxEvent,
  generateUuidV7,
} from '../../shared/index.js';
import {
  PLAN_RANK_ORDER,
  assertValidLifecycleTransition,
  calculateSubscriptionQuote,
  mergePlanAndCustomFeatures,
} from '../domain/entitlement-matrix.js';
import {
  type OnlineGatewayProviderCode,
  getOnlineGatewayAdapter,
} from '../domain/payment-gateway.port.js';
import { getTenantSubscriptionEntitlement } from './sub.service.js';

const MAX_PROOF_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB

function detectAndValidateProofBytes(buffer: Buffer, mimeType: string): boolean {
  if (buffer.length < 4 || buffer.length > MAX_PROOF_SIZE_BYTES) {
    return false;
  }
  const mime = mimeType.toLowerCase().trim();
  if (mime === 'application/pdf') {
    return buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46; // %PDF
  }
  if (buffer.length < 12) return false;
  if (mime === 'image/jpeg' || mime === 'image/jpg') {
    return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }
  if (mime === 'image/png') {
    return (
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47
    );
  }
  if (mime === 'image/webp') {
    return (
      buffer[0] === 0x52 &&
      buffer[1] === 0x49 &&
      buffer[2] === 0x46 &&
      buffer[3] === 0x46 &&
      buffer[8] === 0x57 &&
      buffer[9] === 0x45 &&
      buffer[10] === 0x42 &&
      buffer[11] === 0x50
    );
  }
  return false;
}

function mapPlanCatalogItem(row: {
  id: string;
  code: string;
  name: string;
  description: string;
  display_order: number;
  is_public: boolean;
  is_custom_pricing: boolean;
  max_branches: number;
  max_warehouses: number;
  max_registers: number;
  max_users: number;
  max_products: number;
  max_storage_mb: number;
  monthly_price_amount: string;
  annual_discount_pct: string;
  additional_branch_monthly_fee: string | null;
  currency_code: string;
  trial_days: number;
  support_level: string;
  features_json: unknown;
  version: number;
}): SubscriptionPlanCatalogItem {
  const quoteAnnual = calculateSubscriptionQuote({
    planCode: row.code,
    planName: row.name,
    currencyCode: row.currency_code,
    isCustomPricing: row.is_custom_pricing,
    monthlyPriceAmount: row.monthly_price_amount,
    annualDiscountPct: row.annual_discount_pct,
    additionalBranchMonthlyFee: row.additional_branch_monthly_fee,
    billingCycle: 'ANNUAL',
  });

  const annualTotalMoney = Money.fromDecimalString(
    quoteAnnual.planCycleNetAmount,
    row.currency_code,
  );
  const effectiveMonthlyMicro = annualTotalMoney.toMinorUnits() / 12n;
  const effectiveMonthlyStr = Money.fromMinorUnits(
    effectiveMonthlyMicro,
    row.currency_code,
  ).toDecimalString();

  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    displayOrder: row.display_order,
    isPublic: row.is_public,
    isCustomPricing: row.is_custom_pricing,
    currencyCode: row.currency_code,
    monthlyPriceAmount: Money.fromDecimalString(
      row.monthly_price_amount,
      row.currency_code,
    ).toDecimalString(),
    annualDiscountPct: String(row.annual_discount_pct),
    annualTotalAmount: quoteAnnual.planCycleNetAmount,
    annualMonthlyEquivalent: effectiveMonthlyStr,
    annualSavingsAmount: quoteAnnual.annualDiscountAmount,
    additionalBranchMonthlyFee: row.additional_branch_monthly_fee
      ? Money.fromDecimalString(
          row.additional_branch_monthly_fee,
          row.currency_code,
        ).toDecimalString()
      : null,
    trialDays: row.trial_days,
    supportLevel: row.support_level,
    limits: {
      maxBranches: row.max_branches,
      maxWarehouses: row.max_warehouses,
      maxRegisters: row.max_registers,
      maxUsers: row.max_users,
      maxProducts: row.max_products,
      maxStorageMb: row.max_storage_mb,
    },
    features: mergePlanAndCustomFeatures({
      planCode: row.code,
      rawPlanFeaturesJson: row.features_json,
    }),
    version: row.version,
  };
}

export async function listSubscriptionPlans(
  db: Transaction<NexStockDatabase>,
  includeHidden = false,
): Promise<SubscriptionPlanCatalogItem[]> {
  let q = db
    .selectFrom('subscription_plans')
    .selectAll()
    .where('is_active', '=', true);

  if (!includeHidden) {
    q = q.where('is_public', '=', true);
  }

  const rows = await q.orderBy('display_order', 'asc').execute();
  return rows.map(mapPlanCatalogItem);
}

export async function calculateServerSubscriptionPricing(
  db: Transaction<NexStockDatabase>,
  input: CalculateSubscriptionPricingRequest,
): Promise<SubscriptionPricingQuoteResponse> {
  const plan = await db
    .selectFrom('subscription_plans')
    .selectAll()
    .where('code', '=', input.planCode)
    .where('is_active', '=', true)
    .executeTakeFirst();

  if (!plan) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'ERR_NOT_FOUND',
      title: 'Subscription Plan Not Found',
      detail: `Plan "${input.planCode}" was not found.`,
    });
  }

  return calculateSubscriptionQuote({
    planCode: plan.code,
    planName: plan.name,
    currencyCode: plan.currency_code,
    isCustomPricing: plan.is_custom_pricing,
    monthlyPriceAmount: plan.monthly_price_amount,
    annualDiscountPct: String(plan.annual_discount_pct),
    additionalBranchMonthlyFee: plan.additional_branch_monthly_fee,
    billingCycle: input.billingCycle,
    additionalBranchCount: input.additionalBranchCount,
    prorateBranchDaysRemaining: input.prorateBranchDaysRemaining,
    prorateCycleTotalDays: input.prorateCycleTotalDays,
    customMonthlyPriceOverride: input.customMonthlyPrice,
  });
}

export async function calculateTenantStorageUsageBytes(
  trx: TenantTransactionContext,
): Promise<number> {
  const [prodImgSum, empDocSum, expAttachSum] = await Promise.all([
    trx.db
      .selectFrom('product_media_assets')
      .select(sql<string>`COALESCE(SUM(file_size), 0)`.as('total_bytes'))
      .where('tenant_id', '=', trx.tenantId)
      .executeTakeFirst(),
    trx.db
      .selectFrom('employee_documents')
      .select(sql<string>`COALESCE(SUM(file_size), 0)`.as('total_bytes'))
      .where('tenant_id', '=', trx.tenantId)
      .executeTakeFirst(),
    trx.db
      .selectFrom('expense_attachments')
      .select(sql<string>`COALESCE(SUM(file_size_bytes), 0)`.as('total_bytes'))
      .where('tenant_id', '=', trx.tenantId)
      .executeTakeFirst(),
  ]);

  const b1 = Number.parseInt(String(prodImgSum?.total_bytes ?? '0'), 10) || 0;
  const b2 = Number.parseInt(String(empDocSum?.total_bytes ?? '0'), 10) || 0;
  const b3 = Number.parseInt(String(expAttachSum?.total_bytes ?? '0'), 10) || 0;
  return b1 + b2 + b3;
}

export async function getTenantSubscriptionUsage(
  trx: TenantTransactionContext,
  now = new Date(),
): Promise<SubscriptionUsageSummary> {
  const ent = await getTenantSubscriptionEntitlement(trx);

  const [branchRows, memberRows, productRows, usedStorageBytes] =
    await Promise.all([
      trx.db
        .selectFrom('branches')
        .select(['id'])
        .where('tenant_id', '=', trx.tenantId)
        .where('is_active', '=', true)
        .execute(),
      trx.db
        .selectFrom('tenant_memberships')
        .select(['user_id'])
        .where('tenant_id', '=', trx.tenantId)
        .where('status', '=', 'ACTIVE')
        .execute(),
      trx.db
        .selectFrom('products')
        .select(['id'])
        .where('tenant_id', '=', trx.tenantId)
        .where('status', '!=', 'ARCHIVED')
        .execute(),
      calculateTenantStorageUsageBytes(trx),
    ]);

  // Distinct user_id across all branches
  const distinctUsers = new Set(memberRows.map((m) => m.user_id)).size;

  const dayMs = 86_400_000;
  const trialDaysRemaining =
    ent.trialEndsAt && ent.status === 'TRIALING'
      ? Math.max(0, Math.ceil((Date.parse(ent.trialEndsAt) - now.getTime()) / dayMs))
      : 0;
  const graceDaysRemaining =
    ent.gracePeriodEndsAt && ent.status === 'GRACE_PERIOD'
      ? Math.max(
          0,
          Math.ceil((Date.parse(ent.gracePeriodEndsAt) - now.getTime()) / dayMs),
        )
      : 0;

  return {
    tenantId: trx.tenantId,
    planCode: ent.planCode,
    planName: ent.planName,
    status: ent.status,
    billingCycle: ent.billingCycle,
    includedBranches: ent.limits.includedBranches,
    additionalBranchSlots: ent.additionalBranchSlots,
    effectiveMaxBranches: ent.limits.maxBranches,
    activeBranchesCount: branchRows.length,
    maxUsers: ent.limits.maxUsers,
    distinctActiveUsersCount: distinctUsers,
    maxProducts: ent.limits.maxProducts,
    distinctProductsCount: productRows.length,
    maxStorageMb: ent.limits.maxStorageMb,
    usedStorageBytes,
    usedStorageMb: (usedStorageBytes / (1024 * 1024)).toFixed(2),
    trialStartedAt: ent.trialStartedAt,
    trialEndsAt: ent.trialEndsAt,
    trialDaysRemaining,
    gracePeriodEndsAt: ent.gracePeriodEndsAt,
    graceDaysRemaining,
    scheduledDowngradePlanCode: ent.scheduledDowngradePlanCode,
    scheduledDowngradeBillingCycle: ent.scheduledDowngradeBillingCycle,
    scheduledDowngradeEffectiveAt: ent.scheduledDowngradeEffectiveAt,
  };
}

export async function startTenantFreeTrial(
  trx: TenantTransactionContext,
  input: StartFreeTrialRequest,
) {
  const ent = await getTenantSubscriptionEntitlement(trx);

  const priorTrial = await trx.db
    .selectFrom('subscription_plan_history')
    .select(['id'])
    .where('tenant_id', '=', trx.tenantId)
    .where('change_type', '=', 'TRIAL_STARTED')
    .executeTakeFirst();

  if (ent.trialStartedAt || priorTrial) {
    throw new AppError({
      statusCode: 409,
      errorCode: 'SUB_TRIAL_ALREADY_USED',
      title: 'Free Trial Already Used',
      detail: 'This business organization has already used its free trial.',
    });
  }

  const targetCode = input.planCode ?? 'STARTER';
  const plan = await trx.db
    .selectFrom('subscription_plans')
    .select(['id', 'code', 'trial_days'])
    .where('code', '=', targetCode)
    .where('is_active', '=', true)
    .executeTakeFirstOrThrow();

  const now = new Date();
  const trialDays = plan.trial_days || 30;
  const trialEndsAt = new Date(now.getTime() + trialDays * 86_400_000);

  await trx.db
    .updateTable('tenant_subscriptions')
    .set({
      plan_id: plan.id,
      status: 'TRIALING',
      trial_started_at: now,
      trial_ends_at: trialEndsAt,
      current_period_start: now,
      current_period_end: trialEndsAt,
      updated_at: now,
    })
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', ent.subscriptionId)
    .execute();

  await trx.db
    .updateTable('tenants')
    .set({ status: 'TRIALING', updated_at: now })
    .where('id', '=', trx.tenantId)
    .execute();

  await trx.db
    .insertInto('subscription_plan_history')
    .values({
      id: generateUuidV7(),
      tenant_id: trx.tenantId,
      subscription_id: ent.subscriptionId,
      change_type: 'TRIAL_STARTED',
      from_plan_id: ent.planId,
      to_plan_id: plan.id,
      from_status: ent.status,
      to_status: 'TRIALING',
      billing_cycle: 'MONTHLY',
      effective_at: now,
      actor_user_id: trx.userId,
      notes: `${trialDays}-day free trial started`,
      metadata_json: JSON.stringify({ planCode: plan.code, trialDays }),
    })
    .execute();

  trx._trxCache?.delete(`subEntitlement:${trx.tenantId}`);
  return getTenantSubscriptionEntitlement(trx);
}

function generateSubInvoiceNumber(): string {
  const d = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const rand = Math.random().toString(36).slice(2, 7).toUpperCase();
  return `SUB-${d}-${rand}`;
}

/**
 * Initiates a server-calculated upgrade or trial conversion checkout invoice.
 * CRITICAL: Never upgrades plan or activates paid subscription until payment is verified!
 */
export async function createSubscriptionCheckoutInvoice(
  trx: TenantTransactionContext,
  input: UpgradeCheckoutRequest,
) {
  const ent = await getTenantSubscriptionEntitlement(trx);
  const targetPlan = await trx.db
    .selectFrom('subscription_plans')
    .selectAll()
    .where('code', '=', input.targetPlanCode)
    .where('is_active', '=', true)
    .executeTakeFirst();

  if (!targetPlan) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'ERR_NOT_FOUND',
      title: 'Target Plan Not Found',
      detail: `Subscription plan "${input.targetPlanCode}" was not found.`,
    });
  }

  const subRow = await trx.db
    .selectFrom('tenant_subscriptions')
    .select(['custom_monthly_price', 'additional_branch_slots'])
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', ent.subscriptionId)
    .executeTakeFirst();

  if (targetPlan.is_custom_pricing && !subRow?.custom_monthly_price) {
    throw new AppError({
      statusCode: 422,
      errorCode: 'ERR_VALIDATION_FAILED',
      title: 'Custom Enterprise Quote Required',
      detail:
        'Enterprise plans require custom commercial pricing configured by Platform Administration.',
    });
  }

  const branchAddonQty =
    input.additionalBranchCount ?? subRow?.additional_branch_slots ?? 0;

  const quote = calculateSubscriptionQuote({
    planCode: targetPlan.code,
    planName: targetPlan.name,
    currencyCode: targetPlan.currency_code,
    isCustomPricing: targetPlan.is_custom_pricing,
    monthlyPriceAmount: targetPlan.monthly_price_amount,
    annualDiscountPct: String(targetPlan.annual_discount_pct),
    additionalBranchMonthlyFee: targetPlan.additional_branch_monthly_fee,
    billingCycle: input.billingCycle,
    additionalBranchCount: branchAddonQty,
    customMonthlyPriceOverride: subRow?.custom_monthly_price ?? null,
  });

  const now = new Date();
  const dueDate = new Date(now.getTime() + 7 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const invoiceId = generateUuidV7();
  const invoiceNumber = generateSubInvoiceNumber();
  const invoiceType =
    ent.status === 'TRIALING'
      ? 'TRIAL_CONVERSION'
      : (PLAN_RANK_ORDER[targetPlan.code] ?? 0) >
          (PLAN_RANK_ORDER[ent.planCode] ?? 0)
        ? 'UPGRADE'
        : 'PLAN_SUBSCRIPTION';

  await trx.db
    .insertInto('subscription_invoices')
    .values({
      id: invoiceId,
      tenant_id: trx.tenantId,
      subscription_id: ent.subscriptionId,
      invoice_number: invoiceNumber,
      currency_code: quote.currencyCode,
      billing_cycle: input.billingCycle,
      invoice_type: invoiceType,
      target_plan_id: targetPlan.id,
      target_billing_cycle: input.billingCycle,
      branch_addon_qty: branchAddonQty,
      plan_amount: quote.planCycleGrossAmount,
      discount_amount: quote.annualDiscountAmount,
      addon_amount: quote.additionalBranchCycleAmount,
      proration_amount: quote.proratedAdditionalBranchAmount,
      notes: input.notes ?? null,
      total_amount: quote.totalDueNow,
      amount_paid: Money.zero(quote.currencyCode).toDecimalString(),
      status: 'OPEN',
      due_date: dueDate,
      paid_at: null,
    })
    .execute();

  await appendAuditLog(trx, {
    action: 'SUB_CHECKOUT_INVOICE_CREATED',
    resourceType: 'SUBSCRIPTION_INVOICE',
    resourceId: invoiceId,
    metadata: {
      invoiceNumber,
      invoiceType,
      targetPlanCode: targetPlan.code,
      billingCycle: input.billingCycle,
      totalAmount: quote.totalDueNow,
    },
  });

  return {
    invoice: {
      id: invoiceId,
      tenantId: trx.tenantId,
      subscriptionId: ent.subscriptionId,
      invoiceNumber,
      invoiceType,
      targetPlanCode: targetPlan.code,
      targetPlanName: targetPlan.name,
      billingCycle: input.billingCycle,
      currencyCode: quote.currencyCode,
      totalAmount: quote.totalDueNow,
      status: 'OPEN' as const,
      dueDate,
    },
    quote,
  };
}

/**
 * Schedules a downgrade to take effect at the next billing renewal date.
 * Preserves existing data, audit history, and current access until period end.
 */
export async function scheduleSubscriptionDowngrade(
  trx: TenantTransactionContext,
  input: ScheduleDowngradeRequest,
) {
  const ent = await getTenantSubscriptionEntitlement(trx);
  const targetPlan = await trx.db
    .selectFrom('subscription_plans')
    .select(['id', 'code', 'name'])
    .where('code', '=', input.targetPlanCode)
    .where('is_active', '=', true)
    .executeTakeFirst();

  if (!targetPlan) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'ERR_NOT_FOUND',
      title: 'Target Plan Not Found',
      detail: `Plan "${input.targetPlanCode}" not found.`,
    });
  }

  const currentRank = PLAN_RANK_ORDER[ent.planCode] ?? 2;
  const targetRank = PLAN_RANK_ORDER[targetPlan.code] ?? 1;
  if (targetRank >= currentRank && targetPlan.code !== ent.planCode) {
    throw new AppError({
      statusCode: 422,
      errorCode: 'ERR_VALIDATION_FAILED',
      title: 'Use Upgrade Checkout For Higher Tiers',
      detail: `"${targetPlan.name}" is higher tier than "${ent.planName}". Use upgrade checkout instead.`,
    });
  }

  const effectiveAt = new Date(ent.currentPeriodEnd);
  const targetCycle = input.billingCycle ?? ent.billingCycle;

  await trx.db
    .updateTable('tenant_subscriptions')
    .set({
      scheduled_plan_id: targetPlan.id,
      scheduled_billing_cycle: targetCycle,
      scheduled_change_effective_at: effectiveAt,
      updated_at: new Date(),
    })
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', ent.subscriptionId)
    .execute();

  await trx.db
    .insertInto('subscription_plan_history')
    .values({
      id: generateUuidV7(),
      tenant_id: trx.tenantId,
      subscription_id: ent.subscriptionId,
      change_type: 'DOWNGRADE_SCHEDULED',
      from_plan_id: ent.planId,
      to_plan_id: targetPlan.id,
      from_status: ent.status,
      to_status: ent.status,
      billing_cycle: targetCycle,
      effective_at: effectiveAt,
      actor_user_id: trx.userId,
      notes: input.reason ?? `Scheduled downgrade to ${targetPlan.name}`,
      metadata_json: JSON.stringify({ targetPlanCode: targetPlan.code }),
    })
    .execute();

  await appendAuditLog(trx, {
    action: 'SUB_DOWNGRADE_SCHEDULED',
    resourceType: 'TENANT_SUBSCRIPTION',
    resourceId: ent.subscriptionId,
    metadata: {
      fromPlan: ent.planCode,
      toPlan: targetPlan.code,
      effectiveAt: effectiveAt.toISOString(),
    },
  });

  trx._trxCache?.delete(`subEntitlement:${trx.tenantId}`);
  return getTenantSubscriptionEntitlement(trx);
}

export async function cancelScheduledSubscriptionDowngrade(
  trx: TenantTransactionContext,
) {
  const ent = await getTenantSubscriptionEntitlement(trx);
  if (!ent.scheduledDowngradePlanCode) {
    throw new AppError({
      statusCode: 409,
      errorCode: 'ERR_CONFLICT',
      title: 'No Scheduled Downgrade',
      detail: 'There is no pending scheduled downgrade to cancel.',
    });
  }

  await trx.db
    .updateTable('tenant_subscriptions')
    .set({
      scheduled_plan_id: null,
      scheduled_billing_cycle: null,
      scheduled_change_effective_at: null,
      updated_at: new Date(),
    })
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', ent.subscriptionId)
    .execute();

  await trx.db
    .insertInto('subscription_plan_history')
    .values({
      id: generateUuidV7(),
      tenant_id: trx.tenantId,
      subscription_id: ent.subscriptionId,
      change_type: 'DOWNGRADE_CANCELLED',
      from_plan_id: ent.planId,
      to_plan_id: ent.planId,
      from_status: ent.status,
      to_status: ent.status,
      billing_cycle: ent.billingCycle,
      effective_at: new Date(),
      actor_user_id: trx.userId,
      notes: `Cancelled scheduled downgrade to ${ent.scheduledDowngradePlanCode}`,
      metadata_json: JSON.stringify({
        cancelledTargetPlanCode: ent.scheduledDowngradePlanCode,
      }),
    })
    .execute();

  trx._trxCache?.delete(`subEntitlement:${trx.tenantId}`);
  return getTenantSubscriptionEntitlement(trx);
}

/**
 * Purchases prorated additional branch capacity for remaining days of current cycle.
 * Respects existing feature matrix (does NOT unlock higher-tier features).
 */
export async function createBranchAddonCheckout(
  trx: TenantTransactionContext,
  input: PurchaseBranchAddonRequest,
  now = new Date(),
) {
  const ent = await getTenantSubscriptionEntitlement(trx);
  const plan = await trx.db
    .selectFrom('subscription_plans')
    .selectAll()
    .where('id', '=', ent.planId)
    .executeTakeFirstOrThrow();

  if (plan.additional_branch_monthly_fee === null) {
    throw new AppError({
      statusCode: 422,
      errorCode: 'ERR_VALIDATION_FAILED',
      title: 'Custom Branch Add-On Required',
      detail: `Plan "${plan.name}" uses custom branch add-on pricing. Contact Platform Administration.`,
    });
  }

  const periodStart = new Date(ent.currentPeriodStart);
  const periodEnd = new Date(ent.currentPeriodEnd);
  const totalDays = Math.max(
    1,
    Math.ceil((periodEnd.getTime() - periodStart.getTime()) / 86_400_000),
  );
  const remainingDays = Math.max(
    1,
    Math.min(
      totalDays,
      Math.ceil((periodEnd.getTime() - now.getTime()) / 86_400_000),
    ),
  );

  const cycleMonths = ent.billingCycle === 'ANNUAL' ? 12n : 1n;
  const extraMonthly = Money.fromDecimalString(
    plan.additional_branch_monthly_fee,
    plan.currency_code,
  );
  const fullCycleMicro =
    extraMonthly.toMinorUnits() * BigInt(input.additionalBranches) * cycleMonths;
  const proratedMicro =
    (fullCycleMicro * BigInt(remainingDays) + BigInt(totalDays) / 2n) /
    BigInt(totalDays);
  const proratedStr = Money.fromMinorUnits(
    proratedMicro,
    plan.currency_code,
  ).toDecimalString();

  const invoiceId = generateUuidV7();
  const invoiceNumber = generateSubInvoiceNumber();
  const addonId = generateUuidV7();
  const dueDate = new Date(now.getTime() + 7 * 86_400_000)
    .toISOString()
    .slice(0, 10);

  await trx.db
    .insertInto('subscription_invoices')
    .values({
      id: invoiceId,
      tenant_id: trx.tenantId,
      subscription_id: ent.subscriptionId,
      invoice_number: invoiceNumber,
      currency_code: plan.currency_code,
      billing_cycle: ent.billingCycle,
      invoice_type: 'BRANCH_ADDON',
      target_plan_id: plan.id,
      target_billing_cycle: ent.billingCycle,
      branch_addon_qty: input.additionalBranches,
      plan_amount: Money.zero(plan.currency_code).toDecimalString(),
      discount_amount: Money.zero(plan.currency_code).toDecimalString(),
      addon_amount: Money.fromMinorUnits(
        fullCycleMicro,
        plan.currency_code,
      ).toDecimalString(),
      proration_amount: proratedStr,
      notes: input.notes ?? `${input.additionalBranches} additional branch slot(s) (${remainingDays}/${totalDays} days prorated)`,
      total_amount: proratedStr,
      amount_paid: Money.zero(plan.currency_code).toDecimalString(),
      status: 'OPEN',
      due_date: dueDate,
      paid_at: null,
    })
    .execute();

  await trx.db
    .insertInto('subscription_branch_addons')
    .values({
      id: addonId,
      tenant_id: trx.tenantId,
      subscription_id: ent.subscriptionId,
      invoice_id: invoiceId,
      quantity: input.additionalBranches,
      unit_monthly_price: extraMonthly.toDecimalString(),
      prorated_amount: proratedStr,
      currency_code: plan.currency_code,
      billing_cycle: ent.billingCycle,
      period_start: now,
      period_end: periodEnd,
      status: 'PENDING_PAYMENT',
    })
    .execute();

  return {
    addonId,
    invoiceId,
    invoiceNumber,
    quantity: input.additionalBranches,
    unitMonthlyFee: extraMonthly.toDecimalString(),
    proratedAmountDue: proratedStr,
    remainingDays,
    totalCycleDays: totalDays,
    currencyCode: plan.currency_code,
  };
}

export async function createRenewalInvoice(
  trx: TenantTransactionContext,
  billingCycleOverride?: SubscriptionBillingCycle,
) {
  const ent = await getTenantSubscriptionEntitlement(trx);
  const subRow = await trx.db
    .selectFrom('tenant_subscriptions')
    .select([
      'plan_id',
      'scheduled_plan_id',
      'scheduled_billing_cycle',
      'additional_branch_slots',
      'custom_monthly_price',
    ])
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', ent.subscriptionId)
    .executeTakeFirstOrThrow();

  const planIdToRenew = subRow.scheduled_plan_id ?? subRow.plan_id;
  const plan = await trx.db
    .selectFrom('subscription_plans')
    .selectAll()
    .where('id', '=', planIdToRenew)
    .executeTakeFirstOrThrow();

  const effectiveCycle =
    billingCycleOverride ?? subRow.scheduled_billing_cycle ?? ent.billingCycle;

  const quote = calculateSubscriptionQuote({
    planCode: plan.code,
    planName: plan.name,
    currencyCode: plan.currency_code,
    isCustomPricing: plan.is_custom_pricing,
    monthlyPriceAmount: plan.monthly_price_amount,
    annualDiscountPct: String(plan.annual_discount_pct),
    additionalBranchMonthlyFee: plan.additional_branch_monthly_fee,
    billingCycle: effectiveCycle,
    additionalBranchCount: subRow.additional_branch_slots,
    customMonthlyPriceOverride: subRow.custom_monthly_price,
  });

  const now = new Date();
  const invoiceId = generateUuidV7();
  const invoiceNumber = generateSubInvoiceNumber();
  const dueDate = new Date(
    Math.max(now.getTime(), new Date(ent.currentPeriodEnd).getTime()),
  )
    .toISOString()
    .slice(0, 10);

  await trx.db
    .insertInto('subscription_invoices')
    .values({
      id: invoiceId,
      tenant_id: trx.tenantId,
      subscription_id: ent.subscriptionId,
      invoice_number: invoiceNumber,
      currency_code: quote.currencyCode,
      billing_cycle: effectiveCycle,
      invoice_type: 'RENEWAL',
      target_plan_id: plan.id,
      target_billing_cycle: effectiveCycle,
      branch_addon_qty: subRow.additional_branch_slots,
      plan_amount: quote.planCycleGrossAmount,
      discount_amount: quote.annualDiscountAmount,
      addon_amount: quote.additionalBranchCycleAmount,
      proration_amount: Money.zero(quote.currencyCode).toDecimalString(),
      notes: subRow.scheduled_plan_id
        ? `Renewal with scheduled transition to ${plan.name}`
        : `Subscription renewal (${plan.name})`,
      total_amount: quote.recurringNextCycleTotal,
      amount_paid: Money.zero(quote.currencyCode).toDecimalString(),
      status: 'OPEN',
      due_date: dueDate,
      paid_at: null,
    })
    .execute();

  return {
    invoiceId,
    invoiceNumber,
    planCode: plan.code,
    billingCycle: effectiveCycle,
    totalDue: quote.recurringNextCycleTotal,
    currencyCode: quote.currencyCode,
    dueDate,
  };
}

/**
 * Advances expired trials/periods into RENEWAL_DUE -> GRACE_PERIOD (7 days) -> READ_ONLY readiness.
 */
export async function evaluateSubscriptionLifecycle(
  trx: TenantTransactionContext,
  now = new Date(),
) {
  const ent = await getTenantSubscriptionEntitlement(trx);
  if (ent.status === 'SUSPENDED' || ent.status === 'CANCELLED') {
    return ent;
  }

  const settings = await getPlatformBankSettings(trx.db);
  const graceDays = settings.gracePeriodDays || 7;
  const periodEnd = new Date(ent.currentPeriodEnd);

  if (now.getTime() <= periodEnd.getTime()) {
    return ent;
  }

  const graceEnd = ent.gracePeriodEndsAt
    ? new Date(ent.gracePeriodEndsAt)
    : new Date(periodEnd.getTime() + graceDays * 86_400_000);

  const nextStatus =
    now.getTime() <= graceEnd.getTime() ? 'GRACE_PERIOD' : 'READ_ONLY';

  if (nextStatus !== ent.status) {
    assertValidLifecycleTransition(ent.status, nextStatus);
    await trx.db
      .updateTable('tenant_subscriptions')
      .set({
        status: nextStatus,
        grace_period_ends_at: graceEnd,
        read_only_entered_at: nextStatus === 'READ_ONLY' ? now : null,
        updated_at: now,
      })
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', ent.subscriptionId)
      .execute();

    await trx.db
      .updateTable('tenants')
      .set({ status: nextStatus, updated_at: now })
      .where('id', '=', trx.tenantId)
      .execute();

    await trx.db
      .insertInto('subscription_plan_history')
      .values({
        id: generateUuidV7(),
        tenant_id: trx.tenantId,
        subscription_id: ent.subscriptionId,
        change_type: 'STATUS_CHANGED',
        from_plan_id: ent.planId,
        to_plan_id: ent.planId,
        from_status: ent.status,
        to_status: nextStatus,
        billing_cycle: ent.billingCycle,
        effective_at: now,
        actor_user_id: trx.userId,
        notes:
          nextStatus === 'GRACE_PERIOD'
            ? `Entered ${graceDays}-day post-expiry grace period`
            : 'Grace period elapsed; subscription marked READ_ONLY',
        metadata_json: JSON.stringify({ graceEndsAt: graceEnd.toISOString() }),
      })
      .execute();

    trx._trxCache?.delete(`subEntitlement:${trx.tenantId}`);
    await insertSubscriptionNotification(trx, {
      tenantId: trx.tenantId,
      subscriptionId: ent.subscriptionId,
      eventType:
        nextStatus === 'GRACE_PERIOD'
          ? 'GRACE_PERIOD_STARTED'
          : 'READ_ONLY_ACTIVATED',
      dedupeKey: `${nextStatus}:${graceEnd.toISOString().slice(0, 10)}:${ent.subscriptionId}`,
      severity: 'CRITICAL',
      title:
        nextStatus === 'GRACE_PERIOD'
          ? 'Subscription Grace Period Started'
          : 'Read-Only Mode Activated',
      message:
        nextStatus === 'GRACE_PERIOD'
          ? `Your subscription period expired. You have ${graceDays} days (${graceEnd.toISOString().slice(0, 10)}) to renew before Read-Only Mode takes effect.`
          : 'Your 7-day grace period has elapsed. Existing records are preserved in Read-Only Mode. Submit a renewal payment to restore full write access.',
    });
  }

  return getTenantSubscriptionEntitlement(trx);
}

type SubNotificationEvent =
  | 'TRIAL_STARTED'
  | 'TRIAL_ENDING_SOON'
  | 'RENEWAL_APPROACHING'
  | 'PAYMENT_SUBMITTED'
  | 'PAYMENT_VERIFIED'
  | 'PAYMENT_REJECTED'
  | 'SUBSCRIPTION_UPGRADED'
  | 'DOWNGRADE_SCHEDULED'
  | 'DOWNGRADE_APPROACHING'
  | 'SUBSCRIPTION_EXPIRED'
  | 'GRACE_PERIOD_STARTED'
  | 'READ_ONLY_ACTIVATED'
  | 'RENEWAL_COMPLETED'
  | 'SUBSCRIPTION_SUSPENDED'
  | 'SUBSCRIPTION_RESTORED';

async function insertSubscriptionNotification(
  trx: TenantTransactionContext,
  params: {
    readonly tenantId: string;
    readonly subscriptionId: string;
    readonly eventType: SubNotificationEvent;
    readonly dedupeKey: string;
    readonly severity: SubscriptionNotificationSeverity;
    readonly title: string;
    readonly message: string;
    readonly metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await trx.db
    .insertInto('subscription_notifications')
    .values({
      id: generateUuidV7(),
      tenant_id: params.tenantId,
      subscription_id: params.subscriptionId,
      event_type: params.eventType,
      dedupe_key: params.dedupeKey,
      severity: params.severity,
      title: params.title,
      message: params.message,
      metadata_json: JSON.stringify(params.metadata ?? {}),
    })
    .onConflict((oc) => oc.columns(['tenant_id', 'dedupe_key']).doNothing())
    .execute();
}

export async function getPlatformBankSettings(
  db: Transaction<NexStockDatabase>,
): Promise<SubscriptionBankSettingsResponse> {
  const row = await db
    .selectFrom('subscription_platform_settings')
    .selectAll()
    .where('singleton_id', '=', 1)
    .executeTakeFirst();

  if (!row) {
    return {
      manualBankTransferEnabled: true,
      bankAccountName: 'W.Swarnalatha',
      bankName: "People's Bank",
      bankBranch: 'Bingiriya Branch',
      bankAccountNumber: '172200270058302',
      bankInstructions:
        'Transfer the exact invoice amount in LKR and upload your transfer receipt.',
      onlineGatewayEnabled: false,
      onlineGatewayProvider: 'PAYHERE_LK',
      gracePeriodDays: 7,
      trialDaysDefault: 30,
      supportEmail: 'support@nexstock.app',
      supportPhone: '+94 11 200 0000',
      supportHours: 'Mon-Sat 08:30-18:00 IST',
    };
  }

  return {
    manualBankTransferEnabled: row.manual_bank_transfer_enabled,
    bankAccountName: row.bank_account_name,
    bankName: row.bank_name,
    bankBranch: row.bank_branch,
    bankAccountNumber: row.bank_account_number,
    bankInstructions: row.bank_instructions,
    onlineGatewayEnabled: row.online_gateway_enabled,
    onlineGatewayProvider: row.online_gateway_provider,
    gracePeriodDays: row.grace_period_days,
    trialDaysDefault: row.trial_days_default,
    supportEmail: row.support_email,
    supportPhone: row.support_phone,
    supportHours: row.support_hours,
  };
}

export async function updatePlatformBankSettings(
  trx: TenantTransactionContext,
  input: UpdatePlatformBankSettingsRequest,
): Promise<SubscriptionBankSettingsResponse> {
  const previous = await getPlatformBankSettings(trx.db);
  await trx.db
    .updateTable('subscription_platform_settings')
    .set({
      ...(input.manualBankTransferEnabled !== undefined
        ? { manual_bank_transfer_enabled: input.manualBankTransferEnabled }
        : {}),
      ...(input.bankAccountName ? { bank_account_name: input.bankAccountName.trim() } : {}),
      ...(input.bankName ? { bank_name: input.bankName.trim() } : {}),
      ...(input.bankBranch ? { bank_branch: input.bankBranch.trim() } : {}),
      ...(input.bankAccountNumber ? { bank_account_number: input.bankAccountNumber.trim() } : {}),
      ...(input.bankInstructions ? { bank_instructions: input.bankInstructions.trim() } : {}),
      ...(input.onlineGatewayEnabled !== undefined
        ? { online_gateway_enabled: input.onlineGatewayEnabled }
        : {}),
      ...(input.onlineGatewayProvider
        ? { online_gateway_provider: input.onlineGatewayProvider }
        : {}),
      ...(input.gracePeriodDays !== undefined
        ? { grace_period_days: input.gracePeriodDays }
        : {}),
      ...(input.trialDaysDefault !== undefined
        ? { trial_days_default: input.trialDaysDefault }
        : {}),
      ...(input.supportEmail ? { support_email: input.supportEmail.trim() } : {}),
      ...(input.supportPhone ? { support_phone: input.supportPhone.trim() } : {}),
      ...(input.supportHours ? { support_hours: input.supportHours.trim() } : {}),
      updated_at: new Date(),
      updated_by_user_id: trx.userId,
    })
    .where('singleton_id', '=', 1)
    .execute();

  const updated = await getPlatformBankSettings(trx.db);
  await trx.db
    .insertInto('platform_audit_logs')
    .values({
      id: generateUuidV7(),
      actor_user_id: trx.userId,
      actor_role: trx.platformRole ?? 'SUPER_ADMIN',
      target_tenant_id: null,
      action: 'PLATFORM_SETTINGS_UPDATED',
      resource_type: 'SUBSCRIPTION_PLATFORM_SETTINGS',
      resource_id: '1',
      previous_state_json: JSON.stringify(previous),
      new_state_json: JSON.stringify(updated),
      correlation_id: trx.tenantContext.traceId,
      metadata_json: JSON.stringify({}),
    })
    .execute();

  return updated;
}

export async function updatePlatformPlanConfig(
  trx: TenantTransactionContext,
  planCode: string,
  input: UpdatePlatformPlanConfigRequest,
): Promise<SubscriptionPlanCatalogItem> {
  const existing = await trx.db
    .selectFrom('subscription_plans')
    .selectAll()
    .where('code', '=', planCode.toUpperCase())
    .executeTakeFirst();

  if (!existing) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'ERR_NOT_FOUND',
      title: 'Plan Not Found',
      detail: `Subscription plan "${planCode}" was not found.`,
    });
  }

  let nextFeatures = existing.features_json;
  if (input.features) {
    const cur = mergePlanAndCustomFeatures({
      planCode: existing.code,
      rawPlanFeaturesJson: existing.features_json,
    });
    nextFeatures = JSON.stringify({ ...cur, ...input.features });
  }

  const prevSnapshot = mapPlanCatalogItem(existing);

  const updated = await trx.db
    .updateTable('subscription_plans')
    .set({
      ...(input.name ? { name: input.name.trim() } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.monthlyPriceAmount !== undefined
        ? { monthly_price_amount: input.monthlyPriceAmount }
        : {}),
      ...(input.annualDiscountPct !== undefined
        ? { annual_discount_pct: input.annualDiscountPct }
        : {}),
      ...(input.additionalBranchMonthlyFee !== undefined
        ? { additional_branch_monthly_fee: input.additionalBranchMonthlyFee }
        : {}),
      ...(input.maxBranches !== undefined ? { max_branches: input.maxBranches } : {}),
      ...(input.maxUsers !== undefined ? { max_users: input.maxUsers } : {}),
      ...(input.maxProducts !== undefined ? { max_products: input.maxProducts } : {}),
      ...(input.maxStorageMb !== undefined ? { max_storage_mb: input.maxStorageMb } : {}),
      ...(input.trialDays !== undefined ? { trial_days: input.trialDays } : {}),
      ...(input.isCustomPricing !== undefined
        ? { is_custom_pricing: input.isCustomPricing }
        : {}),
      ...(input.supportLevel ? { support_level: input.supportLevel.trim() } : {}),
      features_json: nextFeatures,
      version: existing.version + 1,
      updated_at: new Date(),
    })
    .where('id', '=', existing.id)
    .returningAll()
    .executeTakeFirstOrThrow();

  const mappedUpdated = mapPlanCatalogItem(updated);

  await trx.db
    .insertInto('subscription_plan_config_history')
    .values({
      id: generateUuidV7(),
      plan_id: updated.id,
      plan_code: updated.code,
      version: updated.version,
      changed_by_user_id: trx.userId,
      previous_config_json: JSON.stringify(prevSnapshot),
      new_config_json: JSON.stringify(mappedUpdated),
      change_reason: input.changeReason?.trim() ?? null,
    })
    .execute();

  await trx.db
    .insertInto('platform_audit_logs')
    .values({
      id: generateUuidV7(),
      actor_user_id: trx.userId,
      actor_role: trx.platformRole ?? 'SUPER_ADMIN',
      target_tenant_id: null,
      action: 'PLATFORM_PLAN_CONFIG_UPDATED',
      resource_type: 'SUBSCRIPTION_PLAN',
      resource_id: updated.id,
      previous_state_json: JSON.stringify({
        version: prevSnapshot.version,
        monthlyPriceAmount: prevSnapshot.monthlyPriceAmount,
        annualDiscountPct: prevSnapshot.annualDiscountPct,
        limits: prevSnapshot.limits,
      }),
      new_state_json: JSON.stringify({
        version: mappedUpdated.version,
        monthlyPriceAmount: mappedUpdated.monthlyPriceAmount,
        annualDiscountPct: mappedUpdated.annualDiscountPct,
        limits: mappedUpdated.limits,
        changeReason: input.changeReason?.trim() ?? null,
      }),
      correlation_id: trx.tenantContext.traceId,
      metadata_json: JSON.stringify({ planCode: updated.code }),
    })
    .execute();

  return mappedUpdated;
}

export async function listPlatformPlanConfigHistory(
  trx: TenantTransactionContext,
  planCode?: string,
) {
  let q = trx.db.selectFrom('subscription_plan_config_history').selectAll();
  if (planCode) {
    q = q.where('plan_code', '=', planCode.toUpperCase());
  }
  const rows = await q.orderBy('created_at', 'desc').limit(100).execute();
  return rows.map((r) => ({
    id: r.id,
    planCode: r.plan_code,
    version: r.version,
    changedByUserId: r.changed_by_user_id,
    previousConfig: r.previous_config_json,
    newConfig: r.new_config_json,
    changeReason: r.change_reason,
    createdAt: new Date(r.created_at).toISOString(),
  }));
}

export async function listTenantPlanHistory(trx: TenantTransactionContext) {
  const rows = await trx.db
    .selectFrom('subscription_plan_history')
    .leftJoin('subscription_plans as fp', 'fp.id', 'subscription_plan_history.from_plan_id')
    .leftJoin('subscription_plans as tp', 'tp.id', 'subscription_plan_history.to_plan_id')
    .select([
      'subscription_plan_history.id',
      'subscription_plan_history.change_type',
      'fp.code as from_plan_code',
      'tp.code as to_plan_code',
      'subscription_plan_history.from_status',
      'subscription_plan_history.to_status',
      'subscription_plan_history.billing_cycle',
      'subscription_plan_history.effective_at',
      'subscription_plan_history.actor_user_id',
      'subscription_plan_history.notes',
      'subscription_plan_history.created_at',
    ])
    .where('subscription_plan_history.tenant_id', '=', trx.tenantId)
    .orderBy('subscription_plan_history.created_at', 'desc')
    .limit(100)
    .execute();

  return rows.map((r) => ({
    id: r.id,
    changeType: r.change_type,
    fromPlanCode: r.from_plan_code ?? null,
    toPlanCode: r.to_plan_code ?? null,
    fromStatus: r.from_status,
    toStatus: r.to_status,
    billingCycle: r.billing_cycle,
    effectiveAt: new Date(r.effective_at).toISOString(),
    actorUserId: r.actor_user_id,
    notes: r.notes,
    createdAt: new Date(r.created_at).toISOString(),
  }));
}

export async function listTenantSubscriptionInvoices(trx: TenantTransactionContext) {
  const rows = await trx.db
    .selectFrom('subscription_invoices')
    .leftJoin('subscription_plans', 'subscription_plans.id', 'subscription_invoices.target_plan_id')
    .select([
      'subscription_invoices.id',
      'subscription_invoices.invoice_number',
      'subscription_invoices.invoice_type',
      'subscription_invoices.currency_code',
      'subscription_invoices.billing_cycle',
      'subscription_invoices.total_amount',
      'subscription_invoices.amount_paid',
      'subscription_invoices.status',
      'subscription_invoices.due_date',
      'subscription_invoices.issued_at',
      'subscription_invoices.paid_at',
      'subscription_invoices.notes',
      'subscription_plans.code as target_plan_code',
      'subscription_plans.name as target_plan_name',
    ])
    .where('subscription_invoices.tenant_id', '=', trx.tenantId)
    .orderBy('subscription_invoices.issued_at', 'desc')
    .limit(100)
    .execute();

  return rows.map((r) => ({
    id: r.id,
    invoiceNumber: r.invoice_number,
    invoiceType: r.invoice_type,
    currencyCode: r.currency_code,
    billingCycle: r.billing_cycle,
    targetPlanCode: r.target_plan_code ?? null,
    targetPlanName: r.target_plan_name ?? null,
    totalAmount: r.total_amount,
    amountPaid: r.amount_paid,
    status: r.status,
    dueDate:
      r.due_date instanceof Date
        ? r.due_date.toISOString().slice(0, 10)
        : String(r.due_date).slice(0, 10),
    issuedAt: new Date(r.issued_at).toISOString(),
    paidAt: r.paid_at ? new Date(r.paid_at).toISOString() : null,
    notes: r.notes,
  }));
}

function mapSubmissionRow(row: {
  id: string;
  tenant_id: string;
  subscription_id: string;
  invoice_id: string;
  target_billing_cycle: 'MONTHLY' | 'ANNUAL';
  payment_channel: 'MANUAL_BANK_TRANSFER' | 'ONLINE_GATEWAY';
  gateway_provider: string | null;
  expected_amount: string;
  submitted_amount: string;
  currency_code: string;
  payment_reference: string;
  submission_notes: string | null;
  proof_file_name: string | null;
  proof_mime_type: string | null;
  proof_file_size: number | null;
  status: PaymentSubmissionStatus;
  submitted_by_user_id: string;
  submitted_at: Date | null;
  reviewed_by_user_id: string | null;
  reviewed_at: Date | null;
  rejection_reason: string | null;
  verified_payment_id: string | null;
  created_at: Date;
  invoice_number?: string | null;
  target_plan_code?: string | null;
}): SubscriptionPaymentSubmissionResponse {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    subscriptionId: row.subscription_id,
    invoiceId: row.invoice_id,
    ...(row.invoice_number ? { invoiceNumber: row.invoice_number } : {}),
    ...(row.target_plan_code ? { targetPlanCode: row.target_plan_code } : {}),
    targetBillingCycle: row.target_billing_cycle,
    paymentChannel: row.payment_channel,
    gatewayProvider: row.gateway_provider,
    expectedAmount: row.expected_amount,
    submittedAmount: row.submitted_amount,
    currencyCode: row.currency_code,
    paymentReference: row.payment_reference,
    submissionNotes: row.submission_notes,
    proofFileName: row.proof_file_name,
    proofMimeType: row.proof_mime_type,
    proofFileSize: row.proof_file_size,
    status: row.status,
    submittedByUserId: row.submitted_by_user_id,
    submittedAt: row.submitted_at ? new Date(row.submitted_at).toISOString() : null,
    reviewedByUserId: row.reviewed_by_user_id,
    reviewedAt: row.reviewed_at ? new Date(row.reviewed_at).toISOString() : null,
    rejectionReason: row.rejection_reason,
    verifiedPaymentId: row.verified_payment_id,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

/**
 * Manual Bank Transfer Submission + Private Payment Proof Upload.
 * IMPORTANT: NEVER activates plan or marks payment VERIFIED on submission!
 */
export async function submitManualBankTransferPayment(
  trx: TenantTransactionContext,
  input: SubmitManualBankTransferRequest,
  idempotencyKey?: string,
): Promise<SubscriptionPaymentSubmissionResponse> {
  if (idempotencyKey) {
    const existing = await trx.db
      .selectFrom('subscription_payment_submissions')
      .selectAll()
      .where('tenant_id', '=', trx.tenantId)
      .where('idempotency_key', '=', idempotencyKey)
      .executeTakeFirst();
    if (existing) {
      return mapSubmissionRow(existing);
    }
  }

  const invoice = await trx.db
    .selectFrom('subscription_invoices')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', input.invoiceId)
    .executeTakeFirst();

  if (!invoice) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'ERR_NOT_FOUND',
      title: 'Subscription Invoice Not Found',
      detail: `Invoice "${input.invoiceId}" was not found.`,
    });
  }

  if (invoice.status === 'PAID' || invoice.status === 'VOID') {
    throw new AppError({
      statusCode: 409,
      errorCode: 'ERR_CONFLICT',
      title: 'Invoice Already Settled or Void',
      detail: `Invoice "${invoice.invoice_number}" has status "${invoice.status}".`,
    });
  }

  const rawBase64 = input.proofDataBase64.includes(',')
    ? input.proofDataBase64.split(',')[1]!
    : input.proofDataBase64;
  const buffer = Buffer.from(rawBase64, 'base64');
  if (!detectAndValidateProofBytes(buffer, input.proofMimeType)) {
    throw new AppError({
      statusCode: 400,
      errorCode: 'CAT_INVALID_IMAGE_TYPE',
      title: 'Invalid Payment Proof File',
      detail:
        'Uploaded payment proof must be a valid JPEG, PNG, WebP, or PDF file under 5 MB.',
    });
  }

  const ent = await getTenantSubscriptionEntitlement(trx);
  const targetPlanId = invoice.target_plan_id ?? ent.planId;
  const targetCycle = invoice.target_billing_cycle ?? invoice.billing_cycle ?? 'MONTHLY';
  const now = new Date();
  const submissionId = input.resubmitSubmissionId ?? generateUuidV7();
  const storageKey = `private/sub-proofs/${trx.tenantId}/${submissionId}`;

  if (input.resubmitSubmissionId) {
    const prev = await trx.db
      .selectFrom('subscription_payment_submissions')
      .select(['id', 'status'])
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', input.resubmitSubmissionId)
      .executeTakeFirst();
    if (!prev || prev.status !== 'REJECTED') {
      throw new AppError({
        statusCode: 409,
        errorCode: 'ERR_CONFLICT',
        title: 'Only Rejected Submissions Can Be Resubmitted',
        detail: 'Payment proof resubmission is only permitted after rejection.',
      });
    }
    const updated = await trx.db
      .updateTable('subscription_payment_submissions')
      .set({
        payment_reference: input.paymentReference.trim(),
        submission_notes: input.notes ?? null,
        proof_storage_key: storageKey,
        proof_file_name: input.proofFileName.trim(),
        proof_mime_type: input.proofMimeType,
        proof_file_size: buffer.length,
        proof_data_bytea: buffer,
        status: 'SUBMITTED',
        rejection_reason: null,
        submitted_by_user_id: trx.userId,
        submitted_at: now,
        updated_at: now,
      })
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', input.resubmitSubmissionId)
      .returningAll()
      .executeTakeFirstOrThrow();

    await trx.db
      .updateTable('tenant_subscriptions')
      .set({ status: 'PAYMENT_VERIFICATION_REQUIRED', updated_at: now })
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', ent.subscriptionId)
      .execute();

    return mapSubmissionRow(updated);
  }

  const inserted = await trx.db
    .insertInto('subscription_payment_submissions')
    .values({
      id: submissionId,
      tenant_id: trx.tenantId,
      subscription_id: ent.subscriptionId,
      invoice_id: invoice.id,
      target_plan_id: targetPlanId,
      target_billing_cycle: targetCycle,
      payment_channel: 'MANUAL_BANK_TRANSFER',
      gateway_provider: null,
      expected_amount: invoice.total_amount,
      submitted_amount: invoice.total_amount,
      currency_code: invoice.currency_code,
      payment_reference: input.paymentReference.trim(),
      submission_notes: input.notes ?? null,
      proof_storage_key: storageKey,
      proof_file_name: input.proofFileName.trim(),
      proof_mime_type: input.proofMimeType,
      proof_file_size: buffer.length,
      proof_data_bytea: buffer,
      status: 'SUBMITTED',
      submitted_by_user_id: trx.userId,
      submitted_at: now,
      reviewed_by_user_id: null,
      reviewed_at: null,
      rejection_reason: null,
      gateway_transaction_id: null,
      gateway_payload_json: null,
      verified_payment_id: null,
      idempotency_key: idempotencyKey ?? null,
      created_at: now,
      updated_at: now,
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  // Move TRIALING/PENDING_PAYMENT/RENEWAL_DUE into PAYMENT_VERIFICATION_REQUIRED while keeping ACTIVE/READ_ONLY/EXPIRED/SUSPENDED intact until admin verification!
  if (
    ent.status === 'TRIALING' ||
    ent.status === 'PENDING_PAYMENT' ||
    ent.status === 'RENEWAL_DUE'
  ) {
    await trx.db
      .updateTable('tenant_subscriptions')
      .set({ status: 'PAYMENT_VERIFICATION_REQUIRED', updated_at: now })
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', ent.subscriptionId)
      .execute();
    await trx.db
      .updateTable('tenants')
      .set({ status: 'PAYMENT_VERIFICATION_REQUIRED', updated_at: now })
      .where('id', '=', trx.tenantId)
      .execute();
  }

  await insertSubscriptionNotification(trx, {
    tenantId: trx.tenantId,
    subscriptionId: ent.subscriptionId,
    eventType: 'PAYMENT_SUBMITTED',
    dedupeKey: `PAYMENT_SUBMITTED:${submissionId}:${now.toISOString().slice(0, 16)}`,
    severity: 'INFO',
    title: 'Payment Proof Submitted',
    message: `Bank transfer slip for invoice ${invoice.invoice_number} (${invoice.currency_code} ${invoice.total_amount}) submitted for verification.`,
  });

  await appendAuditLog(trx, {
    action: 'SUB_MANUAL_PAYMENT_SUBMITTED',
    resourceType: 'SUBSCRIPTION_PAYMENT_SUBMISSION',
    resourceId: submissionId,
    metadata: {
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoice_number,
      expectedAmount: invoice.total_amount,
      reference: input.paymentReference.trim(),
    },
  });

  trx._trxCache?.delete(`subEntitlement:${trx.tenantId}`);
  return mapSubmissionRow(inserted);
}

export async function listTenantPaymentSubmissions(
  trx: TenantTransactionContext,
): Promise<SubscriptionPaymentSubmissionResponse[]> {
  const rows = await trx.db
    .selectFrom('subscription_payment_submissions')
    .innerJoin(
      'subscription_invoices',
      'subscription_invoices.id',
      'subscription_payment_submissions.invoice_id',
    )
    .leftJoin(
      'subscription_plans',
      'subscription_plans.id',
      'subscription_payment_submissions.target_plan_id',
    )
    .select([
      'subscription_payment_submissions.id',
      'subscription_payment_submissions.tenant_id',
      'subscription_payment_submissions.subscription_id',
      'subscription_payment_submissions.invoice_id',
      'subscription_payment_submissions.target_billing_cycle',
      'subscription_payment_submissions.payment_channel',
      'subscription_payment_submissions.gateway_provider',
      'subscription_payment_submissions.expected_amount',
      'subscription_payment_submissions.submitted_amount',
      'subscription_payment_submissions.currency_code',
      'subscription_payment_submissions.payment_reference',
      'subscription_payment_submissions.submission_notes',
      'subscription_payment_submissions.proof_file_name',
      'subscription_payment_submissions.proof_mime_type',
      'subscription_payment_submissions.proof_file_size',
      'subscription_payment_submissions.status',
      'subscription_payment_submissions.submitted_by_user_id',
      'subscription_payment_submissions.submitted_at',
      'subscription_payment_submissions.reviewed_by_user_id',
      'subscription_payment_submissions.reviewed_at',
      'subscription_payment_submissions.rejection_reason',
      'subscription_payment_submissions.verified_payment_id',
      'subscription_payment_submissions.created_at',
      'subscription_invoices.invoice_number',
      'subscription_plans.code as target_plan_code',
    ])
    .where('subscription_payment_submissions.tenant_id', '=', trx.tenantId)
    .orderBy('subscription_payment_submissions.created_at', 'desc')
    .limit(100)
    .execute();

  return rows.map(mapSubmissionRow);
}

export async function getAuthorizedPaymentProofBytes(
  trx: TenantTransactionContext,
  submissionId: string,
  allowCrossTenantPlatformAdmin = false,
): Promise<{
  readonly fileName: string;
  readonly mimeType: string;
  readonly buffer: Buffer;
}> {
  let q = trx.db
    .selectFrom('subscription_payment_submissions')
    .select([
      'id',
      'tenant_id',
      'proof_file_name',
      'proof_mime_type',
      'proof_data_bytea',
    ])
    .where('id', '=', submissionId);

  if (!allowCrossTenantPlatformAdmin) {
    q = q.where('tenant_id', '=', trx.tenantId);
  }

  const row = await q.executeTakeFirst();
  if (!row || !row.proof_data_bytea) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'ERR_NOT_FOUND',
      title: 'Payment Proof Not Found',
      detail: `Payment proof for submission "${submissionId}" was not found.`,
    });
  }

  return {
    fileName: row.proof_file_name ?? 'payment-proof',
    mimeType: row.proof_mime_type ?? 'application/octet-stream',
    buffer: Buffer.from(row.proof_data_bytea),
  };
}

export async function listPlatformPaymentSubmissions(
  trx: TenantTransactionContext,
  statusFilter?: PaymentSubmissionStatus,
  search?: string,
  limit = 100,
  offset = 0,
): Promise<Array<SubscriptionPaymentSubmissionResponse & { readonly businessName?: string; readonly businessSlug?: string }>> {
  let q = trx.db
    .selectFrom('subscription_payment_submissions')
    .innerJoin(
      'subscription_invoices',
      'subscription_invoices.id',
      'subscription_payment_submissions.invoice_id',
    )
    .leftJoin(
      'tenants',
      'tenants.id',
      'subscription_payment_submissions.tenant_id',
    )
    .leftJoin(
      'subscription_plans',
      'subscription_plans.id',
      'subscription_payment_submissions.target_plan_id',
    )
    .select([
      'subscription_payment_submissions.id',
      'subscription_payment_submissions.tenant_id',
      'subscription_payment_submissions.subscription_id',
      'subscription_payment_submissions.invoice_id',
      'subscription_payment_submissions.target_billing_cycle',
      'subscription_payment_submissions.payment_channel',
      'subscription_payment_submissions.gateway_provider',
      'subscription_payment_submissions.expected_amount',
      'subscription_payment_submissions.submitted_amount',
      'subscription_payment_submissions.currency_code',
      'subscription_payment_submissions.payment_reference',
      'subscription_payment_submissions.submission_notes',
      'subscription_payment_submissions.proof_file_name',
      'subscription_payment_submissions.proof_mime_type',
      'subscription_payment_submissions.proof_file_size',
      'subscription_payment_submissions.status',
      'subscription_payment_submissions.submitted_by_user_id',
      'subscription_payment_submissions.submitted_at',
      'subscription_payment_submissions.reviewed_by_user_id',
      'subscription_payment_submissions.reviewed_at',
      'subscription_payment_submissions.rejection_reason',
      'subscription_payment_submissions.verified_payment_id',
      'subscription_payment_submissions.created_at',
      'subscription_invoices.invoice_number',
      'subscription_plans.code as target_plan_code',
      'tenants.legal_name as business_name',
      'tenants.slug as business_slug',
    ]);

  if (statusFilter) {
    q = q.where('subscription_payment_submissions.status', '=', statusFilter);
  }
  if (search && search.trim()) {
    const pattern = `%${search.trim().toLowerCase()}%`;
    q = q.where((eb) =>
      eb.or([
        eb(sql`LOWER(subscription_payment_submissions.payment_reference)`, 'like', pattern),
        eb(sql`LOWER(subscription_invoices.invoice_number)`, 'like', pattern),
        eb(sql`LOWER(tenants.legal_name)`, 'like', pattern),
      ]),
    );
  }

  const rows = await q
    .orderBy('subscription_payment_submissions.created_at', 'desc')
    .limit(Math.min(200, Math.max(1, limit)))
    .offset(Math.max(0, offset))
    .execute();

  return rows.map((r) => ({
    ...mapSubmissionRow(r),
    ...(r.business_name ? { businessName: r.business_name } : {}),
    ...(r.business_slug ? { businessSlug: r.business_slug } : {}),
  }));
}

/**
 * Shared atomic settlement core invoked ONLY by:
 * 1. Verified Platform Super Admin approval (`verifyPaymentSubmission`)
 * 2. Signature-verified online gateway webhook (`processOnlineGatewayWebhook`)
 * Prevents double verification and duplicate subscription activations.
 */
async function settleVerifiedSubmissionAtomically(params: {
  readonly trx: TenantTransactionContext;
  readonly submissionId: string;
  readonly targetTenantId: string;
  readonly paymentMethod: 'MANUAL_RECEIPT' | 'BANK_TRANSFER' | 'EXTERNAL_GATEWAY_REF';
  readonly referenceNumber: string;
  readonly gatewayTransactionId?: string;
  readonly gatewayPayload?: Record<string, unknown>;
  readonly actorUserId: string;
}) {
  const { trx, submissionId, targetTenantId } = params;
  const subRow = await trx.db
    .selectFrom('subscription_payment_submissions')
    .selectAll()
    .where('tenant_id', '=', targetTenantId)
    .where('id', '=', submissionId)
    .executeTakeFirst();

  if (!subRow) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'ERR_NOT_FOUND',
      title: 'Payment Submission Not Found',
      detail: `Payment submission "${submissionId}" was not found.`,
    });
  }

  if (subRow.status === 'VERIFIED' || subRow.verified_payment_id) {
    throw new AppError({
      statusCode: 409,
      errorCode: 'SUB_PAYMENT_ALREADY_VERIFIED',
      title: 'Payment Already Verified',
      detail: `Submission "${submissionId}" has already been verified and settled.`,
    });
  }

  const invoice = await trx.db
    .selectFrom('subscription_invoices')
    .selectAll()
    .where('tenant_id', '=', targetTenantId)
    .where('id', '=', subRow.invoice_id)
    .executeTakeFirstOrThrow();

  if (invoice.status === 'PAID') {
    throw new AppError({
      statusCode: 409,
      errorCode: 'SUB_PAYMENT_ALREADY_VERIFIED',
      title: 'Invoice Already Paid',
      detail: `Invoice "${invoice.invoice_number}" is already PAID.`,
    });
  }

  const tenantSub = await trx.db
    .selectFrom('tenant_subscriptions')
    .selectAll()
    .where('tenant_id', '=', targetTenantId)
    .where('id', '=', subRow.subscription_id)
    .executeTakeFirstOrThrow();

  const now = new Date();
  const paymentId = generateUuidV7();
  const totalMoney = Money.fromDecimalString(
    String(invoice.total_amount),
    invoice.currency_code,
  );

  await trx.db
    .insertInto('subscription_payments')
    .values({
      id: paymentId,
      tenant_id: targetTenantId,
      subscription_invoice_id: invoice.id,
      currency_code: invoice.currency_code,
      amount: totalMoney.toDecimalString(),
      payment_method: params.paymentMethod,
      reference_number: params.referenceNumber,
      recorded_by_user_id: params.actorUserId,
    })
    .execute();

  await trx.db
    .updateTable('subscription_invoices')
    .set({
      amount_paid: totalMoney.toDecimalString(),
      status: 'PAID',
      paid_at: now,
    })
    .where('tenant_id', '=', targetTenantId)
    .where('id', '=', invoice.id)
    .execute();

  const updatedSub = await trx.db
    .updateTable('subscription_payment_submissions')
    .set({
      status: 'VERIFIED',
      reviewed_by_user_id: params.actorUserId,
      reviewed_at: now,
      rejection_reason: null,
      verified_payment_id: paymentId,
      ...(params.gatewayTransactionId
        ? { gateway_transaction_id: params.gatewayTransactionId }
        : {}),
      ...(params.gatewayPayload
        ? { gateway_payload_json: JSON.stringify(params.gatewayPayload) }
        : {}),
      updated_at: now,
    })
    .where('tenant_id', '=', targetTenantId)
    .where('id', '=', submissionId)
    .where('status', 'in', ['PENDING', 'SUBMITTED', 'UNDER_REVIEW'])
    .returningAll()
    .executeTakeFirst();

  if (!updatedSub) {
    throw new AppError({
      statusCode: 409,
      errorCode: 'SUB_PAYMENT_ALREADY_VERIFIED',
      title: 'Concurrent Verification Conflict',
      detail: 'Submission status changed concurrently before settlement.',
    });
  }

  let nextPlanId = tenantSub.plan_id;
  let nextCycle = tenantSub.billing_cycle;
  let nextPeriodStart = new Date(tenantSub.current_period_start);
  let nextPeriodEnd = new Date(tenantSub.current_period_end);
  let nextExtraBranches = tenantSub.additional_branch_slots ?? 0;
  let changeType:
    | 'TRIAL_CONVERTED'
    | 'UPGRADED'
    | 'RENEWED'
    | 'BRANCH_ADDON_PURCHASED' = 'RENEWED';

  if (invoice.invoice_type === 'BRANCH_ADDON' && invoice.branch_addon_qty > 0) {
    changeType = 'BRANCH_ADDON_PURCHASED';
    nextExtraBranches += invoice.branch_addon_qty;
    await trx.db
      .updateTable('subscription_branch_addons')
      .set({ status: 'ACTIVE' })
      .where('tenant_id', '=', targetTenantId)
      .where('invoice_id', '=', invoice.id)
      .execute();
  } else {
    nextPlanId = invoice.target_plan_id ?? subRow.target_plan_id ?? tenantSub.plan_id;
    nextCycle =
      invoice.target_billing_cycle ??
      subRow.target_billing_cycle ??
      tenantSub.billing_cycle;
    const days = nextCycle === 'ANNUAL' ? 365 : 30;
    const anchorMs =
      invoice.invoice_type === 'RENEWAL' &&
      new Date(tenantSub.current_period_end).getTime() > now.getTime()
        ? new Date(tenantSub.current_period_end).getTime()
        : now.getTime();
    nextPeriodStart = invoice.invoice_type === 'RENEWAL' ? new Date(anchorMs) : now;
    nextPeriodEnd = new Date(anchorMs + days * 86_400_000);
    changeType =
      tenantSub.status === 'TRIALING' || invoice.invoice_type === 'TRIAL_CONVERSION'
        ? 'TRIAL_CONVERTED'
        : invoice.invoice_type === 'UPGRADE'
          ? 'UPGRADED'
          : 'RENEWED';
  }

  await trx.db
    .updateTable('tenant_subscriptions')
    .set({
      plan_id: nextPlanId,
      billing_cycle: nextCycle,
      status: 'ACTIVE',
      current_period_start: nextPeriodStart,
      current_period_end: nextPeriodEnd,
      grace_period_ends_at: null,
      read_only_entered_at: null,
      trial_converted_at:
        changeType === 'TRIAL_CONVERTED'
          ? now
          : tenantSub.trial_converted_at,
      scheduled_plan_id: null,
      scheduled_billing_cycle: null,
      scheduled_change_effective_at: null,
      additional_branch_slots: nextExtraBranches,
      updated_at: now,
    })
    .where('tenant_id', '=', targetTenantId)
    .where('id', '=', tenantSub.id)
    .execute();

  await trx.db
    .updateTable('tenants')
    .set({ status: 'ACTIVE', updated_at: now })
    .where('id', '=', targetTenantId)
    .execute();

  await trx.db
    .insertInto('subscription_plan_history')
    .values({
      id: generateUuidV7(),
      tenant_id: targetTenantId,
      subscription_id: tenantSub.id,
      change_type: changeType,
      from_plan_id: tenantSub.plan_id,
      to_plan_id: nextPlanId,
      from_status: tenantSub.status,
      to_status: 'ACTIVE',
      billing_cycle: nextCycle,
      effective_at: now,
      actor_user_id: params.actorUserId,
      notes: `Verified payment ${params.referenceNumber} for ${invoice.invoice_number}`,
      metadata_json: JSON.stringify({
        paymentId,
        submissionId,
        invoiceId: invoice.id,
        branchAddonQty: invoice.branch_addon_qty,
      }),
    })
    .execute();

  await appendAuditLog(trx, {
    action: 'SUB_PAYMENT_VERIFIED_AND_SETTLED',
    resourceType: 'SUBSCRIPTION_PAYMENT_SUBMISSION',
    resourceId: submissionId,
    metadata: {
      paymentId,
      invoiceId: invoice.id,
      changeType,
      nextPlanId,
      nextCycle,
    },
  });

  await insertSubscriptionNotification(trx, {
    tenantId: targetTenantId,
    subscriptionId: tenantSub.id,
    eventType:
      changeType === 'UPGRADED'
        ? 'SUBSCRIPTION_UPGRADED'
        : changeType === 'RENEWED'
          ? 'RENEWAL_COMPLETED'
          : 'PAYMENT_VERIFIED',
    dedupeKey: `VERIFIED:${submissionId}`,
    severity: 'SUCCESS',
    title:
      changeType === 'UPGRADED'
        ? 'Subscription Upgraded & Activated'
        : 'Payment Verified & Subscription Active',
    message: `Payment ${params.referenceNumber} (${invoice.currency_code} ${totalMoney.toDecimalString()}) verified. Your subscription is ACTIVE until ${nextPeriodEnd.toISOString().slice(0, 10)}.`,
  });

  await enqueueOutboxEvent(trx, {
    aggregateType: 'SUBSCRIPTION_PAYMENT_SUBMISSION',
    aggregateId: submissionId,
    eventType: 'SUBSCRIPTION_PAYMENT_VERIFIED',
    payload: {
      tenantId: targetTenantId,
      paymentId,
      invoiceId: invoice.id,
      changeType,
    },
  });

  return {
    submission: mapSubmissionRow(updatedSub),
    paymentId,
    subscriptionStatus: 'ACTIVE' as const,
  };
}

export async function verifyManualPaymentSubmission(
  trx: TenantTransactionContext,
  submissionId: string,
  input: VerifyPaymentSubmissionRequest,
) {
  const row = await trx.db
    .selectFrom('subscription_payment_submissions')
    .selectAll()
    .where('id', '=', submissionId)
    .executeTakeFirst();

  if (!row) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'ERR_NOT_FOUND',
      title: 'Payment Submission Not Found',
      detail: `Payment submission "${submissionId}" was not found.`,
    });
  }

  if (row.status === 'VERIFIED' || row.verified_payment_id) {
    throw new AppError({
      statusCode: 409,
      errorCode: 'SUB_PAYMENT_ALREADY_VERIFIED',
      title: 'Payment Already Verified',
      detail: 'Cannot verify or modify an already verified payment submission.',
    });
  }

  const now = new Date();
  if (input.decision === 'MARK_UNDER_REVIEW') {
    const updated = await trx.db
      .updateTable('subscription_payment_submissions')
      .set({
        status: 'UNDER_REVIEW',
        reviewed_by_user_id: trx.userId,
        updated_at: now,
      })
      .where('tenant_id', '=', row.tenant_id)
      .where('id', '=', submissionId)
      .returningAll()
      .executeTakeFirstOrThrow();

    return {
      submission: mapSubmissionRow(updated),
      paymentId: null,
      subscriptionStatus: null,
    };
  }

  if (input.decision === 'REJECT') {
    if (!input.rejectionReason || input.rejectionReason.trim().length < 5) {
      throw new AppError({
        statusCode: 400,
        errorCode: 'ERR_VALIDATION_FAILED',
        title: 'Rejection Reason Required',
        detail: 'Rejecting a payment submission requires a rejectionReason (min 5 chars).',
      });
    }

    const updated = await trx.db
      .updateTable('subscription_payment_submissions')
      .set({
        status: 'REJECTED',
        reviewed_by_user_id: trx.userId,
        reviewed_at: now,
        rejection_reason: input.rejectionReason.trim(),
        updated_at: now,
      })
      .where('tenant_id', '=', row.tenant_id)
      .where('id', '=', submissionId)
      .returningAll()
      .executeTakeFirstOrThrow();

    await trx.db
      .updateTable('subscription_invoices')
      .set({ status: 'OPEN' })
      .where('tenant_id', '=', row.tenant_id)
      .where('id', '=', row.invoice_id)
      .where('status', '!=', 'PAID')
      .execute();

    await insertSubscriptionNotification(trx, {
      tenantId: row.tenant_id,
      subscriptionId: row.subscription_id,
      eventType: 'PAYMENT_REJECTED',
      dedupeKey: `REJECTED:${submissionId}:${now.toISOString().slice(0, 16)}`,
      severity: 'WARNING',
      title: 'Payment Submission Rejected',
      message: `Your payment proof (${row.payment_reference}) was rejected: ${input.rejectionReason.trim()}. You may resubmit updated proof.`,
    });

    await trx.db
      .insertInto('platform_audit_logs')
      .values({
        id: generateUuidV7(),
        actor_user_id: trx.userId,
        actor_role: trx.platformRole ?? 'SUPER_ADMIN',
        target_tenant_id: row.tenant_id,
        action: 'PLATFORM_PAYMENT_REJECTED',
        resource_type: 'SUBSCRIPTION_PAYMENT_SUBMISSION',
        resource_id: submissionId,
        previous_state_json: JSON.stringify({ status: row.status }),
        new_state_json: JSON.stringify({
          status: 'REJECTED',
          rejectionReason: input.rejectionReason.trim(),
        }),
        correlation_id: trx.tenantContext.traceId,
        metadata_json: JSON.stringify({ invoiceId: row.invoice_id }),
      })
      .execute();

    await appendAuditLog(trx, {
      action: 'SUB_PAYMENT_SUBMISSION_REJECTED',
      resourceType: 'SUBSCRIPTION_PAYMENT_SUBMISSION',
      resourceId: submissionId,
      metadata: { reason: input.rejectionReason.trim() },
    });

    return {
      submission: mapSubmissionRow(updated),
      paymentId: null,
      subscriptionStatus: null,
    };
  }

  const settled = await settleVerifiedSubmissionAtomically({
    trx,
    submissionId,
    targetTenantId: row.tenant_id,
    paymentMethod: 'BANK_TRANSFER',
    referenceNumber: row.payment_reference,
    actorUserId: trx.userId,
  });

  await trx.db
    .insertInto('platform_audit_logs')
    .values({
      id: generateUuidV7(),
      actor_user_id: trx.userId,
      actor_role: trx.platformRole ?? 'SUPER_ADMIN',
      target_tenant_id: row.tenant_id,
      action: 'PLATFORM_PAYMENT_APPROVED',
      resource_type: 'SUBSCRIPTION_PAYMENT_SUBMISSION',
      resource_id: submissionId,
      previous_state_json: JSON.stringify({ status: row.status }),
      new_state_json: JSON.stringify({
        status: 'VERIFIED',
        paymentId: settled.paymentId,
      }),
      correlation_id: trx.tenantContext.traceId,
      metadata_json: JSON.stringify({
        invoiceId: row.invoice_id,
        amount: row.expected_amount,
      }),
    })
    .execute();

  return settled;
}

export async function createOnlineGatewayPaymentSession(
  trx: TenantTransactionContext,
  input: OnlineGatewayCheckoutRequest,
) {
  const invoice = await trx.db
    .selectFrom('subscription_invoices')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', input.invoiceId)
    .executeTakeFirst();

  if (!invoice) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'ERR_NOT_FOUND',
      title: 'Invoice Not Found',
      detail: `Subscription invoice "${input.invoiceId}" not found.`,
    });
  }

  if (invoice.status === 'PAID' || invoice.status === 'VOID') {
    throw new AppError({
      statusCode: 409,
      errorCode: 'ERR_CONFLICT',
      title: 'Invoice Already Settled',
      detail: `Invoice "${invoice.invoice_number}" is ${invoice.status}.`,
    });
  }

  const ent = await getTenantSubscriptionEntitlement(trx);
  const submissionId = generateUuidV7();
  const now = new Date();
  const adapter = getOnlineGatewayAdapter(input.providerCode);
  const session = adapter.createCheckoutSession({
    tenantId: trx.tenantId,
    submissionId,
    invoiceNumber: invoice.invoice_number,
    amount: invoice.total_amount,
    currencyCode: invoice.currency_code,
    returnUrl: input.returnUrl,
    cancelUrl: input.cancelUrl,
  });

  await trx.db
    .insertInto('subscription_payment_submissions')
    .values({
      id: submissionId,
      tenant_id: trx.tenantId,
      subscription_id: ent.subscriptionId,
      invoice_id: invoice.id,
      target_plan_id: invoice.target_plan_id ?? ent.planId,
      target_billing_cycle:
        invoice.target_billing_cycle ?? invoice.billing_cycle ?? 'MONTHLY',
      payment_channel: 'ONLINE_GATEWAY',
      gateway_provider: input.providerCode,
      expected_amount: invoice.total_amount,
      submitted_amount: invoice.total_amount,
      currency_code: invoice.currency_code,
      payment_reference: session.sessionReference,
      submission_notes: session.message,
      proof_storage_key: null,
      proof_file_name: null,
      proof_mime_type: null,
      proof_file_size: null,
      proof_data_bytea: null,
      status: 'PENDING',
      submitted_by_user_id: trx.userId,
      submitted_at: now,
      reviewed_by_user_id: null,
      reviewed_at: null,
      rejection_reason: null,
      gateway_transaction_id: null,
      gateway_payload_json: null,
      verified_payment_id: null,
      idempotency_key: null,
      created_at: now,
      updated_at: now,
    })
    .execute();

  return {
    submissionId,
    ...session,
  };
}

export async function processOnlineGatewayWebhook(
  trx: TenantTransactionContext,
  params: {
    readonly providerCode: OnlineGatewayProviderCode;
    readonly rawBodyString: string;
    readonly signatureHeader: string | undefined;
    readonly body: OnlineGatewayWebhookRequest;
  },
) {
  const adapter = getOnlineGatewayAdapter(params.providerCode);
  const validSig = adapter.verifyWebhookSignature({
    rawPayload: params.rawBodyString,
    signatureHeader: params.signatureHeader,
  });
  if (!validSig) {
    throw new AppError({
      statusCode: 401,
      errorCode: 'SUB_WEBHOOK_SIGNATURE_INVALID',
      title: 'Invalid Gateway Webhook Signature',
      detail: 'Gateway callback signature verification failed.',
    });
  }

  // Idempotent webhook check
  const existingLog = await trx.db
    .selectFrom('subscription_gateway_webhook_logs')
    .selectAll()
    .where('provider_code', '=', params.providerCode)
    .where('provider_event_id', '=', params.body.providerEventId)
    .executeTakeFirst();

  if (existingLog) {
    return {
      duplicate: true,
      eventId: params.body.providerEventId,
      status: existingLog.event_status,
    };
  }

  const subRow = await trx.db
    .selectFrom('subscription_payment_submissions')
    .selectAll()
    .where('tenant_id', '=', params.body.tenantId)
    .where('id', '=', params.body.submissionId)
    .executeTakeFirst();

  if (!subRow) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'ERR_NOT_FOUND',
      title: 'Submission Not Found For Webhook',
      detail: `Submission "${params.body.submissionId}" was not found for tenant "${params.body.tenantId}".`,
    });
  }

  const now = new Date();
  await trx.db
    .insertInto('subscription_gateway_webhook_logs')
    .values({
      id: generateUuidV7(),
      tenant_id: params.body.tenantId,
      provider_code: params.providerCode,
      provider_event_id: params.body.providerEventId,
      submission_id: params.body.submissionId,
      gateway_transaction_id: params.body.gatewayTransactionId,
      event_status: params.body.status,
      payload_json: JSON.stringify(params.body.rawPayload ?? params.body),
      processed_at: now,
    })
    .execute();

  if (params.body.status === 'FAILED' || params.body.status === 'CANCELLED') {
    await trx.db
      .updateTable('subscription_payment_submissions')
      .set({
        status: 'FAILED',
        gateway_transaction_id: params.body.gatewayTransactionId,
        rejection_reason: `Gateway reported status ${params.body.status}`,
        updated_at: now,
      })
      .where('tenant_id', '=', params.body.tenantId)
      .where('id', '=', params.body.submissionId)
      .where('status', '!=', 'VERIFIED')
      .execute();

    return {
      duplicate: false,
      eventId: params.body.providerEventId,
      status: 'FAILED',
    };
  }

  if (params.body.status === 'PENDING') {
    return {
      duplicate: false,
      eventId: params.body.providerEventId,
      status: 'PENDING',
    };
  }

  // Verify exact currency & expected amount >= billed amount
  if (
    subRow.currency_code.trim().toUpperCase() !==
    params.body.currencyCode.trim().toUpperCase()
  ) {
    throw new AppError({
      statusCode: 422,
      errorCode: 'SUB_PAYMENT_AMOUNT_MISMATCH',
      title: 'Gateway Currency Mismatch',
      detail: `Expected ${subRow.currency_code}, got ${params.body.currencyCode}.`,
    });
  }

  const expectedMoney = Money.fromDecimalString(
    subRow.expected_amount,
    subRow.currency_code,
  );
  const paidMoney = Money.fromDecimalString(
    params.body.paidAmount,
    params.body.currencyCode,
  );
  if (paidMoney.compare(expectedMoney) < 0) {
    throw new AppError({
      statusCode: 422,
      errorCode: 'SUB_PAYMENT_AMOUNT_MISMATCH',
      title: 'Gateway Paid Amount Less Than Expected',
      detail: `Expected at least ${expectedMoney.toDecimalString()}, received ${paidMoney.toDecimalString()}.`,
    });
  }

  const settled = await settleVerifiedSubmissionAtomically({
    trx,
    submissionId: params.body.submissionId,
    targetTenantId: params.body.tenantId,
    paymentMethod: 'EXTERNAL_GATEWAY_REF',
    referenceNumber: params.body.gatewayTransactionId,
    gatewayTransactionId: params.body.gatewayTransactionId,
    gatewayPayload: params.body.rawPayload ?? { providerEventId: params.body.providerEventId },
    actorUserId: subRow.submitted_by_user_id,
  });

  return {
    duplicate: false,
    eventId: params.body.providerEventId,
    status: settled.subscriptionStatus,
    paymentId: settled.paymentId,
  };
}

// ============================================================================
// Business Portal Notifications & Entitlement-Scoped Support (10.7.8 & 10.7.9)
// ============================================================================

export async function listTenantSubscriptionNotifications(
  trx: TenantTransactionContext,
  now = new Date(),
): Promise<SubscriptionNotificationResponse[]> {
  const ent = await getTenantSubscriptionEntitlement(trx);

  // De-duplicated proactive alerts for approaching trial end / renewal / downgrade
  if (ent.status === 'TRIALING' && ent.trialEndsAt) {
    const msLeft = new Date(ent.trialEndsAt).getTime() - now.getTime();
    const daysLeft = Math.ceil(msLeft / 86_400_000);
    if (daysLeft >= 0 && daysLeft <= 7) {
      await insertSubscriptionNotification(trx, {
        tenantId: trx.tenantId,
        subscriptionId: ent.subscriptionId,
        eventType: 'TRIAL_ENDING_SOON',
        dedupeKey: `TRIAL_ENDING:${ent.trialEndsAt.slice(0, 10)}:${ent.subscriptionId}`,
        severity: daysLeft <= 2 ? 'WARNING' : 'INFO',
        title: `Free Trial Ending in ${daysLeft} Day(s)`,
        message: `Your free trial ends on ${ent.trialEndsAt.slice(0, 10)}. Upgrade or submit payment to prevent interruption.`,
      });
    }
  } else if (ent.status === 'ACTIVE') {
    const msLeft = new Date(ent.currentPeriodEnd).getTime() - now.getTime();
    const daysLeft = Math.ceil(msLeft / 86_400_000);
    if (daysLeft >= 0 && daysLeft <= 7) {
      await insertSubscriptionNotification(trx, {
        tenantId: trx.tenantId,
        subscriptionId: ent.subscriptionId,
        eventType: 'RENEWAL_APPROACHING',
        dedupeKey: `RENEWAL_SOON:${ent.currentPeriodEnd.slice(0, 10)}:${ent.subscriptionId}`,
        severity: 'INFO',
        title: `Subscription Renewal Due in ${daysLeft} Day(s)`,
        message: `Your ${ent.planName} cycle ends on ${ent.currentPeriodEnd.slice(0, 10)}. Generate and pay your renewal invoice anytime.`,
      });
    }
  }

  if (ent.scheduledDowngradePlanCode && ent.scheduledDowngradeEffectiveAt) {
    const msLeft =
      new Date(ent.scheduledDowngradeEffectiveAt).getTime() - now.getTime();
    const daysLeft = Math.ceil(msLeft / 86_400_000);
    if (daysLeft >= 0 && daysLeft <= 7) {
      await insertSubscriptionNotification(trx, {
        tenantId: trx.tenantId,
        subscriptionId: ent.subscriptionId,
        eventType: 'DOWNGRADE_APPROACHING',
        dedupeKey: `DOWNGRADE_SOON:${ent.scheduledDowngradeEffectiveAt.slice(0, 10)}:${ent.subscriptionId}`,
        severity: 'WARNING',
        title: 'Scheduled Plan Downgrade Approaching',
        message: `Your plan will transition to ${ent.scheduledDowngradePlanCode} on ${ent.scheduledDowngradeEffectiveAt.slice(0, 10)}.`,
      });
    }
  }

  const rows = await trx.db
    .selectFrom('subscription_notifications')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .orderBy('created_at', 'desc')
    .limit(50)
    .execute();

  return rows.map((r) => ({
    id: r.id,
    tenantId: r.tenant_id,
    subscriptionId: r.subscription_id,
    eventType: r.event_type,
    severity: r.severity,
    title: r.title,
    message: r.message,
    isRead: r.is_read,
    readAt: r.read_at ? new Date(r.read_at).toISOString() : null,
    createdAt: new Date(r.created_at).toISOString(),
  }));
}

export async function markSubscriptionNotificationRead(
  trx: TenantTransactionContext,
  notificationId: string,
) {
  const now = new Date();
  await trx.db
    .updateTable('subscription_notifications')
    .set({
      is_read: true,
      read_at: now,
      read_by_user_id: trx.userId,
    })
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', notificationId)
    .execute();
  return { ok: true };
}

export async function markAllSubscriptionNotificationsRead(
  trx: TenantTransactionContext,
) {
  const now = new Date();
  await trx.db
    .updateTable('subscription_notifications')
    .set({
      is_read: true,
      read_at: now,
      read_by_user_id: trx.userId,
    })
    .where('tenant_id', '=', trx.tenantId)
    .where('is_read', '=', false)
    .execute();
  return { ok: true };
}

export async function getTenantSupportOptions(trx: TenantTransactionContext) {
  const [ent, settings, plan] = await Promise.all([
    getTenantSubscriptionEntitlement(trx),
    getPlatformBankSettings(trx.db),
    trx.db
      .selectFrom('subscription_plans')
      .select(['support_level'])
      .where('code', '=', (await getTenantSubscriptionEntitlement(trx)).planCode)
      .executeTakeFirst(),
  ]);

  const supportLevel = plan?.support_level ?? 'Email Support';
  const isDedicated = ent.planCode === 'ENTERPRISE';
  const isPriority = ent.planCode === 'PROFESSIONAL' || ent.planCode === 'GROWTH' || isDedicated;

  return {
    planCode: ent.planCode,
    planName: ent.planName,
    supportTier: supportLevel,
    supportEmail: settings.supportEmail ?? 'support@nexstock.app',
    supportHours: settings.supportHours ?? 'Mon-Sat 08:30-18:00 IST',
    priorityQueueEnabled: isPriority,
    dedicatedPhoneAvailable: isDedicated,
    supportPhone: isDedicated ? (settings.supportPhone ?? '+94 11 200 0000') : null,
    slaResponseTarget: isDedicated
      ? '1 Hour Dedicated SLA'
      : isPriority
        ? '4 Business Hours Priority Queue'
        : '24 Business Hours Email Support',
  };
}

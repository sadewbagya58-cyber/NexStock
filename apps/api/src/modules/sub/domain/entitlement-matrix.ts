import type {
  SubscriptionBillingCycle,
  SubscriptionPricingQuoteResponse,
  SubscriptionStatus,
} from '@nexstock/contracts';
import { Money } from '@nexstock/domain-core';
import { AppError } from '../../shared/index.js';

export type SubscriptionFeatureMap = Readonly<Record<string, boolean>>;

/**
 * Canonical Phase 10.2 Feature Entitlement Matrix per plan tier.
 * Used as authoritative baseline + fallback alongside `subscription_plans.features_json`
 * and tenant-level Enterprise `custom_features_json` overrides.
 */
export const STARTER_DEFAULT_FEATURES: SubscriptionFeatureMap = {
  onlinePos: true,
  onlineInventory: true,
  desktopOfflinePos: false,
  mobileOfflinePos: false,
  offlineInventory: false,
  basicReports: true,
  advancedReports: false,
  multiBranchComparison: false,
  customReports: false,
  customerDirectory: true,
  customerProfiles: true,
  customerSearch: true,
  basicPurchaseHistory: true,
  advancedPurchaseHistory: false,
  basicCustomerCredit: true,
  advancedCustomerCredit: false,
  customerAnalytics: false,
  apiAccess: false,
  basicCsvExport: true,
  basicPdfExport: true,
  excelExport: false,
  advancedExport: false,
  customReportExport: false,
  basicInventory: true,
  fifoMacCosting: true,
  basicStockMovementHistory: true,
  batchTracking: true,
  expiryTracking: true,
  serialTracking: false,
  fefoFifoAllocation: true,
  advancedMovementHistory: false,
  customInventoryFeatures: false,
  basicPos: true,
  advancedPos: false,
  cashPayment: true,
  advancedReturns: false,
  advancedCheckout: false,
  customPosCapabilities: false,
  posPaymentCash: true,
  posPaymentCard: false,
  posPaymentBankTransfer: false,
  posPaymentSplit: false,
  posPaymentCustom: false,
  barcodeFull: true,
  supplierDirectory: true,
  basicPurchaseOrders: true,
  goodsReceiving: true,
  advancedPurchasing: false,
  supplierPerformance: false,
  purchaseAnalytics: false,
  customPurchaseWorkflows: false,
  multiBranchManagement: false,
  stockTransfers: false,
  advancedMultiBranch: false,
  basicStockAdjustments: true,
  advancedStockAdjustments: false,
  advancedAdjustmentReports: false,
  basicUom: true,
  advancedUom: false,
  advancedVariableQty: false,
  productCategoriesFull: true,
  basicNotifications: true,
  basicAlerts: true,
  advancedAlerts: false,
  customNotifications: false,
  notificationAutomation: false,
  basicBackup: true,
  advancedRecovery: false,
  automatedBackup: false,
  advancedDisasterRecovery: false,
  basicEmployeeManagement: true,
  basicRoles: true,
  advancedPermissions: false,
  customRoles: false,
  advancedAccessPolicies: false,
  multiCurrency: false,
  hrm: false,
};

export const PROFESSIONAL_DEFAULT_FEATURES: SubscriptionFeatureMap = {
  ...STARTER_DEFAULT_FEATURES,
  desktopOfflinePos: true,
  mobileOfflinePos: true,
  offlineInventory: true,
  advancedReports: true,
  multiBranchComparison: true,
  advancedPurchaseHistory: true,
  advancedCustomerCredit: true,
  customerAnalytics: true,
  apiAccess: true,
  excelExport: true,
  advancedExport: true,
  batchTracking: true,
  expiryTracking: true,
  serialTracking: true,
  fefoFifoAllocation: true,
  advancedMovementHistory: true,
  advancedPos: true,
  advancedReturns: true,
  advancedCheckout: true,
  posPaymentCard: true,
  posPaymentBankTransfer: true,
  posPaymentSplit: true,
  advancedPurchasing: true,
  supplierPerformance: true,
  purchaseAnalytics: true,
  multiBranchManagement: true,
  stockTransfers: true,
  advancedStockAdjustments: true,
  advancedAdjustmentReports: true,
  advancedUom: true,
  advancedVariableQty: true,
  advancedAlerts: true,
  advancedRecovery: true,
  advancedPermissions: true,
  multiCurrency: true,
};

export const ENTERPRISE_DEFAULT_FEATURES: SubscriptionFeatureMap = {
  ...PROFESSIONAL_DEFAULT_FEATURES,
  customReports: true,
  customReportExport: true,
  customInventoryFeatures: true,
  customPosCapabilities: true,
  posPaymentCustom: true,
  customPurchaseWorkflows: true,
  advancedMultiBranch: true,
  customNotifications: true,
  notificationAutomation: true,
  automatedBackup: true,
  advancedDisasterRecovery: true,
  customRoles: true,
  advancedAccessPolicies: true,
};

export function resolveBaselineFeaturesForPlanCode(planCode: string): SubscriptionFeatureMap {
  const code = planCode.trim().toUpperCase();
  if (code === 'ENTERPRISE') return ENTERPRISE_DEFAULT_FEATURES;
  if (code === 'PROFESSIONAL' || code === 'GROWTH') return PROFESSIONAL_DEFAULT_FEATURES;
  return STARTER_DEFAULT_FEATURES;
}

export function mergePlanAndCustomFeatures(params: {
  readonly planCode: string;
  readonly rawPlanFeaturesJson: unknown;
  readonly rawCustomFeaturesJson?: unknown;
  readonly allowV2HrmFlag?: boolean;
}): Record<string, boolean> {
  const baseline = { ...resolveBaselineFeaturesForPlanCode(params.planCode) };
  const parseJsonObj = (raw: unknown): Record<string, unknown> => {
    if (!raw) return {};
    if (typeof raw === 'string') {
      try {
        return JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return {};
      }
    }
    return typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  };

  const planObj = parseJsonObj(params.rawPlanFeaturesJson);
  const customObj = parseJsonObj(params.rawCustomFeaturesJson);
  const combined: Record<string, boolean> = { ...baseline };

  for (const [k, v] of Object.entries(planObj)) {
    if (typeof v === 'boolean') combined[k] = v;
  }
  for (const [k, v] of Object.entries(customObj)) {
    if (typeof v === 'boolean') combined[k] = v;
  }

  const isV2Hrm =
    params.allowV2HrmFlag ?? process.env.NEXSTOCK_ENABLE_V2_HRM === 'true';
  combined.hrm = Boolean(isV2Hrm || planObj.hrm || customObj.hrm);
  return combined;
}

export const PLAN_RANK_ORDER: Readonly<Record<string, number>> = {
  STARTER: 1,
  PROFESSIONAL: 2,
  GROWTH: 2,
  ENTERPRISE: 3,
};

/**
 * Valid explicit Phase 10.3 lifecycle state transitions.
 */
export const VALID_SUBSCRIPTION_TRANSITIONS: Readonly<
  Record<SubscriptionStatus, ReadonlySet<SubscriptionStatus>>
> = {
  TRIALING: new Set([
    'TRIALING',
    'ACTIVE',
    'PENDING_PAYMENT',
    'PAYMENT_VERIFICATION_REQUIRED',
    'EXPIRED',
    'GRACE_PERIOD',
    'READ_ONLY',
    'PAST_DUE',
    'SUSPENDED',
    'CANCELLED',
  ]),
  ACTIVE: new Set([
    'ACTIVE',
    'PENDING_PAYMENT',
    'PAYMENT_VERIFICATION_REQUIRED',
    'RENEWAL_DUE',
    'GRACE_PERIOD',
    'EXPIRED',
    'READ_ONLY',
    'PAST_DUE',
    'SUSPENDED',
    'CANCELLED',
  ]),
  PENDING_PAYMENT: new Set([
    'PENDING_PAYMENT',
    'PAYMENT_VERIFICATION_REQUIRED',
    'ACTIVE',
    'RENEWAL_DUE',
    'GRACE_PERIOD',
    'EXPIRED',
    'READ_ONLY',
    'PAST_DUE',
    'SUSPENDED',
    'CANCELLED',
  ]),
  PAYMENT_VERIFICATION_REQUIRED: new Set([
    'PAYMENT_VERIFICATION_REQUIRED',
    'ACTIVE',
    'PENDING_PAYMENT',
    'GRACE_PERIOD',
    'EXPIRED',
    'READ_ONLY',
    'PAST_DUE',
    'SUSPENDED',
    'CANCELLED',
  ]),
  RENEWAL_DUE: new Set([
    'RENEWAL_DUE',
    'PENDING_PAYMENT',
    'PAYMENT_VERIFICATION_REQUIRED',
    'ACTIVE',
    'GRACE_PERIOD',
    'EXPIRED',
    'READ_ONLY',
    'PAST_DUE',
    'SUSPENDED',
    'CANCELLED',
  ]),
  GRACE_PERIOD: new Set([
    'GRACE_PERIOD',
    'PENDING_PAYMENT',
    'PAYMENT_VERIFICATION_REQUIRED',
    'ACTIVE',
    'EXPIRED',
    'READ_ONLY',
    'PAST_DUE',
    'SUSPENDED',
    'CANCELLED',
  ]),
  EXPIRED: new Set([
    'EXPIRED',
    'GRACE_PERIOD',
    'READ_ONLY',
    'PENDING_PAYMENT',
    'PAYMENT_VERIFICATION_REQUIRED',
    'ACTIVE',
    'SUSPENDED',
    'CANCELLED',
  ]),
  READ_ONLY: new Set([
    'READ_ONLY',
    'PENDING_PAYMENT',
    'PAYMENT_VERIFICATION_REQUIRED',
    'ACTIVE',
    'SUSPENDED',
    'CANCELLED',
  ]),
  PAST_DUE: new Set([
    'PAST_DUE',
    'ACTIVE',
    'GRACE_PERIOD',
    'EXPIRED',
    'READ_ONLY',
    'PENDING_PAYMENT',
    'PAYMENT_VERIFICATION_REQUIRED',
    'SUSPENDED',
    'CANCELLED',
  ]),
  SUSPENDED: new Set(['SUSPENDED', 'ACTIVE', 'TRIALING', 'PAST_DUE', 'CANCELLED']),
  CANCELLED: new Set(['CANCELLED', 'ACTIVE', 'PENDING_PAYMENT']),
};

export function assertValidLifecycleTransition(
  fromStatus: SubscriptionStatus,
  toStatus: SubscriptionStatus,
): void {
  const allowed = VALID_SUBSCRIPTION_TRANSITIONS[fromStatus];
  if (!allowed || !allowed.has(toStatus)) {
    throw new AppError({
      statusCode: 409,
      errorCode: 'SUB_INVALID_LIFECYCLE_TRANSITION',
      title: 'Invalid Subscription Lifecycle Transition',
      detail: `Subscription cannot transition directly from "${fromStatus}" to "${toStatus}".`,
    });
  }
}

export function divideAndRoundHalfUpBigInt(
  numerator: bigint,
  denominator: bigint,
): bigint {
  if (denominator <= 0n) {
    throw new Error('Denominator must be strictly positive.');
  }
  if (numerator === 0n) return 0n;
  const half = denominator / 2n;
  return (numerator + half) / denominator;
}

/**
 * Deterministic Fixed-Point Subscription Pricing & Proration Calculator (0 floating point).
 * Supports Monthly/Annual billing, configurable annual discount (e.g. 15%),
 * hybrid extra branch pricing, and remaining-days proration.
 */
export function calculateSubscriptionQuote(params: {
  readonly planCode: string;
  readonly planName: string;
  readonly currencyCode: string;
  readonly isCustomPricing: boolean;
  readonly monthlyPriceAmount: string;
  readonly annualDiscountPct: string;
  readonly additionalBranchMonthlyFee: string | null;
  readonly billingCycle: SubscriptionBillingCycle;
  readonly additionalBranchCount?: number | undefined;
  readonly prorateBranchDaysRemaining?: number | undefined;
  readonly prorateCycleTotalDays?: number | undefined;
  readonly customMonthlyPriceOverride?: string | null | undefined;
}): SubscriptionPricingQuoteResponse {
  const currency = params.currencyCode.trim().toUpperCase();
  const baseStr =
    params.customMonthlyPriceOverride ?? params.monthlyPriceAmount;
  const monthlyMoney = Money.fromDecimalString(baseStr, currency);
  const monthlyMicro = monthlyMoney.toMinorUnits(); // scale 4 fixed-point bigint

  const cycleMonths = params.billingCycle === 'ANNUAL' ? 12n : 1n;
  const planGrossMicro = monthlyMicro * cycleMonths;

  let annualDiscountMicro = 0n;
  if (params.billingCycle === 'ANNUAL') {
    const pctBasisPoints = BigInt(
      Math.round((Number.parseFloat(params.annualDiscountPct || '0') || 0) * 100),
    );
    annualDiscountMicro = divideAndRoundHalfUpBigInt(
      planGrossMicro * pctBasisPoints,
      10000n,
    );
  }
  const planNetMicro = planGrossMicro - annualDiscountMicro;

  const extraCount = BigInt(Math.max(0, params.additionalBranchCount ?? 0));
  const extraMonthlyMoney = params.additionalBranchMonthlyFee
    ? Money.fromDecimalString(params.additionalBranchMonthlyFee, currency)
    : Money.zero(currency);
  const extraMonthlyTotalMicro = extraMonthlyMoney.toMinorUnits() * extraCount;
  const extraFullCycleMicro = extraMonthlyTotalMicro * cycleMonths;

  let proratedBranchMicro = extraFullCycleMicro;
  if (
    params.prorateBranchDaysRemaining !== undefined &&
    params.prorateCycleTotalDays !== undefined &&
    params.prorateCycleTotalDays > 0 &&
    extraCount > 0n
  ) {
    const remDays = BigInt(
      Math.max(0, Math.min(params.prorateBranchDaysRemaining, params.prorateCycleTotalDays)),
    );
    const totalDays = BigInt(params.prorateCycleTotalDays);
    proratedBranchMicro = divideAndRoundHalfUpBigInt(
      extraFullCycleMicro * remDays,
      totalDays,
    );
  }

  const totalDueNowMicro = planNetMicro + proratedBranchMicro;
  const recurringNextCycleMicro = planNetMicro + extraFullCycleMicro;

  const fmt = (micro: bigint) =>
    Money.fromMinorUnits(micro, currency).toDecimalString();

  return {
    planCode: params.planCode,
    planName: params.planName,
    billingCycle: params.billingCycle,
    currencyCode: currency,
    isCustomPricing: params.isCustomPricing && !params.customMonthlyPriceOverride,
    monthlyBaseAmount: fmt(monthlyMicro),
    planCycleGrossAmount: fmt(planGrossMicro),
    annualDiscountPct: params.annualDiscountPct,
    annualDiscountAmount: fmt(annualDiscountMicro),
    planCycleNetAmount: fmt(planNetMicro),
    additionalBranchCount: Number(extraCount),
    additionalBranchMonthlyFee: params.additionalBranchMonthlyFee
      ? extraMonthlyMoney.toDecimalString()
      : null,
    additionalBranchCycleAmount: fmt(extraFullCycleMicro),
    proratedAdditionalBranchAmount: fmt(proratedBranchMicro),
    totalDueNow: fmt(totalDueNowMicro),
    recurringNextCycleTotal: fmt(recurringNextCycleMicro),
  };
}

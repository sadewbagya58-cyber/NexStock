import type {
  ApprovePriceSuggestionRequest,
  BranchPriceOverrideResponse,
  CreatePriceSuggestionRequest,
  CurrencyCode,
  PriceSuggestionResponse,
  PriceSuggestionSourceEventType,
  PriceSuggestionStatus,
  PricingAnalyticsDashboardResponse,
  PricingCostBasisType,
  PricingMethodType,
  PricingProductHealthRow,
  PricingRoundingRuleType,
  PricingScope,
  PricingSettingsResponse,
  ProductPriceHistoryResponse,
  ProductPricingRuleResponse,
  RejectOrDeferPriceSuggestionRequest,
  SyncCatalogPricingResponse,
  UpdatePricingSettingsRequest,
  UpsertProductPricingRuleRequest,
} from '@nexstock/contracts';
import {
  calculateSuggestedSellingPrice,
  computeActualMarginPct,
  evaluateMarginHealth,
  Money,
  PricingCalculationError,
  Quantity,
} from '@nexstock/domain-core';
import { assertAuthorized } from '../../iam/index.js';
import {
  AppError,
  appendAuditLog,
  enqueueOutboxEvent,
  generateUuidV7,
  realtimeEventHub,
  type TenantTransactionContext,
} from '../../shared/index.js';
import { assertSubscriptionEntitlement } from '../../sub/index.js';

function formatDateOnly(val: string | Date | null | undefined): string {
  if (!val) {
    return new Date().toISOString().slice(0, 10);
  }
  if (val instanceof Date) {
    return val.toISOString().slice(0, 10);
  }
  return String(val).slice(0, 10);
}

function formatPct2(val: string | number | null | undefined, fallback = '0.00'): string {
  if (val === null || val === undefined || val === '') return fallback;
  const raw = String(val).trim();
  const match = raw.match(/^(-?\d+)(?:\.(\d+))?$/);
  if (!match) return fallback;
  const intPart = match[1]!;
  const fracPart = (match[2] ?? '').padEnd(2, '0').slice(0, 2);
  return `${intPart}.${fracPart}`;
}

async function getTenantBaseCurrency(
  trx: TenantTransactionContext,
): Promise<CurrencyCode> {
  const tenant = await trx.db
    .selectFrom('tenants')
    .select(['base_currency'])
    .where('id', '=', trx.tenantId)
    .executeTakeFirst();
  return (tenant?.base_currency?.trim() || 'USD') as CurrencyCode;
}

export async function ensureTenantPricingSettings(
  trx: TenantTransactionContext,
) {
  let row = await trx.db
    .selectFrom('pricing_settings')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .executeTakeFirst();

  if (!row) {
    const now = new Date();
    await trx.db
      .insertInto('pricing_settings')
      .values({
        tenant_id: trx.tenantId,
        created_at: now,
        updated_at: now,
      })
      .onConflict((oc) => oc.column('tenant_id').doNothing())
      .execute();

    row = await trx.db
      .selectFrom('pricing_settings')
      .selectAll()
      .where('tenant_id', '=', trx.tenantId)
      .executeTakeFirstOrThrow();
  }

  return row;
}

function mapPricingSettingsRow(
  row: Awaited<ReturnType<typeof ensureTenantPricingSettings>>,
): PricingSettingsResponse {
  return {
    tenantId: row.tenant_id,
    defaultPricingMethod: row.default_pricing_method as PricingMethodType,
    defaultTargetPercentage: formatPct2(row.default_target_percentage, '25.00'),
    defaultCostBasis: row.default_cost_basis as PricingCostBasisType,
    defaultRoundingRule: row.default_rounding_rule as PricingRoundingRuleType,
    defaultMinMarginPct: formatPct2(row.default_min_margin_pct, '10.00'),
    defaultMaxDiscountPct: formatPct2(row.default_max_discount_pct, '20.00'),
    branchApprovalPolicy: row.branch_approval_policy,
    allowSelfApproval: Boolean(row.allow_self_approval),
    autoCreateSuggestionsOnCostChange: Boolean(
      row.auto_create_suggestions_on_cost_change,
    ),
    autoCreateSuggestionsOnCostDecrease: Boolean(
      row.auto_create_suggestions_on_cost_decrease,
    ),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export async function getPricingSettings(
  trx: TenantTransactionContext,
): Promise<PricingSettingsResponse> {
  await assertAuthorized(trx, { permission: 'cat:pricing:read' });
  await assertSubscriptionEntitlement(trx, { requireWriteAccess: false });
  const row = await ensureTenantPricingSettings(trx);
  return mapPricingSettingsRow(row);
}

export async function updatePricingSettings(
  trx: TenantTransactionContext,
  input: UpdatePricingSettingsRequest,
): Promise<PricingSettingsResponse> {
  await assertAuthorized(trx, { permission: 'cat:pricing:policy_manage' });
  await assertSubscriptionEntitlement(trx, { requireWriteAccess: true });

  const existing = await ensureTenantPricingSettings(trx);
  const nextMethod = (input.defaultPricingMethod ??
    existing.default_pricing_method) as PricingMethodType;
  const nextPct = formatPct2(
    input.defaultTargetPercentage ?? existing.default_target_percentage,
    '25.00',
  );

  // Validate formula invariants via domain-core
  try {
    calculateSuggestedSellingPrice({
      cost: '100.0000',
      currencyCode: await getTenantBaseCurrency(trx),
      pricingMethod: nextMethod,
      targetPercentage: nextPct,
      roundingRule: (input.defaultRoundingRule ??
        existing.default_rounding_rule) as PricingRoundingRuleType,
    });
  } catch (err) {
    if (err instanceof PricingCalculationError) {
      throw new AppError({
        statusCode: 422,
        errorCode:
          nextMethod === 'PROFIT_MARGIN'
            ? 'PRICING_INVALID_MARGIN_RATE'
            : 'PRICING_INVALID_MARKUP_RATE',
        title: 'Invalid Pricing Rate',
        detail: err.message,
      });
    }
    throw err;
  }

  const now = new Date();
  await trx.db
    .updateTable('pricing_settings')
    .set({
      default_pricing_method: nextMethod,
      default_target_percentage: nextPct,
      default_cost_basis: (input.defaultCostBasis ??
        existing.default_cost_basis) as PricingCostBasisType,
      default_rounding_rule: (input.defaultRoundingRule ??
        existing.default_rounding_rule) as PricingRoundingRuleType,
      default_min_margin_pct: formatPct2(
        input.defaultMinMarginPct ?? existing.default_min_margin_pct,
        '10.00',
      ),
      default_max_discount_pct: formatPct2(
        input.defaultMaxDiscountPct ?? existing.default_max_discount_pct,
        '20.00',
      ),
      branch_approval_policy:
        input.branchApprovalPolicy ?? existing.branch_approval_policy,
      allow_self_approval:
        input.allowSelfApproval ?? Boolean(existing.allow_self_approval),
      auto_create_suggestions_on_cost_change:
        input.autoCreateSuggestionsOnCostChange ??
        Boolean(existing.auto_create_suggestions_on_cost_change),
      auto_create_suggestions_on_cost_decrease:
        input.autoCreateSuggestionsOnCostDecrease ??
        Boolean(existing.auto_create_suggestions_on_cost_decrease),
      updated_by_user_id: trx.userId,
      updated_at: now,
    })
    .where('tenant_id', '=', trx.tenantId)
    .execute();

  const updated = await ensureTenantPricingSettings(trx);
  const mapped = mapPricingSettingsRow(updated);

  await appendAuditLog(trx, {
    action: 'CAT_PRICING_SETTINGS_UPDATED',
    resourceType: 'PRICING_SETTINGS',
    resourceId: trx.tenantId,
    metadata: {
      branchApprovalPolicy: mapped.branchApprovalPolicy,
      allowSelfApproval: mapped.allowSelfApproval,
      defaultPricingMethod: mapped.defaultPricingMethod,
      defaultTargetPercentage: mapped.defaultTargetPercentage,
    },
  });

  return mapped;
}

async function resolveEffectiveRuleForProduct(
  trx: TenantTransactionContext,
  productId: string,
  settings?: Awaited<ReturnType<typeof ensureTenantPricingSettings>>,
): Promise<ProductPricingRuleResponse> {
  const s = settings ?? (await ensureTenantPricingSettings(trx));
  const row = await trx.db
    .selectFrom('product_pricing_rules')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('product_id', '=', productId)
    .executeTakeFirst();

  if (!row) {
    return {
      tenantId: trx.tenantId,
      productId,
      pricingMethod: s.default_pricing_method as PricingMethodType,
      targetPercentage: formatPct2(s.default_target_percentage, '25.00'),
      costBasis: s.default_cost_basis as PricingCostBasisType,
      roundingRule: s.default_rounding_rule as PricingRoundingRuleType,
      minSellingPrice: null,
      minMarginPct: formatPct2(s.default_min_margin_pct, '10.00'),
      maxDiscountPct: formatPct2(s.default_max_discount_pct, '20.00'),
      suggestionsEnabled: true,
      effectiveDate: formatDateOnly(new Date()),
      updatedAt: new Date(s.updated_at).toISOString(),
    };
  }

  return {
    tenantId: row.tenant_id,
    productId: row.product_id,
    pricingMethod: row.pricing_method as PricingMethodType,
    targetPercentage: formatPct2(row.target_percentage, '25.00'),
    costBasis: row.cost_basis as PricingCostBasisType,
    roundingRule: row.rounding_rule as PricingRoundingRuleType,
    minSellingPrice: row.min_selling_price
      ? Money.fromDecimalString(String(row.min_selling_price), 'USD').toDecimalString()
      : null,
    minMarginPct:
      row.min_margin_pct !== null && row.min_margin_pct !== undefined
        ? formatPct2(row.min_margin_pct)
        : formatPct2(s.default_min_margin_pct, '10.00'),
    maxDiscountPct:
      row.max_discount_pct !== null && row.max_discount_pct !== undefined
        ? formatPct2(row.max_discount_pct)
        : formatPct2(s.default_max_discount_pct, '20.00'),
    suggestionsEnabled: Boolean(row.suggestions_enabled),
    effectiveDate: formatDateOnly(row.effective_date),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export async function getProductPricingRule(
  trx: TenantTransactionContext,
  productId: string,
): Promise<ProductPricingRuleResponse> {
  await assertAuthorized(trx, { permission: 'cat:pricing:read' });
  await assertSubscriptionEntitlement(trx, { requireWriteAccess: false });

  const prod = await trx.db
    .selectFrom('products')
    .select(['id'])
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', productId)
    .executeTakeFirst();

  if (!prod) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'ERR_NOT_FOUND',
      title: 'Product Not Found',
      detail: `Product "${productId}" was not found.`,
    });
  }

  return resolveEffectiveRuleForProduct(trx, productId);
}

/**
 * Resolves effective product cost based on the configured cost basis
 * (`LAST_PURCHASE_COST`, `MOVING_AVERAGE_COST`, or `HIGHEST_RECENT_COST`) using exact BigInt arithmetic.
 */
async function resolveCostByBasis(params: {
  readonly trx: TenantTransactionContext;
  readonly productId: string;
  readonly productPurchaseCost: string;
  readonly currencyCode: CurrencyCode;
  readonly costBasis: PricingCostBasisType;
}): Promise<Money> {
  const { trx, productId, productPurchaseCost, currencyCode, costBasis } = params;
  const fallbackCost = Money.fromDecimalString(productPurchaseCost, currencyCode);

  if (costBasis === 'LAST_PURCHASE_COST') {
    return fallbackCost;
  }

  if (costBasis === 'MOVING_AVERAGE_COST') {
    const balances = await trx.db
      .selectFrom('inventory_balances')
      .select(['qty_on_hand', 'moving_avg_cost'])
      .where('tenant_id', '=', trx.tenantId)
      .where('product_id', '=', productId)
      .execute();

    let totalValueScaled = 0n;
    let totalQtyScaled = 0n;
    let highestNonZeroCost: Money | null = null;

    for (const bal of balances) {
      const qty = Quantity.fromDecimalString(String(bal.qty_on_hand));
      const mac = Money.fromDecimalString(String(bal.moving_avg_cost), currencyCode);
      if (mac.scaledUnits > 0n && (!highestNonZeroCost || mac.scaledUnits > highestNonZeroCost.scaledUnits)) {
        highestNonZeroCost = mac;
      }
      if (qty.microUnits > 0n && mac.scaledUnits > 0n) {
        totalValueScaled += (qty.microUnits * mac.scaledUnits) / 1_000_000n;
        totalQtyScaled += qty.microUnits;
      }
    }

    if (totalQtyScaled > 0n && totalValueScaled > 0n) {
      const weightedScaled = (totalValueScaled * 1_000_000n) / totalQtyScaled;
      return Money.fromScaledUnits(weightedScaled, currencyCode);
    }
    return highestNonZeroCost ?? fallbackCost;
  }

  // HIGHEST_RECENT_COST: check recent GRN lines & cost layers vs purchase_cost
  const [layers, grnLines] = await Promise.all([
    trx.db
      .selectFrom('inventory_cost_layers')
      .select(['unit_cost'])
      .where('tenant_id', '=', trx.tenantId)
      .where('product_id', '=', productId)
      .orderBy('created_at', 'desc')
      .limit(10)
      .execute(),
    trx.db
      .selectFrom('goods_receipt_lines')
      .select(['unit_cost_per_base_uom'])
      .where('tenant_id', '=', trx.tenantId)
      .where('product_id', '=', productId)
      .orderBy('created_at', 'desc')
      .limit(10)
      .execute(),
  ]);

  let maxCost = fallbackCost;
  for (const l of layers) {
    const m = Money.fromDecimalString(String(l.unit_cost), currencyCode);
    if (m.scaledUnits > maxCost.scaledUnits) maxCost = m;
  }
  for (const g of grnLines) {
    const m = Money.fromDecimalString(String(g.unit_cost_per_base_uom), currencyCode);
    if (m.scaledUnits > maxCost.scaledUnits) maxCost = m;
  }
  return maxCost;
}

export async function upsertProductPricingRule(
  trx: TenantTransactionContext,
  productId: string,
  input: UpsertProductPricingRuleRequest,
): Promise<{
  rule: ProductPricingRuleResponse;
  createdSuggestion: PriceSuggestionResponse | null;
}> {
  await assertAuthorized(trx, { permission: 'cat:pricing:approve_global' });
  await assertSubscriptionEntitlement(trx, { requireWriteAccess: true });

  const prod = await trx.db
    .selectFrom('products')
    .select(['id', 'sku', 'name', 'purchase_cost', 'selling_price', 'price_uom', 'base_uom'])
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', productId)
    .executeTakeFirst();

  if (!prod) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'ERR_NOT_FOUND',
      title: 'Product Not Found',
      detail: `Product "${productId}" was not found.`,
    });
  }

  const currencyCode = await getTenantBaseCurrency(trx);
  const targetPctStr = formatPct2(input.targetPercentage);
  const minPriceNormalized = input.minSellingPrice
    ? Money.fromDecimalString(input.minSellingPrice, currencyCode).toDecimalString()
    : null;

  try {
    calculateSuggestedSellingPrice({
      cost: String(prod.purchase_cost),
      currencyCode,
      pricingMethod: input.pricingMethod,
      targetPercentage: targetPctStr,
      roundingRule: input.roundingRule,
      minSellingPrice: minPriceNormalized,
    });
  } catch (err) {
    if (err instanceof PricingCalculationError) {
      throw new AppError({
        statusCode: 422,
        errorCode:
          input.pricingMethod === 'PROFIT_MARGIN'
            ? 'PRICING_INVALID_MARGIN_RATE'
            : 'PRICING_INVALID_MARKUP_RATE',
        title: 'Invalid Product Pricing Rule',
        detail: err.message,
      });
    }
    throw err;
  }

  const now = new Date();
  const effectiveDate = input.effectiveDate ?? formatDateOnly(now);

  await trx.db
    .insertInto('product_pricing_rules')
    .values({
      tenant_id: trx.tenantId,
      product_id: productId,
      pricing_method: input.pricingMethod,
      target_percentage: targetPctStr,
      cost_basis: input.costBasis,
      rounding_rule: input.roundingRule,
      min_selling_price: minPriceNormalized,
      min_margin_pct:
        input.minMarginPct !== undefined && input.minMarginPct !== null
          ? formatPct2(input.minMarginPct)
          : null,
      max_discount_pct:
        input.maxDiscountPct !== undefined && input.maxDiscountPct !== null
          ? formatPct2(input.maxDiscountPct)
          : null,
      suggestions_enabled: input.suggestionsEnabled ?? true,
      effective_date: effectiveDate,
      updated_by_user_id: trx.userId,
      created_at: now,
      updated_at: now,
    })
    .onConflict((oc) =>
      oc.columns(['tenant_id', 'product_id']).doUpdateSet({
        pricing_method: input.pricingMethod,
        target_percentage: targetPctStr,
        cost_basis: input.costBasis,
        rounding_rule: input.roundingRule,
        min_selling_price: minPriceNormalized,
        min_margin_pct:
          input.minMarginPct !== undefined && input.minMarginPct !== null
            ? formatPct2(input.minMarginPct)
            : null,
        max_discount_pct:
          input.maxDiscountPct !== undefined && input.maxDiscountPct !== null
            ? formatPct2(input.maxDiscountPct)
            : null,
        suggestions_enabled: input.suggestionsEnabled ?? true,
        effective_date: effectiveDate,
        updated_by_user_id: trx.userId,
        updated_at: now,
      }),
    )
    .execute();

  const rule = await resolveEffectiveRuleForProduct(trx, productId);

  await appendAuditLog(trx, {
    action: 'CAT_PRODUCT_PRICING_RULE_UPDATED',
    resourceType: 'PRODUCT_PRICING_RULE',
    resourceId: productId,
    metadata: {
      pricingMethod: rule.pricingMethod,
      targetPercentage: rule.targetPercentage,
      costBasis: rule.costBasis,
      roundingRule: rule.roundingRule,
      minSellingPrice: rule.minSellingPrice,
      maxDiscountPct: rule.maxDiscountPct,
    },
  });

  let createdSuggestion: PriceSuggestionResponse | null = null;
  if (input.recalculateGlobalSuggestion) {
    const effCost = await resolveCostByBasis({
      trx,
      productId,
      productPurchaseCost: String(prod.purchase_cost),
      currencyCode,
      costBasis: rule.costBasis,
    });
    createdSuggestion = await createSuggestionInternal(trx, {
      productId,
      scope: 'GLOBAL',
      branchId: null,
      sourceEventType: 'GLOBAL_RULE_CHANGE',
      sourceEventKey: null,
      oldCost: effCost.toDecimalString(),
      newCost: effCost.toDecimalString(),
      costBasis: rule.costBasis,
      pricingMethod: rule.pricingMethod,
      targetPercentage: rule.targetPercentage,
      roundingRule: rule.roundingRule,
      minSellingPrice: rule.minSellingPrice,
      effectiveDate,
      reason: `Pricing rule updated (${rule.pricingMethod} ${rule.targetPercentage}%)`,
    });
  }

  return { rule, createdSuggestion };
}

async function hydrateSuggestionRow(
  trx: TenantTransactionContext,
  row: {
    id: string;
    tenant_id: string;
    product_id: string;
    scope: 'GLOBAL' | 'BRANCH';
    branch_id: string | null;
    source_event_type: PriceSuggestionSourceEventType;
    source_event_key: string | null;
    cost_change_direction: 'INCREASE' | 'DECREASE' | 'UNCHANGED';
    old_cost: string;
    new_cost: string;
    cost_basis: PricingCostBasisType;
    current_selling_price: string;
    suggested_selling_price: string;
    final_approved_price: string | null;
    pricing_method: PricingMethodType;
    target_percentage: string;
    rounding_rule: PricingRoundingRuleType;
    reason: string;
    effective_date: string | Date;
    status: PriceSuggestionStatus;
    created_by_user_id: string;
    reviewed_by_user_id: string | null;
    review_notes: string | null;
    deferred_until: string | Date | null;
    created_at: Date;
    reviewed_at: Date | null;
    product_name: string;
    sku: string;
    price_uom: string | null;
    base_uom: string;
    branch_name: string | null;
  },
  currencyCode: CurrencyCode,
): Promise<PriceSuggestionResponse> {
  const newCostStr = Money.fromDecimalString(
    String(row.new_cost),
    currencyCode,
  ).toDecimalString();
  const currentPriceStr = Money.fromDecimalString(
    String(row.current_selling_price),
    currencyCode,
  ).toDecimalString();
  const suggestedPriceStr = Money.fromDecimalString(
    String(row.suggested_selling_price),
    currencyCode,
  ).toDecimalString();

  const expectedProfit = Money.fromDecimalString(suggestedPriceStr, currencyCode).subtract(
    Money.fromDecimalString(newCostStr, currencyCode),
  );

  return {
    id: row.id,
    tenantId: row.tenant_id,
    productId: row.product_id,
    productName: row.product_name,
    sku: row.sku,
    priceUom: (row.price_uom ?? row.base_uom).toUpperCase(),
    scope: row.scope,
    branchId: row.branch_id,
    branchName: row.branch_name,
    sourceEventType: row.source_event_type,
    sourceEventKey: row.source_event_key,
    costChangeDirection: row.cost_change_direction,
    oldCost: Money.fromDecimalString(String(row.old_cost), currencyCode).toDecimalString(),
    newCost: newCostStr,
    costBasis: row.cost_basis,
    currentSellingPrice: currentPriceStr,
    suggestedSellingPrice: suggestedPriceStr,
    finalApprovedPrice: row.final_approved_price
      ? Money.fromDecimalString(
          String(row.final_approved_price),
          currencyCode,
        ).toDecimalString()
      : null,
    pricingMethod: row.pricing_method,
    targetPercentage: formatPct2(row.target_percentage),
    roundingRule: row.rounding_rule,
    reason: row.reason,
    effectiveDate: formatDateOnly(row.effective_date),
    status: row.status,
    currentMarginPct: computeActualMarginPct({
      cost: newCostStr,
      sellingPrice: currentPriceStr,
      currencyCode,
    }),
    suggestedMarginPct: computeActualMarginPct({
      cost: newCostStr,
      sellingPrice: suggestedPriceStr,
      currencyCode,
    }),
    expectedProfitPerUnit: expectedProfit.toDecimalString(),
    createdByUserId: row.created_by_user_id,
    reviewedByUserId: row.reviewed_by_user_id,
    reviewNotes: row.review_notes,
    deferredUntil: row.deferred_until ? formatDateOnly(row.deferred_until) : null,
    createdAt: new Date(row.created_at).toISOString(),
    reviewedAt: row.reviewed_at ? new Date(row.reviewed_at).toISOString() : null,
  };
}

async function getHydratedSuggestionById(
  trx: TenantTransactionContext,
  suggestionId: string,
): Promise<PriceSuggestionResponse | null> {
  const currencyCode = await getTenantBaseCurrency(trx);
  const row = await trx.db
    .selectFrom('price_suggestions')
    .innerJoin('products', (j) =>
      j
        .onRef('price_suggestions.tenant_id', '=', 'products.tenant_id')
        .onRef('price_suggestions.product_id', '=', 'products.id'),
    )
    .leftJoin('branches', (j) =>
      j
        .onRef('price_suggestions.tenant_id', '=', 'branches.tenant_id')
        .onRef('price_suggestions.branch_id', '=', 'branches.id'),
    )
    .select([
      'price_suggestions.id',
      'price_suggestions.tenant_id',
      'price_suggestions.product_id',
      'price_suggestions.scope',
      'price_suggestions.branch_id',
      'price_suggestions.source_event_type',
      'price_suggestions.source_event_key',
      'price_suggestions.cost_change_direction',
      'price_suggestions.old_cost',
      'price_suggestions.new_cost',
      'price_suggestions.cost_basis',
      'price_suggestions.current_selling_price',
      'price_suggestions.suggested_selling_price',
      'price_suggestions.final_approved_price',
      'price_suggestions.pricing_method',
      'price_suggestions.target_percentage',
      'price_suggestions.rounding_rule',
      'price_suggestions.reason',
      'price_suggestions.effective_date',
      'price_suggestions.status',
      'price_suggestions.created_by_user_id',
      'price_suggestions.reviewed_by_user_id',
      'price_suggestions.review_notes',
      'price_suggestions.deferred_until',
      'price_suggestions.created_at',
      'price_suggestions.reviewed_at',
      'products.name as product_name',
      'products.sku as sku',
      'products.price_uom as price_uom',
      'products.base_uom as base_uom',
      'branches.name as branch_name',
    ])
    .where('price_suggestions.tenant_id', '=', trx.tenantId)
    .where('price_suggestions.id', '=', suggestionId)
    .executeTakeFirst();

  if (!row) return null;
  return hydrateSuggestionRow(trx, row, currencyCode);
}

async function createSuggestionInternal(
  trx: TenantTransactionContext,
  params: {
    readonly productId: string;
    readonly scope: PricingScope;
    readonly branchId: string | null;
    readonly sourceEventType: PriceSuggestionSourceEventType;
    readonly sourceEventKey: string | null;
    readonly oldCost: string;
    readonly newCost: string;
    readonly costBasis: PricingCostBasisType;
    readonly pricingMethod: PricingMethodType;
    readonly targetPercentage: string;
    readonly roundingRule: PricingRoundingRuleType;
    readonly minSellingPrice: string | null;
    readonly effectiveDate: string;
    readonly reason: string;
    readonly explicitProposedPrice?: string | undefined;
  },
): Promise<PriceSuggestionResponse | null> {
  const currencyCode = await getTenantBaseCurrency(trx);
  const product = await trx.db
    .selectFrom('products')
    .select(['id', 'selling_price'])
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', params.productId)
    .executeTakeFirstOrThrow();

  // Deduplicate if the exact source_event_key already has a PENDING suggestion
  if (params.sourceEventKey) {
    const existingPending = await trx.db
      .selectFrom('price_suggestions')
      .select(['id'])
      .where('tenant_id', '=', trx.tenantId)
      .where('source_event_key', '=', params.sourceEventKey)
      .where('status', '=', 'PENDING')
      .executeTakeFirst();

    if (existingPending) {
      return getHydratedSuggestionById(trx, existingPending.id);
    }
  }

  let currentPriceStr = Money.fromDecimalString(
    String(product.selling_price),
    currencyCode,
  ).toDecimalString();

  if (params.scope === 'BRANCH' && params.branchId) {
    const branchRow = await trx.db
      .selectFrom('product_branch_prices')
      .select(['selling_price'])
      .where('tenant_id', '=', trx.tenantId)
      .where('product_id', '=', params.productId)
      .where('branch_id', '=', params.branchId)
      .where('is_active', '=', true)
      .executeTakeFirst();

    if (branchRow) {
      currentPriceStr = Money.fromDecimalString(
        String(branchRow.selling_price),
        currencyCode,
      ).toDecimalString();
    }
  }

  const oldCostMoney = Money.fromDecimalString(params.oldCost, currencyCode);
  const newCostMoney = Money.fromDecimalString(params.newCost, currencyCode);
  const direction: 'INCREASE' | 'DECREASE' | 'UNCHANGED' =
    newCostMoney.scaledUnits > oldCostMoney.scaledUnits
      ? 'INCREASE'
      : newCostMoney.scaledUnits < oldCostMoney.scaledUnits
        ? 'DECREASE'
        : 'UNCHANGED';

  let suggestedPriceStr: string;
  if (params.explicitProposedPrice) {
    suggestedPriceStr = Money.fromDecimalString(
      params.explicitProposedPrice,
      currencyCode,
    ).toDecimalString();
  } else {
    const calc = calculateSuggestedSellingPrice({
      cost: newCostMoney.toDecimalString(),
      currencyCode,
      pricingMethod: params.pricingMethod,
      targetPercentage: params.targetPercentage,
      roundingRule: params.roundingRule,
      minSellingPrice: params.minSellingPrice,
    });
    suggestedPriceStr = calc.suggestedPrice;
  }

  const now = new Date();
  const suggestionId = generateUuidV7();

  await trx.db
    .insertInto('price_suggestions')
    .values({
      id: suggestionId,
      tenant_id: trx.tenantId,
      product_id: params.productId,
      scope: params.scope,
      branch_id: params.scope === 'BRANCH' ? params.branchId : null,
      source_event_type: params.sourceEventType,
      source_event_key: params.sourceEventKey,
      cost_change_direction: direction,
      old_cost: oldCostMoney.toDecimalString(),
      new_cost: newCostMoney.toDecimalString(),
      cost_basis: params.costBasis,
      current_selling_price: currentPriceStr,
      suggested_selling_price: suggestedPriceStr,
      final_approved_price: null,
      pricing_method: params.pricingMethod,
      target_percentage: formatPct2(params.targetPercentage),
      rounding_rule: params.roundingRule,
      reason: params.reason.trim(),
      effective_date: params.effectiveDate,
      status: 'PENDING',
      created_by_user_id: trx.userId,
      reviewed_by_user_id: null,
      review_notes: null,
      deferred_until: null,
      created_at: now,
      reviewed_at: null,
    })
    .execute();

  return getHydratedSuggestionById(trx, suggestionId);
}

/**
 * Automatic hook invoked by Purchasing (GRN), Catalog (Cost Edit), and Inventory (Stock Movement Cost).
 * Detects cost change, reads product/tenant pricing configuration, generates a deduplicated PENDING suggestion,
 * and NEVER silently overwrites the active selling price.
 */
export async function triggerCostChangeSuggestionIfApplicable(
  trx: TenantTransactionContext,
  params: {
    readonly productId: string;
    readonly oldCost: string;
    readonly newCost: string;
    readonly movingAvgCost?: string;
    readonly sourceEventType: 'GRN_POSTED' | 'COST_EDIT' | 'STOCK_MOVEMENT';
    readonly sourceEventKey: string;
    readonly reason: string;
    readonly scopeBranchId?: string | null;
  },
): Promise<PriceSuggestionResponse | null> {
  const settings = await ensureTenantPricingSettings(trx);
  if (!settings.auto_create_suggestions_on_cost_change) {
    return null;
  }

  const currencyCode = await getTenantBaseCurrency(trx);
  const oldCostMoney = Money.fromDecimalString(params.oldCost, currencyCode);
  const newCostMoney = Money.fromDecimalString(params.newCost, currencyCode);

  if (oldCostMoney.scaledUnits === newCostMoney.scaledUnits) {
    return null;
  }

  const isDecrease = newCostMoney.scaledUnits < oldCostMoney.scaledUnits;
  if (isDecrease && !settings.auto_create_suggestions_on_cost_decrease) {
    return null;
  }

  const rule = await resolveEffectiveRuleForProduct(trx, params.productId, settings);
  if (!rule.suggestionsEnabled) {
    return null;
  }

  let basisCostStr = newCostMoney.toDecimalString();
  if (rule.costBasis === 'MOVING_AVERAGE_COST') {
    if (params.movingAvgCost) {
      basisCostStr = Money.fromDecimalString(
        params.movingAvgCost,
        currencyCode,
      ).toDecimalString();
    } else {
      basisCostStr = (
        await resolveCostByBasis({
          trx,
          productId: params.productId,
          productPurchaseCost: newCostMoney.toDecimalString(),
          currencyCode,
          costBasis: 'MOVING_AVERAGE_COST',
        })
      ).toDecimalString();
    }
  } else if (rule.costBasis === 'HIGHEST_RECENT_COST') {
    const highest = await resolveCostByBasis({
      trx,
      productId: params.productId,
      productPurchaseCost: newCostMoney.toDecimalString(),
      currencyCode,
      costBasis: 'HIGHEST_RECENT_COST',
    });
    basisCostStr =
      newCostMoney.scaledUnits > highest.scaledUnits
        ? newCostMoney.toDecimalString()
        : highest.toDecimalString();
  }

  // Deduplicate exact same event key first
  const existingExact = await trx.db
    .selectFrom('price_suggestions')
    .select(['id'])
    .where('tenant_id', '=', trx.tenantId)
    .where('source_event_key', '=', params.sourceEventKey)
    .where('status', '=', 'PENDING')
    .executeTakeFirst();
  if (existingExact) {
    return getHydratedSuggestionById(trx, existingExact.id);
  }

  // Supersede older stale auto-cost PENDING GLOBAL suggestions so the queue stays clean & accurate
  await trx.db
    .updateTable('price_suggestions')
    .set({
      status: 'SUPERSEDED',
      reviewed_at: new Date(),
      review_notes: `Superseded by newer cost event (${params.sourceEventType}).`,
    })
    .where('tenant_id', '=', trx.tenantId)
    .where('product_id', '=', params.productId)
    .where('scope', '=', 'GLOBAL')
    .where('status', '=', 'PENDING')
    .where('source_event_type', 'in', ['GRN_POSTED', 'COST_EDIT', 'STOCK_MOVEMENT'])
    .execute();

  return createSuggestionInternal(trx, {
    productId: params.productId,
    scope: 'GLOBAL',
    branchId: null,
    sourceEventType: params.sourceEventType,
    sourceEventKey: params.sourceEventKey,
    oldCost: oldCostMoney.toDecimalString(),
    newCost: basisCostStr,
    costBasis: rule.costBasis,
    pricingMethod: rule.pricingMethod,
    targetPercentage: rule.targetPercentage,
    roundingRule: rule.roundingRule,
    minSellingPrice: rule.minSellingPrice,
    effectiveDate: formatDateOnly(new Date()),
    reason: params.reason,
  });
}

export async function createPriceSuggestion(
  trx: TenantTransactionContext,
  input: CreatePriceSuggestionRequest,
): Promise<PriceSuggestionResponse> {
  if (input.scope === 'BRANCH') {
    if (!input.branchId) {
      throw new AppError({
        statusCode: 400,
        errorCode: 'ORG_BRANCH_NOT_FOUND',
        title: 'Branch Required',
        detail: 'branchId is required when creating a BRANCH pricing suggestion.',
      });
    }
    await assertAuthorized(trx, {
      permission: 'cat:pricing:suggest',
      branchId: input.branchId,
    });
    const branch = await trx.db
      .selectFrom('branches')
      .select(['id'])
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', input.branchId)
      .executeTakeFirst();
    if (!branch) {
      throw new AppError({
        statusCode: 404,
        errorCode: 'ORG_BRANCH_NOT_FOUND',
        title: 'Branch Not Found',
        detail: `Branch "${input.branchId}" was not found.`,
      });
    }
  } else {
    await assertAuthorized(trx, {
      permission: 'cat:pricing:suggest',
      requireAllLocationsAccess: true,
    });
  }

  await assertSubscriptionEntitlement(trx, { requireWriteAccess: true });

  const prod = await trx.db
    .selectFrom('products')
    .select(['id', 'purchase_cost', 'selling_price'])
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', input.productId)
    .executeTakeFirst();

  if (!prod) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'ERR_NOT_FOUND',
      title: 'Product Not Found',
      detail: `Product "${input.productId}" was not found.`,
    });
  }

  const currencyCode = await getTenantBaseCurrency(trx);
  const rule = await resolveEffectiveRuleForProduct(trx, input.productId);
  const method = input.pricingMethod ?? rule.pricingMethod;
  const targetPct = formatPct2(input.targetPercentage ?? rule.targetPercentage);
  const roundingRule = input.roundingRule ?? rule.roundingRule;
  const costBasis = input.costBasis ?? rule.costBasis;

  const costMoney = input.costOverride
    ? Money.fromDecimalString(input.costOverride, currencyCode)
    : await resolveCostByBasis({
        trx,
        productId: input.productId,
        productPurchaseCost: String(prod.purchase_cost),
        currencyCode,
        costBasis,
      });

  // Validate formula first
  try {
    if (!input.proposedPrice) {
      calculateSuggestedSellingPrice({
        cost: costMoney.toDecimalString(),
        currencyCode,
        pricingMethod: method,
        targetPercentage: targetPct,
        roundingRule,
        minSellingPrice: rule.minSellingPrice,
      });
    }
  } catch (err) {
    if (err instanceof PricingCalculationError) {
      throw new AppError({
        statusCode: 422,
        errorCode:
          method === 'PROFIT_MARGIN'
            ? 'PRICING_INVALID_MARGIN_RATE'
            : 'PRICING_INVALID_MARKUP_RATE',
        title: 'Invalid Pricing Parameters',
        detail: err.message,
      });
    }
    throw err;
  }

  const created = await createSuggestionInternal(trx, {
    productId: input.productId,
    scope: input.scope,
    branchId: input.scope === 'BRANCH' ? (input.branchId ?? null) : null,
    sourceEventType: input.scope === 'BRANCH' ? 'BRANCH_PROPOSAL' : 'MANUAL_RECALC',
    sourceEventKey: null,
    oldCost: String(prod.purchase_cost),
    newCost: costMoney.toDecimalString(),
    costBasis,
    pricingMethod: method,
    targetPercentage: targetPct,
    roundingRule,
    minSellingPrice: rule.minSellingPrice,
    effectiveDate: input.effectiveDate ?? formatDateOnly(new Date()),
    reason: input.reason,
    explicitProposedPrice: input.proposedPrice,
  });

  if (!created) {
    throw new AppError({
      statusCode: 500,
      errorCode: 'ERR_INTERNAL_SERVER_ERROR',
      title: 'Failed to Create Suggestion',
      detail: 'Unable to persist price suggestion.',
    });
  }

  await appendAuditLog(trx, {
    action: 'CAT_PRICE_SUGGESTION_CREATED',
    resourceType: 'PRICE_SUGGESTION',
    resourceId: created.id,
    metadata: {
      productId: created.productId,
      scope: created.scope,
      branchId: created.branchId,
      suggestedSellingPrice: created.suggestedSellingPrice,
    },
  });

  return created;
}

export async function approvePriceSuggestion(
  trx: TenantTransactionContext,
  suggestionId: string,
  input: ApprovePriceSuggestionRequest = {},
): Promise<PriceSuggestionResponse> {
  const row = await trx.db
    .selectFrom('price_suggestions')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', suggestionId)
    .forUpdate()
    .executeTakeFirst();

  if (!row) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'PRICING_SUGGESTION_NOT_FOUND',
      title: 'Price Suggestion Not Found',
      detail: `Price suggestion "${suggestionId}" was not found.`,
    });
  }

  if (row.status !== 'PENDING' && row.status !== 'DEFERRED') {
    throw new AppError({
      statusCode: 409,
      errorCode: 'PRICING_INVALID_SUGGESTION_STATUS',
      title: 'Suggestion Already Resolved',
      detail: `Suggestion is currently "${row.status}" and cannot be approved again.`,
    });
  }

  const settings = await ensureTenantPricingSettings(trx);

  // Enforce approval permissions & Mode A vs Mode B policy
  let isOwnerOrAdmin = false;
  if (row.scope === 'GLOBAL') {
    const authCtx = await assertAuthorized(trx, {
      permission: 'cat:pricing:approve_global',
    });
    isOwnerOrAdmin =
      authCtx.roleCodes.includes('TENANT_OWNER') ||
      authCtx.roleCodes.includes('ORG_ADMIN');
    if (!isOwnerOrAdmin) {
      throw new AppError({
        statusCode: 403,
        errorCode: 'PRICING_APPROVAL_POLICY_FORBIDDEN',
        title: 'Global Price Authority Required',
        detail: 'Only Organization Owners or Administrators can approve global catalog prices.',
      });
    }
  } else {
    const authCtx = await assertAuthorized(trx, {
      permission: 'cat:pricing:approve_branch',
      branchId: row.branch_id ?? undefined,
    });
    isOwnerOrAdmin =
      authCtx.roleCodes.includes('TENANT_OWNER') ||
      authCtx.roleCodes.includes('ORG_ADMIN');
    if (settings.branch_approval_policy === 'OWNER_ADMIN_ONLY' && !isOwnerOrAdmin) {
      throw new AppError({
        statusCode: 403,
        errorCode: 'PRICING_APPROVAL_POLICY_FORBIDDEN',
        title: 'Owner/Admin Approval Policy Enabled (Mode A)',
        detail:
          'This organization requires an Owner or Admin to approve branch price overrides (Mode A).',
      });
    }
  }

  // Self-approval restriction check
  const requiresDualControl =
    row.source_event_type === 'BRANCH_PROPOSAL' ||
    row.source_event_type === 'MANUAL_RECALC';
  if (
    !settings.allow_self_approval &&
    requiresDualControl &&
    row.created_by_user_id === trx.userId
  ) {
    throw new AppError({
      statusCode: 403,
      errorCode: 'PRICING_SELF_APPROVAL_FORBIDDEN',
      title: 'Self-Approval Not Permitted',
      detail:
        'Your pricing policy prohibits approving a price proposal you submitted yourself.',
    });
  }

  await assertSubscriptionEntitlement(trx, { requireWriteAccess: true });

  const currencyCode = await getTenantBaseCurrency(trx);
  const product = await trx.db
    .selectFrom('products')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', row.product_id)
    .forUpdate()
    .executeTakeFirstOrThrow();

  const rule = await resolveEffectiveRuleForProduct(trx, row.product_id, settings);

  const suggestedMoney = Money.fromDecimalString(
    String(row.suggested_selling_price),
    currencyCode,
  );
  const approvedMoney = input.overridePrice
    ? Money.fromDecimalString(input.overridePrice, currencyCode)
    : suggestedMoney;

  // Enforce minimum selling price floor unless Owner/Admin specifies override reason
  if (rule.minSellingPrice) {
    const floorMoney = Money.fromDecimalString(rule.minSellingPrice, currencyCode);
    if (
      approvedMoney.scaledUnits < floorMoney.scaledUnits &&
      !(isOwnerOrAdmin && input.bypassFloorWithReason)
    ) {
      throw new AppError({
        statusCode: 422,
        errorCode: 'PRICING_MIN_PRICE_VIOLATION',
        title: 'Selling Price Below Configured Minimum',
        detail: `Approved price (${approvedMoney.toDecimalString()}) is below configured minimum selling price (${floorMoney.toDecimalString()}).`,
      });
    }
  }

  const now = new Date();
  const effectiveDate = input.effectiveDate ?? formatDateOnly(row.effective_date);
  const isModified = approvedMoney.scaledUnits !== suggestedMoney.scaledUnits;
  const nextStatus: PriceSuggestionStatus = isModified
    ? 'MODIFIED_APPROVED'
    : 'APPROVED';

  let previousPriceStr = Money.fromDecimalString(
    String(product.selling_price),
    currencyCode,
  ).toDecimalString();

  if (row.scope === 'GLOBAL') {
    await trx.db
      .updateTable('products')
      .set({
        selling_price: approvedMoney.toDecimalString(),
        sync_version: Number(product.sync_version) + 1,
        updated_at: now,
      })
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', product.id)
      .execute();

    // Flag active branch overrides for reassessment WITHOUT silently overwriting their prices (PRICE-16)
    await trx.db
      .updateTable('product_branch_prices')
      .set({
        needs_review: true,
        review_reason: `Global base price updated from ${previousPriceStr} to ${approvedMoney.toDecimalString()}; review branch override.`,
        updated_at: now,
      })
      .where('tenant_id', '=', trx.tenantId)
      .where('product_id', '=', product.id)
      .where('is_active', '=', true)
      .execute();
  } else {
    const branchId = row.branch_id!;
    const existingBranchPrice = await trx.db
      .selectFrom('product_branch_prices')
      .selectAll()
      .where('tenant_id', '=', trx.tenantId)
      .where('product_id', '=', product.id)
      .where('branch_id', '=', branchId)
      .forUpdate()
      .executeTakeFirst();

    if (existingBranchPrice) {
      previousPriceStr = Money.fromDecimalString(
        String(existingBranchPrice.selling_price),
        currencyCode,
      ).toDecimalString();

      await trx.db
        .updateTable('product_branch_prices')
        .set({
          selling_price: approvedMoney.toDecimalString(),
          pricing_method: row.pricing_method,
          target_percentage: formatPct2(row.target_percentage),
          rounding_rule: row.rounding_rule,
          min_selling_price: rule.minSellingPrice,
          max_discount_pct: rule.maxDiscountPct,
          effective_date: effectiveDate,
          is_active: true,
          needs_review: false,
          review_reason: null,
          approved_by_user_id: trx.userId,
          approved_at: now,
          sync_version: Number(existingBranchPrice.sync_version) + 1,
          updated_at: now,
        })
        .where('tenant_id', '=', trx.tenantId)
        .where('id', '=', existingBranchPrice.id)
        .execute();
    } else {
      await trx.db
        .insertInto('product_branch_prices')
        .values({
          id: generateUuidV7(),
          tenant_id: trx.tenantId,
          product_id: product.id,
          branch_id: branchId,
          selling_price: approvedMoney.toDecimalString(),
          pricing_method: row.pricing_method,
          target_percentage: formatPct2(row.target_percentage),
          rounding_rule: row.rounding_rule,
          min_selling_price: rule.minSellingPrice,
          max_discount_pct: rule.maxDiscountPct,
          effective_date: effectiveDate,
          is_active: true,
          needs_review: false,
          review_reason: null,
          approved_by_user_id: trx.userId,
          approved_at: now,
          sync_version: 1,
          created_at: now,
          updated_at: now,
        })
        .execute();
    }
  }

  await trx.db
    .updateTable('price_suggestions')
    .set({
      status: nextStatus,
      final_approved_price: approvedMoney.toDecimalString(),
      effective_date: effectiveDate,
      reviewed_by_user_id: trx.userId,
      review_notes: input.reviewNotes?.trim() || input.bypassFloorWithReason?.trim() || null,
      reviewed_at: now,
    })
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', row.id)
    .execute();

  // Immutable append-only audit entry in product_price_history
  await trx.db
    .insertInto('product_price_history')
    .values({
      id: generateUuidV7(),
      tenant_id: trx.tenantId,
      product_id: row.product_id,
      scope: row.scope,
      branch_id: row.branch_id,
      suggestion_id: row.id,
      previous_price: previousPriceStr,
      new_price: approvedMoney.toDecimalString(),
      cost_snapshot: Money.fromDecimalString(
        String(row.new_cost),
        currencyCode,
      ).toDecimalString(),
      pricing_method: row.pricing_method,
      target_percentage: formatPct2(row.target_percentage),
      rounding_rule: row.rounding_rule,
      reason: input.reviewNotes?.trim() || row.reason,
      actor_user_id: row.created_by_user_id,
      approver_user_id: trx.userId,
      effective_date: effectiveDate,
      approved_at: now,
      created_at: now,
    })
    .execute();

  await appendAuditLog(trx, {
    action: `CAT_PRICE_SUGGESTION_${nextStatus}`,
    resourceType: 'PRICE_SUGGESTION',
    resourceId: row.id,
    metadata: {
      productId: row.product_id,
      scope: row.scope,
      branchId: row.branch_id,
      previousPrice: previousPriceStr,
      newPrice: approvedMoney.toDecimalString(),
      effectiveDate,
    },
  });

  await enqueueOutboxEvent(trx, {
    aggregateType: 'PRODUCT',
    aggregateId: row.product_id,
    eventType: 'PRICE_CHANGED',
    payload: {
      productId: row.product_id,
      scope: row.scope,
      branchId: row.branch_id,
      previousPrice: previousPriceStr,
      newPrice: approvedMoney.toDecimalString(),
      effectiveDate,
    },
  });

  realtimeEventHub.publish({
    tenantId: trx.tenantId,
    branchId: row.branch_id ?? null,
    eventType: 'PRICE_CHANGED',
    data: {
      productId: row.product_id,
      sku: product.sku,
      scope: row.scope,
      branchId: row.branch_id,
      previousPrice: previousPriceStr,
      newPrice: approvedMoney.toDecimalString(),
      effectiveDate,
    },
  });

  return (await getHydratedSuggestionById(trx, row.id))!;
}

export async function rejectOrDeferPriceSuggestion(
  trx: TenantTransactionContext,
  suggestionId: string,
  input: RejectOrDeferPriceSuggestionRequest,
): Promise<PriceSuggestionResponse> {
  const row = await trx.db
    .selectFrom('price_suggestions')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', suggestionId)
    .forUpdate()
    .executeTakeFirst();

  if (!row) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'PRICING_SUGGESTION_NOT_FOUND',
      title: 'Price Suggestion Not Found',
      detail: `Price suggestion "${suggestionId}" was not found.`,
    });
  }

  if (row.status !== 'PENDING' && row.status !== 'DEFERRED') {
    throw new AppError({
      statusCode: 409,
      errorCode: 'PRICING_INVALID_SUGGESTION_STATUS',
      title: 'Suggestion Already Resolved',
      detail: `Suggestion is currently "${row.status}" and cannot be updated.`,
    });
  }

  if (input.action === 'DEFER') {
    await assertAuthorized(trx, {
      permission: 'cat:pricing:suggest',
      ...(row.scope === 'BRANCH' && row.branch_id
        ? { branchId: row.branch_id }
        : {}),
    });
  } else {
    const settings = await ensureTenantPricingSettings(trx);
    if (row.scope === 'GLOBAL') {
      await assertAuthorized(trx, { permission: 'cat:pricing:approve_global' });
    } else {
      const authCtx = await assertAuthorized(trx, {
        permission: 'cat:pricing:approve_branch',
        branchId: row.branch_id ?? undefined,
      });
      const isOwnerOrAdmin =
        authCtx.roleCodes.includes('TENANT_OWNER') ||
        authCtx.roleCodes.includes('ORG_ADMIN');
      if (settings.branch_approval_policy === 'OWNER_ADMIN_ONLY' && !isOwnerOrAdmin) {
        throw new AppError({
          statusCode: 403,
          errorCode: 'PRICING_APPROVAL_POLICY_FORBIDDEN',
          title: 'Owner/Admin Policy Enforced',
          detail: 'Only Owners or Admins can reject branch overrides under Mode A.',
        });
      }
    }
  }

  await assertSubscriptionEntitlement(trx, { requireWriteAccess: true });

  const now = new Date();
  const nextStatus: PriceSuggestionStatus =
    input.action === 'DEFER' ? 'DEFERRED' : 'REJECTED';

  await trx.db
    .updateTable('price_suggestions')
    .set({
      status: nextStatus,
      reviewed_by_user_id: trx.userId,
      review_notes: input.reviewNotes.trim(),
      deferred_until: input.action === 'DEFER' ? (input.deferredUntil ?? null) : null,
      reviewed_at: now,
    })
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', row.id)
    .execute();

  await appendAuditLog(trx, {
    action: `CAT_PRICE_SUGGESTION_${nextStatus}`,
    resourceType: 'PRICE_SUGGESTION',
    resourceId: row.id,
    metadata: {
      productId: row.product_id,
      scope: row.scope,
      branchId: row.branch_id,
      reviewNotes: input.reviewNotes,
    },
  });

  return (await getHydratedSuggestionById(trx, row.id))!;
}

export async function listPriceSuggestions(
  trx: TenantTransactionContext,
  query: {
    status?: PriceSuggestionStatus;
    scope?: PricingScope;
    branchId?: string;
    productId?: string;
    limit?: number;
  } = {},
): Promise<PriceSuggestionResponse[]> {
  const authCtx = await assertAuthorized(trx, {
    permission: 'cat:pricing:read',
    ...(query.branchId ? { branchId: query.branchId } : {}),
  });
  await assertSubscriptionEntitlement(trx, { requireWriteAccess: false });

  const currencyCode = await getTenantBaseCurrency(trx);
  const limit = Math.min(Math.max(Number(query.limit ?? 50), 1), 100);

  let dbQuery = trx.db
    .selectFrom('price_suggestions')
    .innerJoin('products', (j) =>
      j
        .onRef('price_suggestions.tenant_id', '=', 'products.tenant_id')
        .onRef('price_suggestions.product_id', '=', 'products.id'),
    )
    .leftJoin('branches', (j) =>
      j
        .onRef('price_suggestions.tenant_id', '=', 'branches.tenant_id')
        .onRef('price_suggestions.branch_id', '=', 'branches.id'),
    )
    .select([
      'price_suggestions.id',
      'price_suggestions.tenant_id',
      'price_suggestions.product_id',
      'price_suggestions.scope',
      'price_suggestions.branch_id',
      'price_suggestions.source_event_type',
      'price_suggestions.source_event_key',
      'price_suggestions.cost_change_direction',
      'price_suggestions.old_cost',
      'price_suggestions.new_cost',
      'price_suggestions.cost_basis',
      'price_suggestions.current_selling_price',
      'price_suggestions.suggested_selling_price',
      'price_suggestions.final_approved_price',
      'price_suggestions.pricing_method',
      'price_suggestions.target_percentage',
      'price_suggestions.rounding_rule',
      'price_suggestions.reason',
      'price_suggestions.effective_date',
      'price_suggestions.status',
      'price_suggestions.created_by_user_id',
      'price_suggestions.reviewed_by_user_id',
      'price_suggestions.review_notes',
      'price_suggestions.deferred_until',
      'price_suggestions.created_at',
      'price_suggestions.reviewed_at',
      'products.name as product_name',
      'products.sku as sku',
      'products.price_uom as price_uom',
      'products.base_uom as base_uom',
      'branches.name as branch_name',
    ])
    .where('price_suggestions.tenant_id', '=', trx.tenantId)
    .orderBy('price_suggestions.created_at', 'desc')
    .limit(limit);

  if (query.status) {
    dbQuery = dbQuery.where('price_suggestions.status', '=', query.status);
  }
  if (query.scope) {
    dbQuery = dbQuery.where('price_suggestions.scope', '=', query.scope);
  }
  if (query.branchId) {
    dbQuery = dbQuery.where('price_suggestions.branch_id', '=', query.branchId);
  }
  if (query.productId) {
    dbQuery = dbQuery.where('price_suggestions.product_id', '=', query.productId);
  }

  const rows = await dbQuery.execute();
  const visibleRows = authCtx.allLocationsAccess
    ? rows
    : rows.filter(
        (r) =>
          r.scope === 'GLOBAL' ||
          (r.branch_id !== null && authCtx.allowedBranchIds.has(r.branch_id)),
      );

  return Promise.all(
    visibleRows.map((r) => hydrateSuggestionRow(trx, r, currencyCode)),
  );
}

export async function listBranchPriceOverrides(
  trx: TenantTransactionContext,
  query: {
    branchId?: string;
    productId?: string;
    needsReviewOnly?: boolean;
  } = {},
): Promise<BranchPriceOverrideResponse[]> {
  const authCtx = await assertAuthorized(trx, {
    permission: 'cat:pricing:read',
    ...(query.branchId ? { branchId: query.branchId } : {}),
  });
  await assertSubscriptionEntitlement(trx, { requireWriteAccess: false });

  const currencyCode = await getTenantBaseCurrency(trx);
  let dbQuery = trx.db
    .selectFrom('product_branch_prices')
    .innerJoin('products', (j) =>
      j
        .onRef('product_branch_prices.tenant_id', '=', 'products.tenant_id')
        .onRef('product_branch_prices.product_id', '=', 'products.id'),
    )
    .innerJoin('branches', (j) =>
      j
        .onRef('product_branch_prices.tenant_id', '=', 'branches.tenant_id')
        .onRef('product_branch_prices.branch_id', '=', 'branches.id'),
    )
    .select([
      'product_branch_prices.id',
      'product_branch_prices.tenant_id',
      'product_branch_prices.product_id',
      'products.name as product_name',
      'products.sku as sku',
      'products.selling_price as global_selling_price',
      'product_branch_prices.branch_id',
      'branches.name as branch_name',
      'product_branch_prices.selling_price',
      'product_branch_prices.pricing_method',
      'product_branch_prices.target_percentage',
      'product_branch_prices.rounding_rule',
      'product_branch_prices.min_selling_price',
      'product_branch_prices.max_discount_pct',
      'product_branch_prices.effective_date',
      'product_branch_prices.is_active',
      'product_branch_prices.needs_review',
      'product_branch_prices.review_reason',
      'product_branch_prices.approved_at',
      'product_branch_prices.sync_version',
    ])
    .where('product_branch_prices.tenant_id', '=', trx.tenantId)
    .orderBy('product_branch_prices.updated_at', 'desc');

  if (query.branchId) {
    dbQuery = dbQuery.where('product_branch_prices.branch_id', '=', query.branchId);
  }
  if (query.productId) {
    dbQuery = dbQuery.where('product_branch_prices.product_id', '=', query.productId);
  }
  if (query.needsReviewOnly) {
    dbQuery = dbQuery.where('product_branch_prices.needs_review', '=', true);
  }
  if (!authCtx.allLocationsAccess) {
    const allowed = [...authCtx.allowedBranchIds];
    if (allowed.length === 0) return [];
    dbQuery = dbQuery.where('product_branch_prices.branch_id', 'in', allowed);
  }

  const rows = await dbQuery.execute();
  return rows.map((r) => ({
    id: r.id,
    tenantId: r.tenant_id,
    productId: r.product_id,
    productName: r.product_name,
    sku: r.sku,
    branchId: r.branch_id,
    branchName: r.branch_name,
    globalSellingPrice: Money.fromDecimalString(
      String(r.global_selling_price),
      currencyCode,
    ).toDecimalString(),
    sellingPrice: Money.fromDecimalString(
      String(r.selling_price),
      currencyCode,
    ).toDecimalString(),
    pricingMethod: r.pricing_method as PricingMethodType,
    targetPercentage:
      r.target_percentage !== null && r.target_percentage !== undefined
        ? formatPct2(r.target_percentage)
        : null,
    roundingRule: r.rounding_rule as PricingRoundingRuleType,
    minSellingPrice: r.min_selling_price
      ? Money.fromDecimalString(String(r.min_selling_price), currencyCode).toDecimalString()
      : null,
    maxDiscountPct:
      r.max_discount_pct !== null && r.max_discount_pct !== undefined
        ? formatPct2(r.max_discount_pct)
        : null,
    effectiveDate: formatDateOnly(r.effective_date),
    isActive: Boolean(r.is_active),
    needsReview: Boolean(r.needs_review),
    reviewReason: r.review_reason,
    approvedAt: r.approved_at ? new Date(r.approved_at).toISOString() : null,
    syncVersion: Number(r.sync_version),
  }));
}

export async function acknowledgeOrDeactivateBranchOverride(
  trx: TenantTransactionContext,
  overrideId: string,
  action: 'CLEAR_REVIEW' | 'REVERT_TO_GLOBAL',
): Promise<BranchPriceOverrideResponse> {
  const existing = await trx.db
    .selectFrom('product_branch_prices')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', overrideId)
    .forUpdate()
    .executeTakeFirst();

  if (!existing) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'ERR_NOT_FOUND',
      title: 'Branch Price Override Not Found',
      detail: `Branch price override "${overrideId}" was not found.`,
    });
  }

  const settings = await ensureTenantPricingSettings(trx);
  const authCtx = await assertAuthorized(trx, {
    permission: 'cat:pricing:approve_branch',
    branchId: existing.branch_id,
  });
  const isOwnerOrAdmin =
    authCtx.roleCodes.includes('TENANT_OWNER') ||
    authCtx.roleCodes.includes('ORG_ADMIN');
  if (settings.branch_approval_policy === 'OWNER_ADMIN_ONLY' && !isOwnerOrAdmin) {
    throw new AppError({
      statusCode: 403,
      errorCode: 'PRICING_APPROVAL_POLICY_FORBIDDEN',
      title: 'Owner/Admin Policy Enforced',
      detail: 'Mode A requires Owner or Admin authorization to manage branch overrides.',
    });
  }

  const now = new Date();
  await trx.db
    .updateTable('product_branch_prices')
    .set({
      needs_review: false,
      review_reason: null,
      ...(action === 'REVERT_TO_GLOBAL' ? { is_active: false } : {}),
      sync_version: Number(existing.sync_version) + 1,
      updated_at: now,
    })
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', existing.id)
    .execute();

  if (action === 'REVERT_TO_GLOBAL') {
    const product = await trx.db
      .selectFrom('products')
      .select(['selling_price', 'purchase_cost', 'sku'])
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', existing.product_id)
      .executeTakeFirstOrThrow();

    await trx.db
      .insertInto('product_price_history')
      .values({
        id: generateUuidV7(),
        tenant_id: trx.tenantId,
        product_id: existing.product_id,
        scope: 'BRANCH',
        branch_id: existing.branch_id,
        suggestion_id: null,
        previous_price: String(existing.selling_price),
        new_price: String(product.selling_price),
        cost_snapshot: String(product.purchase_cost),
        pricing_method: existing.pricing_method,
        target_percentage: existing.target_percentage,
        rounding_rule: existing.rounding_rule,
        reason: 'Branch price override deactivated; reverted to inherited global price.',
        actor_user_id: trx.userId,
        approver_user_id: trx.userId,
        effective_date: formatDateOnly(now),
        approved_at: now,
        created_at: now,
      })
      .execute();

    realtimeEventHub.publish({
      tenantId: trx.tenantId,
      branchId: existing.branch_id,
      eventType: 'PRICE_CHANGED',
      data: {
        productId: existing.product_id,
        sku: product.sku,
        scope: 'BRANCH',
        branchId: existing.branch_id,
        previousPrice: String(existing.selling_price),
        newPrice: String(product.selling_price),
      },
    });
  }

  const list = await listBranchPriceOverrides(trx, {
    branchId: existing.branch_id,
    productId: existing.product_id,
  });
  return list[0]!;
}

export async function listProductPriceHistory(
  trx: TenantTransactionContext,
  query: { productId?: string; branchId?: string; limit?: number } = {},
): Promise<ProductPriceHistoryResponse[]> {
  const authCtx = await assertAuthorized(trx, {
    permission: 'cat:pricing:read',
    ...(query.branchId ? { branchId: query.branchId } : {}),
  });
  await assertSubscriptionEntitlement(trx, { requireWriteAccess: false });

  const currencyCode = await getTenantBaseCurrency(trx);
  const limit = Math.min(Math.max(Number(query.limit ?? 50), 1), 100);

  let dbQuery = trx.db
    .selectFrom('product_price_history')
    .innerJoin('products', (j) =>
      j
        .onRef('product_price_history.tenant_id', '=', 'products.tenant_id')
        .onRef('product_price_history.product_id', '=', 'products.id'),
    )
    .leftJoin('branches', (j) =>
      j
        .onRef('product_price_history.tenant_id', '=', 'branches.tenant_id')
        .onRef('product_price_history.branch_id', '=', 'branches.id'),
    )
    .select([
      'product_price_history.id',
      'product_price_history.tenant_id',
      'product_price_history.product_id',
      'products.name as product_name',
      'products.sku as sku',
      'product_price_history.scope',
      'product_price_history.branch_id',
      'branches.name as branch_name',
      'product_price_history.suggestion_id',
      'product_price_history.previous_price',
      'product_price_history.new_price',
      'product_price_history.cost_snapshot',
      'product_price_history.pricing_method',
      'product_price_history.target_percentage',
      'product_price_history.rounding_rule',
      'product_price_history.reason',
      'product_price_history.actor_user_id',
      'product_price_history.approver_user_id',
      'product_price_history.effective_date',
      'product_price_history.approved_at',
      'product_price_history.created_at',
    ])
    .where('product_price_history.tenant_id', '=', trx.tenantId)
    .orderBy('product_price_history.approved_at', 'desc')
    .limit(limit);

  if (query.productId) {
    dbQuery = dbQuery.where('product_price_history.product_id', '=', query.productId);
  }
  if (query.branchId) {
    dbQuery = dbQuery.where('product_price_history.branch_id', '=', query.branchId);
  }

  const rows = await dbQuery.execute();
  const visible = authCtx.allLocationsAccess
    ? rows
    : rows.filter(
        (r) =>
          r.scope === 'GLOBAL' ||
          (r.branch_id !== null && authCtx.allowedBranchIds.has(r.branch_id)),
      );

  return visible.map((r) => ({
    id: r.id,
    tenantId: r.tenant_id,
    productId: r.product_id,
    productName: r.product_name,
    sku: r.sku,
    scope: r.scope,
    branchId: r.branch_id,
    branchName: r.branch_name,
    suggestionId: r.suggestion_id,
    previousPrice: Money.fromDecimalString(
      String(r.previous_price),
      currencyCode,
    ).toDecimalString(),
    newPrice: Money.fromDecimalString(
      String(r.new_price),
      currencyCode,
    ).toDecimalString(),
    costSnapshot: Money.fromDecimalString(
      String(r.cost_snapshot),
      currencyCode,
    ).toDecimalString(),
    pricingMethod: r.pricing_method as PricingMethodType | null,
    targetPercentage:
      r.target_percentage !== null && r.target_percentage !== undefined
        ? formatPct2(r.target_percentage)
        : null,
    roundingRule: r.rounding_rule,
    reason: r.reason,
    actorUserId: r.actor_user_id,
    approverUserId: r.approver_user_id,
    effectiveDate: formatDateOnly(r.effective_date),
    approvedAt: new Date(r.approved_at).toISOString(),
    createdAt: new Date(r.created_at).toISOString(),
  }));
}

export async function getPricingAnalyticsDashboard(
  trx: TenantTransactionContext,
): Promise<PricingAnalyticsDashboardResponse> {
  await assertAuthorized(trx, { permission: 'cat:pricing:read' });
  await assertSubscriptionEntitlement(trx, { requireWriteAccess: false });

  const currencyCode = await getTenantBaseCurrency(trx);
  const settingsRow = await ensureTenantPricingSettings(trx);
  const settings = mapPricingSettingsRow(settingsRow);

  const [products, rules, suggestions, branchOverrides] = await Promise.all([
    trx.db
      .selectFrom('products')
      .select(['id', 'sku', 'name', 'base_uom', 'price_uom', 'purchase_cost', 'selling_price'])
      .where('tenant_id', '=', trx.tenantId)
      .where('status', '=', 'ACTIVE')
      .orderBy('name', 'asc')
      .execute(),
    trx.db
      .selectFrom('product_pricing_rules')
      .selectAll()
      .where('tenant_id', '=', trx.tenantId)
      .execute(),
    trx.db
      .selectFrom('price_suggestions')
      .select(['id', 'scope', 'status', 'cost_change_direction'])
      .where('tenant_id', '=', trx.tenantId)
      .execute(),
    listBranchPriceOverrides(trx, {}),
  ]);

  const ruleMap = new Map(rules.map((r) => [r.product_id, r]));
  const branchCountByProduct = new Map<string, number>();
  for (const bo of branchOverrides) {
    if (bo.isActive) {
      branchCountByProduct.set(
        bo.productId,
        (branchCountByProduct.get(bo.productId) ?? 0) + 1,
      );
    }
  }

  const productHealth: PricingProductHealthRow[] = [];
  const lowMarginProducts: PricingProductHealthRow[] = [];
  let lowMarginCount = 0;
  let zeroOrNegativeMarginCount = 0;

  for (const p of products) {
    const rule = ruleMap.get(p.id);
    const minMarginPct = rule?.min_margin_pct
      ? formatPct2(rule.min_margin_pct)
      : settings.defaultMinMarginPct;
    const minSellingPrice = rule?.min_selling_price
      ? Money.fromDecimalString(String(rule.min_selling_price), currencyCode).toDecimalString()
      : null;
    const maxDiscountPct =
      rule?.max_discount_pct !== null && rule?.max_discount_pct !== undefined
        ? formatPct2(rule.max_discount_pct)
        : settings.defaultMaxDiscountPct;

    const costStr = Money.fromDecimalString(String(p.purchase_cost), currencyCode).toDecimalString();
    const priceStr = Money.fromDecimalString(String(p.selling_price), currencyCode).toDecimalString();
    const health = evaluateMarginHealth({
      cost: costStr,
      sellingPrice: priceStr,
      currencyCode,
      minMarginPct,
      minSellingPrice,
    });
    const expectedProfit = Money.fromDecimalString(priceStr, currencyCode)
      .subtract(Money.fromDecimalString(costStr, currencyCode))
      .toDecimalString();

    if (health.isLowMargin) lowMarginCount++;
    if (health.isZeroOrNegativeMargin) zeroOrNegativeMarginCount++;

    const row: PricingProductHealthRow = {
      productId: p.id,
      sku: p.sku,
      name: p.name,
      priceUom: (p.price_uom ?? p.base_uom).toUpperCase(),
      purchaseCost: costStr,
      sellingPrice: priceStr,
      minSellingPrice,
      maxDiscountPct,
      pricingMethod: (rule?.pricing_method ?? settings.defaultPricingMethod) as PricingMethodType,
      targetPercentage: formatPct2(rule?.target_percentage, settings.defaultTargetPercentage),
      costBasis: (rule?.cost_basis ?? settings.defaultCostBasis) as PricingCostBasisType,
      roundingRule: (rule?.rounding_rule ?? settings.defaultRoundingRule) as PricingRoundingRuleType,
      actualMarginPct: health.actualMarginPct,
      actualMarkupPct: health.actualMarkupPct,
      expectedProfitPerUnit: expectedProfit,
      isZeroOrNegativeMargin: health.isZeroOrNegativeMargin,
      isLowMargin: health.isLowMargin,
      isBelowMinSellingPrice: health.isBelowMinSellingPrice,
      suggestionsEnabled: rule ? Boolean(rule.suggestions_enabled) : true,
      branchOverrideCount: branchCountByProduct.get(p.id) ?? 0,
    };
    productHealth.push(row);
    if (health.isLowMargin || health.isZeroOrNegativeMargin || health.isBelowMinSellingPrice) {
      lowMarginProducts.push(row);
    }
  }

  const pending = suggestions.filter((s) => s.status === 'PENDING');
  return {
    currencyCode,
    kpis: {
      pendingGlobalSuggestions: pending.filter((s) => s.scope === 'GLOBAL').length,
      pendingBranchSuggestions: pending.filter((s) => s.scope === 'BRANCH').length,
      costIncreaseSuggestions: pending.filter((s) => s.cost_change_direction === 'INCREASE')
        .length,
      costDecreaseSuggestions: pending.filter((s) => s.cost_change_direction === 'DECREASE')
        .length,
      lowMarginCount,
      zeroOrNegativeMarginCount,
      branchReviewAlertsCount: branchOverrides.filter((b) => b.isActive && b.needsReview).length,
      recentApprovalsCount: suggestions.filter(
        (s) => s.status === 'APPROVED' || s.status === 'MODIFIED_APPROVED',
      ).length,
      recentRejectionsCount: suggestions.filter((s) => s.status === 'REJECTED').length,
      deferredCount: suggestions.filter((s) => s.status === 'DEFERRED').length,
    },
    settings,
    lowMarginProducts,
    productHealth,
    branchOverrides,
  };
}

/**
 * Resolves the active branch-specific selling price, fallback global selling price,
 * minimum selling price floor, and maximum discount percentage for POS checkout & discovery.
 */
export async function resolveBranchEffectivePriceConfig(
  trx: TenantTransactionContext,
  params: {
    readonly productId: string;
    readonly branchId: string;
    readonly globalSellingPrice: string;
    readonly currencyCode: CurrencyCode;
  },
): Promise<{
  readonly effectivePrice: string;
  readonly priceSource: 'GLOBAL' | 'BRANCH_OVERRIDE';
  readonly minSellingPrice: string | null;
  readonly maxDiscountPct: string | null;
}> {
  const todayStr = formatDateOnly(new Date());
  const [branchRow, ruleRow, settingsRow] = await Promise.all([
    trx.db
      .selectFrom('product_branch_prices')
      .select([
        'selling_price',
        'min_selling_price',
        'max_discount_pct',
        'effective_date',
      ])
      .where('tenant_id', '=', trx.tenantId)
      .where('product_id', '=', params.productId)
      .where('branch_id', '=', params.branchId)
      .where('is_active', '=', true)
      .executeTakeFirst(),
    trx.db
      .selectFrom('product_pricing_rules')
      .select(['min_selling_price', 'max_discount_pct'])
      .where('tenant_id', '=', trx.tenantId)
      .where('product_id', '=', params.productId)
      .executeTakeFirst(),
    trx.db
      .selectFrom('pricing_settings')
      .select(['default_max_discount_pct'])
      .where('tenant_id', '=', trx.tenantId)
      .executeTakeFirst(),
  ]);

  const effectiveDateOk =
    branchRow && formatDateOnly(branchRow.effective_date) <= todayStr;

  if (branchRow && effectiveDateOk) {
    return {
      effectivePrice: Money.fromDecimalString(
        String(branchRow.selling_price),
        params.currencyCode,
      ).toDecimalString(),
      priceSource: 'BRANCH_OVERRIDE',
      minSellingPrice: branchRow.min_selling_price
        ? Money.fromDecimalString(
            String(branchRow.min_selling_price),
            params.currencyCode,
          ).toDecimalString()
        : ruleRow?.min_selling_price
          ? Money.fromDecimalString(
              String(ruleRow.min_selling_price),
              params.currencyCode,
            ).toDecimalString()
          : null,
      maxDiscountPct:
        branchRow.max_discount_pct !== null && branchRow.max_discount_pct !== undefined
          ? formatPct2(branchRow.max_discount_pct)
          : ruleRow?.max_discount_pct !== null && ruleRow?.max_discount_pct !== undefined
            ? formatPct2(ruleRow.max_discount_pct)
            : settingsRow
              ? formatPct2(settingsRow.default_max_discount_pct)
              : null,
    };
  }

  return {
    effectivePrice: Money.fromDecimalString(
      params.globalSellingPrice,
      params.currencyCode,
    ).toDecimalString(),
    priceSource: 'GLOBAL',
    minSellingPrice: ruleRow?.min_selling_price
      ? Money.fromDecimalString(
          String(ruleRow.min_selling_price),
          params.currencyCode,
        ).toDecimalString()
      : null,
    maxDiscountPct:
      ruleRow?.max_discount_pct !== null && ruleRow?.max_discount_pct !== undefined
        ? formatPct2(ruleRow.max_discount_pct)
        : settingsRow
          ? formatPct2(settingsRow.default_max_discount_pct)
          : null,
  };
}

/**
 * Offline synchronization snapshot for POS registers & SQLite mirrors.
 * Exposes approved global and branch-specific selling prices cleanly without allowing offline approvals.
 */
export async function getSyncCatalogPricingSnapshot(
  trx: TenantTransactionContext,
  query: { branchId?: string } = {},
): Promise<SyncCatalogPricingResponse> {
  await assertAuthorized(trx, {
    permission: 'pos:sale:create',
    ...(query.branchId ? { branchId: query.branchId } : {}),
  });
  await assertSubscriptionEntitlement(trx, { requireWriteAccess: false });

  const currencyCode = await getTenantBaseCurrency(trx);
  const [products, rules, settings, branchOverrides] = await Promise.all([
    trx.db
      .selectFrom('products')
      .select([
        'id',
        'sku',
        'name',
        'base_uom',
        'price_uom',
        'selling_price',
        'sync_version',
      ])
      .where('tenant_id', '=', trx.tenantId)
      .where('status', '=', 'ACTIVE')
      .execute(),
    trx.db
      .selectFrom('product_pricing_rules')
      .select(['product_id', 'min_selling_price', 'max_discount_pct'])
      .where('tenant_id', '=', trx.tenantId)
      .execute(),
    ensureTenantPricingSettings(trx),
    trx.db
      .selectFrom('product_branch_prices')
      .innerJoin('products', (j) =>
        j
          .onRef('product_branch_prices.tenant_id', '=', 'products.tenant_id')
          .onRef('product_branch_prices.product_id', '=', 'products.id'),
      )
      .innerJoin('branches', (j) =>
        j
          .onRef('product_branch_prices.tenant_id', '=', 'branches.tenant_id')
          .onRef('product_branch_prices.branch_id', '=', 'branches.id'),
      )
      .select([
        'product_branch_prices.id',
        'product_branch_prices.tenant_id',
        'product_branch_prices.product_id',
        'products.name as product_name',
        'products.sku as sku',
        'products.selling_price as global_selling_price',
        'product_branch_prices.branch_id',
        'branches.name as branch_name',
        'product_branch_prices.selling_price',
        'product_branch_prices.pricing_method',
        'product_branch_prices.target_percentage',
        'product_branch_prices.rounding_rule',
        'product_branch_prices.min_selling_price',
        'product_branch_prices.max_discount_pct',
        'product_branch_prices.effective_date',
        'product_branch_prices.is_active',
        'product_branch_prices.needs_review',
        'product_branch_prices.review_reason',
        'product_branch_prices.approved_at',
        'product_branch_prices.sync_version',
      ])
      .where('product_branch_prices.tenant_id', '=', trx.tenantId)
      .where('product_branch_prices.is_active', '=', true)
      .$if(Boolean(query.branchId), (qb) =>
        qb.where('product_branch_prices.branch_id', '=', query.branchId!),
      )
      .execute(),
  ]);

  const ruleMap = new Map(rules.map((r) => [r.product_id, r]));
  const defaultMaxDisc = formatPct2(settings.default_max_discount_pct, '20.00');

  return {
    tenantId: trx.tenantId,
    branchId: query.branchId ?? null,
    currencyCode,
    syncedAt: new Date().toISOString(),
    globalPrices: products.map((p) => {
      const rule = ruleMap.get(p.id);
      return {
        productId: p.id,
        sku: p.sku,
        name: p.name,
        baseUom: p.base_uom,
        priceUom: (p.price_uom ?? p.base_uom).toUpperCase(),
        sellingPrice: Money.fromDecimalString(
          String(p.selling_price),
          currencyCode,
        ).toDecimalString(),
        minSellingPrice: rule?.min_selling_price
          ? Money.fromDecimalString(
              String(rule.min_selling_price),
              currencyCode,
            ).toDecimalString()
          : null,
        maxDiscountPct:
          rule?.max_discount_pct !== null && rule?.max_discount_pct !== undefined
            ? formatPct2(rule.max_discount_pct)
            : defaultMaxDisc,
        syncVersion: Number(p.sync_version),
      };
    }),
    branchOverrides: branchOverrides.map((r) => ({
      id: r.id,
      tenantId: r.tenant_id,
      productId: r.product_id,
      productName: r.product_name,
      sku: r.sku,
      branchId: r.branch_id,
      branchName: r.branch_name,
      globalSellingPrice: Money.fromDecimalString(
        String(r.global_selling_price),
        currencyCode,
      ).toDecimalString(),
      sellingPrice: Money.fromDecimalString(
        String(r.selling_price),
        currencyCode,
      ).toDecimalString(),
      pricingMethod: r.pricing_method as PricingMethodType,
      targetPercentage:
        r.target_percentage !== null && r.target_percentage !== undefined
          ? formatPct2(r.target_percentage)
          : null,
      roundingRule: r.rounding_rule as PricingRoundingRuleType,
      minSellingPrice: r.min_selling_price
        ? Money.fromDecimalString(
            String(r.min_selling_price),
            currencyCode,
          ).toDecimalString()
        : null,
      maxDiscountPct:
        r.max_discount_pct !== null && r.max_discount_pct !== undefined
          ? formatPct2(r.max_discount_pct)
          : defaultMaxDisc,
      effectiveDate: formatDateOnly(r.effective_date),
      isActive: Boolean(r.is_active),
      needsReview: Boolean(r.needs_review),
      reviewReason: r.review_reason,
      approvedAt: r.approved_at ? new Date(r.approved_at).toISOString() : null,
      syncVersion: Number(r.sync_version),
    })),
  };
}

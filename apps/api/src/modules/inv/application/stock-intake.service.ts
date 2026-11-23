import { randomBytes } from 'node:crypto';
import type {
  CurrencyCode,
  ListStockConfigAlertsQuery,
  ListStockIntakeLotsQuery,
  ResolveStockConfigAlertRequest,
  StockConfigAlertResponse,
  StockIntakeLotResponse,
  StockIntakePricingMode,
  StockIntakeSourceMethod,
  StockIntakeStatus,
  UpdateStockIntakeLotRequest,
} from '@nexstock/contracts';
import {
  Money,
  QUANTITY_SCALE_FACTOR,
  Quantity,
  convertQuantityBetweenUoms,
  divideAndRoundBigInt,
} from '@nexstock/domain-core';
import type { Selectable } from 'kysely';
import { addProductBarcode, approvePriceSuggestion } from '../../cat/index.js';
import { assertAuthorized } from '../../iam/index.js';
import {
  AppError,
  type StockConfigAlertsTable,
  type StockIntakeLotsTable,
  type TenantTransactionContext,
  appendAuditLog,
  generateUuidV7,
} from '../../shared/index.js';
import { assertSubscriptionEntitlement } from '../../sub/index.js';

async function getTenantBaseCurrency(
  trx: TenantTransactionContext,
): Promise<string> {
  const cacheKey = `baseCurrency:${trx.tenantId}`;
  const cached = trx._trxCache?.get(cacheKey) as string | undefined;
  if (cached) {
    return cached;
  }
  const tenant = await trx.db
    .selectFrom('tenants')
    .select(['base_currency'])
    .where('id', '=', trx.tenantId)
    .executeTakeFirst();
  const resolved = tenant?.base_currency?.trim() ?? 'LKR';
  trx._trxCache?.set(cacheKey, resolved);
  return resolved;
}

function asRecord(val: unknown): Record<string, unknown> {
  if (!val) return {};
  if (typeof val === 'string') {
    try {
      const parsed = JSON.parse(val) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  if (typeof val === 'object' && !Array.isArray(val)) {
    return val as Record<string, unknown>;
  }
  return {};
}

function asStringArray(val: unknown): string[] {
  if (!val) return [];
  if (Array.isArray(val)) {
    return val.map((x) => String(x));
  }
  if (typeof val === 'string') {
    try {
      const parsed = JSON.parse(val) as unknown;
      return Array.isArray(parsed) ? parsed.map((x) => String(x)) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function generateIntakeCode(sourceMethod: StockIntakeSourceMethod, now: Date): string {
  const datePart = now.toISOString().slice(0, 10).replace(/-/g, '');
  const prefix =
    sourceMethod === 'GRN'
      ? 'INT-GRN'
      : sourceMethod === 'OPENING_STOCK'
        ? 'INT-OPN'
        : sourceMethod === 'TRANSFER_IN'
          ? 'INT-TRF'
          : sourceMethod === 'STOCKTAKE'
            ? 'INT-CNT'
            : 'INT-STK';
  const rand = randomBytes(3).toString('hex').toUpperCase();
  return `${prefix}-${datePart}-${rand}`;
}

export function mapStockIntakeLotRow(
  row: Selectable<StockIntakeLotsTable> & {
    product_sku?: string | null;
    product_name?: string | null;
    product_selling_price?: string | null;
    branch_selling_price?: string | null;
  },
  defaultCurrency = 'LKR',
): StockIntakeLotResponse {
  const ccy = (row.currency_code || defaultCurrency) as CurrencyCode;
  const sellingPriceFormatted =
    row.selling_price != null
      ? Money.fromDecimalString(String(row.selling_price), ccy).toDecimalString()
      : null;
  const effectivePriceStr =
    row.pricing_mode === 'INTAKE_SPECIFIC' && sellingPriceFormatted
      ? sellingPriceFormatted
      : row.branch_selling_price != null
        ? Money.fromDecimalString(String(row.branch_selling_price), ccy).toDecimalString()
        : sellingPriceFormatted ??
          (row.product_selling_price != null
            ? Money.fromDecimalString(String(row.product_selling_price), ccy).toDecimalString()
            : undefined);

  return {
    id: row.id,
    tenantId: row.tenant_id,
    branchId: row.branch_id,
    warehouseId: row.warehouse_id,
    productId: row.product_id,
    ...(row.product_sku ? { productSku: row.product_sku } : {}),
    ...(row.product_name ? { productName: row.product_name } : {}),
    batchId: row.batch_id ?? null,
    ledgerEntryId: row.ledger_entry_id ?? null,
    supplierId: row.supplier_id ?? null,
    intakeCode: row.intake_code,
    sourceMethod: row.source_method as StockIntakeSourceMethod,
    sourceReferenceType: row.source_reference_type ?? null,
    sourceReferenceId: row.source_reference_id ?? null,
    receivedUom: row.received_uom,
    receivedQty: Quantity.fromDecimalString(String(row.received_qty)).toDecimalString(),
    conversionFactorToBase: Quantity.fromDecimalString(
      String(row.conversion_factor_to_base ?? '1.000000'),
    ).toDecimalString(),
    baseQtyReceived: Quantity.fromDecimalString(String(row.base_qty_received)).toDecimalString(),
    baseQtyRemaining: Quantity.fromDecimalString(String(row.base_qty_remaining)).toDecimalString(),
    baseQtyReserved: Quantity.fromDecimalString(
      String(row.base_qty_reserved ?? '0.000000'),
    ).toDecimalString(),
    purchaseCostPerReceivedUom: Money.fromDecimalString(
      String(row.purchase_cost_per_received_uom ?? row.purchase_cost_per_base_uom ?? '0'),
      ccy,
    ).toDecimalString(),
    purchaseCostPerBaseUom: Money.fromDecimalString(
      String(row.purchase_cost_per_base_uom ?? '0'),
      ccy,
    ).toDecimalString(),
    pricingMode: (row.pricing_mode ?? 'INHERIT_PRODUCT') as StockIntakePricingMode,
    sellingUom: row.selling_uom,
    sellingPrice: sellingPriceFormatted,
    ...(effectivePriceStr ? { effectiveSellingPrice: effectivePriceStr } : {}),
    minSellingPrice:
      row.min_selling_price != null
        ? Money.fromDecimalString(String(row.min_selling_price), ccy).toDecimalString()
        : null,
    maxDiscountPct: row.max_discount_pct != null ? String(row.max_discount_pct) : null,
    currencyCode: ccy,
    isLegacyAggregate: Boolean(row.is_legacy_aggregate),
    status: (row.status ?? 'ACTIVE') as StockIntakeStatus,
    configSnapshot: asRecord(row.config_snapshot_json),
    notes: row.notes ?? null,
    receivedAt: new Date(row.received_at).toISOString(),
    createdByUserId: row.created_by_user_id ?? null,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export function mapStockConfigAlertRow(
  row: Selectable<StockConfigAlertsTable> & {
    product_sku?: string | null;
    product_name?: string | null;
    product_base_uom?: string | null;
    intake_code?: string | null;
  },
): StockConfigAlertResponse {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    branchId: row.branch_id,
    warehouseId: row.warehouse_id,
    productId: row.product_id,
    ...(row.product_sku ? { productSku: row.product_sku } : {}),
    ...(row.product_name ? { productName: row.product_name } : {}),
    ...(row.product_base_uom ? { baseUom: row.product_base_uom } : {}),
    stockIntakeLotId: row.stock_intake_lot_id ?? null,
    intakeCode: row.intake_code ?? null,
    batchId: row.batch_id ?? null,
    ledgerEntryId: row.ledger_entry_id ?? null,
    priceSuggestionId: row.price_suggestion_id ?? null,
    sourceMethod: row.source_method,
    sourceEventKey: row.source_event_key,
    severity: row.severity,
    changeTypes: asStringArray(row.change_types_json),
    previousConfig: asRecord(row.previous_config_json),
    incomingConfig: asRecord(row.incoming_config_json),
    summary: row.summary,
    impactExplanation: row.impact_explanation,
    recommendedAction: row.recommended_action,
    status: row.status,
    resolutionAction: row.resolution_action ?? null,
    resolutionNotes: row.resolution_notes ?? null,
    resolutionPayload: row.resolution_payload_json
      ? asRecord(row.resolution_payload_json)
      : null,
    createdByUserId: row.created_by_user_id ?? null,
    resolvedByUserId: row.resolved_by_user_id ?? null,
    createdAt: new Date(row.created_at).toISOString(),
    resolvedAt: row.resolved_at ? new Date(row.resolved_at).toISOString() : null,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export interface CreateInboundStockIntakeParams {
  readonly intakeLotId?: string;
  readonly branchId: string;
  readonly warehouseId: string;
  readonly productId: string;
  readonly batchId?: string | null;
  readonly ledgerEntryId: string;
  readonly supplierId?: string | null;
  readonly sourceMethod: StockIntakeSourceMethod;
  readonly sourceReferenceType?: string | null;
  readonly sourceReferenceId?: string | null;
  readonly receivedUom: string;
  readonly receivedQty: Quantity;
  readonly conversionFactorToBase: string;
  readonly baseQtyReceived: Quantity;
  readonly purchaseCostPerBaseUom: Money;
  readonly proposedSellingPrice?: string | null;
  readonly proposedSellingUom?: string | null;
  readonly previousProductPurchaseCost?: string | null;
  readonly priceSuggestionId?: string | null;
  readonly notes?: string | null;
  readonly occurredAt: Date;
}

export async function createInboundStockIntakeAndEvaluate(
  trx: TenantTransactionContext,
  params: CreateInboundStockIntakeParams,
): Promise<{
  readonly intakeLot: StockIntakeLotResponse;
  readonly configAlert: StockConfigAlertResponse | null;
}> {
  const baseCurrency = await getTenantBaseCurrency(trx);
  const now = new Date();
  const intakeLotId = params.intakeLotId ?? generateUuidV7();
  const intakeCode = generateIntakeCode(params.sourceMethod, params.occurredAt);

  const [productRow, convRows, branchOverrideRow, activeExistingLots, activeBarcodes] =
    await Promise.all([
      trx.db
        .selectFrom('products')
        .select([
          'id',
          'sku',
          'name',
          'base_uom',
          'purchase_uom',
          'price_uom',
          'allowed_selling_uoms',
          'purchase_cost',
          'selling_price',
          'tracking_mode',
          'valuation_method',
          'primary_barcode',
        ])
        .where('tenant_id', '=', trx.tenantId)
        .where('id', '=', params.productId)
        .executeTakeFirstOrThrow(),
      trx.db
        .selectFrom('product_unit_conversions')
        .select([
          'uom_code',
          'uom_name',
          'conversion_factor_to_base',
          'is_default_purchasing',
          'is_default_selling',
          'selling_price',
        ])
        .where('tenant_id', '=', trx.tenantId)
        .where('product_id', '=', params.productId)
        .where('is_active', '=', true)
        .execute(),
      trx.db
        .selectFrom('product_branch_prices')
        .select(['selling_price', 'min_selling_price', 'max_discount_pct'])
        .where('tenant_id', '=', trx.tenantId)
        .where('branch_id', '=', params.branchId)
        .where('product_id', '=', params.productId)
        .where('is_active', '=', true)
        .executeTakeFirst(),
      trx.db
        .selectFrom('stock_intake_lots')
        .selectAll()
        .where('tenant_id', '=', trx.tenantId)
        .where('warehouse_id', '=', params.warehouseId)
        .where('product_id', '=', params.productId)
        .where('status', '=', 'ACTIVE')
        .where('base_qty_remaining', '>', '0.000000')
        .orderBy('received_at', 'desc')
        .execute(),
      trx.db
        .selectFrom('product_barcodes')
        .select(['id', 'barcode', 'uom_code', 'stock_intake_lot_id', 'is_primary'])
        .where('tenant_id', '=', trx.tenantId)
        .where('product_id', '=', params.productId)
        .where('is_active', '=', true)
        .execute(),
    ]);

  const baseUom = String(productRow.base_uom).trim().toUpperCase();
  const priceUom = String(productRow.price_uom || baseUom).trim().toUpperCase();
  const prevCostStr =
    params.previousProductPurchaseCost ?? String(productRow.purchase_cost ?? '0.0000');
  const prevCostMoney = Money.fromDecimalString(prevCostStr, baseCurrency);
  const currentGlobalPriceMoney = Money.fromDecimalString(
    String(productRow.selling_price ?? '0.0000'),
    baseCurrency,
  );
  const activePosPriceMoney = branchOverrideRow?.selling_price
    ? Money.fromDecimalString(String(branchOverrideRow.selling_price), baseCurrency)
    : currentGlobalPriceMoney;

  const convFactorQty = Quantity.fromDecimalString(params.conversionFactorToBase);
  const costPerReceivedScaled =
    (params.purchaseCostPerBaseUom.scaledUnits * convFactorQty.microUnits) /
    QUANTITY_SCALE_FACTOR;
  const purchaseCostPerReceivedMoney = Money.fromScaledUnits(
    costPerReceivedScaled,
    baseCurrency,
  );

  const sellingUom = (params.proposedSellingUom ?? priceUom).trim().toUpperCase();
  const hasExplicitProposedPrice =
    params.proposedSellingPrice !== undefined &&
    params.proposedSellingPrice !== null &&
    params.proposedSellingPrice.trim() !== '';
  const proposedSellingMoney = hasExplicitProposedPrice
    ? Money.fromDecimalString(params.proposedSellingPrice!, baseCurrency)
    : null;

  const isDistinctProposedPrice =
    proposedSellingMoney !== null &&
    (proposedSellingMoney.scaledUnits !== activePosPriceMoney.scaledUnits ||
      sellingUom !== priceUom);

  const pricingMode: StockIntakePricingMode = isDistinctProposedPrice
    ? 'INTAKE_SPECIFIC'
    : branchOverrideRow?.selling_price
      ? 'INHERIT_BRANCH'
      : 'INHERIT_PRODUCT';

  const storedSellingPrice = proposedSellingMoney
    ? proposedSellingMoney.toDecimalString()
    : activePosPriceMoney.toDecimalString();

  const allowedSellingUoms = asStringArray(productRow.allowed_selling_uoms);
  const effectiveAllowedUoms =
    allowedSellingUoms.length > 0 ? allowedSellingUoms.map((u) => u.toUpperCase()) : [baseUom];

  const configSnapshot: Record<string, unknown> = {
    capturedAt: now.toISOString(),
    sku: productRow.sku,
    productName: productRow.name,
    baseUom,
    priceUom,
    receivedUom: params.receivedUom,
    conversionFactorToBase: params.conversionFactorToBase,
    previousProductPurchaseCost: prevCostMoney.toDecimalString(),
    incomingPurchaseCostPerBaseUom: params.purchaseCostPerBaseUom.toDecimalString(),
    incomingPurchaseCostPerReceivedUom: purchaseCostPerReceivedMoney.toDecimalString(),
    existingGlobalSellingPrice: currentGlobalPriceMoney.toDecimalString(),
    existingActivePosPrice: activePosPriceMoney.toDecimalString(),
    proposedSellingPrice: proposedSellingMoney ? proposedSellingMoney.toDecimalString() : null,
    sellingUom,
    allowedSellingUoms: effectiveAllowedUoms,
    unitConversions: convRows.map((c) => ({
      uomCode: c.uom_code,
      uomName: c.uom_name,
      conversionFactorToBase: String(c.conversion_factor_to_base),
      sellingPrice: c.selling_price != null ? String(c.selling_price) : null,
    })),
  };

  await trx.db
    .insertInto('stock_intake_lots')
    .values({
      id: intakeLotId,
      tenant_id: trx.tenantId,
      branch_id: params.branchId,
      warehouse_id: params.warehouseId,
      product_id: params.productId,
      batch_id: params.batchId ?? null,
      ledger_entry_id: params.ledgerEntryId,
      supplier_id: params.supplierId ?? null,
      intake_code: intakeCode,
      source_method: params.sourceMethod,
      source_reference_type: params.sourceReferenceType ?? null,
      source_reference_id: params.sourceReferenceId ?? null,
      received_uom: params.receivedUom,
      received_qty: params.receivedQty.toDecimalString(),
      conversion_factor_to_base: convFactorQty.toDecimalString(),
      base_qty_received: params.baseQtyReceived.toDecimalString(),
      base_qty_remaining: params.baseQtyReceived.toDecimalString(),
      base_qty_reserved: Quantity.zero().toDecimalString(),
      purchase_cost_per_received_uom: purchaseCostPerReceivedMoney.toDecimalString(),
      purchase_cost_per_base_uom: params.purchaseCostPerBaseUom.toDecimalString(),
      pricing_mode: pricingMode,
      selling_uom: sellingUom,
      selling_price: storedSellingPrice,
      min_selling_price: branchOverrideRow?.min_selling_price
        ? Money.fromDecimalString(String(branchOverrideRow.min_selling_price), baseCurrency).toDecimalString()
        : null,
      max_discount_pct: branchOverrideRow?.max_discount_pct
        ? String(branchOverrideRow.max_discount_pct)
        : null,
      currency_code: baseCurrency,
      is_legacy_aggregate: false,
      status: 'ACTIVE',
      config_snapshot_json: JSON.stringify(configSnapshot),
      notes: params.notes ?? null,
      received_at: params.occurredAt,
      created_by_user_id: trx.userId,
      created_at: now,
      updated_at: now,
    })
    .execute();

  const insertedLot = await trx.db
    .selectFrom('stock_intake_lots')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', intakeLotId)
    .executeTakeFirstOrThrow();

  const mappedLot = mapStockIntakeLotRow(
    {
      ...insertedLot,
      product_sku: productRow.sku,
      product_name: productRow.name,
      product_selling_price: String(productRow.selling_price),
      branch_selling_price: branchOverrideRow?.selling_price
        ? String(branchOverrideRow.selling_price)
        : null,
    },
    baseCurrency,
  );

  // ============================================================================
  // Smart Stock Configuration Change Detection Engine
  // ============================================================================
  const changeTypes: string[] = [];
  const latestExistingLot = activeExistingLots[0];
  const baselineCostMoney = latestExistingLot
    ? Money.fromDecimalString(String(latestExistingLot.purchase_cost_per_base_uom), baseCurrency)
    : prevCostMoney;
  const baselineSellingMoney =
    latestExistingLot && latestExistingLot.selling_price != null
      ? Money.fromDecimalString(String(latestExistingLot.selling_price), baseCurrency)
      : activePosPriceMoney;

  const hasPriorStockOrHistory =
    activeExistingLots.length > 0 || !prevCostMoney.isZero();

  if (
    hasPriorStockOrHistory &&
    !params.purchaseCostPerBaseUom.isZero() &&
    !baselineCostMoney.isZero() &&
    params.purchaseCostPerBaseUom.scaledUnits !== baselineCostMoney.scaledUnits
  ) {
    changeTypes.push('PURCHASE_COST_CHANGED');
  }

  if (
    proposedSellingMoney !== null &&
    proposedSellingMoney.scaledUnits !== baselineSellingMoney.scaledUnits
  ) {
    changeTypes.push('SELLING_PRICE_CHANGED');
  }

  if (
    !params.purchaseCostPerBaseUom.isZero() &&
    (proposedSellingMoney ?? activePosPriceMoney).scaledUnits <=
      params.purchaseCostPerBaseUom.scaledUnits &&
    sellingUom === baseUom
  ) {
    changeTypes.push('BELOW_COST_MARGIN_RISK');
  }

  if (
    params.proposedSellingUom &&
    !effectiveAllowedUoms.includes(sellingUom)
  ) {
    changeTypes.push('SELLING_UOM_CHANGED');
  }

  if (params.receivedUom !== baseUom) {
    const matchingConv = convRows.find(
      (c) => c.uom_code.toUpperCase() === params.receivedUom.toUpperCase(),
    );
    if (matchingConv) {
      const configuredFactor = Quantity.fromDecimalString(
        String(matchingConv.conversion_factor_to_base),
      );
      if (!configuredFactor.equals(convFactorQty)) {
        changeTypes.push('PACKAGE_CONVERSION_CHANGED');
      }
    }
  }

  if (
    params.sourceMethod === 'TRANSFER_IN' &&
    branchOverrideRow?.selling_price &&
    proposedSellingMoney &&
    proposedSellingMoney.scaledUnits !== activePosPriceMoney.scaledUnits
  ) {
    changeTypes.push('LOCATION_PRICE_MISMATCH');
  }

  // Detect if multiple active intake lots in this warehouse now have distinct selling prices while only generic product barcodes exist
  const hasCoexistingDifferentPriceStock =
    activeExistingLots.length > 0 &&
    (changeTypes.includes('SELLING_PRICE_CHANGED') ||
      activeExistingLots.some((lot) => {
        const lotPrice = lot.selling_price != null
          ? Money.fromDecimalString(String(lot.selling_price), baseCurrency)
          : activePosPriceMoney;
        const incomingPrice = proposedSellingMoney ?? activePosPriceMoney;
        return lotPrice.scaledUnits !== incomingPrice.scaledUnits;
      }));

  if (
    hasCoexistingDifferentPriceStock &&
    activeBarcodes.length > 0 &&
    !activeBarcodes.some((b) => b.stock_intake_lot_id === intakeLotId)
  ) {
    changeTypes.push('BARCODE_MAPPING_CONFLICT');
  }

  if (changeTypes.length === 0) {
    return { intakeLot: mappedLot, configAlert: null };
  }

  const severity: 'INFO' | 'WARNING' | 'CONFLICT' =
    changeTypes.includes('BELOW_COST_MARGIN_RISK') ||
    changeTypes.includes('BARCODE_MAPPING_CONFLICT') ||
    changeTypes.includes('PACKAGE_CONVERSION_CHANGED') ||
    (changeTypes.includes('SELLING_PRICE_CHANGED') && activeExistingLots.length > 0)
      ? 'CONFLICT'
      : changeTypes.includes('PURCHASE_COST_CHANGED') ||
          changeTypes.includes('SELLING_PRICE_CHANGED') ||
          changeTypes.includes('SELLING_UOM_CHANGED') ||
          changeTypes.includes('LOCATION_PRICE_MISMATCH')
        ? 'WARNING'
        : 'INFO';

  const prevConfigObj = {
    intakeCode: latestExistingLot?.intake_code ?? 'PRODUCT_DEFAULT',
    purchaseCostPerBaseUom: baselineCostMoney.toDecimalString(),
    sellingPrice: baselineSellingMoney.toDecimalString(),
    sellingUom: latestExistingLot?.selling_uom ?? priceUom,
    baseUom,
    activeStockBeforeIntake: activeExistingLots
      .reduce(
        (acc, l) => acc.add(Quantity.fromDecimalString(String(l.base_qty_remaining))),
        Quantity.zero(),
      )
      .toDecimalString(),
  };

  const incomingConfigObj = {
    intakeLotId,
    intakeCode,
    sourceMethod: params.sourceMethod,
    receivedQty: params.receivedQty.toDecimalString(),
    receivedUom: params.receivedUom,
    conversionFactorToBase: convFactorQty.toDecimalString(),
    baseQtyReceived: params.baseQtyReceived.toDecimalString(),
    purchaseCostPerBaseUom: params.purchaseCostPerBaseUom.toDecimalString(),
    purchaseCostPerReceivedUom: purchaseCostPerReceivedMoney.toDecimalString(),
    sellingPrice: (proposedSellingMoney ?? activePosPriceMoney).toDecimalString(),
    sellingUom,
    pricingMode,
  };

  const summaryParts: string[] = [];
  if (changeTypes.includes('PURCHASE_COST_CHANGED')) {
    summaryParts.push(
      `Purchase cost changed (${baselineCostMoney.toDecimalString()} -> ${params.purchaseCostPerBaseUom.toDecimalString()} / ${baseUom})`,
    );
  }
  if (changeTypes.includes('SELLING_PRICE_CHANGED')) {
    summaryParts.push(
      `Selling price differs (${baselineSellingMoney.toDecimalString()} -> ${(proposedSellingMoney ?? activePosPriceMoney).toDecimalString()} / ${sellingUom})`,
    );
  }
  if (changeTypes.includes('BELOW_COST_MARGIN_RISK')) {
    summaryParts.push('Incoming cost exceeds or equals current POS selling price');
  }
  if (changeTypes.includes('BARCODE_MAPPING_CONFLICT')) {
    summaryParts.push('Existing stock and new stock have different selling prices under shared product barcode');
  }
  if (changeTypes.includes('SELLING_UOM_CHANGED') || changeTypes.includes('PACKAGE_CONVERSION_CHANGED')) {
    summaryParts.push(`UoM / package configuration difference (${params.receivedUom} -> ${baseUom})`);
  }

  const summary =
    summaryParts.join('; ') ||
    `Stock configuration change detected on intake ${intakeCode} for ${productRow.sku}`;
  const impactExplanation = hasCoexistingDifferentPriceStock
    ? `Warehouse currently holds active stock from prior intake (${prevConfigObj.activeStockBeforeIntake} ${baseUom} @ ${baselineSellingMoney.toDecimalString()}) alongside new intake ${intakeCode} (${params.baseQtyReceived.toDecimalString()} ${baseUom} @ ${(proposedSellingMoney ?? activePosPriceMoney).toDecimalString()}). Active global POS price (${activePosPriceMoney.toDecimalString()}) was preserved and NOT overwritten.`
    : `Incoming stock (${params.baseQtyReceived.toDecimalString()} ${baseUom}) introduced a configuration change (${changeTypes.join(', ')}). Active POS selling price (${activePosPriceMoney.toDecimalString()}) remains untouched until reviewed.`;
  const recommendedAction = hasCoexistingDifferentPriceStock
    ? 'Keep existing global POS price for old stock and assign a stock-specific selling price / barcode for the new intake, or approve a global price update.'
    : changeTypes.includes('PURCHASE_COST_CHANGED')
      ? 'Review margin impact: keep current global POS price, configure a stock-specific price for this intake, or approve a global price update.'
      : 'Review incoming UoM and pricing configuration for POS compatibility.';

  const sourceEventKey = `INTAKE_ALERT:${intakeLotId}`;
  const alertId = generateUuidV7();

  await trx.db
    .insertInto('stock_config_alerts')
    .values({
      id: alertId,
      tenant_id: trx.tenantId,
      branch_id: params.branchId,
      warehouse_id: params.warehouseId,
      product_id: params.productId,
      stock_intake_lot_id: intakeLotId,
      batch_id: params.batchId ?? null,
      ledger_entry_id: params.ledgerEntryId,
      price_suggestion_id: params.priceSuggestionId ?? null,
      source_method: params.sourceMethod,
      source_event_key: sourceEventKey,
      severity,
      change_types_json: JSON.stringify(changeTypes),
      previous_config_json: JSON.stringify(prevConfigObj),
      incoming_config_json: JSON.stringify(incomingConfigObj),
      summary,
      impact_explanation: impactExplanation,
      recommended_action: recommendedAction,
      status: 'PENDING',
      resolution_action: null,
      resolution_notes: null,
      resolution_payload_json: null,
      created_by_user_id: trx.userId,
      resolved_by_user_id: null,
      created_at: now,
      resolved_at: null,
      updated_at: now,
    })
    .onConflict((oc) => oc.columns(['tenant_id', 'source_event_key']).doNothing())
    .execute();

  const alertRow = await trx.db
    .selectFrom('stock_config_alerts')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('source_event_key', '=', sourceEventKey)
    .executeTakeFirst();

  return {
    intakeLot: mappedLot,
    configAlert: alertRow
      ? mapStockConfigAlertRow({
          ...alertRow,
          product_sku: productRow.sku,
          product_name: productRow.name,
          product_base_uom: baseUom,
          intake_code: intakeCode,
        })
      : null,
  };
}

export interface ConsumedIntakeSlice {
  readonly intakeLotId: string;
  readonly intakeCode: string;
  readonly qtyConsumedBase: string;
  readonly unitCostPerBase: string;
  readonly sellingPrice: string | null;
}

export async function consumeStockIntakeLotsForOutbound(
  trx: TenantTransactionContext,
  params: {
    readonly warehouseId: string;
    readonly productId: string;
    readonly qtyToConsumeBase: Quantity;
    readonly explicitIntakeLotId?: string | null;
    readonly enforceExplicitLotStock?: boolean;
  },
): Promise<readonly ConsumedIntakeSlice[]> {
  const baseCurrency = await getTenantBaseCurrency(trx);
  const now = new Date();
  const consumed: ConsumedIntakeSlice[] = [];

  if (params.explicitIntakeLotId) {
    const lot = await trx.db
      .selectFrom('stock_intake_lots')
      .selectAll()
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', params.explicitIntakeLotId)
      .forUpdate()
      .executeTakeFirst();

    if (!lot || lot.product_id !== params.productId || lot.warehouse_id !== params.warehouseId) {
      throw new AppError({
        statusCode: 404,
        errorCode: 'POS_INTAKE_LOT_NOT_FOUND',
        title: 'Stock Intake Reference Not Found',
        detail: `Stock intake reference "${params.explicitIntakeLotId}" was not found for this product in warehouse "${params.warehouseId}".`,
      });
    }

    if (lot.status !== 'ACTIVE') {
      throw new AppError({
        statusCode: 409,
        errorCode: 'POS_INTAKE_LOT_INACTIVE',
        title: 'Stock Intake Reference Inactive or Depleted',
        detail: `Stock reference "${lot.intake_code}" has status "${lot.status}" and cannot be sold. Another stock layer will not be substituted automatically.`,
      });
    }

    const rem = Quantity.fromDecimalString(String(lot.base_qty_remaining));
    const res = Quantity.fromDecimalString(String(lot.base_qty_reserved ?? '0.000000'));
    const avail = rem.subtract(res);

    if (
      params.enforceExplicitLotStock !== false &&
      avail.compare(params.qtyToConsumeBase) < 0
    ) {
      throw new AppError({
        statusCode: 409,
        errorCode: 'POS_INTAKE_LOT_EXHAUSTED',
        title: 'Referenced Stock Intake Exhausted',
        detail: `Stock intake "${lot.intake_code}" has only ${avail.toDecimalString()} ${lot.received_uom} (base) remaining, which is insufficient for requested ${params.qtyToConsumeBase.toDecimalString()}.`,
      });
    }

    const nextRem = rem.subtract(params.qtyToConsumeBase);
    const clampedRem = nextRem.isNegative() ? Quantity.zero() : nextRem;
    await trx.db
      .updateTable('stock_intake_lots')
      .set({
        base_qty_remaining: clampedRem.toDecimalString(),
        status: clampedRem.isZero() ? 'DEPLETED' : 'ACTIVE',
        updated_at: now,
      })
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', lot.id)
      .execute();

    consumed.push({
      intakeLotId: lot.id,
      intakeCode: lot.intake_code,
      qtyConsumedBase: params.qtyToConsumeBase.toDecimalString(),
      unitCostPerBase: Money.fromDecimalString(
        String(lot.purchase_cost_per_base_uom),
        baseCurrency,
      ).toDecimalString(),
      sellingPrice:
        lot.selling_price != null
          ? Money.fromDecimalString(String(lot.selling_price), baseCurrency).toDecimalString()
          : null,
    });
    return consumed;
  }

  // Product-level allocation: consume active intake lots in FIFO order (oldest received first)
  const openLots = await trx.db
    .selectFrom('stock_intake_lots')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('warehouse_id', '=', params.warehouseId)
    .where('product_id', '=', params.productId)
    .where('status', '=', 'ACTIVE')
    .where('base_qty_remaining', '>', '0.000000')
    .orderBy('is_legacy_aggregate', 'desc')
    .orderBy('received_at', 'asc')
    .orderBy('created_at', 'asc')
    .forUpdate()
    .execute();

  let remainingNeeded = params.qtyToConsumeBase;
  for (const lot of openLots) {
    if (!remainingNeeded.isPositive()) break;
    const rem = Quantity.fromDecimalString(String(lot.base_qty_remaining));
    if (!rem.isPositive()) continue;

    const take = rem.compare(remainingNeeded) <= 0 ? rem : remainingNeeded;
    const nextRem = rem.subtract(take);

    await trx.db
      .updateTable('stock_intake_lots')
      .set({
        base_qty_remaining: nextRem.toDecimalString(),
        status: nextRem.isZero() ? 'DEPLETED' : 'ACTIVE',
        updated_at: now,
      })
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', lot.id)
      .execute();

    consumed.push({
      intakeLotId: lot.id,
      intakeCode: lot.intake_code,
      qtyConsumedBase: take.toDecimalString(),
      unitCostPerBase: Money.fromDecimalString(
        String(lot.purchase_cost_per_base_uom),
        baseCurrency,
      ).toDecimalString(),
      sellingPrice:
        lot.selling_price != null
          ? Money.fromDecimalString(String(lot.selling_price), baseCurrency).toDecimalString()
          : null,
    });
    remainingNeeded = remainingNeeded.subtract(take);
  }

  return consumed;
}

export async function restoreStockIntakeLotQuantity(
  trx: TenantTransactionContext,
  params: {
    readonly warehouseId: string;
    readonly productId: string;
    readonly qtyToRestoreBase: Quantity;
    readonly explicitIntakeLotId?: string | null;
    readonly consumedSlices?: readonly {
      readonly intakeLotId: string;
      readonly qtyConsumedBase: string;
    }[];
  },
): Promise<string | null> {
  const now = new Date();
  let remainingToRestore = params.qtyToRestoreBase;
  let primaryRestoredLotId: string | null = params.explicitIntakeLotId ?? null;

  if (params.explicitIntakeLotId) {
    const lot = await trx.db
      .selectFrom('stock_intake_lots')
      .select(['id', 'base_qty_received', 'base_qty_remaining', 'status'])
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', params.explicitIntakeLotId)
      .forUpdate()
      .executeTakeFirst();

    if (lot) {
      const curRem = Quantity.fromDecimalString(String(lot.base_qty_remaining));
      const maxRec = Quantity.fromDecimalString(String(lot.base_qty_received));
      const nextRemCandidate = curRem.add(remainingToRestore);
      const nextRem =
        nextRemCandidate.compare(maxRec) > 0 ? maxRec : nextRemCandidate;

      await trx.db
        .updateTable('stock_intake_lots')
        .set({
          base_qty_remaining: nextRem.toDecimalString(),
          status: nextRem.isPositive() ? 'ACTIVE' : lot.status,
          updated_at: now,
        })
        .where('tenant_id', '=', trx.tenantId)
        .where('id', '=', lot.id)
        .execute();

      return lot.id;
    }
  }

  if (params.consumedSlices && params.consumedSlices.length > 0) {
    for (const slice of params.consumedSlices) {
      if (!remainingToRestore.isPositive()) break;
      const lot = await trx.db
        .selectFrom('stock_intake_lots')
        .select(['id', 'base_qty_received', 'base_qty_remaining', 'status'])
        .where('tenant_id', '=', trx.tenantId)
        .where('id', '=', slice.intakeLotId)
        .forUpdate()
        .executeTakeFirst();
      if (!lot) continue;

      const sliceQty = Quantity.fromDecimalString(slice.qtyConsumedBase);
      const addQty =
        sliceQty.compare(remainingToRestore) <= 0 ? sliceQty : remainingToRestore;
      const curRem = Quantity.fromDecimalString(String(lot.base_qty_remaining));
      const maxRec = Quantity.fromDecimalString(String(lot.base_qty_received));
      const candidate = curRem.add(addQty);
      const nextRem = candidate.compare(maxRec) > 0 ? maxRec : candidate;

      await trx.db
        .updateTable('stock_intake_lots')
        .set({
          base_qty_remaining: nextRem.toDecimalString(),
          status: nextRem.isPositive() ? 'ACTIVE' : lot.status,
          updated_at: now,
        })
        .where('tenant_id', '=', trx.tenantId)
        .where('id', '=', lot.id)
        .execute();

      if (!primaryRestoredLotId) primaryRestoredLotId = lot.id;
      remainingToRestore = remainingToRestore.subtract(addQty);
    }
  }

  if (remainingToRestore.isPositive()) {
    const candidates = await trx.db
      .selectFrom('stock_intake_lots')
      .select(['id', 'base_qty_received', 'base_qty_remaining', 'status'])
      .where('tenant_id', '=', trx.tenantId)
      .where('warehouse_id', '=', params.warehouseId)
      .where('product_id', '=', params.productId)
      .where('status', 'in', ['ACTIVE', 'DEPLETED'])
      .orderBy('received_at', 'desc')
      .forUpdate()
      .execute();

    for (const lot of candidates) {
      if (!remainingToRestore.isPositive()) break;
      const maxRec = Quantity.fromDecimalString(String(lot.base_qty_received));
      const curRem = Quantity.fromDecimalString(String(lot.base_qty_remaining));
      const deficit = maxRec.subtract(curRem);
      if (!deficit.isPositive()) continue;

      const addBack =
        deficit.compare(remainingToRestore) <= 0 ? deficit : remainingToRestore;
      const nextRem = curRem.add(addBack);
      await trx.db
        .updateTable('stock_intake_lots')
        .set({
          base_qty_remaining: nextRem.toDecimalString(),
          status: nextRem.isPositive() ? 'ACTIVE' : lot.status,
          updated_at: now,
        })
        .where('tenant_id', '=', trx.tenantId)
        .where('id', '=', lot.id)
        .execute();

      if (!primaryRestoredLotId) primaryRestoredLotId = lot.id;
      remainingToRestore = remainingToRestore.subtract(addBack);
    }
  }

  return primaryRestoredLotId;
}

export async function listStockIntakeLots(
  trx: TenantTransactionContext,
  query: ListStockIntakeLotsQuery,
): Promise<StockIntakeLotResponse[]> {
  await assertAuthorized(trx, {
    permission: 'inv:movement:read',
    ...(query.branchId ? { branchId: query.branchId } : {}),
    ...(query.warehouseId ? { warehouseId: query.warehouseId } : {}),
  });

  const baseCurrency = await getTenantBaseCurrency(trx);
  const limit = Math.min(Number(query.limit ?? 100), 250);

  let q = trx.db
    .selectFrom('stock_intake_lots')
    .innerJoin('products', (join) =>
      join
        .onRef('stock_intake_lots.tenant_id', '=', 'products.tenant_id')
        .onRef('stock_intake_lots.product_id', '=', 'products.id'),
    )
    .selectAll('stock_intake_lots')
    .select([
      'products.sku as product_sku',
      'products.name as product_name',
      'products.selling_price as product_selling_price',
    ])
    .where('stock_intake_lots.tenant_id', '=', trx.tenantId);

  if (query.branchId) {
    q = q.where('stock_intake_lots.branch_id', '=', query.branchId);
  }
  if (query.warehouseId) {
    q = q.where('stock_intake_lots.warehouse_id', '=', query.warehouseId);
  }
  if (query.productId) {
    q = q.where('stock_intake_lots.product_id', '=', query.productId);
  }
  if (query.status) {
    q = q.where('stock_intake_lots.status', '=', query.status);
  } else if (query.includeDepleted !== 'true') {
    q = q.where('stock_intake_lots.status', '=', 'ACTIVE');
  }

  const rows = await q
    .orderBy('stock_intake_lots.received_at', 'desc')
    .orderBy('stock_intake_lots.created_at', 'desc')
    .limit(limit)
    .execute();

  return rows.map((r) => mapStockIntakeLotRow(r, baseCurrency));
}

export async function updateStockIntakeLot(
  trx: TenantTransactionContext,
  intakeLotId: string,
  input: UpdateStockIntakeLotRequest,
): Promise<StockIntakeLotResponse> {
  const existing = await trx.db
    .selectFrom('stock_intake_lots')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', intakeLotId)
    .forUpdate()
    .executeTakeFirst();

  if (!existing) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'POS_INTAKE_LOT_NOT_FOUND',
      title: 'Stock Intake Reference Not Found',
      detail: `Stock intake lot "${intakeLotId}" was not found.`,
    });
  }

  await assertAuthorized(trx, {
    permission: 'cat:product:manage',
    branchId: existing.branch_id,
    warehouseId: existing.warehouse_id,
  });
  await assertSubscriptionEntitlement(trx, { requireWriteAccess: true });

  const baseCurrency = await getTenantBaseCurrency(trx);
  const now = new Date();

  const nextPricingMode = input.pricingMode ?? existing.pricing_mode;
  const nextSellingUom = input.sellingUom
    ? input.sellingUom.trim().toUpperCase()
    : existing.selling_uom;
  const nextSellingPrice =
    input.sellingPrice !== undefined
      ? input.sellingPrice !== null
        ? Money.fromDecimalString(input.sellingPrice, baseCurrency).toDecimalString()
        : null
      : existing.selling_price;
  const nextMinPrice =
    input.minSellingPrice !== undefined
      ? input.minSellingPrice !== null
        ? Money.fromDecimalString(input.minSellingPrice, baseCurrency).toDecimalString()
        : null
      : existing.min_selling_price;
  const nextMaxDisc =
    input.maxDiscountPct !== undefined ? input.maxDiscountPct : existing.max_discount_pct;
  const nextStatus = input.status ?? existing.status;
  const nextNotes = input.notes !== undefined ? input.notes : existing.notes;

  await trx.db
    .updateTable('stock_intake_lots')
    .set({
      pricing_mode: nextPricingMode,
      selling_uom: nextSellingUom,
      selling_price: nextSellingPrice,
      min_selling_price: nextMinPrice,
      max_discount_pct: nextMaxDisc,
      status: nextStatus,
      notes: nextNotes,
      updated_at: now,
    })
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', intakeLotId)
    .execute();

  await appendAuditLog(trx, {
    action: 'INV_STOCK_INTAKE_LOT_UPDATED',
    resourceType: 'STOCK_INTAKE_LOT',
    resourceId: intakeLotId,
    metadata: {
      intakeCode: existing.intake_code,
      pricingMode: nextPricingMode,
      sellingUom: nextSellingUom,
      sellingPrice: nextSellingPrice,
      status: nextStatus,
    },
  });

  const updated = await trx.db
    .selectFrom('stock_intake_lots')
    .innerJoin('products', (join) =>
      join
        .onRef('stock_intake_lots.tenant_id', '=', 'products.tenant_id')
        .onRef('stock_intake_lots.product_id', '=', 'products.id'),
    )
    .selectAll('stock_intake_lots')
    .select([
      'products.sku as product_sku',
      'products.name as product_name',
      'products.selling_price as product_selling_price',
    ])
    .where('stock_intake_lots.tenant_id', '=', trx.tenantId)
    .where('stock_intake_lots.id', '=', intakeLotId)
    .executeTakeFirstOrThrow();

  return mapStockIntakeLotRow(updated, baseCurrency);
}

export async function listStockConfigAlerts(
  trx: TenantTransactionContext,
  query: ListStockConfigAlertsQuery,
): Promise<StockConfigAlertResponse[]> {
  await assertAuthorized(trx, {
    permission: 'inv:movement:read',
    ...(query.branchId ? { branchId: query.branchId } : {}),
    ...(query.warehouseId ? { warehouseId: query.warehouseId } : {}),
  });

  const limit = Math.min(Number(query.limit ?? 100), 250);
  let q = trx.db
    .selectFrom('stock_config_alerts')
    .innerJoin('products', (join) =>
      join
        .onRef('stock_config_alerts.tenant_id', '=', 'products.tenant_id')
        .onRef('stock_config_alerts.product_id', '=', 'products.id'),
    )
    .leftJoin('stock_intake_lots', (join) =>
      join
        .onRef('stock_config_alerts.tenant_id', '=', 'stock_intake_lots.tenant_id')
        .onRef(
          'stock_config_alerts.stock_intake_lot_id',
          '=',
          'stock_intake_lots.id',
        ),
    )
    .selectAll('stock_config_alerts')
    .select([
      'products.sku as product_sku',
      'products.name as product_name',
      'products.base_uom as product_base_uom',
      'stock_intake_lots.intake_code as intake_code',
    ])
    .where('stock_config_alerts.tenant_id', '=', trx.tenantId);

  if (query.branchId) {
    q = q.where('stock_config_alerts.branch_id', '=', query.branchId);
  }
  if (query.warehouseId) {
    q = q.where('stock_config_alerts.warehouse_id', '=', query.warehouseId);
  }
  if (query.productId) {
    q = q.where('stock_config_alerts.product_id', '=', query.productId);
  }
  if (query.stockIntakeLotId) {
    q = q.where('stock_config_alerts.stock_intake_lot_id', '=', query.stockIntakeLotId);
  }
  if (query.status) {
    q = q.where('stock_config_alerts.status', '=', query.status);
  }
  if (query.severity) {
    q = q.where('stock_config_alerts.severity', '=', query.severity);
  }

  const rows = await q
    .orderBy('stock_config_alerts.created_at', 'desc')
    .limit(limit)
    .execute();

  return rows.map(mapStockConfigAlertRow);
}

export async function resolveStockConfigAlert(
  trx: TenantTransactionContext,
  alertId: string,
  input: ResolveStockConfigAlertRequest,
): Promise<StockConfigAlertResponse> {
  const alertRow = await trx.db
    .selectFrom('stock_config_alerts')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', alertId)
    .forUpdate()
    .executeTakeFirst();

  if (!alertRow) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'INV_CONFIG_ALERT_NOT_FOUND',
      title: 'Stock Configuration Alert Not Found',
      detail: `Stock configuration alert "${alertId}" was not found.`,
    });
  }

  await assertAuthorized(trx, {
    permission:
      input.action === 'UPDATE_GLOBAL_WITH_APPROVAL'
        ? 'cat:pricing:approve_global'
        : 'cat:product:manage',
    branchId: alertRow.branch_id,
    warehouseId: alertRow.warehouse_id,
  });
  await assertSubscriptionEntitlement(trx, { requireWriteAccess: true });

  const baseCurrency = await getTenantBaseCurrency(trx);
  const now = new Date();
  const resolutionPayload: Record<string, unknown> = {
    action: input.action,
  };

  if (input.action === 'KEEP_GLOBAL_PRICE') {
    if (alertRow.stock_intake_lot_id) {
      await trx.db
        .updateTable('stock_intake_lots')
        .set({
          pricing_mode: 'INHERIT_PRODUCT',
          updated_at: now,
        })
        .where('tenant_id', '=', trx.tenantId)
        .where('id', '=', alertRow.stock_intake_lot_id)
        .execute();
    }
  } else if (
    input.action === 'SET_INTAKE_SPECIFIC_PRICE' ||
    input.action === 'CREATE_INTAKE_BARCODE'
  ) {
    if (!alertRow.stock_intake_lot_id) {
      throw new AppError({
        statusCode: 422,
        errorCode: 'POS_INTAKE_LOT_NOT_FOUND',
        title: 'Stock Intake Reference Required',
        detail: 'This alert is not linked to a stock intake lot.',
      });
    }

    const lot = await trx.db
      .selectFrom('stock_intake_lots')
      .selectAll()
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', alertRow.stock_intake_lot_id)
      .forUpdate()
      .executeTakeFirstOrThrow();

    const targetPrice = input.sellingPrice
      ? Money.fromDecimalString(input.sellingPrice, baseCurrency).toDecimalString()
      : lot.selling_price;
    const targetUom = (input.sellingUom ?? input.uomCode ?? lot.selling_uom)
      .trim()
      .toUpperCase();

    if (!targetPrice) {
      throw new AppError({
        statusCode: 400,
        errorCode: 'ERR_VALIDATION_FAILED',
        title: 'Selling Price Required',
        detail: 'Provide sellingPrice when configuring an intake-specific selling price.',
      });
    }

    await trx.db
      .updateTable('stock_intake_lots')
      .set({
        pricing_mode: 'INTAKE_SPECIFIC',
        selling_price: targetPrice,
        selling_uom: targetUom,
        updated_at: now,
      })
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', lot.id)
      .execute();

    resolutionPayload['stockIntakeLotId'] = lot.id;
    resolutionPayload['intakeSellingPrice'] = targetPrice;
    resolutionPayload['intakeSellingUom'] = targetUom;

    if (input.barcode || input.action === 'CREATE_INTAKE_BARCODE') {
      const codeToBind =
        input.barcode?.trim() ||
        `NB-I${now.toISOString().slice(2, 10).replace(/-/g, '')}${randomBytes(2).toString('hex').toUpperCase()}`;
      const createdBc = await addProductBarcode(trx, alertRow.product_id, {
        barcode: codeToBind,
        barcodeType: input.barcodeType ?? 'CODE128',
        uomCode: targetUom,
        isPrimary: false,
        isActive: true,
        stockIntakeLotId: lot.id,
        branchId: alertRow.branch_id,
        warehouseId: alertRow.warehouse_id,
        priceSourceMode: 'INTAKE_SPECIFIC',
        sellingPriceOverride: targetPrice,
        ...(input.conversionFactorToBase
          ? { conversionFactorToBase: input.conversionFactorToBase }
          : {}),
      });
      resolutionPayload['createdBarcode'] = createdBc.barcode;
      resolutionPayload['createdBarcodeId'] = createdBc.id;
    }
  } else if (input.action === 'UPDATE_GLOBAL_WITH_APPROVAL') {
    const product = await trx.db
      .selectFrom('products')
      .select(['id', 'sku', 'selling_price', 'purchase_cost', 'sync_version'])
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', alertRow.product_id)
      .forUpdate()
      .executeTakeFirstOrThrow();

    const incomingCfg = asRecord(alertRow.incoming_config_json);
    const rawNewPrice =
      input.sellingPrice ??
      (typeof incomingCfg['sellingPrice'] === 'string'
        ? incomingCfg['sellingPrice']
        : null);

    if (alertRow.price_suggestion_id) {
      const approved = await approvePriceSuggestion(trx, alertRow.price_suggestion_id, {
        ...(rawNewPrice ? { overridePrice: rawNewPrice } : {}),
        ...(input.notes ? { reviewNotes: input.notes } : {}),
      });
      resolutionPayload['approvedSuggestionId'] = approved.id;
      resolutionPayload['newGlobalSellingPrice'] = approved.finalApprovedPrice;
    } else {
      if (!rawNewPrice) {
        throw new AppError({
          statusCode: 400,
          errorCode: 'ERR_VALIDATION_FAILED',
          title: 'Global Selling Price Required',
          detail: 'Provide sellingPrice to approve a global product price update.',
        });
      }
      const newGlobalMoney = Money.fromDecimalString(rawNewPrice, baseCurrency);
      await trx.db
        .updateTable('products')
        .set({
          selling_price: newGlobalMoney.toDecimalString(),
          sync_version: Number(product.sync_version) + 1,
          updated_at: now,
        })
        .where('tenant_id', '=', trx.tenantId)
        .where('id', '=', product.id)
        .execute();

      await trx.db
        .insertInto('product_price_history')
        .values({
          id: generateUuidV7(),
          tenant_id: trx.tenantId,
          product_id: product.id,
          scope: 'GLOBAL',
          branch_id: null,
          previous_price: Money.fromDecimalString(
            String(product.selling_price),
            baseCurrency,
          ).toDecimalString(),
          new_price: newGlobalMoney.toDecimalString(),
          cost_snapshot: Money.fromDecimalString(
            String(product.purchase_cost),
            baseCurrency,
          ).toDecimalString(),
          pricing_method: null,
          target_percentage: null,
          rounding_rule: null,
          suggestion_id: null,
          reason: input.notes?.trim() || `Approved via Stock Config Alert (${alertRow.source_method})`,
          actor_user_id: trx.userId,
          approver_user_id: trx.userId,
          created_at: now,
        })
        .execute();

      resolutionPayload['newGlobalSellingPrice'] = newGlobalMoney.toDecimalString();
    }
  } else if (input.action === 'UPDATE_UOM_CONVERSION') {
    const product = await trx.db
      .selectFrom('products')
      .select(['id', 'base_uom', 'allowed_selling_uoms', 'sync_version'])
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', alertRow.product_id)
      .forUpdate()
      .executeTakeFirstOrThrow();

    const targetUom = (input.uomCode ?? input.sellingUom ?? '').trim().toUpperCase();
    const factorStr = input.conversionFactorToBase
      ? Quantity.fromDecimalString(input.conversionFactorToBase).toDecimalString()
      : null;

    if (!targetUom) {
      throw new AppError({
        statusCode: 400,
        errorCode: 'ERR_VALIDATION_FAILED',
        title: 'UoM Code Required',
        detail: 'Provide uomCode to update UoM conversion configuration.',
      });
    }

    if (factorStr && targetUom !== product.base_uom.toUpperCase()) {
      const existingConv = await trx.db
        .selectFrom('product_unit_conversions')
        .select(['id'])
        .where('tenant_id', '=', trx.tenantId)
        .where('product_id', '=', product.id)
        .where('uom_code', '=', targetUom)
        .executeTakeFirst();

      if (existingConv) {
        await trx.db
          .updateTable('product_unit_conversions')
          .set({
            conversion_factor_to_base: factorStr,
            is_default_selling: true,
            ...(input.sellingPrice
              ? {
                  selling_price: Money.fromDecimalString(
                    input.sellingPrice,
                    baseCurrency,
                  ).toDecimalString(),
                }
              : {}),
            is_active: true,
            updated_at: now,
          })
          .where('tenant_id', '=', trx.tenantId)
          .where('id', '=', existingConv.id)
          .execute();
      } else {
        await trx.db
          .insertInto('product_unit_conversions')
          .values({
            id: generateUuidV7(),
            tenant_id: trx.tenantId,
            product_id: product.id,
            uom_code: targetUom,
            uom_name: `${targetUom} (${Number(factorStr)} ${product.base_uom})`,
            conversion_factor_to_base: factorStr,
            is_default_purchasing: false,
            is_default_selling: true,
            selling_price: input.sellingPrice
              ? Money.fromDecimalString(input.sellingPrice, baseCurrency).toDecimalString()
              : null,
            is_active: true,
            created_at: now,
            updated_at: now,
          })
          .execute();
      }
    }

    const currentAllowed = asStringArray(product.allowed_selling_uoms);
    const nextAllowed = Array.from(
      new Set([
        ...(currentAllowed.length > 0 ? currentAllowed : [product.base_uom]),
        targetUom,
      ]),
    );

    await trx.db
      .updateTable('products')
      .set({
        allowed_selling_uoms: JSON.stringify(nextAllowed),
        sync_version: Number(product.sync_version) + 1,
        updated_at: now,
      })
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', product.id)
      .execute();

    resolutionPayload['updatedUomCode'] = targetUom;
    resolutionPayload['conversionFactorToBase'] = factorStr;
    resolutionPayload['allowedSellingUoms'] = nextAllowed;
  }

  const nextStatus = input.action === 'DISMISS' ? 'DISMISSED' : 'RESOLVED';
  await trx.db
    .updateTable('stock_config_alerts')
    .set({
      status: nextStatus,
      resolution_action: input.action,
      resolution_notes: input.notes?.trim() ?? null,
      resolution_payload_json: JSON.stringify(resolutionPayload),
      resolved_by_user_id: trx.userId,
      resolved_at: now,
      updated_at: now,
    })
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', alertId)
    .execute();

  await appendAuditLog(trx, {
    action: 'INV_STOCK_CONFIG_ALERT_RESOLVED',
    resourceType: 'STOCK_CONFIG_ALERT',
    resourceId: alertId,
    metadata: {
      resolutionAction: input.action,
      status: nextStatus,
      notes: input.notes ?? null,
      ...resolutionPayload,
    },
  });

  const updated = await trx.db
    .selectFrom('stock_config_alerts')
    .innerJoin('products', (join) =>
      join
        .onRef('stock_config_alerts.tenant_id', '=', 'products.tenant_id')
        .onRef('stock_config_alerts.product_id', '=', 'products.id'),
    )
    .leftJoin('stock_intake_lots', (join) =>
      join
        .onRef('stock_config_alerts.tenant_id', '=', 'stock_intake_lots.tenant_id')
        .onRef(
          'stock_config_alerts.stock_intake_lot_id',
          '=',
          'stock_intake_lots.id',
        ),
    )
    .selectAll('stock_config_alerts')
    .select([
      'products.sku as product_sku',
      'products.name as product_name',
      'products.base_uom as product_base_uom',
      'stock_intake_lots.intake_code as intake_code',
    ])
    .where('stock_config_alerts.tenant_id', '=', trx.tenantId)
    .where('stock_config_alerts.id', '=', alertId)
    .executeTakeFirstOrThrow();

  return mapStockConfigAlertRow(updated);
}

/**
 * Helper to resolve effective selling price for a product in a given sellingUom,
 * accounting for explicit package selling price on `product_unit_conversions`,
 * intake-specific price on `stock_intake_lots`, or proportionate conversion from `price_uom`.
 */
export function resolvePackageAwareSellingPrice(params: {
  readonly targetSellingUom: string;
  readonly productBaseUom: string;
  readonly productPriceUom: string;
  readonly baseUnitPriceStr: string;
  readonly basePriceUom?: string;
  readonly unitConversions: readonly {
    readonly uomCode: string;
    readonly conversionFactorToBase: string;
    readonly sellingPrice?: string | null;
  }[];
  readonly densityGPerMl?: string | null;
  readonly currencyCode: string;
}): {
  readonly unitPriceInSellingUom: Money;
  readonly conversionFactorToBase: string;
  readonly isPackageExplicitPrice: boolean;
} {
  const targetUom = params.targetSellingUom.trim().toUpperCase();
  const baseUom = params.productBaseUom.trim().toUpperCase();
  const sourcePriceUom = (params.basePriceUom ?? params.productPriceUom ?? baseUom)
    .trim()
    .toUpperCase();

  const customConvs = params.unitConversions.map((c) => ({
    uomCode: c.uomCode.trim().toUpperCase(),
    conversionFactorToBase: c.conversionFactorToBase,
  }));

  const convToBase = convertQuantityBetweenUoms({
    quantity: '1',
    fromUom: targetUom,
    toUom: baseUom,
    productBaseUom: baseUom,
    customConversions: customConvs,
    densityGPerMl: params.densityGPerMl ?? null,
  });

  // Check if the package conversion row defines an explicit package selling price (e.g. 1 BAG = LKR 230 instead of 25 * 10)
  const matchedPkg = params.unitConversions.find(
    (c) =>
      c.uomCode.trim().toUpperCase() === targetUom &&
      c.sellingPrice != null &&
      String(c.sellingPrice).trim() !== '',
  );
  if (matchedPkg && matchedPkg.sellingPrice != null && !params.basePriceUom) {
    const pkgPrice = Money.fromDecimalString(
      String(matchedPkg.sellingPrice),
      params.currencyCode,
    );
    if (pkgPrice.isPositive()) {
      return {
        unitPriceInSellingUom: pkgPrice,
        conversionFactorToBase: convToBase.factorDecimal6,
        isPackageExplicitPrice: true,
      };
    }
  }

  const baseMoney = Money.fromDecimalString(
    params.baseUnitPriceStr,
    params.currencyCode,
  );
  if (targetUom === sourcePriceUom) {
    return {
      unitPriceInSellingUom: baseMoney,
      conversionFactorToBase: convToBase.factorDecimal6,
      isPackageExplicitPrice: false,
    };
  }

  // Convert 1 targetUom into sourcePriceUom to scale unit price accurately
  const convToPriceUom = convertQuantityBetweenUoms({
    quantity: '1',
    fromUom: targetUom,
    toUom: sourcePriceUom,
    productBaseUom: baseUom,
    customConversions: customConvs,
    densityGPerMl: params.densityGPerMl ?? null,
  });

  const scaledPrice = divideAndRoundBigInt(
    baseMoney.scaledUnits * convToPriceUom.numerator,
    convToPriceUom.denominator,
    'HALF_EVEN',
  );

  return {
    unitPriceInSellingUom: Money.fromScaledUnits(scaledPrice, params.currencyCode),
    conversionFactorToBase: convToBase.factorDecimal6,
    isPackageExplicitPrice: false,
  };
}

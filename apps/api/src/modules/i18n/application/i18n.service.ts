import {
  Money,
  Quantity,
  type RoundingMode,
  calculateLinePricingAndTax,
} from '@nexstock/domain-core';
import {
  AppError,
  type TenantTransactionContext,
  appendAuditLog,
  generateUuidV7,
} from '../../shared/index.js';

/**
 * Documented compliance decisions and assumptions requiring jurisdictional tax/legal specialist review
 * (Milestone 1 Instruction Section 5.4 & Acceptance Criteria).
 */
export const I18N_COMPLIANCE_DECISIONS_FOR_REVIEW = [
  {
    code: 'I18N-COMP-01',
    topic: 'Configurable Multi-Jurisdictional Tax Engine',
    summary:
      'Tax groups and tax rates are tenant-configurable (supporting both simple and compound cascading taxes such as Sri Lanka SSCL + VAT, EU VAT, or US State/Local sales tax) without hardcoding country tax statutes in code.',
    specialistReviewRequired:
      'Local tax counsel must verify statutory invoice disclosure fields, compound tax priority ordering, and rounding rules (HALF_EVEN vs HALF_UP) per operating country before fiscal certification.',
  },
  {
    code: 'I18N-COMP-02',
    topic: 'Exchange Rate Effective Dating & Historical Immutability',
    summary:
      'Exchange rates are append-only (`tenant_exchange_rates`) with an `effective_from` timestamp. Converting foreign currency amounts uses fixed-point 8-decimal rates (`NUMERIC(18,8)`) and 4-decimal internal Money (`NUMERIC(19,4)`).',
    specialistReviewRequired:
      'External auditors should confirm whether central-bank daily closing rates or transaction-time spot rates are mandated for unrealized/realized FX gain/loss recognition.',
  },
] as const;

export interface CurrencyDto {
  readonly code: string;
  readonly name: string;
  readonly symbol: string;
  readonly minorUnits: number;
  readonly isActive: boolean;
}

export interface LocalizationSettingsDto {
  readonly id: string;
  readonly tenantId: string;
  readonly locale: string;
  readonly timezone: string;
  readonly dateFormat: string;
  readonly numberFormat: string;
  readonly currencyDisplayMode: 'SYMBOL' | 'ISO_CODE' | 'SYMBOL_AND_CODE';
}

export interface ExchangeRateDto {
  readonly id: string;
  readonly tenantId: string;
  readonly sourceCurrency: string;
  readonly targetCurrency: string;
  readonly rate: string;
  readonly effectiveFrom: string;
  readonly createdByUserId: string;
}

export interface TaxRateDto {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly ratePercentage: string;
  readonly isCompound: boolean;
  readonly priority: number;
  readonly isActive: boolean;
}

export interface TaxGroupDto {
  readonly id: string;
  readonly tenantId: string;
  readonly code: string;
  readonly name: string;
  readonly countryCode: string;
  readonly isActive: boolean;
  readonly rates: readonly TaxRateDto[];
}

export async function listSupportedCurrencies(
  trx: TenantTransactionContext,
): Promise<readonly CurrencyDto[]> {
  const rows = await trx.db
    .selectFrom('currencies')
    .select(['code', 'name', 'symbol', 'minor_units', 'is_active'])
    .where('is_active', '=', true)
    .orderBy('code', 'asc')
    .execute();

  return rows.map((row) => ({
    code: row.code.trim(),
    name: row.name,
    symbol: row.symbol,
    minorUnits: Number(row.minor_units),
    isActive: row.is_active,
  }));
}

export async function upsertTenantLocalizationSettings(
  trx: TenantTransactionContext,
  input: {
    readonly locale: string;
    readonly timezone: string;
    readonly dateFormat: string;
    readonly numberFormat: string;
    readonly currencyDisplayMode: 'SYMBOL' | 'ISO_CODE' | 'SYMBOL_AND_CODE';
  },
): Promise<LocalizationSettingsDto> {
  const existing = await trx.db
    .selectFrom('tenant_localization_settings')
    .select(['id'])
    .where('tenant_id', '=', trx.tenantId)
    .executeTakeFirst();

  const id = existing?.id ?? generateUuidV7();

  if (existing) {
    await trx.db
      .updateTable('tenant_localization_settings')
      .set({
        locale: input.locale,
        timezone: input.timezone,
        date_format: input.dateFormat,
        number_format: input.numberFormat,
        currency_display_mode: input.currencyDisplayMode,
        updated_at: new Date(),
      })
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', id)
      .execute();
  } else {
    await trx.db
      .insertInto('tenant_localization_settings')
      .values({
        id,
        tenant_id: trx.tenantId,
        locale: input.locale,
        timezone: input.timezone,
        date_format: input.dateFormat,
        number_format: input.numberFormat,
        currency_display_mode: input.currencyDisplayMode,
      })
      .execute();
  }

  await appendAuditLog(trx, {
    action: 'I18N_LOCALIZATION_SETTINGS_UPSERTED',
    resourceType: 'TENANT_LOCALIZATION_SETTINGS',
    resourceId: id,
    metadata: input,
  });

  return {
    id,
    tenantId: trx.tenantId,
    locale: input.locale,
    timezone: input.timezone,
    dateFormat: input.dateFormat,
    numberFormat: input.numberFormat,
    currencyDisplayMode: input.currencyDisplayMode,
  };
}

export async function getTenantLocalizationSettings(
  trx: TenantTransactionContext,
): Promise<LocalizationSettingsDto> {
  const row = await trx.db
    .selectFrom('tenant_localization_settings')
    .select([
      'id',
      'tenant_id',
      'locale',
      'timezone',
      'date_format',
      'number_format',
      'currency_display_mode',
    ])
    .where('tenant_id', '=', trx.tenantId)
    .executeTakeFirst();

  if (!row) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'ERR_NOT_FOUND',
      title: 'Localization Settings Not Found',
      detail: `Localization settings have not been initialized for tenant "${trx.tenantId}".`,
    });
  }

  return {
    id: row.id,
    tenantId: row.tenant_id,
    locale: row.locale,
    timezone: row.timezone,
    dateFormat: row.date_format,
    numberFormat: row.number_format,
    currencyDisplayMode: row.currency_display_mode,
  };
}

export async function recordTenantExchangeRate(
  trx: TenantTransactionContext,
  input: {
    readonly sourceCurrency: string;
    readonly targetCurrency: string;
    readonly rate: string;
    readonly effectiveFrom: string;
  },
): Promise<ExchangeRateDto> {
  const sourceCurrency = input.sourceCurrency.trim().toUpperCase();
  const targetCurrency = input.targetCurrency.trim().toUpperCase();

  // Validate positive rate via Money conversion dry-run
  try {
    Money.fromDecimalString('1.0000', sourceCurrency).convertCurrency(
      targetCurrency,
      input.rate,
    );
  } catch (err) {
    throw new AppError({
      statusCode: 400,
      errorCode: 'ERR_VALIDATION_FAILED',
      title: 'Invalid Exchange Rate',
      detail:
        err instanceof Error ? err.message : 'Invalid exchange rate format.',
    });
  }

  const id = generateUuidV7();
  const effectiveDate = new Date(input.effectiveFrom);

  await trx.db
    .insertInto('tenant_exchange_rates')
    .values({
      id,
      tenant_id: trx.tenantId,
      source_currency: sourceCurrency,
      target_currency: targetCurrency,
      rate: input.rate,
      effective_from: effectiveDate,
      created_by_user_id: trx.userId,
    })
    .execute();

  await appendAuditLog(trx, {
    action: 'I18N_EXCHANGE_RATE_RECORDED',
    resourceType: 'TENANT_EXCHANGE_RATE',
    resourceId: id,
    metadata: {
      sourceCurrency,
      targetCurrency,
      rate: input.rate,
      effectiveFrom: effectiveDate.toISOString(),
    },
  });

  return {
    id,
    tenantId: trx.tenantId,
    sourceCurrency,
    targetCurrency,
    rate: input.rate,
    effectiveFrom: effectiveDate.toISOString(),
    createdByUserId: trx.userId,
  };
}

export async function convertTenantCurrencyAmount(
  trx: TenantTransactionContext,
  input: {
    readonly amount: string;
    readonly sourceCurrency: string;
    readonly targetCurrency: string;
    readonly asOf?: Date;
    readonly roundingMode?: RoundingMode;
  },
): Promise<{
  readonly sourceAmount: string;
  readonly sourceCurrency: string;
  readonly targetAmount: string;
  readonly targetCurrencyMinorString: string;
  readonly targetCurrency: string;
  readonly appliedRate: string;
}> {
  const sourceCurrency = input.sourceCurrency.trim().toUpperCase();
  const targetCurrency = input.targetCurrency.trim().toUpperCase();
  const roundingMode = input.roundingMode ?? 'HALF_EVEN';
  const sourceMoney = Money.fromDecimalString(
    input.amount,
    sourceCurrency,
    roundingMode,
  );

  if (sourceCurrency === targetCurrency) {
    return {
      sourceAmount: sourceMoney.toDecimalString(),
      sourceCurrency,
      targetAmount: sourceMoney.toDecimalString(),
      targetCurrencyMinorString:
        sourceMoney.toCurrencyDecimalString(roundingMode),
      targetCurrency,
      appliedRate: '1.00000000',
    };
  }

  const asOf = input.asOf ?? new Date();
  const rateRow = await trx.db
    .selectFrom('tenant_exchange_rates')
    .select(['rate'])
    .where('tenant_id', '=', trx.tenantId)
    .where('source_currency', '=', sourceCurrency)
    .where('target_currency', '=', targetCurrency)
    .where('effective_from', '<=', asOf)
    .orderBy('effective_from', 'desc')
    .orderBy('id', 'desc')
    .executeTakeFirst();

  if (!rateRow) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'ERR_NOT_FOUND',
      title: 'Exchange Rate Not Found',
      detail: `No effective exchange rate found from "${sourceCurrency}" to "${targetCurrency}" as of ${asOf.toISOString()}.`,
    });
  }

  const rateStr = String(rateRow.rate);
  const converted = sourceMoney.convertCurrency(
    targetCurrency,
    rateStr,
    roundingMode,
  );

  return {
    sourceAmount: sourceMoney.toDecimalString(),
    sourceCurrency,
    targetAmount: converted.toDecimalString(),
    targetCurrencyMinorString: converted.toCurrencyDecimalString(roundingMode),
    targetCurrency,
    appliedRate: rateStr,
  };
}

export async function createTaxGroupWithRates(
  trx: TenantTransactionContext,
  input: {
    readonly code: string;
    readonly name: string;
    readonly countryCode: string;
    readonly rates: readonly {
      readonly code: string;
      readonly name: string;
      readonly ratePercentage: string;
      readonly isCompound?: boolean | undefined;
      readonly priority?: number | undefined;
    }[];
  },
): Promise<TaxGroupDto> {
  const taxGroupId = generateUuidV7();
  const countryCode = input.countryCode.trim().toUpperCase();

  await trx.db
    .insertInto('tax_groups')
    .values({
      id: taxGroupId,
      tenant_id: trx.tenantId,
      code: input.code,
      name: input.name,
      country_code: countryCode,
      is_active: true,
    })
    .execute();

  const createdRates: TaxRateDto[] = [];
  for (let i = 0; i < input.rates.length; i++) {
    const rateInput = input.rates[i]!;
    const rateId = generateUuidV7();
    const isCompound = rateInput.isCompound ?? false;
    const priority = rateInput.priority ?? i + 1;

    await trx.db
      .insertInto('tax_rates')
      .values({
        id: rateId,
        tenant_id: trx.tenantId,
        tax_group_id: taxGroupId,
        code: rateInput.code,
        name: rateInput.name,
        rate_percentage: rateInput.ratePercentage,
        is_compound: isCompound,
        priority,
        is_active: true,
      })
      .execute();

    createdRates.push({
      id: rateId,
      code: rateInput.code,
      name: rateInput.name,
      ratePercentage: rateInput.ratePercentage,
      isCompound,
      priority,
      isActive: true,
    });
  }

  createdRates.sort((a, b) => a.priority - b.priority);

  await appendAuditLog(trx, {
    action: 'I18N_TAX_GROUP_CREATED',
    resourceType: 'TAX_GROUP',
    resourceId: taxGroupId,
    metadata: {
      code: input.code,
      countryCode,
      rateCount: createdRates.length,
    },
  });

  return {
    id: taxGroupId,
    tenantId: trx.tenantId,
    code: input.code,
    name: input.name,
    countryCode,
    isActive: true,
    rates: createdRates,
  };
}

export async function calculateTaxForTaxGroup(
  trx: TenantTransactionContext,
  input: {
    readonly taxGroupId: string;
    readonly unitPrice: string;
    readonly quantity: string;
    readonly currencyCode: string;
    readonly isTaxInclusive: boolean;
  },
): Promise<{
  readonly netTaxableAmount: string;
  readonly totalTaxAmount: string;
  readonly lineTotalWithTax: string;
  readonly breakdown: readonly {
    readonly taxRateId: string;
    readonly name: string;
    readonly ratePercentage: string;
    readonly taxAmount: string;
  }[];
}> {
  const rateRows = await trx.db
    .selectFrom('tax_rates')
    .select(['id', 'name', 'rate_percentage', 'is_compound', 'priority'])
    .where('tenant_id', '=', trx.tenantId)
    .where('tax_group_id', '=', input.taxGroupId)
    .where('is_active', '=', true)
    .orderBy('priority', 'asc')
    .orderBy('id', 'asc')
    .execute();

  const unitPrice = Money.fromDecimalString(
    input.unitPrice,
    input.currencyCode,
  );
  const quantity = Quantity.fromDecimalString(input.quantity);

  const calc = calculateLinePricingAndTax({
    unitPrice,
    quantity,
    isTaxInclusive: input.isTaxInclusive,
    taxRules: rateRows.map((r) => ({
      taxRateId: r.id,
      name: r.name,
      ratePercentage: String(r.rate_percentage),
      isCompound: r.is_compound,
    })),
  });

  return {
    netTaxableAmount: calc.netTaxableAmount.toDecimalString(),
    totalTaxAmount: calc.totalTaxAmount.toDecimalString(),
    lineTotalWithTax: calc.lineTotalWithTax.toDecimalString(),
    breakdown: calc.taxes.map((t) => ({
      taxRateId: t.taxRateId,
      name: t.name,
      ratePercentage: t.ratePercentage,
      taxAmount: t.taxAmount.toDecimalString(),
    })),
  };
}

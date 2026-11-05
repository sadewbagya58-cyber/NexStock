import {
  type CustomerCreditSettingsResponse,
  type UpdateCustomerCreditSettingsRequest,
} from '@nexstock/contracts';
import { sql } from 'kysely';
import { Money } from '@nexstock/domain-core';
import { assertAuthorized } from '../../iam/index.js';
import {
  AppError,
  type TenantTransactionContext,
  appendAuditLog,
  generateUuidV7,
} from '../../shared/index.js';

export async function getOrInitCreditSettings(
  trx: TenantTransactionContext,
): Promise<CustomerCreditSettingsResponse> {
  let settings = await trx.db
    .selectFrom('customer_credit_settings')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .executeTakeFirst();

  if (!settings) {
    const id = generateUuidV7();
    settings = await trx.db
      .insertInto('customer_credit_settings')
      .values({
        id,
        tenant_id: trx.tenantId,
        default_credit_limit: '50000.0000',
        default_credit_terms: 'NET_30',
        default_custom_days: 30,
        approval_policy: 'AUTO_WITHIN_LIMIT',
        approval_threshold_amount: '100000.0000',
        require_approval_for_overrides: true,
        require_approval_for_adjustments: true,
        interest_enabled: false,
        interest_calculation_mode: 'MONTHLY',
        interest_rate_percentage: '2.0000',
        interest_grace_period_days: 5,
        compounding_enabled: false,
        late_fee_enabled: false,
        late_fee_type: 'FIXED',
        late_fee_amount: '500.0000',
        late_fee_percentage: '1.0000',
        late_fee_grace_period_days: 7,
        late_fee_max_amount: '5000.0000',
        auto_hold_enabled: true,
        auto_hold_max_overdue_days: 60,
        auto_hold_max_overdue_amount: '50000.0000',
        auto_hold_utilization_threshold: '100.00',
        currency_code: 'LKR',
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  return {
    id: settings.id,
    defaultCreditLimit: String(settings.default_credit_limit),
    defaultCreditTerms: settings.default_credit_terms,
    defaultCustomDays: settings.default_custom_days,
    approvalPolicy: settings.approval_policy,
    approvalThresholdAmount: String(settings.approval_threshold_amount),
    requireApprovalForOverrides: settings.require_approval_for_overrides,
    requireApprovalForAdjustments: settings.require_approval_for_adjustments,
    interestEnabled: settings.interest_enabled,
    interestCalculationMode: settings.interest_calculation_mode,
    interestRatePercentage: String(settings.interest_rate_percentage),
    interestGracePeriodDays: settings.interest_grace_period_days,
    compoundingEnabled: settings.compounding_enabled,
    lateFeeEnabled: settings.late_fee_enabled,
    lateFeeType: settings.late_fee_type,
    lateFeeAmount: String(settings.late_fee_amount),
    lateFeePercentage: String(settings.late_fee_percentage),
    lateFeeGracePeriodDays: settings.late_fee_grace_period_days,
    lateFeeMaxAmount: String(settings.late_fee_max_amount),
    autoHoldEnabled: settings.auto_hold_enabled,
    autoHoldMaxOverdueDays: settings.auto_hold_max_overdue_days,
    autoHoldMaxOverdueAmount: String(settings.auto_hold_max_overdue_amount),
    autoHoldUtilizationThreshold: String(settings.auto_hold_utilization_threshold),
    currencyCode: settings.currency_code,
    updatedAt: settings.updated_at.toISOString(),
  };
}

export async function updateCreditSettings(
  trx: TenantTransactionContext,
  input: UpdateCustomerCreditSettingsRequest,
): Promise<CustomerCreditSettingsResponse> {
  await assertAuthorized(trx, { permission: 'crm:settings:manage' });

  // Ensure row exists
  await getOrInitCreditSettings(trx);

  const updateValues: Record<string, unknown> = {
    updated_at: sql<Date>`clock_timestamp()`,
  };

  if (input.defaultCreditLimit !== undefined) updateValues['default_credit_limit'] = input.defaultCreditLimit;
  if (input.defaultCreditTerms !== undefined) updateValues['default_credit_terms'] = input.defaultCreditTerms;
  if (input.defaultCustomDays !== undefined) updateValues['default_custom_days'] = input.defaultCustomDays;
  if (input.approvalPolicy !== undefined) updateValues['approval_policy'] = input.approvalPolicy;
  if (input.approvalThresholdAmount !== undefined) updateValues['approval_threshold_amount'] = input.approvalThresholdAmount;
  if (input.requireApprovalForOverrides !== undefined) updateValues['require_approval_for_overrides'] = input.requireApprovalForOverrides;
  if (input.requireApprovalForAdjustments !== undefined) updateValues['require_approval_for_adjustments'] = input.requireApprovalForAdjustments;
  if (input.interestEnabled !== undefined) updateValues['interest_enabled'] = input.interestEnabled;
  if (input.interestCalculationMode !== undefined) updateValues['interest_calculation_mode'] = input.interestCalculationMode;
  if (input.interestRatePercentage !== undefined) updateValues['interest_rate_percentage'] = input.interestRatePercentage;
  if (input.interestGracePeriodDays !== undefined) updateValues['interest_grace_period_days'] = input.interestGracePeriodDays;
  if (input.compoundingEnabled !== undefined) updateValues['compounding_enabled'] = input.compoundingEnabled;
  if (input.lateFeeEnabled !== undefined) updateValues['late_fee_enabled'] = input.lateFeeEnabled;
  if (input.lateFeeType !== undefined) updateValues['late_fee_type'] = input.lateFeeType;
  if (input.lateFeeAmount !== undefined) updateValues['late_fee_amount'] = input.lateFeeAmount;
  if (input.lateFeePercentage !== undefined) updateValues['late_fee_percentage'] = input.lateFeePercentage;
  if (input.lateFeeGracePeriodDays !== undefined) updateValues['late_fee_grace_period_days'] = input.lateFeeGracePeriodDays;
  if (input.lateFeeMaxAmount !== undefined) updateValues['late_fee_max_amount'] = input.lateFeeMaxAmount;
  if (input.autoHoldEnabled !== undefined) updateValues['auto_hold_enabled'] = input.autoHoldEnabled;
  if (input.autoHoldMaxOverdueDays !== undefined) updateValues['auto_hold_max_overdue_days'] = input.autoHoldMaxOverdueDays;
  if (input.autoHoldMaxOverdueAmount !== undefined) updateValues['auto_hold_max_overdue_amount'] = input.autoHoldMaxOverdueAmount;
  if (input.autoHoldUtilizationThreshold !== undefined) updateValues['auto_hold_utilization_threshold'] = input.autoHoldUtilizationThreshold;

  await trx.db
    .updateTable('customer_credit_settings')
    .set(updateValues)
    .where('tenant_id', '=', trx.tenantId)
    .execute();

  await appendAuditLog(trx, {
    action: 'crm:settings:update',
    resourceType: 'customer_credit_settings',
    resourceId: trx.tenantId,
    metadata: { updatedKeys: Object.keys(updateValues) },
  });

  return getOrInitCreditSettings(trx);
}

export async function calculateAndAccrueInterest(
  trx: TenantTransactionContext,
  options?: { accountId?: string; asOfDate?: string },
): Promise<{ processedCount: number; totalInterestAccrued: string }> {
  await assertAuthorized(trx, { permission: 'crm:interest:manage' });

  const settings = await getOrInitCreditSettings(trx);
  if (!settings.interestEnabled) {
    throw new AppError({
      statusCode: 400,
      errorCode: 'CREDIT_INTEREST_DISABLED',
      title: 'Interest Disabled',
      detail: 'Interest calculation is disabled by organization policy.',
    });
  }

  const asOf = options?.asOfDate ? new Date(options.asOfDate) : new Date();
  const graceDays = settings.interestGracePeriodDays;
  const ratePct = parseFloat(settings.interestRatePercentage);

  // Find overdue unpaid debit transactions
  let q = trx.db
    .selectFrom('customer_credit_transactions')
    .innerJoin('customer_credit_accounts', (j) =>
      j.onRef('customer_credit_transactions.tenant_id', '=', 'customer_credit_accounts.tenant_id')
       .onRef('customer_credit_transactions.account_id', '=', 'customer_credit_accounts.id'),
    )
    .select([
      'customer_credit_transactions.id as tx_id',
      'customer_credit_transactions.account_id',
      'customer_credit_transactions.customer_id',
      'customer_credit_transactions.branch_id',
      'customer_credit_transactions.unpaid_amount',
      'customer_credit_transactions.due_date',
      'customer_credit_transactions.source_reference_id',
      'customer_credit_transactions.transaction_reference',
      'customer_credit_accounts.credit_limit',
      'customer_credit_accounts.current_balance',
    ])
    .where('customer_credit_transactions.tenant_id', '=', trx.tenantId)
    .where('customer_credit_transactions.entry_direction', '=', 'DEBIT')
    .where(sql`unpaid_amount::numeric`, '>', 0)
    .where('customer_credit_transactions.due_date', 'is not', null)
    .where('customer_credit_accounts.status', 'in', ['ACTIVE', 'ON_HOLD']);

  if (options?.accountId) {
    q = q.where('customer_credit_transactions.account_id', '=', options.accountId);
  }

  const rows = await q.execute();

  let processedCount = 0;
  let totalAccruedMoney = Money.zero('LKR');
  const yearMonth = asOf.toISOString().slice(0, 7).replace('-', '');

  for (const row of rows) {
    if (!row.due_date) continue;
    const dueDate = new Date(row.due_date);
    const diffTime = asOf.getTime() - dueDate.getTime();
    const overdueDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));

    if (overdueDays <= graceDays) continue;

    // Check if interest was already charged for this transaction in the current period
    const existingEntry = await trx.db
      .selectFrom('customer_credit_interest_entries')
      .select(['id'])
      .where('tenant_id', '=', trx.tenantId)
      .where('source_invoice_id', '=', row.tx_id)
      .where('status', '=', 'POSTED')
      .where('calculation_period_end', '>=', sql<Date>`CURRENT_DATE - INTERVAL '25 days'`)
      .executeTakeFirst();

    if (existingEntry) continue;

    const principal = parseFloat(String(row.unpaid_amount));
    let calculatedInterest = 0;

    if (settings.interestCalculationMode === 'DAILY') {
      calculatedInterest = principal * (ratePct / 100 / 365) * overdueDays;
    } else if (settings.interestCalculationMode === 'MONTHLY') {
      calculatedInterest = principal * (ratePct / 100);
    } else if (settings.interestCalculationMode === 'ANNUAL') {
      calculatedInterest = principal * (ratePct / 100 / 365) * overdueDays;
    } else {
      calculatedInterest = principal * (ratePct / 100);
    }

    // Round to 4 decimal places
    const interestAmountStr = Math.max(0, calculatedInterest).toFixed(4);
    const interestMoney = Money.fromDecimalString(interestAmountStr, 'LKR');

    if (!interestMoney.isPositive()) continue;

    const interestEntryId = generateUuidV7();
    const txId = generateUuidV7();
    const txRef = `CTX-${yearMonth}-${generateUuidV7().slice(-5).toUpperCase()}`;

    // Update account balances
    const curBalMoney = Money.fromDecimalString(String(row.current_balance), 'LKR');
    const newBalMoney = curBalMoney.add(interestMoney);
    const limitMoney = Money.fromDecimalString(String(row.credit_limit), 'LKR');
    const newAvailMoney = limitMoney.compare(newBalMoney) > 0
      ? limitMoney.subtract(newBalMoney)
      : Money.zero('LKR');

    // Post to ledger
    await trx.db.insertInto('customer_credit_transactions').values({
      id: txId,
      tenant_id: trx.tenantId,
      account_id: row.account_id,
      customer_id: row.customer_id,
      branch_id: row.branch_id,
      transaction_reference: txRef,
      transaction_type: 'INTEREST_CHARGE',
      entry_direction: 'DEBIT',
      amount: interestMoney.toDecimalString(),
      currency_code: 'LKR',
      balance_after: newBalMoney.toDecimalString(),
      unpaid_amount: interestMoney.toDecimalString(),
      transaction_date: sql<string>`CURRENT_DATE`,
      due_date: sql<string>`CURRENT_DATE + INTERVAL '14 days'`,
      source_reference_type: 'INTEREST',
      source_reference_id: row.tx_id,
      source_reference_number: row.transaction_reference,
      description: `Interest charge (${settings.interestRatePercentage}%) on ${row.transaction_reference}`,
      created_by_user_id: trx.userId,
    }).execute();

    // Record interest entry
    await trx.db.insertInto('customer_credit_interest_entries').values({
      id: interestEntryId,
      tenant_id: trx.tenantId,
      account_id: row.account_id,
      transaction_id: txId,
      source_invoice_id: row.tx_id,
      calculation_period_start: String(row.due_date).slice(0, 10),
      calculation_period_end: asOf.toISOString().slice(0, 10),
      eligible_principal: String(row.unpaid_amount),
      rate_percentage: String(settings.interestRatePercentage),
      calculation_mode: settings.interestCalculationMode,
      calculated_amount: interestMoney.toDecimalString(),
      status: 'POSTED',
    }).execute();

    // Update account
    await trx.db
      .updateTable('customer_credit_accounts')
      .set({
        current_balance: newBalMoney.toDecimalString(),
        available_credit: newAvailMoney.toDecimalString(),
        total_interest_charged: sql`total_interest_charged + ${interestMoney.toDecimalString()}::numeric`,
        updated_at: sql<Date>`clock_timestamp()`,
      })
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', row.account_id)
      .execute();

    processedCount++;
    totalAccruedMoney = totalAccruedMoney.add(interestMoney);
  }

  return {
    processedCount,
    totalInterestAccrued: totalAccruedMoney.toDecimalString(),
  };
}

export async function calculateAndApplyLateFees(
  trx: TenantTransactionContext,
  options?: { accountId?: string; asOfDate?: string },
): Promise<{ processedCount: number; totalLateFeesApplied: string }> {
  await assertAuthorized(trx, { permission: 'crm:interest:manage' });

  const settings = await getOrInitCreditSettings(trx);
  if (!settings.lateFeeEnabled) {
    throw new AppError({
      statusCode: 400,
      errorCode: 'CREDIT_LATE_FEE_DISABLED',
      title: 'Late Fees Disabled',
      detail: 'Late fee calculation is disabled by organization policy.',
    });
  }

  const asOf = options?.asOfDate ? new Date(options.asOfDate) : new Date();
  const graceDays = settings.lateFeeGracePeriodDays;

  let q = trx.db
    .selectFrom('customer_credit_transactions')
    .innerJoin('customer_credit_accounts', (j) =>
      j.onRef('customer_credit_transactions.tenant_id', '=', 'customer_credit_accounts.tenant_id')
       .onRef('customer_credit_transactions.account_id', '=', 'customer_credit_accounts.id'),
    )
    .select([
      'customer_credit_transactions.id as tx_id',
      'customer_credit_transactions.account_id',
      'customer_credit_transactions.customer_id',
      'customer_credit_transactions.branch_id',
      'customer_credit_transactions.unpaid_amount',
      'customer_credit_transactions.due_date',
      'customer_credit_transactions.transaction_reference',
      'customer_credit_accounts.credit_limit',
      'customer_credit_accounts.current_balance',
    ])
    .where('customer_credit_transactions.tenant_id', '=', trx.tenantId)
    .where('customer_credit_transactions.entry_direction', '=', 'DEBIT')
    .where(sql`unpaid_amount::numeric`, '>', 0)
    .where('customer_credit_transactions.due_date', 'is not', null)
    .where('customer_credit_accounts.status', 'in', ['ACTIVE', 'ON_HOLD']);

  if (options?.accountId) {
    q = q.where('customer_credit_transactions.account_id', '=', options.accountId);
  }

  const rows = await q.execute();

  let processedCount = 0;
  let totalAppliedMoney = Money.zero('LKR');
  const yearMonth = asOf.toISOString().slice(0, 7).replace('-', '');

  for (const row of rows) {
    if (!row.due_date) continue;
    const dueDate = new Date(row.due_date);
    const diffTime = asOf.getTime() - dueDate.getTime();
    const overdueDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));

    if (overdueDays <= graceDays) continue;

    // Check if late fee was already charged for this transaction
    const existingFee = await trx.db
      .selectFrom('customer_credit_late_fee_entries')
      .select(['id'])
      .where('tenant_id', '=', trx.tenantId)
      .where('source_invoice_id', '=', row.tx_id)
      .where('status', '=', 'POSTED')
      .executeTakeFirst();

    if (existingFee) continue;

    let feeVal = 0;
    if (settings.lateFeeType === 'FIXED') {
      feeVal = parseFloat(settings.lateFeeAmount);
    } else if (settings.lateFeeType === 'PERCENTAGE') {
      feeVal = parseFloat(String(row.unpaid_amount)) * (parseFloat(settings.lateFeePercentage) / 100);
    } else {
      // PER_DAY
      const maxVal = parseFloat(settings.lateFeeMaxAmount);
      feeVal = Math.min(maxVal, overdueDays * parseFloat(settings.lateFeeAmount));
    }

    const feeMoney = Money.fromDecimalString(feeVal.toFixed(4), 'LKR');
    if (!feeMoney.isPositive()) continue;

    const feeEntryId = generateUuidV7();
    const txId = generateUuidV7();
    const txRef = `CTX-${yearMonth}-${generateUuidV7().slice(-5).toUpperCase()}`;

    const curBalMoney = Money.fromDecimalString(String(row.current_balance), 'LKR');
    const newBalMoney = curBalMoney.add(feeMoney);
    const limitMoney = Money.fromDecimalString(String(row.credit_limit), 'LKR');
    const newAvailMoney = limitMoney.compare(newBalMoney) > 0
      ? limitMoney.subtract(newBalMoney)
      : Money.zero('LKR');

    // Post to ledger
    await trx.db.insertInto('customer_credit_transactions').values({
      id: txId,
      tenant_id: trx.tenantId,
      account_id: row.account_id,
      customer_id: row.customer_id,
      branch_id: row.branch_id,
      transaction_reference: txRef,
      transaction_type: 'LATE_FEE',
      entry_direction: 'DEBIT',
      amount: feeMoney.toDecimalString(),
      currency_code: 'LKR',
      balance_after: newBalMoney.toDecimalString(),
      unpaid_amount: feeMoney.toDecimalString(),
      transaction_date: sql<string>`CURRENT_DATE`,
      due_date: sql<string>`CURRENT_DATE + INTERVAL '7 days'`,
      source_reference_type: 'LATE_FEE',
      source_reference_id: row.tx_id,
      source_reference_number: row.transaction_reference,
      description: `Late payment fee on ${row.transaction_reference} (${overdueDays} days overdue)`,
      created_by_user_id: trx.userId,
    }).execute();

    // Record late fee entry
    await trx.db.insertInto('customer_credit_late_fee_entries').values({
      id: feeEntryId,
      tenant_id: trx.tenantId,
      account_id: row.account_id,
      transaction_id: txId,
      source_invoice_id: row.tx_id,
      fee_type: settings.lateFeeType,
      overdue_days: overdueDays,
      fee_amount: feeMoney.toDecimalString(),
      status: 'POSTED',
    }).execute();

    // Update account
    await trx.db
      .updateTable('customer_credit_accounts')
      .set({
        current_balance: newBalMoney.toDecimalString(),
        available_credit: newAvailMoney.toDecimalString(),
        total_late_fees: sql`total_late_fees + ${feeMoney.toDecimalString()}::numeric`,
        updated_at: sql<Date>`clock_timestamp()`,
      })
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', row.account_id)
      .execute();

    processedCount++;
    totalAppliedMoney = totalAppliedMoney.add(feeMoney);
  }

  return {
    processedCount,
    totalLateFeesApplied: totalAppliedMoney.toDecimalString(),
  };
}

export async function waiveInterestOrLateFee(
  trx: TenantTransactionContext,
  input: { entryId: string; feeType: 'INTEREST' | 'LATE_FEE'; reason: string },
): Promise<{ success: boolean; waivedAmount: string }> {
  await assertAuthorized(trx, { permission: 'crm:interest:waive' });

  if (input.feeType === 'INTEREST') {
    const entry = await trx.db
      .selectFrom('customer_credit_interest_entries')
      .selectAll()
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', input.entryId)
      .forUpdate()
      .executeTakeFirst();

    if (!entry) {
      throw new AppError({
        statusCode: 404,
        errorCode: 'ERR_NOT_FOUND',
        title: 'Interest Entry Not Found',
        detail: `Interest entry "${input.entryId}" was not found.`,
      });
    }

    if (entry.status !== 'POSTED') {
      throw new AppError({
        statusCode: 409,
        errorCode: 'ERR_CONFLICT',
        title: 'Already Waived',
        detail: `Interest entry is already ${entry.status}.`,
      });
    }

    const waivedMoney = Money.fromDecimalString(String(entry.calculated_amount), 'LKR');

    await trx.db
      .updateTable('customer_credit_interest_entries')
      .set({
        status: 'WAIVED',
        waiver_reason: input.reason.trim(),
        waived_by_user_id: trx.userId,
        waived_at: sql<Date>`clock_timestamp()`,
      })
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', input.entryId)
      .execute();

    // Post compensating adjustment credit in ledger
    const yearMonth = new Date().toISOString().slice(0, 7).replace('-', '');
    const txRef = `CTX-${yearMonth}-${generateUuidV7().slice(-5).toUpperCase()}`;

    const account = await trx.db
      .selectFrom('customer_credit_accounts')
      .select(['id', 'customer_id', 'branch_id', 'current_balance', 'credit_limit'])
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', entry.account_id)
      .forUpdate()
      .executeTakeFirstOrThrow();

    const curBalMoney = Money.fromDecimalString(String(account.current_balance), 'LKR');
    const newBalMoney = curBalMoney.compare(waivedMoney) > 0 ? curBalMoney.subtract(waivedMoney) : Money.zero('LKR');
    const limitMoney = Money.fromDecimalString(String(account.credit_limit), 'LKR');
    const newAvailMoney = limitMoney.compare(newBalMoney) > 0 ? limitMoney.subtract(newBalMoney) : Money.zero('LKR');

    await trx.db.insertInto('customer_credit_transactions').values({
      id: generateUuidV7(),
      tenant_id: trx.tenantId,
      account_id: account.id,
      customer_id: account.customer_id,
      branch_id: account.branch_id,
      transaction_reference: txRef,
      transaction_type: 'ADJUSTMENT_CREDIT',
      entry_direction: 'CREDIT',
      amount: waivedMoney.toDecimalString(),
      currency_code: 'LKR',
      balance_after: newBalMoney.toDecimalString(),
      unpaid_amount: '0.0000',
      transaction_date: sql<string>`CURRENT_DATE`,
      source_reference_type: 'INTEREST_WAIVER',
      source_reference_id: entry.id,
      description: `Waiver of interest charge: ${input.reason.trim()}`,
      created_by_user_id: trx.userId,
    }).execute();

    await trx.db
      .updateTable('customer_credit_accounts')
      .set({
        current_balance: newBalMoney.toDecimalString(),
        available_credit: newAvailMoney.toDecimalString(),
        total_interest_charged: sql`GREATEST(0, total_interest_charged - ${waivedMoney.toDecimalString()}::numeric)`,
        updated_at: sql<Date>`clock_timestamp()`,
      })
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', account.id)
      .execute();

    return { success: true, waivedAmount: waivedMoney.toDecimalString() };
  } else {
    const entry = await trx.db
      .selectFrom('customer_credit_late_fee_entries')
      .selectAll()
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', input.entryId)
      .forUpdate()
      .executeTakeFirst();

    if (!entry) {
      throw new AppError({
        statusCode: 404,
        errorCode: 'ERR_NOT_FOUND',
        title: 'Late Fee Entry Not Found',
        detail: `Late fee entry "${input.entryId}" was not found.`,
      });
    }

    if (entry.status !== 'POSTED') {
      throw new AppError({
        statusCode: 409,
        errorCode: 'ERR_CONFLICT',
        title: 'Already Waived',
        detail: `Late fee entry is already ${entry.status}.`,
      });
    }

    const waivedMoney = Money.fromDecimalString(String(entry.fee_amount), 'LKR');

    await trx.db
      .updateTable('customer_credit_late_fee_entries')
      .set({
        status: 'WAIVED',
        waiver_reason: input.reason.trim(),
        waived_by_user_id: trx.userId,
        waived_at: sql<Date>`clock_timestamp()`,
      })
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', input.entryId)
      .execute();

    const yearMonth = new Date().toISOString().slice(0, 7).replace('-', '');
    const txRef = `CTX-${yearMonth}-${generateUuidV7().slice(-5).toUpperCase()}`;

    const account = await trx.db
      .selectFrom('customer_credit_accounts')
      .select(['id', 'customer_id', 'branch_id', 'current_balance', 'credit_limit'])
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', entry.account_id)
      .forUpdate()
      .executeTakeFirstOrThrow();

    const curBalMoney = Money.fromDecimalString(String(account.current_balance), 'LKR');
    const newBalMoney = curBalMoney.compare(waivedMoney) > 0 ? curBalMoney.subtract(waivedMoney) : Money.zero('LKR');
    const limitMoney = Money.fromDecimalString(String(account.credit_limit), 'LKR');
    const newAvailMoney = limitMoney.compare(newBalMoney) > 0 ? limitMoney.subtract(newBalMoney) : Money.zero('LKR');

    await trx.db.insertInto('customer_credit_transactions').values({
      id: generateUuidV7(),
      tenant_id: trx.tenantId,
      account_id: account.id,
      customer_id: account.customer_id,
      branch_id: account.branch_id,
      transaction_reference: txRef,
      transaction_type: 'ADJUSTMENT_CREDIT',
      entry_direction: 'CREDIT',
      amount: waivedMoney.toDecimalString(),
      currency_code: 'LKR',
      balance_after: newBalMoney.toDecimalString(),
      unpaid_amount: '0.0000',
      transaction_date: sql<string>`CURRENT_DATE`,
      source_reference_type: 'LATE_FEE_WAIVER',
      source_reference_id: entry.id,
      description: `Waiver of late fee: ${input.reason.trim()}`,
      created_by_user_id: trx.userId,
    }).execute();

    await trx.db
      .updateTable('customer_credit_accounts')
      .set({
        current_balance: newBalMoney.toDecimalString(),
        available_credit: newAvailMoney.toDecimalString(),
        total_late_fees: sql`GREATEST(0, total_late_fees - ${waivedMoney.toDecimalString()}::numeric)`,
        updated_at: sql<Date>`clock_timestamp()`,
      })
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', account.id)
      .execute();

    return { success: true, waivedAmount: waivedMoney.toDecimalString() };
  }
}

import {
  type AgingBucket,
  type CollectionRecordResponse,
  type ProcessBadDebtWriteOffRequest,
  type RecordCollectionFollowUpRequest,
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
import { getOrInitCreditSettings } from './interest-latefee.service.js';

export async function getAccountAging(
  trx: TenantTransactionContext,
  accountId: string,
  asOfDate?: string,
): Promise<AgingBucket> {
  const asOf = asOfDate ? new Date(asOfDate) : new Date();

  const txs = await trx.db
    .selectFrom('customer_credit_transactions')
    .select(['id', 'unpaid_amount', 'due_date', 'transaction_date'])
    .where('tenant_id', '=', trx.tenantId)
    .where('account_id', '=', accountId)
    .where('entry_direction', '=', 'DEBIT')
    .where(sql`unpaid_amount::numeric`, '>', 0)
    .execute();

  let currentMoney = Money.zero('LKR');
  let days1To30Money = Money.zero('LKR');
  let days31To60Money = Money.zero('LKR');
  let days61To90Money = Money.zero('LKR');
  let days90PlusMoney = Money.zero('LKR');

  for (const tx of txs) {
    const unpaidMoney = Money.fromDecimalString(String(tx.unpaid_amount), 'LKR');
    const dueDate = tx.due_date ? new Date(tx.due_date) : new Date(tx.transaction_date);
    const diffTime = asOf.getTime() - dueDate.getTime();
    const overdueDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));

    if (overdueDays <= 0) {
      currentMoney = currentMoney.add(unpaidMoney);
    } else if (overdueDays <= 30) {
      days1To30Money = days1To30Money.add(unpaidMoney);
    } else if (overdueDays <= 60) {
      days31To60Money = days31To60Money.add(unpaidMoney);
    } else if (overdueDays <= 90) {
      days61To90Money = days61To90Money.add(unpaidMoney);
    } else {
      days90PlusMoney = days90PlusMoney.add(unpaidMoney);
    }
  }

  const totalOverdueMoney = days1To30Money
    .add(days31To60Money)
    .add(days61To90Money)
    .add(days90PlusMoney);
  const totalOutstandingMoney = currentMoney.add(totalOverdueMoney);

  // Evaluate risk classification
  let risk: 'LOW_RISK' | 'MEDIUM_RISK' | 'HIGH_RISK' | 'CRITICAL_RISK' = 'LOW_RISK';
  if (days90PlusMoney.isPositive() || days61To90Money.isPositive()) {
    risk = 'CRITICAL_RISK';
  } else if (days31To60Money.isPositive()) {
    risk = 'HIGH_RISK';
  } else if (days1To30Money.isPositive()) {
    risk = 'MEDIUM_RISK';
  }

  // Update account risk classification
  await trx.db
    .updateTable('customer_credit_accounts')
    .set({
      risk_classification: risk,
      updated_at: sql<Date>`clock_timestamp()`,
    })
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', accountId)
    .execute();

  // Evaluate Auto-Hold policy
  const settings = await getOrInitCreditSettings(trx);
  if (settings.autoHoldEnabled) {
    const maxOverdueAmtMoney = Money.fromDecimalString(settings.autoHoldMaxOverdueAmount, 'LKR');
    const isOverdueAmountExceeded = totalOverdueMoney.compare(maxOverdueAmtMoney) > 0;
    const isOverdueDaysExceeded = days61To90Money.isPositive() || days90PlusMoney.isPositive();

    if (isOverdueAmountExceeded || isOverdueDaysExceeded) {
      const acc = await trx.db
        .selectFrom('customer_credit_accounts')
        .select(['id', 'status'])
        .where('tenant_id', '=', trx.tenantId)
        .where('id', '=', accountId)
        .executeTakeFirst();

      if (acc && acc.status === 'ACTIVE') {
        const reason = isOverdueAmountExceeded
          ? `Automatic credit hold: overdue balance LKR ${totalOverdueMoney.toDecimalString()} exceeds maximum allowed threshold of LKR ${maxOverdueAmtMoney.toDecimalString()}`
          : 'Automatic credit hold: invoices severely overdue exceeding 60 days';

        await trx.db
          .updateTable('customer_credit_accounts')
          .set({
            status: 'ON_HOLD',
            hold_reason: reason,
            held_at: sql<Date>`clock_timestamp()`,
            updated_at: sql<Date>`clock_timestamp()`,
          })
          .where('tenant_id', '=', trx.tenantId)
          .where('id', '=', accountId)
          .execute();
      }
    }
  }

  return {
    current: currentMoney.toDecimalString(),
    days1To30: days1To30Money.toDecimalString(),
    days31To60: days31To60Money.toDecimalString(),
    days61To90: days61To90Money.toDecimalString(),
    days90Plus: days90PlusMoney.toDecimalString(),
    totalOverdue: totalOverdueMoney.toDecimalString(),
    totalOutstanding: totalOutstandingMoney.toDecimalString(),
  };
}

export async function recordCollectionFollowUp(
  trx: TenantTransactionContext,
  input: RecordCollectionFollowUpRequest,
): Promise<CollectionRecordResponse> {
  await assertAuthorized(trx, { permission: 'crm:collection:manage' });

  const account = await trx.db
    .selectFrom('customer_credit_accounts')
    .innerJoin('customers', (j) =>
      j.onRef('customer_credit_accounts.tenant_id', '=', 'customers.tenant_id')
       .onRef('customer_credit_accounts.customer_id', '=', 'customers.id'),
    )
    .select(['customer_credit_accounts.id', 'customer_credit_accounts.customer_id', 'customers.name as customer_name'])
    .where('customer_credit_accounts.tenant_id', '=', trx.tenantId)
    .where('customer_credit_accounts.id', '=', input.accountId)
    .executeTakeFirst();

  if (!account) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'CREDIT_ACCOUNT_NOT_FOUND',
      title: 'Credit Account Not Found',
      detail: `Credit account "${input.accountId}" does not exist.`,
    });
  }

  const id = generateUuidV7();
  const row = await trx.db
    .insertInto('customer_credit_collections')
    .values({
      id,
      tenant_id: trx.tenantId,
      account_id: account.id,
      customer_id: account.customer_id,
      follow_up_date: input.followUpDate ?? sql<string>`CURRENT_DATE`,
      collector_user_id: trx.userId,
      contact_method: input.contactMethod,
      contact_person: input.contactPerson?.trim() || null,
      notes: input.notes.trim(),
      promise_to_pay_date: input.promiseToPayDate ?? null,
      promise_amount: input.promiseAmount ? input.promiseAmount : null,
      outcome: input.outcome,
      next_follow_up_date: input.nextFollowUpDate ?? null,
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  await appendAuditLog(trx, {
    action: 'crm:collection:record',
    resourceType: 'customer_credit_collections',
    resourceId: id,
    metadata: {
      accountId: account.id,
      outcome: input.outcome,
      promiseToPayDate: input.promiseToPayDate,
    },
  });

  const user = await trx.db
    .selectFrom('users')
    .select(['full_name'])
    .where('id', '=', trx.userId)
    .executeTakeFirst();

  return {
    id: row.id,
    accountId: row.account_id,
    customerId: row.customer_id,
    customerName: account.customer_name,
    followUpDate: String(row.follow_up_date).slice(0, 10),
    collectorName: user?.full_name ?? 'Collector',
    contactMethod: row.contact_method,
    contactPerson: row.contact_person,
    notes: row.notes,
    promiseToPayDate: row.promise_to_pay_date ? String(row.promise_to_pay_date).slice(0, 10) : null,
    promiseAmount: row.promise_amount != null ? String(row.promise_amount) : null,
    outcome: row.outcome,
    nextFollowUpDate: row.next_follow_up_date ? String(row.next_follow_up_date).slice(0, 10) : null,
    createdAt: row.created_at.toISOString(),
  };
}

export async function listCollectionHistory(
  trx: TenantTransactionContext,
  accountId: string,
): Promise<CollectionRecordResponse[]> {
  await assertAuthorized(trx, { permission: 'crm:ledger:read' });

  const rows = await trx.db
    .selectFrom('customer_credit_collections')
    .innerJoin('customers', (j) =>
      j.onRef('customer_credit_collections.tenant_id', '=', 'customers.tenant_id')
       .onRef('customer_credit_collections.customer_id', '=', 'customers.id'),
    )
    .innerJoin('users', 'customer_credit_collections.collector_user_id', 'users.id')
    .select([
      'customer_credit_collections.id',
      'customer_credit_collections.account_id',
      'customer_credit_collections.customer_id',
      'customers.name as customer_name',
      'customer_credit_collections.follow_up_date',
      'users.full_name as collector_name',
      'customer_credit_collections.contact_method',
      'customer_credit_collections.contact_person',
      'customer_credit_collections.notes',
      'customer_credit_collections.promise_to_pay_date',
      'customer_credit_collections.promise_amount',
      'customer_credit_collections.outcome',
      'customer_credit_collections.next_follow_up_date',
      'customer_credit_collections.created_at',
    ])
    .where('customer_credit_collections.tenant_id', '=', trx.tenantId)
    .where('customer_credit_collections.account_id', '=', accountId)
    .orderBy('customer_credit_collections.follow_up_date', 'desc')
    .execute();

  return rows.map((r) => ({
    id: r.id,
    accountId: r.account_id,
    customerId: r.customer_id,
    customerName: r.customer_name,
    followUpDate: String(r.follow_up_date).slice(0, 10),
    collectorName: r.collector_name,
    contactMethod: r.contact_method,
    contactPerson: r.contact_person,
    notes: r.notes,
    promiseToPayDate: r.promise_to_pay_date ? String(r.promise_to_pay_date).slice(0, 10) : null,
    promiseAmount: r.promise_amount != null ? String(r.promise_amount) : null,
    outcome: r.outcome,
    nextFollowUpDate: r.next_follow_up_date ? String(r.next_follow_up_date).slice(0, 10) : null,
    createdAt: r.created_at.toISOString(),
  }));
}

export async function processBadDebtWriteOff(
  trx: TenantTransactionContext,
  input: ProcessBadDebtWriteOffRequest,
): Promise<{ success: boolean; writeoffAmount: string; remainingBalance: string }> {
  await assertAuthorized(trx, { permission: 'crm:writeoff:approve' });

  const account = await trx.db
    .selectFrom('customer_credit_accounts')
    .select(['id', 'customer_id', 'branch_id', 'current_balance', 'credit_limit'])
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', input.accountId)
    .forUpdate()
    .executeTakeFirst();

  if (!account) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'CREDIT_ACCOUNT_NOT_FOUND',
      title: 'Credit Account Not Found',
      detail: `Credit account "${input.accountId}" does not exist.`,
    });
  }

  const writeoffMoney = Money.fromDecimalString(input.writeoffAmount, 'LKR');
  if (!writeoffMoney.isPositive()) {
    throw new AppError({
      statusCode: 400,
      errorCode: 'ERR_VALIDATION_FAILED',
      title: 'Invalid Write-off Amount',
      detail: 'Write-off amount must be strictly positive.',
    });
  }

  const curBalMoney = Money.fromDecimalString(String(account.current_balance), 'LKR');
  if (writeoffMoney.compare(curBalMoney) > 0) {
    throw new AppError({
      statusCode: 400,
      errorCode: 'CREDIT_WRITEOFF_EXCEEDS_BALANCE',
      title: 'Write-off Exceeds Balance',
      detail: `Write-off amount LKR ${writeoffMoney.toDecimalString()} exceeds outstanding balance LKR ${curBalMoney.toDecimalString()}.`,
    });
  }

  const remainingMoney = curBalMoney.subtract(writeoffMoney);
  const limitMoney = Money.fromDecimalString(String(account.credit_limit), 'LKR');
  const newAvailMoney = limitMoney.compare(remainingMoney) > 0
    ? limitMoney.subtract(remainingMoney)
    : Money.zero('LKR');

  const yearMonth = new Date().toISOString().slice(0, 7).replace('-', '');
  const txRef = `CTX-${yearMonth}-${generateUuidV7().slice(-5).toUpperCase()}`;
  const txId = generateUuidV7();

  // 1. Post WRITE_OFF ledger entry
  await trx.db.insertInto('customer_credit_transactions').values({
    id: txId,
    tenant_id: trx.tenantId,
    account_id: account.id,
    customer_id: account.customer_id,
    branch_id: account.branch_id,
    transaction_reference: txRef,
    transaction_type: 'WRITE_OFF',
    entry_direction: 'CREDIT',
    amount: writeoffMoney.toDecimalString(),
    currency_code: 'LKR',
    balance_after: remainingMoney.toDecimalString(),
    unpaid_amount: '0.0000',
    transaction_date: sql<string>`CURRENT_DATE`,
    source_reference_type: 'WRITE_OFF',
    source_reference_id: txId,
    description: `Bad Debt Write-off: ${input.reason.trim()}`,
    created_by_user_id: trx.userId,
  }).execute();

  // 2. Record in customer_credit_writeoffs
  await trx.db.insertInto('customer_credit_writeoffs').values({
    id: generateUuidV7(),
    tenant_id: trx.tenantId,
    account_id: account.id,
    customer_id: account.customer_id,
    transaction_id: txId,
    original_outstanding: curBalMoney.toDecimalString(),
    writeoff_amount: writeoffMoney.toDecimalString(),
    remaining_balance: remainingMoney.toDecimalString(),
    reason: input.reason.trim(),
    supporting_notes: input.supportingNotes?.trim() || null,
    approved_by_user_id: trx.userId,
  }).execute();

  // Reduce open debit transactions FIFO
  const unpaidTxs = await trx.db
    .selectFrom('customer_credit_transactions')
    .select(['id', 'unpaid_amount'])
    .where('tenant_id', '=', trx.tenantId)
    .where('account_id', '=', account.id)
    .where('entry_direction', '=', 'DEBIT')
    .where(sql`unpaid_amount::numeric`, '>', 0)
    .orderBy('transaction_date', 'asc')
    .orderBy('created_at', 'asc')
    .forUpdate()
    .execute();

  let remainingReduction = writeoffMoney;
  for (const tx of unpaidTxs) {
    if (remainingReduction.isZero()) break;
    const unpaidMoney = Money.fromDecimalString(String(tx.unpaid_amount), 'LKR');
    const reduceMoney = remainingReduction.compare(unpaidMoney) >= 0 ? unpaidMoney : remainingReduction;
    const newUnpaid = unpaidMoney.subtract(reduceMoney);
    remainingReduction = remainingReduction.subtract(reduceMoney);
    await trx.db
      .updateTable('customer_credit_transactions')
      .set({ unpaid_amount: newUnpaid.toDecimalString() })
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', tx.id)
      .execute();
  }

  // 3. Update account balances
  await trx.db
    .updateTable('customer_credit_accounts')
    .set({
      current_balance: remainingMoney.toDecimalString(),
      available_credit: newAvailMoney.toDecimalString(),
      total_written_off: sql`total_written_off + ${writeoffMoney.toDecimalString()}::numeric`,
      updated_at: sql<Date>`clock_timestamp()`,
    })
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', account.id)
    .execute();

  await appendAuditLog(trx, {
    action: 'crm:writeoff:approve',
    resourceType: 'customer_credit_writeoffs',
    resourceId: txId,
    metadata: {
      accountId: account.id,
      writeoffAmount: writeoffMoney.toDecimalString(),
      remainingBalance: remainingMoney.toDecimalString(),
      reason: input.reason,
    },
  });

  return {
    success: true,
    writeoffAmount: writeoffMoney.toDecimalString(),
    remainingBalance: remainingMoney.toDecimalString(),
  };
}

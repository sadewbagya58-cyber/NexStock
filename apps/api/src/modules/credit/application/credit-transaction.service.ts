import {
  type CreateManualCreditTransactionRequest,
  type CustomerCreditTransactionListResponse,
  type CustomerCreditTransactionResponse,
  type ListCreditTransactionsQuery,
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

export async function createManualCreditTransaction(
  trx: TenantTransactionContext,
  input: CreateManualCreditTransactionRequest,
): Promise<CustomerCreditTransactionResponse> {
  await assertAuthorized(trx, { permission: 'crm:transaction:create' });

  // 1. Fetch account with row lock
  const account = await trx.db
    .selectFrom('customer_credit_accounts')
    .select([
      'id',
      'customer_id',
      'credit_limit',
      'current_balance',
      'available_credit',
      'status',
      'branch_id',
    ])
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', input.accountId)
    .forUpdate()
    .executeTakeFirst();

  if (!account) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'CREDIT_ACCOUNT_NOT_FOUND',
      title: 'Credit Account Not Found',
      detail: `Credit account with ID "${input.accountId}" does not exist.`,
    });
  }

  if (account.status === 'CLOSED') {
    throw new AppError({
      statusCode: 409,
      errorCode: 'CREDIT_ACCOUNT_NOT_ACTIVE',
      title: 'Credit Account Closed',
      detail: 'Cannot post manual transactions to a closed customer credit account.',
    });
  }

  const amountMoney = Money.fromDecimalString(input.amount, 'LKR');
  if (!amountMoney.isPositive()) {
    throw new AppError({
      statusCode: 400,
      errorCode: 'ERR_VALIDATION_FAILED',
      title: 'Invalid Transaction Amount',
      detail: 'Transaction amount must be strictly positive.',
    });
  }

  const isDebit =
    input.transactionType === 'OPENING_BALANCE' ||
    input.transactionType === 'DEBIT_NOTE' ||
    input.transactionType === 'ADJUSTMENT_DEBIT';

  const entryDirection: 'DEBIT' | 'CREDIT' = isDebit ? 'DEBIT' : 'CREDIT';

  const curBalMoney = Money.fromDecimalString(String(account.current_balance), 'LKR');
  const creditLimitMoney = Money.fromDecimalString(String(account.credit_limit), 'LKR');

  let newBalMoney: Money;
  let newAvailMoney: Money;

  if (isDebit) {
    newBalMoney = curBalMoney.add(amountMoney);
    newAvailMoney = creditLimitMoney.compare(newBalMoney) > 0
      ? creditLimitMoney.subtract(newBalMoney)
      : Money.zero('LKR');
  } else {
    // Credit decreases debt
    newBalMoney = curBalMoney.compare(amountMoney) > 0
      ? curBalMoney.subtract(amountMoney)
      : Money.zero('LKR');
    newAvailMoney = creditLimitMoney.compare(newBalMoney) > 0
      ? creditLimitMoney.subtract(newBalMoney)
      : Money.zero('LKR');
  }

  const yearMonth = new Date().toISOString().slice(0, 7).replace('-', '');
  const txRef = `CTX-${yearMonth}-${generateUuidV7().slice(-5).toUpperCase()}`;
  const txId = generateUuidV7();

  await trx.db
    .insertInto('customer_credit_transactions')
    .values({
      id: txId,
      tenant_id: trx.tenantId,
      account_id: account.id,
      customer_id: account.customer_id,
      branch_id: account.branch_id,
      transaction_reference: txRef,
      transaction_type: input.transactionType,
      entry_direction: entryDirection,
      amount: amountMoney.toDecimalString(),
      currency_code: 'LKR',
      balance_after: newBalMoney.toDecimalString(),
      unpaid_amount: isDebit ? amountMoney.toDecimalString() : '0.0000',
      transaction_date: sql<string>`CURRENT_DATE`,
      due_date: input.dueDate ?? (isDebit ? sql<string>`CURRENT_DATE` : null),
      source_reference_type: input.sourceReferenceType ?? 'MANUAL',
      source_reference_number: input.sourceReferenceNumber ?? txRef,
      description: input.description.trim(),
      created_by_user_id: trx.userId,
    })
    .execute();

  // If Credit Note or Debit Note, record in customer_credit_notes
  if (input.transactionType === 'CREDIT_NOTE' || input.transactionType === 'DEBIT_NOTE') {
    const notePrefix = input.transactionType === 'CREDIT_NOTE' ? 'CRN' : 'DBN';
    const noteNumber = `${notePrefix}-${yearMonth}-${generateUuidV7().slice(-5).toUpperCase()}`;
    await trx.db.insertInto('customer_credit_notes').values({
      id: generateUuidV7(),
      tenant_id: trx.tenantId,
      account_id: account.id,
      customer_id: account.customer_id,
      transaction_id: txId,
      note_number: noteNumber,
      note_type: input.transactionType,
      amount: amountMoney.toDecimalString(),
      reason: input.description.trim(),
      created_by_user_id: trx.userId,
    }).execute();
  }

  // If credit note or adjustment credit, reduce open debits FIFO
  if (!isDebit) {
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

    let remainingReduction = amountMoney;
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
  }

  // Update account balances
  await trx.db
    .updateTable('customer_credit_accounts')
    .set({
      current_balance: newBalMoney.toDecimalString(),
      available_credit: newAvailMoney.toDecimalString(),
      updated_at: sql<Date>`clock_timestamp()`,
    })
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', account.id)
    .execute();

  await appendAuditLog(trx, {
    action: 'crm:transaction:create',
    resourceType: 'customer_credit_transactions',
    resourceId: txId,
    metadata: {
      transactionReference: txRef,
      transactionType: input.transactionType,
      amount: amountMoney.toDecimalString(),
      balanceAfter: newBalMoney.toDecimalString(),
    },
  });

  return getCreditTransactionById(trx, txId);
}

export async function getCreditTransactionById(
  trx: TenantTransactionContext,
  id: string,
): Promise<CustomerCreditTransactionResponse> {
  await assertAuthorized(trx, { permission: 'crm:ledger:read' });

  const row = await trx.db
    .selectFrom('customer_credit_transactions')
    .innerJoin('customers', (join) =>
      join
        .onRef('customer_credit_transactions.tenant_id', '=', 'customers.tenant_id')
        .onRef('customer_credit_transactions.customer_id', '=', 'customers.id'),
    )
    .select([
      'customer_credit_transactions.id',
      'customer_credit_transactions.account_id',
      'customer_credit_transactions.customer_id',
      'customers.name as customer_name',
      'customer_credit_transactions.branch_id',
      'customer_credit_transactions.transaction_reference',
      'customer_credit_transactions.transaction_type',
      'customer_credit_transactions.entry_direction',
      'customer_credit_transactions.amount',
      'customer_credit_transactions.currency_code',
      'customer_credit_transactions.balance_after',
      'customer_credit_transactions.unpaid_amount',
      'customer_credit_transactions.transaction_date',
      'customer_credit_transactions.posting_date',
      'customer_credit_transactions.due_date',
      'customer_credit_transactions.source_reference_type',
      'customer_credit_transactions.source_reference_id',
      'customer_credit_transactions.source_reference_number',
      'customer_credit_transactions.description',
      'customer_credit_transactions.is_reversed',
      'customer_credit_transactions.reversed_at',
      'customer_credit_transactions.created_at',
    ])
    .where('customer_credit_transactions.tenant_id', '=', trx.tenantId)
    .where('customer_credit_transactions.id', '=', id)
    .executeTakeFirst();

  if (!row) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'CREDIT_TRANSACTION_NOT_FOUND',
      title: 'Credit Transaction Not Found',
      detail: `Transaction with ID "${id}" was not found.`,
    });
  }

  return {
    id: row.id,
    accountId: row.account_id,
    customerId: row.customer_id,
    customerName: row.customer_name,
    branchId: row.branch_id,
    transactionReference: row.transaction_reference,
    transactionType: row.transaction_type,
    entryDirection: row.entry_direction,
    amount: String(row.amount),
    currencyCode: row.currency_code,
    balanceAfter: String(row.balance_after),
    unpaidAmount: String(row.unpaid_amount),
    transactionDate: String(row.transaction_date).slice(0, 10),
    postingDate: row.posting_date.toISOString(),
    dueDate: row.due_date ? String(row.due_date).slice(0, 10) : null,
    sourceReferenceType: row.source_reference_type,
    sourceReferenceId: row.source_reference_id,
    sourceReferenceNumber: row.source_reference_number,
    description: row.description,
    isReversed: row.is_reversed,
    reversedAt: row.reversed_at ? (row.reversed_at as Date).toISOString() : null,
    createdAt: row.created_at.toISOString(),
  };
}

export async function listCreditTransactions(
  trx: TenantTransactionContext,
  query: ListCreditTransactionsQuery,
): Promise<CustomerCreditTransactionListResponse> {
  await assertAuthorized(trx, { permission: 'crm:ledger:read' });

  const limit = query.limit ?? 50;
  const offset = query.offset ?? 0;

  let baseQuery = trx.db
    .selectFrom('customer_credit_transactions')
    .innerJoin('customers', (join) =>
      join
        .onRef('customer_credit_transactions.tenant_id', '=', 'customers.tenant_id')
        .onRef('customer_credit_transactions.customer_id', '=', 'customers.id'),
    )
    .where('customer_credit_transactions.tenant_id', '=', trx.tenantId);

  if (query.accountId) {
    baseQuery = baseQuery.where('customer_credit_transactions.account_id', '=', query.accountId);
  }
  if (query.customerId) {
    baseQuery = baseQuery.where('customer_credit_transactions.customer_id', '=', query.customerId);
  }
  if (query.transactionType) {
    baseQuery = baseQuery.where('customer_credit_transactions.transaction_type', '=', query.transactionType);
  }
  if (query.startDate) {
    baseQuery = baseQuery.where('customer_credit_transactions.transaction_date', '>=', query.startDate);
  }
  if (query.endDate) {
    baseQuery = baseQuery.where('customer_credit_transactions.transaction_date', '<=', query.endDate);
  }

  const countRow = await baseQuery
    .select(sql<number>`count(*)::int`.as('total'))
    .executeTakeFirst();
  const total = countRow?.total ?? 0;

  const rows = await baseQuery
    .select([
      'customer_credit_transactions.id',
      'customer_credit_transactions.account_id',
      'customer_credit_transactions.customer_id',
      'customers.name as customer_name',
      'customer_credit_transactions.branch_id',
      'customer_credit_transactions.transaction_reference',
      'customer_credit_transactions.transaction_type',
      'customer_credit_transactions.entry_direction',
      'customer_credit_transactions.amount',
      'customer_credit_transactions.currency_code',
      'customer_credit_transactions.balance_after',
      'customer_credit_transactions.unpaid_amount',
      'customer_credit_transactions.transaction_date',
      'customer_credit_transactions.posting_date',
      'customer_credit_transactions.due_date',
      'customer_credit_transactions.source_reference_type',
      'customer_credit_transactions.source_reference_id',
      'customer_credit_transactions.source_reference_number',
      'customer_credit_transactions.description',
      'customer_credit_transactions.is_reversed',
      'customer_credit_transactions.reversed_at',
      'customer_credit_transactions.created_at',
    ])
    .orderBy('customer_credit_transactions.posting_date', 'desc')
    .limit(limit)
    .offset(offset)
    .execute();

  const items: CustomerCreditTransactionResponse[] = rows.map((r) => ({
    id: r.id,
    accountId: r.account_id,
    customerId: r.customer_id,
    customerName: r.customer_name,
    branchId: r.branch_id,
    transactionReference: r.transaction_reference,
    transactionType: r.transaction_type,
    entryDirection: r.entry_direction,
    amount: String(r.amount),
    currencyCode: r.currency_code,
    balanceAfter: String(r.balance_after),
    unpaidAmount: String(r.unpaid_amount),
    transactionDate: String(r.transaction_date).slice(0, 10),
    postingDate: r.posting_date.toISOString(),
    dueDate: r.due_date ? String(r.due_date).slice(0, 10) : null,
    sourceReferenceType: r.source_reference_type,
    sourceReferenceId: r.source_reference_id,
    sourceReferenceNumber: r.source_reference_number,
    description: r.description,
    isReversed: r.is_reversed,
    reversedAt: r.reversed_at ? (r.reversed_at as Date).toISOString() : null,
    createdAt: r.created_at.toISOString(),
  }));

  return { items, total };
}

import {
  type AgingBucket,
  type CreditAgingReportResponse,
  type CreditDashboardKpisResponse,
  type CustomerAgingReportItem,
  type CustomerCreditTransactionResponse,
  type CustomerStatementResponse,
} from '@nexstock/contracts';
import { sql } from 'kysely';
import { Money } from '@nexstock/domain-core';
import { assertAuthorized } from '../../iam/index.js';
import {
  AppError,
  type TenantTransactionContext,
} from '../../shared/index.js';

export async function getCreditDashboardKpis(
  trx: TenantTransactionContext,
): Promise<CreditDashboardKpisResponse> {
  await assertAuthorized(trx, { permission: 'crm:report:read' });

  // 1. Account balances aggregate
  const accAgg = await trx.db
    .selectFrom('customer_credit_accounts')
    .select([
      sql<string>`coalesce(sum(current_balance), 0)::text`.as('total_outstanding'),
      sql<string>`coalesce(sum(available_credit), 0)::text`.as('total_available_credit'),
      sql<string>`coalesce(sum(unallocated_payment_balance), 0)::text`.as('total_unallocated'),
      sql<number>`count(*) filter (where status = 'ACTIVE')::int`.as('active_count'),
      sql<number>`count(*) filter (where status = 'ON_HOLD')::int`.as('on_hold_count'),
    ])
    .where('tenant_id', '=', trx.tenantId)
    .executeTakeFirst();

  // 2. Pending approvals count
  const pendingApprovalsRow = await trx.db
    .selectFrom('customer_credit_approvals')
    .select(sql<number>`count(*)::int`.as('count'))
    .where('tenant_id', '=', trx.tenantId)
    .where('status', '=', 'PENDING')
    .executeTakeFirst();

  // 3. Today's collections
  const todayCollRow = await trx.db
    .selectFrom('customer_credit_payments')
    .select(sql<string>`coalesce(sum(amount), 0)::text`.as('total'))
    .where('tenant_id', '=', trx.tenantId)
    .where('status', '=', 'COMPLETED')
    .where('payment_date', '=', sql<string>`CURRENT_DATE`)
    .executeTakeFirst();

  // 4. Month's credit sales
  const monthSalesRow = await trx.db
    .selectFrom('customer_credit_transactions')
    .select(sql<string>`coalesce(sum(amount), 0)::text`.as('total'))
    .where('tenant_id', '=', trx.tenantId)
    .where('transaction_type', '=', 'CREDIT_SALE')
    .where('transaction_date', '>=', sql<string>`date_trunc('month', CURRENT_DATE)::date`)
    .executeTakeFirst();

  // 5. Total overdue amount
  const overdueRow = await trx.db
    .selectFrom('customer_credit_transactions')
    .select(sql<string>`coalesce(sum(unpaid_amount), 0)::text`.as('total'))
    .where('tenant_id', '=', trx.tenantId)
    .where('entry_direction', '=', 'DEBIT')
    .where(sql`unpaid_amount::numeric`, '>', 0)
    .where('due_date', '<', sql<string>`CURRENT_DATE`)
    .executeTakeFirst();

  return {
    totalOutstanding: Money.fromDecimalString(accAgg?.total_outstanding ?? '0', 'LKR').toDecimalString(),
    totalAvailableCredit: Money.fromDecimalString(accAgg?.total_available_credit ?? '0', 'LKR').toDecimalString(),
    totalOverdue: Money.fromDecimalString(overdueRow?.total ?? '0', 'LKR').toDecimalString(),
    activeCreditCustomers: accAgg?.active_count ?? 0,
    customersOnHold: accAgg?.on_hold_count ?? 0,
    pendingApprovals: pendingApprovalsRow?.count ?? 0,
    todayCollections: Money.fromDecimalString(todayCollRow?.total ?? '0', 'LKR').toDecimalString(),
    monthCreditSales: Money.fromDecimalString(monthSalesRow?.total ?? '0', 'LKR').toDecimalString(),
    totalUnallocatedPayments: Money.fromDecimalString(accAgg?.total_unallocated ?? '0', 'LKR').toDecimalString(),
  };
}

export async function getCreditAgingReport(
  trx: TenantTransactionContext,
  asOfDate?: string,
): Promise<CreditAgingReportResponse> {
  await assertAuthorized(trx, { permission: 'crm:report:read' });

  const asOf = asOfDate ? new Date(asOfDate) : new Date();
  const asOfStr = asOf.toISOString().slice(0, 10);

  const accounts = await trx.db
    .selectFrom('customer_credit_accounts')
    .innerJoin('customers', (j) =>
      j.onRef('customer_credit_accounts.tenant_id', '=', 'customers.tenant_id')
       .onRef('customer_credit_accounts.customer_id', '=', 'customers.id'),
    )
    .select([
      'customer_credit_accounts.id',
      'customer_credit_accounts.customer_id',
      'customers.customer_number',
      'customers.name as customer_name',
      'customer_credit_accounts.account_number',
      'customer_credit_accounts.credit_limit',
      'customer_credit_accounts.status',
      'customer_credit_accounts.risk_classification',
    ])
    .where('customer_credit_accounts.tenant_id', '=', trx.tenantId)
    .orderBy('customers.name', 'asc')
    .execute();

  let summaryCurrentMoney = Money.zero('LKR');
  let summaryDays1To30Money = Money.zero('LKR');
  let summaryDays31To60Money = Money.zero('LKR');
  let summaryDays61To90Money = Money.zero('LKR');
  let summaryDays90PlusMoney = Money.zero('LKR');

  const customerItems: CustomerAgingReportItem[] = [];

  for (const acc of accounts) {
    const txs = await trx.db
      .selectFrom('customer_credit_transactions')
      .select(['unpaid_amount', 'due_date', 'transaction_date'])
      .where('tenant_id', '=', trx.tenantId)
      .where('account_id', '=', acc.id)
      .where('entry_direction', '=', 'DEBIT')
      .where(sql`unpaid_amount::numeric`, '>', 0)
      .execute();

    let curMoney = Money.zero('LKR');
    let d1to30Money = Money.zero('LKR');
    let d31to60Money = Money.zero('LKR');
    let d61to90Money = Money.zero('LKR');
    let d90plusMoney = Money.zero('LKR');

    for (const tx of txs) {
      const unpaidMoney = Money.fromDecimalString(String(tx.unpaid_amount), 'LKR');
      const dueDate = tx.due_date ? new Date(tx.due_date) : new Date(tx.transaction_date);
      const diffTime = asOf.getTime() - dueDate.getTime();
      const overdueDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));

      if (overdueDays <= 0) {
        curMoney = curMoney.add(unpaidMoney);
      } else if (overdueDays <= 30) {
        d1to30Money = d1to30Money.add(unpaidMoney);
      } else if (overdueDays <= 60) {
        d31to60Money = d31to60Money.add(unpaidMoney);
      } else if (overdueDays <= 90) {
        d61to90Money = d61to90Money.add(unpaidMoney);
      } else {
        d90plusMoney = d90plusMoney.add(unpaidMoney);
      }
    }

    const totalOverdueMoney = d1to30Money
      .add(d31to60Money)
      .add(d61to90Money)
      .add(d90plusMoney);
    const totalOutstandingMoney = curMoney.add(totalOverdueMoney);

    summaryCurrentMoney = summaryCurrentMoney.add(curMoney);
    summaryDays1To30Money = summaryDays1To30Money.add(d1to30Money);
    summaryDays31To60Money = summaryDays31To60Money.add(d31to60Money);
    summaryDays61To90Money = summaryDays61To90Money.add(d61to90Money);
    summaryDays90PlusMoney = summaryDays90PlusMoney.add(d90plusMoney);

    customerItems.push({
      accountId: acc.id,
      customerId: acc.customer_id,
      customerName: acc.customer_name,
      customerNumber: acc.customer_number,
      accountNumber: acc.account_number,
      creditLimit: String(acc.credit_limit),
      status: acc.status,
      riskClassification: acc.risk_classification,
      current: curMoney.toDecimalString(),
      days1To30: d1to30Money.toDecimalString(),
      days31To60: d31to60Money.toDecimalString(),
      days61To90: d61to90Money.toDecimalString(),
      days90Plus: d90plusMoney.toDecimalString(),
      totalOverdue: totalOverdueMoney.toDecimalString(),
      totalOutstanding: totalOutstandingMoney.toDecimalString(),
    });
  }

  const summaryTotalOverdue = summaryDays1To30Money
    .add(summaryDays31To60Money)
    .add(summaryDays61To90Money)
    .add(summaryDays90PlusMoney);
  const summaryTotalOutstanding = summaryCurrentMoney.add(summaryTotalOverdue);

  const summary: AgingBucket = {
    current: summaryCurrentMoney.toDecimalString(),
    days1To30: summaryDays1To30Money.toDecimalString(),
    days31To60: summaryDays31To60Money.toDecimalString(),
    days61To90: summaryDays61To90Money.toDecimalString(),
    days90Plus: summaryDays90PlusMoney.toDecimalString(),
    totalOverdue: summaryTotalOverdue.toDecimalString(),
    totalOutstanding: summaryTotalOutstanding.toDecimalString(),
  };

  return {
    asOfDate: asOfStr,
    summary,
    customers: customerItems,
  };
}

export async function getCustomerCreditStatement(
  trx: TenantTransactionContext,
  customerId: string,
  startDate?: string,
  endDate?: string,
): Promise<CustomerStatementResponse> {
  await assertAuthorized(trx, { permission: 'crm:report:read' });

  const account = await trx.db
    .selectFrom('customer_credit_accounts')
    .innerJoin('customers', (j) =>
      j.onRef('customer_credit_accounts.tenant_id', '=', 'customers.tenant_id')
       .onRef('customer_credit_accounts.customer_id', '=', 'customers.id'),
    )
    .select([
      'customer_credit_accounts.id',
      'customer_credit_accounts.customer_id',
      'customers.customer_number',
      'customers.name as customer_name',
      'customer_credit_accounts.account_number',
      'customer_credit_accounts.credit_limit',
      'customer_credit_accounts.current_balance',
    ])
    .where('customer_credit_accounts.tenant_id', '=', trx.tenantId)
    .where('customer_credit_accounts.customer_id', '=', customerId)
    .executeTakeFirst();

  if (!account) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'CREDIT_ACCOUNT_NOT_FOUND',
      title: 'Credit Account Not Found',
      detail: `No credit account exists for customer "${customerId}".`,
    });
  }

  const sDate = startDate ?? new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);
  const eDate = endDate ?? new Date().toISOString().slice(0, 10);

  // 1. Calculate opening balance as of startDate
  const debitsBefore = await trx.db
    .selectFrom('customer_credit_transactions')
    .select(sql<string>`coalesce(sum(amount), 0)::text`.as('total'))
    .where('tenant_id', '=', trx.tenantId)
    .where('account_id', '=', account.id)
    .where('entry_direction', '=', 'DEBIT')
    .where('transaction_date', '<', sDate)
    .executeTakeFirst();

  const creditsBefore = await trx.db
    .selectFrom('customer_credit_transactions')
    .select(sql<string>`coalesce(sum(amount), 0)::text`.as('total'))
    .where('tenant_id', '=', trx.tenantId)
    .where('account_id', '=', account.id)
    .where('entry_direction', '=', 'CREDIT')
    .where('transaction_date', '<', sDate)
    .executeTakeFirst();

  const dBeforeMoney = Money.fromDecimalString(debitsBefore?.total ?? '0', 'LKR');
  const cBeforeMoney = Money.fromDecimalString(creditsBefore?.total ?? '0', 'LKR');
  const openingBalMoney = dBeforeMoney.compare(cBeforeMoney) > 0 ? dBeforeMoney.subtract(cBeforeMoney) : Money.zero('LKR');

  // 2. Fetch transactions in date range
  const txRows = await trx.db
    .selectFrom('customer_credit_transactions')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('account_id', '=', account.id)
    .where('transaction_date', '>=', sDate)
    .where('transaction_date', '<=', eDate)
    .orderBy('posting_date', 'asc')
    .execute();

  let totalDebitsMoney = Money.zero('LKR');
  let totalCreditsMoney = Money.zero('LKR');

  const transactions: CustomerCreditTransactionResponse[] = txRows.map((r) => {
    const amtMoney = Money.fromDecimalString(String(r.amount), 'LKR');
    if (r.entry_direction === 'DEBIT') {
      totalDebitsMoney = totalDebitsMoney.add(amtMoney);
    } else {
      totalCreditsMoney = totalCreditsMoney.add(amtMoney);
    }

    return {
      id: r.id,
      accountId: r.account_id,
      customerId: r.customer_id,
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
    };
  });

  const closingBalMoney = openingBalMoney.add(totalDebitsMoney).subtract(totalCreditsMoney);

  // 3. Outstanding unpaid invoices
  const unpaidRows = await trx.db
    .selectFrom('customer_credit_transactions')
    .select(['transaction_reference', 'transaction_date', 'due_date', 'description', 'amount', 'unpaid_amount'])
    .where('tenant_id', '=', trx.tenantId)
    .where('account_id', '=', account.id)
    .where('entry_direction', '=', 'DEBIT')
    .where(sql`unpaid_amount::numeric`, '>', 0)
    .orderBy('due_date', 'asc')
    .execute();

  const now = new Date();
  const unpaidInvoices = unpaidRows.map((u) => {
    const dDate = u.due_date ? new Date(u.due_date) : new Date(u.transaction_date);
    const diff = now.getTime() - dDate.getTime();
    const daysOverdue = Math.max(0, Math.floor(diff / (1000 * 60 * 60 * 24)));
    return {
      transactionReference: u.transaction_reference,
      transactionDate: String(u.transaction_date).slice(0, 10),
      dueDate: u.due_date ? String(u.due_date).slice(0, 10) : null,
      description: u.description,
      originalAmount: String(u.amount),
      unpaidAmount: String(u.unpaid_amount),
      daysOverdue,
    };
  });

  // 4. Aging
  let curM = Money.zero('LKR');
  let d1to30M = Money.zero('LKR');
  let d31to60M = Money.zero('LKR');
  let d61to90M = Money.zero('LKR');
  let d90plusM = Money.zero('LKR');

  for (const u of unpaidInvoices) {
    const amt = Money.fromDecimalString(u.unpaidAmount, 'LKR');
    if (u.daysOverdue === 0) curM = curM.add(amt);
    else if (u.daysOverdue <= 30) d1to30M = d1to30M.add(amt);
    else if (u.daysOverdue <= 60) d31to60M = d31to60M.add(amt);
    else if (u.daysOverdue <= 90) d61to90M = d61to90M.add(amt);
    else d90plusM = d90plusM.add(amt);
  }

  const totOverdue = d1to30M.add(d31to60M).add(d61to90M).add(d90plusM);
  const totOutstanding = curM.add(totOverdue);

  return {
    customerName: account.customer_name,
    customerNumber: account.customer_number,
    accountNumber: account.account_number,
    creditLimit: String(account.credit_limit),
    startDate: sDate,
    endDate: eDate,
    openingBalance: openingBalMoney.toDecimalString(),
    totalDebits: totalDebitsMoney.toDecimalString(),
    totalCredits: totalCreditsMoney.toDecimalString(),
    closingBalance: (closingBalMoney.isNegative() ? Money.zero('LKR') : closingBalMoney).toDecimalString(),
    transactions,
    unpaidInvoices,
    aging: {
      current: curM.toDecimalString(),
      days1To30: d1to30M.toDecimalString(),
      days31To60: d31to60M.toDecimalString(),
      days61To90: d61to90M.toDecimalString(),
      days90Plus: d90plusM.toDecimalString(),
      totalOverdue: totOverdue.toDecimalString(),
      totalOutstanding: totOutstanding.toDecimalString(),
    },
  };
}

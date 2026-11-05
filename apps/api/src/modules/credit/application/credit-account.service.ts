import {
  type CreateCustomerCreditAccountRequest,
  type CreditLimitHistoryResponse,
  type CustomerCreditAccountListResponse,
  type CustomerCreditAccountResponse,
  type ListCreditAccountsQuery,
  type ManageCreditLimitRequest,
  type UpdateCreditAccountStatusRequest,
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

export async function createCustomerCreditAccount(
  trx: TenantTransactionContext,
  input: CreateCustomerCreditAccountRequest,
): Promise<CustomerCreditAccountResponse> {
  await assertAuthorized(trx, { permission: 'crm:credit:create', branchId: input.branchId ?? undefined });

  // 1. Verify customer exists
  const customer = await trx.db
    .selectFrom('customers')
    .select(['id', 'customer_number', 'name', 'status'])
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', input.customerId)
    .executeTakeFirst();

  if (!customer) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'CUST_NOT_FOUND',
      title: 'Customer Not Found',
      detail: `Customer with ID "${input.customerId}" does not exist.`,
    });
  }

  // 2. Verify no existing credit account
  const existingAccount = await trx.db
    .selectFrom('customer_credit_accounts')
    .select(['id', 'account_number'])
    .where('tenant_id', '=', trx.tenantId)
    .where('customer_id', '=', input.customerId)
    .executeTakeFirst();

  if (existingAccount) {
    throw new AppError({
      statusCode: 409,
      errorCode: 'CREDIT_ACCOUNT_ALREADY_EXISTS',
      title: 'Credit Account Exists',
      detail: `Customer "${customer.name}" already has credit account "${existingAccount.account_number}".`,
    });
  }

  // 3. Load tenant credit settings for defaults if needed
  const settings = await trx.db
    .selectFrom('customer_credit_settings')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .executeTakeFirst();

  const creditLimitStr = input.creditLimit ?? (settings ? String(settings.default_credit_limit) : '50000.0000');
  const creditTerms = input.creditTerms ?? (settings ? settings.default_credit_terms : 'NET_30');
  const customTermDays = input.customTermDays ?? (settings ? settings.default_custom_days : 30);

  const limitMoney = Money.fromDecimalString(creditLimitStr, 'LKR');
  if (limitMoney.isNegative()) {
    throw new AppError({
      statusCode: 400,
      errorCode: 'ERR_VALIDATION_FAILED',
      title: 'Invalid Credit Limit',
      detail: 'Credit limit cannot be negative.',
    });
  }

  // 4. Generate account number: CCA-YYYYMM-XXXXX
  const now = new Date();
  const yearMonth = now.toISOString().slice(0, 7).replace('-', '');
  const countRow = await trx.db
    .selectFrom('customer_credit_accounts')
    .select(sql<number>`count(*)::int`.as('count'))
    .where('tenant_id', '=', trx.tenantId)
    .executeTakeFirst();
  const nextSeq = (countRow?.count ?? 0) + 1;
  const accountNumber = `CCA-${yearMonth}-${String(nextSeq).padStart(5, '0')}`;

  const accountId = generateUuidV7();

  let initialBalanceMoney = Money.zero('LKR');
  if (input.openingBalance) {
    const obMoney = Money.fromDecimalString(input.openingBalance, 'LKR');
    if (obMoney.isNegative()) {
      throw new AppError({
        statusCode: 400,
        errorCode: 'ERR_VALIDATION_FAILED',
        title: 'Invalid Opening Balance',
        detail: 'Opening balance cannot be negative.',
      });
    }
    initialBalanceMoney = obMoney;
  }

  const availableMoney = limitMoney.compare(initialBalanceMoney) > 0
    ? limitMoney.subtract(initialBalanceMoney)
    : Money.zero('LKR');

  const row = await trx.db
    .insertInto('customer_credit_accounts')
    .values({
      id: accountId,
      tenant_id: trx.tenantId,
      customer_id: input.customerId,
      account_number: accountNumber,
      credit_limit: limitMoney.toDecimalString(),
      current_balance: initialBalanceMoney.toDecimalString(),
      available_credit: availableMoney.toDecimalString(),
      total_credit_sales: initialBalanceMoney.toDecimalString(),
      total_payments: '0.0000',
      total_interest_charged: '0.0000',
      total_late_fees: '0.0000',
      total_written_off: '0.0000',
      unallocated_payment_balance: '0.0000',
      credit_terms: creditTerms,
      custom_term_days: creditTerms === 'CUSTOM' ? customTermDays : null,
      status: 'ACTIVE',
      risk_classification: 'LOW_RISK',
      branch_id: input.branchId ?? null,
      currency_code: 'LKR',
      created_by_user_id: trx.userId,
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  // Record initial limit in history
  await trx.db.insertInto('customer_credit_limit_history').values({
    id: generateUuidV7(),
    tenant_id: trx.tenantId,
    account_id: accountId,
    previous_limit: '0.0000',
    new_limit: limitMoney.toDecimalString(),
    change_type: 'INITIAL',
    reason: 'Initial credit account creation limit',
    requested_by_user_id: trx.userId,
    approved_by_user_id: trx.userId,
    approval_status: 'APPROVED',
  }).execute();

  // If opening balance > 0, post opening balance ledger entry
  if (initialBalanceMoney.isPositive()) {
    const txRef = `CTX-${yearMonth}-${generateUuidV7().slice(-5).toUpperCase()}`;
    await trx.db.insertInto('customer_credit_transactions').values({
      id: generateUuidV7(),
      tenant_id: trx.tenantId,
      account_id: accountId,
      customer_id: input.customerId,
      branch_id: input.branchId ?? null,
      transaction_reference: txRef,
      transaction_type: 'OPENING_BALANCE',
      entry_direction: 'DEBIT',
      amount: initialBalanceMoney.toDecimalString(),
      currency_code: 'LKR',
      balance_after: initialBalanceMoney.toDecimalString(),
      unpaid_amount: initialBalanceMoney.toDecimalString(),
      transaction_date: sql<string>`CURRENT_DATE`,
      due_date: sql<string>`CURRENT_DATE`,
      source_reference_type: 'MANUAL',
      source_reference_number: 'OPENING_BALANCE',
      description: 'Account Opening Balance',
      created_by_user_id: trx.userId,
    }).execute();
  }

  await appendAuditLog(trx, {
    action: 'crm:credit:create',
    resourceType: 'customer_credit_accounts',
    resourceId: row.id,
    metadata: {
      accountNumber: row.account_number,
      customerNumber: customer.customer_number,
      creditLimit: limitMoney.toDecimalString(),
      initialBalance: initialBalanceMoney.toDecimalString(),
    },
  });

  return getCreditAccountById(trx, row.id);
}

export async function getCreditAccountById(
  trx: TenantTransactionContext,
  id: string,
): Promise<CustomerCreditAccountResponse> {
  await assertAuthorized(trx, { permission: 'crm:credit:read' });

  const row = await trx.db
    .selectFrom('customer_credit_accounts')
    .innerJoin('customers', (join) =>
      join
        .onRef('customer_credit_accounts.tenant_id', '=', 'customers.tenant_id')
        .onRef('customer_credit_accounts.customer_id', '=', 'customers.id'),
    )
    .leftJoin('branches', (join) =>
      join
        .onRef('customer_credit_accounts.tenant_id', '=', 'branches.tenant_id')
        .onRef('customer_credit_accounts.branch_id', '=', 'branches.id'),
    )
    .select([
      'customer_credit_accounts.id',
      'customer_credit_accounts.customer_id',
      'customers.customer_number',
      'customers.name as customer_name',
      'customer_credit_accounts.account_number',
      'customer_credit_accounts.credit_limit',
      'customer_credit_accounts.current_balance',
      'customer_credit_accounts.available_credit',
      'customer_credit_accounts.total_credit_sales',
      'customer_credit_accounts.total_payments',
      'customer_credit_accounts.total_interest_charged',
      'customer_credit_accounts.total_late_fees',
      'customer_credit_accounts.total_written_off',
      'customer_credit_accounts.unallocated_payment_balance',
      'customer_credit_accounts.credit_terms',
      'customer_credit_accounts.custom_term_days',
      'customer_credit_accounts.status',
      'customer_credit_accounts.hold_reason',
      'customer_credit_accounts.held_at',
      'customer_credit_accounts.risk_classification',
      'customer_credit_accounts.branch_id',
      'branches.name as branch_name',
      'customer_credit_accounts.currency_code',
      'customer_credit_accounts.opened_at',
      'customer_credit_accounts.closed_at',
      'customer_credit_accounts.created_at',
      'customer_credit_accounts.updated_at',
    ])
    .where('customer_credit_accounts.tenant_id', '=', trx.tenantId)
    .where('customer_credit_accounts.id', '=', id)
    .executeTakeFirst();

  if (!row) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'CREDIT_ACCOUNT_NOT_FOUND',
      title: 'Credit Account Not Found',
      detail: `Credit account with ID "${id}" was not found.`,
    });
  }

  return {
    id: row.id,
    customerId: row.customer_id,
    customerNumber: row.customer_number,
    customerName: row.customer_name,
    accountNumber: row.account_number,
    creditLimit: String(row.credit_limit),
    currentBalance: String(row.current_balance),
    availableCredit: String(row.available_credit),
    totalCreditSales: String(row.total_credit_sales),
    totalPayments: String(row.total_payments),
    totalInterestCharged: String(row.total_interest_charged),
    totalLateFees: String(row.total_late_fees),
    totalWrittenOff: String(row.total_written_off),
    unallocatedPaymentBalance: String(row.unallocated_payment_balance),
    creditTerms: row.credit_terms,
    customTermDays: row.custom_term_days,
    status: row.status,
    holdReason: row.hold_reason,
    heldAt: row.held_at ? (row.held_at as Date).toISOString() : null,
    riskClassification: row.risk_classification,
    branchId: row.branch_id,
    ...(row.branch_name ? { branchName: row.branch_name } : {}),
    currencyCode: row.currency_code,
    openedAt: row.opened_at.toISOString(),
    closedAt: row.closed_at ? (row.closed_at as Date).toISOString() : null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function getCreditAccountByCustomerId(
  trx: TenantTransactionContext,
  customerId: string,
): Promise<CustomerCreditAccountResponse> {
  const row = await trx.db
    .selectFrom('customer_credit_accounts')
    .select(['id'])
    .where('tenant_id', '=', trx.tenantId)
    .where('customer_id', '=', customerId)
    .executeTakeFirst();

  if (!row) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'CREDIT_ACCOUNT_NOT_FOUND',
      title: 'Credit Account Not Found',
      detail: `No credit account exists for customer "${customerId}".`,
    });
  }

  return getCreditAccountById(trx, row.id);
}

export async function listCreditAccounts(
  trx: TenantTransactionContext,
  query: ListCreditAccountsQuery,
): Promise<CustomerCreditAccountListResponse> {
  await assertAuthorized(trx, { permission: 'crm:credit:read', branchId: query.branchId });

  const limit = query.limit ?? 50;
  const offset = query.offset ?? 0;

  let baseQuery = trx.db
    .selectFrom('customer_credit_accounts')
    .innerJoin('customers', (join) =>
      join
        .onRef('customer_credit_accounts.tenant_id', '=', 'customers.tenant_id')
        .onRef('customer_credit_accounts.customer_id', '=', 'customers.id'),
    )
    .leftJoin('branches', (join) =>
      join
        .onRef('customer_credit_accounts.tenant_id', '=', 'branches.tenant_id')
        .onRef('customer_credit_accounts.branch_id', '=', 'branches.id'),
    )
    .where('customer_credit_accounts.tenant_id', '=', trx.tenantId);

  if (query.status) {
    baseQuery = baseQuery.where('customer_credit_accounts.status', '=', query.status);
  }
  if (query.risk) {
    baseQuery = baseQuery.where('customer_credit_accounts.risk_classification', '=', query.risk);
  }
  if (query.branchId) {
    baseQuery = baseQuery.where('customer_credit_accounts.branch_id', '=', query.branchId);
  }
  if (query.search?.trim()) {
    const term = `%${query.search.trim().toLowerCase()}%`;
    baseQuery = baseQuery.where((eb) =>
      eb.or([
        eb(sql`lower(customers.name)`, 'like', term),
        eb(sql`lower(customers.customer_number)`, 'like', term),
        eb(sql`lower(customer_credit_accounts.account_number)`, 'like', term),
        eb(sql`lower(coalesce(customers.phone, ''))`, 'like', term),
      ]),
    );
  }

  const countRow = await baseQuery
    .select(sql<number>`count(*)::int`.as('total'))
    .executeTakeFirst();
  const total = countRow?.total ?? 0;

  const rows = await baseQuery
    .select([
      'customer_credit_accounts.id',
      'customer_credit_accounts.customer_id',
      'customers.customer_number',
      'customers.name as customer_name',
      'customer_credit_accounts.account_number',
      'customer_credit_accounts.credit_limit',
      'customer_credit_accounts.current_balance',
      'customer_credit_accounts.available_credit',
      'customer_credit_accounts.total_credit_sales',
      'customer_credit_accounts.total_payments',
      'customer_credit_accounts.total_interest_charged',
      'customer_credit_accounts.total_late_fees',
      'customer_credit_accounts.total_written_off',
      'customer_credit_accounts.unallocated_payment_balance',
      'customer_credit_accounts.credit_terms',
      'customer_credit_accounts.custom_term_days',
      'customer_credit_accounts.status',
      'customer_credit_accounts.hold_reason',
      'customer_credit_accounts.held_at',
      'customer_credit_accounts.risk_classification',
      'customer_credit_accounts.branch_id',
      'branches.name as branch_name',
      'customer_credit_accounts.currency_code',
      'customer_credit_accounts.opened_at',
      'customer_credit_accounts.closed_at',
      'customer_credit_accounts.created_at',
      'customer_credit_accounts.updated_at',
    ])
    .orderBy('customer_credit_accounts.created_at', 'desc')
    .limit(limit)
    .offset(offset)
    .execute();

  const items: CustomerCreditAccountResponse[] = rows.map((r) => ({
    id: r.id,
    customerId: r.customer_id,
    customerNumber: r.customer_number,
    customerName: r.customer_name,
    accountNumber: r.account_number,
    creditLimit: String(r.credit_limit),
    currentBalance: String(r.current_balance),
    availableCredit: String(r.available_credit),
    totalCreditSales: String(r.total_credit_sales),
    totalPayments: String(r.total_payments),
    totalInterestCharged: String(r.total_interest_charged),
    totalLateFees: String(r.total_late_fees),
    totalWrittenOff: String(r.total_written_off),
    unallocatedPaymentBalance: String(r.unallocated_payment_balance),
    creditTerms: r.credit_terms,
    customTermDays: r.custom_term_days,
    status: r.status,
    holdReason: r.hold_reason,
    heldAt: r.held_at ? (r.held_at as Date).toISOString() : null,
    riskClassification: r.risk_classification,
    branchId: r.branch_id,
    ...(r.branch_name ? { branchName: r.branch_name } : {}),
    currencyCode: r.currency_code,
    openedAt: r.opened_at.toISOString(),
    closedAt: r.closed_at ? (r.closed_at as Date).toISOString() : null,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  }));

  return { items, total };
}

export async function updateCreditAccountStatus(
  trx: TenantTransactionContext,
  id: string,
  input: UpdateCreditAccountStatusRequest,
): Promise<CustomerCreditAccountResponse> {
  await assertAuthorized(trx, { permission: 'crm:credit:hold' });

  const account = await trx.db
    .selectFrom('customer_credit_accounts')
    .select(['id', 'status', 'current_balance', 'account_number'])
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', id)
    .forUpdate()
    .executeTakeFirst();

  if (!account) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'CREDIT_ACCOUNT_NOT_FOUND',
      title: 'Credit Account Not Found',
      detail: `Credit account "${id}" was not found.`,
    });
  }

  // Prevent closing account if outstanding balance exists
  if (input.status === 'CLOSED') {
    const balMoney = Money.fromDecimalString(String(account.current_balance), 'LKR');
    if (balMoney.isPositive()) {
      throw new AppError({
        statusCode: 409,
        errorCode: 'CREDIT_CANNOT_CLOSE_WITH_BALANCE',
        title: 'Outstanding Balance Remains',
        detail: `Cannot close credit account "${account.account_number}" with outstanding balance LKR ${balMoney.toDecimalString()}. Must be fully settled or written off.`,
      });
    }
  }

  const isHold = input.status === 'ON_HOLD' || input.status === 'SUSPENDED' || input.status === 'BLOCKED';
  const isClosed = input.status === 'CLOSED';

  await trx.db
    .updateTable('customer_credit_accounts')
    .set({
      status: input.status,
      hold_reason: isHold ? (input.reason ?? 'Placed on hold by administrator') : null,
      held_at: isHold ? sql<Date>`clock_timestamp()` : null,
      held_by_user_id: isHold ? trx.userId : null,
      closed_at: isClosed ? sql<Date>`clock_timestamp()` : null,
      closed_by_user_id: isClosed ? trx.userId : null,
      updated_at: sql<Date>`clock_timestamp()`,
    })
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', id)
    .execute();

  await appendAuditLog(trx, {
    action: 'crm:credit:status_update',
    resourceType: 'customer_credit_accounts',
    resourceId: id,
    metadata: {
      previousStatus: account.status,
      newStatus: input.status,
      reason: input.reason,
    },
  });

  return getCreditAccountById(trx, id);
}

export async function manageCreditLimit(
  trx: TenantTransactionContext,
  id: string,
  input: ManageCreditLimitRequest,
): Promise<CustomerCreditAccountResponse> {
  await assertAuthorized(trx, { permission: 'crm:limit:manage' });

  const account = await trx.db
    .selectFrom('customer_credit_accounts')
    .select(['id', 'credit_limit', 'current_balance', 'status'])
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', id)
    .forUpdate()
    .executeTakeFirst();

  if (!account) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'CREDIT_ACCOUNT_NOT_FOUND',
      title: 'Credit Account Not Found',
      detail: `Credit account "${id}" was not found.`,
    });
  }

  const newLimitMoney = Money.fromDecimalString(input.newLimit, 'LKR');
  if (newLimitMoney.isNegative()) {
    throw new AppError({
      statusCode: 400,
      errorCode: 'ERR_VALIDATION_FAILED',
      title: 'Invalid Credit Limit',
      detail: 'Credit limit cannot be negative.',
    });
  }

  const curBalMoney = Money.fromDecimalString(String(account.current_balance), 'LKR');
  const newAvailableMoney = newLimitMoney.compare(curBalMoney) > 0
    ? newLimitMoney.subtract(curBalMoney)
    : Money.zero('LKR');

  // Insert limit history
  await trx.db.insertInto('customer_credit_limit_history').values({
    id: generateUuidV7(),
    tenant_id: trx.tenantId,
    account_id: id,
    previous_limit: String(account.credit_limit),
    new_limit: newLimitMoney.toDecimalString(),
    change_type: input.changeType,
    reason: input.reason.trim(),
    expiry_date: input.expiryDate ?? null,
    requested_by_user_id: trx.userId,
    approved_by_user_id: trx.userId,
    approval_status: 'APPROVED',
  }).execute();

  await trx.db
    .updateTable('customer_credit_accounts')
    .set({
      credit_limit: newLimitMoney.toDecimalString(),
      available_credit: newAvailableMoney.toDecimalString(),
      updated_at: sql<Date>`clock_timestamp()`,
    })
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', id)
    .execute();

  await appendAuditLog(trx, {
    action: 'crm:limit:manage',
    resourceType: 'customer_credit_accounts',
    resourceId: id,
    metadata: {
      previousLimit: String(account.credit_limit),
      newLimit: newLimitMoney.toDecimalString(),
      changeType: input.changeType,
      reason: input.reason,
    },
  });

  return getCreditAccountById(trx, id);
}

export async function listCreditLimitHistory(
  trx: TenantTransactionContext,
  accountId: string,
): Promise<CreditLimitHistoryResponse[]> {
  await assertAuthorized(trx, { permission: 'crm:credit:read' });

  const rows = await trx.db
    .selectFrom('customer_credit_limit_history')
    .innerJoin('users as req', 'customer_credit_limit_history.requested_by_user_id', 'req.id')
    .leftJoin('users as app', 'customer_credit_limit_history.approved_by_user_id', 'app.id')
    .select([
      'customer_credit_limit_history.id',
      'customer_credit_limit_history.account_id',
      'customer_credit_limit_history.previous_limit',
      'customer_credit_limit_history.new_limit',
      'customer_credit_limit_history.change_type',
      'customer_credit_limit_history.reason',
      'customer_credit_limit_history.effective_date',
      'customer_credit_limit_history.expiry_date',
      'customer_credit_limit_history.requested_by_user_id',
      'req.full_name as requested_by_name',
      'customer_credit_limit_history.approved_by_user_id',
      'app.full_name as approved_by_name',
      'customer_credit_limit_history.approval_status',
      'customer_credit_limit_history.created_at',
    ])
    .where('customer_credit_limit_history.tenant_id', '=', trx.tenantId)
    .where('customer_credit_limit_history.account_id', '=', accountId)
    .orderBy('customer_credit_limit_history.created_at', 'desc')
    .execute();

  return rows.map((r) => ({
    id: r.id,
    accountId: r.account_id,
    previousLimit: String(r.previous_limit),
    newLimit: String(r.new_limit),
    changeType: r.change_type,
    reason: r.reason,
    effectiveDate: String(r.effective_date).slice(0, 10),
    expiryDate: r.expiry_date ? String(r.expiry_date).slice(0, 10) : null,
    requestedByUserId: r.requested_by_user_id,
    ...(r.requested_by_name ? { requestedByName: r.requested_by_name } : {}),
    approvedByUserId: r.approved_by_user_id,
    ...(r.approved_by_name ? { approvedByName: r.approved_by_name } : {}),
    approvalStatus: r.approval_status,
    createdAt: r.created_at.toISOString(),
  }));
}

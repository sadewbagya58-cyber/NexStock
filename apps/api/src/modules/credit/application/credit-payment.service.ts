import {
  type AllocateUnappliedPaymentRequest,
  type CustomerCreditPaymentListResponse,
  type CustomerCreditPaymentResponse,
  type ListCreditPaymentsQuery,
  type PaymentReceiptResponse,
  type RecordCustomerCreditPaymentRequest,
  type ReverseCustomerCreditPaymentRequest,
} from '@nexstock/contracts';
import { sql } from 'kysely';
import { Money } from '@nexstock/domain-core';
import { assertAuthorized } from '../../iam/index.js';
import {
  AppError,
  type TenantTransactionContext,
  appendAuditLog,
  generateUuidV7,
  realtimeEventHub,
} from '../../shared/index.js';

export async function recordCustomerCreditPayment(
  trx: TenantTransactionContext,
  input: RecordCustomerCreditPaymentRequest,
): Promise<CustomerCreditPaymentResponse> {
  await assertAuthorized(trx, { permission: 'crm:payment:create', branchId: input.branchId ?? undefined });

  // 1. Fetch account with row lock
  const account = await trx.db
    .selectFrom('customer_credit_accounts')
    .innerJoin('customers', (join) =>
      join
        .onRef('customer_credit_accounts.tenant_id', '=', 'customers.tenant_id')
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
      'customer_credit_accounts.available_credit',
      'customer_credit_accounts.unallocated_payment_balance',
      'customer_credit_accounts.status',
      'customer_credit_accounts.branch_id',
    ])
    .where('customer_credit_accounts.tenant_id', '=', trx.tenantId)
    .where('customer_credit_accounts.id', '=', input.accountId)
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
      detail: 'Cannot accept payments for a closed customer credit account.',
    });
  }

  const paymentAmountMoney = Money.fromDecimalString(input.amount, 'LKR');
  if (!paymentAmountMoney.isPositive()) {
    throw new AppError({
      statusCode: 400,
      errorCode: 'ERR_VALIDATION_FAILED',
      title: 'Invalid Payment Amount',
      detail: 'Payment amount must be strictly positive.',
    });
  }

  // 2. Process Allocations
  let allocatedTotalMoney = Money.zero('LKR');
  const validAllocations: Array<{
    transactionId: string;
    transactionReference: string;
    transactionDate: string;
    amountMoney: Money;
    invoiceId: string | null;
  }> = [];

  if (input.allocations && input.allocations.length > 0) {
    for (const alloc of input.allocations) {
      const allocMoney = Money.fromDecimalString(alloc.amount, 'LKR');
      if (!allocMoney.isPositive()) {
        throw new AppError({
          statusCode: 400,
          errorCode: 'ERR_VALIDATION_FAILED',
          title: 'Invalid Allocation Amount',
          detail: 'Allocation amount must be strictly positive.',
        });
      }

      // Check transaction exists and has unpaid amount
      const tx = await trx.db
        .selectFrom('customer_credit_transactions')
        .select(['id', 'transaction_reference', 'transaction_date', 'unpaid_amount', 'source_reference_id', 'entry_direction'])
        .where('tenant_id', '=', trx.tenantId)
        .where('account_id', '=', account.id)
        .where('id', '=', alloc.transactionId)
        .forUpdate()
        .executeTakeFirst();

      if (!tx || tx.entry_direction !== 'DEBIT') {
        throw new AppError({
          statusCode: 404,
          errorCode: 'CREDIT_TRANSACTION_NOT_FOUND',
          title: 'Transaction Not Found',
          detail: `Transaction "${alloc.transactionId}" not found or not eligible for payment allocation.`,
        });
      }

      const unpaidMoney = Money.fromDecimalString(String(tx.unpaid_amount), 'LKR');
      if (allocMoney.compare(unpaidMoney) > 0) {
        throw new AppError({
          statusCode: 400,
          errorCode: 'CREDIT_ALLOCATION_EXCEEDS_DUE',
          title: 'Allocation Exceeds Amount Due',
          detail: `Allocation of LKR ${allocMoney.toDecimalString()} exceeds unpaid amount LKR ${unpaidMoney.toDecimalString()} for transaction "${alloc.transactionId}".`,
        });
      }

      allocatedTotalMoney = allocatedTotalMoney.add(allocMoney);
      validAllocations.push({
        transactionId: alloc.transactionId,
        transactionReference: tx.transaction_reference,
        transactionDate: String(tx.transaction_date).slice(0, 10),
        amountMoney: allocMoney,
        invoiceId: tx.source_reference_id,
      });
    }

    if (allocatedTotalMoney.compare(paymentAmountMoney) > 0) {
      throw new AppError({
        statusCode: 400,
        errorCode: 'CREDIT_ALLOCATION_EXCEEDS_PAYMENT',
        title: 'Allocations Exceed Payment',
        detail: `Total allocations LKR ${allocatedTotalMoney.toDecimalString()} exceed payment amount LKR ${paymentAmountMoney.toDecimalString()}.`,
      });
    }
  } else {
    // FIFO automatic allocation across oldest unpaid debit transactions
    const unpaidTxs = await trx.db
      .selectFrom('customer_credit_transactions')
      .select(['id', 'transaction_reference', 'transaction_date', 'unpaid_amount', 'source_reference_id'])
      .where('tenant_id', '=', trx.tenantId)
      .where('account_id', '=', account.id)
      .where('entry_direction', '=', 'DEBIT')
      .where(sql`unpaid_amount::numeric`, '>', 0)
      .orderBy('transaction_date', 'asc')
      .orderBy('created_at', 'asc')
      .forUpdate()
      .execute();

    let remainingToAllocate = paymentAmountMoney;
    for (const tx of unpaidTxs) {
      if (remainingToAllocate.isZero()) break;
      const unpaidMoney = Money.fromDecimalString(String(tx.unpaid_amount), 'LKR');
      const allocMoney = remainingToAllocate.compare(unpaidMoney) >= 0 ? unpaidMoney : remainingToAllocate;
      allocatedTotalMoney = allocatedTotalMoney.add(allocMoney);
      remainingToAllocate = remainingToAllocate.subtract(allocMoney);
      validAllocations.push({
        transactionId: tx.id,
        transactionReference: tx.transaction_reference,
        transactionDate: String(tx.transaction_date).slice(0, 10),
        amountMoney: allocMoney,
        invoiceId: tx.source_reference_id,
      });
    }
  }

  const unallocatedMoney = paymentAmountMoney.subtract(allocatedTotalMoney);

  // 3. Generate references: CPAY-YYYYMM-XXXXX, RCP-YYYYMM-XXXXX
  const yearMonth = new Date().toISOString().slice(0, 7).replace('-', '');
  const countRow = await trx.db
    .selectFrom('customer_credit_payments')
    .select(sql<number>`count(*)::int`.as('count'))
    .where('tenant_id', '=', trx.tenantId)
    .executeTakeFirst();
  const nextSeq = (countRow?.count ?? 0) + 1;
  const payRef = `CPAY-${yearMonth}-${String(nextSeq).padStart(5, '0')}`;
  const rcpNumber = `RCP-${yearMonth}-${String(nextSeq).padStart(5, '0')}`;
  const resolvedExternalRef = input.paymentReference?.trim() || input.externalReference?.trim() || null;

  const paymentId = generateUuidV7();

  // 4. Insert Payment record
  const payRow = await trx.db
    .insertInto('customer_credit_payments')
    .values({
      id: paymentId,
      tenant_id: trx.tenantId,
      account_id: account.id,
      customer_id: account.customer_id,
      payment_reference: payRef,
      receipt_number: rcpNumber,
      amount: paymentAmountMoney.toDecimalString(),
      allocated_amount: allocatedTotalMoney.toDecimalString(),
      unallocated_amount: unallocatedMoney.toDecimalString(),
      currency_code: 'LKR',
      payment_date: input.paymentDate ?? sql<string>`CURRENT_DATE`,
      payment_method: input.paymentMethod,
      external_reference: resolvedExternalRef,
      branch_id: input.branchId ?? account.branch_id,
      received_by_user_id: trx.userId,
      status: 'COMPLETED',
      notes: input.notes?.trim() || null,
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  // 5. Insert allocations and deduct unpaid amounts
  for (const alloc of validAllocations) {
    await trx.db.insertInto('customer_credit_allocations').values({
      id: generateUuidV7(),
      tenant_id: trx.tenantId,
      payment_id: paymentId,
      invoice_id: alloc.invoiceId,
      transaction_id: alloc.transactionId,
      amount: alloc.amountMoney.toDecimalString(),
      allocated_by_user_id: trx.userId,
      status: 'ACTIVE',
    }).execute();

    await trx.db
      .updateTable('customer_credit_transactions')
      .set({
        unpaid_amount: sql`GREATEST(0, unpaid_amount - ${alloc.amountMoney.toDecimalString()}::numeric)`,
        updated_at: sql<Date>`clock_timestamp()`,
      })
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', alloc.transactionId)
      .execute();
  }

  // 6. Post PAYMENT credit ledger entry
  const curBalMoney = Money.fromDecimalString(String(account.current_balance), 'LKR');
  const newBalMoney = curBalMoney.compare(paymentAmountMoney) > 0
    ? curBalMoney.subtract(paymentAmountMoney)
    : Money.zero('LKR');
  const creditLimitMoney = Money.fromDecimalString(String(account.credit_limit), 'LKR');
  const newAvailMoney = creditLimitMoney.compare(newBalMoney) > 0
    ? creditLimitMoney.subtract(newBalMoney)
    : Money.zero('LKR');

  const txRef = `CTX-${yearMonth}-${generateUuidV7().slice(-5).toUpperCase()}`;
  await trx.db.insertInto('customer_credit_transactions').values({
    id: generateUuidV7(),
    tenant_id: trx.tenantId,
    account_id: account.id,
    customer_id: account.customer_id,
    branch_id: input.branchId ?? account.branch_id,
    transaction_reference: txRef,
    transaction_type: 'PAYMENT',
    entry_direction: 'CREDIT',
    amount: paymentAmountMoney.toDecimalString(),
    currency_code: 'LKR',
    balance_after: newBalMoney.toDecimalString(),
    unpaid_amount: '0.0000',
    transaction_date: input.paymentDate ?? sql<string>`CURRENT_DATE`,
    source_reference_type: 'PAYMENT',
    source_reference_id: paymentId,
    source_reference_number: payRef,
    description: `Customer Credit Payment - Ref #${payRef}`,
    created_by_user_id: trx.userId,
  }).execute();

  // 7. Update account balances
  await trx.db
    .updateTable('customer_credit_accounts')
    .set({
      current_balance: newBalMoney.toDecimalString(),
      available_credit: newAvailMoney.toDecimalString(),
      total_payments: sql`total_payments + ${paymentAmountMoney.toDecimalString()}::numeric`,
      unallocated_payment_balance: sql`unallocated_payment_balance + ${unallocatedMoney.toDecimalString()}::numeric`,
      updated_at: sql<Date>`clock_timestamp()`,
    })
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', account.id)
    .execute();

  await appendAuditLog(trx, {
    action: 'crm:payment:create',
    resourceType: 'customer_credit_payments',
    resourceId: paymentId,
    metadata: {
      paymentReference: payRef,
      externalReference: resolvedExternalRef,
      receiptNumber: rcpNumber,
      amount: paymentAmountMoney.toDecimalString(),
      allocatedAmount: allocatedTotalMoney.toDecimalString(),
      unallocatedAmount: unallocatedMoney.toDecimalString(),
    },
  });

  realtimeEventHub.publish({
    tenantId: trx.tenantId,
    branchId: input.branchId ?? account.branch_id,
    eventType: 'CREDIT_ACCOUNT_CHANGED',
    data: {
      accountId: account.id,
      customerId: account.customer_id,
      amount: paymentAmountMoney.toDecimalString(),
    },
  });

  return {
    id: payRow.id,
    accountId: payRow.account_id,
    customerId: payRow.customer_id,
    customerName: account.customer_name,
    paymentReference: payRow.payment_reference,
    receiptNumber: payRow.receipt_number,
    amount: String(payRow.amount),
    allocatedAmount: String(payRow.allocated_amount),
    unallocatedAmount: String(payRow.unallocated_amount),
    currencyCode: payRow.currency_code,
    paymentDate: String(payRow.payment_date).slice(0, 10),
    paymentMethod: payRow.payment_method,
    externalReference: payRow.external_reference,
    branchId: payRow.branch_id,
    status: payRow.status,
    reversalReason: payRow.reversal_reason,
    reversedAt: payRow.reversed_at ? (payRow.reversed_at as Date).toISOString() : null,
    notes: payRow.notes,
    allocations: validAllocations.map((a) => ({
      transactionId: a.transactionId,
      transactionReference: a.transactionReference,
      transactionDate: a.transactionDate,
      allocatedAmount: a.amountMoney.toDecimalString(),
    })),
    createdAt: payRow.created_at.toISOString(),
  };
}

export async function reverseCustomerCreditPayment(
  trx: TenantTransactionContext,
  id: string,
  input: ReverseCustomerCreditPaymentRequest,
): Promise<CustomerCreditPaymentResponse> {
  await assertAuthorized(trx, { permission: 'crm:payment:reverse' });

  const payment = await trx.db
    .selectFrom('customer_credit_payments')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', id)
    .forUpdate()
    .executeTakeFirst();

  if (!payment) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'CREDIT_PAYMENT_NOT_FOUND',
      title: 'Payment Not Found',
      detail: `Credit payment with ID "${id}" does not exist.`,
    });
  }

  if (payment.status === 'REVERSED') {
    throw new AppError({
      statusCode: 409,
      errorCode: 'CREDIT_PAYMENT_ALREADY_REVERSED',
      title: 'Payment Already Reversed',
      detail: `Payment "${payment.payment_reference}" has already been reversed.`,
    });
  }

  // 1. Fetch active allocations and restore unpaid amounts on transactions
  const allocations = await trx.db
    .selectFrom('customer_credit_allocations')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('payment_id', '=', id)
    .where('status', '=', 'ACTIVE')
    .execute();

  for (const alloc of allocations) {
    await trx.db
      .updateTable('customer_credit_transactions')
      .set({
        unpaid_amount: sql`unpaid_amount + ${String(alloc.amount)}::numeric`,
        updated_at: sql<Date>`clock_timestamp()`,
      })
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', alloc.transaction_id)
      .execute();
  }

  // 2. Mark allocations reversed
  await trx.db
    .updateTable('customer_credit_allocations')
    .set({
      status: 'REVERSED',
      reversal_reason: input.reason.trim(),
      reversed_at: sql<Date>`clock_timestamp()`,
      reversed_by_user_id: trx.userId,
    })
    .where('tenant_id', '=', trx.tenantId)
    .where('payment_id', '=', id)
    .execute();

  // 3. Mark payment reversed
  await trx.db
    .updateTable('customer_credit_payments')
    .set({
      status: 'REVERSED',
      allocated_amount: '0.0000',
      unallocated_amount: '0.0000',
      reversal_reason: input.reason.trim(),
      reversed_at: sql<Date>`clock_timestamp()`,
      reversed_by_user_id: trx.userId,
      updated_at: sql<Date>`clock_timestamp()`,
    })
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', id)
    .execute();

  // 4. Update customer credit account
  const account = await trx.db
    .selectFrom('customer_credit_accounts')
    .select(['id', 'current_balance', 'credit_limit', 'total_payments', 'unallocated_payment_balance'])
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', payment.account_id)
    .forUpdate()
    .executeTakeFirstOrThrow();

  const payAmountMoney = Money.fromDecimalString(String(payment.amount), 'LKR');
  const allocPayMoney = Money.fromDecimalString(String(payment.allocated_amount), 'LKR');
  const curBalMoney = Money.fromDecimalString(String(account.current_balance), 'LKR');
  const newBalMoney = curBalMoney.add(allocPayMoney);
  const creditLimitMoney = Money.fromDecimalString(String(account.credit_limit), 'LKR');
  const newAvailMoney = creditLimitMoney.compare(newBalMoney) > 0
    ? creditLimitMoney.subtract(newBalMoney)
    : Money.zero('LKR');

  const unallocPayMoney = Money.fromDecimalString(String(payment.unallocated_amount), 'LKR');

  await trx.db
    .updateTable('customer_credit_accounts')
    .set({
      current_balance: newBalMoney.toDecimalString(),
      available_credit: newAvailMoney.toDecimalString(),
      total_payments: sql`GREATEST(0, total_payments - ${payAmountMoney.toDecimalString()}::numeric)`,
      unallocated_payment_balance: sql`GREATEST(0, unallocated_payment_balance - ${unallocPayMoney.toDecimalString()}::numeric)`,
      updated_at: sql<Date>`clock_timestamp()`,
    })
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', account.id)
    .execute();

  // 5. Post PAYMENT_REVERSAL debit ledger entry
  const yearMonth = new Date().toISOString().slice(0, 7).replace('-', '');
  const txRef = `CTX-${yearMonth}-${generateUuidV7().slice(-5).toUpperCase()}`;
  await trx.db.insertInto('customer_credit_transactions').values({
    id: generateUuidV7(),
    tenant_id: trx.tenantId,
    account_id: account.id,
    customer_id: payment.customer_id,
    branch_id: payment.branch_id,
    transaction_reference: txRef,
    transaction_type: 'PAYMENT_REVERSAL',
    entry_direction: 'DEBIT',
    amount: payAmountMoney.toDecimalString(),
    currency_code: 'LKR',
    balance_after: newBalMoney.toDecimalString(),
    unpaid_amount: '0.0000',
    transaction_date: sql<string>`CURRENT_DATE`,
    source_reference_type: 'PAYMENT_REVERSAL',
    source_reference_id: id,
    source_reference_number: payment.payment_reference,
    description: `Reversal of Payment ${payment.payment_reference}: ${input.reason.trim()}`,
    created_by_user_id: trx.userId,
  }).execute();

  await appendAuditLog(trx, {
    action: 'crm:payment:reverse',
    resourceType: 'customer_credit_payments',
    resourceId: id,
    metadata: {
      paymentReference: payment.payment_reference,
      reversedAmount: payAmountMoney.toDecimalString(),
      reason: input.reason,
    },
  });

  const updatedPay = await trx.db
    .selectFrom('customer_credit_payments')
    .innerJoin('customers', (join) =>
      join
        .onRef('customer_credit_payments.tenant_id', '=', 'customers.tenant_id')
        .onRef('customer_credit_payments.customer_id', '=', 'customers.id'),
    )
    .select([
      'customer_credit_payments.id',
      'customer_credit_payments.account_id',
      'customer_credit_payments.customer_id',
      'customers.name as customer_name',
      'customer_credit_payments.payment_reference',
      'customer_credit_payments.receipt_number',
      'customer_credit_payments.amount',
      'customer_credit_payments.allocated_amount',
      'customer_credit_payments.unallocated_amount',
      'customer_credit_payments.currency_code',
      'customer_credit_payments.payment_date',
      'customer_credit_payments.payment_method',
      'customer_credit_payments.external_reference',
      'customer_credit_payments.branch_id',
      'customer_credit_payments.status',
      'customer_credit_payments.reversal_reason',
      'customer_credit_payments.reversed_at',
      'customer_credit_payments.notes',
      'customer_credit_payments.created_at',
    ])
    .where('customer_credit_payments.tenant_id', '=', trx.tenantId)
    .where('customer_credit_payments.id', '=', id)
    .executeTakeFirstOrThrow();

  return {
    id: updatedPay.id,
    accountId: updatedPay.account_id,
    customerId: updatedPay.customer_id,
    customerName: updatedPay.customer_name,
    paymentReference: updatedPay.payment_reference,
    receiptNumber: updatedPay.receipt_number,
    amount: String(updatedPay.amount),
    allocatedAmount: String(updatedPay.allocated_amount),
    unallocatedAmount: String(updatedPay.unallocated_amount),
    currencyCode: updatedPay.currency_code,
    paymentDate: String(updatedPay.payment_date).slice(0, 10),
    paymentMethod: updatedPay.payment_method,
    externalReference: updatedPay.external_reference,
    branchId: updatedPay.branch_id,
    status: updatedPay.status,
    reversalReason: updatedPay.reversal_reason,
    reversedAt: updatedPay.reversed_at ? (updatedPay.reversed_at as Date).toISOString() : null,
    notes: updatedPay.notes,
    createdAt: updatedPay.created_at.toISOString(),
  };
}

export async function allocateUnappliedPayment(
  trx: TenantTransactionContext,
  input: AllocateUnappliedPaymentRequest,
): Promise<CustomerCreditPaymentResponse> {
  await assertAuthorized(trx, { permission: 'crm:payment:create' });

  const payment = await trx.db
    .selectFrom('customer_credit_payments')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', input.paymentId)
    .forUpdate()
    .executeTakeFirst();

  if (!payment) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'CREDIT_PAYMENT_NOT_FOUND',
      title: 'Payment Not Found',
      detail: `Credit payment "${input.paymentId}" was not found.`,
    });
  }

  if (payment.status !== 'COMPLETED') {
    throw new AppError({
      statusCode: 409,
      errorCode: 'CREDIT_PAYMENT_ALREADY_REVERSED',
      title: 'Payment Reversed',
      detail: 'Cannot allocate from a reversed payment.',
    });
  }

  const unallocAvailableMoney = Money.fromDecimalString(String(payment.unallocated_amount), 'LKR');
  let allocatedTotalMoney = Money.zero('LKR');

  for (const alloc of input.allocations) {
    const allocMoney = Money.fromDecimalString(alloc.amount, 'LKR');
    if (!allocMoney.isPositive()) {
      throw new AppError({
        statusCode: 400,
        errorCode: 'ERR_VALIDATION_FAILED',
        title: 'Invalid Allocation Amount',
        detail: 'Allocation amount must be strictly positive.',
      });
    }

    const tx = await trx.db
      .selectFrom('customer_credit_transactions')
      .select(['id', 'unpaid_amount', 'source_reference_id', 'entry_direction'])
      .where('tenant_id', '=', trx.tenantId)
      .where('account_id', '=', payment.account_id)
      .where('id', '=', alloc.transactionId)
      .forUpdate()
      .executeTakeFirst();

    if (!tx || tx.entry_direction !== 'DEBIT') {
      throw new AppError({
        statusCode: 404,
        errorCode: 'CREDIT_TRANSACTION_NOT_FOUND',
        title: 'Transaction Not Found',
        detail: `Transaction "${alloc.transactionId}" not found or not eligible for payment allocation.`,
      });
    }

    const unpaidMoney = Money.fromDecimalString(String(tx.unpaid_amount), 'LKR');
    if (allocMoney.compare(unpaidMoney) > 0) {
      throw new AppError({
        statusCode: 400,
        errorCode: 'CREDIT_ALLOCATION_EXCEEDS_DUE',
        title: 'Allocation Exceeds Amount Due',
        detail: `Allocation of LKR ${allocMoney.toDecimalString()} exceeds unpaid amount LKR ${unpaidMoney.toDecimalString()} for transaction "${alloc.transactionId}".`,
      });
    }

    allocatedTotalMoney = allocatedTotalMoney.add(allocMoney);

    await trx.db.insertInto('customer_credit_allocations').values({
      id: generateUuidV7(),
      tenant_id: trx.tenantId,
      payment_id: payment.id,
      invoice_id: tx.source_reference_id,
      transaction_id: alloc.transactionId,
      amount: allocMoney.toDecimalString(),
      allocated_by_user_id: trx.userId,
      status: 'ACTIVE',
    }).execute();

    await trx.db
      .updateTable('customer_credit_transactions')
      .set({
        unpaid_amount: sql`GREATEST(0, unpaid_amount - ${allocMoney.toDecimalString()}::numeric)`,
        updated_at: sql<Date>`clock_timestamp()`,
      })
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', alloc.transactionId)
      .execute();
  }

  if (allocatedTotalMoney.compare(unallocAvailableMoney) > 0) {
    throw new AppError({
      statusCode: 400,
      errorCode: 'CREDIT_ALLOCATION_EXCEEDS_PAYMENT',
      title: 'Allocation Exceeds Available Payment',
      detail: `Allocations of LKR ${allocatedTotalMoney.toDecimalString()} exceed available unapplied amount LKR ${unallocAvailableMoney.toDecimalString()}.`,
    });
  }

  const newUnallocMoney = unallocAvailableMoney.subtract(allocatedTotalMoney);

  // Update payment records
  await trx.db
    .updateTable('customer_credit_payments')
    .set({
      allocated_amount: sql`allocated_amount + ${allocatedTotalMoney.toDecimalString()}::numeric`,
      unallocated_amount: newUnallocMoney.toDecimalString(),
      updated_at: sql<Date>`clock_timestamp()`,
    })
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', payment.id)
    .execute();

  // Deduct from account's unallocated_payment_balance
  await trx.db
    .updateTable('customer_credit_accounts')
    .set({
      unallocated_payment_balance: sql`GREATEST(0, unallocated_payment_balance - ${allocatedTotalMoney.toDecimalString()}::numeric)`,
      updated_at: sql<Date>`clock_timestamp()`,
    })
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', payment.account_id)
    .execute();

  return recordCustomerCreditPaymentReturn(trx, payment.id);
}

async function recordCustomerCreditPaymentReturn(
  trx: TenantTransactionContext,
  paymentId: string,
): Promise<CustomerCreditPaymentResponse> {
  const r = await trx.db
    .selectFrom('customer_credit_payments')
    .innerJoin('customers', (join) =>
      join
        .onRef('customer_credit_payments.tenant_id', '=', 'customers.tenant_id')
        .onRef('customer_credit_payments.customer_id', '=', 'customers.id'),
    )
    .select([
      'customer_credit_payments.id',
      'customer_credit_payments.account_id',
      'customer_credit_payments.customer_id',
      'customers.name as customer_name',
      'customer_credit_payments.payment_reference',
      'customer_credit_payments.receipt_number',
      'customer_credit_payments.amount',
      'customer_credit_payments.allocated_amount',
      'customer_credit_payments.unallocated_amount',
      'customer_credit_payments.currency_code',
      'customer_credit_payments.payment_date',
      'customer_credit_payments.payment_method',
      'customer_credit_payments.external_reference',
      'customer_credit_payments.branch_id',
      'customer_credit_payments.status',
      'customer_credit_payments.reversal_reason',
      'customer_credit_payments.reversed_at',
      'customer_credit_payments.notes',
      'customer_credit_payments.created_at',
    ])
    .where('customer_credit_payments.tenant_id', '=', trx.tenantId)
    .where('customer_credit_payments.id', '=', paymentId)
    .executeTakeFirstOrThrow();

  return {
    id: r.id,
    accountId: r.account_id,
    customerId: r.customer_id,
    customerName: r.customer_name,
    paymentReference: r.payment_reference,
    receiptNumber: r.receipt_number,
    amount: String(r.amount),
    allocatedAmount: String(r.allocated_amount),
    unallocatedAmount: String(r.unallocated_amount),
    currencyCode: r.currency_code,
    paymentDate: String(r.payment_date).slice(0, 10),
    paymentMethod: r.payment_method,
    externalReference: r.external_reference,
    branchId: r.branch_id,
    status: r.status,
    reversalReason: r.reversal_reason,
    reversedAt: r.reversed_at ? (r.reversed_at as Date).toISOString() : null,
    notes: r.notes,
    createdAt: r.created_at.toISOString(),
  };
}

export async function getPaymentReceipt(
  trx: TenantTransactionContext,
  id: string,
): Promise<PaymentReceiptResponse> {
  await assertAuthorized(trx, { permission: 'crm:ledger:read' });

  const payment = await trx.db
    .selectFrom('customer_credit_payments')
    .innerJoin('customer_credit_accounts', (join) =>
      join
        .onRef('customer_credit_payments.tenant_id', '=', 'customer_credit_accounts.tenant_id')
        .onRef('customer_credit_payments.account_id', '=', 'customer_credit_accounts.id'),
    )
    .innerJoin('customers', (join) =>
      join
        .onRef('customer_credit_payments.tenant_id', '=', 'customers.tenant_id')
        .onRef('customer_credit_payments.customer_id', '=', 'customers.id'),
    )
    .innerJoin('users', 'customer_credit_payments.received_by_user_id', 'users.id')
    .select([
      'customer_credit_payments.receipt_number',
      'customer_credit_payments.payment_reference',
      'customer_credit_payments.external_reference',
      'customer_credit_payments.payment_date',
      'customers.name as customer_name',
      'customers.customer_number',
      'customer_credit_accounts.account_number',
      'customer_credit_payments.payment_method',
      'customer_credit_payments.amount',
      'customer_credit_payments.allocated_amount',
      'customer_credit_payments.unallocated_amount',
      'customer_credit_accounts.current_balance',
      'customer_credit_accounts.available_credit',
      'users.full_name as received_by_name',
      'customer_credit_payments.notes',
    ])
    .where('customer_credit_payments.tenant_id', '=', trx.tenantId)
    .where('customer_credit_payments.id', '=', id)
    .executeTakeFirst();

  if (!payment) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'CREDIT_PAYMENT_NOT_FOUND',
      title: 'Payment Not Found',
      detail: `Credit payment "${id}" was not found.`,
    });
  }

  const allocRows = await trx.db
    .selectFrom('customer_credit_allocations')
    .innerJoin('customer_credit_transactions', (join) =>
      join
        .onRef('customer_credit_allocations.tenant_id', '=', 'customer_credit_transactions.tenant_id')
        .onRef('customer_credit_allocations.transaction_id', '=', 'customer_credit_transactions.id'),
    )
    .select([
      'customer_credit_transactions.transaction_reference',
      'customer_credit_transactions.transaction_date',
      'customer_credit_allocations.amount',
    ])
    .where('customer_credit_allocations.tenant_id', '=', trx.tenantId)
    .where('customer_credit_allocations.payment_id', '=', id)
    .where('customer_credit_allocations.status', '=', 'ACTIVE')
    .execute();

  return {
    receiptNumber: payment.receipt_number,
    paymentReference: payment.payment_reference,
    externalReference: payment.external_reference,
    paymentDate: String(payment.payment_date).slice(0, 10),
    customerName: payment.customer_name,
    customerNumber: payment.customer_number,
    accountNumber: payment.account_number,
    paymentMethod: payment.payment_method,
    amount: String(payment.amount),
    allocatedAmount: String(payment.allocated_amount),
    unallocatedAmount: String(payment.unallocated_amount),
    currentBalance: String(payment.current_balance),
    availableCredit: String(payment.available_credit),
    receivedByName: payment.received_by_name,
    notes: payment.notes,
    allocations: allocRows.map((a) => ({
      transactionReference: a.transaction_reference,
      transactionDate: String(a.transaction_date).slice(0, 10),
      allocatedAmount: String(a.amount),
    })),
  };
}

export async function listCreditPayments(
  trx: TenantTransactionContext,
  query: ListCreditPaymentsQuery,
): Promise<CustomerCreditPaymentListResponse> {
  await assertAuthorized(trx, { permission: 'crm:credit:read' });

  const limit = query.limit ?? 50;
  const offset = query.offset ?? 0;

  let baseQuery = trx.db
    .selectFrom('customer_credit_payments')
    .innerJoin('customers', (join) =>
      join
        .onRef('customer_credit_payments.tenant_id', '=', 'customers.tenant_id')
        .onRef('customer_credit_payments.customer_id', '=', 'customers.id'),
    )
    .where('customer_credit_payments.tenant_id', '=', trx.tenantId);

  if (query.accountId) {
    baseQuery = baseQuery.where('customer_credit_payments.account_id', '=', query.accountId);
  }
  if (query.customerId) {
    baseQuery = baseQuery.where('customer_credit_payments.customer_id', '=', query.customerId);
  }

  const countRow = await baseQuery
    .select(sql<number>`count(*)::int`.as('total'))
    .executeTakeFirst();
  const total = countRow?.total ?? 0;

  const rows = await baseQuery
    .select([
      'customer_credit_payments.id',
      'customer_credit_payments.account_id',
      'customer_credit_payments.customer_id',
      'customers.name as customer_name',
      'customer_credit_payments.payment_reference',
      'customer_credit_payments.receipt_number',
      'customer_credit_payments.amount',
      'customer_credit_payments.allocated_amount',
      'customer_credit_payments.unallocated_amount',
      'customer_credit_payments.currency_code',
      'customer_credit_payments.payment_date',
      'customer_credit_payments.payment_method',
      'customer_credit_payments.external_reference',
      'customer_credit_payments.branch_id',
      'customer_credit_payments.status',
      'customer_credit_payments.reversal_reason',
      'customer_credit_payments.reversed_at',
      'customer_credit_payments.notes',
      'customer_credit_payments.created_at',
    ])
    .orderBy('customer_credit_payments.created_at', 'desc')
    .limit(limit)
    .offset(offset)
    .execute();

  const paymentIds = rows.map((r) => r.id);
  const allocationsByPaymentId = new Map<
    string,
    Array<{
      transactionId: string;
      transactionReference: string;
      transactionDate: string;
      allocatedAmount: string;
    }>
  >();

  if (paymentIds.length > 0) {
    const allocRows = await trx.db
      .selectFrom('customer_credit_allocations')
      .innerJoin('customer_credit_transactions', (join) =>
        join
          .onRef('customer_credit_allocations.tenant_id', '=', 'customer_credit_transactions.tenant_id')
          .onRef('customer_credit_allocations.transaction_id', '=', 'customer_credit_transactions.id'),
      )
      .select([
        'customer_credit_allocations.payment_id',
        'customer_credit_allocations.transaction_id',
        'customer_credit_transactions.transaction_reference',
        'customer_credit_transactions.transaction_date',
        'customer_credit_allocations.amount',
      ])
      .where('customer_credit_allocations.tenant_id', '=', trx.tenantId)
      .where('customer_credit_allocations.payment_id', 'in', paymentIds)
      .where('customer_credit_allocations.status', '=', 'ACTIVE')
      .orderBy('customer_credit_transactions.transaction_date', 'asc')
      .execute();

    for (const a of allocRows) {
      const list = allocationsByPaymentId.get(a.payment_id) ?? [];
      list.push({
        transactionId: a.transaction_id,
        transactionReference: a.transaction_reference,
        transactionDate: String(a.transaction_date).slice(0, 10),
        allocatedAmount: String(a.amount),
      });
      allocationsByPaymentId.set(a.payment_id, list);
    }
  }

  return {
    items: rows.map((r) => ({
      id: r.id,
      accountId: r.account_id,
      customerId: r.customer_id,
      customerName: r.customer_name,
      paymentReference: r.payment_reference,
      receiptNumber: r.receipt_number,
      amount: String(r.amount),
      allocatedAmount: String(r.allocated_amount),
      unallocatedAmount: String(r.unallocated_amount),
      currencyCode: r.currency_code,
      paymentDate: String(r.payment_date).slice(0, 10),
      paymentMethod: r.payment_method,
      externalReference: r.external_reference,
      branchId: r.branch_id,
      status: r.status,
      reversalReason: r.reversal_reason,
      reversedAt: r.reversed_at ? new Date(r.reversed_at).toISOString() : null,
      notes: r.notes,
      allocations: allocationsByPaymentId.get(r.id) ?? [],
      createdAt: new Date(r.created_at).toISOString(),
    })),
    total,
  };
}

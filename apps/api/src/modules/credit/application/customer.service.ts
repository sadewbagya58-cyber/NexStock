import {
  type CreateCustomerRequest,
  type CustomerListResponse,
  type CustomerResponse,
  type ListCustomersQuery,
  type UpdateCustomerRequest,
} from '@nexstock/contracts';
import { sql } from 'kysely';
import { assertAuthorized } from '../../iam/index.js';
import {
  AppError,
  type TenantTransactionContext,
  appendAuditLog,
  generateUuidV7,
} from '../../shared/index.js';

export async function createCustomer(
  trx: TenantTransactionContext,
  input: CreateCustomerRequest,
): Promise<CustomerResponse> {
  await assertAuthorized(trx, { permission: 'crm:customer:manage' });

  // Generate sequential customer number: CUST-XXXXX
  const countRes = await trx.db
    .selectFrom('customers')
    .select(sql<number>`count(*)::int`.as('count'))
    .where('tenant_id', '=', trx.tenantId)
    .executeTakeFirst();
  const nextSeq = (countRes?.count ?? 0) + 1;
  const customerNumber = `CUST-${String(nextSeq).padStart(5, '0')}`;

  const customerId = generateUuidV7();
  const row = await trx.db
    .insertInto('customers')
    .values({
      id: customerId,
      tenant_id: trx.tenantId,
      customer_number: customerNumber,
      name: input.name.trim(),
      email: input.email?.trim() || null,
      phone: input.phone?.trim() || null,
      address: input.address?.trim() || null,
      tax_id: input.taxId?.trim() || null,
      notes: input.notes?.trim() || null,
      status: 'ACTIVE',
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  await appendAuditLog(trx, {
    action: 'crm:customer:create',
    resourceType: 'customers',
    resourceId: row.id,
    metadata: { customerNumber: row.customer_number, name: row.name },
  });

  return {
    id: row.id,
    customerNumber: row.customer_number,
    name: row.name,
    email: row.email,
    phone: row.phone,
    address: row.address,
    taxId: row.tax_id,
    notes: row.notes,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function getCustomerById(
  trx: TenantTransactionContext,
  id: string,
): Promise<CustomerResponse> {
  await assertAuthorized(trx, { permission: 'crm:customer:read' });

  const customer = await trx.db
    .selectFrom('customers')
    .leftJoin('customer_credit_accounts', (join) =>
      join
        .onRef('customers.tenant_id', '=', 'customer_credit_accounts.tenant_id')
        .onRef('customers.id', '=', 'customer_credit_accounts.customer_id'),
    )
    .select([
      'customers.id',
      'customers.customer_number',
      'customers.name',
      'customers.email',
      'customers.phone',
      'customers.address',
      'customers.tax_id',
      'customers.notes',
      'customers.status',
      'customers.created_at',
      'customers.updated_at',
      'customer_credit_accounts.id as credit_account_id',
      'customer_credit_accounts.account_number as credit_account_number',
      'customer_credit_accounts.credit_limit',
      'customer_credit_accounts.current_balance',
      'customer_credit_accounts.available_credit',
      'customer_credit_accounts.status as credit_status',
    ])
    .where('customers.tenant_id', '=', trx.tenantId)
    .where('customers.id', '=', id)
    .executeTakeFirst();

  if (!customer) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'CUST_NOT_FOUND',
      title: 'Customer Not Found',
      detail: `Customer with ID "${id}" was not found.`,
    });
  }

  return {
    id: customer.id,
    customerNumber: customer.customer_number,
    name: customer.name,
    email: customer.email,
    phone: customer.phone,
    address: customer.address,
    taxId: customer.tax_id,
    notes: customer.notes,
    status: customer.status,
    ...(customer.credit_account_id ? { creditAccountId: customer.credit_account_id } : {}),
    ...(customer.credit_account_number ? { creditAccountNumber: customer.credit_account_number } : {}),
    ...(customer.credit_limit != null ? { creditLimit: String(customer.credit_limit) } : {}),
    ...(customer.current_balance != null ? { currentBalance: String(customer.current_balance) } : {}),
    ...(customer.available_credit != null ? { availableCredit: String(customer.available_credit) } : {}),
    ...(customer.credit_status ? { creditStatus: customer.credit_status } : {}),
    createdAt: customer.created_at.toISOString(),
    updatedAt: customer.updated_at.toISOString(),
  };
}

export async function listCustomers(
  trx: TenantTransactionContext,
  query: ListCustomersQuery,
): Promise<CustomerListResponse> {
  await assertAuthorized(trx, { permission: 'crm:customer:read' });

  const limit = query.limit ?? 50;
  const offset = query.offset ?? 0;

  let baseQuery = trx.db
    .selectFrom('customers')
    .leftJoin('customer_credit_accounts', (join) =>
      join
        .onRef('customers.tenant_id', '=', 'customer_credit_accounts.tenant_id')
        .onRef('customers.id', '=', 'customer_credit_accounts.customer_id'),
    )
    .where('customers.tenant_id', '=', trx.tenantId);

  if (query.status) {
    baseQuery = baseQuery.where('customers.status', '=', query.status);
  }

  if (query.search?.trim()) {
    const term = `%${query.search.trim().toLowerCase()}%`;
    baseQuery = baseQuery.where((eb) =>
      eb.or([
        eb(sql`lower(customers.name)`, 'like', term),
        eb(sql`lower(customers.customer_number)`, 'like', term),
        eb(sql`lower(coalesce(customers.phone, ''))`, 'like', term),
        eb(sql`lower(coalesce(customers.email, ''))`, 'like', term),
      ]),
    );
  }

  const countRow = await baseQuery
    .select(sql<number>`count(*)::int`.as('total'))
    .executeTakeFirst();
  const total = countRow?.total ?? 0;

  const rows = await baseQuery
    .select([
      'customers.id',
      'customers.customer_number',
      'customers.name',
      'customers.email',
      'customers.phone',
      'customers.address',
      'customers.tax_id',
      'customers.notes',
      'customers.status',
      'customers.created_at',
      'customers.updated_at',
      'customer_credit_accounts.id as credit_account_id',
      'customer_credit_accounts.account_number as credit_account_number',
      'customer_credit_accounts.credit_limit',
      'customer_credit_accounts.current_balance',
      'customer_credit_accounts.available_credit',
      'customer_credit_accounts.status as credit_status',
    ])
    .orderBy('customers.name', 'asc')
    .limit(limit)
    .offset(offset)
    .execute();

  const items: CustomerResponse[] = rows.map((r) => ({
    id: r.id,
    customerNumber: r.customer_number,
    name: r.name,
    email: r.email,
    phone: r.phone,
    address: r.address,
    taxId: r.tax_id,
    notes: r.notes,
    status: r.status,
    ...(r.credit_account_id ? { creditAccountId: r.credit_account_id } : {}),
    ...(r.credit_account_number ? { creditAccountNumber: r.credit_account_number } : {}),
    ...(r.credit_limit != null ? { creditLimit: String(r.credit_limit) } : {}),
    ...(r.current_balance != null ? { currentBalance: String(r.current_balance) } : {}),
    ...(r.available_credit != null ? { availableCredit: String(r.available_credit) } : {}),
    ...(r.credit_status ? { creditStatus: r.credit_status } : {}),
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  }));

  return { items, total };
}

export async function updateCustomer(
  trx: TenantTransactionContext,
  id: string,
  input: UpdateCustomerRequest,
): Promise<CustomerResponse> {
  await assertAuthorized(trx, { permission: 'crm:customer:manage' });

  const existing = await trx.db
    .selectFrom('customers')
    .select(['id', 'status'])
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', id)
    .executeTakeFirst();

  if (!existing) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'CUST_NOT_FOUND',
      title: 'Customer Not Found',
      detail: `Customer with ID "${id}" was not found.`,
    });
  }

  const updateValues: Record<string, unknown> = {
    updated_at: sql<Date>`clock_timestamp()`,
  };

  if (input.name !== undefined) updateValues['name'] = input.name.trim();
  if (input.email !== undefined) updateValues['email'] = input.email?.trim() || null;
  if (input.phone !== undefined) updateValues['phone'] = input.phone?.trim() || null;
  if (input.address !== undefined) updateValues['address'] = input.address?.trim() || null;
  if (input.taxId !== undefined) updateValues['tax_id'] = input.taxId?.trim() || null;
  if (input.notes !== undefined) updateValues['notes'] = input.notes?.trim() || null;
  if (input.status !== undefined) updateValues['status'] = input.status;

  const row = await trx.db
    .updateTable('customers')
    .set(updateValues)
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirstOrThrow();

  await appendAuditLog(trx, {
    action: 'crm:customer:update',
    resourceType: 'customers',
    resourceId: row.id,
    metadata: { changes: Object.keys(updateValues) },
  });

  return getCustomerById(trx, id);
}

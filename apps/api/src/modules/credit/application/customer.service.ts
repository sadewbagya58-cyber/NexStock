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
import { assertSubscriptionEntitlement } from '../../sub/index.js';

export async function createCustomer(
  trx: TenantTransactionContext,
  input: CreateCustomerRequest,
): Promise<CustomerResponse> {
  // Allow crm:customer:manage or frontline cashiers with pos:sale:create + crm:customer:read
  try {
    await assertAuthorized(trx, { permission: 'crm:customer:manage' });
  } catch {
    await assertAuthorized(trx, { permission: 'crm:customer:read' });
    await assertAuthorized(trx, { permission: 'pos:sale:create' });
  }
  await assertSubscriptionEntitlement(trx, { requireWriteAccess: true });

  const addrLine1 = input.addressLine1?.trim() || null;
  const addrCity = (input.addressCity ?? input.city)?.trim() || null;
  const addrPostal = (input.addressPostalCode ?? input.postalCode)?.trim() || null;
  const compName = input.companyName?.trim() || null;

  // Canonical address resolution
  let resolvedAddress = input.address?.trim() || null;
  if (!resolvedAddress) {
    const parts = [addrLine1, addrCity, addrPostal].filter(Boolean);
    if (parts.length > 0) {
      resolvedAddress = parts.join(', ');
    }
  }

  // Canonical notes / company name resolution
  const noteParts = [
    compName ? `Company: ${compName}` : null,
    input.notes?.trim() || null,
  ].filter(Boolean);
  const resolvedNotes = noteParts.length > 0 ? noteParts.join('\n') : null;

  // Status resolution
  let resolvedStatus: 'ACTIVE' | 'INACTIVE' | 'ARCHIVED' = 'ACTIVE';
  if (input.status) {
    resolvedStatus = input.status;
  } else if (input.isActive === false) {
    resolvedStatus = 'INACTIVE';
  }

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
      address: resolvedAddress,
      address_line1: addrLine1 ?? resolvedAddress,
      city: addrCity,
      postal_code: addrPostal,
      company_name: compName,
      tax_id: input.taxId?.trim() || null,
      notes: resolvedNotes,
      status: resolvedStatus,
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
    addressLine1: row.address_line1 ?? row.address,
    addressCity: row.city ?? null,
    addressPostalCode: row.postal_code ?? null,
    city: row.city ?? null,
    postalCode: row.postal_code ?? null,
    companyName: row.company_name ?? null,
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
      'customers.address_line1',
      'customers.city',
      'customers.postal_code',
      'customers.company_name',
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
    addressLine1: customer.address_line1 ?? customer.address,
    addressCity: customer.city ?? null,
    addressPostalCode: customer.postal_code ?? null,
    city: customer.city ?? null,
    postalCode: customer.postal_code ?? null,
    companyName: customer.company_name ?? null,
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
      'customers.address_line1',
      'customers.city',
      'customers.postal_code',
      'customers.company_name',
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
    addressLine1: r.address_line1 ?? r.address,
    addressCity: r.city ?? null,
    addressPostalCode: r.postal_code ?? null,
    city: r.city ?? null,
    postalCode: r.postal_code ?? null,
    companyName: r.company_name ?? null,
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
  await assertSubscriptionEntitlement(trx, { requireWriteAccess: true });

  const existing = await trx.db
    .selectFrom('customers')
    .select(['id', 'status', 'address', 'address_line1', 'city', 'postal_code', 'company_name'])
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

  const hasCityUpdate = input.addressCity !== undefined || input.city !== undefined;
  const hasPostalUpdate = input.addressPostalCode !== undefined || input.postalCode !== undefined;
  const nextLine1 =
    input.addressLine1 !== undefined
      ? input.addressLine1?.trim() || null
      : existing.address_line1 ?? null;
  const nextCity = hasCityUpdate
    ? (input.addressCity ?? input.city)?.trim() || null
    : existing.city ?? null;
  const nextPostal = hasPostalUpdate
    ? (input.addressPostalCode ?? input.postalCode)?.trim() || null
    : existing.postal_code ?? null;

  if (input.addressLine1 !== undefined) updateValues['address_line1'] = nextLine1;
  if (hasCityUpdate) updateValues['city'] = nextCity;
  if (hasPostalUpdate) updateValues['postal_code'] = nextPostal;

  if (input.address !== undefined) {
    const trimmedAddr = input.address?.trim() || null;
    updateValues['address'] = trimmedAddr;
    if (input.addressLine1 === undefined && !hasCityUpdate && !hasPostalUpdate) {
      updateValues['address_line1'] = trimmedAddr;
    }
  } else if (input.addressLine1 !== undefined || hasCityUpdate || hasPostalUpdate) {
    const parts = [nextLine1, nextCity, nextPostal].filter(Boolean);
    updateValues['address'] = parts.length > 0 ? parts.join(', ') : null;
  }

  if (input.companyName !== undefined) {
    updateValues['company_name'] = input.companyName?.trim() || null;
  }

  if (input.taxId !== undefined) updateValues['tax_id'] = input.taxId?.trim() || null;
  
  if (input.notes !== undefined) {
    const effCompany = input.companyName !== undefined ? input.companyName?.trim() : existing.company_name;
    const noteParts = [
      effCompany ? `Company: ${effCompany}` : null,
      input.notes?.trim() || null,
    ].filter(Boolean);
    updateValues['notes'] = noteParts.length > 0 ? noteParts.join('\n') : null;
  } else if (input.companyName !== undefined) {
    updateValues['notes'] = input.companyName?.trim() ? `Company: ${input.companyName.trim()}` : null;
  }

  if (input.status !== undefined) {
    updateValues['status'] = input.status;
  } else if (input.isActive !== undefined) {
    updateValues['status'] = input.isActive ? 'ACTIVE' : 'INACTIVE';
  }

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

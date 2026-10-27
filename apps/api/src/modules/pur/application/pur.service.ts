import type {
  CreateSupplierRequest,
  LinkSupplierProductRequest,
  ListSuppliersQuery,
  RecordLifecycleStatus,
  SupplierProductResponse,
  SupplierResponse,
  UpdateSupplierRequest,
} from '@nexstock/contracts';
import { Money, Quantity } from '@nexstock/domain-core';
import {
  type CursorPaginatedResult,
  resolveProductForInventory,
} from '../../cat/index.js';
import { assertAuthorized } from '../../iam/index.js';
import {
  AppError,
  type TenantTransactionContext,
  appendAuditLog,
  enqueueOutboxEvent,
  generateUuidV7,
} from '../../shared/index.js';
import { assertSubscriptionEntitlement } from '../../sub/index.js';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_REGEX = /^[0-9+()\-.\s]{5,40}$/;

function validateSupplierContactData(input: {
  readonly email?: string | null | undefined;
  readonly phone?: string | null | undefined;
}): {
  readonly email: string | null;
  readonly phone: string | null;
} {
  const email = input.email?.trim().toLowerCase() || null;
  if (email && !EMAIL_REGEX.test(email)) {
    throw new AppError({
      statusCode: 400,
      errorCode: 'ERR_VALIDATION_FAILED',
      title: 'Invalid Supplier Email Address',
      detail: `Email address "${email}" is not in a valid format.`,
    });
  }

  const phone = input.phone?.trim() || null;
  if (phone && !PHONE_REGEX.test(phone)) {
    throw new AppError({
      statusCode: 400,
      errorCode: 'ERR_VALIDATION_FAILED',
      title: 'Invalid Supplier Phone Number',
      detail: `Phone number "${phone}" contains invalid characters or length.`,
    });
  }

  return { email, phone };
}

async function hydrateSupplierResponse(
  trx: TenantTransactionContext,
  row: {
    id: string;
    tenant_id: string;
    code: string;
    business_name: string;
    contact_person: string | null;
    email: string | null;
    phone: string | null;
    address: string | null;
    tax_registration_number: string | null;
    notes: string | null;
    status: RecordLifecycleStatus;
    sync_version: string | number;
    created_at: Date | string;
    updated_at: Date | string;
    archived_at: Date | string | null;
  },
): Promise<SupplierResponse> {
  const linkRows = await trx.db
    .selectFrom('supplier_products')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('supplier_id', '=', row.id)
    .orderBy('id', 'asc')
    .execute();

  const products: SupplierProductResponse[] = linkRows.map((l) => {
    const currency = l.currency_code?.trim() || null;
    return {
      id: l.id,
      tenantId: l.tenant_id,
      supplierId: l.supplier_id,
      productId: l.product_id,
      supplierSku: l.supplier_sku,
      supplierProductName: l.supplier_product_name,
      unitCost:
        l.unit_cost !== null
          ? Money.fromDecimalString(
              String(l.unit_cost),
              currency ?? 'USD',
            ).toDecimalString()
          : null,
      currencyCode: currency,
      minimumOrderQty:
        l.minimum_order_qty !== null
          ? Quantity.fromDecimalString(
              String(l.minimum_order_qty),
            ).toDecimalString()
          : null,
      leadTimeDays: l.lead_time_days,
      isPreferred: l.is_preferred,
      createdAt: new Date(l.created_at).toISOString(),
      updatedAt: new Date(l.updated_at).toISOString(),
    };
  });

  return {
    id: row.id,
    tenantId: row.tenant_id,
    code: row.code,
    businessName: row.business_name,
    contactPerson: row.contact_person,
    email: row.email,
    phone: row.phone,
    address: row.address,
    taxRegistrationNumber: row.tax_registration_number,
    notes: row.notes,
    status: row.status,
    products,
    syncVersion: Number(row.sync_version),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    archivedAt: row.archived_at ? new Date(row.archived_at).toISOString() : null,
  };
}

export async function createSupplier(
  trx: TenantTransactionContext,
  input: CreateSupplierRequest,
): Promise<SupplierResponse> {
  await assertAuthorized(trx, {
    permission: 'pur:supplier:manage',
  });

  await assertSubscriptionEntitlement(trx, {
    requireWriteAccess: true,
  });

  const code = input.code.trim().toUpperCase();
  const businessName = input.businessName.trim();

  if (!code || !businessName) {
    throw new AppError({
      statusCode: 400,
      errorCode: 'ERR_VALIDATION_FAILED',
      title: 'Invalid Supplier Code or Name',
      detail: 'Supplier code and businessName cannot be blank.',
    });
  }

  const { email, phone } = validateSupplierContactData({
    email: input.email,
    phone: input.phone,
  });

  const existingCode = await trx.db
    .selectFrom('suppliers')
    .select(['id'])
    .where('tenant_id', '=', trx.tenantId)
    .where('code', '=', code)
    .executeTakeFirst();

  if (existingCode) {
    throw new AppError({
      statusCode: 409,
      errorCode: 'PUR_DUPLICATE_SUPPLIER_CODE',
      title: 'Duplicate Supplier Code',
      detail: `A supplier with code "${code}" already exists in this organization.`,
    });
  }

  const taxRegistrationNumber = input.taxRegistrationNumber?.trim() || null;
  if (taxRegistrationNumber) {
    const allSuppliers = await trx.db
      .selectFrom('suppliers')
      .select(['id', 'tax_registration_number'])
      .where('tenant_id', '=', trx.tenantId)
      .where('tax_registration_number', 'is not', null)
      .execute();

    const dupTax = allSuppliers.find(
      (s) =>
        s.tax_registration_number?.trim().toLowerCase() ===
        taxRegistrationNumber.toLowerCase(),
    );

    if (dupTax) {
      throw new AppError({
        statusCode: 409,
        errorCode: 'PUR_DUPLICATE_SUPPLIER_TAX_ID',
        title: 'Duplicate Supplier Tax Registration Number',
        detail: `A supplier with tax registration number "${taxRegistrationNumber}" already exists in this organization.`,
      });
    }
  }

  const supplierId = generateUuidV7();
  const now = new Date();

  await trx.db
    .insertInto('suppliers')
    .values({
      id: supplierId,
      tenant_id: trx.tenantId,
      code,
      business_name: businessName,
      contact_person: input.contactPerson?.trim() || null,
      email,
      phone,
      address: input.address?.trim() || null,
      tax_registration_number: taxRegistrationNumber,
      notes: input.notes?.trim() || null,
      status: 'ACTIVE',
      sync_version: 1,
      created_at: now,
      updated_at: now,
      archived_at: null,
    })
    .execute();

  await appendAuditLog(trx, {
    action: 'PUR_SUPPLIER_CREATED',
    resourceType: 'SUPPLIER',
    resourceId: supplierId,
    metadata: { code, businessName, taxRegistrationNumber },
  });

  await enqueueOutboxEvent(trx, {
    aggregateType: 'SUPPLIER',
    aggregateId: supplierId,
    eventType: 'SUPPLIER_CREATED',
    payload: { supplierId, code, businessName },
  });

  const inserted = await trx.db
    .selectFrom('suppliers')
    .selectAll()
    .where('id', '=', supplierId)
    .executeTakeFirstOrThrow();

  return hydrateSupplierResponse(trx, inserted);
}

export async function getSupplierById(
  trx: TenantTransactionContext,
  supplierId: string,
): Promise<SupplierResponse> {
  await assertAuthorized(trx, {
    permission: 'pur:supplier:read',
  });

  await assertSubscriptionEntitlement(trx, {
    requireWriteAccess: false,
  });

  const row = await trx.db
    .selectFrom('suppliers')
    .selectAll()
    .where('id', '=', supplierId)
    .executeTakeFirst();

  if (!row) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'ERR_NOT_FOUND',
      title: 'Supplier Not Found',
      detail: `Supplier "${supplierId}" was not found.`,
    });
  }

  return hydrateSupplierResponse(trx, row);
}

export async function updateSupplier(
  trx: TenantTransactionContext,
  supplierId: string,
  input: UpdateSupplierRequest,
): Promise<SupplierResponse> {
  await assertAuthorized(trx, {
    permission: 'pur:supplier:manage',
  });

  await assertSubscriptionEntitlement(trx, {
    requireWriteAccess: true,
  });

  const existing = await trx.db
    .selectFrom('suppliers')
    .selectAll()
    .where('id', '=', supplierId)
    .executeTakeFirst();

  if (!existing) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'ERR_NOT_FOUND',
      title: 'Supplier Not Found',
      detail: `Supplier "${supplierId}" was not found.`,
    });
  }

  const nextCode =
    input.code !== undefined ? input.code.trim().toUpperCase() : existing.code;
  const nextBusinessName =
    input.businessName !== undefined
      ? input.businessName.trim()
      : existing.business_name;

  if (!nextCode || !nextBusinessName) {
    throw new AppError({
      statusCode: 400,
      errorCode: 'ERR_VALIDATION_FAILED',
      title: 'Invalid Supplier Code or Name',
      detail: 'Supplier code and businessName cannot be blank.',
    });
  }

  if (nextCode !== existing.code) {
    const dupCode = await trx.db
      .selectFrom('suppliers')
      .select(['id'])
      .where('tenant_id', '=', trx.tenantId)
      .where('code', '=', nextCode)
      .where('id', '<>', supplierId)
      .executeTakeFirst();

    if (dupCode) {
      throw new AppError({
        statusCode: 409,
        errorCode: 'PUR_DUPLICATE_SUPPLIER_CODE',
        title: 'Duplicate Supplier Code',
        detail: `A supplier with code "${nextCode}" already exists in this organization.`,
      });
    }
  }

  const nextEmailInput =
    input.email !== undefined ? input.email : existing.email;
  const nextPhoneInput =
    input.phone !== undefined ? input.phone : existing.phone;
  const { email: nextEmail, phone: nextPhone } = validateSupplierContactData({
    email: nextEmailInput,
    phone: nextPhoneInput,
  });

  const nextTaxReg =
    input.taxRegistrationNumber !== undefined
      ? (input.taxRegistrationNumber?.trim() || null)
      : existing.tax_registration_number;

  if (nextTaxReg) {
    const others = await trx.db
      .selectFrom('suppliers')
      .select(['id', 'tax_registration_number'])
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '<>', supplierId)
      .where('tax_registration_number', 'is not', null)
      .execute();

    const dupTax = others.find(
      (s) =>
        s.tax_registration_number?.trim().toLowerCase() ===
        nextTaxReg.toLowerCase(),
    );

    if (dupTax) {
      throw new AppError({
        statusCode: 409,
        errorCode: 'PUR_DUPLICATE_SUPPLIER_TAX_ID',
        title: 'Duplicate Supplier Tax Registration Number',
        detail: `A supplier with tax registration number "${nextTaxReg}" already exists in this organization.`,
      });
    }
  }

  const now = new Date();
  const nextSyncVersion = Number(existing.sync_version) + 1;

  await trx.db
    .updateTable('suppliers')
    .set({
      code: nextCode,
      business_name: nextBusinessName,
      contact_person:
        input.contactPerson !== undefined
          ? (input.contactPerson?.trim() || null)
          : existing.contact_person,
      email: nextEmail,
      phone: nextPhone,
      address:
        input.address !== undefined
          ? (input.address?.trim() || null)
          : existing.address,
      tax_registration_number: nextTaxReg,
      notes:
        input.notes !== undefined
          ? (input.notes?.trim() || null)
          : existing.notes,
      sync_version: nextSyncVersion,
      updated_at: now,
    })
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', supplierId)
    .execute();

  await appendAuditLog(trx, {
    action: 'PUR_SUPPLIER_UPDATED',
    resourceType: 'SUPPLIER',
    resourceId: supplierId,
    metadata: {
      previousCode: existing.code,
      nextCode,
      nextBusinessName,
    },
  });

  const updated = await trx.db
    .selectFrom('suppliers')
    .selectAll()
    .where('id', '=', supplierId)
    .executeTakeFirstOrThrow();

  return hydrateSupplierResponse(trx, updated);
}

export async function archiveSupplier(
  trx: TenantTransactionContext,
  supplierId: string,
): Promise<SupplierResponse> {
  await assertAuthorized(trx, {
    permission: 'pur:supplier:manage',
  });

  await assertSubscriptionEntitlement(trx, {
    requireWriteAccess: true,
  });

  const existing = await trx.db
    .selectFrom('suppliers')
    .selectAll()
    .where('id', '=', supplierId)
    .executeTakeFirst();

  if (!existing) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'ERR_NOT_FOUND',
      title: 'Supplier Not Found',
      detail: `Supplier "${supplierId}" was not found.`,
    });
  }

  const now = new Date();
  const nextSyncVersion = Number(existing.sync_version) + 1;

  await trx.db
    .updateTable('suppliers')
    .set({
      status: 'ARCHIVED',
      archived_at: now,
      sync_version: nextSyncVersion,
      updated_at: now,
    })
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', supplierId)
    .execute();

  await appendAuditLog(trx, {
    action: 'PUR_SUPPLIER_ARCHIVED',
    resourceType: 'SUPPLIER',
    resourceId: supplierId,
    metadata: { code: existing.code, businessName: existing.business_name },
  });

  const updated = await trx.db
    .selectFrom('suppliers')
    .selectAll()
    .where('id', '=', supplierId)
    .executeTakeFirstOrThrow();

  return hydrateSupplierResponse(trx, updated);
}

export async function linkSupplierProduct(
  trx: TenantTransactionContext,
  supplierId: string,
  input: LinkSupplierProductRequest,
): Promise<SupplierProductResponse> {
  await assertAuthorized(trx, {
    permission: 'pur:supplier:manage',
  });

  await assertSubscriptionEntitlement(trx, {
    requireWriteAccess: true,
  });

  const supplierRow = await trx.db
    .selectFrom('suppliers')
    .select(['id', 'status'])
    .where('id', '=', supplierId)
    .executeTakeFirst();

  if (!supplierRow) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'ERR_NOT_FOUND',
      title: 'Supplier Not Found',
      detail: `Supplier "${supplierId}" was not found in tenant "${trx.tenantId}".`,
    });
  }
  if (supplierRow.status !== 'ACTIVE') {
    throw new AppError({
      statusCode: 400,
      errorCode: 'ERR_VALIDATION_FAILED',
      title: 'Supplier Is Archived',
      detail: `Cannot link products to archived supplier "${supplierId}".`,
    });
  }

  // Verify product exists in the same tenant via CAT public facade
  const productInfo = await resolveProductForInventory(trx, input.productId);
  if (productInfo.status !== 'ACTIVE') {
    throw new AppError({
      statusCode: 400,
      errorCode: 'ERR_VALIDATION_FAILED',
      title: 'Product Is Archived',
      detail: `Cannot link archived product "${input.productId}" to a supplier.`,
    });
  }

  const currencyCode = input.currencyCode?.trim().toUpperCase() || null;
  let normalizedUnitCost: string | null = null;
  if (input.unitCost !== undefined && input.unitCost !== null) {
    const money = Money.fromDecimalString(
      input.unitCost,
      currencyCode ?? 'USD',
    );
    if (money.isNegative()) {
      throw new AppError({
        statusCode: 400,
        errorCode: 'ERR_VALIDATION_FAILED',
        title: 'Negative Supplier Unit Cost',
        detail: 'Supplier unit cost cannot be negative.',
      });
    }
    normalizedUnitCost = money.toDecimalString();
  }

  let normalizedMinOrderQty: string | null = null;
  if (input.minimumOrderQty !== undefined && input.minimumOrderQty !== null) {
    const qty = Quantity.fromDecimalString(input.minimumOrderQty);
    if (!qty.isPositive()) {
      throw new AppError({
        statusCode: 400,
        errorCode: 'ERR_VALIDATION_FAILED',
        title: 'Invalid Minimum Order Quantity',
        detail: 'Supplier minimumOrderQty must be strictly greater than zero.',
      });
    }
    normalizedMinOrderQty = qty.toDecimalString();
  }

  const supplierSku = input.supplierSku?.trim().toUpperCase() || null;
  if (supplierSku) {
    const dupSupplierSku = await trx.db
      .selectFrom('supplier_products')
      .select(['id', 'product_id'])
      .where('tenant_id', '=', trx.tenantId)
      .where('supplier_id', '=', supplierId)
      .where('supplier_sku', '=', supplierSku)
      .where('product_id', '<>', input.productId)
      .executeTakeFirst();

    if (dupSupplierSku) {
      throw new AppError({
        statusCode: 409,
        errorCode: 'PUR_DUPLICATE_SUPPLIER_PRODUCT',
        title: 'Duplicate Supplier SKU',
        detail: `Supplier SKU "${supplierSku}" is already assigned to another product for this supplier.`,
      });
    }
  }

  const existingLink = await trx.db
    .selectFrom('supplier_products')
    .select(['id', 'created_at'])
    .where('tenant_id', '=', trx.tenantId)
    .where('supplier_id', '=', supplierId)
    .where('product_id', '=', input.productId)
    .executeTakeFirst();

  const now = new Date();
  const linkId = existingLink?.id ?? generateUuidV7();
  const isPreferred = input.isPreferred ?? false;
  const leadTimeDays = input.leadTimeDays ?? null;
  const supplierProductName = input.supplierProductName?.trim() || null;

  if (existingLink) {
    await trx.db
      .updateTable('supplier_products')
      .set({
        supplier_sku: supplierSku,
        supplier_product_name: supplierProductName,
        unit_cost: normalizedUnitCost,
        currency_code: currencyCode,
        minimum_order_qty: normalizedMinOrderQty,
        lead_time_days: leadTimeDays,
        is_preferred: isPreferred,
        updated_at: now,
      })
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', linkId)
      .execute();
  } else {
    await trx.db
      .insertInto('supplier_products')
      .values({
        id: linkId,
        tenant_id: trx.tenantId,
        supplier_id: supplierId,
        product_id: input.productId,
        supplier_sku: supplierSku,
        supplier_product_name: supplierProductName,
        unit_cost: normalizedUnitCost,
        currency_code: currencyCode,
        minimum_order_qty: normalizedMinOrderQty,
        lead_time_days: leadTimeDays,
        is_preferred: isPreferred,
        created_at: now,
        updated_at: now,
      })
      .execute();
  }

  await appendAuditLog(trx, {
    action: 'PUR_SUPPLIER_PRODUCT_LINKED',
    resourceType: 'SUPPLIER_PRODUCT',
    resourceId: linkId,
    metadata: {
      supplierId,
      productId: input.productId,
      supplierSku,
      unitCost: normalizedUnitCost,
    },
  });

  return {
    id: linkId,
    tenantId: trx.tenantId,
    supplierId,
    productId: input.productId,
    supplierSku,
    supplierProductName,
    unitCost: normalizedUnitCost,
    currencyCode,
    minimumOrderQty: normalizedMinOrderQty,
    leadTimeDays,
    isPreferred,
    createdAt: existingLink
      ? new Date(existingLink.created_at).toISOString()
      : now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

export async function listSuppliers(
  trx: TenantTransactionContext,
  query: ListSuppliersQuery,
): Promise<CursorPaginatedResult<SupplierResponse>> {
  await assertAuthorized(trx, {
    permission: 'pur:supplier:read',
  });

  await assertSubscriptionEntitlement(trx, {
    requireWriteAccess: false,
  });

  const limit = Math.min(Math.max(Number(query.limit ?? 50), 1), 100);

  let dbQuery = trx.db
    .selectFrom('suppliers')
    .selectAll()
    .orderBy('id', 'asc');

  if (query.status) {
    dbQuery = dbQuery.where('status', '=', query.status);
  }
  if (query.cursor) {
    dbQuery = dbQuery.where('id', '>', query.cursor);
  }

  const rows = await dbQuery.execute();
  const searchLower = query.search?.trim().toLowerCase();

  const filtered = searchLower
    ? rows.filter(
        (r) =>
          r.code.toLowerCase().includes(searchLower) ||
          r.business_name.toLowerCase().includes(searchLower) ||
          (r.contact_person?.toLowerCase().includes(searchLower) ?? false) ||
          (r.email?.toLowerCase().includes(searchLower) ?? false) ||
          (r.tax_registration_number?.toLowerCase().includes(searchLower) ??
            false),
      )
    : rows;

  const pageRows = filtered.slice(0, limit);
  const hasNextPage = filtered.length > limit;
  const nextCursor =
    hasNextPage && pageRows.length > 0
      ? pageRows[pageRows.length - 1]!.id
      : null;

  const hydrated: SupplierResponse[] = [];
  for (const r of pageRows) {
    hydrated.push(await hydrateSupplierResponse(trx, r));
  }

  return {
    data: hydrated,
    pageInfo: {
      hasNextPage,
      nextCursor,
    },
  };
}

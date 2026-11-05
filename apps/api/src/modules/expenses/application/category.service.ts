import type {
  CreateExpenseCategoryRequest,
  ExpenseCategoryListResponse,
  ExpenseCategoryResponse,
  UpdateExpenseCategoryRequest,
} from '@nexstock/contracts';
import { sql } from 'kysely';
import { resolveMemberAuthorizationContext } from '../../iam/index.js';
import {
  AppError,
  type TenantTransactionContext,
  appendAuditLog,
  generateUuidV7,
} from '../../shared/index.js';

export const DEFAULT_EXPENSE_CATEGORIES = [
  { code: 'RENT', name: 'Rent', description: 'Office, warehouse, and store lease/rental expenses' },
  { code: 'ELECTRICITY', name: 'Electricity', description: 'Power and utility billing expenses' },
  { code: 'WATER', name: 'Water', description: 'Municipal water and sewage utility expenses' },
  { code: 'INTERNET', name: 'Internet', description: 'Broadband, telecom, and communication services' },
  { code: 'TRANSPORT', name: 'Transport', description: 'Logistics, delivery, courier, and travel expenses' },
  { code: 'SALARIES_WAGES', name: 'Salaries and Wages', description: 'Operational staff wages, contract labor, and overtime payouts' },
  { code: 'MAINTENANCE', name: 'Maintenance', description: 'Equipment, building, and vehicle repairs' },
  { code: 'OFFICE_SUPPLIES', name: 'Office Supplies', description: 'Stationery, packaging materials, and office consumables' },
  { code: 'MARKETING', name: 'Marketing', description: 'Advertising, promotion, campaigns, and branding expenses' },
  { code: 'OTHER', name: 'Other Expenses', description: 'Miscellaneous operational business expenses' },
] as const;

export async function seedDefaultExpenseCategories(
  trx: TenantTransactionContext,
): Promise<void> {
  for (const cat of DEFAULT_EXPENSE_CATEGORIES) {
    const existing = await trx.db
      .selectFrom('expense_categories')
      .select(['id'])
      .where('tenant_id', '=', trx.tenantId)
      .where('code', '=', cat.code)
      .executeTakeFirst();

    if (!existing) {
      await trx.db
        .insertInto('expense_categories')
        .values({
          id: generateUuidV7(),
          tenant_id: trx.tenantId,
          code: cat.code,
          name: cat.name,
          description: cat.description,
          is_active: true,
          is_system_default: true,
        })
        .execute();
    }
  }
}

export interface ExpenseCategoryRow {
  id: string;
  tenant_id: string;
  code: string;
  name: string;
  description: string | null;
  is_active: boolean;
  is_system_default: boolean;
  created_at: Date | string;
  updated_at: Date | string;
  expense_count?: string | number | null;
}

export function mapCategory(row: ExpenseCategoryRow): ExpenseCategoryResponse {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    code: row.code,
    name: row.name,
    description: row.description,
    isActive: Boolean(row.is_active),
    isSystemDefault: Boolean(row.is_system_default),
    ...(row.expense_count != null ? { expenseCount: Number(row.expense_count) } : {}),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export async function listExpenseCategories(
  trx: TenantTransactionContext,
  includeInactive = true,
): Promise<ExpenseCategoryListResponse> {
  const auth = await resolveMemberAuthorizationContext(trx);
  if (
    !auth.permissions.has('exp:expense:read') &&
    !auth.permissions.has('exp:expense:manage') &&
    !auth.permissions.has('exp:category:manage')
  ) {
    throw new AppError({
      statusCode: 403,
      errorCode: 'IAM_PERMISSION_DENIED',
      title: 'Permission Denied',
      detail: 'User lacks required permission to view expense categories',
    });
  }

  // Ensure default categories exist
  await seedDefaultExpenseCategories(trx);

  let query = trx.db
    .selectFrom('expense_categories as ec')
    .leftJoin('expenses as e', (join) =>
      join
        .onRef('e.category_id', '=', 'ec.id')
        .onRef('e.tenant_id', '=', 'ec.tenant_id'),
    )
    .select([
      'ec.id',
      'ec.tenant_id',
      'ec.code',
      'ec.name',
      'ec.description',
      'ec.is_active',
      'ec.is_system_default',
      'ec.created_at',
      'ec.updated_at',
      sql<number>`count(e.id)`.as('expense_count'),
    ])
    .where('ec.tenant_id', '=', trx.tenantId)
    .groupBy([
      'ec.id',
      'ec.tenant_id',
      'ec.code',
      'ec.name',
      'ec.description',
      'ec.is_active',
      'ec.is_system_default',
      'ec.created_at',
      'ec.updated_at',
    ])
    .orderBy('ec.name', 'asc');

  if (!includeInactive) {
    query = query.where('ec.is_active', '=', true);
  }

  const rows = await query.execute();
  return {
    items: rows.map(mapCategory),
  };
}

export async function createExpenseCategory(
  trx: TenantTransactionContext,
  input: CreateExpenseCategoryRequest,
): Promise<ExpenseCategoryResponse> {
  const auth = await resolveMemberAuthorizationContext(trx);
  if (
    !auth.permissions.has('exp:category:manage') &&
    !auth.permissions.has('exp:expense:manage')
  ) {
    throw new AppError({
      statusCode: 403,
      errorCode: 'IAM_PERMISSION_DENIED',
      title: 'Permission Denied',
      detail: 'User lacks required permission to manage expense categories',
    });
  }

  const normalizedCode = input.code.trim().toUpperCase();
  const normalizedName = input.name.trim();

  const existing = await trx.db
    .selectFrom('expense_categories')
    .select(['id'])
    .where('tenant_id', '=', trx.tenantId)
    .where('code', '=', normalizedCode)
    .executeTakeFirst();

  if (existing) {
    throw new AppError({
      statusCode: 409,
      errorCode: 'EXP_DUPLICATE_CATEGORY_CODE',
      title: 'Duplicate Category Code',
      detail: `An expense category with code "${normalizedCode}" already exists`,
    });
  }

  const id = generateUuidV7();
  const created = await trx.db
    .insertInto('expense_categories')
    .values({
      id,
      tenant_id: trx.tenantId,
      code: normalizedCode,
      name: normalizedName,
      description: input.description?.trim() ?? null,
      is_active: true,
      is_system_default: false,
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  await appendAuditLog(trx, {
    action: 'exp.category.created',
    resourceType: 'expense_category',
    resourceId: id,
    metadata: { code: normalizedCode, name: normalizedName },
  });

  return mapCategory(created);
}

export async function updateExpenseCategory(
  trx: TenantTransactionContext,
  categoryId: string,
  input: UpdateExpenseCategoryRequest,
): Promise<ExpenseCategoryResponse> {
  const auth = await resolveMemberAuthorizationContext(trx);
  if (
    !auth.permissions.has('exp:category:manage') &&
    !auth.permissions.has('exp:expense:manage')
  ) {
    throw new AppError({
      statusCode: 403,
      errorCode: 'IAM_PERMISSION_DENIED',
      title: 'Permission Denied',
      detail: 'User lacks required permission to manage expense categories',
    });
  }

  const existing = await trx.db
    .selectFrom('expense_categories')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', categoryId)
    .executeTakeFirst();

  if (!existing) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'EXP_CATEGORY_NOT_FOUND',
      title: 'Category Not Found',
      detail: 'Expense category not found',
    });
  }

  const updates: Record<string, unknown> = {
    updated_at: new Date(),
  };

  if (input.name !== undefined) {
    updates.name = input.name.trim();
  }
  if (input.description !== undefined) {
    updates.description = input.description?.trim() ?? null;
  }
  if (input.isActive !== undefined) {
    updates.is_active = input.isActive;
  }

  const updated = await trx.db
    .updateTable('expense_categories')
    .set(updates)
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', categoryId)
    .returningAll()
    .executeTakeFirstOrThrow();

  await appendAuditLog(trx, {
    action: 'exp.category.updated',
    resourceType: 'expense_category',
    resourceId: categoryId,
    metadata: { updates },
  });

  return mapCategory(updated);
}

export async function deleteExpenseCategory(
  trx: TenantTransactionContext,
  categoryId: string,
): Promise<void> {
  const auth = await resolveMemberAuthorizationContext(trx);
  if (
    !auth.permissions.has('exp:category:manage') &&
    !auth.permissions.has('exp:expense:manage')
  ) {
    throw new AppError({
      statusCode: 403,
      errorCode: 'IAM_PERMISSION_DENIED',
      title: 'Permission Denied',
      detail: 'User lacks required permission to manage expense categories',
    });
  }

  const existing = await trx.db
    .selectFrom('expense_categories')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', categoryId)
    .executeTakeFirst();

  if (!existing) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'EXP_CATEGORY_NOT_FOUND',
      title: 'Category Not Found',
      detail: 'Expense category not found',
    });
  }

  // Prevent deletion when referenced by historical transactions
  const usageCount = await trx.db
    .selectFrom('expenses')
    .select(sql<number>`count(id)`.as('count'))
    .where('tenant_id', '=', trx.tenantId)
    .where('category_id', '=', categoryId)
    .executeTakeFirst();

  if (usageCount && Number(usageCount.count) > 0) {
    throw new AppError({
      statusCode: 409,
      errorCode: 'EXP_CATEGORY_IN_USE',
      title: 'Category In Use',
      detail: `Cannot delete expense category "${existing.name}" because it is referenced by ${usageCount.count} expense transaction(s). Deactivate the category instead.`,
    });
  }

  await trx.db
    .deleteFrom('expense_categories')
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', categoryId)
    .execute();

  await appendAuditLog(trx, {
    action: 'exp.category.deleted',
    resourceType: 'expense_category',
    resourceId: categoryId,
    metadata: { code: existing.code, name: existing.name },
  });
}

import type {
  ApproveExpenseRequest,
  CreateExpenseRequest,
  ExpenseListResponse,
  ExpensePaymentMethod,
  ExpenseResponse,
  ExpenseStatus,
  ExpenseSummaryByCategory,
  ExpenseSummaryByBranch,
  ExpenseSummaryByStatus,
  ExpenseSummaryReportResponse,
  RecordExpensePaymentRequest,
  RejectExpenseRequest,
  SubmitExpenseRequest,
  UpdateExpenseRequest,
} from '@nexstock/contracts';
import { sql } from 'kysely';
import {
  type AuthorizedMemberContext,
  type PermissionKey,
  resolveMemberAuthorizationContext,
} from '../../iam/index.js';
import {
  AppError,
  type TenantTransactionContext,
  appendAuditLog,
  generateUuidV7,
} from '../../shared/index.js';

export interface ExpenseRow {
  id: string;
  tenant_id: string;
  reference_number: string;
  title: string;
  description: string | null;
  category_id: string;
  category_name?: string;
  category_code?: string;
  amount: string | number;
  currency_code: string;
  expense_date: Date | string;
  vendor_payee: string | null;
  payment_method: ExpensePaymentMethod | null;
  branch_id: string | null;
  branch_name?: string | null;
  status: ExpenseStatus;
  rejection_reason: string | null;
  created_by_user_id: string;
  creator_name?: string | null;
  approved_by_user_id: string | null;
  approved_at: Date | string | null;
  paid_at: Date | string | null;
  payment_reference: string | null;
  payment_notes: string | null;
  attachment_count?: string | number | null;
  created_at: Date | string;
  updated_at: Date | string;
}

function formatDateOnly(d: Date | string | null): string {
  if (!d) return '';
  if (typeof d === 'string') return d.substring(0, 10);
  return d.toISOString().substring(0, 10);
}

function formatIso(d: Date | string | null): string | null {
  if (!d) return null;
  return new Date(d).toISOString();
}

function formatMoney(amount: string | number | null | undefined): string {
  if (amount == null) return '0.0000';
  const num = typeof amount === 'number' ? amount : parseFloat(String(amount));
  return isNaN(num) ? '0.0000' : num.toFixed(4);
}

export function mapExpense(row: ExpenseRow): ExpenseResponse {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    referenceNumber: row.reference_number,
    title: row.title,
    description: row.description,
    categoryId: row.category_id,
    ...(row.category_name != null ? { categoryName: row.category_name } : {}),
    ...(row.category_code != null ? { categoryCode: row.category_code } : {}),
    amount: formatMoney(row.amount),
    currencyCode: row.currency_code,
    expenseDate: formatDateOnly(row.expense_date),
    vendorPayee: row.vendor_payee,
    paymentMethod: row.payment_method,
    branchId: row.branch_id,
    ...(row.branch_name !== undefined ? { branchName: row.branch_name } : {}),
    status: row.status,
    rejectionReason: row.rejection_reason,
    approvedByUserId: row.approved_by_user_id,
    approvedAt: formatIso(row.approved_at),
    paidAt: formatIso(row.paid_at),
    paymentReference: row.payment_reference,
    createdByUserId: row.created_by_user_id,
    ...(row.creator_name !== undefined ? { createdByName: row.creator_name } : {}),
    notes: row.payment_notes,
    attachmentCount: row.attachment_count != null ? Number(row.attachment_count) : 0,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

async function assertExpensePermission(
  trx: TenantTransactionContext,
  permission: PermissionKey,
  options?: { branchId?: string | null | undefined },
): Promise<AuthorizedMemberContext> {
  const auth = await resolveMemberAuthorizationContext(trx);
  if (
    !auth.permissions.has(permission) &&
    !auth.permissions.has('exp:expense:manage')
  ) {
    throw new AppError({
      statusCode: 403,
      errorCode: 'IAM_PERMISSION_DENIED',
      title: 'Permission Denied',
      detail: `User lacks required permission: ${permission}`,
    });
  }

  if (
    options?.branchId &&
    !auth.allLocationsAccess &&
    !auth.allowedBranchIds.has(options.branchId)
  ) {
    throw new AppError({
      statusCode: 403,
      errorCode: 'IAM_LOCATION_SCOPE_DENIED',
      title: 'Location Scope Denied',
      detail: 'You are not authorized for this branch location',
    });
  }

  return auth;
}

export async function generateExpenseReferenceNumber(
  trx: TenantTransactionContext,
  expenseDateStr: string,
): Promise<string> {
  const dateObj = new Date(expenseDateStr);
  const yyyy = isNaN(dateObj.getFullYear())
    ? new Date().getUTCFullYear()
    : dateObj.getUTCFullYear();
  const mm = isNaN(dateObj.getMonth())
    ? String(new Date().getUTCMonth() + 1).padStart(2, '0')
    : String(dateObj.getUTCMonth() + 1).padStart(2, '0');
  const prefix = `EXP-${yyyy}${mm}`;

  const countRow = await trx.db
    .selectFrom('expenses')
    .select(sql<number>`count(id)`.as('count'))
    .where('tenant_id', '=', trx.tenantId)
    .where('reference_number', 'like', `${prefix}-%`)
    .executeTakeFirst();

  let nextSeq = (Number(countRow?.count ?? 0) || 0) + 1;

  for (let attempt = 0; attempt < 50; attempt++) {
    const candidate = `${prefix}-${String(nextSeq).padStart(5, '0')}`;
    const collision = await trx.db
      .selectFrom('expenses')
      .select(['id'])
      .where('tenant_id', '=', trx.tenantId)
      .where('reference_number', '=', candidate)
      .executeTakeFirst();

    if (!collision) {
      return candidate;
    }
    nextSeq += 1;
  }

  // Fallback random suffix
  const rand = Math.floor(10000 + Math.random() * 90000);
  return `${prefix}-${rand}`;
}

export async function createExpense(
  trx: TenantTransactionContext,
  input: CreateExpenseRequest,
): Promise<ExpenseResponse> {
  await assertExpensePermission(trx, 'exp:expense:create', {
    branchId: input.branchId,
  });

  // Validate positive amount
  const numAmount = parseFloat(input.amount);
  if (isNaN(numAmount) || numAmount <= 0) {
    throw new AppError({
      statusCode: 400,
      errorCode: 'ERR_VALIDATION_FAILED',
      title: 'Invalid Expense Amount',
      detail: 'Expense amount must be a positive number greater than 0',
    });
  }

  // Validate category
  const category = await trx.db
    .selectFrom('expense_categories')
    .select(['id', 'name', 'code', 'is_active'])
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', input.categoryId)
    .executeTakeFirst();

  if (!category) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'EXP_CATEGORY_NOT_FOUND',
      title: 'Category Not Found',
      detail: 'Expense category not found',
    });
  }

  if (!category.is_active) {
    throw new AppError({
      statusCode: 400,
      errorCode: 'EXP_CATEGORY_NOT_FOUND',
      title: 'Category Deactivated',
      detail: `Expense category "${category.name}" is deactivated and cannot accept new expense entries`,
    });
  }

  // Validate branch if supplied
  if (input.branchId) {
    const branch = await trx.db
      .selectFrom('branches')
      .select(['id'])
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', input.branchId)
      .executeTakeFirst();

    if (!branch) {
      throw new AppError({
        statusCode: 404,
        errorCode: 'ERR_NOT_FOUND',
        title: 'Branch Not Found',
        detail: 'Specified branch not found',
      });
    }
  }

  const expenseId = generateUuidV7();
  const referenceNumber = await generateExpenseReferenceNumber(
    trx,
    input.expenseDate,
  );

  await trx.db
    .insertInto('expenses')
    .values({
      id: expenseId,
      tenant_id: trx.tenantId,
      reference_number: referenceNumber,
      title: input.title.trim(),
      description: input.description?.trim() ?? null,
      category_id: input.categoryId,
      amount: input.amount,
      currency_code: input.currencyCode.trim().toUpperCase(),
      expense_date: input.expenseDate as unknown as Date,
      vendor_payee: input.vendorPayee?.trim() ?? null,
      payment_method: input.paymentMethod ?? 'CASH',
      branch_id: input.branchId ?? null,
      status: 'DRAFT',
      created_by_user_id: trx.userId,
      payment_notes: input.notes?.trim() ?? null,
    })
    .execute();

  await appendAuditLog(trx, {
    action: 'exp.expense.created',
    resourceType: 'expense',
    resourceId: expenseId,
    metadata: {
      referenceNumber,
      title: input.title,
      amount: input.amount,
      currencyCode: input.currencyCode,
      categoryId: input.categoryId,
    },
  });

  return getExpenseById(trx, expenseId);
}

export async function getExpenseById(
  trx: TenantTransactionContext,
  expenseId: string,
): Promise<ExpenseResponse> {
  const auth = await assertExpensePermission(trx, 'exp:expense:read');

  const row = await trx.db
    .selectFrom('expenses as e')
    .leftJoin('expense_categories as ec', 'ec.id', 'e.category_id')
    .leftJoin('branches as b', (join) =>
      join
        .onRef('b.id', '=', 'e.branch_id')
        .onRef('b.tenant_id', '=', 'e.tenant_id'),
    )
    .leftJoin('users as u', 'u.id', 'e.created_by_user_id')
    .leftJoin('expense_attachments as ea', 'ea.expense_id', 'e.id')
    .select([
      'e.id',
      'e.tenant_id',
      'e.reference_number',
      'e.title',
      'e.description',
      'e.category_id',
      'ec.name as category_name',
      'ec.code as category_code',
      'e.amount',
      'e.currency_code',
      'e.expense_date',
      'e.vendor_payee',
      'e.payment_method',
      'e.branch_id',
      'b.name as branch_name',
      'e.status',
      'e.rejection_reason',
      'e.created_by_user_id',
      'u.full_name as creator_name',
      'e.approved_by_user_id',
      'e.approved_at',
      'e.paid_at',
      'e.payment_reference',
      'e.payment_notes',
      'e.created_at',
      'e.updated_at',
      sql<number>`count(ea.id)`.as('attachment_count'),
    ])
    .where('e.tenant_id', '=', trx.tenantId)
    .where('e.id', '=', expenseId)
    .groupBy([
      'e.id',
      'e.tenant_id',
      'e.reference_number',
      'e.title',
      'e.description',
      'e.category_id',
      'ec.name',
      'ec.code',
      'e.amount',
      'e.currency_code',
      'e.expense_date',
      'e.vendor_payee',
      'e.payment_method',
      'e.branch_id',
      'b.name',
      'e.status',
      'e.rejection_reason',
      'e.created_by_user_id',
      'u.full_name',
      'e.approved_by_user_id',
      'e.approved_at',
      'e.paid_at',
      'e.payment_reference',
      'e.payment_notes',
      'e.created_at',
      'e.updated_at',
    ])
    .executeTakeFirst();

  if (!row) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'EXP_EXPENSE_NOT_FOUND',
      title: 'Expense Not Found',
      detail: 'Expense record not found',
    });
  }

  // Location scoping check
  if (
    row.branch_id &&
    !auth.allLocationsAccess &&
    !auth.allowedBranchIds.has(row.branch_id)
  ) {
    throw new AppError({
      statusCode: 403,
      errorCode: 'IAM_LOCATION_SCOPE_DENIED',
      title: 'Location Scope Denied',
      detail: 'You are not authorized to view expenses for this branch location',
    });
  }

  return mapExpense(row as unknown as ExpenseRow);
}

export async function listExpenses(
  trx: TenantTransactionContext,
  query: {
    startDate?: string;
    endDate?: string;
    status?: ExpenseStatus;
    categoryId?: string;
    branchId?: string;
    search?: string;
    limit?: number;
    offset?: number;
  },
): Promise<ExpenseListResponse> {
  const auth = await assertExpensePermission(trx, 'exp:expense:read');

  const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
  const offset = Math.max(query.offset ?? 0, 0);

  let baseQuery = trx.db
    .selectFrom('expenses as e')
    .leftJoin('expense_categories as ec', 'ec.id', 'e.category_id')
    .leftJoin('branches as b', (join) =>
      join
        .onRef('b.id', '=', 'e.branch_id')
        .onRef('b.tenant_id', '=', 'e.tenant_id'),
    )
    .leftJoin('users as u', 'u.id', 'e.created_by_user_id')
    .where('e.tenant_id', '=', trx.tenantId);

  // Apply location scoping
  if (!auth.allLocationsAccess) {
    const allowed = Array.from(auth.allowedBranchIds);
    if (allowed.length === 0) {
      baseQuery = baseQuery.where('e.branch_id', 'is', null);
    } else {
      baseQuery = baseQuery.where((eb) =>
        eb.or([
          eb('e.branch_id', 'in', allowed),
          eb('e.branch_id', 'is', null),
        ]),
      );
    }
  }

  if (query.startDate) {
    baseQuery = baseQuery.where('e.expense_date', '>=', query.startDate as unknown as Date);
  }
  if (query.endDate) {
    baseQuery = baseQuery.where('e.expense_date', '<=', query.endDate as unknown as Date);
  }
  if (query.status) {
    baseQuery = baseQuery.where('e.status', '=', query.status);
  }
  if (query.categoryId) {
    baseQuery = baseQuery.where('e.category_id', '=', query.categoryId);
  }
  if (query.branchId) {
    baseQuery = baseQuery.where('e.branch_id', '=', query.branchId);
  }
  if (query.search?.trim()) {
    const pattern = `%${query.search.trim()}%`;
    baseQuery = baseQuery.where((eb) =>
      eb.or([
        eb('e.reference_number', 'ilike', pattern),
        eb('e.title', 'ilike', pattern),
        eb('e.vendor_payee', 'ilike', pattern),
      ]),
    );
  }

  // Count total matching
  const totalRow = await baseQuery
    .select(sql<number>`count(e.id)`.as('count'))
    .executeTakeFirst();
  const total = Number(totalRow?.count ?? 0);

  // Fetch page items with attachment count
  const rows = await baseQuery
    .leftJoin('expense_attachments as ea', 'ea.expense_id', 'e.id')
    .select([
      'e.id',
      'e.tenant_id',
      'e.reference_number',
      'e.title',
      'e.description',
      'e.category_id',
      'ec.name as category_name',
      'ec.code as category_code',
      'e.amount',
      'e.currency_code',
      'e.expense_date',
      'e.vendor_payee',
      'e.payment_method',
      'e.branch_id',
      'b.name as branch_name',
      'e.status',
      'e.rejection_reason',
      'e.created_by_user_id',
      'u.full_name as creator_name',
      'e.approved_by_user_id',
      'e.approved_at',
      'e.paid_at',
      'e.payment_reference',
      'e.payment_notes',
      'e.created_at',
      'e.updated_at',
      sql<number>`count(ea.id)`.as('attachment_count'),
    ])
    .groupBy([
      'e.id',
      'e.tenant_id',
      'e.reference_number',
      'e.title',
      'e.description',
      'e.category_id',
      'ec.name',
      'ec.code',
      'e.amount',
      'e.currency_code',
      'e.expense_date',
      'e.vendor_payee',
      'e.payment_method',
      'e.branch_id',
      'b.name',
      'e.status',
      'e.rejection_reason',
      'e.created_by_user_id',
      'u.full_name',
      'e.approved_by_user_id',
      'e.approved_at',
      'e.paid_at',
      'e.payment_reference',
      'e.payment_notes',
      'e.created_at',
      'e.updated_at',
    ])
    .orderBy('e.expense_date', 'desc')
    .orderBy('e.created_at', 'desc')
    .limit(limit)
    .offset(offset)
    .execute();

  return {
    items: rows.map((r) => mapExpense(r as unknown as ExpenseRow)),
    total,
  };
}

export async function updateExpense(
  trx: TenantTransactionContext,
  expenseId: string,
  input: UpdateExpenseRequest,
): Promise<ExpenseResponse> {
  const auth = await assertExpensePermission(trx, 'exp:expense:edit');

  const existing = await trx.db
    .selectFrom('expenses')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', expenseId)
    .executeTakeFirst();

  if (!existing) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'EXP_EXPENSE_NOT_FOUND',
      title: 'Expense Not Found',
      detail: 'Expense not found',
    });
  }

  // Expenses can only be edited in DRAFT or REJECTED status
  if (existing.status !== 'DRAFT' && existing.status !== 'REJECTED') {
    throw new AppError({
      statusCode: 409,
      errorCode: 'EXP_NOT_EDITABLE',
      title: 'Expense Not Editable',
      detail: `Expenses in ${existing.status} status cannot be edited. Only DRAFT or REJECTED expenses may be modified.`,
    });
  }

  // Location scoping check
  if (
    existing.branch_id &&
    !auth.allLocationsAccess &&
    !auth.allowedBranchIds.has(existing.branch_id)
  ) {
    throw new AppError({
      statusCode: 403,
      errorCode: 'IAM_LOCATION_SCOPE_DENIED',
      title: 'Location Scope Denied',
      detail: 'You are not authorized to edit expenses for this branch location',
    });
  }

  if (
    input.branchId &&
    !auth.allLocationsAccess &&
    !auth.allowedBranchIds.has(input.branchId)
  ) {
    throw new AppError({
      statusCode: 403,
      errorCode: 'IAM_LOCATION_SCOPE_DENIED',
      title: 'Location Scope Denied',
      detail: 'You are not authorized to assign this branch location',
    });
  }

  // Validate category if updating
  if (input.categoryId && input.categoryId !== existing.category_id) {
    const category = await trx.db
      .selectFrom('expense_categories')
      .select(['id', 'is_active', 'name'])
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', input.categoryId)
      .executeTakeFirst();

    if (!category || !category.is_active) {
      throw new AppError({
        statusCode: 400,
        errorCode: 'EXP_CATEGORY_NOT_FOUND',
        title: 'Category Not Found',
        detail: 'Active expense category not found',
      });
    }
  }

  const updates: Record<string, unknown> = {
    updated_at: new Date(),
  };

  if (input.title !== undefined) updates.title = input.title.trim();
  if (input.description !== undefined) updates.description = input.description?.trim() ?? null;
  if (input.categoryId !== undefined) updates.category_id = input.categoryId;
  if (input.amount !== undefined) {
    const numAmount = parseFloat(input.amount);
    if (isNaN(numAmount) || numAmount <= 0) {
      throw new AppError({
        statusCode: 400,
        errorCode: 'ERR_VALIDATION_FAILED',
        title: 'Invalid Expense Amount',
        detail: 'Expense amount must be a positive number greater than 0',
      });
    }
    updates.amount = input.amount;
  }
  if (input.currencyCode !== undefined) updates.currency_code = input.currencyCode.trim().toUpperCase();
  if (input.expenseDate !== undefined) updates.expense_date = input.expenseDate as unknown as Date;
  if (input.vendorPayee !== undefined) updates.vendor_payee = input.vendorPayee?.trim() ?? null;
  if (input.paymentMethod !== undefined) updates.payment_method = input.paymentMethod ?? 'CASH';
  if (input.branchId !== undefined) updates.branch_id = input.branchId ?? null;
  if (input.notes !== undefined) updates.payment_notes = input.notes?.trim() ?? null;

  await trx.db
    .updateTable('expenses')
    .set(updates)
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', expenseId)
    .execute();

  await appendAuditLog(trx, {
    action: 'exp.expense.updated',
    resourceType: 'expense',
    resourceId: expenseId,
    metadata: { updates },
  });

  return getExpenseById(trx, expenseId);
}

export async function deleteExpense(
  trx: TenantTransactionContext,
  expenseId: string,
): Promise<void> {
  await assertExpensePermission(trx, 'exp:expense:delete');

  const existing = await trx.db
    .selectFrom('expenses')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', expenseId)
    .executeTakeFirst();

  if (!existing) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'EXP_EXPENSE_NOT_FOUND',
      title: 'Expense Not Found',
      detail: 'Expense not found',
    });
  }

  if (existing.status !== 'DRAFT') {
    throw new AppError({
      statusCode: 409,
      errorCode: 'EXP_NOT_DELETABLE',
      title: 'Expense Not Deletable',
      detail: `Cannot delete expense in ${existing.status} status. Only DRAFT expenses can be deleted.`,
    });
  }

  // Delete attached files first
  await trx.db
    .deleteFrom('expense_attachments')
    .where('tenant_id', '=', trx.tenantId)
    .where('expense_id', '=', expenseId)
    .execute();

  await trx.db
    .deleteFrom('expenses')
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', expenseId)
    .execute();

  await appendAuditLog(trx, {
    action: 'exp.expense.deleted',
    resourceType: 'expense',
    resourceId: expenseId,
    metadata: { referenceNumber: existing.reference_number, title: existing.title },
  });
}

export async function submitExpenseForApproval(
  trx: TenantTransactionContext,
  expenseId: string,
  input?: SubmitExpenseRequest,
): Promise<ExpenseResponse> {
  await assertExpensePermission(trx, 'exp:expense:submit');

  const existing = await trx.db
    .selectFrom('expenses')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', expenseId)
    .executeTakeFirst();

  if (!existing) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'EXP_EXPENSE_NOT_FOUND',
      title: 'Expense Not Found',
      detail: 'Expense not found',
    });
  }

  if (existing.status !== 'DRAFT' && existing.status !== 'REJECTED') {
    throw new AppError({
      statusCode: 409,
      errorCode: 'EXP_INVALID_STATUS_TRANSITION',
      title: 'Invalid Transition',
      detail: `Cannot submit expense in ${existing.status} status. Only DRAFT or REJECTED expenses can be submitted for approval.`,
    });
  }

  const now = new Date();
  await trx.db
    .updateTable('expenses')
    .set({
      status: 'PENDING_APPROVAL',
      submitted_at: now,
      submitted_by_user_id: trx.userId,
      rejection_reason: null,
      payment_notes: input?.notes?.trim() ?? existing.payment_notes,
      updated_at: now,
    })
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', expenseId)
    .execute();

  await appendAuditLog(trx, {
    action: 'exp.expense.submitted',
    resourceType: 'expense',
    resourceId: expenseId,
    metadata: {
      referenceNumber: existing.reference_number,
      previousStatus: existing.status,
      newStatus: 'PENDING_APPROVAL',
    },
  });

  return getExpenseById(trx, expenseId);
}

export async function approveExpense(
  trx: TenantTransactionContext,
  expenseId: string,
  input?: ApproveExpenseRequest,
): Promise<ExpenseResponse> {
  const auth = await assertExpensePermission(trx, 'exp:expense:approve');

  const existing = await trx.db
    .selectFrom('expenses')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', expenseId)
    .executeTakeFirst();

  if (!existing) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'EXP_EXPENSE_NOT_FOUND',
      title: 'Expense Not Found',
      detail: 'Expense not found',
    });
  }

  if (existing.status !== 'PENDING_APPROVAL') {
    throw new AppError({
      statusCode: 409,
      errorCode: 'EXP_INVALID_STATUS_TRANSITION',
      title: 'Invalid Transition',
      detail: `Cannot approve expense in ${existing.status} status. Only PENDING_APPROVAL expenses can be approved.`,
    });
  }

  // Separation of Duties: Creator cannot approve their own expense unless Tenant Owner or Org Admin
  const isOwnerOrAdmin = auth.roleCodes.some(
    (rc) => rc === 'TENANT_OWNER' || rc === 'ORG_ADMIN',
  );
  if (existing.created_by_user_id === trx.userId && !isOwnerOrAdmin) {
    throw new AppError({
      statusCode: 403,
      errorCode: 'EXP_CANNOT_APPROVE_OWN_EXPENSE',
      title: 'Separation of Duties',
      detail:
        'Separation of duties required: You cannot approve your own expense submission. Another authorized manager or administrator must review and approve it.',
    });
  }

  const now = new Date();
  await trx.db
    .updateTable('expenses')
    .set({
      status: 'APPROVED',
      approved_at: now,
      approved_by_user_id: trx.userId,
      rejection_reason: null,
      payment_notes: input?.notes?.trim() ?? existing.payment_notes,
      updated_at: now,
    })
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', expenseId)
    .execute();

  await appendAuditLog(trx, {
    action: 'exp.expense.approved',
    resourceType: 'expense',
    resourceId: expenseId,
    metadata: {
      referenceNumber: existing.reference_number,
      approvedByUserId: trx.userId,
      amount: existing.amount,
    },
  });

  return getExpenseById(trx, expenseId);
}

export async function rejectExpense(
  trx: TenantTransactionContext,
  expenseId: string,
  input: RejectExpenseRequest,
): Promise<ExpenseResponse> {
  await assertExpensePermission(trx, 'exp:expense:approve');

  const reason = input.rejectionReason?.trim();
  if (!reason || reason.length < 3) {
    throw new AppError({
      statusCode: 400,
      errorCode: 'EXP_REJECTION_REASON_REQUIRED',
      title: 'Rejection Reason Required',
      detail: 'A rejection reason of at least 3 characters is mandatory when rejecting an expense',
    });
  }

  const existing = await trx.db
    .selectFrom('expenses')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', expenseId)
    .executeTakeFirst();

  if (!existing) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'EXP_EXPENSE_NOT_FOUND',
      title: 'Expense Not Found',
      detail: 'Expense not found',
    });
  }

  if (existing.status !== 'PENDING_APPROVAL') {
    throw new AppError({
      statusCode: 409,
      errorCode: 'EXP_INVALID_STATUS_TRANSITION',
      title: 'Invalid Transition',
      detail: `Cannot reject expense in ${existing.status} status. Only PENDING_APPROVAL expenses can be rejected.`,
    });
  }

  const now = new Date();
  await trx.db
    .updateTable('expenses')
    .set({
      status: 'REJECTED',
      rejected_at: now,
      rejected_by_user_id: trx.userId,
      rejection_reason: reason,
      updated_at: now,
    })
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', expenseId)
    .execute();

  await appendAuditLog(trx, {
    action: 'exp.expense.rejected',
    resourceType: 'expense',
    resourceId: expenseId,
    metadata: {
      referenceNumber: existing.reference_number,
      rejectedByUserId: trx.userId,
      rejectionReason: reason,
    },
  });

  return getExpenseById(trx, expenseId);
}

export async function recordExpensePayment(
  trx: TenantTransactionContext,
  expenseId: string,
  input: RecordExpensePaymentRequest,
): Promise<ExpenseResponse> {
  await assertExpensePermission(trx, 'exp:expense:pay');

  const existing = await trx.db
    .selectFrom('expenses')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', expenseId)
    .executeTakeFirst();

  if (!existing) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'EXP_EXPENSE_NOT_FOUND',
      title: 'Expense Not Found',
      detail: 'Expense not found',
    });
  }

  if (existing.status === 'PAID') {
    throw new AppError({
      statusCode: 409,
      errorCode: 'EXP_ALREADY_PAID',
      title: 'Already Paid',
      detail: `Expense "${existing.reference_number}" is already marked as paid`,
    });
  }

  if (existing.status !== 'APPROVED') {
    throw new AppError({
      statusCode: 409,
      errorCode: 'EXP_INVALID_STATUS_TRANSITION',
      title: 'Invalid Transition',
      detail: `Only APPROVED expenses can be paid. Current status: ${existing.status}`,
    });
  }

  const now = new Date();
  const paymentDate = input.paymentDate
    ? new Date(input.paymentDate)
    : now;

  await trx.db
    .updateTable('expenses')
    .set({
      status: 'PAID',
      paid_at: paymentDate,
      paid_by_user_id: trx.userId,
      payment_method: input.paymentMethod,
      payment_reference: input.paymentReference?.trim() ?? null,
      payment_notes: input.notes?.trim() ?? existing.payment_notes,
      updated_at: now,
    })
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', expenseId)
    .execute();

  await appendAuditLog(trx, {
    action: 'exp.expense.paid',
    resourceType: 'expense',
    resourceId: expenseId,
    metadata: {
      referenceNumber: existing.reference_number,
      paidByUserId: trx.userId,
      paymentMethod: input.paymentMethod,
      paymentReference: input.paymentReference,
      amount: existing.amount,
    },
  });

  return getExpenseById(trx, expenseId);
}

export async function getExpenseSummaryReport(
  trx: TenantTransactionContext,
  query: {
    startDate?: string;
    endDate?: string;
    branchId?: string;
  },
): Promise<ExpenseSummaryReportResponse> {
  const auth = await assertExpensePermission(trx, 'exp:report:view');

  let baseQuery = trx.db
    .selectFrom('expenses as e')
    .where('e.tenant_id', '=', trx.tenantId);

  // Apply location scoping
  if (!auth.allLocationsAccess) {
    const allowed = Array.from(auth.allowedBranchIds);
    if (allowed.length === 0) {
      baseQuery = baseQuery.where('e.branch_id', 'is', null);
    } else {
      baseQuery = baseQuery.where((eb) =>
        eb.or([
          eb('e.branch_id', 'in', allowed),
          eb('e.branch_id', 'is', null),
        ]),
      );
    }
  }

  if (query.startDate) {
    baseQuery = baseQuery.where('e.expense_date', '>=', query.startDate as unknown as Date);
  }
  if (query.endDate) {
    baseQuery = baseQuery.where('e.expense_date', '<=', query.endDate as unknown as Date);
  }
  if (query.branchId) {
    baseQuery = baseQuery.where('e.branch_id', '=', query.branchId);
  }

  // Fetch status breakdown
  const statusRows = await baseQuery
    .select([
      'e.status',
      sql<number>`count(e.id)`.as('count'),
      sql<string | number>`coalesce(sum(e.amount), 0)`.as('total_amount'),
    ])
    .groupBy('e.status')
    .execute();

  let totalExpensesNum = 0;
  let totalCount = 0;
  let pendingAmount = 0;
  let pendingCount = 0;
  let approvedUnpaidAmount = 0;
  let approvedUnpaidCount = 0;
  let paidAmount = 0;
  let paidCount = 0;

  const byStatus: ExpenseSummaryByStatus[] = statusRows.map((r) => {
    const amt = parseFloat(String(r.total_amount ?? 0)) || 0;
    const cnt = Number(r.count ?? 0);

    // Sum overall except REJECTED
    if (r.status !== 'REJECTED') {
      totalExpensesNum += amt;
      totalCount += cnt;
    }

    if (r.status === 'PENDING_APPROVAL') {
      pendingAmount += amt;
      pendingCount += cnt;
    } else if (r.status === 'APPROVED') {
      approvedUnpaidAmount += amt;
      approvedUnpaidCount += cnt;
    } else if (r.status === 'PAID') {
      paidAmount += amt;
      paidCount += cnt;
    }

    return {
      status: r.status as ExpenseStatus,
      totalAmount: formatMoney(amt),
      count: cnt,
    };
  });

  // Fetch category breakdown
  const categoryRows = await baseQuery
    .innerJoin('expense_categories as ec', 'ec.id', 'e.category_id')
    .select([
      'ec.id as category_id',
      'ec.name as category_name',
      'ec.code as category_code',
      sql<number>`count(e.id)`.as('count'),
      sql<string | number>`coalesce(sum(e.amount), 0)`.as('total_amount'),
    ])
    .groupBy(['ec.id', 'ec.name', 'ec.code'])
    .orderBy('total_amount', 'desc')
    .execute();

  const byCategory: ExpenseSummaryByCategory[] = categoryRows.map((r) => ({
    categoryId: r.category_id,
    categoryName: r.category_name,
    categoryCode: r.category_code,
    totalAmount: formatMoney(r.total_amount),
    count: Number(r.count ?? 0),
  }));

  // Fetch branch breakdown
  const branchRows = await baseQuery
    .leftJoin('branches as b', (join) =>
      join
        .onRef('b.id', '=', 'e.branch_id')
        .onRef('b.tenant_id', '=', 'e.tenant_id'),
    )
    .select([
      'e.branch_id',
      'b.name as branch_name',
      sql<number>`count(e.id)`.as('count'),
      sql<string | number>`coalesce(sum(e.amount), 0)`.as('total_amount'),
    ])
    .groupBy(['e.branch_id', 'b.name'])
    .orderBy('total_amount', 'desc')
    .execute();

  const byBranch: ExpenseSummaryByBranch[] = branchRows.map((r) => ({
    branchId: r.branch_id,
    branchName: r.branch_name,
    totalAmount: formatMoney(r.total_amount),
    count: Number(r.count ?? 0),
  }));

  return {
    totalExpenses: formatMoney(totalExpensesNum),
    totalCount,
    pendingApprovalAmount: formatMoney(pendingAmount),
    pendingApprovalCount: pendingCount,
    approvedUnpaidAmount: formatMoney(approvedUnpaidAmount),
    approvedUnpaidCount: approvedUnpaidCount,
    paidAmount: formatMoney(paidAmount),
    paidCount: paidCount,
    byCategory,
    byBranch,
    byStatus,
  };
}

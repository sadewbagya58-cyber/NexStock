import type {
  CreateLeaveRequest,
  LeaveBalanceListResponse,
  LeaveBalanceResponse,
  LeaveRequestListResponse,
  LeaveRequestResponse,
  LeaveRequestStatus,
  LeaveType,
  ReviewLeaveRequest,
} from '@nexstock/contracts';
import { assertAuthorized } from '../../iam/index.js';
import {
  AppError,
  type TenantTransactionContext,
  appendAuditLog,
  generateUuidV7,
} from '../../shared/index.js';

export interface LeaveRequestRow {
  id: string;
  tenant_id: string;
  employee_id: string;
  employee_code?: string;
  employee_name?: string;
  leave_type: LeaveType;
  start_date: Date | string;
  end_date: Date | string;
  days_count: number | string;
  is_half_day: boolean;
  reason: string;
  status: LeaveRequestStatus;
  requested_by_user_id: string | null;
  reviewed_by_user_id: string | null;
  reviewed_at: Date | string | null;
  review_notes: string | null;
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

export function mapLeaveRequest(row: LeaveRequestRow): LeaveRequestResponse {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    employeeId: row.employee_id,
    ...(row.employee_code ? { employeeCode: row.employee_code } : {}),
    ...(row.employee_name ? { employeeName: row.employee_name } : {}),
    leaveType: row.leave_type,
    startDate: formatDateOnly(row.start_date),
    endDate: formatDateOnly(row.end_date),
    daysCount: Number(row.days_count),
    isHalfDay: Boolean(row.is_half_day),
    reason: row.reason,
    status: row.status,
    requestedByUserId: row.requested_by_user_id,
    reviewedByUserId: row.reviewed_by_user_id,
    reviewedAt: formatIso(row.reviewed_at),
    reviewNotes: row.review_notes,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

async function getLinkedEmployee(trx: TenantTransactionContext): Promise<{
  id: string;
  employee_code: string;
  display_name: string;
}> {
  const emp = await trx.db
    .selectFrom('employees')
    .select(['id', 'employee_code', 'display_name'])
    .where('tenant_id', '=', trx.tenantId)
    .where('linked_user_id', '=', trx.userId)
    .executeTakeFirst();

  if (!emp) {
    throw new AppError({
      statusCode: 403,
      errorCode: 'HRM_STAFF_ACCOUNT_NOT_LINKED',
      title: 'Staff Account Not Linked',
      detail: 'Your user account is not linked to any active employee profile.',
    });
  }

  return emp;
}

export async function createLeaveRequest(
  trx: TenantTransactionContext,
  input: CreateLeaveRequest,
): Promise<LeaveRequestResponse> {
  let targetEmployeeId = input.employeeId;
  let isDirectAdminEntry = false;

  const hasManage = await (async () => {
    try {
      await assertAuthorized(trx, { permission: 'hrm:leave:manage' });
      return true;
    } catch {
      return false;
    }
  })();

  if (hasManage && targetEmployeeId) {
    isDirectAdminEntry = true;
  } else {
    // Self-service
    await assertAuthorized(trx, { permission: 'hrm:leave:self' });
    const emp = await getLinkedEmployee(trx);
    if (targetEmployeeId && targetEmployeeId !== emp.id) {
      throw new AppError({
        statusCode: 403,
        errorCode: 'ERR_FORBIDDEN',
        title: 'Access Denied',
        detail: 'You are only authorized to request leave for yourself.',
      });
    }
    targetEmployeeId = emp.id;
  }

  const employee = await trx.db
    .selectFrom('employees')
    .select(['id', 'employee_code', 'display_name'])
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', targetEmployeeId)
    .executeTakeFirst();

  if (!employee) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'HRM_EMPLOYEE_NOT_FOUND',
      title: 'Employee Not Found',
      detail: `Employee "${targetEmployeeId}" was not found.`,
    });
  }

  if (input.startDate > input.endDate) {
    throw new AppError({
      statusCode: 400,
      errorCode: 'ERR_VALIDATION_FAILED',
      title: 'Invalid Date Range',
      detail: 'Leave start date cannot be after leave end date.',
    });
  }

  // Prevent overlapping active requests
  const overlap = await trx.db
    .selectFrom('employee_leave_requests')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('employee_id', '=', targetEmployeeId)
    .where('status', 'in', ['PENDING', 'APPROVED'])
    .where('start_date', '<=', input.endDate)
    .where('end_date', '>=', input.startDate)
    .executeTakeFirst();

  if (overlap) {
    throw new AppError({
      statusCode: 409,
      errorCode: 'HRM_LEAVE_OVERLAP',
      title: 'Overlapping Leave Request',
      detail: `An existing ${overlap.status.toLowerCase()} leave request already covers dates between ${formatDateOnly(overlap.start_date)} and ${formatDateOnly(overlap.end_date)}.`,
    });
  }

  const requestId = generateUuidV7();
  const status: LeaveRequestStatus = isDirectAdminEntry ? 'APPROVED' : 'PENDING';
  const now = new Date();

  await trx.db
    .insertInto('employee_leave_requests')
    .values({
      id: requestId,
      tenant_id: trx.tenantId,
      employee_id: targetEmployeeId,
      leave_type: input.leaveType,
      start_date: input.startDate,
      end_date: input.endDate,
      days_count: input.daysCount,
      is_half_day: input.isHalfDay ?? false,
      reason: input.reason.trim(),
      status,
      requested_by_user_id: trx.userId,
      reviewed_by_user_id: isDirectAdminEntry ? trx.userId : null,
      reviewed_at: isDirectAdminEntry ? now : null,
      review_notes: isDirectAdminEntry ? 'Direct manager entry' : null,
    })
    .execute();

  // If directly approved by admin/manager, deduct balance and sync attendance
  if (isDirectAdminEntry && input.leaveType !== 'NO_PAY') {
    const year = new Date(input.startDate).getFullYear();
    await deductLeaveBalance(trx, targetEmployeeId, year, input.leaveType, input.daysCount);
    await syncAttendanceForLeave(trx, targetEmployeeId, input.startDate, input.endDate, input.leaveType);
  }

  await appendAuditLog(trx, {
    action: 'hrm.leave.requested',
    resourceType: 'employee_leave_request',
    resourceId: requestId,
    metadata: {
      employeeId: targetEmployeeId,
      leaveType: input.leaveType,
      startDate: input.startDate,
      endDate: input.endDate,
      daysCount: input.daysCount,
      status,
    },
  });

  const row = await trx.db
    .selectFrom('employee_leave_requests')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', requestId)
    .executeTakeFirstOrThrow();

  return mapLeaveRequest({
    ...(row as unknown as LeaveRequestRow),
    employee_code: employee.employee_code,
    employee_name: employee.display_name,
  });
}

export async function reviewLeaveRequest(
  trx: TenantTransactionContext,
  requestId: string,
  input: ReviewLeaveRequest,
): Promise<LeaveRequestResponse> {
  await assertAuthorized(trx, { permission: 'hrm:leave:approve' });

  const existing = await trx.db
    .selectFrom('employee_leave_requests')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', requestId)
    .executeTakeFirst();

  if (!existing) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'HRM_LEAVE_NOT_FOUND',
      title: 'Leave Request Not Found',
      detail: `Leave request "${requestId}" was not found.`,
    });
  }

  if (existing.status !== 'PENDING') {
    throw new AppError({
      statusCode: 400,
      errorCode: 'HRM_LEAVE_ALREADY_REVIEWED',
      title: 'Already Reviewed',
      detail: `This leave request is already ${existing.status.toLowerCase()}.`,
    });
  }

  // Prevent user from approving their own leave request
  const requesterEmployee = await trx.db
    .selectFrom('employees')
    .select(['id', 'linked_user_id'])
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', existing.employee_id)
    .executeTakeFirst();

  if (requesterEmployee?.linked_user_id === trx.userId) {
    throw new AppError({
      statusCode: 403,
      errorCode: 'HRM_CANNOT_APPROVE_OWN_LEAVE',
      title: 'Self-Approval Forbidden',
      detail: 'You are not authorized to approve your own leave requests.',
    });
  }

  const now = new Date();
  await trx.db
    .updateTable('employee_leave_requests')
    .set({
      status: input.status,
      reviewed_by_user_id: trx.userId,
      reviewed_at: now,
      review_notes: input.reviewNotes?.trim() || null,
      updated_at: now,
    })
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', requestId)
    .execute();

  // If approved, reduce balance and sync attendance
  if (input.status === 'APPROVED') {
    if (existing.leave_type !== 'NO_PAY') {
      const year = new Date(existing.start_date).getFullYear();
      await deductLeaveBalance(
        trx,
        existing.employee_id,
        year,
        existing.leave_type,
        Number(existing.days_count),
      );
    }
    await syncAttendanceForLeave(
      trx,
      existing.employee_id,
      formatDateOnly(existing.start_date),
      formatDateOnly(existing.end_date),
      existing.leave_type,
    );
  }

  await appendAuditLog(trx, {
    action: `hrm.leave.${input.status.toLowerCase()}`,
    resourceType: 'employee_leave_request',
    resourceId: requestId,
    metadata: {
      employeeId: existing.employee_id,
      status: input.status,
      reviewedByUserId: trx.userId,
      reviewNotes: input.reviewNotes,
    },
  });

  const updated = await trx.db
    .selectFrom('employee_leave_requests')
    .innerJoin('employees', 'employees.id', 'employee_leave_requests.employee_id')
    .select([
      'employee_leave_requests.id',
      'employee_leave_requests.tenant_id',
      'employee_leave_requests.employee_id',
      'employees.employee_code',
      'employees.display_name as employee_name',
      'employee_leave_requests.leave_type',
      'employee_leave_requests.start_date',
      'employee_leave_requests.end_date',
      'employee_leave_requests.days_count',
      'employee_leave_requests.is_half_day',
      'employee_leave_requests.reason',
      'employee_leave_requests.status',
      'employee_leave_requests.requested_by_user_id',
      'employee_leave_requests.reviewed_by_user_id',
      'employee_leave_requests.reviewed_at',
      'employee_leave_requests.review_notes',
      'employee_leave_requests.created_at',
      'employee_leave_requests.updated_at',
    ])
    .where('employee_leave_requests.tenant_id', '=', trx.tenantId)
    .where('employee_leave_requests.id', '=', requestId)
    .executeTakeFirstOrThrow();

  return mapLeaveRequest(updated as unknown as LeaveRequestRow);
}

async function deductLeaveBalance(
  trx: TenantTransactionContext,
  employeeId: string,
  year: number,
  leaveType: LeaveType,
  days: number,
): Promise<void> {
  const existingBalance = await trx.db
    .selectFrom('employee_leave_balances')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('employee_id', '=', employeeId)
    .where('year', '=', year)
    .where('leave_type', '=', leaveType)
    .executeTakeFirst();

  if (existingBalance) {
    const newUsed = Number(existingBalance.used_days) + days;
    await trx.db
      .updateTable('employee_leave_balances')
      .set({
        used_days: newUsed,
        updated_at: new Date(),
      })
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', existingBalance.id)
      .execute();
  } else {
    const entitlement = leaveType === 'ANNUAL' ? 14 : leaveType === 'CASUAL' ? 7 : leaveType === 'SICK' ? 7 : 5;
    await trx.db
      .insertInto('employee_leave_balances')
      .values({
        id: generateUuidV7(),
        tenant_id: trx.tenantId,
        employee_id: employeeId,
        year,
        leave_type: leaveType,
        annual_entitlement: entitlement,
        used_days: days,
        pending_days: 0,
      })
      .execute();
  }
}

async function syncAttendanceForLeave(
  trx: TenantTransactionContext,
  employeeId: string,
  startDateStr: string,
  endDateStr: string,
  leaveType: LeaveType,
): Promise<void> {
  const start = new Date(startDateStr);
  const end = new Date(endDateStr);
  const status = leaveType === 'NO_PAY' ? 'NO_PAY_LEAVE' : 'PAID_LEAVE';

  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const curStr = d.toISOString().substring(0, 10);
    const existing = await trx.db
      .selectFrom('employee_attendance')
      .select(['id', 'status'])
      .where('tenant_id', '=', trx.tenantId)
      .where('employee_id', '=', employeeId)
      .where('attendance_date', '=', curStr)
      .executeTakeFirst();

    if (existing) {
      await trx.db
        .updateTable('employee_attendance')
        .set({
          status,
          notes: `Approved leave: ${leaveType}`,
          updated_at: new Date(),
        })
        .where('tenant_id', '=', trx.tenantId)
        .where('id', '=', existing.id)
        .execute();
    } else {
      await trx.db
        .insertInto('employee_attendance')
        .values({
          id: generateUuidV7(),
          tenant_id: trx.tenantId,
          employee_id: employeeId,
          attendance_date: curStr,
          status,
          notes: `Approved leave: ${leaveType}`,
          is_manual: false,
        })
        .execute();
    }
  }
}

export async function getLeaveBalances(
  trx: TenantTransactionContext,
  employeeId: string,
  year?: number,
): Promise<LeaveBalanceListResponse> {
  // If user only has self, ensure employeeId matches
  const hasManageOrRead = await (async () => {
    try {
      await assertAuthorized(trx, { permission: 'hrm:leave:read' });
      return true;
    } catch {
      return false;
    }
  })();

  if (!hasManageOrRead) {
    await assertAuthorized(trx, { permission: 'hrm:leave:self' });
    const emp = await getLinkedEmployee(trx);
    if (emp.id !== employeeId) {
      throw new AppError({
        statusCode: 403,
        errorCode: 'HRM_UNAUTHORIZED_EMPLOYEE_ACCESS',
        title: 'Access Denied',
        detail: 'You are only authorized to view your own leave balances.',
      });
    }
  }

  const targetYear = year || new Date().getFullYear();
  const leaveTypes: LeaveType[] = ['ANNUAL', 'CASUAL', 'SICK', 'NO_PAY', 'SPECIAL'];

  const existingRows = await trx.db
    .selectFrom('employee_leave_balances')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('employee_id', '=', employeeId)
    .where('year', '=', targetYear)
    .execute();

  const balanceMap = new Map(existingRows.map((r) => [r.leave_type, r]));
  const items: LeaveBalanceResponse[] = [];

  for (const lt of leaveTypes) {
    const found = balanceMap.get(lt);
    const entitlement = found
      ? Number(found.annual_entitlement)
      : lt === 'ANNUAL'
        ? 14
        : lt === 'CASUAL'
          ? 7
          : lt === 'SICK'
            ? 7
            : 0;
    const used = found ? Number(found.used_days) : 0;
    const pending = found ? Number(found.pending_days) : 0;
    const remaining = Math.max(0, entitlement - used);

    items.push({
      id: found?.id || generateUuidV7(),
      tenantId: trx.tenantId,
      employeeId,
      year: targetYear,
      leaveType: lt,
      annualEntitlement: entitlement,
      usedDays: used,
      pendingDays: pending,
      remainingDays: remaining,
    });
  }

  return { items };
}

export async function listLeaveRequests(
  trx: TenantTransactionContext,
  query: {
    employeeId?: string | undefined;
    status?: LeaveRequestStatus | undefined;
    year?: number | undefined;
  },
): Promise<LeaveRequestListResponse> {
  let targetEmployeeId = query.employeeId;
  const hasManageOrRead = await (async () => {
    try {
      await assertAuthorized(trx, { permission: 'hrm:leave:read' });
      return true;
    } catch {
      return false;
    }
  })();

  if (!hasManageOrRead) {
    await assertAuthorized(trx, { permission: 'hrm:leave:self' });
    const emp = await getLinkedEmployee(trx);
    targetEmployeeId = emp.id;
  }

  let dbQuery = trx.db
    .selectFrom('employee_leave_requests')
    .innerJoin('employees', 'employees.id', 'employee_leave_requests.employee_id')
    .select([
      'employee_leave_requests.id',
      'employee_leave_requests.tenant_id',
      'employee_leave_requests.employee_id',
      'employees.employee_code',
      'employees.display_name as employee_name',
      'employee_leave_requests.leave_type',
      'employee_leave_requests.start_date',
      'employee_leave_requests.end_date',
      'employee_leave_requests.days_count',
      'employee_leave_requests.is_half_day',
      'employee_leave_requests.reason',
      'employee_leave_requests.status',
      'employee_leave_requests.requested_by_user_id',
      'employee_leave_requests.reviewed_by_user_id',
      'employee_leave_requests.reviewed_at',
      'employee_leave_requests.review_notes',
      'employee_leave_requests.created_at',
      'employee_leave_requests.updated_at',
    ])
    .where('employee_leave_requests.tenant_id', '=', trx.tenantId);

  if (targetEmployeeId) {
    dbQuery = dbQuery.where('employee_leave_requests.employee_id', '=', targetEmployeeId);
  }
  if (query.status) {
    dbQuery = dbQuery.where('employee_leave_requests.status', '=', query.status);
  }
  if (query.year) {
    const yearStart = `${query.year}-01-01`;
    const yearEnd = `${query.year}-12-31`;
    dbQuery = dbQuery
      .where('employee_leave_requests.start_date', '<=', yearEnd)
      .where('employee_leave_requests.end_date', '>=', yearStart);
  }

  const rows = await dbQuery
    .orderBy('employee_leave_requests.created_at', 'desc')
    .execute();

  return {
    items: rows.map((r) => mapLeaveRequest(r as unknown as LeaveRequestRow)),
    total: rows.length,
  };
}

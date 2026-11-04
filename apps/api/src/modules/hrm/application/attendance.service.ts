import type {
  AttendanceListResponse,
  AttendanceRecordResponse,
  AttendanceStatus,
  CheckInRequest,
  CheckOutRequest,
  RecordManualAttendanceRequest,
} from '@nexstock/contracts';
import { assertAuthorized } from '../../iam/index.js';
import {
  AppError,
  type TenantTransactionContext,
  appendAuditLog,
  generateUuidV7,
} from '../../shared/index.js';

export interface AttendanceRow {
  id: string;
  tenant_id: string;
  employee_id: string;
  employee_code?: string;
  employee_name?: string;
  attendance_date: Date | string;
  check_in_time: Date | string | null;
  check_out_time: Date | string | null;
  status: AttendanceStatus;
  latitude: number | string | null;
  longitude: number | string | null;
  gps_verified: boolean;
  notes: string | null;
  is_manual: boolean;
  adjustment_reason: string | null;
  adjusted_by_user_id: string | null;
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

export function mapAttendanceRecord(row: AttendanceRow): AttendanceRecordResponse {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    employeeId: row.employee_id,
    ...(row.employee_code ? { employeeCode: row.employee_code } : {}),
    ...(row.employee_name ? { employeeName: row.employee_name } : {}),
    attendanceDate: formatDateOnly(row.attendance_date),
    checkInTime: formatIso(row.check_in_time),
    checkOutTime: formatIso(row.check_out_time),
    status: row.status,
    latitude: row.latitude != null ? Number(row.latitude) : null,
    longitude: row.longitude != null ? Number(row.longitude) : null,
    gpsVerified: Boolean(row.gps_verified),
    notes: row.notes,
    isManual: Boolean(row.is_manual),
    adjustmentReason: row.adjustment_reason,
    adjustedByUserId: row.adjusted_by_user_id,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function calculateDistanceMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const R = 6371e3; // Earth radius in meters
  const phi1 = (lat1 * Math.PI) / 180;
  const phi2 = (lat2 * Math.PI) / 180;
  const deltaPhi = ((lat2 - lat1) * Math.PI) / 180;
  const deltaLambda = ((lon2 - lon1) * Math.PI) / 180;

  const a =
    Math.sin(deltaPhi / 2) * Math.sin(deltaPhi / 2) +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(deltaLambda / 2) * Math.sin(deltaLambda / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
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

export async function checkIn(
  trx: TenantTransactionContext,
  input: CheckInRequest,
): Promise<AttendanceRecordResponse> {
  await assertAuthorized(trx, { permission: 'hrm:attendance:self' });

  const emp = await getLinkedEmployee(trx);
  const now = new Date();
  const todayStr = now.toISOString().substring(0, 10);

  // Check organization settings for GPS requirements
  const settings = await trx.db
    .selectFrom('org_payroll_settings')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .executeTakeFirst();

  let gpsVerified = false;
  if (settings?.gps_attendance_enabled) {
    if (input.latitude == null || input.longitude == null) {
      throw new AppError({
        statusCode: 400,
        errorCode: 'HRM_GPS_REQUIRED',
        title: 'Location Required',
        detail: 'GPS location verification is required by your organization for attendance check-in.',
      });
    }

    if (settings.workplace_latitude != null && settings.workplace_longitude != null) {
      const distance = calculateDistanceMeters(
        input.latitude,
        input.longitude,
        Number(settings.workplace_latitude),
        Number(settings.workplace_longitude),
      );
      gpsVerified = distance <= (settings.geofence_radius_meters || 500);
      if (!gpsVerified) {
        throw new AppError({
          statusCode: 400,
          errorCode: 'HRM_GEOFENCE_FAILED',
          title: 'Outside Workplace Boundary',
          detail: `Your current location is outside the authorized workplace radius (${Math.round(distance)}m away).`,
        });
      }
    } else {
      gpsVerified = true;
    }
  }

  // Check for duplicate check-in
  const existing = await trx.db
    .selectFrom('employee_attendance')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('employee_id', '=', emp.id)
    .where('attendance_date', '=', todayStr)
    .executeTakeFirst();

  if (existing && existing.check_in_time) {
    throw new AppError({
      statusCode: 409,
      errorCode: 'HRM_ALREADY_CHECKED_IN',
      title: 'Already Checked In',
      detail: `You have already checked in for today (${todayStr}) at ${new Date(existing.check_in_time).toLocaleTimeString()}.`,
    });
  }

  // Determine initial status (PRESENT vs LATE) based on work schedule
  let status: AttendanceStatus = 'PRESENT';
  const schedule = await trx.db
    .selectFrom('employee_work_schedules')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('employee_id', '=', emp.id)
    .where('is_active', '=', true)
    .where('effective_from', '<=', todayStr)
    .where((eb) =>
      eb.or([
        eb('effective_to', 'is', null),
        eb('effective_to', '>=', todayStr),
      ]),
    )
    .orderBy('effective_from', 'desc')
    .executeTakeFirst();

  if (schedule?.shift_start_time) {
    const [startH, startM] = schedule.shift_start_time.split(':').map(Number);
    const nowH = now.getUTCHours();
    const nowM = now.getUTCMinutes();
    const shiftMinutes = (startH || 9) * 60 + (startM || 0);
    const currentMinutes = nowH * 60 + nowM;
    // Grace period of 15 minutes
    if (currentMinutes > shiftMinutes + 15) {
      status = 'LATE';
    }
  }

  let recordId: string;
  if (existing) {
    recordId = existing.id;
    await trx.db
      .updateTable('employee_attendance')
      .set({
        check_in_time: now,
        status,
        latitude: input.latitude ?? null,
        longitude: input.longitude ?? null,
        gps_verified: gpsVerified,
        notes: input.notes?.trim() || existing.notes,
        updated_at: now,
      })
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', existing.id)
      .execute();
  } else {
    recordId = generateUuidV7();
    await trx.db
      .insertInto('employee_attendance')
      .values({
        id: recordId,
        tenant_id: trx.tenantId,
        employee_id: emp.id,
        attendance_date: todayStr,
        check_in_time: now,
        status,
        latitude: input.latitude ?? null,
        longitude: input.longitude ?? null,
        gps_verified: gpsVerified,
        notes: input.notes?.trim() || null,
        is_manual: false,
      })
      .execute();
  }

  await appendAuditLog(trx, {
    action: 'hrm.attendance.check_in',
    resourceType: 'employee_attendance',
    resourceId: recordId,
    metadata: {
      employeeId: emp.id,
      employeeCode: emp.employee_code,
      attendanceDate: todayStr,
      checkInTime: now.toISOString(),
      status,
      gpsVerified,
    },
  });

  const record = await trx.db
    .selectFrom('employee_attendance')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', recordId)
    .executeTakeFirstOrThrow();

  return mapAttendanceRecord({
    ...(record as unknown as AttendanceRow),
    employee_code: emp.employee_code,
    employee_name: emp.display_name,
  });
}

export async function checkOut(
  trx: TenantTransactionContext,
  input: CheckOutRequest,
): Promise<AttendanceRecordResponse> {
  await assertAuthorized(trx, { permission: 'hrm:attendance:self' });

  const emp = await getLinkedEmployee(trx);
  const now = new Date();
  const todayStr = now.toISOString().substring(0, 10);

  const existing = await trx.db
    .selectFrom('employee_attendance')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('employee_id', '=', emp.id)
    .where('attendance_date', '=', todayStr)
    .executeTakeFirst();

  if (!existing || !existing.check_in_time) {
    throw new AppError({
      statusCode: 400,
      errorCode: 'HRM_CHECK_IN_REQUIRED',
      title: 'Check-In Required First',
      detail: 'You must check in before checking out for today.',
    });
  }

  if (existing.check_out_time) {
    throw new AppError({
      statusCode: 409,
      errorCode: 'HRM_ALREADY_CHECKED_OUT',
      title: 'Already Checked Out',
      detail: `You have already checked out for today at ${new Date(existing.check_out_time).toLocaleTimeString()}.`,
    });
  }

  // Calculate duration between check-in and check-out
  const checkInDate = new Date(existing.check_in_time);
  const workedMs = now.getTime() - checkInDate.getTime();
  const workedHours = workedMs / (1000 * 60 * 60);

  let newStatus = existing.status;
  if (workedHours > 0 && workedHours < 4 && existing.status !== 'PAID_LEAVE') {
    newStatus = 'HALF_DAY';
  }

  await trx.db
    .updateTable('employee_attendance')
    .set({
      check_out_time: now,
      status: newStatus,
      updated_at: now,
      notes: input.notes?.trim() ? `${existing.notes || ''} [Checkout: ${input.notes.trim()}]`.trim() : existing.notes,
    })
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', existing.id)
    .execute();

  await appendAuditLog(trx, {
    action: 'hrm.attendance.check_out',
    resourceType: 'employee_attendance',
    resourceId: existing.id,
    metadata: {
      employeeId: emp.id,
      employeeCode: emp.employee_code,
      attendanceDate: todayStr,
      checkOutTime: now.toISOString(),
      workedHours: Number(workedHours.toFixed(2)),
      status: newStatus,
    },
  });

  const updated = await trx.db
    .selectFrom('employee_attendance')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', existing.id)
    .executeTakeFirstOrThrow();

  return mapAttendanceRecord({
    ...(updated as unknown as AttendanceRow),
    employee_code: emp.employee_code,
    employee_name: emp.display_name,
  });
}

export async function recordManualAttendance(
  trx: TenantTransactionContext,
  input: RecordManualAttendanceRequest,
): Promise<AttendanceRecordResponse> {
  await assertAuthorized(trx, { permission: 'hrm:attendance:manage' });

  if (!input.adjustmentReason || !input.adjustmentReason.trim()) {
    throw new AppError({
      statusCode: 400,
      errorCode: 'HRM_REASON_REQUIRED',
      title: 'Audit Reason Required',
      detail: 'An audit reason is strictly required when manually recording or correcting attendance.',
    });
  }

  const employee = await trx.db
    .selectFrom('employees')
    .select(['id', 'employee_code', 'display_name'])
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', input.employeeId)
    .executeTakeFirst();

  if (!employee) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'HRM_EMPLOYEE_NOT_FOUND',
      title: 'Employee Not Found',
      detail: `Employee "${input.employeeId}" was not found.`,
    });
  }

  const existing = await trx.db
    .selectFrom('employee_attendance')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('employee_id', '=', input.employeeId)
    .where('attendance_date', '=', input.attendanceDate)
    .executeTakeFirst();

  const now = new Date();
  let recordId: string;

  if (existing) {
    recordId = existing.id;
    await trx.db
      .updateTable('employee_attendance')
      .set({
        check_in_time: input.checkInTime ? new Date(input.checkInTime) : existing.check_in_time,
        check_out_time: input.checkOutTime ? new Date(input.checkOutTime) : existing.check_out_time,
        status: input.status,
        is_manual: true,
        adjustment_reason: input.adjustmentReason.trim(),
        adjusted_by_user_id: trx.userId,
        notes: input.notes?.trim() || existing.notes,
        updated_at: now,
      })
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', existing.id)
      .execute();
  } else {
    recordId = generateUuidV7();
    await trx.db
      .insertInto('employee_attendance')
      .values({
        id: recordId,
        tenant_id: trx.tenantId,
        employee_id: input.employeeId,
        attendance_date: input.attendanceDate,
        check_in_time: input.checkInTime ? new Date(input.checkInTime) : null,
        check_out_time: input.checkOutTime ? new Date(input.checkOutTime) : null,
        status: input.status,
        is_manual: true,
        adjustment_reason: input.adjustmentReason.trim(),
        adjusted_by_user_id: trx.userId,
        notes: input.notes?.trim() || null,
        gps_verified: false,
      })
      .execute();
  }

  await appendAuditLog(trx, {
    action: 'hrm.attendance.manual_adjustment',
    resourceType: 'employee_attendance',
    resourceId: recordId,
    metadata: {
      employeeId: input.employeeId,
      attendanceDate: input.attendanceDate,
      status: input.status,
      adjustmentReason: input.adjustmentReason,
      adjustedByUserId: trx.userId,
    },
  });

  const saved = await trx.db
    .selectFrom('employee_attendance')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', recordId)
    .executeTakeFirstOrThrow();

  return mapAttendanceRecord({
    ...(saved as unknown as AttendanceRow),
    employee_code: employee.employee_code,
    employee_name: employee.display_name,
  });
}

export async function listAttendance(
  trx: TenantTransactionContext,
  query: {
    employeeId?: string | undefined;
    startDate?: string | undefined;
    endDate?: string | undefined;
    date?: string | undefined;
    status?: AttendanceStatus | undefined;
  },
): Promise<AttendanceListResponse> {
  // Check permission: if user only has hrm:attendance:self, restrict to self
  let targetEmployeeId = query.employeeId;
  const hasManageOrRead = await (async () => {
    try {
      await assertAuthorized(trx, { permission: 'hrm:attendance:read' });
      return true;
    } catch {
      return false;
    }
  })();

  if (!hasManageOrRead) {
    await assertAuthorized(trx, { permission: 'hrm:attendance:self' });
    const emp = await getLinkedEmployee(trx);
    targetEmployeeId = emp.id;
  }

  let dbQuery = trx.db
    .selectFrom('employee_attendance')
    .innerJoin('employees', 'employees.id', 'employee_attendance.employee_id')
    .select([
      'employee_attendance.id',
      'employee_attendance.tenant_id',
      'employee_attendance.employee_id',
      'employees.employee_code',
      'employees.display_name as employee_name',
      'employee_attendance.attendance_date',
      'employee_attendance.check_in_time',
      'employee_attendance.check_out_time',
      'employee_attendance.status',
      'employee_attendance.latitude',
      'employee_attendance.longitude',
      'employee_attendance.gps_verified',
      'employee_attendance.notes',
      'employee_attendance.is_manual',
      'employee_attendance.adjustment_reason',
      'employee_attendance.adjusted_by_user_id',
      'employee_attendance.created_at',
      'employee_attendance.updated_at',
    ])
    .where('employee_attendance.tenant_id', '=', trx.tenantId);

  if (targetEmployeeId) {
    dbQuery = dbQuery.where('employee_attendance.employee_id', '=', targetEmployeeId);
  }
  if (query.date) {
    dbQuery = dbQuery.where('employee_attendance.attendance_date', '=', query.date);
  }
  if (query.startDate) {
    dbQuery = dbQuery.where('employee_attendance.attendance_date', '>=', query.startDate);
  }
  if (query.endDate) {
    dbQuery = dbQuery.where('employee_attendance.attendance_date', '<=', query.endDate);
  }
  if (query.status) {
    dbQuery = dbQuery.where('employee_attendance.status', '=', query.status);
  }

  const rows = await dbQuery
    .orderBy('employee_attendance.attendance_date', 'desc')
    .orderBy('employees.employee_code', 'asc')
    .execute();

  return {
    items: rows.map((r) => mapAttendanceRecord(r as unknown as AttendanceRow)),
    total: rows.length,
  };
}

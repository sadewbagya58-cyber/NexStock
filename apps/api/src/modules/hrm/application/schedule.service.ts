import type {
  CreateWorkScheduleRequest,
  WorkScheduleResponse,
} from '@nexstock/contracts';
import { assertAuthorized } from '../../iam/index.js';
import {
  AppError,
  type TenantTransactionContext,
  appendAuditLog,
  generateUuidV7,
} from '../../shared/index.js';

export interface WorkScheduleRow {
  id: string;
  tenant_id: string;
  employee_id: string;
  shift_name: string;
  shift_type: 'DAY' | 'NIGHT' | 'ROTATING';
  shift_start_time: string;
  shift_end_time: string;
  break_duration_minutes: number;
  monday_working: boolean;
  tuesday_working: boolean;
  wednesday_working: boolean;
  thursday_working: boolean;
  friday_working: boolean;
  saturday_working: boolean;
  sunday_working: boolean;
  effective_from: Date | string;
  effective_to: Date | string | null;
  is_active: boolean;
  notes: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

function formatDateOnly(d: Date | string | null): string | null {
  if (!d) return null;
  if (typeof d === 'string') return d.substring(0, 10);
  return d.toISOString().substring(0, 10);
}

export function mapWorkSchedule(row: WorkScheduleRow): WorkScheduleResponse {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    employeeId: row.employee_id,
    shiftName: row.shift_name,
    shiftType: row.shift_type,
    shiftStartTime: row.shift_start_time,
    shiftEndTime: row.shift_end_time,
    breakDurationMinutes: Number(row.break_duration_minutes),
    mondayWorking: Boolean(row.monday_working),
    tuesdayWorking: Boolean(row.tuesday_working),
    wednesdayWorking: Boolean(row.wednesday_working),
    thursdayWorking: Boolean(row.thursday_working),
    fridayWorking: Boolean(row.friday_working),
    saturdayWorking: Boolean(row.saturday_working),
    sundayWorking: Boolean(row.sunday_working),
    effectiveFrom: formatDateOnly(row.effective_from) ?? '',
    effectiveTo: formatDateOnly(row.effective_to),
    isActive: Boolean(row.is_active),
    notes: row.notes,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export async function createWorkSchedule(
  trx: TenantTransactionContext,
  employeeId: string,
  input: CreateWorkScheduleRequest,
): Promise<WorkScheduleResponse> {
  await assertAuthorized(trx, { permission: 'hrm:schedule:manage' });

  const employee = await trx.db
    .selectFrom('employees')
    .select(['id', 'employee_code'])
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', employeeId)
    .executeTakeFirst();

  if (!employee) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'HRM_EMPLOYEE_NOT_FOUND',
      title: 'Employee Not Found',
      detail: `Employee "${employeeId}" was not found.`,
    });
  }

  // Deactivate prior active schedules that overlap or set effective_to
  const priorSchedules = await trx.db
    .selectFrom('employee_work_schedules')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('employee_id', '=', employeeId)
    .where('is_active', '=', true)
    .execute();

  for (const prev of priorSchedules) {
    if (!prev.effective_to) {
      // Set effective_to to day before new effective_from
      const newFrom = new Date(input.effectiveFrom);
      const dayBefore = new Date(newFrom);
      dayBefore.setDate(dayBefore.getDate() - 1);
      const dayBeforeStr = dayBefore.toISOString().substring(0, 10);

      await trx.db
        .updateTable('employee_work_schedules')
        .set({
          effective_to: dayBeforeStr,
          is_active: false,
          updated_at: new Date(),
        })
        .where('tenant_id', '=', trx.tenantId)
        .where('id', '=', prev.id)
        .execute();
    }
  }

  const scheduleId = generateUuidV7();
  await trx.db
    .insertInto('employee_work_schedules')
    .values({
      id: scheduleId,
      tenant_id: trx.tenantId,
      employee_id: employeeId,
      shift_name: input.shiftName?.trim() || 'General Shift',
      shift_type: input.shiftType ?? 'DAY',
      shift_start_time: input.shiftStartTime || '09:00',
      shift_end_time: input.shiftEndTime || '17:00',
      break_duration_minutes: input.breakDurationMinutes ?? 60,
      monday_working: input.mondayWorking ?? true,
      tuesday_working: input.tuesdayWorking ?? true,
      wednesday_working: input.wednesdayWorking ?? true,
      thursday_working: input.thursdayWorking ?? true,
      friday_working: input.fridayWorking ?? true,
      saturday_working: input.saturdayWorking ?? false,
      sunday_working: input.sundayWorking ?? false,
      effective_from: input.effectiveFrom,
      effective_to: input.effectiveTo || null,
      is_active: true,
      notes: input.notes?.trim() || null,
    })
    .execute();

  await appendAuditLog(trx, {
    action: 'hrm.schedule.created',
    resourceType: 'employee_work_schedule',
    resourceId: scheduleId,
    metadata: {
      employeeId,
      effectiveFrom: input.effectiveFrom,
      shiftName: input.shiftName || 'General Shift',
    },
  });

  const created = await trx.db
    .selectFrom('employee_work_schedules')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', scheduleId)
    .executeTakeFirstOrThrow();

  return mapWorkSchedule(created as unknown as WorkScheduleRow);
}

export async function getActiveWorkSchedule(
  trx: TenantTransactionContext,
  employeeId: string,
  forDate?: string,
): Promise<WorkScheduleResponse | null> {
  await assertAuthorized(trx, { permission: 'hrm:schedule:read' });

  const queryDate = forDate || new Date().toISOString().substring(0, 10);

  const row = await trx.db
    .selectFrom('employee_work_schedules')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('employee_id', '=', employeeId)
    .where('effective_from', '<=', queryDate)
    .where((eb) =>
      eb.or([
        eb('effective_to', 'is', null),
        eb('effective_to', '>=', queryDate),
      ]),
    )
    .orderBy('effective_from', 'desc')
    .executeTakeFirst();

  if (row) {
    return mapWorkSchedule(row as unknown as WorkScheduleRow);
  }

  return null;
}

export async function listWorkSchedules(
  trx: TenantTransactionContext,
  employeeId: string,
): Promise<WorkScheduleResponse[]> {
  await assertAuthorized(trx, { permission: 'hrm:schedule:read' });

  const rows = await trx.db
    .selectFrom('employee_work_schedules')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('employee_id', '=', employeeId)
    .orderBy('effective_from', 'desc')
    .execute();

  return rows.map((r) => mapWorkSchedule(r as unknown as WorkScheduleRow));
}

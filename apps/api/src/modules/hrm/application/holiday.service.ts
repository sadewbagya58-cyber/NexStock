import type {
  CreateOrgHolidayRequest,
  HolidayType,
  OrgHolidayListResponse,
  OrgHolidayResponse,
} from '@nexstock/contracts';
import { assertAuthorized } from '../../iam/index.js';
import {
  AppError,
  type TenantTransactionContext,
  appendAuditLog,
  generateUuidV7,
} from '../../shared/index.js';

export interface HolidayRow {
  id: string;
  tenant_id: string;
  holiday_date: Date | string;
  name: string;
  holiday_type: HolidayType;
  is_recurring: boolean;
  notes: string | null;
  created_at: Date | string;
}

function formatDateOnly(d: Date | string | null): string {
  if (!d) return '';
  if (typeof d === 'string') return d.substring(0, 10);
  return d.toISOString().substring(0, 10);
}

export function mapHoliday(row: HolidayRow): OrgHolidayResponse {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    holidayDate: formatDateOnly(row.holiday_date),
    name: row.name,
    holidayType: row.holiday_type,
    isRecurring: Boolean(row.is_recurring),
    notes: row.notes,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

export async function createOrgHoliday(
  trx: TenantTransactionContext,
  input: CreateOrgHolidayRequest,
): Promise<OrgHolidayResponse> {
  await assertAuthorized(trx, { permission: 'hrm:holiday:manage' });

  const holidayName = (input.name || input.holidayName || '').trim();
  if (!holidayName) {
    throw new AppError({
      statusCode: 400,
      errorCode: 'ERR_VALIDATION_FAILED',
      title: 'Validation Error',
      detail: 'Holiday name is required and cannot be blank.',
    });
  }

  const existing = await trx.db
    .selectFrom('org_holidays')
    .select(['id'])
    .where('tenant_id', '=', trx.tenantId)
    .where('holiday_date', '=', input.holidayDate)
    .executeTakeFirst();

  if (existing) {
    throw new AppError({
      statusCode: 409,
      errorCode: 'HRM_HOLIDAY_EXISTS',
      title: 'Holiday Already Exists',
      detail: `A holiday is already scheduled for date ${input.holidayDate}.`,
    });
  }

  const holidayId = generateUuidV7();
  await trx.db
    .insertInto('org_holidays')
    .values({
      id: holidayId,
      tenant_id: trx.tenantId,
      holiday_date: input.holidayDate,
      name: holidayName,
      holiday_type: input.holidayType ?? 'PUBLIC',
      is_recurring: input.isRecurring ?? false,
      notes: input.notes?.trim() || null,
    })
    .execute();

  await appendAuditLog(trx, {
    action: 'hrm.holiday.created',
    resourceType: 'org_holiday',
    resourceId: holidayId,
    metadata: {
      holidayDate: input.holidayDate,
      name: holidayName,
      holidayType: input.holidayType ?? 'PUBLIC',
    },
  });

  const row = await trx.db
    .selectFrom('org_holidays')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', holidayId)
    .executeTakeFirstOrThrow();

  return mapHoliday(row as unknown as HolidayRow);
}

export async function listOrgHolidays(
  trx: TenantTransactionContext,
  query?: { year?: number | undefined },
): Promise<OrgHolidayListResponse> {
  await assertAuthorized(trx, { permission: 'hrm:holiday:read' });

  let dbQuery = trx.db
    .selectFrom('org_holidays')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId);

  if (query?.year) {
    const yStart = `${query.year}-01-01`;
    const yEnd = `${query.year}-12-31`;
    dbQuery = dbQuery.where((eb) =>
      eb.or([
        eb.and([
          eb('holiday_date', '>=', yStart),
          eb('holiday_date', '<=', yEnd),
        ]),
        eb('is_recurring', '=', true),
      ]),
    );
  }

  const rows = await dbQuery.orderBy('holiday_date', 'asc').execute();

  return {
    items: rows.map((r) => mapHoliday(r as unknown as HolidayRow)),
  };
}

export async function deleteOrgHoliday(
  trx: TenantTransactionContext,
  holidayId: string,
): Promise<{ success: boolean }> {
  await assertAuthorized(trx, { permission: 'hrm:holiday:manage' });

  const existing = await trx.db
    .selectFrom('org_holidays')
    .select(['id', 'name', 'holiday_date'])
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', holidayId)
    .executeTakeFirst();

  if (!existing) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'HRM_HOLIDAY_NOT_FOUND',
      title: 'Holiday Not Found',
      detail: `Holiday "${holidayId}" was not found.`,
    });
  }

  await trx.db
    .deleteFrom('org_holidays')
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', holidayId)
    .execute();

  await appendAuditLog(trx, {
    action: 'hrm.holiday.deleted',
    resourceType: 'org_holiday',
    resourceId: holidayId,
    metadata: {
      name: existing.name,
      holidayDate: existing.holiday_date,
    },
  });

  return { success: true };
}

import type {
  OrgPayrollSettingsResponse,
  UpdateOrgPayrollSettingsRequest,
} from '@nexstock/contracts';
import { assertAuthorized } from '../../iam/index.js';
import {
  type TenantTransactionContext,
  appendAuditLog,
} from '../../shared/index.js';

export async function getOrgPayrollSettings(
  trx: TenantTransactionContext,
): Promise<OrgPayrollSettingsResponse> {
  const row = await trx.db
    .selectFrom('org_payroll_settings')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .executeTakeFirst();

  if (row) {
    return {
      tenantId: row.tenant_id,
      prorationMethod: row.proration_method,
      gpsAttendanceEnabled: Boolean(row.gps_attendance_enabled),
      allowanceProrationPolicy: row.allowance_proration_policy,
      workplaceLatitude: row.workplace_latitude != null ? Number(row.workplace_latitude) : null,
      workplaceLongitude: row.workplace_longitude != null ? Number(row.workplace_longitude) : null,
      geofenceRadiusMeters: Number(row.geofence_radius_meters),
      updatedAt: new Date(row.updated_at).toISOString(),
    };
  }

  // Default settings
  return {
    tenantId: trx.tenantId,
    prorationMethod: 'CALENDAR_DAYS',
    gpsAttendanceEnabled: false,
    allowanceProrationPolicy: 'PRORATE',
    workplaceLatitude: null,
    workplaceLongitude: null,
    geofenceRadiusMeters: 500,
    updatedAt: new Date().toISOString(),
  };
}

export async function updateOrgPayrollSettings(
  trx: TenantTransactionContext,
  input: UpdateOrgPayrollSettingsRequest,
): Promise<OrgPayrollSettingsResponse> {
  await assertAuthorized(trx, { permission: 'hrm:settings:manage' });

  const existing = await trx.db
    .selectFrom('org_payroll_settings')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .executeTakeFirst();

  const now = new Date();

  if (existing) {
    await trx.db
      .updateTable('org_payroll_settings')
      .set({
        proration_method: input.prorationMethod ?? existing.proration_method,
        gps_attendance_enabled: input.gpsAttendanceEnabled ?? existing.gps_attendance_enabled,
        allowance_proration_policy: input.allowanceProrationPolicy ?? existing.allowance_proration_policy,
        workplace_latitude: input.workplaceLatitude !== undefined ? (input.workplaceLatitude != null ? String(input.workplaceLatitude) : null) : existing.workplace_latitude,
        workplace_longitude: input.workplaceLongitude !== undefined ? (input.workplaceLongitude != null ? String(input.workplaceLongitude) : null) : existing.workplace_longitude,
        geofence_radius_meters: input.geofenceRadiusMeters ?? existing.geofence_radius_meters,
        updated_at: now,
      })
      .where('tenant_id', '=', trx.tenantId)
      .execute();
  } else {
    await trx.db
      .insertInto('org_payroll_settings')
      .values({
        tenant_id: trx.tenantId,
        proration_method: input.prorationMethod ?? 'CALENDAR_DAYS',
        gps_attendance_enabled: input.gpsAttendanceEnabled ?? false,
        allowance_proration_policy: input.allowanceProrationPolicy ?? 'PRORATE',
        workplace_latitude: input.workplaceLatitude != null ? String(input.workplaceLatitude) : null,
        workplace_longitude: input.workplaceLongitude != null ? String(input.workplaceLongitude) : null,
        geofence_radius_meters: input.geofenceRadiusMeters ?? 500,
        updated_at: now,
      })
      .execute();
  }

  await appendAuditLog(trx, {
    action: 'hrm.payroll_settings.updated',
    resourceType: 'org_payroll_settings',
    resourceId: trx.tenantId,
    metadata: {
      prorationMethod: input.prorationMethod,
      gpsAttendanceEnabled: input.gpsAttendanceEnabled,
      allowanceProrationPolicy: input.allowanceProrationPolicy,
    },
  });

  return getOrgPayrollSettings(trx);
}

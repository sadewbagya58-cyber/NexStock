import {
  type LocalizationSettingsDto,
  upsertTenantLocalizationSettings,
} from '../../i18n/index.js';
import {
  assertAuthorized,
  provisionTenantMember,
  seedDefaultSystemRoles,
} from '../../iam/index.js';
import {
  AppError,
  type TenantLifecycleStatus,
  type TenantTransactionContext,
  appendAuditLog,
  enqueueOutboxEvent,
  generateUuidV7,
} from '../../shared/index.js';
import {
  type SubscriptionEntitlementDto,
   type SubscriptionPlanCode,
  assertSubscriptionEntitlement,
  provisionTenantSubscription,
} from '../../sub/index.js';

export interface TenantOrganizationDto {
  readonly id: string;
  readonly slug: string;
  readonly legalName: string;
  readonly baseCurrency: string;
  readonly defaultLocale: string;
  readonly defaultTimezone: string;
  readonly countryCode: string;
  readonly status: TenantLifecycleStatus;
}

export interface BranchDto {
  readonly id: string;
  readonly tenantId: string;
  readonly code: string;
  readonly name: string;
  readonly timezone: string;
  readonly countryCode: string;
  readonly defaultWarehouseId: string | null;
  readonly isActive: boolean;
}

export interface WarehouseDto {
  readonly id: string;
  readonly tenantId: string;
  readonly branchId: string | null;
  readonly code: string;
  readonly name: string;
  readonly allowNegativeStock: boolean;
  readonly isActive: boolean;
}

export interface PosRegisterDto {
  readonly id: string;
  readonly tenantId: string;
  readonly branchId: string;
  readonly warehouseId: string;
  readonly code: string;
  readonly name: string;
  readonly lastInvoiceSeq: number;
  readonly isActive: boolean;
}

/**
 * Provisions a new Tenant Organization along with its initial:
 * 1. `tenants` record
 * 2. Default `IAM` system roles and `TENANT_OWNER` membership for the founding user
 * 3. `SUB` subscription (`STARTER` / `GROWTH` / `ENTERPRISE`)
 * 4. `I18N` localization settings
 */
export async function onboardTenantOrganization(
  trx: TenantTransactionContext,
  input: {
    readonly slug: string;
    readonly legalName: string;
    readonly baseCurrency: string;
    readonly defaultLocale?: string | undefined;
    readonly defaultTimezone?: string | undefined;
    readonly countryCode?: string | undefined;
    readonly ownerEmail: string;
    readonly ownerFullName: string;
    readonly planCode?: SubscriptionPlanCode | undefined;
    readonly initialStatus?: TenantLifecycleStatus | undefined;
    readonly trialDays?: number | undefined;
  },
): Promise<{
  readonly tenant: TenantOrganizationDto;
  readonly ownerMembershipId: string;
  readonly subscription: SubscriptionEntitlementDto;
  readonly localization: LocalizationSettingsDto;
}> {
  const baseCurrency = input.baseCurrency.trim().toUpperCase();
  const defaultLocale = input.defaultLocale ?? 'en-US';
  const defaultTimezone = input.defaultTimezone ?? 'UTC';
  const countryCode = (input.countryCode ?? 'US').trim().toUpperCase();
  const initialStatus = input.initialStatus ?? 'TRIALING';
  const planCode = input.planCode ?? 'STARTER';

  await trx.db
    .insertInto('tenants')
    .values({
      id: trx.tenantId,
      slug: input.slug.trim().toLowerCase(),
      legal_name: input.legalName,
      base_currency: baseCurrency,
      default_locale: defaultLocale,
      default_timezone: defaultTimezone,
      country_code: countryCode,
      status: initialStatus,
    })
    .execute();

  await seedDefaultSystemRoles(trx);

  const ownerMembership = await provisionTenantMember(trx, {
    userId: trx.userId,
    email: input.ownerEmail,
    fullName: input.ownerFullName,
    roleCodes: ['TENANT_OWNER'],
    allLocationsAccess: true,
    status: 'ACTIVE',
  });

  const subscription = await provisionTenantSubscription(trx, {
    planCode,
    status: initialStatus,
    trialDays: input.trialDays,
  });

  const localization = await upsertTenantLocalizationSettings(trx, {
    locale: defaultLocale,
    timezone: defaultTimezone,
    dateFormat: 'YYYY-MM-DD',
    numberFormat: '1,234.56',
    currencyDisplayMode: 'SYMBOL',
  });

  await appendAuditLog(trx, {
    action: 'ORG_TENANT_ONBOARDED',
    resourceType: 'TENANT',
    resourceId: trx.tenantId,
    metadata: {
      slug: input.slug,
      baseCurrency,
      planCode,
      ownerUserId: trx.userId,
    },
  });

  await enqueueOutboxEvent(trx, {
    aggregateType: 'TENANT',
    aggregateId: trx.tenantId,
    eventType: 'TENANT_ONBOARDED',
    payload: {
      tenantId: trx.tenantId,
      slug: input.slug,
      planCode,
    },
  });

  return {
    tenant: {
      id: trx.tenantId,
      slug: input.slug.trim().toLowerCase(),
      legalName: input.legalName,
      baseCurrency,
      defaultLocale,
      defaultTimezone,
      countryCode,
      status: subscription.status,
    },
    ownerMembershipId: ownerMembership.membershipId,
    subscription,
    localization,
  };
}

export async function createBranch(
  trx: TenantTransactionContext,
  input: {
    readonly code: string;
    readonly name: string;
    readonly timezone: string;
    readonly countryCode: string;
  },
): Promise<BranchDto> {
  // Creating a new branch requires `org:branch:manage` AND organization-wide access (`all_locations_access = true`)
  await assertAuthorized(trx, {
    permission: 'org:branch:manage',
    requireAllLocationsAccess: true,
  });

  const existingBranches = await trx.db
    .selectFrom('branches')
    .select(['id'])
    .where('tenant_id', '=', trx.tenantId)
    .where('is_active', '=', true)
    .execute();

  await assertSubscriptionEntitlement(trx, {
    requireWriteAccess: true,
    quotaCheck: {
      resource: 'BRANCH',
      currentActiveCount: existingBranches.length,
    },
  });

  const branchId = generateUuidV7();
  const countryCode = input.countryCode.trim().toUpperCase();

  await trx.db
    .insertInto('branches')
    .values({
      id: branchId,
      tenant_id: trx.tenantId,
      code: input.code.trim().toUpperCase(),
      name: input.name,
      timezone: input.timezone,
      country_code: countryCode,
      default_warehouse_id: null,
      is_active: true,
    })
    .execute();

  await appendAuditLog(trx, {
    action: 'ORG_BRANCH_CREATED',
    resourceType: 'BRANCH',
    resourceId: branchId,
    metadata: {
      code: input.code,
      name: input.name,
      timezone: input.timezone,
      countryCode,
    },
  });

  return {
    id: branchId,
    tenantId: trx.tenantId,
    code: input.code.trim().toUpperCase(),
    name: input.name,
    timezone: input.timezone,
    countryCode,
    defaultWarehouseId: null,
    isActive: true,
  };
}

export async function getBranchById(
  trx: TenantTransactionContext,
  branchId: string,
): Promise<BranchDto> {
  await assertAuthorized(trx, {
    permission: 'org:branch:read',
    branchId,
  });

  await assertSubscriptionEntitlement(trx, {
    requireWriteAccess: false,
  });

  // Intentionally rely on PostgreSQL RLS (`tenant_id = app_current_tenant_id()`) + id lookup
  const row = await trx.db
    .selectFrom('branches')
    .select([
      'id',
      'tenant_id',
      'code',
      'name',
      'timezone',
      'country_code',
      'default_warehouse_id',
      'is_active',
    ])
    .where('id', '=', branchId)
    .executeTakeFirst();

  if (!row) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'ERR_NOT_FOUND',
      title: 'Branch Not Found',
      detail: `Branch "${branchId}" was not found in tenant "${trx.tenantId}".`,
    });
  }

  return {
    id: row.id,
    tenantId: row.tenant_id,
    code: row.code,
    name: row.name,
    timezone: row.timezone,
    countryCode: row.country_code.trim(),
    defaultWarehouseId: row.default_warehouse_id,
    isActive: row.is_active,
  };
}

export async function updateBranchName(
  trx: TenantTransactionContext,
  input: {
    readonly branchId: string;
    readonly name: string;
  },
): Promise<BranchDto> {
  await assertAuthorized(trx, {
    permission: 'org:branch:manage',
    branchId: input.branchId,
  });

  await assertSubscriptionEntitlement(trx, {
    requireWriteAccess: true,
  });

  const existing = await trx.db
    .selectFrom('branches')
    .select([
      'id',
      'tenant_id',
      'code',
      'name',
      'timezone',
      'country_code',
      'default_warehouse_id',
      'is_active',
    ])
    .where('id', '=', input.branchId)
    .executeTakeFirst();

  if (!existing) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'ERR_NOT_FOUND',
      title: 'Branch Not Found',
      detail: `Branch "${input.branchId}" was not found.`,
    });
  }

  await trx.db
    .updateTable('branches')
    .set({
      name: input.name,
      updated_at: new Date(),
    })
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', input.branchId)
    .execute();

  await appendAuditLog(trx, {
    action: 'ORG_BRANCH_UPDATED',
    resourceType: 'BRANCH',
    resourceId: input.branchId,
    metadata: { previousName: existing.name, nextName: input.name },
  });

  return {
    id: existing.id,
    tenantId: existing.tenant_id,
    code: existing.code,
    name: input.name,
    timezone: existing.timezone,
    countryCode: existing.country_code.trim(),
    defaultWarehouseId: existing.default_warehouse_id,
    isActive: existing.is_active,
  };
}

export async function listBranches(
  trx: TenantTransactionContext,
): Promise<readonly BranchDto[]> {
  const authCtx = await assertAuthorized(trx, {
    permission: 'org:branch:read',
  });

  await assertSubscriptionEntitlement(trx, {
    requireWriteAccess: false,
  });

  // Intentionally omit `.where('tenant_id', '=', trx.tenantId)` to prove PostgreSQL RLS enforcement
  let query = trx.db
    .selectFrom('branches')
    .select([
      'id',
      'tenant_id',
      'code',
      'name',
      'timezone',
      'country_code',
      'default_warehouse_id',
      'is_active',
    ])
    .orderBy('code', 'asc');

  if (!authCtx.allLocationsAccess) {
    const allowedIds = [...authCtx.allowedBranchIds];
    if (allowedIds.length === 0) {
      return [];
    }
    query = query.where('id', 'in', allowedIds);
  }

  const rows = await query.execute();
  return rows.map((row) => ({
    id: row.id,
    tenantId: row.tenant_id,
    code: row.code,
    name: row.name,
    timezone: row.timezone,
    countryCode: row.country_code.trim(),
    defaultWarehouseId: row.default_warehouse_id,
    isActive: row.is_active,
  }));
}

export async function createWarehouse(
  trx: TenantTransactionContext,
  input: {
    readonly branchId?: string | null | undefined;
    readonly code: string;
    readonly name: string;
    readonly allowNegativeStock?: boolean | undefined;
    readonly isPrimaryForBranch?: boolean | undefined;
  },
): Promise<WarehouseDto> {
  const branchId = input.branchId ?? null;

  await assertAuthorized(trx, {
    permission: 'org:warehouse:manage',
    ...(branchId
      ? { branchId }
      : { requireAllLocationsAccess: true }),
  });

  const existingWarehouses = await trx.db
    .selectFrom('warehouses')
    .select(['id'])
    .where('tenant_id', '=', trx.tenantId)
    .where('is_active', '=', true)
    .execute();

  await assertSubscriptionEntitlement(trx, {
    requireWriteAccess: true,
    quotaCheck: {
      resource: 'WAREHOUSE',
      currentActiveCount: existingWarehouses.length,
    },
  });

  const warehouseId = generateUuidV7();
  const allowNegativeStock = input.allowNegativeStock ?? false;

  await trx.db
    .insertInto('warehouses')
    .values({
      id: warehouseId,
      tenant_id: trx.tenantId,
      branch_id: branchId,
      code: input.code.trim().toUpperCase(),
      name: input.name,
      allow_negative_stock: allowNegativeStock,
      is_active: true,
    })
    .execute();

  if (branchId) {
    const isPrimary = input.isPrimaryForBranch ?? true;
    await trx.db
      .insertInto('branch_warehouse_links')
      .values({
        id: generateUuidV7(),
        tenant_id: trx.tenantId,
        branch_id: branchId,
        warehouse_id: warehouseId,
        is_primary: isPrimary,
      })
      .execute();

    if (isPrimary) {
      await trx.db
        .updateTable('branches')
        .set({
          default_warehouse_id: warehouseId,
          updated_at: new Date(),
        })
        .where('tenant_id', '=', trx.tenantId)
        .where('id', '=', branchId)
        .execute();
    }
  }

  await appendAuditLog(trx, {
    action: 'ORG_WAREHOUSE_CREATED',
    resourceType: 'WAREHOUSE',
    resourceId: warehouseId,
    metadata: {
      branchId,
      code: input.code,
      name: input.name,
      allowNegativeStock,
    },
  });

  return {
    id: warehouseId,
    tenantId: trx.tenantId,
    branchId,
    code: input.code.trim().toUpperCase(),
    name: input.name,
    allowNegativeStock,
    isActive: true,
  };
}

export async function createPosRegister(
  trx: TenantTransactionContext,
  input: {
    readonly branchId: string;
    readonly warehouseId: string;
    readonly code: string;
    readonly name: string;
  },
): Promise<PosRegisterDto> {
  await assertAuthorized(trx, {
    permission: 'org:register:manage',
    branchId: input.branchId,
  });

  const existingRegisters = await trx.db
    .selectFrom('pos_registers')
    .select(['id'])
    .where('tenant_id', '=', trx.tenantId)
    .where('is_active', '=', true)
    .execute();

  await assertSubscriptionEntitlement(trx, {
    requireWriteAccess: true,
    quotaCheck: {
      resource: 'REGISTER',
      currentActiveCount: existingRegisters.length,
    },
  });

  const registerId = generateUuidV7();
  await trx.db
    .insertInto('pos_registers')
    .values({
      id: registerId,
      tenant_id: trx.tenantId,
      branch_id: input.branchId,
      warehouse_id: input.warehouseId,
      code: input.code.trim().toUpperCase(),
      name: input.name,
      last_invoice_seq: 0,
      is_active: true,
    })
    .execute();

  await appendAuditLog(trx, {
    action: 'ORG_POS_REGISTER_CREATED',
    resourceType: 'POS_REGISTER',
    resourceId: registerId,
    metadata: {
      branchId: input.branchId,
      warehouseId: input.warehouseId,
      code: input.code,
    },
  });

  return {
    id: registerId,
    tenantId: trx.tenantId,
    branchId: input.branchId,
    warehouseId: input.warehouseId,
    code: input.code.trim().toUpperCase(),
    name: input.name,
    lastInvoiceSeq: 0,
    isActive: true,
  };
}

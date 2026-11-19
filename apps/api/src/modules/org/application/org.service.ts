import type {
  TenantBrandingResponse,
  UpdateTenantBrandingRequest,
} from '@nexstock/contracts';
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
  readonly defaultWarehouseCode?: string | null;
  readonly defaultWarehouseName?: string | null;
  readonly phone?: string | null;
  readonly email?: string | null;
  readonly address?: string | null;
  readonly city?: string | null;
  readonly managerName?: string | null;
  readonly managerUserId?: string | null;
  readonly isMainBranch?: boolean;
  readonly isHeadquarters?: boolean;
  readonly status?: 'ACTIVE' | 'ARCHIVED';
  readonly isActive: boolean;
  readonly archivedAt?: string | null;
  readonly createdAt?: string;
  readonly updatedAt?: string;
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

interface RawBranchRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly code: string;
  readonly name: string;
  readonly timezone: string;
  readonly country_code: string;
  readonly default_warehouse_id: string | null;
  readonly is_active: boolean;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface BranchExtendedMeta {
  phone: string | null;
  email: string | null;
  address: string | null;
  city: string | null;
  managerName: string | null;
  managerUserId: string | null;
  archivedAt: string | null;
}

async function ensureBranchDefaultWarehouseInternal(
  trx: TenantTransactionContext,
  branch: {
    readonly id: string;
    readonly code: string;
    readonly name: string;
    readonly default_warehouse_id: string | null;
  },
  customWarehouseCode?: string,
  customWarehouseName?: string,
): Promise<{
  readonly warehouseId: string;
  readonly warehouseCode: string;
  readonly warehouseName: string;
}> {
  if (branch.default_warehouse_id) {
    const existingWh = await trx.db
      .selectFrom('warehouses')
      .select(['id', 'code', 'name'])
      .where('id', '=', branch.default_warehouse_id)
      .executeTakeFirst();
    if (existingWh) {
      return {
        warehouseId: existingWh.id,
        warehouseCode: existingWh.code,
        warehouseName: existingWh.name,
      };
    }
  }

  // Check if any warehouse is already linked to this branch
  const existingBranchWh = await trx.db
    .selectFrom('warehouses')
    .select(['id', 'code', 'name'])
    .where('tenant_id', '=', trx.tenantId)
    .where('branch_id', '=', branch.id)
    .orderBy('created_at', 'asc')
    .executeTakeFirst();

  if (existingBranchWh) {
    await trx.db
      .updateTable('branches')
      .set({
        default_warehouse_id: existingBranchWh.id,
        updated_at: new Date(),
      })
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', branch.id)
      .execute();

    const existingLink = await trx.db
      .selectFrom('branch_warehouse_links')
      .select(['id'])
      .where('tenant_id', '=', trx.tenantId)
      .where('branch_id', '=', branch.id)
      .where('warehouse_id', '=', existingBranchWh.id)
      .executeTakeFirst();

    if (!existingLink) {
      await trx.db
        .insertInto('branch_warehouse_links')
        .values({
          id: generateUuidV7(),
          tenant_id: trx.tenantId,
          branch_id: branch.id,
          warehouse_id: existingBranchWh.id,
          is_primary: true,
        })
        .execute();
    }

    return {
      warehouseId: existingBranchWh.id,
      warehouseCode: existingBranchWh.code,
      warehouseName: existingBranchWh.name,
    };
  }

  // Auto-provision the branch's Default Warehouse with zero stock
  const defaultWarehouseId = generateUuidV7();
  let defaultWarehouseCode = (
    customWarehouseCode ?? `WH-${branch.code.trim().toUpperCase()}-DEF`
  )
    .trim()
    .toUpperCase()
    .slice(0, 32);

  const codeCollision = await trx.db
    .selectFrom('warehouses')
    .select(['id'])
    .where('tenant_id', '=', trx.tenantId)
    .where('code', '=', defaultWarehouseCode)
    .executeTakeFirst();

  if (codeCollision) {
    const suffix = defaultWarehouseId.slice(-4).toUpperCase();
    defaultWarehouseCode = `WH-${branch.code.trim().toUpperCase().slice(0, 20)}-${suffix}`;
  }

  const defaultWarehouseName = (
    customWarehouseName ?? `${branch.name.trim()} Default Warehouse`
  )
    .trim()
    .slice(0, 120);

  await trx.db
    .insertInto('warehouses')
    .values({
      id: defaultWarehouseId,
      tenant_id: trx.tenantId,
      branch_id: branch.id,
      code: defaultWarehouseCode,
      name: defaultWarehouseName,
      allow_negative_stock: false,
      is_active: true,
    })
    .execute();

  await trx.db
    .insertInto('branch_warehouse_links')
    .values({
      id: generateUuidV7(),
      tenant_id: trx.tenantId,
      branch_id: branch.id,
      warehouse_id: defaultWarehouseId,
      is_primary: true,
    })
    .execute();

  await trx.db
    .updateTable('branches')
    .set({
      default_warehouse_id: defaultWarehouseId,
      updated_at: new Date(),
    })
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', branch.id)
    .execute();

  await appendAuditLog(trx, {
    action: 'ORG_WAREHOUSE_CREATED',
    resourceType: 'WAREHOUSE',
    resourceId: defaultWarehouseId,
    metadata: {
      branchId: branch.id,
      code: defaultWarehouseCode,
      name: defaultWarehouseName,
      allowNegativeStock: false,
      isAutoDefaultWarehouse: true,
    },
  });

  return {
    warehouseId: defaultWarehouseId,
    warehouseCode: defaultWarehouseCode,
    warehouseName: defaultWarehouseName,
  };
}

async function hydrateBranchRows(
  trx: TenantTransactionContext,
  rows: readonly RawBranchRow[],
): Promise<readonly BranchDto[]> {
  if (rows.length === 0) {
    return [];
  }

  // Ensure every branch has its required Default Warehouse
  const resolvedDefaultWarehouses = new Map<
    string,
    { warehouseId: string; warehouseCode: string; warehouseName: string }
  >();

  const warehouseIdsToFetch = rows
    .map((r) => r.default_warehouse_id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);

  const existingWarehousesMap = new Map<
    string,
    { id: string; code: string; name: string }
  >();
  if (warehouseIdsToFetch.length > 0) {
    const whRows = await trx.db
      .selectFrom('warehouses')
      .select(['id', 'code', 'name'])
      .where('id', 'in', warehouseIdsToFetch)
      .execute();
    for (const wh of whRows) {
      existingWarehousesMap.set(wh.id, wh);
    }
  }

  for (const row of rows) {
    if (
      row.default_warehouse_id &&
      existingWarehousesMap.has(row.default_warehouse_id)
    ) {
      const wh = existingWarehousesMap.get(row.default_warehouse_id)!;
      resolvedDefaultWarehouses.set(row.id, {
        warehouseId: wh.id,
        warehouseCode: wh.code,
        warehouseName: wh.name,
      });
    } else {
      const ensured = await ensureBranchDefaultWarehouseInternal(trx, row);
      resolvedDefaultWarehouses.set(row.id, ensured);
    }
  }

  // Load extended metadata and Main Branch designation from audit_logs
  const allTenantBranches = await trx.db
    .selectFrom('branches')
    .select(['id', 'is_active', 'created_at', 'code'])
    .orderBy('created_at', 'asc')
    .orderBy('code', 'asc')
    .execute();

  const branchAuditLogs = await trx.db
    .selectFrom('audit_logs')
    .select(['resource_id', 'action', 'metadata_json', 'created_at'])
    .where('tenant_id', '=', trx.tenantId)
    .where('resource_type', '=', 'BRANCH')
    .orderBy('created_at', 'asc')
    .execute();

  const metaByBranchId = new Map<string, BranchExtendedMeta>();
  let explicitMainBranchId: string | null = null;

  for (const log of branchAuditLogs) {
    const bId = log.resource_id;
    const current: BranchExtendedMeta = metaByBranchId.get(bId) ?? {
      phone: null,
      email: null,
      address: null,
      city: null,
      managerName: null,
      managerUserId: null,
      archivedAt: null,
    };

    const meta = (log.metadata_json ?? {}) as Record<string, unknown>;
    if ('phone' in meta) {
      current.phone =
        typeof meta.phone === 'string' && meta.phone.trim()
          ? meta.phone.trim()
          : null;
    }
    if ('email' in meta) {
      current.email =
        typeof meta.email === 'string' && meta.email.trim()
          ? meta.email.trim()
          : null;
    }
    if ('address' in meta) {
      current.address =
        typeof meta.address === 'string' && meta.address.trim()
          ? meta.address.trim()
          : null;
    }
    if ('city' in meta) {
      current.city =
        typeof meta.city === 'string' && meta.city.trim()
          ? meta.city.trim()
          : null;
    }
    if ('managerName' in meta) {
      current.managerName =
        typeof meta.managerName === 'string' && meta.managerName.trim()
          ? meta.managerName.trim()
          : null;
    }
    if ('managerUserId' in meta) {
      current.managerUserId =
        typeof meta.managerUserId === 'string' && meta.managerUserId.trim()
          ? meta.managerUserId.trim()
          : null;
    }
    if (log.action === 'ORG_BRANCH_ARCHIVED') {
      current.archivedAt =
        typeof meta.archivedAt === 'string'
          ? meta.archivedAt
          : log.created_at.toISOString();
    } else if (log.action === 'ORG_BRANCH_RESTORED') {
      current.archivedAt = null;
    } else if ('archivedAt' in meta) {
      current.archivedAt =
        typeof meta.archivedAt === 'string' ? meta.archivedAt : null;
    }

    if (
      log.action === 'ORG_BRANCH_SET_MAIN' ||
      meta.isMainBranch === true ||
      meta.isHeadquarters === true
    ) {
      explicitMainBranchId = bId;
    }

    metaByBranchId.set(bId, current);
  }

  // Determine the single Main Branch for the tenant
  const activeTenantBranches = allTenantBranches.filter((b) => b.is_active);
  let mainBranchId: string | null = null;
  if (
    explicitMainBranchId &&
    activeTenantBranches.some((b) => b.id === explicitMainBranchId)
  ) {
    mainBranchId = explicitMainBranchId;
  } else if (activeTenantBranches.length > 0) {
    mainBranchId = activeTenantBranches[0]!.id;
  } else if (allTenantBranches.length > 0) {
    mainBranchId = allTenantBranches[0]!.id;
  }

  return rows.map((row) => {
    const wh = resolvedDefaultWarehouses.get(row.id);
    const meta = metaByBranchId.get(row.id);
    const isMain = row.id === mainBranchId;
    return {
      id: row.id,
      tenantId: row.tenant_id,
      code: row.code,
      name: row.name,
      timezone: row.timezone,
      countryCode: row.country_code.trim(),
      defaultWarehouseId: wh?.warehouseId ?? row.default_warehouse_id,
      defaultWarehouseCode: wh?.warehouseCode ?? null,
      defaultWarehouseName: wh?.warehouseName ?? null,
      phone: meta?.phone ?? null,
      email: meta?.email ?? null,
      address: meta?.address ?? null,
      city: meta?.city ?? null,
      managerName: meta?.managerName ?? null,
      managerUserId: meta?.managerUserId ?? null,
      isMainBranch: isMain,
      isHeadquarters: isMain,
      status: row.is_active ? 'ACTIVE' : 'ARCHIVED',
      isActive: row.is_active,
      archivedAt: row.is_active ? null : (meta?.archivedAt ?? row.updated_at.toISOString()),
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  });
}

export async function createBranch(
  trx: TenantTransactionContext,
  input: {
    readonly code: string;
    readonly name: string;
    readonly timezone?: string | undefined;
    readonly countryCode?: string | undefined;
    readonly phone?: string | null | undefined;
    readonly email?: string | null | undefined;
    readonly address?: string | null | undefined;
    readonly city?: string | null | undefined;
    readonly managerName?: string | null | undefined;
    readonly managerUserId?: string | null | undefined;
    readonly isMainBranch?: boolean | undefined;
    readonly isHeadquarters?: boolean | undefined;
    readonly defaultWarehouseCode?: string | undefined;
    readonly defaultWarehouseName?: string | undefined;
  },
): Promise<BranchDto> {
  // Creating a new branch requires `org:branch:manage` AND organization-wide access (`all_locations_access = true`)
  await assertAuthorized(trx, {
    permission: 'org:branch:manage',
    requireAllLocationsAccess: true,
  });

  const existingBranches = await trx.db
    .selectFrom('branches')
    .select(['id', 'code', 'is_active'])
    .where('tenant_id', '=', trx.tenantId)
    .execute();

  const activeBranchesCount = existingBranches.filter((b) => b.is_active).length;

  await assertSubscriptionEntitlement(trx, {
    requireWriteAccess: true,
    quotaCheck: {
      resource: 'BRANCH',
      currentActiveCount: activeBranchesCount,
    },
  });

  const normalizedCode = input.code.trim().toUpperCase();
  const duplicateCode = existingBranches.find(
    (b) => b.code.trim().toUpperCase() === normalizedCode,
  );
  if (duplicateCode) {
    throw new AppError({
      statusCode: 409,
      errorCode: 'ERR_CONFLICT',
      title: 'Duplicate Branch Code',
      detail: `A branch with code "${normalizedCode}" already exists in this business account.`,
    });
  }

  let timezone = input.timezone?.trim();
  let countryCode = input.countryCode?.trim().toUpperCase();
  if (!timezone || !countryCode) {
    const tenantRow = await trx.db
      .selectFrom('tenants')
      .select(['default_timezone', 'country_code'])
      .where('id', '=', trx.tenantId)
      .executeTakeFirst();
    timezone = timezone || tenantRow?.default_timezone || 'UTC';
    countryCode = (countryCode || tenantRow?.country_code || 'US')
      .trim()
      .toUpperCase();
  }

  const branchId = generateUuidV7();
  const isFirstBranch = existingBranches.length === 0;
  const isMainBranch =
    isFirstBranch ||
    input.isMainBranch === true ||
    input.isHeadquarters === true;

  await trx.db
    .insertInto('branches')
    .values({
      id: branchId,
      tenant_id: trx.tenantId,
      code: normalizedCode,
      name: input.name.trim(),
      timezone,
      country_code: countryCode,
      default_warehouse_id: null,
      is_active: true,
    })
    .execute();

  // Automatically create the branch's Default Warehouse with zero stock
  const defaultWh = await ensureBranchDefaultWarehouseInternal(
    trx,
    {
      id: branchId,
      code: normalizedCode,
      name: input.name.trim(),
      default_warehouse_id: null,
    },
    input.defaultWarehouseCode,
    input.defaultWarehouseName,
  );

  await appendAuditLog(trx, {
    action: 'ORG_BRANCH_CREATED',
    resourceType: 'BRANCH',
    resourceId: branchId,
    metadata: {
      code: normalizedCode,
      name: input.name.trim(),
      timezone,
      countryCode,
      defaultWarehouseId: defaultWh.warehouseId,
      defaultWarehouseCode: defaultWh.warehouseCode,
      defaultWarehouseName: defaultWh.warehouseName,
      phone: input.phone ?? null,
      email: input.email ?? null,
      address: input.address ?? null,
      city: input.city ?? null,
      managerName: input.managerName ?? null,
      managerUserId: input.managerUserId ?? null,
      isMainBranch,
      status: 'ACTIVE',
      archivedAt: null,
    },
  });

  if (isMainBranch && !isFirstBranch) {
    await appendAuditLog(trx, {
      action: 'ORG_BRANCH_SET_MAIN',
      resourceType: 'BRANCH',
      resourceId: branchId,
      metadata: {
        isMainBranch: true,
      },
    });
  }

  const createdRow = await trx.db
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
      'created_at',
      'updated_at',
    ])
    .where('id', '=', branchId)
    .executeTakeFirstOrThrow();

  const [hydrated] = await hydrateBranchRows(trx, [createdRow]);
  return hydrated!;
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
      'created_at',
      'updated_at',
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

  const [hydrated] = await hydrateBranchRows(trx, [row]);
  return hydrated!;
}

export async function updateBranch(
  trx: TenantTransactionContext,
  input: {
    readonly branchId: string;
    readonly code?: string | undefined;
    readonly name?: string | undefined;
    readonly timezone?: string | undefined;
    readonly countryCode?: string | undefined;
    readonly phone?: string | null | undefined;
    readonly email?: string | null | undefined;
    readonly address?: string | null | undefined;
    readonly city?: string | null | undefined;
    readonly managerName?: string | null | undefined;
    readonly managerUserId?: string | null | undefined;
    readonly isMainBranch?: boolean | undefined;
    readonly isHeadquarters?: boolean | undefined;
    readonly isActive?: boolean | undefined;
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
      'created_at',
      'updated_at',
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

  const [currentHydrated] = await hydrateBranchRows(trx, [existing]);

  let nextCode = existing.code;
  if (input.code !== undefined) {
    nextCode = input.code.trim().toUpperCase();
    if (nextCode !== existing.code) {
      const duplicate = await trx.db
        .selectFrom('branches')
        .select(['id'])
        .where('tenant_id', '=', trx.tenantId)
        .where('code', '=', nextCode)
        .where('id', '!=', input.branchId)
        .executeTakeFirst();
      if (duplicate) {
        throw new AppError({
          statusCode: 409,
          errorCode: 'ERR_CONFLICT',
          title: 'Duplicate Branch Code',
          detail: `A branch with code "${nextCode}" already exists.`,
        });
      }
    }
  }

  if (input.isActive === false && existing.is_active) {
    if (currentHydrated?.isMainBranch) {
      throw new AppError({
        statusCode: 409,
        errorCode: 'ERR_CONFLICT',
        title: 'Cannot Archive Main Branch',
        detail:
          'The designated Main Branch cannot be archived. Set another active branch as Main Branch first.',
      });
    }
  }

  const nextName =
    input.name !== undefined ? input.name.trim() : existing.name;
  const nextTimezone =
    input.timezone !== undefined ? input.timezone.trim() : existing.timezone;
  const nextCountryCode =
    input.countryCode !== undefined
      ? input.countryCode.trim().toUpperCase()
      : existing.country_code.trim();
  const nextIsActive =
    input.isActive !== undefined ? input.isActive : existing.is_active;

  await trx.db
    .updateTable('branches')
    .set({
      code: nextCode,
      name: nextName,
      timezone: nextTimezone,
      country_code: nextCountryCode,
      is_active: nextIsActive,
      updated_at: new Date(),
    })
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', input.branchId)
    .execute();

  const updatedMeta: Record<string, unknown> = {
    previousName: existing.name,
    nextName,
    code: nextCode,
    timezone: nextTimezone,
    countryCode: nextCountryCode,
    phone:
      input.phone !== undefined
        ? input.phone
        : (currentHydrated?.phone ?? null),
    email:
      input.email !== undefined
        ? input.email
        : (currentHydrated?.email ?? null),
    address:
      input.address !== undefined
        ? input.address
        : (currentHydrated?.address ?? null),
    city:
      input.city !== undefined ? input.city : (currentHydrated?.city ?? null),
    managerName:
      input.managerName !== undefined
        ? input.managerName
        : (currentHydrated?.managerName ?? null),
    managerUserId:
      input.managerUserId !== undefined
        ? input.managerUserId
        : (currentHydrated?.managerUserId ?? null),
  };

  if (input.isMainBranch === true || input.isHeadquarters === true) {
    updatedMeta.isMainBranch = true;
  }

  await appendAuditLog(trx, {
    action: 'ORG_BRANCH_UPDATED',
    resourceType: 'BRANCH',
    resourceId: input.branchId,
    metadata: updatedMeta,
  });

  if (input.isMainBranch === true || input.isHeadquarters === true) {
    await appendAuditLog(trx, {
      action: 'ORG_BRANCH_SET_MAIN',
      resourceType: 'BRANCH',
      resourceId: input.branchId,
      metadata: { isMainBranch: true },
    });
  }

  const updatedRow = await trx.db
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
      'created_at',
      'updated_at',
    ])
    .where('id', '=', input.branchId)
    .executeTakeFirstOrThrow();

  const [hydrated] = await hydrateBranchRows(trx, [updatedRow]);
  return hydrated!;
}

export async function updateBranchName(
  trx: TenantTransactionContext,
  input: {
    readonly branchId: string;
    readonly name: string;
  },
): Promise<BranchDto> {
  return updateBranch(trx, input);
}

export async function archiveBranch(
  trx: TenantTransactionContext,
  branchId: string,
): Promise<BranchDto> {
  await assertAuthorized(trx, {
    permission: 'org:branch:manage',
    branchId,
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
      'created_at',
      'updated_at',
    ])
    .where('id', '=', branchId)
    .executeTakeFirst();

  if (!existing) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'ERR_NOT_FOUND',
      title: 'Branch Not Found',
      detail: `Branch "${branchId}" was not found.`,
    });
  }

  const [currentHydrated] = await hydrateBranchRows(trx, [existing]);

  if (!existing.is_active) {
    return currentHydrated!;
  }

  if (currentHydrated?.isMainBranch) {
    throw new AppError({
      statusCode: 409,
      errorCode: 'ERR_CONFLICT',
      title: 'Cannot Archive Main Branch',
      detail:
        'The designated Main Branch cannot be archived. Designate another active branch as Main Branch before archiving.',
    });
  }

  const activeBranches = await trx.db
    .selectFrom('branches')
    .select(['id'])
    .where('tenant_id', '=', trx.tenantId)
    .where('is_active', '=', true)
    .execute();

  if (activeBranches.length <= 1) {
    throw new AppError({
      statusCode: 409,
      errorCode: 'ERR_CONFLICT',
      title: 'Cannot Archive Last Active Branch',
      detail: 'A business account must have at least one active branch.',
    });
  }

  const now = new Date();
  await trx.db
    .updateTable('branches')
    .set({
      is_active: false,
      updated_at: now,
    })
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', branchId)
    .execute();

  await appendAuditLog(trx, {
    action: 'ORG_BRANCH_ARCHIVED',
    resourceType: 'BRANCH',
    resourceId: branchId,
    metadata: {
      code: existing.code,
      name: existing.name,
      archivedAt: now.toISOString(),
    },
  });

  const updatedRow = await trx.db
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
      'created_at',
      'updated_at',
    ])
    .where('id', '=', branchId)
    .executeTakeFirstOrThrow();

  const [hydrated] = await hydrateBranchRows(trx, [updatedRow]);
  return hydrated!;
}

export async function restoreBranch(
  trx: TenantTransactionContext,
  branchId: string,
): Promise<BranchDto> {
  await assertAuthorized(trx, {
    permission: 'org:branch:manage',
    branchId,
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
      'created_at',
      'updated_at',
    ])
    .where('id', '=', branchId)
    .executeTakeFirst();

  if (!existing) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'ERR_NOT_FOUND',
      title: 'Branch Not Found',
      detail: `Branch "${branchId}" was not found.`,
    });
  }

  if (existing.is_active) {
    const [hydrated] = await hydrateBranchRows(trx, [existing]);
    return hydrated!;
  }

  const activeBranches = await trx.db
    .selectFrom('branches')
    .select(['id'])
    .where('tenant_id', '=', trx.tenantId)
    .where('is_active', '=', true)
    .execute();

  await assertSubscriptionEntitlement(trx, {
    requireWriteAccess: true,
    quotaCheck: {
      resource: 'BRANCH',
      currentActiveCount: activeBranches.length,
    },
  });

  const now = new Date();
  await trx.db
    .updateTable('branches')
    .set({
      is_active: true,
      updated_at: now,
    })
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', branchId)
    .execute();

  await appendAuditLog(trx, {
    action: 'ORG_BRANCH_RESTORED',
    resourceType: 'BRANCH',
    resourceId: branchId,
    metadata: {
      code: existing.code,
      name: existing.name,
      restoredAt: now.toISOString(),
      archivedAt: null,
    },
  });

  const updatedRow = await trx.db
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
      'created_at',
      'updated_at',
    ])
    .where('id', '=', branchId)
    .executeTakeFirstOrThrow();

  const [hydrated] = await hydrateBranchRows(trx, [updatedRow]);
  return hydrated!;
}

export async function setMainBranch(
  trx: TenantTransactionContext,
  branchId: string,
): Promise<BranchDto> {
  await assertAuthorized(trx, {
    permission: 'org:branch:manage',
    requireAllLocationsAccess: true,
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
      'created_at',
      'updated_at',
    ])
    .where('id', '=', branchId)
    .executeTakeFirst();

  if (!existing) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'ERR_NOT_FOUND',
      title: 'Branch Not Found',
      detail: `Branch "${branchId}" was not found.`,
    });
  }

  if (!existing.is_active) {
    throw new AppError({
      statusCode: 409,
      errorCode: 'ERR_CONFLICT',
      title: 'Branch Archived',
      detail:
        'Cannot designate an archived branch as the Main Branch. Restore the branch first.',
    });
  }

  await trx.db
    .updateTable('branches')
    .set({ updated_at: new Date() })
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', branchId)
    .execute();

  await appendAuditLog(trx, {
    action: 'ORG_BRANCH_SET_MAIN',
    resourceType: 'BRANCH',
    resourceId: branchId,
    metadata: {
      code: existing.code,
      name: existing.name,
      isMainBranch: true,
    },
  });

  const [hydrated] = await hydrateBranchRows(trx, [existing]);
  return hydrated!;
}

export async function listBranches(
  trx: TenantTransactionContext,
  options?: {
    readonly status?: 'ACTIVE' | 'ARCHIVED' | 'ALL' | undefined;
    readonly search?: string | undefined;
  },
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
      'created_at',
      'updated_at',
    ])
    .orderBy('code', 'asc');

  if (!authCtx.allLocationsAccess) {
    const allowedIds = [...authCtx.allowedBranchIds];
    if (allowedIds.length === 0) {
      return [];
    }
    query = query.where('id', 'in', allowedIds);
  }

  if (options?.status === 'ACTIVE') {
    query = query.where('is_active', '=', true);
  } else if (options?.status === 'ARCHIVED') {
    query = query.where('is_active', '=', false);
  }

  const rows = await query.execute();
  const hydrated = await hydrateBranchRows(trx, rows);

  if (options?.search && options.search.trim().length > 0) {
    const q = options.search.trim().toLowerCase();
    return hydrated.filter(
      (b) =>
        b.code.toLowerCase().includes(q) ||
        b.name.toLowerCase().includes(q) ||
        (b.city && b.city.toLowerCase().includes(q)) ||
        (b.managerName && b.managerName.toLowerCase().includes(q)),
    );
  }

  return hydrated;
}

export async function listWarehouses(
  trx: TenantTransactionContext,
  options?: { readonly branchId?: string | undefined },
): Promise<readonly WarehouseDto[]> {
  const authCtx = await assertAuthorized(trx, {
    permission: 'org:warehouse:read',
    ...(options?.branchId ? { branchId: options.branchId } : {}),
  });

  await assertSubscriptionEntitlement(trx, {
    requireWriteAccess: false,
  });

  let query = trx.db
    .selectFrom('warehouses')
    .select([
      'id',
      'tenant_id',
      'branch_id',
      'code',
      'name',
      'allow_negative_stock',
      'is_active',
    ])
    .orderBy('code', 'asc');

  let preferredDefaultWarehouseId: string | null = null;

  if (options?.branchId) {
    const branchId = options.branchId;
    const branchRow = await trx.db
      .selectFrom('branches')
      .select(['id', 'default_warehouse_id'])
      .where('id', '=', branchId)
      .executeTakeFirst();
    preferredDefaultWarehouseId = branchRow?.default_warehouse_id ?? null;

    const linked = await trx.db
      .selectFrom('branch_warehouse_links')
      .select(['warehouse_id'])
      .where('tenant_id', '=', trx.tenantId)
      .where('branch_id', '=', branchId)
      .execute();
    const linkedIds = linked.map((l) => l.warehouse_id);

    query = query.where((eb) =>
      eb.or([
        eb('branch_id', '=', branchId),
        ...(linkedIds.length > 0 ? [eb('id', 'in', linkedIds)] : []),
      ]),
    );
  }

  if (!authCtx.allLocationsAccess) {
    const allowedIds = [...authCtx.allowedWarehouseIds];
    if (allowedIds.length === 0) {
      return [];
    }
    query = query.where('id', 'in', allowedIds);
  }

  const rows = await query.execute();
  const mapped = rows.map((row) => ({
    id: row.id,
    tenantId: row.tenant_id,
    branchId: row.branch_id,
    code: row.code,
    name: row.name,
    allowNegativeStock: row.allow_negative_stock,
    isActive: row.is_active,
  }));

  if (preferredDefaultWarehouseId) {
    mapped.sort((a, b) => {
      if (a.id === preferredDefaultWarehouseId && b.id !== preferredDefaultWarehouseId) {
        return -1;
      }
      if (b.id === preferredDefaultWarehouseId && a.id !== preferredDefaultWarehouseId) {
        return 1;
      }
      return a.code.localeCompare(b.code);
    });
  }

  return mapped;
}

export async function getWarehouseById(
  trx: TenantTransactionContext,
  warehouseId: string,
): Promise<WarehouseDto> {
  await assertAuthorized(trx, {
    permission: 'org:warehouse:read',
    warehouseId,
  });

  await assertSubscriptionEntitlement(trx, {
    requireWriteAccess: false,
  });

  const row = await trx.db
    .selectFrom('warehouses')
    .select([
      'id',
      'tenant_id',
      'branch_id',
      'code',
      'name',
      'allow_negative_stock',
      'is_active',
    ])
    .where('id', '=', warehouseId)
    .executeTakeFirst();

  if (!row) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'ERR_NOT_FOUND',
      title: 'Warehouse Not Found',
      detail: `Warehouse "${warehouseId}" was not found in tenant "${trx.tenantId}".`,
    });
  }

  return {
    id: row.id,
    tenantId: row.tenant_id,
    branchId: row.branch_id,
    code: row.code,
    name: row.name,
    allowNegativeStock: row.allow_negative_stock,
    isActive: row.is_active,
  };
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

  // Auto-provisioned branch default warehouses (`WH-*-DEF`) are part of the branch entitlement
  const existingWarehouses = await trx.db
    .selectFrom('warehouses')
    .select(['id', 'code'])
    .where('tenant_id', '=', trx.tenantId)
    .where('is_active', '=', true)
    .execute();

  const nonAutoDefaultCount = existingWarehouses.filter(
    (w) => !(w.code.startsWith('WH-') && w.code.endsWith('-DEF')),
  ).length;

  await assertSubscriptionEntitlement(trx, {
    requireWriteAccess: true,
    quotaCheck: {
      resource: 'WAREHOUSE',
      currentActiveCount: nonAutoDefaultCount,
    },
  });

  const allowNegativeStock = input.allowNegativeStock ?? false;
  const normalizedCode = input.code.trim().toUpperCase();

  // If the branch only has an unused auto-provisioned default warehouse (`WH-*-DEF`)
  // and this warehouse is marked primary for the branch, promote/customize it in place
  // so legacy single-warehouse branch setups keep a single canonical warehouse ID.
  if (branchId && (input.isPrimaryForBranch ?? true)) {
    const autoDef = await trx.db
      .selectFrom('warehouses')
      .select(['id', 'code'])
      .where('tenant_id', '=', trx.tenantId)
      .where('branch_id', '=', branchId)
      .where('is_active', '=', true)
      .where('code', 'like', 'WH-%-DEF')
      .executeTakeFirst();

    if (autoDef) {
      const [hasLedger, hasBal, hasBatch, hasSerial, hasReg] = await Promise.all([
        trx.db.selectFrom('stock_ledger_entries').select('id').where('warehouse_id', '=', autoDef.id).limit(1).executeTakeFirst(),
        trx.db.selectFrom('inventory_balances').select('id').where('warehouse_id', '=', autoDef.id).limit(1).executeTakeFirst(),
        trx.db.selectFrom('inventory_batches').select('id').where('warehouse_id', '=', autoDef.id).limit(1).executeTakeFirst(),
        trx.db.selectFrom('inventory_serials').select('id').where('warehouse_id', '=', autoDef.id).limit(1).executeTakeFirst(),
        trx.db.selectFrom('pos_registers').select('id').where('warehouse_id', '=', autoDef.id).limit(1).executeTakeFirst(),
      ]);

      if (!hasLedger && !hasBal && !hasBatch && !hasSerial && !hasReg) {
        await trx.db
          .updateTable('warehouses')
          .set({
            code: normalizedCode,
            name: input.name,
            allow_negative_stock: allowNegativeStock,
            updated_at: new Date(),
          })
          .where('tenant_id', '=', trx.tenantId)
          .where('id', '=', autoDef.id)
          .execute();

        await appendAuditLog(trx, {
          action: 'ORG_WAREHOUSE_CREATED',
          resourceType: 'WAREHOUSE',
          resourceId: autoDef.id,
          metadata: {
            branchId,
            code: normalizedCode,
            name: input.name,
            allowNegativeStock,
            promotedFromAutoDefault: autoDef.code,
          },
        });

        return {
          id: autoDef.id,
          tenantId: trx.tenantId,
          branchId,
          code: normalizedCode,
          name: input.name,
          allowNegativeStock,
          isActive: true,
        };
      }
    }
  }

  const warehouseId = generateUuidV7();

  await trx.db
    .insertInto('warehouses')
    .values({
      id: warehouseId,
      tenant_id: trx.tenantId,
      branch_id: branchId,
      code: normalizedCode,
      name: input.name,
      allow_negative_stock: allowNegativeStock,
      is_active: true,
    })
    .execute();

  if (branchId) {
    const isPrimary = input.isPrimaryForBranch ?? true;
    if (isPrimary) {
      await trx.db
        .updateTable('branch_warehouse_links')
        .set({ is_primary: false })
        .where('tenant_id', '=', trx.tenantId)
        .where('branch_id', '=', branchId)
        .execute();
    }

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

export async function updateWarehouse(
  trx: TenantTransactionContext,
  warehouseId: string,
  input: {
    readonly name?: string;
    readonly isActive?: boolean;
  },
): Promise<WarehouseDto> {
  const existing = await trx.db
    .selectFrom('warehouses')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', warehouseId)
    .executeTakeFirst();

  if (!existing) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'ERR_NOT_FOUND',
      title: 'Warehouse Not Found',
      detail: `Warehouse "${warehouseId}" was not found in tenant "${trx.tenantId}".`,
    });
  }

  await assertAuthorized(trx, {
    permission: 'org:branch:manage',
    branchId: existing.branch_id ?? undefined,
    warehouseId: existing.id,
  });

  await assertSubscriptionEntitlement(trx, { requireWriteAccess: true });

  const nextName = input.name !== undefined ? input.name.trim() : existing.name;
  if (!nextName) {
    throw new AppError({
      statusCode: 400,
      errorCode: 'ERR_VALIDATION_FAILED',
      title: 'Invalid Warehouse Name',
      detail: 'Warehouse name cannot be empty.',
    });
  }

  const nextIsActive =
    input.isActive !== undefined ? input.isActive : existing.is_active;

  await trx.db
    .updateTable('warehouses')
    .set({
      name: nextName,
      is_active: nextIsActive,
      updated_at: new Date(),
    })
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', warehouseId)
    .execute();

  await appendAuditLog(trx, {
    action: 'ORG_WAREHOUSE_UPDATED',
    resourceType: 'WAREHOUSE',
    resourceId: warehouseId,
    metadata: {
      previousName: existing.name,
      nextName,
      previousIsActive: existing.is_active,
      nextIsActive,
    },
  });

  return {
    id: existing.id,
    tenantId: existing.tenant_id,
    branchId: existing.branch_id,
    code: existing.code,
    name: nextName,
    allowNegativeStock: existing.allow_negative_stock,
    isActive: nextIsActive,
  };
}

export async function getTenantBranding(
  trx: TenantTransactionContext,
): Promise<TenantBrandingResponse> {
  await assertAuthorized(trx, { permission: 'org:branch:read' });
  await assertSubscriptionEntitlement(trx, { requireWriteAccess: false });

  const tenant = await trx.db
    .selectFrom('tenants')
    .select(['id', 'legal_name', 'shop_display_name', 'logo_url'])
    .where('id', '=', trx.tenantId)
    .executeTakeFirst();

  if (!tenant) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'ERR_NOT_FOUND',
      title: 'Tenant Not Found',
      detail: `Tenant "${trx.tenantId}" was not found.`,
    });
  }

  return {
    tenantId: tenant.id,
    name: tenant.legal_name,
    shopDisplayName: tenant.shop_display_name ?? null,
    logoUrl: tenant.logo_url ?? null,
  };
}

export async function updateTenantBranding(
  trx: TenantTransactionContext,
  input: UpdateTenantBrandingRequest,
): Promise<TenantBrandingResponse> {
  await assertAuthorized(trx, { permission: 'org:tenant:manage' });
  await assertSubscriptionEntitlement(trx, { requireWriteAccess: true });

  const existing = await trx.db
    .selectFrom('tenants')
    .select(['id', 'legal_name', 'shop_display_name', 'logo_url'])
    .where('id', '=', trx.tenantId)
    .forUpdate()
    .executeTakeFirst();

  if (!existing) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'ERR_NOT_FOUND',
      title: 'Tenant Not Found',
      detail: `Tenant "${trx.tenantId}" was not found.`,
    });
  }

  const nextDisplayName =
    input.shopDisplayName !== undefined
      ? input.shopDisplayName?.trim() || null
      : existing.shop_display_name ?? null;
  const nextLogoUrl =
    input.logoUrl !== undefined
      ? input.logoUrl?.trim() || null
      : existing.logo_url ?? null;

  await trx.db
    .updateTable('tenants')
    .set({
      shop_display_name: nextDisplayName,
      logo_url: nextLogoUrl,
      updated_at: new Date(),
    })
    .where('id', '=', trx.tenantId)
    .execute();

  await appendAuditLog(trx, {
    action: 'ORG_TENANT_BRANDING_UPDATED',
    resourceType: 'TENANT',
    resourceId: trx.tenantId,
    metadata: {
      previousShopDisplayName: existing.shop_display_name ?? null,
      nextShopDisplayName: nextDisplayName,
      previousLogoUrl: existing.logo_url ?? null,
      nextLogoUrl,
    },
  });

  return {
    tenantId: existing.id,
    name: existing.legal_name,
    shopDisplayName: nextDisplayName,
    logoUrl: nextLogoUrl,
  };
}

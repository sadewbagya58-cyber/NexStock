import {
  AppError,
  type TenantTransactionContext,
  appendAuditLog,
  generateUuidV7,
} from '../../shared/index.js';

export type SystemRoleCode =
  | 'TENANT_OWNER'
  | 'ORG_ADMIN'
  | 'BRANCH_MANAGER'
  | 'CASHIER'
  | 'WAREHOUSE_CLERK'
  | 'PURCHASER'
  | 'ACCOUNTANT';

export type PermissionKey =
  | 'org:tenant:manage'
  | 'org:branch:read'
  | 'org:branch:manage'
  | 'org:warehouse:read'
  | 'org:warehouse:manage'
  | 'org:register:read'
  | 'org:register:manage'
  | 'iam:member:read'
  | 'iam:member:manage'
  | 'iam:role:manage'
  | 'sub:subscription:read'
  | 'sub:subscription:manage'
  | 'sub:payment:record'
  | 'i18n:settings:read'
  | 'i18n:settings:manage'
  | 'i18n:fx:manage'
  | 'i18n:tax:manage';

const ALL_MILESTONE1_PERMISSIONS: readonly PermissionKey[] = [
  'org:tenant:manage',
  'org:branch:read',
  'org:branch:manage',
  'org:warehouse:read',
  'org:warehouse:manage',
  'org:register:read',
  'org:register:manage',
  'iam:member:read',
  'iam:member:manage',
  'iam:role:manage',
  'sub:subscription:read',
  'sub:subscription:manage',
  'sub:payment:record',
  'i18n:settings:read',
  'i18n:settings:manage',
  'i18n:fx:manage',
  'i18n:tax:manage',
];

export const SYSTEM_ROLE_DEFINITIONS: Readonly<
  Record<
    SystemRoleCode,
    { readonly name: string; readonly permissions: readonly PermissionKey[] }
  >
> = {
  TENANT_OWNER: {
    name: 'Tenant Owner',
    permissions: ALL_MILESTONE1_PERMISSIONS,
  },
  ORG_ADMIN: {
    name: 'Organization Administrator',
    permissions: ALL_MILESTONE1_PERMISSIONS.filter(
      (p) => p !== 'sub:payment:record',
    ),
  },
  BRANCH_MANAGER: {
    name: 'Branch Manager',
    permissions: [
      'org:branch:read',
      'org:branch:manage',
      'org:warehouse:read',
      'org:warehouse:manage',
      'org:register:read',
      'org:register:manage',
      'iam:member:read',
      'i18n:settings:read',
    ],
  },
  CASHIER: {
    name: 'POS Cashier',
    permissions: [
      'org:branch:read',
      'org:register:read',
      'i18n:settings:read',
    ],
  },
  WAREHOUSE_CLERK: {
    name: 'Warehouse Clerk',
    permissions: [
      'org:branch:read',
      'org:warehouse:read',
      'i18n:settings:read',
    ],
  },
  PURCHASER: {
    name: 'Purchasing Officer',
    permissions: [
      'org:branch:read',
      'org:warehouse:read',
      'i18n:settings:read',
    ],
  },
  ACCOUNTANT: {
    name: 'Accountant',
    permissions: [
      'org:branch:read',
      'org:warehouse:read',
      'sub:subscription:read',
      'sub:payment:record',
      'i18n:settings:read',
      'i18n:fx:manage',
      'i18n:tax:manage',
    ],
  },
};

export interface AuthorizedMemberContext {
  readonly membershipId: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly allLocationsAccess: boolean;
  readonly roleCodes: readonly string[];
  readonly permissions: ReadonlySet<string>;
  readonly allowedBranchIds: ReadonlySet<string>;
  readonly allowedWarehouseIds: ReadonlySet<string>;
}

export async function seedDefaultSystemRoles(
  trx: TenantTransactionContext,
): Promise<Readonly<Record<SystemRoleCode, string>>> {
  const roleIdMap = {} as Record<SystemRoleCode, string>;

  for (const [code, def] of Object.entries(SYSTEM_ROLE_DEFINITIONS) as [
    SystemRoleCode,
    (typeof SYSTEM_ROLE_DEFINITIONS)[SystemRoleCode],
  ][]) {
    const existing = await trx.db
      .selectFrom('roles')
      .select(['id'])
      .where('tenant_id', '=', trx.tenantId)
      .where('code', '=', code)
      .executeTakeFirst();

    const roleId = existing?.id ?? generateUuidV7();
    if (!existing) {
      await trx.db
        .insertInto('roles')
        .values({
          id: roleId,
          tenant_id: trx.tenantId,
          code,
          name: def.name,
          is_system_role: true,
        })
        .execute();
    }

    roleIdMap[code] = roleId;

    for (const permKey of def.permissions) {
      const existingPerm = await trx.db
        .selectFrom('role_permissions')
        .select(['id'])
        .where('tenant_id', '=', trx.tenantId)
        .where('role_id', '=', roleId)
        .where('permission_key', '=', permKey)
        .executeTakeFirst();

      if (!existingPerm) {
        await trx.db
          .insertInto('role_permissions')
          .values({
            id: generateUuidV7(),
            tenant_id: trx.tenantId,
            role_id: roleId,
            permission_key: permKey,
          })
          .execute();
      }
    }
  }

  return roleIdMap;
}

export async function ensureUserRecord(
  trx: TenantTransactionContext,
  input: {
    readonly userId: string;
    readonly email: string;
    readonly fullName: string;
  },
): Promise<void> {
  const existing = await trx.db
    .selectFrom('users')
    .select(['id'])
    .where('id', '=', input.userId)
    .executeTakeFirst();

  if (!existing) {
    await trx.db
      .insertInto('users')
      .values({
        id: input.userId,
        email: input.email.trim().toLowerCase(),
        full_name: input.fullName,
        is_platform_admin: false,
      })
      .execute();
  }
}

export async function provisionTenantMember(
  trx: TenantTransactionContext,
  input: {
    readonly userId: string;
    readonly email: string;
    readonly fullName: string;
    readonly roleCodes: readonly SystemRoleCode[];
    readonly allLocationsAccess: boolean;
    readonly branchIds?: readonly string[] | undefined;
    readonly warehouseIds?: readonly string[] | undefined;
    readonly status?: 'INVITED' | 'ACTIVE' | 'DISABLED' | undefined;
  },
): Promise<{
  readonly membershipId: string;
  readonly userId: string;
  readonly tenantId: string;
  readonly status: 'INVITED' | 'ACTIVE' | 'DISABLED';
  readonly allLocationsAccess: boolean;
  readonly roleCodes: readonly SystemRoleCode[];
  readonly branchIds: readonly string[];
  readonly warehouseIds: readonly string[];
}> {
  await ensureUserRecord(trx, {
    userId: input.userId,
    email: input.email,
    fullName: input.fullName,
  });

  const existingMembership = await trx.db
    .selectFrom('tenant_memberships')
    .select(['id'])
    .where('tenant_id', '=', trx.tenantId)
    .where('user_id', '=', input.userId)
    .executeTakeFirst();

  const membershipId = existingMembership?.id ?? generateUuidV7();
  const status = input.status ?? 'ACTIVE';

  if (existingMembership) {
    await trx.db
      .updateTable('tenant_memberships')
      .set({
        status,
        all_locations_access: input.allLocationsAccess,
        updated_at: new Date(),
      })
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', membershipId)
      .execute();
  } else {
    await trx.db
      .insertInto('tenant_memberships')
      .values({
        id: membershipId,
        tenant_id: trx.tenantId,
        user_id: input.userId,
        status,
        all_locations_access: input.allLocationsAccess,
        pin_hash: null,
      })
      .execute();
  }

  // Replace role assignments for deterministic state
  await trx.db
    .deleteFrom('member_role_assignments')
    .where('tenant_id', '=', trx.tenantId)
    .where('membership_id', '=', membershipId)
    .execute();

  for (const roleCode of input.roleCodes) {
    const roleRow = await trx.db
      .selectFrom('roles')
      .select(['id'])
      .where('tenant_id', '=', trx.tenantId)
      .where('code', '=', roleCode)
      .executeTakeFirst();

    if (!roleRow) {
      throw new AppError({
        statusCode: 404,
        errorCode: 'ERR_NOT_FOUND',
        title: 'Role Not Found',
        detail: `Role "${roleCode}" was not found in tenant "${trx.tenantId}".`,
      });
    }

    await trx.db
      .insertInto('member_role_assignments')
      .values({
        id: generateUuidV7(),
        tenant_id: trx.tenantId,
        membership_id: membershipId,
        role_id: roleRow.id,
      })
      .execute();
  }

  // Replace location scopes
  await trx.db
    .deleteFrom('member_location_scopes')
    .where('tenant_id', '=', trx.tenantId)
    .where('membership_id', '=', membershipId)
    .execute();

  const branchIds = input.branchIds ?? [];
  const warehouseIds = input.warehouseIds ?? [];

  for (const branchId of branchIds) {
    await trx.db
      .insertInto('member_location_scopes')
      .values({
        id: generateUuidV7(),
        tenant_id: trx.tenantId,
        membership_id: membershipId,
        branch_id: branchId,
        warehouse_id: null,
      })
      .execute();
  }

  for (const warehouseId of warehouseIds) {
    await trx.db
      .insertInto('member_location_scopes')
      .values({
        id: generateUuidV7(),
        tenant_id: trx.tenantId,
        membership_id: membershipId,
        branch_id: null,
        warehouse_id: warehouseId,
      })
      .execute();
  }

  await appendAuditLog(trx, {
    action: 'IAM_MEMBER_PROVISIONED',
    resourceType: 'TENANT_MEMBERSHIP',
    resourceId: membershipId,
    metadata: {
      targetUserId: input.userId,
      status,
      allLocationsAccess: input.allLocationsAccess,
      roleCodes: input.roleCodes,
      branchIds,
      warehouseIds,
    },
  });

  return {
    membershipId,
    userId: input.userId,
    tenantId: trx.tenantId,
    status,
    allLocationsAccess: input.allLocationsAccess,
    roleCodes: input.roleCodes,
    branchIds,
    warehouseIds,
  };
}

/**
 * Loads the authenticated user's membership, roles, permissions, and location scopes
 * within the current tenant transaction.
 */
export async function resolveMemberAuthorizationContext(
  trx: TenantTransactionContext,
): Promise<AuthorizedMemberContext> {
  const membership = await trx.db
    .selectFrom('tenant_memberships')
    .select(['id', 'status', 'all_locations_access'])
    .where('tenant_id', '=', trx.tenantId)
    .where('user_id', '=', trx.userId)
    .executeTakeFirst();

  if (!membership || membership.status !== 'ACTIVE') {
    throw new AppError({
      statusCode: 403,
      errorCode: 'IAM_TENANT_MEMBERSHIP_REQUIRED',
      title: 'Active Tenant Membership Required',
      detail: `User "${trx.userId}" does not hold an active membership in tenant "${trx.tenantId}".`,
    });
  }

  const assignedRoles = await trx.db
    .selectFrom('member_role_assignments')
    .innerJoin('roles', (join) =>
      join
        .onRef('roles.tenant_id', '=', 'member_role_assignments.tenant_id')
        .onRef('roles.id', '=', 'member_role_assignments.role_id'),
    )
    .select(['roles.id as role_id', 'roles.code as role_code'])
    .where('member_role_assignments.tenant_id', '=', trx.tenantId)
    .where('member_role_assignments.membership_id', '=', membership.id)
    .execute();

  const roleIds = assignedRoles.map((r) => r.role_id);
  const roleCodes = assignedRoles.map((r) => r.role_code);

  const permissions = new Set<string>();
  if (roleIds.length > 0) {
    const permRows = await trx.db
      .selectFrom('role_permissions')
      .select(['permission_key'])
      .where('tenant_id', '=', trx.tenantId)
      .where('role_id', 'in', roleIds)
      .execute();

    for (const p of permRows) {
      permissions.add(p.permission_key);
    }
  }

  const allowedBranchIds = new Set<string>();
  const allowedWarehouseIds = new Set<string>();

  if (!membership.all_locations_access) {
    const scopeRows = await trx.db
      .selectFrom('member_location_scopes')
      .select(['branch_id', 'warehouse_id'])
      .where('tenant_id', '=', trx.tenantId)
      .where('membership_id', '=', membership.id)
      .execute();

    for (const row of scopeRows) {
      if (row.branch_id) {
        allowedBranchIds.add(row.branch_id);
      }
      if (row.warehouse_id) {
        allowedWarehouseIds.add(row.warehouse_id);
      }
    }
  }

  return {
    membershipId: membership.id,
    tenantId: trx.tenantId,
    userId: trx.userId,
    allLocationsAccess: membership.all_locations_access,
    roleCodes,
    permissions,
    allowedBranchIds,
    allowedWarehouseIds,
  };
}

/**
 * Enforces NexStock's 3-Dimensional Authorization Model (NEX-DOC-06 Section 3):
 *   1. Tenant Isolation (Active `tenant_memberships` record)
 *   2. Permission Grant (`permission` present in member's assigned `role_permissions`)
 *   3. Location Scope (`all_locations_access` OR explicit `branchId` / `warehouseId` grant)
 */
export async function assertAuthorized(
  trx: TenantTransactionContext,
  requirements: {
    readonly permission: PermissionKey;
    readonly branchId?: string | undefined;
    readonly warehouseId?: string | undefined;
    readonly requireAllLocationsAccess?: boolean | undefined;
  },
): Promise<AuthorizedMemberContext> {
  const ctx = await resolveMemberAuthorizationContext(trx);

  if (!ctx.permissions.has(requirements.permission)) {
    throw new AppError({
      statusCode: 403,
      errorCode: 'IAM_PERMISSION_DENIED',
      title: 'Insufficient Role Permissions',
      detail: `User "${trx.userId}" lacks required permission "${requirements.permission}".`,
      extensions: {
        requiredPermission: requirements.permission,
        assignedRoles: ctx.roleCodes,
      },
    });
  }

  if (requirements.requireAllLocationsAccess && !ctx.allLocationsAccess) {
    throw new AppError({
      statusCode: 403,
      errorCode: 'IAM_LOCATION_SCOPE_DENIED',
      title: 'Organization-Wide Location Scope Required',
      detail: `Operation requires organization-wide location access ("all_locations_access = true").`,
    });
  }

  if (!ctx.allLocationsAccess) {
    if (
      requirements.branchId &&
      !ctx.allowedBranchIds.has(requirements.branchId)
    ) {
      throw new AppError({
        statusCode: 403,
        errorCode: 'IAM_LOCATION_SCOPE_DENIED',
        title: 'Branch Location Scope Denied',
        detail: `User "${trx.userId}" is not authorized to access or mutate branch "${requirements.branchId}".`,
        extensions: { branchId: requirements.branchId },
      });
    }

    if (
      requirements.warehouseId &&
      !ctx.allowedWarehouseIds.has(requirements.warehouseId)
    ) {
      throw new AppError({
        statusCode: 403,
        errorCode: 'IAM_LOCATION_SCOPE_DENIED',
        title: 'Warehouse Location Scope Denied',
        detail: `User "${trx.userId}" is not authorized to access or mutate warehouse "${requirements.warehouseId}".`,
        extensions: { warehouseId: requirements.warehouseId },
      });
    }
  }

  return ctx;
}

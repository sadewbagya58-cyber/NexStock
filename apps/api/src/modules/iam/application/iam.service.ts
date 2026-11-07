import * as crypto from 'node:crypto';
import type {
  AcceptInvitationRequest,
  CreateRoleRequest,
  InviteStaffRequest,
  LoginResponse,
  MemberPermissionsResponse,
  MemberSummaryResponse,
  PermissionAction,
  PermissionItem,
  PermissionsCatalogResponse,
  RoleDetailResponse,
  RoleSummaryResponse,
  StaffInvitationResponse,
  UpdateMemberLocationScopesRequest,
  UpdateRoleRequest,
  ValidateInvitationCodeRequest,
  ValidateInvitationResponse,
} from '@nexstock/contracts';
import { type Kysely, sql } from 'kysely';
import {
  AppError,
  type NexStockDatabase,
  type TenantTransactionContext,
  appendAuditLog,
  generateUuidV7,
  sanitizeLogMessage,
  withAppUserTransaction,
  withTenantTransaction,
} from '../../shared/index.js';
import { DEFAULT_SUPABASE_URL, signDevJwt } from '../domain/jwt-verifier.js';
import {
  type AuthServiceConfig,
  ensureUserRecordDirect,
  getUserProfileAndMemberships,
} from './auth.service.js';

export {
  type SystemRoleCode,
  type PermissionKey,
  PERMISSIONS_CATALOG,
  ALL_SYSTEM_PERMISSIONS,
  SYSTEM_ROLE_DESCRIPTIONS,
  SYSTEM_ROLE_DEFINITIONS,
} from '../domain/system-roles.js';
import {
  type SystemRoleCode,
  type PermissionKey,
  PERMISSIONS_CATALOG,
  ALL_SYSTEM_PERMISSIONS,
  SYSTEM_ROLE_DESCRIPTIONS,
  SYSTEM_ROLE_DEFINITIONS,
} from '../domain/system-roles.js';

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
    const desc = SYSTEM_ROLE_DESCRIPTIONS[code];
    if (!existing) {
      await trx.db
        .insertInto('roles')
        .values({
          id: roleId,
          tenant_id: trx.tenantId,
          code,
          name: def.name,
          description: desc,
          is_system_role: true,
        })
        .execute();
    } else {
      await trx.db
        .updateTable('roles')
        .set({
          name: def.name,
          description: desc,
        })
        .where('tenant_id', '=', trx.tenantId)
        .where('id', '=', roleId)
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
    let roleRow = await trx.db
      .selectFrom('roles')
      .select(['id'])
      .where('tenant_id', '=', trx.tenantId)
      .where('code', '=', roleCode)
      .executeTakeFirst();

    if (!roleRow && roleCode in SYSTEM_ROLE_DEFINITIONS) {
      const def = SYSTEM_ROLE_DEFINITIONS[roleCode as SystemRoleCode];
      const desc = SYSTEM_ROLE_DESCRIPTIONS[roleCode as SystemRoleCode];
      const newRoleId = generateUuidV7();
      await trx.db
        .insertInto('roles')
        .values({
          id: newRoleId,
          tenant_id: trx.tenantId,
          code: roleCode,
          name: def.name,
          description: desc,
          is_system_role: true,
        })
        .execute();
      roleRow = { id: newRoleId };
    }

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

  trx._trxCache?.clear();

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
  const cacheKey = `authCtx:${trx.tenantId}:${trx.userId}`;
  const cached = trx._trxCache?.get(cacheKey) as
    | AuthorizedMemberContext
    | undefined;
  if (cached) {
    return cached;
  }

  const membershipAndRoles = await trx.db
    .selectFrom('tenant_memberships')
    .leftJoin('member_role_assignments', (join) =>
      join
        .onRef('member_role_assignments.tenant_id', '=', 'tenant_memberships.tenant_id')
        .onRef('member_role_assignments.membership_id', '=', 'tenant_memberships.id'),
    )
    .leftJoin('roles', (join) =>
      join
        .onRef('roles.tenant_id', '=', 'member_role_assignments.tenant_id')
        .onRef('roles.id', '=', 'member_role_assignments.role_id'),
    )
    .select([
      'tenant_memberships.id as membership_id',
      'tenant_memberships.status as status',
      'tenant_memberships.all_locations_access as all_locations_access',
      'roles.id as role_id',
      'roles.code as role_code',
      'roles.is_system_role as is_system_role',
    ])
    .where('tenant_memberships.tenant_id', '=', trx.tenantId)
    .where('tenant_memberships.user_id', '=', trx.userId)
    .execute();

  const firstRow = membershipAndRoles[0];
  if (!firstRow || firstRow.status !== 'ACTIVE') {
    throw new AppError({
      statusCode: 403,
      errorCode: 'IAM_TENANT_MEMBERSHIP_REQUIRED',
      title: 'Active Tenant Membership Required',
      detail: 'Active organization membership required to perform this action.',
    });
  }

  const membership = {
    id: firstRow.membership_id,
    status: firstRow.status,
    all_locations_access: firstRow.all_locations_access,
  };

  const assignedRoles: Array<{
    role_id: string;
    role_code: string;
    is_system_role: boolean;
  }> = [];
  const seenRoleIds = new Set<string>();
  for (const r of membershipAndRoles) {
    if (r.role_id && r.role_code && !seenRoleIds.has(r.role_id)) {
      seenRoleIds.add(r.role_id);
      assignedRoles.push({
        role_id: r.role_id,
        role_code: r.role_code,
        is_system_role: Boolean(r.is_system_role),
      });
    }
  }

  const roleIds = assignedRoles.map((r) => r.role_id);
  const roleCodes = assignedRoles.map((r) => r.role_code);

  const [permRows, scopeRows] = await Promise.all([
    roleIds.length > 0
      ? trx.db
          .selectFrom('role_permissions')
          .select(['permission_key', 'role_id'])
          .where('tenant_id', '=', trx.tenantId)
          .where('role_id', 'in', roleIds)
          .execute()
      : Promise.resolve([]),
    !membership.all_locations_access
      ? trx.db
          .selectFrom('member_location_scopes')
          .select(['branch_id', 'warehouse_id'])
          .where('tenant_id', '=', trx.tenantId)
          .where('membership_id', '=', membership.id)
          .execute()
      : Promise.resolve([]),
  ]);

  const permissions = new Set<string>();
  if (roleIds.length > 0) {
    for (const p of permRows) {
      permissions.add(p.permission_key);
    }

    // Auto-heal / synchronize missing permissions for built-in system roles
    const missingRolePerms: Array<{
      id: string;
      tenant_id: string;
      role_id: string;
      permission_key: string;
    }> = [];

    for (const role of assignedRoles) {
      if (role.is_system_role && role.role_code in SYSTEM_ROLE_DEFINITIONS) {
        const sysDef = SYSTEM_ROLE_DEFINITIONS[role.role_code as SystemRoleCode];
        for (const permKey of sysDef.permissions) {
          permissions.add(permKey);
          const alreadyInDb = permRows.some(
            (r) => r.role_id === role.role_id && r.permission_key === permKey,
          );
          if (!alreadyInDb) {
            missingRolePerms.push({
              id: generateUuidV7(),
              tenant_id: trx.tenantId,
              role_id: role.role_id,
              permission_key: permKey,
            });
          }
        }
      }
    }

    if (missingRolePerms.length > 0) {
      await trx.db
        .insertInto('role_permissions')
        .values(missingRolePerms)
        .onConflict((oc) =>
          oc.columns(['tenant_id', 'role_id', 'permission_key']).doNothing(),
        )
        .execute()
        .catch(() => {});
    }
  }

  // Owners and Admins always enjoy organization-wide location access
  const isOwnerOrAdmin =
    roleCodes.includes('TENANT_OWNER') || roleCodes.includes('ORG_ADMIN');
  const effectiveAllLocationsAccess = Boolean(
    membership.all_locations_access || isOwnerOrAdmin,
  );

  const allowedBranchIds = new Set<string>();
  const allowedWarehouseIds = new Set<string>();

  if (!effectiveAllLocationsAccess) {
    for (const row of scopeRows) {
      if (row.branch_id) {
        allowedBranchIds.add(row.branch_id);
      }
      if (row.warehouse_id) {
        allowedWarehouseIds.add(row.warehouse_id);
      }
    }

    // Auto-heal location scope if no explicit scope is configured:
    // 1. Fallback to linked employee primary branch
    if (allowedBranchIds.size === 0) {
      const linkedEmployee = await trx.db
        .selectFrom('employees')
        .select(['primary_branch_id'])
        .where('tenant_id', '=', trx.tenantId)
        .where('linked_user_id', '=', trx.userId)
        .where('employment_status', '=', 'ACTIVE')
        .executeTakeFirst();

      if (linkedEmployee?.primary_branch_id) {
        allowedBranchIds.add(linkedEmployee.primary_branch_id);
      }
    }

    // 2. Fallback to single active tenant branch if tenant only has 1 branch
    if (allowedBranchIds.size === 0) {
      const tenantBranches = await trx.db
        .selectFrom('branches')
        .select(['id'])
        .where('tenant_id', '=', trx.tenantId)
        .where('is_active', '=', true)
        .limit(2)
        .execute();

      if (tenantBranches.length === 1 && tenantBranches[0]) {
        allowedBranchIds.add(tenantBranches[0].id);
      }
    }

    if (allowedBranchIds.size > 0) {
      const branchIdList = [...allowedBranchIds];
      const [branchWarehouses, linkedWarehouses] = await Promise.all([
        trx.db
          .selectFrom('warehouses')
          .select(['id'])
          .where('tenant_id', '=', trx.tenantId)
          .where('branch_id', 'in', branchIdList)
          .execute(),
        trx.db
          .selectFrom('branch_warehouse_links')
          .select(['warehouse_id'])
          .where('tenant_id', '=', trx.tenantId)
          .where('branch_id', 'in', branchIdList)
          .execute(),
      ]);

      for (const wh of branchWarehouses) {
        allowedWarehouseIds.add(wh.id);
      }
      for (const link of linkedWarehouses) {
        allowedWarehouseIds.add(link.warehouse_id);
      }
    }
  }

  const authCtx: AuthorizedMemberContext = {
    membershipId: membership.id,
    tenantId: trx.tenantId,
    userId: trx.userId,
    allLocationsAccess: effectiveAllLocationsAccess,
    roleCodes,
    permissions,
    allowedBranchIds,
    allowedWarehouseIds,
  };

  trx._trxCache?.set(cacheKey, authCtx);
  return authCtx;
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
      detail: `You do not have permission to perform this action. Required permission: ${requirements.permission}. Contact your administrator.`,
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
      detail: 'Operation requires organization-wide location access. Contact your administrator.',
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
        detail: 'You do not have access to this store branch. Contact your administrator if you need access.',
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
        detail: 'You do not have access to this warehouse. Contact your administrator if you need access.',
        extensions: { warehouseId: requirements.warehouseId },
      });
    }
  }

  return ctx;
}

export async function getEffectiveMemberPermissions(
  trx: TenantTransactionContext,
): Promise<MemberPermissionsResponse> {
  const ctx = await resolveMemberAuthorizationContext(trx);
  const isOwner = ctx.roleCodes.includes('TENANT_OWNER');
  const primaryRole = ctx.roleCodes[0] || (isOwner ? 'TENANT_OWNER' : 'STAFF');
  return {
    membershipId: ctx.membershipId,
    status: 'ACTIVE',
    role: primaryRole,
    roles: ctx.roleCodes.length > 0 ? [...ctx.roleCodes] : [primaryRole],
    permissions: Array.from(ctx.permissions),
    allLocationsAccess: ctx.allLocationsAccess,
    allowedBranchIds: ctx.allLocationsAccess
      ? null
      : Array.from(ctx.allowedBranchIds),
    allowedWarehouseIds: ctx.allLocationsAccess
      ? null
      : Array.from(ctx.allowedWarehouseIds),
  };
}

// ============================================================================
// Phase 7.2: Advanced Permissions & Granular Role Management Services
// ============================================================================

export function getPermissionsCatalog(): PermissionsCatalogResponse {
  const moduleMap = new Map<string, PermissionItem[]>();
  for (const p of PERMISSIONS_CATALOG) {
    const existing = moduleMap.get(p.module) ?? [];
    existing.push({
      key: p.key,
      name: p.name,
      module: p.module,
      action: p.action as PermissionAction,
      description: p.description,
    });
    moduleMap.set(p.module, existing);
  }

  const modules = Array.from(moduleMap.entries()).map(([module, permissions]) => ({
    module,
    permissions,
  }));

  return {
    modules,
    allKeys: ALL_SYSTEM_PERMISSIONS.slice(),
  };
}

export async function listRoles(
  trx: TenantTransactionContext,
): Promise<RoleSummaryResponse[]> {
  await assertAuthorized(trx, { permission: 'iam:member:read' });

  const [roleRows, memberAssignments, rolePermRows] = await Promise.all([
    trx.db
      .selectFrom('roles')
      .selectAll()
      .where('tenant_id', '=', trx.tenantId)
      .orderBy('is_system_role', 'desc')
      .orderBy('name', 'asc')
      .execute(),
    trx.db
      .selectFrom('member_role_assignments')
      .select(['role_id'])
      .where('tenant_id', '=', trx.tenantId)
      .execute(),
    trx.db
      .selectFrom('role_permissions')
      .select(['role_id', 'permission_key'])
      .where('tenant_id', '=', trx.tenantId)
      .execute(),
  ]);

  const memberCountMap = new Map<string, number>();
  for (const m of memberAssignments) {
    memberCountMap.set(m.role_id, (memberCountMap.get(m.role_id) ?? 0) + 1);
  }

  const permCountMap = new Map<string, number>();
  for (const p of rolePermRows) {
    permCountMap.set(p.role_id, (permCountMap.get(p.role_id) ?? 0) + 1);
  }

  return roleRows.map((r) => {
    let permsCount = permCountMap.get(r.id) ?? 0;
    if (r.is_system_role && r.code in SYSTEM_ROLE_DEFINITIONS) {
      permsCount = SYSTEM_ROLE_DEFINITIONS[r.code as SystemRoleCode].permissions.length;
    }

    const item: RoleSummaryResponse = {
      id: r.id,
      tenantId: r.tenant_id,
      code: r.code,
      name: r.name,
      description: r.description ?? (SYSTEM_ROLE_DESCRIPTIONS[r.code as SystemRoleCode] || null),
      isSystemRole: Boolean(r.is_system_role),
      memberCount: memberCountMap.get(r.id) ?? 0,
      permissionsCount: permsCount,
      createdAt: r.created_at.toISOString(),
      ...(r.updated_at ? { updatedAt: r.updated_at.toISOString() } : {}),
    };
    return item;
  });
}

export async function getRoleById(
  trx: TenantTransactionContext,
  roleId: string,
): Promise<RoleDetailResponse> {
  await assertAuthorized(trx, { permission: 'iam:member:read' });

  const role = await trx.db
    .selectFrom('roles')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', roleId)
    .executeTakeFirst();

  if (!role) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'IAM_ROLE_NOT_FOUND',
      title: 'Role Not Found',
      detail: `Role "${roleId}" was not found in tenant "${trx.tenantId}".`,
    });
  }

  const memberRows = await trx.db
    .selectFrom('member_role_assignments')
    .select(['id'])
    .where('tenant_id', '=', trx.tenantId)
    .where('role_id', '=', roleId)
    .execute();

  const permKeys = new Set<string>();
  if (role.is_system_role && role.code in SYSTEM_ROLE_DEFINITIONS) {
    for (const p of SYSTEM_ROLE_DEFINITIONS[role.code as SystemRoleCode].permissions) {
      permKeys.add(p);
    }
  } else {
    const rolePerms = await trx.db
      .selectFrom('role_permissions')
      .select(['permission_key'])
      .where('tenant_id', '=', trx.tenantId)
      .where('role_id', '=', roleId)
      .execute();

    for (const p of rolePerms) {
      permKeys.add(p.permission_key);
    }
  }

  const detail: RoleDetailResponse = {
    id: role.id,
    tenantId: role.tenant_id,
    code: role.code,
    name: role.name,
    description: role.description ?? (SYSTEM_ROLE_DESCRIPTIONS[role.code as SystemRoleCode] || null),
    isSystemRole: Boolean(role.is_system_role),
    memberCount: memberRows.length,
    permissions: Array.from(permKeys),
    createdAt: role.created_at.toISOString(),
    ...(role.updated_at ? { updatedAt: role.updated_at.toISOString() } : {}),
  };
  return detail;
}

export async function createRole(
  trx: TenantTransactionContext,
  input: CreateRoleRequest,
): Promise<RoleDetailResponse> {
  await assertAuthorized(trx, { permission: 'iam:role:manage' });

  const code = input.code.trim().toUpperCase();

  const reservedCodes = new Set([
    'TENANT_OWNER',
    'ORG_ADMIN',
    'BRANCH_MANAGER',
    'CASHIER',
    'WAREHOUSE_CLERK',
    'PURCHASER',
    'ACCOUNTANT',
  ]);

  if (reservedCodes.has(code)) {
    throw new AppError({
      statusCode: 422,
      errorCode: 'IAM_RESERVED_ROLE_CODE',
      title: 'Reserved Role Code',
      detail: `Role code "${code}" is reserved for built-in system roles.`,
    });
  }

  const existingCode = await trx.db
    .selectFrom('roles')
    .select(['id'])
    .where('tenant_id', '=', trx.tenantId)
    .where('code', '=', code)
    .executeTakeFirst();

  if (existingCode) {
    throw new AppError({
      statusCode: 409,
      errorCode: 'IAM_DUPLICATE_ROLE_CODE',
      title: 'Duplicate Role Code',
      detail: `A role with code "${code}" already exists in this organization.`,
    });
  }

  // Privilege Escalation Guard: Actor must possess all permissions being granted
  const actorContext = await resolveMemberAuthorizationContext(trx);
  const unauthorizedPerms = input.permissions.filter((p) => !actorContext.permissions.has(p));
  if (unauthorizedPerms.length > 0) {
    throw new AppError({
      statusCode: 403,
      errorCode: 'IAM_PRIVILEGE_ESCALATION_DENIED',
      title: 'Privilege Escalation Denied',
      detail: `You cannot grant permissions you do not possess: ${unauthorizedPerms.join(', ')}.`,
    });
  }

  const roleId = generateUuidV7();
  const validPermissions = Array.from(new Set(input.permissions));

  await trx.db
    .insertInto('roles')
    .values({
      id: roleId,
      tenant_id: trx.tenantId,
      code,
      name: input.name.trim(),
      description: input.description ? input.description.trim() : null,
      is_system_role: false,
    })
    .execute();

  for (const permKey of validPermissions) {
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

  await appendAuditLog(trx, {
    action: 'iam.role.created',
    resourceType: 'role',
    resourceId: roleId,
    metadata: {
      code,
      name: input.name.trim(),
      permissionsCount: validPermissions.length,
    },
  });

  return getRoleById(trx, roleId);
}

export async function updateRole(
  trx: TenantTransactionContext,
  roleId: string,
  input: UpdateRoleRequest,
): Promise<RoleDetailResponse> {
  await assertAuthorized(trx, { permission: 'iam:role:manage' });

  const role = await trx.db
    .selectFrom('roles')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', roleId)
    .executeTakeFirst();

  if (!role) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'IAM_ROLE_NOT_FOUND',
      title: 'Role Not Found',
      detail: `Role "${roleId}" was not found in tenant "${trx.tenantId}".`,
    });
  }

  // Protect critical built-in roles from modification or permission edits
  if (role.is_system_role) {
    throw new AppError({
      statusCode: 403,
      errorCode: 'IAM_SYSTEM_ROLE_PROTECTED',
      title: 'Built-in System Role Protected',
      detail: `Built-in system role "${role.name}" (${role.code}) cannot be modified.`,
    });
  }

  // Privilege Escalation Guard
  if (input.permissions !== undefined) {
    const actorContext = await resolveMemberAuthorizationContext(trx);
    const unauthorizedPerms = input.permissions.filter((p) => !actorContext.permissions.has(p));
    if (unauthorizedPerms.length > 0) {
      throw new AppError({
        statusCode: 403,
        errorCode: 'IAM_PRIVILEGE_ESCALATION_DENIED',
        title: 'Privilege Escalation Denied',
        detail: `You cannot grant permissions you do not possess: ${unauthorizedPerms.join(', ')}.`,
      });
    }

    // Replace role permissions
    await trx.db
      .deleteFrom('role_permissions')
      .where('tenant_id', '=', trx.tenantId)
      .where('role_id', '=', roleId)
      .execute();

    const uniquePerms = Array.from(new Set(input.permissions));
    for (const permKey of uniquePerms) {
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

  const updatedName = input.name !== undefined ? input.name.trim() : role.name;
  const updatedDesc =
    input.description !== undefined
      ? input.description ? input.description.trim() : null
      : role.description;

  await trx.db
    .updateTable('roles')
    .set({
      name: updatedName,
      description: updatedDesc,
      updated_at: new Date(),
    })
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', roleId)
    .execute();

  await appendAuditLog(trx, {
    action: 'iam.role.updated',
    resourceType: 'role',
    resourceId: roleId,
    metadata: {
      name: updatedName,
      permissionsUpdated: input.permissions !== undefined,
    },
  });

  trx._trxCache?.clear();
  return getRoleById(trx, roleId);
}

export async function deleteRole(
  trx: TenantTransactionContext,
  roleId: string,
): Promise<{ readonly success: true; readonly roleId: string }> {
  await assertAuthorized(trx, { permission: 'iam:role:manage' });

  const role = await trx.db
    .selectFrom('roles')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', roleId)
    .executeTakeFirst();

  if (!role) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'IAM_ROLE_NOT_FOUND',
      title: 'Role Not Found',
      detail: `Role "${roleId}" was not found in tenant "${trx.tenantId}".`,
    });
  }

  if (role.is_system_role) {
    throw new AppError({
      statusCode: 403,
      errorCode: 'IAM_SYSTEM_ROLE_PROTECTED',
      title: 'Built-in System Role Protected',
      detail: `Built-in system role "${role.name}" (${role.code}) cannot be deleted.`,
    });
  }

  // Check if role is in active use
  const inUse = await trx.db
    .selectFrom('member_role_assignments')
    .select(['id'])
    .where('tenant_id', '=', trx.tenantId)
    .where('role_id', '=', roleId)
    .execute();

  if (inUse.length > 0) {
    throw new AppError({
      statusCode: 409,
      errorCode: 'IAM_ROLE_IN_USE',
      title: 'Role In Use',
      detail: `Cannot delete role "${role.name}" because it is currently assigned to ${inUse.length} member(s).`,
    });
  }

  await trx.db
    .deleteFrom('role_permissions')
    .where('tenant_id', '=', trx.tenantId)
    .where('role_id', '=', roleId)
    .execute();

  await trx.db
    .deleteFrom('roles')
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', roleId)
    .execute();

  await appendAuditLog(trx, {
    action: 'iam.role.deleted',
    resourceType: 'role',
    resourceId: roleId,
    metadata: {
      code: role.code,
      name: role.name,
    },
  });

  trx._trxCache?.clear();
  return { success: true, roleId };
}

export async function listMembers(
  trx: TenantTransactionContext,
): Promise<MemberSummaryResponse[]> {
  await assertAuthorized(trx, { permission: 'iam:member:read' });

  const [members, assignments, scopes, employees] = await Promise.all([
    trx.db
      .selectFrom('tenant_memberships')
      .innerJoin('users', 'users.id', 'tenant_memberships.user_id')
      .select([
        'tenant_memberships.id as membership_id',
        'tenant_memberships.tenant_id as tenant_id',
        'tenant_memberships.user_id as user_id',
        'users.email as email',
        'users.full_name as full_name',
        'tenant_memberships.status as status',
        'tenant_memberships.all_locations_access as all_locations_access',
        'tenant_memberships.created_at as created_at',
      ])
      .where('tenant_memberships.tenant_id', '=', trx.tenantId)
      .orderBy('tenant_memberships.created_at', 'asc')
      .execute(),
    trx.db
      .selectFrom('member_role_assignments')
      .innerJoin('roles', (join) =>
        join
          .onRef('roles.tenant_id', '=', 'member_role_assignments.tenant_id')
          .onRef('roles.id', '=', 'member_role_assignments.role_id'),
      )
      .select([
        'member_role_assignments.membership_id as membership_id',
        'roles.id as role_id',
        'roles.code as role_code',
        'roles.name as role_name',
        'roles.is_system_role as is_system_role',
      ])
      .where('member_role_assignments.tenant_id', '=', trx.tenantId)
      .execute(),
    trx.db
      .selectFrom('member_location_scopes')
      .select(['membership_id', 'branch_id', 'warehouse_id'])
      .where('tenant_id', '=', trx.tenantId)
      .execute(),
    trx.db
      .selectFrom('employees')
      .select([
        'id',
        'employee_code',
        'display_name',
        'designation',
        'department',
        'linked_user_id',
      ])
      .where('tenant_id', '=', trx.tenantId)
      .where('linked_user_id', 'is not', null)
      .execute(),
  ]);

  const roleMap = new Map<
    string,
    Array<{ id: string; code: string; name: string; isSystemRole: boolean }>
  >();
  for (const a of assignments) {
    const list = roleMap.get(a.membership_id) ?? [];
    list.push({
      id: a.role_id,
      code: a.role_code,
      name: a.role_name,
      isSystemRole: Boolean(a.is_system_role),
    });
    roleMap.set(a.membership_id, list);
  }

  const scopeMap = new Map<string, { branchIds: string[]; warehouseIds: string[] }>();
  for (const s of scopes) {
    const current = scopeMap.get(s.membership_id) ?? { branchIds: [], warehouseIds: [] };
    if (s.branch_id && !current.branchIds.includes(s.branch_id)) {
      current.branchIds.push(s.branch_id);
    }
    if (s.warehouse_id && !current.warehouseIds.includes(s.warehouse_id)) {
      current.warehouseIds.push(s.warehouse_id);
    }
    scopeMap.set(s.membership_id, current);
  }

  const employeeByUserId = new Map<
    string,
    { id: string; employeeCode: string; displayName: string; designation?: string; department?: string }
  >();
  for (const e of employees) {
    if (e.linked_user_id) {
      employeeByUserId.set(e.linked_user_id, {
        id: e.id,
        employeeCode: e.employee_code,
        displayName: e.display_name,
        designation: e.designation,
        department: e.department,
      });
    }
  }

  return members.map((m) => ({
    id: m.membership_id,
    tenantId: m.tenant_id,
    userId: m.user_id,
    email: m.email,
    fullName: m.full_name,
    status: m.status as 'INVITED' | 'ACTIVE' | 'DISABLED',
    allLocationsAccess: Boolean(m.all_locations_access),
    roles: roleMap.get(m.membership_id) ?? [],
    locationScopes: scopeMap.get(m.membership_id) ?? { branchIds: [], warehouseIds: [] },
    linkedEmployee: employeeByUserId.get(m.user_id) ?? null,
    createdAt: m.created_at.toISOString(),
  }));
}

export async function assignMemberRoles(
  trx: TenantTransactionContext,
  membershipId: string,
  roleIds: readonly string[],
): Promise<MemberSummaryResponse> {
  await assertAuthorized(trx, { permission: 'iam:member:manage' });

  const membership = await trx.db
    .selectFrom('tenant_memberships')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', membershipId)
    .executeTakeFirst();

  if (!membership) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'IAM_MEMBERSHIP_NOT_FOUND',
      title: 'Membership Not Found',
      detail: `Membership "${membershipId}" was not found in tenant "${trx.tenantId}".`,
    });
  }

  // Load target roles
  const uniqueRoleIds = Array.from(new Set(roleIds));
  const targetRoles = uniqueRoleIds.length > 0
    ? await trx.db
        .selectFrom('roles')
        .selectAll()
        .where('tenant_id', '=', trx.tenantId)
        .where('id', 'in', uniqueRoleIds)
        .execute()
    : [];

  if (targetRoles.length !== uniqueRoleIds.length) {
    throw new AppError({
      statusCode: 400,
      errorCode: 'IAM_INVALID_ROLE_ID',
      title: 'Invalid Role Assignment',
      detail: `One or more specified role IDs do not exist in this organization.`,
    });
  }

  // Check if member is currently an active TENANT_OWNER and whether this action removes it
  const currentOwnerRole = await trx.db
    .selectFrom('member_role_assignments')
    .innerJoin('roles', (join) =>
      join
        .onRef('roles.tenant_id', '=', 'member_role_assignments.tenant_id')
        .onRef('roles.id', '=', 'member_role_assignments.role_id'),
    )
    .select(['roles.code as role_code'])
    .where('member_role_assignments.tenant_id', '=', trx.tenantId)
    .where('member_role_assignments.membership_id', '=', membershipId)
    .where('roles.code', '=', 'TENANT_OWNER')
    .executeTakeFirst();

  const newIncludesOwner = targetRoles.some((r) => r.code === 'TENANT_OWNER');
  if (currentOwnerRole && !newIncludesOwner) {
    const otherOwners = await trx.db
      .selectFrom('member_role_assignments')
      .innerJoin('roles', (join) =>
        join
          .onRef('roles.tenant_id', '=', 'member_role_assignments.tenant_id')
          .onRef('roles.id', '=', 'member_role_assignments.role_id'),
      )
      .innerJoin(
        'tenant_memberships',
        'tenant_memberships.id',
        'member_role_assignments.membership_id',
      )
      .select(['tenant_memberships.id as membership_id'])
      .where('member_role_assignments.tenant_id', '=', trx.tenantId)
      .where('roles.code', '=', 'TENANT_OWNER')
      .where('tenant_memberships.status', '=', 'ACTIVE')
      .where('member_role_assignments.membership_id', '!=', membershipId)
      .execute();

    if (otherOwners.length === 0) {
      throw new AppError({
        statusCode: 422,
        errorCode: 'IAM_CANNOT_REMOVE_LAST_OWNER',
        title: 'Cannot Remove Last Owner',
        detail: `Cannot remove the Tenant Owner role because this member is the only active Owner in the organization.`,
      });
    }
  }

  // Privilege Escalation Guard: Actor must possess all permissions included in assigned roles
  const actorContext = await resolveMemberAuthorizationContext(trx);
  const requiredPerms = new Set<string>();
  const customRoleIdsToFetch: string[] = [];

  for (const role of targetRoles) {
    if (role.is_system_role && role.code in SYSTEM_ROLE_DEFINITIONS) {
      for (const p of SYSTEM_ROLE_DEFINITIONS[role.code as SystemRoleCode].permissions) {
        requiredPerms.add(p);
      }
    } else {
      customRoleIdsToFetch.push(role.id);
    }
  }

  if (customRoleIdsToFetch.length > 0) {
    const perms = await trx.db
      .selectFrom('role_permissions')
      .select(['permission_key'])
      .where('tenant_id', '=', trx.tenantId)
      .where('role_id', 'in', customRoleIdsToFetch)
      .execute();

    for (const p of perms) {
      requiredPerms.add(p.permission_key);
    }
  }

  const unauthorizedPerms = Array.from(requiredPerms).filter(
    (p) => !actorContext.permissions.has(p),
  );

  if (unauthorizedPerms.length > 0) {
    throw new AppError({
      statusCode: 403,
      errorCode: 'IAM_PRIVILEGE_ESCALATION_DENIED',
      title: 'Privilege Escalation Denied',
      detail: `You cannot assign roles granting permissions you do not possess: ${unauthorizedPerms.join(', ')}.`,
    });
  }

  // Replace member role assignments
  await trx.db
    .deleteFrom('member_role_assignments')
    .where('tenant_id', '=', trx.tenantId)
    .where('membership_id', '=', membershipId)
    .execute();

  for (const roleId of uniqueRoleIds) {
    await trx.db
      .insertInto('member_role_assignments')
      .values({
        id: generateUuidV7(),
        tenant_id: trx.tenantId,
        membership_id: membershipId,
        role_id: roleId,
      })
      .execute();
  }

  await appendAuditLog(trx, {
    action: 'iam.member.roles_updated',
    resourceType: 'membership',
    resourceId: membershipId,
    metadata: {
      roleIds: uniqueRoleIds,
      roleCodes: targetRoles.map((r) => r.code),
    },
  });

  trx._trxCache?.clear();
  const allMembers = await listMembers(trx);
  const updatedMember = allMembers.find((m) => m.id === membershipId);
  if (!updatedMember) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'IAM_MEMBERSHIP_NOT_FOUND',
      title: 'Membership Not Found',
      detail: `Membership "${membershipId}" disappeared unexpectedly.`,
    });
  }

  return updatedMember;
}

export async function removeMemberRole(
  trx: TenantTransactionContext,
  membershipId: string,
  roleId: string,
): Promise<MemberSummaryResponse> {
  await assertAuthorized(trx, { permission: 'iam:member:manage' });

  const role = await trx.db
    .selectFrom('roles')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', roleId)
    .executeTakeFirst();

  if (role && role.code === 'TENANT_OWNER') {
    const otherOwners = await trx.db
      .selectFrom('member_role_assignments')
      .innerJoin('roles', (join) =>
        join
          .onRef('roles.tenant_id', '=', 'member_role_assignments.tenant_id')
          .onRef('roles.id', '=', 'member_role_assignments.role_id'),
      )
      .innerJoin(
        'tenant_memberships',
        'tenant_memberships.id',
        'member_role_assignments.membership_id',
      )
      .select(['tenant_memberships.id as membership_id'])
      .where('member_role_assignments.tenant_id', '=', trx.tenantId)
      .where('roles.code', '=', 'TENANT_OWNER')
      .where('tenant_memberships.status', '=', 'ACTIVE')
      .where('member_role_assignments.membership_id', '!=', membershipId)
      .execute();

    if (otherOwners.length === 0) {
      throw new AppError({
        statusCode: 422,
        errorCode: 'IAM_CANNOT_REMOVE_LAST_OWNER',
        title: 'Cannot Remove Last Owner',
        detail: `Cannot remove the Tenant Owner role because this member is the only active Owner in the organization.`,
      });
    }
  }

  await trx.db
    .deleteFrom('member_role_assignments')
    .where('tenant_id', '=', trx.tenantId)
    .where('membership_id', '=', membershipId)
    .where('role_id', '=', roleId)
    .execute();

  await appendAuditLog(trx, {
    action: 'iam.member.role_removed',
    resourceType: 'membership',
    resourceId: membershipId,
    metadata: { roleId },
  });

  trx._trxCache?.clear();
  const allMembers = await listMembers(trx);
  const updatedMember = allMembers.find((m) => m.id === membershipId);
  if (!updatedMember) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'IAM_MEMBERSHIP_NOT_FOUND',
      title: 'Membership Not Found',
      detail: `Membership "${membershipId}" was not found.`,
    });
  }

  return updatedMember;
}

export async function updateMemberLocationScopes(
  trx: TenantTransactionContext,
  membershipId: string,
  input: UpdateMemberLocationScopesRequest,
): Promise<MemberSummaryResponse> {
  await assertAuthorized(trx, { permission: 'iam:member:manage' });

  const membership = await trx.db
    .selectFrom('tenant_memberships')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', membershipId)
    .executeTakeFirst();

  if (!membership) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'IAM_MEMBERSHIP_NOT_FOUND',
      title: 'Membership Not Found',
      detail: `Membership "${membershipId}" was not found in tenant "${trx.tenantId}".`,
    });
  }

  await trx.db
    .updateTable('tenant_memberships')
    .set({
      all_locations_access: input.allLocationsAccess,
      updated_at: new Date(),
    })
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', membershipId)
    .execute();

  await trx.db
    .deleteFrom('member_location_scopes')
    .where('tenant_id', '=', trx.tenantId)
    .where('membership_id', '=', membershipId)
    .execute();

  if (!input.allLocationsAccess) {
    const branchIds = input.branchIds ?? [];
    const warehouseIds = input.warehouseIds ?? [];

    for (const bId of branchIds) {
      await trx.db
        .insertInto('member_location_scopes')
        .values({
          id: generateUuidV7(),
          tenant_id: trx.tenantId,
          membership_id: membershipId,
          branch_id: bId,
          warehouse_id: null,
        })
        .execute();
    }

    for (const wId of warehouseIds) {
      await trx.db
        .insertInto('member_location_scopes')
        .values({
          id: generateUuidV7(),
          tenant_id: trx.tenantId,
          membership_id: membershipId,
          branch_id: null,
          warehouse_id: wId,
        })
        .execute();
    }
  }

  await appendAuditLog(trx, {
    action: 'iam.member.location_scopes_updated',
    resourceType: 'membership',
    resourceId: membershipId,
    metadata: {
      allLocationsAccess: input.allLocationsAccess,
      branchCount: (input.branchIds ?? []).length,
      warehouseCount: (input.warehouseIds ?? []).length,
    },
  });

  trx._trxCache?.clear();
  const allMembers = await listMembers(trx);
  const updatedMember = allMembers.find((m) => m.id === membershipId);
  if (!updatedMember) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'IAM_MEMBERSHIP_NOT_FOUND',
      title: 'Membership Not Found',
      detail: `Membership "${membershipId}" was not found.`,
    });
  }

  return updatedMember;
}

// ============================================================================
// Phase 7.2 Staff 4-Digit Access Code, Symmetric Encryption & Rate Limiting Helpers
// ============================================================================

function getInvitationEncryptionKey(): Buffer {
  const secret =
    process.env['INVITATION_ENCRYPTION_KEY'] ??
    process.env['JWT_SECRET'] ??
    process.env['SUPABASE_SERVICE_ROLE_KEY'] ??
    'nexstock-default-invitation-symmetric-key-2026';
  return crypto.createHash('sha256').update(secret).digest();
}

export function encryptInvitationCode(code: string): string {
  const key = getInvitationEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  let encrypted = cipher.update(code, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

export function decryptInvitationCode(encryptedStr: string | null | undefined): string | null {
  if (!encryptedStr) return null;
  try {
    const [ivHex, authTagHex, cipherHex] = encryptedStr.split(':');
    if (!ivHex || !authTagHex || !cipherHex) return null;
    const key = getInvitationEncryptionKey();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
    let decrypted = decipher.update(cipherHex, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch {
    return null;
  }
}

export function generateRandom4DigitCode(): string {
  return crypto.randomInt(1000, 10000).toString();
}

export function maskEmail(email: string): string {
  const parts = email.split('@');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return email;
  const local = parts[0];
  const domain = parts[1];
  const visible = local.length > 2 ? local.slice(0, 2) : local.slice(0, 1);
  return `${visible}***@${domain}`;
}

interface RateLimitEntry {
  failedAttempts: number;
  firstAttemptAt: number;
  blockedUntil?: number;
}
const ipRateLimitStore = new Map<string, RateLimitEntry>();

export function checkInvitationRateLimit(clientIp: string): void {
  const now = Date.now();
  const entry = ipRateLimitStore.get(clientIp);
  if (entry && entry.blockedUntil && entry.blockedUntil > now) {
    const retryAfterSeconds = Math.ceil((entry.blockedUntil - now) / 1000);
    throw new AppError({
      statusCode: 429,
      errorCode: 'IAM_INVITATION_TOO_MANY_ATTEMPTS',
      title: 'Too Many Attempts',
      detail: `Too many failed invitation attempts from this network. Please try again in ${retryAfterSeconds} seconds.`,
    });
  }
}

export function recordFailedInvitationAttempt(clientIp: string): void {
  const now = Date.now();
  const windowMs = 15 * 60 * 1000;
  const entry = ipRateLimitStore.get(clientIp);
  if (!entry || now - entry.firstAttemptAt > windowMs) {
    ipRateLimitStore.set(clientIp, {
      failedAttempts: 1,
      firstAttemptAt: now,
    });
  } else {
    entry.failedAttempts += 1;
    if (entry.failedAttempts >= 5) {
      entry.blockedUntil = now + 15 * 60 * 1000;
    }
  }
}

export function resetInvitationRateLimit(clientIp: string): void {
  ipRateLimitStore.delete(clientIp);
}

// ============================================================================
// Phase 7.2 Staff Invitation & Account Provisioning Engine
// ============================================================================

export async function createStaffInvitation(
  trx: TenantTransactionContext,
  input: InviteStaffRequest,
): Promise<StaffInvitationResponse> {
  await assertAuthorized(trx, { permission: 'iam:member:manage' });

  const normalizedEmail = input.email.trim().toLowerCase();
  const roleCode = input.roleCode?.trim() || 'STAFF';

  // 1. Quota check
  const activeMembers = await trx.db
    .selectFrom('tenant_memberships')
    .select(['id'])
    .where('tenant_id', '=', trx.tenantId)
    .where('status', '=', 'ACTIVE')
    .execute();

  const plan = await trx.db
    .selectFrom('tenant_subscriptions')
    .innerJoin('subscription_plans', 'subscription_plans.id', 'tenant_subscriptions.plan_id')
    .select(['subscription_plans.max_users'])
    .where('tenant_subscriptions.tenant_id', '=', trx.tenantId)
    .executeTakeFirst();

  if (plan?.max_users != null && activeMembers.length >= plan.max_users) {
    throw new AppError({
      statusCode: 403,
      errorCode: 'SUB_QUOTA_EXCEEDED',
      title: 'Subscription Quota Exceeded',
      detail: `Your organization has reached the maximum user limit (${plan.max_users}) allowed by your subscription plan.`,
    });
  }

  // 2. Prevent assigning OWNER or ADMIN automatically
  if (roleCode === 'TENANT_OWNER' || roleCode === 'ORG_ADMIN') {
    throw new AppError({
      statusCode: 400,
      errorCode: 'IAM_INVALID_INVITATION_ROLE',
      title: 'Invalid Invitation Role',
      detail: 'Elevated roles (Owner, Administrator) cannot be assigned via staff invitations.',
    });
  }

  // 3. Verify role exists in tenant
  const role = await trx.db
    .selectFrom('roles')
    .select(['id', 'code', 'name'])
    .where('tenant_id', '=', trx.tenantId)
    .where('code', '=', roleCode)
    .executeTakeFirst();

  if (!role) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'IAM_ROLE_NOT_FOUND',
      title: 'Role Not Found',
      detail: `Role with code "${roleCode}" was not found in this organization.`,
    });
  }

  // 4. Check whether email belongs to the Tenant Owner
  const owner = await trx.db
    .selectFrom('tenant_memberships')
    .innerJoin('users', 'users.id', 'tenant_memberships.user_id')
    .innerJoin('member_role_assignments', 'member_role_assignments.membership_id', 'tenant_memberships.id')
    .innerJoin('roles', 'roles.id', 'member_role_assignments.role_id')
    .select(['users.email'])
    .where('tenant_memberships.tenant_id', '=', trx.tenantId)
    .where('roles.code', '=', 'TENANT_OWNER')
    .executeTakeFirst();

  if (owner && owner.email.toLowerCase().trim() === normalizedEmail) {
    throw new AppError({
      statusCode: 400,
      errorCode: 'IAM_CANNOT_INVITE_OWNER',
      title: 'Cannot Invite Owner Account',
      detail: 'The email address belongs to the Tenant Owner. Staff invitations must use a distinct staff email address.',
    });
  }

  // 5. Check no existing ACTIVE membership with this email
  const existingActiveMember = await trx.db
    .selectFrom('tenant_memberships')
    .innerJoin('users', 'users.id', 'tenant_memberships.user_id')
    .select(['tenant_memberships.id', 'tenant_memberships.status'])
    .where('tenant_memberships.tenant_id', '=', trx.tenantId)
    .where('users.email', '=', normalizedEmail)
    .executeTakeFirst();

  if (existingActiveMember && existingActiveMember.status === 'ACTIVE') {
    throw new AppError({
      statusCode: 409,
      errorCode: 'IAM_USER_ALREADY_MEMBER',
      title: 'User Already a Member',
      detail: `A user with email "${input.email}" is already an active member of this organization.`,
    });
  }

  // 6. Check no active PENDING invitation for this email
  const pending = await trx.db
    .selectFrom('tenant_invitations')
    .select(['id', 'expires_at'])
    .where('tenant_id', '=', trx.tenantId)
    .where('email', '=', normalizedEmail)
    .where('status', '=', 'PENDING')
    .executeTakeFirst();

  if (pending) {
    if (new Date(pending.expires_at) > new Date()) {
      throw new AppError({
        statusCode: 409,
        errorCode: 'IAM_INVITATION_ALREADY_EXISTS',
        title: 'Pending Invitation Exists',
        detail: `An active invitation has already been sent to "${input.email}". You can resend or cancel it.`,
      });
    } else {
      await trx.db
        .updateTable('tenant_invitations')
        .set({ status: 'EXPIRED', updated_at: new Date() })
        .where('id', '=', pending.id)
        .execute();
    }
  }

  // 7. Verify employee profile if provided
  let employeeCode: string | null = null;
  let employeeName: string | null = null;
  if (input.employeeId) {
    const employee = await trx.db
      .selectFrom('employees')
      .select(['id', 'employee_code', 'display_name', 'linked_user_id', 'email'])
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', input.employeeId)
      .executeTakeFirst();

    if (!employee) {
      throw new AppError({
        statusCode: 404,
        errorCode: 'HRM_EMPLOYEE_NOT_FOUND',
        title: 'Employee Not Found',
        detail: `Employee profile "${input.employeeId}" was not found.`,
      });
    }

    if (employee.linked_user_id) {
      throw new AppError({
        statusCode: 409,
        errorCode: 'HRM_EMPLOYEE_ALREADY_LINKED',
        title: 'Employee Already Linked',
        detail: `Employee "${employee.employee_code}" is already linked to another user account.`,
      });
    }

    employeeCode = employee.employee_code;
    employeeName = employee.display_name;
  }

  // 8. Generate unique 4-digit code, secure hash, and symmetric ciphertext
  let rawCode = generateRandom4DigitCode();
  let tokenHash = crypto.createHash('sha256').update(rawCode).digest('hex');
  let genTries = 0;
  while (genTries < 5) {
    const existingWithHash = await trx.db
      .selectFrom('tenant_invitations')
      .select(['id'])
      .where('token_hash', '=', tokenHash)
      .where('status', '=', 'PENDING')
      .executeTakeFirst();
    if (!existingWithHash) break;
    rawCode = generateRandom4DigitCode();
    tokenHash = crypto.createHash('sha256').update(rawCode).digest('hex');
    genTries++;
  }

  const codeEncrypted = encryptInvitationCode(rawCode);
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24-hour expiration (Part 2 E)
  const invitationId = generateUuidV7();
  const now = new Date();

  await trx.db
    .insertInto('tenant_invitations')
    .values({
      id: invitationId,
      tenant_id: trx.tenantId,
      email: normalizedEmail,
      role_code: roleCode,
      employee_id: input.employeeId ?? null,
      token_hash: tokenHash,
      code_encrypted: codeEncrypted,
      failed_attempts: 0,
      locked_until: null,
      status: 'PENDING',
      invited_by_user_id: trx.userId,
      accepted_by_user_id: null,
      expires_at: expiresAt,
      accepted_at: null,
      cancelled_at: null,
      created_at: now,
      updated_at: now,
    })
    .execute();

  await appendAuditLog(trx, {
    action: 'iam.invitation.created',
    resourceType: 'invitation',
    resourceId: invitationId,
    metadata: {
      email: normalizedEmail,
      roleCode,
      employeeId: input.employeeId ?? null,
      expiresAt: expiresAt.toISOString(),
      codeLength: rawCode.length,
    },
  });

  const inviter = await trx.db
    .selectFrom('users')
    .select(['email', 'full_name'])
    .where('id', '=', trx.userId)
    .executeTakeFirst();

  return {
    id: invitationId,
    tenantId: trx.tenantId,
    email: normalizedEmail,
    roleCode,
    employeeId: input.employeeId ?? null,
    employeeCode,
    employeeName,
    status: 'PENDING',
    invitedByUserId: trx.userId,
    invitedByEmail: inviter?.email ?? null,
    invitedByName: inviter?.full_name ?? null,
    acceptedByUserId: null,
    expiresAt: expiresAt.toISOString(),
    acceptedAt: null,
    cancelledAt: null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    invitationCode: rawCode,
    token: rawCode,
    invitationToken: rawCode,
    invitationLink: `/accept-invitation?code=${rawCode}`,
  };
}

export async function listStaffInvitations(
  trx: TenantTransactionContext,
  statusFilter?: string,
): Promise<StaffInvitationResponse[]> {
  await assertAuthorized(trx, { permission: 'iam:member:read' });

  // Lazily update expired invitations
  await trx.db
    .updateTable('tenant_invitations')
    .set({ status: 'EXPIRED', updated_at: new Date() })
    .where('tenant_id', '=', trx.tenantId)
    .where('status', '=', 'PENDING')
    .where('expires_at', '<', new Date())
    .execute();

  let query = trx.db
    .selectFrom('tenant_invitations')
    .leftJoin('employees', 'employees.id', 'tenant_invitations.employee_id')
    .leftJoin('users as inviter', 'inviter.id', 'tenant_invitations.invited_by_user_id')
    .select([
      'tenant_invitations.id',
      'tenant_invitations.tenant_id',
      'tenant_invitations.email',
      'tenant_invitations.role_code',
      'tenant_invitations.employee_id',
      'employees.employee_code',
      'employees.display_name as employee_name',
      'tenant_invitations.status',
      'tenant_invitations.invited_by_user_id',
      'inviter.email as invited_by_email',
      'inviter.full_name as invited_by_name',
      'tenant_invitations.accepted_by_user_id',
      'tenant_invitations.expires_at',
      'tenant_invitations.accepted_at',
      'tenant_invitations.cancelled_at',
      'tenant_invitations.created_at',
      'tenant_invitations.updated_at',
      'tenant_invitations.code_encrypted',
    ])
    .where('tenant_invitations.tenant_id', '=', trx.tenantId)
    .orderBy('tenant_invitations.created_at', 'desc');

  if (statusFilter && ['PENDING', 'ACCEPTED', 'EXPIRED', 'CANCELLED', 'FAILED'].includes(statusFilter)) {
    query = query.where('tenant_invitations.status', '=', statusFilter as 'PENDING' | 'ACCEPTED' | 'EXPIRED' | 'CANCELLED' | 'FAILED');
  }

  const rows = await query.execute();

  return rows.map((r) => {
    let decryptedCode: string | null = null;
    if (r.status === 'PENDING' && r.code_encrypted) {
      decryptedCode = decryptInvitationCode(r.code_encrypted);
    }

    return {
      id: r.id,
      tenantId: r.tenant_id,
      email: r.email,
      roleCode: r.role_code,
      employeeId: r.employee_id,
      employeeCode: r.employee_code ?? null,
      employeeName: r.employee_name ?? null,
      status: r.status as StaffInvitationResponse['status'],
      invitedByUserId: r.invited_by_user_id,
      invitedByEmail: r.invited_by_email ?? null,
      invitedByName: r.invited_by_name ?? null,
      acceptedByUserId: r.accepted_by_user_id,
      expiresAt: r.expires_at.toISOString(),
      acceptedAt: r.accepted_at ? r.accepted_at.toISOString() : null,
      cancelledAt: r.cancelled_at ? r.cancelled_at.toISOString() : null,
      createdAt: r.created_at.toISOString(),
      updatedAt: r.updated_at.toISOString(),
      ...(decryptedCode ? { invitationCode: decryptedCode } : {}),
    };
  });
}

export async function resendStaffInvitation(
  trx: TenantTransactionContext,
  invitationId: string,
): Promise<StaffInvitationResponse> {
  await assertAuthorized(trx, { permission: 'iam:member:manage' });

  const existing = await trx.db
    .selectFrom('tenant_invitations')
    .leftJoin('employees', 'employees.id', 'tenant_invitations.employee_id')
    .leftJoin('users as inviter', 'inviter.id', 'tenant_invitations.invited_by_user_id')
    .select([
      'tenant_invitations.id',
      'tenant_invitations.tenant_id',
      'tenant_invitations.email',
      'tenant_invitations.role_code',
      'tenant_invitations.employee_id',
      'employees.employee_code',
      'employees.display_name as employee_name',
      'tenant_invitations.status',
      'tenant_invitations.invited_by_user_id',
      'inviter.email as invited_by_email',
      'inviter.full_name as invited_by_name',
      'tenant_invitations.accepted_by_user_id',
      'tenant_invitations.expires_at',
      'tenant_invitations.accepted_at',
      'tenant_invitations.cancelled_at',
      'tenant_invitations.created_at',
      'tenant_invitations.updated_at',
    ])
    .where('tenant_invitations.tenant_id', '=', trx.tenantId)
    .where('tenant_invitations.id', '=', invitationId)
    .executeTakeFirst();

  if (!existing) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'IAM_INVITATION_NOT_FOUND',
      title: 'Invitation Not Found',
      detail: `Invitation "${invitationId}" was not found.`,
    });
  }

  if (existing.status === 'ACCEPTED') {
    throw new AppError({
      statusCode: 400,
      errorCode: 'IAM_INVITATION_ALREADY_ACCEPTED',
      title: 'Invitation Already Accepted',
      detail: 'This invitation has already been accepted and cannot be resent.',
    });
  }

  const rawCode = generateRandom4DigitCode();
  const tokenHash = crypto.createHash('sha256').update(rawCode).digest('hex');
  const codeEncrypted = encryptInvitationCode(rawCode);
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24-hour expiration
  const now = new Date();

  await trx.db
    .updateTable('tenant_invitations')
    .set({
      token_hash: tokenHash,
      code_encrypted: codeEncrypted,
      failed_attempts: 0,
      locked_until: null,
      status: 'PENDING',
      expires_at: expiresAt,
      cancelled_at: null,
      updated_at: now,
    })
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', invitationId)
    .execute();

  await appendAuditLog(trx, {
    action: 'iam.invitation.resent',
    resourceType: 'invitation',
    resourceId: invitationId,
    metadata: {
      email: existing.email,
      expiresAt: expiresAt.toISOString(),
      codeLength: rawCode.length,
    },
  });

  return {
    id: existing.id,
    tenantId: existing.tenant_id,
    email: existing.email,
    roleCode: existing.role_code,
    employeeId: existing.employee_id,
    employeeCode: existing.employee_code ?? null,
    employeeName: existing.employee_name ?? null,
    status: 'PENDING',
    invitedByUserId: existing.invited_by_user_id,
    invitedByEmail: existing.invited_by_email ?? null,
    invitedByName: existing.invited_by_name ?? null,
    acceptedByUserId: null,
    expiresAt: expiresAt.toISOString(),
    acceptedAt: null,
    cancelledAt: null,
    createdAt: existing.created_at.toISOString(),
    updatedAt: now.toISOString(),
    invitationCode: rawCode,
    token: rawCode,
    invitationToken: rawCode,
    invitationLink: `/accept-invitation?code=${rawCode}`,
  };
}

export async function cancelStaffInvitation(
  trx: TenantTransactionContext,
  invitationId: string,
): Promise<StaffInvitationResponse> {
  await assertAuthorized(trx, { permission: 'iam:member:manage' });

  const existing = await trx.db
    .selectFrom('tenant_invitations')
    .leftJoin('employees', 'employees.id', 'tenant_invitations.employee_id')
    .leftJoin('users as inviter', 'inviter.id', 'tenant_invitations.invited_by_user_id')
    .select([
      'tenant_invitations.id',
      'tenant_invitations.tenant_id',
      'tenant_invitations.email',
      'tenant_invitations.role_code',
      'tenant_invitations.employee_id',
      'employees.employee_code',
      'employees.display_name as employee_name',
      'tenant_invitations.status',
      'tenant_invitations.invited_by_user_id',
      'inviter.email as invited_by_email',
      'inviter.full_name as invited_by_name',
      'tenant_invitations.accepted_by_user_id',
      'tenant_invitations.expires_at',
      'tenant_invitations.accepted_at',
      'tenant_invitations.cancelled_at',
      'tenant_invitations.created_at',
      'tenant_invitations.updated_at',
    ])
    .where('tenant_invitations.tenant_id', '=', trx.tenantId)
    .where('tenant_invitations.id', '=', invitationId)
    .executeTakeFirst();

  if (!existing) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'IAM_INVITATION_NOT_FOUND',
      title: 'Invitation Not Found',
      detail: `Invitation "${invitationId}" was not found.`,
    });
  }

  if (existing.status === 'ACCEPTED') {
    throw new AppError({
      statusCode: 400,
      errorCode: 'IAM_INVITATION_ALREADY_ACCEPTED',
      title: 'Invitation Already Accepted',
      detail: 'This invitation has already been accepted and cannot be cancelled.',
    });
  }

  const now = new Date();
  await trx.db
    .updateTable('tenant_invitations')
    .set({
      status: 'CANCELLED',
      code_encrypted: null,
      cancelled_at: now,
      updated_at: now,
    })
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', invitationId)
    .execute();

  await appendAuditLog(trx, {
    action: 'iam.invitation.cancelled',
    resourceType: 'invitation',
    resourceId: invitationId,
    metadata: {
      email: existing.email,
    },
  });

  return {
    id: existing.id,
    tenantId: existing.tenant_id,
    email: existing.email,
    roleCode: existing.role_code,
    employeeId: existing.employee_id,
    employeeCode: existing.employee_code ?? null,
    employeeName: existing.employee_name ?? null,
    status: 'CANCELLED',
    invitedByUserId: existing.invited_by_user_id,
    invitedByEmail: existing.invited_by_email ?? null,
    invitedByName: existing.invited_by_name ?? null,
    acceptedByUserId: null,
    expiresAt: existing.expires_at.toISOString(),
    acceptedAt: null,
    cancelledAt: now.toISOString(),
    createdAt: existing.created_at.toISOString(),
    updatedAt: now.toISOString(),
  };
}

export async function validateStaffInvitation(
  db: Kysely<NexStockDatabase>,
  codeOrToken: string,
  traceId?: string,
  clientIp?: string,
  emailCheck?: string,
): Promise<ValidateInvitationResponse> {
  const cleanCode = codeOrToken.trim();
  if (!cleanCode) {
    throw new AppError({
      statusCode: 400,
      errorCode: 'IAM_INVITATION_CODE_INVALID',
      title: 'Invalid Code',
      detail: 'Please enter a valid 4-digit invitation code.',
    });
  }

  if (clientIp) {
    checkInvitationRateLimit(clientIp);
  }

  const tokenHash = crypto.createHash('sha256').update(cleanCode).digest('hex');

  const rows = await sql<{
    id: string;
    tenant_id: string;
    email: string;
    role_code: string;
    employee_id: string | null;
    status: string;
    expires_at: Date;
    failed_attempts: number;
    locked_until: Date | null;
    tenant_name: string;
    employee_name: string | null;
  }>`SELECT * FROM public.lookup_invitation_by_code_hash(${tokenHash})`.execute(db);

  const invitation = rows.rows[0];

  if (!invitation) {
    if (clientIp) recordFailedInvitationAttempt(clientIp);
    throw new AppError({
      statusCode: 404,
      errorCode: 'IAM_INVITATION_NOT_FOUND',
      title: 'Invitation Not Found',
      detail: 'The invitation token is invalid or does not exist.',
    });
  }

  if (invitation.locked_until && new Date(invitation.locked_until) > new Date()) {
    throw new AppError({
      statusCode: 423,
      errorCode: 'IAM_INVITATION_LOCKED',
      title: 'Invitation Temporarily Locked',
      detail: 'This invitation has been temporarily locked due to multiple failed attempts. Please try again later or contact your administrator.',
    });
  }

  if (invitation.status === 'ACCEPTED') {
    throw new AppError({
      statusCode: 400,
      errorCode: 'IAM_INVITATION_ALREADY_ACCEPTED',
      title: 'Invitation Already Accepted',
      detail: 'This invitation has already been accepted.',
    });
  }

  if (invitation.status === 'CANCELLED') {
    throw new AppError({
      statusCode: 400,
      errorCode: 'IAM_INVITATION_INACTIVE',
      title: 'Invitation Inactive',
      detail: 'This invitation is no longer active (status: CANCELLED).',
    });
  }

  if (invitation.status === 'EXPIRED' || new Date(invitation.expires_at) < new Date()) {
    throw new AppError({
      statusCode: 410,
      errorCode: 'IAM_INVITATION_EXPIRED',
      title: 'Invitation Expired',
      detail: 'This invitation link has expired. Please contact your organization administrator to receive a new invitation.',
    });
  }

  if (invitation.status !== 'PENDING') {
    throw new AppError({
      statusCode: 400,
      errorCode: 'IAM_INVITATION_INACTIVE',
      title: 'Invitation Inactive',
      detail: `This invitation is no longer active (status: ${invitation.status}).`,
    });
  }

  if (emailCheck) {
    if (invitation.email.toLowerCase().trim() !== emailCheck.toLowerCase().trim()) {
      if (clientIp) recordFailedInvitationAttempt(clientIp);
      await sql`SELECT public.record_invitation_failed_attempt(${invitation.id}::uuid)`.execute(db);
      throw new AppError({
        statusCode: 400,
        errorCode: 'IAM_INVITATION_EMAIL_MISMATCH',
        title: 'Email Address Mismatch',
        detail: 'The email address provided does not match the invitation record.',
      });
    }
  }

  return {
    valid: true,
    email: invitation.email,
    maskedEmail: maskEmail(invitation.email),
    roleCode: invitation.role_code,
    tenantId: invitation.tenant_id,
    tenantName: invitation.tenant_name,
    employeeName: invitation.employee_name,
    ...(cleanCode.length === 4 ? { invitationCode: cleanCode } : {}),
  };
}

export async function validateStaffInvitationCode(
  db: Kysely<NexStockDatabase>,
  input: ValidateInvitationCodeRequest,
  traceId?: string,
  clientIp?: string,
): Promise<ValidateInvitationResponse> {
  return validateStaffInvitation(db, input.code, traceId, clientIp, input.email);
}

export async function acceptStaffInvitation(
  db: Kysely<NexStockDatabase>,
  config: AuthServiceConfig,
  input: AcceptInvitationRequest,
  traceId?: string,
  clientIp?: string,
): Promise<LoginResponse> {
  const currentTraceId = traceId ?? `inv_acc_${generateUuidV7()}`;
  const codeToVerify = (input.code || input.token || '').trim();

  if (!codeToVerify) {
    throw new AppError({
      statusCode: 400,
      errorCode: 'IAM_INVITATION_CODE_INVALID',
      title: 'Invitation Code Required',
      detail: 'A valid 4-digit invitation code or token is required to activate an account.',
    });
  }

  if (clientIp) {
    checkInvitationRateLimit(clientIp);
  }

  const tokenHash = crypto.createHash('sha256').update(codeToVerify).digest('hex');

  if (input.password.length < 8) {
    throw new AppError({
      statusCode: 400,
      errorCode: 'AUTH_WEAK_PASSWORD',
      title: 'Weak Password',
      detail: 'Password must be at least 8 characters long.',
    });
  }

  // 1. Look up invitation using security definer function
  const rows = await sql<{
    id: string;
    tenant_id: string;
    email: string;
    role_code: string;
    employee_id: string | null;
    status: string;
    expires_at: Date;
    failed_attempts: number;
    locked_until: Date | null;
    tenant_name: string;
    employee_name: string | null;
  }>`SELECT * FROM public.lookup_invitation_by_code_hash(${tokenHash})`.execute(db);

  const invitation = rows.rows[0];

  if (!invitation) {
    if (clientIp) recordFailedInvitationAttempt(clientIp);
    throw new AppError({
      statusCode: 404,
      errorCode: 'IAM_INVITATION_NOT_FOUND',
      title: 'Invitation Not Found',
      detail: 'The invitation token is invalid or does not exist.',
    });
  }

  if (invitation.locked_until && new Date(invitation.locked_until) > new Date()) {
    throw new AppError({
      statusCode: 423,
      errorCode: 'IAM_INVITATION_LOCKED',
      title: 'Invitation Temporarily Locked',
      detail: 'This invitation has been temporarily locked due to multiple failed attempts. Please try again later.',
    });
  }

  if (invitation.status === 'ACCEPTED') {
    throw new AppError({
      statusCode: 400,
      errorCode: 'IAM_INVITATION_ALREADY_ACCEPTED',
      title: 'Invitation Already Accepted',
      detail: 'This invitation has already been accepted.',
    });
  }

  if (invitation.status === 'EXPIRED' || new Date(invitation.expires_at) < new Date()) {
    throw new AppError({
      statusCode: 410,
      errorCode: 'IAM_INVITATION_EXPIRED',
      title: 'Invitation Expired',
      detail: 'This invitation has expired. Request a new invitation from your administrator.',
    });
  }

  if (invitation.status !== 'PENDING') {
    throw new AppError({
      statusCode: 400,
      errorCode: 'IAM_INVITATION_INACTIVE',
      title: 'Invitation Inactive',
      detail: `This invitation is no longer active (status: ${invitation.status}).`,
    });
  }

  // Verify supplied email if provided
  if (input.email) {
    if (input.email.trim().toLowerCase() !== invitation.email.trim().toLowerCase()) {
      if (clientIp) recordFailedInvitationAttempt(clientIp);
      await sql`SELECT public.record_invitation_failed_attempt(${invitation.id}::uuid)`.execute(db);
      throw new AppError({
        statusCode: 400,
        errorCode: 'IAM_INVITATION_EMAIL_MISMATCH',
        title: 'Email Address Mismatch',
        detail: 'The email address provided does not match the invitation record.',
      });
    }
  }

  const normalizedEmail = invitation.email.toLowerCase().trim();
  const fullName = input.fullName?.trim() || invitation.employee_name || normalizedEmail.split('@')[0] || 'Staff Member';

  // 2. Ensure User Account exists in auth provider / users table
  let userId = '';
  let sessionToken = '';
  let sessionRefreshToken: string | undefined;
  let sessionExpiresIn: number | undefined;

  const supabaseUrl = config.supabaseUrl ?? process.env['SUPABASE_URL'] ?? DEFAULT_SUPABASE_URL;
  const anonKey = config.supabaseAnonKey ?? process.env['SUPABASE_ANON_KEY'] ?? process.env['SUPABASE_PUBLISHABLE_KEY'];

  if (anonKey && anonKey !== 'SET_IN_LOCAL_ENV') {
    // Live Supabase Auth integration (Production / Live Supabase Mode)
    let signupResp: Response;
    try {
      signupResp = await fetch(`${supabaseUrl}/auth/v1/signup`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: anonKey,
          Authorization: `Bearer ${anonKey}`,
        },
        body: JSON.stringify({
          email: normalizedEmail,
          password: input.password,
          data: {
            full_name: fullName,
          },
        }),
      });
    } catch (err) {
      if (err instanceof AppError) throw err;
      const safeDetail = sanitizeLogMessage(err instanceof Error ? err.message : String(err));
      console.error('[NexStock Invitation Supabase Auth Provider Failure]', {
        traceId: currentTraceId,
        operation: 'signup',
        detail: safeDetail,
      });
      throw new AppError({
        statusCode: 502,
        errorCode: 'ERR_INTERNAL_SERVER_ERROR',
        title: 'Authentication Service Unavailable',
        detail: `Failed to communicate with authentication provider: ${safeDetail}`,
      });
    }

    const signupData = (await signupResp.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      user?: { id?: string };
      id?: string;
      msg?: string;
      message?: string;
      error_description?: string;
      error?: string;
      code?: string | number;
    };

    if (signupResp.ok) {
      const foundUserId = signupData.user?.id ?? signupData.id;
      if (!foundUserId) {
        throw new AppError({
          statusCode: 500,
          errorCode: 'ERR_INTERNAL_SERVER_ERROR',
          title: 'Registration Failed',
          detail: 'Identity provider did not return a user identifier.',
        });
      }
      userId = foundUserId;
      sessionToken = signupData.access_token ?? '';
      sessionRefreshToken = signupData.refresh_token;
      sessionExpiresIn = signupData.expires_in;

      // If access_token was not returned in signup response, sign in via password to acquire session
      if (!sessionToken) {
        const loginResp = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            apikey: anonKey,
            Authorization: `Bearer ${anonKey}`,
          },
          body: JSON.stringify({
            email: normalizedEmail,
            password: input.password,
          }),
        });
        if (loginResp.ok) {
          const loginData = (await loginResp.json()) as {
            access_token?: string;
            refresh_token?: string;
            expires_in?: number;
            user?: { id?: string };
          };
          if (loginData.access_token) {
            sessionToken = loginData.access_token;
            sessionRefreshToken = loginData.refresh_token;
            sessionExpiresIn = loginData.expires_in;
            if (loginData.user?.id) userId = loginData.user.id;
          }
        }
      }
    } else {
      const errorMsg =
        signupData.msg ??
        signupData.message ??
        signupData.error_description ??
        signupData.error ??
        'Registration failed.';
      const isAlreadyRegistered =
        signupResp.status === 422 ||
        errorMsg.toLowerCase().includes('already') ||
        errorMsg.toLowerCase().includes('registered');

      if (isAlreadyRegistered) {
        // User already registered in Supabase. Attempt password login
        let loginResp: Response;
        try {
          loginResp = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              apikey: anonKey,
              Authorization: `Bearer ${anonKey}`,
            },
            body: JSON.stringify({
              email: normalizedEmail,
              password: input.password,
            }),
          });
        } catch (err) {
          if (err instanceof AppError) throw err;
          const safeDetail = sanitizeLogMessage(err instanceof Error ? err.message : String(err));
          throw new AppError({
            statusCode: 502,
            errorCode: 'ERR_INTERNAL_SERVER_ERROR',
            title: 'Authentication Service Unavailable',
            detail: `Failed to communicate with authentication provider: ${safeDetail}`,
          });
        }

        if (loginResp.ok) {
          const loginData = (await loginResp.json()) as {
            access_token?: string;
            refresh_token?: string;
            expires_in?: number;
            user?: { id: string };
          };
          if (!loginData.access_token || !loginData.user?.id) {
            throw new AppError({
              statusCode: 401,
              errorCode: 'AUTH_INVALID_CREDENTIALS',
              title: 'Authentication Failed',
              detail: 'Invalid credentials or inactive session.',
            });
          }
          userId = loginData.user.id;
          sessionToken = loginData.access_token;
          sessionRefreshToken = loginData.refresh_token;
          sessionExpiresIn = loginData.expires_in;
        } else {
          // Password did not match existing account. Check if SUPABASE_SERVICE_ROLE_KEY is present
          const serviceRoleKey = process.env['SUPABASE_SERVICE_ROLE_KEY'];
          let updatedViaAdmin = false;

          if (serviceRoleKey && serviceRoleKey !== 'SET_IN_LOCAL_ENV') {
            try {
              const adminUsersResp = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
                headers: {
                  apikey: serviceRoleKey,
                  Authorization: `Bearer ${serviceRoleKey}`,
                },
              });
              if (adminUsersResp.ok) {
                const adminData = (await adminUsersResp.json()) as { users?: Array<{ id: string; email?: string }> };
                const target = (adminData.users ?? []).find(u => u.email?.toLowerCase() === normalizedEmail);
                if (target) {
                  const updateResp = await fetch(`${supabaseUrl}/auth/v1/admin/users/${target.id}`, {
                    method: 'PUT',
                    headers: {
                      'Content-Type': 'application/json',
                      apikey: serviceRoleKey,
                      Authorization: `Bearer ${serviceRoleKey}`,
                    },
                    body: JSON.stringify({
                      password: input.password,
                      email_confirm: true,
                      user_metadata: { full_name: fullName },
                    }),
                  });
                  if (updateResp.ok) {
                    const reloginResp = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
                      method: 'POST',
                      headers: {
                        'Content-Type': 'application/json',
                        apikey: anonKey,
                        Authorization: `Bearer ${anonKey}`,
                      },
                      body: JSON.stringify({
                        email: normalizedEmail,
                        password: input.password,
                      }),
                    });
                    if (reloginResp.ok) {
                      const reloginData = (await reloginResp.json()) as {
                        access_token?: string;
                        refresh_token?: string;
                        expires_in?: number;
                        user?: { id: string };
                      };
                      if (reloginData.access_token && reloginData.user?.id) {
                        userId = reloginData.user.id;
                        sessionToken = reloginData.access_token;
                        sessionRefreshToken = reloginData.refresh_token;
                        sessionExpiresIn = reloginData.expires_in;
                        updatedViaAdmin = true;
                      }
                    }
                  }
                }
              }
            } catch (adminErr) {
              console.warn('[Supabase Admin User Password Update Failed]', adminErr);
            }
          }

          if (!updatedViaAdmin) {
            throw new AppError({
              statusCode: 409,
              errorCode: 'AUTH_EMAIL_ALREADY_EXISTS',
              title: 'Account Already Exists',
              detail: 'An account with this email address already exists. Please enter your existing account password to join this organization.',
            });
          }
        }
      } else if (signupResp.status === 400 && errorMsg.toLowerCase().includes('password')) {
        throw new AppError({
          statusCode: 400,
          errorCode: 'AUTH_WEAK_PASSWORD',
          title: 'Weak Password',
          detail: errorMsg,
        });
      } else {
        throw new AppError({
          statusCode: signupResp.status >= 400 && signupResp.status < 500 ? signupResp.status : 400,
          errorCode: 'ERR_VALIDATION_FAILED',
          title: 'Account Provisioning Failed',
          detail: errorMsg,
        });
      }
    }

    if (!sessionToken || !userId) {
      throw new AppError({
        statusCode: 500,
        errorCode: 'ERR_INTERNAL_SERVER_ERROR',
        title: 'Session Creation Failed',
        detail: 'Failed to establish an authenticated session with identity provider.',
      });
    }
  } else {
    // Local Development / Test Fallback
    const existingUser = await withAppUserTransaction(db, { traceId: currentTraceId }, async (trx) => {
      return trx
        .selectFrom('users')
        .select(['id', 'email', 'full_name'])
        .where('email', '=', normalizedEmail)
        .executeTakeFirst();
    });

    userId = existingUser?.id ?? generateUuidV7();
    sessionToken = signDevJwt({
      userId,
      email: normalizedEmail,
      userMetadata: { full_name: fullName },
    });
    sessionRefreshToken = `dev_refresh_${generateUuidV7()}`;
    sessionExpiresIn = 86400 * 7;
  }

  await ensureUserRecordDirect(
    db,
    {
      userId,
      email: normalizedEmail,
      fullName,
    },
    currentTraceId,
  );

  // 3. Atomically activate membership, assign role, link employee, and mark invitation accepted
  await withTenantTransaction(
    db,
    { tenantId: invitation.tenant_id, userId, traceId: currentTraceId },
    async (trx) => {
      // A. Quota check
      const existingMembership = await trx.db
        .selectFrom('tenant_memberships')
        .select(['id', 'status'])
        .where('tenant_id', '=', trx.tenantId)
        .where('user_id', '=', userId)
        .executeTakeFirst();

      const activeMembers = await trx.db
        .selectFrom('tenant_memberships')
        .select(['id'])
        .where('tenant_id', '=', trx.tenantId)
        .where('status', '=', 'ACTIVE')
        .execute();

      const plan = await trx.db
        .selectFrom('tenant_subscriptions')
        .innerJoin('subscription_plans', 'subscription_plans.id', 'tenant_subscriptions.plan_id')
        .select(['subscription_plans.max_users'])
        .where('tenant_subscriptions.tenant_id', '=', trx.tenantId)
        .executeTakeFirst();

      const isNewActive = !existingMembership || existingMembership.status !== 'ACTIVE';
      const projectedCount = isNewActive ? activeMembers.length + 1 : activeMembers.length;

      if (plan?.max_users != null && projectedCount > plan.max_users) {
        throw new AppError({
          statusCode: 403,
          errorCode: 'SUB_QUOTA_EXCEEDED',
          title: 'Subscription Quota Exceeded',
          detail: `Your organization has reached the maximum user limit (${plan.max_users}) allowed by your subscription plan.`,
        });
      }

      // B. Create or update tenant_memberships
      let membershipId: string;
      if (existingMembership) {
        membershipId = existingMembership.id;
        await trx.db
          .updateTable('tenant_memberships')
          .set({
            status: 'ACTIVE',
            updated_at: new Date(),
          })
          .where('tenant_id', '=', trx.tenantId)
          .where('id', '=', membershipId)
          .execute();
      } else {
        membershipId = generateUuidV7();
        await trx.db
          .insertInto('tenant_memberships')
          .values({
            id: membershipId,
            tenant_id: trx.tenantId,
            user_id: userId,
            status: 'ACTIVE',
            all_locations_access: false,
          })
          .execute();
      }

      // C. Role assignment
      const targetRole = await trx.db
        .selectFrom('roles')
        .select(['id', 'code'])
        .where('tenant_id', '=', trx.tenantId)
        .where('code', '=', invitation.role_code)
        .executeTakeFirst();

      if (targetRole) {
        const existingRoleAssignment = await trx.db
          .selectFrom('member_role_assignments')
          .select(['id'])
          .where('tenant_id', '=', trx.tenantId)
          .where('membership_id', '=', membershipId)
          .where('role_id', '=', targetRole.id)
          .executeTakeFirst();

        if (!existingRoleAssignment) {
          await trx.db
            .insertInto('member_role_assignments')
            .values({
              id: generateUuidV7(),
              tenant_id: trx.tenantId,
              membership_id: membershipId,
              role_id: targetRole.id,
            })
            .execute();
        }
      }

      // D. Link employee if employee_id was specified
      if (invitation.employee_id) {
        await trx.db
          .updateTable('employees')
          .set({
            linked_user_id: userId,
            updated_at: new Date(),
          })
          .where('tenant_id', '=', trx.tenantId)
          .where('id', '=', invitation.employee_id)
          .execute();

        // Auto-assign location scope from employee's primary branch
        const emp = await trx.db
          .selectFrom('employees')
          .select(['primary_branch_id'])
          .where('tenant_id', '=', trx.tenantId)
          .where('id', '=', invitation.employee_id)
          .executeTakeFirst();

        if (emp?.primary_branch_id) {
          await trx.db
            .insertInto('member_location_scopes')
            .values({
              id: generateUuidV7(),
              tenant_id: trx.tenantId,
              membership_id: membershipId,
              branch_id: emp.primary_branch_id,
              warehouse_id: null,
            })
            .onConflict((oc) =>
              oc
                .columns(['tenant_id', 'membership_id', 'branch_id'])
                .doNothing(),
            )
            .execute();
        }
      }

      // E. Mark invitation ACCEPTED and clear encrypted code
      const now = new Date();
      await trx.db
        .updateTable('tenant_invitations')
        .set({
          status: 'ACCEPTED',
          accepted_by_user_id: userId,
          accepted_at: now,
          code_encrypted: null,
          failed_attempts: 0,
          locked_until: null,
          updated_at: now,
        })
        .where('tenant_id', '=', trx.tenantId)
        .where('id', '=', invitation.id)
        .execute();

      await appendAuditLog(trx, {
        action: 'iam.invitation.accepted',
        resourceType: 'invitation',
        resourceId: invitation.id,
        metadata: {
          acceptedByUserId: userId,
          roleCode: invitation.role_code,
          employeeId: invitation.employee_id,
        },
      });
    },
  );

  if (clientIp) {
    resetInvitationRateLimit(clientIp);
  }

  // 4. Return authenticated session & user profile for staff member
  const profile = await getUserProfileAndMemberships(db, userId, currentTraceId);

  return {
    token: sessionToken,
    ...(sessionRefreshToken ? { refreshToken: sessionRefreshToken } : {}),
    ...(sessionExpiresIn ? { expiresIn: sessionExpiresIn } : {}),
    user: profile.user,
    memberships: profile.memberships,
  };
}

export async function updateMemberStatus(
  trx: TenantTransactionContext,
  membershipId: string,
  status: 'ACTIVE' | 'DISABLED',
): Promise<MemberSummaryResponse> {
  await assertAuthorized(trx, { permission: 'iam:member:manage' });

  const membership = await trx.db
    .selectFrom('tenant_memberships')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', membershipId)
    .executeTakeFirst();

  if (!membership) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'IAM_MEMBERSHIP_NOT_FOUND',
      title: 'Membership Not Found',
      detail: `Membership "${membershipId}" was not found.`,
    });
  }

  // Prevent disabling tenant owner
  const roles = await trx.db
    .selectFrom('member_role_assignments')
    .innerJoin('roles', 'roles.id', 'member_role_assignments.role_id')
    .select(['roles.code'])
    .where('member_role_assignments.tenant_id', '=', trx.tenantId)
    .where('member_role_assignments.membership_id', '=', membershipId)
    .execute();

  const isOwner = roles.some((r) => r.code === 'TENANT_OWNER');
  if (isOwner && status === 'DISABLED') {
    throw new AppError({
      statusCode: 400,
      errorCode: 'IAM_CANNOT_DISABLE_OWNER',
      title: 'Cannot Disable Owner Account',
      detail: 'The Organization Owner account cannot be deactivated.',
    });
  }

  await trx.db
    .updateTable('tenant_memberships')
    .set({
      status,
      updated_at: new Date(),
    })
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', membershipId)
    .execute();

  await appendAuditLog(trx, {
    action: 'iam.member.status_updated',
    resourceType: 'membership',
    resourceId: membershipId,
    metadata: {
      userId: membership.user_id,
      previousStatus: membership.status,
      newStatus: status,
    },
  });

  const allMembers = await listMembers(trx);
  const updated = allMembers.find((m) => m.id === membershipId);
  return updated!;
}

export async function revokeMemberAccess(
  trx: TenantTransactionContext,
  membershipId: string,
): Promise<{ success: boolean; message: string }> {
  await assertAuthorized(trx, { permission: 'iam:member:manage' });

  const membership = await trx.db
    .selectFrom('tenant_memberships')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', membershipId)
    .executeTakeFirst();

  if (!membership) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'IAM_MEMBERSHIP_NOT_FOUND',
      title: 'Membership Not Found',
      detail: `Membership "${membershipId}" was not found.`,
    });
  }

  // Prevent revoking tenant owner
  const roles = await trx.db
    .selectFrom('member_role_assignments')
    .innerJoin('roles', 'roles.id', 'member_role_assignments.role_id')
    .select(['roles.code'])
    .where('member_role_assignments.tenant_id', '=', trx.tenantId)
    .where('member_role_assignments.membership_id', '=', membershipId)
    .execute();

  const isOwner = roles.some((r) => r.code === 'TENANT_OWNER');
  if (isOwner) {
    throw new AppError({
      statusCode: 400,
      errorCode: 'IAM_CANNOT_REVOKE_OWNER',
      title: 'Cannot Revoke Owner Account',
      detail: 'The Organization Owner access cannot be revoked.',
    });
  }

  // Unlink any employee linked to this user in this tenant
  await trx.db
    .updateTable('employees')
    .set({
      linked_user_id: null,
      updated_at: new Date(),
    })
    .where('tenant_id', '=', trx.tenantId)
    .where('linked_user_id', '=', membership.user_id)
    .execute();

  // Remove role assignments, location scopes, and membership
  await trx.db
    .deleteFrom('member_role_assignments')
    .where('tenant_id', '=', trx.tenantId)
    .where('membership_id', '=', membershipId)
    .execute();

  await trx.db
    .deleteFrom('member_location_scopes')
    .where('tenant_id', '=', trx.tenantId)
    .where('membership_id', '=', membershipId)
    .execute();

  await trx.db
    .deleteFrom('tenant_memberships')
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', membershipId)
    .execute();

  await appendAuditLog(trx, {
    action: 'iam.member.revoked',
    resourceType: 'membership',
    resourceId: membershipId,
    metadata: {
      userId: membership.user_id,
    },
  });

  return { success: true, message: 'Member access revoked successfully.' };
}

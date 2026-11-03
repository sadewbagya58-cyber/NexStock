import type {
  CreateRoleRequest,
  MemberSummaryResponse,
  PermissionAction,
  PermissionItem,
  PermissionsCatalogResponse,
  RoleDetailResponse,
  RoleSummaryResponse,
  UpdateMemberLocationScopesRequest,
  UpdateRoleRequest,
} from '@nexstock/contracts';
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
  | 'dash:view'
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
  | 'i18n:tax:manage'
  | 'cat:category:read'
  | 'cat:category:manage'
  | 'cat:product:read'
  | 'cat:product:manage'
  | 'pur:supplier:read'
  | 'pur:supplier:manage'
  | 'inv:balance:read'
  | 'inv:movement:read'
  | 'inv:movement:post'
  | 'inv:movement:reverse'
  | 'pos:register:read'
  | 'pos:shift:open'
  | 'pos:shift:close'
  | 'pos:sale:create'
  | 'pos:sale:read'
  | 'pos:sale:void'
  | 'pos:payment:create'
  | 'inv:batch:read'
  | 'inv:batch:manage'
  | 'inv:serial:read'
  | 'inv:serial:manage'
  | 'inv:costing:read'
  | 'inv:count:read'
  | 'inv:count:create'
  | 'inv:count:submit'
  | 'inv:count:approve'
  | 'inv:count:post'
  | 'hrm:employee:read'
  | 'hrm:employee:manage'
  | 'hrm:document:read'
  | 'hrm:document:manage'
  | 'hrm:salary:read'
  | 'hrm:salary:manage'
  | 'hrm:payroll:read'
  | 'hrm:payroll:process'
  | 'hrm:payroll:approve'
  | 'hrm:payroll:pay'
  | 'exp:expense:read'
  | 'exp:expense:manage'
  | 'crm:credit:read'
  | 'crm:credit:manage'
  | 'rep:report:view'
  | 'rep:report:export';

export const PERMISSIONS_CATALOG: readonly PermissionItem[] = [
  // 1. Dashboard
  { key: 'dash:view', module: 'Dashboard', action: 'View', name: 'View Dashboard', description: 'Access organization dashboard KPIs, charts, and metrics.' },

  // 2. Products
  { key: 'cat:product:read', module: 'Products', action: 'View', name: 'View Products', description: 'Browse and search product catalog items.' },
  { key: 'cat:product:manage', module: 'Products', action: 'Manage', name: 'Manage Products', description: 'Create, edit, archive, and configure product SKUs and barcodes.' },

  // 3. Categories
  { key: 'cat:category:read', module: 'Categories', action: 'View', name: 'View Categories', description: 'View product category trees and taxonomies.' },
  { key: 'cat:category:manage', module: 'Categories', action: 'Manage', name: 'Manage Categories', description: 'Create, edit, and organize product categories.' },

  // 4. Suppliers
  { key: 'pur:supplier:read', module: 'Suppliers', action: 'View', name: 'View Suppliers', description: 'Browse supplier profiles, contacts, and linked products.' },
  { key: 'pur:supplier:manage', module: 'Suppliers', action: 'Manage', name: 'Manage Suppliers', description: 'Create and update vendor records and supply terms.' },

  // 5. Stock Movements
  { key: 'inv:movement:read', module: 'Stock Movements', action: 'View', name: 'View Stock Movements', description: 'Inspect stock movement ledger history.' },
  { key: 'inv:movement:post', module: 'Stock Movements', action: 'Create', name: 'Post Stock Movements', description: 'Record inventory receipts, dispatches, adjustments, and transfers.' },
  { key: 'inv:movement:reverse', module: 'Stock Movements', action: 'Edit', name: 'Reverse Stock Movements', description: 'Post compensating reversals for previous stock entries.' },

  // 6. Inventory Balances
  { key: 'inv:balance:read', module: 'Inventory Balances', action: 'View', name: 'View Inventory Balances', description: 'Check real-time stock levels across branches and warehouses.' },

  // 7. Batches & Expiry
  { key: 'inv:batch:read', module: 'Batches & Expiry', action: 'View', name: 'View Batches & Expiry', description: 'Track lot batches, manufacture dates, and expiration schedules.' },
  { key: 'inv:batch:manage', module: 'Batches & Expiry', action: 'Manage', name: 'Manage Batches', description: 'Create, edit, and adjust batch numbers and shelf life parameters.' },

  // 8. Serial Registry
  { key: 'inv:serial:read', module: 'Serial Registry', action: 'View', name: 'View Serial Registry', description: 'Lookup individual serial numbers and their warranty lifecycle.' },
  { key: 'inv:serial:manage', module: 'Serial Registry', action: 'Manage', name: 'Manage Serial Numbers', description: 'Register, transition status, and assign serial numbers.' },

  // 9. Costing & Valuation
  { key: 'inv:costing:read', module: 'Costing & Valuation', action: 'View', name: 'View Costing & Valuation', description: 'Inspect FIFO unit costs and total inventory valuation balance sheets.' },

  // 10. Stock Counts
  { key: 'inv:count:read', module: 'Stock Counts', action: 'View', name: 'View Stock Counts', description: 'Inspect physical stocktake sessions and counted items.' },
  { key: 'inv:count:create', module: 'Stock Counts', action: 'Create', name: 'Create Stocktake Sessions', description: 'Initiate new cycle counts and blind count sheets.' },
  { key: 'inv:count:submit', module: 'Stock Counts', action: 'Edit', name: 'Submit Stock Counts', description: 'Record and submit tallied item counts for verification.' },
  { key: 'inv:count:approve', module: 'Stock Counts', action: 'Approve', name: 'Approve Stocktake Audits', description: 'Review and approve stocktake variance reconciliations.' },
  { key: 'inv:count:post', module: 'Stock Counts', action: 'Manage', name: 'Post Stocktake Adjustments', description: 'Finalize counts and atomically write variance adjustments to ledger.' },

  // 11. POS Checkout
  { key: 'pos:sale:create', module: 'POS Checkout', action: 'Create', name: 'Create POS Sales', description: 'Ring up retail orders and scan barcodes at checkout.' },
  { key: 'pos:payment:create', module: 'POS Checkout', action: 'Create', name: 'Record POS Payments', description: 'Tender cash, card, and split payments on retail sales.' },

  // 12. Registers
  { key: 'pos:register:read', module: 'Registers', action: 'View', name: 'View Registers', description: 'Check register status and hardware terminal bindings.' },
  { key: 'org:register:read', module: 'Registers', action: 'View', name: 'View Register Configurations', description: 'Inspect store checkout stations and branch assignments.' },
  { key: 'org:register:manage', module: 'Registers', action: 'Manage', name: 'Manage Registers', description: 'Create, rename, and assign POS checkout stations.' },

  // 13. Cashier Shifts
  { key: 'pos:shift:open', module: 'Cashier Shifts', action: 'Create', name: 'Open Cashier Shifts', description: 'Start cash drawer shifts with opening float verification.' },
  { key: 'pos:shift:close', module: 'Cashier Shifts', action: 'Edit', name: 'Close Cashier Shifts', description: 'Reconcile counted cash drawer and close shift sessions.' },

  // 14. Sales History
  { key: 'pos:sale:read', module: 'Sales History', action: 'View', name: 'View Sales History', description: 'Browse completed POS invoices, tickets, and receipts.' },
  { key: 'pos:sale:void', module: 'Sales History', action: 'Delete', name: 'Void Completed Sales', description: 'Authorize supervisor voiding and return items to stock.' },

  // 15. Employees
  { key: 'hrm:employee:read', module: 'Employees', action: 'View', name: 'View Employee Directory', description: 'Browse staff records, contact info, and employment status.' },
  { key: 'hrm:employee:manage', module: 'Employees', action: 'Manage', name: 'Manage Employees', description: 'Enroll, update profiles, change status, and assign branches/warehouses.' },
  { key: 'hrm:document:read', module: 'Employees', action: 'View', name: 'View Employee Documents', description: 'Access contracts, identity cards, and verification files.' },
  { key: 'hrm:document:manage', module: 'Employees', action: 'Manage', name: 'Manage Employee Documents', description: 'Upload, verify signatures, and delete employee files.' },

  // 16. Payroll
  { key: 'hrm:salary:read', module: 'Payroll', action: 'View', name: 'View Salary Structures', description: 'Inspect employee compensation plans and allowance breakdowns.' },
  { key: 'hrm:salary:manage', module: 'Payroll', action: 'Manage', name: 'Manage Salary Structures', description: 'Configure basic salary, allowances, and statutory deductions.' },
  { key: 'hrm:payroll:read', module: 'Payroll', action: 'View', name: 'View Payroll Runs & Reports', description: 'Browse historical payroll calculation runs and summary analytics.' },
  { key: 'hrm:payroll:process', module: 'Payroll', action: 'Create', name: 'Process Payroll Runs', description: 'Initialize payroll cycles and compute gross-to-net pay.' },
  { key: 'hrm:payroll:approve', module: 'Payroll', action: 'Approve', name: 'Approve Payroll Runs', description: 'Lock payroll calculations for disbursement.' },
  { key: 'hrm:payroll:pay', module: 'Payroll', action: 'Manage', name: 'Disburse Payroll Payments', description: 'Record bank transfers, cheques, and cash disbursements.' },

  // 17. Expenses
  { key: 'exp:expense:read', module: 'Expenses', action: 'View', name: 'View Expenses', description: 'Inspect operating expenses and vendor payout records.' },
  { key: 'exp:expense:manage', module: 'Expenses', action: 'Manage', name: 'Manage Expenses', description: 'Record and categorize store and warehouse operational expenses.' },

  // 18. Customer Credit
  { key: 'crm:credit:read', module: 'Customer Credit', action: 'View', name: 'View Customer Credit', description: 'Check customer accounts receivable and credit limits.' },
  { key: 'crm:credit:manage', module: 'Customer Credit', action: 'Manage', name: 'Manage Customer Credit', description: 'Adjust customer credit terms and record debt settlements.' },

  // 19. Reports
  { key: 'rep:report:view', module: 'Reports', action: 'View', name: 'View Analytics & Reports', description: 'Access operational, financial, and inventory analytics.' },
  { key: 'rep:report:export', module: 'Reports', action: 'Export', name: 'Export Reports', description: 'Export financial reports and data sets to CSV, Excel, or PDF.' },

  // 20. Organization Settings
  { key: 'org:tenant:manage', module: 'Organization Settings', action: 'Manage', name: 'Manage Organization', description: 'Configure company legal identity, currency, and business profile.' },
  { key: 'org:branch:read', module: 'Organization Settings', action: 'View', name: 'View Branches', description: 'Inspect store locations and physical outlets.' },
  { key: 'org:branch:manage', module: 'Organization Settings', action: 'Manage', name: 'Manage Branches', description: 'Create and configure physical branch outlets.' },
  { key: 'org:warehouse:read', module: 'Organization Settings', action: 'View', name: 'View Warehouses', description: 'Inspect storage depots and fulfillment centers.' },
  { key: 'org:warehouse:manage', module: 'Organization Settings', action: 'Manage', name: 'Manage Warehouses', description: 'Create and configure storage warehouses and depot links.' },
  { key: 'iam:member:read', module: 'Organization Settings', action: 'View', name: 'View Organization Members', description: 'Inspect active team members and their assigned roles.' },
  { key: 'iam:member:manage', module: 'Organization Settings', action: 'Manage', name: 'Manage Team Members', description: 'Invite, assign roles, and configure location scopes for staff.' },
  { key: 'iam:role:manage', module: 'Organization Settings', action: 'Manage', name: 'Manage Custom Roles', description: 'Design custom access roles and configure granular permissions.' },
  { key: 'sub:subscription:read', module: 'Organization Settings', action: 'View', name: 'View Subscription & Quotas', description: 'Check subscription tier, renewal dates, and resource quotas.' },
  { key: 'sub:subscription:manage', module: 'Organization Settings', action: 'Manage', name: 'Manage Subscription Plan', description: 'Change subscription plans and request plan upgrades.' },
  { key: 'sub:payment:record', module: 'Organization Settings', action: 'Manage', name: 'Record Subscription Payment', description: 'Record billing transactions for software subscriptions.' },
  { key: 'i18n:settings:read', module: 'Organization Settings', action: 'View', name: 'View Regional Settings', description: 'Inspect timezone, number format, and localization rules.' },
  { key: 'i18n:settings:manage', module: 'Organization Settings', action: 'Manage', name: 'Manage Regional Settings', description: 'Configure tenant timezone, locale, and currency formats.' },
  { key: 'i18n:fx:manage', module: 'Organization Settings', action: 'Manage', name: 'Manage Exchange Rates', description: 'Configure multi-currency exchange rate tables.' },
  { key: 'i18n:tax:manage', module: 'Organization Settings', action: 'Manage', name: 'Manage Tax Configurations', description: 'Configure tax groups, rates, and automated tax calculations.' },
];

export const ALL_SYSTEM_PERMISSIONS: readonly PermissionKey[] = PERMISSIONS_CATALOG.map(
  (p) => p.key as PermissionKey,
);

export const SYSTEM_ROLE_DESCRIPTIONS: Readonly<Record<SystemRoleCode, string>> = {
  TENANT_OWNER:
    'Full organization control with unrestricted access across all branches, warehouses, payroll, and settings.',
  ORG_ADMIN:
    'Administrative access to manage inventory, catalog, sales, staff, and operations without subscription payment recording.',
  BRANCH_MANAGER:
    'Location-scoped operational management for store branches, local inventory, POS registers, and staff directory.',
  CASHIER:
    'Frontline point-of-sale operator permitted to open/close assigned registers, process customer sales, and take payments.',
  WAREHOUSE_CLERK:
    'Warehouse logistics operator responsible for stock movement receipts, dispatch transfers, counts, and bin tracking.',
  PURCHASER:
    'Procurement coordinator managing supplier relationships, purchase orders, and stock intake catalog items.',
  ACCOUNTANT:
    'Financial controller managing compensation plans, payroll calculation runs, disbursements, and accounting reports.',
};

export const SYSTEM_ROLE_DEFINITIONS: Readonly<
  Record<
    SystemRoleCode,
    { readonly name: string; readonly permissions: readonly PermissionKey[] }
  >
> = {
  TENANT_OWNER: {
    name: 'Tenant Owner',
    permissions: ALL_SYSTEM_PERMISSIONS,
  },
  ORG_ADMIN: {
    name: 'Organization Administrator',
    permissions: ALL_SYSTEM_PERMISSIONS.filter((p) => p !== 'sub:payment:record'),
  },
  BRANCH_MANAGER: {
    name: 'Branch Manager',
    permissions: [
      'dash:view',
      'org:branch:read',
      'org:branch:manage',
      'org:warehouse:read',
      'org:warehouse:manage',
      'org:register:read',
      'org:register:manage',
      'iam:member:read',
      'i18n:settings:read',
      'cat:category:read',
      'cat:category:manage',
      'cat:product:read',
      'cat:product:manage',
      'pur:supplier:read',
      'pur:supplier:manage',
      'inv:balance:read',
      'inv:movement:read',
      'inv:movement:post',
      'inv:movement:reverse',
      'pos:register:read',
      'pos:shift:open',
      'pos:shift:close',
      'pos:sale:create',
      'pos:sale:read',
      'pos:sale:void',
      'pos:payment:create',
      'inv:batch:read',
      'inv:batch:manage',
      'inv:serial:read',
      'inv:serial:manage',
      'inv:costing:read',
      'inv:count:read',
      'inv:count:create',
      'inv:count:submit',
      'inv:count:approve',
      'inv:count:post',
      'hrm:employee:read',
      'exp:expense:read',
      'exp:expense:manage',
      'crm:credit:read',
      'crm:credit:manage',
      'rep:report:view',
    ],
  },
  CASHIER: {
    name: 'POS Cashier',
    permissions: [
      'org:branch:read',
      'org:register:read',
      'i18n:settings:read',
      'cat:category:read',
      'cat:product:read',
      'inv:balance:read',
      'pos:register:read',
      'pos:shift:open',
      'pos:shift:close',
      'pos:sale:create',
      'pos:sale:read',
      'pos:payment:create',
      'inv:batch:read',
      'inv:serial:read',
      'crm:credit:read',
    ],
  },
  WAREHOUSE_CLERK: {
    name: 'Warehouse Clerk',
    permissions: [
      'org:branch:read',
      'org:warehouse:read',
      'i18n:settings:read',
      'cat:category:read',
      'cat:product:read',
      'pur:supplier:read',
      'inv:balance:read',
      'inv:movement:read',
      'inv:movement:post',
      'inv:batch:read',
      'inv:batch:manage',
      'inv:serial:read',
      'inv:serial:manage',
      'inv:count:read',
      'inv:count:create',
      'inv:count:submit',
    ],
  },
  PURCHASER: {
    name: 'Purchasing Officer',
    permissions: [
      'org:branch:read',
      'org:warehouse:read',
      'i18n:settings:read',
      'cat:category:read',
      'cat:category:manage',
      'cat:product:read',
      'cat:product:manage',
      'pur:supplier:read',
      'pur:supplier:manage',
      'inv:balance:read',
      'inv:movement:read',
      'inv:movement:post',
      'inv:batch:read',
      'inv:batch:manage',
      'inv:serial:read',
      'inv:costing:read',
    ],
  },
  ACCOUNTANT: {
    name: 'Staff Accountant',
    permissions: [
      'dash:view',
      'org:tenant:manage',
      'org:branch:read',
      'org:warehouse:read',
      'org:register:read',
      'iam:member:read',
      'sub:subscription:read',
      'sub:payment:record',
      'i18n:settings:read',
      'i18n:fx:manage',
      'i18n:tax:manage',
      'cat:category:read',
      'cat:product:read',
      'pur:supplier:read',
      'inv:balance:read',
      'inv:movement:read',
      'pos:sale:read',
      'inv:batch:read',
      'inv:serial:read',
      'inv:costing:read',
      'inv:count:read',
      'inv:count:approve',
      'hrm:employee:read',
      'hrm:salary:read',
      'hrm:salary:manage',
      'hrm:payroll:read',
      'hrm:payroll:process',
      'hrm:payroll:approve',
      'hrm:payroll:pay',
      'exp:expense:read',
      'exp:expense:manage',
      'crm:credit:read',
      'crm:credit:manage',
      'rep:report:view',
      'rep:report:export',
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
    .select([
      'roles.id as role_id',
      'roles.code as role_code',
      'roles.is_system_role as is_system_role',
    ])
    .where('member_role_assignments.tenant_id', '=', trx.tenantId)
    .where('member_role_assignments.membership_id', '=', membership.id)
    .execute();

  const roleIds = assignedRoles.map((r) => r.role_id);
  const roleCodes = assignedRoles.map((r) => r.role_code);

  const permissions = new Set<string>();
  if (roleIds.length > 0) {
    const permRows = await trx.db
      .selectFrom('role_permissions')
      .select(['permission_key', 'role_id'])
      .where('tenant_id', '=', trx.tenantId)
      .where('role_id', 'in', roleIds)
      .execute();

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

    if (allowedBranchIds.size > 0) {
      const branchIdList = [...allowedBranchIds];
      const branchWarehouses = await trx.db
        .selectFrom('warehouses')
        .select(['id'])
        .where('tenant_id', '=', trx.tenantId)
        .where('branch_id', 'in', branchIdList)
        .execute();

      for (const wh of branchWarehouses) {
        allowedWarehouseIds.add(wh.id);
      }

      const linkedWarehouses = await trx.db
        .selectFrom('branch_warehouse_links')
        .select(['warehouse_id'])
        .where('tenant_id', '=', trx.tenantId)
        .where('branch_id', 'in', branchIdList)
        .execute();

      for (const link of linkedWarehouses) {
        allowedWarehouseIds.add(link.warehouse_id);
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

  const roleRows = await trx.db
    .selectFrom('roles')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .orderBy('is_system_role', 'desc')
    .orderBy('name', 'asc')
    .execute();

  const memberAssignments = await trx.db
    .selectFrom('member_role_assignments')
    .select(['role_id'])
    .where('tenant_id', '=', trx.tenantId)
    .execute();

  const memberCountMap = new Map<string, number>();
  for (const m of memberAssignments) {
    memberCountMap.set(m.role_id, (memberCountMap.get(m.role_id) ?? 0) + 1);
  }

  const rolePermRows = await trx.db
    .selectFrom('role_permissions')
    .select(['role_id', 'permission_key'])
    .where('tenant_id', '=', trx.tenantId)
    .execute();

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

  return { success: true, roleId };
}

export async function listMembers(
  trx: TenantTransactionContext,
): Promise<MemberSummaryResponse[]> {
  await assertAuthorized(trx, { permission: 'iam:member:read' });

  const members = await trx.db
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
    .execute();

  const assignments = await trx.db
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
    .execute();

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

  const scopes = await trx.db
    .selectFrom('member_location_scopes')
    .select(['membership_id', 'branch_id', 'warehouse_id'])
    .where('tenant_id', '=', trx.tenantId)
    .execute();

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

  for (const role of targetRoles) {
    if (role.is_system_role && role.code in SYSTEM_ROLE_DEFINITIONS) {
      for (const p of SYSTEM_ROLE_DEFINITIONS[role.code as SystemRoleCode].permissions) {
        requiredPerms.add(p);
      }
    } else {
      const perms = await trx.db
        .selectFrom('role_permissions')
        .select(['permission_key'])
        .where('tenant_id', '=', trx.tenantId)
        .where('role_id', '=', role.id)
        .execute();

      for (const p of perms) {
        requiredPerms.add(p.permission_key);
      }
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

import type { PermissionItem } from '@nexstock/contracts';

export type SystemRoleCode =
  | 'TENANT_OWNER'
  | 'ORG_ADMIN'
  | 'BRANCH_MANAGER'
  | 'CASHIER'
  | 'WAREHOUSE_CLERK'
  | 'PURCHASER'
  | 'ACCOUNTANT'
  | 'STAFF';

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
  | 'hrm:attendance:read'
  | 'hrm:attendance:manage'
  | 'hrm:attendance:self'
  | 'hrm:leave:read'
  | 'hrm:leave:manage'
  | 'hrm:leave:approve'
  | 'hrm:leave:self'
  | 'hrm:schedule:read'
  | 'hrm:schedule:manage'
  | 'hrm:holiday:read'
  | 'hrm:holiday:manage'
  | 'hrm:settings:read'
  | 'hrm:settings:manage'
  | 'exp:expense:read'
  | 'exp:expense:create'
  | 'exp:expense:edit'
  | 'exp:expense:delete'
  | 'exp:expense:submit'
  | 'exp:expense:approve'
  | 'exp:expense:pay'
  | 'exp:category:manage'
  | 'exp:report:view'
  | 'exp:expense:manage'
  | 'crm:customer:read'
  | 'crm:customer:manage'
  | 'crm:credit:read'
  | 'crm:credit:create'
  | 'crm:credit:manage'
  | 'crm:credit:hold'
  | 'crm:limit:manage'
  | 'crm:sale:create'
  | 'crm:sale:approve'
  | 'crm:transaction:create'
  | 'crm:payment:create'
  | 'crm:payment:reverse'
  | 'crm:ledger:read'
  | 'crm:adjustment:create'
  | 'crm:interest:manage'
  | 'crm:interest:waive'
  | 'crm:collection:manage'
  | 'crm:writeoff:create'
  | 'crm:writeoff:approve'
  | 'crm:report:read'
  | 'crm:settings:manage'
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
  { key: 'hrm:attendance:read', module: 'HRM', action: 'View', name: 'View Attendance Records', description: 'View organization-wide staff attendance ledgers and logs.' },
  { key: 'hrm:attendance:manage', module: 'HRM', action: 'Manage', name: 'Manage Attendance', description: 'Record and correct employee attendance records manually.' },
  { key: 'hrm:attendance:self', module: 'HRM', action: 'Create', name: 'Staff Attendance Check-In', description: 'Clock in and clock out for authenticated staff profile.' },
  { key: 'hrm:leave:read', module: 'HRM', action: 'View', name: 'View Leave Requests', description: 'Browse submitted staff leave requests and leave balances.' },
  { key: 'hrm:leave:manage', module: 'HRM', action: 'Manage', name: 'Manage Leave Requests', description: 'Submit leave directly on behalf of employees.' },
  { key: 'hrm:leave:approve', module: 'HRM', action: 'Approve', name: 'Approve Leave Requests', description: 'Approve or reject employee leave applications.' },
  { key: 'hrm:leave:self', module: 'HRM', action: 'Create', name: 'Staff Leave Self-Service', description: 'Submit leave applications and check personal leave balances.' },
  { key: 'hrm:schedule:read', module: 'HRM', action: 'View', name: 'View Work Schedules', description: 'Inspect individual employee work schedules and shifts.' },
  { key: 'hrm:schedule:manage', module: 'HRM', action: 'Manage', name: 'Manage Work Schedules', description: 'Configure weekly shifts and work days per employee.' },
  { key: 'hrm:holiday:read', module: 'HRM', action: 'View', name: 'View Holiday Calendar', description: 'Inspect public and organization holiday dates.' },
  { key: 'hrm:holiday:manage', module: 'HRM', action: 'Manage', name: 'Manage Holiday Calendar', description: 'Create and configure official holidays.' },
  { key: 'hrm:settings:read', module: 'HRM', action: 'View', name: 'View Payroll & HR Settings', description: 'Inspect proration and GPS attendance policies.' },
  { key: 'hrm:settings:manage', module: 'HRM', action: 'Manage', name: 'Manage Payroll & HR Settings', description: 'Configure salary proration rules and GPS geofence settings.' },

  // 17. Expenses
  { key: 'exp:expense:read', module: 'Expenses', action: 'View', name: 'View Expenses', description: 'Inspect operating expenses and vendor payout records.' },
  { key: 'exp:expense:create', module: 'Expenses', action: 'Create', name: 'Create Expenses', description: 'Record draft operating expenses and receipts.' },
  { key: 'exp:expense:edit', module: 'Expenses', action: 'Edit', name: 'Edit Expenses', description: 'Modify draft or rejected expense entries.' },
  { key: 'exp:expense:delete', module: 'Expenses', action: 'Delete', name: 'Delete Expenses', description: 'Remove draft expense records.' },
  { key: 'exp:expense:submit', module: 'Expenses', action: 'Edit', name: 'Submit Expenses', description: 'Submit draft expenses for manager approval.' },
  { key: 'exp:expense:approve', module: 'Expenses', action: 'Approve', name: 'Approve Expenses', description: 'Approve or reject submitted expense requests.' },
  { key: 'exp:expense:pay', module: 'Expenses', action: 'Manage', name: 'Disburse Expense Payments', description: 'Record payment disbursements for approved expenses.' },
  { key: 'exp:category:manage', module: 'Expenses', action: 'Manage', name: 'Manage Expense Categories', description: 'Create, update, and deactivate expense categories.' },
  { key: 'exp:report:view', module: 'Expenses', action: 'View', name: 'View Expense Reports', description: 'Access expense dashboard summaries and analytics.' },
  { key: 'exp:expense:manage', module: 'Expenses', action: 'Manage', name: 'Manage Expenses', description: 'Record and categorize store and warehouse operational expenses.' },

  // 18. Customers & Customer Credit
  { key: 'crm:customer:read', module: 'Customers', action: 'View', name: 'View Customers', description: 'Browse and inspect customer accounts and directory.' },
  { key: 'crm:customer:manage', module: 'Customers', action: 'Manage', name: 'Manage Customers', description: 'Create and update customer profiles and contact details.' },
  { key: 'crm:credit:read', module: 'Customer Credit', action: 'View', name: 'View Customer Credit', description: 'Check customer accounts receivable and credit limits.' },
  { key: 'crm:credit:create', module: 'Customer Credit', action: 'Create', name: 'Create Credit Accounts', description: 'Open new customer credit accounts and terms.' },
  { key: 'crm:credit:manage', module: 'Customer Credit', action: 'Manage', name: 'Manage Customer Credit', description: 'Adjust customer credit terms and record debt settlements.' },
  { key: 'crm:credit:hold', module: 'Customer Credit', action: 'Manage', name: 'Manage Credit Holds', description: 'Place or release customer accounts on credit hold.' },
  { key: 'crm:limit:manage', module: 'Customer Credit', action: 'Manage', name: 'Manage Credit Limits', description: 'Increase, decrease, or override customer credit limits.' },
  { key: 'crm:sale:create', module: 'Customer Credit', action: 'Create', name: 'Process Credit Sales', description: 'Execute POS and manual customer credit sales.' },
  { key: 'crm:sale:approve', module: 'Customer Credit', action: 'Approve', name: 'Approve Credit Sales', description: 'Authorize credit sales requiring management sign-off.' },
  { key: 'crm:transaction:create', module: 'Customer Credit', action: 'Create', name: 'Create Credit Transactions', description: 'Post manual credit and debit entries and notes.' },
  { key: 'crm:payment:create', module: 'Customer Credit', action: 'Create', name: 'Record Credit Payments', description: 'Accept customer debt payments and allocate to invoices.' },
  { key: 'crm:payment:reverse', module: 'Customer Credit', action: 'Manage', name: 'Reverse Credit Payments', description: 'Reverse erroneous customer credit payments.' },
  { key: 'crm:ledger:read', module: 'Customer Credit', action: 'View', name: 'View Credit Ledger', description: 'Inspect immutable customer credit ledger history.' },
  { key: 'crm:adjustment:create', module: 'Customer Credit', action: 'Manage', name: 'Create Credit Adjustments', description: 'Create authorized ledger balance adjustments.' },
  { key: 'crm:interest:manage', module: 'Customer Credit', action: 'Manage', name: 'Manage Interest & Late Fees', description: 'Configure and accrue interest and overdue penalties.' },
  { key: 'crm:interest:waive', module: 'Customer Credit', action: 'Approve', name: 'Waive Interest & Fees', description: 'Authorize waivers for customer interest and late fees.' },
  { key: 'crm:collection:manage', module: 'Customer Credit', action: 'Manage', name: 'Manage Collections', description: 'Track debt follow-ups and collection commitments.' },
  { key: 'crm:writeoff:create', module: 'Customer Credit', action: 'Create', name: 'Submit Bad Debt Write-offs', description: 'Submit bad debt write-off requests for approval.' },
  { key: 'crm:writeoff:approve', module: 'Customer Credit', action: 'Approve', name: 'Approve Bad Debt Write-offs', description: 'Authorize uncollectible debt write-offs.' },
  { key: 'crm:report:read', module: 'Customer Credit', action: 'View', name: 'View Credit Reports', description: 'Access credit aging, customer statements, and risk analytics.' },
  { key: 'crm:settings:manage', module: 'Customer Credit', action: 'Manage', name: 'Manage Credit Settings', description: 'Configure organization credit limits, terms, and policies.' },

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
  STAFF:
    'Standard employee account with self-service access to personal attendance, work schedule, holidays, and leave requests.',
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
      'hrm:attendance:self',
      'hrm:attendance:read',
      'hrm:leave:self',
      'hrm:leave:read',
      'hrm:holiday:read',
      'hrm:schedule:read',
      'exp:expense:read',
      'exp:expense:create',
      'exp:expense:edit',
      'exp:expense:delete',
      'exp:expense:submit',
      'exp:expense:approve',
      'exp:report:view',
      'exp:expense:manage',
      'crm:customer:read',
      'crm:credit:read',
      'crm:credit:create',
      'crm:credit:manage',
      'crm:credit:hold',
      'crm:limit:manage',
      'crm:sale:create',
      'crm:sale:approve',
      'crm:transaction:create',
      'crm:payment:create',
      'crm:ledger:read',
      'crm:collection:manage',
      'crm:report:read',
      'rep:report:view',
    ],
  },
  CASHIER: {
    name: 'POS Cashier',
    permissions: [
      'dash:view',
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
      'crm:customer:read',
      'crm:credit:read',
      'crm:credit:create',
      'crm:sale:create',
      'crm:payment:create',
      'crm:ledger:read',
      'hrm:attendance:self',
      'hrm:leave:self',
      'exp:expense:read',
      'exp:expense:create',
      'exp:expense:submit',
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
      'hrm:attendance:self',
      'hrm:leave:self',
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
      'hrm:attendance:self',
      'hrm:leave:self',
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
      'hrm:attendance:self',
      'hrm:attendance:read',
      'hrm:leave:self',
      'hrm:leave:read',
      'hrm:holiday:read',
      'hrm:schedule:read',
      'hrm:salary:read',
      'hrm:salary:manage',
      'hrm:payroll:read',
      'hrm:payroll:process',
      'hrm:payroll:approve',
      'hrm:payroll:pay',
      'exp:expense:read',
      'exp:expense:create',
      'exp:expense:edit',
      'exp:expense:delete',
      'exp:expense:submit',
      'exp:expense:approve',
      'exp:expense:pay',
      'exp:category:manage',
      'exp:report:view',
      'exp:expense:manage',
      'crm:customer:read',
      'crm:customer:manage',
      'crm:credit:read',
      'crm:credit:create',
      'crm:credit:manage',
      'crm:credit:hold',
      'crm:limit:manage',
      'crm:sale:create',
      'crm:sale:approve',
      'crm:transaction:create',
      'crm:payment:create',
      'crm:payment:reverse',
      'crm:ledger:read',
      'crm:adjustment:create',
      'crm:interest:manage',
      'crm:interest:waive',
      'crm:collection:manage',
      'crm:writeoff:create',
      'crm:writeoff:approve',
      'crm:report:read',
      'crm:settings:manage',
      'rep:report:view',
      'rep:report:export',
    ],
  },
  STAFF: {
    name: 'Staff Employee',
    permissions: [
      'dash:view',
      'hrm:attendance:self',
      'hrm:leave:self',
      'hrm:schedule:read',
      'hrm:holiday:read',
    ],
  },
};

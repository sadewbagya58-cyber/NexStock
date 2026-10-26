import type { ColumnType, Generated } from 'kysely';

export interface IdempotencyKeysTable {
  tenant_id: string;
  idempotency_key: string;
  actor_user_id: string;
  endpoint: string;
  request_hash: string;
  status: 'PROCESSING' | 'COMPLETED';
  response_status_code: number | null;
  response_body: unknown | null;
  created_at: Generated<Date>;
  expires_at: Date;
}

export interface OutboxEventsTable {
  id: string;
  tenant_id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  payload_json: unknown;
  status: Generated<'PENDING' | 'PROCESSED' | 'FAILED'>;
  created_at: Generated<Date>;
  processed_at: Date | null;
}

export interface AuditLogsTable {
  id: string;
  tenant_id: string;
  actor_user_id: string;
  action: string;
  resource_type: string;
  resource_id: string;
  metadata_json: unknown;
  trace_id: string;
  created_at: Generated<Date>;
}

export interface SyncCommandLogTable {
  tenant_id: string;
  command_id: string;
  branch_id: string;
  device_id: string;
  actor_user_id: string;
  local_seq: number;
  command_type: string;
  status: 'APPLIED' | 'APPLIED_WITH_CONFLICT_FLAG' | 'QUARANTINED';
  conflict_code: string | null;
  response_json: unknown;
  occurred_at: ColumnType<Date, Date | string, Date | string>;
  processed_at: Generated<Date>;
}

export interface SyncConflictsTable {
  id: string;
  tenant_id: string;
  branch_id: string;
  device_id: string;
  command_id: string;
  conflict_type: string;
  status: Generated<'OPEN' | 'QUARANTINED' | 'RESOLVED' | 'DISMISSED'>;
  details_json: unknown;
  created_at: Generated<Date>;
  resolved_at: Date | null;
}

// ============================================================================
// Milestone 1 Tables (I18N, ORG, SUB, IAM)
// ============================================================================

export interface CurrenciesTable {
  code: string;
  name: string;
  symbol: string;
  minor_units: number;
  is_active: Generated<boolean>;
}

export type TenantLifecycleStatus =
  | 'TRIALING'
  | 'ACTIVE'
  | 'PAST_DUE'
  | 'GRACE_PERIOD'
  | 'SUSPENDED'
  | 'CANCELLED';

export interface TenantsTable {
  id: string;
  slug: string;
  legal_name: string;
  base_currency: string;
  default_locale: Generated<string>;
  default_timezone: Generated<string>;
  country_code: Generated<string>;
  status: Generated<TenantLifecycleStatus>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface BranchesTable {
  id: string;
  tenant_id: string;
  code: string;
  name: string;
  timezone: string;
  country_code: string;
  default_warehouse_id: string | null;
  is_active: Generated<boolean>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface WarehousesTable {
  id: string;
  tenant_id: string;
  branch_id: string | null;
  code: string;
  name: string;
  allow_negative_stock: Generated<boolean>;
  is_active: Generated<boolean>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface BranchWarehouseLinksTable {
  id: string;
  tenant_id: string;
  branch_id: string;
  warehouse_id: string;
  is_primary: Generated<boolean>;
  created_at: Generated<Date>;
}

export interface PosRegistersTable {
  id: string;
  tenant_id: string;
  branch_id: string;
  warehouse_id: string;
  code: string;
  name: string;
  last_invoice_seq: Generated<string | number>;
  is_active: Generated<boolean>;
  created_at: Generated<Date>;
}

export interface TenantLocalizationSettingsTable {
  id: string;
  tenant_id: string;
  locale: string;
  timezone: string;
  date_format: string;
  number_format: string;
  currency_display_mode: 'SYMBOL' | 'ISO_CODE' | 'SYMBOL_AND_CODE';
  updated_at: Generated<Date>;
}

export interface TenantExchangeRatesTable {
  id: string;
  tenant_id: string;
  source_currency: string;
  target_currency: string;
  rate: string;
  effective_from: ColumnType<Date, Date | string, Date | string>;
  created_by_user_id: string;
  created_at: Generated<Date>;
}

export interface TaxGroupsTable {
  id: string;
  tenant_id: string;
  code: string;
  name: string;
  country_code: string;
  is_active: Generated<boolean>;
  created_at: Generated<Date>;
}

export interface TaxRatesTable {
  id: string;
  tenant_id: string;
  tax_group_id: string;
  code: string;
  name: string;
  rate_percentage: string;
  is_compound: Generated<boolean>;
  priority: Generated<number>;
  is_active: Generated<boolean>;
  created_at: Generated<Date>;
}

export interface SubscriptionPlansTable {
  id: string;
  code: string;
  name: string;
  max_branches: number;
  max_warehouses: number;
  max_registers: number;
  max_users: number;
  monthly_price_amount: string;
  currency_code: string;
  features_json: unknown;
  is_active: Generated<boolean>;
  created_at: Generated<Date>;
}

export interface TenantSubscriptionsTable {
  id: string;
  tenant_id: string;
  plan_id: string;
  billing_mode: Generated<'ADMIN_PROVISIONED' | 'EXTERNAL_PROVIDER'>;
  provider_code: Generated<
    'MANUAL_ADMIN' | 'PAYHERE_LK' | 'STRIPE' | 'PADDLE'
  >;
  status: TenantLifecycleStatus;
  trial_ends_at: ColumnType<Date | null, Date | string | null, Date | string | null>;
  current_period_start: ColumnType<Date, Date | string, Date | string>;
  current_period_end: ColumnType<Date, Date | string, Date | string>;
  allow_admin_override: Generated<boolean>;
  override_reason: string | null;
  updated_at: Generated<Date>;
}

export interface SubscriptionInvoicesTable {
  id: string;
  tenant_id: string;
  subscription_id: string;
  invoice_number: string;
  currency_code: string;
  total_amount: string;
  amount_paid: Generated<string>;
  status: 'DRAFT' | 'OPEN' | 'PAID' | 'PAST_DUE' | 'VOID';
  due_date: ColumnType<Date | string, Date | string, Date | string>;
  issued_at: Generated<Date>;
}

export interface SubscriptionPaymentsTable {
  id: string;
  tenant_id: string;
  subscription_invoice_id: string;
  currency_code: string;
  amount: string;
  payment_method:
    | 'BANK_TRANSFER'
    | 'MANUAL_RECEIPT'
    | 'CHEQUE'
    | 'EXTERNAL_GATEWAY_REF';
  reference_number: string;
  recorded_by_user_id: string;
  paid_at: Generated<Date>;
}

export interface UsersTable {
  id: string;
  email: string;
  full_name: string;
  is_platform_admin: Generated<boolean>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface TenantMembershipsTable {
  id: string;
  tenant_id: string;
  user_id: string;
  status: Generated<'INVITED' | 'ACTIVE' | 'DISABLED'>;
  all_locations_access: Generated<boolean>;
  pin_hash: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface RolesTable {
  id: string;
  tenant_id: string;
  code: string;
  name: string;
  is_system_role: Generated<boolean>;
  created_at: Generated<Date>;
}

export interface RolePermissionsTable {
  id: string;
  tenant_id: string;
  role_id: string;
  permission_key: string;
  created_at: Generated<Date>;
}

export interface MemberRoleAssignmentsTable {
  id: string;
  tenant_id: string;
  membership_id: string;
  role_id: string;
  created_at: Generated<Date>;
}

export interface MemberLocationScopesTable {
  id: string;
  tenant_id: string;
  membership_id: string;
  branch_id: string | null;
  warehouse_id: string | null;
  created_at: Generated<Date>;
}

export interface SupervisorOverrideLogsTable {
  id: string;
  tenant_id: string;
  branch_id: string;
  actor_user_id: string;
  supervisor_user_id: string;
  permission_key: string;
  action_description: string;
  resource_id: string;
  created_at: Generated<Date>;
}

export interface NexStockDatabase {
  idempotency_keys: IdempotencyKeysTable;
  outbox_events: OutboxEventsTable;
  audit_logs: AuditLogsTable;
  sync_command_log: SyncCommandLogTable;
  sync_conflicts: SyncConflictsTable;
  currencies: CurrenciesTable;
  tenants: TenantsTable;
  branches: BranchesTable;
  warehouses: WarehousesTable;
  branch_warehouse_links: BranchWarehouseLinksTable;
  pos_registers: PosRegistersTable;
  tenant_localization_settings: TenantLocalizationSettingsTable;
  tenant_exchange_rates: TenantExchangeRatesTable;
  tax_groups: TaxGroupsTable;
  tax_rates: TaxRatesTable;
  subscription_plans: SubscriptionPlansTable;
  tenant_subscriptions: TenantSubscriptionsTable;
  subscription_invoices: SubscriptionInvoicesTable;
  subscription_payments: SubscriptionPaymentsTable;
  users: UsersTable;
  tenant_memberships: TenantMembershipsTable;
  roles: RolesTable;
  role_permissions: RolePermissionsTable;
  member_role_assignments: MemberRoleAssignmentsTable;
  member_location_scopes: MemberLocationScopesTable;
  supervisor_override_logs: SupervisorOverrideLogsTable;
}

import type { ColumnType, Generated } from 'kysely';

export interface SchemaMigrationsTable {
  version: number;
  name: string;
  filename: string;
  applied_at: Generated<Date>;
  applied_by: Generated<string>;
}

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

// ============================================================================
// Phase 2 Core Inventory Tables (CAT, PUR, INV)
// ============================================================================

export interface CategoriesTable {
  id: string;
  tenant_id: string;
  parent_id: string | null;
  name: string;
  description: string | null;
  status: Generated<'ACTIVE' | 'ARCHIVED'>;
  sync_version: Generated<string | number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  archived_at: ColumnType<Date | null, Date | string | null, Date | string | null>;
}

export interface ProductsTable {
  id: string;
  tenant_id: string;
  sku: string;
  name: string;
  description: string | null;
  product_type: Generated<'STANDARD' | 'SERVICE' | 'BUNDLE'>;
  status: Generated<'ACTIVE' | 'ARCHIVED'>;
  category_id: string | null;
  base_uom: string;
  purchase_cost: string;
  selling_price: string;
  tax_group_id: string | null;
  track_inventory: Generated<boolean>;
  reorder_point: Generated<string>;
  reorder_qty: Generated<string>;
  image_url: string | null;
  image_alt: string | null;
  primary_barcode: string | null;
  sync_version: Generated<string | number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  archived_at: ColumnType<Date | null, Date | string | null, Date | string | null>;
}

export interface ProductBarcodesTable {
  id: string;
  tenant_id: string;
  product_id: string;
  barcode: string;
  barcode_type: Generated<'EAN13' | 'UPCA' | 'CODE128' | 'QR' | 'CUSTOM'>;
  uom_code: string;
  is_primary: Generated<boolean>;
  created_at: Generated<Date>;
}

export interface ProductUnitConversionsTable {
  id: string;
  tenant_id: string;
  product_id: string;
  uom_code: string;
  uom_name: string;
  conversion_factor_to_base: string;
  is_active: Generated<boolean>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface SuppliersTable {
  id: string;
  tenant_id: string;
  code: string;
  business_name: string;
  contact_person: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  tax_registration_number: string | null;
  notes: string | null;
  status: Generated<'ACTIVE' | 'ARCHIVED'>;
  sync_version: Generated<string | number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  archived_at: ColumnType<Date | null, Date | string | null, Date | string | null>;
}

export interface SupplierProductsTable {
  id: string;
  tenant_id: string;
  supplier_id: string;
  product_id: string;
  supplier_sku: string | null;
  supplier_product_name: string | null;
  unit_cost: string | null;
  currency_code: string | null;
  minimum_order_qty: string | null;
  lead_time_days: number | null;
  is_preferred: Generated<boolean>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export type StockMovementTypeDb =
  | 'OPENING_STOCK'
  | 'STOCK_IN'
  | 'STOCK_OUT'
  | 'ADJUSTMENT_POSITIVE'
  | 'ADJUSTMENT_NEGATIVE'
  | 'CORRECTION_REVERSAL'
  | 'CUSTOMER_RETURN_RESTOCK'
  | 'SUPPLIER_RETURN';

export interface StockLedgerEntriesTable {
  id: string;
  tenant_id: string;
  branch_id: string;
  warehouse_id: string;
  product_id: string;
  supplier_id: string | null;
  movement_type: StockMovementTypeDb;
  uom_code: string;
  input_qty: string;
  conversion_factor_to_base: string;
  qty_delta: string;
  balance_before: string;
  balance_after: string;
  unit_cost: string;
  reference_type: string | null;
  reference_id: string | null;
  reversed_entry_id: string | null;
  reason: string | null;
  negative_stock_override_applied: Generated<boolean>;
  actor_user_id: string;
  idempotency_key: string;
  occurred_at: ColumnType<Date, Date | string, Date | string>;
  recorded_at: Generated<Date>;
  metadata_json: Generated<unknown>;
}

export interface InventoryBalancesTable {
  id: string;
  tenant_id: string;
  branch_id: string;
  warehouse_id: string;
  product_id: string;
  uom_code: string;
  qty_on_hand: string;
  qty_reserved: Generated<string>;
  qty_in_transit: Generated<string>;
  qty_damaged: Generated<string>;
  moving_avg_cost: Generated<string>;
  total_inventory_value: Generated<string>;
  last_ledger_entry_id: string;
  last_movement_at: ColumnType<Date, Date | string, Date | string>;
  sync_version: Generated<string | number>;
  updated_at: Generated<Date>;
}

export interface PosShiftsTable {
  id: string;
  tenant_id: string;
  branch_id: string;
  register_id: string;
  opened_by_user_id: string;
  closed_by_user_id: string | null;
  currency_code: string;
  opening_cash_float: Generated<string>;
  expected_closing_cash: Generated<string>;
  counted_closing_cash: string | null;
  cash_variance: string | null;
  status: Generated<'OPEN' | 'CLOSED'>;
  opened_at: Generated<Date>;
  closed_at: Date | string | null;
  notes: string | null;
  metadata_json: Generated<unknown>;
}

export interface SalesInvoicesTable {
  id: string;
  tenant_id: string;
  branch_id: string;
  warehouse_id: string;
  register_id: string;
  shift_id: string | null;
  customer_id: string | null;
  cashier_user_id: string;
  invoice_number: string;
  status: Generated<'COMPLETED' | 'VOIDED'>;
  currency_code: string;
  exchange_rate_to_base: Generated<string>;
  subtotal_amount: string;
  discount_amount: Generated<string>;
  tax_amount: Generated<string>;
  rounding_adjustment: Generated<string>;
  grand_total: string;
  total_paid: string;
  change_given: Generated<string>;
  customer_name: string | null;
  notes: string | null;
  voided_at: Date | string | null;
  void_reason: string | null;
  voided_by_user_id: string | null;
  idempotency_key: string;
  created_at: Generated<Date>;
  metadata_json: Generated<unknown>;
}

export interface SalesInvoiceLinesTable {
  id: string;
  tenant_id: string;
  invoice_id: string;
  line_number: number;
  product_id: string;
  sku: string;
  product_name: string;
  uom_code: string;
  quantity: string;
  unit_price: string;
  discount_amount: Generated<string>;
  tax_amount: Generated<string>;
  line_total: string;
  tax_rate_snapshot: Generated<unknown>;
  unit_cost_snapshot: Generated<string>;
  created_at: Generated<Date>;
}

export interface SalesPaymentsTable {
  id: string;
  tenant_id: string;
  invoice_id: string;
  payment_method: 'CASH' | 'CARD' | 'OTHER';
  amount: string;
  currency_code: string;
  status: Generated<'COMPLETED' | 'VOIDED'>;
  tendered_amount: string;
  change_amount: Generated<string>;
  card_reference: string | null;
  card_last_four: string | null;
  notes: string | null;
  recorded_by_user_id: string;
  created_at: Generated<Date>;
}

export interface NexStockDatabase {
  schema_migrations: SchemaMigrationsTable;
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
  categories: CategoriesTable;
  products: ProductsTable;
  product_barcodes: ProductBarcodesTable;
  product_unit_conversions: ProductUnitConversionsTable;
  suppliers: SuppliersTable;
  supplier_products: SupplierProductsTable;
  stock_ledger_entries: StockLedgerEntriesTable;
  inventory_balances: InventoryBalancesTable;
  pos_shifts: PosShiftsTable;
  sales_invoices: SalesInvoicesTable;
  sales_invoice_lines: SalesInvoiceLinesTable;
  sales_payments: SalesPaymentsTable;
}

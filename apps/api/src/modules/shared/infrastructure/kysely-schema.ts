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
  description: string | null;
  is_system_role: Generated<boolean>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
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
  color: ColumnType<string | null, string | null | undefined, string | null | undefined>;
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
  tracking_mode: Generated<'NONE' | 'BATCH' | 'BATCH_EXPIRY' | 'SERIAL'>;
  valuation_method: Generated<'MOVING_AVG' | 'FIFO'>;
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
  barcode_type: Generated<'EAN13' | 'EAN8' | 'UPCA' | 'UPCE' | 'CODE128' | 'CODE39' | 'ITF' | 'QR' | 'CUSTOM'>;
  uom_code: string;
  is_primary: Generated<boolean>;
  is_active: Generated<boolean>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface TenantBarcodeSettingsTable {
  tenant_id: string;
  barcode_management_enabled: Generated<boolean>;
  internal_generation_enabled: Generated<boolean>;
  internal_prefix: Generated<string>;
  labels_enabled: Generated<boolean>;
  hardware_scanner_enabled: Generated<boolean>;
  camera_scanner_enabled: Generated<boolean>;
  auto_add_to_cart: Generated<boolean>;
  increment_on_duplicate: Generated<boolean>;
  unknown_barcode_action: Generated<'PROMPT' | 'IGNORE' | 'MANUAL_SEARCH'>;
  default_scan_mode: Generated<'HARDWARE' | 'CAMERA' | 'MANUAL'>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ProductMediaAssetsTable {
  id: string;
  tenant_id: string;
  file_name: string;
  mime_type: 'image/jpeg' | 'image/png' | 'image/webp';
  file_size: number;
  storage_path: string;
  data_base64: string;
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
  batch_id: string | null;
  serial_id: string | null;
  supplier_id: string | null;
  movement_type: StockMovementTypeDb;
  uom_code: string;
  input_qty: string;
  conversion_factor_to_base: string;
  qty_delta: string;
  balance_before: string;
  balance_after: string;
  unit_cost: string;
  total_cost_delta: Generated<string>;
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

export interface PosCashAdjustmentsTable {
  id: string;
  tenant_id: string;
  branch_id: string;
  register_id: string;
  shift_id: string;
  adjustment_type: 'CASH_IN' | 'CASH_OUT' | 'CASH_REFUND';
  amount: string;
  currency_code: string;
  reason: string;
  performed_by_user_id: string;
  created_at: Generated<Date>;
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
  batch_id: string | null;
  serial_id: string | null;
  created_at: Generated<Date>;
}

export interface SalesPaymentsTable {
  id: string;
  tenant_id: string;
  invoice_id: string;
  payment_method: 'CASH' | 'CARD' | 'OTHER' | 'CREDIT' | 'BANK_TRANSFER' | 'CHEQUE';
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

// ============================================================================
// Phase 4 Advanced Inventory Tables (Batches, Serials, Cost Layers, Stocktakes)
// ============================================================================

export interface InventoryBatchesTable {
  id: string;
  tenant_id: string;
  product_id: string;
  warehouse_id: string;
  batch_number: string;
  supplier_id: string | null;
  status: Generated<'ACTIVE' | 'QUARANTINED' | 'DEPLETED'>;
  received_date: ColumnType<Date, Date | string, Date | string>;
  manufacturing_date: ColumnType<Date | null, Date | string | null, Date | string | null>;
  expiry_date: ColumnType<Date | null, Date | string | null, Date | string | null>;
  initial_quantity: string;
  current_quantity: Generated<string>;
  unit_cost: Generated<string>;
  selling_price: ColumnType<string | null, string | number | null | undefined, string | number | null | undefined>;
  currency_code: string;
  quarantine_reason: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export type SerialStatusDb =
  | 'IN_STOCK'
  | 'RESERVED'
  | 'SOLD'
  | 'RETURNED'
  | 'QUARANTINED'
  | 'DAMAGED'
  | 'WRITTEN_OFF';

export interface InventorySerialsTable {
  id: string;
  tenant_id: string;
  product_id: string;
  batch_id: string | null;
  warehouse_id: string;
  branch_id: string;
  serial_number: string;
  status: Generated<SerialStatusDb>;
  unit_cost: Generated<string>;
  currency_code: string;
  received_at: Generated<Date>;
  sold_at: Date | string | null;
  last_movement_id: string | null;
  last_sale_invoice_id: string | null;
  notes: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface InventorySerialTransitionsTable {
  id: string;
  tenant_id: string;
  serial_id: string;
  from_status: string;
  to_status: string;
  reference_type: string | null;
  reference_id: string | null;
  actor_user_id: string;
  notes: string | null;
  occurred_at: Generated<Date>;
}

export interface InventoryCostLayersTable {
  id: string;
  tenant_id: string;
  warehouse_id: string;
  product_id: string;
  batch_id: string | null;
  ledger_entry_id: string;
  layer_date: ColumnType<Date, Date | string, Date | string>;
  received_qty: string;
  remaining_qty: string;
  unit_cost: string;
  currency_code: string;
  status: Generated<'OPEN' | 'DEPLETED'>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export type StocktakeScopeDb = 'FULL_WAREHOUSE' | 'CATEGORY' | 'PARTIAL';
export type StocktakeStatusDb =
  | 'DRAFT'
  | 'IN_PROGRESS'
  | 'SUBMITTED'
  | 'APPROVED'
  | 'REJECTED'
  | 'POSTED';

export interface StocktakeSessionsTable {
  id: string;
  tenant_id: string;
  count_number: string;
  branch_id: string;
  warehouse_id: string;
  scope: StocktakeScopeDb;
  category_id: string | null;
  status: Generated<StocktakeStatusDb>;
  started_at: Date | string | null;
  completed_at: Date | string | null;
  counted_by_user_id: string | null;
  reviewed_by_user_id: string | null;
  rejection_reason: string | null;
  notes: string | null;
  sync_version: Generated<string | number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface StocktakeLinesTable {
  id: string;
  tenant_id: string;
  session_id: string;
  product_id: string;
  batch_id: string | null;
  expected_qty: string;
  counted_qty: string | null;
  variance_qty: string | null;
  unit_cost: Generated<string>;
  variance_value: Generated<string>;
  adjustment_movement_id: string | null;
  notes: string | null;
}

// ============================================================================
// Phase 7.1 Tables (HRM, Employee Management & Flexible Payroll)
// ============================================================================

export type EmploymentStatus =
  | 'ACTIVE'
  | 'PROBATION'
  | 'INACTIVE'
  | 'SUSPENDED'
  | 'TERMINATED';

export type PayrollFrequency = 'MONTHLY' | 'WEEKLY' | 'DAILY';

export type DocumentCategory =
  | 'NIC_PASSPORT'
  | 'CONTRACT'
  | 'CERTIFICATE'
  | 'RESUME'
  | 'OTHER';

export type SalaryPaymentMethod = 'BANK_TRANSFER' | 'CASH' | 'CHEQUE';

export type SalaryComponentType = 'EARNING' | 'DEDUCTION';

export type SalaryCalculationType = 'FIXED_AMOUNT' | 'PERCENTAGE_OF_BASIC';

export type PayrollRunStatus =
  | 'DRAFT'
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'PARTIALLY_PAID'
  | 'PAID'
  | 'CANCELLED';

export type PayrollPaymentStatus = 'UNPAID' | 'PARTIALLY_PAID' | 'PAID';

export interface EmployeesTable {
  id: string;
  tenant_id: string;
  employee_code: string;
  first_name: string;
  last_name: string;
  display_name: string;
  email: string | null;
  phone: string | null;
  national_id: string | null;
  gender: string | null;
  date_of_birth: ColumnType<Date | string | null, Date | string | null, Date | string | null>;
  joined_date: ColumnType<Date | string, Date | string, Date | string>;
  designation: string;
  department: string;
  employment_status: Generated<EmploymentStatus>;
  payroll_frequency: Generated<PayrollFrequency>;
  primary_branch_id: string | null;
  primary_warehouse_id: string | null;
  linked_user_id: string | null;
  avatar_url: string | null;
  bank_name: string | null;
  bank_account_number: string | null;
  bank_branch: string | null;
  epf_number: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  district: string | null;
  postal_code: string | null;
  leaving_date: ColumnType<Date | string | null, Date | string | null, Date | string | null>;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
  notes: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface EmployeeBranchAssignmentsTable {
  id: string;
  tenant_id: string;
  employee_id: string;
  branch_id: string;
  is_primary: Generated<boolean>;
  assigned_at: Generated<Date>;
}

export interface EmployeeWarehouseAssignmentsTable {
  id: string;
  tenant_id: string;
  employee_id: string;
  warehouse_id: string;
  is_primary: Generated<boolean>;
  assigned_at: Generated<Date>;
}

export interface EmployeeDocumentsTable {
  id: string;
  tenant_id: string;
  employee_id: string;
  document_category: DocumentCategory;
  document_title: string;
  file_name: string;
  file_size: number;
  mime_type: string;
  storage_path: string;
  data_base64: string;
  uploaded_by_user_id: string;
  notes: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface EmployeeSalaryStructuresTable {
  id: string;
  tenant_id: string;
  employee_id: string;
  effective_from: ColumnType<Date | string, Date | string, Date | string>;
  basic_salary: string;
  currency_code: string;
  payment_method: Generated<SalaryPaymentMethod>;
  is_active: Generated<boolean>;
  notes: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface EmployeeSalaryComponentsTable {
  id: string;
  tenant_id: string;
  structure_id: string;
  component_type: SalaryComponentType;
  component_name: string;
  calculation_type: SalaryCalculationType;
  component_value: string;
  is_taxable: Generated<boolean>;
  is_statutory: Generated<boolean>;
  is_enabled: Generated<boolean>;
  proration_rule: Generated<'PRORATE' | 'FULL'>;
}

export interface PayrollRunsTable {
  id: string;
  tenant_id: string;
  run_number: string;
  frequency: PayrollFrequency;
  period_start: ColumnType<Date | string, Date | string, Date | string>;
  period_end: ColumnType<Date | string, Date | string, Date | string>;
  payment_date: ColumnType<Date | string, Date | string, Date | string>;
  currency_code: string;
  status: Generated<PayrollRunStatus>;
  total_gross_pay: Generated<string>;
  total_deductions: Generated<string>;
  total_net_pay: Generated<string>;
  total_paid_amount: Generated<string>;
  employee_count: Generated<number>;
  created_by_user_id: string;
  approved_by_user_id: string | null;
  approved_at: ColumnType<Date | string | null, Date | string | null, Date | string | null>;
  notes: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface PayrollItemsTable {
  id: string;
  tenant_id: string;
  payroll_run_id: string;
  employee_id: string;
  basic_salary: Generated<string>;
  allowances_total: Generated<string>;
  overtime_hours: Generated<string>;
  overtime_pay: Generated<string>;
  bonus_pay: Generated<string>;
  commissions_pay: Generated<string>;
  gross_pay: Generated<string>;
  deductions_total: Generated<string>;
  net_pay: Generated<string>;
  paid_amount: Generated<string>;
  payment_status: Generated<PayrollPaymentStatus>;
  components_snapshot: Generated<unknown>;
  calculation_breakdown: Generated<unknown>;
  notes: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface PayrollPaymentsTable {
  id: string;
  tenant_id: string;
  payroll_run_id: string;
  payroll_item_id: string;
  employee_id: string;
  payment_method: SalaryPaymentMethod;
  payment_amount: string;
  currency_code: string;
  payment_date: ColumnType<Date | string, Date | string, Date | string>;
  reference_number: string | null;
  recorded_by_user_id: string;
  notes: string | null;
  created_at: Generated<Date>;
}

export interface EmployeeWorkSchedulesTable {
  id: string;
  tenant_id: string;
  employee_id: string;
  shift_name: Generated<string>;
  shift_type: Generated<'DAY' | 'NIGHT' | 'ROTATING'>;
  shift_start_time: Generated<string>;
  shift_end_time: Generated<string>;
  break_duration_minutes: Generated<number>;
  monday_working: Generated<boolean>;
  tuesday_working: Generated<boolean>;
  wednesday_working: Generated<boolean>;
  thursday_working: Generated<boolean>;
  friday_working: Generated<boolean>;
  saturday_working: Generated<boolean>;
  sunday_working: Generated<boolean>;
  effective_from: ColumnType<Date | string, Date | string, Date | string>;
  effective_to: ColumnType<Date | string | null, Date | string | null, Date | string | null>;
  is_active: Generated<boolean>;
  notes: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface EmployeeAttendanceTable {
  id: string;
  tenant_id: string;
  employee_id: string;
  attendance_date: ColumnType<Date | string, Date | string, Date | string>;
  check_in_time: ColumnType<Date | string | null, Date | string | null, Date | string | null>;
  check_out_time: ColumnType<Date | string | null, Date | string | null, Date | string | null>;
  status: Generated<'PRESENT' | 'ABSENT' | 'LATE' | 'HALF_DAY' | 'PAID_LEAVE' | 'NO_PAY_LEAVE' | 'WEEKLY_OFF' | 'PUBLIC_HOLIDAY'>;
  latitude: string | number | null;
  longitude: string | number | null;
  gps_verified: Generated<boolean>;
  notes: string | null;
  is_manual: Generated<boolean>;
  adjustment_reason: string | null;
  adjusted_by_user_id: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface EmployeeLeaveRequestsTable {
  id: string;
  tenant_id: string;
  employee_id: string;
  leave_type: 'ANNUAL' | 'CASUAL' | 'SICK' | 'NO_PAY' | 'HALF_DAY' | 'SPECIAL';
  start_date: ColumnType<Date | string, Date | string, Date | string>;
  end_date: ColumnType<Date | string, Date | string, Date | string>;
  days_count: string | number;
  is_half_day: Generated<boolean>;
  reason: string;
  status: Generated<'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED'>;
  requested_by_user_id: string | null;
  reviewed_by_user_id: string | null;
  reviewed_at: ColumnType<Date | string | null, Date | string | null, Date | string | null>;
  review_notes: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface EmployeeLeaveBalancesTable {
  id: string;
  tenant_id: string;
  employee_id: string;
  year: number;
  leave_type: 'ANNUAL' | 'CASUAL' | 'SICK' | 'NO_PAY' | 'HALF_DAY' | 'SPECIAL';
  annual_entitlement: Generated<string | number>;
  used_days: Generated<string | number>;
  pending_days: Generated<string | number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface OrgHolidaysTable {
  id: string;
  tenant_id: string;
  holiday_date: ColumnType<Date | string, Date | string, Date | string>;
  name: string;
  holiday_type: Generated<'PUBLIC' | 'ORG' | 'SPECIAL'>;
  is_recurring: Generated<boolean>;
  notes: string | null;
  created_at: Generated<Date>;
}

export interface OrgPayrollSettingsTable {
  tenant_id: string;
  proration_method: Generated<'CALENDAR_DAYS' | 'WORKING_DAYS' | 'FIXED_30_DAYS'>;
  gps_attendance_enabled: Generated<boolean>;
  allowance_proration_policy: Generated<'PRORATE' | 'FULL'>;
  workplace_latitude: string | number | null;
  workplace_longitude: string | number | null;
  geofence_radius_meters: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ExpenseCategoriesTable {
  id: string;
  tenant_id: string;
  code: string;
  name: string;
  description: string | null;
  is_active: Generated<boolean>;
  is_system_default: Generated<boolean>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ExpensesTable {
  id: string;
  tenant_id: string;
  reference_number: string;
  title: string;
  description: string | null;
  category_id: string;
  amount: string | number;
  currency_code: string;
  expense_date: string | Date;
  vendor_payee: string | null;
  payment_method: Generated<'CASH' | 'BANK_TRANSFER' | 'CARD' | 'CHEQUE' | 'OTHER'>;
  branch_id: string | null;
  status: Generated<'DRAFT' | 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED' | 'PAID'>;
  rejection_reason: string | null;
  created_by_user_id: string;
  submitted_at: Date | string | null;
  submitted_by_user_id: string | null;
  approved_at: Date | string | null;
  approved_by_user_id: string | null;
  rejected_at: Date | string | null;
  rejected_by_user_id: string | null;
  paid_at: Date | string | null;
  paid_by_user_id: string | null;
  payment_reference: string | null;
  payment_notes: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ExpenseAttachmentsTable {
  id: string;
  tenant_id: string;
  expense_id: string;
  file_name: string;
  file_size_bytes: number;
  mime_type: string;
  storage_path: string;
  data_base64: string;
  uploaded_by_user_id: string;
  created_at: Generated<Date>;
}

export interface CustomersTable {
  id: string;
  tenant_id: string;
  customer_number: string;
  name: string;
  email: string | null;
  phone: string | null;
  address: string | null;
  tax_id: string | null;
  notes: string | null;
  status: Generated<'ACTIVE' | 'INACTIVE' | 'ARCHIVED'>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface CustomerCreditSettingsTable {
  id: string;
  tenant_id: string;
  default_credit_limit: string | number;
  default_credit_terms: Generated<'IMMEDIATE' | 'NET_7' | 'NET_14' | 'NET_30' | 'NET_60' | 'NET_90' | 'CUSTOM'>;
  default_custom_days: number | null;
  approval_policy: Generated<'AUTO_WITHIN_LIMIT' | 'ALWAYS_REQUIRE_APPROVAL' | 'THRESHOLD_REQUIRED' | 'OVERRIDE_ONLY'>;
  approval_threshold_amount: string | number;
  require_approval_for_overrides: Generated<boolean>;
  require_approval_for_adjustments: Generated<boolean>;
  interest_enabled: Generated<boolean>;
  interest_calculation_mode: Generated<'DAILY' | 'MONTHLY' | 'ANNUAL' | 'FIXED'>;
  interest_rate_percentage: string | number;
  interest_grace_period_days: Generated<number>;
  compounding_enabled: Generated<boolean>;
  late_fee_enabled: Generated<boolean>;
  late_fee_type: Generated<'FIXED' | 'PERCENTAGE' | 'PER_DAY'>;
  late_fee_amount: string | number;
  late_fee_percentage: string | number;
  late_fee_grace_period_days: Generated<number>;
  late_fee_max_amount: string | number;
  auto_hold_enabled: Generated<boolean>;
  auto_hold_max_overdue_days: Generated<number>;
  auto_hold_max_overdue_amount: string | number;
  auto_hold_utilization_threshold: string | number;
  currency_code: Generated<string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface CustomerCreditAccountsTable {
  id: string;
  tenant_id: string;
  customer_id: string;
  account_number: string;
  credit_limit: string | number;
  current_balance: string | number;
  available_credit: string | number;
  total_credit_sales: string | number;
  total_payments: string | number;
  total_interest_charged: string | number;
  total_late_fees: string | number;
  total_written_off: string | number;
  unallocated_payment_balance: string | number;
  credit_terms: Generated<'IMMEDIATE' | 'NET_7' | 'NET_14' | 'NET_30' | 'NET_60' | 'NET_90' | 'CUSTOM'>;
  custom_term_days: number | null;
  status: Generated<'ACTIVE' | 'ON_HOLD' | 'SUSPENDED' | 'BLOCKED' | 'CLOSED'>;
  hold_reason: string | null;
  held_at: Date | string | null;
  held_by_user_id: string | null;
  risk_classification: Generated<'LOW_RISK' | 'MEDIUM_RISK' | 'HIGH_RISK' | 'CRITICAL_RISK'>;
  branch_id: string | null;
  currency_code: Generated<string>;
  opened_at: Generated<Date>;
  closed_at: Date | string | null;
  closed_by_user_id: string | null;
  created_by_user_id: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface CustomerCreditLimitHistoryTable {
  id: string;
  tenant_id: string;
  account_id: string;
  previous_limit: string | number;
  new_limit: string | number;
  change_type: 'INITIAL' | 'INCREASE' | 'DECREASE' | 'TEMPORARY_OVERRIDE' | 'RESTORE';
  reason: string;
  effective_date: Generated<string | Date>;
  expiry_date: string | Date | null;
  requested_by_user_id: string;
  approved_by_user_id: string | null;
  approval_status: Generated<'PENDING' | 'APPROVED' | 'REJECTED'>;
  created_at: Generated<Date>;
}

export interface CustomerCreditTransactionsTable {
  id: string;
  tenant_id: string;
  account_id: string;
  customer_id: string;
  branch_id: string | null;
  transaction_reference: string;
  transaction_type:
    | 'OPENING_BALANCE'
    | 'CREDIT_SALE'
    | 'PAYMENT'
    | 'SALES_RETURN'
    | 'CREDIT_NOTE'
    | 'DEBIT_NOTE'
    | 'INTEREST_CHARGE'
    | 'LATE_FEE'
    | 'ADJUSTMENT_DEBIT'
    | 'ADJUSTMENT_CREDIT'
    | 'PAYMENT_REVERSAL'
    | 'CREDIT_REVERSAL'
    | 'WRITE_OFF'
    | 'ADVANCE_PAYMENT';
  entry_direction: 'DEBIT' | 'CREDIT';
  amount: string | number;
  currency_code: Generated<string>;
  balance_after: string | number;
  unpaid_amount: string | number;
  transaction_date: string | Date;
  posting_date: Generated<Date>;
  due_date: string | Date | null;
  source_reference_type: string;
  source_reference_id: string | null;
  source_reference_number: string | null;
  description: string;
  created_by_user_id: string;
  approval_id: string | null;
  reversal_of_transaction_id: string | null;
  is_reversed: Generated<boolean>;
  reversed_at: Date | string | null;
  reversed_by_user_id: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface CustomerCreditPaymentsTable {
  id: string;
  tenant_id: string;
  account_id: string;
  customer_id: string;
  payment_reference: string;
  receipt_number: string;
  amount: string | number;
  allocated_amount: string | number;
  unallocated_amount: string | number;
  currency_code: Generated<string>;
  payment_date: string | Date;
  payment_method: 'CASH' | 'BANK_TRANSFER' | 'CARD' | 'CHEQUE' | 'OTHER';
  external_reference: string | null;
  branch_id: string | null;
  received_by_user_id: string;
  status: Generated<'COMPLETED' | 'REVERSED'>;
  reversal_reason: string | null;
  reversed_at: Date | string | null;
  reversed_by_user_id: string | null;
  notes: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface CustomerCreditAllocationsTable {
  id: string;
  tenant_id: string;
  payment_id: string;
  invoice_id: string | null;
  transaction_id: string;
  amount: string | number;
  allocated_at: Generated<Date>;
  allocated_by_user_id: string;
  status: Generated<'ACTIVE' | 'REVERSED'>;
  reversal_reason: string | null;
  reversed_at: Date | string | null;
  reversed_by_user_id: string | null;
}

export interface CustomerCreditApprovalsTable {
  id: string;
  tenant_id: string;
  approval_type: 'CREDIT_SALE' | 'LIMIT_CHANGE' | 'LIMIT_OVERRIDE' | 'MANUAL_ADJUSTMENT' | 'INTEREST_WAIVER' | 'WRITE_OFF';
  reference_id: string | null;
  account_id: string;
  requested_by_user_id: string;
  approved_by_user_id: string | null;
  status: Generated<'PENDING' | 'APPROVED' | 'REJECTED'>;
  requested_amount: string | number | null;
  reason: string;
  rejection_reason: string | null;
  decided_at: Date | string | null;
  created_at: Generated<Date>;
}

export interface CustomerCreditInterestEntriesTable {
  id: string;
  tenant_id: string;
  account_id: string;
  transaction_id: string | null;
  source_invoice_id: string | null;
  calculation_period_start: string | Date;
  calculation_period_end: string | Date;
  eligible_principal: string | number;
  rate_percentage: string | number;
  calculation_mode: string;
  calculated_amount: string | number;
  status: Generated<'POSTED' | 'WAIVED' | 'REVERSED'>;
  waiver_reason: string | null;
  waived_by_user_id: string | null;
  waived_at: Date | string | null;
  created_at: Generated<Date>;
}

export interface CustomerCreditLateFeeEntriesTable {
  id: string;
  tenant_id: string;
  account_id: string;
  transaction_id: string | null;
  source_invoice_id: string | null;
  fee_type: string;
  overdue_days: number;
  fee_amount: string | number;
  status: Generated<'POSTED' | 'WAIVED' | 'REVERSED'>;
  waiver_reason: string | null;
  waived_by_user_id: string | null;
  waived_at: Date | string | null;
  created_at: Generated<Date>;
}

export interface CustomerCreditCollectionsTable {
  id: string;
  tenant_id: string;
  account_id: string;
  customer_id: string;
  follow_up_date: string | Date;
  collector_user_id: string;
  contact_method: 'PHONE' | 'VISIT' | 'EMAIL' | 'MESSAGE' | 'OTHER';
  contact_person: string | null;
  notes: string;
  promise_to_pay_date: string | Date | null;
  promise_amount: string | number | null;
  outcome: 'PROMISED_TO_PAY' | 'DISPUTED' | 'UNREACHABLE' | 'REFUSED' | 'FOLLOW_UP_REQUIRED' | 'PAID' | 'OTHER';
  next_follow_up_date: string | Date | null;
  created_at: Generated<Date>;
}

export interface CustomerCreditWriteoffsTable {
  id: string;
  tenant_id: string;
  account_id: string;
  customer_id: string;
  transaction_id: string;
  original_outstanding: string | number;
  writeoff_amount: string | number;
  remaining_balance: string | number;
  reason: string;
  supporting_notes: string | null;
  approved_by_user_id: string;
  created_at: Generated<Date>;
}

export interface CustomerCreditNotesTable {
  id: string;
  tenant_id: string;
  account_id: string;
  customer_id: string;
  transaction_id: string;
  note_number: string;
  note_type: 'CREDIT_NOTE' | 'DEBIT_NOTE' | 'ADJUSTMENT';
  amount: string | number;
  reason: string;
  reference_invoice_id: string | null;
  approved_by_user_id: string | null;
  created_by_user_id: string;
  created_at: Generated<Date>;
}

export interface TenantInvitationsTable {
  id: string;
  tenant_id: string;
  email: string;
  role_code: string;
  employee_id: string | null;
  token_hash: string;
  code_encrypted: string | null;
  failed_attempts: Generated<number>;
  locked_until: ColumnType<Date | null, Date | string | null, Date | string | null>;
  status: 'PENDING' | 'ACCEPTED' | 'EXPIRED' | 'CANCELLED' | 'FAILED';
  invited_by_user_id: string;
  accepted_by_user_id: string | null;
  expires_at: ColumnType<Date, Date | string, Date | string>;
  accepted_at: ColumnType<Date | null, Date | string | null, Date | string | null>;
  cancelled_at: ColumnType<Date | null, Date | string | null, Date | string | null>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
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
  pos_cash_adjustments: PosCashAdjustmentsTable;
  sales_invoices: SalesInvoicesTable;
  sales_invoice_lines: SalesInvoiceLinesTable;
  sales_payments: SalesPaymentsTable;
  inventory_batches: InventoryBatchesTable;
  inventory_serials: InventorySerialsTable;
  inventory_serial_transitions: InventorySerialTransitionsTable;
  inventory_cost_layers: InventoryCostLayersTable;
  stocktake_sessions: StocktakeSessionsTable;
  stocktake_lines: StocktakeLinesTable;
  tenant_barcode_settings: TenantBarcodeSettingsTable;
  product_media_assets: ProductMediaAssetsTable;
  employees: EmployeesTable;
  employee_branch_assignments: EmployeeBranchAssignmentsTable;
  employee_warehouse_assignments: EmployeeWarehouseAssignmentsTable;
  employee_documents: EmployeeDocumentsTable;
  employee_salary_structures: EmployeeSalaryStructuresTable;
  employee_salary_components: EmployeeSalaryComponentsTable;
  payroll_runs: PayrollRunsTable;
  payroll_items: PayrollItemsTable;
  payroll_payments: PayrollPaymentsTable;
  employee_work_schedules: EmployeeWorkSchedulesTable;
  employee_attendance: EmployeeAttendanceTable;
  employee_leave_requests: EmployeeLeaveRequestsTable;
  employee_leave_balances: EmployeeLeaveBalancesTable;
  org_holidays: OrgHolidaysTable;
  org_payroll_settings: OrgPayrollSettingsTable;
  expense_categories: ExpenseCategoriesTable;
  expenses: ExpensesTable;
  expense_attachments: ExpenseAttachmentsTable;
  customers: CustomersTable;
  customer_credit_settings: CustomerCreditSettingsTable;
  customer_credit_accounts: CustomerCreditAccountsTable;
  customer_credit_limit_history: CustomerCreditLimitHistoryTable;
  customer_credit_transactions: CustomerCreditTransactionsTable;
  customer_credit_payments: CustomerCreditPaymentsTable;
  customer_credit_allocations: CustomerCreditAllocationsTable;
  customer_credit_approvals: CustomerCreditApprovalsTable;
  customer_credit_interest_entries: CustomerCreditInterestEntriesTable;
  customer_credit_late_fee_entries: CustomerCreditLateFeeEntriesTable;
  customer_credit_collections: CustomerCreditCollectionsTable;
  customer_credit_writeoffs: CustomerCreditWriteoffsTable;
  customer_credit_notes: CustomerCreditNotesTable;
  tenant_invitations: TenantInvitationsTable;
}

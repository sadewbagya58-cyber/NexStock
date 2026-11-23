import { type Static, type TSchema, Type } from '@sinclair/typebox';

/**
 * Canonical TypeBox Wire Schemas (NEX-DOC-07 & UD-01).
 * Used by Fastify for runtime validation + OpenAPI 3.1 generation,
 * and shared with Web/Desktop TypeScript clients.
 */

export const UuidSchema = Type.String({
  pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
  description: 'Canonical UUID string (UUIDv7 recommended for chronological sorting)',
});

export const CurrencyCodeSchema = Type.String({
  pattern: '^[A-Z]{3}$',
  description: 'ISO 4217 3-letter currency code (e.g., USD, LKR, EUR, JPY, KWD)',
});
export type CurrencyCode = Static<typeof CurrencyCodeSchema>;

/**
 * Fixed-point monetary string matching PostgreSQL NUMERIC(19, 4).
 * Numbers/floats are strictly rejected at the wire level to prevent IEEE 754 precision loss.
 */
export const DecimalMoneyStringSchema = Type.String({
  pattern: '^-?\\d+(\\.\\d{1,4})?$',
  description: 'Fixed-point monetary string with up to 4 decimal places (e.g., "124.5000")',
});

/**
 * Fixed-point quantity string matching PostgreSQL NUMERIC(18, 6).
 */
export const DecimalQuantityStringSchema = Type.String({
  pattern: '^-?\\d+(\\.\\d{1,6})?$',
  description: 'Fixed-point quantity string with up to 6 decimal places (e.g., "2.500000")',
});

export const DecimalPctStringSchema = Type.String({
  pattern: '^-?\\d+(?:\\.\\d{1,4})?$',
  description: 'Fixed-point percentage string (e.g. "25.00")',
});

export const IsoTimestampSchema = Type.String({
  pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,6})?(Z|[+-]\\d{2}:\\d{2})$',
  description: 'ISO-8601 UTC timestamp string',
});

export const ErrorCodeSchema = Type.Union([
  Type.Literal('ERR_VALIDATION_FAILED'),
  Type.Literal('ERR_UNAUTHORIZED'),
  Type.Literal('ERR_FORBIDDEN'),
  Type.Literal('ERR_TENANT_CONTEXT_MISSING'),
  Type.Literal('ERR_NOT_FOUND'),
  Type.Literal('ERR_CONFLICT'),
  Type.Literal('ERR_IDEMPOTENCY_KEY_MISSING'),
  Type.Literal('ERR_IDEMPOTENCY_KEY_REUSED_DIFFERENT_PAYLOAD'),
  Type.Literal('ERR_IDEMPOTENCY_IN_PROGRESS'),
  Type.Literal('IAM_UNAUTHENTICATED_TOKEN'),
  Type.Literal('IAM_TENANT_MEMBERSHIP_REQUIRED'),
  Type.Literal('IAM_PERMISSION_DENIED'),
  Type.Literal('IAM_LOCATION_SCOPE_DENIED'),
  Type.Literal('IAM_ROLE_NOT_FOUND'),
  Type.Literal('IAM_RESERVED_ROLE_CODE'),
  Type.Literal('IAM_DUPLICATE_ROLE_CODE'),
  Type.Literal('IAM_PRIVILEGE_ESCALATION_DENIED'),
  Type.Literal('IAM_SYSTEM_ROLE_PROTECTED'),
  Type.Literal('IAM_ROLE_IN_USE'),
  Type.Literal('IAM_MEMBERSHIP_NOT_FOUND'),
  Type.Literal('IAM_INVALID_ROLE_ID'),
  Type.Literal('IAM_CANNOT_REMOVE_LAST_OWNER'),
  Type.Literal('SUB_SUBSCRIPTION_INACTIVE'),
  Type.Literal('SUB_TRIAL_EXPIRED'),
  Type.Literal('SUB_QUOTA_EXCEEDED'),
  Type.Literal('SUB_FEATURE_NOT_ENTITLED'),
  Type.Literal('SUB_INVALID_LIFECYCLE_TRANSITION'),
  Type.Literal('SUB_TRIAL_ALREADY_USED'),
  Type.Literal('SUB_PAYMENT_ALREADY_VERIFIED'),
  Type.Literal('SUB_PAYMENT_AMOUNT_MISMATCH'),
  Type.Literal('SUB_WEBHOOK_SIGNATURE_INVALID'),
  Type.Literal('SUB_PLATFORM_ADMIN_REQUIRED'),
  Type.Literal('SUB_READ_ONLY_MODE'),
  Type.Literal('SUB_PLATFORM_MFA_REQUIRED'),
  Type.Literal('CAT_DUPLICATE_CATEGORY_NAME'),
  Type.Literal('CAT_CIRCULAR_CATEGORY_HIERARCHY'),
  Type.Literal('CAT_CATEGORY_HAS_ACTIVE_CHILDREN_OR_PRODUCTS'),
  Type.Literal('CAT_DUPLICATE_SKU'),
  Type.Literal('CAT_DUPLICATE_BARCODE'),
  Type.Literal('CAT_INVALID_UOM_CONVERSION'),
  Type.Literal('CAT_INVALID_TRACKING_MODE_TRANSITION'),
  Type.Literal('CAT_UNSUPPORTED_SYMBOLOGY'),
  Type.Literal('CAT_BARCODE_COLLISION_EXHAUSTED'),
  Type.Literal('CAT_SETTINGS_NOT_AVAILABLE'),
  Type.Literal('CAT_INVALID_IMAGE_TYPE'),
  Type.Literal('CAT_IMAGE_TOO_LARGE'),
  Type.Literal('CAT_CANNOT_DEACTIVATE_ONLY_ACTIVE_BARCODE'),
  Type.Literal('CAT_INACTIVE_BARCODE_CANNOT_BE_PRIMARY'),
  Type.Literal('PUR_DUPLICATE_SUPPLIER_CODE'),
  Type.Literal('PUR_DUPLICATE_SUPPLIER_TAX_ID'),
  Type.Literal('PUR_DUPLICATE_SUPPLIER_PRODUCT'),
  Type.Literal('INV_PRODUCT_NOT_TRACKABLE'),
  Type.Literal('INV_PRODUCT_ARCHIVED'),
  Type.Literal('INV_INVALID_MOVEMENT_QUANTITY'),
  Type.Literal('INV_INSUFFICIENT_AVAILABLE_STOCK'),
  Type.Literal('INV_MOVEMENT_ALREADY_REVERSED'),
  Type.Literal('INV_BALANCE_RECONCILIATION_MISMATCH'),
  Type.Literal('POS_SHIFT_NOT_OPEN'),
  Type.Literal('POS_REGISTER_NOT_FOUND'),
  Type.Literal('POS_REGISTER_INACTIVE'),
  Type.Literal('POS_SHIFT_ALREADY_OPEN'),
  Type.Literal('POS_CASHIER_SHIFT_ALREADY_OPEN'),
  Type.Literal('POS_SHIFT_CLOSE_UNAUTHORIZED'),
  Type.Literal('POS_NO_ACTIVE_SHIFT'),
  Type.Literal('POS_SHIFT_NOT_FOUND'),
  Type.Literal('POS_SHIFT_ALREADY_CLOSED'),
  Type.Literal('POS_REGISTER_CODE_EXISTS'),
  Type.Literal('SUB_PLAN_LIMIT_REACHED'),
  Type.Literal('ORG_BRANCH_NOT_FOUND'),
  Type.Literal('POS_CART_EMPTY'),
  Type.Literal('POS_INSUFFICIENT_PAYMENT'),
  Type.Literal('POS_SALE_NOT_FOUND'),
  Type.Literal('POS_SALE_ALREADY_VOIDED'),
  Type.Literal('POS_UNAUTHORIZED_DISCOUNT'),
  Type.Literal('INV_BATCH_NOT_FOUND'),
  Type.Literal('INV_BATCH_ALREADY_EXISTS'),
  Type.Literal('INV_BATCH_DUPLICATE_NUMBER'),
  Type.Literal('INV_BATCH_EXPIRED'),
  Type.Literal('INV_BATCH_QUARANTINED'),
  Type.Literal('INV_INSUFFICIENT_BATCH_STOCK'),
  Type.Literal('INV_PRODUCT_NOT_BATCH_TRACKED'),
  Type.Literal('INV_SERIAL_NOT_FOUND'),
  Type.Literal('INV_SERIAL_ALREADY_EXISTS'),
  Type.Literal('INV_SERIAL_DUPLICATE'),
  Type.Literal('INV_SERIAL_GROUP_DUPLICATE'),
  Type.Literal('INV_SERIAL_NOT_AVAILABLE'),
  Type.Literal('INV_SERIAL_ALREADY_SOLD'),
  Type.Literal('INV_SERIAL_MISMATCH'),
  Type.Literal('INV_SERIAL_INVALID_TRANSITION'),
  Type.Literal('INV_SERIAL_QUANTITY_MUST_BE_ONE'),
  Type.Literal('INV_SERIAL_WRONG_WAREHOUSE'),
  Type.Literal('POS_BATCH_SELECTION_REQUIRED'),
  Type.Literal('POS_SERIAL_SELECTION_REQUIRED'),
  Type.Literal('POS_SERIAL_PRODUCT_MISMATCH'),
  Type.Literal('POS_DUPLICATE_SERIAL_IN_CART'),
  Type.Literal('INV_PRODUCT_NOT_SERIAL_TRACKED'),
  Type.Literal('INV_TRACKING_MODE_MISMATCH'),
  Type.Literal('INV_STOCKTAKE_NOT_FOUND'),
  Type.Literal('INV_STOCKTAKE_NOT_IN_PROGRESS'),
  Type.Literal('INV_STOCKTAKE_ALREADY_SUBMITTED'),
  Type.Literal('INV_STOCKTAKE_ALREADY_POSTED'),
  Type.Literal('INV_STOCKTAKE_NOT_APPROVED'),
  Type.Literal('INV_STOCKTAKE_NOT_EDITABLE'),
  Type.Literal('INV_STOCKTAKE_NOT_SUBMITTED'),
  Type.Literal('INV_STOCKTAKE_NO_ELIGIBLE_PRODUCTS'),
  Type.Literal('INV_STOCKTAKE_SELF_APPROVAL_FORBIDDEN'),
  Type.Literal('INV_STOCKTAKE_REJECTED'),
  Type.Literal('SYNC_COMMAND_QUARANTINED'),
  Type.Literal('AUTH_INVALID_CREDENTIALS'),
  Type.Literal('AUTH_EMAIL_ALREADY_EXISTS'),
  Type.Literal('AUTH_USER_NOT_FOUND'),
  Type.Literal('AUTH_WEAK_PASSWORD'),
  Type.Literal('AUTH_RATE_LIMITED'),
  Type.Literal('ORG_DUPLICATE_SLUG'),
  Type.Literal('ORG_DUPLICATE_BRANCH_CODE'),
  Type.Literal('ORG_TENANT_NOT_FOUND'),
  Type.Literal('HRM_EMPLOYEE_NOT_FOUND'),
  Type.Literal('HRM_DUPLICATE_EMPLOYEE_CODE'),
  Type.Literal('HRM_USER_ALREADY_LINKED'),
  Type.Literal('HRM_DOCUMENT_NOT_FOUND'),
  Type.Literal('HRM_INVALID_DOCUMENT_TYPE'),
  Type.Literal('HRM_DOCUMENT_TOO_LARGE'),
  Type.Literal('HRM_SALARY_STRUCTURE_NOT_FOUND'),
  Type.Literal('HRM_PAYROLL_RUN_NOT_FOUND'),
  Type.Literal('HRM_PAYROLL_RUN_ALREADY_EXISTS'),
  Type.Literal('HRM_PAYROLL_RUN_IMMUTABLE'),
  Type.Literal('HRM_PAYROLL_ITEM_NOT_FOUND'),
  Type.Literal('HRM_INVALID_PAYROLL_STATUS_TRANSITION'),
  Type.Literal('HRM_OVERPAYMENT_NOT_ALLOWED'),
  Type.Literal('HRM_STAFF_ACCOUNT_NOT_LINKED'),
  Type.Literal('HRM_GPS_REQUIRED'),
  Type.Literal('HRM_GEOFENCE_FAILED'),
  Type.Literal('HRM_ALREADY_CHECKED_IN'),
  Type.Literal('HRM_CHECK_IN_REQUIRED'),
  Type.Literal('HRM_ALREADY_CHECKED_OUT'),
  Type.Literal('HRM_REASON_REQUIRED'),
  Type.Literal('HRM_LEAVE_OVERLAP'),
  Type.Literal('HRM_LEAVE_NOT_FOUND'),
  Type.Literal('HRM_LEAVE_ALREADY_REVIEWED'),
  Type.Literal('HRM_CANNOT_APPROVE_OWN_LEAVE'),
  Type.Literal('HRM_UNAUTHORIZED_EMPLOYEE_ACCESS'),
  Type.Literal('HRM_HOLIDAY_EXISTS'),
  Type.Literal('HRM_HOLIDAY_NOT_FOUND'),
  Type.Literal('EXP_CATEGORY_NOT_FOUND'),
  Type.Literal('EXP_DUPLICATE_CATEGORY_CODE'),
  Type.Literal('EXP_CATEGORY_IN_USE'),
  Type.Literal('EXP_EXPENSE_NOT_FOUND'),
  Type.Literal('EXP_INVALID_STATUS_TRANSITION'),
  Type.Literal('EXP_NOT_EDITABLE'),
  Type.Literal('EXP_NOT_DELETABLE'),
  Type.Literal('EXP_REJECTION_REASON_REQUIRED'),
  Type.Literal('EXP_CANNOT_APPROVE_OWN_EXPENSE'),
  Type.Literal('EXP_ALREADY_PAID'),
  Type.Literal('EXP_ATTACHMENT_NOT_FOUND'),
  Type.Literal('EXP_ATTACHMENT_TOO_LARGE'),
  Type.Literal('EXP_INVALID_ATTACHMENT_TYPE'),
  Type.Literal('CUST_NOT_FOUND'),
  Type.Literal('CUST_DUPLICATE_NUMBER'),
  Type.Literal('CREDIT_ACCOUNT_NOT_FOUND'),
  Type.Literal('CREDIT_ACCOUNT_ALREADY_EXISTS'),
  Type.Literal('CREDIT_ACCOUNT_NOT_ACTIVE'),
  Type.Literal('CREDIT_LIMIT_EXCEEDED'),
  Type.Literal('CREDIT_CANNOT_CLOSE_WITH_BALANCE'),
  Type.Literal('CREDIT_TRANSACTION_NOT_FOUND'),
  Type.Literal('CREDIT_PAYMENT_NOT_FOUND'),
  Type.Literal('CREDIT_PAYMENT_ALREADY_REVERSED'),
  Type.Literal('CREDIT_ALLOCATION_EXCEEDS_PAYMENT'),
  Type.Literal('CREDIT_ALLOCATION_EXCEEDS_DUE'),
  Type.Literal('CREDIT_APPROVAL_REQUIRED'),
  Type.Literal('CREDIT_WRITEOFF_EXCEEDS_BALANCE'),
  Type.Literal('CREDIT_INTEREST_DISABLED'),
  Type.Literal('CREDIT_LATE_FEE_DISABLED'),
  Type.Literal('CREDIT_INVALID_STATUS_TRANSITION'),
  Type.Literal('CREDIT_CUSTOMER_REQUIRED_FOR_CREDIT_SALE'),
  Type.Literal('CREDIT_LIMIT_APPROVAL_REQUIRED'),
  Type.Literal('CREDIT_CASHIER_LIMIT_EXCEEDED'),
  Type.Literal('HRM_EMPLOYEE_ALREADY_LINKED'),
  Type.Literal('HRM_USER_NOT_TENANT_MEMBER'),
  Type.Literal('HRM_INVALID_STAFF_LINK'),
  Type.Literal('IAM_INVALID_INVITATION_ROLE'),
  Type.Literal('IAM_CANNOT_INVITE_OWNER'),
  Type.Literal('IAM_INVITATION_CODE_INVALID'),
  Type.Literal('IAM_INVITATION_EMAIL_MISMATCH'),
  Type.Literal('IAM_INVITATION_LOCKED'),
  Type.Literal('IAM_INVITATION_TOO_MANY_ATTEMPTS'),
  Type.Literal('IAM_USER_ALREADY_MEMBER'),
  Type.Literal('IAM_INVITATION_ALREADY_EXISTS'),
  Type.Literal('IAM_INVITATION_NOT_FOUND'),
  Type.Literal('IAM_INVITATION_ALREADY_ACCEPTED'),
  Type.Literal('IAM_INVITATION_INACTIVE'),
  Type.Literal('IAM_INVITATION_EXPIRED'),
  Type.Literal('IAM_CANNOT_DISABLE_OWNER'),
  Type.Literal('IAM_CANNOT_REVOKE_OWNER'),
  Type.Literal('IAM_MEMBERSHIP_DEACTIVATED'),
  Type.Literal('IAM_MEMBERSHIP_SUSPENDED'),
  Type.Literal('IAM_MEMBERSHIP_REVOKED'),
  Type.Literal('IAM_INVALID_MEMBERSHIP_TRANSITION'),
  Type.Literal('IAM_SUSPENSION_REASON_REQUIRED'),
  Type.Literal('IAM_INVALID_MEMBERSHIP_STATUS'),
  Type.Literal('INV_BRANCH_WAREHOUSE_MISMATCH'),
  Type.Literal('INV_BATCH_REQUIRED'),
  Type.Literal('INV_BATCH_EXPIRY_REQUIRED'),
  Type.Literal('PUR_PRODUCT_NOT_ELIGIBLE'),
  Type.Literal('PUR_INVALID_STATUS_TRANSITION'),
  Type.Literal('PUR_GRN_PO_MISMATCH'),
  Type.Literal('PUR_ORDER_NOT_RECEIVABLE'),
  Type.Literal('POS_RETURN_EXCEEDS_SOLD_QTY'),
  Type.Literal('PRICING_INVALID_MARGIN_RATE'),
  Type.Literal('PRICING_INVALID_MARKUP_RATE'),
  Type.Literal('PRICING_SUGGESTION_NOT_FOUND'),
  Type.Literal('PRICING_INVALID_SUGGESTION_STATUS'),
  Type.Literal('PRICING_SELF_APPROVAL_FORBIDDEN'),
  Type.Literal('PRICING_APPROVAL_POLICY_FORBIDDEN'),
  Type.Literal('PRICING_MIN_PRICE_VIOLATION'),
  Type.Literal('PRICING_MAX_DISCOUNT_EXCEEDED'),
  Type.Literal('PRICING_OFFLINE_APPROVAL_FORBIDDEN'),
  Type.Literal('POS_BATCH_PRICE_REQUIRED'),
  Type.Literal('POS_BATCH_NOT_AVAILABLE'),
  Type.Literal('POS_BATCH_EXPIRED'),
  Type.Literal('POS_EXPIRED_BATCH_RESTOCK_BLOCKED'),
  Type.Literal('POS_BATCH_MIN_PRICE_VIOLATION'),
  Type.Literal('PUR_BATCH_LOT_CONFLICT'),
  Type.Literal('CAT_UOM_CHANGE_REQUIRES_WIZARD'),
  Type.Literal('CAT_BARCODE_COLLISION'),
  Type.Literal('INV_TRANSFER_NOT_FOUND'),
  Type.Literal('INV_TRANSFER_INVALID_STATUS'),
  Type.Literal('INV_TRANSFER_BRANCH_CONFLICT'),
  Type.Literal('ERR_INTERNAL_SERVER_ERROR'),
  Type.Literal('SYNC_DEVICE_REVOKED'),
  Type.Literal('POS_INTAKE_LOT_NOT_FOUND'),
  Type.Literal('POS_INTAKE_LOT_INACTIVE'),
  Type.Literal('POS_INTAKE_LOT_EXHAUSTED'),
  Type.Literal('CAT_BARCODE_IN_USE_DEACTIVATE_ONLY'),
  Type.Literal('CAT_BARCODE_INACTIVE'),
  Type.Literal('INV_CONFIG_ALERT_NOT_FOUND'),
]);
export type ErrorCode = Static<typeof ErrorCodeSchema>;

/**
 * RFC 9457 Problem Details error response contract (NEX-DOC-07 Section 6).
 */
export const ProblemDetailsSchema = Type.Object({
  type: Type.String(),
  title: Type.String(),
  status: Type.Integer({ minimum: 400, maximum: 599 }),
  detail: Type.String(),
  instance: Type.Optional(Type.String()),
  errorCode: ErrorCodeSchema,
  traceId: Type.String(),
  extensions: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});
export type ProblemDetails = Static<typeof ProblemDetailsSchema>;

export const TenantContextHeadersSchema = Type.Object({
  'x-tenant-id': UuidSchema,
  'x-user-id': Type.Optional(UuidSchema),
  'x-device-id': Type.Optional(UuidSchema),
});
export type TenantContextHeaders = Static<typeof TenantContextHeadersSchema>;

export const IdempotentMutationHeadersSchema = Type.Object({
  'x-tenant-id': UuidSchema,
  'idempotency-key': UuidSchema,
  'x-user-id': Type.Optional(UuidSchema),
  'x-device-id': Type.Optional(UuidSchema),
});
export type IdempotentMutationHeaders = Static<
  typeof IdempotentMutationHeadersSchema
>;

export function createCursorPageResponseSchema<T extends TSchema>(
  itemSchema: T,
) {
  return Type.Object({
    data: Type.Array(itemSchema),
    pageInfo: Type.Object({
      hasNextPage: Type.Boolean(),
      nextCursor: Type.Union([Type.String(), Type.Null()]),
    }),
  });
}

/**
 * Offline Synchronization Command Envelope Contract (NEX-DOC-08).
 */
export const SyncCommandTypeSchema = Type.Union([
  Type.Literal('POS_OPEN_SHIFT'),
  Type.Literal('POS_RECORD_SALE'),
  Type.Literal('POS_RECORD_RETURN'),
  Type.Literal('POS_CLOSE_SHIFT'),
  Type.Literal('INV_SUBMIT_STOCKTAKE_COUNT'),
  Type.Literal('INV_RECEIVE_TRANSFER'),
  Type.Literal('INV_RECORD_ADJUSTMENT'),
  Type.Literal('INV_RECORD_MOVEMENT'),
  Type.Literal('INV_REQUEST_TRANSFER'),
  Type.Literal('INV_SERIAL_OPERATION'),
]);
export type SyncCommandType = Static<typeof SyncCommandTypeSchema>;

export const SyncCommandEnvelopeSchema = Type.Object({
  localSeq: Type.Integer({ minimum: 1 }),
  commandId: UuidSchema,
  tenantId: UuidSchema,
  branchId: UuidSchema,
  deviceId: UuidSchema,
  actorUserId: UuidSchema,
  commandType: SyncCommandTypeSchema,
  schemaVersion: Type.Integer({ minimum: 1 }),
  occurredAt: IsoTimestampSchema,
  payload: Type.Record(Type.String(), Type.Unknown()),
});
export type SyncCommandEnvelope = Static<typeof SyncCommandEnvelopeSchema>;

export const SyncCommandAckStatusSchema = Type.Union([
  Type.Literal('APPLIED'),
  Type.Literal('APPLIED_WITH_CONFLICT_FLAG'),
  Type.Literal('DUPLICATE_IGNORED'),
  Type.Literal('QUARANTINED'),
]);
export type SyncCommandAckStatus = Static<typeof SyncCommandAckStatusSchema>;

export const SyncPushBatchRequestSchema = Type.Object({
  deviceId: UuidSchema,
  branchId: UuidSchema,
  commands: Type.Array(SyncCommandEnvelopeSchema, {
    minItems: 1,
    maxItems: 50,
  }),
});
export type SyncPushBatchRequest = Static<typeof SyncPushBatchRequestSchema>;

export const SyncPushBatchResponseSchema = Type.Object({
  receipts: Type.Array(
    Type.Object({
      commandId: UuidSchema,
      localSeq: Type.Integer({ minimum: 1 }),
      status: SyncCommandAckStatusSchema,
      conflictId: Type.Optional(UuidSchema),
      conflictCode: Type.Optional(Type.String()),
      errorMessage: Type.Optional(Type.String()),
      serverReferenceId: Type.Optional(Type.String()),
      serverReferenceNumber: Type.Optional(Type.String()),
      serverDetails: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
      serverProcessedAt: IsoTimestampSchema,
    }),
  ),
});
export type SyncPushBatchResponse = Static<typeof SyncPushBatchResponseSchema>;

export const HealthStatusResponseSchema = Type.Object({
  status: Type.Union([Type.Literal('ok'), Type.Literal('degraded')]),
  service: Type.Literal('nexstock-api'),
  version: Type.String(),
  timestamp: IsoTimestampSchema,
});
export type HealthStatusResponse = Static<typeof HealthStatusResponseSchema>;

/**
 * ============================================================================
 * Milestone 1 Contracts: IAM, ORG, SUB, and I18N (NEX-DOC-06 & NEX-DOC-07)
 * ============================================================================
 */

export const AuthenticatedTenantHeadersSchema = Type.Object({
  authorization: Type.Optional(Type.String()),
  'x-tenant-id': UuidSchema,
});
export type AuthenticatedTenantHeaders = Static<
  typeof AuthenticatedTenantHeadersSchema
>;

export const AuthenticatedIdempotentHeadersSchema = Type.Object({
  authorization: Type.Optional(Type.String()),
  'x-tenant-id': UuidSchema,
  'idempotency-key': UuidSchema,
});
export type AuthenticatedIdempotentHeaders = Static<
  typeof AuthenticatedIdempotentHeadersSchema
>;

export const ExchangeRateStringSchema = Type.String({
  pattern: '^\\d+(\\.\\d{1,8})?$',
  description: 'Fixed-point exchange rate string with up to 8 decimal places',
});

export const TaxPercentageStringSchema = Type.String({
  pattern: '^\\d+(\\.\\d{1,4})?$',
  description: 'Fixed-point tax percentage string with up to 4 decimal places',
});

export const SubscriptionStatusSchema = Type.Union([
  Type.Literal('TRIALING'),
  Type.Literal('ACTIVE'),
  Type.Literal('PENDING_PAYMENT'),
  Type.Literal('PAYMENT_VERIFICATION_REQUIRED'),
  Type.Literal('RENEWAL_DUE'),
  Type.Literal('GRACE_PERIOD'),
  Type.Literal('EXPIRED'),
  Type.Literal('READ_ONLY'),
  Type.Literal('PAST_DUE'),
  Type.Literal('SUSPENDED'),
  Type.Literal('CANCELLED'),
]);
export type SubscriptionStatus = Static<typeof SubscriptionStatusSchema>;

export const CreateBranchRequestSchema = Type.Object(
  {
    code: Type.String({ minLength: 2, maxLength: 32 }),
    name: Type.String({ minLength: 2, maxLength: 120 }),
    timezone: Type.Optional(Type.String({ minLength: 2, maxLength: 64 })),
    countryCode: Type.Optional(Type.String({ pattern: '^[A-Z]{2}$' })),
    phone: Type.Optional(Type.Union([Type.String({ maxLength: 40 }), Type.Null()])),
    email: Type.Optional(Type.Union([Type.String({ maxLength: 160 }), Type.Null()])),
    address: Type.Optional(Type.Union([Type.String({ maxLength: 320 }), Type.Null()])),
    city: Type.Optional(Type.Union([Type.String({ maxLength: 120 }), Type.Null()])),
    managerName: Type.Optional(Type.Union([Type.String({ maxLength: 120 }), Type.Null()])),
    managerUserId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
    isMainBranch: Type.Optional(Type.Boolean()),
    isHeadquarters: Type.Optional(Type.Boolean()),
    defaultWarehouseCode: Type.Optional(Type.String({ minLength: 2, maxLength: 32 })),
    defaultWarehouseName: Type.Optional(Type.String({ minLength: 2, maxLength: 120 })),
  },
  { additionalProperties: false },
);
export type CreateBranchRequest = Static<typeof CreateBranchRequestSchema>;

export const UpdateBranchRequestSchema = Type.Object(
  {
    code: Type.Optional(Type.String({ minLength: 2, maxLength: 32 })),
    name: Type.Optional(Type.String({ minLength: 2, maxLength: 160 })),
    timezone: Type.Optional(Type.String({ minLength: 2, maxLength: 64 })),
    countryCode: Type.Optional(Type.String({ pattern: '^[A-Z]{2}$' })),
    phone: Type.Optional(Type.Union([Type.String({ maxLength: 40 }), Type.Null()])),
    email: Type.Optional(Type.Union([Type.String({ maxLength: 160 }), Type.Null()])),
    address: Type.Optional(Type.Union([Type.String({ maxLength: 320 }), Type.Null()])),
    city: Type.Optional(Type.Union([Type.String({ maxLength: 120 }), Type.Null()])),
    managerName: Type.Optional(Type.Union([Type.String({ maxLength: 120 }), Type.Null()])),
    managerUserId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
    isMainBranch: Type.Optional(Type.Boolean()),
    isHeadquarters: Type.Optional(Type.Boolean()),
    isActive: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type UpdateBranchRequest = Static<typeof UpdateBranchRequestSchema>;

export const BranchResponseSchema = Type.Object({
  id: UuidSchema,
  tenantId: UuidSchema,
  code: Type.String(),
  name: Type.String(),
  timezone: Type.String(),
  countryCode: Type.String(),
  defaultWarehouseId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
  defaultWarehouseCode: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  defaultWarehouseName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  phone: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  email: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  address: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  city: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  managerName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  managerUserId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
  isMainBranch: Type.Optional(Type.Boolean()),
  isHeadquarters: Type.Optional(Type.Boolean()),
  status: Type.Optional(
    Type.Union([Type.Literal('ACTIVE'), Type.Literal('ARCHIVED')]),
  ),
  isActive: Type.Boolean(),
  archivedAt: Type.Optional(Type.Union([IsoTimestampSchema, Type.Null()])),
  createdAt: Type.Optional(IsoTimestampSchema),
  updatedAt: Type.Optional(IsoTimestampSchema),
});
export type BranchResponse = Static<typeof BranchResponseSchema>;

export const CreateWarehouseRequestSchema = Type.Object(
  {
    branchId: UuidSchema,
    code: Type.String({ minLength: 2, maxLength: 32 }),
    name: Type.String({ minLength: 2, maxLength: 120 }),
    allowNegativeStock: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type CreateWarehouseRequest = Static<
  typeof CreateWarehouseRequestSchema
>;

export const WarehouseResponseSchema = Type.Object({
  id: UuidSchema,
  tenantId: UuidSchema,
  branchId: Type.Union([UuidSchema, Type.Null()]),
  code: Type.String(),
  name: Type.String(),
  allowNegativeStock: Type.Boolean(),
  isActive: Type.Boolean(),
});
export type WarehouseResponse = Static<typeof WarehouseResponseSchema>;

export const UpdateWarehouseRequestSchema = Type.Object(
  {
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
    isActive: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type UpdateWarehouseRequest = Static<typeof UpdateWarehouseRequestSchema>;

export const RecordSubscriptionPaymentRequestSchema = Type.Object(
  {
    currencyCode: CurrencyCodeSchema,
    amount: DecimalMoneyStringSchema,
    paymentMethod: Type.Union([
      Type.Literal('BANK_TRANSFER'),
      Type.Literal('MANUAL_RECEIPT'),
      Type.Literal('CHEQUE'),
      Type.Literal('EXTERNAL_GATEWAY_REF'),
    ]),
    referenceNumber: Type.String({ minLength: 1, maxLength: 120 }),
  },
  { additionalProperties: false },
);
export type RecordSubscriptionPaymentRequest = Static<
  typeof RecordSubscriptionPaymentRequestSchema
>;

export const UpsertLocalizationSettingsRequestSchema = Type.Object(
  {
    locale: Type.String({ minLength: 2, maxLength: 20 }),
    timezone: Type.String({ minLength: 2, maxLength: 64 }),
    dateFormat: Type.String({ minLength: 4, maxLength: 32 }),
    numberFormat: Type.String({ minLength: 2, maxLength: 32 }),
    currencyDisplayMode: Type.Union([
      Type.Literal('SYMBOL'),
      Type.Literal('ISO_CODE'),
      Type.Literal('SYMBOL_AND_CODE'),
    ]),
  },
  { additionalProperties: false },
);
export type UpsertLocalizationSettingsRequest = Static<
  typeof UpsertLocalizationSettingsRequestSchema
>;

export const CreateExchangeRateRequestSchema = Type.Object(
  {
    sourceCurrency: CurrencyCodeSchema,
    targetCurrency: CurrencyCodeSchema,
    rate: ExchangeRateStringSchema,
    effectiveFrom: IsoTimestampSchema,
  },
  { additionalProperties: false },
);
export type CreateExchangeRateRequest = Static<
  typeof CreateExchangeRateRequestSchema
>;

/**
 * ============================================================================
 * Phase 2 Contracts: CAT (Categories & Products), PUR (Suppliers), INV (Movements & Balances)
 * ============================================================================
 */

export const RecordLifecycleStatusSchema = Type.Union([
  Type.Literal('ACTIVE'),
  Type.Literal('ARCHIVED'),
]);
export type RecordLifecycleStatus = Static<typeof RecordLifecycleStatusSchema>;

export const PaginationLimitQueryParamSchema = Type.Union([
  Type.Integer({ minimum: 1, maximum: 250 }),
  Type.String({ pattern: '^(?:[1-9]\\d?|1\\d{2}|2[0-4]\\d|250)$' }),
]);
export type PaginationLimitQueryParam = Static<
  typeof PaginationLimitQueryParamSchema
>;

// 1. Category Contracts (/v1/categories)
export const CreateCategoryRequestSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 120 }),
    description: Type.Optional(
      Type.Union([Type.String({ maxLength: 500 }), Type.Null()]),
    ),
    parentId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
    color: Type.Optional(Type.Union([Type.String({ maxLength: 30 }), Type.Null()])),
  },
  { additionalProperties: false },
);
export type CreateCategoryRequest = Static<typeof CreateCategoryRequestSchema>;

export const UpdateCategoryRequestSchema = Type.Object(
  {
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
    description: Type.Optional(
      Type.Union([Type.String({ maxLength: 500 }), Type.Null()]),
    ),
    parentId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
    color: Type.Optional(Type.Union([Type.String({ maxLength: 30 }), Type.Null()])),
  },
  { additionalProperties: false },
);
export type UpdateCategoryRequest = Static<typeof UpdateCategoryRequestSchema>;

export const ListCategoriesQuerySchema = Type.Object(
  {
    search: Type.Optional(Type.String({ maxLength: 120 })),
    status: Type.Optional(RecordLifecycleStatusSchema),
    parentId: Type.Optional(UuidSchema),
    limit: Type.Optional(PaginationLimitQueryParamSchema),
    cursor: Type.Optional(UuidSchema),
  },
  { additionalProperties: false },
);
export type ListCategoriesQuery = Static<typeof ListCategoriesQuerySchema>;

export const CategoryResponseSchema = Type.Object({
  id: UuidSchema,
  tenantId: UuidSchema,
  parentId: Type.Union([UuidSchema, Type.Null()]),
  name: Type.String(),
  description: Type.Union([Type.String(), Type.Null()]),
  status: RecordLifecycleStatusSchema,
  color: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  syncVersion: Type.Integer(),
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
  archivedAt: Type.Union([IsoTimestampSchema, Type.Null()]),
});
export type CategoryResponse = Static<typeof CategoryResponseSchema>;

// 2. Product Contracts (/v1/products)
export const ProductTypeSchema = Type.Union([
  Type.Literal('STANDARD'),
  Type.Literal('SERVICE'),
  Type.Literal('BUNDLE'),
]);
export type ProductType = Static<typeof ProductTypeSchema>;

export const TrackingModeSchema = Type.Union([
  Type.Literal('NONE'),
  Type.Literal('BATCH'),
  Type.Literal('BATCH_EXPIRY'),
  Type.Literal('SERIAL'),
]);
export type TrackingMode = Static<typeof TrackingModeSchema>;

export const ValuationMethodSchema = Type.Union([
  Type.Literal('MOVING_AVG'),
  Type.Literal('FIFO'),
]);
export type ValuationMethod = Static<typeof ValuationMethodSchema>;

export const BarcodeTypeSchema = Type.Union([
  Type.Literal('EAN13'),
  Type.Literal('EAN8'),
  Type.Literal('UPCA'),
  Type.Literal('UPCE'),
  Type.Literal('CODE128'),
  Type.Literal('CODE39'),
  Type.Literal('ITF'),
  Type.Literal('QR'),
  Type.Literal('CUSTOM'),
]);
export type BarcodeType = Static<typeof BarcodeTypeSchema>;

export const ProductBarcodeInputSchema = Type.Object(
  {
    barcode: Type.String({ minLength: 1, maxLength: 64 }),
    barcodeType: Type.Optional(BarcodeTypeSchema),
    uomCode: Type.Optional(Type.String({ minLength: 1, maxLength: 16 })),
    isPrimary: Type.Optional(Type.Boolean()),
    isActive: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type ProductBarcodeInput = Static<typeof ProductBarcodeInputSchema>;

export const ProductUnitConversionInputSchema = Type.Object(
  {
    uomCode: Type.String({ minLength: 1, maxLength: 16 }),
    uomName: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    conversionFactorToBase: DecimalQuantityStringSchema,
    isDefaultPurchasing: Type.Optional(Type.Boolean()),
    isDefaultSelling: Type.Optional(Type.Boolean()),
    sellingPrice: Type.Optional(Type.Union([DecimalMoneyStringSchema, Type.Null()])),
  },
  { additionalProperties: false },
);
export type ProductUnitConversionInput = Static<
  typeof ProductUnitConversionInputSchema
>;

export const ProductAllocationPolicySchema = Type.Union([
  Type.Literal('FEFO'),
  Type.Literal('FIFO'),
  Type.Literal('MANUAL'),
]);
export type ProductAllocationPolicy = Static<typeof ProductAllocationPolicySchema>;

export const ProductQtyModeSchema = Type.Union([
  Type.Literal('STANDARD'),
  Type.Literal('VARIABLE'),
]);
export type ProductQtyMode = Static<typeof ProductQtyModeSchema>;

export const MeasurementCategorySchema = Type.Union([
  Type.Literal('WEIGHT'),
  Type.Literal('VOLUME'),
  Type.Literal('COUNT'),
  Type.Literal('LENGTH'),
]);
export type MeasurementCategory = Static<typeof MeasurementCategorySchema>;

export const UnitOfMeasureResponseSchema = Type.Object({
  code: Type.String(),
  name: Type.String(),
  category: MeasurementCategorySchema,
  baseUnitCode: Type.String(),
  conversionToBase: DecimalQuantityStringSchema,
  decimalPrecision: Type.Integer(),
  isFractional: Type.Boolean(),
  isActive: Type.Boolean(),
});
export type UnitOfMeasureResponse = Static<
  typeof UnitOfMeasureResponseSchema
>;

export const LineEntrySourceSchema = Type.Union([
  Type.Literal('BARCODE_SCAN'),
  Type.Literal('MANUAL'),
  Type.Literal('MANUAL_WEIGHT'),
  Type.Literal('SCALE_WEIGHT'),
  Type.Literal('QUICK_PICK'),
  Type.Literal('API'),
]);
export type LineEntrySource = Static<typeof LineEntrySourceSchema>;

export const CreateProductRequestSchema = Type.Object(
  {
    sku: Type.String({ minLength: 1, maxLength: 64 }),
    name: Type.String({ minLength: 1, maxLength: 160 }),
    description: Type.Optional(
      Type.Union([Type.String({ maxLength: 1000 }), Type.Null()]),
    ),
    productType: Type.Optional(ProductTypeSchema),
    trackingMode: Type.Optional(TrackingModeSchema),
    valuationMethod: Type.Optional(ValuationMethodSchema),
    categoryId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
    baseUom: Type.String({ minLength: 1, maxLength: 16 }),
    productQtyMode: Type.Optional(ProductQtyModeSchema),
    measurementCategory: Type.Optional(
      Type.Union([MeasurementCategorySchema, Type.Null()]),
    ),
    purchaseUom: Type.Optional(
      Type.Union([Type.String({ minLength: 1, maxLength: 16 }), Type.Null()]),
    ),
    priceUom: Type.Optional(
      Type.Union([Type.String({ minLength: 1, maxLength: 16 }), Type.Null()]),
    ),
    allowedSellingUoms: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 16 }), { maxItems: 20 }),
    ),
    qtyDecimalPrecision: Type.Optional(
      Type.Integer({ minimum: 0, maximum: 6 }),
    ),
    featuredPos: Type.Optional(Type.Boolean()),
    densityGPerMl: Type.Optional(
      Type.Union([DecimalQuantityStringSchema, Type.Null()]),
    ),
    purchaseCost: DecimalMoneyStringSchema,
    sellingPrice: DecimalMoneyStringSchema,
    taxGroupId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
    trackInventory: Type.Optional(Type.Boolean()),
    reorderPoint: Type.Optional(DecimalQuantityStringSchema),
    reorderQty: Type.Optional(DecimalQuantityStringSchema),
    imageUrl: Type.Optional(
      Type.Union([Type.String({ maxLength: 2048 }), Type.Null()]),
    ),
    imageAlt: Type.Optional(
      Type.Union([Type.String({ maxLength: 200 }), Type.Null()]),
    ),
    primaryBarcode: Type.Optional(
      Type.Union([Type.String({ minLength: 1, maxLength: 64 }), Type.Null()]),
    ),
    alternateBarcodes: Type.Optional(
      Type.Array(ProductBarcodeInputSchema, { maxItems: 25 }),
    ),
    unitConversions: Type.Optional(
      Type.Array(ProductUnitConversionInputSchema, { maxItems: 20 }),
    ),
    allocationPolicy: Type.Optional(ProductAllocationPolicySchema),
    requireBatchSellingPrice: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type CreateProductRequest = Static<typeof CreateProductRequestSchema>;

export const UpdateProductRequestSchema = Type.Object(
  {
    sku: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
    description: Type.Optional(
      Type.Union([Type.String({ maxLength: 1000 }), Type.Null()]),
    ),
    categoryId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
    trackingMode: Type.Optional(TrackingModeSchema),
    valuationMethod: Type.Optional(ValuationMethodSchema),
    baseUom: Type.Optional(Type.String({ minLength: 1, maxLength: 16 })),
    productQtyMode: Type.Optional(ProductQtyModeSchema),
    measurementCategory: Type.Optional(
      Type.Union([MeasurementCategorySchema, Type.Null()]),
    ),
    purchaseUom: Type.Optional(
      Type.Union([Type.String({ minLength: 1, maxLength: 16 }), Type.Null()]),
    ),
    priceUom: Type.Optional(
      Type.Union([Type.String({ minLength: 1, maxLength: 16 }), Type.Null()]),
    ),
    allowedSellingUoms: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 16 }), { maxItems: 20 }),
    ),
    qtyDecimalPrecision: Type.Optional(
      Type.Integer({ minimum: 0, maximum: 6 }),
    ),
    featuredPos: Type.Optional(Type.Boolean()),
    densityGPerMl: Type.Optional(
      Type.Union([DecimalQuantityStringSchema, Type.Null()]),
    ),
    purchaseCost: Type.Optional(DecimalMoneyStringSchema),
    sellingPrice: Type.Optional(DecimalMoneyStringSchema),
    taxGroupId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
    trackInventory: Type.Optional(Type.Boolean()),
    reorderPoint: Type.Optional(DecimalQuantityStringSchema),
    reorderQty: Type.Optional(DecimalQuantityStringSchema),
    imageUrl: Type.Optional(
      Type.Union([Type.String({ maxLength: 2048 }), Type.Null()]),
    ),
    imageAlt: Type.Optional(
      Type.Union([Type.String({ maxLength: 200 }), Type.Null()]),
    ),
    primaryBarcode: Type.Optional(
      Type.Union([Type.String({ minLength: 1, maxLength: 64 }), Type.Null()]),
    ),
    alternateBarcodes: Type.Optional(
      Type.Array(ProductBarcodeInputSchema, { maxItems: 25 }),
    ),
    unitConversions: Type.Optional(
      Type.Array(ProductUnitConversionInputSchema, { maxItems: 20 }),
    ),
    allocationPolicy: Type.Optional(ProductAllocationPolicySchema),
    requireBatchSellingPrice: Type.Optional(Type.Boolean()),
    isActive: Type.Optional(Type.Boolean()),
    status: Type.Optional(RecordLifecycleStatusSchema),
  },
  { additionalProperties: false },
);
export type UpdateProductRequest = Static<typeof UpdateProductRequestSchema>;

export const ListProductsQuerySchema = Type.Object(
  {
    search: Type.Optional(Type.String({ maxLength: 160 })),
    categoryId: Type.Optional(UuidSchema),
    status: Type.Optional(RecordLifecycleStatusSchema),
    productType: Type.Optional(ProductTypeSchema),
    trackingMode: Type.Optional(TrackingModeSchema),
    valuationMethod: Type.Optional(ValuationMethodSchema),
    trackInventory: Type.Optional(
      Type.Union([Type.Literal('true'), Type.Literal('false')]),
    ),
    sortBy: Type.Optional(
      Type.Union([
        Type.Literal('name'),
        Type.Literal('sku'),
        Type.Literal('createdAt'),
        Type.Literal('sellingPrice'),
      ]),
    ),
    sortDir: Type.Optional(
      Type.Union([Type.Literal('asc'), Type.Literal('desc')]),
    ),
    limit: Type.Optional(PaginationLimitQueryParamSchema),
    cursor: Type.Optional(UuidSchema),
  },
  { additionalProperties: false },
);
export type ListProductsQuery = Static<typeof ListProductsQuerySchema>;

export const BarcodePriceSourceModeSchema = Type.Union([
  Type.Literal('INHERIT'),
  Type.Literal('INTAKE_SPECIFIC'),
  Type.Literal('BATCH_SPECIFIC'),
  Type.Literal('PACKAGE_EXPLICIT'),
]);
export type BarcodePriceSourceMode = Static<typeof BarcodePriceSourceModeSchema>;

export const ProductBarcodeResponseSchema = Type.Object({
  id: UuidSchema,
  barcode: Type.String(),
  barcodeType: BarcodeTypeSchema,
  symbology: Type.Optional(BarcodeTypeSchema),
  uomCode: Type.String(),
  isPrimary: Type.Boolean(),
  isActive: Type.Boolean(),
  stockIntakeLotId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
  intakeCode: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  batchId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
  batchNumber: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  branchId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
  warehouseId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
  conversionFactorToBase: Type.Optional(Type.Union([DecimalQuantityStringSchema, Type.Null()])),
  priceSourceMode: Type.Optional(BarcodePriceSourceModeSchema),
  sellingPriceOverride: Type.Optional(Type.Union([DecimalMoneyStringSchema, Type.Null()])),
  effectiveSellingPrice: Type.Optional(Type.Union([DecimalMoneyStringSchema, Type.Null()])),
  labelNote: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  deactivatedAt: Type.Optional(Type.Union([IsoTimestampSchema, Type.Null()])),
  createdAt: Type.Optional(IsoTimestampSchema),
  updatedAt: Type.Optional(IsoTimestampSchema),
});
export type ProductBarcodeResponse = Static<
  typeof ProductBarcodeResponseSchema
>;

export const GenerateBarcodeQuerySchema = Type.Object(
  {
    format: Type.Optional(BarcodeTypeSchema),
    symbology: Type.Optional(BarcodeTypeSchema),
    prefix: Type.Optional(Type.String({ minLength: 1, maxLength: 10 })),
  },
  { additionalProperties: false },
);
export type GenerateBarcodeQuery = Static<typeof GenerateBarcodeQuerySchema>;

export const GenerateBarcodeResponseSchema = Type.Object({
  barcode: Type.String(),
  format: BarcodeTypeSchema,
  symbology: Type.Optional(BarcodeTypeSchema),
  prefix: Type.String(),
});
export type GenerateBarcodeResponse = Static<typeof GenerateBarcodeResponseSchema>;

export const CreateProductBarcodeRequestSchema = Type.Object(
  {
    barcode: Type.String({ minLength: 1, maxLength: 64 }),
    barcodeType: Type.Optional(BarcodeTypeSchema),
    symbology: Type.Optional(BarcodeTypeSchema),
    uomCode: Type.Optional(Type.String({ minLength: 1, maxLength: 16 })),
    isPrimary: Type.Optional(Type.Boolean()),
    isActive: Type.Optional(Type.Boolean()),
    stockIntakeLotId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
    batchId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
    branchId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
    warehouseId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
    conversionFactorToBase: Type.Optional(Type.Union([DecimalQuantityStringSchema, Type.Null()])),
    priceSourceMode: Type.Optional(BarcodePriceSourceModeSchema),
    sellingPriceOverride: Type.Optional(Type.Union([DecimalMoneyStringSchema, Type.Null()])),
    labelNote: Type.Optional(Type.Union([Type.String({ maxLength: 240 }), Type.Null()])),
  },
  { additionalProperties: false },
);
export type CreateProductBarcodeRequest = Static<typeof CreateProductBarcodeRequestSchema>;

export const UpdateProductBarcodeRequestSchema = Type.Object(
  {
    barcodeType: Type.Optional(BarcodeTypeSchema),
    symbology: Type.Optional(BarcodeTypeSchema),
    uomCode: Type.Optional(Type.String({ minLength: 1, maxLength: 16 })),
    isPrimary: Type.Optional(Type.Boolean()),
    isActive: Type.Optional(Type.Boolean()),
    promotedBarcodeId: Type.Optional(UuidSchema),
    stockIntakeLotId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
    batchId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
    branchId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
    warehouseId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
    conversionFactorToBase: Type.Optional(Type.Union([DecimalQuantityStringSchema, Type.Null()])),
    priceSourceMode: Type.Optional(BarcodePriceSourceModeSchema),
    sellingPriceOverride: Type.Optional(Type.Union([DecimalMoneyStringSchema, Type.Null()])),
    labelNote: Type.Optional(Type.Union([Type.String({ maxLength: 240 }), Type.Null()])),
  },
  { additionalProperties: false },
);
export type UpdateProductBarcodeRequest = Static<typeof UpdateProductBarcodeRequestSchema>;

export const UnknownBarcodeActionSchema = Type.Union([
  Type.Literal('PROMPT'),
  Type.Literal('IGNORE'),
  Type.Literal('MANUAL_SEARCH'),
]);
export type UnknownBarcodeAction = Static<typeof UnknownBarcodeActionSchema>;

export const DefaultScanModeSchema = Type.Union([
  Type.Literal('HARDWARE'),
  Type.Literal('CAMERA'),
  Type.Literal('MANUAL'),
]);
export type DefaultScanMode = Static<typeof DefaultScanModeSchema>;

export const TenantBarcodeSettingsSchema = Type.Object({
  tenantId: UuidSchema,
  barcodeManagementEnabled: Type.Boolean(),
  internalGenerationEnabled: Type.Boolean(),
  internalPrefix: Type.String({ minLength: 1, maxLength: 10 }),
  labelsEnabled: Type.Boolean(),
  hardwareScannerEnabled: Type.Boolean(),
  cameraScannerEnabled: Type.Boolean(),
  autoAddToCart: Type.Boolean(),
  incrementOnDuplicate: Type.Boolean(),
  unknownBarcodeAction: UnknownBarcodeActionSchema,
  defaultScanMode: DefaultScanModeSchema,
  updatedAt: Type.Optional(Type.String()),
});
export type TenantBarcodeSettings = Static<typeof TenantBarcodeSettingsSchema>;

export const UpdateTenantBarcodeSettingsRequestSchema = Type.Object(
  {
    barcodeManagementEnabled: Type.Optional(Type.Boolean()),
    internalGenerationEnabled: Type.Optional(Type.Boolean()),
    internalPrefix: Type.Optional(Type.String({ minLength: 1, maxLength: 10 })),
    labelsEnabled: Type.Optional(Type.Boolean()),
    hardwareScannerEnabled: Type.Optional(Type.Boolean()),
    cameraScannerEnabled: Type.Optional(Type.Boolean()),
    autoAddToCart: Type.Optional(Type.Boolean()),
    incrementOnDuplicate: Type.Optional(Type.Boolean()),
    unknownBarcodeAction: Type.Optional(UnknownBarcodeActionSchema),
    defaultScanMode: Type.Optional(DefaultScanModeSchema),
  },
  { additionalProperties: false },
);
export type UpdateTenantBarcodeSettingsRequest = Static<
  typeof UpdateTenantBarcodeSettingsRequestSchema
>;

export const ProductUnitConversionResponseSchema = Type.Object({
  id: UuidSchema,
  uomCode: Type.String(),
  uomName: Type.String(),
  conversionFactorToBase: DecimalQuantityStringSchema,
  isDefaultPurchasing: Type.Optional(Type.Boolean()),
  isDefaultSelling: Type.Optional(Type.Boolean()),
  sellingPrice: Type.Optional(Type.Union([DecimalMoneyStringSchema, Type.Null()])),
  isActive: Type.Boolean(),
});
export type ProductUnitConversionResponse = Static<
  typeof ProductUnitConversionResponseSchema
>;

export const ProductResponseSchema = Type.Object({
  id: UuidSchema,
  tenantId: UuidSchema,
  sku: Type.String(),
  name: Type.String(),
  description: Type.Union([Type.String(), Type.Null()]),
  productType: ProductTypeSchema,
  trackingMode: TrackingModeSchema,
  valuationMethod: ValuationMethodSchema,
  status: RecordLifecycleStatusSchema,
  categoryId: Type.Union([UuidSchema, Type.Null()]),
  baseUom: Type.String(),
  productQtyMode: Type.Optional(ProductQtyModeSchema),
  measurementCategory: Type.Optional(
    Type.Union([MeasurementCategorySchema, Type.Null()]),
  ),
  purchaseUom: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  priceUom: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  allowedSellingUoms: Type.Optional(Type.Array(Type.String())),
  qtyDecimalPrecision: Type.Optional(Type.Integer()),
  featuredPos: Type.Optional(Type.Boolean()),
  densityGPerMl: Type.Optional(
    Type.Union([DecimalQuantityStringSchema, Type.Null()]),
  ),
  purchaseCost: DecimalMoneyStringSchema,
  sellingPrice: DecimalMoneyStringSchema,
  taxGroupId: Type.Union([UuidSchema, Type.Null()]),
  trackInventory: Type.Boolean(),
  reorderPoint: DecimalQuantityStringSchema,
  reorderQty: DecimalQuantityStringSchema,
  imageUrl: Type.Union([Type.String(), Type.Null()]),
  imageAlt: Type.Union([Type.String(), Type.Null()]),
  primaryBarcode: Type.Union([Type.String(), Type.Null()]),
  barcodes: Type.Array(ProductBarcodeResponseSchema),
  unitConversions: Type.Array(ProductUnitConversionResponseSchema),
  allocationPolicy: Type.Optional(ProductAllocationPolicySchema),
  requireBatchSellingPrice: Type.Optional(Type.Boolean()),
  syncVersion: Type.Integer(),
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
  archivedAt: Type.Union([IsoTimestampSchema, Type.Null()]),
});
export type ProductResponse = Static<typeof ProductResponseSchema>;

export const UploadProductImageRequestSchema = Type.Object(
  {
    filename: Type.String({ minLength: 1, maxLength: 255 }),
    mimeType: Type.Union([
      Type.Literal('image/jpeg'),
      Type.Literal('image/jpg'),
      Type.Literal('image/png'),
      Type.Literal('image/webp'),
    ]),
    dataBase64: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);
export type UploadProductImageRequest = Static<typeof UploadProductImageRequestSchema>;

export const UploadProductImageResponseSchema = Type.Object({
  imageUrl: Type.String(),
  mimeType: Type.String(),
  size: Type.Number(),
  storagePath: Type.String(),
});
export type UploadProductImageResponse = Static<typeof UploadProductImageResponseSchema>;

// 3. Supplier Contracts (/v1/suppliers)
export const CreateSupplierRequestSchema = Type.Object(
  {
    code: Type.String({ minLength: 1, maxLength: 32 }),
    businessName: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
    contactPerson: Type.Optional(
      Type.Union([Type.String({ maxLength: 120 }), Type.Null()]),
    ),
    email: Type.Optional(
      Type.Union([Type.String({ maxLength: 160 }), Type.Null()]),
    ),
    phone: Type.Optional(
      Type.Union([Type.String({ maxLength: 40 }), Type.Null()]),
    ),
    address: Type.Optional(
      Type.Union([Type.String({ maxLength: 500 }), Type.Null()]),
    ),
    taxRegistrationNumber: Type.Optional(
      Type.Union([Type.String({ maxLength: 64 }), Type.Null()]),
    ),
    notes: Type.Optional(
      Type.Union([Type.String({ maxLength: 1000 }), Type.Null()]),
    ),
    countryCode: Type.Optional(
      Type.Union([Type.String({ minLength: 2, maxLength: 3 }), Type.Null()]),
    ),
    currencyCode: Type.Optional(
      Type.Union([CurrencyCodeSchema, Type.Null()]),
    ),
    leadTimeDays: Type.Optional(
      Type.Union([Type.Integer({ minimum: 0, maximum: 365 }), Type.Null()]),
    ),
    isActive: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type CreateSupplierRequest = Static<typeof CreateSupplierRequestSchema>;

export const UpdateSupplierRequestSchema = Type.Object(
  {
    code: Type.Optional(Type.String({ minLength: 1, maxLength: 32 })),
    businessName: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
    contactPerson: Type.Optional(
      Type.Union([Type.String({ maxLength: 120 }), Type.Null()]),
    ),
    email: Type.Optional(
      Type.Union([Type.String({ maxLength: 160 }), Type.Null()]),
    ),
    phone: Type.Optional(
      Type.Union([Type.String({ maxLength: 40 }), Type.Null()]),
    ),
    address: Type.Optional(
      Type.Union([Type.String({ maxLength: 500 }), Type.Null()]),
    ),
    taxRegistrationNumber: Type.Optional(
      Type.Union([Type.String({ maxLength: 64 }), Type.Null()]),
    ),
    notes: Type.Optional(
      Type.Union([Type.String({ maxLength: 1000 }), Type.Null()]),
    ),
    countryCode: Type.Optional(
      Type.Union([Type.String({ minLength: 2, maxLength: 3 }), Type.Null()]),
    ),
    currencyCode: Type.Optional(
      Type.Union([CurrencyCodeSchema, Type.Null()]),
    ),
    leadTimeDays: Type.Optional(
      Type.Union([Type.Integer({ minimum: 0, maximum: 365 }), Type.Null()]),
    ),
    isActive: Type.Optional(Type.Boolean()),
    status: Type.Optional(RecordLifecycleStatusSchema),
  },
  { additionalProperties: false },
);
export type UpdateSupplierRequest = Static<typeof UpdateSupplierRequestSchema>;

export const LinkSupplierProductRequestSchema = Type.Object(
  {
    productId: UuidSchema,
    supplierSku: Type.Optional(
      Type.Union([Type.String({ minLength: 1, maxLength: 64 }), Type.Null()]),
    ),
    supplierProductName: Type.Optional(
      Type.Union([Type.String({ minLength: 1, maxLength: 160 }), Type.Null()]),
    ),
    unitCost: Type.Optional(
      Type.Union([DecimalMoneyStringSchema, Type.Null()]),
    ),
    currencyCode: Type.Optional(
      Type.Union([CurrencyCodeSchema, Type.Null()]),
    ),
    minimumOrderQty: Type.Optional(
      Type.Union([DecimalQuantityStringSchema, Type.Null()]),
    ),
    leadTimeDays: Type.Optional(
      Type.Union([Type.Integer({ minimum: 0, maximum: 365 }), Type.Null()]),
    ),
    isPreferred: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type LinkSupplierProductRequest = Static<
  typeof LinkSupplierProductRequestSchema
>;

export const ListSuppliersQuerySchema = Type.Object(
  {
    search: Type.Optional(Type.String({ maxLength: 160 })),
    status: Type.Optional(RecordLifecycleStatusSchema),
    limit: Type.Optional(PaginationLimitQueryParamSchema),
    cursor: Type.Optional(UuidSchema),
  },
  { additionalProperties: false },
);
export type ListSuppliersQuery = Static<typeof ListSuppliersQuerySchema>;

export const SupplierProductResponseSchema = Type.Object({
  id: UuidSchema,
  tenantId: UuidSchema,
  supplierId: UuidSchema,
  productId: UuidSchema,
  supplierSku: Type.Union([Type.String(), Type.Null()]),
  supplierProductName: Type.Union([Type.String(), Type.Null()]),
  unitCost: Type.Union([DecimalMoneyStringSchema, Type.Null()]),
  currencyCode: Type.Union([CurrencyCodeSchema, Type.Null()]),
  minimumOrderQty: Type.Union([DecimalQuantityStringSchema, Type.Null()]),
  leadTimeDays: Type.Union([Type.Integer(), Type.Null()]),
  isPreferred: Type.Boolean(),
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
});
export type SupplierProductResponse = Static<
  typeof SupplierProductResponseSchema
>;

export const SupplierResponseSchema = Type.Object({
  id: UuidSchema,
  tenantId: UuidSchema,
  code: Type.String(),
  businessName: Type.String(),
  name: Type.Optional(Type.String()),
  contactPerson: Type.Union([Type.String(), Type.Null()]),
  email: Type.Union([Type.String(), Type.Null()]),
  phone: Type.Union([Type.String(), Type.Null()]),
  address: Type.Union([Type.String(), Type.Null()]),
  taxRegistrationNumber: Type.Union([Type.String(), Type.Null()]),
  notes: Type.Union([Type.String(), Type.Null()]),
  status: RecordLifecycleStatusSchema,
  isActive: Type.Optional(Type.Boolean()),
  products: Type.Array(SupplierProductResponseSchema),
  syncVersion: Type.Integer(),
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
  archivedAt: Type.Union([IsoTimestampSchema, Type.Null()]),
});
export type SupplierResponse = Static<typeof SupplierResponseSchema>;

// 4. Stock Movement Contracts (/v1/inventory/movements)
export const StockMovementTypeSchema = Type.Union([
  Type.Literal('OPENING_STOCK'),
  Type.Literal('STOCK_IN'),
  Type.Literal('STOCK_OUT'),
  Type.Literal('ADJUSTMENT_POSITIVE'),
  Type.Literal('ADJUSTMENT_NEGATIVE'),
  Type.Literal('CORRECTION_REVERSAL'),
  Type.Literal('CUSTOMER_RETURN_RESTOCK'),
  Type.Literal('SUPPLIER_RETURN'),
  Type.Literal('TRANSFER_OUT'),
  Type.Literal('TRANSFER_IN'),
]);
export type StockMovementType = Static<typeof StockMovementTypeSchema>;

export const PostStockMovementRequestSchema = Type.Object(
  {
    branchId: UuidSchema,
    warehouseId: UuidSchema,
    productId: UuidSchema,
    batchId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
    serialId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
    supplierId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
    movementType: Type.Union([
      Type.Literal('OPENING_STOCK'),
      Type.Literal('STOCK_IN'),
      Type.Literal('STOCK_OUT'),
      Type.Literal('ADJUSTMENT_POSITIVE'),
      Type.Literal('ADJUSTMENT_NEGATIVE'),
      Type.Literal('CUSTOMER_RETURN_RESTOCK'),
      Type.Literal('SUPPLIER_RETURN'),
      Type.Literal('TRANSFER_OUT'),
      Type.Literal('TRANSFER_IN'),
    ]),
    quantity: DecimalQuantityStringSchema,
    uomCode: Type.Optional(Type.String({ minLength: 1, maxLength: 16 })),
    unitCost: Type.Optional(DecimalMoneyStringSchema),
    sellingPrice: Type.Optional(Type.Union([DecimalMoneyStringSchema, Type.Null()])),
    sellingUom: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 16 }), Type.Null()])),
    stockIntakeLotId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
    referenceType: Type.Optional(
      Type.Union([Type.String({ maxLength: 64 }), Type.Null()]),
    ),
    referenceId: Type.Optional(
      Type.Union([Type.String({ maxLength: 120 }), Type.Null()]),
    ),
    reason: Type.Optional(
      Type.Union([Type.String({ maxLength: 500 }), Type.Null()]),
    ),
    notes: Type.Optional(
      Type.Union([Type.String({ maxLength: 500 }), Type.Null()]),
    ),
    occurredAt: Type.Optional(IsoTimestampSchema),
    allowNegativeStockOverride: Type.Optional(Type.Boolean()),
    overrideReason: Type.Optional(
      Type.Union([Type.String({ maxLength: 500 }), Type.Null()]),
    ),
    entrySource: Type.Optional(
      Type.Union([
        Type.Literal('OPENING_BALANCE'),
        Type.Literal('PURCHASE_RECEIPT'),
        Type.Literal('POS_SALE'),
        Type.Literal('POS_VOID'),
        Type.Literal('CUSTOMER_RETURN'),
        Type.Literal('SUPPLIER_RETURN'),
        Type.Literal('STOCKTAKE'),
        Type.Literal('MANUAL'),
        Type.Literal('MANUAL_WEIGHT'),
        Type.Literal('SCALE_WEIGHT'),
        Type.Literal('SYSTEM_REVERSAL'),
      ]),
    ),
  },
  { additionalProperties: false },
);
export type PostStockMovementRequest = Static<
  typeof PostStockMovementRequestSchema
>;

export const ReverseStockMovementRequestSchema = Type.Object(
  {
    reason: Type.String({ minLength: 5, maxLength: 500 }),
    occurredAt: Type.Optional(IsoTimestampSchema),
    allowNegativeStockOverride: Type.Optional(Type.Boolean()),
    overrideReason: Type.Optional(
      Type.Union([Type.String({ maxLength: 500 }), Type.Null()]),
    ),
    entrySource: Type.Optional(
      Type.Union([
        Type.Literal('OPENING_BALANCE'),
        Type.Literal('PURCHASE_RECEIPT'),
        Type.Literal('POS_SALE'),
        Type.Literal('POS_VOID'),
        Type.Literal('CUSTOMER_RETURN'),
        Type.Literal('SUPPLIER_RETURN'),
        Type.Literal('STOCKTAKE'),
        Type.Literal('MANUAL'),
        Type.Literal('MANUAL_WEIGHT'),
        Type.Literal('SCALE_WEIGHT'),
        Type.Literal('SYSTEM_REVERSAL'),
      ]),
    ),
  },
  { additionalProperties: false },
);
export type ReverseStockMovementRequest = Static<
  typeof ReverseStockMovementRequestSchema
>;

export const ListStockMovementsQuerySchema = Type.Object(
  {
    branchId: Type.Optional(UuidSchema),
    warehouseId: Type.Optional(UuidSchema),
    productId: Type.Optional(UuidSchema),
    supplierId: Type.Optional(UuidSchema),
    movementType: Type.Optional(StockMovementTypeSchema),
    limit: Type.Optional(PaginationLimitQueryParamSchema),
    cursor: Type.Optional(UuidSchema),
  },
  { additionalProperties: false },
);
export type ListStockMovementsQuery = Static<
  typeof ListStockMovementsQuerySchema
>;

export const StockMovementResponseSchema = Type.Object({
  id: UuidSchema,
  tenantId: UuidSchema,
  branchId: UuidSchema,
  warehouseId: UuidSchema,
  productId: UuidSchema,
  productSku: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  productName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  batchId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
  serialId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
  stockIntakeLotId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
  intakeCode: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  configAlertId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
  supplierId: Type.Union([UuidSchema, Type.Null()]),
  movementType: StockMovementTypeSchema,
  uomCode: Type.String(),
  inputQty: DecimalQuantityStringSchema,
  conversionFactorToBase: DecimalQuantityStringSchema,
  qtyDelta: DecimalQuantityStringSchema,
  quantity: Type.Optional(DecimalQuantityStringSchema),
  balanceBefore: DecimalQuantityStringSchema,
  balanceAfter: DecimalQuantityStringSchema,
  unitCost: DecimalMoneyStringSchema,
  totalCostDelta: Type.Optional(DecimalMoneyStringSchema),
  referenceType: Type.Union([Type.String(), Type.Null()]),
  referenceId: Type.Union([Type.String(), Type.Null()]),
  reversedEntryId: Type.Union([UuidSchema, Type.Null()]),
  reason: Type.Union([Type.String(), Type.Null()]),
  notes: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  negativeStockOverrideApplied: Type.Boolean(),
  entrySource: Type.Optional(Type.String()),
  actorUserId: UuidSchema,
  idempotencyKey: UuidSchema,
  occurredAt: IsoTimestampSchema,
  recordedAt: IsoTimestampSchema,
  createdAt: Type.Optional(IsoTimestampSchema),
});
export type StockMovementResponse = Static<typeof StockMovementResponseSchema>;

// 5. Inventory Balance & Reconciliation Contracts (/v1/inventory/balances)
export const StockAlertStateSchema = Type.Union([
  Type.Literal('OK'),
  Type.Literal('LOW_STOCK'),
  Type.Literal('ZERO_STOCK'),
  Type.Literal('NEGATIVE_STOCK'),
]);
export type StockAlertState = Static<typeof StockAlertStateSchema>;

export const ListInventoryBalancesQuerySchema = Type.Object(
  {
    branchId: Type.Optional(UuidSchema),
    warehouseId: Type.Optional(UuidSchema),
    productId: Type.Optional(UuidSchema),
    search: Type.Optional(Type.String({ maxLength: 160 })),
    stockState: Type.Optional(
      Type.Union([
        Type.Literal('ALL'),
        Type.Literal('OK'),
        Type.Literal('LOW_STOCK'),
        Type.Literal('ZERO_STOCK'),
        Type.Literal('NEGATIVE_STOCK'),
      ]),
    ),
    includeZeroStock: Type.Optional(
      Type.Union([Type.Literal('true'), Type.Literal('false')]),
    ),
    limit: Type.Optional(PaginationLimitQueryParamSchema),
    cursor: Type.Optional(UuidSchema),
  },
  { additionalProperties: false },
);
export type ListInventoryBalancesQuery = Static<
  typeof ListInventoryBalancesQuerySchema
>;

export const InventoryBalanceResponseSchema = Type.Object({
  id: UuidSchema,
  tenantId: UuidSchema,
  branchId: UuidSchema,
  warehouseId: UuidSchema,
  productId: UuidSchema,
  sku: Type.String(),
  productName: Type.String(),
  uomCode: Type.String(),
  baseUom: Type.Optional(Type.String()),
  imageUrl: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  warehouseName: Type.Optional(Type.String()),
  branchName: Type.Optional(Type.String()),
  qtyOnHand: DecimalQuantityStringSchema,
  qtyReserved: DecimalQuantityStringSchema,
  qtyInTransit: DecimalQuantityStringSchema,
  qtyDamaged: DecimalQuantityStringSchema,
  availableQty: DecimalQuantityStringSchema,
  reorderPoint: DecimalQuantityStringSchema,
  reorderQty: DecimalQuantityStringSchema,
  isZeroStock: Type.Boolean(),
  isLowStock: Type.Boolean(),
  stockState: StockAlertStateSchema,
  movingAvgCost: DecimalMoneyStringSchema,
  totalInventoryValue: DecimalMoneyStringSchema,
  lastLedgerEntryId: UuidSchema,
  lastMovementAt: IsoTimestampSchema,
  syncVersion: Type.Integer(),
});
export type InventoryBalanceResponse = Static<
  typeof InventoryBalanceResponseSchema
>;

export const InventoryReconciliationDiscrepancySchema = Type.Object({
  warehouseId: UuidSchema,
  productId: UuidSchema,
  balanceQtyOnHand: DecimalQuantityStringSchema,
  ledgerSumQtyDelta: DecimalQuantityStringSchema,
  differenceQty: DecimalQuantityStringSchema,
  balanceLastEntryId: Type.Union([UuidSchema, Type.Null()]),
  ledgerLatestEntryId: Type.Union([UuidSchema, Type.Null()]),
});
export type InventoryReconciliationDiscrepancy = Static<
  typeof InventoryReconciliationDiscrepancySchema
>;

export const InventoryReconciliationResponseSchema = Type.Object({
  isConsistent: Type.Boolean(),
  checkedBalancesCount: Type.Integer(),
  checkedLedgerGroupsCount: Type.Integer(),
  discrepancies: Type.Array(InventoryReconciliationDiscrepancySchema),
});
export type InventoryReconciliationResponse = Static<
  typeof InventoryReconciliationResponseSchema
>;

// ============================================================================
// PHASE 3: POS & BILLING WIRE CONTRACTS
// ============================================================================

export const PosRegisterSummaryResponseSchema = Type.Object({
  id: UuidSchema,
  branchId: UuidSchema,
  branchCode: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  branchName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  warehouseId: UuidSchema,
  warehouseName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  code: Type.String(),
  name: Type.String(),
  isActive: Type.Boolean(),
});
export type PosRegisterSummaryResponse = Static<
  typeof PosRegisterSummaryResponseSchema
>;

export const EnsureDefaultPosRegisterRequestSchema = Type.Object(
  {
    branchId: UuidSchema,
  },
  { additionalProperties: false },
);
export type EnsureDefaultPosRegisterRequest = Static<
  typeof EnsureDefaultPosRegisterRequestSchema
>;

export const CreatePosRegisterRequestSchema = Type.Object(
  {
    branchId: UuidSchema,
    warehouseId: Type.Optional(UuidSchema),
    code: Type.String({ minLength: 2, maxLength: 30 }),
    name: Type.String({ minLength: 2, maxLength: 100 }),
    isActive: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type CreatePosRegisterRequest = Static<
  typeof CreatePosRegisterRequestSchema
>;

export const UpdatePosRegisterRequestSchema = Type.Object(
  {
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
    isActive: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type UpdatePosRegisterRequest = Static<
  typeof UpdatePosRegisterRequestSchema
>;

export const ListPosRegistersQuerySchema = Type.Object(
  {
    branchId: Type.Optional(UuidSchema),
  },
  { additionalProperties: false },
);
export type ListPosRegistersQuery = Static<
  typeof ListPosRegistersQuerySchema
>;

export const OpenPosShiftRequestSchema = Type.Object(
  {
    registerId: UuidSchema,
    openingCashFloat: DecimalMoneyStringSchema,
    notes: Type.Optional(Type.Union([Type.String({ maxLength: 500 }), Type.Null()])),
  },
  { additionalProperties: false },
);
export type OpenPosShiftRequest = Static<
  typeof OpenPosShiftRequestSchema
>;

export const ClosePosShiftRequestSchema = Type.Object(
  {
    countedClosingCash: DecimalMoneyStringSchema,
    notes: Type.Optional(Type.Union([Type.String({ maxLength: 500 }), Type.Null()])),
    adminOverride: Type.Optional(Type.Boolean()),
    overrideReason: Type.Optional(Type.Union([Type.String({ maxLength: 500 }), Type.Null()])),
  },
  { additionalProperties: false },
);
export type ClosePosShiftRequest = Static<
  typeof ClosePosShiftRequestSchema
>;

export const ListPosShiftsQuerySchema = Type.Object(
  {
    branchId: Type.Optional(UuidSchema),
    registerId: Type.Optional(UuidSchema),
    status: Type.Optional(Type.Union([Type.Literal('OPEN'), Type.Literal('CLOSED'), Type.Literal('ALL')])),
    limit: Type.Optional(PaginationLimitQueryParamSchema),
    offset: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);
export type ListPosShiftsQuery = Static<
  typeof ListPosShiftsQuerySchema
>;

export const CreatePosShiftAdjustmentRequestSchema = Type.Object(
  {
    type: Type.Union([
      Type.Literal('CASH_IN'),
      Type.Literal('CASH_OUT'),
      Type.Literal('CASH_REFUND'),
    ]),
    amount: DecimalMoneyStringSchema,
    reason: Type.String({ minLength: 3, maxLength: 500 }),
  },
  { additionalProperties: false },
);
export type CreatePosShiftAdjustmentRequest = Static<
  typeof CreatePosShiftAdjustmentRequestSchema
>;

export const PosShiftAdjustmentResponseSchema = Type.Object({
  id: UuidSchema,
  shiftId: UuidSchema,
  adjustmentType: Type.Union([
    Type.Literal('CASH_IN'),
    Type.Literal('CASH_OUT'),
    Type.Literal('CASH_REFUND'),
  ]),
  amount: DecimalMoneyStringSchema,
  reason: Type.String(),
  notes: Type.Union([Type.String(), Type.Null()]),
  createdAt: IsoTimestampSchema,
});
export type PosShiftAdjustmentResponse = Static<
  typeof PosShiftAdjustmentResponseSchema
>;

export const PosShiftResponseSchema = Type.Object({
  id: UuidSchema,
  branchId: UuidSchema,
  registerId: UuidSchema,
  openedByUserId: UuidSchema,
  openedByUserName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  closedByUserId: Type.Union([UuidSchema, Type.Null()]),
  closedByUserName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  currencyCode: CurrencyCodeSchema,
  openingCashFloat: DecimalMoneyStringSchema,
  cashSales: Type.Optional(DecimalMoneyStringSchema),
  cashIn: Type.Optional(DecimalMoneyStringSchema),
  cashOut: Type.Optional(DecimalMoneyStringSchema),
  cashRefunds: Type.Optional(DecimalMoneyStringSchema),
  expectedClosingCash: DecimalMoneyStringSchema,
  countedClosingCash: Type.Union([DecimalMoneyStringSchema, Type.Null()]),
  cashVariance: Type.Union([DecimalMoneyStringSchema, Type.Null()]),
  status: Type.Union([Type.Literal('OPEN'), Type.Literal('CLOSED')]),
  openedAt: IsoTimestampSchema,
  closedAt: Type.Union([IsoTimestampSchema, Type.Null()]),
  notes: Type.Union([Type.String(), Type.Null()]),
  isOwnShift: Type.Optional(Type.Boolean()),
  openedByOtherCashier: Type.Optional(Type.Boolean()),
  adminOverride: Type.Optional(Type.Boolean()),
  overrideReason: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});
export type PosShiftResponse = Static<typeof PosShiftResponseSchema>;

export const GetActivePosShiftQuerySchema = Type.Object(
  {
    registerId: Type.Optional(UuidSchema),
    branchId: Type.Optional(UuidSchema),
  },
  { additionalProperties: false },
);
export type GetActivePosShiftQuery = Static<
  typeof GetActivePosShiftQuerySchema
>;

export const PosProductSearchQuerySchema = Type.Object(
  {
    q: Type.Optional(Type.String({ maxLength: 100 })),
    barcode: Type.Optional(Type.String({ maxLength: 100 })),
    warehouseId: UuidSchema,
    branchId: Type.Optional(UuidSchema),
    categoryId: Type.Optional(UuidSchema),
    qtyMode: Type.Optional(ProductQtyModeSchema),
    featuredOnly: Type.Optional(Type.Union([Type.Literal('true'), Type.Literal('false')])),
    limit: Type.Optional(PaginationLimitQueryParamSchema),
  },
  { additionalProperties: false },
);
export type PosProductSearchQuery = Static<
  typeof PosProductSearchQuerySchema
>;

export const PosProductItemResponseSchema = Type.Object({
  id: UuidSchema,
  sku: Type.String(),
  name: Type.String(),
  productType: ProductTypeSchema,
  trackingMode: TrackingModeSchema,
  valuationMethod: ValuationMethodSchema,
  baseUom: Type.String(),
  productQtyMode: Type.Optional(ProductQtyModeSchema),
  measurementCategory: Type.Optional(
    Type.Union([MeasurementCategorySchema, Type.Null()]),
  ),
  priceUom: Type.Optional(Type.String()),
  allowedSellingUoms: Type.Optional(Type.Array(Type.String())),
  qtyDecimalPrecision: Type.Optional(Type.Integer()),
  featuredPos: Type.Optional(Type.Boolean()),
  densityGPerMl: Type.Optional(
    Type.Union([DecimalQuantityStringSchema, Type.Null()]),
  ),
  unitConversions: Type.Optional(Type.Array(ProductUnitConversionResponseSchema)),
  allocationPolicy: Type.Optional(ProductAllocationPolicySchema),
  requireBatchSellingPrice: Type.Optional(Type.Boolean()),
  retailPrice: DecimalMoneyStringSchema,
  globalRetailPrice: Type.Optional(DecimalMoneyStringSchema),
  priceSource: Type.Optional(Type.Union([Type.Literal('GLOBAL'), Type.Literal('BRANCH_OVERRIDE'), Type.Literal('BATCH')])),
  sellingPrice: Type.Optional(DecimalMoneyStringSchema),
  trackInventory: Type.Boolean(),
  availableQuantity: DecimalQuantityStringSchema,
  barcodes: Type.Array(Type.String()),
  categoryId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
  categoryName: Type.Union([Type.String(), Type.Null()]),
  imageUrl: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});
export type PosProductItemResponse = Static<
  typeof PosProductItemResponseSchema
>;

export const CheckoutCartLineInputSchema = Type.Object(
  {
    productId: UuidSchema,
    quantity: DecimalQuantityStringSchema,
    uomCode: Type.Optional(Type.String({ minLength: 1, maxLength: 20 })),
    entrySource: Type.Optional(LineEntrySourceSchema),
    discountAmount: Type.Optional(DecimalMoneyStringSchema),
    batchId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
    serialId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
    serialGroupId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
    serialNumber: Type.Optional(
      Type.Union([Type.String({ minLength: 1, maxLength: 100 }), Type.Null()]),
    ),
    stockIntakeLotId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
    scannedBarcode: Type.Optional(
      Type.Union([Type.String({ minLength: 1, maxLength: 128 }), Type.Null()]),
    ),
    overrideSellingPrice: Type.Optional(
      Type.Union([DecimalMoneyStringSchema, Type.Null()]),
    ),
    overrideReason: Type.Optional(
      Type.Union([Type.String({ minLength: 3, maxLength: 500 }), Type.Null()]),
    ),
  },
  { additionalProperties: false },
);
export type CheckoutCartLineInput = Static<
  typeof CheckoutCartLineInputSchema
>;

export const CheckoutPaymentInputSchema = Type.Object(
  {
    paymentMethod: Type.Union([
      Type.Literal('CASH'),
      Type.Literal('CARD'),
      Type.Literal('OTHER'),
      Type.Literal('CREDIT'),
      Type.Literal('BANK_TRANSFER'),
      Type.Literal('CHEQUE'),
    ]),
    amount: DecimalMoneyStringSchema,
    tenderedAmount: DecimalMoneyStringSchema,
    cardReference: Type.Optional(Type.String({ maxLength: 100 })),
    cardLastFour: Type.Optional(Type.String({ minLength: 4, maxLength: 4 })),
    notes: Type.Optional(Type.String({ maxLength: 255 })),
  },
  { additionalProperties: false },
);
export type CheckoutPaymentInput = Static<
  typeof CheckoutPaymentInputSchema
>;

export const CreatePosSaleRequestSchema = Type.Object(
  {
    registerId: UuidSchema,
    shiftId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
    customerId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
    lines: Type.Array(CheckoutCartLineInputSchema, { minItems: 1 }),
    orderDiscountAmount: Type.Optional(DecimalMoneyStringSchema),
    payments: Type.Array(CheckoutPaymentInputSchema, { minItems: 1 }),
    customerName: Type.Optional(
      Type.Union([Type.String({ maxLength: 255 }), Type.Null()]),
    ),
    notes: Type.Optional(
      Type.Union([Type.String({ maxLength: 500 }), Type.Null()]),
    ),
    allowNegativeStockOverride: Type.Optional(Type.Boolean()),
    overrideReason: Type.Optional(
      Type.Union([Type.String({ minLength: 3, maxLength: 500 }), Type.Null()]),
    ),
  },
  { additionalProperties: false },
);
export type CreatePosSaleRequest = Static<
  typeof CreatePosSaleRequestSchema
>;

export const SalesInvoiceLineResponseSchema = Type.Object({
  id: UuidSchema,
  lineNumber: Type.Integer(),
  productId: UuidSchema,
  sku: Type.String(),
  productName: Type.String(),
  uomCode: Type.String(),
  quantity: DecimalQuantityStringSchema,
  unitPrice: DecimalMoneyStringSchema,
  discountAmount: DecimalMoneyStringSchema,
  taxAmount: DecimalMoneyStringSchema,
  lineTotal: DecimalMoneyStringSchema,
  unitCostSnapshot: Type.Optional(DecimalMoneyStringSchema),
  batchId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
  batchNumber: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  internalBarcode: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  expiryDate: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  priceSource: Type.Optional(
    Type.Union([
      Type.Literal('BATCH_EXPLICIT'),
      Type.Literal('SERIAL_GROUP'),
      Type.Literal('INTAKE_SPECIFIC'),
      Type.Literal('PACKAGE_EXPLICIT'),
      Type.Literal('POS_MANUAL_OVERRIDE'),
      Type.Literal('PRODUCT_FALLBACK'),
      Type.Literal('BRANCH_OVERRIDE'),
      Type.Literal('GLOBAL_PRODUCT'),
      Type.Null(),
    ]),
  ),
  stockIntakeLotId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
  intakeCode: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  scannedBarcode: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  serialId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
  serialGroupId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
  serialNumber: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  serialInternalBarcode: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  originalEnteredQty: Type.Optional(Type.Union([DecimalQuantityStringSchema, Type.Null()])),
  originalUomCode: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  conversionFactorToBase: Type.Optional(Type.Union([DecimalQuantityStringSchema, Type.Null()])),
  normalizedBaseQty: Type.Optional(Type.Union([DecimalQuantityStringSchema, Type.Null()])),
  priceUom: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  pricePerPriceUom: Type.Optional(Type.Union([DecimalMoneyStringSchema, Type.Null()])),
  entrySource: Type.Optional(Type.String()),
});
export type SalesInvoiceLineResponse = Static<
  typeof SalesInvoiceLineResponseSchema
>;

export const SalesPaymentResponseSchema = Type.Object({
  id: UuidSchema,
  paymentMethod: Type.Union([
    Type.Literal('CASH'),
    Type.Literal('CARD'),
    Type.Literal('OTHER'),
    Type.Literal('CREDIT'),
    Type.Literal('BANK_TRANSFER'),
    Type.Literal('CHEQUE'),
  ]),
  amount: DecimalMoneyStringSchema,
  currencyCode: CurrencyCodeSchema,
  status: Type.Union([Type.Literal('COMPLETED'), Type.Literal('VOIDED')]),
  tenderedAmount: DecimalMoneyStringSchema,
  changeAmount: DecimalMoneyStringSchema,
  cardReference: Type.Union([Type.String(), Type.Null()]),
  cardLastFour: Type.Union([Type.String(), Type.Null()]),
  createdAt: IsoTimestampSchema,
});
export type SalesPaymentResponse = Static<
  typeof SalesPaymentResponseSchema
>;

export const SalesInvoiceResponseSchema = Type.Object({
  id: UuidSchema,
  invoiceNumber: Type.String(),
  status: Type.Union([Type.Literal('COMPLETED'), Type.Literal('VOIDED')]),
  branchId: UuidSchema,
  branchCode: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  branchName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  warehouseId: UuidSchema,
  registerId: UuidSchema,
  registerCode: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  shiftId: Type.Union([UuidSchema, Type.Null()]),
  cashierUserId: UuidSchema,
  customerId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
  customerName: Type.Union([Type.String(), Type.Null()]),
  currencyCode: CurrencyCodeSchema,
  subtotalAmount: DecimalMoneyStringSchema,
  discountAmount: DecimalMoneyStringSchema,
  taxAmount: DecimalMoneyStringSchema,
  roundingAdjustment: DecimalMoneyStringSchema,
  grandTotal: DecimalMoneyStringSchema,
  totalPaid: DecimalMoneyStringSchema,
  changeGiven: DecimalMoneyStringSchema,
  createdAt: IsoTimestampSchema,
  voidedAt: Type.Union([IsoTimestampSchema, Type.Null()]),
  voidReason: Type.Union([Type.String(), Type.Null()]),
  lines: Type.Array(SalesInvoiceLineResponseSchema),
  payments: Type.Array(SalesPaymentResponseSchema),
});
export type SalesInvoiceResponse = Static<
  typeof SalesInvoiceResponseSchema
>;

export const ListSalesQuerySchema = Type.Object(
  {
    branchId: Type.Optional(UuidSchema),
    registerId: Type.Optional(UuidSchema),
    status: Type.Optional(
      Type.Union([Type.Literal('COMPLETED'), Type.Literal('VOIDED')]),
    ),
    startDate: Type.Optional(IsoTimestampSchema),
    endDate: Type.Optional(IsoTimestampSchema),
    limit: Type.Optional(PaginationLimitQueryParamSchema),
    cursor: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
export type ListSalesQuery = Static<typeof ListSalesQuerySchema>;

export const SalesSummaryQuerySchema = Type.Object(
  {
    branchId: Type.Optional(UuidSchema),
    registerId: Type.Optional(UuidSchema),
    startDate: Type.Optional(IsoTimestampSchema),
    endDate: Type.Optional(IsoTimestampSchema),
  },
  { additionalProperties: false },
);
export type SalesSummaryQuery = Static<typeof SalesSummaryQuerySchema>;

export const SalesSummaryResponseSchema = Type.Object(
  {
    completedAmount: DecimalMoneyStringSchema,
    completedCount: Type.Integer({ minimum: 0 }),
    voidedAmount: DecimalMoneyStringSchema,
    voidedCount: Type.Integer({ minimum: 0 }),
    totalSalesCount: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
export type SalesSummaryResponse = Static<typeof SalesSummaryResponseSchema>;

export const VoidSaleRequestSchema = Type.Object(
  {
    reason: Type.String({ minLength: 3, maxLength: 500 }),
  },
  { additionalProperties: false },
);
export type VoidSaleRequest = Static<typeof VoidSaleRequestSchema>;

export const PrintableReceiptLineSchema = Type.Object({
  sku: Type.String(),
  name: Type.String(),
  quantity: DecimalQuantityStringSchema,
  uomCode: Type.String(),
  unitPrice: DecimalMoneyStringSchema,
  discountAmount: DecimalMoneyStringSchema,
  taxAmount: DecimalMoneyStringSchema,
  lineTotal: DecimalMoneyStringSchema,
  unitCostSnapshot: Type.Optional(DecimalMoneyStringSchema),
  batchId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
  batchNumber: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  internalBarcode: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  expiryDate: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  priceSource: Type.Optional(
    Type.Union([
      Type.Literal('BATCH_EXPLICIT'),
      Type.Literal('SERIAL_GROUP'),
      Type.Literal('INTAKE_SPECIFIC'),
      Type.Literal('PACKAGE_EXPLICIT'),
      Type.Literal('POS_MANUAL_OVERRIDE'),
      Type.Literal('PRODUCT_FALLBACK'),
      Type.Literal('BRANCH_OVERRIDE'),
      Type.Literal('GLOBAL_PRODUCT'),
      Type.Null(),
    ]),
  ),
  stockIntakeLotId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
  intakeCode: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  scannedBarcode: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  serialId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
  serialGroupId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
  serialNumber: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  serialInternalBarcode: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  originalEnteredQty: Type.Optional(Type.Union([DecimalQuantityStringSchema, Type.Null()])),
  originalUomCode: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  conversionFactorToBase: Type.Optional(Type.Union([DecimalQuantityStringSchema, Type.Null()])),
  normalizedBaseQty: Type.Optional(Type.Union([DecimalQuantityStringSchema, Type.Null()])),
  priceUom: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  pricePerPriceUom: Type.Optional(Type.Union([DecimalMoneyStringSchema, Type.Null()])),
  entrySource: Type.Optional(Type.String()),
});
export type PrintableReceiptLine = Static<typeof PrintableReceiptLineSchema>;

export const PrintableReceiptPaymentSchema = Type.Object({
  method: Type.String(),
  amount: DecimalMoneyStringSchema,
  tenderedAmount: DecimalMoneyStringSchema,
  changeAmount: DecimalMoneyStringSchema,
});
export type PrintableReceiptPayment = Static<
  typeof PrintableReceiptPaymentSchema
>;

export const ReceiptResponseSchema = Type.Object({
  businessName: Type.String(),
  branchName: Type.String(),
  registerCode: Type.String(),
  invoiceNumber: Type.String(),
  cashierName: Type.String(),
  formattedTimestamp: Type.String(),
  currencyCode: CurrencyCodeSchema,
  lines: Type.Array(PrintableReceiptLineSchema),
  subtotalAmount: DecimalMoneyStringSchema,
  discountAmount: DecimalMoneyStringSchema,
  taxAmount: DecimalMoneyStringSchema,
  grandTotal: DecimalMoneyStringSchema,
  payments: Type.Array(PrintableReceiptPaymentSchema),
  changeGiven: DecimalMoneyStringSchema,
  notes: Type.Union([Type.String(), Type.Null()]),
});
export type ReceiptResponse = Static<typeof ReceiptResponseSchema>;

// ============================================================================
// Phase 4 Advanced Inventory Contracts (Batches, Expiry, Serials, Costing, Stocktakes)
// ============================================================================

// 1. Batches & Lots
export const BatchStatusSchema = Type.Union([
  Type.Literal('ACTIVE'),
  Type.Literal('QUARANTINED'),
  Type.Literal('DEPLETED'),
  Type.Literal('EXPIRED'),
  Type.Literal('INACTIVE'),
  Type.Literal('DAMAGED'),
]);
export type BatchStatus = Static<typeof BatchStatusSchema>;

export const BatchAllocationPolicySchema = Type.Union([
  Type.Literal('FEFO'),
  Type.Literal('FIFO'),
  Type.Literal('MANUAL'),
]);
export type BatchAllocationPolicy = Static<typeof BatchAllocationPolicySchema>;

export const DefaultTenantBatchAllocationPolicySchema = Type.Union([
  Type.Literal('FEFO'),
  Type.Literal('FIFO'),
]);
export type DefaultTenantBatchAllocationPolicy = Static<typeof DefaultTenantBatchAllocationPolicySchema>;

export const BatchPricingModeSchema = Type.Union([
  Type.Literal('EXPLICIT'),
  Type.Literal('INHERIT_PRODUCT'),
]);
export type BatchPricingMode = Static<typeof BatchPricingModeSchema>;

export const BatchPricingFallbackPolicySchema = Type.Union([
  Type.Literal('BLOCK_MISSING'),
  Type.Literal('ALLOW_PRODUCT_FALLBACK'),
]);
export type BatchPricingFallbackPolicy = Static<typeof BatchPricingFallbackPolicySchema>;

export const LotConflictPolicySchema = Type.Union([
  Type.Literal('REJECT'),
  Type.Literal('CREATE_NEW_LOT_SUFFIX'),
  Type.Literal('MANAGER_OVERRIDE'),
]);
export type LotConflictPolicy = Static<typeof LotConflictPolicySchema>;

export const BatchExpiryStatusSchema = Type.Union([
  Type.Literal('VALID'),
  Type.Literal('EXPIRING_SOON'),
  Type.Literal('EXPIRED'),
]);
export type BatchExpiryStatus = Static<typeof BatchExpiryStatusSchema>;

export const CreateBatchRequestSchema = Type.Object(
  {
    branchId: Type.Optional(UuidSchema),
    productId: UuidSchema,
    warehouseId: UuidSchema,
    batchNumber: Type.String({ minLength: 1, maxLength: 64 }),
    supplierId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
    receivedDate: Type.Optional(Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' })),
    manufacturingDate: Type.Optional(
      Type.Union([Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }), Type.Null()]),
    ),
    expiryDate: Type.Optional(
      Type.Union([Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }), Type.Null()]),
    ),
    initialQuantity: DecimalQuantityStringSchema,
    unitCost: DecimalMoneyStringSchema,
    sellingPrice: Type.Optional(Type.Union([DecimalMoneyStringSchema, Type.Null()])),
    minSellingPrice: Type.Optional(Type.Union([DecimalMoneyStringSchema, Type.Null()])),
    maxDiscountPct: Type.Optional(Type.Union([DecimalPctStringSchema, Type.Null()])),
    batchPricingMode: Type.Optional(BatchPricingModeSchema),
    internalBarcode: Type.Optional(
      Type.Union([Type.String({ minLength: 3, maxLength: 120 }), Type.Null()]),
    ),
    currencyCode: Type.Optional(CurrencyCodeSchema),
  },
  { additionalProperties: false },
);
export type CreateBatchRequest = Static<typeof CreateBatchRequestSchema>;

export const BatchResponseSchema = Type.Object({
  id: UuidSchema,
  tenantId: UuidSchema,
  branchId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
  productId: UuidSchema,
  warehouseId: UuidSchema,
  batchNumber: Type.String(),
  supplierId: Type.Union([UuidSchema, Type.Null()]),
  status: BatchStatusSchema,
  receivedDate: Type.String(),
  manufacturingDate: Type.Union([Type.String(), Type.Null()]),
  expiryDate: Type.Union([Type.String(), Type.Null()]),
  initialQuantity: DecimalQuantityStringSchema,
  currentQuantity: DecimalQuantityStringSchema,
  reservedQuantity: Type.Optional(DecimalQuantityStringSchema),
  availableQuantity: Type.Optional(DecimalQuantityStringSchema),
  unitCost: DecimalMoneyStringSchema,
  sellingPrice: Type.Optional(Type.Union([DecimalMoneyStringSchema, Type.Null()])),
  minSellingPrice: Type.Optional(Type.Union([DecimalMoneyStringSchema, Type.Null()])),
  maxDiscountPct: Type.Optional(Type.Union([DecimalPctStringSchema, Type.Null()])),
  batchPricingMode: Type.Optional(BatchPricingModeSchema),
  internalBarcode: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  internalBarcodeType: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  currencyCode: CurrencyCodeSchema,
  expiryStatus: BatchExpiryStatusSchema,
  quarantineReason: Type.Union([Type.String(), Type.Null()]),
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
});
export type BatchResponse = Static<typeof BatchResponseSchema>;

export const ListBatchesQuerySchema = Type.Object(
  {
    branchId: Type.Optional(UuidSchema),
    productId: Type.Optional(UuidSchema),
    warehouseId: Type.Optional(UuidSchema),
    status: Type.Optional(BatchStatusSchema),
    expiryStatus: Type.Optional(BatchExpiryStatusSchema),
    expiringWithinDays: Type.Optional(Type.Integer({ minimum: 1, maximum: 365 })),
    missingPriceOnly: Type.Optional(
      Type.Union([Type.Boolean(), Type.Literal('true'), Type.Literal('false')]),
    ),
    search: Type.Optional(Type.String({ maxLength: 64 })),
    limit: Type.Optional(PaginationLimitQueryParamSchema),
    cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
  },
  { additionalProperties: false },
);
export type ListBatchesQuery = Static<typeof ListBatchesQuerySchema>;

export const QuarantineBatchRequestSchema = Type.Object(
  {
    reason: Type.String({ minLength: 3, maxLength: 500 }),
  },
  { additionalProperties: false },
);
export type QuarantineBatchRequest = Static<typeof QuarantineBatchRequestSchema>;

export const FefoBatchAllocationSchema = Type.Object({
  batchId: UuidSchema,
  batchNumber: Type.String(),
  internalBarcode: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  expiryDate: Type.Union([Type.String(), Type.Null()]),
  availableQty: DecimalQuantityStringSchema,
  reservedQty: Type.Optional(DecimalQuantityStringSchema),
  allocatedQty: DecimalQuantityStringSchema,
  unitCost: DecimalMoneyStringSchema,
  sellingPrice: Type.Optional(Type.Union([DecimalMoneyStringSchema, Type.Null()])),
  batchPricingMode: Type.Optional(BatchPricingModeSchema),
});
export type FefoBatchAllocation = Static<typeof FefoBatchAllocationSchema>;

export const FefoSelectionResponseSchema = Type.Object({
  productId: UuidSchema,
  warehouseId: UuidSchema,
  allocationPolicy: Type.Optional(BatchAllocationPolicySchema),
  requestedQty: DecimalQuantityStringSchema,
  fulfilledQty: DecimalQuantityStringSchema,
  unfulfilledQty: DecimalQuantityStringSchema,
  isFullyFulfilled: Type.Boolean(),
  allocations: Type.Array(FefoBatchAllocationSchema),
});
export type FefoSelectionResponse = Static<typeof FefoSelectionResponseSchema>;

// 2. Serial Numbers
export const SerialStatusSchema = Type.Union([
  Type.Literal('IN_STOCK'),
  Type.Literal('RESERVED'),
  Type.Literal('SOLD'),
  Type.Literal('RETURNED'),
  Type.Literal('QUARANTINED'),
  Type.Literal('DAMAGED'),
  Type.Literal('WRITTEN_OFF'),
]);
export type SerialStatus = Static<typeof SerialStatusSchema>;

export const RegisterSerialStockRequestSchema = Type.Object(
  {
    branchId: UuidSchema,
    warehouseId: UuidSchema,
    productId: UuidSchema,
    batchId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
    supplierId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
    groupCode: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    serialNumbers: Type.Array(Type.String({ minLength: 1, maxLength: 100 }), {
      minItems: 1,
      maxItems: 1000,
    }),
    unitCost: DecimalMoneyStringSchema,
    sellingPrice: Type.Optional(DecimalMoneyStringSchema),
    generateBarcodes: Type.Optional(Type.Boolean()),
    notes: Type.Optional(Type.String({ maxLength: 500 })),
  },
  { additionalProperties: false },
);
export type RegisterSerialStockRequest = Static<
  typeof RegisterSerialStockRequestSchema
>;

export const SerialResponseSchema = Type.Object({
  id: UuidSchema,
  tenantId: UuidSchema,
  productId: UuidSchema,
  batchId: Type.Union([UuidSchema, Type.Null()]),
  serialGroupId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
  groupCode: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  warehouseId: UuidSchema,
  branchId: UuidSchema,
  serialNumber: Type.String(),
  internalBarcode: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  status: SerialStatusSchema,
  unitCost: DecimalMoneyStringSchema,
  sellingPrice: Type.Optional(Type.Union([DecimalMoneyStringSchema, Type.Null()])),
  currencyCode: CurrencyCodeSchema,
  labelPrintCount: Type.Optional(Type.Integer()),
  lastLabelPrintedAt: Type.Optional(Type.Union([IsoTimestampSchema, Type.Null()])),
  receivedAt: IsoTimestampSchema,
  soldAt: Type.Union([IsoTimestampSchema, Type.Null()]),
  lastMovementId: Type.Union([UuidSchema, Type.Null()]),
  lastSaleInvoiceId: Type.Union([UuidSchema, Type.Null()]),
  notes: Type.Union([Type.String(), Type.Null()]),
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
});
export type SerialResponse = Static<typeof SerialResponseSchema>;

export const SerialStockGroupResponseSchema = Type.Object({
  id: UuidSchema,
  tenantId: UuidSchema,
  branchId: UuidSchema,
  warehouseId: UuidSchema,
  productId: UuidSchema,
  productSku: Type.Optional(Type.String()),
  productName: Type.Optional(Type.String()),
  supplierId: Type.Union([UuidSchema, Type.Null()]),
  goodsReceiptId: Type.Union([UuidSchema, Type.Null()]),
  groupCode: Type.String(),
  purchaseCost: DecimalMoneyStringSchema,
  sellingPrice: DecimalMoneyStringSchema,
  currencyCode: CurrencyCodeSchema,
  initialQuantity: Type.Integer(),
  remainingQuantity: Type.Integer(),
  receivedAt: IsoTimestampSchema,
  notes: Type.Union([Type.String(), Type.Null()]),
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
  serials: Type.Optional(Type.Array(SerialResponseSchema)),
});
export type SerialStockGroupResponse = Static<typeof SerialStockGroupResponseSchema>;

export const PrintSerialGroupBarcodesRequestSchema = Type.Object(
  {
    serialIds: Type.Optional(Type.Array(UuidSchema, { minItems: 1, maxItems: 1000 })),
    format: Type.Union([
      Type.Literal('THERMAL_40X30'),
      Type.Literal('THERMAL_50X30'),
      Type.Literal('THERMAL_50X40'),
      Type.Literal('THERMAL_58'),
      Type.Literal('THERMAL_80'),
      Type.Literal('A4_SHEET'),
    ]),
  },
  { additionalProperties: false },
);
export type PrintSerialGroupBarcodesRequest = Static<typeof PrintSerialGroupBarcodesRequestSchema>;

export const ListSerialsQuerySchema = Type.Object(
  {
    productId: Type.Optional(UuidSchema),
    serialGroupId: Type.Optional(UuidSchema),
    warehouseId: Type.Optional(UuidSchema),
    branchId: Type.Optional(UuidSchema),
    status: Type.Optional(SerialStatusSchema),
    serialNumber: Type.Optional(Type.String({ maxLength: 100 })),
    limit: Type.Optional(PaginationLimitQueryParamSchema),
    cursor: Type.Optional(UuidSchema),
  },
  { additionalProperties: false },
);
export type ListSerialsQuery = Static<typeof ListSerialsQuerySchema>;

export const ListSerialStockGroupsQuerySchema = Type.Object(
  {
    productId: Type.Optional(UuidSchema),
    warehouseId: Type.Optional(UuidSchema),
    branchId: Type.Optional(UuidSchema),
    inStockOnly: Type.Optional(Type.Union([Type.Literal('true'), Type.Literal('false')])),
    includeSerials: Type.Optional(Type.Union([Type.Literal('true'), Type.Literal('false')])),
    limit: Type.Optional(PaginationLimitQueryParamSchema),
    cursor: Type.Optional(UuidSchema),
  },
  { additionalProperties: false },
);
export type ListSerialStockGroupsQuery = Static<typeof ListSerialStockGroupsQuerySchema>;

export const TransitionSerialStatusRequestSchema = Type.Object(
  {
    toStatus: SerialStatusSchema,
    reason: Type.String({ minLength: 3, maxLength: 500 }),
  },
  { additionalProperties: false },
);
export type TransitionSerialStatusRequest = Static<
  typeof TransitionSerialStatusRequestSchema
>;

// 3. Costing & Valuation
export const FifoCostLayerResponseSchema = Type.Object({
  id: UuidSchema,
  tenantId: UuidSchema,
  warehouseId: UuidSchema,
  productId: UuidSchema,
  batchId: Type.Union([UuidSchema, Type.Null()]),
  ledgerEntryId: UuidSchema,
  layerDate: IsoTimestampSchema,
  receivedQty: DecimalQuantityStringSchema,
  remainingQty: DecimalQuantityStringSchema,
  unitCost: DecimalMoneyStringSchema,
  currencyCode: CurrencyCodeSchema,
  status: Type.Union([Type.Literal('OPEN'), Type.Literal('DEPLETED')]),
  createdAt: IsoTimestampSchema,
});
export type FifoCostLayerResponse = Static<typeof FifoCostLayerResponseSchema>;

export const InventoryValuationSummarySchema = Type.Object({
  productId: UuidSchema,
  warehouseId: UuidSchema,
  sku: Type.String(),
  productName: Type.String(),
  valuationMethod: ValuationMethodSchema,
  qtyOnHand: DecimalQuantityStringSchema,
  movingAvgCost: DecimalMoneyStringSchema,
  totalInventoryValue: DecimalMoneyStringSchema,
  openLayersCount: Type.Integer(),
  activeBatchesCount: Type.Integer(),
});
export type InventoryValuationSummary = Static<
  typeof InventoryValuationSummarySchema
>;

export const InventoryValuationResponseSchema = Type.Object({
  warehouseId: UuidSchema,
  totalAssetValue: DecimalMoneyStringSchema,
  currencyCode: CurrencyCodeSchema,
  items: Type.Array(InventoryValuationSummarySchema),
});
export type InventoryValuationResponse = Static<
  typeof InventoryValuationResponseSchema
>;

// 4. Stock Count / Stocktake Sessions
export const StocktakeScopeSchema = Type.Union([
  Type.Literal('FULL_WAREHOUSE'),
  Type.Literal('CATEGORY'),
  Type.Literal('PARTIAL'),
]);
export type StocktakeScope = Static<typeof StocktakeScopeSchema>;

export const StocktakeStatusSchema = Type.Union([
  Type.Literal('DRAFT'),
  Type.Literal('IN_PROGRESS'),
  Type.Literal('SUBMITTED'),
  Type.Literal('APPROVED'),
  Type.Literal('REJECTED'),
  Type.Literal('POSTED'),
]);
export type StocktakeStatus = Static<typeof StocktakeStatusSchema>;

export const CreateStocktakeSessionRequestSchema = Type.Object(
  {
    branchId: UuidSchema,
    warehouseId: UuidSchema,
    scope: StocktakeScopeSchema,
    categoryId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
    productIds: Type.Optional(Type.Array(UuidSchema, { maxItems: 500 })),
    notes: Type.Optional(Type.String({ maxLength: 500 })),
  },
  { additionalProperties: false },
);
export type CreateStocktakeSessionRequest = Static<
  typeof CreateStocktakeSessionRequestSchema
>;

export const RecordStocktakeCountLineSchema = Type.Object({
  productId: UuidSchema,
  batchId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
  countedQty: DecimalQuantityStringSchema,
  notes: Type.Optional(Type.String({ maxLength: 500 })),
});
export type RecordStocktakeCountLine = Static<
  typeof RecordStocktakeCountLineSchema
>;

export const RecordStocktakeCountRequestSchema = Type.Object(
  {
    lines: Type.Array(RecordStocktakeCountLineSchema, { minItems: 1 }),
  },
  { additionalProperties: false },
);
export type RecordStocktakeCountRequest = Static<
  typeof RecordStocktakeCountRequestSchema
>;

export const StocktakeLineResponseSchema = Type.Object({
  id: UuidSchema,
  productId: UuidSchema,
  productSku: Type.String(),
  productName: Type.String(),
  batchId: Type.Union([UuidSchema, Type.Null()]),
  batchNumber: Type.Union([Type.String(), Type.Null()]),
  expectedQty: DecimalQuantityStringSchema,
  countedQty: Type.Union([DecimalQuantityStringSchema, Type.Null()]),
  varianceQty: Type.Union([DecimalQuantityStringSchema, Type.Null()]),
  unitCost: DecimalMoneyStringSchema,
  varianceValue: DecimalMoneyStringSchema,
  adjustmentMovementId: Type.Union([UuidSchema, Type.Null()]),
  notes: Type.Union([Type.String(), Type.Null()]),
});
export type StocktakeLineResponse = Static<typeof StocktakeLineResponseSchema>;

export const StocktakeSessionResponseSchema = Type.Object({
  id: UuidSchema,
  countNumber: Type.String(),
  branchId: UuidSchema,
  warehouseId: UuidSchema,
  scope: StocktakeScopeSchema,
  categoryId: Type.Union([UuidSchema, Type.Null()]),
  status: StocktakeStatusSchema,
  startedAt: Type.Union([IsoTimestampSchema, Type.Null()]),
  completedAt: Type.Union([IsoTimestampSchema, Type.Null()]),
  countedByUserId: Type.Union([UuidSchema, Type.Null()]),
  reviewedByUserId: Type.Union([UuidSchema, Type.Null()]),
  rejectionReason: Type.Union([Type.String(), Type.Null()]),
  notes: Type.Union([Type.String(), Type.Null()]),
  totalLinesCount: Type.Integer(),
  discrepantLinesCount: Type.Integer(),
  totalVarianceValue: DecimalMoneyStringSchema,
  lines: Type.Optional(Type.Array(StocktakeLineResponseSchema)),
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
});
export type StocktakeSessionResponse = Static<
  typeof StocktakeSessionResponseSchema
>;

export const ListStocktakeSessionsQuerySchema = Type.Object(
  {
    warehouseId: Type.Optional(UuidSchema),
    status: Type.Optional(StocktakeStatusSchema),
    limit: Type.Optional(PaginationLimitQueryParamSchema),
    cursor: Type.Optional(UuidSchema),
  },
  { additionalProperties: false },
);
export type ListStocktakeSessionsQuery = Static<
  typeof ListStocktakeSessionsQuerySchema
>;

export const ReviewStocktakeRequestSchema = Type.Object(
  {
    action: Type.Union([Type.Literal('APPROVE'), Type.Literal('REJECT')]),
    rejectionReason: Type.Optional(
      Type.String({ minLength: 3, maxLength: 500 }),
    ),
  },
  { additionalProperties: false },
);
export type ReviewStocktakeRequest = Static<
  typeof ReviewStocktakeRequestSchema
>;

// ============================================================================
// Phase 5.0 Schemas: Authentication & Business Foundation
// ============================================================================

export const SignUpRequestSchema = Type.Object(
  {
    email: Type.String({ minLength: 3, maxLength: 255 }),
    password: Type.String({ minLength: 8, maxLength: 128 }),
    fullName: Type.String({ minLength: 2, maxLength: 160 }),
  },
  { additionalProperties: false },
);
export type SignUpRequest = Static<typeof SignUpRequestSchema>;

export const SignUpResponseSchema = Type.Object({
  userId: UuidSchema,
  email: Type.String(),
  fullName: Type.String(),
  token: Type.Optional(Type.String()),
  refreshToken: Type.Optional(Type.String()),
  requiresEmailVerification: Type.Boolean(),
  message: Type.String(),
});
export type SignUpResponse = Static<typeof SignUpResponseSchema>;

export const LoginRequestSchema = Type.Object(
  {
    email: Type.String({ minLength: 3, maxLength: 255 }),
    password: Type.String({ minLength: 1, maxLength: 128 }),
  },
  { additionalProperties: false },
);
export type LoginRequest = Static<typeof LoginRequestSchema>;

export const BranchSummarySchema = Type.Object({
  id: UuidSchema,
  code: Type.String(),
  name: Type.String(),
  defaultWarehouseId: Type.Union([UuidSchema, Type.Null()]),
  timezone: Type.Optional(Type.String()),
});
export type BranchSummary = Static<typeof BranchSummarySchema>;

export const TenantMembershipSummarySchema = Type.Object({
  tenantId: UuidSchema,
  businessName: Type.String(),
  slug: Type.String(),
  baseCurrency: CurrencyCodeSchema,
  status: Type.String(),
  membershipStatus: Type.Optional(Type.String()),
  role: Type.String(),
  roles: Type.Optional(Type.Array(Type.String())),
  permissions: Type.Optional(Type.Array(Type.String())),
  allLocationsAccess: Type.Optional(Type.Boolean()),
  allowedBranchIds: Type.Optional(
    Type.Union([Type.Array(Type.String()), Type.Null()]),
  ),
  allowedWarehouseIds: Type.Optional(
    Type.Union([Type.Array(Type.String()), Type.Null()]),
  ),
  timezone: Type.Optional(Type.String()),
  branches: Type.Array(BranchSummarySchema),
});
export type TenantMembershipSummary = Static<
  typeof TenantMembershipSummarySchema
>;

export const MemberPermissionsResponseSchema = Type.Object({
  membershipId: UuidSchema,
  status: Type.String(),
  role: Type.Optional(Type.String()),
  roles: Type.Array(Type.String()),
  permissions: Type.Array(Type.String()),
  allLocationsAccess: Type.Boolean(),
  allowedBranchIds: Type.Union([Type.Array(UuidSchema), Type.Null()]),
  allowedWarehouseIds: Type.Union([Type.Array(UuidSchema), Type.Null()]),
});
export type MemberPermissionsResponse = Static<
  typeof MemberPermissionsResponseSchema
>;

export const AuthUserSummarySchema = Type.Object({
  id: UuidSchema,
  email: Type.String(),
  fullName: Type.String(),
  isPlatformAdmin: Type.Optional(Type.Boolean()),
  platformRole: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  mfaEnforced: Type.Optional(Type.Boolean()),
  totpEnabled: Type.Optional(Type.Boolean()),
});
export type AuthUserSummary = Static<typeof AuthUserSummarySchema>;

export const LoginResponseSchema = Type.Object({
  token: Type.String(),
  refreshToken: Type.Optional(Type.String()),
  expiresIn: Type.Optional(Type.Integer()),
  user: AuthUserSummarySchema,
  memberships: Type.Array(TenantMembershipSummarySchema),
});
export type LoginResponse = Static<typeof LoginResponseSchema>;

export const RefreshTokenRequestSchema = Type.Object(
  {
    refreshToken: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);
export type RefreshTokenRequest = Static<typeof RefreshTokenRequestSchema>;

export const PasswordResetRequestSchema = Type.Object(
  {
    email: Type.String({ minLength: 3, maxLength: 255 }),
  },
  { additionalProperties: false },
);
export type PasswordResetRequest = Static<typeof PasswordResetRequestSchema>;

export const PasswordResetConfirmSchema = Type.Object(
  {
    password: Type.String({ minLength: 8, maxLength: 128 }),
  },
  { additionalProperties: false },
);
export type PasswordResetConfirm = Static<typeof PasswordResetConfirmSchema>;

export const UserMeResponseSchema = Type.Object({
  user: AuthUserSummarySchema,
  memberships: Type.Array(TenantMembershipSummarySchema),
});
export type UserMeResponse = Static<typeof UserMeResponseSchema>;

export const BusinessTypeSchema = Type.Union([
  Type.Literal('RETAIL'),
  Type.Literal('RESTAURANT'),
  Type.Literal('SERVICES'),
  Type.Literal('DISTRIBUTION'),
  Type.Literal('WHOLESALE'),
]);
export type BusinessType = Static<typeof BusinessTypeSchema>;

export const OnboardBusinessRequestSchema = Type.Object(
  {
    businessName: Type.String({ minLength: 2, maxLength: 160 }),
    businessType: BusinessTypeSchema,
    currency: CurrencyCodeSchema,
    firstBranchName: Type.String({ minLength: 2, maxLength: 160 }),
    firstBranchCode: Type.Optional(Type.String({ minLength: 1, maxLength: 32 })),
    timezone: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
    countryCode: Type.Optional(Type.String({ pattern: '^[A-Z]{2}$' })),
  },
  { additionalProperties: false },
);
export type OnboardBusinessRequest = Static<
  typeof OnboardBusinessRequestSchema
>;

export const OnboardBusinessResponseSchema = Type.Object({
  tenant: Type.Object({
    id: UuidSchema,
    slug: Type.String(),
    legalName: Type.String(),
    baseCurrency: CurrencyCodeSchema,
    status: Type.String(),
  }),
  branch: Type.Object({
    id: UuidSchema,
    code: Type.String(),
    name: Type.String(),
  }),
  warehouse: Type.Object({
    id: UuidSchema,
    code: Type.String(),
    name: Type.String(),
  }),
  register: Type.Object({
    id: UuidSchema,
    code: Type.String(),
    name: Type.String(),
  }),
  ownerMembershipId: UuidSchema,
});
export type OnboardBusinessResponse = Static<
  typeof OnboardBusinessResponseSchema
>;

// ============================================================================
// Phase 7.1 HRM & Flexible Payroll Wire Contracts
// ============================================================================

export const EmploymentStatusSchema = Type.Union([
  Type.Literal('ACTIVE'),
  Type.Literal('PROBATION'),
  Type.Literal('INACTIVE'),
  Type.Literal('SUSPENDED'),
  Type.Literal('TERMINATED'),
]);
export type EmploymentStatus = Static<typeof EmploymentStatusSchema>;

export const PayrollFrequencySchema = Type.Union([
  Type.Literal('MONTHLY'),
  Type.Literal('WEEKLY'),
  Type.Literal('DAILY'),
]);
export type PayrollFrequency = Static<typeof PayrollFrequencySchema>;

export const DocumentCategorySchema = Type.Union([
  Type.Literal('NIC_PASSPORT'),
  Type.Literal('CONTRACT'),
  Type.Literal('CERTIFICATE'),
  Type.Literal('RESUME'),
  Type.Literal('OTHER'),
]);
export type DocumentCategory = Static<typeof DocumentCategorySchema>;

export const SalaryPaymentMethodSchema = Type.Union([
  Type.Literal('BANK_TRANSFER'),
  Type.Literal('CASH'),
  Type.Literal('CHEQUE'),
]);
export type SalaryPaymentMethod = Static<typeof SalaryPaymentMethodSchema>;

export const SalaryComponentTypeSchema = Type.Union([
  Type.Literal('EARNING'),
  Type.Literal('DEDUCTION'),
]);
export type SalaryComponentType = Static<typeof SalaryComponentTypeSchema>;

export const SalaryCalculationTypeSchema = Type.Union([
  Type.Literal('FIXED_AMOUNT'),
  Type.Literal('PERCENTAGE_OF_BASIC'),
]);
export type SalaryCalculationType = Static<typeof SalaryCalculationTypeSchema>;

export const PayrollRunStatusSchema = Type.Union([
  Type.Literal('DRAFT'),
  Type.Literal('PENDING_APPROVAL'),
  Type.Literal('APPROVED'),
  Type.Literal('PARTIALLY_PAID'),
  Type.Literal('PAID'),
  Type.Literal('CANCELLED'),
]);
export type PayrollRunStatus = Static<typeof PayrollRunStatusSchema>;

export const PayrollPaymentStatusSchema = Type.Union([
  Type.Literal('UNPAID'),
  Type.Literal('PARTIALLY_PAID'),
  Type.Literal('PAID'),
]);
export type PayrollPaymentStatus = Static<typeof PayrollPaymentStatusSchema>;

export const CreateEmployeeRequestSchema = Type.Object(
  {
    employeeCode: Type.String({ minLength: 1, maxLength: 50 }),
    firstName: Type.String({ minLength: 1, maxLength: 100 }),
    lastName: Type.String({ minLength: 1, maxLength: 100 }),
    displayName: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 200 }), Type.Null()])),
    email: Type.Optional(Type.Union([Type.String({ maxLength: 255 }), Type.Null()])),
    phone: Type.Optional(Type.Union([Type.String({ maxLength: 50 }), Type.Null()])),
    nationalId: Type.Optional(Type.Union([Type.String({ maxLength: 50 }), Type.Null()])),
    gender: Type.Optional(Type.Union([Type.String({ maxLength: 20 }), Type.Null()])),
    dateOfBirth: Type.Optional(Type.Union([Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }), Type.Literal(''), Type.Null()])),
    joinedDate: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }),
    designation: Type.String({ minLength: 1, maxLength: 100 }),
    department: Type.String({ minLength: 1, maxLength: 100 }),
    employmentStatus: Type.Optional(EmploymentStatusSchema),
    payrollFrequency: Type.Optional(PayrollFrequencySchema),
    primaryBranchId: Type.Optional(Type.Union([UuidSchema, Type.Literal(''), Type.Null()])),
    primaryWarehouseId: Type.Optional(Type.Union([UuidSchema, Type.Literal(''), Type.Null()])),
    branchIds: Type.Optional(Type.Union([Type.Array(UuidSchema), Type.Null()])),
    warehouseIds: Type.Optional(Type.Union([Type.Array(UuidSchema), Type.Null()])),
    linkedUserId: Type.Optional(Type.Union([UuidSchema, Type.Literal(''), Type.Null()])),
    avatarUrl: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    bankName: Type.Optional(Type.Union([Type.String({ maxLength: 100 }), Type.Null()])),
    bankAccountNumber: Type.Optional(Type.Union([Type.String({ maxLength: 100 }), Type.Null()])),
    bankBranch: Type.Optional(Type.Union([Type.String({ maxLength: 100 }), Type.Null()])),
    epfNumber: Type.Optional(Type.Union([Type.String({ maxLength: 100 }), Type.Null()])),
    addressLine1: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    addressLine2: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    city: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    district: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    postalCode: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    leavingDate: Type.Optional(Type.Union([Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }), Type.Literal(''), Type.Null()])),
    emergencyContactName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    emergencyContactPhone: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    notes: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  },
  { additionalProperties: false },
);
export type CreateEmployeeRequest = Static<typeof CreateEmployeeRequestSchema>;

export const UpdateEmployeeRequestSchema = Type.Partial(CreateEmployeeRequestSchema);
export type UpdateEmployeeRequest = Static<typeof UpdateEmployeeRequestSchema>;

export const UpdateEmployeeStatusRequestSchema = Type.Object(
  {
    status: EmploymentStatusSchema,
    reason: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
export type UpdateEmployeeStatusRequest = Static<
  typeof UpdateEmployeeStatusRequestSchema
>;

export const LinkEmployeeUserRequestSchema = Type.Object(
  {
    userId: Type.Union([UuidSchema, Type.Null()]),
  },
  { additionalProperties: false },
);
export type LinkEmployeeUserRequest = Static<
  typeof LinkEmployeeUserRequestSchema
>;

export const EmployeeResponseSchema = Type.Object({
  id: UuidSchema,
  tenantId: UuidSchema,
  employeeCode: Type.String(),
  firstName: Type.String(),
  lastName: Type.String(),
  displayName: Type.String(),
  email: Type.Union([Type.String(), Type.Null()]),
  phone: Type.Union([Type.String(), Type.Null()]),
  nationalId: Type.Union([Type.String(), Type.Null()]),
  gender: Type.Union([Type.String(), Type.Null()]),
  dateOfBirth: Type.Union([Type.String(), Type.Null()]),
  joinedDate: Type.String(),
  designation: Type.String(),
  department: Type.String(),
  employmentStatus: EmploymentStatusSchema,
  payrollFrequency: PayrollFrequencySchema,
  primaryBranchId: Type.Union([UuidSchema, Type.Null()]),
  primaryBranchName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  primaryWarehouseId: Type.Union([UuidSchema, Type.Null()]),
  primaryWarehouseName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  branchIds: Type.Array(UuidSchema),
  warehouseIds: Type.Array(UuidSchema),
  linkedUserId: Type.Union([UuidSchema, Type.Null()]),
  linkedUserEmail: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  avatarUrl: Type.Union([Type.String(), Type.Null()]),
  bankName: Type.Union([Type.String(), Type.Null()]),
  bankAccountNumber: Type.Union([Type.String(), Type.Null()]),
  bankBranch: Type.Union([Type.String(), Type.Null()]),
  epfNumber: Type.Union([Type.String(), Type.Null()]),
  addressLine1: Type.Union([Type.String(), Type.Null()]),
  addressLine2: Type.Union([Type.String(), Type.Null()]),
  city: Type.Union([Type.String(), Type.Null()]),
  district: Type.Union([Type.String(), Type.Null()]),
  postalCode: Type.Union([Type.String(), Type.Null()]),
  leavingDate: Type.Union([Type.String(), Type.Null()]),
  emergencyContactName: Type.Union([Type.String(), Type.Null()]),
  emergencyContactPhone: Type.Union([Type.String(), Type.Null()]),
  notes: Type.Union([Type.String(), Type.Null()]),
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
});
export type EmployeeResponse = Static<typeof EmployeeResponseSchema>;

export const EmployeeListResponseSchema = Type.Object({
  items: Type.Array(EmployeeResponseSchema),
  total: Type.Integer({ minimum: 0 }),
});
export type EmployeeListResponse = Static<typeof EmployeeListResponseSchema>;

export const UploadEmployeeDocumentRequestSchema = Type.Object(
  {
    documentCategory: DocumentCategorySchema,
    documentTitle: Type.String({ minLength: 1, maxLength: 200 }),
    fileName: Type.String({ minLength: 1, maxLength: 255 }),
    mimeType: Type.String({ minLength: 3, maxLength: 100 }),
    dataBase64: Type.String({ minLength: 1 }),
    notes: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
export type UploadEmployeeDocumentRequest = Static<
  typeof UploadEmployeeDocumentRequestSchema
>;

export const EmployeeDocumentResponseSchema = Type.Object({
  id: UuidSchema,
  employeeId: UuidSchema,
  documentCategory: DocumentCategorySchema,
  documentTitle: Type.String(),
  fileName: Type.String(),
  fileSize: Type.Integer({ minimum: 1 }),
  mimeType: Type.String(),
  storagePath: Type.String(),
  uploadedByUserId: UuidSchema,
  notes: Type.Union([Type.String(), Type.Null()]),
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
});
export type EmployeeDocumentResponse = Static<
  typeof EmployeeDocumentResponseSchema
>;

export const ProrationRuleSchema = Type.Union([
  Type.Literal('PRORATE'),
  Type.Literal('FULL'),
]);
export type ProrationRule = Static<typeof ProrationRuleSchema>;

export const SalaryComponentInputSchema = Type.Object(
  {
    componentType: SalaryComponentTypeSchema,
    componentName: Type.String({ minLength: 1, maxLength: 100 }),
    calculationType: SalaryCalculationTypeSchema,
    componentValue: DecimalMoneyStringSchema,
    isTaxable: Type.Optional(Type.Boolean()),
    isStatutory: Type.Optional(Type.Boolean()),
    isEnabled: Type.Optional(Type.Boolean()),
    prorationRule: Type.Optional(ProrationRuleSchema),
  },
  { additionalProperties: false },
);
export type SalaryComponentInput = Static<typeof SalaryComponentInputSchema>;

export const SalaryComponentResponseSchema = Type.Object({
  id: UuidSchema,
  structureId: UuidSchema,
  componentType: SalaryComponentTypeSchema,
  componentName: Type.String(),
  calculationType: SalaryCalculationTypeSchema,
  componentValue: DecimalMoneyStringSchema,
  isTaxable: Type.Boolean(),
  isStatutory: Type.Boolean(),
  isEnabled: Type.Boolean(),
  prorationRule: Type.Optional(ProrationRuleSchema),
});
export type SalaryComponentResponse = Static<
  typeof SalaryComponentResponseSchema
>;

export const CreateSalaryStructureRequestSchema = Type.Object(
  {
    effectiveFrom: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }),
    basicSalary: DecimalMoneyStringSchema,
    currencyCode: CurrencyCodeSchema,
    paymentMethod: Type.Optional(SalaryPaymentMethodSchema),
    notes: Type.Optional(Type.String()),
    components: Type.Array(SalaryComponentInputSchema),
  },
  { additionalProperties: false },
);
export type CreateSalaryStructureRequest = Static<
  typeof CreateSalaryStructureRequestSchema
>;

export const SalaryStructureResponseSchema = Type.Object({
  id: UuidSchema,
  employeeId: UuidSchema,
  effectiveFrom: Type.String(),
  basicSalary: DecimalMoneyStringSchema,
  currencyCode: CurrencyCodeSchema,
  paymentMethod: SalaryPaymentMethodSchema,
  isActive: Type.Boolean(),
  notes: Type.Union([Type.String(), Type.Null()]),
  components: Type.Array(SalaryComponentResponseSchema),
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
});
export type SalaryStructureResponse = Static<
  typeof SalaryStructureResponseSchema
>;

export const EmployeeActivityItemSchema = Type.Object({
  id: Type.String(),
  timestamp: IsoTimestampSchema,
  activityType: Type.String(),
  description: Type.String(),
  referenceId: Type.Optional(Type.String()),
  details: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});
export type EmployeeActivityItem = Static<typeof EmployeeActivityItemSchema>;

export const EmployeeProfileResponseSchema = Type.Object({
  employee: EmployeeResponseSchema,
  activeSalaryStructure: Type.Union([SalaryStructureResponseSchema, Type.Null()]),
  documents: Type.Array(EmployeeDocumentResponseSchema),
  recentActivity: Type.Array(EmployeeActivityItemSchema),
});
export type EmployeeProfileResponse = Static<
  typeof EmployeeProfileResponseSchema
>;

export const CreatePayrollRunRequestSchema = Type.Object(
  {
    frequency: PayrollFrequencySchema,
    periodStart: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }),
    periodEnd: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }),
    paymentDate: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }),
    currencyCode: CurrencyCodeSchema,
    notes: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
export type CreatePayrollRunRequest = Static<
  typeof CreatePayrollRunRequestSchema
>;

export const UpdatePayrollItemRequestSchema = Type.Object(
  {
    overtimeHours: Type.Optional(DecimalQuantityStringSchema),
    overtimePay: Type.Optional(DecimalMoneyStringSchema),
    bonusPay: Type.Optional(DecimalMoneyStringSchema),
    commissionsPay: Type.Optional(DecimalMoneyStringSchema),
    notes: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
export type UpdatePayrollItemRequest = Static<
  typeof UpdatePayrollItemRequestSchema
>;

export const PayrollRunItemResponseSchema = Type.Object({
  id: UuidSchema,
  payrollRunId: UuidSchema,
  employeeId: UuidSchema,
  employeeCode: Type.String(),
  employeeName: Type.String(),
  department: Type.String(),
  designation: Type.String(),
  basicSalary: DecimalMoneyStringSchema,
  allowancesTotal: DecimalMoneyStringSchema,
  overtimeHours: DecimalQuantityStringSchema,
  overtimePay: DecimalMoneyStringSchema,
  bonusPay: DecimalMoneyStringSchema,
  commissionsPay: DecimalMoneyStringSchema,
  grossPay: DecimalMoneyStringSchema,
  deductionsTotal: DecimalMoneyStringSchema,
  netPay: DecimalMoneyStringSchema,
  paidAmount: DecimalMoneyStringSchema,
  paymentStatus: PayrollPaymentStatusSchema,
  componentsSnapshot: Type.Array(Type.Any()),
  calculationBreakdown: Type.Optional(Type.Any()),
  notes: Type.Union([Type.String(), Type.Null()]),
});
export type PayrollRunItemResponse = Static<
  typeof PayrollRunItemResponseSchema
>;

export const PayrollRunResponseSchema = Type.Object({
  id: UuidSchema,
  runNumber: Type.String(),
  frequency: PayrollFrequencySchema,
  periodStart: Type.String(),
  periodEnd: Type.String(),
  paymentDate: Type.String(),
  currencyCode: CurrencyCodeSchema,
  status: PayrollRunStatusSchema,
  totalGrossPay: DecimalMoneyStringSchema,
  totalDeductions: DecimalMoneyStringSchema,
  totalNetPay: DecimalMoneyStringSchema,
  totalPaidAmount: DecimalMoneyStringSchema,
  employeeCount: Type.Integer({ minimum: 0 }),
  createdByUserId: UuidSchema,
  approvedByUserId: Type.Union([UuidSchema, Type.Null()]),
  approvedAt: Type.Union([IsoTimestampSchema, Type.Null()]),
  notes: Type.Union([Type.String(), Type.Null()]),
  items: Type.Optional(Type.Array(PayrollRunItemResponseSchema)),
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
});
export type PayrollRunResponse = Static<typeof PayrollRunResponseSchema>;

export const RecordPayrollPaymentRequestSchema = Type.Object(
  {
    itemId: UuidSchema,
    paymentMethod: SalaryPaymentMethodSchema,
    paymentAmount: DecimalMoneyStringSchema,
    currencyCode: CurrencyCodeSchema,
    paymentDate: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }),
    referenceNumber: Type.Optional(Type.String({ maxLength: 100 })),
    notes: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
export type RecordPayrollPaymentRequest = Static<
  typeof RecordPayrollPaymentRequestSchema
>;

export const PayrollPaymentResponseSchema = Type.Object({
  id: UuidSchema,
  payrollRunId: UuidSchema,
  payrollItemId: UuidSchema,
  employeeId: UuidSchema,
  paymentMethod: SalaryPaymentMethodSchema,
  paymentAmount: DecimalMoneyStringSchema,
  currencyCode: CurrencyCodeSchema,
  paymentDate: Type.String(),
  referenceNumber: Type.Union([Type.String(), Type.Null()]),
  recordedByUserId: UuidSchema,
  notes: Type.Union([Type.String(), Type.Null()]),
  createdAt: IsoTimestampSchema,
});
export type PayrollPaymentResponse = Static<
  typeof PayrollPaymentResponseSchema
>;

export const PayslipEarningsBreakdownSchema = Type.Object({
  name: Type.String(),
  amount: DecimalMoneyStringSchema,
  type: Type.String(),
});

export const PayslipDeductionsBreakdownSchema = Type.Object({
  name: Type.String(),
  amount: DecimalMoneyStringSchema,
  type: Type.String(),
});

export const PayslipResponseSchema = Type.Object({
  tenantName: Type.String(),
  runNumber: Type.String(),
  frequency: PayrollFrequencySchema,
  periodStart: Type.String(),
  periodEnd: Type.String(),
  paymentDate: Type.String(),
  currencyCode: CurrencyCodeSchema,
  employee: Type.Object({
    id: UuidSchema,
    employeeCode: Type.String(),
    fullName: Type.String(),
    designation: Type.String(),
    department: Type.String(),
    bankName: Type.Union([Type.String(), Type.Null()]),
    bankAccountNumber: Type.Union([Type.String(), Type.Null()]),
    epfNumber: Type.Union([Type.String(), Type.Null()]),
  }),
  item: PayrollRunItemResponseSchema,
  earningsBreakdown: Type.Array(PayslipEarningsBreakdownSchema),
  deductionsBreakdown: Type.Array(PayslipDeductionsBreakdownSchema),
});
export type PayslipResponse = Static<typeof PayslipResponseSchema>;

export const PayrollReportSummaryResponseSchema = Type.Object({
  totalGross: DecimalMoneyStringSchema,
  totalDeductions: DecimalMoneyStringSchema,
  totalNet: DecimalMoneyStringSchema,
  totalPaid: DecimalMoneyStringSchema,
  totalUnpaid: DecimalMoneyStringSchema,
  runsCount: Type.Integer({ minimum: 0 }),
  employeesPaidCount: Type.Integer({ minimum: 0 }),
  byDepartment: Type.Array(
    Type.Object({
      department: Type.String(),
      employeeCount: Type.Integer({ minimum: 0 }),
      gross: DecimalMoneyStringSchema,
      net: DecimalMoneyStringSchema,
      paid: DecimalMoneyStringSchema,
    }),
  ),
  byFrequency: Type.Array(
    Type.Object({
      frequency: PayrollFrequencySchema,
      runsCount: Type.Integer({ minimum: 0 }),
      gross: DecimalMoneyStringSchema,
      net: DecimalMoneyStringSchema,
      paid: DecimalMoneyStringSchema,
    }),
  ),
});
export type PayrollReportSummaryResponse = Static<
  typeof PayrollReportSummaryResponseSchema
>;

// --- Phase 7.2: Advanced Permissions & Role Management Schemas ---

export const PermissionActionSchema = Type.Union([
  Type.Literal('View'),
  Type.Literal('Create'),
  Type.Literal('Edit'),
  Type.Literal('Delete'),
  Type.Literal('Approve'),
  Type.Literal('Export'),
  Type.Literal('Manage'),
]);
export type PermissionAction = Static<typeof PermissionActionSchema>;

export const PermissionItemSchema = Type.Object({
  key: Type.String(),
  name: Type.String(),
  module: Type.String(),
  action: PermissionActionSchema,
  description: Type.String(),
});
export type PermissionItem = Static<typeof PermissionItemSchema>;

export const ModulePermissionsSchema = Type.Object({
  module: Type.String(),
  permissions: Type.Array(PermissionItemSchema),
});
export type ModulePermissions = Static<typeof ModulePermissionsSchema>;

export const PermissionsCatalogResponseSchema = Type.Object({
  modules: Type.Array(ModulePermissionsSchema),
  allKeys: Type.Array(Type.String()),
});
export type PermissionsCatalogResponse = Static<typeof PermissionsCatalogResponseSchema>;

export const RoleSummaryResponseSchema = Type.Object({
  id: UuidSchema,
  tenantId: UuidSchema,
  code: Type.String(),
  name: Type.String(),
  description: Type.Union([Type.String(), Type.Null()]),
  isSystemRole: Type.Boolean(),
  memberCount: Type.Integer({ minimum: 0 }),
  permissionsCount: Type.Integer({ minimum: 0 }),
  createdAt: Type.String(),
  updatedAt: Type.Optional(Type.String()),
});
export type RoleSummaryResponse = Static<typeof RoleSummaryResponseSchema>;

export const RoleDetailResponseSchema = Type.Object({
  id: UuidSchema,
  tenantId: UuidSchema,
  code: Type.String(),
  name: Type.String(),
  description: Type.Union([Type.String(), Type.Null()]),
  isSystemRole: Type.Boolean(),
  memberCount: Type.Integer({ minimum: 0 }),
  permissions: Type.Array(Type.String()),
  createdAt: Type.String(),
  updatedAt: Type.Optional(Type.String()),
});
export type RoleDetailResponse = Static<typeof RoleDetailResponseSchema>;

export const CreateRoleRequestSchema = Type.Object(
  {
    code: Type.String({ minLength: 2, maxLength: 50, pattern: '^[A-Z0-9_]+$' }),
    name: Type.String({ minLength: 2, maxLength: 100 }),
    description: Type.Optional(Type.Union([Type.String({ maxLength: 255 }), Type.Null()])),
    permissions: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);
export type CreateRoleRequest = Static<typeof CreateRoleRequestSchema>;

export const UpdateRoleRequestSchema = Type.Object(
  {
    name: Type.Optional(Type.String({ minLength: 2, maxLength: 100 })),
    description: Type.Optional(Type.Union([Type.String({ maxLength: 255 }), Type.Null()])),
    permissions: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: false },
);
export type UpdateRoleRequest = Static<typeof UpdateRoleRequestSchema>;

export const MemberRoleAssignmentSummarySchema = Type.Object({
  id: UuidSchema,
  code: Type.String(),
  name: Type.String(),
  isSystemRole: Type.Boolean(),
});
export type MemberRoleAssignmentSummary = Static<typeof MemberRoleAssignmentSummarySchema>;

export const MemberLocationScopeDetailSchema = Type.Object({
  branchIds: Type.Array(UuidSchema),
  warehouseIds: Type.Array(UuidSchema),
});
export type MemberLocationScopeDetail = Static<typeof MemberLocationScopeDetailSchema>;

export const MemberLinkedEmployeeSummarySchema = Type.Object({
  id: UuidSchema,
  employeeCode: Type.String(),
  displayName: Type.String(),
  designation: Type.Optional(Type.String()),
  department: Type.Optional(Type.String()),
});
export type MemberLinkedEmployeeSummary = Static<typeof MemberLinkedEmployeeSummarySchema>;

export const MemberAssignedBranchSummarySchema = Type.Object({
  id: UuidSchema,
  code: Type.String(),
  name: Type.String(),
  isActive: Type.Boolean(),
});

export const MemberSummaryResponseSchema = Type.Object({
  id: UuidSchema,
  tenantId: UuidSchema,
  userId: UuidSchema,
  email: Type.String(),
  fullName: Type.String(),
  status: Type.Union([
    Type.Literal('INVITED'),
    Type.Literal('ACTIVE'),
    Type.Literal('DEACTIVATED'),
    Type.Literal('SUSPENDED'),
    Type.Literal('REVOKED'),
    Type.Literal('DISABLED'),
  ]),
  allLocationsAccess: Type.Boolean(),
  roles: Type.Array(MemberRoleAssignmentSummarySchema),
  locationScopes: MemberLocationScopeDetailSchema,
  assignedBranches: Type.Optional(Type.Array(MemberAssignedBranchSummarySchema)),
  linkedEmployee: Type.Optional(Type.Union([MemberLinkedEmployeeSummarySchema, Type.Null()])),
  suspensionReason: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  createdAt: Type.String(),
});
export type MemberSummaryResponse = Static<typeof MemberSummaryResponseSchema>;

export const AssignMemberRolesRequestSchema = Type.Object(
  {
    roleIds: Type.Array(UuidSchema),
  },
  { additionalProperties: false },
);
export type AssignMemberRolesRequest = Static<typeof AssignMemberRolesRequestSchema>;

export const UpdateMemberLocationScopesRequestSchema = Type.Object(
  {
    allLocationsAccess: Type.Boolean(),
    branchIds: Type.Optional(Type.Array(UuidSchema)),
    warehouseIds: Type.Optional(Type.Array(UuidSchema)),
  },
  { additionalProperties: false },
);
export type UpdateMemberLocationScopesRequest = Static<
  typeof UpdateMemberLocationScopesRequestSchema
>;

export const UpdateMemberStatusRequestSchema = Type.Object(
  {
    status: Type.Union([
      Type.Literal('ACTIVE'),
      Type.Literal('DEACTIVATED'),
      Type.Literal('SUSPENDED'),
      Type.Literal('REVOKED'),
      Type.Literal('DISABLED'),
    ]),
    reason: Type.Optional(Type.String({ minLength: 3, maxLength: 500 })),
  },
  { additionalProperties: false },
);
export type UpdateMemberStatusRequest = Static<typeof UpdateMemberStatusRequestSchema>;

// Phase 7.2 Staff Invitation & Account Provisioning Schemas
export const InviteStaffRequestSchema = Type.Object(
  {
    email: Type.String({
      minLength: 3,
      maxLength: 255,
      pattern: '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$',
    }),
    roleCode: Type.Optional(Type.String({ minLength: 2, maxLength: 50 })),
    employeeId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
    allLocationsAccess: Type.Optional(Type.Boolean()),
    branchIds: Type.Optional(Type.Array(UuidSchema)),
    warehouseIds: Type.Optional(Type.Array(UuidSchema)),
  },
  { additionalProperties: false },
);
export type InviteStaffRequest = Static<typeof InviteStaffRequestSchema>;

export const StaffInvitationResponseSchema = Type.Object({
  id: UuidSchema,
  tenantId: UuidSchema,
  email: Type.String(),
  roleCode: Type.String(),
  employeeId: Type.Union([UuidSchema, Type.Null()]),
  employeeCode: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  employeeName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  allLocationsAccess: Type.Optional(Type.Boolean()),
  branchIds: Type.Optional(Type.Array(UuidSchema)),
  warehouseIds: Type.Optional(Type.Array(UuidSchema)),
  status: Type.Union([
    Type.Literal('PENDING'),
    Type.Literal('ACCEPTED'),
    Type.Literal('EXPIRED'),
    Type.Literal('CANCELLED'),
    Type.Literal('FAILED'),
  ]),
  invitedByUserId: UuidSchema,
  invitedByEmail: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  invitedByName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  acceptedByUserId: Type.Union([UuidSchema, Type.Null()]),
  expiresAt: Type.String(),
  acceptedAt: Type.Union([Type.String(), Type.Null()]),
  cancelledAt: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String(),
  updatedAt: Type.String(),
  invitationCode: Type.Optional(Type.String()),
  token: Type.Optional(Type.String()),
  invitationToken: Type.Optional(Type.String()),
  invitationLink: Type.Optional(Type.String()),
});
export type StaffInvitationResponse = Static<typeof StaffInvitationResponseSchema>;

export const ValidateInvitationResponseSchema = Type.Object({
  valid: Type.Boolean(),
  email: Type.String(),
  maskedEmail: Type.Optional(Type.String()),
  roleCode: Type.String(),
  tenantId: UuidSchema,
  tenantName: Type.String(),
  employeeName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  invitationCode: Type.Optional(Type.String()),
  isExistingUser: Type.Optional(Type.Boolean()),
});
export type ValidateInvitationResponse = Static<typeof ValidateInvitationResponseSchema>;

export const ValidateInvitationCodeRequestSchema = Type.Object(
  {
    code: Type.String({ minLength: 4, maxLength: 8 }),
    email: Type.Optional(Type.String({ pattern: '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$' })),
  },
  { additionalProperties: false },
);
export type ValidateInvitationCodeRequest = Static<typeof ValidateInvitationCodeRequestSchema>;

export const AcceptInvitationRequestSchema = Type.Object(
  {
    code: Type.Optional(Type.String({ minLength: 4, maxLength: 8 })),
    email: Type.Optional(Type.String({ pattern: '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$' })),
    token: Type.Optional(Type.String()),
    password: Type.String({ minLength: 8, maxLength: 128 }),
    fullName: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
  },
  { additionalProperties: false },
);
export type AcceptInvitationRequest = Static<typeof AcceptInvitationRequestSchema>;

// ============================================================================
// Phase 7.1 Complete HRM: Work Schedules, Attendance, Leave, Holidays & Settings
// ============================================================================

// 1. Work Schedules
export const ShiftTypeSchema = Type.Union([
  Type.Literal('DAY'),
  Type.Literal('NIGHT'),
  Type.Literal('ROTATING'),
]);
export type ShiftType = Static<typeof ShiftTypeSchema>;

export const CreateWorkScheduleRequestSchema = Type.Object(
  {
    shiftName: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
    shiftType: Type.Optional(ShiftTypeSchema),
    shiftStartTime: Type.Optional(Type.String({ pattern: '^\\d{2}:\\d{2}(:\\d{2})?$' })),
    shiftEndTime: Type.Optional(Type.String({ pattern: '^\\d{2}:\\d{2}(:\\d{2})?$' })),
    breakDurationMinutes: Type.Optional(Type.Integer({ minimum: 0, maximum: 480 })),
    mondayWorking: Type.Optional(Type.Boolean()),
    isMondayWorking: Type.Optional(Type.Boolean()),
    tuesdayWorking: Type.Optional(Type.Boolean()),
    isTuesdayWorking: Type.Optional(Type.Boolean()),
    wednesdayWorking: Type.Optional(Type.Boolean()),
    isWednesdayWorking: Type.Optional(Type.Boolean()),
    thursdayWorking: Type.Optional(Type.Boolean()),
    isThursdayWorking: Type.Optional(Type.Boolean()),
    fridayWorking: Type.Optional(Type.Boolean()),
    isFridayWorking: Type.Optional(Type.Boolean()),
    saturdayWorking: Type.Optional(Type.Boolean()),
    isSaturdayWorking: Type.Optional(Type.Boolean()),
    sundayWorking: Type.Optional(Type.Boolean()),
    isSundayWorking: Type.Optional(Type.Boolean()),
    effectiveFrom: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }),
    effectiveTo: Type.Optional(Type.Union([Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }), Type.Literal(''), Type.Null()])),
    notes: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  },
  { additionalProperties: false },
);
export type CreateWorkScheduleRequest = Static<typeof CreateWorkScheduleRequestSchema>;

export const WorkScheduleResponseSchema = Type.Object({
  id: UuidSchema,
  tenantId: UuidSchema,
  employeeId: UuidSchema,
  shiftName: Type.String(),
  shiftType: ShiftTypeSchema,
  shiftStartTime: Type.String(),
  shiftEndTime: Type.String(),
  breakDurationMinutes: Type.Integer(),
  mondayWorking: Type.Boolean(),
  isMondayWorking: Type.Boolean(),
  tuesdayWorking: Type.Boolean(),
  isTuesdayWorking: Type.Boolean(),
  wednesdayWorking: Type.Boolean(),
  isWednesdayWorking: Type.Boolean(),
  thursdayWorking: Type.Boolean(),
  isThursdayWorking: Type.Boolean(),
  fridayWorking: Type.Boolean(),
  isFridayWorking: Type.Boolean(),
  saturdayWorking: Type.Boolean(),
  isSaturdayWorking: Type.Boolean(),
  sundayWorking: Type.Boolean(),
  isSundayWorking: Type.Boolean(),
  effectiveFrom: Type.String(),
  effectiveTo: Type.Union([Type.String(), Type.Null()]),
  isActive: Type.Boolean(),
  notes: Type.Union([Type.String(), Type.Null()]),
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
});
export type WorkScheduleResponse = Static<typeof WorkScheduleResponseSchema>;

// 2. Attendance
export const AttendanceStatusSchema = Type.Union([
  Type.Literal('PRESENT'),
  Type.Literal('ABSENT'),
  Type.Literal('LATE'),
  Type.Literal('HALF_DAY'),
  Type.Literal('PAID_LEAVE'),
  Type.Literal('NO_PAY_LEAVE'),
  Type.Literal('WEEKLY_OFF'),
  Type.Literal('PUBLIC_HOLIDAY'),
]);
export type AttendanceStatus = Static<typeof AttendanceStatusSchema>;

export const CheckInRequestSchema = Type.Object(
  {
    latitude: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    longitude: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    notes: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  },
  { additionalProperties: false },
);
export type CheckInRequest = Static<typeof CheckInRequestSchema>;

export const CheckOutRequestSchema = Type.Object(
  {
    latitude: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    longitude: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    notes: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  },
  { additionalProperties: false },
);
export type CheckOutRequest = Static<typeof CheckOutRequestSchema>;

export const RecordManualAttendanceRequestSchema = Type.Object(
  {
    employeeId: UuidSchema,
    attendanceDate: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }),
    checkInTime: Type.Optional(Type.Union([IsoTimestampSchema, Type.Literal(''), Type.Null()])),
    checkOutTime: Type.Optional(Type.Union([IsoTimestampSchema, Type.Literal(''), Type.Null()])),
    status: AttendanceStatusSchema,
    adjustmentReason: Type.String({ minLength: 1, maxLength: 500 }),
    notes: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  },
  { additionalProperties: false },
);
export type RecordManualAttendanceRequest = Static<typeof RecordManualAttendanceRequestSchema>;

export const AttendanceRecordResponseSchema = Type.Object({
  id: UuidSchema,
  tenantId: UuidSchema,
  employeeId: UuidSchema,
  employeeCode: Type.Optional(Type.String()),
  employeeName: Type.Optional(Type.String()),
  attendanceDate: Type.String(),
  checkInTime: Type.Union([IsoTimestampSchema, Type.Null()]),
  checkOutTime: Type.Union([IsoTimestampSchema, Type.Null()]),
  status: AttendanceStatusSchema,
  latitude: Type.Union([Type.Number(), Type.Null()]),
  longitude: Type.Union([Type.Number(), Type.Null()]),
  gpsVerified: Type.Boolean(),
  notes: Type.Union([Type.String(), Type.Null()]),
  isManual: Type.Boolean(),
  isManualEntry: Type.Optional(Type.Boolean()),
  totalHoursWorked: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
  adjustmentReason: Type.Union([Type.String(), Type.Null()]),
  adjustedByUserId: Type.Union([UuidSchema, Type.Null()]),
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
});
export type AttendanceRecordResponse = Static<typeof AttendanceRecordResponseSchema>;

export const AttendanceListResponseSchema = Type.Object({
  items: Type.Array(AttendanceRecordResponseSchema),
  total: Type.Integer({ minimum: 0 }),
});
export type AttendanceListResponse = Static<typeof AttendanceListResponseSchema>;

// 3. Leaves
export const LeaveTypeSchema = Type.Union([
  Type.Literal('ANNUAL'),
  Type.Literal('CASUAL'),
  Type.Literal('SICK'),
  Type.Literal('NO_PAY'),
  Type.Literal('HALF_DAY'),
  Type.Literal('SPECIAL'),
]);
export type LeaveType = Static<typeof LeaveTypeSchema>;

export const LeaveRequestStatusSchema = Type.Union([
  Type.Literal('PENDING'),
  Type.Literal('APPROVED'),
  Type.Literal('REJECTED'),
  Type.Literal('CANCELLED'),
]);
export type LeaveRequestStatus = Static<typeof LeaveRequestStatusSchema>;

export const CreateLeaveRequestSchema = Type.Object(
  {
    employeeId: Type.Optional(UuidSchema),
    leaveType: LeaveTypeSchema,
    startDate: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }),
    endDate: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }),
    daysCount: Type.Number({ minimum: 0.5 }),
    isHalfDay: Type.Optional(Type.Boolean()),
    reason: Type.String({ minLength: 1, maxLength: 500 }),
  },
  { additionalProperties: false },
);
export type CreateLeaveRequest = Static<typeof CreateLeaveRequestSchema>;

export const ReviewLeaveRequestSchema = Type.Object(
  {
    status: Type.Union([Type.Literal('APPROVED'), Type.Literal('REJECTED')]),
    reviewNotes: Type.Optional(Type.Union([Type.String({ maxLength: 500 }), Type.Null()])),
  },
  { additionalProperties: false },
);
export type ReviewLeaveRequest = Static<typeof ReviewLeaveRequestSchema>;

export const LeaveRequestResponseSchema = Type.Object({
  id: UuidSchema,
  tenantId: UuidSchema,
  employeeId: UuidSchema,
  employeeCode: Type.Optional(Type.String()),
  employeeName: Type.Optional(Type.String()),
  leaveType: LeaveTypeSchema,
  startDate: Type.String(),
  endDate: Type.String(),
  daysCount: Type.Number(),
  isHalfDay: Type.Boolean(),
  reason: Type.String(),
  status: LeaveRequestStatusSchema,
  requestedByUserId: Type.Union([UuidSchema, Type.Null()]),
  reviewedByUserId: Type.Union([UuidSchema, Type.Null()]),
  reviewedAt: Type.Union([IsoTimestampSchema, Type.Null()]),
  reviewNotes: Type.Union([Type.String(), Type.Null()]),
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
});
export type LeaveRequestResponse = Static<typeof LeaveRequestResponseSchema>;

export const LeaveRequestListResponseSchema = Type.Object({
  items: Type.Array(LeaveRequestResponseSchema),
  total: Type.Integer({ minimum: 0 }),
});
export type LeaveRequestListResponse = Static<typeof LeaveRequestListResponseSchema>;

export const LeaveBalanceResponseSchema = Type.Object({
  id: UuidSchema,
  tenantId: UuidSchema,
  employeeId: UuidSchema,
  year: Type.Integer(),
  leaveType: LeaveTypeSchema,
  annualEntitlement: Type.Number(),
  usedDays: Type.Number(),
  pendingDays: Type.Number(),
  remainingDays: Type.Number(),
});
export type LeaveBalanceResponse = Static<typeof LeaveBalanceResponseSchema>;

export const LeaveBalanceListResponseSchema = Type.Object({
  items: Type.Array(LeaveBalanceResponseSchema),
});
export type LeaveBalanceListResponse = Static<typeof LeaveBalanceListResponseSchema>;

// 4. Organization Holidays
export const HolidayTypeSchema = Type.Union([
  Type.Literal('PUBLIC'),
  Type.Literal('ORG'),
  Type.Literal('SPECIAL'),
]);
export type HolidayType = Static<typeof HolidayTypeSchema>;

export const CreateOrgHolidayRequestSchema = Type.Object(
  {
    holidayDate: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }),
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
    holidayName: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
    holidayType: Type.Optional(HolidayTypeSchema),
    isRecurring: Type.Optional(Type.Boolean()),
    notes: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  },
  { additionalProperties: false },
);
export type CreateOrgHolidayRequest = Static<typeof CreateOrgHolidayRequestSchema>;

export const OrgHolidayResponseSchema = Type.Object({
  id: UuidSchema,
  tenantId: UuidSchema,
  holidayDate: Type.String(),
  name: Type.String(),
  holidayType: HolidayTypeSchema,
  isRecurring: Type.Boolean(),
  notes: Type.Union([Type.String(), Type.Null()]),
  createdAt: IsoTimestampSchema,
});
export type OrgHolidayResponse = Static<typeof OrgHolidayResponseSchema>;

export const OrgHolidayListResponseSchema = Type.Object({
  items: Type.Array(OrgHolidayResponseSchema),
});
export type OrgHolidayListResponse = Static<typeof OrgHolidayListResponseSchema>;

// 5. Organization Payroll Settings & Proration
export const ProrationMethodSchema = Type.Union([
  Type.Literal('CALENDAR_DAYS'),
  Type.Literal('WORKING_DAYS'),
  Type.Literal('SCHEDULED_WORKING_DAYS'),
  Type.Literal('FIXED_30_DAYS'),
]);
export type ProrationMethod = Static<typeof ProrationMethodSchema>;

export const AllowanceProrationPolicySchema = Type.Union([
  Type.Literal('PRORATE'),
  Type.Literal('FULL'),
  Type.Literal('PRORATE_ALL'),
  Type.Literal('BASIC_ONLY'),
]);
export type AllowanceProrationPolicy = Static<typeof AllowanceProrationPolicySchema>;

export const OrgPayrollSettingsResponseSchema = Type.Object({
  tenantId: UuidSchema,
  prorationMethod: ProrationMethodSchema,
  gpsAttendanceEnabled: Type.Boolean(),
  allowanceProrationPolicy: AllowanceProrationPolicySchema,
  workplaceLatitude: Type.Union([Type.Number(), Type.Null()]),
  workplaceLongitude: Type.Union([Type.Number(), Type.Null()]),
  geofenceRadiusMeters: Type.Integer(),
  updatedAt: IsoTimestampSchema,
});
export type OrgPayrollSettingsResponse = Static<typeof OrgPayrollSettingsResponseSchema>;

export const UpdateOrgPayrollSettingsRequestSchema = Type.Object(
  {
    prorationMethod: Type.Optional(ProrationMethodSchema),
    defaultProrationRule: Type.Optional(Type.String()),
    gpsAttendanceEnabled: Type.Optional(Type.Boolean()),
    allowanceProrationPolicy: Type.Optional(AllowanceProrationPolicySchema),
    overtimeHourlyMultiplier: Type.Optional(Type.Union([Type.String(), Type.Number()])),
    workplaceLatitude: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    workplaceLongitude: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    geofenceRadiusMeters: Type.Optional(Type.Integer({ minimum: 10, maximum: 50000 })),
  },
  { additionalProperties: false },
);
export type UpdateOrgPayrollSettingsRequest = Static<typeof UpdateOrgPayrollSettingsRequestSchema>;

// 6. Pre-Calculation Validation
export const PreCalculationValidationItemSchema = Type.Object({
  type: Type.String(),
  severity: Type.Union([Type.Literal('ERROR'), Type.Literal('WARNING')]),
  employeeId: Type.Optional(UuidSchema),
  employeeCode: Type.Optional(Type.String()),
  employeeName: Type.Optional(Type.String()),
  message: Type.String(),
});
export type PreCalculationValidationItem = Static<typeof PreCalculationValidationItemSchema>;

export const PreCalculationValidationResponseSchema = Type.Object({
  isValid: Type.Boolean(),
  canProceed: Type.Boolean(),
  issues: Type.Array(PreCalculationValidationItemSchema),
});
export type PreCalculationValidationResponse = Static<typeof PreCalculationValidationResponseSchema>;

// ==========================================
// Phase 7.3 — Expenses Management Schemas
// ==========================================

export const ExpenseStatusSchema = Type.Union([
  Type.Literal('DRAFT'),
  Type.Literal('PENDING_APPROVAL'),
  Type.Literal('APPROVED'),
  Type.Literal('REJECTED'),
  Type.Literal('PAID'),
]);
export type ExpenseStatus = Static<typeof ExpenseStatusSchema>;

export const ExpensePaymentMethodSchema = Type.Union([
  Type.Literal('CASH'),
  Type.Literal('BANK_TRANSFER'),
  Type.Literal('CARD'),
  Type.Literal('CHEQUE'),
  Type.Literal('OTHER'),
]);
export type ExpensePaymentMethod = Static<typeof ExpensePaymentMethodSchema>;

// Expense Categories
export const CreateExpenseCategoryRequestSchema = Type.Object(
  {
    code: Type.String({ minLength: 1, maxLength: 50 }),
    name: Type.String({ minLength: 1, maxLength: 100 }),
    description: Type.Optional(Type.Union([Type.String({ maxLength: 500 }), Type.Null()])),
  },
  { additionalProperties: false },
);
export type CreateExpenseCategoryRequest = Static<typeof CreateExpenseCategoryRequestSchema>;

export const UpdateExpenseCategoryRequestSchema = Type.Object(
  {
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
    description: Type.Optional(Type.Union([Type.String({ maxLength: 500 }), Type.Null()])),
    isActive: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type UpdateExpenseCategoryRequest = Static<typeof UpdateExpenseCategoryRequestSchema>;

export const ExpenseCategoryResponseSchema = Type.Object({
  id: UuidSchema,
  tenantId: UuidSchema,
  code: Type.String(),
  name: Type.String(),
  description: Type.Union([Type.String(), Type.Null()]),
  isActive: Type.Boolean(),
  isSystemDefault: Type.Boolean(),
  expenseCount: Type.Optional(Type.Number()),
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
});
export type ExpenseCategoryResponse = Static<typeof ExpenseCategoryResponseSchema>;

export const ExpenseCategoryListResponseSchema = Type.Object({
  items: Type.Array(ExpenseCategoryResponseSchema),
});
export type ExpenseCategoryListResponse = Static<typeof ExpenseCategoryListResponseSchema>;

// Expense Records
export const CreateExpenseRequestSchema = Type.Object(
  {
    title: Type.String({ minLength: 1, maxLength: 200 }),
    description: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    categoryId: UuidSchema,
    amount: DecimalMoneyStringSchema,
    currencyCode: CurrencyCodeSchema,
    expenseDate: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }),
    vendorPayee: Type.Optional(Type.Union([Type.String({ maxLength: 200 }), Type.Null()])),
    paymentMethod: Type.Optional(Type.Union([ExpensePaymentMethodSchema, Type.Null()])),
    branchId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
    notes: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  },
  { additionalProperties: false },
);
export type CreateExpenseRequest = Static<typeof CreateExpenseRequestSchema>;

export const UpdateExpenseRequestSchema = Type.Object(
  {
    title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    description: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    categoryId: Type.Optional(UuidSchema),
    amount: Type.Optional(DecimalMoneyStringSchema),
    currencyCode: Type.Optional(CurrencyCodeSchema),
    expenseDate: Type.Optional(Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' })),
    vendorPayee: Type.Optional(Type.Union([Type.String({ maxLength: 200 }), Type.Null()])),
    paymentMethod: Type.Optional(Type.Union([ExpensePaymentMethodSchema, Type.Null()])),
    branchId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
    notes: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  },
  { additionalProperties: false },
);
export type UpdateExpenseRequest = Static<typeof UpdateExpenseRequestSchema>;

export const SubmitExpenseRequestSchema = Type.Object(
  {
    notes: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  },
  { additionalProperties: false },
);
export type SubmitExpenseRequest = Static<typeof SubmitExpenseRequestSchema>;

export const ApproveExpenseRequestSchema = Type.Object(
  {
    notes: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  },
  { additionalProperties: false },
);
export type ApproveExpenseRequest = Static<typeof ApproveExpenseRequestSchema>;

export const RejectExpenseRequestSchema = Type.Object(
  {
    rejectionReason: Type.String({ minLength: 3, maxLength: 500 }),
  },
  { additionalProperties: false },
);
export type RejectExpenseRequest = Static<typeof RejectExpenseRequestSchema>;

export const RecordExpensePaymentRequestSchema = Type.Object(
  {
    paymentDate: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }),
    paymentMethod: ExpensePaymentMethodSchema,
    paymentReference: Type.Optional(Type.Union([Type.String({ maxLength: 100 }), Type.Null()])),
    notes: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  },
  { additionalProperties: false },
);
export type RecordExpensePaymentRequest = Static<typeof RecordExpensePaymentRequestSchema>;

// Expense Attachments
export const ExpenseAttachmentResponseSchema = Type.Object({
  id: UuidSchema,
  tenantId: UuidSchema,
  expenseId: UuidSchema,
  fileName: Type.String(),
  fileSizeBytes: Type.Integer(),
  mimeType: Type.String(),
  uploadedByUserId: Type.Union([UuidSchema, Type.Null()]),
  createdAt: IsoTimestampSchema,
});
export type ExpenseAttachmentResponse = Static<typeof ExpenseAttachmentResponseSchema>;

export const ExpenseAttachmentListResponseSchema = Type.Object({
  items: Type.Array(ExpenseAttachmentResponseSchema),
});
export type ExpenseAttachmentListResponse = Static<typeof ExpenseAttachmentListResponseSchema>;

export const UploadExpenseAttachmentRequestSchema = Type.Object(
  {
    fileName: Type.String({ minLength: 1, maxLength: 255 }),
    mimeType: Type.String({ pattern: '^(image\\/(png|jpeg|webp)|application\\/pdf)$' }),
    dataBase64: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);
export type UploadExpenseAttachmentRequest = Static<typeof UploadExpenseAttachmentRequestSchema>;

// Expense Entity Responses & Summaries
export const ExpenseResponseSchema = Type.Object({
  id: UuidSchema,
  tenantId: UuidSchema,
  referenceNumber: Type.String(),
  title: Type.String(),
  description: Type.Union([Type.String(), Type.Null()]),
  categoryId: UuidSchema,
  categoryName: Type.Optional(Type.String()),
  categoryCode: Type.Optional(Type.String()),
  amount: DecimalMoneyStringSchema,
  currencyCode: CurrencyCodeSchema,
  expenseDate: Type.String(),
  vendorPayee: Type.Union([Type.String(), Type.Null()]),
  paymentMethod: Type.Union([ExpensePaymentMethodSchema, Type.Null()]),
  branchId: Type.Union([UuidSchema, Type.Null()]),
  branchName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  status: ExpenseStatusSchema,
  rejectionReason: Type.Union([Type.String(), Type.Null()]),
  approvedByUserId: Type.Union([UuidSchema, Type.Null()]),
  approvedAt: Type.Union([IsoTimestampSchema, Type.Null()]),
  paidAt: Type.Union([IsoTimestampSchema, Type.Null()]),
  paymentReference: Type.Union([Type.String(), Type.Null()]),
  createdByUserId: Type.Union([UuidSchema, Type.Null()]),
  createdByName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  notes: Type.Union([Type.String(), Type.Null()]),
  attachmentCount: Type.Optional(Type.Number()),
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
});
export type ExpenseResponse = Static<typeof ExpenseResponseSchema>;

export const ExpenseListResponseSchema = Type.Object({
  items: Type.Array(ExpenseResponseSchema),
  total: Type.Integer(),
});
export type ExpenseListResponse = Static<typeof ExpenseListResponseSchema>;

export const ExpenseSummaryByCategorySchema = Type.Object({
  categoryId: UuidSchema,
  categoryName: Type.String(),
  categoryCode: Type.String(),
  totalAmount: DecimalMoneyStringSchema,
  count: Type.Integer(),
});
export type ExpenseSummaryByCategory = Static<typeof ExpenseSummaryByCategorySchema>;

export const ExpenseSummaryByBranchSchema = Type.Object({
  branchId: Type.Union([UuidSchema, Type.Null()]),
  branchName: Type.Union([Type.String(), Type.Null()]),
  totalAmount: DecimalMoneyStringSchema,
  count: Type.Integer(),
});
export type ExpenseSummaryByBranch = Static<typeof ExpenseSummaryByBranchSchema>;

export const ExpenseSummaryByStatusSchema = Type.Object({
  status: ExpenseStatusSchema,
  totalAmount: DecimalMoneyStringSchema,
  count: Type.Integer(),
});
export type ExpenseSummaryByStatus = Static<typeof ExpenseSummaryByStatusSchema>;

export const ExpenseSummaryReportResponseSchema = Type.Object({
  totalExpenses: DecimalMoneyStringSchema,
  totalCount: Type.Integer(),
  pendingApprovalAmount: DecimalMoneyStringSchema,
  pendingApprovalCount: Type.Integer(),
  approvedUnpaidAmount: DecimalMoneyStringSchema,
  approvedUnpaidCount: Type.Integer(),
  paidAmount: DecimalMoneyStringSchema,
  paidCount: Type.Integer(),
  byCategory: Type.Array(ExpenseSummaryByCategorySchema),
  byBranch: Type.Array(ExpenseSummaryByBranchSchema),
  byStatus: Type.Array(ExpenseSummaryByStatusSchema),
});
export type ExpenseSummaryReportResponse = Static<typeof ExpenseSummaryReportResponseSchema>;

// ============================================================================
// PHASE 7.4 CUSTOMER CREDIT MANAGEMENT SYSTEM CONTRACTS
// ============================================================================

export const CustomerStatusSchema = Type.Union([
  Type.Literal('ACTIVE'),
  Type.Literal('INACTIVE'),
  Type.Literal('ARCHIVED'),
]);
export type CustomerStatus = Static<typeof CustomerStatusSchema>;

export const CustomerResponseSchema = Type.Object({
  id: UuidSchema,
  customerNumber: Type.String(),
  name: Type.String(),
  email: Type.Union([Type.String(), Type.Null()]),
  phone: Type.Union([Type.String(), Type.Null()]),
  address: Type.Union([Type.String(), Type.Null()]),
  taxId: Type.Union([Type.String(), Type.Null()]),
  notes: Type.Union([Type.String(), Type.Null()]),
  status: CustomerStatusSchema,
  creditAccountId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
  creditAccountNumber: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  creditLimit: Type.Optional(DecimalMoneyStringSchema),
  currentBalance: Type.Optional(DecimalMoneyStringSchema),
  availableCredit: Type.Optional(DecimalMoneyStringSchema),
  creditStatus: Type.Optional(Type.String()),
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
});
export type CustomerResponse = Static<typeof CustomerResponseSchema>;

export const CreateCustomerRequestSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 255 }),
    email: Type.Optional(Type.Union([Type.String({ maxLength: 255 }), Type.Null()])),
    phone: Type.Optional(Type.Union([Type.String({ maxLength: 50 }), Type.Null()])),
    address: Type.Optional(Type.Union([Type.String({ maxLength: 500 }), Type.Null()])),
    addressLine1: Type.Optional(Type.Union([Type.String({ maxLength: 255 }), Type.Null()])),
    addressCity: Type.Optional(Type.Union([Type.String({ maxLength: 100 }), Type.Null()])),
    addressPostalCode: Type.Optional(Type.Union([Type.String({ maxLength: 20 }), Type.Null()])),
    companyName: Type.Optional(Type.Union([Type.String({ maxLength: 255 }), Type.Null()])),
    taxId: Type.Optional(Type.Union([Type.String({ maxLength: 100 }), Type.Null()])),
    notes: Type.Optional(Type.Union([Type.String({ maxLength: 1000 }), Type.Null()])),
    status: Type.Optional(CustomerStatusSchema),
    isActive: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type CreateCustomerRequest = Static<typeof CreateCustomerRequestSchema>;

export const UpdateCustomerRequestSchema = Type.Object(
  {
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
    email: Type.Optional(Type.Union([Type.String({ maxLength: 255 }), Type.Null()])),
    phone: Type.Optional(Type.Union([Type.String({ maxLength: 50 }), Type.Null()])),
    address: Type.Optional(Type.Union([Type.String({ maxLength: 500 }), Type.Null()])),
    addressLine1: Type.Optional(Type.Union([Type.String({ maxLength: 255 }), Type.Null()])),
    addressCity: Type.Optional(Type.Union([Type.String({ maxLength: 100 }), Type.Null()])),
    addressPostalCode: Type.Optional(Type.Union([Type.String({ maxLength: 20 }), Type.Null()])),
    companyName: Type.Optional(Type.Union([Type.String({ maxLength: 255 }), Type.Null()])),
    taxId: Type.Optional(Type.Union([Type.String({ maxLength: 100 }), Type.Null()])),
    notes: Type.Optional(Type.Union([Type.String({ maxLength: 1000 }), Type.Null()])),
    status: Type.Optional(CustomerStatusSchema),
    isActive: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type UpdateCustomerRequest = Static<typeof UpdateCustomerRequestSchema>;

export const ListCustomersQuerySchema = Type.Object({
  search: Type.Optional(Type.String()),
  status: Type.Optional(CustomerStatusSchema),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 50 })),
  offset: Type.Optional(Type.Integer({ minimum: 0, default: 0 })),
});
export type ListCustomersQuery = Static<typeof ListCustomersQuerySchema>;

export const CustomerListResponseSchema = Type.Object({
  items: Type.Array(CustomerResponseSchema),
  total: Type.Integer(),
});
export type CustomerListResponse = Static<typeof CustomerListResponseSchema>;

// Credit Enums
export const CreditTermsSchema = Type.Union([
  Type.Literal('IMMEDIATE'),
  Type.Literal('NET_7'),
  Type.Literal('NET_14'),
  Type.Literal('NET_30'),
  Type.Literal('NET_60'),
  Type.Literal('NET_90'),
  Type.Literal('CUSTOM'),
]);
export type CreditTerms = Static<typeof CreditTermsSchema>;

export const CreditAccountStatusSchema = Type.Union([
  Type.Literal('ACTIVE'),
  Type.Literal('ON_HOLD'),
  Type.Literal('SUSPENDED'),
  Type.Literal('BLOCKED'),
  Type.Literal('CLOSED'),
]);
export type CreditAccountStatus = Static<typeof CreditAccountStatusSchema>;

export const CreditRiskClassificationSchema = Type.Union([
  Type.Literal('LOW_RISK'),
  Type.Literal('MEDIUM_RISK'),
  Type.Literal('HIGH_RISK'),
  Type.Literal('CRITICAL_RISK'),
]);
export type CreditRiskClassification = Static<typeof CreditRiskClassificationSchema>;

export const CreditTransactionTypeSchema = Type.Union([
  Type.Literal('OPENING_BALANCE'),
  Type.Literal('CREDIT_SALE'),
  Type.Literal('PAYMENT'),
  Type.Literal('SALES_RETURN'),
  Type.Literal('CREDIT_NOTE'),
  Type.Literal('DEBIT_NOTE'),
  Type.Literal('INTEREST_CHARGE'),
  Type.Literal('LATE_FEE'),
  Type.Literal('ADJUSTMENT_DEBIT'),
  Type.Literal('ADJUSTMENT_CREDIT'),
  Type.Literal('PAYMENT_REVERSAL'),
  Type.Literal('CREDIT_REVERSAL'),
  Type.Literal('WRITE_OFF'),
  Type.Literal('ADVANCE_PAYMENT'),
]);
export type CreditTransactionType = Static<typeof CreditTransactionTypeSchema>;

export const CreditPaymentMethodSchema = Type.Union([
  Type.Literal('CASH'),
  Type.Literal('BANK_TRANSFER'),
  Type.Literal('CARD'),
  Type.Literal('CHEQUE'),
  Type.Literal('OTHER'),
]);
export type CreditPaymentMethod = Static<typeof CreditPaymentMethodSchema>;

// Customer Credit Account Contracts
export const CreateCustomerCreditAccountRequestSchema = Type.Object(
  {
    customerId: UuidSchema,
    creditLimit: Type.Optional(DecimalMoneyStringSchema),
    creditTerms: Type.Optional(CreditTermsSchema),
    customTermDays: Type.Optional(Type.Integer({ minimum: 0, maximum: 365 })),
    branchId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
    openingBalance: Type.Optional(DecimalMoneyStringSchema),
  },
  { additionalProperties: false },
);
export type CreateCustomerCreditAccountRequest = Static<typeof CreateCustomerCreditAccountRequestSchema>;

export const CustomerCreditAccountResponseSchema = Type.Object({
  id: UuidSchema,
  customerId: UuidSchema,
  customerNumber: Type.String(),
  customerName: Type.String(),
  accountNumber: Type.String(),
  creditLimit: DecimalMoneyStringSchema,
  currentBalance: DecimalMoneyStringSchema,
  availableCredit: DecimalMoneyStringSchema,
  totalCreditSales: DecimalMoneyStringSchema,
  totalPayments: DecimalMoneyStringSchema,
  totalInterestCharged: DecimalMoneyStringSchema,
  totalLateFees: DecimalMoneyStringSchema,
  totalWrittenOff: DecimalMoneyStringSchema,
  unallocatedPaymentBalance: DecimalMoneyStringSchema,
  creditTerms: CreditTermsSchema,
  customTermDays: Type.Union([Type.Integer(), Type.Null()]),
  status: CreditAccountStatusSchema,
  holdReason: Type.Union([Type.String(), Type.Null()]),
  heldAt: Type.Union([IsoTimestampSchema, Type.Null()]),
  riskClassification: CreditRiskClassificationSchema,
  branchId: Type.Union([UuidSchema, Type.Null()]),
  branchName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  currencyCode: Type.String(),
  openedAt: IsoTimestampSchema,
  closedAt: Type.Union([IsoTimestampSchema, Type.Null()]),
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
});
export type CustomerCreditAccountResponse = Static<typeof CustomerCreditAccountResponseSchema>;

export const ListCreditAccountsQuerySchema = Type.Object({
  customerId: Type.Optional(UuidSchema),
  search: Type.Optional(Type.String()),
  status: Type.Optional(CreditAccountStatusSchema),
  risk: Type.Optional(CreditRiskClassificationSchema),
  branchId: Type.Optional(UuidSchema),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 50 })),
  offset: Type.Optional(Type.Integer({ minimum: 0, default: 0 })),
});
export type ListCreditAccountsQuery = Static<typeof ListCreditAccountsQuerySchema>;

export const CustomerCreditAccountListResponseSchema = Type.Object({
  items: Type.Array(CustomerCreditAccountResponseSchema),
  total: Type.Integer(),
});
export type CustomerCreditAccountListResponse = Static<typeof CustomerCreditAccountListResponseSchema>;

export const UpdateCreditAccountStatusRequestSchema = Type.Object(
  {
    status: CreditAccountStatusSchema,
    reason: Type.Optional(Type.String({ minLength: 3, maxLength: 500 })),
  },
  { additionalProperties: false },
);
export type UpdateCreditAccountStatusRequest = Static<typeof UpdateCreditAccountStatusRequestSchema>;

export const ManageCreditLimitRequestSchema = Type.Object(
  {
    newLimit: DecimalMoneyStringSchema,
    changeType: Type.Union([
      Type.Literal('INCREASE'),
      Type.Literal('DECREASE'),
      Type.Literal('TEMPORARY_OVERRIDE'),
      Type.Literal('RESTORE'),
    ]),
    reason: Type.String({ minLength: 3, maxLength: 500 }),
    expiryDate: Type.Optional(Type.Union([Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }), Type.Null()])),
  },
  { additionalProperties: false },
);
export type ManageCreditLimitRequest = Static<typeof ManageCreditLimitRequestSchema>;

export const CreditLimitHistoryResponseSchema = Type.Object({
  id: UuidSchema,
  accountId: UuidSchema,
  previousLimit: DecimalMoneyStringSchema,
  newLimit: DecimalMoneyStringSchema,
  changeType: Type.String(),
  reason: Type.String(),
  effectiveDate: Type.String(),
  expiryDate: Type.Union([Type.String(), Type.Null()]),
  requestedByUserId: UuidSchema,
  requestedByName: Type.Optional(Type.String()),
  approvedByUserId: Type.Union([UuidSchema, Type.Null()]),
  approvedByName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  approvalStatus: Type.String(),
  createdAt: IsoTimestampSchema,
});
export type CreditLimitHistoryResponse = Static<typeof CreditLimitHistoryResponseSchema>;

// Ledger & Transaction Contracts
export const CustomerCreditTransactionResponseSchema = Type.Object({
  id: UuidSchema,
  accountId: UuidSchema,
  customerId: UuidSchema,
  customerName: Type.Optional(Type.String()),
  branchId: Type.Union([UuidSchema, Type.Null()]),
  transactionReference: Type.String(),
  transactionType: CreditTransactionTypeSchema,
  entryDirection: Type.Union([Type.Literal('DEBIT'), Type.Literal('CREDIT')]),
  amount: DecimalMoneyStringSchema,
  currencyCode: Type.String(),
  balanceAfter: DecimalMoneyStringSchema,
  unpaidAmount: DecimalMoneyStringSchema,
  transactionDate: Type.String(),
  postingDate: IsoTimestampSchema,
  dueDate: Type.Union([Type.String(), Type.Null()]),
  sourceReferenceType: Type.String(),
  sourceReferenceId: Type.Union([UuidSchema, Type.Null()]),
  sourceReferenceNumber: Type.Union([Type.String(), Type.Null()]),
  description: Type.String(),
  isReversed: Type.Boolean(),
  reversedAt: Type.Union([IsoTimestampSchema, Type.Null()]),
  createdAt: IsoTimestampSchema,
});
export type CustomerCreditTransactionResponse = Static<typeof CustomerCreditTransactionResponseSchema>;

export const ListCreditTransactionsQuerySchema = Type.Object({
  accountId: Type.Optional(UuidSchema),
  customerId: Type.Optional(UuidSchema),
  transactionType: Type.Optional(CreditTransactionTypeSchema),
  startDate: Type.Optional(Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' })),
  endDate: Type.Optional(Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 50 })),
  offset: Type.Optional(Type.Integer({ minimum: 0, default: 0 })),
});
export type ListCreditTransactionsQuery = Static<typeof ListCreditTransactionsQuerySchema>;

export const CustomerCreditTransactionListResponseSchema = Type.Object({
  items: Type.Array(CustomerCreditTransactionResponseSchema),
  total: Type.Integer(),
});
export type CustomerCreditTransactionListResponse = Static<typeof CustomerCreditTransactionListResponseSchema>;

export const CreateManualCreditTransactionRequestSchema = Type.Object(
  {
    accountId: UuidSchema,
    transactionType: Type.Union([
      Type.Literal('OPENING_BALANCE'),
      Type.Literal('DEBIT_NOTE'),
      Type.Literal('CREDIT_NOTE'),
      Type.Literal('ADJUSTMENT_DEBIT'),
      Type.Literal('ADJUSTMENT_CREDIT'),
    ]),
    amount: DecimalMoneyStringSchema,
    description: Type.String({ minLength: 3, maxLength: 500 }),
    sourceReferenceType: Type.Optional(Type.String({ maxLength: 50 })),
    sourceReferenceNumber: Type.Optional(Type.String({ maxLength: 100 })),
    dueDate: Type.Optional(Type.Union([Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }), Type.Null()])),
  },
  { additionalProperties: false },
);
export type CreateManualCreditTransactionRequest = Static<typeof CreateManualCreditTransactionRequestSchema>;

// Payment & Allocation Contracts
export const PaymentAllocationInputSchema = Type.Object(
  {
    transactionId: UuidSchema,
    amount: DecimalMoneyStringSchema,
  },
  { additionalProperties: false },
);
export type PaymentAllocationInput = Static<typeof PaymentAllocationInputSchema>;

export const RecordCustomerCreditPaymentRequestSchema = Type.Object(
  {
    accountId: UuidSchema,
    amount: DecimalMoneyStringSchema,
    paymentMethod: CreditPaymentMethodSchema,
    paymentDate: Type.Optional(Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' })),
    paymentReference: Type.Optional(Type.Union([Type.String({ maxLength: 100 }), Type.Null()])),
    externalReference: Type.Optional(Type.Union([Type.String({ maxLength: 100 }), Type.Null()])),
    branchId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
    notes: Type.Optional(Type.Union([Type.String({ maxLength: 500 }), Type.Null()])),
    allocations: Type.Optional(Type.Array(PaymentAllocationInputSchema)),
  },
  { additionalProperties: false },
);
export type RecordCustomerCreditPaymentRequest = Static<typeof RecordCustomerCreditPaymentRequestSchema>;

export const CustomerCreditPaymentResponseSchema = Type.Object({
  id: UuidSchema,
  accountId: UuidSchema,
  customerId: UuidSchema,
  customerName: Type.Optional(Type.String()),
  paymentReference: Type.String(),
  receiptNumber: Type.String(),
  amount: DecimalMoneyStringSchema,
  allocatedAmount: DecimalMoneyStringSchema,
  unallocatedAmount: DecimalMoneyStringSchema,
  currencyCode: Type.String(),
  paymentDate: Type.String(),
  paymentMethod: CreditPaymentMethodSchema,
  externalReference: Type.Union([Type.String(), Type.Null()]),
  branchId: Type.Union([UuidSchema, Type.Null()]),
  status: Type.Union([Type.Literal('COMPLETED'), Type.Literal('REVERSED')]),
  reversalReason: Type.Union([Type.String(), Type.Null()]),
  reversedAt: Type.Union([IsoTimestampSchema, Type.Null()]),
  notes: Type.Union([Type.String(), Type.Null()]),
  allocations: Type.Optional(
    Type.Array(
      Type.Object({
        transactionId: UuidSchema,
        transactionReference: Type.String(),
        transactionDate: Type.String(),
        allocatedAmount: DecimalMoneyStringSchema,
      }),
    ),
  ),
  createdAt: IsoTimestampSchema,
});
export type CustomerCreditPaymentResponse = Static<typeof CustomerCreditPaymentResponseSchema>;

export const ListCreditPaymentsQuerySchema = Type.Object({
  accountId: Type.Optional(UuidSchema),
  customerId: Type.Optional(UuidSchema),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 50 })),
  offset: Type.Optional(Type.Integer({ minimum: 0, default: 0 })),
});
export type ListCreditPaymentsQuery = Static<typeof ListCreditPaymentsQuerySchema>;

export const CustomerCreditPaymentListResponseSchema = Type.Object({
  items: Type.Array(CustomerCreditPaymentResponseSchema),
  total: Type.Integer(),
});
export type CustomerCreditPaymentListResponse = Static<typeof CustomerCreditPaymentListResponseSchema>;

export const ReverseCustomerCreditPaymentRequestSchema = Type.Object(
  {
    reason: Type.String({ minLength: 3, maxLength: 500 }),
  },
  { additionalProperties: false },
);
export type ReverseCustomerCreditPaymentRequest = Static<typeof ReverseCustomerCreditPaymentRequestSchema>;

export const AllocateUnappliedPaymentRequestSchema = Type.Object(
  {
    paymentId: UuidSchema,
    allocations: Type.Array(PaymentAllocationInputSchema, { minItems: 1 }),
  },
  { additionalProperties: false },
);
export type AllocateUnappliedPaymentRequest = Static<typeof AllocateUnappliedPaymentRequestSchema>;

export const PaymentReceiptResponseSchema = Type.Object({
  receiptNumber: Type.String(),
  paymentReference: Type.String(),
  externalReference: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  paymentDate: Type.String(),
  customerName: Type.String(),
  customerNumber: Type.String(),
  accountNumber: Type.String(),
  paymentMethod: CreditPaymentMethodSchema,
  amount: DecimalMoneyStringSchema,
  allocatedAmount: DecimalMoneyStringSchema,
  unallocatedAmount: DecimalMoneyStringSchema,
  currentBalance: DecimalMoneyStringSchema,
  availableCredit: DecimalMoneyStringSchema,
  receivedByName: Type.String(),
  notes: Type.Union([Type.String(), Type.Null()]),
  allocations: Type.Array(
    Type.Object({
      transactionReference: Type.String(),
      transactionDate: Type.String(),
      allocatedAmount: DecimalMoneyStringSchema,
    }),
  ),
});
export type PaymentReceiptResponse = Static<typeof PaymentReceiptResponseSchema>;

// Credit Settings Contracts
export const CustomerCreditSettingsResponseSchema = Type.Object({
  id: UuidSchema,
  defaultCreditLimit: DecimalMoneyStringSchema,
  defaultCreditTerms: CreditTermsSchema,
  defaultCustomDays: Type.Union([Type.Integer(), Type.Null()]),
  approvalPolicy: Type.Union([
    Type.Literal('AUTO_WITHIN_LIMIT'),
    Type.Literal('ALWAYS_REQUIRE_APPROVAL'),
    Type.Literal('THRESHOLD_REQUIRED'),
    Type.Literal('OVERRIDE_ONLY'),
  ]),
  approvalThresholdAmount: DecimalMoneyStringSchema,
  requireApprovalForOverrides: Type.Boolean(),
  requireApprovalForAdjustments: Type.Boolean(),
  interestEnabled: Type.Boolean(),
  interestCalculationMode: Type.Union([
    Type.Literal('DAILY'),
    Type.Literal('MONTHLY'),
    Type.Literal('ANNUAL'),
    Type.Literal('FIXED'),
  ]),
  interestRatePercentage: Type.String(),
  interestGracePeriodDays: Type.Integer(),
  compoundingEnabled: Type.Boolean(),
  lateFeeEnabled: Type.Boolean(),
  lateFeeType: Type.Union([
    Type.Literal('FIXED'),
    Type.Literal('PERCENTAGE'),
    Type.Literal('PER_DAY'),
  ]),
  lateFeeAmount: DecimalMoneyStringSchema,
  lateFeePercentage: Type.String(),
  lateFeeGracePeriodDays: Type.Integer(),
  lateFeeMaxAmount: DecimalMoneyStringSchema,
  autoHoldEnabled: Type.Boolean(),
  autoHoldMaxOverdueDays: Type.Integer(),
  autoHoldMaxOverdueAmount: DecimalMoneyStringSchema,
  autoHoldUtilizationThreshold: Type.String(),
  currencyCode: Type.String(),
  updatedAt: IsoTimestampSchema,
});
export type CustomerCreditSettingsResponse = Static<typeof CustomerCreditSettingsResponseSchema>;

export const UpdateCustomerCreditSettingsRequestSchema = Type.Object(
  {
    defaultCreditLimit: Type.Optional(DecimalMoneyStringSchema),
    defaultCreditTerms: Type.Optional(CreditTermsSchema),
    defaultCustomDays: Type.Optional(Type.Union([Type.Integer({ minimum: 0, maximum: 365 }), Type.Null()])),
    approvalPolicy: Type.Optional(
      Type.Union([
        Type.Literal('AUTO_WITHIN_LIMIT'),
        Type.Literal('ALWAYS_REQUIRE_APPROVAL'),
        Type.Literal('THRESHOLD_REQUIRED'),
        Type.Literal('OVERRIDE_ONLY'),
      ]),
    ),
    approvalThresholdAmount: Type.Optional(DecimalMoneyStringSchema),
    requireApprovalForOverrides: Type.Optional(Type.Boolean()),
    requireApprovalForAdjustments: Type.Optional(Type.Boolean()),
    interestEnabled: Type.Optional(Type.Boolean()),
    interestCalculationMode: Type.Optional(
      Type.Union([
        Type.Literal('DAILY'),
        Type.Literal('MONTHLY'),
        Type.Literal('ANNUAL'),
        Type.Literal('FIXED'),
      ]),
    ),
    interestRatePercentage: Type.Optional(Type.String()),
    interestGracePeriodDays: Type.Optional(Type.Integer({ minimum: 0, maximum: 90 })),
    compoundingEnabled: Type.Optional(Type.Boolean()),
    lateFeeEnabled: Type.Optional(Type.Boolean()),
    lateFeeType: Type.Optional(
      Type.Union([
        Type.Literal('FIXED'),
        Type.Literal('PERCENTAGE'),
        Type.Literal('PER_DAY'),
      ]),
    ),
    lateFeeAmount: Type.Optional(DecimalMoneyStringSchema),
    lateFeePercentage: Type.Optional(Type.String()),
    lateFeeGracePeriodDays: Type.Optional(Type.Integer({ minimum: 0, maximum: 90 })),
    lateFeeMaxAmount: Type.Optional(DecimalMoneyStringSchema),
    autoHoldEnabled: Type.Optional(Type.Boolean()),
    autoHoldMaxOverdueDays: Type.Optional(Type.Integer({ minimum: 0, maximum: 365 })),
    autoHoldMaxOverdueAmount: Type.Optional(DecimalMoneyStringSchema),
    autoHoldUtilizationThreshold: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
export type UpdateCustomerCreditSettingsRequest = Static<typeof UpdateCustomerCreditSettingsRequestSchema>;

// Collections & Follow-up Contracts
export const RecordCollectionFollowUpRequestSchema = Type.Object(
  {
    accountId: UuidSchema,
    followUpDate: Type.Optional(Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' })),
    contactMethod: Type.Union([
      Type.Literal('PHONE'),
      Type.Literal('VISIT'),
      Type.Literal('EMAIL'),
      Type.Literal('MESSAGE'),
      Type.Literal('OTHER'),
    ]),
    contactPerson: Type.Optional(Type.Union([Type.String({ maxLength: 255 }), Type.Null()])),
    notes: Type.String({ minLength: 3, maxLength: 1000 }),
    promiseToPayDate: Type.Optional(Type.Union([Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }), Type.Null()])),
    promiseAmount: Type.Optional(Type.Union([DecimalMoneyStringSchema, Type.Null()])),
    outcome: Type.Union([
      Type.Literal('PROMISED_TO_PAY'),
      Type.Literal('DISPUTED'),
      Type.Literal('UNREACHABLE'),
      Type.Literal('REFUSED'),
      Type.Literal('FOLLOW_UP_REQUIRED'),
      Type.Literal('PAID'),
      Type.Literal('OTHER'),
    ]),
    nextFollowUpDate: Type.Optional(Type.Union([Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }), Type.Null()])),
  },
  { additionalProperties: false },
);
export type RecordCollectionFollowUpRequest = Static<typeof RecordCollectionFollowUpRequestSchema>;

export const CollectionRecordResponseSchema = Type.Object({
  id: UuidSchema,
  accountId: UuidSchema,
  customerId: UuidSchema,
  customerName: Type.Optional(Type.String()),
  followUpDate: Type.String(),
  collectorName: Type.Optional(Type.String()),
  contactMethod: Type.String(),
  contactPerson: Type.Union([Type.String(), Type.Null()]),
  notes: Type.String(),
  promiseToPayDate: Type.Union([Type.String(), Type.Null()]),
  promiseAmount: Type.Union([DecimalMoneyStringSchema, Type.Null()]),
  outcome: Type.String(),
  nextFollowUpDate: Type.Union([Type.String(), Type.Null()]),
  createdAt: IsoTimestampSchema,
});
export type CollectionRecordResponse = Static<typeof CollectionRecordResponseSchema>;

// Bad Debt Write-Off Contracts
export const ProcessBadDebtWriteOffRequestSchema = Type.Object(
  {
    accountId: UuidSchema,
    writeoffAmount: DecimalMoneyStringSchema,
    reason: Type.String({ minLength: 3, maxLength: 500 }),
    supportingNotes: Type.Optional(Type.Union([Type.String({ maxLength: 1000 }), Type.Null()])),
  },
  { additionalProperties: false },
);
export type ProcessBadDebtWriteOffRequest = Static<typeof ProcessBadDebtWriteOffRequestSchema>;

// Reports & Statement Contracts
export const AgingBucketSchema = Type.Object({
  current: DecimalMoneyStringSchema,
  days1To30: DecimalMoneyStringSchema,
  days31To60: DecimalMoneyStringSchema,
  days61To90: DecimalMoneyStringSchema,
  days90Plus: DecimalMoneyStringSchema,
  totalOverdue: DecimalMoneyStringSchema,
  totalOutstanding: DecimalMoneyStringSchema,
});
export type AgingBucket = Static<typeof AgingBucketSchema>;

export const CustomerAgingReportItemSchema = Type.Object({
  accountId: UuidSchema,
  customerId: UuidSchema,
  customerName: Type.String(),
  customerNumber: Type.String(),
  accountNumber: Type.String(),
  creditLimit: DecimalMoneyStringSchema,
  status: CreditAccountStatusSchema,
  riskClassification: CreditRiskClassificationSchema,
  current: DecimalMoneyStringSchema,
  days1To30: DecimalMoneyStringSchema,
  days31To60: DecimalMoneyStringSchema,
  days61To90: DecimalMoneyStringSchema,
  days90Plus: DecimalMoneyStringSchema,
  totalOverdue: DecimalMoneyStringSchema,
  totalOutstanding: DecimalMoneyStringSchema,
});
export type CustomerAgingReportItem = Static<typeof CustomerAgingReportItemSchema>;

export const CreditAgingReportResponseSchema = Type.Object({
  asOfDate: Type.String(),
  summary: AgingBucketSchema,
  customers: Type.Array(CustomerAgingReportItemSchema),
});
export type CreditAgingReportResponse = Static<typeof CreditAgingReportResponseSchema>;

export const CustomerStatementResponseSchema = Type.Object({
  customerName: Type.String(),
  customerNumber: Type.String(),
  accountNumber: Type.String(),
  creditLimit: DecimalMoneyStringSchema,
  startDate: Type.String(),
  endDate: Type.String(),
  openingBalance: DecimalMoneyStringSchema,
  totalDebits: DecimalMoneyStringSchema,
  totalCredits: DecimalMoneyStringSchema,
  closingBalance: DecimalMoneyStringSchema,
  transactions: Type.Array(CustomerCreditTransactionResponseSchema),
  unpaidInvoices: Type.Array(
    Type.Object({
      transactionReference: Type.String(),
      transactionDate: Type.String(),
      dueDate: Type.Union([Type.String(), Type.Null()]),
      description: Type.String(),
      originalAmount: DecimalMoneyStringSchema,
      unpaidAmount: DecimalMoneyStringSchema,
      daysOverdue: Type.Integer(),
    }),
  ),
  aging: AgingBucketSchema,
});
export type CustomerStatementResponse = Static<typeof CustomerStatementResponseSchema>;

export const CreditDashboardKpisResponseSchema = Type.Object({
  totalOutstanding: DecimalMoneyStringSchema,
  totalAvailableCredit: DecimalMoneyStringSchema,
  totalOverdue: DecimalMoneyStringSchema,
  activeCreditCustomers: Type.Integer(),
  customersOnHold: Type.Integer(),
  pendingApprovals: Type.Integer(),
  todayCollections: DecimalMoneyStringSchema,
  monthCreditSales: DecimalMoneyStringSchema,
  totalUnallocatedPayments: DecimalMoneyStringSchema,
});
export type CreditDashboardKpisResponse = Static<typeof CreditDashboardKpisResponseSchema>;

// ============================================================================
// UOM-04 & UOM-07: PURCHASING (PO / GRN / SUPPLIER RETURNS) & POS RETURNS CONTRACTS
// ============================================================================

export const CreatePurchaseOrderLineInputSchema = Type.Object(
  {
    productId: UuidSchema,
    orderedUom: Type.Optional(Type.String({ minLength: 1, maxLength: 16 })),
    orderedQty: DecimalQuantityStringSchema,
    unitCost: DecimalMoneyStringSchema,
  },
  { additionalProperties: false },
);

export const CreatePurchaseOrderRequestSchema = Type.Object(
  {
    branchId: UuidSchema,
    warehouseId: UuidSchema,
    supplierId: UuidSchema,
    expectedAt: Type.Optional(Type.Union([IsoTimestampSchema, Type.Null()])),
    notes: Type.Optional(Type.Union([Type.String({ maxLength: 500 }), Type.Null()])),
    approveImmediately: Type.Optional(Type.Boolean()),
    lines: Type.Array(CreatePurchaseOrderLineInputSchema, { minItems: 1, maxItems: 100 }),
  },
  { additionalProperties: false },
);
export type CreatePurchaseOrderRequest = Static<typeof CreatePurchaseOrderRequestSchema>;

export const PurchaseOrderLineResponseSchema = Type.Object({
  id: UuidSchema,
  lineNumber: Type.Integer(),
  productId: UuidSchema,
  productName: Type.Optional(Type.String()),
  sku: Type.Optional(Type.String()),
  orderedUom: Type.String(),
  orderedQty: DecimalQuantityStringSchema,
  conversionFactorToBase: DecimalQuantityStringSchema,
  normalizedBaseQty: DecimalQuantityStringSchema,
  receivedBaseQty: DecimalQuantityStringSchema,
  unitCost: DecimalMoneyStringSchema,
  lineTotal: DecimalMoneyStringSchema,
});
export type PurchaseOrderLineResponse = Static<typeof PurchaseOrderLineResponseSchema>;

export const PurchaseOrderResponseSchema = Type.Object({
  id: UuidSchema,
  tenantId: UuidSchema,
  branchId: UuidSchema,
  warehouseId: UuidSchema,
  supplierId: UuidSchema,
  supplierName: Type.Optional(Type.String()),
  poNumber: Type.String(),
  status: Type.Union([
    Type.Literal('DRAFT'),
    Type.Literal('APPROVED'),
    Type.Literal('PARTIALLY_RECEIVED'),
    Type.Literal('RECEIVED'),
    Type.Literal('CANCELLED'),
  ]),
  currencyCode: CurrencyCodeSchema,
  totalAmount: DecimalMoneyStringSchema,
  notes: Type.Union([Type.String(), Type.Null()]),
  expectedAt: Type.Union([IsoTimestampSchema, Type.Null()]),
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
  lines: Type.Array(PurchaseOrderLineResponseSchema),
});
export type PurchaseOrderResponse = Static<typeof PurchaseOrderResponseSchema>;

export const CreateGoodsReceiptLineInputSchema = Type.Object(
  {
    purchaseOrderLineId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
    productId: UuidSchema,
    receivedUom: Type.Optional(Type.String({ minLength: 1, maxLength: 16 })),
    receivedQty: DecimalQuantityStringSchema,
    unitCost: DecimalMoneyStringSchema,
    batchNumber: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 64 }), Type.Null()])),
    manufacturingDate: Type.Optional(Type.Union([Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }), Type.Null()])),
    expiryDate: Type.Optional(Type.Union([Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }), Type.Null()])),
    sellingPrice: Type.Optional(Type.Union([DecimalMoneyStringSchema, Type.Null()])),
    minSellingPrice: Type.Optional(Type.Union([DecimalMoneyStringSchema, Type.Null()])),
    maxDiscountPct: Type.Optional(Type.Union([DecimalPctStringSchema, Type.Null()])),
    batchPricingMode: Type.Optional(BatchPricingModeSchema),
    lotConflictPolicy: Type.Optional(LotConflictPolicySchema),
    marketPrice: Type.Optional(Type.Union([DecimalMoneyStringSchema, Type.Null()])),
    marketPriceSource: Type.Optional(Type.Union([Type.String({ maxLength: 64 }), Type.Null()])),
  },
  { additionalProperties: false },
);

export const PricingMethodSchema = Type.Union([
  Type.Literal('PROFIT_MARGIN'),
  Type.Literal('COST_MARKUP'),
]);
export type PricingMethodType = Static<typeof PricingMethodSchema>;

export const PricingScopeSchema = Type.Union([
  Type.Literal('GLOBAL'),
  Type.Literal('BRANCH'),
  Type.Literal('BATCH'),
]);
export type PricingScope = Static<typeof PricingScopeSchema>;

export const CreateGoodsReceiptRequestSchema = Type.Object(
  {
    purchaseOrderId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
    supplierId: UuidSchema,
    branchId: UuidSchema,
    warehouseId: UuidSchema,
    notes: Type.Optional(Type.Union([Type.String({ maxLength: 500 }), Type.Null()])),
    receivedAt: Type.Optional(IsoTimestampSchema),
    lotConflictPolicy: Type.Optional(LotConflictPolicySchema),
    conflictOverrideReason: Type.Optional(
      Type.Union([Type.String({ minLength: 3, maxLength: 500 }), Type.Null()]),
    ),
    lines: Type.Array(CreateGoodsReceiptLineInputSchema, { minItems: 1, maxItems: 100 }),
  },
  { additionalProperties: false },
);
export type CreateGoodsReceiptRequest = Static<typeof CreateGoodsReceiptRequestSchema>;

export const GoodsReceiptLineResponseSchema = Type.Object({
  id: UuidSchema,
  lineNumber: Type.Integer(),
  purchaseOrderLineId: Type.Union([UuidSchema, Type.Null()]),
  productId: UuidSchema,
  receivedUom: Type.String(),
  receivedQty: DecimalQuantityStringSchema,
  conversionFactorToBase: DecimalQuantityStringSchema,
  normalizedBaseQty: DecimalQuantityStringSchema,
  unitCostPerReceivedUom: DecimalMoneyStringSchema,
  unitCostPerBaseUom: DecimalMoneyStringSchema,
  lineTotalCost: DecimalMoneyStringSchema,
  batchNumber: Type.Union([Type.String(), Type.Null()]),
  batchId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
  internalBarcode: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  manufacturingDate: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  expiryDate: Type.Union([Type.String(), Type.Null()]),
  sellingPrice: Type.Optional(Type.Union([DecimalMoneyStringSchema, Type.Null()])),
  lotConflictResolution: Type.Optional(
    Type.Union([Type.Literal('NONE'), Type.Literal('SUFFIXED'), Type.Literal('OVERRIDDEN'), Type.Null()]),
  ),
  ledgerEntryId: Type.Union([UuidSchema, Type.Null()]),
});
export type GoodsReceiptLineResponse = Static<typeof GoodsReceiptLineResponseSchema>;

export const GoodsReceiptResponseSchema = Type.Object({
  id: UuidSchema,
  tenantId: UuidSchema,
  purchaseOrderId: Type.Union([UuidSchema, Type.Null()]),
  supplierId: UuidSchema,
  branchId: UuidSchema,
  warehouseId: UuidSchema,
  grnNumber: Type.String(),
  status: Type.Union([Type.Literal('POSTED'), Type.Literal('CANCELLED')]),
  currencyCode: CurrencyCodeSchema,
  totalCost: DecimalMoneyStringSchema,
  notes: Type.Union([Type.String(), Type.Null()]),
  receivedAt: IsoTimestampSchema,
  createdAt: IsoTimestampSchema,
  lines: Type.Array(GoodsReceiptLineResponseSchema),
  pricingRecommendations: Type.Optional(
    Type.Array(
      Type.Object({
        productId: UuidSchema,
        sku: Type.String(),
        productName: Type.String(),
        baseUom: Type.String(),
        suggestionId: Type.Union([UuidSchema, Type.Null()]),
        existingSellingPrice: DecimalMoneyStringSchema,
        incomingPurchaseCost: DecimalMoneyStringSchema,
        updatedMovingAvgCost: DecimalMoneyStringSchema,
        marketPrice: Type.Union([DecimalMoneyStringSchema, Type.Null()]),
        marketPriceSource: Type.Union([Type.String(), Type.Null()]),
        recommendedSellingPrice: DecimalMoneyStringSchema,
        expectedMarginPct: DecimalPctStringSchema,
        expectedProfitPerUnit: DecimalMoneyStringSchema,
        targetPercentage: DecimalPctStringSchema,
        pricingMethod: PricingMethodSchema,
        scope: PricingScopeSchema,
        batchId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
      }),
    ),
  ),
});
export type GoodsReceiptResponse = Static<typeof GoodsReceiptResponseSchema>;

export const CreateSupplierReturnRequestSchema = Type.Object(
  {
    supplierId: UuidSchema,
    goodsReceiptId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
    branchId: UuidSchema,
    warehouseId: UuidSchema,
    productId: UuidSchema,
    returnUom: Type.Optional(Type.String({ minLength: 1, maxLength: 16 })),
    returnQty: DecimalQuantityStringSchema,
    unitCost: Type.Optional(DecimalMoneyStringSchema),
    reason: Type.String({ minLength: 3, maxLength: 500 }),
  },
  { additionalProperties: false },
);
export type CreateSupplierReturnRequest = Static<typeof CreateSupplierReturnRequestSchema>;

export const SupplierReturnResponseSchema = Type.Object({
  id: UuidSchema,
  tenantId: UuidSchema,
  supplierId: UuidSchema,
  goodsReceiptId: Type.Union([UuidSchema, Type.Null()]),
  branchId: UuidSchema,
  warehouseId: UuidSchema,
  returnNumber: Type.String(),
  productId: UuidSchema,
  returnUom: Type.String(),
  returnQty: DecimalQuantityStringSchema,
  conversionFactorToBase: DecimalQuantityStringSchema,
  normalizedBaseQty: DecimalQuantityStringSchema,
  unitCost: DecimalMoneyStringSchema,
  totalCost: DecimalMoneyStringSchema,
  reason: Type.String(),
  ledgerEntryId: Type.Union([UuidSchema, Type.Null()]),
  createdAt: IsoTimestampSchema,
});
export type SupplierReturnResponse = Static<typeof SupplierReturnResponseSchema>;

export const CreatePosReturnLineInputSchema = Type.Object(
  {
    invoiceLineId: UuidSchema,
    returnQty: DecimalQuantityStringSchema,
    returnUom: Type.Optional(Type.String({ minLength: 1, maxLength: 16 })),
    restockCondition: Type.Optional(Type.Union([Type.Literal('RESELLABLE'), Type.Literal('DAMAGED')])),
  },
  { additionalProperties: false },
);

export const CreatePosReturnRequestSchema = Type.Object(
  {
    reason: Type.String({ minLength: 3, maxLength: 500 }),
    refundMethod: Type.Union([
      Type.Literal('CASH'),
      Type.Literal('CARD'),
      Type.Literal('CREDIT_ADJUSTMENT'),
      Type.Literal('OTHER'),
    ]),
    lines: Type.Array(CreatePosReturnLineInputSchema, { minItems: 1, maxItems: 50 }),
  },
  { additionalProperties: false },
);
export type CreatePosReturnRequest = Static<typeof CreatePosReturnRequestSchema>;

export const PosReturnLineResponseSchema = Type.Object({
  id: UuidSchema,
  invoiceLineId: UuidSchema,
  productId: UuidSchema,
  returnUom: Type.String(),
  returnQty: DecimalQuantityStringSchema,
  conversionFactorToBase: DecimalQuantityStringSchema,
  normalizedBaseQty: DecimalQuantityStringSchema,
  restockCondition: Type.Union([Type.Literal('RESELLABLE'), Type.Literal('DAMAGED')]),
  unitPrice: DecimalMoneyStringSchema,
  refundAmount: DecimalMoneyStringSchema,
  batchId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
  batchNumber: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  serialId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
  ledgerEntryId: Type.Union([UuidSchema, Type.Null()]),
});
export type PosReturnLineResponse = Static<typeof PosReturnLineResponseSchema>;

export const PosReturnResponseSchema = Type.Object({
  id: UuidSchema,
  tenantId: UuidSchema,
  invoiceId: UuidSchema,
  branchId: UuidSchema,
  warehouseId: UuidSchema,
  returnNumber: Type.String(),
  reason: Type.String(),
  refundMethod: Type.String(),
  totalRefundAmount: DecimalMoneyStringSchema,
  currencyCode: CurrencyCodeSchema,
  createdAt: IsoTimestampSchema,
  lines: Type.Array(PosReturnLineResponseSchema),
});
export type PosReturnResponse = Static<typeof PosReturnResponseSchema>;

// ============================================================================
// Phase 4 & 5: Smart Pricing Management System (PRICE-01..PRICE-20)
// ============================================================================

export const PricingCostBasisSchema = Type.Union([
  Type.Literal('LAST_PURCHASE_COST'),
  Type.Literal('MOVING_AVERAGE_COST'),
  Type.Literal('HIGHEST_RECENT_COST'),
]);
export type PricingCostBasisType = Static<typeof PricingCostBasisSchema>;

export const PricingRoundingRuleSchema = Type.Union([
  Type.Literal('NONE'),
  Type.Literal('NEAREST_0_01'),
  Type.Literal('NEAREST_0_50'),
  Type.Literal('NEAREST_1'),
  Type.Literal('NEAREST_5'),
  Type.Literal('NEAREST_10'),
  Type.Literal('CEIL_0_50'),
  Type.Literal('CEIL_1'),
  Type.Literal('CEIL_5'),
  Type.Literal('CEIL_10'),
]);
export type PricingRoundingRuleType = Static<typeof PricingRoundingRuleSchema>;

export const BranchApprovalPolicySchema = Type.Union([
  Type.Literal('OWNER_ADMIN_ONLY'),
  Type.Literal('BRANCH_MANAGER_OWN_BRANCH'),
]);
export type BranchApprovalPolicy = Static<typeof BranchApprovalPolicySchema>;

export const PriceSuggestionStatusSchema = Type.Union([
  Type.Literal('PENDING'),
  Type.Literal('APPROVED'),
  Type.Literal('MODIFIED_APPROVED'),
  Type.Literal('REJECTED'),
  Type.Literal('DEFERRED'),
  Type.Literal('SUPERSEDED'),
]);
export type PriceSuggestionStatus = Static<typeof PriceSuggestionStatusSchema>;

export const PriceSuggestionSourceEventTypeSchema = Type.Union([
  Type.Literal('GRN_POSTED'),
  Type.Literal('COST_EDIT'),
  Type.Literal('STOCK_MOVEMENT'),
  Type.Literal('BRANCH_PROPOSAL'),
  Type.Literal('GLOBAL_RULE_CHANGE'),
  Type.Literal('MANUAL_RECALC'),
]);
export type PriceSuggestionSourceEventType = Static<
  typeof PriceSuggestionSourceEventTypeSchema
>;

export const CostChangeDirectionSchema = Type.Union([
  Type.Literal('INCREASE'),
  Type.Literal('DECREASE'),
  Type.Literal('UNCHANGED'),
]);

export const DateOnlyStringSchema = Type.String({
  pattern: '^\\d{4}-\\d{2}-\\d{2}$',
});

export const PricingSettingsResponseSchema = Type.Object({
  tenantId: UuidSchema,
  defaultPricingMethod: PricingMethodSchema,
  defaultTargetPercentage: DecimalPctStringSchema,
  defaultCostBasis: PricingCostBasisSchema,
  defaultRoundingRule: PricingRoundingRuleSchema,
  defaultMinMarginPct: DecimalPctStringSchema,
  defaultMaxDiscountPct: DecimalPctStringSchema,
  branchApprovalPolicy: BranchApprovalPolicySchema,
  allowSelfApproval: Type.Boolean(),
  autoCreateSuggestionsOnCostChange: Type.Boolean(),
  autoCreateSuggestionsOnCostDecrease: Type.Boolean(),
  batchPricingFallbackPolicy: Type.Optional(BatchPricingFallbackPolicySchema),
  defaultBatchAllocationPolicy: Type.Optional(DefaultTenantBatchAllocationPolicySchema),
  updatedAt: IsoTimestampSchema,
});
export type PricingSettingsResponse = Static<typeof PricingSettingsResponseSchema>;

export const UpdatePricingSettingsRequestSchema = Type.Object(
  {
    defaultPricingMethod: Type.Optional(PricingMethodSchema),
    defaultTargetPercentage: Type.Optional(DecimalPctStringSchema),
    defaultCostBasis: Type.Optional(PricingCostBasisSchema),
    defaultRoundingRule: Type.Optional(PricingRoundingRuleSchema),
    defaultMinMarginPct: Type.Optional(DecimalPctStringSchema),
    defaultMaxDiscountPct: Type.Optional(DecimalPctStringSchema),
    branchApprovalPolicy: Type.Optional(BranchApprovalPolicySchema),
    allowSelfApproval: Type.Optional(Type.Boolean()),
    autoCreateSuggestionsOnCostChange: Type.Optional(Type.Boolean()),
    autoCreateSuggestionsOnCostDecrease: Type.Optional(Type.Boolean()),
    batchPricingFallbackPolicy: Type.Optional(BatchPricingFallbackPolicySchema),
    defaultBatchAllocationPolicy: Type.Optional(DefaultTenantBatchAllocationPolicySchema),
  },
  { additionalProperties: false },
);
export type UpdatePricingSettingsRequest = Static<
  typeof UpdatePricingSettingsRequestSchema
>;

export const ProductPricingRuleResponseSchema = Type.Object({
  tenantId: UuidSchema,
  productId: UuidSchema,
  pricingMethod: PricingMethodSchema,
  targetPercentage: DecimalPctStringSchema,
  costBasis: PricingCostBasisSchema,
  roundingRule: PricingRoundingRuleSchema,
  minSellingPrice: Type.Union([DecimalMoneyStringSchema, Type.Null()]),
  minMarginPct: Type.Union([DecimalPctStringSchema, Type.Null()]),
  maxDiscountPct: Type.Union([DecimalPctStringSchema, Type.Null()]),
  suggestionsEnabled: Type.Boolean(),
  effectiveDate: DateOnlyStringSchema,
  updatedAt: IsoTimestampSchema,
});
export type ProductPricingRuleResponse = Static<
  typeof ProductPricingRuleResponseSchema
>;

export const UpsertProductPricingRuleRequestSchema = Type.Object(
  {
    pricingMethod: PricingMethodSchema,
    targetPercentage: DecimalPctStringSchema,
    costBasis: PricingCostBasisSchema,
    roundingRule: PricingRoundingRuleSchema,
    minSellingPrice: Type.Optional(
      Type.Union([DecimalMoneyStringSchema, Type.Null()]),
    ),
    minMarginPct: Type.Optional(
      Type.Union([DecimalPctStringSchema, Type.Null()]),
    ),
    maxDiscountPct: Type.Optional(
      Type.Union([DecimalPctStringSchema, Type.Null()]),
    ),
    suggestionsEnabled: Type.Optional(Type.Boolean()),
    effectiveDate: Type.Optional(DateOnlyStringSchema),
    recalculateGlobalSuggestion: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type UpsertProductPricingRuleRequest = Static<
  typeof UpsertProductPricingRuleRequestSchema
>;

export const BranchPriceOverrideResponseSchema = Type.Object({
  id: UuidSchema,
  tenantId: UuidSchema,
  productId: UuidSchema,
  productName: Type.Optional(Type.String()),
  sku: Type.Optional(Type.String()),
  branchId: UuidSchema,
  branchName: Type.Optional(Type.String()),
  globalSellingPrice: DecimalMoneyStringSchema,
  sellingPrice: DecimalMoneyStringSchema,
  pricingMethod: PricingMethodSchema,
  targetPercentage: Type.Union([DecimalPctStringSchema, Type.Null()]),
  roundingRule: PricingRoundingRuleSchema,
  minSellingPrice: Type.Union([DecimalMoneyStringSchema, Type.Null()]),
  maxDiscountPct: Type.Union([DecimalPctStringSchema, Type.Null()]),
  effectiveDate: DateOnlyStringSchema,
  isActive: Type.Boolean(),
  needsReview: Type.Boolean(),
  reviewReason: Type.Union([Type.String(), Type.Null()]),
  approvedAt: Type.Union([IsoTimestampSchema, Type.Null()]),
  syncVersion: Type.Integer(),
});
export type BranchPriceOverrideResponse = Static<
  typeof BranchPriceOverrideResponseSchema
>;

export const PriceSuggestionResponseSchema = Type.Object({
  id: UuidSchema,
  tenantId: UuidSchema,
  productId: UuidSchema,
  productName: Type.String(),
  sku: Type.String(),
  priceUom: Type.String(),
  scope: PricingScopeSchema,
  branchId: Type.Union([UuidSchema, Type.Null()]),
  branchName: Type.Union([Type.String(), Type.Null()]),
  sourceEventType: PriceSuggestionSourceEventTypeSchema,
  sourceEventKey: Type.Union([Type.String(), Type.Null()]),
  costChangeDirection: CostChangeDirectionSchema,
  oldCost: DecimalMoneyStringSchema,
  newCost: DecimalMoneyStringSchema,
  costBasis: PricingCostBasisSchema,
  currentSellingPrice: DecimalMoneyStringSchema,
  suggestedSellingPrice: DecimalMoneyStringSchema,
  finalApprovedPrice: Type.Union([DecimalMoneyStringSchema, Type.Null()]),
  pricingMethod: PricingMethodSchema,
  targetPercentage: DecimalPctStringSchema,
  roundingRule: PricingRoundingRuleSchema,
  reason: Type.String(),
  effectiveDate: DateOnlyStringSchema,
  marketPrice: Type.Optional(Type.Union([DecimalMoneyStringSchema, Type.Null()])),
  marketPriceSource: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  incomingPurchaseCost: Type.Optional(Type.Union([DecimalMoneyStringSchema, Type.Null()])),
  movingAvgCost: Type.Optional(Type.Union([DecimalMoneyStringSchema, Type.Null()])),
  status: PriceSuggestionStatusSchema,
  currentMarginPct: DecimalPctStringSchema,
  suggestedMarginPct: DecimalPctStringSchema,
  expectedProfitPerUnit: DecimalMoneyStringSchema,
  createdByUserId: UuidSchema,
  reviewedByUserId: Type.Union([UuidSchema, Type.Null()]),
  reviewNotes: Type.Union([Type.String(), Type.Null()]),
  deferredUntil: Type.Union([DateOnlyStringSchema, Type.Null()]),
  createdAt: IsoTimestampSchema,
  reviewedAt: Type.Union([IsoTimestampSchema, Type.Null()]),
});
export type PriceSuggestionResponse = Static<
  typeof PriceSuggestionResponseSchema
>;

export const CreatePriceSuggestionRequestSchema = Type.Object(
  {
    productId: UuidSchema,
    scope: PricingScopeSchema,
    branchId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
    proposedPrice: Type.Optional(DecimalMoneyStringSchema),
    costOverride: Type.Optional(DecimalMoneyStringSchema),
    pricingMethod: Type.Optional(PricingMethodSchema),
    targetPercentage: Type.Optional(DecimalPctStringSchema),
    roundingRule: Type.Optional(PricingRoundingRuleSchema),
    costBasis: Type.Optional(PricingCostBasisSchema),
    marketPrice: Type.Optional(Type.Union([DecimalMoneyStringSchema, Type.Null()])),
    marketPriceSource: Type.Optional(Type.Union([Type.String({ maxLength: 64 }), Type.Null()])),
    effectiveDate: Type.Optional(DateOnlyStringSchema),
    reason: Type.String({ minLength: 2, maxLength: 500 }),
  },
  { additionalProperties: false },
);
export type CreatePriceSuggestionRequest = Static<
  typeof CreatePriceSuggestionRequestSchema
>;

export const ApprovePriceSuggestionRequestSchema = Type.Object(
  {
    overridePrice: Type.Optional(DecimalMoneyStringSchema),
    effectiveDate: Type.Optional(DateOnlyStringSchema),
    reviewNotes: Type.Optional(Type.String({ maxLength: 500 })),
    bypassFloorWithReason: Type.Optional(Type.String({ minLength: 3, maxLength: 500 })),
    marketPrice: Type.Optional(Type.Union([DecimalMoneyStringSchema, Type.Null()])),
    marketPriceSource: Type.Optional(Type.Union([Type.String({ maxLength: 64 }), Type.Null()])),
  },
  { additionalProperties: false },
);
export type ApprovePriceSuggestionRequest = Static<
  typeof ApprovePriceSuggestionRequestSchema
>;

export const MarketPriceLookupQuerySchema = Type.Object(
  {
    productId: Type.Optional(UuidSchema),
    barcode: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    query: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  },
  { additionalProperties: false },
);
export type MarketPriceLookupQuery = Static<typeof MarketPriceLookupQuerySchema>;

export const MarketPriceLookupResponseSchema = Type.Object({
  available: Type.Boolean(),
  suggestedMarketPrice: Type.Union([DecimalMoneyStringSchema, Type.Null()]),
  currencyCode: CurrencyCodeSchema,
  source: Type.String(),
  externalReferenceName: Type.Union([Type.String(), Type.Null()]),
  message: Type.String(),
});
export type MarketPriceLookupResponse = Static<typeof MarketPriceLookupResponseSchema>;

export const RejectOrDeferPriceSuggestionRequestSchema = Type.Object(
  {
    action: Type.Union([Type.Literal('REJECT'), Type.Literal('DEFER')]),
    deferredUntil: Type.Optional(DateOnlyStringSchema),
    reviewNotes: Type.String({ minLength: 2, maxLength: 500 }),
  },
  { additionalProperties: false },
);
export type RejectOrDeferPriceSuggestionRequest = Static<
  typeof RejectOrDeferPriceSuggestionRequestSchema
>;

export const ProductPriceHistoryResponseSchema = Type.Object({
  id: UuidSchema,
  tenantId: UuidSchema,
  productId: UuidSchema,
  productName: Type.Optional(Type.String()),
  sku: Type.Optional(Type.String()),
  scope: PricingScopeSchema,
  branchId: Type.Union([UuidSchema, Type.Null()]),
  branchName: Type.Union([Type.String(), Type.Null()]),
  suggestionId: Type.Union([UuidSchema, Type.Null()]),
  previousPrice: DecimalMoneyStringSchema,
  newPrice: DecimalMoneyStringSchema,
  costSnapshot: DecimalMoneyStringSchema,
  pricingMethod: Type.Union([PricingMethodSchema, Type.Null()]),
  targetPercentage: Type.Union([DecimalPctStringSchema, Type.Null()]),
  roundingRule: Type.Union([Type.String(), Type.Null()]),
  reason: Type.String(),
  actorUserId: UuidSchema,
  approverUserId: UuidSchema,
  effectiveDate: DateOnlyStringSchema,
  approvedAt: IsoTimestampSchema,
  createdAt: IsoTimestampSchema,
});
export type ProductPriceHistoryResponse = Static<
  typeof ProductPriceHistoryResponseSchema
>;

export const PricingProductHealthRowSchema = Type.Object({
  productId: UuidSchema,
  sku: Type.String(),
  name: Type.String(),
  priceUom: Type.String(),
  purchaseCost: DecimalMoneyStringSchema,
  sellingPrice: DecimalMoneyStringSchema,
  minSellingPrice: Type.Union([DecimalMoneyStringSchema, Type.Null()]),
  maxDiscountPct: Type.Union([DecimalPctStringSchema, Type.Null()]),
  pricingMethod: PricingMethodSchema,
  targetPercentage: DecimalPctStringSchema,
  costBasis: PricingCostBasisSchema,
  roundingRule: PricingRoundingRuleSchema,
  actualMarginPct: DecimalPctStringSchema,
  actualMarkupPct: DecimalPctStringSchema,
  expectedProfitPerUnit: DecimalMoneyStringSchema,
  isZeroOrNegativeMargin: Type.Boolean(),
  isLowMargin: Type.Boolean(),
  isBelowMinSellingPrice: Type.Boolean(),
  suggestionsEnabled: Type.Boolean(),
  branchOverrideCount: Type.Integer(),
});
export type PricingProductHealthRow = Static<
  typeof PricingProductHealthRowSchema
>;

export const PricingAnalyticsDashboardResponseSchema = Type.Object({
  currencyCode: CurrencyCodeSchema,
  kpis: Type.Object({
    pendingGlobalSuggestions: Type.Integer(),
    pendingBranchSuggestions: Type.Integer(),
    costIncreaseSuggestions: Type.Integer(),
    costDecreaseSuggestions: Type.Integer(),
    lowMarginCount: Type.Integer(),
    zeroOrNegativeMarginCount: Type.Integer(),
    branchReviewAlertsCount: Type.Integer(),
    recentApprovalsCount: Type.Integer(),
    recentRejectionsCount: Type.Integer(),
    deferredCount: Type.Integer(),
  }),
  settings: PricingSettingsResponseSchema,
  lowMarginProducts: Type.Array(PricingProductHealthRowSchema),
  productHealth: Type.Array(PricingProductHealthRowSchema),
  branchOverrides: Type.Array(BranchPriceOverrideResponseSchema),
});
export type PricingAnalyticsDashboardResponse = Static<
  typeof PricingAnalyticsDashboardResponseSchema
>;

export const SyncCatalogPricingResponseSchema = Type.Object({
  tenantId: UuidSchema,
  branchId: Type.Union([UuidSchema, Type.Null()]),
  currencyCode: CurrencyCodeSchema,
  syncedAt: IsoTimestampSchema,
  branding: Type.Optional(
    Type.Object({
      shopDisplayName: Type.Union([Type.String(), Type.Null()]),
      logoUrl: Type.Union([Type.String(), Type.Null()]),
    }),
  ),
  policies: Type.Optional(
    Type.Object({
      batchPricingFallbackPolicy: BatchPricingFallbackPolicySchema,
      defaultBatchAllocationPolicy: BatchAllocationPolicySchema,
    }),
  ),
  globalPrices: Type.Array(
    Type.Object({
      productId: UuidSchema,
      sku: Type.String(),
      name: Type.String(),
      categoryId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
      baseUom: Type.String(),
      priceUom: Type.String(),
      purchaseCost: Type.Optional(DecimalMoneyStringSchema),
      sellingPrice: DecimalMoneyStringSchema,
      minSellingPrice: Type.Union([DecimalMoneyStringSchema, Type.Null()]),
      maxDiscountPct: Type.Union([DecimalPctStringSchema, Type.Null()]),
      valuationMethod: Type.Optional(ValuationMethodSchema),
      trackingMode: Type.Optional(TrackingModeSchema),
      allocationPolicy: Type.Optional(BatchAllocationPolicySchema),
      requireBatchSellingPrice: Type.Optional(Type.Boolean()),
      productQtyMode: Type.Optional(ProductQtyModeSchema),
      measurementCategory: Type.Optional(Type.Union([MeasurementCategorySchema, Type.Null()])),
      allowedSellingUoms: Type.Optional(Type.Array(Type.String())),
      qtyDecimalPrecision: Type.Optional(Type.Integer()),
      taxGroupId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
      trackInventory: Type.Optional(Type.Boolean()),
      primaryBarcode: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      syncVersion: Type.Integer(),
    }),
  ),
  branchOverrides: Type.Array(BranchPriceOverrideResponseSchema),
  batches: Type.Optional(
    Type.Array(
      Type.Object({
        batchId: UuidSchema,
        productId: UuidSchema,
        branchId: Type.Union([UuidSchema, Type.Null()]),
        warehouseId: UuidSchema,
        batchNumber: Type.String(),
        internalBarcode: Type.Union([Type.String(), Type.Null()]),
        expiryDate: Type.Union([Type.String(), Type.Null()]),
        receivedDate: Type.String(),
        availableQuantity: DecimalQuantityStringSchema,
        unitCost: DecimalMoneyStringSchema,
        sellingPrice: Type.Union([DecimalMoneyStringSchema, Type.Null()]),
        minSellingPrice: Type.Union([DecimalMoneyStringSchema, Type.Null()]),
        maxDiscountPct: Type.Union([DecimalPctStringSchema, Type.Null()]),
        batchPricingMode: BatchPricingModeSchema,
        status: BatchStatusSchema,
      }),
    ),
  ),
  categories: Type.Optional(
    Type.Array(
      Type.Object({
        id: UuidSchema,
        parentId: Type.Union([UuidSchema, Type.Null()]),
        name: Type.String(),
        status: Type.Union([Type.Literal('ACTIVE'), Type.Literal('ARCHIVED')]),
        syncVersion: Type.Integer(),
      }),
    ),
  ),
  barcodes: Type.Optional(
    Type.Array(
      Type.Object({
        id: UuidSchema,
        productId: UuidSchema,
        barcode: Type.String(),
        barcodeType: Type.String(),
        uomCode: Type.String(),
        isPrimary: Type.Boolean(),
        isActive: Type.Optional(Type.Boolean()),
        stockIntakeLotId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
        batchId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
        conversionFactorToBase: Type.Optional(Type.Union([DecimalQuantityStringSchema, Type.Null()])),
        priceSourceMode: Type.Optional(BarcodePriceSourceModeSchema),
        sellingPriceOverride: Type.Optional(Type.Union([DecimalMoneyStringSchema, Type.Null()])),
      }),
    ),
  ),
  unitConversions: Type.Optional(
    Type.Array(
      Type.Object({
        id: UuidSchema,
        productId: UuidSchema,
        uomCode: Type.String(),
        uomName: Type.String(),
        conversionFactorToBase: DecimalQuantityStringSchema,
        isDefaultPurchasing: Type.Optional(Type.Boolean()),
        isDefaultSelling: Type.Optional(Type.Boolean()),
        sellingPrice: Type.Optional(Type.Union([DecimalMoneyStringSchema, Type.Null()])),
        isActive: Type.Boolean(),
      }),
    ),
  ),
  intakeLots: Type.Optional(
    Type.Array(
      Type.Object({
        id: UuidSchema,
        branchId: UuidSchema,
        warehouseId: UuidSchema,
        productId: UuidSchema,
        batchId: Type.Union([UuidSchema, Type.Null()]),
        intakeCode: Type.String(),
        sourceMethod: Type.String(),
        receivedUom: Type.String(),
        receivedQty: DecimalQuantityStringSchema,
        conversionFactorToBase: DecimalQuantityStringSchema,
        baseQtyReceived: DecimalQuantityStringSchema,
        baseQtyRemaining: DecimalQuantityStringSchema,
        purchaseCostPerBaseUom: DecimalMoneyStringSchema,
        pricingMode: Type.Union([
          Type.Literal('INHERIT_PRODUCT'),
          Type.Literal('INHERIT_BRANCH'),
          Type.Literal('INTAKE_SPECIFIC'),
        ]),
        sellingUom: Type.String(),
        sellingPrice: Type.Union([DecimalMoneyStringSchema, Type.Null()]),
        isLegacyAggregate: Type.Boolean(),
        status: Type.Union([
          Type.Literal('ACTIVE'),
          Type.Literal('DEPLETED'),
          Type.Literal('INACTIVE'),
          Type.Literal('REVERSED'),
        ]),
        receivedAt: IsoTimestampSchema,
      }),
    ),
  ),
  taxGroups: Type.Optional(
    Type.Array(
      Type.Object({
        id: UuidSchema,
        code: Type.String(),
        name: Type.String(),
        isActive: Type.Boolean(),
      }),
    ),
  ),
  taxRates: Type.Optional(
    Type.Array(
      Type.Object({
        id: UuidSchema,
        taxGroupId: UuidSchema,
        code: Type.String(),
        name: Type.String(),
        ratePercentage: Type.String(),
        isCompound: Type.Boolean(),
        priority: Type.Integer(),
        isActive: Type.Boolean(),
      }),
    ),
  ),
  customers: Type.Optional(
    Type.Array(
      Type.Object({
        id: UuidSchema,
        customerNumber: Type.String(),
        name: Type.String(),
        phone: Type.Union([Type.String(), Type.Null()]),
        email: Type.Union([Type.String(), Type.Null()]),
        status: Type.Union([Type.Literal('ACTIVE'), Type.Literal('INACTIVE'), Type.Literal('ARCHIVED')]),
      }),
    ),
  ),
  branches: Type.Optional(
    Type.Array(
      Type.Object({
        id: UuidSchema,
        code: Type.String(),
        name: Type.String(),
        isMainBranch: Type.Boolean(),
        isActive: Type.Boolean(),
        defaultWarehouseId: Type.Union([UuidSchema, Type.Null()]),
      }),
    ),
  ),
  warehouses: Type.Optional(
    Type.Array(
      Type.Object({
        id: UuidSchema,
        branchId: Type.Union([UuidSchema, Type.Null()]),
        code: Type.String(),
        name: Type.String(),
        allowNegativeStock: Type.Boolean(),
        isActive: Type.Boolean(),
      }),
    ),
  ),
  registers: Type.Optional(
    Type.Array(
      Type.Object({
        id: UuidSchema,
        branchId: UuidSchema,
        warehouseId: UuidSchema,
        code: Type.String(),
        name: Type.String(),
        isActive: Type.Boolean(),
      }),
    ),
  ),
  balances: Type.Optional(
    Type.Array(
      Type.Object({
        branchId: UuidSchema,
        warehouseId: UuidSchema,
        productId: UuidSchema,
        qtyOnHand: DecimalQuantityStringSchema,
        qtyReserved: DecimalQuantityStringSchema,
        availableQty: DecimalQuantityStringSchema,
        movingAvgCost: DecimalMoneyStringSchema,
      }),
    ),
  ),
  serials: Type.Optional(
    Type.Array(
      Type.Object({
        id: UuidSchema,
        productId: UuidSchema,
        warehouseId: UuidSchema,
        branchId: UuidSchema,
        batchId: Type.Union([UuidSchema, Type.Null()]),
        serialNumber: Type.String(),
        status: Type.String(),
        unitCost: DecimalMoneyStringSchema,
      }),
    ),
  ),
  deviceAuthorization: Type.Optional(
    Type.Object({
      actorUserId: UuidSchema,
      allLocationsAccess: Type.Boolean(),
      allowedBranchIds: Type.Array(UuidSchema),
      roleCodes: Type.Array(Type.String()),
      permissions: Type.Array(Type.String()),
      offlineAuthTtlHours: Type.Integer(),
    }),
  ),
});
export type SyncCatalogPricingResponse = Static<
  typeof SyncCatalogPricingResponseSchema
>;

// ============================================================================
// Phase 2 — Hybrid Barcodes, Batch Pricing, Transfers & Legacy UOM Correction
// ============================================================================

export const ResolveBarcodeRequestSchema = Type.Object(
  {
    rawBarcode: Type.String({ minLength: 1, maxLength: 255 }),
    branchId: Type.Optional(UuidSchema),
    warehouseId: Type.Optional(UuidSchema),
    requestedQty: Type.Optional(DecimalQuantityStringSchema),
    context: Type.Optional(
      Type.Union([
        Type.Literal('POS'),
        Type.Literal('GRN'),
        Type.Literal('INVENTORY'),
      ]),
    ),
  },
  { additionalProperties: false },
);
export type ResolveBarcodeRequest = Static<typeof ResolveBarcodeRequestSchema>;

export const ResolveBarcodeResponseSchema = Type.Object({
  matchedBy: Type.Union([
    Type.Literal('INTERNAL_BATCH'),
    Type.Literal('GS1_BATCH_AND_PRODUCT'),
    Type.Literal('GS1_PRODUCT_ONLY'),
    Type.Literal('MANUFACTURER_PRODUCT_BARCODE'),
    Type.Literal('SERIAL_BARCODE'),
    Type.Literal('SERIAL_NUMBER'),
    Type.Literal('SKU'),
    Type.Literal('UNRESOLVED'),
  ]),
  rawBarcode: Type.String(),
  normalizedBarcode: Type.String(),
  isExactBatchLocked: Type.Boolean(),
  isExactSerialLocked: Type.Optional(Type.Boolean()),
  isExactIntakeLotLocked: Type.Optional(Type.Boolean()),
  resolvedSellingUom: Type.Optional(Type.String()),
  resolvedConversionFactorToBase: Type.Optional(DecimalQuantityStringSchema),
  matchedBarcode: Type.Optional(
    Type.Union([
      Type.Object({
        id: UuidSchema,
        barcode: Type.String(),
        barcodeType: BarcodeTypeSchema,
        uomCode: Type.String(),
        conversionFactorToBase: Type.Union([DecimalQuantityStringSchema, Type.Null()]),
        stockIntakeLotId: Type.Union([UuidSchema, Type.Null()]),
        batchId: Type.Union([UuidSchema, Type.Null()]),
        priceSourceMode: BarcodePriceSourceModeSchema,
        sellingPriceOverride: Type.Union([DecimalMoneyStringSchema, Type.Null()]),
      }),
      Type.Null(),
    ]),
  ),
  exactIntakeLot: Type.Optional(
    Type.Union([
      Type.Object({
        id: UuidSchema,
        intakeCode: Type.String(),
        sourceMethod: Type.String(),
        warehouseId: UuidSchema,
        branchId: UuidSchema,
        receivedUom: Type.String(),
        receivedQty: DecimalQuantityStringSchema,
        conversionFactorToBase: DecimalQuantityStringSchema,
        baseQtyReceived: DecimalQuantityStringSchema,
        baseQtyRemaining: DecimalQuantityStringSchema,
        purchaseCostPerBaseUom: DecimalMoneyStringSchema,
        pricingMode: Type.Union([
          Type.Literal('INHERIT_PRODUCT'),
          Type.Literal('INHERIT_BRANCH'),
          Type.Literal('INTAKE_SPECIFIC'),
        ]),
        sellingUom: Type.String(),
        sellingPrice: Type.Union([DecimalMoneyStringSchema, Type.Null()]),
        isLegacyAggregate: Type.Boolean(),
        status: Type.Union([
          Type.Literal('ACTIVE'),
          Type.Literal('DEPLETED'),
          Type.Literal('INACTIVE'),
          Type.Literal('REVERSED'),
        ]),
        receivedAt: IsoTimestampSchema,
      }),
      Type.Null(),
    ]),
  ),
  gs1Parsed: Type.Object({
    isGs1: Type.Boolean(),
    gtin: Type.Union([Type.String(), Type.Null()]),
    batchNumber: Type.Union([Type.String(), Type.Null()]),
    expiryDate: Type.Union([Type.String(), Type.Null()]),
    serialNumber: Type.Union([Type.String(), Type.Null()]),
  }),
  product: Type.Union([
    Type.Object({
      id: UuidSchema,
      sku: Type.String(),
      name: Type.String(),
      baseUom: Type.String(),
      trackingMode: TrackingModeSchema,
      trackInventory: Type.Optional(Type.Boolean()),
      productQtyMode: Type.Optional(ProductQtyModeSchema),
      availableQuantity: Type.Optional(DecimalQuantityStringSchema),
      allocationPolicy: BatchAllocationPolicySchema,
      requireBatchSellingPrice: Type.Boolean(),
      sellingPrice: DecimalMoneyStringSchema,
      primaryBarcode: Type.Union([Type.String(), Type.Null()]),
    }),
    Type.Null(),
  ]),
  exactBatch: Type.Union([BatchResponseSchema, Type.Null()]),
  exactSerial: Type.Optional(
    Type.Union([
      Type.Object({
        id: UuidSchema,
        serialNumber: Type.String(),
        internalBarcode: Type.Union([Type.String(), Type.Null()]),
        serialGroupId: Type.Union([UuidSchema, Type.Null()]),
        groupCode: Type.Union([Type.String(), Type.Null()]),
        status: SerialStatusSchema,
        unitCost: DecimalMoneyStringSchema,
        sellingPrice: Type.Union([DecimalMoneyStringSchema, Type.Null()]),
        warehouseId: UuidSchema,
        branchId: UuidSchema,
      }),
      Type.Null(),
    ]),
  ),
  availableQuantityTotal: Type.Optional(DecimalQuantityStringSchema),
  effectiveUnitPrice: Type.Union([DecimalMoneyStringSchema, Type.Null()]),
  priceSource: Type.Union([
    Type.Literal('BATCH_EXPLICIT'),
    Type.Literal('SERIAL_GROUP'),
    Type.Literal('INTAKE_SPECIFIC'),
    Type.Literal('PACKAGE_EXPLICIT'),
    Type.Literal('PRODUCT_FALLBACK'),
    Type.Literal('BRANCH_OVERRIDE'),
    Type.Literal('GLOBAL_PRODUCT'),
    Type.Literal('REQUIRES_POS_MANUAL_PRICE'),
    Type.Literal('MISSING_BLOCKED'),
    Type.Null(),
  ]),
  requiresPricePrompt: Type.Boolean(),
  blockedReason: Type.Union([Type.String(), Type.Null()]),
  fefoPreview: Type.Array(FefoBatchAllocationSchema),
});
export type ResolveBarcodeResponse = Static<typeof ResolveBarcodeResponseSchema>;

export const UpdateBatchPricingRequestSchema = Type.Object(
  {
    sellingPrice: Type.Union([DecimalMoneyStringSchema, Type.Null()]),
    minSellingPrice: Type.Optional(Type.Union([DecimalMoneyStringSchema, Type.Null()])),
    maxDiscountPct: Type.Optional(Type.Union([DecimalPctStringSchema, Type.Null()])),
    batchPricingMode: Type.Optional(BatchPricingModeSchema),
    changeSource: Type.Optional(
      Type.Union([
        Type.Literal('MANUAL_UPDATE'),
        Type.Literal('SMART_PRICING_APPLIED'),
        Type.Literal('MANAGER_OVERRIDE'),
        Type.Literal('LEGACY_MIGRATION'),
      ]),
    ),
    reason: Type.Optional(Type.Union([Type.String({ maxLength: 500 }), Type.Null()])),
  },
  { additionalProperties: false },
);
export type UpdateBatchPricingRequest = Static<typeof UpdateBatchPricingRequestSchema>;

export const GenerateBatchBarcodeRequestSchema = Type.Object(
  {
    symbology: Type.Optional(Type.Literal('CODE128')),
    prefix: Type.Optional(Type.String({ minLength: 2, maxLength: 16 })),
    forceRegenerate: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type GenerateBatchBarcodeRequest = Static<typeof GenerateBatchBarcodeRequestSchema>;

export const GenerateBatchBarcodeResponseSchema = Type.Object({
  batchId: UuidSchema,
  internalBarcode: Type.String(),
  internalBarcodeType: Type.String(),
  alreadyExisted: Type.Boolean(),
});
export type GenerateBatchBarcodeResponse = Static<typeof GenerateBatchBarcodeResponseSchema>;

export const BatchBarcodePrintLogRequestSchema = Type.Object(
  {
    labelFormat: Type.Union([
      Type.Literal('40x30'),
      Type.Literal('50x30'),
      Type.Literal('50x40'),
      Type.Literal('58mm'),
      Type.Literal('80mm'),
      Type.Literal('A4'),
    ]),
    copies: Type.Integer({ minimum: 1, maximum: 5000 }),
    printerName: Type.Optional(Type.Union([Type.String({ maxLength: 160 }), Type.Null()])),
    printReason: Type.Optional(
      Type.Union([
        Type.Literal('INITIAL_RECEIVE'),
        Type.Literal('REPRINT'),
        Type.Literal('PRICE_CHANGED'),
        Type.Literal('DAMAGED_LABEL'),
      ]),
    ),
    deviceId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
  },
  { additionalProperties: false },
);
export type BatchBarcodePrintLogRequest = Static<typeof BatchBarcodePrintLogRequestSchema>;

export const BatchBarcodePrintLogResponseSchema = Type.Object({
  id: UuidSchema,
  tenantId: UuidSchema,
  batchId: UuidSchema,
  barcodeValue: Type.String(),
  labelFormat: Type.String(),
  copies: Type.Integer(),
  printedBy: Type.Union([UuidSchema, Type.Null()]),
  printerName: Type.Union([Type.String(), Type.Null()]),
  printReason: Type.String(),
  deviceId: Type.Union([UuidSchema, Type.Null()]),
  printedAt: IsoTimestampSchema,
});
export type BatchBarcodePrintLogResponse = Static<typeof BatchBarcodePrintLogResponseSchema>;

export const BatchPriceHistoryEntrySchema = Type.Object({
  id: UuidSchema,
  oldSellingPrice: Type.Union([DecimalMoneyStringSchema, Type.Null()]),
  newSellingPrice: Type.Union([DecimalMoneyStringSchema, Type.Null()]),
  oldMinSellingPrice: Type.Union([DecimalMoneyStringSchema, Type.Null()]),
  newMinSellingPrice: Type.Union([DecimalMoneyStringSchema, Type.Null()]),
  changeSource: Type.String(),
  reason: Type.Union([Type.String(), Type.Null()]),
  changedBy: Type.Union([UuidSchema, Type.Null()]),
  changedAt: IsoTimestampSchema,
});
export type BatchPriceHistoryEntry = Static<typeof BatchPriceHistoryEntrySchema>;

export const BatchHistoryResponseSchema = Type.Object({
  batch: BatchResponseSchema,
  priceHistory: Type.Array(BatchPriceHistoryEntrySchema),
  printLogs: Type.Array(BatchBarcodePrintLogResponseSchema),
  stockMovements: Type.Array(
    Type.Object({
      id: UuidSchema,
      movementType: StockMovementTypeSchema,
      quantityDelta: DecimalQuantityStringSchema,
      unitCost: DecimalMoneyStringSchema,
      totalCostDelta: DecimalMoneyStringSchema,
      referenceType: Type.String(),
      referenceId: UuidSchema,
      notes: Type.Union([Type.String(), Type.Null()]),
      createdAt: IsoTimestampSchema,
    }),
  ),
});
export type BatchHistoryResponse = Static<typeof BatchHistoryResponseSchema>;

export const TenantBrandingResponseSchema = Type.Object({
  tenantId: UuidSchema,
  name: Type.String(),
  shopDisplayName: Type.Union([Type.String(), Type.Null()]),
  logoUrl: Type.Union([Type.String(), Type.Null()]),
});
export type TenantBrandingResponse = Static<typeof TenantBrandingResponseSchema>;

export const UpdateTenantBrandingRequestSchema = Type.Object(
  {
    shopDisplayName: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 160 }), Type.Null()])),
    logoUrl: Type.Optional(Type.Union([Type.String({ maxLength: 2048 }), Type.Null()])),
  },
  { additionalProperties: false },
);
export type UpdateTenantBrandingRequest = Static<typeof UpdateTenantBrandingRequestSchema>;

export const StockTransferStatusSchema = Type.Union([
  Type.Literal('DRAFT'),
  Type.Literal('IN_TRANSIT'),
  Type.Literal('RECEIVED'),
  Type.Literal('CANCELLED'),
]);
export type StockTransferStatus = Static<typeof StockTransferStatusSchema>;

export const CreateStockTransferLineInputSchema = Type.Object(
  {
    productId: UuidSchema,
    sourceBatchId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
    serialIds: Type.Optional(Type.Array(UuidSchema, { minItems: 1, maxItems: 500 })),
    quantity: DecimalQuantityStringSchema,
    uomCode: Type.Optional(Type.String({ minLength: 1, maxLength: 32 })),
    notes: Type.Optional(Type.Union([Type.String({ maxLength: 500 }), Type.Null()])),
  },
  { additionalProperties: false },
);

export const CreateStockTransferRequestSchema = Type.Object(
  {
    sourceBranchId: UuidSchema,
    sourceWarehouseId: Type.Optional(UuidSchema),
    destinationBranchId: UuidSchema,
    destinationWarehouseId: Type.Optional(UuidSchema),
    autoComplete: Type.Optional(Type.Boolean()),
    notes: Type.Optional(Type.Union([Type.String({ maxLength: 500 }), Type.Null()])),
    lines: Type.Array(CreateStockTransferLineInputSchema, { minItems: 1, maxItems: 100 }),
  },
  { additionalProperties: false },
);
export type CreateStockTransferRequest = Static<typeof CreateStockTransferRequestSchema>;

export const StockTransferLineResponseSchema = Type.Object({
  id: UuidSchema,
  lineNumber: Type.Integer(),
  productId: UuidSchema,
  productSku: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  productName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  uomCode: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  sourceBatchId: Type.Union([UuidSchema, Type.Null()]),
  destinationBatchId: Type.Union([UuidSchema, Type.Null()]),
  serialId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
  serialNumber: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  quantity: Type.Optional(DecimalQuantityStringSchema),
  quantityRequested: DecimalQuantityStringSchema,
  quantityDispatched: DecimalQuantityStringSchema,
  quantityReceived: DecimalQuantityStringSchema,
  unitCostSnapshot: DecimalMoneyStringSchema,
  sellingPriceSnapshot: Type.Union([DecimalMoneyStringSchema, Type.Null()]),
  expiryDateSnapshot: Type.Union([Type.String(), Type.Null()]),
  batchNumberSnapshot: Type.Union([Type.String(), Type.Null()]),
  notes: Type.Union([Type.String(), Type.Null()]),
});
export type StockTransferLineResponse = Static<typeof StockTransferLineResponseSchema>;

export const StockTransferResponseSchema = Type.Object({
  id: UuidSchema,
  tenantId: UuidSchema,
  transferNumber: Type.String(),
  sourceBranchId: UuidSchema,
  sourceBranchCode: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  sourceBranchName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  sourceWarehouseId: UuidSchema,
  sourceWarehouseName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  destinationBranchId: UuidSchema,
  destinationBranchCode: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  destinationBranchName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  destinationWarehouseId: UuidSchema,
  destinationWarehouseName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  status: StockTransferStatusSchema,
  notes: Type.Union([Type.String(), Type.Null()]),
  dispatchedBy: Type.Union([UuidSchema, Type.Null()]),
  dispatchedAt: Type.Union([IsoTimestampSchema, Type.Null()]),
  receivedBy: Type.Union([UuidSchema, Type.Null()]),
  receivedAt: Type.Union([IsoTimestampSchema, Type.Null()]),
  createdBy: Type.Union([UuidSchema, Type.Null()]),
  createdByName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
  lines: Type.Array(StockTransferLineResponseSchema),
});
export type StockTransferResponse = Static<typeof StockTransferResponseSchema>;

export const ReceiveStockTransferRequestSchema = Type.Object(
  {
    notes: Type.Optional(Type.Union([Type.String({ maxLength: 500 }), Type.Null()])),
    lines: Type.Optional(
      Type.Array(
        Type.Object(
          {
            lineId: UuidSchema,
            quantityReceived: DecimalQuantityStringSchema,
          },
          { additionalProperties: false },
        ),
        { minItems: 1, maxItems: 100 },
      ),
    ),
  },
  { additionalProperties: false },
);
export type ReceiveStockTransferRequest = Static<typeof ReceiveStockTransferRequestSchema>;

export const ListStockTransfersQuerySchema = Type.Object(
  {
    status: Type.Optional(StockTransferStatusSchema),
    branchId: Type.Optional(UuidSchema),
    sourceBranchId: Type.Optional(UuidSchema),
    destinationBranchId: Type.Optional(UuidSchema),
    productId: Type.Optional(UuidSchema),
    search: Type.Optional(Type.String({ maxLength: 160 })),
    limit: Type.Optional(PaginationLimitQueryParamSchema),
  },
  { additionalProperties: false },
);
export type ListStockTransfersQuery = Static<typeof ListStockTransfersQuerySchema>;

export const StockTransferListResponseSchema = Type.Object({
  items: Type.Array(StockTransferResponseSchema),
});
export type StockTransferListResponse = Static<typeof StockTransferListResponseSchema>;

export const UomCorrectionPreviewRequestSchema = Type.Object(
  {
    targetBaseUom: Type.String({ minLength: 1, maxLength: 16 }),
    targetMeasurementCategory: Type.Optional(Type.Union([MeasurementCategorySchema, Type.Null()])),
    conversionFactorFromOldToNew: DecimalQuantityStringSchema,
  },
  { additionalProperties: false },
);
export type UomCorrectionPreviewRequest = Static<typeof UomCorrectionPreviewRequestSchema>;

export const UomCorrectionPreviewResponseSchema = Type.Object({
  productId: UuidSchema,
  currentBaseUom: Type.String(),
  targetBaseUom: Type.String(),
  conversionFactorFromOldToNew: DecimalQuantityStringSchema,
  currentTotalQtyInOldUom: DecimalQuantityStringSchema,
  projectedTotalQtyInNewUom: DecimalQuantityStringSchema,
  currentTotalValuation: DecimalMoneyStringSchema,
  projectedUnitCostInNewUom: DecimalMoneyStringSchema,
  affectedBalancesCount: Type.Integer(),
  affectedBatchesCount: Type.Integer(),
  affectedCostLayersCount: Type.Integer(),
  historicalLedgerEntriesCount: Type.Integer(),
  warnings: Type.Array(Type.String()),
});
export type UomCorrectionPreviewResponse = Static<typeof UomCorrectionPreviewResponseSchema>;

export const UomCorrectionExecuteRequestSchema = Type.Object(
  {
    targetBaseUom: Type.String({ minLength: 1, maxLength: 16 }),
    targetMeasurementCategory: Type.Optional(Type.Union([MeasurementCategorySchema, Type.Null()])),
    conversionFactorFromOldToNew: DecimalQuantityStringSchema,
    reason: Type.String({ minLength: 3, maxLength: 500 }),
  },
  { additionalProperties: false },
);
export type UomCorrectionExecuteRequest = Static<typeof UomCorrectionExecuteRequestSchema>;

export const UomCorrectionExecuteResponseSchema = Type.Object({
  product: ProductResponseSchema,
  rebasedBalancesCount: Type.Integer(),
  rebasedBatchesCount: Type.Integer(),
  rebasedCostLayersCount: Type.Integer(),
  previousTotalValuation: DecimalMoneyStringSchema,
  newTotalValuation: DecimalMoneyStringSchema,
  auditTrailEntryCount: Type.Integer(),
});
export type UomCorrectionExecuteResponse = Static<typeof UomCorrectionExecuteResponseSchema>;

// ============================================================================
// PHASE 8.6: CENTRALIZED MULTI-BRANCH BUSINESS DASHBOARD CONTRACTS
// ============================================================================

export const DashboardDatePresetSchema = Type.Union([
  Type.Literal('TODAY'),
  Type.Literal('YESTERDAY'),
  Type.Literal('THIS_WEEK'),
  Type.Literal('THIS_MONTH'),
  Type.Literal('CUSTOM'),
]);
export type DashboardDatePreset = Static<typeof DashboardDatePresetSchema>;

export const DashboardSummaryQuerySchema = Type.Object(
  {
    datePreset: Type.Optional(DashboardDatePresetSchema),
    startDate: Type.Optional(Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' })),
    endDate: Type.Optional(Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' })),
    branchId: Type.Optional(UuidSchema),
  },
  { additionalProperties: false },
);
export type DashboardSummaryQuery = Static<typeof DashboardSummaryQuerySchema>;

export const DashboardBranchMetricSchema = Type.Object({
  branchId: UuidSchema,
  branchCode: Type.String(),
  branchName: Type.String(),
  isMainBranch: Type.Boolean(),
  netSales: DecimalMoneyStringSchema,
  grossSales: DecimalMoneyStringSchema,
  refundTotal: DecimalMoneyStringSchema,
  ordersCount: Type.Integer(),
  voidedCount: Type.Integer(),
  returnsCount: Type.Integer(),
  averageOrderValue: DecimalMoneyStringSchema,
  inventoryValue: DecimalMoneyStringSchema,
  unitsOnHand: DecimalQuantityStringSchema,
  lowStockCount: Type.Integer(),
  outOfStockCount: Type.Integer(),
  confirmedCogs: DecimalMoneyStringSchema,
  grossProfit: DecimalMoneyStringSchema,
  costCoveragePct: Type.Number(),
  hasIncompleteCostData: Type.Boolean(),
});
export type DashboardBranchMetric = Static<typeof DashboardBranchMetricSchema>;

export const DashboardLowStockItemSchema = Type.Object({
  branchId: UuidSchema,
  branchName: Type.String(),
  warehouseId: UuidSchema,
  warehouseName: Type.String(),
  productId: UuidSchema,
  sku: Type.String(),
  productName: Type.String(),
  baseUom: Type.String(),
  qtyOnHand: DecimalQuantityStringSchema,
  availableQty: DecimalQuantityStringSchema,
  reorderPoint: DecimalQuantityStringSchema,
  stockState: StockAlertStateSchema,
});
export type DashboardLowStockItem = Static<typeof DashboardLowStockItemSchema>;

export const DashboardActivityItemSchema = Type.Object({
  id: Type.String(),
  activityType: Type.Union([
    Type.Literal('POS_SALE'),
    Type.Literal('POS_VOID'),
    Type.Literal('POS_RETURN'),
    Type.Literal('STOCK_TRANSFER'),
  ]),
  referenceNumber: Type.String(),
  branchId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
  branchName: Type.String(),
  description: Type.String(),
  amount: Type.Optional(Type.Union([DecimalMoneyStringSchema, Type.Null()])),
  actorName: Type.String(),
  occurredAt: IsoTimestampSchema,
});
export type DashboardActivityItem = Static<typeof DashboardActivityItemSchema>;

export const DashboardTrendPointSchema = Type.Object({
  date: Type.String(),
  netSales: DecimalMoneyStringSchema,
  ordersCount: Type.Integer(),
});
export type DashboardTrendPoint = Static<typeof DashboardTrendPointSchema>;

export const DashboardSummaryResponseSchema = Type.Object({
  scopeMode: Type.Union([Type.Literal('BUSINESS_WIDE'), Type.Literal('SINGLE_BRANCH')]),
  selectedBranchId: Type.Union([UuidSchema, Type.Null()]),
  selectedBranchName: Type.String(),
  datePreset: DashboardDatePresetSchema,
  startDate: Type.String(),
  endDate: Type.String(),
  currencyCode: CurrencyCodeSchema,
  allLocationsAccess: Type.Boolean(),
  kpis: Type.Object({
    totalSales: DecimalMoneyStringSchema,
    grossSales: DecimalMoneyStringSchema,
    refundTotal: DecimalMoneyStringSchema,
    totalOrders: Type.Integer(),
    voidedOrders: Type.Integer(),
    returnsCount: Type.Integer(),
    averageOrderValue: DecimalMoneyStringSchema,
    totalInventoryValue: DecimalMoneyStringSchema,
    totalUnitsOnHand: DecimalQuantityStringSchema,
    totalProducts: Type.Integer(),
    totalCustomers: Type.Integer(),
    activeBranchesCount: Type.Integer(),
    lowStockAlerts: Type.Integer(),
    outOfStockAlerts: Type.Integer(),
    confirmedCogs: DecimalMoneyStringSchema,
    grossProfit: DecimalMoneyStringSchema,
    grossMarginPct: Type.Number(),
    costCoveragePct: Type.Number(),
    hasIncompleteCostData: Type.Boolean(),
    incompleteCostLinesCount: Type.Integer(),
    totalSalesLinesCount: Type.Integer(),
  }),
  bestPerformingBranch: Type.Union([
    Type.Object({
      branchId: UuidSchema,
      branchCode: Type.String(),
      branchName: Type.String(),
      netSales: DecimalMoneyStringSchema,
      ordersCount: Type.Integer(),
      sharePct: Type.Number(),
    }),
    Type.Null(),
  ]),
  branchComparison: Type.Array(DashboardBranchMetricSchema),
  salesTrend: Type.Array(DashboardTrendPointSchema),
  lowStockWatchlist: Type.Array(DashboardLowStockItemSchema),
  recentActivities: Type.Array(DashboardActivityItemSchema),
});
export type DashboardSummaryResponse = Static<typeof DashboardSummaryResponseSchema>;

// ============================================================================
// PHASE 9.1 - 9.4: CROSS-PLATFORM OFFLINE FOUNDATION & LOCAL POS CONTRACTS
// ============================================================================

export const OfflineClientPlatformSchema = Type.Union([
  Type.Literal('TAURI_DESKTOP'),
  Type.Literal('MOBILE_APP'),
  Type.Literal('MOBILE_PWA'),
  Type.Literal('FLUTTER_MOBILE'),
  Type.Literal('WEB_BROWSER'),
]);
export type OfflineClientPlatform = Static<typeof OfflineClientPlatformSchema>;

export const OfflineCapabilityClassSchema = Type.Union([
  Type.Literal('OFFLINE_CAPABLE'),
  Type.Literal('ONLINE_ONLY'),
]);
export type OfflineCapabilityClass = Static<typeof OfflineCapabilityClassSchema>;

export const OfflineOperationKeySchema = Type.Union([
  Type.Literal('POS_SEARCH_CATALOG'),
  Type.Literal('POS_SCAN_BARCODE'),
  Type.Literal('POS_CART_MANAGE'),
  Type.Literal('POS_CASH_CHECKOUT'),
  Type.Literal('POS_LOCAL_RECEIPT'),
  Type.Literal('POS_RECOVERY'),
  Type.Literal('POS_CARD_GATEWAY'),
  Type.Literal('POS_CREDIT_CHECKOUT'),
  Type.Literal('PRICING_APPROVAL'),
  Type.Literal('INV_TRANSFER_APPROVAL'),
  Type.Literal('IAM_STAFF_INVITE'),
  Type.Literal('REPORT_DRILLDOWN'),
  Type.Literal('INV_OFFLINE_ADJUSTMENT'),
  Type.Literal('INV_OFFLINE_MOVEMENT'),
  Type.Literal('INV_OFFLINE_TRANSFER_REQUEST'),
  Type.Literal('INV_OFFLINE_BATCH_INSPECT'),
  Type.Literal('INV_OFFLINE_SERIAL_OPS'),
  Type.Literal('SYNC_RESOLVE_CONFLICT'),
]);
export type OfflineOperationKey = Static<typeof OfflineOperationKeySchema>;

export const LocalTransactionSyncStateSchema = Type.Union([
  Type.Literal('LOCAL_SAVED'),
  Type.Literal('PENDING_SYNC'),
  Type.Literal('SYNC_IN_FLIGHT'),
  Type.Literal('SERVER_CONFIRMED'),
  Type.Literal('CONFLICT_FLAGGED'),
  Type.Literal('QUARANTINED'),
]);
export type LocalTransactionSyncState = Static<typeof LocalTransactionSyncStateSchema>;

export const SubscriptionRuntimeSnapshotSchema = Type.Object({
  planCode: Type.String(),
  planName: Type.String(),
  status: SubscriptionStatusSchema,
  isReadOnly: Type.Boolean(),
  inGracePeriod: Type.Boolean(),
  gracePeriodEndsAt: Type.Union([IsoTimestampSchema, Type.Null()]),
  offlineEntitled: Type.Boolean(),
  features: Type.Record(Type.String(), Type.Boolean()),
  limits: Type.Object({
    maxBranches: Type.Integer(),
    maxUsers: Type.Integer(),
    maxProducts: Type.Integer(),
    maxStorageMb: Type.Integer(),
  }),
  evaluatedAt: IsoTimestampSchema,
});
export type SubscriptionRuntimeSnapshot = Static<
  typeof SubscriptionRuntimeSnapshotSchema
>;

export const OfflineDeviceContextSchema = Type.Object({
  deviceId: UuidSchema,
  tenantId: UuidSchema,
  branchId: UuidSchema,
  branchCode: Type.Optional(Type.String()),
  branchName: Type.Optional(Type.String()),
  warehouseId: UuidSchema,
  registerId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
  actorUserId: UuidSchema,
  roleCodes: Type.Array(Type.String()),
  permissions: Type.Array(Type.String()),
  allLocationsAccess: Type.Boolean(),
  allowedBranchIds: Type.Array(UuidSchema),
  clientPlatform: OfflineClientPlatformSchema,
  enrolledAt: IsoTimestampSchema,
  offlineAuthExpiresAt: IsoTimestampSchema,
  subscriptionSnapshot: Type.Optional(SubscriptionRuntimeSnapshotSchema),
});
export type OfflineDeviceContext = Static<typeof OfflineDeviceContextSchema>;

export const OfflineDataFreshnessSchema = Type.Object({
  tenantId: UuidSchema,
  branchId: UuidSchema,
  lastSuccessfulRefreshAt: Type.Union([IsoTimestampSchema, Type.Null()]),
  snapshotVersion: Type.Integer(),
  staleAfterMinutes: Type.Integer(),
  isStale: Type.Boolean(),
  counts: Type.Object({
    products: Type.Integer(),
    categories: Type.Integer(),
    barcodes: Type.Integer(),
    customers: Type.Integer(),
    batches: Type.Integer(),
    serials: Type.Integer(),
    pendingOutbox: Type.Integer(),
  }),
});
export type OfflineDataFreshness = Static<typeof OfflineDataFreshnessSchema>;

export const OfflineLocalInvoiceSchema = Type.Object({
  invoiceId: UuidSchema,
  tenantId: UuidSchema,
  branchId: UuidSchema,
  warehouseId: UuidSchema,
  registerId: UuidSchema,
  shiftId: Type.Union([UuidSchema, Type.Null()]),
  customerId: Type.Union([UuidSchema, Type.Null()]),
  customerName: Type.Union([Type.String(), Type.Null()]),
  cashierUserId: UuidSchema,
  invoiceNumber: Type.String(),
  currencyCode: CurrencyCodeSchema,
  subtotalAmount: DecimalMoneyStringSchema,
  discountAmount: DecimalMoneyStringSchema,
  taxAmount: DecimalMoneyStringSchema,
  grandTotal: DecimalMoneyStringSchema,
  totalPaid: DecimalMoneyStringSchema,
  changeGiven: DecimalMoneyStringSchema,
  syncState: LocalTransactionSyncStateSchema,
  serverConfirmed: Type.Boolean(),
  outboxCommandId: Type.Union([UuidSchema, Type.Null()]),
  conflictReason: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  createdAt: IsoTimestampSchema,
});
export type OfflineLocalInvoice = Static<typeof OfflineLocalInvoiceSchema>;

// ============================================================================
// Phase 9.5–9.9 — Offline Inventory, Sync Conflicts, Reconciliation & Security
// ============================================================================

export const SyncConflictStatusSchema = Type.Union([
  Type.Literal('OPEN'),
  Type.Literal('QUARANTINED'),
  Type.Literal('RESOLVED'),
  Type.Literal('DISMISSED'),
]);
export type SyncConflictStatus = Static<typeof SyncConflictStatusSchema>;

export const SyncConflictResolutionActionSchema = Type.Union([
  Type.Literal('ACCEPT_WITH_STOCK_OVERRIDE'),
  Type.Literal('RETRY_REPLAY'),
  Type.Literal('MARK_VOIDED_REFUND_REQUIRED'),
  Type.Literal('DISMISS'),
]);
export type SyncConflictResolutionAction = Static<
  typeof SyncConflictResolutionActionSchema
>;

export const SyncConflictRecordSchema = Type.Object({
  id: UuidSchema,
  tenantId: UuidSchema,
  branchId: UuidSchema,
  deviceId: UuidSchema,
  commandId: UuidSchema,
  commandType: Type.Optional(Type.String()),
  conflictType: Type.String(),
  status: SyncConflictStatusSchema,
  details: Type.Record(Type.String(), Type.Unknown()),
  originalPayload: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  resolutionAction: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  resolutionNotes: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  resolvedByUserId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
  createdAt: IsoTimestampSchema,
  resolvedAt: Type.Union([IsoTimestampSchema, Type.Null()]),
});
export type SyncConflictRecord = Static<typeof SyncConflictRecordSchema>;

export const ResolveSyncConflictRequestSchema = Type.Object({
  action: SyncConflictResolutionActionSchema,
  notes: Type.Optional(Type.String({ maxLength: 1000 })),
});
export type ResolveSyncConflictRequest = Static<
  typeof ResolveSyncConflictRequestSchema
>;

export const ResolveSyncConflictResponseSchema = Type.Object({
  conflict: SyncConflictRecordSchema,
  replayedReferenceId: Type.Optional(Type.String()),
  replayedReferenceNumber: Type.Optional(Type.String()),
});
export type ResolveSyncConflictResponse = Static<
  typeof ResolveSyncConflictResponseSchema
>;

export const EnrollOfflineDeviceRequestSchema = Type.Object({
  deviceId: UuidSchema,
  branchId: UuidSchema,
  clientPlatform: OfflineClientPlatformSchema,
  deviceName: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
  appVersion: Type.Optional(Type.String({ maxLength: 64 })),
});
export type EnrollOfflineDeviceRequest = Static<
  typeof EnrollOfflineDeviceRequestSchema
>;

export const OfflineDeviceRecordSchema = Type.Object({
  deviceId: UuidSchema,
  tenantId: UuidSchema,
  branchId: UuidSchema,
  userId: UuidSchema,
  clientPlatform: OfflineClientPlatformSchema,
  deviceName: Type.Union([Type.String(), Type.Null()]),
  status: Type.Union([Type.Literal('ACTIVE'), Type.Literal('REVOKED')]),
  revokedReason: Type.Union([Type.String(), Type.Null()]),
  enrolledAt: IsoTimestampSchema,
  lastSeenAt: IsoTimestampSchema,
  revokedAt: Type.Union([IsoTimestampSchema, Type.Null()]),
});
export type OfflineDeviceRecord = Static<typeof OfflineDeviceRecordSchema>;

export const RevokeOfflineDeviceRequestSchema = Type.Object({
  reason: Type.String({ minLength: 2, maxLength: 500 }),
});
export type RevokeOfflineDeviceRequest = Static<
  typeof RevokeOfflineDeviceRequestSchema
>;

export const SyncPullResponseSchema = Type.Object({
  serverTimestamp: IsoTimestampSchema,
  deviceAuthorized: Type.Boolean(),
  revokedReason: Type.Union([Type.String(), Type.Null()]),
  openConflictsCount: Type.Integer({ minimum: 0 }),
  openConflicts: Type.Array(SyncConflictRecordSchema),
  recentConfirmedCommands: Type.Array(
    Type.Object({
      commandId: UuidSchema,
      commandType: Type.String(),
      status: Type.String(),
      conflictCode: Type.Union([Type.String(), Type.Null()]),
      response: Type.Record(Type.String(), Type.Unknown()),
      processedAt: IsoTimestampSchema,
    }),
  ),
  snapshot: SyncCatalogPricingResponseSchema,
  subscriptionState: Type.Optional(SubscriptionRuntimeSnapshotSchema),
});
export type SyncPullResponse = Static<typeof SyncPullResponseSchema>;

export const OfflineInventoryHistoryEntrySchema = Type.Object({
  id: UuidSchema,
  commandId: UuidSchema,
  entryKind: Type.Union([
    Type.Literal('ADJUSTMENT'),
    Type.Literal('MOVEMENT'),
    Type.Literal('TRANSFER_REQUEST'),
    Type.Literal('SERIAL_OP'),
  ]),
  branchId: UuidSchema,
  warehouseId: UuidSchema,
  productId: UuidSchema,
  productSku: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  productName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  batchId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
  serialId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
  qtyDeltaMicro: Type.Integer(),
  reason: Type.Union([Type.String(), Type.Null()]),
  syncState: LocalTransactionSyncStateSchema,
  serverReferenceId: Type.Union([Type.String(), Type.Null()]),
  conflictReason: Type.Union([Type.String(), Type.Null()]),
  createdAt: IsoTimestampSchema,
});
export type OfflineInventoryHistoryEntry = Static<
  typeof OfflineInventoryHistoryEntrySchema
>;

// ============================================================================
// PHASE 10.1–10.4: SUBSCRIPTION PLANS, ENTITLEMENTS, LIFECYCLE & BILLING
// ============================================================================

export const SubscriptionPlanCodeSchema = Type.Union([
  Type.Literal('STARTER'),
  Type.Literal('PROFESSIONAL'),
  Type.Literal('ENTERPRISE'),
  Type.Literal('GROWTH'),
]);
export type SubscriptionPlanCodeContract = Static<typeof SubscriptionPlanCodeSchema>;

export const SubscriptionBillingCycleSchema = Type.Union([
  Type.Literal('MONTHLY'),
  Type.Literal('ANNUAL'),
]);
export type SubscriptionBillingCycle = Static<typeof SubscriptionBillingCycleSchema>;

export const PaymentSubmissionStatusSchema = Type.Union([
  Type.Literal('PENDING'),
  Type.Literal('SUBMITTED'),
  Type.Literal('UNDER_REVIEW'),
  Type.Literal('VERIFIED'),
  Type.Literal('REJECTED'),
  Type.Literal('FAILED'),
]);
export type PaymentSubmissionStatus = Static<typeof PaymentSubmissionStatusSchema>;

export const SubscriptionPlanCatalogItemSchema = Type.Object({
  id: UuidSchema,
  code: Type.String(),
  name: Type.String(),
  description: Type.String(),
  displayOrder: Type.Integer(),
  isPublic: Type.Boolean(),
  isCustomPricing: Type.Boolean(),
  currencyCode: CurrencyCodeSchema,
  monthlyPriceAmount: DecimalMoneyStringSchema,
  annualDiscountPct: Type.String(),
  annualTotalAmount: DecimalMoneyStringSchema,
  annualMonthlyEquivalent: DecimalMoneyStringSchema,
  annualSavingsAmount: DecimalMoneyStringSchema,
  additionalBranchMonthlyFee: Type.Union([DecimalMoneyStringSchema, Type.Null()]),
  trialDays: Type.Integer(),
  supportLevel: Type.String(),
  limits: Type.Object({
    maxBranches: Type.Integer(),
    maxWarehouses: Type.Integer(),
    maxRegisters: Type.Integer(),
    maxUsers: Type.Integer(),
    maxProducts: Type.Integer(),
    maxStorageMb: Type.Integer(),
  }),
  features: Type.Record(Type.String(), Type.Boolean()),
  version: Type.Integer(),
});
export type SubscriptionPlanCatalogItem = Static<
  typeof SubscriptionPlanCatalogItemSchema
>;

export const CalculateSubscriptionPricingRequestSchema = Type.Object(
  {
    planCode: SubscriptionPlanCodeSchema,
    billingCycle: SubscriptionBillingCycleSchema,
    additionalBranchCount: Type.Optional(Type.Integer({ minimum: 0, maximum: 500 })),
    prorateBranchDaysRemaining: Type.Optional(Type.Integer({ minimum: 0, maximum: 366 })),
    prorateCycleTotalDays: Type.Optional(Type.Integer({ minimum: 1, maximum: 366 })),
    customMonthlyPrice: Type.Optional(DecimalMoneyStringSchema),
  },
  { additionalProperties: false },
);
export type CalculateSubscriptionPricingRequest = Static<
  typeof CalculateSubscriptionPricingRequestSchema
>;

export const SubscriptionPricingQuoteResponseSchema = Type.Object({
  planCode: Type.String(),
  planName: Type.String(),
  billingCycle: SubscriptionBillingCycleSchema,
  currencyCode: CurrencyCodeSchema,
  isCustomPricing: Type.Boolean(),
  monthlyBaseAmount: DecimalMoneyStringSchema,
  planCycleGrossAmount: DecimalMoneyStringSchema,
  annualDiscountPct: Type.String(),
  annualDiscountAmount: DecimalMoneyStringSchema,
  planCycleNetAmount: DecimalMoneyStringSchema,
  additionalBranchCount: Type.Integer(),
  additionalBranchMonthlyFee: Type.Union([DecimalMoneyStringSchema, Type.Null()]),
  additionalBranchCycleAmount: DecimalMoneyStringSchema,
  proratedAdditionalBranchAmount: DecimalMoneyStringSchema,
  totalDueNow: DecimalMoneyStringSchema,
  recurringNextCycleTotal: DecimalMoneyStringSchema,
});
export type SubscriptionPricingQuoteResponse = Static<
  typeof SubscriptionPricingQuoteResponseSchema
>;

export const SubscriptionUsageSummarySchema = Type.Object({
  tenantId: UuidSchema,
  planCode: Type.String(),
  planName: Type.String(),
  status: SubscriptionStatusSchema,
  billingCycle: SubscriptionBillingCycleSchema,
  includedBranches: Type.Integer(),
  additionalBranchSlots: Type.Integer(),
  effectiveMaxBranches: Type.Integer(),
  activeBranchesCount: Type.Integer(),
  maxUsers: Type.Integer(),
  distinctActiveUsersCount: Type.Integer(),
  maxProducts: Type.Integer(),
  distinctProductsCount: Type.Integer(),
  maxStorageMb: Type.Integer(),
  usedStorageBytes: Type.Integer(),
  usedStorageMb: Type.String(),
  trialStartedAt: Type.Union([IsoTimestampSchema, Type.Null()]),
  trialEndsAt: Type.Union([IsoTimestampSchema, Type.Null()]),
  trialDaysRemaining: Type.Integer(),
  gracePeriodEndsAt: Type.Union([IsoTimestampSchema, Type.Null()]),
  graceDaysRemaining: Type.Integer(),
  scheduledDowngradePlanCode: Type.Union([Type.String(), Type.Null()]),
  scheduledDowngradeBillingCycle: Type.Union([SubscriptionBillingCycleSchema, Type.Null()]),
  scheduledDowngradeEffectiveAt: Type.Union([IsoTimestampSchema, Type.Null()]),
});
export type SubscriptionUsageSummary = Static<typeof SubscriptionUsageSummarySchema>;

export const StartFreeTrialRequestSchema = Type.Object(
  {
    planCode: Type.Optional(SubscriptionPlanCodeSchema),
  },
  { additionalProperties: false },
);
export type StartFreeTrialRequest = Static<typeof StartFreeTrialRequestSchema>;

export const UpgradeCheckoutRequestSchema = Type.Object(
  {
    targetPlanCode: SubscriptionPlanCodeSchema,
    billingCycle: SubscriptionBillingCycleSchema,
    additionalBranchCount: Type.Optional(Type.Integer({ minimum: 0, maximum: 500 })),
    notes: Type.Optional(Type.String({ maxLength: 500 })),
  },
  { additionalProperties: false },
);
export type UpgradeCheckoutRequest = Static<typeof UpgradeCheckoutRequestSchema>;

export const ScheduleDowngradeRequestSchema = Type.Object(
  {
    targetPlanCode: SubscriptionPlanCodeSchema,
    billingCycle: Type.Optional(SubscriptionBillingCycleSchema),
    reason: Type.Optional(Type.String({ maxLength: 500 })),
  },
  { additionalProperties: false },
);
export type ScheduleDowngradeRequest = Static<typeof ScheduleDowngradeRequestSchema>;

export const PurchaseBranchAddonRequestSchema = Type.Object(
  {
    additionalBranches: Type.Integer({ minimum: 1, maximum: 200 }),
    notes: Type.Optional(Type.String({ maxLength: 500 })),
  },
  { additionalProperties: false },
);
export type PurchaseBranchAddonRequest = Static<typeof PurchaseBranchAddonRequestSchema>;

export const SubscriptionBankSettingsResponseSchema = Type.Object({
  manualBankTransferEnabled: Type.Boolean(),
  bankAccountName: Type.String(),
  bankName: Type.String(),
  bankBranch: Type.String(),
  bankAccountNumber: Type.String(),
  bankInstructions: Type.String(),
  onlineGatewayEnabled: Type.Boolean(),
  onlineGatewayProvider: Type.String(),
  gracePeriodDays: Type.Integer(),
  trialDaysDefault: Type.Integer(),
  supportEmail: Type.Optional(Type.String()),
  supportPhone: Type.Optional(Type.String()),
  supportHours: Type.Optional(Type.String()),
});
export type SubscriptionBankSettingsResponse = Static<
  typeof SubscriptionBankSettingsResponseSchema
>;

export const UpdatePlatformBankSettingsRequestSchema = Type.Object(
  {
    manualBankTransferEnabled: Type.Optional(Type.Boolean()),
    bankAccountName: Type.Optional(Type.String({ minLength: 2, maxLength: 160 })),
    bankName: Type.Optional(Type.String({ minLength: 2, maxLength: 160 })),
    bankBranch: Type.Optional(Type.String({ minLength: 2, maxLength: 160 })),
    bankAccountNumber: Type.Optional(Type.String({ minLength: 4, maxLength: 80 })),
    bankInstructions: Type.Optional(Type.String({ minLength: 2, maxLength: 1000 })),
    onlineGatewayEnabled: Type.Optional(Type.Boolean()),
    onlineGatewayProvider: Type.Optional(
      Type.Union([
        Type.Literal('PAYHERE_LK'),
        Type.Literal('STRIPE'),
        Type.Literal('PADDLE'),
      ]),
    ),
    gracePeriodDays: Type.Optional(Type.Integer({ minimum: 1, maximum: 60 })),
    trialDaysDefault: Type.Optional(Type.Integer({ minimum: 1, maximum: 90 })),
    supportEmail: Type.Optional(Type.String({ minLength: 3, maxLength: 160 })),
    supportPhone: Type.Optional(Type.String({ minLength: 3, maxLength: 64 })),
    supportHours: Type.Optional(Type.String({ minLength: 2, maxLength: 160 })),
  },
  { additionalProperties: false },
);
export type UpdatePlatformBankSettingsRequest = Static<
  typeof UpdatePlatformBankSettingsRequestSchema
>;

export const SubmitManualBankTransferRequestSchema = Type.Object(
  {
    invoiceId: UuidSchema,
    paymentReference: Type.String({ minLength: 3, maxLength: 120 }),
    proofFileName: Type.String({ minLength: 3, maxLength: 255 }),
    proofMimeType: Type.Union([
      Type.Literal('image/jpeg'),
      Type.Literal('image/jpg'),
      Type.Literal('image/png'),
      Type.Literal('image/webp'),
      Type.Literal('application/pdf'),
    ]),
    proofDataBase64: Type.String({ minLength: 16 }),
    notes: Type.Optional(Type.String({ maxLength: 500 })),
    resubmitSubmissionId: Type.Optional(UuidSchema),
  },
  { additionalProperties: false },
);
export type SubmitManualBankTransferRequest = Static<
  typeof SubmitManualBankTransferRequestSchema
>;

export const SubscriptionPaymentSubmissionResponseSchema = Type.Object({
  id: UuidSchema,
  tenantId: UuidSchema,
  subscriptionId: UuidSchema,
  invoiceId: UuidSchema,
  invoiceNumber: Type.Optional(Type.String()),
  targetPlanCode: Type.Optional(Type.String()),
  targetBillingCycle: SubscriptionBillingCycleSchema,
  paymentChannel: Type.Union([
    Type.Literal('MANUAL_BANK_TRANSFER'),
    Type.Literal('ONLINE_GATEWAY'),
  ]),
  gatewayProvider: Type.Union([Type.String(), Type.Null()]),
  expectedAmount: DecimalMoneyStringSchema,
  submittedAmount: DecimalMoneyStringSchema,
  currencyCode: CurrencyCodeSchema,
  paymentReference: Type.String(),
  submissionNotes: Type.Union([Type.String(), Type.Null()]),
  proofFileName: Type.Union([Type.String(), Type.Null()]),
  proofMimeType: Type.Union([Type.String(), Type.Null()]),
  proofFileSize: Type.Union([Type.Integer(), Type.Null()]),
  status: PaymentSubmissionStatusSchema,
  submittedByUserId: UuidSchema,
  submittedAt: Type.Union([IsoTimestampSchema, Type.Null()]),
  reviewedByUserId: Type.Union([UuidSchema, Type.Null()]),
  reviewedAt: Type.Union([IsoTimestampSchema, Type.Null()]),
  rejectionReason: Type.Union([Type.String(), Type.Null()]),
  verifiedPaymentId: Type.Union([UuidSchema, Type.Null()]),
  createdAt: IsoTimestampSchema,
});
export type SubscriptionPaymentSubmissionResponse = Static<
  typeof SubscriptionPaymentSubmissionResponseSchema
>;

export const VerifyPaymentSubmissionRequestSchema = Type.Object(
  {
    tenantId: Type.Optional(UuidSchema),
    decision: Type.Union([
      Type.Literal('MARK_UNDER_REVIEW'),
      Type.Literal('APPROVE'),
      Type.Literal('REJECT'),
    ]),
    rejectionReason: Type.Optional(Type.String({ minLength: 5, maxLength: 500 })),
  },
  { additionalProperties: false },
);
export type VerifyPaymentSubmissionRequest = Static<
  typeof VerifyPaymentSubmissionRequestSchema
>;

export const OnlineGatewayCheckoutRequestSchema = Type.Object(
  {
    invoiceId: UuidSchema,
    providerCode: Type.Union([
      Type.Literal('PAYHERE_LK'),
      Type.Literal('STRIPE'),
      Type.Literal('PADDLE'),
    ]),
    returnUrl: Type.Optional(Type.String({ maxLength: 500 })),
    cancelUrl: Type.Optional(Type.String({ maxLength: 500 })),
  },
  { additionalProperties: false },
);
export type OnlineGatewayCheckoutRequest = Static<
  typeof OnlineGatewayCheckoutRequestSchema
>;

export const OnlineGatewayWebhookRequestSchema = Type.Object(
  {
    providerEventId: Type.String({ minLength: 3, maxLength: 160 }),
    submissionId: UuidSchema,
    tenantId: UuidSchema,
    gatewayTransactionId: Type.String({ minLength: 3, maxLength: 160 }),
    status: Type.Union([
      Type.Literal('VERIFIED'),
      Type.Literal('FAILED'),
      Type.Literal('CANCELLED'),
      Type.Literal('PENDING'),
    ]),
    paidAmount: DecimalMoneyStringSchema,
    currencyCode: CurrencyCodeSchema,
    rawPayload: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);
export type OnlineGatewayWebhookRequest = Static<
  typeof OnlineGatewayWebhookRequestSchema
>;

export const UpdatePlatformPlanConfigRequestSchema = Type.Object(
  {
    name: Type.Optional(Type.String({ minLength: 2, maxLength: 120 })),
    description: Type.Optional(Type.String({ maxLength: 500 })),
    monthlyPriceAmount: Type.Optional(DecimalMoneyStringSchema),
    annualDiscountPct: Type.Optional(Type.String({ pattern: '^\\d+(\\.\\d{1,2})?$' })),
    additionalBranchMonthlyFee: Type.Optional(
      Type.Union([DecimalMoneyStringSchema, Type.Null()]),
    ),
    maxBranches: Type.Optional(Type.Integer({ minimum: 1 })),
    maxUsers: Type.Optional(Type.Integer({ minimum: 1 })),
    maxProducts: Type.Optional(Type.Integer({ minimum: 1 })),
    maxStorageMb: Type.Optional(Type.Integer({ minimum: 1 })),
    trialDays: Type.Optional(Type.Integer({ minimum: 0, maximum: 90 })),
    isCustomPricing: Type.Optional(Type.Boolean()),
    supportLevel: Type.Optional(Type.String({ minLength: 2, maxLength: 120 })),
    features: Type.Optional(Type.Record(Type.String(), Type.Boolean())),
    changeReason: Type.Optional(Type.String({ minLength: 3, maxLength: 500 })),
  },
  { additionalProperties: false },
);
export type UpdatePlatformPlanConfigRequest = Static<
  typeof UpdatePlatformPlanConfigRequestSchema
>;

// ============================================================================
// Phase 10.5–10.9 — Super Admin, Business Portal, Analytics, MFA & Audit
// ============================================================================

export const PlatformAdminRoleSchema = Type.Union([
  Type.Literal('SUPER_ADMIN'),
  Type.Literal('BILLING_ADMIN'),
  Type.Literal('SUPPORT_ADMIN'),
  Type.Literal('ANALYST'),
]);
export type PlatformAdminRole = Static<typeof PlatformAdminRoleSchema>;

export const PlatformMfaVerifyRequestSchema = Type.Object(
  {
    code: Type.String({ pattern: '^[0-9]{6}$' }),
  },
  { additionalProperties: false },
);
export type PlatformMfaVerifyRequest = Static<
  typeof PlatformMfaVerifyRequestSchema
>;

export const PlatformProvisionAdminRequestSchema = Type.Object(
  {
    email: Type.String({ minLength: 3, maxLength: 255 }),
    platformRole: PlatformAdminRoleSchema,
    mfaEnforced: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type PlatformProvisionAdminRequest = Static<
  typeof PlatformProvisionAdminRequestSchema
>;

export const PlatformUpdateAdminRequestSchema = Type.Object(
  {
    platformRole: Type.Optional(PlatformAdminRoleSchema),
    status: Type.Optional(
      Type.Union([Type.Literal('ACTIVE'), Type.Literal('SUSPENDED')]),
    ),
    mfaEnforced: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type PlatformUpdateAdminRequest = Static<
  typeof PlatformUpdateAdminRequestSchema
>;

export const PlatformSuspendBusinessRequestSchema = Type.Object(
  {
    reason: Type.String({ minLength: 5, maxLength: 500 }),
  },
  { additionalProperties: false },
);
export type PlatformSuspendBusinessRequest = Static<
  typeof PlatformSuspendBusinessRequestSchema
>;

export const PlatformRestoreBusinessRequestSchema = Type.Object(
  {
    targetStatus: Type.Union([
      Type.Literal('ACTIVE'),
      Type.Literal('TRIALING'),
      Type.Literal('READ_ONLY'),
    ]),
    reason: Type.String({ minLength: 5, maxLength: 500 }),
  },
  { additionalProperties: false },
);
export type PlatformRestoreBusinessRequest = Static<
  typeof PlatformRestoreBusinessRequestSchema
>;

export const PlatformSubscriptionOverrideRequestSchema = Type.Object(
  {
    planCode: Type.Optional(SubscriptionPlanCodeSchema),
    status: Type.Optional(SubscriptionStatusSchema),
    billingCycle: Type.Optional(SubscriptionBillingCycleSchema),
    extendDays: Type.Optional(Type.Integer({ minimum: 1, maximum: 3650 })),
    extendGraceDays: Type.Optional(Type.Integer({ minimum: 1, maximum: 90 })),
    additionalBranchSlots: Type.Optional(Type.Integer({ minimum: 0, maximum: 500 })),
    customMonthlyPrice: Type.Optional(
      Type.Union([DecimalMoneyStringSchema, Type.Null()]),
    ),
    customMaxBranches: Type.Optional(Type.Union([Type.Integer({ minimum: 1 }), Type.Null()])),
    customMaxUsers: Type.Optional(Type.Union([Type.Integer({ minimum: 1 }), Type.Null()])),
    customMaxProducts: Type.Optional(Type.Union([Type.Integer({ minimum: 1 }), Type.Null()])),
    customMaxStorageMb: Type.Optional(Type.Union([Type.Integer({ minimum: 1 }), Type.Null()])),
    allowAdminOverride: Type.Optional(Type.Boolean()),
    reason: Type.String({ minLength: 5, maxLength: 500 }),
  },
  { additionalProperties: false },
);
export type PlatformSubscriptionOverrideRequest = Static<
  typeof PlatformSubscriptionOverrideRequestSchema
>;

export const PlatformAnalyticsQuerySchema = Type.Object(
  {
    startDate: Type.Optional(DateOnlyStringSchema),
    endDate: Type.Optional(DateOnlyStringSchema),
    planCode: Type.Optional(SubscriptionPlanCodeSchema),
    status: Type.Optional(SubscriptionStatusSchema),
  },
  { additionalProperties: false },
);
export type PlatformAnalyticsQuery = Static<typeof PlatformAnalyticsQuerySchema>;

export const SubscriptionNotificationSeveritySchema = Type.Union([
  Type.Literal('INFO'),
  Type.Literal('WARNING'),
  Type.Literal('CRITICAL'),
  Type.Literal('SUCCESS'),
]);
export type SubscriptionNotificationSeverity = Static<
  typeof SubscriptionNotificationSeveritySchema
>;

export const SubscriptionNotificationResponseSchema = Type.Object({
  id: UuidSchema,
  tenantId: UuidSchema,
  subscriptionId: UuidSchema,
  eventType: Type.String(),
  severity: SubscriptionNotificationSeveritySchema,
  title: Type.String(),
  message: Type.String(),
  isRead: Type.Boolean(),
  readAt: Type.Union([IsoTimestampSchema, Type.Null()]),
  createdAt: IsoTimestampSchema,
});
export type SubscriptionNotificationResponse = Static<
  typeof SubscriptionNotificationResponseSchema
>;

// ============================================================================
// Smart Stock Intake Lots & Stock Configuration Change Alerts Contracts
// ============================================================================

export const StockIntakeSourceMethodSchema = Type.Union([
  Type.Literal('GRN'),
  Type.Literal('OPENING_STOCK'),
  Type.Literal('STOCK_IN'),
  Type.Literal('ADJUSTMENT_POSITIVE'),
  Type.Literal('STOCKTAKE'),
  Type.Literal('TRANSFER_IN'),
  Type.Literal('LEGACY_BACKFILL'),
  Type.Literal('FIFO_LAYER_BACKFILL'),
]);
export type StockIntakeSourceMethod = Static<typeof StockIntakeSourceMethodSchema>;

export const StockIntakePricingModeSchema = Type.Union([
  Type.Literal('INHERIT_PRODUCT'),
  Type.Literal('INHERIT_BRANCH'),
  Type.Literal('INTAKE_SPECIFIC'),
]);
export type StockIntakePricingMode = Static<typeof StockIntakePricingModeSchema>;

export const StockIntakeStatusSchema = Type.Union([
  Type.Literal('ACTIVE'),
  Type.Literal('DEPLETED'),
  Type.Literal('INACTIVE'),
  Type.Literal('REVERSED'),
]);
export type StockIntakeStatus = Static<typeof StockIntakeStatusSchema>;

export const StockIntakeLotResponseSchema = Type.Object({
  id: UuidSchema,
  tenantId: UuidSchema,
  branchId: UuidSchema,
  warehouseId: UuidSchema,
  productId: UuidSchema,
  productSku: Type.Optional(Type.String()),
  productName: Type.Optional(Type.String()),
  batchId: Type.Union([UuidSchema, Type.Null()]),
  ledgerEntryId: Type.Union([UuidSchema, Type.Null()]),
  supplierId: Type.Union([UuidSchema, Type.Null()]),
  intakeCode: Type.String(),
  sourceMethod: StockIntakeSourceMethodSchema,
  sourceReferenceType: Type.Union([Type.String(), Type.Null()]),
  sourceReferenceId: Type.Union([Type.String(), Type.Null()]),
  receivedUom: Type.String(),
  receivedQty: DecimalQuantityStringSchema,
  conversionFactorToBase: DecimalQuantityStringSchema,
  baseQtyReceived: DecimalQuantityStringSchema,
  baseQtyRemaining: DecimalQuantityStringSchema,
  baseQtyReserved: DecimalQuantityStringSchema,
  purchaseCostPerReceivedUom: DecimalMoneyStringSchema,
  purchaseCostPerBaseUom: DecimalMoneyStringSchema,
  pricingMode: StockIntakePricingModeSchema,
  sellingUom: Type.String(),
  sellingPrice: Type.Union([DecimalMoneyStringSchema, Type.Null()]),
  effectiveSellingPrice: Type.Optional(DecimalMoneyStringSchema),
  minSellingPrice: Type.Union([DecimalMoneyStringSchema, Type.Null()]),
  maxDiscountPct: Type.Union([DecimalPctStringSchema, Type.Null()]),
  currencyCode: CurrencyCodeSchema,
  isLegacyAggregate: Type.Boolean(),
  status: StockIntakeStatusSchema,
  configSnapshot: Type.Record(Type.String(), Type.Unknown()),
  notes: Type.Union([Type.String(), Type.Null()]),
  receivedAt: IsoTimestampSchema,
  createdByUserId: Type.Union([UuidSchema, Type.Null()]),
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
});
export type StockIntakeLotResponse = Static<typeof StockIntakeLotResponseSchema>;

export const ListStockIntakeLotsQuerySchema = Type.Object(
  {
    branchId: Type.Optional(UuidSchema),
    warehouseId: Type.Optional(UuidSchema),
    productId: Type.Optional(UuidSchema),
    status: Type.Optional(StockIntakeStatusSchema),
    includeDepleted: Type.Optional(Type.Union([Type.Literal('true'), Type.Literal('false')])),
    limit: Type.Optional(PaginationLimitQueryParamSchema),
  },
  { additionalProperties: false },
);
export type ListStockIntakeLotsQuery = Static<typeof ListStockIntakeLotsQuerySchema>;

export const UpdateStockIntakeLotRequestSchema = Type.Object(
  {
    pricingMode: Type.Optional(StockIntakePricingModeSchema),
    sellingUom: Type.Optional(Type.String({ minLength: 1, maxLength: 16 })),
    sellingPrice: Type.Optional(Type.Union([DecimalMoneyStringSchema, Type.Null()])),
    minSellingPrice: Type.Optional(Type.Union([DecimalMoneyStringSchema, Type.Null()])),
    maxDiscountPct: Type.Optional(Type.Union([DecimalPctStringSchema, Type.Null()])),
    status: Type.Optional(
      Type.Union([Type.Literal('ACTIVE'), Type.Literal('INACTIVE')]),
    ),
    notes: Type.Optional(Type.Union([Type.String({ maxLength: 500 }), Type.Null()])),
  },
  { additionalProperties: false },
);
export type UpdateStockIntakeLotRequest = Static<typeof UpdateStockIntakeLotRequestSchema>;

export const StockConfigAlertSeveritySchema = Type.Union([
  Type.Literal('INFO'),
  Type.Literal('WARNING'),
  Type.Literal('CONFLICT'),
]);
export type StockConfigAlertSeverity = Static<typeof StockConfigAlertSeveritySchema>;

export const StockConfigAlertStatusSchema = Type.Union([
  Type.Literal('PENDING'),
  Type.Literal('RESOLVED'),
  Type.Literal('DISMISSED'),
]);
export type StockConfigAlertStatus = Static<typeof StockConfigAlertStatusSchema>;

export const StockConfigAlertResolutionActionSchema = Type.Union([
  Type.Literal('KEEP_GLOBAL_PRICE'),
  Type.Literal('SET_INTAKE_SPECIFIC_PRICE'),
  Type.Literal('CREATE_INTAKE_BARCODE'),
  Type.Literal('UPDATE_GLOBAL_WITH_APPROVAL'),
  Type.Literal('UPDATE_UOM_CONVERSION'),
  Type.Literal('DISMISS'),
]);
export type StockConfigAlertResolutionAction = Static<
  typeof StockConfigAlertResolutionActionSchema
>;

export const StockConfigAlertResponseSchema = Type.Object({
  id: UuidSchema,
  tenantId: UuidSchema,
  branchId: UuidSchema,
  warehouseId: UuidSchema,
  productId: UuidSchema,
  productSku: Type.Optional(Type.String()),
  productName: Type.Optional(Type.String()),
  baseUom: Type.Optional(Type.String()),
  stockIntakeLotId: Type.Union([UuidSchema, Type.Null()]),
  intakeCode: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  batchId: Type.Union([UuidSchema, Type.Null()]),
  ledgerEntryId: Type.Union([UuidSchema, Type.Null()]),
  priceSuggestionId: Type.Union([UuidSchema, Type.Null()]),
  sourceMethod: Type.String(),
  sourceEventKey: Type.String(),
  severity: StockConfigAlertSeveritySchema,
  changeTypes: Type.Array(Type.String()),
  previousConfig: Type.Record(Type.String(), Type.Unknown()),
  incomingConfig: Type.Record(Type.String(), Type.Unknown()),
  summary: Type.String(),
  impactExplanation: Type.String(),
  recommendedAction: Type.String(),
  status: StockConfigAlertStatusSchema,
  resolutionAction: Type.Union([StockConfigAlertResolutionActionSchema, Type.Null()]),
  resolutionNotes: Type.Union([Type.String(), Type.Null()]),
  resolutionPayload: Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()]),
  createdByUserId: Type.Union([UuidSchema, Type.Null()]),
  resolvedByUserId: Type.Union([UuidSchema, Type.Null()]),
  createdAt: IsoTimestampSchema,
  resolvedAt: Type.Union([IsoTimestampSchema, Type.Null()]),
  updatedAt: IsoTimestampSchema,
});
export type StockConfigAlertResponse = Static<typeof StockConfigAlertResponseSchema>;

export const ListStockConfigAlertsQuerySchema = Type.Object(
  {
    branchId: Type.Optional(UuidSchema),
    warehouseId: Type.Optional(UuidSchema),
    productId: Type.Optional(UuidSchema),
    stockIntakeLotId: Type.Optional(UuidSchema),
    status: Type.Optional(StockConfigAlertStatusSchema),
    severity: Type.Optional(StockConfigAlertSeveritySchema),
    limit: Type.Optional(PaginationLimitQueryParamSchema),
  },
  { additionalProperties: false },
);
export type ListStockConfigAlertsQuery = Static<typeof ListStockConfigAlertsQuerySchema>;

export const ResolveStockConfigAlertRequestSchema = Type.Object(
  {
    action: StockConfigAlertResolutionActionSchema,
    sellingPrice: Type.Optional(DecimalMoneyStringSchema),
    sellingUom: Type.Optional(Type.String({ minLength: 1, maxLength: 16 })),
    barcode: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    barcodeType: Type.Optional(BarcodeTypeSchema),
    uomCode: Type.Optional(Type.String({ minLength: 1, maxLength: 16 })),
    conversionFactorToBase: Type.Optional(DecimalQuantityStringSchema),
    notes: Type.Optional(Type.Union([Type.String({ maxLength: 500 }), Type.Null()])),
  },
  { additionalProperties: false },
);
export type ResolveStockConfigAlertRequest = Static<
  typeof ResolveStockConfigAlertRequestSchema
>;






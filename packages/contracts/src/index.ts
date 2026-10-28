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
  Type.Literal('SUB_SUBSCRIPTION_INACTIVE'),
  Type.Literal('SUB_TRIAL_EXPIRED'),
  Type.Literal('SUB_QUOTA_EXCEEDED'),
  Type.Literal('CAT_DUPLICATE_CATEGORY_NAME'),
  Type.Literal('CAT_CIRCULAR_CATEGORY_HIERARCHY'),
  Type.Literal('CAT_CATEGORY_HAS_ACTIVE_CHILDREN_OR_PRODUCTS'),
  Type.Literal('CAT_DUPLICATE_SKU'),
  Type.Literal('CAT_DUPLICATE_BARCODE'),
  Type.Literal('CAT_INVALID_UOM_CONVERSION'),
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
  Type.Literal('POS_NO_ACTIVE_SHIFT'),
  Type.Literal('POS_SHIFT_NOT_FOUND'),
  Type.Literal('POS_SHIFT_ALREADY_CLOSED'),
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
  Type.Literal('INV_SERIAL_NOT_AVAILABLE'),
  Type.Literal('INV_SERIAL_ALREADY_SOLD'),
  Type.Literal('INV_SERIAL_MISMATCH'),
  Type.Literal('INV_SERIAL_INVALID_TRANSITION'),
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
  Type.Literal('ERR_INTERNAL_SERVER_ERROR'),
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
      conflictCode: Type.Optional(Type.String()),
      errorMessage: Type.Optional(Type.String()),
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
  Type.Literal('PAST_DUE'),
  Type.Literal('GRACE_PERIOD'),
  Type.Literal('SUSPENDED'),
  Type.Literal('CANCELLED'),
]);
export type SubscriptionStatus = Static<typeof SubscriptionStatusSchema>;

export const CreateBranchRequestSchema = Type.Object(
  {
    code: Type.String({ minLength: 2, maxLength: 32 }),
    name: Type.String({ minLength: 2, maxLength: 120 }),
    timezone: Type.String({ minLength: 2, maxLength: 64 }),
    countryCode: Type.String({ pattern: '^[A-Z]{2}$' }),
  },
  { additionalProperties: false },
);
export type CreateBranchRequest = Static<typeof CreateBranchRequestSchema>;

export const BranchResponseSchema = Type.Object({
  id: UuidSchema,
  tenantId: UuidSchema,
  code: Type.String(),
  name: Type.String(),
  timezone: Type.String(),
  countryCode: Type.String(),
  isActive: Type.Boolean(),
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
  Type.Integer({ minimum: 1, maximum: 100 }),
  Type.String({ pattern: '^(?:[1-9]\\d?|100)$' }),
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
  Type.Literal('UPCA'),
  Type.Literal('CODE128'),
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
  },
  { additionalProperties: false },
);
export type ProductBarcodeInput = Static<typeof ProductBarcodeInputSchema>;

export const ProductUnitConversionInputSchema = Type.Object(
  {
    uomCode: Type.String({ minLength: 1, maxLength: 16 }),
    uomName: Type.String({ minLength: 1, maxLength: 64 }),
    conversionFactorToBase: DecimalQuantityStringSchema,
  },
  { additionalProperties: false },
);
export type ProductUnitConversionInput = Static<
  typeof ProductUnitConversionInputSchema
>;

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
    purchaseCost: DecimalMoneyStringSchema,
    sellingPrice: DecimalMoneyStringSchema,
    taxGroupId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
    trackInventory: Type.Optional(Type.Boolean()),
    reorderPoint: Type.Optional(DecimalQuantityStringSchema),
    reorderQty: Type.Optional(DecimalQuantityStringSchema),
    imageUrl: Type.Optional(
      Type.Union([Type.String({ maxLength: 500 }), Type.Null()]),
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
    purchaseCost: Type.Optional(DecimalMoneyStringSchema),
    sellingPrice: Type.Optional(DecimalMoneyStringSchema),
    taxGroupId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
    reorderPoint: Type.Optional(DecimalQuantityStringSchema),
    reorderQty: Type.Optional(DecimalQuantityStringSchema),
    imageUrl: Type.Optional(
      Type.Union([Type.String({ maxLength: 500 }), Type.Null()]),
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

export const ProductBarcodeResponseSchema = Type.Object({
  id: UuidSchema,
  barcode: Type.String(),
  barcodeType: BarcodeTypeSchema,
  uomCode: Type.String(),
  isPrimary: Type.Boolean(),
});
export type ProductBarcodeResponse = Static<
  typeof ProductBarcodeResponseSchema
>;

export const ProductUnitConversionResponseSchema = Type.Object({
  id: UuidSchema,
  uomCode: Type.String(),
  uomName: Type.String(),
  conversionFactorToBase: DecimalQuantityStringSchema,
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
  syncVersion: Type.Integer(),
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
  archivedAt: Type.Union([IsoTimestampSchema, Type.Null()]),
});
export type ProductResponse = Static<typeof ProductResponseSchema>;

// 3. Supplier Contracts (/v1/suppliers)
export const CreateSupplierRequestSchema = Type.Object(
  {
    code: Type.String({ minLength: 1, maxLength: 32 }),
    businessName: Type.String({ minLength: 1, maxLength: 160 }),
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
  },
  { additionalProperties: false },
);
export type CreateSupplierRequest = Static<typeof CreateSupplierRequestSchema>;

export const UpdateSupplierRequestSchema = Type.Object(
  {
    code: Type.Optional(Type.String({ minLength: 1, maxLength: 32 })),
    businessName: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
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
  contactPerson: Type.Union([Type.String(), Type.Null()]),
  email: Type.Union([Type.String(), Type.Null()]),
  phone: Type.Union([Type.String(), Type.Null()]),
  address: Type.Union([Type.String(), Type.Null()]),
  taxRegistrationNumber: Type.Union([Type.String(), Type.Null()]),
  notes: Type.Union([Type.String(), Type.Null()]),
  status: RecordLifecycleStatusSchema,
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
    ]),
    quantity: DecimalQuantityStringSchema,
    uomCode: Type.Optional(Type.String({ minLength: 1, maxLength: 16 })),
    unitCost: Type.Optional(DecimalMoneyStringSchema),
    referenceType: Type.Optional(
      Type.Union([Type.String({ maxLength: 64 }), Type.Null()]),
    ),
    referenceId: Type.Optional(
      Type.Union([Type.String({ maxLength: 120 }), Type.Null()]),
    ),
    reason: Type.Optional(
      Type.Union([Type.String({ maxLength: 500 }), Type.Null()]),
    ),
    occurredAt: Type.Optional(IsoTimestampSchema),
    allowNegativeStockOverride: Type.Optional(Type.Boolean()),
    overrideReason: Type.Optional(
      Type.Union([Type.String({ maxLength: 500 }), Type.Null()]),
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
  batchId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
  serialId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
  supplierId: Type.Union([UuidSchema, Type.Null()]),
  movementType: StockMovementTypeSchema,
  uomCode: Type.String(),
  inputQty: DecimalQuantityStringSchema,
  conversionFactorToBase: DecimalQuantityStringSchema,
  qtyDelta: DecimalQuantityStringSchema,
  balanceBefore: DecimalQuantityStringSchema,
  balanceAfter: DecimalQuantityStringSchema,
  unitCost: DecimalMoneyStringSchema,
  totalCostDelta: Type.Optional(DecimalMoneyStringSchema),
  referenceType: Type.Union([Type.String(), Type.Null()]),
  referenceId: Type.Union([Type.String(), Type.Null()]),
  reversedEntryId: Type.Union([UuidSchema, Type.Null()]),
  reason: Type.Union([Type.String(), Type.Null()]),
  negativeStockOverrideApplied: Type.Boolean(),
  actorUserId: UuidSchema,
  idempotencyKey: UuidSchema,
  occurredAt: IsoTimestampSchema,
  recordedAt: IsoTimestampSchema,
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
  warehouseId: UuidSchema,
  code: Type.String(),
  name: Type.String(),
  isActive: Type.Boolean(),
});
export type PosRegisterSummaryResponse = Static<
  typeof PosRegisterSummaryResponseSchema
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
    notes: Type.Optional(Type.String({ maxLength: 500 })),
  },
  { additionalProperties: false },
);
export type OpenPosShiftRequest = Static<
  typeof OpenPosShiftRequestSchema
>;

export const ClosePosShiftRequestSchema = Type.Object(
  {
    countedClosingCash: DecimalMoneyStringSchema,
    notes: Type.Optional(Type.String({ maxLength: 500 })),
  },
  { additionalProperties: false },
);
export type ClosePosShiftRequest = Static<
  typeof ClosePosShiftRequestSchema
>;

export const PosShiftResponseSchema = Type.Object({
  id: UuidSchema,
  branchId: UuidSchema,
  registerId: UuidSchema,
  openedByUserId: UuidSchema,
  closedByUserId: Type.Union([UuidSchema, Type.Null()]),
  currencyCode: CurrencyCodeSchema,
  openingCashFloat: DecimalMoneyStringSchema,
  expectedClosingCash: DecimalMoneyStringSchema,
  countedClosingCash: Type.Union([DecimalMoneyStringSchema, Type.Null()]),
  cashVariance: Type.Union([DecimalMoneyStringSchema, Type.Null()]),
  status: Type.Union([Type.Literal('OPEN'), Type.Literal('CLOSED')]),
  openedAt: IsoTimestampSchema,
  closedAt: Type.Union([IsoTimestampSchema, Type.Null()]),
  notes: Type.Union([Type.String(), Type.Null()]),
});
export type PosShiftResponse = Static<typeof PosShiftResponseSchema>;

export const GetActivePosShiftQuerySchema = Type.Object(
  {
    registerId: UuidSchema,
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
    categoryId: Type.Optional(UuidSchema),
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
  retailPrice: DecimalMoneyStringSchema,
  trackInventory: Type.Boolean(),
  availableQuantity: DecimalQuantityStringSchema,
  barcodes: Type.Array(Type.String()),
  categoryName: Type.Union([Type.String(), Type.Null()]),
});
export type PosProductItemResponse = Static<
  typeof PosProductItemResponseSchema
>;

export const CheckoutCartLineInputSchema = Type.Object(
  {
    productId: UuidSchema,
    quantity: DecimalQuantityStringSchema,
    uomCode: Type.Optional(Type.String({ minLength: 1, maxLength: 20 })),
    discountAmount: Type.Optional(DecimalMoneyStringSchema),
    batchId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
    serialId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
    serialNumber: Type.Optional(
      Type.Union([Type.String({ minLength: 1, maxLength: 100 }), Type.Null()]),
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
    shiftId: Type.Optional(UuidSchema),
    lines: Type.Array(CheckoutCartLineInputSchema, { minItems: 1 }),
    orderDiscountAmount: Type.Optional(DecimalMoneyStringSchema),
    payments: Type.Array(CheckoutPaymentInputSchema, { minItems: 1 }),
    customerName: Type.Optional(Type.String({ maxLength: 255 })),
    notes: Type.Optional(Type.String({ maxLength: 500 })),
    allowNegativeStockOverride: Type.Optional(Type.Boolean()),
    overrideReason: Type.Optional(Type.String({ minLength: 3, maxLength: 500 })),
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
  serialId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
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
  warehouseId: UuidSchema,
  registerId: UuidSchema,
  shiftId: Type.Union([UuidSchema, Type.Null()]),
  cashierUserId: UuidSchema,
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
  serialId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
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
]);
export type BatchStatus = Static<typeof BatchStatusSchema>;

export const BatchExpiryStatusSchema = Type.Union([
  Type.Literal('VALID'),
  Type.Literal('EXPIRING_SOON'),
  Type.Literal('EXPIRED'),
]);
export type BatchExpiryStatus = Static<typeof BatchExpiryStatusSchema>;

export const CreateBatchRequestSchema = Type.Object(
  {
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
    currencyCode: Type.Optional(CurrencyCodeSchema),
  },
  { additionalProperties: false },
);
export type CreateBatchRequest = Static<typeof CreateBatchRequestSchema>;

export const BatchResponseSchema = Type.Object({
  id: UuidSchema,
  tenantId: UuidSchema,
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
  unitCost: DecimalMoneyStringSchema,
  currencyCode: CurrencyCodeSchema,
  expiryStatus: BatchExpiryStatusSchema,
  quarantineReason: Type.Union([Type.String(), Type.Null()]),
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
});
export type BatchResponse = Static<typeof BatchResponseSchema>;

export const ListBatchesQuerySchema = Type.Object(
  {
    productId: Type.Optional(UuidSchema),
    warehouseId: Type.Optional(UuidSchema),
    status: Type.Optional(BatchStatusSchema),
    expiryStatus: Type.Optional(BatchExpiryStatusSchema),
    expiringWithinDays: Type.Optional(Type.Integer({ minimum: 1, maximum: 365 })),
    search: Type.Optional(Type.String({ maxLength: 64 })),
    limit: Type.Optional(PaginationLimitQueryParamSchema),
    cursor: Type.Optional(UuidSchema),
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
  expiryDate: Type.Union([Type.String(), Type.Null()]),
  availableQty: DecimalQuantityStringSchema,
  allocatedQty: DecimalQuantityStringSchema,
  unitCost: DecimalMoneyStringSchema,
});
export type FefoBatchAllocation = Static<typeof FefoBatchAllocationSchema>;

export const FefoSelectionResponseSchema = Type.Object({
  productId: UuidSchema,
  warehouseId: UuidSchema,
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
    serialNumbers: Type.Array(Type.String({ minLength: 1, maxLength: 100 }), {
      minItems: 1,
      maxItems: 1000,
    }),
    unitCost: DecimalMoneyStringSchema,
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
  warehouseId: UuidSchema,
  branchId: UuidSchema,
  serialNumber: Type.String(),
  status: SerialStatusSchema,
  unitCost: DecimalMoneyStringSchema,
  currencyCode: CurrencyCodeSchema,
  receivedAt: IsoTimestampSchema,
  soldAt: Type.Union([IsoTimestampSchema, Type.Null()]),
  lastMovementId: Type.Union([UuidSchema, Type.Null()]),
  lastSaleInvoiceId: Type.Union([UuidSchema, Type.Null()]),
  notes: Type.Union([Type.String(), Type.Null()]),
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
});
export type SerialResponse = Static<typeof SerialResponseSchema>;

export const ListSerialsQuerySchema = Type.Object(
  {
    productId: Type.Optional(UuidSchema),
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
});
export type BranchSummary = Static<typeof BranchSummarySchema>;

export const TenantMembershipSummarySchema = Type.Object({
  tenantId: UuidSchema,
  businessName: Type.String(),
  slug: Type.String(),
  baseCurrency: CurrencyCodeSchema,
  status: Type.String(),
  role: Type.String(),
  branches: Type.Array(BranchSummarySchema),
});
export type TenantMembershipSummary = Static<
  typeof TenantMembershipSummarySchema
>;

export const AuthUserSummarySchema = Type.Object({
  id: UuidSchema,
  email: Type.String(),
  fullName: Type.String(),
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



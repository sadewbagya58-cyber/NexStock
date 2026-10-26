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
  Type.Literal('INV_INSUFFICIENT_AVAILABLE_STOCK'),
  Type.Literal('POS_SHIFT_NOT_OPEN'),
  Type.Literal('SYNC_COMMAND_QUARANTINED'),
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


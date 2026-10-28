import swagger from '@fastify/swagger';
import {
  type TypeBoxTypeProvider,
  TypeBoxValidatorCompiler,
} from '@fastify/type-provider-typebox';
import {
  AuthenticatedIdempotentHeadersSchema,
  AuthenticatedTenantHeadersSchema,
  BatchResponseSchema,
  BranchResponseSchema,
  CategoryResponseSchema,
  ClosePosShiftRequestSchema,
  CreateBatchRequestSchema,
  CreateBranchRequestSchema,
  CreateCategoryRequestSchema,
  CreateExchangeRateRequestSchema,
  CreatePosSaleRequestSchema,
  CreateProductRequestSchema,
  CreateStocktakeSessionRequestSchema,
  CreateSupplierRequestSchema,
  CreateWarehouseRequestSchema,
  CurrencyCodeSchema,
  DecimalMoneyStringSchema,
  DecimalQuantityStringSchema,
  FefoSelectionResponseSchema,
  FifoCostLayerResponseSchema,
  GetActivePosShiftQuerySchema,
  HealthStatusResponseSchema,
  IdempotentMutationHeadersSchema,
  InventoryBalanceResponseSchema,
  InventoryReconciliationResponseSchema,
  InventoryValuationResponseSchema,
  LinkSupplierProductRequestSchema,
  ListBatchesQuerySchema,
  ListCategoriesQuerySchema,
  ListInventoryBalancesQuerySchema,
  ListPosRegistersQuerySchema,
  ListProductsQuerySchema,
  ListSalesQuerySchema,
  ListSerialsQuerySchema,
  ListStockMovementsQuerySchema,
  ListStocktakeSessionsQuerySchema,
  ListSuppliersQuerySchema,
  LoginRequestSchema,
  LoginResponseSchema,
  OnboardBusinessRequestSchema,
  OnboardBusinessResponseSchema,
  OpenPosShiftRequestSchema,
  PasswordResetRequestSchema,
  PosProductItemResponseSchema,
  PosProductSearchQuerySchema,
  PosRegisterSummaryResponseSchema,
  PosShiftResponseSchema,
  PostStockMovementRequestSchema,
  ProblemDetailsSchema,
  ProductResponseSchema,
  QuarantineBatchRequestSchema,
  ReceiptResponseSchema,
  RecordStocktakeCountRequestSchema,
  RecordSubscriptionPaymentRequestSchema,
  RefreshTokenRequestSchema,
  RegisterSerialStockRequestSchema,
  ReverseStockMovementRequestSchema,
  ReviewStocktakeRequestSchema,
  SalesInvoiceResponseSchema,
  SerialResponseSchema,
  SignUpRequestSchema,
  SignUpResponseSchema,
  StockMovementResponseSchema,
  StocktakeSessionResponseSchema,
  SubscriptionStatusSchema,
  SupplierProductResponseSchema,
  SupplierResponseSchema,
  SyncPushBatchRequestSchema,
  SyncPushBatchResponseSchema,
  TenantContextHeadersSchema,
  TenantMembershipSummarySchema,
  TransitionSerialStatusRequestSchema,
  UpdateCategoryRequestSchema,
  UpdateProductRequestSchema,
  UpdateSupplierRequestSchema,
  UpsertLocalizationSettingsRequestSchema,
  UserMeResponseSchema,
  UuidSchema,
  VoidSaleRequestSchema,
  WarehouseResponseSchema,
  createCursorPageResponseSchema,
} from '@nexstock/contracts';
import { Type } from '@sinclair/typebox';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import {
  archiveCategory,
  archiveProduct,
  createCategory,
  createProduct,
  getCategoryById,
  getProductById,
  listCategories,
  listProducts,
  updateCategory,
  updateProduct,
} from './modules/cat/index.js';
import {
  convertTenantCurrencyAmount,
  recordTenantExchangeRate,
  upsertTenantLocalizationSettings,
} from './modules/i18n/index.js';
import {
  type AuthServiceConfig,
  DEFAULT_SUPABASE_URL,
  type JwksKeyProvider,
  type JwtVerificationOptions,
  RemoteJwksProvider,
  type SystemRoleCode,
  assertAuthorized,
  getUserProfileAndMemberships,
  handleLogin,
  handleLogout,
  handlePasswordResetRequest,
  handleRefreshToken,
  handleSignUp,
  provisionTenantMember,
  verifySupabaseJwt,
} from './modules/iam/index.js';
import {
  createBatch,
  createStocktakeSession,
  getBatchById,
  getInventoryValuation,
  getSerialById,
  getStockMovementById,
  getStocktakeSessionById,
  listBatches,
  listFifoCostLayers,
  listInventoryBalances,
  listSerials,
  listStockMovements,
  listStocktakeSessions,
  postStockMovement,
  postStocktakeAdjustments,
  quarantineBatch,
  reconcileInventoryBalances,
  recordStocktakeCounts,
  registerSerialStock,
  releaseBatch,
  reverseStockMovement,
  reviewStocktakeSession,
  selectFefoBatches,
  submitStocktakeSession,
  transitionSerialStatus,
} from './modules/inv/index.js';
import {
  createBranch,
  createWarehouse,
  getBranchById,
  listBranches,
  onboardBusinessAtomic,
  onboardTenantOrganization,
  updateBranchName,
} from './modules/org/index.js';
import {
  archiveSupplier,
  createSupplier,
  getSupplierById,
  linkSupplierProduct,
  listSuppliers,
  updateSupplier,
} from './modules/pur/index.js';
import {
  checkoutSale,
  closePosShift,
  getActivePosShift,
  getReceiptData,
  getSaleById,
  listAuthorizedRegisters,
  listSales,
  openPosShift,
  searchPosProducts,
  voidSale,
} from './modules/pos/index.js';
import {
  AppError,
  type NexStockDatabase,
  SyncPoisonPillError,
  appendAuditLog,
  assertActiveRoleEnforcesRls,
  enqueueOutboxEvent,
  executeIdempotentMutation,
  generateUuidV7,
  processSyncCommandBatch,
  sanitizeLogMessage,
  withTenantTransaction,
} from './modules/shared/index.js';
import {
  type SubscriptionPlanCode,
  assertSubscriptionEntitlement,
  defaultManualBillingAdapter,
  getTenantSubscriptionEntitlement,
  issueSubscriptionInvoice,
  updateSubscriptionLifecycleAndOverride,
} from './modules/sub/index.js';

export { DEFAULT_SUPABASE_URL };
export const DEFAULT_SUPABASE_JWKS_URL = `${DEFAULT_SUPABASE_URL}/auth/v1/.well-known/jwks.json`;
export const DEFAULT_SUPABASE_JWT_ISSUER = `${DEFAULT_SUPABASE_URL}/auth/v1`;
export const DEFAULT_SUPABASE_JWT_AUDIENCE = 'authenticated';

export interface BuildAppOptions {
  readonly db: Kysely<NexStockDatabase>;
  readonly jwksProvider?: JwksKeyProvider | undefined;
  readonly jwtVerificationOptions?: Partial<JwtVerificationOptions> | undefined;
  readonly authServiceConfig?: AuthServiceConfig | undefined;
}

const KernelAuditMutationBodySchema = Type.Object(
  {
    action: Type.String({ minLength: 1, maxLength: 120 }),
    resourceType: Type.String({ minLength: 1, maxLength: 80 }),
    resourceId: UuidSchema,
    amount: DecimalMoneyStringSchema,
    simulateFailureAfterInsert: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

const KernelAuditMutationResponseSchema = Type.Object({
  auditLogId: UuidSchema,
  outboxEventId: UuidSchema,
  tenantId: UuidSchema,
  action: Type.String(),
  amount: DecimalMoneyStringSchema,
});

const KernelAuditLogListResponseSchema = Type.Object({
  items: Type.Array(
    Type.Object({
      id: UuidSchema,
      tenantId: UuidSchema,
      actorUserId: UuidSchema,
      action: Type.String(),
      resourceType: Type.String(),
      resourceId: UuidSchema,
    }),
  ),
});

export async function buildApp(
  options: BuildAppOptions,
): Promise<FastifyInstance> {
  const jwksUrl =
    process.env['SUPABASE_JWKS_URL'] ?? DEFAULT_SUPABASE_JWKS_URL;
  const jwksProvider =
    options.jwksProvider ?? new RemoteJwksProvider({ jwksUrl });

  const jwtOptions: JwtVerificationOptions = {
    expectedIssuer:
      options.jwtVerificationOptions?.expectedIssuer ??
      process.env['SUPABASE_JWT_ISSUER'] ??
      DEFAULT_SUPABASE_JWT_ISSUER,
    expectedAudience:
      options.jwtVerificationOptions?.expectedAudience ??
      process.env['SUPABASE_JWT_AUDIENCE'] ??
      DEFAULT_SUPABASE_JWT_AUDIENCE,
    ...(options.jwtVerificationOptions?.allowedAlgorithms
      ? { allowedAlgorithms: options.jwtVerificationOptions.allowedAlgorithms }
      : {}),
    ...(options.jwtVerificationOptions?.clockToleranceSeconds !== undefined
      ? {
          clockToleranceSeconds:
            options.jwtVerificationOptions.clockToleranceSeconds,
        }
      : {}),
    ...(options.jwtVerificationOptions?.nowMs
      ? { nowMs: options.jwtVerificationOptions.nowMs }
      : {}),
    ...(options.jwtVerificationOptions?.legacyHs256SharedSecret
      ? {
          legacyHs256SharedSecret:
            options.jwtVerificationOptions.legacyHs256SharedSecret,
        }
      : {}),
  };

  const app = Fastify({
    logger: false,
    genReqId: () => `req_${generateUuidV7()}`,
    ajv: {
      customOptions: {
        coerceTypes: false,
        allErrors: true,
      },
    },
  })
    .setValidatorCompiler(TypeBoxValidatorCompiler)
    .withTypeProvider<TypeBoxTypeProvider>();

  // CORS Support for Browser Web UI Preview & Local Development
  app.addHook('onRequest', async (request, reply) => {
    reply.header('access-control-allow-origin', '*');
    reply.header(
      'access-control-allow-methods',
      'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    );
    reply.header(
      'access-control-allow-headers',
      'Content-Type, Authorization, x-tenant-id, idempotency-key',
    );
    reply.header('access-control-expose-headers', 'x-idempotent-replayed');

    if (request.method === 'OPTIONS') {
      return reply.status(204).send();
    }
  });

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'NexStock Modular Monolith API',
        version: '0.1.0',
        description:
          'Universal Inventory Management and Point-of-Sale (POS) SaaS API (Fastify + TypeBox + Kysely)',
      },
    },
  });

  // RFC 9457 Problem Details Error Handler (NEX-DOC-07 Section 6)
  app.setErrorHandler((error, request, reply) => {
    const traceId = String(request.id);

    if (error instanceof AppError) {
      return reply
        .status(error.statusCode)
        .header('content-type', 'application/problem+json')
        .send(error.toProblemDetails(traceId, request.url));
    }

    const fastifyErr = error as {
      validation?: unknown;
      statusCode?: number;
      message?: string;
    };
    if (fastifyErr.validation) {
      return reply
        .status(400)
        .header('content-type', 'application/problem+json')
        .send({
          type: 'https://api.nexstock.io/errors/err-validation-failed',
          title: 'Request Validation Failed',
          status: 400,
          detail: fastifyErr.message ?? 'Payload failed TypeBox validation.',
          instance: request.url,
          errorCode: 'ERR_VALIDATION_FAILED',
          traceId,
          extensions: { validation: fastifyErr.validation },
        });
    }

    const errObj = error as Record<string, unknown>;
    request.log.error(
      {
        traceId,
        url: request.url,
        method: request.method,
        errName: error instanceof Error ? error.name : typeof error,
        errCode: errObj?.['code'],
        errMessage:
          error instanceof Error
            ? sanitizeLogMessage(error.message)
            : String(error),
      },
      '[NexStock Unhandled Error]',
    );

    return reply
      .status(500)
      .header('content-type', 'application/problem+json')
      .send({
        type: 'https://api.nexstock.io/errors/err-internal-server-error',
        title: 'Internal Server Error',
        status: 500,
        detail: 'An unexpected internal server error occurred.',
        instance: request.url,
        errorCode: 'ERR_INTERNAL_SERVER_ERROR',
        traceId,
      });
  });

  // 1. Liveness Probe
  app.get(
    '/v1/health/live',
    {
      schema: {
        response: {
          200: HealthStatusResponseSchema,
        },
      },
    },
    async () => ({
      status: 'ok' as const,
      service: 'nexstock-api' as const,
      version: '0.1.0',
      timestamp: new Date().toISOString(),
    }),
  );

  // 2. Readiness Probe (Verifies DB connection & NOBYPASSRLS enforcement)
  app.get(
    '/v1/health/ready',
    {
      schema: {
        response: {
          200: HealthStatusResponseSchema,
          500: ProblemDetailsSchema,
          503: ProblemDetailsSchema,
        },
      },
    },
    async (request, reply) => {
      const traceId = String(request.id);
      try {
        const probeTenantId = '00000000-0000-7000-8000-000000000000';
        const probeUserId = '00000000-0000-7000-8000-000000000000';
        await withTenantTransaction(
          options.db,
          {
            tenantId: probeTenantId,
            userId: probeUserId,
            traceId,
          },
          async (trx) => {
            await assertActiveRoleEnforcesRls(trx);
          },
        );
        return {
          status: 'ok' as const,
          service: 'nexstock-api' as const,
          version: '0.1.0',
          timestamp: new Date().toISOString(),
        };
      } catch (err) {
        const errObj = err as Record<string, unknown>;
        request.log.error(
          {
            probe: 'readiness',
            traceId,
            errName: err instanceof Error ? err.name : typeof err,
            errCode: errObj?.['code'],
            errMessage:
              err instanceof Error
                ? sanitizeLogMessage(err.message)
                : String(err),
          },
          '[NexStock Readiness Probe Failed]',
        );

        return reply
          .status(503)
          .header('content-type', 'application/problem+json')
          .send({
            type: 'https://api.nexstock.io/errors/err-internal-server-error',
            title: 'Service Unavailable',
            status: 503,
            detail: 'Database readiness check failed.',
            instance: request.url,
            errorCode: 'ERR_INTERNAL_SERVER_ERROR',
            traceId,
          });
      }
    },
  );

  // 3. OpenAPI 3.1 JSON Spec Endpoint
  app.get('/v1/openapi.json', async () => {
    return app.swagger();
  });

  const authConfig: AuthServiceConfig = {
    supabaseUrl:
      options.authServiceConfig?.supabaseUrl ??
      process.env['SUPABASE_URL'] ??
      DEFAULT_SUPABASE_URL,
    supabaseAnonKey:
      options.authServiceConfig?.supabaseAnonKey ??
      process.env['SUPABASE_ANON_KEY'] ??
      process.env['SUPABASE_PUBLISHABLE_KEY'],
    isDevOrTestMode: options.authServiceConfig?.isDevOrTestMode,
  };

  // ==========================================================================
  // Phase 5.0 Authentication & User Profile Endpoints
  // ==========================================================================

  // Auth 1: Sign Up
  app.post(
    '/v1/auth/signup',
    {
      schema: {
        body: SignUpRequestSchema,
        response: {
          201: SignUpResponseSchema,
          400: ProblemDetailsSchema,
          409: ProblemDetailsSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await handleSignUp(options.db, authConfig, request.body);
      return reply.status(201).send(result);
    },
  );

  // Auth 2: Log In
  app.post(
    '/v1/auth/login',
    {
      schema: {
        body: LoginRequestSchema,
        response: {
          200: LoginResponseSchema,
          400: ProblemDetailsSchema,
          401: ProblemDetailsSchema,
        },
      },
    },
    async (request, reply) => {
      const traceId = String(request.id);
      const result = await handleLogin(
        options.db,
        authConfig,
        request.body,
        traceId,
      );
      return reply.send(result);
    },
  );

  // Auth 3: Log Out
  app.post(
    '/v1/auth/logout',
    {
      schema: {
        response: {
          200: Type.Object({
            success: Type.Boolean(),
            message: Type.String(),
          }),
        },
      },
    },
    async (request, reply) => {
      const token = request.headers.authorization?.replace(/^Bearer\s+/i, '');
      const result = await handleLogout(authConfig, token);
      return reply.send(result);
    },
  );

  // Auth 4: Refresh Token
  app.post(
    '/v1/auth/refresh',
    {
      schema: {
        body: RefreshTokenRequestSchema,
        response: {
          200: Type.Object({
            token: Type.String(),
            refreshToken: Type.Optional(Type.String()),
            expiresIn: Type.Optional(Type.Integer()),
          }),
          401: ProblemDetailsSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await handleRefreshToken(authConfig, request.body);
      return reply.send(result);
    },
  );

  // Auth 5: Password Recovery Request
  app.post(
    '/v1/auth/recover',
    {
      schema: {
        body: PasswordResetRequestSchema,
        response: {
          200: Type.Object({
            message: Type.String(),
          }),
        },
      },
    },
    async (request, reply) => {
      const result = await handlePasswordResetRequest(authConfig, request.body);
      return reply.send(result);
    },
  );

  // Auth 6: Get Current User Profile & Memberships
  app.get(
    '/v1/auth/me',
    {
      schema: {
        headers: Type.Object({
          authorization: Type.Optional(Type.String()),
        }),
        response: {
          200: UserMeResponseSchema,
          401: ProblemDetailsSchema,
        },
      },
    },
    async (request, reply) => {
      const principal = await verifySupabaseJwt(
        request.headers.authorization,
        jwksProvider,
        jwtOptions,
      );
      const traceId = String(request.id);
      const result = await getUserProfileAndMemberships(
        options.db,
        principal.userId,
        traceId,
      );
      return reply.send(result);
    },
  );

  // ==========================================================================
  // Phase 5.0 Business Onboarding Endpoints
  // ==========================================================================

  // Onboard 1: Atomic Business Setup (Tenant + First Branch + Stockroom + POS Register)
  app.post(
    '/v1/org/onboard',
    {
      schema: {
        headers: Type.Object({
          authorization: Type.Optional(Type.String()),
        }),
        body: OnboardBusinessRequestSchema,
        response: {
          201: OnboardBusinessResponseSchema,
          400: ProblemDetailsSchema,
          401: ProblemDetailsSchema,
        },
      },
    },
    async (request, reply) => {
      const principal = await verifySupabaseJwt(
        request.headers.authorization,
        jwksProvider,
        jwtOptions,
      );
      const traceId = String(request.id);
      const result = await onboardBusinessAtomic(options.db, {
        userId: principal.userId,
        userEmail: principal.email,
        request: request.body,
        traceId,
      });
      return reply.status(201).send(result);
    },
  );

  // Onboard 2: List My Tenants / Businesses
  app.get(
    '/v1/org/my-tenants',
    {
      schema: {
        headers: Type.Object({
          authorization: Type.Optional(Type.String()),
        }),
        response: {
          200: Type.Array(TenantMembershipSummarySchema),
          401: ProblemDetailsSchema,
        },
      },
    },
    async (request, reply) => {
      const principal = await verifySupabaseJwt(
        request.headers.authorization,
        jwksProvider,
        jwtOptions,
      );
      const traceId = String(request.id);
      const result = await getUserProfileAndMemberships(
        options.db,
        principal.userId,
        traceId,
      );
      return reply.send(result.memberships);
    },
  );

  // 4. Tenant-Scoped Idempotent Kernel Mutation Endpoint
  app.post(
    '/v1/kernel/audit-mutations',
    {
      schema: {
        headers: IdempotentMutationHeadersSchema,
        body: KernelAuditMutationBodySchema,
        response: {
          201: KernelAuditMutationResponseSchema,
          400: ProblemDetailsSchema,
          409: ProblemDetailsSchema,
          422: ProblemDetailsSchema,
        },
      },
    },
    async (request, reply) => {
      const tenantId = request.headers['x-tenant-id'];
      const userId =
        request.headers['x-user-id'] ?? '0192b4a0-0000-7000-8000-000000000001';
      const idempotencyKey = request.headers['idempotency-key'];
      const traceId = String(request.id);

      const outcome = await withTenantTransaction(
        options.db,
        { tenantId, userId, traceId },
        async (trx) => {
          return executeIdempotentMutation({
            trx,
            idempotencyKey,
            endpoint: 'POST /v1/kernel/audit-mutations',
            requestPayload: request.body,
            execute: async (innerTrx) => {
              const auditLogId = await appendAuditLog(innerTrx, {
                action: request.body.action,
                resourceType: request.body.resourceType,
                resourceId: request.body.resourceId,
                metadata: { amount: request.body.amount },
              });

              const outboxEventId = await enqueueOutboxEvent(innerTrx, {
                aggregateType: request.body.resourceType,
                aggregateId: request.body.resourceId,
                eventType: `${request.body.action}_RECORDED`,
                payload: { auditLogId, amount: request.body.amount },
              });

              if (request.body.simulateFailureAfterInsert) {
                throw new AppError({
                  statusCode: 409,
                  errorCode: 'INV_INSUFFICIENT_AVAILABLE_STOCK',
                  title: 'Simulated Domain Rollback',
                  detail:
                    'Simulated failure after insert to verify atomic transaction rollback.',
                });
              }

              return {
                statusCode: 201,
                body: {
                  auditLogId,
                  outboxEventId,
                  tenantId,
                  action: request.body.action,
                  amount: request.body.amount,
                },
              };
            },
          });
        },
      );

      return reply
        .status(outcome.statusCode as 201)
        .header('x-idempotent-replayed', String(outcome.replayed))
        .send(outcome.body);
    },
  );

  // 5. Tenant-Scoped Audit Log Query (Demonstrates RLS Isolation without explicit WHERE tenant_id)
  app.get(
    '/v1/kernel/audit-logs',
    {
      schema: {
        headers: TenantContextHeadersSchema,
        response: {
          200: KernelAuditLogListResponseSchema,
        },
      },
    },
    async (request) => {
      const tenantId = request.headers['x-tenant-id'];
      const userId =
        request.headers['x-user-id'] ?? '0192b4a0-0000-7000-8000-000000000001';
      const traceId = String(request.id);

      const rows = await withTenantTransaction(
        options.db,
        { tenantId, userId, traceId },
        async (trx) => {
          return trx
            .selectFrom('audit_logs')
            .select([
              'id',
              'tenant_id',
              'actor_user_id',
              'action',
              'resource_type',
              'resource_id',
            ])
            .orderBy('id', 'asc')
            .execute();
        },
      );

      return {
        items: rows.map((r) => ({
          id: r.id,
          tenantId: r.tenant_id,
          actorUserId: r.actor_user_id,
          action: r.action,
          resourceType: r.resource_type,
          resourceId: r.resource_id,
        })),
      };
    },
  );

  // 6. Foundation Offline Sync Push Batch Endpoint (Savepoint Isolation & Quarantine)
  app.post(
    '/v1/sync/push',
    {
      schema: {
        headers: TenantContextHeadersSchema,
        body: SyncPushBatchRequestSchema,
        response: {
          200: SyncPushBatchResponseSchema,
          403: ProblemDetailsSchema,
          422: ProblemDetailsSchema,
        },
      },
    },
    async (request) => {
      const tenantId = request.headers['x-tenant-id'];
      const userId =
        request.headers['x-user-id'] ?? '0192b4a0-0000-7000-8000-000000000001';
      const traceId = String(request.id);

      return withTenantTransaction(
        options.db,
        {
          tenantId,
          userId,
          deviceId: request.body.deviceId,
          traceId,
        },
        async (trx) => {
          return processSyncCommandBatch({
            trx,
            deviceId: request.body.deviceId,
            branchId: request.body.branchId,
            commands: request.body.commands,
            handler: async (cmdTrx, envelope) => {
              await appendAuditLog(cmdTrx, {
                action: `SYNC_${envelope.commandType}`,
                resourceType: 'SYNC_COMMAND',
                resourceId: envelope.commandId,
                metadata: envelope.payload,
              });

              if (envelope.payload['simulatePoisonPill'] === true) {
                throw new SyncPoisonPillError(
                  'INVALID_OFFLINE_COMMAND_PAYLOAD',
                  `Command "${envelope.commandId}" failed domain invariant validation and was quarantined.`,
                  { commandType: envelope.commandType },
                );
              }

              if (envelope.payload['droveStockNegativeOffline'] === true) {
                return {
                  status: 'APPLIED_WITH_CONFLICT_FLAG',
                  conflictCode: 'NEGATIVE_STOCK_VARIANCE',
                  conflictDetails: {
                    note: 'Offline physical sale accepted; stock balance went negative.',
                  },
                };
              }

              return {
                status: 'APPLIED',
              };
            },
          });
        },
      );
    },
  );

  // ==========================================================================
  // Milestone 1 Routes: IAM, ORG, SUB, I18N (JWT Verified + 3D RBAC + RLS)
  // ==========================================================================

  // 7. Onboard Tenant Organization
  app.post(
    '/v1/org/tenants/onboard',
    {
      schema: {
        headers: AuthenticatedTenantHeadersSchema,
        body: Type.Object(
          {
            slug: Type.String({ minLength: 2, maxLength: 64 }),
            legalName: Type.String({ minLength: 2, maxLength: 160 }),
            baseCurrency: CurrencyCodeSchema,
            defaultLocale: Type.Optional(Type.String()),
            defaultTimezone: Type.Optional(Type.String()),
            countryCode: Type.Optional(Type.String({ pattern: '^[A-Z]{2}$' })),
            ownerEmail: Type.String({ minLength: 3, maxLength: 160 }),
            ownerFullName: Type.String({ minLength: 2, maxLength: 160 }),
            planCode: Type.Optional(
              Type.Union([
                Type.Literal('STARTER'),
                Type.Literal('GROWTH'),
                Type.Literal('ENTERPRISE'),
              ]),
            ),
            trialDays: Type.Optional(Type.Integer({ minimum: 1, maximum: 90 })),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (request, reply) => {
      const principal = await verifySupabaseJwt(
        request.headers.authorization,
        jwksProvider,
        jwtOptions,
      );
      const tenantId = request.headers['x-tenant-id'];
      const traceId = String(request.id);

      const result = await withTenantTransaction(
        options.db,
        { tenantId, userId: principal.userId, traceId },
        async (trx) => {
          return onboardTenantOrganization(trx, {
            slug: request.body.slug,
            legalName: request.body.legalName,
            baseCurrency: request.body.baseCurrency,
            defaultLocale: request.body.defaultLocale,
            defaultTimezone: request.body.defaultTimezone,
            countryCode: request.body.countryCode,
            ownerEmail: request.body.ownerEmail,
            ownerFullName: request.body.ownerFullName,
            planCode: request.body.planCode as SubscriptionPlanCode | undefined,
            trialDays: request.body.trialDays,
          });
        },
      );

      return reply.status(201).send(result);
    },
  );

  // 8. Create Branch (Enforces JWT + 3D RBAC + SUB Quota)
  app.post(
    '/v1/org/branches',
    {
      schema: {
        headers: AuthenticatedTenantHeadersSchema,
        body: CreateBranchRequestSchema,
        response: {
          201: BranchResponseSchema,
          401: ProblemDetailsSchema,
          403: ProblemDetailsSchema,
        },
      },
    },
    async (request, reply) => {
      const principal = await verifySupabaseJwt(
        request.headers.authorization,
        jwksProvider,
        jwtOptions,
      );
      const tenantId = request.headers['x-tenant-id'];
      const traceId = String(request.id);

      const branch = await withTenantTransaction(
        options.db,
        { tenantId, userId: principal.userId, traceId },
        async (trx) => {
          return createBranch(trx, request.body);
        },
      );

      return reply.status(201).send(branch);
    },
  );

  // 9. List Branches (Enforces JWT + 3D Location Scope Filter + RLS)
  app.get(
    '/v1/org/branches',
    {
      schema: {
        headers: AuthenticatedTenantHeadersSchema,
        response: {
          200: Type.Object({
            items: Type.Array(BranchResponseSchema),
          }),
          401: ProblemDetailsSchema,
          403: ProblemDetailsSchema,
        },
      },
    },
    async (request) => {
      const principal = await verifySupabaseJwt(
        request.headers.authorization,
        jwksProvider,
        jwtOptions,
      );
      const tenantId = request.headers['x-tenant-id'];
      const traceId = String(request.id);

      const items = await withTenantTransaction(
        options.db,
        { tenantId, userId: principal.userId, traceId },
        async (trx) => {
          return listBranches(trx);
        },
      );

      return { items: [...items] };
    },
  );

  // 10. Get Branch by ID (Enforces JWT + Branch Scope + RLS)
  app.get(
    '/v1/org/branches/:branchId',
    {
      schema: {
        headers: AuthenticatedTenantHeadersSchema,
        params: Type.Object({ branchId: UuidSchema }),
        response: {
          200: BranchResponseSchema,
          401: ProblemDetailsSchema,
          403: ProblemDetailsSchema,
          404: ProblemDetailsSchema,
        },
      },
    },
    async (request) => {
      const principal = await verifySupabaseJwt(
        request.headers.authorization,
        jwksProvider,
        jwtOptions,
      );
      const tenantId = request.headers['x-tenant-id'];
      const traceId = String(request.id);

      return withTenantTransaction(
        options.db,
        { tenantId, userId: principal.userId, traceId },
        async (trx) => {
          return getBranchById(trx, request.params.branchId);
        },
      );
    },
  );

  // 11. Update Branch Name (Enforces JWT + Branch Scope + SUB Write Entitlement)
  app.patch(
    '/v1/org/branches/:branchId',
    {
      schema: {
        headers: AuthenticatedTenantHeadersSchema,
        params: Type.Object({ branchId: UuidSchema }),
        body: Type.Object(
          { name: Type.String({ minLength: 2, maxLength: 120 }) },
          { additionalProperties: false },
        ),
        response: {
          200: BranchResponseSchema,
          401: ProblemDetailsSchema,
          403: ProblemDetailsSchema,
          404: ProblemDetailsSchema,
        },
      },
    },
    async (request) => {
      const principal = await verifySupabaseJwt(
        request.headers.authorization,
        jwksProvider,
        jwtOptions,
      );
      const tenantId = request.headers['x-tenant-id'];
      const traceId = String(request.id);

      return withTenantTransaction(
        options.db,
        { tenantId, userId: principal.userId, traceId },
        async (trx) => {
          return updateBranchName(trx, {
            branchId: request.params.branchId,
            name: request.body.name,
          });
        },
      );
    },
  );

  // 12. Create Warehouse (Enforces JWT + Branch Scope + SUB Quota)
  app.post(
    '/v1/org/warehouses',
    {
      schema: {
        headers: AuthenticatedTenantHeadersSchema,
        body: CreateWarehouseRequestSchema,
        response: {
          201: WarehouseResponseSchema,
          401: ProblemDetailsSchema,
          403: ProblemDetailsSchema,
        },
      },
    },
    async (request, reply) => {
      const principal = await verifySupabaseJwt(
        request.headers.authorization,
        jwksProvider,
        jwtOptions,
      );
      const tenantId = request.headers['x-tenant-id'];
      const traceId = String(request.id);

      const warehouse = await withTenantTransaction(
        options.db,
        { tenantId, userId: principal.userId, traceId },
        async (trx) => {
          return createWarehouse(trx, request.body);
        },
      );

      return reply.status(201).send(warehouse);
    },
  );

  // 13. Provision Organization Member (Enforces JWT + iam:member:manage + SUB Quota)
  app.post(
    '/v1/iam/members',
    {
      schema: {
        headers: AuthenticatedTenantHeadersSchema,
        body: Type.Object(
          {
            userId: UuidSchema,
            email: Type.String({ minLength: 3, maxLength: 160 }),
            fullName: Type.String({ minLength: 2, maxLength: 160 }),
            roleCodes: Type.Array(Type.String({ minLength: 2 }), {
              minItems: 1,
            }),
            allLocationsAccess: Type.Boolean(),
            branchIds: Type.Optional(Type.Array(UuidSchema)),
            warehouseIds: Type.Optional(Type.Array(UuidSchema)),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (request, reply) => {
      const principal = await verifySupabaseJwt(
        request.headers.authorization,
        jwksProvider,
        jwtOptions,
      );
      const tenantId = request.headers['x-tenant-id'];
      const traceId = String(request.id);

      const member = await withTenantTransaction(
        options.db,
        { tenantId, userId: principal.userId, traceId },
        async (trx) => {
          await assertAuthorized(trx, {
            permission: 'iam:member:manage',
            requireAllLocationsAccess: true,
          });

          const existingMembers = await trx.db
            .selectFrom('tenant_memberships')
            .select(['id'])
            .where('tenant_id', '=', trx.tenantId)
            .where('status', '=', 'ACTIVE')
            .execute();

          await assertSubscriptionEntitlement(trx, {
            requireWriteAccess: true,
            quotaCheck: {
              resource: 'USER',
              currentActiveCount: existingMembers.length,
            },
          });

          return provisionTenantMember(trx, {
            userId: request.body.userId,
            email: request.body.email,
            fullName: request.body.fullName,
            roleCodes: request.body.roleCodes as SystemRoleCode[],
            allLocationsAccess: request.body.allLocationsAccess,
            branchIds: request.body.branchIds,
            warehouseIds: request.body.warehouseIds,
          });
        },
      );

      return reply.status(201).send(member);
    },
  );

  // 14. Get & Update Subscription Entitlement / Administrative Override
  app.get(
    '/v1/subscriptions/entitlement',
    {
      schema: {
        headers: AuthenticatedTenantHeadersSchema,
      },
    },
    async (request) => {
      const principal = await verifySupabaseJwt(
        request.headers.authorization,
        jwksProvider,
        jwtOptions,
      );
      const tenantId = request.headers['x-tenant-id'];
      const traceId = String(request.id);

      return withTenantTransaction(
        options.db,
        { tenantId, userId: principal.userId, traceId },
        async (trx) => {
          await assertAuthorized(trx, {
            permission: 'sub:subscription:read',
          });
          return getTenantSubscriptionEntitlement(trx);
        },
      );
    },
  );

  app.patch(
    '/v1/subscriptions/lifecycle',
    {
      schema: {
        headers: AuthenticatedTenantHeadersSchema,
        body: Type.Object(
          {
            status: Type.Optional(SubscriptionStatusSchema),
            planCode: Type.Optional(
              Type.Union([
                Type.Literal('STARTER'),
                Type.Literal('GROWTH'),
                Type.Literal('ENTERPRISE'),
              ]),
            ),
            allowAdminOverride: Type.Optional(Type.Boolean()),
            overrideReason: Type.Optional(
              Type.Union([Type.String(), Type.Null()]),
            ),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (request) => {
      const principal = await verifySupabaseJwt(
        request.headers.authorization,
        jwksProvider,
        jwtOptions,
      );
      const tenantId = request.headers['x-tenant-id'];
      const traceId = String(request.id);

      return withTenantTransaction(
        options.db,
        { tenantId, userId: principal.userId, traceId },
        async (trx) => {
          await assertAuthorized(trx, {
            permission: 'sub:subscription:manage',
            requireAllLocationsAccess: true,
          });
          return updateSubscriptionLifecycleAndOverride(trx, {
            status: request.body.status,
            planCode: request.body.planCode as SubscriptionPlanCode | undefined,
            allowAdminOverride: request.body.allowAdminOverride,
            overrideReason: request.body.overrideReason,
          });
        },
      );
    },
  );

  // 15. Issue Subscription Invoice & Record Verified Subscription Payment
  app.post(
    '/v1/subscriptions/invoices',
    {
      schema: {
        headers: AuthenticatedTenantHeadersSchema,
        body: Type.Object(
          {
            invoiceNumber: Type.String({ minLength: 3, maxLength: 64 }),
            currencyCode: CurrencyCodeSchema,
            totalAmount: DecimalMoneyStringSchema,
            dueDate: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (request, reply) => {
      const principal = await verifySupabaseJwt(
        request.headers.authorization,
        jwksProvider,
        jwtOptions,
      );
      const tenantId = request.headers['x-tenant-id'];
      const traceId = String(request.id);

      const invoice = await withTenantTransaction(
        options.db,
        { tenantId, userId: principal.userId, traceId },
        async (trx) => {
          await assertAuthorized(trx, {
            permission: 'sub:subscription:manage',
          });
          return issueSubscriptionInvoice(trx, request.body);
        },
      );

      return reply.status(201).send(invoice);
    },
  );

  app.post(
    '/v1/subscriptions/invoices/:invoiceId/payments',
    {
      schema: {
        headers: AuthenticatedTenantHeadersSchema,
        params: Type.Object({ invoiceId: UuidSchema }),
        body: RecordSubscriptionPaymentRequestSchema,
        response: {
          201: Type.Object({
            paymentId: UuidSchema,
            subscriptionStatus: SubscriptionStatusSchema,
            invoice: Type.Object({
              id: UuidSchema,
              tenantId: UuidSchema,
              subscriptionId: UuidSchema,
              invoiceNumber: Type.String(),
              currencyCode: CurrencyCodeSchema,
              totalAmount: DecimalMoneyStringSchema,
              amountPaid: DecimalMoneyStringSchema,
              status: Type.String(),
              dueDate: Type.String(),
            }),
          }),
          401: ProblemDetailsSchema,
          403: ProblemDetailsSchema,
          404: ProblemDetailsSchema,
        },
      },
    },
    async (request, reply) => {
      const principal = await verifySupabaseJwt(
        request.headers.authorization,
        jwksProvider,
        jwtOptions,
      );
      const tenantId = request.headers['x-tenant-id'];
      const traceId = String(request.id);

      const result = await withTenantTransaction(
        options.db,
        { tenantId, userId: principal.userId, traceId },
        async (trx) => {
          await assertAuthorized(trx, {
            permission: 'sub:payment:record',
          });
          return defaultManualBillingAdapter.recordVerifiedPayment(trx, {
            invoiceId: request.params.invoiceId,
            currencyCode: request.body.currencyCode,
            amount: request.body.amount,
            paymentMethod: request.body.paymentMethod,
            referenceNumber: request.body.referenceNumber,
          });
        },
      );

      return reply.status(201).send(result);
    },
  );

  // 16. I18N Localization Settings & Exchange Rates
  app.put(
    '/v1/i18n/localization',
    {
      schema: {
        headers: AuthenticatedTenantHeadersSchema,
        body: UpsertLocalizationSettingsRequestSchema,
      },
    },
    async (request) => {
      const principal = await verifySupabaseJwt(
        request.headers.authorization,
        jwksProvider,
        jwtOptions,
      );
      const tenantId = request.headers['x-tenant-id'];
      const traceId = String(request.id);

      return withTenantTransaction(
        options.db,
        { tenantId, userId: principal.userId, traceId },
        async (trx) => {
          await assertAuthorized(trx, {
            permission: 'i18n:settings:manage',
          });
          await assertSubscriptionEntitlement(trx, {
            requireWriteAccess: true,
          });
          return upsertTenantLocalizationSettings(trx, request.body);
        },
      );
    },
  );

  app.post(
    '/v1/i18n/exchange-rates',
    {
      schema: {
        headers: AuthenticatedTenantHeadersSchema,
        body: CreateExchangeRateRequestSchema,
      },
    },
    async (request, reply) => {
      const principal = await verifySupabaseJwt(
        request.headers.authorization,
        jwksProvider,
        jwtOptions,
      );
      const tenantId = request.headers['x-tenant-id'];
      const traceId = String(request.id);

      const fx = await withTenantTransaction(
        options.db,
        { tenantId, userId: principal.userId, traceId },
        async (trx) => {
          await assertAuthorized(trx, {
            permission: 'i18n:fx:manage',
          });
          await assertSubscriptionEntitlement(trx, {
            requireWriteAccess: true,
          });
          return recordTenantExchangeRate(trx, request.body);
        },
      );

      return reply.status(201).send(fx);
    },
  );

  app.post(
    '/v1/i18n/convert',
    {
      schema: {
        headers: AuthenticatedTenantHeadersSchema,
        body: Type.Object(
          {
            amount: DecimalMoneyStringSchema,
            sourceCurrency: CurrencyCodeSchema,
            targetCurrency: CurrencyCodeSchema,
          },
          { additionalProperties: false },
        ),
      },
    },
    async (request) => {
      const principal = await verifySupabaseJwt(
        request.headers.authorization,
        jwksProvider,
        jwtOptions,
      );
      const tenantId = request.headers['x-tenant-id'];
      const traceId = String(request.id);

      return withTenantTransaction(
        options.db,
        { tenantId, userId: principal.userId, traceId },
        async (trx) => {
          await assertAuthorized(trx, {
            permission: 'i18n:settings:read',
          });
          return convertTenantCurrencyAmount(trx, request.body);
        },
      );
    },
  );

  // =========================================================================
  // Phase 2: Core Inventory — Category Management (CAT)
  // =========================================================================

  app.post(
    '/v1/categories',
    {
      schema: {
        headers: AuthenticatedTenantHeadersSchema,
        body: CreateCategoryRequestSchema,
        response: {
          201: CategoryResponseSchema,
          400: ProblemDetailsSchema,
          401: ProblemDetailsSchema,
          403: ProblemDetailsSchema,
          404: ProblemDetailsSchema,
          409: ProblemDetailsSchema,
          422: ProblemDetailsSchema,
        },
      },
    },
    async (request, reply) => {
      const principal = await verifySupabaseJwt(
        request.headers.authorization,
        jwksProvider,
        jwtOptions,
      );
      const tenantId = request.headers['x-tenant-id'];
      const traceId = String(request.id);

      const category = await withTenantTransaction(
        options.db,
        { tenantId, userId: principal.userId, traceId },
        (trx) => createCategory(trx, request.body),
      );

      return reply.status(201).send(category);
    },
  );

  app.get(
    '/v1/categories',
    {
      schema: {
        headers: AuthenticatedTenantHeadersSchema,
        querystring: ListCategoriesQuerySchema,
        response: {
          200: createCursorPageResponseSchema(CategoryResponseSchema),
          401: ProblemDetailsSchema,
          403: ProblemDetailsSchema,
        },
      },
    },
    async (request) => {
      const principal = await verifySupabaseJwt(
        request.headers.authorization,
        jwksProvider,
        jwtOptions,
      );
      const tenantId = request.headers['x-tenant-id'];
      const traceId = String(request.id);

      return withTenantTransaction(
        options.db,
        { tenantId, userId: principal.userId, traceId },
        (trx) => listCategories(trx, request.query),
      );
    },
  );

  app.get(
    '/v1/categories/:categoryId',
    {
      schema: {
        headers: AuthenticatedTenantHeadersSchema,
        params: Type.Object({ categoryId: UuidSchema }),
        response: {
          200: CategoryResponseSchema,
          401: ProblemDetailsSchema,
          403: ProblemDetailsSchema,
          404: ProblemDetailsSchema,
        },
      },
    },
    async (request) => {
      const principal = await verifySupabaseJwt(
        request.headers.authorization,
        jwksProvider,
        jwtOptions,
      );
      const tenantId = request.headers['x-tenant-id'];
      const traceId = String(request.id);

      return withTenantTransaction(
        options.db,
        { tenantId, userId: principal.userId, traceId },
        (trx) => getCategoryById(trx, request.params.categoryId),
      );
    },
  );

  app.patch(
    '/v1/categories/:categoryId',
    {
      schema: {
        headers: AuthenticatedTenantHeadersSchema,
        params: Type.Object({ categoryId: UuidSchema }),
        body: UpdateCategoryRequestSchema,
        response: {
          200: CategoryResponseSchema,
          401: ProblemDetailsSchema,
          403: ProblemDetailsSchema,
          404: ProblemDetailsSchema,
          409: ProblemDetailsSchema,
          422: ProblemDetailsSchema,
        },
      },
    },
    async (request) => {
      const principal = await verifySupabaseJwt(
        request.headers.authorization,
        jwksProvider,
        jwtOptions,
      );
      const tenantId = request.headers['x-tenant-id'];
      const traceId = String(request.id);

      return withTenantTransaction(
        options.db,
        { tenantId, userId: principal.userId, traceId },
        (trx) => updateCategory(trx, request.params.categoryId, request.body),
      );
    },
  );

  app.post(
    '/v1/categories/:categoryId/archive',
    {
      schema: {
        headers: AuthenticatedTenantHeadersSchema,
        params: Type.Object({ categoryId: UuidSchema }),
        response: {
          200: CategoryResponseSchema,
          401: ProblemDetailsSchema,
          403: ProblemDetailsSchema,
          404: ProblemDetailsSchema,
          409: ProblemDetailsSchema,
        },
      },
    },
    async (request) => {
      const principal = await verifySupabaseJwt(
        request.headers.authorization,
        jwksProvider,
        jwtOptions,
      );
      const tenantId = request.headers['x-tenant-id'];
      const traceId = String(request.id);

      return withTenantTransaction(
        options.db,
        { tenantId, userId: principal.userId, traceId },
        (trx) => archiveCategory(trx, request.params.categoryId),
      );
    },
  );

  // =========================================================================
  // Phase 2: Core Inventory — Product Management (CAT)
  // =========================================================================

  app.post(
    '/v1/products',
    {
      schema: {
        headers: AuthenticatedTenantHeadersSchema,
        body: CreateProductRequestSchema,
        response: {
          201: ProductResponseSchema,
          400: ProblemDetailsSchema,
          401: ProblemDetailsSchema,
          403: ProblemDetailsSchema,
          404: ProblemDetailsSchema,
          409: ProblemDetailsSchema,
          422: ProblemDetailsSchema,
        },
      },
    },
    async (request, reply) => {
      const principal = await verifySupabaseJwt(
        request.headers.authorization,
        jwksProvider,
        jwtOptions,
      );
      const tenantId = request.headers['x-tenant-id'];
      const traceId = String(request.id);

      const product = await withTenantTransaction(
        options.db,
        { tenantId, userId: principal.userId, traceId },
        (trx) => createProduct(trx, request.body),
      );

      return reply.status(201).send(product);
    },
  );

  app.get(
    '/v1/products',
    {
      schema: {
        headers: AuthenticatedTenantHeadersSchema,
        querystring: ListProductsQuerySchema,
        response: {
          200: createCursorPageResponseSchema(ProductResponseSchema),
          401: ProblemDetailsSchema,
          403: ProblemDetailsSchema,
        },
      },
    },
    async (request) => {
      const principal = await verifySupabaseJwt(
        request.headers.authorization,
        jwksProvider,
        jwtOptions,
      );
      const tenantId = request.headers['x-tenant-id'];
      const traceId = String(request.id);

      return withTenantTransaction(
        options.db,
        { tenantId, userId: principal.userId, traceId },
        (trx) => listProducts(trx, request.query),
      );
    },
  );

  app.get(
    '/v1/products/:productId',
    {
      schema: {
        headers: AuthenticatedTenantHeadersSchema,
        params: Type.Object({ productId: UuidSchema }),
        response: {
          200: ProductResponseSchema,
          401: ProblemDetailsSchema,
          403: ProblemDetailsSchema,
          404: ProblemDetailsSchema,
        },
      },
    },
    async (request) => {
      const principal = await verifySupabaseJwt(
        request.headers.authorization,
        jwksProvider,
        jwtOptions,
      );
      const tenantId = request.headers['x-tenant-id'];
      const traceId = String(request.id);

      return withTenantTransaction(
        options.db,
        { tenantId, userId: principal.userId, traceId },
        (trx) => getProductById(trx, request.params.productId),
      );
    },
  );

  app.patch(
    '/v1/products/:productId',
    {
      schema: {
        headers: AuthenticatedTenantHeadersSchema,
        params: Type.Object({ productId: UuidSchema }),
        body: UpdateProductRequestSchema,
        response: {
          200: ProductResponseSchema,
          401: ProblemDetailsSchema,
          403: ProblemDetailsSchema,
          404: ProblemDetailsSchema,
          409: ProblemDetailsSchema,
          422: ProblemDetailsSchema,
        },
      },
    },
    async (request) => {
      const principal = await verifySupabaseJwt(
        request.headers.authorization,
        jwksProvider,
        jwtOptions,
      );
      const tenantId = request.headers['x-tenant-id'];
      const traceId = String(request.id);

      return withTenantTransaction(
        options.db,
        { tenantId, userId: principal.userId, traceId },
        (trx) => updateProduct(trx, request.params.productId, request.body),
      );
    },
  );

  app.post(
    '/v1/products/:productId/archive',
    {
      schema: {
        headers: AuthenticatedTenantHeadersSchema,
        params: Type.Object({ productId: UuidSchema }),
        response: {
          200: ProductResponseSchema,
          401: ProblemDetailsSchema,
          403: ProblemDetailsSchema,
          404: ProblemDetailsSchema,
        },
      },
    },
    async (request) => {
      const principal = await verifySupabaseJwt(
        request.headers.authorization,
        jwksProvider,
        jwtOptions,
      );
      const tenantId = request.headers['x-tenant-id'];
      const traceId = String(request.id);

      return withTenantTransaction(
        options.db,
        { tenantId, userId: principal.userId, traceId },
        (trx) => archiveProduct(trx, request.params.productId),
      );
    },
  );

  // =========================================================================
  // Phase 2: Core Inventory — Supplier Management (PUR)
  // =========================================================================

  app.post(
    '/v1/suppliers',
    {
      schema: {
        headers: AuthenticatedTenantHeadersSchema,
        body: CreateSupplierRequestSchema,
        response: {
          201: SupplierResponseSchema,
          400: ProblemDetailsSchema,
          401: ProblemDetailsSchema,
          403: ProblemDetailsSchema,
          409: ProblemDetailsSchema,
          422: ProblemDetailsSchema,
        },
      },
    },
    async (request, reply) => {
      const principal = await verifySupabaseJwt(
        request.headers.authorization,
        jwksProvider,
        jwtOptions,
      );
      const tenantId = request.headers['x-tenant-id'];
      const traceId = String(request.id);

      const supplier = await withTenantTransaction(
        options.db,
        { tenantId, userId: principal.userId, traceId },
        (trx) => createSupplier(trx, request.body),
      );

      return reply.status(201).send(supplier);
    },
  );

  app.get(
    '/v1/suppliers',
    {
      schema: {
        headers: AuthenticatedTenantHeadersSchema,
        querystring: ListSuppliersQuerySchema,
        response: {
          200: createCursorPageResponseSchema(SupplierResponseSchema),
          401: ProblemDetailsSchema,
          403: ProblemDetailsSchema,
        },
      },
    },
    async (request) => {
      const principal = await verifySupabaseJwt(
        request.headers.authorization,
        jwksProvider,
        jwtOptions,
      );
      const tenantId = request.headers['x-tenant-id'];
      const traceId = String(request.id);

      return withTenantTransaction(
        options.db,
        { tenantId, userId: principal.userId, traceId },
        (trx) => listSuppliers(trx, request.query),
      );
    },
  );

  app.get(
    '/v1/suppliers/:supplierId',
    {
      schema: {
        headers: AuthenticatedTenantHeadersSchema,
        params: Type.Object({ supplierId: UuidSchema }),
        response: {
          200: SupplierResponseSchema,
          401: ProblemDetailsSchema,
          403: ProblemDetailsSchema,
          404: ProblemDetailsSchema,
        },
      },
    },
    async (request) => {
      const principal = await verifySupabaseJwt(
        request.headers.authorization,
        jwksProvider,
        jwtOptions,
      );
      const tenantId = request.headers['x-tenant-id'];
      const traceId = String(request.id);

      return withTenantTransaction(
        options.db,
        { tenantId, userId: principal.userId, traceId },
        (trx) => getSupplierById(trx, request.params.supplierId),
      );
    },
  );

  app.patch(
    '/v1/suppliers/:supplierId',
    {
      schema: {
        headers: AuthenticatedTenantHeadersSchema,
        params: Type.Object({ supplierId: UuidSchema }),
        body: UpdateSupplierRequestSchema,
        response: {
          200: SupplierResponseSchema,
          401: ProblemDetailsSchema,
          403: ProblemDetailsSchema,
          404: ProblemDetailsSchema,
          409: ProblemDetailsSchema,
          422: ProblemDetailsSchema,
        },
      },
    },
    async (request) => {
      const principal = await verifySupabaseJwt(
        request.headers.authorization,
        jwksProvider,
        jwtOptions,
      );
      const tenantId = request.headers['x-tenant-id'];
      const traceId = String(request.id);

      return withTenantTransaction(
        options.db,
        { tenantId, userId: principal.userId, traceId },
        (trx) => updateSupplier(trx, request.params.supplierId, request.body),
      );
    },
  );

  app.post(
    '/v1/suppliers/:supplierId/archive',
    {
      schema: {
        headers: AuthenticatedTenantHeadersSchema,
        params: Type.Object({ supplierId: UuidSchema }),
        response: {
          200: SupplierResponseSchema,
          401: ProblemDetailsSchema,
          403: ProblemDetailsSchema,
          404: ProblemDetailsSchema,
        },
      },
    },
    async (request) => {
      const principal = await verifySupabaseJwt(
        request.headers.authorization,
        jwksProvider,
        jwtOptions,
      );
      const tenantId = request.headers['x-tenant-id'];
      const traceId = String(request.id);

      return withTenantTransaction(
        options.db,
        { tenantId, userId: principal.userId, traceId },
        (trx) => archiveSupplier(trx, request.params.supplierId),
      );
    },
  );

  app.post(
    '/v1/suppliers/:supplierId/products',
    {
      schema: {
        headers: AuthenticatedTenantHeadersSchema,
        params: Type.Object({ supplierId: UuidSchema }),
        body: LinkSupplierProductRequestSchema,
        response: {
          201: SupplierProductResponseSchema,
          401: ProblemDetailsSchema,
          403: ProblemDetailsSchema,
          404: ProblemDetailsSchema,
          422: ProblemDetailsSchema,
        },
      },
    },
    async (request, reply) => {
      const principal = await verifySupabaseJwt(
        request.headers.authorization,
        jwksProvider,
        jwtOptions,
      );
      const tenantId = request.headers['x-tenant-id'];
      const traceId = String(request.id);

      const association = await withTenantTransaction(
        options.db,
        { tenantId, userId: principal.userId, traceId },
        (trx) => linkSupplierProduct(trx, request.params.supplierId, request.body),
      );

      return reply.status(201).send(association);
    },
  );

  // =========================================================================
  // Phase 2: Core Inventory — Stock Movements & Inventory Balances (INV)
  // =========================================================================

  app.post(
    '/v1/inventory/movements',
    {
      schema: {
        headers: AuthenticatedIdempotentHeadersSchema,
        body: PostStockMovementRequestSchema,
        response: {
          201: StockMovementResponseSchema,
          400: ProblemDetailsSchema,
          401: ProblemDetailsSchema,
          403: ProblemDetailsSchema,
          404: ProblemDetailsSchema,
          409: ProblemDetailsSchema,
          422: ProblemDetailsSchema,
        },
      },
    },
    async (request, reply) => {
      const principal = await verifySupabaseJwt(
        request.headers.authorization,
        jwksProvider,
        jwtOptions,
      );
      const tenantId = request.headers['x-tenant-id'];
      const idempotencyKey = request.headers['idempotency-key'];
      const traceId = String(request.id);

      const outcome = await withTenantTransaction(
        options.db,
        { tenantId, userId: principal.userId, traceId },
        (trx) =>
          executeIdempotentMutation({
            trx,
            idempotencyKey,
            endpoint: 'POST /v1/inventory/movements',
            requestPayload: request.body,
            execute: async (innerTrx) => {
              const body = await postStockMovement(
                innerTrx,
                idempotencyKey,
                request.body,
              );
              return { statusCode: 201, body };
            },
          }),
      );

      return reply
        .status(outcome.statusCode as 201)
        .header('x-idempotent-replayed', String(outcome.replayed))
        .send(outcome.body);
    },
  );

  app.post(
    '/v1/inventory/movements/:movementId/reverse',
    {
      schema: {
        headers: AuthenticatedIdempotentHeadersSchema,
        params: Type.Object({ movementId: UuidSchema }),
        body: ReverseStockMovementRequestSchema,
        response: {
          201: StockMovementResponseSchema,
          400: ProblemDetailsSchema,
          401: ProblemDetailsSchema,
          403: ProblemDetailsSchema,
          404: ProblemDetailsSchema,
          409: ProblemDetailsSchema,
          422: ProblemDetailsSchema,
        },
      },
    },
    async (request, reply) => {
      const principal = await verifySupabaseJwt(
        request.headers.authorization,
        jwksProvider,
        jwtOptions,
      );
      const tenantId = request.headers['x-tenant-id'];
      const idempotencyKey = request.headers['idempotency-key'];
      const traceId = String(request.id);

      const outcome = await withTenantTransaction(
        options.db,
        { tenantId, userId: principal.userId, traceId },
        (trx) =>
          executeIdempotentMutation({
            trx,
            idempotencyKey,
            endpoint: `POST /v1/inventory/movements/${request.params.movementId}/reverse`,
            requestPayload: {
              movementId: request.params.movementId,
              body: request.body,
            },
            execute: async (innerTrx) => {
              const body = await reverseStockMovement(
                innerTrx,
                request.params.movementId,
                idempotencyKey,
                request.body,
              );
              return { statusCode: 201, body };
            },
          }),
      );

      return reply
        .status(outcome.statusCode as 201)
        .header('x-idempotent-replayed', String(outcome.replayed))
        .send(outcome.body);
    },
  );

  app.get(
    '/v1/inventory/movements',
    {
      schema: {
        headers: AuthenticatedTenantHeadersSchema,
        querystring: ListStockMovementsQuerySchema,
        response: {
          200: createCursorPageResponseSchema(StockMovementResponseSchema),
          401: ProblemDetailsSchema,
          403: ProblemDetailsSchema,
        },
      },
    },
    async (request) => {
      const principal = await verifySupabaseJwt(
        request.headers.authorization,
        jwksProvider,
        jwtOptions,
      );
      const tenantId = request.headers['x-tenant-id'];
      const traceId = String(request.id);

      return withTenantTransaction(
        options.db,
        { tenantId, userId: principal.userId, traceId },
        (trx) => listStockMovements(trx, request.query),
      );
    },
  );

  app.get(
    '/v1/inventory/movements/:movementId',
    {
      schema: {
        headers: AuthenticatedTenantHeadersSchema,
        params: Type.Object({ movementId: UuidSchema }),
        response: {
          200: StockMovementResponseSchema,
          401: ProblemDetailsSchema,
          403: ProblemDetailsSchema,
          404: ProblemDetailsSchema,
        },
      },
    },
    async (request) => {
      const principal = await verifySupabaseJwt(
        request.headers.authorization,
        jwksProvider,
        jwtOptions,
      );
      const tenantId = request.headers['x-tenant-id'];
      const traceId = String(request.id);

      return withTenantTransaction(
        options.db,
        { tenantId, userId: principal.userId, traceId },
        (trx) => getStockMovementById(trx, request.params.movementId),
      );
    },
  );

  app.get(
    '/v1/inventory/balances',
    {
      schema: {
        headers: AuthenticatedTenantHeadersSchema,
        querystring: ListInventoryBalancesQuerySchema,
        response: {
          200: createCursorPageResponseSchema(InventoryBalanceResponseSchema),
          401: ProblemDetailsSchema,
          403: ProblemDetailsSchema,
        },
      },
    },
    async (request) => {
      const principal = await verifySupabaseJwt(
        request.headers.authorization,
        jwksProvider,
        jwtOptions,
      );
      const tenantId = request.headers['x-tenant-id'];
      const traceId = String(request.id);

      return withTenantTransaction(
        options.db,
        { tenantId, userId: principal.userId, traceId },
        (trx) => listInventoryBalances(trx, request.query),
      );
    },
  );

  app.get(
    '/v1/inventory/balances/reconcile',
    {
      schema: {
        headers: AuthenticatedTenantHeadersSchema,
        querystring: Type.Object(
          {
            branchId: Type.Optional(UuidSchema),
            warehouseId: Type.Optional(UuidSchema),
            productId: Type.Optional(UuidSchema),
          },
          { additionalProperties: false },
        ),
        response: {
          200: InventoryReconciliationResponseSchema,
          401: ProblemDetailsSchema,
          403: ProblemDetailsSchema,
        },
      },
    },
    async (request) => {
      const principal = await verifySupabaseJwt(
        request.headers.authorization,
        jwksProvider,
        jwtOptions,
      );
      const tenantId = request.headers['x-tenant-id'];
      const traceId = String(request.id);

      return withTenantTransaction(
        options.db,
        { tenantId, userId: principal.userId, traceId },
        (trx) => reconcileInventoryBalances(trx, request.query),
      );
    },
  );

  // ============================================================================
  // PHASE 4: ADVANCED INVENTORY (BATCHES, SERIALS, COSTING, STOCKTAKES)
  // ============================================================================

  // 1. Batches / Lots
  app.post(
    '/v1/inventory/batches',
    {
      schema: {
        headers: AuthenticatedTenantHeadersSchema,
        body: CreateBatchRequestSchema,
        response: {
          201: BatchResponseSchema,
          400: ProblemDetailsSchema,
          401: ProblemDetailsSchema,
          403: ProblemDetailsSchema,
          404: ProblemDetailsSchema,
          409: ProblemDetailsSchema,
          422: ProblemDetailsSchema,
        },
      },
    },
    async (request, reply) => {
      const principal = await verifySupabaseJwt(
        request.headers.authorization,
        jwksProvider,
        jwtOptions,
      );
      const tenantId = request.headers['x-tenant-id'];
      const traceId = String(request.id);

      const result = await withTenantTransaction(
        options.db,
        { tenantId, userId: principal.userId, traceId },
        (trx) => createBatch(trx, request.body),
      );

      reply.status(201);
      return result;
    },
  );

  app.get(
    '/v1/inventory/batches',
    {
      schema: {
        headers: AuthenticatedTenantHeadersSchema,
        querystring: ListBatchesQuerySchema,
        response: {
          200: createCursorPageResponseSchema(BatchResponseSchema),
          401: ProblemDetailsSchema,
          403: ProblemDetailsSchema,
        },
      },
    },
    async (request) => {
      const principal = await verifySupabaseJwt(
        request.headers.authorization,
        jwksProvider,
        jwtOptions,
      );
      const tenantId = request.headers['x-tenant-id'];
      const traceId = String(request.id);

      return withTenantTransaction(
        options.db,
        { tenantId, userId: principal.userId, traceId },
        (trx) => listBatches(trx, request.query),
      );
    },
  );

  app.get(
    '/v1/inventory/batches/:batchId',
    {
      schema: {
        headers: AuthenticatedTenantHeadersSchema,
        params: Type.Object({ batchId: UuidSchema }),
        response: {
          200: BatchResponseSchema,
          401: ProblemDetailsSchema,
          403: ProblemDetailsSchema,
          404: ProblemDetailsSchema,
        },
      },
    },
    async (request) => {
      const principal = await verifySupabaseJwt(
        request.headers.authorization,
        jwksProvider,
        jwtOptions,
      );
      const tenantId = request.headers['x-tenant-id'];
      const traceId = String(request.id);

      return withTenantTransaction(
        options.db,
        { tenantId, userId: principal.userId, traceId },
        (trx) => getBatchById(trx, request.params.batchId),
      );
    },
  );

  app.post(
    '/v1/inventory/batches/:batchId/quarantine',
    {
      schema: {
        headers: AuthenticatedTenantHeadersSchema,
        params: Type.Object({ batchId: UuidSchema }),
        body: QuarantineBatchRequestSchema,
        response: {
          200: BatchResponseSchema,
          400: ProblemDetailsSchema,
          401: ProblemDetailsSchema,
          403: ProblemDetailsSchema,
          404: ProblemDetailsSchema,
        },
      },
    },
    async (request) => {
      const principal = await verifySupabaseJwt(
        request.headers.authorization,
        jwksProvider,
        jwtOptions,
      );
      const tenantId = request.headers['x-tenant-id'];
      const traceId = String(request.id);

      return withTenantTransaction(
        options.db,
        { tenantId, userId: principal.userId, traceId },
        (trx) =>
          quarantineBatch(trx, request.params.batchId, request.body.reason),
      );
    },
  );

  app.post(
    '/v1/inventory/batches/:batchId/release',
    {
      schema: {
        headers: AuthenticatedTenantHeadersSchema,
        params: Type.Object({ batchId: UuidSchema }),
        body: Type.Optional(
          Type.Object(
            { reason: Type.Optional(Type.String()) },
            { additionalProperties: false },
          ),
        ),
        response: {
          200: BatchResponseSchema,
          401: ProblemDetailsSchema,
          403: ProblemDetailsSchema,
          404: ProblemDetailsSchema,
        },
      },
    },
    async (request) => {
      const principal = await verifySupabaseJwt(
        request.headers.authorization,
        jwksProvider,
        jwtOptions,
      );
      const tenantId = request.headers['x-tenant-id'];
      const traceId = String(request.id);

      return withTenantTransaction(
        options.db,
        { tenantId, userId: principal.userId, traceId },
        (trx) => releaseBatch(trx, request.params.batchId, request.body?.reason),
      );
    },
  );

  app.post(
    '/v1/inventory/batches/fefo-select',
    {
      schema: {
        headers: AuthenticatedTenantHeadersSchema,
        body: Type.Object(
          {
            warehouseId: UuidSchema,
            productId: UuidSchema,
            requiredQuantity: DecimalQuantityStringSchema,
            allowExpiringSoon: Type.Optional(Type.Boolean()),
          },
          { additionalProperties: false },
        ),
        response: {
          200: FefoSelectionResponseSchema,
          400: ProblemDetailsSchema,
          401: ProblemDetailsSchema,
          403: ProblemDetailsSchema,
        },
      },
    },
    async (request) => {
      const principal = await verifySupabaseJwt(
        request.headers.authorization,
        jwksProvider,
        jwtOptions,
      );
      const tenantId = request.headers['x-tenant-id'];
      const traceId = String(request.id);

      return withTenantTransaction(
        options.db,
        { tenantId, userId: principal.userId, traceId },
        (trx) => selectFefoBatches(trx, request.body),
      );
    },
  );

  // 2. Serial Numbers
  app.post(
    '/v1/inventory/serials',
    {
      schema: {
        headers: AuthenticatedIdempotentHeadersSchema,
        body: RegisterSerialStockRequestSchema,
        response: {
          201: Type.Array(SerialResponseSchema),
          400: ProblemDetailsSchema,
          401: ProblemDetailsSchema,
          403: ProblemDetailsSchema,
          404: ProblemDetailsSchema,
          409: ProblemDetailsSchema,
          422: ProblemDetailsSchema,
        },
      },
    },
    async (request, reply) => {
      const principal = await verifySupabaseJwt(
        request.headers.authorization,
        jwksProvider,
        jwtOptions,
      );
      const tenantId = request.headers['x-tenant-id'];
      const idempotencyKey = request.headers['idempotency-key'];
      const traceId = String(request.id);

      const result = await withTenantTransaction(
        options.db,
        { tenantId, userId: principal.userId, traceId },
        (trx) => registerSerialStock(trx, idempotencyKey, request.body),
      );

      reply.status(201);
      return result;
    },
  );

  app.get(
    '/v1/inventory/serials',
    {
      schema: {
        headers: AuthenticatedTenantHeadersSchema,
        querystring: ListSerialsQuerySchema,
        response: {
          200: createCursorPageResponseSchema(SerialResponseSchema),
          401: ProblemDetailsSchema,
          403: ProblemDetailsSchema,
        },
      },
    },
    async (request) => {
      const principal = await verifySupabaseJwt(
        request.headers.authorization,
        jwksProvider,
        jwtOptions,
      );
      const tenantId = request.headers['x-tenant-id'];
      const traceId = String(request.id);

      return withTenantTransaction(
        options.db,
        { tenantId, userId: principal.userId, traceId },
        (trx) => listSerials(trx, request.query),
      );
    },
  );

  app.get(
    '/v1/inventory/serials/:serialId',
    {
      schema: {
        headers: AuthenticatedTenantHeadersSchema,
        params: Type.Object({ serialId: UuidSchema }),
        response: {
          200: SerialResponseSchema,
          401: ProblemDetailsSchema,
          403: ProblemDetailsSchema,
          404: ProblemDetailsSchema,
        },
      },
    },
    async (request) => {
      const principal = await verifySupabaseJwt(
        request.headers.authorization,
        jwksProvider,
        jwtOptions,
      );
      const tenantId = request.headers['x-tenant-id'];
      const traceId = String(request.id);

      return withTenantTransaction(
        options.db,
        { tenantId, userId: principal.userId, traceId },
        (trx) => getSerialById(trx, request.params.serialId),
      );
    },
  );

  app.post(
    '/v1/inventory/serials/:serialId/transition',
    {
      schema: {
        headers: AuthenticatedTenantHeadersSchema,
        params: Type.Object({ serialId: UuidSchema }),
        body: TransitionSerialStatusRequestSchema,
        response: {
          200: SerialResponseSchema,
          400: ProblemDetailsSchema,
          401: ProblemDetailsSchema,
          403: ProblemDetailsSchema,
          404: ProblemDetailsSchema,
          409: ProblemDetailsSchema,
        },
      },
    },
    async (request) => {
      const principal = await verifySupabaseJwt(
        request.headers.authorization,
        jwksProvider,
        jwtOptions,
      );
      const tenantId = request.headers['x-tenant-id'];
      const traceId = String(request.id);

      return withTenantTransaction(
        options.db,
        { tenantId, userId: principal.userId, traceId },
        (trx) =>
          transitionSerialStatus(trx, request.params.serialId, request.body),
      );
    },
  );

  // 3. Inventory Costing & Valuation
  app.get(
    '/v1/inventory/valuation',
    {
      schema: {
        headers: AuthenticatedTenantHeadersSchema,
        querystring: Type.Object(
          { warehouseId: UuidSchema },
          { additionalProperties: false },
        ),
        response: {
          200: InventoryValuationResponseSchema,
          401: ProblemDetailsSchema,
          403: ProblemDetailsSchema,
        },
      },
    },
    async (request) => {
      const principal = await verifySupabaseJwt(
        request.headers.authorization,
        jwksProvider,
        jwtOptions,
      );
      const tenantId = request.headers['x-tenant-id'];
      const traceId = String(request.id);

      return withTenantTransaction(
        options.db,
        { tenantId, userId: principal.userId, traceId },
        (trx) => getInventoryValuation(trx, request.query.warehouseId),
      );
    },
  );

  app.get(
    '/v1/inventory/cost-layers',
    {
      schema: {
        headers: AuthenticatedTenantHeadersSchema,
        querystring: Type.Object(
          {
            warehouseId: UuidSchema,
            productId: UuidSchema,
          },
          { additionalProperties: false },
        ),
        response: {
          200: Type.Array(FifoCostLayerResponseSchema),
          401: ProblemDetailsSchema,
          403: ProblemDetailsSchema,
        },
      },
    },
    async (request) => {
      const principal = await verifySupabaseJwt(
        request.headers.authorization,
        jwksProvider,
        jwtOptions,
      );
      const tenantId = request.headers['x-tenant-id'];
      const traceId = String(request.id);

      return withTenantTransaction(
        options.db,
        { tenantId, userId: principal.userId, traceId },
        (trx) => listFifoCostLayers(trx, request.query),
      );
    },
  );

  // 4. Stocktake Sessions & Counts
  app.post(
    '/v1/inventory/stocktakes',
    {
      schema: {
        headers: AuthenticatedTenantHeadersSchema,
        body: CreateStocktakeSessionRequestSchema,
        response: {
          201: StocktakeSessionResponseSchema,
          400: ProblemDetailsSchema,
          401: ProblemDetailsSchema,
          403: ProblemDetailsSchema,
          404: ProblemDetailsSchema,
          422: ProblemDetailsSchema,
        },
      },
    },
    async (request, reply) => {
      const principal = await verifySupabaseJwt(
        request.headers.authorization,
        jwksProvider,
        jwtOptions,
      );
      const tenantId = request.headers['x-tenant-id'];
      const traceId = String(request.id);

      const result = await withTenantTransaction(
        options.db,
        { tenantId, userId: principal.userId, traceId },
        (trx) => createStocktakeSession(trx, request.body),
      );

      reply.status(201);
      return result;
    },
  );

  app.get(
    '/v1/inventory/stocktakes',
    {
      schema: {
        headers: AuthenticatedTenantHeadersSchema,
        querystring: ListStocktakeSessionsQuerySchema,
        response: {
          200: createCursorPageResponseSchema(StocktakeSessionResponseSchema),
          401: ProblemDetailsSchema,
          403: ProblemDetailsSchema,
        },
      },
    },
    async (request) => {
      const principal = await verifySupabaseJwt(
        request.headers.authorization,
        jwksProvider,
        jwtOptions,
      );
      const tenantId = request.headers['x-tenant-id'];
      const traceId = String(request.id);

      return withTenantTransaction(
        options.db,
        { tenantId, userId: principal.userId, traceId },
        (trx) => listStocktakeSessions(trx, request.query),
      );
    },
  );

  app.get(
    '/v1/inventory/stocktakes/:sessionId',
    {
      schema: {
        headers: AuthenticatedTenantHeadersSchema,
        params: Type.Object({ sessionId: UuidSchema }),
        response: {
          200: StocktakeSessionResponseSchema,
          401: ProblemDetailsSchema,
          403: ProblemDetailsSchema,
          404: ProblemDetailsSchema,
        },
      },
    },
    async (request) => {
      const principal = await verifySupabaseJwt(
        request.headers.authorization,
        jwksProvider,
        jwtOptions,
      );
      const tenantId = request.headers['x-tenant-id'];
      const traceId = String(request.id);

      return withTenantTransaction(
        options.db,
        { tenantId, userId: principal.userId, traceId },
        (trx) => getStocktakeSessionById(trx, request.params.sessionId),
      );
    },
  );

  app.post(
    '/v1/inventory/stocktakes/:sessionId/counts',
    {
      schema: {
        headers: AuthenticatedTenantHeadersSchema,
        params: Type.Object({ sessionId: UuidSchema }),
        body: RecordStocktakeCountRequestSchema,
        response: {
          200: StocktakeSessionResponseSchema,
          400: ProblemDetailsSchema,
          401: ProblemDetailsSchema,
          403: ProblemDetailsSchema,
          404: ProblemDetailsSchema,
          409: ProblemDetailsSchema,
        },
      },
    },
    async (request) => {
      const principal = await verifySupabaseJwt(
        request.headers.authorization,
        jwksProvider,
        jwtOptions,
      );
      const tenantId = request.headers['x-tenant-id'];
      const traceId = String(request.id);

      return withTenantTransaction(
        options.db,
        { tenantId, userId: principal.userId, traceId },
        (trx) =>
          recordStocktakeCounts(trx, request.params.sessionId, request.body),
      );
    },
  );

  app.post(
    '/v1/inventory/stocktakes/:sessionId/submit',
    {
      schema: {
        headers: AuthenticatedTenantHeadersSchema,
        params: Type.Object({ sessionId: UuidSchema }),
        response: {
          200: StocktakeSessionResponseSchema,
          401: ProblemDetailsSchema,
          403: ProblemDetailsSchema,
          404: ProblemDetailsSchema,
          409: ProblemDetailsSchema,
        },
      },
    },
    async (request) => {
      const principal = await verifySupabaseJwt(
        request.headers.authorization,
        jwksProvider,
        jwtOptions,
      );
      const tenantId = request.headers['x-tenant-id'];
      const traceId = String(request.id);

      return withTenantTransaction(
        options.db,
        { tenantId, userId: principal.userId, traceId },
        (trx) => submitStocktakeSession(trx, request.params.sessionId),
      );
    },
  );

  app.post(
    '/v1/inventory/stocktakes/:sessionId/review',
    {
      schema: {
        headers: AuthenticatedTenantHeadersSchema,
        params: Type.Object({ sessionId: UuidSchema }),
        body: ReviewStocktakeRequestSchema,
        response: {
          200: StocktakeSessionResponseSchema,
          400: ProblemDetailsSchema,
          401: ProblemDetailsSchema,
          403: ProblemDetailsSchema,
          404: ProblemDetailsSchema,
          409: ProblemDetailsSchema,
        },
      },
    },
    async (request) => {
      const principal = await verifySupabaseJwt(
        request.headers.authorization,
        jwksProvider,
        jwtOptions,
      );
      const tenantId = request.headers['x-tenant-id'];
      const traceId = String(request.id);

      return withTenantTransaction(
        options.db,
        { tenantId, userId: principal.userId, traceId },
        (trx) =>
          reviewStocktakeSession(trx, request.params.sessionId, request.body),
      );
    },
  );

  app.post(
    '/v1/inventory/stocktakes/:sessionId/post-adjustments',
    {
      schema: {
        headers: AuthenticatedTenantHeadersSchema,
        params: Type.Object({ sessionId: UuidSchema }),
        response: {
          200: StocktakeSessionResponseSchema,
          401: ProblemDetailsSchema,
          403: ProblemDetailsSchema,
          404: ProblemDetailsSchema,
          409: ProblemDetailsSchema,
        },
      },
    },
    async (request) => {
      const principal = await verifySupabaseJwt(
        request.headers.authorization,
        jwksProvider,
        jwtOptions,
      );
      const tenantId = request.headers['x-tenant-id'];
      const traceId = String(request.id);

      return withTenantTransaction(
        options.db,
        { tenantId, userId: principal.userId, traceId },
        (trx) => postStocktakeAdjustments(trx, request.params.sessionId),
      );
    },
  );

  // ============================================================================
  // PHASE 3: POS & BILLING ROUTES
  // ============================================================================

  // 1. List Authorized POS Registers
  app.get(
    '/v1/pos/registers',
    {
      schema: {
        headers: AuthenticatedTenantHeadersSchema,
        querystring: ListPosRegistersQuerySchema,
        response: {
          200: Type.Array(PosRegisterSummaryResponseSchema),
          401: ProblemDetailsSchema,
          403: ProblemDetailsSchema,
        },
      },
    },
    async (request) => {
      const principal = await verifySupabaseJwt(
        request.headers.authorization,
        jwksProvider,
        jwtOptions,
      );
      const tenantId = request.headers['x-tenant-id'];
      const traceId = String(request.id);

      return withTenantTransaction(
        options.db,
        { tenantId, userId: principal.userId, traceId },
        (trx) => listAuthorizedRegisters(trx, request.query),
      );
    },
  );

  // 2. Open Cashier Shift
  app.post(
    '/v1/pos/shifts',
    {
      schema: {
        headers: AuthenticatedTenantHeadersSchema,
        body: OpenPosShiftRequestSchema,
        response: {
          201: PosShiftResponseSchema,
          400: ProblemDetailsSchema,
          401: ProblemDetailsSchema,
          403: ProblemDetailsSchema,
          404: ProblemDetailsSchema,
          409: ProblemDetailsSchema,
        },
      },
    },
    async (request, reply) => {
      const principal = await verifySupabaseJwt(
        request.headers.authorization,
        jwksProvider,
        jwtOptions,
      );
      const tenantId = request.headers['x-tenant-id'];
      const traceId = String(request.id);

      const shift = await withTenantTransaction(
        options.db,
        { tenantId, userId: principal.userId, traceId },
        (trx) => openPosShift(trx, request.body),
      );

      reply.code(201).send(shift);
    },
  );

  // 3. Close Cashier Shift
  app.post(
    '/v1/pos/shifts/:shiftId/close',
    {
      schema: {
        headers: AuthenticatedTenantHeadersSchema,
        params: Type.Object({ shiftId: UuidSchema }),
        body: ClosePosShiftRequestSchema,
        response: {
          200: PosShiftResponseSchema,
          400: ProblemDetailsSchema,
          401: ProblemDetailsSchema,
          403: ProblemDetailsSchema,
          404: ProblemDetailsSchema,
          409: ProblemDetailsSchema,
        },
      },
    },
    async (request, reply) => {
      const principal = await verifySupabaseJwt(
        request.headers.authorization,
        jwksProvider,
        jwtOptions,
      );
      const tenantId = request.headers['x-tenant-id'];
      const traceId = String(request.id);

      const shift = await withTenantTransaction(
        options.db,
        { tenantId, userId: principal.userId, traceId },
        (trx) => closePosShift(trx, request.params.shiftId, request.body),
      );

      reply.code(200).send(shift);
    },
  );

  // 4. Get Active POS Shift for Register
  app.get(
    '/v1/pos/shifts/active',
    {
      schema: {
        headers: AuthenticatedTenantHeadersSchema,
        querystring: GetActivePosShiftQuerySchema,
        response: {
          200: PosShiftResponseSchema,
          401: ProblemDetailsSchema,
          403: ProblemDetailsSchema,
          404: ProblemDetailsSchema,
        },
      },
    },
    async (request, reply) => {
      const principal = await verifySupabaseJwt(
        request.headers.authorization,
        jwksProvider,
        jwtOptions,
      );
      const tenantId = request.headers['x-tenant-id'];
      const traceId = String(request.id);

      const shift = await withTenantTransaction(
        options.db,
        { tenantId, userId: principal.userId, traceId },
        (trx) => getActivePosShift(trx, request.query.registerId),
      );

      if (!shift) {
        reply.code(404).send({
          type: 'https://nexstock.io/errors/pos-no-active-shift',
          title: 'No Active Shift Found',
          status: 404,
          errorCode: 'POS_NO_ACTIVE_SHIFT',
          detail: `No open cashier shift currently exists for register "${request.query.registerId}".`,
          traceId,
        });
        return;
      }

      reply.code(200).send(shift);
    },
  );

  // 5. Product Discovery for Checkout (Barcode / SKU / Text Search)
  app.get(
    '/v1/pos/products/search',
    {
      schema: {
        headers: AuthenticatedTenantHeadersSchema,
        querystring: PosProductSearchQuerySchema,
        response: {
          200: Type.Array(PosProductItemResponseSchema),
          401: ProblemDetailsSchema,
          403: ProblemDetailsSchema,
        },
      },
    },
    async (request) => {
      const principal = await verifySupabaseJwt(
        request.headers.authorization,
        jwksProvider,
        jwtOptions,
      );
      const tenantId = request.headers['x-tenant-id'];
      const traceId = String(request.id);

      return withTenantTransaction(
        options.db,
        { tenantId, userId: principal.userId, traceId },
        (trx) => searchPosProducts(trx, request.query),
      );
    },
  );

  // 6. Checkout & Sale Creation (Idempotent Atomic Server Transaction)
  app.post(
    '/v1/pos/sales',
    {
      schema: {
        headers: AuthenticatedIdempotentHeadersSchema,
        body: CreatePosSaleRequestSchema,
        response: {
          201: SalesInvoiceResponseSchema,
          400: ProblemDetailsSchema,
          401: ProblemDetailsSchema,
          403: ProblemDetailsSchema,
          404: ProblemDetailsSchema,
          409: ProblemDetailsSchema,
          422: ProblemDetailsSchema,
        },
      },
    },
    async (request, reply) => {
      const principal = await verifySupabaseJwt(
        request.headers.authorization,
        jwksProvider,
        jwtOptions,
      );
      const tenantId = request.headers['x-tenant-id'];
      const idempotencyKey = request.headers['idempotency-key'];
      const traceId = String(request.id);

      const result = await withTenantTransaction(
        options.db,
        { tenantId, userId: principal.userId, traceId },
        (trx) =>
          executeIdempotentMutation({
            trx,
            idempotencyKey,
            endpoint: 'POST /v1/pos/sales',
            requestPayload: request.body,
            execute: async (innerTrx) => {
              const body = await checkoutSale(
                innerTrx,
                idempotencyKey,
                request.body,
              );
              return { statusCode: 201, body };
            },
          }),
      );

      return reply
        .status(result.statusCode as 201)
        .header('x-idempotent-replayed', String(result.replayed))
        .send(result.body);
    },
  );

  // 7. List Sales History
  app.get(
    '/v1/pos/sales',
    {
      schema: {
        headers: AuthenticatedTenantHeadersSchema,
        querystring: ListSalesQuerySchema,
        response: {
          200: Type.Array(SalesInvoiceResponseSchema),
          401: ProblemDetailsSchema,
          403: ProblemDetailsSchema,
        },
      },
    },
    async (request) => {
      const principal = await verifySupabaseJwt(
        request.headers.authorization,
        jwksProvider,
        jwtOptions,
      );
      const tenantId = request.headers['x-tenant-id'];
      const traceId = String(request.id);

      return withTenantTransaction(
        options.db,
        { tenantId, userId: principal.userId, traceId },
        (trx) => listSales(trx, request.query),
      );
    },
  );

  // 8. Get Sale by ID
  app.get(
    '/v1/pos/sales/:saleId',
    {
      schema: {
        headers: AuthenticatedTenantHeadersSchema,
        params: Type.Object({ saleId: UuidSchema }),
        response: {
          200: SalesInvoiceResponseSchema,
          401: ProblemDetailsSchema,
          403: ProblemDetailsSchema,
          404: ProblemDetailsSchema,
        },
      },
    },
    async (request) => {
      const principal = await verifySupabaseJwt(
        request.headers.authorization,
        jwksProvider,
        jwtOptions,
      );
      const tenantId = request.headers['x-tenant-id'];
      const traceId = String(request.id);

      return withTenantTransaction(
        options.db,
        { tenantId, userId: principal.userId, traceId },
        (trx) => getSaleById(trx, request.params.saleId),
      );
    },
  );

  // 9. Void Sale (Idempotent Compensating Inventory Restock)
  app.post(
    '/v1/pos/sales/:saleId/void',
    {
      schema: {
        headers: AuthenticatedIdempotentHeadersSchema,
        params: Type.Object({ saleId: UuidSchema }),
        body: VoidSaleRequestSchema,
        response: {
          200: SalesInvoiceResponseSchema,
          400: ProblemDetailsSchema,
          401: ProblemDetailsSchema,
          403: ProblemDetailsSchema,
          404: ProblemDetailsSchema,
          409: ProblemDetailsSchema,
          422: ProblemDetailsSchema,
        },
      },
    },
    async (request, reply) => {
      const principal = await verifySupabaseJwt(
        request.headers.authorization,
        jwksProvider,
        jwtOptions,
      );
      const tenantId = request.headers['x-tenant-id'];
      const idempotencyKey = request.headers['idempotency-key'];
      const traceId = String(request.id);

      const result = await withTenantTransaction(
        options.db,
        { tenantId, userId: principal.userId, traceId },
        (trx) =>
          executeIdempotentMutation({
            trx,
            idempotencyKey,
            endpoint: `POST /v1/pos/sales/${request.params.saleId}/void`,
            requestPayload: {
              saleId: request.params.saleId,
              body: request.body,
            },
            execute: async (innerTrx) => {
              const body = await voidSale(
                innerTrx,
                request.params.saleId,
                request.body,
              );
              return { statusCode: 200, body };
            },
          }),
      );

      return reply
        .status(result.statusCode as 200)
        .header('x-idempotent-replayed', String(result.replayed))
        .send(result.body);
    },
  );

  // 10. Printable Receipt Data
  app.get(
    '/v1/pos/sales/:saleId/receipt',
    {
      schema: {
        headers: AuthenticatedTenantHeadersSchema,
        params: Type.Object({ saleId: UuidSchema }),
        response: {
          200: ReceiptResponseSchema,
          401: ProblemDetailsSchema,
          403: ProblemDetailsSchema,
          404: ProblemDetailsSchema,
        },
      },
    },
    async (request) => {
      const principal = await verifySupabaseJwt(
        request.headers.authorization,
        jwksProvider,
        jwtOptions,
      );
      const tenantId = request.headers['x-tenant-id'];
      const traceId = String(request.id);

      return withTenantTransaction(
        options.db,
        { tenantId, userId: principal.userId, traceId },
        (trx) => getReceiptData(trx, request.params.saleId),
      );
    },
  );

  return app;
}

import swagger from '@fastify/swagger';
import {
  type TypeBoxTypeProvider,
  TypeBoxValidatorCompiler,
} from '@fastify/type-provider-typebox';
import {
  AuthenticatedTenantHeadersSchema,
  BranchResponseSchema,
  CreateBranchRequestSchema,
  CreateExchangeRateRequestSchema,
  CreateWarehouseRequestSchema,
  CurrencyCodeSchema,
  DecimalMoneyStringSchema,
  HealthStatusResponseSchema,
  IdempotentMutationHeadersSchema,
  ProblemDetailsSchema,
  RecordSubscriptionPaymentRequestSchema,
  SubscriptionStatusSchema,
  SyncPushBatchRequestSchema,
  SyncPushBatchResponseSchema,
  TenantContextHeadersSchema,
  UpsertLocalizationSettingsRequestSchema,
  UuidSchema,
  WarehouseResponseSchema,
} from '@nexstock/contracts';
import { Type } from '@sinclair/typebox';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import {
  convertTenantCurrencyAmount,
  recordTenantExchangeRate,
  upsertTenantLocalizationSettings,
} from './modules/i18n/index.js';
import {
  type JwksKeyProvider,
  type JwtVerificationOptions,
  RemoteJwksProvider,
  type SystemRoleCode,
  assertAuthorized,
  provisionTenantMember,
  verifySupabaseJwt,
} from './modules/iam/index.js';
import {
  createBranch,
  createWarehouse,
  getBranchById,
  listBranches,
  onboardTenantOrganization,
  updateBranchName,
} from './modules/org/index.js';
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
  withTenantTransaction,
} from './modules/shared/index.js';
import {
  type SubscriptionPlanCode,
  assertSubscriptionEntitlement,
  defaultManualBillingAdapter,
  getTenantSubscriptionEntitlement,
  issueSubscriptionInvoice,
} from './modules/sub/index.js';

export const DEFAULT_SUPABASE_URL = 'https://tokylhdgzyoxiqwvncis.supabase.co';
export const DEFAULT_SUPABASE_JWKS_URL = `${DEFAULT_SUPABASE_URL}/auth/v1/.well-known/jwks.json`;
export const DEFAULT_SUPABASE_JWT_ISSUER = `${DEFAULT_SUPABASE_URL}/auth/v1`;
export const DEFAULT_SUPABASE_JWT_AUDIENCE = 'authenticated';

export interface BuildAppOptions {
  readonly db: Kysely<NexStockDatabase>;
  readonly jwksProvider?: JwksKeyProvider | undefined;
  readonly jwtVerificationOptions?: Partial<JwtVerificationOptions> | undefined;
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

    return reply
      .status(500)
      .header('content-type', 'application/problem+json')
      .send({
        type: 'https://api.nexstock.io/errors/err-internal-server-error',
        title: 'Internal Server Error',
        status: 500,
        detail:
          error instanceof Error
            ? error.message
            : 'An unexpected error occurred.',
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
        },
      },
    },
    async (request) => {
      const probeTenantId = '00000000-0000-7000-8000-000000000000';
      const probeUserId = '00000000-0000-7000-8000-000000000000';
      await withTenantTransaction(
        options.db,
        {
          tenantId: probeTenantId,
          userId: probeUserId,
          traceId: String(request.id),
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
    },
  );

  // 3. OpenAPI 3.1 JSON Spec Endpoint
  app.get('/v1/openapi.json', async () => {
    return app.swagger();
  });

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

  // 14. Get Subscription Entitlement
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

  return app;
}

import { type Kysely, type Transaction, sql } from 'kysely';
import { AppError } from '../domain/errors.js';
import type { NexStockDatabase } from './kysely-schema.js';

const TENANT_TRX_BRAND: unique symbol = Symbol('TENANT_TRX_BRAND');

/**
 * Branded Kysely Transaction guaranteeing that:
 * 1. Execution is pinned to a single database transaction (`BEGIN ... COMMIT`).
 * 2. Active role is `nexstock_app_user` (`NOBYPASSRLS`).
 * 3. `app.current_tenant_id` and `app.current_user_id` are set with `is_local = true` (`SET LOCAL`).
 */
export type TenantTransaction = Transaction<NexStockDatabase> & {
  readonly [TENANT_TRX_BRAND]: true;
  readonly tenantContext: TenantExecutionContext;
  readonly db: Transaction<NexStockDatabase>;
  readonly tenantId: string;
  readonly userId: string;
  readonly platformRole?: 'SUPER_ADMIN' | 'BILLING_ADMIN' | 'SUPPORT_ADMIN' | 'ANALYST' | undefined;
  readonly _trxCache?: Map<string, unknown>;
};

export type TenantTransactionContext = TenantTransaction;

export interface TenantExecutionContext {
  readonly tenantId: string;
  readonly userId: string;
  readonly deviceId?: string | undefined;
  readonly traceId: string;
}

const UUID_REGEX =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function assertValidTenantExecutionContext(
  ctx: TenantExecutionContext,
): void {
  if (!ctx.tenantId || !UUID_REGEX.test(ctx.tenantId)) {
    throw new AppError({
      statusCode: 400,
      errorCode: 'ERR_TENANT_CONTEXT_MISSING',
      title: 'Missing or Invalid Tenant Context',
      detail: 'A valid UUID tenantId is required to open a tenant transaction.',
    });
  }
  if (!ctx.userId || !UUID_REGEX.test(ctx.userId)) {
    throw new AppError({
      statusCode: 401,
      errorCode: 'ERR_UNAUTHORIZED',
      title: 'Missing or Invalid Actor User ID',
      detail: 'A valid UUID userId is required to open a tenant transaction.',
    });
  }
}

/**
 * Executes `fn` inside an atomic PostgreSQL transaction with transaction-scoped
 * Row Level Security (`SET LOCAL ROLE nexstock_app_user` + `set_config(..., true)`).
 */
export async function withTenantTransaction<T>(
  db: Kysely<NexStockDatabase>,
  ctx: TenantExecutionContext,
  fn: (trx: TenantTransaction) => Promise<T>,
): Promise<T> {
  assertValidTenantExecutionContext(ctx);

  return db.transaction().execute(async (trx) => {
    // 1. Switch transaction-local role to nexstock_app_user (NOSUPERUSER NOBYPASSRLS)
    await sql`SET LOCAL ROLE nexstock_app_user`.execute(trx);

    // 2. Set transaction-scoped context variables (is_local = true clears automatically on COMMIT/ROLLBACK)
    await sql`
      SELECT
        set_config('app.current_tenant_id', ${ctx.tenantId}, true),
        set_config('app.current_user_id', ${ctx.userId}, true),
        set_config('app.is_platform_admin', 'false', true)
    `.execute(trx);

    const brandedTrx = Object.assign(trx, {
      [TENANT_TRX_BRAND]: true as const,
      tenantContext: ctx,
      db: trx,
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      _trxCache: new Map<string, unknown>(),
    }) as TenantTransaction;

    return fn(brandedTrx);
  });
}

export interface UserExecutionContext {
  readonly userId: string;
  readonly traceId: string;
}

export function assertValidUserExecutionContext(
  ctx: UserExecutionContext,
): void {
  if (!ctx.userId || !UUID_REGEX.test(ctx.userId)) {
    throw new AppError({
      statusCode: 401,
      errorCode: 'ERR_UNAUTHORIZED',
      title: 'Missing or Invalid Actor User ID',
      detail: 'A valid UUID userId is required to open a user transaction.',
    });
  }
}

/**
 * Executes `fn` inside an atomic PostgreSQL transaction with user-scoped
 * Row Level Security (`SET LOCAL ROLE nexstock_app_user` + `app.current_user_id` set, `app.current_tenant_id` cleared).
 * Used for user-centric queries across tenants (e.g. listing authorized memberships).
 */
export async function withUserTransaction<T>(
  db: Kysely<NexStockDatabase>,
  ctx: UserExecutionContext,
  fn: (trx: Transaction<NexStockDatabase>) => Promise<T>,
): Promise<T> {
  assertValidUserExecutionContext(ctx);

  return db.transaction().execute(async (trx) => {
    // 1. Switch transaction-local role to nexstock_app_user (NOSUPERUSER NOBYPASSRLS)
    await sql`SET LOCAL ROLE nexstock_app_user`.execute(trx);

    // 2. Set user context and clear tenant context
    await sql`
      SELECT
        set_config('app.current_user_id', ${ctx.userId}, true),
        set_config('app.current_tenant_id', '', true),
        set_config('app.is_platform_admin', 'false', true)
    `.execute(trx);

    return fn(trx);
  });
}

/**
 * Executes `fn` inside a transaction scoped as Platform Super Admin (`users.is_platform_admin = true` strictly verified in DB).
 * Never auto-elevates from email string or HTTP headers; sets `app.is_platform_admin = 'true'` with `SET LOCAL` ONLY after verification.
 */
export async function withPlatformAdminTransaction<T>(
  db: Kysely<NexStockDatabase>,
  ctx: {
    readonly userId: string;
    readonly targetTenantId?: string | undefined;
    readonly traceId: string;
    readonly allowedRoles?: readonly (
      | 'SUPER_ADMIN'
      | 'BILLING_ADMIN'
      | 'SUPPORT_ADMIN'
      | 'ANALYST'
    )[] | undefined;
    readonly requireMfaStepUp?: boolean | undefined;
    readonly jwtAal?: string | undefined;
    readonly jwtAmr?: readonly string[] | undefined;
  },
  fn: (trx: TenantTransaction) => Promise<T>,
): Promise<T> {
  assertValidUserExecutionContext({ userId: ctx.userId, traceId: ctx.traceId });
  if (ctx.targetTenantId && !UUID_REGEX.test(ctx.targetTenantId)) {
    throw new AppError({
      statusCode: 400,
      errorCode: 'ERR_TENANT_CONTEXT_MISSING',
      title: 'Invalid Target Tenant ID',
      detail: 'Target tenantId must be a valid UUID.',
    });
  }

  return db.transaction().execute(async (trx) => {
    await sql`SET LOCAL ROLE nexstock_app_user`.execute(trx);
    await sql`
      SELECT
        set_config('app.current_user_id', ${ctx.userId}, true),
        set_config('app.current_tenant_id', ${ctx.targetTenantId ?? ''}, true),
        set_config('app.is_platform_admin', 'false', true)
    `.execute(trx);

    const userRow = await trx
      .selectFrom('users')
      .select(['id', 'email', 'is_platform_admin'])
      .where('id', '=', ctx.userId)
      .executeTakeFirst();

    if (!userRow || userRow.is_platform_admin !== true) {
      throw new AppError({
        statusCode: 403,
        errorCode: 'SUB_PLATFORM_ADMIN_REQUIRED',
        title: 'Platform Super Admin Authorization Required',
        detail:
          'This operation requires an authenticated Platform Super Admin account (is_platform_admin = true).',
      });
    }

    await sql`SELECT set_config('app.is_platform_admin', 'true', true)`.execute(trx);

    const adminAcct = await trx
      .selectFrom('platform_admin_accounts')
      .select([
        'platform_role',
        'status',
        'mfa_enforced',
        'totp_enabled',
        'mfa_verified_until',
      ])
      .where('user_id', '=', ctx.userId)
      .executeTakeFirst()
      .catch(() => undefined);

    if (adminAcct?.status === 'SUSPENDED') {
      throw new AppError({
        statusCode: 403,
        errorCode: 'SUB_PLATFORM_ADMIN_REQUIRED',
        title: 'Platform Admin Account Suspended',
        detail: 'Your Platform Admin account has been suspended.',
      });
    }

    const effectiveRole = adminAcct?.platform_role ?? 'SUPER_ADMIN';
    if (ctx.allowedRoles && !ctx.allowedRoles.includes(effectiveRole)) {
      throw new AppError({
        statusCode: 403,
        errorCode: 'SUB_PLATFORM_ADMIN_REQUIRED',
        title: 'Insufficient Platform Admin Role',
        detail: `This operation requires one of: ${ctx.allowedRoles.join(', ')}.`,
      });
    }

    const mfaRequired =
      Boolean(ctx.requireMfaStepUp) &&
      (Boolean(adminAcct?.mfa_enforced) ||
        effectiveRole === 'SUPER_ADMIN' ||
        process.env['NEXSTOCK_REQUIRE_PLATFORM_MFA'] === 'true');

    if (mfaRequired) {
      const hasJwtMfa =
        ctx.jwtAal === 'aal2' || Boolean(ctx.jwtAmr?.includes('totp'));
      const hasBackendMfa =
        Boolean(adminAcct?.totp_enabled) &&
        Boolean(adminAcct?.mfa_verified_until) &&
        new Date(adminAcct!.mfa_verified_until!).getTime() > Date.now();

      if (!hasJwtMfa && !hasBackendMfa) {
        throw new AppError({
          statusCode: 403,
          errorCode: 'SUB_PLATFORM_MFA_REQUIRED',
          title: 'Multi-Factor Verification Required',
          detail:
            'Sensitive Platform Super Admin operations require an active TOTP/MFA step-up verification.',
        });
      }
    }

    const tenantCtx: TenantExecutionContext = {
      tenantId: ctx.targetTenantId ?? ctx.userId,
      userId: ctx.userId,
      traceId: ctx.traceId,
    };

    const brandedTrx = Object.assign(trx, {
      [TENANT_TRX_BRAND]: true as const,
      tenantContext: tenantCtx,
      db: trx,
      tenantId: tenantCtx.tenantId,
      userId: ctx.userId,
      platformRole: effectiveRole,
      _trxCache: new Map<string, unknown>(),
    }) as TenantTransaction;

    return fn(brandedTrx);
  });
}

/**
 * Executes `fn` inside an atomic PostgreSQL transaction with the application runtime role
 * (`SET LOCAL ROLE nexstock_app_user`). Sets `app.current_user_id` if provided, and clears `app.current_tenant_id`.
 * Suitable for authentication checks, user pre-existence checks, and sync operations before a tenant context exists.
 */
export async function withAppUserTransaction<T>(
  db: Kysely<NexStockDatabase>,
  ctx: { readonly traceId?: string | undefined; readonly userId?: string | undefined },
  fn: (trx: Transaction<NexStockDatabase>) => Promise<T>,
): Promise<T> {
  return db.transaction().execute(async (trx) => {
    // 1. Switch transaction-local role to nexstock_app_user (NOSUPERUSER NOBYPASSRLS)
    await sql`SET LOCAL ROLE nexstock_app_user`.execute(trx);

    // 2. Set user context (or empty string if not authenticated yet) and clear tenant context
    const currentUserId = ctx.userId && UUID_REGEX.test(ctx.userId) ? ctx.userId : '';
    await sql`
      SELECT
        set_config('app.current_user_id', ${currentUserId}, true),
        set_config('app.current_tenant_id', '', true),
        set_config('app.is_platform_admin', 'false', true)
    `.execute(trx);

    return fn(trx);
  });
}


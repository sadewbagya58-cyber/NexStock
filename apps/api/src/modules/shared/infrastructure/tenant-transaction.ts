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
    }) as TenantTransaction;

    return fn(brandedTrx);
  });
}

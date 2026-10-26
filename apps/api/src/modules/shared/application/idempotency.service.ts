import { createHash } from 'node:crypto';
import { AppError } from '../domain/errors.js';
import type { TenantTransaction } from '../infrastructure/tenant-transaction.js';

export interface IdempotentExecutionResult<T> {
  readonly statusCode: number;
  readonly body: T;
  readonly replayed: boolean;
}

/**
 * Deterministic canonical JSON SHA-256 hash so key order differences do not cause false mismatches.
 */
export function computeCanonicalPayloadHash(payload: unknown): string {
  const canonicalJson = canonicalizeValue(payload);
  return createHash('sha256').update(canonicalJson, 'utf8').digest('hex');
}

function canonicalizeValue(value: unknown): string {
  if (value === null || value === undefined) {
    return 'null';
  }
  if (typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalizeValue(item)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const sortedKeys = Object.keys(obj).sort();
  const entries = sortedKeys.map(
    (k) => `${JSON.stringify(k)}:${canonicalizeValue(obj[k])}`,
  );
  return `{${entries.join(',')}}`;
}

/**
 * Executes a mutation inside a tenant-scoped transaction with strict idempotency guarantees
 * (NEX-DOC-07 Section 3.1 & Principle #8).
 */
export async function executeIdempotentMutation<T>(params: {
  readonly trx: TenantTransaction;
  readonly idempotencyKey: string;
  readonly endpoint: string;
  readonly requestPayload: unknown;
  readonly ttlSeconds?: number;
  readonly execute: (
    trx: TenantTransaction,
  ) => Promise<{ statusCode: number; body: T }>;
}): Promise<IdempotentExecutionResult<T>> {
  const { trx, idempotencyKey, endpoint, requestPayload } = params;
  const { tenantId, userId } = trx.tenantContext;
  const requestHash = computeCanonicalPayloadHash(requestPayload);
  const ttlSeconds = params.ttlSeconds ?? 7 * 24 * 60 * 60; // Default 7 days
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

  const inserted = await trx
    .insertInto('idempotency_keys')
    .values({
      tenant_id: tenantId,
      idempotency_key: idempotencyKey,
      actor_user_id: userId,
      endpoint,
      request_hash: requestHash,
      status: 'PROCESSING',
      response_status_code: null,
      response_body: null,
      expires_at: expiresAt,
    })
    .onConflict((oc) =>
      oc.columns(['tenant_id', 'idempotency_key']).doNothing(),
    )
    .returning(['status'])
    .executeTakeFirst();

  if (!inserted) {
    // Key already exists for this tenant -> inspect existing record
    const existing = await trx
      .selectFrom('idempotency_keys')
      .select([
        'status',
        'request_hash',
        'response_status_code',
        'response_body',
      ])
      .where('tenant_id', '=', tenantId)
      .where('idempotency_key', '=', idempotencyKey)
      .executeTakeFirst();

    if (!existing) {
      throw new AppError({
        statusCode: 409,
        errorCode: 'ERR_IDEMPOTENCY_IN_PROGRESS',
        title: 'Idempotent Request Conflict',
        detail: 'Unable to resolve existing idempotency key state.',
      });
    }

    if (existing.request_hash.trim() !== requestHash) {
      throw new AppError({
        statusCode: 422,
        errorCode: 'ERR_IDEMPOTENCY_KEY_REUSED_DIFFERENT_PAYLOAD',
        title: 'Idempotency Key Reused With Different Payload',
        detail: `Idempotency-Key "${idempotencyKey}" was already used with a different request payload.`,
      });
    }

    if (existing.status === 'PROCESSING') {
      throw new AppError({
        statusCode: 409,
        errorCode: 'ERR_IDEMPOTENCY_IN_PROGRESS',
        title: 'Request Already In Progress',
        detail: `A request with Idempotency-Key "${idempotencyKey}" is currently being processed.`,
      });
    }

    const parsedBody =
      typeof existing.response_body === 'string'
        ? (JSON.parse(existing.response_body) as T)
        : (existing.response_body as T);

    return {
      statusCode: existing.response_status_code ?? 200,
      body: parsedBody,
      replayed: true,
    };
  }

  // First time seeing this Idempotency-Key -> execute mutation inside the same transaction
  const outcome = await params.execute(trx);

  await trx
    .updateTable('idempotency_keys')
    .set({
      status: 'COMPLETED',
      response_status_code: outcome.statusCode,
      response_body: JSON.stringify(outcome.body),
    })
    .where('tenant_id', '=', tenantId)
    .where('idempotency_key', '=', idempotencyKey)
    .execute();

  return {
    statusCode: outcome.statusCode,
    body: outcome.body,
    replayed: false,
  };
}

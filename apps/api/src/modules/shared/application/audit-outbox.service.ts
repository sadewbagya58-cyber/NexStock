import { generateUuidV7 } from '../domain/uuidv7.js';
import type { TenantTransaction } from '../infrastructure/tenant-transaction.js';

export interface AppendAuditLogInput {
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly metadata?: Record<string, unknown>;
}

export async function appendAuditLog(
  trx: TenantTransaction,
  input: AppendAuditLogInput,
): Promise<string> {
  const id = generateUuidV7();
  const { tenantId, userId, traceId } = trx.tenantContext;

  await trx
    .insertInto('audit_logs')
    .values({
      id,
      tenant_id: tenantId,
      actor_user_id: userId,
      action: input.action,
      resource_type: input.resourceType,
      resource_id: input.resourceId,
      metadata_json: JSON.stringify(input.metadata ?? {}),
      trace_id: traceId,
    })
    .execute();

  return id;
}

export interface EnqueueOutboxEventInput {
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly payload: Record<string, unknown>;
}

export async function enqueueOutboxEvent(
  trx: TenantTransaction,
  input: EnqueueOutboxEventInput,
): Promise<string> {
  const id = generateUuidV7();
  const { tenantId } = trx.tenantContext;

  await trx
    .insertInto('outbox_events')
    .values({
      id,
      tenant_id: tenantId,
      aggregate_type: input.aggregateType,
      aggregate_id: input.aggregateId,
      event_type: input.eventType,
      payload_json: JSON.stringify(input.payload),
      status: 'PENDING',
      processed_at: null,
    })
    .execute();

  return id;
}

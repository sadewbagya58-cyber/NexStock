import type {
  SyncCommandAckStatus,
  SyncCommandEnvelope,
  SyncPushBatchResponse,
} from '@nexstock/contracts';
import { sql } from 'kysely';
import { AppError } from '../domain/errors.js';
import { generateUuidV7 } from '../domain/uuidv7.js';
import type { TenantTransaction } from '../infrastructure/tenant-transaction.js';

export interface SyncCommandHandlerOutcome {
  readonly status: 'APPLIED' | 'APPLIED_WITH_CONFLICT_FLAG';
  readonly conflictCode?: string;
  readonly conflictDetails?: Record<string, unknown>;
  readonly responsePayload?: Record<string, unknown>;
  readonly serverReferenceId?: string;
  readonly serverReferenceNumber?: string;
}

export type SyncCommandDomainHandler = (
  trx: TenantTransaction,
  envelope: SyncCommandEnvelope,
) => Promise<SyncCommandHandlerOutcome>;

export class SyncPoisonPillError extends Error {
  readonly conflictCode: string;
  readonly details: Record<string, unknown>;

  constructor(
    conflictCode: string,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'SyncPoisonPillError';
    this.conflictCode = conflictCode;
    this.details = details;
  }
}

/**
 * Processes an ordered batch of offline commands with:
 * 1. Causal `localSeq` ordering verification.
 * 2. Duplicate prevention via `sync_command_log`.
 * 3. Per-command PostgreSQL SAVEPOINT isolation.
 * 4. Poison-pill quarantine into `sync_conflicts` so subsequent commands are not blocked.
 */
export async function processSyncCommandBatch(params: {
  readonly trx: TenantTransaction;
  readonly deviceId: string;
  readonly branchId: string;
  readonly commands: readonly SyncCommandEnvelope[];
  readonly handler: SyncCommandDomainHandler;
}): Promise<SyncPushBatchResponse> {
  const { trx, deviceId, branchId, commands, handler } = params;
  const { tenantId } = trx.tenantContext;

  // 1. Verify causal localSeq ordering and tenant/device binding before processing
  let prevSeq = 0;
  for (const cmd of commands) {
    if (cmd.tenantId !== tenantId) {
      throw new AppError({
        statusCode: 403,
        errorCode: 'ERR_FORBIDDEN',
        title: 'Cross-Tenant Sync Command Rejected',
        detail: `Sync command "${cmd.commandId}" tenantId (${cmd.tenantId}) does not match active tenant context (${tenantId}).`,
      });
    }
    if (cmd.deviceId !== deviceId || cmd.branchId !== branchId) {
      throw new AppError({
        statusCode: 422,
        errorCode: 'ERR_VALIDATION_FAILED',
        title: 'Mismatched Device or Branch in Sync Batch',
        detail: `Command "${cmd.commandId}" deviceId/branchId does not match batch header.`,
      });
    }
    if (cmd.localSeq <= prevSeq) {
      throw new AppError({
        statusCode: 422,
        errorCode: 'ERR_VALIDATION_FAILED',
        title: 'Non-Monotonic Offline Command Sequence',
        detail: `Offline commands must be submitted in strictly increasing localSeq order (saw ${cmd.localSeq} after ${prevSeq}).`,
      });
    }
    prevSeq = cmd.localSeq;
  }

  const receipts: SyncPushBatchResponse['receipts'] = [];

  for (let idx = 0; idx < commands.length; idx++) {
    const cmd = commands[idx]!;
    const nowIso = new Date().toISOString();

    // 2. Check if commandId was already processed (Duplicate Prevention — NEX-DOC-08 Sec 6.1)
    const existingLog = await trx
      .selectFrom('sync_command_log')
      .select(['status', 'conflict_code', 'response_json'])
      .where('tenant_id', '=', tenantId)
      .where('command_id', '=', cmd.commandId)
      .executeTakeFirst();

    if (existingLog) {
      const respObj =
        existingLog.response_json && typeof existingLog.response_json === 'object'
          ? (existingLog.response_json as Record<string, unknown>)
          : {};
      const existingRefId =
        typeof respObj['saleId'] === 'string'
          ? respObj['saleId']
          : typeof respObj['movementId'] === 'string'
            ? respObj['movementId']
            : typeof respObj['transferId'] === 'string'
              ? respObj['transferId']
              : typeof respObj['returnId'] === 'string'
                ? respObj['returnId']
                : undefined;
      const existingRefNum =
        typeof respObj['invoiceNumber'] === 'string'
          ? respObj['invoiceNumber']
          : typeof respObj['transferNumber'] === 'string'
            ? respObj['transferNumber']
            : typeof respObj['returnNumber'] === 'string'
              ? respObj['returnNumber']
              : undefined;
      receipts.push({
        commandId: cmd.commandId,
        localSeq: cmd.localSeq,
        status: 'DUPLICATE_IGNORED',
        ...(existingLog.conflict_code
          ? { conflictCode: existingLog.conflict_code }
          : {}),
        ...(existingRefId ? { serverReferenceId: existingRefId } : {}),
        ...(existingRefNum ? { serverReferenceNumber: existingRefNum } : {}),
        serverProcessedAt: nowIso,
      });
      continue;
    }

    // 3. Execute command handler inside its own SAVEPOINT
    const savepointName = `sp_sync_cmd_${idx}`;
    await sql`SAVEPOINT ${sql.raw(savepointName)}`.execute(trx);

    try {
      const outcome = await handler(trx, cmd);
      await sql`RELEASE SAVEPOINT ${sql.raw(savepointName)}`.execute(trx);

      await trx
        .insertInto('sync_command_log')
        .values({
          tenant_id: tenantId,
          command_id: cmd.commandId,
          branch_id: cmd.branchId,
          device_id: cmd.deviceId,
          actor_user_id: cmd.actorUserId,
          local_seq: cmd.localSeq,
          command_type: cmd.commandType,
          status: outcome.status,
          conflict_code: outcome.conflictCode ?? null,
          response_json: JSON.stringify(outcome.responsePayload ?? {}),
          occurred_at: cmd.occurredAt,
        })
        .execute();

      let conflictId: string | undefined;
      if (
        outcome.status === 'APPLIED_WITH_CONFLICT_FLAG' &&
        outcome.conflictCode
      ) {
        conflictId = generateUuidV7();
        await trx
          .insertInto('sync_conflicts')
          .values({
            id: conflictId,
            tenant_id: tenantId,
            branch_id: cmd.branchId,
            device_id: cmd.deviceId,
            command_id: cmd.commandId,
            command_type: cmd.commandType,
            conflict_type: outcome.conflictCode,
            status: 'OPEN',
            details_json: JSON.stringify(outcome.conflictDetails ?? {}),
            original_payload_json: JSON.stringify(cmd.payload ?? {}),
            resolution_action: null,
            resolution_notes: null,
            resolved_by_user_id: null,
            resolved_at: null,
          })
          .execute();
      }

      receipts.push({
        commandId: cmd.commandId,
        localSeq: cmd.localSeq,
        status: outcome.status as SyncCommandAckStatus,
        ...(conflictId ? { conflictId } : {}),
        ...(outcome.conflictCode ? { conflictCode: outcome.conflictCode } : {}),
        ...(outcome.serverReferenceId
          ? { serverReferenceId: outcome.serverReferenceId }
          : {}),
        ...(outcome.serverReferenceNumber
          ? { serverReferenceNumber: outcome.serverReferenceNumber }
          : {}),
        serverProcessedAt: nowIso,
      });
    } catch (err) {
      // Roll back only the failed command's partial writes inside the savepoint
      await sql`ROLLBACK TO SAVEPOINT ${sql.raw(savepointName)}`.execute(trx);
      await sql`RELEASE SAVEPOINT ${sql.raw(savepointName)}`.execute(trx);

      if (err instanceof SyncPoisonPillError) {
        // Record as QUARANTINED so subsequent commands in the terminal outbox continue syncing
        await trx
          .insertInto('sync_command_log')
          .values({
            tenant_id: tenantId,
            command_id: cmd.commandId,
            branch_id: cmd.branchId,
            device_id: cmd.deviceId,
            actor_user_id: cmd.actorUserId,
            local_seq: cmd.localSeq,
            command_type: cmd.commandType,
            status: 'QUARANTINED',
            conflict_code: err.conflictCode,
            response_json: JSON.stringify({ error: err.message, ...err.details }),
            occurred_at: cmd.occurredAt,
          })
          .execute();

        const conflictId = generateUuidV7();
        await trx
          .insertInto('sync_conflicts')
          .values({
            id: conflictId,
            tenant_id: tenantId,
            branch_id: cmd.branchId,
            device_id: cmd.deviceId,
            command_id: cmd.commandId,
            command_type: cmd.commandType,
            conflict_type: err.conflictCode,
            status: 'QUARANTINED',
            details_json: JSON.stringify({
              message: err.message,
              ...err.details,
            }),
            original_payload_json: JSON.stringify(cmd.payload ?? {}),
            resolution_action: null,
            resolution_notes: null,
            resolved_by_user_id: null,
            resolved_at: null,
          })
          .execute();

        receipts.push({
          commandId: cmd.commandId,
          localSeq: cmd.localSeq,
          status: 'QUARANTINED',
          conflictId,
          conflictCode: err.conflictCode,
          errorMessage: err.message,
          serverDetails: err.details,
          serverProcessedAt: nowIso,
        });
      } else {
        throw err;
      }
    }
  }

  return { receipts };
}

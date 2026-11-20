import { createHash } from 'node:crypto';
import type {
  ResolveSyncConflictRequest,
  ResolveSyncConflictResponse,
  SyncCommandEnvelope,
} from '@nexstock/contracts';
import { OfflineEngineError } from './capability-policy.js';
import type {
  OfflineLocalConflictRecord,
  OfflineRecoveryBackupPayload,
  OfflineStoragePort,
  OfflineSyncConnectionState,
  OfflineSyncEngineStatus,
  OfflineSyncRunResult,
  OfflineSyncTransportPort,
} from './types.js';

export function computeExponentialBackoffMs(retryCount: number, baseMs = 2000, maxMs = 120000): number {
  const safeRetries = Math.max(0, Math.min(retryCount, 10));
  return Math.min(maxMs, baseMs * Math.pow(2, safeRetries));
}

export function computeRecoveryBackupChecksum(
  payload: Omit<OfflineRecoveryBackupPayload, 'checksumSha256'>,
): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export function isRetryableSyncTransportError(err: unknown): boolean {
  if (err && typeof err === 'object' && 'statusCode' in err) {
    const sc = Number((err as { statusCode?: unknown }).statusCode);
    if (sc === 401 || sc === 403 || sc === 422) {
      return false;
    }
  }
  return true;
}

/**
 * Phase 9.6 / 9.7 / 9.9 — Cross-Platform Offline Sync, Crash Recovery & Integrity Engine.
 */
export class OfflineSyncEngine {
  private syncInFlight = false;
  private isOnline = true;

  constructor(
    private readonly storage: OfflineStoragePort,
    private readonly transport?: OfflineSyncTransportPort,
  ) {}

  setOnlineState(online: boolean): void {
    this.isOnline = online;
  }

  async recoverInterruptedSyncOnStartup(tenantId: string): Promise<number> {
    if (!this.storage.recoverInFlightOutboxCommands) {
      return 0;
    }
    return this.storage.recoverInFlightOutboxCommands({ tenantId });
  }

  async getStatus(tenantId: string, branchId?: string): Promise<OfflineSyncEngineStatus> {
    const outbox = await this.storage.listPendingOutboxCommands({ tenantId, limit: 500 });
    const conflicts = this.storage.listLocalConflicts
      ? await this.storage.listLocalConflicts({
          tenantId,
          ...(branchId ? { branchId } : {}),
        })
      : [];
    const openConflicts = conflicts.filter(
      (c) => c.status === 'OPEN' || c.status === 'QUARANTINED',
    );
    const pendingCount = outbox.filter(
      (c) => c.status === 'PENDING' || c.status === 'IN_FLIGHT',
    ).length;
    const failedCount = outbox.filter(
      (c) => c.status === 'PENDING' && c.retryCount > 0 && Boolean(c.lastError),
    ).length;
    const secState = this.storage.getDeviceSecurityState
      ? await this.storage.getDeviceSecurityState({ tenantId })
      : null;

    let connectionState: OfflineSyncConnectionState = 'ONLINE';
    if (this.syncInFlight) {
      connectionState = 'SYNCING';
    } else if (!this.isOnline) {
      connectionState = 'OFFLINE';
    } else if (openConflicts.length > 0) {
      connectionState = 'CONFLICT';
    } else if (failedCount > 0 || (secState?.lastSyncError && pendingCount > 0)) {
      connectionState = 'SYNC_FAILED';
    } else if (pendingCount > 0) {
      connectionState = 'PENDING_SYNC';
    }

    return {
      connectionState,
      isOnline: this.isOnline,
      isSyncing: this.syncInFlight,
      pendingCount,
      failedCount,
      openConflictCount: openConflicts.length,
      lastSyncAttemptAt: secState?.lastSyncAttemptAt ?? null,
      lastSyncSuccessAt: secState?.lastSyncSuccessAt ?? null,
      lastError: secState?.lastSyncError ?? null,
      deviceSecurityStatus: secState?.status ?? 'ACTIVE',
      revokedReason: secState?.revokedReason ?? null,
    };
  }

  async syncNow(params?: {
    readonly batchSize?: number;
    readonly forceEvenIfOfflineFlagFalse?: boolean;
  }): Promise<OfflineSyncRunResult> {
    const devCtx = await this.storage.getDeviceContext();
    if (!devCtx) {
      throw new OfflineEngineError(
        'OFFLINE_DEVICE_UNBOUND',
        'No enrolled offline device context is present.',
        401,
      );
    }

    if (this.syncInFlight) {
      const status = await this.getStatus(devCtx.tenantId, devCtx.branchId);
      return {
        pushedCount: 0,
        appliedCount: 0,
        duplicateCount: 0,
        quarantinedCount: 0,
        conflictFlaggedCount: 0,
        failedCount: 0,
        recoveredInFlightCount: 0,
        pulledOpenConflicts: status.openConflictCount,
        deviceRevoked: status.deviceSecurityStatus === 'REVOKED',
        lastError: status.lastError,
        status,
      };
    }

    if (!this.isOnline && !params?.forceEvenIfOfflineFlagFalse) {
      const status = await this.getStatus(devCtx.tenantId, devCtx.branchId);
      return {
        pushedCount: 0,
        appliedCount: 0,
        duplicateCount: 0,
        quarantinedCount: 0,
        conflictFlaggedCount: 0,
        failedCount: 0,
        recoveredInFlightCount: 0,
        pulledOpenConflicts: status.openConflictCount,
        deviceRevoked: status.deviceSecurityStatus === 'REVOKED',
        lastError: 'Device is offline.',
        status,
      };
    }

    if (!this.transport) {
      throw new OfflineEngineError(
        'SYNC_TRANSPORT_UNCONFIGURED',
        'Sync transport is not attached to OfflineSyncEngine.',
        500,
      );
    }

    this.syncInFlight = true;
    const nowIso = new Date().toISOString();
    let pushedCount = 0;
    let appliedCount = 0;
    let duplicateCount = 0;
    let quarantinedCount = 0;
    let conflictFlaggedCount = 0;
    let failedCount = 0;
    let deviceRevoked = false;
    let lastError: string | null = null;
    let recoveredInFlightCount = 0;
    let pulledOpenConflicts = 0;

    try {
      recoveredInFlightCount = await this.recoverInterruptedSyncOnStartup(devCtx.tenantId);

      const batchLimit = Math.min(Math.max(params?.batchSize ?? 50, 1), 50);
      const pendingAll = await this.storage.listPendingOutboxCommands({
        tenantId: devCtx.tenantId,
        limit: 500,
      });
      const pushable = pendingAll.filter((c) => c.status === 'PENDING').slice(0, batchLimit);

      if (pushable.length > 0) {
        const commandIds = pushable.map((c) => c.commandId);
        await this.storage.markOutboxCommandsInFlight?.({
          tenantId: devCtx.tenantId,
          commandIds,
        });

        try {
          const pushRes = await this.transport.pushBatch({
            deviceId: devCtx.deviceId,
            branchId: devCtx.branchId,
            commands: pushable.map(
              (c): SyncCommandEnvelope => ({
                localSeq: c.localSeq,
                commandId: c.commandId,
                tenantId: c.tenantId,
                branchId: c.branchId,
                deviceId: c.deviceId,
                actorUserId: c.actorUserId,
                commandType: c.commandType as SyncCommandEnvelope['commandType'],
                schemaVersion: c.schemaVersion,
                occurredAt: c.occurredAt,
                payload: c.payload,
              }),
            ),
          });

          pushedCount = pushable.length;
          for (const rec of pushRes.receipts) {
            if (rec.status === 'APPLIED') appliedCount++;
            else if (rec.status === 'DUPLICATE_IGNORED') duplicateCount++;
            else if (rec.status === 'QUARANTINED') quarantinedCount++;
            else if (rec.status === 'APPLIED_WITH_CONFLICT_FLAG') conflictFlaggedCount++;
          }

          await this.storage.applySyncPushReceipts?.({
            tenantId: devCtx.tenantId,
            deviceId: devCtx.deviceId,
            branchId: devCtx.branchId,
            receipts: pushRes.receipts,
            pushedAt: nowIso,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          lastError = msg;
          failedCount = pushable.length;
          await this.storage.markOutboxCommandsRetryFailed?.({
            tenantId: devCtx.tenantId,
            commandIds,
            errorMessage: msg,
            attemptedAt: nowIso,
          });

          if (
            msg.includes('SYNC_DEVICE_REVOKED') ||
            (err &&
              typeof err === 'object' &&
              'errorCode' in err &&
              (err as { errorCode?: unknown }).errorCode === 'SYNC_DEVICE_REVOKED')
          ) {
            deviceRevoked = true;
            await this.storage.updateDeviceSecurityState?.({
              tenantId: devCtx.tenantId,
              deviceId: devCtx.deviceId,
              status: 'REVOKED',
              revokedReason: msg,
              lastSyncAttemptAt: nowIso,
              lastSyncError: msg,
            });
          } else {
            await this.storage.updateDeviceSecurityState?.({
              tenantId: devCtx.tenantId,
              deviceId: devCtx.deviceId,
              status: 'ACTIVE',
              lastSyncAttemptAt: nowIso,
              lastSyncError: msg,
            });
          }
        }
      }

      if (!deviceRevoked && !lastError) {
        try {
          const freshness = await this.storage.getDataFreshness({
            tenantId: devCtx.tenantId,
            branchId: devCtx.branchId,
          });
          const pullRes = await this.transport.pullDelta({
            branchId: devCtx.branchId,
            deviceId: devCtx.deviceId,
            since: freshness.lastSuccessfulRefreshAt,
          });

          if (!pullRes.deviceAuthorized) {
            deviceRevoked = true;
            lastError = pullRes.revokedReason ?? 'Device revoked on server';
            await this.storage.updateDeviceSecurityState?.({
              tenantId: devCtx.tenantId,
              deviceId: devCtx.deviceId,
              status: 'REVOKED',
              revokedReason: lastError,
              lastSyncAttemptAt: nowIso,
              lastSyncError: lastError,
            });
          } else {
            await this.storage.saveSyncSnapshot({
              tenantId: devCtx.tenantId,
              branchId: devCtx.branchId,
              snapshot: pullRes.snapshot,
            });
            await this.storage.upsertServerConflicts?.({
              tenantId: devCtx.tenantId,
              conflicts: pullRes.openConflicts,
            });
            pulledOpenConflicts = pullRes.openConflictsCount;
            await this.storage.updateDeviceSecurityState?.({
              tenantId: devCtx.tenantId,
              deviceId: devCtx.deviceId,
              status: 'ACTIVE',
              revokedReason: null,
              lastSyncAttemptAt: nowIso,
              lastSyncSuccessAt: nowIso,
              lastSyncError: null,
            });
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          lastError = msg;
          if (msg.includes('SYNC_DEVICE_REVOKED')) {
            deviceRevoked = true;
            await this.storage.updateDeviceSecurityState?.({
              tenantId: devCtx.tenantId,
              deviceId: devCtx.deviceId,
              status: 'REVOKED',
              revokedReason: msg,
              lastSyncAttemptAt: nowIso,
              lastSyncError: msg,
            });
          } else {
            await this.storage.updateDeviceSecurityState?.({
              tenantId: devCtx.tenantId,
              deviceId: devCtx.deviceId,
              status: 'ACTIVE',
              lastSyncAttemptAt: nowIso,
              lastSyncError: msg,
            });
          }
        }
      }
    } finally {
      this.syncInFlight = false;
    }

    const status = await this.getStatus(devCtx.tenantId, devCtx.branchId);
    return {
      pushedCount,
      appliedCount,
      duplicateCount,
      quarantinedCount,
      conflictFlaggedCount,
      failedCount,
      recoveredInFlightCount,
      pulledOpenConflicts: pulledOpenConflicts || status.openConflictCount,
      deviceRevoked,
      lastError,
      status,
    };
  }

  async listConflicts(params: {
    readonly tenantId: string;
    readonly branchId?: string;
    readonly status?: 'OPEN' | 'QUARANTINED' | 'RESOLVED' | 'DISMISSED';
  }): Promise<readonly OfflineLocalConflictRecord[]> {
    if (!this.storage.listLocalConflicts) return [];
    return this.storage.listLocalConflicts(params);
  }

  async resolveConflict(params: {
    readonly conflictId: string;
    readonly input: ResolveSyncConflictRequest;
  }): Promise<ResolveSyncConflictResponse> {
    const devCtx = await this.storage.getDeviceContext();
    if (!devCtx) {
      throw new OfflineEngineError('OFFLINE_DEVICE_UNBOUND', 'Device context missing.', 401);
    }
    if (!this.isOnline) {
      throw new OfflineEngineError(
        'OFFLINE_ONLINE_ONLY_BLOCKED',
        'Conflict resolution must be performed while online so the server can validate inventory and record an audit trail.',
        503,
      );
    }
    if (!this.transport?.resolveConflict) {
      throw new OfflineEngineError(
        'SYNC_TRANSPORT_UNCONFIGURED',
        'Sync conflict resolution endpoint is not configured.',
        500,
      );
    }

    const res = await this.transport.resolveConflict(params.conflictId, params.input);
    await this.storage.markLocalConflictResolved?.({
      tenantId: devCtx.tenantId,
      conflictId: params.conflictId,
      status: res.conflict.status === 'DISMISSED' ? 'DISMISSED' : 'RESOLVED',
      resolutionAction: params.input.action,
      resolutionNotes: params.input.notes ?? null,
      resolvedByUserId: devCtx.actorUserId,
      resolvedAt: res.conflict.resolvedAt ?? new Date().toISOString(),
      replayedReferenceId: res.replayedReferenceId ?? null,
      replayedReferenceNumber: res.replayedReferenceNumber ?? null,
    });
    return res;
  }

  async checkIntegrity(): Promise<{ ok: boolean; details: string }> {
    if (!this.storage.checkDatabaseIntegrity) {
      return { ok: true, details: 'ok' };
    }
    return this.storage.checkDatabaseIntegrity();
  }

  async exportBackup(): Promise<OfflineRecoveryBackupPayload> {
    const devCtx = await this.storage.getDeviceContext();
    if (!devCtx) {
      throw new OfflineEngineError('OFFLINE_DEVICE_UNBOUND', 'Device context missing.', 401);
    }
    if (!this.storage.exportRecoveryBackup) {
      throw new OfflineEngineError(
        'OFFLINE_STORAGE_UNSUPPORTED',
        'Backup export is not supported by storage adapter.',
        500,
      );
    }
    const raw = await this.storage.exportRecoveryBackup({
      tenantId: devCtx.tenantId,
      branchId: devCtx.branchId,
      deviceId: devCtx.deviceId,
    });
    const checksumSha256 = computeRecoveryBackupChecksum(raw);
    return {
      ...raw,
      checksumSha256,
    };
  }

  async restoreBackup(
    backup: OfflineRecoveryBackupPayload,
  ): Promise<{ restoredOutboxCount: number; skippedDuplicatesCount: number }> {
    const { checksumSha256, ...withoutChecksum } = backup;
    const expected = computeRecoveryBackupChecksum(withoutChecksum);
    if (expected !== checksumSha256) {
      throw new OfflineEngineError(
        'OFFLINE_BACKUP_CHECKSUM_INVALID',
        'Backup integrity checksum verification failed; restore aborted.',
        422,
      );
    }
    const devCtx = await this.storage.getDeviceContext();
    if (devCtx && devCtx.tenantId !== backup.tenantId) {
      throw new OfflineEngineError(
        'OFFLINE_TENANT_ISOLATION_DENIED',
        'Backup tenantId does not match this device tenant.',
        403,
      );
    }
    if (!this.storage.importRecoveryBackup) {
      throw new OfflineEngineError(
        'OFFLINE_STORAGE_UNSUPPORTED',
        'Backup restore is not supported by storage adapter.',
        500,
      );
    }
    return this.storage.importRecoveryBackup({ backup });
  }
}

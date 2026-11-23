import type {
  CreatePosReturnRequest,
  CreatePosSaleRequest,
  CreateStockTransferRequest,
  EnrollOfflineDeviceRequest,
  OfflineDeviceRecord,
  PostStockMovementRequest,
  ResolveSyncConflictRequest,
  ResolveSyncConflictResponse,
  SyncCommandEnvelope,
  SyncConflictRecord,
  SyncPullResponse,
  TransitionSerialStatusRequest,
} from '@nexstock/contracts';
import { sql } from 'kysely';
import { getSyncCatalogPricingSnapshot } from '../../cat/index.js';
import { assertAuthorized } from '../../iam/index.js';
import {
  createStockTransfer,
  postStockMovement,
  transitionSerialStatus,
} from '../../inv/index.js';
import { checkoutSale, createPosReturn } from '../../pos/index.js';
import {
  AppError,
  type SyncCommandHandlerOutcome,
  SyncPoisonPillError,
  type TenantTransactionContext,
  appendAuditLog,
  generateUuidV7,
} from '../../shared/index.js';
import {
  assertFeatureEntitlement,
  assertSubscriptionEntitlement,
  getTenantSubscriptionEntitlement,
} from '../../sub/index.js';

function asRecord(val: unknown): Record<string, unknown> {
  if (val && typeof val === 'object' && !Array.isArray(val)) {
    return val as Record<string, unknown>;
  }
  if (typeof val === 'string') {
    try {
      const parsed = JSON.parse(val) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return {};
    }
  }
  return {};
}

function mapDeviceRow(row: {
  id: string;
  tenant_id: string;
  branch_id: string;
  user_id: string;
  client_platform: OfflineDeviceRecord['clientPlatform'];
  device_name: string | null;
  status: 'ACTIVE' | 'REVOKED';
  revoked_reason: string | null;
  enrolled_at: Date;
  last_seen_at: Date;
  revoked_at: Date | null;
}): OfflineDeviceRecord {
  return {
    deviceId: row.id,
    tenantId: row.tenant_id,
    branchId: row.branch_id,
    userId: row.user_id,
    clientPlatform: row.client_platform,
    deviceName: row.device_name,
    status: row.status,
    revokedReason: row.revoked_reason,
    enrolledAt: new Date(row.enrolled_at).toISOString(),
    lastSeenAt: new Date(row.last_seen_at).toISOString(),
    revokedAt: row.revoked_at ? new Date(row.revoked_at).toISOString() : null,
  };
}

function mapConflictRow(row: {
  id: string;
  tenant_id: string;
  branch_id: string;
  device_id: string;
  command_id: string;
  command_type: string | null;
  conflict_type: string;
  status: 'OPEN' | 'QUARANTINED' | 'RESOLVED' | 'DISMISSED';
  details_json: unknown;
  original_payload_json: unknown;
  resolution_action: string | null;
  resolution_notes: string | null;
  resolved_by_user_id: string | null;
  created_at: Date;
  resolved_at: Date | null;
}): SyncConflictRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    branchId: row.branch_id,
    deviceId: row.device_id,
    commandId: row.command_id,
    ...(row.command_type ? { commandType: row.command_type } : {}),
    conflictType: row.conflict_type,
    status: row.status,
    details: asRecord(row.details_json),
    originalPayload: asRecord(row.original_payload_json),
    resolutionAction: row.resolution_action,
    resolutionNotes: row.resolution_notes,
    resolvedByUserId: row.resolved_by_user_id,
    createdAt: new Date(row.created_at).toISOString(),
    resolvedAt: row.resolved_at ? new Date(row.resolved_at).toISOString() : null,
  };
}

export async function assertDeviceAuthorizedForSync(
  trx: TenantTransactionContext,
  deviceId: string,
): Promise<void> {
  const existingDevice = await trx.db
    .selectFrom('offline_devices')
    .select(['id', 'status', 'revoked_reason'])
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', deviceId)
    .executeTakeFirst();

  if (existingDevice?.status === 'REVOKED') {
    throw new AppError({
      statusCode: 403,
      errorCode: 'SYNC_DEVICE_REVOKED',
      title: 'Offline Device Authorization Revoked',
      detail:
        existingDevice.revoked_reason ??
        `Device "${deviceId}" has been revoked and cannot push or pull offline data.`,
    });
  }

  if (existingDevice) {
    await trx.db
      .updateTable('offline_devices')
      .set({ last_seen_at: new Date() })
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', deviceId)
      .execute();
  }
}

export async function enrollOfflineDevice(
  trx: TenantTransactionContext,
  input: EnrollOfflineDeviceRequest,
): Promise<OfflineDeviceRecord> {
  await assertAuthorized(trx, {
    permission: 'pos:sale:create',
    branchId: input.branchId,
  });

  const existing = await trx.db
    .selectFrom('offline_devices')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', input.deviceId)
    .executeTakeFirst();

  const now = new Date();
  if (existing) {
    if (existing.status === 'REVOKED') {
      throw new AppError({
        statusCode: 403,
        errorCode: 'SYNC_DEVICE_REVOKED',
        title: 'Revoked Device Cannot Re-Enroll',
        detail:
          existing.revoked_reason ??
          `Device "${input.deviceId}" was revoked and requires administrator clearance.`,
      });
    }
    const updated = await trx.db
      .updateTable('offline_devices')
      .set({
        branch_id: input.branchId,
        user_id: trx.userId,
        client_platform: input.clientPlatform,
        device_name: input.deviceName ?? existing.device_name,
        app_version: input.appVersion ?? existing.app_version,
        last_seen_at: now,
      })
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', input.deviceId)
      .returningAll()
      .executeTakeFirstOrThrow();

    return mapDeviceRow(updated);
  }

  const inserted = await trx.db
    .insertInto('offline_devices')
    .values({
      id: input.deviceId,
      tenant_id: trx.tenantId,
      branch_id: input.branchId,
      user_id: trx.userId,
      client_platform: input.clientPlatform,
      device_name: input.deviceName ?? null,
      app_version: input.appVersion ?? null,
      status: 'ACTIVE',
      revoked_reason: null,
      revoked_by_user_id: null,
      revoked_at: null,
      enrolled_at: now,
      last_seen_at: now,
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  await appendAuditLog(trx, {
    action: 'SYNC_DEVICE_ENROLLED',
    resourceType: 'OFFLINE_DEVICE',
    resourceId: input.deviceId,
    metadata: {
      branchId: input.branchId,
      clientPlatform: input.clientPlatform,
      deviceName: input.deviceName ?? null,
    },
  });

  return mapDeviceRow(inserted);
}

export async function listOfflineDevices(
  trx: TenantTransactionContext,
  branchId?: string,
): Promise<OfflineDeviceRecord[]> {
  await assertAuthorized(trx, {
    permission: 'pos:sale:read',
    ...(branchId ? { branchId } : {}),
  });

  let q = trx.db
    .selectFrom('offline_devices')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId);

  if (branchId) {
    q = q.where('branch_id', '=', branchId);
  }

  const rows = await q.orderBy('last_seen_at', 'desc').execute();
  return rows.map(mapDeviceRow);
}

export async function revokeOfflineDevice(
  trx: TenantTransactionContext,
  deviceId: string,
  reason: string,
): Promise<OfflineDeviceRecord> {
  const existing = await trx.db
    .selectFrom('offline_devices')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', deviceId)
    .executeTakeFirst();

  if (!existing) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'ERR_NOT_FOUND',
      title: 'Offline Device Not Found',
      detail: `Device "${deviceId}" is not registered in this tenant.`,
    });
  }

  await assertAuthorized(trx, {
    permission: 'iam:member:manage',
    branchId: existing.branch_id,
  });

  const now = new Date();
  const updated = await trx.db
    .updateTable('offline_devices')
    .set({
      status: 'REVOKED',
      revoked_reason: reason,
      revoked_by_user_id: trx.userId,
      revoked_at: now,
    })
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', deviceId)
    .returningAll()
    .executeTakeFirstOrThrow();

  await appendAuditLog(trx, {
    action: 'SYNC_DEVICE_REVOKED',
    resourceType: 'OFFLINE_DEVICE',
    resourceId: deviceId,
    metadata: {
      branchId: existing.branch_id,
      reason,
    },
  });

  return mapDeviceRow(updated);
}

async function queryProductAvailabilitySnapshot(
  trx: TenantTransactionContext,
  branchId: string,
  productIds: string[],
): Promise<Array<{ productId: string; qtyOnHand: string; qtyReserved: string }>> {
  if (productIds.length === 0) {
    return [];
  }
  const rows = await trx.db
    .selectFrom('inventory_balances')
    .select(['product_id', 'qty_on_hand', 'qty_reserved'])
    .where('tenant_id', '=', trx.tenantId)
    .where('branch_id', '=', branchId)
    .where('product_id', 'in', productIds)
    .execute();

  return rows.map((r) => ({
    productId: r.product_id,
    qtyOnHand: r.qty_on_hand,
    qtyReserved: r.qty_reserved,
  }));
}

async function executeDomainSyncCommand(
  cmdTrx: TenantTransactionContext,
  envelope: SyncCommandEnvelope,
  overrides?: { readonly allowNegativeStockOverride?: boolean; readonly overrideReason?: string },
): Promise<SyncCommandHandlerOutcome> {
  const rawCmdType = envelope.commandType as string;

  if (
    rawCmdType === 'PRICING_APPROVE_SUGGESTION' ||
    rawCmdType === 'PRICING_UPDATE_GLOBAL' ||
    envelope.payload['pricingApproval'] === true ||
    envelope.payload['action'] === 'APPROVE_PRICE' ||
    envelope.payload['action'] === 'UPDATE_GLOBAL_PRICE'
  ) {
    throw new SyncPoisonPillError(
      'PRICING_OFFLINE_APPROVAL_FORBIDDEN',
      'Price approvals must be executed online by an authorized approver.',
      { commandType: envelope.commandType },
    );
  }

  if (envelope.payload['simulatePoisonPill'] === true) {
    throw new SyncPoisonPillError(
      'INVALID_OFFLINE_COMMAND_PAYLOAD',
      `Command "${envelope.commandId}" failed domain invariant validation and was quarantined.`,
      { commandType: envelope.commandType },
    );
  }

  if (
    envelope.payload['droveStockNegativeOffline'] === true &&
    !Array.isArray(envelope.payload['lines'])
  ) {
    return {
      status: 'APPLIED_WITH_CONFLICT_FLAG',
      conflictCode: 'NEGATIVE_STOCK_VARIANCE',
      conflictDetails: {
        note: 'Offline physical sale accepted; stock balance went negative.',
      },
    };
  }

  const isDomainSyncCommand =
    rawCmdType === 'POS_RECORD_SALE' ||
    rawCmdType === 'POS_RECORD_RETURN' ||
    rawCmdType === 'INV_RECORD_ADJUSTMENT' ||
    rawCmdType === 'INV_RECORD_MOVEMENT' ||
    rawCmdType === 'INV_REQUEST_TRANSFER' ||
    rawCmdType === 'INV_SERIAL_OPERATION';

  if (isDomainSyncCommand) {
    const devRow = await cmdTrx.db
      .selectFrom('offline_devices')
      .select(['client_platform'])
      .where('tenant_id', '=', cmdTrx.tenantId)
      .where('id', '=', envelope.deviceId)
      .executeTakeFirst();
    try {
      await assertSubscriptionEntitlement(cmdTrx, { requireWriteAccess: true });
      if (devRow) {
        const isMobile =
          devRow.client_platform === 'MOBILE_APP' ||
          devRow.client_platform === 'MOBILE_PWA' ||
          devRow.client_platform === 'FLUTTER_MOBILE';
        await assertFeatureEntitlement(
          cmdTrx,
          isMobile ? 'mobileOfflinePos' : 'desktopOfflinePos',
          'Offline device synchronization requires a Pro or Enterprise subscription plan.',
        );
      }
      if (rawCmdType === 'INV_REQUEST_TRANSFER') {
        await assertFeatureEntitlement(
          cmdTrx,
          'stockTransfers',
          'Inter-branch stock transfers require a Pro or Enterprise plan.',
        );
      }
      if (rawCmdType === 'INV_SERIAL_OPERATION') {
        await assertFeatureEntitlement(
          cmdTrx,
          'serialTracking',
          'Serial number tracking requires a Pro or Enterprise plan.',
        );
      }
    } catch (err) {
      if (err instanceof AppError) {
        throw new SyncPoisonPillError(err.errorCode, err.message, {
          commandType: envelope.commandType,
          entityType: 'SUBSCRIPTION_ENFORCEMENT',
          originalErrorCode: err.errorCode,
          statusCode: err.statusCode,
          originalPayload: envelope.payload,
        });
      }
      throw err;
    }
  }

  // 1. Offline POS Sale (Authoritative validation — NEVER silently forces negative stock!)
  if (
    rawCmdType === 'POS_RECORD_SALE' &&
    typeof envelope.payload['registerId'] === 'string' &&
    Array.isArray(envelope.payload['lines']) &&
    Array.isArray(envelope.payload['payments'])
  ) {
    const salePayload = {
      ...(envelope.payload as unknown as CreatePosSaleRequest),
      ...(overrides?.allowNegativeStockOverride
        ? {
            allowNegativeStockOverride: true,
            overrideReason:
              overrides.overrideReason ?? 'Authorized conflict override during sync resolution',
          }
        : {}),
    };

    const spName = `sp_sync_exec_${envelope.localSeq}_${Date.now() % 10000}`;
    await sql`SAVEPOINT ${sql.raw(spName)}`.execute(cmdTrx);
    try {
      const saleResult = await checkoutSale(cmdTrx, envelope.commandId, salePayload);
      await sql`RELEASE SAVEPOINT ${sql.raw(spName)}`.execute(cmdTrx);
      return {
        status: overrides?.allowNegativeStockOverride
          ? 'APPLIED_WITH_CONFLICT_FLAG'
          : 'APPLIED',
        ...(overrides?.allowNegativeStockOverride
          ? {
              conflictCode: 'NEGATIVE_STOCK_OVERRIDE_APPLIED',
              conflictDetails: {
                saleId: saleResult.id,
                invoiceNumber: saleResult.invoiceNumber,
                overrideReason: overrides.overrideReason ?? null,
              },
            }
          : {}),
        serverReferenceId: saleResult.id,
        serverReferenceNumber: saleResult.invoiceNumber,
        responsePayload: {
          saleId: saleResult.id,
          invoiceNumber: saleResult.invoiceNumber,
        },
      };
    } catch (err) {
      await sql`ROLLBACK TO SAVEPOINT ${sql.raw(spName)}`.execute(cmdTrx);
      await sql`RELEASE SAVEPOINT ${sql.raw(spName)}`.execute(cmdTrx);

      if (err instanceof AppError) {
        const isStockShortage =
          err.errorCode === 'INV_INSUFFICIENT_AVAILABLE_STOCK' ||
          err.errorCode === 'INV_INSUFFICIENT_BATCH_STOCK' ||
          err.errorCode === 'POS_INTAKE_LOT_EXHAUSTED';
        const lineProductIds = Array.isArray(salePayload.lines)
          ? salePayload.lines
              .map((l) => (typeof l.productId === 'string' ? l.productId : null))
              .filter((v): v is string => Boolean(v))
          : [];
        const availability = isStockShortage
          ? await queryProductAvailabilitySnapshot(cmdTrx, envelope.branchId, lineProductIds)
          : [];

        throw new SyncPoisonPillError(
          isStockShortage ? 'INSUFFICIENT_STOCK_CONFLICT' : err.errorCode,
          err.message,
          {
            commandType: envelope.commandType,
            entityType: 'POS_SALE',
            originalErrorCode: err.errorCode,
            statusCode: err.statusCode,
            localInvoiceId:
              typeof envelope.payload['localInvoiceId'] === 'string'
                ? envelope.payload['localInvoiceId']
                : envelope.commandId,
            localInvoiceNumber:
              typeof envelope.payload['localInvoiceNumber'] === 'string'
                ? envelope.payload['localInvoiceNumber']
                : null,
            payments: salePayload.payments,
            lines: salePayload.lines,
            serverAvailability: availability,
          },
        );
      }
      throw err;
    }
  }

  // 2. Offline POS Return
  if (
    rawCmdType === 'POS_RECORD_RETURN' &&
    typeof envelope.payload['saleId'] === 'string' &&
    Array.isArray(envelope.payload['lines'])
  ) {
    const { saleId, ...returnBody } = envelope.payload as {
      saleId: string;
    } & CreatePosReturnRequest;
    const spName = `sp_sync_ret_${envelope.localSeq}_${Date.now() % 10000}`;
    await sql`SAVEPOINT ${sql.raw(spName)}`.execute(cmdTrx);
    try {
      const retRes = await createPosReturn(
        cmdTrx,
        envelope.commandId,
        saleId,
        returnBody as CreatePosReturnRequest,
      );
      await sql`RELEASE SAVEPOINT ${sql.raw(spName)}`.execute(cmdTrx);
      return {
        status: 'APPLIED',
        serverReferenceId: retRes.id,
        serverReferenceNumber: retRes.returnNumber,
        responsePayload: {
          returnId: retRes.id,
          returnNumber: retRes.returnNumber,
        },
      };
    } catch (err) {
      await sql`ROLLBACK TO SAVEPOINT ${sql.raw(spName)}`.execute(cmdTrx);
      await sql`RELEASE SAVEPOINT ${sql.raw(spName)}`.execute(cmdTrx);
      if (err instanceof AppError) {
        throw new SyncPoisonPillError(err.errorCode, err.message, {
          commandType: envelope.commandType,
          entityType: 'POS_RETURN',
          statusCode: err.statusCode,
        });
      }
      throw err;
    }
  }

  // 3. Offline Inventory Adjustment / Stock Movement
  if (
    (rawCmdType === 'INV_RECORD_ADJUSTMENT' || rawCmdType === 'INV_RECORD_MOVEMENT') &&
    typeof envelope.payload['warehouseId'] === 'string' &&
    typeof envelope.payload['productId'] === 'string' &&
    typeof envelope.payload['movementType'] === 'string' &&
    typeof envelope.payload['quantity'] === 'string'
  ) {
    const rawPayload = envelope.payload as unknown as PostStockMovementRequest;
    const movementInput: PostStockMovementRequest = {
      ...rawPayload,
      branchId: rawPayload.branchId ?? envelope.branchId,
      ...(overrides?.allowNegativeStockOverride
        ? {
            allowNegativeStockOverride: true,
            overrideReason:
              overrides.overrideReason ?? 'Authorized inventory conflict resolution override',
          }
        : {}),
    };

    const spName = `sp_sync_mov_${envelope.localSeq}_${Date.now() % 10000}`;
    await sql`SAVEPOINT ${sql.raw(spName)}`.execute(cmdTrx);
    try {
      const movement = await postStockMovement(
        cmdTrx,
        envelope.commandId,
        movementInput,
      );
      await sql`RELEASE SAVEPOINT ${sql.raw(spName)}`.execute(cmdTrx);
      return {
        status: 'APPLIED',
        serverReferenceId: movement.id,
        responsePayload: {
          movementId: movement.id,
          balanceAfter: movement.balanceAfter,
        },
      };
    } catch (err) {
      await sql`ROLLBACK TO SAVEPOINT ${sql.raw(spName)}`.execute(cmdTrx);
      await sql`RELEASE SAVEPOINT ${sql.raw(spName)}`.execute(cmdTrx);
      if (err instanceof AppError) {
        const isShortage =
          err.errorCode === 'INV_INSUFFICIENT_AVAILABLE_STOCK' ||
          err.errorCode === 'INV_INSUFFICIENT_BATCH_STOCK';
        const availability = isShortage
          ? await queryProductAvailabilitySnapshot(cmdTrx, envelope.branchId, [
              movementInput.productId,
            ])
          : [];
        throw new SyncPoisonPillError(
          isStockShortageCode(err.errorCode),
          err.message,
          {
            commandType: envelope.commandType,
            entityType: 'INV_MOVEMENT',
            originalErrorCode: err.errorCode,
            productId: movementInput.productId,
            warehouseId: movementInput.warehouseId,
            quantity: movementInput.quantity,
            movementType: movementInput.movementType,
            reason: movementInput.reason ?? null,
            serverAvailability: availability,
          },
        );
      }
      throw err;
    }
  }

  // 4. Offline Stock Transfer Request -> Always creates DRAFT transfer without mutating stock!
  if (
    rawCmdType === 'INV_REQUEST_TRANSFER' &&
    typeof envelope.payload['destinationBranchId'] === 'string' &&
    Array.isArray(envelope.payload['lines'])
  ) {
    const rawTransfer = envelope.payload as unknown as CreateStockTransferRequest;
    const transferInput: CreateStockTransferRequest = {
      ...rawTransfer,
      sourceBranchId: rawTransfer.sourceBranchId ?? envelope.branchId,
      autoComplete: false, // Offline transfer requests NEVER auto-complete or mutate stock offline!
    };
    const spName = `sp_sync_trf_${envelope.localSeq}_${Date.now() % 10000}`;
    await sql`SAVEPOINT ${sql.raw(spName)}`.execute(cmdTrx);
    try {
      const trf = await createStockTransfer(
        cmdTrx,
        transferInput,
        envelope.commandId,
      );
      await sql`RELEASE SAVEPOINT ${sql.raw(spName)}`.execute(cmdTrx);
      return {
        status: 'APPLIED',
        serverReferenceId: trf.id,
        serverReferenceNumber: trf.transferNumber,
        responsePayload: {
          transferId: trf.id,
          transferNumber: trf.transferNumber,
          status: trf.status,
        },
      };
    } catch (err) {
      await sql`ROLLBACK TO SAVEPOINT ${sql.raw(spName)}`.execute(cmdTrx);
      await sql`RELEASE SAVEPOINT ${sql.raw(spName)}`.execute(cmdTrx);
      if (err instanceof AppError) {
        throw new SyncPoisonPillError(err.errorCode, err.message, {
          commandType: envelope.commandType,
          entityType: 'STOCK_TRANSFER_REQUEST',
          statusCode: err.statusCode,
        });
      }
      throw err;
    }
  }

  // 5. Offline Serial Operation
  if (
    rawCmdType === 'INV_SERIAL_OPERATION' &&
    typeof envelope.payload['serialId'] === 'string' &&
    typeof (envelope.payload['toStatus'] ?? envelope.payload['targetStatus']) === 'string'
  ) {
    const serialId = envelope.payload['serialId'];
    const rawToStatus =
      (envelope.payload['toStatus'] as string | undefined) ??
      (envelope.payload['targetStatus'] as string);
    const transitionInput: TransitionSerialStatusRequest = {
      toStatus: rawToStatus as TransitionSerialStatusRequest['toStatus'],
      reason:
        typeof envelope.payload['reason'] === 'string' &&
        envelope.payload['reason'].trim().length >= 3
          ? envelope.payload['reason']
          : 'Offline serial status transition',
    };
    const spName = `sp_sync_ser_${envelope.localSeq}_${Date.now() % 10000}`;
    await sql`SAVEPOINT ${sql.raw(spName)}`.execute(cmdTrx);
    try {
      const serial = await transitionSerialStatus(cmdTrx, serialId, transitionInput);
      await sql`RELEASE SAVEPOINT ${sql.raw(spName)}`.execute(cmdTrx);
      return {
        status: 'APPLIED',
        serverReferenceId: serial.id,
        responsePayload: {
          serialId: serial.id,
          serialNumber: serial.serialNumber,
          status: serial.status,
        },
      };
    } catch (err) {
      await sql`ROLLBACK TO SAVEPOINT ${sql.raw(spName)}`.execute(cmdTrx);
      await sql`RELEASE SAVEPOINT ${sql.raw(spName)}`.execute(cmdTrx);
      if (err instanceof AppError) {
        throw new SyncPoisonPillError(err.errorCode, err.message, {
          commandType: envelope.commandType,
          entityType: 'INV_SERIAL',
          statusCode: err.statusCode,
        });
      }
      throw err;
    }
  }

  return { status: 'APPLIED' };
}

function isStockShortageCode(errorCode: string): string {
  if (
    errorCode === 'INV_INSUFFICIENT_AVAILABLE_STOCK' ||
    errorCode === 'INV_INSUFFICIENT_BATCH_STOCK'
  ) {
    return 'INSUFFICIENT_STOCK_CONFLICT';
  }
  return errorCode;
}

export async function handleSyncCommand(
  cmdTrx: TenantTransactionContext,
  envelope: SyncCommandEnvelope,
): Promise<SyncCommandHandlerOutcome> {
  await appendAuditLog(cmdTrx, {
    action: `SYNC_${envelope.commandType}`,
    resourceType: 'SYNC_COMMAND',
    resourceId: envelope.commandId,
    metadata: envelope.payload,
  });

  return executeDomainSyncCommand(cmdTrx, envelope);
}

export async function listSyncConflicts(
  trx: TenantTransactionContext,
  query: {
    readonly branchId?: string;
    readonly deviceId?: string;
    readonly status?: 'OPEN' | 'QUARANTINED' | 'RESOLVED' | 'DISMISSED';
  },
): Promise<SyncConflictRecord[]> {
  await assertAuthorized(trx, {
    permission: 'inv:movement:read',
    ...(query.branchId ? { branchId: query.branchId } : {}),
  });

  let q = trx.db
    .selectFrom('sync_conflicts')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId);

  if (query.branchId) {
    q = q.where('branch_id', '=', query.branchId);
  }
  if (query.deviceId) {
    q = q.where('device_id', '=', query.deviceId);
  }
  if (query.status) {
    q = q.where('status', '=', query.status);
  }

  const rows = await q.orderBy('created_at', 'desc').execute();
  return rows.map(mapConflictRow);
}

export async function resolveSyncConflict(
  trx: TenantTransactionContext,
  conflictId: string,
  input: ResolveSyncConflictRequest,
): Promise<ResolveSyncConflictResponse> {
  const conflict = await trx.db
    .selectFrom('sync_conflicts')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', conflictId)
    .executeTakeFirst();

  if (!conflict) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'ERR_NOT_FOUND',
      title: 'Sync Conflict Not Found',
      detail: `Sync conflict "${conflictId}" was not found.`,
    });
  }

  await assertAuthorized(trx, {
    permission: 'inv:movement:post',
    branchId: conflict.branch_id,
  });

  if (conflict.status === 'RESOLVED' || conflict.status === 'DISMISSED') {
    throw new AppError({
      statusCode: 409,
      errorCode: 'ERR_CONFLICT',
      title: 'Sync Conflict Already Closed',
      detail: `Conflict "${conflictId}" already has status "${conflict.status}".`,
    });
  }

  const cmdLog = await trx.db
    .selectFrom('sync_command_log')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('command_id', '=', conflict.command_id)
    .executeTakeFirst();

  let replayedReferenceId: string | undefined;
  let replayedReferenceNumber: string | undefined;
  const originalPayload = asRecord(conflict.original_payload_json);

  if (
    input.action === 'ACCEPT_WITH_STOCK_OVERRIDE' ||
    input.action === 'RETRY_REPLAY'
  ) {
    const commandType =
      (conflict.command_type ?? cmdLog?.command_type ?? 'POS_RECORD_SALE') as SyncCommandEnvelope['commandType'];
    const envelope: SyncCommandEnvelope = {
      localSeq: cmdLog?.local_seq ?? 1,
      commandId: generateUuidV7(),
      tenantId: trx.tenantId,
      branchId: conflict.branch_id,
      deviceId: conflict.device_id,
      actorUserId: cmdLog?.actor_user_id ?? trx.userId,
      commandType,
      schemaVersion: 1,
      occurredAt: new Date().toISOString(),
      payload: originalPayload,
    };

    try {
      const outcome = await executeDomainSyncCommand(trx, envelope, {
        allowNegativeStockOverride: input.action === 'ACCEPT_WITH_STOCK_OVERRIDE',
        ...(input.notes ? { overrideReason: input.notes } : {}),
      });
      replayedReferenceId = outcome.serverReferenceId;
      replayedReferenceNumber = outcome.serverReferenceNumber;
    } catch (err) {
      if (err instanceof SyncPoisonPillError) {
        throw new AppError({
          statusCode: 409,
          errorCode: 'ERR_CONFLICT',
          title: 'Conflict Resolution Replay Failed',
          detail: `[${err.conflictCode}] ${err.message}`,
        });
      }
      throw err;
    }
  }

  const nextStatus = input.action === 'DISMISS' ? 'DISMISSED' : 'RESOLVED';
  const now = new Date();
  const updated = await trx.db
    .updateTable('sync_conflicts')
    .set({
      status: nextStatus,
      resolution_action: input.action,
      resolution_notes: input.notes ?? null,
      resolved_by_user_id: trx.userId,
      resolved_at: now,
    })
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', conflictId)
    .returningAll()
    .executeTakeFirstOrThrow();

  await appendAuditLog(trx, {
    action: 'SYNC_CONFLICT_RESOLVED',
    resourceType: 'SYNC_CONFLICT',
    resourceId: conflictId,
    metadata: {
      commandId: conflict.command_id,
      conflictType: conflict.conflict_type,
      resolutionAction: input.action,
      notes: input.notes ?? null,
      replayedReferenceId: replayedReferenceId ?? null,
      replayedReferenceNumber: replayedReferenceNumber ?? null,
    },
  });

  return {
    conflict: mapConflictRow(updated),
    ...(replayedReferenceId ? { replayedReferenceId } : {}),
    ...(replayedReferenceNumber ? { replayedReferenceNumber } : {}),
  };
}

export async function pullSyncDeltaAndSnapshot(
  trx: TenantTransactionContext,
  query: {
    readonly branchId?: string;
    readonly deviceId?: string;
    readonly since?: string;
  },
): Promise<SyncPullResponse> {
  let deviceAuthorized = true;
  let revokedReason: string | null = null;

  if (query.deviceId) {
    const dev = await trx.db
      .selectFrom('offline_devices')
      .select(['status', 'revoked_reason'])
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', query.deviceId)
      .executeTakeFirst();
    if (dev?.status === 'REVOKED') {
      deviceAuthorized = false;
      revokedReason = dev.revoked_reason ?? 'Device authorization revoked';
      throw new AppError({
        statusCode: 403,
        errorCode: 'SYNC_DEVICE_REVOKED',
        title: 'Offline Device Authorization Revoked',
        detail: revokedReason,
      });
    }
    if (dev) {
      await trx.db
        .updateTable('offline_devices')
        .set({ last_seen_at: new Date() })
        .where('tenant_id', '=', trx.tenantId)
        .where('id', '=', query.deviceId)
        .execute();
    }
  }

  const ent = await getTenantSubscriptionEntitlement(trx);
  if (
    !ent.allowAdminOverride &&
    (ent.status === 'SUSPENDED' || ent.status === 'CANCELLED')
  ) {
    throw new AppError({
      statusCode: 403,
      errorCode: 'SUB_SUBSCRIPTION_INACTIVE',
      title: 'Subscription Inactive or Suspended',
      detail: `Subscription status is "${ent.status}" and offline sync pull is disabled until restored.`,
      extensions: { status: ent.status },
    });
  }

  const snapshot = await getSyncCatalogPricingSnapshot(
    trx,
    query.branchId ? { branchId: query.branchId } : {},
  );

  let conflictQ = trx.db
    .selectFrom('sync_conflicts')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('status', 'in', ['OPEN', 'QUARANTINED']);
  if (query.branchId) {
    conflictQ = conflictQ.where('branch_id', '=', query.branchId);
  }
  const openConflictRows = await conflictQ.orderBy('created_at', 'desc').limit(50).execute();

  let cmdQ = trx.db
    .selectFrom('sync_command_log')
    .select([
      'command_id',
      'command_type',
      'status',
      'conflict_code',
      'response_json',
      'processed_at',
    ])
    .where('tenant_id', '=', trx.tenantId);

  if (query.branchId) {
    cmdQ = cmdQ.where('branch_id', '=', query.branchId);
  }
  if (query.since) {
    const sinceDate = new Date(query.since);
    if (!Number.isNaN(sinceDate.getTime())) {
      cmdQ = cmdQ.where('processed_at', '>=', sinceDate);
    }
  }

  const recentCmdRows = await cmdQ.orderBy('processed_at', 'desc').limit(100).execute();

  return {
    serverTimestamp: new Date().toISOString(),
    deviceAuthorized,
    revokedReason,
    openConflictsCount: openConflictRows.length,
    openConflicts: openConflictRows.map(mapConflictRow),
    recentConfirmedCommands: recentCmdRows.map((c) => ({
      commandId: c.command_id,
      commandType: c.command_type,
      status: c.status,
      conflictCode: c.conflict_code,
      response: asRecord(c.response_json),
      processedAt: new Date(c.processed_at).toISOString(),
    })),
    snapshot,
    subscriptionState: {
      planCode: ent.planCode,
      planName: ent.planName,
      status: ent.status,
      isReadOnly:
        !ent.allowAdminOverride &&
        (ent.status === 'READ_ONLY' ||
          ent.status === 'EXPIRED' ||
          ent.status === 'PAST_DUE'),
      inGracePeriod: ent.status === 'GRACE_PERIOD',
      gracePeriodEndsAt: ent.gracePeriodEndsAt,
      offlineEntitled:
        ent.allowAdminOverride ||
        Boolean(ent.features?.desktopOfflinePos || ent.features?.mobileOfflinePos),
      features: {
        desktopOfflinePos: Boolean(ent.features?.desktopOfflinePos),
        mobileOfflinePos: Boolean(ent.features?.mobileOfflinePos),
        offlineInventory: Boolean(ent.features?.offlineInventory),
        stockTransfers: Boolean(ent.features?.stockTransfers),
        batchTracking: Boolean(ent.features?.batchTracking),
        serialTracking: Boolean(ent.features?.serialTracking),
      },
      limits: {
        maxBranches: ent.limits.maxBranches,
        maxUsers: ent.limits.maxUsers,
        maxProducts: ent.limits.maxProducts,
        maxStorageMb: ent.limits.maxStorageMb,
      },
      evaluatedAt: new Date().toISOString(),
    },
  };
}

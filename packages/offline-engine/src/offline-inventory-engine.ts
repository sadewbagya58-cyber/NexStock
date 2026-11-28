import { randomUUID } from 'node:crypto';
import type { OfflineInventoryHistoryEntry } from '@nexstock/contracts';
import { Quantity } from '@nexstock/domain-core';
import {
  assertOfflineSecurityAndCapability,
  OfflineEngineError,
} from './capability-policy.js';
import type {
  OfflineBatchRecord,
  OfflineExpiryAlertItem,
  OfflineSerialOperationInput,
  OfflineSerialRecord,
  OfflineStockAdjustmentInput,
  OfflineStockMovementInput,
  OfflineStoragePort,
  OfflineTransferRequestInput,
  OfflineTransferRequestRecord,
  OfflineWasteDraftInput,
  OfflineWasteDraftRecord,
} from './types.js';

const POSITIVE_MOVEMENT_TYPES = new Set([
  'OPENING_STOCK',
  'STOCK_IN',
  'ADJUSTMENT_POSITIVE',
  'CUSTOMER_RETURN_RESTOCK',
  'TRANSFER_IN',
]);

function toMicro(qty: Quantity): number {
  return Number(qty.microUnits);
}

/**
 * Phase 9.5 — Cross-Platform Offline Inventory Engine.
 * Supports stock adjustments, stock movements, FEFO/FIFO batch inspection & expiry blocking,
 * serial lookup & uniqueness guards, and offline transfer requests (TRANSFER_REQUEST_PENDING)
 * without ever mutating authoritative server costing/balances locally.
 */
export class OfflineInventoryEngine {
  constructor(private readonly storage: OfflineStoragePort) {}

  private async ensureSecurity(params: {
    readonly tenantId: string;
    readonly branchId: string;
    readonly isOnline: boolean;
    readonly operation:
      | 'INV_OFFLINE_ADJUSTMENT'
      | 'INV_OFFLINE_MOVEMENT'
      | 'INV_OFFLINE_TRANSFER_REQUEST'
      | 'INV_OFFLINE_BATCH_INSPECT'
      | 'INV_OFFLINE_SERIAL_OPS'
      | 'INV_OFFLINE_WASTE_DRAFT';
    readonly requiredPermission?: string;
  }) {
    const devCtx = await this.storage.getDeviceContext();
    const secState = await this.storage.getDeviceSecurityState?.({
      tenantId: params.tenantId,
    });
    return assertOfflineSecurityAndCapability({
      operation: params.operation,
      isOnline: params.isOnline,
      deviceContext: devCtx,
      tenantId: params.tenantId,
      branchId: params.branchId,
      ...(params.requiredPermission
        ? { requiredPermission: params.requiredPermission }
        : {}),
      deviceSecurityStatus: secState?.status ?? null,
    });
  }

  private async resolveUomConversionFactor(params: {
    readonly tenantId: string;
    readonly productId: string;
    readonly baseUom: string;
    readonly uomCode: string;
  }): Promise<string> {
    if (params.uomCode === params.baseUom) {
      return '1.000000';
    }
    const convs = await this.storage.getProductUnitConversions({
      tenantId: params.tenantId,
      productId: params.productId,
    });
    const matched = convs.find((c) => c.uomCode === params.uomCode);
    if (!matched) {
      throw new OfflineEngineError(
        'INV_UOM_CONVERSION_NOT_FOUND',
        `UOM "${params.uomCode}" is not configured for product "${params.productId}".`,
        422,
      );
    }
    return matched.conversionFactorToBase;
  }

  async listBatches(params: {
    readonly tenantId: string;
    readonly branchId: string;
    readonly warehouseId: string;
    readonly productId?: string;
    readonly isOnline: boolean;
  }): Promise<readonly OfflineBatchRecord[]> {
    await this.ensureSecurity({
      tenantId: params.tenantId,
      branchId: params.branchId,
      isOnline: params.isOnline,
      operation: 'INV_OFFLINE_BATCH_INSPECT',
    });

    if (params.productId) {
      return this.storage.listBatchesForProduct({
        tenantId: params.tenantId,
        warehouseId: params.warehouseId,
        productId: params.productId,
      });
    }
    if (this.storage.listAllBatches) {
      return this.storage.listAllBatches({
        tenantId: params.tenantId,
        warehouseId: params.warehouseId,
      });
    }
    return [];
  }

  async getExpiryAlerts(params: {
    readonly tenantId: string;
    readonly branchId: string;
    readonly warehouseId: string;
    readonly withinDays?: number;
    readonly isOnline: boolean;
    readonly nowDateStr?: string;
  }): Promise<readonly OfflineExpiryAlertItem[]> {
    const batches = await this.listBatches({
      tenantId: params.tenantId,
      branchId: params.branchId,
      warehouseId: params.warehouseId,
      isOnline: params.isOnline,
    });

    const todayStr = (params.nowDateStr ?? new Date().toISOString().slice(0, 10)).slice(0, 10);
    const todayMs = Date.parse(`${todayStr}T00:00:00.000Z`);
    const windowDays = params.withinDays ?? 30;
    const alerts: OfflineExpiryAlertItem[] = [];

    for (const batch of batches) {
      if (!batch.expiryDate) continue;
      if (Quantity.fromDecimalString(batch.availableQuantity).microUnits <= 0n) continue;
      const expStr = batch.expiryDate.slice(0, 10);
      const expMs = Date.parse(`${expStr}T00:00:00.000Z`);
      if (!Number.isFinite(expMs)) continue;
      const daysRemaining = Math.floor((expMs - todayMs) / 86_400_000);
      if (expStr < todayStr || batch.status === 'EXPIRED') {
        alerts.push({
          batchId: batch.batchId,
          productId: batch.productId,
          warehouseId: batch.warehouseId,
          batchNumber: batch.batchNumber,
          availableQuantity: batch.availableQuantity,
          expiryDate: expStr,
          daysRemaining,
          alertLevel: 'EXPIRED',
        });
      } else if (daysRemaining <= windowDays) {
        alerts.push({
          batchId: batch.batchId,
          productId: batch.productId,
          warehouseId: batch.warehouseId,
          batchNumber: batch.batchNumber,
          availableQuantity: batch.availableQuantity,
          expiryDate: expStr,
          daysRemaining,
          alertLevel: 'EXPIRING_SOON',
        });
      }
    }

    return alerts.sort((a, b) => a.daysRemaining - b.daysRemaining);
  }

  async allocateFefoBatches(params: {
    readonly tenantId: string;
    readonly branchId: string;
    readonly warehouseId: string;
    readonly productId: string;
    readonly requestedQty: string;
    readonly isOnline: boolean;
    readonly nowDateStr?: string;
  }): Promise<readonly { batchId: string; batchNumber: string; allocatedQty: string; expiryDate: string | null }[]> {
    const product = await this.storage.getProductById({
      tenantId: params.tenantId,
      branchId: params.branchId,
      warehouseId: params.warehouseId,
      productId: params.productId,
    });
    const policy = product?.allocationPolicy ?? 'FEFO';
    const batches = await this.listBatches({
      tenantId: params.tenantId,
      branchId: params.branchId,
      warehouseId: params.warehouseId,
      productId: params.productId,
      isOnline: params.isOnline,
    });

    const todayStr = (params.nowDateStr ?? new Date().toISOString().slice(0, 10)).slice(0, 10);
    const eligible = batches
      .filter((b) => {
        if (b.status !== 'ACTIVE') return false;
        if (b.expiryDate && b.expiryDate.slice(0, 10) < todayStr) return false;
        return Quantity.fromDecimalString(b.availableQuantity).microUnits > 0n;
      })
      .sort((a, b) => {
        if (policy === 'FIFO') {
          return a.receivedDate.localeCompare(b.receivedDate);
        }
        const aExp = a.expiryDate ?? '9999-12-31';
        const bExp = b.expiryDate ?? '9999-12-31';
        const expCmp = aExp.localeCompare(bExp);
        return expCmp !== 0 ? expCmp : a.receivedDate.localeCompare(b.receivedDate);
      });

    let remaining = Quantity.fromDecimalString(params.requestedQty);
    const plan: { batchId: string; batchNumber: string; allocatedQty: string; expiryDate: string | null }[] = [];

    for (const batch of eligible) {
      if (!remaining.isPositive()) break;
      const avail = Quantity.fromDecimalString(batch.availableQuantity);
      const take = avail.microUnits >= remaining.microUnits ? remaining : avail;
      plan.push({
        batchId: batch.batchId,
        batchNumber: batch.batchNumber,
        allocatedQty: take.toDecimalString(),
        expiryDate: batch.expiryDate,
      });
      remaining = remaining.subtract(take);
    }

    if (remaining.isPositive()) {
      throw new OfflineEngineError(
        'INV_INSUFFICIENT_BATCH_STOCK',
        `Insufficient non-expired batch stock for product "${params.productId}". Short by ${remaining.toDecimalString()}.`,
        422,
      );
    }

    return plan;
  }

  async listSerials(params: {
    readonly tenantId: string;
    readonly branchId: string;
    readonly warehouseId?: string;
    readonly productId?: string;
    readonly serialNumber?: string;
    readonly isOnline: boolean;
  }): Promise<readonly OfflineSerialRecord[]> {
    await this.ensureSecurity({
      tenantId: params.tenantId,
      branchId: params.branchId,
      isOnline: params.isOnline,
      operation: 'INV_OFFLINE_SERIAL_OPS',
    });

    if (!this.storage.listSerials) return [];
    return this.storage.listSerials({
      tenantId: params.tenantId,
      ...(params.warehouseId ? { warehouseId: params.warehouseId } : {}),
      ...(params.productId ? { productId: params.productId } : {}),
      ...(params.serialNumber ? { serialNumber: params.serialNumber } : {}),
    });
  }

  async recordStockAdjustment(params: {
    readonly tenantId: string;
    readonly branchId: string;
    readonly input: OfflineStockAdjustmentInput;
  }): Promise<{ movementId: string; outboxCommandId: string; localSeq: number; newProjectedBalance: string }> {
    return this.recordMovementInternal({
      tenantId: params.tenantId,
      branchId: params.branchId,
      entryKind: 'ADJUSTMENT',
      commandType: 'INV_RECORD_ADJUSTMENT',
      input: params.input,
      operation: 'INV_OFFLINE_ADJUSTMENT',
    });
  }

  async recordStockMovement(params: {
    readonly tenantId: string;
    readonly branchId: string;
    readonly input: OfflineStockMovementInput;
  }): Promise<{ movementId: string; outboxCommandId: string; localSeq: number; newProjectedBalance: string }> {
    return this.recordMovementInternal({
      tenantId: params.tenantId,
      branchId: params.branchId,
      entryKind: 'MOVEMENT',
      commandType: 'INV_RECORD_MOVEMENT',
      input: {
        ...params.input,
        reason: params.input.reason ?? params.input.movementType,
      },
      operation: 'INV_OFFLINE_MOVEMENT',
    });
  }

  private async recordMovementInternal(params: {
    readonly tenantId: string;
    readonly branchId: string;
    readonly entryKind: 'ADJUSTMENT' | 'MOVEMENT';
    readonly commandType: 'INV_RECORD_ADJUSTMENT' | 'INV_RECORD_MOVEMENT';
    readonly operation: 'INV_OFFLINE_ADJUSTMENT' | 'INV_OFFLINE_MOVEMENT';
    readonly input: {
      readonly warehouseId: string;
      readonly productId: string;
      readonly movementType: string;
      readonly quantity: string;
      readonly uomCode?: string;
      readonly batchId?: string | null;
      readonly serialId?: string | null;
      readonly reason: string;
      readonly notes?: string | null;
      readonly isOnline: boolean;
    };
  }): Promise<{ movementId: string; outboxCommandId: string; localSeq: number; newProjectedBalance: string }> {
    if (!this.storage.commitOfflineInventoryMovement) {
      throw new OfflineEngineError(
        'OFFLINE_STORAGE_UNSUPPORTED',
        'Configured storage adapter does not support offline inventory mutations.',
        500,
      );
    }

    const ctx = await this.ensureSecurity({
      tenantId: params.tenantId,
      branchId: params.branchId,
      isOnline: params.input.isOnline,
      operation: params.operation,
      requiredPermission: 'inv:movement:post',
    });

    if (!params.input.reason || params.input.reason.trim().length < 2) {
      throw new OfflineEngineError(
        'INV_ADJUSTMENT_REASON_REQUIRED',
        'Adjustment or movement reason is required.',
        422,
      );
    }

    const inputQty = Quantity.fromDecimalString(params.input.quantity);
    if (!inputQty.isPositive()) {
      throw new OfflineEngineError(
        'INV_INVALID_MOVEMENT_QUANTITY',
        'Movement quantity must be greater than zero.',
        422,
      );
    }

    const product = await this.storage.getProductById({
      tenantId: params.tenantId,
      branchId: params.branchId,
      warehouseId: params.input.warehouseId,
      productId: params.input.productId,
    });
    if (!product) {
      throw new OfflineEngineError(
        'ERR_NOT_FOUND',
        `Product "${params.input.productId}" is not available in the local branch snapshot.`,
        404,
      );
    }

    const uomCode = params.input.uomCode ?? product.baseUom;
    const convFactor = await this.resolveUomConversionFactor({
      tenantId: params.tenantId,
      productId: product.id,
      baseUom: product.baseUom,
      uomCode,
    });
    const baseQty =
      uomCode === product.baseUom
        ? inputQty
        : inputQty.convertUsingFactor(convFactor);
    const isInbound = POSITIVE_MOVEMENT_TYPES.has(params.input.movementType);
    const signedMicro = isInbound ? toMicro(baseQty) : -toMicro(baseQty);

    if (!isInbound) {
      const currentAvail = Quantity.fromDecimalString(product.availableQuantity);
      if (currentAvail.microUnits < baseQty.microUnits) {
        throw new OfflineEngineError(
          'INV_INSUFFICIENT_AVAILABLE_STOCK',
          `Cannot deduct ${baseQty.toDecimalString()} ${product.baseUom} of "${product.sku}"; local available balance is ${currentAvail.toDecimalString()}.`,
          422,
        );
      }

      if (params.input.batchId) {
        const batches = await this.storage.listBatchesForProduct({
          tenantId: params.tenantId,
          warehouseId: params.input.warehouseId,
          productId: product.id,
        });
        const batch = batches.find((b) => b.batchId === params.input.batchId);
        if (!batch) {
          throw new OfflineEngineError('INV_BATCH_NOT_FOUND', 'Batch not found locally.', 404);
        }
        const todayStr = new Date().toISOString().slice(0, 10);
        if (batch.status === 'QUARANTINED' || batch.status === 'EXPIRED' || (batch.expiryDate && batch.expiryDate.slice(0, 10) < todayStr)) {
          throw new OfflineEngineError(
            'INV_BATCH_BLOCKED',
            `Batch "${batch.batchNumber}" is ${batch.status === 'QUARANTINED' ? 'quarantined' : 'expired'} and cannot be issued.`,
            422,
          );
        }
        if (Quantity.fromDecimalString(batch.availableQuantity).microUnits < baseQty.microUnits) {
          throw new OfflineEngineError(
            'INV_INSUFFICIENT_BATCH_STOCK',
            `Batch "${batch.batchNumber}" has only ${batch.availableQuantity} available.`,
            422,
          );
        }
      }

      if (params.input.serialId && this.storage.listSerials) {
        const serials = await this.storage.listSerials({
          tenantId: params.tenantId,
          warehouseId: params.input.warehouseId,
          productId: product.id,
        });
        const ser = serials.find((s) => s.id === params.input.serialId);
        if (!ser || ser.status !== 'IN_STOCK') {
          throw new OfflineEngineError(
            'INV_SERIAL_NOT_AVAILABLE',
            `Serial "${params.input.serialId}" is not available (IN_STOCK) in this warehouse.`,
            422,
          );
        }
      }
    }

    const movementId = randomUUID();
    const outboxCommandId = randomUUID();
    const occurredAt = new Date().toISOString();

    const { localSeq } = await this.storage.commitOfflineInventoryMovement({
      movementId,
      tenantId: params.tenantId,
      branchId: params.branchId,
      warehouseId: params.input.warehouseId,
      productId: product.id,
      productSku: product.sku,
      productName: product.name,
      batchId: params.input.batchId ?? null,
      serialId: params.input.serialId ?? null,
      entryKind: params.entryKind,
      movementType: params.input.movementType,
      uomCode,
      inputQtyMicro: toMicro(inputQty),
      qtyDeltaMicro: signedMicro,
      reason: params.input.reason.trim(),
      notes: params.input.notes ?? null,
      actorUserId: ctx.actorUserId,
      deviceId: ctx.deviceId,
      outboxCommandId,
      commandType: params.commandType,
      occurredAt,
      outboxPayload: {
        branchId: params.branchId,
        warehouseId: params.input.warehouseId,
        productId: product.id,
        batchId: params.input.batchId ?? null,
        serialId: params.input.serialId ?? null,
        movementType: params.input.movementType,
        quantity: inputQty.toDecimalString(),
        uomCode,
        reason: params.input.reason.trim(),
        notes: params.input.notes ?? null,
        occurredAt,
        entrySource: 'MANUAL',
      },
    });

    const refreshed = await this.storage.getProductById({
      tenantId: params.tenantId,
      branchId: params.branchId,
      warehouseId: params.input.warehouseId,
      productId: product.id,
    });

    return {
      movementId,
      outboxCommandId,
      localSeq,
      newProjectedBalance: refreshed?.availableQuantity ?? product.availableQuantity,
    };
  }

  async createTransferRequest(params: {
    readonly tenantId: string;
    readonly branchId: string;
    readonly input: OfflineTransferRequestInput;
  }): Promise<{ transfer: OfflineTransferRequestRecord; localSeq: number }> {
    if (!this.storage.createOfflineTransferRequest) {
      throw new OfflineEngineError(
        'OFFLINE_STORAGE_UNSUPPORTED',
        'Storage adapter does not support offline transfer requests.',
        500,
      );
    }

    const ctx = await this.ensureSecurity({
      tenantId: params.tenantId,
      branchId: params.branchId,
      isOnline: params.input.isOnline,
      operation: 'INV_OFFLINE_TRANSFER_REQUEST',
      requiredPermission: 'inv:movement:post',
    });

    if (params.input.destinationBranchId === params.branchId) {
      throw new OfflineEngineError(
        'INV_TRANSFER_BRANCH_CONFLICT',
        'Destination branch must differ from the source branch.',
        422,
      );
    }
    if (params.input.lines.length === 0) {
      throw new OfflineEngineError(
        'ERR_VALIDATION_FAILED',
        'Transfer request requires at least one product line.',
        422,
      );
    }

    for (const line of params.input.lines) {
      const q = Quantity.fromDecimalString(line.quantity);
      if (!q.isPositive()) {
        throw new OfflineEngineError(
          'ERR_VALIDATION_FAILED',
          'Transfer line quantity must be positive.',
          422,
        );
      }
      const prod = await this.storage.getProductById({
        tenantId: params.tenantId,
        branchId: params.branchId,
        warehouseId: params.input.sourceWarehouseId,
        productId: line.productId,
      });
      if (!prod) {
        throw new OfflineEngineError(
          'ERR_NOT_FOUND',
          `Product "${line.productId}" not found in source branch.`,
          404,
        );
      }
      if (Quantity.fromDecimalString(prod.availableQuantity).microUnits < q.microUnits) {
        throw new OfflineEngineError(
          'INV_INSUFFICIENT_AVAILABLE_STOCK',
          `Insufficient available quantity for "${prod.sku}" to request transfer.`,
          422,
        );
      }
    }

    const transferId = randomUUID();
    const outboxCommandId = randomUUID();
    const occurredAt = new Date().toISOString();

    const { localSeq } = await this.storage.createOfflineTransferRequest({
      transferId,
      tenantId: params.tenantId,
      sourceBranchId: params.branchId,
      sourceWarehouseId: params.input.sourceWarehouseId,
      destinationBranchId: params.input.destinationBranchId,
      destinationWarehouseId: params.input.destinationWarehouseId ?? null,
      notes: params.input.notes ?? null,
      lines: params.input.lines,
      actorUserId: ctx.actorUserId,
      deviceId: ctx.deviceId,
      outboxCommandId,
      occurredAt,
      outboxPayload: {
        sourceBranchId: params.branchId,
        sourceWarehouseId: params.input.sourceWarehouseId,
        destinationBranchId: params.input.destinationBranchId,
        ...(params.input.destinationWarehouseId
          ? { destinationWarehouseId: params.input.destinationWarehouseId }
          : {}),
        autoComplete: false,
        notes: params.input.notes ?? null,
        lines: params.input.lines.map((l) => ({
          productId: l.productId,
          quantity: Quantity.fromDecimalString(l.quantity).toDecimalString(),
          ...(l.uomCode ? { uomCode: l.uomCode } : {}),
          ...(l.batchId ? { sourceBatchId: l.batchId } : {}),
          ...(l.serialId ? { serialId: l.serialId } : {}),
        })),
      },
    });

    return {
      localSeq,
      transfer: {
        id: transferId,
        outboxCommandId,
        sourceBranchId: params.branchId,
        sourceWarehouseId: params.input.sourceWarehouseId,
        destinationBranchId: params.input.destinationBranchId,
        destinationWarehouseId: params.input.destinationWarehouseId ?? null,
        notes: params.input.notes ?? null,
        lines: params.input.lines,
        status: 'TRANSFER_REQUEST_PENDING',
        syncState: 'PENDING_SYNC',
        serverTransferId: null,
        serverTransferNumber: null,
        conflictReason: null,
        createdAt: occurredAt,
      },
    };
  }

  async performSerialOperation(params: {
    readonly tenantId: string;
    readonly branchId: string;
    readonly warehouseId: string;
    readonly input: OfflineSerialOperationInput;
  }): Promise<{ movementId: string; outboxCommandId: string; localSeq: number }> {
    if (!this.storage.commitOfflineInventoryMovement || !this.storage.listSerials) {
      throw new OfflineEngineError(
        'OFFLINE_STORAGE_UNSUPPORTED',
        'Storage adapter does not support offline serial operations.',
        500,
      );
    }

    const ctx = await this.ensureSecurity({
      tenantId: params.tenantId,
      branchId: params.branchId,
      isOnline: params.input.isOnline,
      operation: 'INV_OFFLINE_SERIAL_OPS',
      requiredPermission: 'inv:serial:manage',
    });

    const serials = await this.storage.listSerials({
      tenantId: params.tenantId,
      warehouseId: params.warehouseId,
    });
    const serial = serials.find((s) => s.id === params.input.serialId);
    if (!serial) {
      throw new OfflineEngineError('ERR_NOT_FOUND', 'Serial number record not found locally.', 404);
    }

    const movementId = randomUUID();
    const outboxCommandId = randomUUID();
    const occurredAt = new Date().toISOString();

    const { localSeq } = await this.storage.commitOfflineInventoryMovement({
      movementId,
      tenantId: params.tenantId,
      branchId: params.branchId,
      warehouseId: params.warehouseId,
      productId: serial.productId,
      productSku: null,
      productName: serial.serialNumber,
      batchId: serial.batchId,
      serialId: serial.id,
      entryKind: 'SERIAL_OP',
      movementType: `SERIAL_${params.input.toStatus}`,
      uomCode: 'EA',
      inputQtyMicro: 0,
      qtyDeltaMicro: 0,
      reason: params.input.reason,
      notes: `Serial ${serial.serialNumber} -> ${params.input.toStatus}`,
      actorUserId: ctx.actorUserId,
      deviceId: ctx.deviceId,
      outboxCommandId,
      commandType: 'INV_SERIAL_OPERATION',
      occurredAt,
      outboxPayload: {
        serialId: serial.id,
        toStatus: params.input.toStatus,
        reason: params.input.reason,
      },
    });

    return { movementId, outboxCommandId, localSeq };
  }

  async listTransfers(params: {
    readonly tenantId: string;
    readonly branchId: string;
    readonly isOnline: boolean;
    readonly limit?: number;
  }): Promise<readonly OfflineTransferRequestRecord[]> {
    await this.ensureSecurity({
      tenantId: params.tenantId,
      branchId: params.branchId,
      isOnline: params.isOnline,
      operation: 'INV_OFFLINE_TRANSFER_REQUEST',
    });
    return (
      this.storage.listOfflineTransfers?.({
        tenantId: params.tenantId,
        branchId: params.branchId,
        ...(params.limit ? { limit: params.limit } : {}),
      }) ?? []
    );
  }

  async listInventoryHistory(params: {
    readonly tenantId: string;
    readonly branchId: string;
    readonly isOnline: boolean;
    readonly limit?: number;
  }): Promise<readonly OfflineInventoryHistoryEntry[]> {
    await this.ensureSecurity({
      tenantId: params.tenantId,
      branchId: params.branchId,
      isOnline: params.isOnline,
      operation: 'INV_OFFLINE_ADJUSTMENT',
    });
    return (
      this.storage.listOfflineInventoryHistory?.({
        tenantId: params.tenantId,
        branchId: params.branchId,
        ...(params.limit ? { limit: params.limit } : {}),
      }) ?? []
    );
  }

  async recordOfflineWasteDraft(params: {
    readonly tenantId: string;
    readonly branchId: string;
    readonly input: OfflineWasteDraftInput;
  }): Promise<{ wasteDraftId: string; outboxCommandId: string; localSeq: number }> {
    if (!this.storage.createOfflineWasteDraft) {
      throw new OfflineEngineError(
        'OFFLINE_STORAGE_UNSUPPORTED',
        'Storage adapter does not support offline waste drafts.',
        500,
      );
    }

    const ctx = await this.ensureSecurity({
      tenantId: params.tenantId,
      branchId: params.branchId,
      isOnline: params.input.isOnline,
      operation: 'INV_OFFLINE_WASTE_DRAFT',
      requiredPermission: 'inv:waste:create',
    });

    const reasonCode = params.input.reasonCode.trim().toUpperCase();
    if (!reasonCode) {
      throw new OfflineEngineError(
        'ERR_VALIDATION_FAILED',
        'Waste reason code is required.',
        422,
      );
    }
    if (reasonCode === 'OTHER' && (!params.input.description || !params.input.description.trim())) {
      throw new OfflineEngineError(
        'INV_WASTE_DESCRIPTION_REQUIRED',
        'Description is mandatory when reason is OTHER.',
        422,
      );
    }
    if (params.input.lines.length === 0) {
      throw new OfflineEngineError(
        'ERR_VALIDATION_FAILED',
        'Waste draft requires at least one product line.',
        422,
      );
    }

    for (const line of params.input.lines) {
      const q = Quantity.fromDecimalString(line.quantity);
      if (!q.isPositive()) {
        throw new OfflineEngineError(
          'INV_WASTE_INVALID_QUANTITY',
          'Waste quantity must be positive.',
          422,
        );
      }
      const prod = await this.storage.getProductById({
        tenantId: params.tenantId,
        branchId: params.branchId,
        warehouseId: params.input.warehouseId,
        productId: line.productId,
      });
      if (!prod) {
        throw new OfflineEngineError(
          'ERR_NOT_FOUND',
          `Product "${line.productId}" not found in branch offline snapshot.`,
          404,
        );
      }
    }

    const wasteDraftId = randomUUID();
    const outboxCommandId = randomUUID();
    const occurredAt = new Date().toISOString();

    const { localSeq } = await this.storage.createOfflineWasteDraft({
      wasteDraftId,
      tenantId: params.tenantId,
      branchId: params.branchId,
      warehouseId: params.input.warehouseId,
      reasonCode,
      description: params.input.description?.trim() || null,
      lines: params.input.lines,
      actorUserId: ctx.actorUserId,
      deviceId: ctx.deviceId,
      outboxCommandId,
      occurredAt,
      outboxPayload: {
        branchId: params.branchId,
        warehouseId: params.input.warehouseId,
        reasonCode,
        description: params.input.description?.trim() || null,
        confirmImmediately: false,
        syncCommandId: outboxCommandId,
        lines: params.input.lines.map((l) => ({
          productId: l.productId,
          wasteQty: l.quantity,
          uomCode: l.uomCode || undefined,
          batchId: l.batchId ?? null,
          serialId: l.serialId ?? null,
          stockIntakeLotId: l.stockIntakeLotId ?? null,
          notes: l.notes ?? null,
        })),
      },
    });

    return { wasteDraftId, outboxCommandId, localSeq };
  }

  async listWasteDrafts(params: {
    readonly tenantId: string;
    readonly branchId?: string;
    readonly isOnline: boolean;
    readonly limit?: number;
  }): Promise<readonly OfflineWasteDraftRecord[]> {
    if (!params.branchId) {
      return [];
    }
    await this.ensureSecurity({
      tenantId: params.tenantId,
      branchId: params.branchId,
      isOnline: params.isOnline,
      operation: 'INV_OFFLINE_WASTE_DRAFT',
    });
    return (
      this.storage.listOfflineWasteDrafts?.({
        tenantId: params.tenantId,
        branchId: params.branchId,
        ...(params.limit ? { limit: params.limit } : {}),
      }) ?? []
    );
  }
}

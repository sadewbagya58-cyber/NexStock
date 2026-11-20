import { parseGs1Barcode } from '@nexstock/domain-core';
import {
  OfflineInventoryEngine,
  OfflinePosEngine,
  OfflineSyncEngine,
  type SqliteDatabaseLike,
  SqliteOfflineStorageAdapter,
  type OfflineStoragePort,
  type OfflineSyncTransportPort,
} from '@nexstock/offline-engine';
import {
  getCanonicalSqliteMigrations,
  initializeLocalSqliteDatabase,
} from '@nexstock/sqlite-schema';
import {
  type StatusBannerDescriptor,
  createSyncStatusBannerDescriptor,
} from '@nexstock/ui';

export {
  getCanonicalSqliteMigrations,
  initializeLocalSqliteDatabase,
  OfflineInventoryEngine,
  OfflinePosEngine,
  OfflineSyncEngine,
  SqliteOfflineStorageAdapter,
};
export * from '@nexstock/offline-engine';

export function getMobileConnectionBanner(params: {
  readonly isOnline: boolean;
  readonly pendingOutboxCount: number;
  readonly isSyncInFlight: boolean;
}): StatusBannerDescriptor {
  return createSyncStatusBannerDescriptor({
    ...params,
    clientPlatform: 'MOBILE_APP',
  });
}

export interface ParsedMobileCameraScan {
  readonly rawValue: string;
  readonly normalizedCode: string;
  readonly gtin: string | null;
  readonly batchLot: string | null;
  readonly expiryDate: string | null;
  readonly isGs1: boolean;
  readonly isInternalBatchBarcode: boolean;
}

/**
 * Normalizes camera scanner payloads (MLKit / Vision / Web BarcodeDetector)
 * across GS1-128, internal batch barcodes (NB-B...), EAN-13, UPC-A, and SKUs.
 */
export function parseMobileCameraBarcodeScan(rawValue: string): ParsedMobileCameraScan {
  const trimmed = rawValue.trim();
  if (!trimmed) {
    return {
      rawValue,
      normalizedCode: '',
      gtin: null,
      batchLot: null,
      expiryDate: null,
      isGs1: false,
      isInternalBatchBarcode: false,
    };
  }

  const isInternalBatch = /^NB-/i.test(trimmed);
  if (isInternalBatch) {
    return {
      rawValue,
      normalizedCode: trimmed.toUpperCase(),
      gtin: null,
      batchLot: null,
      expiryDate: null,
      isGs1: false,
      isInternalBatchBarcode: true,
    };
  }

  const gs1 = parseGs1Barcode(trimmed);
  if (gs1.isGs1 || gs1.gtin14 || gs1.batchNumber || gs1.expiryDate) {
    return {
      rawValue,
      normalizedCode: gs1.candidateBarcodes[0] || gs1.gtin14 || trimmed,
      gtin: gs1.gtin14 ?? null,
      batchLot: gs1.batchNumber ?? null,
      expiryDate: gs1.expiryDate ?? null,
      isGs1: gs1.isGs1,
      isInternalBatchBarcode: false,
    };
  }

  return {
    rawValue,
    normalizedCode: trimmed,
    gtin: null,
    batchLot: null,
    expiryDate: null,
    isGs1: false,
    isInternalBatchBarcode: false,
  };
}

/**
 * Mobile Offline POS, Inventory & Sync Engine runtime (Phase 9.1 - 9.9).
 * Uses the exact same canonical SQLite 0001..0009 schema and @nexstock/offline-engine
 * business logic as Desktop, with touch/camera barcode extensions.
 */
export class MobileOfflinePosRuntime {
  readonly storage: OfflineStoragePort;
  readonly engine: OfflinePosEngine;
  readonly inventory: OfflineInventoryEngine;
  sync: OfflineSyncEngine;

  constructor(
    storage: OfflineStoragePort,
    currencyCode = 'LKR',
    syncTransport?: OfflineSyncTransportPort,
  ) {
    this.storage = storage;
    this.engine = new OfflinePosEngine(storage, currencyCode);
    this.inventory = new OfflineInventoryEngine(storage);
    this.sync = new OfflineSyncEngine(storage, syncTransport);
  }

  attachSyncTransport(transport: OfflineSyncTransportPort): void {
    this.sync = new OfflineSyncEngine(this.storage, transport);
  }

  static fromSqlite(
    db: SqliteDatabaseLike,
    currencyCode = 'LKR',
    syncTransport?: OfflineSyncTransportPort,
  ): MobileOfflinePosRuntime {
    const adapter = new SqliteOfflineStorageAdapter(db, 'MOBILE_APP');
    return new MobileOfflinePosRuntime(adapter, currencyCode, syncTransport);
  }

  async scanFromCamera(params: {
    readonly tenantId: string;
    readonly branchId: string;
    readonly warehouseId: string;
    readonly rawCameraPayload: string;
    readonly isOnline: boolean;
  }) {
    const parsed = parseMobileCameraBarcodeScan(params.rawCameraPayload);
    const lookup = await this.engine.scanBarcode({
      tenantId: params.tenantId,
      branchId: params.branchId,
      warehouseId: params.warehouseId,
      code: parsed.normalizedCode || parsed.rawValue,
      isOnline: params.isOnline,
    });
    return {
      parsed,
      lookup,
    };
  }
}

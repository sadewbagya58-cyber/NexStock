import type {
  LocalTransactionSyncState,
  OfflineCapabilityClass,
  OfflineClientPlatform,
  OfflineDataFreshness,
  OfflineDeviceContext,
  OfflineInventoryHistoryEntry,
  OfflineLocalInvoice,
  OfflineOperationKey,
  ResolveSyncConflictRequest,
  ResolveSyncConflictResponse,
  SyncCatalogPricingResponse,
  SyncConflictRecord,
  SyncPullResponse,
  SyncPushBatchRequest,
  SyncPushBatchResponse,
} from '@nexstock/contracts';

export interface OfflineCategoryRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly parentId: string | null;
  readonly name: string;
  readonly status: 'ACTIVE' | 'ARCHIVED';
  readonly syncVersion: number;
}

export interface OfflineProductRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly sku: string;
  readonly name: string;
  readonly categoryId: string | null;
  readonly baseUom: string;
  readonly priceUom: string;
  readonly purchaseCost: string;
  readonly sellingPrice: string;
  readonly effectivePrice: string;
  readonly minSellingPrice: string | null;
  readonly maxDiscountPct: string | null;
  readonly valuationMethod: 'MOVING_AVG' | 'FIFO';
  readonly trackingMode: 'NONE' | 'BATCH' | 'BATCH_EXPIRY' | 'SERIAL';
  readonly allocationPolicy: 'FEFO' | 'FIFO' | 'MANUAL';
  readonly requireBatchSellingPrice: boolean;
  readonly productQtyMode: 'STANDARD' | 'VARIABLE';
  readonly measurementCategory: 'WEIGHT' | 'VOLUME' | 'COUNT' | 'LENGTH' | null;
  readonly allowedSellingUoms: readonly string[];
  readonly qtyDecimalPrecision: number;
  readonly taxGroupId: string | null;
  readonly trackInventory: boolean;
  readonly primaryBarcode: string | null;
  readonly availableQuantity: string;
  readonly serverQuantity: string;
  readonly localPendingDelta: string;
  readonly movingAvgCost: string;
}

export interface OfflineBatchRecord {
  readonly batchId: string;
  readonly productId: string;
  readonly warehouseId: string;
  readonly branchId: string | null;
  readonly batchNumber: string;
  readonly status: string;
  readonly availableQuantity: string;
  readonly unitCost: string;
  readonly sellingPrice: string | null;
  readonly minSellingPrice: string | null;
  readonly maxDiscountPct: string | null;
  readonly batchPricingMode: 'EXPLICIT' | 'INHERIT_PRODUCT';
  readonly internalBarcode: string | null;
  readonly expiryDate: string | null;
  readonly receivedDate: string;
}

export interface OfflineSerialRecord {
  readonly id: string;
  readonly productId: string;
  readonly warehouseId: string;
  readonly branchId: string;
  readonly batchId: string | null;
  readonly serialNumber: string;
  readonly status: string;
  readonly unitCost: string;
}

export interface OfflineCustomerRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly customerNumber: string;
  readonly name: string;
  readonly phone: string | null;
  readonly email: string | null;
  readonly status: 'ACTIVE' | 'INACTIVE' | 'ARCHIVED';
}

export interface OfflineTaxRateRecord {
  readonly id: string;
  readonly taxGroupId: string;
  readonly code: string;
  readonly name: string;
  readonly ratePercentage: string;
  readonly isCompound: boolean;
  readonly priority: number;
}

export interface OfflineUnitConversionRecord {
  readonly productId: string;
  readonly uomCode: string;
  readonly uomName: string;
  readonly conversionFactorToBase: string;
  readonly sellingPrice?: string | null;
}

export interface OfflineBarcodeLookupResult {
  readonly matchType: 'INTERNAL_BATCH_BARCODE' | 'PRODUCT_BARCODE' | 'SERIAL_NUMBER' | 'NOT_FOUND';
  readonly productId: string | null;
  readonly sku: string | null;
  readonly name: string | null;
  readonly baseUom: string | null;
  readonly priceUom: string | null;
  readonly resolvedSellingUom?: string | null;
  readonly resolvedConversionFactorToBase?: string | null;
  readonly stockIntakeLotId?: string | null;
  readonly intakeCode?: string | null;
  readonly batchId: string | null;
  readonly batchNumber: string | null;
  readonly serialId: string | null;
  readonly serialNumber: string | null;
  readonly internalBarcode: string | null;
  readonly availableQuantity: string | null;
  readonly sellingPrice: string | null;
  readonly pricingSource:
    | 'EXPLICIT_BATCH_PRICE'
    | 'INTAKE_SPECIFIC'
    | 'PACKAGE_EXPLICIT'
    | 'BRANCH_OVERRIDE'
    | 'PRODUCT_DEFAULT'
    | null;
  readonly expiryDate: string | null;
  readonly allocationPolicy: string | null;
  readonly isBlocked: boolean;
  readonly blockReason: string | null;
}

export interface OfflineCartLineInput {
  readonly productId: string;
  readonly uomCode?: string;
  readonly quantity: string;
  readonly lineDiscount?: string;
  readonly batchId?: string | null;
  readonly serialId?: string | null;
  readonly stockIntakeLotId?: string | null;
  readonly intakeCode?: string | null;
  readonly scannedBarcode?: string | null;
  readonly overrideSellingPrice?: string | null;
  readonly entrySource?: 'BARCODE_SCAN' | 'MANUAL' | 'MANUAL_WEIGHT' | 'SCALE_WEIGHT' | 'QUICK_PICK';
}

export interface OfflineComputedCartLine {
  readonly lineNumber: number;
  readonly productId: string;
  readonly sku: string;
  readonly productName: string;
  readonly batchId: string | null;
  readonly batchNumber: string | null;
  readonly serialId: string | null;
  readonly stockIntakeLotId?: string | null;
  readonly intakeCode?: string | null;
  readonly scannedBarcode?: string | null;
  readonly uomCode: string;
  readonly enteredQty: string;
  readonly conversionFactorToBase: string;
  readonly normalizedBaseQty: string;
  readonly unitPrice: string;
  readonly unitCostSnapshot: string;
  readonly grossAmount: string;
  readonly discountAmount: string;
  readonly netTaxableAmount: string;
  readonly taxAmount: string;
  readonly lineTotal: string;
  readonly taxRulesApplied: readonly {
    readonly taxRateId: string;
    readonly name: string;
    readonly ratePercentage: string;
    readonly taxAmount: string;
  }[];
  readonly entrySource: string;
}

export interface OfflineCartTotalsSummary {
  readonly currencyCode: string;
  readonly subtotalAmount: string;
  readonly discountAmount: string;
  readonly taxAmount: string;
  readonly grandTotal: string;
  readonly lines: readonly OfflineComputedCartLine[];
}

export interface OfflineDraftCartRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly branchId: string;
  readonly userId: string;
  readonly registerId: string | null;
  readonly customerId: string | null;
  readonly customerName: string | null;
  readonly lines: readonly OfflineCartLineInput[];
  readonly notes: string | null;
  readonly updatedAt: string;
}

export interface OfflineCashCheckoutInput {
  readonly registerId: string;
  readonly shiftId: string | null;
  readonly customerId?: string | null;
  readonly customerName?: string | null;
  readonly lines: readonly OfflineCartLineInput[];
  readonly paymentMethod: 'CASH' | 'CARD' | 'CREDIT' | 'SPLIT_CASH_CARD' | 'SPLIT_CASH_CREDIT';
  readonly tenderedAmount: string;
  readonly isOnline: boolean;
  readonly notes?: string | null;
}

export interface OfflineCompletedSaleResult {
  readonly invoice: OfflineLocalInvoice;
  readonly lines: readonly OfflineComputedCartLine[];
  readonly outboxCommandId: string;
  readonly localSeq: number;
  readonly syncState: LocalTransactionSyncState;
  readonly serverConfirmed: false;
  readonly receiptPayload: {
    readonly invoiceNumber: string;
    readonly syncBadge: 'PENDING_SYNC';
    readonly issuedAt: string;
    readonly branchId: string;
    readonly registerId: string;
    readonly customerName: string | null;
    readonly currencyCode: string;
    readonly subtotalAmount: string;
    readonly discountAmount: string;
    readonly taxAmount: string;
    readonly grandTotal: string;
    readonly tenderedAmount: string;
    readonly changeGiven: string;
    readonly lines: readonly OfflineComputedCartLine[];
  };
}

export interface OfflineOutboxCommandRecord {
  readonly localSeq: number;
  readonly commandId: string;
  readonly tenantId: string;
  readonly branchId: string;
  readonly deviceId: string;
  readonly actorUserId: string;
  readonly commandType: string;
  readonly schemaVersion: number;
  readonly payload: Record<string, unknown>;
  readonly occurredAt: string;
  readonly status: 'PENDING' | 'IN_FLIGHT' | 'SYNCED' | 'QUARANTINED';
  readonly retryCount: number;
  readonly lastError: string | null;
}

export interface OfflineCapabilityDescriptor {
  readonly operation: OfflineOperationKey;
  readonly capability: OfflineCapabilityClass;
  readonly reason: string;
}

export type OfflineSyncConnectionState =
  | 'ONLINE'
  | 'OFFLINE'
  | 'SYNCING'
  | 'PENDING_SYNC'
  | 'SYNC_FAILED'
  | 'CONFLICT';

export interface OfflineStockAdjustmentInput {
  readonly warehouseId: string;
  readonly productId: string;
  readonly movementType: 'ADJUSTMENT_POSITIVE' | 'ADJUSTMENT_NEGATIVE';
  readonly quantity: string;
  readonly uomCode?: string;
  readonly batchId?: string | null;
  readonly serialId?: string | null;
  readonly reason: string;
  readonly notes?: string | null;
  readonly isOnline: boolean;
}

export interface OfflineStockMovementInput {
  readonly warehouseId: string;
  readonly productId: string;
  readonly movementType: 'STOCK_IN' | 'STOCK_OUT' | 'SUPPLIER_RETURN' | 'CUSTOMER_RETURN_RESTOCK';
  readonly quantity: string;
  readonly uomCode?: string;
  readonly batchId?: string | null;
  readonly serialId?: string | null;
  readonly reason?: string | null;
  readonly notes?: string | null;
  readonly isOnline: boolean;
}

export interface OfflineTransferRequestInput {
  readonly sourceWarehouseId: string;
  readonly destinationBranchId: string;
  readonly destinationWarehouseId?: string | null;
  readonly notes?: string | null;
  readonly lines: readonly {
    readonly productId: string;
    readonly quantity: string;
    readonly uomCode?: string;
    readonly batchId?: string | null;
    readonly serialId?: string | null;
  }[];
  readonly isOnline: boolean;
}

export interface OfflineTransferRequestRecord {
  readonly id: string;
  readonly outboxCommandId: string;
  readonly sourceBranchId: string;
  readonly sourceWarehouseId: string;
  readonly destinationBranchId: string;
  readonly destinationWarehouseId: string | null;
  readonly notes: string | null;
  readonly lines: readonly {
    readonly productId: string;
    readonly quantity: string;
    readonly uomCode?: string;
    readonly batchId?: string | null;
    readonly serialId?: string | null;
  }[];
  readonly status: 'TRANSFER_REQUEST_PENDING' | 'SERVER_CONFIRMED' | 'CONFLICT_FLAGGED' | 'QUARANTINED';
  readonly syncState: LocalTransactionSyncState;
  readonly serverTransferId: string | null;
  readonly serverTransferNumber: string | null;
  readonly conflictReason: string | null;
  readonly createdAt: string;
}

export interface OfflineExpiryAlertItem {
  readonly batchId: string;
  readonly productId: string;
  readonly warehouseId: string;
  readonly batchNumber: string;
  readonly availableQuantity: string;
  readonly expiryDate: string;
  readonly daysRemaining: number;
  readonly alertLevel: 'EXPIRED' | 'EXPIRING_SOON';
}

export interface OfflineSerialOperationInput {
  readonly serialId: string;
  readonly toStatus: 'IN_STOCK' | 'RESERVED' | 'DAMAGED' | 'QUARANTINED' | 'WRITTEN_OFF';
  readonly reason: string;
  readonly isOnline: boolean;
}

export interface OfflineLocalConflictRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly branchId: string;
  readonly deviceId: string;
  readonly commandId: string;
  readonly commandType: string;
  readonly entityType: string;
  readonly localReferenceId: string | null;
  readonly localReferenceNumber: string | null;
  readonly conflictCode: string;
  readonly status: 'OPEN' | 'QUARANTINED' | 'RESOLVED' | 'DISMISSED';
  readonly details: Record<string, unknown>;
  readonly originalPayload: Record<string, unknown>;
  readonly resolutionAction: string | null;
  readonly resolutionNotes: string | null;
  readonly resolvedByUserId: string | null;
  readonly createdAt: string;
  readonly resolvedAt: string | null;
}

export interface OfflineDeviceSecurityStateRecord {
  readonly tenantId: string;
  readonly deviceId: string;
  readonly status: 'ACTIVE' | 'REVOKED' | 'EXPIRED';
  readonly revokedReason: string | null;
  readonly lastVerifiedAt: string;
  readonly lastSyncAttemptAt: string | null;
  readonly lastSyncSuccessAt: string | null;
  readonly lastSyncError: string | null;
}

export interface OfflineSyncTransportPort {
  pushBatch(req: SyncPushBatchRequest): Promise<SyncPushBatchResponse>;
  pullDelta(params: {
    readonly branchId: string;
    readonly deviceId: string;
    readonly since?: string | null;
  }): Promise<SyncPullResponse>;
  listConflicts?(params: {
    readonly branchId?: string;
    readonly deviceId?: string;
    readonly status?: 'OPEN' | 'QUARANTINED' | 'RESOLVED' | 'DISMISSED';
  }): Promise<readonly SyncConflictRecord[]>;
  resolveConflict?(
    conflictId: string,
    input: ResolveSyncConflictRequest,
  ): Promise<ResolveSyncConflictResponse>;
}

export interface OfflineSyncEngineStatus {
  readonly connectionState: OfflineSyncConnectionState;
  readonly isOnline: boolean;
  readonly isSyncing: boolean;
  readonly pendingCount: number;
  readonly failedCount: number;
  readonly openConflictCount: number;
  readonly lastSyncAttemptAt: string | null;
  readonly lastSyncSuccessAt: string | null;
  readonly lastError: string | null;
  readonly deviceSecurityStatus: 'ACTIVE' | 'REVOKED' | 'EXPIRED';
  readonly revokedReason: string | null;
}

export interface OfflineSyncRunResult {
  readonly pushedCount: number;
  readonly appliedCount: number;
  readonly duplicateCount: number;
  readonly quarantinedCount: number;
  readonly conflictFlaggedCount: number;
  readonly failedCount: number;
  readonly recoveredInFlightCount: number;
  readonly pulledOpenConflicts: number;
  readonly deviceRevoked: boolean;
  readonly lastError: string | null;
  readonly status: OfflineSyncEngineStatus;
}

export interface OfflineRecoveryBackupPayload {
  readonly formatVersion: 1;
  readonly exportedAt: string;
  readonly tenantId: string;
  readonly branchId: string;
  readonly deviceId: string;
  readonly checksumSha256: string;
  readonly pendingOutbox: readonly OfflineOutboxCommandRecord[];
  readonly localInvoices: readonly OfflineLocalInvoice[];
  readonly inventoryMovements: readonly OfflineInventoryHistoryEntry[];
  readonly transferRequests: readonly OfflineTransferRequestRecord[];
  readonly conflicts: readonly OfflineLocalConflictRecord[];
}

export interface OfflineWasteDraftLineInput {
  readonly productId: string;
  readonly quantity: string;
  readonly uomCode?: string | null;
  readonly batchId?: string | null;
  readonly serialId?: string | null;
  readonly stockIntakeLotId?: string | null;
  readonly notes?: string | null;
}

export interface OfflineWasteDraftInput {
  readonly warehouseId: string;
  readonly reasonCode: string;
  readonly description?: string | null;
  readonly isOnline: boolean;
  readonly lines: readonly OfflineWasteDraftLineInput[];
}

export interface OfflineWasteDraftRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly branchId: string;
  readonly warehouseId: string;
  readonly reasonCode: string;
  readonly description: string | null;
  readonly lines: readonly OfflineWasteDraftLineInput[];
  readonly syncState: LocalTransactionSyncState;
  readonly outboxCommandId: string;
  readonly serverWasteLogId: string | null;
  readonly serverWasteNumber: string | null;
  readonly conflictReason: string | null;
  readonly actorUserId: string;
  readonly createdAt: string;
  readonly syncedAt: string | null;
}

export interface OfflineStoragePort {
  readonly platform: OfflineClientPlatform;

  getDeviceContext(): Promise<OfflineDeviceContext | null> | OfflineDeviceContext | null;
  saveDeviceContext(ctx: OfflineDeviceContext): Promise<void> | void;

  saveSyncSnapshot(params: {
    readonly tenantId: string;
    readonly branchId: string;
    readonly snapshot: SyncCatalogPricingResponse;
  }): Promise<{ savedProducts: number; savedCustomers: number; savedBatches: number; syncedAt: string }>
    | { savedProducts: number; savedCustomers: number; savedBatches: number; syncedAt: string };

  getDataFreshness(params: {
    readonly tenantId: string;
    readonly branchId: string;
    readonly staleAfterMinutes?: number;
  }): Promise<OfflineDataFreshness> | OfflineDataFreshness;

  listCategories(tenantId: string): Promise<readonly OfflineCategoryRecord[]> | readonly OfflineCategoryRecord[];

  searchProducts(params: {
    readonly tenantId: string;
    readonly branchId: string;
    readonly warehouseId: string;
    readonly query?: string;
    readonly categoryId?: string | null;
    readonly limit?: number;
  }): Promise<readonly OfflineProductRecord[]> | readonly OfflineProductRecord[];

  getProductById(params: {
    readonly tenantId: string;
    readonly branchId: string;
    readonly warehouseId: string;
    readonly productId: string;
  }): Promise<OfflineProductRecord | null> | OfflineProductRecord | null;

  getProductUnitConversions(params: {
    readonly tenantId: string;
    readonly productId: string;
  }): Promise<readonly OfflineUnitConversionRecord[]> | readonly OfflineUnitConversionRecord[];

  getTaxRatesForGroup(params: {
    readonly tenantId: string;
    readonly taxGroupId: string;
  }): Promise<readonly OfflineTaxRateRecord[]> | readonly OfflineTaxRateRecord[];

  listBatchesForProduct(params: {
    readonly tenantId: string;
    readonly warehouseId: string;
    readonly productId: string;
  }): Promise<readonly OfflineBatchRecord[]> | readonly OfflineBatchRecord[];

  resolveBarcode(params: {
    readonly tenantId: string;
    readonly branchId: string;
    readonly warehouseId: string;
    readonly code: string;
  }): Promise<OfflineBarcodeLookupResult> | OfflineBarcodeLookupResult;

  listCustomers(params: {
    readonly tenantId: string;
    readonly query?: string;
    readonly limit?: number;
  }): Promise<readonly OfflineCustomerRecord[]> | readonly OfflineCustomerRecord[];

  saveDraftCart(draft: OfflineDraftCartRecord): Promise<void> | void;
  loadDraftCart(params: {
    readonly tenantId: string;
    readonly branchId: string;
    readonly userId: string;
  }): Promise<OfflineDraftCartRecord | null> | OfflineDraftCartRecord | null;
  clearDraftCart(params: {
    readonly tenantId: string;
    readonly branchId: string;
    readonly userId: string;
  }): Promise<void> | void;

  commitOfflineCashSale(params: {
    readonly invoice: OfflineLocalInvoice;
    readonly lines: readonly OfflineComputedCartLine[];
    readonly tenderedAmount: string;
    readonly outboxCommandId: string;
    readonly outboxPayload: Record<string, unknown>;
    readonly stockDeductions: readonly {
      readonly productId: string;
      readonly warehouseId: string;
      readonly baseQtyDelta: string;
      readonly batchId: string | null;
      readonly serialId: string | null;
    }[];
  }): Promise<{ localSeq: number }> | { localSeq: number };

  listLocalInvoices(params: {
    readonly tenantId: string;
    readonly branchId?: string;
    readonly limit?: number;
  }): Promise<readonly OfflineLocalInvoice[]> | readonly OfflineLocalInvoice[];

  listPendingOutboxCommands(params: {
    readonly tenantId: string;
    readonly limit?: number;
  }): Promise<readonly OfflineOutboxCommandRecord[]> | readonly OfflineOutboxCommandRecord[];

  // Phase 9.5–9.9 Storage Extensions
  listAllBatches?(params: {
    readonly tenantId: string;
    readonly warehouseId?: string;
    readonly productId?: string;
  }): Promise<readonly OfflineBatchRecord[]> | readonly OfflineBatchRecord[];

  listSerials?(params: {
    readonly tenantId: string;
    readonly warehouseId?: string;
    readonly productId?: string;
    readonly serialNumber?: string;
  }): Promise<readonly OfflineSerialRecord[]> | readonly OfflineSerialRecord[];

  commitOfflineInventoryMovement?(params: {
    readonly movementId: string;
    readonly tenantId: string;
    readonly branchId: string;
    readonly warehouseId: string;
    readonly productId: string;
    readonly productSku: string | null;
    readonly productName: string | null;
    readonly batchId: string | null;
    readonly serialId: string | null;
    readonly entryKind: 'ADJUSTMENT' | 'MOVEMENT' | 'SERIAL_OP';
    readonly movementType: string;
    readonly uomCode: string;
    readonly inputQtyMicro: number;
    readonly qtyDeltaMicro: number;
    readonly reason: string | null;
    readonly notes: string | null;
    readonly actorUserId: string;
    readonly deviceId: string;
    readonly outboxCommandId: string;
    readonly commandType: string;
    readonly outboxPayload: Record<string, unknown>;
    readonly occurredAt: string;
  }): Promise<{ localSeq: number }> | { localSeq: number };

  createOfflineTransferRequest?(params: {
    readonly transferId: string;
    readonly tenantId: string;
    readonly sourceBranchId: string;
    readonly sourceWarehouseId: string;
    readonly destinationBranchId: string;
    readonly destinationWarehouseId: string | null;
    readonly notes: string | null;
    readonly lines: OfflineTransferRequestInput['lines'];
    readonly actorUserId: string;
    readonly deviceId: string;
    readonly outboxCommandId: string;
    readonly outboxPayload: Record<string, unknown>;
    readonly occurredAt: string;
  }): Promise<{ localSeq: number }> | { localSeq: number };

  listOfflineTransfers?(params: {
    readonly tenantId: string;
    readonly branchId?: string;
    readonly limit?: number;
  }): Promise<readonly OfflineTransferRequestRecord[]> | readonly OfflineTransferRequestRecord[];

  createOfflineWasteDraft?(params: {
    readonly wasteDraftId: string;
    readonly tenantId: string;
    readonly branchId: string;
    readonly warehouseId: string;
    readonly reasonCode: string;
    readonly description: string | null;
    readonly lines: readonly OfflineWasteDraftLineInput[];
    readonly actorUserId: string;
    readonly deviceId: string;
    readonly outboxCommandId: string;
    readonly outboxPayload: Record<string, unknown>;
    readonly occurredAt: string;
  }): Promise<{ localSeq: number }> | { localSeq: number };

  listOfflineWasteDrafts?(params: {
    readonly tenantId: string;
    readonly branchId?: string;
    readonly limit?: number;
  }): Promise<readonly OfflineWasteDraftRecord[]> | readonly OfflineWasteDraftRecord[];

  listOfflineInventoryHistory?(params: {
    readonly tenantId: string;
    readonly branchId?: string;
    readonly limit?: number;
  }): Promise<readonly OfflineInventoryHistoryEntry[]> | readonly OfflineInventoryHistoryEntry[];

  recoverInFlightOutboxCommands?(params: {
    readonly tenantId: string;
  }): Promise<number> | number;

  markOutboxCommandsInFlight?(params: {
    readonly tenantId: string;
    readonly commandIds: readonly string[];
  }): Promise<void> | void;

  applySyncPushReceipts?(params: {
    readonly tenantId: string;
    readonly deviceId: string;
    readonly branchId: string;
    readonly receipts: SyncPushBatchResponse['receipts'];
    readonly pushedAt: string;
  }): Promise<void> | void;

  markOutboxCommandsRetryFailed?(params: {
    readonly tenantId: string;
    readonly commandIds: readonly string[];
    readonly errorMessage: string;
    readonly attemptedAt: string;
  }): Promise<void> | void;

  upsertServerConflicts?(params: {
    readonly tenantId: string;
    readonly conflicts: readonly SyncConflictRecord[];
  }): Promise<void> | void;

  listLocalConflicts?(params: {
    readonly tenantId: string;
    readonly branchId?: string;
    readonly status?: 'OPEN' | 'QUARANTINED' | 'RESOLVED' | 'DISMISSED';
  }): Promise<readonly OfflineLocalConflictRecord[]> | readonly OfflineLocalConflictRecord[];

  markLocalConflictResolved?(params: {
    readonly tenantId: string;
    readonly conflictId: string;
    readonly status: 'RESOLVED' | 'DISMISSED';
    readonly resolutionAction: string;
    readonly resolutionNotes: string | null;
    readonly resolvedByUserId: string;
    readonly resolvedAt: string;
    readonly replayedReferenceId?: string | null;
    readonly replayedReferenceNumber?: string | null;
  }): Promise<void> | void;

  getDeviceSecurityState?(params: {
    readonly tenantId: string;
  }): Promise<OfflineDeviceSecurityStateRecord | null> | OfflineDeviceSecurityStateRecord | null;

  updateDeviceSecurityState?(params: {
    readonly tenantId: string;
    readonly deviceId: string;
    readonly status: 'ACTIVE' | 'REVOKED' | 'EXPIRED';
    readonly revokedReason?: string | null;
    readonly lastSyncAttemptAt?: string | null;
    readonly lastSyncSuccessAt?: string | null;
    readonly lastSyncError?: string | null;
  }): Promise<void> | void;

  checkDatabaseIntegrity?(): Promise<{ ok: boolean; details: string }> | { ok: boolean; details: string };

  exportRecoveryBackup?(params: {
    readonly tenantId: string;
    readonly branchId: string;
    readonly deviceId: string;
  }): Promise<Omit<OfflineRecoveryBackupPayload, 'checksumSha256'>> | Omit<OfflineRecoveryBackupPayload, 'checksumSha256'>;

  importRecoveryBackup?(params: {
    readonly backup: OfflineRecoveryBackupPayload;
  }): Promise<{ restoredOutboxCount: number; skippedDuplicatesCount: number }>
    | { restoredOutboxCount: number; skippedDuplicatesCount: number };
}

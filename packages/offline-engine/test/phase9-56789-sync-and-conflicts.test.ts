import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  OfflineInventoryEngine,
  OfflinePosEngine,
  OfflineSyncEngine,
  SqliteOfflineStorageAdapter,
  computeExponentialBackoffMs,
  type OfflineSyncTransportPort,
} from '../src/index.js';

describe('@nexstock/offline-engine — Phase 9.5–9.9 Inventory, Sync, Conflict, Security & Recovery', () => {
  const TENANT_ID = '0192b800-1111-7000-8000-000000000010';
  const FOREIGN_TENANT = '0192b800-2222-7000-8000-000000000020';
  const BRANCH_1 = '0192b800-1111-7000-8000-000000000031';
  const BRANCH_2 = '0192b800-1111-7000-8000-000000000032';
  const WH_1 = '0192b800-1111-7000-8000-000000000041';
  const REG_1 = '0192b800-1111-7000-8000-000000000051';
  const SHIFT_1 = '0192b800-1111-7000-8000-000000000061';
  const USER_ID = '0192b800-1111-7000-8000-000000000071';
  const DEVICE_ID = '0192b800-1111-7000-8000-000000000081';

  const PROD_SOAP = '0192b800-1111-7000-8000-000000000301';
  const BATCH_EXP = '0192b800-1111-7000-8000-000000000401';
  const BATCH_SOON = '0192b800-1111-7000-8000-000000000402';
  const BATCH_OK = '0192b800-1111-7000-8000-000000000403';
  const SERIAL_1 = '0192b800-1111-7000-8000-000000000501';

  async function createSeededSuite() {
    const db = new DatabaseSync(':memory:');
    const storage = new SqliteOfflineStorageAdapter(db, 'TAURI_DESKTOP');
    const pos = new OfflinePosEngine(storage, 'LKR');
    const inventory = new OfflineInventoryEngine(storage);

    await pos.bindDeviceSession({
      deviceId: DEVICE_ID,
      tenantId: TENANT_ID,
      branchId: BRANCH_1,
      branchCode: 'CMB-01',
      branchName: 'Colombo Main',
      warehouseId: WH_1,
      registerId: REG_1,
      actorUserId: USER_ID,
      roleCodes: ['BRANCH_MANAGER'],
      permissions: ['pos:sale:create', 'pos:sale:read', 'inv:movement:post', 'inv:serial:manage'],
      allLocationsAccess: false,
      allowedBranchIds: [BRANCH_1],
      clientPlatform: 'TAURI_DESKTOP',
      enrolledAt: new Date().toISOString(),
      offlineAuthExpiresAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
    });

    const snapshot = {
      tenantId: TENANT_ID,
      branchId: BRANCH_1,
      currencyCode: 'LKR',
      syncedAt: new Date().toISOString(),
      globalPrices: [
        {
          productId: PROD_SOAP,
          sku: 'SOAP-01',
          name: 'Herbal Soap 100g',
          categoryId: null,
          baseUom: 'PCS',
          priceUom: 'PCS',
          purchaseCost: '100.0000',
          sellingPrice: '150.0000',
          minSellingPrice: '130.0000',
          maxDiscountPct: '10.00',
          valuationMethod: 'FIFO' as const,
          trackingMode: 'BATCH_EXPIRY' as const,
          allocationPolicy: 'FEFO' as const,
          requireBatchSellingPrice: false,
          productQtyMode: 'STANDARD' as const,
          measurementCategory: null,
          allowedSellingUoms: ['PCS'],
          qtyDecimalPrecision: 0,
          taxGroupId: null,
          trackInventory: true,
          primaryBarcode: '4790001001001',
          syncVersion: 1,
        },
      ],
      branchOverrides: [],
      batches: [
        {
          batchId: BATCH_EXP,
          productId: PROD_SOAP,
          branchId: BRANCH_1,
          warehouseId: WH_1,
          batchNumber: 'B-EXPIRED',
          internalBarcode: 'NB-EXP',
          expiryDate: '2025-01-01',
          receivedDate: '2024-11-01',
          availableQuantity: '2.000000',
          unitCost: '95.0000',
          sellingPrice: '150.0000',
          minSellingPrice: null,
          maxDiscountPct: null,
          batchPricingMode: 'EXPLICIT' as const,
          status: 'ACTIVE' as const,
        },
        {
          batchId: BATCH_SOON,
          productId: PROD_SOAP,
          branchId: BRANCH_1,
          warehouseId: WH_1,
          batchNumber: 'B-FEFO-1',
          internalBarcode: 'NB-SOON',
          expiryDate: '2026-12-05',
          receivedDate: '2026-10-01',
          availableQuantity: '5.000000',
          unitCost: '100.0000',
          sellingPrice: '150.0000',
          minSellingPrice: null,
          maxDiscountPct: null,
          batchPricingMode: 'EXPLICIT' as const,
          status: 'ACTIVE' as const,
        },
        {
          batchId: BATCH_OK,
          productId: PROD_SOAP,
          branchId: BRANCH_1,
          warehouseId: WH_1,
          batchNumber: 'B-FEFO-2',
          internalBarcode: 'NB-OK',
          expiryDate: '2028-06-30',
          receivedDate: '2026-11-01',
          availableQuantity: '10.000000',
          unitCost: '110.0000',
          sellingPrice: '150.0000',
          minSellingPrice: null,
          maxDiscountPct: null,
          batchPricingMode: 'EXPLICIT' as const,
          status: 'ACTIVE' as const,
        },
      ],
      categories: [],
      barcodes: [],
      unitConversions: [],
      taxGroups: [],
      taxRates: [],
      customers: [],
      branches: [
        {
          id: BRANCH_1,
          code: 'CMB-01',
          name: 'Colombo Main',
          isMainBranch: true,
          isActive: true,
          defaultWarehouseId: WH_1,
        },
      ],
      warehouses: [
        {
          id: WH_1,
          branchId: BRANCH_1,
          code: 'WH-CMB',
          name: 'Colombo Warehouse',
          allowNegativeStock: false,
          isActive: true,
        },
      ],
      registers: [
        {
          id: REG_1,
          branchId: BRANCH_1,
          warehouseId: WH_1,
          code: 'REG-01',
          name: 'POS 1',
          isActive: true,
        },
      ],
      balances: [
        {
          branchId: BRANCH_1,
          warehouseId: WH_1,
          productId: PROD_SOAP,
          qtyOnHand: '17.000000',
          qtyReserved: '0.000000',
          availableQty: '17.000000',
          movingAvgCost: '104.0000',
        },
      ],
      serials: [
        {
          id: SERIAL_1,
          productId: PROD_SOAP,
          warehouseId: WH_1,
          branchId: BRANCH_1,
          batchId: null,
          serialNumber: 'SN-SOAP-0001',
          status: 'IN_STOCK',
          unitCost: '100.0000',
        },
      ],
    };

    await pos.ingestServerSnapshot({ tenantId: TENANT_ID, branchId: BRANCH_1, snapshot });
    return { db, storage, pos, inventory, snapshot };
  }

  it('supports offline stock adjustments, FEFO batch expiry blocking, serial ops, and transfer requests without mutating stock for transfers', async () => {
    const { inventory, storage } = await createSeededSuite();

    // 1. Expiry alerts distinguish EXPIRED vs EXPIRING_SOON
    const alerts = await inventory.getExpiryAlerts({
      tenantId: TENANT_ID,
      branchId: BRANCH_1,
      warehouseId: WH_1,
      withinDays: 30,
      isOnline: false,
      nowDateStr: '2026-11-20',
    });
    expect(alerts.map((a) => `${a.batchNumber}:${a.alertLevel}`)).toEqual([
      'B-EXPIRED:EXPIRED',
      'B-FEFO-1:EXPIRING_SOON',
    ]);

    // 2. FEFO plan skips expired batch and allocates earliest non-expired first
    const plan = await inventory.allocateFefoBatches({
      tenantId: TENANT_ID,
      branchId: BRANCH_1,
      warehouseId: WH_1,
      productId: PROD_SOAP,
      requestedQty: '8.000000',
      isOnline: false,
      nowDateStr: '2026-11-20',
    });
    expect(plan).toEqual([
      { batchId: BATCH_SOON, batchNumber: 'B-FEFO-1', allocatedQty: '5.000000', expiryDate: '2026-12-05' },
      { batchId: BATCH_OK, batchNumber: 'B-FEFO-2', allocatedQty: '3.000000', expiryDate: '2028-06-30' },
    ]);

    // 3. Reject deduction from expired batch
    await expect(
      inventory.recordStockAdjustment({
        tenantId: TENANT_ID,
        branchId: BRANCH_1,
        input: {
          warehouseId: WH_1,
          productId: PROD_SOAP,
          batchId: BATCH_EXP,
          movementType: 'ADJUSTMENT_NEGATIVE',
          quantity: '1.000000',
          reason: 'Expired check',
          isOnline: false,
        },
      }),
    ).rejects.toThrow(/expired/i);

    // 4. Valid negative stock adjustment updates local projection ONLY and queues INV_RECORD_ADJUSTMENT
    const adj = await inventory.recordStockAdjustment({
      tenantId: TENANT_ID,
      branchId: BRANCH_1,
      input: {
        warehouseId: WH_1,
        productId: PROD_SOAP,
        batchId: BATCH_OK,
        movementType: 'ADJUSTMENT_NEGATIVE',
        quantity: '2.000000',
        reason: 'Damaged shelf unit',
        isOnline: false,
      },
    });
    expect(adj.newProjectedBalance).toBe('15.000000');

    const prod = storage.getProductById({
      tenantId: TENANT_ID,
      branchId: BRANCH_1,
      warehouseId: WH_1,
      productId: PROD_SOAP,
    });
    expect(prod?.serverQuantity).toBe('17.000000');
    expect(prod?.localPendingDelta).toBe('-2.000000');

    // 5. Offline serial lookup & status op
    const serials = await inventory.listSerials({
      tenantId: TENANT_ID,
      branchId: BRANCH_1,
      serialNumber: 'SN-SOAP',
      isOnline: false,
    });
    expect(serials).toHaveLength(1);
    await inventory.performSerialOperation({
      tenantId: TENANT_ID,
      branchId: BRANCH_1,
      warehouseId: WH_1,
      input: {
        serialId: SERIAL_1,
        toStatus: 'DAMAGED',
        reason: 'Dropped box',
        isOnline: false,
      },
    });

    // 6. Offline Transfer Request stays TRANSFER_REQUEST_PENDING and NEVER changes stock balance!
    const trfRes = await inventory.createTransferRequest({
      tenantId: TENANT_ID,
      branchId: BRANCH_1,
      input: {
        sourceWarehouseId: WH_1,
        destinationBranchId: BRANCH_2,
        notes: 'Need units in Kandy branch',
        lines: [{ productId: PROD_SOAP, quantity: '4.000000', batchId: BATCH_OK }],
        isOnline: false,
      },
    });
    expect(trfRes.transfer.status).toBe('TRANSFER_REQUEST_PENDING');
    const prodAfterTrf = storage.getProductById({
      tenantId: TENANT_ID,
      branchId: BRANCH_1,
      warehouseId: WH_1,
      productId: PROD_SOAP,
    });
    expect(prodAfterTrf?.availableQuantity).toBe('15.000000');

    const history = await inventory.listInventoryHistory({
      tenantId: TENANT_ID,
      branchId: BRANCH_1,
      isOnline: false,
    });
    expect(history).toHaveLength(2);
    expect(history.every((h) => h.syncState === 'PENDING_SYNC')).toBe(true);
  });

  it('recovers interrupted IN_FLIGHT outbox, handles push retry backoff, resolves quarantined oversell conflicts, and verifies backup checksum + revocation', async () => {
    const { db, storage, pos, snapshot } = await createSeededSuite();

    // Record 2 offline cash sales
    const sale1 = await pos.recordOfflineCashSale({
      tenantId: TENANT_ID,
      branchId: BRANCH_1,
      warehouseId: WH_1,
      currencyCode: 'LKR',
      input: {
        registerId: REG_1,
        shiftId: SHIFT_1,
        lines: [{ productId: PROD_SOAP, quantity: '3.000000', batchId: BATCH_OK }],
        paymentMethod: 'CASH',
        tenderedAmount: '500.0000',
        isOnline: false,
      },
    });

    const sale2 = await pos.recordOfflineCashSale({
      tenantId: TENANT_ID,
      branchId: BRANCH_1,
      warehouseId: WH_1,
      currencyCode: 'LKR',
      input: {
        registerId: REG_1,
        shiftId: SHIFT_1,
        lines: [{ productId: PROD_SOAP, quantity: '6.000000', batchId: BATCH_OK }],
        paymentMethod: 'CASH',
        tenderedAmount: '1000.0000',
        isOnline: false,
      },
    });

    // Simulate crash leaving sale1 command IN_FLIGHT
    db.prepare(`UPDATE local_sync_outbox SET status = 'IN_FLIGHT' WHERE command_id = ?`).run(
      sale1.outboxCommandId,
    );

    let failOnce = true;
    const fakeConflictId = randomUUID();
    const transport: OfflineSyncTransportPort = {
      async pushBatch(req) {
        if (failOnce) {
          failOnce = false;
          throw new Error('503 Gateway Timeout');
        }
        return {
          receipts: req.commands.map((c) =>
            c.commandId === sale1.outboxCommandId
              ? {
                  commandId: c.commandId,
                  localSeq: c.localSeq,
                  status: 'APPLIED' as const,
                  serverReferenceId: randomUUID(),
                  serverReferenceNumber: 'INV-SRV-9001',
                  serverProcessedAt: new Date().toISOString(),
                }
              : {
                  commandId: c.commandId,
                  localSeq: c.localSeq,
                  status: 'QUARANTINED' as const,
                  conflictId: fakeConflictId,
                  conflictCode: 'INSUFFICIENT_STOCK_CONFLICT',
                  errorMessage: 'Available stock (3) is less than requested (6)',
                  serverDetails: { availableQty: '3.000000', requestedQty: '6.000000' },
                  serverProcessedAt: new Date().toISOString(),
                },
          ),
        };
      },
      async pullDelta() {
        return {
          serverTimestamp: new Date().toISOString(),
          deviceAuthorized: true,
          revokedReason: null,
          openConflictsCount: 1,
          openConflicts: [],
          recentConfirmedCommands: [],
          snapshot,
        };
      },
      async resolveConflict(conflictId, input) {
        const srvInvId = randomUUID();
        return {
          conflict: {
            id: conflictId,
            tenantId: TENANT_ID,
            branchId: BRANCH_1,
            deviceId: DEVICE_ID,
            commandId: sale2.outboxCommandId,
            commandType: 'POS_RECORD_SALE',
            conflictType: 'INSUFFICIENT_STOCK_CONFLICT',
            status: 'RESOLVED',
            details: {},
            originalPayload: {},
            resolutionAction: input.action,
            resolutionNotes: input.notes ?? null,
            resolvedByUserId: USER_ID,
            createdAt: new Date().toISOString(),
            resolvedAt: new Date().toISOString(),
          },
          replayedReferenceId: srvInvId,
          replayedReferenceNumber: 'INV-SRV-9002',
        };
      },
    };

    const syncEngine = new OfflineSyncEngine(storage, transport);
    expect(computeExponentialBackoffMs(0)).toBe(2000);
    expect(computeExponentialBackoffMs(2)).toBe(8000);

    // First sync attempt fails transiently & recovers IN_FLIGHT
    const attempt1 = await syncEngine.syncNow();
    expect(attempt1.recoveredInFlightCount).toBe(1);
    expect(attempt1.failedCount).toBe(2);
    expect(attempt1.status.connectionState).toBe('SYNC_FAILED');

    // Second sync succeeds for sale1 and quarantines sale2 without losing sale2 invoice/payment!
    const attempt2 = await syncEngine.syncNow();
    expect(attempt2.appliedCount).toBe(1);
    expect(attempt2.quarantinedCount).toBe(1);
    expect(attempt2.status.connectionState).toBe('CONFLICT');

    const localInvoices = storage.listLocalInvoices({ tenantId: TENANT_ID, branchId: BRANCH_1 });
    expect(localInvoices.find((i) => i.invoiceId === sale1.invoice.invoiceId)?.syncState).toBe('SERVER_CONFIRMED');
    expect(localInvoices.find((i) => i.invoiceId === sale2.invoice.invoiceId)?.syncState).toBe('QUARANTINED');

    // Export checksummed recovery backup & verify tamper detection + idempotent restore
    const backup = await syncEngine.exportBackup();
    expect(backup.localInvoices).toHaveLength(2);
    expect(storage.checkDatabaseIntegrity().ok).toBe(true);

    await expect(
      syncEngine.restoreBackup({ ...backup, tenantId: FOREIGN_TENANT, checksumSha256: 'bad' }),
    ).rejects.toThrow(/checksum/i);

    const restoreSame = await syncEngine.restoreBackup(backup);
    expect(restoreSame.restoredOutboxCount).toBe(0);

    // Resolve quarantined sale2 conflict online
    await syncEngine.resolveConflict({
      conflictId: fakeConflictId,
      input: { action: 'ACCEPT_WITH_STOCK_OVERRIDE', notes: 'Manager verified shelf recount' },
    });
    const resolvedInvoices = storage.listLocalInvoices({ tenantId: TENANT_ID, branchId: BRANCH_1 });
    expect(resolvedInvoices.find((i) => i.invoiceId === sale2.invoice.invoiceId)?.syncState).toBe('SERVER_CONFIRMED');

    // Device revocation locks new checkouts while preserving local records
    storage.updateDeviceSecurityState({
      tenantId: TENANT_ID,
      deviceId: DEVICE_ID,
      status: 'REVOKED',
      revokedReason: 'Terminal stolen',
    });
    await expect(
      pos.recordOfflineCashSale({
        tenantId: TENANT_ID,
        branchId: BRANCH_1,
        warehouseId: WH_1,
        currencyCode: 'LKR',
        input: {
          registerId: REG_1,
          shiftId: SHIFT_1,
          lines: [{ productId: PROD_SOAP, quantity: '1.000000', batchId: BATCH_OK }],
          paymentMethod: 'CASH',
          tenderedAmount: '200.0000',
          isOnline: false,
        },
      }),
    ).rejects.toThrow(/revoked/i);
    expect(storage.listLocalInvoices({ tenantId: TENANT_ID, branchId: BRANCH_1 })).toHaveLength(2);

    db.close();
  });
});

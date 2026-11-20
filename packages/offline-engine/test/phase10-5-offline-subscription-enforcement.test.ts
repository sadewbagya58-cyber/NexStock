import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  OfflineInventoryEngine,
  OfflinePosEngine,
  SqliteOfflineStorageAdapter,
} from '../src/index.js';

describe('@nexstock/offline-engine — Phase 10.5 Offline Subscription & Read-Only Mode Enforcement', () => {
  const TENANT_ID = '0192b800-1111-7000-8000-000000000010';
  const BRANCH_1 = '0192b800-1111-7000-8000-000000000031';
  const WH_1 = '0192b800-1111-7000-8000-000000000041';
  const REG_1 = '0192b800-1111-7000-8000-000000000051';
  const SHIFT_1 = '0192b800-1111-7000-8000-000000000061';
  const USER_ID = '0192b800-1111-7000-8000-000000000071';
  const DEVICE_ID = '0192b800-1111-7000-8000-000000000081';
  const PROD_1 = '0192b800-1111-7000-8000-000000000301';

  async function setupEngineWithSub(sub: {
    planCode: string;
    status: string;
    gracePeriodEndsAt?: string | null;
    features?: Record<string, boolean>;
  }) {
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
      permissions: ['pos:sale:create', 'pos:sale:read', 'inv:movement:post', 'pos:shift:open'],
      allLocationsAccess: false,
      allowedBranchIds: [BRANCH_1],
      clientPlatform: 'TAURI_DESKTOP',
      enrolledAt: new Date().toISOString(),
      offlineAuthExpiresAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
      subscriptionSnapshot: {
        planCode: sub.planCode,
        planName: sub.planCode === 'STARTER' ? 'Starter' : 'Professional',
        status: sub.status as 'ACTIVE',
        isReadOnly: sub.status === 'READ_ONLY' || sub.status === 'EXPIRED' || sub.status === 'SUSPENDED',
        inGracePeriod: sub.status === 'GRACE_PERIOD',
        gracePeriodEndsAt: sub.gracePeriodEndsAt ?? null,
        offlineEntitled: sub.planCode !== 'STARTER',
        limits: {
          maxBranches: 5,
          maxUsers: 15,
          maxProducts: 25000,
          maxStorageMb: 51200,
        },
        features: {
          desktopOfflinePos: sub.planCode !== 'STARTER',
          mobileOfflinePos: sub.planCode !== 'STARTER',
          offlineInventory: sub.planCode !== 'STARTER',
          ...(sub.features ?? {}),
        },
        evaluatedAt: new Date().toISOString(),
      },
    });

    await pos.ingestServerSnapshot({
      tenantId: TENANT_ID,
      branchId: BRANCH_1,
      snapshot: {
        tenantId: TENANT_ID,
        branchId: BRANCH_1,
        currencyCode: 'LKR',
        syncedAt: new Date().toISOString(),
        globalPrices: [
          {
            productId: PROD_1,
            sku: 'TEA-01',
            name: 'Ceylon Black Tea',
            categoryId: null,
            baseUom: 'PCS',
            priceUom: 'PCS',
            purchaseCost: '200.0000',
            sellingPrice: '300.0000',
            minSellingPrice: '250.0000',
            maxDiscountPct: '10.00',
            valuationMethod: 'FIFO',
            trackingMode: 'NONE',
            allocationPolicy: 'FEFO',
            requireBatchSellingPrice: false,
            productQtyMode: 'STANDARD',
            measurementCategory: null,
            allowedSellingUoms: ['PCS'],
            qtyDecimalPrecision: 0,
            taxGroupId: null,
            trackInventory: true,
            primaryBarcode: '479100000101',
            syncVersion: 1,
          },
        ],
        branchOverrides: [],
        batches: [],
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
            name: 'Counter 1',
            isActive: true,
          },
        ],
        balances: [
          {
            branchId: BRANCH_1,
            warehouseId: WH_1,
            productId: PROD_1,
            qtyOnHand: '25.000000',
            qtyReserved: '0.000000',
            availableQty: '25.000000',
            movingAvgCost: '200.0000',
          },
        ],
        serials: [],
      },
    });

    return { storage, pos, inventory };
  }

  it('allows offline POS & inventory mutations on ACTIVE PROFESSIONAL plan and preserves local transactions if transitioned to READ_ONLY', async () => {
    const { storage, pos, inventory } = await setupEngineWithSub({
      planCode: 'PROFESSIONAL',
      status: 'ACTIVE',
    });

    const sale = await pos.recordOfflineCashSale({
      tenantId: TENANT_ID,
      branchId: BRANCH_1,
      warehouseId: WH_1,
      currencyCode: 'LKR',
      input: {
        registerId: REG_1,
        shiftId: SHIFT_1,
        lines: [{ productId: PROD_1, quantity: '2' }],
        paymentMethod: 'CASH',
        tenderedAmount: '1000.00',
        isOnline: false,
      },
    });
    expect(sale.syncState).toBe('PENDING_SYNC');

    // Update cached subscription snapshot to READ_ONLY (simulating synced server expiration after offline shift)
    const ctx = storage.getDeviceContext();
    storage.saveDeviceContext({
      ...ctx!,
      subscriptionSnapshot: {
        ...ctx!.subscriptionSnapshot!,
        status: 'READ_ONLY',
        isReadOnly: true,
      },
    });

    // Existing unsynced local sales remain intact in SQLite!
    const recoveredBefore = await pos.recoverSessionState({
      tenantId: TENANT_ID,
      branchId: BRANCH_1,
      userId: USER_ID,
      isOnline: false,
    });
    expect(recoveredBefore.localInvoices).toHaveLength(1);

    // New offline POS sale and offline stock adjustment MUST now fail cleanly
    await expect(
      pos.recordOfflineCashSale({
        tenantId: TENANT_ID,
        branchId: BRANCH_1,
        warehouseId: WH_1,
        currencyCode: 'LKR',
        input: {
          registerId: REG_1,
          shiftId: SHIFT_1,
          lines: [{ productId: PROD_1, quantity: '1' }],
          paymentMethod: 'CASH',
          tenderedAmount: '500.00',
          isOnline: false,
        },
      }),
    ).rejects.toThrow(/Read-Only Mode|expired/i);

    await expect(
      inventory.recordStockAdjustment({
        tenantId: TENANT_ID,
        branchId: BRANCH_1,
        input: {
          warehouseId: WH_1,
          productId: PROD_1,
          movementType: 'ADJUSTMENT_NEGATIVE',
          quantity: '1.000000',
          reason: 'Should be blocked in read-only',
          isOnline: false,
        },
      }),
    ).rejects.toThrow(/Read-Only Mode|expired/i);

    // Existing local invoices remain untouched (zero silent deletion)
    const recoveredAfter = await pos.recoverSessionState({
      tenantId: TENANT_ID,
      branchId: BRANCH_1,
      userId: USER_ID,
      isOnline: false,
    });
    expect(recoveredAfter.localInvoices).toHaveLength(1);
    expect(recoveredAfter.localInvoices[0]!.invoiceNumber).toBe(
      recoveredBefore.localInvoices[0]!.invoiceNumber,
    );
  });

  it('blocks offline Desktop/Inventory operations on STARTER plan when offline features are disabled', async () => {
    const { pos, inventory } = await setupEngineWithSub({
      planCode: 'STARTER',
      status: 'ACTIVE',
      features: {
        desktopOfflinePos: false,
        mobileOfflinePos: false,
        offlineInventory: false,
      },
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
          lines: [{ productId: PROD_1, quantity: '1' }],
          paymentMethod: 'CASH',
          tenderedAmount: '500.00',
          isOnline: false,
        },
      }),
    ).rejects.toThrow(/Professional|Offline POS/i);

    await expect(
      inventory.recordStockAdjustment({
        tenantId: TENANT_ID,
        branchId: BRANCH_1,
        input: {
          warehouseId: WH_1,
          productId: PROD_1,
          movementType: 'ADJUSTMENT_POSITIVE',
          quantity: '1.000000',
          reason: 'Starter plan test',
          isOnline: false,
        },
      }),
    ).rejects.toThrow(/Professional|Offline Inventory/i);
  });
});

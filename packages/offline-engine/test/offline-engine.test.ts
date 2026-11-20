import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  OfflineEngineError,
  OfflinePosEngine,
  SqliteOfflineStorageAdapter,
  getOperationCapability,
} from '../src/index.js';

describe('@nexstock/offline-engine — Phase 9.1 & 9.2 Shared Cross-Platform Foundation', () => {
  const TENANT_ID = '0192b600-1111-7000-8000-000000000010';
  const FOREIGN_TENANT = '0192b600-2222-7000-8000-000000000020';
  const BRANCH_1 = '0192b600-1111-7000-8000-000000000031';
  const BRANCH_2 = '0192b600-1111-7000-8000-000000000032';
  const WH_1 = '0192b600-1111-7000-8000-000000000041';
  const REG_1 = '0192b600-1111-7000-8000-000000000051';
  const SHIFT_1 = '0192b600-1111-7000-8000-000000000061';
  const USER_ID = '0192b600-1111-7000-8000-000000000071';
  const DEVICE_ID = '0192b600-1111-7000-8000-000000000081';

  const CAT_DAIRY = '0192b600-1111-7000-8000-000000000101';
  const TAX_GRP_STD = '0192b600-1111-7000-8000-000000000201';
  const TAX_RATE_VAT = '0192b600-1111-7000-8000-000000000202';
  const PROD_MILK = '0192b600-1111-7000-8000-000000000301';
  const BATCH_EXP = '0192b600-1111-7000-8000-000000000401';
  const BATCH_FEFO_1 = '0192b600-1111-7000-8000-000000000402';
  const BATCH_FEFO_2 = '0192b600-1111-7000-8000-000000000403';
  const CUST_1 = '0192b600-1111-7000-8000-000000000501';

  function createSeededEngine(sqlitePath = ':memory:') {
    const db = new DatabaseSync(sqlitePath);
    const storage = new SqliteOfflineStorageAdapter(db, 'TAURI_DESKTOP');
    const engine = new OfflinePosEngine(storage, 'LKR');
    return { db, storage, engine };
  }

  async function seedStandardSnapshot(engine: OfflinePosEngine) {
    await engine.bindDeviceSession({
      deviceId: DEVICE_ID,
      tenantId: TENANT_ID,
      branchId: BRANCH_1,
      branchCode: 'CMB-01',
      branchName: 'Colombo Main',
      warehouseId: WH_1,
      registerId: REG_1,
      actorUserId: USER_ID,
      roleCodes: ['CASHIER'],
      permissions: ['pos:sale:create', 'pos:sale:read'],
      allLocationsAccess: false,
      allowedBranchIds: [BRANCH_1],
      clientPlatform: 'TAURI_DESKTOP',
      enrolledAt: new Date().toISOString(),
      offlineAuthExpiresAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
    });

    await engine.ingestServerSnapshot({
      tenantId: TENANT_ID,
      branchId: BRANCH_1,
      snapshot: {
        tenantId: TENANT_ID,
        branchId: BRANCH_1,
        currencyCode: 'LKR',
        syncedAt: new Date().toISOString(),
        globalPrices: [
          {
            productId: PROD_MILK,
            sku: 'MILK-1L',
            name: 'Fresh Milk 1L',
            categoryId: CAT_DAIRY,
            baseUom: 'PCS',
            priceUom: 'PCS',
            purchaseCost: '220.0000',
            sellingPrice: '300.0000',
            minSellingPrice: '280.0000',
            maxDiscountPct: '10.00',
            valuationMethod: 'FIFO',
            trackingMode: 'BATCH_EXPIRY',
            allocationPolicy: 'FEFO',
            requireBatchSellingPrice: true,
            productQtyMode: 'STANDARD',
            measurementCategory: null,
            allowedSellingUoms: ['PCS'],
            qtyDecimalPrecision: 0,
            taxGroupId: TAX_GRP_STD,
            trackInventory: true,
            primaryBarcode: '4791234567890',
            syncVersion: 1,
          },
        ],
        branchOverrides: [
          {
            id: randomUUID(),
            tenantId: TENANT_ID,
            productId: PROD_MILK,
            productName: 'Fresh Milk 1L',
            sku: 'MILK-1L',
            branchId: BRANCH_1,
            branchName: 'Colombo Main',
            globalSellingPrice: '300.0000',
            sellingPrice: '310.0000',
            pricingMethod: 'PROFIT_MARGIN',
            targetPercentage: '30.00',
            roundingRule: 'NONE',
            minSellingPrice: '285.0000',
            maxDiscountPct: '10.00',
            effectiveDate: '2026-01-01',
            isActive: true,
            needsReview: false,
            reviewReason: null,
            approvedAt: new Date().toISOString(),
            syncVersion: 1,
          },
        ],
        batches: [
          {
            batchId: BATCH_EXP,
            productId: PROD_MILK,
            branchId: BRANCH_1,
            warehouseId: WH_1,
            batchNumber: 'MILK-OLD-EXP',
            internalBarcode: 'NB-MILKOLD',
            expiryDate: '2025-01-01',
            receivedDate: '2024-12-01',
            availableQuantity: '4.000000',
            unitCost: '200.0000',
            sellingPrice: '310.0000',
            minSellingPrice: null,
            maxDiscountPct: null,
            batchPricingMode: 'EXPLICIT',
            status: 'ACTIVE',
          },
          {
            batchId: BATCH_FEFO_1,
            productId: PROD_MILK,
            branchId: BRANCH_1,
            warehouseId: WH_1,
            batchNumber: 'MILK-B1',
            internalBarcode: 'NB-MILKB1',
            expiryDate: '2027-06-30',
            receivedDate: '2026-06-01',
            availableQuantity: '10.000000',
            unitCost: '220.0000',
            sellingPrice: '320.0000',
            minSellingPrice: null,
            maxDiscountPct: null,
            batchPricingMode: 'EXPLICIT',
            status: 'ACTIVE',
          },
          {
            batchId: BATCH_FEFO_2,
            productId: PROD_MILK,
            branchId: BRANCH_1,
            warehouseId: WH_1,
            batchNumber: 'MILK-B2',
            internalBarcode: 'NB-MILKB2',
            expiryDate: '2028-12-31',
            receivedDate: '2026-07-01',
            availableQuantity: '12.000000',
            unitCost: '230.0000',
            sellingPrice: '350.0000',
            minSellingPrice: null,
            maxDiscountPct: null,
            batchPricingMode: 'EXPLICIT',
            status: 'ACTIVE',
          },
        ],
        categories: [
          { id: CAT_DAIRY, parentId: null, name: 'Dairy', status: 'ACTIVE', syncVersion: 1 },
        ],
        barcodes: [
          {
            id: randomUUID(),
            productId: PROD_MILK,
            barcode: '4791234567890',
            barcodeType: 'EAN13',
            uomCode: 'PCS',
            isPrimary: true,
          },
        ],
        taxGroups: [{ id: TAX_GRP_STD, code: 'VAT10', name: 'VAT 10%', isActive: true }],
        taxRates: [
          {
            id: TAX_RATE_VAT,
            taxGroupId: TAX_GRP_STD,
            code: 'VAT',
            name: 'VAT',
            ratePercentage: '10.0000',
            isCompound: false,
            priority: 1,
            isActive: true,
          },
        ],
        customers: [
          {
            id: CUST_1,
            customerNumber: 'CUS-001',
            name: 'Kamal Silva',
            phone: '+94771234567',
            email: 'kamal@test.lk',
            status: 'ACTIVE',
          },
        ],
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
            code: 'WH-CMB-01',
            name: 'CMB Main WH',
            allowNegativeStock: false,
            isActive: true,
          },
        ],
        registers: [
          {
            id: REG_1,
            branchId: BRANCH_1,
            warehouseId: WH_1,
            code: 'REG-CMB-01',
            name: 'Counter 1',
            isActive: true,
          },
        ],
        balances: [
          {
            branchId: BRANCH_1,
            warehouseId: WH_1,
            productId: PROD_MILK,
            qtyOnHand: '22.000000',
            qtyReserved: '0.000000',
            availableQty: '22.000000',
            movingAvgCost: '220.0000',
          },
        ],
      },
    });
  }

  it('1. Enforces capability separation, tenant isolation, branch restrictions, and blocks online-only payments offline', async () => {
    expect(getOperationCapability('POS_CASH_CHECKOUT')).toBe('OFFLINE_CAPABLE');
    expect(getOperationCapability('POS_CARD_GATEWAY')).toBe('ONLINE_ONLY');
    expect(getOperationCapability('POS_CREDIT_CHECKOUT')).toBe('ONLINE_ONLY');
    expect(getOperationCapability('PRICING_APPROVAL')).toBe('ONLINE_ONLY');

    const { db, engine } = createSeededEngine();
    await seedStandardSnapshot(engine);

    // Cross-tenant rejected
    await expect(
      engine.searchProducts({
        tenantId: FOREIGN_TENANT,
        branchId: BRANCH_1,
        warehouseId: WH_1,
        isOnline: false,
      }),
    ).rejects.toThrow(OfflineEngineError);

    // Unauthorized branch rejected
    await expect(
      engine.searchProducts({
        tenantId: TENANT_ID,
        branchId: BRANCH_2,
        warehouseId: WH_1,
        isOnline: false,
      }),
    ).rejects.toMatchObject({ code: 'OFFLINE_BRANCH_SCOPE_DENIED' });

    // Card gateway & Credit rejected while offline
    await expect(
      engine.recordOfflineCashSale({
        tenantId: TENANT_ID,
        branchId: BRANCH_1,
        warehouseId: WH_1,
        currencyCode: 'LKR',
        input: {
          registerId: REG_1,
          shiftId: SHIFT_1,
          lines: [{ productId: PROD_MILK, quantity: '1' }],
          paymentMethod: 'CARD',
          tenderedAmount: '352.00',
          isOnline: false,
        },
      }),
    ).rejects.toMatchObject({ code: 'OFFLINE_ONLINE_ONLY_BLOCKED' });

    db.close();
  });

  it('2. Performs offline search, FEFO + internal barcode resolution, tax calculation, Option A stock projection, and file restart recovery', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexstock-offline-'));
    const dbFile = path.join(tmpDir, 'desktop-offline.sqlite3');

    try {
      const { db, engine } = createSeededEngine(dbFile);
      await seedStandardSnapshot(engine);

      // Freshness check
      const freshness = await engine.getDataFreshness({
        tenantId: TENANT_ID,
        branchId: BRANCH_1,
        isOnline: false,
      });
      expect(freshness.isStale).toBe(false);
      expect(freshness.counts.products).toBe(1);
      expect(freshness.counts.customers).toBe(1);
      expect(freshness.counts.batches).toBe(3);

      // Expired internal barcode blocked
      const expScan = await engine.scanBarcode({
        tenantId: TENANT_ID,
        branchId: BRANCH_1,
        warehouseId: WH_1,
        code: 'NB-MILKOLD',
        isOnline: false,
      });
      expect(expScan.isBlocked).toBe(true);
      expect(expScan.blockReason).toBe('BATCH_EXPIRED');

      // Manufacturer EAN picks earliest non-expired FEFO batch (MILK-B1 @ 320.0000)
      const fefoScan = await engine.scanBarcode({
        tenantId: TENANT_ID,
        branchId: BRANCH_1,
        warehouseId: WH_1,
        code: '4791234567890',
        isOnline: false,
      });
      expect(fefoScan.batchId).toBe(BATCH_FEFO_1);
      expect(fefoScan.sellingPrice).toBe('320.0000');

      // Save an unfinished draft cart, then close DB to simulate crash/restart
      await engine.saveDraftCart({
        tenantId: TENANT_ID,
        branchId: BRANCH_1,
        userId: USER_ID,
        registerId: REG_1,
        customerId: CUST_1,
        customerName: 'Kamal Silva',
        lines: [{ productId: PROD_MILK, quantity: '2', batchId: BATCH_FEFO_2 }],
        isOnline: false,
      });
      db.close();

      // Reopen DB from disk (restart simulation) & recover unfinished draft cart
      const reopened = createSeededEngine(dbFile);
      const recovered1 = await reopened.engine.recoverSessionState({
        tenantId: TENANT_ID,
        branchId: BRANCH_1,
        userId: USER_ID,
        isOnline: false,
      });
      expect(recovered1.draftCart).not.toBeNull();
      expect(recovered1.draftCart!.customerName).toBe('Kamal Silva');
      expect(recovered1.draftCart!.lines).toHaveLength(1);

      // Checkout cash sale offline: 2 x 350.00 = 700.00 + 10% VAT (70.00) = 770.00, tendered 1000 -> change 230.00
      const saleRes = await reopened.engine.recordOfflineCashSale({
        tenantId: TENANT_ID,
        branchId: BRANCH_1,
        warehouseId: WH_1,
        currencyCode: 'LKR',
        input: {
          registerId: REG_1,
          shiftId: SHIFT_1,
          customerId: CUST_1,
          customerName: 'Kamal Silva',
          lines: [{ productId: PROD_MILK, quantity: '2', batchId: BATCH_FEFO_2 }],
          paymentMethod: 'CASH',
          tenderedAmount: '1000.00',
          isOnline: false,
        },
      });
      expect(saleRes.invoice.invoiceNumber.startsWith('OFF-')).toBe(true);
      expect(saleRes.syncState).toBe('PENDING_SYNC');
      expect(saleRes.serverConfirmed).toBe(false);
      expect(saleRes.invoice.subtotalAmount).toBe('700.0000');
      expect(saleRes.invoice.taxAmount).toBe('70.0000');
      expect(saleRes.invoice.grandTotal).toBe('770.0000');
      expect(saleRes.invoice.changeGiven).toBe('230.0000');

      // Option A check: serverQuantity stayed 22.000000 while localPendingDelta became -2.000000 -> availableQuantity 20.000000
      const [prodAfter] = await reopened.engine.searchProducts({
        tenantId: TENANT_ID,
        branchId: BRANCH_1,
        warehouseId: WH_1,
        isOnline: false,
      });
      expect(Number(prodAfter!.serverQuantity)).toBe(22);
      expect(Number(prodAfter!.localPendingDelta)).toBe(-2);
      expect(Number(prodAfter!.availableQuantity)).toBe(20);
      reopened.db.close();

      // Reopen a 3rd time to verify pending invoice & outbox survive restart and draft was cleared
      const thirdBoot = createSeededEngine(dbFile);
      const recovered2 = await thirdBoot.engine.recoverSessionState({
        tenantId: TENANT_ID,
        branchId: BRANCH_1,
        userId: USER_ID,
        isOnline: false,
      });
      expect(recovered2.draftCart).toBeNull();
      expect(recovered2.localInvoices).toHaveLength(1);
      expect(recovered2.localInvoices[0]!.syncState).toBe('PENDING_SYNC');
      expect(recovered2.localInvoices[0]!.serverConfirmed).toBe(false);
      expect(recovered2.pendingOutbox).toHaveLength(1);
      expect(recovered2.pendingOutbox[0]!.commandType).toBe('POS_RECORD_SALE');
      thirdBoot.db.close();
    } finally {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // Ignore transient Windows SQLite WAL handle release delay
      }
    }
  });
});

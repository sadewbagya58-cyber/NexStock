import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MobileOfflinePosRuntime,
  getMobileConnectionBanner,
  parseMobileCameraBarcodeScan,
} from '../src/index.js';

describe('@nexstock/mobile — Phase 9.4 Mobile Offline POS Engine & Camera Scanner', () => {
  it('1. Parses camera barcode scans across GS1-128, NB- internal batch codes, and EAN-13', () => {
    const gs1 = parseMobileCameraBarcodeScan('(01)04791234567893(10)BATCH01(17)281231');
    expect(gs1.isGs1).toBe(true);
    expect(gs1.gtin).toBe('04791234567893');
    expect(gs1.batchLot).toBe('BATCH01');
    expect(gs1.expiryDate).toBe('2028-12-31');

    const internal = parseMobileCameraBarcodeScan('nb-b01abc99');
    expect(internal.isInternalBatchBarcode).toBe(true);
    expect(internal.normalizedCode).toBe('NB-B01ABC99');

    const ean = parseMobileCameraBarcodeScan('8901234567893');
    expect(ean.isGs1).toBe(false);
    expect(ean.normalizedCode).toBe('8901234567893');

    const banner = getMobileConnectionBanner({
      isOnline: false,
      pendingOutboxCount: 3,
      isSyncInFlight: false,
    });
    expect(banner.state).toBe('OFFLINE_LOCAL_QUEUE_ACTIVE');
    expect(banner.pendingOutboxCount).toBe(3);
  });

  it('2. Executes consistent Mobile Offline POS workflow with persistent SQLite restart recovery & Option A stock integrity', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexstock-mobile-'));
    const dbPath = path.join(tmpDir, 'mobile-offline.sqlite3');

    const tenantId = randomUUID();
    const branchId = randomUUID();
    const otherBranchId = randomUUID();
    const whId = randomUUID();
    const regId = randomUUID();
    const userId = randomUUID();
    const prodId = randomUUID();
    const custId = randomUUID();

    try {
      const db1 = new DatabaseSync(dbPath);
      const mobile1 = MobileOfflinePosRuntime.fromSqlite(db1, 'LKR');

      await mobile1.engine.bindDeviceSession({
        deviceId: randomUUID(),
        tenantId,
        branchId,
        branchCode: 'KDY-01',
        branchName: 'Kandy Outlet',
        warehouseId: whId,
        registerId: regId,
        actorUserId: userId,
        roleCodes: ['CASHIER'],
        permissions: ['pos:sale:create', 'pos:sale:read'],
        allLocationsAccess: false,
        allowedBranchIds: [branchId],
        clientPlatform: 'MOBILE_APP',
        enrolledAt: new Date().toISOString(),
        offlineAuthExpiresAt: new Date(Date.now() + 24 * 3600_000).toISOString(),
      });

      await mobile1.engine.ingestServerSnapshot({
        tenantId,
        branchId,
        snapshot: {
          tenantId,
          branchId,
          currencyCode: 'LKR',
          syncedAt: new Date().toISOString(),
          globalPrices: [
            {
              productId: prodId,
              sku: 'MOB-COFFEE',
              name: 'Roast Coffee 250G',
              baseUom: 'PCS',
              priceUom: 'PCS',
              purchaseCost: '650.0000',
              sellingPrice: '950.0000',
              minSellingPrice: '850.0000',
              maxDiscountPct: '10.00',
              trackInventory: true,
              primaryBarcode: '8901234567893',
              syncVersion: 1,
            },
          ],
          branchOverrides: [],
          customers: [
            {
              id: custId,
              customerNumber: 'M-101',
              name: 'Ruwan Bandara',
              phone: '+94712223344',
              email: null,
              status: 'ACTIVE',
            },
          ],
          balances: [
            {
              branchId,
              warehouseId: whId,
              productId: prodId,
              qtyOnHand: '10.000000',
              qtyReserved: '0.000000',
              availableQty: '10.000000',
              movingAvgCost: '650.0000',
            },
          ],
        },
      });

      // Camera scan offline
      const camScan = await mobile1.scanFromCamera({
        tenantId,
        branchId,
        warehouseId: whId,
        rawCameraPayload: '8901234567893',
        isOnline: false,
      });
      expect(camScan.lookup.productId).toBe(prodId);
      expect(camScan.lookup.sellingPrice).toBe('950.0000');

      // Card payment must fail offline
      await expect(
        mobile1.engine.recordOfflineCashSale({
          tenantId,
          branchId,
          warehouseId: whId,
          currencyCode: 'LKR',
          input: {
            registerId: regId,
            shiftId: null,
            lines: [{ productId: prodId, quantity: '1' }],
            paymentMethod: 'CARD',
            tenderedAmount: '950.00',
            isOnline: false,
          },
        }),
      ).rejects.toMatchObject({ code: 'OFFLINE_ONLINE_ONLY_BLOCKED' });

      // Unauthorized branch access rejected
      await expect(
        mobile1.engine.searchProducts({
          tenantId,
          branchId: otherBranchId,
          warehouseId: whId,
          isOnline: false,
        }),
      ).rejects.toMatchObject({ code: 'OFFLINE_BRANCH_SCOPE_DENIED' });

      // Offline cash sale completes locally (1 x 950 = 950)
      const sale = await mobile1.engine.recordOfflineCashSale({
        tenantId,
        branchId,
        warehouseId: whId,
        currencyCode: 'LKR',
        input: {
          registerId: regId,
          shiftId: null,
          customerId: custId,
          customerName: 'Ruwan Bandara',
          lines: [{ productId: prodId, quantity: '1', entrySource: 'BARCODE_SCAN' }],
          paymentMethod: 'CASH',
          tenderedAmount: '1000.00',
          isOnline: false,
        },
      });
      expect(sale.invoice.invoiceNumber.startsWith('OFF-')).toBe(true);
      expect(sale.invoice.changeGiven).toBe('50.0000');
      expect(sale.serverConfirmed).toBe(false);
      db1.close();

      // Reopen database on Mobile after app restart -> pending transaction & Option A stock preserved
      const db2 = new DatabaseSync(dbPath);
      const mobile2 = MobileOfflinePosRuntime.fromSqlite(db2, 'LKR');
      const recovered = await mobile2.engine.recoverSessionState({
        tenantId,
        branchId,
        userId,
        isOnline: false,
      });
      expect(recovered.localInvoices).toHaveLength(1);
      expect(recovered.localInvoices[0]!.syncState).toBe('PENDING_SYNC');
      expect(recovered.localInvoices[0]!.serverConfirmed).toBe(false);
      expect(recovered.pendingOutbox).toHaveLength(1);

      const [prodAfter] = await mobile2.engine.searchProducts({
        tenantId,
        branchId,
        warehouseId: whId,
        isOnline: false,
      });
      expect(Number(prodAfter!.serverQuantity)).toBe(10);
      expect(Number(prodAfter!.availableQuantity)).toBe(9);

      // Phase 9.6 & 9.9 on Mobile: sync status & integrity check after app restart
      const mobSyncStatus = await mobile2.sync.getStatus(tenantId, branchId);
      expect(mobSyncStatus.pendingCount).toBe(1);
      expect((await mobile2.sync.checkIntegrity()).ok).toBe(true);
      db2.close();
    } finally {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // Ignore transient Windows file handle delay
      }
    }
  });
});

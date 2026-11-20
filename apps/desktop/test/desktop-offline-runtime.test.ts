import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DesktopOfflinePosRuntime,
  DesktopOfflineStore,
  getCanonicalSqliteMigrations,
  getDesktopConnectionBanner,
} from '../src/index.js';

describe('@nexstock/desktop — Tauri v2 Offline-First SQLite Runtime & Bridge', () => {
  it('1. Tauri v2 native crate manifests and Rust sources exist and declare all offline IPC commands', () => {
    const tauriRoot = resolve(process.cwd(), 'src-tauri');
    expect(existsSync(resolve(tauriRoot, 'Cargo.toml'))).toBe(true);
    expect(existsSync(resolve(tauriRoot, 'tauri.conf.json'))).toBe(true);
    expect(existsSync(resolve(tauriRoot, 'build.rs'))).toBe(true);
    expect(existsSync(resolve(tauriRoot, 'capabilities/default.json'))).toBe(true);
    expect(existsSync(resolve(tauriRoot, 'src/main.rs'))).toBe(true);
    expect(existsSync(resolve(tauriRoot, 'src/lib.rs'))).toBe(true);
    expect(existsSync(resolve(tauriRoot, 'src/db.rs'))).toBe(true);
    expect(existsSync(resolve(tauriRoot, 'src/commands.rs'))).toBe(true);
    expect(getCanonicalSqliteMigrations()).toHaveLength(9);

    const banner = getDesktopConnectionBanner({
      isOnline: false,
      pendingOutboxCount: 2,
      isSyncInFlight: false,
    });
    expect(banner).toBeTruthy();
  });

  it('2. Bootstraps SQLite 0001..0007, saves sync snapshot, resolves hybrid barcodes offline (FEFO + explicit NB-B lock + expiry block), and queues POS_RECORD_SALE + print job', () => {
    const db = new DatabaseSync(':memory:');
    const store = new DesktopOfflineStore(db);

    const initialStatus = store.getStatus();
    expect(initialStatus.schemaVersion).toBe(9);
    expect(initialStatus.pendingOutboxCount).toBe(0);

    const tenantId = '0192b4d0-1111-7000-8000-000000000010';
    const warehouseId = '0192b4d0-1111-7000-8000-000000000020';
    const branchId = '0192b4d0-1111-7000-8000-000000000030';
    const productId = '0192b4d0-1111-7000-8000-000000000040';
    const batchEarlyId = '0192b4d0-1111-7000-8000-000000000051';
    const batchLateId = '0192b4d0-1111-7000-8000-000000000052';
    const batchExpId = '0192b4d0-1111-7000-8000-000000000053';

    const snap = store.saveSyncSnapshot({
      tenantId,
      branding: { shopDisplayName: 'Lanka Herbals Main', logoUrl: '/uploads/logo.png' },
      policies: { batchPricingFallbackPolicy: 'BLOCK_MISSING', defaultBatchAllocationPolicy: 'FEFO' },
      products: [
        {
          id: productId,
          sku: 'SOAP-100G',
          name: 'Herbal Soap 100G',
          baseUom: 'PCS',
          sellingPrice: '140.0000',
          purchaseCost: '90.0000',
          primaryBarcode: '8901234567893',
        },
      ],
      batches: [
        {
          id: batchEarlyId,
          productId,
          warehouseId,
          branchId,
          batchNumber: 'SOAP-A',
          status: 'ACTIVE',
          availableQuantity: '10.000000',
          sellingPrice: '150.0000',
          unitCost: '100.0000',
          internalBarcode: 'NB-BSOAPA01',
          expiryDate: '2028-06-30',
        },
        {
          id: batchLateId,
          productId,
          warehouseId,
          branchId,
          batchNumber: 'SOAP-B',
          status: 'ACTIVE',
          availableQuantity: '20.000000',
          sellingPrice: '180.0000',
          unitCost: '120.0000',
          internalBarcode: 'NB-BSOAPB02',
          expiryDate: '2029-12-31',
        },
        {
          id: batchExpId,
          productId,
          warehouseId,
          branchId,
          batchNumber: 'SOAP-EXP',
          status: 'ACTIVE',
          availableQuantity: '5.000000',
          sellingPrice: '150.0000',
          unitCost: '100.0000',
          internalBarcode: 'NB-BSOAPEXP',
          expiryDate: '2025-01-01',
        },
      ],
    });
    expect(snap.savedProducts).toBe(1);
    expect(snap.savedBatches).toBe(3);

    // Manufacturer EAN-13 selects earliest valid non-expired FEFO batch (SOAP-A @ 150)
    const eanLookup = store.resolveBarcodeOffline({
      tenantId,
      warehouseId,
      code: '8901234567893',
    });
    expect(eanLookup.matchType).toBe('PRODUCT_BARCODE');
    expect(eanLookup.batchId).toBe(batchEarlyId);
    expect(eanLookup.sellingPrice).toBe('150.0000');

    // Internal batch barcode NB-BSOAPB02 locks explicitly onto SOAP-B @ 180
    const batchLookup = store.resolveBarcodeOffline({
      tenantId,
      warehouseId,
      code: 'NB-BSOAPB02',
    });
    expect(batchLookup.matchType).toBe('INTERNAL_BATCH_BARCODE');
    expect(batchLookup.batchId).toBe(batchLateId);
    expect(batchLookup.sellingPrice).toBe('180.0000');

    // Expired internal batch barcode is blocked
    const expLookup = store.resolveBarcodeOffline({
      tenantId,
      warehouseId,
      code: 'NB-BSOAPEXP',
    });
    expect(expLookup.isBlocked).toBe(true);
    expect(expLookup.blockReason).toBe('POS_BATCH_EXPIRED');

    // Queue offline sale from SOAP-B -> decrements local batch available qty & creates POS_RECORD_SALE outbox cmd
    const queued = store.queueOfflineSale({
      tenantId,
      branchId,
      warehouseId,
      registerId: '0192b4d0-1111-7000-8000-000000000090',
      shiftId: '0192b4d0-1111-7000-8000-000000000091',
      cashierUserId: '0192b4d0-1111-7000-8000-000000000092',
      deviceId: 'tauri-win-01',
      currencyCode: 'LKR',
      grandTotal: '360.0000',
      paymentMethod: 'CASH',
      tenderedAmount: '400.0000',
      lines: [
        {
          productId,
          sku: 'SOAP-100G',
          productName: 'Herbal Soap 100G',
          batchId: batchLateId,
          uomCode: 'PCS',
          quantity: '2.000000',
          unitPrice: '180.0000',
          unitCostSnapshot: '120.0000',
          lineTotal: '360.0000',
          entrySource: 'BARCODE_SCAN',
        },
      ],
    });
    expect(queued.invoiceNumber.startsWith('OFF-')).toBe(true);

    // After decrementing 2 from 20 -> 18 available
    const afterLookup = store.resolveBarcodeOffline({
      tenantId,
      warehouseId,
      code: 'NB-BSOAPB02',
    });
    expect(afterLookup.availableQuantity).toBe('18.000000');

    store.queuePrintJob({
      tenantId,
      branchId,
      productId,
      batchId: batchLateId,
      barcodeValue: 'NB-BSOAPB02',
      labelFormat: 'THERMAL_50X30',
      printQuantity: 4,
      isReprint: false,
      printedByUserId: '0192b4d0-1111-7000-8000-000000000092',
    });

    const st = store.getStatus();
    expect(st.pendingOutboxCount).toBe(1);
    expect(st.queuedPrintJobs).toBe(1);

    const pending = store.getPendingOutboxCommands(tenantId);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.commandType).toBe('POS_RECORD_SALE');

    store.markSyncPushResult({
      ackedCommandIds: [queued.commandId],
      quarantinedCommands: [],
    });
    expect(store.getStatus().pendingOutboxCount).toBe(0);
  });

  it('3. Phase 9.3 Desktop Offline POS workflow: catalog, customers, discounts, taxes, cash checkout & draft recovery', async () => {
    const db = new DatabaseSync(':memory:');
    const runtime = DesktopOfflinePosRuntime.fromSqlite(db, 'LKR');
    const tenantId = randomUUID();
    const branchId = randomUUID();
    const whId = randomUUID();
    const regId = randomUUID();
    const shiftId = randomUUID();
    const userId = randomUUID();
    const prodId = randomUUID();
    const taxGrpId = randomUUID();
    const custId = randomUUID();

    await runtime.engine.bindDeviceSession({
      deviceId: randomUUID(),
      tenantId,
      branchId,
      branchCode: 'CMB-01',
      branchName: 'Colombo Main',
      warehouseId: whId,
      registerId: regId,
      actorUserId: userId,
      roleCodes: ['CASHIER'],
      permissions: ['pos:sale:create', 'pos:sale:read', 'inv:movement:post'],
      allLocationsAccess: false,
      allowedBranchIds: [branchId],
      clientPlatform: 'TAURI_DESKTOP',
      enrolledAt: new Date().toISOString(),
      offlineAuthExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });

    await runtime.engine.ingestServerSnapshot({
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
            sku: 'TEA-500G',
            name: 'Ceylon Tea 500G',
            baseUom: 'PCS',
            priceUom: 'PCS',
            purchaseCost: '400.0000',
            sellingPrice: '500.0000',
            minSellingPrice: '450.0000',
            maxDiscountPct: '10.00',
            taxGroupId: taxGrpId,
            trackInventory: true,
            primaryBarcode: '4790001112223',
            syncVersion: 1,
          },
        ],
        branchOverrides: [],
        taxGroups: [{ id: taxGrpId, code: 'STD', name: 'Standard VAT', isActive: true }],
        taxRates: [
          {
            id: randomUUID(),
            taxGroupId: taxGrpId,
            code: 'VAT',
            name: 'VAT 15%',
            ratePercentage: '15.0000',
            isCompound: false,
            priority: 1,
            isActive: true,
          },
        ],
        customers: [
          {
            id: custId,
            customerNumber: 'C-009',
            name: 'Nimali Perera',
            phone: '+94770001122',
            email: null,
            status: 'ACTIVE',
          },
        ],
        balances: [
          {
            branchId,
            warehouseId: whId,
            productId: prodId,
            qtyOnHand: '15.000000',
            qtyReserved: '0.000000',
            availableQty: '15.000000',
            movingAvgCost: '400.0000',
          },
        ],
      },
    });

    const customers = await runtime.engine.listCustomers({
      tenantId,
      branchId,
      query: 'Nimali',
      isOnline: false,
    });
    expect(customers).toHaveLength(1);

    // Save draft, recover it, then complete cash sale (2 x 500 = 1000 - 50 disc = 950 taxable + 15% VAT (142.50) = 1092.50)
    await runtime.engine.saveDraftCart({
      tenantId,
      branchId,
      userId,
      registerId: regId,
      customerId: custId,
      customerName: 'Nimali Perera',
      lines: [{ productId: prodId, quantity: '2', lineDiscount: '50.00' }],
      isOnline: false,
    });

    const recovered = await runtime.engine.recoverSessionState({
      tenantId,
      branchId,
      userId,
      isOnline: false,
    });
    expect(recovered.draftCart?.lines).toHaveLength(1);

    const sale = await runtime.engine.recordOfflineCashSale({
      tenantId,
      branchId,
      warehouseId: whId,
      currencyCode: 'LKR',
      input: {
        registerId: regId,
        shiftId,
        customerId: custId,
        customerName: 'Nimali Perera',
        lines: [{ productId: prodId, quantity: '2', lineDiscount: '50.00' }],
        paymentMethod: 'CASH',
        tenderedAmount: '1500.00',
        isOnline: false,
      },
    });
    expect(sale.invoice.grandTotal).toBe('1092.5000');
    expect(sale.invoice.changeGiven).toBe('407.5000');
    expect(sale.serverConfirmed).toBe(false);
    expect(sale.syncState).toBe('PENDING_SYNC');

    // Phase 9.5 & 9.9 checks on Desktop runtime: offline inventory adjustment + checksummed backup
    const deskAdj = await runtime.inventory.recordStockAdjustment({
      tenantId,
      branchId,
      input: {
        warehouseId: whId,
        productId: prodId,
        movementType: 'ADJUSTMENT_POSITIVE',
        quantity: '3.000000',
        reason: 'Desktop shelf recount adjustment',
        isOnline: false,
      },
    });
    expect(Number(deskAdj.newProjectedBalance)).toBeGreaterThan(0);
    const deskStatus = await runtime.sync.getStatus(tenantId, branchId);
    expect(deskStatus.pendingCount).toBe(2);
    const deskBackup = await runtime.sync.exportBackup();
    expect(deskBackup.pendingOutbox).toHaveLength(2);
    expect(deskBackup.checksumSha256.length).toBe(64);
    db.close();
  });
});

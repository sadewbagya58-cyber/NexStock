/* global window, navigator, localStorage, crypto, indexedDB, TextEncoder */
/* NexStock Phase 9.1 - 9.9 Browser, Mobile PWA & Tauri IPC Persistent Offline Client */
(function (global) {
  'use strict';

  const DB_NAME = 'nexstock_offline_v1';
  const DB_VERSION = 2;
  const STORES = {
    DEVICE: 'device_context',
    SNAPSHOTS: 'branch_snapshots',
    DRAFTS: 'draft_carts',
    INVOICES: 'local_invoices',
    OUTBOX: 'sync_outbox',
    SHIFTS: 'local_shifts',
    MOVEMENTS: 'local_movements',
    TRANSFERS: 'local_transfers',
    CONFLICTS: 'local_conflicts',
    RECOVERY: 'recovery_meta',
  };

  function detectClientPlatform() {
    if (typeof window !== 'undefined' && (window.__TAURI_INTERNALS__ || window.__TAURI__)) {
      return 'TAURI_DESKTOP';
    }
    if (typeof navigator !== 'undefined' && /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '')) {
      return 'MOBILE_PWA';
    }
    return 'MOBILE_PWA';
  }

  function hasTauriIpc() {
    return Boolean(
      typeof window !== 'undefined' &&
        window.__TAURI_INTERNALS__ &&
        typeof window.__TAURI_INTERNALS__.invoke === 'function',
    );
  }

  async function invokeTauri(cmd, args) {
    if (!hasTauriIpc()) return null;
    try {
      return await window.__TAURI_INTERNALS__.invoke(cmd, args || {});
    } catch {
      return null;
    }
  }

  function getOrCreateDeviceId() {
    const key = 'nexstock_device_id';
    try {
      let existing = localStorage.getItem(key);
      if (!existing) {
        existing = (typeof crypto !== 'undefined' && crypto.randomUUID)
          ? crypto.randomUUID()
          : '0192b600-0000-7000-8000-' + Date.now().toString(16).padStart(12, '0').slice(-12);
        localStorage.setItem(key, existing);
      }
      return existing;
    } catch {
      return '0192b600-0000-7000-8000-000000000001';
    }
  }

  function openIdb() {
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('IndexedDB unavailable'));
        return;
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (ev) => {
        const db = ev.target.result;
        if (!db.objectStoreNames.contains(STORES.DEVICE)) {
          db.createObjectStore(STORES.DEVICE, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(STORES.SNAPSHOTS)) {
          db.createObjectStore(STORES.SNAPSHOTS, { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains(STORES.DRAFTS)) {
          db.createObjectStore(STORES.DRAFTS, { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains(STORES.INVOICES)) {
          const s = db.createObjectStore(STORES.INVOICES, { keyPath: 'invoiceId' });
          s.createIndex('byTenantBranch', ['tenantId', 'branchId'], { unique: false });
        }
        if (!db.objectStoreNames.contains(STORES.OUTBOX)) {
          const o = db.createObjectStore(STORES.OUTBOX, { keyPath: 'commandId' });
          o.createIndex('byTenant', 'tenantId', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORES.SHIFTS)) {
          db.createObjectStore(STORES.SHIFTS, { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains(STORES.MOVEMENTS)) {
          const m = db.createObjectStore(STORES.MOVEMENTS, { keyPath: 'id' });
          m.createIndex('byTenantBranch', ['tenantId', 'branchId'], { unique: false });
        }
        if (!db.objectStoreNames.contains(STORES.TRANSFERS)) {
          const t = db.createObjectStore(STORES.TRANSFERS, { keyPath: 'id' });
          t.createIndex('byTenantBranch', ['tenantId', 'branchId'], { unique: false });
        }
        if (!db.objectStoreNames.contains(STORES.CONFLICTS)) {
          const c = db.createObjectStore(STORES.CONFLICTS, { keyPath: 'id' });
          c.createIndex('byTenantBranch', ['tenantId', 'branchId'], { unique: false });
        }
        if (!db.objectStoreNames.contains(STORES.RECOVERY)) {
          db.createObjectStore(STORES.RECOVERY, { keyPath: 'key' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('Failed to open IndexedDB'));
    });
  }

  async function idbGet(storeName, key) {
    const db = await openIdb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbPut(storeName, value) {
    const db = await openIdb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).put(value);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  }

  async function idbDelete(storeName, key) {
    const db = await openIdb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).delete(key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  }

  async function idbGetAllByTenantBranch(storeName, tenantId, branchId) {
    const db = await openIdb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const req = store.getAll();
      req.onsuccess = () => {
        const items = (req.result || []).filter((x) =>
          x.tenantId === tenantId && (!branchId || x.branchId === branchId),
        );
        resolve(items);
      };
      req.onerror = () => reject(req.error);
    });
  }

  function snapshotKey(tenantId, branchId) {
    return `${tenantId}::${branchId}`;
  }

  async function bindDeviceSession(ctx) {
    const record = {
      id: 'active',
      deviceId: ctx.deviceId || getOrCreateDeviceId(),
      tenantId: ctx.tenantId,
      branchId: ctx.branchId,
      branchCode: ctx.branchCode || '',
      branchName: ctx.branchName || '',
      warehouseId: ctx.warehouseId,
      registerId: ctx.registerId || null,
      actorUserId: ctx.actorUserId || '',
      roleCodes: Array.isArray(ctx.roleCodes) ? ctx.roleCodes : [],
      permissions: Array.isArray(ctx.permissions) ? ctx.permissions : [],
      allLocationsAccess: Boolean(ctx.allLocationsAccess),
      allowedBranchIds: Array.isArray(ctx.allowedBranchIds) ? ctx.allowedBranchIds : [],
      clientPlatform: detectClientPlatform(),
      enrolledAt: ctx.enrolledAt || new Date().toISOString(),
      offlineAuthExpiresAt: ctx.offlineAuthExpiresAt || new Date(Date.now() + 24 * 3600_000).toISOString(),
      ...(ctx.subscriptionSnapshot ? { subscriptionSnapshot: ctx.subscriptionSnapshot } : {}),
    };
    await idbPut(STORES.DEVICE, record);
    return record;
  }

  async function getDeviceContext() {
    return idbGet(STORES.DEVICE, 'active');
  }

  async function assertAuthorizedOfflineScope(tenantId, branchId, requiredPermission, isWriteOperation = false) {
    const dev = await getDeviceContext();
    if (!dev) return null;
    if (dev.securityStatus === 'REVOKED') {
      throw new Error(dev.revokedReason || 'Device authorization revoked. Pending local records are preserved read-only.');
    }
    if (dev.tenantId !== tenantId) {
      throw new Error(`Offline tenant isolation denied (${tenantId} vs ${dev.tenantId})`);
    }
    if (!dev.allLocationsAccess && Array.isArray(dev.allowedBranchIds) && dev.allowedBranchIds.length > 0) {
      if (branchId && !dev.allowedBranchIds.includes(branchId)) {
        throw new Error(`Offline branch access denied for branch ${branchId}`);
      }
    }
    if (requiredPermission && !dev.roleCodes.includes('TENANT_OWNER') && !dev.roleCodes.includes('ORG_ADMIN')) {
      if (Array.isArray(dev.permissions) && dev.permissions.length > 0 && !dev.permissions.includes(requiredPermission)) {
        throw new Error(`Missing offline permission ${requiredPermission}`);
      }
    }
    const meta = await getSyncMetaState(tenantId);
    const snap = meta?.subscriptionState || dev.subscriptionSnapshot;
    if (snap) {
      if (snap.status === 'SUSPENDED' || snap.status === 'CANCELLED') {
        throw new Error(`Subscription is ${snap.status}. Pending local transactions remain preserved safely until restored.`);
      }
      if (isWriteOperation && (snap.isReadOnly || snap.status === 'READ_ONLY' || snap.status === 'EXPIRED' || snap.status === 'PAST_DUE')) {
        throw new Error(`Read-Only Mode (${snap.status}): New offline transactions are blocked. Renew your subscription to resume sales and stock adjustments.`);
      }
      if (isWriteOperation && snap.offlineEntitled === false) {
        throw new Error(`Offline POS & Inventory requires Professional or Enterprise plan (current plan: ${snap.planCode}).`);
      }
    }
    return dev;
  }

  async function ingestServerSnapshot(params) {
    const { tenantId, branchId, warehouseId, snapshot, clearPendingDeltas } = params;
    const prev = await idbGet(STORES.SNAPSHOTS, snapshotKey(tenantId, branchId));
    const prevDeltas = clearPendingDeltas ? {} : ((prev && prev.pendingStockDeltas) ? prev.pendingStockDeltas : {});
    const prevBatchDeltas = clearPendingDeltas ? {} : ((prev && prev.pendingBatchDeltas) ? prev.pendingBatchDeltas : {});

    const now = snapshot.syncedAt || new Date().toISOString();
    const record = {
      key: snapshotKey(tenantId, branchId),
      tenantId,
      branchId,
      warehouseId,
      currencyCode: snapshot.currencyCode || 'LKR',
      syncedAt: now,
      snapshotVersion: ((prev && prev.snapshotVersion) || 0) + 1,
      branding: snapshot.branding || null,
      policies: snapshot.policies || null,
      globalPrices: snapshot.globalPrices || [],
      branchOverrides: snapshot.branchOverrides || [],
      batches: snapshot.batches || [],
      categories: snapshot.categories || [],
      barcodes: snapshot.barcodes || [],
      unitConversions: snapshot.unitConversions || [],
      taxGroups: snapshot.taxGroups || [],
      taxRates: snapshot.taxRates || [],
      customers: snapshot.customers || [],
      branches: snapshot.branches || [],
      warehouses: snapshot.warehouses || [],
      registers: snapshot.registers || [],
      balances: snapshot.balances || [],
      serials: snapshot.serials || [],
      deviceAuthorization: snapshot.deviceAuthorization || null,
      pendingStockDeltas: prevDeltas,
      pendingBatchDeltas: prevBatchDeltas,
    };

    await idbPut(STORES.SNAPSHOTS, record);

    if (snapshot.deviceAuthorization) {
      await bindDeviceSession({
        tenantId,
        branchId,
        warehouseId,
        actorUserId: snapshot.deviceAuthorization.actorUserId,
        roleCodes: snapshot.deviceAuthorization.roleCodes,
        permissions: snapshot.deviceAuthorization.permissions,
        allLocationsAccess: snapshot.deviceAuthorization.allLocationsAccess,
        allowedBranchIds: snapshot.deviceAuthorization.allowedBranchIds,
        offlineAuthExpiresAt: new Date(
          Date.now() + (snapshot.deviceAuthorization.offlineAuthTtlHours || 24) * 3600_000,
        ).toISOString(),
      });
    }

    if (hasTauriIpc()) {
      await invokeTauri('desktop_save_sync_snapshot', {
        req: {
          tenantId,
          branding: snapshot.branding || null,
          policies: snapshot.policies || null,
          products: (snapshot.globalPrices || []).map((p) => ({
            id: p.productId,
            sku: p.sku,
            name: p.name,
            baseUom: p.baseUom,
            sellingPrice: p.sellingPrice,
            purchaseCost: p.purchaseCost || '0.0000',
            primaryBarcode: p.primaryBarcode || null,
          })),
          batches: snapshot.batches || [],
        },
      });
    }

    return {
      syncedAt: now,
      snapshotVersion: record.snapshotVersion,
      productsCount: record.globalPrices.length,
      customersCount: record.customers.length,
      batchesCount: record.batches.length,
    };
  }

  async function getSnapshot(tenantId, branchId) {
    return idbGet(STORES.SNAPSHOTS, snapshotKey(tenantId, branchId));
  }

  async function getDataFreshness(tenantId, branchId) {
    const snap = await getSnapshot(tenantId, branchId);
    const outbox = await listOutboxCommands(tenantId);
    const pendingCount = outbox.filter((x) => x.status === 'PENDING' || x.status === 'IN_FLIGHT').length;
    const syncedAt = snap ? snap.syncedAt : null;
    const isStale = !syncedAt || (Date.now() - Date.parse(syncedAt)) > 12 * 3600_000;
    return {
      hasSnapshot: Boolean(snap),
      syncedAt,
      snapshotVersion: snap ? snap.snapshotVersion : 0,
      isStale,
      pendingOutboxCount: pendingCount,
      counts: {
        products: snap ? (snap.globalPrices || []).length : 0,
        categories: snap ? (snap.categories || []).length : 0,
        customers: snap ? (snap.customers || []).length : 0,
        batches: snap ? (snap.batches || []).length : 0,
      },
    };
  }

  async function getPosProductsOffline(tenantId, branchId, warehouseId) {
    await assertAuthorizedOfflineScope(tenantId, branchId, 'pos:sale:create', true);
    const snap = await getSnapshot(tenantId, branchId);
    if (!snap) return { products: [], categories: [], batches: [], taxRates: [], customers: [] };

    const overrides = new Map();
    for (const ov of (snap.branchOverrides || [])) {
      if (ov.branchId === branchId && ov.isActive) overrides.set(ov.productId, ov);
    }
    const balMap = new Map();
    for (const b of (snap.balances || [])) {
      if (b.warehouseId === warehouseId || !warehouseId) balMap.set(b.productId, b);
    }
    const bcByProd = new Map();
    for (const bc of (snap.barcodes || [])) {
      const list = bcByProd.get(bc.productId) || [];
      list.push(bc);
      bcByProd.set(bc.productId, list);
    }
    const convByProd = new Map();
    for (const uc of (snap.unitConversions || [])) {
      const list = convByProd.get(uc.productId) || [];
      list.push(uc);
      convByProd.set(uc.productId, list);
    }

    const deltas = snap.pendingStockDeltas || {};
    const products = (snap.globalPrices || []).map((p) => {
      const ov = overrides.get(p.productId);
      const bal = balMap.get(p.productId);
      const srvAvail = parseFloat(bal?.availableQty || '0') || 0;
      const pendingDelta = parseFloat(deltas[p.productId] || '0') || 0;
      const projAvail = Math.max(0, srvAvail + pendingDelta);
      const effPrice = ov ? ov.sellingPrice : p.sellingPrice;
      return {
        id: p.productId,
        sku: p.sku,
        name: p.name,
        categoryId: p.categoryId || null,
        baseUom: p.baseUom,
        priceUom: p.priceUom || p.baseUom,
        productQtyMode: p.productQtyMode || 'STANDARD',
        measurementCategory: p.measurementCategory || null,
        allowedSellingUoms: p.allowedSellingUoms || [p.baseUom],
        qtyDecimalPrecision: p.qtyDecimalPrecision || 0,
        sellingPrice: effPrice,
        retailPrice: effPrice,
        globalRetailPrice: p.sellingPrice,
        minSellingPrice: (ov && ov.minSellingPrice) || p.minSellingPrice || null,
        maxDiscountPct: (ov && ov.maxDiscountPct) || p.maxDiscountPct || null,
        trackingMode: p.trackingMode || 'NONE',
        allocationPolicy: p.allocationPolicy || 'FEFO',
        taxGroupId: p.taxGroupId || null,
        trackInventory: p.trackInventory !== false,
        availableQuantity: projAvail.toFixed(6),
        serverAvailableQuantity: srvAvail.toFixed(6),
        primaryBarcode: p.primaryBarcode || null,
        barcodes: bcByProd.get(p.productId) || [],
        unitConversions: convByProd.get(p.productId) || [],
      };
    });

    const bDeltas = snap.pendingBatchDeltas || {};
    const batches = (snap.batches || [])
      .filter((b) => !warehouseId || b.warehouseId === warehouseId)
      .map((b) => {
        const srvAvail = parseFloat(b.availableQuantity || '0') || 0;
        const delta = parseFloat(bDeltas[b.batchId] || '0') || 0;
        const proj = Math.max(0, srvAvail + delta);
        return {
          ...b,
          id: b.batchId,
          currentQuantity: proj.toFixed(6),
          reservedQuantity: '0.000000',
          availableQuantity: proj.toFixed(6),
        };
      });

    return {
      products,
      categories: snap.categories || [],
      batches,
      taxRates: snap.taxRates || [],
      customers: snap.customers || [],
      registers: snap.registers || [],
    };
  }

  async function resolveBarcodeOffline(tenantId, branchId, warehouseId, code) {
    const clean = String(code || '').trim();
    if (!clean) return null;
    const data = await getPosProductsOffline(tenantId, branchId, warehouseId);
    const today = new Date().toISOString().slice(0, 10);

    const exactBatch = data.batches.find((b) => b.internalBarcode === clean);
    if (exactBatch) {
      const prod = data.products.find((p) => p.id === exactBatch.productId);
      const isExpired = exactBatch.status === 'EXPIRED' || (exactBatch.expiryDate && exactBatch.expiryDate < today);
      if (isExpired) {
        return { isBlocked: true, message: `Batch ${exactBatch.batchNumber} is expired (${exactBatch.expiryDate}) and cannot be sold.` };
      }
      if (exactBatch.status !== 'ACTIVE' || parseFloat(exactBatch.availableQuantity) <= 0) {
        return { isBlocked: true, message: `Batch ${exactBatch.batchNumber} has no sellable stock remaining.` };
      }
      return {
        isBlocked: false,
        product: prod,
        lockedBatch: exactBatch,
        effectiveUnitPrice: (exactBatch.batchPricingMode === 'EXPLICIT' && exactBatch.sellingPrice) ? exactBatch.sellingPrice : prod?.retailPrice,
        priceSource: exactBatch.batchPricingMode === 'EXPLICIT' ? 'BATCH_EXPLICIT' : 'PRODUCT_FALLBACK',
      };
    }

    const lower = clean.toLowerCase();
    const matchedProd = data.products.find((p) =>
      (p.sku && p.sku.toLowerCase() === lower) ||
      (p.primaryBarcode && p.primaryBarcode.toLowerCase() === lower) ||
      (Array.isArray(p.barcodes) && p.barcodes.some((bc) => String(bc.barcode || bc).toLowerCase() === lower)),
    );
    if (!matchedProd) return null;

    const prodBatches = data.batches
      .filter((b) => b.productId === matchedProd.id && b.status === 'ACTIVE' && (!b.expiryDate || b.expiryDate >= today) && parseFloat(b.availableQuantity) > 0)
      .sort((a, b) => {
        if (matchedProd.allocationPolicy === 'FIFO') return String(a.receivedDate || '').localeCompare(String(b.receivedDate || ''));
        return String(a.expiryDate || '9999-12-31').localeCompare(String(b.expiryDate || '9999-12-31'));
      });

    return {
      isBlocked: false,
      product: matchedProd,
      fefoPreview: prodBatches,
      availableQuantityTotal: matchedProd.availableQuantity,
      effectiveUnitPrice: prodBatches[0]?.sellingPrice || matchedProd.retailPrice,
      priceSource: prodBatches[0]?.sellingPrice ? 'BATCH_EXPLICIT' : 'PRODUCT_FALLBACK',
    };
  }

  async function saveDraftCart(params) {
    const key = `${params.tenantId}::${params.branchId}::${params.userId}`;
    const record = {
      key,
      id: params.id || key,
      tenantId: params.tenantId,
      branchId: params.branchId,
      userId: params.userId,
      registerId: params.registerId || null,
      customerId: params.customerId || null,
      customerName: params.customerName || null,
      cart: Array.isArray(params.cart) ? params.cart : [],
      updatedAt: new Date().toISOString(),
    };
    await idbPut(STORES.DRAFTS, record);
    if (hasTauriIpc()) {
      await invokeTauri('desktop_save_draft_cart', {
        req: {
          id: record.id,
          tenantId: record.tenantId,
          branchId: record.branchId,
          userId: record.userId,
          registerId: record.registerId,
          customerId: record.customerId,
          customerName: record.customerName,
          cartLinesJson: JSON.stringify(record.cart),
          notes: null,
        },
      });
    }
    return record;
  }

  async function loadDraftCart(tenantId, branchId, userId) {
    const key = `${tenantId}::${branchId}::${userId}`;
    const rec = await idbGet(STORES.DRAFTS, key);
    if (rec && Array.isArray(rec.cart) && rec.cart.length > 0) return rec;
    if (hasTauriIpc()) {
      const tauriDraft = await invokeTauri('desktop_load_draft_cart', {
        tenantId,
        branchId,
        userId,
      });
      if (tauriDraft && tauriDraft.cartLinesJson) {
        try {
          return {
            key,
            id: tauriDraft.id,
            tenantId,
            branchId,
            userId,
            registerId: tauriDraft.registerId || null,
            customerId: tauriDraft.customerId || null,
            customerName: tauriDraft.customerName || null,
            cart: JSON.parse(tauriDraft.cartLinesJson),
            updatedAt: tauriDraft.updatedAt,
          };
        } catch {
          return rec || null;
        }
      }
    }
    return rec || null;
  }

  async function clearDraftCart(tenantId, branchId, userId) {
    await idbDelete(STORES.DRAFTS, `${tenantId}::${branchId}::${userId}`);
  }

  async function saveCachedShift(tenantId, branchId, shiftObj) {
    if (!tenantId || !branchId) return;
    await idbPut(STORES.SHIFTS, {
      key: snapshotKey(tenantId, branchId),
      tenantId,
      branchId,
      shift: shiftObj,
      updatedAt: new Date().toISOString(),
    });
  }

  async function loadCachedShift(tenantId, branchId) {
    const rec = await idbGet(STORES.SHIFTS, snapshotKey(tenantId, branchId));
    return rec ? rec.shift : null;
  }

  async function listOutboxCommands(tenantId) {
    return idbGetAllByTenantBranch(STORES.OUTBOX, tenantId, null);
  }

  async function listLocalInvoices(tenantId, branchId) {
    const items = await idbGetAllByTenantBranch(STORES.INVOICES, tenantId, branchId);
    return items.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  async function recordOfflineCashSale(params) {
    const {
      tenantId,
      branchId,
      warehouseId,
      registerId,
      shiftId,
      cashierUserId,
      currencyCode,
      customerId,
      customerName,
      lines,
      subtotalAmount,
      taxAmount,
      grandTotal,
      tenderedAmount,
      changeGiven,
      idempotencyKey,
    } = params;

    await assertAuthorizedOfflineScope(tenantId, branchId, 'pos:sale:create', true);
    const now = new Date().toISOString();
    const invoiceId = idempotencyKey || (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()));
    const commandId = crypto.randomUUID ? crypto.randomUUID() : `${invoiceId}-cmd`;
    const invoiceNumber = `OFF-${invoiceId.replace(/-/g, '').slice(0, 10).toUpperCase()}`;
    const deviceId = getOrCreateDeviceId();

    const invoiceRecord = {
      id: invoiceId,
      invoiceId,
      tenantId,
      branchId,
      warehouseId,
      registerId,
      shiftId: shiftId || null,
      customerId: customerId || null,
      customerName: customerName || null,
      cashierUserId,
      invoiceNumber,
      status: 'COMPLETED',
      syncState: 'PENDING_SYNC',
      serverConfirmed: false,
      outboxCommandId: commandId,
      currencyCode: currencyCode || 'LKR',
      subtotalAmount: Number(subtotalAmount).toFixed(4),
      taxAmount: Number(taxAmount).toFixed(4),
      grandTotal: Number(grandTotal).toFixed(4),
      totalPaid: Number(grandTotal).toFixed(4),
      changeGiven: Number(changeGiven).toFixed(4),
      lines,
      payments: [
        {
          paymentMethod: 'CASH',
          amount: Number(grandTotal).toFixed(4),
          tenderedAmount: Number(tenderedAmount).toFixed(4),
          changeAmount: Number(changeGiven).toFixed(4),
        },
      ],
      createdAt: now,
    };

    const existingOutbox = await listOutboxCommands(tenantId);
    const nextSeq = existingOutbox.reduce((max, x) => Math.max(max, x.localSeq || 0), 0) + 1;

    const outboxCmd = {
      localSeq: nextSeq,
      commandId,
      tenantId,
      branchId,
      deviceId,
      actorUserId: cashierUserId,
      commandType: 'POS_RECORD_SALE',
      schemaVersion: 1,
      occurredAt: now,
      status: 'PENDING',
      retryCount: 0,
      payload: {
        registerId,
        shiftId: shiftId || null,
        customerId: customerId || null,
        customerName: customerName || null,
        lines,
        payments: invoiceRecord.payments,
        offlineInvoiceNumber: invoiceNumber,
        validationPolicy: 'OPTION_A_SERVER_VALIDATION_ON_SYNC',
      },
    };

    await idbPut(STORES.INVOICES, invoiceRecord);
    await idbPut(STORES.OUTBOX, outboxCmd);

    // Update local stock projection ONLY (preserving server quantities cleanly)
    const snap = await getSnapshot(tenantId, branchId);
    if (snap) {
      snap.pendingStockDeltas = snap.pendingStockDeltas || {};
      snap.pendingBatchDeltas = snap.pendingBatchDeltas || {};
      for (const l of lines) {
        const delta = -(parseFloat(l.normalizedBaseQty ?? l.quantity ?? '0') || 0);
        if (delta < 0) {
          snap.pendingStockDeltas[l.productId] = ((parseFloat(snap.pendingStockDeltas[l.productId] || '0') || 0) + delta).toFixed(6);
          if (l.batchId) {
            snap.pendingBatchDeltas[l.batchId] = ((parseFloat(snap.pendingBatchDeltas[l.batchId] || '0') || 0) + delta).toFixed(6);
          }
        }
      }
      await idbPut(STORES.SNAPSHOTS, snap);
    }

    if (hasTauriIpc()) {
      await invokeTauri('desktop_queue_offline_sale', {
        req: {
          tenantId,
          branchId,
          warehouseId,
          registerId,
          shiftId: shiftId || '00000000-0000-0000-0000-000000000000',
          cashierUserId,
          deviceId,
          currencyCode: currencyCode || 'LKR',
          grandTotal: Number(grandTotal).toFixed(4),
          paymentMethod: 'CASH',
          tenderedAmount: Number(tenderedAmount).toFixed(4),
          customerId: customerId || null,
          customerName: customerName || null,
          lines: lines.map((l) => ({
            productId: l.productId,
            sku: l.sku || '',
            productName: l.productName || '',
            batchId: l.batchId || null,
            uomCode: l.uomCode || 'PCS',
            quantity: String(l.quantity),
            unitPrice: String(l.unitPrice || '0.0000'),
            unitCostSnapshot: String(l.unitCostSnapshot || '0.0000'),
            lineTotal: String(l.lineTotal || '0.0000'),
            entrySource: l.entrySource || 'MANUAL',
          })),
        },
      });
    }

    await clearDraftCart(tenantId, branchId, cashierUserId);
    return invoiceRecord;
  }

  let _syncInFlight = false;

  async function computeSha256Hex(text) {
    if (typeof crypto !== 'undefined' && crypto.subtle && typeof TextEncoder !== 'undefined') {
      const data = new TextEncoder().encode(text);
      const digest = await crypto.subtle.digest('SHA-256', data);
      return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
    }
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return ('fnv1a_' + (hash >>> 0).toString(16).padStart(8, '0'));
  }

  async function getSerialsOffline(tenantId, branchId, warehouseId, query) {
    await assertAuthorizedOfflineScope(tenantId, branchId, 'inv:serial:read');
    const snap = await getSnapshot(tenantId, branchId);
    if (!snap || !Array.isArray(snap.serials)) return [];
    const q = String(query || '').trim().toUpperCase();
    return snap.serials.filter((s) => {
      if (warehouseId && s.warehouseId && s.warehouseId !== warehouseId) return false;
      if (q && !String(s.serialNumber || '').toUpperCase().includes(q)) return false;
      return true;
    });
  }

  async function getExpiryAlertsOffline(tenantId, branchId, warehouseId, withinDays = 30) {
    const data = await getPosProductsOffline(tenantId, branchId, warehouseId);
    const todayStr = new Date().toISOString().slice(0, 10);
    const todayMs = Date.parse(todayStr + 'T00:00:00.000Z');
    const prodById = new Map((data.products || []).map((p) => [p.id, p]));
    const alerts = [];
    for (const b of (data.batches || [])) {
      if (!b.expiryDate || parseFloat(b.availableQuantity || '0') <= 0) continue;
      const expStr = String(b.expiryDate).slice(0, 10);
      const expMs = Date.parse(expStr + 'T00:00:00.000Z');
      if (!Number.isFinite(expMs)) continue;
      const daysRemaining = Math.floor((expMs - todayMs) / 86400000);
      const prod = prodById.get(b.productId);
      if (expStr < todayStr || b.status === 'EXPIRED') {
        alerts.push({
          ...b,
          sku: prod?.sku || '',
          productName: prod?.name || 'Product',
          expiryDate: expStr,
          daysRemaining,
          alertLevel: 'EXPIRED',
        });
      } else if (daysRemaining <= withinDays) {
        alerts.push({
          ...b,
          sku: prod?.sku || '',
          productName: prod?.name || 'Product',
          expiryDate: expStr,
          daysRemaining,
          alertLevel: 'EXPIRING_SOON',
        });
      }
    }
    return alerts.sort((a, b) => a.daysRemaining - b.daysRemaining);
  }

  async function recordOfflineStockAdjustment(params) {
    const {
      tenantId, branchId, warehouseId, userId, productId,
      movementType, quantity, batchId, serialId, reason, notes,
    } = params;
    await assertAuthorizedOfflineScope(tenantId, branchId, 'inv:movement:post', true);
    const qtyNum = parseFloat(String(quantity || '0'));
    if (!(qtyNum > 0)) throw new Error('Adjustment quantity must be greater than zero.');
    if (!reason || String(reason).trim().length < 2) throw new Error('Adjustment reason is required.');

    const snap = await getSnapshot(tenantId, branchId);
    if (!snap) throw new Error('No synced offline snapshot found for this branch.');

    const prod = (snap.globalPrices || []).find((p) => p.productId === productId);
    if (!prod) throw new Error('Product not found in local branch snapshot.');

    const inbound = ['OPENING_STOCK', 'STOCK_IN', 'ADJUSTMENT_POSITIVE', 'CUSTOMER_RETURN_RESTOCK'].includes(movementType);
    const data = await getPosProductsOffline(tenantId, branchId, warehouseId);
    const prodView = (data.products || []).find((p) => p.id === productId);
    const currentAvail = parseFloat(prodView?.availableQuantity || '0') || 0;
    if (!inbound && currentAvail < qtyNum) {
      throw new Error(`Insufficient local available stock (${currentAvail.toFixed(4)}) for negative deduction of ${qtyNum}.`);
    }

    if (batchId && !inbound) {
      const b = (data.batches || []).find((x) => x.batchId === batchId);
      const todayStr = new Date().toISOString().slice(0, 10);
      if (!b || b.status === 'EXPIRED' || b.status === 'QUARANTINED' || (b.expiryDate && b.expiryDate < todayStr)) {
        throw new Error('Selected batch is expired or quarantined and cannot be deducted.');
      }
      if ((parseFloat(b.availableQuantity || '0') || 0) < qtyNum) {
        throw new Error(`Selected batch has only ${b.availableQuantity} available.`);
      }
    }

    const now = new Date().toISOString();
    const id = crypto.randomUUID ? crypto.randomUUID() : String(Date.now());
    const commandId = crypto.randomUUID ? crypto.randomUUID() : `${id}-cmd`;
    const deviceId = getOrCreateDeviceId();
    const existingOutbox = await listOutboxCommands(tenantId);
    const nextSeq = existingOutbox.reduce((max, x) => Math.max(max, x.localSeq || 0), 0) + 1;
    const commandType = ['ADJUSTMENT_POSITIVE', 'ADJUSTMENT_NEGATIVE'].includes(movementType)
      ? 'INV_RECORD_ADJUSTMENT'
      : 'INV_RECORD_MOVEMENT';

    const signedDelta = inbound ? qtyNum : -qtyNum;
    const movRecord = {
      id,
      tenantId,
      branchId,
      warehouseId,
      productId,
      productSku: prod.sku,
      productName: prod.name,
      batchId: batchId || null,
      serialId: serialId || null,
      movementType,
      uomCode: prod.baseUom || 'PCS',
      qtyDelta: signedDelta.toFixed(6),
      reason: String(reason).trim(),
      notes: notes || null,
      syncState: 'PENDING_SYNC',
      outboxCommandId: commandId,
      serverReferenceId: null,
      conflictReason: null,
      createdAt: now,
    };

    const outboxCmd = {
      localSeq: nextSeq,
      commandId,
      tenantId,
      branchId,
      deviceId,
      actorUserId: userId,
      commandType,
      schemaVersion: 1,
      occurredAt: now,
      status: 'PENDING',
      retryCount: 0,
      payload: {
        branchId,
        warehouseId,
        productId,
        batchId: batchId || null,
        serialId: serialId || null,
        movementType,
        quantity: qtyNum.toFixed(6),
        uomCode: prod.baseUom || 'PCS',
        reason: String(reason).trim(),
        notes: notes || null,
        occurredAt: now,
        entrySource: 'MANUAL',
      },
    };

    snap.pendingStockDeltas = snap.pendingStockDeltas || {};
    snap.pendingStockDeltas[productId] = ((parseFloat(snap.pendingStockDeltas[productId] || '0') || 0) + signedDelta).toFixed(6);
    if (batchId) {
      snap.pendingBatchDeltas = snap.pendingBatchDeltas || {};
      snap.pendingBatchDeltas[batchId] = ((parseFloat(snap.pendingBatchDeltas[batchId] || '0') || 0) + signedDelta).toFixed(6);
    }

    await idbPut(STORES.MOVEMENTS, movRecord);
    await idbPut(STORES.OUTBOX, outboxCmd);
    await idbPut(STORES.SNAPSHOTS, snap);
    return movRecord;
  }

  async function createOfflineTransferRequest(params) {
    const {
      tenantId, branchId, sourceWarehouseId, destinationBranchId,
      destinationWarehouseId, userId, lines, notes,
    } = params;
    await assertAuthorizedOfflineScope(tenantId, branchId, 'inv:movement:post', true);
    if (destinationBranchId === branchId) {
      throw new Error('Destination branch must differ from source branch.');
    }
    if (!Array.isArray(lines) || lines.length === 0) {
      throw new Error('At least one product line is required for transfer request.');
    }

    const now = new Date().toISOString();
    const id = crypto.randomUUID ? crypto.randomUUID() : String(Date.now());
    const commandId = crypto.randomUUID ? crypto.randomUUID() : `${id}-cmd`;
    const deviceId = getOrCreateDeviceId();
    const existingOutbox = await listOutboxCommands(tenantId);
    const nextSeq = existingOutbox.reduce((max, x) => Math.max(max, x.localSeq || 0), 0) + 1;

    const record = {
      id,
      tenantId,
      branchId,
      sourceBranchId: branchId,
      sourceWarehouseId,
      destinationBranchId,
      destinationWarehouseId: destinationWarehouseId || null,
      notes: notes || null,
      lines,
      status: 'TRANSFER_REQUEST_PENDING',
      syncState: 'PENDING_SYNC',
      outboxCommandId: commandId,
      serverTransferId: null,
      serverTransferNumber: null,
      conflictReason: null,
      createdAt: now,
    };

    const outboxCmd = {
      localSeq: nextSeq,
      commandId,
      tenantId,
      branchId,
      deviceId,
      actorUserId: userId,
      commandType: 'INV_REQUEST_TRANSFER',
      schemaVersion: 1,
      occurredAt: now,
      status: 'PENDING',
      retryCount: 0,
      payload: {
        sourceBranchId: branchId,
        sourceWarehouseId,
        destinationBranchId,
        ...(destinationWarehouseId ? { destinationWarehouseId } : {}),
        autoComplete: false,
        notes: notes || null,
        lines: lines.map((l) => ({
          productId: l.productId,
          quantity: Number(l.quantity).toFixed(6),
          ...(l.uomCode ? { uomCode: l.uomCode } : {}),
          ...(l.batchId ? { sourceBatchId: l.batchId } : {}),
        })),
      },
    };

    // NOTE: Transfer request does NOT mutate stock balance offline; stock moves only on server transfer execution.
    await idbPut(STORES.TRANSFERS, record);
    await idbPut(STORES.OUTBOX, outboxCmd);
    return record;
  }

  async function listOfflineMovements(tenantId, branchId) {
    const items = await idbGetAllByTenantBranch(STORES.MOVEMENTS, tenantId, branchId);
    return items.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  async function listOfflineTransfers(tenantId, branchId) {
    const items = await idbGetAllByTenantBranch(STORES.TRANSFERS, tenantId, branchId);
    return items.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  async function listLocalConflicts(tenantId, branchId) {
    const items = await idbGetAllByTenantBranch(STORES.CONFLICTS, tenantId, branchId);
    return items.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  async function recoverInFlightCommands(tenantId) {
    const outbox = await listOutboxCommands(tenantId);
    let recovered = 0;
    for (const cmd of outbox) {
      if (cmd.status === 'IN_FLIGHT') {
        cmd.status = 'PENDING';
        cmd.retryCount = (cmd.retryCount || 0) + 1;
        cmd.lastError = cmd.lastError || 'Recovered from interrupted sync';
        await idbPut(STORES.OUTBOX, cmd);
        recovered++;
      }
    }
    if (hasTauriIpc()) {
      await invokeTauri('desktop_recover_in_flight_outbox', { tenantId });
    }
    return recovered;
  }

  async function getSyncMetaState(tenantId) {
    return idbGet(STORES.RECOVERY, `sync_meta::${tenantId}`);
  }

  async function saveSyncMetaState(tenantId, patch) {
    const key = `sync_meta::${tenantId}`;
    const prev = (await idbGet(STORES.RECOVERY, key)) || { key, tenantId };
    const next = { ...prev, ...patch, updatedAt: new Date().toISOString() };
    await idbPut(STORES.RECOVERY, next);
    return next;
  }

  async function getSyncStatusSummary(tenantId, branchId, isOnline) {
    const outbox = await listOutboxCommands(tenantId);
    const conflicts = await listLocalConflicts(tenantId, branchId);
    const openConflicts = conflicts.filter((c) => c.status === 'OPEN' || c.status === 'QUARANTINED');
    const pendingCount = outbox.filter((o) => o.status === 'PENDING' || o.status === 'IN_FLIGHT').length;
    const failedCount = outbox.filter((o) => o.status === 'PENDING' && o.retryCount > 0 && Boolean(o.lastError)).length;
    const meta = await idbGet(STORES.RECOVERY, `sync_meta::${tenantId}`);
    const dev = await getDeviceContext();

    let connectionState = 'ONLINE';
    if (_syncInFlight) connectionState = 'SYNCING';
    else if (!isOnline) connectionState = 'OFFLINE';
    else if (openConflicts.length > 0) connectionState = 'CONFLICT';
    else if (failedCount > 0 || (meta?.lastError && pendingCount > 0)) connectionState = 'SYNC_FAILED';
    else if (pendingCount > 0) connectionState = 'PENDING_SYNC';

    return {
      connectionState,
      isOnline: Boolean(isOnline),
      isSyncing: _syncInFlight,
      pendingCount,
      failedCount,
      openConflictCount: openConflicts.length,
      lastSyncAttemptAt: meta?.lastSyncAttemptAt || null,
      lastSyncSuccessAt: meta?.lastSyncSuccessAt || null,
      lastError: meta?.lastError || null,
      deviceSecurityStatus: dev?.securityStatus || 'ACTIVE',
      revokedReason: dev?.revokedReason || null,
    };
  }

  async function syncNow(params) {
    const { tenantId, branchId, warehouseId, apiFetchFn } = params;
    if (!tenantId || !branchId || typeof apiFetchFn !== 'function') {
      throw new Error('Missing tenantId, branchId, or apiFetchFn for sync.');
    }
    if (_syncInFlight) {
      return { skipped: true, reason: 'Sync already in progress' };
    }

    _syncInFlight = true;
    const nowIso = new Date().toISOString();
    const deviceId = getOrCreateDeviceId();
    let appliedCount = 0;
    let duplicateCount = 0;
    let quarantinedCount = 0;
    let conflictFlaggedCount = 0;
    let lastError = null;

    try {
      await recoverInFlightCommands(tenantId);
      const allOutbox = (await listOutboxCommands(tenantId))
        .filter((c) => c.status === 'PENDING' && (!c.branchId || c.branchId === branchId))
        .sort((a, b) => (a.localSeq || 0) - (b.localSeq || 0));

      if (allOutbox.length > 0) {
        const batch = allOutbox.slice(0, 50);
        for (const c of batch) {
          c.status = 'IN_FLIGHT';
          await idbPut(STORES.OUTBOX, c);
        }

        try {
          let seqCursor = 0;
          const commands = batch.map((c) => {
            const rawSeq = Number(c.localSeq || 0);
            seqCursor = rawSeq > seqCursor ? rawSeq : seqCursor + 1;
            return {
              localSeq: seqCursor,
              commandId: c.commandId,
              tenantId: c.tenantId,
              branchId: c.branchId || branchId,
              deviceId: c.deviceId || deviceId,
              actorUserId: c.actorUserId,
              commandType: c.commandType,
              schemaVersion: c.schemaVersion || 1,
              occurredAt: c.occurredAt,
              payload: c.payload || {},
            };
          });

          const pushRes = await apiFetchFn('/v1/sync/push', {
            method: 'POST',
            body: JSON.stringify({ deviceId, branchId, commands }),
            silent: true,
          });

          const invoices = await listLocalInvoices(tenantId, branchId);
          const movements = await listOfflineMovements(tenantId, branchId);
          const transfers = await listOfflineTransfers(tenantId, branchId);
          const invByCmd = new Map(invoices.map((i) => [i.outboxCommandId, i]));
          const movByCmd = new Map(movements.map((m) => [m.outboxCommandId, m]));
          const trfByCmd = new Map(transfers.map((t) => [t.outboxCommandId, t]));
          const batchByCmd = new Map(batch.map((b) => [b.commandId, b]));

          for (const rec of (pushRes.receipts || [])) {
            const cmdObj = batchByCmd.get(rec.commandId);
            const isQuarantined = rec.status === 'QUARANTINED';
            const isFlag = rec.status === 'APPLIED_WITH_CONFLICT_FLAG';

            if (rec.status === 'APPLIED') appliedCount++;
            else if (rec.status === 'DUPLICATE_IGNORED') duplicateCount++;
            else if (isQuarantined) quarantinedCount++;
            else if (isFlag) conflictFlaggedCount++;

            if (cmdObj) {
              cmdObj.status = isQuarantined ? 'QUARANTINED' : 'SYNCED';
              cmdObj.lastError = rec.errorMessage || rec.conflictCode || null;
              await idbPut(STORES.OUTBOX, cmdObj);
            }

            const nextState = isQuarantined
              ? 'QUARANTINED'
              : (isFlag ? 'CONFLICT_FLAGGED' : 'SERVER_CONFIRMED');

            const inv = invByCmd.get(rec.commandId);
            if (inv) {
              inv.syncState = nextState;
              inv.serverConfirmed = !isQuarantined;
              inv.serverInvoiceId = rec.serverReferenceId || inv.serverInvoiceId || null;
              inv.serverInvoiceNumber = rec.serverReferenceNumber || inv.serverInvoiceNumber || null;
              inv.conflictReason = rec.errorMessage || rec.conflictCode || null;
              await idbPut(STORES.INVOICES, inv);
            }

            const mov = movByCmd.get(rec.commandId);
            if (mov) {
              mov.syncState = nextState;
              mov.serverReferenceId = rec.serverReferenceId || mov.serverReferenceId || null;
              mov.conflictReason = rec.errorMessage || rec.conflictCode || null;
              await idbPut(STORES.MOVEMENTS, mov);
            }

            const trf = trfByCmd.get(rec.commandId);
            if (trf) {
              trf.syncState = nextState;
              trf.status = isQuarantined ? 'QUARANTINED' : (isFlag ? 'CONFLICT_FLAGGED' : 'SERVER_CONFIRMED');
              trf.serverTransferId = rec.serverReferenceId || trf.serverTransferId || null;
              trf.serverTransferNumber = rec.serverReferenceNumber || trf.serverTransferNumber || null;
              trf.conflictReason = rec.errorMessage || rec.conflictCode || null;
              await idbPut(STORES.TRANSFERS, trf);
            }

            if (isQuarantined || isFlag) {
              const conflictId = rec.conflictId || rec.commandId;
              await idbPut(STORES.CONFLICTS, {
                id: conflictId,
                tenantId,
                branchId,
                deviceId,
                commandId: rec.commandId,
                commandType: cmdObj?.commandType || 'POS_RECORD_SALE',
                conflictCode: rec.conflictCode || 'SYNC_CONFLICT',
                status: isQuarantined ? 'QUARANTINED' : 'OPEN',
                localReferenceNumber: inv?.invoiceNumber || mov?.productSku || null,
                details: { message: rec.errorMessage || rec.conflictCode, ...(rec.serverDetails || {}) },
                originalPayload: cmdObj?.payload || {},
                createdAt: nowIso,
                resolvedAt: null,
              });
            }
          }
        } catch (pushErr) {
          lastError = pushErr?.message || String(pushErr);
          for (const c of batch) {
            c.status = 'PENDING';
            c.retryCount = (c.retryCount || 0) + 1;
            c.lastError = lastError;
            await idbPut(STORES.OUTBOX, c);
          }
          if (pushErr?.errorCode === 'SYNC_DEVICE_REVOKED' || lastError.includes('SYNC_DEVICE_REVOKED')) {
            const dev = await getDeviceContext();
            if (dev) {
              dev.securityStatus = 'REVOKED';
              dev.revokedReason = lastError;
              await idbPut(STORES.DEVICE, dev);
            }
          }
          await saveSyncMetaState(tenantId, { lastSyncAttemptAt: nowIso, lastError });
          throw pushErr;
        }
      }

      const fresh = await getDataFreshness(tenantId, branchId);
      const pullRes = await apiFetchFn(
        `/v1/sync/pull?branchId=${encodeURIComponent(branchId)}&deviceId=${encodeURIComponent(deviceId)}${fresh.syncedAt ? `&since=${encodeURIComponent(fresh.syncedAt)}` : ''}`,
        { silent: true },
      );

      if (pullRes && pullRes.snapshot) {
        const remainingPending = (await listOutboxCommands(tenantId)).filter(
          (x) => x.status === 'PENDING' || x.status === 'IN_FLIGHT',
        ).length;
        await ingestServerSnapshot({
          tenantId,
          branchId,
          warehouseId: warehouseId || '',
          snapshot: pullRes.snapshot,
          clearPendingDeltas: remainingPending === 0,
        });
      }

      for (const sc of (pullRes?.openConflicts || [])) {
        await idbPut(STORES.CONFLICTS, {
          id: sc.id,
          tenantId: sc.tenantId,
          branchId: sc.branchId,
          deviceId: sc.deviceId,
          commandId: sc.commandId,
          commandType: sc.commandType || 'POS_RECORD_SALE',
          conflictCode: sc.conflictType,
          status: sc.status,
          details: sc.details || {},
          originalPayload: sc.originalPayload || {},
          createdAt: sc.createdAt,
          resolvedAt: sc.resolvedAt || null,
        });
      }

      await saveSyncMetaState(tenantId, {
        lastSyncAttemptAt: nowIso,
        lastSyncSuccessAt: nowIso,
        lastError: null,
        ...(pullRes?.subscriptionState ? { subscriptionState: pullRes.subscriptionState } : {}),
      });

      return {
        skipped: false,
        appliedCount,
        duplicateCount,
        quarantinedCount,
        conflictFlaggedCount,
        openConflicts: pullRes?.openConflictsCount || 0,
      };
    } catch (err) {
      if (!lastError) {
        lastError = err?.message || String(err);
        await saveSyncMetaState(tenantId, { lastSyncAttemptAt: nowIso, lastError });
      }
      throw err;
    } finally {
      _syncInFlight = false;
    }
  }

  async function resolveLocalConflict(params) {
    const { tenantId, branchId, conflictId, action, notes, apiFetchFn } = params;
    const res = await apiFetchFn(`/v1/sync/conflicts/${encodeURIComponent(conflictId)}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ action, ...(notes ? { notes } : {}) }),
    });
    const conflicts = await listLocalConflicts(tenantId, branchId);
    const target = conflicts.find((c) => c.id === conflictId);
    if (target) {
      target.status = res.conflict?.status || (action === 'DISMISS' ? 'DISMISSED' : 'RESOLVED');
      target.resolutionAction = action;
      target.resolutionNotes = notes || null;
      target.resolvedAt = res.conflict?.resolvedAt || new Date().toISOString();
      await idbPut(STORES.CONFLICTS, target);

      const invoices = await listLocalInvoices(tenantId, branchId);
      const inv = invoices.find((i) => i.outboxCommandId === target.commandId);
      if (inv) {
        inv.syncState = action === 'MARK_VOIDED_REFUND_REQUIRED' ? 'CONFLICT_FLAGGED' : 'SERVER_CONFIRMED';
        inv.serverConfirmed = action !== 'MARK_VOIDED_REFUND_REQUIRED';
        inv.serverInvoiceId = res.replayedReferenceId || inv.serverInvoiceId || null;
        inv.serverInvoiceNumber = res.replayedReferenceNumber || inv.serverInvoiceNumber || null;
        inv.conflictReason = action === 'MARK_VOIDED_REFUND_REQUIRED' ? 'Marked Voided / Customer Refund' : null;
        await idbPut(STORES.INVOICES, inv);
      }
    }
    return res;
  }

  async function exportRecoveryBackup(tenantId, branchId) {
    const raw = {
      formatVersion: 1,
      exportedAt: new Date().toISOString(),
      tenantId,
      branchId,
      deviceId: getOrCreateDeviceId(),
      pendingOutbox: await listOutboxCommands(tenantId),
      localInvoices: await listLocalInvoices(tenantId, branchId),
      inventoryMovements: await listOfflineMovements(tenantId, branchId),
      transferRequests: await listOfflineTransfers(tenantId, branchId),
      conflicts: await listLocalConflicts(tenantId, branchId),
    };
    const checksumSha256 = await computeSha256Hex(JSON.stringify(raw));
    return { ...raw, checksumSha256 };
  }

  async function importRecoveryBackup(backup) {
    const { checksumSha256, ...withoutChecksum } = backup || {};
    const expected = await computeSha256Hex(JSON.stringify(withoutChecksum));
    if (expected !== checksumSha256) {
      throw new Error('Recovery backup checksum failed. File may be corrupted.');
    }
    let restored = 0;
    let skipped = 0;
    const existing = new Set((await listOutboxCommands(backup.tenantId)).map((x) => x.commandId));
    for (const cmd of (backup.pendingOutbox || [])) {
      if (existing.has(cmd.commandId)) {
        skipped++;
        continue;
      }
      await idbPut(STORES.OUTBOX, cmd);
      restored++;
    }
    for (const inv of (backup.localInvoices || [])) {
      await idbPut(STORES.INVOICES, inv);
    }
    for (const mov of (backup.inventoryMovements || [])) {
      await idbPut(STORES.MOVEMENTS, mov);
    }
    for (const trf of (backup.transferRequests || [])) {
      await idbPut(STORES.TRANSFERS, trf);
    }
    return { restoredOutboxCount: restored, skippedDuplicatesCount: skipped };
  }

  global.NexStockOfflineClient = {
    detectClientPlatform,
    hasTauriIpc,
    getOrCreateDeviceId,
    bindDeviceSession,
    getDeviceContext,
    ingestServerSnapshot,
    getDataFreshness,
    getPosProductsOffline,
    resolveBarcodeOffline,
    saveDraftCart,
    loadDraftCart,
    clearDraftCart,
    saveCachedShift,
    loadCachedShift,
    listLocalInvoices,
    listOutboxCommands,
    recordOfflineCashSale,
    getSerialsOffline,
    getExpiryAlertsOffline,
    recordOfflineStockAdjustment,
    createOfflineTransferRequest,
    listOfflineMovements,
    listOfflineTransfers,
    listLocalConflicts,
    recoverInFlightCommands,
    getSyncStatusSummary,
    syncNow,
    resolveLocalConflict,
    exportRecoveryBackup,
    importRecoveryBackup,
  };
})(typeof window !== 'undefined' ? window : globalThis);

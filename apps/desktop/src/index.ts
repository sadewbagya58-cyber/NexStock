import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  getCanonicalSqliteMigrations,
  initializeLocalSqliteDatabase,
} from '@nexstock/sqlite-schema';
import {
  type StatusBannerDescriptor,
  createSyncStatusBannerDescriptor,
} from '@nexstock/ui';

/**
 * @nexstock/desktop — Offline-First Tauri v2 Desktop Runtime & SQLite Store.
 * Mirrors all Tauri Rust IPC commands (`desktop_get_status`, `desktop_save_sync_snapshot`,
 * `desktop_resolve_barcode`, `desktop_queue_offline_sale`, `desktop_queue_print_job`,
 * `desktop_flush_sync_outbox`) against the canonical SQLite 0001..0007 schema.
 */
export function getDesktopConnectionBanner(params: {
  readonly isOnline: boolean;
  readonly pendingOutboxCount: number;
  readonly isSyncInFlight: boolean;
}): StatusBannerDescriptor {
  return createSyncStatusBannerDescriptor({
    ...params,
    clientPlatform: 'TAURI_DESKTOP',
  });
}

export { getCanonicalSqliteMigrations, initializeLocalSqliteDatabase };

export interface DesktopRuntimeStatus {
  readonly schemaVersion: number;
  readonly pendingOutboxCount: number;
  readonly quarantinedOutboxCount: number;
  readonly queuedPrintJobs: number;
  readonly cachedBatchesCount: number;
}

export interface OfflineSyncSnapshotInput {
  readonly tenantId: string;
  readonly branding?: {
    readonly shopDisplayName?: string | null;
    readonly logoUrl?: string | null;
  };
  readonly policies?: {
    readonly batchPricingFallbackPolicy?: 'BLOCK_MISSING' | 'ALLOW_PRODUCT_FALLBACK';
    readonly defaultBatchAllocationPolicy?: 'FEFO' | 'FIFO';
  };
  readonly products?: readonly {
    readonly id: string;
    readonly sku: string;
    readonly name: string;
    readonly baseUom: string;
    readonly sellingPrice: string;
    readonly purchaseCost?: string;
    readonly primaryBarcode?: string | null;
    readonly barcodes?: readonly { readonly barcode: string; readonly barcodeType?: string; readonly uomCode?: string; readonly isPrimary?: boolean }[];
  }[];
  readonly batches?: readonly {
    readonly id: string;
    readonly productId: string;
    readonly warehouseId: string;
    readonly branchId?: string | null;
    readonly batchNumber: string;
    readonly status: string;
    readonly availableQuantity: string;
    readonly currentQuantity?: string;
    readonly reservedQuantity?: string;
    readonly sellingPrice?: string | null;
    readonly minSellingPrice?: string | null;
    readonly maxDiscountPct?: string | null;
    readonly batchPricingMode?: 'EXPLICIT' | 'INHERIT_PRODUCT';
    readonly internalBarcode?: string | null;
    readonly expiryDate?: string | null;
    readonly unitCost?: string;
    readonly receivedDate?: string;
  }[];
}

export interface OfflineBarcodeLookupResult {
  readonly matchType: 'INTERNAL_BATCH_BARCODE' | 'PRODUCT_BARCODE' | 'NOT_FOUND';
  readonly productId: string | null;
  readonly sku: string | null;
  readonly name: string | null;
  readonly baseUom: string | null;
  readonly batchId: string | null;
  readonly batchNumber: string | null;
  readonly internalBarcode: string | null;
  readonly availableQuantity: string | null;
  readonly sellingPrice: string | null;
  readonly pricingSource: 'EXPLICIT_BATCH_PRICE' | 'PRODUCT_DEFAULT_FALLBACK' | null;
  readonly expiryDate: string | null;
  readonly allocationPolicy: string | null;
  readonly isBlocked: boolean;
  readonly blockReason: string | null;
}

export interface QueueOfflineSaleInput {
  readonly tenantId: string;
  readonly branchId: string;
  readonly warehouseId: string;
  readonly registerId: string;
  readonly shiftId: string;
  readonly cashierUserId: string;
  readonly deviceId: string;
  readonly currencyCode: string;
  readonly grandTotal: string;
  readonly paymentMethod: 'CASH' | 'CARD' | 'OTHER';
  readonly tenderedAmount: string;
  readonly customerId?: string | null;
  readonly customerName?: string | null;
  readonly lines: readonly {
    readonly productId: string;
    readonly sku: string;
    readonly productName: string;
    readonly batchId?: string | null;
    readonly uomCode: string;
    readonly quantity: string;
    readonly unitPrice: string;
    readonly unitCostSnapshot: string;
    readonly lineTotal: string;
    readonly entrySource: string;
  }[];
}

export interface QueuePrintJobInput {
  readonly tenantId: string;
  readonly branchId?: string | null;
  readonly productId: string;
  readonly batchId: string;
  readonly barcodeValue: string;
  readonly labelFormat:
    | 'THERMAL_40X30'
    | 'THERMAL_50X30'
    | 'THERMAL_50X40'
    | 'THERMAL_58'
    | 'THERMAL_80'
    | 'A4_SHEET';
  readonly printQuantity: number;
  readonly isReprint: boolean;
  readonly printedByUserId: string;
}

export class DesktopOfflineStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    initializeLocalSqliteDatabase(db);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS nexstock_schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      ) STRICT;
    `);
    const migrations = getCanonicalSqliteMigrations();
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO nexstock_schema_migrations (version, name, applied_at) VALUES (?, ?, ?)`,
    );
    const now = new Date().toISOString();
    for (const m of migrations) {
      stmt.run(m.version, m.name, now);
    }
  }

  getStatus(): DesktopRuntimeStatus {
    const schemaRow = this.db
      .prepare('SELECT COALESCE(MAX(version), 0) AS v FROM nexstock_schema_migrations')
      .get() as { v: number };
    const pendingRow = this.db
      .prepare("SELECT COUNT(*) AS c FROM local_sync_outbox WHERE status = 'PENDING'")
      .get() as { c: number };
    const quarRow = this.db
      .prepare("SELECT COUNT(*) AS c FROM local_sync_outbox WHERE status = 'QUARANTINED'")
      .get() as { c: number };
    const printRow = this.db
      .prepare('SELECT COUNT(*) AS c FROM local_batch_barcode_print_queue WHERE synced = 0')
      .get() as { c: number };
    const batchRow = this.db
      .prepare('SELECT COUNT(*) AS c FROM local_batch_pricing_profiles')
      .get() as { c: number };

    return {
      schemaVersion: schemaRow.v,
      pendingOutboxCount: pendingRow.c,
      quarantinedOutboxCount: quarRow.c,
      queuedPrintJobs: printRow.c,
      cachedBatchesCount: batchRow.c,
    };
  }

  saveSyncSnapshot(snapshot: OfflineSyncSnapshotInput): { savedBatches: number; savedProducts: number } {
    const now = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (snapshot.branding || snapshot.policies) {
        this.db
          .prepare(
            `INSERT OR REPLACE INTO local_tenant_branding
             (tenant_id, shop_display_name, logo_url, batch_pricing_fallback_policy, default_batch_allocation_policy, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            snapshot.tenantId,
            snapshot.branding?.shopDisplayName ?? null,
            snapshot.branding?.logoUrl ?? null,
            snapshot.policies?.batchPricingFallbackPolicy ?? 'ALLOW_PRODUCT_FALLBACK',
            snapshot.policies?.defaultBatchAllocationPolicy ?? 'FEFO',
            now,
          );
      }

      let savedProducts = 0;
      for (const p of snapshot.products ?? []) {
        const sellingScaled = Math.round(Number.parseFloat(p.sellingPrice || '0') * 10000);
        const purchaseScaled = Math.round(Number.parseFloat(p.purchaseCost || '0') * 10000);
        this.db
          .prepare(
            `INSERT OR REPLACE INTO local_products
             (id, tenant_id, sku, name, description, product_type, status, category_id, base_uom, purchase_cost_scaled, selling_price_scaled, tax_group_id, track_inventory, reorder_point_micro, reorder_qty_micro, primary_barcode, sync_version, updated_at)
             VALUES (?, ?, ?, ?, NULL, 'STANDARD', 'ACTIVE', NULL, ?, ?, ?, NULL, 1, 0, 0, ?, 1, ?)`,
          )
          .run(
            p.id,
            snapshot.tenantId,
            p.sku,
            p.name,
            p.baseUom,
            purchaseScaled,
            sellingScaled,
            p.primaryBarcode ?? null,
            now,
          );
        for (const bc of p.barcodes ?? []) {
          const allowedType = ['EAN13', 'UPCA', 'CODE128', 'QR', 'CUSTOM'].includes(
            bc.barcodeType ?? 'CODE128',
          )
            ? (bc.barcodeType as string)
            : 'CODE128';
          this.db
            .prepare(
              `INSERT OR REPLACE INTO local_product_barcodes
               (id, tenant_id, product_id, barcode, barcode_type, uom_code, is_primary)
               VALUES (?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              randomUUID(),
              snapshot.tenantId,
              p.id,
              bc.barcode,
              allowedType,
              bc.uomCode ?? p.baseUom,
              bc.isPrimary ? 1 : 0,
            );
        }
        savedProducts++;
      }

      let savedBatches = 0;
      for (const b of snapshot.batches ?? []) {
        const baseStatus =
          b.status === 'QUARANTINED' ? 'QUARANTINED' : b.status === 'DEPLETED' ? 'DEPLETED' : 'ACTIVE';
        const curQty = b.currentQuantity ?? b.availableQuantity;
        this.db
          .prepare(
            `INSERT OR REPLACE INTO local_inventory_batches
             (id, tenant_id, product_id, warehouse_id, batch_number, supplier_id, status, received_date, manufacturing_date, expiry_date, initial_quantity, current_quantity, unit_cost, currency_code, quarantine_reason, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, NULL, ?, ?, NULL, ?, ?, ?, ?, 'LKR', NULL, ?, ?)`,
          )
          .run(
            b.id,
            snapshot.tenantId,
            b.productId,
            b.warehouseId,
            b.batchNumber,
            baseStatus,
            b.receivedDate ?? now,
            b.expiryDate ?? null,
            curQty,
            curQty,
            b.unitCost ?? '0.0000',
            now,
            now,
          );

        const mode = b.batchPricingMode ?? (b.sellingPrice ? 'EXPLICIT' : 'INHERIT_PRODUCT');
        this.db
          .prepare(
            `INSERT OR REPLACE INTO local_batch_pricing_profiles
             (tenant_id, batch_id, product_id, warehouse_id, branch_id, batch_number, status, reserved_quantity, available_quantity, selling_price, min_selling_price, max_discount_pct, batch_pricing_mode, internal_barcode, internal_barcode_type, sync_version, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'CODE128', 1, ?)`,
          )
          .run(
            snapshot.tenantId,
            b.id,
            b.productId,
            b.warehouseId,
            b.branchId ?? null,
            b.batchNumber,
            b.status,
            b.reservedQuantity ?? '0.000000',
            b.availableQuantity,
            b.sellingPrice ?? null,
            b.minSellingPrice ?? null,
            b.maxDiscountPct ?? null,
            mode,
            b.internalBarcode ?? null,
            now,
          );
        savedBatches++;
      }

      this.db.exec('COMMIT');
      return { savedBatches, savedProducts };
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  resolveBarcodeOffline(params: {
    readonly tenantId: string;
    readonly warehouseId: string;
    readonly code: string;
  }): OfflineBarcodeLookupResult {
    const code = params.code.trim();
    const today = new Date().toISOString().slice(0, 10);

    const directBatch = this.db
      .prepare(
        `SELECT bp.batch_id, bp.product_id, bp.batch_number, bp.status, bp.available_quantity,
                bp.batch_pricing_mode, bp.selling_price, ib.expiry_date
         FROM local_batch_pricing_profiles bp
         JOIN local_inventory_batches ib ON ib.tenant_id = bp.tenant_id AND ib.id = bp.batch_id
         WHERE bp.tenant_id = ? AND bp.internal_barcode = ? AND bp.warehouse_id = ?`,
      )
      .get(params.tenantId, code, params.warehouseId) as
      | {
          batch_id: string;
          product_id: string;
          batch_number: string;
          status: string;
          available_quantity: string;
          batch_pricing_mode: string;
          selling_price: string | null;
          expiry_date: string | null;
        }
      | undefined;

    if (directBatch) {
      const prod = this.db
        .prepare(
          'SELECT sku, name, base_uom, selling_price_scaled FROM local_products WHERE tenant_id = ? AND id = ?',
        )
        .get(params.tenantId, directBatch.product_id) as
        | { sku: string; name: string; base_uom: string; selling_price_scaled: number }
        | undefined;
      const isExpired =
        directBatch.status === 'EXPIRED' ||
        (directBatch.expiry_date !== null && directBatch.expiry_date < today);
      const isBlocked = isExpired || directBatch.status !== 'ACTIVE';
      const fallbackPrice = prod ? (prod.selling_price_scaled / 10000).toFixed(4) : null;
      const resolvedPrice =
        directBatch.selling_price ??
        (directBatch.batch_pricing_mode === 'INHERIT_PRODUCT' ? fallbackPrice : null);

      return {
        matchType: 'INTERNAL_BATCH_BARCODE',
        productId: directBatch.product_id,
        sku: prod?.sku ?? null,
        name: prod?.name ?? null,
        baseUom: prod?.base_uom ?? null,
        batchId: directBatch.batch_id,
        batchNumber: directBatch.batch_number,
        internalBarcode: code,
        availableQuantity: directBatch.available_quantity,
        sellingPrice: resolvedPrice,
        pricingSource: directBatch.selling_price ? 'EXPLICIT_BATCH_PRICE' : 'PRODUCT_DEFAULT_FALLBACK',
        expiryDate: directBatch.expiry_date,
        allocationPolicy: 'MANUAL',
        isBlocked,
        blockReason: isExpired
          ? 'POS_BATCH_EXPIRED'
          : directBatch.status !== 'ACTIVE'
            ? 'POS_BATCH_UNSELLABLE'
            : null,
      };
    }

    const prod = this.db
      .prepare(
        `SELECT id, sku, name, base_uom, selling_price_scaled
         FROM local_products
         WHERE tenant_id = ?
           AND (primary_barcode = ? OR id IN (SELECT product_id FROM local_product_barcodes WHERE tenant_id = ? AND barcode = ?))`,
      )
      .get(params.tenantId, code, params.tenantId, code) as
      | { id: string; sku: string; name: string; base_uom: string; selling_price_scaled: number }
      | undefined;

    if (prod) {
      const nextBatch = this.db
        .prepare(
          `SELECT bp.batch_id, bp.batch_number, bp.available_quantity, bp.selling_price, ib.expiry_date, bp.internal_barcode
           FROM local_batch_pricing_profiles bp
           JOIN local_inventory_batches ib ON ib.tenant_id = bp.tenant_id AND ib.id = bp.batch_id
           WHERE bp.tenant_id = ? AND bp.product_id = ? AND bp.warehouse_id = ?
             AND bp.status = 'ACTIVE'
             AND CAST(bp.available_quantity AS REAL) > 0
             AND (ib.expiry_date IS NULL OR ib.expiry_date >= ?)
           ORDER BY CASE WHEN ib.expiry_date IS NULL THEN 1 ELSE 0 END ASC, ib.expiry_date ASC, ib.received_date ASC
           LIMIT 1`,
        )
        .get(params.tenantId, prod.id, params.warehouseId, today) as
        | {
            batch_id: string;
            batch_number: string;
            available_quantity: string;
            selling_price: string | null;
            expiry_date: string | null;
            internal_barcode: string | null;
          }
        | undefined;

      const fallbackPrice = (prod.selling_price_scaled / 10000).toFixed(4);
      return {
        matchType: 'PRODUCT_BARCODE',
        productId: prod.id,
        sku: prod.sku,
        name: prod.name,
        baseUom: prod.base_uom,
        batchId: nextBatch?.batch_id ?? null,
        batchNumber: nextBatch?.batch_number ?? null,
        internalBarcode: nextBatch?.internal_barcode ?? null,
        availableQuantity: nextBatch?.available_quantity ?? null,
        sellingPrice: nextBatch?.selling_price ?? fallbackPrice,
        pricingSource: nextBatch?.selling_price ? 'EXPLICIT_BATCH_PRICE' : 'PRODUCT_DEFAULT_FALLBACK',
        expiryDate: nextBatch?.expiry_date ?? null,
        allocationPolicy: 'FEFO',
        isBlocked: false,
        blockReason: null,
      };
    }

    return {
      matchType: 'NOT_FOUND',
      productId: null,
      sku: null,
      name: null,
      baseUom: null,
      batchId: null,
      batchNumber: null,
      internalBarcode: null,
      availableQuantity: null,
      sellingPrice: null,
      pricingSource: null,
      expiryDate: null,
      allocationPolicy: null,
      isBlocked: false,
      blockReason: null,
    };
  }

  queueOfflineSale(input: QueueOfflineSaleInput): {
    invoiceId: string;
    invoiceNumber: string;
    commandId: string;
    syncPayload: Record<string, unknown>;
  } {
    const now = new Date().toISOString();
    const invoiceId = randomUUID();
    const commandId = randomUUID();
    const idempotencyKey = randomUUID();
    const invoiceNumber = `OFF-${invoiceId.replace(/-/g, '').slice(0, 10).toUpperCase()}`;

    const syncPayload = {
      registerId: input.registerId,
      shiftId: input.shiftId,
      customerId: input.customerId ?? null,
      customerName: input.customerName ?? null,
      lines: input.lines.map((l) => ({
        productId: l.productId,
        batchId: l.batchId ?? null,
        quantity: l.quantity,
        uomCode: l.uomCode,
        entrySource: l.entrySource,
        unitPrice: l.unitPrice,
      })),
      payments: [
        {
          paymentMethod: input.paymentMethod,
          amount: input.grandTotal,
          tenderedAmount: input.tenderedAmount,
        },
      ],
      offlineInvoiceNumber: invoiceNumber,
    };

    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare(
          `INSERT INTO local_sales_invoices
           (id, tenant_id, branch_id, warehouse_id, register_id, shift_id, customer_id, cashier_user_id, invoice_number, status, currency_code, subtotal_amount, grand_total, total_paid, customer_name, idempotency_key, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'COMPLETED', ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          invoiceId,
          input.tenantId,
          input.branchId,
          input.warehouseId,
          input.registerId,
          input.shiftId,
          input.customerId ?? null,
          input.cashierUserId,
          invoiceNumber,
          input.currencyCode,
          input.grandTotal,
          input.grandTotal,
          input.grandTotal,
          input.customerName ?? null,
          idempotencyKey,
          now,
        );

      input.lines.forEach((line, idx) => {
        const lineId = randomUUID();
        this.db
          .prepare(
            `INSERT INTO local_sales_invoice_lines
             (id, tenant_id, invoice_id, line_number, product_id, sku, product_name, uom_code, quantity, unit_price, line_total, unit_cost_snapshot, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            lineId,
            input.tenantId,
            invoiceId,
            idx + 1,
            line.productId,
            line.sku,
            line.productName,
            line.uomCode,
            line.quantity,
            line.unitPrice,
            line.lineTotal,
            line.unitCostSnapshot,
            now,
          );

        if (line.batchId) {
          this.db
            .prepare(
              `INSERT INTO local_sales_line_batch_links
               (line_id, tenant_id, invoice_id, batch_id, serial_id, unit_cost_snapshot, selling_price_snapshot, created_at)
               VALUES (?, ?, ?, ?, NULL, ?, ?, ?)`,
            )
            .run(
              lineId,
              input.tenantId,
              invoiceId,
              line.batchId,
              line.unitCostSnapshot,
              line.unitPrice,
              now,
            );

          const qtyNum = Number.parseFloat(line.quantity);
          if (Number.isFinite(qtyNum) && qtyNum > 0) {
            this.db
              .prepare(
                `UPDATE local_batch_pricing_profiles
                 SET available_quantity = printf('%.6f', MAX(0.0, CAST(available_quantity AS REAL) - ?)), updated_at = ?
                 WHERE tenant_id = ? AND batch_id = ?`,
              )
              .run(qtyNum, now, input.tenantId, line.batchId);
          }
        }
      });

      this.db
        .prepare(
          `INSERT INTO local_sync_outbox
           (command_id, tenant_id, branch_id, device_id, actor_user_id, command_type, schema_version, payload_json, occurred_at, status)
           VALUES (?, ?, ?, ?, ?, 'POS_RECORD_SALE', 1, ?, ?, 'PENDING')`,
        )
        .run(
          commandId,
          input.tenantId,
          input.branchId,
          input.deviceId,
          input.cashierUserId,
          JSON.stringify(syncPayload),
          now,
        );

      this.db.exec('COMMIT');
      return { invoiceId, invoiceNumber, commandId, syncPayload };
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  queuePrintJob(input: QueuePrintJobInput): { id: string; printedAt: string } {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO local_batch_barcode_print_queue
         (id, tenant_id, branch_id, product_id, batch_id, barcode_value, label_format, print_quantity, is_reprint, printed_by_user_id, printed_at, synced)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(
        id,
        input.tenantId,
        input.branchId ?? null,
        input.productId,
        input.batchId,
        input.barcodeValue,
        input.labelFormat,
        input.printQuantity,
        input.isReprint ? 1 : 0,
        input.printedByUserId,
        now,
      );
    return { id, printedAt: now };
  }

  getPendingOutboxCommands(tenantId: string, limit = 50): readonly {
    readonly commandId: string;
    readonly deviceId: string;
    readonly branchId: string;
    readonly commandType: string;
    readonly schemaVersion: number;
    readonly occurredAt: string;
    readonly payload: Record<string, unknown>;
  }[] {
    const rows = this.db
      .prepare(
        `SELECT command_id, device_id, branch_id, command_type, schema_version, occurred_at, payload_json
         FROM local_sync_outbox
         WHERE tenant_id = ? AND status = 'PENDING'
         ORDER BY local_seq ASC
         LIMIT ?`,
      )
      .all(tenantId, limit) as {
      command_id: string;
      device_id: string;
      branch_id: string;
      command_type: string;
      schema_version: number;
      occurred_at: string;
      payload_json: string;
    }[];

    return rows.map((r) => ({
      commandId: r.command_id,
      deviceId: r.device_id,
      branchId: r.branch_id,
      commandType: r.command_type,
      schemaVersion: r.schema_version,
      occurredAt: r.occurred_at,
      payload: JSON.parse(r.payload_json) as Record<string, unknown>,
    }));
  }

  markSyncPushResult(params: {
    readonly ackedCommandIds: readonly string[];
    readonly quarantinedCommands: readonly { readonly commandId: string; readonly reason: string }[];
  }): void {
    const now = new Date().toISOString();
    const ackStmt = this.db.prepare(
      "UPDATE local_sync_outbox SET status = 'SYNCED', server_ack_at = ? WHERE command_id = ?",
    );
    for (const id of params.ackedCommandIds) {
      ackStmt.run(now, id);
    }
    const quarStmt = this.db.prepare(
      "UPDATE local_sync_outbox SET status = 'QUARANTINED', last_error = ? WHERE command_id = ?",
    );
    for (const q of params.quarantinedCommands) {
      quarStmt.run(q.reason, q.commandId);
    }
  }
}

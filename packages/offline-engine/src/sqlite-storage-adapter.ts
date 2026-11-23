import { randomUUID } from 'node:crypto';
import type {
  OfflineClientPlatform,
  OfflineDataFreshness,
  OfflineDeviceContext,
  OfflineInventoryHistoryEntry,
  OfflineLocalInvoice,
  SyncCatalogPricingResponse,
  SyncConflictRecord,
  SyncPushBatchResponse,
} from '@nexstock/contracts';
import { initializeLocalSqliteDatabase } from '@nexstock/sqlite-schema';
import type {
  OfflineBarcodeLookupResult,
  OfflineBatchRecord,
  OfflineCategoryRecord,
  OfflineComputedCartLine,
  OfflineCustomerRecord,
  OfflineDeviceSecurityStateRecord,
  OfflineDraftCartRecord,
  OfflineLocalConflictRecord,
  OfflineOutboxCommandRecord,
  OfflineProductRecord,
  OfflineRecoveryBackupPayload,
  OfflineSerialRecord,
  OfflineTaxRateRecord,
  OfflineTransferRequestInput,
  OfflineTransferRequestRecord,
  OfflineUnitConversionRecord,
  OfflineStoragePort,
} from './types.js';

export interface SqlitePreparedStatementLike {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface SqliteDatabaseLike {
  exec(sql: string): unknown;
  prepare(sql: string): SqlitePreparedStatementLike;
}

export class SqliteOfflineStorageAdapter implements OfflineStoragePort {
  readonly platform: OfflineClientPlatform;
  private readonly db: SqliteDatabaseLike;

  constructor(db: SqliteDatabaseLike, platform: OfflineClientPlatform = 'TAURI_DESKTOP') {
    this.db = db;
    this.platform = platform;
    initializeLocalSqliteDatabase(db);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS nexstock_schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS local_subscription_entitlement (
        tenant_id TEXT PRIMARY KEY,
        snapshot_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
    `);
  }

  getDeviceContext(): OfflineDeviceContext | null {
    const devRow = this.db
      .prepare(
        `SELECT tenant_id, branch_id, warehouse_id, register_id, device_id, enrolled_at, offline_auth_expires_at
         FROM local_device_metadata WHERE singleton_id = 1`,
      )
      .get() as
      | {
          tenant_id: string;
          branch_id: string;
          warehouse_id: string;
          register_id: string | null;
          device_id: string;
          enrolled_at: string;
          offline_auth_expires_at: string;
        }
      | undefined;

    if (!devRow) return null;

    const permRow = this.db
      .prepare(
        `SELECT user_id, client_platform, all_locations_access, allowed_branch_ids_json,
                role_codes_json, permissions_json, offline_auth_expires_at
         FROM local_device_permissions WHERE tenant_id = ? LIMIT 1`,
      )
      .get(devRow.tenant_id) as
      | {
          user_id: string;
          client_platform: string;
          all_locations_access: number;
          allowed_branch_ids_json: string;
          role_codes_json: string;
          permissions_json: string;
          offline_auth_expires_at: string;
        }
      | undefined;

    const branchRow = this.db
      .prepare('SELECT code, name FROM local_branches WHERE tenant_id = ? AND id = ?')
      .get(devRow.tenant_id, devRow.branch_id) as { code: string; name: string } | undefined;

    const subRow = this.db
      .prepare('SELECT snapshot_json FROM local_subscription_entitlement WHERE tenant_id = ?')
      .get(devRow.tenant_id) as { snapshot_json: string } | undefined;

    return {
      deviceId: devRow.device_id,
      tenantId: devRow.tenant_id,
      branchId: devRow.branch_id,
      ...(branchRow ? { branchCode: branchRow.code, branchName: branchRow.name } : {}),
      warehouseId: devRow.warehouse_id,
      registerId: devRow.register_id,
      actorUserId: permRow?.user_id ?? '00000000-0000-0000-0000-000000000000',
      roleCodes: permRow ? (JSON.parse(permRow.role_codes_json) as string[]) : [],
      permissions: permRow ? (JSON.parse(permRow.permissions_json) as string[]) : [],
      allLocationsAccess: Boolean(permRow?.all_locations_access),
      allowedBranchIds: permRow
        ? (JSON.parse(permRow.allowed_branch_ids_json) as string[])
        : [devRow.branch_id],
      clientPlatform: (permRow?.client_platform as OfflineClientPlatform) ?? this.platform,
      enrolledAt: devRow.enrolled_at,
      offlineAuthExpiresAt: permRow?.offline_auth_expires_at ?? devRow.offline_auth_expires_at,
      ...(subRow
        ? {
            subscriptionSnapshot: JSON.parse(
              subRow.snapshot_json,
            ) as NonNullable<OfflineDeviceContext['subscriptionSnapshot']>,
          }
        : {}),
    };
  }

  saveDeviceContext(ctx: OfflineDeviceContext): void {
    const now = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO local_device_metadata
           (singleton_id, tenant_id, branch_id, warehouse_id, register_id, device_id, enrolled_at, offline_auth_expires_at)
           VALUES (1, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          ctx.tenantId,
          ctx.branchId,
          ctx.warehouseId,
          ctx.registerId ?? null,
          ctx.deviceId,
          ctx.enrolledAt,
          ctx.offlineAuthExpiresAt,
        );

      this.db
        .prepare(
          `INSERT OR REPLACE INTO local_device_permissions
           (tenant_id, user_id, device_id, client_platform, all_locations_access, allowed_branch_ids_json, role_codes_json, permissions_json, offline_auth_expires_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          ctx.tenantId,
          ctx.actorUserId,
          ctx.deviceId,
          ctx.clientPlatform,
          ctx.allLocationsAccess ? 1 : 0,
          JSON.stringify(ctx.allowedBranchIds),
          JSON.stringify(ctx.roleCodes),
          JSON.stringify(ctx.permissions),
          ctx.offlineAuthExpiresAt,
          now,
        );
      if (ctx.subscriptionSnapshot) {
        this.db
          .prepare(
            `INSERT OR REPLACE INTO local_subscription_entitlement
             (tenant_id, snapshot_json, updated_at)
             VALUES (?, ?, ?)`,
          )
          .run(ctx.tenantId, JSON.stringify(ctx.subscriptionSnapshot), now);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  saveSyncSnapshot(params: {
    readonly tenantId: string;
    readonly branchId: string;
    readonly snapshot: SyncCatalogPricingResponse;
  }): { savedProducts: number; savedCustomers: number; savedBatches: number; syncedAt: string } {
    const { tenantId, branchId, snapshot } = params;
    const now = snapshot.syncedAt || new Date().toISOString();
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
            tenantId,
            snapshot.branding?.shopDisplayName ?? null,
            snapshot.branding?.logoUrl ?? null,
            snapshot.policies?.batchPricingFallbackPolicy ?? 'ALLOW_PRODUCT_FALLBACK',
            snapshot.policies?.defaultBatchAllocationPolicy ?? 'FEFO',
            now,
          );
      }

      for (const c of snapshot.categories ?? []) {
        this.db
          .prepare(
            `INSERT OR REPLACE INTO local_categories
             (id, tenant_id, parent_id, name, description, status, sync_version, updated_at)
             VALUES (?, ?, ?, ?, NULL, ?, ?, ?)`,
          )
          .run(c.id, tenantId, c.parentId, c.name, c.status, c.syncVersion, now);
      }

      let savedProducts = 0;
      for (const p of snapshot.globalPrices) {
        const purchaseScaled = Math.round(Number.parseFloat(p.purchaseCost || '0') * 10000);
        const sellingScaled = Math.round(Number.parseFloat(p.sellingPrice || '0') * 10000);
        this.db
          .prepare(
            `INSERT OR REPLACE INTO local_products
             (id, tenant_id, sku, name, description, product_type, status, category_id, base_uom, purchase_cost_scaled, selling_price_scaled, tax_group_id, track_inventory, reorder_point_micro, reorder_qty_micro, primary_barcode, sync_version, updated_at)
             VALUES (?, ?, ?, ?, NULL, 'STANDARD', 'ACTIVE', ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)`,
          )
          .run(
            p.productId,
            tenantId,
            p.sku,
            p.name,
            p.categoryId ?? null,
            p.baseUom,
            purchaseScaled,
            sellingScaled,
            p.taxGroupId ?? null,
            p.trackInventory === false ? 0 : 1,
            p.primaryBarcode ?? null,
            p.syncVersion,
            now,
          );

        this.db
          .prepare(
            `INSERT OR REPLACE INTO local_product_uom_configs
             (product_id, tenant_id, product_qty_mode, measurement_category, purchase_uom, price_uom, allowed_selling_uoms_json, qty_decimal_precision, featured_pos, density_g_per_ml_micro, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?)`,
          )
          .run(
            p.productId,
            tenantId,
            p.productQtyMode ?? 'STANDARD',
            p.measurementCategory ?? null,
            p.baseUom,
            p.priceUom ?? p.baseUom,
            JSON.stringify(p.allowedSellingUoms ?? [p.baseUom]),
            p.qtyDecimalPrecision ?? 0,
            now,
          );

        this.db
          .prepare(
            `INSERT OR REPLACE INTO local_product_batch_policies
             (product_id, tenant_id, allocation_policy, require_batch_selling_price, updated_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(
            p.productId,
            tenantId,
            p.allocationPolicy ?? 'FEFO',
            p.requireBatchSellingPrice ? 1 : 0,
            now,
          );
        savedProducts++;
      }

      for (const bc of snapshot.barcodes ?? []) {
        const allowedType = ['EAN13', 'UPCA', 'CODE128', 'QR', 'CUSTOM'].includes(bc.barcodeType)
          ? bc.barcodeType
          : 'CODE128';
        this.db
          .prepare(
            `INSERT OR REPLACE INTO local_product_barcodes
             (id, tenant_id, product_id, barcode, barcode_type, uom_code, is_primary)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(bc.id, tenantId, bc.productId, bc.barcode, allowedType, bc.uomCode, bc.isPrimary ? 1 : 0);
        this.db
          .prepare(
            `INSERT OR REPLACE INTO local_barcode_intake_mappings
             (barcode_id, tenant_id, product_id, barcode, uom_code, stock_intake_lot_id, batch_id, conversion_factor_to_base, price_source_mode, selling_price_override, is_active, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            bc.id,
            tenantId,
            bc.productId,
            bc.barcode,
            bc.uomCode,
            bc.stockIntakeLotId ?? null,
            bc.batchId ?? null,
            bc.conversionFactorToBase ?? null,
            bc.priceSourceMode ?? 'INHERIT',
            bc.sellingPriceOverride ?? null,
            bc.isActive === false ? 0 : 1,
            now,
          );
      }

      for (const uc of snapshot.unitConversions ?? []) {
        const factorMicro = Math.round(Number.parseFloat(uc.conversionFactorToBase || '1') * 1_000_000);
        this.db
          .prepare(
            `INSERT OR REPLACE INTO local_product_unit_conversions
             (id, tenant_id, product_id, uom_code, uom_name, conversion_factor_micro, is_active)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(uc.id, tenantId, uc.productId, uc.uomCode, uc.uomName, Math.max(1, factorMicro), uc.isActive ? 1 : 0);
        this.db
          .prepare(
            `INSERT OR REPLACE INTO local_uom_package_pricing
             (conversion_id, tenant_id, product_id, uom_code, selling_price, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(uc.id, tenantId, uc.productId, uc.uomCode, uc.sellingPrice ?? null, now);
      }

      for (const lot of snapshot.intakeLots ?? []) {
        this.db
          .prepare(
            `INSERT OR REPLACE INTO local_stock_intake_lots
             (id, tenant_id, branch_id, warehouse_id, product_id, batch_id, intake_code, source_method, received_uom, received_qty, conversion_factor_to_base, base_qty_received, base_qty_remaining, purchase_cost_per_base_uom, selling_price, selling_uom, pricing_mode, status, is_legacy_aggregate, received_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            lot.id,
            tenantId,
            lot.branchId,
            lot.warehouseId,
            lot.productId,
            lot.batchId ?? null,
            lot.intakeCode,
            lot.sourceMethod,
            lot.receivedUom,
            lot.receivedQty,
            lot.conversionFactorToBase,
            lot.baseQtyReceived,
            lot.baseQtyRemaining,
            lot.purchaseCostPerBaseUom,
            lot.sellingPrice ?? null,
            lot.sellingUom,
            lot.pricingMode ?? 'INHERIT_PRODUCT',
            lot.status,
            lot.isLegacyAggregate ? 1 : 0,
            lot.receivedAt,
            now,
          );
      }

      for (const ov of snapshot.branchOverrides) {
        const sellScaled = Math.round(Number.parseFloat(ov.sellingPrice || '0') * 10000);
        const minScaled = ov.minSellingPrice
          ? Math.round(Number.parseFloat(ov.minSellingPrice) * 10000)
          : null;
        const maxDiscX100 = ov.maxDiscountPct
          ? Math.round(Number.parseFloat(ov.maxDiscountPct) * 100)
          : null;
        this.db
          .prepare(
            `INSERT OR REPLACE INTO local_product_branch_prices
             (id, tenant_id, product_id, branch_id, selling_price_scaled, min_selling_price_scaled, max_discount_pct_x100, effective_date, is_active, sync_version, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            ov.id,
            tenantId,
            ov.productId,
            ov.branchId,
            sellScaled,
            minScaled,
            maxDiscX100,
            ov.effectiveDate,
            ov.isActive ? 1 : 0,
            ov.syncVersion,
            now,
          );
      }

      for (const tg of snapshot.taxGroups ?? []) {
        this.db
          .prepare(
            `INSERT OR REPLACE INTO local_tax_groups
             (id, tenant_id, code, name, is_active, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(tg.id, tenantId, tg.code, tg.name, tg.isActive ? 1 : 0, now);
      }

      for (const tr of snapshot.taxRates ?? []) {
        this.db
          .prepare(
            `INSERT OR REPLACE INTO local_tax_rates
             (id, tenant_id, tax_group_id, code, name, rate_percentage, is_compound, priority, is_active, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            tr.id,
            tenantId,
            tr.taxGroupId,
            tr.code,
            tr.name,
            tr.ratePercentage,
            tr.isCompound ? 1 : 0,
            tr.priority,
            tr.isActive ? 1 : 0,
            now,
          );
      }

      let savedCustomers = 0;
      for (const cu of snapshot.customers ?? []) {
        this.db
          .prepare(
            `INSERT OR REPLACE INTO local_customers
             (id, tenant_id, customer_number, name, phone, email, status, sync_version, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
          )
          .run(cu.id, tenantId, cu.customerNumber, cu.name, cu.phone, cu.email, cu.status, now);
        savedCustomers++;
      }

      for (const br of snapshot.branches ?? []) {
        this.db
          .prepare(
            `INSERT OR REPLACE INTO local_branches
             (id, tenant_id, code, name, is_main_branch, is_active, default_warehouse_id, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(br.id, tenantId, br.code, br.name, br.isMainBranch ? 1 : 0, br.isActive ? 1 : 0, br.defaultWarehouseId, now);
      }

      for (const wh of snapshot.warehouses ?? []) {
        this.db
          .prepare(
            `INSERT OR REPLACE INTO local_warehouses
             (id, tenant_id, branch_id, code, name, allow_negative_stock, is_active, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(wh.id, tenantId, wh.branchId, wh.code, wh.name, wh.allowNegativeStock ? 1 : 0, wh.isActive ? 1 : 0, now);
      }

      for (const reg of snapshot.registers ?? []) {
        this.db
          .prepare(
            `INSERT OR REPLACE INTO local_pos_registers
             (id, tenant_id, branch_id, warehouse_id, code, name, is_active, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(reg.id, tenantId, reg.branchId, reg.warehouseId, reg.code, reg.name, reg.isActive ? 1 : 0, now);
      }

      // Preserve existing local_pending_qty_delta_micro on balances during refresh (Option A!)
      for (const bal of snapshot.balances ?? []) {
        const existingBal = this.db
          .prepare(
            `SELECT local_pending_qty_delta_micro FROM local_inventory_balances
             WHERE tenant_id = ? AND warehouse_id = ? AND variant_id = ?`,
          )
          .get(tenantId, bal.warehouseId, bal.productId) as
          | { local_pending_qty_delta_micro: number }
          | undefined;

        const onHandMicro = Math.round(Number.parseFloat(bal.qtyOnHand || '0') * 1_000_000);
        const reservedMicro = Math.round(Number.parseFloat(bal.qtyReserved || '0') * 1_000_000);
        const pendingDeltaMicro = existingBal?.local_pending_qty_delta_micro ?? 0;

        this.db
          .prepare(
            `INSERT OR REPLACE INTO local_inventory_balances
             (tenant_id, warehouse_id, variant_id, server_qty_on_hand_micro, server_qty_reserved_micro, local_pending_qty_delta_micro, server_sync_version, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
          )
          .run(tenantId, bal.warehouseId, bal.productId, onHandMicro, reservedMicro, pendingDeltaMicro, now);
      }

      let savedBatches = 0;
      for (const b of snapshot.batches ?? []) {
        const baseStatus =
          b.status === 'QUARANTINED' ? 'QUARANTINED' : b.status === 'DEPLETED' ? 'DEPLETED' : 'ACTIVE';
        this.db
          .prepare(
            `INSERT OR REPLACE INTO local_inventory_batches
             (id, tenant_id, product_id, warehouse_id, batch_number, supplier_id, status, received_date, manufacturing_date, expiry_date, initial_quantity, current_quantity, unit_cost, currency_code, quarantine_reason, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, NULL, ?, ?, NULL, ?, ?, ?, ?, ?, NULL, ?, ?)`,
          )
          .run(
            b.batchId,
            tenantId,
            b.productId,
            b.warehouseId,
            b.batchNumber,
            baseStatus,
            b.receivedDate,
            b.expiryDate,
            b.availableQuantity,
            b.availableQuantity,
            b.unitCost,
            snapshot.currencyCode,
            now,
            now,
          );

        this.db
          .prepare(
            `INSERT OR REPLACE INTO local_batch_pricing_profiles
             (tenant_id, batch_id, product_id, warehouse_id, branch_id, batch_number, status, reserved_quantity, available_quantity, selling_price, min_selling_price, max_discount_pct, batch_pricing_mode, internal_barcode, internal_barcode_type, sync_version, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, '0.000000', ?, ?, ?, ?, ?, ?, 'CODE128', 1, ?)`,
          )
          .run(
            tenantId,
            b.batchId,
            b.productId,
            b.warehouseId,
            b.branchId,
            b.batchNumber,
            b.status,
            b.availableQuantity,
            b.sellingPrice,
            b.minSellingPrice,
            b.maxDiscountPct,
            b.batchPricingMode,
            b.internalBarcode,
            now,
          );
        savedBatches++;
      }

      for (const ser of snapshot.serials ?? []) {
        const mappedStatus = ser.status === 'IN_STOCK' ? 'IN_STOCK' : 'SOLD';
        this.db
          .prepare(
            `INSERT OR REPLACE INTO local_inventory_serials
             (id, tenant_id, product_id, batch_id, warehouse_id, branch_id, serial_number, status, unit_cost, currency_code, received_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            ser.id,
            tenantId,
            ser.productId,
            ser.batchId,
            ser.warehouseId,
            ser.branchId,
            ser.serialNumber,
            mappedStatus,
            ser.unitCost,
            snapshot.currencyCode,
            now,
            now,
            now,
          );
      }

      const countsJson = JSON.stringify({
        products: savedProducts,
        categories: (snapshot.categories ?? []).length,
        barcodes: (snapshot.barcodes ?? []).length,
        customers: savedCustomers,
        batches: savedBatches,
        serials: (snapshot.serials ?? []).length,
      });

      this.db
        .prepare(
          `INSERT OR REPLACE INTO local_snapshot_freshness
           (tenant_id, branch_id, last_successful_refresh_at, snapshot_version, counts_json, updated_at)
           VALUES (?, ?, ?, COALESCE((SELECT snapshot_version + 1 FROM local_snapshot_freshness WHERE tenant_id = ? AND branch_id = ?), 1), ?, ?)`,
        )
        .run(tenantId, branchId, now, tenantId, branchId, countsJson, now);

      this.db.exec('COMMIT');
      return { savedProducts, savedCustomers, savedBatches, syncedAt: now };
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  getDataFreshness(params: {
    readonly tenantId: string;
    readonly branchId: string;
    readonly staleAfterMinutes?: number;
  }): OfflineDataFreshness {
    const staleAfterMinutes = params.staleAfterMinutes ?? 720;
    const row = this.db
      .prepare(
        `SELECT last_successful_refresh_at, snapshot_version, counts_json
         FROM local_snapshot_freshness WHERE tenant_id = ? AND branch_id = ?`,
      )
      .get(params.tenantId, params.branchId) as
      | { last_successful_refresh_at: string; snapshot_version: number; counts_json: string }
      | undefined;

    const pendingRow = this.db
      .prepare(
        `SELECT COUNT(*) AS c FROM local_sync_outbox WHERE tenant_id = ? AND status IN ('PENDING', 'IN_FLIGHT')`,
      )
      .get(params.tenantId) as { c: number };

    const lastRefresh = row?.last_successful_refresh_at ?? null;
    const isStale =
      !lastRefresh ||
      Date.now() - Date.parse(lastRefresh) > staleAfterMinutes * 60 * 1000;
    const countsParsed = row ? (JSON.parse(row.counts_json) as Record<string, number>) : {};

    return {
      tenantId: params.tenantId,
      branchId: params.branchId,
      lastSuccessfulRefreshAt: lastRefresh,
      snapshotVersion: row?.snapshot_version ?? 0,
      staleAfterMinutes,
      isStale,
      counts: {
        products: countsParsed.products ?? 0,
        categories: countsParsed.categories ?? 0,
        barcodes: countsParsed.barcodes ?? 0,
        customers: countsParsed.customers ?? 0,
        batches: countsParsed.batches ?? 0,
        serials: countsParsed.serials ?? 0,
        pendingOutbox: pendingRow.c,
      },
    };
  }

  listCategories(tenantId: string): readonly OfflineCategoryRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, tenant_id, parent_id, name, status, sync_version
         FROM local_categories WHERE tenant_id = ? AND status = 'ACTIVE' ORDER BY name ASC`,
      )
      .all(tenantId) as {
      id: string;
      tenant_id: string;
      parent_id: string | null;
      name: string;
      status: 'ACTIVE' | 'ARCHIVED';
      sync_version: number;
    }[];
    return rows.map((r) => ({
      id: r.id,
      tenantId: r.tenant_id,
      parentId: r.parent_id,
      name: r.name,
      status: r.status,
      syncVersion: r.sync_version,
    }));
  }

  searchProducts(params: {
    readonly tenantId: string;
    readonly branchId: string;
    readonly warehouseId: string;
    readonly query?: string;
    readonly categoryId?: string | null;
    readonly limit?: number;
  }): readonly OfflineProductRecord[] {
    const q = (params.query ?? '').trim().toLowerCase();
    const limit = params.limit ?? 100;
    const rows = this.db
      .prepare(
        `SELECT p.id, p.tenant_id, p.sku, p.name, p.category_id, p.base_uom,
                p.purchase_cost_scaled, p.selling_price_scaled, p.tax_group_id,
                p.track_inventory, p.primary_barcode,
                uc.product_qty_mode, uc.measurement_category, uc.price_uom,
                uc.allowed_selling_uoms_json, uc.qty_decimal_precision,
                bp.allocation_policy, bp.require_batch_selling_price,
                ov.selling_price_scaled AS ov_selling_scaled,
                ov.min_selling_price_scaled AS ov_min_scaled,
                ov.max_discount_pct_x100 AS ov_max_disc_x100,
                ib.server_qty_on_hand_micro, ib.server_qty_reserved_micro, ib.local_pending_qty_delta_micro
         FROM local_products p
         LEFT JOIN local_product_uom_configs uc ON uc.product_id = p.id
         LEFT JOIN local_product_batch_policies bp ON bp.product_id = p.id
         LEFT JOIN local_product_branch_prices ov
           ON ov.tenant_id = p.tenant_id AND ov.product_id = p.id AND ov.branch_id = ? AND ov.is_active = 1
         LEFT JOIN local_inventory_balances ib
           ON ib.tenant_id = p.tenant_id AND ib.warehouse_id = ? AND ib.variant_id = p.id
         WHERE p.tenant_id = ? AND p.status = 'ACTIVE'
         ORDER BY p.name ASC`,
      )
      .all(params.branchId, params.warehouseId, params.tenantId) as {
      id: string;
      tenant_id: string;
      sku: string;
      name: string;
      category_id: string | null;
      base_uom: string;
      purchase_cost_scaled: number;
      selling_price_scaled: number;
      tax_group_id: string | null;
      track_inventory: number;
      primary_barcode: string | null;
      product_qty_mode: string | null;
      measurement_category: string | null;
      price_uom: string | null;
      allowed_selling_uoms_json: string | null;
      qty_decimal_precision: number | null;
      allocation_policy: string | null;
      require_batch_selling_price: number | null;
      ov_selling_scaled: number | null;
      ov_min_scaled: number | null;
      ov_max_disc_x100: number | null;
      server_qty_on_hand_micro: number | null;
      server_qty_reserved_micro: number | null;
      local_pending_qty_delta_micro: number | null;
    }[];

    const matched: OfflineProductRecord[] = [];
    for (const r of rows) {
      if (params.categoryId && r.category_id !== params.categoryId) continue;
      if (q) {
        const hay = `${r.sku} ${r.name} ${r.primary_barcode ?? ''}`.toLowerCase();
        if (!hay.includes(q)) continue;
      }
      const hasBatches = this.db
        .prepare(
          `SELECT COUNT(*) AS c FROM local_batch_pricing_profiles WHERE tenant_id = ? AND warehouse_id = ? AND product_id = ? AND status = 'ACTIVE'`,
        )
        .get(params.tenantId, params.warehouseId, r.id) as { c: number };
      const trackingMode = hasBatches.c > 0 ? 'BATCH_EXPIRY' : 'NONE';

      const srvMicro = (r.server_qty_on_hand_micro ?? 0) - (r.server_qty_reserved_micro ?? 0);
      const pendingDelta = r.local_pending_qty_delta_micro ?? 0;
      const availMicro = Math.max(0, srvMicro + pendingDelta);
      const effScaled = r.ov_selling_scaled ?? r.selling_price_scaled;

      matched.push({
        id: r.id,
        tenantId: r.tenant_id,
        sku: r.sku,
        name: r.name,
        categoryId: r.category_id,
        baseUom: r.base_uom,
        priceUom: r.price_uom ?? r.base_uom,
        purchaseCost: (r.purchase_cost_scaled / 10000).toFixed(4),
        sellingPrice: (r.selling_price_scaled / 10000).toFixed(4),
        effectivePrice: (effScaled / 10000).toFixed(4),
        minSellingPrice: r.ov_min_scaled != null ? (r.ov_min_scaled / 10000).toFixed(4) : null,
        maxDiscountPct: r.ov_max_disc_x100 != null ? (r.ov_max_disc_x100 / 100).toFixed(2) : null,
        valuationMethod: 'MOVING_AVG',
        trackingMode,
        allocationPolicy: (r.allocation_policy as 'FEFO' | 'FIFO' | 'MANUAL') ?? 'FEFO',
        requireBatchSellingPrice: Boolean(r.require_batch_selling_price),
        productQtyMode: (r.product_qty_mode as 'STANDARD' | 'VARIABLE') ?? 'STANDARD',
        measurementCategory:
          (r.measurement_category as 'WEIGHT' | 'VOLUME' | 'COUNT' | 'LENGTH' | null) ?? null,
        allowedSellingUoms: r.allowed_selling_uoms_json
          ? (JSON.parse(r.allowed_selling_uoms_json) as string[])
          : [r.base_uom],
        qtyDecimalPrecision: r.qty_decimal_precision ?? 0,
        taxGroupId: r.tax_group_id,
        trackInventory: r.track_inventory === 1,
        primaryBarcode: r.primary_barcode,
        availableQuantity: (availMicro / 1_000_000).toFixed(6),
        serverQuantity: (Math.max(0, srvMicro) / 1_000_000).toFixed(6),
        localPendingDelta: (pendingDelta / 1_000_000).toFixed(6),
        movingAvgCost: (r.purchase_cost_scaled / 10000).toFixed(4),
      });
      if (matched.length >= limit) break;
    }

    return matched;
  }

  getProductById(params: {
    readonly tenantId: string;
    readonly branchId: string;
    readonly warehouseId: string;
    readonly productId: string;
  }): OfflineProductRecord | null {
    const items = this.searchProducts({
      tenantId: params.tenantId,
      branchId: params.branchId,
      warehouseId: params.warehouseId,
      limit: 500,
    });
    return items.find((p) => p.id === params.productId) ?? null;
  }

  getProductUnitConversions(params: {
    readonly tenantId: string;
    readonly productId: string;
  }): readonly OfflineUnitConversionRecord[] {
    const rows = this.db
      .prepare(
        `SELECT uc.product_id, uc.uom_code, uc.uom_name, uc.conversion_factor_micro, upp.selling_price
         FROM local_product_unit_conversions uc
         LEFT JOIN local_uom_package_pricing upp
           ON upp.tenant_id = uc.tenant_id AND upp.conversion_id = uc.id
         WHERE uc.tenant_id = ? AND uc.product_id = ? AND uc.is_active = 1`,
      )
      .all(params.tenantId, params.productId) as {
      product_id: string;
      uom_code: string;
      uom_name: string;
      conversion_factor_micro: number;
      selling_price: string | null;
    }[];
    return rows.map((r) => ({
      productId: r.product_id,
      uomCode: r.uom_code,
      uomName: r.uom_name,
      conversionFactorToBase: (r.conversion_factor_micro / 1_000_000).toFixed(6),
      sellingPrice: r.selling_price ?? null,
    }));
  }

  getTaxRatesForGroup(params: {
    readonly tenantId: string;
    readonly taxGroupId: string;
  }): readonly OfflineTaxRateRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, tax_group_id, code, name, rate_percentage, is_compound, priority
         FROM local_tax_rates
         WHERE tenant_id = ? AND tax_group_id = ? AND is_active = 1
         ORDER BY priority ASC`,
      )
      .all(params.tenantId, params.taxGroupId) as {
      id: string;
      tax_group_id: string;
      code: string;
      name: string;
      rate_percentage: string;
      is_compound: number;
      priority: number;
    }[];
    return rows.map((r) => ({
      id: r.id,
      taxGroupId: r.tax_group_id,
      code: r.code,
      name: r.name,
      ratePercentage: r.rate_percentage,
      isCompound: r.is_compound === 1,
      priority: r.priority,
    }));
  }

  listBatchesForProduct(params: {
    readonly tenantId: string;
    readonly warehouseId: string;
    readonly productId: string;
  }): readonly OfflineBatchRecord[] {
    const rows = this.db
      .prepare(
        `SELECT bp.batch_id, bp.product_id, bp.warehouse_id, bp.branch_id, bp.batch_number,
                bp.status, bp.available_quantity, bp.selling_price, bp.min_selling_price,
                bp.max_discount_pct, bp.batch_pricing_mode, bp.internal_barcode,
                ib.expiry_date, ib.received_date, ib.unit_cost
         FROM local_batch_pricing_profiles bp
         JOIN local_inventory_batches ib ON ib.tenant_id = bp.tenant_id AND ib.id = bp.batch_id
         WHERE bp.tenant_id = ? AND bp.warehouse_id = ? AND bp.product_id = ?`,
      )
      .all(params.tenantId, params.warehouseId, params.productId) as {
      batch_id: string;
      product_id: string;
      warehouse_id: string;
      branch_id: string | null;
      batch_number: string;
      status: string;
      available_quantity: string;
      selling_price: string | null;
      min_selling_price: string | null;
      max_discount_pct: string | null;
      batch_pricing_mode: 'EXPLICIT' | 'INHERIT_PRODUCT';
      internal_barcode: string | null;
      expiry_date: string | null;
      received_date: string;
      unit_cost: string;
    }[];
    return rows.map((b) => ({
      batchId: b.batch_id,
      productId: b.product_id,
      warehouseId: b.warehouse_id,
      branchId: b.branch_id,
      batchNumber: b.batch_number,
      status: b.status,
      availableQuantity: b.available_quantity,
      unitCost: b.unit_cost,
      sellingPrice: b.selling_price,
      minSellingPrice: b.min_selling_price,
      maxDiscountPct: b.max_discount_pct,
      batchPricingMode: b.batch_pricing_mode,
      internalBarcode: b.internal_barcode,
      expiryDate: b.expiry_date,
      receivedDate: b.received_date,
    }));
  }

  resolveBarcode(params: {
    readonly tenantId: string;
    readonly branchId: string;
    readonly warehouseId: string;
    readonly code: string;
  }): OfflineBarcodeLookupResult {
    const code = params.code.trim();
    const today = new Date().toISOString().slice(0, 10);

    // 1. Direct internal batch barcode match (locks exact batch)
    const directBatch = this.db
      .prepare(
        `SELECT bp.batch_id, bp.product_id, bp.batch_number, bp.status, bp.available_quantity,
                bp.batch_pricing_mode, bp.selling_price, bp.internal_barcode, ib.expiry_date
         FROM local_batch_pricing_profiles bp
         JOIN local_inventory_batches ib ON ib.tenant_id = bp.tenant_id AND ib.id = bp.batch_id
         WHERE bp.tenant_id = ? AND bp.warehouse_id = ? AND bp.internal_barcode = ?`,
      )
      .get(params.tenantId, params.warehouseId, code) as
      | {
          batch_id: string;
          product_id: string;
          batch_number: string;
          status: string;
          available_quantity: string;
          batch_pricing_mode: string;
          selling_price: string | null;
          internal_barcode: string | null;
          expiry_date: string | null;
        }
      | undefined;

    if (directBatch) {
      const prod = this.getProductById({
        tenantId: params.tenantId,
        branchId: params.branchId,
        warehouseId: params.warehouseId,
        productId: directBatch.product_id,
      });
      const isExpired =
        directBatch.status === 'EXPIRED' ||
        Boolean(directBatch.expiry_date && directBatch.expiry_date < today);
      const isBlocked =
        isExpired ||
        directBatch.status !== 'ACTIVE' ||
        Number.parseFloat(directBatch.available_quantity) <= 0;

      return {
        matchType: 'INTERNAL_BATCH_BARCODE',
        productId: directBatch.product_id,
        sku: prod?.sku ?? null,
        name: prod?.name ?? null,
        baseUom: prod?.baseUom ?? null,
        priceUom: prod?.priceUom ?? null,
        batchId: directBatch.batch_id,
        batchNumber: directBatch.batch_number,
        serialId: null,
        serialNumber: null,
        internalBarcode: directBatch.internal_barcode,
        availableQuantity: directBatch.available_quantity,
        sellingPrice:
          directBatch.batch_pricing_mode === 'EXPLICIT' && directBatch.selling_price
            ? directBatch.selling_price
            : (prod?.effectivePrice ?? null),
        pricingSource:
          directBatch.batch_pricing_mode === 'EXPLICIT' && directBatch.selling_price
            ? 'EXPLICIT_BATCH_PRICE'
            : 'PRODUCT_DEFAULT',
        expiryDate: directBatch.expiry_date,
        allocationPolicy: 'MANUAL',
        isBlocked,
        blockReason: isExpired
          ? 'BATCH_EXPIRED'
          : directBatch.status !== 'ACTIVE'
            ? `BATCH_${directBatch.status}`
            : Number.parseFloat(directBatch.available_quantity) <= 0
              ? 'BATCH_DEPLETED'
              : null,
      };
    }

    // 2. Product barcode / primary barcode / SKU lookup (including intake lot & package UoM mapping)
    const barcodeMapRow = this.db
      .prepare(
        `SELECT product_id, uom_code, stock_intake_lot_id, batch_id, conversion_factor_to_base,
                price_source_mode, selling_price_override, is_active
         FROM local_barcode_intake_mappings
         WHERE tenant_id = ? AND barcode = ?
         ORDER BY is_active DESC
         LIMIT 1`,
      )
      .get(params.tenantId, code) as
      | {
          product_id: string;
          uom_code: string;
          stock_intake_lot_id: string | null;
          batch_id: string | null;
          conversion_factor_to_base: string | null;
          price_source_mode: string;
          selling_price_override: string | null;
          is_active: number;
        }
      | undefined;

    if (barcodeMapRow && barcodeMapRow.is_active === 0) {
      const prod = this.getProductById({
        tenantId: params.tenantId,
        branchId: params.branchId,
        warehouseId: params.warehouseId,
        productId: barcodeMapRow.product_id,
      });
      return {
        matchType: 'PRODUCT_BARCODE',
        productId: barcodeMapRow.product_id,
        sku: prod?.sku ?? null,
        name: prod?.name ?? null,
        baseUom: prod?.baseUom ?? null,
        priceUom: prod?.priceUom ?? null,
        resolvedSellingUom: barcodeMapRow.uom_code,
        resolvedConversionFactorToBase: barcodeMapRow.conversion_factor_to_base ?? '1.000000',
        stockIntakeLotId: barcodeMapRow.stock_intake_lot_id,
        intakeCode: null,
        batchId: barcodeMapRow.batch_id,
        batchNumber: null,
        serialId: null,
        serialNumber: null,
        internalBarcode: null,
        availableQuantity: '0.000000',
        sellingPrice: prod?.effectivePrice ?? null,
        pricingSource: 'PRODUCT_DEFAULT',
        expiryDate: null,
        allocationPolicy: null,
        isBlocked: true,
        blockReason: 'BARCODE_INACTIVE',
      };
    }

    const prodMatch = barcodeMapRow
      ? { id: barcodeMapRow.product_id }
      : (this.db
          .prepare(
            `SELECT id FROM local_products WHERE tenant_id = ? AND (primary_barcode = ? OR UPPER(sku) = UPPER(?))
             UNION
             SELECT product_id AS id FROM local_product_barcodes WHERE tenant_id = ? AND barcode = ?
             LIMIT 1`,
          )
          .get(params.tenantId, code, code, params.tenantId, code) as { id: string } | undefined);

    if (prodMatch) {
      const prod = this.getProductById({
        tenantId: params.tenantId,
        branchId: params.branchId,
        warehouseId: params.warehouseId,
        productId: prodMatch.id,
      });
      if (prod) {
        const resolvedUom = (barcodeMapRow?.uom_code || prod.baseUom).toUpperCase();
        const convs = this.getProductUnitConversions({
          tenantId: params.tenantId,
          productId: prod.id,
        });
        const matchedConv = convs.find((c) => c.uomCode.toUpperCase() === resolvedUom);
        const resolvedConvFactor =
          resolvedUom === prod.baseUom.toUpperCase()
            ? '1.000000'
            : (barcodeMapRow?.conversion_factor_to_base ??
              matchedConv?.conversionFactorToBase ??
              '1.000000');

        if (barcodeMapRow?.stock_intake_lot_id) {
          const intakeLot = this.db
            .prepare(
              `SELECT id, warehouse_id, intake_code, base_qty_remaining, selling_price, pricing_mode, status
               FROM local_stock_intake_lots
               WHERE tenant_id = ? AND id = ?`,
            )
            .get(params.tenantId, barcodeMapRow.stock_intake_lot_id) as
            | {
                id: string;
                warehouse_id: string;
                intake_code: string;
                base_qty_remaining: string;
                selling_price: string | null;
                pricing_mode: string;
                status: string;
              }
            | undefined;

          const remQty = Number.parseFloat(intakeLot?.base_qty_remaining ?? '0');
          const reqQty = Number.parseFloat(resolvedConvFactor || '1');
          const isIntakeBlocked =
            !intakeLot ||
            intakeLot.warehouse_id !== params.warehouseId ||
            intakeLot.status !== 'ACTIVE' ||
            remQty < reqQty;
          const baseUnitSellPrice =
            intakeLot?.pricing_mode === 'INTAKE_SPECIFIC' && intakeLot.selling_price
              ? intakeLot.selling_price
              : prod.effectivePrice;
          const resolvedSellPrice =
            barcodeMapRow.selling_price_override ??
            (resolvedUom !== prod.baseUom.toUpperCase() && matchedConv?.sellingPrice
              ? matchedConv.sellingPrice
              : resolvedUom !== prod.baseUom.toUpperCase()
                ? (Number.parseFloat(baseUnitSellPrice) * reqQty).toFixed(4)
                : baseUnitSellPrice);

          return {
            matchType: 'PRODUCT_BARCODE',
            productId: prod.id,
            sku: prod.sku,
            name: prod.name,
            baseUom: prod.baseUom,
            priceUom: prod.priceUom,
            resolvedSellingUom: resolvedUom,
            resolvedConversionFactorToBase: resolvedConvFactor,
            stockIntakeLotId: intakeLot?.id ?? barcodeMapRow.stock_intake_lot_id,
            intakeCode: intakeLot?.intake_code ?? null,
            batchId: null,
            batchNumber: null,
            serialId: null,
            serialNumber: null,
            internalBarcode: null,
            availableQuantity: intakeLot?.base_qty_remaining ?? '0.000000',
            sellingPrice: resolvedSellPrice,
            pricingSource:
              barcodeMapRow.selling_price_override ||
              (resolvedUom !== prod.baseUom.toUpperCase() && matchedConv?.sellingPrice)
                ? 'PACKAGE_EXPLICIT'
                : intakeLot?.pricing_mode === 'INTAKE_SPECIFIC' && intakeLot.selling_price
                  ? 'INTAKE_SPECIFIC'
                  : 'PRODUCT_DEFAULT',
            expiryDate: null,
            allocationPolicy: 'MANUAL',
            isBlocked: isIntakeBlocked,
            blockReason: !intakeLot
              ? 'INTAKE_LOT_EXHAUSTED'
              : intakeLot.warehouse_id !== params.warehouseId
                ? 'INTAKE_LOT_WRONG_WAREHOUSE'
                : intakeLot.status !== 'ACTIVE'
                  ? `INTAKE_LOT_${intakeLot.status}`
                  : remQty < reqQty
                    ? 'INTAKE_LOT_EXHAUSTED'
                    : null,
          };
        }

        const batches = this.listBatchesForProduct({
          tenantId: params.tenantId,
          warehouseId: params.warehouseId,
          productId: prod.id,
        });
        if (batches.length > 0) {
          const eligible = batches
            .filter(
              (b) =>
                b.status === 'ACTIVE' &&
                (!b.expiryDate || b.expiryDate >= today) &&
                Number.parseFloat(b.availableQuantity) > 0,
            )
            .sort((a, b) => {
              if (prod.allocationPolicy === 'FIFO') {
                return a.receivedDate.localeCompare(b.receivedDate);
              }
              return (a.expiryDate ?? '9999-12-31').localeCompare(b.expiryDate ?? '9999-12-31');
            });
          const bestBatch = barcodeMapRow?.batch_id
            ? (batches.find((b) => b.batchId === barcodeMapRow.batch_id) ?? null)
            : (eligible[0] ?? null);
          return {
            matchType: 'PRODUCT_BARCODE',
            productId: prod.id,
            sku: prod.sku,
            name: prod.name,
            baseUom: prod.baseUom,
            priceUom: prod.priceUom,
            resolvedSellingUom: resolvedUom,
            resolvedConversionFactorToBase: resolvedConvFactor,
            stockIntakeLotId: null,
            intakeCode: null,
            batchId: bestBatch?.batchId ?? null,
            batchNumber: bestBatch?.batchNumber ?? null,
            serialId: null,
            serialNumber: null,
            internalBarcode: bestBatch?.internalBarcode ?? null,
            availableQuantity: bestBatch?.availableQuantity ?? '0.000000',
            sellingPrice:
              bestBatch?.batchPricingMode === 'EXPLICIT' && bestBatch.sellingPrice
                ? bestBatch.sellingPrice
                : prod.effectivePrice,
            pricingSource:
              bestBatch?.batchPricingMode === 'EXPLICIT' && bestBatch.sellingPrice
                ? 'EXPLICIT_BATCH_PRICE'
                : 'PRODUCT_DEFAULT',
            expiryDate: bestBatch?.expiryDate ?? null,
            allocationPolicy: prod.allocationPolicy,
            isBlocked: !bestBatch,
            blockReason: bestBatch ? null : 'NO_ELIGIBLE_BATCH',
          };
        }

        const reqFactorNum = Number.parseFloat(resolvedConvFactor || '1');
        const resolvedStandardPrice =
          barcodeMapRow?.selling_price_override ??
          (resolvedUom !== prod.baseUom.toUpperCase() && matchedConv?.sellingPrice
            ? matchedConv.sellingPrice
            : resolvedUom !== prod.baseUom.toUpperCase()
              ? (Number.parseFloat(prod.effectivePrice) * reqFactorNum).toFixed(4)
              : prod.effectivePrice);

        return {
          matchType: 'PRODUCT_BARCODE',
          productId: prod.id,
          sku: prod.sku,
          name: prod.name,
          baseUom: prod.baseUom,
          priceUom: prod.priceUom,
          resolvedSellingUom: resolvedUom,
          resolvedConversionFactorToBase: resolvedConvFactor,
          stockIntakeLotId: null,
          intakeCode: null,
          batchId: null,
          batchNumber: null,
          serialId: null,
          serialNumber: null,
          internalBarcode: null,
          availableQuantity: prod.availableQuantity,
          sellingPrice: resolvedStandardPrice,
          pricingSource:
            barcodeMapRow?.selling_price_override ||
            (resolvedUom !== prod.baseUom.toUpperCase() && matchedConv?.sellingPrice)
              ? 'PACKAGE_EXPLICIT'
              : 'PRODUCT_DEFAULT',
          expiryDate: null,
          allocationPolicy: null,
          isBlocked: false,
          blockReason: null,
        };
      }
    }

    // 3. Serial number lookup
    const ser = this.db
      .prepare(
        `SELECT id, product_id, batch_id, serial_number, status
         FROM local_inventory_serials
         WHERE tenant_id = ? AND warehouse_id = ? AND serial_number = ?`,
      )
      .get(params.tenantId, params.warehouseId, code) as
      | { id: string; product_id: string; batch_id: string | null; serial_number: string; status: string }
      | undefined;

    if (ser) {
      const prod = this.getProductById({
        tenantId: params.tenantId,
        branchId: params.branchId,
        warehouseId: params.warehouseId,
        productId: ser.product_id,
      });
      return {
        matchType: 'SERIAL_NUMBER',
        productId: ser.product_id,
        sku: prod?.sku ?? null,
        name: prod?.name ?? null,
        baseUom: prod?.baseUom ?? null,
        priceUom: prod?.priceUom ?? null,
        batchId: ser.batch_id,
        batchNumber: null,
        serialId: ser.id,
        serialNumber: ser.serial_number,
        internalBarcode: null,
        availableQuantity: ser.status === 'IN_STOCK' ? '1.000000' : '0.000000',
        sellingPrice: prod?.effectivePrice ?? null,
        pricingSource: 'PRODUCT_DEFAULT',
        expiryDate: null,
        allocationPolicy: null,
        isBlocked: ser.status !== 'IN_STOCK',
        blockReason: ser.status === 'IN_STOCK' ? null : `SERIAL_${ser.status}`,
      };
    }

    return {
      matchType: 'NOT_FOUND',
      productId: null,
      sku: null,
      name: null,
      baseUom: null,
      priceUom: null,
      batchId: null,
      batchNumber: null,
      serialId: null,
      serialNumber: null,
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

  listCustomers(params: {
    readonly tenantId: string;
    readonly query?: string;
    readonly limit?: number;
  }): readonly OfflineCustomerRecord[] {
    const q = (params.query ?? '').trim().toLowerCase();
    const limit = params.limit ?? 100;
    const rows = this.db
      .prepare(
        `SELECT id, tenant_id, customer_number, name, phone, email, status
         FROM local_customers WHERE tenant_id = ? AND status = 'ACTIVE' ORDER BY name ASC`,
      )
      .all(params.tenantId) as {
      id: string;
      tenant_id: string;
      customer_number: string;
      name: string;
      phone: string | null;
      email: string | null;
      status: 'ACTIVE' | 'INACTIVE' | 'ARCHIVED';
    }[];

    const out: OfflineCustomerRecord[] = [];
    for (const r of rows) {
      if (q) {
        const hay = `${r.customer_number} ${r.name} ${r.phone ?? ''} ${r.email ?? ''}`.toLowerCase();
        if (!hay.includes(q)) continue;
      }
      out.push({
        id: r.id,
        tenantId: r.tenant_id,
        customerNumber: r.customer_number,
        name: r.name,
        phone: r.phone,
        email: r.email,
        status: r.status,
      });
      if (out.length >= limit) break;
    }
    return out;
  }

  saveDraftCart(draft: OfflineDraftCartRecord): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO local_pos_draft_carts
         (id, tenant_id, branch_id, user_id, register_id, customer_id, customer_name, cart_lines_json, notes, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        draft.id,
        draft.tenantId,
        draft.branchId,
        draft.userId,
        draft.registerId,
        draft.customerId,
        draft.customerName,
        JSON.stringify(draft.lines),
        draft.notes,
        draft.updatedAt,
      );
  }

  loadDraftCart(params: {
    readonly tenantId: string;
    readonly branchId: string;
    readonly userId: string;
  }): OfflineDraftCartRecord | null {
    const r = this.db
      .prepare(
        `SELECT id, tenant_id, branch_id, user_id, register_id, customer_id, customer_name, cart_lines_json, notes, updated_at
         FROM local_pos_draft_carts WHERE tenant_id = ? AND branch_id = ? AND user_id = ?`,
      )
      .get(params.tenantId, params.branchId, params.userId) as
      | {
          id: string;
          tenant_id: string;
          branch_id: string;
          user_id: string;
          register_id: string | null;
          customer_id: string | null;
          customer_name: string | null;
          cart_lines_json: string;
          notes: string | null;
          updated_at: string;
        }
      | undefined;

    if (!r) return null;
    return {
      id: r.id,
      tenantId: r.tenant_id,
      branchId: r.branch_id,
      userId: r.user_id,
      registerId: r.register_id,
      customerId: r.customer_id,
      customerName: r.customer_name,
      lines: JSON.parse(r.cart_lines_json),
      notes: r.notes,
      updatedAt: r.updated_at,
    };
  }

  clearDraftCart(params: {
    readonly tenantId: string;
    readonly branchId: string;
    readonly userId: string;
  }): void {
    this.db
      .prepare(
        `DELETE FROM local_pos_draft_carts WHERE tenant_id = ? AND branch_id = ? AND user_id = ?`,
      )
      .run(params.tenantId, params.branchId, params.userId);
  }

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
  }): { localSeq: number } {
    const { invoice, lines, tenderedAmount, outboxCommandId, outboxPayload, stockDeductions } = params;
    const idempotencyKey = randomUUID();
    const paymentId = randomUUID();
    const deviceRow = this.getDeviceContext();
    const deviceId = deviceRow?.deviceId ?? randomUUID();

    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare(
          `INSERT INTO local_sales_invoices
           (id, tenant_id, branch_id, warehouse_id, register_id, shift_id, customer_id, cashier_user_id, invoice_number, status, currency_code, subtotal_amount, discount_amount, tax_amount, grand_total, total_paid, change_given, customer_name, idempotency_key, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'COMPLETED', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          invoice.invoiceId,
          invoice.tenantId,
          invoice.branchId,
          invoice.warehouseId,
          invoice.registerId,
          invoice.shiftId,
          invoice.customerId,
          invoice.cashierUserId,
          invoice.invoiceNumber,
          invoice.currencyCode,
          invoice.subtotalAmount,
          invoice.discountAmount,
          invoice.taxAmount,
          invoice.grandTotal,
          invoice.totalPaid,
          invoice.changeGiven,
          invoice.customerName,
          idempotencyKey,
          invoice.createdAt,
        );

      for (const l of lines) {
        const lineId = randomUUID();
        this.db
          .prepare(
            `INSERT INTO local_sales_invoice_lines
             (id, tenant_id, invoice_id, line_number, product_id, sku, product_name, uom_code, quantity, unit_price, discount_amount, tax_amount, line_total, tax_rate_snapshot, unit_cost_snapshot, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            lineId,
            invoice.tenantId,
            invoice.invoiceId,
            l.lineNumber,
            l.productId,
            l.sku,
            l.productName,
            l.uomCode,
            l.enteredQty,
            l.unitPrice,
            l.discountAmount,
            l.taxAmount,
            l.lineTotal,
            JSON.stringify(l.taxRulesApplied),
            l.unitCostSnapshot,
            invoice.createdAt,
          );

        if (l.batchId || l.serialId) {
          this.db
            .prepare(
              `INSERT INTO local_sales_line_batch_links
               (line_id, tenant_id, invoice_id, batch_id, serial_id, unit_cost_snapshot, selling_price_snapshot, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              lineId,
              invoice.tenantId,
              invoice.invoiceId,
              l.batchId,
              l.serialId,
              l.unitCostSnapshot,
              l.unitPrice,
              invoice.createdAt,
            );
        }

        if (l.stockIntakeLotId || l.scannedBarcode) {
          this.db
            .prepare(
              `INSERT INTO local_sales_line_intake_links
               (line_id, tenant_id, invoice_id, stock_intake_lot_id, intake_code_snapshot, selling_uom, conversion_factor_to_base, normalized_base_qty, scanned_barcode, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              lineId,
              invoice.tenantId,
              invoice.invoiceId,
              l.stockIntakeLotId ?? null,
              l.intakeCode ?? null,
              l.uomCode,
              l.conversionFactorToBase,
              l.normalizedBaseQty,
              l.scannedBarcode ?? null,
              invoice.createdAt,
            );
        }

        if (l.stockIntakeLotId) {
          const lotRow = this.db
            .prepare(
              `SELECT base_qty_remaining FROM local_stock_intake_lots WHERE tenant_id = ? AND id = ?`,
            )
            .get(invoice.tenantId, l.stockIntakeLotId) as { base_qty_remaining: string } | undefined;
          if (lotRow) {
            const rem = Math.max(
              0,
              Number.parseFloat(lotRow.base_qty_remaining) -
                Number.parseFloat(l.normalizedBaseQty || '0'),
            );
            this.db
              .prepare(
                `UPDATE local_stock_intake_lots
                 SET base_qty_remaining = ?, status = ?, updated_at = ?
                 WHERE tenant_id = ? AND id = ?`,
              )
              .run(
                rem.toFixed(6),
                rem <= 0 ? 'DEPLETED' : 'ACTIVE',
                invoice.createdAt,
                invoice.tenantId,
                l.stockIntakeLotId,
              );
          }
        }
      }

      this.db
        .prepare(
          `INSERT INTO local_sales_payments
           (id, tenant_id, invoice_id, payment_method, amount, currency_code, status, tendered_amount, change_amount, recorded_by_user_id, created_at)
           VALUES (?, ?, ?, 'CASH', ?, ?, 'COMPLETED', ?, ?, ?, ?)`,
        )
        .run(
          paymentId,
          invoice.tenantId,
          invoice.invoiceId,
          invoice.grandTotal,
          invoice.currencyCode,
          tenderedAmount,
          invoice.changeGiven,
          invoice.cashierUserId,
          invoice.createdAt,
        );

      // Update local stock projections ONLY (never modifying server_qty_on_hand_micro)
      for (const d of stockDeductions) {
        const qtyMicro = Math.round(Number.parseFloat(d.baseQtyDelta || '0') * 1_000_000);
        if (qtyMicro > 0) {
          this.db
            .prepare(
              `UPDATE local_inventory_balances
               SET local_pending_qty_delta_micro = local_pending_qty_delta_micro - ?, updated_at = ?
               WHERE tenant_id = ? AND warehouse_id = ? AND variant_id = ?`,
            )
            .run(qtyMicro, invoice.createdAt, invoice.tenantId, d.warehouseId, d.productId);
        }
        if (d.batchId) {
          const qtyFloat = Number.parseFloat(d.baseQtyDelta || '0');
          if (qtyFloat > 0) {
            this.db
              .prepare(
                `UPDATE local_batch_pricing_profiles
                 SET available_quantity = printf('%.6f', MAX(0.0, CAST(available_quantity AS REAL) - ?)), updated_at = ?
                 WHERE tenant_id = ? AND batch_id = ?`,
              )
              .run(qtyFloat, invoice.createdAt, invoice.tenantId, d.batchId);
          }
        }
        if (d.serialId) {
          this.db
            .prepare(
              `UPDATE local_inventory_serials
               SET status = 'RESERVED', last_sale_invoice_id = ?, updated_at = ?
               WHERE tenant_id = ? AND id = ?`,
            )
            .run(invoice.invoiceId, invoice.createdAt, invoice.tenantId, d.serialId);
        }
      }

      this.db
        .prepare(
          `INSERT INTO local_sync_outbox
           (command_id, tenant_id, branch_id, device_id, actor_user_id, command_type, schema_version, payload_json, occurred_at, status)
           VALUES (?, ?, ?, ?, ?, 'POS_RECORD_SALE', 1, ?, ?, 'PENDING')`,
        )
        .run(
          outboxCommandId,
          invoice.tenantId,
          invoice.branchId,
          deviceId,
          invoice.cashierUserId,
          JSON.stringify(outboxPayload),
          invoice.createdAt,
        );

      const seqRow = this.db
        .prepare('SELECT local_seq FROM local_sync_outbox WHERE command_id = ?')
        .get(outboxCommandId) as { local_seq: number };

      this.db
        .prepare(
          `INSERT INTO local_sales_invoice_sync_meta
           (tenant_id, invoice_id, sync_state, outbox_command_id, server_confirmed, updated_at)
           VALUES (?, ?, 'PENDING_SYNC', ?, 0, ?)`,
        )
        .run(invoice.tenantId, invoice.invoiceId, outboxCommandId, invoice.createdAt);

      this.db.exec('COMMIT');
      return { localSeq: seqRow.local_seq };
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  listLocalInvoices(params: {
    readonly tenantId: string;
    readonly branchId?: string;
    readonly limit?: number;
  }): readonly OfflineLocalInvoice[] {
    const limit = params.limit ?? 50;
    const rows = (
      params.branchId
        ? this.db
            .prepare(
              `SELECT i.*, sm.sync_state, sm.server_confirmed, sm.outbox_command_id, sm.conflict_reason
               FROM local_sales_invoices i
               LEFT JOIN local_sales_invoice_sync_meta sm
                 ON sm.tenant_id = i.tenant_id AND sm.invoice_id = i.id
               WHERE i.tenant_id = ? AND i.branch_id = ?
               ORDER BY i.created_at DESC LIMIT ?`,
            )
            .all(params.tenantId, params.branchId, limit)
        : this.db
            .prepare(
              `SELECT i.*, sm.sync_state, sm.server_confirmed, sm.outbox_command_id, sm.conflict_reason
               FROM local_sales_invoices i
               LEFT JOIN local_sales_invoice_sync_meta sm
                 ON sm.tenant_id = i.tenant_id AND sm.invoice_id = i.id
               WHERE i.tenant_id = ?
               ORDER BY i.created_at DESC LIMIT ?`,
            )
            .all(params.tenantId, limit)
    ) as {
      id: string;
      tenant_id: string;
      branch_id: string;
      warehouse_id: string;
      register_id: string;
      shift_id: string | null;
      customer_id: string | null;
      customer_name: string | null;
      cashier_user_id: string;
      invoice_number: string;
      currency_code: string;
      subtotal_amount: string;
      discount_amount: string;
      tax_amount: string;
      grand_total: string;
      total_paid: string;
      change_given: string;
      sync_state: OfflineLocalInvoice['syncState'] | null;
      server_confirmed: number | null;
      outbox_command_id: string | null;
      conflict_reason: string | null;
      created_at: string;
    }[];

    return rows.map((r) => ({
      invoiceId: r.id,
      tenantId: r.tenant_id,
      branchId: r.branch_id,
      warehouseId: r.warehouse_id,
      registerId: r.register_id,
      shiftId: r.shift_id,
      customerId: r.customer_id,
      customerName: r.customer_name,
      cashierUserId: r.cashier_user_id,
      invoiceNumber: r.invoice_number,
      currencyCode: r.currency_code,
      subtotalAmount: r.subtotal_amount,
      discountAmount: r.discount_amount,
      taxAmount: r.tax_amount,
      grandTotal: r.grand_total,
      totalPaid: r.total_paid,
      changeGiven: r.change_given,
      syncState: r.sync_state ?? 'PENDING_SYNC',
      serverConfirmed: r.server_confirmed === 1,
      outboxCommandId: r.outbox_command_id,
      conflictReason: r.conflict_reason,
      createdAt: r.created_at,
    }));
  }

  listPendingOutboxCommands(params: {
    readonly tenantId: string;
    readonly limit?: number;
  }): readonly OfflineOutboxCommandRecord[] {
    const rows = this.db
      .prepare(
        `SELECT local_seq, command_id, tenant_id, branch_id, device_id, actor_user_id,
                command_type, schema_version, payload_json, occurred_at, status, retry_count, last_error
         FROM local_sync_outbox
         WHERE tenant_id = ? AND status IN ('PENDING', 'IN_FLIGHT', 'QUARANTINED')
         ORDER BY local_seq ASC LIMIT ?`,
      )
      .all(params.tenantId, params.limit ?? 100) as {
      local_seq: number;
      command_id: string;
      tenant_id: string;
      branch_id: string;
      device_id: string;
      actor_user_id: string;
      command_type: string;
      schema_version: number;
      payload_json: string;
      occurred_at: string;
      status: OfflineOutboxCommandRecord['status'];
      retry_count: number;
      last_error: string | null;
    }[];

    return rows.map((r) => ({
      localSeq: r.local_seq,
      commandId: r.command_id,
      tenantId: r.tenant_id,
      branchId: r.branch_id,
      deviceId: r.device_id,
      actorUserId: r.actor_user_id,
      commandType: r.command_type,
      schemaVersion: r.schema_version,
      payload: JSON.parse(r.payload_json) as Record<string, unknown>,
      occurredAt: r.occurred_at,
      status: r.status,
      retryCount: r.retry_count,
      lastError: r.last_error,
    }));
  }

  listAllBatches(params: {
    readonly tenantId: string;
    readonly warehouseId?: string;
    readonly productId?: string;
  }): readonly OfflineBatchRecord[] {
    let sqlStr = `SELECT bp.batch_id, bp.product_id, bp.warehouse_id, bp.branch_id, bp.batch_number,
                         bp.status, bp.available_quantity, bp.selling_price, bp.min_selling_price,
                         bp.max_discount_pct, bp.batch_pricing_mode, bp.internal_barcode,
                         ib.expiry_date, ib.received_date, ib.unit_cost
       FROM local_batch_pricing_profiles bp
       JOIN local_inventory_batches ib
         ON ib.tenant_id = bp.tenant_id AND ib.id = bp.batch_id
       WHERE bp.tenant_id = ?`;
    const args: unknown[] = [params.tenantId];
    if (params.warehouseId) {
      sqlStr += ' AND bp.warehouse_id = ?';
      args.push(params.warehouseId);
    }
    if (params.productId) {
      sqlStr += ' AND bp.product_id = ?';
      args.push(params.productId);
    }
    sqlStr += ` ORDER BY COALESCE(ib.expiry_date, '9999-12-31') ASC, ib.received_date ASC`;

    const rows = this.db.prepare(sqlStr).all(...args) as {
      batch_id: string;
      product_id: string;
      warehouse_id: string;
      branch_id: string | null;
      batch_number: string;
      status: string;
      available_quantity: string;
      unit_cost: string;
      selling_price: string | null;
      min_selling_price: string | null;
      max_discount_pct: string | null;
      batch_pricing_mode: 'EXPLICIT' | 'INHERIT_PRODUCT';
      internal_barcode: string | null;
      expiry_date: string | null;
      received_date: string;
    }[];

    return rows.map((r) => ({
      batchId: r.batch_id,
      productId: r.product_id,
      warehouseId: r.warehouse_id,
      branchId: r.branch_id,
      batchNumber: r.batch_number,
      status: r.status,
      availableQuantity: r.available_quantity,
      unitCost: r.unit_cost,
      sellingPrice: r.selling_price,
      minSellingPrice: r.min_selling_price,
      maxDiscountPct: r.max_discount_pct,
      batchPricingMode: r.batch_pricing_mode,
      internalBarcode: r.internal_barcode,
      expiryDate: r.expiry_date,
      receivedDate: r.received_date,
    }));
  }

  listSerials(params: {
    readonly tenantId: string;
    readonly warehouseId?: string;
    readonly productId?: string;
    readonly serialNumber?: string;
  }): readonly OfflineSerialRecord[] {
    let sqlStr = `SELECT id, product_id, warehouse_id, branch_id, batch_id, serial_number, status, unit_cost
      FROM local_inventory_serials WHERE tenant_id = ?`;
    const args: unknown[] = [params.tenantId];
    if (params.warehouseId) {
      sqlStr += ' AND warehouse_id = ?';
      args.push(params.warehouseId);
    }
    if (params.productId) {
      sqlStr += ' AND product_id = ?';
      args.push(params.productId);
    }
    if (params.serialNumber) {
      sqlStr += ' AND UPPER(serial_number) LIKE ?';
      args.push(`%${params.serialNumber.trim().toUpperCase()}%`);
    }
    sqlStr += ' ORDER BY serial_number ASC LIMIT 200';
    const rows = this.db.prepare(sqlStr).all(...args) as {
      id: string;
      product_id: string;
      warehouse_id: string;
      branch_id: string;
      batch_id: string | null;
      serial_number: string;
      status: string;
      unit_cost: string;
    }[];

    return rows.map((r) => ({
      id: r.id,
      productId: r.product_id,
      warehouseId: r.warehouse_id,
      branchId: r.branch_id,
      batchId: r.batch_id,
      serialNumber: r.serial_number,
      status: r.status,
      unitCost: r.unit_cost,
    }));
  }

  commitOfflineInventoryMovement(params: {
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
  }): { localSeq: number } {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare(
          `INSERT INTO local_inventory_movements_queue
           (id, tenant_id, branch_id, warehouse_id, product_id, product_sku, product_name,
            batch_id, serial_id, entry_kind, movement_type, uom_code, input_qty_micro, qty_delta_micro,
            reason, notes, actor_user_id, outbox_command_id, sync_state, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING_SYNC', ?)`,
        )
        .run(
          params.movementId,
          params.tenantId,
          params.branchId,
          params.warehouseId,
          params.productId,
          params.productSku,
          params.productName,
          params.batchId,
          params.serialId,
          params.entryKind,
          params.movementType,
          params.uomCode,
          params.inputQtyMicro,
          params.qtyDeltaMicro,
          params.reason,
          params.notes,
          params.actorUserId,
          params.outboxCommandId,
          params.occurredAt,
        );

      if (params.qtyDeltaMicro !== 0) {
        this.db
          .prepare(
            `UPDATE local_inventory_balances
             SET local_pending_qty_delta_micro = local_pending_qty_delta_micro + ?, updated_at = ?
             WHERE tenant_id = ? AND warehouse_id = ? AND variant_id = ?`,
          )
          .run(
            params.qtyDeltaMicro,
            params.occurredAt,
            params.tenantId,
            params.warehouseId,
            params.productId,
          );
      }

      if (params.batchId && params.qtyDeltaMicro !== 0) {
        const deltaFloat = params.qtyDeltaMicro / 1_000_000;
        this.db
          .prepare(
            `UPDATE local_batch_pricing_profiles
             SET available_quantity = printf('%.6f', MAX(0.0, CAST(available_quantity AS REAL) + ?)), updated_at = ?
             WHERE tenant_id = ? AND batch_id = ?`,
          )
          .run(deltaFloat, params.occurredAt, params.tenantId, params.batchId);
      }

      if (params.serialId && params.entryKind === 'SERIAL_OP') {
        const nextStatus =
          typeof params.outboxPayload['toStatus'] === 'string'
            ? params.outboxPayload['toStatus']
            : null;
        if (nextStatus) {
          this.db
            .prepare(
              `UPDATE local_inventory_serials
               SET status = ?, updated_at = ?
               WHERE tenant_id = ? AND id = ?`,
            )
            .run(nextStatus, params.occurredAt, params.tenantId, params.serialId);
        }
      }

      this.db
        .prepare(
          `INSERT INTO local_sync_outbox
           (command_id, tenant_id, branch_id, device_id, actor_user_id, command_type, schema_version, payload_json, occurred_at, status)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, 'PENDING')`,
        )
        .run(
          params.outboxCommandId,
          params.tenantId,
          params.branchId,
          params.deviceId,
          params.actorUserId,
          params.commandType,
          JSON.stringify(params.outboxPayload),
          params.occurredAt,
        );

      const seqRow = this.db
        .prepare('SELECT local_seq FROM local_sync_outbox WHERE command_id = ?')
        .get(params.outboxCommandId) as { local_seq: number };

      this.db.exec('COMMIT');
      return { localSeq: seqRow.local_seq };
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  createOfflineTransferRequest(params: {
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
  }): { localSeq: number } {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare(
          `INSERT INTO local_stock_transfers
           (id, tenant_id, source_branch_id, source_warehouse_id, destination_branch_id,
            destination_warehouse_id, notes, lines_json, status, sync_state,
            outbox_command_id, actor_user_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'TRANSFER_REQUEST_PENDING', 'PENDING_SYNC', ?, ?, ?)`,
        )
        .run(
          params.transferId,
          params.tenantId,
          params.sourceBranchId,
          params.sourceWarehouseId,
          params.destinationBranchId,
          params.destinationWarehouseId,
          params.notes,
          JSON.stringify(params.lines),
          params.outboxCommandId,
          params.actorUserId,
          params.occurredAt,
        );

      this.db
        .prepare(
          `INSERT INTO local_sync_outbox
           (command_id, tenant_id, branch_id, device_id, actor_user_id, command_type, schema_version, payload_json, occurred_at, status)
           VALUES (?, ?, ?, ?, ?, 'INV_REQUEST_TRANSFER', 1, ?, ?, 'PENDING')`,
        )
        .run(
          params.outboxCommandId,
          params.tenantId,
          params.sourceBranchId,
          params.deviceId,
          params.actorUserId,
          JSON.stringify(params.outboxPayload),
          params.occurredAt,
        );

      const seqRow = this.db
        .prepare('SELECT local_seq FROM local_sync_outbox WHERE command_id = ?')
        .get(params.outboxCommandId) as { local_seq: number };

      this.db.exec('COMMIT');
      return { localSeq: seqRow.local_seq };
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  listOfflineTransfers(params: {
    readonly tenantId: string;
    readonly branchId?: string;
    readonly limit?: number;
  }): readonly OfflineTransferRequestRecord[] {
    const rows = (
      params.branchId
        ? this.db
            .prepare(
              `SELECT * FROM local_stock_transfers
               WHERE tenant_id = ? AND source_branch_id = ?
               ORDER BY created_at DESC LIMIT ?`,
            )
            .all(params.tenantId, params.branchId, params.limit ?? 100)
        : this.db
            .prepare(
              `SELECT * FROM local_stock_transfers
               WHERE tenant_id = ?
               ORDER BY created_at DESC LIMIT ?`,
            )
            .all(params.tenantId, params.limit ?? 100)
    ) as {
      id: string;
      outbox_command_id: string;
      source_branch_id: string;
      source_warehouse_id: string;
      destination_branch_id: string;
      destination_warehouse_id: string | null;
      notes: string | null;
      lines_json: string;
      status: OfflineTransferRequestRecord['status'];
      sync_state: OfflineTransferRequestRecord['syncState'];
      server_transfer_id: string | null;
      server_transfer_number: string | null;
      conflict_reason: string | null;
      created_at: string;
    }[];

    return rows.map((r) => ({
      id: r.id,
      outboxCommandId: r.outbox_command_id,
      sourceBranchId: r.source_branch_id,
      sourceWarehouseId: r.source_warehouse_id,
      destinationBranchId: r.destination_branch_id,
      destinationWarehouseId: r.destination_warehouse_id,
      notes: r.notes,
      lines: JSON.parse(r.lines_json) as OfflineTransferRequestInput['lines'],
      status: r.status,
      syncState: r.sync_state,
      serverTransferId: r.server_transfer_id,
      serverTransferNumber: r.server_transfer_number,
      conflictReason: r.conflict_reason,
      createdAt: r.created_at,
    }));
  }

  listOfflineInventoryHistory(params: {
    readonly tenantId: string;
    readonly branchId?: string;
    readonly limit?: number;
  }): readonly OfflineInventoryHistoryEntry[] {
    const rows = (
      params.branchId
        ? this.db
            .prepare(
              `SELECT * FROM local_inventory_movements_queue
               WHERE tenant_id = ? AND branch_id = ?
               ORDER BY created_at DESC LIMIT ?`,
            )
            .all(params.tenantId, params.branchId, params.limit ?? 100)
        : this.db
            .prepare(
              `SELECT * FROM local_inventory_movements_queue
               WHERE tenant_id = ?
               ORDER BY created_at DESC LIMIT ?`,
            )
            .all(params.tenantId, params.limit ?? 100)
    ) as {
      id: string;
      outbox_command_id: string;
      entry_kind: OfflineInventoryHistoryEntry['entryKind'];
      branch_id: string;
      warehouse_id: string;
      product_id: string;
      product_sku: string | null;
      product_name: string | null;
      batch_id: string | null;
      serial_id: string | null;
      qty_delta_micro: number;
      reason: string | null;
      sync_state: OfflineInventoryHistoryEntry['syncState'];
      server_reference_id: string | null;
      conflict_reason: string | null;
      created_at: string;
    }[];

    return rows.map((r) => ({
      id: r.id,
      commandId: r.outbox_command_id,
      entryKind: r.entry_kind,
      branchId: r.branch_id,
      warehouseId: r.warehouse_id,
      productId: r.product_id,
      productSku: r.product_sku,
      productName: r.product_name,
      batchId: r.batch_id,
      serialId: r.serial_id,
      qtyDeltaMicro: r.qty_delta_micro,
      reason: r.reason,
      syncState: r.sync_state,
      serverReferenceId: r.server_reference_id,
      conflictReason: r.conflict_reason,
      createdAt: r.created_at,
    }));
  }

  recoverInFlightOutboxCommands(params: { readonly tenantId: string }): number {
    const existing = this.db
      .prepare(
        `SELECT command_id FROM local_sync_outbox WHERE tenant_id = ? AND status = 'IN_FLIGHT'`,
      )
      .all(params.tenantId) as { command_id: string }[];
    if (existing.length === 0) return 0;

    const now = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare(
          `UPDATE local_sync_outbox
           SET status = 'PENDING', retry_count = retry_count + 1,
               last_error = COALESCE(last_error, 'Recovered from interrupted sync session')
           WHERE tenant_id = ? AND status = 'IN_FLIGHT'`,
        )
        .run(params.tenantId);

      this.db
        .prepare(
          `UPDATE local_sales_invoice_sync_meta
           SET sync_state = 'PENDING_SYNC', updated_at = ?
           WHERE tenant_id = ? AND sync_state = 'SYNC_IN_FLIGHT'`,
        )
        .run(now, params.tenantId);

      this.db
        .prepare(
          `UPDATE local_inventory_movements_queue
           SET sync_state = 'PENDING_SYNC'
           WHERE tenant_id = ? AND sync_state = 'SYNC_IN_FLIGHT'`,
        )
        .run(params.tenantId);

      this.db
        .prepare(
          `UPDATE local_stock_transfers
           SET sync_state = 'PENDING_SYNC'
           WHERE tenant_id = ? AND sync_state = 'SYNC_IN_FLIGHT'`,
        )
        .run(params.tenantId);

      this.db.exec('COMMIT');
      return existing.length;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  markOutboxCommandsInFlight(params: {
    readonly tenantId: string;
    readonly commandIds: readonly string[];
  }): void {
    if (params.commandIds.length === 0) return;
    const now = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const updOutbox = this.db.prepare(
        `UPDATE local_sync_outbox SET status = 'IN_FLIGHT' WHERE tenant_id = ? AND command_id = ?`,
      );
      const updInv = this.db.prepare(
        `UPDATE local_sales_invoice_sync_meta SET sync_state = 'SYNC_IN_FLIGHT', updated_at = ?
         WHERE tenant_id = ? AND outbox_command_id = ? AND server_confirmed = 0`,
      );
      const updMov = this.db.prepare(
        `UPDATE local_inventory_movements_queue SET sync_state = 'SYNC_IN_FLIGHT'
         WHERE tenant_id = ? AND outbox_command_id = ? AND sync_state = 'PENDING_SYNC'`,
      );
      const updTrf = this.db.prepare(
        `UPDATE local_stock_transfers SET sync_state = 'SYNC_IN_FLIGHT'
         WHERE tenant_id = ? AND outbox_command_id = ? AND sync_state = 'PENDING_SYNC'`,
      );
      for (const cmdId of params.commandIds) {
        updOutbox.run(params.tenantId, cmdId);
        updInv.run(now, params.tenantId, cmdId);
        updMov.run(params.tenantId, cmdId);
        updTrf.run(params.tenantId, cmdId);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  applySyncPushReceipts(params: {
    readonly tenantId: string;
    readonly deviceId: string;
    readonly branchId: string;
    readonly receipts: SyncPushBatchResponse['receipts'];
    readonly pushedAt: string;
  }): void {
    if (params.receipts.length === 0) return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const rec of params.receipts) {
        const cmdRow = this.db
          .prepare(
            `SELECT command_type, payload_json FROM local_sync_outbox
             WHERE tenant_id = ? AND command_id = ?`,
          )
          .get(params.tenantId, rec.commandId) as
          | { command_type: string; payload_json: string }
          | undefined;

        const isQuarantined = rec.status === 'QUARANTINED';
        const isConflictFlag = rec.status === 'APPLIED_WITH_CONFLICT_FLAG';

        this.db
          .prepare(
            `UPDATE local_sync_outbox
             SET status = ?, last_error = ?
             WHERE tenant_id = ? AND command_id = ?`,
          )
          .run(
            isQuarantined ? 'QUARANTINED' : 'SYNCED',
            rec.errorMessage ?? rec.conflictCode ?? null,
            params.tenantId,
            rec.commandId,
          );

        const nextSyncState = isQuarantined
          ? 'QUARANTINED'
          : isConflictFlag
            ? 'CONFLICT_FLAGGED'
            : 'SERVER_CONFIRMED';

        this.db
          .prepare(
            `UPDATE local_sales_invoice_sync_meta
             SET sync_state = ?,
                 server_confirmed = ?,
                 server_invoice_id = COALESCE(?, server_invoice_id),
                 server_invoice_number = COALESCE(?, server_invoice_number),
                 conflict_reason = ?,
                 updated_at = ?
             WHERE tenant_id = ? AND outbox_command_id = ?`,
          )
          .run(
            nextSyncState,
            isQuarantined ? 0 : 1,
            rec.serverReferenceId ?? null,
            rec.serverReferenceNumber ?? null,
            rec.errorMessage ?? rec.conflictCode ?? null,
            params.pushedAt,
            params.tenantId,
            rec.commandId,
          );

        this.db
          .prepare(
            `UPDATE local_inventory_movements_queue
             SET sync_state = ?,
                 server_reference_id = COALESCE(?, server_reference_id),
                 conflict_reason = ?,
                 synced_at = ?
             WHERE tenant_id = ? AND outbox_command_id = ?`,
          )
          .run(
            nextSyncState,
            rec.serverReferenceId ?? null,
            rec.errorMessage ?? rec.conflictCode ?? null,
            isQuarantined ? null : params.pushedAt,
            params.tenantId,
            rec.commandId,
          );

        this.db
          .prepare(
            `UPDATE local_stock_transfers
             SET sync_state = ?,
                 status = ?,
                 server_transfer_id = COALESCE(?, server_transfer_id),
                 server_transfer_number = COALESCE(?, server_transfer_number),
                 conflict_reason = ?,
                 synced_at = ?
             WHERE tenant_id = ? AND outbox_command_id = ?`,
          )
          .run(
            nextSyncState,
            isQuarantined
              ? 'QUARANTINED'
              : isConflictFlag
                ? 'CONFLICT_FLAGGED'
                : 'SERVER_CONFIRMED',
            rec.serverReferenceId ?? null,
            rec.serverReferenceNumber ?? null,
            rec.errorMessage ?? rec.conflictCode ?? null,
            isQuarantined ? null : params.pushedAt,
            params.tenantId,
            rec.commandId,
          );

        if (isQuarantined || isConflictFlag) {
          const invMeta = this.db
            .prepare(
              `SELECT i.id, i.invoice_number
               FROM local_sales_invoice_sync_meta sm
               JOIN local_sales_invoices i
                 ON i.tenant_id = sm.tenant_id AND i.id = sm.invoice_id
               WHERE sm.tenant_id = ? AND sm.outbox_command_id = ?`,
            )
            .get(params.tenantId, rec.commandId) as
            | { id: string; invoice_number: string }
            | undefined;

          const conflictId = rec.conflictId ?? randomUUID();
          const cmdType = cmdRow?.command_type ?? 'POS_RECORD_SALE';
          this.db
            .prepare(
              `INSERT INTO local_sync_conflicts
               (id, tenant_id, branch_id, device_id, command_id, command_type, entity_type,
                local_reference_id, local_reference_number, conflict_code, status,
                details_json, original_payload_json, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT (tenant_id, command_id) DO UPDATE SET
                 id = excluded.id,
                 conflict_code = excluded.conflict_code,
                 status = excluded.status,
                 details_json = excluded.details_json`,
            )
            .run(
              conflictId,
              params.tenantId,
              params.branchId,
              params.deviceId,
              rec.commandId,
              cmdType,
              cmdType.startsWith('POS_') ? 'POS_SALE' : 'INVENTORY',
              invMeta?.id ?? null,
              invMeta?.invoice_number ?? null,
              rec.conflictCode ?? 'SYNC_VALIDATION_CONFLICT',
              isQuarantined ? 'QUARANTINED' : 'OPEN',
              JSON.stringify({
                message: rec.errorMessage ?? rec.conflictCode ?? 'Conflict flagged during sync',
                ...(rec.serverDetails ?? {}),
              }),
              cmdRow?.payload_json ?? '{}',
              params.pushedAt,
            );
        }
      }

      // Reset local pending delta projection once all non-quarantined items are confirmed
      // (authoritative pull snapshot also overwrites balances).
      const pendingRemains = this.db
        .prepare(
          `SELECT COUNT(*) AS cnt FROM local_sync_outbox
           WHERE tenant_id = ? AND status IN ('PENDING', 'IN_FLIGHT')`,
        )
        .get(params.tenantId) as { cnt: number };
      if (pendingRemains.cnt === 0) {
        this.db
          .prepare(
            `UPDATE local_inventory_balances
             SET local_pending_qty_delta_micro = 0, updated_at = ?
             WHERE tenant_id = ?`,
          )
          .run(params.pushedAt, params.tenantId);
      }

      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  markOutboxCommandsRetryFailed(params: {
    readonly tenantId: string;
    readonly commandIds: readonly string[];
    readonly errorMessage: string;
    readonly attemptedAt: string;
  }): void {
    if (params.commandIds.length === 0) return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const stmt = this.db.prepare(
        `UPDATE local_sync_outbox
         SET status = 'PENDING', retry_count = retry_count + 1, last_error = ?
         WHERE tenant_id = ? AND command_id = ? AND status != 'SYNCED'`,
      );
      const updInv = this.db.prepare(
        `UPDATE local_sales_invoice_sync_meta SET sync_state = 'PENDING_SYNC', updated_at = ?
         WHERE tenant_id = ? AND outbox_command_id = ? AND server_confirmed = 0`,
      );
      for (const cmdId of params.commandIds) {
        stmt.run(params.errorMessage, params.tenantId, cmdId);
        updInv.run(params.attemptedAt, params.tenantId, cmdId);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  upsertServerConflicts(params: {
    readonly tenantId: string;
    readonly conflicts: readonly SyncConflictRecord[];
  }): void {
    if (params.conflicts.length === 0) return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const stmt = this.db.prepare(
        `INSERT INTO local_sync_conflicts
         (id, tenant_id, branch_id, device_id, command_id, command_type, entity_type,
          conflict_code, status, details_json, original_payload_json,
          resolution_action, resolution_notes, resolved_by_user_id, created_at, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (tenant_id, command_id) DO UPDATE SET
           id = excluded.id,
           conflict_code = excluded.conflict_code,
           status = excluded.status,
           details_json = excluded.details_json,
           resolution_action = excluded.resolution_action,
           resolution_notes = excluded.resolution_notes,
           resolved_by_user_id = excluded.resolved_by_user_id,
           resolved_at = excluded.resolved_at`,
      );
      for (const c of params.conflicts) {
        const cmdType = c.commandType ?? 'POS_RECORD_SALE';
        stmt.run(
          c.id,
          params.tenantId,
          c.branchId,
          c.deviceId,
          c.commandId,
          cmdType,
          cmdType.startsWith('POS_') ? 'POS_SALE' : 'INVENTORY',
          c.conflictType,
          c.status,
          JSON.stringify(c.details ?? {}),
          JSON.stringify(c.originalPayload ?? {}),
          c.resolutionAction ?? null,
          c.resolutionNotes ?? null,
          c.resolvedByUserId ?? null,
          c.createdAt,
          c.resolvedAt ?? null,
        );
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  listLocalConflicts(params: {
    readonly tenantId: string;
    readonly branchId?: string;
    readonly status?: 'OPEN' | 'QUARANTINED' | 'RESOLVED' | 'DISMISSED';
  }): readonly OfflineLocalConflictRecord[] {
    let sqlStr = `SELECT * FROM local_sync_conflicts WHERE tenant_id = ?`;
    const args: unknown[] = [params.tenantId];
    if (params.branchId) {
      sqlStr += ' AND branch_id = ?';
      args.push(params.branchId);
    }
    if (params.status) {
      sqlStr += ' AND status = ?';
      args.push(params.status);
    }
    sqlStr += ' ORDER BY created_at DESC LIMIT 200';
    const rows = this.db.prepare(sqlStr).all(...args) as {
      id: string;
      tenant_id: string;
      branch_id: string;
      device_id: string;
      command_id: string;
      command_type: string;
      entity_type: string;
      local_reference_id: string | null;
      local_reference_number: string | null;
      conflict_code: string;
      status: OfflineLocalConflictRecord['status'];
      details_json: string;
      original_payload_json: string;
      resolution_action: string | null;
      resolution_notes: string | null;
      resolved_by_user_id: string | null;
      created_at: string;
      resolved_at: string | null;
    }[];

    return rows.map((r) => ({
      id: r.id,
      tenantId: r.tenant_id,
      branchId: r.branch_id,
      deviceId: r.device_id,
      commandId: r.command_id,
      commandType: r.command_type,
      entityType: r.entity_type,
      localReferenceId: r.local_reference_id,
      localReferenceNumber: r.local_reference_number,
      conflictCode: r.conflict_code,
      status: r.status,
      details: JSON.parse(r.details_json) as Record<string, unknown>,
      originalPayload: JSON.parse(r.original_payload_json) as Record<string, unknown>,
      resolutionAction: r.resolution_action,
      resolutionNotes: r.resolution_notes,
      resolvedByUserId: r.resolved_by_user_id,
      createdAt: r.created_at,
      resolvedAt: r.resolved_at,
    }));
  }

  markLocalConflictResolved(params: {
    readonly tenantId: string;
    readonly conflictId: string;
    readonly status: 'RESOLVED' | 'DISMISSED';
    readonly resolutionAction: string;
    readonly resolutionNotes: string | null;
    readonly resolvedByUserId: string;
    readonly resolvedAt: string;
    readonly replayedReferenceId?: string | null;
    readonly replayedReferenceNumber?: string | null;
  }): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const cRow = this.db
        .prepare(
          `SELECT command_id FROM local_sync_conflicts WHERE tenant_id = ? AND id = ?`,
        )
        .get(params.tenantId, params.conflictId) as { command_id: string } | undefined;

      this.db
        .prepare(
          `UPDATE local_sync_conflicts
           SET status = ?, resolution_action = ?, resolution_notes = ?,
               resolved_by_user_id = ?, resolved_at = ?
           WHERE tenant_id = ? AND id = ?`,
        )
        .run(
          params.status,
          params.resolutionAction,
          params.resolutionNotes,
          params.resolvedByUserId,
          params.resolvedAt,
          params.tenantId,
          params.conflictId,
        );

      if (cRow) {
        this.db
          .prepare(
            `UPDATE local_sales_invoice_sync_meta
             SET sync_state = 'SERVER_CONFIRMED',
                 server_confirmed = 1,
                 server_invoice_id = COALESCE(?, server_invoice_id),
                 server_invoice_number = COALESCE(?, server_invoice_number),
                 conflict_reason = NULL,
                 updated_at = ?
             WHERE tenant_id = ? AND outbox_command_id = ?`,
          )
          .run(
            params.replayedReferenceId ?? null,
            params.replayedReferenceNumber ?? null,
            params.resolvedAt,
            params.tenantId,
            cRow.command_id,
          );
      }

      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  getDeviceSecurityState(params: {
    readonly tenantId: string;
  }): OfflineDeviceSecurityStateRecord | null {
    const row = this.db
      .prepare(
        `SELECT tenant_id, device_id, status, revoked_reason, last_verified_at,
                last_sync_attempt_at, last_sync_success_at, last_sync_error
         FROM local_device_security_state
         WHERE singleton_id = 1 AND tenant_id = ?`,
      )
      .get(params.tenantId) as
      | {
          tenant_id: string;
          device_id: string;
          status: OfflineDeviceSecurityStateRecord['status'];
          revoked_reason: string | null;
          last_verified_at: string;
          last_sync_attempt_at: string | null;
          last_sync_success_at: string | null;
          last_sync_error: string | null;
        }
      | undefined;

    if (!row) return null;
    return {
      tenantId: row.tenant_id,
      deviceId: row.device_id,
      status: row.status,
      revokedReason: row.revoked_reason,
      lastVerifiedAt: row.last_verified_at,
      lastSyncAttemptAt: row.last_sync_attempt_at,
      lastSyncSuccessAt: row.last_sync_success_at,
      lastSyncError: row.last_sync_error,
    };
  }

  updateDeviceSecurityState(params: {
    readonly tenantId: string;
    readonly deviceId: string;
    readonly status: 'ACTIVE' | 'REVOKED' | 'EXPIRED';
    readonly revokedReason?: string | null;
    readonly lastSyncAttemptAt?: string | null;
    readonly lastSyncSuccessAt?: string | null;
    readonly lastSyncError?: string | null;
  }): void {
    const now = new Date().toISOString();
    const existing = this.getDeviceSecurityState({ tenantId: params.tenantId });
    this.db
      .prepare(
        `INSERT OR REPLACE INTO local_device_security_state
         (singleton_id, tenant_id, device_id, status, revoked_reason, last_verified_at,
          last_sync_attempt_at, last_sync_success_at, last_sync_error)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        params.tenantId,
        params.deviceId,
        params.status,
        params.revokedReason !== undefined ? params.revokedReason : (existing?.revokedReason ?? null),
        now,
        params.lastSyncAttemptAt !== undefined ? params.lastSyncAttemptAt : (existing?.lastSyncAttemptAt ?? null),
        params.lastSyncSuccessAt !== undefined ? params.lastSyncSuccessAt : (existing?.lastSyncSuccessAt ?? null),
        params.lastSyncError !== undefined ? params.lastSyncError : (existing?.lastSyncError ?? null),
      );
  }

  checkDatabaseIntegrity(): { ok: boolean; details: string } {
    const row = this.db.prepare('PRAGMA integrity_check;').get() as Record<string, unknown> | undefined;
    const msg = row ? String(Object.values(row)[0] ?? 'ok') : 'unknown';
    return { ok: msg.toLowerCase() === 'ok', details: msg };
  }

  exportRecoveryBackup(params: {
    readonly tenantId: string;
    readonly branchId: string;
    readonly deviceId: string;
  }): Omit<OfflineRecoveryBackupPayload, 'checksumSha256'> {
    const pendingOutbox = this.listPendingOutboxCommands({
      tenantId: params.tenantId,
      limit: 500,
    });
    const localInvoices = this.listLocalInvoices({
      tenantId: params.tenantId,
      branchId: params.branchId,
      limit: 500,
    });
    const inventoryMovements = this.listOfflineInventoryHistory({
      tenantId: params.tenantId,
      branchId: params.branchId,
      limit: 500,
    });
    const transferRequests = this.listOfflineTransfers({
      tenantId: params.tenantId,
      branchId: params.branchId,
      limit: 500,
    });
    const conflicts = this.listLocalConflicts({
      tenantId: params.tenantId,
      branchId: params.branchId,
    });

    return {
      formatVersion: 1,
      exportedAt: new Date().toISOString(),
      tenantId: params.tenantId,
      branchId: params.branchId,
      deviceId: params.deviceId,
      pendingOutbox,
      localInvoices,
      inventoryMovements,
      transferRequests,
      conflicts,
    };
  }

  importRecoveryBackup(params: {
    readonly backup: OfflineRecoveryBackupPayload;
  }): { restoredOutboxCount: number; skippedDuplicatesCount: number } {
    const { backup } = params;
    let restoredOutboxCount = 0;
    let skippedDuplicatesCount = 0;

    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const cmd of backup.pendingOutbox) {
        const existing = this.db
          .prepare('SELECT command_id FROM local_sync_outbox WHERE command_id = ?')
          .get(cmd.commandId) as { command_id: string } | undefined;
        if (existing) {
          skippedDuplicatesCount++;
          continue;
        }
        this.db
          .prepare(
            `INSERT INTO local_sync_outbox
             (command_id, tenant_id, branch_id, device_id, actor_user_id, command_type,
              schema_version, payload_json, occurred_at, status, retry_count, last_error)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            cmd.commandId,
            cmd.tenantId,
            cmd.branchId,
            cmd.deviceId,
            cmd.actorUserId,
            cmd.commandType,
            cmd.schemaVersion,
            JSON.stringify(cmd.payload),
            cmd.occurredAt,
            cmd.status === 'IN_FLIGHT' ? 'PENDING' : cmd.status,
            cmd.retryCount,
            cmd.lastError,
          );
        restoredOutboxCount++;
      }

      for (const mov of backup.inventoryMovements) {
        this.db
          .prepare(
            `INSERT OR IGNORE INTO local_inventory_movements_queue
             (id, tenant_id, branch_id, warehouse_id, product_id, product_sku, product_name,
              batch_id, serial_id, entry_kind, movement_type, uom_code, input_qty_micro, qty_delta_micro,
              reason, notes, actor_user_id, outbox_command_id, sync_state, server_reference_id,
              conflict_reason, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'EA', 0, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            mov.id,
            backup.tenantId,
            mov.branchId,
            mov.warehouseId,
            mov.productId,
            mov.productSku ?? null,
            mov.productName ?? null,
            mov.batchId ?? null,
            mov.serialId ?? null,
            mov.entryKind,
            'RESTORED_BACKUP',
            mov.qtyDeltaMicro,
            mov.reason,
            '00000000-0000-0000-0000-000000000000',
            mov.commandId,
            mov.syncState,
            mov.serverReferenceId,
            mov.conflictReason,
            mov.createdAt,
          );
      }

      this.db
        .prepare(
          `INSERT INTO local_recovery_backups_meta
           (id, tenant_id, device_id, checksum_sha256, record_counts_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          backup.tenantId,
          backup.deviceId,
          backup.checksumSha256,
          JSON.stringify({
            restoredOutboxCount,
            skippedDuplicatesCount,
          }),
          new Date().toISOString(),
        );

      this.db.exec('COMMIT');
      return { restoredOutboxCount, skippedDuplicatesCount };
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }
}

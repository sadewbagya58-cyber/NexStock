import crypto from 'node:crypto';
import type {
  CreateWasteLogRequest,
  CreateWasteReasonRequest,
  ListWasteLogsQuery,
  ReverseWasteLogRequest,
  UpdateWasteReasonRequest,
  WasteCostPreviewRequest,
  WasteCostPreviewResponse,
  WasteLogLineResponse,
  WasteLogResponse,
  WasteReasonResponse,
  WasteReportQuery,
} from '@nexstock/contracts';
import {
  type FifoCostLayer,
  Money,
  Quantity,
  UomConversionError,
  applyMacOutboundIssue,
  consumeFifoCostLayers,
  convertQuantityBetweenUoms,
} from '@nexstock/domain-core';
import { sql } from 'kysely';
import {
  isProductVisibleInBranch,
  resolveProductForInventory,
} from '../../cat/index.js';
import {
  assertAuthorized,
  resolveMemberAuthorizationContext,
} from '../../iam/index.js';
import {
  AppError,
  type TenantTransactionContext,
  appendAuditLog,
  enqueueOutboxEvent,
  generateUuidV7,
} from '../../shared/index.js';
import { assertSubscriptionEntitlement } from '../../sub/index.js';
import {
  postStockMovement,
  reverseStockMovement,
  verifyBranchAndWarehouseRelationship,
} from './inv.service.js';

const DEFAULT_WASTE_REASONS: ReadonlyArray<{
  code: string;
  name: string;
  description: string;
  requiresDescription: boolean;
  sortOrder: number;
}> = [
  { code: 'EXPIRED', name: 'Expired', description: 'Inventory passed expiration / best-before date', requiresDescription: false, sortOrder: 10 },
  { code: 'DAMAGED', name: 'Damaged', description: 'Physically damaged, crushed, broken, or torn goods', requiresDescription: false, sortOrder: 20 },
  { code: 'SPOILED', name: 'Spoiled', description: 'Perishable spoilage, rot, or temperature excursion loss', requiresDescription: false, sortOrder: 30 },
  { code: 'LOST_MISSING', name: 'Lost/Missing', description: 'Unaccounted shrinkage, misplaced or missing items', requiresDescription: false, sortOrder: 40 },
  { code: 'CONTAMINATED', name: 'Contaminated', description: 'Chemical, pest, moisture, or hygiene contamination', requiresDescription: false, sortOrder: 50 },
  { code: 'PRODUCTION_WASTE', name: 'Production Waste', description: 'Trim, prep, repacking, or processing discard', requiresDescription: false, sortOrder: 60 },
  { code: 'INTERNAL_CONSUMPTION', name: 'Internal Consumption', description: 'Staff/store sample, demonstration, or internal use', requiresDescription: false, sortOrder: 70 },
  { code: 'THEFT_SUSPECTED_LOSS', name: 'Theft/Suspected Loss', description: 'Suspected pilferage or unexplained theft loss', requiresDescription: false, sortOrder: 80 },
  { code: 'OTHER', name: 'Other', description: 'Other specified inventory loss (requires description)', requiresDescription: true, sortOrder: 90 },
];

function generateWasteNumber(): string {
  const stamp = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  const rand = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `WST-${stamp}-${rand}`;
}

async function getTenantBaseCurrency(trx: TenantTransactionContext): Promise<string> {
  const row = await trx.db
    .selectFrom('tenants')
    .select(['base_currency'])
    .where('id', '=', trx.tenantId)
    .executeTakeFirst();
  return row?.base_currency?.trim() || 'USD';
}

export async function ensureDefaultWasteReasons(
  trx: TenantTransactionContext,
): Promise<void> {
  const existingCount = await trx.db
    .selectFrom('waste_reasons')
    .select(sql<number>`count(*)::int`.as('cnt'))
    .where('tenant_id', '=', trx.tenantId)
    .executeTakeFirst();
  if ((existingCount?.cnt ?? 0) > 0) return;

  for (const r of DEFAULT_WASTE_REASONS) {
    await trx.db
      .insertInto('waste_reasons')
      .values({
        id: generateUuidV7(),
        tenant_id: trx.tenantId,
        code: r.code,
        name: r.name,
        description: r.description,
        is_system_default: true,
        requires_description: r.requiresDescription,
        is_active: true,
        sort_order: r.sortOrder,
        created_by_user_id: null,
      })
      .onConflict((oc) => oc.columns(['tenant_id', 'code']).doNothing())
      .execute();
  }
}

function mapWasteReasonRow(r: {
  id: string;
  tenant_id: string;
  code: string;
  name: string;
  description: string | null;
  is_system_default: boolean;
  requires_description: boolean;
  is_active: boolean;
  sort_order: number;
  created_at: Date | string;
  updated_at: Date | string;
}): WasteReasonResponse {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    code: r.code,
    name: r.name,
    description: r.description,
    isSystemDefault: Boolean(r.is_system_default),
    requiresDescription: Boolean(r.requires_description),
    isActive: Boolean(r.is_active),
    sortOrder: Number(r.sort_order),
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}

export async function listWasteReasons(
  trx: TenantTransactionContext,
  opts?: { activeOnly?: boolean },
): Promise<WasteReasonResponse[]> {
  try {
    await assertAuthorized(trx, { permission: 'inv:waste:read' });
  } catch {
    await assertAuthorized(trx, { permission: 'pos:sale:return' });
  }
  await ensureDefaultWasteReasons(trx);

  let q = trx.db
    .selectFrom('waste_reasons')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId);

  if (opts?.activeOnly) {
    q = q.where('is_active', '=', true);
  }

  const rows = await q
    .orderBy('sort_order', 'asc')
    .orderBy('name', 'asc')
    .execute();

  return rows.map(mapWasteReasonRow);
}

export async function createWasteReason(
  trx: TenantTransactionContext,
  input: CreateWasteReasonRequest,
): Promise<WasteReasonResponse> {
  await assertAuthorized(trx, { permission: 'inv:waste:reason:manage' });
  await assertSubscriptionEntitlement(trx, { requireWriteAccess: true });
  await ensureDefaultWasteReasons(trx);

  const code = input.code.trim().toUpperCase().replace(/[^A-Z0-9_]+/g, '_');
  const dup = await trx.db
    .selectFrom('waste_reasons')
    .select(['id'])
    .where('tenant_id', '=', trx.tenantId)
    .where('code', '=', code)
    .executeTakeFirst();
  if (dup) {
    throw new AppError({
      statusCode: 409,
      errorCode: 'INV_WASTE_REASON_EXISTS',
      title: 'Duplicate Waste Reason Code',
      detail: `Waste reason code "${code}" already exists.`,
    });
  }

  const now = new Date();
  const id = generateUuidV7();
  const inserted = await trx.db
    .insertInto('waste_reasons')
    .values({
      id,
      tenant_id: trx.tenantId,
      code,
      name: input.name.trim(),
      description: input.description?.trim() ?? null,
      is_system_default: false,
      requires_description: Boolean(input.requiresDescription ?? code === 'OTHER'),
      is_active: input.isActive ?? true,
      sort_order: input.sortOrder ?? 150,
      created_by_user_id: trx.userId,
      created_at: now,
      updated_at: now,
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  await appendAuditLog(trx, {
    action: 'INV_WASTE_REASON_CREATED',
    resourceType: 'WASTE_REASON',
    resourceId: id,
    metadata: { code, name: inserted.name },
  });

  return mapWasteReasonRow(inserted);
}

export async function updateWasteReason(
  trx: TenantTransactionContext,
  reasonId: string,
  input: UpdateWasteReasonRequest,
): Promise<WasteReasonResponse> {
  await assertAuthorized(trx, { permission: 'inv:waste:reason:manage' });
  await assertSubscriptionEntitlement(trx, { requireWriteAccess: true });

  const existing = await trx.db
    .selectFrom('waste_reasons')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', reasonId)
    .forUpdate()
    .executeTakeFirst();
  if (!existing) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'ERR_NOT_FOUND',
      title: 'Waste Reason Not Found',
      detail: `Waste reason "${reasonId}" was not found.`,
    });
  }

  const updated = await trx.db
    .updateTable('waste_reasons')
    .set({
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.description !== undefined ? { description: input.description?.trim() ?? null } : {}),
      ...(input.requiresDescription !== undefined ? { requires_description: input.requiresDescription } : {}),
      ...(input.isActive !== undefined ? { is_active: input.isActive } : {}),
      ...(input.sortOrder !== undefined ? { sort_order: input.sortOrder } : {}),
      updated_at: new Date(),
    })
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', reasonId)
    .returningAll()
    .executeTakeFirstOrThrow();

  await appendAuditLog(trx, {
    action: 'INV_WASTE_REASON_UPDATED',
    resourceType: 'WASTE_REASON',
    resourceId: reasonId,
    metadata: { code: updated.code, isActive: updated.is_active },
  });

  return mapWasteReasonRow(updated);
}

async function resolveWasteReasonForCode(
  trx: TenantTransactionContext,
  reasonCode: string,
  description: string | null | undefined,
) {
  await ensureDefaultWasteReasons(trx);
  const cleanCode = reasonCode.trim().toUpperCase();
  const reason = await trx.db
    .selectFrom('waste_reasons')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('code', '=', cleanCode)
    .executeTakeFirst();

  if (!reason || !reason.is_active) {
    throw new AppError({
      statusCode: 422,
      errorCode: 'INV_WASTE_INVALID_REASON',
      title: 'Invalid Waste Reason',
      detail: `Waste reason "${cleanCode}" was not found or is inactive.`,
    });
  }

  const trimmedDesc = description?.trim() || null;
  if ((reason.requires_description || reason.code === 'OTHER') && (!trimmedDesc || trimmedDesc.length < 3)) {
    throw new AppError({
      statusCode: 422,
      errorCode: 'INV_WASTE_DESCRIPTION_REQUIRED',
      title: 'Description Required',
      detail: `A descriptive explanation (minimum 3 characters) is required when waste reason is "${reason.name}".`,
    });
  }

  return { reason, trimmedDesc };
}

async function estimateLineCostAndAvailability(
  trx: TenantTransactionContext,
  params: {
    branchId: string;
    warehouseId: string;
    baseCurrency: string;
    productId: string;
    batchId?: string | null;
    serialId?: string | null;
    stockIntakeLotId?: string | null;
    uomCode?: string | null;
    wasteQtyStr: string;
  },
) {
  const product = await resolveProductForInventory(trx, params.productId);
  if (product.status !== 'ACTIVE') {
    throw new AppError({
      statusCode: 409,
      errorCode: 'INV_PRODUCT_ARCHIVED',
      title: 'Product Archived',
      detail: `Product "${product.sku}" is archived.`,
    });
  }
  const visible = await isProductVisibleInBranch(trx, params.productId, params.branchId);
  if (!visible) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'CAT_PRODUCT_NOT_IN_BRANCH',
      title: 'Product Not Available in Branch',
      detail: `Product "${product.sku}" is not assigned to the selected branch.`,
    });
  }

  const wasteQty = Quantity.fromDecimalString(params.wasteQtyStr);
  if (!wasteQty.isPositive()) {
    throw new AppError({
      statusCode: 422,
      errorCode: 'INV_WASTE_INVALID_QUANTITY',
      title: 'Invalid Waste Quantity',
      detail: 'Waste quantity must be strictly positive.',
    });
  }

  const uomCode = (params.uomCode?.trim() || product.baseUom).toUpperCase();
  const customConversions = [...product.unitConversions.entries()].map(
    ([code, factor]) => ({
      uomCode: code,
      conversionFactorToBase: factor,
    }),
  );

  let conversionFactorStr = '1.000000';
  let baseQty = wasteQty;
  try {
    const conv = convertQuantityBetweenUoms({
      quantity: wasteQty.toDecimalString(),
      fromUom: uomCode,
      toUom: product.baseUom,
      productBaseUom: product.baseUom,
      customConversions,
      densityGPerMl: product.densityGPerMl,
    });
    conversionFactorStr = conv.factorDecimal6;
    baseQty = conv.convertedQuantity;
  } catch (err) {
    if (err instanceof UomConversionError) {
      throw new AppError({
        statusCode: 400,
        errorCode: 'CAT_INVALID_UOM_CONVERSION',
        title: 'Incompatible Unit of Measure',
        detail: err.message,
      });
    }
    throw err;
  }

  if (params.serialId && !baseQty.equals(Quantity.fromInteger(1))) {
    throw new AppError({
      statusCode: 422,
      errorCode: 'INV_SERIAL_QUANTITY_MUST_BE_ONE',
      title: 'Invalid Serialized Waste Quantity',
      detail: 'Serialized waste items must have a normalized base quantity of exactly 1.',
    });
  }

  const balanceRow = await trx.db
    .selectFrom('inventory_balances')
    .select(['qty_on_hand', 'qty_reserved', 'moving_avg_cost', 'total_inventory_value'])
    .where('tenant_id', '=', trx.tenantId)
    .where('warehouse_id', '=', params.warehouseId)
    .where('product_id', '=', params.productId)
    .executeTakeFirst();

  const onHand = balanceRow ? Quantity.fromDecimalString(String(balanceRow.qty_on_hand)) : Quantity.zero();
  const reserved = balanceRow ? Quantity.fromDecimalString(String(balanceRow.qty_reserved ?? '0')) : Quantity.zero();
  let available = onHand.subtract(reserved);
  if (available.isNegative()) available = Quantity.zero();

  let batchRow:
    | { id: string; current_quantity: string; reserved_quantity: string; unit_cost: string | null }
    | undefined;
  if (params.batchId) {
    batchRow = await trx.db
      .selectFrom('inventory_batches')
      .select(['id', 'current_quantity', 'reserved_quantity', 'unit_cost'])
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', params.batchId)
      .where('warehouse_id', '=', params.warehouseId)
      .where('product_id', '=', params.productId)
      .executeTakeFirst();
    if (!batchRow) {
      throw new AppError({
        statusCode: 404,
        errorCode: 'INV_BATCH_NOT_FOUND',
        title: 'Batch Not Found',
        detail: `Batch "${params.batchId}" was not found in warehouse "${params.warehouseId}".`,
      });
    }
    const batchAvail = Quantity.fromDecimalString(String(batchRow.current_quantity)).subtract(
      Quantity.fromDecimalString(String(batchRow.reserved_quantity ?? '0')),
    );
    available = batchAvail.isNegative() ? Quantity.zero() : batchAvail;
  }

  if (params.serialId) {
    const serRow = await trx.db
      .selectFrom('inventory_serials')
      .select(['id', 'status', 'warehouse_id'])
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', params.serialId)
      .where('product_id', '=', params.productId)
      .executeTakeFirst();
    if (!serRow) {
      throw new AppError({
        statusCode: 404,
        errorCode: 'INV_SERIAL_NOT_FOUND',
        title: 'Serial Number Not Found',
        detail: `Serial "${params.serialId}" was not found for product "${product.sku}".`,
      });
    }
    const okSerial =
      serRow.warehouse_id === params.warehouseId &&
      (serRow.status === 'IN_STOCK' || serRow.status === 'QUARANTINED' || serRow.status === 'DAMAGED');
    available = okSerial ? Quantity.fromInteger(1) : Quantity.zero();
  }

  const sufficientStock = !product.trackInventory || available.compare(baseQty) >= 0;

  let unitCost = Money.fromDecimalString(product.purchaseCost, params.baseCurrency);
  let totalCost = unitCost.multiplyByQuantity(baseQty, 'HALF_EVEN');
  let costBreakdownNote = `Fallback product baseline (${product.valuationMethod})`;

  if (product.trackInventory) {
    if (product.valuationMethod === 'FIFO') {
      let lq = trx.db
        .selectFrom('inventory_cost_layers')
        .select(['id', 'batch_id', 'remaining_qty', 'unit_cost'])
        .where('tenant_id', '=', trx.tenantId)
        .where('warehouse_id', '=', params.warehouseId)
        .where('product_id', '=', params.productId)
        .where('status', '=', 'OPEN')
        .where('remaining_qty', '>', '0');
      if (params.batchId) {
        lq = lq.where('batch_id', '=', params.batchId);
      }
      const openLayers = await lq
        .orderBy('layer_date', 'asc')
        .orderBy('created_at', 'asc')
        .execute();

      const fifoLayers: FifoCostLayer[] = openLayers.map((l) => ({
        layerId: l.id,
        batchId: l.batch_id ?? '',
        remainingQty: Quantity.fromDecimalString(String(l.remaining_qty)),
        unitCost: Money.fromDecimalString(String(l.unit_cost), params.baseCurrency),
      }));
      const fallbackCost =
        batchRow?.unit_cost != null
          ? Money.fromDecimalString(String(batchRow.unit_cost), params.baseCurrency)
          : unitCost;

      const sim = consumeFifoCostLayers({
        layers: fifoLayers,
        qtyToConsume: baseQty,
        fallbackUnitCost: fallbackCost,
        allowNegativeStock: true,
      });
      unitCost = sim.effectiveUnitCostSnapshot;
      totalCost = sim.totalCogs;
      costBreakdownNote =
        openLayers.length > 0
          ? `FIFO across ${sim.consumedSlices.length || openLayers.length} open cost layer(s)`
          : 'FIFO layer empty (batch/baseline fallback)';
    } else {
      const mac = balanceRow
        ? Money.fromDecimalString(String(balanceRow.moving_avg_cost), params.baseCurrency)
        : unitCost;
      const totalVal = balanceRow
        ? Money.fromDecimalString(String(balanceRow.total_inventory_value), params.baseCurrency)
        : Money.zero(params.baseCurrency);
      if (balanceRow && onHand.isPositive()) {
        const issueSim = applyMacOutboundIssue({
          currentState: {
            qtyOnHand: onHand,
            movingAvgCost: mac,
            totalInventoryValue: totalVal,
          },
          qtyIssued: baseQty,
          allowNegativeStock: true,
        });
        unitCost = issueSim.unitCostSnapshot;
        totalCost = issueSim.cogsAmount;
        costBreakdownNote = `Moving Average Cost (MAC = ${mac.toDecimalString()}/${product.baseUom})`;
      } else {
        unitCost = mac;
        totalCost = mac.multiplyByQuantity(baseQty, 'HALF_EVEN');
        costBreakdownNote = 'Moving Average Cost baseline';
      }
    }
  }

  return {
    product,
    uomCode,
    wasteQty,
    conversionFactorStr,
    baseQty,
    unitCost,
    totalCost,
    available,
    sufficientStock,
    costBreakdownNote,
  };
}

export async function previewWasteLogCost(
  trx: TenantTransactionContext,
  input: WasteCostPreviewRequest,
): Promise<WasteCostPreviewResponse> {
  try {
    await assertAuthorized(trx, {
      permission: 'inv:waste:create',
      branchId: input.branchId,
      warehouseId: input.warehouseId,
    });
  } catch {
    await assertAuthorized(trx, {
      permission: 'inv:waste:read',
      branchId: input.branchId,
      warehouseId: input.warehouseId,
    });
  }

  await verifyBranchAndWarehouseRelationship(trx, input.branchId, input.warehouseId);
  const baseCurrency = await getTenantBaseCurrency(trx);

  let totalQty = Quantity.zero();
  let totalCost = Money.zero(baseCurrency);
  const lines: WasteCostPreviewResponse['lines'] = [];

  for (const line of input.lines) {
    const est = await estimateLineCostAndAvailability(trx, {
      branchId: input.branchId,
      warehouseId: input.warehouseId,
      baseCurrency,
      productId: line.productId,
      batchId: line.batchId ?? null,
      serialId: line.serialId ?? null,
      stockIntakeLotId: line.stockIntakeLotId ?? null,
      uomCode: line.uomCode ?? null,
      wasteQtyStr: line.wasteQty,
    });

    totalQty = totalQty.add(est.baseQty);
    totalCost = totalCost.add(est.totalCost);
    lines.push({
      productId: est.product.id,
      sku: est.product.sku,
      productName: est.product.name,
      wasteUom: est.uomCode,
      wasteQty: est.wasteQty.toDecimalString(),
      baseUom: est.product.baseUom,
      normalizedBaseQty: est.baseQty.toDecimalString(),
      valuationMethod: est.product.valuationMethod,
      estimatedUnitCostPerBase: est.unitCost.toDecimalString(),
      estimatedTotalCost: est.totalCost.toDecimalString(),
      availableBaseQty: est.available.toDecimalString(),
      sufficientStock: est.sufficientStock,
      costBreakdownNote: est.costBreakdownNote,
    });
  }

  return {
    currencyCode: baseCurrency,
    totalEstimatedBaseQty: totalQty.toDecimalString(),
    totalEstimatedCost: totalCost.toDecimalString(),
    lines,
  };
}

async function hydrateWasteLogResponse(
  trx: TenantTransactionContext,
  wasteLogId: string,
): Promise<WasteLogResponse> {
  const header = await trx.db
    .selectFrom('waste_logs')
    .innerJoin('branches', (join) =>
      join
        .onRef('waste_logs.tenant_id', '=', 'branches.tenant_id')
        .onRef('waste_logs.branch_id', '=', 'branches.id'),
    )
    .innerJoin('warehouses', (join) =>
      join
        .onRef('waste_logs.tenant_id', '=', 'warehouses.tenant_id')
        .onRef('waste_logs.warehouse_id', '=', 'warehouses.id'),
    )
    .leftJoin('pos_returns', (join) =>
      join
        .onRef('waste_logs.tenant_id', '=', 'pos_returns.tenant_id')
        .onRef('waste_logs.source_reference_id', '=', 'pos_returns.id'),
    )
    .leftJoin('users as cu', 'waste_logs.created_by_user_id', 'cu.id')
    .leftJoin('users as confu', 'waste_logs.confirmed_by_user_id', 'confu.id')
    .leftJoin('users as revu', 'waste_logs.reversed_by_user_id', 'revu.id')
    .select([
      'waste_logs.id',
      'waste_logs.tenant_id',
      'waste_logs.waste_number',
      'waste_logs.branch_id',
      'branches.name as branch_name',
      'waste_logs.warehouse_id',
      'warehouses.name as warehouse_name',
      'waste_logs.source_type',
      'waste_logs.source_reference_id',
      'pos_returns.return_number as source_return_number',
      'waste_logs.status',
      'waste_logs.reason_id',
      'waste_logs.reason_code',
      'waste_logs.reason_name',
      'waste_logs.description',
      'waste_logs.currency_code',
      'waste_logs.total_base_qty',
      'waste_logs.total_cost',
      'waste_logs.sync_command_id',
      'waste_logs.created_by_user_id',
      'cu.full_name as created_by_name',
      'waste_logs.confirmed_by_user_id',
      'confu.full_name as confirmed_by_name',
      'waste_logs.confirmed_at',
      'waste_logs.cancelled_by_user_id',
      'waste_logs.cancelled_at',
      'waste_logs.reversed_by_user_id',
      'revu.full_name as reversed_by_name',
      'waste_logs.reversed_at',
      'waste_logs.reversal_reason',
      'waste_logs.created_at',
      'waste_logs.updated_at',
    ])
    .where('waste_logs.tenant_id', '=', trx.tenantId)
    .where('waste_logs.id', '=', wasteLogId)
    .executeTakeFirst();

  if (!header) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'INV_WASTE_NOT_FOUND',
      title: 'Waste Log Not Found',
      detail: `Waste log "${wasteLogId}" was not found.`,
    });
  }

  const lineRows = await trx.db
    .selectFrom('waste_log_lines')
    .innerJoin('products', (join) =>
      join
        .onRef('waste_log_lines.tenant_id', '=', 'products.tenant_id')
        .onRef('waste_log_lines.product_id', '=', 'products.id'),
    )
    .leftJoin('categories', (join) =>
      join
        .onRef('products.tenant_id', '=', 'categories.tenant_id')
        .onRef('products.category_id', '=', 'categories.id'),
    )
    .leftJoin('inventory_batches', (join) =>
      join
        .onRef('waste_log_lines.tenant_id', '=', 'inventory_batches.tenant_id')
        .onRef('waste_log_lines.batch_id', '=', 'inventory_batches.id'),
    )
    .leftJoin('inventory_serials', (join) =>
      join
        .onRef('waste_log_lines.tenant_id', '=', 'inventory_serials.tenant_id')
        .onRef('waste_log_lines.serial_id', '=', 'inventory_serials.id'),
    )
    .select([
      'waste_log_lines.id',
      'waste_log_lines.line_number',
      'waste_log_lines.product_id',
      'products.sku as product_sku',
      'products.name as product_name',
      'products.category_id',
      'categories.name as category_name',
      'products.base_uom',
      'waste_log_lines.batch_id',
      'inventory_batches.batch_number',
      'inventory_batches.expiry_date',
      'waste_log_lines.serial_id',
      'inventory_serials.serial_number',
      'waste_log_lines.stock_intake_lot_id',
      'waste_log_lines.pos_return_line_id',
      'waste_log_lines.sales_invoice_id',
      'waste_log_lines.sales_invoice_line_id',
      'waste_log_lines.waste_uom',
      'waste_log_lines.waste_qty',
      'waste_log_lines.conversion_factor_to_base',
      'waste_log_lines.normalized_base_qty',
      'waste_log_lines.deducted_from_on_hand',
      'waste_log_lines.valuation_method_snapshot',
      'waste_log_lines.unit_cost_snapshot',
      'waste_log_lines.total_cost_snapshot',
      'waste_log_lines.consumed_cost_layers_json',
      'waste_log_lines.ledger_entry_id',
      'waste_log_lines.reversal_ledger_entry_id',
      'waste_log_lines.notes',
    ])
    .where('waste_log_lines.tenant_id', '=', trx.tenantId)
    .where('waste_log_lines.waste_log_id', '=', wasteLogId)
    .orderBy('waste_log_lines.line_number', 'asc')
    .execute();

  const lines: WasteLogLineResponse[] = lineRows.map((l) => ({
    id: l.id,
    lineNumber: Number(l.line_number),
    productId: l.product_id,
    productSku: l.product_sku,
    productName: l.product_name,
    categoryId: l.category_id ?? null,
    categoryName: l.category_name ?? null,
    baseUom: l.base_uom,
    batchId: l.batch_id ?? null,
    batchNumber: l.batch_number ?? null,
    expiryDate: l.expiry_date ? new Date(l.expiry_date).toISOString().slice(0, 10) : null,
    serialId: l.serial_id ?? null,
    serialNumber: l.serial_number ?? null,
    stockIntakeLotId: l.stock_intake_lot_id ?? null,
    posReturnLineId: l.pos_return_line_id ?? null,
    salesInvoiceId: l.sales_invoice_id ?? null,
    salesInvoiceLineId: l.sales_invoice_line_id ?? null,
    wasteUom: l.waste_uom,
    wasteQty: Quantity.fromDecimalString(String(l.waste_qty)).toDecimalString(),
    conversionFactorToBase: Quantity.fromDecimalString(String(l.conversion_factor_to_base)).toDecimalString(),
    normalizedBaseQty: Quantity.fromDecimalString(String(l.normalized_base_qty)).toDecimalString(),
    deductedFromOnHand: Boolean(l.deducted_from_on_hand),
    valuationMethodSnapshot: l.valuation_method_snapshot,
    unitCostSnapshot: Money.fromDecimalString(String(l.unit_cost_snapshot), header.currency_code).toDecimalString(),
    totalCostSnapshot: Money.fromDecimalString(String(l.total_cost_snapshot), header.currency_code).toDecimalString(),
    consumedCostLayersJson: (l.consumed_cost_layers_json as Record<string, unknown> | unknown[] | null) ?? null,
    ledgerEntryId: l.ledger_entry_id ?? null,
    reversalLedgerEntryId: l.reversal_ledger_entry_id ?? null,
    notes: l.notes ?? null,
  }));

  return {
    id: header.id,
    tenantId: header.tenant_id,
    wasteNumber: header.waste_number,
    branchId: header.branch_id,
    branchName: header.branch_name,
    warehouseId: header.warehouse_id,
    warehouseName: header.warehouse_name,
    sourceType: header.source_type,
    sourceReferenceId: header.source_reference_id ?? null,
    sourceReturnNumber: header.source_return_number ?? null,
    status: header.status,
    reasonId: header.reason_id,
    reasonCode: header.reason_code,
    reasonName: header.reason_name,
    description: header.description ?? null,
    currencyCode: header.currency_code,
    totalBaseQty: Quantity.fromDecimalString(String(header.total_base_qty)).toDecimalString(),
    totalCost: Money.fromDecimalString(String(header.total_cost), header.currency_code).toDecimalString(),
    syncCommandId: header.sync_command_id ?? null,
    createdByUserId: header.created_by_user_id,
    createdByName: header.created_by_name ?? null,
    confirmedByUserId: header.confirmed_by_user_id ?? null,
    confirmedByName: header.confirmed_by_name ?? null,
    confirmedAt: header.confirmed_at ? new Date(header.confirmed_at).toISOString() : null,
    cancelledByUserId: header.cancelled_by_user_id ?? null,
    cancelledAt: header.cancelled_at ? new Date(header.cancelled_at).toISOString() : null,
    reversedByUserId: header.reversed_by_user_id ?? null,
    reversedByName: header.reversed_by_name ?? null,
    reversedAt: header.reversed_at ? new Date(header.reversed_at).toISOString() : null,
    reversalReason: header.reversal_reason ?? null,
    createdAt: new Date(header.created_at).toISOString(),
    updatedAt: new Date(header.updated_at).toISOString(),
    lines,
  };
}

export async function createWasteLog(
  trx: TenantTransactionContext,
  idempotencyKey: string,
  input: CreateWasteLogRequest,
  options?: { skipPermissionCheck?: boolean },
): Promise<WasteLogResponse> {
  if (!options?.skipPermissionCheck) {
    await assertAuthorized(trx, {
      permission: 'inv:waste:create',
      branchId: input.branchId,
      warehouseId: input.warehouseId,
    });
    if (input.confirmImmediately) {
      await assertAuthorized(trx, {
        permission: 'inv:waste:confirm',
        branchId: input.branchId,
        warehouseId: input.warehouseId,
      });
    }
  }
  await assertSubscriptionEntitlement(trx, { requireWriteAccess: true });

  if (input.syncCommandId) {
    const existingSync = await trx.db
      .selectFrom('waste_logs')
      .select(['id'])
      .where('tenant_id', '=', trx.tenantId)
      .where('sync_command_id', '=', input.syncCommandId)
      .executeTakeFirst();
    if (existingSync) {
      return hydrateWasteLogResponse(trx, existingSync.id);
    }
  }

  await verifyBranchAndWarehouseRelationship(trx, input.branchId, input.warehouseId);
  const { reason, trimmedDesc } = await resolveWasteReasonForCode(
    trx,
    input.reasonCode,
    input.description ?? input.lines.map((l) => l.notes).filter(Boolean).join('; '),
  );
  const baseCurrency = await getTenantBaseCurrency(trx);

  const wasteLogId = generateUuidV7();
  const wasteNumber = generateWasteNumber();
  const now = new Date();

  let totalQty = Quantity.zero();
  let totalCost = Money.zero(baseCurrency);
  const preparedLines: Array<{
    productId: string;
    batchId: string | null;
    serialId: string | null;
    stockIntakeLotId: string | null;
    wasteUom: string;
    wasteQty: string;
    conversionFactor: string;
    baseQty: string;
    valuationMethod: 'MOVING_AVG' | 'FIFO';
    unitCost: string;
    totalCost: string;
    notes: string | null;
  }> = [];

  for (const line of input.lines) {
    const est = await estimateLineCostAndAvailability(trx, {
      branchId: input.branchId,
      warehouseId: input.warehouseId,
      baseCurrency,
      productId: line.productId,
      batchId: line.batchId ?? null,
      serialId: line.serialId ?? null,
      stockIntakeLotId: line.stockIntakeLotId ?? null,
      uomCode: line.uomCode ?? null,
      wasteQtyStr: line.wasteQty,
    });
    totalQty = totalQty.add(est.baseQty);
    totalCost = totalCost.add(est.totalCost);
    preparedLines.push({
      productId: est.product.id,
      batchId: line.batchId ?? null,
      serialId: line.serialId ?? null,
      stockIntakeLotId: line.stockIntakeLotId ?? null,
      wasteUom: est.uomCode,
      wasteQty: est.wasteQty.toDecimalString(),
      conversionFactor: est.conversionFactorStr,
      baseQty: est.baseQty.toDecimalString(),
      valuationMethod: est.product.valuationMethod,
      unitCost: est.unitCost.toDecimalString(),
      totalCost: est.totalCost.toDecimalString(),
      notes: line.notes?.trim() ?? null,
    });
  }

  await trx.db
    .insertInto('waste_logs')
    .values({
      id: wasteLogId,
      tenant_id: trx.tenantId,
      waste_number: wasteNumber,
      branch_id: input.branchId,
      warehouse_id: input.warehouseId,
      source_type: 'MANUAL',
      source_reference_id: null,
      status: 'DRAFT',
      reason_id: reason.id,
      reason_code: reason.code,
      reason_name: reason.name,
      description: trimmedDesc,
      currency_code: baseCurrency,
      total_base_qty: totalQty.toDecimalString(),
      total_cost: totalCost.toDecimalString(),
      sync_command_id: input.syncCommandId ?? null,
      created_by_user_id: trx.userId,
      confirmed_by_user_id: null,
      confirmed_at: null,
      cancelled_by_user_id: null,
      cancelled_at: null,
      reversed_by_user_id: null,
      reversed_at: null,
      reversal_reason: null,
      idempotency_key: idempotencyKey,
      created_at: now,
      updated_at: now,
    })
    .execute();

  for (let i = 0; i < preparedLines.length; i++) {
    const l = preparedLines[i]!;
    await trx.db
      .insertInto('waste_log_lines')
      .values({
        id: generateUuidV7(),
        tenant_id: trx.tenantId,
        waste_log_id: wasteLogId,
        line_number: i + 1,
        product_id: l.productId,
        batch_id: l.batchId,
        serial_id: l.serialId,
        stock_intake_lot_id: l.stockIntakeLotId,
        pos_return_line_id: null,
        sales_invoice_id: null,
        sales_invoice_line_id: null,
        waste_uom: l.wasteUom,
        waste_qty: l.wasteQty,
        conversion_factor_to_base: l.conversionFactor,
        normalized_base_qty: l.baseQty,
        deducted_from_on_hand: true,
        valuation_method_snapshot: l.valuationMethod,
        unit_cost_snapshot: l.unitCost,
        total_cost_snapshot: l.totalCost,
        consumed_cost_layers_json: null,
        prior_batch_status: null,
        prior_serial_status: null,
        ledger_entry_id: null,
        reversal_ledger_entry_id: null,
        notes: l.notes,
        created_at: now,
        updated_at: now,
      })
      .execute();
  }

  await appendAuditLog(trx, {
    action: 'INV_WASTE_DRAFT_CREATED',
    resourceType: 'WASTE_LOG',
    resourceId: wasteLogId,
    metadata: {
      wasteNumber,
      branchId: input.branchId,
      warehouseId: input.warehouseId,
      reasonCode: reason.code,
      totalBaseQty: totalQty.toDecimalString(),
      estimatedTotalCost: totalCost.toDecimalString(),
      syncCommandId: input.syncCommandId ?? null,
    },
  });

  if (input.confirmImmediately) {
    return confirmWasteLog(trx, idempotencyKey, wasteLogId, options);
  }

  return hydrateWasteLogResponse(trx, wasteLogId);
}

export async function confirmWasteLog(
  trx: TenantTransactionContext,
  idempotencyKey: string,
  wasteLogId: string,
  options?: { skipPermissionCheck?: boolean },
): Promise<WasteLogResponse> {
  const header = await trx.db
    .selectFrom('waste_logs')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', wasteLogId)
    .forUpdate()
    .executeTakeFirst();

  if (!header) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'INV_WASTE_NOT_FOUND',
      title: 'Waste Log Not Found',
      detail: `Waste log "${wasteLogId}" was not found.`,
    });
  }

  if (!options?.skipPermissionCheck) {
    await assertAuthorized(trx, {
      permission: 'inv:waste:confirm',
      branchId: header.branch_id,
      warehouseId: header.warehouse_id,
    });
  }
  await assertSubscriptionEntitlement(trx, { requireWriteAccess: true });

  if (header.status !== 'DRAFT') {
    throw new AppError({
      statusCode: 409,
      errorCode: 'INV_WASTE_INVALID_STATUS',
      title: 'Waste Log Cannot Be Confirmed',
      detail: `Waste log "${header.waste_number}" is in "${header.status}" status and cannot be confirmed.`,
    });
  }

  await verifyBranchAndWarehouseRelationship(trx, header.branch_id, header.warehouse_id);

  const lines = await trx.db
    .selectFrom('waste_log_lines')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('waste_log_id', '=', wasteLogId)
    .orderBy('line_number', 'asc')
    .forUpdate()
    .execute();

  const now = new Date();
  let confirmedTotalQty = Quantity.zero();
  let confirmedTotalCost = Money.zero(header.currency_code);

  for (const line of lines) {
    const product = await resolveProductForInventory(trx, line.product_id);
    if (product.status !== 'ACTIVE') {
      throw new AppError({
        statusCode: 409,
        errorCode: 'INV_PRODUCT_ARCHIVED',
        title: 'Product Archived',
        detail: `Product "${product.sku}" is archived.`,
      });
    }
    const visible = await isProductVisibleInBranch(trx, line.product_id, header.branch_id);
    if (!visible) {
      throw new AppError({
        statusCode: 404,
        errorCode: 'CAT_PRODUCT_NOT_IN_BRANCH',
        title: 'Product Not Available in Branch',
        detail: `Product "${product.sku}" is no longer assigned to branch "${header.branch_id}".`,
      });
    }

    const baseQty = Quantity.fromDecimalString(String(line.normalized_base_qty));
    confirmedTotalQty = confirmedTotalQty.add(baseQty);

    let ledgerId: string | null = line.ledger_entry_id ?? null;
    let unitCost = Money.fromDecimalString(String(line.unit_cost_snapshot), header.currency_code);
    let lineCost = Money.fromDecimalString(String(line.total_cost_snapshot), header.currency_code);
    let consumedLayersJson: unknown = line.consumed_cost_layers_json ?? null;
    let priorBatchStatus: string | null = line.prior_batch_status ?? null;
    let priorSerialStatus: string | null = line.prior_serial_status ?? null;

    if (line.deducted_from_on_hand && product.trackInventory) {
      const lineIdemKey =
        lines.length === 1 && header.idempotency_key !== idempotencyKey
          ? idempotencyKey
          : generateUuidV7();
      const mv = await postStockMovement(
        trx,
        lineIdemKey,
        {
          branchId: header.branch_id,
          warehouseId: header.warehouse_id,
          productId: line.product_id,
          batchId: line.batch_id ?? null,
          serialId: line.serial_id ?? null,
          stockIntakeLotId: line.stock_intake_lot_id ?? null,
          movementType: 'WASTE_OUT',
          quantity: `-${String(line.waste_qty)}`,
          uomCode: line.waste_uom,
          referenceType: 'WASTE_LOG',
          referenceId: wasteLogId,
          entrySource: 'WASTE',
          reason: `Waste ${header.waste_number} (${header.reason_name})${header.description ? `: ${header.description}` : ''}`,
        },
        { skipPermissionCheck: true },
      );

      ledgerId = mv.id;
      const ledgerRow = await trx.db
        .selectFrom('stock_ledger_entries')
        .select(['unit_cost', 'total_cost_delta', 'metadata_json'])
        .where('tenant_id', '=', trx.tenantId)
        .where('id', '=', mv.id)
        .executeTakeFirst();

      if (ledgerRow) {
        unitCost = Money.fromDecimalString(String(ledgerRow.unit_cost), header.currency_code);
        lineCost = Money.fromDecimalString(String(ledgerRow.total_cost_delta), header.currency_code).abs();
        const meta =
          ledgerRow.metadata_json && typeof ledgerRow.metadata_json === 'object'
            ? (ledgerRow.metadata_json as Record<string, unknown>)
            : null;
        if (meta) {
          consumedLayersJson = meta['consumedCostLayers'] ?? null;
          priorBatchStatus = typeof meta['priorBatchStatus'] === 'string' ? meta['priorBatchStatus'] : null;
          priorSerialStatus = typeof meta['priorSerialStatus'] === 'string' ? meta['priorSerialStatus'] : null;
        }
      }
    }

    confirmedTotalCost = confirmedTotalCost.add(lineCost);

    await trx.db
      .updateTable('waste_log_lines')
      .set({
        valuation_method_snapshot: product.valuationMethod,
        unit_cost_snapshot: unitCost.toDecimalString(),
        total_cost_snapshot: lineCost.toDecimalString(),
        consumed_cost_layers_json: consumedLayersJson ? JSON.stringify(consumedLayersJson) : null,
        prior_batch_status: priorBatchStatus,
        prior_serial_status: priorSerialStatus,
        ledger_entry_id: ledgerId,
        updated_at: now,
      })
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', line.id)
      .execute();
  }

  await trx.db
    .updateTable('waste_logs')
    .set({
      status: 'CONFIRMED',
      total_base_qty: confirmedTotalQty.toDecimalString(),
      total_cost: confirmedTotalCost.toDecimalString(),
      confirmed_by_user_id: trx.userId,
      confirmed_at: now,
      updated_at: now,
    })
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', wasteLogId)
    .execute();

  await appendAuditLog(trx, {
    action: 'INV_WASTE_CONFIRMED',
    resourceType: 'WASTE_LOG',
    resourceId: wasteLogId,
    metadata: {
      wasteNumber: header.waste_number,
      branchId: header.branch_id,
      warehouseId: header.warehouse_id,
      reasonCode: header.reason_code,
      totalBaseQty: confirmedTotalQty.toDecimalString(),
      totalCost: confirmedTotalCost.toDecimalString(),
    },
  });

  await enqueueOutboxEvent(trx, {
    aggregateType: 'WASTE_LOG',
    aggregateId: wasteLogId,
    eventType: 'WASTE_LOG_CONFIRMED',
    payload: {
      wasteLogId,
      wasteNumber: header.waste_number,
      branchId: header.branch_id,
      warehouseId: header.warehouse_id,
      sourceType: header.source_type,
      reasonCode: header.reason_code,
      totalCost: confirmedTotalCost.toDecimalString(),
      currencyCode: header.currency_code,
      accountingHint: {
        debitAccount: '5200_WASTE_EXPENSE',
        creditAccount: '1300_INVENTORY_ASSET',
        amount: confirmedTotalCost.toDecimalString(),
      },
    },
  });

  return hydrateWasteLogResponse(trx, wasteLogId);
}

/**
 * Internal helper invoked by Customer Return / Disposition flows inside the same DB transaction.
 * Strictly prevents double-deduction:
 * - When `deductFromOnHand === true` (stock previously entered `qty_on_hand`), posts `WASTE_OUT`.
 * - When `deductFromOnHand === false` (damaged/returned item never entered sellable stock),
 *   records the confirmed loss valued at historical `unitCostPerBase` without touching `qty_on_hand`,
 *   and transitions any linked serial (`SOLD` | `RETURNED`) -> `WRITTEN_OFF`.
 */
export async function createReturnLinkedWasteLog(
  trx: TenantTransactionContext,
  params: {
    branchId: string;
    warehouseId: string;
    posReturnId: string;
    posReturnNumber: string;
    reasonCode?: string | null;
    description?: string | null;
    currencyCode: string;
    idempotencyKey: string;
    lines: ReadonlyArray<{
      posReturnLineId: string;
      salesInvoiceId: string;
      salesInvoiceLineId: string;
      productId: string;
      batchId: string | null;
      serialId: string | null;
      stockIntakeLotId: string | null;
      wasteUom: string;
      wasteQty: string;
      conversionFactorToBase: string;
      normalizedBaseQty: string;
      unitCostPerBase: string;
      deductFromOnHand: boolean;
      notes?: string | null;
    }>;
  },
): Promise<WasteLogResponse> {
  const effectiveReasonCode = (params.reasonCode?.trim() || 'DAMAGED').toUpperCase();
  const { reason, trimmedDesc } = await resolveWasteReasonForCode(
    trx,
    effectiveReasonCode,
    params.description ?? `Customer Return ${params.posReturnNumber}`,
  );

  const wasteLogId = generateUuidV7();
  const wasteNumber = generateWasteNumber();
  const now = new Date();

  let totalQty = Quantity.zero();
  let totalCost = Money.zero(params.currencyCode);

  await trx.db
    .insertInto('waste_logs')
    .values({
      id: wasteLogId,
      tenant_id: trx.tenantId,
      waste_number: wasteNumber,
      branch_id: params.branchId,
      warehouse_id: params.warehouseId,
      source_type: 'CUSTOMER_RETURN',
      source_reference_id: params.posReturnId,
      status: 'CONFIRMED',
      reason_id: reason.id,
      reason_code: reason.code,
      reason_name: reason.name,
      description: trimmedDesc,
      currency_code: params.currencyCode,
      total_base_qty: '0.000000',
      total_cost: '0.0000',
      sync_command_id: null,
      created_by_user_id: trx.userId,
      confirmed_by_user_id: trx.userId,
      confirmed_at: now,
      cancelled_by_user_id: null,
      cancelled_at: null,
      reversed_by_user_id: null,
      reversed_at: null,
      reversal_reason: null,
      idempotency_key: params.idempotencyKey,
      created_at: now,
      updated_at: now,
    })
    .execute();

  for (let i = 0; i < params.lines.length; i++) {
    const l = params.lines[i]!;
    const product = await resolveProductForInventory(trx, l.productId);
    const baseQty = Quantity.fromDecimalString(l.normalizedBaseQty);
    totalQty = totalQty.add(baseQty);

    let ledgerId: string | null = null;
    let unitCost = Money.fromDecimalString(l.unitCostPerBase, params.currencyCode);
    let lineCost = unitCost.multiplyByQuantity(baseQty, 'HALF_EVEN');
    let consumedLayersJson: unknown = null;
    let priorBatchStatus: string | null = null;
    let priorSerialStatus: string | null = null;

    if (l.deductFromOnHand && product.trackInventory) {
      const mv = await postStockMovement(
        trx,
        generateUuidV7(),
        {
          branchId: params.branchId,
          warehouseId: params.warehouseId,
          productId: l.productId,
          batchId: l.batchId ?? null,
          serialId: l.serialId ?? null,
          stockIntakeLotId: l.stockIntakeLotId ?? null,
          movementType: 'WASTE_OUT',
          quantity: `-${l.wasteQty}`,
          uomCode: l.wasteUom,
          referenceType: 'WASTE_LOG',
          referenceId: wasteLogId,
          entrySource: 'WASTE',
          reason: `Return ${params.posReturnNumber} waste disposition (${reason.name})`,
        },
        { skipPermissionCheck: true },
      );
      ledgerId = mv.id;
      const ledgerRow = await trx.db
        .selectFrom('stock_ledger_entries')
        .select(['unit_cost', 'total_cost_delta', 'metadata_json'])
        .where('tenant_id', '=', trx.tenantId)
        .where('id', '=', mv.id)
        .executeTakeFirst();
      if (ledgerRow) {
        unitCost = Money.fromDecimalString(String(ledgerRow.unit_cost), params.currencyCode);
        lineCost = Money.fromDecimalString(String(ledgerRow.total_cost_delta), params.currencyCode).abs();
        const meta =
          ledgerRow.metadata_json && typeof ledgerRow.metadata_json === 'object'
            ? (ledgerRow.metadata_json as Record<string, unknown>)
            : null;
        if (meta) {
          consumedLayersJson = meta['consumedCostLayers'] ?? null;
          priorBatchStatus = typeof meta['priorBatchStatus'] === 'string' ? meta['priorBatchStatus'] : null;
          priorSerialStatus = typeof meta['priorSerialStatus'] === 'string' ? meta['priorSerialStatus'] : null;
        }
      }
    } else if (l.serialId) {
      const ser = await trx.db
        .selectFrom('inventory_serials')
        .select(['id', 'status'])
        .where('tenant_id', '=', trx.tenantId)
        .where('id', '=', l.serialId)
        .forUpdate()
        .executeTakeFirst();
      if (ser && ser.status !== 'WRITTEN_OFF') {
        priorSerialStatus = ser.status;
        await trx.db
          .updateTable('inventory_serials')
          .set({ status: 'WRITTEN_OFF', updated_at: now })
          .where('tenant_id', '=', trx.tenantId)
          .where('id', '=', ser.id)
          .execute();
        await trx.db
          .insertInto('inventory_serial_transitions')
          .values({
            id: generateUuidV7(),
            tenant_id: trx.tenantId,
            serial_id: ser.id,
            from_status: ser.status,
            to_status: 'WRITTEN_OFF',
            reference_type: 'WASTE_LOG',
            reference_id: wasteLogId,
            actor_user_id: trx.userId,
            notes: `Return ${params.posReturnNumber} damaged waste write-off`,
            occurred_at: now,
          })
          .execute();
      }
    }

    totalCost = totalCost.add(lineCost);

    await trx.db
      .insertInto('waste_log_lines')
      .values({
        id: generateUuidV7(),
        tenant_id: trx.tenantId,
        waste_log_id: wasteLogId,
        line_number: i + 1,
        product_id: l.productId,
        batch_id: l.batchId ?? null,
        serial_id: l.serialId ?? null,
        stock_intake_lot_id: l.stockIntakeLotId ?? null,
        pos_return_line_id: l.posReturnLineId,
        sales_invoice_id: l.salesInvoiceId,
        sales_invoice_line_id: l.salesInvoiceLineId,
        waste_uom: l.wasteUom,
        waste_qty: l.wasteQty,
        conversion_factor_to_base: l.conversionFactorToBase,
        normalized_base_qty: l.normalizedBaseQty,
        deducted_from_on_hand: l.deductFromOnHand,
        valuation_method_snapshot: product.valuationMethod,
        unit_cost_snapshot: unitCost.toDecimalString(),
        total_cost_snapshot: lineCost.toDecimalString(),
        consumed_cost_layers_json: consumedLayersJson ? JSON.stringify(consumedLayersJson) : null,
        prior_batch_status: priorBatchStatus,
        prior_serial_status: priorSerialStatus,
        ledger_entry_id: ledgerId,
        reversal_ledger_entry_id: null,
        notes: l.notes?.trim() ?? null,
        created_at: now,
        updated_at: now,
      })
      .execute();
  }

  await trx.db
    .updateTable('waste_logs')
    .set({
      total_base_qty: totalQty.toDecimalString(),
      total_cost: totalCost.toDecimalString(),
      updated_at: now,
    })
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', wasteLogId)
    .execute();

  await appendAuditLog(trx, {
    action: 'INV_WASTE_CONFIRMED',
    resourceType: 'WASTE_LOG',
    resourceId: wasteLogId,
    metadata: {
      wasteNumber,
      sourceType: 'CUSTOMER_RETURN',
      posReturnId: params.posReturnId,
      posReturnNumber: params.posReturnNumber,
      reasonCode: reason.code,
      totalBaseQty: totalQty.toDecimalString(),
      totalCost: totalCost.toDecimalString(),
    },
  });

  await enqueueOutboxEvent(trx, {
    aggregateType: 'WASTE_LOG',
    aggregateId: wasteLogId,
    eventType: 'WASTE_LOG_CONFIRMED',
    payload: {
      wasteLogId,
      wasteNumber,
      branchId: params.branchId,
      warehouseId: params.warehouseId,
      sourceType: 'CUSTOMER_RETURN',
      posReturnId: params.posReturnId,
      reasonCode: reason.code,
      totalCost: totalCost.toDecimalString(),
      currencyCode: params.currencyCode,
    },
  });

  return hydrateWasteLogResponse(trx, wasteLogId);
}

export async function cancelWasteLog(
  trx: TenantTransactionContext,
  wasteLogId: string,
): Promise<WasteLogResponse> {
  const header = await trx.db
    .selectFrom('waste_logs')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', wasteLogId)
    .forUpdate()
    .executeTakeFirst();

  if (!header) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'INV_WASTE_NOT_FOUND',
      title: 'Waste Log Not Found',
      detail: `Waste log "${wasteLogId}" was not found.`,
    });
  }

  await assertAuthorized(trx, {
    permission: 'inv:waste:reverse',
    branchId: header.branch_id,
    warehouseId: header.warehouse_id,
  });
  await assertSubscriptionEntitlement(trx, { requireWriteAccess: true });

  if (header.status !== 'DRAFT') {
    throw new AppError({
      statusCode: 409,
      errorCode: 'INV_WASTE_IMMUTABLE',
      title: 'Confirmed Waste Log Cannot Be Deleted Or Cancelled Directly',
      detail: `Waste log "${header.waste_number}" is "${header.status}". Use controlled reversal instead.`,
    });
  }

  const now = new Date();
  await trx.db
    .updateTable('waste_logs')
    .set({
      status: 'CANCELLED',
      cancelled_by_user_id: trx.userId,
      cancelled_at: now,
      updated_at: now,
    })
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', wasteLogId)
    .execute();

  await appendAuditLog(trx, {
    action: 'INV_WASTE_CANCELLED',
    resourceType: 'WASTE_LOG',
    resourceId: wasteLogId,
    metadata: { wasteNumber: header.waste_number },
  });

  return hydrateWasteLogResponse(trx, wasteLogId);
}

export async function reverseWasteLog(
  trx: TenantTransactionContext,
  wasteLogId: string,
  input: ReverseWasteLogRequest,
): Promise<WasteLogResponse> {
  const header = await trx.db
    .selectFrom('waste_logs')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', wasteLogId)
    .forUpdate()
    .executeTakeFirst();

  if (!header) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'INV_WASTE_NOT_FOUND',
      title: 'Waste Log Not Found',
      detail: `Waste log "${wasteLogId}" was not found.`,
    });
  }

  await assertAuthorized(trx, {
    permission: 'inv:waste:reverse',
    branchId: header.branch_id,
    warehouseId: header.warehouse_id,
  });
  await assertSubscriptionEntitlement(trx, { requireWriteAccess: true });

  if (header.status !== 'CONFIRMED') {
    throw new AppError({
      statusCode: 409,
      errorCode: 'INV_WASTE_NOT_CONFIRMED',
      title: 'Waste Log Is Not Reversable',
      detail: `Only CONFIRMED waste logs can be reversed (current status: "${header.status}").`,
    });
  }

  const reason = input.reason.trim();
  if (reason.length < 5) {
    throw new AppError({
      statusCode: 400,
      errorCode: 'ERR_VALIDATION_FAILED',
      title: 'Invalid Reversal Reason',
      detail: 'Reversal reason must be at least 5 characters.',
    });
  }

  const lines = await trx.db
    .selectFrom('waste_log_lines')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('waste_log_id', '=', wasteLogId)
    .forUpdate()
    .execute();

  const now = new Date();
  for (const line of lines) {
    let reversalLedgerId: string | null = null;
    if (line.ledger_entry_id) {
      const rev = await reverseStockMovement(
        trx,
        line.ledger_entry_id,
        generateUuidV7(),
        { reason: `Waste Reversal ${header.waste_number}: ${reason}` },
        { skipPermissionCheck: true },
      );
      reversalLedgerId = rev.id;
      await trx.db
        .updateTable('waste_log_lines')
        .set({ reversal_ledger_entry_id: reversalLedgerId, updated_at: now })
        .where('tenant_id', '=', trx.tenantId)
        .where('id', '=', line.id)
        .execute();
    } else if (line.serial_id && line.prior_serial_status) {
      await trx.db
        .updateTable('inventory_serials')
        .set({ status: line.prior_serial_status as 'RETURNED' | 'SOLD' | 'QUARANTINED' | 'DAMAGED' | 'IN_STOCK', updated_at: now })
        .where('tenant_id', '=', trx.tenantId)
        .where('id', '=', line.serial_id)
        .execute();
      await trx.db
        .insertInto('inventory_serial_transitions')
        .values({
          id: generateUuidV7(),
          tenant_id: trx.tenantId,
          serial_id: line.serial_id,
          from_status: 'WRITTEN_OFF',
          to_status: line.prior_serial_status,
          reference_type: 'WASTE_REVERSAL',
          reference_id: wasteLogId,
          actor_user_id: trx.userId,
          notes: `Waste Reversal ${header.waste_number}: ${reason}`,
          occurred_at: now,
        })
        .execute();
    }

    if (line.pos_return_line_id) {
      const retLine = await trx.db
        .selectFrom('pos_return_lines')
        .selectAll()
        .where('tenant_id', '=', trx.tenantId)
        .where('id', '=', line.pos_return_line_id)
        .forUpdate()
        .executeTakeFirst();
      if (retLine) {
        const reversedBase = Quantity.fromDecimalString(String(line.normalized_base_qty));
        const curWasted = Quantity.fromDecimalString(String(retLine.wasted_base_qty ?? '0'));
        const curRestocked = Quantity.fromDecimalString(String(retLine.restocked_base_qty ?? '0'));
        const curPending = Quantity.fromDecimalString(String(retLine.pending_base_qty ?? '0'));
        const nextWasted = curWasted.compare(reversedBase) >= 0 ? curWasted.subtract(reversedBase) : Quantity.zero();
        const nextRestocked = line.deducted_from_on_hand ? curRestocked.add(reversedBase) : curRestocked;
        const nextPending = line.deducted_from_on_hand ? curPending : curPending.add(reversedBase);
        const nextStatus = nextPending.isPositive()
          ? (nextRestocked.isPositive() || nextWasted.isPositive() ? 'PARTIAL' : 'PENDING_INSPECTION')
          : nextWasted.isPositive() && nextRestocked.isPositive()
            ? 'MIXED'
            : nextRestocked.isPositive()
              ? 'RESTOCKED'
              : 'WASTED';

        await trx.db
          .updateTable('pos_return_lines')
          .set({
            wasted_base_qty: nextWasted.toDecimalString(),
            restocked_base_qty: nextRestocked.toDecimalString(),
            pending_base_qty: nextPending.toDecimalString(),
            disposition_status: nextStatus,
          })
          .where('tenant_id', '=', trx.tenantId)
          .where('id', '=', retLine.id)
          .execute();
      }
    }
  }

  await trx.db
    .updateTable('waste_logs')
    .set({
      status: 'REVERSED',
      reversed_by_user_id: trx.userId,
      reversed_at: now,
      reversal_reason: reason,
      updated_at: now,
    })
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', wasteLogId)
    .execute();

  await appendAuditLog(trx, {
    action: 'INV_WASTE_REVERSED',
    resourceType: 'WASTE_LOG',
    resourceId: wasteLogId,
    metadata: {
      wasteNumber: header.waste_number,
      reversalReason: reason,
    },
  });

  await enqueueOutboxEvent(trx, {
    aggregateType: 'WASTE_LOG',
    aggregateId: wasteLogId,
    eventType: 'WASTE_LOG_REVERSED',
    payload: {
      wasteLogId,
      wasteNumber: header.waste_number,
      branchId: header.branch_id,
      warehouseId: header.warehouse_id,
      totalCost: String(header.total_cost),
      reversalReason: reason,
    },
  });

  return hydrateWasteLogResponse(trx, wasteLogId);
}

export async function getWasteLogById(
  trx: TenantTransactionContext,
  wasteLogId: string,
): Promise<WasteLogResponse> {
  const res = await hydrateWasteLogResponse(trx, wasteLogId);
  await assertAuthorized(trx, {
    permission: 'inv:waste:read',
    branchId: res.branchId,
    warehouseId: res.warehouseId,
  });
  return res;
}

export async function listWasteLogs(
  trx: TenantTransactionContext,
  query: ListWasteLogsQuery,
): Promise<{ items: WasteLogResponse[]; total: number; limit: number; offset: number }> {
  await assertAuthorized(trx, {
    permission: 'inv:waste:read',
    branchId: query.branchId,
    warehouseId: query.warehouseId,
  });

  const authCtx = await resolveMemberAuthorizationContext(trx);
  const limit = Math.min(Math.max(query.limit ?? 25, 1), 100);
  const offset = Math.max(query.offset ?? 0, 0);

  let baseQ = trx.db
    .selectFrom('waste_logs')
    .where('waste_logs.tenant_id', '=', trx.tenantId);

  if (!authCtx.allLocationsAccess) {
    if (authCtx.allowedBranchIds.size === 0 && authCtx.allowedWarehouseIds.size === 0) {
      return { items: [], total: 0, limit, offset };
    }
    if (authCtx.allowedBranchIds.size > 0) {
      baseQ = baseQ.where('waste_logs.branch_id', 'in', [...authCtx.allowedBranchIds]);
    }
    if (authCtx.allowedWarehouseIds.size > 0) {
      baseQ = baseQ.where('waste_logs.warehouse_id', 'in', [...authCtx.allowedWarehouseIds]);
    }
  }

  if (query.branchId) baseQ = baseQ.where('waste_logs.branch_id', '=', query.branchId);
  if (query.warehouseId) baseQ = baseQ.where('waste_logs.warehouse_id', '=', query.warehouseId);
  if (query.status) baseQ = baseQ.where('waste_logs.status', '=', query.status);
  if (query.sourceType) baseQ = baseQ.where('waste_logs.source_type', '=', query.sourceType);
  if (query.reasonCode) baseQ = baseQ.where('waste_logs.reason_code', '=', query.reasonCode.trim().toUpperCase());
  if (query.startDate) baseQ = baseQ.where('waste_logs.created_at', '>=', new Date(`${query.startDate}T00:00:00.000Z`));
  if (query.endDate) baseQ = baseQ.where('waste_logs.created_at', '<=', new Date(`${query.endDate}T23:59:59.999Z`));

  if (query.search && query.search.trim().length > 0) {
    const pattern = `%${query.search.trim().toLowerCase()}%`;
    baseQ = baseQ.where((eb) =>
      eb.or([
        eb(sql`LOWER(waste_logs.waste_number)`, 'like', pattern),
        eb(sql`LOWER(COALESCE(waste_logs.description, ''))`, 'like', pattern),
        eb(sql`LOWER(waste_logs.reason_name)`, 'like', pattern),
        eb.exists(
          eb
            .selectFrom('waste_log_lines')
            .innerJoin('products', (join) =>
              join
                .onRef('waste_log_lines.tenant_id', '=', 'products.tenant_id')
                .onRef('waste_log_lines.product_id', '=', 'products.id'),
            )
            .select('waste_log_lines.id')
            .whereRef('waste_log_lines.tenant_id', '=', 'waste_logs.tenant_id')
            .whereRef('waste_log_lines.waste_log_id', '=', 'waste_logs.id')
            .where((eb2) =>
              eb2.or([
                eb2(sql`LOWER(products.sku)`, 'like', pattern),
                eb2(sql`LOWER(products.name)`, 'like', pattern),
              ]),
            ),
        ),
      ]),
    );
  }

  const countRow = await baseQ
    .select(sql<number>`count(*)::int`.as('cnt'))
    .executeTakeFirst();
  const total = Number(countRow?.cnt ?? 0);

  const idRows = await baseQ
    .select(['waste_logs.id'])
    .orderBy('waste_logs.created_at', 'desc')
    .limit(limit)
    .offset(offset)
    .execute();

  const items: WasteLogResponse[] = [];
  for (const row of idRows) {
    items.push(await hydrateWasteLogResponse(trx, row.id));
  }

  return { items, total, limit, offset };
}

export async function getWasteDashboardAndReport(
  trx: TenantTransactionContext,
  query: WasteReportQuery,
  requiredPermission: 'inv:waste:read' | 'inv:waste:report' = 'inv:waste:read',
) {
  await assertAuthorized(trx, {
    permission: requiredPermission,
    branchId: query.branchId,
    warehouseId: query.warehouseId,
  });

  const authCtx = await resolveMemberAuthorizationContext(trx);
  const baseCurrency = await getTenantBaseCurrency(trx);
  const granularity = query.granularity ?? 'DAILY';

  let confirmedQ = trx.db
    .selectFrom('waste_log_lines')
    .innerJoin('waste_logs', (join) =>
      join
        .onRef('waste_log_lines.tenant_id', '=', 'waste_logs.tenant_id')
        .onRef('waste_log_lines.waste_log_id', '=', 'waste_logs.id'),
    )
    .innerJoin('products', (join) =>
      join
        .onRef('waste_log_lines.tenant_id', '=', 'products.tenant_id')
        .onRef('waste_log_lines.product_id', '=', 'products.id'),
    )
    .leftJoin('categories', (join) =>
      join
        .onRef('products.tenant_id', '=', 'categories.tenant_id')
        .onRef('products.category_id', '=', 'categories.id'),
    )
    .innerJoin('branches', (join) =>
      join
        .onRef('waste_logs.tenant_id', '=', 'branches.tenant_id')
        .onRef('waste_logs.branch_id', '=', 'branches.id'),
    )
    .innerJoin('warehouses', (join) =>
      join
        .onRef('waste_logs.tenant_id', '=', 'warehouses.tenant_id')
        .onRef('waste_logs.warehouse_id', '=', 'warehouses.id'),
    )
    .leftJoin('users', 'waste_logs.created_by_user_id', 'users.id')
    .select([
      'waste_logs.id as waste_log_id',
      'waste_logs.waste_number',
      'waste_logs.branch_id',
      'branches.name as branch_name',
      'waste_logs.warehouse_id',
      'warehouses.name as warehouse_name',
      'waste_logs.source_type',
      'waste_logs.source_reference_id',
      'waste_logs.reason_code',
      'waste_logs.reason_name',
      'waste_logs.confirmed_at',
      'waste_logs.created_at',
      'waste_logs.created_by_user_id',
      'users.full_name as employee_name',
      'waste_log_lines.product_id',
      'products.sku as product_sku',
      'products.name as product_name',
      'products.base_uom',
      'products.category_id',
      'categories.name as category_name',
      'waste_log_lines.normalized_base_qty',
      'waste_log_lines.total_cost_snapshot',
    ])
    .where('waste_logs.tenant_id', '=', trx.tenantId)
    .where('waste_logs.status', '=', 'CONFIRMED');

  if (!authCtx.allLocationsAccess) {
    if (authCtx.allowedBranchIds.size === 0 && authCtx.allowedWarehouseIds.size === 0) {
      return {
        currencyCode: baseCurrency,
        kpis: {
          totalWasteCost: '0.0000',
          totalWasteRecords: 0,
          totalWasteQuantity: '0.000000',
          topWasteReason: null as { code: string; name: string; cost: string } | null,
          customerReturnWasteCost: '0.0000',
          customerReturnWasteCount: 0,
        },
        trends: [] as Array<{ bucket: string; totalCost: string; totalQty: string; recordCount: number }>,
        byReason: [] as Array<{ reasonCode: string; reasonName: string; totalCost: string; totalQty: string; recordCount: number }>,
        byProduct: [] as Array<{ productId: string; sku: string; name: string; baseUom: string; totalCost: string; totalQty: string; recordCount: number }>,
        byCategory: [] as Array<{ categoryId: string | null; categoryName: string; totalCost: string; totalQty: string; recordCount: number }>,
        byBranch: [] as Array<{ branchId: string; branchName: string; totalCost: string; totalQty: string; recordCount: number }>,
        byWarehouse: [] as Array<{ warehouseId: string; warehouseName: string; branchName: string; totalCost: string; totalQty: string; recordCount: number }>,
        byEmployee: [] as Array<{ userId: string; employeeName: string; totalCost: string; totalQty: string; recordCount: number }>,
        customerReturnWaste: [] as Array<{ wasteLogId: string; wasteNumber: string; sourceReferenceId: string | null; productName: string; productSku: string; reasonName: string; totalQty: string; totalCost: string; confirmedAt: string }>,
        recentRecords: [] as WasteLogResponse[],
      };
    }
    if (authCtx.allowedBranchIds.size > 0) {
      confirmedQ = confirmedQ.where('waste_logs.branch_id', 'in', [...authCtx.allowedBranchIds]);
    }
    if (authCtx.allowedWarehouseIds.size > 0) {
      confirmedQ = confirmedQ.where('waste_logs.warehouse_id', 'in', [...authCtx.allowedWarehouseIds]);
    }
  }

  if (query.branchId) confirmedQ = confirmedQ.where('waste_logs.branch_id', '=', query.branchId);
  if (query.warehouseId) confirmedQ = confirmedQ.where('waste_logs.warehouse_id', '=', query.warehouseId);
  if (query.reasonCode) confirmedQ = confirmedQ.where('waste_logs.reason_code', '=', query.reasonCode.trim().toUpperCase());
  if (query.sourceType) confirmedQ = confirmedQ.where('waste_logs.source_type', '=', query.sourceType);
  if (query.startDate) {
    confirmedQ = confirmedQ.where(
      sql`COALESCE(waste_logs.confirmed_at, waste_logs.created_at)`,
      '>=',
      new Date(`${query.startDate}T00:00:00.000Z`),
    );
  }
  if (query.endDate) {
    confirmedQ = confirmedQ.where(
      sql`COALESCE(waste_logs.confirmed_at, waste_logs.created_at)`,
      '<=',
      new Date(`${query.endDate}T23:59:59.999Z`),
    );
  }

  const rows = await confirmedQ.execute();

  let totalCost = Money.zero(baseCurrency);
  let totalQty = Quantity.zero();
  const recordSet = new Set<string>();
  let returnWasteCost = Money.zero(baseCurrency);
  const returnRecordSet = new Set<string>();

  const formatBucket = (dt: Date): string => {
    const iso = dt.toISOString();
    if (granularity === 'YEARLY') return iso.slice(0, 4);
    if (granularity === 'MONTHLY') return iso.slice(0, 7);
    if (granularity === 'WEEKLY') {
      const d = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate()));
      const dow = d.getUTCDay();
      const diff = dow === 0 ? -6 : 1 - dow;
      d.setUTCDate(d.getUTCDate() + diff);
      return `Wk ${d.toISOString().slice(0, 10)}`;
    }
    return iso.slice(0, 10);
  };

  type AggBucket<T> = T & { cost: Money; qty: Quantity; records: Set<string> };
  const trendMap = new Map<string, AggBucket<{ bucket: string }>>();
  const reasonMap = new Map<string, AggBucket<{ reasonCode: string; reasonName: string }>>();
  const productMap = new Map<string, AggBucket<{ productId: string; sku: string; name: string; baseUom: string }>>();
  const categoryMap = new Map<string, AggBucket<{ categoryId: string | null; categoryName: string }>>();
  const branchMap = new Map<string, AggBucket<{ branchId: string; branchName: string }>>();
  const warehouseMap = new Map<string, AggBucket<{ warehouseId: string; warehouseName: string; branchName: string }>>();
  const employeeMap = new Map<string, AggBucket<{ userId: string; employeeName: string }>>();
  const customerReturnRows: Array<{
    wasteLogId: string;
    wasteNumber: string;
    sourceReferenceId: string | null;
    productName: string;
    productSku: string;
    reasonName: string;
    totalQty: string;
    totalCost: string;
    confirmedAt: string;
  }> = [];

  for (const r of rows) {
    const c = Money.fromDecimalString(String(r.total_cost_snapshot), baseCurrency);
    const q = Quantity.fromDecimalString(String(r.normalized_base_qty));
    totalCost = totalCost.add(c);
    totalQty = totalQty.add(q);
    recordSet.add(r.waste_log_id);

    const effDate = new Date(r.confirmed_at ?? r.created_at);
    const bucket = formatBucket(effDate);
    const tEntry = trendMap.get(bucket) ?? { bucket, cost: Money.zero(baseCurrency), qty: Quantity.zero(), records: new Set() };
    tEntry.cost = tEntry.cost.add(c);
    tEntry.qty = tEntry.qty.add(q);
    tEntry.records.add(r.waste_log_id);
    trendMap.set(bucket, tEntry);

    const rEntry = reasonMap.get(r.reason_code) ?? { reasonCode: r.reason_code, reasonName: r.reason_name, cost: Money.zero(baseCurrency), qty: Quantity.zero(), records: new Set() };
    rEntry.cost = rEntry.cost.add(c);
    rEntry.qty = rEntry.qty.add(q);
    rEntry.records.add(r.waste_log_id);
    reasonMap.set(r.reason_code, rEntry);

    const pEntry = productMap.get(r.product_id) ?? { productId: r.product_id, sku: r.product_sku, name: r.product_name, baseUom: r.base_uom, cost: Money.zero(baseCurrency), qty: Quantity.zero(), records: new Set() };
    pEntry.cost = pEntry.cost.add(c);
    pEntry.qty = pEntry.qty.add(q);
    pEntry.records.add(r.waste_log_id);
    productMap.set(r.product_id, pEntry);

    const catKey = r.category_id ?? '__UNCATEGORIZED__';
    const cEntry = categoryMap.get(catKey) ?? { categoryId: r.category_id ?? null, categoryName: r.category_name ?? 'Uncategorized', cost: Money.zero(baseCurrency), qty: Quantity.zero(), records: new Set() };
    cEntry.cost = cEntry.cost.add(c);
    cEntry.qty = cEntry.qty.add(q);
    cEntry.records.add(r.waste_log_id);
    categoryMap.set(catKey, cEntry);

    const bEntry = branchMap.get(r.branch_id) ?? { branchId: r.branch_id, branchName: r.branch_name, cost: Money.zero(baseCurrency), qty: Quantity.zero(), records: new Set() };
    bEntry.cost = bEntry.cost.add(c);
    bEntry.qty = bEntry.qty.add(q);
    bEntry.records.add(r.waste_log_id);
    branchMap.set(r.branch_id, bEntry);

    const wEntry = warehouseMap.get(r.warehouse_id) ?? { warehouseId: r.warehouse_id, warehouseName: r.warehouse_name, branchName: r.branch_name, cost: Money.zero(baseCurrency), qty: Quantity.zero(), records: new Set() };
    wEntry.cost = wEntry.cost.add(c);
    wEntry.qty = wEntry.qty.add(q);
    wEntry.records.add(r.waste_log_id);
    warehouseMap.set(r.warehouse_id, wEntry);

    const eEntry = employeeMap.get(r.created_by_user_id) ?? { userId: r.created_by_user_id, employeeName: r.employee_name ?? 'Staff User', cost: Money.zero(baseCurrency), qty: Quantity.zero(), records: new Set() };
    eEntry.cost = eEntry.cost.add(c);
    eEntry.qty = eEntry.qty.add(q);
    eEntry.records.add(r.waste_log_id);
    employeeMap.set(r.created_by_user_id, eEntry);

    if (r.source_type === 'CUSTOMER_RETURN') {
      returnWasteCost = returnWasteCost.add(c);
      returnRecordSet.add(r.waste_log_id);
      customerReturnRows.push({
        wasteLogId: r.waste_log_id,
        wasteNumber: r.waste_number,
        sourceReferenceId: r.source_reference_id ?? null,
        productName: r.product_name,
        productSku: r.product_sku,
        reasonName: r.reason_name,
        totalQty: q.toDecimalString(),
        totalCost: c.toDecimalString(),
        confirmedAt: effDate.toISOString(),
      });
    }
  }

  const byReason = [...reasonMap.values()]
    .sort((a, b) => Number(b.cost.scaledUnits - a.cost.scaledUnits))
    .map((x) => ({
      reasonCode: x.reasonCode,
      reasonName: x.reasonName,
      totalCost: x.cost.toDecimalString(),
      totalQty: x.qty.toDecimalString(),
      recordCount: x.records.size,
    }));

  const recentResult = await listWasteLogs(trx, {
    ...(query.branchId !== undefined ? { branchId: query.branchId } : {}),
    ...(query.warehouseId !== undefined ? { warehouseId: query.warehouseId } : {}),
    status: 'CONFIRMED',
    ...(query.reasonCode !== undefined ? { reasonCode: query.reasonCode } : {}),
    ...(query.sourceType !== undefined ? { sourceType: query.sourceType } : {}),
    ...(query.startDate !== undefined ? { startDate: query.startDate } : {}),
    ...(query.endDate !== undefined ? { endDate: query.endDate } : {}),
    limit: 10,
    offset: 0,
  });

  const topReason = byReason.length > 0
    ? { code: byReason[0]!.reasonCode, name: byReason[0]!.reasonName, cost: byReason[0]!.totalCost }
    : null;

  return {
    currencyCode: baseCurrency,
    kpis: {
      totalWasteCost: totalCost.toDecimalString(),
      totalWasteRecords: recordSet.size,
      totalWasteQuantity: totalQty.toDecimalString(),
      topWasteReason: topReason,
      customerReturnWasteCost: returnWasteCost.toDecimalString(),
      customerReturnWasteCount: returnRecordSet.size,
    },
    trends: [...trendMap.values()]
      .sort((a, b) => a.bucket.localeCompare(b.bucket))
      .map((x) => ({
        bucket: x.bucket,
        totalCost: x.cost.toDecimalString(),
        totalQty: x.qty.toDecimalString(),
        recordCount: x.records.size,
      })),
    byReason,
    byProduct: [...productMap.values()]
      .sort((a, b) => Number(b.cost.scaledUnits - a.cost.scaledUnits))
      .map((x) => ({
        productId: x.productId,
        sku: x.sku,
        name: x.name,
        baseUom: x.baseUom,
        totalCost: x.cost.toDecimalString(),
        totalQty: x.qty.toDecimalString(),
        recordCount: x.records.size,
      })),
    byCategory: [...categoryMap.values()]
      .sort((a, b) => Number(b.cost.scaledUnits - a.cost.scaledUnits))
      .map((x) => ({
        categoryId: x.categoryId,
        categoryName: x.categoryName,
        totalCost: x.cost.toDecimalString(),
        totalQty: x.qty.toDecimalString(),
        recordCount: x.records.size,
      })),
    byBranch: [...branchMap.values()]
      .sort((a, b) => Number(b.cost.scaledUnits - a.cost.scaledUnits))
      .map((x) => ({
        branchId: x.branchId,
        branchName: x.branchName,
        totalCost: x.cost.toDecimalString(),
        totalQty: x.qty.toDecimalString(),
        recordCount: x.records.size,
      })),
    byWarehouse: [...warehouseMap.values()]
      .sort((a, b) => Number(b.cost.scaledUnits - a.cost.scaledUnits))
      .map((x) => ({
        warehouseId: x.warehouseId,
        warehouseName: x.warehouseName,
        branchName: x.branchName,
        totalCost: x.cost.toDecimalString(),
        totalQty: x.qty.toDecimalString(),
        recordCount: x.records.size,
      })),
    byEmployee: [...employeeMap.values()]
      .sort((a, b) => Number(b.cost.scaledUnits - a.cost.scaledUnits))
      .map((x) => ({
        userId: x.userId,
        employeeName: x.employeeName,
        totalCost: x.cost.toDecimalString(),
        totalQty: x.qty.toDecimalString(),
        recordCount: x.records.size,
      })),
    customerReturnWaste: customerReturnRows,
    recentRecords: recentResult.items,
  };
}

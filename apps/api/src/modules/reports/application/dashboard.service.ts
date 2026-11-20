import type {
  DashboardActivityItem,
  DashboardBranchMetric,
  DashboardDatePreset,
  DashboardLowStockItem,
  DashboardSummaryQuery,
  DashboardSummaryResponse,
  DashboardTrendPoint,
  StockAlertState,
} from '@nexstock/contracts';
import { AppError, type TenantTransactionContext } from '../../shared/index.js';
import { assertAuthorized } from '../../iam/index.js';
import { assertSubscriptionEntitlement } from '../../sub/index.js';

function roundMoney(val: number): string {
  if (!Number.isFinite(val)) return '0.0000';
  return val.toFixed(4);
}

function roundQty(val: number): string {
  if (!Number.isFinite(val)) return '0.0000';
  return val.toFixed(4);
}

function roundPct(val: number): number {
  if (!Number.isFinite(val)) return 0;
  return Math.round(val * 100) / 100;
}

function formatIsoDayUtc(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addUtcDays(d: Date, days: number): Date {
  const next = new Date(d.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function resolveDashboardWindow(query: DashboardSummaryQuery): {
  datePreset: DashboardDatePreset;
  startDate: string;
  endDate: string;
  startTs: Date;
  endTs: Date;
} {
  const now = new Date();
  const todayUtc = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const datePreset: DashboardDatePreset = query.datePreset ?? 'TODAY';

  let startDay: Date;
  let endDay: Date;

  if (datePreset === 'YESTERDAY') {
    startDay = addUtcDays(todayUtc, -1);
    endDay = addUtcDays(todayUtc, -1);
  } else if (datePreset === 'THIS_WEEK') {
    const dow = todayUtc.getUTCDay(); // 0=Sun..6=Sat
    const diffToMon = dow === 0 ? -6 : 1 - dow;
    startDay = addUtcDays(todayUtc, diffToMon);
    endDay = todayUtc;
  } else if (datePreset === 'THIS_MONTH') {
    startDay = new Date(Date.UTC(todayUtc.getUTCFullYear(), todayUtc.getUTCMonth(), 1));
    endDay = todayUtc;
  } else if (datePreset === 'CUSTOM' && (query.startDate || query.endDate)) {
    const sStr = query.startDate ?? query.endDate ?? formatIsoDayUtc(todayUtc);
    const eStr = query.endDate ?? query.startDate ?? sStr;
    const [sY, sM, sD] = sStr.split('-').map(Number);
    const [eY, eM, eD] = eStr.split('-').map(Number);
    startDay = new Date(Date.UTC(sY!, sM! - 1, sD!));
    endDay = new Date(Date.UTC(eY!, eM! - 1, eD!));
    if (startDay.getTime() > endDay.getTime()) {
      const tmp = startDay;
      startDay = endDay;
      endDay = tmp;
    }
  } else {
    startDay = todayUtc;
    endDay = todayUtc;
  }

  const startDate = formatIsoDayUtc(startDay);
  const endDate = formatIsoDayUtc(endDay);
  const startTs = new Date(`${startDate}T00:00:00.000Z`);
  const endTs = new Date(`${endDate}T23:59:59.999Z`);

  return {
    datePreset,
    startDate,
    endDate,
    startTs,
    endTs,
  };
}

function classifyStockState(qtyOnHand: number, reorderPoint: number): StockAlertState {
  if (qtyOnHand < -0.00005) return 'NEGATIVE_STOCK';
  if (qtyOnHand <= 0.00005) return 'ZERO_STOCK';
  if (reorderPoint > 0 && qtyOnHand <= reorderPoint + 0.00005) return 'LOW_STOCK';
  return 'OK';
}

export async function getDashboardSummary(
  trx: TenantTransactionContext,
  query: DashboardSummaryQuery,
): Promise<DashboardSummaryResponse> {
  const authCtx = await assertAuthorized(trx, {
    permission: 'dash:view',
    ...(query.branchId ? { branchId: query.branchId } : {}),
  });

  await assertSubscriptionEntitlement(trx, { requireWriteAccess: false });

  const { datePreset, startDate, endDate, startTs, endTs } = resolveDashboardWindow(query);

  const [
    tenantRow,
    allBranchRows,
    branchMainLogs,
    allWarehouses,
    activeProducts,
    activeCustomersCountRow,
  ] = await Promise.all([
    trx.db
      .selectFrom('tenants')
      .select(['base_currency'])
      .where('id', '=', trx.tenantId)
      .executeTakeFirst(),
    trx.db
      .selectFrom('branches')
      .select(['id', 'tenant_id', 'code', 'name', 'is_active', 'default_warehouse_id', 'created_at'])
      .where('tenant_id', '=', trx.tenantId)
      .orderBy('created_at', 'asc')
      .orderBy('code', 'asc')
      .execute(),
    trx.db
      .selectFrom('audit_logs')
      .select(['resource_id', 'action', 'metadata_json', 'created_at'])
      .where('tenant_id', '=', trx.tenantId)
      .where('resource_type', '=', 'BRANCH')
      .orderBy('created_at', 'asc')
      .execute(),
    trx.db
      .selectFrom('warehouses')
      .select(['id', 'branch_id', 'name', 'is_active'])
      .where('tenant_id', '=', trx.tenantId)
      .execute(),
    trx.db
      .selectFrom('products')
      .select(['id', 'sku', 'name', 'base_uom', 'track_inventory', 'reorder_point', 'product_type'])
      .where('tenant_id', '=', trx.tenantId)
      .where('status', '=', 'ACTIVE')
      .execute(),
    trx.db
      .selectFrom('customers')
      .select((eb) => eb.fn.countAll<string>().as('cnt'))
      .where('tenant_id', '=', trx.tenantId)
      .where('status', '=', 'ACTIVE')
      .executeTakeFirst(),
  ]);

  let explicitMainBranchId: string | null = null;
  for (const log of branchMainLogs) {
    if (!log.resource_id) continue;
    const meta =
      log.metadata_json && typeof log.metadata_json === 'object'
        ? (log.metadata_json as Record<string, unknown>)
        : {};
    if (
      log.action === 'ORG_BRANCH_SET_MAIN' ||
      meta.isMainBranch === true ||
      meta.isHeadquarters === true
    ) {
      explicitMainBranchId = log.resource_id;
    }
  }
  const activeBranchRows = allBranchRows.filter((b) => b.is_active);
  const resolvedMainBranchId =
    explicitMainBranchId && activeBranchRows.some((b) => b.id === explicitMainBranchId)
      ? explicitMainBranchId
      : (activeBranchRows[0]?.id ?? allBranchRows[0]?.id ?? null);

  const allBranches = allBranchRows.map((b) => ({
    ...b,
    is_main_branch: b.id === resolvedMainBranchId,
  }));

  const branchById = new Map(allBranches.map((b) => [b.id, b]));
  const warehouseById = new Map(allWarehouses.map((w) => [w.id, w]));
  const productById = new Map(activeProducts.map((p) => [p.id, p]));

  if (query.branchId && !branchById.has(query.branchId)) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'ORG_BRANCH_NOT_FOUND',
      title: 'Branch Not Found',
      detail: `Branch "${query.branchId}" was not found in tenant "${trx.tenantId}".`,
    });
  }

  const accessibleActiveBranches = allBranches.filter(
    (b) => b.is_active && (authCtx.allLocationsAccess || authCtx.allowedBranchIds.has(b.id)),
  );
  const accessibleBranchIds = query.branchId
    ? [query.branchId]
    : authCtx.allLocationsAccess
      ? allBranches.map((b) => b.id)
      : Array.from(authCtx.allowedBranchIds);

  const selectedBranch = query.branchId ? branchById.get(query.branchId) ?? null : null;
  const scopeMode = selectedBranch ? 'SINGLE_BRANCH' : 'BUSINESS_WIDE';
  const selectedBranchName = selectedBranch
    ? selectedBranch.name
    : authCtx.allLocationsAccess
      ? 'All Branches'
      : 'Authorized Branches';

  if (accessibleBranchIds.length === 0) {
    return {
      scopeMode,
      selectedBranchId: selectedBranch ? selectedBranch.id : null,
      selectedBranchName,
      datePreset,
      startDate,
      endDate,
      currencyCode: tenantRow?.base_currency ?? 'LKR',
      allLocationsAccess: authCtx.allLocationsAccess,
      kpis: {
        totalSales: '0.0000',
        grossSales: '0.0000',
        refundTotal: '0.0000',
        totalOrders: 0,
        voidedOrders: 0,
        returnsCount: 0,
        averageOrderValue: '0.0000',
        totalInventoryValue: '0.0000',
        totalUnitsOnHand: '0.0000',
        totalProducts: activeProducts.length,
        totalCustomers: Number(activeCustomersCountRow?.cnt ?? 0),
        activeBranchesCount: 0,
        lowStockAlerts: 0,
        outOfStockAlerts: 0,
        confirmedCogs: '0.0000',
        grossProfit: '0.0000',
        grossMarginPct: 0,
        costCoveragePct: 100,
        hasIncompleteCostData: false,
        incompleteCostLinesCount: 0,
        totalSalesLinesCount: 0,
      },
      bestPerformingBranch: null,
      branchComparison: [],
      salesTrend: [],
      lowStockWatchlist: [],
      recentActivities: [],
    };
  }

  const [invoices, returnsRows, balancesRows, transfersRows, usersRows] = await Promise.all([
    trx.db
      .selectFrom('sales_invoices')
      .select([
        'id',
        'branch_id',
        'cashier_user_id',
        'invoice_number',
        'status',
        'grand_total',
        'customer_name',
        'created_at',
        'voided_at',
        'voided_by_user_id',
      ])
      .where('tenant_id', '=', trx.tenantId)
      .where('branch_id', 'in', accessibleBranchIds)
      .where('created_at', '>=', startTs)
      .where('created_at', '<=', endTs)
      .orderBy('created_at', 'desc')
      .execute(),
    trx.db
      .selectFrom('pos_returns')
      .select([
        'id',
        'invoice_id',
        'branch_id',
        'return_number',
        'total_refund_amount',
        'created_by_user_id',
        'created_at',
      ])
      .where('tenant_id', '=', trx.tenantId)
      .where('branch_id', 'in', accessibleBranchIds)
      .where('created_at', '>=', startTs)
      .where('created_at', '<=', endTs)
      .orderBy('created_at', 'desc')
      .execute(),
    trx.db
      .selectFrom('inventory_balances')
      .select([
        'branch_id',
        'warehouse_id',
        'product_id',
        'qty_on_hand',
        'qty_reserved',
        'moving_avg_cost',
        'total_inventory_value',
      ])
      .where('tenant_id', '=', trx.tenantId)
      .where('branch_id', 'in', accessibleBranchIds)
      .execute(),
    trx.db
      .selectFrom('stock_transfers')
      .select([
        'id',
        'transfer_number',
        'source_branch_id',
        'destination_branch_id',
        'status',
        'created_by_user_id',
        'created_at',
        'received_at',
      ])
      .where('tenant_id', '=', trx.tenantId)
      .where((eb) =>
        eb.or([
          eb('source_branch_id', 'in', accessibleBranchIds),
          eb('destination_branch_id', 'in', accessibleBranchIds),
        ]),
      )
      .where('created_at', '>=', startTs)
      .where('created_at', '<=', endTs)
      .orderBy('created_at', 'desc')
      .limit(20)
      .execute(),
    trx.db.selectFrom('users').select(['id', 'full_name', 'email']).execute(),
  ]);

  const userNameById = new Map(
    usersRows.map((u) => [u.id, u.full_name || u.email || 'Team Member']),
  );

  const completedInvoiceIds = invoices
    .filter((i) => i.status === 'COMPLETED')
    .map((i) => i.id);
  const returnIds = returnsRows.map((r) => r.id);

  const [invoiceLines, returnLines] = await Promise.all([
    completedInvoiceIds.length > 0
      ? trx.db
          .selectFrom('sales_invoice_lines')
          .select([
            'id',
            'invoice_id',
            'product_id',
            'quantity',
            'normalized_base_qty',
            'unit_cost_snapshot',
          ])
          .where('tenant_id', '=', trx.tenantId)
          .where('invoice_id', 'in', completedInvoiceIds)
          .execute()
      : Promise.resolve([]),
    returnIds.length > 0
      ? trx.db
          .selectFrom('pos_return_lines')
          .select([
            'pos_return_id',
            'invoice_line_id',
            'return_qty',
            'normalized_base_qty',
            'restock_condition',
          ])
          .where('tenant_id', '=', trx.tenantId)
          .where('pos_return_id', 'in', returnIds)
          .execute()
      : Promise.resolve([]),
  ]);

  const invoiceById = new Map(invoices.map((i) => [i.id, i]));
  const invoiceLineById = new Map(invoiceLines.map((l) => [l.id, l]));

  interface BranchAcc {
    branchId: string;
    branchCode: string;
    branchName: string;
    isMainBranch: boolean;
    grossSales: number;
    refundTotal: number;
    ordersCount: number;
    voidedCount: number;
    returnsCount: number;
    inventoryValue: number;
    unitsOnHand: number;
    lowStockCount: number;
    outOfStockCount: number;
    confirmedCogs: number;
    confirmedLines: number;
    totalLines: number;
  }

  const branchAccMap = new Map<string, BranchAcc>();
  const ensureBranchAcc = (bId: string): BranchAcc | null => {
    const existing = branchAccMap.get(bId);
    if (existing) return existing;
    const b = branchById.get(bId);
    if (!b) return null;
    const acc: BranchAcc = {
      branchId: b.id,
      branchCode: b.code,
      branchName: b.name,
      isMainBranch: b.is_main_branch,
      grossSales: 0,
      refundTotal: 0,
      ordersCount: 0,
      voidedCount: 0,
      returnsCount: 0,
      inventoryValue: 0,
      unitsOnHand: 0,
      lowStockCount: 0,
      outOfStockCount: 0,
      confirmedCogs: 0,
      confirmedLines: 0,
      totalLines: 0,
    };
    branchAccMap.set(b.id, acc);
    return acc;
  };

  if (selectedBranch) {
    ensureBranchAcc(selectedBranch.id);
  } else {
    for (const b of accessibleActiveBranches) {
      ensureBranchAcc(b.id);
    }
  }

  // Initialize daily trend buckets
  const trendMap = new Map<string, { netSales: number; ordersCount: number }>();
  const dayCursor = new Date(`${startDate}T00:00:00.000Z`);
  const endCursor = new Date(`${endDate}T00:00:00.000Z`);
  let safetyCounter = 0;
  while (dayCursor.getTime() <= endCursor.getTime() && safetyCounter < 120) {
    trendMap.set(formatIsoDayUtc(dayCursor), { netSales: 0, ordersCount: 0 });
    dayCursor.setUTCDate(dayCursor.getUTCDate() + 1);
    safetyCounter += 1;
  }

  let totalGrossSales = 0;
  let totalOrders = 0;
  let totalVoidedOrders = 0;

  for (const inv of invoices) {
    const acc = ensureBranchAcc(inv.branch_id);
    if (inv.status === 'VOIDED') {
      totalVoidedOrders += 1;
      if (acc) acc.voidedCount += 1;
      continue;
    }

    const amt = Number(inv.grand_total || 0);
    totalGrossSales += amt;
    totalOrders += 1;
    if (acc) {
      acc.grossSales += amt;
      acc.ordersCount += 1;
    }

    const dayKey = formatIsoDayUtc(new Date(inv.created_at));
    const tEntry = trendMap.get(dayKey);
    if (tEntry) {
      tEntry.netSales += amt;
      tEntry.ordersCount += 1;
    }
  }

  let totalRefunds = 0;
  const returnBranchById = new Map<string, string>();
  for (const ret of returnsRows) {
    returnBranchById.set(ret.id, ret.branch_id);
    const refAmt = Number(ret.total_refund_amount || 0);
    totalRefunds += refAmt;
    const acc = ensureBranchAcc(ret.branch_id);
    if (acc) {
      acc.refundTotal += refAmt;
      acc.returnsCount += 1;
    }
    const dayKey = formatIsoDayUtc(new Date(ret.created_at));
    const tEntry = trendMap.get(dayKey);
    if (tEntry) {
      tEntry.netSales -= refAmt;
    }
  }

  let totalConfirmedCogs = 0;
  let totalSalesLinesCount = 0;
  let incompleteCostLinesCount = 0;

  for (const line of invoiceLines) {
    const inv = invoiceById.get(line.invoice_id);
    if (!inv) continue;
    const prod = productById.get(line.product_id);
    if (prod && prod.product_type === 'SERVICE') {
      continue;
    }

    const baseQty = Number(line.normalized_base_qty ?? line.quantity ?? 0);
    const unitCost = Number(line.unit_cost_snapshot ?? 0);
    const hasConfirmedCost =
      line.unit_cost_snapshot !== null &&
      line.unit_cost_snapshot !== undefined &&
      unitCost > 0;

    totalSalesLinesCount += 1;
    const acc = ensureBranchAcc(inv.branch_id);
    if (acc) acc.totalLines += 1;

    if (hasConfirmedCost) {
      const cogs = baseQty * unitCost;
      totalConfirmedCogs += cogs;
      if (acc) {
        acc.confirmedCogs += cogs;
        acc.confirmedLines += 1;
      }
    } else if (baseQty > 0) {
      incompleteCostLinesCount += 1;
    }
  }

  for (const rl of returnLines) {
    if (rl.restock_condition !== 'RESELLABLE') continue;
    const branchId = returnBranchById.get(rl.pos_return_id);
    const origLine = invoiceLineById.get(rl.invoice_line_id);
    const unitCost = Number(origLine?.unit_cost_snapshot ?? 0);
    if (unitCost <= 0) continue;
    const restockQty = Number(rl.normalized_base_qty ?? rl.return_qty ?? 0);
    const restockCogs = restockQty * unitCost;
    totalConfirmedCogs -= restockCogs;
    if (branchId) {
      const acc = ensureBranchAcc(branchId);
      if (acc) acc.confirmedCogs -= restockCogs;
    }
  }

  totalConfirmedCogs = Math.max(0, totalConfirmedCogs);

  // Inventory Valuation & Low Stock Watchlist across scoped warehouses/balances
  let totalInventoryValue = 0;
  let totalUnitsOnHand = 0;
  let lowStockAlerts = 0;
  let outOfStockAlerts = 0;

  const balanceByBranchProduct = new Map<
    string,
    {
      branchId: string;
      warehouseId: string;
      productId: string;
      qtyOnHand: number;
      qtyReserved: number;
      value: number;
    }
  >();

  for (const bal of balancesRows) {
    const qty = Number(bal.qty_on_hand || 0);
    const reserved = Number(bal.qty_reserved || 0);
    const explicitVal = Number(bal.total_inventory_value || 0);
    const avgCost = Number(bal.moving_avg_cost || 0);
    const val =
      Math.abs(explicitVal) > 0.00001
        ? explicitVal
        : qty > 0 && avgCost > 0
          ? qty * avgCost
          : 0;

    totalInventoryValue += val;
    totalUnitsOnHand += qty;

    const acc = ensureBranchAcc(bal.branch_id);
    if (acc) {
      acc.inventoryValue += val;
      acc.unitsOnHand += qty;
    }

    const key = `${bal.branch_id}::${bal.product_id}`;
    const existing = balanceByBranchProduct.get(key);
    if (existing) {
      existing.qtyOnHand += qty;
      existing.qtyReserved += reserved;
      existing.value += val;
    } else {
      balanceByBranchProduct.set(key, {
        branchId: bal.branch_id,
        warehouseId: bal.warehouse_id,
        productId: bal.product_id,
        qtyOnHand: qty,
        qtyReserved: reserved,
        value: val,
      });
    }
  }

  const watchlistCandidates: Array<DashboardLowStockItem & { sortScore: number }> = [];
  const checkBranchesForAlerts = selectedBranch
    ? [selectedBranch]
    : accessibleActiveBranches;

  for (const branch of checkBranchesForAlerts) {
    const acc = ensureBranchAcc(branch.id);
    for (const prod of activeProducts) {
      if (!prod.track_inventory) continue;
      const reorderPoint = Number(prod.reorder_point || 0);
      const bal = balanceByBranchProduct.get(`${branch.id}::${prod.id}`);
      const qtyOnHand = bal?.qtyOnHand ?? 0;
      const availableQty = qtyOnHand - (bal?.qtyReserved ?? 0);
      const stockState = classifyStockState(qtyOnHand, reorderPoint);

      if (stockState === 'ZERO_STOCK' || stockState === 'NEGATIVE_STOCK') {
        if (bal || reorderPoint > 0) {
          outOfStockAlerts += 1;
          if (acc) acc.outOfStockCount += 1;
          const whId = bal?.warehouseId ?? branch.default_warehouse_id ?? '';
          if (whId) {
            const wh = warehouseById.get(whId);
            watchlistCandidates.push({
              branchId: branch.id,
              branchName: branch.name,
              warehouseId: whId,
              warehouseName: wh?.name ?? 'Default Warehouse',
              productId: prod.id,
              sku: prod.sku,
              productName: prod.name,
              baseUom: prod.base_uom,
              qtyOnHand: roundQty(qtyOnHand),
              availableQty: roundQty(availableQty),
              reorderPoint: roundQty(reorderPoint),
              stockState,
              sortScore: stockState === 'NEGATIVE_STOCK' ? -2 : -1,
            });
          }
        }
      } else if (stockState === 'LOW_STOCK') {
        lowStockAlerts += 1;
        if (acc) acc.lowStockCount += 1;
        const whId = bal?.warehouseId ?? branch.default_warehouse_id ?? '';
        if (whId) {
          const wh = warehouseById.get(whId);
          watchlistCandidates.push({
            branchId: branch.id,
            branchName: branch.name,
            warehouseId: whId,
            warehouseName: wh?.name ?? 'Default Warehouse',
            productId: prod.id,
            sku: prod.sku,
            productName: prod.name,
            baseUom: prod.base_uom,
            qtyOnHand: roundQty(qtyOnHand),
            availableQty: roundQty(availableQty),
            reorderPoint: roundQty(reorderPoint),
            stockState,
            sortScore: reorderPoint > 0 ? qtyOnHand / reorderPoint : 1,
          });
        }
      }
    }
  }

  watchlistCandidates.sort((a, b) => a.sortScore - b.sortScore);
  const lowStockWatchlist: DashboardLowStockItem[] = watchlistCandidates
    .slice(0, 12)
    .map(({ sortScore: _s, ...item }) => item);

  const totalSales = totalGrossSales - totalRefunds;
  const averageOrderValue = totalOrders > 0 ? totalSales / totalOrders : 0;
  const grossProfit = totalSales - totalConfirmedCogs;
  const grossMarginPct = totalSales > 0 ? roundPct((grossProfit / totalSales) * 100) : 0;
  const confirmedLinesTotal = totalSalesLinesCount - incompleteCostLinesCount;
  const costCoveragePct =
    totalSalesLinesCount > 0
      ? roundPct((confirmedLinesTotal / totalSalesLinesCount) * 100)
      : 100;

  const branchComparison: DashboardBranchMetric[] = Array.from(branchAccMap.values())
    .map((b) => {
      const net = b.grossSales - b.refundTotal;
      const aov = b.ordersCount > 0 ? net / b.ordersCount : 0;
      const cogs = Math.max(0, b.confirmedCogs);
      const gp = net - cogs;
      const cov =
        b.totalLines > 0 ? roundPct((b.confirmedLines / b.totalLines) * 100) : 100;
      return {
        branchId: b.branchId,
        branchCode: b.branchCode,
        branchName: b.branchName,
        isMainBranch: b.isMainBranch,
        netSales: roundMoney(net),
        grossSales: roundMoney(b.grossSales),
        refundTotal: roundMoney(b.refundTotal),
        ordersCount: b.ordersCount,
        voidedCount: b.voidedCount,
        returnsCount: b.returnsCount,
        averageOrderValue: roundMoney(aov),
        inventoryValue: roundMoney(b.inventoryValue),
        unitsOnHand: roundQty(b.unitsOnHand),
        lowStockCount: b.lowStockCount,
        outOfStockCount: b.outOfStockCount,
        confirmedCogs: roundMoney(cogs),
        grossProfit: roundMoney(gp),
        costCoveragePct: cov,
        hasIncompleteCostData: b.confirmedLines < b.totalLines,
      };
    })
    .sort((a, b) => {
      const diff = Number(b.netSales) - Number(a.netSales);
      if (Math.abs(diff) > 0.001) return diff;
      if (b.ordersCount !== a.ordersCount) return b.ordersCount - a.ordersCount;
      if (a.isMainBranch !== b.isMainBranch) return a.isMainBranch ? -1 : 1;
      return a.branchName.localeCompare(b.branchName);
    });

  const topBranch = branchComparison[0];
  const bestPerformingBranch =
    topBranch && (Number(topBranch.netSales) > 0 || topBranch.ordersCount > 0)
      ? {
          branchId: topBranch.branchId,
          branchCode: topBranch.branchCode,
          branchName: topBranch.branchName,
          netSales: topBranch.netSales,
          ordersCount: topBranch.ordersCount,
          sharePct:
            totalSales > 0
              ? roundPct((Number(topBranch.netSales) / totalSales) * 100)
              : 0,
        }
      : null;

  const salesTrend: DashboardTrendPoint[] = Array.from(trendMap.entries()).map(
    ([date, val]) => ({
      date,
      netSales: roundMoney(val.netSales),
      ordersCount: val.ordersCount,
    }),
  );

  // Recent business activities feed (Sales, Voids, Returns, Stock Transfers — transfers have amount: null)
  const activityItems: Array<DashboardActivityItem & { ts: number }> = [];

  for (const inv of invoices.slice(0, 20)) {
    const bName = branchById.get(inv.branch_id)?.name ?? 'Branch';
    if (inv.status === 'VOIDED') {
      const occurredAt = new Date(inv.voided_at ?? inv.created_at);
      const actor =
        userNameById.get(inv.voided_by_user_id ?? inv.cashier_user_id) ?? 'Cashier';
      activityItems.push({
        id: `void-${inv.id}`,
        activityType: 'POS_VOID',
        referenceNumber: inv.invoice_number,
        branchId: inv.branch_id,
        branchName: bName,
        description: `Voided POS Sale ${inv.invoice_number}`,
        amount: roundMoney(Number(inv.grand_total || 0)),
        actorName: actor,
        occurredAt: occurredAt.toISOString(),
        ts: occurredAt.getTime(),
      });
    } else {
      const occurredAt = new Date(inv.created_at);
      const actor = userNameById.get(inv.cashier_user_id) ?? 'Cashier';
      activityItems.push({
        id: `sale-${inv.id}`,
        activityType: 'POS_SALE',
        referenceNumber: inv.invoice_number,
        branchId: inv.branch_id,
        branchName: bName,
        description: inv.customer_name
          ? `POS Sale ${inv.invoice_number} • ${inv.customer_name}`
          : `POS Sale ${inv.invoice_number}`,
        amount: roundMoney(Number(inv.grand_total || 0)),
        actorName: actor,
        occurredAt: occurredAt.toISOString(),
        ts: occurredAt.getTime(),
      });
    }
  }

  for (const ret of returnsRows.slice(0, 15)) {
    const bName = branchById.get(ret.branch_id)?.name ?? 'Branch';
    const occurredAt = new Date(ret.created_at);
    activityItems.push({
      id: `ret-${ret.id}`,
      activityType: 'POS_RETURN',
      referenceNumber: ret.return_number,
      branchId: ret.branch_id,
      branchName: bName,
      description: `Customer Return ${ret.return_number}`,
      amount: roundMoney(Number(ret.total_refund_amount || 0)),
      actorName: userNameById.get(ret.created_by_user_id) ?? 'Cashier',
      occurredAt: occurredAt.toISOString(),
      ts: occurredAt.getTime(),
    });
  }

  for (const tr of transfersRows.slice(0, 15)) {
    const srcName = branchById.get(tr.source_branch_id)?.name ?? 'Source';
    const dstName = branchById.get(tr.destination_branch_id)?.name ?? 'Destination';
    const occurredAt = new Date(tr.received_at ?? tr.created_at);
    activityItems.push({
      id: `trf-${tr.id}`,
      activityType: 'STOCK_TRANSFER',
      referenceNumber: tr.transfer_number,
      branchId: selectedBranch ? selectedBranch.id : tr.source_branch_id,
      branchName: `${srcName} -> ${dstName}`,
      description: `Stock Transfer ${tr.transfer_number} (${tr.status})`,
      amount: null,
      actorName: userNameById.get(tr.created_by_user_id) ?? 'Inventory Team',
      occurredAt: occurredAt.toISOString(),
      ts: occurredAt.getTime(),
    });
  }

  activityItems.sort((a, b) => b.ts - a.ts);
  const recentActivities: DashboardActivityItem[] = activityItems
    .slice(0, 15)
    .map(({ ts: _t, ...item }) => item);

  return {
    scopeMode,
    selectedBranchId: selectedBranch ? selectedBranch.id : null,
    selectedBranchName,
    datePreset,
    startDate,
    endDate,
    currencyCode: tenantRow?.base_currency ?? 'LKR',
    allLocationsAccess: authCtx.allLocationsAccess,
    kpis: {
      totalSales: roundMoney(totalSales),
      grossSales: roundMoney(totalGrossSales),
      refundTotal: roundMoney(totalRefunds),
      totalOrders,
      voidedOrders: totalVoidedOrders,
      returnsCount: returnsRows.length,
      averageOrderValue: roundMoney(averageOrderValue),
      totalInventoryValue: roundMoney(totalInventoryValue),
      totalUnitsOnHand: roundQty(totalUnitsOnHand),
      totalProducts: activeProducts.length,
      totalCustomers: Number(activeCustomersCountRow?.cnt ?? 0),
      activeBranchesCount: selectedBranch
        ? 1
        : accessibleActiveBranches.length,
      lowStockAlerts,
      outOfStockAlerts,
      confirmedCogs: roundMoney(totalConfirmedCogs),
      grossProfit: roundMoney(grossProfit),
      grossMarginPct,
      costCoveragePct,
      hasIncompleteCostData: incompleteCostLinesCount > 0,
      incompleteCostLinesCount,
      totalSalesLinesCount,
    },
    bestPerformingBranch,
    branchComparison,
    salesTrend,
    lowStockWatchlist,
    recentActivities,
  };
}

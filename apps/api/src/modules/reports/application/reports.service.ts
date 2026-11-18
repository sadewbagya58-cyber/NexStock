import {
  AppError,
  type TenantTransactionContext,
} from '../../shared/index.js';
import {
  type AuthorizedMemberContext,
  resolveMemberAuthorizationContext,
} from '../../iam/index.js';
import { assertSubscriptionEntitlement } from '../../sub/index.js';

export type BusinessReportCategory =
  | 'SALES'
  | 'INVENTORY'
  | 'PROFITABILITY'
  | 'PURCHASING'
  | 'CUSTOMER_CREDIT'
  | 'EMPLOYEE_HR'
  | 'FINANCIAL_EXPENSE'
  | 'AUDIT_OPERATIONAL';

export type ReportGranularity = 'DAILY' | 'WEEKLY' | 'MONTHLY';

export interface BusinessReportQuery {
  readonly category?: BusinessReportCategory | undefined;
  readonly granularity?: ReportGranularity | undefined;
  readonly startDate?: string | undefined;
  readonly endDate?: string | undefined;
  readonly branchId?: string | undefined;
  readonly warehouseId?: string | undefined;
  readonly employeeId?: string | undefined;
  readonly productId?: string | undefined;
  readonly categoryId?: string | undefined;
  readonly supplierId?: string | undefined;
}

export interface BusinessReportDrilldownQuery {
  readonly drilldownType:
    | 'PRODUCT'
    | 'PRODUCT_SALES'
    | 'CATEGORY'
    | 'CATEGORY_SALES'
    | 'BRANCH'
    | 'BRANCH_SALES'
    | 'EMPLOYEE'
    | 'EMPLOYEE_SALES'
    | 'STOCK_MOVEMENTS'
    | 'SUPPLIER'
    | 'SUPPLIER_PURCHASES'
    | 'CUSTOMER'
    | 'CUSTOMER_HISTORY'
    | 'EXPENSE_CATEGORY'
    | 'VOIDED_INVOICE';
  readonly targetId?: string | undefined;
  readonly startDate?: string | undefined;
  readonly endDate?: string | undefined;
  readonly branchId?: string | undefined;
  readonly warehouseId?: string | undefined;
}

function roundMoney(val: number): string {
  if (!Number.isFinite(val)) return '0.0000';
  return val.toFixed(4);
}

function roundPct(val: number): number {
  if (!Number.isFinite(val)) return 0;
  return Math.round(val * 100) / 100;
}

function computeDeltaPct(current: number, previous: number): number {
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return 0;
  if (Math.abs(previous) < 0.0001) {
    if (current > 0.0001) return 100;
    if (current < -0.0001) return -100;
    return 0;
  }
  return roundPct(((current - previous) / Math.abs(previous)) * 100);
}

function resolveDateRange(startDate?: string, endDate?: string): {
  startDateStr: string;
  endDateStr: string;
  startTs: Date;
  endTs: Date;
  prevStartDateStr: string;
  prevEndDateStr: string;
  prevStartTs: Date;
  prevEndTs: Date;
  daysInPeriod: number;
} {
  const now = new Date();
  const defaultEnd = now.toISOString().slice(0, 10);
  const defaultStart = new Date(now.getTime() - 29 * 86400000)
    .toISOString()
    .slice(0, 10);

  const startDateStr =
    startDate && /^\d{4}-\d{2}-\d{2}$/.test(startDate)
      ? startDate
      : defaultStart;
  const endDateStr =
    endDate && /^\d{4}-\d{2}-\d{2}$/.test(endDate) ? endDate : defaultEnd;

  const rawStart = new Date(`${startDateStr}T00:00:00.000Z`);
  const rawEnd = new Date(`${endDateStr}T23:59:59.999Z`);
  const startTs = rawStart <= rawEnd ? rawStart : rawEnd;
  const endTs =
    rawStart <= rawEnd
      ? rawEnd
      : new Date(`${startDateStr}T23:59:59.999Z`);

  const durationMs = Math.max(86400000, endTs.getTime() - startTs.getTime() + 1);
  const daysInPeriod = Math.max(1, Math.round(durationMs / 86400000));
  const prevEndTs = new Date(startTs.getTime() - 1);
  const prevStartTs = new Date(prevEndTs.getTime() - durationMs + 1);

  return {
    startDateStr: startTs.toISOString().slice(0, 10),
    endDateStr: endTs.toISOString().slice(0, 10),
    startTs,
    endTs,
    prevStartDateStr: prevStartTs.toISOString().slice(0, 10),
    prevEndDateStr: prevEndTs.toISOString().slice(0, 10),
    prevStartTs,
    prevEndTs,
    daysInPeriod,
  };
}

function formatBucketKey(dateInput: Date | string, granularity: ReportGranularity): string {
  const d = new Date(dateInput);
  if (Number.isNaN(d.getTime())) return 'Unknown';
  const iso = d.toISOString().slice(0, 10);
  if (granularity === 'MONTHLY') {
    return iso.slice(0, 7);
  }
  if (granularity === 'WEEKLY') {
    const copy = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const day = copy.getUTCDay();
    const diff = copy.getUTCDate() - day + (day === 0 ? -6 : 1);
    copy.setUTCDate(diff);
    return `Wk ${copy.toISOString().slice(0, 10)}`;
  }
  return iso;
}

function assertCategoryPermission(
  authCtx: AuthorizedMemberContext,
  category: BusinessReportCategory,
): void {
  const isOwnerOrAdmin =
    authCtx.roleCodes.includes('TENANT_OWNER') ||
    authCtx.roleCodes.includes('ORG_ADMIN');
  if (isOwnerOrAdmin) return;

  const hasGeneralReport = authCtx.permissions.has('rep:report:view');

  const allowedByCategory: Record<BusinessReportCategory, boolean> = {
    SALES: hasGeneralReport,
    INVENTORY:
      hasGeneralReport ||
      authCtx.permissions.has('inv:costing:read') ||
      authCtx.permissions.has('inv:balance:read'),
    PROFITABILITY:
      hasGeneralReport || authCtx.permissions.has('inv:costing:read'),
    PURCHASING:
      hasGeneralReport || authCtx.permissions.has('pur:po:read'),
    CUSTOMER_CREDIT:
      hasGeneralReport || authCtx.permissions.has('crm:report:read'),
    EMPLOYEE_HR:
      hasGeneralReport ||
      authCtx.permissions.has('hrm:payroll:read') ||
      authCtx.permissions.has('hrm:employee:read') ||
      authCtx.permissions.has('hrm:attendance:read'),
    FINANCIAL_EXPENSE:
      hasGeneralReport || authCtx.permissions.has('exp:report:view'),
    AUDIT_OPERATIONAL: hasGeneralReport,
  };

  if (!allowedByCategory[category]) {
    throw new AppError({
      statusCode: 403,
      errorCode: 'IAM_PERMISSION_DENIED',
      title: 'Permission Denied',
      detail: `Member lacks required permission to access ${category} business reports.`,
    });
  }
}

function resolveScopedLocationFilters(
  authCtx: AuthorizedMemberContext,
  requestedBranchId?: string,
  requestedWarehouseId?: string,
): {
  allowedBranchIds: string[] | null;
  allowedWarehouseIds: string[] | null;
} {
  if (requestedBranchId && !authCtx.allLocationsAccess) {
    if (!authCtx.allowedBranchIds.has(requestedBranchId)) {
      throw new AppError({
        statusCode: 403,
        errorCode: 'IAM_LOCATION_SCOPE_DENIED',
        title: 'Branch Location Scope Denied',
        detail: `You do not have access to branch "${requestedBranchId}".`,
      });
    }
  }

  if (requestedWarehouseId && !authCtx.allLocationsAccess) {
    if (!authCtx.allowedWarehouseIds.has(requestedWarehouseId)) {
      throw new AppError({
        statusCode: 403,
        errorCode: 'IAM_LOCATION_SCOPE_DENIED',
        title: 'Warehouse Location Scope Denied',
        detail: `You do not have access to warehouse "${requestedWarehouseId}".`,
      });
    }
  }

  let allowedBranchIds: string[] | null = null;
  if (requestedBranchId) {
    allowedBranchIds = [requestedBranchId];
  } else if (!authCtx.allLocationsAccess) {
    allowedBranchIds = Array.from(authCtx.allowedBranchIds);
  }

  let allowedWarehouseIds: string[] | null = null;
  if (requestedWarehouseId) {
    allowedWarehouseIds = [requestedWarehouseId];
  } else if (!authCtx.allLocationsAccess) {
    allowedWarehouseIds = Array.from(authCtx.allowedWarehouseIds);
  }

  return { allowedBranchIds, allowedWarehouseIds };
}

export async function getBusinessReport(
  trx: TenantTransactionContext,
  query: BusinessReportQuery,
) {
  const authCtx = await resolveMemberAuthorizationContext(trx);
  await assertSubscriptionEntitlement(trx, { requireWriteAccess: false });

  const category: BusinessReportCategory = query.category ?? 'SALES';
  const granularity: ReportGranularity = query.granularity ?? 'DAILY';
  assertCategoryPermission(authCtx, category);

  const { allowedBranchIds, allowedWarehouseIds } = resolveScopedLocationFilters(
    authCtx,
    query.branchId,
    query.warehouseId,
  );

  const range = resolveDateRange(query.startDate, query.endDate);

  const [
    tenantRow,
    branches,
    warehouses,
    categories,
    products,
    users,
    employees,
    suppliers,
  ] = await Promise.all([
    trx.db
      .selectFrom('tenants')
      .select(['id', 'legal_name', 'base_currency'])
      .where('id', '=', trx.tenantId)
      .executeTakeFirst(),
    trx.db
      .selectFrom('branches')
      .select(['id', 'code', 'name'])
      .where('tenant_id', '=', trx.tenantId)
      .execute(),
    trx.db
      .selectFrom('warehouses')
      .select(['id', 'branch_id', 'code', 'name'])
      .where('tenant_id', '=', trx.tenantId)
      .execute(),
    trx.db
      .selectFrom('categories')
      .select(['id', 'name'])
      .where('tenant_id', '=', trx.tenantId)
      .execute(),
    trx.db
      .selectFrom('products')
      .select([
        'id',
        'sku',
        'name',
        'category_id',
        'base_uom',
        'tracking_mode',
        'valuation_method',
        'purchase_cost',
        'selling_price',
        'reorder_point',
        'reorder_qty',
        'track_inventory',
        'status',
      ])
      .where('tenant_id', '=', trx.tenantId)
      .execute(),
    trx.db.selectFrom('users').select(['id', 'email', 'full_name']).execute(),
    trx.db
      .selectFrom('employees')
      .select([
        'id',
        'employee_code',
        'display_name',
        'designation',
        'department',
        'employment_status',
        'primary_branch_id',
        'linked_user_id',
      ])
      .where('tenant_id', '=', trx.tenantId)
      .execute(),
    trx.db
      .selectFrom('suppliers')
      .select(['id', 'code', 'business_name', 'status'])
      .where('tenant_id', '=', trx.tenantId)
      .execute(),
  ]);

  const branchMap = new Map(branches.map((b) => [b.id, b]));
  const warehouseMap = new Map(warehouses.map((w) => [w.id, w]));
  const categoryMap = new Map(categories.map((c) => [c.id, c.name]));
  const productMap = new Map(products.map((p) => [p.id, p]));
  const userMap = new Map(users.map((u) => [u.id, u]));
  const employeeMap = new Map(employees.map((e) => [e.id, e]));
  const employeeByUserMap = new Map(
    employees.filter((e) => e.linked_user_id).map((e) => [e.linked_user_id!, e]),
  );
  const supplierMap = new Map(suppliers.map((s) => [s.id, s]));

  // Load invoices + lines + returns across [prevStartTs .. endTs] for current + comparison period
  let invoicesQuery = trx.db
    .selectFrom('sales_invoices')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('created_at', '>=', range.prevStartTs)
    .where('created_at', '<=', range.endTs);

  if (allowedBranchIds !== null) {
    if (allowedBranchIds.length === 0) {
      invoicesQuery = invoicesQuery.where('branch_id', '=', '__none__');
    } else {
      invoicesQuery = invoicesQuery.where('branch_id', 'in', allowedBranchIds);
    }
  }
  if (allowedWarehouseIds !== null) {
    if (allowedWarehouseIds.length === 0) {
      invoicesQuery = invoicesQuery.where('warehouse_id', '=', '__none__');
    } else {
      invoicesQuery = invoicesQuery.where('warehouse_id', 'in', allowedWarehouseIds);
    }
  }
  if (query.employeeId) {
    const emp = employeeMap.get(query.employeeId);
    const targetUserId = emp?.linked_user_id ?? query.employeeId;
    invoicesQuery = invoicesQuery.where('cashier_user_id', '=', targetUserId);
  }

  const allWindowInvoices = await invoicesQuery.execute();
  const allWindowInvoiceIds = allWindowInvoices.map((inv) => inv.id);

  const [allWindowLines, allWindowPayments, allWindowReturns] = await Promise.all([
    allWindowInvoiceIds.length > 0
      ? trx.db
          .selectFrom('sales_invoice_lines')
          .selectAll()
          .where('tenant_id', '=', trx.tenantId)
          .where('invoice_id', 'in', allWindowInvoiceIds)
          .execute()
      : Promise.resolve([]),
    allWindowInvoiceIds.length > 0
      ? trx.db
          .selectFrom('sales_payments')
          .selectAll()
          .where('tenant_id', '=', trx.tenantId)
          .where('invoice_id', 'in', allWindowInvoiceIds)
          .execute()
      : Promise.resolve([]),
    trx.db
      .selectFrom('pos_returns')
      .selectAll()
      .where('tenant_id', '=', trx.tenantId)
      .where('created_at', '>=', range.prevStartTs)
      .where('created_at', '<=', range.endTs)
      .execute(),
  ]);

  const scopedReturns = allWindowReturns.filter((r) => {
    if (allowedBranchIds !== null && !allowedBranchIds.includes(r.branch_id)) {
      return false;
    }
    if (
      allowedWarehouseIds !== null &&
      !allowedWarehouseIds.includes(r.warehouse_id)
    ) {
      return false;
    }
    return true;
  });

  const returnIds = scopedReturns.map((r) => r.id);
  const allWindowReturnLines =
    returnIds.length > 0
      ? await trx.db
          .selectFrom('pos_return_lines')
          .selectAll()
          .where('tenant_id', '=', trx.tenantId)
          .where('pos_return_id', 'in', returnIds)
          .execute()
      : [];

  // Map lines by invoice_id and id
  const linesByInvoiceId = new Map<string, typeof allWindowLines>();
  const invoiceLineById = new Map<string, (typeof allWindowLines)[number]>();
  for (const line of allWindowLines) {
    invoiceLineById.set(line.id, line);
    const list = linesByInvoiceId.get(line.invoice_id) ?? [];
    list.push(line);
    linesByInvoiceId.set(line.invoice_id, list);
  }

  const returnLinesByReturnId = new Map<string, typeof allWindowReturnLines>();
  for (const rl of allWindowReturnLines) {
    const list = returnLinesByReturnId.get(rl.pos_return_id) ?? [];
    list.push(rl);
    returnLinesByReturnId.set(rl.pos_return_id, list);
  }

  // Helper to compute sales & COGS metrics for a time window
  const computeWindowFinancials = (winStart: Date, winEnd: Date) => {
    const winInvoices = allWindowInvoices.filter((inv) => {
      const t = new Date(inv.created_at).getTime();
      return t >= winStart.getTime() && t <= winEnd.getTime();
    });
    const winReturns = scopedReturns.filter((ret) => {
      const t = new Date(ret.created_at).getTime();
      return t >= winStart.getTime() && t <= winEnd.getTime();
    });

    let completedOrders = 0;
    let voidedOrders = 0;
    let voidedAmount = 0;
    let grossSales = 0; // before discount, excl. tax
    let totalDiscounts = 0;
    let totalTax = 0;
    let billedGrandTotal = 0;
    let confirmedCogs = 0;
    let uncostedLineCount = 0;

    for (const inv of winInvoices) {
      if (inv.status === 'VOIDED') {
        voidedOrders += 1;
        voidedAmount += Number(inv.grand_total || 0);
        continue;
      }

      const invLines = (linesByInvoiceId.get(inv.id) ?? []).filter((l) => {
        if (query.productId && l.product_id !== query.productId) return false;
        if (query.categoryId) {
          const prod = productMap.get(l.product_id);
          if (prod?.category_id !== query.categoryId) return false;
        }
        return true;
      });

      if ((query.productId || query.categoryId) && invLines.length === 0) {
        continue;
      }

      completedOrders += 1;
      const allInvLines = linesByInvoiceId.get(inv.id) ?? [];
      const sumAllLineGross = allInvLines.reduce(
        (acc, l) => acc + Number(l.quantity || 0) * Number(l.unit_price || 0),
        0,
      );
      const sumAllLineDisc = allInvLines.reduce(
        (acc, l) => acc + Number(l.discount_amount || 0),
        0,
      );
      const headerExtraDisc = Math.max(
        0,
        Number(inv.discount_amount || 0) - sumAllLineDisc,
      );

      for (const l of invLines) {
        const lineGross = Number(l.quantity || 0) * Number(l.unit_price || 0);
        const propHeaderDisc =
          sumAllLineGross > 0
            ? headerExtraDisc * (lineGross / sumAllLineGross)
            : 0;
        const lineDisc = Number(l.discount_amount || 0) + propHeaderDisc;
        const lineTax = Number(l.tax_amount || 0);

        grossSales += lineGross;
        totalDiscounts += lineDisc;
        totalTax += lineTax;
        billedGrandTotal += lineGross - lineDisc + lineTax;

        const prod = productMap.get(l.product_id);
        const baseQty = Number(l.normalized_base_qty ?? l.quantity ?? 0);
        const unitCostSnap = Number(l.unit_cost_snapshot ?? 0);
        if (unitCostSnap > 0) {
          confirmedCogs += baseQty * unitCostSnap;
        } else if (
          prod &&
          prod.track_inventory !== false &&
          Number(prod.purchase_cost || 0) > 0
        ) {
          uncostedLineCount += 1;
        }
      }
    }

    let totalRefunds = 0;
    let restockedReturnCost = 0;
    let returnsCount = 0;

    for (const ret of winReturns) {
      const rLines = (returnLinesByReturnId.get(ret.id) ?? []).filter((rl) => {
        if (query.productId && rl.product_id !== query.productId) return false;
        if (query.categoryId) {
          const prod = productMap.get(rl.product_id);
          if (prod?.category_id !== query.categoryId) return false;
        }
        return true;
      });
      if ((query.productId || query.categoryId) && rLines.length === 0) {
        continue;
      }
      returnsCount += 1;
      for (const rl of rLines) {
        totalRefunds += Number(rl.refund_amount || 0);
        if (rl.restock_condition === 'RESELLABLE') {
          const origLine = invoiceLineById.get(rl.invoice_line_id);
          const unitCost = Number(origLine?.unit_cost_snapshot ?? 0);
          const baseRetQty = Number(rl.normalized_base_qty ?? rl.return_qty ?? 0);
          if (unitCost > 0 && baseRetQty > 0) {
            restockedReturnCost += baseRetQty * unitCost;
          }
        }
      }
    }

    const netCogs = Math.max(0, confirmedCogs - restockedReturnCost);
    const netSales = grossSales - totalDiscounts - totalRefunds;
    const grossProfit = netSales - netCogs;
    const grossMarginPct = netSales > 0 ? (grossProfit / netSales) * 100 : 0;
    const averageOrderValue =
      completedOrders > 0 ? netSales / completedOrders : 0;

    return {
      completedOrders,
      voidedOrders,
      voidedAmount,
      grossSales,
      totalDiscounts,
      totalRefunds,
      returnsCount,
      totalTax,
      billedGrandTotal,
      netSales,
      netCogs,
      grossProfit,
      grossMarginPct,
      averageOrderValue,
      uncostedLineCount,
      winInvoices,
      winReturns,
    };
  };

  const currentFin = computeWindowFinancials(range.startTs, range.endTs);
  const prevFin = computeWindowFinancials(range.prevStartTs, range.prevEndTs);

  // Load expenses and payroll across [prevStartTs .. endTs] for Net Profit & Financial reports
  let expensesQuery = trx.db
    .selectFrom('expenses')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId);

  if (allowedBranchIds !== null) {
    if (allowedBranchIds.length === 0) {
      expensesQuery = expensesQuery.where('branch_id', '=', '__none__');
    } else {
      expensesQuery = expensesQuery.where((eb) =>
        eb.or([
          eb('branch_id', 'in', allowedBranchIds),
          eb('branch_id', 'is', null),
        ]),
      );
    }
  }

  const [allExpenses, expenseCategories, allPayrollRuns] = await Promise.all([
    expensesQuery.execute(),
    trx.db
      .selectFrom('expense_categories')
      .select(['id', 'code', 'name'])
      .where('tenant_id', '=', trx.tenantId)
      .execute(),
    trx.db
      .selectFrom('payroll_runs')
      .selectAll()
      .where('tenant_id', '=', trx.tenantId)
      .execute(),
  ]);

  const expCategoryMap = new Map(expenseCategories.map((c) => [c.id, c.name]));

  const filterExpensesInWindow = (winStart: Date, winEnd: Date) =>
    allExpenses.filter((e) => {
      const d = new Date(e.expense_date || e.created_at).getTime();
      return d >= winStart.getTime() && d <= winEnd.getTime();
    });

  const filterPayrollInWindow = (winStart: Date, winEnd: Date) =>
    allPayrollRuns.filter((pr) => {
      const d = new Date(pr.period_end || pr.payment_date || pr.created_at).getTime();
      return d >= winStart.getTime() && d <= winEnd.getTime();
    });

  const currentExpenses = filterExpensesInWindow(range.startTs, range.endTs);
  const prevExpenses = filterExpensesInWindow(range.prevStartTs, range.prevEndTs);
  const currentPayrolls = filterPayrollInWindow(range.startTs, range.endTs);
  const prevPayrolls = filterPayrollInWindow(range.prevStartTs, range.prevEndTs);

  const currentApprovedExpenses = currentExpenses
    .filter((e) => e.status === 'APPROVED' || e.status === 'PAID')
    .reduce((acc, e) => acc + Number(e.amount || 0), 0);
  const prevApprovedExpenses = prevExpenses
    .filter((e) => e.status === 'APPROVED' || e.status === 'PAID')
    .reduce((acc, e) => acc + Number(e.amount || 0), 0);

  const currentPayrollExpense = currentPayrolls
    .filter((pr) =>
      ['APPROVED', 'PARTIALLY_PAID', 'PAID'].includes(String(pr.status)),
    )
    .reduce((acc, pr) => acc + Number(pr.total_gross_pay || 0), 0);
  const prevPayrollExpense = prevPayrolls
    .filter((pr) =>
      ['APPROVED', 'PARTIALLY_PAID', 'PAID'].includes(String(pr.status)),
    )
    .reduce((acc, pr) => acc + Number(pr.total_gross_pay || 0), 0);

  const currentNetProfit =
    currentFin.grossProfit - currentApprovedExpenses - currentPayrollExpense;
  const prevNetProfit =
    prevFin.grossProfit - prevApprovedExpenses - prevPayrollExpense;
  const currentNetMarginPct =
    currentFin.netSales > 0 ? (currentNetProfit / currentFin.netSales) * 100 : 0;

  // =========================================================================
  // 1. SALES REPORT DATA
  // =========================================================================
  const seriesMap = new Map<
    string,
    {
      period: string;
      ordersCount: number;
      grossSales: number;
      discounts: number;
      refunds: number;
      taxAmount: number;
      netSales: number;
    }
  >();

  const byProductMap = new Map<
    string,
    {
      productId: string;
      sku: string;
      productName: string;
      categoryId: string | null;
      categoryName: string;
      uomCode: string;
      qtySold: number;
      grossAmount: number;
      discountAmount: number;
      refundAmount: number;
      netAmount: number;
      cogsAmount: number;
      invoiceIds: Set<string>;
    }
  >();

  const byCategoryMap = new Map<
    string,
    {
      categoryId: string;
      categoryName: string;
      qtySold: number;
      grossAmount: number;
      discountAmount: number;
      refundAmount: number;
      netAmount: number;
      cogsAmount: number;
    }
  >();

  const byEmployeeMap = new Map<
    string,
    {
      userId: string;
      employeeId: string | null;
      employeeName: string;
      email: string;
      ordersCount: number;
      grossSales: number;
      discounts: number;
      netSales: number;
    }
  >();

  const byBranchMap = new Map<
    string,
    {
      branchId: string;
      branchName: string;
      ordersCount: number;
      grossSales: number;
      discounts: number;
      refunds: number;
      netSales: number;
      cogs: number;
    }
  >();

  for (const inv of currentFin.winInvoices) {
    if (inv.status === 'VOIDED') continue;
    const invLines = (linesByInvoiceId.get(inv.id) ?? []).filter((l) => {
      if (query.productId && l.product_id !== query.productId) return false;
      if (query.categoryId) {
        const prod = productMap.get(l.product_id);
        if (prod?.category_id !== query.categoryId) return false;
      }
      return true;
    });
    if ((query.productId || query.categoryId) && invLines.length === 0) continue;

    const bucket = formatBucketKey(inv.created_at, granularity);
    const sEntry = seriesMap.get(bucket) ?? {
      period: bucket,
      ordersCount: 0,
      grossSales: 0,
      discounts: 0,
      refunds: 0,
      taxAmount: 0,
      netSales: 0,
    };
    sEntry.ordersCount += 1;

    const allInvLines = linesByInvoiceId.get(inv.id) ?? [];
    const sumAllLineGross = allInvLines.reduce(
      (acc, l) => acc + Number(l.quantity || 0) * Number(l.unit_price || 0),
      0,
    );
    const sumAllLineDisc = allInvLines.reduce(
      (acc, l) => acc + Number(l.discount_amount || 0),
      0,
    );
    const headerExtraDisc = Math.max(
      0,
      Number(inv.discount_amount || 0) - sumAllLineDisc,
    );

    const branchName = branchMap.get(inv.branch_id)?.name ?? 'Main Branch';
    const bEntry = byBranchMap.get(inv.branch_id) ?? {
      branchId: inv.branch_id,
      branchName,
      ordersCount: 0,
      grossSales: 0,
      discounts: 0,
      refunds: 0,
      netSales: 0,
      cogs: 0,
    };
    bEntry.ordersCount += 1;

    const userObj = userMap.get(inv.cashier_user_id);
    const empObj = employeeByUserMap.get(inv.cashier_user_id);
    const empName =
      empObj?.display_name ?? userObj?.full_name ?? userObj?.email ?? 'Cashier';
    const eEntry = byEmployeeMap.get(inv.cashier_user_id) ?? {
      userId: inv.cashier_user_id,
      employeeId: empObj?.id ?? null,
      employeeName: empName,
      email: userObj?.email ?? '—',
      ordersCount: 0,
      grossSales: 0,
      discounts: 0,
      netSales: 0,
    };
    eEntry.ordersCount += 1;

    for (const l of invLines) {
      const lineGross = Number(l.quantity || 0) * Number(l.unit_price || 0);
      const propHeaderDisc =
        sumAllLineGross > 0
          ? headerExtraDisc * (lineGross / sumAllLineGross)
          : 0;
      const lineDisc = Number(l.discount_amount || 0) + propHeaderDisc;
      const lineTax = Number(l.tax_amount || 0);
      const lineNet = lineGross - lineDisc;
      const baseQty = Number(l.normalized_base_qty ?? l.quantity ?? 0);
      const lineCogs = baseQty * Number(l.unit_cost_snapshot ?? 0);

      sEntry.grossSales += lineGross;
      sEntry.discounts += lineDisc;
      sEntry.taxAmount += lineTax;
      sEntry.netSales += lineNet;

      bEntry.grossSales += lineGross;
      bEntry.discounts += lineDisc;
      bEntry.netSales += lineNet;
      bEntry.cogs += lineCogs;

      eEntry.grossSales += lineGross;
      eEntry.discounts += lineDisc;
      eEntry.netSales += lineNet;

      const prod = productMap.get(l.product_id);
      const catId = prod?.category_id ?? 'uncategorized';
      const catName =
        (prod?.category_id ? categoryMap.get(prod.category_id) : null) ??
        'Uncategorized';

      const pEntry = byProductMap.get(l.product_id) ?? {
        productId: l.product_id,
        sku: l.sku || prod?.sku || '—',
        productName: l.product_name || prod?.name || 'Product',
        categoryId: prod?.category_id ?? null,
        categoryName: catName,
        uomCode: prod?.base_uom ?? l.uom_code ?? 'PCS',
        qtySold: 0,
        grossAmount: 0,
        discountAmount: 0,
        refundAmount: 0,
        netAmount: 0,
        cogsAmount: 0,
        invoiceIds: new Set<string>(),
      };
      pEntry.qtySold += baseQty;
      pEntry.grossAmount += lineGross;
      pEntry.discountAmount += lineDisc;
      pEntry.netAmount += lineNet;
      pEntry.cogsAmount += lineCogs;
      pEntry.invoiceIds.add(inv.id);
      byProductMap.set(l.product_id, pEntry);

      const cEntry = byCategoryMap.get(catId) ?? {
        categoryId: catId,
        categoryName: catName,
        qtySold: 0,
        grossAmount: 0,
        discountAmount: 0,
        refundAmount: 0,
        netAmount: 0,
        cogsAmount: 0,
      };
      cEntry.qtySold += baseQty;
      cEntry.grossAmount += lineGross;
      cEntry.discountAmount += lineDisc;
      cEntry.netAmount += lineNet;
      cEntry.cogsAmount += lineCogs;
      byCategoryMap.set(catId, cEntry);
    }

    seriesMap.set(bucket, sEntry);
    byBranchMap.set(inv.branch_id, bEntry);
    byEmployeeMap.set(inv.cashier_user_id, eEntry);
  }

  for (const ret of currentFin.winReturns) {
    const bucket = formatBucketKey(ret.created_at, granularity);
    const sEntry = seriesMap.get(bucket);
    const bEntry = byBranchMap.get(ret.branch_id);
    const rLines = returnLinesByReturnId.get(ret.id) ?? [];

    for (const rl of rLines) {
      if (query.productId && rl.product_id !== query.productId) continue;
      const prod = productMap.get(rl.product_id);
      if (query.categoryId && prod?.category_id !== query.categoryId) continue;

      const refAmt = Number(rl.refund_amount || 0);
      const origLine = invoiceLineById.get(rl.invoice_line_id);
      const baseRetQty = Number(rl.normalized_base_qty ?? rl.return_qty ?? 0);
      const restockCost =
        rl.restock_condition === 'RESELLABLE'
          ? baseRetQty * Number(origLine?.unit_cost_snapshot ?? 0)
          : 0;

      if (sEntry) {
        sEntry.refunds += refAmt;
        sEntry.netSales -= refAmt;
      }
      if (bEntry) {
        bEntry.refunds += refAmt;
        bEntry.netSales -= refAmt;
        bEntry.cogs = Math.max(0, bEntry.cogs - restockCost);
      }
      const pEntry = byProductMap.get(rl.product_id);
      if (pEntry) {
        pEntry.refundAmount += refAmt;
        pEntry.netAmount -= refAmt;
        pEntry.cogsAmount = Math.max(0, pEntry.cogsAmount - restockCost);
      }
      const catId = prod?.category_id ?? 'uncategorized';
      const cEntry = byCategoryMap.get(catId);
      if (cEntry) {
        cEntry.refundAmount += refAmt;
        cEntry.netAmount -= refAmt;
        cEntry.cogsAmount = Math.max(0, cEntry.cogsAmount - restockCost);
      }
    }
  }

  const salesSeries = Array.from(seriesMap.values())
    .sort((a, b) => a.period.localeCompare(b.period))
    .map((s) => ({
      period: s.period,
      ordersCount: s.ordersCount,
      grossSales: roundMoney(s.grossSales),
      discounts: roundMoney(s.discounts),
      refunds: roundMoney(s.refunds),
      taxAmount: roundMoney(s.taxAmount),
      netSales: roundMoney(s.netSales),
      averageOrderValue: roundMoney(
        s.ordersCount > 0 ? s.netSales / s.ordersCount : 0,
      ),
    }));

  const salesByProduct = Array.from(byProductMap.values())
    .sort((a, b) => b.netAmount - a.netAmount)
    .map((p) => {
      const gp = p.netAmount - p.cogsAmount;
      const prod = productMap.get(p.productId);
      return {
        productId: p.productId,
        sku: p.sku,
        productName: p.productName,
        categoryName: p.categoryName,
        uomCode: p.uomCode,
        valuationMethod: prod?.valuation_method ?? 'MOVING_AVG',
        costBasis:
          prod?.tracking_mode === 'BATCH' ||
          prod?.tracking_mode === 'BATCH_EXPIRY' ||
          prod?.valuation_method === 'FIFO'
            ? 'FIFO_BATCH'
            : 'MOVING_AVG',
        qtySold: roundMoney(p.qtySold),
        invoiceCount: p.invoiceIds.size,
        grossAmount: roundMoney(p.grossAmount),
        discountAmount: roundMoney(p.discountAmount),
        refundAmount: roundMoney(p.refundAmount),
        netAmount: roundMoney(p.netAmount),
        cogsAmount: roundMoney(p.cogsAmount),
        grossProfit: roundMoney(gp),
        grossMarginPct: roundPct(p.netAmount > 0 ? (gp / p.netAmount) * 100 : 0),
      };
    });

  const totalCategoryNet = Array.from(byCategoryMap.values()).reduce(
    (acc, c) => acc + Math.max(0, c.netAmount),
    0,
  );
  const salesByCategory = Array.from(byCategoryMap.values())
    .sort((a, b) => b.netAmount - a.netAmount)
    .map((c) => {
      const gp = c.netAmount - c.cogsAmount;
      return {
        categoryId: c.categoryId,
        categoryName: c.categoryName,
        qtySold: roundMoney(c.qtySold),
        grossAmount: roundMoney(c.grossAmount),
        discountAmount: roundMoney(c.discountAmount),
        refundAmount: roundMoney(c.refundAmount),
        netAmount: roundMoney(c.netAmount),
        cogsAmount: roundMoney(c.cogsAmount),
        grossProfit: roundMoney(gp),
        grossMarginPct: roundPct(c.netAmount > 0 ? (gp / c.netAmount) * 100 : 0),
        sharePct: roundPct(
          totalCategoryNet > 0 ? (Math.max(0, c.netAmount) / totalCategoryNet) * 100 : 0,
        ),
      };
    });

  const salesByEmployee = Array.from(byEmployeeMap.values())
    .sort((a, b) => b.netSales - a.netSales)
    .map((e) => ({
      userId: e.userId,
      employeeId: e.employeeId,
      employeeName: e.employeeName,
      email: e.email,
      ordersCount: e.ordersCount,
      grossSales: roundMoney(e.grossSales),
      discounts: roundMoney(e.discounts),
      netSales: roundMoney(e.netSales),
      averageOrderValue: roundMoney(
        e.ordersCount > 0 ? e.netSales / e.ordersCount : 0,
      ),
    }));

  const salesByBranch = Array.from(byBranchMap.values())
    .sort((a, b) => b.netSales - a.netSales)
    .map((b) => {
      const gp = b.netSales - b.cogs;
      const branchExpenses = currentExpenses
        .filter(
          (e) =>
            e.branch_id === b.branchId &&
            (e.status === 'APPROVED' || e.status === 'PAID'),
        )
        .reduce((acc, e) => acc + Number(e.amount || 0), 0);
      const branchNetProfit = gp - branchExpenses;
      return {
        branchId: b.branchId,
        branchName: b.branchName,
        ordersCount: b.ordersCount,
        grossSales: roundMoney(b.grossSales),
        discounts: roundMoney(b.discounts),
        refunds: roundMoney(b.refunds),
        netSales: roundMoney(b.netSales),
        cogs: roundMoney(b.cogs),
        grossProfit: roundMoney(gp),
        grossMarginPct: roundPct(b.netSales > 0 ? (gp / b.netSales) * 100 : 0),
        branchExpenses: roundMoney(branchExpenses),
        branchNetProfit: roundMoney(branchNetProfit),
        branchNetMarginPct: roundPct(
          b.netSales > 0 ? (branchNetProfit / b.netSales) * 100 : 0,
        ),
        averageOrderValue: roundMoney(
          b.ordersCount > 0 ? b.netSales / b.ordersCount : 0,
        ),
      };
    });

  // =========================================================================
  // 2. INVENTORY REPORT DATA
  // =========================================================================
  let balancesQuery = trx.db
    .selectFrom('inventory_balances')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId);

  if (allowedBranchIds !== null) {
    balancesQuery =
      allowedBranchIds.length > 0
        ? balancesQuery.where('branch_id', 'in', allowedBranchIds)
        : balancesQuery.where('branch_id', '=', '__none__');
  }
  if (allowedWarehouseIds !== null) {
    balancesQuery =
      allowedWarehouseIds.length > 0
        ? balancesQuery.where('warehouse_id', 'in', allowedWarehouseIds)
        : balancesQuery.where('warehouse_id', '=', '__none__');
  }
  if (query.productId) {
    balancesQuery = balancesQuery.where('product_id', '=', query.productId);
  }

  let batchesQuery = trx.db
    .selectFrom('inventory_batches')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('status', 'in', ['ACTIVE', 'QUARANTINED']);

  if (allowedWarehouseIds !== null) {
    batchesQuery =
      allowedWarehouseIds.length > 0
        ? batchesQuery.where('warehouse_id', 'in', allowedWarehouseIds)
        : batchesQuery.where('warehouse_id', '=', '__none__');
  }

  let ledgerQuery = trx.db
    .selectFrom('stock_ledger_entries')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('occurred_at', '>=', range.startTs)
    .where('occurred_at', '<=', range.endTs)
    .orderBy('occurred_at', 'desc');

  if (allowedBranchIds !== null) {
    ledgerQuery =
      allowedBranchIds.length > 0
        ? ledgerQuery.where('branch_id', 'in', allowedBranchIds)
        : ledgerQuery.where('branch_id', '=', '__none__');
  }
  if (allowedWarehouseIds !== null) {
    ledgerQuery =
      allowedWarehouseIds.length > 0
        ? ledgerQuery.where('warehouse_id', 'in', allowedWarehouseIds)
        : ledgerQuery.where('warehouse_id', '=', '__none__');
  }

  const [balanceRows, activeBatches, periodLedgerEntries] = await Promise.all([
    balancesQuery.execute(),
    batchesQuery.execute(),
    ledgerQuery.execute(),
  ]);

  // Compute FIFO batch layer valuation per (product_id, warehouse_id)
  const batchValByProdWh = new Map<string, number>();
  for (const b of activeBatches) {
    const key = `${b.product_id}:${b.warehouse_id}`;
    const curVal = batchValByProdWh.get(key) ?? 0;
    const rem = Math.max(0, Number(b.current_quantity || 0));
    const uCost = Number(b.unit_cost || 0);
    batchValByProdWh.set(key, curVal + rem * uCost);
  }

  let totalInventoryValuation = 0;
  let totalOnHandUnits = 0;
  let lowStockCount = 0;
  let outOfStockCount = 0;

  const stockOnHand = balanceRows
    .filter((bal) => {
      const prod = productMap.get(bal.product_id);
      if (!prod) return false;
      if (query.categoryId && prod.category_id !== query.categoryId) return false;
      return true;
    })
    .map((bal) => {
      const prod = productMap.get(bal.product_id)!;
      const wh = warehouseMap.get(bal.warehouse_id);
      const br = branchMap.get(bal.branch_id);
      const onHand = Number(bal.qty_on_hand || 0);
      const reserved = Number(bal.qty_reserved || 0);
      const avail = Math.max(0, onHand - reserved);
      const reorderPt = Number(prod.reorder_point || 0);
      const reorderQty = Number(prod.reorder_qty || 0);
      const macCost = Number(bal.moving_avg_cost || prod.purchase_cost || 0);

      const isBatchOrFifo =
        prod.tracking_mode === 'BATCH' ||
        prod.tracking_mode === 'BATCH_EXPIRY' ||
        prod.valuation_method === 'FIFO';
      const fifoVal = batchValByProdWh.get(`${bal.product_id}:${bal.warehouse_id}`);
      const totalVal =
        isBatchOrFifo && fifoVal !== undefined && fifoVal > 0
          ? fifoVal
          : Number(bal.total_inventory_value || 0) > 0
            ? Number(bal.total_inventory_value)
            : Math.max(0, onHand) * macCost;

      const effectiveUnitCost = onHand > 0 ? totalVal / onHand : macCost;

      totalInventoryValuation += totalVal;
      totalOnHandUnits += Math.max(0, onHand);

      let stockStatus: 'IN_STOCK' | 'LOW_STOCK' | 'OUT_OF_STOCK' = 'IN_STOCK';
      if (avail <= 0) {
        stockStatus = 'OUT_OF_STOCK';
        outOfStockCount += 1;
      } else if (avail <= reorderPt) {
        stockStatus = 'LOW_STOCK';
        lowStockCount += 1;
      }

      return {
        productId: prod.id,
        sku: prod.sku,
        productName: prod.name,
        categoryName:
          (prod.category_id ? categoryMap.get(prod.category_id) : null) ??
          'Uncategorized',
        warehouseId: bal.warehouse_id,
        warehouseName: wh?.name ?? 'Warehouse',
        branchId: bal.branch_id,
        branchName: br?.name ?? 'Branch',
        baseUom: prod.base_uom,
        trackingMode: prod.tracking_mode,
        valuationMethod: isBatchOrFifo ? 'FIFO' : 'MOVING_AVG',
        qtyOnHand: roundMoney(onHand),
        qtyReserved: roundMoney(reserved),
        availableQty: roundMoney(avail),
        reorderPoint: roundMoney(reorderPt),
        reorderQty: roundMoney(reorderQty),
        shortfallQty: roundMoney(Math.max(0, reorderPt - avail)),
        unitCost: roundMoney(effectiveUnitCost),
        totalValuation: roundMoney(totalVal),
        stockStatus,
      };
    });

  const lowAndOutOfStock = stockOnHand.filter(
    (s) => s.stockStatus === 'OUT_OF_STOCK' || s.stockStatus === 'LOW_STOCK',
  );

  // Fast Moving & Slow Moving Products + Inventory Turnover
  const onHandByProduct = new Map<string, number>();
  for (const b of balanceRows) {
    onHandByProduct.set(
      b.product_id,
      (onHandByProduct.get(b.product_id) ?? 0) + Math.max(0, Number(b.qty_on_hand || 0)),
    );
  }

  let fastMovingCount = 0;
  let slowMovingCount = 0;
  const movementVelocity = products
    .filter((p) => {
      if (p.status !== 'ACTIVE' || p.track_inventory === false) return false;
      if (query.productId && p.id !== query.productId) return false;
      if (query.categoryId && p.category_id !== query.categoryId) return false;
      return true;
    })
    .map((p) => {
      const salesStat = byProductMap.get(p.id);
      const qtySold = salesStat?.qtySold ?? 0;
      const invoiceCount = salesStat?.invoiceIds.size ?? 0;
      const onHand = onHandByProduct.get(p.id) ?? 0;
      const avgInventory = onHand > 0 ? onHand : qtySold > 0 ? qtySold : 1;
      const turnoverRatio = onHand > 0 || qtySold > 0 ? qtySold / avgInventory : 0;
      const dailyVelocity = qtySold / range.daysInPeriod;
      const daysRemaining =
        dailyVelocity > 0 ? Math.round(onHand / dailyVelocity) : null;

      let classification: 'FAST_MOVING' | 'MODERATE' | 'SLOW_MOVING' | 'NON_MOVING' =
        'NON_MOVING';
      if (qtySold >= 5 || invoiceCount >= 3 || turnoverRatio >= 0.5) {
        classification = 'FAST_MOVING';
        fastMovingCount += 1;
      } else if (qtySold >= 2) {
        classification = 'MODERATE';
      } else if (qtySold > 0) {
        classification = 'SLOW_MOVING';
        slowMovingCount += 1;
      } else {
        classification = 'NON_MOVING';
        slowMovingCount += 1;
      }

      return {
        productId: p.id,
        sku: p.sku,
        productName: p.name,
        categoryName:
          (p.category_id ? categoryMap.get(p.category_id) : null) ??
          'Uncategorized',
        baseUom: p.base_uom,
        qtySoldInPeriod: roundMoney(qtySold),
        salesFrequency: invoiceCount,
        qtyOnHand: roundMoney(onHand),
        turnoverRatio: roundPct(turnoverRatio),
        daysOfInventoryRemaining: daysRemaining,
        classification,
      };
    })
    .sort((a, b) => Number(b.qtySoldInPeriod) - Number(a.qtySoldInPeriod));

  const overallTurnoverRatio =
    totalInventoryValuation > 0
      ? currentFin.netCogs / totalInventoryValuation
      : 0;

  let positiveAdjustmentsValue = 0;
  let negativeAdjustmentsValue = 0;
  const stockAdjustments = periodLedgerEntries
    .filter(
      (le) =>
        le.movement_type === 'ADJUSTMENT_POSITIVE' ||
        le.movement_type === 'ADJUSTMENT_NEGATIVE' ||
        le.movement_type === 'CORRECTION_REVERSAL' ||
        le.entry_source === 'STOCKTAKE' ||
        le.entry_source === 'MANUAL' ||
        le.entry_source === 'UOM_CORRECTION',
    )
    .map((le) => {
      const prod = productMap.get(le.product_id);
      const wh = warehouseMap.get(le.warehouse_id);
      const actor = userMap.get(le.actor_user_id);
      const costDelta = Number(le.total_cost_delta || 0);
      if (costDelta >= 0) positiveAdjustmentsValue += costDelta;
      else negativeAdjustmentsValue += Math.abs(costDelta);

      return {
        id: le.id,
        occurredAt: new Date(le.occurred_at).toISOString(),
        productId: le.product_id,
        sku: prod?.sku ?? '—',
        productName: prod?.name ?? 'Product',
        warehouseName: wh?.name ?? 'Warehouse',
        movementType: le.movement_type,
        entrySource: le.entry_source,
        qtyDelta: roundMoney(Number(le.qty_delta || 0)),
        unitCost: roundMoney(Number(le.unit_cost || 0)),
        totalCostDelta: roundMoney(costDelta),
        reason: le.reason ?? '—',
        actorName: actor?.full_name ?? actor?.email ?? 'System',
      };
    });

  // =========================================================================
  // 4. PURCHASING & SUPPLIER REPORT DATA
  // =========================================================================
  let poQuery = trx.db
    .selectFrom('purchase_orders')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('created_at', '>=', range.startTs)
    .where('created_at', '<=', range.endTs);

  let grnQuery = trx.db
    .selectFrom('goods_receipts')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('received_at', '>=', range.startTs)
    .where('received_at', '<=', range.endTs);

  let supRetQuery = trx.db
    .selectFrom('supplier_returns')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('created_at', '>=', range.startTs)
    .where('created_at', '<=', range.endTs);

  if (allowedBranchIds !== null) {
    poQuery =
      allowedBranchIds.length > 0
        ? poQuery.where('branch_id', 'in', allowedBranchIds)
        : poQuery.where('branch_id', '=', '__none__');
    grnQuery =
      allowedBranchIds.length > 0
        ? grnQuery.where('branch_id', 'in', allowedBranchIds)
        : grnQuery.where('branch_id', '=', '__none__');
    supRetQuery =
      allowedBranchIds.length > 0
        ? supRetQuery.where('branch_id', 'in', allowedBranchIds)
        : supRetQuery.where('branch_id', '=', '__none__');
  }
  if (query.supplierId) {
    poQuery = poQuery.where('supplier_id', '=', query.supplierId);
    grnQuery = grnQuery.where('supplier_id', '=', query.supplierId);
    supRetQuery = supRetQuery.where('supplier_id', '=', query.supplierId);
  }

  const [purchaseOrders, goodsReceipts, supplierReturns] = await Promise.all([
    poQuery.execute(),
    grnQuery.execute(),
    supRetQuery.execute(),
  ]);

  const bySupplierMap = new Map<
    string,
    {
      supplierId: string;
      supplierCode: string;
      supplierName: string;
      poCount: number;
      poValue: number;
      grnCount: number;
      totalReceivedValue: number;
      returnsValue: number;
      unreceivedPoValue: number;
    }
  >();

  let totalPoValue = 0;
  let totalGrnValue = 0;
  let totalSupReturnValue = 0;
  let outstandingPayablesEstimate = 0;

  for (const po of purchaseOrders) {
    if (po.status === 'CANCELLED') continue;
    const sup = supplierMap.get(po.supplier_id);
    const amt = Number(po.total_amount || 0);
    totalPoValue += amt;
    const entry = bySupplierMap.get(po.supplier_id) ?? {
      supplierId: po.supplier_id,
      supplierCode: sup?.code ?? '—',
      supplierName: sup?.business_name ?? 'Supplier',
      poCount: 0,
      poValue: 0,
      grnCount: 0,
      totalReceivedValue: 0,
      returnsValue: 0,
      unreceivedPoValue: 0,
    };
    entry.poCount += 1;
    entry.poValue += amt;
    if (po.status === 'APPROVED' || po.status === 'PARTIALLY_RECEIVED') {
      entry.unreceivedPoValue += amt;
    }
    bySupplierMap.set(po.supplier_id, entry);
  }

  for (const grn of goodsReceipts) {
    if (grn.status === 'CANCELLED') continue;
    const sup = supplierMap.get(grn.supplier_id);
    const amt = Number(grn.total_cost || 0);
    totalGrnValue += amt;
    const entry = bySupplierMap.get(grn.supplier_id) ?? {
      supplierId: grn.supplier_id,
      supplierCode: sup?.code ?? '—',
      supplierName: sup?.business_name ?? 'Supplier',
      poCount: 0,
      poValue: 0,
      grnCount: 0,
      totalReceivedValue: 0,
      returnsValue: 0,
      unreceivedPoValue: 0,
    };
    entry.grnCount += 1;
    entry.totalReceivedValue += amt;
    bySupplierMap.set(grn.supplier_id, entry);
  }

  for (const sr of supplierReturns) {
    const sup = supplierMap.get(sr.supplier_id);
    const amt = Number(sr.total_cost || 0);
    totalSupReturnValue += amt;
    const entry = bySupplierMap.get(sr.supplier_id) ?? {
      supplierId: sr.supplier_id,
      supplierCode: sup?.code ?? '—',
      supplierName: sup?.business_name ?? 'Supplier',
      poCount: 0,
      poValue: 0,
      grnCount: 0,
      totalReceivedValue: 0,
      returnsValue: 0,
      unreceivedPoValue: 0,
    };
    entry.returnsValue += amt;
    bySupplierMap.set(sr.supplier_id, entry);
  }

  // Compute supplier payouts recorded in expenses (if any) vs net GRN value
  const supplierByPurchaseList = Array.from(bySupplierMap.values())
    .map((s) => {
      const netPurchase = Math.max(0, s.totalReceivedValue - s.returnsValue);
      outstandingPayablesEstimate += netPurchase;
      return {
        supplierId: s.supplierId,
        supplierCode: s.supplierCode,
        supplierName: s.supplierName,
        poCount: s.poCount,
        poValue: roundMoney(s.poValue),
        grnCount: s.grnCount,
        totalReceivedValue: roundMoney(s.totalReceivedValue),
        returnsValue: roundMoney(s.returnsValue),
        netPurchaseValue: roundMoney(netPurchase),
        unreceivedPoValue: roundMoney(s.unreceivedPoValue),
      };
    })
    .sort((a, b) => Number(b.netPurchaseValue) - Number(a.netPurchaseValue));

  // =========================================================================
  // 5. CUSTOMER & CREDIT REPORT DATA
  // =========================================================================
  const [allCustomers, creditAccounts, creditTransactions] = await Promise.all([
    trx.db
      .selectFrom('customers')
      .selectAll()
      .where('tenant_id', '=', trx.tenantId)
      .execute(),
    trx.db
      .selectFrom('customer_credit_accounts')
      .selectAll()
      .where('tenant_id', '=', trx.tenantId)
      .execute(),
    trx.db
      .selectFrom('customer_credit_transactions')
      .selectAll()
      .where('tenant_id', '=', trx.tenantId)
      .where('is_reversed', '=', false)
      .execute(),
  ]);

  const customerMap = new Map(allCustomers.map((c) => [c.id, c]));
  const creditAccByCustomer = new Map(
    creditAccounts.map((ca) => [ca.customer_id, ca]),
  );

  // Track historical invoices before startTs to distinguish New vs Returning customers
  const priorCustomerInvoices = await trx.db
    .selectFrom('sales_invoices')
    .select(['customer_id'])
    .where('tenant_id', '=', trx.tenantId)
    .where('status', '=', 'COMPLETED')
    .where('customer_id', 'is not', null)
    .where('created_at', '<', range.startTs)
    .execute();
  const priorCustomerIds = new Set(
    priorCustomerInvoices.map((r) => r.customer_id!).filter(Boolean),
  );

  const customerSalesStats = new Map<
    string,
    {
      customerId: string;
      ordersCount: number;
      totalSpent: number;
      lastPurchaseAt: string;
    }
  >();

  for (const inv of currentFin.winInvoices) {
    if (inv.status === 'VOIDED' || !inv.customer_id) continue;
    const cur = customerSalesStats.get(inv.customer_id) ?? {
      customerId: inv.customer_id,
      ordersCount: 0,
      totalSpent: 0,
      lastPurchaseAt: new Date(inv.created_at).toISOString(),
    };
    cur.ordersCount += 1;
    cur.totalSpent += Number(inv.grand_total || 0);
    const iso = new Date(inv.created_at).toISOString();
    if (iso > cur.lastPurchaseAt) cur.lastPurchaseAt = iso;
    customerSalesStats.set(inv.customer_id, cur);
  }

  let newCustomersInPeriod = 0;
  let returningCustomersInPeriod = 0;
  for (const [custId, stat] of customerSalesStats.entries()) {
    if (priorCustomerIds.has(custId) || stat.ordersCount > 1) {
      returningCustomersInPeriod += 1;
    } else {
      newCustomersInPeriod += 1;
    }
  }

  let totalOutstandingCredit = 0;
  let totalOverdueBalance = 0;
  let overdueAccountsCount = 0;
  const nowMs = Date.now();

  const creditAccountRows = creditAccounts
    .filter((ca) => {
      if (
        allowedBranchIds !== null &&
        ca.branch_id &&
        !allowedBranchIds.includes(ca.branch_id)
      ) {
        return false;
      }
      return true;
    })
    .map((ca) => {
      const cust = customerMap.get(ca.customer_id);
      const bal = Math.max(0, Number(ca.current_balance || 0));
      totalOutstandingCredit += bal;

      // Compute overdue amount from unpaid debit transactions past due_date
      const accTxns = creditTransactions.filter(
        (t) =>
          t.account_id === ca.id &&
          t.entry_direction === 'DEBIT' &&
          Number(t.unpaid_amount || 0) > 0 &&
          t.due_date,
      );
      let overdueAmt = 0;
      let maxOverdueDays = 0;
      for (const tx of accTxns) {
        const dueMs = new Date(tx.due_date!).getTime();
        if (dueMs < nowMs) {
          overdueAmt += Number(tx.unpaid_amount || 0);
          const days = Math.floor((nowMs - dueMs) / 86400000);
          if (days > maxOverdueDays) maxOverdueDays = days;
        }
      }
      if (overdueAmt > 0) {
        totalOverdueBalance += overdueAmt;
        overdueAccountsCount += 1;
      }

      return {
        accountId: ca.id,
        accountNumber: ca.account_number,
        customerId: ca.customer_id,
        customerName: cust?.name ?? 'Customer',
        creditLimit: roundMoney(Number(ca.credit_limit || 0)),
        currentBalance: roundMoney(bal),
        availableCredit: roundMoney(Number(ca.available_credit || 0)),
        overdueAmount: roundMoney(overdueAmt),
        maxOverdueDays,
        status: ca.status,
        riskClassification: ca.risk_classification,
      };
    })
    .sort((a, b) => Number(b.currentBalance) - Number(a.currentBalance));

  const topCustomers = Array.from(customerSalesStats.values())
    .map((cs) => {
      const cust = customerMap.get(cs.customerId);
      const ca = creditAccByCustomer.get(cs.customerId);
      const isReturning =
        priorCustomerIds.has(cs.customerId) || cs.ordersCount > 1;
      return {
        customerId: cs.customerId,
        customerNumber: cust?.customer_number ?? '—',
        customerName: cust?.name ?? 'Walk-in / Customer',
        customerType: isReturning ? 'RETURNING' : 'NEW',
        ordersCount: cs.ordersCount,
        totalSpent: roundMoney(cs.totalSpent),
        creditBalance: roundMoney(Number(ca?.current_balance || 0)),
        lastPurchaseAt: cs.lastPurchaseAt,
      };
    })
    .sort((a, b) => Number(b.totalSpent) - Number(a.totalSpent));

  // =========================================================================
  // 6. EMPLOYEE & HR REPORT DATA
  // =========================================================================
  const [attendanceRows, payrollItems] = await Promise.all([
    trx.db
      .selectFrom('employee_attendance')
      .selectAll()
      .where('tenant_id', '=', trx.tenantId)
      .execute(),
    trx.db
      .selectFrom('payroll_items')
      .selectAll()
      .where('tenant_id', '=', trx.tenantId)
      .execute(),
  ]);

  const periodAttendance = attendanceRows.filter((a) => {
    const d = new Date(a.attendance_date).getTime();
    return d >= range.startTs.getTime() && d <= range.endTs.getTime();
  });

  let totalWorkingHours = 0;
  let totalPresentRecords = 0;
  const attendanceSummary = employees
    .filter((emp) => {
      if (
        allowedBranchIds !== null &&
        emp.primary_branch_id &&
        !allowedBranchIds.includes(emp.primary_branch_id)
      ) {
        return false;
      }
      if (query.employeeId && emp.id !== query.employeeId) return false;
      return true;
    })
    .map((emp) => {
      const empAtt = periodAttendance.filter((a) => a.employee_id === emp.id);
      let presentDays = 0;
      let lateDays = 0;
      let absentDays = 0;
      let leaveDays = 0;
      let hoursWorked = 0;

      for (const a of empAtt) {
        if (a.status === 'PRESENT') presentDays += 1;
        else if (a.status === 'LATE') {
          presentDays += 1;
          lateDays += 1;
        } else if (a.status === 'HALF_DAY') {
          presentDays += 0.5;
        } else if (a.status === 'ABSENT') {
          absentDays += 1;
        } else if (
          a.status === 'PAID_LEAVE' ||
          a.status === 'NO_PAY_LEAVE'
        ) {
          leaveDays += 1;
        }

        if (a.check_in_time && a.check_out_time) {
          const inMs = new Date(a.check_in_time).getTime();
          const outMs = new Date(a.check_out_time).getTime();
          if (outMs > inMs) {
            hoursWorked += (outMs - inMs) / 3600000;
          }
        } else if (a.status === 'PRESENT' || a.status === 'LATE') {
          hoursWorked += 8;
        } else if (a.status === 'HALF_DAY') {
          hoursWorked += 4;
        }
      }

      totalWorkingHours += hoursWorked;
      totalPresentRecords += presentDays;

      const empPayrollItems = payrollItems.filter((pi) =>
        currentPayrolls.some(
          (pr) => pr.id === pi.payroll_run_id && pi.employee_id === emp.id,
        ),
      );
      const overtimeHours = empPayrollItems.reduce(
        (acc, pi) => acc + Number(pi.overtime_hours || 0),
        0,
      );

      const salesStat = emp.linked_user_id
        ? byEmployeeMap.get(emp.linked_user_id)
        : undefined;

      return {
        employeeId: emp.id,
        employeeCode: emp.employee_code,
        employeeName: emp.display_name,
        designation: emp.designation,
        department: emp.department,
        employmentStatus: emp.employment_status,
        presentDays,
        lateDays,
        absentDays,
        leaveDays,
        totalHoursWorked: roundPct(hoursWorked),
        overtimeHours: roundPct(overtimeHours),
        ordersHandled: salesStat?.ordersCount ?? 0,
        netSales: roundMoney(salesStat?.netSales ?? 0),
      };
    });

  const totalPayrollGross = currentPayrolls.reduce(
    (acc, pr) => acc + Number(pr.total_gross_pay || 0),
    0,
  );
  const totalPayrollNet = currentPayrolls.reduce(
    (acc, pr) => acc + Number(pr.total_net_pay || 0),
    0,
  );
  const totalPayrollPaid = currentPayrolls.reduce(
    (acc, pr) => acc + Number(pr.total_paid_amount || 0),
    0,
  );
  const laborCostToSalesPct =
    currentFin.netSales > 0 ? (totalPayrollGross / currentFin.netSales) * 100 : 0;

  // =========================================================================
  // 7. FINANCIAL & EXPENSE REPORT DATA
  // =========================================================================
  const currentInvoiceIds = new Set(
    currentFin.winInvoices
      .filter((inv) => inv.status === 'COMPLETED')
      .map((inv) => inv.id),
  );
  const currentSalesPayments = allWindowPayments.filter(
    (p) => p.status === 'COMPLETED' && currentInvoiceIds.has(p.invoice_id),
  );

  const paymentMethodMap = new Map<
    string,
    { paymentMethod: string; transactionCount: number; totalAmount: number }
  >();
  let totalPosCollected = 0;

  for (const sp of currentSalesPayments) {
    const m = sp.payment_method;
    const amt = Number(sp.amount || 0);
    if (m !== 'CREDIT') {
      totalPosCollected += amt;
    }
    const entry = paymentMethodMap.get(m) ?? {
      paymentMethod: m,
      transactionCount: 0,
      totalAmount: 0,
    };
    entry.transactionCount += 1;
    entry.totalAmount += amt;
    paymentMethodMap.set(m, entry);
  }

  const totalPaymentVolume = Array.from(paymentMethodMap.values()).reduce(
    (acc, p) => acc + p.totalAmount,
    0,
  );
  const paymentMethods = Array.from(paymentMethodMap.values())
    .sort((a, b) => b.totalAmount - a.totalAmount)
    .map((p) => ({
      paymentMethod: p.paymentMethod,
      transactionCount: p.transactionCount,
      totalAmount: roundMoney(p.totalAmount),
      sharePct: roundPct(
        totalPaymentVolume > 0 ? (p.totalAmount / totalPaymentVolume) * 100 : 0,
      ),
    }));

  const [creditPayments, shifts, cashAdjustments] = await Promise.all([
    trx.db
      .selectFrom('customer_credit_payments')
      .selectAll()
      .where('tenant_id', '=', trx.tenantId)
      .where('status', '=', 'COMPLETED')
      .execute(),
    trx.db
      .selectFrom('pos_shifts')
      .selectAll()
      .where('tenant_id', '=', trx.tenantId)
      .where('opened_at', '>=', range.startTs)
      .where('opened_at', '<=', range.endTs)
      .orderBy('opened_at', 'desc')
      .execute(),
    trx.db
      .selectFrom('pos_cash_adjustments')
      .selectAll()
      .where('tenant_id', '=', trx.tenantId)
      .where('created_at', '>=', range.startTs)
      .where('created_at', '<=', range.endTs)
      .execute(),
  ]);

  const periodCreditCollections = creditPayments
    .filter((cp) => {
      if (
        allowedBranchIds !== null &&
        cp.branch_id &&
        !allowedBranchIds.includes(cp.branch_id)
      ) {
        return false;
      }
      const d = new Date(cp.payment_date || cp.created_at).getTime();
      return d >= range.startTs.getTime() && d <= range.endTs.getTime();
    })
    .reduce((acc, cp) => acc + Number(cp.amount || 0), 0);

  const shiftCashIn = cashAdjustments
    .filter((ca) => ca.adjustment_type === 'CASH_IN')
    .reduce((acc, ca) => acc + Number(ca.amount || 0), 0);
  const shiftCashOut = cashAdjustments
    .filter(
      (ca) =>
        ca.adjustment_type === 'CASH_OUT' || ca.adjustment_type === 'CASH_REFUND',
    )
    .reduce((acc, ca) => acc + Number(ca.amount || 0), 0);

  const paidExpensesOutflow = currentExpenses
    .filter((e) => e.status === 'PAID')
    .reduce((acc, e) => acc + Number(e.amount || 0), 0);

  const cashInflows =
    totalPosCollected + periodCreditCollections + shiftCashIn;
  const cashOutflows =
    paidExpensesOutflow +
    totalPayrollPaid +
    currentFin.totalRefunds +
    shiftCashOut;
  const netCashFlow = cashInflows - cashOutflows;

  const expByCatMap = new Map<
    string,
    {
      categoryId: string;
      categoryName: string;
      expenseCount: number;
      totalAmount: number;
      paidAmount: number;
      pendingAmount: number;
    }
  >();
  for (const e of currentExpenses) {
    if (e.status === 'REJECTED') continue;
    const catName = expCategoryMap.get(e.category_id) ?? 'Operating Expense';
    const entry = expByCatMap.get(e.category_id) ?? {
      categoryId: e.category_id,
      categoryName: catName,
      expenseCount: 0,
      totalAmount: 0,
      paidAmount: 0,
      pendingAmount: 0,
    };
    const amt = Number(e.amount || 0);
    entry.expenseCount += 1;
    entry.totalAmount += amt;
    if (e.status === 'PAID') entry.paidAmount += amt;
    else entry.pendingAmount += amt;
    expByCatMap.set(e.category_id, entry);
  }

  // =========================================================================
  // 8. AUDIT & OPERATIONAL REPORT DATA
  // =========================================================================
  const [registers, auditLogs, prodPriceHistory, batchPriceHistory] =
    await Promise.all([
      trx.db
        .selectFrom('pos_registers')
        .selectAll()
        .where('tenant_id', '=', trx.tenantId)
        .execute(),
      trx.db
        .selectFrom('audit_logs')
        .selectAll()
        .where('tenant_id', '=', trx.tenantId)
        .where('created_at', '>=', range.startTs)
        .where('created_at', '<=', range.endTs)
        .orderBy('created_at', 'desc')
        .limit(150)
        .execute(),
      trx.db
        .selectFrom('product_price_history')
        .selectAll()
        .where('tenant_id', '=', trx.tenantId)
        .where('created_at', '>=', range.startTs)
        .where('created_at', '<=', range.endTs)
        .orderBy('created_at', 'desc')
        .execute(),
      trx.db
        .selectFrom('batch_price_history')
        .selectAll()
        .where('tenant_id', '=', trx.tenantId)
        .where('created_at', '>=', range.startTs)
        .where('created_at', '<=', range.endTs)
        .orderBy('created_at', 'desc')
        .execute(),
    ]);

  const registerMap = new Map(registers.map((r) => [r.id, r]));

  let registerVarianceTotal = 0;
  const registerClosings = shifts
    .filter(
      (sh) =>
        allowedBranchIds === null || allowedBranchIds.includes(sh.branch_id),
    )
    .map((sh) => {
      const reg = registerMap.get(sh.register_id);
      const br = branchMap.get(sh.branch_id);
      const opener = userMap.get(sh.opened_by_user_id);
      const closer = sh.closed_by_user_id
        ? userMap.get(sh.closed_by_user_id)
        : null;
      const variance = Number(sh.cash_variance || 0);
      registerVarianceTotal += variance;

      return {
        shiftId: sh.id,
        registerName: reg?.name ?? 'Register',
        branchName: br?.name ?? 'Branch',
        openedByName: opener?.full_name ?? opener?.email ?? 'Cashier',
        closedByName: closer?.full_name ?? closer?.email ?? '—',
        openingFloat: roundMoney(Number(sh.opening_cash_float || 0)),
        expectedClosingCash: roundMoney(Number(sh.expected_closing_cash || 0)),
        countedClosingCash:
          sh.counted_closing_cash != null
            ? roundMoney(Number(sh.counted_closing_cash))
            : null,
        cashVariance: roundMoney(variance),
        status: sh.status,
        openedAt: new Date(sh.opened_at).toISOString(),
        closedAt: sh.closed_at ? new Date(sh.closed_at).toISOString() : null,
      };
    });

  const combinedPriceChanges = [
    ...prodPriceHistory.map((ph) => {
      const prod = productMap.get(ph.product_id);
      const actor = userMap.get(ph.actor_user_id);
      return {
        id: ph.id,
        createdAt: new Date(ph.created_at).toISOString(),
        productId: ph.product_id,
        sku: prod?.sku ?? '—',
        productName: prod?.name ?? 'Product',
        scope: ph.scope,
        previousPrice: roundMoney(Number(ph.previous_price || 0)),
        newPrice: roundMoney(Number(ph.new_price || 0)),
        costSnapshot: roundMoney(Number(ph.cost_snapshot || 0)),
        reason: ph.reason,
        actorName: actor?.full_name ?? actor?.email ?? 'User',
      };
    }),
    ...batchPriceHistory.map((bph) => {
      const prod = productMap.get(bph.product_id);
      const actor = userMap.get(bph.actor_user_id);
      return {
        id: bph.id,
        createdAt: new Date(bph.created_at).toISOString(),
        productId: bph.product_id,
        sku: prod?.sku ?? '—',
        productName: prod?.name ?? 'Product',
        scope: `BATCH (${bph.change_type})`,
        previousPrice: roundMoney(Number(bph.previous_price || 0)),
        newPrice: roundMoney(Number(bph.new_price || 0)),
        costSnapshot: roundMoney(Number(bph.cost_snapshot || 0)),
        reason: bph.reason,
        actorName: actor?.full_name ?? actor?.email ?? 'User',
      };
    }),
  ].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const voidedTransactions = currentFin.winInvoices
    .filter((inv) => inv.status === 'VOIDED')
    .map((inv) => {
      const br = branchMap.get(inv.branch_id);
      const cashier = userMap.get(inv.cashier_user_id);
      const voider = inv.voided_by_user_id
        ? userMap.get(inv.voided_by_user_id)
        : null;
      return {
        id: inv.id,
        invoiceNumber: inv.invoice_number,
        branchName: br?.name ?? 'Branch',
        cashierName: cashier?.full_name ?? cashier?.email ?? 'Cashier',
        voidedByName: voider?.full_name ?? voider?.email ?? 'Supervisor',
        grandTotal: roundMoney(Number(inv.grand_total || 0)),
        voidReason: inv.void_reason ?? '—',
        createdAt: new Date(inv.created_at).toISOString(),
        voidedAt: inv.voided_at ? new Date(inv.voided_at).toISOString() : null,
      };
    });

  const registerActivity = registers
    .filter(
      (reg) =>
        allowedBranchIds === null || allowedBranchIds.includes(reg.branch_id),
    )
    .map((reg) => {
      const br = branchMap.get(reg.branch_id);
      const regInvoices = currentFin.winInvoices.filter(
        (inv) => inv.register_id === reg.id,
      );
      const completed = regInvoices.filter((i) => i.status === 'COMPLETED');
      const voided = regInvoices.filter((i) => i.status === 'VOIDED');
      const regShifts = shifts.filter((s) => s.register_id === reg.id);
      const rev = completed.reduce(
        (acc, i) => acc + Number(i.grand_total || 0),
        0,
      );
      return {
        registerId: reg.id,
        registerCode: reg.code,
        registerName: reg.name,
        branchName: br?.name ?? 'Branch',
        shiftsCount: regShifts.length,
        completedSalesCount: completed.length,
        voidedSalesCount: voided.length,
        totalSalesRevenue: roundMoney(rev),
        isActive: reg.is_active,
      };
    });

  const costConfirmationStatus =
    currentFin.uncostedLineCount === 0
      ? ('CONFIRMED_ACTUAL' as const)
      : ('PARTIAL_UNCOSTED' as const);
  const costBasisNote =
    'Inventory valuation and COGS use Moving Average Cost (MAC) for standard/serialized items and FIFO cost layers for batch-tracked items. Gross Profit = Net Revenue − Confirmed COGS. Net Profit = Gross Profit − Approved Operating Expenses − Paid Payroll.';

  const kpisByCategory: Record<
    BusinessReportCategory,
    Array<{
      key: string;
      label: string;
      value: number;
      previousValue?: number;
      changePct?: number;
      formattedType: 'currency' | 'number' | 'percent';
      subtitle?: string;
    }>
  > = {
    SALES: [
      {
        key: 'net_sales',
        label: 'Net Sales Revenue',
        value: Number(roundMoney(currentFin.netSales)),
        previousValue: Number(roundMoney(prevFin.netSales)),
        changePct: computeDeltaPct(currentFin.netSales, prevFin.netSales),
        formattedType: 'currency',
      },
      {
        key: 'gross_sales',
        label: 'Gross Sales',
        value: Number(roundMoney(currentFin.grossSales)),
        previousValue: Number(roundMoney(prevFin.grossSales)),
        changePct: computeDeltaPct(currentFin.grossSales, prevFin.grossSales),
        formattedType: 'currency',
      },
      {
        key: 'completed_orders',
        label: 'Completed Orders',
        value: currentFin.completedOrders,
        previousValue: prevFin.completedOrders,
        changePct: computeDeltaPct(currentFin.completedOrders, prevFin.completedOrders),
        formattedType: 'number',
      },
      {
        key: 'aov',
        label: 'Average Order Value (AOV)',
        value: Number(roundMoney(currentFin.averageOrderValue)),
        previousValue: Number(roundMoney(prevFin.averageOrderValue)),
        changePct: computeDeltaPct(currentFin.averageOrderValue, prevFin.averageOrderValue),
        formattedType: 'currency',
      },
      {
        key: 'discounts_and_refunds',
        label: 'Discounts & Refunds',
        value: Number(roundMoney(currentFin.totalDiscounts + currentFin.totalRefunds)),
        previousValue: Number(roundMoney(prevFin.totalDiscounts + prevFin.totalRefunds)),
        changePct: computeDeltaPct(
          currentFin.totalDiscounts + currentFin.totalRefunds,
          prevFin.totalDiscounts + prevFin.totalRefunds,
        ),
        formattedType: 'currency',
      },
    ],
    INVENTORY: [
      {
        key: 'stock_valuation',
        label: 'Total Stock Valuation (MAC + FIFO)',
        value: Number(roundMoney(totalInventoryValuation)),
        formattedType: 'currency',
      },
      {
        key: 'stock_on_hand_units',
        label: 'Total Units On Hand',
        value: Number(roundMoney(totalOnHandUnits)),
        formattedType: 'number',
      },
      {
        key: 'low_and_out_of_stock',
        label: 'Low / Out of Stock SKUs',
        value: lowStockCount + outOfStockCount,
        formattedType: 'number',
        subtitle: `${lowStockCount} Low • ${outOfStockCount} Out`,
      },
      {
        key: 'inventory_turnover',
        label: 'Inventory Turnover Ratio',
        value: roundPct(overallTurnoverRatio),
        formattedType: 'number',
      },
    ],
    PROFITABILITY: [
      {
        key: 'net_revenue',
        label: 'Net Sales Revenue',
        value: Number(roundMoney(currentFin.netSales)),
        previousValue: Number(roundMoney(prevFin.netSales)),
        changePct: computeDeltaPct(currentFin.netSales, prevFin.netSales),
        formattedType: 'currency',
      },
      {
        key: 'confirmed_cogs',
        label: 'Confirmed COGS (MAC + FIFO)',
        value: Number(roundMoney(currentFin.netCogs)),
        previousValue: Number(roundMoney(prevFin.netCogs)),
        changePct: computeDeltaPct(currentFin.netCogs, prevFin.netCogs),
        formattedType: 'currency',
      },
      {
        key: 'gross_profit',
        label: 'Gross Profit',
        value: Number(roundMoney(currentFin.grossProfit)),
        previousValue: Number(roundMoney(prevFin.grossProfit)),
        changePct: computeDeltaPct(currentFin.grossProfit, prevFin.grossProfit),
        formattedType: 'currency',
      },
      {
        key: 'net_profit',
        label: 'Net Profit (After Expenses & Payroll)',
        value: Number(roundMoney(currentNetProfit)),
        previousValue: Number(roundMoney(prevNetProfit)),
        changePct: computeDeltaPct(currentNetProfit, prevNetProfit),
        formattedType: 'currency',
      },
      {
        key: 'gross_margin_pct',
        label: 'Gross Profit Margin %',
        value: roundPct(currentFin.grossMarginPct),
        formattedType: 'percent',
      },
      {
        key: 'net_margin_pct',
        label: 'Net Profit Margin %',
        value: roundPct(currentNetMarginPct),
        formattedType: 'percent',
      },
    ],
    PURCHASING: [
      {
        key: 'total_grn_value',
        label: 'Goods Received Value (GRN)',
        value: Number(roundMoney(totalGrnValue)),
        formattedType: 'currency',
      },
      {
        key: 'purchase_returns_value',
        label: 'Purchase Returns Value',
        value: Number(roundMoney(totalSupReturnValue)),
        formattedType: 'currency',
      },
      {
        key: 'net_purchases_value',
        label: 'Net Purchases',
        value: Number(roundMoney(Math.max(0, totalGrnValue - totalSupReturnValue))),
        formattedType: 'currency',
      },
      {
        key: 'outstanding_supplier_payables',
        label: 'Outstanding Supplier Payables',
        value: Number(roundMoney(outstandingPayablesEstimate)),
        formattedType: 'currency',
      },
    ],
    CUSTOMER_CREDIT: [
      {
        key: 'active_customers',
        label: 'Active Customers',
        value: allCustomers.filter((c) => c.status === 'ACTIVE').length,
        formattedType: 'number',
        subtitle: `${newCustomersInPeriod} New • ${returningCustomersInPeriod} Returning`,
      },
      {
        key: 'outstanding_credit',
        label: 'Outstanding Customer Credit (AR)',
        value: Number(roundMoney(totalOutstandingCredit)),
        formattedType: 'currency',
      },
      {
        key: 'overdue_balance',
        label: 'Overdue Credit Balance',
        value: Number(roundMoney(totalOverdueBalance)),
        formattedType: 'currency',
        subtitle: `${overdueAccountsCount} overdue account(s)`,
      },
    ],
    EMPLOYEE_HR: [
      {
        key: 'employee_sales',
        label: 'Total Employee Sales',
        value: Number(roundMoney(currentFin.netSales)),
        formattedType: 'currency',
      },
      {
        key: 'working_hours',
        label: 'Logged Working Hours',
        value: roundPct(totalWorkingHours),
        formattedType: 'number',
      },
      {
        key: 'payroll_gross',
        label: 'Total Payroll Gross',
        value: Number(roundMoney(totalPayrollGross)),
        formattedType: 'currency',
      },
      {
        key: 'labor_cost_vs_sales',
        label: 'Labor Cost vs Sales %',
        value: roundPct(laborCostToSalesPct),
        formattedType: 'percent',
      },
    ],
    FINANCIAL_EXPENSE: [
      {
        key: 'cash_inflows',
        label: 'Total Cash Inflows',
        value: Number(roundMoney(cashInflows)),
        formattedType: 'currency',
      },
      {
        key: 'cash_outflows',
        label: 'Total Cash Outflows',
        value: Number(roundMoney(cashOutflows)),
        formattedType: 'currency',
      },
      {
        key: 'net_cash_flow',
        label: 'Net Cash Flow',
        value: Number(roundMoney(netCashFlow)),
        formattedType: 'currency',
      },
      {
        key: 'accounts_receivable',
        label: 'Accounts Receivable (AR)',
        value: Number(roundMoney(totalOutstandingCredit)),
        formattedType: 'currency',
      },
      {
        key: 'accounts_payable',
        label: 'Accounts Payable (AP)',
        value: Number(roundMoney(outstandingPayablesEstimate)),
        formattedType: 'currency',
      },
      {
        key: 'tax_collected',
        label: 'Tax Collected',
        value: Number(roundMoney(currentFin.totalTax)),
        formattedType: 'currency',
      },
    ],
    AUDIT_OPERATIONAL: [
      {
        key: 'stock_adjustments_count',
        label: 'Stock Adjustments',
        value: stockAdjustments.length,
        formattedType: 'number',
      },
      {
        key: 'user_activity_count',
        label: 'User Activity Audit Logs',
        value: auditLogs.length,
        formattedType: 'number',
      },
      {
        key: 'price_changes_count',
        label: 'Price Change Events',
        value: combinedPriceChanges.length,
        formattedType: 'number',
      },
      {
        key: 'voided_transactions_count',
        label: 'Voided Transactions',
        value: voidedTransactions.length,
        formattedType: 'number',
      },
    ],
  };

  const chartsByCategory: Record<
    BusinessReportCategory,
    Array<{
      key: string;
      title: string;
      type: 'bar' | 'horizontal-bar' | 'donut';
      series: Array<{ label: string; value: number; secondaryValue?: number }>;
    }>
  > = {
    SALES: [
      {
        key: 'sales_trend',
        title: `Net Sales Trend (${granularity})`,
        type: 'bar',
        series: salesSeries.map((s) => ({
          label: s.period,
          value: Number(s.netSales || 0),
          secondaryValue: s.ordersCount,
        })),
      },
      {
        key: 'sales_by_category_chart',
        title: 'Sales by Category',
        type: 'horizontal-bar',
        series: salesByCategory.map((c) => ({
          label: c.categoryName,
          value: Number(c.netAmount || 0),
          secondaryValue: Number(c.qtySold || 0),
        })),
      },
    ],
    INVENTORY: [
      {
        key: 'top_stock_valuation',
        title: 'Top Stock Valuation by Product',
        type: 'horizontal-bar',
        series: stockOnHand.slice(0, 8).map((s) => ({
          label: s.productName,
          value: Number(s.totalValuation || 0),
          secondaryValue: Number(s.qtyOnHand || 0),
        })),
      },
    ],
    PROFITABILITY: [
      {
        key: 'product_profit_chart',
        title: 'Gross Profit by Product',
        type: 'horizontal-bar',
        series: salesByProduct.slice(0, 8).map((p) => ({
          label: p.productName,
          value: Number(p.grossProfit || 0),
          secondaryValue: Number(p.grossMarginPct || 0),
        })),
      },
      {
        key: 'branch_profit_chart',
        title: 'Gross Profit by Branch',
        type: 'horizontal-bar',
        series: salesByBranch.map((b) => ({
          label: b.branchName,
          value: Number(b.grossProfit || 0),
        })),
      },
    ],
    PURCHASING: [
      {
        key: 'supplier_purchases_chart',
        title: 'Purchases by Supplier',
        type: 'horizontal-bar',
        series: supplierByPurchaseList.map((s) => ({
          label: s.supplierName,
          value: Number(s.netPurchaseValue || 0),
        })),
      },
    ],
    CUSTOMER_CREDIT: [
      {
        key: 'top_customers_chart',
        title: 'Top Customers by Revenue',
        type: 'horizontal-bar',
        series: topCustomers.slice(0, 8).map((c) => ({
          label: c.customerName,
          value: Number(c.totalSpent || 0),
        })),
      },
    ],
    EMPLOYEE_HR: [
      {
        key: 'employee_sales_chart',
        title: 'Sales by Employee',
        type: 'horizontal-bar',
        series: salesByEmployee.map((e) => ({
          label: e.employeeName,
          value: Number(e.netSales || 0),
          secondaryValue: e.ordersCount,
        })),
      },
    ],
    FINANCIAL_EXPENSE: [
      {
        key: 'payment_methods_chart',
        title: 'Payment Method Breakdown',
        type: 'horizontal-bar',
        series: paymentMethods.map((pm) => ({
          label: pm.paymentMethod,
          value: Number(pm.totalAmount || 0),
          secondaryValue: pm.transactionCount,
        })),
      },
    ],
    AUDIT_OPERATIONAL: [
      {
        key: 'register_activity_chart',
        title: 'Register Sales Activity',
        type: 'horizontal-bar',
        series: registerActivity.map((r) => ({
          label: `${r.registerCode} (${r.branchName})`,
          value: Number(r.totalSalesRevenue || 0),
          secondaryValue: r.completedSalesCount,
        })),
      },
    ],
  };

  const tablesByCategory: Record<
    BusinessReportCategory,
    Array<{
      key: string;
      title: string;
      columns: Array<{
        key: string;
        label: string;
        format?: 'text' | 'number' | 'currency' | 'percent' | 'badge';
        align?: 'left' | 'right' | 'center';
      }>;
      rows: Array<Record<string, unknown>>;
    }>
  > = {
    SALES: [
      {
        key: 'sales_by_product',
        title: 'Sales by Product',
        columns: [
          { key: 'sku', label: 'SKU', format: 'text' },
          { key: 'productName', label: 'Product', format: 'text' },
          { key: 'categoryName', label: 'Category', format: 'text' },
          { key: 'qtySold', label: 'Qty Sold', format: 'number', align: 'right' },
          { key: 'grossSales', label: 'Gross Sales', format: 'currency', align: 'right' },
          { key: 'discountAmount', label: 'Discounts', format: 'currency', align: 'right' },
          { key: 'refundAmount', label: 'Refunds', format: 'currency', align: 'right' },
          { key: 'netSales', label: 'Net Sales', format: 'currency', align: 'right' },
        ],
        rows: salesByProduct.map((p) => ({
          ...p,
          drilldownType: 'PRODUCT_SALES',
          drilldownId: p.productId,
        })),
      },
      {
        key: 'sales_by_category',
        title: 'Sales by Category',
        columns: [
          { key: 'categoryName', label: 'Category', format: 'text' },
          { key: 'qtySold', label: 'Qty Sold', format: 'number', align: 'right' },
          { key: 'netSales', label: 'Net Sales', format: 'currency', align: 'right' },
        ],
        rows: salesByCategory.map((c) => ({
          ...c,
          drilldownType: 'CATEGORY_SALES',
          drilldownId: c.categoryId || 'uncategorized',
        })),
      },
      {
        key: 'sales_by_employee',
        title: 'Sales by Employee & Branch',
        columns: [
          { key: 'employeeName', label: 'Employee', format: 'text' },
          { key: 'ordersCount', label: 'Orders', format: 'number', align: 'right' },
          { key: 'netSales', label: 'Net Sales', format: 'currency', align: 'right' },
          { key: 'averageOrderValue', label: 'AOV', format: 'currency', align: 'right' },
        ],
        rows: salesByEmployee.map((e) => ({
          ...e,
          drilldownType: 'EMPLOYEE_SALES',
          drilldownId: e.userId,
        })),
      },
      {
        key: 'sales_by_branch',
        title: 'Sales by Branch',
        columns: [
          { key: 'branchName', label: 'Branch', format: 'text' },
          { key: 'ordersCount', label: 'Orders', format: 'number', align: 'right' },
          { key: 'netSales', label: 'Net Sales', format: 'currency', align: 'right' },
        ],
        rows: salesByBranch.map((b) => ({
          ...b,
          drilldownType: 'BRANCH_SALES',
          drilldownId: b.branchId,
        })),
      },
    ],
    INVENTORY: [
      {
        key: 'stock_on_hand',
        title: 'Stock Valuation & Stock on Hand (MAC + FIFO)',
        columns: [
          { key: 'sku', label: 'SKU', format: 'text' },
          { key: 'productName', label: 'Product', format: 'text' },
          { key: 'trackingMode', label: 'Costing Mode', format: 'badge' },
          { key: 'qtyOnHand', label: 'On Hand', format: 'number', align: 'right' },
          { key: 'unitCost', label: 'Unit Cost', format: 'currency', align: 'right' },
          { key: 'totalValuation', label: 'Total Valuation', format: 'currency', align: 'right' },
          { key: 'stockStatus', label: 'Status', format: 'badge' },
        ],
        rows: stockOnHand.map((s) => ({
          ...s,
          drilldownType: 'STOCK_MOVEMENTS',
          drilldownId: s.productId,
        })),
      },
      {
        key: 'low_and_out_of_stock',
        title: 'Low Stock & Out of Stock Items',
        columns: [
          { key: 'sku', label: 'SKU', format: 'text' },
          { key: 'productName', label: 'Product', format: 'text' },
          { key: 'qtyAvailable', label: 'Available', format: 'number', align: 'right' },
          { key: 'reorderPoint', label: 'Reorder Point', format: 'number', align: 'right' },
          { key: 'stockStatus', label: 'Alert', format: 'badge' },
        ],
        rows: lowAndOutOfStock,
      },
      {
        key: 'fast_and_slow_moving',
        title: 'Fast Moving, Slow Moving & Inventory Turnover',
        columns: [
          { key: 'sku', label: 'SKU', format: 'text' },
          { key: 'productName', label: 'Product', format: 'text' },
          { key: 'qtySoldInPeriod', label: 'Qty Sold', format: 'number', align: 'right' },
          { key: 'turnoverRatio', label: 'Turnover Ratio', format: 'number', align: 'right' },
          { key: 'velocityClass', label: 'Velocity', format: 'badge' },
        ],
        rows: movementVelocity,
      },
      {
        key: 'stock_adjustments',
        title: 'Stock Adjustments',
        columns: [
          { key: 'occurredAt', label: 'Timestamp', format: 'text' },
          { key: 'sku', label: 'SKU', format: 'text' },
          { key: 'productName', label: 'Product', format: 'text' },
          { key: 'movementType', label: 'Type', format: 'badge' },
          { key: 'qtyDelta', label: 'Qty Delta', format: 'number', align: 'right' },
          { key: 'totalCostDelta', label: 'Value Impact', format: 'currency', align: 'right' },
        ],
        rows: stockAdjustments,
      },
    ],
    PROFITABILITY: [
      {
        key: 'product_profitability',
        title: 'Product-wise Profitability (Confirmed MAC / FIFO COGS)',
        columns: [
          { key: 'sku', label: 'SKU', format: 'text' },
          { key: 'productName', label: 'Product', format: 'text' },
          { key: 'qtySold', label: 'Qty Sold', format: 'number', align: 'right' },
          { key: 'netSales', label: 'Net Revenue', format: 'currency', align: 'right' },
          { key: 'cogs', label: 'Confirmed COGS', format: 'currency', align: 'right' },
          { key: 'grossProfit', label: 'Gross Profit', format: 'currency', align: 'right' },
          { key: 'grossMarginPct', label: 'Margin %', format: 'percent', align: 'right' },
        ],
        rows: salesByProduct.map((p) => ({
          ...p,
          drilldownType: 'PRODUCT_SALES',
          drilldownId: p.productId,
        })),
      },
      {
        key: 'category_profitability',
        title: 'Category-wise Profitability',
        columns: [
          { key: 'categoryName', label: 'Category', format: 'text' },
          { key: 'netSales', label: 'Net Revenue', format: 'currency', align: 'right' },
          { key: 'cogs', label: 'Confirmed COGS', format: 'currency', align: 'right' },
          { key: 'grossProfit', label: 'Gross Profit', format: 'currency', align: 'right' },
          { key: 'grossMarginPct', label: 'Margin %', format: 'percent', align: 'right' },
        ],
        rows: salesByCategory.map((c) => ({
          ...c,
          drilldownType: 'CATEGORY_SALES',
          drilldownId: c.categoryId || 'uncategorized',
        })),
      },
      {
        key: 'branch_profitability',
        title: 'Branch-wise Profitability',
        columns: [
          { key: 'branchName', label: 'Branch', format: 'text' },
          { key: 'netSales', label: 'Net Revenue', format: 'currency', align: 'right' },
          { key: 'cogs', label: 'Confirmed COGS', format: 'currency', align: 'right' },
          { key: 'grossProfit', label: 'Gross Profit', format: 'currency', align: 'right' },
          { key: 'grossMarginPct', label: 'Margin %', format: 'percent', align: 'right' },
        ],
        rows: salesByBranch.map((b) => ({
          ...b,
          drilldownType: 'BRANCH_SALES',
          drilldownId: b.branchId,
        })),
      },
    ],
    PURCHASING: [
      {
        key: 'supplier_purchases',
        title: 'Supplier-wise Purchases & Outstanding Payables',
        columns: [
          { key: 'supplierName', label: 'Supplier', format: 'text' },
          { key: 'grnCount', label: 'GRNs', format: 'number', align: 'right' },
          { key: 'totalGrnAmount', label: 'Goods Received', format: 'currency', align: 'right' },
          { key: 'totalReturnAmount', label: 'Returns', format: 'currency', align: 'right' },
          { key: 'netPurchaseAmount', label: 'Net Purchases', format: 'currency', align: 'right' },
        ],
        rows: supplierByPurchaseList.map((s) => ({
          ...s,
          drilldownType: 'SUPPLIER_PURCHASES',
          drilldownId: s.supplierId,
        })),
      },
    ],
    CUSTOMER_CREDIT: [
      {
        key: 'top_customers',
        title: 'Top Customers & Purchase History',
        columns: [
          { key: 'customerName', label: 'Customer', format: 'text' },
          { key: 'ordersCount', label: 'Orders', format: 'number', align: 'right' },
          { key: 'totalSpent', label: 'Total Purchased', format: 'currency', align: 'right' },
          { key: 'outstandingBalance', label: 'Credit Balance', format: 'currency', align: 'right' },
        ],
        rows: topCustomers.map((c) => ({
          ...c,
          drilldownType: 'CUSTOMER_HISTORY',
          drilldownId: c.customerId,
        })),
      },
      {
        key: 'customer_credit_balances',
        title: 'Outstanding Customer Credit & Overdue Balances',
        columns: [
          { key: 'customerName', label: 'Customer', format: 'text' },
          { key: 'creditLimit', label: 'Credit Limit', format: 'currency', align: 'right' },
          { key: 'currentBalance', label: 'Outstanding', format: 'currency', align: 'right' },
          { key: 'overdueAmount', label: 'Overdue', format: 'currency', align: 'right' },
          { key: 'status', label: 'Status', format: 'badge' },
        ],
        rows: creditAccountRows,
      },
    ],
    EMPLOYEE_HR: [
      {
        key: 'employee_sales_performance',
        title: 'Employee Sales Performance',
        columns: [
          { key: 'employeeName', label: 'Employee', format: 'text' },
          { key: 'ordersCount', label: 'Orders', format: 'number', align: 'right' },
          { key: 'netSales', label: 'Net Sales', format: 'currency', align: 'right' },
          { key: 'averageOrderValue', label: 'AOV', format: 'currency', align: 'right' },
        ],
        rows: salesByEmployee.map((e) => ({
          ...e,
          drilldownType: 'EMPLOYEE_SALES',
          drilldownId: e.userId,
        })),
      },
      {
        key: 'attendance_summary',
        title: 'Attendance & Working Hours Summary',
        columns: [
          { key: 'employeeName', label: 'Employee', format: 'text' },
          { key: 'presentDays', label: 'Present Days', format: 'number', align: 'right' },
          { key: 'totalHours', label: 'Working Hours', format: 'number', align: 'right' },
        ],
        rows: attendanceSummary,
      },
    ],
    FINANCIAL_EXPENSE: [
      {
        key: 'payment_method_breakdown',
        title: 'Payment Method Breakdown',
        columns: [
          { key: 'paymentMethod', label: 'Payment Method', format: 'badge' },
          { key: 'transactionsCount', label: 'Transactions', format: 'number', align: 'right' },
          { key: 'totalAmount', label: 'Total Collected', format: 'currency', align: 'right' },
        ],
        rows: paymentMethods,
      },
      {
        key: 'cash_register_closing',
        title: 'Cash Register Closing & Variance Summary',
        columns: [
          { key: 'registerCode', label: 'Register', format: 'text' },
          { key: 'branchName', label: 'Branch', format: 'text' },
          { key: 'openingFloat', label: 'Opening Float', format: 'currency', align: 'right' },
          { key: 'expectedClosingCash', label: 'Expected Cash', format: 'currency', align: 'right' },
          { key: 'actualClosingCash', label: 'Declared Cash', format: 'currency', align: 'right' },
          { key: 'variance', label: 'Variance', format: 'currency', align: 'right' },
          { key: 'status', label: 'Status', format: 'badge' },
        ],
        rows: registerClosings,
      },
    ],
    AUDIT_OPERATIONAL: [
      {
        key: 'stock_adjustment_history',
        title: 'Stock Adjustment History',
        columns: [
          { key: 'occurredAt', label: 'Timestamp', format: 'text' },
          { key: 'sku', label: 'SKU', format: 'text' },
          { key: 'productName', label: 'Product', format: 'text' },
          { key: 'movementType', label: 'Movement Type', format: 'badge' },
          { key: 'qtyDelta', label: 'Qty Delta', format: 'number', align: 'right' },
        ],
        rows: stockAdjustments,
      },
      {
        key: 'price_change_history',
        title: 'Price Change History (Catalog & Batch Overrides)',
        columns: [
          { key: 'changedAt', label: 'Timestamp', format: 'text' },
          { key: 'sku', label: 'SKU', format: 'text' },
          { key: 'productName', label: 'Product', format: 'text' },
          { key: 'scope', label: 'Scope', format: 'badge' },
          { key: 'oldPrice', label: 'Old Price', format: 'currency', align: 'right' },
          { key: 'newPrice', label: 'New Price', format: 'currency', align: 'right' },
        ],
        rows: combinedPriceChanges,
      },
      {
        key: 'voided_transactions',
        title: 'Voided Transactions',
        columns: [
          { key: 'invoiceNumber', label: 'Invoice #', format: 'text' },
          { key: 'branchName', label: 'Branch', format: 'text' },
          { key: 'grandTotal', label: 'Voided Amount', format: 'currency', align: 'right' },
          { key: 'voidReason', label: 'Reason', format: 'text' },
        ],
        rows: voidedTransactions.map((v) => ({
          ...v,
          drilldownType: 'VOIDED_INVOICE',
          drilldownId: v.id,
        })),
      },
      {
        key: 'register_activity',
        title: 'Register Activity',
        columns: [
          { key: 'registerCode', label: 'Register', format: 'text' },
          { key: 'branchName', label: 'Branch', format: 'text' },
          { key: 'shiftsCount', label: 'Shifts', format: 'number', align: 'right' },
          { key: 'completedSalesCount', label: 'Completed Sales', format: 'number', align: 'right' },
          { key: 'totalSalesRevenue', label: 'Revenue', format: 'currency', align: 'right' },
        ],
        rows: registerActivity,
      },
    ],
  };

  return {
    tenantId: trx.tenantId,
    tenantName: tenantRow?.legal_name ?? 'NexStock Organization',
    currencyCode: tenantRow?.base_currency ?? 'USD',
    category,
    granularity,
    generatedAt: new Date().toISOString(),
    filters: {
      startDate: range.startDateStr,
      endDate: range.endDateStr,
      previousStartDate: range.prevStartDateStr,
      previousEndDate: range.prevEndDateStr,
      granularity,
      branchId: query.branchId ?? null,
      warehouseId: query.warehouseId ?? null,
      employeeId: query.employeeId ?? null,
      productId: query.productId ?? null,
    },
    costBasisNote,
    costConfirmationStatus,
    kpis: kpisByCategory[category] ?? kpisByCategory.SALES,
    charts: chartsByCategory[category] ?? [],
    tables: tablesByCategory[category] ?? [],
    period: {
      startDate: range.startDateStr,
      endDate: range.endDateStr,
      previousStartDate: range.prevStartDateStr,
      previousEndDate: range.prevEndDateStr,
      daysInPeriod: range.daysInPeriod,
    },
    sales: {
      summary: {
        totalOrders: currentFin.completedOrders,
        grossSales: roundMoney(currentFin.grossSales),
        totalDiscounts: roundMoney(currentFin.totalDiscounts),
        totalRefunds: roundMoney(currentFin.totalRefunds),
        totalReturnsCount: currentFin.returnsCount,
        totalTax: roundMoney(currentFin.totalTax),
        netSales: roundMoney(currentFin.netSales),
        averageOrderValue: roundMoney(currentFin.averageOrderValue),
        voidedCount: currentFin.voidedOrders,
        voidedAmount: roundMoney(currentFin.voidedAmount),
      },
      comparison: {
        previousOrders: prevFin.completedOrders,
        ordersDeltaPct: computeDeltaPct(
          currentFin.completedOrders,
          prevFin.completedOrders,
        ),
        previousNetSales: roundMoney(prevFin.netSales),
        netSalesDeltaPct: computeDeltaPct(
          currentFin.netSales,
          prevFin.netSales,
        ),
        previousAov: roundMoney(prevFin.averageOrderValue),
        aovDeltaPct: computeDeltaPct(
          currentFin.averageOrderValue,
          prevFin.averageOrderValue,
        ),
      },
      series: salesSeries,
      byProduct: salesByProduct,
      byCategory: salesByCategory,
      byEmployee: salesByEmployee,
      byBranch: salesByBranch,
      returnsAndDiscounts: currentFin.winReturns.map((r) => {
        const inv = allWindowInvoices.find((i) => i.id === r.invoice_id);
        const br = branchMap.get(r.branch_id);
        return {
          id: r.id,
          returnNumber: r.return_number,
          invoiceNumber: inv?.invoice_number ?? '—',
          branchName: br?.name ?? 'Branch',
          reason: r.reason,
          refundMethod: r.refund_method,
          totalRefundAmount: roundMoney(Number(r.total_refund_amount || 0)),
          createdAt: new Date(r.created_at).toISOString(),
        };
      }),
    },
    inventory: {
      summary: {
        totalSkus: stockOnHand.length,
        totalValuation: roundMoney(totalInventoryValuation),
        totalOnHandUnits: roundMoney(totalOnHandUnits),
        lowStockCount,
        outOfStockCount,
        fastMovingCount,
        slowMovingCount,
        inventoryTurnoverRatio: roundPct(overallTurnoverRatio),
        positiveAdjustmentsValue: roundMoney(positiveAdjustmentsValue),
        negativeAdjustmentsValue: roundMoney(negativeAdjustmentsValue),
      },
      stockOnHand,
      lowAndOutOfStock,
      movementVelocity,
      stockAdjustments,
    },
    profitability: {
      summary: {
        grossSalesRevenue: roundMoney(currentFin.grossSales),
        salesDiscounts: roundMoney(currentFin.totalDiscounts),
        salesReturnsRefunds: roundMoney(currentFin.totalRefunds),
        netSalesRevenue: roundMoney(currentFin.netSales),
        confirmedCogs: roundMoney(currentFin.netCogs),
        grossProfit: roundMoney(currentFin.grossProfit),
        grossMarginPct: roundPct(currentFin.grossMarginPct),
        operatingExpenses: roundMoney(currentApprovedExpenses),
        payrollExpenses: roundMoney(currentPayrollExpense),
        netProfit: roundMoney(currentNetProfit),
        netMarginPct: roundPct(currentNetMarginPct),
        costConfirmationStatus:
          currentFin.uncostedLineCount === 0
            ? 'CONFIRMED_ACTUAL'
            : 'PARTIAL_UNCOSTED',
        uncostedLineCount: currentFin.uncostedLineCount,
      },
      comparison: {
        previousGrossProfit: roundMoney(prevFin.grossProfit),
        grossProfitDeltaPct: computeDeltaPct(
          currentFin.grossProfit,
          prevFin.grossProfit,
        ),
        previousNetProfit: roundMoney(prevNetProfit),
        netProfitDeltaPct: computeDeltaPct(currentNetProfit, prevNetProfit),
        previousCogs: roundMoney(prevFin.netCogs),
        cogsDeltaPct: computeDeltaPct(currentFin.netCogs, prevFin.netCogs),
      },
      byProduct: salesByProduct,
      byCategory: salesByCategory,
      byBranch: salesByBranch,
    },
    purchasing: {
      summary: {
        totalPurchaseOrders: purchaseOrders.filter(
          (p) => p.status !== 'CANCELLED',
        ).length,
        totalPoValue: roundMoney(totalPoValue),
        totalGoodsReceivedCount: goodsReceipts.filter(
          (g) => g.status !== 'CANCELLED',
        ).length,
        totalGrnValue: roundMoney(totalGrnValue),
        totalSupplierReturnsCount: supplierReturns.length,
        totalSupplierReturnsValue: roundMoney(totalSupReturnValue),
        netPurchasesValue: roundMoney(
          Math.max(0, totalGrnValue - totalSupReturnValue),
        ),
        outstandingPayablesEstimate: roundMoney(outstandingPayablesEstimate),
      },
      bySupplier: supplierByPurchaseList,
      goodsReceipts: goodsReceipts.map((g) => ({
        id: g.id,
        grnNumber: g.grn_number,
        supplierName: supplierMap.get(g.supplier_id)?.business_name ?? 'Supplier',
        branchName: branchMap.get(g.branch_id)?.name ?? 'Branch',
        warehouseName: warehouseMap.get(g.warehouse_id)?.name ?? 'Warehouse',
        totalCost: roundMoney(Number(g.total_cost || 0)),
        status: g.status,
        receivedAt: new Date(g.received_at).toISOString(),
      })),
      purchaseReturns: supplierReturns.map((sr) => {
        const prod = productMap.get(sr.product_id);
        return {
          id: sr.id,
          returnNumber: sr.return_number,
          supplierName:
            supplierMap.get(sr.supplier_id)?.business_name ?? 'Supplier',
          sku: prod?.sku ?? '—',
          productName: prod?.name ?? 'Product',
          returnQty: roundMoney(Number(sr.return_qty || 0)),
          returnUom: sr.return_uom,
          totalCost: roundMoney(Number(sr.total_cost || 0)),
          reason: sr.reason,
          createdAt: new Date(sr.created_at).toISOString(),
        };
      }),
    },
    customerCredit: {
      summary: {
        totalCustomers: allCustomers.filter((c) => c.status === 'ACTIVE').length,
        newCustomersInPeriod,
        returningCustomersInPeriod,
        totalOutstandingCredit: roundMoney(totalOutstandingCredit),
        totalOverdueBalance: roundMoney(totalOverdueBalance),
        overdueAccountsCount,
      },
      topCustomers,
      creditAccounts: creditAccountRows,
      purchaseHistory: currentFin.winInvoices
        .filter((inv) => inv.status === 'COMPLETED' && inv.customer_id)
        .slice(0, 100)
        .map((inv) => ({
          invoiceId: inv.id,
          invoiceNumber: inv.invoice_number,
          customerId: inv.customer_id!,
          customerName:
            customerMap.get(inv.customer_id!)?.name ??
            inv.customer_name ??
            'Customer',
          branchName: branchMap.get(inv.branch_id)?.name ?? 'Branch',
          grandTotal: roundMoney(Number(inv.grand_total || 0)),
          createdAt: new Date(inv.created_at).toISOString(),
        })),
    },
    employeeHr: {
      summary: {
        activeEmployeesCount: employees.filter(
          (e) =>
            e.employment_status === 'ACTIVE' ||
            e.employment_status === 'PROBATION',
        ).length,
        totalEmployeeSales: roundMoney(currentFin.netSales),
        totalWorkingHours: roundPct(totalWorkingHours),
        presentRecordsCount: totalPresentRecords,
        totalPayrollGross: roundMoney(totalPayrollGross),
        totalPayrollNet: roundMoney(totalPayrollNet),
        totalPayrollPaid: roundMoney(totalPayrollPaid),
        laborCostToSalesPct: roundPct(laborCostToSalesPct),
      },
      salesPerformance: salesByEmployee,
      attendanceSummary,
      payrollSummary: currentPayrolls.map((pr) => ({
        runId: pr.id,
        runNumber: pr.run_number,
        frequency: pr.frequency,
        periodStart: String(pr.period_start).slice(0, 10),
        periodEnd: String(pr.period_end).slice(0, 10),
        status: pr.status,
        employeeCount: pr.employee_count,
        totalGrossPay: roundMoney(Number(pr.total_gross_pay || 0)),
        totalDeductions: roundMoney(Number(pr.total_deductions || 0)),
        totalNetPay: roundMoney(Number(pr.total_net_pay || 0)),
        totalPaidAmount: roundMoney(Number(pr.total_paid_amount || 0)),
      })),
    },
    financialExpense: {
      summary: {
        cashInflows: roundMoney(cashInflows),
        cashOutflows: roundMoney(cashOutflows),
        netCashFlow: roundMoney(netCashFlow),
        posSalesCollected: roundMoney(totalPosCollected),
        creditCollections: roundMoney(periodCreditCollections),
        accountsReceivable: roundMoney(totalOutstandingCredit),
        accountsPayable: roundMoney(outstandingPayablesEstimate),
        totalExpensesApprovedPaid: roundMoney(currentApprovedExpenses),
        totalTaxCollected: roundMoney(currentFin.totalTax),
        registerVarianceTotal: roundMoney(registerVarianceTotal),
      },
      comparison: {
        previousExpenses: roundMoney(prevApprovedExpenses),
        expensesDeltaPct: computeDeltaPct(
          currentApprovedExpenses,
          prevApprovedExpenses,
        ),
      },
      paymentMethods,
      registerClosings,
      expenseByCategory: Array.from(expByCatMap.values()).map((ec) => ({
        categoryId: ec.categoryId,
        categoryName: ec.categoryName,
        expenseCount: ec.expenseCount,
        totalAmount: roundMoney(ec.totalAmount),
        paidAmount: roundMoney(ec.paidAmount),
        pendingAmount: roundMoney(ec.pendingAmount),
      })),
      expensesList: currentExpenses.map((e) => ({
        id: e.id,
        referenceNumber: e.reference_number,
        title: e.title,
        categoryName: expCategoryMap.get(e.category_id) ?? 'Expense',
        vendorPayee: e.vendor_payee ?? '—',
        amount: roundMoney(Number(e.amount || 0)),
        paymentMethod: e.payment_method,
        status: e.status,
        expenseDate: String(e.expense_date).slice(0, 10),
      })),
      taxSummary: {
        taxableSalesAmount: roundMoney(currentFin.netSales),
        taxCollectedAmount: roundMoney(currentFin.totalTax),
        netTaxPayable: roundMoney(currentFin.totalTax),
      },
    },
    auditOperational: {
      summary: {
        stockAdjustmentsCount: stockAdjustments.length,
        auditEventsCount: auditLogs.length,
        priceChangesCount: combinedPriceChanges.length,
        voidedTransactionsCount: voidedTransactions.length,
        voidedTransactionsAmount: roundMoney(currentFin.voidedAmount),
        activeRegistersCount: registerActivity.filter((r) => r.isActive).length,
      },
      stockAdjustments,
      userActivityLogs: auditLogs.map((al) => {
        const actor = userMap.get(al.actor_user_id);
        return {
          id: al.id,
          createdAt: new Date(al.created_at).toISOString(),
          actorUserId: al.actor_user_id,
          actorName: actor?.full_name ?? actor?.email ?? 'User',
          actorEmail: actor?.email ?? '—',
          action: al.action,
          resourceType: al.resource_type,
          resourceId: al.resource_id,
          traceId: al.trace_id,
        };
      }),
      priceChanges: combinedPriceChanges,
      voidedTransactions,
      registerActivity,
    },
  };
}

export async function getBusinessReportDrilldown(
  trx: TenantTransactionContext,
  query: BusinessReportDrilldownQuery,
) {
  const authCtx = await resolveMemberAuthorizationContext(trx);
  await assertSubscriptionEntitlement(trx, { requireWriteAccess: false });

  const hasAnyReportPerm =
    authCtx.roleCodes.includes('TENANT_OWNER') ||
    authCtx.roleCodes.includes('ORG_ADMIN') ||
    authCtx.permissions.has('rep:report:view') ||
    authCtx.permissions.has('inv:costing:read') ||
    authCtx.permissions.has('pur:po:read') ||
    authCtx.permissions.has('crm:report:read') ||
    authCtx.permissions.has('exp:report:view');

  if (!hasAnyReportPerm) {
    throw new AppError({
      statusCode: 403,
      errorCode: 'IAM_PERMISSION_DENIED',
      title: 'Permission Denied',
      detail: 'Member lacks required permission to drill down into report source transactions.',
    });
  }

  const { allowedBranchIds, allowedWarehouseIds } = resolveScopedLocationFilters(
    authCtx,
    query.branchId,
    query.warehouseId,
  );
  const range = resolveDateRange(query.startDate, query.endDate);
  const rawType = query.drilldownType;
  const normalizedType =
    rawType === 'PRODUCT'
      ? 'PRODUCT_SALES'
      : rawType === 'CATEGORY'
        ? 'CATEGORY_SALES'
        : rawType === 'BRANCH'
          ? 'BRANCH_SALES'
          : rawType === 'EMPLOYEE'
            ? 'EMPLOYEE_SALES'
            : rawType === 'SUPPLIER'
              ? 'SUPPLIER_PURCHASES'
              : rawType === 'CUSTOMER'
                ? 'CUSTOMER_HISTORY'
                : rawType;

  if (
    normalizedType === 'PRODUCT_SALES' ||
    normalizedType === 'CATEGORY_SALES' ||
    normalizedType === 'BRANCH_SALES' ||
    normalizedType === 'EMPLOYEE_SALES' ||
    normalizedType === 'VOIDED_INVOICE' ||
    normalizedType === 'CUSTOMER_HISTORY'
  ) {
    let invQuery = trx.db
      .selectFrom('sales_invoices')
      .selectAll()
      .where('tenant_id', '=', trx.tenantId)
      .where('created_at', '>=', range.startTs)
      .where('created_at', '<=', range.endTs)
      .orderBy('created_at', 'desc')
      .limit(100);

    if (allowedBranchIds !== null) {
      invQuery =
        allowedBranchIds.length > 0
          ? invQuery.where('branch_id', 'in', allowedBranchIds)
          : invQuery.where('branch_id', '=', '__none__');
    }
    if (normalizedType === 'BRANCH_SALES' && query.targetId) {
      invQuery = invQuery.where('branch_id', '=', query.targetId);
    }
    if (normalizedType === 'EMPLOYEE_SALES' && query.targetId) {
      invQuery = invQuery.where('cashier_user_id', '=', query.targetId);
    }
    if (normalizedType === 'CUSTOMER_HISTORY' && query.targetId) {
      invQuery = invQuery.where('customer_id', '=', query.targetId);
    }
    if (normalizedType === 'VOIDED_INVOICE') {
      invQuery = invQuery.where('status', '=', 'VOIDED');
      if (query.targetId) invQuery = invQuery.where('id', '=', query.targetId);
    } else {
      invQuery = invQuery.where('status', '=', 'COMPLETED');
    }

    const invoices = await invQuery.execute();
    const invIds = invoices.map((i) => i.id);
    const lines =
      invIds.length > 0
        ? await trx.db
            .selectFrom('sales_invoice_lines')
            .selectAll()
            .where('tenant_id', '=', trx.tenantId)
            .where('invoice_id', 'in', invIds)
            .execute()
        : [];

    let productsMap = new Map<string, { category_id: string | null }>();
    if (normalizedType === 'CATEGORY_SALES') {
      const prods = await trx.db
        .selectFrom('products')
        .select(['id', 'category_id'])
        .where('tenant_id', '=', trx.tenantId)
        .execute();
      productsMap = new Map(prods.map((p) => [p.id, p]));
    }

    const records = [];
    for (const inv of invoices) {
      const invLines = lines.filter((l) => {
        if (l.invoice_id !== inv.id) return false;
        if (
          normalizedType === 'PRODUCT_SALES' &&
          query.targetId &&
          l.product_id !== query.targetId
        ) {
          return false;
        }
        if (normalizedType === 'CATEGORY_SALES' && query.targetId) {
          const catId =
            productsMap.get(l.product_id)?.category_id ?? 'uncategorized';
          if (catId !== query.targetId) return false;
        }
        return true;
      });

      if (
        (normalizedType === 'PRODUCT_SALES' ||
          normalizedType === 'CATEGORY_SALES') &&
        invLines.length === 0
      ) {
        continue;
      }

      records.push({
        id: inv.id,
        referenceNumber: inv.invoice_number,
        type: inv.status === 'VOIDED' ? 'VOIDED_SALE' : 'POS_SALE',
        occurredAt: new Date(inv.created_at).toISOString(),
        status: inv.status,
        amount: roundMoney(
          normalizedType === 'PRODUCT_SALES' ||
            normalizedType === 'CATEGORY_SALES'
            ? invLines.reduce((acc, l) => acc + Number(l.line_total || 0), 0)
            : Number(inv.grand_total || 0),
        ),
        costAmount: roundMoney(
          invLines.reduce(
            (acc, l) =>
              acc +
              Number(l.normalized_base_qty ?? l.quantity ?? 0) *
                Number(l.unit_cost_snapshot ?? 0),
            0,
          ),
        ),
        details: invLines
          .map(
            (l) =>
              `${l.sku} (${l.product_name}) × ${Number(l.quantity)} ${l.uom_code}`,
          )
          .join(', '),
      });
    }

    return {
      drilldownType: query.drilldownType,
      targetId: query.targetId ?? null,
      records,
      rows: records,
    };
  }

  if (normalizedType === 'STOCK_MOVEMENTS') {
    let movQuery = trx.db
      .selectFrom('stock_ledger_entries')
      .selectAll()
      .where('tenant_id', '=', trx.tenantId)
      .where('occurred_at', '>=', range.startTs)
      .where('occurred_at', '<=', range.endTs)
      .orderBy('occurred_at', 'desc')
      .limit(100);

    if (allowedWarehouseIds !== null) {
      movQuery =
        allowedWarehouseIds.length > 0
          ? movQuery.where('warehouse_id', 'in', allowedWarehouseIds)
          : movQuery.where('warehouse_id', '=', '__none__');
    }
    if (query.targetId) {
      movQuery = movQuery.where('product_id', '=', query.targetId);
    }

    const entries = await movQuery.execute();
    const movRecords = entries.map((e) => ({
      id: e.id,
      referenceNumber: `${e.movement_type} (${e.entry_source})`,
      type: e.movement_type,
      occurredAt: new Date(e.occurred_at).toISOString(),
      status: 'POSTED',
      amount: roundMoney(Number(e.total_cost_delta || 0)),
      costAmount: roundMoney(Number(e.unit_cost || 0)),
      details: `Qty Delta: ${Number(e.qty_delta)} ${e.uom_code} | Balance After: ${Number(e.balance_after)}${e.reason ? ` | ${e.reason}` : ''}`,
    }));
    return {
      drilldownType: query.drilldownType,
      targetId: query.targetId ?? null,
      records: movRecords,
      rows: movRecords,
    };
  }

  if (normalizedType === 'SUPPLIER_PURCHASES') {
    let grnQ = trx.db
      .selectFrom('goods_receipts')
      .selectAll()
      .where('tenant_id', '=', trx.tenantId)
      .where('received_at', '>=', range.startTs)
      .where('received_at', '<=', range.endTs)
      .orderBy('received_at', 'desc')
      .limit(100);

    if (query.targetId) {
      grnQ = grnQ.where('supplier_id', '=', query.targetId);
    }
    const grns = await grnQ.execute();
    const grnRecords = grns.map((g) => ({
      id: g.id,
      referenceNumber: g.grn_number,
      type: 'GOODS_RECEIPT',
      occurredAt: new Date(g.received_at).toISOString(),
      status: g.status,
      amount: roundMoney(Number(g.total_cost || 0)),
      costAmount: roundMoney(Number(g.total_cost || 0)),
      details: g.notes ?? 'Goods Receipt Posted',
    }));
    return {
      drilldownType: query.drilldownType,
      targetId: query.targetId ?? null,
      records: grnRecords,
      rows: grnRecords,
    };
  }

  // EXPENSE_CATEGORY
  let expQ = trx.db
    .selectFrom('expenses')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .orderBy('created_at', 'desc')
    .limit(100);
  if (query.targetId) {
    expQ = expQ.where('category_id', '=', query.targetId);
  }
  const exps = await expQ.execute();
  const expRecords = exps.map((e) => ({
    id: e.id,
    referenceNumber: e.reference_number,
    type: 'EXPENSE',
    occurredAt: new Date(e.expense_date || e.created_at).toISOString(),
    status: e.status,
    amount: roundMoney(Number(e.amount || 0)),
    costAmount: roundMoney(Number(e.amount || 0)),
    details: `${e.title}${e.vendor_payee ? ` — ${e.vendor_payee}` : ''}`,
  }));
  return {
    drilldownType: query.drilldownType,
    targetId: query.targetId ?? null,
    records: expRecords,
    rows: expRecords,
  };
}

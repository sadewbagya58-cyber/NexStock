import {
  type ClosePosShiftRequest,
  type CreatePosRegisterRequest,
  type CreatePosSaleRequest,
  type CreatePosShiftAdjustmentRequest,
  type LineEntrySource,
  type ListPosRegistersQuery,
  type ListPosShiftsQuery,
  type ListSalesQuery,
  type MeasurementCategory,
  type OpenPosShiftRequest,
  type PosProductItemResponse,
  type PosProductSearchQuery,
  type PosRegisterSummaryResponse,
  type PosShiftResponse,
  type ProductQtyMode,
  type ProductUnitConversionResponse,
  type ReceiptResponse,
  type SalesInvoiceResponse,
  type SalesSummaryQuery,
  type SalesSummaryResponse,
  type TrackingMode,
  type UpdatePosRegisterRequest,
  type ValuationMethod,
  type VoidSaleRequest,
} from '@nexstock/contracts';
import { sql } from 'kysely';
import {
  Money,
  Quantity,
  UomConversionError,
  calculateLinePricingAndTax,
  computeProportionateUnitPriceAndTotal,
  convertQuantityBetweenUoms,
  resolveEffectiveBatchPrice,
  validateDiscountAgainstPolicy,
} from '@nexstock/domain-core';
import { resolveBranchEffectivePriceConfig } from '../../cat/index.js';
import {
  assertAuthorized,
  resolveMemberAuthorizationContext,
} from '../../iam/index.js';
import { postStockMovement, selectFefoBatches } from '../../inv/index.js';
import {
  AppError,
  type TenantTransactionContext,
  appendAuditLog,
  enqueueOutboxEvent,
  generateUuidV7,
  realtimeEventHub,
} from '../../shared/index.js';
import { assertSubscriptionEntitlement } from '../../sub/index.js';
import { formatReceiptData } from '../domain/receipt-formatter.js';

// ============================================================================
// 1. POS REGISTERS
// ============================================================================

export async function listAuthorizedRegisters(
  trx: TenantTransactionContext,
  query: ListPosRegistersQuery,
): Promise<PosRegisterSummaryResponse[]> {
  await assertAuthorized(trx, {
    permission: 'pos:register:read',
    branchId: query.branchId,
  });

  let dbQuery = trx.db
    .selectFrom('pos_registers')
    .select(['id', 'branch_id', 'warehouse_id', 'code', 'name', 'is_active'])
    .where('tenant_id', '=', trx.tenantId);

  if (query.branchId) {
    dbQuery = dbQuery.where('branch_id', '=', query.branchId);
  }

  const rows = await dbQuery.orderBy('code', 'asc').execute();

  return rows.map((r) => ({
    id: r.id,
    branchId: r.branch_id,
    warehouseId: r.warehouse_id,
    code: r.code,
    name: r.name,
    isActive: r.is_active,
  }));
}

export async function createPosRegister(
  trx: TenantTransactionContext,
  input: CreatePosRegisterRequest,
): Promise<PosRegisterSummaryResponse> {
  await assertAuthorized(trx, {
    permission: 'org:register:manage',
    branchId: input.branchId,
  });

  await assertSubscriptionEntitlement(trx, { requireWriteAccess: true });

  const subRow = await trx.db
    .selectFrom('tenant_subscriptions')
    .innerJoin('subscription_plans', 'subscription_plans.id', 'tenant_subscriptions.plan_id')
    .select(['subscription_plans.max_registers as max_registers'])
    .where('tenant_subscriptions.tenant_id', '=', trx.tenantId)
    .executeTakeFirst();

  if (subRow && subRow.max_registers !== null) {
    const countRow = await trx.db
      .selectFrom('pos_registers')
      .select(sql<number>`count(*)::int`.as('count'))
      .where('tenant_id', '=', trx.tenantId)
      .executeTakeFirst();
    const currentCount = Number(countRow?.count ?? 0);
    if (currentCount >= Number(subRow.max_registers)) {
      throw new AppError({
        statusCode: 403,
        errorCode: 'SUB_PLAN_LIMIT_REACHED',
        title: 'Register Limit Reached',
        detail: `Your organization has reached the maximum register limit (${subRow.max_registers}) for your subscription plan.`,
      });
    }
  }

  const normalizedCode = input.code.trim().toUpperCase();
  const duplicate = await trx.db
    .selectFrom('pos_registers')
    .select(['id'])
    .where('tenant_id', '=', trx.tenantId)
    .where('code', '=', normalizedCode)
    .executeTakeFirst();

  if (duplicate) {
    throw new AppError({
      statusCode: 409,
      errorCode: 'POS_REGISTER_CODE_EXISTS',
      title: 'Register Code Already Exists',
      detail: `A POS register with code "${normalizedCode}" already exists in this organization.`,
    });
  }

  const branch = await trx.db
    .selectFrom('branches')
    .select(['id', 'default_warehouse_id'])
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', input.branchId)
    .executeTakeFirst();

  if (!branch) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'ORG_BRANCH_NOT_FOUND',
      title: 'Branch Not Found',
      detail: `Branch "${input.branchId}" does not exist.`,
    });
  }

  const warehouseId = input.warehouseId ?? branch.default_warehouse_id;
  if (!warehouseId) {
    throw new AppError({
      statusCode: 400,
      errorCode: 'ERR_VALIDATION_FAILED',
      title: 'Warehouse Required',
      detail: 'An assigned warehouse is required for POS register inventory deduction.',
    });
  }

  const newId = generateUuidV7();
  const inserted = await trx.db
    .insertInto('pos_registers')
    .values({
      id: newId,
      tenant_id: trx.tenantId,
      branch_id: input.branchId,
      warehouse_id: warehouseId,
      code: normalizedCode,
      name: input.name.trim(),
      is_active: input.isActive ?? true,
      created_at: new Date(),
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  await appendAuditLog(trx, {
    action: 'pos:register:create',
    resourceType: 'pos_registers',
    resourceId: newId,
    metadata: {
      code: inserted.code,
      name: inserted.name,
      branchId: inserted.branch_id,
      warehouseId: inserted.warehouse_id,
    },
  });

  return {
    id: inserted.id,
    branchId: inserted.branch_id,
    warehouseId: inserted.warehouse_id,
    code: inserted.code,
    name: inserted.name,
    isActive: inserted.is_active,
  };
}

// ============================================================================
// 2. POS SHIFTS / CASHIER SESSIONS
// ============================================================================

export async function openPosShift(
  trx: TenantTransactionContext,
  input: OpenPosShiftRequest,
): Promise<PosShiftResponse> {
  const register = await trx.db
    .selectFrom('pos_registers')
    .select(['id', 'branch_id', 'warehouse_id', 'code', 'name', 'is_active'])
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', input.registerId)
    .executeTakeFirst();

  if (!register) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'POS_REGISTER_NOT_FOUND',
      title: 'POS Register Not Found',
      detail: `POS Register "${input.registerId}" was not found in tenant "${trx.tenantId}".`,
    });
  }

  if (!register.is_active) {
    throw new AppError({
      statusCode: 409,
      errorCode: 'POS_REGISTER_INACTIVE',
      title: 'POS Register Inactive',
      detail: `POS Register "${register.code}" is disabled.`,
    });
  }

  await assertAuthorized(trx, {
    permission: 'pos:shift:open',
    branchId: register.branch_id,
    warehouseId: register.warehouse_id,
  });

  await assertSubscriptionEntitlement(trx, { requireWriteAccess: true });

  // Check if an OPEN shift already exists for this register
  const existingShift = await trx.db
    .selectFrom('pos_shifts')
    .select(['id'])
    .where('tenant_id', '=', trx.tenantId)
    .where('register_id', '=', input.registerId)
    .where('status', '=', 'OPEN')
    .executeTakeFirst();

  if (existingShift) {
    throw new AppError({
      statusCode: 409,
      errorCode: 'POS_SHIFT_ALREADY_OPEN',
      title: 'Active Shift Already Open',
      detail: `An active cashier shift is already open for register "${register.code}". Close it before opening a new one.`,
    });
  }

  // Check if caller already has an active OPEN shift on ANY register in this tenant
  const userActiveShift = await trx.db
    .selectFrom('pos_shifts')
    .innerJoin('pos_registers', 'pos_registers.id', 'pos_shifts.register_id')
    .select(['pos_shifts.id', 'pos_registers.code as register_code'])
    .where('pos_shifts.tenant_id', '=', trx.tenantId)
    .where('pos_shifts.opened_by_user_id', '=', trx.userId)
    .where('pos_shifts.status', '=', 'OPEN')
    .executeTakeFirst();

  if (userActiveShift) {
    throw new AppError({
      statusCode: 409,
      errorCode: 'POS_CASHIER_SHIFT_ALREADY_OPEN',
      title: 'Active Shift Already Open',
      detail: `You already have an active shift open on register "${userActiveShift.register_code}". Close it before opening a new shift.`,
    });
  }

  const tenant = await trx.db
    .selectFrom('tenants')
    .select(['base_currency'])
    .where('id', '=', trx.tenantId)
    .executeTakeFirstOrThrow();

  const openingFloatMoney = Money.fromDecimalString(
    input.openingCashFloat,
    tenant.base_currency,
  );
  if (openingFloatMoney.isNegative()) {
    throw new AppError({
      statusCode: 400,
      errorCode: 'ERR_VALIDATION_FAILED',
      title: 'Negative Opening Float Forbidden',
      detail: 'Opening cash float cannot be negative.',
    });
  }

  const shiftId = generateUuidV7();
  const shiftRow = await trx.db
    .insertInto('pos_shifts')
    .values({
      id: shiftId,
      tenant_id: trx.tenantId,
      branch_id: register.branch_id,
      register_id: register.id,
      opened_by_user_id: trx.userId,
      closed_by_user_id: null,
      currency_code: tenant.base_currency,
      opening_cash_float: openingFloatMoney.toDecimalString(),
      expected_closing_cash: openingFloatMoney.toDecimalString(),
      counted_closing_cash: null,
      cash_variance: null,
      status: 'OPEN',
      notes: input.notes?.trim() || null,
      metadata_json: JSON.stringify({ traceId: trx.tenantContext.traceId }),
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  await appendAuditLog(trx, {
    action: 'pos:shift:open',
    resourceType: 'pos_shifts',
    resourceId: shiftId,
    metadata: {
      registerId: register.id,
      openingCashFloat: openingFloatMoney.toDecimalString(),
    },
  });

  const openerUser = await trx.db
    .selectFrom('users')
    .select(['full_name', 'email'])
    .where('id', '=', shiftRow.opened_by_user_id)
    .executeTakeFirst();

  return {
    id: shiftRow.id,
    branchId: shiftRow.branch_id,
    registerId: shiftRow.register_id,
    openedByUserId: shiftRow.opened_by_user_id,
    openedByUserName: openerUser?.full_name ?? openerUser?.email ?? 'Unknown Cashier',
    closedByUserId: shiftRow.closed_by_user_id,
    closedByUserName: null,
    currencyCode: shiftRow.currency_code,
    openingCashFloat: Money.fromDecimalString(
      shiftRow.opening_cash_float,
      shiftRow.currency_code,
    ).toDecimalString(),
    cashSales: Money.zero(shiftRow.currency_code).toDecimalString(),
    cashIn: Money.zero(shiftRow.currency_code).toDecimalString(),
    cashOut: Money.zero(shiftRow.currency_code).toDecimalString(),
    cashRefunds: Money.zero(shiftRow.currency_code).toDecimalString(),
    expectedClosingCash: Money.fromDecimalString(
      shiftRow.expected_closing_cash,
      shiftRow.currency_code,
    ).toDecimalString(),
    countedClosingCash: shiftRow.counted_closing_cash
      ? Money.fromDecimalString(
          shiftRow.counted_closing_cash,
          shiftRow.currency_code,
        ).toDecimalString()
      : null,
    cashVariance: shiftRow.cash_variance
      ? Money.fromDecimalString(
          shiftRow.cash_variance,
          shiftRow.currency_code,
        ).toDecimalString()
      : null,
    status: shiftRow.status,
    openedAt: (shiftRow.opened_at instanceof Date ? shiftRow.opened_at : new Date(shiftRow.opened_at)).toISOString(),
    closedAt: shiftRow.closed_at
      ? (shiftRow.closed_at instanceof Date ? shiftRow.closed_at : new Date(shiftRow.closed_at)).toISOString()
      : null,
    notes: shiftRow.notes,
    isOwnShift: true,
    openedByOtherCashier: false,
    adminOverride: false,
    overrideReason: null,
  };
}

// Authoritative Shift Reconciliation (BUG-013)
export interface ShiftReconciliationResult {
  readonly openingCashFloat: string;
  readonly cashSales: string;
  readonly cashIn: string;
  readonly cashOut: string;
  readonly cashRefunds: string;
  readonly expectedClosingCash: string;
  readonly countedClosingCash: string | null;
  readonly cashVariance: string | null;
}

export async function calculateShiftReconciliation(
  trx: TenantTransactionContext,
  shift: {
    readonly id: string;
    readonly branch_id: string;
    readonly register_id: string;
    readonly currency_code: string;
    readonly opening_cash_float: string;
    readonly counted_closing_cash?: string | null;
    readonly status: string;
  },
): Promise<ShiftReconciliationResult> {
  const currency = shift.currency_code;
  const openingFloatMoney = Money.fromDecimalString(
    shift.opening_cash_float,
    currency,
  );

  // 1. Authoritative Cash Sales Query:
  // Must match tenant, branch, register, and shift.
  // Must strictly exclude VOIDED, DRAFT, CANCELLED sales (status === 'COMPLETED').
  // Must strictly exclude non-cash payments (payment_method === 'CASH') and non-completed payments.
  const cashPayments = await trx.db
    .selectFrom('sales_payments')
    .innerJoin('sales_invoices', (join) =>
      join
        .onRef('sales_payments.tenant_id', '=', 'sales_invoices.tenant_id')
        .onRef('sales_payments.invoice_id', '=', 'sales_invoices.id'),
    )
    .select([
      'sales_payments.id as payment_id',
      'sales_payments.amount',
      'sales_payments.change_amount',
    ])
    .where('sales_invoices.tenant_id', '=', trx.tenantId)
    .where('sales_invoices.branch_id', '=', shift.branch_id)
    .where('sales_invoices.register_id', '=', shift.register_id)
    .where('sales_invoices.shift_id', '=', shift.id)
    .where('sales_invoices.status', '=', 'COMPLETED')
    .where('sales_payments.payment_method', '=', 'CASH')
    .where('sales_payments.status', '=', 'COMPLETED')
    .execute();

  let cashSalesMoney = Money.zero(currency);
  for (const cp of cashPayments) {
    cashSalesMoney = cashSalesMoney.add(
      Money.fromDecimalString(cp.amount, currency),
    );
  }

  // 2. Authoritative Cash Adjustments Query (Cash In, Cash Out, Cash Refunds)
  let cashInMoney = Money.zero(currency);
  let cashOutMoney = Money.zero(currency);
  let cashRefundsMoney = Money.zero(currency);

  try {
    const adjustments = await trx.db
      .selectFrom('pos_cash_adjustments')
      .select(['adjustment_type', 'amount'])
      .where('tenant_id', '=', trx.tenantId)
      .where('branch_id', '=', shift.branch_id)
      .where('register_id', '=', shift.register_id)
      .where('shift_id', '=', shift.id)
      .execute();

    for (const adj of adjustments) {
      const amt = Money.fromDecimalString(adj.amount, currency);
      if (adj.adjustment_type === 'CASH_IN') {
        cashInMoney = cashInMoney.add(amt);
      } else if (adj.adjustment_type === 'CASH_OUT') {
        cashOutMoney = cashOutMoney.add(amt);
      } else if (adj.adjustment_type === 'CASH_REFUND') {
        cashRefundsMoney = cashRefundsMoney.add(amt);
      }
    }
  } catch {
    // Gracefully handle if pos_cash_adjustments table is not yet provisioned in target environment
  }

  // 3. Expected Drawer Cash Formula:
  // Expected Drawer Cash = Opening Float + Cash Sales + Cash In - Cash Out - Cash Refunds
  const expectedClosingCashMoney = openingFloatMoney
    .add(cashSalesMoney)
    .add(cashInMoney)
    .subtract(cashOutMoney)
    .subtract(cashRefundsMoney);

  // 4. Counted Cash & Variance
  let countedClosingCash: string | null = null;
  let cashVariance: string | null = null;

  if (shift.counted_closing_cash != null) {
    const countedMoney = Money.fromDecimalString(
      shift.counted_closing_cash,
      currency,
    );
    countedClosingCash = countedMoney.toDecimalString();
    cashVariance = countedMoney
      .subtract(expectedClosingCashMoney)
      .toDecimalString();
  }

  return {
    openingCashFloat: openingFloatMoney.toDecimalString(),
    cashSales: cashSalesMoney.toDecimalString(),
    cashIn: cashInMoney.toDecimalString(),
    cashOut: cashOutMoney.toDecimalString(),
    cashRefunds: cashRefundsMoney.toDecimalString(),
    expectedClosingCash: expectedClosingCashMoney.toDecimalString(),
    countedClosingCash,
    cashVariance,
  };
}

export async function closePosShift(
  trx: TenantTransactionContext,
  shiftId: string,
  input: ClosePosShiftRequest,
): Promise<PosShiftResponse> {
  const shift = await trx.db
    .selectFrom('pos_shifts')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', shiftId)
    .forUpdate()
    .executeTakeFirst();

  if (!shift) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'POS_SHIFT_NOT_FOUND',
      title: 'Shift Not Found',
      detail: `POS Shift "${shiftId}" was not found in tenant "${trx.tenantId}".`,
    });
  }

  if (shift.status === 'CLOSED') {
    throw new AppError({
      statusCode: 409,
      errorCode: 'POS_SHIFT_ALREADY_CLOSED',
      title: 'Shift Already Closed',
      detail: `POS Shift "${shiftId}" is already closed.`,
    });
  }

  await assertAuthorized(trx, {
    permission: 'pos:shift:close',
    branchId: shift.branch_id,
  });

  // Shift ownership enforcement:
  // Only the cashier who opened the shift or an authorized manager/admin may close it.
  // Shift ownership enforcement:
  // Only the cashier who opened the shift or an authorized manager/admin may close it.
  const isAdminOverride = shift.opened_by_user_id !== trx.userId;
  let overrideReason: string | undefined = undefined;

  if (isAdminOverride) {
    const authCtx = await resolveMemberAuthorizationContext(trx);
    const isManagerOrAdmin =
      authCtx.roleCodes.includes('TENANT_OWNER') ||
      authCtx.roleCodes.includes('ORG_ADMIN') ||
      authCtx.roleCodes.includes('BRANCH_MANAGER') ||
      authCtx.permissions.has('org:branch:manage') ||
      authCtx.permissions.has('iam:member:manage');

    if (!isManagerOrAdmin) {
      throw new AppError({
        statusCode: 403,
        errorCode: 'POS_SHIFT_CLOSE_UNAUTHORIZED',
        title: 'Unauthorized to Close Shift',
        detail:
          'Only the cashier who opened this shift or an authorized manager may close it.',
      });
    }

    const effectiveReason =
      input.overrideReason?.trim() ||
      (input.notes && input.notes.trim().length >= 3 ? input.notes.trim() : undefined);

    if (!effectiveReason || effectiveReason.length < 3) {
      throw new AppError({
        statusCode: 400,
        errorCode: 'ERR_VALIDATION_FAILED',
        title: 'Override Reason Required',
        detail:
          'A valid override reason (at least 3 characters) is mandatory when closing another cashier\'s shift.',
      });
    }
    overrideReason = effectiveReason;
  }

  await assertSubscriptionEntitlement(trx, { requireWriteAccess: true });

  const recon = await calculateShiftReconciliation(trx, {
    ...shift,
    counted_closing_cash: input.countedClosingCash,
  });

  const metadata = (shift.metadata_json && typeof shift.metadata_json === 'object')
    ? { ...(shift.metadata_json as Record<string, unknown>) }
    : {};

  if (isAdminOverride) {
    metadata.adminOverride = true;
    metadata.overrideReason = overrideReason;
    metadata.closedByUserId = trx.userId;
  }

  const finalNotes = isAdminOverride && overrideReason
    ? (input.notes?.trim() ? `${input.notes.trim()} (Override: ${overrideReason})` : `Admin Override: ${overrideReason}`)
    : (input.notes?.trim() ?? shift.notes);

  const updatedShift = await trx.db
    .updateTable('pos_shifts')
    .set({
      status: 'CLOSED',
      closed_by_user_id: trx.userId,
      closed_at: new Date(),
      expected_closing_cash: recon.expectedClosingCash,
      counted_closing_cash: recon.countedClosingCash,
      cash_variance: recon.cashVariance,
      notes: finalNotes,
      metadata_json: JSON.stringify(metadata),
    })
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', shiftId)
    .returningAll()
    .executeTakeFirstOrThrow();

  await appendAuditLog(trx, {
    action: 'pos:shift:close',
    resourceType: 'pos_shifts',
    resourceId: shiftId,
    metadata: {
      expectedClosingCash: recon.expectedClosingCash,
      countedClosingCash: recon.countedClosingCash,
      variance: recon.cashVariance,
      adminOverride: isAdminOverride,
      overrideReason: overrideReason ?? null,
      closedByUserId: trx.userId,
      openedByUserId: shift.opened_by_user_id,
    },
  });

  await enqueueOutboxEvent(trx, {
    eventType: 'PosShiftClosedEvent',
    aggregateType: 'pos_shifts',
    aggregateId: shiftId,
    payload: {
      shiftId,
      registerId: shift.register_id,
      expectedClosingCash: recon.expectedClosingCash,
      countedClosingCash: recon.countedClosingCash,
      cashVariance: recon.cashVariance,
      adminOverride: isAdminOverride,
    },
  });

  const [openerUser, closerUser] = await Promise.all([
    trx.db
      .selectFrom('users')
      .select(['full_name', 'email'])
      .where('id', '=', updatedShift.opened_by_user_id)
      .executeTakeFirst(),
    trx.db
      .selectFrom('users')
      .select(['full_name', 'email'])
      .where('id', '=', trx.userId)
      .executeTakeFirst(),
  ]);

  return {
    id: updatedShift.id,
    branchId: updatedShift.branch_id,
    registerId: updatedShift.register_id,
    openedByUserId: updatedShift.opened_by_user_id,
    openedByUserName: openerUser?.full_name ?? openerUser?.email ?? 'Unknown Cashier',
    closedByUserId: updatedShift.closed_by_user_id,
    closedByUserName: closerUser?.full_name ?? closerUser?.email ?? 'Unknown',
    currencyCode: updatedShift.currency_code,
    openingCashFloat: recon.openingCashFloat,
    cashSales: recon.cashSales,
    cashIn: recon.cashIn,
    cashOut: recon.cashOut,
    cashRefunds: recon.cashRefunds,
    expectedClosingCash: recon.expectedClosingCash,
    countedClosingCash: recon.countedClosingCash,
    cashVariance: recon.cashVariance,
    status: updatedShift.status,
    openedAt: (updatedShift.opened_at instanceof Date ? updatedShift.opened_at : new Date(updatedShift.opened_at)).toISOString(),
    closedAt: updatedShift.closed_at
      ? (updatedShift.closed_at instanceof Date ? updatedShift.closed_at : new Date(updatedShift.closed_at)).toISOString()
      : null,
    notes: updatedShift.notes,
    isOwnShift: !isAdminOverride,
    openedByOtherCashier: isAdminOverride,
    adminOverride: isAdminOverride,
    overrideReason: overrideReason ?? null,
  };
}

export async function getActivePosShift(
  trx: TenantTransactionContext,
  registerId?: string,
): Promise<PosShiftResponse | null> {
  let shiftRow;

  if (registerId) {
    const register = await trx.db
      .selectFrom('pos_registers')
      .select(['id', 'branch_id', 'warehouse_id', 'code'])
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', registerId)
      .executeTakeFirst();

    if (!register) {
      throw new AppError({
        statusCode: 404,
        errorCode: 'POS_REGISTER_NOT_FOUND',
        title: 'POS Register Not Found',
        detail: `POS Register "${registerId}" was not found.`,
      });
    }

    await assertAuthorized(trx, {
      permission: 'pos:register:read',
      branchId: register.branch_id,
      warehouseId: register.warehouse_id,
    });

    shiftRow = await trx.db
      .selectFrom('pos_shifts')
      .selectAll()
      .where('tenant_id', '=', trx.tenantId)
      .where('register_id', '=', registerId)
      .where('status', '=', 'OPEN')
      .executeTakeFirst();
  } else {
    // If no registerId provided, lookup the calling cashier's active shift
    shiftRow = await trx.db
      .selectFrom('pos_shifts')
      .selectAll()
      .where('tenant_id', '=', trx.tenantId)
      .where('opened_by_user_id', '=', trx.userId)
      .where('status', '=', 'OPEN')
      .executeTakeFirst();

    if (shiftRow) {
      const register = await trx.db
        .selectFrom('pos_registers')
        .select(['id', 'branch_id', 'warehouse_id', 'code'])
        .where('tenant_id', '=', trx.tenantId)
        .where('id', '=', shiftRow.register_id)
        .executeTakeFirst();

      if (register) {
        await assertAuthorized(trx, {
          permission: 'pos:register:read',
          branchId: register.branch_id,
          warehouseId: register.warehouse_id,
        });
      }
    }
  }

  if (!shiftRow) {
    return null;
  }

  const isShiftOwner = shiftRow.opened_by_user_id === trx.userId;
  let canViewFinancials = isShiftOwner;

  if (!isShiftOwner) {
    const authCtx = await resolveMemberAuthorizationContext(trx);
    const isManagerOrAdmin =
      authCtx.roleCodes.includes('TENANT_OWNER') ||
      authCtx.roleCodes.includes('ORG_ADMIN') ||
      authCtx.roleCodes.includes('BRANCH_MANAGER') ||
      authCtx.permissions.has('org:branch:manage') ||
      authCtx.permissions.has('iam:member:manage');
    canViewFinancials = isManagerOrAdmin;
  }

  const [openerUser, closerUser] = await Promise.all([
    trx.db
      .selectFrom('users')
      .select(['full_name', 'email'])
      .where('id', '=', shiftRow.opened_by_user_id)
      .executeTakeFirst(),
    shiftRow.closed_by_user_id
      ? trx.db
          .selectFrom('users')
          .select(['full_name', 'email'])
          .where('id', '=', shiftRow.closed_by_user_id)
          .executeTakeFirst()
      : null,
  ]);

  const recon = canViewFinancials
    ? await calculateShiftReconciliation(trx, shiftRow)
    : {
        openingCashFloat: '0.00',
        cashSales: '0.00',
        cashIn: '0.00',
        cashOut: '0.00',
        cashRefunds: '0.00',
        expectedClosingCash: '0.00',
        countedClosingCash: null,
        cashVariance: null,
      };

  const meta = (shiftRow.metadata_json && typeof shiftRow.metadata_json === 'object')
    ? (shiftRow.metadata_json as Record<string, unknown>)
    : {};

  return {
    id: shiftRow.id,
    branchId: shiftRow.branch_id,
    registerId: shiftRow.register_id,
    openedByUserId: shiftRow.opened_by_user_id,
    openedByUserName: openerUser?.full_name ?? openerUser?.email ?? 'Unknown Cashier',
    closedByUserId: shiftRow.closed_by_user_id,
    closedByUserName: closerUser?.full_name ?? closerUser?.email ?? null,
    currencyCode: shiftRow.currency_code,
    openingCashFloat: recon.openingCashFloat,
    cashSales: recon.cashSales,
    cashIn: recon.cashIn,
    cashOut: recon.cashOut,
    cashRefunds: recon.cashRefunds,
    expectedClosingCash: recon.expectedClosingCash,
    countedClosingCash: recon.countedClosingCash,
    cashVariance: recon.cashVariance,
    status: shiftRow.status,
    openedAt: (shiftRow.opened_at instanceof Date ? shiftRow.opened_at : new Date(shiftRow.opened_at)).toISOString(),
    closedAt: shiftRow.closed_at
      ? (shiftRow.closed_at instanceof Date ? shiftRow.closed_at : new Date(shiftRow.closed_at)).toISOString()
      : null,
    notes: shiftRow.notes,
    isOwnShift: isShiftOwner,
    openedByOtherCashier: !isShiftOwner,
    adminOverride: Boolean(meta.adminOverride),
    overrideReason: (meta.overrideReason as string) ?? null,
  };
}

export async function listPosShifts(
  trx: TenantTransactionContext,
  query: ListPosShiftsQuery,
): Promise<PosShiftResponse[]> {
  const authCtx = await resolveMemberAuthorizationContext(trx);
  const isManagerOrAdmin =
    authCtx.roleCodes.includes('TENANT_OWNER') ||
    authCtx.roleCodes.includes('ORG_ADMIN') ||
    authCtx.roleCodes.includes('BRANCH_MANAGER') ||
    authCtx.permissions.has('org:branch:manage') ||
    authCtx.permissions.has('iam:member:manage');

  let baseQuery = trx.db
    .selectFrom('pos_shifts')
    .leftJoin('users as opener', 'opener.id', 'pos_shifts.opened_by_user_id')
    .leftJoin('users as closer', 'closer.id', 'pos_shifts.closed_by_user_id')
    .select([
      'pos_shifts.id',
      'pos_shifts.branch_id',
      'pos_shifts.register_id',
      'pos_shifts.opened_by_user_id',
      'pos_shifts.closed_by_user_id',
      'pos_shifts.currency_code',
      'pos_shifts.opening_cash_float',
      'pos_shifts.expected_closing_cash',
      'pos_shifts.counted_closing_cash',
      'pos_shifts.cash_variance',
      'pos_shifts.status',
      'pos_shifts.opened_at',
      'pos_shifts.closed_at',
      'pos_shifts.notes',
      'pos_shifts.metadata_json',
      'opener.full_name as opener_name',
      'opener.email as opener_email',
      'closer.full_name as closer_name',
      'closer.email as closer_email',
    ])
    .where('pos_shifts.tenant_id', '=', trx.tenantId);

  if (!isManagerOrAdmin) {
    baseQuery = baseQuery.where('pos_shifts.opened_by_user_id', '=', trx.userId);
  }

  if (query.registerId) {
    baseQuery = baseQuery.where('pos_shifts.register_id', '=', query.registerId);
  }

  if (query.status && query.status !== 'ALL') {
    baseQuery = baseQuery.where('pos_shifts.status', '=', query.status);
  }

  const limit = Number(query.limit ?? 50);
  baseQuery = baseQuery.orderBy('pos_shifts.opened_at', 'desc').limit(limit);

  if (query.offset !== undefined && query.offset !== null) {
    baseQuery = baseQuery.offset(Number(query.offset));
  }

  const rows = await baseQuery.execute();

  return rows.map((row) => {
    const isShiftOwner = row.opened_by_user_id === trx.userId;
    const meta = (row.metadata_json && typeof row.metadata_json === 'object')
      ? (row.metadata_json as Record<string, unknown>)
      : {};

    return {
      id: row.id,
      branchId: row.branch_id,
      registerId: row.register_id,
      openedByUserId: row.opened_by_user_id,
      openedByUserName: row.opener_name ?? row.opener_email ?? 'Unknown Cashier',
      closedByUserId: row.closed_by_user_id,
      closedByUserName: row.closer_name ?? row.closer_email ?? (row.closed_by_user_id ? 'Unknown' : null),
      currencyCode: row.currency_code,
      openingCashFloat: Money.fromDecimalString(row.opening_cash_float, row.currency_code).toDecimalString(),
      expectedClosingCash: Money.fromDecimalString(row.expected_closing_cash, row.currency_code).toDecimalString(),
      countedClosingCash: row.counted_closing_cash
        ? Money.fromDecimalString(row.counted_closing_cash, row.currency_code).toDecimalString()
        : null,
      cashVariance: row.cash_variance
        ? Money.fromDecimalString(row.cash_variance, row.currency_code).toDecimalString()
        : null,
      status: row.status,
      openedAt: (row.opened_at instanceof Date ? row.opened_at : new Date(row.opened_at)).toISOString(),
      closedAt: row.closed_at
        ? (row.closed_at instanceof Date ? row.closed_at : new Date(row.closed_at)).toISOString()
        : null,
      notes: row.notes,
      isOwnShift: isShiftOwner,
      openedByOtherCashier: !isShiftOwner,
      adminOverride: Boolean(meta.adminOverride),
      overrideReason: (meta.overrideReason as string) ?? null,
    };
  });
}

export async function createPosShiftAdjustment(
  trx: TenantTransactionContext,
  shiftId: string,
  input: CreatePosShiftAdjustmentRequest,
): Promise<PosShiftResponse> {
  const shift = await trx.db
    .selectFrom('pos_shifts')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', shiftId)
    .forUpdate()
    .executeTakeFirst();

  if (!shift) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'POS_SHIFT_NOT_FOUND',
      title: 'Shift Not Found',
      detail: `POS Shift "${shiftId}" was not found.`,
    });
  }

  if (shift.status !== 'OPEN') {
    throw new AppError({
      statusCode: 409,
      errorCode: 'POS_SHIFT_NOT_OPEN',
      title: 'Shift Not Open',
      detail: `Cannot add cash adjustment to closed shift "${shiftId}".`,
    });
  }

  await assertAuthorized(trx, {
    permission: 'pos:register:read',
    branchId: shift.branch_id,
  });

  // Shift ownership enforcement for cash adjustments:
  if (shift.opened_by_user_id !== trx.userId) {
    const authCtx = await resolveMemberAuthorizationContext(trx);
    const isManagerOrAdmin =
      authCtx.roleCodes.includes('TENANT_OWNER') ||
      authCtx.roleCodes.includes('ORG_ADMIN') ||
      authCtx.roleCodes.includes('BRANCH_MANAGER') ||
      authCtx.permissions.has('org:branch:manage') ||
      authCtx.permissions.has('iam:member:manage');

    if (!isManagerOrAdmin) {
      throw new AppError({
        statusCode: 403,
        errorCode: 'POS_SHIFT_CLOSE_UNAUTHORIZED',
        title: 'Unauthorized Shift Adjustment',
        detail:
          'Only the cashier who opened this shift or an authorized manager may record cash adjustments.',
      });
    }
  }

  await assertSubscriptionEntitlement(trx, { requireWriteAccess: true });

  const amountMoney = Money.fromDecimalString(
    input.amount,
    shift.currency_code,
  );
  if (!amountMoney.isPositive()) {
    throw new AppError({
      statusCode: 400,
      errorCode: 'ERR_VALIDATION_FAILED',
      title: 'Invalid Adjustment Amount',
      detail: 'Cash adjustment amount must be strictly positive.',
    });
  }

  const adjId = generateUuidV7();
  await trx.db
    .insertInto('pos_cash_adjustments')
    .values({
      id: adjId,
      tenant_id: trx.tenantId,
      branch_id: shift.branch_id,
      register_id: shift.register_id,
      shift_id: shift.id,
      adjustment_type: input.type,
      amount: amountMoney.toDecimalString(),
      currency_code: shift.currency_code,
      reason: input.reason.trim(),
      performed_by_user_id: trx.userId,
    })
    .execute();

  await appendAuditLog(trx, {
    action: 'pos:shift:adjustment',
    resourceType: 'pos_cash_adjustments',
    resourceId: adjId,
    metadata: {
      shiftId: shift.id,
      registerId: shift.register_id,
      type: input.type,
      amount: amountMoney.toDecimalString(),
      reason: input.reason.trim(),
    },
  });

  const recon = await calculateShiftReconciliation(trx, shift);

  return {
    id: shift.id,
    branchId: shift.branch_id,
    registerId: shift.register_id,
    openedByUserId: shift.opened_by_user_id,
    closedByUserId: shift.closed_by_user_id,
    currencyCode: shift.currency_code,
    openingCashFloat: recon.openingCashFloat,
    cashSales: recon.cashSales,
    cashIn: recon.cashIn,
    cashOut: recon.cashOut,
    cashRefunds: recon.cashRefunds,
    expectedClosingCash: recon.expectedClosingCash,
    countedClosingCash: recon.countedClosingCash,
    cashVariance: recon.cashVariance,
    status: shift.status,
    openedAt: (shift.opened_at instanceof Date ? shift.opened_at : new Date(shift.opened_at)).toISOString(),
    closedAt: shift.closed_at
      ? (shift.closed_at instanceof Date ? shift.closed_at : new Date(shift.closed_at)).toISOString()
      : null,
    notes: shift.notes,
  };
}

export async function updatePosRegister(
  trx: TenantTransactionContext,
  registerId: string,
  input: UpdatePosRegisterRequest,
): Promise<PosRegisterSummaryResponse> {
  const existing = await trx.db
    .selectFrom('pos_registers')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', registerId)
    .executeTakeFirst();

  if (!existing) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'POS_REGISTER_NOT_FOUND',
      title: 'POS Register Not Found',
      detail: `POS Register "${registerId}" was not found.`,
    });
  }

  await assertAuthorized(trx, {
    permission: 'pos:register:read',
    branchId: existing.branch_id,
    warehouseId: existing.warehouse_id,
  });

  await assertSubscriptionEntitlement(trx, { requireWriteAccess: true });

  const nextName = input.name !== undefined ? input.name.trim() : existing.name;
  if (!nextName) {
    throw new AppError({
      statusCode: 400,
      errorCode: 'ERR_VALIDATION_FAILED',
      title: 'Invalid Register Name',
      detail: 'Register name cannot be empty.',
    });
  }

  const nextIsActive =
    input.isActive !== undefined ? input.isActive : existing.is_active;

  const updated = await trx.db
    .updateTable('pos_registers')
    .set({
      name: nextName,
      is_active: nextIsActive,
    })
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', registerId)
    .returningAll()
    .executeTakeFirstOrThrow();

  await appendAuditLog(trx, {
    action: 'pos:register:update',
    resourceType: 'pos_registers',
    resourceId: registerId,
    metadata: {
      previousName: existing.name,
      nextName: updated.name,
      previousIsActive: existing.is_active,
      nextIsActive: updated.is_active,
    },
  });

  return {
    id: updated.id,
    branchId: updated.branch_id,
    warehouseId: updated.warehouse_id,
    code: updated.code,
    name: updated.name,
    isActive: updated.is_active,
  };
}

// ============================================================================
// 3. PRODUCT DISCOVERY FOR CHECKOUT
// ============================================================================

export async function searchPosProducts(
  trx: TenantTransactionContext,
  query: PosProductSearchQuery,
): Promise<PosProductItemResponse[]> {
  await assertAuthorized(trx, {
    permission: 'pos:sale:create',
    warehouseId: query.warehouseId,
  });

  const limit = Math.min(Math.max(Number(query.limit ?? 25), 1), 100);

  let dbQuery = trx.db
    .selectFrom('products')
    .leftJoin('categories', (join) =>
      join
        .onRef('products.tenant_id', '=', 'categories.tenant_id')
        .onRef('products.category_id', '=', 'categories.id'),
    )
    .leftJoin('inventory_balances', (join) =>
      join
        .onRef('products.tenant_id', '=', 'inventory_balances.tenant_id')
        .onRef('products.id', '=', 'inventory_balances.product_id')
        .on('inventory_balances.warehouse_id', '=', query.warehouseId),
    )
    .select([
      'products.id as product_id',
      'products.sku as sku',
      'products.name as name',
      'products.product_type as product_type',
      'products.base_uom as base_uom',
      'products.product_qty_mode as product_qty_mode',
      'products.measurement_category as measurement_category',
      'products.price_uom as price_uom',
      'products.allowed_selling_uoms as allowed_selling_uoms',
      'products.qty_decimal_precision as qty_decimal_precision',
      'products.featured_pos as featured_pos',
      'products.density_g_per_ml as density_g_per_ml',
      'products.selling_price as selling_price',
      'products.track_inventory as track_inventory',
      'products.tracking_mode as tracking_mode',
      'products.valuation_method as valuation_method',
      'products.image_url as image_url',
      'products.category_id as category_id',
      'categories.name as category_name',
      'inventory_balances.qty_on_hand as qty_on_hand',
      'inventory_balances.qty_reserved as qty_reserved',
    ])
    .where('products.tenant_id', '=', trx.tenantId)
    .where('products.status', '=', 'ACTIVE');

  if (query.categoryId) {
    dbQuery = dbQuery.where('products.category_id', '=', query.categoryId);
  }
  if (query.qtyMode) {
    dbQuery = dbQuery.where('products.product_qty_mode', '=', query.qtyMode);
  }
  if (query.featuredOnly === 'true') {
    dbQuery = dbQuery.where('products.featured_pos', '=', true);
  }

  // Exact barcode match search takes highest precedence
  if (query.barcode) {
    const trimmedBarcode = query.barcode.trim();
    const [barcodeMatches, serialMatches] = await Promise.all([
      trx.db
        .selectFrom('product_barcodes')
        .select(['product_id'])
        .where('tenant_id', '=', trx.tenantId)
        .where('barcode', '=', trimmedBarcode)
        .where('is_active', '=', true)
        .execute(),
      trx.db
        .selectFrom('inventory_serials')
        .select(['product_id'])
        .where('tenant_id', '=', trx.tenantId)
        .where('serial_number', '=', trimmedBarcode.toUpperCase())
        .where('status', '=', 'IN_STOCK')
        .execute(),
    ]);

    if (barcodeMatches.length > 0) {
      const productIds = barcodeMatches.map((b) => b.product_id);
      dbQuery = dbQuery.where('products.id', 'in', productIds);
    } else if (serialMatches.length > 0) {
      dbQuery = dbQuery.where(
        'products.id',
        'in',
        serialMatches.map((s) => s.product_id),
      );
    } else {
      // Also check if scanned code matches products.sku exactly
      dbQuery = dbQuery.where('products.sku', '=', trimmedBarcode);
    }
  } else if (query.q) {
    const trimmedQ = query.q.trim();
    const matchedBarcodeProductIds = await trx.db
      .selectFrom('product_barcodes')
      .select(['product_id'])
      .where('tenant_id', '=', trx.tenantId)
      .where('barcode', 'ilike', `%${trimmedQ}%`)
      .where('is_active', '=', true)
      .execute();

    const matchedIds = matchedBarcodeProductIds.map((b) => b.product_id);

    dbQuery = dbQuery.where((eb) => {
      const conditions = [
        eb('products.sku', 'ilike', `%${trimmedQ}%`),
        eb('products.name', 'ilike', `%${trimmedQ}%`),
      ];
      if (matchedIds.length > 0) {
        conditions.push(eb('products.id', 'in', matchedIds));
      }
      return eb.or(conditions);
    });
  }

  const rows = await dbQuery.orderBy('products.name', 'asc').limit(limit).execute();

  if (rows.length === 0) {
    return [];
  }

  const tenant = await trx.db
    .selectFrom('tenants')
    .select(['base_currency'])
    .where('id', '=', trx.tenantId)
    .executeTakeFirst();
  const baseCurrency = tenant?.base_currency || 'USD';

  const productIds = rows.map((r) => r.product_id);
  let targetBranchId = query.branchId ?? null;
  if (!targetBranchId) {
    const wh = await trx.db
      .selectFrom('warehouses')
      .select(['branch_id'])
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', query.warehouseId)
      .executeTakeFirst();
    targetBranchId = wh?.branch_id ?? null;
  }

  const todayStr = new Date().toISOString().slice(0, 10);
  const [barcodes, unitConvRows, branchPriceRows] = await Promise.all([
    trx.db
      .selectFrom('product_barcodes')
      .select(['product_id', 'barcode'])
      .where('tenant_id', '=', trx.tenantId)
      .where('product_id', 'in', productIds)
      .where('is_active', '=', true)
      .execute(),
    trx.db
      .selectFrom('product_unit_conversions')
      .selectAll()
      .where('tenant_id', '=', trx.tenantId)
      .where('product_id', 'in', productIds)
      .where('is_active', '=', true)
      .orderBy('uom_code', 'asc')
      .execute(),
    targetBranchId
      ? trx.db
          .selectFrom('product_branch_prices')
          .select(['product_id', 'selling_price', 'effective_date'])
          .where('tenant_id', '=', trx.tenantId)
          .where('branch_id', '=', targetBranchId)
          .where('product_id', 'in', productIds)
          .where('is_active', '=', true)
          .execute()
      : Promise.resolve([]),
  ]);

  const branchPriceByProduct = new Map<string, string>();
  for (const bp of branchPriceRows) {
    const eff =
      bp.effective_date instanceof Date
        ? bp.effective_date.toISOString().slice(0, 10)
        : String(bp.effective_date).slice(0, 10);
    if (eff <= todayStr) {
      branchPriceByProduct.set(
        bp.product_id,
        Money.fromDecimalString(String(bp.selling_price), baseCurrency).toDecimalString(),
      );
    }
  }

  const barcodesByProduct = new Map<string, string[]>();
  for (const b of barcodes) {
    const list = barcodesByProduct.get(b.product_id) ?? [];
    list.push(b.barcode);
    barcodesByProduct.set(b.product_id, list);
  }

  const uomsByProduct = new Map<string, ProductUnitConversionResponse[]>();
  for (const u of unitConvRows) {
    const list = uomsByProduct.get(u.product_id) ?? [];
    list.push({
      id: u.id,
      uomCode: u.uom_code,
      uomName: u.uom_name,
      conversionFactorToBase: Quantity.fromDecimalString(
        String(u.conversion_factor_to_base),
      ).toDecimalString(),
      isActive: u.is_active,
    });
    uomsByProduct.set(u.product_id, list);
  }

  return rows.map((r) => {
    let availableQtyStr = '0.000000';
    if (r.track_inventory && r.qty_on_hand) {
      const onHand = Quantity.fromDecimalString(r.qty_on_hand);
      const reserved = Quantity.fromDecimalString(r.qty_reserved ?? '0.000000');
      availableQtyStr = onHand.subtract(reserved).toDecimalString();
    }

    const globalPriceStr = Money.fromDecimalString(r.selling_price, baseCurrency).toDecimalString();
    const branchOverridePrice = branchPriceByProduct.get(r.product_id);
    const priceStr = branchOverridePrice ?? globalPriceStr;
    const rawAllowed = r.allowed_selling_uoms;
    let parsedAllowed: string[] = [];
    if (Array.isArray(rawAllowed)) {
      parsedAllowed = rawAllowed.map((u) => String(u).trim().toUpperCase()).filter(Boolean);
    } else if (typeof rawAllowed === 'string' && rawAllowed.trim().startsWith('[')) {
      try {
        const parsed = JSON.parse(rawAllowed) as unknown[];
        if (Array.isArray(parsed)) {
          parsedAllowed = parsed.map((u) => String(u).trim().toUpperCase()).filter(Boolean);
        }
      } catch {
        parsedAllowed = [];
      }
    }

    return {
      id: r.product_id,
      sku: r.sku,
      name: r.name,
      productType: r.product_type as 'STANDARD' | 'SERVICE',
      trackingMode: (r.tracking_mode ?? 'NONE') as TrackingMode,
      valuationMethod: (r.valuation_method ?? 'MOVING_AVG') as ValuationMethod,
      baseUom: r.base_uom,
      productQtyMode: (r.product_qty_mode ?? 'STANDARD') as ProductQtyMode,
      measurementCategory: (r.measurement_category ?? null) as MeasurementCategory | null,
      priceUom: r.price_uom ?? r.base_uom,
      allowedSellingUoms:
        parsedAllowed.length > 0 ? [...new Set(parsedAllowed)] : [r.base_uom],
      qtyDecimalPrecision: r.qty_decimal_precision ?? 0,
      featuredPos: Boolean(r.featured_pos ?? false),
      densityGPerMl: r.density_g_per_ml
        ? Quantity.fromDecimalString(String(r.density_g_per_ml)).toDecimalString()
        : null,
      unitConversions: uomsByProduct.get(r.product_id) ?? [],
      retailPrice: priceStr,
      globalRetailPrice: globalPriceStr,
      priceSource: branchOverridePrice ? ('BRANCH_OVERRIDE' as const) : ('GLOBAL' as const),
      sellingPrice: priceStr,
      trackInventory: r.track_inventory,
      availableQuantity: availableQtyStr,
      barcodes: barcodesByProduct.get(r.product_id) ?? [],
      categoryId: r.category_id ?? null,
      categoryName: r.category_name ?? null,
      imageUrl: r.image_url ?? null,
    };
  });
}

// ============================================================================
// 4. CHECKOUT AND SALE CREATION (ATOMIC SERVER-SIDE TRANSACTION)
// ============================================================================

export async function checkoutSale(
  trx: TenantTransactionContext,
  idempotencyKey: string,
  input: CreatePosSaleRequest,
): Promise<SalesInvoiceResponse> {
  await assertSubscriptionEntitlement(trx, { requireWriteAccess: true });

  const register = await trx.db
    .selectFrom('pos_registers')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', input.registerId)
    .forUpdate()
    .executeTakeFirst();

  if (!register) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'POS_REGISTER_NOT_FOUND',
      title: 'POS Register Not Found',
      detail: `Register "${input.registerId}" was not found.`,
    });
  }

  if (!register.is_active) {
    throw new AppError({
      statusCode: 409,
      errorCode: 'POS_REGISTER_INACTIVE',
      title: 'POS Register Inactive',
      detail: `Register "${register.code}" is disabled.`,
    });
  }

  await assertAuthorized(trx, {
    permission: 'pos:sale:create',
    branchId: register.branch_id,
    warehouseId: register.warehouse_id,
  });

  if (input.lines.length === 0) {
    throw new AppError({
      statusCode: 422,
      errorCode: 'POS_CART_EMPTY',
      title: 'Cart Is Empty',
      detail: 'Cannot complete checkout with an empty cart.',
    });
  }

  // Validate active shift if provided
  if (input.shiftId) {
    const shift = await trx.db
      .selectFrom('pos_shifts')
      .select(['id', 'register_id', 'status', 'opened_by_user_id'])
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', input.shiftId)
      .executeTakeFirst();

    if (!shift || shift.register_id !== register.id || shift.status !== 'OPEN') {
      throw new AppError({
        statusCode: 409,
        errorCode: 'POS_SHIFT_NOT_OPEN',
        title: 'POS Shift Not Open',
        detail: `The specified shift "${input.shiftId}" is not currently open for register "${register.code}".`,
      });
    }

    if (shift.opened_by_user_id !== trx.userId) {
      const authCtx = await resolveMemberAuthorizationContext(trx);
      const isManagerOrAdmin =
        authCtx.roleCodes.includes('TENANT_OWNER') ||
        authCtx.roleCodes.includes('ORG_ADMIN') ||
        authCtx.roleCodes.includes('BRANCH_MANAGER') ||
        authCtx.permissions.has('org:branch:manage') ||
        authCtx.permissions.has('iam:member:manage');

      if (!isManagerOrAdmin) {
        throw new AppError({
          statusCode: 403,
          errorCode: 'POS_SHIFT_CLOSE_UNAUTHORIZED',
          title: 'Unauthorized Sale Shift',
          detail: "You cannot record sales under another cashier's active shift.",
        });
      }
    }
  }

  // Tenant base currency & pricing policy
  const [tenant, warehouseRow, pricingSettingsRow] = await Promise.all([
    trx.db
      .selectFrom('tenants')
      .select(['base_currency', 'legal_name'])
      .where('id', '=', trx.tenantId)
      .executeTakeFirstOrThrow(),
    trx.db
      .selectFrom('warehouses')
      .select(['id', 'allow_negative_stock'])
      .where('id', '=', register.warehouse_id)
      .executeTakeFirst(),
    trx.db
      .selectFrom('pricing_settings')
      .select(['batch_pricing_fallback_policy', 'default_batch_allocation_policy'])
      .where('tenant_id', '=', trx.tenantId)
      .executeTakeFirst(),
  ]);

  const currencyCode = tenant.base_currency;
  const allowNegative = Boolean(
    warehouseRow?.allow_negative_stock || input.allowNegativeStockOverride,
  );
  const batchFallbackPolicy =
    (pricingSettingsRow?.batch_pricing_fallback_policy as
      | 'BLOCK_MISSING'
      | 'ALLOW_PRODUCT_FALLBACK'
      | undefined) ?? 'ALLOW_PRODUCT_FALLBACK';
  const todayStr = new Date().toISOString().slice(0, 10);

  let cachedIsSupervisor: boolean | null = null;
  async function checkIsSupervisor(): Promise<boolean> {
    if (cachedIsSupervisor !== null) return cachedIsSupervisor;
    const authCtx = await resolveMemberAuthorizationContext(trx);
    cachedIsSupervisor = authCtx.roleCodes.some(
      (code) =>
        code === 'TENANT_OWNER' ||
        code === 'ORG_ADMIN' ||
        code === 'BRANCH_MANAGER',
    );
    return cachedIsSupervisor;
  }

  // Increment sequential invoice number concurrency-safely
  const nextSeq = BigInt(register.last_invoice_seq) + 1n;
  await trx.db
    .updateTable('pos_registers')
    .set({ last_invoice_seq: Number(nextSeq) })
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', register.id)
    .execute();

  const invoiceNumber = `${register.code}-${nextSeq.toString().padStart(6, '0')}`;
  const saleId = generateUuidV7();

  // Resolve Products & Calculate Line Totals
  const processedLines: Array<{
    readonly lineNumber: number;
    readonly productId: string;
    readonly sku: string;
    readonly productName: string;
    readonly uomCode: string;
    readonly quantity: Quantity;
    readonly conversionFactorToBase: string;
    readonly normalizedBaseQty: Quantity;
    readonly priceUom: string;
    readonly pricePerPriceUom: Money;
    readonly entrySource: LineEntrySource;
    readonly unitPrice: Money;
    readonly discountAmount: Money;
    readonly taxAmount: Money;
    readonly lineTotal: Money;
    readonly trackInventory: boolean;
    readonly trackingMode: string;
    readonly valuationMethod: string;
    readonly unitCostSnapshot: string;
    readonly batchId: string | null;
    readonly batchNumber: string | null;
    readonly internalBarcode: string | null;
    readonly expiryDate: string | null;
    readonly priceSource:
      | 'BATCH_EXPLICIT'
      | 'POS_MANUAL_OVERRIDE'
      | 'PRODUCT_FALLBACK'
      | 'BRANCH_OVERRIDE'
      | 'GLOBAL_PRODUCT'
      | null;
    readonly serialId: string | null;
  }> = [];

  let subtotalAccumulator = Money.zero(currencyCode);
  let totalLineDiscounts = Money.zero(currencyCode);
  let totalTaxes = Money.zero(currencyCode);

  for (let idx = 0; idx < input.lines.length; idx++) {
    const lineItem = input.lines[idx]!;

    let lineQty: Quantity;
    try {
      lineQty = Quantity.fromDecimalString(lineItem.quantity);
    } catch {
      throw new AppError({
        statusCode: 422,
        errorCode: 'INV_INVALID_MOVEMENT_QUANTITY',
        title: 'Invalid Line Quantity',
        detail: `Quantity "${lineItem.quantity}" is invalid.`,
      });
    }

    if (!lineQty.isPositive()) {
      throw new AppError({
        statusCode: 422,
        errorCode: 'INV_INVALID_MOVEMENT_QUANTITY',
        title: 'Invalid Line Quantity',
        detail: `Line item quantity must be strictly positive (> 0).`,
      });
    }

    const product = await trx.db
      .selectFrom('products')
      .selectAll()
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', lineItem.productId)
      .executeTakeFirst();

    if (!product) {
      throw new AppError({
        statusCode: 404,
        errorCode: 'ERR_NOT_FOUND',
        title: 'Product Not Found',
        detail: `Product "${lineItem.productId}" was not found.`,
      });
    }

    if (product.status !== 'ACTIVE') {
      throw new AppError({
        statusCode: 409,
        errorCode: 'INV_PRODUCT_ARCHIVED',
        title: 'Product Archived',
        detail: `Product "${product.sku}" is archived and cannot be sold.`,
      });
    }

    const uomCode = (lineItem.uomCode ?? product.base_uom).trim().toUpperCase();
    const convRows = await trx.db
      .selectFrom('product_unit_conversions')
      .select(['uom_code', 'conversion_factor_to_base'])
      .where('tenant_id', '=', trx.tenantId)
      .where('product_id', '=', product.id)
      .where('is_active', '=', true)
      .execute();

    const customConversions = convRows.map((c) => ({
      uomCode: c.uom_code,
      conversionFactorToBase: String(c.conversion_factor_to_base),
    }));

    let convToBase: { convertedQuantity: Quantity; factorDecimal6: string };
    try {
      convToBase = convertQuantityBetweenUoms({
        quantity: lineQty.toDecimalString(),
        fromUom: uomCode,
        toUom: product.base_uom,
        productBaseUom: product.base_uom,
        customConversions,
        densityGPerMl: product.density_g_per_ml,
      });
    } catch (err) {
      if (err instanceof UomConversionError) {
        throw new AppError({
          statusCode: 400,
          errorCode: 'CAT_INVALID_UOM_CONVERSION',
          title: 'Unsupported UoM',
          detail: err.message,
        });
      }
      throw err;
    }

    const normalizedBaseQty = convToBase.convertedQuantity;
    const conversionFactorToBaseStr = convToBase.factorDecimal6;

    // Verify supervisor authorization if manual selling price override is supplied
    let isPriceOverrideAuthorized = false;
    if (lineItem.overrideSellingPrice !== undefined && lineItem.overrideSellingPrice !== null) {
      isPriceOverrideAuthorized = await checkIsSupervisor();
      if (!isPriceOverrideAuthorized) {
        throw new AppError({
          statusCode: 403,
          errorCode: 'POS_UNAUTHORIZED_DISCOUNT',
          title: 'Unauthorized Price Override',
          detail:
            'Cashiers are not permitted to override selling prices without supervisor authorization.',
        });
      }
    }

    // Load branch pricing config & tax rules once per cart line
    const effectivePriceUom = (product.price_uom ?? product.base_uom)
      .trim()
      .toUpperCase();
    const branchPriceCfg = await resolveBranchEffectivePriceConfig(trx, {
      productId: product.id,
      branchId: register.branch_id,
      globalSellingPrice: product.selling_price,
      currencyCode,
    });

    let lineTaxRules: Array<{
      taxRateId: string;
      name: string;
      ratePercentage: string;
      isCompound: boolean;
    }> = [];

    if (product.tax_group_id) {
      const taxRates = await trx.db
        .selectFrom('tax_rates')
        .selectAll()
        .where('tenant_id', '=', trx.tenantId)
        .where('tax_group_id', '=', product.tax_group_id)
        .where('is_active', '=', true)
        .orderBy('priority', 'asc')
        .execute();

      lineTaxRules = taxRates.map((r) => ({
        taxRateId: r.id,
        name: r.name,
        ratePercentage: r.rate_percentage,
        isCompound: r.is_compound,
      }));
    }

    let serialId: string | null = lineItem.serialId ?? null;
    if (product.track_inventory && product.tracking_mode === 'SERIAL') {
      if (!serialId && lineItem.serialNumber) {
        const sRow = await trx.db
          .selectFrom('inventory_serials')
          .select(['id', 'status'])
          .where('tenant_id', '=', trx.tenantId)
          .where('product_id', '=', product.id)
          .where(
            'serial_number',
            '=',
            lineItem.serialNumber.trim().toUpperCase(),
          )
          .executeTakeFirst();
        if (sRow) {
          serialId = sRow.id;
        } else {
          throw new AppError({
            statusCode: 404,
            errorCode: 'INV_SERIAL_NOT_FOUND',
            title: 'Serial Number Not Found',
            detail: `Serial number "${lineItem.serialNumber}" not found for product "${product.sku}".`,
          });
        }
      }
    }

    type CheckoutSlice = {
      readonly sliceQty: Quantity;
      readonly sliceBaseQty: Quantity;
      readonly sliceConvFactorToBase: string;
      readonly batchId: string | null;
      readonly batchNumber: string | null;
      readonly internalBarcode: string | null;
      readonly expiryDate: string | null;
      readonly effectiveUnitPriceStr: string;
      readonly minSellingPriceFloor: string | null;
      readonly maxDiscountPctPolicy: string | null;
      readonly unitCostSnapshot: string;
      readonly priceSource:
        | 'BATCH_EXPLICIT'
        | 'POS_MANUAL_OVERRIDE'
        | 'PRODUCT_FALLBACK'
        | 'BRANCH_OVERRIDE'
        | 'GLOBAL_PRODUCT';
    };

    const slices: CheckoutSlice[] = [];

    if (
      product.track_inventory &&
      (product.tracking_mode === 'BATCH' ||
        product.tracking_mode === 'BATCH_EXPIRY')
    ) {
      const resolveSlicePrice = (params: {
        batchNumber: string;
        batchSellingPrice: string | null;
        batchMinSellingPrice: string | null;
        batchMaxDiscountPct: string | null;
        batchPricingMode: 'EXPLICIT' | 'INHERIT_PRODUCT';
      }) => {
        const priceRes = resolveEffectiveBatchPrice({
          batchNumber: params.batchNumber,
          batchSellingPrice: params.batchSellingPrice,
          batchMinSellingPrice: params.batchMinSellingPrice,
          batchMaxDiscountPct: params.batchMaxDiscountPct,
          batchPricingMode: params.batchPricingMode,
          productSellingPrice: product.selling_price,
          productMinSellingPrice: null,
          productMaxDiscountPct: null,
          branchSellingPrice:
            branchPriceCfg.priceSource === 'BRANCH_OVERRIDE'
              ? branchPriceCfg.effectivePrice
              : null,
          branchMinSellingPrice: branchPriceCfg.minSellingPrice,
          branchMaxDiscountPct: branchPriceCfg.maxDiscountPct,
          fallbackPolicy: batchFallbackPolicy,
          requireBatchSellingPrice: Boolean(product.require_batch_selling_price),
          overrideSellingPrice: lineItem.overrideSellingPrice ?? null,
          overrideAuthorized: isPriceOverrideAuthorized,
          currencyCode,
        });

        if (!priceRes.ok) {
          throw new AppError({
            statusCode: 422,
            errorCode:
              priceRes.errorCode === 'BATCH_MIN_PRICE_VIOLATION'
                ? 'POS_BATCH_MIN_PRICE_VIOLATION'
                : 'POS_BATCH_PRICE_REQUIRED',
            title:
              priceRes.errorCode === 'BATCH_MIN_PRICE_VIOLATION'
                ? 'Batch Minimum Selling Price Violation'
                : 'Batch Selling Price Required',
            detail: priceRes.reason,
          });
        }

        const priceSourceMap: Record<
          Extract<typeof priceRes, { ok: true }>['source'],
          CheckoutSlice['priceSource']
        > = {
          EXPLICIT_BATCH_PRICE: 'BATCH_EXPLICIT',
          POS_BATCH_OVERRIDE: 'POS_MANUAL_OVERRIDE',
          BRANCH_DEFAULT_FALLBACK: 'BRANCH_OVERRIDE',
          PRODUCT_DEFAULT_FALLBACK: 'PRODUCT_FALLBACK',
        };

        return {
          effectiveUnitPriceStr: priceRes.resolvedPrice,
          minSellingPriceFloor: priceRes.minSellingPrice,
          maxDiscountPctPolicy: priceRes.maxDiscountPct,
          priceSource: priceSourceMap[priceRes.source],
        };
      };

      if (lineItem.batchId) {
        // Explicit internal batch barcode lock: never replace with another batch via FEFO/FIFO
        const explicitBatch = await trx.db
          .selectFrom('inventory_batches')
          .selectAll()
          .where('tenant_id', '=', trx.tenantId)
          .where('id', '=', lineItem.batchId)
          .forUpdate()
          .executeTakeFirst();

        if (!explicitBatch) {
          throw new AppError({
            statusCode: 404,
            errorCode: 'INV_BATCH_NOT_FOUND',
            title: 'Batch Not Found',
            detail: `Batch "${lineItem.batchId}" was not found.`,
          });
        }

        if (
          explicitBatch.product_id !== product.id ||
          explicitBatch.warehouse_id !== register.warehouse_id
        ) {
          throw new AppError({
            statusCode: 409,
            errorCode: 'POS_BATCH_NOT_AVAILABLE',
            title: 'Batch Not Available At Register',
            detail: `Batch "${explicitBatch.batch_number}" does not belong to product "${product.sku}" in this warehouse.`,
          });
        }

        const expRaw: unknown = explicitBatch.expiry_date;
        const expiryStr = expRaw
          ? typeof expRaw === 'string'
            ? expRaw.slice(0, 10)
            : (expRaw as Date).toISOString().slice(0, 10)
          : null;

        if (
          explicitBatch.status === 'EXPIRED' ||
          (expiryStr && expiryStr < todayStr)
        ) {
          throw new AppError({
            statusCode: 409,
            errorCode: 'POS_BATCH_EXPIRED',
            title: 'Expired Batch Blocked',
            detail: `Batch "${explicitBatch.batch_number}" expired on ${expiryStr ?? 'record'} and cannot be sold.`,
          });
        }

        if (explicitBatch.status !== 'ACTIVE') {
          throw new AppError({
            statusCode: 409,
            errorCode: 'POS_BATCH_NOT_AVAILABLE',
            title: 'Batch Unavailable For Sale',
            detail: `Batch "${explicitBatch.batch_number}" has status "${explicitBatch.status}" and cannot be sold.`,
          });
        }

        const currentQty = Quantity.fromDecimalString(
          String(explicitBatch.current_quantity),
        );
        const reservedQty = Quantity.fromDecimalString(
          String(explicitBatch.reserved_quantity ?? '0.000000'),
        );
        const availableQty = currentQty.subtract(reservedQty);
        if (!allowNegative && availableQty.compare(normalizedBaseQty) < 0) {
          throw new AppError({
            statusCode: 409,
            errorCode: 'INV_INSUFFICIENT_BATCH_STOCK',
            title: 'Insufficient Batch Stock',
            detail: `Batch "${explicitBatch.batch_number}" has only ${availableQty.toDecimalString()} available, but ${normalizedBaseQty.toDecimalString()} was requested.`,
          });
        }

        const resolvedPrice = resolveSlicePrice({
          batchNumber: explicitBatch.batch_number,
          batchSellingPrice:
            explicitBatch.selling_price != null
              ? Money.fromDecimalString(
                  String(explicitBatch.selling_price),
                  currencyCode,
                ).toDecimalString()
              : null,
          batchMinSellingPrice:
            explicitBatch.min_selling_price != null
              ? Money.fromDecimalString(
                  String(explicitBatch.min_selling_price),
                  currencyCode,
                ).toDecimalString()
              : null,
          batchMaxDiscountPct:
            explicitBatch.max_discount_pct != null
              ? String(explicitBatch.max_discount_pct)
              : null,
          batchPricingMode: (explicitBatch.batch_pricing_mode ?? 'EXPLICIT') as
            | 'EXPLICIT'
            | 'INHERIT_PRODUCT',
        });

        slices.push({
          sliceQty: lineQty,
          sliceBaseQty: normalizedBaseQty,
          sliceConvFactorToBase: conversionFactorToBaseStr,
          batchId: explicitBatch.id,
          batchNumber: explicitBatch.batch_number,
          internalBarcode: explicitBatch.internal_barcode ?? null,
          expiryDate: expiryStr,
          effectiveUnitPriceStr: resolvedPrice.effectiveUnitPriceStr,
          minSellingPriceFloor: resolvedPrice.minSellingPriceFloor,
          maxDiscountPctPolicy: resolvedPrice.maxDiscountPctPolicy,
          unitCostSnapshot: Money.fromDecimalString(
            String(explicitBatch.unit_cost),
            currencyCode,
          ).toDecimalString(),
          priceSource: resolvedPrice.priceSource,
        });
      } else {
        // Automatic FEFO/FIFO allocation (supports multi-batch cart splitting)
        const fefo = await selectFefoBatches(trx, {
          warehouseId: register.warehouse_id,
          productId: product.id,
          requiredQuantity: normalizedBaseQty.toDecimalString(),
          skipPermissionCheck: true,
        });

        const unfulfilledQty = Quantity.fromDecimalString(fefo.unfulfilledQty);
        if (
          !allowNegative &&
          (fefo.allocations.length === 0 || unfulfilledQty.isPositive())
        ) {
          throw new AppError({
            statusCode: 409,
            errorCode: 'INV_INSUFFICIENT_BATCH_STOCK',
            title: 'Insufficient Batch Stock',
            detail: `Insufficient active non-expired batch stock for product "${product.sku}": requested ${normalizedBaseQty.toDecimalString()}, available ${fefo.fulfilledQty}.`,
          });
        }

        if (fefo.allocations.length === 0) {
          const resolvedFallback = resolveSlicePrice({
            batchNumber: product.sku,
            batchSellingPrice: null,
            batchMinSellingPrice: null,
            batchMaxDiscountPct: null,
            batchPricingMode: 'INHERIT_PRODUCT',
          });
          slices.push({
            sliceQty: lineQty,
            sliceBaseQty: normalizedBaseQty,
            sliceConvFactorToBase: conversionFactorToBaseStr,
            batchId: null,
            batchNumber: null,
            internalBarcode: null,
            expiryDate: null,
            effectiveUnitPriceStr: resolvedFallback.effectiveUnitPriceStr,
            minSellingPriceFloor: resolvedFallback.minSellingPriceFloor,
            maxDiscountPctPolicy: resolvedFallback.maxDiscountPctPolicy,
            unitCostSnapshot: product.purchase_cost,
            priceSource: resolvedFallback.priceSource,
          });
        } else {
          const allocatedBatchIds = fefo.allocations.map((a) => a.batchId);
          const batchMetaRows = await trx.db
            .selectFrom('inventory_batches')
            .select([
              'id',
              'min_selling_price',
              'max_discount_pct',
              'batch_pricing_mode',
              'unit_cost',
            ])
            .where('tenant_id', '=', trx.tenantId)
            .where('id', 'in', allocatedBatchIds)
            .execute();
          const batchMetaById = new Map(batchMetaRows.map((b) => [b.id, b]));

          for (let aIdx = 0; aIdx < fefo.allocations.length; aIdx++) {
            const alloc = fefo.allocations[aIdx]!;
            const bMeta = batchMetaById.get(alloc.batchId);
            const sliceBaseQty = Quantity.fromDecimalString(alloc.allocatedQty);

            let sliceQty: Quantity;
            if (fefo.allocations.length === 1 && !unfulfilledQty.isPositive()) {
              sliceQty = lineQty;
            } else if (uomCode === product.base_uom) {
              sliceQty = sliceBaseQty;
            } else {
              sliceQty = convertQuantityBetweenUoms({
                quantity: sliceBaseQty.toDecimalString(),
                fromUom: product.base_uom,
                toUom: uomCode,
                productBaseUom: product.base_uom,
                customConversions,
                densityGPerMl: product.density_g_per_ml,
              }).convertedQuantity;
            }

            const resolvedPrice = resolveSlicePrice({
              batchNumber: alloc.batchNumber,
              batchSellingPrice: alloc.sellingPrice ?? null,
              batchMinSellingPrice:
                bMeta?.min_selling_price != null
                  ? Money.fromDecimalString(
                      String(bMeta.min_selling_price),
                      currencyCode,
                    ).toDecimalString()
                  : null,
              batchMaxDiscountPct:
                bMeta?.max_discount_pct != null
                  ? String(bMeta.max_discount_pct)
                  : null,
              batchPricingMode: (bMeta?.batch_pricing_mode ??
                alloc.batchPricingMode ??
                'EXPLICIT') as 'EXPLICIT' | 'INHERIT_PRODUCT',
            });

            slices.push({
              sliceQty,
              sliceBaseQty,
              sliceConvFactorToBase: conversionFactorToBaseStr,
              batchId: alloc.batchId,
              batchNumber: alloc.batchNumber,
              internalBarcode: alloc.internalBarcode ?? null,
              expiryDate: alloc.expiryDate ?? null,
              effectiveUnitPriceStr: resolvedPrice.effectiveUnitPriceStr,
              minSellingPriceFloor: resolvedPrice.minSellingPriceFloor,
              maxDiscountPctPolicy: resolvedPrice.maxDiscountPctPolicy,
              unitCostSnapshot: Money.fromDecimalString(
                String(bMeta?.unit_cost ?? alloc.unitCost),
                currencyCode,
              ).toDecimalString(),
              priceSource: resolvedPrice.priceSource,
            });
          }

          if (unfulfilledQty.isPositive()) {
            const extraQty =
              uomCode === product.base_uom
                ? unfulfilledQty
                : convertQuantityBetweenUoms({
                    quantity: unfulfilledQty.toDecimalString(),
                    fromUom: product.base_uom,
                    toUom: uomCode,
                    productBaseUom: product.base_uom,
                    customConversions,
                    densityGPerMl: product.density_g_per_ml,
                  }).convertedQuantity;
            const resolvedFallback = resolveSlicePrice({
              batchNumber: product.sku,
              batchSellingPrice: null,
              batchMinSellingPrice: null,
              batchMaxDiscountPct: null,
              batchPricingMode: 'INHERIT_PRODUCT',
            });
            slices.push({
              sliceQty: extraQty,
              sliceBaseQty: unfulfilledQty,
              sliceConvFactorToBase: conversionFactorToBaseStr,
              batchId: null,
              batchNumber: null,
              internalBarcode: null,
              expiryDate: null,
              effectiveUnitPriceStr: resolvedFallback.effectiveUnitPriceStr,
              minSellingPriceFloor: resolvedFallback.minSellingPriceFloor,
              maxDiscountPctPolicy: resolvedFallback.maxDiscountPctPolicy,
              unitCostSnapshot: product.purchase_cost,
              priceSource: resolvedFallback.priceSource,
            });
          }
        }
      }
    } else {
      let effectiveUnitPriceStr = branchPriceCfg.effectivePrice;
      let resolvedPriceSource: CheckoutSlice['priceSource'] =
        branchPriceCfg.priceSource === 'BRANCH_OVERRIDE'
          ? 'BRANCH_OVERRIDE'
          : 'GLOBAL_PRODUCT';
      if (
        isPriceOverrideAuthorized &&
        lineItem.overrideSellingPrice !== undefined &&
        lineItem.overrideSellingPrice !== null
      ) {
        const overrideMoney = Money.fromDecimalString(
          lineItem.overrideSellingPrice,
          currencyCode,
        );
        if (branchPriceCfg.minSellingPrice) {
          const floorMoney = Money.fromDecimalString(
            branchPriceCfg.minSellingPrice,
            currencyCode,
          );
          if (overrideMoney.compare(floorMoney) < 0) {
            throw new AppError({
              statusCode: 422,
              errorCode: 'POS_BATCH_MIN_PRICE_VIOLATION',
              title: 'Minimum Selling Price Floor Violation',
              detail: `Override price (${overrideMoney.toDecimalString()}) is below minimum selling price floor (${floorMoney.toDecimalString()}).`,
            });
          }
        }
        effectiveUnitPriceStr = overrideMoney.toDecimalString();
        resolvedPriceSource = 'POS_MANUAL_OVERRIDE';
      }

      slices.push({
        sliceQty: lineQty,
        sliceBaseQty: normalizedBaseQty,
        sliceConvFactorToBase: conversionFactorToBaseStr,
        batchId: null,
        batchNumber: null,
        internalBarcode: null,
        expiryDate: null,
        effectiveUnitPriceStr,
        minSellingPriceFloor: branchPriceCfg.minSellingPrice,
        maxDiscountPctPolicy: branchPriceCfg.maxDiscountPct,
        unitCostSnapshot: product.purchase_cost,
        priceSource: resolvedPriceSource,
      });
    }

    let totalRequestedDiscount = Money.zero(currencyCode);
    if (lineItem.discountAmount) {
      totalRequestedDiscount = Money.fromDecimalString(
        lineItem.discountAmount,
        currencyCode,
      );
      if (totalRequestedDiscount.isNegative()) {
        throw new AppError({
          statusCode: 400,
          errorCode: 'ERR_VALIDATION_FAILED',
          title: 'Invalid Line Discount',
          detail: 'Line discount cannot be negative.',
        });
      }
    }
    let remainingDiscountToAllocate = totalRequestedDiscount;

    for (let sIdx = 0; sIdx < slices.length; sIdx++) {
      const slice = slices[sIdx]!;
      const pricePerPriceUomMoney = Money.fromDecimalString(
        slice.effectiveUnitPriceStr,
        currencyCode,
      );

      let propPricing: ReturnType<typeof computeProportionateUnitPriceAndTotal>;
      try {
        propPricing = computeProportionateUnitPriceAndTotal({
          sellingPricePerPriceUom: pricePerPriceUomMoney.toDecimalString(),
          priceUom: effectivePriceUom,
          enteredQty: slice.sliceQty.toDecimalString(),
          sellingUom: uomCode,
          currencyCode,
          productBaseUom: product.base_uom,
          customConversions,
          densityGPerMl: product.density_g_per_ml,
        });
      } catch (err) {
        if (err instanceof UomConversionError) {
          throw new AppError({
            statusCode: 400,
            errorCode: 'CAT_INVALID_UOM_CONVERSION',
            title: 'Incompatible Pricing UoM',
            detail: err.message,
          });
        }
        throw err;
      }

      const unitPriceMoney = propPricing.unitPriceInSellingUom;
      const resolvedEntrySource: LineEntrySource =
        lineItem.entrySource ??
        ((product.product_qty_mode ?? 'STANDARD') === 'VARIABLE'
          ? 'MANUAL_WEIGHT'
          : 'MANUAL');

      let lineDiscountMoney = Money.zero(currencyCode);
      if (totalRequestedDiscount.isPositive()) {
        if (sIdx === slices.length - 1 || slices.length === 1) {
          lineDiscountMoney = remainingDiscountToAllocate;
        } else if (normalizedBaseQty.microUnits > 0n) {
          const sliceScaledDiscount =
            (totalRequestedDiscount.scaledUnits * slice.sliceBaseQty.microUnits) /
            normalizedBaseQty.microUnits;
          lineDiscountMoney = Money.fromScaledUnits(
            sliceScaledDiscount,
            currencyCode,
          );
          remainingDiscountToAllocate =
            remainingDiscountToAllocate.subtract(lineDiscountMoney);
        }

        if (lineDiscountMoney.isPositive()) {
          const qtyInPriceUomStr =
            effectivePriceUom === product.base_uom
              ? slice.sliceBaseQty.toDecimalString()
              : effectivePriceUom === uomCode
                ? slice.sliceQty.toDecimalString()
                : convertQuantityBetweenUoms({
                    quantity: slice.sliceQty.toDecimalString(),
                    fromUom: uomCode,
                    toUom: effectivePriceUom,
                    productBaseUom: product.base_uom,
                    customConversions,
                    densityGPerMl: product.density_g_per_ml,
                  }).convertedQuantity.toDecimalString();

          const policyCheck = validateDiscountAgainstPolicy({
            grossLineTotal: propPricing.effectiveLineSubtotal.toDecimalString(),
            discountAmount: lineDiscountMoney.toDecimalString(),
            baseQty: qtyInPriceUomStr,
            maxDiscountPct: slice.maxDiscountPctPolicy,
            minSellingPrice: slice.minSellingPriceFloor,
            currencyCode,
          });
          if (!policyCheck.allowed) {
            const isFloorViolation = policyCheck.reason?.includes('minimum selling price');
            throw new AppError({
              statusCode: 422,
              errorCode: isFloorViolation
                ? 'PRICING_MIN_PRICE_VIOLATION'
                : 'PRICING_MAX_DISCOUNT_EXCEEDED',
              title: isFloorViolation
                ? 'Minimum Selling Price Floor Violation'
                : 'Discount Exceeds Policy Limit',
              detail:
                policyCheck.reason ??
                `Discount exceeds pricing policy limit for "${product.sku}".`,
            });
          }
        }
      }

      let lineCalc;
      try {
        lineCalc = calculateLinePricingAndTax({
          unitPrice:
            uomCode === effectivePriceUom
              ? unitPriceMoney
              : propPricing.effectiveLineSubtotal,
          quantity:
            uomCode === effectivePriceUom ? slice.sliceQty : Quantity.fromInteger(1),
          lineDiscount: lineDiscountMoney,
          isTaxInclusive: false,
          taxRules: lineTaxRules,
        });
      } catch (err: unknown) {
        throw new AppError({
          statusCode: 400,
          errorCode: 'ERR_VALIDATION_FAILED',
          title: 'Line Price Calculation Error',
          detail: (err as Error).message,
        });
      }

      subtotalAccumulator = subtotalAccumulator.add(lineCalc.grossLineAmount);
      totalLineDiscounts = totalLineDiscounts.add(lineCalc.discountAmount);
      totalTaxes = totalTaxes.add(lineCalc.totalTaxAmount);

      processedLines.push({
        lineNumber: processedLines.length + 1,
        productId: product.id,
        sku: product.sku,
        productName: product.name,
        uomCode,
        quantity: slice.sliceQty,
        conversionFactorToBase: slice.sliceConvFactorToBase,
        normalizedBaseQty: slice.sliceBaseQty,
        priceUom: effectivePriceUom,
        pricePerPriceUom: pricePerPriceUomMoney,
        entrySource: resolvedEntrySource,
        unitPrice: unitPriceMoney,
        discountAmount: lineCalc.discountAmount,
        taxAmount: lineCalc.totalTaxAmount,
        lineTotal: lineCalc.lineTotalWithTax,
        trackInventory: product.track_inventory,
        trackingMode: product.tracking_mode ?? 'NONE',
        valuationMethod: product.valuation_method ?? 'MOVING_AVG',
        unitCostSnapshot: slice.unitCostSnapshot,
        batchId: slice.batchId,
        batchNumber: slice.batchNumber,
        internalBarcode: slice.internalBarcode,
        expiryDate: slice.expiryDate,
        priceSource: slice.priceSource,
        serialId:
          product.tracking_mode === 'SERIAL' && sIdx === 0 ? serialId : null,
      });
    }
  }

  // Order level discount
  let orderDiscountMoney = Money.zero(currencyCode);
  if (input.orderDiscountAmount) {
    orderDiscountMoney = Money.fromDecimalString(
      input.orderDiscountAmount,
      currencyCode,
    );
    if (orderDiscountMoney.isNegative()) {
      throw new AppError({
        statusCode: 400,
        errorCode: 'ERR_VALIDATION_FAILED',
        title: 'Negative Order Discount Forbidden',
        detail: 'Order discount cannot be negative.',
      });
    }

    // Require TENANT_OWNER, ORG_ADMIN, or BRANCH_MANAGER for arbitrary order-level discounts (BUG-096)
    const discountAuthCtx = await resolveMemberAuthorizationContext(trx);
    const isPrivileged = discountAuthCtx.roleCodes.some(
      (code) =>
        code === 'TENANT_OWNER' ||
        code === 'ORG_ADMIN' ||
        code === 'BRANCH_MANAGER',
    );
    if (!isPrivileged) {
      throw new AppError({
        statusCode: 403,
        errorCode: 'POS_UNAUTHORIZED_DISCOUNT',
        title: 'Unauthorized Order Discount',
        detail: 'Cashiers are not permitted to apply arbitrary order discounts without supervisor authorization.',
      });
    }
  }

  const totalDiscountMoney = totalLineDiscounts.add(orderDiscountMoney);
  const netSubtotalMoney = subtotalAccumulator.subtract(totalDiscountMoney);
  const grandTotalMoney = netSubtotalMoney.add(totalTaxes);

  // 4b. Pre-validate available stock for all trackable items in the cart (BUG-020)
  if (!allowNegative) {
    const requiredQuantitiesByProduct = new Map<
      string,
      { qty: Quantity; sku: string; name: string }
    >();
    for (const line of processedLines) {
      if (line.trackInventory) {
        const existing = requiredQuantitiesByProduct.get(line.productId);
        if (existing) {
          existing.qty = existing.qty.add(line.normalizedBaseQty);
        } else {
          requiredQuantitiesByProduct.set(line.productId, {
            qty: line.normalizedBaseQty,
            sku: line.sku,
            name: line.productName,
          });
        }
      }
    }

    for (const [productId, req] of requiredQuantitiesByProduct.entries()) {
      const balanceRow = await trx.db
        .selectFrom('inventory_balances')
        .select(['qty_on_hand', 'qty_reserved'])
        .where('tenant_id', '=', trx.tenantId)
        .where('warehouse_id', '=', register.warehouse_id)
        .where('product_id', '=', productId)
        .forUpdate()
        .executeTakeFirst();

      const onHand = balanceRow
        ? Quantity.fromDecimalString(String(balanceRow.qty_on_hand))
        : Quantity.zero();
      const reserved = balanceRow
        ? Quantity.fromDecimalString(String(balanceRow.qty_reserved))
        : Quantity.zero();
      const available = onHand.subtract(reserved);

      if (available.compare(req.qty) < 0) {
        throw new AppError({
          statusCode: 409,
          errorCode: 'INV_INSUFFICIENT_AVAILABLE_STOCK',
          title: 'Insufficient Available Stock',
          detail: `Product "${req.name}" (${req.sku}) has only ${available.toDecimalString()} available in warehouse, but ${req.qty.toDecimalString()} was requested in cart.`,
          extensions: {
            productId,
            available: available.toDecimalString(),
            requested: req.qty.toDecimalString(),
          },
        });
      }
    }
  }

  // Validate Payments
  if (input.payments.length === 0) {
    throw new AppError({
      statusCode: 422,
      errorCode: 'POS_INSUFFICIENT_PAYMENT',
      title: 'Payment Required',
      detail: 'At least one payment method is required to complete the sale.',
    });
  }

  // Pre-validate Customer Credit if paying by CREDIT
  const creditPayment = input.payments.find((p) => p.paymentMethod === 'CREDIT');
  let customerCreditAccount: {
    id: string;
    customer_id: string;
    credit_limit: string | number;
    current_balance: string | number;
    available_credit: string | number;
    status: string;
    hold_reason: string | null;
    credit_terms: string;
    custom_term_days: number | null;
  } | null = null;

  if (creditPayment) {
    if (!input.customerId) {
      throw new AppError({
        statusCode: 400,
        errorCode: 'CREDIT_CUSTOMER_REQUIRED_FOR_CREDIT_SALE',
        title: 'Customer Required for Credit Sale',
        detail: 'Credit payment method requires selecting a customer with an active credit account.',
      });
    }

    const creditAcc = await trx.db
      .selectFrom('customer_credit_accounts')
      .select([
        'id',
        'customer_id',
        'credit_limit',
        'current_balance',
        'available_credit',
        'status',
        'hold_reason',
        'credit_terms',
        'custom_term_days',
      ])
      .where('tenant_id', '=', trx.tenantId)
      .where('customer_id', '=', input.customerId)
      .forUpdate()
      .executeTakeFirst();

    if (!creditAcc) {
      throw new AppError({
        statusCode: 404,
        errorCode: 'CREDIT_ACCOUNT_NOT_FOUND',
        title: 'Credit Account Not Found',
        detail: `No customer credit account found for customer "${input.customerId}".`,
      });
    }

    if (creditAcc.status !== 'ACTIVE') {
      throw new AppError({
        statusCode: 409,
        errorCode: 'CREDIT_ACCOUNT_NOT_ACTIVE',
        title: 'Customer Credit Account Not Active',
        detail: `Credit account is currently ${creditAcc.status}${creditAcc.hold_reason ? `: ${creditAcc.hold_reason}` : ''}.`,
      });
    }

    const creditPayAmount = Money.fromDecimalString(creditPayment.amount, currencyCode);
    const availableCreditMoney = Money.fromDecimalString(String(creditAcc.available_credit), currencyCode);

    if (creditPayAmount.compare(availableCreditMoney) > 0) {
      const creditAuthCtx = await resolveMemberAuthorizationContext(trx);
      const canOverride = creditAuthCtx.roleCodes.some(
        (code) =>
          code === 'TENANT_OWNER' ||
          code === 'ORG_ADMIN' ||
          code === 'BRANCH_MANAGER',
      );

      if (!canOverride) {
        throw new AppError({
          statusCode: 409,
          errorCode: 'CREDIT_LIMIT_EXCEEDED',
          title: 'Credit Limit Exceeded',
          detail: `Credit sale of LKR ${creditPayAmount.toDecimalString()} exceeds available credit of LKR ${availableCreditMoney.toDecimalString()}. Supervisor approval is required.`,
        });
      }
    }

    customerCreditAccount = creditAcc;
  }

  let totalPaidMoney = Money.zero(currencyCode);
  let totalTenderedMoney = Money.zero(currencyCode);
  let totalChangeGivenMoney = Money.zero(currencyCode);

  for (const pay of input.payments) {
    const payAmount = Money.fromDecimalString(pay.amount, currencyCode);
    const payTendered = Money.fromDecimalString(pay.tenderedAmount, currencyCode);

    if (!payAmount.isPositive()) {
      throw new AppError({
        statusCode: 400,
        errorCode: 'ERR_VALIDATION_FAILED',
        title: 'Invalid Payment Amount',
        detail: 'Payment amount must be strictly positive.',
      });
    }

    if (pay.paymentMethod === 'CASH') {
      if (payTendered.compare(payAmount) < 0) {
        throw new AppError({
          statusCode: 422,
          errorCode: 'POS_INSUFFICIENT_PAYMENT',
          title: 'Insufficient Cash Tendered',
          detail: `Tendered amount "${payTendered.toDecimalString()}" is less than payment amount "${payAmount.toDecimalString()}".`,
        });
      }
      const changeDue = payTendered.subtract(payAmount);
      totalChangeGivenMoney = totalChangeGivenMoney.add(changeDue);
    } else {
      // CARD or OTHER: tendered must equal amount
      if (!payTendered.equals(payAmount)) {
        throw new AppError({
          statusCode: 400,
          errorCode: 'ERR_VALIDATION_FAILED',
          title: 'Non-Cash Tender Mismatch',
          detail: 'For non-cash payments, tendered amount must equal the payment amount.',
        });
      }
    }

    totalPaidMoney = totalPaidMoney.add(payAmount);
    totalTenderedMoney = totalTenderedMoney.add(payTendered);
  }

  if (totalPaidMoney.compare(grandTotalMoney) < 0) {
    throw new AppError({
      statusCode: 422,
      errorCode: 'POS_INSUFFICIENT_PAYMENT',
      title: 'Insufficient Total Payment',
      detail: `Total paid "${totalPaidMoney.toDecimalString()}" is less than grand total "${grandTotalMoney.toDecimalString()}".`,
    });
  }

  // 5. ATOMIC INVENTORY DEDUCTIONS
  // For each trackable product, deduct stock via the established immutable ledger
  const balanceAfterByProduct = new Map<string, string>();
  const batchAvailableAfterByBatch = new Map<string, string>();

  for (const line of processedLines) {
    if (line.trackInventory) {
      const deductionQtyStr = `-${line.quantity.toDecimalString()}`;
      const lineMoveIdempotencyKey = generateUuidV7();

      const moveResult = await postStockMovement(
        trx,
        lineMoveIdempotencyKey,
        {
          branchId: register.branch_id,
          warehouseId: register.warehouse_id,
          productId: line.productId,
          batchId: line.batchId ?? null,
          serialId: line.serialId ?? null,
          movementType: 'STOCK_OUT',
          quantity: deductionQtyStr,
          uomCode: line.uomCode,
          unitCost: line.unitCostSnapshot,
          referenceType: 'POS_SALE',
          referenceId: saleId,
          entrySource:
            line.entrySource === 'MANUAL_WEIGHT' ||
            line.entrySource === 'SCALE_WEIGHT'
              ? line.entrySource
              : 'POS_SALE',
          allowNegativeStockOverride: input.allowNegativeStockOverride ?? false,
          overrideReason: input.overrideReason ?? null,
        },
        { skipPermissionCheck: true, skipRealtimePublish: true },
      );

      balanceAfterByProduct.set(line.productId, moveResult.balanceAfter);
      if (line.batchId) {
        const bSnap = await trx.db
          .selectFrom('inventory_batches')
          .select(['current_quantity'])
          .where('tenant_id', '=', trx.tenantId)
          .where('id', '=', line.batchId)
          .executeTakeFirst();
        if (bSnap) {
          batchAvailableAfterByBatch.set(
            line.batchId,
            Quantity.fromDecimalString(String(bSnap.current_quantity)).toDecimalString(),
          );
        }
      }
    }
  }

  // 6. INSERT SALE HEADER
  let assignedShiftId: string | null = input.shiftId ?? null;
  if (!assignedShiftId) {
    const activeShiftRow = await trx.db
      .selectFrom('pos_shifts')
      .select(['id'])
      .where('tenant_id', '=', trx.tenantId)
      .where('register_id', '=', register.id)
      .where('status', '=', 'OPEN')
      .executeTakeFirst();
    if (activeShiftRow) {
      assignedShiftId = activeShiftRow.id;
    }
  }

  const invoiceRow = await trx.db
    .insertInto('sales_invoices')
    .values({
      id: saleId,
      tenant_id: trx.tenantId,
      branch_id: register.branch_id,
      warehouse_id: register.warehouse_id,
      register_id: register.id,
      shift_id: assignedShiftId,
      customer_id: input.customerId ?? null,
      cashier_user_id: trx.userId,
      invoice_number: invoiceNumber,
      status: 'COMPLETED',
      currency_code: currencyCode,
      exchange_rate_to_base: '1.00000000',
      subtotal_amount: subtotalAccumulator.toDecimalString(),
      discount_amount: totalDiscountMoney.toDecimalString(),
      tax_amount: totalTaxes.toDecimalString(),
      rounding_adjustment: '0.0000',
      grand_total: grandTotalMoney.toDecimalString(),
      total_paid: totalPaidMoney.toDecimalString(),
      change_given: totalChangeGivenMoney.toDecimalString(),
      customer_name: input.customerName?.trim() || null,
      notes: input.notes?.trim() || null,
      voided_at: null,
      void_reason: null,
      voided_by_user_id: null,
      idempotency_key: idempotencyKey,
      metadata_json: JSON.stringify({ traceId: trx.tenantContext.traceId }),
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  // 7. INSERT IMMUTABLE LINE SNAPSHOTS
  const lineResponses: Array<{
    id: string;
    lineNumber: number;
    productId: string;
    sku: string;
    productName: string;
    uomCode: string;
    quantity: string;
    unitPrice: string;
    discountAmount: string;
    taxAmount: string;
    lineTotal: string;
    unitCostSnapshot?: string;
    batchId?: string | null;
    batchNumber?: string | null;
    internalBarcode?: string | null;
    expiryDate?: string | null;
    priceSource?:
      | 'BATCH_EXPLICIT'
      | 'POS_MANUAL_OVERRIDE'
      | 'PRODUCT_FALLBACK'
      | 'BRANCH_OVERRIDE'
      | 'GLOBAL_PRODUCT'
      | null;
    serialId?: string | null;
    originalEnteredQty?: string | null;
    originalUomCode?: string | null;
    conversionFactorToBase?: string | null;
    normalizedBaseQty?: string | null;
    priceUom?: string | null;
    pricePerPriceUom?: string | null;
    entrySource?: string;
  }> = [];

  for (const line of processedLines) {
    const lineId = generateUuidV7();
    await trx.db
      .insertInto('sales_invoice_lines')
      .values({
        id: lineId,
        tenant_id: trx.tenantId,
        invoice_id: saleId,
        line_number: line.lineNumber,
        product_id: line.productId,
        sku: line.sku,
        product_name: line.productName,
        uom_code: line.uomCode,
        quantity: line.quantity.toDecimalString(),
        unit_price: line.unitPrice.toDecimalString(),
        discount_amount: line.discountAmount.toDecimalString(),
        tax_amount: line.taxAmount.toDecimalString(),
        line_total: line.lineTotal.toDecimalString(),
        tax_rate_snapshot: JSON.stringify({}),
        unit_cost_snapshot: line.unitCostSnapshot,
        batch_id: line.batchId ?? null,
        serial_id: line.serialId ?? null,
        original_entered_qty: line.quantity.toDecimalString(),
        original_uom_code: line.uomCode,
        conversion_factor_to_base: line.conversionFactorToBase,
        normalized_base_qty: line.normalizedBaseQty.toDecimalString(),
        price_uom: line.priceUom,
        price_per_price_uom: line.pricePerPriceUom.toDecimalString(),
        entry_source: line.entrySource,
      })
      .execute();

    lineResponses.push({
      id: lineId,
      lineNumber: line.lineNumber,
      productId: line.productId,
      sku: line.sku,
      productName: line.productName,
      uomCode: line.uomCode,
      quantity: line.quantity.toDecimalString(),
      unitPrice: line.unitPrice.toDecimalString(),
      discountAmount: line.discountAmount.toDecimalString(),
      taxAmount: line.taxAmount.toDecimalString(),
      lineTotal: line.lineTotal.toDecimalString(),
      unitCostSnapshot: line.unitCostSnapshot,
      batchId: line.batchId ?? null,
      batchNumber: line.batchNumber ?? null,
      internalBarcode: line.internalBarcode ?? null,
      expiryDate: line.expiryDate ?? null,
      priceSource: line.priceSource ?? null,
      serialId: line.serialId ?? null,
      originalEnteredQty: line.quantity.toDecimalString(),
      originalUomCode: line.uomCode,
      conversionFactorToBase: line.conversionFactorToBase,
      normalizedBaseQty: line.normalizedBaseQty.toDecimalString(),
      priceUom: line.priceUom,
      pricePerPriceUom: line.pricePerPriceUom.toDecimalString(),
      entrySource: line.entrySource,
    });
  }

  // 8. INSERT PAYMENT RECORDS
  const paymentResponses: Array<{
    id: string;
    paymentMethod: 'CASH' | 'CARD' | 'OTHER' | 'CREDIT' | 'BANK_TRANSFER' | 'CHEQUE';
    amount: string;
    currencyCode: string;
    status: 'COMPLETED' | 'VOIDED';
    tenderedAmount: string;
    changeAmount: string;
    cardReference: string | null;
    cardLastFour: string | null;
    createdAt: string;
  }> = [];

  for (const pay of input.payments) {
    const paymentId = generateUuidV7();
    const payAmountMoney = Money.fromDecimalString(pay.amount, currencyCode);
    const payTenderedMoney = Money.fromDecimalString(pay.tenderedAmount, currencyCode);
    const changeDueMoney =
      pay.paymentMethod === 'CASH'
        ? payTenderedMoney.subtract(payAmountMoney)
        : Money.zero(currencyCode);

    const payRow = await trx.db
      .insertInto('sales_payments')
      .values({
        id: paymentId,
        tenant_id: trx.tenantId,
        invoice_id: saleId,
        payment_method: pay.paymentMethod,
        amount: payAmountMoney.toDecimalString(),
        currency_code: currencyCode,
        status: 'COMPLETED',
        tendered_amount: payTenderedMoney.toDecimalString(),
        change_amount: changeDueMoney.toDecimalString(),
        card_reference: pay.cardReference?.trim() || null,
        card_last_four: pay.cardLastFour?.trim() || null,
        notes: pay.notes?.trim() || null,
        recorded_by_user_id: trx.userId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    if (customerCreditAccount && pay.paymentMethod === 'CREDIT') {
      let daysToAdd = 30;
      if (customerCreditAccount.credit_terms === 'IMMEDIATE') daysToAdd = 0;
      else if (customerCreditAccount.credit_terms === 'NET_7') daysToAdd = 7;
      else if (customerCreditAccount.credit_terms === 'NET_14') daysToAdd = 14;
      else if (customerCreditAccount.credit_terms === 'NET_30') daysToAdd = 30;
      else if (customerCreditAccount.credit_terms === 'NET_60') daysToAdd = 60;
      else if (customerCreditAccount.credit_terms === 'NET_90') daysToAdd = 90;
      else if (customerCreditAccount.credit_terms === 'CUSTOM') daysToAdd = customerCreditAccount.custom_term_days ?? 30;

      const dueDateObj = new Date();
      dueDateObj.setDate(dueDateObj.getDate() + daysToAdd);
      const dueDateStr = dueDateObj.toISOString().slice(0, 10);

      const txRef = `CTX-${new Date().toISOString().slice(0, 7).replace('-', '')}-${generateUuidV7().slice(-5).toUpperCase()}`;
      const prevBalMoney = Money.fromDecimalString(String(customerCreditAccount.current_balance), currencyCode);
      const newBalMoney = prevBalMoney.add(payAmountMoney);
      const creditLimitMoney = Money.fromDecimalString(String(customerCreditAccount.credit_limit), currencyCode);
      const newAvailMoney = creditLimitMoney.compare(newBalMoney) > 0 ? creditLimitMoney.subtract(newBalMoney) : Money.zero(currencyCode);

      await trx.db.insertInto('customer_credit_transactions').values({
        id: generateUuidV7(),
        tenant_id: trx.tenantId,
        account_id: customerCreditAccount.id,
        customer_id: customerCreditAccount.customer_id,
        branch_id: register.branch_id,
        transaction_reference: txRef,
        transaction_type: 'CREDIT_SALE',
        entry_direction: 'DEBIT',
        amount: payAmountMoney.toDecimalString(),
        currency_code: 'LKR',
        balance_after: newBalMoney.toDecimalString(),
        unpaid_amount: payAmountMoney.toDecimalString(),
        transaction_date: sql<string>`CURRENT_DATE`,
        due_date: dueDateStr,
        source_reference_type: 'POS_SALE',
        source_reference_id: saleId,
        source_reference_number: invoiceNumber,
        description: `POS Credit Sale - Invoice #${invoiceNumber}`,
        created_by_user_id: trx.userId,
      }).execute();

      await trx.db.updateTable('customer_credit_accounts')
        .set({
          current_balance: newBalMoney.toDecimalString(),
          available_credit: newAvailMoney.toDecimalString(),
          total_credit_sales: sql`total_credit_sales + ${payAmountMoney.toDecimalString()}::numeric`,
          updated_at: sql<Date>`clock_timestamp()`,
        })
        .where('tenant_id', '=', trx.tenantId)
        .where('id', '=', customerCreditAccount.id)
        .execute();
    }

    paymentResponses.push({
      id: payRow.id,
      paymentMethod: payRow.payment_method,
      amount: Money.fromDecimalString(payRow.amount, currencyCode).toDecimalString(),
      currencyCode: payRow.currency_code,
      status: payRow.status,
      tenderedAmount: Money.fromDecimalString(
        payRow.tendered_amount,
        currencyCode,
      ).toDecimalString(),
      changeAmount: Money.fromDecimalString(
        payRow.change_amount,
        currencyCode,
      ).toDecimalString(),
      cardReference: payRow.card_reference,
      cardLastFour: payRow.card_last_four,
      createdAt: payRow.created_at.toISOString(),
    });
  }

  // 9. AUDIT LOG & OUTBOX EVENT
  await appendAuditLog(trx, {
    action: 'pos:sale:create',
    resourceType: 'sales_invoices',
    resourceId: saleId,
    metadata: {
      invoiceNumber,
      grandTotal: grandTotalMoney.toDecimalString(),
      lineCount: processedLines.length,
    },
  });

  await enqueueOutboxEvent(trx, {
    eventType: 'PosSaleCompletedEvent',
    aggregateType: 'sales_invoices',
    aggregateId: saleId,
    payload: {
      invoiceId: saleId,
      invoiceNumber,
      grandTotal: grandTotalMoney.toDecimalString(),
      cashierUserId: trx.userId,
    },
  });

  realtimeEventHub.publish({
    tenantId: trx.tenantId,
    branchId: register.branch_id,
    eventType: 'STOCK_CHANGED',
    data: {
      saleId,
      invoiceNumber,
      registerId: register.id,
      warehouseId: register.warehouse_id,
      movementType: 'POS_SALE',
      lines: processedLines.map((l) => ({
        productId: l.productId,
        batchId: l.batchId ?? null,
        quantity: l.quantity.toDecimalString(),
        uomCode: l.uomCode,
        qtyDelta: l.normalizedBaseQty.negate().toDecimalString(),
        balanceAfter: balanceAfterByProduct.get(l.productId) ?? null,
        batchAvailableAfter: l.batchId
          ? (batchAvailableAfterByBatch.get(l.batchId) ?? null)
          : null,
      })),
    },
  });

  if (creditPayment && customerCreditAccount) {
    realtimeEventHub.publish({
      tenantId: trx.tenantId,
      branchId: register.branch_id,
      eventType: 'CREDIT_ACCOUNT_CHANGED',
      data: {
        accountId: customerCreditAccount.id,
        customerId: customerCreditAccount.customer_id,
      },
    });
  }

  return {
    id: invoiceRow.id,
    invoiceNumber: invoiceRow.invoice_number,
    status: invoiceRow.status,
    branchId: invoiceRow.branch_id,
    warehouseId: invoiceRow.warehouse_id,
    registerId: invoiceRow.register_id,
    shiftId: invoiceRow.shift_id,
    cashierUserId: invoiceRow.cashier_user_id,
    ...(invoiceRow.customer_id ? { customerId: invoiceRow.customer_id } : {}),
    customerName: invoiceRow.customer_name,
    currencyCode: invoiceRow.currency_code,
    subtotalAmount: Money.fromDecimalString(
      invoiceRow.subtotal_amount,
      currencyCode,
    ).toDecimalString(),
    discountAmount: Money.fromDecimalString(
      invoiceRow.discount_amount,
      currencyCode,
    ).toDecimalString(),
    taxAmount: Money.fromDecimalString(
      invoiceRow.tax_amount,
      currencyCode,
    ).toDecimalString(),
    roundingAdjustment: Money.fromDecimalString(
      invoiceRow.rounding_adjustment,
      currencyCode,
    ).toDecimalString(),
    grandTotal: Money.fromDecimalString(
      invoiceRow.grand_total,
      currencyCode,
    ).toDecimalString(),
    totalPaid: Money.fromDecimalString(
      invoiceRow.total_paid,
      currencyCode,
    ).toDecimalString(),
    changeGiven: Money.fromDecimalString(
      invoiceRow.change_given,
      currencyCode,
    ).toDecimalString(),
    createdAt: invoiceRow.created_at.toISOString(),
    voidedAt: invoiceRow.voided_at
      ? (invoiceRow.voided_at as Date).toISOString()
      : null,
    voidReason: invoiceRow.void_reason,
    lines: lineResponses,
    payments: paymentResponses,
  };
}

// ============================================================================
// 5. SALE VOID & COMPENSATING RESTOCK
// ============================================================================

export async function voidSale(
  trx: TenantTransactionContext,
  saleId: string,
  input: VoidSaleRequest,
): Promise<SalesInvoiceResponse> {
  await assertSubscriptionEntitlement(trx, { requireWriteAccess: true });

  const sale = await trx.db
    .selectFrom('sales_invoices')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', saleId)
    .forUpdate()
    .executeTakeFirst();

  if (!sale) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'POS_SALE_NOT_FOUND',
      title: 'Sale Not Found',
      detail: `Sales invoice "${saleId}" was not found.`,
    });
  }

  if (sale.status === 'VOIDED') {
    throw new AppError({
      statusCode: 409,
      errorCode: 'POS_SALE_ALREADY_VOIDED',
      title: 'Sale Already Voided',
      detail: `Sales invoice "${sale.invoice_number}" is already voided.`,
    });
  }

  await assertAuthorized(trx, {
    permission: 'pos:sale:void',
    branchId: sale.branch_id,
    warehouseId: sale.warehouse_id,
  });

  const lines = await trx.db
    .selectFrom('sales_invoice_lines')
    .innerJoin('products', (join) =>
      join
        .onRef('sales_invoice_lines.tenant_id', '=', 'products.tenant_id')
        .onRef('sales_invoice_lines.product_id', '=', 'products.id'),
    )
    .select([
      'sales_invoice_lines.id',
      'sales_invoice_lines.line_number',
      'sales_invoice_lines.product_id',
      'sales_invoice_lines.sku',
      'sales_invoice_lines.product_name',
      'sales_invoice_lines.uom_code',
      'sales_invoice_lines.quantity',
      'sales_invoice_lines.unit_price',
      'sales_invoice_lines.discount_amount',
      'sales_invoice_lines.tax_amount',
      'sales_invoice_lines.line_total',
      'sales_invoice_lines.unit_cost_snapshot',
      'sales_invoice_lines.batch_id',
      'sales_invoice_lines.serial_id',
      'products.track_inventory',
    ])
    .where('sales_invoice_lines.tenant_id', '=', trx.tenantId)
    .where('sales_invoice_lines.invoice_id', '=', saleId)
    .orderBy('sales_invoice_lines.line_number', 'asc')
    .execute();

  // Restock each trackable line item via CUSTOMER_RETURN_RESTOCK
  for (const line of lines) {
    if (line.track_inventory) {
      const restockIdempotencyKey = generateUuidV7();
      await postStockMovement(
        trx,
        restockIdempotencyKey,
        {
          branchId: sale.branch_id,
          warehouseId: sale.warehouse_id,
          productId: line.product_id,
          batchId: line.batch_id ?? null,
          serialId: line.serial_id ?? null,
          movementType: 'CUSTOMER_RETURN_RESTOCK',
          quantity: line.quantity,
          uomCode: line.uom_code,
          unitCost: line.unit_cost_snapshot,
          referenceType: 'POS_SALE_VOID',
          referenceId: saleId,
          reason: `Void invoice ${sale.invoice_number}: ${input.reason}`,
        },
        { skipPermissionCheck: true },
      );
    }
  }

  const voidDate = new Date();
  const updatedSale = await trx.db
    .updateTable('sales_invoices')
    .set({
      status: 'VOIDED',
      voided_at: voidDate,
      void_reason: input.reason.trim(),
      voided_by_user_id: trx.userId,
    })
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', saleId)
    .returningAll()
    .executeTakeFirstOrThrow();

  await trx.db
    .updateTable('sales_payments')
    .set({ status: 'VOIDED' })
    .where('tenant_id', '=', trx.tenantId)
    .where('invoice_id', '=', saleId)
    .execute();

  const payments = await trx.db
    .selectFrom('sales_payments')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('invoice_id', '=', saleId)
    .execute();

  await appendAuditLog(trx, {
    action: 'pos:sale:void',
    resourceType: 'sales_invoices',
    resourceId: saleId,
    metadata: {
      invoiceNumber: sale.invoice_number,
      reason: input.reason,
    },
  });

  return {
    id: updatedSale.id,
    invoiceNumber: updatedSale.invoice_number,
    status: updatedSale.status,
    branchId: updatedSale.branch_id,
    warehouseId: updatedSale.warehouse_id,
    registerId: updatedSale.register_id,
    shiftId: updatedSale.shift_id,
    cashierUserId: updatedSale.cashier_user_id,
    customerName: updatedSale.customer_name,
    currencyCode: updatedSale.currency_code,
    subtotalAmount: Money.fromDecimalString(
      updatedSale.subtotal_amount,
      updatedSale.currency_code,
    ).toDecimalString(),
    discountAmount: Money.fromDecimalString(
      updatedSale.discount_amount,
      updatedSale.currency_code,
    ).toDecimalString(),
    taxAmount: Money.fromDecimalString(
      updatedSale.tax_amount,
      updatedSale.currency_code,
    ).toDecimalString(),
    roundingAdjustment: Money.fromDecimalString(
      updatedSale.rounding_adjustment,
      updatedSale.currency_code,
    ).toDecimalString(),
    grandTotal: Money.fromDecimalString(
      updatedSale.grand_total,
      updatedSale.currency_code,
    ).toDecimalString(),
    totalPaid: Money.fromDecimalString(
      updatedSale.total_paid,
      updatedSale.currency_code,
    ).toDecimalString(),
    changeGiven: Money.fromDecimalString(
      updatedSale.change_given,
      updatedSale.currency_code,
    ).toDecimalString(),
    createdAt: updatedSale.created_at.toISOString(),
    voidedAt: updatedSale.voided_at
      ? (updatedSale.voided_at as Date).toISOString()
      : null,
    voidReason: updatedSale.void_reason,
    lines: lines.map((l) => ({
      id: l.id,
      lineNumber: l.line_number,
      productId: l.product_id,
      sku: l.sku,
      productName: l.product_name,
      uomCode: l.uom_code,
      quantity: l.quantity,
      unitPrice: Money.fromDecimalString(
        l.unit_price,
        updatedSale.currency_code,
      ).toDecimalString(),
      discountAmount: Money.fromDecimalString(
        l.discount_amount,
        updatedSale.currency_code,
      ).toDecimalString(),
      taxAmount: Money.fromDecimalString(
        l.tax_amount,
        updatedSale.currency_code,
      ).toDecimalString(),
      lineTotal: Money.fromDecimalString(
        l.line_total,
        updatedSale.currency_code,
      ).toDecimalString(),
    })),
    payments: payments.map((p) => ({
      id: p.id,
      paymentMethod: p.payment_method,
      amount: Money.fromDecimalString(
        p.amount,
        updatedSale.currency_code,
      ).toDecimalString(),
      currencyCode: p.currency_code,
      status: p.status,
      tenderedAmount: Money.fromDecimalString(
        p.tendered_amount,
        updatedSale.currency_code,
      ).toDecimalString(),
      changeAmount: Money.fromDecimalString(
        p.change_amount,
        updatedSale.currency_code,
      ).toDecimalString(),
      cardReference: p.card_reference,
      cardLastFour: p.card_last_four,
      createdAt: p.created_at.toISOString(),
    })),
  };
}

// ============================================================================
// 6. SALE DETAIL & SALES HISTORY
// ============================================================================

export async function getSaleById(
  trx: TenantTransactionContext,
  saleId: string,
): Promise<SalesInvoiceResponse> {
  const sale = await trx.db
    .selectFrom('sales_invoices')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', saleId)
    .executeTakeFirst();

  if (!sale) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'POS_SALE_NOT_FOUND',
      title: 'Sale Not Found',
      detail: `Sales invoice "${saleId}" was not found.`,
    });
  }

  await assertAuthorized(trx, {
    permission: 'pos:sale:read',
    branchId: sale.branch_id,
    warehouseId: sale.warehouse_id,
  });

  const lines = await trx.db
    .selectFrom('sales_invoice_lines')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('invoice_id', '=', saleId)
    .orderBy('line_number', 'asc')
    .execute();

  const payments = await trx.db
    .selectFrom('sales_payments')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('invoice_id', '=', saleId)
    .execute();

  return {
    id: sale.id,
    invoiceNumber: sale.invoice_number,
    status: sale.status,
    branchId: sale.branch_id,
    warehouseId: sale.warehouse_id,
    registerId: sale.register_id,
    shiftId: sale.shift_id,
    cashierUserId: sale.cashier_user_id,
    customerName: sale.customer_name,
    currencyCode: sale.currency_code,
    subtotalAmount: Money.fromDecimalString(
      sale.subtotal_amount,
      sale.currency_code,
    ).toDecimalString(),
    discountAmount: Money.fromDecimalString(
      sale.discount_amount,
      sale.currency_code,
    ).toDecimalString(),
    taxAmount: Money.fromDecimalString(
      sale.tax_amount,
      sale.currency_code,
    ).toDecimalString(),
    roundingAdjustment: Money.fromDecimalString(
      sale.rounding_adjustment,
      sale.currency_code,
    ).toDecimalString(),
    grandTotal: Money.fromDecimalString(
      sale.grand_total,
      sale.currency_code,
    ).toDecimalString(),
    totalPaid: Money.fromDecimalString(
      sale.total_paid,
      sale.currency_code,
    ).toDecimalString(),
    changeGiven: Money.fromDecimalString(
      sale.change_given,
      sale.currency_code,
    ).toDecimalString(),
    createdAt: sale.created_at.toISOString(),
    voidedAt: sale.voided_at ? (sale.voided_at as Date).toISOString() : null,
    voidReason: sale.void_reason,
    lines: lines.map((l) => ({
      id: l.id,
      lineNumber: l.line_number,
      productId: l.product_id,
      sku: l.sku,
      productName: l.product_name,
      uomCode: l.uom_code,
      quantity: l.quantity,
      unitPrice: Money.fromDecimalString(
        l.unit_price,
        sale.currency_code,
      ).toDecimalString(),
      discountAmount: Money.fromDecimalString(
        l.discount_amount,
        sale.currency_code,
      ).toDecimalString(),
      taxAmount: Money.fromDecimalString(
        l.tax_amount,
        sale.currency_code,
      ).toDecimalString(),
      lineTotal: Money.fromDecimalString(
        l.line_total,
        sale.currency_code,
      ).toDecimalString(),
      unitCostSnapshot: l.unit_cost_snapshot,
      batchId: l.batch_id ?? null,
      serialId: l.serial_id ?? null,
      originalEnteredQty: l.original_entered_qty
        ? Quantity.fromDecimalString(String(l.original_entered_qty)).toDecimalString()
        : null,
      originalUomCode: l.original_uom_code ?? null,
      conversionFactorToBase: l.conversion_factor_to_base
        ? Quantity.fromDecimalString(String(l.conversion_factor_to_base)).toDecimalString()
        : null,
      normalizedBaseQty: l.normalized_base_qty
        ? Quantity.fromDecimalString(String(l.normalized_base_qty)).toDecimalString()
        : null,
      priceUom: l.price_uom ?? null,
      pricePerPriceUom: l.price_per_price_uom
        ? Money.fromDecimalString(String(l.price_per_price_uom), sale.currency_code).toDecimalString()
        : null,
      entrySource: l.entry_source ?? 'MANUAL',
    })),
    payments: payments.map((p) => ({
      id: p.id,
      paymentMethod: p.payment_method,
      amount: Money.fromDecimalString(
        p.amount,
        sale.currency_code,
      ).toDecimalString(),
      currencyCode: p.currency_code,
      status: p.status,
      tenderedAmount: Money.fromDecimalString(
        p.tendered_amount,
        sale.currency_code,
      ).toDecimalString(),
      changeAmount: Money.fromDecimalString(
        p.change_amount,
        sale.currency_code,
      ).toDecimalString(),
      cardReference: p.card_reference,
      cardLastFour: p.card_last_four,
      createdAt: p.created_at.toISOString(),
    })),
  };
}

export async function listSales(
  trx: TenantTransactionContext,
  query: ListSalesQuery,
): Promise<SalesInvoiceResponse[]> {
  await assertAuthorized(trx, {
    permission: 'pos:sale:read',
  });

  const limit = Math.min(Math.max(Number(query.limit ?? 25), 1), 100);

  let dbQuery = trx.db
    .selectFrom('sales_invoices')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId);

  if (query.registerId) {
    dbQuery = dbQuery.where('register_id', '=', query.registerId);
  }

  if (query.status) {
    dbQuery = dbQuery.where('status', '=', query.status);
  }

  if (query.startDate) {
    dbQuery = dbQuery.where('created_at', '>=', new Date(query.startDate));
  }

  if (query.endDate) {
    dbQuery = dbQuery.where('created_at', '<=', new Date(query.endDate));
  }

  const sales = await dbQuery
    .orderBy('created_at', 'desc')
    .limit(limit)
    .execute();

  if (sales.length === 0) {
    return [];
  }

  const saleIds = sales.map((s) => s.id);
  const allLines = await trx.db
    .selectFrom('sales_invoice_lines')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('invoice_id', 'in', saleIds)
    .orderBy('line_number', 'asc')
    .execute();

  const allPayments = await trx.db
    .selectFrom('sales_payments')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('invoice_id', 'in', saleIds)
    .execute();

  const linesByInvoice = new Map<string, typeof allLines>();
  for (const l of allLines) {
    const list = linesByInvoice.get(l.invoice_id) ?? [];
    list.push(l);
    linesByInvoice.set(l.invoice_id, list);
  }

  const paymentsByInvoice = new Map<string, typeof allPayments>();
  for (const p of allPayments) {
    const list = paymentsByInvoice.get(p.invoice_id) ?? [];
    list.push(p);
    paymentsByInvoice.set(p.invoice_id, list);
  }

  return sales.map((sale) => {
    const lines = linesByInvoice.get(sale.id) ?? [];
    const payments = paymentsByInvoice.get(sale.id) ?? [];

    return {
      id: sale.id,
      invoiceNumber: sale.invoice_number,
      status: sale.status,
      branchId: sale.branch_id,
      warehouseId: sale.warehouse_id,
      registerId: sale.register_id,
      shiftId: sale.shift_id,
      cashierUserId: sale.cashier_user_id,
      customerName: sale.customer_name,
      currencyCode: sale.currency_code,
      subtotalAmount: Money.fromDecimalString(
        sale.subtotal_amount,
        sale.currency_code,
      ).toDecimalString(),
      discountAmount: Money.fromDecimalString(
        sale.discount_amount,
        sale.currency_code,
      ).toDecimalString(),
      taxAmount: Money.fromDecimalString(
        sale.tax_amount,
        sale.currency_code,
      ).toDecimalString(),
      roundingAdjustment: Money.fromDecimalString(
        sale.rounding_adjustment,
        sale.currency_code,
      ).toDecimalString(),
      grandTotal: Money.fromDecimalString(
        sale.grand_total,
        sale.currency_code,
      ).toDecimalString(),
      totalPaid: Money.fromDecimalString(
        sale.total_paid,
        sale.currency_code,
      ).toDecimalString(),
      changeGiven: Money.fromDecimalString(
        sale.change_given,
        sale.currency_code,
      ).toDecimalString(),
      createdAt: sale.created_at.toISOString(),
      voidedAt: sale.voided_at ? (sale.voided_at as Date).toISOString() : null,
      voidReason: sale.void_reason,
      lines: lines.map((l) => ({
        id: l.id,
        lineNumber: l.line_number,
        productId: l.product_id,
        sku: l.sku,
        productName: l.product_name,
        uomCode: l.uom_code,
        quantity: l.quantity,
        unitPrice: Money.fromDecimalString(
          l.unit_price,
          sale.currency_code,
        ).toDecimalString(),
        discountAmount: Money.fromDecimalString(
          l.discount_amount,
          sale.currency_code,
        ).toDecimalString(),
        taxAmount: Money.fromDecimalString(
          l.tax_amount,
          sale.currency_code,
        ).toDecimalString(),
        lineTotal: Money.fromDecimalString(
          l.line_total,
          sale.currency_code,
        ).toDecimalString(),
        originalEnteredQty: l.original_entered_qty
          ? Quantity.fromDecimalString(String(l.original_entered_qty)).toDecimalString()
          : null,
        originalUomCode: l.original_uom_code ?? null,
        conversionFactorToBase: l.conversion_factor_to_base
          ? Quantity.fromDecimalString(String(l.conversion_factor_to_base)).toDecimalString()
          : null,
        normalizedBaseQty: l.normalized_base_qty
          ? Quantity.fromDecimalString(String(l.normalized_base_qty)).toDecimalString()
          : null,
        priceUom: l.price_uom ?? null,
        pricePerPriceUom: l.price_per_price_uom
          ? Money.fromDecimalString(String(l.price_per_price_uom), sale.currency_code).toDecimalString()
          : null,
        entrySource: l.entry_source ?? 'MANUAL',
      })),
      payments: payments.map((p) => ({
        id: p.id,
        paymentMethod: p.payment_method,
        amount: Money.fromDecimalString(
          p.amount,
          sale.currency_code,
        ).toDecimalString(),
        currencyCode: p.currency_code,
        status: p.status,
        tenderedAmount: Money.fromDecimalString(
          p.tendered_amount,
          sale.currency_code,
        ).toDecimalString(),
        changeAmount: Money.fromDecimalString(
          p.change_amount,
          sale.currency_code,
        ).toDecimalString(),
        cardReference: p.card_reference,
        cardLastFour: p.card_last_four,
        createdAt: p.created_at.toISOString(),
      })),
    };
  });
}

export async function getSalesSummary(
  trx: TenantTransactionContext,
  query: SalesSummaryQuery,
): Promise<SalesSummaryResponse> {
  await assertAuthorized(trx, {
    permission: 'pos:sale:read',
  });

  let dbQuery = trx.db
    .selectFrom('sales_invoices')
    .select([
      'status',
      trx.db.fn.count<number | string>('id').as('count'),
      trx.db.fn.coalesce(trx.db.fn.sum<string>('grand_total'), sql`0`).as('total_amount'),
    ])
    .where('tenant_id', '=', trx.tenantId)
    .groupBy('status');

  if (query.registerId) {
    dbQuery = dbQuery.where('register_id', '=', query.registerId);
  }

  if (query.startDate) {
    dbQuery = dbQuery.where('created_at', '>=', new Date(query.startDate));
  }

  if (query.endDate) {
    dbQuery = dbQuery.where('created_at', '<=', new Date(query.endDate));
  }

  const rows = await dbQuery.execute();
  let completedAmount = '0.0000';
  let completedCount = 0;
  let voidedAmount = '0.0000';
  let voidedCount = 0;

  for (const row of rows) {
    if (row.status === 'COMPLETED') {
      completedCount = Number(row.count);
      completedAmount = Number(row.total_amount).toFixed(4);
    } else if (row.status === 'VOIDED') {
      voidedCount = Number(row.count);
      voidedAmount = Number(row.total_amount).toFixed(4);
    }
  }

  return {
    completedAmount,
    completedCount,
    voidedAmount,
    voidedCount,
    totalSalesCount: completedCount + voidedCount,
  };
}

// ============================================================================
// 7. PRINTABLE RECEIPT DATA GENERATION
// ============================================================================

export async function getReceiptData(
  trx: TenantTransactionContext,
  saleId: string,
): Promise<ReceiptResponse> {
  const sale = await trx.db
    .selectFrom('sales_invoices')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', saleId)
    .executeTakeFirst();

  if (!sale) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'POS_SALE_NOT_FOUND',
      title: 'Sale Not Found',
      detail: `Sales invoice "${saleId}" was not found.`,
    });
  }

  await assertAuthorized(trx, {
    permission: 'pos:sale:read',
    branchId: sale.branch_id,
    warehouseId: sale.warehouse_id,
  });

  const tenant = await trx.db
    .selectFrom('tenants')
    .select(['legal_name'])
    .where('id', '=', trx.tenantId)
    .executeTakeFirstOrThrow();

  const branch = await trx.db
    .selectFrom('branches')
    .select(['name'])
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', sale.branch_id)
    .executeTakeFirstOrThrow();

  const register = await trx.db
    .selectFrom('pos_registers')
    .select(['code'])
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', sale.register_id)
    .executeTakeFirstOrThrow();

  const cashier = await trx.db
    .selectFrom('users')
    .select(['full_name'])
    .where('id', '=', sale.cashier_user_id)
    .executeTakeFirstOrThrow();

  const localization = await trx.db
    .selectFrom('tenant_localization_settings')
    .select(['timezone', 'locale'])
    .where('tenant_id', '=', trx.tenantId)
    .executeTakeFirst();

  const lines = await trx.db
    .selectFrom('sales_invoice_lines')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('invoice_id', '=', saleId)
    .orderBy('line_number', 'asc')
    .execute();

  const payments = await trx.db
    .selectFrom('sales_payments')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('invoice_id', '=', saleId)
    .execute();

  return formatReceiptData({
    businessName: tenant.legal_name,
    branchName: branch.name,
    registerCode: register.code,
    invoiceNumber: sale.invoice_number,
    cashierName: cashier.full_name,
    createdAt: sale.created_at,
    timezone: localization?.timezone,
    locale: localization?.locale,
    currencyCode: sale.currency_code,
    lines: lines.map((l) => ({
      sku: l.sku,
      name: l.product_name,
      quantity: l.quantity,
      uomCode: l.uom_code,
      unitPrice: Money.fromDecimalString(
        l.unit_price,
        sale.currency_code,
      ).toDecimalString(),
      discountAmount: Money.fromDecimalString(
        l.discount_amount,
        sale.currency_code,
      ).toDecimalString(),
      taxAmount: Money.fromDecimalString(
        l.tax_amount,
        sale.currency_code,
      ).toDecimalString(),
      lineTotal: Money.fromDecimalString(
        l.line_total,
        sale.currency_code,
      ).toDecimalString(),
      unitCostSnapshot: l.unit_cost_snapshot,
      batchId: l.batch_id ?? null,
      serialId: l.serial_id ?? null,
      originalEnteredQty: l.original_entered_qty
        ? Quantity.fromDecimalString(String(l.original_entered_qty)).toDecimalString()
        : null,
      originalUomCode: l.original_uom_code ?? null,
      conversionFactorToBase: l.conversion_factor_to_base
        ? Quantity.fromDecimalString(String(l.conversion_factor_to_base)).toDecimalString()
        : null,
      normalizedBaseQty: l.normalized_base_qty
        ? Quantity.fromDecimalString(String(l.normalized_base_qty)).toDecimalString()
        : null,
      priceUom: l.price_uom ?? null,
      pricePerPriceUom: l.price_per_price_uom
        ? Money.fromDecimalString(String(l.price_per_price_uom), sale.currency_code).toDecimalString()
        : null,
      entrySource: l.entry_source ?? 'MANUAL',
    })),
    subtotalAmount: Money.fromDecimalString(
      sale.subtotal_amount,
      sale.currency_code,
    ).toDecimalString(),
    discountAmount: Money.fromDecimalString(
      sale.discount_amount,
      sale.currency_code,
    ).toDecimalString(),
    taxAmount: Money.fromDecimalString(
      sale.tax_amount,
      sale.currency_code,
    ).toDecimalString(),
    grandTotal: Money.fromDecimalString(
      sale.grand_total,
      sale.currency_code,
    ).toDecimalString(),
    payments: payments.map((p) => ({
      method: p.payment_method,
      amount: Money.fromDecimalString(
        p.amount,
        sale.currency_code,
      ).toDecimalString(),
      tenderedAmount: Money.fromDecimalString(
        p.tendered_amount,
        sale.currency_code,
      ).toDecimalString(),
      changeAmount: Money.fromDecimalString(
        p.change_amount,
        sale.currency_code,
      ).toDecimalString(),
    })),
    changeGiven: Money.fromDecimalString(
      sale.change_given,
      sale.currency_code,
    ).toDecimalString(),
    notes: sale.notes,
  });
}

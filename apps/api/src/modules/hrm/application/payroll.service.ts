import type {
  CreatePayrollRunRequest,
  PayrollFrequency,
  PayrollPaymentResponse,
  PayrollPaymentStatus,
  PayrollReportSummaryResponse,
  PayrollRunItemResponse,
  PayrollRunResponse,
  PayrollRunStatus,
  PayslipResponse,
  RecordPayrollPaymentRequest,
  UpdatePayrollItemRequest,
} from '@nexstock/contracts';
import {
  MONEY_INTERNAL_SCALE,
  Money,
  divideAndRoundBigInt,
  parseDecimalStringToScaledBigInt,
} from '@nexstock/domain-core';
import { assertAuthorized } from '../../iam/index.js';
import {
  AppError,
  type TenantTransactionContext,
  appendAuditLog,
  generateUuidV7,
} from '../../shared/index.js';

export interface ComponentSnapshotItem {
  readonly name: string;
  readonly type: 'EARNING' | 'DEDUCTION';
  readonly calculationType: 'FIXED_AMOUNT' | 'PERCENTAGE_OF_BASIC';
  readonly value: string;
  readonly amount: string;
  readonly isTaxable: boolean;
  readonly isStatutory: boolean;
}

function formatDate(d: Date | string | null): string {
  if (!d) return '';
  if (typeof d === 'string') return d.substring(0, 10);
  return d.toISOString().substring(0, 10);
}

function calculateComponentAmount(
  basicMoney: Money,
  comp: {
    calculation_type: 'FIXED_AMOUNT' | 'PERCENTAGE_OF_BASIC';
    component_value: string;
  },
  currencyCode: string,
): Money {
  if (comp.calculation_type === 'FIXED_AMOUNT') {
    return Money.fromDecimalString(comp.component_value, currencyCode);
  }

  // PERCENTAGE_OF_BASIC:
  // parse percentage to scaled bigint (4 decimals, e.g. 10.0000 = 100_000n)
  const percentScaled = parseDecimalStringToScaledBigInt(
    comp.component_value,
    MONEY_INTERNAL_SCALE,
    'HALF_EVEN',
  );

  // amountScaled = (basicScaled * percentScaled) / (100 * 10_000)
  const product = basicMoney.scaledUnits * percentScaled;
  const divisor = 100n * 10_000n;
  const amountScaled = divideAndRoundBigInt(product, divisor, 'HALF_EVEN');

  return Money.fromScaledUnits(amountScaled, currencyCode);
}

export async function createPayrollRun(
  trx: TenantTransactionContext,
  input: CreatePayrollRunRequest,
): Promise<PayrollRunResponse> {
  await assertAuthorized(trx, { permission: 'hrm:payroll:process' });

  // Check if active run exists for the same period and frequency
  const existingRun = await trx.db
    .selectFrom('payroll_runs')
    .select(['id', 'run_number', 'status'])
    .where('tenant_id', '=', trx.tenantId)
    .where('frequency', '=', input.frequency)
    .where('period_start', '=', input.periodStart)
    .where('period_end', '=', input.periodEnd)
    .where('status', '!=', 'CANCELLED')
    .executeTakeFirst();

  if (existingRun) {
    throw new AppError({
      statusCode: 409,
      errorCode: 'HRM_PAYROLL_RUN_ALREADY_EXISTS',
      title: 'Payroll Run Already Exists',
      detail: `An active payroll run (${existingRun.run_number}) already exists for ${input.frequency} period ${input.periodStart} to ${input.periodEnd}.`,
    });
  }

  // Find eligible active employees for this frequency
  const eligibleEmployees = await trx.db
    .selectFrom('employees')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('payroll_frequency', '=', input.frequency)
    .where('employment_status', 'in', ['ACTIVE', 'PROBATION'])
    .orderBy('employee_code', 'asc')
    .execute();

  const runId = generateUuidV7();
  const dateSuffix = input.periodEnd.replace(/-/g, '');
  const randSuffix = Math.floor(1000 + Math.random() * 9000);
  const runNumber = `PR-${dateSuffix}-${input.frequency.substring(0, 3)}-${randSuffix}`;

  let totalGrossMoney = Money.zero(input.currencyCode);
  let totalDeductionsMoney = Money.zero(input.currencyCode);
  let totalNetMoney = Money.zero(input.currencyCode);

  const runItemsToInsert: Array<{
    id: string;
    tenant_id: string;
    payroll_run_id: string;
    employee_id: string;
    basic_salary: string;
    allowances_total: string;
    overtime_hours: string;
    overtime_pay: string;
    bonus_pay: string;
    commissions_pay: string;
    gross_pay: string;
    deductions_total: string;
    net_pay: string;
    paid_amount: string;
    payment_status: PayrollPaymentStatus;
    components_snapshot: string;
    notes: string | null;
  }> = [];

  for (const emp of eligibleEmployees) {
    // Find active salary structure
    const structure = await trx.db
      .selectFrom('employee_salary_structures')
      .selectAll()
      .where('tenant_id', '=', trx.tenantId)
      .where('employee_id', '=', emp.id)
      .where('is_active', '=', true)
      .executeTakeFirst();

    let basicMoney = Money.zero(input.currencyCode);
    let allowancesMoney = Money.zero(input.currencyCode);
    let deductionsMoney = Money.zero(input.currencyCode);
    const snapshot: ComponentSnapshotItem[] = [];

    if (structure) {
      basicMoney = Money.fromDecimalString(
        structure.basic_salary,
        input.currencyCode,
      );

      const components = await trx.db
        .selectFrom('employee_salary_components')
        .selectAll()
        .where('tenant_id', '=', trx.tenantId)
        .where('structure_id', '=', structure.id)
        .where('is_enabled', '=', true)
        .execute();

      for (const comp of components) {
        const compAmount = calculateComponentAmount(
          basicMoney,
          comp,
          input.currencyCode,
        );

        if (comp.component_type === 'EARNING') {
          allowancesMoney = allowancesMoney.add(compAmount);
        } else {
          deductionsMoney = deductionsMoney.add(compAmount);
        }

        snapshot.push({
          name: comp.component_name,
          type: comp.component_type,
          calculationType: comp.calculation_type,
          value: comp.component_value,
          amount: compAmount.toDecimalString(),
          isTaxable: comp.is_taxable,
          isStatutory: comp.is_statutory,
        });
      }
    }

    const grossMoney = basicMoney.add(allowancesMoney);
    const netMoney =
      grossMoney.compare(deductionsMoney) > 0
        ? grossMoney.subtract(deductionsMoney)
        : Money.zero(input.currencyCode);

    totalGrossMoney = totalGrossMoney.add(grossMoney);
    totalDeductionsMoney = totalDeductionsMoney.add(deductionsMoney);
    totalNetMoney = totalNetMoney.add(netMoney);

    runItemsToInsert.push({
      id: generateUuidV7(),
      tenant_id: trx.tenantId,
      payroll_run_id: runId,
      employee_id: emp.id,
      basic_salary: basicMoney.toDecimalString(),
      allowances_total: allowancesMoney.toDecimalString(),
      overtime_hours: '0.0000',
      overtime_pay: Money.zero(input.currencyCode).toDecimalString(),
      bonus_pay: Money.zero(input.currencyCode).toDecimalString(),
      commissions_pay: Money.zero(input.currencyCode).toDecimalString(),
      gross_pay: grossMoney.toDecimalString(),
      deductions_total: deductionsMoney.toDecimalString(),
      net_pay: netMoney.toDecimalString(),
      paid_amount: Money.zero(input.currencyCode).toDecimalString(),
      payment_status: 'UNPAID',
      components_snapshot: JSON.stringify(snapshot),
      notes: null,
    });
  }

  // Insert run
  await trx.db
    .insertInto('payroll_runs')
    .values({
      id: runId,
      tenant_id: trx.tenantId,
      run_number: runNumber,
      frequency: input.frequency,
      period_start: input.periodStart,
      period_end: input.periodEnd,
      payment_date: input.paymentDate,
      currency_code: input.currencyCode,
      status: 'DRAFT',
      total_gross_pay: totalGrossMoney.toDecimalString(),
      total_deductions: totalDeductionsMoney.toDecimalString(),
      total_net_pay: totalNetMoney.toDecimalString(),
      total_paid_amount: Money.zero(input.currencyCode).toDecimalString(),
      employee_count: runItemsToInsert.length,
      created_by_user_id: trx.userId,
      notes: input.notes?.trim() || null,
    })
    .execute();

  // Insert items
  for (const item of runItemsToInsert) {
    await trx.db
      .insertInto('payroll_items')
      .values({
        id: item.id,
        tenant_id: item.tenant_id,
        payroll_run_id: item.payroll_run_id,
        employee_id: item.employee_id,
        basic_salary: item.basic_salary,
        allowances_total: item.allowances_total,
        overtime_hours: item.overtime_hours,
        overtime_pay: item.overtime_pay,
        bonus_pay: item.bonus_pay,
        commissions_pay: item.commissions_pay,
        gross_pay: item.gross_pay,
        deductions_total: item.deductions_total,
        net_pay: item.net_pay,
        paid_amount: item.paid_amount,
        payment_status: item.payment_status,
        components_snapshot: item.components_snapshot as unknown as Record<string, unknown>,
        notes: item.notes,
      })
      .execute();
  }

  await appendAuditLog(trx, {
    action: 'hrm.payroll.run_created',
    resourceType: 'payroll_run',
    resourceId: runId,
    metadata: {
      runNumber,
      frequency: input.frequency,
      employeeCount: runItemsToInsert.length,
      totalNet: totalNetMoney.toDecimalString(),
      currencyCode: input.currencyCode,
    },
  });

  return getPayrollRunById(trx, runId);
}

export async function getPayrollRunById(
  trx: TenantTransactionContext,
  runId: string,
): Promise<PayrollRunResponse> {
  await assertAuthorized(trx, { permission: 'hrm:payroll:read' });

  const run = await trx.db
    .selectFrom('payroll_runs')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', runId)
    .executeTakeFirst();

  if (!run) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'HRM_PAYROLL_RUN_NOT_FOUND',
      title: 'Payroll Run Not Found',
      detail: `Payroll run "${runId}" was not found.`,
    });
  }

  const items = await trx.db
    .selectFrom('payroll_items')
    .innerJoin('employees', (join) =>
      join
        .onRef('employees.tenant_id', '=', 'payroll_items.tenant_id')
        .onRef('employees.id', '=', 'payroll_items.employee_id'),
    )
    .select([
      'payroll_items.id as id',
      'payroll_items.payroll_run_id as payroll_run_id',
      'payroll_items.employee_id as employee_id',
      'employees.employee_code as employee_code',
      'employees.display_name as employee_name',
      'employees.department as department',
      'employees.designation as designation',
      'payroll_items.basic_salary as basic_salary',
      'payroll_items.allowances_total as allowances_total',
      'payroll_items.overtime_hours as overtime_hours',
      'payroll_items.overtime_pay as overtime_pay',
      'payroll_items.bonus_pay as bonus_pay',
      'payroll_items.commissions_pay as commissions_pay',
      'payroll_items.gross_pay as gross_pay',
      'payroll_items.deductions_total as deductions_total',
      'payroll_items.net_pay as net_pay',
      'payroll_items.paid_amount as paid_amount',
      'payroll_items.payment_status as payment_status',
      'payroll_items.components_snapshot as components_snapshot',
      'payroll_items.notes as notes',
    ])
    .where('payroll_items.tenant_id', '=', trx.tenantId)
    .where('payroll_items.payroll_run_id', '=', runId)
    .orderBy('employees.employee_code', 'asc')
    .execute();

  const mappedItems: PayrollRunItemResponse[] = items.map((i) => {
    let snapshotList: unknown[] = [];
    if (typeof i.components_snapshot === 'string') {
      try {
        snapshotList = JSON.parse(i.components_snapshot);
      } catch {
        snapshotList = [];
      }
    } else if (Array.isArray(i.components_snapshot)) {
      snapshotList = i.components_snapshot;
    }

    return {
      id: i.id,
      payrollRunId: i.payroll_run_id,
      employeeId: i.employee_id,
      employeeCode: i.employee_code,
      employeeName: i.employee_name,
      department: i.department,
      designation: i.designation,
      basicSalary: Money.fromDecimalString(
        i.basic_salary,
        run.currency_code,
      ).toDecimalString(),
      allowancesTotal: Money.fromDecimalString(
        i.allowances_total,
        run.currency_code,
      ).toDecimalString(),
      overtimeHours: i.overtime_hours,
      overtimePay: Money.fromDecimalString(
        i.overtime_pay,
        run.currency_code,
      ).toDecimalString(),
      bonusPay: Money.fromDecimalString(
        i.bonus_pay,
        run.currency_code,
      ).toDecimalString(),
      commissionsPay: Money.fromDecimalString(
        i.commissions_pay,
        run.currency_code,
      ).toDecimalString(),
      grossPay: Money.fromDecimalString(
        i.gross_pay,
        run.currency_code,
      ).toDecimalString(),
      deductionsTotal: Money.fromDecimalString(
        i.deductions_total,
        run.currency_code,
      ).toDecimalString(),
      netPay: Money.fromDecimalString(
        i.net_pay,
        run.currency_code,
      ).toDecimalString(),
      paidAmount: Money.fromDecimalString(
        i.paid_amount,
        run.currency_code,
      ).toDecimalString(),
      paymentStatus: i.payment_status as PayrollPaymentStatus,
      componentsSnapshot: snapshotList,
      notes: i.notes,
    };
  });

  return {
    id: run.id,
    runNumber: run.run_number,
    frequency: run.frequency as PayrollFrequency,
    periodStart: formatDate(run.period_start),
    periodEnd: formatDate(run.period_end),
    paymentDate: formatDate(run.payment_date),
    currencyCode: run.currency_code,
    status: run.status as PayrollRunStatus,
    totalGrossPay: Money.fromDecimalString(
      run.total_gross_pay,
      run.currency_code,
    ).toDecimalString(),
    totalDeductions: Money.fromDecimalString(
      run.total_deductions,
      run.currency_code,
    ).toDecimalString(),
    totalNetPay: Money.fromDecimalString(
      run.total_net_pay,
      run.currency_code,
    ).toDecimalString(),
    totalPaidAmount: Money.fromDecimalString(
      run.total_paid_amount,
      run.currency_code,
    ).toDecimalString(),
    employeeCount: run.employee_count,
    createdByUserId: run.created_by_user_id,
    approvedByUserId: run.approved_by_user_id,
    approvedAt: run.approved_at
      ? new Date(run.approved_at).toISOString()
      : null,
    notes: run.notes,
    items: mappedItems,
    createdAt: new Date(run.created_at).toISOString(),
    updatedAt: new Date(run.updated_at).toISOString(),
  };
}

export async function listPayrollRuns(
  trx: TenantTransactionContext,
  options: {
    readonly frequency?: PayrollFrequency | undefined;
    readonly status?: PayrollRunStatus | undefined;
    readonly limit?: number | undefined;
    readonly offset?: number | undefined;
  } = {},
): Promise<PayrollRunResponse[]> {
  await assertAuthorized(trx, { permission: 'hrm:payroll:read' });

  let query = trx.db
    .selectFrom('payroll_runs')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId);

  if (options.frequency) {
    query = query.where('frequency', '=', options.frequency);
  }

  if (options.status) {
    query = query.where('status', '=', options.status);
  }

  const limit = options.limit ?? 50;
  const offset = options.offset ?? 0;

  const rows = await query
    .orderBy('period_end', 'desc')
    .orderBy('created_at', 'desc')
    .limit(limit)
    .offset(offset)
    .execute();

  return rows.map((run) => ({
    id: run.id,
    runNumber: run.run_number,
    frequency: run.frequency as PayrollFrequency,
    periodStart: formatDate(run.period_start),
    periodEnd: formatDate(run.period_end),
    paymentDate: formatDate(run.payment_date),
    currencyCode: run.currency_code,
    status: run.status as PayrollRunStatus,
    totalGrossPay: Money.fromDecimalString(
      run.total_gross_pay,
      run.currency_code,
    ).toDecimalString(),
    totalDeductions: Money.fromDecimalString(
      run.total_deductions,
      run.currency_code,
    ).toDecimalString(),
    totalNetPay: Money.fromDecimalString(
      run.total_net_pay,
      run.currency_code,
    ).toDecimalString(),
    totalPaidAmount: Money.fromDecimalString(
      run.total_paid_amount,
      run.currency_code,
    ).toDecimalString(),
    employeeCount: run.employee_count,
    createdByUserId: run.created_by_user_id,
    approvedByUserId: run.approved_by_user_id,
    approvedAt: run.approved_at
      ? new Date(run.approved_at).toISOString()
      : null,
    notes: run.notes,
    createdAt: new Date(run.created_at).toISOString(),
    updatedAt: new Date(run.updated_at).toISOString(),
  }));
}

export async function updatePayrollItemAdjustments(
  trx: TenantTransactionContext,
  runId: string,
  itemId: string,
  input: UpdatePayrollItemRequest,
): Promise<PayrollRunItemResponse> {
  await assertAuthorized(trx, { permission: 'hrm:payroll:process' });

  const run = await trx.db
    .selectFrom('payroll_runs')
    .select(['id', 'status', 'currency_code'])
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', runId)
    .executeTakeFirst();

  if (!run) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'HRM_PAYROLL_RUN_NOT_FOUND',
      title: 'Payroll Run Not Found',
      detail: `Payroll run "${runId}" was not found.`,
    });
  }

  if (run.status !== 'DRAFT') {
    throw new AppError({
      statusCode: 409,
      errorCode: 'HRM_PAYROLL_RUN_IMMUTABLE',
      title: 'Payroll Run Immutable',
      detail: `Cannot adjust items on payroll run in status "${run.status}". Items are locked after submission or approval.`,
    });
  }

  const item = await trx.db
    .selectFrom('payroll_items')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('payroll_run_id', '=', runId)
    .where('id', '=', itemId)
    .executeTakeFirst();

  if (!item) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'HRM_PAYROLL_ITEM_NOT_FOUND',
      title: 'Payroll Item Not Found',
      detail: `Payroll item "${itemId}" was not found in run "${runId}".`,
    });
  }

  const basicMoney = Money.fromDecimalString(
    item.basic_salary,
    run.currency_code,
  );
  const allowancesMoney = Money.fromDecimalString(
    item.allowances_total,
    run.currency_code,
  );
  const deductionsMoney = Money.fromDecimalString(
    item.deductions_total,
    run.currency_code,
  );

  const overtimePayMoney = input.overtimePay
    ? Money.fromDecimalString(input.overtimePay, run.currency_code)
    : Money.fromDecimalString(item.overtime_pay, run.currency_code);

  const bonusPayMoney = input.bonusPay
    ? Money.fromDecimalString(input.bonusPay, run.currency_code)
    : Money.fromDecimalString(item.bonus_pay, run.currency_code);

  const commissionsPayMoney = input.commissionsPay
    ? Money.fromDecimalString(input.commissionsPay, run.currency_code)
    : Money.fromDecimalString(item.commissions_pay, run.currency_code);

  const newGross = basicMoney
    .add(allowancesMoney)
    .add(overtimePayMoney)
    .add(bonusPayMoney)
    .add(commissionsPayMoney);

  const newNet =
    newGross.compare(deductionsMoney) > 0
      ? newGross.subtract(deductionsMoney)
      : Money.zero(run.currency_code);

  await trx.db
    .updateTable('payroll_items')
    .set({
      overtime_hours: input.overtimeHours ?? item.overtime_hours,
      overtime_pay: overtimePayMoney.toDecimalString(),
      bonus_pay: bonusPayMoney.toDecimalString(),
      commissions_pay: commissionsPayMoney.toDecimalString(),
      gross_pay: newGross.toDecimalString(),
      net_pay: newNet.toDecimalString(),
      notes: input.notes !== undefined ? (input.notes ? input.notes.trim() : null) : item.notes,
      updated_at: new Date(),
    })
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', itemId)
    .execute();

  // Recalculate run totals
  const allItems = await trx.db
    .selectFrom('payroll_items')
    .select(['gross_pay', 'deductions_total', 'net_pay'])
    .where('tenant_id', '=', trx.tenantId)
    .where('payroll_run_id', '=', runId)
    .execute();

  let runGross = Money.zero(run.currency_code);
  let runDeductions = Money.zero(run.currency_code);
  let runNet = Money.zero(run.currency_code);

  for (const it of allItems) {
    runGross = runGross.add(Money.fromDecimalString(it.gross_pay, run.currency_code));
    runDeductions = runDeductions.add(
      Money.fromDecimalString(it.deductions_total, run.currency_code),
    );
    runNet = runNet.add(Money.fromDecimalString(it.net_pay, run.currency_code));
  }

  await trx.db
    .updateTable('payroll_runs')
    .set({
      total_gross_pay: runGross.toDecimalString(),
      total_deductions: runDeductions.toDecimalString(),
      total_net_pay: runNet.toDecimalString(),
      updated_at: new Date(),
    })
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', runId)
    .execute();

  const refreshedRun = await getPayrollRunById(trx, runId);
  const updatedItem = refreshedRun.items?.find((i) => i.id === itemId);
  if (!updatedItem) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'HRM_PAYROLL_ITEM_NOT_FOUND',
      title: 'Payroll Item Not Found',
      detail: `Item "${itemId}" could not be retrieved.`,
    });
  }

  return updatedItem;
}

export async function submitPayrollRunForApproval(
  trx: TenantTransactionContext,
  runId: string,
): Promise<PayrollRunResponse> {
  await assertAuthorized(trx, { permission: 'hrm:payroll:process' });

  const run = await trx.db
    .selectFrom('payroll_runs')
    .select(['id', 'run_number', 'status'])
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', runId)
    .executeTakeFirst();

  if (!run) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'HRM_PAYROLL_RUN_NOT_FOUND',
      title: 'Payroll Run Not Found',
      detail: `Payroll run "${runId}" was not found.`,
    });
  }

  if (run.status !== 'DRAFT') {
    throw new AppError({
      statusCode: 409,
      errorCode: 'HRM_INVALID_PAYROLL_STATUS_TRANSITION',
      title: 'Invalid Status Transition',
      detail: `Cannot submit payroll run in status "${run.status}". Only DRAFT runs can be submitted for approval.`,
    });
  }

  await trx.db
    .updateTable('payroll_runs')
    .set({
      status: 'PENDING_APPROVAL',
      updated_at: new Date(),
    })
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', runId)
    .execute();

  await appendAuditLog(trx, {
    action: 'hrm.payroll.submitted_for_approval',
    resourceType: 'payroll_run',
    resourceId: runId,
    metadata: { runNumber: run.run_number },
  });

  return getPayrollRunById(trx, runId);
}

export async function approvePayrollRun(
  trx: TenantTransactionContext,
  runId: string,
): Promise<PayrollRunResponse> {
  await assertAuthorized(trx, { permission: 'hrm:payroll:approve' });

  const run = await trx.db
    .selectFrom('payroll_runs')
    .select(['id', 'run_number', 'status'])
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', runId)
    .executeTakeFirst();

  if (!run) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'HRM_PAYROLL_RUN_NOT_FOUND',
      title: 'Payroll Run Not Found',
      detail: `Payroll run "${runId}" was not found.`,
    });
  }

  if (run.status !== 'PENDING_APPROVAL' && run.status !== 'DRAFT') {
    throw new AppError({
      statusCode: 409,
      errorCode: 'HRM_INVALID_PAYROLL_STATUS_TRANSITION',
      title: 'Invalid Status Transition',
      detail: `Cannot approve payroll run in status "${run.status}".`,
    });
  }

  await trx.db
    .updateTable('payroll_runs')
    .set({
      status: 'APPROVED',
      approved_by_user_id: trx.userId,
      approved_at: new Date(),
      updated_at: new Date(),
    })
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', runId)
    .execute();

  await appendAuditLog(trx, {
    action: 'hrm.payroll.approved',
    resourceType: 'payroll_run',
    resourceId: runId,
    metadata: {
      runNumber: run.run_number,
      approvedBy: trx.userId,
    },
  });

  return getPayrollRunById(trx, runId);
}

export async function cancelPayrollRun(
  trx: TenantTransactionContext,
  runId: string,
  reason?: string,
): Promise<PayrollRunResponse> {
  await assertAuthorized(trx, { permission: 'hrm:payroll:process' });

  const run = await trx.db
    .selectFrom('payroll_runs')
    .select(['id', 'run_number', 'status', 'total_paid_amount'])
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', runId)
    .executeTakeFirst();

  if (!run) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'HRM_PAYROLL_RUN_NOT_FOUND',
      title: 'Payroll Run Not Found',
      detail: `Payroll run "${runId}" was not found.`,
    });
  }

  if (run.status === 'PAID' || run.status === 'PARTIALLY_PAID') {
    throw new AppError({
      statusCode: 409,
      errorCode: 'HRM_INVALID_PAYROLL_STATUS_TRANSITION',
      title: 'Cannot Cancel Paid Payroll Run',
      detail: `Payroll run "${run.run_number}" has already recorded payments and cannot be cancelled.`,
    });
  }

  await trx.db
    .updateTable('payroll_runs')
    .set({
      status: 'CANCELLED',
      updated_at: new Date(),
    })
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', runId)
    .execute();

  await appendAuditLog(trx, {
    action: 'hrm.payroll.cancelled',
    resourceType: 'payroll_run',
    resourceId: runId,
    metadata: {
      runNumber: run.run_number,
      reason: reason || null,
    },
  });

  return getPayrollRunById(trx, runId);
}

export async function recordPayrollPayment(
  trx: TenantTransactionContext,
  runId: string,
  input: RecordPayrollPaymentRequest,
): Promise<PayrollPaymentResponse> {
  await assertAuthorized(trx, { permission: 'hrm:payroll:pay' });

  const run = await trx.db
    .selectFrom('payroll_runs')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', runId)
    .executeTakeFirst();

  if (!run) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'HRM_PAYROLL_RUN_NOT_FOUND',
      title: 'Payroll Run Not Found',
      detail: `Payroll run "${runId}" was not found.`,
    });
  }

  if (run.status !== 'APPROVED' && run.status !== 'PARTIALLY_PAID') {
    throw new AppError({
      statusCode: 409,
      errorCode: 'HRM_INVALID_PAYROLL_STATUS_TRANSITION',
      title: 'Payroll Run Not Approved For Payment',
      detail: `Payments can only be recorded against APPROVED or PARTIALLY_PAID runs (current status: "${run.status}").`,
    });
  }

  const item = await trx.db
    .selectFrom('payroll_items')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('payroll_run_id', '=', runId)
    .where('id', '=', input.itemId)
    .executeTakeFirst();

  if (!item) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'HRM_PAYROLL_ITEM_NOT_FOUND',
      title: 'Payroll Item Not Found',
      detail: `Payroll item "${input.itemId}" was not found in run "${runId}".`,
    });
  }

  const paymentMoney = Money.fromDecimalString(
    input.paymentAmount,
    input.currencyCode,
  );
  if (!paymentMoney.isPositive()) {
    throw new AppError({
      statusCode: 400,
      errorCode: 'ERR_VALIDATION_FAILED',
      title: 'Invalid Payment Amount',
      detail: 'Payment amount must be strictly positive.',
    });
  }

  const netPayMoney = Money.fromDecimalString(
    item.net_pay,
    input.currencyCode,
  );
  const alreadyPaidMoney = Money.fromDecimalString(
    item.paid_amount,
    input.currencyCode,
  );
  const remainingDueMoney = netPayMoney.subtract(alreadyPaidMoney);

  if (paymentMoney.compare(remainingDueMoney) > 0) {
    throw new AppError({
      statusCode: 400,
      errorCode: 'HRM_OVERPAYMENT_NOT_ALLOWED',
      title: 'Overpayment Not Allowed',
      detail: `Payment amount (${paymentMoney.toDecimalString()}) exceeds the remaining balance due (${remainingDueMoney.toDecimalString()}).`,
    });
  }

  const paymentId = generateUuidV7();

  // Insert payment
  await trx.db
    .insertInto('payroll_payments')
    .values({
      id: paymentId,
      tenant_id: trx.tenantId,
      payroll_run_id: runId,
      payroll_item_id: input.itemId,
      employee_id: item.employee_id,
      payment_method: input.paymentMethod,
      payment_amount: paymentMoney.toDecimalString(),
      currency_code: input.currencyCode,
      payment_date: input.paymentDate,
      reference_number: input.referenceNumber?.trim() || null,
      recorded_by_user_id: trx.userId,
      notes: input.notes?.trim() || null,
    })
    .execute();

  // Update item
  const newPaidAmount = alreadyPaidMoney.add(paymentMoney);
  const newItemStatus: PayrollPaymentStatus =
    newPaidAmount.compare(netPayMoney) >= 0 ? 'PAID' : 'PARTIALLY_PAID';

  await trx.db
    .updateTable('payroll_items')
    .set({
      paid_amount: newPaidAmount.toDecimalString(),
      payment_status: newItemStatus,
      updated_at: new Date(),
    })
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', input.itemId)
    .execute();

  // Update run
  const runPaidMoney = Money.fromDecimalString(
    run.total_paid_amount,
    input.currencyCode,
  ).add(paymentMoney);
  const runTotalNetMoney = Money.fromDecimalString(
    run.total_net_pay,
    input.currencyCode,
  );
  const newRunStatus: PayrollRunStatus =
    runPaidMoney.compare(runTotalNetMoney) >= 0 ? 'PAID' : 'PARTIALLY_PAID';

  await trx.db
    .updateTable('payroll_runs')
    .set({
      total_paid_amount: runPaidMoney.toDecimalString(),
      status: newRunStatus,
      updated_at: new Date(),
    })
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', runId)
    .execute();

  await appendAuditLog(trx, {
    action: 'hrm.payroll.payment_recorded',
    resourceType: 'payroll_payment',
    resourceId: paymentId,
    metadata: {
      runId,
      itemId: input.itemId,
      employeeId: item.employee_id,
      amount: paymentMoney.toDecimalString(),
      method: input.paymentMethod,
    },
  });

  return {
    id: paymentId,
    payrollRunId: runId,
    payrollItemId: input.itemId,
    employeeId: item.employee_id,
    paymentMethod: input.paymentMethod,
    paymentAmount: paymentMoney.toDecimalString(),
    currencyCode: input.currencyCode,
    paymentDate: input.paymentDate,
    referenceNumber: input.referenceNumber?.trim() || null,
    recordedByUserId: trx.userId,
    notes: input.notes?.trim() || null,
    createdAt: new Date().toISOString(),
  };
}

export async function generatePayslip(
  trx: TenantTransactionContext,
  runId: string,
  employeeId: string,
): Promise<PayslipResponse> {
  await assertAuthorized(trx, { permission: 'hrm:payroll:read' });

  const run = await trx.db
    .selectFrom('payroll_runs')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', runId)
    .executeTakeFirst();

  if (!run) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'HRM_PAYROLL_RUN_NOT_FOUND',
      title: 'Payroll Run Not Found',
      detail: `Payroll run "${runId}" was not found.`,
    });
  }

  const tenant = await trx.db
    .selectFrom('tenants')
    .select(['legal_name'])
    .where('id', '=', trx.tenantId)
    .executeTakeFirst();

  const employee = await trx.db
    .selectFrom('employees')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', employeeId)
    .executeTakeFirst();

  if (!employee) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'HRM_EMPLOYEE_NOT_FOUND',
      title: 'Employee Not Found',
      detail: `Employee "${employeeId}" was not found.`,
    });
  }

  const item = await trx.db
    .selectFrom('payroll_items')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('payroll_run_id', '=', runId)
    .where('employee_id', '=', employeeId)
    .executeTakeFirst();

  if (!item) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'HRM_PAYROLL_ITEM_NOT_FOUND',
      title: 'Payroll Item Not Found',
      detail: `Employee "${employeeId}" has no line item in payroll run "${runId}".`,
    });
  }

  let snapshotList: ComponentSnapshotItem[] = [];
  if (typeof item.components_snapshot === 'string') {
    try {
      snapshotList = JSON.parse(item.components_snapshot);
    } catch {
      snapshotList = [];
    }
  } else if (Array.isArray(item.components_snapshot)) {
    snapshotList = item.components_snapshot as unknown as ComponentSnapshotItem[];
  }

  const earningsBreakdown: Array<{ name: string; amount: string; type: string }> = [
    {
      name: 'Basic Salary',
      amount: Money.fromDecimalString(
        item.basic_salary,
        run.currency_code,
      ).toDecimalString(),
      type: 'BASIC',
    },
  ];

  for (const comp of snapshotList.filter((s) => s.type === 'EARNING')) {
    earningsBreakdown.push({
      name: comp.name,
      amount: Money.fromDecimalString(
        comp.amount,
        run.currency_code,
      ).toDecimalString(),
      type: 'ALLOWANCE',
    });
  }

  if (parseFloat(item.overtime_pay) > 0) {
    earningsBreakdown.push({
      name: `Overtime (${item.overtime_hours} hrs)`,
      amount: Money.fromDecimalString(
        item.overtime_pay,
        run.currency_code,
      ).toDecimalString(),
      type: 'OVERTIME',
    });
  }

  if (parseFloat(item.bonus_pay) > 0) {
    earningsBreakdown.push({
      name: 'Bonus',
      amount: Money.fromDecimalString(
        item.bonus_pay,
        run.currency_code,
      ).toDecimalString(),
      type: 'BONUS',
    });
  }

  if (parseFloat(item.commissions_pay) > 0) {
    earningsBreakdown.push({
      name: 'Commissions',
      amount: Money.fromDecimalString(
        item.commissions_pay,
        run.currency_code,
      ).toDecimalString(),
      type: 'COMMISSION',
    });
  }

  const deductionsBreakdown: Array<{ name: string; amount: string; type: string }> = [];
  for (const comp of snapshotList.filter((s) => s.type === 'DEDUCTION')) {
    deductionsBreakdown.push({
      name: comp.name,
      amount: Money.fromDecimalString(
        comp.amount,
        run.currency_code,
      ).toDecimalString(),
      type: comp.isStatutory ? 'STATUTORY' : 'OTHER',
    });
  }

  const mappedItem: PayrollRunItemResponse = {
    id: item.id,
    payrollRunId: item.payroll_run_id,
    employeeId: item.employee_id,
    employeeCode: employee.employee_code,
    employeeName: employee.display_name,
    department: employee.department,
    designation: employee.designation,
    basicSalary: Money.fromDecimalString(
      item.basic_salary,
      run.currency_code,
    ).toDecimalString(),
    allowancesTotal: Money.fromDecimalString(
      item.allowances_total,
      run.currency_code,
    ).toDecimalString(),
    overtimeHours: item.overtime_hours,
    overtimePay: Money.fromDecimalString(
      item.overtime_pay,
      run.currency_code,
    ).toDecimalString(),
    bonusPay: Money.fromDecimalString(
      item.bonus_pay,
      run.currency_code,
    ).toDecimalString(),
    commissionsPay: Money.fromDecimalString(
      item.commissions_pay,
      run.currency_code,
    ).toDecimalString(),
    grossPay: Money.fromDecimalString(
      item.gross_pay,
      run.currency_code,
    ).toDecimalString(),
    deductionsTotal: Money.fromDecimalString(
      item.deductions_total,
      run.currency_code,
    ).toDecimalString(),
    netPay: Money.fromDecimalString(
      item.net_pay,
      run.currency_code,
    ).toDecimalString(),
    paidAmount: Money.fromDecimalString(
      item.paid_amount,
      run.currency_code,
    ).toDecimalString(),
    paymentStatus: item.payment_status as PayrollPaymentStatus,
    componentsSnapshot: snapshotList,
    notes: item.notes,
  };

  return {
    tenantName: tenant?.legal_name ?? 'NexStock Business',
    runNumber: run.run_number,
    frequency: run.frequency as PayrollFrequency,
    periodStart: formatDate(run.period_start),
    periodEnd: formatDate(run.period_end),
    paymentDate: formatDate(run.payment_date),
    currencyCode: run.currency_code,
    employee: {
      id: employee.id,
      employeeCode: employee.employee_code,
      fullName: employee.display_name,
      designation: employee.designation,
      department: employee.department,
      bankName: employee.bank_name,
      bankAccountNumber: employee.bank_account_number,
      epfNumber: employee.epf_number,
    },
    item: mappedItem,
    earningsBreakdown,
    deductionsBreakdown,
  };
}

export async function getPayrollSummaryReport(
  trx: TenantTransactionContext,
  query: {
    readonly startDate?: string | undefined;
    readonly endDate?: string | undefined;
    readonly frequency?: PayrollFrequency | undefined;
  } = {},
): Promise<PayrollReportSummaryResponse> {
  await assertAuthorized(trx, { permission: 'hrm:payroll:read' });

  let runsQuery = trx.db
    .selectFrom('payroll_runs')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('status', '!=', 'CANCELLED');

  if (query.frequency) {
    runsQuery = runsQuery.where('frequency', '=', query.frequency);
  }

  if (query.startDate) {
    runsQuery = runsQuery.where('period_start', '>=', query.startDate);
  }

  if (query.endDate) {
    runsQuery = runsQuery.where('period_end', '<=', query.endDate);
  }

  const runs = await runsQuery.execute();

  const baseCurrency = runs[0]?.currency_code ?? 'USD';

  let totalGross = Money.zero(baseCurrency);
  let totalDeductions = Money.zero(baseCurrency);
  let totalNet = Money.zero(baseCurrency);
  let totalPaid = Money.zero(baseCurrency);

  for (const r of runs) {
    totalGross = totalGross.add(Money.fromDecimalString(r.total_gross_pay, baseCurrency));
    totalDeductions = totalDeductions.add(
      Money.fromDecimalString(r.total_deductions, baseCurrency),
    );
    totalNet = totalNet.add(Money.fromDecimalString(r.total_net_pay, baseCurrency));
    totalPaid = totalPaid.add(Money.fromDecimalString(r.total_paid_amount, baseCurrency));
  }

  const totalUnpaid =
    totalNet.compare(totalPaid) > 0
      ? totalNet.subtract(totalPaid)
      : Money.zero(baseCurrency);

  // Department aggregations
  const deptMap = new Map<
    string,
    { count: number; gross: Money; net: Money; paid: Money }
  >();

  if (runs.length > 0) {
    const runIds = runs.map((r) => r.id);
    const items = await trx.db
      .selectFrom('payroll_items')
      .innerJoin('employees', (join) =>
        join
          .onRef('employees.tenant_id', '=', 'payroll_items.tenant_id')
          .onRef('employees.id', '=', 'payroll_items.employee_id'),
      )
      .select([
        'employees.department as department',
        'payroll_items.gross_pay as gross_pay',
        'payroll_items.net_pay as net_pay',
        'payroll_items.paid_amount as paid_amount',
      ])
      .where('payroll_items.tenant_id', '=', trx.tenantId)
      .where('payroll_items.payroll_run_id', 'in', runIds)
      .execute();

    for (const it of items) {
      const existing = deptMap.get(it.department) ?? {
        count: 0,
        gross: Money.zero(baseCurrency),
        net: Money.zero(baseCurrency),
        paid: Money.zero(baseCurrency),
      };

      existing.count += 1;
      existing.gross = existing.gross.add(
        Money.fromDecimalString(it.gross_pay, baseCurrency),
      );
      existing.net = existing.net.add(
        Money.fromDecimalString(it.net_pay, baseCurrency),
      );
      existing.paid = existing.paid.add(
        Money.fromDecimalString(it.paid_amount, baseCurrency),
      );
      deptMap.set(it.department, existing);
    }
  }

  const byDepartment = Array.from(deptMap.entries()).map(([department, data]) => ({
    department,
    employeeCount: data.count,
    gross: data.gross.toDecimalString(),
    net: data.net.toDecimalString(),
    paid: data.paid.toDecimalString(),
  }));

  // Frequency aggregations
  const freqMap = new Map<
    PayrollFrequency,
    { count: number; gross: Money; net: Money; paid: Money }
  >();

  for (const r of runs) {
    const freq = r.frequency as PayrollFrequency;
    const existing = freqMap.get(freq) ?? {
      count: 0,
      gross: Money.zero(baseCurrency),
      net: Money.zero(baseCurrency),
      paid: Money.zero(baseCurrency),
    };
    existing.count += 1;
    existing.gross = existing.gross.add(
      Money.fromDecimalString(r.total_gross_pay, baseCurrency),
    );
    existing.net = existing.net.add(
      Money.fromDecimalString(r.total_net_pay, baseCurrency),
    );
    existing.paid = existing.paid.add(
      Money.fromDecimalString(r.total_paid_amount, baseCurrency),
    );
    freqMap.set(freq, existing);
  }

  const byFrequency = Array.from(freqMap.entries()).map(([frequency, data]) => ({
    frequency,
    runsCount: data.count,
    gross: data.gross.toDecimalString(),
    net: data.net.toDecimalString(),
    paid: data.paid.toDecimalString(),
  }));

  // Employees paid count
  let employeesPaidCount = 0;
  if (runs.length > 0) {
    const runIds = runs.map((r) => r.id);
    const countRow = await trx.db
      .selectFrom('payroll_items')
      .select((eb) => eb.fn.count('employee_id').distinct().as('count'))
      .where('tenant_id', '=', trx.tenantId)
      .where('payroll_run_id', 'in', runIds)
      .where('payment_status', '=', 'PAID')
      .executeTakeFirst();
    employeesPaidCount = Number(countRow?.count ?? 0);
  }

  return {
    totalGross: totalGross.toDecimalString(),
    totalDeductions: totalDeductions.toDecimalString(),
    totalNet: totalNet.toDecimalString(),
    totalPaid: totalPaid.toDecimalString(),
    totalUnpaid: totalUnpaid.toDecimalString(),
    runsCount: runs.length,
    employeesPaidCount,
    byDepartment,
    byFrequency,
  };
}

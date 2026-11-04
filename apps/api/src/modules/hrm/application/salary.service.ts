import type {
  CreateSalaryStructureRequest,
  SalaryCalculationType,
  SalaryComponentResponse,
  SalaryComponentType,
  SalaryPaymentMethod,
  SalaryStructureResponse,
} from '@nexstock/contracts';
import { Money } from '@nexstock/domain-core';
import { assertAuthorized } from '../../iam/index.js';
import {
  AppError,
  type TenantTransactionContext,
  appendAuditLog,
  generateUuidV7,
} from '../../shared/index.js';

export function mapSalaryStructure(
  structureRow: {
    id: string;
    employee_id: string;
    effective_from: Date | string;
    basic_salary: string;
    currency_code: string;
    payment_method: SalaryPaymentMethod;
    is_active: boolean;
    notes: string | null;
    created_at: Date | string;
    updated_at: Date | string;
  },
  components: Array<{
    id: string;
    structure_id: string;
    component_type: SalaryComponentType;
    component_name: string;
    calculation_type: SalaryCalculationType;
    component_value: string;
    is_taxable: boolean;
    is_statutory: boolean;
    is_enabled: boolean;
    proration_rule?: string;
  }> = [],
): SalaryStructureResponse {
  const effectiveFrom =
    typeof structureRow.effective_from === 'string'
      ? structureRow.effective_from.substring(0, 10)
      : structureRow.effective_from.toISOString().substring(0, 10);

  const mappedComponents: SalaryComponentResponse[] = components.map((c) => ({
    id: c.id,
    structureId: c.structure_id,
    componentType: c.component_type,
    componentName: c.component_name,
    calculationType: c.calculation_type,
    componentValue: Money.fromDecimalString(
      c.component_value,
      structureRow.currency_code,
    ).toDecimalString(),
    isTaxable: c.is_taxable,
    isStatutory: c.is_statutory,
    isEnabled: c.is_enabled,
    prorationRule: (c.proration_rule === 'FULL' ? 'FULL' : 'PRORATE') as 'PRORATE' | 'FULL',
  }));

  return {
    id: structureRow.id,
    employeeId: structureRow.employee_id,
    effectiveFrom,
    basicSalary: Money.fromDecimalString(
      structureRow.basic_salary,
      structureRow.currency_code,
    ).toDecimalString(),
    currencyCode: structureRow.currency_code,
    paymentMethod: structureRow.payment_method,
    isActive: structureRow.is_active,
    notes: structureRow.notes,
    components: mappedComponents,
    createdAt: new Date(structureRow.created_at).toISOString(),
    updatedAt: new Date(structureRow.updated_at).toISOString(),
  };
}

export async function createSalaryStructure(
  trx: TenantTransactionContext,
  employeeId: string,
  input: CreateSalaryStructureRequest,
): Promise<SalaryStructureResponse> {
  await assertAuthorized(trx, { permission: 'hrm:salary:manage' });

  const employee = await trx.db
    .selectFrom('employees')
    .select(['id', 'employee_code'])
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

  const basicMoney = Money.fromDecimalString(input.basicSalary, input.currencyCode);
  if (basicMoney.isNegative()) {
    throw new AppError({
      statusCode: 400,
      errorCode: 'ERR_VALIDATION_FAILED',
      title: 'Invalid Basic Salary',
      detail: 'Basic salary must be non-negative.',
    });
  }

  // Deactivate all previous active structures
  await trx.db
    .updateTable('employee_salary_structures')
    .set({
      is_active: false,
      updated_at: new Date(),
    })
    .where('tenant_id', '=', trx.tenantId)
    .where('employee_id', '=', employeeId)
    .where('is_active', '=', true)
    .execute();

  const structureId = generateUuidV7();

  await trx.db
    .insertInto('employee_salary_structures')
    .values({
      id: structureId,
      tenant_id: trx.tenantId,
      employee_id: employeeId,
      effective_from: input.effectiveFrom,
      basic_salary: basicMoney.toDecimalString(),
      currency_code: input.currencyCode,
      payment_method: input.paymentMethod ?? 'BANK_TRANSFER',
      is_active: true,
      notes: input.notes?.trim() || null,
    })
    .execute();

  for (const comp of input.components) {
    const compValMoney = Money.fromDecimalString(comp.componentValue, input.currencyCode);
    if (compValMoney.isNegative()) {
      throw new AppError({
        statusCode: 400,
        errorCode: 'ERR_VALIDATION_FAILED',
        title: 'Invalid Component Value',
        detail: `Component "${comp.componentName}" value must be non-negative.`,
      });
    }

    await trx.db
      .insertInto('employee_salary_components')
      .values({
        id: generateUuidV7(),
        tenant_id: trx.tenantId,
        structure_id: structureId,
        component_type: comp.componentType,
        component_name: comp.componentName.trim(),
        calculation_type: comp.calculationType,
        component_value: compValMoney.toDecimalString(),
        is_taxable: comp.isTaxable ?? true,
        is_statutory: comp.isStatutory ?? false,
        is_enabled: comp.isEnabled ?? true,
        proration_rule: comp.prorationRule ?? 'PRORATE',
      })
      .execute();
  }

  await appendAuditLog(trx, {
    action: 'hrm.salary_structure.created',
    resourceType: 'employee_salary_structure',
    resourceId: structureId,
    metadata: {
      employeeId,
      basicSalary: basicMoney.toDecimalString(),
      currencyCode: input.currencyCode,
      componentCount: input.components.length,
    },
  });

  return getSalaryStructureById(trx, structureId);
}

export async function getSalaryStructureById(
  trx: TenantTransactionContext,
  structureId: string,
): Promise<SalaryStructureResponse> {
  const row = await trx.db
    .selectFrom('employee_salary_structures')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', structureId)
    .executeTakeFirst();

  if (!row) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'HRM_SALARY_STRUCTURE_NOT_FOUND',
      title: 'Salary Structure Not Found',
      detail: `Salary structure "${structureId}" was not found.`,
    });
  }

  const components = await trx.db
    .selectFrom('employee_salary_components')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('structure_id', '=', structureId)
    .execute();

  return mapSalaryStructure(
    row as unknown as Parameters<typeof mapSalaryStructure>[0],
    components as unknown as Parameters<typeof mapSalaryStructure>[1],
  );
}

export async function getActiveSalaryStructure(
  trx: TenantTransactionContext,
  employeeId: string,
): Promise<SalaryStructureResponse | null> {
  await assertAuthorized(trx, { permission: 'hrm:salary:read' });

  const row = await trx.db
    .selectFrom('employee_salary_structures')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('employee_id', '=', employeeId)
    .where('is_active', '=', true)
    .executeTakeFirst();

  if (!row) {
    return null;
  }

  const components = await trx.db
    .selectFrom('employee_salary_components')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('structure_id', '=', row.id)
    .execute();

  return mapSalaryStructure(
    row as unknown as Parameters<typeof mapSalaryStructure>[0],
    components as unknown as Parameters<typeof mapSalaryStructure>[1],
  );
}

export async function getSalaryStructureHistory(
  trx: TenantTransactionContext,
  employeeId: string,
): Promise<SalaryStructureResponse[]> {
  await assertAuthorized(trx, { permission: 'hrm:salary:read' });

  const rows = await trx.db
    .selectFrom('employee_salary_structures')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('employee_id', '=', employeeId)
    .orderBy('effective_from', 'desc')
    .execute();

  if (rows.length === 0) {
    return [];
  }

  const structureIds = rows.map((r) => r.id);
  const allComponents = await trx.db
    .selectFrom('employee_salary_components')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('structure_id', 'in', structureIds)
    .execute();

  const compMap = new Map<string, typeof allComponents>();
  for (const c of allComponents) {
    const list = compMap.get(c.structure_id) ?? [];
    list.push(c);
    compMap.set(c.structure_id, list);
  }

  return rows.map((r) =>
    mapSalaryStructure(
      r as unknown as Parameters<typeof mapSalaryStructure>[0],
      (compMap.get(r.id) ?? []) as unknown as Parameters<typeof mapSalaryStructure>[1],
    ),
  );
}

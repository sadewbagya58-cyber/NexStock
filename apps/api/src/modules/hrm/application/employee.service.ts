import type {
  CreateEmployeeRequest,
  EmployeeListResponse,
  EmployeeProfileResponse,
  EmployeeResponse,
  EmploymentStatus,
  PayrollFrequency,
  UpdateEmployeeRequest,
} from '@nexstock/contracts';
import { assertAuthorized } from '../../iam/index.js';
import {
  AppError,
  type TenantTransactionContext,
  appendAuditLog,
  generateUuidV7,
} from '../../shared/index.js';
import { listEmployeeDocuments } from './document.service.js';
import { getActiveSalaryStructure } from './salary.service.js';

export interface EmployeeRow {
  id: string;
  tenant_id: string;
  employee_code: string;
  first_name: string;
  last_name: string;
  display_name: string;
  email: string | null;
  phone: string | null;
  national_id: string | null;
  gender: string | null;
  date_of_birth: Date | string | null;
  joined_date: Date | string;
  designation: string;
  department: string;
  employment_status: EmploymentStatus;
  payroll_frequency: PayrollFrequency;
  primary_branch_id: string | null;
  primary_warehouse_id: string | null;
  linked_user_id: string | null;
  avatar_url: string | null;
  bank_name: string | null;
  bank_account_number: string | null;
  bank_branch: string | null;
  epf_number: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  district: string | null;
  postal_code: string | null;
  leaving_date: Date | string | null;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
  notes: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

function formatDateOnly(d: Date | string | null): string | null {
  if (!d) return null;
  if (typeof d === 'string') {
    return d.substring(0, 10);
  }
  return d.toISOString().substring(0, 10);
}

function mapEmployee(
  row: EmployeeRow,
  branches: string[] = [],
  warehouses: string[] = [],
  extra?: {
    primaryBranchName?: string | null;
    primaryWarehouseName?: string | null;
    linkedUserEmail?: string | null;
  },
): EmployeeResponse {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    employeeCode: row.employee_code,
    firstName: row.first_name,
    lastName: row.last_name,
    displayName: row.display_name,
    email: row.email,
    phone: row.phone,
    nationalId: row.national_id,
    gender: row.gender,
    dateOfBirth: formatDateOnly(row.date_of_birth),
    joinedDate: formatDateOnly(row.joined_date) ?? '',
    designation: row.designation,
    department: row.department,
    employmentStatus: row.employment_status,
    payrollFrequency: row.payroll_frequency,
    primaryBranchId: row.primary_branch_id,
    primaryBranchName: extra?.primaryBranchName ?? null,
    primaryWarehouseId: row.primary_warehouse_id,
    primaryWarehouseName: extra?.primaryWarehouseName ?? null,
    branchIds: branches,
    warehouseIds: warehouses,
    linkedUserId: row.linked_user_id,
    linkedUserEmail: extra?.linkedUserEmail ?? null,
    avatarUrl: row.avatar_url,
    bankName: row.bank_name,
    bankAccountNumber: row.bank_account_number,
    bankBranch: row.bank_branch,
    epfNumber: row.epf_number,
    addressLine1: row.address_line1,
    addressLine2: row.address_line2,
    city: row.city,
    district: row.district ?? null,
    postalCode: row.postal_code ?? null,
    leavingDate: formatDateOnly(row.leaving_date),
    emergencyContactName: row.emergency_contact_name,
    emergencyContactPhone: row.emergency_contact_phone,
    notes: row.notes,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export async function createEmployee(
  trx: TenantTransactionContext,
  input: CreateEmployeeRequest,
): Promise<EmployeeResponse> {
  await assertAuthorized(trx, { permission: 'hrm:employee:manage' });

  // Check code uniqueness
  const existingCode = await trx.db
    .selectFrom('employees')
    .select(['id'])
    .where('tenant_id', '=', trx.tenantId)
    .where('employee_code', '=', input.employeeCode.trim())
    .executeTakeFirst();

  if (existingCode) {
    throw new AppError({
      statusCode: 409,
      errorCode: 'HRM_DUPLICATE_EMPLOYEE_CODE',
      title: 'Duplicate Employee Code',
      detail: `An employee with code "${input.employeeCode}" already exists in this tenant.`,
    });
  }

  // Check linked user uniqueness
  if (input.linkedUserId) {
    const existingUserLink = await trx.db
      .selectFrom('employees')
      .select(['id', 'employee_code'])
      .where('tenant_id', '=', trx.tenantId)
      .where('linked_user_id', '=', input.linkedUserId)
      .executeTakeFirst();

    if (existingUserLink) {
      throw new AppError({
        statusCode: 409,
        errorCode: 'HRM_USER_ALREADY_LINKED',
        title: 'User Already Linked',
        detail: `User "${input.linkedUserId}" is already linked to employee "${existingUserLink.employee_code}".`,
      });
    }
  }

  const employeeId = generateUuidV7();
  const displayName =
    input.displayName?.trim() ||
    `${input.firstName.trim()} ${input.lastName.trim()}`;

  await trx.db
    .insertInto('employees')
    .values({
      id: employeeId,
      tenant_id: trx.tenantId,
      employee_code: input.employeeCode.trim(),
      first_name: input.firstName.trim(),
      last_name: input.lastName.trim(),
      display_name: displayName,
      email: input.email?.trim().toLowerCase() || null,
      phone: input.phone?.trim() || null,
      national_id: input.nationalId?.trim() || null,
      gender: input.gender?.trim() || null,
      date_of_birth: input.dateOfBirth || null,
      joined_date: input.joinedDate,
      designation: input.designation.trim(),
      department: input.department.trim(),
      employment_status: input.employmentStatus ?? 'ACTIVE',
      payroll_frequency: input.payrollFrequency ?? 'MONTHLY',
      primary_branch_id: input.primaryBranchId ?? null,
      primary_warehouse_id: input.primaryWarehouseId ?? null,
      linked_user_id: input.linkedUserId ?? null,
      avatar_url: input.avatarUrl ?? null,
      bank_name: input.bankName?.trim() || null,
      bank_account_number: input.bankAccountNumber?.trim() || null,
      bank_branch: input.bankBranch?.trim() || null,
      epf_number: input.epfNumber?.trim() || null,
      address_line1: input.addressLine1?.trim() || null,
      address_line2: input.addressLine2?.trim() || null,
      city: input.city?.trim() || null,
      district: input.district?.trim() || null,
      postal_code: input.postalCode?.trim() || null,
      leaving_date: input.leavingDate || null,
      emergency_contact_name: input.emergencyContactName?.trim() || null,
      emergency_contact_phone: input.emergencyContactPhone?.trim() || null,
      notes: input.notes?.trim() || null,
    })
    .execute();

  // Branch assignments
  const branchIds = new Set<string>();
  if (input.primaryBranchId) {
    branchIds.add(input.primaryBranchId);
  }
  if (input.branchIds) {
    for (const b of input.branchIds) branchIds.add(b);
  }

  for (const bId of branchIds) {
    await trx.db
      .insertInto('employee_branch_assignments')
      .values({
        id: generateUuidV7(),
        tenant_id: trx.tenantId,
        employee_id: employeeId,
        branch_id: bId,
        is_primary: bId === input.primaryBranchId,
      })
      .execute();
  }

  // Warehouse assignments
  const warehouseIds = new Set<string>();
  if (input.primaryWarehouseId) {
    warehouseIds.add(input.primaryWarehouseId);
  }
  if (input.warehouseIds) {
    for (const w of input.warehouseIds) warehouseIds.add(w);
  }

  for (const wId of warehouseIds) {
    await trx.db
      .insertInto('employee_warehouse_assignments')
      .values({
        id: generateUuidV7(),
        tenant_id: trx.tenantId,
        employee_id: employeeId,
        warehouse_id: wId,
        is_primary: wId === input.primaryWarehouseId,
      })
      .execute();
  }

  await appendAuditLog(trx, {
    action: 'hrm.employee.created',
    resourceType: 'employee',
    resourceId: employeeId,
    metadata: {
      employeeCode: input.employeeCode,
      displayName,
      department: input.department,
      designation: input.designation,
    },
  });

  return getEmployeeById(trx, employeeId);
}

export async function updateEmployee(
  trx: TenantTransactionContext,
  employeeId: string,
  input: UpdateEmployeeRequest,
): Promise<EmployeeResponse> {
  await assertAuthorized(trx, { permission: 'hrm:employee:manage' });

  const existing = await trx.db
    .selectFrom('employees')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', employeeId)
    .executeTakeFirst();

  if (!existing) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'HRM_EMPLOYEE_NOT_FOUND',
      title: 'Employee Not Found',
      detail: `Employee "${employeeId}" was not found.`,
    });
  }

  // Code uniqueness check
  if (input.employeeCode && input.employeeCode.trim() !== existing.employee_code) {
    const codeConflict = await trx.db
      .selectFrom('employees')
      .select(['id'])
      .where('tenant_id', '=', trx.tenantId)
      .where('employee_code', '=', input.employeeCode.trim())
      .where('id', '!=', employeeId)
      .executeTakeFirst();

    if (codeConflict) {
      throw new AppError({
        statusCode: 409,
        errorCode: 'HRM_DUPLICATE_EMPLOYEE_CODE',
        title: 'Duplicate Employee Code',
        detail: `An employee with code "${input.employeeCode}" already exists.`,
      });
    }
  }

  // Linked user uniqueness check
  if (input.linkedUserId && input.linkedUserId !== existing.linked_user_id) {
    const userConflict = await trx.db
      .selectFrom('employees')
      .select(['id'])
      .where('tenant_id', '=', trx.tenantId)
      .where('linked_user_id', '=', input.linkedUserId)
      .where('id', '!=', employeeId)
      .executeTakeFirst();

    if (userConflict) {
      throw new AppError({
        statusCode: 409,
        errorCode: 'HRM_USER_ALREADY_LINKED',
        title: 'User Already Linked',
        detail: `User "${input.linkedUserId}" is already linked to another employee.`,
      });
    }
  }

  const updatedDisplayName =
    input.displayName?.trim() ??
    (input.firstName || input.lastName
      ? `${(input.firstName ?? existing.first_name).trim()} ${(input.lastName ?? existing.last_name).trim()}`
      : existing.display_name);

  await trx.db
    .updateTable('employees')
    .set({
      employee_code: input.employeeCode ? input.employeeCode.trim() : existing.employee_code,
      first_name: input.firstName ? input.firstName.trim() : existing.first_name,
      last_name: input.lastName ? input.lastName.trim() : existing.last_name,
      display_name: updatedDisplayName,
      email: input.email !== undefined ? (input.email && input.email.trim() ? input.email.trim().toLowerCase() : null) : existing.email,
      phone: input.phone !== undefined ? (input.phone && input.phone.trim() ? input.phone.trim() : null) : existing.phone,
      national_id: input.nationalId !== undefined ? (input.nationalId && input.nationalId.trim() ? input.nationalId.trim() : null) : existing.national_id,
      gender: input.gender !== undefined ? (input.gender && input.gender.trim() ? input.gender.trim() : null) : existing.gender,
      date_of_birth: input.dateOfBirth !== undefined ? (input.dateOfBirth && input.dateOfBirth.trim() ? input.dateOfBirth.trim() : null) : existing.date_of_birth,
      joined_date: input.joinedDate !== undefined ? input.joinedDate : existing.joined_date,
      designation: input.designation ? input.designation.trim() : existing.designation,
      department: input.department ? input.department.trim() : existing.department,
      employment_status: input.employmentStatus ?? existing.employment_status,
      payroll_frequency: input.payrollFrequency ?? existing.payroll_frequency,
      primary_branch_id: input.primaryBranchId !== undefined ? (input.primaryBranchId ? input.primaryBranchId : null) : existing.primary_branch_id,
      primary_warehouse_id: input.primaryWarehouseId !== undefined ? (input.primaryWarehouseId ? input.primaryWarehouseId : null) : existing.primary_warehouse_id,
      linked_user_id: input.linkedUserId !== undefined ? (input.linkedUserId ? input.linkedUserId : null) : existing.linked_user_id,
      avatar_url: input.avatarUrl !== undefined ? (input.avatarUrl && input.avatarUrl.trim() ? input.avatarUrl.trim() : null) : existing.avatar_url,
      bank_name: input.bankName !== undefined ? (input.bankName && input.bankName.trim() ? input.bankName.trim() : null) : existing.bank_name,
      bank_account_number: input.bankAccountNumber !== undefined ? (input.bankAccountNumber && input.bankAccountNumber.trim() ? input.bankAccountNumber.trim() : null) : existing.bank_account_number,
      bank_branch: input.bankBranch !== undefined ? (input.bankBranch && input.bankBranch.trim() ? input.bankBranch.trim() : null) : existing.bank_branch,
      epf_number: input.epfNumber !== undefined ? (input.epfNumber && input.epfNumber.trim() ? input.epfNumber.trim() : null) : existing.epf_number,
      address_line1: input.addressLine1 !== undefined ? (input.addressLine1 && input.addressLine1.trim() ? input.addressLine1.trim() : null) : existing.address_line1,
      address_line2: input.addressLine2 !== undefined ? (input.addressLine2 && input.addressLine2.trim() ? input.addressLine2.trim() : null) : existing.address_line2,
      city: input.city !== undefined ? (input.city && input.city.trim() ? input.city.trim() : null) : existing.city,
      district: input.district !== undefined ? (input.district && input.district.trim() ? input.district.trim() : null) : existing.district,
      postal_code: input.postalCode !== undefined ? (input.postalCode && input.postalCode.trim() ? input.postalCode.trim() : null) : existing.postal_code,
      leaving_date: input.leavingDate !== undefined ? (input.leavingDate && input.leavingDate.trim() ? input.leavingDate.trim() : null) : existing.leaving_date,
      emergency_contact_name: input.emergencyContactName !== undefined ? (input.emergencyContactName && input.emergencyContactName.trim() ? input.emergencyContactName.trim() : null) : existing.emergency_contact_name,
      emergency_contact_phone: input.emergencyContactPhone !== undefined ? (input.emergencyContactPhone && input.emergencyContactPhone.trim() ? input.emergencyContactPhone.trim() : null) : existing.emergency_contact_phone,
      notes: input.notes !== undefined ? (input.notes && input.notes.trim() ? input.notes.trim() : null) : existing.notes,
      updated_at: new Date(),
    })
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', employeeId)
    .execute();

  // Update branch assignments if specified
  if (input.branchIds !== undefined || input.primaryBranchId !== undefined) {
    await trx.db
      .deleteFrom('employee_branch_assignments')
      .where('tenant_id', '=', trx.tenantId)
      .where('employee_id', '=', employeeId)
      .execute();

    const branchIds = new Set<string>(input.branchIds ?? []);
    const primaryBranch = input.primaryBranchId !== undefined ? (input.primaryBranchId || null) : existing.primary_branch_id;
    if (primaryBranch) {
      branchIds.add(primaryBranch);
    }
    for (const bId of branchIds) {
      await trx.db
        .insertInto('employee_branch_assignments')
        .values({
          id: generateUuidV7(),
          tenant_id: trx.tenantId,
          employee_id: employeeId,
          branch_id: bId,
          is_primary: bId === primaryBranch,
        })
        .execute();
    }
  }

  // Update warehouse assignments if specified
  if (input.warehouseIds !== undefined || input.primaryWarehouseId !== undefined) {
    await trx.db
      .deleteFrom('employee_warehouse_assignments')
      .where('tenant_id', '=', trx.tenantId)
      .where('employee_id', '=', employeeId)
      .execute();

    const warehouseIds = new Set<string>(input.warehouseIds ?? []);
    const primaryWarehouse = input.primaryWarehouseId !== undefined ? (input.primaryWarehouseId || null) : existing.primary_warehouse_id;
    if (primaryWarehouse) {
      warehouseIds.add(primaryWarehouse);
    }
    for (const wId of warehouseIds) {
      await trx.db
        .insertInto('employee_warehouse_assignments')
        .values({
          id: generateUuidV7(),
          tenant_id: trx.tenantId,
          employee_id: employeeId,
          warehouse_id: wId,
          is_primary: wId === primaryWarehouse,
        })
        .execute();
    }
  }

  await appendAuditLog(trx, {
    action: 'hrm.employee.updated',
    resourceType: 'employee',
    resourceId: employeeId,
    metadata: {
      employeeCode: input.employeeCode ?? existing.employee_code,
      displayName: updatedDisplayName,
    },
  });

  return getEmployeeById(trx, employeeId);
}

export async function updateEmployeeStatus(
  trx: TenantTransactionContext,
  employeeId: string,
  status: EmploymentStatus,
  reason?: string,
): Promise<EmployeeResponse> {
  await assertAuthorized(trx, { permission: 'hrm:employee:manage' });

  const existing = await trx.db
    .selectFrom('employees')
    .select(['id', 'employee_code', 'employment_status'])
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', employeeId)
    .executeTakeFirst();

  if (!existing) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'HRM_EMPLOYEE_NOT_FOUND',
      title: 'Employee Not Found',
      detail: `Employee "${employeeId}" was not found.`,
    });
  }

  await trx.db
    .updateTable('employees')
    .set({
      employment_status: status,
      updated_at: new Date(),
    })
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', employeeId)
    .execute();

  await appendAuditLog(trx, {
    action: 'hrm.employee.status_changed',
    resourceType: 'employee',
    resourceId: employeeId,
    metadata: {
      previousStatus: existing.employment_status,
      newStatus: status,
      reason: reason || null,
    },
  });

  return getEmployeeById(trx, employeeId);
}

export async function linkEmployeeUser(
  trx: TenantTransactionContext,
  employeeId: string,
  userId: string | null,
): Promise<EmployeeResponse> {
  await assertAuthorized(trx, { permission: 'hrm:employee:manage' });

  const existing = await trx.db
    .selectFrom('employees')
    .select(['id', 'employee_code', 'linked_user_id'])
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', employeeId)
    .executeTakeFirst();

  if (!existing) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'HRM_EMPLOYEE_NOT_FOUND',
      title: 'Employee Not Found',
      detail: `Employee "${employeeId}" was not found.`,
    });
  }

  if (userId) {
    // 1. Prevent accidental reassignment if employee is already linked to a different user
    if (existing.linked_user_id && existing.linked_user_id !== userId) {
      throw new AppError({
        statusCode: 409,
        errorCode: 'HRM_EMPLOYEE_ALREADY_LINKED',
        title: 'Employee Already Linked',
        detail: `Employee "${existing.employee_code}" is already linked to another user account. Unlink the existing account first before reassigning.`,
      });
    }

    // 2. Check user exists
    const user = await trx.db
      .selectFrom('users')
      .select(['id', 'email'])
      .where('id', '=', userId)
      .executeTakeFirst();

    if (!user) {
      throw new AppError({
        statusCode: 404,
        errorCode: 'AUTH_USER_NOT_FOUND',
        title: 'User Not Found',
        detail: `System user "${userId}" was not found.`,
      });
    }

    // 3. Check membership in tenant
    const membership = await trx.db
      .selectFrom('tenant_memberships')
      .select(['id', 'status'])
      .where('tenant_id', '=', trx.tenantId)
      .where('user_id', '=', userId)
      .executeTakeFirst();

    if (!membership) {
      throw new AppError({
        statusCode: 400,
        errorCode: 'HRM_USER_NOT_TENANT_MEMBER',
        title: 'User Not Organization Member',
        detail: `User "${user.email}" is not a member of this organization.`,
      });
    }

    // 4. Check user roles: BLOCK linking TENANT_OWNER or ORG_ADMIN to standard staff
    const roles = await trx.db
      .selectFrom('member_role_assignments')
      .innerJoin('roles', (join) =>
        join
          .onRef('roles.tenant_id', '=', 'member_role_assignments.tenant_id')
          .onRef('roles.id', '=', 'member_role_assignments.role_id'),
      )
      .select(['roles.code'])
      .where('member_role_assignments.tenant_id', '=', trx.tenantId)
      .where('member_role_assignments.membership_id', '=', membership.id)
      .execute();

    const roleCodes = roles.map((r) => r.code);
    if (roleCodes.includes('TENANT_OWNER') || roleCodes.includes('ORG_ADMIN')) {
      throw new AppError({
        statusCode: 400,
        errorCode: 'HRM_INVALID_STAFF_LINK',
        title: 'Cannot Link Owner/Admin Account',
        detail: 'Owner and Organization Administrator accounts cannot be linked to standard employee staff profiles.',
      });
    }

    // 5. Check no other employee linked to this user
    const otherEmployee = await trx.db
      .selectFrom('employees')
      .select(['id', 'employee_code'])
      .where('tenant_id', '=', trx.tenantId)
      .where('linked_user_id', '=', userId)
      .where('id', '!=', employeeId)
      .executeTakeFirst();

    if (otherEmployee) {
      throw new AppError({
        statusCode: 409,
        errorCode: 'HRM_USER_ALREADY_LINKED',
        title: 'User Already Linked',
        detail: `User "${userId}" is already linked to employee "${otherEmployee.employee_code}".`,
      });
    }
  }

  await trx.db
    .updateTable('employees')
    .set({
      linked_user_id: userId,
      updated_at: new Date(),
    })
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', employeeId)
    .execute();

  await appendAuditLog(trx, {
    action: userId ? 'hrm.employee.user_linked' : 'hrm.employee.user_unlinked',
    resourceType: 'employee',
    resourceId: employeeId,
    metadata: {
      userId,
      employeeCode: existing.employee_code,
    },
  });

  return getEmployeeById(trx, employeeId);
}

export async function getMyEmployee(
  trx: TenantTransactionContext,
): Promise<EmployeeResponse> {
  const membership = await trx.db
    .selectFrom('tenant_memberships')
    .select(['status'])
    .where('tenant_id', '=', trx.tenantId)
    .where('user_id', '=', trx.userId)
    .executeTakeFirst();

  if (!membership || membership.status !== 'ACTIVE') {
    throw new AppError({
      statusCode: 403,
      errorCode: 'IAM_TENANT_MEMBERSHIP_REQUIRED',
      title: 'Active Tenant Membership Required',
      detail: `User "${trx.userId}" does not hold an active membership in tenant "${trx.tenantId}".`,
    });
  }

  const row = await trx.db
    .selectFrom('employees')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('linked_user_id', '=', trx.userId)
    .executeTakeFirst();

  if (!row) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'HRM_STAFF_ACCOUNT_NOT_LINKED',
      title: 'Staff Account Not Linked',
      detail: 'Your user account is not linked to any active employee profile.',
    });
  }

  // Branch assignments
  const branchRows = await trx.db
    .selectFrom('employee_branch_assignments')
    .select(['branch_id', 'is_primary'])
    .where('tenant_id', '=', trx.tenantId)
    .where('employee_id', '=', row.id)
    .execute();

  // Warehouse assignments
  const warehouseRows = await trx.db
    .selectFrom('employee_warehouse_assignments')
    .select(['warehouse_id', 'is_primary'])
    .where('tenant_id', '=', trx.tenantId)
    .where('employee_id', '=', row.id)
    .execute();

  // Branch name
  let primaryBranchName: string | null = null;
  if (row.primary_branch_id) {
    const b = await trx.db
      .selectFrom('branches')
      .select(['name'])
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', row.primary_branch_id)
      .executeTakeFirst();
    if (b) primaryBranchName = b.name;
  }

  // Warehouse name
  let primaryWarehouseName: string | null = null;
  if (row.primary_warehouse_id) {
    const w = await trx.db
      .selectFrom('warehouses')
      .select(['name'])
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', row.primary_warehouse_id)
      .executeTakeFirst();
    if (w) primaryWarehouseName = w.name;
  }

  // Linked user email
  let linkedUserEmail: string | null = null;
  const u = await trx.db
    .selectFrom('users')
    .select(['email'])
    .where('id', '=', trx.userId)
    .executeTakeFirst();
  if (u) linkedUserEmail = u.email;

  return mapEmployee(
    row as unknown as EmployeeRow,
    branchRows.map((b) => b.branch_id),
    warehouseRows.map((w) => w.warehouse_id),
    {
      primaryBranchName,
      primaryWarehouseName,
      linkedUserEmail,
    },
  );
}

export async function getEmployeeById(
  trx: TenantTransactionContext,
  employeeId: string,
): Promise<EmployeeResponse> {
  const hasManageOrRead = await (async () => {
    try {
      await assertAuthorized(trx, { permission: 'hrm:employee:read' });
      return true;
    } catch {
      return false;
    }
  })();

  if (!hasManageOrRead) {
    const linked = await trx.db
      .selectFrom('employees')
      .select(['id'])
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', employeeId)
      .where('linked_user_id', '=', trx.userId)
      .executeTakeFirst();

    if (!linked) {
      await assertAuthorized(trx, { permission: 'hrm:employee:read' });
    }
  }

  const row = await trx.db
    .selectFrom('employees')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', employeeId)
    .executeTakeFirst();

  if (!row) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'HRM_EMPLOYEE_NOT_FOUND',
      title: 'Employee Not Found',
      detail: `Employee "${employeeId}" was not found.`,
    });
  }

  // Branch assignments
  const branchRows = await trx.db
    .selectFrom('employee_branch_assignments')
    .select(['branch_id', 'is_primary'])
    .where('tenant_id', '=', trx.tenantId)
    .where('employee_id', '=', employeeId)
    .execute();

  // Warehouse assignments
  const warehouseRows = await trx.db
    .selectFrom('employee_warehouse_assignments')
    .select(['warehouse_id', 'is_primary'])
    .where('tenant_id', '=', trx.tenantId)
    .where('employee_id', '=', employeeId)
    .execute();

  // Branch name
  let primaryBranchName: string | null = null;
  if (row.primary_branch_id) {
    const b = await trx.db
      .selectFrom('branches')
      .select(['name'])
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', row.primary_branch_id)
      .executeTakeFirst();
    if (b) primaryBranchName = b.name;
  }

  // Warehouse name
  let primaryWarehouseName: string | null = null;
  if (row.primary_warehouse_id) {
    const w = await trx.db
      .selectFrom('warehouses')
      .select(['name'])
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', row.primary_warehouse_id)
      .executeTakeFirst();
    if (w) primaryWarehouseName = w.name;
  }

  // Linked user email
  let linkedUserEmail: string | null = null;
  if (row.linked_user_id) {
    const u = await trx.db
      .selectFrom('users')
      .select(['email'])
      .where('id', '=', row.linked_user_id)
      .executeTakeFirst();
    if (u) linkedUserEmail = u.email;
  }

  return mapEmployee(
    row as unknown as EmployeeRow,
    branchRows.map((b) => b.branch_id),
    warehouseRows.map((w) => w.warehouse_id),
    {
      primaryBranchName,
      primaryWarehouseName,
      linkedUserEmail,
    },
  );
}

export async function listEmployees(
  trx: TenantTransactionContext,
  options: {
    readonly search?: string | undefined;
    readonly status?: EmploymentStatus | undefined;
    readonly department?: string | undefined;
    readonly branchId?: string | undefined;
    readonly limit?: number | undefined;
    readonly offset?: number | undefined;
  } = {},
): Promise<EmployeeListResponse> {
  await assertAuthorized(trx, { permission: 'hrm:employee:read' });

  let query = trx.db
    .selectFrom('employees')
    .where('tenant_id', '=', trx.tenantId);

  if (options.status) {
    query = query.where('employment_status', '=', options.status);
  }

  if (options.department) {
    query = query.where('department', '=', options.department);
  }

  if (options.branchId) {
    query = query.where((eb) =>
      eb.or([
        eb('primary_branch_id', '=', options.branchId!),
        eb(
          'id',
          'in',
          trx.db
            .selectFrom('employee_branch_assignments')
            .select('employee_id')
            .where('tenant_id', '=', trx.tenantId)
            .where('branch_id', '=', options.branchId!),
        ),
      ]),
    );
  }

  if (options.search && options.search.trim().length > 0) {
    const term = `%${options.search.trim().toLowerCase()}%`;
    query = query.where((eb) =>
      eb.or([
        eb(eb.fn('lower', ['employee_code']), 'like', term),
        eb(eb.fn('lower', ['first_name']), 'like', term),
        eb(eb.fn('lower', ['last_name']), 'like', term),
        eb(eb.fn('lower', ['display_name']), 'like', term),
        eb(eb.fn('lower', ['email']), 'like', term),
        eb(eb.fn('lower', ['phone']), 'like', term),
        eb(eb.fn('lower', ['designation']), 'like', term),
        eb(eb.fn('lower', ['department']), 'like', term),
      ]),
    );
  }

  const limit = options.limit ?? 100;
  const offset = options.offset ?? 0;

  const [rows, countResult] = await Promise.all([
    query
      .selectAll()
      .orderBy('created_at', 'desc')
      .limit(limit)
      .offset(offset)
      .execute(),
    query
      .select((eb) => eb.fn.countAll<number>().as('total'))
      .executeTakeFirst(),
  ]);

  const total = Number(countResult?.total ?? rows.length);

  // Fetch branches, warehouses, and linked user info for each row
  const branchMap = new Map<string, string[]>();
  const warehouseMap = new Map<string, string[]>();
  const branchNameMap = new Map<string, string>();
  const warehouseNameMap = new Map<string, string>();
  const userEmailMap = new Map<string, string>();

  if (rows.length > 0) {
    const empIds = rows.map((r) => r.id);
    const branchIds = [
      ...new Set(
        rows.map((r) => r.primary_branch_id).filter(Boolean) as string[],
      ),
    ];
    const warehouseIds = [
      ...new Set(
        rows.map((r) => r.primary_warehouse_id).filter(Boolean) as string[],
      ),
    ];
    const userIds = [
      ...new Set(
        rows.map((r) => r.linked_user_id).filter(Boolean) as string[],
      ),
    ];

    const [bRows, wRows, bNames, wNames, uEmails] = await Promise.all([
      trx.db
        .selectFrom('employee_branch_assignments')
        .select(['employee_id', 'branch_id'])
        .where('tenant_id', '=', trx.tenantId)
        .where('employee_id', 'in', empIds)
        .execute(),
      trx.db
        .selectFrom('employee_warehouse_assignments')
        .select(['employee_id', 'warehouse_id'])
        .where('tenant_id', '=', trx.tenantId)
        .where('employee_id', 'in', empIds)
        .execute(),
      branchIds.length > 0
        ? trx.db
            .selectFrom('branches')
            .select(['id', 'name'])
            .where('tenant_id', '=', trx.tenantId)
            .where('id', 'in', branchIds)
            .execute()
        : Promise.resolve([]),
      warehouseIds.length > 0
        ? trx.db
            .selectFrom('warehouses')
            .select(['id', 'name'])
            .where('tenant_id', '=', trx.tenantId)
            .where('id', 'in', warehouseIds)
            .execute()
        : Promise.resolve([]),
      userIds.length > 0
        ? trx.db
            .selectFrom('users')
            .select(['id', 'email'])
            .where('id', 'in', userIds)
            .execute()
        : Promise.resolve([]),
    ]);

    for (const b of bRows) {
      const list = branchMap.get(b.employee_id) ?? [];
      list.push(b.branch_id);
      branchMap.set(b.employee_id, list);
    }
    for (const w of wRows) {
      const list = warehouseMap.get(w.employee_id) ?? [];
      list.push(w.warehouse_id);
      warehouseMap.set(w.employee_id, list);
    }
    for (const bn of bNames) {
      branchNameMap.set(bn.id, bn.name);
    }
    for (const wn of wNames) {
      warehouseNameMap.set(wn.id, wn.name);
    }
    for (const ue of uEmails) {
      userEmailMap.set(ue.id, ue.email);
    }
  }

  const items: EmployeeResponse[] = rows.map((r) =>
    mapEmployee(
      r as unknown as EmployeeRow,
      branchMap.get(r.id) ?? [],
      warehouseMap.get(r.id) ?? [],
      {
        primaryBranchName: (r.primary_branch_id ? branchNameMap.get(r.primary_branch_id) : null) ?? null,
        primaryWarehouseName: (r.primary_warehouse_id ? warehouseNameMap.get(r.primary_warehouse_id) : null) ?? null,
        linkedUserEmail: (r.linked_user_id ? userEmailMap.get(r.linked_user_id) : null) ?? null,
      },
    ),
  );

  return {
    items,
    total,
  };
}

export async function getEmployeeActivity(
  trx: TenantTransactionContext,
  employeeId: string,
): Promise<Array<{
  id: string;
  timestamp: string;
  activityType: string;
  description: string;
  referenceId?: string;
  details?: Record<string, unknown>;
}>> {
  await assertAuthorized(trx, { permission: 'hrm:employee:read' });

  const employee = await trx.db
    .selectFrom('employees')
    .select(['id', 'employee_code', 'linked_user_id'])
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

  const activities: Array<{
    id: string;
    timestamp: string;
    activityType: string;
    description: string;
    referenceId?: string;
    details?: Record<string, unknown>;
  }> = [];

  // 1. Audit logs referencing this employee
  const auditLogs = await trx.db
    .selectFrom('audit_logs')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('resource_id', '=', employeeId)
    .orderBy('created_at', 'desc')
    .limit(30)
    .execute();

  for (const log of auditLogs) {
    activities.push({
      id: log.id,
      timestamp: new Date(log.created_at).toISOString(),
      activityType: log.action,
      description: `Action ${log.action} performed on employee profile`,
      referenceId: log.id,
      details: (log.metadata_json as Record<string, unknown>) ?? {},
    });
  }

  // 2. If user is linked, fetch recent sales & shift activities
  if (employee.linked_user_id) {
    const sales = await trx.db
      .selectFrom('sales_invoices')
      .select(['id', 'invoice_number', 'grand_total', 'created_at'])
      .where('tenant_id', '=', trx.tenantId)
      .where('cashier_user_id', '=', employee.linked_user_id)
      .orderBy('created_at', 'desc')
      .limit(20)
      .execute();

    for (const sale of sales) {
      activities.push({
        id: sale.id,
        timestamp: new Date(sale.created_at).toISOString(),
        activityType: 'pos.sale.completed',
        description: `Completed POS Sale #${sale.invoice_number} (${sale.grand_total})`,
        referenceId: sale.id,
      });
    }
  }

  // Sort by timestamp desc
  activities.sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  );

  return activities.slice(0, 50);
}

export async function getEmployeeProfile(
  trx: TenantTransactionContext,
  employeeId: string,
): Promise<EmployeeProfileResponse> {
  await assertAuthorized(trx, { permission: 'hrm:employee:read' });

  const [employee, activeSalaryStructure, documents, recentActivity] =
    await Promise.all([
      getEmployeeById(trx, employeeId),
      getActiveSalaryStructure(trx, employeeId),
      listEmployeeDocuments(trx, employeeId),
      getEmployeeActivity(trx, employeeId),
    ]);

  return {
    employee,
    activeSalaryStructure,
    documents,
    recentActivity,
  };
}

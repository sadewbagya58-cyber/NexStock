import type {
  DocumentCategory,
  EmployeeDocumentResponse,
  UploadEmployeeDocumentRequest,
} from '@nexstock/contracts';
import { assertAuthorized } from '../../iam/index.js';
import {
  AppError,
  type TenantTransactionContext,
  appendAuditLog,
  generateUuidV7,
} from '../../shared/index.js';

export const MAX_DOCUMENT_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

export const ALLOWED_DOCUMENT_MIMES = [
  'application/pdf',
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
] as const;

export function verifyDocumentMagicBytes(buffer: Buffer, mimeType: string): boolean {
  if (buffer.length < 4) {
    return false;
  }

  const normalizedMime = mimeType.toLowerCase();

  // PDF: %PDF (0x25 0x50 0x44 0x46)
  if (normalizedMime === 'application/pdf') {
    return (
      buffer[0] === 0x25 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x44 &&
      buffer[3] === 0x46
    );
  }

  // JPEG: FF D8 FF
  if (normalizedMime === 'image/jpeg' || normalizedMime === 'image/jpg') {
    return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (normalizedMime === 'image/png') {
    if (buffer.length < 8) return false;
    return (
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47 &&
      buffer[4] === 0x0d &&
      buffer[5] === 0x0a &&
      buffer[6] === 0x1a &&
      buffer[7] === 0x0a
    );
  }

  // WebP: RIFF at offset 0, WEBP at offset 8
  if (normalizedMime === 'image/webp') {
    if (buffer.length < 12) return false;
    const isRiff =
      buffer[0] === 0x52 &&
      buffer[1] === 0x49 &&
      buffer[2] === 0x46 &&
      buffer[3] === 0x46;
    const isWebp =
      buffer[8] === 0x57 &&
      buffer[9] === 0x45 &&
      buffer[10] === 0x42 &&
      buffer[11] === 0x50;
    return isRiff && isWebp;
  }

  return false;
}

export function mapDocumentRow(row: {
  id: string;
  employee_id: string;
  document_category: DocumentCategory;
  document_title: string;
  file_name: string;
  file_size: number;
  mime_type: string;
  storage_path: string;
  uploaded_by_user_id: string;
  notes: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}): EmployeeDocumentResponse {
  return {
    id: row.id,
    employeeId: row.employee_id,
    documentCategory: row.document_category,
    documentTitle: row.document_title,
    fileName: row.file_name,
    fileSize: row.file_size,
    mimeType: row.mime_type,
    storagePath: row.storage_path,
    uploadedByUserId: row.uploaded_by_user_id,
    notes: row.notes,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export async function uploadEmployeeDocument(
  trx: TenantTransactionContext,
  employeeId: string,
  input: UploadEmployeeDocumentRequest,
): Promise<EmployeeDocumentResponse> {
  await assertAuthorized(trx, { permission: 'hrm:document:manage' });

  // Verify employee exists in tenant
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

  // Parse and validate base64 data
  let rawBase64 = input.dataBase64;
  if (rawBase64.includes(';base64,')) {
    rawBase64 = rawBase64.split(';base64,')[1] ?? rawBase64;
  }

  let buffer: Buffer;
  try {
    buffer = Buffer.from(rawBase64, 'base64');
  } catch {
    throw new AppError({
      statusCode: 400,
      errorCode: 'ERR_VALIDATION_FAILED',
      title: 'Invalid Base64 Data',
      detail: 'Failed to decode base64 document content.',
    });
  }

  if (buffer.length === 0) {
    throw new AppError({
      statusCode: 400,
      errorCode: 'ERR_VALIDATION_FAILED',
      title: 'Empty Document Data',
      detail: 'Document content cannot be empty.',
    });
  }

  if (buffer.length > MAX_DOCUMENT_FILE_SIZE) {
    throw new AppError({
      statusCode: 413,
      errorCode: 'HRM_DOCUMENT_TOO_LARGE',
      title: 'Document Too Large',
      detail: `Document size (${(buffer.length / (1024 * 1024)).toFixed(2)} MB) exceeds maximum allowed size of 10 MB.`,
    });
  }

  const normalizedMime = input.mimeType.toLowerCase().trim();
  const isAllowedMime = (ALLOWED_DOCUMENT_MIMES as readonly string[]).includes(
    normalizedMime,
  );

  if (!isAllowedMime) {
    throw new AppError({
      statusCode: 415,
      errorCode: 'HRM_INVALID_DOCUMENT_TYPE',
      title: 'Unsupported Document Type',
      detail: `MIME type "${input.mimeType}" is not supported. Allowed formats: PDF, JPEG, PNG, WebP.`,
    });
  }

  if (!verifyDocumentMagicBytes(buffer, normalizedMime)) {
    throw new AppError({
      statusCode: 400,
      errorCode: 'HRM_INVALID_DOCUMENT_TYPE',
      title: 'Corrupted Or Mismatched Document Data',
      detail: `File content does not match the declared document format (${normalizedMime}).`,
    });
  }

  const documentId = generateUuidV7();
  const sanitizedFileName = input.fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
  const storagePath = `hrm/${trx.tenantId}/employees/${employeeId}/${documentId}-${sanitizedFileName}`;

  await trx.db
    .insertInto('employee_documents')
    .values({
      id: documentId,
      tenant_id: trx.tenantId,
      employee_id: employeeId,
      document_category: input.documentCategory,
      document_title: input.documentTitle.trim(),
      file_name: sanitizedFileName,
      file_size: buffer.length,
      mime_type: normalizedMime,
      storage_path: storagePath,
      data_base64: buffer.toString('base64'),
      uploaded_by_user_id: trx.userId,
      notes: input.notes?.trim() || null,
    })
    .execute();

  await appendAuditLog(trx, {
    action: 'hrm.document.uploaded',
    resourceType: 'employee_document',
    resourceId: documentId,
    metadata: {
      employeeId,
      documentTitle: input.documentTitle,
      category: input.documentCategory,
      fileName: sanitizedFileName,
      fileSize: buffer.length,
      mimeType: normalizedMime,
    },
  });

  return getEmployeeDocument(trx, employeeId, documentId);
}

export async function listEmployeeDocuments(
  trx: TenantTransactionContext,
  employeeId: string,
): Promise<EmployeeDocumentResponse[]> {
  await assertAuthorized(trx, { permission: 'hrm:document:read' });

  const rows = await trx.db
    .selectFrom('employee_documents')
    .select([
      'id',
      'employee_id',
      'document_category',
      'document_title',
      'file_name',
      'file_size',
      'mime_type',
      'storage_path',
      'uploaded_by_user_id',
      'notes',
      'created_at',
      'updated_at',
    ])
    .where('tenant_id', '=', trx.tenantId)
    .where('employee_id', '=', employeeId)
    .orderBy('created_at', 'desc')
    .execute();

  return rows.map((r) =>
    mapDocumentRow(r as unknown as Parameters<typeof mapDocumentRow>[0]),
  );
}

export async function getEmployeeDocument(
  trx: TenantTransactionContext,
  employeeId: string,
  documentId: string,
): Promise<EmployeeDocumentResponse> {
  await assertAuthorized(trx, { permission: 'hrm:document:read' });

  const row = await trx.db
    .selectFrom('employee_documents')
    .select([
      'id',
      'employee_id',
      'document_category',
      'document_title',
      'file_name',
      'file_size',
      'mime_type',
      'storage_path',
      'uploaded_by_user_id',
      'notes',
      'created_at',
      'updated_at',
    ])
    .where('tenant_id', '=', trx.tenantId)
    .where('employee_id', '=', employeeId)
    .where('id', '=', documentId)
    .executeTakeFirst();

  if (!row) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'HRM_DOCUMENT_NOT_FOUND',
      title: 'Document Not Found',
      detail: `Document "${documentId}" for employee "${employeeId}" was not found.`,
    });
  }

  return mapDocumentRow(row as unknown as Parameters<typeof mapDocumentRow>[0]);
}

export async function getEmployeeDocumentContent(
  trx: TenantTransactionContext,
  employeeId: string,
  documentId: string,
): Promise<{
  readonly fileName: string;
  readonly mimeType: string;
  readonly fileSize: number;
  readonly dataBase64: string;
}> {
  await assertAuthorized(trx, { permission: 'hrm:document:read' });

  const row = await trx.db
    .selectFrom('employee_documents')
    .select(['file_name', 'mime_type', 'file_size', 'data_base64'])
    .where('tenant_id', '=', trx.tenantId)
    .where('employee_id', '=', employeeId)
    .where('id', '=', documentId)
    .executeTakeFirst();

  if (!row) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'HRM_DOCUMENT_NOT_FOUND',
      title: 'Document Not Found',
      detail: `Document "${documentId}" for employee "${employeeId}" was not found.`,
    });
  }

  return {
    fileName: row.file_name,
    mimeType: row.mime_type,
    fileSize: row.file_size,
    dataBase64: row.data_base64,
  };
}

export async function deleteEmployeeDocument(
  trx: TenantTransactionContext,
  employeeId: string,
  documentId: string,
): Promise<{ success: true }> {
  await assertAuthorized(trx, { permission: 'hrm:document:manage' });

  const existing = await trx.db
    .selectFrom('employee_documents')
    .select(['id', 'document_title', 'file_name'])
    .where('tenant_id', '=', trx.tenantId)
    .where('employee_id', '=', employeeId)
    .where('id', '=', documentId)
    .executeTakeFirst();

  if (!existing) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'HRM_DOCUMENT_NOT_FOUND',
      title: 'Document Not Found',
      detail: `Document "${documentId}" for employee "${employeeId}" was not found.`,
    });
  }

  await trx.db
    .deleteFrom('employee_documents')
    .where('tenant_id', '=', trx.tenantId)
    .where('employee_id', '=', employeeId)
    .where('id', '=', documentId)
    .execute();

  await appendAuditLog(trx, {
    action: 'hrm.document.deleted',
    resourceType: 'employee_document',
    resourceId: documentId,
    metadata: {
      employeeId,
      documentTitle: existing.document_title,
      fileName: existing.file_name,
    },
  });

  return { success: true };
}

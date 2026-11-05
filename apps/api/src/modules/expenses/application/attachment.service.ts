import type {
  ExpenseAttachmentListResponse,
  ExpenseAttachmentResponse,
  UploadExpenseAttachmentRequest,
} from '@nexstock/contracts';
import { resolveMemberAuthorizationContext } from '../../iam/index.js';
import {
  AppError,
  type TenantTransactionContext,
  appendAuditLog,
  generateUuidV7,
} from '../../shared/index.js';

export const MAX_EXPENSE_ATTACHMENT_SIZE = 10 * 1024 * 1024; // 10 MB

export const ALLOWED_EXPENSE_MIMES = [
  'application/pdf',
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
] as const;

export function verifyAttachmentMagicBytes(buffer: Buffer, mimeType: string): boolean {
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

export interface ExpenseAttachmentRow {
  id: string;
  tenant_id: string;
  expense_id: string;
  file_name: string;
  file_size_bytes: number;
  mime_type: string;
  storage_path: string;
  data_base64: string;
  uploaded_by_user_id: string;
  created_at: Date | string;
}

export function mapAttachment(row: {
  id: string;
  tenant_id: string;
  expense_id: string;
  file_name: string;
  file_size_bytes: number;
  mime_type: string;
  uploaded_by_user_id: string;
  created_at: Date | string;
}): ExpenseAttachmentResponse {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    expenseId: row.expense_id,
    fileName: row.file_name,
    fileSizeBytes: Number(row.file_size_bytes),
    mimeType: row.mime_type,
    uploadedByUserId: row.uploaded_by_user_id,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

export async function uploadExpenseAttachment(
  trx: TenantTransactionContext,
  expenseId: string,
  input: UploadExpenseAttachmentRequest,
): Promise<ExpenseAttachmentResponse> {
  const auth = await resolveMemberAuthorizationContext(trx);
  if (
    !auth.permissions.has('exp:expense:create') &&
    !auth.permissions.has('exp:expense:edit') &&
    !auth.permissions.has('exp:expense:manage')
  ) {
    throw new AppError({
      statusCode: 403,
      errorCode: 'IAM_PERMISSION_DENIED',
      title: 'Permission Denied',
      detail: 'User lacks required permission to upload expense attachments',
    });
  }

  const expense = await trx.db
    .selectFrom('expenses')
    .select(['id', 'tenant_id', 'status'])
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', expenseId)
    .executeTakeFirst();

  if (!expense) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'EXP_EXPENSE_NOT_FOUND',
      title: 'Expense Not Found',
      detail: 'Expense not found',
    });
  }

  const normalizedMime = input.mimeType.toLowerCase();
  if (
    !ALLOWED_EXPENSE_MIMES.includes(
      normalizedMime as (typeof ALLOWED_EXPENSE_MIMES)[number],
    )
  ) {
    throw new AppError({
      statusCode: 400,
      errorCode: 'EXP_INVALID_ATTACHMENT_TYPE',
      title: 'Invalid Attachment Type',
      detail: `Invalid attachment type: "${input.mimeType}". Allowed types: ${ALLOWED_EXPENSE_MIMES.join(', ')}`,
    });
  }

  const cleanBase64 = input.dataBase64.replace(/^data:[^;]+;base64,/, '');
  const buffer = Buffer.from(cleanBase64, 'base64');

  if (buffer.length > MAX_EXPENSE_ATTACHMENT_SIZE) {
    throw new AppError({
      statusCode: 413,
      errorCode: 'EXP_ATTACHMENT_TOO_LARGE',
      title: 'Attachment Too Large',
      detail: `Attachment exceeds maximum size of ${MAX_EXPENSE_ATTACHMENT_SIZE / (1024 * 1024)} MB`,
    });
  }

  if (buffer.length === 0) {
    throw new AppError({
      statusCode: 400,
      errorCode: 'EXP_INVALID_ATTACHMENT_TYPE',
      title: 'Empty Attachment',
      detail: 'Attachment file is empty',
    });
  }

  if (!verifyAttachmentMagicBytes(buffer, normalizedMime)) {
    throw new AppError({
      statusCode: 400,
      errorCode: 'EXP_INVALID_ATTACHMENT_TYPE',
      title: 'Invalid Attachment Signature',
      detail: `File header does not match claimed MIME type "${input.mimeType}"`,
    });
  }

  const attachmentId = generateUuidV7();
  const safeFileName = input.fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
  const storagePath = `expenses/${trx.tenantId}/${expenseId}/${attachmentId}_${safeFileName}`;

  const created = await trx.db
    .insertInto('expense_attachments')
    .values({
      id: attachmentId,
      tenant_id: trx.tenantId,
      expense_id: expenseId,
      file_name: safeFileName,
      file_size_bytes: buffer.length,
      mime_type: normalizedMime,
      storage_path: storagePath,
      data_base64: cleanBase64,
      uploaded_by_user_id: trx.userId,
    })
    .returning([
      'id',
      'tenant_id',
      'expense_id',
      'file_name',
      'file_size_bytes',
      'mime_type',
      'uploaded_by_user_id',
      'created_at',
    ])
    .executeTakeFirstOrThrow();

  await appendAuditLog(trx, {
    action: 'exp.attachment.uploaded',
    resourceType: 'expense_attachment',
    resourceId: attachmentId,
    metadata: {
      expenseId,
      fileName: safeFileName,
      fileSizeBytes: buffer.length,
      mimeType: normalizedMime,
    },
  });

  return mapAttachment(created);
}

export async function listExpenseAttachments(
  trx: TenantTransactionContext,
  expenseId: string,
): Promise<ExpenseAttachmentListResponse> {
  const auth = await resolveMemberAuthorizationContext(trx);
  if (
    !auth.permissions.has('exp:expense:read') &&
    !auth.permissions.has('exp:expense:manage')
  ) {
    throw new AppError({
      statusCode: 403,
      errorCode: 'IAM_PERMISSION_DENIED',
      title: 'Permission Denied',
      detail: 'User lacks required permission to view expense attachments',
    });
  }

  const rows = await trx.db
    .selectFrom('expense_attachments')
    .select([
      'id',
      'tenant_id',
      'expense_id',
      'file_name',
      'file_size_bytes',
      'mime_type',
      'uploaded_by_user_id',
      'created_at',
    ])
    .where('tenant_id', '=', trx.tenantId)
    .where('expense_id', '=', expenseId)
    .orderBy('created_at', 'asc')
    .execute();

  return {
    items: rows.map(mapAttachment),
  };
}

export async function getExpenseAttachmentContent(
  trx: TenantTransactionContext,
  expenseId: string,
  attachmentId: string,
): Promise<ExpenseAttachmentRow> {
  const auth = await resolveMemberAuthorizationContext(trx);
  if (
    !auth.permissions.has('exp:expense:read') &&
    !auth.permissions.has('exp:expense:manage')
  ) {
    throw new AppError({
      statusCode: 403,
      errorCode: 'IAM_PERMISSION_DENIED',
      title: 'Permission Denied',
      detail: 'User lacks required permission to view expense attachments',
    });
  }

  const row = await trx.db
    .selectFrom('expense_attachments')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('expense_id', '=', expenseId)
    .where('id', '=', attachmentId)
    .executeTakeFirst();

  if (!row) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'EXP_ATTACHMENT_NOT_FOUND',
      title: 'Attachment Not Found',
      detail: 'Attachment not found',
    });
  }

  return row as unknown as ExpenseAttachmentRow;
}

export async function deleteExpenseAttachment(
  trx: TenantTransactionContext,
  expenseId: string,
  attachmentId: string,
): Promise<void> {
  const auth = await resolveMemberAuthorizationContext(trx);
  if (
    !auth.permissions.has('exp:expense:edit') &&
    !auth.permissions.has('exp:expense:manage')
  ) {
    throw new AppError({
      statusCode: 403,
      errorCode: 'IAM_PERMISSION_DENIED',
      title: 'Permission Denied',
      detail: 'User lacks required permission to delete expense attachments',
    });
  }

  const existing = await trx.db
    .selectFrom('expense_attachments')
    .select(['id', 'file_name', 'tenant_id'])
    .where('tenant_id', '=', trx.tenantId)
    .where('expense_id', '=', expenseId)
    .where('id', '=', attachmentId)
    .executeTakeFirst();

  if (!existing) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'EXP_ATTACHMENT_NOT_FOUND',
      title: 'Attachment Not Found',
      detail: 'Attachment not found',
    });
  }

  await trx.db
    .deleteFrom('expense_attachments')
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', attachmentId)
    .execute();

  await appendAuditLog(trx, {
    action: 'exp.attachment.deleted',
    resourceType: 'expense_attachment',
    resourceId: attachmentId,
    metadata: { expenseId, fileName: existing.file_name },
  });
}

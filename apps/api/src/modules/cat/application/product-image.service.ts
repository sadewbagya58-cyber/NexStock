import {
  type UploadProductImageRequest,
  type UploadProductImageResponse,
} from '@nexstock/contracts';
import { type Kysely } from 'kysely';
import { assertAuthorized } from '../../iam/index.js';
import {
  AppError,
  type NexStockDatabase,
  type TenantTransactionContext,
  appendAuditLog,
  generateUuidV7,
} from '../../shared/index.js';

export const MAX_IMAGE_FILE_SIZE = 5 * 1024 * 1024; // 5 MB
export const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

/**
 * Validates binary magic bytes against declared MIME type to prevent malicious uploads.
 */
export function verifyImageMagicBytes(buffer: Buffer, mimeType: string): boolean {
  if (buffer.length < 12) {
    return false;
  }

  if (mimeType === 'image/jpeg') {
    // JPEG starts with FF D8 FF
    return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }

  if (mimeType === 'image/png') {
    // PNG starts with 89 50 4E 47 0D 0A 1A 0A
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

  if (mimeType === 'image/webp') {
    // WebP: RIFF at offset 0, WEBP at offset 8
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

/**
 * Uploads, validates, and stores a tenant-scoped product image asset.
 */
export async function uploadProductImage(
  trx: TenantTransactionContext,
  input: UploadProductImageRequest,
): Promise<UploadProductImageResponse> {
  await assertAuthorized(trx, { permission: 'cat:product:manage' });

  const filename = input.filename.trim();
  if (!filename) {
    throw new AppError({
      statusCode: 400,
      errorCode: 'ERR_VALIDATION_FAILED',
      title: 'Invalid Image Filename',
      detail: 'Filename cannot be empty.',
    });
  }

  if (!ALLOWED_MIME_TYPES.includes(input.mimeType)) {
    throw new AppError({
      statusCode: 400,
      errorCode: 'CAT_INVALID_IMAGE_TYPE',
      title: 'Unsupported Image Type',
      detail: `MIME type "${input.mimeType}" is not supported. Only JPEG, PNG, and WebP are allowed.`,
    });
  }

  let buffer: Buffer;
  try {
    buffer = Buffer.from(input.dataBase64, 'base64');
  } catch {
    throw new AppError({
      statusCode: 400,
      errorCode: 'ERR_VALIDATION_FAILED',
      title: 'Malformed Base64 Data',
      detail: 'The provided dataBase64 string could not be decoded.',
    });
  }

  if (buffer.length > MAX_IMAGE_FILE_SIZE) {
    throw new AppError({
      statusCode: 400,
      errorCode: 'CAT_IMAGE_TOO_LARGE',
      title: 'Image File Too Large',
      detail: `Product image size (${(buffer.length / (1024 * 1024)).toFixed(2)} MB) exceeds the maximum limit of 5.00 MB.`,
    });
  }

  if (buffer.length < 12 || !verifyImageMagicBytes(buffer, input.mimeType)) {
    throw new AppError({
      statusCode: 400,
      errorCode: 'CAT_INVALID_IMAGE_TYPE',
      title: 'Invalid Image Content',
      detail: 'File content does not match the declared image format (JPEG, PNG, WebP) or is corrupted.',
    });
  }

  const ext =
    input.mimeType === 'image/jpeg' ? 'jpg' : input.mimeType === 'image/png' ? 'png' : 'webp';
  const mediaId = generateUuidV7();
  const storagePath = `${trx.tenantId}/products/${mediaId}.${ext}`;

  await trx.db
    .insertInto('product_media_assets')
    .values({
      id: mediaId,
      tenant_id: trx.tenantId,
      file_name: filename,
      mime_type: input.mimeType,
      file_size: buffer.length,
      storage_path: storagePath,
      data_base64: input.dataBase64,
      created_at: new Date(),
    })
    .execute();

  await appendAuditLog(trx, {
    action: 'PRODUCT_IMAGE_UPLOADED',
    resourceType: 'product_media_asset',
    resourceId: mediaId,
    metadata: {
      fileName: filename,
      mimeType: input.mimeType,
      fileSize: buffer.length,
      storagePath,
    },
  });

  const imageUrl = `/v1/media/${trx.tenantId}/${mediaId}.${ext}`;

  return {
    imageUrl,
    mimeType: input.mimeType,
    size: buffer.length,
    storagePath,
  };
}

/**
 * Retrieves a media asset by tenant and asset ID for content delivery.
 */
export async function getProductMediaAsset(
  db: Kysely<NexStockDatabase>,
  tenantId: string,
  assetId: string,
): Promise<{ mimeType: string; buffer: Buffer; fileName: string } | null> {
  const row = await db
    .selectFrom('product_media_assets')
    .select(['file_name', 'mime_type', 'data_base64'])
    .where('tenant_id', '=', tenantId)
    .where('id', '=', assetId)
    .executeTakeFirst();

  if (!row) {
    return null;
  }

  return {
    fileName: row.file_name,
    mimeType: row.mime_type,
    buffer: Buffer.from(row.data_base64, 'base64'),
  };
}

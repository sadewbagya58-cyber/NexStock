import {
  type UploadProductImageRequest,
  type UploadProductImageResponse,
} from '@nexstock/contracts';
import { type Kysely, sql } from 'kysely';
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
export type AllowedMimeType = (typeof ALLOWED_MIME_TYPES)[number];

/**
 * Validates binary magic bytes against declared MIME type to prevent malicious uploads.
 */
export function verifyImageMagicBytes(buffer: Buffer, mimeType: string): boolean {
  if (buffer.length < 12) {
    return false;
  }

  if (mimeType === 'image/jpeg' || mimeType === 'image/jpg') {
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
 * Detects the canonical image MIME type directly from binary magic bytes.
 */
export function detectImageMimeType(buffer: Buffer): AllowedMimeType | null {
  if (buffer.length < 12) {
    return null;
  }

  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return 'image/png';
  }

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
  if (isRiff && isWebp) {
    return 'image/webp';
  }

  return null;
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

  const rawMime = (input.mimeType || '').toLowerCase().trim();
  const normalizedMimeType = (
    rawMime === 'image/jpg' ? 'image/jpeg' : rawMime
  ) as AllowedMimeType;

  if (!ALLOWED_MIME_TYPES.includes(normalizedMimeType)) {
    throw new AppError({
      statusCode: 400,
      errorCode: 'CAT_INVALID_IMAGE_TYPE',
      title: 'Unsupported Image Type',
      detail: `MIME type "${input.mimeType}" is not supported. Only JPEG, PNG, and WebP are allowed.`,
    });
  }

  const rawBase64 = input.dataBase64.includes(',')
    ? input.dataBase64.split(',')[1]!
    : input.dataBase64;

  let buffer: Buffer;
  try {
    buffer = Buffer.from(rawBase64, 'base64');
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

  // Detect genuine binary format from magic bytes to support cross-platform image uploads
  const detectedMime = detectImageMimeType(buffer);
  if (!detectedMime) {
    throw new AppError({
      statusCode: 400,
      errorCode: 'CAT_INVALID_IMAGE_TYPE',
      title: 'Invalid Image Content',
      detail: 'File content does not match the declared image format (JPEG, PNG, WebP) or is corrupted.',
    });
  }

  // Use the verified binary format (reconciles client/browser MIME discrepancies)
  const effectiveMime: AllowedMimeType = detectedMime;

  const ext =
    effectiveMime === 'image/jpeg' ? 'jpg' : effectiveMime === 'image/png' ? 'png' : 'webp';
  const mediaId = generateUuidV7();
  const storagePath = `${trx.tenantId}/products/${mediaId}.${ext}`;

  await trx.db
    .insertInto('product_media_assets')
    .values({
      id: mediaId,
      tenant_id: trx.tenantId,
      file_name: filename,
      mime_type: effectiveMime,
      file_size: buffer.length,
      storage_path: storagePath,
      data_base64: buffer.toString('base64'),
      created_at: new Date(),
    })
    .execute();

  await appendAuditLog(trx, {
    action: 'PRODUCT_IMAGE_UPLOADED',
    resourceType: 'product_media_asset',
    resourceId: mediaId,
    metadata: {
      fileName: filename,
      mimeType: effectiveMime,
      fileSize: buffer.length,
      storagePath,
    },
  });

  const imageUrl = `/v1/media/${trx.tenantId}/${mediaId}.${ext}`;

  return {
    imageUrl,
    mimeType: effectiveMime,
    size: buffer.length,
    storagePath,
  };
}

/**
 * Retrieves a media asset by tenant and asset ID for content delivery.
 * Sets transaction-scoped app.current_tenant_id so PostgreSQL Row Level Security (RLS)
 * permits serving the asset.
 */
export async function getProductMediaAsset(
  db: Kysely<NexStockDatabase>,
  tenantId: string,
  assetId: string,
): Promise<{ mimeType: string; buffer: Buffer; fileName: string } | null> {
  return db.transaction().execute(async (trx) => {
    try {
      await sql`SET LOCAL ROLE nexstock_app_user`.execute(trx);
      await sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`.execute(trx);
    } catch {
      // In SQLite / test environments, session variables don't exist
    }

    const row = await trx
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
  });
}

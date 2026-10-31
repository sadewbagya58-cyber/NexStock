import {
  type BarcodeType,
  type CreateProductBarcodeRequest,
  type GenerateBarcodeQuery,
  type GenerateBarcodeResponse,
  type ProductBarcodeResponse,
  type TenantBarcodeSettings,
  type UpdateProductBarcodeRequest,
  type UpdateTenantBarcodeSettingsRequest,
} from '@nexstock/contracts';
import { assertAuthorized } from '../../iam/index.js';
import {
  AppError,
  type TenantTransactionContext,
  appendAuditLog,
  generateUuidV7,
} from '../../shared/index.js';

/**
 * Calculates standard GS1 Modulo-10 checksum digit for an EAN-13 (12 digits) or EAN-8 (7 digits).
 */
export function calculateEanCheckDigit(digits: string): string {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    const d = parseInt(digits[i]!, 10);
    if (isNaN(d)) {
      throw new AppError({
        statusCode: 400,
        errorCode: 'ERR_VALIDATION_FAILED',
        title: 'Invalid Barcode Digits',
        detail: `Expected numeric digits, received "${digits}".`,
      });
    }
    const posFromRight = digits.length - i;
    const mult = (posFromRight % 2 === 1) ? 3 : 1;
    sum += d * mult;
  }
  const rem = sum % 10;
  return rem === 0 ? '0' : String(10 - rem);
}

/**
 * Validates check digit of an EAN-13, EAN-8, or UPC-A barcode.
 */
export function validateBarcodeCheckDigit(barcode: string, format: BarcodeType): boolean {
  const clean = barcode.trim();
  if (format === 'EAN13' && clean.length === 13 && /^\d+$/.test(clean)) {
    const payload = clean.slice(0, 12);
    const expected = calculateEanCheckDigit(payload);
    return clean[12] === expected;
  }
  if (format === 'EAN8' && clean.length === 8 && /^\d+$/.test(clean)) {
    const payload = clean.slice(0, 7);
    const expected = calculateEanCheckDigit(payload);
    return clean[7] === expected;
  }
  if (format === 'UPCA' && clean.length === 12 && /^\d+$/.test(clean)) {
    // UPC-A is equivalent to EAN-13 with a leading zero
    const payload = '0' + clean.slice(0, 11);
    const expected = calculateEanCheckDigit(payload);
    return clean[11] === expected;
  }
  return true;
}

/**
 * Generates a unique, collision-free internal barcode.
 */
export async function generateInternalBarcode(
  trx: TenantTransactionContext,
  query?: GenerateBarcodeQuery,
): Promise<GenerateBarcodeResponse> {
  await assertAuthorized(trx, { permission: 'cat:product:manage' });

  const settings = await getTenantBarcodeSettings(trx);
  const format: BarcodeType = query?.format ?? query?.symbology ?? 'CODE128';
  const prefix = (query?.prefix ?? settings.internalPrefix ?? 'NB').trim().toUpperCase();

  let candidateBarcode = '';
  let attempts = 0;
  const maxAttempts = 15;

  while (attempts < maxAttempts) {
    attempts++;

    if (format === 'EAN13') {
      // Internal EAN-13 uses GS1 restricted-circulation prefix (e.g. 200–299)
      const numPrefix = /^\d{2,3}$/.test(prefix) ? prefix : '200';
      const randomLength = 12 - numPrefix.length;
      let randomDigits = '';
      for (let i = 0; i < randomLength; i++) {
        randomDigits += Math.floor(Math.random() * 10).toString();
      }
      const base12 = (numPrefix + randomDigits).slice(0, 12);
      const checkDigit = calculateEanCheckDigit(base12);
      candidateBarcode = base12 + checkDigit;
    } else if (format === 'EAN8') {
      const numPrefix = /^\d{2,3}$/.test(prefix) ? prefix : '20';
      const randomLength = 7 - numPrefix.length;
      let randomDigits = '';
      for (let i = 0; i < randomLength; i++) {
        randomDigits += Math.floor(Math.random() * 10).toString();
      }
      const base7 = (numPrefix + randomDigits).slice(0, 7);
      const checkDigit = calculateEanCheckDigit(base7);
      candidateBarcode = base7 + checkDigit;
    } else if (format === 'UPCA') {
      const numPrefix = /^\d{1,2}$/.test(prefix) ? prefix : '0';
      const randomLength = 11 - numPrefix.length;
      let randomDigits = '';
      for (let i = 0; i < randomLength; i++) {
        randomDigits += Math.floor(Math.random() * 10).toString();
      }
      const base11 = (numPrefix + randomDigits).slice(0, 11);
      const checkDigit = calculateEanCheckDigit(base11);
      candidateBarcode = base11 + checkDigit;
    } else {
      // CODE128 / Default alphanumeric
      const timestampPart = Date.now().toString().slice(-6);
      const randomPart = Math.random().toString(36).substring(2, 6).toUpperCase();
      candidateBarcode = `${prefix}-${timestampPart}${randomPart}`;
    }

    // Verify collision resistance within tenant
    const existing = await trx.db
      .selectFrom('product_barcodes')
      .select(['id'])
      .where('tenant_id', '=', trx.tenantId)
      .where('barcode', '=', candidateBarcode)
      .executeTakeFirst();

    if (!existing) {
      const existingProduct = await trx.db
        .selectFrom('products')
        .select(['id'])
        .where('tenant_id', '=', trx.tenantId)
        .where('primary_barcode', '=', candidateBarcode)
        .executeTakeFirst();

      if (!existingProduct) {
        break;
      }
    }
  }

  if (attempts >= maxAttempts) {
    throw new AppError({
      statusCode: 500,
      errorCode: 'ERR_INTERNAL_SERVER_ERROR',
      title: 'Barcode Generation Failed',
      detail: 'Could not generate a unique collision-free barcode within maximum attempts. Please try again.',
    });
  }

  return {
    barcode: candidateBarcode,
    format,
    symbology: format,
    prefix,
  };
}

/**
 * Lists all registered barcodes for a product.
 */
export async function listProductBarcodes(
  trx: TenantTransactionContext,
  productId: string,
): Promise<ProductBarcodeResponse[]> {
  await assertAuthorized(trx, { permission: 'cat:product:read' });

  const rows = await trx.db
    .selectFrom('product_barcodes')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('product_id', '=', productId)
    .orderBy('is_primary', 'desc')
    .orderBy('created_at', 'asc')
    .execute();

  return rows.map((r) => ({
    id: r.id,
    barcode: r.barcode,
    barcodeType: r.barcode_type as BarcodeType,
    symbology: r.barcode_type as BarcodeType,
    uomCode: r.uom_code,
    isPrimary: r.is_primary,
    isActive: r.is_active ?? true,
  }));
}

/**
 * Registers a new barcode mapping for an existing product.
 */
export async function addProductBarcode(
  trx: TenantTransactionContext,
  productId: string,
  input: CreateProductBarcodeRequest,
): Promise<ProductBarcodeResponse> {
  await assertAuthorized(trx, { permission: 'cat:product:manage' });

  const cleanBarcode = input.barcode.trim();
  if (!cleanBarcode) {
    throw new AppError({
      statusCode: 400,
      errorCode: 'ERR_VALIDATION_FAILED',
      title: 'Invalid Barcode',
      detail: 'Barcode cannot be blank.',
    });
  }

  const format: BarcodeType = input.barcodeType ?? input.symbology ?? 'CODE128';
  if (!validateBarcodeCheckDigit(cleanBarcode, format)) {
    throw new AppError({
      statusCode: 400,
      errorCode: 'ERR_VALIDATION_FAILED',
      title: 'Invalid Barcode Check Digit',
      detail: `Check digit for ${format} barcode "${cleanBarcode}" is invalid.`,
    });
  }

  // Verify product exists in tenant
  const product = await trx.db
    .selectFrom('products')
    .select(['id', 'sku', 'base_uom', 'primary_barcode'])
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', productId)
    .executeTakeFirst();

  if (!product) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'ERR_NOT_FOUND',
      title: 'Product Not Found',
      detail: `Product "${productId}" was not found in this organization.`,
    });
  }

  // Enforce tenant-scoped uniqueness
  const conflict = await trx.db
    .selectFrom('product_barcodes')
    .select(['product_id', 'barcode'])
    .where('tenant_id', '=', trx.tenantId)
    .where('barcode', '=', cleanBarcode)
    .executeTakeFirst();

  if (conflict) {
    throw new AppError({
      statusCode: 409,
      errorCode: 'CAT_DUPLICATE_BARCODE',
      title: 'Duplicate Barcode',
      detail: `Barcode "${cleanBarcode}" is already assigned to a product in this organization.`,
    });
  }

  const uomCode = (input.uomCode ?? product.base_uom).trim().toUpperCase();
  const isPrimary = Boolean(input.isPrimary);
  const isActive = input.isActive !== false;
  const now = new Date();
  const id = generateUuidV7();

  if (isPrimary) {
    // Clear is_primary on other barcodes for this product
    await trx.db
      .updateTable('product_barcodes')
      .set({ is_primary: false, updated_at: now })
      .where('tenant_id', '=', trx.tenantId)
      .where('product_id', '=', productId)
      .execute();

    // Update primary_barcode on product
    await trx.db
      .updateTable('products')
      .set({ primary_barcode: cleanBarcode, updated_at: now })
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', productId)
      .execute();
  } else if (!product.primary_barcode && input.isPrimary !== false) {
    // If no primary barcode exists and not explicitly opted out, promote this one
    await trx.db
      .updateTable('products')
      .set({ primary_barcode: cleanBarcode, updated_at: now })
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', productId)
      .execute();
  }

  const willBePrimary = isPrimary || (!product.primary_barcode && input.isPrimary !== false);

  await trx.db
    .insertInto('product_barcodes')
    .values({
      id,
      tenant_id: trx.tenantId,
      product_id: productId,
      barcode: cleanBarcode,
      barcode_type: format,
      uom_code: uomCode,
      is_primary: willBePrimary,
      is_active: isActive,
      created_at: now,
      updated_at: now,
    })
    .execute();

  await appendAuditLog(trx, {
    action: 'CAT_BARCODE_CREATED',
    resourceType: 'product_barcode',
    resourceId: id,
    metadata: {
      productId,
      sku: product.sku,
      barcode: cleanBarcode,
      format,
      isPrimary: willBePrimary,
      isActive,
    },
  });

  return {
    id,
    barcode: cleanBarcode,
    barcodeType: format,
    symbology: format,
    uomCode,
    isPrimary: willBePrimary,
    isActive,
  };
}

/**
 * Updates an existing barcode mapping (toggle active status, set primary, change UoM/symbology).
 */
export async function updateProductBarcode(
  trx: TenantTransactionContext,
  productId: string,
  barcodeId: string,
  input: UpdateProductBarcodeRequest,
): Promise<ProductBarcodeResponse> {
  await assertAuthorized(trx, { permission: 'cat:product:manage' });

  const existing = await trx.db
    .selectFrom('product_barcodes')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('product_id', '=', productId)
    .where('id', '=', barcodeId)
    .executeTakeFirst();

  if (!existing) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'ERR_NOT_FOUND',
      title: 'Barcode Not Found',
      detail: `Barcode mapping "${barcodeId}" not found for product "${productId}".`,
    });
  }

  const now = new Date();
  let effectiveIsPrimary = input.isPrimary !== undefined ? input.isPrimary : existing.is_primary;
  const nextIsActive = input.isActive !== undefined ? input.isActive : (existing.is_active ?? true);
  const nextType = input.barcodeType ?? input.symbology ?? existing.barcode_type;
  const nextUom = input.uomCode ? input.uomCode.trim().toUpperCase() : existing.uom_code;

  if (!nextIsActive && existing.is_primary) {
    // If deactivating a primary barcode, clear as primary on product
    await trx.db
      .updateTable('products')
      .set({ primary_barcode: null, updated_at: now })
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', productId)
      .execute();
    effectiveIsPrimary = false;
  } else if (effectiveIsPrimary && !existing.is_primary) {
    // Clear is_primary on other barcodes
    await trx.db
      .updateTable('product_barcodes')
      .set({ is_primary: false, updated_at: now })
      .where('tenant_id', '=', trx.tenantId)
      .where('product_id', '=', productId)
      .execute();

    // Update product table primary_barcode
    await trx.db
      .updateTable('products')
      .set({ primary_barcode: existing.barcode, updated_at: now })
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', productId)
      .execute();
  } else if (!effectiveIsPrimary && existing.is_primary) {
    // Remove as primary on product
    await trx.db
      .updateTable('products')
      .set({ primary_barcode: null, updated_at: now })
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', productId)
      .execute();
  }

  await trx.db
    .updateTable('product_barcodes')
    .set({
      barcode_type: nextType,
      uom_code: nextUom,
      is_primary: effectiveIsPrimary,
      is_active: nextIsActive,
      updated_at: now,
    })
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', barcodeId)
    .execute();

  await appendAuditLog(trx, {
    action: 'CAT_BARCODE_UPDATED',
    resourceType: 'product_barcode',
    resourceId: barcodeId,
    metadata: {
      productId,
      barcode: existing.barcode,
      isPrimary: effectiveIsPrimary,
      isActive: nextIsActive,
    },
  });

  return {
    id: barcodeId,
    barcode: existing.barcode,
    barcodeType: nextType as BarcodeType,
    symbology: nextType as BarcodeType,
    uomCode: nextUom,
    isPrimary: effectiveIsPrimary,
    isActive: nextIsActive,
  };
}

/**
 * Removes or deactivates a barcode mapping.
 */
export async function deleteProductBarcode(
  trx: TenantTransactionContext,
  productId: string,
  barcodeId: string,
): Promise<{ success: boolean }> {
  await assertAuthorized(trx, { permission: 'cat:product:manage' });

  const existing = await trx.db
    .selectFrom('product_barcodes')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('product_id', '=', productId)
    .where('id', '=', barcodeId)
    .executeTakeFirst();

  if (!existing) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'ERR_NOT_FOUND',
      title: 'Barcode Not Found',
      detail: `Barcode mapping "${barcodeId}" not found for product "${productId}".`,
    });
  }

  const now = new Date();

  // If this was primary, clear primary on product or pick next active
  if (existing.is_primary) {
    const nextBarcode = await trx.db
      .selectFrom('product_barcodes')
      .selectAll()
      .where('tenant_id', '=', trx.tenantId)
      .where('product_id', '=', productId)
      .where('id', '!=', barcodeId)
      .where('is_active', '=', true)
      .orderBy('created_at', 'asc')
      .executeTakeFirst();

    if (nextBarcode) {
      await trx.db
        .updateTable('product_barcodes')
        .set({ is_primary: true, updated_at: now })
        .where('tenant_id', '=', trx.tenantId)
        .where('id', '=', nextBarcode.id)
        .execute();

      await trx.db
        .updateTable('products')
        .set({ primary_barcode: nextBarcode.barcode, updated_at: now })
        .where('tenant_id', '=', trx.tenantId)
        .where('id', '=', productId)
        .execute();
    } else {
      await trx.db
        .updateTable('products')
        .set({ primary_barcode: null, updated_at: now })
        .where('tenant_id', '=', trx.tenantId)
        .where('id', '=', productId)
        .execute();
    }
  }

  await trx.db
    .deleteFrom('product_barcodes')
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', barcodeId)
    .execute();

  await appendAuditLog(trx, {
    action: 'CAT_BARCODE_DELETED',
    resourceType: 'product_barcode',
    resourceId: barcodeId,
    metadata: {
      productId,
      barcode: existing.barcode,
    },
  });

  return { success: true };
}

/**
 * Retrieves organization-level barcode & POS scanning configuration.
 */
export async function getTenantBarcodeSettings(
  trx: TenantTransactionContext,
): Promise<TenantBarcodeSettings> {
  const row = await trx.db
    .selectFrom('tenant_barcode_settings')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .executeTakeFirst();

  if (row) {
    return {
      tenantId: row.tenant_id,
      barcodeManagementEnabled: row.barcode_management_enabled,
      internalGenerationEnabled: row.internal_generation_enabled,
      internalPrefix: row.internal_prefix,
      labelsEnabled: row.labels_enabled,
      hardwareScannerEnabled: row.hardware_scanner_enabled,
      cameraScannerEnabled: row.camera_scanner_enabled,
      autoAddToCart: row.auto_add_to_cart,
      incrementOnDuplicate: row.increment_on_duplicate,
      unknownBarcodeAction: row.unknown_barcode_action as 'PROMPT' | 'IGNORE' | 'MANUAL_SEARCH',
      defaultScanMode: row.default_scan_mode as 'HARDWARE' | 'CAMERA' | 'MANUAL',
      ...(row.updated_at ? { updatedAt: new Date(row.updated_at).toISOString() } : {}),
    };
  }

  // Default settings
  return {
    tenantId: trx.tenantId,
    barcodeManagementEnabled: true,
    internalGenerationEnabled: true,
    internalPrefix: 'NB',
    labelsEnabled: true,
    hardwareScannerEnabled: true,
    cameraScannerEnabled: true,
    autoAddToCart: true,
    incrementOnDuplicate: true,
    unknownBarcodeAction: 'PROMPT',
    defaultScanMode: 'HARDWARE',
  };
}

/**
 * Updates organization-level barcode & POS scanning configuration.
 */
export async function updateTenantBarcodeSettings(
  trx: TenantTransactionContext,
  input: UpdateTenantBarcodeSettingsRequest,
): Promise<TenantBarcodeSettings> {
  await assertAuthorized(trx, { permission: 'cat:product:manage' });

  const current = await getTenantBarcodeSettings(trx);
  const now = new Date();

  const merged = {
    barcodeManagementEnabled:
      input.barcodeManagementEnabled !== undefined
        ? input.barcodeManagementEnabled
        : current.barcodeManagementEnabled,
    internalGenerationEnabled:
      input.internalGenerationEnabled !== undefined
        ? input.internalGenerationEnabled
        : current.internalGenerationEnabled,
    internalPrefix: input.internalPrefix ? input.internalPrefix.trim().toUpperCase() : current.internalPrefix,
    labelsEnabled: input.labelsEnabled !== undefined ? input.labelsEnabled : current.labelsEnabled,
    hardwareScannerEnabled:
      input.hardwareScannerEnabled !== undefined
        ? input.hardwareScannerEnabled
        : current.hardwareScannerEnabled,
    cameraScannerEnabled:
      input.cameraScannerEnabled !== undefined ? input.cameraScannerEnabled : current.cameraScannerEnabled,
    autoAddToCart: input.autoAddToCart !== undefined ? input.autoAddToCart : current.autoAddToCart,
    incrementOnDuplicate:
      input.incrementOnDuplicate !== undefined ? input.incrementOnDuplicate : current.incrementOnDuplicate,
    unknownBarcodeAction: input.unknownBarcodeAction ?? current.unknownBarcodeAction,
    defaultScanMode: input.defaultScanMode ?? current.defaultScanMode,
  };

  await trx.db
    .insertInto('tenant_barcode_settings')
    .values({
      tenant_id: trx.tenantId,
      barcode_management_enabled: merged.barcodeManagementEnabled,
      internal_generation_enabled: merged.internalGenerationEnabled,
      internal_prefix: merged.internalPrefix,
      labels_enabled: merged.labelsEnabled,
      hardware_scanner_enabled: merged.hardwareScannerEnabled,
      camera_scanner_enabled: merged.cameraScannerEnabled,
      auto_add_to_cart: merged.autoAddToCart,
      increment_on_duplicate: merged.incrementOnDuplicate,
      unknown_barcode_action: merged.unknownBarcodeAction,
      default_scan_mode: merged.defaultScanMode,
      created_at: now,
      updated_at: now,
    })
    .onConflict((oc) =>
      oc.column('tenant_id').doUpdateSet({
        barcode_management_enabled: merged.barcodeManagementEnabled,
        internal_generation_enabled: merged.internalGenerationEnabled,
        internal_prefix: merged.internalPrefix,
        labels_enabled: merged.labelsEnabled,
        hardware_scanner_enabled: merged.hardwareScannerEnabled,
        camera_scanner_enabled: merged.cameraScannerEnabled,
        auto_add_to_cart: merged.autoAddToCart,
        increment_on_duplicate: merged.incrementOnDuplicate,
        unknown_barcode_action: merged.unknownBarcodeAction,
        default_scan_mode: merged.defaultScanMode,
        updated_at: now,
      }),
    )
    .execute();

  await appendAuditLog(trx, {
    action: 'ORG_BARCODE_SETTINGS_UPDATED',
    resourceType: 'tenant_barcode_settings',
    resourceId: trx.tenantId,
    metadata: merged,
  });

  return {
    tenantId: trx.tenantId,
    ...merged,
    updatedAt: now.toISOString(),
  };
}

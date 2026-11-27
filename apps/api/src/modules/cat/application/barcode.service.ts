import {
  type BarcodePriceSourceMode,
  type BarcodeType,
  type CreateProductBarcodeRequest,
  type GenerateBarcodeQuery,
  type GenerateBarcodeResponse,
  type ProductBarcodeResponse,
  type TenantBarcodeSettings,
  type UpdateProductBarcodeRequest,
  type UpdateTenantBarcodeSettingsRequest,
} from '@nexstock/contracts';
import {
  Money,
  Quantity,
  UomConversionError,
  convertQuantityBetweenUoms,
  divideAndRoundBigInt,
} from '@nexstock/domain-core';
import { sql } from 'kysely';
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

export const SUPPORTED_GENERATION_SYMBOLOGIES: readonly BarcodeType[] = [
  'CODE128',
  'CODE39',
  'EAN13',
  'EAN8',
  'UPCA',
  'UPCE',
  'ITF',
  'QR',
  'CUSTOM',
];

/**
 * Validates check digit or format of a barcode for supported symbologies.
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
  if (format === 'UPCE' && clean.length === 8 && /^\d+$/.test(clean)) {
    const payload = clean.slice(0, 7);
    const expected = calculateEanCheckDigit(payload);
    return clean[7] === expected;
  }
  if (format === 'ITF' && clean.length % 2 === 0 && /^\d+$/.test(clean)) {
    if (clean.length === 14) {
      const payload = clean.slice(0, 13);
      const expected = calculateEanCheckDigit(payload);
      return clean[13] === expected;
    }
    return true;
  }
  if (format === 'CODE39') {
    return /^[A-Z0-9\-. $/+%]+$/.test(clean);
  }
  if (format === 'CODE128') {
    return /^[\x20-\x7E]+$/.test(clean);
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

  if (!SUPPORTED_GENERATION_SYMBOLOGIES.includes(format)) {
    throw new AppError({
      statusCode: 400,
      errorCode: 'CAT_UNSUPPORTED_SYMBOLOGY',
      title: 'Unsupported Barcode Symbology',
      detail: `Symbology "${format}" is not supported for internal generation. Supported: ${SUPPORTED_GENERATION_SYMBOLOGIES.join(', ')}.`,
    });
  }

  const rawPrefix = (query?.prefix ?? settings.internalPrefix ?? 'NB').trim().toUpperCase();
  const prefix = rawPrefix || 'NB';

  let candidateBarcode = '';
  let attempts = 0;
  const maxAttempts = 20;

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
      const checkDigit = calculateEanCheckDigit('0' + base11);
      candidateBarcode = base11 + checkDigit;
    } else if (format === 'UPCE') {
      // UPC-E: 8 numeric digits ('0' + 6 random digits + check digit)
      let randomDigits = '';
      for (let i = 0; i < 6; i++) {
        randomDigits += Math.floor(Math.random() * 10).toString();
      }
      const base7 = '0' + randomDigits;
      const checkDigit = calculateEanCheckDigit(base7);
      candidateBarcode = base7 + checkDigit;
    } else if (format === 'ITF') {
      // ITF-14: 14 numeric digits ('1' packaging indicator + 12 random digits + check digit)
      const numPrefix = /^\d{1,3}$/.test(prefix) ? prefix : '1';
      const randomLength = 13 - numPrefix.length;
      let randomDigits = '';
      for (let i = 0; i < randomLength; i++) {
        randomDigits += Math.floor(Math.random() * 10).toString();
      }
      const base13 = (numPrefix + randomDigits).slice(0, 13);
      const checkDigit = calculateEanCheckDigit(base13);
      candidateBarcode = base13 + checkDigit;
    } else if (format === 'CODE39') {
      // Code 39: uppercase alphanumeric with hyphens
      const cleanPrefix = prefix.replace(/[^A-Z0-9]/g, '') || 'NB';
      const timestampPart = Date.now().toString().slice(-6);
      const randomPart = Math.random().toString(36).substring(2, 6).toUpperCase();
      candidateBarcode = `${cleanPrefix}-${timestampPart}${randomPart}`;
    } else {
      // CODE128 / QR / CUSTOM
      const timestampPart = Date.now().toString().slice(-6);
      const randomPart = Math.random().toString(36).substring(2, 6).toUpperCase();
      candidateBarcode = `${prefix}-${timestampPart}${randomPart}`;
    }

    // Verify candidate passes format and checksum validation
    if (!validateBarcodeCheckDigit(candidateBarcode, format)) {
      continue;
    }

    // Verify collision resistance within tenant across products, batches & serials
    const existing = await trx.db
      .selectFrom('product_barcodes')
      .select(['id'])
      .where('tenant_id', '=', trx.tenantId)
      .where('barcode', '=', candidateBarcode)
      .executeTakeFirst();

    if (!existing) {
      const [existingProduct, existingBatch, existingSerial] = await Promise.all([
        trx.db
          .selectFrom('products')
          .select(['id'])
          .where('tenant_id', '=', trx.tenantId)
          .where((eb) =>
            eb.or([
              eb('primary_barcode', '=', candidateBarcode),
              eb('sku', '=', candidateBarcode),
            ]),
          )
          .executeTakeFirst(),
        trx.db
          .selectFrom('inventory_batches')
          .select(['id'])
          .where('tenant_id', '=', trx.tenantId)
          .where('internal_barcode', '=', candidateBarcode)
          .executeTakeFirst(),
        trx.db
          .selectFrom('inventory_serials')
          .select(['id'])
          .where('tenant_id', '=', trx.tenantId)
          .where('serial_number', '=', candidateBarcode)
          .executeTakeFirst(),
      ]);

      if (!existingProduct && !existingBatch && !existingSerial) {
        break;
      }
    }
  }

  if (attempts >= maxAttempts) {
    throw new AppError({
      statusCode: 422,
      errorCode: 'CAT_BARCODE_COLLISION_EXHAUSTED',
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
 * Lists all registered barcodes for a product, enriched with stock intake / batch / package UoM context.
 */
export async function listProductBarcodes(
  trx: TenantTransactionContext,
  productId: string,
): Promise<ProductBarcodeResponse[]> {
  await assertAuthorized(trx, { permission: 'cat:product:read' });

  const [tenantRow, productRow, convRows, rows] = await Promise.all([
    trx.db
      .selectFrom('tenants')
      .select(['base_currency'])
      .where('id', '=', trx.tenantId)
      .executeTakeFirst(),
    trx.db
      .selectFrom('products')
      .select(['id', 'base_uom', 'price_uom', 'selling_price', 'density_g_per_ml'])
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', productId)
      .executeTakeFirst(),
    trx.db
      .selectFrom('product_unit_conversions')
      .select(['uom_code', 'conversion_factor_to_base', 'selling_price'])
      .where('tenant_id', '=', trx.tenantId)
      .where('product_id', '=', productId)
      .where('is_active', '=', true)
      .execute(),
    trx.db
      .selectFrom('product_barcodes')
      .leftJoin('stock_intake_lots', (join) =>
        join
          .onRef('product_barcodes.tenant_id', '=', 'stock_intake_lots.tenant_id')
          .onRef(
            'product_barcodes.stock_intake_lot_id',
            '=',
            'stock_intake_lots.id',
          ),
      )
      .leftJoin('inventory_batches', (join) =>
        join
          .onRef('product_barcodes.tenant_id', '=', 'inventory_batches.tenant_id')
          .onRef('product_barcodes.batch_id', '=', 'inventory_batches.id'),
      )
      .selectAll('product_barcodes')
      .select([
        'stock_intake_lots.intake_code as intake_code',
        'stock_intake_lots.selling_price as intake_selling_price',
        'stock_intake_lots.selling_uom as intake_selling_uom',
        'stock_intake_lots.pricing_mode as intake_pricing_mode',
        'inventory_batches.batch_number as batch_number',
        'inventory_batches.selling_price as batch_selling_price',
      ])
      .where('product_barcodes.tenant_id', '=', trx.tenantId)
      .where('product_barcodes.product_id', '=', productId)
      .orderBy('product_barcodes.is_primary', 'desc')
      .orderBy('product_barcodes.created_at', 'asc')
      .execute(),
  ]);

  const baseCurrency = tenantRow?.base_currency?.trim() ?? 'LKR';
  const baseUom = String(productRow?.base_uom || 'PCS').toUpperCase();
  const priceUom = String(productRow?.price_uom || baseUom).toUpperCase();
  const customConvs = convRows.map((c) => ({
    uomCode: c.uom_code.toUpperCase(),
    conversionFactorToBase: String(c.conversion_factor_to_base),
    sellingPrice: c.selling_price != null ? String(c.selling_price) : null,
  }));

  return rows.map((r) => {
    const uomCode = String(r.uom_code || baseUom).toUpperCase();
    let factorStr = r.conversion_factor_to_base
      ? Quantity.fromDecimalString(String(r.conversion_factor_to_base)).toDecimalString()
      : null;
    if (!factorStr) {
      try {
        factorStr = convertQuantityBetweenUoms({
          quantity: '1',
          fromUom: uomCode,
          toUom: baseUom,
          productBaseUom: baseUom,
          customConversions: customConvs,
          densityGPerMl: productRow?.density_g_per_ml
            ? String(productRow.density_g_per_ml)
            : null,
        }).factorDecimal6;
      } catch {
        factorStr = '1.000000';
      }
    }

    const priceOverrideStr =
      r.selling_price_override != null
        ? Money.fromDecimalString(String(r.selling_price_override), baseCurrency).toDecimalString()
        : null;

    let effectiveSellingPrice: string | null = priceOverrideStr;
    if (!effectiveSellingPrice && r.stock_intake_lot_id && r.intake_selling_price != null) {
      effectiveSellingPrice = Money.fromDecimalString(
        String(r.intake_selling_price),
        baseCurrency,
      ).toDecimalString();
    }
    if (!effectiveSellingPrice && r.batch_id && r.batch_selling_price != null) {
      effectiveSellingPrice = Money.fromDecimalString(
        String(r.batch_selling_price),
        baseCurrency,
      ).toDecimalString();
    }
    if (!effectiveSellingPrice) {
      const pkgRow = customConvs.find(
        (c) => c.uomCode === uomCode && c.sellingPrice != null,
      );
      if (pkgRow && pkgRow.sellingPrice) {
        effectiveSellingPrice = Money.fromDecimalString(
          pkgRow.sellingPrice,
          baseCurrency,
        ).toDecimalString();
      } else if (productRow?.selling_price != null) {
        const basePriceMoney = Money.fromDecimalString(
          String(productRow.selling_price),
          baseCurrency,
        );
        if (uomCode === priceUom) {
          effectiveSellingPrice = basePriceMoney.toDecimalString();
        } else {
          try {
            const convToPrice = convertQuantityBetweenUoms({
              quantity: '1',
              fromUom: uomCode,
              toUom: priceUom,
              productBaseUom: baseUom,
              customConversions: customConvs,
              densityGPerMl: productRow?.density_g_per_ml
                ? String(productRow.density_g_per_ml)
                : null,
            });
            effectiveSellingPrice = Money.fromScaledUnits(
              divideAndRoundBigInt(
                basePriceMoney.scaledUnits * convToPrice.numerator,
                convToPrice.denominator,
                'HALF_EVEN',
              ),
              baseCurrency,
            ).toDecimalString();
          } catch {
            effectiveSellingPrice = basePriceMoney.toDecimalString();
          }
        }
      }
    }

    return {
      id: r.id,
      barcode: r.barcode,
      barcodeType: r.barcode_type as BarcodeType,
      symbology: r.barcode_type as BarcodeType,
      uomCode,
      isPrimary: r.is_primary,
      isActive: r.is_active ?? true,
      stockIntakeLotId: r.stock_intake_lot_id ?? null,
      intakeCode: r.intake_code ?? null,
      batchId: r.batch_id ?? null,
      batchNumber: r.batch_number ?? null,
      branchId: r.branch_id ?? null,
      warehouseId: r.warehouse_id ?? null,
      conversionFactorToBase: factorStr,
      priceSourceMode: (r.price_source_mode ?? 'INHERIT') as BarcodePriceSourceMode,
      sellingPriceOverride: priceOverrideStr,
      effectiveSellingPrice,
      labelNote: r.label_note ?? null,
      deactivatedAt: r.deactivated_at ? new Date(r.deactivated_at).toISOString() : null,
      createdAt: new Date(r.created_at).toISOString(),
      updatedAt: new Date(r.updated_at).toISOString(),
    };
  });
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

  const [tenantRow, product, convRows] = await Promise.all([
    trx.db
      .selectFrom('tenants')
      .select(['base_currency'])
      .where('id', '=', trx.tenantId)
      .executeTakeFirst(),
    trx.db
      .selectFrom('products')
      .select([
        'id',
        'origin_branch_id',
        'sku',
        'base_uom',
        'price_uom',
        'selling_price',
        'primary_barcode',
        'density_g_per_ml',
      ])
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', productId)
      .executeTakeFirst(),
    trx.db
      .selectFrom('product_unit_conversions')
      .select(['uom_code', 'conversion_factor_to_base', 'selling_price'])
      .where('tenant_id', '=', trx.tenantId)
      .where('product_id', '=', productId)
      .where('is_active', '=', true)
      .execute(),
  ]);

  if (!product) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'ERR_NOT_FOUND',
      title: 'Product Not Found',
      detail: `Product "${productId}" was not found in this organization.`,
    });
  }

  const baseCurrency = tenantRow?.base_currency?.trim() ?? 'LKR';
  const baseUom = product.base_uom.trim().toUpperCase();

  let linkedIntakeLot:
    | {
        id: string;
        intake_code: string;
        branch_id: string;
        warehouse_id: string;
        selling_price: string | null;
        selling_uom: string;
      }
    | undefined;
  if (input.stockIntakeLotId) {
    linkedIntakeLot = await trx.db
      .selectFrom('stock_intake_lots')
      .select([
        'id',
        'intake_code',
        'branch_id',
        'warehouse_id',
        'selling_price',
        'selling_uom',
      ])
      .where('tenant_id', '=', trx.tenantId)
      .where('product_id', '=', productId)
      .where('id', '=', input.stockIntakeLotId)
      .executeTakeFirst();
    if (!linkedIntakeLot) {
      throw new AppError({
        statusCode: 404,
        errorCode: 'POS_INTAKE_LOT_NOT_FOUND',
        title: 'Stock Intake Reference Not Found',
        detail: `Stock intake reference "${input.stockIntakeLotId}" was not found for product "${product.sku}".`,
      });
    }
  }

  let linkedBatch:
    | {
        id: string;
        batch_number: string;
        branch_id: string | null;
        warehouse_id: string;
        selling_price: string | null;
      }
    | undefined;
  if (input.batchId) {
    linkedBatch = await trx.db
      .selectFrom('inventory_batches')
      .select(['id', 'batch_number', 'branch_id', 'warehouse_id', 'selling_price'])
      .where('tenant_id', '=', trx.tenantId)
      .where('product_id', '=', productId)
      .where('id', '=', input.batchId)
      .executeTakeFirst();
    if (!linkedBatch) {
      throw new AppError({
        statusCode: 404,
        errorCode: 'INV_BATCH_NOT_FOUND',
        title: 'Batch Not Found',
        detail: `Batch "${input.batchId}" was not found for product "${product.sku}".`,
      });
    }
  }

  const effectiveBranchId =
    input.branchId ?? linkedIntakeLot?.branch_id ?? linkedBatch?.branch_id ?? product.origin_branch_id ?? null;

  let conflictQuery = trx.db
    .selectFrom('product_barcodes')
    .select(['product_id', 'barcode'])
    .where('tenant_id', '=', trx.tenantId)
    .where('barcode', '=', cleanBarcode);
  conflictQuery = effectiveBranchId
    ? conflictQuery.where('branch_id', '=', effectiveBranchId)
    : conflictQuery.where('branch_id', 'is', null);
  const conflict = await conflictQuery.executeTakeFirst();

  if (conflict) {
    throw new AppError({
      statusCode: 409,
      errorCode: 'CAT_DUPLICATE_BARCODE',
      title: 'Duplicate Barcode',
      detail: `Barcode "${cleanBarcode}" is already assigned to a product in this branch.`,
    });
  }

  // Enforce branch-scoped / tenant-scoped uniqueness (primary barcodes, SKUs, batch barcodes, serials)
  await assertBarcodeGloballyUniqueAcrossEntities(trx, cleanBarcode, {
    productIdToAllowSameProductBarcode: false,
    branchId: effectiveBranchId,
  });

  const uomCode = (
    input.uomCode ??
    linkedIntakeLot?.selling_uom ??
    baseUom
  )
    .trim()
    .toUpperCase();

  let conversionFactorToBaseStr: string;
  if (input.conversionFactorToBase) {
    conversionFactorToBaseStr = Quantity.fromDecimalString(
      input.conversionFactorToBase,
    ).toDecimalString();
  } else {
    try {
      conversionFactorToBaseStr = convertQuantityBetweenUoms({
        quantity: '1',
        fromUom: uomCode,
        toUom: baseUom,
        productBaseUom: baseUom,
        customConversions: convRows.map((c) => ({
          uomCode: c.uom_code.toUpperCase(),
          conversionFactorToBase: String(c.conversion_factor_to_base),
        })),
        densityGPerMl: product.density_g_per_ml
          ? String(product.density_g_per_ml)
          : null,
      }).factorDecimal6;
    } catch (err) {
      if (err instanceof UomConversionError) {
        throw new AppError({
          statusCode: 400,
          errorCode: 'CAT_INVALID_UOM_CONVERSION',
          title: 'Incompatible Barcode UoM',
          detail: err.message,
        });
      }
      throw err;
    }
  }

  const isStockSpecific = Boolean(input.stockIntakeLotId || input.batchId);
  const isPrimary = Boolean(input.isPrimary);
  const isActive = input.isActive !== false;
  const now = new Date();
  const id = generateUuidV7();

  if (isPrimary) {
    await trx.db
      .updateTable('product_barcodes')
      .set({ is_primary: false, updated_at: now })
      .where('tenant_id', '=', trx.tenantId)
      .where('product_id', '=', productId)
      .execute();

    await trx.db
      .updateTable('products')
      .set({ primary_barcode: cleanBarcode, updated_at: now })
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', productId)
      .execute();
  } else if (!product.primary_barcode && input.isPrimary !== false && !isStockSpecific) {
    await trx.db
      .updateTable('products')
      .set({ primary_barcode: cleanBarcode, updated_at: now })
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', productId)
      .execute();
  }

  const willBePrimary =
    isPrimary ||
    (!product.primary_barcode && input.isPrimary !== false && !isStockSpecific);

  const sellingPriceOverride =
    input.sellingPriceOverride != null
      ? Money.fromDecimalString(input.sellingPriceOverride, baseCurrency).toDecimalString()
      : null;

  const priceSourceMode: BarcodePriceSourceMode =
    input.priceSourceMode ??
    (sellingPriceOverride
      ? 'PACKAGE_EXPLICIT'
      : input.stockIntakeLotId
        ? 'INTAKE_SPECIFIC'
        : input.batchId
          ? 'BATCH_SPECIFIC'
          : 'INHERIT');

  const branchId = effectiveBranchId;
  const warehouseId =
    input.warehouseId ??
    linkedIntakeLot?.warehouse_id ??
    linkedBatch?.warehouse_id ??
    null;

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
      stock_intake_lot_id: input.stockIntakeLotId ?? null,
      batch_id: input.batchId ?? null,
      branch_id: branchId,
      warehouse_id: warehouseId,
      conversion_factor_to_base: conversionFactorToBaseStr,
      price_source_mode: priceSourceMode,
      selling_price_override: sellingPriceOverride,
      label_note: input.labelNote?.trim() ?? null,
      deactivated_at: isActive ? null : now,
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
      uomCode,
      stockIntakeLotId: input.stockIntakeLotId ?? null,
      batchId: input.batchId ?? null,
      priceSourceMode,
      sellingPriceOverride,
      isPrimary: willBePrimary,
      isActive,
    },
  });

  const allBarcodes = await listProductBarcodes(trx, productId);
  return (
    allBarcodes.find((b) => b.id === id) ?? {
      id,
      barcode: cleanBarcode,
      barcodeType: format,
      symbology: format,
      uomCode,
      isPrimary: willBePrimary,
      isActive,
      stockIntakeLotId: input.stockIntakeLotId ?? null,
      intakeCode: linkedIntakeLot?.intake_code ?? null,
      batchId: input.batchId ?? null,
      batchNumber: linkedBatch?.batch_number ?? null,
      branchId,
      warehouseId,
      conversionFactorToBase: conversionFactorToBaseStr,
      priceSourceMode,
      sellingPriceOverride,
      effectiveSellingPrice: sellingPriceOverride,
      labelNote: input.labelNote?.trim() ?? null,
      deactivatedAt: isActive ? null : now.toISOString(),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    }
  );
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
  const nextIsActive = input.isActive !== undefined ? input.isActive : (existing.is_active ?? true);
  let effectiveIsPrimary = input.isPrimary !== undefined ? input.isPrimary : existing.is_primary;
  const nextType = input.barcodeType ?? input.symbology ?? existing.barcode_type;
  const nextUom = input.uomCode ? input.uomCode.trim().toUpperCase() : existing.uom_code;

  // If deactivating a primary barcode, it cannot remain primary
  if (!nextIsActive && existing.is_primary) {
    effectiveIsPrimary = false;
  }

  if (effectiveIsPrimary && !nextIsActive) {
    throw new AppError({
      statusCode: 400,
      errorCode: 'CAT_INACTIVE_BARCODE_CANNOT_BE_PRIMARY',
      title: 'Inactive Barcode Cannot Be Primary',
      detail: 'An inactive barcode cannot be designated as primary.',
    });
  }

  if ((!nextIsActive && existing.is_primary) || (input.isPrimary === false && existing.is_primary)) {
    // Find other active barcodes for this product
    const otherActiveBarcodes = await trx.db
      .selectFrom('product_barcodes')
      .selectAll()
      .where('tenant_id', '=', trx.tenantId)
      .where('product_id', '=', productId)
      .where('id', '!=', barcodeId)
      .where('is_active', '=', true)
      .orderBy('created_at', 'asc')
      .execute();

    if (otherActiveBarcodes.length === 0) {
      throw new AppError({
        statusCode: 409,
        errorCode: 'CAT_CANNOT_DEACTIVATE_ONLY_ACTIVE_BARCODE',
        title: 'Cannot Deactivate Only Active Barcode',
        detail: `Barcode "${existing.barcode}" is the only active barcode for this product. Products with registered barcodes must retain at least one active primary barcode.`,
      });
    }

    // Determine replacement barcode (first created active barcode or explicitly requested)
    let replacement = otherActiveBarcodes[0]!;
    if (input.promotedBarcodeId) {
      const specified = otherActiveBarcodes.find((b) => b.id === input.promotedBarcodeId);
      if (specified) replacement = specified;
    }

    // Set other barcodes is_primary = false, and set replacement is_primary = true
    await trx.db
      .updateTable('product_barcodes')
      .set({ is_primary: false, updated_at: now })
      .where('tenant_id', '=', trx.tenantId)
      .where('product_id', '=', productId)
      .execute();

    await trx.db
      .updateTable('product_barcodes')
      .set({ is_primary: true, updated_at: now })
      .where('tenant_id', '=', trx.tenantId)
      .where('id', '=', replacement.id)
      .execute();

    await trx.db
      .updateTable('products')
      .set({ primary_barcode: replacement.barcode, updated_at: now })
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
  }

  const tenantRow = await trx.db
    .selectFrom('tenants')
    .select(['base_currency'])
    .where('id', '=', trx.tenantId)
    .executeTakeFirst();
  const baseCurrency = tenantRow?.base_currency?.trim() ?? 'LKR';

  const nextIntakeLotId =
    input.stockIntakeLotId !== undefined
      ? input.stockIntakeLotId
      : (existing.stock_intake_lot_id ?? null);
  const nextBatchId =
    input.batchId !== undefined ? input.batchId : (existing.batch_id ?? null);
  const nextBranchId =
    input.branchId !== undefined ? input.branchId : (existing.branch_id ?? null);
  const nextWarehouseId =
    input.warehouseId !== undefined
      ? input.warehouseId
      : (existing.warehouse_id ?? null);
  const nextConvFactor =
    input.conversionFactorToBase !== undefined
      ? input.conversionFactorToBase !== null
        ? Quantity.fromDecimalString(input.conversionFactorToBase).toDecimalString()
        : null
      : (existing.conversion_factor_to_base ?? null);
  const nextPriceOverride =
    input.sellingPriceOverride !== undefined
      ? input.sellingPriceOverride !== null
        ? Money.fromDecimalString(input.sellingPriceOverride, baseCurrency).toDecimalString()
        : null
      : (existing.selling_price_override ?? null);
  const nextPriceMode =
    input.priceSourceMode ??
    (existing.price_source_mode as BarcodePriceSourceMode | undefined) ??
    'INHERIT';
  const nextLabelNote =
    input.labelNote !== undefined ? input.labelNote : (existing.label_note ?? null);
  const nextDeactivatedAt = !nextIsActive
    ? existing.deactivated_at ?? now
    : null;

  await trx.db
    .updateTable('product_barcodes')
    .set({
      barcode_type: nextType,
      uom_code: nextUom,
      is_primary: effectiveIsPrimary,
      is_active: nextIsActive,
      stock_intake_lot_id: nextIntakeLotId,
      batch_id: nextBatchId,
      branch_id: nextBranchId,
      warehouse_id: nextWarehouseId,
      conversion_factor_to_base: nextConvFactor,
      price_source_mode: nextPriceMode,
      selling_price_override: nextPriceOverride,
      label_note: nextLabelNote,
      deactivated_at: nextDeactivatedAt,
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
      uomCode: nextUom,
      stockIntakeLotId: nextIntakeLotId,
      batchId: nextBatchId,
      priceSourceMode: nextPriceMode,
      sellingPriceOverride: nextPriceOverride,
      isPrimary: effectiveIsPrimary,
      isActive: nextIsActive,
    },
  });

  const allBarcodes = await listProductBarcodes(trx, productId);
  return (
    allBarcodes.find((b) => b.id === barcodeId) ?? {
      id: barcodeId,
      barcode: existing.barcode,
      barcodeType: nextType as BarcodeType,
      symbology: nextType as BarcodeType,
      uomCode: nextUom,
      isPrimary: effectiveIsPrimary,
      isActive: nextIsActive,
      stockIntakeLotId: nextIntakeLotId,
      batchId: nextBatchId,
      branchId: nextBranchId,
      warehouseId: nextWarehouseId,
      conversionFactorToBase: nextConvFactor,
      priceSourceMode: nextPriceMode,
      sellingPriceOverride: nextPriceOverride,
      labelNote: nextLabelNote,
      deactivatedAt: nextDeactivatedAt ? new Date(nextDeactivatedAt).toISOString() : null,
    }
  );
}

/**
 * Removes a barcode mapping if never used in sales transactions; rejects hard delete if referenced historically.
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

  // Prevent hard-deletion of barcodes referenced in historical sales transactions (Section 7.3)
  const usedInSale = await trx.db
    .selectFrom('sales_invoice_lines')
    .select(['id'])
    .where('tenant_id', '=', trx.tenantId)
    .where('product_id', '=', productId)
    .where((eb) =>
      eb.or([
        eb('scanned_barcode', '=', existing.barcode),
        ...(existing.stock_intake_lot_id
          ? [eb('stock_intake_lot_id', '=', existing.stock_intake_lot_id)]
          : []),
      ]),
    )
    .executeTakeFirst();

  if (usedInSale) {
    throw new AppError({
      statusCode: 409,
      errorCode: 'CAT_BARCODE_IN_USE_DEACTIVATE_ONLY',
      title: 'Barcode Referenced in Historical Sales',
      detail: `Barcode "${existing.barcode}" is referenced by completed sales transactions and cannot be permanently deleted. Deactivate it instead to preserve historical traceability.`,
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
  const defaultSettings: TenantBarcodeSettings = {
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

  try {
    const tableExists = await sql<{ reg: string | null }>`
      SELECT to_regclass('public.tenant_barcode_settings')::text as reg
    `.execute(trx);

    if (!tableExists.rows[0]?.reg) {
      return defaultSettings;
    }

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

    return defaultSettings;
  } catch {
    return defaultSettings;
  }
}

/**
 * Updates organization-level barcode & POS scanning configuration.
 */
export async function updateTenantBarcodeSettings(
  trx: TenantTransactionContext,
  input: UpdateTenantBarcodeSettingsRequest,
): Promise<TenantBarcodeSettings> {
  await assertAuthorized(trx, { permission: 'cat:product:manage' });

  const tableExists = await sql<{ reg: string | null }>`
    SELECT to_regclass('public.tenant_barcode_settings')::text as reg
  `.execute(trx);

  if (!tableExists.rows[0]?.reg) {
    throw new AppError({
      statusCode: 400,
      errorCode: 'CAT_SETTINGS_NOT_AVAILABLE',
      title: 'Tenant Settings Table Unavailable',
      detail: 'The tenant barcode settings table is not yet migrated in database. Please run migration 0011.',
    });
  }

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

/**
 * Ensures a barcode candidate (product barcode, internal batch barcode, or serial)
 * does not collide with any existing barcode/SKU/serial across products, batches, and serials
 * within the same tenant.
 */
export async function assertBarcodeGloballyUniqueAcrossEntities(
  trx: TenantTransactionContext,
  candidate: string,
  options?: {
    excludeProductId?: string;
    excludeBatchId?: string;
    excludeSerialId?: string;
    productIdToAllowSameProductBarcode?: boolean;
    branchId?: string | null;
  },
): Promise<void> {
  const clean = candidate.trim();
  if (!clean) {
    return;
  }

  const branchId = options?.branchId ?? null;

  let productBarcodeQuery = trx.db
    .selectFrom('product_barcodes')
    .select(['id', 'product_id'])
    .where('tenant_id', '=', trx.tenantId)
    .where('barcode', '=', clean);

  if (branchId) {
    productBarcodeQuery = productBarcodeQuery.where((eb) =>
      eb.or([eb('branch_id', '=', branchId), eb('branch_id', 'is', null)]),
    );
  }

  if (options?.excludeProductId && options.productIdToAllowSameProductBarcode) {
    productBarcodeQuery = productBarcodeQuery.where('product_id', '!=', options.excludeProductId);
  }

  let productPrimaryQuery = trx.db
    .selectFrom('products')
    .select(['id', 'sku'])
    .where('tenant_id', '=', trx.tenantId)
    .where((eb) =>
      eb.or([eb('primary_barcode', '=', clean), eb('sku', '=', clean)]),
    );

  if (branchId) {
    productPrimaryQuery = productPrimaryQuery.where((eb) =>
      eb.or([eb('origin_branch_id', '=', branchId), eb('origin_branch_id', 'is', null)]),
    );
  }

  if (options?.excludeProductId) {
    productPrimaryQuery = productPrimaryQuery.where('id', '!=', options.excludeProductId);
  }

  let batchQuery = trx.db
    .selectFrom('inventory_batches')
    .select(['id', 'batch_number'])
    .where('tenant_id', '=', trx.tenantId)
    .where('internal_barcode', '=', clean);

  if (branchId) {
    batchQuery = batchQuery.where((eb) =>
      eb.or([eb('branch_id', '=', branchId), eb('branch_id', 'is', null)]),
    );
  }

  if (options?.excludeBatchId) {
    batchQuery = batchQuery.where('id', '!=', options.excludeBatchId);
  }

  let serialQuery = trx.db
    .selectFrom('inventory_serials')
    .select(['id', 'serial_number'])
    .where('tenant_id', '=', trx.tenantId)
    .where('serial_number', '=', clean);

  if (branchId) {
    serialQuery = serialQuery.where((eb) =>
      eb.or([eb('branch_id', '=', branchId), eb('branch_id', 'is', null)]),
    );
  }

  if (options?.excludeSerialId) {
    serialQuery = serialQuery.where('id', '!=', options.excludeSerialId);
  }

  const [pb, prod, batch, serial] = await Promise.all([
    productBarcodeQuery.executeTakeFirst(),
    productPrimaryQuery.executeTakeFirst(),
    batchQuery.executeTakeFirst(),
    serialQuery.executeTakeFirst(),
  ]);

  if (pb || prod) {
    throw new AppError({
      statusCode: 409,
      errorCode: 'CAT_BARCODE_COLLISION',
      title: 'Barcode Collision Across Products',
      detail: `Barcode "${clean}" is already assigned to a product barcode or SKU in this tenant.`,
    });
  }

  if (batch) {
    throw new AppError({
      statusCode: 409,
      errorCode: 'CAT_BARCODE_COLLISION',
      title: 'Barcode Collision With Batch',
      detail: `Barcode "${clean}" is already used as internal barcode for batch "${batch.batch_number}".`,
    });
  }

  if (serial) {
    throw new AppError({
      statusCode: 409,
      errorCode: 'CAT_BARCODE_COLLISION',
      title: 'Barcode Collision With Serial',
      detail: `Barcode "${clean}" is already assigned to serial "${serial.serial_number}".`,
    });
  }
}

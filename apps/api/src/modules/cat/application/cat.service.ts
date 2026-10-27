import type {
  BarcodeType,
  CategoryResponse,
  CreateCategoryRequest,
  CreateProductRequest,
  ListCategoriesQuery,
  ListProductsQuery,
  ProductBarcodeResponse,
  ProductResponse,
  ProductType,
  ProductUnitConversionResponse,
  RecordLifecycleStatus,
  UpdateCategoryRequest,
  UpdateProductRequest,
} from '@nexstock/contracts';
import { Money, Quantity } from '@nexstock/domain-core';
import {
  AppError,
  type TenantTransactionContext,
  appendAuditLog,
  enqueueOutboxEvent,
  generateUuidV7,
} from '../../shared/index.js';
import { assertSubscriptionEntitlement } from '../../sub/index.js';
import { assertAuthorized } from '../../iam/index.js';

export interface CursorPaginatedResult<T> {
  data: T[];
  readonly pageInfo: {
    readonly hasNextPage: boolean;
    readonly nextCursor: string | null;
  };
}

function mapCategoryRow(row: {
  id: string;
  tenant_id: string;
  parent_id: string | null;
  name: string;
  description: string | null;
  status: 'ACTIVE' | 'ARCHIVED';
  sync_version: string | number;
  created_at: Date | string;
  updated_at: Date | string;
  archived_at: Date | string | null;
}): CategoryResponse {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    parentId: row.parent_id,
    name: row.name,
    description: row.description,
    status: row.status,
    syncVersion: Number(row.sync_version),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    archivedAt: row.archived_at ? new Date(row.archived_at).toISOString() : null,
  };
}

async function assertValidCategoryParent(
  trx: TenantTransactionContext,
  parentId: string,
  currentCategoryId?: string,
): Promise<void> {
  if (currentCategoryId && parentId === currentCategoryId) {
    throw new AppError({
      statusCode: 409,
      errorCode: 'CAT_CIRCULAR_CATEGORY_HIERARCHY',
      title: 'Circular Category Hierarchy',
      detail: 'A category cannot be assigned as its own parent.',
    });
  }

  const parentRow = await trx.db
    .selectFrom('categories')
    .select(['id', 'parent_id', 'status'])
    .where('id', '=', parentId)
    .executeTakeFirst();

  if (!parentRow) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'ERR_NOT_FOUND',
      title: 'Parent Category Not Found',
      detail: `Parent category "${parentId}" was not found in tenant "${trx.tenantId}".`,
    });
  }

  if (parentRow.status !== 'ACTIVE') {
    throw new AppError({
      statusCode: 400,
      errorCode: 'ERR_VALIDATION_FAILED',
      title: 'Archived Parent Category',
      detail: `Cannot assign archived category "${parentId}" as a parent category.`,
    });
  }

  // Walk ancestor chain to prevent multi-hop circular hierarchies
  if (currentCategoryId) {
    const visited = new Set<string>([currentCategoryId]);
    let cursorId: string | null = parentRow.id;

    while (cursorId) {
      if (visited.has(cursorId)) {
        throw new AppError({
          statusCode: 409,
          errorCode: 'CAT_CIRCULAR_CATEGORY_HIERARCHY',
          title: 'Circular Category Hierarchy',
          detail: `Assigning parent "${parentId}" to category "${currentCategoryId}" creates a cycle in the category hierarchy.`,
        });
      }
      visited.add(cursorId);

      const anc = await trx.db
        .selectFrom('categories')
        .select(['parent_id'])
        .where('id', '=', cursorId)
        .executeTakeFirst();

      cursorId = anc?.parent_id ?? null;
    }
  }
}

async function assertNoDuplicateCategoryName(
  trx: TenantTransactionContext,
  name: string,
  parentId: string | null,
  excludeCategoryId?: string,
): Promise<void> {
  const normalizedName = name.trim().toLowerCase();
  let query = trx.db
    .selectFrom('categories')
    .select(['id', 'name'])
    .where('tenant_id', '=', trx.tenantId);

  if (parentId === null) {
    query = query.where('parent_id', 'is', null);
  } else {
    query = query.where('parent_id', '=', parentId);
  }

  if (excludeCategoryId) {
    query = query.where('id', '<>', excludeCategoryId);
  }

  const siblings = await query.execute();
  const duplicate = siblings.find(
    (s) => s.name.trim().toLowerCase() === normalizedName,
  );

  if (duplicate) {
    throw new AppError({
      statusCode: 409,
      errorCode: 'CAT_DUPLICATE_CATEGORY_NAME',
      title: 'Duplicate Category Name',
      detail: `A category named "${name.trim()}" already exists under the specified parent scope.`,
    });
  }
}

export async function createCategory(
  trx: TenantTransactionContext,
  input: CreateCategoryRequest,
): Promise<CategoryResponse> {
  await assertAuthorized(trx, {
    permission: 'cat:category:manage',
  });

  await assertSubscriptionEntitlement(trx, {
    requireWriteAccess: true,
  });

  const name = input.name.trim();
  if (!name) {
    throw new AppError({
      statusCode: 400,
      errorCode: 'ERR_VALIDATION_FAILED',
      title: 'Invalid Category Name',
      detail: 'Category name cannot be blank.',
    });
  }

  const parentId = input.parentId ?? null;
  if (parentId) {
    await assertValidCategoryParent(trx, parentId);
  }

  await assertNoDuplicateCategoryName(trx, name, parentId);

  const categoryId = generateUuidV7();
  const description = input.description?.trim() ?? null;
  const now = new Date();

  await trx.db
    .insertInto('categories')
    .values({
      id: categoryId,
      tenant_id: trx.tenantId,
      parent_id: parentId,
      name,
      description,
      status: 'ACTIVE',
      sync_version: 1,
      created_at: now,
      updated_at: now,
      archived_at: null,
    })
    .execute();

  await appendAuditLog(trx, {
    action: 'CAT_CATEGORY_CREATED',
    resourceType: 'CATEGORY',
    resourceId: categoryId,
    metadata: { name, parentId },
  });

  await enqueueOutboxEvent(trx, {
    aggregateType: 'CATEGORY',
    aggregateId: categoryId,
    eventType: 'CATEGORY_CREATED',
    payload: { categoryId, name, parentId },
  });

  return {
    id: categoryId,
    tenantId: trx.tenantId,
    parentId,
    name,
    description,
    status: 'ACTIVE',
    syncVersion: 1,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    archivedAt: null,
  };
}

export async function getCategoryById(
  trx: TenantTransactionContext,
  categoryId: string,
): Promise<CategoryResponse> {
  await assertAuthorized(trx, {
    permission: 'cat:category:read',
  });

  await assertSubscriptionEntitlement(trx, {
    requireWriteAccess: false,
  });

  const row = await trx.db
    .selectFrom('categories')
    .selectAll()
    .where('id', '=', categoryId)
    .executeTakeFirst();

  if (!row) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'ERR_NOT_FOUND',
      title: 'Category Not Found',
      detail: `Category "${categoryId}" was not found.`,
    });
  }

  return mapCategoryRow(row);
}

export async function updateCategory(
  trx: TenantTransactionContext,
  categoryId: string,
  input: UpdateCategoryRequest,
): Promise<CategoryResponse> {
  await assertAuthorized(trx, {
    permission: 'cat:category:manage',
  });

  await assertSubscriptionEntitlement(trx, {
    requireWriteAccess: true,
  });

  const existing = await trx.db
    .selectFrom('categories')
    .selectAll()
    .where('id', '=', categoryId)
    .executeTakeFirst();

  if (!existing) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'ERR_NOT_FOUND',
      title: 'Category Not Found',
      detail: `Category "${categoryId}" was not found.`,
    });
  }

  const nextName = input.name !== undefined ? input.name.trim() : existing.name;
  if (!nextName) {
    throw new AppError({
      statusCode: 400,
      errorCode: 'ERR_VALIDATION_FAILED',
      title: 'Invalid Category Name',
      detail: 'Category name cannot be blank.',
    });
  }

  const nextParentId =
    input.parentId !== undefined ? input.parentId : existing.parent_id;

  if (nextParentId) {
    await assertValidCategoryParent(trx, nextParentId, categoryId);
  }

  await assertNoDuplicateCategoryName(
    trx,
    nextName,
    nextParentId,
    categoryId,
  );

  const nextDescription =
    input.description !== undefined
      ? (input.description?.trim() ?? null)
      : existing.description;
  const nextSyncVersion = Number(existing.sync_version) + 1;
  const now = new Date();

  await trx.db
    .updateTable('categories')
    .set({
      name: nextName,
      description: nextDescription,
      parent_id: nextParentId,
      sync_version: nextSyncVersion,
      updated_at: now,
    })
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', categoryId)
    .execute();

  await appendAuditLog(trx, {
    action: 'CAT_CATEGORY_UPDATED',
    resourceType: 'CATEGORY',
    resourceId: categoryId,
    metadata: {
      previousName: existing.name,
      nextName,
      previousParentId: existing.parent_id,
      nextParentId,
    },
  });

  return {
    id: existing.id,
    tenantId: existing.tenant_id,
    parentId: nextParentId,
    name: nextName,
    description: nextDescription,
    status: existing.status,
    syncVersion: nextSyncVersion,
    createdAt: new Date(existing.created_at).toISOString(),
    updatedAt: now.toISOString(),
    archivedAt: existing.archived_at
      ? new Date(existing.archived_at).toISOString()
      : null,
  };
}

export async function archiveCategory(
  trx: TenantTransactionContext,
  categoryId: string,
): Promise<CategoryResponse> {
  await assertAuthorized(trx, {
    permission: 'cat:category:manage',
  });

  await assertSubscriptionEntitlement(trx, {
    requireWriteAccess: true,
  });

  const existing = await trx.db
    .selectFrom('categories')
    .selectAll()
    .where('id', '=', categoryId)
    .executeTakeFirst();

  if (!existing) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'ERR_NOT_FOUND',
      title: 'Category Not Found',
      detail: `Category "${categoryId}" was not found.`,
    });
  }

  const activeChild = await trx.db
    .selectFrom('categories')
    .select(['id'])
    .where('tenant_id', '=', trx.tenantId)
    .where('parent_id', '=', categoryId)
    .where('status', '=', 'ACTIVE')
    .executeTakeFirst();

  if (activeChild) {
    throw new AppError({
      statusCode: 409,
      errorCode: 'CAT_CATEGORY_HAS_ACTIVE_CHILDREN_OR_PRODUCTS',
      title: 'Category Has Active Child Categories',
      detail: `Category "${categoryId}" cannot be archived while it still has active child categories.`,
    });
  }

  const now = new Date();
  const nextSyncVersion = Number(existing.sync_version) + 1;

  await trx.db
    .updateTable('categories')
    .set({
      status: 'ARCHIVED',
      archived_at: now,
      sync_version: nextSyncVersion,
      updated_at: now,
    })
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', categoryId)
    .execute();

  await appendAuditLog(trx, {
    action: 'CAT_CATEGORY_ARCHIVED',
    resourceType: 'CATEGORY',
    resourceId: categoryId,
    metadata: { name: existing.name },
  });

  return {
    id: existing.id,
    tenantId: existing.tenant_id,
    parentId: existing.parent_id,
    name: existing.name,
    description: existing.description,
    status: 'ARCHIVED',
    syncVersion: nextSyncVersion,
    createdAt: new Date(existing.created_at).toISOString(),
    updatedAt: now.toISOString(),
    archivedAt: now.toISOString(),
  };
}

export async function listCategories(
  trx: TenantTransactionContext,
  query: ListCategoriesQuery,
): Promise<CursorPaginatedResult<CategoryResponse>> {
  await assertAuthorized(trx, {
    permission: 'cat:category:read',
  });

  await assertSubscriptionEntitlement(trx, {
    requireWriteAccess: false,
  });

  const limit = Math.min(Math.max(Number(query.limit ?? 50), 1), 100);

  let dbQuery = trx.db
    .selectFrom('categories')
    .selectAll()
    .orderBy('id', 'asc');

  if (query.status) {
    dbQuery = dbQuery.where('status', '=', query.status);
  }
  if (query.parentId) {
    dbQuery = dbQuery.where('parent_id', '=', query.parentId);
  }
  if (query.cursor) {
    dbQuery = dbQuery.where('id', '>', query.cursor);
  }

  const rows = await dbQuery.execute();
  const searchLower = query.search?.trim().toLowerCase();
  const filtered = searchLower
    ? rows.filter(
        (r) =>
          r.name.toLowerCase().includes(searchLower) ||
          (r.description?.toLowerCase().includes(searchLower) ?? false),
      )
    : rows;

  const pageRows = filtered.slice(0, limit);
  const hasNextPage = filtered.length > limit;
  const nextCursor =
    hasNextPage && pageRows.length > 0
      ? pageRows[pageRows.length - 1]!.id
      : null;

  return {
    data: pageRows.map(mapCategoryRow),
    pageInfo: {
      hasNextPage,
      nextCursor,
    },
  };
}

// ============================================================================
// Product Management (Section 4A)
// ============================================================================

async function getTenantBaseCurrency(
  trx: TenantTransactionContext,
): Promise<string> {
  const tenant = await trx.db
    .selectFrom('tenants')
    .select(['base_currency'])
    .where('id', '=', trx.tenantId)
    .executeTakeFirst();

  return tenant?.base_currency?.trim() ?? 'USD';
}

function validateAndNormalizeMoney(
  decimalStr: string,
  currencyCode: string,
  fieldName: string,
): string {
  let money: Money;
  try {
    money = Money.fromDecimalString(decimalStr, currencyCode);
  } catch {
    throw new AppError({
      statusCode: 400,
      errorCode: 'ERR_VALIDATION_FAILED',
      title: 'Invalid Monetary Value',
      detail: `Field "${fieldName}" contains an invalid monetary value "${decimalStr}".`,
    });
  }
  if (money.isNegative()) {
    throw new AppError({
      statusCode: 400,
      errorCode: 'ERR_VALIDATION_FAILED',
      title: 'Negative Price or Cost Not Permitted',
      detail: `Field "${fieldName}" cannot be negative ("${decimalStr}").`,
    });
  }
  return money.toDecimalString();
}

function validateAndNormalizeNonNegativeQuantity(
  decimalStr: string,
  fieldName: string,
): string {
  let qty: Quantity;
  try {
    qty = Quantity.fromDecimalString(decimalStr);
  } catch {
    throw new AppError({
      statusCode: 400,
      errorCode: 'ERR_VALIDATION_FAILED',
      title: 'Invalid Quantity Value',
      detail: `Field "${fieldName}" contains an invalid quantity value "${decimalStr}".`,
    });
  }
  if (qty.isNegative()) {
    throw new AppError({
      statusCode: 400,
      errorCode: 'ERR_VALIDATION_FAILED',
      title: 'Negative Threshold Quantity Not Permitted',
      detail: `Field "${fieldName}" cannot be negative ("${decimalStr}").`,
    });
  }
  return qty.toDecimalString();
}

async function hydrateProductDetails(
  trx: TenantTransactionContext,
  row: {
    id: string;
    tenant_id: string;
    sku: string;
    name: string;
    description: string | null;
    product_type: ProductType;
    status: RecordLifecycleStatus;
    category_id: string | null;
    base_uom: string;
    purchase_cost: string;
    selling_price: string;
    tax_group_id: string | null;
    track_inventory: boolean;
    reorder_point: string;
    reorder_qty: string;
    image_url: string | null;
    image_alt: string | null;
    primary_barcode: string | null;
    sync_version: string | number;
    created_at: Date | string;
    updated_at: Date | string;
    archived_at: Date | string | null;
  },
): Promise<ProductResponse> {
  const barcodeRows = await trx.db
    .selectFrom('product_barcodes')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('product_id', '=', row.id)
    .orderBy('is_primary', 'desc')
    .orderBy('barcode', 'asc')
    .execute();

  const uomRows = await trx.db
    .selectFrom('product_unit_conversions')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('product_id', '=', row.id)
    .orderBy('uom_code', 'asc')
    .execute();

  const barcodes: ProductBarcodeResponse[] = barcodeRows.map((b) => ({
    id: b.id,
    barcode: b.barcode,
    barcodeType: b.barcode_type,
    uomCode: b.uom_code,
    isPrimary: b.is_primary,
  }));

  const unitConversions: ProductUnitConversionResponse[] = uomRows.map((u) => ({
    id: u.id,
    uomCode: u.uom_code,
    uomName: u.uom_name,
    conversionFactorToBase: Quantity.fromDecimalString(
      String(u.conversion_factor_to_base),
    ).toDecimalString(),
    isActive: u.is_active,
  }));

  const baseCurrency = await getTenantBaseCurrency(trx);

  return {
    id: row.id,
    tenantId: row.tenant_id,
    sku: row.sku,
    name: row.name,
    description: row.description,
    productType: row.product_type,
    status: row.status,
    categoryId: row.category_id,
    baseUom: row.base_uom,
    purchaseCost: Money.fromDecimalString(
      String(row.purchase_cost),
      baseCurrency,
    ).toDecimalString(),
    sellingPrice: Money.fromDecimalString(
      String(row.selling_price),
      baseCurrency,
    ).toDecimalString(),
    taxGroupId: row.tax_group_id,
    trackInventory: row.track_inventory,
    reorderPoint: Quantity.fromDecimalString(
      String(row.reorder_point),
    ).toDecimalString(),
    reorderQty: Quantity.fromDecimalString(
      String(row.reorder_qty),
    ).toDecimalString(),
    imageUrl: row.image_url,
    imageAlt: row.image_alt,
    primaryBarcode: row.primary_barcode,
    barcodes,
    unitConversions,
    syncVersion: Number(row.sync_version),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    archivedAt: row.archived_at ? new Date(row.archived_at).toISOString() : null,
  };
}

export async function createProduct(
  trx: TenantTransactionContext,
  input: CreateProductRequest,
): Promise<ProductResponse> {
  await assertAuthorized(trx, {
    permission: 'cat:product:manage',
  });

  await assertSubscriptionEntitlement(trx, {
    requireWriteAccess: true,
  });

  const sku = input.sku.trim().toUpperCase();
  const name = input.name.trim();
  const baseUom = input.baseUom.trim().toUpperCase();

  if (!sku || !name || !baseUom) {
    throw new AppError({
      statusCode: 400,
      errorCode: 'ERR_VALIDATION_FAILED',
      title: 'Invalid Product Identifiers',
      detail: 'Product SKU, name, and baseUom cannot be blank.',
    });
  }

  const productType: ProductType = input.productType ?? 'STANDARD';
  const trackInventory =
    input.trackInventory ?? (productType === 'SERVICE' ? false : true);

  if (productType === 'SERVICE' && trackInventory) {
    throw new AppError({
      statusCode: 400,
      errorCode: 'ERR_VALIDATION_FAILED',
      title: 'Invalid Service Stock Configuration',
      detail: 'Products with productType="SERVICE" cannot have trackInventory=true.',
    });
  }

  const baseCurrency = await getTenantBaseCurrency(trx);
  const purchaseCost = validateAndNormalizeMoney(
    input.purchaseCost,
    baseCurrency,
    'purchaseCost',
  );
  const sellingPrice = validateAndNormalizeMoney(
    input.sellingPrice,
    baseCurrency,
    'sellingPrice',
  );
  const reorderPoint = input.reorderPoint
    ? validateAndNormalizeNonNegativeQuantity(
        input.reorderPoint,
        'reorderPoint',
      )
    : Quantity.zero().toDecimalString();
  const reorderQty = input.reorderQty
    ? validateAndNormalizeNonNegativeQuantity(input.reorderQty, 'reorderQty')
    : Quantity.zero().toDecimalString();

  // Check SKU uniqueness in current tenant
  const existingSku = await trx.db
    .selectFrom('products')
    .select(['id'])
    .where('tenant_id', '=', trx.tenantId)
    .where('sku', '=', sku)
    .executeTakeFirst();

  if (existingSku) {
    throw new AppError({
      statusCode: 409,
      errorCode: 'CAT_DUPLICATE_SKU',
      title: 'Duplicate Product SKU',
      detail: `A product with SKU "${sku}" already exists in this organization.`,
    });
  }

  // Validate category reference in current tenant
  const categoryId = input.categoryId ?? null;
  if (categoryId) {
    const categoryRow = await trx.db
      .selectFrom('categories')
      .select(['id', 'status'])
      .where('id', '=', categoryId)
      .executeTakeFirst();

    if (!categoryRow) {
      throw new AppError({
        statusCode: 404,
        errorCode: 'ERR_NOT_FOUND',
        title: 'Category Not Found',
        detail: `Category "${categoryId}" was not found in tenant "${trx.tenantId}".`,
      });
    }
    if (categoryRow.status !== 'ACTIVE') {
      throw new AppError({
        statusCode: 400,
        errorCode: 'ERR_VALIDATION_FAILED',
        title: 'Archived Category Reference',
        detail: `Cannot assign product to archived category "${categoryId}".`,
      });
    }
  }

  // Validate taxGroupId reference in current tenant
  const taxGroupId = input.taxGroupId ?? null;
  if (taxGroupId) {
    const taxGroupRow = await trx.db
      .selectFrom('tax_groups')
      .select(['id', 'is_active'])
      .where('id', '=', taxGroupId)
      .executeTakeFirst();

    if (!taxGroupRow || !taxGroupRow.is_active) {
      throw new AppError({
        statusCode: 404,
        errorCode: 'ERR_NOT_FOUND',
        title: 'Tax Group Not Found',
        detail: `Active tax group "${taxGroupId}" was not found in tenant "${trx.tenantId}".`,
      });
    }
  }

  // Validate UoM conversions
  const seenUoms = new Set<string>([baseUom]);
  const normalizedConversions: Array<{
    uomCode: string;
    uomName: string;
    conversionFactorToBase: string;
  }> = [];

  for (const conv of input.unitConversions ?? []) {
    const code = conv.uomCode.trim().toUpperCase();
    const uomName = conv.uomName.trim();
    if (!code || !uomName || seenUoms.has(code)) {
      throw new AppError({
        statusCode: 400,
        errorCode: 'CAT_INVALID_UOM_CONVERSION',
        title: 'Invalid or Duplicate UoM Conversion',
        detail: `Additional UoM "${code}" is invalid or duplicates baseUom / another conversion.`,
      });
    }

    let factor: Quantity;
    try {
      factor = Quantity.fromDecimalString(conv.conversionFactorToBase);
    } catch {
      throw new AppError({
        statusCode: 400,
        errorCode: 'CAT_INVALID_UOM_CONVERSION',
        title: 'Invalid UoM Conversion Factor',
        detail: `Conversion factor "${conv.conversionFactorToBase}" for UoM "${code}" is not a valid fixed-point quantity.`,
      });
    }

    if (!factor.isPositive()) {
      throw new AppError({
        statusCode: 400,
        errorCode: 'CAT_INVALID_UOM_CONVERSION',
        title: 'Non-Positive UoM Conversion Factor',
        detail: `Conversion factor for UoM "${code}" must be strictly greater than zero.`,
      });
    }

    seenUoms.add(code);
    normalizedConversions.push({
      uomCode: code,
      uomName,
      conversionFactorToBase: factor.toDecimalString(),
    });
  }

  // Validate Primary & Alternate Barcodes
  const primaryBarcode = input.primaryBarcode?.trim() || null;
  const barcodeEntries: Array<{
    barcode: string;
    barcodeType: BarcodeType;
    uomCode: string;
    isPrimary: boolean;
  }> = [];
  const seenBarcodes = new Set<string>();

  if (primaryBarcode) {
    seenBarcodes.add(primaryBarcode);
    barcodeEntries.push({
      barcode: primaryBarcode,
      barcodeType: 'CODE128',
      uomCode: baseUom,
      isPrimary: true,
    });
  }

  for (const alt of input.alternateBarcodes ?? []) {
    const code = alt.barcode.trim();
    if (!code) {
      throw new AppError({
        statusCode: 400,
        errorCode: 'ERR_VALIDATION_FAILED',
        title: 'Blank Barcode',
        detail: 'Barcode string cannot be empty.',
      });
    }
    if (seenBarcodes.has(code)) {
      throw new AppError({
        statusCode: 409,
        errorCode: 'CAT_DUPLICATE_BARCODE',
        title: 'Duplicate Barcode in Request',
        detail: `Barcode "${code}" is specified more than once.`,
      });
    }
    const targetUom = (alt.uomCode ?? baseUom).trim().toUpperCase();
    if (!seenUoms.has(targetUom)) {
      throw new AppError({
        statusCode: 400,
        errorCode: 'CAT_INVALID_UOM_CONVERSION',
        title: 'Unknown Barcode UoM',
        detail: `Barcode "${code}" references UoM "${targetUom}" which is neither the baseUom ("${baseUom}") nor a configured unit conversion.`,
      });
    }
    seenBarcodes.add(code);
    barcodeEntries.push({
      barcode: code,
      barcodeType: alt.barcodeType ?? 'CODE128',
      uomCode: targetUom,
      isPrimary: false,
    });
  }

  if (barcodeEntries.length > 0) {
    const existingBarcode = await trx.db
      .selectFrom('product_barcodes')
      .select(['barcode'])
      .where('tenant_id', '=', trx.tenantId)
      .where(
        'barcode',
        'in',
        barcodeEntries.map((b) => b.barcode),
      )
      .executeTakeFirst();

    if (existingBarcode) {
      throw new AppError({
        statusCode: 409,
        errorCode: 'CAT_DUPLICATE_BARCODE',
        title: 'Duplicate Barcode',
        detail: `Barcode "${existingBarcode.barcode}" is already assigned to a product in this organization.`,
      });
    }
  }

  const productId = generateUuidV7();
  const now = new Date();

  await trx.db
    .insertInto('products')
    .values({
      id: productId,
      tenant_id: trx.tenantId,
      sku,
      name,
      description: input.description?.trim() ?? null,
      product_type: productType,
      status: 'ACTIVE',
      category_id: categoryId,
      base_uom: baseUom,
      purchase_cost: purchaseCost,
      selling_price: sellingPrice,
      tax_group_id: taxGroupId,
      track_inventory: trackInventory,
      reorder_point: reorderPoint,
      reorder_qty: reorderQty,
      image_url: input.imageUrl?.trim() ?? null,
      image_alt: input.imageAlt?.trim() ?? null,
      primary_barcode: primaryBarcode,
      sync_version: 1,
      created_at: now,
      updated_at: now,
      archived_at: null,
    })
    .execute();

  for (const conv of normalizedConversions) {
    await trx.db
      .insertInto('product_unit_conversions')
      .values({
        id: generateUuidV7(),
        tenant_id: trx.tenantId,
        product_id: productId,
        uom_code: conv.uomCode,
        uom_name: conv.uomName,
        conversion_factor_to_base: conv.conversionFactorToBase,
        is_active: true,
        created_at: now,
        updated_at: now,
      })
      .execute();
  }

  for (const bc of barcodeEntries) {
    await trx.db
      .insertInto('product_barcodes')
      .values({
        id: generateUuidV7(),
        tenant_id: trx.tenantId,
        product_id: productId,
        barcode: bc.barcode,
        barcode_type: bc.barcodeType,
        uom_code: bc.uomCode,
        is_primary: bc.isPrimary,
        created_at: now,
      })
      .execute();
  }

  await appendAuditLog(trx, {
    action: 'CAT_PRODUCT_CREATED',
    resourceType: 'PRODUCT',
    resourceId: productId,
    metadata: {
      sku,
      name,
      productType,
      baseUom,
      purchaseCost,
      sellingPrice,
      trackInventory,
    },
  });

  await enqueueOutboxEvent(trx, {
    aggregateType: 'PRODUCT',
    aggregateId: productId,
    eventType: 'PRODUCT_CREATED',
    payload: { productId, sku, name },
  });

  const inserted = await trx.db
    .selectFrom('products')
    .selectAll()
    .where('id', '=', productId)
    .executeTakeFirstOrThrow();

  return hydrateProductDetails(trx, inserted);
}

export async function getProductById(
  trx: TenantTransactionContext,
  productId: string,
): Promise<ProductResponse> {
  await assertAuthorized(trx, {
    permission: 'cat:product:read',
  });

  await assertSubscriptionEntitlement(trx, {
    requireWriteAccess: false,
  });

  const row = await trx.db
    .selectFrom('products')
    .selectAll()
    .where('id', '=', productId)
    .executeTakeFirst();

  if (!row) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'ERR_NOT_FOUND',
      title: 'Product Not Found',
      detail: `Product "${productId}" was not found.`,
    });
  }

  return hydrateProductDetails(trx, row);
}

export async function updateProduct(
  trx: TenantTransactionContext,
  productId: string,
  input: UpdateProductRequest,
): Promise<ProductResponse> {
  await assertAuthorized(trx, {
    permission: 'cat:product:manage',
  });

  await assertSubscriptionEntitlement(trx, {
    requireWriteAccess: true,
  });

  const existing = await trx.db
    .selectFrom('products')
    .selectAll()
    .where('id', '=', productId)
    .executeTakeFirst();

  if (!existing) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'ERR_NOT_FOUND',
      title: 'Product Not Found',
      detail: `Product "${productId}" was not found.`,
    });
  }

  const baseCurrency = await getTenantBaseCurrency(trx);
  const nextSku =
    input.sku !== undefined ? input.sku.trim().toUpperCase() : existing.sku;
  const nextName =
    input.name !== undefined ? input.name.trim() : existing.name;

  if (!nextSku || !nextName) {
    throw new AppError({
      statusCode: 400,
      errorCode: 'ERR_VALIDATION_FAILED',
      title: 'Invalid Product Name or SKU',
      detail: 'Product SKU and name cannot be blank.',
    });
  }

  if (nextSku !== existing.sku) {
    const dupSku = await trx.db
      .selectFrom('products')
      .select(['id'])
      .where('tenant_id', '=', trx.tenantId)
      .where('sku', '=', nextSku)
      .where('id', '<>', productId)
      .executeTakeFirst();

    if (dupSku) {
      throw new AppError({
        statusCode: 409,
        errorCode: 'CAT_DUPLICATE_SKU',
        title: 'Duplicate Product SKU',
        detail: `A product with SKU "${nextSku}" already exists in this organization.`,
      });
    }
  }

  const nextCategoryId =
    input.categoryId !== undefined ? input.categoryId : existing.category_id;
  if (nextCategoryId) {
    const categoryRow = await trx.db
      .selectFrom('categories')
      .select(['id', 'status'])
      .where('id', '=', nextCategoryId)
      .executeTakeFirst();

    if (!categoryRow) {
      throw new AppError({
        statusCode: 404,
        errorCode: 'ERR_NOT_FOUND',
        title: 'Category Not Found',
        detail: `Category "${nextCategoryId}" was not found in tenant "${trx.tenantId}".`,
      });
    }
    if (categoryRow.status !== 'ACTIVE') {
      throw new AppError({
        statusCode: 400,
        errorCode: 'ERR_VALIDATION_FAILED',
        title: 'Archived Category Reference',
        detail: `Cannot assign product to archived category "${nextCategoryId}".`,
      });
    }
  }

  const nextTaxGroupId =
    input.taxGroupId !== undefined ? input.taxGroupId : existing.tax_group_id;
  if (nextTaxGroupId) {
    const taxGroupRow = await trx.db
      .selectFrom('tax_groups')
      .select(['id', 'is_active'])
      .where('id', '=', nextTaxGroupId)
      .executeTakeFirst();

    if (!taxGroupRow || !taxGroupRow.is_active) {
      throw new AppError({
        statusCode: 404,
        errorCode: 'ERR_NOT_FOUND',
        title: 'Tax Group Not Found',
        detail: `Active tax group "${nextTaxGroupId}" was not found in tenant "${trx.tenantId}".`,
      });
    }
  }

  const nextPurchaseCost =
    input.purchaseCost !== undefined
      ? validateAndNormalizeMoney(
          input.purchaseCost,
          baseCurrency,
          'purchaseCost',
        )
      : String(existing.purchase_cost);
  const nextSellingPrice =
    input.sellingPrice !== undefined
      ? validateAndNormalizeMoney(
          input.sellingPrice,
          baseCurrency,
          'sellingPrice',
        )
      : String(existing.selling_price);
  const nextReorderPoint =
    input.reorderPoint !== undefined
      ? validateAndNormalizeNonNegativeQuantity(
          input.reorderPoint,
          'reorderPoint',
        )
      : String(existing.reorder_point);
  const nextReorderQty =
    input.reorderQty !== undefined
      ? validateAndNormalizeNonNegativeQuantity(input.reorderQty, 'reorderQty')
      : String(existing.reorder_qty);

  const now = new Date();

  if (input.unitConversions !== undefined) {
    const seenUoms = new Set<string>([existing.base_uom]);
    const normalizedConversions: Array<{
      uomCode: string;
      uomName: string;
      conversionFactorToBase: string;
    }> = [];

    for (const conv of input.unitConversions) {
      const code = conv.uomCode.trim().toUpperCase();
      const uomName = conv.uomName.trim();
      if (!code || !uomName || seenUoms.has(code)) {
        throw new AppError({
          statusCode: 400,
          errorCode: 'CAT_INVALID_UOM_CONVERSION',
          title: 'Invalid or Duplicate UoM Conversion',
          detail: `Additional UoM "${code}" is invalid or duplicates baseUom / another conversion.`,
        });
      }
      const factor = Quantity.fromDecimalString(conv.conversionFactorToBase);
      if (!factor.isPositive()) {
        throw new AppError({
          statusCode: 400,
          errorCode: 'CAT_INVALID_UOM_CONVERSION',
          title: 'Non-Positive UoM Conversion Factor',
          detail: `Conversion factor for UoM "${code}" must be strictly greater than zero.`,
        });
      }
      seenUoms.add(code);
      normalizedConversions.push({
        uomCode: code,
        uomName,
        conversionFactorToBase: factor.toDecimalString(),
      });
    }

    await trx.db
      .deleteFrom('product_unit_conversions')
      .where('tenant_id', '=', trx.tenantId)
      .where('product_id', '=', productId)
      .execute();

    for (const conv of normalizedConversions) {
      await trx.db
        .insertInto('product_unit_conversions')
        .values({
          id: generateUuidV7(),
          tenant_id: trx.tenantId,
          product_id: productId,
          uom_code: conv.uomCode,
          uom_name: conv.uomName,
          conversion_factor_to_base: conv.conversionFactorToBase,
          is_active: true,
          created_at: now,
          updated_at: now,
        })
        .execute();
    }
  }

  let nextPrimaryBarcode = existing.primary_barcode;
  if (
    input.primaryBarcode !== undefined ||
    input.alternateBarcodes !== undefined
  ) {
    nextPrimaryBarcode =
      input.primaryBarcode !== undefined
        ? (input.primaryBarcode?.trim() || null)
        : existing.primary_barcode;

    const currentConversions = await trx.db
      .selectFrom('product_unit_conversions')
      .select(['uom_code'])
      .where('tenant_id', '=', trx.tenantId)
      .where('product_id', '=', productId)
      .execute();

    const validUoms = new Set<string>([
      existing.base_uom,
      ...currentConversions.map((c) => c.uom_code),
    ]);

    const barcodeEntries: Array<{
      barcode: string;
      barcodeType: BarcodeType;
      uomCode: string;
      isPrimary: boolean;
    }> = [];
    const seenBarcodes = new Set<string>();

    if (nextPrimaryBarcode) {
      seenBarcodes.add(nextPrimaryBarcode);
      barcodeEntries.push({
        barcode: nextPrimaryBarcode,
        barcodeType: 'CODE128',
        uomCode: existing.base_uom,
        isPrimary: true,
      });
    }

    const altList = input.alternateBarcodes ?? [];
    for (const alt of altList) {
      const code = alt.barcode.trim();
      if (!code || seenBarcodes.has(code)) {
        throw new AppError({
          statusCode: 409,
          errorCode: 'CAT_DUPLICATE_BARCODE',
          title: 'Duplicate or Invalid Barcode',
          detail: `Barcode "${code}" is invalid or duplicated.`,
        });
      }
      const targetUom = (alt.uomCode ?? existing.base_uom)
        .trim()
        .toUpperCase();
      if (!validUoms.has(targetUom)) {
        throw new AppError({
          statusCode: 400,
          errorCode: 'CAT_INVALID_UOM_CONVERSION',
          title: 'Unknown Barcode UoM',
          detail: `Barcode "${code}" references UoM "${targetUom}" which is not configured on this product.`,
        });
      }
      seenBarcodes.add(code);
      barcodeEntries.push({
        barcode: code,
        barcodeType: alt.barcodeType ?? 'CODE128',
        uomCode: targetUom,
        isPrimary: false,
      });
    }

    if (barcodeEntries.length > 0) {
      const conflictBarcode = await trx.db
        .selectFrom('product_barcodes')
        .select(['barcode'])
        .where('tenant_id', '=', trx.tenantId)
        .where('product_id', '<>', productId)
        .where(
          'barcode',
          'in',
          barcodeEntries.map((b) => b.barcode),
        )
        .executeTakeFirst();

      if (conflictBarcode) {
        throw new AppError({
          statusCode: 409,
          errorCode: 'CAT_DUPLICATE_BARCODE',
          title: 'Duplicate Barcode',
          detail: `Barcode "${conflictBarcode.barcode}" is already assigned to another product in this organization.`,
        });
      }
    }

    await trx.db
      .deleteFrom('product_barcodes')
      .where('tenant_id', '=', trx.tenantId)
      .where('product_id', '=', productId)
      .execute();

    for (const bc of barcodeEntries) {
      await trx.db
        .insertInto('product_barcodes')
        .values({
          id: generateUuidV7(),
          tenant_id: trx.tenantId,
          product_id: productId,
          barcode: bc.barcode,
          barcode_type: bc.barcodeType,
          uom_code: bc.uomCode,
          is_primary: bc.isPrimary,
          created_at: now,
        })
        .execute();
    }
  }

  const nextSyncVersion = Number(existing.sync_version) + 1;

  await trx.db
    .updateTable('products')
    .set({
      sku: nextSku,
      name: nextName,
      description:
        input.description !== undefined
          ? (input.description?.trim() ?? null)
          : existing.description,
      category_id: nextCategoryId,
      purchase_cost: nextPurchaseCost,
      selling_price: nextSellingPrice,
      tax_group_id: nextTaxGroupId,
      reorder_point: nextReorderPoint,
      reorder_qty: nextReorderQty,
      image_url:
        input.imageUrl !== undefined
          ? (input.imageUrl?.trim() ?? null)
          : existing.image_url,
      image_alt:
        input.imageAlt !== undefined
          ? (input.imageAlt?.trim() ?? null)
          : existing.image_alt,
      primary_barcode: nextPrimaryBarcode,
      sync_version: nextSyncVersion,
      updated_at: now,
    })
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', productId)
    .execute();

  await appendAuditLog(trx, {
    action: 'CAT_PRODUCT_UPDATED',
    resourceType: 'PRODUCT',
    resourceId: productId,
    metadata: {
      previousSku: existing.sku,
      nextSku,
      previousSellingPrice: existing.selling_price,
      nextSellingPrice,
    },
  });

  const updated = await trx.db
    .selectFrom('products')
    .selectAll()
    .where('id', '=', productId)
    .executeTakeFirstOrThrow();

  return hydrateProductDetails(trx, updated);
}

export async function archiveProduct(
  trx: TenantTransactionContext,
  productId: string,
): Promise<ProductResponse> {
  await assertAuthorized(trx, {
    permission: 'cat:product:manage',
  });

  await assertSubscriptionEntitlement(trx, {
    requireWriteAccess: true,
  });

  const existing = await trx.db
    .selectFrom('products')
    .selectAll()
    .where('id', '=', productId)
    .executeTakeFirst();

  if (!existing) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'ERR_NOT_FOUND',
      title: 'Product Not Found',
      detail: `Product "${productId}" was not found.`,
    });
  }

  const now = new Date();
  const nextSyncVersion = Number(existing.sync_version) + 1;

  await trx.db
    .updateTable('products')
    .set({
      status: 'ARCHIVED',
      archived_at: now,
      sync_version: nextSyncVersion,
      updated_at: now,
    })
    .where('tenant_id', '=', trx.tenantId)
    .where('id', '=', productId)
    .execute();

  await appendAuditLog(trx, {
    action: 'CAT_PRODUCT_ARCHIVED',
    resourceType: 'PRODUCT',
    resourceId: productId,
    metadata: { sku: existing.sku, name: existing.name },
  });

  const updated = await trx.db
    .selectFrom('products')
    .selectAll()
    .where('id', '=', productId)
    .executeTakeFirstOrThrow();

  return hydrateProductDetails(trx, updated);
}

export async function listProducts(
  trx: TenantTransactionContext,
  query: ListProductsQuery,
): Promise<CursorPaginatedResult<ProductResponse>> {
  await assertAuthorized(trx, {
    permission: 'cat:product:read',
  });

  await assertSubscriptionEntitlement(trx, {
    requireWriteAccess: false,
  });

  const limit = Math.min(Math.max(Number(query.limit ?? 50), 1), 100);

  let dbQuery = trx.db.selectFrom('products').selectAll();

  if (query.categoryId) {
    dbQuery = dbQuery.where('category_id', '=', query.categoryId);
  }
  if (query.status) {
    dbQuery = dbQuery.where('status', '=', query.status);
  }
  if (query.productType) {
    dbQuery = dbQuery.where('product_type', '=', query.productType);
  }
  if (query.trackInventory !== undefined) {
    dbQuery = dbQuery.where(
      'track_inventory',
      '=',
      query.trackInventory === 'true',
    );
  }
  if (query.cursor) {
    dbQuery = dbQuery.where('id', '>', query.cursor);
  }

  const sortDir = query.sortDir ?? 'asc';
  const sortBy = query.sortBy ?? 'createdAt';
  if (sortBy === 'name') {
    dbQuery = dbQuery.orderBy('name', sortDir).orderBy('id', 'asc');
  } else if (sortBy === 'sku') {
    dbQuery = dbQuery.orderBy('sku', sortDir).orderBy('id', 'asc');
  } else if (sortBy === 'sellingPrice') {
    dbQuery = dbQuery.orderBy('selling_price', sortDir).orderBy('id', 'asc');
  } else {
    dbQuery = dbQuery.orderBy('id', sortDir);
  }

  const rows = await dbQuery.execute();

  let matchedProductIdsByBarcode: Set<string> | null = null;
  const searchLower = query.search?.trim().toLowerCase();
  if (searchLower) {
    const bcRows = await trx.db
      .selectFrom('product_barcodes')
      .select(['product_id', 'barcode'])
      .where('tenant_id', '=', trx.tenantId)
      .execute();

    matchedProductIdsByBarcode = new Set(
      bcRows
        .filter((b) => b.barcode.toLowerCase().includes(searchLower))
        .map((b) => b.product_id),
    );
  }

  const filtered = searchLower
    ? rows.filter(
        (r) =>
          r.name.toLowerCase().includes(searchLower) ||
          r.sku.toLowerCase().includes(searchLower) ||
          (r.description?.toLowerCase().includes(searchLower) ?? false) ||
          (matchedProductIdsByBarcode?.has(r.id) ?? false),
      )
    : rows;

  const pageRows = filtered.slice(0, limit);
  const hasNextPage = filtered.length > limit;
  const nextCursor =
    hasNextPage && pageRows.length > 0
      ? pageRows[pageRows.length - 1]!.id
      : null;

  const hydrated: ProductResponse[] = [];
  for (const r of pageRows) {
    hydrated.push(await hydrateProductDetails(trx, r));
  }

  return {
    data: hydrated,
    pageInfo: {
      hasNextPage,
      nextCursor,
    },
  };
}

/**
 * Public facade method for INV / PUR modules to resolve product metadata and UoM conversions
 * within the active tenant transaction without crossing module repository boundaries.
 */
export async function resolveProductForInventory(
  trx: TenantTransactionContext,
  productId: string,
): Promise<{
  readonly id: string;
  readonly sku: string;
  readonly name: string;
  readonly status: RecordLifecycleStatus;
  readonly productType: ProductType;
  readonly trackInventory: boolean;
  readonly baseUom: string;
  readonly purchaseCost: string;
  readonly reorderPoint: string;
  readonly reorderQty: string;
  readonly unitConversions: ReadonlyMap<string, string>;
}> {
  const row = await trx.db
    .selectFrom('products')
    .select([
      'id',
      'sku',
      'name',
      'status',
      'product_type',
      'track_inventory',
      'base_uom',
      'purchase_cost',
      'reorder_point',
      'reorder_qty',
    ])
    .where('id', '=', productId)
    .executeTakeFirst();

  if (!row) {
    throw new AppError({
      statusCode: 404,
      errorCode: 'ERR_NOT_FOUND',
      title: 'Product Not Found',
      detail: `Product "${productId}" was not found in tenant "${trx.tenantId}".`,
    });
  }

  const uomRows = await trx.db
    .selectFrom('product_unit_conversions')
    .select(['uom_code', 'conversion_factor_to_base'])
    .where('tenant_id', '=', trx.tenantId)
    .where('product_id', '=', productId)
    .where('is_active', '=', true)
    .execute();

  const unitConversions = new Map<string, string>();
  unitConversions.set(row.base_uom, Quantity.fromInteger(1).toDecimalString());
  for (const u of uomRows) {
    unitConversions.set(
      u.uom_code,
      Quantity.fromDecimalString(
        String(u.conversion_factor_to_base),
      ).toDecimalString(),
    );
  }

  return {
    id: row.id,
    sku: row.sku,
    name: row.name,
    status: row.status,
    productType: row.product_type,
    trackInventory: row.track_inventory,
    baseUom: row.base_uom,
    purchaseCost: String(row.purchase_cost),
    reorderPoint: String(row.reorder_point),
    reorderQty: String(row.reorder_qty),
    unitConversions,
  };
}

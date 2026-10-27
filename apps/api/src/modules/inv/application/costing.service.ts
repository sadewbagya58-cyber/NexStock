import type {
  CurrencyCode,
  FifoCostLayerResponse,
  InventoryValuationResponse,
  InventoryValuationSummary,
  ValuationMethod,
} from '@nexstock/contracts';
import { Money, Quantity } from '@nexstock/domain-core';
import { assertAuthorized } from '../../iam/index.js';
import {
  type TenantTransactionContext,
} from '../../shared/index.js';

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

export async function listFifoCostLayers(
  trx: TenantTransactionContext,
  query: {
    readonly warehouseId: string;
    readonly productId: string;
  },
): Promise<FifoCostLayerResponse[]> {
  await assertAuthorized(trx, {
    permission: 'inv:costing:read',
    warehouseId: query.warehouseId,
  });

  const baseCurrency = await getTenantBaseCurrency(trx);

  const rows = await trx.db
    .selectFrom('inventory_cost_layers')
    .selectAll()
    .where('tenant_id', '=', trx.tenantId)
    .where('warehouse_id', '=', query.warehouseId)
    .where('product_id', '=', query.productId)
    .orderBy('layer_date', 'asc')
    .orderBy('created_at', 'asc')
    .execute();

  return rows.map((r) => ({
    id: r.id,
    tenantId: r.tenant_id,
    warehouseId: r.warehouse_id,
    productId: r.product_id,
    batchId: r.batch_id,
    ledgerEntryId: r.ledger_entry_id,
    layerDate: new Date(r.layer_date).toISOString(),
    receivedQty: Quantity.fromDecimalString(String(r.received_qty)).toDecimalString(),
    remainingQty: Quantity.fromDecimalString(String(r.remaining_qty)).toDecimalString(),
    unitCost: Money.fromDecimalString(
      String(r.unit_cost),
      r.currency_code || baseCurrency,
    ).toDecimalString(),
    currencyCode: (r.currency_code || baseCurrency) as CurrencyCode,
    status: r.status,
    createdAt: new Date(r.created_at).toISOString(),
  }));
}

export async function getInventoryValuation(
  trx: TenantTransactionContext,
  warehouseId: string,
): Promise<InventoryValuationResponse> {
  await assertAuthorized(trx, {
    permission: 'inv:costing:read',
    warehouseId,
  });

  const baseCurrency = await getTenantBaseCurrency(trx);

  // Query all inventory balances joined with products for this warehouse
  const balanceRows = await trx.db
    .selectFrom('inventory_balances')
    .innerJoin('products', 'products.id', 'inventory_balances.product_id')
    .select([
      'inventory_balances.warehouse_id',
      'inventory_balances.product_id',
      'inventory_balances.qty_on_hand',
      'inventory_balances.moving_avg_cost',
      'inventory_balances.total_inventory_value',
      'products.sku',
      'products.name',
      'products.valuation_method',
    ])
    .where('inventory_balances.tenant_id', '=', trx.tenantId)
    .where('inventory_balances.warehouse_id', '=', warehouseId)
    .orderBy('products.name', 'asc')
    .execute();

  if (balanceRows.length === 0) {
    return {
      warehouseId,
      totalAssetValue: Money.zero(baseCurrency).toDecimalString(),
      currencyCode: baseCurrency as CurrencyCode,
      items: [],
    };
  }

  // Count open layers per product
  const openLayers = await trx.db
    .selectFrom('inventory_cost_layers')
    .select(['product_id'])
    .where('tenant_id', '=', trx.tenantId)
    .where('warehouse_id', '=', warehouseId)
    .where('status', '=', 'OPEN')
    .execute();

  const openLayersCountMap = new Map<string, number>();
  for (const l of openLayers) {
    openLayersCountMap.set(
      l.product_id,
      (openLayersCountMap.get(l.product_id) ?? 0) + 1,
    );
  }

  // Count active batches per product
  const activeBatches = await trx.db
    .selectFrom('inventory_batches')
    .select(['product_id'])
    .where('tenant_id', '=', trx.tenantId)
    .where('warehouse_id', '=', warehouseId)
    .where('status', '=', 'ACTIVE')
    .execute();

  const activeBatchesCountMap = new Map<string, number>();
  for (const b of activeBatches) {
    activeBatchesCountMap.set(
      b.product_id,
      (activeBatchesCountMap.get(b.product_id) ?? 0) + 1,
    );
  }

  let totalAsset = Money.zero(baseCurrency);
  const items: InventoryValuationSummary[] = [];

  for (const b of balanceRows) {
    const val = Money.fromDecimalString(
      String(b.total_inventory_value ?? '0.0000'),
      baseCurrency,
    );
    totalAsset = totalAsset.add(val);

    items.push({
      productId: b.product_id,
      warehouseId: b.warehouse_id,
      sku: b.sku,
      productName: b.name,
      valuationMethod: (b.valuation_method ?? 'MOVING_AVG') as ValuationMethod,
      qtyOnHand: Quantity.fromDecimalString(String(b.qty_on_hand)).toDecimalString(),
      movingAvgCost: Money.fromDecimalString(
        String(b.moving_avg_cost ?? '0.0000'),
        baseCurrency,
      ).toDecimalString(),
      totalInventoryValue: val.toDecimalString(),
      openLayersCount: openLayersCountMap.get(b.product_id) ?? 0,
      activeBatchesCount: activeBatchesCountMap.get(b.product_id) ?? 0,
    });
  }

  return {
    warehouseId,
    totalAssetValue: totalAsset.toDecimalString(),
    currencyCode: baseCurrency as CurrencyCode,
    items,
  };
}

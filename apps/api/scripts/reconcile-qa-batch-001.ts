import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import {
  type NexStockDatabase,
  generateUuidV7,
  resolveDatabaseSslConfig,
  validateEnvironmentConfig,
} from '../src/modules/shared/index.js';
import { withTenantTransaction } from '../src/modules/shared/infrastructure/tenant-transaction.js';
import { postStockMovement } from '../src/modules/inv/application/inv.service.js';

interface ReconciliationResult {
  readonly dryRun: boolean;
  readonly batchNumber: string;
  readonly sku: string;
  readonly previousBatchCurrentQty: string;
  readonly reconciledBatchCurrentQty: string;
  readonly ledgerEntryCreated: boolean;
  readonly ledgerEntryId?: string;
  readonly balanceOnHandBefore: string;
  readonly balanceOnHandAfter: string;
}

export async function reconcileBatchStockIntake(options: {
  readonly connectionString: string;
  readonly dryRun: boolean;
  readonly batchNumber?: string;
  readonly sku?: string;
}): Promise<ReconciliationResult> {
  const targetBatchNumber = (options.batchNumber ?? 'QA-BATCH-2026-001').trim().toUpperCase();
  const targetSku = (options.sku ?? 'QA-BATCH-001').trim().toUpperCase();

  const sslConfig = resolveDatabaseSslConfig({
    connectionString: options.connectionString,
    nodeEnv: 'production',
  });

  const pool = new pg.Pool({
    connectionString: sslConfig.sanitizedConnectionString,
    ssl: sslConfig.ssl,
    max: 2,
    idleTimeoutMillis: 5000,
    connectionTimeoutMillis: 10000,
  });

  const db = new Kysely<NexStockDatabase>({
    dialect: new PostgresDialect({ pool }),
  });

  try {
    // 1. Locate Product
    const product = await db
      .selectFrom('products')
      .selectAll()
      .where('sku', '=', targetSku)
      .executeTakeFirst();

    if (!product) {
      throw new Error(`Target product with SKU "${targetSku}" was not found.`);
    }

    // 2. Locate Batch
    const batch = await db
      .selectFrom('inventory_batches')
      .selectAll()
      .where('tenant_id', '=', product.tenant_id)
      .where('product_id', '=', product.id)
      .where('batch_number', '=', targetBatchNumber)
      .executeTakeFirst();

    if (!batch) {
      throw new Error(`Target batch "${targetBatchNumber}" for product "${targetSku}" was not found.`);
    }

    // 3. Check for existing stock ledger entries
    const existingLedgerEntries = await db
      .selectFrom('stock_ledger_entries')
      .selectAll()
      .where('tenant_id', '=', product.tenant_id)
      .where('batch_id', '=', batch.id)
      .execute();

    if (existingLedgerEntries.length > 0) {
      console.log(`[Reconcile] Notice: Batch "${targetBatchNumber}" already has ${existingLedgerEntries.length} stock ledger entries.`);
      return {
        dryRun: options.dryRun,
        batchNumber: targetBatchNumber,
        sku: targetSku,
        previousBatchCurrentQty: String(batch.current_quantity),
        reconciledBatchCurrentQty: String(batch.current_quantity),
        ledgerEntryCreated: false,
        balanceOnHandBefore: 'N/A (already reconciled)',
        balanceOnHandAfter: 'N/A (already reconciled)',
      };
    }

    // 4. Check existing inventory balance
    const existingBalance = await db
      .selectFrom('inventory_balances')
      .selectAll()
      .where('tenant_id', '=', product.tenant_id)
      .where('warehouse_id', '=', batch.warehouse_id)
      .where('product_id', '=', product.id)
      .executeTakeFirst();

    const balanceBefore = existingBalance ? String(existingBalance.qty_on_hand) : '0.000000';
    const initialQty = String(batch.initial_quantity);

    // Resolve branchId
    const warehouse = await db
      .selectFrom('warehouses')
      .select(['branch_id'])
      .where('id', '=', batch.warehouse_id)
      .executeTakeFirst();

    const branchId = warehouse?.branch_id;
    if (!branchId) {
      throw new Error(`Warehouse "${batch.warehouse_id}" has no associated branch_id.`);
    }

    // Find tenant owner / user
    const tenantUser = await db
      .selectFrom('tenant_memberships')
      .select(['user_id'])
      .where('tenant_id', '=', product.tenant_id)
      .orderBy('created_at', 'asc')
      .executeTakeFirst();

    const actorUserId = tenantUser?.user_id ?? product.tenant_id;

    if (options.dryRun) {
      console.log('=== [DRY RUN RECONCILIATION PLAN] ===');
      console.log(`Tenant ID:            ${product.tenant_id}`);
      console.log(`Product:              ${targetSku} (${product.id})`);
      console.log(`Batch Number:         ${targetBatchNumber} (${batch.id})`);
      console.log(`Initial Quantity:     ${batch.initial_quantity}`);
      console.log(`Current Quantity:     ${batch.current_quantity}`);
      console.log(`Unit Cost:            ${batch.unit_cost} ${batch.currency_code}`);
      console.log(`Warehouse ID:         ${batch.warehouse_id}`);
      console.log(`Branch ID:            ${branchId}`);
      console.log(`Current Balance:      ${balanceBefore}`);
      console.log(`Missing Ledger Move:  STOCK_IN +${initialQty}`);
      console.log(`Target Balance After: ${Number(balanceBefore) + Number(initialQty)}`);
      console.log('Target Batch After:   100.0000 (resets current to 0 first, then postStockMovement brings it back to 100)');
      console.log('=== NO CHANGES WRITTEN (Dry Run Mode) ===');

      return {
        dryRun: true,
        batchNumber: targetBatchNumber,
        sku: targetSku,
        previousBatchCurrentQty: String(batch.current_quantity),
        reconciledBatchCurrentQty: String(batch.initial_quantity),
        ledgerEntryCreated: true,
        balanceOnHandBefore: balanceBefore,
        balanceOnHandAfter: String(Number(balanceBefore) + Number(initialQty)),
      };
    }

    // LIVE EXECUTION: Atomic Transaction
    let createdMovementId: string | undefined;
    let balanceAfterStr: string = balanceBefore;

    await withTenantTransaction(
      db,
      {
        tenantId: product.tenant_id,
        userId: actorUserId,
        traceId: 'reconcile_batch_001',
      },
      async (trx) => {
        // Step A: Reset batch current_quantity to 0 so postStockMovement restores it to initial_quantity
        await trx.db
          .updateTable('inventory_batches')
          .set({ current_quantity: '0.000000', updated_at: new Date() })
          .where('tenant_id', '=', trx.tenantId)
          .where('id', '=', batch.id)
          .execute();

        // Step B: Authoritative postStockMovement
        const movementKey = generateUuidV7();
        const movement = await postStockMovement(
          trx,
          movementKey,
          {
            branchId,
            warehouseId: batch.warehouse_id,
            productId: product.id,
            batchId: batch.id,
            movementType: 'STOCK_IN',
            quantity: initialQty,
            uomCode: product.base_uom,
            unitCost: String(batch.unit_cost),
            referenceType: 'BATCH_REGISTRATION',
            referenceId: targetBatchNumber,
            reason: `Authoritative stock intake reconciliation for ${targetBatchNumber}`,
            supplierId: batch.supplier_id ?? undefined,
          },
          { skipPermissionCheck: true },
        );

        createdMovementId = movement.id;
        balanceAfterStr = movement.balanceAfter;

        // Step C: Verify invariants
        const verifiedBatch = await trx.db
          .selectFrom('inventory_batches')
          .select(['current_quantity', 'initial_quantity'])
          .where('id', '=', batch.id)
          .executeTakeFirst();

        if (!verifiedBatch || Number(verifiedBatch.current_quantity) !== Number(batch.initial_quantity)) {
          throw new Error(
            `Inconsistent batch quantity after reconciliation: expected ${batch.initial_quantity}, got ${verifiedBatch?.current_quantity}`,
          );
        }
      },
    );

    console.log(`[Reconcile] Successfully reconciled batch "${targetBatchNumber}"!`);
    console.log(`[Reconcile] Created Ledger Entry: ${createdMovementId}`);
    console.log(`[Reconcile] Balance on Hand:     ${balanceBefore} -> ${balanceAfterStr}`);

    return {
      dryRun: false,
      batchNumber: targetBatchNumber,
      sku: targetSku,
      previousBatchCurrentQty: String(batch.current_quantity),
      reconciledBatchCurrentQty: String(batch.initial_quantity),
      ledgerEntryCreated: true,
      ledgerEntryId: createdMovementId,
      balanceOnHandBefore: balanceBefore,
      balanceOnHandAfter: balanceAfterStr,
    };
  } finally {
    await db.destroy();
    await pool.end();
  }
}

// CLI entrypoint
if (process.argv[1]?.endsWith('reconcile-qa-batch-001.ts')) {
  const isExecute = process.argv.includes('--execute');
  const env = validateEnvironmentConfig(process.env);
  const connStr = env.APP_DATABASE_URL;

  if (!connStr) {
    console.error('Error: APP_DATABASE_URL environment variable is required.');
    process.exit(1);
  }

  reconcileBatchStockIntake({
    connectionString: connStr,
    dryRun: !isExecute,
  })
    .then((result) => {
      console.log('Result:', JSON.stringify(result, null, 2));
      process.exit(0);
    })
    .catch((err) => {
      console.error('Reconciliation failed:', err);
      process.exit(1);
    });
}

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

interface SerialReconciliationResult {
  readonly dryRun: boolean;
  readonly sku: string;
  readonly serialNumbers: readonly string[];
  readonly serialCount: number;
  readonly previousBalanceOnHand: string;
  readonly reconciledBalanceOnHand: string;
  readonly ledgerEntryCreated: boolean;
  readonly ledgerEntryId?: string;
}

export async function reconcileSerialStockIntake(options: {
  readonly connectionString: string;
  readonly dryRun: boolean;
  readonly sku?: string;
  readonly serialNumbers?: readonly string[];
}): Promise<SerialReconciliationResult> {
  const targetSku = (options.sku ?? 'QA-SERIAL-001').trim().toUpperCase();
  const targetSerials = (options.serialNumbers ?? ['SN-10001', 'SN-10002', 'SN-10003']).map((s) =>
    s.trim().toUpperCase(),
  );

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

    // 2. Locate Serials
    const serialRows = await db
      .selectFrom('inventory_serials')
      .selectAll()
      .where('tenant_id', '=', product.tenant_id)
      .where('product_id', '=', product.id)
      .where('serial_number', 'in', targetSerials)
      .execute();

    if (serialRows.length !== targetSerials.length) {
      const foundNumbers = serialRows.map((s) => s.serial_number);
      const missing = targetSerials.filter((s) => !foundNumbers.includes(s));
      throw new Error(
        `Expected ${targetSerials.length} serials for product "${targetSku}", but found ${serialRows.length}. Missing: ${missing.join(', ')}`,
      );
    }

    const warehouseId = serialRows[0]!.warehouse_id;
    const branchId = serialRows[0]!.branch_id;
    const unitCost = String(serialRows[0]!.unit_cost);

    // Verify all serials are in the same warehouse, branch, have identical unit cost, and status IN_STOCK
    for (const s of serialRows) {
      if (s.warehouse_id !== warehouseId) {
        throw new Error(`Serial "${s.serial_number}" belongs to warehouse "${s.warehouse_id}", expected "${warehouseId}".`);
      }
      if (s.branch_id !== branchId) {
        throw new Error(`Serial "${s.serial_number}" belongs to branch "${s.branch_id}", expected "${branchId}".`);
      }
      if (String(s.unit_cost) !== unitCost) {
        throw new Error(`Serial "${s.serial_number}" has unit cost "${s.unit_cost}", expected "${unitCost}".`);
      }
      if (s.status !== 'IN_STOCK') {
        throw new Error(`Serial "${s.serial_number}" has status "${s.status}", expected "IN_STOCK".`);
      }
    }

    // 3. Check for existing stock ledger entries referencing these serials or reconciliation reference
    const serialIds = serialRows.map((s) => s.id);
    const existingLedgerBySerial = await db
      .selectFrom('stock_ledger_entries')
      .selectAll()
      .where('tenant_id', '=', product.tenant_id)
      .where('serial_id', 'in', serialIds)
      .execute();

    const existingReconcileLedger = await db
      .selectFrom('stock_ledger_entries')
      .selectAll()
      .where('tenant_id', '=', product.tenant_id)
      .where('reference_type', '=', 'SERIAL_REGISTRATION')
      .where('reference_id', '=', `RECONCILE-${targetSku}`)
      .execute();

    if (existingLedgerBySerial.length > 0 || existingReconcileLedger.length > 0) {
      console.log(`[Reconcile] Notice: Product "${targetSku}" already has stock ledger entries recorded.`);
      return {
        dryRun: options.dryRun,
        sku: targetSku,
        serialNumbers: targetSerials,
        serialCount: targetSerials.length,
        previousBalanceOnHand: 'N/A (already reconciled)',
        reconciledBalanceOnHand: 'N/A (already reconciled)',
        ledgerEntryCreated: false,
      };
    }

    // 4. Check existing inventory balance
    const existingBalance = await db
      .selectFrom('inventory_balances')
      .selectAll()
      .where('tenant_id', '=', product.tenant_id)
      .where('warehouse_id', '=', warehouseId)
      .where('product_id', '=', product.id)
      .executeTakeFirst();

    const balanceBefore = existingBalance ? String(existingBalance.qty_on_hand) : '0.000000';
    const targetIntakeQty = String(targetSerials.length);

    if (Number(balanceBefore) >= Number(targetIntakeQty)) {
      console.log(`[Reconcile] Notice: Product "${targetSku}" already has balance ${balanceBefore} >= target intake qty ${targetIntakeQty}.`);
      return {
        dryRun: options.dryRun,
        sku: targetSku,
        serialNumbers: targetSerials,
        serialCount: targetSerials.length,
        previousBalanceOnHand: balanceBefore,
        reconciledBalanceOnHand: balanceBefore,
        ledgerEntryCreated: false,
      };
    }

    const expectedBalanceAfter = String(Number(balanceBefore) + Number(targetIntakeQty));

    // Find tenant user
    const tenantUser = await db
      .selectFrom('tenant_memberships')
      .select(['user_id'])
      .where('tenant_id', '=', product.tenant_id)
      .orderBy('created_at', 'asc')
      .executeTakeFirst();

    const actorUserId = tenantUser?.user_id ?? product.tenant_id;

    if (options.dryRun) {
      console.log('=== [DRY RUN RECONCILIATION PLAN: SERIAL INTAKE] ===');
      console.log(`Tenant ID:            ${product.tenant_id}`);
      console.log(`Product:              ${targetSku} (${product.id})`);
      console.log(`Serials (${targetSerials.length}):    ${targetSerials.join(', ')}`);
      console.log(`Unit Cost:            ${unitCost} ${product.currency_code ?? 'LKR'}`);
      console.log(`Warehouse ID:         ${warehouseId}`);
      console.log(`Branch ID:            ${branchId}`);
      console.log(`Current Balance:      ${balanceBefore} PCS`);
      console.log(`Missing Ledger Move:  STOCK_IN +${targetIntakeQty} PCS`);
      console.log(`Target Balance After: ${expectedBalanceAfter} PCS`);
      console.log(`Serial LastMovement:  Will be linked to new stock ledger entry`);
      console.log('=== NO CHANGES WRITTEN (Dry Run Mode) ===');

      return {
        dryRun: true,
        sku: targetSku,
        serialNumbers: targetSerials,
        serialCount: targetSerials.length,
        previousBalanceOnHand: balanceBefore,
        reconciledBalanceOnHand: expectedBalanceAfter,
        ledgerEntryCreated: true,
      };
    }

    // LIVE EXECUTION: Single Atomic Transaction
    let createdMovementId: string | undefined;
    let balanceAfterStr: string = balanceBefore;

    await withTenantTransaction(
      db,
      {
        tenantId: product.tenant_id,
        userId: actorUserId,
        traceId: 'reconcile_serial_001',
      },
      async (trx) => {
        // Step A: Post the authoritative stock movement for +N PCS
        const movementKey = generateUuidV7();
        const movement = await postStockMovement(
          trx,
          movementKey,
          {
            branchId,
            warehouseId,
            productId: product.id,
            movementType: 'STOCK_IN',
            quantity: targetIntakeQty,
            uomCode: product.base_uom,
            unitCost,
            referenceType: 'SERIAL_REGISTRATION',
            referenceId: `RECONCILE-${targetSku}`,
            reason: `Authoritative stock intake reconciliation for ${targetSku} (${targetSerials.join(', ')})`,
          },
          { skipPermissionCheck: true },
        );

        createdMovementId = movement.id;
        balanceAfterStr = movement.balanceAfter;

        // Step B: Update serials to link to the new movement ID
        await trx.db
          .updateTable('inventory_serials')
          .set({
            last_movement_id: movement.id,
            updated_at: new Date(),
          })
          .where('tenant_id', '=', trx.tenantId)
          .where('id', 'in', serialIds)
          .execute();

        // Step C: Verify balance matches exactly expected quantity
        const verifiedBalance = await trx.db
          .selectFrom('inventory_balances')
          .select(['qty_on_hand'])
          .where('tenant_id', '=', trx.tenantId)
          .where('warehouse_id', '=', warehouseId)
          .where('product_id', '=', product.id)
          .executeTakeFirst();

        if (!verifiedBalance || Number(verifiedBalance.qty_on_hand) !== Number(expectedBalanceAfter)) {
          throw new Error(
            `Inconsistent balance after serial reconciliation: expected ${expectedBalanceAfter}, got ${verifiedBalance?.qty_on_hand}`,
          );
        }
      },
    );

    console.log(`[Reconcile] Successfully reconciled serial intake for "${targetSku}"!`);
    console.log(`[Reconcile] Created Ledger Entry: ${createdMovementId}`);
    console.log(`[Reconcile] Balance on Hand:     ${balanceBefore} -> ${balanceAfterStr}`);

    return {
      dryRun: false,
      sku: targetSku,
      serialNumbers: targetSerials,
      serialCount: targetSerials.length,
      previousBalanceOnHand: balanceBefore,
      reconciledBalanceOnHand: balanceAfterStr,
      ledgerEntryCreated: true,
      ledgerEntryId: createdMovementId,
    };
  } finally {
    await db.destroy();
    await pool.end();
  }
}

// CLI entrypoint
if (process.argv[1]?.endsWith('reconcile-qa-serial-001.ts')) {
  const isExecute = process.argv.includes('--execute');
  const env = validateEnvironmentConfig(process.env);
  const connStr = env.APP_DATABASE_URL;

  if (!connStr) {
    console.error('Error: APP_DATABASE_URL environment variable is required.');
    process.exit(1);
  }

  reconcileSerialStockIntake({
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

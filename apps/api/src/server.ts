import { type KeyObject, generateKeyPairSync, sign } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import {
  CompiledQuery,
  type DatabaseConnection,
  type Driver,
  Kysely,
  PostgresAdapter,
  PostgresDialect,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type QueryResult,
} from 'kysely';
import pg from 'pg';
import { buildApp } from './app.js';
import {
  type JwksKeyProvider,
  RemoteJwksProvider,
  StaticJwksProvider,
  type SupabaseJwk,
  provisionTenantMember,
  seedDefaultSystemRoles,
} from './modules/iam/index.js';
import {
  type NexStockDatabase,
  generateUuidV7,
  resolveDatabaseSslConfig,
  runPostgresMigrations,
  sanitizeLogMessage,
  validateEnvironmentConfig,
} from './modules/shared/index.js';
import { withTenantTransaction } from './modules/shared/infrastructure/tenant-transaction.js';

// PGlite Kysely Driver for safe zero-setup local development
class LocalPGliteConnection implements DatabaseConnection {
  constructor(private readonly pg: PGlite) {}

  async executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
    const res = await this.pg.query<R>(compiledQuery.sql, [
      ...compiledQuery.parameters,
    ]);
    return {
      rows: res.rows,
      ...(res.affectedRows !== undefined
        ? { numAffectedRows: BigInt(res.affectedRows) }
        : {}),
    };
  }

  streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error('Streaming is not supported in local PGlite dev mode.');
  }
}

class LocalPGliteDriver implements Driver {
  private readonly connection: LocalPGliteConnection;
  constructor(private readonly pg: PGlite) {
    this.connection = new LocalPGliteConnection(pg);
  }

  async init(): Promise<void> {}
  async acquireConnection(): Promise<DatabaseConnection> {
    return this.connection;
  }
  async beginTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw('BEGIN'));
  }
  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw('COMMIT'));
  }
  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw('ROLLBACK'));
  }
  async releaseConnection(): Promise<void> {}
  async destroy(): Promise<void> {
    await this.pg.close();
  }
}

// Canonical Demo UUIDs for local exploration (RFC 9562 compliant)
export const DEMO_TENANT_ID = '0192b4c0-1111-7000-8000-000000000001';
export const DEMO_OWNER_USER_ID = '0192b4c0-2222-7000-8000-000000000001';
export const DEMO_CASHIER_USER_ID = '0192b4c0-2222-7000-8000-000000000002';
export const DEMO_BRANCH_1_ID = '0192b4c0-3333-7000-8000-000000000001';
export const DEMO_WAREHOUSE_1_ID = '0192b4c0-4444-7000-8000-000000000001';
export const DEMO_REGISTER_1_ID = '0192b4c0-5555-7000-8000-000000000001';
export const DEMO_REGISTER_2_ID = '0192b4c0-5555-7000-8000-000000000002';

interface DevKeyMaterial {
  readonly kid: string;
  readonly privateKey: KeyObject;
  readonly publicJwk: SupabaseJwk;
}

let devKeyMaterial: DevKeyMaterial | null = null;

function getOrCreateDevKeyMaterial(): DevKeyMaterial {
  if (!devKeyMaterial) {
    const { publicKey, privateKey } = generateKeyPairSync('ec', {
      namedCurve: 'P-256',
    });
    const exported = publicKey.export({ format: 'jwk' });
    const kid = 'nexstock-local-dev-key';
    devKeyMaterial = {
      kid,
      privateKey,
      publicJwk: {
        ...exported,
        kty: 'EC',
        crv: 'P-256',
        alg: 'ES256',
        use: 'sig',
        kid,
      },
    };
  }
  return devKeyMaterial;
}

export function generateDevJwt(payload: {
  readonly sub: string;
  readonly email: string;
  readonly tenantId: string;
  readonly role: 'OWNER' | 'CASHIER';
}): string {
  const keys = getOrCreateDevKeyMaterial();
  const header = {
    alg: 'ES256',
    typ: 'JWT',
    kid: keys.kid,
  };
  const nowSec = Math.floor(Date.now() / 1000);
  const jwtPayload = {
    iss: process.env['SUPABASE_JWT_ISSUER'] ?? 'https://tokylhdgzyoxiqwvncis.supabase.co/auth/v1',
    aud: process.env['SUPABASE_JWT_AUDIENCE'] ?? 'authenticated',
    sub: payload.sub,
    email: payload.email,
    iat: nowSec,
    exp: nowSec + 86400 * 7, // 7 days
    app_metadata: {
      tenant_id: payload.tenantId,
      roles: [payload.role],
    },
    user_metadata: {
      full_name: payload.role === 'OWNER' ? 'Demo Store Owner' : 'Demo Cashier',
    },
  };

  const headerB64 = Buffer.from(JSON.stringify(header), 'utf-8').toString('base64url');
  const payloadB64 = Buffer.from(JSON.stringify(jwtPayload), 'utf-8').toString('base64url');
  const signingInput = Buffer.from(`${headerB64}.${payloadB64}`, 'utf-8');
  const signature = sign('sha256', signingInput, {
    key: keys.privateKey,
    dsaEncoding: 'ieee-p1363',
  });
  const signatureB64 = signature.toString('base64url');

  return `${headerB64}.${payloadB64}.${signatureB64}`;
}

async function seedDemoData(db: Kysely<NexStockDatabase>): Promise<void> {
  const existingTenant = await db
    .selectFrom('tenants')
    .select('id')
    .where('id', '=', DEMO_TENANT_ID)
    .executeTakeFirst();

  if (existingTenant) {
    return;
  }

  console.log('[NexStock API] Seeding initial demo data for local exploration...');

  // 1. Tenant & Plan
  await db
    .insertInto('tenants')
    .values({
      id: DEMO_TENANT_ID,
      slug: 'nexstock-global-demo',
      legal_name: 'NexStock Global Retail Ltd (Demo Store)',
      status: 'ACTIVE',
      base_currency: 'USD',
      default_locale: 'en-US',
      default_timezone: 'America/New_York',
      country_code: 'US',
    })
    .execute();

  const plan = await db
    .selectFrom('subscription_plans')
    .select('id')
    .where('code', '=', 'GROWTH')
    .executeTakeFirst();

  if (plan) {
    await db
      .insertInto('tenant_subscriptions')
      .values({
        id: generateUuidV7(),
        tenant_id: DEMO_TENANT_ID,
        plan_id: plan.id,
        status: 'ACTIVE',
        billing_mode: 'ADMIN_PROVISIONED',
        provider_code: 'MANUAL_ADMIN',
        current_period_start: new Date(),
        current_period_end: new Date(Date.now() + 30 * 86400 * 1000),
      })
      .execute();
  }

  // 2. IAM System Roles and Memberships
  await withTenantTransaction(
    db,
    { tenantId: DEMO_TENANT_ID, userId: DEMO_OWNER_USER_ID, traceId: generateUuidV7() },
    async (trx) => {
      await seedDefaultSystemRoles(trx);

      await provisionTenantMember(trx, {
        userId: DEMO_OWNER_USER_ID,
        email: 'owner@demo.nexstock.local',
        fullName: 'Demo Store Owner',
        roleCodes: ['TENANT_OWNER'],
        allLocationsAccess: true,
      });

      await provisionTenantMember(trx, {
        userId: DEMO_CASHIER_USER_ID,
        email: 'cashier@demo.nexstock.local',
        fullName: 'Demo Cashier',
        roleCodes: ['CASHIER'],
        allLocationsAccess: true,
      });
    },
  );

  // 3. Branches & Warehouses
  await db
    .insertInto('branches')
    .values([
      {
        id: DEMO_BRANCH_1_ID,
        tenant_id: DEMO_TENANT_ID,
        code: 'BR-NYC-01',
        name: 'Manhattan Flagship Store',
        country_code: 'US',
        timezone: 'America/New_York',
        is_active: true,
      },
    ])
    .execute();

  await db
    .insertInto('warehouses')
    .values([
      {
        id: DEMO_WAREHOUSE_1_ID,
        tenant_id: DEMO_TENANT_ID,
        branch_id: DEMO_BRANCH_1_ID,
        code: 'WH-NYC-01',
        name: 'Manhattan Retail Stockroom',
        allow_negative_stock: false,
        is_active: true,
      },
    ])
    .execute();

  // 4. POS Registers
  await db
    .insertInto('pos_registers')
    .values([
      {
        id: DEMO_REGISTER_1_ID,
        tenant_id: DEMO_TENANT_ID,
        branch_id: DEMO_BRANCH_1_ID,
        warehouse_id: DEMO_WAREHOUSE_1_ID,
        code: 'REG-01',
        name: 'Front Counter Express 1',
        is_active: true,
        last_invoice_seq: 0,
      },
      {
        id: DEMO_REGISTER_2_ID,
        tenant_id: DEMO_TENANT_ID,
        branch_id: DEMO_BRANCH_1_ID,
        warehouse_id: DEMO_WAREHOUSE_1_ID,
        code: 'REG-02',
        name: 'Front Counter Terminal 2',
        is_active: true,
        last_invoice_seq: 0,
      },
    ])
    .execute();

  // 5. Tax Group (NYC 8.875%)
  const taxGroupId = generateUuidV7();
  await db
    .insertInto('tax_groups')
    .values({
      id: taxGroupId,
      tenant_id: DEMO_TENANT_ID,
      code: 'NYC-SALES-TAX',
      name: 'NYC Standard Sales Tax (8.875%)',
      country_code: 'US',
      is_active: true,
    })
    .execute();

  await db
    .insertInto('tax_rates')
    .values([
      {
        id: generateUuidV7(),
        tenant_id: DEMO_TENANT_ID,
        tax_group_id: taxGroupId,
        code: 'NY-STATE-TAX',
        name: 'NY State Tax',
        rate_percentage: '4.0000',
        is_compound: false,
        priority: 1,
        is_active: true,
      },
      {
        id: generateUuidV7(),
        tenant_id: DEMO_TENANT_ID,
        tax_group_id: taxGroupId,
        code: 'NYC-CITY-TAX',
        name: 'NYC City Tax',
        rate_percentage: '4.8750',
        is_compound: false,
        priority: 2,
        is_active: true,
      },
    ])
    .execute();

  // 6. Categories
  const catElectronics = generateUuidV7();
  const catAccessories = generateUuidV7();
  const catServices = generateUuidV7();

  await db
    .insertInto('categories')
    .values([
      {
        id: catElectronics,
        tenant_id: DEMO_TENANT_ID,
        name: 'Electronics',
        description: 'Computers, displays, and gadgets',
        status: 'ACTIVE',
      },
      {
        id: catAccessories,
        tenant_id: DEMO_TENANT_ID,
        name: 'Computer Accessories',
        description: 'Cables, peripherals, mice, keyboards',
        status: 'ACTIVE',
      },
      {
        id: catServices,
        tenant_id: DEMO_TENANT_ID,
        name: 'Professional Services',
        description: 'Installation, repairs, and diagnostics',
        status: 'ACTIVE',
      },
    ])
    .execute();

  // 7. Products
  const prodMouse = generateUuidV7();
  const prodCable = generateUuidV7();
  const prodMonitor = generateUuidV7();
  const prodService = generateUuidV7();

  await db
    .insertInto('products')
    .values([
      {
        id: prodMouse,
        tenant_id: DEMO_TENANT_ID,
        sku: 'MOUSE-WL-01',
        name: 'Ergonomic Wireless Mouse',
        description: '2.4GHz rechargeable wireless optical mouse',
        category_id: catAccessories,
        product_type: 'STANDARD',
        base_uom: 'PCS',
        purchase_cost: '12.0000',
        selling_price: '25.0000',
        tax_group_id: taxGroupId,
        track_inventory: true,
        reorder_point: '5.000000',
        reorder_qty: '20.000000',
        status: 'ACTIVE',
      },
      {
        id: prodCable,
        tenant_id: DEMO_TENANT_ID,
        sku: 'CABLE-USBC-01',
        name: 'Braided USB-C Cable 2M',
        description: 'Heavy duty nylon braided USB-C 100W cable',
        category_id: catAccessories,
        product_type: 'STANDARD',
        base_uom: 'PCS',
        purchase_cost: '3.0000',
        selling_price: '10.0000',
        tax_group_id: taxGroupId,
        track_inventory: true,
        reorder_point: '10.000000',
        reorder_qty: '50.000000',
        status: 'ACTIVE',
      },
      {
        id: prodMonitor,
        tenant_id: DEMO_TENANT_ID,
        sku: 'MON-4K-27',
        name: 'UltraSharp 27 4K Monitor',
        description: '27-inch IPS 4K UHD with USB-C 90W power delivery',
        category_id: catElectronics,
        product_type: 'STANDARD',
        base_uom: 'PCS',
        purchase_cost: '285.5000',
        selling_price: '449.9900',
        tax_group_id: taxGroupId,
        track_inventory: true,
        reorder_point: '3.000000',
        reorder_qty: '10.000000',
        status: 'ACTIVE',
      },
      {
        id: prodService,
        tenant_id: DEMO_TENANT_ID,
        sku: 'SRV-SETUP-01',
        name: 'Device Setup & Diagnostic Service',
        description: 'Complete on-site device setup and diagnostics',
        category_id: catServices,
        product_type: 'SERVICE',
        base_uom: 'JOB',
        purchase_cost: '0.0000',
        selling_price: '50.0000',
        tax_group_id: taxGroupId,
        track_inventory: false,
        status: 'ACTIVE',
      },
    ])
    .execute();

  // Barcodes
  await db
    .insertInto('product_barcodes')
    .values([
      {
        id: generateUuidV7(),
        tenant_id: DEMO_TENANT_ID,
        product_id: prodMouse,
        barcode: '012345678901',
        barcode_type: 'UPCA',
        uom_code: 'PCS',
        is_primary: true,
      },
      {
        id: generateUuidV7(),
        tenant_id: DEMO_TENANT_ID,
        product_id: prodCable,
        barcode: '098765432101',
        barcode_type: 'UPCA',
        uom_code: 'PCS',
        is_primary: true,
      },
      {
        id: generateUuidV7(),
        tenant_id: DEMO_TENANT_ID,
        product_id: prodMonitor,
        barcode: '8800112233441',
        barcode_type: 'EAN13',
        uom_code: 'PCS',
        is_primary: true,
      },
    ])
    .execute();

  // UoM conversions for Cable (BOX = 10 PCS)
  await db
    .insertInto('product_unit_conversions')
    .values({
      id: generateUuidV7(),
      tenant_id: DEMO_TENANT_ID,
      product_id: prodCable,
      uom_code: 'BOX',
      uom_name: 'Box of 10 Cables',
      conversion_factor_to_base: '10.000000',
    })
    .execute();

  // 8. Suppliers
  const supApex = generateUuidV7();
  const supPacific = generateUuidV7();

  await db
    .insertInto('suppliers')
    .values([
      {
        id: supApex,
        tenant_id: DEMO_TENANT_ID,
        code: 'SUP-APEX-01',
        business_name: 'Apex Wholesale Electronics',
        contact_person: 'David Chen',
        email: 'sales@apex-electronics.example.com',
        phone: '+1-555-234-5678',
        status: 'ACTIVE',
      },
      {
        id: supPacific,
        tenant_id: DEMO_TENANT_ID,
        code: 'SUP-PACIFIC-02',
        business_name: 'Pacific Connectivity Solutions',
        contact_person: 'Sarah Miller',
        email: 'orders@pacific-cables.example.com',
        phone: '+1-555-876-5432',
        status: 'ACTIVE',
      },
    ])
    .execute();

  // 9. Initial Stock Ledger Entries via withTenantTransaction
  await withTenantTransaction(
    db,
    {
      tenantId: DEMO_TENANT_ID,
      userId: DEMO_OWNER_USER_ID,
      traceId: 'seed_stock_ledger',
    },
    async (trx) => {
      const initialStock = [
        {
          productId: prodMouse,
          qty: '50.000000',
          cost: '12.0000',
        },
        {
          productId: prodCable,
          qty: '100.000000',
          cost: '3.0000',
        },
        {
          productId: prodMonitor,
          qty: '12.000000',
          cost: '285.5000',
        },
      ];

      for (const item of initialStock) {
        const ledgerId = generateUuidV7();
        await trx.db
          .insertInto('stock_ledger_entries')
          .values({
            id: ledgerId,
            tenant_id: DEMO_TENANT_ID,
            branch_id: DEMO_BRANCH_1_ID,
            warehouse_id: DEMO_WAREHOUSE_1_ID,
            product_id: item.productId,
            movement_type: 'OPENING_STOCK',
            uom_code: 'PCS',
            input_qty: item.qty,
            conversion_factor_to_base: '1.000000',
            qty_delta: item.qty,
            balance_before: '0.000000',
            balance_after: item.qty,
            unit_cost: item.cost,
            reference_type: 'INITIAL_IMPORT',
            reference_id: 'SEED-DATA-001',
            reason: 'Initial warehouse opening inventory balance',
            reversed_entry_id: null,
            actor_user_id: DEMO_OWNER_USER_ID,
            idempotency_key: generateUuidV7(),
            occurred_at: new Date(),
          })
          .execute();

        await trx.db
          .insertInto('inventory_balances')
          .values({
            id: generateUuidV7(),
            tenant_id: DEMO_TENANT_ID,
            branch_id: DEMO_BRANCH_1_ID,
            warehouse_id: DEMO_WAREHOUSE_1_ID,
            product_id: item.productId,
            uom_code: 'PCS',
            qty_on_hand: item.qty,
            qty_reserved: '0.000000',
            last_ledger_entry_id: ledgerId,
            last_movement_at: new Date(),
          })
          .execute();
      }
    },
  );

  console.log('[NexStock API] Demo data successfully seeded.');
}

export async function startServer(): Promise<void> {
  const port = process.env['PORT'] ? Number(process.env['PORT']) : 4000;
  const host = process.env['HOST'] ?? '0.0.0.0';

  let db: Kysely<NexStockDatabase>;
  let jwksProvider: JwksKeyProvider;

  if (process.env['APP_DATABASE_URL']) {
    console.log('[NexStock API] Initializing with remote PostgreSQL database...');
    const validated = validateEnvironmentConfig(process.env);
    const { ssl, sanitizedConnectionString } = resolveDatabaseSslConfig({
      connectionString: validated.appDatabaseUrl,
      sslCa: validated.appDatabaseSslCa,
      sslCaPath: validated.appDatabaseSslCaPath,
    });
    const pool = new pg.Pool({
      connectionString: sanitizedConnectionString,
      ssl,
      connectionTimeoutMillis: 10000,
      idleTimeoutMillis: 30000,
      max: 10,
    });
    pool.on('error', (err) => {
      const errObj = err as unknown as Record<string, unknown>;
      console.error('[NexStock DB Pool Error]', {
        name: err.name,
        code: errObj?.['code'],
        message: sanitizeLogMessage(err.message),
      });
    });

    // Non-blocking initial connectivity verification ping
    pool
      .query('SELECT 1 as alive')
      .then(() => {
        console.log('[NexStock API] Remote PostgreSQL connection verified successfully.');
      })
      .catch((err) => {
        const errObj = err as unknown as Record<string, unknown>;
        console.error('[NexStock API] Remote PostgreSQL connection failed during startup check:', {
          name: err instanceof Error ? err.name : typeof err,
          code: errObj?.['code'],
          message: sanitizeLogMessage(err instanceof Error ? err.message : String(err)),
        });
      });

    const dialect = new PostgresDialect({ pool });
    db = new Kysely<NexStockDatabase>({ dialect });
    jwksProvider = new RemoteJwksProvider({ jwksUrl: validated.supabaseJwksUrl });
  } else {
    console.log(
      '[NexStock API] No APP_DATABASE_URL detected. Starting in safe local development mode with embedded PostgreSQL (PGlite)...',
    );
    const pgInstance = new PGlite();
    await runPostgresMigrations(pgInstance);

    const keys = getOrCreateDevKeyMaterial();
    jwksProvider = new StaticJwksProvider({ keys: [keys.publicJwk] });

    db = new Kysely<NexStockDatabase>({
      dialect: {
        createAdapter: () => new PostgresAdapter(),
        createDriver: () => new LocalPGliteDriver(pgInstance),
        createIntrospector: (kyselyDb) => new PostgresIntrospector(kyselyDb),
        createQueryCompiler: () => new PostgresQueryCompiler(),
      },
    });

    await seedDemoData(db);
  }

  const app = await buildApp({
    db,
    jwksProvider,
  });

  // Local development demo auth endpoint
  app.post('/v1/auth/demo-session', async (request, reply) => {
    try {
      const body = (request.body as { role?: 'OWNER' | 'CASHIER' }) ?? {};
      const role = body.role === 'CASHIER' ? 'CASHIER' : 'OWNER';
      const userId = role === 'OWNER' ? DEMO_OWNER_USER_ID : DEMO_CASHIER_USER_ID;
      const email = role === 'OWNER' ? 'owner@demo.nexstock.local' : 'cashier@demo.nexstock.local';

      const token = generateDevJwt({
        sub: userId,
        email,
        tenantId: DEMO_TENANT_ID,
        role,
      });

      return reply.send({
        token,
        tenantId: DEMO_TENANT_ID,
        userId,
        email,
        fullName: role === 'OWNER' ? 'Demo Store Owner' : 'Demo Cashier',
        role,
        branchId: DEMO_BRANCH_1_ID,
        warehouseId: DEMO_WAREHOUSE_1_ID,
        registerId: DEMO_REGISTER_1_ID,
      });
    } catch (err) {
      console.error('[Demo Session Error]', err);
      return reply.status(500).send({ error: String(err) });
    }
  });

  await app.listen({ port, host });

  console.log(`\n======================================================`);
  console.log(`  NexStock Modular Monolith API v0.1.0`);
  console.log(`  URL: http://localhost:${port}`);
  console.log(`  Health Check: http://localhost:${port}/v1/health/live`);
  console.log(`  OpenAPI Spec: http://localhost:${port}/v1/openapi.json`);
  console.log(`======================================================\n`);
}

// Auto-start when executed directly
if (process.argv[1]?.includes('server')) {
  startServer().catch((err) => {
    console.error('[NexStock API] Fatal server error:', err);
    process.exit(1);
  });
}

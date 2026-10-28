import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { type Kysely, sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type NexStockDatabase,
  type PostgresMigrationSpec,
  assertActiveRoleEnforcesRls,
  assertPostgresMigrationSqlCompatible,
  buildApp,
  generateUuidV7,
  getOrderedPostgresMigrations,
  loadFoundationMigrationSql,
  loadMilestone1MigrationSql,
  loadPhase2MigrationSql,
  runPostgresMigrations,
  sanitizeLogMessage,
  validateDatabaseCredentialSeparation,
  validateEnvironmentConfig,
  withTenantTransaction,
} from '../src/index.js';
import {
  type TestPostgresHarness,
  createTestPostgresHarness,
} from './helpers/pglite-kysely.js';

const TENANT_ALPHA = '0192b4a0-1111-7000-8000-000000000001';
const TENANT_BETA = '0192b4a0-2222-7000-8000-000000000002';
const USER_ALPHA = '0192b4a0-1111-7000-8000-000000000099';
const USER_BETA = '0192b4a0-2222-7000-8000-000000000099';

describe('@nexstock/api — Milestone 0 Foundation, RLS, Idempotency & Sync Invariants', () => {
  let harness: TestPostgresHarness;

  beforeAll(async () => {
    harness = await createTestPostgresHarness();
  });

  afterAll(async () => {
    await harness.db.destroy();
  });

  describe('1. Database Credential Separation & Reproducible RLS Migration', () => {
    it('enforces strict separation between APP_DATABASE_URL and MIGRATION_DATABASE_URL', () => {
      expect(() =>
        validateDatabaseCredentialSeparation({
          appDatabaseUrl:
            'postgresql://nexstock_app_user:secret@localhost:5432/nexstock',
          migrationDatabaseUrl:
            'postgresql://nexstock_migrator:secret@localhost:5432/nexstock',
        }),
      ).not.toThrow();

      // Same user for both -> must fail
      expect(() =>
        validateDatabaseCredentialSeparation({
          appDatabaseUrl:
            'postgresql://nexstock_migrator:secret@localhost:5432/nexstock',
          migrationDatabaseUrl:
            'postgresql://nexstock_migrator:secret@localhost:5432/nexstock',
        }),
      ).toThrow(/Privilege separation violation/);

      // Privileged postgres user in runtime URL -> must fail
      expect(() =>
        validateDatabaseCredentialSeparation({
          appDatabaseUrl: 'postgresql://postgres:secret@localhost:5432/nexstock',
          migrationDatabaseUrl:
            'postgresql://nexstock_migrator:secret@localhost:5432/nexstock',
        }),
      ).toThrow(/privileged owner/);

      // Environment config validation: valid env succeeds, missing or placeholder env fails safely without leaking secrets
      const validEnv = {
        SUPABASE_URL: 'https://tokylhdgzyoxiqwvncis.supabase.co',
        SUPABASE_JWKS_URL:
          'https://tokylhdgzyoxiqwvncis.supabase.co/auth/v1/.well-known/jwks.json',
        SUPABASE_JWT_ISSUER:
          'https://tokylhdgzyoxiqwvncis.supabase.co/auth/v1',
        SUPABASE_JWT_AUDIENCE: 'authenticated',
        APP_DATABASE_URL:
          'postgresql://nexstock_app_user:local_dev_pw@localhost:5432/nexstock',
        MIGRATION_DATABASE_URL:
          'postgresql://nexstock_migrator:local_mig_pw@localhost:5432/nexstock',
      };
      expect(
        validateEnvironmentConfig(validEnv, {
          requireMigrationDatabaseUrl: true,
        }).supabaseJwtAudience,
      ).toBe('authenticated');

      expect(() =>
        validateEnvironmentConfig({
          ...validEnv,
          APP_DATABASE_URL: undefined,
        }),
      ).toThrow(/Missing required environment variable "APP_DATABASE_URL"/);

      expect(() =>
        validateEnvironmentConfig({
          ...validEnv,
          APP_DATABASE_URL:
            'postgresql://nexstock_app_user:SET_IN_LOCAL_ENV@localhost:5432/nexstock',
        }),
      ).toThrow(/still contains the placeholder value "SET_IN_LOCAL_ENV"/);

      expect(() =>
        validateEnvironmentConfig({
          ...validEnv,
          SUPABASE_URL: 'http://insecure.supabase.co',
        }),
      ).toThrow(/must be valid HTTPS URLs/);
    });

    it('is safe to rerun 0001_shared_foundation_rls.sql idempotently and enforces NOBYPASSRLS inside withTenantTransaction', async () => {
      // Rerunning migration SQL must succeed without error
      await expect(
        harness.pg.exec(loadFoundationMigrationSql()),
      ).resolves.not.toThrow();

      // Outside withTenantTransaction, the default PGlite owner is a superuser -> assertActiveRoleEnforcesRls must reject it!
      await expect(assertActiveRoleEnforcesRls(harness.db)).rejects.toThrow(
        /CRITICAL RLS BYPASS DETECTED/,
      );

      // Inside withTenantTransaction, SET LOCAL ROLE nexstock_app_user is active (rolsuper=false, rolbypassrls=false)
      const status = await withTenantTransaction(
        harness.db,
        {
          tenantId: TENANT_ALPHA,
          userId: USER_ALPHA,
          traceId: 'trace_rls_check',
        },
        async (trx) => assertActiveRoleEnforcesRls(trx),
      );
      expect(status.roleName).toBe('nexstock_app_user');
      expect(status.isSuperuser).toBe(false);
      expect(status.bypassesRls).toBe(false);

      // Verify schema_migrations ledger recorded versions 1, 2, 3, and 4
      const appliedMigrations = await harness.db
        .selectFrom('schema_migrations')
        .select(['version', 'name', 'filename'])
        .orderBy('version', 'asc')
        .execute();
      expect(appliedMigrations).toEqual([
        {
          version: 1,
          name: '0001_shared_foundation_rls',
          filename: '0001_shared_foundation_rls.sql',
        },
        {
          version: 2,
          name: '0002_milestone1_iam_org_sub_i18n',
          filename: '0002_milestone1_iam_org_sub_i18n.sql',
        },
        {
          version: 3,
          name: '0003_phase2_core_inventory',
          filename: '0003_phase2_core_inventory.sql',
        },
        {
          version: 4,
          name: '0004_phase3_pos_and_billing',
          filename: '0004_phase3_pos_and_billing.sql',
        },
        {
          version: 5,
          name: '0005_phase4_advanced_inventory',
          filename: '0005_phase4_advanced_inventory.sql',
        },
      ]);
    });

    it('rejects SQLite migration scripts (PRAGMA, AUTOINCREMENT, STRICT) and out-of-order migrations in the PostgreSQL runner', async () => {
      const testDir = dirname(fileURLToPath(import.meta.url));
      const sqliteMigrationPath = resolve(
        testDir,
        '../../../packages/sqlite-schema/migrations/0001_local_sync_foundation.sql',
      );
      const sqliteMigrationSql = readFileSync(sqliteMigrationPath, 'utf-8');
      const sqliteMigration = {
        dialect: 'sqlite' as const,
        version: 1,
        name: '0001_local_sync_foundation',
        filename: '0001_local_sync_foundation.sql',
        sql: sqliteMigrationSql,
      };

      // 1. Direct SQLite script validation against PostgreSQL compatibility guard must throw
      expect(() =>
        assertPostgresMigrationSqlCompatible(
          sqliteMigration.sql,
          sqliteMigration.filename,
        ),
      ).toThrow(/SQLITE_MIGRATION_REJECTED.*PRAGMA/);

      // 2. Passing the SQLite migration spec into runPostgresMigrations must be rejected before executing SQL
      let executedCount = 0;
      const spyExecutor = {
        exec: () => {
          executedCount++;
        },
      };

      await expect(
        runPostgresMigrations(spyExecutor, [
          sqliteMigration as unknown as PostgresMigrationSpec,
        ]),
      ).rejects.toThrow(/SQLITE_MIGRATION_REJECTED/);
      expect(executedCount).toBe(0);

      // 3. Even if dialect is spoofed as 'postgres', the PRAGMA / STRICT content check rejects it
      await expect(
        runPostgresMigrations(spyExecutor, [
          {
            dialect: 'postgres',
            version: 1,
            name: sqliteMigration.name,
            filename: sqliteMigration.filename,
            sql: sqliteMigration.sql,
          },
        ]),
      ).rejects.toThrow(/SQLITE_MIGRATION_REJECTED.*PRAGMA/);
      expect(executedCount).toBe(0);

      // 4. Out-of-order PostgreSQL migrations (0002 before 0001) are rejected by runPostgresMigrations
      const pgMigrations = getOrderedPostgresMigrations();
      expect(pgMigrations.map((m) => m.filename)).toEqual([
        '0001_shared_foundation_rls.sql',
        '0002_milestone1_iam_org_sub_i18n.sql',
        '0003_phase2_core_inventory.sql',
        '0004_phase3_pos_and_billing.sql',
        '0005_phase4_advanced_inventory.sql',
      ]);

      await expect(
        runPostgresMigrations(spyExecutor, [pgMigrations[1]!, pgMigrations[0]!]),
      ).rejects.toThrow(/MIGRATION_ORDER_ERROR/);
      expect(executedCount).toBe(0);

      // 5. SQL-level prerequisite guard: executing 0002 or 0003 directly on an uninitialized PostgreSQL DB fails with MIGRATION_ORDER_ERROR
      const blankPg = new PGlite();
      await expect(
        blankPg.exec(loadMilestone1MigrationSql()),
      ).rejects.toThrow(/MIGRATION_ORDER_ERROR/);
      await expect(
        blankPg.exec(loadPhase2MigrationSql()),
      ).rejects.toThrow(/MIGRATION_ORDER_ERROR/);
      await blankPg.close();
    });

    it('executes and reruns 0001, 0002, and 0003 under a non-superuser CREATEROLE migration role (simulating managed Supabase postgres role)', async () => {
      const managedPg = new PGlite();

      // Simulate Supabase managed PostgreSQL environment:
      // The migration role (`supabase_managed_migrator`) has CREATEROLE and owns schema `public`,
      // but is NOT a PostgreSQL SUPERUSER (`rolsuper = false`).
      await managedPg.exec(`
        CREATE ROLE supabase_managed_migrator LOGIN NOSUPERUSER CREATEDB CREATEROLE NOBYPASSRLS;
        ALTER SCHEMA public OWNER TO supabase_managed_migrator;
        GRANT ALL ON SCHEMA public TO supabase_managed_migrator;
        SET ROLE supabase_managed_migrator;
      `);

      const roleCheck = await managedPg.query<{
        current_user: string;
        rolsuper: boolean;
        rolcreaterole: boolean;
      }>(`
        SELECT current_user::text AS current_user, rolsuper, rolcreaterole
        FROM pg_roles
        WHERE rolname = current_user;
      `);
      expect(roleCheck.rows[0]).toEqual({
        current_user: 'supabase_managed_migrator',
        rolsuper: false,
        rolcreaterole: true,
      });

      // If only `nexstock_app_user` exists without 0001's tables, 0002 and 0003 must reject with MIGRATION_ORDER_ERROR
      await managedPg.exec(`CREATE ROLE nexstock_app_user NOLOGIN;`);
      await expect(
        managedPg.exec(loadMilestone1MigrationSql()),
      ).rejects.toThrow(/MIGRATION_ORDER_ERROR/);
      await expect(
        managedPg.exec(loadPhase2MigrationSql()),
      ).rejects.toThrow(/MIGRATION_ORDER_ERROR/);

      // 1st run of 0001 (when `nexstock_app_user` already exists!), 0002, and 0003 under non-superuser CREATEROLE
      await expect(
        managedPg.exec(loadFoundationMigrationSql()),
      ).resolves.not.toThrow();
      await expect(
        managedPg.exec(loadMilestone1MigrationSql()),
      ).resolves.not.toThrow();
      await expect(
        managedPg.exec(loadPhase2MigrationSql()),
      ).resolves.not.toThrow();

      // 2nd rerun of 0001, 0002, and 0003 under non-superuser CREATEROLE must also succeed without 42501 permission denied
      await expect(
        managedPg.exec(loadFoundationMigrationSql()),
      ).resolves.not.toThrow();
      await expect(
        managedPg.exec(loadMilestone1MigrationSql()),
      ).resolves.not.toThrow();
      await expect(
        managedPg.exec(loadPhase2MigrationSql()),
      ).resolves.not.toThrow();

      // Verify `nexstock_app_user` attributes and runtime RLS enforcement under `SET LOCAL ROLE nexstock_app_user`
      const appRoleRow = await managedPg.query<{
        rolsuper: boolean;
        rolbypassrls: boolean;
        rolcanlogin: boolean;
        rolcreatedb: boolean;
        rolcreaterole: boolean;
      }>(`
        SELECT rolsuper, rolbypassrls, rolcanlogin, rolcreatedb, rolcreaterole
        FROM pg_roles
        WHERE rolname = 'nexstock_app_user';
      `);
      expect(appRoleRow.rows[0]).toEqual({
        rolsuper: false,
        rolbypassrls: false,
        rolcanlogin: false,
        rolcreatedb: false,
        rolcreaterole: false,
      });

      // Verify transaction-scoped tenant isolation works under `SET LOCAL ROLE nexstock_app_user`
      // (`currencies` is already seeded by 0002 and granted SELECT-only to `nexstock_app_user`)
      await managedPg.exec(`
        BEGIN;
        SET LOCAL ROLE nexstock_app_user;
        SELECT set_config('app.current_tenant_id', '${TENANT_ALPHA}', true);
        INSERT INTO tenants (id, slug, legal_name, base_currency)
          VALUES ('${TENANT_ALPHA}', 'alpha-org', 'Alpha Org', 'USD');
        COMMIT;
      `);

      await managedPg.exec(`
        SELECT set_config('app.current_tenant_id', '${TENANT_BETA}', false);
        SET ROLE nexstock_app_user;
      `);
      const isolatedQuery = await managedPg.query<{ id: string }>(
        `SELECT id FROM tenants;`,
      );
      expect(isolatedQuery.rows).toHaveLength(0);

      await managedPg.close();
    });
  });

  describe('2. Fastify + TypeBox Validation, OpenAPI 3.1 & Health Readiness', () => {
    it('serves /v1/health/live, /v1/health/ready, and emits OpenAPI 3.1.0 spec at /v1/openapi.json', async () => {
      const app = await buildApp({ db: harness.db });

      const liveRes = await app.inject({
        method: 'GET',
        url: '/v1/health/live',
      });
      expect(liveRes.statusCode).toBe(200);
      expect(liveRes.json().status).toBe('ok');

      const readyRes = await app.inject({
        method: 'GET',
        url: '/v1/health/ready',
      });
      expect(readyRes.statusCode).toBe(200);

      const openApiRes = await app.inject({
        method: 'GET',
        url: '/v1/openapi.json',
      });
      expect(openApiRes.statusCode).toBe(200);
      expect(openApiRes.json().openapi).toBe('3.1.0');

      await app.close();
    });

    it('returns 503 Service Unavailable when the database readiness check fails and sanitizes logs', async () => {
      const brokenDb = {
        transaction: () => ({
          execute: async () => {
            throw new Error('connect ECONNREFUSED 127.0.0.1:5432');
          },
        }),
      } as unknown as Kysely<NexStockDatabase>;

      const app = await buildApp({ db: brokenDb });

      const liveRes = await app.inject({
        method: 'GET',
        url: '/v1/health/live',
      });
      expect(liveRes.statusCode).toBe(200);
      expect(liveRes.json().status).toBe('ok');

      const readyRes = await app.inject({
        method: 'GET',
        url: '/v1/health/ready',
      });
      expect(readyRes.statusCode).toBe(503);
      const readyJson = readyRes.json();
      expect(readyJson.status).toBe(503);
      expect(readyJson.title).toBe('Service Unavailable');
      expect(readyJson.detail).toBe('Database readiness check failed.');
      expect(readyJson.errorCode).toBe('ERR_INTERNAL_SERVER_ERROR');
      expect(readyJson.traceId).toBeDefined();

      await app.close();

      const rawUrl = 'postgresql://nexstock_app_user:super_secret_pw123@db.supabase.co:5432/postgres';
      const sanitized = sanitizeLogMessage(`Failed to connect to ${rawUrl}`);
      expect(sanitized).not.toContain('super_secret_pw123');
      expect(sanitized).toContain('postgresql://nexstock_app_user:***@db.supabase.co:5432/postgres');

      const rawAuth = 'Error with Bearer eyJhbGciOiJIUzI1NiJ9.secret';
      expect(sanitizeLogMessage(rawAuth)).toBe('Error with Bearer ***');
    });

    it('rejects float numbers on monetary string fields (coerceTypes: false) with RFC 9457 Problem Details', async () => {
      const app = await buildApp({ db: harness.db });

      const badRes = await app.inject({
        method: 'POST',
        url: '/v1/kernel/audit-mutations',
        headers: {
          'x-tenant-id': TENANT_ALPHA,
          'idempotency-key': generateUuidV7(),
        },
        payload: {
          action: 'TEST_FLOAT_REJECTION',
          resourceType: 'INVOICE',
          resourceId: generateUuidV7(),
          amount: 124.5, // Float number instead of canonical fixed-point string!
        },
      });

      expect(badRes.statusCode).toBe(400);
      expect(badRes.headers['content-type']).toContain(
        'application/problem+json',
      );
      expect(badRes.json().errorCode).toBe('ERR_VALIDATION_FAILED');

      await app.close();
    });
  });

  describe('3. Multi-Tenant PostgreSQL RLS Isolation, Fail-Closed Default & Immutability Triggers', () => {
    it('isolates Tenant_Alpha and Tenant_Beta strictly via PostgreSQL RLS and blocks cross-tenant writes', async () => {
      const app = await buildApp({ db: harness.db });

      // Insert record for Tenant Alpha
      const alphaRes = await app.inject({
        method: 'POST',
        url: '/v1/kernel/audit-mutations',
        headers: {
          'x-tenant-id': TENANT_ALPHA,
          'x-user-id': USER_ALPHA,
          'idempotency-key': generateUuidV7(),
        },
        payload: {
          action: 'ALPHA_ACTION',
          resourceType: 'PRODUCT',
          resourceId: generateUuidV7(),
          amount: '100.0000',
        },
      });
      expect(alphaRes.statusCode).toBe(201);

      // Insert record for Tenant Beta
      const betaRes = await app.inject({
        method: 'POST',
        url: '/v1/kernel/audit-mutations',
        headers: {
          'x-tenant-id': TENANT_BETA,
          'x-user-id': USER_BETA,
          'idempotency-key': generateUuidV7(),
        },
        payload: {
          action: 'BETA_ACTION',
          resourceType: 'PRODUCT',
          resourceId: generateUuidV7(),
          amount: '250.0000',
        },
      });
      expect(betaRes.statusCode).toBe(201);

      // Query /v1/kernel/audit-logs as Tenant Alpha (no explicit WHERE tenant_id in SQL!)
      const listAlpha = await app.inject({
        method: 'GET',
        url: '/v1/kernel/audit-logs',
        headers: {
          'x-tenant-id': TENANT_ALPHA,
          'x-user-id': USER_ALPHA,
        },
      });
      expect(listAlpha.statusCode).toBe(200);
      const alphaItems = listAlpha.json().items as Array<{
        tenantId: string;
        action: string;
      }>;
      expect(alphaItems.length).toBeGreaterThanOrEqual(1);
      expect(alphaItems.every((i) => i.tenantId === TENANT_ALPHA)).toBe(true);
      expect(alphaItems.some((i) => i.action === 'BETA_ACTION')).toBe(false);

      // Attempt cross-tenant INSERT (writing TENANT_BETA row inside TENANT_ALPHA context) -> must fail RLS WITH CHECK!
      await expect(
        withTenantTransaction(
          harness.db,
          {
            tenantId: TENANT_ALPHA,
            userId: USER_ALPHA,
            traceId: 'trace_cross_tenant_write',
          },
          async (trx) => {
            await trx
              .insertInto('audit_logs')
              .values({
                id: generateUuidV7(),
                tenant_id: TENANT_BETA, // Spoofed tenant_id!
                actor_user_id: USER_ALPHA,
                action: 'SPOOFED_WRITE',
                resource_type: 'TEST',
                resource_id: generateUuidV7(),
                metadata_json: '{}',
                trace_id: 'trace_spoof',
              })
              .execute();
          },
        ),
      ).rejects.toThrow(/row-level security policy/);

      // Verify fail-closed behavior when app.current_tenant_id is empty under nexstock_app_user
      const failClosedRows = await harness.db
        .transaction()
        .execute(async (trx) => {
          await sql`SET LOCAL ROLE nexstock_app_user`.execute(trx);
          await sql`SELECT set_config('app.current_tenant_id', '', true)`.execute(
            trx,
          );
          return trx.selectFrom('audit_logs').selectAll().execute();
        });
      expect(failClosedRows.length).toBe(0);

      await app.close();
    });

    it('prevents UPDATE and DELETE on append-only audit_logs via both least-privilege ACLs and database trigger', async () => {
      // Layer 1: Runtime role (nexstock_app_user) lacks UPDATE/DELETE table privileges
      await expect(
        withTenantTransaction(
          harness.db,
          {
            tenantId: TENANT_ALPHA,
            userId: USER_ALPHA,
            traceId: 'trace_immutable_acl_test',
          },
          async (trx) => {
            await trx.deleteFrom('audit_logs').execute();
          },
        ),
      ).rejects.toThrow(/permission denied for table audit_logs/);

      // Layer 2: Even privileged table owner cannot UPDATE or DELETE due to BEFORE UPDATE OR DELETE trigger
      await expect(
        harness.db.deleteFrom('audit_logs').execute(),
      ).rejects.toThrow(/IMMUTABLE_TABLE_VIOLATION/);
    });
  });

  describe('4. Idempotency & Atomic Transaction Rollback', () => {
    it('replays identical idempotent mutations and rejects payload hash mismatches (422)', async () => {
      const app = await buildApp({ db: harness.db });
      const idempotencyKey = generateUuidV7();
      const resourceId = generateUuidV7();

      // 1st execution
      const first = await app.inject({
        method: 'POST',
        url: '/v1/kernel/audit-mutations',
        headers: {
          'x-tenant-id': TENANT_ALPHA,
          'x-user-id': USER_ALPHA,
          'idempotency-key': idempotencyKey,
        },
        payload: {
          action: 'IDEMPOTENT_SALE',
          resourceType: 'POS_INVOICE',
          resourceId,
          amount: '49.9900',
        },
      });
      expect(first.statusCode).toBe(201);
      expect(first.headers['x-idempotent-replayed']).toBe('false');

      // 2nd execution with identical key and payload -> replayed without duplicating rows
      const second = await app.inject({
        method: 'POST',
        url: '/v1/kernel/audit-mutations',
        headers: {
          'x-tenant-id': TENANT_ALPHA,
          'x-user-id': USER_ALPHA,
          'idempotency-key': idempotencyKey,
        },
        payload: {
          action: 'IDEMPOTENT_SALE',
          resourceType: 'POS_INVOICE',
          resourceId,
          amount: '49.9900',
        },
      });
      expect(second.statusCode).toBe(201);
      expect(second.headers['x-idempotent-replayed']).toBe('true');
      expect(second.json()).toEqual(first.json());

      // 3rd execution reusing the same key with a different amount -> 422
      const mismatch = await app.inject({
        method: 'POST',
        url: '/v1/kernel/audit-mutations',
        headers: {
          'x-tenant-id': TENANT_ALPHA,
          'x-user-id': USER_ALPHA,
          'idempotency-key': idempotencyKey,
        },
        payload: {
          action: 'IDEMPOTENT_SALE',
          resourceType: 'POS_INVOICE',
          resourceId,
          amount: '99.9900',
        },
      });
      expect(mismatch.statusCode).toBe(422);
      expect(mismatch.json().errorCode).toBe(
        'ERR_IDEMPOTENCY_KEY_REUSED_DIFFERENT_PAYLOAD',
      );

      await app.close();
    });

    it('rolls back audit_logs, outbox_events, and idempotency_keys atomically when a domain error occurs mid-transaction', async () => {
      const app = await buildApp({ db: harness.db });
      const failedKey = generateUuidV7();
      const failedResourceId = generateUuidV7();

      const failedRes = await app.inject({
        method: 'POST',
        url: '/v1/kernel/audit-mutations',
        headers: {
          'x-tenant-id': TENANT_ALPHA,
          'x-user-id': USER_ALPHA,
          'idempotency-key': failedKey,
        },
        payload: {
          action: 'ROLLBACK_TEST_ACTION',
          resourceType: 'POS_INVOICE',
          resourceId: failedResourceId,
          amount: '15.0000',
          simulateFailureAfterInsert: true,
        },
      });
      expect(failedRes.statusCode).toBe(409);

      // Verify neither audit_logs, outbox_events, nor idempotency_keys persisted the rolled-back write
      await withTenantTransaction(
        harness.db,
        {
          tenantId: TENANT_ALPHA,
          userId: USER_ALPHA,
          traceId: 'trace_verify_rollback',
        },
        async (trx) => {
          const auditRow = await trx
            .selectFrom('audit_logs')
            .selectAll()
            .where('resource_id', '=', failedResourceId)
            .executeTakeFirst();
          expect(auditRow).toBeUndefined();

          const outboxRow = await trx
            .selectFrom('outbox_events')
            .selectAll()
            .where('aggregate_id', '=', failedResourceId)
            .executeTakeFirst();
          expect(outboxRow).toBeUndefined();

          const idemRow = await trx
            .selectFrom('idempotency_keys')
            .selectAll()
            .where('idempotency_key', '=', failedKey)
            .executeTakeFirst();
          expect(idemRow).toBeUndefined();
        },
      );

      await app.close();
    });
  });

  describe('5. Offline Synchronization Batch Invariants (Savepoints, Quarantine, Deduplication)', () => {
    it('isolates poison-pill commands via SAVEPOINT into QUARANTINED status while applying subsequent commands and flagging negative stock conflicts', async () => {
      const app = await buildApp({ db: harness.db });
      const deviceId = generateUuidV7();
      const branchId = generateUuidV7();
      const cmd1Id = generateUuidV7();
      const cmd2PoisonId = generateUuidV7();
      const cmd3ConflictId = generateUuidV7();

      const pushRes = await app.inject({
        method: 'POST',
        url: '/v1/sync/push',
        headers: {
          'x-tenant-id': TENANT_ALPHA,
          'x-user-id': USER_ALPHA,
        },
        payload: {
          deviceId,
          branchId,
          commands: [
            {
              localSeq: 1,
              commandId: cmd1Id,
              tenantId: TENANT_ALPHA,
              branchId,
              deviceId,
              actorUserId: USER_ALPHA,
              commandType: 'POS_OPEN_SHIFT',
              schemaVersion: 1,
              occurredAt: '2026-10-26T08:00:00.000Z',
              payload: { openingFloat: '100.0000' },
            },
            {
              localSeq: 2,
              commandId: cmd2PoisonId,
              tenantId: TENANT_ALPHA,
              branchId,
              deviceId,
              actorUserId: USER_ALPHA,
              commandType: 'POS_RECORD_SALE',
              schemaVersion: 1,
              occurredAt: '2026-10-26T08:01:00.000Z',
              payload: { simulatePoisonPill: true },
            },
            {
              localSeq: 3,
              commandId: cmd3ConflictId,
              tenantId: TENANT_ALPHA,
              branchId,
              deviceId,
              actorUserId: USER_ALPHA,
              commandType: 'POS_RECORD_SALE',
              schemaVersion: 1,
              occurredAt: '2026-10-26T08:02:00.000Z',
              payload: { droveStockNegativeOffline: true },
            },
          ],
        },
      });

      expect(pushRes.statusCode).toBe(200);
      const receipts = pushRes.json().receipts;
      expect(receipts).toHaveLength(3);
      expect(receipts[0].status).toBe('APPLIED');
      expect(receipts[1].status).toBe('QUARANTINED');
      expect(receipts[1].conflictCode).toBe('INVALID_OFFLINE_COMMAND_PAYLOAD');
      expect(receipts[2].status).toBe('APPLIED_WITH_CONFLICT_FLAG');
      expect(receipts[2].conflictCode).toBe('NEGATIVE_STOCK_VARIANCE');

      // Verify cmd2PoisonId's partial audit_log write was rolled back by SAVEPOINT while cmd1 and cmd3 persisted
      await withTenantTransaction(
        harness.db,
        {
          tenantId: TENANT_ALPHA,
          userId: USER_ALPHA,
          traceId: 'trace_verify_sync',
        },
        async (trx) => {
          const poisonAudit = await trx
            .selectFrom('audit_logs')
            .selectAll()
            .where('resource_id', '=', cmd2PoisonId)
            .executeTakeFirst();
          expect(poisonAudit).toBeUndefined();

          const conflicts = await trx
            .selectFrom('sync_conflicts')
            .select(['command_id', 'conflict_type', 'status'])
            .where('device_id', '=', deviceId)
            .orderBy('created_at', 'asc')
            .execute();
          expect(conflicts).toEqual([
            {
              command_id: cmd2PoisonId,
              conflict_type: 'INVALID_OFFLINE_COMMAND_PAYLOAD',
              status: 'QUARANTINED',
            },
            {
              command_id: cmd3ConflictId,
              conflict_type: 'NEGATIVE_STOCK_VARIANCE',
              status: 'OPEN',
            },
          ]);
        },
      );

      // Replaying cmd1Id must return DUPLICATE_IGNORED
      const replayRes = await app.inject({
        method: 'POST',
        url: '/v1/sync/push',
        headers: {
          'x-tenant-id': TENANT_ALPHA,
          'x-user-id': USER_ALPHA,
        },
        payload: {
          deviceId,
          branchId,
          commands: [
            {
              localSeq: 1,
              commandId: cmd1Id,
              tenantId: TENANT_ALPHA,
              branchId,
              deviceId,
              actorUserId: USER_ALPHA,
              commandType: 'POS_OPEN_SHIFT',
              schemaVersion: 1,
              occurredAt: '2026-10-26T08:00:00.000Z',
              payload: { openingFloat: '100.0000' },
            },
          ],
        },
      });
      expect(replayRes.statusCode).toBe(200);
      expect(replayRes.json().receipts[0].status).toBe('DUPLICATE_IGNORED');

      await app.close();
    });
  });
});

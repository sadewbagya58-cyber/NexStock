import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Kysely, type Transaction, sql } from 'kysely';
import { SecurityConfigurationError } from '../domain/errors.js';
import type { NexStockDatabase } from './kysely-schema.js';

export interface DatabaseRoleSecurityStatus {
  readonly roleName: string;
  readonly isSuperuser: boolean;
  readonly bypassesRls: boolean;
}

export interface PostgresMigrationSpec {
  readonly dialect: 'postgres';
  readonly version: number;
  readonly name: string;
  readonly filename: string;
  readonly sql: string;
}

export interface PostgresMigrationRawExecutor {
  exec(sqlText: string): Promise<unknown> | unknown;
}

/**
 * Validates that runtime application DB credentials and privileged migration credentials
 * use distinct database users (Acceptance Criteria #2 & #6).
 */
export function validateDatabaseCredentialSeparation(params: {
  readonly appDatabaseUrl: string;
  readonly migrationDatabaseUrl: string;
}): void {
  let appUrl: URL;
  let migUrl: URL;
  try {
    appUrl = new URL(params.appDatabaseUrl);
    migUrl = new URL(params.migrationDatabaseUrl);
  } catch {
    throw new SecurityConfigurationError(
      'Invalid APP_DATABASE_URL or MIGRATION_DATABASE_URL connection string format.',
    );
  }

  const appUser = decodeURIComponent(appUrl.username);
  const migUser = decodeURIComponent(migUrl.username);

  if (!appUser || !migUser) {
    throw new SecurityConfigurationError(
      'Both APP_DATABASE_URL and MIGRATION_DATABASE_URL must specify an explicit database username.',
    );
  }

  if (appUser === migUser) {
    throw new SecurityConfigurationError(
      `Privilege separation violation: APP_DATABASE_URL and MIGRATION_DATABASE_URL must not share the same database role ("${appUser}"). Runtime requests must connect as a NOBYPASSRLS role.`,
    );
  }

  if (appUser === 'postgres' || appUser.includes('migrator')) {
    throw new SecurityConfigurationError(
      `Runtime database user "${appUser}" appears to be a privileged owner/migrator role. Use "nexstock_app_user" (NOBYPASSRLS).`,
    );
  }
}

/**
 * Queries pg_roles inside the active session/transaction to verify that the active database role
 * is neither a superuser nor configured with BYPASSRLS.
 */
export async function assertActiveRoleEnforcesRls(
  executor: Kysely<NexStockDatabase> | Transaction<NexStockDatabase>,
): Promise<DatabaseRoleSecurityStatus> {
  const result = await sql<{
    role_name: string;
    rolsuper: boolean;
    rolbypassrls: boolean;
  }>`
    SELECT
      current_user::text AS role_name,
      rolsuper,
      rolbypassrls
    FROM pg_roles
    WHERE rolname = current_user
  `.execute(executor);

  const row = result.rows[0];
  if (!row) {
    throw new SecurityConfigurationError(
      'Unable to inspect active PostgreSQL role in pg_roles.',
    );
  }

  if (row.rolsuper || row.rolbypassrls) {
    throw new SecurityConfigurationError(
      `CRITICAL RLS BYPASS DETECTED: Active database role "${row.role_name}" has rolsuper=${String(row.rolsuper)}, rolbypassrls=${String(row.rolbypassrls)}. Runtime queries must execute under a NOBYPASSRLS role.`,
    );
  }

  return {
    roleName: row.role_name,
    isSuperuser: row.rolsuper,
    bypassesRls: row.rolbypassrls,
  };
}

/**
 * Strips SQL line (`-- ...`) and block (`/* ... *\/`) comments so dialect inspection
 * only evaluates executable SQL tokens.
 */
function stripSqlComments(sqlText: string): string {
  return sqlText
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/--.*$/gm, '');
}

/**
 * Guard that prevents SQLite migration scripts (`PRAGMA`, `AUTOINCREMENT`, `STRICT` tables,
 * or `packages/sqlite-schema` edge tables) from ever being passed to the PostgreSQL / Supabase
 * migration runner.
 */
export function assertPostgresMigrationSqlCompatible(
  sqlText: string,
  sourceName = 'migration.sql',
): void {
  const executableSql = stripSqlComments(sqlText);

  if (/\bPRAGMA\s+[A-Za-z0-9_]+/i.test(executableSql)) {
    throw new SecurityConfigurationError(
      `SQLITE_MIGRATION_REJECTED: "${sourceName}" contains SQLite "PRAGMA" statements (e.g. PRAGMA journal_mode = WAL) which are invalid in PostgreSQL/Supabase. Keep SQLite migrations in packages/sqlite-schema and use apps/api/migrations for PostgreSQL.`,
    );
  }

  if (/\bAUTOINCREMENT\b/i.test(executableSql)) {
    throw new SecurityConfigurationError(
      `SQLITE_MIGRATION_REJECTED: "${sourceName}" contains SQLite "AUTOINCREMENT" syntax which is invalid in PostgreSQL.`,
    );
  }

  if (/\)\s*STRICT\s*;/i.test(executableSql)) {
    throw new SecurityConfigurationError(
      `SQLITE_MIGRATION_REJECTED: "${sourceName}" contains SQLite ") STRICT;" table modifiers which are invalid in PostgreSQL.`,
    );
  }

  if (/\b(local_device_metadata|local_sync_outbox|local_sync_watermarks|local_inventory_balances)\b/i.test(executableSql)) {
    throw new SecurityConfigurationError(
      `SQLITE_MIGRATION_REJECTED: "${sourceName}" defines local offline SQLite device tables and must not be executed against PostgreSQL/Supabase.`,
    );
  }
}

const currentDir = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(currentDir, '../../../../migrations');

export function loadFoundationMigrationSql(): string {
  const filename = '0001_shared_foundation_rls.sql';
  const sqlText = readFileSync(resolve(migrationsDir, filename), 'utf-8');
  assertPostgresMigrationSqlCompatible(sqlText, filename);
  return sqlText;
}

export function loadMilestone1MigrationSql(): string {
  const filename = '0002_milestone1_iam_org_sub_i18n.sql';
  const sqlText = readFileSync(resolve(migrationsDir, filename), 'utf-8');
  assertPostgresMigrationSqlCompatible(sqlText, filename);
  return sqlText;
}

export function getOrderedPostgresMigrations(): readonly PostgresMigrationSpec[] {
  return [
    {
      dialect: 'postgres',
      version: 1,
      name: '0001_shared_foundation_rls',
      filename: '0001_shared_foundation_rls.sql',
      sql: loadFoundationMigrationSql(),
    },
    {
      dialect: 'postgres',
      version: 2,
      name: '0002_milestone1_iam_org_sub_i18n',
      filename: '0002_milestone1_iam_org_sub_i18n.sql',
      sql: loadMilestone1MigrationSql(),
    },
  ];
}

export function loadAllMigrationSqls(): readonly string[] {
  return getOrderedPostgresMigrations().map((m) => m.sql);
}

/**
 * Validates dialect compatibility (`postgres` only, rejecting any SQLite `PRAGMA` / `STRICT` scripts)
 * and strict sequential migration ordering (`1, 2, ...`) before executing against PostgreSQL.
 */
export async function runPostgresMigrations(
  executor: PostgresMigrationRawExecutor,
  migrations: readonly PostgresMigrationSpec[] = getOrderedPostgresMigrations(),
): Promise<void> {
  if (migrations.length === 0) {
    throw new SecurityConfigurationError(
      'PostgreSQL migration list cannot be empty.',
    );
  }

  let expectedVersion = 1;
  for (const migration of migrations) {
    if ((migration as { dialect?: string }).dialect !== 'postgres') {
      throw new SecurityConfigurationError(
        `SQLITE_MIGRATION_REJECTED: Migration "${migration.filename}" has dialect="${String((migration as { dialect?: string }).dialect)}". Only dialect="postgres" migrations may be passed to runPostgresMigrations.`,
      );
    }

    if (migration.version !== expectedVersion) {
      throw new SecurityConfigurationError(
        `MIGRATION_ORDER_ERROR: Expected PostgreSQL migration version ${String(expectedVersion)}, but received version ${String(migration.version)} ("${migration.filename}"). Ensure 0001_shared_foundation_rls.sql runs before 0002_milestone1_iam_org_sub_i18n.sql.`,
      );
    }

    assertPostgresMigrationSqlCompatible(migration.sql, migration.filename);
    await executor.exec(migration.sql);
    expectedVersion++;
  }
}

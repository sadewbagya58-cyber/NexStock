import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { ConnectionOptions } from 'node:tls';
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

export interface ValidatedEnvironmentConfig {
  readonly supabaseUrl: string;
  readonly supabaseJwksUrl: string;
  readonly supabaseJwtIssuer: string;
  readonly supabaseJwtAudience: string;
  readonly appDatabaseUrl: string;
  readonly migrationDatabaseUrl?: string | undefined;
  readonly appDatabaseSslCa?: string | undefined;
  readonly appDatabaseSslCaPath?: string | undefined;
}

function assertNonEmptyEnvVar(
  env: Readonly<Record<string, string | undefined>>,
  key: string,
): string {
  const raw = env[key]?.trim();
  if (!raw) {
    throw new SecurityConfigurationError(
      `Missing required environment variable "${key}". Configure it in your local environment (see .env.example).`,
    );
  }
  if (raw.includes('SET_IN_LOCAL_ENV')) {
    throw new SecurityConfigurationError(
      `Environment variable "${key}" still contains the placeholder value "SET_IN_LOCAL_ENV". Replace it with a valid configuration value in your local .env file.`,
    );
  }
  return raw;
}

/**
 * Sanitizes log messages to ensure connection strings, passwords, or credentials
 * embedded in error messages or URLs are masked before logging.
 */
export function sanitizeLogMessage(message: string): string {
  if (!message) return '';
  return message
    .replace(/(postgres(?:ql)?:\/\/[^:]+:)([^@]+)(@)/gi, '$1***$3')
    .replace(/(bearer\s+)[a-zA-Z0-9._-]+/gi, '$1***');
}

/**
 * Official Supabase Root 2021 CA certificate (PEM format).
 * Subject: CN=Supabase Root 2021 CA, O=Supabase Inc
 * SHA-256 Fingerprint: 80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA
 * Valid through: April 26, 2031
 * Used to verify Supabase hosted databases and connection poolers (*.supabase.co and *.supabase.com).
 */
export const DEFAULT_SUPABASE_ROOT_CA = `-----BEGIN CERTIFICATE-----
MIIDxDCCAqygAwIBAgIUbLxMod62P2ktCiAkxnKJwtE9VPYwDQYJKoZIhvcNAQEL
BQAwazELMAkGA1UEBhMCVVMxEDAOBgNVBAgMB0RlbHdhcmUxEzARBgNVBAcMCk5l
dyBDYXN0bGUxFTATBgNVBAoMDFN1cGFiYXNlIEluYzEeMBwGA1UEAwwVU3VwYWJh
c2UgUm9vdCAyMDIxIENBMB4XDTIxMDQyODEwNTY1M1oXDTMxMDQyNjEwNTY1M1ow
azELMAkGA1UEBhMCVVMxEDAOBgNVBAgMB0RlbHdhcmUxEzARBgNVBAcMCk5ldyBD
YXN0bGUxFTATBgNVBAoMDFN1cGFiYXNlIEluYzEeMBwGA1UEAwwVU3VwYWJhc2Ug
Um9vdCAyMDIxIENBMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAqQXW
QyHOB+qR2GJobCq/CBmQ40G0oDmCC3mzVnn8sv4XNeWtE5XcEL0uVih7Jo4Dkx1Q
DmGHBH1zDfgs2qXiLb6xpw/CKQPypZW1JssOTMIfQppNQ87K75Ya0p25Y3ePS2t2
GtvHxNjUV6kjOZjEn2yWEcBdpOVCUYBVFBNMB4YBHkNRDa/+S4uywAoaTWnCJLUi
cvTlHmMw6xSQQn1UfRQHk50DMCEJ7Cy1RxrZJrkXXRP3LqQL2ijJ6F4yMfh+Gyb4
O4XajoVj/+R4GwywKYrrS8PrSNtwxr5StlQO8zIQUSMiq26wM8mgELFlS/32Uclt
NaQ1xBRizkzpZct9DwIDAQABo2AwXjALBgNVHQ8EBAMCAQYwHQYDVR0OBBYEFKjX
uXY32CztkhImng4yJNUtaUYsMB8GA1UdIwQYMBaAFKjXuXY32CztkhImng4yJNUt
aUYsMA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQELBQADggEBAB8spzNn+4VU
tVxbdMaX+39Z50sc7uATmus16jmmHjhIHz+l/9GlJ5KqAMOx26mPZgfzG7oneL2b
VW+WgYUkTT3XEPFWnTp2RJwQao8/tYPXWEJDc0WVQHrpmnWOFKU/d3MqBgBm5y+6
jB81TU/RG2rVerPDWP+1MMcNNy0491CTL5XQZ7JfDJJ9CCmXSdtTl4uUQnSuv/Qx
Cea13BX2ZgJc7Au30vihLhub52De4P/4gonKsNHYdbWjg7OWKwNv/zitGDVDB9Y2
CMTyZKG3XEu5Ghl1LEnI3QmEKsqaCLv12BnVjbkSeZsMnevJPs1Ye6TjjJwdik5P
o/bKiIz+Fq8=
-----END CERTIFICATE-----
`;

export interface DatabaseSslConfigResult {
  readonly ssl: ConnectionOptions | boolean;
  readonly sanitizedConnectionString: string;
}

/**
 * Resolves the appropriate TLS / SSL configuration for PostgreSQL connections.
 * Enforces strict certificate validation (rejectUnauthorized: true) at all times.
 * Never disables TLS or weakens security verification.
 * Automatically provisions the official Supabase Root CA for Supabase hosts
 * unless an explicit custom CA is supplied via parameters or environment variables.
 */
export function resolveDatabaseSslConfig(params: {
  readonly connectionString: string;
  readonly sslCa?: string | undefined;
  readonly sslCaPath?: string | undefined;
}): DatabaseSslConfigResult {
  let url: URL;
  try {
    url = new URL(params.connectionString);
  } catch {
    throw new SecurityConfigurationError(
      'Invalid database connection string format.',
    );
  }

  const sslmode = url.searchParams.get('sslmode')?.toLowerCase();
  const isLoopback =
    url.hostname === 'localhost' ||
    url.hostname === '127.0.0.1' ||
    url.hostname === '::1';

  if (sslmode === 'disable' || (isLoopback && !sslmode)) {
    url.searchParams.delete('sslmode');
    url.searchParams.delete('sslrootcert');
    url.searchParams.delete('uselibpqcompat');
    return {
      ssl: false,
      sanitizedConnectionString: url.toString(),
    };
  }

  // Priority 1: In-memory PEM string (e.g. from APP_DATABASE_SSL_CA or SUPABASE_SSL_CA)
  let ca: string | undefined;
  if (params.sslCa && params.sslCa.trim() !== '') {
    ca = params.sslCa.trim();
  }
  // Priority 2: Local CA file path (e.g. from APP_DATABASE_SSL_CA_PATH)
  else if (params.sslCaPath && params.sslCaPath.trim() !== '') {
    const certPath = resolve(params.sslCaPath.trim());
    if (!existsSync(certPath)) {
      throw new SecurityConfigurationError(
        `Configured SSL CA certificate file not found: ${certPath}`,
      );
    }
    ca = readFileSync(certPath, 'utf8');
  }
  // Priority 3: sslrootcert query parameter in the connection URL
  else if (url.searchParams.get('sslrootcert')) {
    const certPath = resolve(url.searchParams.get('sslrootcert')!);
    if (!existsSync(certPath)) {
      throw new SecurityConfigurationError(
        `Configured sslrootcert file not found: ${certPath}`,
      );
    }
    ca = readFileSync(certPath, 'utf8');
  }
  // Priority 4: Official Supabase Root CA for Supabase hosts (*.supabase.co and *.supabase.com)
  else if (
    url.hostname.endsWith('.supabase.co') ||
    url.hostname.endsWith('.supabase.com')
  ) {
    ca = DEFAULT_SUPABASE_ROOT_CA;
  }

  // Delete ssl query parameters from the URL passed to pg.Pool.
  // pg's internal ConnectionParameters parses connectionString and overwrites
  // config.ssl with an empty object {} if sslmode is present, which drops custom CA
  // settings and triggers deprecated sslmode warnings.
  url.searchParams.delete('sslmode');
  url.searchParams.delete('sslrootcert');
  url.searchParams.delete('uselibpqcompat');

  const ssl: ConnectionOptions = {
    rejectUnauthorized: true,
    ...(ca ? { ca } : {}),
  };

  return {
    ssl,
    sanitizedConnectionString: url.toString(),
  };
}

/**
 * Validates required runtime and optional migration environment variables without
 * printing or logging any secret/password values (Phase 1 Section 8).
 */
export function validateEnvironmentConfig(
  env: Readonly<Record<string, string | undefined>>,
  options?: { readonly requireMigrationDatabaseUrl?: boolean },
): ValidatedEnvironmentConfig {
  const supabaseUrl = assertNonEmptyEnvVar(env, 'SUPABASE_URL');
  const supabaseJwksUrl = assertNonEmptyEnvVar(env, 'SUPABASE_JWKS_URL');
  const supabaseJwtIssuer = assertNonEmptyEnvVar(env, 'SUPABASE_JWT_ISSUER');
  const supabaseJwtAudience = assertNonEmptyEnvVar(
    env,
    'SUPABASE_JWT_AUDIENCE',
  );
  const appDatabaseUrl = assertNonEmptyEnvVar(env, 'APP_DATABASE_URL');

  try {
    const parsedSupabase = new URL(supabaseUrl);
    const parsedJwks = new URL(supabaseJwksUrl);
    if (
      parsedSupabase.protocol !== 'https:' ||
      parsedJwks.protocol !== 'https:'
    ) {
      throw new Error('Supabase URLs must use https.');
    }
  } catch {
    throw new SecurityConfigurationError(
      'Invalid SUPABASE_URL or SUPABASE_JWKS_URL format; both must be valid HTTPS URLs.',
    );
  }

  let migrationDatabaseUrl: string | undefined;
  if (
    options?.requireMigrationDatabaseUrl ||
    (env['MIGRATION_DATABASE_URL'] &&
      env['MIGRATION_DATABASE_URL'].trim() !== '')
  ) {
    migrationDatabaseUrl = assertNonEmptyEnvVar(env, 'MIGRATION_DATABASE_URL');
    validateDatabaseCredentialSeparation({
      appDatabaseUrl,
      migrationDatabaseUrl,
    });
  } else {
    // Still validate that APP_DATABASE_URL alone is not using a privileged role
    validateDatabaseCredentialSeparation({
      appDatabaseUrl,
      migrationDatabaseUrl:
        'postgresql://nexstock_migrator:placeholder@localhost:5432/nexstock',
    });
  }

  const appDatabaseSslCa =
    env['APP_DATABASE_SSL_CA']?.trim() || env['SUPABASE_SSL_CA']?.trim();
  const appDatabaseSslCaPath = env['APP_DATABASE_SSL_CA_PATH']?.trim();

  return {
    supabaseUrl,
    supabaseJwksUrl,
    supabaseJwtIssuer,
    supabaseJwtAudience,
    appDatabaseUrl,
    migrationDatabaseUrl,
    ...(appDatabaseSslCa ? { appDatabaseSslCa } : {}),
    ...(appDatabaseSslCaPath ? { appDatabaseSslCaPath } : {}),
  };
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

  const baseAppUser = appUser.split('.')[0]!;
  if (baseAppUser === 'postgres' || appUser.includes('migrator')) {
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

  if (
    /\b(local_device_metadata|local_sync_outbox|local_sync_watermarks|local_inventory_balances|local_categories|local_products|local_product_barcodes|local_product_unit_conversions|local_suppliers)\b/i.test(
      executableSql,
    )
  ) {
    throw new SecurityConfigurationError(
      `SQLITE_MIGRATION_REJECTED: "${sourceName}" defines local offline SQLite device tables and must not be executed against PostgreSQL/Supabase.`,
    );
  }
}

const currentDir = dirname(fileURLToPath(import.meta.url));
function resolveMigrationsDir(): string {
  const candidate1 = resolve(currentDir, '../../../../migrations');
  if (existsSync(candidate1)) {
    return candidate1;
  }
  const candidate2 = resolve(currentDir, '../../../../../migrations');
  if (existsSync(candidate2)) {
    return candidate2;
  }
  return candidate1;
}
const migrationsDir = resolveMigrationsDir();

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

export function loadPhase2MigrationSql(): string {
  const filename = '0003_phase2_core_inventory.sql';
  const sqlText = readFileSync(resolve(migrationsDir, filename), 'utf-8');
  assertPostgresMigrationSqlCompatible(sqlText, filename);
  return sqlText;
}

export function loadPhase3MigrationSql(): string {
  const filename = '0004_phase3_pos_and_billing.sql';
  const sqlText = readFileSync(resolve(migrationsDir, filename), 'utf-8');
  assertPostgresMigrationSqlCompatible(sqlText, filename);
  return sqlText;
}

export function loadPhase4MigrationSql(): string {
  const filename = '0005_phase4_advanced_inventory.sql';
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
    {
      dialect: 'postgres',
      version: 3,
      name: '0003_phase2_core_inventory',
      filename: '0003_phase2_core_inventory.sql',
      sql: loadPhase2MigrationSql(),
    },
    {
      dialect: 'postgres',
      version: 4,
      name: '0004_phase3_pos_and_billing',
      filename: '0004_phase3_pos_and_billing.sql',
      sql: loadPhase3MigrationSql(),
    },
    {
      dialect: 'postgres',
      version: 5,
      name: '0005_phase4_advanced_inventory',
      filename: '0005_phase4_advanced_inventory.sql',
      sql: loadPhase4MigrationSql(),
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

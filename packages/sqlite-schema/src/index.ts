import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface SqliteMigrationSpec {
  readonly dialect: 'sqlite';
  readonly version: number;
  readonly name: string;
  readonly filename: string;
  readonly sql: string;
}

export interface SqliteDatabaseExecutor {
  exec(sql: string): unknown;
}

const currentDir = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(currentDir, '../migrations');

export function getCanonicalSqliteMigrations(): readonly SqliteMigrationSpec[] {
  const filename1 = '0001_local_sync_foundation.sql';
  const sql1 = readFileSync(resolve(migrationsDir, filename1), 'utf-8');
  const filename2 = '0002_local_catalog_and_inventory.sql';
  const sql2 = readFileSync(resolve(migrationsDir, filename2), 'utf-8');
  const filename3 = '0003_local_pos_and_billing.sql';
  const sql3 = readFileSync(resolve(migrationsDir, filename3), 'utf-8');
  return [
    {
      dialect: 'sqlite',
      version: 1,
      name: '0001_local_sync_foundation',
      filename: filename1,
      sql: sql1,
    },
    {
      dialect: 'sqlite',
      version: 2,
      name: '0002_local_catalog_and_inventory',
      filename: filename2,
      sql: sql2,
    },
    {
      dialect: 'sqlite',
      version: 3,
      name: '0003_local_pos_and_billing',
      filename: filename3,
      sql: sql3,
    },
  ];
}

/**
 * Initializes a local SQLite database connection (Tauri Desktop / Node SQLite test harness)
 * with required SQLite PRAGMAs (`journal_mode = WAL`, `foreign_keys = ON`) and applies
 * all canonical offline SQLite migrations in order.
 */
export function initializeLocalSqliteDatabase(
  db: SqliteDatabaseExecutor,
): readonly SqliteMigrationSpec[] {
  const migrations = getCanonicalSqliteMigrations();
  for (const migration of migrations) {
    db.exec(migration.sql);
  }
  return migrations;
}

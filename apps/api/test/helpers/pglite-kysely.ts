import { PGlite } from '@electric-sql/pglite';
import {
  CompiledQuery,
  type DatabaseConnection,
  type Driver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type QueryResult,
} from 'kysely';
import {
  type NexStockDatabase,
  runPostgresMigrations,
} from '../../src/index.js';

class PGliteKyselyConnection implements DatabaseConnection {
  private readonly pg: PGlite;

  constructor(pg: PGlite) {
    this.pg = pg;
  }

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
    throw new Error('Streaming is not used in PGlite test harness.');
  }
}

class PGliteKyselyDriver implements Driver {
  private readonly pg: PGlite;
  private readonly connection: PGliteKyselyConnection;

  constructor(pg: PGlite) {
    this.pg = pg;
    this.connection = new PGliteKyselyConnection(pg);
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

export interface TestPostgresHarness {
  readonly pg: PGlite;
  readonly db: Kysely<NexStockDatabase>;
}

/**
 * Creates a fresh embedded PostgreSQL 16 engine (PGlite) and applies all validated
 * PostgreSQL migrations (`0001_shared_foundation_rls.sql`, `0002_milestone1_iam_org_sub_i18n.sql`)
 * via `runPostgresMigrations`.
 */
export async function createTestPostgresHarness(): Promise<TestPostgresHarness> {
  const pg = new PGlite();

  // Execute validated PostgreSQL migrations in sequence as privileged migration owner
  await runPostgresMigrations(pg);

  const db = new Kysely<NexStockDatabase>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new PGliteKyselyDriver(pg),
      createIntrospector: (kyselyDb) => new PostgresIntrospector(kyselyDb),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });

  return { pg, db };
}

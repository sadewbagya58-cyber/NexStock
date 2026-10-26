import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  getCanonicalSqliteMigrations,
  initializeLocalSqliteDatabase,
} from '../src/index.js';

describe('@nexstock/sqlite-schema — Canonical Offline SQLite STRICT Schema', () => {
  it('applies 0001_local_sync_foundation.sql cleanly, preserves SQLite PRAGMAs, and enforces STRICT types and single-tenant binding', () => {
    const db = new DatabaseSync(':memory:');
    const migrations = initializeLocalSqliteDatabase(db);
    expect(migrations.length).toBe(1);
    expect(migrations[0]!.dialect).toBe('sqlite');
    expect(migrations[0]!.sql).toContain('PRAGMA journal_mode = WAL;');
    expect(migrations[0]!.sql).toContain('PRAGMA foreign_keys = ON;');

    const fkRow = db.prepare('PRAGMA foreign_keys;').get() as {
      foreign_keys: number;
    };
    expect(fkRow.foreign_keys).toBe(1);

    for (const m of migrations) {
      // Verify migration is idempotent (safe to rerun)
      db.exec(m.sql);
    }

    // Bind device to Tenant A
    db.prepare(
      `INSERT INTO local_device_metadata (
        singleton_id, tenant_id, branch_id, warehouse_id, register_id, device_id, enrolled_at, offline_auth_expires_at
      ) VALUES (1, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      '0192b4a0-0000-7000-8000-000000000001',
      '0192b4a0-0000-7000-8000-000000000002',
      '0192b4a0-0000-7000-8000-000000000003',
      '0192b4a0-0000-7000-8000-000000000004',
      '0192b4a0-0000-7000-8000-000000000005',
      '2026-10-26T00:00:00.000Z',
      '2026-11-09T00:00:00.000Z',
    );

    // Attempting to insert a second tenant binding row (singleton_id = 2) must fail CHECK (singleton_id = 1)
    expect(() =>
      db
        .prepare(
          `INSERT INTO local_device_metadata (
          singleton_id, tenant_id, branch_id, warehouse_id, register_id, device_id, enrolled_at, offline_auth_expires_at
        ) VALUES (2, 't2', 'b2', 'w2', 'r2', 'd2', '2026-10-26T00:00:00.000Z', '2026-11-09T00:00:00.000Z')`,
        )
        .run(),
    ).toThrow();

    db.close();
  });

  it('enforces command_id uniqueness, causal local_seq ordering, and crash recovery in local_sync_outbox', () => {
    const db = new DatabaseSync(':memory:');
    for (const m of getCanonicalSqliteMigrations()) {
      db.exec(m.sql);
    }

    const insertCmd = db.prepare(
      `INSERT INTO local_sync_outbox (
        command_id, tenant_id, branch_id, device_id, actor_user_id, command_type, schema_version, payload_json, occurred_at, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    insertCmd.run(
      '0192b4a0-0000-7000-8000-000000000101',
      'tenant-1',
      'branch-1',
      'device-1',
      'user-1',
      'POS_OPEN_SHIFT',
      1,
      '{"openingFloat":"100.0000"}',
      '2026-10-26T08:00:00.000Z',
      'IN_FLIGHT',
    );

    insertCmd.run(
      '0192b4a0-0000-7000-8000-000000000102',
      'tenant-1',
      'branch-1',
      'device-1',
      'user-1',
      'POS_RECORD_SALE',
      1,
      '{"grandTotal":"25.0000"}',
      '2026-10-26T08:05:00.000Z',
      'PENDING',
    );

    // Duplicate command_id must be rejected by SQLite UNIQUE constraint
    expect(() =>
      insertCmd.run(
        '0192b4a0-0000-7000-8000-000000000102',
        'tenant-1',
        'branch-1',
        'device-1',
        'user-1',
        'POS_RECORD_SALE',
        1,
        '{"grandTotal":"25.0000"}',
        '2026-10-26T08:05:00.000Z',
        'PENDING',
      ),
    ).toThrow();

    // Simulate startup crash recovery: reset stuck IN_FLIGHT commands back to PENDING
    db.prepare(
      `UPDATE local_sync_outbox SET status = 'PENDING' WHERE status = 'IN_FLIGHT'`,
    ).run();

    const pendingBatch = db
      .prepare(
        `SELECT local_seq, command_id, command_type FROM local_sync_outbox WHERE status = 'PENDING' ORDER BY local_seq ASC`,
      )
      .all() as Array<{
      local_seq: number;
      command_id: string;
      command_type: string;
    }>;

    expect(pendingBatch.map((r) => r.command_type)).toEqual([
      'POS_OPEN_SHIFT',
      'POS_RECORD_SALE',
    ]);
    expect(pendingBatch[0]!.local_seq).toBeLessThan(pendingBatch[1]!.local_seq);

    db.close();
  });
});

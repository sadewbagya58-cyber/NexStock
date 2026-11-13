use rusqlite::Connection;
use std::path::PathBuf;
use std::sync::Mutex;

pub struct DesktopDbState {
    pub db_path: PathBuf,
    pub conn: Mutex<Connection>,
}

struct EmbeddedMigration {
    version: i64,
    name: &'static str,
    sql: &'static str,
}

const CANONICAL_MIGRATIONS: &[EmbeddedMigration] = &[
    EmbeddedMigration {
        version: 1,
        name: "0001_local_sync_foundation",
        sql: include_str!("../../../../packages/sqlite-schema/migrations/0001_local_sync_foundation.sql"),
    },
    EmbeddedMigration {
        version: 2,
        name: "0002_local_catalog_and_inventory",
        sql: include_str!("../../../../packages/sqlite-schema/migrations/0002_local_catalog_and_inventory.sql"),
    },
    EmbeddedMigration {
        version: 3,
        name: "0003_local_pos_and_billing",
        sql: include_str!("../../../../packages/sqlite-schema/migrations/0003_local_pos_and_billing.sql"),
    },
    EmbeddedMigration {
        version: 4,
        name: "0004_local_advanced_inventory",
        sql: include_str!("../../../../packages/sqlite-schema/migrations/0004_local_advanced_inventory.sql"),
    },
    EmbeddedMigration {
        version: 5,
        name: "0005_local_uom_and_variable_products",
        sql: include_str!("../../../../packages/sqlite-schema/migrations/0005_local_uom_and_variable_products.sql"),
    },
    EmbeddedMigration {
        version: 6,
        name: "0006_local_branch_pricing",
        sql: include_str!("../../../../packages/sqlite-schema/migrations/0006_local_branch_pricing.sql"),
    },
    EmbeddedMigration {
        version: 7,
        name: "0007_local_batch_pricing_and_barcodes",
        sql: include_str!("../../../../packages/sqlite-schema/migrations/0007_local_batch_pricing_and_barcodes.sql"),
    },
];

pub fn open_and_migrate(db_path: PathBuf) -> Result<DesktopDbState, String> {
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Failed creating app data dir: {e}"))?;
    }

    let conn = Connection::open(&db_path).map_err(|e| format!("Failed opening SQLite DB: {e}"))?;
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;\nPRAGMA foreign_keys = ON;\nPRAGMA busy_timeout = 5000;",
    )
    .map_err(|e| format!("Failed configuring SQLite PRAGMAs: {e}"))?;

    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS nexstock_schema_migrations (\n  version INTEGER PRIMARY KEY,\n  name TEXT NOT NULL,\n  applied_at TEXT NOT NULL\n) STRICT;",
    )
    .map_err(|e| format!("Failed creating schema_migrations table: {e}"))?;

    for migration in CANONICAL_MIGRATIONS {
        conn.execute_batch(migration.sql)
            .map_err(|e| format!("Failed applying migration {}: {e}", migration.name))?;
        conn.execute(
            "INSERT OR REPLACE INTO nexstock_schema_migrations (version, name, applied_at) VALUES (?1, ?2, datetime('now'))",
            rusqlite::params![migration.version, migration.name],
        )
        .map_err(|e| format!("Failed recording migration {}: {e}", migration.name))?;
    }

    Ok(DesktopDbState {
        db_path,
        conn: Mutex::new(conn),
    })
}

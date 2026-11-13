pub mod commands;
pub mod db;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let app_data_dir = app
                .path()
                .app_data_dir()
                .map_err(|e| format!("Cannot resolve app data dir: {e}"))?;
            let db_path = app_data_dir.join("nexstock-offline.sqlite3");
            let db_state = db::open_and_migrate(db_path)?;
            app.manage(db_state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::desktop_get_status,
            commands::desktop_save_sync_snapshot,
            commands::desktop_resolve_barcode,
            commands::desktop_queue_offline_sale,
            commands::desktop_queue_print_job,
            commands::desktop_flush_sync_outbox,
        ])
        .run(tauri::generate_context!())
        .expect("error while running NexStock Tauri desktop runtime");
}

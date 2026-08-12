mod vault;
mod vault_meta;
mod watcher;

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(watcher::WatcherState::default())
        .invoke_handler(tauri::generate_handler![
            greet,
            vault::scan_vault,
            vault::read_note,
            vault::write_note,
            vault::create_note,
            vault::delete_note,
            vault::duplicate_note,
            vault::copy_note,
            vault::move_note,
            vault_meta::load_vault_meta,
            vault_meta::save_vault_meta,
            watcher::start_vault_watch,
            watcher::stop_vault_watch,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

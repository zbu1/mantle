mod credentials;
mod logging;
mod notes_crypto;
mod vault;
mod vault_meta;
mod watcher;

use tauri::{Manager, RunEvent};
use tauri_plugin_log::{RotationStrategy, Target, TargetKind};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .targets([
                    Target::new(TargetKind::Stdout),
                    Target::new(TargetKind::LogDir {
                        file_name: Some("mantle".into()),
                    }),
                ])
                .max_file_size(5_000_000)
                .rotation_strategy(RotationStrategy::KeepOne)
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(watcher::WatcherState::default())
        .manage(credentials::SessionKeys::default())
        .invoke_handler(tauri::generate_handler![
            vault::scan_vault,
            vault::read_note,
            vault::write_note,
            vault::create_note,
            vault::create_folder,
            vault::delete_note,
            vault::delete_folder,
            vault::rename_note,
            vault::rename_folder,
            vault::duplicate_note,
            vault::copy_note,
            vault::move_note,
            vault::move_folder,
            vault_meta::load_vault_meta,
            vault_meta::save_vault_meta,
            credentials::list_credential_profiles,
            credentials::create_credential_profile,
            credentials::unlock_credential_profile,
            credentials::lock_credential_profile,
            credentials::lock_all_credential_profiles,
            credentials::rename_credential_profile,
            credentials::change_credential_profile_password,
            credentials::delete_credential_profile,
            notes_crypto::encrypt_note_to_profile,
            notes_crypto::decrypt_note_to_plaintext,
            notes_crypto::move_note_to_profile,
            notes_crypto::create_encrypted_note,
            watcher::start_vault_watch,
            watcher::stop_vault_watch,
        ])
        // Built rather than `.run(...)` directly so we get a `RunEvent` hook:
        // managed state is not reliably dropped on exit, so unlocked master
        // keys have to be wiped explicitly rather than relying on Drop.
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if matches!(event, RunEvent::Exit) {
                let _ = app.state::<credentials::SessionKeys>().lock_all();
            }
        });
}

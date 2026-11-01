mod attachments;
mod credentials;
mod export;
mod history;
mod hidden;
mod links;
mod migrate;
mod logging;
mod notes_crypto;
mod rotation;
mod spelling;
mod tags;
mod typst_render;
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
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(watcher::WatcherState::default())
        .manage(credentials::SessionKeys::default())
        .register_asynchronous_uri_scheme_protocol("mantle", attachments::protocol)
        .invoke_handler(tauri::generate_handler![
            spelling::spelling_suggestions,
            spelling::spell_check,
            spelling::add_to_dictionary,
            typst_render::render_typst,
            vault::scan_vault,
            vault::create_vault,
            vault::move_vault,
            vault::list_folders,
            vault::read_note,
            vault::write_note,
            vault::set_note_favorite,
            vault::set_note_style,
            vault::create_note,
            vault::create_folder,
            vault::delete_note,
            vault::delete_folder,
            vault::restore_from_trash,
            vault::open_vault_file,
            vault::rename_note,
            vault::rename_folder,
            vault::duplicate_note,
            vault::copy_note,
            vault::move_note,
            vault::move_folder,
            history::list_snapshots,
            history::read_snapshot,
            history::close_snapshot,
            history::list_deleted_notes,
            history::restore_deleted_note,
            history::prune_history,
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
            credentials::create_recovery_key,
            credentials::recover_credential_profile,
            rotation::rotate_master_key,
            credentials::undo_create_credential_profile,
            credentials::redo_create_credential_profile,
            hidden::set_profile_hiding,
            hidden::hiding_clashes,
            hidden::note_disk_path,
            notes_crypto::encrypt_note_to_profile,
            notes_crypto::decrypt_note_to_plaintext,
            notes_crypto::move_note_to_profile,
            notes_crypto::create_encrypted_note,
            notes_crypto::convert_markdown_notes,
            export::convert_to_markdown,
            export::export_vault,
            migrate::import_obsidian_vault,
            attachments::save_attachment,
            attachments::import_attachment,
            attachments::save_attachment_copy,
            attachments::attachment_info,
            attachments::unused_attachments,
            attachments::profile_attachments,
            attachments::delete_attachments,
            tags::rename_tag,
            tags::remove_tag,
            tags::set_note_tags,
            links::rewrite_links,
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

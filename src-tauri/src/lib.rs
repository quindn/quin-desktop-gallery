mod ai;
mod browser;
mod commands;
mod db;
mod duplicates;
mod editor;
mod fs_sandbox;
mod lan;
mod metadata;
mod online;
mod paths;
mod scanner;
mod startup;
mod state;
mod thumbnails;
mod tools;
mod transcode;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager, WindowEvent};

use state::AppState;
use thumbnails::queue::ThumbnailQueue;

/// Bounded concurrency per MEDIA_PIPELINE.md §5: thumbnails (mostly
/// in-process image decode) get a larger pool than metadata probing
/// (spawns an FFprobe subprocess per job, heavier).
fn worker_count(divisor: usize, cap: usize) -> usize {
    let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
    (cores / divisor).clamp(1, cap)
}

/// A release build has no console attached (`windows_subsystem = "windows"` in main.rs), so an
/// unhandled panic anywhere — including inside Tauri's own setup, which turns a failed `.setup()`
/// into a hard `panic!`, see `db::open_with_repair`'s doc comment for why that path itself is now
/// avoided — would otherwise just make the app vanish with nothing to go on. This appends every
/// panic to a small log next to the data folder instead, so a crash is at least diagnosable.
fn install_panic_hook() {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let stamp = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
        let line = format!("[{stamp}] {info}\n");
        let path = paths::data_dir().join("crash.log");
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
            use std::io::Write;
            let _ = f.write_all(line.as_bytes());
        }
        default_hook(info);
    }));
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    install_panic_hook();
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            // The main window is created here (not from the config alone) so its web data
            // lives in the data folder like everything else.
            if let Some(cfg) = app.config().app.windows.first().cloned() {
                tauri::WebviewWindowBuilder::from_config(app.handle(), &cfg)?.data_directory(paths::webview_dir()).build()?;
            }
            // FFmpeg / FFprobe / yt-dlp are inside this exe; unpack them in the background.
            tools::init();
            browser::startup_cleanup();
            let app_local_data_dir = startup::resolve_data_dir(app)?;
            std::fs::create_dir_all(&app_local_data_dir)?;
            startup::mark_running(&app_local_data_dir);
            startup::cleanup_abandoned_temp_files(app_local_data_dir.clone());

            // tauri.conf.json's static assetProtocol scope only covers
            // $APPLOCALDATA/{thumbcache,playcache} — the *standard* OS
            // app-data path. Since resolve_data_dir() can now point
            // somewhere else entirely (the portable exe-relative `data/`
            // folder), the webview would otherwise be denied access to
            // every thumbnail/playback file it serves: they'd 404 against
            // the scope check even though they exist on disk. Grant scope
            // for wherever the cache dirs actually ended up, dynamically,
            // the same way an opened root's own directory is granted in
            // commands/root.rs.
            let thumbcache_dir = app_local_data_dir.join("thumbcache");
            let playcache_dir = app_local_data_dir.join("playcache");
            std::fs::create_dir_all(&thumbcache_dir)?;
            std::fs::create_dir_all(&playcache_dir)?;
            app.asset_protocol_scope().allow_directory(&thumbcache_dir, true)?;
            app.asset_protocol_scope().allow_directory(&playcache_dir, true)?;

            let app_db = db::app::open_app_db(&app_local_data_dir)?;

            let thumbnail_queue = ThumbnailQueue::start(app.handle().clone(), worker_count(1, 4));
            // The fast header-probe pass is cheap (mostly I/O + a small
            // header parse) and no longer shares a pool with the slow
            // deep-scan pass (see metadata::queue's doc comment), so it
            // can run with real parallelism instead of the old cap of 4.
            let metadata_queue =
                metadata::queue::MetadataQueue::start(app.handle().clone(), worker_count(1, 6));

            app.manage(AppState {
                app_db,
                app_local_data_dir,
                current: std::sync::Mutex::new(None),
                thumbnail_queue,
                metadata_queue,
                edit_jobs: Default::default(),
                lan: std::sync::Mutex::new(None),
            });

            // Closing the window hides it to the tray instead of quitting —
            // the actual close/quit handler is registered below via
            // `.on_window_event`, this just builds the tray icon + menu it
            // needs to be reachable again afterward.
            let show_item = MenuItem::with_id(app, "show", "Show Quin Gallery", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let tray_menu = Menu::with_items(app, &[&show_item, &quit_item])?;

            TrayIconBuilder::new()
                .icon(app.default_window_icon().cloned().expect("bundled window icon"))
                .tooltip("Quin Gallery")
                .menu(&tray_menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            // Lock again on the way back in, in case the hide-time signal was missed.
                            let _ = w.emit("app://lock", ());
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                        let app = tray.app_handle();
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.emit("app://lock", ());
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::lock::verify_password,
            commands::lock::lock_status,
            commands::lock::set_password,
            commands::browser::browser_open,
            commands::browser::browser_tabs,
            commands::browser::browser_restore_session,
            commands::browser::browser_navigate,
            commands::browser::browser_action,
            commands::browser::browser_close,
            commands::browser::browser_activate,
            commands::browser::browser_hide_all,
            commands::browser::browser_show_active,
            commands::browser::browser_set_bounds,
            commands::browser::browser_reorder,
            commands::browser::browser_pin,
            commands::browser::browser_duplicate,
            commands::browser::browser_reopen,
            commands::browser::browser_zoom,
            commands::browser::browser_devtools,
            commands::browser::browser_print,
            commands::browser::browser_find,
            commands::browser::browser_find_clear,
            commands::browser::browser_bookmarks,
            commands::browser::browser_bookmark_toggle,
            commands::browser::browser_is_bookmarked,
            commands::browser::browser_bookmark_remove,
            commands::browser::browser_bookmark_rename,
            commands::browser::browser_history,
            commands::browser::browser_history_remove,
            commands::browser::browser_history_clear,
            commands::browser::browser_suggest,
            commands::browser::browser_settings,
            commands::browser::browser_settings_set,
            commands::browser::browser_sniffed,
            commands::browser::browser_clear_sniffed,
            commands::browser::browser_media_items,
            commands::browser::browser_media_config,
            commands::browser::browser_media_cmd,
            commands::browser::browser_media_action,
            commands::browser::browser_popup,
            commands::browser::browser_popup_notice,
            commands::browser::browser_popup_task,
            commands::browser::browser_media_debug,
            commands::browser::browser_profiles,
            commands::browser::browser_profile_create,
            commands::browser::browser_profile_rename,
            commands::browser::browser_profile_delete,
            commands::browser::browser_profile_clear,
            commands::browser::app_quit,
            commands::browser::browser_extensions,
            commands::browser::browser_extension_toggle,
            commands::browser::browser_extension_remove,
            commands::browser::browser_extension_install,
            commands::browser::browser_extension_install_folder,
            commands::browser::browser_reload_engines,
            commands::browser::browser_media_debug,
            commands::online::online_prepare,
            commands::online::online_forget,
            commands::online::default_download_dir,
            commands::online::download_start,
            commands::online::download_list,
            commands::online::download_cancel,
            commands::online::download_remove,
            commands::online::download_clear_finished,
            commands::online::download_reveal,
            commands::online::engine_info,
            commands::online::engine_update,
            commands::online::pick_download_folder,
            commands::root::get_startup_info,
            commands::root::open_root,
            commands::root::pick_root_folder,
            commands::root::remove_recent_root,
            commands::root::rescan_root,
            commands::root::scan_new_folders,
            commands::root::restart_app,
            commands::root::open_in_explorer,
            commands::media::get_media_page,
            commands::media::get_folders,
            commands::media::get_media_position,
            commands::media::get_media_position_first,
            commands::media::search_suggest,
            commands::media::set_favorite,
            commands::media::set_rating,
            commands::media::get_library_stats,
            commands::media::get_dashboard_stats,
            commands::media::get_pending_counts,
            commands::media::get_thumbnail_path,
            commands::media::get_thumbnail_paths,
            commands::media::retry_metadata,
            commands::media::retry_thumbnail,
            commands::actions::get_media_file_path,
            commands::actions::get_media_stream_url,
            commands::actions::get_playback_position,
            commands::actions::set_playback_position,
            commands::files_out::start_file_drag,
            commands::files_out::copy_files_to_clipboard,
            commands::ai::ai_status,
            commands::ai::ai_install,
            commands::ai::ai_source_info,
            commands::ai::ai_enhance,
            commands::studio::studio_list,
            commands::studio::studio_load,
            commands::studio::studio_save,
            commands::studio::studio_delete,
            commands::studio::studio_file_info,
            commands::studio::studio_export,
            commands::studio::studio_pick_files,
            commands::studio::studio_stream_url,
            commands::actions::get_media_file_paths,
            commands::actions::delete_media,
            commands::actions::rename_media,
            commands::actions::set_favorite_batch,
            commands::playback::prepare_video_playback,
            commands::settings::get_cache_stats,
            commands::settings::clear_thumbnail_cache,
            commands::settings::clear_playback_cache,
            commands::tags::list_all_tags,
            commands::tags::list_tags_for_media,
            commands::tags::add_tag,
            commands::tags::remove_tag,
            commands::duplicates::find_duplicates,
            commands::editor::start_edit_job,
            commands::editor::cancel_edit_job,
            commands::editor::extract_frame,
            commands::editor::extract_audio,
            commands::editor::editor_source_info,
            commands::editor::editor_filmstrip,
            commands::lan::list_lan_interfaces,
            commands::lan::start_lan_server,
            commands::lan::stop_lan_server,
            commands::lan::get_lan_status,
            commands::lan::get_lan_qr_code,
        ])
        .on_window_event(|window, event| {
            // Hide-to-tray: the window's own close button (and the custom
            // title bar's Close, which calls the same JS close() API)
            // requests a close, which we intercept and turn into a hide.
            // The tray menu's "Quit" is the only way to actually exit.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                // Hidden = locked: whoever brings the window back must enter the password.
                let _ = window.emit("app://lock", ());
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // Quit for real: close the browser pages first so the engine writes cookies and logins to the profile folders.
            if let tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit = event {
                browser::shutdown(app);
            }
            if let tauri::RunEvent::Exit = event {
                // leave the databases compact and say this was a proper quit
                if let Some(state) = app.try_state::<AppState>() {
                    if let Some(ctx) = state.current.lock().unwrap().as_ref() {
                        db::checkpoint(&ctx.pool);
                    }
                    db::checkpoint(&state.app_db);
                    startup::mark_clean_exit(&state.app_local_data_dir);
                }
            }
        });
}

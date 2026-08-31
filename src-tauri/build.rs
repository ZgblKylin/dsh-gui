fn main() {
    // Declare the app's custom commands so tauri-build autogenerates their
    // ACL permissions (`allow-<command>` in snake_case). Without them a
    // non-local page (a tab webview loading the harness or a remote dsh
    // server) cannot invoke the bridge commands: the IPC layer rejects it as
    // "not allowed by ACL". Textual list: keep in sync with
    // `generate_handler!` in `src/main.rs`.
    let manifest = tauri_build::AppManifest::new().commands(&[
        "minimize_window",
        "toggle_maximize_window",
        "is_window_maximized",
        "close_window",
        "start_window_drag",
        "show_window_menu",
        "show_config_menu",
        "harness_url",
        "about_info",
        "local_update_projects",
        "cached_update_status",
        "remote_call",
        "check_updates",
        "start_update",
        "update_root",
        "update_changelog",
        "shell_log",
        // Dialog windows + shell↔dialog bridge (see `src/dialogs.rs`).
        "open_dialog",
        "close_dialog",
        "fit_dialog",
        "show_dialog",
        "connection_added",
        "ai_update_request",
        "dialog_event",
        // Connection-tab child webviews + page bridge (see `src/views.rs`).
        "view_create",
        "view_set_bounds",
        "view_set_visible",
        "view_close",
        "view_eval",
        "page_theme",
        "ai_update_result",
    ]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest))
        .expect("tauri_build failed");
    // tauri-build does not re-emit assets when `frontendDist` content
    // changes (only the config file is tracked), so a stale embedded
    // `ui/` would survive an incremental build. Track the directory.
    println!("cargo:rerun-if-changed=ui");
}

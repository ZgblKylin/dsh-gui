fn main() {
    // Declare the app's custom commands so tauri-build autogenerates their
    // ACL permissions (`allow-<command>` in snake_case). Without them a
    // remote-origin page (the loopback wrapper, see `wrapper.rs`) cannot
    // invoke any custom command: the IPC layer rejects it as
    // "not allowed by ACL". Textual list: keep in sync with
    // `generate_handler!` in `src/main.rs`.
    let manifest = tauri_build::AppManifest::new().commands(&[
        "minimize_window",
        "toggle_maximize_window",
        "is_window_maximized",
        "close_window",
        "start_window_drag",
        "show_window_menu",
        "harness_url",
        "about_info",
        "local_update_projects",
        "remote_call",
        "check_updates",
        "start_update",
        "update_root",
        "update_changelog",
        "shell_log",
    ]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest))
        .expect("tauri_build failed");
    // tauri-build does not re-emit assets when `frontendDist` content
    // changes (only the config file is tracked), so a stale embedded
    // `ui/` would survive an incremental build. Track the directory.
    println!("cargo:rerun-if-changed=ui");
}

//! Dialog-size persistence: remembers each native dialog window's last
//! user-adjusted size in `<root>/.dsh/gui/dialog-sizes.json`, so a reopened
//! dialog keeps the geometry the user chose instead of snapping back to a
//! compiled-in default.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

const SIZES_FILE: &str = "dialog-sizes.json";

/// Persisted size map: dialog kind -> `(width, height)` in logical pixels.
#[derive(Serialize, Deserialize, Default)]
pub struct DialogSizes(pub HashMap<String, (f64, f64)>);

fn sizes_path(root: &Path) -> PathBuf {
    root.join(".dsh").join("gui").join(SIZES_FILE)
}

/// Load the persisted dialog sizes. A missing or corrupt file silently
/// yields the empty map (every dialog falls back to its compiled default).
pub fn load(root: &Path) -> DialogSizes {
    let text = fs::read_to_string(sizes_path(root)).unwrap_or_default();
    serde_json::from_str(&text).unwrap_or_default()
}

/// Persist one dialog's size. The write is best-effort: a failure is
/// swallowed so a read-only checkout never breaks the dialog flow.
pub fn save(root: &Path, kind: &str, width: f64, height: f64) {
    let mut sizes = load(root);
    sizes.0.insert(kind.to_string(), (width, height));
    let path = sizes_path(root);
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_string_pretty(&sizes) {
        let _ = fs::write(path, json);
    }
}

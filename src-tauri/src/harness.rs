//! Resolve the `dsh` CLI the shell launches.
//!
//! `harness.json` at the repository root selects the runtime, and environment
//! variables override it (`scripts/harness-runtime.mjs` implements the same
//! contract for the build CLI, the plugin installer, and `scripts/harness.mjs`;
//! the two must agree on the file, the variable names, and the resolved paths).
//!
//! * `npm` — `@deepseek-ai/dsh@<version>` installed into `<root>/.harness/`.
//!   Nothing under `deepseek-harness/` is compiled; the pinned submodule
//!   supplies the version (`apps/cli/package.json`).
//! * `source` — the built `deepseek-harness` submodule at
//!   `deepseek-harness/apps/cli/lib/bin.js`.
//!
//! Overrides: `DSH_HARNESS_RUNTIME` (`npm` | `source`), `DSH_HARNESS_VERSION`,
//! `DSH_HARNESS_INSTALL_DIR` (relative to the repository root, or absolute),
//! `DSH_HARNESS_BIN` (a `bin.js` path; highest precedence, the runtime still
//! decides the working directory).

use std::path::{Path, PathBuf};

use serde_json::Value;

/// Repository-root manifest that selects the runtime.
pub const CONFIG_FILE: &str = "harness.json";
/// The published dsh CLI package.
pub const NPM_PACKAGE: &str = "@deepseek-ai/dsh";
/// Source-mode submodule directory, relative to the repository root.
pub const SUBMODULE_DIR: &str = "deepseek-harness";
/// npm-mode install directory, relative to the repository root.
pub const INSTALL_DIR: &str = ".harness";

/// Which dsh runtime the repository is configured for.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Runtime {
    /// Registry-installed CLI; the submodule is not compiled.
    Npm,
    /// CLI built from the pinned submodule.
    Source,
}

/// The resolved CLI, its working directory, and the version it was selected by.
#[derive(Clone, Debug)]
pub struct HarnessRuntime {
    /// Configured runtime.
    pub runtime: Runtime,
    /// Exact version for the npm runtime, or a pinned version in source mode.
    pub version: Option<String>,
    /// Absolute path to the CLI entry (`lib/bin.js`).
    pub bin: PathBuf,
    /// Working directory the CLI is spawned with.
    pub cwd: PathBuf,
}

impl HarnessRuntime {
    /// The remedy for a missing CLI, matching what the build CLI installs.
    /// @returns a human-readable hint naming the install step.
    pub fn missing_hint(&self) -> String {
        match self.runtime {
            Runtime::Npm => {
                let version = self.version.as_deref().unwrap_or("<version>");
                format!(
                    "run `npm run setup` to install {NPM_PACKAGE}@{version} into {}",
                    self.cwd.display()
                )
            }
            Runtime::Source => {
                "run `npm run setup` to build the deepseek-harness submodule".to_string()
            }
        }
    }
}

/// Read an environment override; blank values behave as unset.
fn env_override(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// Read the repository manifest. A missing file keeps the source runtime, so a
/// checkout that predates the manifest still launches the local build.
fn read_config(root: &Path) -> Result<(Runtime, Option<String>), String> {
    let path = root.join(CONFIG_FILE);
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok((Runtime::Source, None))
        }
        Err(error) => return Err(format!("cannot read {}: {error}", path.display())),
    };
    let value: Value =
        serde_json::from_str(&text).map_err(|e| format!("{CONFIG_FILE} is not valid JSON: {e}"))?;
    let runtime = match value.get("runtime").and_then(Value::as_str) {
        None | Some("source") => Runtime::Source,
        Some("npm") => Runtime::Npm,
        Some(other) => {
            return Err(format!(
                "{CONFIG_FILE}: \"runtime\" must be \"npm\" or \"source\" (got {other:?})"
            ))
        }
    };
    let version = match value.get("version") {
        None | Some(Value::Null) => None,
        Some(Value::String(text)) if !text.trim().is_empty() => Some(text.trim().to_string()),
        Some(other) => {
            return Err(format!(
                "{CONFIG_FILE}: \"version\" must be a non-empty string or null (got {other})"
            ))
        }
    };
    Ok((runtime, version))
}

/// The dsh version the pinned submodule records.
///
/// Read from `apps/cli/package.json`: the release contract gives the repository
/// root manifest, `apps/cli`, and every published package of the `dsh` family
/// one version, and the submodule is pinned to a release tag.
/// @param root - repository root.
/// @returns the version, or `None` when the submodule is unavailable.
pub fn submodule_version(root: &Path) -> Option<String> {
    let manifest = root
        .join(SUBMODULE_DIR)
        .join("apps")
        .join("cli")
        .join("package.json");
    let text = std::fs::read_to_string(manifest).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    value
        .get("version")
        .and_then(Value::as_str)
        .filter(|version| !version.is_empty())
        .map(str::to_string)
}

/// Resolve the runtime the shell should launch.
///
/// Configuration errors (malformed manifest, unknown runtime, npm runtime
/// without a resolvable version) fail loud; a missing CLI binary does not — the
/// caller reports [`HarnessRuntime::missing_hint`] with launch context.
/// @param root - repository root.
/// @returns the resolved runtime.
pub fn resolve(root: &Path) -> Result<HarnessRuntime, String> {
    let (file_runtime, file_version) = read_config(root)?;
    let runtime = match env_override("DSH_HARNESS_RUNTIME").as_deref() {
        None => file_runtime,
        Some("npm") => Runtime::Npm,
        Some("source") => Runtime::Source,
        Some(other) => {
            return Err(format!(
                "DSH_HARNESS_RUNTIME must be \"npm\" or \"source\" (got {other:?})"
            ))
        }
    };
    let install_dir = match env_override("DSH_HARNESS_INSTALL_DIR") {
        Some(value) => {
            let path = Path::new(&value);
            if path.is_absolute() {
                path.to_path_buf()
            } else {
                root.join(path)
            }
        }
        None => root.join(INSTALL_DIR),
    };
    let configured = env_override("DSH_HARNESS_VERSION").or(file_version);

    let (version, bin, cwd) = match runtime {
        Runtime::Npm => {
            let version = match configured {
                Some(version) => version,
                None => submodule_version(root).ok_or_else(|| {
                    format!(
                        "{CONFIG_FILE} selects the npm runtime without a version, and \
                         {SUBMODULE_DIR}/apps/cli/package.json is unavailable. Pin \"version\" in \
                         {CONFIG_FILE}, set DSH_HARNESS_VERSION, or initialize the submodule."
                    )
                })?,
            };
            let bin = install_dir
                .join("node_modules")
                .join("@deepseek-ai")
                .join("dsh")
                .join("lib")
                .join("bin.js");
            (Some(version), bin, install_dir)
        }
        Runtime::Source => {
            let submodule = root.join(SUBMODULE_DIR);
            let bin = submodule
                .join("apps")
                .join("cli")
                .join("lib")
                .join("bin.js");
            (configured, bin, submodule)
        }
    };
    let bin = match env_override("DSH_HARNESS_BIN") {
        Some(value) => PathBuf::from(value),
        None => bin,
    };
    Ok(HarnessRuntime {
        runtime,
        version,
        bin,
        cwd,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A unique empty directory per test, removed first when left over.
    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("dsh-gui-harness-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create scratch dir");
        dir
    }

    fn write_config(root: &Path, text: &str) {
        std::fs::write(root.join(CONFIG_FILE), text).expect("write config");
    }

    fn write_submodule_version(root: &Path, version: &str) {
        let dir = root.join(SUBMODULE_DIR).join("apps").join("cli");
        std::fs::create_dir_all(&dir).expect("create submodule dir");
        std::fs::write(
            dir.join("package.json"),
            format!("{{\"name\":\"@deepseek-ai/dsh\",\"version\":\"{version}\"}}"),
        )
        .expect("write submodule manifest");
    }

    #[test]
    fn missing_config_selects_the_source_runtime() {
        let root = scratch("no-config");
        let runtime = resolve(&root).expect("resolve");
        assert_eq!(runtime.runtime, Runtime::Source);
        assert!(runtime.bin.ends_with("deepseek-harness/apps/cli/lib/bin.js"));
        assert_eq!(runtime.cwd, root.join(SUBMODULE_DIR));
    }

    #[test]
    fn npm_config_derives_the_version_from_the_submodule() {
        let root = scratch("npm-derived");
        write_config(&root, "{\"runtime\":\"npm\",\"version\":null}");
        write_submodule_version(&root, "0.1.5-rc.2");
        let runtime = resolve(&root).expect("resolve");
        assert_eq!(runtime.runtime, Runtime::Npm);
        assert_eq!(runtime.version.as_deref(), Some("0.1.5-rc.2"));
        assert_eq!(runtime.cwd, root.join(INSTALL_DIR));
        assert!(runtime
            .bin
            .ends_with(".harness/node_modules/@deepseek-ai/dsh/lib/bin.js"));
    }

    #[test]
    fn npm_config_pins_an_explicit_version_without_the_submodule() {
        let root = scratch("npm-pinned");
        write_config(&root, "{\"runtime\":\"npm\",\"version\":\"9.9.9\"}");
        let runtime = resolve(&root).expect("resolve");
        assert_eq!(runtime.version.as_deref(), Some("9.9.9"));
    }

    #[test]
    fn npm_without_a_version_or_submodule_fails_loud() {
        let root = scratch("npm-unversioned");
        write_config(&root, "{\"runtime\":\"npm\"}");
        let error = resolve(&root).expect_err("resolve must fail");
        assert!(error.contains("without a version"), "{error}");
    }

    #[test]
    fn an_unknown_runtime_is_rejected() {
        let root = scratch("bad-runtime");
        write_config(&root, "{\"runtime\":\"pnpm\"}");
        let error = resolve(&root).expect_err("resolve must fail");
        assert!(error.contains("\"runtime\""), "{error}");
    }

    #[test]
    fn a_malformed_config_is_rejected() {
        let root = scratch("bad-json");
        write_config(&root, "{");
        let error = resolve(&root).expect_err("resolve must fail");
        assert!(error.contains("not valid JSON"), "{error}");
    }

    #[test]
    fn this_repository_resolves_a_launchable_runtime() {
        // CARGO_MANIFEST_DIR is <repo>/src-tauri, so its parent is the root the
        // shell walks to at runtime.
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("repository root");
        let runtime = resolve(root).expect("the checked-in harness.json must resolve");
        assert!(runtime.bin.is_absolute(), "{:?}", runtime.bin);
        assert!(runtime.cwd.is_absolute(), "{:?}", runtime.cwd);
        assert!(runtime.bin.starts_with(root), "{:?}", runtime.bin);
        match runtime.runtime {
            Runtime::Npm => {
                assert_eq!(runtime.version.as_deref(), submodule_version(root).as_deref());
                assert!(runtime
                    .bin
                    .ends_with(".harness/node_modules/@deepseek-ai/dsh/lib/bin.js"));
            }
            Runtime::Source => assert!(runtime.bin.ends_with("apps/cli/lib/bin.js")),
        }
    }
}

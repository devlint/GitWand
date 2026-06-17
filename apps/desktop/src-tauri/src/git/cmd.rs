use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

// ─── Transparent command log ──────────────────────────────────
// A bounded ring buffer (cap = 200) records every git write-command
// that GitWand runs on behalf of the user.  The frontend can fetch it
// via the `get_command_log` Tauri command and display it in the
// Command Log panel (⌘⇧L).

/// One entry in the transparent command log.
#[derive(serde::Serialize, Clone)]
pub(crate) struct CmdLogEntry {
    pub id:          u64,
    pub label:       String,   // human-readable "git push origin HEAD"
    pub cwd:         String,
    pub duration_ms: u64,
    pub exit_code:   i32,      // 0 = success, -1 = could not be determined
    pub timestamp_ms: u64,     // Unix epoch in milliseconds
}

const CMD_LOG_CAP: usize = 200;
static CMD_LOG: OnceLock<Mutex<VecDeque<CmdLogEntry>>> = OnceLock::new();
static CMD_LOG_CTR: AtomicU64 = AtomicU64::new(0);

/// Append one entry to the ring buffer (oldest entry evicted when full).
pub(crate) fn record_cmd(label: &str, cwd: &str, duration_ms: u64, exit_code: i32) {
    let log = CMD_LOG.get_or_init(|| Mutex::new(VecDeque::with_capacity(CMD_LOG_CAP + 1)));
    let id = CMD_LOG_CTR.fetch_add(1, Ordering::Relaxed);
    let timestamp_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let mut buf = log.lock().unwrap();
    if buf.len() >= CMD_LOG_CAP {
        buf.pop_front();
    }
    buf.push_back(CmdLogEntry { id, label: label.to_string(), cwd: cwd.to_string(),
                                duration_ms, exit_code, timestamp_ms });
}

/// Returns a snapshot (newest first) of the ring buffer.
pub(crate) fn cmd_log_snapshot() -> Vec<CmdLogEntry> {
    let log = CMD_LOG.get_or_init(|| Mutex::new(VecDeque::with_capacity(CMD_LOG_CAP + 1)));
    log.lock().unwrap().iter().cloned().rev().collect()
}

// Windows-only: `creation_flags` is an inherent method added by the
// `CommandExt` trait. Without this `use`, `cmd.creation_flags(...)` at
// `hidden_cmd` below would fail to compile on Windows, defeating the
// CREATE_NO_WINDOW flag and causing visible console windows to flash
// for every spawned subprocess (see issue #6).
//
// This `use` was historically at the top of `lib.rs`. The §3.4 split
// moved `hidden_cmd` into this module but the trait import didn't
// follow — re-imported here so it's collocated with the call site.
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

/// Ensure `rel_path`, resolved under `cwd`, stays inside the canonical `cwd`.
///
/// Rejects empty paths, absolute `rel_path` that would escape the root,
/// and any resolution that lands outside `cwd` (defense against `..` traversal
/// and symlink escapes).
pub(crate) fn safe_repo_path(cwd: &str, rel_path: &str) -> Result<PathBuf, String> {
    if cwd.trim().is_empty() {
        return Err("cwd must not be empty".to_string());
    }
    if rel_path.trim().is_empty() {
        return Err("path must not be empty".to_string());
    }

    let cwd_path = Path::new(cwd);
    if !cwd_path.is_absolute() {
        return Err(format!("cwd must be absolute (got: {})", cwd));
    }

    let cwd_canonical = cwd_path
        .canonicalize()
        .map_err(|e| format!("cwd does not resolve: {}", e))?;

    let joined = cwd_canonical.join(rel_path);

    let resolved = match joined.canonicalize() {
        Ok(p) => p,
        Err(_) => {
            let parent = joined.parent().ok_or("path has no parent")?;
            let parent_canonical = parent
                .canonicalize()
                .map_err(|e| format!("parent path does not resolve: {}", e))?;
            let file_name = joined.file_name().ok_or("path has no file name")?;
            parent_canonical.join(file_name)
        }
    };

    if !resolved.starts_with(&cwd_canonical) {
        return Err(format!(
            "path escapes cwd (resolved: {}, cwd: {})",
            resolved.display(),
            cwd_canonical.display()
        ));
    }

    Ok(resolved)
}

pub(crate) static GIT_BINARY: OnceLock<Mutex<String>> = OnceLock::new();

pub(crate) fn git_binary() -> String {
    GIT_BINARY
        .get_or_init(|| Mutex::new("git".to_string()))
        .lock()
        .unwrap()
        .clone()
}

/// Environment variables an AppImage's `AppRun` rewrites to point at the
/// bundle's own libraries. Any external process we spawn (`curl`, `gh`,
/// `git`…) inherits them and then loads ABI-incompatible bundled libs — e.g.
/// the system `curl` crashing at TLS init and emitting an empty body, which
/// surfaced as the OAuth "Failed to parse device-code response: EOF" failure
/// in the released Linux AppImage (GitHub issue #48). We undo the pollution
/// for child processes so they pick up the *system* libraries.
const APPIMAGE_POLLUTED_VARS: &[&str] = &[
    "LD_LIBRARY_PATH",
    "LD_PRELOAD",
    "GTK_PATH",
    "GIO_MODULE_DIR",
    "GSETTINGS_SCHEMA_DIR",
    "GDK_PIXBUF_MODULE_FILE",
    "GDK_PIXBUF_MODULEDIR",
    "GST_PLUGIN_SYSTEM_PATH",
    "GST_PLUGIN_PATH",
    "QT_PLUGIN_PATH",
    "PYTHONPATH",
    "PYTHONHOME",
    "PERLLIB",
];

/// One fix to apply to a spawned child's environment.
#[derive(Debug, PartialEq, Eq)]
enum EnvFix {
    /// Restore the value `AppRun` saved (in `<VAR>_ORIG`) before overriding it.
    Restore(String),
    /// No saved original — drop the override so the system default applies.
    Remove,
}

/// Compute the environment fixes needed so a spawned process uses *system*
/// libraries instead of the AppImage's bundled ones.
///
/// `get` is the environment lookup (injected for testability). Returns no
/// fixes when not running inside an AppImage: on a normal install
/// `LD_LIBRARY_PATH` and friends may be set intentionally and must be left
/// untouched. AppImage's `AppRun` always exports `APPDIR`; `APPIMAGE` points at
/// the `.AppImage` file — either marks the bundled runtime.
fn appimage_env_fixes(get: &dyn Fn(&str) -> Option<String>) -> Vec<(&'static str, EnvFix)> {
    if get("APPDIR").is_none() && get("APPIMAGE").is_none() {
        return Vec::new();
    }
    let mut fixes = Vec::new();
    for &var in APPIMAGE_POLLUTED_VARS {
        match get(&format!("{var}_ORIG")) {
            Some(orig) => fixes.push((var, EnvFix::Restore(orig))),
            None if get(var).is_some() => fixes.push((var, EnvFix::Remove)),
            None => {}
        }
    }
    fixes
}

/// Builds a `Command` for any binary with CREATE_NO_WINDOW on Windows.
/// Prevents black CMD console windows from flashing when spawning child processes.
///
/// On macOS the app launched from Finder/Dock inherits a minimal PATH
/// (/usr/bin:/bin:/usr/sbin:/sbin) that does not include Homebrew.
/// We extend PATH with the common Homebrew prefixes so that tools like
/// `gh`, `git` (custom path), `claude`, `codex`, etc. are resolvable.
pub(crate) fn hidden_cmd(bin: &str) -> std::process::Command {
    let mut cmd = std::process::Command::new(bin);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(crate::types::CREATE_NO_WINDOW);
    #[cfg(target_os = "macos")]
    {
        let current_path = std::env::var("PATH").unwrap_or_default();
        let extras = ["/opt/homebrew/bin", "/opt/homebrew/sbin",
                      "/usr/local/bin", "/usr/local/sbin",
                      "/opt/local/bin"];
        let mut enriched = current_path.clone();
        for extra in extras {
            if !current_path.split(':').any(|p| p == extra) {
                enriched.push(':');
                enriched.push_str(extra);
            }
        }
        cmd.env("PATH", enriched);
    }
    // Undo AppImage library-path pollution so the spawned binary loads system
    // libs, not the bundle's. No-op unless we're running inside an AppImage
    // (gated by APPDIR/APPIMAGE), so it's safe to run on every platform. See
    // `appimage_env_fixes` — this is the fix for the Linux OAuth failure in
    // GitHub issue #48.
    let get_env = |k: &str| std::env::var(k).ok();
    for (var, fix) in appimage_env_fixes(&get_env) {
        match fix {
            EnvFix::Restore(value) => { cmd.env(var, value); }
            EnvFix::Remove         => { cmd.env_remove(var); }
        }
    }
    // Defensive: propagate auth tokens explicitly to every subprocess so
    // `gh` (and any other CLI that respects these env vars) bypasses the
    // macOS keychain helper, which hangs ≥30s when called from a signed
    // Tauri app due to per-binary ACL trust differences vs the user's
    // terminal. Shell-env preload in `shell_env.rs` populates `GH_TOKEN`
    // at app startup. `Command::new` already inherits the parent env
    // by default, but explicit propagation makes it survive any future
    // `env_clear()` or tokio-runtime peculiarity.
    if let Ok(tok) = std::env::var("GH_TOKEN") {
        cmd.env("GH_TOKEN", tok);
    }
    if let Ok(tok) = std::env::var("GITHUB_TOKEN") {
        cmd.env("GITHUB_TOKEN", tok);
    }
    cmd
}

/// Builds a `Command` for the configured Git binary (no console window on Windows).
pub(crate) fn git_cmd() -> std::process::Command {
    hidden_cmd(&git_binary())
}

/// Returns the list of files that differ between two revs (names only).
/// Shared between `commands::read::preview_merge` and the rebase preview in
/// `commands::ops::*`.
pub(crate) fn git_changed_files(git: &str, cwd: &str, base: &str, rev: &str) -> Result<Vec<String>, String> {
    let out = hidden_cmd(git)
        .args(["diff", "--name-only", base, rev])
        .current_dir(cwd)
        .output()
        .map_err(|e| format!("diff --name-only failed: {}", e))?;

    Ok(String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| l.to_string())
        .collect())
}

static GIT_DIR_CACHE: OnceLock<Mutex<HashMap<String, PathBuf>>> = OnceLock::new();

/// Resolve the `.git` directory for a given cwd, with caching (P2.3).
/// Handles worktrees (where `.git` is a file pointing elsewhere) via the
/// authoritative `git rev-parse --git-dir`.
pub(crate) fn resolve_git_dir(cwd: &str) -> Result<PathBuf, String> {
    let cache = GIT_DIR_CACHE.get_or_init(|| Mutex::new(HashMap::new()));

    if let Some(cached) = cache.lock().unwrap().get(cwd) {
        return Ok(cached.clone());
    }

    let out = git_cmd()
        .args(["rev-parse", "--git-dir"])
        .current_dir(cwd)
        .output()
        .map_err(|e| format!("rev-parse --git-dir failed: {}", e))?;
    if !out.status.success() {
        return Err(format!(
            "rev-parse --git-dir failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    let rel = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let path = if rel.starts_with('/') || (rel.len() > 2 && rel.chars().nth(1) == Some(':')) {
        PathBuf::from(&rel)
    } else {
        Path::new(cwd).join(&rel)
    };

    cache.lock().unwrap().insert(cwd.to_string(), path.clone());
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    /// Build an env-lookup closure backed by a fixed map (no global state).
    fn lookup<'a>(map: &'a HashMap<&'a str, &'a str>) -> impl Fn(&str) -> Option<String> + 'a {
        move |k: &str| map.get(k).map(|s| s.to_string())
    }

    #[test]
    fn appimage_env_fixes_left_alone_outside_appimage() {
        // No APPDIR/APPIMAGE → a legitimately-set LD_LIBRARY_PATH is untouched.
        let env: HashMap<&str, &str> = [("LD_LIBRARY_PATH", "/usr/lib/x86_64-linux-gnu")]
            .into_iter()
            .collect();
        assert!(appimage_env_fixes(&lookup(&env)).is_empty());
    }

    #[test]
    fn appimage_env_fixes_removes_polluted_var_without_orig() {
        // Inside an AppImage, a bundled LD_LIBRARY_PATH with no saved original
        // is dropped so the child falls back to the system default.
        let env: HashMap<&str, &str> =
            [("APPDIR", "/tmp/.mount_app"), ("LD_LIBRARY_PATH", "/tmp/.mount_app/usr/lib")]
                .into_iter()
                .collect();
        assert_eq!(
            appimage_env_fixes(&lookup(&env)),
            vec![("LD_LIBRARY_PATH", EnvFix::Remove)]
        );
    }

    #[test]
    fn appimage_env_fixes_restores_apprun_saved_original() {
        // AppRun stashes the pre-override value in <VAR>_ORIG; restore it.
        let env: HashMap<&str, &str> = [
            ("APPIMAGE", "/home/u/GitWand.AppImage"),
            ("LD_LIBRARY_PATH", "/tmp/.mount_app/usr/lib"),
            ("LD_LIBRARY_PATH_ORIG", "/usr/lib:/usr/local/lib"),
        ]
        .into_iter()
        .collect();
        assert_eq!(
            appimage_env_fixes(&lookup(&env)),
            vec![(
                "LD_LIBRARY_PATH",
                EnvFix::Restore("/usr/lib:/usr/local/lib".to_string())
            )]
        );
    }
}



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

/// Real-environment lookup for the AppImage fix computations. Passed as a
/// `&dyn Fn` so tests can inject a fixed map (see `lookup` in the test module)
/// instead of touching the process environment.
fn env_get(k: &str) -> Option<String> {
    std::env::var(k).ok()
}

/// Search-path variables AppImage's `AppRun` prepends with `$APPDIR/...`
/// entries. Distinct from `APPIMAGE_POLLUTED_VARS` (library loading): these
/// steer *which binary* an opener resolves (`PATH`) and *where* it looks up the
/// default-handler / mime association (`XDG_DATA_DIRS`, `XDG_CONFIG_DIRS`). Left
/// polluted, a spawned `xdg-open` can resolve a bundled helper or miss the
/// system browser association, then exit 0 without opening anything — the
/// silent failure in the released AppImage (GitHub issue #52, follow-up to #48).
///
/// `allow(dead_code)` off Linux: the only callers live in
/// `#[cfg(target_os = "linux")]` opener code, so this whole helper chain is
/// (legitimately) unused on the macOS/Windows release builds.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
const APPIMAGE_SEARCH_PATH_VARS: &[&str] = &["PATH", "XDG_DATA_DIRS", "XDG_CONFIG_DIRS"];

/// True when `entry` is `appdir` itself or lives beneath it.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn path_entry_under(entry: &str, appdir: &str) -> bool {
    entry == appdir || entry.starts_with(&format!("{appdir}/"))
}

/// Compute search-path fixes so a spawned opener resolves *system* binaries and
/// mime associations instead of the AppImage's bundled ones. For each variable
/// every `:`-separated entry under `$APPDIR` is dropped, host entries kept in
/// order. Returns the cleaned value to set; a variable is skipped when nothing
/// changed or when stripping would empty it (never hand a child an empty
/// `PATH`). No fixes outside an AppImage — `AppRun` always exports `APPDIR`.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn appimage_path_fixes(get: &dyn Fn(&str) -> Option<String>) -> Vec<(&'static str, String)> {
    let Some(appdir) = get("APPDIR").filter(|d| !d.is_empty()) else {
        return Vec::new();
    };
    let mut fixes = Vec::new();
    for &var in APPIMAGE_SEARCH_PATH_VARS {
        let Some(value) = get(var) else { continue };
        let cleaned = value
            .split(':')
            .filter(|e| !e.is_empty() && !path_entry_under(e, &appdir))
            .collect::<Vec<_>>()
            .join(":");
        if cleaned != value && !cleaned.is_empty() {
            fixes.push((var, cleaned));
        }
    }
    fixes
}

/// Apply AppImage search-path de-pollution to a command. No-op outside an
/// AppImage. Pairs with `hidden_cmd`'s library-path de-pollution; kept separate
/// and opt-in because we only want to override binary/mime resolution for the
/// URL openers (issue #52), not for every spawned process.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) fn sanitize_appimage_search_paths(cmd: &mut std::process::Command) {
    for (var, value) in appimage_path_fixes(&env_get) {
        cmd.env(var, value);
    }
}

/// Builds a `Command` for any binary with CREATE_NO_WINDOW on Windows.
/// Prevents black CMD console windows from flashing when spawning child processes.
///
/// On macOS the app launched from Finder/Dock inherits a minimal PATH
/// (/usr/bin:/bin:/usr/sbin:/sbin) that does not include Homebrew.
/// We extend PATH with the common Homebrew prefixes so that tools like
/// `gh`, `git` (custom path), `claude`, `codex`, etc. are resolvable.
/// Canonical macOS PATH enrichment, shared by every subprocess spawner so they
/// resolve tools from the same set of prefixes. The app launched from
/// Finder/Dock inherits a minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin) that
/// excludes Homebrew/MacPorts, so we append the common package-manager prefixes
/// not already present. Returns `None` when nothing needs adding.
///
/// Single source of truth for `hidden_cmd` (above) and the integrated terminal
/// (`commands::terminal`) — keep both on this helper so the prefix list can
/// never drift between them.
#[cfg(target_os = "macos")]
pub(crate) fn macos_enriched_path() -> Option<String> {
    let current_path = std::env::var("PATH").unwrap_or_default();
    let extras = ["/opt/homebrew/bin", "/opt/homebrew/sbin",
                  "/usr/local/bin", "/usr/local/sbin",
                  "/opt/local/bin"];
    let mut enriched = current_path.clone();
    let mut added = false;
    for extra in extras {
        if !current_path.split(':').any(|p| p == extra) {
            enriched.push(':');
            enriched.push_str(extra);
            added = true;
        }
    }
    if added { Some(enriched) } else { None }
}

pub(crate) fn hidden_cmd(bin: &str) -> std::process::Command {
    let mut cmd = std::process::Command::new(bin);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(crate::types::CREATE_NO_WINDOW);
    #[cfg(target_os = "macos")]
    if let Some(enriched) = macos_enriched_path() {
        cmd.env("PATH", enriched);
    }
    // Undo AppImage library-path pollution so the spawned binary loads system
    // libs, not the bundle's. No-op unless we're running inside an AppImage
    // (gated by APPDIR/APPIMAGE), so it's safe to run on every platform. See
    // `appimage_env_fixes` — this is the fix for the Linux OAuth failure in
    // GitHub issue #48.
    for (var, fix) in appimage_env_fixes(&env_get) {
        match fix {
            EnvFix::Restore(value) => { cmd.env(var, value); }
            EnvFix::Remove         => { cmd.env_remove(var); }
        }
    }
    // Defensive: propagate auth tokens explicitly to every subprocess so
    // `gh`/`glab` (and any other CLI that respects these env vars) bypasses
    // the macOS keychain helper, which hangs ≥30s when called from a signed
    // Tauri app due to per-binary ACL trust differences vs the user's
    // terminal. Shell-env preload in `shell_env.rs` populates `GH_TOKEN` and
    // `GITLAB_TOKEN` at app startup (#149 for the glab case — `glab auth
    // login --use-keyring` hits the same ACL mismatch as `gh`). `Command::new`
    // already inherits the parent env by default, but explicit propagation
    // makes it survive any future `env_clear()` or tokio-runtime peculiarity.
    if let Ok(tok) = std::env::var("GH_TOKEN") {
        cmd.env("GH_TOKEN", tok);
    }
    if let Ok(tok) = std::env::var("GITHUB_TOKEN") {
        cmd.env("GITHUB_TOKEN", tok);
    }
    if let Ok(tok) = std::env::var("GITLAB_TOKEN") {
        cmd.env("GITLAB_TOKEN", tok);
    }
    if let Ok(tok) = std::env::var("GITLAB_ACCESS_TOKEN") {
        cmd.env("GITLAB_ACCESS_TOKEN", tok);
    }
    cmd
}

/// Builds a `Command` for the configured Git binary (no console window on Windows).
pub(crate) fn git_cmd() -> std::process::Command {
    hidden_cmd(&git_binary())
}

/// Run `cmd` with a deadline, killing it if it doesn't finish in time.
///
/// Unlike `Command::output()`, this never blocks the caller for longer than
/// `timeout`: on expiry the child is killed and reaped, and `Err` is returned
/// with `ErrorKind::TimedOut`. Generalizes the deadline-poll pattern already
/// used by `try_open_linux` (`commands/ops.rs`).
///
/// stdin is forced to `Stdio::null()` so a child that unexpectedly reads
/// stdin (interactive auth re-prompt, pager, TTY probe) never hangs waiting
/// on input the caller has no way to supply.
pub(crate) fn output_with_timeout(
    mut cmd: std::process::Command,
    timeout: std::time::Duration,
) -> std::io::Result<std::process::Output> {
    use std::io::Read;
    use std::process::Stdio;
    use std::time::{Duration, Instant};

    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let mut child = cmd.spawn()?;
    let mut stdout_pipe = child.stdout.take().expect("stdout was piped");
    let mut stderr_pipe = child.stderr.take().expect("stderr was piped");

    let stdout_thread = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout_pipe.read_to_end(&mut buf);
        buf
    });
    let stderr_thread = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stderr_pipe.read_to_end(&mut buf);
        buf
    });

    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait()? {
            Some(status) => {
                let stdout = stdout_thread.join().unwrap_or_default();
                let stderr = stderr_thread.join().unwrap_or_default();
                return Ok(std::process::Output { status, stdout, stderr });
            }
            None if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait(); // reap — avoid a zombie
                // Do NOT join the reader threads here: a child that spawned a
                // grandchild holding the pipe open would never hit EOF, and
                // joining would defeat the entire point of the timeout. They
                // exit on their own at EOF; just drop the handles.
                return Err(std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    format!("timed out after {}s", timeout.as_secs()),
                ));
            }
            None => std::thread::sleep(Duration::from_millis(25)),
        }
    }
}

/// Resolve the repo's mainline branch name for commands that need a "main"
/// reference point (ahead/behind counts, "merged into main" checks, top-author
/// stats per branch). Shared by `commands::ops` and `commands::read` so the
/// fallback chain lives in exactly one place (#136).
///
/// Tried in order, each verified with `git rev-parse --verify <name>` before
/// being accepted:
/// 1. `configured` — the user's Settings > Git > Default Branch, if non-empty.
/// 2. The remote's default branch, via `origin/HEAD`'s symref (handles a
///    mainline like `develop`/`trunk` that isn't named `main`/`master` but
///    that the remote already points at).
/// 3. `main`, `master`, `origin/main`, `origin/master`.
/// 4. The current branch (`rev-parse --abbrev-ref HEAD`) — this always
///    resolves in a non-empty repo, so it replaces the old hardcoded `"main"`
///    literal that caused `fatal: failed to find 'main'` (#136) whenever none
///    of the above candidates existed.
pub(crate) fn resolve_default_branch(cwd: &str, configured: Option<&str>) -> String {
    let verify = |name: &str| -> bool {
        git_cmd()
            .args(["rev-parse", "--verify", name])
            .current_dir(cwd)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    };

    if let Some(name) = configured {
        let name = name.trim();
        if !name.is_empty() && verify(name) {
            return name.to_string();
        }
    }

    if let Ok(output) = git_cmd()
        .args(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])
        .current_dir(cwd)
        .output()
    {
        if output.status.success() {
            // e.g. "origin/main" -> "main"
            let short = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if let Some((_, name)) = short.split_once('/') {
                if !name.is_empty() && verify(name) {
                    return name.to_string();
                }
            }
        }
    }

    for name in ["main", "master", "origin/main", "origin/master"] {
        if verify(name) {
            return name.to_string();
        }
    }

    if let Ok(output) = git_cmd()
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(cwd)
        .output()
    {
        if output.status.success() {
            let name = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !name.is_empty() && name != "HEAD" {
                return name;
            }
        }
    }

    "main".to_string()
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

    // ── resolve_default_branch (#136) ──────────────────────────────────────

    mod resolve_default_branch_tests {
        use super::super::resolve_default_branch;
        use std::path::PathBuf;
        use std::process::Command;
        use std::sync::atomic::{AtomicU64, Ordering};

        static COUNTER: AtomicU64 = AtomicU64::new(0);

        struct TempRepo {
            path: PathBuf,
        }
        impl Drop for TempRepo {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.path);
            }
        }
        impl TempRepo {
            /// A fresh repo whose only branch is `trunk` — neither `main` nor
            /// `master` exist, and there is no remote.
            fn new_trunk() -> Self {
                let n = COUNTER.fetch_add(1, Ordering::SeqCst);
                let pid = std::process::id();
                let nanos = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos();
                let dir = std::env::temp_dir().join(format!(
                    "gitwand-resolve-default-branch-test-{}-{}-{}",
                    pid, n, nanos
                ));
                std::fs::create_dir_all(&dir).unwrap();
                let repo = TempRepo { path: dir };
                repo.git_ok(&["init", "-q", "-b", "trunk"]);
                repo.git_ok(&["config", "user.name", "Test"]);
                repo.git_ok(&["config", "user.email", "test@example.com"]);
                repo.git_ok(&["config", "commit.gpgsign", "false"]);
                repo.write("README.md", "hello\n");
                repo.git_ok(&["add", "-A"]);
                repo.git_ok(&["commit", "-q", "-m", "init"]);
                repo
            }
            fn cwd(&self) -> String {
                self.path.to_str().unwrap().to_string()
            }
            fn write(&self, rel: &str, content: &str) {
                std::fs::write(self.path.join(rel), content).unwrap();
            }
            fn git(&self, args: &[&str]) -> std::process::Output {
                Command::new(crate::git::cmd::git_binary())
                    .args(args)
                    .current_dir(&self.path)
                    .output()
                    .unwrap_or_else(|e| panic!("git {:?} spawn: {}", args, e))
            }
            fn git_ok(&self, args: &[&str]) {
                let out = self.git(args);
                assert!(
                    out.status.success(),
                    "git {:?} failed: {}",
                    args,
                    String::from_utf8_lossy(&out.stderr)
                );
            }
        }

        #[test]
        fn falls_back_to_current_branch_when_nothing_matches() {
            // No "main"/"master", no remote, no configured setting — must
            // resolve to the actual current branch ("trunk"), never the
            // hardcoded literal "main" (#136: this used to make the
            // subsequent `git branch --format=...%(ahead-behind:main)`
            // fail with "fatal: failed to find 'main'").
            let repo = TempRepo::new_trunk();
            assert_eq!(resolve_default_branch(&repo.cwd(), None), "trunk");
        }

        #[test]
        fn prefers_configured_branch_when_it_resolves() {
            // Even with "main" also present, an explicitly configured
            // default branch (Settings > Git > Default Branch) wins.
            let repo = TempRepo::new_trunk();
            repo.git_ok(&["branch", "main"]);
            assert_eq!(
                resolve_default_branch(&repo.cwd(), Some("trunk")),
                "trunk"
            );
        }

        #[test]
        fn ignores_configured_branch_that_does_not_exist() {
            // A stale/mistyped setting must not be trusted blindly — fall
            // through to the rest of the chain (here: current branch).
            let repo = TempRepo::new_trunk();
            assert_eq!(
                resolve_default_branch(&repo.cwd(), Some("does-not-exist")),
                "trunk"
            );
        }

        #[test]
        fn prefers_main_over_current_branch_when_main_exists() {
            // Baseline: unchanged behavior when "main" is a real branch and
            // nothing is explicitly configured.
            let repo = TempRepo::new_trunk();
            repo.git_ok(&["branch", "main"]);
            assert_eq!(resolve_default_branch(&repo.cwd(), None), "main");
        }

        #[test]
        fn empty_configured_string_is_treated_as_unset() {
            let repo = TempRepo::new_trunk();
            assert_eq!(resolve_default_branch(&repo.cwd(), Some("  ")), "trunk");
        }
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

    #[test]
    fn appimage_path_fixes_noop_outside_appimage() {
        // No APPDIR → a legitimately-set PATH is left untouched.
        let env: HashMap<&str, &str> = [("PATH", "/usr/bin:/bin")].into_iter().collect();
        assert!(appimage_path_fixes(&lookup(&env)).is_empty());
    }

    #[test]
    fn appimage_path_fixes_strips_appdir_entries() {
        // Inside an AppImage, $APPDIR entries are dropped so the opener resolves
        // system binaries and the system mime/browser association.
        let env: HashMap<&str, &str> = [
            ("APPDIR", "/tmp/.mount_app"),
            ("PATH", "/tmp/.mount_app/usr/bin:/usr/bin:/bin"),
            ("XDG_DATA_DIRS", "/tmp/.mount_app/usr/share:/usr/share"),
        ]
        .into_iter()
        .collect();
        assert_eq!(
            appimage_path_fixes(&lookup(&env)),
            vec![
                ("PATH", "/usr/bin:/bin".to_string()),
                ("XDG_DATA_DIRS", "/usr/share".to_string()),
            ]
        );
    }

    #[test]
    fn appimage_path_fixes_leaves_clean_path_alone() {
        // Inside an AppImage but a host-only PATH → nothing to strip.
        let env: HashMap<&str, &str> =
            [("APPDIR", "/tmp/.mount_app"), ("PATH", "/usr/bin:/bin")]
                .into_iter()
                .collect();
        assert!(appimage_path_fixes(&lookup(&env)).is_empty());
    }

    // ── output_with_timeout (#149) ─────────────────────────────────────────
    //
    // Real subprocesses per AGENTS.md § Testing — gated #[cfg(unix)] since
    // they rely on `sleep`, `false`, `head`, `/dev/zero` (CI's Rust matrix is
    // Linux/macOS, per .github/workflows/ci.yml).

    #[cfg(unix)]
    mod output_with_timeout_tests {
        use super::super::output_with_timeout;
        use std::io::ErrorKind;
        use std::process::Command;
        use std::time::{Duration, Instant};

        #[test]
        fn returns_output_for_a_fast_command() {
            let mut cmd = Command::new("echo");
            cmd.arg("hi");
            let out = output_with_timeout(cmd, Duration::from_secs(5)).unwrap();
            assert!(out.status.success());
            assert_eq!(out.stdout, b"hi\n");
        }

        #[test]
        fn kills_and_errors_when_the_command_exceeds_the_timeout() {
            let mut cmd = Command::new("sleep");
            cmd.arg("30");
            let start = Instant::now();
            let err = output_with_timeout(cmd, Duration::from_millis(300)).unwrap_err();
            // This is the actual regression assertion for #149: the call
            // returns promptly instead of blocking for the child's full
            // lifetime.
            assert!(start.elapsed() < Duration::from_secs(5));
            assert_eq!(err.kind(), ErrorKind::TimedOut);
            assert!(err.to_string().contains("timed out"));
        }

        #[test]
        fn captures_large_stdout_without_deadlocking() {
            // Guards the pipe-buffer deadlock: without dedicated drain
            // threads, a child writing more than the OS pipe buffer (~64 KB)
            // blocks on write() forever and this test hangs until the
            // timeout, then fails.
            let mut cmd = Command::new("head");
            cmd.args(["-c", "2000000", "/dev/zero"]);
            let out = output_with_timeout(cmd, Duration::from_secs(10)).unwrap();
            assert_eq!(out.stdout.len(), 2_000_000);
        }

        #[test]
        fn propagates_nonzero_exit_status() {
            let cmd = Command::new("false");
            let out = output_with_timeout(cmd, Duration::from_secs(5)).unwrap();
            assert!(!out.status.success());
        }

        #[test]
        fn spawn_failure_error_text_is_preserved() {
            let cmd = Command::new("gitwand-no-such-binary-149");
            let err = output_with_timeout(cmd, Duration::from_secs(5)).unwrap_err();
            assert!(
                err.kind() == ErrorKind::NotFound
                    || err.to_string().contains("No such file or directory"),
                "unexpected error: {}",
                err
            );
        }
    }

    #[test]
    fn appimage_path_fixes_never_empties_a_var() {
        // All entries under $APPDIR → skip rather than hand the child an empty
        // PATH (which would make it unable to resolve anything).
        let env: HashMap<&str, &str> = [
            ("APPDIR", "/tmp/.mount_app"),
            ("PATH", "/tmp/.mount_app/usr/bin:/tmp/.mount_app/bin"),
        ]
        .into_iter()
        .collect();
        assert!(appimage_path_fixes(&lookup(&env)).is_empty());
    }
}



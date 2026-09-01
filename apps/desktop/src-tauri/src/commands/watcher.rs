//! Live Repo filesystem watcher (v3.10.0).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::Duration;

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use tauri::ipc::Channel;

use crate::git::safe_repo_path;
use crate::types::RepoChangeEvent;

pub(crate) const EVENT_PATH_CAP: usize = 512;

/// Directory names whose contents are never interesting, at any depth.
const IGNORED_DIRS: [&str; 5] = ["node_modules", "target", "dist", ".venv", "__pycache__"];

/// Classify a repo-relative path into a change category, or `None` when the
/// path is pure noise that must never wake the UI.
pub(crate) fn classify_path(rel: &str) -> Option<&'static str> {
    let rel = rel.trim_start_matches("./");

    if let Some(inner) = rel.strip_prefix(".git/") {
        // Noise first: object churn, transient locks, reflogs.
        if inner.starts_with("objects/") || inner.starts_with("lfs/") || inner.ends_with(".lock") {
            return None;
        }
        // Stash lives under refs/ and logs/refs/, so it must be tested before
        // the generic refs rule below and before the logs/ ignore.
        if inner == "refs/stash" || inner == "logs/refs/stash" {
            return Some("stash");
        }
        if inner.starts_with("logs/") {
            return None;
        }
        if inner == "HEAD" {
            return Some("head");
        }
        if inner == "index" {
            return Some("index");
        }
        if inner == "config" {
            return Some("config");
        }
        if inner.starts_with("refs/") || inner == "packed-refs" {
            return Some("refs");
        }
        if matches!(
            inner,
            "MERGE_HEAD" | "REBASE_HEAD" | "CHERRY_PICK_HEAD" | "REVERT_HEAD" | "MERGE_MSG"
        ) || inner.starts_with("rebase-merge/")
            || inner.starts_with("rebase-apply/")
        {
            return Some("mergeState");
        }
        return None;
    }

    if rel.split('/').any(|seg| IGNORED_DIRS.contains(&seg)) {
        return None;
    }
    if rel.is_empty() {
        return None;
    }
    Some("worktree")
}

/// Turn a raw batch of repo-relative paths into one event, or `None` when
/// nothing in the batch is interesting. Paths and kinds are deduplicated and
/// sorted so the payload is deterministic (and so tests are stable).
pub(crate) fn coalesce(batch: &[String]) -> Option<RepoChangeEvent> {
    let mut kinds = std::collections::BTreeSet::<&'static str>::new();
    let mut paths = std::collections::BTreeSet::<String>::new();
    for p in batch {
        if let Some(kind) = classify_path(p) {
            kinds.insert(kind);
            paths.insert(p.clone());
        }
    }
    if kinds.is_empty() {
        return None;
    }
    let truncated = paths.len() > EVENT_PATH_CAP;
    Some(RepoChangeEvent {
        kinds: kinds.into_iter().map(str::to_string).collect(),
        paths: paths.into_iter().take(EVENT_PATH_CAP).collect(),
        truncated,
    })
}

/// Quiet window before a batch is flushed. Long enough to swallow the dozens of
/// events a single `git checkout` produces, short enough to feel instant.
const DEBOUNCE: Duration = Duration::from_millis(150);

struct RepoWatch {
    /// Dropping the watcher stops the OS-level subscription.
    _watcher: RecommendedWatcher,
    stop: Arc<AtomicBool>,
    subscriber_count: usize,
}

fn watches() -> &'static Mutex<HashMap<PathBuf, RepoWatch>> {
    static W: OnceLock<Mutex<HashMap<PathBuf, RepoWatch>>> = OnceLock::new();
    W.get_or_init(|| Mutex::new(HashMap::new()))
}

type Subscribers = HashMap<u64, (PathBuf, Channel<RepoChangeEvent>)>;

fn subscribers() -> &'static Mutex<Subscribers> {
    static S: OnceLock<Mutex<Subscribers>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(HashMap::new()))
}

fn lock_watches() -> std::sync::MutexGuard<'static, HashMap<PathBuf, RepoWatch>> {
    watches().lock().unwrap_or_else(|e| e.into_inner())
}

fn lock_subscribers() -> std::sync::MutexGuard<'static, Subscribers> {
    subscribers().lock().unwrap_or_else(|e| e.into_inner())
}

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

/// Fan an event out to every live subscriber of `root`.
fn broadcast(root: &PathBuf, event: &RepoChangeEvent) {
    let subs = lock_subscribers();
    for (path, chan) in subs.values() {
        if path == root {
            // A dead channel (window closed) just errors; the subscription is
            // reaped by watch_repo_stop or by the next app_handle teardown.
            let _ = chan.send(event.clone());
        }
    }
}

/// Start (or join) a watch on `cwd`. Returns a subscription id to pass to
/// `watch_repo_stop`. Calling this twice on the same repo creates two
/// independent subscriptions sharing a single OS watcher: this is the
/// extension point the v4.0 incremental code-graph indexer will use.
#[tauri::command]
pub(crate) fn watch_repo_start(
    cwd: String,
    on_change: Channel<RepoChangeEvent>,
) -> Result<u64, String> {
    let root = safe_repo_path(cwd.trim(), ".").map_err(|e| format!("invalid cwd: {e}"))?;
    if !root.is_dir() {
        return Err("cwd is not a directory".to_string());
    }

    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    lock_subscribers().insert(id, (root.clone(), on_change));

    let mut watches = lock_watches();
    if let Some(existing) = watches.get_mut(&root) {
        existing.subscriber_count += 1;
        return Ok(id);
    }

    let (tx, rx) = mpsc::channel::<notify::Result<notify::Event>>();
    let mut watcher = notify::recommended_watcher(move |res| {
        let _ = tx.send(res);
    })
    .map_err(|e| format!("failed to create watcher: {e}"))?;
    watcher
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|e| format!("failed to watch {}: {e}", root.display()))?;

    let stop = Arc::new(AtomicBool::new(false));
    let thread_root = root.clone();
    let thread_stop = stop.clone();
    std::thread::spawn(move || {
        let mut batch: Vec<String> = Vec::new();
        loop {
            if thread_stop.load(Ordering::Relaxed) {
                return;
            }
            match rx.recv_timeout(DEBOUNCE) {
                Ok(Ok(event)) => {
                    for p in event.paths {
                        if let Ok(rel) = p.strip_prefix(&thread_root) {
                            let rel = rel.to_string_lossy().replace('\\', "/");
                            if !rel.is_empty() {
                                batch.push(rel);
                            }
                        }
                    }
                }
                // A watcher error (e.g. inotify queue overflow) must not kill
                // the loop: force a "everything changed" event so the UI
                // resyncs, then keep going.
                Ok(Err(_)) => {
                    broadcast(
                        &thread_root,
                        &RepoChangeEvent {
                            kinds: vec!["worktree".to_string()],
                            paths: Vec::new(),
                            truncated: true,
                        },
                    );
                    batch.clear();
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    if !batch.is_empty() {
                        if let Some(ev) = coalesce(&batch) {
                            broadcast(&thread_root, &ev);
                        }
                        batch.clear();
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => return,
            }
        }
    });

    watches.insert(
        root,
        RepoWatch {
            _watcher: watcher,
            stop,
            subscriber_count: 1,
        },
    );
    Ok(id)
}

/// Drop a subscription. When the last subscriber for a repo leaves, the OS
/// watcher and its coalescing thread are torn down.
#[tauri::command]
pub(crate) fn watch_repo_stop(id: u64) -> Result<(), String> {
    let removed = lock_subscribers().remove(&id);
    let Some((root, _)) = removed else {
        return Ok(()); // idempotent: stopping an unknown id is not an error
    };
    let mut watches = lock_watches();
    if let Some(entry) = watches.get_mut(&root) {
        entry.subscriber_count = entry.subscriber_count.saturating_sub(1);
        if entry.subscriber_count == 0 {
            entry.stop.store(true, Ordering::Relaxed);
            watches.remove(&root); // drops the watcher, ends the thread
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_git_metadata_paths() {
        assert_eq!(classify_path(".git/HEAD"), Some("head"));
        assert_eq!(classify_path(".git/index"), Some("index"));
        assert_eq!(classify_path(".git/config"), Some("config"));
        assert_eq!(classify_path(".git/refs/heads/main"), Some("refs"));
        assert_eq!(classify_path(".git/packed-refs"), Some("refs"));
        assert_eq!(classify_path(".git/MERGE_HEAD"), Some("mergeState"));
        assert_eq!(classify_path(".git/rebase-merge/head-name"), Some("mergeState"));
    }

    #[test]
    fn stash_wins_over_the_generic_refs_rule() {
        assert_eq!(classify_path(".git/refs/stash"), Some("stash"));
        assert_eq!(classify_path(".git/logs/refs/stash"), Some("stash"));
    }

    #[test]
    fn ignores_object_churn_and_lockfiles() {
        assert_eq!(classify_path(".git/objects/ab/cdef0123"), None);
        assert_eq!(classify_path(".git/index.lock"), None);
        assert_eq!(classify_path(".git/refs/heads/main.lock"), None);
        assert_eq!(classify_path(".git/lfs/tmp/x"), None);
        assert_eq!(classify_path(".git/logs/HEAD"), None);
    }

    #[test]
    fn ignores_heavy_build_directories() {
        assert_eq!(classify_path("node_modules/vue/index.js"), None);
        assert_eq!(classify_path("apps/desktop/node_modules/x/y.js"), None);
        assert_eq!(classify_path("target/debug/build/foo"), None);
        assert_eq!(classify_path("dist/assets/index.js"), None);
        assert_eq!(classify_path("__pycache__/mod.cpython-312.pyc"), None);
    }

    #[test]
    fn treats_everything_else_as_worktree() {
        assert_eq!(classify_path("src/main.rs"), Some("worktree"));
        assert_eq!(classify_path("README.md"), Some("worktree"));
        // A file literally named ".gitignore" is worktree content, not metadata.
        assert_eq!(classify_path(".gitignore"), Some("worktree"));
    }

    #[test]
    fn coalesce_dedupes_and_sorts_kinds() {
        let batch = vec![
            "src/a.rs".to_string(),
            ".git/index".to_string(),
            "src/b.rs".to_string(),
            ".git/objects/aa/bb".to_string(),
        ];
        let ev = coalesce(&batch).expect("batch has interesting paths");
        assert_eq!(ev.kinds, vec!["index".to_string(), "worktree".to_string()]);
        assert_eq!(ev.paths, vec![".git/index".to_string(), "src/a.rs".to_string(), "src/b.rs".to_string()]);
        assert!(!ev.truncated);
    }

    #[test]
    fn coalesce_returns_none_when_every_path_is_noise() {
        let batch = vec![".git/objects/aa/bb".to_string(), "node_modules/x/y.js".to_string()];
        assert!(coalesce(&batch).is_none());
    }

    #[test]
    fn coalesce_caps_paths_and_flags_truncation() {
        let batch: Vec<String> = (0..EVENT_PATH_CAP + 10).map(|i| format!("src/f{i}.rs")).collect();
        let ev = coalesce(&batch).expect("worktree paths");
        assert_eq!(ev.paths.len(), EVENT_PATH_CAP);
        assert!(ev.truncated);
        assert_eq!(ev.kinds, vec!["worktree".to_string()]);
    }

    /// End-to-end over a real temp git repo: writing a file must produce a
    /// coalesced "worktree" event, and `git add` must produce an "index" one.
    #[test]
    fn watches_a_real_repo_and_reports_worktree_and_index_changes() {
        use std::process::Command;
        use std::sync::mpsc;

        let dir = std::env::temp_dir().join(format!("gw-watch-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let run = |args: &[&str]| {
            Command::new("git").args(args).current_dir(&dir).output().unwrap();
        };
        run(&["init", "-q"]);
        run(&["config", "user.email", "t@example.com"]);
        run(&["config", "user.name", "T"]);
        std::fs::write(dir.join("a.txt"), "one\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "-qm", "init"]);

        let root = std::fs::canonicalize(&dir).unwrap();
        let (tx, rx) = mpsc::channel::<notify::Result<notify::Event>>();
        let mut watcher = notify::recommended_watcher(move |res| { let _ = tx.send(res); }).unwrap();
        watcher.watch(&root, notify::RecursiveMode::Recursive).unwrap();

        std::fs::write(root.join("a.txt"), "two\n").unwrap();
        Command::new("git").args(["add", "a.txt"]).current_dir(&root).output().unwrap();

        // Drain for up to 3 s, then coalesce whatever arrived.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        let mut batch: Vec<String> = Vec::new();
        while std::time::Instant::now() < deadline {
            match rx.recv_timeout(std::time::Duration::from_millis(200)) {
                Ok(Ok(ev)) => {
                    for p in ev.paths {
                        if let Ok(rel) = p.strip_prefix(&root) {
                            let rel = rel.to_string_lossy().replace('\\', "/");
                            if !rel.is_empty() { batch.push(rel); }
                        }
                    }
                }
                _ => {
                    if batch.iter().any(|p| classify_path(p) == Some("index"))
                        && batch.iter().any(|p| classify_path(p) == Some("worktree"))
                    { break; }
                }
            }
        }

        let ev = coalesce(&batch).expect("expected at least one interesting path");
        assert!(ev.kinds.contains(&"worktree".to_string()), "kinds: {:?}", ev.kinds);
        assert!(ev.kinds.contains(&"index".to_string()), "kinds: {:?}", ev.kinds);
        assert!(ev.paths.iter().any(|p| p == "a.txt"), "paths: {:?}", ev.paths);
        // Object churn from `git add` must never surface.
        assert!(!ev.paths.iter().any(|p| p.starts_with(".git/objects/")), "paths: {:?}", ev.paths);

        drop(watcher);
        let _ = std::fs::remove_dir_all(&root);
    }
}

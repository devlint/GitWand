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

/// Normalize a path fragment for classification and for the event payload:
/// lossy UTF-8, forward slashes on every platform.
fn rel_str(rel: &std::path::Path) -> String {
    rel.to_string_lossy().replace('\\', "/")
}

/// Map an absolute filesystem path to the repo-relative form `classify_path`
/// understands, or `None` when it belongs to neither the worktree nor the
/// repo's metadata directories.
///
/// `git_dirs` carries the metadata directories that are *not* already covered
/// by the recursive worktree watch: a linked `git worktree` has `.git` as a
/// **file**, with HEAD/index/MERGE_HEAD living in
/// `<main>/.git/worktrees/<name>/` and refs/config in `<main>/.git/`, both
/// outside the worktree entirely. `--separate-git-dir` repos are the same
/// shape. Paths found there are renamed to `.git/<rest>` so one classifier
/// covers every repo layout, and so `head`/`index`/`refs`/`mergeState` events
/// are produced for a worktree instead of the watcher going silently
/// metadata-blind while still reporting itself healthy.
///
/// Metadata directories are tested first: in the ordinary layout `<root>/.git`
/// is *inside* the worktree, so worktree-first would classify every metadata
/// path as plain `worktree` content.
pub(crate) fn classify_abs_path(
    worktree: &std::path::Path,
    git_dirs: &[PathBuf],
    abs: &std::path::Path,
) -> Option<(String, &'static str)> {
    for dir in git_dirs {
        if let Ok(rel) = abs.strip_prefix(dir) {
            let rel = rel_str(rel);
            if rel.is_empty() {
                continue;
            }
            let mapped = format!(".git/{rel}");
            return classify_path(&mapped).map(|kind| (mapped, kind));
        }
    }
    let rel = rel_str(abs.strip_prefix(worktree).ok()?);
    if rel.is_empty() {
        return None;
    }
    classify_path(&rel).map(|kind| (rel, kind))
}

/// The metadata directories of `root` that a recursive watch on `root` does
/// **not** already cover. Empty for the ordinary layout (`<root>/.git` is a
/// real directory inside the worktree).
///
/// Resolved in-process through libgit2 rather than `git rev-parse --git-dir`:
/// no subprocess on the repo-open path, and `commondir()` gives the shared
/// directory a linked worktree keeps its refs in, which `--git-dir` alone
/// does not.
fn external_git_dirs(root: &std::path::Path) -> Vec<PathBuf> {
    let Ok(repo) = git2::Repository::open(root) else {
        return Vec::new();
    };
    let mut out: Vec<PathBuf> = Vec::new();
    // Order matters for `classify_abs_path`: the worktree's own git dir is
    // nested inside the common dir, and its HEAD/index must win over the
    // common dir's `worktrees/<name>/...` reading of the same path.
    for dir in [repo.path().to_path_buf(), repo.commondir().to_path_buf()] {
        let dir = std::fs::canonicalize(&dir).unwrap_or(dir);
        if dir.starts_with(root) || out.contains(&dir) {
            continue;
        }
        out.push(dir);
    }
    out
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
        closed: false,
    })
}

/// Quiet window before a batch is flushed. Long enough to swallow the dozens of
/// events a single `git checkout` produces, short enough to feel instant. This
/// window *resets* on every event, so on its own it never fires under
/// continuous churn (an install, a big checkout, a build writing to `dist/`);
/// `MAX_WAIT` below is the backstop for that case.
const DEBOUNCE: Duration = Duration::from_millis(150);

/// Hard ceiling on how long a batch can stay open, measured from its first
/// event, regardless of whether events keep resetting `DEBOUNCE`. Fixes
/// Finding 1: a continuous event stream faster than `DEBOUNCE` (package
/// installs, `cargo build`, a huge `git checkout`) used to reset the quiet
/// window forever and never flush.
const MAX_WAIT: Duration = Duration::from_millis(500);

/// Safety valve on the pre-coalesce staging batch. Without this, the same
/// continuous-churn scenario that motivates `MAX_WAIT` would otherwise grow
/// `Vec<String>` unbounded for as long as the storm lasts. Deliberately much
/// larger than `EVENT_PATH_CAP` (512): this bounds raw, non-deduplicated
/// input, not the final event payload.
const MAX_RAW_BATCH: usize = 4096;

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

/// One frontend subscription. `webview` is the label of the webview that
/// opened it, so every subscription a document left behind can be reaped when
/// that webview navigates or is destroyed, see `stop_all_for_webview`.
struct Subscription {
    root: PathBuf,
    webview: String,
    chan: Channel<RepoChangeEvent>,
}

type Subscribers = HashMap<u64, Subscription>;

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

/// Fan an event out to every live subscriber of `root`, reaping the ones whose
/// channel is gone.
///
/// A `Channel::send` bottoms out in `webview.eval(...)`, which fails once the
/// webview is destroyed (window closed without the frontend's `onUnmounted`
/// getting to run). Ignoring that error used to leave the subscription, and
/// the `subscriber_count` it holds, in place forever, so the count could
/// never fall back to 0 and both the `RecommendedWatcher` and its coalescing
/// thread leaked for the lifetime of the process, with every event still being
/// cloned into a channel nobody reads.
fn broadcast(root: &PathBuf, event: &RepoChangeEvent) {
    // Collect under the lock, reap after releasing it: `drop_subscription`
    // takes both this lock and WATCHES.
    let dead: Vec<u64> = {
        let subs = lock_subscribers();
        subs.iter()
            .filter(|(_, sub)| &sub.root == root)
            .filter(|(_, sub)| sub.chan.send(event.clone()).is_err())
            .map(|(id, _)| *id)
            .collect()
    };
    for id in dead {
        drop_subscription(id);
    }
}

/// Drive the debounce/coalesce state machine for one repo's raw `notify`
/// event stream, calling `emit` for each flushed batch. Extracted from
/// `ensure_watch` so it is testable with a plain `mpsc` channel and closure,
/// without a real OS watcher or a Tauri `Channel` (which cannot be
/// constructed outside a Tauri runtime).
///
/// Flush triggers, first one to fire wins:
/// - `DEBOUNCE` quiet window elapses (no new event) — the common bursty case.
/// - `MAX_WAIT` elapses since the batch's first event, even if events are
///   still arriving fast enough to keep resetting the quiet window (Finding 1).
/// - the raw staging batch hits `MAX_RAW_BATCH`, in which case the flush is
///   forced `truncated` regardless of `coalesce`'s own (post-dedup) cap.
fn spawn_coalescer<F>(
    root: PathBuf,
    git_dirs: Vec<PathBuf>,
    rx: mpsc::Receiver<notify::Result<notify::Event>>,
    stop: Arc<AtomicBool>,
    emit: F,
) where
    F: Fn(RepoChangeEvent) + Send + 'static,
{
    std::thread::spawn(move || {
        let mut batch: Vec<String> = Vec::new();
        let mut first_event_at: Option<std::time::Instant> = None;

        let flush = |batch: &mut Vec<String>, force_truncated: bool| {
            if batch.is_empty() {
                return;
            }
            if let Some(mut ev) = coalesce(&batch[..]) {
                if force_truncated {
                    ev.truncated = true;
                }
                emit(ev);
            }
            batch.clear();
        };

        loop {
            if stop.load(Ordering::Relaxed) {
                return;
            }

            if let Some(started) = first_event_at {
                if started.elapsed() >= MAX_WAIT {
                    flush(&mut batch, false);
                    first_event_at = None;
                }
            }

            let wait = match first_event_at {
                Some(started) => DEBOUNCE.min(MAX_WAIT.saturating_sub(started.elapsed())),
                None => DEBOUNCE,
            };

            match rx.recv_timeout(wait) {
                Ok(Ok(event)) => {
                    for p in event.paths {
                        // Classify at push time so noise (object churn,
                        // ignored build dirs) is never stored, not just
                        // discarded later at flush. `classify_abs_path` also
                        // maps a linked worktree's external metadata paths
                        // onto the `.git/<...>` names the classifier knows.
                        let Some((rel, _kind)) = classify_abs_path(&root, &git_dirs, &p) else {
                            continue;
                        };
                        if batch.is_empty() {
                            first_event_at = Some(std::time::Instant::now());
                        }
                        batch.push(rel);
                        if batch.len() >= MAX_RAW_BATCH {
                            flush(&mut batch, true);
                            first_event_at = None;
                        }
                    }
                }
                // A watcher error (e.g. inotify queue overflow) must not kill
                // the loop: force a "everything changed" event so the UI
                // resyncs, then keep going.
                Ok(Err(_)) => {
                    emit(RepoChangeEvent {
                        kinds: vec!["worktree".to_string()],
                        paths: Vec::new(),
                        truncated: true,
                        closed: false,
                    });
                    batch.clear();
                    first_event_at = None;
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    flush(&mut batch, false);
                    first_event_at = None;
                }
                // The raw-event channel only disconnects when the `notify`
                // watcher (and the sender closure it owns) is dropped. An
                // intentional `watch_repo_stop` teardown sets `stop` first
                // (see `watch_repo_stop`), so a Disconnected with `stop` still
                // false means the OS-level watch died on its own (deleted /
                // unmounted directory, fatal notify backend error). Emit a
                // terminal `closed` sentinel so subscribers stop trusting
                // `healthy`, then purge this repo's state so a future
                // `watch_repo_start` on the same root gets a fresh watcher
                // instead of silently joining a dead one.
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    if !stop.load(Ordering::Relaxed) {
                        emit(RepoChangeEvent {
                            kinds: Vec::new(),
                            paths: Vec::new(),
                            truncated: false,
                            closed: true,
                        });
                        lock_watches().remove(&root);
                        lock_subscribers().retain(|_, sub| sub.root != root);
                    }
                    return;
                }
            }
        }
    });
}

/// Ensure a live OS watch exists for `root`, joining an existing one or
/// creating a new watcher and its coalescing thread. Never touches
/// SUBSCRIBERS: `watch_repo_start` only registers a subscriber after this
/// returns `Ok(())`, so a failed watcher creation can never orphan a
/// subscriber entry that nothing can ever `watch_repo_stop` (Finding 3).
fn ensure_watch(root: &std::path::Path) -> Result<(), String> {
    let mut watches = lock_watches();
    if let Some(existing) = watches.get_mut(root) {
        existing.subscriber_count += 1;
        return Ok(());
    }

    let (tx, rx) = mpsc::channel::<notify::Result<notify::Event>>();
    let mut watcher = notify::recommended_watcher(move |res| {
        let _ = tx.send(res);
    })
    .map_err(|e| format!("failed to create watcher: {e}"))?;
    watcher
        .watch(root, RecursiveMode::Recursive)
        .map_err(|e| format!("failed to watch {}: {e}", root.display()))?;

    // A linked `git worktree` (or a `--separate-git-dir` repo) keeps its
    // metadata outside the worktree, so the recursive watch above sees no
    // HEAD, index, refs or merge-state writes at all. Watch those directories
    // too, otherwise the watcher reports itself healthy (demoting the poll to
    // 15 s) while being blind to every commit, branch switch and conflict
    // created outside GitWand: strictly worse than the pre-v3.10.0 2 s poll.
    let git_dirs = external_git_dirs(root);
    for dir in &git_dirs {
        watcher
            .watch(dir, RecursiveMode::Recursive)
            .map_err(|e| format!("failed to watch {}: {e}", dir.display()))?;
    }
    // Nothing to watch for metadata and no `.git` directory inside the
    // worktree either: we cannot honestly claim a healthy watch, and saying so
    // is what keeps the poller on its 2 s cadence.
    if git_dirs.is_empty() && !root.join(".git").is_dir() {
        return Err(format!(
            "cannot resolve the git metadata directory for {}",
            root.display()
        ));
    }

    let stop = Arc::new(AtomicBool::new(false));
    let thread_root = root.to_path_buf();
    let emit_root = thread_root.clone();
    spawn_coalescer(thread_root, git_dirs, rx, stop.clone(), move |ev| {
        broadcast(&emit_root, &ev);
    });

    watches.insert(
        root.to_path_buf(),
        RepoWatch {
            _watcher: watcher,
            stop,
            subscriber_count: 1,
        },
    );
    Ok(())
}

/// Start (or join) a watch on `cwd`. Returns a subscription id to pass to
/// `watch_repo_stop`. Calling this twice on the same repo creates two
/// independent subscriptions sharing a single OS watcher: this is the
/// extension point the v4.0 incremental code-graph indexer will use.
#[tauri::command]
pub(crate) fn watch_repo_start(
    webview: tauri::Webview,
    cwd: String,
    on_change: Channel<RepoChangeEvent>,
) -> Result<u64, String> {
    let root = safe_repo_path(cwd.trim(), ".").map_err(|e| format!("invalid cwd: {e}"))?;
    if !root.is_dir() {
        return Err("cwd is not a directory".to_string());
    }

    ensure_watch(&root)?;

    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    lock_subscribers().insert(
        id,
        Subscription {
            root,
            webview: webview.label().to_string(),
            chan: on_change,
        },
    );
    Ok(id)
}

/// Drop a subscription and release the watch reference it held. When the last
/// subscriber for a repo leaves, the OS watcher and its coalescing thread are
/// torn down. Shared by the `watch_repo_stop` command, the dead-channel
/// reaping in `broadcast`, and `stop_all_for_webview`.
fn drop_subscription(id: u64) {
    let removed = lock_subscribers().remove(&id);
    let Some(sub) = removed else {
        return; // idempotent: dropping an unknown id is not an error
    };
    let mut watches = lock_watches();
    if let Some(entry) = watches.get_mut(&sub.root) {
        entry.subscriber_count = entry.subscriber_count.saturating_sub(1);
        if entry.subscriber_count == 0 {
            entry.stop.store(true, Ordering::Relaxed);
            watches.remove(&sub.root); // drops the watcher, ends the thread
        }
    }
}

/// Drop a subscription. Idempotent: an unknown id is a no-op.
#[tauri::command]
pub(crate) fn watch_repo_stop(id: u64) -> Result<(), String> {
    drop_subscription(id);
    Ok(())
}

/// Reap every subscription opened by a webview. Called from `lib.rs` on
/// `PageLoadEvent::Started` and on `WindowEvent::Destroyed`.
///
/// This is the only reliable signal for a *reload* (a Vite full reload in dev,
/// a `location.reload()`, a crashed-and-restored webview): the old document's
/// `onUnmounted` never runs, so nothing calls `watch_repo_stop`, and
/// `Channel::send` keeps succeeding because the webview itself is still alive:
/// the `eval` lands in a document whose callback registry was wiped, so the
/// dead-channel reaping in `broadcast` cannot see it either. Without this the
/// `subscriber_count` for the repo would climb by one per reload and never
/// return to 0.
pub(crate) fn stop_all_for_webview(label: &str) {
    let stale: Vec<u64> = {
        let subs = lock_subscribers();
        subs.iter()
            .filter(|(_, sub)| sub.webview == label)
            .map(|(id, _)| *id)
            .collect()
    };
    for id in stale {
        drop_subscription(id);
    }
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
        assert_eq!(
            classify_path(".git/rebase-merge/head-name"),
            Some("mergeState")
        );
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
    fn classifies_absolute_paths_in_the_ordinary_layout() {
        let root = PathBuf::from("/repo");
        let none: Vec<PathBuf> = Vec::new();
        assert_eq!(
            classify_abs_path(&root, &none, &PathBuf::from("/repo/.git/HEAD")),
            Some((".git/HEAD".to_string(), "head"))
        );
        assert_eq!(
            classify_abs_path(&root, &none, &PathBuf::from("/repo/src/main.rs")),
            Some(("src/main.rs".to_string(), "worktree"))
        );
        assert_eq!(
            classify_abs_path(&root, &none, &PathBuf::from("/elsewhere/x")),
            None
        );
        // The root itself is not a change.
        assert_eq!(classify_abs_path(&root, &none, &root), None);
    }

    /// Regression test for the linked-worktree blind spot: HEAD, index and
    /// merge state live in `<main>/.git/worktrees/<name>/`, refs and config in
    /// `<main>/.git/`, and neither is under the worktree. Without the mapping
    /// these paths classify as nothing at all, and the watcher reports itself
    /// healthy (demoting the poll to 15 s) while missing every commit, branch
    /// switch and conflict made outside GitWand.
    #[test]
    fn classifies_a_linked_worktrees_external_metadata() {
        let root = PathBuf::from("/wt/feature");
        let git_dir = PathBuf::from("/main/.git/worktrees/feature");
        let common = PathBuf::from("/main/.git");
        let dirs = vec![git_dir.clone(), common.clone()];

        assert_eq!(
            classify_abs_path(&root, &dirs, &git_dir.join("HEAD")),
            Some((".git/HEAD".to_string(), "head"))
        );
        assert_eq!(
            classify_abs_path(&root, &dirs, &git_dir.join("index")),
            Some((".git/index".to_string(), "index"))
        );
        assert_eq!(
            classify_abs_path(&root, &dirs, &git_dir.join("MERGE_HEAD")),
            Some((".git/MERGE_HEAD".to_string(), "mergeState"))
        );
        assert_eq!(
            classify_abs_path(&root, &dirs, &common.join("refs/heads/main")),
            Some((".git/refs/heads/main".to_string(), "refs"))
        );
        // The worktree's own git dir must win over the common dir's reading of
        // the same path (`.git/worktrees/feature/HEAD`, which is noise).
        assert_eq!(
            classify_abs_path(&root, &dirs, &common.join("worktrees/feature/HEAD")),
            Some((".git/HEAD".to_string(), "head"))
        );
        // Object churn in the shared dir stays noise.
        assert_eq!(
            classify_abs_path(&root, &dirs, &common.join("objects/ab/cdef")),
            None
        );
        // Worktree content still classifies normally.
        assert_eq!(
            classify_abs_path(&root, &dirs, &root.join("src/main.rs")),
            Some(("src/main.rs".to_string(), "worktree"))
        );
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
        assert_eq!(
            ev.paths,
            vec![
                ".git/index".to_string(),
                "src/a.rs".to_string(),
                "src/b.rs".to_string()
            ]
        );
        assert!(!ev.truncated);
    }

    #[test]
    fn coalesce_returns_none_when_every_path_is_noise() {
        let batch = vec![
            ".git/objects/aa/bb".to_string(),
            "node_modules/x/y.js".to_string(),
        ];
        assert!(coalesce(&batch).is_none());
    }

    #[test]
    fn coalesce_caps_paths_and_flags_truncation() {
        let batch: Vec<String> = (0..EVENT_PATH_CAP + 10)
            .map(|i| format!("src/f{i}.rs"))
            .collect();
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
            Command::new("git")
                .args(args)
                .current_dir(&dir)
                .output()
                .unwrap();
        };
        run(&["init", "-q"]);
        run(&["config", "user.email", "t@example.com"]);
        run(&["config", "user.name", "T"]);
        std::fs::write(dir.join("a.txt"), "one\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "-qm", "init"]);

        let root = std::fs::canonicalize(&dir).unwrap();
        let (tx, rx) = mpsc::channel::<notify::Result<notify::Event>>();
        let mut watcher = notify::recommended_watcher(move |res| {
            let _ = tx.send(res);
        })
        .unwrap();
        watcher
            .watch(&root, notify::RecursiveMode::Recursive)
            .unwrap();

        std::fs::write(root.join("a.txt"), "two\n").unwrap();
        Command::new("git")
            .args(["add", "a.txt"])
            .current_dir(&root)
            .output()
            .unwrap();

        // Drain for up to 3 s, then coalesce whatever arrived.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        let mut batch: Vec<String> = Vec::new();
        while std::time::Instant::now() < deadline {
            match rx.recv_timeout(std::time::Duration::from_millis(200)) {
                Ok(Ok(ev)) => {
                    for p in ev.paths {
                        if let Ok(rel) = p.strip_prefix(&root) {
                            let rel = rel.to_string_lossy().replace('\\', "/");
                            if !rel.is_empty() {
                                batch.push(rel);
                            }
                        }
                    }
                }
                _ => {
                    if batch.iter().any(|p| classify_path(p) == Some("index"))
                        && batch.iter().any(|p| classify_path(p) == Some("worktree"))
                    {
                        break;
                    }
                }
            }
        }

        let ev = coalesce(&batch).expect("expected at least one interesting path");
        assert!(
            ev.kinds.contains(&"worktree".to_string()),
            "kinds: {:?}",
            ev.kinds
        );
        assert!(
            ev.kinds.contains(&"index".to_string()),
            "kinds: {:?}",
            ev.kinds
        );
        assert!(
            ev.paths.iter().any(|p| p == "a.txt"),
            "paths: {:?}",
            ev.paths
        );
        // Object churn from `git add` must never surface.
        assert!(
            !ev.paths.iter().any(|p| p.starts_with(".git/objects/")),
            "paths: {:?}",
            ev.paths
        );

        drop(watcher);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// End-to-end over a real `git worktree`: a commit made inside a linked
    /// worktree writes HEAD and refs *outside* the worktree directory, so a
    /// recursive watch on the worktree alone sees none of it. `ensure_watch`
    /// must pick those directories up and the coalescer must classify them.
    #[test]
    fn watches_a_linked_worktrees_external_metadata_end_to_end() {
        use std::process::Command;

        let base = std::env::temp_dir().join(format!(
            "gw-watch-wt-{}-{}",
            std::process::id(),
            NEXT_ID.load(Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&base);
        let main = base.join("main");
        std::fs::create_dir_all(&main).unwrap();
        let git = |dir: &std::path::Path, args: &[&str]| {
            let out = Command::new("git")
                .args(args)
                .current_dir(dir)
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "git {:?}: {}",
                args,
                String::from_utf8_lossy(&out.stderr)
            );
        };
        git(&main, &["init", "-q", "-b", "main"]);
        git(&main, &["config", "user.email", "t@example.com"]);
        git(&main, &["config", "user.name", "T"]);
        git(&main, &["config", "commit.gpgsign", "false"]);
        std::fs::write(main.join("a.txt"), "one\n").unwrap();
        git(&main, &["add", "."]);
        git(&main, &["commit", "-qm", "init"]);
        let wt = base.join("feature");
        git(
            &main,
            &[
                "worktree",
                "add",
                "-q",
                wt.to_str().unwrap(),
                "-b",
                "feature",
            ],
        );
        let wt = std::fs::canonicalize(&wt).unwrap();

        // Sanity: this is the shape the finding is about, `.git` is a file.
        assert!(wt.join(".git").is_file(), "expected a gitfile worktree");
        let dirs = external_git_dirs(&wt);
        assert!(
            !dirs.is_empty(),
            "the worktree's metadata dirs live outside it and must be resolved"
        );

        let (tx, rx) = mpsc::channel::<notify::Result<notify::Event>>();
        let (evt_tx, evt_rx) = mpsc::channel::<RepoChangeEvent>();
        let mut watcher = notify::recommended_watcher(move |res| {
            let _ = tx.send(res);
        })
        .unwrap();
        watcher.watch(&wt, RecursiveMode::Recursive).unwrap();
        for dir in &dirs {
            watcher.watch(dir, RecursiveMode::Recursive).unwrap();
        }
        let stop = Arc::new(AtomicBool::new(false));
        spawn_coalescer(wt.clone(), dirs, rx, stop.clone(), move |ev| {
            let _ = evt_tx.send(ev);
        });

        // A commit inside the worktree: writes the worktree's HEAD-adjacent
        // metadata and the shared refs, all outside `wt` itself.
        std::fs::write(wt.join("a.txt"), "two\n").unwrap();
        git(&wt, &["add", "a.txt"]);
        git(&wt, &["commit", "-qm", "in worktree"]);

        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let mut kinds = std::collections::BTreeSet::<String>::new();
        while std::time::Instant::now() < deadline {
            // A timeout is not a failure here: keep waiting until the
            // deadline, since the events arrive in several coalesced batches.
            if let Ok(ev) = evt_rx.recv_timeout(Duration::from_millis(300)) {
                for k in ev.kinds {
                    kinds.insert(k);
                }
                if kinds.contains("refs") && kinds.contains("index") {
                    break;
                }
            }
        }
        stop.store(true, Ordering::Relaxed);

        assert!(
            kinds.contains("index"),
            "a staged change in a linked worktree must produce an `index` event; got {kinds:?}"
        );
        assert!(
            kinds.contains("refs"),
            "a commit in a linked worktree moves a ref in the shared git dir and must produce a `refs` event; got {kinds:?}"
        );

        drop(watcher);
        let _ = std::fs::remove_dir_all(&base);
    }

    /// Regression test for Finding 1: a *resetting* quiet window (the old
    /// `rx.recv_timeout(DEBOUNCE)` with no other flush trigger) never fires
    /// under continuous churn, because every new event re-arms the window
    /// before it elapses. `spawn_coalescer` must force a flush within
    /// `MAX_WAIT` of the first event in a batch regardless of how many more
    /// events keep arriving.
    #[test]
    fn continuous_churn_still_flushes_within_max_wait() {
        use std::sync::mpsc;

        let root = PathBuf::from("/fake/repo/for/churn/test");
        let (raw_tx, raw_rx) = mpsc::channel::<notify::Result<notify::Event>>();
        let (evt_tx, evt_rx) = mpsc::channel::<RepoChangeEvent>();
        let stop = Arc::new(AtomicBool::new(false));

        spawn_coalescer(root.clone(), Vec::new(), raw_rx, stop.clone(), move |ev| {
            let _ = evt_tx.send(ev);
        });

        // Faster than DEBOUNCE (150ms), for longer than MAX_WAIT (500ms): a
        // purely resetting quiet window would never see a gap and would never
        // flush the whole time this loop runs.
        let stop_sending_at = std::time::Instant::now() + Duration::from_millis(900);
        std::thread::spawn(move || {
            let mut i = 0u32;
            while std::time::Instant::now() < stop_sending_at {
                let path = root.join(format!("f{}.txt", i % 5));
                let _ = raw_tx.send(Ok(notify::Event::new(notify::EventKind::Any).add_path(path)));
                i += 1;
                std::thread::sleep(Duration::from_millis(20));
            }
        });

        let first = evt_rx
            .recv_timeout(Duration::from_millis(700))
            .expect("expected a flush within MAX_WAIT despite continuous churn");
        assert!(
            first.kinds.contains(&"worktree".to_string()),
            "kinds: {:?}",
            first.kinds
        );

        stop.store(true, Ordering::Relaxed);
    }

    /// Regression test for Finding 1's raw-batch cap: an event storm that
    /// never reaches the max-wait deadline must still flush once the
    /// pre-coalesce staging batch hits `MAX_RAW_BATCH`, and must report the
    /// result as truncated.
    #[test]
    fn raw_batch_cap_forces_an_early_truncated_flush() {
        use std::sync::mpsc;

        let root = PathBuf::from("/fake/repo/for/cap/test");
        let (raw_tx, raw_rx) = mpsc::channel::<notify::Result<notify::Event>>();
        let (evt_tx, evt_rx) = mpsc::channel::<RepoChangeEvent>();
        let stop = Arc::new(AtomicBool::new(false));

        spawn_coalescer(root.clone(), Vec::new(), raw_rx, stop.clone(), move |ev| {
            let _ = evt_tx.send(ev);
        });

        for i in 0..(MAX_RAW_BATCH + 10) {
            let path = root.join(format!("f{i}.txt"));
            raw_tx
                .send(Ok(notify::Event::new(notify::EventKind::Any).add_path(path)))
                .unwrap();
        }

        // The cap must trip well before MAX_WAIT (500ms) would have.
        let ev = evt_rx
            .recv_timeout(Duration::from_millis(300))
            .expect("expected an early flush once the raw batch cap was hit");
        assert!(
            ev.truncated,
            "a flush forced by the raw batch cap must be marked truncated"
        );

        stop.store(true, Ordering::Relaxed);
    }

    /// Phase C prerequisite: an *unexpected* death of the raw `notify` channel
    /// (the sender dropped without `watch_repo_stop` ever setting `stop`)
    /// must surface as a terminal `closed: true` sentinel, so
    /// `useRepoWatcher` on the frontend can flip `healthy` to false instead
    /// of silently going quiet forever.
    #[test]
    fn unexpected_disconnect_emits_a_closed_sentinel() {
        use std::sync::mpsc;

        let root = PathBuf::from("/fake/repo/for/closed/test");
        let (raw_tx, raw_rx) = mpsc::channel::<notify::Result<notify::Event>>();
        let (evt_tx, evt_rx) = mpsc::channel::<RepoChangeEvent>();
        let stop = Arc::new(AtomicBool::new(false));

        spawn_coalescer(root, Vec::new(), raw_rx, stop, move |ev| {
            let _ = evt_tx.send(ev);
        });

        // Drop the sender without ever setting `stop`: simulates the OS-level
        // watch dying on its own rather than an intentional teardown.
        drop(raw_tx);

        let ev = evt_rx
            .recv_timeout(Duration::from_millis(300))
            .expect("expected a closed sentinel after the unexpected disconnect");
        assert!(ev.closed, "expected closed: true, got {:?}", ev);
        assert!(ev.kinds.is_empty());
        assert!(ev.paths.is_empty());
        assert!(!ev.truncated);
    }

    /// An *intentional* teardown (`stop` set before the sender drops, exactly
    /// as `watch_repo_stop` does when the last subscriber leaves) must not
    /// emit a `closed` sentinel: nothing is listening for it anymore, and a
    /// stray event here would be pure noise.
    #[test]
    fn intentional_stop_emits_no_closed_sentinel() {
        use std::sync::mpsc;

        let root = PathBuf::from("/fake/repo/for/intentional/stop/test");
        let (raw_tx, raw_rx) = mpsc::channel::<notify::Result<notify::Event>>();
        let (evt_tx, evt_rx) = mpsc::channel::<RepoChangeEvent>();
        let stop = Arc::new(AtomicBool::new(false));

        spawn_coalescer(root, Vec::new(), raw_rx, stop.clone(), move |ev| {
            let _ = evt_tx.send(ev);
        });

        stop.store(true, Ordering::Relaxed);
        drop(raw_tx);

        assert!(
            evt_rx.recv_timeout(Duration::from_millis(300)).is_err(),
            "an intentional stop must not emit a closed sentinel"
        );
    }

    /// Regression test for Finding 3: `watch_repo_start` inserts into
    /// SUBSCRIBERS only after `ensure_watch` succeeds, so a failed watch can
    /// never orphan a subscriber entry nothing can ever `watch_repo_stop`.
    /// `watch_repo_start` itself takes a `tauri::ipc::Channel`, which cannot
    /// be constructed outside a Tauri runtime (see the note on the real-repo
    /// test above) — so this exercises `ensure_watch` directly, the exact
    /// function `watch_repo_start` gates subscriber registration on.
    #[test]
    fn ensure_watch_failure_never_touches_subscribers() {
        let missing = std::env::temp_dir().join(format!(
            "gw-watch-missing-{}-{}",
            std::process::id(),
            line!()
        ));
        let _ = std::fs::remove_dir_all(&missing); // guarantee it does not exist

        let result = ensure_watch(&missing);
        assert!(result.is_err(), "watching a nonexistent path must fail");
        assert!(
            !lock_watches().contains_key(&missing),
            "a failed watch must not linger in the WATCHES registry"
        );
        // Scoped to this root rather than comparing the global SUBSCRIBERS
        // length: the registry is process-wide and the tests around this one
        // register their own subscribers on other roots in parallel.
        assert!(
            !lock_subscribers().values().any(|sub| sub.root == missing),
            "ensure_watch must never touch SUBSCRIBERS"
        );
    }

    /// Create a real watched directory and register `n` subscriptions on it,
    /// each with the given webview label and channel behaviour. Returns the
    /// root and the ids, so a test can assert on the reaping bookkeeping.
    fn register_subscription(
        root: &std::path::Path,
        webview: &str,
        chan: Channel<RepoChangeEvent>,
    ) -> u64 {
        ensure_watch(root).expect("watching a real temp dir must succeed");
        let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
        lock_subscribers().insert(
            id,
            Subscription {
                root: root.to_path_buf(),
                webview: webview.to_string(),
                chan,
            },
        );
        id
    }

    /// A real (if empty) git repo: `ensure_watch` refuses a directory whose
    /// git metadata it cannot resolve, since it could not honestly report the
    /// watch as healthy.
    fn temp_watch_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "gw-watch-{tag}-{}-{}",
            std::process::id(),
            NEXT_ID.load(Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let out = std::process::Command::new("git")
            .args(["init", "-q"])
            .current_dir(&dir)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git init failed in the temp watch root"
        );
        std::fs::canonicalize(&dir).unwrap()
    }

    /// Regression test: a subscription whose channel is gone (window destroyed
    /// without the frontend's `onUnmounted` running) must be reaped by the
    /// broadcast that discovers it, releasing the watch reference it held.
    /// Otherwise `subscriber_count` never returns to 0 and both the OS watcher
    /// and its coalescing thread leak.
    #[test]
    fn broadcast_reaps_a_subscriber_whose_channel_is_gone() {
        let root = temp_watch_root("reap");
        // `Channel::send` bottoms out in `webview.eval`, which is exactly what
        // fails with this error once the webview is destroyed.
        let dead = Channel::new(|_| Err(tauri::Error::WebviewNotFound));
        let id = register_subscription(&root, "main", dead);

        broadcast(
            &root,
            &RepoChangeEvent {
                kinds: vec!["worktree".to_string()],
                paths: vec!["a.txt".to_string()],
                truncated: false,
                closed: false,
            },
        );

        assert!(
            !lock_subscribers().contains_key(&id),
            "a subscription with a dead channel must be reaped"
        );
        assert!(
            !lock_watches().contains_key(&root),
            "reaping the last subscriber must tear the OS watcher down"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A live channel must survive a broadcast, and the watch it holds must
    /// stay up, the reaping above must key on the send failure, not fire
    /// indiscriminately.
    #[test]
    fn broadcast_keeps_a_live_subscriber() {
        let root = temp_watch_root("live");
        let id = register_subscription(&root, "main", Channel::new(|_| Ok(())));

        broadcast(
            &root,
            &RepoChangeEvent {
                kinds: vec!["worktree".to_string()],
                paths: Vec::new(),
                truncated: false,
                closed: false,
            },
        );

        assert!(lock_subscribers().contains_key(&id));
        assert!(lock_watches().contains_key(&root));
        drop_subscription(id);
        assert!(!lock_watches().contains_key(&root));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Regression test for the reload leak: after a webview reloads, the old
    /// document's subscriptions are unreachable (its `onUnmounted` never ran)
    /// yet `Channel::send` still succeeds, so `broadcast` cannot detect them.
    /// `stop_all_for_webview` is what releases them, and it must only touch
    /// the reloading webview's own subscriptions.
    #[test]
    fn stop_all_for_webview_reaps_only_that_webviews_subscriptions() {
        let root = temp_watch_root("reload");
        // Two subscriptions from the document that is about to be replaced,
        // plus one from a second window on the same repo.
        let stale_a = register_subscription(&root, "main", Channel::new(|_| Ok(())));
        let stale_b = register_subscription(&root, "main", Channel::new(|_| Ok(())));
        let other = register_subscription(&root, "second", Channel::new(|_| Ok(())));
        assert_eq!(lock_watches().get(&root).unwrap().subscriber_count, 3);

        stop_all_for_webview("main");

        assert!(!lock_subscribers().contains_key(&stale_a));
        assert!(!lock_subscribers().contains_key(&stale_b));
        assert!(
            lock_subscribers().contains_key(&other),
            "another window's subscription must not be reaped"
        );
        assert_eq!(
            lock_watches().get(&root).unwrap().subscriber_count,
            1,
            "the watch reference count must follow the reaped subscriptions"
        );

        drop_subscription(other);
        assert!(
            !lock_watches().contains_key(&root),
            "the count must now be able to reach 0 and tear the watcher down"
        );
        let _ = std::fs::remove_dir_all(&root);
    }
}

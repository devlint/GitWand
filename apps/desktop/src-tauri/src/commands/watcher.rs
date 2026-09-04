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
                        let Ok(rel) = p.strip_prefix(&root) else {
                            continue;
                        };
                        let rel = rel.to_string_lossy().replace('\\', "/");
                        if rel.is_empty() {
                            continue;
                        }
                        // Classify at push time so noise (object churn,
                        // ignored build dirs) is never stored, not just
                        // discarded later at flush.
                        if classify_path(&rel).is_none() {
                            continue;
                        }
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
                        lock_subscribers().retain(|_, (path, _)| path != &root);
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

    let stop = Arc::new(AtomicBool::new(false));
    let thread_root = root.to_path_buf();
    let emit_root = thread_root.clone();
    spawn_coalescer(thread_root, rx, stop.clone(), move |ev| {
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
    cwd: String,
    on_change: Channel<RepoChangeEvent>,
) -> Result<u64, String> {
    let root = safe_repo_path(cwd.trim(), ".").map_err(|e| format!("invalid cwd: {e}"))?;
    if !root.is_dir() {
        return Err("cwd is not a directory".to_string());
    }

    ensure_watch(&root)?;

    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    lock_subscribers().insert(id, (root, on_change));
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

        spawn_coalescer(root.clone(), raw_rx, stop.clone(), move |ev| {
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

        spawn_coalescer(root.clone(), raw_rx, stop.clone(), move |ev| {
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

        spawn_coalescer(root, raw_rx, stop, move |ev| {
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

        spawn_coalescer(root, raw_rx, stop.clone(), move |ev| {
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

        let subscribers_before = lock_subscribers().len();
        let result = ensure_watch(&missing);
        assert!(result.is_err(), "watching a nonexistent path must fail");
        assert!(
            !lock_watches().contains_key(&missing),
            "a failed watch must not linger in the WATCHES registry"
        );
        assert_eq!(
            lock_subscribers().len(),
            subscribers_before,
            "ensure_watch must never touch SUBSCRIBERS"
        );
    }
}

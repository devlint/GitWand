//! Per-repository serialization of git subprocesses.
//!
//! # Why
//!
//! A git working tree is guarded by a single `.git/index.lock`. Two git
//! processes that both want to touch the index/refs/worktree of the *same*
//! repo cannot run concurrently: the second dies with
//!
//! ```text
//! fatal: Unable to create '.../.git/index.lock': File exists.
//! ```
//!
//! GitWand fires several commands at once — e.g. a background refresh runs
//! `git status` / `git stash list` / `git log` while the user triggers a sync
//! (`git fetch` + `git checkout`). Two failure modes were observed in the wild
//! (submodule-heavy repo, "click origin/main to sync"):
//!
//! - the mutating op collides on `index.lock` (the message above);
//! - a *read* spawned with `current_dir(cwd)` fails with
//!   `No such file or directory (os error 2)` because a concurrent checkout /
//!   submodule update was recreating a working-tree directory out from under
//!   it at spawn time.
//!
//! # How
//!
//! One `RwLock` per repo, keyed by `cwd`. Reads take the shared guard (many
//! concurrent readers of one repo are fine); anything that mutates the index,
//! refs, or working tree takes the exclusive guard. Different repos map to
//! different locks, so cross-repo parallelism (the `workspace_*_all` rayon hot
//! paths) is unaffected — the lock only serializes operations that would
//! genuinely contend on the same `index.lock`.
//!
//! Keying is by the raw `cwd` string (no `rev-parse` spawn on the hot path).
//! For the contended case — a repo's own status/log/stash racing its
//! checkout/fetch — every caller passes the same `cwd`, so they share a lock.
//!
//! # Discipline
//!
//! Acquire the guard at the top of a `#[tauri::command]` body and hold it for
//! the whole command. Never acquire a second repo guard while holding one
//! (the `RwLock` is non-reentrant — re-locking the same repo would deadlock).
//! To keep that safe by construction, command bodies must never call another
//! `#[tauri::command]`: when one command needs another's logic, that logic is
//! factored into a plain (non-command, unlocked) helper both share, and the
//! caller owns the single guard. See `list_worktrees` in `commands/ops.rs`
//! (shared by `git_worktree_list`, `git_worktree_status_all`, and
//! `agent_session_list`) for the pattern.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use parking_lot::{
    ArcMutexGuard, ArcRwLockReadGuard, ArcRwLockWriteGuard, Mutex as PlMutex, RawMutex, RawRwLock,
    RwLock,
};

/// Shared guard: multiple readers of a repo proceed together, all blocked
/// while a writer holds the lock.
pub(crate) type RepoReadGuard = ArcRwLockReadGuard<RawRwLock, ()>;
/// Exclusive guard: blocks every other reader and writer on the same repo.
pub(crate) type RepoWriteGuard = ArcRwLockWriteGuard<RawRwLock, ()>;

/// Registry of per-repo locks. `Mutex` only guards the map itself (cheap,
/// never held across a git call); the returned `Arc<RwLock<()>>` is what the
/// git subprocess is serialized on.
static LOCKS: OnceLock<Mutex<HashMap<String, Arc<RwLock<()>>>>> = OnceLock::new();

/// Registry of per-repo *push* mutexes, orthogonal to `LOCKS`. Serializes
/// outbound pushes to one repo against each other without blocking reads (see
/// `push`). Same keying and unbounded-growth trade-off as `LOCKS`.
static PUSH_LOCKS: OnceLock<Mutex<HashMap<String, Arc<PlMutex<()>>>>> = OnceLock::new();

/// Canonicalize `cwd` so two path representations of the same physical repo (a
/// symlink, a trailing slash, `..` components) resolve to the same key —
/// otherwise the serialization this module exists for silently doesn't apply
/// between them. Falls back to the raw string if canonicalization fails (path
/// removed between the frontend call and this command running, unavailable
/// network mount, …) — same behavior as before this fallback existed.
fn canonical_key(cwd: &str) -> String {
    std::fs::canonicalize(cwd)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| cwd.to_string())
}

/// Fetch (or create) the lock for `cwd`. Entries are tiny and bounded by the
/// number of distinct repo paths the session has touched, so the map is left
/// to grow rather than reference-counted for eviction.
fn lock_for(cwd: &str) -> Arc<RwLock<()>> {
    let key = canonical_key(cwd);
    let map = LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut guard = map.lock().unwrap();
    guard
        .entry(key)
        .or_insert_with(|| Arc::new(RwLock::new(())))
        .clone()
}

/// Fetch (or create) the push mutex for `cwd`.
fn push_lock_for(cwd: &str) -> Arc<PlMutex<()>> {
    let key = canonical_key(cwd);
    let map = PUSH_LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut guard = map.lock().unwrap();
    guard
        .entry(key)
        .or_insert_with(|| Arc::new(PlMutex::new(())))
        .clone()
}

/// Acquire the shared (read) guard for `cwd`. Use for commands that only
/// *inspect* the repo (status, log, diff, stash list, …). The returned guard
/// is `#[must_use]` (via the underlying `ArcRwLockReadGuard`): bind it to a
/// named local (`let _repo = …`) so it lives for the whole command body.
pub(crate) fn read(cwd: &str) -> RepoReadGuard {
    lock_for(cwd).read_arc()
}

/// Acquire the exclusive (write) guard for `cwd`. Use for any command that
/// mutates the index, refs, or working tree (fetch, pull, merge, checkout,
/// stash push/pop, submodule update, discard, …).
pub(crate) fn write(cwd: &str) -> RepoWriteGuard {
    lock_for(cwd).write_arc()
}

/// Guard for an outbound push: holds the repo's shared read guard *and* the
/// exclusive per-repo push mutex for the whole command body. Drop order is
/// field order — push mutex released before the read guard, the reverse of
/// acquisition.
pub(crate) struct RepoPushGuard {
    _push: ArcMutexGuard<RawMutex, ()>,
    _read: RepoReadGuard,
}

/// Acquire the guard for an outbound push (`git push` of a branch/tags/delete).
///
/// A push publishes refs but doesn't touch the index/worktree, so — like
/// `read` — it must stay concurrent with status/log reads. But two pushes to
/// the *same* repo must not overlap: two `--set-upstream` pushes of the same
/// new branch both read the (branch-less) ref advertisement, both send a
/// *create*, and the loser is rejected with `cannot lock ref …: reference
/// already exists`. So a push takes the shared read guard (still excludes a
/// ref-mutating writer — checkout/pull/rebase) **plus** an exclusive push mutex
/// that serializes it against other pushes only.
///
/// Ordering: read guard first, then the push mutex. Only `push` ever touches
/// the push mutex, so this can't invert against `read`/`write` callers and
/// can't deadlock.
pub(crate) fn push(cwd: &str) -> RepoPushGuard {
    let read = lock_for(cwd).read_arc();
    let push = push_lock_for(cwd).lock_arc();
    RepoPushGuard { _push: push, _read: read }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_cwd_shares_one_lock() {
        let a = lock_for("/tmp/repo-a");
        let b = lock_for("/tmp/repo-a");
        assert!(Arc::ptr_eq(&a, &b), "same cwd must resolve to the same lock");
    }

    #[test]
    fn distinct_cwd_distinct_locks() {
        let a = lock_for("/tmp/repo-one");
        let b = lock_for("/tmp/repo-two");
        assert!(!Arc::ptr_eq(&a, &b), "different repos must not contend");
    }

    #[test]
    fn readers_share_writer_excludes() {
        // Two read guards on the same repo coexist.
        let _r1 = read("/tmp/repo-rw");
        let _r2 = read("/tmp/repo-rw");
        // A writer cannot be taken while a reader is held.
        assert!(
            lock_for("/tmp/repo-rw").try_write_arc().is_none(),
            "writer must be excluded while a reader holds the lock"
        );
    }

    #[test]
    fn distinct_repos_do_not_block() {
        let _w = write("/tmp/repo-x");
        // A writer on another repo is unaffected.
        assert!(
            lock_for("/tmp/repo-y").try_write_arc().is_some(),
            "a writer on one repo must not block another repo"
        );
    }

    #[test]
    fn concurrent_pushes_to_same_repo_are_serialized() {
        let _p = push("/tmp/repo-push");
        // A second push to the same repo cannot proceed: the push mutex is held.
        assert!(
            push_lock_for("/tmp/repo-push").try_lock_arc().is_none(),
            "a second push must block while the first holds the push mutex"
        );
    }

    #[test]
    fn push_does_not_block_reads() {
        let _p = push("/tmp/repo-push-read");
        // Status/log reads stay concurrent with an in-flight push.
        assert!(
            lock_for("/tmp/repo-push-read").try_read_arc().is_some(),
            "a push must not exclude concurrent readers"
        );
        // But it does exclude a writer (checkout/pull mutating refs).
        assert!(
            lock_for("/tmp/repo-push-read").try_write_arc().is_none(),
            "a push must exclude a ref-mutating writer"
        );
    }

    #[test]
    fn pushes_to_distinct_repos_do_not_block() {
        let _p = push("/tmp/repo-push-a");
        assert!(
            push_lock_for("/tmp/repo-push-b").try_lock_arc().is_some(),
            "a push on one repo must not block a push on another"
        );
    }

    #[cfg(unix)]
    #[test]
    fn symlink_and_real_path_share_one_lock() {
        let pid = std::process::id();
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let real = std::env::temp_dir().join(format!("gitwand-repolock-real-{}-{}", pid, nanos));
        let link = std::env::temp_dir().join(format!("gitwand-repolock-link-{}-{}", pid, nanos));
        std::fs::create_dir_all(&real).expect("create real dir");
        std::os::unix::fs::symlink(&real, &link).expect("create symlink");

        let a = lock_for(real.to_str().unwrap());
        let b = lock_for(link.to_str().unwrap());

        std::fs::remove_dir_all(&real).ok();
        std::fs::remove_file(&link).ok();

        assert!(
            Arc::ptr_eq(&a, &b),
            "a symlink and its real path must resolve to the same lock"
        );
    }

    #[test]
    fn nonexistent_path_falls_back_to_raw_string_without_panic() {
        let a = lock_for("/gitwand-repolock-does-not-exist-1");
        let b = lock_for("/gitwand-repolock-does-not-exist-1");
        assert!(Arc::ptr_eq(&a, &b), "same nonexistent path must still share one lock");
    }
}

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
//! GitWand's command bodies each spawn their git subprocess directly and do
//! not call one another, so this holds by construction.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use parking_lot::{ArcRwLockReadGuard, ArcRwLockWriteGuard, RawRwLock, RwLock};

/// Shared guard: multiple readers of a repo proceed together, all blocked
/// while a writer holds the lock.
pub(crate) type RepoReadGuard = ArcRwLockReadGuard<RawRwLock, ()>;
/// Exclusive guard: blocks every other reader and writer on the same repo.
pub(crate) type RepoWriteGuard = ArcRwLockWriteGuard<RawRwLock, ()>;

/// Registry of per-repo locks. `Mutex` only guards the map itself (cheap,
/// never held across a git call); the returned `Arc<RwLock<()>>` is what the
/// git subprocess is serialized on.
static LOCKS: OnceLock<Mutex<HashMap<String, Arc<RwLock<()>>>>> = OnceLock::new();

/// Fetch (or create) the lock for `cwd`. Entries are tiny and bounded by the
/// number of distinct repo paths the session has touched, so the map is left
/// to grow rather than reference-counted for eviction.
fn lock_for(cwd: &str) -> Arc<RwLock<()>> {
    let map = LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut guard = map.lock().unwrap();
    guard
        .entry(cwd.to_string())
        .or_insert_with(|| Arc::new(RwLock::new(())))
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
}

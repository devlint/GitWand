//! Tauri command surface for repo snapshots (v3.8 Time Machine).
//!
//! Every command takes the repo guard and delegates to the lock-free engine
//! in `git::snapshot`. Destructive commands in `ops.rs` call the `*_inner`
//! functions directly instead, because they already hold the guard and
//! `repo_lock` is not reentrant.

use crate::git::repo_lock;
use crate::git::snapshot::{
    create_snapshot_inner, list_snapshots_inner, prune_snapshots_inner, restore_snapshot_inner,
    SnapshotMeta,
};

#[tauri::command]
pub(crate) async fn snapshot_create(
    cwd: String,
    kind: String,
    label: String,
) -> Result<Option<SnapshotMeta>, String> {
    let _repo = repo_lock::write(&cwd);
    create_snapshot_inner(&cwd, &kind, &label)
}

#[tauri::command]
pub(crate) async fn snapshot_list(cwd: String) -> Result<Vec<SnapshotMeta>, String> {
    let _repo = repo_lock::read(&cwd);
    list_snapshots_inner(&cwd)
}

#[tauri::command]
pub(crate) async fn snapshot_restore(cwd: String, id: String) -> Result<SnapshotMeta, String> {
    let _repo = repo_lock::write(&cwd);
    restore_snapshot_inner(&cwd, &id)
}

#[tauri::command]
pub(crate) async fn snapshot_prune(
    cwd: String,
    max_age_days: u32,
    max_count: usize,
) -> Result<usize, String> {
    let _repo = repo_lock::write(&cwd);
    prune_snapshots_inner(&cwd, max_age_days, max_count)
}

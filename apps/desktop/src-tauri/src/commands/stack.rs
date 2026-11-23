//! Tauri commands for stacked branches. Each body is: take the repo lock,
//! call into `crate::stack`, return the result. The logic lives there.
//!
//! Every command takes `repo_lock::write`, the plan command included:
//! `status` writes config, runs `update-ref` and `git switch` when it
//! finalizes a pending restack, and `plan` goes through the same detection, so
//! overlapping calls must not interleave. `git_restack` holds the lock across
//! the whole `git rebase`, exactly as `git_rebase_onto` does.

use crate::git::*;
use crate::stack::{
    detect, guard, meta, restack, MergedParentHint, PreviewedRestack, RestackPlan, RestackRun,
    StackMeta, StackReport,
};
use std::path::Path;

#[tauri::command]
pub(crate) async fn stack_status(
    cwd: String,
    configured_trunk: Option<String>,
    merged_parents: Vec<MergedParentHint>,
) -> Result<StackReport, String> {
    let _repo = repo_lock::write(&cwd);
    detect::status(
        Path::new(&cwd),
        configured_trunk.as_deref(),
        &merged_parents,
    )
}

#[tauri::command]
pub(crate) async fn stack_set_parent(
    cwd: String,
    branch: String,
    parent: String,
    configured_trunk: Option<String>,
) -> Result<StackMeta, String> {
    let _repo = repo_lock::write(&cwd);
    let repo = Path::new(&cwd);
    let trunk = meta::trunk(repo, configured_trunk.as_deref());
    meta::set_parent(repo, trunk.as_deref(), &branch, &parent)
}

#[tauri::command]
pub(crate) async fn stack_unset(cwd: String, branch: String) -> Result<(), String> {
    let _repo = repo_lock::write(&cwd);
    meta::unset(Path::new(&cwd), &branch)
}

#[tauri::command]
pub(crate) async fn stack_restack_plan(
    cwd: String,
    branch: String,
    configured_trunk: Option<String>,
    merged_parents: Vec<MergedParentHint>,
) -> Result<RestackPlan, String> {
    let _repo = repo_lock::write(&cwd);
    restack::plan(
        Path::new(&cwd),
        configured_trunk.as_deref(),
        &branch,
        &merged_parents,
        guard::git_version(),
    )
}

#[tauri::command]
pub(crate) async fn git_restack(
    cwd: String,
    branch: String,
    configured_trunk: Option<String>,
    merged_parents: Vec<MergedParentHint>,
    previewed: PreviewedRestack,
) -> Result<RestackRun, String> {
    let _repo = repo_lock::write(&cwd);
    restack::run(
        Path::new(&cwd),
        configured_trunk.as_deref(),
        &branch,
        &merged_parents,
        &previewed,
        guard::git_version(),
    )
}

/// Deletes the merged parent a finalized restack offered to delete, only if
/// it still points at the tip that offer verified (compare-and-swap).
#[tauri::command]
pub(crate) async fn stack_delete_merged_parent(
    cwd: String,
    branch: String,
    tip: String,
) -> Result<(), String> {
    let _repo = repo_lock::write(&cwd);
    restack::delete_merged_parent(Path::new(&cwd), &branch, &tip)
}

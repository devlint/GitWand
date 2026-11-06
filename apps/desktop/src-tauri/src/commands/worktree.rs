//! v3.13.0 — Tauri commands of the worktree service (`crate::worktree`).
//!
//! Thin: validate paths with `safe_repo_path`, then run the service off the
//! UI thread.

use crate::worktree::{base, settings};
use serde::Serialize;
use std::path::PathBuf;
use std::time::Duration;

/// How long a base fetch may take before GitWand falls back (spec §5.2).
pub(crate) const FETCH_TIMEOUT: Duration = Duration::from_secs(20);

fn canonical_cwd(cwd: &str) -> Result<PathBuf, String> {
    crate::git::safe_repo_path(cwd.trim(), ".").map_err(|e| format!("invalid cwd: {e}"))
}

#[derive(Serialize, Debug)]
pub struct WorktreeBaseInfo {
    pub base: base::BaseResolution,
    /// Where a new worktree goes by default, for pre-filling the form.
    pub dir: String,
}

pub(crate) fn resolve_base_info(cwd: &str) -> Result<WorktreeBaseInfo, String> {
    let root = canonical_cwd(cwd)?;
    let main = super::worktree_trust::main_worktree_root(&root.to_string_lossy())?;
    let s = settings::read_settings(&main);
    Ok(WorktreeBaseInfo {
        base: base::resolve_default_base(&main, FETCH_TIMEOUT)?,
        dir: settings::worktrees_dir(&main, &s)
            .to_string_lossy()
            .to_string(),
    })
}

/// The base a new worktree would start from, fetched now, and the default
/// directory (spec §10.1).
#[tauri::command]
pub(crate) async fn worktree_resolve_base(cwd: String) -> Result<WorktreeBaseInfo, String> {
    tauri::async_runtime::spawn_blocking(move || resolve_base_info(&cwd))
        .await
        .map_err(|e| format!("worktree base resolution failed: {e}"))?
}

/// Creates a worktree through the worktree service (spec §5, §10.1). Does
/// not run `setup`: the frontend opens the setup tab with
/// `worktree_run_hook` once it knows the user's trust answer.
#[tauri::command]
pub(crate) async fn worktree_create(
    cwd: String,
    name: String,
    base: Option<String>,
    branch: Option<String>,
    path: Option<String>,
    kind: String,
) -> Result<crate::worktree::create::CreatedWorktree, String> {
    let root = canonical_cwd(&cwd)?;
    let kind = match kind.as_str() {
        "task" => crate::worktree::record::Kind::Task,
        "manual" => crate::worktree::record::Kind::Manual,
        other => return Err(format!("Unknown worktree kind: {other}")),
    };
    let req = crate::worktree::create::CreateRequest {
        name,
        base,
        branch,
        path,
        kind,
    };
    tauri::async_runtime::spawn_blocking(move || {
        crate::worktree::create::create_worktree(&root, req, FETCH_TIMEOUT)
    })
    .await
    .map_err(|e| format!("worktree creation failed: {e}"))?
}

/// Runs the repository's `setup` or `teardown` hook for `path` in a PTY session streamed on
/// `on_output`, like `terminal_open` (spec §5.4). Refuses unless the hooks
/// still hash to `hash` and that hash is trusted for the repo.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) fn worktree_run_hook(
    cwd: String,
    path: String,
    hook: String,
    hash: String,
    cols: u16,
    rows: u16,
    on_output: tauri::ipc::Channel<super::terminal::TerminalEvent>,
) -> Result<u64, String> {
    let root = canonical_cwd(&cwd)?;
    let worktree =
        crate::git::safe_repo_path(path.trim(), ".").map_err(|e| format!("invalid path: {e}"))?;
    let hook = crate::worktree::hooks::Hook::parse(&hook)
        .ok_or_else(|| format!("Unknown worktree hook: {hook}"))?;
    let spec = crate::worktree::hooks::hook_spec(
        &root,
        &worktree,
        hook,
        &hash,
        &super::worktree_trust::store_path(),
        None,
        cols,
        rows,
    )?;
    let (on_chunk, on_exit) =
        super::terminal::event_sinks(move |event| on_output.send(event).is_ok());
    super::terminal::spawn_session(spec, on_chunk, on_exit)
}

/// How long `url` may run (spec §10.1).
const URL_TIMEOUT: Duration = Duration::from_secs(10);

/// Runs the repository's `url` hook for `path` and returns the first
/// non-empty line of its output; `None` when the repo defines no `url`.
#[tauri::command]
pub(crate) async fn worktree_url(
    cwd: String,
    path: String,
    hash: String,
) -> Result<Option<String>, String> {
    let root = canonical_cwd(&cwd)?;
    let worktree =
        crate::git::safe_repo_path(path.trim(), ".").map_err(|e| format!("invalid path: {e}"))?;
    tauri::async_runtime::spawn_blocking(move || {
        crate::worktree::hooks::url_for(
            &root,
            &worktree,
            &hash,
            &super::worktree_trust::store_path(),
            None,
            URL_TIMEOUT,
        )
    })
    .await
    .map_err(|e| format!("worktree url failed: {e}"))?
}

/// A worktree path from the frontend. `safe_repo_path` when it exists; a
/// path whose directory is gone (a teardown may delete it) is accepted
/// as is, since the removal service only goes on with a path git itself
/// lists as a worktree of this repo, and only runs git on it.
fn worktree_arg(path: &str) -> Result<PathBuf, String> {
    let p = path.trim();
    if p.is_empty() {
        return Err("invalid path: empty".to_string());
    }
    if std::path::Path::new(p).exists() {
        return crate::git::safe_repo_path(p, ".").map_err(|e| format!("invalid path: {e}"));
    }
    let raw = PathBuf::from(p);
    if !raw.is_absolute() {
        return Err(format!("invalid path: {p}"));
    }
    Ok(raw)
}

/// What GitWand may do to a worktree (spec §7.1).
#[tauri::command]
pub(crate) async fn worktree_guard(
    cwd: String,
    path: String,
) -> Result<crate::worktree::guard::GuardReport, String> {
    let root = canonical_cwd(&cwd)?;
    let worktree = worktree_arg(&path)?;
    tauri::async_runtime::spawn_blocking(move || crate::worktree::guard::guard(&root, &worktree))
        .await
        .map_err(|e| format!("worktree guard failed: {e}"))?
}

/// Removal steps 1–3 (spec §7.2): guards, stop the processes, snapshot.
#[tauri::command]
pub(crate) async fn worktree_remove_prepare(
    cwd: String,
    path: String,
    kill_foreign: bool,
) -> Result<crate::worktree::remove::Prepared, String> {
    let root = canonical_cwd(&cwd)?;
    let worktree =
        crate::git::safe_repo_path(path.trim(), ".").map_err(|e| format!("invalid path: {e}"))?;
    tauri::async_runtime::spawn_blocking(move || {
        crate::worktree::remove::prepare_removal(&root, &worktree, |wt| {
            super::worktree_processes::stop_processes_in(&root, wt, kill_foreign)
        })
    })
    .await
    .map_err(|e| format!("worktree removal failed: {e}"))?
}

/// Removal steps 1 and 5–7 (spec §7.2), once teardown ran, was skipped,
/// or the user chose "Remove anyway".
#[tauri::command]
pub(crate) async fn worktree_remove(
    cwd: String,
    path: String,
    opts: crate::worktree::remove::RemoveOptions,
) -> Result<crate::worktree::remove::RemoveOutcome, String> {
    let root = canonical_cwd(&cwd)?;
    let worktree = worktree_arg(&path)?;
    tauri::async_runtime::spawn_blocking(move || {
        crate::worktree::remove::remove_worktree(
            &root,
            &worktree,
            &opts,
            super::worktree_processes::still_running,
        )
    })
    .await
    .map_err(|e| format!("worktree removal failed: {e}"))?
}

/// `git worktree unlock`: the only action offered on a locked worktree.
#[tauri::command]
pub(crate) async fn worktree_unlock(cwd: String, path: String) -> Result<(), String> {
    let root = canonical_cwd(&cwd)?;
    let worktree = worktree_arg(&path)?;
    tauri::async_runtime::spawn_blocking(move || {
        let entry = crate::worktree::guard::listed(&root, &worktree)?;
        let out = crate::git::git_cmd()
            .args(["worktree", "unlock"])
            .arg(&entry.path)
            .current_dir(&root)
            .output()
            .map_err(|e| format!("cannot run git: {e}"))?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("worktree unlock failed: {e}"))?
}

/// Merge-back steps 1–2 (spec §6.1), read-only: the task, the target and
/// whether the main checkout can take the work now.
#[tauri::command]
pub(crate) async fn worktree_merge_back_check(
    cwd: String,
    path: String,
    target: Option<String>,
) -> Result<crate::worktree::merge_back::MergeBackCheck, String> {
    let root = canonical_cwd(&cwd)?;
    let worktree =
        crate::git::safe_repo_path(path.trim(), ".").map_err(|e| format!("invalid path: {e}"))?;
    tauri::async_runtime::spawn_blocking(move || {
        crate::worktree::merge_back::check(&root, &worktree, target.as_deref())
    })
    .await
    .map_err(|e| format!("merge-back check failed: {e}"))?
}

/// Merge-back steps 3–5: stop the task's processes, commit its outstanding
/// work, snapshot both sides. Preview and apply go through the existing
/// commands.
#[tauri::command]
pub(crate) async fn worktree_merge_back_prepare(
    cwd: String,
    path: String,
    target: String,
) -> Result<crate::worktree::merge_back::Prepared, String> {
    let root = canonical_cwd(&cwd)?;
    let worktree =
        crate::git::safe_repo_path(path.trim(), ".").map_err(|e| format!("invalid path: {e}"))?;
    tauri::async_runtime::spawn_blocking(move || {
        // Same lock as the scratch merge-back: no other GitWand write to the
        // repo while the task is committed and both sides snapshotted.
        let _repo = crate::git::repo_lock::write(&root.to_string_lossy());
        crate::worktree::merge_back::prepare(&root, &worktree, &target, |wt| {
            super::worktree_processes::stop_processes_in(&root, wt, false)
        })
    })
    .await
    .map_err(|e| format!("merge-back preparation failed: {e}"))?
}

/// Squash mode: `git merge --squash <task>` in the main checkout.
#[tauri::command]
pub(crate) async fn worktree_merge_back_squash(
    cwd: String,
    path: String,
    target: String,
) -> Result<crate::worktree::merge_back::StepResult, String> {
    let root = canonical_cwd(&cwd)?;
    let worktree =
        crate::git::safe_repo_path(path.trim(), ".").map_err(|e| format!("invalid path: {e}"))?;
    tauri::async_runtime::spawn_blocking(move || {
        crate::worktree::merge_back::squash(&root, &worktree, &target)
    })
    .await
    .map_err(|e| format!("merge-back squash failed: {e}"))?
}

/// Rebase mode, last step: `git merge --ff-only <task>` in the main checkout.
#[tauri::command]
pub(crate) async fn worktree_merge_back_fast_forward(
    cwd: String,
    path: String,
    target: String,
) -> Result<crate::worktree::merge_back::StepResult, String> {
    let root = canonical_cwd(&cwd)?;
    let worktree =
        crate::git::safe_repo_path(path.trim(), ".").map_err(|e| format!("invalid path: {e}"))?;
    tauri::async_runtime::spawn_blocking(move || {
        crate::worktree::merge_back::fast_forward(&root, &worktree, &target)
    })
    .await
    .map_err(|e| format!("merge-back fast-forward failed: {e}"))?
}

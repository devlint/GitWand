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

/// Runs the repository's `setup` hook for `path` in a PTY session streamed on
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
    if hook != "setup" {
        return Err(format!("Unknown worktree hook: {hook}"));
    }
    let spec = crate::worktree::hooks::setup_spec(
        &root,
        &worktree,
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

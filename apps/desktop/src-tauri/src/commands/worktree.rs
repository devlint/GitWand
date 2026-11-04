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

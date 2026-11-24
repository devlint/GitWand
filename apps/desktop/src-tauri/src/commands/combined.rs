//! `git_combined_diff` (v3.15): the net diff of several selected commits.

use crate::combined::replay::combined_diff;
use crate::git::repo_lock;
use crate::types::CombinedDiff;

/// Combined diff of `hashes` (2..=50, any order), optionally limited to
/// `paths`. Read-only: writes only unreachable objects. Runs on a blocking
/// thread — a 50-commit replay spawns a few hundred git processes.
#[tauri::command]
pub(crate) async fn git_combined_diff(
    cwd: String,
    hashes: Vec<String>,
    paths: Option<Vec<String>>,
) -> Result<CombinedDiff, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _repo = repo_lock::read(&cwd);
        combined_diff(&cwd, &hashes, paths.as_deref())
    })
    .await
    .map_err(|e| format!("Combined diff task failed: {e}"))?
}

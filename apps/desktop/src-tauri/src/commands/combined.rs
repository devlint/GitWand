//! `git_combined_diff` (v3.15): the net diff of several selected commits.

use crate::combined::replay::combined_diff;
use crate::types::CombinedDiff;

/// Combined diff of `hashes` (2..=50, any order), optionally limited to
/// `paths` (root-relative; each kept inside the repository by
/// `validate_paths` in `combined/replay.rs`, through `safe_repo_path`). Read-only: writes only unreachable objects. Runs on a blocking
/// thread — a 50-commit replay spawns a few hundred git processes.
///
/// No repo guard for the whole command, unlike the other commands: the
/// replay never touches the index, HEAD, refs or the worktree, it only reads
/// objects by id and writes unreachable ones, which git does safely next to
/// any concurrent process. Holding the shared guard for a replay that can
/// last seconds would block every writer of the repo (and, the lock being
/// fair, every reader queued behind one). The one step that reads the
/// worktree — `check-attr` on `.gitattributes`, which a checkout rewrites —
/// takes the shared guard for its own short spawn (`Repo::merge_driven`).
#[tauri::command]
pub(crate) async fn git_combined_diff(
    cwd: String,
    hashes: Vec<String>,
    paths: Option<Vec<String>>,
) -> Result<CombinedDiff, String> {
    tauri::async_runtime::spawn_blocking(move || combined_diff(&cwd, &hashes, paths.as_deref()))
        .await
        .map_err(|e| format!("Combined diff task failed: {e}"))?
}

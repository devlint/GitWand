//! Live Repo filesystem watcher (v3.10.0).

// TODO(v3.10.0 Task A2): remove once watch_repo_start/coalesce land and use
// these for real; only #[cfg(test)] consumes them at this intermediate step.
#![allow(dead_code)]

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
        assert_eq!(classify_path(".git/rebase-merge/head-name"), Some("mergeState"));
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
}

//! What GitWand may do to a worktree before removing it (spec §7.1).
//!
//! A worktree is **untouchable** when it is locked (`git worktree lock`),
//! has a `.worktree-keep` file at its root, or sits in another tool's
//! worktree directory without a GitWand record. Nothing removes, merges
//! back into or discards an untouchable worktree; the only action offered
//! is the specific unlock.

use crate::worktree::record::{self, WorktreeRecord};
use serde::Serialize;
use std::path::{Path, PathBuf};

/// Other orchestrators' worktree directories, as consecutive path
/// components: Claude Code, Conductor, Superset.
pub(crate) const OTHER_TOOL_DIRS: &[&[&str]] = &[
    &[".claude", "worktrees"],
    &["conductor", "workspaces"],
    &[".superset", "worktrees"],
];

/// The file that marks a worktree as never to be removed by GitWand.
pub(crate) const KEEP_FILE: &str = ".worktree-keep";

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct GuardReport {
    pub untouchable: bool,
    /// `"locked"`, `"keep-file"`, `"other-tool"`.
    pub reasons: Vec<String>,
    /// Created by GitWand: a record, or a pre-v3.13 scratch worktree.
    pub owned: bool,
    /// Has a record in `worktrees.json` (created by the worktree service).
    pub recorded: bool,
    /// The repo defines `teardown` and this worktree is recorded: removal
    /// waits for teardown, or for the user to skip or override it.
    pub teardown_required: bool,
    /// The checked-out branch, `None` when detached.
    pub branch: Option<String>,
    /// The reason given to `git worktree lock --reason`, if any.
    pub lock_reason: Option<String>,
}

/// A linked worktree as `git worktree list --porcelain` describes it.
pub(crate) struct Listed {
    pub path: PathBuf,
    pub branch: Option<String>,
    /// `Some("")` when locked without a reason.
    pub locked: Option<String>,
}

/// `worktree`'s porcelain entry (canonical while it exists) when it is a
/// linked worktree of `repo`: never the main worktree, never a path git
/// does not list.
pub(crate) fn listed(repo: &Path, worktree: &Path) -> Result<Listed, String> {
    let refuse = || {
        format!(
            "Not a linked worktree of this repository: {}",
            worktree.display()
        )
    };
    // A worktree whose directory is gone (a teardown may delete it) is
    // still listed by git until pruned: matched on its raw path then.
    let canon = worktree.canonicalize().ok();
    let out = crate::git::git_cmd()
        .args(["worktree", "list", "--porcelain"])
        .current_dir(repo)
        .output()
        .map_err(|e| format!("cannot run git: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    let text = String::from_utf8_lossy(&out.stdout);
    for block in text.split("\n\n").skip(1) {
        let mut path = None;
        let mut branch = None;
        let mut locked = None;
        for line in block.lines() {
            if let Some(p) = line.strip_prefix("worktree ") {
                path = match &canon {
                    Some(_) => Path::new(p).canonicalize().ok(),
                    None => Some(PathBuf::from(p)),
                };
            } else if let Some(b) = line.strip_prefix("branch ") {
                branch = Some(b.strip_prefix("refs/heads/").unwrap_or(b).to_string());
            } else if line == "locked" {
                locked = Some(String::new());
            } else if let Some(r) = line.strip_prefix("locked ") {
                locked = Some(r.to_string());
            }
        }
        let wanted = canon.as_deref().unwrap_or(worktree);
        if path.as_deref() == Some(wanted) {
            return Ok(Listed {
                path: wanted.to_path_buf(),
                branch,
                locked,
            });
        }
    }
    Err(refuse())
}

fn in_other_tool_dir(path: &Path) -> bool {
    let parts: Vec<String> = path
        .components()
        .map(|c| c.as_os_str().to_string_lossy().to_string())
        .collect();
    OTHER_TOOL_DIRS
        .iter()
        .any(|dir| parts.windows(dir.len()).any(|w| w.iter().eq(dir.iter())))
}

/// A worktree GitWand created before v3.13: the `gitwand-scratch-*`
/// convention, or a branch carrying `gitwandBase`.
fn legacy_owned(repo: &Path, path: &Path, branch: Option<&str>) -> bool {
    let scratch_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.starts_with("gitwand-scratch-"));
    scratch_name
        || branch.is_some_and(|b| {
            crate::git::git_cmd()
                .args(["config", "--get", &format!("branch.{b}.gitwandBase")])
                .current_dir(repo)
                .output()
                .is_ok_and(|o| o.status.success())
        })
}

/// The record for `path`, if GitWand's worktree service created it.
pub(crate) fn record_for(repo: &Path, path: &Path) -> Option<WorktreeRecord> {
    let common = record::common_dir(repo).ok()?;
    record::find(&common, path)
}

pub(crate) fn guard(repo: &Path, worktree: &Path) -> Result<GuardReport, String> {
    let entry = listed(repo, worktree)?;
    let rec = record_for(repo, &entry.path);
    let recorded = rec.is_some();
    let owned = recorded || legacy_owned(repo, &entry.path, entry.branch.as_deref());

    let mut reasons = Vec::new();
    if entry.locked.is_some() {
        reasons.push("locked".to_string());
    }
    if entry.path.join(KEEP_FILE).exists() {
        reasons.push("keep-file".to_string());
    }
    if !recorded && in_other_tool_dir(&entry.path) {
        reasons.push("other-tool".to_string());
    }

    let teardown_required = recorded && {
        let main = crate::commands::worktree_trust::main_worktree_root(&repo.to_string_lossy())?;
        crate::commands::worktree_trust::hooks_from_rc_text(
            &crate::commands::ops::read_gitwandrc_text(&main),
        )
        .teardown
        .is_some()
    };

    Ok(GuardReport {
        untouchable: !reasons.is_empty(),
        reasons,
        owned,
        recorded,
        teardown_required,
        branch: entry.branch,
        lock_reason: entry.locked.filter(|r| !r.is_empty()),
    })
}

/// `Err` naming the reasons when `report` is untouchable. The message
/// starts with `untouchable:` so the frontend can tell it apart.
pub(crate) fn refuse_untouchable(report: &GuardReport, path: &Path) -> Result<(), String> {
    if report.untouchable {
        return Err(format!(
            "untouchable: {} ({}) — GitWand will not remove or modify it.",
            path.display(),
            report.reasons.join(", ")
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::worktree::record::{Kind, WorktreeRecord};
    use crate::worktree::test_support::TempRepo;

    fn add(repo: &TempRepo, rel: &str, branch: &str) -> PathBuf {
        let path = repo.sandbox.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        repo.git(&[
            "worktree",
            "add",
            "-q",
            "-b",
            branch,
            path.to_str().unwrap(),
        ]);
        path.canonicalize().unwrap()
    }

    fn record(repo: &TempRepo, path: &Path, branch: &str) {
        let common = record::common_dir(&repo.path).unwrap();
        record::upsert(
            &common,
            WorktreeRecord {
                path: path.to_string_lossy().to_string(),
                branch: branch.into(),
                base_ref: "main".into(),
                base_commit: repo.git(&["rev-parse", "HEAD"]),
                created_at: 1,
                kind: Kind::Task,
                source_branch: Some("main".into()),
            },
        )
        .unwrap();
    }

    #[test]
    fn guard_reports_a_locked_worktree() {
        let repo = TempRepo::new();
        let wt = add(&repo, "wt/a", "a");
        repo.git(&["worktree", "lock", "--reason", "busy", wt.to_str().unwrap()]);
        let g = guard(&repo.path, &wt).unwrap();
        assert!(g.untouchable);
        assert_eq!(g.reasons, vec!["locked"]);
        assert_eq!(g.lock_reason.as_deref(), Some("busy"));
        assert!(refuse_untouchable(&g, &wt)
            .unwrap_err()
            .starts_with("untouchable:"));
    }

    #[test]
    fn guard_reports_a_keep_file() {
        let repo = TempRepo::new();
        let wt = add(&repo, "wt/a", "a");
        std::fs::write(wt.join(KEEP_FILE), "").unwrap();
        let g = guard(&repo.path, &wt).unwrap();
        assert!(g.untouchable);
        assert_eq!(g.reasons, vec!["keep-file"]);
    }

    #[test]
    fn guard_reports_another_tools_directory_unless_recorded() {
        let repo = TempRepo::new();
        let wt = add(&repo, "repo2/.claude/worktrees/x", "x");
        let g = guard(&repo.path, &wt).unwrap();
        assert_eq!(g.reasons, vec!["other-tool"]);
        assert!(!g.owned);
        record(&repo, &wt, "x");
        let g = guard(&repo.path, &wt).unwrap();
        assert!(!g.untouchable);
        assert!(g.owned && g.recorded);
    }

    #[test]
    fn guard_owned_for_record_and_legacy_scratch() {
        let repo = TempRepo::new();
        let plain = add(&repo, "wt/plain", "plain");
        let g = guard(&repo.path, &plain).unwrap();
        assert!(!g.owned && !g.untouchable);
        assert_eq!(g.branch.as_deref(), Some("plain"));

        let scratch = add(&repo, "gitwand-scratch-1", "gitwand-scratch-1");
        assert!(guard(&repo.path, &scratch).unwrap().owned);

        let based = add(&repo, "wt/based", "based");
        repo.git(&["config", "branch.based.gitwandBase", "abc"]);
        let g = guard(&repo.path, &based).unwrap();
        assert!(g.owned && !g.recorded);
    }

    #[test]
    fn git_worktree_remove_refuses_a_locked_worktree() {
        let repo = TempRepo::new();
        let wt = add(&repo, "wt/a", "a");
        repo.git(&["worktree", "lock", wt.to_str().unwrap()]);
        let err = crate::commands::ops::git_worktree_remove_impl(
            repo.path.to_str().unwrap(),
            wt.to_str().unwrap(),
            Some(true),
        )
        .unwrap_err();
        assert!(err.starts_with("untouchable:"), "{err}");
        assert!(wt.exists());
    }

    #[test]
    fn guard_refuses_the_main_worktree() {
        let repo = TempRepo::new();
        assert!(guard(&repo.path, &repo.path).is_err());
        assert!(guard(&repo.path, &repo.sandbox).is_err());
    }

    #[test]
    fn teardown_required_only_with_a_record_and_a_teardown_hook() {
        let repo = TempRepo::new();
        repo.write(".gitwandrc", r#"{"worktree":{"teardown":"echo bye"}}"#);
        let wt = add(&repo, "wt/a", "a");
        assert!(!guard(&repo.path, &wt).unwrap().teardown_required);
        record(&repo, &wt, "a");
        assert!(guard(&repo.path, &wt).unwrap().teardown_required);
        // From the linked worktree too: hooks come from the main one.
        assert!(guard(&wt, &wt).unwrap().teardown_required);
    }
}

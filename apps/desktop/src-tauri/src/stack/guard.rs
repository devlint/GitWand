//! Refusal guards for restacks: `git rebase --update-refs` silently skips a
//! ref that is checked out, or being rebased, in another worktree. These
//! helpers tell the caller which branches are held, and where.

use crate::commands::ops::list_worktrees;
use crate::git::git_cmd;
use std::path::{Path, PathBuf};

/// `git version 2.39.3 (Apple Git-146)` / `git version 2.45.1.windows.1`
/// → `(2, 39)` / `(2, 45)`.
// Consumed by Task 3 (stack status).
#[allow(dead_code)]
pub(crate) fn parse_git_version(s: &str) -> Option<(u32, u32)> {
    let rest = s.trim().strip_prefix("git version ")?;
    let mut nums = rest.split('.');
    let major = nums.next()?.parse().ok()?;
    let minor = nums.next()?.parse().ok()?;
    Some((major, minor))
}

// Consumed by Task 3 (stack status).
#[allow(dead_code)]
pub(crate) fn git_version() -> Option<(u32, u32)> {
    let out = git_cmd().arg("--version").output().ok()?;
    if !out.status.success() {
        return None;
    }
    parse_git_version(&String::from_utf8_lossy(&out.stdout))
}

/// `--update-refs` landed in git 2.38.
// Consumed by Task 3 (stack status).
#[allow(dead_code)]
pub(crate) fn supports_update_refs(v: Option<(u32, u32)>) -> bool {
    matches!(v, Some(v) if v >= (2, 38))
}

/// A branch held by a worktree: checked out there, or mid-rebase there.
// Consumed by Task 5 (restack planning).
#[allow(dead_code)]
#[derive(Clone, PartialEq, Eq, Debug)]
pub(crate) struct Holder {
    pub branch: String,
    pub worktree: PathBuf,
    pub rebasing: bool,
    pub current: bool,
}

// Consumed by Task 5 (restack planning).
#[allow(dead_code)]
pub(crate) fn branch_holders(repo: &Path) -> Result<Vec<Holder>, String> {
    let top = git_out(repo, &["rev-parse", "--show-toplevel"])?;
    let top = canonical(Path::new(&top));
    let mut holders = Vec::new();
    for wt in list_worktrees(&repo.to_string_lossy())? {
        if wt.is_bare || wt.is_prunable {
            continue;
        }
        let worktree = PathBuf::from(&wt.path);
        let current = canonical(&worktree) == top;
        // (a) The branch the worktree has checked out.
        if !wt.branch.is_empty() && wt.branch != "(detached HEAD)" {
            holders.push(Holder {
                branch: wt.branch.clone(),
                worktree: worktree.clone(),
                rebasing: false,
                current,
            });
        }
        // (b) The branch it is rebasing: HEAD is detached then, the branch
        // survives only in the rebase state's `head-name`.
        let Ok(git_dir) = git_out(&worktree, &["rev-parse", "--absolute-git-dir"]) else {
            continue;
        };
        for state in ["rebase-merge", "rebase-apply"] {
            let head_name = Path::new(&git_dir).join(state).join("head-name");
            let Ok(raw) = std::fs::read_to_string(head_name) else {
                continue;
            };
            if let Some(branch) = raw.trim().strip_prefix("refs/heads/") {
                holders.push(Holder {
                    branch: branch.to_string(),
                    worktree: worktree.clone(),
                    rebasing: true,
                    current,
                });
                break;
            }
        }
    }
    Ok(holders)
}

fn git_out(dir: &Path, args: &[&str]) -> Result<String, String> {
    let out = git_cmd()
        .args(args)
        .current_dir(dir)
        .output()
        .map_err(|e| format!("git {}: {e}", args.first().copied().unwrap_or("")))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// `/var` vs `/private/var` (macOS) and symlinked checkouts compare equal.
fn canonical(p: &Path) -> PathBuf {
    p.canonicalize().unwrap_or_else(|_| p.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::worktree::test_support::{git_at, TempRepo};

    #[test]
    fn parses_git_version_strings() {
        assert_eq!(
            parse_git_version("git version 2.39.3 (Apple Git-146)"),
            Some((2, 39))
        );
        assert_eq!(
            parse_git_version("git version 2.45.1.windows.1"),
            Some((2, 45))
        );
        assert_eq!(parse_git_version("garbage"), None);
        assert!(!supports_update_refs(Some((2, 37))));
        assert!(supports_update_refs(Some((2, 38))));
        assert!(supports_update_refs(Some((3, 0))));
        assert!(!supports_update_refs(None));
    }

    #[test]
    fn git_version_reads_the_installed_git() {
        assert!(git_version().is_some());
    }

    /// main <- step-2 (b.txt); step-2 is left checked out in `<sandbox>/wt`.
    fn step2_in_worktree(r: &TempRepo) -> PathBuf {
        r.git(&["checkout", "-q", "-b", "step-2"]);
        r.commit("b.txt", "mine\n", "s2");
        r.git(&["checkout", "-q", "main"]);
        let wt = r.sandbox.join("wt");
        r.git(&["worktree", "add", "-q", wt.to_str().unwrap(), "step-2"]);
        wt
    }

    #[test]
    fn holders_report_a_branch_checked_out_in_a_linked_worktree() {
        let r = TempRepo::new();
        step2_in_worktree(&r);
        let h = branch_holders(&r.path).unwrap();
        let x = h.iter().find(|h| h.branch == "step-2").unwrap();
        assert!(!x.current && !x.rebasing);
        assert!(x.worktree.ends_with("wt"));
        assert!(h.iter().any(|h| h.branch == "main" && h.current));
    }

    #[test]
    fn holders_report_a_branch_being_rebased_in_a_linked_worktree() {
        let r = TempRepo::new();
        let wt = step2_in_worktree(&r);
        // A conflicting commit on main, then rebase step-2 onto it in wt.
        r.commit("b.txt", "theirs\n", "main b");
        let out = crate::git::git_cmd()
            .args(["rebase", "main"])
            .current_dir(&wt)
            .output()
            .unwrap();
        assert!(!out.status.success(), "rebase should halt on a conflict");
        // Porcelain now shows the worktree detached.
        assert_eq!(git_at(&wt, &["branch", "--show-current"]), "");
        let x = branch_holders(&r.path)
            .unwrap()
            .into_iter()
            .find(|h| h.branch == "step-2")
            .unwrap();
        assert!(x.rebasing && !x.current);
    }
}

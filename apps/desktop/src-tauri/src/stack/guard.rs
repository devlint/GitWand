//! Refusal guards for restacks: `git rebase --update-refs` silently skips a
//! ref that is checked out, or being rebased, in another worktree. These
//! helpers tell the caller which branches are held, and where.

use crate::commands::ops::list_worktrees;
use crate::git::git_cmd;
use std::path::{Path, PathBuf};

/// `git version 2.39.3 (Apple Git-146)` / `git version 2.45.1.windows.1`
/// → `(2, 39)` / `(2, 45)`.
pub(crate) fn parse_git_version(s: &str) -> Option<(u32, u32)> {
    let rest = s.trim().strip_prefix("git version ")?;
    let mut nums = rest.split('.');
    let major = nums.next()?.parse().ok()?;
    let minor = nums.next()?.parse().ok()?;
    Some((major, minor))
}

pub(crate) fn git_version() -> Option<(u32, u32)> {
    let out = git_cmd().arg("--version").output().ok()?;
    if !out.status.success() {
        return None;
    }
    parse_git_version(&String::from_utf8_lossy(&out.stdout))
}

/// `--update-refs` landed in git 2.38.
pub(crate) fn supports_update_refs(v: Option<(u32, u32)>) -> bool {
    matches!(v, Some(v) if v >= (2, 38))
}

/// A branch held by a worktree: checked out there, or mid-rebase there.
#[derive(Clone, PartialEq, Eq, Debug)]
pub(crate) struct Holder {
    pub branch: String,
    pub worktree: PathBuf,
    pub rebasing: bool,
    pub current: bool,
}

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
        let git_dir = git_out(&worktree, &["rev-parse", "--absolute-git-dir"])
            .map_err(|e| format!("cannot inspect worktree {}: {e}", worktree.display()))?;
        for state in ["rebase-merge", "rebase-apply"] {
            let head_name = Path::new(&git_dir).join(state).join("head-name");
            let read = std::fs::read_to_string(&head_name);
            if let Some(branch) = interpret_head_name(&head_name, read)? {
                holders.push(Holder {
                    branch,
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

/// What a rebase state's `head-name` says. Only a missing file means "no
/// rebase here"; any other IO error or unexpected content is an error, since
/// the guard protects user branches and must fail closed.
fn interpret_head_name(
    path: &Path,
    read: std::io::Result<String>,
) -> Result<Option<String>, String> {
    match read {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("cannot read {}: {e}", path.display())),
        Ok(raw) => match raw.trim() {
            // A rebase started from a detached HEAD holds no branch.
            "detached HEAD" => Ok(None),
            name => match name.strip_prefix("refs/heads/") {
                Some(b) if !b.is_empty() => Ok(Some(b.to_string())),
                _ => Err(format!(
                    "unexpected content in {}: {name:?}",
                    path.display()
                )),
            },
        },
    }
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

    #[test]
    fn head_name_missing_file_means_no_rebase() {
        let e = std::io::Error::from(std::io::ErrorKind::NotFound);
        assert_eq!(interpret_head_name(Path::new("p"), Err(e)), Ok(None));
    }

    #[test]
    fn head_name_other_io_errors_fail_closed() {
        let e = std::io::Error::from(std::io::ErrorKind::PermissionDenied);
        assert!(interpret_head_name(Path::new("p"), Err(e)).is_err());
    }

    #[test]
    fn head_name_interprets_branch_detached_and_garbage() {
        let p = Path::new("p");
        assert_eq!(
            interpret_head_name(p, Ok("refs/heads/feat/x\n".into())),
            Ok(Some("feat/x".into()))
        );
        assert_eq!(
            interpret_head_name(p, Ok("detached HEAD\n".into())),
            Ok(None)
        );
        assert!(interpret_head_name(p, Ok("refs/tags/v1\n".into())).is_err());
        assert!(interpret_head_name(p, Ok("refs/heads/\n".into())).is_err());
        assert!(interpret_head_name(p, Ok("".into())).is_err());
    }

    #[test]
    fn holders_fail_closed_when_a_worktree_cannot_be_inspected() {
        let r = TempRepo::new();
        let wt = step2_in_worktree(&r);
        // Keep the admin dir (so git still lists and does not prune it) but
        // point the linked worktree's `.git` file at nothing.
        std::fs::write(wt.join(".git"), "gitdir: /nonexistent/gitwand-guard\n").unwrap();
        let err = branch_holders(&r.path).unwrap_err();
        assert!(
            err.contains("cannot inspect worktree") && err.contains(wt.to_str().unwrap()),
            "error should name the worktree: {err}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn holders_fail_closed_when_head_name_is_unreadable() {
        use std::os::unix::fs::PermissionsExt;
        let r = TempRepo::new();
        let wt = step2_in_worktree(&r);
        r.commit("b.txt", "theirs\n", "main b");
        let out = git_cmd()
            .args(["rebase", "main"])
            .current_dir(&wt)
            .output()
            .unwrap();
        assert!(!out.status.success());
        let head_name = PathBuf::from(git_at(&wt, &["rev-parse", "--absolute-git-dir"]))
            .join("rebase-merge")
            .join("head-name");
        std::fs::set_permissions(&head_name, std::fs::Permissions::from_mode(0o000)).unwrap();
        let unreadable = std::fs::read_to_string(&head_name).is_err();
        let res = branch_holders(&r.path);
        std::fs::set_permissions(&head_name, std::fs::Permissions::from_mode(0o644)).unwrap();
        // root reads a 0o000 file: the precondition cannot be set up there.
        if unsafe { libc::geteuid() } == 0 {
            eprintln!("skipped: running as root, a 0o000 head-name stays readable");
            return;
        }
        assert!(unreadable, "precondition: head-name must be unreadable");
        let err = res.unwrap_err();
        assert!(err.contains("cannot read"), "{err}");
    }

    #[test]
    fn rebase_in_the_current_worktree_is_current_and_rebasing() {
        let r = TempRepo::new();
        r.git(&["checkout", "-q", "-b", "step-2"]);
        r.commit("b.txt", "mine\n", "s2");
        r.git(&["checkout", "-q", "main"]);
        r.commit("b.txt", "theirs\n", "main b");
        r.git(&["checkout", "-q", "step-2"]);
        let out = git_cmd()
            .args(["rebase", "main"])
            .current_dir(&r.path)
            .output()
            .unwrap();
        assert!(!out.status.success());
        let h = branch_holders(&r.path).unwrap();
        let x = h.iter().find(|h| h.branch == "step-2").unwrap();
        assert!(x.current && x.rebasing);
    }

    #[test]
    fn prunable_worktrees_are_skipped() {
        let r = TempRepo::new();
        let wt = step2_in_worktree(&r);
        std::fs::remove_dir_all(&wt).unwrap();
        let h = branch_holders(&r.path).unwrap();
        assert!(h.iter().all(|h| h.branch != "step-2"), "{h:?}");
        assert!(h.iter().any(|h| h.branch == "main" && h.current));
    }

    #[test]
    fn bare_entries_are_skipped() {
        let r = TempRepo::new();
        let bare = r.sandbox.join("bare.git");
        git_at(
            &r.sandbox,
            &[
                "clone",
                "-q",
                "--bare",
                r.path.to_str().unwrap(),
                bare.to_str().unwrap(),
            ],
        );
        let wt = r.sandbox.join("bare-wt");
        git_at(
            &bare,
            &["worktree", "add", "-q", wt.to_str().unwrap(), "main"],
        );
        let h = branch_holders(&wt).unwrap();
        assert_eq!(h.len(), 1, "{h:?}");
        assert!(h[0].branch == "main" && h[0].current);
    }
}

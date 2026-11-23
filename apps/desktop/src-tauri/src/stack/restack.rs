//! Restack planning (spec §5.4, D2, D8, D15, D16, D20, D21): what a restack
//! of one layer would do — which commits move onto what, which branches
//! `--update-refs` would carry along — and every reason to refuse it.

use super::detect::{behind_upstream, is_sha, resolve_commit, status};
use super::guard::{branch_holders, supports_update_refs, Holder};
use super::meta::{read_all, validate_branch_name};
use super::{
    LayerState, LayerStatus, MergedParentHint, Moment, MovingRef, RestackPlan, RestackRefusal,
};
use crate::git::git_cmd;
use std::collections::BTreeMap;
use std::path::Path;
use std::process::Output;

fn run(repo: &Path, args: &[&str]) -> Result<Output, String> {
    git_cmd()
        .args(args)
        .current_dir(repo)
        .output()
        .map_err(|e| format!("git {}: {e}", args.first().copied().unwrap_or("")))
}

fn run_ok(repo: &Path, args: &[&str]) -> Result<String, String> {
    let out = run(repo, args)?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(format!(
            "git {}: {}",
            args.first().copied().unwrap_or(""),
            String::from_utf8_lossy(&out.stderr).trim()
        ))
    }
}

/// Where the layer's commits go, before any refusal is considered.
struct Target {
    moment: Moment,
    onto_ref: String,
    /// `None` when `onto_ref` does not exist (moment 2 without a remote trunk).
    onto_sha: Option<String>,
    /// `None` when no old base exists locally (D20).
    upstream_sha: Option<String>,
    new_parent: Option<String>,
    /// Commits the local `onto_ref` lacks from its own upstream.
    onto_behind: u32,
}

/// The restack of `layer`'s chain from `layer` up (spec §5.4). Err only for a
/// branch that is not a restackable layer, or when the repo cannot be read;
/// every refusable condition is reported in `refusal`, first one wins, in the
/// order of the refusal-code list.
// Consumed by Task 5 (run) and Task 6 (Tauri commands) of the stacked-branches plan.
#[allow(dead_code)]
pub(crate) fn plan(
    repo: &Path,
    configured_trunk: Option<&str>,
    layer: &str,
    hints: &[MergedParentHint],
    git_version: Option<(u32, u32)>,
) -> Result<RestackPlan, String> {
    validate_branch_name(layer)?;
    let report = status(repo, configured_trunk, hints)?;
    let l = report
        .layers
        .iter()
        .find(|l| l.branch == layer)
        .ok_or_else(|| format!("not a stacked branch: {layer}"))?;
    let trunk = report.trunk.as_deref().unwrap_or_default();
    let target = match l.state {
        LayerState::ParentMissing => {
            return Err(format!(
                "cannot restack {layer}: its parent {} is missing",
                l.parent
            ))
        }
        LayerState::BaseLost => {
            return Err(format!(
                "cannot restack {layer}: neither {} nor its recorded base is below it",
                l.parent
            ))
        }
        LayerState::UpToDate | LayerState::OutOfDate => parent_moved(l)?,
        LayerState::ParentMerged => parent_merged(repo, l, hints, trunk)?,
    };
    let top_sha = resolve_commit(repo, &format!("refs/heads/{}", l.top))?
        .ok_or_else(|| format!("unknown branch: {}", l.top))?;
    let stack: Vec<String> = report
        .layers
        .iter()
        .filter(|x| x.top == l.top)
        .map(|x| x.branch.clone())
        .collect();
    let moving = match target.upstream_sha.as_deref() {
        Some(up) => moving_refs(repo, up, &l.top, &stack)?,
        None => Vec::new(),
    };
    let holders = branch_holders(repo)?;
    let rebase_in_progress = report.rebase_in_progress
        || holders.iter().any(|h| h.current && h.rebasing)
        || rebasing_here(repo)?;
    let refusal = first_refusal(Checks {
        repo,
        l,
        target: &target,
        trunk,
        moving: &moving,
        holders: &holders,
        rebase_in_progress,
        git_version,
    })?;
    Ok(RestackPlan {
        moment: target.moment,
        bottom: l.branch.clone(),
        parent: l.parent.clone(),
        onto_ref: target.onto_ref,
        onto_sha: target.onto_sha.unwrap_or_default(),
        upstream_sha: target.upstream_sha.unwrap_or_default(),
        top: l.top.clone(),
        top_sha,
        moving,
        new_parent: target.new_parent,
        refusal,
    })
}

/// Moment 1: replay `base..top` onto the parent's new tip. The parent does
/// not change, so `new_parent` is `None`. An up-to-date layer gets the same
/// shape (with nothing to replay) and is refused `up_to_date`.
fn parent_moved(l: &LayerStatus) -> Result<Target, String> {
    let tip = l
        .parent_tip
        .clone()
        .ok_or_else(|| format!("unknown branch: {}", l.parent))?;
    let upstream = match l.state {
        LayerState::OutOfDate => l.base.clone(),
        _ => Some(tip.clone()),
    };
    Ok(Target {
        moment: Moment::ParentMoved,
        onto_ref: l.parent.clone(),
        onto_sha: Some(tip),
        upstream_sha: upstream,
        new_parent: None,
        onto_behind: l.parent_behind_upstream,
    })
}

/// Moment 2: the parent P is merged. Replay `old-P-tip..top` onto P's own
/// parent P' — the local branch when P' is a non-trunk branch (D8), else
/// `origin/<trunk>` with `new_parent = None`. The old tip is the recorded
/// base, or failing that the head of the merged PR status honoured (D20).
fn parent_merged(
    repo: &Path,
    l: &LayerStatus,
    hints: &[MergedParentHint],
    trunk: &str,
) -> Result<Target, String> {
    let all = read_all(repo)?;
    let grand = all
        .get(&l.parent)
        .map(|m| m.parent.clone())
        .filter(|g| g != trunk);
    let (onto_ref, onto_sha, new_parent, onto_behind) = match grand {
        Some(g) => {
            let sha = resolve_commit(repo, &format!("refs/heads/{g}"))?
                .ok_or_else(|| format!("unknown branch: {g}"))?;
            let behind = behind_upstream(repo, &g);
            (g.clone(), Some(sha), Some(g), behind)
        }
        None => {
            let sha = resolve_commit(repo, &format!("refs/remotes/origin/{trunk}"))?;
            (format!("origin/{trunk}"), sha, None, 0)
        }
    };
    let honoured = hints
        .iter()
        .find(|h| h.branch == l.parent && l.merged_pr == Some(h.number));
    let mut upstream = None;
    for candidate in [
        l.base.as_deref(),
        honoured.and_then(|h| h.head_ref_oid.as_deref()),
    ]
    .into_iter()
    .flatten()
    {
        if commit_exists(repo, candidate)? {
            upstream = Some(candidate.to_string());
            break;
        }
    }
    Ok(Target {
        moment: Moment::ParentMerged,
        onto_ref,
        onto_sha,
        upstream_sha: upstream,
        new_parent,
        onto_behind,
    })
}

/// `git cat-file -e <sha>^{commit}` (D20). A non-sha is never a commit.
fn commit_exists(repo: &Path, sha: &str) -> Result<bool, String> {
    if !is_sha(sha) {
        return Ok(false);
    }
    let out = run(repo, &["cat-file", "-e", &format!("{sha}^{{commit}}")])?;
    Ok(out.status.success())
}

/// A rebase halted in this worktree, whatever it rebases (a detached HEAD
/// included, which no `Holder` reports).
fn rebasing_here(repo: &Path) -> Result<bool, String> {
    for state in ["rebase-merge", "rebase-apply"] {
        let p = run_ok(repo, &["rev-parse", "--git-path", state])?;
        let p = Path::new(&p);
        let p = if p.is_absolute() {
            p.to_path_buf()
        } else {
            repo.join(p)
        };
        if p.exists() {
            return Ok(true);
        }
    }
    Ok(false)
}

struct Checks<'a> {
    repo: &'a Path,
    l: &'a LayerStatus,
    target: &'a Target,
    trunk: &'a str,
    moving: &'a [MovingRef],
    holders: &'a [Holder],
    rebase_in_progress: bool,
    git_version: Option<(u32, u32)>,
}

fn refusal(code: &str, message: String) -> Option<RestackRefusal> {
    Some(RestackRefusal {
        code: code.into(),
        message,
        branch: None,
        path: None,
    })
}

/// The first refusal in the order `rebase_in_progress`, `up_to_date`,
/// `git_too_old`, `detached`, `dirty`, `occupied`, `parent_behind`,
/// `no_remote_trunk`, `no_old_base`.
fn first_refusal(c: Checks) -> Result<Option<RestackRefusal>, String> {
    if c.rebase_in_progress {
        return Ok(refusal(
            "rebase_in_progress",
            "A rebase is in progress. Finish or abort it first.".into(),
        ));
    }
    if c.l.state == LayerState::UpToDate {
        return Ok(refusal(
            "up_to_date",
            format!("{} is already up to date with {}.", c.l.branch, c.l.parent),
        ));
    }
    if !supports_update_refs(c.git_version) {
        let found = c
            .git_version
            .map(|(maj, min)| format!("{maj}.{min}"))
            .unwrap_or_else(|| "unknown".into());
        return Ok(refusal(
            "git_too_old",
            format!("Restacking needs git 2.38 or later (found {found})."),
        ));
    }
    // D16: `symbolic-ref -q` exits 1 on a detached HEAD.
    let head = run(c.repo, &["symbolic-ref", "-q", "HEAD"])?;
    match head.status.code() {
        Some(0) => {}
        Some(1) => {
            return Ok(refusal(
                "detached",
                "HEAD is detached. Check out a branch first.".into(),
            ))
        }
        _ => {
            return Err(format!(
                "git symbolic-ref HEAD: {}",
                String::from_utf8_lossy(&head.stderr).trim()
            ))
        }
    }
    // D15: tracked changes only, git rebase's own rule.
    if !run_ok(c.repo, &["status", "--porcelain", "--untracked-files=no"])?.is_empty() {
        return Ok(refusal(
            "dirty",
            "You have uncommitted changes to tracked files. Commit or stash them first.".into(),
        ));
    }
    // D21: `--update-refs` skips a ref held by another worktree.
    for m in c.moving {
        if let Some(h) = c
            .holders
            .iter()
            .find(|h| h.branch == m.branch && !h.current)
        {
            let path = h.worktree.to_string_lossy().to_string();
            let how = if h.rebasing {
                "being rebased"
            } else {
                "checked out"
            };
            return Ok(Some(RestackRefusal {
                code: "occupied".into(),
                message: format!("{} is {how} in another worktree ({path}).", m.branch),
                branch: Some(m.branch.clone()),
                path: Some(path),
            }));
        }
    }
    let t = c.target;
    if t.onto_behind > 0 {
        return Ok(refusal(
            "parent_behind",
            format!(
                "{} is {} commit(s) behind its upstream. Pull it first.",
                t.onto_ref, t.onto_behind
            ),
        ));
    }
    if t.onto_sha.is_none() {
        return Ok(refusal(
            "no_remote_trunk",
            format!(
                "There is no origin/{} to restack onto. Fetch from origin first.",
                c.trunk
            ),
        ));
    }
    if t.upstream_sha.is_none() {
        return Ok(refusal(
            "no_old_base",
            format!(
                "The commit {} pointed to before its merge is not available locally.",
                c.l.parent
            ),
        ));
    }
    Ok(None)
}

/// D21: every local branch whose tip is in `upstream..top` (`top` included),
/// stack layer or not — what `git rebase --update-refs` moves. Ordered bottom
/// to top, then by name.
pub(crate) fn moving_refs(
    repo: &Path,
    upstream: &str,
    top: &str,
    stack: &[String],
) -> Result<Vec<MovingRef>, String> {
    if upstream.starts_with('-') {
        return Err(format!("invalid ref: {upstream}"));
    }
    validate_branch_name(top)?;
    let range = format!("{upstream}..refs/heads/{top}");
    let commits = run_ok(repo, &["rev-list", "--reverse", &range, "--"])?;
    let position: BTreeMap<&str, usize> = commits
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .enumerate()
        .map(|(i, sha)| (sha, i))
        .collect();
    let refs = run_ok(
        repo,
        &[
            "for-each-ref",
            "--format=%(objectname) %(refname) %(upstream) %(upstream:short)",
            "refs/heads/",
        ],
    )?;
    let mut out = Vec::new();
    for line in refs.lines() {
        let mut f = line.split(' ');
        let (Some(sha), Some(refname)) = (f.next(), f.next()) else {
            continue;
        };
        let Some(&pos) = position.get(sha) else {
            continue;
        };
        let Some(branch) = refname.strip_prefix("refs/heads/") else {
            continue;
        };
        let upstream_ref = f.next().unwrap_or_default();
        let upstream_short = f.next().unwrap_or_default();
        let remote_sha = if upstream_ref.is_empty() {
            None
        } else {
            resolve_commit(repo, upstream_ref)?
        };
        out.push((
            pos,
            MovingRef {
                branch: branch.to_string(),
                in_stack: stack.iter().any(|s| s == branch),
                upstream: (!upstream_short.is_empty()).then(|| upstream_short.to_string()),
                remote_sha,
            },
        ));
    }
    out.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.branch.cmp(&b.1.branch)));
    Ok(out.into_iter().map(|(_, m)| m).collect())
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::stack::meta::set_parent;
    use crate::stack::{MergedParentHint, Moment, RestackPlan};
    use crate::worktree::test_support::{git_at, TempRepo};

    const V: Option<(u32, u32)> = Some((2, 54));

    /// main <- step-1 (a.txt) <- step-2 (b.txt) <- step-3 (c.txt); step-2
    /// and step-3 are declared layers, step-3 is left checked out.
    fn stack3(r: &TempRepo) {
        r.git(&["checkout", "-q", "-b", "step-1"]);
        r.commit("a.txt", "1\n", "s1");
        r.git(&["checkout", "-q", "-b", "step-2"]);
        r.commit("b.txt", "2\n", "s2");
        r.git(&["checkout", "-q", "-b", "step-3"]);
        r.commit("c.txt", "3\n", "s3");
        set_parent(&r.path, Some("main"), "step-2", "step-1").unwrap();
        set_parent(&r.path, Some("main"), "step-3", "step-2").unwrap();
    }

    /// stack3, then one more commit on step-1 (moment 1 for step-2).
    /// Returns step-1's tip before that commit.
    fn moved_stack(r: &TempRepo) -> String {
        stack3(r);
        let old = r.git(&["rev-parse", "step-1"]);
        r.git(&["checkout", "-q", "step-1"]);
        r.commit("a2.txt", "more\n", "s1 more");
        r.git(&["checkout", "-q", "step-3"]);
        old
    }

    /// Squash-merge step-1 on origin/main, local main left behind.
    fn squash_step1_on_origin(r: &TempRepo) {
        r.add_bare_origin();
        r.git(&["checkout", "-q", "main"]);
        r.git(&["merge", "-q", "--squash", "step-1"]);
        r.git(&["commit", "-q", "-m", "step 1 (squash)"]);
        r.git(&["push", "-q", "origin", "main"]);
        r.git(&["reset", "-q", "--hard", "HEAD~1"]);
        r.git(&["checkout", "-q", "step-3"]);
    }

    fn names(m: &[MovingRef]) -> Vec<&str> {
        m.iter().map(|m| m.branch.as_str()).collect()
    }

    fn code(p: Result<RestackPlan, String>) -> String {
        p.unwrap().refusal.map(|r| r.code).unwrap_or_default()
    }

    fn hint(branch: &str, oid: Option<String>) -> MergedParentHint {
        MergedParentHint {
            branch: branch.into(),
            number: 812,
            head_ref_oid: oid,
        }
    }

    #[test]
    fn plan_moment_one_rebases_from_base_onto_parent() {
        let r = TempRepo::new();
        let old_step1_tip = moved_stack(&r);
        let p = plan(&r.path, Some("main"), "step-2", &[], V).unwrap();
        assert_eq!(p.moment, Moment::ParentMoved);
        assert_eq!(p.bottom, "step-2");
        assert_eq!(p.parent, "step-1");
        assert_eq!(p.onto_ref, "step-1");
        assert_eq!(p.onto_sha, r.git(&["rev-parse", "step-1"]));
        assert_eq!(p.upstream_sha, old_step1_tip);
        assert_eq!(p.top, "step-3");
        assert_eq!(p.top_sha, r.git(&["rev-parse", "step-3"]));
        assert_eq!(names(&p.moving), ["step-2", "step-3"]);
        assert!(p.moving.iter().all(|m| m.in_stack));
        assert_eq!(p.new_parent, None);
        assert!(p.refusal.is_none(), "{:?}", p.refusal);
    }

    #[test]
    fn plan_moment_two_targets_origin_trunk_with_new_parent_none() {
        let r = TempRepo::new();
        stack3(&r);
        let step2_base = r.git(&["config", "branch.step-2.gitwandStackBase"]);
        squash_step1_on_origin(&r);
        let p = plan(&r.path, Some("main"), "step-2", &[], V).unwrap();
        assert_eq!(p.moment, Moment::ParentMerged);
        assert_eq!(p.onto_ref, "origin/main");
        assert_eq!(p.onto_sha, r.git(&["rev-parse", "origin/main"]));
        assert_eq!(p.upstream_sha, step2_base);
        assert_eq!(p.new_parent, None);
        assert_eq!(p.top, "step-3");
        assert_eq!(names(&p.moving), ["step-2", "step-3"]);
        assert!(p.refusal.is_none(), "{:?}", p.refusal);
    }

    #[test]
    fn plan_moment_two_under_a_stacked_grandparent_targets_it() {
        let r = TempRepo::new();
        stack3(&r);
        let step3_base = r.git(&["config", "branch.step-3.gitwandStackBase"]);
        // step-2's PR (based on step-1) is merged into step-1.
        r.git(&["checkout", "-q", "step-1"]);
        r.git(&["merge", "-q", "--squash", "step-2"]);
        r.git(&["commit", "-q", "-m", "step 2 (squash)"]);
        r.git(&["checkout", "-q", "step-3"]);
        let h = [hint("step-2", None)];
        let p = plan(&r.path, Some("main"), "step-3", &h, V).unwrap();
        assert_eq!(p.moment, Moment::ParentMerged);
        assert_eq!(p.parent, "step-2");
        assert_eq!(p.onto_ref, "step-1");
        assert_eq!(p.onto_sha, r.git(&["rev-parse", "step-1"]));
        assert_eq!(p.upstream_sha, step3_base);
        assert_eq!(p.new_parent.as_deref(), Some("step-1"));
        assert_eq!(names(&p.moving), ["step-3"]);
        assert!(p.refusal.is_none(), "{:?}", p.refusal);
    }

    #[test]
    fn plan_without_base_uses_head_ref_oid_else_refuses() {
        let r = TempRepo::new();
        stack3(&r);
        let old_tip = r.git(&["rev-parse", "step-1"]);
        squash_step1_on_origin(&r);
        r.git(&["config", "--unset", "branch.step-2.gitwandStackBase"]);
        let p = &r.path;
        let h = [hint("step-1", Some(old_tip.clone()))];
        let got = plan(p, Some("main"), "step-2", &h, V).unwrap();
        assert_eq!(got.upstream_sha, old_tip);
        assert!(got.refusal.is_none(), "{:?}", got.refusal);
        let h2 = [hint("step-1", None)];
        assert_eq!(code(plan(p, Some("main"), "step-2", &h2, V)), "no_old_base");
        let h3 = [MergedParentHint {
            head_ref_oid: Some("f".repeat(40)),
            ..h2[0].clone()
        }];
        assert_eq!(code(plan(p, Some("main"), "step-2", &h3, V)), "no_old_base");
    }

    #[test]
    fn plan_refuses_a_layer_checked_out_in_another_worktree() {
        let r = TempRepo::new();
        moved_stack(&r);
        r.git(&["checkout", "-q", "main"]);
        let wt = r.sandbox.join("wt");
        r.git(&["worktree", "add", "-q", wt.to_str().unwrap(), "step-3"]);
        let rf = plan(&r.path, Some("main"), "step-2", &[], V)
            .unwrap()
            .refusal
            .unwrap();
        assert_eq!(rf.code, "occupied");
        assert_eq!(rf.branch.as_deref(), Some("step-3"));
        assert!(rf.path.unwrap().ends_with("wt"));
    }

    #[test]
    fn plan_allows_a_layer_checked_out_in_the_current_worktree() {
        let r = TempRepo::new();
        moved_stack(&r);
        r.git(&["checkout", "-q", "step-2"]);
        let p = plan(&r.path, Some("main"), "step-2", &[], V).unwrap();
        assert!(p.refusal.is_none(), "{:?}", p.refusal);
    }

    #[test]
    fn plan_lists_a_non_stack_branch_inside_the_range() {
        let r = TempRepo::new();
        moved_stack(&r);
        r.git(&["branch", "backup", "step-2"]);
        let p = plan(&r.path, Some("main"), "step-2", &[], V).unwrap();
        assert_eq!(names(&p.moving), ["backup", "step-2", "step-3"]);
        let b = p.moving.iter().find(|m| m.branch == "backup").unwrap();
        assert!(!b.in_stack);
        assert!(p.refusal.is_none(), "{:?}", p.refusal);
    }

    #[test]
    fn plan_refuses_when_a_non_stack_branch_in_range_is_checked_out_elsewhere() {
        let r = TempRepo::new();
        moved_stack(&r);
        r.git(&["branch", "backup", "step-2"]);
        let wt = r.sandbox.join("wt");
        r.git(&["worktree", "add", "-q", wt.to_str().unwrap(), "backup"]);
        let rf = plan(&r.path, Some("main"), "step-2", &[], V)
            .unwrap()
            .refusal
            .unwrap();
        assert_eq!(rf.code, "occupied");
        assert_eq!(rf.branch.as_deref(), Some("backup"));
        assert!(rf.path.unwrap().ends_with("wt"));
    }

    #[test]
    fn plan_refuses_a_non_stack_branch_being_rebased_elsewhere() {
        let r = TempRepo::new();
        moved_stack(&r);
        r.git(&["branch", "backup", "step-2"]);
        let wt = r.sandbox.join("wt");
        r.git(&["worktree", "add", "-q", wt.to_str().unwrap(), "backup"]);
        // `clash` edits b.txt the other way: rebasing backup onto it halts
        // on step-2's commit, and backup still points at step-2's tip.
        r.git(&["checkout", "-q", "-b", "clash", "main"]);
        r.commit("b.txt", "clash\n", "clash");
        r.git(&["checkout", "-q", "step-3"]);
        let out = crate::git::git_cmd()
            .args(["rebase", "clash"])
            .current_dir(&wt)
            .output()
            .unwrap();
        assert!(!out.status.success(), "rebase should halt on a conflict");
        assert_eq!(git_at(&wt, &["branch", "--show-current"]), "");
        let rf = plan(&r.path, Some("main"), "step-2", &[], V)
            .unwrap()
            .refusal
            .unwrap();
        assert_eq!(rf.code, "occupied", "{rf:?}");
        assert_eq!(rf.branch.as_deref(), Some("backup"));
    }

    #[test]
    fn plan_refuses_dirty_detached_old_git_and_parent_behind() {
        let r = TempRepo::new();
        moved_stack(&r);
        let p = &r.path;
        // Untracked file alone: not dirty (D15).
        r.write("untracked.txt", "u\n");
        assert_eq!(code(plan(p, Some("main"), "step-2", &[], V)), "");
        // Tracked edit: dirty.
        r.write("c.txt", "edited\n");
        assert_eq!(code(plan(p, Some("main"), "step-2", &[], V)), "dirty");
        r.git(&["checkout", "-q", "--", "c.txt"]);
        // Old git, checked before detached and dirty.
        let rf = plan(p, Some("main"), "step-2", &[], Some((2, 37)))
            .unwrap()
            .refusal
            .unwrap();
        assert_eq!(rf.code, "git_too_old");
        assert_eq!(
            rf.message,
            "Restacking needs git 2.38 or later (found 2.37)."
        );
        // Detached HEAD (D16).
        r.git(&["checkout", "-q", "--detach"]);
        assert_eq!(code(plan(p, Some("main"), "step-2", &[], V)), "detached");
        r.git(&["checkout", "-q", "step-3"]);
        // origin/step-1 has a commit the local step-1 lacks.
        r.add_bare_origin();
        r.git(&["checkout", "-q", "step-1"]);
        r.commit("remote.txt", "r\n", "suggestion");
        r.git(&["push", "-q", "-u", "origin", "step-1"]);
        r.git(&["reset", "-q", "--hard", "HEAD~1"]);
        r.git(&["checkout", "-q", "step-3"]);
        assert_eq!(
            code(plan(p, Some("main"), "step-2", &[], V)),
            "parent_behind"
        );
    }

    #[test]
    fn plan_moment_two_without_origin_refuses_no_remote_trunk() {
        let r = TempRepo::new();
        stack3(&r);
        let h = [hint("step-1", None)];
        let p = plan(&r.path, Some("main"), "step-2", &h, V).unwrap();
        assert_eq!(p.moment, Moment::ParentMerged);
        assert_eq!(p.refusal.unwrap().code, "no_remote_trunk");
    }

    #[test]
    fn plan_records_remote_sha_of_each_upstream() {
        let r = TempRepo::new();
        stack3(&r);
        r.add_bare_origin();
        r.git(&["push", "-q", "-u", "origin", "step-2"]);
        r.git(&["checkout", "-q", "step-1"]);
        r.commit("a2.txt", "more\n", "s1 more");
        r.git(&["checkout", "-q", "step-3"]);
        let p = plan(&r.path, Some("main"), "step-2", &[], V).unwrap();
        let s2 = p.moving.iter().find(|m| m.branch == "step-2").unwrap();
        assert_eq!(s2.upstream.as_deref(), Some("origin/step-2"));
        assert_eq!(
            s2.remote_sha.as_deref(),
            Some(r.git(&["rev-parse", "origin/step-2"]).as_str())
        );
        let s3 = p.moving.iter().find(|m| m.branch == "step-3").unwrap();
        assert_eq!(s3.upstream, None);
        assert_eq!(s3.remote_sha, None);
    }

    #[test]
    fn plan_refuses_up_to_date_and_a_rebase_in_the_current_worktree() {
        let r = TempRepo::new();
        stack3(&r);
        let p = &r.path;
        assert_eq!(code(plan(p, Some("main"), "step-2", &[], V)), "up_to_date");
        // A rebase halted in the current worktree, on a branch outside the
        // stack: still a rebase in progress here.
        r.git(&["checkout", "-q", "-b", "other", "main"]);
        r.commit("README.md", "other\n", "other");
        r.git(&["checkout", "-q", "main"]);
        r.commit("README.md", "main\n", "main edit");
        r.git(&["checkout", "-q", "other"]);
        let out = crate::git::git_cmd()
            .args(["rebase", "main"])
            .current_dir(p)
            .output()
            .unwrap();
        assert!(!out.status.success());
        assert_eq!(
            code(plan(p, Some("main"), "step-2", &[], V)),
            "rebase_in_progress"
        );
    }

    #[test]
    fn plan_errors_for_unknown_layers_and_unrestackable_states() {
        let r = TempRepo::new();
        stack3(&r);
        let p = &r.path;
        assert!(plan(p, Some("main"), "nope", &[], V).is_err());
        assert!(plan(p, Some("main"), "step-1", &[], V).is_err());
        assert!(plan(p, Some("main"), "-x", &[], V).is_err());
        // base_lost
        r.git(&["rebase", "-q", "--onto", "main", "step-1", "step-3"]);
        let e = plan(p, Some("main"), "step-3", &[], V).unwrap_err();
        assert!(e.contains("step-3"), "{e}");
        // parent_missing
        r.git(&["branch", "-m", "step-1", "step-one"]);
        let e = plan(p, Some("main"), "step-2", &[], V).unwrap_err();
        assert!(e.contains("step-2"), "{e}");
    }
}

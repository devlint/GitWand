//! Restack planning (spec §5.4, D2, D8, D15, D16, D20, D21): what a restack
//! of one layer would do — which commits move onto what, which branches
//! `--update-refs` would carry along — and every reason to refuse it.

use super::detect::{
    behind_upstream, is_ancestor, is_sha, propagate, resolve_commit, status_inner,
};
use super::guard::{branch_holders, supports_update_refs, Holder};
use super::meta::{
    clear_pending, read_all, set_base, set_pending, unset, validate_branch_name, write_parent,
};
use super::{
    FinalizedRestack, LayerState, LayerStatus, MergedParentHint, Moment, MovingRef, PendingRestack,
    PreviewedRestack, RestackPlan, RestackRefusal, RestackRun, StackMeta, SwitchError,
};
use crate::git::git_cmd;
use std::collections::BTreeMap;
use std::path::Path;
use std::process::Output;

fn exec(repo: &Path, args: &[&str]) -> Result<Output, String> {
    git_cmd()
        .args(args)
        .current_dir(repo)
        .output()
        .map_err(|e| format!("git {}: {e}", args.first().copied().unwrap_or("")))
}

fn run_ok(repo: &Path, args: &[&str]) -> Result<String, String> {
    let out = exec(repo, args)?;
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
pub(crate) fn plan(
    repo: &Path,
    configured_trunk: Option<&str>,
    layer: &str,
    hints: &[MergedParentHint],
    git_version: Option<(u32, u32)>,
) -> Result<RestackPlan, String> {
    validate_branch_name(layer)?;
    // Never settles: finalizing is `status`'s job alone (D5).
    let (report, blocked) = status_inner(repo, configured_trunk, hints, false)?;
    let l = report
        .layers
        .iter()
        .find(|l| l.branch == layer)
        .ok_or_else(|| format!("not a stacked branch: {layer}"))?;
    // A pending record of this stack (running, finished or failed) has not
    // been settled by a refresh: a new record would replace it.
    if let Some(reason) = blocked.get(layer) {
        return Err(reason.clone());
    }
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
    let holders = branch_holders(repo)?;
    let rebase_in_progress = report.rebase_in_progress
        || holders.iter().any(|h| h.current && h.rebasing)
        || rebasing_here(repo)?;
    // The layers of `layer`'s chain, bottom to top.
    let chain: Vec<&LayerStatus> = report.layers.iter().filter(|x| x.top == l.top).collect();
    let pos = chain
        .iter()
        .position(|x| x.branch == layer)
        .ok_or_else(|| format!("not a stacked branch: {layer}"))?;
    // Only the lowest layer needing a restack can be restacked: a layer above
    // it would be replayed onto a parent that is about to move. A merged
    // parent being dropped by the layer above neither blocks nor restacks.
    // Same rule as `status` (`detect::propagate`).
    if !rebase_in_progress {
        let flow = propagate(&chain)[pos];
        if let Some(b) = flow.blocker {
            return Err(format!("restack {} first", chain[b].branch));
        }
        if let Some(up) = flow.dropped_for {
            return Err(format!(
                "{layer} is merged: restack {} instead",
                chain[up].branch
            ));
        }
    }
    // The restack's top: the highest layer reached from `layer` through a
    // contiguous run where each layer contains the one below. Layers above a
    // break are not moved now; detection reports them out of date afterwards.
    let mut run = vec![l.branch.clone()];
    for next in &chain[pos + 1..] {
        let below = format!("refs/heads/{}", run[run.len() - 1]);
        if !is_ancestor(repo, &below, &format!("refs/heads/{}", next.branch))? {
            break;
        }
        run.push(next.branch.clone());
    }
    let top = run[run.len() - 1].clone();
    let top_sha = resolve_commit(repo, &format!("refs/heads/{top}"))?
        .ok_or_else(|| format!("unknown branch: {top}"))?;
    let stack: Vec<String> = chain.iter().map(|x| x.branch.clone()).collect();
    let mut moving = Vec::new();
    if let Some(up) = target.upstream_sha.as_deref() {
        // Layers from the bottom up still sitting at `upstream` (no commit of
        // their own) are outside `upstream..top`, and `--update-refs` does
        // not move them. List them so the preview shows them and the
        // occupied guard covers them; `finalize` moves them.
        for b in &run {
            if resolve_commit(repo, &format!("refs/heads/{b}"))?.as_deref() == Some(up) {
                moving.push(moving_ref(repo, b, true)?);
            }
        }
        moving.extend(moving_refs(repo, up, &top, &stack)?);
    }
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
    if refusal.is_none() {
        check_layers_moving(&run, &moving)?;
    }
    Ok(RestackPlan {
        moment: target.moment,
        bottom: l.branch.clone(),
        parent: l.parent.clone(),
        onto_ref: target.onto_ref,
        onto_sha: target.onto_sha.unwrap_or_default(),
        upstream_sha: target.upstream_sha.unwrap_or_default(),
        top,
        top_sha,
        moving,
        new_parent: target.new_parent,
        refusal,
    })
}

/// Moment 1: replay `base..top` onto the parent's new tip. The parent does
/// not change, so `new_parent` is `None`: `new_parent` is meaningful for
/// moment 2 only (`finalize` ignores it for moment 1). An up-to-date layer gets the same
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
/// A candidate must exist and be an ancestor of the layer: replaying from
/// anything else would replay commits that are not the layer's own.
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
            let behind = behind_upstream(repo, &g)?;
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
        let layer_ref = format!("refs/heads/{}", l.branch);
        if commit_exists(repo, candidate)? && is_ancestor(repo, candidate, &layer_ref)? {
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
    let out = exec(repo, &["cat-file", "-e", &format!("{sha}^{{commit}}")])?;
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
    let head = exec(c.repo, &["symbolic-ref", "-q", "HEAD"])?;
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
        let in_stack = stack.iter().any(|s| s == branch);
        out.push((
            pos,
            tracked(repo, branch, in_stack, upstream_ref, upstream_short)?,
        ));
    }
    out.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.branch.cmp(&b.1.branch)));
    Ok(out.into_iter().map(|(_, m)| m).collect())
}

/// One branch as a `MovingRef`, with its upstream read from git.
fn moving_ref(repo: &Path, branch: &str, in_stack: bool) -> Result<MovingRef, String> {
    let line = run_ok(
        repo,
        &[
            "for-each-ref",
            "--format=%(upstream) %(upstream:short)",
            &format!("refs/heads/{branch}"),
        ],
    )?;
    let mut f = line.split(' ');
    let upstream_ref = f.next().unwrap_or_default();
    let upstream_short = f.next().unwrap_or_default();
    tracked(repo, branch, in_stack, upstream_ref, upstream_short)
}

fn tracked(
    repo: &Path,
    branch: &str,
    in_stack: bool,
    upstream_ref: &str,
    upstream_short: &str,
) -> Result<MovingRef, String> {
    let remote_sha = if upstream_ref.is_empty() {
        None
    } else {
        resolve_commit(repo, upstream_ref)?
    };
    Ok(MovingRef {
        branch: branch.to_string(),
        in_stack,
        upstream: (!upstream_short.is_empty()).then(|| upstream_short.to_string()),
        remote_sha,
    })
}

/// Invariant of a restack that will run: every layer from the bottom to the
/// top is among the refs `--update-refs` moves. A layer missing here would be
/// left behind while the restack reports success.
fn check_layers_moving(run: &[String], moving: &[MovingRef]) -> Result<(), String> {
    match run.iter().find(|b| !moving.iter().any(|m| &m.branch == *b)) {
        Some(b) => Err(format!("internal error: restack would leave {b} behind")),
        None => Ok(()),
    }
}

const STALE_PREVIEW: &str = "stale preview: the stack changed since the preview. Preview again.";

/// The current branch, `None` on a detached HEAD. Read in full and stripped,
/// since `--short` turns an ambiguous name into `heads/<b>`.
fn current_branch(repo: &Path) -> Result<Option<String>, String> {
    let out = exec(repo, &["symbolic-ref", "-q", "HEAD"])?;
    match out.status.code() {
        Some(0) => {
            let full = String::from_utf8_lossy(&out.stdout).trim().to_string();
            match full.strip_prefix("refs/heads/") {
                Some(b) if !b.is_empty() => Ok(Some(b.to_string())),
                _ => Err(format!("unexpected HEAD: {full}")),
            }
        }
        Some(1) => Ok(None),
        _ => Err(format!(
            "git symbolic-ref HEAD: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        )),
    }
}

/// Runs the restack the user previewed (spec §5.4, D5). Re-plans first and
/// refuses exactly as `plan` would, or when the stack changed since the
/// preview. Writes the pending record only once every check has passed, then
/// runs one `git rebase --update-refs`. Never finalizes: `status` does, on the
/// next refresh, whether the rebase ended at once or after a halt.
pub(crate) fn run(
    repo: &Path,
    configured_trunk: Option<&str>,
    layer: &str,
    hints: &[MergedParentHint],
    previewed: &PreviewedRestack,
    git_version: Option<(u32, u32)>,
) -> Result<RestackRun, String> {
    let p = plan(repo, configured_trunk, layer, hints, git_version)?;
    if let Some(r) = p.refusal {
        return Err(r.message);
    }
    let moving: Vec<&str> = p.moving.iter().map(|m| m.branch.as_str()).collect();
    if p.onto_sha != previewed.onto_sha
        || p.upstream_sha != previewed.upstream_sha
        || p.top_sha != previewed.top_sha
        || moving != previewed.moving
    {
        return Err(STALE_PREVIEW.into());
    }
    validate_branch_name(&p.top)?;
    if !is_sha(&p.onto_sha) || !is_sha(&p.upstream_sha) {
        return Err(format!(
            "internal error: restack of {layer} has no commit to rebase onto"
        ));
    }
    let original = current_branch(repo)?
        .ok_or_else(|| "HEAD is detached. Check out a branch first.".to_string())?;
    // The top's tip just before the rebase: the record's proof that the
    // rebase has since run (D4).
    let top_sha = resolve_commit(repo, &format!("refs/heads/{}", p.top))?
        .ok_or_else(|| format!("unknown branch: {}", p.top))?;
    if top_sha != p.top_sha {
        return Err(STALE_PREVIEW.into());
    }
    let merged = p.moment == Moment::ParentMerged;
    let record = PendingRestack {
        moment: p.moment,
        onto: p.onto_sha.clone(),
        old_base: p.upstream_sha.clone(),
        bottom: p.bottom.clone(),
        new_parent: p.new_parent.clone().filter(|_| merged),
        original,
        top_sha,
        merged_parent: merged.then(|| p.parent.clone()),
    };
    set_pending(repo, &p.top, &record)?;

    let output = git_cmd()
        .args([
            "rebase",
            "--update-refs",
            "--onto",
            &p.onto_sha,
            &p.upstream_sha,
            &p.top,
        ])
        .env("GIT_EDITOR", "true")
        .env("EDITOR", "true")
        .env("GIT_TERMINAL_PROMPT", "0")
        // The conflict check below matches git's own words.
        .env("LC_ALL", "C")
        .env("LANGUAGE", "")
        .current_dir(repo)
        .output();
    let output = match output {
        Ok(o) => o,
        Err(e) => return Err(rebase_failed(repo, &p.top, e.to_string())),
    };
    if output.status.success() {
        return Ok(RestackRun { conflict: false });
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if [&stderr, &stdout]
        .iter()
        .any(|s| s.contains("CONFLICT") || s.contains("could not apply"))
    {
        return Ok(RestackRun { conflict: true });
    }
    let msg = if stderr.is_empty() { stdout } else { stderr };
    Err(rebase_failed(repo, &p.top, msg))
}

/// A rebase that failed without halting on a conflict: the record goes,
/// unless a rebase is now in progress here (or that cannot be told), in
/// which case `status` decides once it ends.
fn rebase_failed(repo: &Path, top: &str, msg: String) -> String {
    let msg = format!("git rebase failed: {msg}");
    if !matches!(rebasing_here(repo), Ok(false)) {
        return msg;
    }
    match clear_pending(repo, top) {
        Ok(()) => msg,
        Err(e) => format!("{msg} (the restack record could not be cleared: {e})"),
    }
}

/// The layers `bottom` to `top`, following each layer's child. Err when
/// `top` is no longer stacked above `bottom`.
fn restacked_layers(
    all: &BTreeMap<String, StackMeta>,
    bottom: &str,
    top: &str,
) -> Result<Vec<String>, String> {
    let mut out = vec![bottom.to_string()];
    while out[out.len() - 1] != top {
        let cur = &out[out.len() - 1];
        let next = all.values().find(|m| &m.parent == cur);
        match next {
            Some(m) if out.len() <= all.len() => out.push(m.branch.clone()),
            _ => {
                return Err(format!(
                    "cannot finalize the restack: {top} is no longer stacked above {bottom}"
                ))
            }
        }
    }
    Ok(out)
}

/// Completes a restack whose rebase has ended (D5). In order: moves the
/// layers the rebase could not (empty ones), before any metadata write;
/// records the new bases; re-parents a moment-2 bottom and drops the merged
/// parent from the stack; clears the record; switches back to the branch the
/// user was on. Every step checks whether it is already applied, so a
/// finalize that stopped half-way completes on the next refresh. An Err
/// leaves the record in place (`status` reports it in `pending_errors`).
pub(crate) fn finalize(
    repo: &Path,
    top: &str,
    p: &PendingRestack,
) -> Result<FinalizedRestack, String> {
    validate_branch_name(top)?;
    validate_branch_name(&p.bottom)?;
    let all = read_all(repo)?;
    let layers = restacked_layers(&all, &p.bottom, top)?;

    // 1. `--update-refs` does not move a ref sitting exactly at the rebase's
    //    upstream (an empty layer): move it onto `onto`, compare-and-swap.
    //    Never a branch a worktree holds: that would change its checkout
    //    under it. Any refusal or failure stops here, before any metadata.
    let mut empty = Vec::new();
    for b in &layers {
        if resolve_commit(repo, &format!("refs/heads/{b}"))?.as_deref() == Some(p.old_base.as_str())
        {
            empty.push(b.as_str());
        }
    }
    if !empty.is_empty() {
        let holders = branch_holders(repo)?;
        for b in &empty {
            if let Some(h) = holders.iter().find(|h| h.branch == *b) {
                let how = if h.rebasing {
                    "being rebased"
                } else {
                    "checked out"
                };
                return Err(format!(
                    "{b} is {how} in a worktree ({}), so it cannot be moved onto the restacked stack. Free it, then refresh.",
                    h.worktree.display()
                ));
            }
        }
        for b in &empty {
            let r = format!("refs/heads/{b}");
            let out = exec(repo, &["update-ref", &r, &p.onto, &p.old_base])?;
            if !out.status.success() {
                return Err(format!(
                    "could not move {b} onto the restacked stack: {}",
                    String::from_utf8_lossy(&out.stderr).trim()
                ));
            }
        }
    }

    // 2. Metadata. Each layer above the bottom sits on its merge-base with
    //    its parent: the parent's tip, unless the parent moved again since.
    for b in layers.iter().skip(1) {
        let Some(m) = all.get(b) else { continue };
        let mb = merge_base(repo, &m.parent, b)?;
        if m.base.as_deref() != Some(mb.as_str()) {
            set_base(repo, b, &mb)?;
        }
    }
    // The bottom sits on `onto`, what the rebase replayed it onto.
    let bottom = all.get(&p.bottom);
    let on_onto = |m: &StackMeta| m.base.as_deref() == Some(p.onto.as_str());
    let mut merged_parent = None;
    let mut new_parent = None;
    match p.moment {
        Moment::ParentMoved => {
            if let Some(m) = bottom.filter(|m| !on_onto(m)) {
                set_base(repo, &m.branch, &p.onto)?;
            }
        }
        Moment::ParentMerged => {
            // The merged parent leaves the stack (two children otherwise).
            // Before the bottom: unsetting a bottom that is also the top
            // removes the record, and a failure after that could not be
            // retried.
            if let Some(mp) = &p.merged_parent {
                if all.contains_key(mp) {
                    unset(repo, mp)?;
                }
            }
            match &p.new_parent {
                Some(np) => {
                    if let Some(m) = bottom {
                        if &m.parent != np {
                            write_parent(repo, &m.branch, np)?;
                        }
                        if !on_onto(m) {
                            set_base(repo, &m.branch, &p.onto)?;
                        }
                    }
                    new_parent = Some(np.clone());
                }
                None => {
                    if bottom.is_some() {
                        unset(repo, &p.bottom)?;
                    }
                }
            }
            merged_parent = p.merged_parent.clone();
        }
    }
    let mut moved = Vec::new();
    for b in &layers {
        if is_ancestor(repo, &p.onto, &format!("refs/heads/{b}"))? {
            moved.push(b.clone());
        }
    }
    // The last write. Nothing after it may fail the finalize: the record
    // would be gone and the report lost.
    clear_pending(repo, top)?;

    // 3. Back to the branch the user was on when the restack started.
    let (switched_back_to, switch_error) = switch_back(repo, top, &p.original);
    Ok(FinalizedRestack {
        moment: p.moment,
        bottom: p.bottom.clone(),
        merged_parent,
        new_parent,
        moved,
        switched_back_to,
        switch_error,
    })
}

/// `git merge-base <parent> <layer>`; no common ancestor is an error.
fn merge_base(repo: &Path, parent: &str, layer: &str) -> Result<String, String> {
    run_ok(
        repo,
        &[
            "merge-base",
            &format!("refs/heads/{parent}"),
            &format!("refs/heads/{layer}"),
        ],
    )
}

/// When HEAD is still on `top` (where the rebase left it), switches to
/// `original`. Skipped, and said why, when `original` is gone or tracked
/// changes would have to be carried over. Runs after the record is cleared,
/// so it never fails: its own git errors are reported in `switch_error`.
fn switch_back(repo: &Path, top: &str, original: &str) -> (Option<String>, Option<SwitchError>) {
    match try_switch_back(repo, top, original) {
        Ok(r) => r,
        Err(e) => (None, Some(switch_error(original, e))),
    }
}

fn switch_error(branch: &str, reason: impl Into<String>) -> SwitchError {
    SwitchError {
        branch: branch.to_string(),
        reason: reason.into(),
    }
}

fn try_switch_back(
    repo: &Path,
    top: &str,
    original: &str,
) -> Result<(Option<String>, Option<SwitchError>), String> {
    if original == top || current_branch(repo)?.as_deref() != Some(top) {
        return Ok((None, None));
    }
    let exists = validate_branch_name(original).is_ok()
        && resolve_commit(repo, &format!("refs/heads/{original}"))?.is_some();
    if !exists {
        return Ok((
            None,
            Some(switch_error(original, "the branch no longer exists")),
        ));
    }
    if !run_ok(repo, &["status", "--porcelain", "--untracked-files=no"])?.is_empty() {
        return Ok((
            None,
            Some(switch_error(
                original,
                format!("uncommitted changes on {top}"),
            )),
        ));
    }
    let out = exec(repo, &["switch", "--no-guess", original])?;
    if out.status.success() {
        Ok((Some(original.to_string()), None))
    } else {
        Ok((
            None,
            Some(switch_error(
                original,
                String::from_utf8_lossy(&out.stderr).trim(),
            )),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stack::detect::status;
    use crate::stack::meta::set_parent;
    use crate::stack::{
        LayerState, MergedParentHint, Moment, PendingRestack, PreviewedRestack, RestackPlan,
        RestackRun, SwitchError,
    };
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
        // The forge reports step-2's PR (based on step-1) merged; the local
        // step-1 has not been pulled yet.
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
    fn a_merged_parent_already_pulled_into_the_grandparent_does_not_block() {
        let r = TempRepo::new();
        stack3(&r);
        let step3_base = r.git(&["config", "branch.step-3.gitwandStackBase"]);
        // step-2's PR (based on step-1) is squash-merged into step-1 and the
        // user pulled step-1: step-2 is now out of date against it.
        r.git(&["checkout", "-q", "step-1"]);
        r.git(&["merge", "-q", "--squash", "step-2"]);
        r.git(&["commit", "-q", "-m", "step 2 (squash)"]);
        r.git(&["checkout", "-q", "step-3"]);
        let h = [hint("step-2", None)];
        let s = status(&r.path, Some("main"), &h).unwrap();
        let l2 = s.layers.iter().find(|l| l.branch == "step-2").unwrap();
        let l3 = s.layers.iter().find(|l| l.branch == "step-3").unwrap();
        assert_eq!(l2.state, LayerState::OutOfDate);
        assert!(!l2.actionable, "the merged parent is being dropped");
        assert_eq!(l3.state, LayerState::ParentMerged);
        assert!(l3.actionable && !l3.inherited, "{l3:?}");
        let p = plan(&r.path, Some("main"), "step-3", &h, V).unwrap();
        assert_eq!(p.moment, Moment::ParentMerged);
        assert_eq!(p.onto_ref, "step-1");
        assert_eq!(p.onto_sha, r.git(&["rev-parse", "step-1"]));
        assert_eq!(p.upstream_sha, step3_base);
        assert_eq!(names(&p.moving), ["step-3"]);
        assert!(p.refusal.is_none(), "{:?}", p.refusal);
        // The dropped layer itself is not restackable.
        let e = plan(&r.path, Some("main"), "step-2", &h, V).unwrap_err();
        assert_eq!(e, "step-2 is merged: restack step-3 instead");
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

    /// moved_stack, plus a commit on step-2 after step-3 branched from it:
    /// step-3 no longer contains step-2's tip.
    fn broken_chain(r: &TempRepo) {
        moved_stack(r);
        r.git(&["checkout", "-q", "step-2"]);
        r.commit("b2.txt", "late\n", "s2 late");
        r.git(&["checkout", "-q", "step-3"]);
    }

    #[test]
    fn plan_stops_at_a_layer_that_does_not_contain_the_one_below() {
        let r = TempRepo::new();
        broken_chain(&r);
        let p = plan(&r.path, Some("main"), "step-2", &[], V).unwrap();
        assert_eq!(p.top, "step-2");
        assert_eq!(p.top_sha, r.git(&["rev-parse", "step-2"]));
        assert_eq!(names(&p.moving), ["step-2"]);
        assert!(p.refusal.is_none(), "{:?}", p.refusal);
        // Run that restack by hand: step-3, above the break, is then the
        // next layer to restack, not silently lost.
        r.git(&[
            "rebase",
            "-q",
            "--onto",
            &p.onto_sha,
            &p.upstream_sha,
            "step-2",
        ]);
        r.git(&["checkout", "-q", "step-3"]);
        let s = status(&r.path, Some("main"), &[]).unwrap();
        let l3 = s.layers.iter().find(|l| l.branch == "step-3").unwrap();
        assert_eq!(l3.state, LayerState::OutOfDate);
        assert!(l3.actionable);
    }

    #[test]
    fn every_layer_up_to_top_must_be_moving() {
        let m = |b: &str| MovingRef {
            branch: b.into(),
            in_stack: true,
            upstream: None,
            remote_sha: None,
        };
        let run = ["step-2".to_string(), "step-3".to_string()];
        assert!(check_layers_moving(&run, &[m("step-2"), m("step-3")]).is_ok());
        let e = check_layers_moving(&run, &[m("step-3")]).unwrap_err();
        assert!(e.contains("step-2"), "{e}");
    }

    #[test]
    fn plan_skips_an_old_base_that_is_not_below_the_layer() {
        let r = TempRepo::new();
        stack3(&r);
        let old_tip = r.git(&["rev-parse", "step-1"]);
        squash_step1_on_origin(&r);
        // An existing commit that is not an ancestor of step-2.
        let elsewhere = r.git(&["rev-parse", "origin/main"]);
        let p = &r.path;
        // Recorded base not below the layer: fall through to the hint.
        r.git(&["config", "branch.step-2.gitwandStackBase", &elsewhere]);
        let h = [hint("step-1", Some(old_tip.clone()))];
        let got = plan(p, Some("main"), "step-2", &h, V).unwrap();
        assert_eq!(got.upstream_sha, old_tip);
        assert!(got.refusal.is_none(), "{:?}", got.refusal);
        // No base, hint head not below the layer: no old base.
        r.git(&["config", "--unset", "branch.step-2.gitwandStackBase"]);
        let h = [hint("step-1", Some(elsewhere))];
        assert_eq!(code(plan(p, Some("main"), "step-2", &h, V)), "no_old_base");
    }

    #[test]
    fn plan_errors_unless_the_layer_is_the_lowest_needing_a_restack() {
        let r = TempRepo::new();
        moved_stack(&r);
        let p = &r.path;
        // step-3 is up to date but inherits step-2's restack.
        let e = plan(p, Some("main"), "step-3", &[], V).unwrap_err();
        assert_eq!(e, "restack step-2 first");
        // step-3 out of date too, still above the lowest one.
        let r2 = TempRepo::new();
        broken_chain(&r2);
        let e = plan(&r2.path, Some("main"), "step-3", &[], V).unwrap_err();
        assert_eq!(e, "restack step-2 first");
        // A rebase in progress: its refusal wins over the Err.
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
            code(plan(p, Some("main"), "step-3", &[], V)),
            "rebase_in_progress"
        );
    }

    #[test]
    fn an_empty_bottom_layer_is_listed_as_moving() {
        let r = TempRepo::new();
        r.add_bare_origin();
        // step-2 has no commit of its own: its tip is step-1's tip.
        r.git(&["checkout", "-q", "-b", "step-1"]);
        let old_tip = r.commit("a.txt", "1\n", "s1");
        r.git(&["checkout", "-q", "-b", "step-2"]);
        r.git(&["push", "-q", "-u", "origin", "step-2"]);
        r.git(&["checkout", "-q", "-b", "step-3"]);
        r.commit("c.txt", "3\n", "s3");
        set_parent(&r.path, Some("main"), "step-2", "step-1").unwrap();
        set_parent(&r.path, Some("main"), "step-3", "step-2").unwrap();
        r.git(&["checkout", "-q", "step-1"]);
        r.commit("a2.txt", "more\n", "s1 more");
        r.git(&["checkout", "-q", "step-3"]);
        let s = status(&r.path, Some("main"), &[]).unwrap();
        let l2 = s.layers.iter().find(|l| l.branch == "step-2").unwrap();
        assert_eq!(l2.state, LayerState::OutOfDate);
        assert!(l2.actionable);
        let p = plan(&r.path, Some("main"), "step-2", &[], V).unwrap();
        assert!(p.refusal.is_none(), "{:?}", p.refusal);
        assert_eq!(p.upstream_sha, old_tip);
        assert_eq!(p.top, "step-3");
        assert_eq!(names(&p.moving), ["step-2", "step-3"]);
        let m2 = &p.moving[0];
        assert!(m2.in_stack);
        assert_eq!(m2.upstream.as_deref(), Some("origin/step-2"));
        assert_eq!(m2.remote_sha.as_deref(), Some(old_tip.as_str()));
    }

    #[test]
    fn an_empty_bottom_layer_checked_out_elsewhere_is_occupied() {
        let r = TempRepo::new();
        r.git(&["checkout", "-q", "-b", "step-1"]);
        r.commit("a.txt", "1\n", "s1");
        r.git(&["branch", "step-2"]);
        r.git(&["checkout", "-q", "-b", "step-3"]);
        r.commit("c.txt", "3\n", "s3");
        set_parent(&r.path, Some("main"), "step-2", "step-1").unwrap();
        set_parent(&r.path, Some("main"), "step-3", "step-2").unwrap();
        r.git(&["checkout", "-q", "step-1"]);
        r.commit("a2.txt", "more\n", "s1 more");
        r.git(&["checkout", "-q", "step-3"]);
        let wt = r.sandbox.join("wt");
        r.git(&["worktree", "add", "-q", wt.to_str().unwrap(), "step-2"]);
        let rf = plan(&r.path, Some("main"), "step-2", &[], V)
            .unwrap()
            .refusal
            .unwrap();
        assert_eq!(rf.code, "occupied");
        assert_eq!(rf.branch.as_deref(), Some("step-2"));
    }

    #[test]
    fn a_dropped_layer_with_a_blocker_below_names_the_blocker() {
        let r = TempRepo::new();
        // main <- step-0 <- step-1 <- step-2 <- step-3, all declared above step-0.
        r.git(&["checkout", "-q", "-b", "step-0"]);
        r.commit("z.txt", "0\n", "s0");
        r.git(&["checkout", "-q", "-b", "step-1"]);
        r.commit("a.txt", "1\n", "s1");
        r.git(&["checkout", "-q", "-b", "step-2"]);
        r.commit("b.txt", "2\n", "s2");
        r.git(&["checkout", "-q", "-b", "step-3"]);
        r.commit("c.txt", "3\n", "s3");
        set_parent(&r.path, Some("main"), "step-1", "step-0").unwrap();
        set_parent(&r.path, Some("main"), "step-2", "step-1").unwrap();
        set_parent(&r.path, Some("main"), "step-3", "step-2").unwrap();
        // step-0 moves (step-1 out of date) and step-2 is reported merged.
        r.git(&["checkout", "-q", "step-0"]);
        r.commit("z2.txt", "more\n", "s0 more");
        r.git(&["checkout", "-q", "step-3"]);
        let h = [hint("step-2", None)];
        let e = plan(&r.path, Some("main"), "step-2", &h, V).unwrap_err();
        assert_eq!(e, "restack step-1 first");
    }

    // ── Task 5: run, pending record, finalize ─────────────────────────

    fn previewed(p: &RestackPlan) -> PreviewedRestack {
        PreviewedRestack {
            onto_sha: p.onto_sha.clone(),
            upstream_sha: p.upstream_sha.clone(),
            top_sha: p.top_sha.clone(),
            moving: p.moving.iter().map(|m| m.branch.clone()).collect(),
        }
    }

    fn restack(r: &TempRepo, layer: &str, h: &[MergedParentHint]) -> RestackRun {
        let p = plan(&r.path, Some("main"), layer, h, V).unwrap();
        run(&r.path, Some("main"), layer, h, &previewed(&p), V).unwrap()
    }

    fn cfg_opt(r: &TempRepo, k: &str) -> Option<String> {
        let out = crate::git::git_cmd()
            .args(["config", "--get", k])
            .current_dir(&r.path)
            .output()
            .unwrap();
        out.status
            .success()
            .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
    }

    fn cfg(r: &TempRepo, k: &str) -> String {
        cfg_opt(r, k).unwrap_or_else(|| panic!("{k} is not set"))
    }

    /// `a` is an ancestor of `b` (both branch names).
    fn ancestor(r: &TempRepo, a: &str, b: &str) -> bool {
        crate::git::git_cmd()
            .args(["merge-base", "--is-ancestor", a, b])
            .current_dir(&r.path)
            .status()
            .unwrap()
            .success()
    }

    /// `git <args>` in the repo with a non-interactive editor (rebase --continue).
    fn git_no_editor(r: &TempRepo, args: &[&str]) {
        let out = crate::git::git_cmd()
            .args(args)
            .env("GIT_EDITOR", "true")
            .current_dir(&r.path)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    /// Every local branch tip and every stack key, for before/after checks.
    fn snapshot(r: &TempRepo) -> (String, String) {
        let refs = r.git(&[
            "for-each-ref",
            "--format=%(refname) %(objectname)",
            "refs/heads/",
        ]);
        let out = crate::git::git_cmd()
            .args(["config", "--local", "--get-regexp", r"^branch\..*\.gitwand"])
            .current_dir(&r.path)
            .output()
            .unwrap();
        (
            refs,
            String::from_utf8_lossy(&out.stdout).trim().to_string(),
        )
    }

    #[test]
    fn moment_one_three_layers_end_to_end() {
        let r = TempRepo::new();
        stack3(&r);
        r.git(&["checkout", "-q", "step-1"]);
        r.commit("a2.txt", "more\n", "s1 more");
        assert!(!restack(&r, "step-2", &[]).conflict);
        // D5: a clean run does not finalize; the record stays until status.
        assert!(cfg_opt(&r, "branch.step-3.gitwandRestack").is_some());
        let s = status(&r.path, Some("main"), &[]).unwrap();
        let f = s.finalized.clone().unwrap();
        assert_eq!(f.moment, Moment::ParentMoved);
        assert_eq!(f.bottom, "step-2");
        assert_eq!(f.moved, ["step-2", "step-3"]);
        assert_eq!(f.switched_back_to.as_deref(), Some("step-1"));
        assert_eq!(f.switch_error, None);
        assert!(ancestor(&r, "step-1", "step-2") && ancestor(&r, "step-2", "step-3"));
        assert_eq!(
            cfg(&r, "branch.step-2.gitwandStackBase"),
            r.git(&["rev-parse", "step-1"])
        );
        assert_eq!(
            cfg(&r, "branch.step-3.gitwandStackBase"),
            r.git(&["rev-parse", "step-2"])
        );
        assert!(cfg_opt(&r, "branch.step-3.gitwandRestack").is_none());
        assert_eq!(r.git(&["branch", "--show-current"]), "step-1");
        assert!(s.layers.iter().all(|l| l.state == LayerState::UpToDate));
        // Finalized once: the next refresh reports nothing.
        assert!(status(&r.path, Some("main"), &[])
            .unwrap()
            .finalized
            .is_none());
    }

    /// main <- step-1 (two commits) <- step-2 <- step-3, then step-1
    /// squash-merged on origin/main with local main left behind.
    fn two_commit_parent_squashed(r: &TempRepo) {
        r.git(&["checkout", "-q", "-b", "step-1"]);
        r.commit("a.txt", "1\n", "s1");
        r.commit("a2.txt", "1b\n", "s1 second");
        r.git(&["checkout", "-q", "-b", "step-2"]);
        r.commit("b.txt", "2\n", "s2");
        r.git(&["checkout", "-q", "-b", "step-3"]);
        r.commit("c.txt", "3\n", "s3");
        set_parent(&r.path, Some("main"), "step-2", "step-1").unwrap();
        set_parent(&r.path, Some("main"), "step-3", "step-2").unwrap();
        squash_step1_on_origin(r);
    }

    #[test]
    fn moment_two_lands_the_squash_while_local_main_stays_behind() {
        let r = TempRepo::new();
        two_commit_parent_squashed(&r);
        let h = [hint("step-1", None)];
        let main_before = r.git(&["rev-parse", "main"]);
        assert!(!restack(&r, "step-2", &h).conflict);
        let f = status(&r.path, Some("main"), &h)
            .unwrap()
            .finalized
            .unwrap();
        assert_eq!(f.moment, Moment::ParentMerged);
        assert_eq!(f.merged_parent.as_deref(), Some("step-1"));
        assert_eq!(f.new_parent, None);
        assert_eq!(f.switched_back_to, None, "step-3 was checked out");
        assert_eq!(r.git(&["rev-parse", "main"]), main_before);
        assert!(ancestor(&r, "origin/main", "step-2"));
        assert_eq!(r.git(&["rev-list", "--count", "origin/main..step-2"]), "1");
        assert!(cfg_opt(&r, "branch.step-2.gitwandParent").is_none());
        assert!(cfg_opt(&r, "branch.step-2.gitwandStackBase").is_none());
        assert_eq!(cfg(&r, "branch.step-3.gitwandParent"), "step-2");
        assert_eq!(
            cfg(&r, "branch.step-3.gitwandStackBase"),
            r.git(&["rev-parse", "step-2"])
        );
        assert!(cfg_opt(&r, "branch.step-3.gitwandRestack").is_none());
    }

    #[test]
    fn moment_two_under_a_stacked_grandparent_reparents_the_bottom() {
        let r = TempRepo::new();
        stack3(&r);
        // step-2's PR (based on step-1) is reported merged.
        let h = [hint("step-2", None)];
        assert!(!restack(&r, "step-3", &h).conflict);
        let f = status(&r.path, Some("main"), &h)
            .unwrap()
            .finalized
            .unwrap();
        assert_eq!(f.merged_parent.as_deref(), Some("step-2"));
        assert_eq!(f.new_parent.as_deref(), Some("step-1"));
        assert_eq!(f.moved, ["step-3"]);
        assert_d8_end_state(&r);
    }

    /// After step-2 (merged into step-1) is dropped by step-3's restack.
    fn assert_d8_end_state(r: &TempRepo) {
        assert_eq!(cfg(r, "branch.step-3.gitwandParent"), "step-1");
        assert_eq!(
            cfg(r, "branch.step-3.gitwandStackBase"),
            r.git(&["rev-parse", "step-1"])
        );
        assert_eq!(
            r.git(&["rev-list", "--count", "step-1..step-3"]),
            "1",
            "only step-3's own commit is left above step-1"
        );
        // The merged layer is no longer declared: step-1 has one child.
        assert!(cfg_opt(r, "branch.step-2.gitwandParent").is_none());
        assert!(cfg_opt(r, "branch.step-2.gitwandStackBase").is_none());
        assert!(cfg_opt(r, "branch.step-3.gitwandRestack").is_none());
    }

    /// stack3, step-1 squash-merged on origin/main, and origin/main also
    /// gains a b.txt, which step-2 adds too: restacking step-2 (moment 2)
    /// halts on a conflict. Left on step-1.
    fn conflicting_moment_two(r: &TempRepo) {
        stack3(r);
        squash_step1_on_origin(r);
        r.git(&["checkout", "-q", "-b", "tmp", "origin/main"]);
        r.commit("b.txt", "main\n", "main b");
        r.git(&["push", "-q", "origin", "tmp:main"]);
        r.git(&["fetch", "-q", "origin"]);
        r.git(&["checkout", "-q", "step-1"]);
        r.git(&["branch", "-q", "-D", "tmp"]);
    }

    /// stack3 where step-1 then gets a commit adding b.txt, which step-2
    /// also adds: restacking step-2 halts on a conflict. Left on step-1.
    fn conflicting_moment_one(r: &TempRepo) {
        stack3(r);
        r.git(&["checkout", "-q", "step-1"]);
        r.commit("b.txt", "theirs\n", "s1 conflicting");
    }

    fn resolve_and_continue(r: &TempRepo) {
        r.write("b.txt", "resolved\n");
        r.git(&["add", "b.txt"]);
        git_no_editor(r, &["rebase", "--continue"]);
    }

    #[test]
    fn conflict_halt_then_continue_finalizes_moment_one() {
        let r = TempRepo::new();
        conflicting_moment_one(&r);
        assert!(restack(&r, "step-2", &[]).conflict);
        let s = status(&r.path, Some("main"), &[]).unwrap();
        assert!(s.finalized.is_none());
        assert!(s.rebase_in_progress);
        assert!(cfg_opt(&r, "branch.step-3.gitwandRestack").is_some());
        resolve_and_continue(&r);
        let s = status(&r.path, Some("main"), &[]).unwrap();
        let f = s.finalized.unwrap();
        assert_eq!(f.moved, ["step-2", "step-3"]);
        assert_eq!(f.switched_back_to.as_deref(), Some("step-1"));
        assert_eq!(r.git(&["branch", "--show-current"]), "step-1");
        assert!(ancestor(&r, "step-1", "step-2") && ancestor(&r, "step-2", "step-3"));
        assert_eq!(
            cfg(&r, "branch.step-2.gitwandStackBase"),
            r.git(&["rev-parse", "step-1"])
        );
        assert!(cfg_opt(&r, "branch.step-3.gitwandRestack").is_none());
        assert!(s.layers.iter().all(|l| l.state == LayerState::UpToDate));
    }

    #[test]
    fn conflict_halt_then_continue_finalizes_moment_two() {
        let r = TempRepo::new();
        conflicting_moment_two(&r);
        assert!(restack(&r, "step-2", &[]).conflict);
        let s = status(&r.path, Some("main"), &[]).unwrap();
        assert!(s.rebase_in_progress && s.finalized.is_none());
        resolve_and_continue(&r);
        let f = status(&r.path, Some("main"), &[])
            .unwrap()
            .finalized
            .unwrap();
        assert_eq!(f.moment, Moment::ParentMerged);
        assert_eq!(f.merged_parent.as_deref(), Some("step-1"));
        assert_eq!(f.switched_back_to.as_deref(), Some("step-1"));
        assert!(ancestor(&r, "origin/main", "step-2"));
        assert!(cfg_opt(&r, "branch.step-2.gitwandParent").is_none());
        assert_eq!(cfg(&r, "branch.step-3.gitwandParent"), "step-2");
        assert!(cfg_opt(&r, "branch.step-3.gitwandRestack").is_none());
    }

    #[test]
    fn abort_clears_the_record_and_changes_nothing() {
        let r = TempRepo::new();
        conflicting_moment_one(&r);
        r.git(&["checkout", "-q", "step-3"]);
        let before = snapshot(&r);
        assert!(restack(&r, "step-2", &[]).conflict);
        r.git(&["rebase", "--abort"]);
        let s = status(&r.path, Some("main"), &[]).unwrap();
        assert!(s.finalized.is_none());
        assert!(!s.rebase_in_progress);
        assert!(cfg_opt(&r, "branch.step-3.gitwandRestack").is_none());
        assert_eq!(snapshot(&r), before);
    }

    #[test]
    fn status_waits_while_top_is_rebasing_in_another_worktree() {
        let r = TempRepo::new();
        conflicting_moment_one(&r);
        let p = plan(&r.path, Some("main"), "step-2", &[], V).unwrap();
        let record = PendingRestack {
            moment: Moment::ParentMoved,
            onto: p.onto_sha.clone(),
            old_base: p.upstream_sha.clone(),
            bottom: "step-2".into(),
            new_parent: None,
            original: "step-1".into(),
            top_sha: p.top_sha.clone(),
            merged_parent: None,
        };
        crate::stack::meta::set_pending(&r.path, "step-3", &record).unwrap();
        let wt = r.sandbox.join("wt");
        r.git(&["worktree", "add", "-q", wt.to_str().unwrap(), "step-3"]);
        let out = crate::git::git_cmd()
            .args([
                "rebase",
                "--update-refs",
                "--onto",
                &p.onto_sha,
                &p.upstream_sha,
                "step-3",
            ])
            .env("GIT_EDITOR", "true")
            .current_dir(&wt)
            .output()
            .unwrap();
        assert!(!out.status.success(), "rebase should halt on a conflict");
        let s = status(&r.path, Some("main"), &[]).unwrap();
        assert!(s.rebase_in_progress && s.finalized.is_none());
        assert!(cfg_opt(&r, "branch.step-3.gitwandRestack").is_some());
    }

    #[test]
    fn stale_preview_is_refused() {
        let r = TempRepo::new();
        moved_stack(&r);
        let p = plan(&r.path, Some("main"), "step-2", &[], V).unwrap();
        r.commit("c2.txt", "late\n", "s3 late");
        let e = run(&r.path, Some("main"), "step-2", &[], &previewed(&p), V).unwrap_err();
        assert_eq!(
            e,
            "stale preview: the stack changed since the preview. Preview again."
        );
        assert!(cfg_opt(&r, "branch.step-3.gitwandRestack").is_none());
    }

    #[test]
    fn run_refuses_a_dirty_tree() {
        let r = TempRepo::new();
        moved_stack(&r);
        let p = plan(&r.path, Some("main"), "step-2", &[], V).unwrap();
        r.write("c.txt", "edited\n");
        let e = run(&r.path, Some("main"), "step-2", &[], &previewed(&p), V).unwrap_err();
        assert_eq!(
            e,
            "You have uncommitted changes to tracked files. Commit or stash them first."
        );
        assert!(cfg_opt(&r, "branch.step-3.gitwandRestack").is_none());
    }

    #[test]
    fn run_errs_like_plan_and_writes_no_record() {
        let r = TempRepo::new();
        moved_stack(&r);
        let before = snapshot(&r);
        let pv = PreviewedRestack {
            onto_sha: String::new(),
            upstream_sha: String::new(),
            top_sha: String::new(),
            moving: Vec::new(),
        };
        let e = run(&r.path, Some("main"), "step-3", &[], &pv, V).unwrap_err();
        assert_eq!(e, "restack step-2 first");
        assert!(run(&r.path, Some("main"), "nope", &[], &pv, V).is_err());
        // An old git: the refusal message, not a rebase.
        let e = run(&r.path, Some("main"), "step-2", &[], &pv, Some((2, 37))).unwrap_err();
        assert_eq!(e, "Restacking needs git 2.38 or later (found 2.37).");
        assert_eq!(snapshot(&r), before);
    }

    #[test]
    fn malformed_record_is_cleared() {
        let r = TempRepo::new();
        stack3(&r);
        r.git(&["config", "branch.step-3.gitwandRestack", "garbage"]);
        let s = status(&r.path, Some("main"), &[]).unwrap();
        assert!(s.finalized.is_none());
        assert!(cfg_opt(&r, "branch.step-3.gitwandRestack").is_none());
    }

    #[test]
    fn a_record_whose_rebase_never_ran_is_cleared() {
        // The app stopped between writing the record and running the rebase.
        let r = TempRepo::new();
        moved_stack(&r);
        let before = snapshot(&r);
        let p = plan(&r.path, Some("main"), "step-2", &[], V).unwrap();
        let record = PendingRestack {
            moment: Moment::ParentMoved,
            onto: p.onto_sha.clone(),
            old_base: p.upstream_sha.clone(),
            bottom: "step-2".into(),
            new_parent: None,
            original: "step-3".into(),
            top_sha: p.top_sha.clone(),
            merged_parent: None,
        };
        crate::stack::meta::set_pending(&r.path, "step-3", &record).unwrap();
        let s = status(&r.path, Some("main"), &[]).unwrap();
        assert!(s.finalized.is_none());
        assert_eq!(snapshot(&r), before);
    }

    /// step-2 has no commit of its own (its tip is step-1's tip), step-3
    /// one; step-1 then moves. Left on step-1.
    fn empty_bottom_moved_parent(r: &TempRepo) {
        r.git(&["checkout", "-q", "-b", "step-1"]);
        r.commit("a.txt", "1\n", "s1");
        r.git(&["checkout", "-q", "-b", "step-2"]);
        r.git(&["checkout", "-q", "-b", "step-3"]);
        r.commit("c.txt", "3\n", "s3");
        set_parent(&r.path, Some("main"), "step-2", "step-1").unwrap();
        set_parent(&r.path, Some("main"), "step-3", "step-2").unwrap();
        r.git(&["checkout", "-q", "step-1"]);
        r.commit("a2.txt", "more\n", "s1 more");
    }

    #[test]
    fn an_empty_bottom_layer_follows_its_moved_parent() {
        let r = TempRepo::new();
        empty_bottom_moved_parent(&r);
        assert!(!restack(&r, "step-2", &[]).conflict);
        let s = status(&r.path, Some("main"), &[]).unwrap();
        let f = s.finalized.clone().unwrap();
        assert_eq!(f.switch_error, None);
        assert_eq!(f.moved, ["step-2", "step-3"]);
        let tip = r.git(&["rev-parse", "step-1"]);
        assert_eq!(r.git(&["rev-parse", "step-2"]), tip);
        assert_eq!(cfg(&r, "branch.step-2.gitwandStackBase"), tip);
        assert_eq!(cfg(&r, "branch.step-3.gitwandStackBase"), tip);
        assert!(ancestor(&r, "step-2", "step-3"));
        assert!(s.layers.iter().all(|l| l.state == LayerState::UpToDate));
    }

    // ── Task 5 review, round 1 ────────────────────────────────────────

    /// Stack keys only (no refs), for "no metadata changed" checks.
    fn stack_keys(r: &TempRepo) -> String {
        snapshot(r).1
    }

    #[test]
    fn an_aborted_restack_is_not_finalized_when_the_top_already_contained_onto() {
        // I-1: step-3 merged the moved step-1 in by hand, so it contains
        // `onto` before the rebase even starts.
        let r = TempRepo::new();
        conflicting_moment_one(&r);
        r.git(&["checkout", "-q", "step-3"]);
        let out = crate::git::git_cmd()
            .args(["merge", "-q", "--no-edit", "step-1"])
            .current_dir(&r.path)
            .output()
            .unwrap();
        assert!(!out.status.success(), "the merge should conflict on b.txt");
        r.write("b.txt", "2\n");
        r.git(&["add", "b.txt"]);
        git_no_editor(&r, &["commit", "-q", "--no-edit"]);
        assert!(ancestor(&r, "step-1", "step-3"));
        let before = snapshot(&r);
        assert!(restack(&r, "step-2", &[]).conflict);
        r.git(&["rebase", "--abort"]);
        let s = status(&r.path, Some("main"), &[]).unwrap();
        assert!(s.finalized.is_none(), "{:?}", s.finalized);
        assert!(s.pending_errors.is_empty());
        assert!(cfg_opt(&r, "branch.step-3.gitwandRestack").is_none());
        assert_eq!(snapshot(&r), before);
    }

    #[test]
    fn moment_two_under_a_stacked_grandparent_layer_leaves_one_linear_stack() {
        // I-2: main <- step-0 <- step-1 <- step-2 <- step-3, all declared
        // above step-0; step-2 merged into step-1, step-3 restacked on step-1.
        let r = TempRepo::new();
        r.git(&["checkout", "-q", "-b", "step-0"]);
        r.commit("z.txt", "0\n", "s0");
        r.git(&["checkout", "-q", "-b", "step-1"]);
        r.commit("a.txt", "1\n", "s1");
        r.git(&["checkout", "-q", "-b", "step-2"]);
        r.commit("b.txt", "2\n", "s2");
        r.git(&["checkout", "-q", "-b", "step-3"]);
        r.commit("c.txt", "3\n", "s3");
        for (l, p) in [
            ("step-1", "step-0"),
            ("step-2", "step-1"),
            ("step-3", "step-2"),
        ] {
            set_parent(&r.path, Some("main"), l, p).unwrap();
        }
        let h = [hint("step-2", None)];
        assert!(!restack(&r, "step-3", &h).conflict);
        let s = status(&r.path, Some("main"), &h).unwrap();
        let f = s.finalized.clone().unwrap();
        assert_eq!(f.merged_parent.as_deref(), Some("step-2"));
        assert_eq!(f.new_parent.as_deref(), Some("step-1"));
        assert_d8_end_state(&r);
        assert_eq!(cfg(&r, "branch.step-1.gitwandParent"), "step-0");
        let names: Vec<(&str, &str)> = s
            .layers
            .iter()
            .map(|l| (l.branch.as_str(), l.top.as_str()))
            .collect();
        assert_eq!(names, [("step-1", "step-3"), ("step-3", "step-3")]);
        assert!(s.layers.iter().all(|l| l.state == LayerState::UpToDate));
    }

    #[test]
    fn an_unsettleable_record_is_reported_and_blocks_only_its_stack() {
        // I-3: the record's `onto` is not a known commit (pruned).
        let r = TempRepo::new();
        moved_stack(&r);
        r.git(&["checkout", "-q", "-b", "other-1", "main"]);
        r.commit("o.txt", "1\n", "o1");
        r.git(&["checkout", "-q", "-b", "other-2"]);
        r.commit("o2.txt", "2\n", "o2");
        set_parent(&r.path, Some("main"), "other-2", "other-1").unwrap();
        r.git(&["checkout", "-q", "other-1"]);
        r.commit("o1b.txt", "more\n", "o1 more");
        r.git(&["checkout", "-q", "step-3"]);
        let record = PendingRestack {
            moment: Moment::ParentMoved,
            onto: "f".repeat(40),
            old_base: r.git(&["rev-parse", "main"]),
            bottom: "step-2".into(),
            new_parent: None,
            original: "step-3".into(),
            top_sha: "e".repeat(40),
            merged_parent: None,
        };
        crate::stack::meta::set_pending(&r.path, "step-3", &record).unwrap();
        let s = status(&r.path, Some("main"), &[]).unwrap();
        // One entry, naming the top of the stack that holds the record, not
        // the other stack (Task 13 review, I-1).
        assert_eq!(s.pending_errors.len(), 1, "{:?}", s.pending_errors);
        assert_eq!(s.pending_errors[0].top, "step-3");
        assert!(!s.pending_errors[0].error.is_empty());
        assert!(s.finalized.is_none());
        assert!(cfg_opt(&r, "branch.step-3.gitwandRestack").is_some());
        for l in s.layers.iter().filter(|l| l.top == "step-3") {
            assert!(!l.actionable, "{l:?}");
        }
        let o2 = s.layers.iter().find(|l| l.branch == "other-2").unwrap();
        assert_eq!(o2.state, LayerState::OutOfDate);
        assert!(o2.actionable);
        // `plan` never settles (round 2): any record blocks its stack with
        // the deferred text; the error itself is in `pending_errors`.
        assert_eq!(
            plan(&r.path, Some("main"), "step-2", &[], V).unwrap_err(),
            "A previous restack of step-3 is still being finalized. Refresh and try again."
        );
        assert!(plan(&r.path, Some("main"), "other-2", &[], V)
            .unwrap()
            .refusal
            .is_none());
        // Unstacking the top is the way out.
        crate::stack::meta::unset(&r.path, "step-3").unwrap();
        assert!(status(&r.path, Some("main"), &[])
            .unwrap()
            .pending_errors
            .is_empty());
    }

    #[test]
    fn a_partially_applied_moment_two_finalize_completes_from_the_record() {
        // I-4: the bottom was already re-parented when finalize stopped.
        let r = TempRepo::new();
        stack3(&r);
        let h = [hint("step-2", None)];
        assert!(!restack(&r, "step-3", &h).conflict);
        crate::stack::meta::write_parent(&r.path, "step-3", "step-1").unwrap();
        let f = status(&r.path, Some("main"), &h)
            .unwrap()
            .finalized
            .unwrap();
        assert_eq!(f.merged_parent.as_deref(), Some("step-2"));
        assert_eq!(f.new_parent.as_deref(), Some("step-1"));
        assert_d8_end_state(&r);
    }

    #[test]
    fn a_locked_empty_layer_keeps_the_record_until_it_can_move() {
        // I-5: the CAS of the empty layer fails; nothing is written.
        let r = TempRepo::new();
        empty_bottom_moved_parent(&r);
        let old_step2 = r.git(&["rev-parse", "step-2"]);
        assert!(!restack(&r, "step-2", &[]).conflict);
        let keys = stack_keys(&r);
        let lock = r.git(&["rev-parse", "--git-path", "refs/heads/step-2.lock"]);
        let lock = r.path.join(lock);
        std::fs::write(&lock, "").unwrap();
        let s = status(&r.path, Some("main"), &[]).unwrap();
        let [e] = s.pending_errors.as_slice() else {
            panic!("{:?}", s.pending_errors)
        };
        assert_eq!(e.top, "step-3");
        assert!(e.error.contains("step-2"), "{}", e.error);
        assert!(s.finalized.is_none());
        assert_eq!(r.git(&["rev-parse", "step-2"]), old_step2);
        assert_eq!(stack_keys(&r), keys, "no metadata written");
        std::fs::remove_file(&lock).unwrap();
        let s = status(&r.path, Some("main"), &[]).unwrap();
        assert!(s.pending_errors.is_empty());
        let f = s.finalized.unwrap();
        assert_eq!(f.switch_error, None);
        assert_eq!(f.moved, ["step-2", "step-3"]);
        assert_eq!(
            r.git(&["rev-parse", "step-2"]),
            r.git(&["rev-parse", "step-1"])
        );
    }

    #[test]
    fn an_empty_layer_checked_out_elsewhere_is_not_moved() {
        // I-5: the empty layer was checked out in a linked worktree after
        // the rebase and before the refresh.
        let r = TempRepo::new();
        empty_bottom_moved_parent(&r);
        let old_step2 = r.git(&["rev-parse", "step-2"]);
        assert!(!restack(&r, "step-2", &[]).conflict);
        let keys = stack_keys(&r);
        let wt = r.sandbox.join("wt");
        r.git(&["worktree", "add", "-q", wt.to_str().unwrap(), "step-2"]);
        let s = status(&r.path, Some("main"), &[]).unwrap();
        let [e] = s.pending_errors.as_slice() else {
            panic!("{:?}", s.pending_errors)
        };
        assert_eq!(e.top, "step-3");
        assert!(
            e.error.contains("step-2") && e.error.contains("wt"),
            "{}",
            e.error
        );
        assert!(s.finalized.is_none());
        assert_eq!(r.git(&["rev-parse", "step-2"]), old_step2);
        assert_eq!(stack_keys(&r), keys);
        assert!(cfg_opt(&r, "branch.step-3.gitwandRestack").is_some());
    }

    #[test]
    fn a_parent_moving_again_before_the_refresh_leaves_the_layer_out_of_date() {
        // M-1: layers above the bottom get merge-base(parent, layer).
        let r = TempRepo::new();
        stack3(&r);
        r.git(&["checkout", "-q", "step-1"]);
        r.commit("a2.txt", "more\n", "s1 more");
        assert!(!restack(&r, "step-2", &[]).conflict);
        let restacked_step2 = r.git(&["rev-parse", "step-2"]);
        // step-2 gets a commit before the refresh; step-3 does not have it.
        r.git(&["checkout", "-q", "step-2"]);
        r.commit("b2.txt", "late\n", "s2 late");
        let s = status(&r.path, Some("main"), &[]).unwrap();
        assert!(s.finalized.is_some());
        assert_eq!(cfg(&r, "branch.step-3.gitwandStackBase"), restacked_step2);
        let l3 = s.layers.iter().find(|l| l.branch == "step-3").unwrap();
        assert_eq!(l3.state, LayerState::OutOfDate);
    }

    #[test]
    fn tracked_changes_after_the_rebase_block_the_switch_back() {
        // M-2
        let r = TempRepo::new();
        stack3(&r);
        r.git(&["checkout", "-q", "step-1"]);
        r.commit("a2.txt", "more\n", "s1 more");
        assert!(!restack(&r, "step-2", &[]).conflict);
        r.write("c.txt", "edited\n");
        let f = status(&r.path, Some("main"), &[])
            .unwrap()
            .finalized
            .unwrap();
        assert_eq!(f.switched_back_to, None);
        assert_eq!(
            f.switch_error,
            Some(SwitchError {
                branch: "step-1".into(),
                reason: "uncommitted changes on step-3".into()
            })
        );
        assert_eq!(r.git(&["branch", "--show-current"]), "step-3");
        assert!(cfg_opt(&r, "branch.step-3.gitwandRestack").is_none());
    }

    #[test]
    fn two_completed_records_settle_one_per_refresh() {
        // M-3: by top name, one per status call.
        let r = TempRepo::new();
        moved_stack(&r);
        r.git(&["checkout", "-q", "-b", "x-1", "main"]);
        r.commit("x.txt", "1\n", "x1");
        r.git(&["checkout", "-q", "-b", "x-2"]);
        r.commit("x2.txt", "2\n", "x2");
        set_parent(&r.path, Some("main"), "x-2", "x-1").unwrap();
        r.git(&["checkout", "-q", "x-1"]);
        r.commit("x1b.txt", "more\n", "x1 more");
        r.git(&["checkout", "-q", "step-3"]);
        let px = plan(&r.path, Some("main"), "x-2", &[], V).unwrap();
        assert!(!restack(&r, "step-2", &[]).conflict);
        // The x stack's restack, run by hand with its own record.
        let record = PendingRestack {
            moment: Moment::ParentMoved,
            onto: px.onto_sha.clone(),
            old_base: px.upstream_sha.clone(),
            bottom: "x-2".into(),
            new_parent: None,
            original: "step-3".into(),
            top_sha: px.top_sha.clone(),
            merged_parent: None,
        };
        crate::stack::meta::set_pending(&r.path, "x-2", &record).unwrap();
        r.git(&[
            "rebase",
            "-q",
            "--update-refs",
            "--onto",
            &px.onto_sha,
            &px.upstream_sha,
            "x-2",
        ]);
        let s = status(&r.path, Some("main"), &[]).unwrap();
        assert_eq!(s.finalized.unwrap().bottom, "step-2");
        assert!(cfg_opt(&r, "branch.x-2.gitwandRestack").is_some());
        let x2 = s.layers.iter().find(|l| l.branch == "x-2").unwrap();
        assert!(!x2.actionable);
        let s = status(&r.path, Some("main"), &[]).unwrap();
        assert_eq!(s.finalized.unwrap().bottom, "x-2");
        assert!(cfg_opt(&r, "branch.x-2.gitwandRestack").is_none());
        assert!(status(&r.path, Some("main"), &[])
            .unwrap()
            .finalized
            .is_none());
    }

    #[test]
    fn a_moment_two_abort_changes_nothing() {
        // M-4: the unset path is never reached.
        let r = TempRepo::new();
        conflicting_moment_two(&r);
        r.git(&["checkout", "-q", "step-3"]);
        let before = snapshot(&r);
        assert!(restack(&r, "step-2", &[]).conflict);
        r.git(&["rebase", "--abort"]);
        let s = status(&r.path, Some("main"), &[]).unwrap();
        assert!(s.finalized.is_none());
        assert_eq!(snapshot(&r), before);
        assert_eq!(cfg(&r, "branch.step-2.gitwandParent"), "step-1");
    }

    #[test]
    fn an_original_branch_deleted_while_halted_is_not_switched_to() {
        // M-4
        let r = TempRepo::new();
        conflicting_moment_one(&r);
        r.git(&["checkout", "-q", "-b", "scratch"]);
        assert!(restack(&r, "step-2", &[]).conflict);
        r.git(&["branch", "-q", "-D", "scratch"]);
        resolve_and_continue(&r);
        let f = status(&r.path, Some("main"), &[])
            .unwrap()
            .finalized
            .unwrap();
        assert_eq!(f.switched_back_to, None);
        assert_eq!(
            f.switch_error,
            Some(SwitchError {
                branch: "scratch".into(),
                reason: "the branch no longer exists".into()
            })
        );
        assert_eq!(r.git(&["branch", "--show-current"]), "step-3");
    }

    // ── Task 5 review, round 2 ────────────────────────────────────────

    #[test]
    fn plan_never_finalizes_a_completed_restack() {
        let r = TempRepo::new();
        stack3(&r);
        r.git(&["checkout", "-q", "step-1"]);
        r.commit("a2.txt", "more\n", "s1 more");
        assert!(!restack(&r, "step-2", &[]).conflict);
        let keys = stack_keys(&r);
        let e = plan(&r.path, Some("main"), "step-2", &[], V).unwrap_err();
        assert_eq!(
            e,
            "A previous restack of step-3 is still being finalized. Refresh and try again."
        );
        assert_eq!(stack_keys(&r), keys, "plan wrote nothing");
        assert!(cfg_opt(&r, "branch.step-3.gitwandRestack").is_some());
        assert_eq!(r.git(&["branch", "--show-current"]), "step-3", "no switch");
        let f = status(&r.path, Some("main"), &[])
            .unwrap()
            .finalized
            .unwrap();
        assert_eq!(f.switched_back_to.as_deref(), Some("step-1"));
    }

    #[test]
    fn a_merged_parent_layer_on_the_trunk_and_a_single_layer_bottom_both_leave() {
        // Moment 2 with no new parent and bottom == top: the merged parent
        // is unset BEFORE the bottom, whose `unset` also removes the record,
        // so a failure in between keeps the record for a retry. Here, the end
        // state: both layers undeclared, no record. step-1 is declared on the
        // trunk by hand (`set_parent` refuses that).
        let r = TempRepo::new();
        r.git(&["checkout", "-q", "-b", "step-1"]);
        r.commit("a.txt", "1\n", "s1");
        r.git(&["checkout", "-q", "-b", "step-2"]);
        r.commit("b.txt", "2\n", "s2");
        set_parent(&r.path, Some("main"), "step-2", "step-1").unwrap();
        r.git(&["config", "branch.step-1.gitwandParent", "main"]);
        r.add_bare_origin();
        r.git(&["checkout", "-q", "main"]);
        r.git(&["merge", "-q", "--squash", "step-1"]);
        r.git(&["commit", "-q", "-m", "step 1 (squash)"]);
        r.git(&["push", "-q", "origin", "main"]);
        r.git(&["reset", "-q", "--hard", "HEAD~1"]);
        r.git(&["checkout", "-q", "step-2"]);
        assert!(!restack(&r, "step-2", &[]).conflict);
        let f = status(&r.path, Some("main"), &[])
            .unwrap()
            .finalized
            .unwrap();
        assert_eq!(f.merged_parent.as_deref(), Some("step-1"));
        assert!(ancestor(&r, "origin/main", "step-2"));
        for k in ["gitwandParent", "gitwandStackBase", "gitwandRestack"] {
            for b in ["step-1", "step-2"] {
                let key = format!("branch.{b}.{k}");
                assert!(cfg_opt(&r, &key).is_none(), "{key} still set");
            }
        }
    }
}

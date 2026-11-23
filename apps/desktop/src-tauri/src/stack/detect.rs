//! Stack detection (spec §5.3, D7, D17): classify every layer against its
//! parent, propagate "needs a restack" up each chain, and self-heal a base
//! that a manual rebase left behind.

use super::guard::{branch_holders, git_version, supports_update_refs};
use super::meta::{read_all, set_base, trunk, validate_branch_name};
use super::{LayerState, LayerStatus, MergeSignal, MergedParentHint, StackMeta, StackReport};
use crate::git::git_cmd;
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::process::Output;

fn run(repo: &Path, args: &[&str]) -> Result<Output, String> {
    git_cmd()
        .args(args)
        .current_dir(repo)
        .output()
        .map_err(|e| format!("git {}: {e}", args.first().copied().unwrap_or("")))
}

fn stdout(out: &Output) -> String {
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

/// The sha `rev` resolves to as a commit, or `None` when it does not.
pub(super) fn resolve_commit(repo: &Path, rev: &str) -> Result<Option<String>, String> {
    let out = run(
        repo,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            "--end-of-options",
            &format!("{rev}^{{commit}}"),
        ],
    )?;
    Ok(out.status.success().then(|| stdout(&out)))
}

/// `merge-base --is-ancestor`: exit 0 yes, 1 no, anything else an error.
pub(super) fn is_ancestor(repo: &Path, a: &str, b: &str) -> Result<bool, String> {
    let out = run(repo, &["merge-base", "--is-ancestor", a, b])?;
    match out.status.code() {
        Some(0) => Ok(true),
        Some(1) => Ok(false),
        _ => Err(format!(
            "git merge-base --is-ancestor {a} {b}: {}: {}",
            out.status,
            String::from_utf8_lossy(&out.stderr).trim()
        )),
    }
}

pub(super) fn is_sha(s: &str) -> bool {
    (s.len() == 40 || s.len() == 64) && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Every declared layer and its report, bottom→top per chain (spec §5.3).
pub(crate) fn status(
    repo: &Path,
    configured_trunk: Option<&str>,
    hints: &[MergedParentHint],
) -> Result<StackReport, String> {
    let all = read_all(repo)?;
    // Fail closed: a worktree we cannot inspect may hide a running rebase.
    let holders = branch_holders(repo)?;
    let rebase_in_progress = holders
        .iter()
        .any(|h| h.rebasing && all.contains_key(&h.branch));
    let git_supports_restack = supports_update_refs(git_version());

    let Some(trunk_name) = trunk(repo, configured_trunk) else {
        return Ok(StackReport {
            trunk: None,
            remote_trunk: None,
            layers: Vec::new(),
            rebase_in_progress,
            finalized: None,
            git_supports_restack,
        });
    };
    let remote_ref = format!("refs/remotes/origin/{trunk_name}");
    let has_remote_trunk = resolve_commit(repo, &remote_ref)?.is_some();

    let mut layers = Vec::new();
    for chain in chains(&all) {
        // A layer whose local branch is gone (deleted with its config kept)
        // has nothing to classify: it is left out, and the layer above it
        // reports `ParentMissing`.
        let mut present = Vec::new();
        for branch in chain {
            if resolve_commit(repo, &format!("refs/heads/{branch}"))?.is_some() {
                present.push(branch);
            }
        }
        let top = present.last().cloned().unwrap_or_default();
        let mut classified = Vec::new();
        for branch in &present {
            let mut l = classify(
                repo,
                &all[branch],
                hints,
                has_remote_trunk.then_some(remote_ref.as_str()),
                rebase_in_progress,
            )?;
            l.top = top.clone();
            classified.push(l);
        }
        let refs: Vec<&LayerStatus> = classified.iter().collect();
        let flow = propagate(&refs);
        for (mut l, f) in classified.into_iter().zip(flow) {
            l.inherited = f.blocker.is_some();
            l.actionable = needs_restack(l.state)
                && f.blocker.is_none()
                && f.dropped_for.is_none()
                && !rebase_in_progress;
            layers.push(l);
        }
    }

    Ok(StackReport {
        trunk: Some(trunk_name.clone()),
        remote_trunk: has_remote_trunk.then(|| format!("origin/{trunk_name}")),
        layers,
        rebase_in_progress,
        finalized: None,
        git_supports_restack,
    })
}

pub(crate) fn needs_restack(s: LayerState) -> bool {
    matches!(s, LayerState::OutOfDate | LayerState::ParentMerged)
}

/// How "needs a restack" flows up one chain (bottom to top).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) struct Propagation {
    /// Index of the lowest layer below that needs a restack first.
    pub blocker: Option<usize>,
    /// Index of the layer above whose merged parent this layer is: it is
    /// being dropped from the chain by that layer's moment-2 restack.
    pub dropped_for: Option<usize>,
}

/// The single rule shared by `status` (actionable / inherited) and
/// `restack::plan` (which layer to restack first), so they cannot disagree.
/// A layer needing a restack blocks every layer above it, unless it is being
/// dropped: it is the merged parent of the layer right above it (that layer
/// is `ParentMerged` with it as parent). Replaying a dropped layer would
/// replay commits that are already merged; the layer above skips it.
pub(crate) fn propagate(chain: &[&LayerStatus]) -> Vec<Propagation> {
    let dropped_for: Vec<Option<usize>> = (0..chain.len())
        .map(|i| {
            chain.get(i + 1).and_then(|up| {
                (up.state == LayerState::ParentMerged && up.parent == chain[i].branch)
                    .then_some(i + 1)
            })
        })
        .collect();
    let mut blocker = None;
    let mut out = Vec::with_capacity(chain.len());
    for (i, l) in chain.iter().enumerate() {
        out.push(Propagation {
            blocker,
            dropped_for: dropped_for[i],
        });
        if blocker.is_none() && needs_restack(l.state) && dropped_for[i].is_none() {
            blocker = Some(i);
        }
    }
    out
}

/// One layer's own state; `inherited`, `actionable` and `top` are set by the
/// caller. Self-heals the base unless a rebase is in progress.
fn classify(
    repo: &Path,
    meta: &StackMeta,
    hints: &[MergedParentHint],
    remote_trunk: Option<&str>,
    rebase_in_progress: bool,
) -> Result<LayerStatus, String> {
    let parent = meta.parent.as_str();
    let parent_tip = resolve_commit(repo, &format!("refs/heads/{parent}"))?;
    // A base that is not a sha naming an existing commit counts as absent.
    let base = match meta.base.as_deref().filter(|b| is_sha(b)) {
        Some(b) => resolve_commit(repo, b)?.map(|_| b.to_string()),
        None => None,
    };
    let mut l = LayerStatus {
        branch: meta.branch.clone(),
        parent: meta.parent.clone(),
        base: meta.base.clone(),
        parent_tip: parent_tip.clone(),
        state: LayerState::UpToDate,
        inherited: false,
        actionable: false,
        merge_signal: None,
        merged_pr: None,
        parent_behind_upstream: 0,
        top: String::new(),
    };

    // 1. The forge says the parent's PR is merged.
    let hint = match hints.iter().find(|h| h.branch == parent) {
        Some(h) if hint_is_stale(repo, h, parent_tip.as_deref())? => None,
        h => h,
    };
    if let Some(h) = hint {
        l.state = LayerState::ParentMerged;
        l.merge_signal = Some(MergeSignal::Forge);
        l.merged_pr = Some(h.number);
        return Ok(l);
    }
    // 2. git fallback against the remote trunk (D7).
    if let (Some(rt), Some(probe)) = (remote_trunk, base.as_deref().or(parent_tip.as_deref())) {
        if let Some(sig) = merged_signal(repo, rt, probe) {
            l.state = LayerState::ParentMerged;
            l.merge_signal = Some(sig);
            return Ok(l);
        }
    }
    // 3. The parent is gone locally.
    let Some(tip) = parent_tip else {
        l.state = LayerState::ParentMissing;
        return Ok(l);
    };
    let layer_ref = format!("refs/heads/{}", meta.branch);
    // 4. Up to date; a manual rebase may have left the base behind.
    if is_ancestor(repo, &tip, &layer_ref)? {
        if base.as_deref() != Some(tip.as_str()) && !rebase_in_progress {
            set_base(repo, &meta.branch, &tip)?;
            l.base = Some(tip);
        }
        return Ok(l);
    }
    // 5. The parent moved under a layer that still sits on its base.
    if let Some(b) = base.as_deref() {
        if is_ancestor(repo, b, &layer_ref)? {
            l.state = LayerState::OutOfDate;
            l.parent_behind_upstream = behind_upstream(repo, parent)?;
            return Ok(l);
        }
    }
    // 6. Neither the parent tip nor the base is below the layer (D17).
    l.state = LayerState::BaseLost;
    Ok(l)
}

/// A merged-PR hint is stale when the parent's local tip has commits the
/// merged head never had (the branch name was reused after the merge). It
/// cannot be judged, and is honoured, when the hint has no head sha, the sha
/// is not known locally, or the parent is gone.
fn hint_is_stale(
    repo: &Path,
    h: &MergedParentHint,
    parent_tip: Option<&str>,
) -> Result<bool, String> {
    let (Some(oid), Some(tip)) = (h.head_ref_oid.as_deref(), parent_tip) else {
        return Ok(false);
    };
    if !is_sha(oid) || resolve_commit(repo, oid)?.is_none() {
        return Ok(false);
    }
    Ok(!is_ancestor(repo, tip, oid)?)
}

/// D7: has `base` (the old parent tip) landed on `remote_trunk`? (a) every
/// commit of it is already there by patch-id; (b) `base` is an ancestor of
/// `remote_trunk` but not on its first-parent line, so it came in through a
/// merge commit. A parent with no commits of its own sits on the first-parent
/// line and is not "merged", even when the trunk later merged a branch that
/// had merged the trunk in. Any git error reads as "not merged".
pub(crate) fn merged_signal(repo: &Path, remote_trunk: &str, base: &str) -> Option<MergeSignal> {
    if remote_trunk.starts_with('-') || base.starts_with('-') {
        return None;
    }
    // (a) cherry
    let out = run(repo, &["cherry", remote_trunk, base]).ok()?;
    if out.status.success() {
        let text = stdout(&out);
        let lines: Vec<&str> = text.lines().filter(|l| !l.is_empty()).collect();
        if !lines.is_empty() && lines.iter().all(|l| l.starts_with('-')) {
            return Some(MergeSignal::Cherry);
        }
    }
    // (b) merge commit: walk the trunk's first-parent line down to `base`'s
    // history. X = the oldest commit of that walk. X^1 == base: base is on
    // the line, not merged. Otherwise the walk stepped over base, which only
    // a merge commit can bring in.
    if !is_ancestor(repo, base, remote_trunk).ok()? {
        return None;
    }
    let base_sha = resolve_commit(repo, base).ok()??;
    let range = format!("{base_sha}..{remote_trunk}");
    let out = run(repo, &["rev-list", "--first-parent", &range]).ok()?;
    if !out.status.success() {
        return None;
    }
    let text = stdout(&out);
    let oldest = text.lines().map(str::trim).rfind(|l| !l.is_empty())?;
    let first_parent = resolve_commit(repo, &format!("{oldest}^1")).ok()??;
    (first_parent != base_sha).then_some(MergeSignal::MergeCommit)
}

/// Bottom→top lists of layers. A bottom is a layer whose parent is not
/// itself a layer. A layer with several children (hand-edited config) follows
/// the first by name. Layers no walk reaches (a second child, or a cycle,
/// which has no bottom) are not hidden: each is reported as its own
/// single-layer chain, after the others, in name order.
pub(crate) fn chains(all: &BTreeMap<String, StackMeta>) -> Vec<Vec<String>> {
    let mut children: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    for m in all.values() {
        children
            .entry(m.parent.as_str())
            .or_default()
            .push(m.branch.as_str());
    }
    let mut out = Vec::new();
    for m in all.values().filter(|m| !all.contains_key(&m.parent)) {
        let mut chain = vec![m.branch.clone()];
        let mut seen: BTreeSet<&str> = BTreeSet::from([m.branch.as_str()]);
        let mut cur = m.branch.as_str();
        while let Some(next) = children.get(cur).and_then(|c| c.first()) {
            if !seen.insert(next) {
                break;
            }
            chain.push((*next).to_string());
            cur = next;
        }
        out.push(chain);
    }
    let reached: BTreeSet<String> = out.iter().flatten().cloned().collect();
    out.extend(
        all.keys()
            .filter(|b| !reached.contains(*b))
            .map(|b| vec![b.clone()]),
    );
    out
}

/// Commits on `branch`'s upstream that `branch` lacks. 0 when no upstream is
/// configured, or when its tracking ref is gone (nothing local to be behind).
/// Any other failure is an error: the `parent_behind` refusal fails closed.
pub(crate) fn behind_upstream(repo: &Path, branch: &str) -> Result<u32, String> {
    validate_branch_name(branch)?;
    let local = format!("refs/heads/{branch}");
    let out = run(repo, &["for-each-ref", "--format=%(upstream)", &local])?;
    if !out.status.success() {
        return Err(format!(
            "git for-each-ref {local}: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    let upstream = stdout(&out);
    if upstream.is_empty() || resolve_commit(repo, &upstream)?.is_none() {
        return Ok(0);
    }
    let range = format!("{local}..{upstream}");
    let out = run(repo, &["rev-list", "--count", &range, "--"])?;
    let text = stdout(&out);
    match (out.status.success(), text.parse()) {
        (true, Ok(n)) => Ok(n),
        _ => Err(format!(
            "git rev-list --count {range}: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stack::meta::read_all;
    use crate::stack::meta::set_parent;
    use crate::stack::LayerState;
    use crate::stack::LayerStatus;
    use crate::worktree::test_support::{git_at, TempRepo};

    /// main <- step-1 (a.txt) <- step-2 (b.txt) <- step-3 (c.txt). step-2 and
    /// step-3 are declared layers (step-1 sits on the trunk, which
    /// `set_parent` refuses as a parent); step-3 is left checked out.
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

    fn layer<'a>(s: &'a StackReport, b: &str) -> &'a LayerStatus {
        s.layers
            .iter()
            .find(|l| l.branch == b)
            .unwrap_or_else(|| panic!("no layer {b} in {:?}", s.layers))
    }

    fn base_of(r: &TempRepo, b: &str) -> String {
        r.git(&["config", "--get", &format!("branch.{b}.gitwandStackBase")])
    }

    /// Squash-merge `step-1` into main, push it to origin, then put local
    /// main back behind origin/main (the real post-GitHub-merge situation).
    fn squash_step1_on_origin(r: &TempRepo) {
        r.add_bare_origin();
        r.git(&["checkout", "-q", "main"]);
        r.git(&["merge", "-q", "--squash", "step-1"]);
        r.git(&["commit", "-q", "-m", "step 1 (squash)"]);
        r.git(&["push", "-q", "origin", "main"]);
        r.git(&["reset", "-q", "--hard", "HEAD~1"]);
        r.git(&["checkout", "-q", "step-3"]);
    }

    #[test]
    fn up_to_date_stack_reports_no_action() {
        let r = TempRepo::new();
        stack3(&r);
        let s = status(&r.path, Some("main"), &[]).unwrap();
        assert_eq!(s.trunk.as_deref(), Some("main"));
        assert_eq!(s.remote_trunk, None);
        assert!(!s.rebase_in_progress);
        assert_eq!(
            s.layers
                .iter()
                .map(|l| l.branch.as_str())
                .collect::<Vec<_>>(),
            ["step-2", "step-3"]
        );
        assert!(s
            .layers
            .iter()
            .all(|l| l.state == LayerState::UpToDate && !l.actionable && !l.inherited));
        assert!(s.layers.iter().all(|l| l.top == "step-3"));
        assert_eq!(
            layer(&s, "step-2").parent_tip,
            Some(r.git(&["rev-parse", "step-1"]))
        );
    }

    #[test]
    fn no_trunk_reports_no_layers() {
        let r = TempRepo::new();
        stack3(&r);
        r.git(&["branch", "-m", "main", "trunkless"]);
        let s = status(&r.path, None, &[]).unwrap();
        assert_eq!(s.trunk, None);
        assert!(s.layers.is_empty());
    }

    #[test]
    fn parent_moved_marks_lowest_layer_actionable_and_inherits_above() {
        let r = TempRepo::new();
        stack3(&r);
        r.git(&["checkout", "-q", "step-1"]);
        r.commit("a2.txt", "more\n", "s1 more");
        r.git(&["checkout", "-q", "step-3"]);
        let s = status(&r.path, Some("main"), &[]).unwrap();
        assert_eq!(layer(&s, "step-2").state, LayerState::OutOfDate);
        assert!(layer(&s, "step-2").actionable);
        assert!(!layer(&s, "step-2").inherited);
        assert!(layer(&s, "step-3").inherited && !layer(&s, "step-3").actionable);
        assert_eq!(layer(&s, "step-3").top, "step-3");
        assert_eq!(layer(&s, "step-2").parent_behind_upstream, 0);
    }

    #[test]
    fn single_commit_squash_is_detected_by_cherry() {
        let r = TempRepo::new();
        stack3(&r);
        squash_step1_on_origin(&r);
        let s = status(&r.path, Some("main"), &[]).unwrap();
        assert_eq!(s.remote_trunk.as_deref(), Some("origin/main"));
        let l2 = layer(&s, "step-2");
        assert_eq!(l2.state, LayerState::ParentMerged);
        assert_eq!(l2.merge_signal, Some(MergeSignal::Cherry));
        assert_eq!(l2.merged_pr, None);
        assert!(l2.actionable);
        assert!(layer(&s, "step-3").inherited && !layer(&s, "step-3").actionable);
        assert!(s.layers.iter().all(|l| l.branch != "step-1"));
    }

    #[test]
    fn merge_commit_merge_is_detected() {
        let r = TempRepo::new();
        stack3(&r);
        r.add_bare_origin();
        r.git(&["checkout", "-q", "main"]);
        r.git(&["merge", "-q", "--no-ff", "-m", "Merge step-1", "step-1"]);
        r.git(&["push", "-q", "origin", "main"]);
        r.git(&["reset", "-q", "--hard", "HEAD~1"]);
        r.git(&["checkout", "-q", "step-3"]);
        let s = status(&r.path, Some("main"), &[]).unwrap();
        let l2 = layer(&s, "step-2");
        assert_eq!(l2.state, LayerState::ParentMerged);
        assert_eq!(l2.merge_signal, Some(MergeSignal::MergeCommit));
        assert!(l2.actionable);
    }

    #[test]
    fn multi_commit_squash_needs_the_forge_hint() {
        let r = TempRepo::new();
        stack3(&r);
        // step-1 gets a second commit; restack the layers above by hand so
        // the stack is up to date before the merge.
        r.git(&["checkout", "-q", "step-1"]);
        r.commit("a2.txt", "two\n", "s1 second");
        r.git(&["checkout", "-q", "step-2"]);
        r.git(&["rebase", "-q", "step-1"]);
        r.git(&["checkout", "-q", "step-3"]);
        r.git(&["rebase", "-q", "step-2"]);
        // let status self-heal the bases first
        status(&r.path, Some("main"), &[]).unwrap();
        squash_step1_on_origin(&r);
        let p = &r.path;
        let s = status(p, Some("main"), &[]).unwrap();
        assert_eq!(layer(&s, "step-2").state, LayerState::UpToDate);
        assert_eq!(layer(&s, "step-2").merge_signal, None);
        let h = [MergedParentHint {
            branch: "step-1".into(),
            number: 812,
            head_ref_oid: None,
        }];
        let s = status(p, Some("main"), &h).unwrap();
        let l2 = layer(&s, "step-2");
        assert_eq!(l2.state, LayerState::ParentMerged);
        assert_eq!(l2.merged_pr, Some(812));
        assert_eq!(l2.merge_signal, Some(MergeSignal::Forge));
        assert!(l2.actionable);
        assert!(layer(&s, "step-3").inherited);
    }

    #[test]
    fn a_parent_without_commits_of_its_own_is_not_merged() {
        let r = TempRepo::new();
        r.add_bare_origin();
        // step-1 at main's tip, no commit of its own; step-2 one commit on it.
        r.git(&["branch", "step-1", "main"]);
        r.git(&["checkout", "-q", "-b", "step-2", "step-1"]);
        r.commit("b.txt", "2\n", "s2");
        set_parent(&r.path, Some("main"), "step-2", "step-1").unwrap();
        // Unrelated work merged on origin/main with a merge commit.
        r.git(&["checkout", "-q", "-b", "other", "main"]);
        r.commit("o.txt", "o\n", "other");
        r.git(&["checkout", "-q", "main"]);
        r.git(&["merge", "-q", "--no-ff", "-m", "Merge other", "other"]);
        r.git(&["push", "-q", "origin", "main"]);
        r.git(&["checkout", "-q", "step-2"]);
        let s = status(&r.path, Some("main"), &[]).unwrap();
        assert_eq!(layer(&s, "step-2").state, LayerState::UpToDate);
        assert_eq!(layer(&s, "step-2").merge_signal, None);
    }

    #[test]
    fn renamed_or_deleted_parent_reports_parent_missing() {
        let r = TempRepo::new();
        stack3(&r);
        r.git(&["branch", "-m", "step-1", "step-one"]);
        let s = status(&r.path, Some("main"), &[]).unwrap();
        let l2 = layer(&s, "step-2");
        assert_eq!(l2.state, LayerState::ParentMissing);
        assert_eq!(l2.parent_tip, None);
        assert!(!l2.actionable);
        assert_eq!(layer(&s, "step-3").state, LayerState::UpToDate);
        assert!(!layer(&s, "step-3").inherited);
    }

    #[test]
    fn self_heal_moves_base_to_parent_tip_after_a_manual_rebase() {
        let r = TempRepo::new();
        stack3(&r);
        r.git(&["checkout", "-q", "step-1"]);
        r.commit("a2.txt", "more\n", "s1 more");
        r.git(&["checkout", "-q", "step-2"]);
        r.git(&["rebase", "-q", "step-1"]);
        let s = status(&r.path, Some("main"), &[]).unwrap();
        let tip = r.git(&["rev-parse", "step-1"]);
        assert_eq!(layer(&s, "step-2").state, LayerState::UpToDate);
        assert_eq!(layer(&s, "step-2").base.as_deref(), Some(tip.as_str()));
        assert_eq!(base_of(&r, "step-2"), tip);
        // step-3 still sits on the old step-2: out of date, and the lowest.
        assert_eq!(layer(&s, "step-3").state, LayerState::OutOfDate);
        assert!(layer(&s, "step-3").actionable);
    }

    #[test]
    fn base_lost_when_neither_parent_tip_nor_base_is_an_ancestor() {
        let r = TempRepo::new();
        stack3(&r);
        let old_base = base_of(&r, "step-2");
        r.git(&["rebase", "-q", "--onto", "main", "step-1", "step-2"]);
        let s = status(&r.path, Some("main"), &[]).unwrap();
        let l2 = layer(&s, "step-2");
        assert_eq!(l2.state, LayerState::BaseLost);
        assert!(!l2.actionable && !l2.inherited);
        assert_eq!(base_of(&r, "step-2"), old_base);
    }

    #[test]
    fn no_writes_and_no_action_while_a_layer_is_rebasing() {
        let r = TempRepo::new();
        stack3(&r);
        // A stale-but-valid base on step-3 that self-heal would rewrite.
        let stale = r.git(&["rev-parse", "step-1"]);
        r.git(&["config", "branch.step-3.gitwandStackBase", &stale]);
        // step-1 moves with a change that conflicts with step-2.
        r.git(&["checkout", "-q", "step-1"]);
        r.commit("b.txt", "theirs\n", "s1 conflicting");
        r.git(&["checkout", "-q", "step-3"]);
        let s2_base = base_of(&r, "step-2");
        let wt = r.sandbox.join("wt");
        r.git(&["worktree", "add", "-q", wt.to_str().unwrap(), "step-2"]);
        let out = crate::git::git_cmd()
            .args(["rebase", "step-1"])
            .current_dir(&wt)
            .output()
            .unwrap();
        assert!(!out.status.success(), "rebase should halt on a conflict");
        assert_eq!(git_at(&wt, &["branch", "--show-current"]), "");
        let s = status(&r.path, Some("main"), &[]).unwrap();
        assert!(s.rebase_in_progress);
        assert!(s.layers.iter().all(|l| !l.actionable));
        assert_eq!(layer(&s, "step-2").state, LayerState::OutOfDate);
        assert_eq!(base_of(&r, "step-2"), s2_base);
        assert_eq!(base_of(&r, "step-3"), stale);
    }

    #[test]
    fn parent_behind_its_upstream_is_reported() {
        let r = TempRepo::new();
        stack3(&r);
        r.add_bare_origin();
        r.git(&["branch", "--set-upstream-to=origin/step-1", "step-1"]);
        r.git(&["checkout", "-q", "step-1"]);
        // one commit only on origin/step-1 …
        r.commit("remote.txt", "r\n", "suggestion");
        r.git(&["push", "-q", "origin", "step-1"]);
        r.git(&["reset", "-q", "--hard", "HEAD~1"]);
        // … and one only on the local step-1, so step-2 is out of date.
        r.commit("local.txt", "l\n", "local");
        r.git(&["checkout", "-q", "step-3"]);
        assert_eq!(behind_upstream(&r.path, "step-1"), Ok(1));
        assert_eq!(behind_upstream(&r.path, "step-2"), Ok(0));
        let s = status(&r.path, Some("main"), &[]).unwrap();
        let l2 = layer(&s, "step-2");
        assert_eq!(l2.state, LayerState::OutOfDate);
        assert_eq!(l2.parent_behind_upstream, 1);
    }

    #[test]
    fn behind_upstream_is_zero_without_or_with_a_gone_upstream_and_errs_otherwise() {
        let r = TempRepo::new();
        stack3(&r);
        assert_eq!(behind_upstream(&r.path, "step-1"), Ok(0));
        // Configured, but the remote-tracking ref is gone (pruned): nothing
        // local to be behind.
        r.git(&["config", "branch.step-1.remote", "origin"]);
        r.git(&["config", "branch.step-1.merge", "refs/heads/step-1"]);
        assert_eq!(behind_upstream(&r.path, "step-1"), Ok(0));
        assert!(behind_upstream(&r.path, "-x").is_err());
    }

    #[test]
    fn chains_run_bottom_to_top_per_stack() {
        let m = |b: &str, p: &str| StackMeta {
            branch: b.into(),
            parent: p.into(),
            base: None,
            pending: None,
        };
        let all: BTreeMap<String, StackMeta> = [
            m("b2", "b1"),
            m("a1", "main"),
            m("b1", "develop"),
            m("a3", "a2"),
            m("a2", "a1"),
        ]
        .into_iter()
        .map(|x| (x.branch.clone(), x))
        .collect();
        assert_eq!(
            chains(&all),
            vec![
                vec!["a1".to_string(), "a2".into(), "a3".into()],
                vec!["b1".to_string(), "b2".into()],
            ]
        );
    }

    #[test]
    fn merged_signal_is_none_for_an_unmerged_parent() {
        let r = TempRepo::new();
        stack3(&r);
        r.add_bare_origin();
        let base = base_of(&r, "step-2");
        assert_eq!(
            merged_signal(&r.path, "refs/remotes/origin/main", &base),
            None
        );
        assert_eq!(
            merged_signal(&r.path, "refs/remotes/origin/main", "-x"),
            None
        );
    }

    #[test]
    fn an_empty_parent_is_not_merged_after_main_was_merged_into_a_feature() {
        let r = TempRepo::new();
        r.add_bare_origin();
        // A feature forked before main's tip.
        r.git(&["checkout", "-q", "-b", "feat", "main"]);
        r.commit("f.txt", "f\n", "feat");
        r.git(&["checkout", "-q", "main"]);
        r.commit("m.txt", "m\n", "main moves");
        // step-1 at main's tip with no commit of its own; step-2 on it.
        r.git(&["branch", "step-1", "main"]);
        r.git(&["checkout", "-q", "-b", "step-2", "step-1"]);
        r.commit("b.txt", "2\n", "s2");
        set_parent(&r.path, Some("main"), "step-2", "step-1").unwrap();
        // "Merge main into feat", then feat merged into main with --no-ff.
        r.git(&["checkout", "-q", "feat"]);
        r.git(&[
            "merge",
            "-q",
            "--no-ff",
            "-m",
            "Merge main into feat",
            "main",
        ]);
        r.git(&["checkout", "-q", "main"]);
        r.git(&["merge", "-q", "--no-ff", "-m", "Merge feat", "feat"]);
        r.git(&["push", "-q", "origin", "main"]);
        r.git(&["checkout", "-q", "step-2"]);
        let base = base_of(&r, "step-2");
        assert_eq!(
            merged_signal(&r.path, "refs/remotes/origin/main", &base),
            None
        );
        let s = status(&r.path, Some("main"), &[]).unwrap();
        assert_eq!(layer(&s, "step-2").state, LayerState::UpToDate);
        assert_eq!(layer(&s, "step-2").merge_signal, None);
    }

    #[test]
    fn a_layer_whose_branch_is_gone_is_left_out_without_failing() {
        let r = TempRepo::new();
        stack3(&r);
        r.git(&["checkout", "-q", "step-2"]);
        r.git(&["update-ref", "-d", "refs/heads/step-3"]);
        assert!(read_all(&r.path).unwrap().contains_key("step-3"));
        let s = status(&r.path, Some("main"), &[]).unwrap();
        assert_eq!(
            s.layers
                .iter()
                .map(|l| l.branch.as_str())
                .collect::<Vec<_>>(),
            ["step-2"]
        );
        assert_eq!(layer(&s, "step-2").top, "step-2");
    }

    #[test]
    fn a_merged_parent_deleted_locally_is_merged_not_missing() {
        let r = TempRepo::new();
        stack3(&r);
        squash_step1_on_origin(&r);
        r.git(&["branch", "-q", "-D", "step-1"]);
        let s = status(&r.path, Some("main"), &[]).unwrap();
        let l2 = layer(&s, "step-2");
        assert_eq!(l2.state, LayerState::ParentMerged);
        assert_eq!(l2.merge_signal, Some(MergeSignal::Cherry));
        assert_eq!(l2.parent_tip, None);
    }

    #[test]
    fn without_a_base_the_parent_tip_is_probed_for_a_merge() {
        let r = TempRepo::new();
        stack3(&r);
        r.git(&["config", "--unset", "branch.step-2.gitwandStackBase"]);
        squash_step1_on_origin(&r);
        let s = status(&r.path, Some("main"), &[]).unwrap();
        let l2 = layer(&s, "step-2");
        assert_eq!(l2.base, None);
        assert_eq!(l2.state, LayerState::ParentMerged);
        assert_eq!(l2.merge_signal, Some(MergeSignal::Cherry));
    }

    #[test]
    fn a_stale_forge_hint_is_ignored_when_the_parent_moved_past_it() {
        let r = TempRepo::new();
        stack3(&r);
        let merged_head = r.git(&["rev-parse", "step-1"]);
        let hint = |oid: &str| MergedParentHint {
            branch: "step-1".into(),
            number: 7,
            head_ref_oid: Some(oid.into()),
        };
        // The PR's head is the parent's current tip: honoured.
        let s = status(&r.path, Some("main"), &[hint(&merged_head)]).unwrap();
        assert_eq!(layer(&s, "step-2").state, LayerState::ParentMerged);
        // The parent got a commit the merged PR never had: stale, ignored.
        r.git(&["checkout", "-q", "step-1"]);
        r.commit("a2.txt", "new\n", "s1 after merge");
        r.git(&["checkout", "-q", "step-3"]);
        let s = status(&r.path, Some("main"), &[hint(&merged_head)]).unwrap();
        let l2 = layer(&s, "step-2");
        assert_eq!(l2.state, LayerState::OutOfDate);
        assert_eq!(l2.merged_pr, None);
    }

    #[test]
    fn cycle_and_second_child_layers_are_reported_as_their_own_chain() {
        let m = |b: &str, p: &str| StackMeta {
            branch: b.into(),
            parent: p.into(),
            base: None,
            pending: None,
        };
        let all: BTreeMap<String, StackMeta> = [
            m("a1", "main"),
            m("a2", "a1"),
            m("a2b", "a1"),
            m("x", "y"),
            m("y", "x"),
        ]
        .into_iter()
        .map(|x| (x.branch.clone(), x))
        .collect();
        assert_eq!(
            chains(&all),
            vec![
                vec!["a1".to_string(), "a2".into()],
                vec!["a2b".to_string()],
                vec!["x".to_string()],
                vec!["y".to_string()],
            ]
        );
    }

    #[test]
    fn is_ancestor_errors_name_the_command() {
        let r = TempRepo::new();
        let e = is_ancestor(&r.path, "refs/heads/nope", "main").unwrap_err();
        assert!(
            e.contains("merge-base --is-ancestor refs/heads/nope main"),
            "{e}"
        );
    }

    #[test]
    fn propagate_skips_only_the_merged_parent_of_the_layer_above() {
        let l = |b: &str, p: &str, state: LayerState| LayerStatus {
            branch: b.into(),
            parent: p.into(),
            base: None,
            parent_tip: None,
            state,
            inherited: false,
            actionable: false,
            merge_signal: None,
            merged_pr: None,
            parent_behind_upstream: 0,
            top: String::new(),
        };
        let p = |blocker, dropped_for| Propagation {
            blocker,
            dropped_for,
        };
        // a out of date blocks everything above.
        let c = [
            l("a", "main-ish", LayerState::OutOfDate),
            l("b", "a", LayerState::UpToDate),
            l("c", "b", LayerState::OutOfDate),
        ];
        let refs: Vec<&LayerStatus> = c.iter().collect();
        assert_eq!(
            propagate(&refs),
            [p(None, None), p(Some(0), None), p(Some(0), None)]
        );
        // b is merged into a and dropped by c: c is not blocked by b, and
        // d above c is blocked by c.
        let c = [
            l("a", "x", LayerState::UpToDate),
            l("b", "a", LayerState::OutOfDate),
            l("c", "b", LayerState::ParentMerged),
            l("d", "c", LayerState::UpToDate),
        ];
        let refs: Vec<&LayerStatus> = c.iter().collect();
        assert_eq!(
            propagate(&refs),
            [
                p(None, None),
                p(None, Some(2)),
                p(None, None),
                p(Some(2), None)
            ]
        );
        // c's merged parent is a deleted branch, not b: b still blocks.
        let c = [
            l("b", "a", LayerState::OutOfDate),
            l("c", "gone", LayerState::ParentMerged),
        ];
        let refs: Vec<&LayerStatus> = c.iter().collect();
        assert_eq!(propagate(&refs), [p(None, None), p(Some(0), None)]);
    }
}

//! v3.14.0 — Stacked branches. Stack metadata lives in the repo's local git
//! config (`meta`); later tasks add status, restack planning and execution.
//!
//! Wire format: snake_case, nested fields included (`MergeBackCheck`
//! precedent).

use serde::{Deserialize, Serialize};

pub(crate) mod detect;
pub(crate) mod guard;
pub(crate) mod meta;
pub(crate) mod restack;

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum Moment {
    ParentMoved,
    ParentMerged,
}

// The types below are consumed by later tasks of the stacked-branches plan;
// until then only `meta` uses a few of them.
#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum LayerState {
    UpToDate,
    OutOfDate,
    ParentMerged,
    ParentMissing,
    BaseLost,
}

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum MergeSignal {
    Forge,
    Cherry,
    MergeCommit,
}

#[derive(Serialize, Clone, PartialEq, Eq, Debug)]
pub struct StackMeta {
    pub branch: String,
    pub parent: String,
    pub base: Option<String>,
    pub pending: Option<PendingRestack>,
}

#[derive(Serialize, Clone, PartialEq, Eq, Debug)]
pub struct PendingRestack {
    pub moment: Moment,
    pub onto: String,
    pub old_base: String,
    pub bottom: String,
    pub new_parent: Option<String>,
    pub original: String,
    /// The top's tip read just before the rebase (D4).
    pub top_sha: String,
    /// Moment 2: the bottom's parent at run time; `None` for moment 1.
    pub merged_parent: Option<String>,
    /// The worktree the restack ran in: `-` for the main one, else its id
    /// (`.git/worktrees/<id>`) in hex. Any worktree settles the record; only
    /// this one (or one that cannot read its own id) switches branches, back
    /// from the top or a reattach, each under its own guards.
    pub worktree: String,
}

#[derive(Deserialize, Clone, PartialEq, Eq, Debug)]
pub struct MergedParentHint {
    pub branch: String,
    pub number: i64,
    pub head_ref_oid: Option<String>,
    /// The merged PR's merge commit on its base (the squash commit for a
    /// squash merge). A moment-2 restack refuses a target that lacks it (I-2).
    #[serde(default)]
    pub merge_commit_oid: Option<String>,
}

#[derive(Serialize, Clone, PartialEq, Eq, Debug)]
pub struct LayerStatus {
    pub branch: String,
    pub parent: String,
    pub base: Option<String>,
    pub parent_tip: Option<String>,
    pub state: LayerState,
    pub inherited: bool,
    pub actionable: bool,
    pub merge_signal: Option<MergeSignal>,
    pub merged_pr: Option<i64>,
    pub parent_behind_upstream: u32,
    pub top: String,
}

#[derive(Serialize, Clone, PartialEq, Eq, Debug)]
pub struct FinalizedRestack {
    pub moment: Moment,
    pub bottom: String,
    pub merged_parent: Option<String>,
    pub new_parent: Option<String>,
    pub moved: Vec<String>,
    pub switched_back_to: Option<String>,
    pub switch_error: Option<SwitchError>,
    /// Moment 2: the merged parent, when deleting it loses nothing (I-1,
    /// M-1): it still exists, its tip is the commit the restack took as its
    /// old tip or the merged PR's head, and no worktree has it checked out
    /// (the current one included). `None` otherwise: no delete offer.
    pub delete_offer: Option<DeleteOffer>,
}

/// A merged parent that may be deleted, and the tip that was verified: the
/// delete is a compare-and-swap on it (`stack_delete_merged_parent`).
#[derive(Serialize, Clone, PartialEq, Eq, Debug)]
pub struct DeleteOffer {
    pub branch: String,
    pub tip: String,
}

/// Why the finalize could not switch back to the branch the user was on.
#[derive(Serialize, Clone, PartialEq, Eq, Debug)]
pub struct SwitchError {
    pub branch: String,
    pub reason: String,
}

/// A pending record that could not be settled, by the top that holds it.
#[derive(Serialize, Clone, PartialEq, Eq, Debug)]
pub struct PendingError {
    pub top: String,
    pub error: String,
}

#[derive(Serialize, Clone, PartialEq, Eq, Debug)]
pub struct StackReport {
    pub trunk: Option<String>,
    pub remote_trunk: Option<String>,
    pub layers: Vec<LayerStatus>,
    pub rebase_in_progress: bool,
    pub finalized: Option<FinalizedRestack>,
    /// `false` as well when the repo has no layer: it is not evaluated then.
    pub git_supports_restack: bool,
    /// The pending records that could not be settled, one per top (sorted).
    /// Each is kept, and its stack is not actionable until it is.
    pub pending_errors: Vec<PendingError>,
}

#[derive(Serialize, Clone, PartialEq, Eq, Debug)]
pub struct MovingRef {
    pub branch: String,
    pub in_stack: bool,
    pub upstream: Option<String>,
    /// The upstream tip read before the restack: the push lease. `None`
    /// without an upstream, when its tracking ref is gone, or when the push
    /// is blocked.
    pub remote_sha: Option<String>,
    /// Why this branch must not be pushed to its upstream (C-1): it tracks a
    /// local branch, or a remote branch of another name. Same words as the
    /// `git_push_branch` refusal.
    pub push_block: Option<String>,
}

#[derive(Serialize, Clone, PartialEq, Eq, Debug)]
pub struct RestackRefusal {
    pub code: String,
    pub message: String,
    /// The branch the refusal is about: the occupied branch, or the target
    /// (`parent_behind`, `merged_work_missing`).
    pub branch: Option<String>,
    /// The worktree holding `branch` (`occupied`, `occupied_rebasing`).
    pub path: Option<String>,
    /// The value the code's text needs (M-3): the commit count for
    /// `parent_behind`, the git version found for `git_too_old`.
    pub detail: Option<String>,
}

#[derive(Serialize, Clone, PartialEq, Eq, Debug)]
pub struct RestackPlan {
    pub moment: Moment,
    pub bottom: String,
    pub parent: String,
    pub onto_ref: String,
    pub onto_sha: String,
    pub upstream_sha: String,
    pub top: String,
    pub top_sha: String,
    pub moving: Vec<MovingRef>,
    pub new_parent: Option<String>,
    pub refusal: Option<RestackRefusal>,
}

#[derive(Deserialize, Clone, PartialEq, Eq, Debug)]
pub struct PreviewedRestack {
    pub onto_sha: String,
    pub upstream_sha: String,
    pub top_sha: String,
    pub moving: Vec<String>,
}

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
pub struct RestackRun {
    pub conflict: bool,
}

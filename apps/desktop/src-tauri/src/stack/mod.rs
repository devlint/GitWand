//! v3.14.0 — Stacked branches. Stack metadata lives in the repo's local git
//! config (`meta`); later tasks add status, restack planning and execution.
//!
//! Wire format: snake_case, nested fields included (`MergeBackCheck`
//! precedent).

use serde::{Deserialize, Serialize};

pub(crate) mod detect;
pub(crate) mod guard;
pub(crate) mod meta;

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
}

#[derive(Deserialize, Clone, PartialEq, Eq, Debug)]
pub struct MergedParentHint {
    pub branch: String,
    pub number: i64,
    pub head_ref_oid: Option<String>,
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

#[allow(dead_code)]
#[derive(Serialize, Clone, PartialEq, Eq, Debug)]
pub struct FinalizedRestack {
    pub moment: Moment,
    pub bottom: String,
    pub merged_parent: Option<String>,
    pub new_parent: Option<String>,
    pub moved: Vec<String>,
    pub switched_back_to: Option<String>,
    pub switch_error: Option<String>,
}

#[derive(Serialize, Clone, PartialEq, Eq, Debug)]
pub struct StackReport {
    pub trunk: Option<String>,
    pub remote_trunk: Option<String>,
    pub layers: Vec<LayerStatus>,
    pub rebase_in_progress: bool,
    pub finalized: Option<FinalizedRestack>,
    pub git_supports_restack: bool,
}

#[allow(dead_code)]
#[derive(Serialize, Clone, PartialEq, Eq, Debug)]
pub struct MovingRef {
    pub branch: String,
    pub in_stack: bool,
    pub upstream: Option<String>,
    pub remote_sha: Option<String>,
}

#[allow(dead_code)]
#[derive(Serialize, Clone, PartialEq, Eq, Debug)]
pub struct RestackRefusal {
    pub code: String,
    pub message: String,
    pub branch: Option<String>,
    pub path: Option<String>,
}

#[allow(dead_code)]
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

#[allow(dead_code)]
#[derive(Deserialize, Clone, PartialEq, Eq, Debug)]
pub struct PreviewedRestack {
    pub onto_sha: String,
    pub upstream_sha: String,
    pub top_sha: String,
    pub moving: Vec<String>,
}

#[allow(dead_code)]
#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
pub struct RestackRun {
    pub conflict: bool,
}

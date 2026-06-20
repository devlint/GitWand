use serde::{Serialize, Deserialize};

// ─── Constants ─────────────────────────────────────────────────────

#[cfg(target_os = "windows")]
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub const DIFF_TRUNCATE_BYTES: usize = 5 * 1024 * 1024;

pub const SKIP_DIRS: &[&str] = &["node_modules", "__pycache__", ".Trash", "target"];

pub const MACOS_TCC_PROTECTED: &[&str] = &[
    "Documents",
    "Desktop",
    "Downloads",
    "Pictures",
    "Movies",
    "Music",
    "Library",
];

pub const CLAUDE_AUTH_OVERRIDE_ENV: &[&str] = &[
    "ANTHROPIC_API_KEY",
    "CLAUDE_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
];

pub const HOOK_NAMES: &[&str] = &[
    "pre-commit",
    "prepare-commit-msg",
    "commit-msg",
    "post-commit",
    "pre-push",
    "pre-rebase",
    "post-checkout",
    "post-merge",
    "pre-receive",
    "update",
    "post-receive",
    "post-update",
    "post-rewrite",
    "applypatch-msg",
    "pre-applypatch",
    "post-applypatch",
    "pre-auto-gc",
    "sendemail-validate",
];

// ─── Git status types ──────────────────────────────────────────────

#[derive(Serialize)]
pub struct FileChange {
    pub path: String,
    pub status: String,
    pub old_path: Option<String>,
}

#[derive(Serialize)]
pub struct GitStatus {
    pub branch: String,
    pub remote: Option<String>,
    /// True when a remote-tracking branch matching the current branch exists,
    /// even if no upstream is configured (`@{u}` missing). Lets the UI tell
    /// "never pushed" apart from "pushed but not tracked" so it doesn't offer
    /// to publish an already-published branch.
    pub remote_branch_exists: bool,
    pub ahead: i32,
    pub behind: i32,
    pub main_commit_count: i32,
    pub push_remote: Option<String>,
    pub ahead_push: i32,
    pub staged: Vec<FileChange>,
    pub unstaged: Vec<FileChange>,
    pub untracked: Vec<String>,
    pub conflicted: Vec<String>,
}

// ─── Diff types ────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct DiffLine {
    pub r#type: String,
    pub content: String,
    pub old_line_no: Option<i32>,
    pub new_line_no: Option<i32>,
}

#[derive(Serialize)]
pub struct DiffHunk {
    pub header: String,
    pub old_start: i32,
    pub old_count: i32,
    pub new_start: i32,
    pub new_count: i32,
    pub lines: Vec<DiffLine>,
}

#[derive(Serialize)]
pub struct GitDiff {
    pub path: String,
    pub hunks: Vec<DiffHunk>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "oldPath")]
    pub old_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "truncatedFromBytes")]
    pub truncated_from_bytes: Option<u64>,
}

// ─── Git log types ─────────────────────────────────────────────────

#[derive(Serialize)]
pub struct GitLogEntry {
    pub hash: String,
    pub hash_full: String,
    pub author: String,
    pub email: String,
    pub date: String,
    pub message: String,
    pub body: String,
    pub parents: Vec<String>,
    pub refs: String,
}

// ─── File at revision ──────────────────────────────────────────────

#[derive(Serialize)]
pub struct FileAtRevision {
    pub bytes_base64: String,
    pub byte_length: usize,
    pub mime: String,
    pub absent: bool,
}

// ─── Folder diff types ─────────────────────────────────────────────

#[derive(Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FolderDiffNode {
    pub path: String,
    pub name: String,
    pub kind: String,
    pub status: Option<String>,
    pub old_path: Option<String>,
    pub files_changed: u32,
    pub additions: u32,
    pub deletions: u32,
    pub binary: bool,
    pub children: Vec<FolderDiffNode>,
}

pub struct RawFileChange {
    pub new_path: String,
    pub old_path: Option<String>,
    pub status: String,
    pub additions: u32,
    pub deletions: u32,
    pub binary: bool,
}

// ─── Directory listing types ──────────────────────────────────────

#[derive(Serialize)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_git_repo: bool,
}

#[derive(Serialize)]
pub struct ListDirResult {
    pub current: String,
    pub parent: Option<String>,
    pub home: String,
    pub dirs: Vec<DirEntry>,
}

// ─── Split commit ──────────────────────────────────────────────────

#[derive(Serialize)]
pub struct GitSplitCommitResult {
    pub first_hash: String,
    pub second_hash: String,
}

// ─── Push / Pull / Merge result ────────────────────────────────────

#[derive(Serialize)]
pub struct GitPushPullResult {
    pub success: bool,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conflicts: Option<bool>,
}

// ─── Repo operation state ──────────────────────────────────────────

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RepoOperationState {
    pub state: String,
    pub has_conflict: bool,
    pub operation_head: Option<String>,
    pub target_branch: Option<String>,
    pub step: u32,
    pub total: u32,
}

// ─── Git branch ────────────────────────────────────────────────────
#[derive(Serialize)]
pub struct GitBranch {
    pub name: String,
    pub is_current: bool,
    pub is_remote: bool,
    pub upstream: Option<String>,
    pub ahead: i32,
    pub behind: i32,
    pub main_commit_count: i32,
    pub last_commit: String,
    pub last_commit_date: String,
}

// ─── Blame types ───────────────────────────────────────────────────

#[derive(Serialize)]
pub struct BlameLine {
    pub hash: String,
    pub hash_full: String,
    pub final_line: u32,
    pub orig_line: u32,
    pub author: String,
    pub author_date: String,
    pub summary: String,
    pub content: String,
}

// ─── File log types ────────────────────────────────────────────────

#[derive(Serialize)]
pub struct FileLogEntry {
    pub hash_full: String,
    pub hash: String,
    pub author: String,
    pub date: String,
    pub message: String,
    pub body: String,
}

// ─── Conflict risk ─────────────────────────────────────────────────

#[derive(Serialize)]
pub struct ConflictRisk {
    pub branch: String,
    pub overlapping_files: Vec<String>,
    pub current_changed: usize,
    pub target_changed: usize,
}

// ─── Tag types ─────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct TagEntry {
    pub name: String,
    pub hash: String,
    pub is_annotated: bool,
    pub date: String,
    pub message: String,
}

// ─── Stash types ───────────────────────────────────────────────────

#[derive(Serialize)]
pub struct StashEntry {
    pub index: usize,
    pub message: String,
    pub branch: String,
    pub date: String,
    pub hash: String,
}

// ─── Monorepo types ────────────────────────────────────────────────

#[derive(Serialize)]
pub struct MonorepoPackage {
    pub name: String,
    pub path: String,
    pub version: String,
}

#[derive(Serialize)]
pub struct MonorepoInfo {
    pub is_monorepo: bool,
    pub manager: String,
    pub packages: Vec<MonorepoPackage>,
}

// ─── Remote info ───────────────────────────────────────────────────

#[derive(Serialize)]
pub struct RemoteInfo {
    pub name: String,
    pub url: String,
    pub provider: String,
    pub owner: String,
    pub repo: String,
}

// ─── PR types ──────────────────────────────────────────────────────

#[derive(Serialize, Deserialize)]
pub struct PullRequest {
    pub number: i64,
    pub title: String,
    pub state: String,
    pub author: String,
    pub branch: String,
    pub base: String,
    pub draft: bool,
    pub created_at: String,
    pub updated_at: String,
    pub url: String,
    pub additions: i64,
    pub deletions: i64,
    pub labels: Vec<String>,
    pub assignees: Vec<String>,
    pub review_requested: Vec<String>,
    pub review_decision: String,
    pub merge_state_status: String,
    pub checks_rollup: String,
    /// Number of issue-comments on the PR. Populated by the enriched
    /// workspace_prs_all path (v2.16) for the Launchpad notification diff;
    /// 0 on the light sidebar list path. `#[serde(default)]` so the
    /// Deserialize impl tolerates older payloads that omit it.
    #[serde(default)]
    pub comment_count: i64,
}

#[derive(Deserialize)]
pub struct GhPrAuthor {
    /// `None` when the original author has been deleted on GitHub, or for
    /// some app-authored PRs (Dependabot, GitHub Actions bot, etc.) where
    /// the GraphQL field is null. Tolerate this so we don't drop the PR.
    #[serde(default)]
    pub login: Option<String>,
}

#[derive(Deserialize)]
pub struct GhPrLabel {
    pub name: String,
}

#[derive(Deserialize)]
pub struct GhPrAssignee {
    #[serde(default)]
    pub login: Option<String>,
}

#[derive(Deserialize)]
pub struct GhPrReviewRequest {
    /// `gh pr list --json reviewRequests` emits each requested reviewer
    /// directly on the element (`{"__typename":"User","login":"…"}`), NOT
    /// nested under `requestedReviewer`. Teams carry no `login` → None.
    #[serde(default)]
    pub login: Option<String>,
}

#[derive(Deserialize)]
pub struct GhPrStatusCheck {
    /// CheckRun outcome (SUCCESS / FAILURE / …). `None` while still running.
    #[serde(default)]
    pub conclusion: Option<String>,
    /// StatusContext outcome (SUCCESS / PENDING / FAILURE / ERROR). Present on
    /// legacy commit-status entries that carry no `conclusion`.
    #[serde(default)]
    pub state: Option<String>,
    /// CheckRun lifecycle (QUEUED / IN_PROGRESS / COMPLETED). Used to detect a
    /// check that is still running (no conclusion yet).
    #[serde(default)]
    pub status: Option<String>,
}

#[derive(Deserialize)]
pub struct GhPrDetailRaw {
    pub number: i64,
    pub title: String,
    pub body: String,
    pub state: String,
    pub author: GhPrAuthor,
    #[serde(rename = "headRefName")]
    pub head_ref_name: String,
    #[serde(rename = "baseRefName")]
    pub base_ref_name: String,
    #[serde(rename = "isDraft")]
    pub is_draft: bool,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
    #[serde(rename = "mergedAt")]
    pub merged_at: Option<String>,
    pub url: String,
    #[serde(default)]
    pub additions: i64,
    #[serde(default)]
    pub deletions: i64,
    #[serde(rename = "changedFiles", default)]
    pub changed_files: i64,
    #[serde(default)]
    pub labels: Vec<GhPrLabel>,
    #[serde(rename = "reviewRequests", default)]
    pub review_requests: Vec<GhPrReviewRequest>,
    #[serde(default)]
    pub comments: Vec<serde_json::Value>,
    #[serde(default)]
    pub reviews: Vec<serde_json::Value>,
    #[serde(default)]
    pub mergeable: Option<String>,
    #[serde(rename = "statusCheckRollup", default)]
    pub status_check_rollup: Vec<GhPrStatusCheck>,
}

#[derive(Deserialize)]
pub struct GhPrRaw {
    pub number: i64,
    pub title: String,
    pub state: String,
    /// `None` when GitHub returns `null` for the author (deleted user,
    /// some bot accounts). We display an empty author rather than dropping
    /// the PR entirely.
    #[serde(default)]
    pub author: Option<GhPrAuthor>,
    #[serde(rename = "headRefName")]
    pub head_ref_name: String,
    #[serde(rename = "baseRefName")]
    pub base_ref_name: String,
    #[serde(rename = "isDraft")]
    pub is_draft: bool,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
    pub url: String,
    #[serde(default)]
    pub additions: i64,
    #[serde(default)]
    pub deletions: i64,
    #[serde(default)]
    pub labels: Vec<GhPrLabel>,
    #[serde(default)]
    pub assignees: Vec<GhPrAssignee>,
    #[serde(rename = "reviewRequests", default)]
    pub review_requests: Vec<GhPrReviewRequest>,
    #[serde(rename = "reviewDecision")]
    pub review_decision: Option<String>,
    #[serde(rename = "mergeStateStatus")]
    pub merge_state_status: Option<String>,
    #[serde(rename = "statusCheckRollup", default)]
    pub status_check_rollup: Vec<GhPrStatusCheck>,
    /// Issue-comments array — only requested by the enriched workspace_prs_all
    /// path (v2.16). Empty on the light sidebar list. We only need its length.
    #[serde(default)]
    pub comments: Vec<serde_json::Value>,
}

// ─── Pull Request Detail ───────────────────────────────────────────

#[derive(Serialize)]
pub struct PullRequestDetail {
    pub number: i64,
    pub title: String,
    pub body: String,
    pub state: String,
    pub author: String,
    pub branch: String,
    pub base: String,
    pub draft: bool,
    pub created_at: String,
    pub updated_at: String,
    pub merged_at: String,
    pub url: String,
    pub additions: i64,
    pub deletions: i64,
    pub changed_files: i64,
    pub comments: i64,
    pub review_comments: i64,
    pub labels: Vec<String>,
    pub reviewers: Vec<String>,
    pub mergeable: String,
    pub checks_status: String,
    /// Whether the current viewer has permission to merge this PR.
    /// `None` when the forge does not cheaply expose it (Azure, Bitbucket) —
    /// the UI must treat unknown as "allowed" and gate on errors only, never
    /// disable the merge button on an unknown permission.
    #[serde(default)]
    pub can_merge: Option<bool>,
}

// ─── Fork / PR target info ─────────────────────────────────────────

/// Describes the current repo's GitHub fork relationship, used by the PR
/// create view to offer "open against upstream" for forks.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForkInfo {
    /// True when `origin` is a fork of another GitHub repo.
    pub is_fork: bool,
    /// `origin` as `owner/repo` (the head side of a cross-fork PR).
    pub origin: String,
    /// Parent/upstream as `owner/repo`, or "" when not a fork.
    pub parent: String,
}

// ─── GitHub OAuth device flow ──────────────────────────────────────

/// Returned by `github_device_start` — the user-facing code + the
/// `device_code` the frontend polls with.
#[derive(Serialize)]
pub struct GithubDeviceCode {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    /// `verification_uri` with the user code pre-filled — opening this skips the
    /// manual code-entry step. Empty if GitHub omits it.
    pub verification_uri_complete: String,
    pub expires_in: i64,
    /// Minimum seconds between polls (GitHub-mandated, floored at 5).
    pub interval: i64,
}

/// Returned by `github_device_poll`. `status` ∈
/// `"pending" | "slow_down" | "success" | "error"`. The token itself is never
/// returned — it is stored directly in the OS keychain on success.
#[derive(Serialize)]
pub struct GithubDevicePoll {
    pub status: String,
    pub login: String,
    pub error: String,
}

// ─── CI Check ──────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct CICheck {
    pub name: String,
    pub state: String,
    pub conclusion: String,
    pub details_url: String,
}

// ─── CI Annotation (v2.18) ─────────────────────────────────────────

/// A single check-run / code-quality annotation anchored to a file line.
///
/// Forge-agnostic shape:
///   - GitHub  : check-runs annotations API (`annotation_level`)
///   - GitLab  : codequality report artifact (Code Climate severity)
///   - Bitbucket: Reports API annotations (severity)
#[derive(Serialize)]
pub struct CIAnnotation {
    /// Name of the check-run / job / report that produced the annotation.
    pub check_name: String,
    pub path: String,
    pub start_line: i64,
    pub end_line: i64,
    /// "failure" | "warning" | "notice"
    pub level: String,
    pub title: String,
    pub message: String,
}

// ─── Reviewer candidate ────────────────────────────────────────────

#[derive(Serialize)]
pub struct ReviewerCandidate {
    pub login: String,
    pub name: Option<String>,
    pub avatar_url: Option<String>,
}

// ─── Terminal result ───────────────────────────────────────────────

#[derive(Serialize)]
pub struct TerminalResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

// ─── Merge preview ─────────────────────────────────────────────────

#[derive(Serialize, Clone)]
pub struct FileMergePreview {
    pub file_path: String,
    pub conflict_content: String,
    pub has_conflicts: bool,
    pub is_add_delete: bool,
}

// ─── Scratch worktree (v2.20.0) ────────────────────────────────────
//
// A temporary isolated worktree (`gitwand-scratch-<timestamp>`) used to
// resolve conflicts away from the active checkout, then merge the result
// back in one click. See commands::scratch.

#[derive(Serialize, Clone)]
pub struct ScratchWorktree {
    /// Absolute path of the scratch worktree on disk.
    pub path: String,
    /// Branch created for the scratch (`gitwand-scratch-<timestamp>`).
    pub branch: String,
    /// Branch/ref the scratch was based on.
    pub source_branch: String,
    /// Creation time (unix epoch seconds).
    pub created_at: u64,
}

// ─── Claude CLI ────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct ClaudeCliInfo {
    pub found: bool,
    pub path: String,
    pub version: String,
    pub logged_in: bool,
    pub status: String,
    pub detail: String,
}

// ─── Codex CLI ─────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct CodexCliInfo {
    pub found: bool,
    pub path: String,
    pub version: String,
    pub logged_in: bool,
    pub status: String,
    pub detail: String,
}

// ─── opencode CLI (v2.17) ──────────────────────────────────────────

#[derive(Serialize)]
pub struct OpencodeCliInfo {
    pub found: bool,
    pub path: String,
    pub version: String,
    pub logged_in: bool,
    pub status: String,
    pub detail: String,
}

// ─── GitHub Copilot CLI ────────────────────────────────────────────

#[derive(Serialize)]
pub struct CopilotCliInfo {
    pub found: bool,
    pub path: String,
    pub version: String,
    pub logged_in: bool,
    pub status: String,
    pub detail: String,
}

// ─── Git hooks ─────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct HookEntry {
    pub name: String,
    pub enabled: bool,
    pub executable: bool,
    pub preview: String,
}

// ─── Workspace types ───────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone)]
pub struct WorkspaceRepo {
    pub path: String,
    pub name: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct WorkspaceConfig {
    pub name: String,
    pub repos: Vec<WorkspaceRepo>,
    /// Active monorepo scope — a repo-relative directory path (v2.21.0).
    /// Optional + skipped when None so older config files round-trip unchanged.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
}

#[derive(Serialize)]
pub struct WorkspaceRepoStatus {
    pub path: String,
    pub name: String,
    pub branch: String,
    pub ahead: u32,
    pub behind: u32,
    pub has_upstream: bool,
    pub modified: u32,
    pub conflicted: u32,
    pub error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceWipItem {
    pub path: String,
    pub name: String,
    pub branch: String,
    pub ahead: u32,
    pub behind: u32,
    pub staged_count: u32,
    pub unstaged_count: u32,
    pub untracked_count: u32,
    pub last_commit_at: String,
    pub has_no_upstream: bool,
    pub error: Option<String>,
    pub changed_files: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRepoPrs {
    pub repo_path: String,
    pub repo_name: String,
    pub prs: Vec<PullRequest>,
    pub error: Option<String>,
}

// ─── Issue types ───────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    pub number: i64,
    pub title: String,
    pub state: String,
    pub author: String,
    pub assignees: Vec<String>,
    pub labels: Vec<String>,
    pub url: String,
    pub created_at: String,
    pub updated_at: String,
    pub milestone: String,
}

#[derive(Deserialize)]
pub struct GhIssueAuthor {
    pub login: String,
}

#[derive(Deserialize)]
pub struct GhIssueAssignee {
    pub login: String,
}

#[derive(Deserialize)]
pub struct GhIssueLabel {
    pub name: String,
}

#[derive(Deserialize)]
pub struct GhIssueMilestone {
    pub title: String,
}

#[derive(Deserialize)]
pub struct GhIssueRaw {
    pub number: i64,
    pub title: String,
    pub state: String,
    pub author: GhIssueAuthor,
    #[serde(default)]
    pub assignees: Vec<GhIssueAssignee>,
    #[serde(default)]
    pub labels: Vec<GhIssueLabel>,
    pub url: String,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
    pub milestone: Option<GhIssueMilestone>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRepoIssues {
    pub repo_path: String,
    pub repo_name: String,
    pub issues: Vec<Issue>,
    pub filter: String,
    pub error: Option<String>,
}

/// Detailed view of a single GitHub issue (body + comment count) — backs the
/// in-app IssueDetailView. Mirrors `Issue` plus `body` and `comments` (count).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueDetail {
    pub number: i64,
    pub title: String,
    pub body: String,
    pub state: String,
    pub author: String,
    pub assignees: Vec<String>,
    pub labels: Vec<String>,
    pub url: String,
    pub created_at: String,
    pub updated_at: String,
    pub milestone: String,
    /// Number of conversation comments on the issue.
    pub comments: i64,
}

/// Raw `gh issue view --json …` shape for the detail endpoint.
#[derive(Deserialize)]
pub struct GhIssueDetailRaw {
    pub number: i64,
    pub title: String,
    #[serde(default)]
    pub body: String,
    pub state: String,
    pub author: GhIssueAuthor,
    #[serde(default)]
    pub assignees: Vec<GhIssueAssignee>,
    #[serde(default)]
    pub labels: Vec<GhIssueLabel>,
    pub url: String,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
    pub milestone: Option<GhIssueMilestone>,
    /// `gh issue view --json comments` returns the full comment array; we only
    /// need its length for the detail header badge.
    #[serde(default)]
    pub comments: Vec<serde_json::Value>,
}

// ─── Worktree types ────────────────────────────────────────────────

#[derive(Serialize, Clone)]
pub struct WorktreeEntry {
    pub path: String,
    pub branch: String,
    pub head: String,
    pub is_main: bool,
    pub is_locked: bool,
    pub lock_reason: Option<String>,
    pub is_bare: bool,
    pub is_prunable: bool,
    pub prunable_reason: Option<String>,
}

// ─── Agent session types ──────────────────────────────────────────

#[derive(Serialize, Clone)]
pub struct AgentSession {
    pub path: String,
    pub branch: String,
    pub tool: String,
    pub active: bool,
    pub ahead: u32,
    pub behind: u32,
    pub modified: u32,
}

// ─── Submodule types ───────────────────────────────────────────────

#[derive(Serialize, Clone)]
pub struct SubmoduleEntry {
    pub path: String,
    pub url: String,
    pub sha: String,
    pub branch: Option<String>,
    pub status: String,
}

#[derive(Serialize, Clone)]
pub struct SubmoduleBranch {
    pub name: String,
    pub is_current: bool,
}

#[derive(Serialize, Clone)]
pub struct CommitSubmoduleChange {
    pub path: String,
    pub pointed_sha: String,
}

// ─── Shortlog types ────────────────────────────────────────────────

#[derive(Serialize)]
pub struct ShortlogEntry {
    pub name: String,
    pub email: String,
    pub count: u32,
}

// ─── Tree conflict types ───────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeConflict {
    pub path: String,
    /// git short-status code, e.g. "UD", "DU", "DD", "AU", "UA"
    pub code: String,
    pub has_base: bool,
    pub has_ours: bool,
    pub has_theirs: bool,
}

// ─── Reconstructed conflict (content conflict from index stages) ────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconstructedConflict {
    /// 3-way merge of the index stages, with diff3 conflict markers.
    pub content: String,
    /// Whether the current working-tree bytes equal stage 2 (ours) or stage 3 (theirs).
    pub wt_matches_side: bool,
}

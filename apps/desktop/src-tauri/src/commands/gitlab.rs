//! GitLab CLI (`glab`) Tauri commands — §2.x Forge integrations.
//!
//! Wraps the official `glab` CLI (gitlab.com/gitlab-org/cli) for MR workflows:
//! list, create, checkout, merge, diff, pipelines, notes, approvals.
//!
//! **Auth**: managed by `glab auth login` — the PAT is normally stored in
//! glab's own config (`~/.config/glab-cli/config.yml`) and `glab` handles
//! credential lookup itself. Exception: `--use-keyring` mode stores the PAT
//! in the macOS keychain instead, which hangs when `glab` is spawned from a
//! signed Tauri app (same ACL mismatch as the `gh` keychain issue, #149) —
//! `shell_env.rs` preloads a `GITLAB_TOKEN` env var at startup to make
//! `hidden_cmd` bypass that path, same as it already does for `gh`.
//!
//! **Project resolution**: `glab api` substitutes `:fullpath` with the
//! URL-encoded `namespace%2Frepo` of the repo in `cwd`, so we never need to
//! hard-code project IDs in endpoint strings.
//!
//! **Pattern**: every command delegates its blocking `hidden_cmd("glab")`
//! work to a private sync `_inner` fn run via `tauri::async_runtime::spawn_blocking`
//! (matching `commands/gh.rs`, see its `gh.rs:16-21`) so a slow `glab` never
//! parks a Tokio worker thread. The primary invocation of each command is
//! further bounded by `output_with_timeout` (`GLAB_TIMEOUT` = 20s, under the
//! frontend's 30s IPC timeout) so a hung subprocess is killed rather than
//! orphaned (#149).

use crate::git::{hidden_cmd, output_with_timeout};
use crate::types::*;
use rayon::prelude::*;
use std::collections::HashMap;
use std::time::{Duration, Instant};

/// Timeout for the primary `glab` invocation of a command (#149). Chosen to
/// leave headroom under the frontend's 30s IPC race (`backend-core.ts`
/// `IPC_TIMEOUT.DEFAULT`) so the Rust "timed out" error surfaces instead of
/// the frontend's generic "IPC timeout after 30000ms" message.
const GLAB_TIMEOUT: Duration = Duration::from_secs(20);
/// Timeout for best-effort `glab api` helpers (`gl_pipeline_rollup`,
/// `glab_api_json`) — these already degrade gracefully on any error.
const GLAB_API_TIMEOUT: Duration = Duration::from_secs(5);
/// Overall wall-clock budget for the per-MR pipeline fan-out in `gl_list_mrs`.
const ROLLUP_BUDGET: Duration = Duration::from_secs(5);

// ─── JSON field helpers ────────────────────────────────────────────────────────

/// Extract a string field from a serde_json::Value object.
fn js(v: &serde_json::Value, key: &str) -> String {
    v.get(key)
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string()
}

/// Extract an i64 field. Also handles string-encoded numbers (GitLab quirk).
fn ji(v: &serde_json::Value, key: &str) -> i64 {
    v.get(key)
        .and_then(|x| x.as_i64())
        .or_else(|| {
            v.get(key)
                .and_then(|x| x.as_str())
                .and_then(|s| s.parse().ok())
        })
        .unwrap_or(0)
}

/// Extract a bool field.
fn jb(v: &serde_json::Value, key: &str) -> bool {
    v.get(key).and_then(|x| x.as_bool()).unwrap_or(false)
}

/// Extract `obj[key].username` — GitLab user objects use `username` not `login`.
fn juser(v: &serde_json::Value, key: &str) -> String {
    v.get(key)
        .and_then(|u| u.get("username"))
        .and_then(|u| u.as_str())
        .unwrap_or("")
        .to_string()
}

/// Extract an array of `username` strings from `obj[key]` = [{username:...}].
fn jusernames(v: &serde_json::Value, key: &str) -> Vec<String> {
    v.get(key)
        .and_then(|a| a.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|u| u.get("username").and_then(|n| n.as_str()))
                .map(String::from)
                .collect()
        })
        .unwrap_or_default()
}

/// Extract label names from `obj[key]` — GitLab returns labels as [String] or [{name:...}].
fn jlabels(v: &serde_json::Value, key: &str) -> Vec<String> {
    v.get(key)
        .and_then(|a| a.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|l| {
                    l.as_str()
                        .map(String::from)
                        .or_else(|| l.get("name").and_then(|n| n.as_str()).map(String::from))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Map GitLab MR state strings to our canonical state.
fn gl_state(state: &str) -> String {
    match state {
        "opened" => "open".to_string(),
        s => s.to_string(), // "merged", "closed", "locked" — pass through
    }
}

/// Map our canonical MR state ("opened"/"closed"/"merged"/"all") to the
/// corresponding `glab mr list` boolean flag.
///
/// Unlike `gh`, `glab mr list` has no generic `--state <value>` flag — it
/// exposes one boolean flag per state (`--opened` is the CLI's own default,
/// plus `--closed` / `--merged` / `--all`). Passing `--state <value>` (the
/// `gh` convention) is rejected by `glab` with "Unknown flag: --state"
/// (issue #138).
fn gl_state_flag(state: &str) -> &'static str {
    match state {
        "closed" => "--closed",
        "merged" => "--merged",
        "all" => "--all",
        _ => "--opened",
    }
}

// ─── MR → PullRequest mapping ─────────────────────────────────────────────────

/// Map a GitLab MR JSON object to a PullRequest.
///
/// GitLab MR fields: iid, title, state, author, source_branch, target_branch,
/// draft, created_at, updated_at, web_url, labels, assignees, reviewers,
/// merge_status, diff_stats (on detail endpoints).
fn gl_mr_to_pr(mr: &serde_json::Value) -> PullRequest {
    let state = js(mr, "state");
    // Draft MRs: `draft` boolean (GitLab 14+) or legacy title prefix "Draft:"/"WIP:".
    let title = js(mr, "title");
    let is_draft = jb(mr, "draft") || title.starts_with("Draft:") || title.starts_with("WIP:");

    // diff_stats is present on `gl_get_mr` (detail) responses.
    let (additions, deletions) = mr
        .get("diff_stats")
        .map(|s| (ji(s, "additions"), ji(s, "deletions")))
        .unwrap_or((0, 0));

    PullRequest {
        number: ji(mr, "iid"),
        title,
        state: gl_state(&state),
        author: juser(mr, "author"),
        branch: js(mr, "source_branch"),
        base: js(mr, "target_branch"),
        draft: is_draft,
        created_at: js(mr, "created_at"),
        updated_at: js(mr, "updated_at"),
        url: js(mr, "web_url"),
        additions,
        deletions,
        labels: jlabels(mr, "labels"),
        assignees: jusernames(mr, "assignees"),
        review_requested: jusernames(mr, "reviewers"),
        review_decision: String::new(),
        merge_state_status: js(mr, "merge_status"),
        checks_rollup: String::new(),
        comment_count: ji(mr, "user_notes_count"),
    }
}

/// Map GitLab's merge-status fields to our canonical MERGEABLE / CONFLICTING
/// / UNKNOWN (#161).
///
/// `merge_status` was deprecated in GitLab 15.6 in favor of
/// `detailed_merge_status`: the old field is binary in practice (only
/// `can_be_merged` means yes), lumping every other reason a merge might be
/// blocked — CI still running, approvals pending, unresolved discussions —
/// together with "not yet computed" (`unchecked`, `checking`). Treating all
/// of those as `CONFLICTING` (the previous mapping) put a false-positive
/// merge-conflict warning on almost every MR, since `unchecked` is the
/// common resting state until something triggers a recheck. Only an actual
/// `conflict` (or the legacy `cannot_be_merged*` values when
/// `detailed_merge_status` isn't present) is a real conflict; anything else
/// maps to `UNKNOWN`, which the frontend already renders as a neutral dash
/// rather than a warning (see `isMergeConflict` in `usePrPanel.ts`).
fn gl_mergeable_state(mr: &serde_json::Value) -> String {
    let detailed = js(mr, "detailed_merge_status");
    if !detailed.is_empty() {
        return match detailed.as_str() {
            "mergeable" => "MERGEABLE",
            "conflict" => "CONFLICTING",
            _ => "UNKNOWN",
        }
        .to_string();
    }
    match js(mr, "merge_status").as_str() {
        "can_be_merged" => "MERGEABLE",
        "cannot_be_merged" | "cannot_be_merged_recheck" => "CONFLICTING",
        _ => "UNKNOWN",
    }
    .to_string()
}

/// Map a GitLab MR JSON object to a PullRequestDetail (richer fields).
fn gl_mr_to_detail(mr: &serde_json::Value) -> PullRequestDetail {
    let state = js(mr, "state");
    let title = js(mr, "title");
    let is_draft = jb(mr, "draft") || title.starts_with("Draft:") || title.starts_with("WIP:");

    let (additions, deletions) = mr
        .get("diff_stats")
        .map(|s| (ji(s, "additions"), ji(s, "deletions")))
        .unwrap_or((0, 0));

    // `changes_count` is a string-encoded number on some GitLab versions.
    let changed_files: i64 = mr
        .get("changes_count")
        .and_then(|v| v.as_i64())
        .or_else(|| {
            mr.get("changes_count")
                .and_then(|v| v.as_str())
                .and_then(|s| s.parse().ok())
        })
        .unwrap_or(0);

    let mergeable = gl_mergeable_state(mr);

    PullRequestDetail {
        number: ji(mr, "iid"),
        title,
        body: js(mr, "description"),
        state: gl_state(&state),
        author: juser(mr, "author"),
        branch: js(mr, "source_branch"),
        base: js(mr, "target_branch"),
        draft: is_draft,
        created_at: js(mr, "created_at"),
        updated_at: js(mr, "updated_at"),
        merged_at: js(mr, "merged_at"),
        url: js(mr, "web_url"),
        additions,
        deletions,
        changed_files,
        comments: 0,        // Would need a separate notes count call
        review_comments: 0, // Same
        labels: jlabels(mr, "labels"),
        reviewers: jusernames(mr, "reviewers"),
        mergeable,
        checks_status: String::new(),
        // GitLab's single-MR endpoint carries `user.can_merge` for the caller.
        can_merge: mr
            .get("user")
            .and_then(|u| u.get("can_merge"))
            .and_then(|b| b.as_bool()),
        head_sha: mr
            .get("diff_refs")
            .and_then(|d| d.get("head_sha"))
            .and_then(|s| s.as_str())
            .map(String::from)
            .unwrap_or_else(|| js(mr, "sha")),
    }
}

// ─── Tauri commands ────────────────────────────────────────────────────────────

/// Detect if `glab` CLI is installed and accessible.
///
/// Short timeout (`GLAB_API_TIMEOUT`, 5s): this is a `--version` probe on the
/// repo-open path, and a 20s hang here would stall forge detection for every
/// panel.
fn detect_glab_inner(cwd: String) -> bool {
    let mut cmd = hidden_cmd("glab");
    cmd.arg("--version").current_dir(&cwd);
    output_with_timeout(cmd, GLAB_API_TIMEOUT)
        .map(|o| o.status.success())
        .unwrap_or(false)
}

#[tauri::command]
pub(crate) async fn detect_glab(cwd: String) -> bool {
    tauri::async_runtime::spawn_blocking(move || detect_glab_inner(cwd))
        .await
        .unwrap_or(false)
}

/// `--per-page` value for a `limit`/`offset` window, clamped to GitLab's
/// 100-per-page ceiling (#161) — see `gl_mr_list_per_page_tests` above for
/// the background-prefetch failure this fixes.
fn gl_mr_list_per_page(limit: Option<i64>, offset: Option<i64>) -> i64 {
    let page = limit.unwrap_or(10).max(1);
    let off = offset.unwrap_or(0).max(0);
    (page + off).min(100)
}

/// List merge requests using `glab mr list`.
///
/// `state` accepts "opened" (default), "closed", "merged", "all".
/// Pagination: naïve slice — glab doesn't support cursor pagination via CLI.
fn gl_list_mrs_inner(
    cwd: String,
    state: String,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<Vec<PullRequest>, String> {
    let flag = gl_state_flag(&state);
    let off = offset.unwrap_or(0).max(0);
    let total = gl_mr_list_per_page(limit, offset).to_string();

    let mut cmd = hidden_cmd("glab");
    cmd.args(["mr", "list", flag, "--per-page", &total, "--output", "json"])
        .current_dir(&cwd);
    let output = output_with_timeout(cmd, GLAB_TIMEOUT)
        .map_err(|e| format!("Failed to run glab mr list (is glab installed?): {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("glab mr list failed: {}", stderr));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let raw: serde_json::Value = serde_json::from_str(stdout.trim())
        .map_err(|e| format!("Failed to parse glab mr list output: {}", e))?;

    let arr = raw.as_array().ok_or_else(|| {
        format!(
            "Expected JSON array from glab mr list, got: {}",
            &stdout[..stdout.len().min(200)]
        )
    })?;

    let mut mrs: Vec<PullRequest> = arr.iter().map(gl_mr_to_pr).collect();

    // Naïve offset: skip first `offset` entries.
    if off > 0 {
        let skip = (off as usize).min(mrs.len());
        mrs.drain(..skip);
    }

    // Colour the sidebar dot from each MR's pipeline. The list payload rarely
    // embeds `head_pipeline`, so use it when present (free) and otherwise fetch
    // the pipeline per MR in parallel (red = failed, yellow = pending).
    let embedded: HashMap<i64, String> = arr
        .iter()
        .filter_map(|mr| {
            let iid = ji(mr, "iid");
            let status = mr
                .get("head_pipeline")
                .or_else(|| mr.get("pipeline"))
                .map(|p| js(p, "status"))?;
            Some((iid, status))
        })
        .collect();
    // Overall wall-clock budget for the fan-out below, not just a per-call
    // cap: both the rollup and the diff-stats fetch are best-effort (empty /
    // 0-0 on any error or once the deadline passes), so degrading past it is
    // a behavior the code already supports. Kept as ONE shared budget (not
    // stacked per fetch) so the worst case for a list load stays at
    // `ROLLUP_BUDGET`, not double it — the diff-stats fetch was left out of
    // the list view for exactly this reason (#161) until this shared-deadline
    // approach made it safe to add.
    let enrich_deadline = Instant::now() + ROLLUP_BUDGET;
    let enrich: HashMap<i64, (String, i64, i64)> = mrs
        .par_iter()
        .map(|mr| {
            let rollup = match embedded.get(&mr.number) {
                Some(s) => gl_status_to_rollup(s),
                None if Instant::now() < enrich_deadline => gl_pipeline_rollup(&cwd, mr.number),
                None => String::new(),
            };
            let (additions, deletions) = if Instant::now() < enrich_deadline {
                gl_mr_diff_stats(&cwd, mr.number)
            } else {
                (0, 0)
            };
            (mr.number, (rollup, additions, deletions))
        })
        .collect();
    for mr in &mut mrs {
        if let Some((rollup, additions, deletions)) = enrich.get(&mr.number) {
            if !rollup.is_empty() {
                mr.checks_rollup = rollup.clone();
            }
            mr.additions = *additions;
            mr.deletions = *deletions;
        }
    }

    Ok(mrs)
}

#[tauri::command]
pub(crate) async fn gl_list_mrs(
    cwd: String,
    state: String,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<Vec<PullRequest>, String> {
    tauri::async_runtime::spawn_blocking(move || gl_list_mrs_inner(cwd, state, limit, offset))
        .await
        .map_err(|e| e.to_string())?
}

/// Map our canonical state to the GitLab REST `state` query value used by
/// `gl_mr_count_inner`'s `X-Total` lookup (distinct from `gl_state_flag`,
/// which returns a `glab mr list` CLI flag, not a query string value).
fn gl_state_query(state: &str) -> &'static str {
    match state {
        "closed" => "closed",
        "merged" => "merged",
        "all" => "all",
        _ => "opened",
    }
}

/// Parse the `X-Total` value out of `glab api --include`'s curl-style
/// "headers, blank line, body" output. Header name match is case-insensitive
/// and tolerant of `\r\n` line endings; stops scanning at the first blank
/// line (end of headers) so it never accidentally matches something in the
/// JSON body.
fn gl_parse_x_total(output: &str) -> Option<i64> {
    for line in output.lines() {
        let line = line.trim_end_matches('\r');
        if line.is_empty() {
            break;
        }
        // The status line ("HTTP/2 200") has no colon — skip it rather than
        // bailing out of the whole scan via `?`.
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        if name.eq_ignore_ascii_case("x-total") {
            return value.trim().parse().ok();
        }
    }
    None
}

/// Count MRs.
///
/// Prefers the REST list endpoint's `X-Total` response header (GitLab's
/// standard offset-pagination total, exposed via `glab api --include`) — a
/// single cheap `per_page=1` call regardless of how many MRs actually exist.
/// Falls back to fetching up to 100 via `glab mr list` and counting the
/// array (the old behavior, silently capped at 100) only if the header is
/// ever absent, e.g. an old self-hosted GitLab or a project forced onto
/// keyset-only pagination (#161 — the old approach was the *only* path and
/// capped every repo with over 100 open MRs at exactly 100).
///
/// Returns 0 on non-fatal errors so the Launchpad badge can still render.
fn gl_mr_count_inner(cwd: String, state: String) -> Result<i64, String> {
    let endpoint = format!(
        "projects/:fullpath/merge_requests?state={}&per_page=1",
        gl_state_query(&state)
    );
    let mut cmd = hidden_cmd("glab");
    cmd.args(["api", "--include", &endpoint]).current_dir(&cwd);
    if let Ok(output) = output_with_timeout(cmd, GLAB_TIMEOUT) {
        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            if let Some(total) = gl_parse_x_total(&stdout) {
                return Ok(total);
            }
        }
    }

    // Fallback: no X-Total header available.
    let flag = gl_state_flag(&state);
    let mut cmd = hidden_cmd("glab");
    cmd.args(["mr", "list", flag, "--per-page", "100", "--output", "json"])
        .current_dir(&cwd);
    let output = match output_with_timeout(cmd, GLAB_TIMEOUT) {
        Ok(o) => o,
        Err(_) => return Ok(0),
    };

    if !output.status.success() {
        return Ok(0);
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let arr: serde_json::Value =
        serde_json::from_str(stdout.trim()).unwrap_or(serde_json::Value::Array(vec![]));
    Ok(arr.as_array().map(|a| a.len() as i64).unwrap_or(0))
}

#[tauri::command]
pub(crate) async fn gl_mr_count(cwd: String, state: String) -> Result<i64, String> {
    tauri::async_runtime::spawn_blocking(move || gl_mr_count_inner(cwd, state))
        .await
        .map_err(|e| e.to_string())?
}

/// Get detailed MR info using `glab mr view`.
fn gl_get_mr_inner(cwd: String, iid: i64) -> Result<PullRequestDetail, String> {
    let mut cmd = hidden_cmd("glab");
    cmd.args(["mr", "view", &iid.to_string(), "--output", "json"])
        .current_dir(&cwd);
    let output =
        output_with_timeout(cmd, GLAB_TIMEOUT).map_err(|e| format!("glab mr view: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "glab mr view failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mr: serde_json::Value = serde_json::from_str(stdout.trim())
        .map_err(|e| format!("Failed to parse glab mr view output: {}", e))?;

    let mut detail = gl_mr_to_detail(&mr);
    // Prefer the pipeline status embedded in the MR object (free); fall back to
    // a dedicated pipelines call so the CI tab can colour red / yellow / green.
    let embedded = mr
        .get("head_pipeline")
        .or_else(|| mr.get("pipeline"))
        .map(|p| js(p, "status"))
        .unwrap_or_default();
    detail.checks_status = if embedded.is_empty() {
        gl_pipeline_rollup(&cwd, iid)
    } else {
        gl_status_to_rollup(&embedded)
    };
    // GitLab's MR resource carries no line-level stats (#161 — `diff_stats`
    // read by `gl_mr_to_detail` never exists on a real GitLab payload, so it
    // always fell through to 0/0). One extra call, only on the detail path.
    let (additions, deletions) = gl_mr_diff_stats(&cwd, iid);
    detail.additions = additions;
    detail.deletions = deletions;
    Ok(detail)
}

/// Sum real `+`/`-` line counts out of each file's unified-diff hunk text,
/// as returned by the `/merge_requests/:iid/diffs` endpoint (#161). File
/// header lines (`--- a/...`, `+++ b/...`) are skipped so they're never
/// miscounted as a deletion/addition of their own.
fn gl_diff_stats_from_files(files: &[serde_json::Value]) -> (i64, i64) {
    let mut additions = 0i64;
    let mut deletions = 0i64;
    for f in files {
        let diff = f.get("diff").and_then(|d| d.as_str()).unwrap_or("");
        for line in diff.lines() {
            if line.starts_with("+++") || line.starts_with("---") {
                continue;
            }
            if line.starts_with('+') {
                additions += 1;
            } else if line.starts_with('-') {
                deletions += 1;
            }
        }
    }
    (additions, deletions)
}

/// Fetch a MR's diffs and reduce them to (additions, deletions). Best-effort
/// — (0, 0) on any error, same non-fatal pattern as `gl_pipeline_rollup`,
/// since a stats miss shouldn't block the rest of the MR detail from
/// rendering.
fn gl_mr_diff_stats(cwd: &str, iid: i64) -> (i64, i64) {
    let endpoint = format!(
        "projects/:fullpath/merge_requests/{}/diffs?per_page=100",
        iid
    );
    let mut cmd = hidden_cmd("glab");
    cmd.args(["api", &endpoint]).current_dir(cwd);
    let out = match output_with_timeout(cmd, GLAB_API_TIMEOUT) {
        Ok(o) if o.status.success() => o,
        _ => return (0, 0),
    };
    let stdout = String::from_utf8_lossy(&out.stdout);
    let v: serde_json::Value =
        serde_json::from_str(stdout.trim()).unwrap_or(serde_json::Value::Array(vec![]));
    match v.as_array() {
        Some(files) => gl_diff_stats_from_files(files),
        None => (0, 0),
    }
}

#[tauri::command]
pub(crate) async fn gl_get_mr(cwd: String, iid: i64) -> Result<PullRequestDetail, String> {
    tauri::async_runtime::spawn_blocking(move || gl_get_mr_inner(cwd, iid))
        .await
        .map_err(|e| e.to_string())?
}

/// Get a MR's diff refs (F1, v3.6.0) — `base_sha`/`start_sha`/`head_sha`,
/// required to correctly anchor inline discussion comments (old/new-side
/// positioning) via the Discussions API. Same `glab mr view --output json`
/// fetch pattern as `gl_mr_to_detail`.
fn gl_mr_diff_refs_inner(cwd: String, iid: i64) -> Result<MrDiffRefs, String> {
    let mut cmd = hidden_cmd("glab");
    cmd.args(["mr", "view", &iid.to_string(), "--output", "json"])
        .current_dir(&cwd);
    let output =
        output_with_timeout(cmd, GLAB_TIMEOUT).map_err(|e| format!("glab mr view: {}", e))?;
    if !output.status.success() {
        return Err(format!(
            "glab mr view failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mr: serde_json::Value = serde_json::from_str(stdout.trim())
        .map_err(|e| format!("Failed to parse glab mr view output: {}", e))?;
    let refs = mr
        .get("diff_refs")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    let base_sha = js(&refs, "base_sha");
    let start_sha = js(&refs, "start_sha");
    let head_sha = js(&refs, "head_sha");
    Ok(MrDiffRefs {
        base_sha: base_sha.clone(),
        start_sha: if start_sha.is_empty() {
            base_sha
        } else {
            start_sha
        },
        head_sha: if head_sha.is_empty() {
            js(&mr, "sha")
        } else {
            head_sha
        },
    })
}

#[tauri::command]
pub(crate) async fn gl_mr_diff_refs(cwd: String, iid: i64) -> Result<MrDiffRefs, String> {
    tauri::async_runtime::spawn_blocking(move || gl_mr_diff_refs_inner(cwd, iid))
        .await
        .map_err(|e| e.to_string())?
}

/// Build the `glab mr diff` argument list (#161).
///
/// `--raw` is required: `glab`'s default (non-raw) diff output is a
/// decorated/summarized rendering, not the git-compatible unified-diff
/// format (`diff --git a/... b/...` headers) the frontend's
/// `indexDiffFiles`/`parseFileDiff` parsers expect. Without it, those
/// parsers silently see zero files — no error, just an empty result — and
/// the UI renders "no diff available" regardless of what the MR contains.
fn gl_mr_diff_args(iid: i64) -> Vec<String> {
    vec![
        "mr".to_string(),
        "diff".to_string(),
        iid.to_string(),
        "--raw".to_string(),
    ]
}

/// Get the unified diff of a MR using `glab mr diff`.
fn gl_mr_diff_inner(cwd: String, iid: i64) -> Result<String, String> {
    let mut cmd = hidden_cmd("glab");
    cmd.args(gl_mr_diff_args(iid)).current_dir(&cwd);
    let output =
        output_with_timeout(cmd, GLAB_TIMEOUT).map_err(|e| format!("glab mr diff: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "glab mr diff failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

#[tauri::command]
pub(crate) async fn gl_mr_diff(cwd: String, iid: i64) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || gl_mr_diff_inner(cwd, iid))
        .await
        .map_err(|e| e.to_string())?
}

/// Get CI pipeline status for a MR using `glab api`.
///
/// Returns the most-recent pipeline as a single-entry list (GitLab only has
/// one "active" pipeline per MR at a time). Each job maps to a CICheck entry.
fn gl_mr_pipelines_inner(cwd: String, iid: i64) -> Result<Vec<CICheck>, String> {
    let endpoint = format!("projects/:fullpath/merge_requests/{}/pipelines", iid);
    let mut cmd = hidden_cmd("glab");
    cmd.args(["api", &endpoint]).current_dir(&cwd);
    let output =
        output_with_timeout(cmd, GLAB_TIMEOUT).map_err(|e| format!("glab api pipelines: {}", e))?;

    if !output.status.success() {
        return Ok(Vec::new()); // Non-fatal — no CI configured is common
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let pipelines: serde_json::Value =
        serde_json::from_str(stdout.trim()).unwrap_or(serde_json::Value::Array(vec![]));

    let arr = match pipelines.as_array() {
        Some(a) => a,
        None => return Ok(Vec::new()),
    };

    // Map each pipeline to a CICheck. `status` in GitLab:
    // pending, running, success, failed, canceled, skipped, manual, scheduled.
    Ok(arr
        .iter()
        .map(|p| {
            let status = js(p, "status");
            let conclusion = match status.as_str() {
                "success" => "SUCCESS",
                "failed" => "FAILURE",
                "canceled" => "CANCELLED",
                "skipped" => "SKIPPED",
                "running" | "pending" => "IN_PROGRESS",
                _ => "",
            }
            .to_string();
            CICheck {
                name: format!("Pipeline #{}", ji(p, "id")),
                state: status.clone(),
                conclusion,
                details_url: js(p, "web_url"),
            }
        })
        .collect())
}

#[tauri::command]
pub(crate) async fn gl_mr_pipelines(cwd: String, iid: i64) -> Result<Vec<CICheck>, String> {
    tauri::async_runtime::spawn_blocking(move || gl_mr_pipelines_inner(cwd, iid))
        .await
        .map_err(|e| e.to_string())?
}

/// Reduce a GitLab pipeline `status` to a rollup state the frontend colours:
/// `FAILURE` (red) / `PENDING` (yellow) / `SUCCESS` (green), or `""` (no CI).
fn gl_status_to_rollup(status: &str) -> String {
    match status {
        "success" => "SUCCESS",
        "failed" | "canceled" => "FAILURE",
        // No pipeline / skipped → no dot.
        "" | "skipped" => "",
        // created / waiting_for_resource / preparing / pending / running /
        // manual / scheduled → still in flight.
        _ => "PENDING",
    }
    .to_string()
}

/// Fetch a MR's most-recent pipeline and reduce it to a rollup state. Sync and
/// best-effort (empty on any error) so it's safe to fan out under rayon.
fn gl_pipeline_rollup(cwd: &str, iid: i64) -> String {
    let endpoint = format!("projects/:fullpath/merge_requests/{}/pipelines", iid);
    let mut cmd = hidden_cmd("glab");
    cmd.args(["api", &endpoint]).current_dir(cwd);
    let out = match output_with_timeout(cmd, GLAB_API_TIMEOUT) {
        Ok(o) if o.status.success() => o,
        _ => return String::new(),
    };
    let stdout = String::from_utf8_lossy(&out.stdout);
    let v: serde_json::Value =
        serde_json::from_str(stdout.trim()).unwrap_or(serde_json::Value::Array(vec![]));
    // The API returns pipelines newest-first; the first entry is the active one.
    let status = v
        .as_array()
        .and_then(|a| a.first())
        .map(|p| js(p, "status"))
        .unwrap_or_default();
    gl_status_to_rollup(&status)
}

/// Helper — run `glab api <endpoint>` and parse the JSON response.
/// Returns `None` on any failure (non-fatal pattern, like gl_mr_pipelines).
fn glab_api_json(cwd: &str, endpoint: &str) -> Option<serde_json::Value> {
    let mut cmd = hidden_cmd("glab");
    cmd.args(["api", endpoint]).current_dir(cwd);
    let output = output_with_timeout(cmd, GLAB_API_TIMEOUT).ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    serde_json::from_str(stdout.trim()).ok()
}

/// Get code-quality annotations for a MR (v2.18 — Inline CI Check Annotations).
///
/// GitLab has no per-line check-runs API; the equivalent signal is the
/// `artifacts:reports:codequality` report (Code Climate JSON format).
///
/// Flow:
///   1. Latest pipeline of the MR
///   2. Pipeline jobs → those exposing a `codequality` artifact
///   3. Download `gl-code-quality-report.json` from the job artifacts
///   4. Map Code Climate severity → failure / warning / notice
///
/// Non-fatal everywhere: no pipeline / no report → `[]`.
fn gl_mr_annotations_inner(cwd: String, iid: i64) -> Result<Vec<CIAnnotation>, String> {
    // 1. Latest pipeline.
    let pipelines = match glab_api_json(
        &cwd,
        &format!("projects/:fullpath/merge_requests/{}/pipelines", iid),
    ) {
        Some(v) => v,
        None => return Ok(Vec::new()),
    };
    let pipeline_id = match pipelines
        .as_array()
        .and_then(|a| a.first())
        .map(|p| ji(p, "id"))
    {
        Some(id) if id > 0 => id,
        _ => return Ok(Vec::new()),
    };

    // 2. Jobs of that pipeline, keep those with a codequality report artifact.
    let jobs = match glab_api_json(
        &cwd,
        &format!(
            "projects/:fullpath/pipelines/{}/jobs?per_page=100",
            pipeline_id
        ),
    ) {
        Some(v) => v,
        None => return Ok(Vec::new()),
    };
    let empty = vec![];
    let jobs = jobs.as_array().unwrap_or(&empty);

    let mut annotations = Vec::new();
    for job in jobs {
        let has_codequality = job
            .get("artifacts")
            .and_then(|a| a.as_array())
            .map(|arts| arts.iter().any(|f| js(f, "file_type") == "codequality"))
            .unwrap_or(false);
        if !has_codequality {
            continue;
        }
        let job_id = ji(job, "id");
        let job_name = js(job, "name");

        // 3. Report file. Default filename produced by `artifacts:reports:codequality`.
        let report = match glab_api_json(
            &cwd,
            &format!(
                "projects/:fullpath/jobs/{}/artifacts/gl-code-quality-report.json",
                job_id
            ),
        ) {
            Some(v) => v,
            None => continue, // report expired or custom filename — skip
        };
        let Some(entries) = report.as_array() else {
            continue;
        };

        // 4. Code Climate format:
        //    { description, check_name, severity, location: { path, lines: { begin, end? } } }
        for e in entries {
            let begin = e
                .get("location")
                .and_then(|l| l.get("lines"))
                .and_then(|l| l.get("begin"))
                .and_then(|v| v.as_i64())
                .unwrap_or(0);
            let end = e
                .get("location")
                .and_then(|l| l.get("lines"))
                .and_then(|l| l.get("end"))
                .and_then(|v| v.as_i64())
                .unwrap_or(begin);
            let path = e
                .get("location")
                .and_then(|l| l.get("path"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if path.is_empty() || begin == 0 {
                continue;
            }
            let level = match js(e, "severity").as_str() {
                "blocker" | "critical" | "major" => "failure",
                "minor" => "warning",
                _ => "notice", // "info" + unknown
            };
            annotations.push(CIAnnotation {
                check_name: job_name.clone(),
                path,
                start_line: begin,
                end_line: end.max(begin),
                level: level.to_string(),
                title: js(e, "check_name"),
                message: js(e, "description"),
            });
        }
    }

    Ok(annotations)
}

/// Converted from a non-async fn (#149, §1e): per `tauri-macros`, a
/// non-`async` command defaults to `ExecutionContext::Blocking`, executed
/// inline in the invoke handler rather than offloaded — this fetches up to
/// 2 + N_jobs `glab api` calls, so it needs the same `spawn_blocking`
/// treatment as everything else in this module.
#[tauri::command]
pub(crate) async fn gl_mr_annotations(cwd: String, iid: i64) -> Result<Vec<CIAnnotation>, String> {
    tauri::async_runtime::spawn_blocking(move || gl_mr_annotations_inner(cwd, iid))
        .await
        .map_err(|e| e.to_string())?
}

// ─── Issue → Issue mapping ────────────────────────────────────────────────────

/// Map a GitLab issue JSON object to an Issue.
///
/// GitLab issue fields: iid, title, state (`opened`/`closed`), author.username,
/// assignees[].username, labels[] (array of strings), web_url, created_at,
/// updated_at, milestone.title.
fn gl_issue_to_issue(v: &serde_json::Value) -> crate::types::Issue {
    let labels = v
        .get("labels")
        .and_then(|l| l.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    let milestone = v
        .get("milestone")
        .map(|m| js(m, "title"))
        .unwrap_or_default();
    crate::types::Issue {
        number: ji(v, "iid"),
        title: js(v, "title"),
        state: gl_state(&js(v, "state")),
        author: juser(v, "author"),
        assignees: jusernames(v, "assignees"),
        labels,
        url: js(v, "web_url"),
        created_at: js(v, "created_at"),
        updated_at: js(v, "updated_at"),
        milestone,
    }
}

/// List issues using `glab issue list`.
///
/// `filter` accepts "assigned" (assigned to me), "created" (created by me), or "" (all open).
/// Pagination: glab's `--per-page` to limit results.
fn gl_list_issues_inner(
    cwd: String,
    filter: String,
    limit: Option<i64>,
) -> Result<Vec<crate::types::Issue>, String> {
    // GitLab caps --per-page at 100; clamp so an over-large limit doesn't error.
    let lim = limit.unwrap_or(100).clamp(1, 100).to_string();
    let mut args: Vec<String> = vec![
        "issue".into(),
        "list".into(),
        "--state".into(),
        "opened".into(),
        "--per-page".into(),
        lim,
        "--output".into(),
        "json".into(),
    ];
    // glab filter flags: --assignee / --author accept usernames or "@me".
    match filter.as_str() {
        "assigned" => {
            args.push("--assignee".into());
            args.push("@me".into());
        }
        "created" => {
            args.push("--author".into());
            args.push("@me".into());
        }
        // "mentioned" has no native glab flag → fall back to all-open.
        _ => {}
    }
    let mut cmd = hidden_cmd("glab");
    cmd.args(&args).current_dir(&cwd);
    let output =
        output_with_timeout(cmd, GLAB_TIMEOUT).map_err(|e| format!("glab not available: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("glab issue list failed: {}", stderr.trim()));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let raw: serde_json::Value = serde_json::from_str(stdout.trim())
        .map_err(|e| format!("Failed to parse glab issue list output: {}", e))?;
    let arr = raw.as_array().cloned().unwrap_or_default();
    Ok(arr.iter().map(gl_issue_to_issue).collect())
}

#[tauri::command]
pub(crate) async fn gl_list_issues(
    cwd: String,
    filter: String,
    limit: Option<i64>,
) -> Result<Vec<crate::types::Issue>, String> {
    tauri::async_runtime::spawn_blocking(move || gl_list_issues_inner(cwd, filter, limit))
        .await
        .map_err(|e| e.to_string())?
}

/// Create a MR using `glab mr create`.
fn gl_create_mr_inner(
    cwd: String,
    title: String,
    body: String,
    source_branch: String,
    target_branch: String,
    draft: bool,
    reviewers: Option<Vec<String>>,
) -> Result<PullRequest, String> {
    let mut args: Vec<String> = vec![
        "mr".to_string(),
        "create".to_string(),
        "--title".to_string(),
        title,
        "--description".to_string(),
        body,
        "--source-branch".to_string(),
        source_branch,
        "--target-branch".to_string(),
        target_branch,
        "--yes".to_string(), // Skip interactive prompts
        "--output".to_string(),
        "json".to_string(),
    ];

    if draft {
        args.push("--draft".to_string());
    }

    if let Some(revs) = reviewers {
        for rev in revs {
            let r = rev.trim().trim_start_matches('@').to_string();
            if !r.is_empty() {
                args.push("--reviewer".to_string());
                args.push(r);
            }
        }
    }

    let mut cmd = hidden_cmd("glab");
    cmd.args(&args).current_dir(&cwd);
    let output = output_with_timeout(cmd, GLAB_TIMEOUT)
        .map_err(|e| format!("Failed to create MR: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "glab mr create failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mr: serde_json::Value = serde_json::from_str(stdout.trim())
        .map_err(|e| format!("Failed to parse glab mr create output: {}", e))?;

    Ok(gl_mr_to_pr(&mr))
}

#[tauri::command]
pub(crate) async fn gl_create_mr(
    cwd: String,
    title: String,
    body: String,
    source_branch: String,
    target_branch: String,
    draft: bool,
    reviewers: Option<Vec<String>>,
) -> Result<PullRequest, String> {
    tauri::async_runtime::spawn_blocking(move || {
        gl_create_mr_inner(
            cwd,
            title,
            body,
            source_branch,
            target_branch,
            draft,
            reviewers,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Merge a MR using `glab mr merge`.
///
/// `method` accepts "merge" (default), "squash", "rebase".
#[tauri::command]
fn gl_merge_mr_inner(cwd: String, iid: i64, method: String) -> Result<(), String> {
    let mut args: Vec<String> = vec!["mr".to_string(), "merge".to_string(), iid.to_string()];

    match method.as_str() {
        "squash" => args.push("--squash".to_string()),
        "rebase" => args.push("--rebase".to_string()),
        _ => {} // default merge
    }

    args.push("--yes".to_string());
    args.push("--delete-source-branch".to_string());

    let mut cmd = hidden_cmd("glab");
    cmd.args(&args).current_dir(&cwd);
    let output =
        output_with_timeout(cmd, GLAB_TIMEOUT).map_err(|e| format!("glab mr merge: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "glab mr merge failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn gl_merge_mr(cwd: String, iid: i64, method: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || gl_merge_mr_inner(cwd, iid, method))
        .await
        .map_err(|e| e.to_string())?
}

/// Checkout a MR branch locally using `glab mr checkout`.
#[tauri::command]
fn gl_checkout_mr_inner(cwd: String, iid: i64) -> Result<(), String> {
    let mut cmd = hidden_cmd("glab");
    cmd.args(["mr", "checkout", &iid.to_string()])
        .current_dir(&cwd);
    let output =
        output_with_timeout(cmd, GLAB_TIMEOUT).map_err(|e| format!("glab mr checkout: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "glab mr checkout failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn gl_checkout_mr(cwd: String, iid: i64) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || gl_checkout_mr_inner(cwd, iid))
        .await
        .map_err(|e| e.to_string())?
}

/// Convert a draft MR to ready-for-review using `glab mr update --draft=false`.
fn gl_convert_draft_to_ready_inner(cwd: String, iid: i64) -> Result<(), String> {
    let mut cmd = hidden_cmd("glab");
    cmd.args(["mr", "update", &iid.to_string(), "--draft=false"])
        .current_dir(&cwd);
    let output = output_with_timeout(cmd, GLAB_TIMEOUT)
        .map_err(|e| format!("glab mr update (draft→ready): {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "glab mr ready failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn gl_convert_draft_to_ready(cwd: String, iid: i64) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || gl_convert_draft_to_ready_inner(cwd, iid))
        .await
        .map_err(|e| e.to_string())?
}

/// Flatten a `/discussions` response into the flat note-array shape
/// `/notes` used to return, preserving each note's own fields — notably
/// `resolvable`/`resolved`, which the flat endpoint never carried (#161).
fn gl_flatten_discussions(discussions: &[serde_json::Value]) -> Vec<serde_json::Value> {
    let mut notes = Vec::new();
    for d in discussions {
        if let Some(arr) = d.get("notes").and_then(|n| n.as_array()) {
            notes.extend(arr.iter().cloned());
        }
    }
    notes
}

/// List notes (comments) for a MR via `glab api`.
///
/// Returns raw JSON array — parsed TypeScript-side into PrReviewComment[].
/// Uses the Discussions API (`/discussions`, flattened back to a flat note
/// array by `gl_flatten_discussions`) rather than the flat `/notes` endpoint
/// this used to call: `/notes` has no concept of a resolved thread at all,
/// so a resolved discussion's notes were indistinguishable from a live one
/// (#161). Diff-line anchoring for the notes *listing* is still not wired
/// up (`path`/`line` stay empty TypeScript-side) — only *creating* an
/// anchored comment already used the Discussions API, via
/// `gl_mr_create_discussion`.
#[tauri::command]
fn gl_mr_notes_inner(cwd: String, iid: i64) -> Result<serde_json::Value, String> {
    let endpoint = format!(
        "projects/:fullpath/merge_requests/{}/discussions?per_page=100",
        iid
    );
    let mut cmd = hidden_cmd("glab");
    cmd.args(["api", &endpoint]).current_dir(&cwd);
    let output = output_with_timeout(cmd, GLAB_TIMEOUT)
        .map_err(|e| format!("glab api discussions: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "gl mr notes failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let discussions: Vec<serde_json::Value> =
        serde_json::from_str(stdout.trim()).map_err(|e| format!("Parse discussions: {}", e))?;
    Ok(serde_json::Value::Array(gl_flatten_discussions(
        &discussions,
    )))
}

#[tauri::command]
pub(crate) async fn gl_mr_notes(cwd: String, iid: i64) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || gl_mr_notes_inner(cwd, iid))
        .await
        .map_err(|e| e.to_string())?
}

/// Create a note (comment) on a MR via `glab api`.
///
/// Returns the created note as raw JSON — parsed TypeScript-side.
fn gl_mr_create_note_inner(
    cwd: String,
    iid: i64,
    body: String,
) -> Result<serde_json::Value, String> {
    let endpoint = format!("projects/:fullpath/merge_requests/{}/notes", iid);
    let mut cmd = hidden_cmd("glab");
    cmd.args([
        "api",
        "-X",
        "POST",
        &endpoint,
        "-f",
        &format!("body={}", body),
    ])
    .current_dir(&cwd);
    let output = output_with_timeout(cmd, GLAB_TIMEOUT)
        .map_err(|e| format!("glab api create note: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "gl create note failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    serde_json::from_str(stdout.trim()).map_err(|e| format!("Parse created note: {}", e))
}

#[tauri::command]
pub(crate) async fn gl_mr_create_note(
    cwd: String,
    iid: i64,
    body: String,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || gl_mr_create_note_inner(cwd, iid, body))
        .await
        .map_err(|e| e.to_string())?
}

/// Update a note on a MR via `glab api`.
fn gl_mr_update_note_inner(
    cwd: String,
    iid: i64,
    note_id: i64,
    body: String,
) -> Result<(), String> {
    let endpoint = format!(
        "projects/:fullpath/merge_requests/{}/notes/{}",
        iid, note_id
    );
    let mut cmd = hidden_cmd("glab");
    cmd.args([
        "api",
        "-X",
        "PUT",
        &endpoint,
        "-f",
        &format!("body={}", body),
    ])
    .current_dir(&cwd);
    let output = output_with_timeout(cmd, GLAB_TIMEOUT)
        .map_err(|e| format!("glab api update note: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "gl update note failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn gl_mr_update_note(
    cwd: String,
    iid: i64,
    note_id: i64,
    body: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || gl_mr_update_note_inner(cwd, iid, note_id, body))
        .await
        .map_err(|e| e.to_string())?
}

/// Delete a note on a MR via `glab api`.
fn gl_mr_delete_note_inner(cwd: String, iid: i64, note_id: i64) -> Result<(), String> {
    let endpoint = format!(
        "projects/:fullpath/merge_requests/{}/notes/{}",
        iid, note_id
    );
    let mut cmd = hidden_cmd("glab");
    cmd.args(["api", "-X", "DELETE", &endpoint])
        .current_dir(&cwd);
    let output = output_with_timeout(cmd, GLAB_TIMEOUT)
        .map_err(|e| format!("glab api delete note: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "gl delete note failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn gl_mr_delete_note(cwd: String, iid: i64, note_id: i64) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || gl_mr_delete_note_inner(cwd, iid, note_id))
        .await
        .map_err(|e| e.to_string())?
}

/// Approve a MR using `glab mr approve`.
#[tauri::command]
fn gl_approve_mr_inner(cwd: String, iid: i64) -> Result<(), String> {
    let mut cmd = hidden_cmd("glab");
    cmd.args(["mr", "approve", &iid.to_string()])
        .current_dir(&cwd);
    let output =
        output_with_timeout(cmd, GLAB_TIMEOUT).map_err(|e| format!("glab mr approve: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "glab mr approve failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn gl_approve_mr(cwd: String, iid: i64) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || gl_approve_mr_inner(cwd, iid))
        .await
        .map_err(|e| e.to_string())?
}

/// Get approval status for a MR via `glab api`.
///
/// Returns raw JSON — parsed TypeScript-side into PrReview[].
fn gl_list_reviews_inner(cwd: String, iid: i64) -> Result<serde_json::Value, String> {
    let endpoint = format!("projects/:fullpath/merge_requests/{}/approvals", iid);
    let mut cmd = hidden_cmd("glab");
    cmd.args(["api", &endpoint]).current_dir(&cwd);
    let output =
        output_with_timeout(cmd, GLAB_TIMEOUT).map_err(|e| format!("glab api approvals: {}", e))?;

    if !output.status.success() {
        // Not all GitLab tiers have the approvals API — return empty gracefully.
        return Ok(serde_json::Value::Object(serde_json::Map::new()));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    serde_json::from_str(stdout.trim()).map_err(|e| format!("Parse approvals: {}", e))
}

#[tauri::command]
pub(crate) async fn gl_list_reviews(cwd: String, iid: i64) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || gl_list_reviews_inner(cwd, iid))
        .await
        .map_err(|e| e.to_string())?
}

/// Get the current GitLab user via `glab api /user`.
fn gl_current_user_inner(cwd: String) -> Result<String, String> {
    let mut cmd = hidden_cmd("glab");
    cmd.args(["api", "/user"]).current_dir(&cwd);
    let output =
        output_with_timeout(cmd, GLAB_TIMEOUT).map_err(|e| format!("glab api /user: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "gl current user failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let user: serde_json::Value =
        serde_json::from_str(stdout.trim()).map_err(|e| format!("Parse user: {}", e))?;

    Ok(user
        .get("username")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string())
}

#[tauri::command]
pub(crate) async fn gl_current_user(cwd: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || gl_current_user_inner(cwd))
        .await
        .map_err(|e| e.to_string())?
}

/// List reviewer candidates (project members with push access) via `glab api`.
fn gl_reviewer_candidates_inner(cwd: String) -> Result<Vec<ReviewerCandidate>, String> {
    let mut cmd = hidden_cmd("glab");
    cmd.args(["api", "projects/:fullpath/members/all?per_page=100"])
        .current_dir(&cwd);
    let output =
        output_with_timeout(cmd, GLAB_TIMEOUT).map_err(|e| format!("glab api members: {}", e))?;

    if !output.status.success() {
        return Ok(Vec::new()); // Non-fatal
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let members: serde_json::Value =
        serde_json::from_str(stdout.trim()).unwrap_or(serde_json::Value::Array(vec![]));

    let arr = match members.as_array() {
        Some(a) => a,
        None => return Ok(Vec::new()),
    };

    let mut candidates: Vec<ReviewerCandidate> = arr
        .iter()
        .filter_map(|m| {
            let login = m.get("username").and_then(|v| v.as_str())?;
            if login.is_empty() {
                return None;
            }
            Some(ReviewerCandidate {
                login: login.to_string(),
                name: m.get("name").and_then(|v| v.as_str()).map(String::from),
                avatar_url: m
                    .get("avatar_url")
                    .and_then(|v| v.as_str())
                    .map(String::from),
            })
        })
        .collect();

    candidates.sort_by_key(|a| a.login.to_lowercase());
    Ok(candidates)
}

#[tauri::command]
pub(crate) async fn gl_reviewer_candidates(cwd: String) -> Result<Vec<ReviewerCandidate>, String> {
    tauri::async_runtime::spawn_blocking(move || gl_reviewer_candidates_inner(cwd))
        .await
        .map_err(|e| e.to_string())?
}

/// Resolve a GitLab username to its numeric member id within the current
/// project — the merge-request update endpoint takes `reviewer_ids`
/// (numeric), not usernames.
fn gl_resolve_member_id(cwd: &str, username: &str) -> Option<i64> {
    let mut cmd = hidden_cmd("glab");
    cmd.args([
        "api",
        &format!("projects/:fullpath/members/all?query={}", username),
    ])
    .current_dir(cwd);
    let output = output_with_timeout(cmd, GLAB_API_TIMEOUT).ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let arr: serde_json::Value = serde_json::from_str(stdout.trim()).ok()?;
    arr.as_array()?
        .iter()
        .find(|m| m.get("username").and_then(|v| v.as_str()) == Some(username))
        .and_then(|m| m.get("id"))
        .and_then(|v| v.as_i64())
}

/// Request reviewers on an existing MR (B4, v3.6.0) — `PUT
/// /merge_requests/:iid` with `reviewer_ids[]=<id>` per resolved username.
#[tauri::command]
pub(crate) async fn gl_request_reviewers(
    cwd: String,
    iid: i64,
    usernames: Vec<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let ids: Vec<i64> = usernames
            .iter()
            .filter_map(|u| gl_resolve_member_id(&cwd, u))
            .collect();
        if ids.is_empty() {
            return Err(
                "Could not resolve any reviewer username to a GitLab project member.".to_string(),
            );
        }
        let endpoint = format!("projects/:fullpath/merge_requests/{}", iid);
        let mut cmd = hidden_cmd("glab");
        cmd.args(["api", "-X", "PUT", &endpoint]);
        for id in &ids {
            cmd.args(["-f", &format!("reviewer_ids[]={}", id)]);
        }
        cmd.current_dir(&cwd);
        let output = output_with_timeout(cmd, GLAB_TIMEOUT)
            .map_err(|e| format!("glab api request reviewers: {}", e))?;
        if !output.status.success() {
            return Err(format!(
                "glab api request reviewers failed: {}",
                String::from_utf8_lossy(&output.stderr)
            ));
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// List branch names for the project via `glab api`. Paginated at 100/page,
/// deduped, case-insensitively sorted. Non-fatal on failure (returns partial).
fn gl_branches_inner(cwd: String) -> Result<Vec<String>, String> {
    let mut names: Vec<String> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for page in 1..=10 {
        let endpoint = format!(
            "projects/:fullpath/repository/branches?per_page=100&page={}",
            page
        );
        let mut cmd = hidden_cmd("glab");
        cmd.args(["api", &endpoint]).current_dir(&cwd);
        let output = output_with_timeout(cmd, GLAB_TIMEOUT)
            .map_err(|e| format!("glab api branches: {}", e))?;
        if !output.status.success() {
            break;
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        let v: serde_json::Value =
            serde_json::from_str(stdout.trim()).unwrap_or(serde_json::Value::Array(vec![]));
        let arr = match v.as_array() {
            Some(a) if !a.is_empty() => a.clone(),
            _ => break,
        };
        let count = arr.len();
        for b in &arr {
            if let Some(name) = b.get("name").and_then(|v| v.as_str()) {
                if name.is_empty() || !seen.insert(name.to_string()) {
                    continue;
                }
                names.push(name.to_string());
            }
        }
        if count < 100 {
            break;
        }
    }
    names.sort_by_key(|a| a.to_lowercase());
    Ok(names)
}

#[tauri::command]
pub(crate) async fn gl_branches(cwd: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || gl_branches_inner(cwd))
        .await
        .map_err(|e| e.to_string())?
}

/// List file paths changed in a MR via `glab api` (diffs endpoint).
fn gl_mr_files_inner(cwd: String, iid: i64) -> Result<Vec<String>, String> {
    let endpoint = format!(
        "projects/:fullpath/merge_requests/{}/diffs?per_page=100",
        iid
    );
    let mut cmd = hidden_cmd("glab");
    cmd.args(["api", &endpoint]).current_dir(&cwd);
    let output =
        output_with_timeout(cmd, GLAB_TIMEOUT).map_err(|e| format!("glab api mr diffs: {}", e))?;

    if !output.status.success() {
        return Ok(Vec::new());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let diffs: serde_json::Value =
        serde_json::from_str(stdout.trim()).unwrap_or(serde_json::Value::Array(vec![]));

    let arr = match diffs.as_array() {
        Some(a) => a,
        None => return Ok(Vec::new()),
    };

    Ok(arr
        .iter()
        .filter_map(|d| d.get("new_path").and_then(|v| v.as_str()).map(String::from))
        .collect())
}

#[tauri::command]
pub(crate) async fn gl_mr_files(cwd: String, iid: i64) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || gl_mr_files_inner(cwd, iid))
        .await
        .map_err(|e| e.to_string())?
}

/// Create a diff-line anchored discussion on a MR via the GitLab Discussions API.
///
/// This provides parité with GitHub's inline review comment anchoring.
/// When `path`, `head_sha`, `base_sha`, and `start_sha` are all non-empty, a
/// position object is included so the discussion is anchored to the diff line.
/// When they are empty, falls back to a general MR note.
///
/// GitLab Discussions API:
///   POST /projects/:fullpath/merge_requests/:iid/discussions
///   Body: { body, position: { base_sha, start_sha, head_sha, position_type,
///            new_path, new_line, old_path, old_line } }
// Mirrors the `#[tauri::command]` wrapper below 1:1 — its param list is the
// IPC contract with the frontend (see `backend.ts`). Regrouping fields into
// a params struct would be a real API-shape change, not a mechanical clippy
// fix; deferred out of this chore(ci) PR. See PR1 clippy cleanup notes.
#[allow(clippy::too_many_arguments)]
fn gl_mr_create_discussion_inner(
    cwd: String,
    iid: i64,
    body: String,
    base_sha: String,
    start_sha: String,
    head_sha: String,
    old_line: Option<i64>,
    new_line: Option<i64>,
    path: String,
) -> Result<serde_json::Value, String> {
    let endpoint = format!("projects/:fullpath/merge_requests/{}/discussions", iid);

    // Build args for `glab api -X POST`.
    let mut args: Vec<String> = vec![
        "api".to_string(),
        "-X".to_string(),
        "POST".to_string(),
        endpoint.clone(),
        "-f".to_string(),
        format!("body={}", body),
    ];

    // Attach diff-line position when we have enough context.
    let has_position = !base_sha.is_empty() && !head_sha.is_empty() && !path.is_empty();
    if has_position {
        args.extend([
            "-f".to_string(),
            format!("position[base_sha]={}", base_sha),
            "-f".to_string(),
            format!("position[start_sha]={}", start_sha),
            "-f".to_string(),
            format!("position[head_sha]={}", head_sha),
            "-f".to_string(),
            "position[position_type]=text".to_string(),
            "-f".to_string(),
            format!("position[new_path]={}", path),
            "-f".to_string(),
            format!("position[old_path]={}", path),
        ]);
        if let Some(nl) = new_line {
            args.extend(["-f".to_string(), format!("position[new_line]={}", nl)]);
        }
        if let Some(ol) = old_line {
            args.extend(["-f".to_string(), format!("position[old_line]={}", ol)]);
        }
    }

    let mut cmd = hidden_cmd("glab");
    cmd.args(&args).current_dir(&cwd);
    let output = output_with_timeout(cmd, GLAB_TIMEOUT)
        .map_err(|e| format!("glab api create discussion: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "gl create discussion failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    serde_json::from_str(stdout.trim()).map_err(|e| format!("Parse discussion: {}", e))
}

// This signature is the Tauri IPC contract (see `backend.ts`); regrouping
// its fields into a params struct is a frontend+backend API-shape change,
// not a mechanical clippy fix. Deferred out of this chore(ci) PR — see PR1
// clippy cleanup notes.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub(crate) async fn gl_mr_create_discussion(
    cwd: String,
    iid: i64,
    body: String,
    base_sha: String,
    start_sha: String,
    head_sha: String,
    old_line: Option<i64>,
    new_line: Option<i64>,
    path: String,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        gl_mr_create_discussion_inner(
            cwd, iid, body, base_sha, start_sha, head_sha, old_line, new_line, path,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

// ─── Award emoji (reactions) ─────────────────────────────────────────────────

/// Map a GitLab emoji name to the equivalent GitHub reaction content string.
fn gl_emoji_to_gh(name: &str) -> &str {
    match name {
        "thumbsup" => "+1",
        "thumbsdown" => "-1",
        "laughing" => "laugh",
        "tada" => "hooray",
        // confused, heart, rocket, eyes share the same name on both platforms
        other => other,
    }
}

/// Map a GitHub reaction content string to the GitLab emoji name.
fn gh_content_to_gl(content: &str) -> &str {
    match content {
        "+1" => "thumbsup",
        "-1" => "thumbsdown",
        "laugh" => "laughing",
        "hooray" => "tada",
        other => other,
    }
}

fn map_gl_reaction(r: &serde_json::Value) -> serde_json::Value {
    serde_json::json!({
        "id": ji(r, "id"),
        "content": gl_emoji_to_gh(&js(r, "name")),
        "user": juser(r, "user"),
    })
}

/// Run any `glab api` call with optional `-f key=value` fields.
fn glab_api(
    cwd: &str,
    method: &str,
    endpoint: &str,
    fields: &[(&str, &str)],
) -> Result<serde_json::Value, String> {
    let mut cmd = hidden_cmd("glab");
    cmd.args(["api", "-X", method, endpoint]);
    for (k, v) in fields {
        cmd.args(["-f", &format!("{}={}", k, v)]);
    }
    cmd.current_dir(cwd);
    let output = output_with_timeout(cmd, GLAB_TIMEOUT).map_err(|e| format!("glab api: {}", e))?;
    if !output.status.success() {
        return Err(format!(
            "glab api {} {}: {}",
            method,
            endpoint,
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        return Ok(serde_json::Value::Null);
    }
    serde_json::from_str(trimmed).map_err(|e| format!("parse glab response: {}", e))
}

fn award_emoji_path(iid: i64, target_type: &str, target_id: i64) -> String {
    match target_type {
        "pr" => format!("projects/:fullpath/merge_requests/{}/award_emoji", iid),
        _ => format!(
            "projects/:fullpath/merge_requests/{}/notes/{}/award_emoji",
            iid, target_id
        ),
    }
}

/// List award emojis (reactions) on a MR or one of its notes.
/// `target_type`: `"pr"` | `"review_comment"` | `"issue_comment"`.
/// `target_id`: ignored for `"pr"`, note id otherwise.
/// Emoji names are normalised to GitHub reaction content strings.
#[tauri::command]
pub(crate) async fn gl_list_reactions(
    cwd: String,
    iid: i64,
    target_type: String,
    target_id: i64,
) -> Result<Vec<serde_json::Value>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = award_emoji_path(iid, &target_type, target_id);
        let v = glab_api(&cwd, "GET", &path, &[])?;
        Ok(v.as_array()
            .map(|a| a.iter().map(map_gl_reaction).collect())
            .unwrap_or_default())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Add an award emoji (reaction) to a MR or note.
/// `content` uses GitHub reaction content strings (normalised to GitLab names internally).
#[tauri::command]
pub(crate) async fn gl_add_reaction(
    cwd: String,
    iid: i64,
    target_type: String,
    target_id: i64,
    content: String,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let gl_name = gh_content_to_gl(&content).to_string();
        let path = award_emoji_path(iid, &target_type, target_id);
        let v = glab_api(&cwd, "POST", &path, &[("name", &gl_name)])?;
        Ok(map_gl_reaction(&v))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Delete an award emoji (reaction) from a MR or note.
#[tauri::command]
pub(crate) async fn gl_delete_reaction(
    cwd: String,
    iid: i64,
    target_type: String,
    target_id: i64,
    reaction_id: i64,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let base = award_emoji_path(iid, &target_type, target_id);
        let path = format!("{}/{}", base, reaction_id);
        glab_api(&cwd, "DELETE", &path, &[])?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod gl_list_issues_tests {
    use super::gl_issue_to_issue;

    #[test]
    fn maps_gitlab_issue_json_to_issue() {
        let v: serde_json::Value = serde_json::from_str(
            r#"{
            "iid": 12, "title": "Crash", "state": "opened",
            "author": {"username": "alice"},
            "assignees": [{"username": "bob"}],
            "labels": ["bug","p1"],
            "web_url": "https://gitlab.com/o/r/-/issues/12",
            "created_at": "2026-01-01T00:00:00Z",
            "updated_at": "2026-01-02T00:00:00Z",
            "milestone": {"title": "M1"}
        }"#,
        )
        .unwrap();
        let i = gl_issue_to_issue(&v);
        assert_eq!(i.number, 12);
        assert_eq!(i.state, "open");
        assert_eq!(i.author, "alice");
        assert_eq!(i.assignees, vec!["bob".to_string()]);
        assert_eq!(i.labels, vec!["bug".to_string(), "p1".to_string()]);
        assert_eq!(i.milestone, "M1");
        assert_eq!(i.url, "https://gitlab.com/o/r/-/issues/12");
    }
}

/// Issue #138 — `glab mr list` has no generic `--state <value>` flag like
/// `gh`; it takes one boolean flag per state. Regression coverage for
/// `gl_state_flag`, consumed by both `gl_list_mrs` and `gl_mr_count`'s
/// `hidden_cmd("glab").args([...])` argument construction.
#[cfg(test)]
mod gl_state_flag_tests {
    use super::gl_state_flag;

    #[test]
    fn maps_closed_to_the_closed_flag() {
        assert_eq!(gl_state_flag("closed"), "--closed");
    }

    #[test]
    fn maps_merged_to_the_merged_flag() {
        assert_eq!(gl_state_flag("merged"), "--merged");
    }

    #[test]
    fn maps_all_to_the_all_flag() {
        assert_eq!(gl_state_flag("all"), "--all");
    }

    #[test]
    fn maps_opened_and_any_other_value_to_the_opened_flag() {
        assert_eq!(gl_state_flag("opened"), "--opened");
        assert_eq!(gl_state_flag("open"), "--opened");
        assert_eq!(gl_state_flag(""), "--opened");
    }
}

/// Issue #161 — `merge_status` is deprecated since GitLab 15.6 and commonly
/// sits at "unchecked"/"checking" until something triggers a recompute, so
/// the old `can_be_merged` else `CONFLICTING` mapping treated every
/// not-yet-computed MR as a false-positive conflict. Regression coverage for
/// `gl_mergeable_state`, consumed by `gl_mr_to_detail`.
#[cfg(test)]
mod gl_mergeable_state_tests {
    use super::gl_mergeable_state;
    use serde_json::json;

    #[test]
    fn detailed_mergeable_maps_to_mergeable() {
        let mr = json!({"detailed_merge_status": "mergeable", "merge_status": "can_be_merged"});
        assert_eq!(gl_mergeable_state(&mr), "MERGEABLE");
    }

    #[test]
    fn detailed_conflict_maps_to_conflicting() {
        let mr = json!({"detailed_merge_status": "conflict", "merge_status": "cannot_be_merged"});
        assert_eq!(gl_mergeable_state(&mr), "CONFLICTING");
    }

    #[test]
    fn detailed_ci_still_running_is_unknown_not_conflicting() {
        let mr = json!({"detailed_merge_status": "ci_still_running", "merge_status": "unchecked"});
        assert_eq!(gl_mergeable_state(&mr), "UNKNOWN");
    }

    #[test]
    fn detailed_unchecked_is_unknown() {
        let mr = json!({"detailed_merge_status": "unchecked"});
        assert_eq!(gl_mergeable_state(&mr), "UNKNOWN");
    }

    #[test]
    fn falls_back_to_legacy_merge_status_when_detailed_is_absent() {
        assert_eq!(
            gl_mergeable_state(&json!({"merge_status": "can_be_merged"})),
            "MERGEABLE"
        );
        assert_eq!(
            gl_mergeable_state(&json!({"merge_status": "cannot_be_merged"})),
            "CONFLICTING"
        );
        assert_eq!(
            gl_mergeable_state(&json!({"merge_status": "cannot_be_merged_recheck"})),
            "CONFLICTING"
        );
        assert_eq!(
            gl_mergeable_state(&json!({"merge_status": "unchecked"})),
            "UNKNOWN"
        );
    }

    #[test]
    fn neither_field_present_is_unknown() {
        assert_eq!(gl_mergeable_state(&json!({})), "UNKNOWN");
    }
}

/// Issue #161 — GitLab's MR resource has no `diff_stats` field (that was a
/// GitHub-shaped assumption; GitLab's REST API never returns per-line
/// addition/deletion counts on the MR itself), so `gl_mr_to_detail` reading
/// `mr.diff_stats` always fell through to `(0, 0)`. Regression coverage for
/// `gl_diff_stats_from_files`, which sums real `+`/`-` line counts out of
/// the diffs endpoint's per-file unified-diff text instead.
#[cfg(test)]
mod gl_diff_stats_from_files_tests {
    use super::gl_diff_stats_from_files;
    use serde_json::json;

    #[test]
    fn sums_additions_and_deletions_across_files() {
        let files = vec![
            json!({"new_path": "a.rs", "diff": "@@ -1,2 +1,3 @@\n-old\n+new1\n+new2\n context\n"}),
            json!({"new_path": "b.rs", "diff": "@@ -1,1 +1,1 @@\n-gone\n+kept\n"}),
        ];
        assert_eq!(gl_diff_stats_from_files(&files), (3, 2));
    }

    #[test]
    fn ignores_the_file_header_lines_not_just_hunk_lines() {
        // `---`/`+++` file headers must not be miscounted as a deletion/addition.
        let files = vec![json!({
            "new_path": "a.rs",
            "diff": "--- a/a.rs\n+++ b/a.rs\n@@ -1,1 +1,1 @@\n-old\n+new\n"
        })];
        assert_eq!(gl_diff_stats_from_files(&files), (1, 1));
    }

    #[test]
    fn empty_file_list_is_zero_zero() {
        assert_eq!(gl_diff_stats_from_files(&[]), (0, 0));
    }

    #[test]
    fn a_file_with_no_diff_field_contributes_nothing() {
        let files = vec![json!({"new_path": "binary.png"})];
        assert_eq!(gl_diff_stats_from_files(&files), (0, 0));
    }
}

/// Issue #161 — `gl_list_mrs_inner`'s naive offset+limit pagination requests
/// a growing `--per-page` value (`limit + offset`) on every page, but never
/// clamped it to GitLab's 100-per-page ceiling the way `gl_list_issues_inner`
/// already does. The background prefetch that drains the rest of the open-MR
/// list right after the first page paints (`prefetchOpenPrs`, `BG_PAGE =
/// 100` in `usePrPanel.ts`) requests its very first batch at `offset: 10,
/// limit: 100` — `--per-page 110` — which GitLab's API rejects outright. The
/// failure is silently swallowed by `loadMorePrs`'s catch block, which sets
/// `hasMore` to `false`, permanently hiding the *visible* scroll-to-load-more
/// sentinel too even though the user never asked for the background batch
/// that actually failed. Regression coverage for `gl_mr_list_per_page`.
#[cfg(test)]
mod gl_mr_list_per_page_tests {
    use super::gl_mr_list_per_page;

    #[test]
    fn stays_under_the_cap_for_small_pages() {
        assert_eq!(gl_mr_list_per_page(Some(10), Some(0)), 10);
        assert_eq!(gl_mr_list_per_page(Some(10), Some(10)), 20);
    }

    #[test]
    fn clamps_to_100_instead_of_erroring_on_the_background_prefetch_batch() {
        // usePrPanel.ts's prefetchOpenPrs: limit=100 (BG_PAGE), offset=10
        // after the first visible page — would ask for --per-page 110.
        assert_eq!(gl_mr_list_per_page(Some(100), Some(10)), 100);
    }

    #[test]
    fn clamps_even_when_both_limit_and_offset_are_already_over_100() {
        assert_eq!(gl_mr_list_per_page(Some(100), Some(200)), 100);
    }

    #[test]
    fn defaults_and_floors_match_the_pre_existing_behavior() {
        assert_eq!(gl_mr_list_per_page(None, None), 10);
        assert_eq!(gl_mr_list_per_page(Some(0), Some(-5)), 1);
    }
}

/// Issue #161 — comments were listed via the flat `/notes` endpoint, which
/// has no concept of a resolved discussion thread at all: a resolved and a
/// live comment were indistinguishable to the frontend. Regression coverage
/// for `gl_flatten_discussions`, which switches to the `/discussions`
/// endpoint and flattens it back to the same flat-array shape `/notes` used
/// to return, while preserving each note's `resolvable`/`resolved` fields.
#[cfg(test)]
mod gl_flatten_discussions_tests {
    use super::gl_flatten_discussions;
    use serde_json::json;

    #[test]
    fn flattens_notes_out_of_every_discussion_preserving_resolved_state() {
        let discussions = vec![
            json!({
                "id": "d1", "individual_note": false,
                "notes": [
                    {"id": 1, "body": "first", "resolvable": true, "resolved": true},
                    {"id": 2, "body": "reply", "resolvable": true, "resolved": true},
                ]
            }),
            json!({
                "id": "d2", "individual_note": true,
                "notes": [{"id": 3, "body": "standalone", "resolvable": false}]
            }),
        ];
        let flat = gl_flatten_discussions(&discussions);
        assert_eq!(flat.len(), 3);
        assert_eq!(flat[0]["id"], 1);
        assert_eq!(flat[0]["resolved"], true);
        assert_eq!(flat[2]["id"], 3);
        assert_eq!(flat[2]["resolvable"], false);
    }

    #[test]
    fn a_discussion_with_no_notes_array_contributes_nothing() {
        let discussions = vec![json!({"id": "d1", "individual_note": true})];
        assert_eq!(gl_flatten_discussions(&discussions).len(), 0);
    }

    #[test]
    fn empty_discussion_list_is_empty() {
        assert_eq!(gl_flatten_discussions(&[]).len(), 0);
    }
}

/// Issue #161 — the dock/badge MR count used to fetch up to 100 MRs and
/// count the array, silently capping any repo with more open MRs than that
/// at exactly 100. Regression coverage for `gl_parse_x_total`, which reads
/// the real total off the REST list endpoint's `X-Total` header instead.
#[cfg(test)]
mod gl_parse_x_total_tests {
    use super::gl_parse_x_total;

    #[test]
    fn finds_x_total_after_a_status_line_with_no_colon() {
        let output = "HTTP/2 200 \r\nContent-Type: application/json\r\nX-Total: 125\r\nX-Per-Page: 1\r\n\r\n[{}]";
        assert_eq!(gl_parse_x_total(output), Some(125));
    }

    #[test]
    fn header_name_match_is_case_insensitive() {
        let output = "HTTP/2 200\nx-total: 7\n\n[]";
        assert_eq!(gl_parse_x_total(output), Some(7));
    }

    #[test]
    fn returns_none_when_the_header_is_absent() {
        let output = "HTTP/2 200\nContent-Type: application/json\n\n[{}]";
        assert_eq!(gl_parse_x_total(output), None);
    }

    #[test]
    fn does_not_scan_into_the_body_past_the_blank_line() {
        // A body containing a line that happens to look like "X-Total: 9"
        // must not be matched once the header block has ended.
        let output = "HTTP/2 200\n\n{\"note\": \"X-Total: 9\"}";
        assert_eq!(gl_parse_x_total(output), None);
    }

    #[test]
    fn returns_none_on_empty_output() {
        assert_eq!(gl_parse_x_total(""), None);
    }
}

/// Issue #161 — `glab mr diff`'s default (non-`--raw`) output isn't the
/// git-compatible unified-diff format (`diff --git a/... b/...` headers) the
/// frontend's `indexDiffFiles`/`parseFileDiff` parsers require; without
/// `--raw` they silently see zero files and the UI renders "no diff
/// available" no matter what the MR actually contains.
#[cfg(test)]
mod gl_mr_diff_args_tests {
    use super::gl_mr_diff_args;

    #[test]
    fn includes_the_raw_flag() {
        assert_eq!(gl_mr_diff_args(42), vec!["mr", "diff", "42", "--raw"]);
    }
}

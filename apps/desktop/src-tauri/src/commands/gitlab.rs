//! GitLab CLI (`glab`) Tauri commands — §2.x Forge integrations.
//!
//! Wraps the official `glab` CLI (gitlab.com/gitlab-org/cli) for MR workflows:
//! list, create, checkout, merge, diff, pipelines, notes, approvals.
//!
//! **Auth**: managed by `glab auth login` — the PAT is stored in glab's own
//! config (`~/.config/glab-cli/config.yml`). GitWand never touches the token
//! directly; `glab` handles all credential lookup.
//!
//! **Project resolution**: `glab api` substitutes `:fullpath` with the
//! URL-encoded `namespace%2Frepo` of the repo in `cwd`, so we never need to
//! hard-code project IDs in endpoint strings.
//!
//! **Pattern**: mirrors `commands/gh.rs` exactly — every command is a thin
//! synchronous `hidden_cmd("glab")` wrapper with JSON parsing. No new HTTP
//! or async dependencies required.

use crate::git::hidden_cmd;
use crate::types::*;
use rayon::prelude::*;
use std::collections::HashMap;

// ─── JSON field helpers ────────────────────────────────────────────────────────

/// Extract a string field from a serde_json::Value object.
fn js(v: &serde_json::Value, key: &str) -> String {
    v.get(key).and_then(|x| x.as_str()).unwrap_or("").to_string()
}

/// Extract an i64 field. Also handles string-encoded numbers (GitLab quirk).
fn ji(v: &serde_json::Value, key: &str) -> i64 {
    v.get(key)
        .and_then(|x| x.as_i64())
        .or_else(|| v.get(key).and_then(|x| x.as_str()).and_then(|s| s.parse().ok()))
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
    let is_draft = jb(mr, "draft")
        || title.starts_with("Draft:")
        || title.starts_with("WIP:");

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

/// Map a GitLab MR JSON object to a PullRequestDetail (richer fields).
fn gl_mr_to_detail(mr: &serde_json::Value) -> PullRequestDetail {
    let state = js(mr, "state");
    let title = js(mr, "title");
    let is_draft = jb(mr, "draft")
        || title.starts_with("Draft:")
        || title.starts_with("WIP:");

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

    let mergeable = if js(mr, "merge_status") == "can_be_merged" {
        "MERGEABLE"
    } else {
        "CONFLICTING"
    }
    .to_string();

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
    }
}

// ─── Tauri commands ────────────────────────────────────────────────────────────

/// Detect if `glab` CLI is installed and accessible.
#[tauri::command]
pub(crate) async fn detect_glab(cwd: String) -> bool {
    hidden_cmd("glab")
        .arg("--version")
        .current_dir(&cwd)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// List merge requests using `glab mr list`.
///
/// `state` accepts "opened" (default), "closed", "merged", "all".
/// Pagination: naïve slice — glab doesn't support cursor pagination via CLI.
#[tauri::command]
pub(crate) async fn gl_list_mrs(
    cwd: String,
    state: String,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<Vec<PullRequest>, String> {
    let st = match state.as_str() {
        "closed" => "closed",
        "merged" => "merged",
        "all" => "all",
        _ => "opened",
    };
    let page = limit.unwrap_or(10).max(1);
    let off = offset.unwrap_or(0).max(0);
    let total = (page + off).to_string();

    let output = hidden_cmd("glab")
        .args([
            "mr", "list",
            "--state", st,
            "--per-page", &total,
            "--output", "json",
        ])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to run glab mr list (is glab installed?): {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("glab mr list failed: {}", stderr));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let raw: serde_json::Value = serde_json::from_str(stdout.trim())
        .map_err(|e| format!("Failed to parse glab mr list output: {}", e))?;

    let arr = raw
        .as_array()
        .ok_or_else(|| format!("Expected JSON array from glab mr list, got: {}", &stdout[..stdout.len().min(200)]))?;

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
            let status = mr.get("head_pipeline").or_else(|| mr.get("pipeline")).map(|p| js(p, "status"))?;
            Some((iid, status))
        })
        .collect();
    let rollups: HashMap<i64, String> = mrs
        .par_iter()
        .filter_map(|mr| {
            let rollup = match embedded.get(&mr.number) {
                Some(s) => gl_status_to_rollup(s),
                None => gl_pipeline_rollup(&cwd, mr.number),
            };
            if rollup.is_empty() { None } else { Some((mr.number, rollup)) }
        })
        .collect();
    for mr in &mut mrs {
        if let Some(state) = rollups.get(&mr.number) {
            mr.checks_rollup = state.clone();
        }
    }

    Ok(mrs)
}

/// Count MRs. Fetches up to 100 via list endpoint (GitLab REST has no free totalCount).
///
/// Returns 0 on non-fatal errors so the Launchpad badge can still render.
#[tauri::command]
pub(crate) async fn gl_mr_count(cwd: String, state: String) -> Result<i64, String> {
    let st = match state.as_str() {
        "closed" => "closed",
        "merged" => "merged",
        "all" => "all",
        _ => "opened",
    };
    let output = hidden_cmd("glab")
        .args(["mr", "list", "--state", st, "--per-page", "100", "--output", "json"])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("glab mr count: {}", e))?;

    if !output.status.success() {
        return Ok(0);
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let arr: serde_json::Value =
        serde_json::from_str(stdout.trim()).unwrap_or(serde_json::Value::Array(vec![]));
    Ok(arr.as_array().map(|a| a.len() as i64).unwrap_or(0))
}

/// Get detailed MR info using `glab mr view`.
#[tauri::command]
pub(crate) async fn gl_get_mr(cwd: String, iid: i64) -> Result<PullRequestDetail, String> {
    let output = hidden_cmd("glab")
        .args(["mr", "view", &iid.to_string(), "--output", "json"])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("glab mr view: {}", e))?;

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
    Ok(detail)
}

/// Get the unified diff of a MR using `glab mr diff`.
#[tauri::command]
pub(crate) async fn gl_mr_diff(cwd: String, iid: i64) -> Result<String, String> {
    let output = hidden_cmd("glab")
        .args(["mr", "diff", &iid.to_string()])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("glab mr diff: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "glab mr diff failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Get CI pipeline status for a MR using `glab api`.
///
/// Returns the most-recent pipeline as a single-entry list (GitLab only has
/// one "active" pipeline per MR at a time). Each job maps to a CICheck entry.
#[tauri::command]
pub(crate) async fn gl_mr_pipelines(cwd: String, iid: i64) -> Result<Vec<CICheck>, String> {
    let endpoint = format!(
        "projects/:fullpath/merge_requests/{}/pipelines",
        iid
    );
    let output = hidden_cmd("glab")
        .args(["api", &endpoint])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("glab api pipelines: {}", e))?;

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
    let out = match hidden_cmd("glab").args(["api", &endpoint]).current_dir(cwd).output() {
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
    let output = hidden_cmd("glab")
        .args(["api", endpoint])
        .current_dir(cwd)
        .output()
        .ok()?;
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
#[tauri::command]
pub(crate) fn gl_mr_annotations(cwd: String, iid: i64) -> Result<Vec<CIAnnotation>, String> {
    // 1. Latest pipeline.
    let pipelines = match glab_api_json(
        &cwd,
        &format!("projects/:fullpath/merge_requests/{}/pipelines", iid),
    ) {
        Some(v) => v,
        None => return Ok(Vec::new()),
    };
    let pipeline_id = match pipelines.as_array().and_then(|a| a.first()).map(|p| ji(p, "id")) {
        Some(id) if id > 0 => id,
        _ => return Ok(Vec::new()),
    };

    // 2. Jobs of that pipeline, keep those with a codequality report artifact.
    let jobs = match glab_api_json(
        &cwd,
        &format!("projects/:fullpath/pipelines/{}/jobs?per_page=100", pipeline_id),
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
        let Some(entries) = report.as_array() else { continue };

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
        .map(|arr| arr.iter().filter_map(|x| x.as_str().map(String::from)).collect())
        .unwrap_or_default();
    let milestone = v.get("milestone").map(|m| js(m, "title")).unwrap_or_default();
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
#[tauri::command]
pub(crate) async fn gl_list_issues(
    cwd: String,
    filter: String,
    limit: Option<i64>,
) -> Result<Vec<crate::types::Issue>, String> {
    // GitLab caps --per-page at 100; clamp so an over-large limit doesn't error.
    let lim = limit.unwrap_or(100).clamp(1, 100).to_string();
    let mut args: Vec<String> = vec![
        "issue".into(), "list".into(),
        "--state".into(), "opened".into(),
        "--per-page".into(), lim,
        "--output".into(), "json".into(),
    ];
    // glab filter flags: --assignee / --author accept usernames or "@me".
    match filter.as_str() {
        "assigned" => { args.push("--assignee".into()); args.push("@me".into()); }
        "created"  => { args.push("--author".into());   args.push("@me".into()); }
        // "mentioned" has no native glab flag → fall back to all-open.
        _ => {}
    }
    let output = hidden_cmd("glab")
        .args(&args)
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("glab not available: {}", e))?;
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

/// Create a MR using `glab mr create`.
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
        "--yes".to_string(),     // Skip interactive prompts
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

    let output = hidden_cmd("glab")
        .args(&args)
        .current_dir(&cwd)
        .output()
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

/// Merge a MR using `glab mr merge`.
///
/// `method` accepts "merge" (default), "squash", "rebase".
#[tauri::command]
pub(crate) async fn gl_merge_mr(cwd: String, iid: i64, method: String) -> Result<(), String> {
    let mut args: Vec<String> = vec!["mr".to_string(), "merge".to_string(), iid.to_string()];

    match method.as_str() {
        "squash" => args.push("--squash".to_string()),
        "rebase" => args.push("--rebase".to_string()),
        _ => {} // default merge
    }

    args.push("--yes".to_string());
    args.push("--delete-source-branch".to_string());

    let output = hidden_cmd("glab")
        .args(&args)
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("glab mr merge: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "glab mr merge failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(())
}

/// Checkout a MR branch locally using `glab mr checkout`.
#[tauri::command]
pub(crate) async fn gl_checkout_mr(cwd: String, iid: i64) -> Result<(), String> {
    let output = hidden_cmd("glab")
        .args(["mr", "checkout", &iid.to_string()])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("glab mr checkout: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "glab mr checkout failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(())
}

/// Convert a draft MR to ready-for-review using `glab mr update --draft=false`.
#[tauri::command]
pub(crate) async fn gl_convert_draft_to_ready(cwd: String, iid: i64) -> Result<(), String> {
    let output = hidden_cmd("glab")
        .args(["mr", "update", &iid.to_string(), "--draft=false"])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("glab mr update (draft→ready): {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "glab mr ready failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(())
}

/// List notes (comments) for a MR via `glab api`.
///
/// Returns raw JSON array — parsed TypeScript-side into PrReviewComment[].
/// GitLab notes are simpler than GitHub review comments: no diff-line
/// anchoring in v2.10 (that requires the Discussions API).
#[tauri::command]
pub(crate) async fn gl_mr_notes(cwd: String, iid: i64) -> Result<serde_json::Value, String> {
    let endpoint = format!(
        "projects/:fullpath/merge_requests/{}/notes?sort=asc&per_page=100",
        iid
    );
    let output = hidden_cmd("glab")
        .args(["api", &endpoint])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("glab api notes: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "gl mr notes failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    serde_json::from_str(stdout.trim()).map_err(|e| format!("Parse notes: {}", e))
}

/// Create a note (comment) on a MR via `glab api`.
///
/// Returns the created note as raw JSON — parsed TypeScript-side.
#[tauri::command]
pub(crate) async fn gl_mr_create_note(
    cwd: String,
    iid: i64,
    body: String,
) -> Result<serde_json::Value, String> {
    let endpoint = format!("projects/:fullpath/merge_requests/{}/notes", iid);
    let output = hidden_cmd("glab")
        .args(["api", "-X", "POST", &endpoint, "-f", &format!("body={}", body)])
        .current_dir(&cwd)
        .output()
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

/// Update a note on a MR via `glab api`.
#[tauri::command]
pub(crate) async fn gl_mr_update_note(
    cwd: String,
    iid: i64,
    note_id: i64,
    body: String,
) -> Result<(), String> {
    let endpoint = format!(
        "projects/:fullpath/merge_requests/{}/notes/{}",
        iid, note_id
    );
    let output = hidden_cmd("glab")
        .args(["api", "-X", "PUT", &endpoint, "-f", &format!("body={}", body)])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("glab api update note: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "gl update note failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(())
}

/// Delete a note on a MR via `glab api`.
#[tauri::command]
pub(crate) async fn gl_mr_delete_note(
    cwd: String,
    iid: i64,
    note_id: i64,
) -> Result<(), String> {
    let endpoint = format!(
        "projects/:fullpath/merge_requests/{}/notes/{}",
        iid, note_id
    );
    let output = hidden_cmd("glab")
        .args(["api", "-X", "DELETE", &endpoint])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("glab api delete note: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "gl delete note failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(())
}

/// Approve a MR using `glab mr approve`.
#[tauri::command]
pub(crate) async fn gl_approve_mr(cwd: String, iid: i64) -> Result<(), String> {
    let output = hidden_cmd("glab")
        .args(["mr", "approve", &iid.to_string()])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("glab mr approve: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "glab mr approve failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(())
}

/// Get approval status for a MR via `glab api`.
///
/// Returns raw JSON — parsed TypeScript-side into PrReview[].
#[tauri::command]
pub(crate) async fn gl_list_reviews(cwd: String, iid: i64) -> Result<serde_json::Value, String> {
    let endpoint = format!(
        "projects/:fullpath/merge_requests/{}/approvals",
        iid
    );
    let output = hidden_cmd("glab")
        .args(["api", &endpoint])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("glab api approvals: {}", e))?;

    if !output.status.success() {
        // Not all GitLab tiers have the approvals API — return empty gracefully.
        return Ok(serde_json::Value::Object(serde_json::Map::new()));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    serde_json::from_str(stdout.trim()).map_err(|e| format!("Parse approvals: {}", e))
}

/// Get the current GitLab user via `glab api /user`.
#[tauri::command]
pub(crate) async fn gl_current_user(cwd: String) -> Result<String, String> {
    let output = hidden_cmd("glab")
        .args(["api", "/user"])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("glab api /user: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "gl current user failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let user: serde_json::Value = serde_json::from_str(stdout.trim())
        .map_err(|e| format!("Parse user: {}", e))?;

    Ok(user
        .get("username")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string())
}

/// List reviewer candidates (project members with push access) via `glab api`.
#[tauri::command]
pub(crate) async fn gl_reviewer_candidates(cwd: String) -> Result<Vec<ReviewerCandidate>, String> {
    let output = hidden_cmd("glab")
        .args(["api", "projects/:fullpath/members/all?per_page=100"])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("glab api members: {}", e))?;

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
                name: m
                    .get("name")
                    .and_then(|v| v.as_str())
                    .map(String::from),
                avatar_url: m
                    .get("avatar_url")
                    .and_then(|v| v.as_str())
                    .map(String::from),
            })
        })
        .collect();

    candidates.sort_by(|a, b| a.login.to_lowercase().cmp(&b.login.to_lowercase()));
    Ok(candidates)
}

/// List file paths changed in a MR via `glab api` (diffs endpoint).
#[tauri::command]
pub(crate) async fn gl_mr_files(cwd: String, iid: i64) -> Result<Vec<String>, String> {
    let endpoint = format!(
        "projects/:fullpath/merge_requests/{}/diffs?per_page=100",
        iid
    );
    let output = hidden_cmd("glab")
        .args(["api", &endpoint])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("glab api mr diffs: {}", e))?;

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
    let endpoint = format!("projects/:fullpath/merge_requests/{}/discussions", iid);

    // Build args for `glab api -X POST`.
    let mut args: Vec<String> = vec![
        "api".to_string(),
        "-X".to_string(), "POST".to_string(),
        endpoint.clone(),
        "-f".to_string(), format!("body={}", body),
    ];

    // Attach diff-line position when we have enough context.
    let has_position = !base_sha.is_empty() && !head_sha.is_empty() && !path.is_empty();
    if has_position {
        args.extend([
            "-f".to_string(), format!("position[base_sha]={}", base_sha),
            "-f".to_string(), format!("position[start_sha]={}", start_sha),
            "-f".to_string(), format!("position[head_sha]={}", head_sha),
            "-f".to_string(), "position[position_type]=text".to_string(),
            "-f".to_string(), format!("position[new_path]={}", path),
            "-f".to_string(), format!("position[old_path]={}", path),
        ]);
        if let Some(nl) = new_line {
            args.extend(["-f".to_string(), format!("position[new_line]={}", nl)]);
        }
        if let Some(ol) = old_line {
            args.extend(["-f".to_string(), format!("position[old_line]={}", ol)]);
        }
    }

    let output = hidden_cmd("glab")
        .args(&args)
        .current_dir(&cwd)
        .output()
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

// ─── Award emoji (reactions) ─────────────────────────────────────────────────

/// Map a GitLab emoji name to the equivalent GitHub reaction content string.
fn gl_emoji_to_gh(name: &str) -> &str {
    match name {
        "thumbsup"   => "+1",
        "thumbsdown" => "-1",
        "laughing"   => "laugh",
        "tada"       => "hooray",
        // confused, heart, rocket, eyes share the same name on both platforms
        other        => other,
    }
}

/// Map a GitHub reaction content string to the GitLab emoji name.
fn gh_content_to_gl(content: &str) -> &str {
    match content {
        "+1"    => "thumbsup",
        "-1"    => "thumbsdown",
        "laugh" => "laughing",
        "hooray"=> "tada",
        other   => other,
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
fn glab_api(cwd: &str, method: &str, endpoint: &str, fields: &[(&str, &str)]) -> Result<serde_json::Value, String> {
    let mut cmd = hidden_cmd("glab");
    cmd.args(["api", "-X", method, endpoint]);
    for (k, v) in fields {
        cmd.args(["-f", &format!("{}={}", k, v)]);
    }
    let output = cmd.current_dir(cwd).output().map_err(|e| format!("glab api: {}", e))?;
    if !output.status.success() {
        return Err(format!("glab api {} {}: {}", method, endpoint, String::from_utf8_lossy(&output.stderr)));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let trimmed = stdout.trim();
    if trimmed.is_empty() { return Ok(serde_json::Value::Null); }
    serde_json::from_str(trimmed).map_err(|e| format!("parse glab response: {}", e))
}

fn award_emoji_path(iid: i64, target_type: &str, target_id: i64) -> String {
    match target_type {
        "pr" => format!("projects/:fullpath/merge_requests/{}/award_emoji", iid),
        _    => format!("projects/:fullpath/merge_requests/{}/notes/{}/award_emoji", iid, target_id),
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
        Ok(v.as_array().map(|a| a.iter().map(map_gl_reaction).collect()).unwrap_or_default())
    }).await.map_err(|e| e.to_string())?
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
    }).await.map_err(|e| e.to_string())?
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
    }).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod gl_list_issues_tests {
    use super::gl_issue_to_issue;

    #[test]
    fn maps_gitlab_issue_json_to_issue() {
        let v: serde_json::Value = serde_json::from_str(r#"{
            "iid": 12, "title": "Crash", "state": "opened",
            "author": {"username": "alice"},
            "assignees": [{"username": "bob"}],
            "labels": ["bug","p1"],
            "web_url": "https://gitlab.com/o/r/-/issues/12",
            "created_at": "2026-01-01T00:00:00Z",
            "updated_at": "2026-01-02T00:00:00Z",
            "milestone": {"title": "M1"}
        }"#).unwrap();
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

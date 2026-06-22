//! Bitbucket Cloud REST v2 Tauri commands — §3.x Forge integrations.
//!
//! Uses `curl` as the HTTP transport (available on macOS, Linux, Windows 10+)
//! with credentials stored in the OS keychain via `credentials.rs`.
//!
//! **Auth**: Bitbucket App Passwords (username + app password) stored as:
//!   service = `"gitwand:bitbucket"`
//!   account = `"<workspace>:<username>"` (URL-safe)
//!   value   = `"<app_password>"`
//!
//! **Project resolution**: workspace + slug are parsed from `git remote get-url
//! origin` at command time. No caching — consistent with `gh.rs` / `gitlab.rs`.
//!
//! **API base**: `https://api.bitbucket.org/2.0/repositories/{workspace}/{slug}`
//!
//! **Pagination**: Bitbucket uses page-based pagination with `?page=N&pagelen=M`
//! and a `size` field in the response envelope.
//!
//! **Security note**: credentials are injected via `curl --config -` (stdin),
//! keeping the `Authorization: Basic` header off the process argv.

use base64::{Engine as _, engine::general_purpose::STANDARD as B64};
use crate::git::hidden_cmd;
use crate::types::*;
use super::curl_util::{auth_header_config, curl_with_status};
use rayon::prelude::*;
use std::collections::HashMap;

// ─── Credential helpers ────────────────────────────────────────────────────────

const BB_SERVICE: &str = "gitwand:bitbucket";

/// Read Bitbucket credentials from the OS keychain.
///
/// Returns `(username, app_password)`. Propagates a user-friendly error if
/// not configured so the caller can surface "Set up in Settings > Accounts."
fn get_bb_creds(cwd: &str) -> Result<(String, String), String> {
    let (workspace, _) = parse_workspace_slug(cwd)?;
    // Try workspace-scoped entry first; fall back to generic workspace key.
    let account_key = workspace.clone();
    let entry = keyring::Entry::new(BB_SERVICE, &account_key)
        .map_err(|e| format!("keyring: {}", e))?;
    let stored = entry.get_password().map_err(|_| {
        format!(
            "No Bitbucket credentials found for workspace '{workspace}'. \
             Please configure your App Password in Settings > Accounts.",
        )
    })?;
    // Value format: "username:app_password"
    let mut parts = stored.splitn(2, ':');
    let username = parts.next().unwrap_or("").to_string();
    let app_password = parts.next().unwrap_or("").to_string();
    if username.is_empty() || app_password.is_empty() {
        return Err(format!(
            "Malformed Bitbucket credential for workspace '{workspace}'. \
             Please re-enter your App Password in Settings > Accounts."
        ));
    }
    Ok((username, app_password))
}

/// Build curl `--config -` file contents for Bitbucket Basic auth.
fn basic_auth_config(username: &str, app_password: &str) -> String {
    let encoded = B64.encode(format!("{}:{}", username, app_password));
    auth_header_config("Basic", &encoded)
}

// ─── Project resolution ────────────────────────────────────────────────────────

/// Parse (workspace, slug) from `git remote get-url origin` in `cwd`.
///
/// Handles both HTTPS and SSH remote URL formats:
/// - `https://bitbucket.org/workspace/repo.git`
/// - `git@bitbucket.org:workspace/repo.git`
fn parse_workspace_slug(cwd: &str) -> Result<(String, String), String> {
    let output = hidden_cmd("git")
        .args(["remote", "get-url", "origin"])
        .current_dir(cwd)
        .output()
        .map_err(|e| format!("git remote get-url: {}", e))?;
    if !output.status.success() {
        return Err("No 'origin' remote found in this repo.".to_string());
    }
    let url = String::from_utf8_lossy(&output.stdout).trim().to_string();

    let path = if url.starts_with("git@") {
        // git@bitbucket.org:workspace/repo.git  →  workspace/repo
        url.splitn(2, ':')
            .nth(1)
            .unwrap_or("")
            .trim_end_matches(".git")
            .to_string()
    } else {
        // https://bitbucket.org/workspace/repo.git  →  workspace/repo
        url.trim_end_matches('/')
            .trim_end_matches(".git")
            .splitn(2, "bitbucket.org/")
            .nth(1)
            .unwrap_or("")
            .to_string()
    };

    let mut parts = path.splitn(2, '/');
    let workspace = parts.next().unwrap_or("").to_string();
    let slug = parts.next().unwrap_or("").to_string();

    if workspace.is_empty() || slug.is_empty() {
        return Err(format!(
            "Could not parse Bitbucket workspace/slug from remote URL: {}",
            url
        ));
    }
    Ok((workspace, slug))
}

/// Build the base API path for a repository.
fn repo_api(workspace: &str, slug: &str) -> String {
    format!(
        "https://api.bitbucket.org/2.0/repositories/{}/{}",
        workspace, slug
    )
}

// ─── HTTP helper ───────────────────────────────────────────────────────────────

/// Transport layer: delegate to `curl_with_status` with no forge-specific
/// extra headers (Bitbucket needs none beyond `Accept` and auth).
fn bb_curl_raw(
    method: &str,
    url: &str,
    body_json: Option<&str>,
    auth_config: &str,
    accept: &str,
) -> Result<(i32, String), String> {
    curl_with_status(method, url, Some(auth_config), body_json, &[], accept)
}

/// JSON API call: interprets the `(status, body)` from `bb_curl_raw`.
///
/// HTTP ≥ 400 maps to an error (preferring the JSON `message` field).
/// Empty bodies (DELETE / some PUT) return `Null`. Application-level errors
/// surfaced in a 2xx `{"error":{...}}` envelope are also mapped to errors.
fn bb_curl(
    method: &str,
    url: &str,
    body_json: Option<&str>,
    auth_config: &str,
) -> Result<serde_json::Value, String> {
    let (status, body) = bb_curl_raw(method, url, body_json, auth_config, "application/json")?;
    if status >= 400 {
        let msg = serde_json::from_str::<serde_json::Value>(body.trim())
            .ok()
            .and_then(|v| {
                v.get("error")
                    .and_then(|e| e.get("message"))
                    .and_then(|m| m.as_str())
                    .map(String::from)
            })
            .unwrap_or_else(|| format!("HTTP {}", status));
        return Err(format!("Bitbucket API error: {}", msg));
    }
    if body.trim().is_empty() {
        return Ok(serde_json::Value::Null);
    }
    let json: serde_json::Value = serde_json::from_str(body.trim())
        .map_err(|e| format!("Failed to parse Bitbucket response: {} — raw: {}", e, &body[..body.len().min(300)]))?;
    // Secondary check: Bitbucket sometimes returns 2xx with an error envelope.
    if let Some(error) = json.get("error") {
        let msg = error
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("unknown Bitbucket API error");
        return Err(format!("Bitbucket API error: {}", msg));
    }
    Ok(json)
}

// ─── JSON field helpers ────────────────────────────────────────────────────────

fn js(v: &serde_json::Value, key: &str) -> String {
    v.get(key).and_then(|x| x.as_str()).unwrap_or("").to_string()
}

fn ji(v: &serde_json::Value, key: &str) -> i64 {
    v.get(key)
        .and_then(|x| x.as_i64())
        .or_else(|| v.get(key).and_then(|x| x.as_str()).and_then(|s| s.parse().ok()))
        .unwrap_or(0)
}

/// Extract a nested string: `obj[outer][inner]`.
fn jnested(v: &serde_json::Value, outer: &str, inner: &str) -> String {
    v.get(outer)
        .and_then(|o| o.get(inner))
        .and_then(|s| s.as_str())
        .unwrap_or("")
        .to_string()
}

/// Extract `obj[outer][inner][leaf]` — for Bitbucket's nested branch objects.
fn jdeep(v: &serde_json::Value, outer: &str, inner: &str, leaf: &str) -> String {
    v.get(outer)
        .and_then(|o| o.get(inner))
        .and_then(|o| o.get(leaf))
        .and_then(|s| s.as_str())
        .unwrap_or("")
        .to_string()
}

/// Extract array of `nickname` from `[{account_id, display_name, nickname, ...}]`.
#[allow(dead_code)]
fn jnicknames(v: &serde_json::Value, key: &str) -> Vec<String> {
    v.get(key)
        .and_then(|a| a.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|u| {
                    u.get("nickname")
                        .or_else(|| u.get("display_name"))
                        .and_then(|n| n.as_str())
                        .map(String::from)
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Extract label names from Bitbucket's `[{name: ...}]` format.
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

/// Map Bitbucket PR state to canonical state.
fn bb_state(state: &str) -> String {
    match state {
        "OPEN" => "open".to_string(),
        "MERGED" => "merged".to_string(),
        "DECLINED" | "SUPERSEDED" => "closed".to_string(),
        s => s.to_lowercase(),
    }
}

// ─── PR mapping ────────────────────────────────────────────────────────────────

/// Map a Bitbucket PR JSON object to a PullRequest.
///
/// Bitbucket PR shape:
/// ```json
/// {
///   "id": 1, "title": "...", "state": "OPEN",
///   "author": {"display_name": "Alice", "nickname": "alice"},
///   "source": {"branch": {"name": "feature/x"}},
///   "destination": {"branch": {"name": "main"}},
///   "created_on": "...", "updated_on": "...",
///   "links": {"html": {"href": "https://bitbucket.org/..."}},
///   "participants": [{role: "REVIEWER", ...}]
/// }
/// ```
fn bb_pr_to_pr(pr: &serde_json::Value) -> PullRequest {
    let state = js(pr, "state");
    // Bitbucket doesn't have a native draft concept — check title prefix.
    let title = js(pr, "title");
    let is_draft = title.starts_with("Draft:");

    let html_url = jnested(pr, "links", "html")
        .split('"')
        .find(|s| s.starts_with("https://"))
        .unwrap_or("")
        .to_string();
    let url = if html_url.is_empty() {
        jdeep(pr, "links", "html", "href")
    } else {
        html_url
    };

    // Reviewers: participants with role "REVIEWER".
    let reviewers: Vec<String> = pr
        .get("participants")
        .and_then(|a| a.as_array())
        .map(|arr| {
            arr.iter()
                .filter(|p| js(p, "role") == "REVIEWER")
                .filter_map(|p| {
                    p.get("user")
                        .and_then(|u| u.get("nickname"))
                        .and_then(|n| n.as_str())
                        .map(String::from)
                })
                .collect()
        })
        .unwrap_or_default();

    PullRequest {
        number: ji(pr, "id"),
        title,
        state: bb_state(&state),
        author: jnested(pr, "author", "nickname"),
        branch: jdeep(pr, "source", "branch", "name"),
        base: jdeep(pr, "destination", "branch", "name"),
        draft: is_draft,
        created_at: js(pr, "created_on"),
        updated_at: js(pr, "updated_on"),
        url,
        additions: 0, // Not in list response — would need per-PR diffstat call
        deletions: 0,
        labels: jlabels(pr, "labels"),
        assignees: vec![jnested(pr, "author", "nickname")]
            .into_iter()
            .filter(|s| !s.is_empty())
            .collect(),
        review_requested: reviewers,
        review_decision: String::new(),
        merge_state_status: String::new(),
        checks_rollup: String::new(),
        comment_count: ji(pr, "comment_count"),
    }
}

/// Map a Bitbucket PR detail response to a PullRequestDetail.
fn bb_pr_to_detail(pr: &serde_json::Value) -> PullRequestDetail {
    let state = js(pr, "state");
    let title = js(pr, "title");
    let is_draft = title.starts_with("Draft:");

    let url = jdeep(pr, "links", "html", "href");

    // Reviewers from participants.
    let reviewers: Vec<String> = pr
        .get("participants")
        .and_then(|a| a.as_array())
        .map(|arr| {
            arr.iter()
                .filter(|p| js(p, "role") == "REVIEWER")
                .filter_map(|p| {
                    p.get("user")
                        .and_then(|u| u.get("nickname"))
                        .and_then(|n| n.as_str())
                        .map(String::from)
                })
                .collect()
        })
        .unwrap_or_default();

    // merge_commit is present on merged PRs.
    let merged_at = jnested(pr, "merge_commit", "date")
        .or_else_empty(|| js(pr, "updated_on")); // fallback if unavailable

    PullRequestDetail {
        number: ji(pr, "id"),
        title,
        body: js(pr, "description"),
        state: bb_state(&state),
        author: jnested(pr, "author", "nickname"),
        branch: jdeep(pr, "source", "branch", "name"),
        base: jdeep(pr, "destination", "branch", "name"),
        draft: is_draft,
        created_at: js(pr, "created_on"),
        updated_at: js(pr, "updated_on"),
        merged_at,
        url,
        additions: 0,
        deletions: 0,
        changed_files: 0,
        comments: ji(pr, "comment_count"),
        review_comments: 0,
        labels: jlabels(pr, "labels"),
        reviewers,
        mergeable: String::new(), // Not directly available in v2.10
        checks_status: String::new(), // Bitbucket Pipelines needs a separate call
        // Bitbucket merge permission needs a separate privileges call —
        // unknown ⇒ UI gates on errors only.
        can_merge: None,
    }
}

// Small helper trait to avoid verbose empty-check on merged_at.
trait OrElseEmpty {
    fn or_else_empty(self, f: impl FnOnce() -> String) -> String;
}
impl OrElseEmpty for String {
    fn or_else_empty(self, f: impl FnOnce() -> String) -> String {
        if self.is_empty() { f() } else { self }
    }
}

// ─── Tauri Commands ────────────────────────────────────────────────────────────

/// List pull requests via Bitbucket REST API v2.
///
/// `state` accepts "OPEN" (default), "MERGED", "DECLINED", "ALL".
#[tauri::command]
pub(crate) async fn bb_list_prs(
    cwd: String,
    state: String,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<Vec<PullRequest>, String> {
    let (workspace, slug) = parse_workspace_slug(&cwd)?;
    let (username, app_password) = get_bb_creds(&cwd)?;
    let auth_config = basic_auth_config(&username, &app_password);

    let st = match state.to_uppercase().as_str() {
        "MERGED" => "MERGED",
        "DECLINED" => "DECLINED",
        "ALL" => "ALL",
        _ => "OPEN",
    };

    let pagelen = limit.unwrap_or(10).max(1);
    let off = offset.unwrap_or(0).max(0);
    // Bitbucket pages are 1-indexed; compute first page needed.
    let page = (off / pagelen) + 1;
    let extra = off % pagelen; // entries to skip within the page

    let url = if st == "ALL" {
        format!(
            "{}/pullrequests?state=OPEN&state=MERGED&state=DECLINED&pagelen={}&page={}",
            repo_api(&workspace, &slug),
            pagelen + extra,
            page
        )
    } else {
        format!(
            "{}/pullrequests?state={}&pagelen={}&page={}",
            repo_api(&workspace, &slug),
            st,
            pagelen + extra,
            page
        )
    };

    let resp = bb_curl("GET", &url, None, &auth_config)?;
    let values = resp
        .get("values")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "Unexpected Bitbucket response shape (missing 'values')".to_string())?;

    let mut prs: Vec<PullRequest> = values.iter().map(bb_pr_to_pr).collect();
    if extra > 0 {
        let skip = (extra as usize).min(prs.len());
        prs.drain(..skip);
    }

    // Colour the sidebar dot from each PR's head-commit build statuses. The list
    // payload carries `source.commit.hash`, so resolve it per PR (no extra PR
    // fetch) and aggregate statuses in parallel (red = failed, yellow = running).
    let sha_by_num: HashMap<i64, String> = values
        .iter()
        .filter_map(|pr| {
            let hash = jdeep(pr, "source", "commit", "hash");
            if hash.is_empty() { None } else { Some((ji(pr, "id"), hash)) }
        })
        .collect();
    let rollups: HashMap<i64, String> = prs
        .par_iter()
        .filter_map(|pr| {
            let sha = sha_by_num.get(&pr.number)?;
            let rollup = bb_rollup_for_sha(&workspace, &slug, sha, &auth_config);
            if rollup.is_empty() { None } else { Some((pr.number, rollup)) }
        })
        .collect();
    for pr in &mut prs {
        if let Some(state) = rollups.get(&pr.number) {
            pr.checks_rollup = state.clone();
        }
    }

    Ok(prs)
}

/// Count PRs for a given state.
#[tauri::command]
pub(crate) async fn bb_pr_count(cwd: String, state: String) -> Result<i64, String> {
    let (workspace, slug) = parse_workspace_slug(&cwd)?;
    let (username, app_password) = get_bb_creds(&cwd)?;
    let auth_config = basic_auth_config(&username, &app_password);

    let st = match state.to_uppercase().as_str() {
        "MERGED" => "MERGED",
        "DECLINED" => "DECLINED",
        _ => "OPEN",
    };

    let url = format!(
        "{}/pullrequests?state={}&pagelen=1",
        repo_api(&workspace, &slug),
        st
    );

    let resp = bb_curl("GET", &url, None, &auth_config).unwrap_or(serde_json::Value::Null);
    Ok(resp.get("size").and_then(|v| v.as_i64()).unwrap_or(0))
}

/// Get detailed PR info.
#[tauri::command]
pub(crate) async fn bb_get_pr(cwd: String, pr_id: i64) -> Result<PullRequestDetail, String> {
    let (workspace, slug) = parse_workspace_slug(&cwd)?;
    let (username, app_password) = get_bb_creds(&cwd)?;
    let auth_config = basic_auth_config(&username, &app_password);

    let url = format!("{}/pullrequests/{}", repo_api(&workspace, &slug), pr_id);
    let resp = bb_curl("GET", &url, None, &auth_config)?;
    let mut detail = bb_pr_to_detail(&resp);
    // Aggregate the head commit's build statuses so the CI tab can colour itself.
    let sha = jdeep(&resp, "source", "commit", "hash");
    detail.checks_status = bb_rollup_for_sha(&workspace, &slug, &sha, &auth_config);
    Ok(detail)
}

/// Get the diff of a PR as a unified diff string.
#[tauri::command]
pub(crate) async fn bb_pr_diff(cwd: String, pr_id: i64) -> Result<String, String> {
    let (workspace, slug) = parse_workspace_slug(&cwd)?;
    let (username, app_password) = get_bb_creds(&cwd)?;
    let auth_config = basic_auth_config(&username, &app_password);

    // Bitbucket /diff endpoint returns plain-text unified diff — not JSON.
    let url = format!("{}/pullrequests/{}/diff", repo_api(&workspace, &slug), pr_id);
    let (status, body) = bb_curl_raw("GET", &url, None, &auth_config, "*/*")?;
    if status >= 400 {
        return Err(format!("Bitbucket diff failed (HTTP {}): {}", status, body.trim()));
    }
    Ok(body)
}

/// Create a PR via Bitbucket REST API.
///
/// If `source_branch` is empty, the current HEAD branch is resolved via
/// `git rev-parse --abbrev-ref HEAD` (mirrors the `glab mr create` convention).
#[tauri::command]
pub(crate) async fn bb_create_pr(
    cwd: String,
    title: String,
    body: String,
    source_branch: String,
    target_branch: String,
    reviewers: Option<Vec<String>>,
) -> Result<PullRequest, String> {
    let (workspace, slug) = parse_workspace_slug(&cwd)?;
    let (username, app_password) = get_bb_creds(&cwd)?;
    let auth_config = basic_auth_config(&username, &app_password);

    // Resolve source branch from HEAD if not provided.
    let source_branch = if source_branch.is_empty() {
        let out = hidden_cmd("git")
            .args(["rev-parse", "--abbrev-ref", "HEAD"])
            .current_dir(&cwd)
            .output()
            .map_err(|e| format!("git rev-parse: {}", e))?;
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    } else {
        source_branch
    };

    let reviewer_list: Vec<serde_json::Value> = reviewers
        .unwrap_or_default()
        .into_iter()
        .map(|r| serde_json::json!({ "username": r }))
        .collect();

    let payload = serde_json::json!({
        "title": title,
        "description": body,
        "source": { "branch": { "name": source_branch } },
        "destination": { "branch": { "name": target_branch } },
        "reviewers": reviewer_list,
        "close_source_branch": true
    });

    let url = format!("{}/pullrequests", repo_api(&workspace, &slug));
    let resp = bb_curl("POST", &url, Some(&payload.to_string()), &auth_config)?;
    Ok(bb_pr_to_pr(&resp))
}

/// Merge a PR via Bitbucket REST API.
///
/// `method` accepts "merge" (default), "squash", "fast_forward".
#[tauri::command]
pub(crate) async fn bb_merge_pr(cwd: String, pr_id: i64, method: String) -> Result<(), String> {
    let (workspace, slug) = parse_workspace_slug(&cwd)?;
    let (username, app_password) = get_bb_creds(&cwd)?;
    let auth_config = basic_auth_config(&username, &app_password);

    let merge_strategy = match method.as_str() {
        "squash" => "squash",
        "fast_forward" | "rebase" => "fast_forward",
        _ => "merge_commit",
    };

    let payload = serde_json::json!({
        "merge_strategy": merge_strategy,
        "close_source_branch": true
    });

    let url = format!("{}/pullrequests/{}/merge", repo_api(&workspace, &slug), pr_id);
    bb_curl("POST", &url, Some(&payload.to_string()), &auth_config)?;
    Ok(())
}

/// Checkout a PR branch locally using git fetch + switch.
///
/// Bitbucket doesn't have a `bb pr checkout` CLI, so we:
/// 1. Fetch the source branch from origin
/// 2. Switch to it (create tracking branch if needed)
#[tauri::command]
pub(crate) async fn bb_checkout_pr(cwd: String, pr_id: i64) -> Result<(), String> {
    let (workspace, slug) = parse_workspace_slug(&cwd)?;
    let (username, app_password) = get_bb_creds(&cwd)?;
    let auth_config = basic_auth_config(&username, &app_password);

    // Fetch PR detail to get the source branch name.
    let url = format!("{}/pullrequests/{}", repo_api(&workspace, &slug), pr_id);
    let pr = bb_curl("GET", &url, None, &auth_config)?;
    let branch = jdeep(&pr, "source", "branch", "name");
    if branch.is_empty() {
        return Err(format!("Could not determine source branch for PR #{}", pr_id));
    }

    // Fetch the branch.
    let fetch = hidden_cmd("git")
        .args(["fetch", "origin", &branch])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("git fetch: {}", e))?;
    if !fetch.status.success() {
        return Err(format!(
            "git fetch failed: {}",
            String::from_utf8_lossy(&fetch.stderr)
        ));
    }

    // Switch to the branch (--track to set upstream).
    let switch = hidden_cmd("git")
        .args(["switch", "--track", &format!("origin/{}", branch)])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("git switch: {}", e))?;

    if !switch.status.success() {
        // Already on the branch or local branch exists — try a plain switch.
        let switch2 = hidden_cmd("git")
            .args(["switch", &branch])
            .current_dir(&cwd)
            .output()
            .map_err(|e| format!("git switch: {}", e))?;
        if !switch2.status.success() {
            return Err(format!(
                "git switch failed: {}",
                String::from_utf8_lossy(&switch2.stderr)
            ));
        }
    }

    Ok(())
}

/// List comments on a PR. Returns raw JSON array for TypeScript parsing.
#[tauri::command]
pub(crate) async fn bb_pr_comments(cwd: String, pr_id: i64) -> Result<serde_json::Value, String> {
    let (workspace, slug) = parse_workspace_slug(&cwd)?;
    let (username, app_password) = get_bb_creds(&cwd)?;
    let auth_config = basic_auth_config(&username, &app_password);

    let url = format!(
        "{}/pullrequests/{}/comments?pagelen=100",
        repo_api(&workspace, &slug),
        pr_id
    );
    let resp = bb_curl("GET", &url, None, &auth_config)?;
    Ok(resp.get("values").cloned().unwrap_or(serde_json::Value::Array(vec![])))
}

/// Create a comment on a PR.
#[tauri::command]
pub(crate) async fn bb_create_comment(
    cwd: String,
    pr_id: i64,
    body: String,
) -> Result<serde_json::Value, String> {
    let (workspace, slug) = parse_workspace_slug(&cwd)?;
    let (username, app_password) = get_bb_creds(&cwd)?;
    let auth_config = basic_auth_config(&username, &app_password);

    let payload = serde_json::json!({ "content": { "raw": body } });
    let url = format!(
        "{}/pullrequests/{}/comments",
        repo_api(&workspace, &slug),
        pr_id
    );
    bb_curl("POST", &url, Some(&payload.to_string()), &auth_config)
}

/// Update a comment on a PR.
#[tauri::command]
pub(crate) async fn bb_update_comment(
    cwd: String,
    pr_id: i64,
    comment_id: i64,
    body: String,
) -> Result<(), String> {
    let (workspace, slug) = parse_workspace_slug(&cwd)?;
    let (username, app_password) = get_bb_creds(&cwd)?;
    let auth_config = basic_auth_config(&username, &app_password);

    let payload = serde_json::json!({ "content": { "raw": body } });
    let url = format!(
        "{}/pullrequests/{}/comments/{}",
        repo_api(&workspace, &slug),
        pr_id,
        comment_id
    );
    bb_curl("PUT", &url, Some(&payload.to_string()), &auth_config)?;
    Ok(())
}

/// Delete a comment on a PR.
#[tauri::command]
pub(crate) async fn bb_delete_comment(
    cwd: String,
    pr_id: i64,
    comment_id: i64,
) -> Result<(), String> {
    let (workspace, slug) = parse_workspace_slug(&cwd)?;
    let (username, app_password) = get_bb_creds(&cwd)?;
    let auth_config = basic_auth_config(&username, &app_password);

    let url = format!(
        "{}/pullrequests/{}/comments/{}",
        repo_api(&workspace, &slug),
        pr_id,
        comment_id
    );
    bb_curl("DELETE", &url, None, &auth_config)?;
    Ok(())
}

/// List PR reviews derived from the participants array.
///
/// Returns each participant who has approved or requested changes, shaped to match
/// the frontend `PrReview` interface. Participants with no recorded action are omitted.
#[tauri::command]
pub(crate) async fn bb_list_reviews(
    cwd: String,
    pr_id: i64,
) -> Result<Vec<serde_json::Value>, String> {
    let (workspace, slug) = parse_workspace_slug(&cwd)?;
    let (username, app_password) = get_bb_creds(&cwd)?;
    let auth_config = basic_auth_config(&username, &app_password);

    let url = format!("{}/pullrequests/{}", repo_api(&workspace, &slug), pr_id);
    let resp = bb_curl("GET", &url, None, &auth_config)?;

    let participants = resp
        .get("participants")
        .and_then(|a| a.as_array())
        .cloned()
        .unwrap_or_default();

    let reviews: Vec<serde_json::Value> = participants
        .into_iter()
        .enumerate()
        .filter_map(|(idx, p)| {
            let approved = p.get("approved").and_then(|b| b.as_bool()).unwrap_or(false);
            let state_raw = p
                .get("state")
                .and_then(|s| s.as_str())
                .unwrap_or("")
                .to_lowercase();

            let review_state = if approved || state_raw == "approved" {
                "APPROVED"
            } else if state_raw == "changes_requested" {
                "CHANGES_REQUESTED"
            } else {
                return None; // participant hasn't acted yet
            };

            let user = p.get("user").cloned().unwrap_or(serde_json::Value::Null);
            let login = user
                .get("nickname")
                .and_then(|s| s.as_str())
                .unwrap_or("")
                .to_string();
            let avatar_url = user
                .get("links")
                .and_then(|l| l.get("avatar"))
                .and_then(|a| a.get("href"))
                .and_then(|s| s.as_str())
                .unwrap_or("")
                .to_string();
            let submitted_at = p
                .get("participated_on")
                .and_then(|s| s.as_str())
                .unwrap_or("")
                .to_string();

            Some(serde_json::json!({
                "id": idx as i64,
                "state": review_state,
                "body": "",
                "user": { "login": login, "avatar_url": avatar_url },
                "submitted_at": submitted_at,
                "html_url": ""
            }))
        })
        .collect();

    Ok(reviews)
}

/// Approve a PR (current user).
#[tauri::command]
pub(crate) async fn bb_approve_pr(cwd: String, pr_id: i64) -> Result<(), String> {
    let (workspace, slug) = parse_workspace_slug(&cwd)?;
    let (username, app_password) = get_bb_creds(&cwd)?;
    let auth_config = basic_auth_config(&username, &app_password);

    let url = format!(
        "{}/pullrequests/{}/approve",
        repo_api(&workspace, &slug),
        pr_id
    );
    bb_curl("POST", &url, None, &auth_config)?;
    Ok(())
}

/// List files changed in a PR.
#[tauri::command]
pub(crate) async fn bb_pr_files(cwd: String, pr_id: i64) -> Result<Vec<String>, String> {
    let (workspace, slug) = parse_workspace_slug(&cwd)?;
    let (username, app_password) = get_bb_creds(&cwd)?;
    let auth_config = basic_auth_config(&username, &app_password);

    let url = format!(
        "{}/pullrequests/{}/diffstat",
        repo_api(&workspace, &slug),
        pr_id
    );
    let resp = bb_curl("GET", &url, None, &auth_config)?;
    let values = resp
        .get("values")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    Ok(values
        .iter()
        .filter_map(|f| {
            f.get("new")
                .and_then(|n| n.get("path"))
                .and_then(|p| p.as_str())
                .or_else(|| {
                    f.get("old")
                        .and_then(|o| o.get("path"))
                        .and_then(|p| p.as_str())
                })
                .map(String::from)
        })
        .collect())
}

/// Get the current Bitbucket user (the one whose credentials are stored).
#[tauri::command]
pub(crate) async fn bb_current_user(cwd: String) -> Result<String, String> {
    let (username, app_password) = get_bb_creds(&cwd)?;
    let auth_config = basic_auth_config(&username, &app_password);

    let resp = bb_curl("GET", "https://api.bitbucket.org/2.0/user", None, &auth_config)?;
    Ok(resp
        .get("nickname")
        .or_else(|| resp.get("display_name"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string())
}

/// List reviewer candidates (repo members with write access).
#[tauri::command]
pub(crate) async fn bb_reviewer_candidates(cwd: String) -> Result<Vec<ReviewerCandidate>, String> {
    let (workspace, slug) = parse_workspace_slug(&cwd)?;
    let (username, app_password) = get_bb_creds(&cwd)?;
    let auth_config = basic_auth_config(&username, &app_password);

    let url = format!(
        "https://api.bitbucket.org/2.0/repositories/{}/{}/permissions-config/users",
        workspace, slug
    );
    let resp = bb_curl("GET", &url, None, &auth_config)
        .unwrap_or(serde_json::Value::Null);

    let values = resp
        .get("values")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let mut candidates: Vec<ReviewerCandidate> = values
        .iter()
        .filter_map(|m| {
            let user = m.get("user")?;
            let login = user
                .get("nickname")
                .or_else(|| user.get("display_name"))
                .and_then(|v| v.as_str())?;
            if login.is_empty() {
                return None;
            }
            Some(ReviewerCandidate {
                login: login.to_string(),
                name: user.get("display_name").and_then(|v| v.as_str()).map(String::from),
                avatar_url: user
                    .get("links")
                    .and_then(|l| l.get("avatar"))
                    .and_then(|a| a.get("href"))
                    .and_then(|v| v.as_str())
                    .map(String::from),
            })
        })
        .collect();

    candidates.sort_by(|a, b| a.login.to_lowercase().cmp(&b.login.to_lowercase()));
    Ok(candidates)
}

/// Reduce a commit's Bitbucket build statuses to one rollup state:
/// `FAILURE` (red) / `PENDING` (yellow) / `SUCCESS` (green), or `""` (no CI).
/// Precedence: any failed/stopped build ⇒ red, else any in-progress ⇒ yellow.
fn bb_rollup_from_statuses(values: &[serde_json::Value]) -> String {
    if values.is_empty() {
        return String::new();
    }
    let mut pending = false;
    for s in values {
        // Bitbucket status states: SUCCESSFUL / FAILED / INPROGRESS / STOPPED.
        match js(s, "state").as_str() {
            "FAILED" | "STOPPED" => return "FAILURE".to_string(),
            "SUCCESSFUL" => {}
            _ => pending = true, // INPROGRESS / anything unknown → still running
        }
    }
    if pending { "PENDING".to_string() } else { "SUCCESS".to_string() }
}

/// Fetch + aggregate the build statuses of commit `sha`. Sync, best-effort
/// (empty on any error) so it's safe to fan out under rayon.
fn bb_rollup_for_sha(workspace: &str, slug: &str, sha: &str, auth_config: &str) -> String {
    if sha.is_empty() {
        return String::new();
    }
    let url = format!(
        "https://api.bitbucket.org/2.0/repositories/{}/{}/commit/{}/statuses?pagelen=100",
        workspace, slug, sha
    );
    let resp = bb_curl("GET", &url, None, auth_config).unwrap_or(serde_json::Value::Null);
    let values = resp.get("values").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    bb_rollup_from_statuses(&values)
}

/// Get CI status checks for a PR via Bitbucket Pipelines commit statuses endpoint.
///
/// Endpoint: GET /2.0/repositories/{ws}/{slug}/commit/{sha}/statuses
/// The head commit SHA is read from the PR's `source.commit.hash` field.
#[tauri::command]
pub(crate) async fn bb_pr_ci_checks(cwd: String, pr_id: i64) -> Result<Vec<CICheck>, String> {
    let (workspace, slug) = parse_workspace_slug(&cwd)?;
    let (username, app_password) = get_bb_creds(&cwd)?;
    let auth_config = basic_auth_config(&username, &app_password);

    // Step 1: get the PR to find the head commit SHA.
    let pr_url = format!("{}/pullrequests/{}", repo_api(&workspace, &slug), pr_id);
    let pr = bb_curl("GET", &pr_url, None, &auth_config)?;
    let head_sha = jdeep(&pr, "source", "commit", "hash");
    if head_sha.is_empty() {
        return Ok(Vec::new());
    }

    // Step 2: fetch commit statuses.
    let url = format!(
        "https://api.bitbucket.org/2.0/repositories/{}/{}/commit/{}/statuses?pagelen=30",
        workspace, slug, head_sha
    );
    let resp = bb_curl("GET", &url, None, &auth_config).unwrap_or(serde_json::Value::Null);
    let values = resp
        .get("values")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let checks: Vec<CICheck> = values
        .iter()
        .map(|s| {
            // Bitbucket status states: SUCCESSFUL, FAILED, INPROGRESS, STOPPED
            let bb_state = js(s, "state");
            let conclusion = match bb_state.as_str() {
                "SUCCESSFUL" => "success".to_string(),
                "FAILED"     => "failure".to_string(),
                "STOPPED"    => "cancelled".to_string(),
                _            => "pending".to_string(),
            };
            let status = if bb_state == "INPROGRESS" {
                "in_progress".to_string()
            } else {
                "completed".to_string()
            };
            CICheck {
                name: js(s, "name"),
                state: status,
                conclusion,
                details_url: {
                    let u = jnested(s, "url", "href");
                    if u.is_empty() { js(s, "url") } else { u }
                },
            }
        })
        .collect();

    Ok(checks)
}

/// Get report annotations for a PR (v2.18 — Inline CI Check Annotations).
///
/// Uses the Bitbucket Reports API:
///   1. PR → head commit SHA
///   2. `GET /commit/{sha}/reports` → reports created by Pipelines / linters
///   3. `GET /commit/{sha}/reports/{id}/annotations` per report
///
/// Severity mapping: CRITICAL|HIGH → failure, MEDIUM → warning, LOW → notice.
/// Non-fatal everywhere: no reports → `[]`.
#[tauri::command]
pub(crate) fn bb_pr_annotations(cwd: String, pr_id: i64) -> Result<Vec<CIAnnotation>, String> {
    let (workspace, slug) = parse_workspace_slug(&cwd)?;
    let (username, app_password) = get_bb_creds(&cwd)?;
    let auth = basic_auth_config(&username, &app_password);

    // 1. Head commit SHA.
    let pr_url = format!("{}/pullrequests/{}", repo_api(&workspace, &slug), pr_id);
    let pr = bb_curl("GET", &pr_url, None, &auth)?;
    let head_sha = jdeep(&pr, "source", "commit", "hash");
    if head_sha.is_empty() {
        return Ok(Vec::new());
    }

    // 2. Reports on that commit.
    let reports_url = format!(
        "{}/commit/{}/reports?pagelen=20",
        repo_api(&workspace, &slug),
        head_sha
    );
    let resp = bb_curl("GET", &reports_url, None, &auth).unwrap_or(serde_json::Value::Null);
    let reports = resp
        .get("values")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    // 3. Annotations per report.
    let mut annotations = Vec::new();
    for report in &reports {
        let report_id = js(report, "uuid");
        if report_id.is_empty() {
            continue;
        }
        let report_title = js(report, "title");
        let ann_url = format!(
            "{}/commit/{}/reports/{}/annotations?pagelen=100",
            repo_api(&workspace, &slug),
            head_sha,
            report_id
        );
        let resp = match bb_curl("GET", &ann_url, None, &auth) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let values = resp
            .get("values")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();

        for a in &values {
            let path = js(a, "path");
            let line = ji(a, "line");
            if path.is_empty() || line == 0 {
                continue; // commit-level annotation — nothing to anchor in the diff
            }
            let level = match js(a, "severity").as_str() {
                "CRITICAL" | "HIGH" => "failure",
                "MEDIUM" => "warning",
                _ => "notice", // LOW + unknown
            };
            annotations.push(CIAnnotation {
                check_name: report_title.clone(),
                path,
                start_line: line,
                end_line: line,
                level: level.to_string(),
                title: js(a, "summary"),
                message: {
                    let d = js(a, "details");
                    if d.is_empty() { js(a, "summary") } else { d }
                },
            });
        }
    }

    Ok(annotations)
}

// ─── Issue mapping ─────────────────────────────────────────────────────────────

/// Map a Bitbucket issue JSON object to a canonical Issue.
///
/// Bitbucket issue shape:
/// ```json
/// {
///   "id": 5, "title": "Broken", "state": "new",
///   "reporter": {"nickname": "alice"},
///   "assignee": {"nickname": "bob"},
///   "created_on": "...", "updated_on": "...",
///   "links": {"html": {"href": "https://bitbucket.org/o/r/issues/5"}}
/// }
/// ```
/// Note: `links.html` is an object `{"href": "..."}`, not a plain string.
/// Bitbucket issues have no labels array or milestone in the same shape as GitHub.
fn bb_issue_to_issue(v: &serde_json::Value) -> crate::types::Issue {
    let assignee = jnested(v, "assignee", "nickname");
    let assignees = if assignee.is_empty() { vec![] } else { vec![assignee] };
    // links.html is {"href": "..."} — extract the nested href string explicitly.
    let url = v
        .get("links")
        .and_then(|l| l.get("html"))
        .and_then(|h| h.get("href"))
        .and_then(|s| s.as_str())
        .unwrap_or("")
        .to_string();
    crate::types::Issue {
        number: ji(v, "id"),
        title: js(v, "title"),
        state: js(v, "state"),
        author: jnested(v, "reporter", "nickname"),
        assignees,
        labels: vec![],
        url,
        created_at: js(v, "created_on"),
        updated_at: js(v, "updated_on"),
        milestone: String::new(),
    }
}

/// List issues for the current repo via Bitbucket REST API v2.
///
/// `filter` accepts: `""` / `"all"` (open issues), `"assigned"` (assigned to me),
/// `"created"` (created by me).
///
/// Bitbucket open issue states are `"new"` and `"open"`. A 404 means the
/// issue tracker is disabled for this repo — treated as an empty list, not an error.
///
/// Minimal percent-encoding for a query-param value. `curl_with_status` sends
/// the URL as a raw positional arg (no encoding), so the spaces, quotes and
/// parens in a BIQL `q=` expression must be encoded here or curl rejects the URL.
/// Keeps RFC-3986 unreserved chars; percent-encodes everything else.
fn bb_urlenc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

#[tauri::command]
pub(crate) async fn bb_list_issues(
    cwd: String,
    filter: String,
    limit: Option<i64>,
) -> Result<Vec<crate::types::Issue>, String> {
    let (workspace, slug) = parse_workspace_slug(&cwd)?;
    let (username, app_password) = get_bb_creds(&cwd)?;
    let auth_config = basic_auth_config(&username, &app_password);
    let pagelen = limit.unwrap_or(100).max(1);

    // Open Bitbucket issue states are "new" and "open".
    // Resolve "me" once for assigned/created filters.
    let me = match filter.as_str() {
        "assigned" | "created" => bb_current_user(cwd.clone()).await.unwrap_or_default(),
        _ => String::new(),
    };
    // Build the BIQL query first, then percent-encode the whole `q` value.
    // curl_with_status sends the URL as a raw arg (no encoding), so the spaces,
    // quotes and parens in BIQL must be encoded here or curl rejects the URL.
    let mut q = String::from("(state=\"new\" OR state=\"open\")");
    if !me.is_empty() {
        match filter.as_str() {
            "assigned" => q.push_str(&format!(" AND assignee.nickname=\"{}\"", me)),
            "created" => q.push_str(&format!(" AND reporter.nickname=\"{}\"", me)),
            _ => {}
        }
    }
    let url = format!(
        "{}/issues?q={}&pagelen={}&sort=-updated_on",
        repo_api(&workspace, &slug),
        bb_urlenc(&q),
        pagelen
    );

    let resp = match bb_curl("GET", &url, None, &auth_config) {
        Ok(v) => v,
        // Issue tracker disabled for this repo ⇒ treat as empty, not an error.
        // bb_curl formats 404 as "Bitbucket API error: HTTP 404" (no JSON body)
        // or "Bitbucket API error: <message>". A repo with the tracker turned
        // off returns a JSON-bodied 404 whose message mentions the issue
        // tracker (e.g. "Repository has no issue tracker") and contains neither
        // "404" nor "not found" — so match that wording too.
        Err(e) => {
            let le = e.to_lowercase();
            if e.contains("404") || le.contains("not found") || le.contains("issue track") {
                return Ok(vec![]);
            }
            return Err(e);
        }
    };
    let values = resp
        .get("values")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    Ok(values.iter().map(bb_issue_to_issue).collect())
}

/// Convert a "Draft: …" Bitbucket PR to ready-for-review by stripping the prefix.
///
/// Bitbucket has no native draft concept — the convention is a "Draft: " title
/// prefix. This command strips it via a PUT update on the PR.
#[tauri::command]
pub(crate) async fn bb_convert_draft_to_ready(cwd: String, pr_id: i64) -> Result<(), String> {
    let (workspace, slug) = parse_workspace_slug(&cwd)?;
    let (username, app_password) = get_bb_creds(&cwd)?;
    let auth_config = basic_auth_config(&username, &app_password);

    // Step 1: get current title.
    let pr_url = format!("{}/pullrequests/{}", repo_api(&workspace, &slug), pr_id);
    let pr = bb_curl("GET", &pr_url, None, &auth_config)?;
    let title = js(&pr, "title");

    // Step 2: strip "Draft: " prefix (case-insensitive).
    let ready_title = if title.to_lowercase().starts_with("draft: ") {
        title[7..].to_string()
    } else if title.to_lowercase().starts_with("draft:") {
        title[6..].trim_start().to_string()
    } else {
        // Already not a draft — nothing to do.
        return Ok(());
    };

    if ready_title.is_empty() {
        return Err("Cannot remove 'Draft:' prefix — resulting title would be empty.".to_string());
    }

    // Step 3: PATCH the title via PUT (Bitbucket uses PUT for PR updates).
    let body = serde_json::json!({ "title": ready_title }).to_string();
    bb_curl("PUT", &pr_url, Some(&body), &auth_config)?;
    Ok(())
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod bb_list_issues_tests {
    use super::{bb_issue_to_issue, bb_urlenc};

    #[test]
    fn urlenc_encodes_biql_query_chars() {
        // The base BIQL query must come out with no raw spaces/quotes/parens,
        // which curl would reject in a positional URL arg.
        let q = r#"(state="new" OR state="open") AND assignee.nickname="al ice""#;
        let enc = bb_urlenc(q);
        assert!(!enc.contains(' '), "spaces must be encoded: {enc}");
        assert!(!enc.contains('"'), "quotes must be encoded: {enc}");
        assert!(!enc.contains('('), "parens must be encoded: {enc}");
        assert_eq!(bb_urlenc("(\"a b\")"), "%28%22a%20b%22%29");
        // Unreserved chars (incl. the dot in assignee.nickname) are preserved.
        assert_eq!(bb_urlenc("assignee.nickname"), "assignee.nickname");
    }

    #[test]
    fn maps_bitbucket_issue_json_to_issue() {
        let v: serde_json::Value = serde_json::from_str(r#"{
            "id": 5, "title": "Broken", "state": "new",
            "reporter": {"nickname": "alice"},
            "assignee": {"nickname": "bob"},
            "created_on": "2026-01-01T00:00:00Z",
            "updated_on": "2026-01-02T00:00:00Z",
            "links": {"html": {"href": "https://bitbucket.org/o/r/issues/5"}}
        }"#).unwrap();
        let i = bb_issue_to_issue(&v);
        assert_eq!(i.number, 5);
        assert_eq!(i.state, "new");
        assert_eq!(i.author, "alice");
        assert_eq!(i.assignees, vec!["bob".to_string()]);
        assert_eq!(i.url, "https://bitbucket.org/o/r/issues/5");
        assert!(i.labels.is_empty());
        assert_eq!(i.milestone, "");
    }
}

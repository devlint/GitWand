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
//! **Security note**: credentials are injected via the `Authorization: Basic`
//! header, which is visible in process arguments. This is acceptable for v2.10
//! (same profile as `gh`/`glab` token propagation). Use stdin piping via
//! `curl --config -` in v2.11 to harden this.

use base64::{Engine as _, engine::general_purpose::STANDARD as B64};
use crate::git::hidden_cmd;
use crate::types::*;

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

/// Build the `Authorization: Basic <base64(user:pass)>` header value.
fn basic_auth_header(username: &str, app_password: &str) -> String {
    let encoded = B64.encode(format!("{}:{}", username, app_password));
    format!("Basic {}", encoded)
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

/// Perform a Bitbucket API call via `curl`.
///
/// - `method`   : "GET", "POST", "PUT", "DELETE"
/// - `url`      : full API URL
/// - `body_json`: optional JSON body as a pre-serialized string
/// - `auth`     : `"Basic <b64>"` header value
///
/// Returns the parsed JSON response on success, or an error string on failure.
fn bb_curl(
    method: &str,
    url: &str,
    body_json: Option<&str>,
    auth: &str,
) -> Result<serde_json::Value, String> {
    let mut args: Vec<String> = vec![
        "-s".to_string(),
        "-X".to_string(), method.to_string(),
        "-H".to_string(), format!("Authorization: {}", auth),
        "-H".to_string(), "Accept: application/json".to_string(),
        "-H".to_string(), "Content-Type: application/json".to_string(),
    ];

    if let Some(body) = body_json {
        args.push("-d".to_string());
        args.push(body.to_string());
    }

    args.push(url.to_string());

    let output = hidden_cmd("curl")
        .args(&args)
        .output()
        .map_err(|e| format!("curl not found or failed to spawn: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    if stdout.trim().is_empty() {
        // DELETE and some PUT calls return no body — success if curl exited 0.
        if output.status.success() {
            return Ok(serde_json::Value::Null);
        }
        return Err(format!(
            "Bitbucket API call failed (no output): {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    let json: serde_json::Value = serde_json::from_str(stdout.trim())
        .map_err(|e| format!("Failed to parse Bitbucket response: {} — raw: {}", e, &stdout[..stdout.len().min(300)]))?;

    // Check for Bitbucket error envelope.
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
pub(crate) fn bb_list_prs(
    cwd: String,
    state: String,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<Vec<PullRequest>, String> {
    let (workspace, slug) = parse_workspace_slug(&cwd)?;
    let (username, app_password) = get_bb_creds(&cwd)?;
    let auth = basic_auth_header(&username, &app_password);

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

    let resp = bb_curl("GET", &url, None, &auth)?;
    let values = resp
        .get("values")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "Unexpected Bitbucket response shape (missing 'values')".to_string())?;

    let mut prs: Vec<PullRequest> = values.iter().map(bb_pr_to_pr).collect();
    if extra > 0 {
        let skip = (extra as usize).min(prs.len());
        prs.drain(..skip);
    }

    Ok(prs)
}

/// Count PRs for a given state.
#[tauri::command]
pub(crate) fn bb_pr_count(cwd: String, state: String) -> Result<i64, String> {
    let (workspace, slug) = parse_workspace_slug(&cwd)?;
    let (username, app_password) = get_bb_creds(&cwd)?;
    let auth = basic_auth_header(&username, &app_password);

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

    let resp = bb_curl("GET", &url, None, &auth).unwrap_or(serde_json::Value::Null);
    Ok(resp.get("size").and_then(|v| v.as_i64()).unwrap_or(0))
}

/// Get detailed PR info.
#[tauri::command]
pub(crate) fn bb_get_pr(cwd: String, pr_id: i64) -> Result<PullRequestDetail, String> {
    let (workspace, slug) = parse_workspace_slug(&cwd)?;
    let (username, app_password) = get_bb_creds(&cwd)?;
    let auth = basic_auth_header(&username, &app_password);

    let url = format!("{}/pullrequests/{}", repo_api(&workspace, &slug), pr_id);
    let resp = bb_curl("GET", &url, None, &auth)?;
    Ok(bb_pr_to_detail(&resp))
}

/// Get the diff of a PR as a unified diff string.
#[tauri::command]
pub(crate) fn bb_pr_diff(cwd: String, pr_id: i64) -> Result<String, String> {
    let (workspace, slug) = parse_workspace_slug(&cwd)?;
    let (username, app_password) = get_bb_creds(&cwd)?;
    let auth = basic_auth_header(&username, &app_password);

    // Bitbucket /diff endpoint returns plain-text unified diff — not JSON.
    let url = format!("{}/pullrequests/{}/diff", repo_api(&workspace, &slug), pr_id);
    let output = hidden_cmd("curl")
        .args([
            "-s",
            "-H", &format!("Authorization: {}", auth),
            &url,
        ])
        .output()
        .map_err(|e| format!("curl diff: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "bb pr diff failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Create a PR via Bitbucket REST API.
///
/// If `source_branch` is empty, the current HEAD branch is resolved via
/// `git rev-parse --abbrev-ref HEAD` (mirrors the `glab mr create` convention).
#[tauri::command]
pub(crate) fn bb_create_pr(
    cwd: String,
    title: String,
    body: String,
    source_branch: String,
    target_branch: String,
    reviewers: Option<Vec<String>>,
) -> Result<PullRequest, String> {
    let (workspace, slug) = parse_workspace_slug(&cwd)?;
    let (username, app_password) = get_bb_creds(&cwd)?;
    let auth = basic_auth_header(&username, &app_password);

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
    let resp = bb_curl("POST", &url, Some(&payload.to_string()), &auth)?;
    Ok(bb_pr_to_pr(&resp))
}

/// Merge a PR via Bitbucket REST API.
///
/// `method` accepts "merge" (default), "squash", "fast_forward".
#[tauri::command]
pub(crate) fn bb_merge_pr(cwd: String, pr_id: i64, method: String) -> Result<(), String> {
    let (workspace, slug) = parse_workspace_slug(&cwd)?;
    let (username, app_password) = get_bb_creds(&cwd)?;
    let auth = basic_auth_header(&username, &app_password);

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
    bb_curl("POST", &url, Some(&payload.to_string()), &auth)?;
    Ok(())
}

/// Checkout a PR branch locally using git fetch + switch.
///
/// Bitbucket doesn't have a `bb pr checkout` CLI, so we:
/// 1. Fetch the source branch from origin
/// 2. Switch to it (create tracking branch if needed)
#[tauri::command]
pub(crate) fn bb_checkout_pr(cwd: String, pr_id: i64) -> Result<(), String> {
    let (workspace, slug) = parse_workspace_slug(&cwd)?;
    let (username, app_password) = get_bb_creds(&cwd)?;
    let auth = basic_auth_header(&username, &app_password);

    // Fetch PR detail to get the source branch name.
    let url = format!("{}/pullrequests/{}", repo_api(&workspace, &slug), pr_id);
    let pr = bb_curl("GET", &url, None, &auth)?;
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
pub(crate) fn bb_pr_comments(cwd: String, pr_id: i64) -> Result<serde_json::Value, String> {
    let (workspace, slug) = parse_workspace_slug(&cwd)?;
    let (username, app_password) = get_bb_creds(&cwd)?;
    let auth = basic_auth_header(&username, &app_password);

    let url = format!(
        "{}/pullrequests/{}/comments?pagelen=100",
        repo_api(&workspace, &slug),
        pr_id
    );
    let resp = bb_curl("GET", &url, None, &auth)?;
    Ok(resp.get("values").cloned().unwrap_or(serde_json::Value::Array(vec![])))
}

/// Create a comment on a PR.
#[tauri::command]
pub(crate) fn bb_create_comment(
    cwd: String,
    pr_id: i64,
    body: String,
) -> Result<serde_json::Value, String> {
    let (workspace, slug) = parse_workspace_slug(&cwd)?;
    let (username, app_password) = get_bb_creds(&cwd)?;
    let auth = basic_auth_header(&username, &app_password);

    let payload = serde_json::json!({ "content": { "raw": body } });
    let url = format!(
        "{}/pullrequests/{}/comments",
        repo_api(&workspace, &slug),
        pr_id
    );
    bb_curl("POST", &url, Some(&payload.to_string()), &auth)
}

/// Update a comment on a PR.
#[tauri::command]
pub(crate) fn bb_update_comment(
    cwd: String,
    pr_id: i64,
    comment_id: i64,
    body: String,
) -> Result<(), String> {
    let (workspace, slug) = parse_workspace_slug(&cwd)?;
    let (username, app_password) = get_bb_creds(&cwd)?;
    let auth = basic_auth_header(&username, &app_password);

    let payload = serde_json::json!({ "content": { "raw": body } });
    let url = format!(
        "{}/pullrequests/{}/comments/{}",
        repo_api(&workspace, &slug),
        pr_id,
        comment_id
    );
    bb_curl("PUT", &url, Some(&payload.to_string()), &auth)?;
    Ok(())
}

/// Delete a comment on a PR.
#[tauri::command]
pub(crate) fn bb_delete_comment(
    cwd: String,
    pr_id: i64,
    comment_id: i64,
) -> Result<(), String> {
    let (workspace, slug) = parse_workspace_slug(&cwd)?;
    let (username, app_password) = get_bb_creds(&cwd)?;
    let auth = basic_auth_header(&username, &app_password);

    let url = format!(
        "{}/pullrequests/{}/comments/{}",
        repo_api(&workspace, &slug),
        pr_id,
        comment_id
    );
    bb_curl("DELETE", &url, None, &auth)?;
    Ok(())
}

/// Approve a PR (current user).
#[tauri::command]
pub(crate) fn bb_approve_pr(cwd: String, pr_id: i64) -> Result<(), String> {
    let (workspace, slug) = parse_workspace_slug(&cwd)?;
    let (username, app_password) = get_bb_creds(&cwd)?;
    let auth = basic_auth_header(&username, &app_password);

    let url = format!(
        "{}/pullrequests/{}/approve",
        repo_api(&workspace, &slug),
        pr_id
    );
    bb_curl("POST", &url, None, &auth)?;
    Ok(())
}

/// List files changed in a PR.
#[tauri::command]
pub(crate) fn bb_pr_files(cwd: String, pr_id: i64) -> Result<Vec<String>, String> {
    let (workspace, slug) = parse_workspace_slug(&cwd)?;
    let (username, app_password) = get_bb_creds(&cwd)?;
    let auth = basic_auth_header(&username, &app_password);

    let url = format!(
        "{}/pullrequests/{}/diffstat",
        repo_api(&workspace, &slug),
        pr_id
    );
    let resp = bb_curl("GET", &url, None, &auth)?;
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
pub(crate) fn bb_current_user(cwd: String) -> Result<String, String> {
    let (username, app_password) = get_bb_creds(&cwd)?;
    let auth = basic_auth_header(&username, &app_password);

    let resp = bb_curl("GET", "https://api.bitbucket.org/2.0/user", None, &auth)?;
    Ok(resp
        .get("nickname")
        .or_else(|| resp.get("display_name"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string())
}

/// List reviewer candidates (repo members with write access).
#[tauri::command]
pub(crate) fn bb_reviewer_candidates(cwd: String) -> Result<Vec<ReviewerCandidate>, String> {
    let (workspace, slug) = parse_workspace_slug(&cwd)?;
    let (username, app_password) = get_bb_creds(&cwd)?;
    let auth = basic_auth_header(&username, &app_password);

    let url = format!(
        "https://api.bitbucket.org/2.0/repositories/{}/{}/permissions-config/users",
        workspace, slug
    );
    let resp = bb_curl("GET", &url, None, &auth)
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

/// Get CI status checks for a PR via Bitbucket Pipelines commit statuses endpoint.
///
/// Endpoint: GET /2.0/repositories/{ws}/{slug}/commit/{sha}/statuses
/// The head commit SHA is read from the PR's `source.commit.hash` field.
#[tauri::command]
pub(crate) fn bb_pr_ci_checks(cwd: String, pr_id: i64) -> Result<Vec<CICheck>, String> {
    let (workspace, slug) = parse_workspace_slug(&cwd)?;
    let (username, app_password) = get_bb_creds(&cwd)?;
    let auth = basic_auth_header(&username, &app_password);

    // Step 1: get the PR to find the head commit SHA.
    let pr_url = format!("{}/pullrequests/{}", repo_api(&workspace, &slug), pr_id);
    let pr = bb_curl("GET", &pr_url, None, &auth)?;
    let head_sha = jdeep(&pr, "source", "commit", "hash");
    if head_sha.is_empty() {
        return Ok(Vec::new());
    }

    // Step 2: fetch commit statuses.
    let url = format!(
        "https://api.bitbucket.org/2.0/repositories/{}/{}/commit/{}/statuses?pagelen=30",
        workspace, slug, head_sha
    );
    let resp = bb_curl("GET", &url, None, &auth).unwrap_or(serde_json::Value::Null);
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
                status,
                conclusion,
                url: {
                    let u = jnested(s, "url", "href");
                    if u.is_empty() { js(s, "url") } else { u }
                },
            }
        })
        .collect();

    Ok(checks)
}

/// Convert a "Draft: …" Bitbucket PR to ready-for-review by stripping the prefix.
///
/// Bitbucket has no native draft concept — the convention is a "Draft: " title
/// prefix. This command strips it via a PUT update on the PR.
#[tauri::command]
pub(crate) fn bb_convert_draft_to_ready(cwd: String, pr_id: i64) -> Result<(), String> {
    let (workspace, slug) = parse_workspace_slug(&cwd)?;
    let (username, app_password) = get_bb_creds(&cwd)?;
    let auth = basic_auth_header(&username, &app_password);

    // Step 1: get current title.
    let pr_url = format!("{}/pullrequests/{}", repo_api(&workspace, &slug), pr_id);
    let pr = bb_curl("GET", &pr_url, None, &auth)?;
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
    bb_curl("PUT", &pr_url, Some(&body), &auth)?;
    Ok(())
}

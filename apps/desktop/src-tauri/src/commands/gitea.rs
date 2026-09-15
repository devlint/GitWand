//! Gitea / Forgejo REST v1 Tauri commands.
//!
//! ## Why this module looks different from its neighbours
//!
//! Every other forge module has a constant API base (`api.bitbucket.org`,
//! `dev.azure.com`). Gitea has none: it is self-hosted, so the host comes from
//! the account the user configured in Settings > Accounts and is resolved per
//! call from `GiteaCtx`.
//!
//! ## Auth
//!
//! Personal access token, stored as:
//!   service = "gitwand:gitea"
//!   account = "<host>:<username>"
//!   value   = "<token>"
//!
//! The token is injected through `curl --config -` (stdin) as
//! `Authorization: token <pat>`, Gitea's documented scheme. It never reaches
//! argv, a log line, or the frontend.

use super::curl_util::{auth_header_config, curl_with_status};
use crate::git::{hidden_cmd, parse_remote_owner_repo};
use crate::types::*;

/// Keychain service for a Settings-managed Gitea token.
pub(crate) const GITEA_SERVICE: &str = "gitwand:gitea";

/// Everything a Gitea call needs: where the server is, which repo, and how to
/// authenticate. Resolved once per command from `cwd`.
pub(crate) struct GiteaCtx {
    pub base: String,
    pub owner: String,
    pub repo: String,
    pub auth: String,
}

impl GiteaCtx {
    /// `https://<host>/api/v1/repos/<owner>/<repo>`
    fn repo_api(&self) -> String {
        format!("{}/api/v1/repos/{}/{}", self.base, self.owner, self.repo)
    }
}

/// Normalise a user-entered server URL to an origin (plus any subpath).
///
/// Adds `https://` when no scheme is present, then strips a trailing slash and
/// a trailing `/api/v1`, which users paste surprisingly often.
fn normalize_base_url(raw: &str) -> String {
    let trimmed = raw.trim();
    let with_scheme = if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        trimmed.to_string()
    } else {
        format!("https://{}", trimmed)
    };
    let mut out = with_scheme.trim_end_matches('/').to_string();
    if let Some(stripped) = out.strip_suffix("/api/v1") {
        out = stripped.trim_end_matches('/').to_string();
    }
    out
}

/// Extract `host[:port]` from a git remote URL, keeping an explicit port.
///
/// `crate::git::extract_remote_host` deliberately returns a bare host (its
/// other caller, the `gh`/`glab auth status --hostname` probe from issue
/// #168, wants exactly that), so it drops a custom port such as
/// `ssh://git@forge.internal:2222/...`. Self-hosted Gitea commonly listens on
/// a non-default port (the stock Docker image uses `:3000`), so the API base
/// URL needs the port kept. This is local to `gitea.rs` on purpose: it is not
/// a fix to `extract_remote_host`, which stays a bare-host helper.
///
/// The SCP-like form (`git@host:owner/repo.git`) never carries a port: the
/// text after the colon there is the path, not a port, so that branch always
/// returns a bare host.
fn remote_host_port(url: &str) -> Option<String> {
    if let Some(rest) = url.strip_prefix("git@") {
        let host = rest.split(':').next()?;
        return (!host.is_empty()).then(|| host.to_string());
    }
    let host_start = url.find("://")? + 3;
    let rest = &url[host_start..];
    let rest = rest
        .rsplit_once('@')
        .map_or(rest, |(_, host_part)| host_part);
    let host_port = rest.split('/').next()?;
    (!host_port.is_empty()).then(|| host_port.to_string())
}

/// Read the origin remote URL of `cwd`.
fn origin_url(cwd: &str) -> Result<String, String> {
    let output = hidden_cmd("git")
        .args(["remote", "get-url", "origin"])
        .current_dir(cwd)
        .output()
        .map_err(|e| format!("git remote get-url: {}", e))?;
    if !output.status.success() {
        return Err("No 'origin' remote found in this repo.".to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Resolve the Gitea context for a repo: host from the remote, owner/repo from
/// the remote, token from the keychain entry whose account key starts with that
/// host.
fn gitea_ctx(cwd: &str) -> Result<GiteaCtx, String> {
    let url = origin_url(cwd)?;
    let host = crate::git::extract_remote_host(&url)
        .ok_or_else(|| format!("Could not read a host from the remote URL: {}", url))?;
    let (owner, repo) = parse_remote_owner_repo(&url);
    if owner.is_empty() || repo.is_empty() {
        return Err(format!("Could not read owner/repo from the remote URL: {}", url));
    }
    let token = gitea_token_for_host(&host)?;
    // The keychain key stays the bare host (matches the frontend's account
    // detection), but the API base URL needs the port when the remote has one.
    let host_port = remote_host_port(&url).unwrap_or_else(|| host.clone());
    Ok(GiteaCtx {
        base: normalize_base_url(&host_port),
        owner,
        repo,
        auth: auth_header_config("token", &token),
    })
}

/// Look up the stored token for `host`.
///
/// The keychain account key is `"<host>:<username>"`, and the username is not
/// known here, so the frontend stores a second entry keyed by host alone
/// pointing at the active username (see `backend-gitea.ts`). This reads that
/// pointer, then the token itself.
fn gitea_token_for_host(host: &str) -> Result<String, String> {
    let pointer = keyring::Entry::new(GITEA_SERVICE, host)
        .map_err(|e| format!("keyring: {}", e))?
        .get_password()
        .map_err(|_| {
            format!(
                "No Gitea account configured for {host}. \
                 Add one in Settings > Accounts."
            )
        })?;
    // The pointer holds the active username for this host.
    keyring::Entry::new(GITEA_SERVICE, &format!("{}:{}", host, pointer))
        .map_err(|e| format!("keyring: {}", e))?
        .get_password()
        .map_err(|_| {
            format!(
                "Gitea credential for {host} is missing or unreadable. \
                 Re-add the account in Settings > Accounts."
            )
        })
}

// ─── HTTP transport ─────────────────────────────────────────────────────────

fn gitea_curl_raw(
    method: &str,
    url: &str,
    body: Option<&str>,
    auth: &str,
    accept: &str,
) -> Result<(i32, String), String> {
    curl_with_status(method, url, Some(auth), body, &[], accept)
}

/// JSON call. HTTP >= 400 maps to an error, preferring Gitea's `message` field.
/// An empty body (DELETE) returns `Null`.
fn gitea_curl(
    method: &str,
    url: &str,
    body: Option<&str>,
    auth: &str,
) -> Result<serde_json::Value, String> {
    let (status, text) = gitea_curl_raw(method, url, body, auth, "application/json")?;
    if status >= 400 {
        let msg = serde_json::from_str::<serde_json::Value>(text.trim())
            .ok()
            .and_then(|v| v.get("message").and_then(|m| m.as_str()).map(String::from))
            .unwrap_or_else(|| format!("HTTP {}", status));
        return Err(format!("Gitea API error: {}", msg));
    }
    if text.trim().is_empty() {
        return Ok(serde_json::Value::Null);
    }
    serde_json::from_str(text.trim()).map_err(|e| {
        format!(
            "Failed to parse Gitea response: {} (raw: {})",
            e,
            &text[..text.len().min(300)]
        )
    })
}

// ─── Commands ───────────────────────────────────────────────────────────────

/// Login of the authenticated user on the server behind this repo's remote.
#[tauri::command]
pub(crate) async fn gitea_current_user(cwd: String) -> Result<String, String> {
    let ctx = gitea_ctx(&cwd)?;
    let v = gitea_curl("GET", &format!("{}/api/v1/user", ctx.base), None, &ctx.auth)?;
    Ok(v.get("login")
        .and_then(|s| s.as_str())
        .unwrap_or("")
        .to_string())
}

/// Validate a host/token pair before the account is saved, returning the login.
///
/// Takes the token directly rather than reading the keychain: at call time
/// nothing is stored yet. Same IPC exposure as `set_credential`, which already
/// carries the secret once on the way to the keychain.
#[tauri::command]
pub(crate) async fn gitea_validate_token(host: String, token: String) -> Result<String, String> {
    let base = normalize_base_url(&host);
    let auth = auth_header_config("token", &token);
    let v = gitea_curl("GET", &format!("{}/api/v1/user", base), None, &auth)?;
    let login = v.get("login").and_then(|s| s.as_str()).unwrap_or("");
    if login.is_empty() {
        return Err("The server answered without a login. Check the URL points at a Gitea or Forgejo instance.".to_string());
    }
    Ok(login.to_string())
}

// ─── JSON helpers ───────────────────────────────────────────────────────────

fn jstr(v: &serde_json::Value, key: &str) -> String {
    v.get(key).and_then(|s| s.as_str()).unwrap_or("").to_string()
}

fn jnum(v: &serde_json::Value, key: &str) -> i64 {
    v.get(key).and_then(|n| n.as_i64()).unwrap_or(0)
}

fn jlogin(v: &serde_json::Value, key: &str) -> String {
    v.get(key)
        .and_then(|u| u.get("login"))
        .and_then(|s| s.as_str())
        .unwrap_or("")
        .to_string()
}

/// Collect `login` from an array of users, or `name` from an array of labels.
fn jnames(v: &serde_json::Value, key: &str, field: &str) -> Vec<String> {
    v.get(key)
        .and_then(|a| a.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|e| e.get(field).and_then(|s| s.as_str()).map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

/// `head.ref` / `base.ref` style lookups.
fn jref(v: &serde_json::Value, side: &str, leaf: &str) -> String {
    v.get(side)
        .and_then(|s| s.get(leaf))
        .and_then(|s| s.as_str())
        .unwrap_or("")
        .to_string()
}

/// Gitea's `mergeable` is a boolean; our contract is a string, with "" for
/// unknown so the UI never disables merge on a missing field.
fn mergeable_str(v: &serde_json::Value) -> String {
    match v.get("mergeable").and_then(|m| m.as_bool()) {
        Some(true) => "MERGEABLE".to_string(),
        Some(false) => "CONFLICTING".to_string(),
        None => String::new(),
    }
}

fn map_pr(v: &serde_json::Value) -> PullRequest {
    PullRequest {
        // `number` is the per-repo index. `id` is a global database id and
        // addressing a PR by it hits the wrong resource.
        number: jnum(v, "number"),
        title: jstr(v, "title"),
        state: jstr(v, "state"),
        author: jlogin(v, "user"),
        branch: jref(v, "head", "ref"),
        base: jref(v, "base", "ref"),
        draft: v.get("draft").and_then(|d| d.as_bool()).unwrap_or(false),
        created_at: jstr(v, "created_at"),
        updated_at: jstr(v, "updated_at"),
        url: jstr(v, "html_url"),
        additions: jnum(v, "additions"),
        deletions: jnum(v, "deletions"),
        labels: jnames(v, "labels", "name"),
        assignees: jnames(v, "assignees", "login"),
        review_requested: jnames(v, "requested_reviewers", "login"),
        review_decision: String::new(),
        merge_state_status: String::new(),
        checks_rollup: String::new(),
        auto_merge: AutoMergeState::default(),
        comment_count: jnum(v, "comments"),
    }
}

fn map_pr_detail(v: &serde_json::Value) -> PullRequestDetail {
    PullRequestDetail {
        number: jnum(v, "number"),
        title: jstr(v, "title"),
        body: jstr(v, "body"),
        state: jstr(v, "state"),
        author: jlogin(v, "user"),
        branch: jref(v, "head", "ref"),
        base: jref(v, "base", "ref"),
        draft: v.get("draft").and_then(|d| d.as_bool()).unwrap_or(false),
        created_at: jstr(v, "created_at"),
        updated_at: jstr(v, "updated_at"),
        merged_at: jstr(v, "merged_at"),
        url: jstr(v, "html_url"),
        additions: jnum(v, "additions"),
        deletions: jnum(v, "deletions"),
        changed_files: jnum(v, "changed_files"),
        comments: jnum(v, "comments"),
        review_comments: 0,
        labels: jnames(v, "labels", "name"),
        reviewers: jnames(v, "requested_reviewers", "login"),
        mergeable: mergeable_str(v),
        checks_status: String::new(),
        // Gitea exposes no cheap per-viewer merge permission here. `None` means
        // unknown, which the UI must read as "allowed, gate on errors".
        can_merge: None,
        head_sha: jref(v, "head", "sha"),
        auto_merge: AutoMergeState::default(),
        auto_merge_support: gitea_auto_merge_support(),
    }
}

/// Gitea does support `merge_when_checks_succeed`, but wiring it is a follow-up
/// (see the spec, section 2). Report it unsupported and say what still works,
/// following the Bitbucket precedent.
fn gitea_auto_merge_support() -> AutoMergeSupport {
    AutoMergeSupport {
        supported: false,
        reason: Some(
            "GitWand does not queue auto-merge on Gitea yet. Merging immediately still works."
                .to_string(),
        ),
    }
}

fn map_status(v: &serde_json::Value) -> Vec<CICheck> {
    v.get("statuses")
        .and_then(|a| a.as_array())
        .map(|arr| {
            arr.iter()
                .map(|s| CICheck {
                    name: jstr(s, "context"),
                    state: jstr(s, "status"),
                    conclusion: jstr(s, "status"),
                    details_url: jstr(s, "target_url"),
                })
                .collect()
        })
        .unwrap_or_default()
}

// ─── Commands ───────────────────────────────────────────────────────────────

/// Gitea states: `open`, `closed`, `all`. Anything else reads as `open`.
fn gitea_state(state: &str) -> &'static str {
    match state.to_lowercase().as_str() {
        "closed" | "merged" => "closed",
        "all" => "all",
        _ => "open",
    }
}

/// Fixed server page size for the paging loops below. Deliberately not tied
/// to the caller's requested `limit`/window: Gitea caps the `limit` query
/// param at `MAX_RESPONSE_ITEMS` (50 by default, admin-lowerable), so asking
/// for a bigger page in one shot risks silent truncation on a server with a
/// lowered cap. Paging in fixed steps of the default cap and windowing
/// client-side never hits that ceiling.
const GITEA_PAGE_SIZE: i64 = 50;

/// PR-prefetch ceiling already used elsewhere in this codebase, reused here
/// as the count cap. Gitea's exact total lives in the `X-Total-Count`
/// response header, which `curl_with_status` does not capture (a
/// transport-level change that would touch every forge, out of scope for
/// this fix). Above this ceiling `gitea_pr_count` under-reports rather than
/// paging without bound.
const GITEA_COUNT_CEILING: i64 = 300;

/// Ceiling for the paging loops below that have no caller-supplied `limit`:
/// PR comments, PR reviews, reviewer candidates (collaborators), and branches.
/// Without a bound, a server that never returns an empty page (a bug, or a
/// hostile deployment) would page forever. This is generous enough to cover
/// every realistic PR conversation, review list, collaborator roster, or
/// branch list, while still guaranteeing the loop terminates.
const GITEA_LIST_CEILING: i64 = 300;

/// Page through a Gitea list endpoint in fixed `GITEA_PAGE_SIZE` steps,
/// accumulating up to `want` items. `url_for_page` builds the request URL for
/// a given 1-based page number. See `needs_another_page` for the stop
/// condition: a short but non-empty page (a lowered server cap) keeps paging
/// rather than being read as the end.
fn gitea_page_all(
    ctx: &GiteaCtx,
    want: usize,
    url_for_page: impl Fn(i64) -> String,
) -> Result<Vec<serde_json::Value>, String> {
    let mut collected: Vec<serde_json::Value> = Vec::new();
    let mut page = 1;
    loop {
        let resp = gitea_curl("GET", &url_for_page(page), None, &ctx.auth)?;
        let arr = resp.as_array().cloned().unwrap_or_default();
        let page_len = arr.len();
        collected.extend(arr);
        if !needs_another_page(collected.len(), want, page_len) {
            break;
        }
        page += 1;
    }
    Ok(collected)
}

/// Slice a client-side accumulated result set down to the caller's requested
/// window. `offset`/`per_page` are already clamped by the command before this
/// is called, but a helper this cheap to misuse gets its own guard rather
/// than trusting every future caller: a negative offset reads as zero, and a
/// non-positive `per_page` yields an empty window instead of panicking or
/// wrapping.
fn select_window(
    items: Vec<serde_json::Value>,
    offset: i64,
    per_page: i64,
) -> Vec<serde_json::Value> {
    if per_page <= 0 {
        return Vec::new();
    }
    let off = offset.max(0) as usize;
    items.into_iter().skip(off).take(per_page as usize).collect()
}

/// Whether a paging loop should fetch one more page, given how many items
/// have been collected so far (`collected`), how many are wanted (`want`),
/// and the length of the page that was just fetched (`last_page_len`).
///
/// An empty page is the only reliable end-of-results signal: a server with a
/// lowered `MAX_RESPONSE_ITEMS` returns pages shorter than `GITEA_PAGE_SIZE`
/// on every request, which must not be read as "no more results" while there
/// are still more to want.
fn needs_another_page(collected: usize, want: usize, last_page_len: usize) -> bool {
    if last_page_len == 0 {
        return false;
    }
    collected < want
}

#[tauri::command]
pub(crate) async fn gitea_list_prs(
    cwd: String,
    state: String,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<Vec<PullRequest>, String> {
    let ctx = gitea_ctx(&cwd)?;
    let per_page = limit.unwrap_or(10).max(1);
    let off = offset.unwrap_or(0).max(0);
    let want = (off + per_page) as usize;

    // Page from the start in fixed server pages, accumulating results, and
    // window the accumulated list client-side. See `select_window` and
    // `needs_another_page` for why: inflating the requested `limit` to reach
    // the offset in one request silently truncates on a server with a
    // lowered response cap.
    let mut collected: Vec<serde_json::Value> = Vec::new();
    let mut page = 1;
    loop {
        let url = format!(
            "{}/pulls?state={}&limit={}&page={}",
            ctx.repo_api(),
            gitea_state(&state),
            GITEA_PAGE_SIZE,
            page
        );
        let resp = gitea_curl("GET", &url, None, &ctx.auth)?;
        let arr = resp.as_array().cloned().unwrap_or_default();
        let page_len = arr.len();
        collected.extend(arr);
        if !needs_another_page(collected.len(), want, page_len) {
            break;
        }
        page += 1;
    }

    Ok(select_window(collected, off, per_page)
        .iter()
        .map(map_pr)
        .collect())
}

#[tauri::command]
pub(crate) async fn gitea_pr_count(cwd: String, state: String) -> Result<i64, String> {
    let ctx = match gitea_ctx(&cwd) {
        Ok(c) => c,
        Err(_) => return Ok(0),
    };
    let want = GITEA_COUNT_CEILING as usize;
    let mut collected: usize = 0;
    let mut page = 1;
    loop {
        let url = format!(
            "{}/pulls?state={}&limit={}&page={}",
            ctx.repo_api(),
            gitea_state(&state),
            GITEA_PAGE_SIZE,
            page
        );
        let resp = gitea_curl("GET", &url, None, &ctx.auth).unwrap_or(serde_json::Value::Null);
        let page_len = resp.as_array().map(|a| a.len()).unwrap_or(0);
        collected += page_len;
        if !needs_another_page(collected, want, page_len) {
            break;
        }
        page += 1;
    }
    Ok(collected.min(want) as i64)
}

#[tauri::command]
pub(crate) async fn gitea_get_pr(cwd: String, index: i64) -> Result<PullRequestDetail, String> {
    let ctx = gitea_ctx(&cwd)?;
    let url = format!("{}/pulls/{}", ctx.repo_api(), index);
    let resp = gitea_curl("GET", &url, None, &ctx.auth)?;
    let mut detail = map_pr_detail(&resp);
    if !detail.head_sha.is_empty() {
        let status_url = format!("{}/commits/{}/status", ctx.repo_api(), detail.head_sha);
        if let Ok(s) = gitea_curl("GET", &status_url, None, &ctx.auth) {
            detail.checks_status = jstr(&s, "state");
        }
    }
    Ok(detail)
}

/// Unified diff. `/pulls/{index}.diff` is the documented suffix form; some
/// deployments only answer `/pulls/{index}/patch`, so fall back to it rather
/// than surfacing a 404 as "no diff".
#[tauri::command]
pub(crate) async fn gitea_pr_diff(cwd: String, index: i64) -> Result<String, String> {
    let ctx = gitea_ctx(&cwd)?;
    let primary = format!("{}/pulls/{}.diff", ctx.repo_api(), index);
    let (status, body) = gitea_curl_raw("GET", &primary, None, &ctx.auth, "*/*")?;
    if status < 400 {
        return Ok(body);
    }
    let fallback = format!("{}/pulls/{}/patch", ctx.repo_api(), index);
    let (status2, body2) = gitea_curl_raw("GET", &fallback, None, &ctx.auth, "*/*")?;
    if status2 >= 400 {
        return Err(format!(
            "Gitea diff failed (HTTP {} on .diff, HTTP {} on /patch)",
            status, status2
        ));
    }
    Ok(body2)
}

#[tauri::command]
pub(crate) async fn gitea_pr_status(cwd: String, index: i64) -> Result<Vec<CICheck>, String> {
    let ctx = gitea_ctx(&cwd)?;
    let pr = gitea_curl("GET", &format!("{}/pulls/{}", ctx.repo_api(), index), None, &ctx.auth)?;
    let sha = jref(&pr, "head", "sha");
    if sha.is_empty() {
        return Ok(Vec::new());
    }
    let url = format!("{}/commits/{}/status", ctx.repo_api(), sha);
    let resp = gitea_curl("GET", &url, None, &ctx.auth)?;
    Ok(map_status(&resp))
}

#[tauri::command]
pub(crate) async fn gitea_pr_files(cwd: String, index: i64) -> Result<Vec<String>, String> {
    let ctx = gitea_ctx(&cwd)?;
    let url = format!("{}/pulls/{}/files?limit=100", ctx.repo_api(), index);
    let resp = gitea_curl("GET", &url, None, &ctx.auth)?;
    Ok(resp
        .as_array()
        .map(|arr| arr.iter().map(|f| jstr(f, "filename")).collect())
        .unwrap_or_default())
}

/// Shape a Gitea issue comment into the frontend's `PrReviewComment`.
///
/// Gitea's issue-comment endpoint carries no diff anchor, so `path` is empty
/// and `line` is null. `usePrPanel` reads that as "conversation comment" and
/// keeps the inline-comment affordances hidden.
fn map_comment(v: &serde_json::Value) -> serde_json::Value {
    serde_json::json!({
        "id": jnum(v, "id"),
        "body": jstr(v, "body"),
        "author": jlogin(v, "user"),
        "created_at": jstr(v, "created_at"),
        "updated_at": jstr(v, "updated_at"),
        "path": "",
        "line": serde_json::Value::Null,
        "original_line": serde_json::Value::Null,
        "side": "RIGHT",
        "start_line": serde_json::Value::Null,
        "start_side": serde_json::Value::Null,
        "in_reply_to_id": serde_json::Value::Null,
        "diff_hunk": "",
        "url": jstr(v, "html_url"),
    })
}

/// Gitea review states are `APPROVED`, `REQUEST_CHANGES`, `COMMENT`, `PENDING`.
/// The shared vocabulary uses `CHANGES_REQUESTED` and `COMMENTED`.
fn map_review(v: &serde_json::Value) -> serde_json::Value {
    let state = match jstr(v, "state").to_uppercase().as_str() {
        "APPROVED" => "APPROVED",
        "REQUEST_CHANGES" | "REQUEST_REVIEW" => "CHANGES_REQUESTED",
        "COMMENT" => "COMMENTED",
        "PENDING" => "PENDING",
        other if !other.is_empty() => "COMMENTED",
        _ => "",
    };
    serde_json::json!({
        "id": jnum(v, "id"),
        "state": state,
        "body": jstr(v, "body"),
        "user": { "login": jlogin(v, "user"), "avatar_url": "" },
        "submitted_at": jstr(v, "submitted_at"),
        "html_url": jstr(v, "html_url"),
    })
}

fn map_issue(v: &serde_json::Value) -> Issue {
    Issue {
        number: jnum(v, "number"),
        title: jstr(v, "title"),
        state: jstr(v, "state"),
        author: jlogin(v, "user"),
        assignees: jnames(v, "assignees", "login"),
        labels: jnames(v, "labels", "name"),
        url: jstr(v, "html_url"),
        created_at: jstr(v, "created_at"),
        updated_at: jstr(v, "updated_at"),
        milestone: v
            .get("milestone")
            .and_then(|m| m.get("title"))
            .and_then(|s| s.as_str())
            .unwrap_or("")
            .to_string(),
    }
}

#[tauri::command]
pub(crate) async fn gitea_pr_comments(
    cwd: String,
    index: i64,
) -> Result<Vec<serde_json::Value>, String> {
    let ctx = gitea_ctx(&cwd)?;
    let want = GITEA_LIST_CEILING as usize;
    let collected = gitea_page_all(&ctx, want, |page| {
        format!(
            "{}/issues/{}/comments?limit={}&page={}",
            ctx.repo_api(),
            index,
            GITEA_PAGE_SIZE,
            page
        )
    })?;
    Ok(select_window(collected, 0, want as i64)
        .iter()
        .map(map_comment)
        .collect())
}

#[tauri::command]
pub(crate) async fn gitea_create_comment(
    cwd: String,
    index: i64,
    body: String,
) -> Result<serde_json::Value, String> {
    let ctx = gitea_ctx(&cwd)?;
    let url = format!("{}/issues/{}/comments", ctx.repo_api(), index);
    let payload = serde_json::json!({ "body": body }).to_string();
    let resp = gitea_curl("POST", &url, Some(&payload), &ctx.auth)?;
    Ok(map_comment(&resp))
}

#[tauri::command]
pub(crate) async fn gitea_update_comment(
    cwd: String,
    comment_id: i64,
    body: String,
) -> Result<(), String> {
    let ctx = gitea_ctx(&cwd)?;
    let url = format!("{}/issues/comments/{}", ctx.repo_api(), comment_id);
    let payload = serde_json::json!({ "body": body }).to_string();
    gitea_curl("PATCH", &url, Some(&payload), &ctx.auth)?;
    Ok(())
}

#[tauri::command]
pub(crate) async fn gitea_delete_comment(cwd: String, comment_id: i64) -> Result<(), String> {
    let ctx = gitea_ctx(&cwd)?;
    let url = format!("{}/issues/comments/{}", ctx.repo_api(), comment_id);
    gitea_curl("DELETE", &url, None, &ctx.auth)?;
    Ok(())
}

#[tauri::command]
pub(crate) async fn gitea_list_reviews(
    cwd: String,
    index: i64,
) -> Result<Vec<serde_json::Value>, String> {
    let ctx = gitea_ctx(&cwd)?;
    let want = GITEA_LIST_CEILING as usize;
    let collected = gitea_page_all(&ctx, want, |page| {
        format!(
            "{}/pulls/{}/reviews?limit={}&page={}",
            ctx.repo_api(),
            index,
            GITEA_PAGE_SIZE,
            page
        )
    })?;
    Ok(select_window(collected, 0, want as i64)
        .iter()
        .map(map_review)
        .collect())
}

#[tauri::command]
pub(crate) async fn gitea_list_issues(
    cwd: String,
    limit: Option<i64>,
) -> Result<Vec<Issue>, String> {
    let ctx = gitea_ctx(&cwd)?;
    let want = limit.unwrap_or(30).max(1) as usize;
    // `type=issues` keeps PRs out: Gitea's issue endpoint returns both.
    let collected = gitea_page_all(&ctx, want, |page| {
        format!(
            "{}/issues?state=open&type=issues&limit={}&page={}",
            ctx.repo_api(),
            GITEA_PAGE_SIZE,
            page
        )
    })?;
    Ok(select_window(collected, 0, want as i64)
        .iter()
        .map(map_issue)
        .collect())
}

#[tauri::command]
pub(crate) async fn gitea_reviewer_candidates(
    cwd: String,
) -> Result<Vec<ReviewerCandidate>, String> {
    let ctx = gitea_ctx(&cwd)?;
    let want = GITEA_LIST_CEILING as usize;
    let collected = gitea_page_all(&ctx, want, |page| {
        format!(
            "{}/collaborators?limit={}&page={}",
            ctx.repo_api(),
            GITEA_PAGE_SIZE,
            page
        )
    })?;
    Ok(select_window(collected, 0, want as i64)
        .iter()
        .map(|u| ReviewerCandidate {
            login: jstr(u, "login"),
            name: Some(jstr(u, "full_name")).filter(|s| !s.is_empty()),
            avatar_url: Some(jstr(u, "avatar_url")).filter(|s| !s.is_empty()),
        })
        .collect())
}

/// Build the merge request body. `use_legacy_field` swaps `merge_method` for
/// `Do`, which older Gitea versions require.
fn merge_payload(method: &str, use_legacy_field: bool) -> String {
    let m = match method {
        "squash" => "squash",
        "rebase" => "rebase",
        _ => "merge",
    };
    let body = if use_legacy_field {
        serde_json::json!({ "Do": m })
    } else {
        serde_json::json!({ "merge_method": m })
    };
    body.to_string()
}

#[tauri::command]
pub(crate) async fn gitea_create_pr(
    cwd: String,
    title: String,
    body: String,
    source_branch: String,
    target_branch: String,
) -> Result<PullRequest, String> {
    let ctx = gitea_ctx(&cwd)?;
    let head = if source_branch.is_empty() {
        let out = hidden_cmd("git")
            .args(["rev-parse", "--abbrev-ref", "HEAD"])
            .current_dir(&cwd)
            .output()
            .map_err(|e| format!("git rev-parse: {}", e))?;
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    } else {
        source_branch
    };
    if head.is_empty() {
        return Err("Could not resolve the source branch.".to_string());
    }
    let base = if target_branch.is_empty() {
        "main".to_string()
    } else {
        target_branch
    };
    let payload = serde_json::json!({
        "title": title,
        "body": body,
        "head": head,
        "base": base,
    })
    .to_string();
    let resp = gitea_curl("POST", &format!("{}/pulls", ctx.repo_api()), Some(&payload), &ctx.auth)?;
    Ok(map_pr(&resp))
}

#[tauri::command]
pub(crate) async fn gitea_merge_pr(
    cwd: String,
    index: i64,
    method: Option<String>,
) -> Result<(), String> {
    let ctx = gitea_ctx(&cwd)?;
    let url = format!("{}/pulls/{}/merge", ctx.repo_api(), index);
    let m = method.unwrap_or_else(|| "merge".to_string());

    let payload = merge_payload(&m, false);
    let (status, body) = gitea_curl_raw("POST", &url, Some(&payload), &ctx.auth, "application/json")?;
    if status < 400 {
        return Ok(());
    }
    // Older Gitea rejects `merge_method` and wants `Do`. Retry once before
    // reporting, so the user never sees a version mismatch as a merge failure.
    let legacy = merge_payload(&m, true);
    let (status2, body2) =
        gitea_curl_raw("POST", &url, Some(&legacy), &ctx.auth, "application/json")?;
    if status2 < 400 {
        return Ok(());
    }
    Err(format!(
        "Gitea merge failed (HTTP {}: {}); retry with the legacy field also failed (HTTP {}: {})",
        status,
        body.trim(),
        status2,
        body2.trim()
    ))
}

/// Fetch the PR head into a local branch and check it out.
///
/// Gitea exposes PR refs as `refs/pull/{index}/head`, same as GitHub. The
/// fetch lands in `FETCH_HEAD` rather than directly updating `refs/heads/pr-N`:
/// fetching straight into a named ref refuses outright when that branch is
/// the one currently checked out ("refusing to fetch into branch ... checked
/// out"), and even when it isn't, a plain (non-force) ref update fails on a
/// PR that has been amended/rebased upstream since a previous checkout,
/// because the update is not a fast-forward. Routing through `FETCH_HEAD`
/// then `checkout -B` sidesteps both: `-B` creates the branch on first
/// checkout and resets it in place on every later one, whether or not it is
/// the branch already checked out, so re-checking out the same PR after it
/// gained new commits just works instead of surfacing a raw git error.
#[tauri::command]
pub(crate) async fn gitea_checkout_pr(cwd: String, index: i64) -> Result<(), String> {
    let branch = format!("pr-{}", index);
    let refspec = format!("refs/pull/{}/head", index);
    // Write guard: fetch + checkout mutate refs and the worktree, colliding on
    // `.git/index.lock` with a concurrent read/write of the same repo. Held
    // across both git ops (the RwLock is non-reentrant, acquire exactly once).
    let _repo = crate::git::repo_lock::write(&cwd);
    let fetch = hidden_cmd("git")
        .args(["fetch", "origin", &refspec])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("git fetch: {}", e))?;
    if !fetch.status.success() {
        return Err(format!(
            "git fetch failed: {}",
            String::from_utf8_lossy(&fetch.stderr).trim()
        ));
    }
    let checkout = hidden_cmd("git")
        .args(["checkout", "-B", &branch, "FETCH_HEAD"])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("git checkout: {}", e))?;
    if !checkout.status.success() {
        return Err(format!(
            "git checkout failed: {}",
            String::from_utf8_lossy(&checkout.stderr).trim()
        ));
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn gitea_convert_draft_to_ready(cwd: String, index: i64) -> Result<(), String> {
    let ctx = gitea_ctx(&cwd)?;
    let url = format!("{}/pulls/{}", ctx.repo_api(), index);
    let payload = serde_json::json!({ "draft": false }).to_string();
    gitea_curl("PATCH", &url, Some(&payload), &ctx.auth)?;
    Ok(())
}

#[tauri::command]
pub(crate) async fn gitea_branches(cwd: String) -> Result<Vec<String>, String> {
    let ctx = gitea_ctx(&cwd)?;
    let want = GITEA_LIST_CEILING as usize;
    let collected = gitea_page_all(&ctx, want, |page| {
        format!(
            "{}/branches?limit={}&page={}",
            ctx.repo_api(),
            GITEA_PAGE_SIZE,
            page
        )
    })?;
    Ok(select_window(collected, 0, want as i64)
        .iter()
        .map(|b| jstr(b, "name"))
        .collect())
}

#[cfg(test)]
mod gitea_base_url_tests {
    use super::normalize_base_url;

    #[test]
    fn adds_https_when_the_scheme_is_missing() {
        assert_eq!(normalize_base_url("git.acme.io"), "https://git.acme.io");
    }

    #[test]
    fn keeps_an_explicit_port() {
        assert_eq!(normalize_base_url("http://git.acme.io:3000"), "http://git.acme.io:3000");
    }

    #[test]
    fn strips_a_trailing_slash_and_an_api_suffix() {
        assert_eq!(normalize_base_url("https://git.acme.io/"), "https://git.acme.io");
        assert_eq!(normalize_base_url("https://git.acme.io/api/v1"), "https://git.acme.io");
        assert_eq!(normalize_base_url("https://git.acme.io/api/v1/"), "https://git.acme.io");
    }

    #[test]
    fn keeps_a_subpath_install() {
        // Gitea can be mounted under a path prefix. Dropping it would 404
        // every call, so only the api suffix and trailing slashes come off.
        assert_eq!(normalize_base_url("https://acme.io/gitea/"), "https://acme.io/gitea");
    }
}

#[cfg(test)]
mod gitea_mapping_tests {
    use super::{map_pr, map_pr_detail, map_status};

    fn pr_json() -> serde_json::Value {
        serde_json::from_str(
            r#"{
              "id": 99001,
              "number": 42,
              "title": "Add the thing",
              "state": "open",
              "draft": true,
              "user": {"login": "alice"},
              "head": {"ref": "feat/thing", "sha": "abc123"},
              "base": {"ref": "main"},
              "created_at": "2026-09-01T10:00:00Z",
              "updated_at": "2026-09-02T10:00:00Z",
              "merged_at": null,
              "html_url": "https://git.acme.io/acme/app/pulls/42",
              "additions": 12,
              "deletions": 3,
              "changed_files": 2,
              "comments": 5,
              "mergeable": true,
              "labels": [{"name": "bug"}],
              "assignees": [{"login": "bob"}],
              "requested_reviewers": [{"login": "carol"}]
            }"#,
        )
        .unwrap()
    }

    #[test]
    fn uses_the_pr_index_not_the_global_id() {
        // Gitea's `id` is a database-wide id. Using it would address the wrong
        // PR on every follow-up call.
        assert_eq!(map_pr(&pr_json()).number, 42);
        assert_eq!(map_pr_detail(&pr_json()).number, 42);
    }

    #[test]
    fn maps_the_list_shape() {
        let pr = map_pr(&pr_json());
        assert_eq!(pr.title, "Add the thing");
        assert_eq!(pr.author, "alice");
        assert_eq!(pr.branch, "feat/thing");
        assert_eq!(pr.base, "main");
        assert!(pr.draft, "draft comes from the boolean, not a title prefix");
        assert_eq!(pr.labels, vec!["bug".to_string()]);
        assert_eq!(pr.assignees, vec!["bob".to_string()]);
        assert_eq!(pr.review_requested, vec!["carol".to_string()]);
        assert_eq!(pr.url, "https://git.acme.io/acme/app/pulls/42");
    }

    #[test]
    fn maps_mergeable_boolean_onto_the_string_contract() {
        let mut v = pr_json();
        assert_eq!(map_pr_detail(&v).mergeable, "MERGEABLE");
        v["mergeable"] = serde_json::Value::Bool(false);
        assert_eq!(map_pr_detail(&v).mergeable, "CONFLICTING");
        v["mergeable"] = serde_json::Value::Null;
        assert_eq!(map_pr_detail(&v).mergeable, "", "absent means unknown, never a guess");
    }

    #[test]
    fn carries_the_head_sha_for_the_status_call() {
        assert_eq!(map_pr_detail(&pr_json()).head_sha, "abc123");
    }

    #[test]
    fn maps_the_combined_status_into_checks() {
        let v: serde_json::Value = serde_json::from_str(
            r#"{"state": "success", "statuses": [
                 {"context": "build", "status": "success", "target_url": "https://ci/1"},
                 {"context": "lint", "status": "pending", "target_url": ""}
               ]}"#,
        )
        .unwrap();
        let checks = map_status(&v);
        assert_eq!(checks.len(), 2);
        assert_eq!(checks[0].name, "build");
        assert_eq!(checks[0].conclusion, "success");
        assert_eq!(checks[0].details_url, "https://ci/1");
        assert_eq!(checks[1].state, "pending");
    }

    #[test]
    fn tolerates_a_status_response_with_no_statuses_array() {
        let v: serde_json::Value = serde_json::from_str(r#"{"state": "pending"}"#).unwrap();
        assert!(map_status(&v).is_empty(), "no statuses means no checks, not a panic");
    }
}

#[cfg(test)]
mod gitea_paging_tests {
    use super::{needs_another_page, select_window};

    fn items(n: usize) -> Vec<serde_json::Value> {
        (0..n as i64).map(|i| serde_json::json!({"number": i})).collect()
    }

    fn numbers(items: &[serde_json::Value]) -> Vec<i64> {
        items.iter().map(|v| v["number"].as_i64().unwrap()).collect()
    }

    #[test]
    fn windows_from_the_start() {
        assert_eq!(numbers(&select_window(items(50), 0, 10)), (0..10).collect::<Vec<_>>());
    }

    #[test]
    fn windows_a_page_aligned_offset() {
        assert_eq!(numbers(&select_window(items(50), 20, 10)), (20..30).collect::<Vec<_>>());
    }

    #[test]
    fn windows_the_offsets_that_used_to_shift_the_result() {
        // Previously: limit was inflated to `per_page + (offset % per_page)`
        // on a single request, which shifts the window instead of covering
        // it whenever offset % per_page != 0.
        assert_eq!(
            numbers(&select_window(items(60), 15, 10)),
            (15..25).collect::<Vec<_>>(),
            "offset 15 limit 10 used to return items 20..30"
        );
        assert_eq!(
            numbers(&select_window(items(60), 25, 10)),
            (25..35).collect::<Vec<_>>(),
            "offset 25 limit 10 used to return items 35..45"
        );
        assert_eq!(
            numbers(&select_window(items(60), 33, 10)),
            (33..43).collect::<Vec<_>>(),
            "offset 33 limit 10 used to return items 42..52"
        );
    }

    #[test]
    fn offset_past_the_end_is_empty_not_a_panic() {
        assert!(select_window(items(10), 20, 10).is_empty());
    }

    #[test]
    fn zero_per_page_is_an_empty_window() {
        assert!(select_window(items(10), 0, 0).is_empty());
    }

    #[test]
    fn negative_offset_reads_as_zero() {
        assert_eq!(numbers(&select_window(items(10), -5, 3)), vec![0, 1, 2]);
    }

    #[test]
    fn stops_on_an_empty_page() {
        // Definitive end-of-results, even though far short of `want`.
        assert!(!needs_another_page(30, 50, 0));
    }

    #[test]
    fn stops_when_enough_is_collected() {
        assert!(!needs_another_page(50, 50, 50));
    }

    #[test]
    fn continues_on_a_short_but_nonempty_page_under_a_lowered_cap() {
        // A server with MAX_RESPONSE_ITEMS lowered below GITEA_PAGE_SIZE
        // returns a page shorter than requested on every call. That must not
        // be read as the end while more is still wanted.
        assert!(needs_another_page(20, 50, 20));
    }

    #[test]
    fn stops_at_exactly_enough() {
        assert!(!needs_another_page(50, 50, 10));
    }

    #[test]
    fn keeps_paging_up_to_the_list_ceiling_used_by_unbounded_endpoints() {
        // `gitea_pr_comments`, `gitea_list_reviews`, `gitea_reviewer_candidates`
        // and `gitea_branches` take no caller limit, so they page toward
        // `GITEA_LIST_CEILING` instead. A short but non-empty page (a lowered
        // server cap) must not be read as the end before the ceiling is hit.
        let want = super::GITEA_LIST_CEILING as usize;
        assert!(needs_another_page(want - 1, want, 1));
    }

    #[test]
    fn stops_exactly_at_the_list_ceiling() {
        let want = super::GITEA_LIST_CEILING as usize;
        assert!(!needs_another_page(want, want, 50));
    }
}

#[cfg(test)]
mod gitea_host_port_tests {
    use super::remote_host_port;

    #[test]
    fn drops_the_default_https_port() {
        assert_eq!(
            remote_host_port("https://git.acme.io/acme/app.git"),
            Some("git.acme.io".to_string())
        );
    }

    #[test]
    fn keeps_an_explicit_http_port() {
        assert_eq!(
            remote_host_port("http://git.acme.io:3000/acme/app.git"),
            Some("git.acme.io:3000".to_string())
        );
    }

    #[test]
    fn keeps_an_explicit_ssh_port() {
        assert_eq!(
            remote_host_port("ssh://git@git.acme.io:2222/acme/app.git"),
            Some("git.acme.io:2222".to_string())
        );
    }

    #[test]
    fn treats_the_scp_like_colon_as_a_path_separator_not_a_port() {
        // git@host:acme/app.git is SCP-like syntax: the text after the colon
        // is the owner/repo path, not a port. There is no port in this form.
        assert_eq!(
            remote_host_port("git@git.acme.io:acme/app.git"),
            Some("git.acme.io".to_string())
        );
    }
}

#[cfg(test)]
mod gitea_merge_payload_tests {
    use super::merge_payload;

    #[test]
    fn sends_the_documented_field_first() {
        let body = merge_payload("squash", false);
        assert!(body.contains("\"merge_method\":\"squash\""), "got {body}");
        assert!(!body.contains("\"Do\""));
    }

    #[test]
    fn falls_back_to_the_legacy_field() {
        let body = merge_payload("rebase", true);
        assert!(body.contains("\"Do\":\"rebase\""), "got {body}");
    }

    #[test]
    fn defaults_an_unknown_method_to_merge() {
        // The forge contract allows "merge" | "squash" | "rebase". Anything
        // else is a caller bug; a plain merge is the safe reading.
        assert!(merge_payload("octopus", false).contains("\"merge_method\":\"merge\""));
    }
}

#[cfg(test)]
mod gitea_comment_tests {
    use super::{map_comment, map_issue, map_review};

    #[test]
    fn maps_an_issue_comment_onto_the_frontend_shape() {
        let v: serde_json::Value = serde_json::from_str(
            r#"{
              "id": 7,
              "body": "looks good",
              "user": {"login": "alice"},
              "created_at": "2026-09-01T10:00:00Z",
              "updated_at": "2026-09-01T11:00:00Z",
              "html_url": "https://git.acme.io/acme/app/pulls/42#issuecomment-7"
            }"#,
        )
        .unwrap();
        let c = map_comment(&v);
        assert_eq!(c["id"], 7);
        assert_eq!(c["author"], "alice");
        assert_eq!(c["body"], "looks good");
        // Conversation comments are not anchored to a diff line. The panel
        // keys off `path` being empty to keep the inline affordances hidden.
        assert_eq!(c["path"], "");
        assert!(c["line"].is_null());
        assert_eq!(c["side"], "RIGHT");
    }

    #[test]
    fn maps_review_states_onto_the_shared_vocabulary() {
        let mk = |state: &str| {
            serde_json::from_str::<serde_json::Value>(&format!(
                r#"{{"id": 3, "state": "{state}", "body": "b",
                     "user": {{"login": "carol"}},
                     "submitted_at": "2026-09-01T10:00:00Z",
                     "html_url": "https://git.acme.io/r/1"}}"#
            ))
            .unwrap()
        };
        assert_eq!(map_review(&mk("APPROVED"))["state"], "APPROVED");
        assert_eq!(map_review(&mk("REQUEST_CHANGES"))["state"], "CHANGES_REQUESTED");
        assert_eq!(map_review(&mk("COMMENT"))["state"], "COMMENTED");
        assert_eq!(map_review(&mk("PENDING"))["state"], "PENDING");
        assert_eq!(map_review(&mk("APPROVED"))["user"]["login"], "carol");
    }

    #[test]
    fn maps_a_repo_issue() {
        let v: serde_json::Value = serde_json::from_str(
            r#"{
              "number": 12, "title": "Crash on save", "state": "open",
              "user": {"login": "dave"},
              "assignees": [{"login": "erin"}],
              "labels": [{"name": "bug"}],
              "html_url": "https://git.acme.io/acme/app/issues/12",
              "created_at": "2026-09-01T10:00:00Z",
              "updated_at": "2026-09-02T10:00:00Z",
              "milestone": {"title": "v2"}
            }"#,
        )
        .unwrap();
        let i = map_issue(&v);
        assert_eq!(i.number, 12);
        assert_eq!(i.author, "dave");
        assert_eq!(i.assignees, vec!["erin".to_string()]);
        assert_eq!(i.labels, vec!["bug".to_string()]);
        assert_eq!(i.milestone, "v2");
    }
}

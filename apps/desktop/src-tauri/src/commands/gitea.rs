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
//! A second entry at `account = "<host>"` (no username) points at which
//! `<host>:<username>` entry is active. Its value is JSON,
//! `{"username": "...", "base": "..."}`, where `base` is the exact server
//! URL (scheme, host, port) the account was validated against: the bare
//! host alone cannot carry a non-default port or an `http://` scheme, and
//! guessing either back from the git remote is how a self-hosted instance
//! on plain http, or on a non-default port, ends up called on the wrong
//! scheme or port. A pointer written before this field existed is a bare
//! username string, not JSON: `gitea_token_for_host` falls back to treating
//! it as one, with no stored base, in which case the API base is still
//! guessed from the remote URL as before.
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
        return Err(format!(
            "Could not read owner/repo from the remote URL: {}",
            url
        ));
    }
    let cred = gitea_token_for_host(&host)?;
    // The account's own validated base URL is the source of truth: it is the
    // exact scheme/host/port the user configured, unlike the remote URL which
    // can only be guessed at (and guesses https unconditionally). Only fall
    // back to the guess when an older pointer format left no base stored.
    let base = cred.base.unwrap_or_else(|| {
        let host_port = remote_host_port(&url).unwrap_or_else(|| host.clone());
        normalize_base_url(&host_port)
    });
    Ok(GiteaCtx {
        base,
        owner,
        repo,
        auth: auth_header_config("token", &cred.token),
    })
}

/// The token and, when the pointer entry carries one, the account's own
/// validated base URL for a host.
struct GiteaCredential {
    token: String,
    base: Option<String>,
}

/// Look up the stored token (and base URL, when stored) for `host`.
///
/// The keychain account key is `"<host>:<username>"`, and the username is not
/// known here, so the frontend stores a second entry keyed by host alone
/// pointing at the active username (see `backend-gitea.ts`). This reads that
/// pointer, then the token itself.
fn gitea_token_for_host(host: &str) -> Result<GiteaCredential, String> {
    let pointer = keyring::Entry::new(GITEA_SERVICE, host)
        .map_err(|e| format!("keyring: {}", e))?
        .get_password()
        .map_err(|_| {
            format!(
                "No Gitea account configured for {host}. \
                 Add one in Settings > Accounts."
            )
        })?;
    let (username, base) = parse_gitea_pointer(&pointer).map_err(|_| {
        format!(
            "Gitea account pointer for {host} is empty or unreadable. \
             Re-add the account in Settings > Accounts."
        )
    })?;
    let token = keyring::Entry::new(GITEA_SERVICE, &format!("{}:{}", host, username))
        .map_err(|e| format!("keyring: {}", e))?
        .get_password()
        .map_err(|_| {
            format!(
                "Gitea credential for {host} is missing or unreadable. \
                 Re-add the account in Settings > Accounts."
            )
        })?;
    Ok(GiteaCredential { token, base })
}

/// Parse the pointer entry's value into `(username, base)`.
///
/// The current form writes JSON, `{"username": "...", "base": "..."}`. A
/// pointer written before that field existed is a bare username string, not
/// JSON: this falls back to treating the whole value as the username, with
/// no base, which is exactly what the old format always meant. A malformed
/// value (present JSON but no `username` key, or invalid JSON) degrades the
/// same way rather than erroring, since the caller already has a clear
/// "missing or unreadable" error path for a token lookup that then fails.
///
/// An empty or whitespace-only pointer is the one case that errors instead
/// of degrading: falling through to the bare-username branch would yield an
/// empty username and go on to build a nonsense `"<host>:"` keychain key,
/// which then fails anyway but with a confusing error about that key rather
/// than about the account itself. The caller turns this into a clear,
/// host-named message.
fn parse_gitea_pointer(raw: &str) -> Result<(String, Option<String>), ()> {
    if raw.trim().is_empty() {
        return Err(());
    }
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(raw) {
        if let Some(username) = v.get("username").and_then(|u| u.as_str()) {
            let base = v.get("base").and_then(|b| b.as_str()).map(str::to_string);
            return Ok((username.to_string(), base));
        }
    }
    Ok((raw.to_string(), None))
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
    v.get(key)
        .and_then(|s| s.as_str())
        .unwrap_or("")
        .to_string()
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
/// Identity of one item for duplicate detection: its `id` when it has one,
/// otherwise the whole value. Branches carry `name` rather than `id`, so the
/// fallback is what keeps this general.
fn item_key(v: &serde_json::Value) -> String {
    match v.get("id") {
        Some(id) if !id.is_null() => id.to_string(),
        _ => v.to_string(),
    }
}

fn gitea_page_all(
    ctx: &GiteaCtx,
    want: usize,
    url_for_page: impl Fn(i64) -> String,
) -> Result<Vec<serde_json::Value>, String> {
    let mut collected: Vec<serde_json::Value> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut page = 1;
    loop {
        let resp = gitea_curl("GET", &url_for_page(page), None, &ctx.auth)?;
        let arr = resp.as_array().cloned().unwrap_or_default();
        let page_len = arr.len();
        // Count only what this page actually ADDS. An empty page is not the
        // only end of a collection: `/issues/{index}/comments` ignores the
        // `page` parameter entirely and serves the same items forever (Gitea
        // 1.27.3, verified against a live server), so a loop that stops only
        // on an empty page spins until the ceiling and returns the same
        // comment hundreds of times. Every other endpoint we page does honour
        // `page`, and for those this changes nothing.
        let mut added = 0usize;
        for item in arr {
            if seen.insert(item_key(&item)) {
                collected.push(item);
                added += 1;
            }
        }
        if added == 0 || !needs_another_page(collected.len(), want, page_len) {
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
    items
        .into_iter()
        .skip(off)
        .take(per_page as usize)
        .collect()
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
    // `/pulls/{index}.diff` is the documented suffix form and the only one
    // that serves a unified diff. There used to be a fallback here to
    // `/pulls/{index}/patch`, which was invented from a docs summary and is a
    // 404 on a real server (verified on Gitea 1.27.3). The sibling that does
    // exist, `/pulls/{index}.patch`, returns an mbox-formatted patch with
    // commit headers rather than a diff, so falling back to it would feed the
    // diff parser something it cannot read. One request, and a real error.
    let url = format!("{}/pulls/{}.diff", ctx.repo_api(), index);
    let (status, body) = gitea_curl_raw("GET", &url, None, &ctx.auth, "*/*")?;
    if status >= 400 {
        return Err(format!("Gitea diff failed (HTTP {})", status));
    }
    Ok(body)
}

#[tauri::command]
pub(crate) async fn gitea_pr_status(cwd: String, index: i64) -> Result<Vec<CICheck>, String> {
    let ctx = gitea_ctx(&cwd)?;
    let pr = gitea_curl(
        "GET",
        &format!("{}/pulls/{}", ctx.repo_api(), index),
        None,
        &ctx.auth,
    )?;
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
    let want = GITEA_LIST_CEILING as usize;
    let collected = gitea_page_all(&ctx, want, |page| {
        format!(
            "{}/pulls/{}/files?limit={}&page={}",
            ctx.repo_api(),
            index,
            GITEA_PAGE_SIZE,
            page
        )
    })?;
    Ok(select_window(collected, 0, want as i64)
        .iter()
        .map(|f| jstr(f, "filename"))
        .collect())
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

/// Build the merge request body.
///
/// The field is `Do`, not `merge_method`. Gitea 1.27.3 rejects
/// `{"merge_method": ...}` with `422 [Do]: Required`, verified against a live
/// server; the plan that introduced this command had it the other way round,
/// on the strength of a docs summary. `use_alternate_field` exists because
/// the two names have swapped places in Gitea's own history, so a version
/// that wants `merge_method` is retried rather than reported as a failure.
fn merge_payload(method: &str, use_alternate_field: bool) -> String {
    let m = match method {
        "squash" => "squash",
        "rebase" => "rebase",
        _ => "merge",
    };
    let body = if use_alternate_field {
        serde_json::json!({ "merge_method": m })
    } else {
        serde_json::json!({ "Do": m })
    };
    body.to_string()
}

/// Pick the base branch out of a repo object's `default_branch` field, e.g.
/// the response of `GET /repos/{owner}/{repo}`. Falls back to `"main"` only
/// when the field is missing or empty, an unexpected response shape rather
/// than the expected way to learn the real default.
fn default_branch_from_repo_json(v: &serde_json::Value) -> String {
    let branch = jstr(v, "default_branch");
    if branch.is_empty() {
        "main".to_string()
    } else {
        branch
    }
}

/// Resolve the repo's actual default branch for `gitea_create_pr`'s no-base
/// case, rather than guessing `"main"`: a repo whose default is `master`,
/// `develop`, or anything else would otherwise 404 or silently target an
/// existing-but-wrong `main`.
fn gitea_default_branch(ctx: &GiteaCtx) -> Result<String, String> {
    let resp = gitea_curl("GET", &ctx.repo_api(), None, &ctx.auth)?;
    Ok(default_branch_from_repo_json(&resp))
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
        gitea_default_branch(&ctx)?
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
    let resp = gitea_curl(
        "POST",
        &format!("{}/pulls", ctx.repo_api()),
        Some(&payload),
        &ctx.auth,
    )?;
    Ok(map_pr(&resp))
}

/// Whether a merge failure should be retried with the legacy `Do` field.
/// Only a client error (4xx) is plausibly "the server didn't understand the
/// `merge_method` field". A 5xx (a timeout, a crashed worker) may already
/// have committed the merge server-side by the time the error comes back, so
/// retrying would fire a second live POST at the merge endpoint instead of a
/// harmless field-name probe. Scoped to `400..500`, exclusive of `500`: the
/// first attempt's error is returned as-is for anything at or above it.
fn should_retry_merge_with_legacy_field(status: i32) -> bool {
    (400..500).contains(&status)
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
    let (status, body) =
        gitea_curl_raw("POST", &url, Some(&payload), &ctx.auth, "application/json")?;
    if status < 400 {
        return Ok(());
    }
    if !should_retry_merge_with_legacy_field(status) {
        return Err(format!(
            "Gitea merge failed (HTTP {}: {})",
            status,
            body.trim()
        ));
    }
    // A Gitea that wants `merge_method` instead of `Do` is retried once
    // rather than reported, so the user never sees a version difference as a
    // merge failure. On 1.27.3 the first attempt is the one that succeeds.
    let legacy = merge_payload(&m, true);
    let (status2, body2) =
        gitea_curl_raw("POST", &url, Some(&legacy), &ctx.auth, "application/json")?;
    if status2 < 400 {
        return Ok(());
    }
    Err(format!(
        "Gitea merge failed (HTTP {}: {}); the retry with the alternate merge field also failed (HTTP {}: {})",
        status,
        body.trim(),
        status2,
        body2.trim()
    ))
}

/// Pure git logic behind `gitea_checkout_pr`, factored out so it is
/// synchronously testable without an async runtime (same pattern as
/// `build_repo_tree` in `commands/files.rs`).
///
/// What this does, in order:
///
/// 1. Fetches the PR head (`refs/pull/{index}/head`, same layout as GitHub)
///    into `FETCH_HEAD` rather than directly into `refs/heads/pr-N`, so the
///    fetch can never collide with `pr-N` being the branch currently checked
///    out: fetching straight into a named ref refuses outright in that case
///    ("refusing to fetch into branch ... checked out"), and even when it
///    isn't checked out, a plain (non-force) ref update fails whenever the PR
///    has been amended/rebased upstream since a previous checkout, because
///    the update is not a fast-forward.
/// 2. Fast-forwards `pr-{index}` to `FETCH_HEAD` if it already exists
///    locally, or creates it fresh at `FETCH_HEAD` if this is the first
///    checkout of this PR, then checks it out.
/// 3. Refuses, rather than resetting, when `pr-{index}` already exists and
///    holds commits the fetched PR head does not (the user committed
///    directly on it, or the PR ref moved sideways rather than forward):
///    resetting with `checkout -B` in that case would strand those commits,
///    recoverable only through the reflog. The error names the branch so the
///    user can rename or drop it themselves.
fn gitea_checkout_pr_inner(cwd: &str, index: i64) -> Result<(), String> {
    let branch = format!("pr-{}", index);
    let refspec = format!("refs/pull/{}/head", index);
    // Write guard: fetch + checkout mutate refs and the worktree, colliding on
    // `.git/index.lock` with a concurrent read/write of the same repo. Held
    // across every git op below (the RwLock is non-reentrant, acquire exactly
    // once).
    let _repo = crate::git::repo_lock::write(cwd);
    let fetch = hidden_cmd("git")
        .args(["fetch", "origin", &refspec])
        .current_dir(cwd)
        .output()
        .map_err(|e| format!("git fetch: {}", e))?;
    if !fetch.status.success() {
        return Err(format!(
            "git fetch failed: {}",
            String::from_utf8_lossy(&fetch.stderr).trim()
        ));
    }

    let branch_ref = format!("refs/heads/{}", branch);
    let branch_exists = hidden_cmd("git")
        .args(["rev-parse", "--verify", "--quiet", &branch_ref])
        .current_dir(cwd)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if branch_exists {
        let is_ancestor = hidden_cmd("git")
            .args(["merge-base", "--is-ancestor", &branch, "FETCH_HEAD"])
            .current_dir(cwd)
            .output()
            .map_err(|e| format!("git merge-base: {}", e))?;
        if !is_ancestor.status.success() {
            return Err(format!(
                "Local branch '{branch}' has commits the PR's current head does not; \
                 checking it out would lose them. Rename or delete '{branch}' locally, \
                 then try again."
            ));
        }
    }

    let checkout = hidden_cmd("git")
        .args(["checkout", "-B", &branch, "FETCH_HEAD"])
        .current_dir(cwd)
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
pub(crate) async fn gitea_checkout_pr(cwd: String, index: i64) -> Result<(), String> {
    gitea_checkout_pr_inner(&cwd, index)
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
        assert_eq!(
            normalize_base_url("http://git.acme.io:3000"),
            "http://git.acme.io:3000"
        );
    }

    #[test]
    fn strips_a_trailing_slash_and_an_api_suffix() {
        assert_eq!(
            normalize_base_url("https://git.acme.io/"),
            "https://git.acme.io"
        );
        assert_eq!(
            normalize_base_url("https://git.acme.io/api/v1"),
            "https://git.acme.io"
        );
        assert_eq!(
            normalize_base_url("https://git.acme.io/api/v1/"),
            "https://git.acme.io"
        );
    }

    #[test]
    fn keeps_a_subpath_install() {
        // Gitea can be mounted under a path prefix. Dropping it would 404
        // every call, so only the api suffix and trailing slashes come off.
        assert_eq!(
            normalize_base_url("https://acme.io/gitea/"),
            "https://acme.io/gitea"
        );
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
        assert_eq!(
            map_pr_detail(&v).mergeable,
            "",
            "absent means unknown, never a guess"
        );
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
        assert!(
            map_status(&v).is_empty(),
            "no statuses means no checks, not a panic"
        );
    }
}

#[cfg(test)]
mod gitea_paging_tests {
    use super::{needs_another_page, select_window};

    fn items(n: usize) -> Vec<serde_json::Value> {
        (0..n as i64)
            .map(|i| serde_json::json!({"number": i}))
            .collect()
    }

    fn numbers(items: &[serde_json::Value]) -> Vec<i64> {
        items
            .iter()
            .map(|v| v["number"].as_i64().unwrap())
            .collect()
    }

    #[test]
    fn windows_from_the_start() {
        assert_eq!(
            numbers(&select_window(items(50), 0, 10)),
            (0..10).collect::<Vec<_>>()
        );
    }

    #[test]
    fn windows_a_page_aligned_offset() {
        assert_eq!(
            numbers(&select_window(items(50), 20, 10)),
            (20..30).collect::<Vec<_>>()
        );
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
mod gitea_duplicate_page_tests {
    use super::item_key;

    /// `/issues/{index}/comments` ignores `page` and serves the same items on
    /// every request (Gitea 1.27.3, verified against a live server). The
    /// paging loop therefore cannot rely on an empty page to stop, and dedupes
    /// by identity instead. These pin the identity function that decision
    /// rests on.
    #[test]
    fn keys_an_item_by_its_id_when_it_has_one() {
        let a: serde_json::Value = serde_json::from_str(r#"{"id": 7, "body": "hi"}"#).unwrap();
        let b: serde_json::Value = serde_json::from_str(r#"{"id": 7, "body": "edited"}"#).unwrap();
        let c: serde_json::Value = serde_json::from_str(r#"{"id": 8, "body": "hi"}"#).unwrap();
        assert_eq!(item_key(&a), item_key(&b), "same id is the same item");
        assert_ne!(
            item_key(&a),
            item_key(&c),
            "different id is a different item"
        );
    }

    #[test]
    fn falls_back_to_the_whole_value_when_there_is_no_id() {
        // Branches carry `name`, not `id`.
        let a: serde_json::Value = serde_json::from_str(r#"{"name": "trunk"}"#).unwrap();
        let b: serde_json::Value = serde_json::from_str(r#"{"name": "trunk"}"#).unwrap();
        let c: serde_json::Value = serde_json::from_str(r#"{"name": "feature/x"}"#).unwrap();
        assert_eq!(item_key(&a), item_key(&b));
        assert_ne!(item_key(&a), item_key(&c));
    }

    #[test]
    fn a_null_id_does_not_collapse_distinct_items() {
        let a: serde_json::Value = serde_json::from_str(r#"{"id": null, "name": "one"}"#).unwrap();
        let b: serde_json::Value = serde_json::from_str(r#"{"id": null, "name": "two"}"#).unwrap();
        assert_ne!(
            item_key(&a),
            item_key(&b),
            "a null id must not make every item identical"
        );
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
mod gitea_pointer_tests {
    use super::parse_gitea_pointer;

    #[test]
    fn parses_the_json_form_with_a_base() {
        assert_eq!(
            parse_gitea_pointer(r#"{"username":"alice","base":"http://git.acme.io:3000"}"#),
            Ok((
                "alice".to_string(),
                Some("http://git.acme.io:3000".to_string())
            ))
        );
    }

    #[test]
    fn falls_back_to_the_legacy_bare_username_form() {
        // Written by a build that predates the `base` field: a plain string,
        // not JSON at all.
        assert_eq!(
            parse_gitea_pointer("alice"),
            Ok(("alice".to_string(), None))
        );
    }

    #[test]
    fn falls_back_on_a_malformed_value() {
        // Valid JSON, but not the expected shape (no "username" key): treated
        // the same as a bare username, using the whole raw string.
        assert_eq!(
            parse_gitea_pointer(r#"{"nope":"alice"}"#),
            Ok((r#"{"nope":"alice"}"#.to_string(), None))
        );
    }

    #[test]
    fn errors_on_an_empty_pointer() {
        // Falling through to the bare-username branch would yield an empty
        // username and go on to build a nonsense "<host>:" keychain key.
        assert_eq!(parse_gitea_pointer(""), Err(()));
    }

    #[test]
    fn errors_on_a_whitespace_only_pointer() {
        assert_eq!(parse_gitea_pointer("   "), Err(()));
    }
}

#[cfg(test)]
mod gitea_merge_payload_tests {
    use super::merge_payload;

    #[test]
    fn sends_do_first_because_that_is_what_gitea_accepts() {
        // Verified against Gitea 1.27.3: {"merge_method": ...} is rejected
        // with 422 [Do]: Required, and {"Do": ...} merges.
        let body = merge_payload("squash", false);
        assert!(body.contains("\"Do\":\"squash\""), "got {body}");
        assert!(!body.contains("\"merge_method\""));
    }

    #[test]
    fn retries_with_the_alternate_field() {
        let body = merge_payload("rebase", true);
        assert!(body.contains("\"merge_method\":\"rebase\""), "got {body}");
    }

    #[test]
    fn defaults_an_unknown_method_to_merge() {
        // The forge contract allows "merge" | "squash" | "rebase". Anything
        // else is a caller bug; a plain merge is the safe reading.
        assert!(merge_payload("octopus", false).contains("\"Do\":\"merge\""));
    }
}

#[cfg(test)]
mod gitea_merge_retry_tests {
    use super::should_retry_merge_with_legacy_field;

    #[test]
    fn does_not_retry_just_below_the_client_error_range() {
        assert!(!should_retry_merge_with_legacy_field(399));
    }

    #[test]
    fn retries_the_low_end_of_the_client_error_range() {
        assert!(should_retry_merge_with_legacy_field(400));
    }

    #[test]
    fn retries_the_high_end_of_the_client_error_range() {
        assert!(should_retry_merge_with_legacy_field(499));
    }

    #[test]
    fn does_not_retry_a_server_error() {
        // A 5xx may arrive after the server already committed the merge
        // (a timeout, a crashed worker). Firing a second live POST at the
        // merge endpoint on a 500/502 risks a double merge attempt, not a
        // version-mismatch retry.
        assert!(!should_retry_merge_with_legacy_field(500));
        assert!(!should_retry_merge_with_legacy_field(502));
    }
}

#[cfg(test)]
mod gitea_default_branch_tests {
    use super::default_branch_from_repo_json;

    #[test]
    fn reads_the_repos_default_branch() {
        let v: serde_json::Value =
            serde_json::from_str(r#"{"default_branch": "develop"}"#).unwrap();
        assert_eq!(default_branch_from_repo_json(&v), "develop");
    }

    #[test]
    fn falls_back_to_main_when_the_field_is_missing() {
        let v: serde_json::Value = serde_json::from_str(r#"{}"#).unwrap();
        assert_eq!(default_branch_from_repo_json(&v), "main");
    }

    #[test]
    fn falls_back_to_main_when_the_field_is_empty() {
        let v: serde_json::Value = serde_json::from_str(r#"{"default_branch": ""}"#).unwrap();
        assert_eq!(default_branch_from_repo_json(&v), "main");
    }
}

#[cfg(test)]
mod gitea_checkout_tests {
    use super::gitea_checkout_pr_inner;
    use crate::git::hidden_cmd;
    use std::path::PathBuf;

    /// A throwaway git repo under the system temp dir, removed on drop.
    struct TempRepo {
        path: PathBuf,
    }

    impl Drop for TempRepo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    impl TempRepo {
        fn new(label: &str) -> Self {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let dir = std::env::temp_dir().join(format!(
                "gw-gitea-checkout-{}-{}-{}",
                std::process::id(),
                label,
                nanos
            ));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            let repo = TempRepo { path: dir };
            repo.git(&["init", "-q", "-b", "main"]);
            repo.git(&["config", "user.name", "Test"]);
            repo.git(&["config", "user.email", "test@example.com"]);
            repo.git(&["config", "commit.gpgsign", "false"]);
            repo
        }

        fn cwd(&self) -> String {
            self.path.to_str().unwrap().to_string()
        }

        fn git(&self, args: &[&str]) -> std::process::Output {
            let out = hidden_cmd("git")
                .args(args)
                .current_dir(&self.path)
                .output()
                .unwrap_or_else(|e| panic!("git {:?} failed to spawn: {}", args, e));
            assert!(
                out.status.success(),
                "git {:?} failed: {}",
                args,
                String::from_utf8_lossy(&out.stderr)
            );
            out
        }

        fn write_commit(&self, rel: &str, content: &str, msg: &str) -> String {
            std::fs::write(self.path.join(rel), content).unwrap();
            self.git(&["add", "-A"]);
            self.git(&["commit", "-q", "-m", msg]);
            let out = self.git(&["rev-parse", "HEAD"]);
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        }

        fn head_sha(&self) -> String {
            let out = self.git(&["rev-parse", "HEAD"]);
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        }

        fn current_branch(&self) -> String {
            let out = self.git(&["rev-parse", "--abbrev-ref", "HEAD"]);
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        }
    }

    #[test]
    fn checks_out_a_pr_ref_into_a_new_local_branch() {
        let origin = TempRepo::new("origin-fresh");
        origin.write_commit("a.txt", "one\n", "init");
        let pr_sha = origin.write_commit("a.txt", "two\n", "pr work");
        origin.git(&["update-ref", "refs/pull/42/head", &pr_sha]);

        let local = TempRepo::new("local-fresh");
        local.git(&["remote", "add", "origin", &origin.cwd()]);

        gitea_checkout_pr_inner(&local.cwd(), 42).expect("first checkout should succeed");

        assert_eq!(local.current_branch(), "pr-42");
        assert_eq!(local.head_sha(), pr_sha);
    }

    #[test]
    fn re_checkout_fast_forwards_when_the_pr_gained_commits() {
        let origin = TempRepo::new("origin-ff");
        origin.write_commit("a.txt", "one\n", "init");
        let pr_sha1 = origin.write_commit("a.txt", "two\n", "pr work");
        origin.git(&["update-ref", "refs/pull/7/head", &pr_sha1]);

        let local = TempRepo::new("local-ff");
        local.git(&["remote", "add", "origin", &origin.cwd()]);
        gitea_checkout_pr_inner(&local.cwd(), 7).expect("first checkout should succeed");
        assert_eq!(local.head_sha(), pr_sha1);

        // The PR gains a new commit upstream, same local branch already
        // checked out.
        let pr_sha2 = origin.write_commit("a.txt", "three\n", "pr work 2");
        origin.git(&["update-ref", "refs/pull/7/head", &pr_sha2]);

        gitea_checkout_pr_inner(&local.cwd(), 7).expect("re-checkout should fast-forward");

        assert_eq!(local.current_branch(), "pr-7");
        assert_eq!(local.head_sha(), pr_sha2);
    }

    #[test]
    fn refuses_to_discard_local_commits_on_the_pr_branch() {
        let origin = TempRepo::new("origin-diverge");
        origin.write_commit("a.txt", "one\n", "init");
        let pr_sha = origin.write_commit("a.txt", "two\n", "pr work");
        origin.git(&["update-ref", "refs/pull/9/head", &pr_sha]);

        let local = TempRepo::new("local-diverge");
        local.git(&["remote", "add", "origin", &origin.cwd()]);
        gitea_checkout_pr_inner(&local.cwd(), 9).expect("first checkout should succeed");
        assert_eq!(local.head_sha(), pr_sha);

        // The user commits directly on the local pr-9 branch. The PR ref on
        // origin does not move, so pr-9 now carries a commit FETCH_HEAD
        // does not.
        let local_only_sha = local.write_commit("mine.txt", "local work\n", "local edit");
        assert_ne!(local_only_sha, pr_sha);

        let err = gitea_checkout_pr_inner(&local.cwd(), 9)
            .expect_err("re-checkout must refuse to discard the local commit");
        assert!(err.contains("pr-9"), "got {err}");

        // Nothing was reset: the branch and its extra commit are untouched.
        assert_eq!(local.current_branch(), "pr-9");
        assert_eq!(local.head_sha(), local_only_sha);
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
        assert_eq!(
            map_review(&mk("REQUEST_CHANGES"))["state"],
            "CHANGES_REQUESTED"
        );
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

//! Azure DevOps REST / Entra ID OAuth Tauri commands.
//!
//! ## Why this exists
//!
//! Mirrors `github_api.rs` for Azure DevOps Services (dev.azure.com /
//! *.visualstudio.com). GitWand had no Azure forge before; this module adds a
//! self-contained auth + PR workflow path so users can sign in and drive PRs
//! without any CLI.
//!
//!   1. **Entra ID device flow** (`azure_device_start` / `azure_device_poll`):
//!      "Sign in with Azure" from Settings → Accounts. Microsoft's identity
//!      platform exposes the OAuth 2.0 device authorization grant, which maps
//!      1-for-1 onto the existing GitHub device-flow UI. The resulting access
//!      token is stored in the OS keychain under `service = "gitwand:azure"`,
//!      `account = "oauth"`.
//!   2. **REST API calls** via `curl` (Bearer token) against the Azure DevOps
//!      `_apis/git` endpoints (api-version 7.1).
//!
//! ## Auth resource / scope
//!
//! Azure DevOps is a first-party Entra resource (app id
//! `499b84ac-1321-427f-aa17-267ca6975798`). We request its `user_impersonation`
//! delegated scope plus `offline_access` so a refresh token is available for
//! follow-up work. (`user_impersonation` rather than `.default` minimises the
//! chance of triggering admin consent — in standard Entra tenants users can
//! self-consent to a single delegated permission; in fully locked-down tenants
//! where user consent is disabled entirely a tenant admin must grant consent
//! once via Azure Portal → Enterprise Applications → GitWand → Permissions.)
//!
//! ## Security note
//!
//! The token is injected via the `Authorization` header in `curl` process
//! arguments — same exposure profile as `github_api.rs` / `bitbucket.rs`. The
//! token is never logged or returned to the frontend.

use crate::git::{git_cmd, hidden_cmd};
use crate::types::*;
use super::curl_util::{bearer_config, curl_with_status, run_curl};
use rayon::prelude::*;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

// ─── Constants ──────────────────────────────────────────────────────────────

/// Keychain service for the Settings-managed Azure token.
pub(crate) const AZ_SERVICE: &str = "gitwand:azure";
/// Keychain account key — fixed, resolved without knowing the login up front.
pub(crate) const AZ_ACCOUNT: &str = "oauth";
/// Keychain account key for the Entra refresh token (used to renew the access
/// token, which expires ~1h after sign-in).
const AZ_ACCOUNT_REFRESH: &str = "oauth-refresh";

/// Azure DevOps first-party resource app id — the audience our access token
/// targets. Stable, public, documented by Microsoft.
const AZURE_DEVOPS_RESOURCE: &str = "499b84ac-1321-427f-aa17-267ca6975798";

/// Azure DevOps REST api-version pinned across this module.
const API_VERSION: &str = "7.1";

/// Entra ID OAuth endpoints. `organizations` admits any work/school tenant
/// (the common case for Azure DevOps) while excluding personal MSAs, which
/// cannot hold Azure DevOps identities anyway.
const DEVICECODE_URL: &str =
    "https://login.microsoftonline.com/organizations/oauth2/v2.0/devicecode";
const TOKEN_URL: &str = "https://login.microsoftonline.com/organizations/oauth2/v2.0/token";

/// Entra ID public-client application id (device-flow enabled).
///
/// Resolution order mirrors `github_api.rs::client_id`:
///   1. `GITWAND_AZURE_CLIENT_ID` at runtime (env of the running app).
///   2. `GITWAND_AZURE_CLIENT_ID` baked in at build time.
///   3. Fallback default (see below).
///
/// Default — GitWand's registered Entra app ("Allow public client flows" = Yes,
/// device flow enabled). Public client id, not a secret — safe to ship.
/// Overridable via `GITWAND_AZURE_CLIENT_ID` at runtime or build time.
fn client_id() -> String {
    if let Ok(v) = std::env::var("GITWAND_AZURE_CLIENT_ID") {
        let v = v.trim().to_string();
        if !v.is_empty() {
            return v;
        }
    }
    option_env!("GITWAND_AZURE_CLIENT_ID")
        .unwrap_or("e26aa15d-856c-4a64-98ed-d44d4c7b3a18")
        .to_string()
}

// ─── Token resolution ───────────────────────────────────────────────────────

/// Read a value from the keychain under `AZ_SERVICE` / `account`.
fn read_secret(account: &str) -> Option<String> {
    let entry = keyring::Entry::new(AZ_SERVICE, account).ok()?;
    let v = entry.get_password().ok()?;
    let v = v.trim().to_string();
    if v.is_empty() { None } else { Some(v) }
}

/// Store a value in the keychain under `AZ_SERVICE` / `account`.
fn write_secret(account: &str, value: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(AZ_SERVICE, account)
        .map_err(|e| format!("keyring init failed: {}", e))?;
    entry
        .set_password(value)
        .map_err(|e| format!("Failed to store Azure token: {}", e))
}

/// Delete a value from the keychain under `AZ_SERVICE` / `account`. A missing
/// entry is not an error — sign-out is idempotent.
fn delete_secret(account: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(AZ_SERVICE, account)
        .map_err(|e| format!("keyring init failed: {}", e))?;
    match entry.delete_password() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("Failed to delete Azure token: {}", e)),
    }
}

/// Read the Settings-managed Azure access token from the OS keychain.
pub(crate) fn settings_azure_token() -> Option<String> {
    read_secret(AZ_ACCOUNT)
}

/// Read the stored Entra refresh token.
fn settings_azure_refresh() -> Option<String> {
    read_secret(AZ_ACCOUNT_REFRESH)
}

/// Persist the access token (and refresh token, when the grant returns one).
fn store_tokens(access: &str, refresh: &str) -> Result<(), String> {
    write_secret(AZ_ACCOUNT, access)?;
    if !refresh.is_empty() {
        write_secret(AZ_ACCOUNT_REFRESH, refresh)?;
    }
    Ok(())
}

/// Exchange the stored refresh token for a fresh access token (Entra rotates the
/// refresh token, so persist the new one too). Returns the new access token.
///
/// Entra access tokens live ~1h; without this, the PR workflow breaks an hour
/// after sign-in and Azure DevOps starts returning an HTML sign-in page.
fn refresh_access_token() -> Result<String, String> {
    let refresh = settings_azure_refresh().ok_or_else(|| {
        "Azure session expired. Open Settings → Accounts and sign in with Azure again."
            .to_string()
    })?;
    let cid = client_id();
    // `user_impersonation` rather than `.default`: `.default` requests every
    // permission on the app registration and is more likely to require admin
    // consent. A single delegated scope can be self-consented in standard
    // tenants; fully locked-down tenants (user consent disabled) still need a
    // one-time admin grant via Azure Portal → Enterprise Applications.
    let scope = format!("{}/user_impersonation offline_access", AZURE_DEVOPS_RESOURCE);
    let (_status, text) = curl_form(
        TOKEN_URL,
        &[
            ("grant_type", "refresh_token"),
            ("client_id", &cid),
            ("refresh_token", &refresh),
            ("scope", &scope),
        ],
    )?;
    let v: serde_json::Value = serde_json::from_str(text.trim())
        .map_err(|e| format!("Failed to parse refresh response: {}", e))?;
    let access = js(&v, "access_token");
    if access.is_empty() {
        return Err(
            "Azure session expired. Open Settings → Accounts and sign in with Azure again."
                .to_string(),
        );
    }
    // Entra refresh-token rotation: store whatever new refresh token it returns.
    let _ = store_tokens(&access, &js(&v, "refresh_token"));
    Ok(access)
}

// ─── org/project/repo resolution ────────────────────────────────────────────

/// Identifies an Azure DevOps repository: organization, project, repo.
struct AzureRepo {
    org: String,
    project: String,
    repo: String,
}

impl AzureRepo {
    /// Base URL for the git REST surface of this repo.
    fn api_base(&self) -> String {
        format!(
            "https://dev.azure.com/{}/{}/_apis/git/repositories/{}",
            urlenc(&self.org),
            urlenc(&self.project),
            urlenc(&self.repo),
        )
    }
}

/// Minimal percent-encoding for path segments (space + a few reserved chars).
/// Azure org/project names allow spaces; the rest of the chars we care about
/// are alphanumerics, `-`, `_`, `.`.
fn urlenc(s: &str) -> String {
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

/// Parse `(org, project, repo)` from `git remote get-url origin`.
///
/// Handles the common Azure DevOps remote URL shapes:
///   - `https://dev.azure.com/{org}/{project}/_git/{repo}`
///   - `https://{org}@dev.azure.com/{org}/{project}/_git/{repo}`
///   - `https://{org}.visualstudio.com/{project}/_git/{repo}`
///   - `https://{org}.visualstudio.com/DefaultCollection/{project}/_git/{repo}`
///   - `git@ssh.dev.azure.com:v3/{org}/{project}/{repo}`
fn azure_repo(cwd: &str) -> Result<AzureRepo, String> {
    let output = hidden_cmd("git")
        .args(["remote", "get-url", "origin"])
        .current_dir(cwd)
        .output()
        .map_err(|e| format!("git remote get-url: {}", e))?;
    if !output.status.success() {
        return Err("No 'origin' remote found in this repo.".to_string());
    }
    let url = String::from_utf8_lossy(&output.stdout).trim().to_string();
    parse_azure_remote(&url)
        .ok_or_else(|| format!("Could not parse an Azure DevOps repo from remote URL: {}", url))
}

fn parse_azure_remote(url: &str) -> Option<AzureRepo> {
    // SSH: git@ssh.dev.azure.com:v3/{org}/{project}/{repo}
    if let Some(rest) = url.split_once("ssh.dev.azure.com:").map(|(_, r)| r) {
        let rest = rest.trim_start_matches("v3/").trim_end_matches(".git");
        let parts: Vec<&str> = rest.split('/').filter(|p| !p.is_empty()).collect();
        if parts.len() >= 3 {
            return Some(AzureRepo {
                org: parts[0].to_string(),
                project: parts[1].to_string(),
                repo: parts[2..].join("/"),
            });
        }
        return None;
    }

    // HTTPS — strip scheme + any `user@` userinfo.
    let after_scheme = url.splitn(2, "://").nth(1).unwrap_or(url);
    let after_userinfo = after_scheme.splitn(2, '@').last().unwrap_or(after_scheme);
    let (host, path) = after_userinfo.split_once('/')?;
    let path = path.trim_end_matches('/').trim_end_matches(".git");

    // dev.azure.com/{org}/{project}/_git/{repo}
    if host.eq_ignore_ascii_case("dev.azure.com") {
        let (left, repo) = path.split_once("/_git/")?;
        let segs: Vec<&str> = left.split('/').filter(|s| !s.is_empty()).collect();
        if segs.len() >= 2 {
            return Some(AzureRepo {
                org: segs[0].to_string(),
                project: segs[1..].join("/"),
                repo: repo.to_string(),
            });
        }
        return None;
    }

    // {org}.visualstudio.com[/DefaultCollection]/{project}/_git/{repo}
    if let Some(org) = host.strip_suffix(".visualstudio.com") {
        let (left, repo) = path.split_once("/_git/")?;
        let segs: Vec<&str> = left
            .split('/')
            .filter(|s| !s.is_empty() && !s.eq_ignore_ascii_case("DefaultCollection"))
            .collect();
        if !segs.is_empty() {
            return Some(AzureRepo {
                org: org.to_string(),
                project: segs.join("/"),
                repo: repo.to_string(),
            });
        }
    }
    None
}

/// Current branch name (`git rev-parse --abbrev-ref HEAD`).
fn current_branch(cwd: &str) -> Result<String, String> {
    let output = hidden_cmd("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(cwd)
        .output()
        .map_err(|e| format!("git rev-parse: {}", e))?;
    if !output.status.success() {
        return Err("Could not determine current branch.".to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

// ─── Fetch throttle ──────────────────────────────────────────────────────────

/// Minimum interval between `git fetch origin` calls per repo. The Azure PR
/// list refreshes remote-tracking branches to compute +/- stats locally; without
/// a guard this fired a blocking network fetch on every list open.
const FETCH_MIN_INTERVAL: Duration = Duration::from_secs(30);

/// Per-cwd timestamp of the last `git fetch origin` issued by the Azure PR list.
fn last_fetch_map() -> &'static Mutex<HashMap<String, Instant>> {
    static MAP: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Returns `true` (and records `now`) when `cwd` has not been fetched within
/// `FETCH_MIN_INTERVAL`; otherwise `false` so callers can skip the network call.
fn should_fetch_origin(cwd: &str) -> bool {
    let now = Instant::now();
    let mut map = match last_fetch_map().lock() {
        Ok(m) => m,
        Err(p) => p.into_inner(), // a poisoned lock must not block PR loading
    };
    match map.get(cwd) {
        Some(prev) if now.duration_since(*prev) < FETCH_MIN_INTERVAL => false,
        _ => {
            map.insert(cwd.to_string(), now);
            true
        }
    }
}

// ─── HTTP transport (curl) ──────────────────────────────────────────────────

/// curl config-file contents that carry form fields as `data-urlencode`
/// directives, so secrets (refresh_token, device_code) stay off argv. Used with
/// `--config -`.
///
/// Each value is wrapped in double-quotes inside the config, so a value
/// containing `"` or a newline could break out of the quoted string and inject
/// an arbitrary curl directive (e.g. `url = …`). Values here come from Entra
/// responses (opaque base64url tokens) and never contain those characters in
/// practice, but we reject them defensively rather than trust that invariant.
fn form_config(fields: &[(&str, &str)]) -> Result<String, String> {
    let mut cfg = String::new();
    for (k, v) in fields {
        if v.contains('"') || v.contains('\n') || v.contains('\r') {
            return Err(format!("Refusing to build curl config: field '{}' contains a quote or newline", k));
        }
        cfg.push_str(&format!("data-urlencode = \"{}={}\"\n", k, v));
    }
    Ok(cfg)
}

/// Run an Azure DevOps `curl` request and return `(http_status, body_text)`.
fn curl_raw(
    method: &str,
    url: &str,
    token: Option<&str>,
    body_json: Option<&str>,
) -> Result<(i32, String), String> {
    curl_with_status(
        method, url,
        token.map(bearer_config).as_deref(),
        body_json,
        &["User-Agent: GitWand"],
        "application/json",
    )
}

/// Form-encoded POST (Entra token/devicecode endpoints expect this), returns
/// `(status, body)`.
fn curl_form(url: &str, fields: &[(&str, &str)]) -> Result<(i32, String), String> {
    const MARKER: &str = "\n__GW_HTTP_STATUS__";
    let mut args: Vec<String> = vec![
        "-s".to_string(),
        "-X".to_string(), "POST".to_string(),
        "-H".to_string(), "Accept: application/json".to_string(),
        "-H".to_string(), "User-Agent: GitWand".to_string(),
        // Form fields (which include the refresh_token / device_code secrets)
        // are fed through `--config -` on stdin rather than `--data-urlencode`
        // argv entries, keeping them out of process listings.
        "--config".to_string(), "-".to_string(),
    ];
    args.push("-w".to_string());
    args.push(format!("{}%{{http_code}}", MARKER));
    args.push(url.to_string());

    let output = run_curl(&args, Some(&form_config(fields)?))?;
    let combined = String::from_utf8(output.stdout)
        .map_err(|e| format!("curl returned invalid UTF-8: {}", e))?;
    let (body, status) = match combined.rsplit_once(MARKER) {
        Some((b, s)) => (b.to_string(), s.trim().parse::<i32>().unwrap_or(0)),
        None => (combined, 0),
    };
    Ok((status, body))
}

/// Whether a response means "the access token is no longer accepted".
///
/// Azure DevOps does not always answer 401: when an OAuth token is expired or
/// rejected it frequently replies **HTTP 200 with an HTML sign-in page**. So we
/// also treat a non-JSON HTML body as an auth failure.
fn auth_failed(status: i32, body: &str) -> bool {
    if status == 401 || status == 203 {
        return true;
    }
    let t = body.trim_start();
    t.starts_with("<!DOCTYPE") || t.starts_with("<html") || t.starts_with("<HTML")
}

/// Turn a raw `(status, body)` into JSON or a user-facing error.
fn finalize_json(status: i32, body: &str) -> Result<serde_json::Value, String> {
    if status >= 400 {
        let msg = serde_json::from_str::<serde_json::Value>(body.trim())
            .ok()
            .and_then(|v| v.get("message").and_then(|m| m.as_str()).map(String::from))
            .unwrap_or_else(|| format!("HTTP {}", status));
        return Err(format!("Azure DevOps API error ({}): {}", status, msg));
    }
    if body.trim().is_empty() {
        return Ok(serde_json::Value::Null);
    }
    serde_json::from_str(body.trim())
        .map_err(|e| format!("Failed to parse Azure DevOps response: {}", e))
}

/// Perform an authenticated Azure DevOps JSON API call.
///
/// Resolves the access token from the keychain; on an auth failure it refreshes
/// the token once (via the stored refresh token) and retries. A persistent
/// failure surfaces a clear "sign in again" error rather than a JSON parse error.
fn az_json(
    method: &str,
    url: &str,
    body_json: Option<&str>,
) -> Result<serde_json::Value, String> {
    let token = settings_azure_token().ok_or_else(|| {
        "Not signed in to Azure DevOps. Open Settings → Accounts and sign in with Azure."
            .to_string()
    })?;
    let (status, body) = curl_raw(method, url, Some(&token), body_json)?;
    if !auth_failed(status, &body) {
        return finalize_json(status, &body);
    }
    // Token rejected/expired → refresh once and retry.
    let fresh = refresh_access_token()?;
    let (status2, body2) = curl_raw(method, url, Some(&fresh), body_json)?;
    if auth_failed(status2, &body2) {
        return Err(
            "Azure session expired. Open Settings → Accounts and sign in with Azure again."
                .to_string(),
        );
    }
    finalize_json(status2, &body2)
}

/// Append the pinned `api-version` query parameter to a URL.
fn with_api_version(url: &str) -> String {
    let sep = if url.contains('?') { '&' } else { '?' };
    format!("{}{}api-version={}", url, sep, API_VERSION)
}

// ─── JSON field helpers ─────────────────────────────────────────────────────

fn js(v: &serde_json::Value, key: &str) -> String {
    v.get(key).and_then(|x| x.as_str()).unwrap_or("").to_string()
}

fn ji(v: &serde_json::Value, key: &str) -> i64 {
    v.get(key).and_then(|x| x.as_i64()).unwrap_or(0)
}

fn jb(v: &serde_json::Value, key: &str) -> bool {
    v.get(key).and_then(|x| x.as_bool()).unwrap_or(false)
}

fn jnested(v: &serde_json::Value, outer: &str, inner: &str) -> String {
    v.get(outer).and_then(|o| o.get(inner)).and_then(|s| s.as_str()).unwrap_or("").to_string()
}

/// Strip the `refs/heads/` prefix from an Azure ref name.
fn short_ref(full: &str) -> String {
    full.strip_prefix("refs/heads/").unwrap_or(full).to_string()
}

/// Map Azure PR `status` to GitWand's vocabulary.
fn map_status(status: &str) -> String {
    match status {
        "completed" => "merged".to_string(),
        "abandoned" => "closed".to_string(),
        _ => "open".to_string(), // "active"
    }
}

/// Web URL for a PR (Azure REST omits a ready-made one in list responses).
fn pr_web_url(r: &AzureRepo, id: i64) -> String {
    format!(
        "https://dev.azure.com/{}/{}/_git/{}/pullrequest/{}",
        urlenc(&r.org), urlenc(&r.project), urlenc(&r.repo), id
    )
}

// ─── Mapping ────────────────────────────────────────────────────────────────

/// Derive a GitHub-style review decision from the reviewer votes carried on the
/// PR list/detail object, so the sidebar can flag PRs that are still waiting.
fn review_decision(pr: &serde_json::Value) -> &'static str {
    match pr.get("reviewers").and_then(|a| a.as_array()) {
        Some(rv) if !rv.is_empty() => {
            if rv.iter().any(|r| ji(r, "vote") <= -5) {
                "CHANGES_REQUESTED"
            } else if rv.iter().any(|r| ji(r, "vote") >= 5) {
                "APPROVED"
            } else {
                "REVIEW_REQUIRED"
            }
        }
        _ => "",
    }
}

fn json_to_pr(r: &AzureRepo, pr: &serde_json::Value) -> PullRequest {
    let id = ji(pr, "pullRequestId");
    PullRequest {
        number: id,
        title: js(pr, "title"),
        state: map_status(&js(pr, "status")),
        author: jnested(pr, "createdBy", "displayName"),
        branch: short_ref(&js(pr, "sourceRefName")),
        base: short_ref(&js(pr, "targetRefName")),
        draft: jb(pr, "isDraft"),
        created_at: js(pr, "creationDate"),
        updated_at: js(pr, "creationDate"),
        url: pr_web_url(r, id),
        additions: 0,
        deletions: 0,
        labels: Vec::new(),
        assignees: Vec::new(),
        review_requested: Vec::new(),
        review_decision: review_decision(pr).to_string(),
        merge_state_status: js(pr, "mergeStatus").to_uppercase(),
        checks_rollup: String::new(),
        comment_count: 0,
    }
}

fn json_to_detail(r: &AzureRepo, pr: &serde_json::Value) -> PullRequestDetail {
    let id = ji(pr, "pullRequestId");
    let status = js(pr, "status");
    let merged_at = if status == "completed" { js(pr, "closedDate") } else { String::new() };
    // Azure `mergeStatus`: succeeded / conflicts / queued / …
    let mergeable = match js(pr, "mergeStatus").as_str() {
        "succeeded" => "MERGEABLE".to_string(),
        "conflicts" => "CONFLICTING".to_string(),
        _ => "UNKNOWN".to_string(),
    };
    PullRequestDetail {
        number: id,
        title: js(pr, "title"),
        body: js(pr, "description"),
        state: map_status(&status),
        author: jnested(pr, "createdBy", "displayName"),
        branch: short_ref(&js(pr, "sourceRefName")),
        base: short_ref(&js(pr, "targetRefName")),
        draft: jb(pr, "isDraft"),
        created_at: js(pr, "creationDate"),
        updated_at: js(pr, "creationDate"),
        merged_at,
        url: pr_web_url(r, id),
        additions: 0,
        deletions: 0,
        changed_files: 0,
        comments: 0,
        review_comments: 0,
        labels: Vec::new(),
        reviewers: pr
            .get("reviewers")
            .and_then(|a| a.as_array())
            .map(|arr| arr.iter().map(|u| js(u, "displayName")).filter(|s| !s.is_empty()).collect())
            .unwrap_or_default(),
        mergeable,
        checks_status: String::new(),
        // Azure merge permission needs the Security/Permissions API — not
        // cheaply available here. Unknown ⇒ UI gates on errors only.
        can_merge: None,
    }
}

// ─── REST PR workflow ───────────────────────────────────────────────────────

fn rest_current_user() -> Result<String, String> {
    let url = with_api_version("https://app.vssps.visualstudio.com/_apis/profile/profiles/me");
    let v = az_json("GET", &url, None)?;
    let name = js(&v, "displayName");
    let name = if name.is_empty() { js(&v, "emailAddress") } else { name };
    if name.is_empty() {
        return Err("Azure DevOps returned an empty profile for this token.".to_string());
    }
    Ok(name)
}

/// Resolve the display name for an explicit token (used right after sign-in,
/// before the token is fully wired into the keychain-backed `az_json` path).
fn rest_current_user_with(token: &str) -> Result<String, String> {
    let url = with_api_version("https://app.vssps.visualstudio.com/_apis/profile/profiles/me");
    let (status, body) = curl_raw("GET", &url, Some(token), None)?;
    let v = finalize_json(status, &body)?;
    let name = js(&v, "displayName");
    let name = if name.is_empty() { js(&v, "emailAddress") } else { name };
    Ok(name)
}

fn search_status(state: &str) -> &'static str {
    match state {
        "closed" => "abandoned",
        "merged" => "completed",
        "all" => "all",
        _ => "active",
    }
}

fn rest_list_prs(cwd: &str, state: &str, limit: i64, offset: i64) -> Result<Vec<PullRequest>, String> {
    let r = azure_repo(cwd)?;
    let top = (limit + offset).clamp(1, 100);
    let url = with_api_version(&format!(
        "{}/pullrequests?searchCriteria.status={}&$top={}",
        r.api_base(), search_status(state), top
    ));
    let v = az_json("GET", &url, None)?;
    let mut prs: Vec<PullRequest> = v
        .get("value")
        .and_then(|a| a.as_array())
        .map(|arr| arr.iter().map(|pr| json_to_pr(&r, pr)).collect())
        .unwrap_or_default();
    if offset > 0 {
        let skip = (offset as usize).min(prs.len());
        prs.drain(..skip);
    }
    prs.truncate(limit.max(1) as usize);

    // Azure PR objects carry no line stats — compute +/- locally per PR. The
    // remote-tracking branches are refreshed once on the first page only (a
    // single incremental network call); paginated loads reuse those refs to
    // avoid a `git fetch` on every scroll. Branches that no longer exist
    // (merged/closed) leave the stats at 0.
    if !prs.is_empty() {
        if offset == 0 && should_fetch_origin(cwd) {
            let _ = git_cmd().args(["fetch", "origin"]).current_dir(cwd).output();
        }
        prs.par_iter_mut().for_each(|pr| {
            let (_, adds, dels) = diff_numstat(cwd, &pr.branch, &pr.base);
            pr.additions = adds;
            pr.deletions = dels;
        });
        // Aggregate each PR's branch-policy evaluations into a rollup so the
        // sidebar dot can colour (red = a build/policy failed, yellow = pending,
        // green = all pass). Parallel — one policy round-trip per PR.
        let rollups: HashMap<i64, String> = prs
            .par_iter()
            .filter_map(|pr| {
                let rollup = rollup_from_checks(&rest_pr_checks(cwd, pr.number).ok()?);
                if rollup.is_empty() { None } else { Some((pr.number, rollup)) }
            })
            .collect();
        for pr in &mut prs {
            if let Some(state) = rollups.get(&pr.number) {
                pr.checks_rollup = state.clone();
            }
        }
    }
    Ok(prs)
}

fn rest_pr_count(cwd: &str, state: &str) -> Result<i64, String> {
    let r = azure_repo(cwd)?;
    let url = with_api_version(&format!(
        "{}/pullrequests?searchCriteria.status={}&$top=1000",
        r.api_base(), search_status(state)
    ));
    let v = az_json("GET", &url, None)?;
    Ok(v.get("count").and_then(|c| c.as_i64()).unwrap_or_else(|| {
        v.get("value").and_then(|a| a.as_array()).map(|a| a.len() as i64).unwrap_or(0)
    }))
}

/// Fetch a single PR object together with its repo descriptor.
fn get_pr_json(cwd: &str, number: i64) -> Result<(AzureRepo, serde_json::Value), String> {
    let r = azure_repo(cwd)?;
    let url = with_api_version(&format!("{}/pullrequests/{}", r.api_base(), number));
    let v = az_json("GET", &url, None)?;
    Ok((r, v))
}

fn rest_pr_detail(cwd: &str, number: i64) -> Result<PullRequestDetail, String> {
    let (r, v) = get_pr_json(cwd, number)?;
    let mut detail = json_to_detail(&r, &v);
    // Azure's PR object has no file/line stats — compute them from local git so
    // the Files tab badge and the changed-files/additions/deletions stats are
    // populated (best-effort; leaves zeros if the branches can't be fetched).
    let source = short_ref(&js(&v, "sourceRefName"));
    let target = short_ref(&js(&v, "targetRefName"));
    if fetch_pr_branches(cwd, &source, &target).is_ok() {
        let (files, adds, dels) = diff_numstat(cwd, &source, &target);
        detail.changed_files = files;
        detail.additions = adds;
        detail.deletions = dels;
    }
    // Aggregate branch-policy evaluations into a rollup so the CI tab can colour
    // itself red (a build/policy failed) / yellow (pending) / green (all pass).
    detail.checks_status = rollup_from_checks(&rest_pr_checks(cwd, number).unwrap_or_default());
    Ok(detail)
}

/// `git diff --numstat target...source` → (changed_files, additions, deletions).
fn diff_numstat(cwd: &str, source: &str, target: &str) -> (i64, i64, i64) {
    let range = format!("origin/{}...origin/{}", target, source);
    let out = match git_cmd()
        .args(["diff", "--numstat", &range])
        .current_dir(cwd)
        .output()
    {
        Ok(o) if o.status.success() => o,
        _ => return (0, 0, 0),
    };
    let text = String::from_utf8_lossy(&out.stdout);
    let (mut files, mut adds, mut dels) = (0i64, 0i64, 0i64);
    for line in text.lines() {
        let mut cols = line.split('\t');
        let a = cols.next().unwrap_or("");
        let d = cols.next().unwrap_or("");
        files += 1;
        // Binary files show "-" for counts.
        adds += a.parse::<i64>().unwrap_or(0);
        dels += d.parse::<i64>().unwrap_or(0);
    }
    (files, adds, dels)
}

/// Diff is produced locally: fetch both PR branches from origin and diff the
/// merge base. Azure DevOps has no single unified-patch endpoint.
fn fetch_pr_branches(cwd: &str, source: &str, target: &str) -> Result<(), String> {
    let out = git_cmd()
        .args(["fetch", "origin", source, target])
        .current_dir(cwd)
        .output()
        .map_err(|e| format!("git fetch failed: {}", e))?;
    if !out.status.success() {
        return Err(format!(
            "git fetch {}/{} failed: {}",
            source, target, String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(())
}

fn rest_pr_diff(cwd: &str, number: i64) -> Result<String, String> {
    let (_r, pr) = get_pr_json(cwd, number)?;
    let source = short_ref(&js(&pr, "sourceRefName"));
    let target = short_ref(&js(&pr, "targetRefName"));
    fetch_pr_branches(cwd, &source, &target)?;
    let range = format!("origin/{}...origin/{}", target, source);
    let out = git_cmd()
        .args(["diff", &range])
        .current_dir(cwd)
        .output()
        .map_err(|e| format!("git diff failed: {}", e))?;
    if !out.status.success() {
        return Err(format!("git diff failed: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

fn rest_pr_files(cwd: &str, number: i64) -> Result<Vec<String>, String> {
    let (_r, pr) = get_pr_json(cwd, number)?;
    let source = short_ref(&js(&pr, "sourceRefName"));
    let target = short_ref(&js(&pr, "targetRefName"));
    fetch_pr_branches(cwd, &source, &target)?;
    let range = format!("origin/{}...origin/{}", target, source);
    let out = git_cmd()
        .args(["diff", "--name-only", &range])
        .current_dir(cwd)
        .output()
        .map_err(|e| format!("git diff --name-only failed: {}", e))?;
    if !out.status.success() {
        return Ok(Vec::new());
    }
    Ok(String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect())
}

/// One project team member: `(login, displayName, avatarUrl, identityId)`.
///
/// `login` is the `uniqueName` (email — the value Azure keys reviewers by),
/// falling back to `displayName`. `identityId` is the GUID the PR-create API
/// expects under `reviewers[].id`.
struct AzureMember {
    login: String,
    name: Option<String>,
    avatar_url: Option<String>,
    id: String,
}

/// Enumerate the union of members across all of the project's teams.
///
/// Azure DevOps has no single "assignable reviewers" endpoint, so we walk the
/// project teams (`_apis/projects/{project}/teams`) and flatten their members.
/// Each `TeamMember` wraps an `identity` carrying `displayName`, `uniqueName`
/// and `id`. Deduped by identity id; teams we can't read are skipped.
fn azure_team_members(cwd: &str) -> Result<Vec<AzureMember>, String> {
    let r = azure_repo(cwd)?;

    let teams_url = with_api_version(&format!(
        "https://dev.azure.com/{}/_apis/projects/{}/teams",
        urlenc(&r.org),
        urlenc(&r.project)
    ));
    let teams_v = az_json("GET", &teams_url, None)?;
    let teams = teams_v
        .get("value")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let mut all: Vec<AzureMember> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for team in &teams {
        let team_id = js(team, "id");
        if team_id.is_empty() {
            continue;
        }
        let members_url = with_api_version(&format!(
            "https://dev.azure.com/{}/_apis/projects/{}/teams/{}/members",
            urlenc(&r.org),
            urlenc(&r.project),
            urlenc(&team_id)
        ));
        // Skip teams we can't read rather than failing the whole picker.
        let members_v = match az_json("GET", &members_url, None) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let members = members_v
            .get("value")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        for m in &members {
            // A TeamMember wraps its identity; fall back to the entry itself.
            let ident = m.get("identity").unwrap_or(m);
            let unique = js(ident, "uniqueName");
            let display = js(ident, "displayName");
            let id = js(ident, "id");
            let login = if !unique.is_empty() {
                unique
            } else if !display.is_empty() {
                display.clone()
            } else {
                continue;
            };
            let dedup_key = if id.is_empty() { login.to_lowercase() } else { id.clone() };
            if !seen.insert(dedup_key) {
                continue;
            }
            let name = if display.is_empty() { None } else { Some(display) };
            let avatar_url = {
                let u = js(ident, "imageUrl");
                if u.is_empty() { None } else { Some(u) }
            };
            all.push(AzureMember { login, name, avatar_url, id });
        }
    }
    Ok(all)
}

/// Candidate reviewers for the combobox (drops the identity id).
fn rest_reviewer_candidates(cwd: &str) -> Result<Vec<ReviewerCandidate>, String> {
    let mut all: Vec<ReviewerCandidate> = azure_team_members(cwd)?
        .into_iter()
        .map(|m| ReviewerCandidate { login: m.login, name: m.name, avatar_url: m.avatar_url })
        .collect();
    all.sort_by(|a, b| a.login.to_lowercase().cmp(&b.login.to_lowercase()));
    Ok(all)
}

/// Resolve the reviewer strings picked in the UI (logins/emails/display names,
/// possibly `@`-prefixed) to Azure identity GUIDs, matched against the project
/// team members. Values that don't match a known member are dropped (Azure
/// requires a valid identity id). Returns a deduped id list.
fn resolve_reviewer_ids(cwd: &str, reviewers: &[String]) -> Vec<String> {
    if reviewers.is_empty() {
        return Vec::new();
    }
    let members = azure_team_members(cwd).unwrap_or_default();
    // login/email + displayName → id.
    let mut by_key: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    for m in &members {
        if m.id.is_empty() {
            continue;
        }
        by_key.entry(m.login.to_lowercase()).or_insert_with(|| m.id.clone());
        if let Some(name) = &m.name {
            by_key.entry(name.to_lowercase()).or_insert_with(|| m.id.clone());
        }
    }
    let mut ids: Vec<String> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for raw in reviewers {
        let key = raw.trim().trim_start_matches('@').to_lowercase();
        if key.is_empty() {
            continue;
        }
        if let Some(id) = by_key.get(&key) {
            if seen.insert(id.clone()) {
                ids.push(id.clone());
            }
        }
    }
    ids
}

fn rest_create_pr(
    cwd: &str,
    title: String,
    body: String,
    base: String,
    draft: bool,
    reviewers: Vec<String>,
) -> Result<PullRequest, String> {
    let r = azure_repo(cwd)?;
    let head_branch = current_branch(cwd)?;
    let base = if base.is_empty() { "main".to_string() } else { base };
    let mut payload = serde_json::json!({
        "sourceRefName": format!("refs/heads/{}", head_branch),
        "targetRefName": format!("refs/heads/{}", base),
        "title": title,
        "description": body,
        "isDraft": draft,
    });
    // Attach reviewers as `[{ id: <identityGuid> }]`. Resolve the picked
    // logins/emails to identity ids; skip silently if none resolve so PR
    // creation never fails just because a reviewer couldn't be matched.
    let ids = resolve_reviewer_ids(cwd, &reviewers);
    if !ids.is_empty() {
        payload["reviewers"] = serde_json::Value::Array(
            ids.into_iter().map(|id| serde_json::json!({ "id": id })).collect(),
        );
    }
    let url = with_api_version(&format!("{}/pullrequests", r.api_base()));
    let created = az_json("POST", &url, Some(&payload.to_string()))?;
    Ok(json_to_pr(&r, &created))
}

fn rest_merge_pr(cwd: &str, number: i64, method: &str) -> Result<(), String> {
    let (r, pr) = get_pr_json(cwd, number)?;
    let merge_strategy = match method {
        "squash" => "squash",
        "rebase" => "rebase",
        _ => "noFastForward",
    };
    let commit_id = pr
        .get("lastMergeSourceCommit")
        .and_then(|c| c.get("commitId"))
        .and_then(|s| s.as_str())
        .unwrap_or("")
        .to_string();
    let payload = serde_json::json!({
        "status": "completed",
        "lastMergeSourceCommit": { "commitId": commit_id },
        "completionOptions": {
            "mergeStrategy": merge_strategy,
            "deleteSourceBranch": true,
        },
    });
    let url = with_api_version(&format!("{}/pullrequests/{}", r.api_base(), number));
    az_json("PATCH", &url, Some(&payload.to_string()))?;
    Ok(())
}

fn rest_pr_ready(cwd: &str, number: i64) -> Result<(), String> {
    let r = azure_repo(cwd)?;
    let payload = serde_json::json!({ "isDraft": false });
    let url = with_api_version(&format!("{}/pullrequests/{}", r.api_base(), number));
    az_json("PATCH", &url, Some(&payload.to_string()))?;
    Ok(())
}

fn rest_checkout_pr(cwd: &str, number: i64) -> Result<(), String> {
    let (_r, pr) = get_pr_json(cwd, number)?;
    let source = short_ref(&js(&pr, "sourceRefName"));
    let fetch = git_cmd()
        .args(["fetch", "origin", &source])
        .current_dir(cwd)
        .output()
        .map_err(|e| format!("git fetch failed: {}", e))?;
    if !fetch.status.success() {
        return Err(format!(
            "git fetch {} failed: {}",
            source, String::from_utf8_lossy(&fetch.stderr).trim()
        ));
    }
    let checkout = git_cmd()
        .args(["checkout", &source])
        .current_dir(cwd)
        .output()
        .map_err(|e| format!("git checkout failed: {}", e))?;
    if !checkout.status.success() {
        return Err(format!(
            "git checkout {} failed: {}",
            source, String::from_utf8_lossy(&checkout.stderr).trim()
        ));
    }
    Ok(())
}

// ─── Comments (Azure DevOps threads) ────────────────────────────────────────
//
// Azure groups PR comments into *threads*. A thread may be anchored to a file
// (`threadContext.filePath` + line range) or be a general PR comment. Comment
// ids restart at 1 within each thread, so we synthesize a globally-unique id
// (`thread_id * COMMENT_ID_STRIDE + comment_id`) to keep Vue keys and reply
// links unambiguous. The same transform is applied to `parentCommentId`.

const COMMENT_ID_STRIDE: i64 = 1_000_000;

/// Map Azure threads into the snake_case shape the frontend `PrReviewComment`
/// type expects (consumed directly by `azPrComments`).
fn threads_to_comments(threads: &serde_json::Value) -> Vec<serde_json::Value> {
    let mut out = Vec::new();
    let empty: Vec<serde_json::Value> = vec![];
    let threads_arr = threads.get("value").and_then(|a| a.as_array()).unwrap_or(&empty);
    for thread in threads_arr {
        let thread_id = ji(thread, "id");
        let ctx = thread.get("threadContext");
        let path = ctx
            .and_then(|c| c.get("filePath"))
            .and_then(|s| s.as_str())
            .unwrap_or("")
            .trim_start_matches('/')
            .to_string();
        let line = ctx
            .and_then(|c| c.get("rightFileStart").or_else(|| c.get("rightFileEnd")))
            .and_then(|p| p.get("line"))
            .and_then(|l| l.as_i64());

        let comments = thread.get("comments").and_then(|a| a.as_array()).cloned().unwrap_or_default();
        for c in &comments {
            // Skip system-generated entries (status changes, votes, etc.).
            if js(c, "commentType") == "system" {
                continue;
            }
            let content = js(c, "content");
            if content.trim().is_empty() {
                continue;
            }
            let cid = ji(c, "id");
            let parent = ji(c, "parentCommentId");
            let in_reply_to = if parent > 0 {
                serde_json::json!(thread_id * COMMENT_ID_STRIDE + parent)
            } else {
                serde_json::Value::Null
            };
            out.push(serde_json::json!({
                "id": thread_id * COMMENT_ID_STRIDE + cid,
                "body": content,
                "author": jnested(c, "author", "displayName"),
                "created_at": js(c, "publishedDate"),
                "updated_at": js(c, "lastUpdatedDate"),
                "path": path,
                "line": line,
                "original_line": serde_json::Value::Null,
                "side": "RIGHT",
                "start_line": serde_json::Value::Null,
                "start_side": serde_json::Value::Null,
                "in_reply_to_id": in_reply_to,
                "diff_hunk": "",
                "url": "",
            }));
        }
    }
    out
}

fn rest_pr_comments(cwd: &str, number: i64) -> Result<Vec<serde_json::Value>, String> {
    let r = azure_repo(cwd)?;
    let url = with_api_version(&format!("{}/pullrequests/{}/threads", r.api_base(), number));
    let threads = az_json("GET", &url, None)?;
    Ok(threads_to_comments(&threads))
}

/// Create a general PR comment (a new thread). File-anchored creation is not
/// wired yet — `path`/`line` are accepted but ignored, producing a general
/// comment so nothing is silently dropped.
fn rest_pr_create_comment(cwd: &str, number: i64, body: &str) -> Result<serde_json::Value, String> {
    let r = azure_repo(cwd)?;
    let payload = serde_json::json!({
        "comments": [{ "parentCommentId": 0, "content": body, "commentType": "text" }],
        "status": "active",
    });
    let url = with_api_version(&format!("{}/pullrequests/{}/threads", r.api_base(), number));
    let thread = az_json("POST", &url, Some(&payload.to_string()))?;
    // Return the created comment in PrReviewComment shape (first non-system one).
    threads_to_comments(&serde_json::json!({ "value": [thread] }))
        .into_iter()
        .next()
        .ok_or_else(|| "Azure DevOps returned no comment after create.".to_string())
}

// ─── CI checks (Azure branch-policy evaluations) ────────────────────────────
//
// Azure surfaces "merge state" through branch *policy evaluations* (build
// validation, required/minimum reviewers, comment resolution, external status).
// This is a richer signal than raw commit statuses and matches what the PR page
// shows under "Checks", so we map each evaluation to a `CICheck`.

/// Map an Azure policy-evaluation `status` to (state, conclusion) in the
/// vocabulary the frontend merge-readiness logic understands.
fn map_policy_status(status: &str) -> (&'static str, &'static str) {
    match status {
        "approved" => ("completed", "SUCCESS"),
        "rejected" => ("completed", "FAILURE"),
        // "broken" = the policy evaluation itself errored (e.g. a build that
        // failed to run) — surface it as a red failure, not a yellow pending.
        "broken" => ("completed", "FAILURE"),
        "notApplicable" => ("completed", "SKIPPED"),
        "running" => ("in_progress", ""),
        // "queued" | "notSubmitted" | anything else → still pending.
        _ => ("queued", ""),
    }
}

/// Resolve a build's real outcome to `(state, conclusion)`. Build-validation
/// policy evaluations can report `queued` while the build itself has already
/// completed — possibly failed — so the build result is the source of truth.
/// Best-effort: returns `None` on any error so the caller keeps the policy
/// status. A still-running build maps to pending (yellow).
fn azure_build_outcome(org: &str, project: &str, build_id: i64) -> Option<(&'static str, &'static str)> {
    let url = format!(
        "https://dev.azure.com/{}/{}/_apis/build/builds/{}?api-version=7.1",
        urlenc(org),
        urlenc(project),
        build_id,
    );
    let v = az_json("GET", &url, None).ok()?;
    // `status`: notStarted / inProgress / completed / cancelling / postponed.
    if js(&v, "status") != "completed" {
        return Some(("in_progress", ""));
    }
    // `result`: succeeded / partiallySucceeded / failed / canceled.
    Some(match js(&v, "result").as_str() {
        "succeeded" => ("completed", "SUCCESS"),
        "failed" | "partiallySucceeded" | "canceled" => ("completed", "FAILURE"),
        _ => ("completed", ""),
    })
}

/// Rank a check's `conclusion` by how "resolved & positive" it is, so duplicate
/// evaluations of the same policy can be collapsed to their best outcome.
/// Higher wins: a passed copy beats a still-queued one.
fn conclusion_rank(conclusion: &str) -> u8 {
    match conclusion.to_uppercase().as_str() {
        "SUCCESS" => 3,
        "SKIPPED" | "NEUTRAL" => 2,
        "FAILURE" | "ERROR" => 1,
        _ => 0, // "" / queued / running / expired
    }
}

/// Collapse duplicate checks by `key`. Azure surfaces the same branch policy
/// twice (inherited + branch-level); when one copy is approved and the other is
/// still queued, the requirement is already met, so the whole group is success.
/// Distinct build definitions get distinct keys, so they are NOT merged.
/// First-seen order is preserved.
fn dedupe_checks(checks: Vec<(String, CICheck)>) -> Vec<CICheck> {
    let mut order: Vec<String> = Vec::new();
    let mut best: HashMap<String, CICheck> = HashMap::new();
    for (key, c) in checks {
        match best.get(&key) {
            Some(existing) if conclusion_rank(&existing.conclusion) >= conclusion_rank(&c.conclusion) => {}
            _ => {
                if !best.contains_key(&key) {
                    order.push(key.clone());
                }
                best.insert(key, c);
            }
        }
    }
    order.into_iter().filter_map(|k| best.remove(&k)).collect()
}

/// Aggregate a PR's policy/check evaluations into one rollup state:
/// `FAILURE` (red) / `PENDING` (yellow) / `SUCCESS` (green), or `""` when there
/// are no checks. Precedence: any failure ⇒ red, else any unfinished ⇒ yellow.
fn rollup_from_checks(checks: &[CICheck]) -> String {
    if checks.is_empty() {
        return String::new();
    }
    let mut pending = false;
    for c in checks {
        match c.conclusion.to_uppercase().as_str() {
            "FAILURE" | "ERROR" => return "FAILURE".to_string(),
            "SUCCESS" | "SKIPPED" | "NEUTRAL" => {}
            // EXPIRED (stale build, needs re-queue) → pending/warning, not red.
            _ => pending = true, // "" / EXPIRED → still running / queued
        }
        if c.state.to_lowercase() != "completed" {
            pending = true;
        }
    }
    if pending { "PENDING".to_string() } else { "SUCCESS".to_string() }
}

fn rest_pr_checks(cwd: &str, number: i64) -> Result<Vec<CICheck>, String> {
    let (r, pr) = get_pr_json(cwd, number)?;
    let project_id = pr
        .get("repository")
        .and_then(|repo| repo.get("project"))
        .and_then(|p| p.get("id"))
        .and_then(|s| s.as_str())
        .unwrap_or("");
    if project_id.is_empty() {
        return Ok(Vec::new());
    }
    // artifactId identifies the PR for the policy engine. The evaluations
    // endpoint is project-scoped (by GUID) and is still a *preview* API even on
    // 7.1 — a plain `api-version=7.1` returns 400, so we pin the preview tag.
    let artifact = format!("vstfs:///CodeReview/CodeReviewId/{}/{}", project_id, number);
    let url = format!(
        "https://dev.azure.com/{}/{}/_apis/policy/evaluations?artifactId={}&api-version=7.1-preview.1",
        urlenc(&r.org),
        urlenc(project_id),
        urlenc(&artifact),
    );
    // Policies may be disabled on the repo — treat any failure as "no checks".
    let v = match az_json("GET", &url, None) {
        Ok(v) => v,
        Err(_) => return Ok(Vec::new()),
    };
    let evals = v.get("value").and_then(|a| a.as_array()).cloned().unwrap_or_default();
    let checks: Vec<(String, CICheck)> = evals
        .iter()
        .filter_map(|e| {
            let cfg = e.get("configuration");
            let display = cfg
                .and_then(|c| c.get("type"))
                .and_then(|t| t.get("displayName"))
                .and_then(|s| s.as_str())
                .unwrap_or("Policy")
                .to_string();
            // Skip non-blocking housekeeping policies that always read as
            // "pending" and add noise to the readiness banner (e.g. the merge
            // strategy, which the user picks at merge time).
            let dl = display.to_lowercase();
            if dl.contains("merge strategy") || dl.contains("stratégie de fusion") {
                return None;
            }
            let settings = cfg.and_then(|c| c.get("settings"));
            // Spell out the reviewer requirement ("At least N reviewer(s) must
            // approve") so the merge-readiness banner is self-explanatory.
            let is_reviewer = display.to_lowercase().contains("reviewer");
            let name = if is_reviewer {
                let n = settings
                    .and_then(|s| s.get("minimumApproverCount"))
                    .and_then(|c| c.as_i64())
                    .unwrap_or(0);
                if n > 0 {
                    format!("At least {} reviewer{} must approve", n, if n > 1 { "s" } else { "" })
                } else {
                    display
                }
            } else {
                // Build / Status policies all share the generic type displayName
                // ("Build"); their real name lives in `settings.displayName`. Use
                // it so distinct builds don't all read as "Build".
                settings
                    .and_then(|s| s.get("displayName"))
                    .and_then(|x| x.as_str())
                    .filter(|x| !x.is_empty())
                    .map(String::from)
                    .unwrap_or(display)
            };
            // Dedupe key: reviewer policies legitimately appear twice (inherited +
            // branch-level) and must collapse, but distinct build definitions can
            // share a name and must NOT — so fold the build definition id into the
            // key when present.
            let build_def_id = settings
                .and_then(|s| s.get("buildDefinitionId"))
                .and_then(|b| b.as_i64());
            let dedupe_key = match build_def_id {
                Some(id) => format!("build:{}", id),
                None => name.clone(),
            };
            let (mut state, mut conclusion) = map_policy_status(&js(e, "status"));
            let is_expired = e
                .get("context")
                .and_then(|c| c.get("isExpired"))
                .and_then(|b| b.as_bool())
                .unwrap_or(false);
            if is_expired {
                // The build ran against a stale commit — Azure flags it
                // "Expired (Please Re-queue)" and it blocks the merge. Surface it
                // as a labelled failure so the user knows to re-run it.
                state = "completed";
                conclusion = "EXPIRED";
            } else if let Some(bid) = e
                .get("context")
                .and_then(|c| c.get("buildId"))
                .and_then(|b| b.as_i64())
            {
                // Build-validation policies: the policy `status` can sit at
                // "queued" even after the build has finished and *failed* (Azure
                // shows "1 required check failed" while the policy re-evaluation
                // is still queued). The build result is authoritative, so resolve
                // it when a `buildId` is present and override the policy status.
                if let Some((s, c)) = azure_build_outcome(&r.org, project_id, bid) {
                    state = s;
                    conclusion = c;
                }
            }
            Some((
                dedupe_key,
                CICheck {
                    name,
                    state: state.to_string(),
                    conclusion: conclusion.to_string(),
                    details_url: String::new(),
                },
            ))
        })
        .collect();

    // Azure reports the same policy twice (inherited + branch-level) — collapse
    // duplicates so an approved copy isn't shown alongside a queued one. Keyed by
    // build definition where applicable so distinct builds are kept separate.
    let checks = dedupe_checks(checks);

    // Fallback: the preview policy API can be unavailable (permissions, tag).
    // Still convey "waiting for reviewer" from the PR's own reviewer list — if
    // reviewers are assigned and none has approved (vote >= 5), surface it.
    if checks.is_empty() {
        if let Some(c) = pending_reviewer_check(&pr) {
            return Ok(vec![c]);
        }
    }
    Ok(checks)
}

/// Build a "waiting for reviewer approval" pending check from the PR's reviewer
/// votes, used when branch-policy evaluations aren't available.
fn pending_reviewer_check(pr: &serde_json::Value) -> Option<CICheck> {
    let reviewers = pr.get("reviewers").and_then(|a| a.as_array())?;
    if reviewers.is_empty() {
        return None;
    }
    let any_approved = reviewers.iter().any(|r| ji(r, "vote") >= 5);
    let any_rejected = reviewers.iter().any(|r| ji(r, "vote") <= -5);
    if any_approved && !any_rejected {
        return None; // requirement already satisfied
    }
    Some(CICheck {
        name: if any_rejected {
            "Changes requested by a reviewer".to_string()
        } else {
            "Waiting for reviewer approval".to_string()
        },
        state: "queued".to_string(),
        conclusion: if any_rejected { "FAILURE" } else { "" }.to_string(),
        details_url: String::new(),
    })
}

// ─── Reviews (reviewer votes) ───────────────────────────────────────────────
//
// Azure has no GitHub-style review submissions; approval is a per-reviewer
// *vote*: 10 approved, 5 approved-with-suggestions, 0 none, -5 waiting for
// author, -10 rejected. We map non-zero votes onto the review vocabulary so the
// merge-readiness chip can reason about approvals / requested changes.

fn map_vote(vote: i64) -> Option<&'static str> {
    match vote {
        v if v >= 5 => Some("APPROVED"),
        -5 => Some("CHANGES_REQUESTED"), // waiting for author
        -10 => Some("CHANGES_REQUESTED"), // rejected
        _ => None,                        // 0 — no vote yet
    }
}

/// Resolve the signed-in user's Azure DevOps identity id (a GUID) for the org.
/// This is the `reviewerId` the vote endpoint expects.
fn current_user_id(org: &str) -> Result<String, String> {
    let url = format!("https://dev.azure.com/{}/_apis/connectionData", urlenc(org));
    let v = az_json("GET", &url, None)?;
    let id = v
        .get("authenticatedUser")
        .and_then(|u| u.get("id"))
        .and_then(|s| s.as_str())
        .unwrap_or("")
        .to_string();
    if id.is_empty() {
        return Err("Could not resolve your Azure DevOps identity.".to_string());
    }
    Ok(id)
}

/// Cast / update the signed-in user's vote on a PR (Azure's review model).
///
/// `event` maps onto a vote: APPROVE → 10, REQUEST_CHANGES → -10. COMMENT casts
/// no vote. Any `body` is posted as a general comment first, so a "Comment"
/// review still leaves a visible note.
fn rest_submit_review(cwd: &str, number: i64, event: &str, body: &str) -> Result<serde_json::Value, String> {
    let r = azure_repo(cwd)?;
    if !body.trim().is_empty() {
        // Best-effort — never fail the vote because the note failed to post.
        let _ = rest_pr_create_comment(cwd, number, body);
    }
    let vote: i64 = match event {
        "APPROVE" => 10,
        "REQUEST_CHANGES" => -10,
        _ => 0,
    };
    let state = if vote > 0 {
        "APPROVED"
    } else if vote < 0 {
        "CHANGES_REQUESTED"
    } else {
        "COMMENTED"
    };
    if vote != 0 {
        let uid = current_user_id(&r.org)?;
        let payload = serde_json::json!({ "vote": vote });
        let url = with_api_version(&format!(
            "{}/pullrequests/{}/reviewers/{}",
            r.api_base(), number, urlenc(&uid)
        ));
        az_json("PUT", &url, Some(&payload.to_string()))?;
    }
    Ok(serde_json::json!({
        "id": 0,
        "state": state,
        "body": body,
        "user": { "login": "", "avatar_url": "" },
        "submitted_at": "",
        "html_url": "",
    }))
}

fn rest_pr_reviews(cwd: &str, number: i64) -> Result<Vec<serde_json::Value>, String> {
    let (_r, pr) = get_pr_json(cwd, number)?;
    let reviewers = pr.get("reviewers").and_then(|a| a.as_array()).cloned().unwrap_or_default();
    let mut out = Vec::new();
    for (i, rev) in reviewers.iter().enumerate() {
        let Some(state) = map_vote(ji(rev, "vote")) else { continue };
        out.push(serde_json::json!({
            "id": i as i64 + 1,
            "state": state,
            "body": "",
            "user": {
                "login": js(rev, "displayName"),
                "avatar_url": js(rev, "imageUrl"),
            },
            "submitted_at": "",
            "html_url": "",
        }));
    }
    Ok(out)
}

// ─── Tauri commands — PR workflow ───────────────────────────────────────────

// These forge commands do blocking network I/O (Azure DevOps REST, ~1–2s each).
// Tauri runs *synchronous* commands on the webview main thread, so a bare `fn`
// here freezes the whole UI for the call's duration. Declaring them `async` and
// running the blocking body via `spawn_blocking` keeps the work off the main
// thread — the UI stays interactive while the request is in flight.
#[tauri::command]
pub(crate) async fn az_current_user() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(rest_current_user)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn az_list_prs(cwd: String, state: String, limit: i64, offset: i64) -> Result<Vec<PullRequest>, String> {
    tauri::async_runtime::spawn_blocking(move || rest_list_prs(&cwd, &state, limit, offset))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn az_pr_count(cwd: String, state: String) -> Result<i64, String> {
    tauri::async_runtime::spawn_blocking(move || rest_pr_count(&cwd, &state))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn az_pr_detail(cwd: String, number: i64) -> Result<PullRequestDetail, String> {
    tauri::async_runtime::spawn_blocking(move || rest_pr_detail(&cwd, number))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn az_pr_diff(cwd: String, number: i64) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || rest_pr_diff(&cwd, number))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn az_pr_files(cwd: String, number: i64) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || rest_pr_files(&cwd, number))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn az_reviewer_candidates(cwd: String) -> Result<Vec<ReviewerCandidate>, String> {
    tauri::async_runtime::spawn_blocking(move || rest_reviewer_candidates(&cwd))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn az_create_pr(
    cwd: String,
    title: String,
    body: String,
    base: Option<String>,
    draft: Option<bool>,
    reviewers: Option<Vec<String>>,
) -> Result<PullRequest, String> {
    tauri::async_runtime::spawn_blocking(move || {
        rest_create_pr(
            &cwd,
            title,
            body,
            base.unwrap_or_default(),
            draft.unwrap_or(false),
            reviewers.unwrap_or_default(),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn az_merge_pr(cwd: String, number: i64, method: Option<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        rest_merge_pr(&cwd, number, &method.unwrap_or_else(|| "merge".to_string()))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn az_pr_ready(cwd: String, number: i64) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || rest_pr_ready(&cwd, number))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn az_checkout_pr(cwd: String, number: i64) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || rest_checkout_pr(&cwd, number))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn az_pr_comments(cwd: String, number: i64) -> Result<Vec<serde_json::Value>, String> {
    tauri::async_runtime::spawn_blocking(move || rest_pr_comments(&cwd, number))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn az_pr_create_comment(cwd: String, number: i64, body: String) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || rest_pr_create_comment(&cwd, number, &body))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn az_pr_checks(cwd: String, number: i64) -> Result<Vec<CICheck>, String> {
    tauri::async_runtime::spawn_blocking(move || rest_pr_checks(&cwd, number))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn az_pr_reviews(cwd: String, number: i64) -> Result<Vec<serde_json::Value>, String> {
    tauri::async_runtime::spawn_blocking(move || rest_pr_reviews(&cwd, number))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn az_submit_review(
    cwd: String,
    number: i64,
    event: String,
    body: Option<String>,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        rest_submit_review(&cwd, number, &event, &body.unwrap_or_default())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ─── Likes (Azure comment reactions) ────────────────────────────────────────
//
// Azure DevOps supports a single reaction type per comment: a "like" (👍).
// The API lives under `/threads/{threadId}/comments/{commentId}/likes`.
// Comment IDs stored in the frontend are composite (thread_id * COMMENT_ID_STRIDE
// + comment_id), so we decompose them here before calling the REST endpoint.
//
// The likes list endpoint returns an array of IdentityRef objects; we map each
// one to a PrReaction with content="+1" so the shared PrReactions.vue component
// can handle Azure uniformly with a simpler UI branch.

/// Build the `.../comments/{commentId}/likes` REST URL, decomposing the
/// composite comment id into its thread / comment parts.
fn likes_url(cwd: &str, pr_number: i64, composite_id: i64) -> Result<String, String> {
    let r = azure_repo(cwd)?;
    let thread_id = composite_id / COMMENT_ID_STRIDE;
    let comment_id = composite_id % COMMENT_ID_STRIDE;
    Ok(with_api_version(&format!(
        "{}/pullrequests/{}/threads/{}/comments/{}/likes",
        r.api_base(), pr_number, thread_id, comment_id
    )))
}

fn rest_list_likes(cwd: &str, pr_number: i64, composite_id: i64) -> Result<Vec<serde_json::Value>, String> {
    let url = likes_url(cwd, pr_number, composite_id)?;
    let v = az_json("GET", &url, None)?;
    let empty = vec![];
    let arr = v.as_array().unwrap_or(&empty);
    let result = arr.iter().enumerate().map(|(i, user)| {
        serde_json::json!({
            "id": i as i64,
            "content": "+1",
            "user": js(user, "displayName"),
        })
    }).collect();
    Ok(result)
}

fn rest_add_like(cwd: &str, pr_number: i64, composite_id: i64) -> Result<serde_json::Value, String> {
    let url = likes_url(cwd, pr_number, composite_id)?;
    az_json("POST", &url, Some("{}"))?;
    let current_user = rest_current_user()?;
    Ok(serde_json::json!({ "id": 999_i64, "content": "+1", "user": current_user }))
}

fn rest_delete_like(cwd: &str, pr_number: i64, composite_id: i64) -> Result<(), String> {
    let url = likes_url(cwd, pr_number, composite_id)?;
    az_json("DELETE", &url, None)?;
    Ok(())
}

#[tauri::command]
pub(crate) async fn az_list_likes(cwd: String, pr_number: i64, composite_id: i64) -> Result<Vec<serde_json::Value>, String> {
    tauri::async_runtime::spawn_blocking(move || rest_list_likes(&cwd, pr_number, composite_id))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn az_add_like(cwd: String, pr_number: i64, composite_id: i64) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || rest_add_like(&cwd, pr_number, composite_id))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn az_delete_like(cwd: String, pr_number: i64, composite_id: i64) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || rest_delete_like(&cwd, pr_number, composite_id))
        .await
        .map_err(|e| e.to_string())?
}

// ─── Entra ID device flow ───────────────────────────────────────────────────

/// Begin the Entra ID device authorization grant.
#[tauri::command]
pub(crate) async fn azure_device_start() -> Result<GithubDeviceCode, String> {
    let cid = client_id();
    // `user_impersonation` rather than `.default`: `.default` requests every
    // permission on the app registration and is more likely to require admin
    // consent. A single delegated scope can be self-consented in standard
    // tenants; fully locked-down tenants (user consent disabled) still need a
    // one-time admin grant via Azure Portal → Enterprise Applications.
    let scope = format!("{}/user_impersonation offline_access", AZURE_DEVOPS_RESOURCE);
    let (status, text) = curl_form(DEVICECODE_URL, &[("client_id", &cid), ("scope", &scope)])?;
    if status >= 400 {
        let msg = serde_json::from_str::<serde_json::Value>(text.trim())
            .ok()
            .and_then(|v| v.get("error_description").and_then(|m| m.as_str()).map(String::from))
            .unwrap_or_else(|| format!("HTTP {}", status));
        return Err(format!("Azure device-code request failed: {}", msg));
    }
    let v: serde_json::Value = serde_json::from_str(text.trim())
        .map_err(|e| format!("Failed to parse device-code response: {}", e))?;
    Ok(GithubDeviceCode {
        device_code: js(&v, "device_code"),
        user_code: js(&v, "user_code"),
        verification_uri: js(&v, "verification_uri"),
        // Entra returns `verification_uri_complete` only with some configs.
        verification_uri_complete: js(&v, "verification_uri_complete"),
        expires_in: ji(&v, "expires_in"),
        interval: ji(&v, "interval").max(5),
    })
}

/// Poll once for the Entra access token. On success the token is stored in the
/// OS keychain; the secret never reaches the frontend.
#[tauri::command]
pub(crate) async fn azure_device_poll(device_code: String) -> Result<GithubDevicePoll, String> {
    let cid = client_id();
    let (status, text) = curl_form(
        TOKEN_URL,
        &[
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
            ("client_id", &cid),
            ("device_code", &device_code),
        ],
    )?;
    let v: serde_json::Value = serde_json::from_str(text.trim())
        .map_err(|e| format!("Failed to parse token response: {}", e))?;

    if let Some(err) = v.get("error").and_then(|e| e.as_str()) {
        let kind = match err {
            "authorization_pending" => "pending",
            "slow_down" => "slow_down",
            _ => "error",
        };
        let detail = js(&v, "error_description");
        return Ok(GithubDevicePoll {
            status: kind.to_string(),
            login: String::new(),
            error: if kind == "error" {
                if detail.is_empty() { err.to_string() } else { detail }
            } else {
                String::new()
            },
        });
    }
    if status >= 400 {
        return Err(format!("Azure token poll failed (HTTP {})", status));
    }

    let token = js(&v, "access_token");
    if token.is_empty() {
        return Ok(GithubDevicePoll {
            status: "pending".to_string(),
            login: String::new(),
            error: String::new(),
        });
    }

    // Persist access + refresh tokens so the PR workflow survives the ~1h
    // access-token lifetime (refreshed transparently by `az_json`).
    store_tokens(&token, &js(&v, "refresh_token"))?;

    let login = rest_current_user_with(&token).unwrap_or_default();
    Ok(GithubDevicePoll {
        status: "success".to_string(),
        login,
        error: String::new(),
    })
}

/// Whether a Settings-managed Azure token is currently stored.
#[tauri::command]
pub(crate) async fn azure_token_present() -> Result<bool, String> {
    Ok(settings_azure_token().is_some())
}

/// Sign out of Azure DevOps: remove BOTH the access token and the Entra refresh
/// token from the OS keychain. Deleting only the access token would leave the
/// refresh token behind, able to silently mint new access tokens after the user
/// believed they had signed out.
#[tauri::command]
pub(crate) async fn azure_sign_out() -> Result<(), String> {
    delete_secret(AZ_ACCOUNT)?;
    delete_secret(AZ_ACCOUNT_REFRESH)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chk(conclusion: &str, state: &str) -> CICheck {
        CICheck {
            name: "n".to_string(),
            state: state.to_string(),
            conclusion: conclusion.to_string(),
            details_url: String::new(),
        }
    }

    fn parse(url: &str) -> (String, String, String) {
        let r = parse_azure_remote(url).expect("should parse");
        (r.org, r.project, r.repo)
    }

    #[test]
    fn parse_azure_remote_https_dev_azure() {
        assert_eq!(
            parse("https://dev.azure.com/myorg/myproj/_git/myrepo"),
            ("myorg".into(), "myproj".into(), "myrepo".into())
        );
    }

    #[test]
    fn parse_azure_remote_strips_userinfo_and_dot_git() {
        assert_eq!(
            parse("https://myorg@dev.azure.com/myorg/myproj/_git/myrepo.git"),
            ("myorg".into(), "myproj".into(), "myrepo".into())
        );
    }

    #[test]
    fn parse_azure_remote_visualstudio_with_default_collection() {
        assert_eq!(
            parse("https://myorg.visualstudio.com/DefaultCollection/myproj/_git/myrepo"),
            ("myorg".into(), "myproj".into(), "myrepo".into())
        );
        assert_eq!(
            parse("https://myorg.visualstudio.com/myproj/_git/myrepo"),
            ("myorg".into(), "myproj".into(), "myrepo".into())
        );
    }

    #[test]
    fn parse_azure_remote_ssh() {
        assert_eq!(
            parse("git@ssh.dev.azure.com:v3/myorg/myproj/myrepo"),
            ("myorg".into(), "myproj".into(), "myrepo".into())
        );
    }

    #[test]
    fn parse_azure_remote_rejects_non_azure() {
        assert!(parse_azure_remote("https://github.com/owner/repo.git").is_none());
        assert!(parse_azure_remote("https://dev.azure.com/onlyorg").is_none());
    }

    #[test]
    fn urlenc_encodes_spaces_and_reserved() {
        assert_eq!(urlenc("My Org"), "My%20Org");
        assert_eq!(urlenc("a/b?c"), "a%2Fb%3Fc");
        assert_eq!(urlenc("safe-_.~AZ09"), "safe-_.~AZ09");
    }

    #[test]
    fn with_api_version_picks_right_separator() {
        assert_eq!(with_api_version("https://x/y"), "https://x/y?api-version=7.1");
        assert_eq!(with_api_version("https://x/y?a=1"), "https://x/y?a=1&api-version=7.1");
    }

    #[test]
    fn auth_failed_detects_401_203_and_html() {
        assert!(auth_failed(401, "{}"));
        assert!(auth_failed(203, "{}"));
        assert!(auth_failed(200, "<!DOCTYPE html>..."));
        assert!(auth_failed(200, "  <html>sign in</html>"));
        assert!(!auth_failed(200, "{\"value\":[]}"));
    }

    #[test]
    fn short_ref_strips_refs_heads() {
        assert_eq!(short_ref("refs/heads/main"), "main");
        assert_eq!(short_ref("feature/x"), "feature/x");
    }

    #[test]
    fn map_status_maps_azure_states() {
        assert_eq!(map_status("completed"), "merged");
        assert_eq!(map_status("abandoned"), "closed");
        assert_eq!(map_status("active"), "open");
    }

    #[test]
    fn map_policy_status_broken_is_failure_not_pending() {
        assert_eq!(map_policy_status("approved"), ("completed", "SUCCESS"));
        assert_eq!(map_policy_status("rejected"), ("completed", "FAILURE"));
        assert_eq!(map_policy_status("broken"), ("completed", "FAILURE"));
        assert_eq!(map_policy_status("running"), ("in_progress", ""));
        assert_eq!(map_policy_status("queued"), ("queued", ""));
    }

    #[test]
    fn dedupe_checks_collapses_same_key_to_best_outcome() {
        // Same policy reported twice (inherited + branch-level): one approved,
        // one still queued → collapses to the approved copy.
        let out = dedupe_checks(vec![
            ("reviewers".to_string(), chk("", "queued")),
            ("reviewers".to_string(), chk("SUCCESS", "completed")),
        ]);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].conclusion, "SUCCESS");
    }

    #[test]
    fn dedupe_checks_keeps_distinct_keys_and_order() {
        let out = dedupe_checks(vec![
            ("build:1".to_string(), chk("SUCCESS", "completed")),
            ("build:2".to_string(), chk("FAILURE", "completed")),
        ]);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].conclusion, "SUCCESS");
        assert_eq!(out[1].conclusion, "FAILURE");
    }

    #[test]
    fn rollup_from_checks_precedence() {
        assert_eq!(rollup_from_checks(&[]), "");
        assert_eq!(
            rollup_from_checks(&[chk("SUCCESS", "completed"), chk("SKIPPED", "completed")]),
            "SUCCESS"
        );
        assert_eq!(
            rollup_from_checks(&[chk("SUCCESS", "completed"), chk("", "queued")]),
            "PENDING"
        );
        assert_eq!(
            rollup_from_checks(&[chk("SUCCESS", "completed"), chk("FAILURE", "completed")]),
            "FAILURE"
        );
    }

    #[test]
    fn map_vote_maps_votes() {
        assert_eq!(map_vote(10), Some("APPROVED"));
        assert_eq!(map_vote(5), Some("APPROVED"));
        assert_eq!(map_vote(-5), Some("CHANGES_REQUESTED"));
        assert_eq!(map_vote(-10), Some("CHANGES_REQUESTED"));
        assert_eq!(map_vote(0), None);
    }

    #[test]
    fn form_config_emits_data_urlencode_lines() {
        let cfg = form_config(&[("grant_type", "refresh_token"), ("client_id", "abc")]).unwrap();
        assert!(cfg.contains("data-urlencode = \"grant_type=refresh_token\""));
        assert!(cfg.contains("data-urlencode = \"client_id=abc\""));
    }

    #[test]
    fn should_fetch_origin_throttles_repeated_calls() {
        let cwd = "/tmp/gitwand-test-throttle-unique-xyz";
        // First call records the timestamp and allows the fetch.
        assert!(should_fetch_origin(cwd));
        // An immediate second call is within the interval and is skipped.
        assert!(!should_fetch_origin(cwd));
    }

    #[test]
    fn form_config_rejects_quote_or_newline_in_value() {
        assert!(form_config(&[("code", "a\"b")]).is_err());
        assert!(form_config(&[("code", "a\nurl = http://evil")]).is_err());
        assert!(form_config(&[("code", "a\rb")]).is_err());
        // A normal opaque token value is accepted.
        assert!(form_config(&[("code", "AQABbase64url-_token")]).is_ok());
    }
}

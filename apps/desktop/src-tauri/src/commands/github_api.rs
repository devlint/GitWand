//! GitHub REST/OAuth Tauri commands — tokenless PR workflow.
//!
//! ## Why this exists
//!
//! The historical GitHub integration (`gh.rs`, `ops.rs`) shells out to the
//! `gh` CLI. That requires the user to install and `gh auth login` from a
//! terminal — a friction point for non-CLI users. This module adds a second,
//! self-contained auth path:
//!
//!   1. **OAuth device flow** (`github_device_start` / `github_device_poll`):
//!      "Sign in with GitHub" from Settings → Accounts. The resulting token is
//!      stored in the OS keychain under `service = "gitwand:github"`,
//!      `account = "oauth"`.
//!   2. **REST API calls** via `curl` (mirrors `bitbucket.rs`): when a keychain
//!      token is present, the `gh_*` commands route here instead of spawning
//!      `gh`, so the `gh` binary is no longer required.
//!
//! ## Routing rule (see `settings_github_token`)
//!
//! REST is used **only** when an explicit Settings token exists in the keychain.
//! The ambient `GH_TOKEN` / `GITHUB_TOKEN` env vars (auto-populated from
//! `gh auth token` on macOS, see `shell_env.rs`) keep driving the `gh` CLI path
//! exactly as before — we never silently change behaviour for existing `gh`
//! users. Token in keychain ⇒ REST; otherwise ⇒ `gh`.
//!
//! ## Scope
//!
//! Core PR workflow only: current-user, list, count, detail, diff, checks,
//! files, create, merge, checkout, ready. Comments / reviews / reviewer
//! candidates / intelligence keep the `gh` path (or degrade gracefully).
//!
//! ## Security note
//!
//! The token is injected via the `Authorization` header in `curl` process
//! arguments — same exposure profile as `bitbucket.rs` (acceptable for now;
//! harden via `curl --config -` stdin piping in a follow-up). The token is
//! never logged or included in error messages.

use crate::git::{git_cmd, hidden_cmd};
use crate::types::*;
use super::curl_util::{bearer_config, curl_with_status};
use rayon::prelude::*;

// ─── Constants ──────────────────────────────────────────────────────────────

/// Keychain service for the Settings-managed GitHub token.
pub(crate) const GH_SERVICE: &str = "gitwand:github";
/// Keychain account key — fixed, since the REST helpers resolve the token
/// without knowing the login up front.
pub(crate) const GH_ACCOUNT: &str = "oauth";

/// GitHub OAuth App client_id (public, not a secret — safe to ship).
///
/// GitWand's registered OAuth App (device flow enabled). Overridable via
/// `GITWAND_GH_CLIENT_ID` at runtime or build time for self-hosted deployments.
///
/// Resolution order:
///   1. `GITWAND_GH_CLIENT_ID` at **runtime** (env var of the running app) —
///      lets `GITWAND_GH_CLIENT_ID=… pnpm tauri dev` work without fighting
///      cargo's build cache.
///   2. `GITWAND_GH_CLIENT_ID` baked in at **build time** (release builds).
///   3. Built-in default — GitWand's registered OAuth App.
fn client_id() -> String {
    if let Ok(v) = std::env::var("GITWAND_GH_CLIENT_ID") {
        let v = v.trim().to_string();
        if !v.is_empty() {
            return v;
        }
    }
    option_env!("GITWAND_GH_CLIENT_ID")
        // GitWand's registered GitHub OAuth App (device flow enabled). Public
        // client_id — not a secret, safe to ship.
        .unwrap_or("Ov23li1JPkwPsqdFrJ76")
        .to_string()
}

const API_BASE: &str = "https://api.github.com";

// ─── Token resolution ───────────────────────────────────────────────────────

/// Read the Settings-managed GitHub token from the OS keychain.
///
/// Returns `Some(token)` only when the user has explicitly signed in via
/// Settings > Accounts. Ambient env tokens are intentionally ignored here so
/// existing `gh` users are unaffected (see module docs).
pub(crate) fn settings_github_token() -> Option<String> {
    let entry = keyring::Entry::new(GH_SERVICE, GH_ACCOUNT).ok()?;
    let tok = entry.get_password().ok()?;
    let tok = tok.trim().to_string();
    if tok.is_empty() { None } else { Some(tok) }
}

// ─── Owner/repo resolution ──────────────────────────────────────────────────

/// Parse `(owner, repo)` from `git remote get-url origin` in `cwd`.
///
/// Handles HTTPS and SSH GitHub remote URL formats.
fn owner_repo(cwd: &str) -> Result<(String, String), String> {
    let output = hidden_cmd("git")
        .args(["remote", "get-url", "origin"])
        .current_dir(cwd)
        .output()
        .map_err(|e| format!("git remote get-url: {}", e))?;
    if !output.status.success() {
        return Err("No 'origin' remote found in this repo.".to_string());
    }
    let url = String::from_utf8_lossy(&output.stdout).trim().to_string();

    let path = if url.starts_with("git@") || url.contains("@github.com:") {
        // git@github.com:owner/repo.git → owner/repo
        url.splitn(2, ':')
            .nth(1)
            .unwrap_or("")
            .trim_end_matches(".git")
            .to_string()
    } else {
        // https://github.com/owner/repo.git → owner/repo
        url.trim_end_matches('/')
            .trim_end_matches(".git")
            .splitn(2, "github.com/")
            .nth(1)
            .unwrap_or("")
            .to_string()
    };

    let mut parts = path.splitn(2, '/');
    let owner = parts.next().unwrap_or("").to_string();
    let repo = parts.next().unwrap_or("").to_string();
    if owner.is_empty() || repo.is_empty() {
        return Err(format!("Could not parse GitHub owner/repo from remote URL: {}", url));
    }
    Ok((owner, repo))
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

// ─── HTTP transport (curl) ──────────────────────────────────────────────────

/// Run a GitHub `curl` request and return `(http_status, body_text)`.
///
/// `accept` selects the representation (`application/vnd.github+json` for JSON,
/// `application/vnd.github.v3.diff` for raw diffs).
fn curl_raw(
    method: &str,
    url: &str,
    token: Option<&str>,
    body_json: Option<&str>,
    accept: &str,
) -> Result<(i32, String), String> {
    curl_with_status(
        method, url,
        token.map(bearer_config).as_deref(),
        body_json,
        &["User-Agent: GitWand", "X-GitHub-Api-Version: 2022-11-28"],
        accept,
    )
}

/// Perform a GitHub JSON API call. Maps HTTP ≥ 400 to a user-facing error,
/// preferring GitHub's `message` field.
fn api_json(
    method: &str,
    url: &str,
    token: &str,
    body_json: Option<&str>,
) -> Result<serde_json::Value, String> {
    let (status, body) = curl_raw(method, url, Some(token), body_json, "application/vnd.github+json")?;
    if status >= 400 {
        let msg = serde_json::from_str::<serde_json::Value>(body.trim())
            .ok()
            .and_then(|v| v.get("message").and_then(|m| m.as_str()).map(String::from))
            .unwrap_or_else(|| format!("HTTP {}", status));
        return Err(format!("GitHub API error ({}): {}", status, msg));
    }
    if body.trim().is_empty() {
        return Ok(serde_json::Value::Null);
    }
    serde_json::from_str(body.trim())
        .map_err(|e| format!("Failed to parse GitHub response: {}", e))
}

// ─── JSON field helpers ─────────────────────────────────────────────────────

fn js(v: &serde_json::Value, key: &str) -> String {
    v.get(key).and_then(|x| x.as_str()).unwrap_or("").to_string()
}

/// Percent-encode an `owner/repo` slug for use inside a search query value,
/// keeping the `/` separator literal. GitHub.com names only use unreserved
/// characters, but GitHub Enterprise can surface unexpected ones; encoding
/// here avoids a malformed query that would silently return wrong counts.
fn enc_nwo(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

fn ji(v: &serde_json::Value, key: &str) -> i64 {
    v.get(key).and_then(|x| x.as_i64()).unwrap_or(0)
}

fn jb(v: &serde_json::Value, key: &str) -> bool {
    v.get(key).and_then(|x| x.as_bool()).unwrap_or(false)
}

/// `obj[outer][inner]` as a string.
fn jnested(v: &serde_json::Value, outer: &str, inner: &str) -> String {
    v.get(outer).and_then(|o| o.get(inner)).and_then(|s| s.as_str()).unwrap_or("").to_string()
}

/// Collect `[{ key: "..." }]` string fields into a Vec.
fn jlogins(v: &serde_json::Value, arr_key: &str, field: &str) -> Vec<String> {
    v.get(arr_key)
        .and_then(|a| a.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|u| u.get(field).and_then(|s| s.as_str()).map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

// ─── Mapping ────────────────────────────────────────────────────────────────

/// Map a GitHub REST pull-request object to `PullRequest`.
fn json_to_pr(pr: &serde_json::Value) -> PullRequest {
    let merged = pr.get("merged_at").map(|m| !m.is_null()).unwrap_or(false);
    let state = if merged { "merged".to_string() } else { js(pr, "state") };
    let review_requested = jlogins(pr, "requested_reviewers", "login");
    // REST has no review-decision field (that's GraphQL). Use the requested
    // reviewers as a cheap proxy: GitHub removes a reviewer from this list once
    // they approve, so a non-empty list ⇒ still waiting on review. Lets the PR
    // sidebar flag the PR (yellow dot) without a per-PR roundtrip.
    let review_decision = if !review_requested.is_empty() {
        "REVIEW_REQUIRED".to_string()
    } else {
        String::new()
    };
    PullRequest {
        number: ji(pr, "number"),
        title: js(pr, "title"),
        state,
        author: jnested(pr, "user", "login"),
        branch: jnested(pr, "head", "ref"),
        base: jnested(pr, "base", "ref"),
        draft: jb(pr, "draft"),
        created_at: js(pr, "created_at"),
        updated_at: js(pr, "updated_at"),
        url: js(pr, "html_url"),
        additions: ji(pr, "additions"),
        deletions: ji(pr, "deletions"),
        labels: jlogins(pr, "labels", "name"),
        assignees: jlogins(pr, "assignees", "login"),
        review_requested,
        review_decision,
        merge_state_status: js(pr, "mergeable_state").to_uppercase(),
        checks_rollup: String::new(),
        comment_count: ji(pr, "comments"),
    }
}

/// Map a GitHub REST pull-request object to `PullRequestDetail`.
fn json_to_detail(pr: &serde_json::Value) -> PullRequestDetail {
    let merged_at = pr.get("merged_at").and_then(|m| m.as_str()).unwrap_or("").to_string();
    let merged = !merged_at.is_empty();
    let state = if merged { "merged".to_string() } else { js(pr, "state") };
    // GitHub `mergeable`: true / false / null (still computing).
    let mergeable = match pr.get("mergeable").and_then(|m| m.as_bool()) {
        Some(true) => "MERGEABLE".to_string(),
        Some(false) => "CONFLICTING".to_string(),
        None => "UNKNOWN".to_string(),
    };
    PullRequestDetail {
        number: ji(pr, "number"),
        title: js(pr, "title"),
        body: js(pr, "body"),
        state,
        author: jnested(pr, "user", "login"),
        branch: jnested(pr, "head", "ref"),
        base: jnested(pr, "base", "ref"),
        draft: jb(pr, "draft"),
        created_at: js(pr, "created_at"),
        updated_at: js(pr, "updated_at"),
        merged_at,
        url: js(pr, "html_url"),
        additions: ji(pr, "additions"),
        deletions: ji(pr, "deletions"),
        changed_files: ji(pr, "changed_files"),
        comments: ji(pr, "comments"),
        review_comments: ji(pr, "review_comments"),
        labels: jlogins(pr, "labels", "name"),
        reviewers: jlogins(pr, "requested_reviewers", "login"),
        mergeable,
        checks_status: String::new(),
        // Filled in by rest_pr_detail via an explicit repo lookup — the pulls
        // response does not embed `permissions` on the nested base repo.
        can_merge: None,
    }
}

// ─── REST PR workflow ───────────────────────────────────────────────────────

pub(crate) fn rest_current_user(token: &str) -> Result<String, String> {
    let v = api_json("GET", &format!("{}/user", API_BASE), token, None)?;
    let login = v.get("login").and_then(|l| l.as_str()).unwrap_or("").to_string();
    if login.is_empty() {
        return Err("GitHub returned an empty login for this token.".to_string());
    }
    Ok(login)
}

pub(crate) fn rest_list_prs(
    cwd: &str,
    state: &str,
    limit: i64,
    offset: i64,
    token: &str,
) -> Result<Vec<PullRequest>, String> {
    let (owner, repo) = owner_repo(cwd)?;
    let origin = format!("{}/{}", owner, repo);
    let base = base_owner_repo(cwd, token).unwrap_or_else(|_| origin.clone());

    let page = limit.max(1);
    let off = offset.max(0);
    // Naïve pagination identical to gh_list_prs: fetch offset+limit, then slice.
    let per_page = (page + off).clamp(1, 100);
    // "merged" is not a native GitHub pulls state — fetch closed and filter.
    let api_state = match state {
        "closed" => "closed",
        "merged" => "closed",
        "all" => "all",
        _ => "open",
    };

    // Fetch PRs from the base repository (matches `gh pr list` behavior).
    let raw: Vec<serde_json::Value> = api_json(
        "GET",
        &format!(
            "{}/repos/{}/pulls?state={}&per_page={}&page=1&sort=updated&direction=desc",
            API_BASE, base, api_state, per_page
        ),
        token,
        None,
    )?
    .as_array()
    .cloned()
    .unwrap_or_default();

    let mut prs: Vec<PullRequest> = raw
        .iter()
        .filter(|pr| {
            if state == "merged" {
                pr.get("merged_at").map(|m| !m.is_null()).unwrap_or(false)
            } else {
                true
            }
        })
        .map(json_to_pr)
        .collect();
    if off > 0 {
        let skip = (off as usize).min(prs.len());
        prs.drain(..skip);
    }
    prs.truncate(page as usize);

    // The list endpoint omits additions/deletions (only the per-PR detail has
    // them). Fetch +/- from the REST detail endpoint per PR, in parallel. GitHub
    // computes the diff server-side, so this is correct for cross-fork PRs whose
    // head branch lives in the contributor's fork — a local `git diff` against
    // `origin/<branch>` would read 0/0 because that ref isn't present locally.
    if !prs.is_empty() {
        let stats: std::collections::HashMap<i64, (i64, i64)> = prs
            .par_iter()
            .filter_map(|pr| rest_pr_line_stats(&base, pr.number, token).map(|s| (pr.number, s)))
            .collect();
        for pr in &mut prs {
            if let Some(&(adds, dels)) = stats.get(&pr.number) {
                pr.additions = adds;
                pr.deletions = dels;
            }
        }
        // The REST list carries no CI status. Resolve each PR's head SHA from
        // the raw list payload, then aggregate its check-runs so the sidebar can
        // colour the dot (red = failing, yellow = pending, green = passing).
        // We use the REST check-runs endpoint — not GraphQL `statusCheckRollup`
        // — because fine-grained / GitHub-App tokens can read check-runs but
        // often can't read the GraphQL rollup field, which would silently leave
        // every dot green.
        let sha_by_num: std::collections::HashMap<i64, String> = raw
            .iter()
            .filter_map(|pr| {
                let n = pr.get("number").and_then(|x| x.as_i64())?;
                Some((n, jnested(pr, "head", "sha")))
            })
            .collect();
        // Combine CI rollup + mergeable-state into one parallel pass so we only
        // spin up one rayon task per PR instead of two separate par_iter rounds.
        // `rest_mergeable_state` fetches the single-PR endpoint — the list
        // endpoint returns null/unknown for mergeable_state (GitHub computes it
        // lazily and only exposes the result on the per-PR detail endpoint).
        let enrich: std::collections::HashMap<i64, (String, String)> = prs
            .par_iter()
            .map(|pr| {
                let sha = sha_by_num.get(&pr.number).map(|s| s.as_str()).unwrap_or("");
                let rollup = if sha.is_empty() { String::new() } else { rest_rollup_for_sha(&base, sha, token) };
                let merge_state = rest_mergeable_state(&base, pr.number, token);
                (pr.number, (rollup, merge_state))
            })
            .collect();
        for pr in &mut prs {
            if let Some((rollup, merge_state)) = enrich.get(&pr.number) {
                if !rollup.is_empty() { pr.checks_rollup = rollup.clone(); }
                if !merge_state.is_empty() { pr.merge_state_status = merge_state.clone(); }
            }
        }
    }
    Ok(prs)
}

/// Aggregate the check-runs of commit `sha` in `repo` ("owner/name") into a
/// single rollup state: `FAILURE` / `PENDING` / `SUCCESS`, or `""` when the
/// commit has no checks configured. Best effort — any HTTP error yields `""`.
///
/// Uses the REST check-runs endpoint (the same one that powers the CI tab's
/// per-check list) rather than GraphQL `statusCheckRollup`, so it keeps working
/// with fine-grained / GitHub-App tokens that can't read the GraphQL field.
fn rest_rollup_for_sha(repo: &str, sha: &str, token: &str) -> String {
    if sha.is_empty() {
        return String::new();
    }
    let url = format!("{}/repos/{}/commits/{}/check-runs", API_BASE, repo, sha);
    let v = match api_json("GET", &url, token, None) {
        Ok(v) => v,
        Err(_) => return String::new(),
    };
    let runs = v.get("check_runs").and_then(|r| r.as_array()).cloned().unwrap_or_default();
    rollup_from_check_runs(&runs)
}

/// Fetch the mergeable state of a single PR from the REST detail endpoint.
/// Returns `"DIRTY"` (conflicts), `"BLOCKED"`, `"CLEAN"`, etc., or `""` on
/// error / when GitHub hasn't computed it yet (`"unknown"`).
/// The list endpoint returns `mergeable_state: null` or `"unknown"` — callers
/// must hit the per-PR endpoint to get a reliable value.
fn rest_mergeable_state(repo: &str, number: i64, token: &str) -> String {
    let url = format!("{}/repos/{}/pulls/{}", API_BASE, repo, number);
    let v = match api_json("GET", &url, token, None) {
        Ok(v) => v,
        Err(_) => return String::new(),
    };
    let state = js(&v, "mergeable_state").to_uppercase();
    if state.is_empty() || state == "UNKNOWN" { String::new() } else { state }
}

/// Reduce a set of check-run objects to one rollup state.
/// Precedence: any failure ⇒ `FAILURE`, else any still-running ⇒ `PENDING`,
/// else `SUCCESS`. Empty input ⇒ `""`.
fn rollup_from_check_runs(runs: &[serde_json::Value]) -> String {
    if runs.is_empty() {
        return String::new();
    }
    let mut pending = false;
    for run in runs {
        // `status`: QUEUED / IN_PROGRESS / COMPLETED.
        // `conclusion`: only meaningful once COMPLETED.
        if js(run, "status").to_uppercase() != "COMPLETED" {
            pending = true;
            continue;
        }
        match js(run, "conclusion").to_uppercase().as_str() {
            "FAILURE" | "TIMED_OUT" | "CANCELLED" | "ACTION_REQUIRED" | "STARTUP_FAILURE"
            | "STALE" => return "FAILURE".to_string(),
            "SUCCESS" | "NEUTRAL" | "SKIPPED" => {}
            _ => pending = true,
        }
    }
    if pending { "PENDING".to_string() } else { "SUCCESS".to_string() }
}

/// `git diff --numstat origin/base...origin/head` → (additions, deletions).
/// Returns zeros when the refs aren't available locally.
pub(crate) fn diff_numstat(cwd: &str, head: &str, base: &str) -> (i64, i64) {
    if head.is_empty() || base.is_empty() {
        return (0, 0);
    }
    let range = format!("origin/{}...origin/{}", base, head);
    let out = match hidden_cmd("git")
        .args(["diff", "--numstat", &range])
        .current_dir(cwd)
        .output()
    {
        Ok(o) if o.status.success() => o,
        _ => return (0, 0),
    };
    let text = String::from_utf8_lossy(&out.stdout);
    let (mut adds, mut dels) = (0i64, 0i64);
    for line in text.lines() {
        let mut cols = line.split('\t');
        adds += cols.next().unwrap_or("").parse::<i64>().unwrap_or(0);
        dels += cols.next().unwrap_or("").parse::<i64>().unwrap_or(0);
    }
    (adds, dels)
}

/// Fetch a PR's `(additions, deletions)` from the REST detail endpoint in
/// `repo` ("owner/name"). GitHub computes these server-side, so this is correct
/// for cross-fork PRs (unlike a local numstat, which can't see a fork's head
/// branch). Best effort — returns `None` on any error so the row keeps 0/0.
fn rest_pr_line_stats(repo: &str, number: i64, token: &str) -> Option<(i64, i64)> {
    let url = format!("{}/repos/{}/pulls/{}", API_BASE, repo, number);
    let v = api_json("GET", &url, token, None).ok()?;
    Some((ji(&v, "additions"), ji(&v, "deletions")))
}

/// Fetch a PR object, trying `origin` first and falling back to the upstream
/// parent (for fork → upstream PRs that don't live in origin). Returns the
/// `owner/repo` the PR actually lives in alongside its JSON, so callers issue
/// follow-up requests against the right repo.
fn get_pr_json(cwd: &str, number: i64, token: &str) -> Result<(String, serde_json::Value), String> {
    let (owner, repo) = owner_repo(cwd)?;
    let origin = format!("{}/{}", owner, repo);
    let (st, body) = curl_raw(
        "GET",
        &format!("{}/repos/{}/pulls/{}", API_BASE, origin, number),
        Some(token),
        None,
        "application/vnd.github+json",
    )?;
    if st < 400 {
        let v = serde_json::from_str(body.trim()).map_err(|e| format!("parse PR: {}", e))?;
        return Ok((origin, v));
    }
    if st == 404 {
        if let Some(parent) = upstream_parent(cwd, token) {
            let (st2, body2) = curl_raw(
                "GET",
                &format!("{}/repos/{}/pulls/{}", API_BASE, parent, number),
                Some(token),
                None,
                "application/vnd.github+json",
            )?;
            if st2 < 400 {
                let v = serde_json::from_str(body2.trim()).map_err(|e| format!("parse PR: {}", e))?;
                return Ok((parent, v));
            }
        }
    }
    Err(format!("GitHub API error ({}) fetching PR #{}", st, number))
}

pub(crate) fn rest_pr_count(cwd: &str, state: &str, token: &str) -> Result<i64, String> {
    let base = base_owner_repo(cwd, token).unwrap_or_else(|_| {
        let (o, r) = owner_repo(cwd).unwrap_or_default();
        format!("{}/{}", o, r)
    });
    let qualifier = match state.to_lowercase().as_str() {
        "closed" => "+state:closed",
        "merged" => "+is:merged",
        "all" => "",
        _ => "+state:open",
    };
    // /search/issues returns total_count without expanding every item.
    let url = format!(
        "{}/search/issues?q=repo:{}+type:pr{}&per_page=1",
        API_BASE, enc_nwo(&base), qualifier
    );
    let v = api_json("GET", &url, token, None)?;
    Ok(v.get("total_count").and_then(|c| c.as_i64()).unwrap_or(0))
}

pub(crate) fn rest_pr_detail(cwd: &str, number: i64, token: &str) -> Result<PullRequestDetail, String> {
    let (repo, v) = get_pr_json(cwd, number, token)?;
    let mut detail = json_to_detail(&v);
    // The REST PR object carries no CI status; aggregate the head commit's
    // check-runs so the CI tab can colour itself (red / yellow / green).
    let sha = jnested(&v, "head", "sha");
    detail.checks_status = rest_rollup_for_sha(&repo, &sha, token);
    // The nested `base.repo` in a pulls response omits the `permissions` block —
    // only the top-level repo endpoint returns it. `repo` is the *base* repo
    // (upstream for a fork), so this checks merge rights on the right side.
    if let Some(cm) = rest_repo_can_push(&repo, token) {
        detail.can_merge = Some(cm);
    }
    Ok(detail)
}

/// Whether the authenticated user has push (= merge) access to `repo`
/// (`owner/name`), via `GET /repos/{repo}`'s `permissions.push`. Returns `None`
/// on any failure so the UI falls back to error-only gating.
fn rest_repo_can_push(repo: &str, token: &str) -> Option<bool> {
    let url = format!("{}/repos/{}", API_BASE, repo);
    let v = api_json("GET", &url, token, None).ok()?;
    v.get("permissions")
        .and_then(|p| p.get("push"))
        .and_then(|b| b.as_bool())
}

pub(crate) fn rest_pr_diff(cwd: &str, number: i64, token: &str) -> Result<String, String> {
    // Resolve which repo the PR lives in (origin or upstream parent), then fetch
    // its diff from there.
    let (repo, _pr) = get_pr_json(cwd, number, token)?;
    let url = format!("{}/repos/{}/pulls/{}", API_BASE, repo, number);
    let (status, body) = curl_raw("GET", &url, Some(token), None, "application/vnd.github.v3.diff")?;
    if status >= 400 {
        return Err(format!("GitHub diff failed (HTTP {})", status));
    }
    Ok(body)
}

pub(crate) fn rest_pr_checks(cwd: &str, number: i64, token: &str) -> Result<Vec<CICheck>, String> {
    // Resolve repo + head SHA, then list check-runs for that commit.
    let (repo, pr) = get_pr_json(cwd, number, token)?;
    let sha = jnested(&pr, "head", "sha");
    if sha.is_empty() {
        return Ok(Vec::new());
    }
    let url = format!("{}/repos/{}/commits/{}/check-runs", API_BASE, repo, sha);
    let v = match api_json("GET", &url, token, None) {
        Ok(v) => v,
        Err(_) => return Ok(Vec::new()), // no checks configured — not fatal
    };
    let runs = v.get("check_runs").and_then(|r| r.as_array()).cloned().unwrap_or_default();
    let checks = runs
        .iter()
        .map(|run| CICheck {
            name: js(run, "name"),
            state: js(run, "status"),
            conclusion: js(run, "conclusion"),
            details_url: js(run, "html_url"),
        })
        .collect();
    Ok(checks)
}

pub(crate) fn rest_pr_files(cwd: &str, number: i64, token: &str) -> Result<Vec<String>, String> {
    let (repo, _pr) = get_pr_json(cwd, number, token)?;
    let url = format!("{}/repos/{}/pulls/{}/files?per_page=100", API_BASE, repo, number);
    let v = api_json("GET", &url, token, None)?;
    let files = v
        .as_array()
        .map(|arr| arr.iter().map(|f| js(f, "filename")).filter(|s| !s.is_empty()).collect())
        .unwrap_or_default();
    Ok(files)
}

/// Map a GitHub comment object to the snake_case shape the frontend
/// `PrReviewComment` interface expects. `issue_level` flags conversation
/// comments (not anchored to a diff line) so their path/line fields are nulled.
pub(crate) fn map_comment(c: &serde_json::Value, issue_level: bool) -> serde_json::Value {
    use serde_json::Value;
    let side = {
        let s = js(c, "side");
        if s.is_empty() { "RIGHT".to_string() } else { s }
    };
    serde_json::json!({
        "id": ji(c, "id"),
        "body": js(c, "body"),
        "author": jnested(c, "user", "login"),
        "created_at": js(c, "created_at"),
        "updated_at": js(c, "updated_at"),
        "path": if issue_level { String::new() } else { js(c, "path") },
        "line": if issue_level { Value::Null } else { c.get("line").cloned().unwrap_or(Value::Null) },
        "original_line": if issue_level { Value::Null } else { c.get("original_line").cloned().unwrap_or(Value::Null) },
        "side": if issue_level { "RIGHT".to_string() } else { side },
        "start_line": if issue_level { Value::Null } else { c.get("start_line").cloned().unwrap_or(Value::Null) },
        "start_side": if issue_level { Value::Null } else { c.get("start_side").cloned().unwrap_or(Value::Null) },
        "in_reply_to_id": if issue_level { Value::Null } else { c.get("in_reply_to_id").cloned().unwrap_or(Value::Null) },
        "diff_hunk": if issue_level { String::new() } else { js(c, "diff_hunk") },
        "url": js(c, "html_url"),
    })
}

/// Map a JSON array of GitHub comments into frontend `PrReviewComment` shape.
pub(crate) fn map_comments(v: &serde_json::Value, issue_level: bool) -> Vec<serde_json::Value> {
    v.as_array()
        .map(|arr| arr.iter().map(|c| map_comment(c, issue_level)).collect())
        .unwrap_or_default()
}

/// List inline review comments (anchored to diff lines) for a PR (REST).
pub(crate) fn rest_pr_comments(cwd: &str, number: i64, token: &str) -> Result<Vec<serde_json::Value>, String> {
    let (repo, _pr) = get_pr_json(cwd, number, token)?;
    let url = format!("{}/repos/{}/pulls/{}/comments?per_page=100", API_BASE, repo, number);
    let v = api_json("GET", &url, token, None)?;
    Ok(map_comments(&v, false))
}

/// List issue-level (conversation) comments for a PR (REST).
pub(crate) fn rest_pr_issue_comments(cwd: &str, number: i64, token: &str) -> Result<Vec<serde_json::Value>, String> {
    let (repo, _pr) = get_pr_json(cwd, number, token)?;
    let url = format!("{}/repos/{}/issues/{}/comments?per_page=100", API_BASE, repo, number);
    let v = api_json("GET", &url, token, None)?;
    Ok(map_comments(&v, true))
}

// ─── Issues (REST) ───────────────────────────────────────────────────────────
//
// Issues live in `origin` (they are never cross-fork like PRs), so the `nwo` is
// always the origin's owner/repo — no upstream fallback needed.

/// Map a GitHub REST issue object into the `IssueDetail` IPC shape.
fn json_to_issue_detail(v: &serde_json::Value) -> IssueDetail {
    let assignees = v
        .get("assignees")
        .and_then(|a| a.as_array())
        .map(|arr| arr.iter().map(|u| js(u, "login")).filter(|s| !s.is_empty()).collect())
        .unwrap_or_default();
    let labels = v
        .get("labels")
        .and_then(|a| a.as_array())
        .map(|arr| arr.iter().map(|l| js(l, "name")).filter(|s| !s.is_empty()).collect())
        .unwrap_or_default();
    // `milestone` is null when unset — js() on a non-object yields "".
    let milestone = v.get("milestone").map(|m| js(m, "title")).unwrap_or_default();
    IssueDetail {
        number: ji(v, "number"),
        title: js(v, "title"),
        body: js(v, "body"),
        state: js(v, "state"),
        author: jnested(v, "user", "login"),
        assignees,
        labels,
        url: js(v, "html_url"),
        created_at: js(v, "created_at"),
        updated_at: js(v, "updated_at"),
        milestone,
        comments: ji(v, "comments"),
    }
}

/// Fetch a single issue's detail (REST).
pub(crate) fn rest_issue_detail(cwd: &str, number: i64, token: &str) -> Result<IssueDetail, String> {
    let (owner, repo) = owner_repo(cwd)?;
    let url = format!("{}/repos/{}/{}/issues/{}", API_BASE, owner, repo, number);
    let v = api_json("GET", &url, token, None)?;
    Ok(json_to_issue_detail(&v))
}

/// Map a GitHub REST issue object into the lightweight `Issue` list IPC shape
/// (no body / comment-count — that's `IssueDetail`).
fn json_to_issue(v: &serde_json::Value) -> Issue {
    let assignees = v
        .get("assignees")
        .and_then(|a| a.as_array())
        .map(|arr| arr.iter().map(|u| js(u, "login")).filter(|s| !s.is_empty()).collect())
        .unwrap_or_default();
    let labels = v
        .get("labels")
        .and_then(|a| a.as_array())
        .map(|arr| arr.iter().map(|l| js(l, "name")).filter(|s| !s.is_empty()).collect())
        .unwrap_or_default();
    let milestone = v.get("milestone").map(|m| js(m, "title")).unwrap_or_default();
    Issue {
        number: ji(v, "number"),
        title: js(v, "title"),
        state: js(v, "state"),
        author: jnested(v, "user", "login"),
        assignees,
        labels,
        url: js(v, "html_url"),
        created_at: js(v, "created_at"),
        updated_at: js(v, "updated_at"),
        milestone,
    }
}

/// List a repo's open issues (REST), mirroring `gh issue list`'s `--state open`
/// behaviour and its `assigned` / `created` / `mentioned` filters.
///
/// `me` is the authenticated login, required for the filtered modes; pass `""`
/// for the unfiltered list (or when the login could not be resolved — the
/// filter then degrades to "all open" rather than returning nothing).
///
/// The REST `/issues` endpoint returns pull requests as issues (each carries a
/// `pull_request` key); we drop those so the Launchpad's Issues tab matches
/// `gh issue list`, which never includes PRs.
pub(crate) fn rest_list_issues(
    cwd: &str,
    filter: &str,
    me: &str,
    limit: i64,
    token: &str,
) -> Result<Vec<Issue>, String> {
    let (owner, repo) = owner_repo(cwd)?;
    let per_page = limit.clamp(1, 100);
    let mut url = format!(
        "{}/repos/{}/{}/issues?state=open&per_page={}&sort=updated&direction=desc",
        API_BASE, owner, repo, per_page
    );
    if !me.is_empty() {
        match filter {
            "assigned" => url.push_str(&format!("&assignee={}", me)),
            "created" => url.push_str(&format!("&creator={}", me)),
            "mentioned" => url.push_str(&format!("&mentioned={}", me)),
            _ => {}
        }
    }
    let raw = api_json("GET", &url, token, None)?
        .as_array()
        .cloned()
        .unwrap_or_default();
    let issues = raw
        .iter()
        .filter(|v| v.get("pull_request").is_none())
        .map(json_to_issue)
        .collect();
    Ok(issues)
}

/// List conversation comments for an issue (REST).
pub(crate) fn rest_issue_comments(cwd: &str, number: i64, token: &str) -> Result<Vec<serde_json::Value>, String> {
    let (owner, repo) = owner_repo(cwd)?;
    let url = format!("{}/repos/{}/{}/issues/{}/comments?per_page=100", API_BASE, owner, repo, number);
    let v = api_json("GET", &url, token, None)?;
    Ok(map_comments(&v, true))
}

/// Add a comment to an issue (REST). Returns the created comment, mapped.
pub(crate) fn rest_issue_add_comment(cwd: &str, number: i64, body: &str, token: &str) -> Result<serde_json::Value, String> {
    let (owner, repo) = owner_repo(cwd)?;
    let url = format!("{}/repos/{}/{}/issues/{}/comments", API_BASE, owner, repo, number);
    let payload = serde_json::json!({ "body": body });
    let v = api_json("POST", &url, token, Some(&payload.to_string()))?;
    Ok(map_comment(&v, true))
}

/// Close or reopen an issue (REST). `state` is "closed" or "open".
pub(crate) fn rest_issue_set_state(cwd: &str, number: i64, state: &str, token: &str) -> Result<(), String> {
    let (owner, repo) = owner_repo(cwd)?;
    let url = format!("{}/repos/{}/{}/issues/{}", API_BASE, owner, repo, number);
    let payload = serde_json::json!({ "state": state });
    api_json("PATCH", &url, token, Some(&payload.to_string()))?;
    Ok(())
}

/// Map a GitHub review object to the snake_case shape the frontend `PrReview`
/// interface expects.
pub(crate) fn map_review(r: &serde_json::Value) -> serde_json::Value {
    serde_json::json!({
        "id": ji(r, "id"),
        "state": js(r, "state"),
        "body": js(r, "body"),
        "user": {
            "login": jnested(r, "user", "login"),
            "avatar_url": jnested(r, "user", "avatar_url"),
        },
        "submitted_at": js(r, "submitted_at"),
        "html_url": js(r, "html_url"),
    })
}

/// Map a JSON array of GitHub reviews into frontend `PrReview` shape.
pub(crate) fn map_reviews(v: &serde_json::Value) -> Vec<serde_json::Value> {
    v.as_array()
        .map(|arr| arr.iter().map(map_review).collect())
        .unwrap_or_default()
}

/// List submitted reviews for a PR (REST).
pub(crate) fn rest_pr_reviews(cwd: &str, number: i64, token: &str) -> Result<Vec<serde_json::Value>, String> {
    let (repo, _pr) = get_pr_json(cwd, number, token)?;
    let url = format!("{}/repos/{}/pulls/{}/reviews?per_page=100", API_BASE, repo, number);
    let v = api_json("GET", &url, token, None)?;
    Ok(map_reviews(&v))
}

/// Resolve the current repo's fork relationship (REST).
pub(crate) fn rest_fork_info(cwd: &str, token: &str) -> Result<ForkInfo, String> {
    let (owner, repo) = owner_repo(cwd)?;
    let origin = format!("{}/{}", owner, repo);
    let info = api_json("GET", &format!("{}/repos/{}/{}", API_BASE, owner, repo), token, None)?;
    let is_fork = info.get("fork").and_then(|f| f.as_bool()).unwrap_or(false);
    let parent = info
        .get("parent")
        .and_then(|p| p.get("full_name"))
        .and_then(|n| n.as_str())
        .unwrap_or("")
        .to_string();
    Ok(ForkInfo { is_fork, origin, parent })
}

/// The upstream parent `owner/repo` when the current repo is a fork, else None.
/// Centralizes the `is_fork && !parent.is_empty()` guard shared by the PR list
/// and the origin→upstream PR fallback.
fn upstream_parent(cwd: &str, token: &str) -> Option<String> {
    let fi = rest_fork_info(cwd, token).ok()?;
    (fi.is_fork && !fi.parent.is_empty()).then_some(fi.parent)
}

/// The canonical base `owner/repo` for PRs. For a fork, this is the upstream
/// parent. For a regular repo, it's the repo itself.
fn base_owner_repo(cwd: &str, token: &str) -> Result<String, String> {
    let fi = rest_fork_info(cwd, token)?;
    if fi.is_fork && !fi.parent.is_empty() {
        Ok(fi.parent)
    } else {
        Ok(fi.origin)
    }
}

pub(crate) fn rest_create_pr(
    cwd: &str,
    title: String,
    body: String,
    base: String,
    base_repo: Option<String>,
    draft: bool,
    reviewers: Option<Vec<String>>,
    token: &str,
) -> Result<PullRequest, String> {
    let (owner, repo) = owner_repo(cwd)?;
    let head_branch = current_branch(cwd)?;
    let origin = format!("{}/{}", owner, repo);

    // Target repo: caller-supplied (cross-fork) or origin. A cross-fork PR must
    // qualify the head ref as "fork-owner:branch".
    let target = match base_repo {
        Some(r) if !r.trim().is_empty() => r.trim().to_string(),
        _ => origin.clone(),
    };
    let is_cross = target != origin;
    let head = if is_cross {
        format!("{}:{}", owner, head_branch)
    } else {
        head_branch
    };

    // Resolve base from the *target* repo's default branch when left empty.
    let base = if base.is_empty() {
        let repo_info = api_json("GET", &format!("{}/repos/{}", API_BASE, target), token, None)?;
        let default = js(&repo_info, "default_branch");
        if default.is_empty() { "main".to_string() } else { default }
    } else {
        base
    };

    let payload = serde_json::json!({
        "title": title,
        "head": head,
        "base": base,
        "body": body,
        "draft": draft,
    });
    let url = format!("{}/repos/{}/pulls", API_BASE, target);
    let created = api_json("POST", &url, token, Some(&payload.to_string()))?;
    let number = ji(&created, "number");

    // Best-effort reviewer request — never fail PR creation if this errors.
    if let Some(revs) = reviewers {
        let cleaned: Vec<String> = revs
            .into_iter()
            .map(|r| r.trim().trim_start_matches('@').to_string())
            .filter(|r| !r.is_empty())
            .collect();
        if !cleaned.is_empty() && number > 0 {
            let rev_payload = serde_json::json!({ "reviewers": cleaned });
            let rev_url = format!(
                "{}/repos/{}/pulls/{}/requested_reviewers",
                API_BASE, target, number
            );
            let _ = api_json("POST", &rev_url, token, Some(&rev_payload.to_string()));
        }
    }

    Ok(json_to_pr(&created))
}

pub(crate) fn rest_merge_pr(cwd: &str, number: i64, method: &str, token: &str) -> Result<(), String> {
    let merge_method = match method {
        "squash" => "squash",
        "rebase" => "rebase",
        _ => "merge",
    };
    // Resolve the repo (origin or upstream) + head branch for cleanup.
    let (repo, pr) = get_pr_json(cwd, number, token)?;
    let branch = jnested(&pr, "head", "ref");

    let payload = serde_json::json!({ "merge_method": merge_method });
    let url = format!("{}/repos/{}/pulls/{}/merge", API_BASE, repo, number);
    api_json("PUT", &url, token, Some(&payload.to_string()))?;

    // Best-effort branch deletion (mirrors `gh pr merge --delete-branch`).
    if !branch.is_empty() {
        let ref_url = format!("{}/repos/{}/git/refs/heads/{}", API_BASE, repo, branch);
        let _ = api_json("DELETE", &ref_url, token, None);
    }
    Ok(())
}

pub(crate) fn rest_pr_ready(cwd: &str, number: i64, token: &str) -> Result<(), String> {
    // Draft→ready is GraphQL-only; resolve the PR node_id first (origin or upstream).
    let (_repo, pr) = get_pr_json(cwd, number, token)?;
    let node_id = js(&pr, "node_id");
    if node_id.is_empty() {
        return Err("Could not resolve PR node_id for ready conversion.".to_string());
    }
    // Pass node_id as a GraphQL variable instead of interpolating it into the
    // query string, so a value with quotes/backslashes can never break out of
    // the mutation (node IDs are opaque API-supplied values — treat as untrusted).
    let query = "mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { isDraft } } }";
    graphql(token, query, serde_json::json!({ "id": node_id }))?;
    Ok(())
}

pub(crate) fn rest_checkout_pr(cwd: &str, number: i64) -> Result<(), String> {
    // Local git fetch of the PR head ref — token not needed (git uses its own
    // credential helper). Works for same-repo and fork PRs alike.
    let local = format!("pr-{}", number);
    let refspec = format!("pull/{}/head:{}", number, local);
    let fetch = git_cmd()
        .args(["fetch", "origin", &refspec])
        .current_dir(cwd)
        .output()
        .map_err(|e| format!("git fetch failed: {}", e))?;
    if !fetch.status.success() {
        return Err(format!(
            "git fetch pull/{}/head failed: {}",
            number,
            String::from_utf8_lossy(&fetch.stderr).trim()
        ));
    }
    let checkout = git_cmd()
        .args(["checkout", &local])
        .current_dir(cwd)
        .output()
        .map_err(|e| format!("git checkout failed: {}", e))?;
    if !checkout.status.success() {
        return Err(format!(
            "git checkout {} failed: {}",
            local,
            String::from_utf8_lossy(&checkout.stderr).trim()
        ));
    }
    Ok(())
}

// ─── Reactions ──────────────────────────────────────────────────────────────

pub(crate) fn map_reaction(r: &serde_json::Value) -> serde_json::Value {
    serde_json::json!({
        "id": ji(r, "id"),
        "content": js(r, "content"),
        "user": jnested(r, "user", "login"),
    })
}

fn reactions_url(repo: &str, target_type: &str, target_id: i64) -> String {
    match target_type {
        "pr" => format!("{}/repos/{}/issues/{}/reactions", API_BASE, repo, target_id),
        "review_comment" => format!("{}/repos/{}/pulls/comments/{}/reactions", API_BASE, repo, target_id),
        _ => format!("{}/repos/{}/issues/comments/{}/reactions", API_BASE, repo, target_id),
    }
}

fn reaction_delete_url(repo: &str, target_type: &str, target_id: i64, reaction_id: i64) -> String {
    format!("{}/{}", reactions_url(repo, target_type, target_id), reaction_id)
}

// ── Review-summary reactions (GraphQL) ──────────────────────────────────────
// A pull-request *review* verdict isn't reactable through the REST reactions
// API (it only covers issues, issue comments and inline review comments), but
// `PullRequestReview` implements GraphQL's `Reactable`. The `"review"` target
// type routes here; everything else stays on REST above.

/// Map a REST reaction content string ("+1", "laugh"…) to the GraphQL
/// `ReactionContent` enum. Returns `None` for an unknown emoji.
fn reaction_content_to_gql(content: &str) -> Option<&'static str> {
    Some(match content {
        "+1" => "THUMBS_UP",
        "-1" => "THUMBS_DOWN",
        "laugh" => "LAUGH",
        "confused" => "CONFUSED",
        "heart" => "HEART",
        "hooray" => "HOORAY",
        "rocket" => "ROCKET",
        "eyes" => "EYES",
        _ => return None,
    })
}

/// Map a GraphQL `ReactionContent` enum back to the REST content string the
/// frontend `PrReaction` shape uses.
fn reaction_content_from_gql(content: &str) -> &str {
    match content {
        "THUMBS_UP" => "+1",
        "THUMBS_DOWN" => "-1",
        "LAUGH" => "laugh",
        "CONFUSED" => "confused",
        "HEART" => "heart",
        "HOORAY" => "hooray",
        "ROCKET" => "rocket",
        "EYES" => "eyes",
        other => other,
    }
}

/// Map a GraphQL reaction node (`{ databaseId, content, user { login } }`) into
/// the same `PrReaction` shape `map_reaction` produces for REST.
fn map_gql_reaction(r: &serde_json::Value) -> serde_json::Value {
    serde_json::json!({
        "id": ji(r, "databaseId"),
        "content": reaction_content_from_gql(&js(r, "content")),
        "user": jnested(r, "user", "login"),
    })
}

/// Run a GraphQL operation and surface the first `errors[]` entry as an `Err`.
fn graphql(token: &str, query: &str, variables: serde_json::Value) -> Result<serde_json::Value, String> {
    let payload = serde_json::json!({ "query": query, "variables": variables });
    let v = api_json("POST", &format!("{}/graphql", API_BASE), token, Some(&payload.to_string()))?;
    if let Some(errors) = v.get("errors").and_then(|e| e.as_array()) {
        if let Some(first) = errors.first() {
            let msg = first.get("message").and_then(|m| m.as_str()).unwrap_or("GraphQL error");
            return Err(format!("GraphQL error: {}", msg));
        }
    }
    Ok(v)
}

/// Resolve a review's opaque GraphQL node id from its REST numeric id.
fn review_node_id(repo: &str, number: i64, review_id: i64, token: &str) -> Result<String, String> {
    let url = format!("{}/repos/{}/pulls/{}/reviews/{}", API_BASE, repo, number, review_id);
    let v = api_json("GET", &url, token, None)?;
    let id = js(&v, "node_id");
    if id.is_empty() {
        return Err("Could not resolve review node_id".to_string());
    }
    Ok(id)
}

/// Reactions on an already-resolved review node — shared by the public list
/// and the delete lookup so the node id is resolved only once per operation.
fn gql_reactions_for_node(node: &str, token: &str) -> Result<Vec<serde_json::Value>, String> {
    let query = "query($id: ID!) { node(id: $id) { ... on PullRequestReview { reactions(first: 100) { nodes { databaseId content user { login } } } } } }";
    let v = graphql(token, query, serde_json::json!({ "id": node }))?;
    let nodes = v
        .pointer("/data/node/reactions/nodes")
        .and_then(|n| n.as_array())
        .cloned()
        .unwrap_or_default();
    Ok(nodes.iter().map(map_gql_reaction).collect())
}

fn gql_list_review_reactions(repo: &str, number: i64, review_id: i64, token: &str) -> Result<Vec<serde_json::Value>, String> {
    let node = review_node_id(repo, number, review_id, token)?;
    gql_reactions_for_node(&node, token)
}

fn gql_add_review_reaction(repo: &str, number: i64, review_id: i64, content: &str, token: &str) -> Result<serde_json::Value, String> {
    let gql_content = reaction_content_to_gql(content).ok_or_else(|| format!("Unsupported reaction: {}", content))?;
    let node = review_node_id(repo, number, review_id, token)?;
    let query = "mutation($id: ID!, $c: ReactionContent!) { addReaction(input: { subjectId: $id, content: $c }) { reaction { databaseId content user { login } } } }";
    let v = graphql(token, query, serde_json::json!({ "id": node, "c": gql_content }))?;
    let reaction = v.pointer("/data/addReaction/reaction").cloned().unwrap_or(serde_json::Value::Null);
    Ok(map_gql_reaction(&reaction))
}

fn gql_delete_review_reaction(repo: &str, number: i64, review_id: i64, reaction_id: i64, token: &str) -> Result<(), String> {
    // GraphQL's removeReaction keys off content, not the reaction id, so look up
    // the content of the reaction being removed first. Resolve the node once and
    // reuse it for both the lookup and the mutation.
    let node = review_node_id(repo, number, review_id, token)?;
    let existing = gql_reactions_for_node(&node, token)?;
    let Some(target) = existing.iter().find(|r| r.get("id").and_then(|x| x.as_i64()) == Some(reaction_id)) else {
        return Ok(()); // already gone
    };
    let rest_content = target.get("content").and_then(|c| c.as_str()).unwrap_or("");
    let gql_content = reaction_content_to_gql(rest_content).ok_or_else(|| format!("Unsupported reaction: {}", rest_content))?;
    let query = "mutation($id: ID!, $c: ReactionContent!) { removeReaction(input: { subjectId: $id, content: $c }) { reaction { databaseId } } }";
    graphql(token, query, serde_json::json!({ "id": node, "c": gql_content }))?;
    Ok(())
}

/// List reactions for a PR or one of its comments.
/// `target_type`: `"pr"` | `"review_comment"` | `"issue_comment"` | `"review"`.
/// `target_id`: PR number for `"pr"`, comment/review id otherwise.
/// Uses `get_pr_json` to resolve the correct repo (handles forks).
pub(crate) fn rest_list_reactions(
    cwd: &str,
    number: i64,
    target_type: &str,
    target_id: i64,
    token: &str,
) -> Result<Vec<serde_json::Value>, String> {
    let (repo, _) = get_pr_json(cwd, number, token)?;
    if target_type == "review" {
        return gql_list_review_reactions(&repo, number, target_id, token);
    }
    let url = reactions_url(&repo, target_type, target_id);
    let v = api_json("GET", &url, token, None)?;
    Ok(v.as_array().map(|a| a.iter().map(|r| map_reaction(r)).collect()).unwrap_or_default())
}

pub(crate) fn rest_add_reaction(
    cwd: &str,
    number: i64,
    target_type: &str,
    target_id: i64,
    content: &str,
    token: &str,
) -> Result<serde_json::Value, String> {
    let (repo, _) = get_pr_json(cwd, number, token)?;
    if target_type == "review" {
        return gql_add_review_reaction(&repo, number, target_id, content, token);
    }
    let url = reactions_url(&repo, target_type, target_id);
    let payload = serde_json::json!({ "content": content });
    let v = api_json("POST", &url, token, Some(&payload.to_string()))?;
    Ok(map_reaction(&v))
}

pub(crate) fn rest_delete_reaction(
    cwd: &str,
    number: i64,
    target_type: &str,
    target_id: i64,
    reaction_id: i64,
    token: &str,
) -> Result<(), String> {
    let (repo, _) = get_pr_json(cwd, number, token)?;
    if target_type == "review" {
        return gql_delete_review_reaction(&repo, number, target_id, reaction_id, token);
    }
    let url = reaction_delete_url(&repo, target_type, target_id, reaction_id);
    api_json("DELETE", &url, token, None)?;
    Ok(())
}

// ─── OAuth device flow ──────────────────────────────────────────────────────

fn github_device_start_inner() -> Result<GithubDeviceCode, String> {
    let cid = client_id();
    // GitHub's OAuth endpoints accept a JSON body when Content-Type is JSON
    // (which `curl_raw` sets whenever a body is present).
    let body = serde_json::json!({ "client_id": cid, "scope": "repo" });
    let (status, text) = curl_raw(
        "POST",
        "https://github.com/login/device/code",
        None,
        Some(&body.to_string()),
        "application/json",
    )?;
    if status >= 400 {
        return Err(format!("GitHub device-code request failed (HTTP {})", status));
    }
    let v: serde_json::Value = serde_json::from_str(text.trim())
        .map_err(|e| format!("Failed to parse device-code response: {}", e))?;
    if let Some(err) = v.get("error").and_then(|e| e.as_str()) {
        return Err(format!("GitHub device-code error: {}", err));
    }
    Ok(GithubDeviceCode {
        device_code: js(&v, "device_code"),
        user_code: js(&v, "user_code"),
        verification_uri: js(&v, "verification_uri"),
        verification_uri_complete: js(&v, "verification_uri_complete"),
        expires_in: ji(&v, "expires_in"),
        interval: ji(&v, "interval").max(5),
    })
}

/// Begin the OAuth device flow. Returns the user code + verification URL the
/// frontend shows, plus the `device_code` used for polling.
#[tauri::command]
pub(crate) async fn github_device_start() -> Result<GithubDeviceCode, String> {
    tauri::async_runtime::spawn_blocking(github_device_start_inner)
        .await
        .map_err(|e| e.to_string())?
}

fn github_device_poll_inner(device_code: String) -> Result<GithubDevicePoll, String> {
    let cid = client_id();
    let body = serde_json::json!({
        "client_id": cid,
        "device_code": device_code,
        "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
    });
    let (status, text) = curl_raw(
        "POST",
        "https://github.com/login/oauth/access_token",
        None,
        Some(&body.to_string()),
        "application/json",
    )?;
    if status >= 400 {
        return Err(format!("GitHub token poll failed (HTTP {})", status));
    }
    let v: serde_json::Value = serde_json::from_str(text.trim())
        .map_err(|e| format!("Failed to parse token response: {}", e))?;

    if let Some(err) = v.get("error").and_then(|e| e.as_str()) {
        let kind = match err {
            "authorization_pending" => "pending",
            "slow_down" => "slow_down",
            _ => "error",
        };
        return Ok(GithubDevicePoll {
            status: kind.to_string(),
            login: String::new(),
            error: if kind == "error" { err.to_string() } else { String::new() },
        });
    }

    let token = js(&v, "access_token");
    if token.is_empty() {
        return Ok(GithubDevicePoll {
            status: "pending".to_string(),
            login: String::new(),
            error: String::new(),
        });
    }

    // Persist to keychain so the REST path activates.
    let entry = keyring::Entry::new(GH_SERVICE, GH_ACCOUNT)
        .map_err(|e| format!("keyring init failed: {}", e))?;
    entry
        .set_password(&token)
        .map_err(|e| format!("Failed to store GitHub token: {}", e))?;

    // Resolve the login for display (non-fatal if it fails).
    let login = rest_current_user(&token).unwrap_or_default();
    Ok(GithubDevicePoll {
        status: "success".to_string(),
        login,
        error: String::new(),
    })
}

/// Poll once for the OAuth access token.
///
/// `status` is one of: `"pending"` (keep polling), `"slow_down"` (back off),
/// `"success"` (token stored, `login` populated), or `"error"`.
/// On success the token is persisted to the OS keychain so the REST path can
/// pick it up; the secret is never returned to the frontend.
#[tauri::command]
pub(crate) async fn github_device_poll(device_code: String) -> Result<GithubDevicePoll, String> {
    tauri::async_runtime::spawn_blocking(move || github_device_poll_inner(device_code))
        .await
        .map_err(|e| e.to_string())?
}

/// Whether a Settings-managed GitHub token is currently stored.
#[tauri::command]
pub(crate) async fn github_token_present() -> Result<bool, String> {
    Ok(settings_github_token().is_some())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn rollup_from_check_runs_failure_wins() {
        let runs = vec![
            json!({"status": "COMPLETED", "conclusion": "SUCCESS"}),
            json!({"status": "COMPLETED", "conclusion": "FAILURE"}),
            json!({"status": "COMPLETED", "conclusion": "SUCCESS"}),
        ];
        assert_eq!(rollup_from_check_runs(&runs), "FAILURE");
    }

    #[test]
    fn rollup_from_check_runs_pending_when_incomplete() {
        let runs = vec![
            json!({"status": "COMPLETED", "conclusion": "SUCCESS"}),
            json!({"status": "IN_PROGRESS", "conclusion": null}),
        ];
        assert_eq!(rollup_from_check_runs(&runs), "PENDING");
    }

    #[test]
    fn rollup_from_check_runs_success_only_when_all_pass() {
        let runs = vec![
            json!({"status": "COMPLETED", "conclusion": "SUCCESS"}),
            json!({"status": "COMPLETED", "conclusion": "SKIPPED"}),
            json!({"status": "COMPLETED", "conclusion": "NEUTRAL"}),
        ];
        assert_eq!(rollup_from_check_runs(&runs), "SUCCESS");
        assert_eq!(rollup_from_check_runs(&[]), "");
    }

    #[test]
    fn rollup_treats_action_required_as_failure() {
        let runs = vec![json!({"status": "COMPLETED", "conclusion": "ACTION_REQUIRED"})];
        assert_eq!(rollup_from_check_runs(&runs), "FAILURE");
    }

    #[test]
    fn json_to_pr_marks_merged_from_merged_at() {
        let pr = json!({
            "number": 42, "title": "t", "state": "closed",
            "merged_at": "2026-01-01T00:00:00Z",
            "user": {"login": "alice"},
            "head": {"ref": "feat"}, "base": {"ref": "main"},
        });
        let out = json_to_pr(&pr);
        assert_eq!(out.number, 42);
        assert_eq!(out.state, "merged");
        assert_eq!(out.author, "alice");
        assert_eq!(out.branch, "feat");
        assert_eq!(out.base, "main");
    }

    #[test]
    fn json_to_pr_review_decision_proxy_from_requested_reviewers() {
        // Non-empty requested_reviewers ⇒ still waiting on review.
        let pending = json!({
            "number": 1, "state": "open",
            "requested_reviewers": [{"login": "bob"}],
        });
        assert_eq!(json_to_pr(&pending).review_decision, "REVIEW_REQUIRED");
        assert_eq!(json_to_pr(&pending).review_requested, vec!["bob".to_string()]);

        let cleared = json!({"number": 2, "state": "open", "requested_reviewers": []});
        assert_eq!(json_to_pr(&cleared).review_decision, "");
    }

    #[test]
    fn map_comment_nulls_path_and_line_for_issue_level() {
        let c = json!({
            "id": 7, "body": "hi", "user": {"login": "u"},
            "path": "src/x.rs", "line": 10, "side": "LEFT",
        });
        let inline = map_comment(&c, false);
        assert_eq!(inline["path"], json!("src/x.rs"));
        assert_eq!(inline["line"], json!(10));
        assert_eq!(inline["side"], json!("LEFT"));

        let issue = map_comment(&c, true);
        assert_eq!(issue["path"], json!(""));
        assert_eq!(issue["line"], serde_json::Value::Null);
        assert_eq!(issue["side"], json!("RIGHT"));
    }

    #[test]
    fn bearer_config_keeps_token_in_header_directive() {
        assert_eq!(
            bearer_config("ghp_abc123"),
            "header = \"Authorization: Bearer ghp_abc123\"\n"
        );
    }
}

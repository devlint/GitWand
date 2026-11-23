//! GitHub CLI (`gh`) Tauri commands (§3.4e migration).
//!
//! Wrappers around the `gh` CLI for pull-request workflows:
//! list, create, checkout, merge, detail, diff, checks + reviewer
//! candidate discovery.
//!
//! All commands rely on:
//!   - `hidden_cmd("gh")` from `crate::git::cmd` to spawn `gh` without
//!     surfacing a console window on Windows.
//!   - `crate::git::parse::{parse_gh_pr_json, gh_pr_raw_to_pr,
//!     gh_pr_detail_raw_to_detail, extract_json_string}` for response
//!     deserialization (already centralized in §3.4a).
//!   - `crate::types::{PullRequest, PullRequestDetail, ReviewerCandidate,
//!     CICheck, GhPrRaw, GhPrDetailRaw}` for the IPC shapes.
//!
//! ## Async / blocking note
//!
//! All Tauri commands here do blocking I/O (subprocess spawns via `gh`/`curl`
//! or OS keychain reads). They are declared `async` and offloaded with
//! `spawn_blocking` — matching `azure.rs` — so the Tokio executor thread is
//! never held by a synchronous wait.

use crate::commands::github_api;
use crate::git::*;
use crate::types::*;
use rayon::prelude::*;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// Timeout for the primary `gh` invocation in `gh_list_prs_inner`. Mirrors
/// `gitlab.rs`'s `GLAB_TIMEOUT` (#149) — chosen to leave headroom under the
/// frontend's 30s IPC race (`backend-core.ts`'s `IPC_TIMEOUT.DEFAULT`) so a
/// Rust "timed out" error surfaces instead of the frontend's generic "IPC
/// timeout after 30000ms" message. Before this, `gh pr list` ran unbounded —
/// devlint/GitWand#161 reported the 30s timeout reappearing once the per-PR
/// stats enrichment below was added.
const GH_TIMEOUT: Duration = Duration::from_secs(20);
/// Timeout for the best-effort `git fetch origin` that refreshes
/// remote-tracking refs before the per-PR numstat diffs below.
const GH_FETCH_TIMEOUT: Duration = Duration::from_secs(5);
/// Minimum interval between `git fetch origin` calls per repo — mirrors
/// `azure.rs`'s `FETCH_MIN_INTERVAL`. Without this, every first-page
/// `gh_list_prs` call (initial load, poll, panel reopen) fired a blocking
/// network fetch even when the previous one was seconds ago.
const GH_FETCH_MIN_INTERVAL: Duration = Duration::from_secs(30);

fn gh_last_fetch_map() -> &'static Mutex<HashMap<String, Instant>> {
    static MAP: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Returns `true` (and records `now`) when `cwd` has not been fetched within
/// `GH_FETCH_MIN_INTERVAL`; otherwise `false` so callers can skip the fetch.
fn gh_should_fetch_origin(cwd: &str) -> bool {
    let now = Instant::now();
    let mut map = match gh_last_fetch_map().lock() {
        Ok(m) => m,
        Err(p) => p.into_inner(), // a poisoned lock must not block PR loading
    };
    match map.get(cwd) {
        Some(prev) if now.duration_since(*prev) < GH_FETCH_MIN_INTERVAL => false,
        _ => {
            map.insert(cwd.to_string(), now);
            true
        }
    }
}

// ─── Inner (sync) implementations ───────────────────────────────────────────
//
// Each Tauri command delegates to a private sync fn so the async wrapper
// can offload all blocking work via `spawn_blocking` without deep nesting.

fn gh_list_prs_inner(
    cwd: String,
    state: String,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<Vec<PullRequest>, String> {
    // Settings-managed token present → tokenless REST path (no `gh` needed).
    if let Some(r) = github_api::with_rest(&cwd, |tok| {
        let st = if state.is_empty() { "open" } else { &state };
        github_api::rest_list_prs(&cwd, st, limit.unwrap_or(10), offset.unwrap_or(0), tok)
    }) {
        return r;
    }
    let st = if state.is_empty() { "open" } else { &state };
    // Naïve pagination: `gh pr list` has no native --offset, so we ask for
    // `offset + limit` and slice. Works correctly for the small windows the
    // UI uses (10/20/30) and stays well under any token rate-limit budget.
    // TODO Phase 2 (v2.9): replace with a cursor-based `gh api graphql`
    // query so we don't re-fetch already-loaded pages on each scroll.
    let page = limit.unwrap_or(10).max(1);
    let off = offset.unwrap_or(0).max(0);
    let total = (page + off).to_string();

    // Name the repo explicitly: left to itself, `gh` would list a fork's own
    // PRs (none) or an unrelated `upstream` remote's (#298). The base repo
    // matches what the OAuth/REST path lists.
    // GH_TOKEN propagation is handled centrally by `hidden_cmd` (cf. git/cmd.rs).
    let mut cmd = gh_base_cmd(&cwd)?;
    cmd.args([
        "pr", "list",
        "--state", st,
        "--json", "number,title,state,author,headRefName,baseRefName,isDraft,createdAt,updatedAt,url,labels,assignees,mergeStateStatus,statusCheckRollup,autoMergeRequest",
        "--limit", &total,
    ]);
    cmd.current_dir(&cwd);
    let output = output_with_timeout(cmd, GH_TIMEOUT)
        .map_err(|e| format!("Failed to run gh pr list (is GitHub CLI installed?): {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("gh pr list failed: {}", stderr));
    }

    // Parse JSON output from gh CLI
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut prs = parse_gh_pr_json(&stdout)?;
    if off > 0 {
        let skip = (off as usize).min(prs.len());
        prs.drain(..skip);
    }

    // Enrich +/- stats via local git diff — mirrors rest_list_prs behaviour.
    // Fetch remote branches once so numstat can resolve origin/branch refs,
    // throttled per-repo (#161) so a poll or panel reopen within
    // `GH_FETCH_MIN_INTERVAL` reuses the previous fetch instead of firing a
    // fresh blocking network call every time.
    if !prs.is_empty() && off == 0 && gh_should_fetch_origin(&cwd) {
        // Write guard: refreshing remote-tracking refs mutates `.git` and can
        // race the single-repo view of the same repo on `index.lock`. Held only
        // around the fetch — the numstat diffs below are read-only.
        let _repo = repo_lock::write(&cwd);
        let mut fetch_cmd = hidden_cmd("git");
        fetch_cmd.args(["fetch", "origin"]).current_dir(&cwd);
        let _ = output_with_timeout(fetch_cmd, GH_FETCH_TIMEOUT);
    }
    // Parallel, not sequential (#161) — one `git diff --numstat` subprocess
    // per PR in series was the other half of the reappeared 30s timeout.
    prs.par_iter_mut().for_each(|pr| {
        let (adds, dels) = github_api::diff_numstat(&cwd, &pr.branch, &pr.base);
        pr.additions = adds;
        pr.deletions = dels;
    });

    Ok(prs)
}

/// List pull requests using `gh` CLI.
///
/// **Perf note** : `statusCheckRollup`, `mergeStateStatus`, `reviewRequests`,
/// `reviewDecision`, `additions` and `deletions` each cost a per-PR roundtrip
/// to the GitHub API internally — gh expands the GraphQL edge by issuing a
/// checks endpoint hit per PR. For a repo with 100+ open PRs (e.g. dendreo),
/// the full query took >30s and tripped the IPC timeout.
///
/// v2.8.5 — Boot perf chantier:
///   - `--limit 50 → 10` (first page); pagination handled via the `offset`
///     parameter from the frontend (`PrListSidebar` IntersectionObserver).
///   - JSON field list shrunk to 12 cheap fields. The heavy fields
///     (`statusCheckRollup`, `mergeStateStatus`, `reviewRequests`,
///     `reviewDecision`, `additions`, `deletions`) are now fetched lazily
///     per-PR when the user opens the detail view. Sidebar badges that
///     relied on them gracefully fall back to empty values until the user
///     selects the PR. See `PrListSidebar.vue` for the UI side.
///
/// TODO Phase 2 (v2.9): lazy per-PR enrichment via a dedicated
/// `gh_pr_status_rollup(cwd, numbers)` batched call that returns just the
/// CI/merge state pieces — keeps the list query light while still letting
/// the sidebar render CI/merge dots without a click.
#[tauri::command]
pub(crate) async fn gh_list_prs(
    cwd: String,
    state: String,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<Vec<PullRequest>, String> {
    tauri::async_runtime::spawn_blocking(move || gh_list_prs_inner(cwd, state, limit, offset))
        .await
        .map_err(|e| e.to_string())?
}

fn gh_pr_count_inner(cwd: String, state: String) -> Result<i64, String> {
    if let Some(r) = github_api::with_rest(&cwd, |tok| github_api::rest_pr_count(&cwd, &state, tok))
    {
        return r;
    }
    let st = state.to_lowercase();
    let states_expr = match st.as_str() {
        "closed" => "[CLOSED]",
        "merged" => "[MERGED]",
        "all" => "[OPEN, CLOSED, MERGED]",
        _ => "[OPEN]",
    };

    // The base repo — the fork parent for a fork, else `origin` — which is
    // the repo `gh_list_prs` lists (#298).
    let nwo = gh_base_nwo(&cwd)?;

    let (owner, name) = match nwo.split_once('/') {
        Some((o, n)) if !o.is_empty() && !n.is_empty() => (o.to_string(), n.to_string()),
        _ => return Err(format!("Unexpected nameWithOwner format: {}", nwo)),
    };

    // GraphQL query — single edge, no nested objects beyond totalCount.
    let query = format!(
        "query($owner:String!,$name:String!) {{ repository(owner:$owner,name:$name) {{ pullRequests(states:{}) {{ totalCount }} }} }}",
        states_expr
    );
    let out = gh_api_cmd(&cwd)
        .args([
            "api",
            "graphql",
            // `-f`: raw strings (`-F` would send `2048` as an integer and
            // read an `@…` value from a file).
            "-f",
            &format!("owner={}", owner),
            "-f",
            &format!("name={}", name),
            "-f",
            &format!("query={}", query),
        ])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("gh api graphql (pr count): {}", e))?;
    if !out.status.success() {
        return Err(format!(
            "gh api graphql pr count failed: {}",
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    let stdout = String::from_utf8_lossy(&out.stdout);

    // Cheap manual extraction of `"totalCount": N` — same rationale as
    // above: no serde_json import just for one integer. The response
    // shape is fixed by GitHub's schema so the substring lookup is safe.
    let key = "\"totalCount\"";
    let start = stdout
        .find(key)
        .ok_or_else(|| format!("totalCount missing from response: {}", stdout))?;
    let after = &stdout[start + key.len()..];
    let colon = after
        .find(':')
        .ok_or_else(|| "malformed totalCount".to_string())?;
    let tail = after[colon + 1..].trim_start();
    let end = tail
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(tail.len());
    if end == 0 {
        return Err(format!("totalCount has no digits: {}", tail));
    }
    tail[..end]
        .parse::<i64>()
        .map_err(|e| format!("totalCount parse: {}", e))
}

/// Lightweight PR count — single GraphQL `totalCount` call, no per-PR roundtrip.
///
/// Used at app boot (DashboardView) and as the sidebar badge source: the
/// dashboard only needs the number of open PRs, not the full list. Falling
/// back to the heavy `gh_list_prs` for a count was costing 1 roundtrip per
/// PR × 2 calls (open + merged) at every repo open (v2.8.4 → v2.8.5 perf
/// chantier).
///
/// Implementation: `gh api graphql` with the `pullRequests.totalCount` edge
/// on the base repo (`gh_base_nwo`, whose fork lookup is cached). Both calls
/// are cheap (<200 ms) and avoid expanding the PR objects.
///
/// `state` accepts "open" (default), "closed", "merged" or "all". `all`
/// maps to GraphQL `[OPEN, CLOSED, MERGED]`.
///
/// Returns 0 on any non-fatal failure (no remote, no token, etc.) so the
/// dashboard can still render — the caller decides whether to surface.
#[tauri::command]
pub(crate) async fn gh_pr_count(cwd: String, state: String) -> Result<i64, String> {
    tauri::async_runtime::spawn_blocking(move || gh_pr_count_inner(cwd, state))
        .await
        .map_err(|e| e.to_string())?
}

/// Pure extraction of `(number, updated_at)` from `gh pr list --json
/// number,updatedAt` output (already `--limit 1 -S "sort:updated-desc"`
/// sorted) — the gh CLI's JSON keys are camelCase, unlike the REST API's
/// snake_case, so this can't share `top_pr_from_rest_json` in github_api.rs.
fn top_pr_from_cli_json(raw: &[serde_json::Value]) -> Option<(i64, String)> {
    let top = raw.first()?;
    let updated_at = top.get("updatedAt").and_then(|v| v.as_str())?.to_string();
    let number = top.get("number").and_then(|v| v.as_i64())?;
    Some((number, updated_at))
}

fn gh_pr_freshness_signal_inner(cwd: String) -> Result<Option<PrFreshnessSignal>, String> {
    if let Some(r) =
        github_api::with_rest(&cwd, |tok| github_api::rest_pr_freshness_signal(&cwd, tok))
    {
        return r;
    }
    // No sort flag is used by the main gh_list_prs_inner list fetch (its
    // order doesn't matter there) — this probe needs updated-desc
    // specifically, via a `-S` search-query sort, requested only here.
    let mut cmd = gh_base_cmd(&cwd)?;
    cmd.args([
        "pr",
        "list",
        "--state",
        "open",
        "--json",
        "number,updatedAt",
        "--limit",
        "1",
        "-S",
        "sort:updated-desc",
    ]);
    let output = cmd
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to run gh pr list (freshness signal): {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("gh pr list (freshness signal) failed: {}", stderr));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let raw: Vec<serde_json::Value> = serde_json::from_str(stdout.trim())
        .map_err(|e| format!("Failed to parse freshness signal output: {}", e))?;
    let (number, updated_at) = match top_pr_from_cli_json(&raw) {
        Some(pair) => pair,
        None => return Ok(None),
    };
    let open_count = gh_pr_count_inner(cwd, "open".to_string())?;
    Ok(Some(PrFreshnessSignal {
        number,
        updated_at,
        open_count,
    }))
}

/// Cheap "has the open-PR list changed?" probe for the branch-badge
/// background-drain cache (`usePrPanel.ts`'s `PR_LIST_CACHE`). See
/// `PrFreshnessSignal`'s doc comment for why two facts are needed.
#[tauri::command]
pub(crate) async fn gh_pr_freshness_signal(
    cwd: String,
) -> Result<Option<PrFreshnessSignal>, String> {
    tauri::async_runtime::spawn_blocking(move || gh_pr_freshness_signal_inner(cwd))
        .await
        .map_err(|e| e.to_string())?
}

fn gh_create_pr_inner(
    cwd: String,
    title: String,
    body: String,
    base: String,
    base_repo: Option<String>,
    draft: bool,
    reviewers: Option<Vec<String>>,
) -> Result<PullRequest, String> {
    if let Some(r) = github_api::with_rest(&cwd, |tok| {
        github_api::rest_create_pr(
            &cwd,
            title.clone(),
            body.clone(),
            base.clone(),
            base_repo.clone(),
            draft,
            reviewers.clone(),
            tok,
        )
    }) {
        return r;
    }
    let mut args = vec![
        "pr".to_string(),
        "create".to_string(),
        "--title".to_string(),
        title,
        "--body".to_string(),
        body,
    ];

    // Target repo: the caller-supplied one (cross-fork), else `origin` — as on
    // the REST path (`rest_create_pr`). Always named: left to itself, `gh`
    // would pick an `upstream` remote over `origin`, even an unrelated one
    // (#298). The head is left to `gh`, which reads it from the branch's push
    // tracking and qualifies it with the owner when that differs.
    let origin = gh_origin_repo(&cwd);
    let requested = base_repo
        .as_deref()
        .map(str::trim)
        .filter(|r| !r.is_empty())
        .map(str::to_string);
    // A requested `owner/repo` is on origin's host; `host/owner/repo` names
    // its own. Without a usable origin, `--repo` as before, the host left to `gh`.
    let mut repo_flag = None;
    let target = match (requested, origin.as_ref()) {
        (Some(r), Some(o)) => match r.split('/').count() {
            2 => Some(o.sibling(r)),
            _ => {
                repo_flag = Some(r);
                None
            }
        },
        (Some(r), None) => {
            repo_flag = Some(r);
            None
        }
        (None, o) => o.cloned(),
    };
    if let Some(r) = repo_flag {
        args.push("--repo".to_string());
        args.push(r);
    }

    if !base.is_empty() {
        args.push("--base".to_string());
        args.push(base);
    }

    if draft {
        args.push("--draft".to_string());
    }

    // Reviewers: gh expects a single comma-separated --reviewer list
    // (GitHub usernames or org/team-slug).
    if let Some(revs) = reviewers {
        let cleaned: Vec<String> = revs
            .into_iter()
            .map(|r| r.trim().trim_start_matches('@').to_string())
            .filter(|r| !r.is_empty())
            .collect();
        if !cleaned.is_empty() {
            args.push("--reviewer".to_string());
            args.push(cleaned.join(","));
        }
    }

    // Note: gh pr create doesn't support --json, but returns the URL.
    let output = gh_cmd(target.as_ref())
        .args(&args)
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to create PR: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("gh pr create failed: {}", stderr));
    }

    let url = String::from_utf8_lossy(&output.stdout).trim().to_string();

    // Fetch the PR details using the URL.
    let view_output = hidden_cmd("gh")
        .args([
            "pr", "view",
            &url,
            "--json", "number,title,state,author,headRefName,baseRefName,isDraft,createdAt,updatedAt,url,additions,deletions,labels,assignees,reviewRequests,reviewDecision,mergeStateStatus,statusCheckRollup,autoMergeRequest",
        ])
        .current_dir(&cwd)
        .output();

    if let Ok(view) = view_output {
        if view.status.success() {
            let json = String::from_utf8_lossy(&view.stdout);
            // gh pr view returns a single object (not array)
            if let Ok(raw) = serde_json::from_str::<GhPrRaw>(json.trim()) {
                return Ok(gh_pr_raw_to_pr(raw));
            }
            // Also try array format
            let raws: Result<Vec<GhPrRaw>, _> = serde_json::from_str(json.trim());
            if let Ok(mut raws) = raws {
                if let Some(raw) = raws.pop() {
                    return Ok(gh_pr_raw_to_pr(raw));
                }
            }
        }
    }

    // Fallback: return minimal info
    Ok(PullRequest {
        number: 0,
        title: String::new(),
        state: "open".to_string(),
        author: String::new(),
        branch: String::new(),
        base: String::new(),
        draft: false,
        created_at: String::new(),
        updated_at: String::new(),
        url,
        additions: 0,
        deletions: 0,
        labels: Vec::new(),
        assignees: Vec::new(),
        review_requested: Vec::new(),
        review_decision: String::new(),
        merge_state_status: String::new(),
        checks_rollup: String::new(),
        comment_count: 0,
        // No PR JSON was ever parsed on this branch (the post-create `gh pr
        // view` failed or came back unparseable), so there is nothing to
        // derive an auto-merge state from. Fails closed, same as every other
        // field on this minimal-info fallback.
        auto_merge: Default::default(),
    })
}

/// Create a pull request using `gh` CLI.
#[tauri::command]
pub(crate) async fn gh_create_pr(
    cwd: String,
    title: String,
    body: String,
    base: String,
    base_repo: Option<String>,
    draft: bool,
    reviewers: Option<Vec<String>>,
) -> Result<PullRequest, String> {
    tauri::async_runtime::spawn_blocking(move || {
        gh_create_pr_inner(cwd, title, body, base, base_repo, draft, reviewers)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn gh_list_reviewer_candidates_inner(cwd: String) -> Result<Vec<ReviewerCandidate>, String> {
    // Users with push access — the set GitHub allows as reviewers. With the
    // Settings token: `origin`'s, over REST. Without: `gh repo view` names the
    // repository, which follows `gh repo set-default` (a fork set to its
    // parent lists the parent's maintainers), as before.
    if let Some(origin) = gh_origin_repo(&cwd) {
        let token = github_api::settings_github_token();
        let path = format!("repos/{}/assignees", origin.nwo);
        if let Some(r) = github_api::with_rest_using(&cwd, token.as_deref(), |tok| {
            super::gh_issues::rest_pages(&path, tok, 3)
        }) {
            return r.map(|items| super::gh_issues::assignees_from(&items));
        }
    }
    gh_reviewer_candidates_via_view(&cwd)
}

/// Reviewer candidates over `gh`: `gh repo view` names the repository (it
/// follows `gh repo set-default`).
fn gh_reviewer_candidates_via_view(cwd: &str) -> Result<Vec<ReviewerCandidate>, String> {
    let view = gh_repo_view_cmd(cwd, "nameWithOwner")
        .output()
        .map_err(|e| format!("Failed to inspect repo: {}", e))?;
    if !view.status.success() {
        return Err(format!(
            "gh repo view failed: {}",
            String::from_utf8_lossy(&view.stderr).trim()
        ));
    }
    let nwo = serde_json::from_slice::<serde_json::Value>(&view.stdout)
        .ok()
        .and_then(|v| v.get("nameWithOwner")?.as_str().map(String::from))
        .ok_or("gh repo view returned no repository")?;
    let output = gh_api_cmd(cwd)
        .args(["api", "--paginate", &format!("repos/{}/assignees", nwo)])
        .current_dir(cwd)
        .output()
        .map_err(|e| format!("Failed to list reviewer candidates: {}", e))?;
    if !output.status.success() {
        return Err(format!(
            "gh api assignees failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    // --paginate concatenates one JSON array per page.
    let raw = String::from_utf8_lossy(&output.stdout);
    let items: Vec<serde_json::Value> = serde_json::Deserializer::from_str(&raw)
        .into_iter::<serde_json::Value>()
        .filter_map(Result::ok)
        .flat_map(|v| v.as_array().cloned().unwrap_or_default())
        .collect();
    Ok(super::gh_issues::assignees_from(&items))
}

/// List candidate reviewers for the current repo using `gh` CLI.
///
/// Calls `gh api /repos/:owner/:repo/assignees` (paginated) which returns
/// users with push access — exactly the set GitHub allows as reviewers.
#[tauri::command]
pub(crate) async fn gh_list_reviewer_candidates(
    cwd: String,
) -> Result<Vec<ReviewerCandidate>, String> {
    tauri::async_runtime::spawn_blocking(move || gh_list_reviewer_candidates_inner(cwd))
        .await
        .map_err(|e| e.to_string())?
}

fn gh_branches_inner(cwd: String) -> Result<Vec<String>, String> {
    // Settings-managed OAuth token present → tokenless REST path (no `gh` needed).
    if let Some(r) = github_api::with_rest(&cwd, |tok| github_api::rest_branches(&cwd, tok)) {
        return r;
    }
    // Discover owner/repo from the current repo.
    let view = gh_repo_view_cmd(&cwd, "owner,name")
        .output()
        .map_err(|e| format!("Failed to inspect repo: {}", e))?;
    if !view.status.success() {
        return Err(format!(
            "gh repo view failed: {}",
            String::from_utf8_lossy(&view.stderr)
        ));
    }
    #[derive(serde::Deserialize)]
    struct OwnerLogin {
        login: String,
    }
    #[derive(serde::Deserialize)]
    struct RepoView {
        owner: OwnerLogin,
        name: String,
    }
    let repo: RepoView = serde_json::from_slice(&view.stdout)
        .map_err(|e| format!("Failed to parse repo view: {}", e))?;
    let endpoint = format!("/repos/{}/{}/branches", repo.owner.login, repo.name);

    let output = gh_api_cmd(&cwd)
        .args([
            "api",
            "--paginate",
            "-H",
            "Accept: application/vnd.github+json",
            &endpoint,
            "--jq",
            "[.[] | .name]",
        ])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to list branches: {}", e))?;
    if !output.status.success() {
        return Err(format!(
            "gh api branches failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    // --paginate concatenates one JSON array per page (NDJSON of arrays).
    let raw = String::from_utf8_lossy(&output.stdout);
    let mut names: Vec<String> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for chunk in raw.split('\n') {
        let trimmed = chunk.trim();
        if trimmed.is_empty() {
            continue;
        }
        let value: serde_json::Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if let Some(arr) = value.as_array() {
            for item in arr {
                if let Some(name) = item.as_str() {
                    if name.is_empty() || !seen.insert(name.to_string()) {
                        continue;
                    }
                    names.push(name.to_string());
                }
            }
        }
    }
    names.sort_by_key(|a| a.to_lowercase());
    Ok(names)
}

/// List branch names (heads) for the current repo. Token → REST, else `gh` CLI.
#[tauri::command]
pub(crate) async fn gh_branches(cwd: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || gh_branches_inner(cwd))
        .await
        .map_err(|e| e.to_string())?
}

fn gh_checkout_pr_inner(cwd: String, number: i64) -> Result<(), String> {
    // Write guard: both paths below fetch a PR ref and check it out — index +
    // refs + worktree mutations that would collide on `.git/index.lock` with a
    // single-repo view of the same repo. Held for the whole op; the inner
    // `github_api::rest_checkout_pr` must NOT re-lock (the RwLock is
    // non-reentrant), so the guard lives only here.
    let _repo = repo_lock::write(&cwd);
    if github_api::rest_token_for(&cwd).is_some() {
        return github_api::rest_checkout_pr(&cwd, number);
    }
    let mut cmd = gh_base_cmd(&cwd)?;
    cmd.args(["pr", "checkout", &number.to_string()]);
    let output = cmd
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to checkout PR: {}", e))?;
    if !output.status.success() {
        return Err(format!(
            "gh pr checkout failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(())
}

/// Checkout a PR branch locally using `gh` CLI.
#[tauri::command]
pub(crate) async fn gh_checkout_pr(cwd: String, number: i64) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || gh_checkout_pr_inner(cwd, number))
        .await
        .map_err(|e| e.to_string())?
}

fn gh_merge_pr_inner(cwd: String, number: i64, method: String) -> Result<(), String> {
    if let Some(r) = github_api::with_rest(&cwd, |tok| {
        github_api::rest_merge_pr(&cwd, number, &method, tok)
    }) {
        return r;
    }
    let merge_flag = match method.as_str() {
        "squash" => "--squash",
        "rebase" => "--rebase",
        _ => "--merge",
    };

    let num = number.to_string();
    let mut cmd = gh_merge_cmd(&cwd, &["pr", "merge", &num, merge_flag, "--delete-branch"])?;
    let output = cmd
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to merge PR: {}", e))?;
    if !output.status.success() {
        return Err(format!(
            "gh pr merge failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(())
}

/// Merge a PR using `gh` CLI.
#[tauri::command]
pub(crate) async fn gh_merge_pr(cwd: String, number: i64, method: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || gh_merge_pr_inner(cwd, number, method))
        .await
        .map_err(|e| e.to_string())?
}

fn gh_enable_auto_merge_inner(cwd: String, number: i64, method: String) -> Result<(), String> {
    if let Some(r) = github_api::with_rest(&cwd, |tok| {
        github_api::rest_enable_auto_merge(&cwd, number, &method, tok)
    }) {
        return r;
    }
    let merge_flag = match method.as_str() {
        "squash" => "--squash",
        "rebase" => "--rebase",
        _ => "--merge",
    };
    // Through `gh_merge_cmd`: a PR that is already mergeable is merged at
    // once, and then gets the same `--delete-branch` local cleanup.
    let num = number.to_string();
    let mut cmd = gh_merge_cmd(
        &cwd,
        &["pr", "merge", &num, "--auto", merge_flag, "--delete-branch"],
    )?;
    let output = cmd
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to enable auto-merge: {}", e))?;
    if !output.status.success() {
        return Err(format!(
            "gh pr merge --auto failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(())
}

/// Queue this PR to merge once its required checks pass.
///
/// A separate command from `gh_merge_pr` rather than a flag on it: arming
/// takes a merge method, disarming takes none, and the two fail for
/// unrelated reasons. `git_rebase_action`'s mode argument works because its
/// three modes share every argument; these do not.
#[tauri::command]
pub(crate) async fn gh_enable_auto_merge(
    cwd: String,
    number: i64,
    method: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || gh_enable_auto_merge_inner(cwd, number, method))
        .await
        .map_err(|e| e.to_string())?
}

fn gh_disable_auto_merge_inner(cwd: String, number: i64) -> Result<(), String> {
    if let Some(r) = github_api::with_rest(&cwd, |tok| {
        github_api::rest_disable_auto_merge(&cwd, number, tok)
    }) {
        return r;
    }
    let mut cmd = gh_base_cmd(&cwd)?;
    cmd.args(["pr", "merge", &number.to_string(), "--disable-auto"]);
    let output = cmd
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to disable auto-merge: {}", e))?;
    if !output.status.success() {
        return Err(format!(
            "gh pr merge --disable-auto failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(())
}

/// Cancel a queued auto-merge. Takes no method: there is nothing to choose.
#[tauri::command]
pub(crate) async fn gh_disable_auto_merge(cwd: String, number: i64) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || gh_disable_auto_merge_inner(cwd, number))
        .await
        .map_err(|e| e.to_string())?
}

fn gh_pr_ready_inner(cwd: String, number: i64) -> Result<(), String> {
    if let Some(r) = github_api::with_rest(&cwd, |tok| github_api::rest_pr_ready(&cwd, number, tok))
    {
        return r;
    }
    // The PR number comes from the base repo's list, so name that repo
    // explicitly rather than rely on gh's remote-name default (#298).
    let mut cmd = gh_base_cmd(&cwd)?;
    cmd.args(["pr", "ready", &number.to_string()]);
    let output = cmd
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to run gh pr ready: {}", e))?;
    if !output.status.success() {
        return Err(format!(
            "gh pr ready failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(())
}

/// Convert a draft PR to a ready-for-review PR via `gh pr ready`.
///
/// Idempotent — `gh pr ready` on a non-draft PR exits 0 with a message like
/// "Pull request #N is already marked as ready for review."
#[tauri::command]
pub(crate) async fn gh_pr_ready(cwd: String, number: i64) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || gh_pr_ready_inner(cwd, number))
        .await
        .map_err(|e| e.to_string())?
}

fn gh_pr_edit_inner(
    cwd: String,
    number: i64,
    title: Option<String>,
    body: Option<String>,
) -> Result<(), String> {
    let fields = super::pr_edit::edit_fields(&title, &body, "body")?;
    if let Some(r) = github_api::with_rest(&cwd, |tok| {
        github_api::rest_pr_edit(&cwd, number, &title, &body, tok)
    }) {
        return r;
    }
    // `-f` sends each value as a raw string — no `@file` expansion, unlike `-F`.
    let nwo = gh_base_nwo(&cwd)?;
    let path = format!("repos/{}/pulls/{}", nwo, number);
    gh_api_write(&cwd, "PATCH", &path, &fields)?;
    Ok(())
}

/// Edit a PR's title and/or body (a `None` field is left unchanged).
#[tauri::command]
pub(crate) async fn gh_pr_edit(
    cwd: String,
    number: i64,
    title: Option<String>,
    body: Option<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || gh_pr_edit_inner(cwd, number, title, body))
        .await
        .map_err(|e| e.to_string())?
}

// ─── Branch PR lookup and retarget (stacked branches) ───────────────────────

/// Parse `gh pr list --json number,baseRefName,headRefOid,mergedAt,url,
/// headRepositoryOwner`, keeping each entry's head-owner login (empty when
/// gh reports none).
fn parse_gh_branch_prs(stdout: &str) -> Result<Vec<(String, BranchPr)>, String> {
    let v: serde_json::Value = serde_json::from_str(stdout.trim())
        .map_err(|e| format!("Failed to parse gh pr list output: {}", e))?;
    let arr = v.as_array().ok_or("gh pr list did not return a list")?;
    let s = |x: &serde_json::Value, k: &str| {
        x.get(k).and_then(|y| y.as_str()).unwrap_or("").to_string()
    };
    Ok(arr
        .iter()
        .filter_map(|x| {
            let owner = x
                .get("headRepositoryOwner")
                .map(|o| s(o, "login"))
                .unwrap_or_default();
            Some((
                owner,
                BranchPr {
                    number: x.get("number")?.as_i64()?,
                    base: s(x, "baseRefName"),
                    head_ref_oid: s(x, "headRefOid"),
                    merged_at: x.get("mergedAt").and_then(|y| y.as_str()).map(String::from),
                    url: s(x, "url"),
                },
            ))
        })
        .collect())
}

/// The newest merged PR of a list (by `merged_at`, RFC 3339 so the strings
/// order like the instants); `None` when none merged.
pub(crate) fn newest_merged(prs: Vec<BranchPr>) -> Option<BranchPr> {
    prs.into_iter()
        .filter(|p| p.merged_at.is_some())
        .max_by(|a, b| a.merged_at.cmp(&b.merged_at))
}

/// The PR `gh pr list` reports for a branch. Only PRs whose head repository
/// belongs to `origin_owner` (case-insensitive) count: `--head` carries no
/// owner, so a fork's same-named branch would otherwise match. An entry
/// without an owner is dropped (fail closed). `merged` keeps the newest merged
/// one and never falls back to an unmerged PR; `open` takes the first.
pub(crate) fn parse_gh_branch_pr_json(
    stdout: &str,
    state: &str,
    origin_owner: &str,
) -> Result<Option<BranchPr>, String> {
    let prs: Vec<BranchPr> = parse_gh_branch_prs(stdout)?
        .into_iter()
        .filter(|(owner, _)| !owner.is_empty() && owner.eq_ignore_ascii_case(origin_owner))
        .map(|(_, p)| p)
        .collect();
    Ok(if state == "merged" {
        newest_merged(prs)
    } else {
        prs.into_iter().next()
    })
}

/// A branch name headed for a `gh`/REST argument: never empty, never an option.
pub(crate) fn check_pr_base(base: &str) -> Result<(), String> {
    if base.is_empty() {
        return Err("base must not be empty".to_string());
    }
    check_branch_arg(base)
}

fn check_branch_arg(branch: &str) -> Result<(), String> {
    if branch.starts_with('-') {
        return Err(format!("invalid branch name: {}", branch));
    }
    Ok(())
}

fn check_pr_number(number: i64) -> Result<(), String> {
    if number <= 0 {
        return Err(format!("invalid PR number: {}", number));
    }
    Ok(())
}

fn check_branch_pr_args(branch: &str, state: &str) -> Result<(), String> {
    check_branch_arg(branch)?;
    match state {
        "open" | "merged" => Ok(()),
        _ => Err(format!("invalid PR state: {}", state)),
    }
}

fn gh_branch_pr_inner(
    cwd: String,
    branch: String,
    state: String,
) -> Result<Option<BranchPr>, String> {
    check_branch_pr_args(&branch, &state)?;
    if let Some(r) = github_api::with_rest(&cwd, |tok| {
        github_api::rest_branch_pr(&cwd, &branch, &state, tok)
    }) {
        return r;
    }
    let mut cmd = gh_base_cmd(&cwd)?;
    cmd.args([
        "pr",
        "list",
        "--state",
        &state,
        "--head",
        &branch,
        "--json",
        "number,baseRefName,headRefOid,mergedAt,url,headRepositoryOwner",
        "--limit",
        "100",
    ]);
    cmd.current_dir(&cwd);
    let output = output_with_timeout(cmd, GH_TIMEOUT)
        .map_err(|e| format!("Failed to run gh pr list (is GitHub CLI installed?): {}", e))?;
    if !output.status.success() {
        return Err(format!(
            "gh pr list failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    // `--head` has no owner: keep only the origin owner's PRs.
    let owner = gh_origin_repo(&cwd)
        .and_then(|r| r.nwo.split('/').next().map(String::from))
        .filter(|o| !o.is_empty())
        .ok_or("Could not resolve the owner of this repository's origin")?;
    parse_gh_branch_pr_json(&String::from_utf8_lossy(&output.stdout), &state, &owner)
}

/// The GitHub PR of `branch` (`state` is `open` or `merged`), `None` when
/// there is none. A hint source for stacks, never a source of truth.
#[tauri::command]
pub(crate) async fn gh_branch_pr(
    cwd: String,
    branch: String,
    state: String,
) -> Result<Option<BranchPr>, String> {
    tauri::async_runtime::spawn_blocking(move || gh_branch_pr_inner(cwd, branch, state))
        .await
        .map_err(|e| e.to_string())?
}

fn gh_pr_set_base_inner(cwd: String, number: i64, base: String) -> Result<(), String> {
    check_pr_number(number)?;
    check_pr_base(&base)?;
    if let Some(r) = github_api::with_rest(&cwd, |tok| {
        github_api::rest_pr_set_base(&cwd, number, &base, tok)
    }) {
        return r;
    }
    // `gh api PATCH`, as `gh_pr_edit_inner` does, not `gh pr edit --base`.
    let nwo = gh_base_nwo(&cwd)?;
    let path = format!("repos/{}/pulls/{}", nwo, number);
    gh_api_write(&cwd, "PATCH", &path, &[("base", base.as_str())])?;
    Ok(())
}

/// Retarget PR `number` onto `base` (after its parent branch merged).
#[tauri::command]
pub(crate) async fn gh_pr_set_base(cwd: String, number: i64, base: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || gh_pr_set_base_inner(cwd, number, base))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod branch_pr_tests {
    use super::*;

    #[test]
    fn parses_gh_branch_pr_json_and_keeps_the_newest_merge() {
        let s = r#"[{"number":800,"baseRefName":"main","headRefOid":"aaa","mergedAt":"2026-11-01T00:00:00Z","url":"u1"},
                   {"number":812,"baseRefName":"main","headRefOid":"bbb","mergedAt":"2026-11-20T00:00:00Z","url":"u2"}]"#;
        let all: Vec<BranchPr> = parse_gh_branch_prs(s)
            .unwrap()
            .into_iter()
            .map(|(_, p)| p)
            .collect();
        let pr = newest_merged(all).unwrap();
        assert_eq!((pr.number, pr.head_ref_oid.as_str()), (812, "bbb"));
    }

    #[test]
    fn open_pr_has_no_merge_date() {
        let s = r#"[{"number":9,"baseRefName":"step-1","headRefOid":"c","mergedAt":null,"url":"u","headRepositoryOwner":{"login":"o"}}]"#;
        let pr = parse_gh_branch_pr_json(s, "open", "o").unwrap().unwrap();
        assert_eq!(
            (pr.number, pr.base.as_str(), pr.merged_at),
            (9, "step-1", None)
        );
        let all: Vec<BranchPr> = parse_gh_branch_prs(s)
            .unwrap()
            .into_iter()
            .map(|(_, p)| p)
            .collect();
        assert_eq!(newest_merged(all), None);
    }

    #[test]
    fn empty_gh_list_is_none() {
        assert_eq!(parse_gh_branch_pr_json("[]", "open", "o").unwrap(), None);
    }

    #[test]
    fn set_base_rejects_dash_and_empty() {
        assert_eq!(check_pr_base("").unwrap_err(), "base must not be empty");
        assert_eq!(check_pr_base("-x").unwrap_err(), "invalid branch name: -x");
        assert!(check_pr_base("main").is_ok());
    }

    #[test]
    fn branch_pr_rejects_unknown_state_and_dash_branch() {
        let err =
            gh_branch_pr_inner("/nonexistent".into(), "b".into(), "closed".into()).unwrap_err();
        assert_eq!(err, "invalid PR state: closed");
        let err =
            gh_branch_pr_inner("/nonexistent".into(), "-b".into(), "open".into()).unwrap_err();
        assert_eq!(err, "invalid branch name: -b");
    }
}

fn gh_dismiss_review_inner(
    cwd: String,
    number: i64,
    review_id: i64,
    message: String,
) -> Result<(), String> {
    if let Some(r) = github_api::with_rest(&cwd, |tok| {
        github_api::rest_dismiss_review(&cwd, number, review_id, &message, tok)
    }) {
        return r;
    }
    let nwo = gh_base_nwo(&cwd)?;
    let path = format!(
        "repos/{}/pulls/{}/reviews/{}/dismissals",
        nwo, number, review_id
    );
    gh_api_write(
        &cwd,
        "PUT",
        &path,
        &[("message", message.as_str()), ("event", "DISMISS")],
    )?;
    Ok(())
}

/// Dismiss a submitted review (B4, v3.6.0).
#[tauri::command]
pub(crate) async fn gh_dismiss_review(
    cwd: String,
    number: i64,
    review_id: i64,
    message: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        gh_dismiss_review_inner(cwd, number, review_id, message)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Token for the review-comment and review-thread commands: the GitWand token
/// when configured, else the `gh` CLI's own. These commands speak REST/GraphQL
/// directly rather than through `gh api`, whose `-f` fields can't carry the
/// integer `line`/`in_reply_to` values GitHub requires.
///
/// When an organization refuses the GitWand token (OAuth App access
/// restrictions), the call is retried with the `gh` token. `cwd` is `None` for
/// commands addressed by a global node id, which have no repository to remember.
fn with_review_token<T>(
    cwd: Option<&str>,
    call: impl Fn(&str) -> Result<T, String>,
) -> Result<T, String> {
    match cwd {
        Some(c) => {
            if let Some(r) = github_api::with_rest(c, &call) {
                return r;
            }
        }
        None => {
            if let Some(tok) = github_api::settings_github_token() {
                match call(&tok) {
                    Err(e) if github_api::is_oauth_restricted(&e) => match gh_auth_token() {
                        Some(gh_tok) => return call(&gh_tok),
                        None => return Err(github_api::oauth_restricted_message(&e)),
                    },
                    other => return other,
                }
            }
        }
    }
    let tok = gh_auth_token().ok_or_else(|| {
        "GitHub authentication required (gh auth login or a token in Settings)".to_string()
    })?;
    call(&tok)
}

/// Create an inline review comment or a reply (`CreatePrCommentParams`).
#[tauri::command]
pub(crate) async fn gh_pr_create_comment(
    cwd: String,
    number: i64,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        with_review_token(Some(&cwd), |tok| {
            github_api::rest_pr_create_comment(&cwd, number, &params, tok)
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Edit the body of an inline review comment.
#[tauri::command]
pub(crate) async fn gh_pr_update_comment(
    cwd: String,
    number: i64,
    comment_id: i64,
    body: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        with_review_token(Some(&cwd), |tok| {
            github_api::rest_pr_update_comment(&cwd, number, comment_id, &body, tok)
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Delete an inline review comment.
#[tauri::command]
pub(crate) async fn gh_pr_delete_comment(
    cwd: String,
    number: i64,
    comment_id: i64,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        with_review_token(Some(&cwd), |tok| {
            github_api::rest_pr_delete_comment(&cwd, number, comment_id, tok)
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// List a PR's review threads with their resolution state.
#[tauri::command]
pub(crate) async fn gh_pr_review_threads(
    cwd: String,
    number: i64,
) -> Result<Vec<serde_json::Value>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        with_review_token(Some(&cwd), |tok| {
            github_api::gql_pr_review_threads(&cwd, number, tok)
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Resolve or unresolve a PR review thread ("Resolve conversation").
#[tauri::command]
pub(crate) async fn gh_set_review_thread_resolved(
    thread_id: String,
    resolved: bool,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        with_review_token(None, |tok| {
            github_api::gql_set_review_thread_resolved(&thread_id, resolved, tok)
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

fn gh_request_reviewers_inner(cwd: String, number: i64, logins: Vec<String>) -> Result<(), String> {
    if let Some(r) = github_api::with_rest(&cwd, |tok| {
        github_api::rest_request_reviewers(&cwd, number, &logins, tok)
    }) {
        return r;
    }
    let nwo = gh_base_nwo(&cwd)?;
    let path = format!("repos/{}/pulls/{}/requested_reviewers", nwo, number);
    let mut cmd = gh_api_cmd(&cwd);
    cmd.args(["api", "-X", "POST", &path]);
    for login in &logins {
        cmd.args(["-f", &format!("reviewers[]={}", login)]);
    }
    let output = cmd
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("gh api request reviewers: {}", e))?;
    if !output.status.success() {
        return Err(format!(
            "gh api request reviewers failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(())
}

/// Request reviewers on an existing PR (B4, v3.6.0).
#[tauri::command]
pub(crate) async fn gh_request_reviewers(
    cwd: String,
    number: i64,
    logins: Vec<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || gh_request_reviewers_inner(cwd, number, logins))
        .await
        .map_err(|e| e.to_string())?
}

fn gh_pr_detail_inner(cwd: String, number: i64) -> Result<PullRequestDetail, String> {
    if let Some(r) =
        github_api::with_rest(&cwd, |tok| github_api::rest_pr_detail(&cwd, number, tok))
    {
        return r;
    }
    let num = number.to_string();
    let mut cmd = gh_base_cmd(&cwd)?;
    cmd.args([
        "pr", "view", &num,
        "--json", "number,title,body,state,author,headRefName,headRefOid,baseRefName,isDraft,createdAt,updatedAt,mergedAt,url,additions,deletions,changedFiles,comments,reviewRequests,labels,reviews,mergeable,statusCheckRollup,autoMergeRequest",
    ]);
    let output = cmd
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("gh pr view: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "gh pr view failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let raw: GhPrDetailRaw = serde_json::from_str(stdout.trim())
        .map_err(|e| format!("Failed to parse gh pr view output: {}", e))?;

    let mut detail = gh_pr_detail_raw_to_detail(raw);
    let (can_merge, auto_merge_support) =
        gh_viewer_can_merge_and_auto_merge_support(&cwd, &detail.url);
    detail.can_merge = can_merge;
    detail.auto_merge_support = auto_merge_support;
    Ok(detail)
}

/// Get detailed PR information using `gh` CLI.
#[tauri::command]
pub(crate) async fn gh_pr_detail(cwd: String, number: i64) -> Result<PullRequestDetail, String> {
    tauri::async_runtime::spawn_blocking(move || gh_pr_detail_inner(cwd, number))
        .await
        .map_err(|e| e.to_string())?
}

// ─── Issues (detail / comments / comment / state) ────────────────────────────
//
// Mirrors the PR commands: a Settings-managed token routes through the tokenless
// REST path (`github_api::rest_issue_*`); otherwise we shell out to `gh`. The
// CLI comment paths use `gh api …/issues/{n}/comments` so they return the same
// REST comment shape as the token path (uniform `map_comment`).

fn gh_issue_detail_inner(cwd: String, number: i64) -> Result<IssueDetail, String> {
    if let Some(r) =
        github_api::with_rest(&cwd, |tok| github_api::rest_issue_detail(&cwd, number, tok))
    {
        return r;
    }
    let num = number.to_string();
    // The base repo: a fork's issues are its parent's (forks usually have
    // issues disabled), as `gh` picked for a GitWand-made fork before #298.
    let mut cmd = gh_base_cmd(&cwd)?;
    cmd.args([
        "issue", "view", &num,
        "--json", "number,title,body,state,author,assignees,labels,url,createdAt,updatedAt,milestone,comments",
    ]);
    let output = cmd
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("gh issue view: {}", e))?;
    if !output.status.success() {
        return Err(format!(
            "gh issue view failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let raw: GhIssueDetailRaw = serde_json::from_str(stdout.trim())
        .map_err(|e| format!("Failed to parse gh issue view output: {}", e))?;
    Ok(IssueDetail {
        number: raw.number,
        title: raw.title,
        body: raw.body,
        state: raw.state,
        author: raw.author.login,
        assignees: raw.assignees.into_iter().map(|a| a.login).collect(),
        labels: raw.labels.into_iter().map(|l| l.name).collect(),
        url: raw.url,
        created_at: raw.created_at,
        updated_at: raw.updated_at,
        milestone: raw.milestone.map(|m| m.title).unwrap_or_default(),
        comments: raw.comments.len() as i64,
    })
}

/// Detailed view of a single GitHub issue (body + comment count).
#[tauri::command]
pub(crate) async fn gh_issue_detail(cwd: String, number: i64) -> Result<IssueDetail, String> {
    tauri::async_runtime::spawn_blocking(move || gh_issue_detail_inner(cwd, number))
        .await
        .map_err(|e| e.to_string())?
}

fn gh_issue_comments_inner(cwd: String, number: i64) -> Result<Vec<serde_json::Value>, String> {
    if let Some(r) = github_api::with_rest(&cwd, |tok| {
        github_api::rest_issue_comments(&cwd, number, tok)
    }) {
        return r;
    }
    let nwo = gh_base_nwo(&cwd)?;
    let path = format!("repos/{}/issues/{}/comments?per_page=100", nwo, number);
    let output = gh_api_cmd(&cwd)
        .args(["api", &path])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("gh api issue comments: {}", e))?;
    if !output.status.success() {
        return Err(format!(
            "gh api issue comments failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    let v: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("parse issue comments: {}", e))?;
    Ok(github_api::map_comments(&v, true))
}

/// List conversation comments on an issue.
#[tauri::command]
pub(crate) async fn gh_issue_comments(
    cwd: String,
    number: i64,
) -> Result<Vec<serde_json::Value>, String> {
    tauri::async_runtime::spawn_blocking(move || gh_issue_comments_inner(cwd, number))
        .await
        .map_err(|e| e.to_string())?
}

fn gh_issue_add_comment_inner(
    cwd: String,
    number: i64,
    body: String,
) -> Result<serde_json::Value, String> {
    if let Some(r) = github_api::with_rest(&cwd, |tok| {
        github_api::rest_issue_add_comment(&cwd, number, &body, tok)
    }) {
        return r;
    }
    let nwo = gh_base_nwo(&cwd)?;
    let path = format!("repos/{}/issues/{}/comments", nwo, number);
    let field = format!("body={}", body);
    let output = gh_api_cmd(&cwd)
        .args(["api", &path, "-X", "POST", "-f", &field])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("gh api add comment: {}", e))?;
    if !output.status.success() {
        return Err(format!(
            "gh api add comment failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    let v: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("parse created comment: {}", e))?;
    Ok(github_api::map_comment(&v, true))
}

/// Add a comment to an issue. Returns the created comment (mapped shape).
#[tauri::command]
pub(crate) async fn gh_issue_add_comment(
    cwd: String,
    number: i64,
    body: String,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || gh_issue_add_comment_inner(cwd, number, body))
        .await
        .map_err(|e| e.to_string())?
}

fn gh_issue_set_state_inner(cwd: String, number: i64, state: String) -> Result<(), String> {
    if let Some(r) = github_api::with_rest(&cwd, |tok| {
        github_api::rest_issue_set_state(&cwd, number, &state, tok)
    }) {
        return r;
    }
    let num = number.to_string();
    // "closed" → `gh issue close`, anything else → `gh issue reopen`.
    let sub = if state == "closed" { "close" } else { "reopen" };
    let mut cmd = gh_base_cmd(&cwd)?;
    cmd.args(["issue", sub, &num]);
    let output = cmd
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("gh issue {}: {}", sub, e))?;
    if !output.status.success() {
        return Err(format!(
            "gh issue {} failed: {}",
            sub,
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(())
}

/// Close (`state="closed"`) or reopen (`state="open"`) an issue.
#[tauri::command]
pub(crate) async fn gh_issue_set_state(
    cwd: String,
    number: i64,
    state: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || gh_issue_set_state_inner(cwd, number, state))
        .await
        .map_err(|e| e.to_string())?
}

fn gh_pr_attachment_urls_inner(
    cwd: String,
    number: i64,
) -> Result<github_api::PrAttachmentUrls, String> {
    if let Some(r) = github_api::with_rest(&cwd, |tok| {
        github_api::rest_pr_attachment_urls(&cwd, number, tok)
    }) {
        return r;
    }
    use rayon::prelude::*;
    let nwo = gh_base_nwo(&cwd)?;
    let (repo, fetches) = rayon::join(
        // The PR's base repository, as the REST path reads it (`get_pr_json`).
        || gh_api_json(&cwd, &format!("repos/{}/pulls/{}", nwo, number)),
        || {
            github_api::pr_attachment_html_paths(&nwo, number)
                .par_iter()
                .map(|path| {
                    gh_api_json_accept(&cwd, path, Some(github_api::HTML_ACCEPT))
                        .map(|v| github_api::body_htmls(&v))
                })
                .collect()
        },
    );
    // Best effort, like the URLs: a repository that cannot be read (SSO,
    // a transient error) does not cost the URLs fetched.
    let private = repo
        .ok()
        .and_then(|pr| pr.pointer("/base/repo/private").and_then(|v| v.as_bool()));
    github_api::PrAttachmentUrls::from_fetches(private, fetches)
}

/// Signed, short-lived URLs of the files uploaded to PR `number`'s
/// description, comments and reviews (#302), and whether its repository is
/// private. GitHub only hands them out in `body_html`; for a private
/// repository the frontend swaps them in for the `user-attachments` URLs of
/// the markdown, which it does not serve to the webview.
#[tauri::command]
pub(crate) async fn gh_pr_attachment_urls(
    cwd: String,
    number: i64,
) -> Result<github_api::PrAttachmentUrls, String> {
    tauri::async_runtime::spawn_blocking(move || gh_pr_attachment_urls_inner(cwd, number))
        .await
        .map_err(|e| e.to_string())?
}

// ─── Private sync helpers ────────────────────────────────────────────────────

// ─── Repository targeting (#298) ─────────────────────────────────────────────
//
// Without `gh repo set-default`, `gh` picks the repo it acts on by remote
// *name*: `upstream` > `github` > `origin`. A clone with an unrelated
// `upstream` remote therefore had its PR list, PR creation and every other
// `gh` call aimed at that other repo. The REST path has always read `origin`
// (`github_api::owner_repo`); these helpers make the `gh` path do the same.
//
// The repo is named through `GH_REPO` (`gh_cmd`), which every `gh`
// subcommand honors, `gh api`'s `{owner}/{repo}` placeholders included — not
// through `--repo`: `gh pr merge` skips deleting the local branch (and leaves
// the checkout on it) whenever `--repo` is given, `GH_REPO` does not.
// `gh api repos/{nwo}/…` paths name it in the path as well.
//
// Only when `origin` is missing or unparseable do callers still leave the
// choice to `gh` — the behavior every repo had before.

/// A GitHub repository as `gh` addresses it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct GhRepo {
    /// `"host/"` for a GitHub Enterprise host, empty for github.com.
    host_prefix: String,
    /// `owner/repo`, the form REST paths (`gh api repos/{nwo}/…`) take.
    pub(crate) nwo: String,
}

impl GhRepo {
    /// The `[HOST/]OWNER/REPO` form `GH_REPO`, `--repo` and `gh repo view` take.
    pub(crate) fn selector(&self) -> String {
        format!("{}{}", self.host_prefix, self.nwo)
    }

    /// The Enterprise host, `None` for github.com.
    pub(crate) fn enterprise_host(&self) -> Option<&str> {
        let host = self.host_prefix.trim_end_matches('/');
        (!host.is_empty()).then_some(host)
    }

    /// The host, github.com included: what `GH_HOST` is set to.
    fn host(&self) -> &str {
        self.enterprise_host().unwrap_or("github.com")
    }

    /// A repository from its parts, for tests outside this module.
    #[cfg(test)]
    pub(crate) fn for_test(host_prefix: &str, nwo: &str) -> GhRepo {
        GhRepo {
            host_prefix: host_prefix.to_string(),
            nwo: nwo.to_string(),
        }
    }

    /// A repository on github.com, whatever the working directory's remote
    /// (GitWand's own repository, for resolver reports, #301).
    pub(crate) fn github_com(nwo: &str) -> GhRepo {
        GhRepo {
            host_prefix: String::new(),
            nwo: nwo.to_string(),
        }
    }

    /// Another repository on the same host (a fork's parent).
    pub(crate) fn sibling(&self, nwo: String) -> GhRepo {
        GhRepo {
            host_prefix: self.host_prefix.clone(),
            nwo,
        }
    }
}

fn is_github_com(host: &str) -> bool {
    host == "github.com" || host.ends_with(".github.com")
}

/// `(host, path, is_ssh)` of a git remote URL: `scheme://[user@]host[:port]/path`
/// or scp-style `[user@]host:path` (SSH, whatever the user: `git@`,
/// `alice@`, an EMU `org-123@`, or none). `None` for a local path.
fn split_remote_url(url: &str) -> Option<(String, String, bool)> {
    if let Some((scheme, rest)) = url.split_once("://") {
        let (authority, path) = rest.split_once('/')?;
        let host_port = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
        let host = host_port.split(':').next().unwrap_or("");
        let is_ssh = scheme.to_ascii_lowercase().contains("ssh");
        return Some((host.to_lowercase(), path.to_string(), is_ssh));
    }
    let (before, path) = url.split_once(':')?;
    if before.is_empty() || before.contains('/') || before.contains('\\') {
        return None;
    }
    let host = before.rsplit_once('@').map_or(before, |(_, h)| h);
    Some((host.to_lowercase(), path.to_string(), true))
}

/// Parse a git remote URL into the repo `gh` should address, the way `gh`
/// reads remotes: the host of an SSH URL is what `ssh` connects to
/// (`resolve_ssh_host`, an alias in `~/.ssh/config` standing for its
/// `HostName`), and a remote counts only when that host is github.com or a
/// host `gh` is signed in to (`is_gh_host`) — anything else (GitLab, a plain
/// git server) is not a GitHub remote: `None`. github.com stays implicit in
/// the selector; an Enterprise host is kept (`github.acme.corp/team/app`).
fn gh_repo_from_url_with(
    url: &str,
    resolve_ssh_host: impl Fn(&str) -> Option<String>,
    is_gh_host: impl Fn(&str) -> bool,
) -> Option<GhRepo> {
    let (host, path, is_ssh) = split_remote_url(url.trim())?;
    let path = path
        .trim_start_matches('/')
        .trim_end_matches('/')
        .trim_end_matches(".git");
    let (owner, repo) = path.split_once('/')?;
    if owner.is_empty() || repo.is_empty() || repo.contains('/') || host.is_empty() {
        return None;
    }
    let host = if is_ssh && !is_github_com(&host) {
        resolve_ssh_host(&host)
            .map(|h| h.to_lowercase())
            .unwrap_or(host)
    } else {
        host
    };
    let host_prefix = if is_github_com(&host) {
        String::new()
    } else if is_gh_host(&host) {
        format!("{}/", host)
    } else {
        return None;
    };
    Some(GhRepo {
        host_prefix,
        nwo: format!("{}/{}", owner, repo),
    })
}

/// How long a negative `ssh -G` / `gh auth status` answer is reused. A
/// positive one is kept for the session; a negative one may be a timeout, an
/// offline start or a `gh auth login` still to come, so it is asked again.
const HOST_NEGATIVE_TTL: Duration = Duration::from_secs(60);

type HostAnswerCache = HashMap<String, (Option<String>, Instant)>;

fn host_answer_cache() -> &'static Mutex<HostAnswerCache> {
    static CACHE: OnceLock<Mutex<HostAnswerCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cached_host_answer(key: String, compute: impl FnOnce() -> Option<String>) -> Option<String> {
    let hit = host_answer_cache()
        .lock()
        .ok()
        .and_then(|m| m.get(&key).cloned());
    if let Some((answer, at)) = hit {
        if answer.is_some() || at.elapsed() < HOST_NEGATIVE_TTL {
            return answer;
        }
    }
    let answer = compute();
    if let Ok(mut m) = host_answer_cache().lock() {
        m.insert(key, (answer.clone(), Instant::now()));
    }
    answer
}

/// A host name safe to pass as an argument (no option, no shell metachar).
fn is_plain_host(host: &str) -> bool {
    !host.starts_with('-')
        && host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
}

/// Upper bound for the local `ssh -G` / `gh auth status` probes.
const GH_PROBE_TIMEOUT: Duration = Duration::from_secs(5);

/// `HostName` that `ssh` connects to for `host` (`ssh -G` reads the config
/// without connecting; for a host it has no entry for, it echoes the name).
/// `None` when `ssh` is missing, fails or times out.
fn ssh_resolved_host(host: &str) -> Option<String> {
    if !is_plain_host(host) {
        return None;
    }
    cached_host_answer(format!("ssh:{}", host), || {
        let mut cmd = hidden_cmd("ssh");
        // Only what `ssh` needs to find and read its config: no forge token
        // (which `hidden_cmd` passes on) reaches it, nor a `Match exec`
        // command it runs.
        let path = cmd
            .get_envs()
            .find(|(k, _)| *k == std::ffi::OsStr::new("PATH"))
            .and_then(|(_, v)| v.map(|v| v.to_os_string()))
            .or_else(|| std::env::var_os("PATH"));
        cmd.env_clear();
        if let Some(path) = path {
            cmd.env("PATH", path);
        }
        for var in [
            "HOME",
            "USER",
            "LOGNAME",
            "USERPROFILE",
            "HOMEDRIVE",
            "HOMEPATH",
            "SystemRoot",
            "windir",
            "TMPDIR",
            "TEMP",
            "TMP",
        ] {
            if let Some(v) = std::env::var_os(var) {
                cmd.env(var, v);
            }
        }
        cmd.args(["-G", host]);
        let out = output_with_timeout(cmd, GH_PROBE_TIMEOUT)
            .ok()
            .filter(|o| o.status.success())?;
        String::from_utf8_lossy(&out.stdout).lines().find_map(|l| {
            l.strip_prefix("hostname ")
                .map(|h| h.trim().to_string())
                .filter(|h| !h.is_empty())
        })
    })
}

/// Whether `gh` is signed in to `host` right now, without the session cache
/// (GitWand's resolver reports ask it each time their form opens, #301).
pub(crate) fn gh_signed_in_now(host: &str) -> bool {
    if !is_plain_host(host) {
        return false;
    }
    let mut cmd = hidden_cmd("gh");
    cmd.args(["auth", "status", "--hostname", host]);
    output_with_timeout(cmd, GH_PROBE_TIMEOUT).is_ok_and(|o| o.status.success())
}

/// Whether `gh` is signed in to `host` (an Enterprise host; github.com is
/// always a GitHub host). Cached for the session.
fn gh_signed_in_to(host: &str) -> bool {
    if !is_plain_host(host) {
        return false;
    }
    cached_host_answer(format!("gh:{}", host), || {
        let mut cmd = hidden_cmd("gh");
        cmd.args(["auth", "status", "--hostname", host]);
        output_with_timeout(cmd, GH_PROBE_TIMEOUT)
            .ok()
            .filter(|o| o.status.success())
            .map(|_| String::new())
    })
    .is_some()
}

/// Parse a git remote URL into the repo `gh` should address (see
/// `gh_repo_from_url_with`). Also the parser of `github_api::owner_repo`, so
/// the REST and `gh` paths read `origin` the same way.
pub(crate) fn gh_repo_from_remote_url(url: &str) -> Option<GhRepo> {
    gh_repo_from_url_with(url, ssh_resolved_host, gh_signed_in_to)
}

/// How long `gh_origin_repo` reuses its answer for a repo: one PR command
/// resolves `origin` several times (token routing, the request path, the
/// host), the Launchpad does it for every repo each minute, and `origin`
/// practically never changes.
const GH_ORIGIN_TTL: Duration = Duration::from_secs(30);

/// The repo `origin` points at, or `None` when `origin` is missing or not a
/// GitHub remote.
pub(crate) fn gh_origin_repo(cwd: &str) -> Option<GhRepo> {
    type OriginCache = HashMap<String, (Option<GhRepo>, Instant)>;
    static CACHE: OnceLock<Mutex<OriginCache>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some((repo, at)) = cache.lock().ok().and_then(|m| m.get(cwd).cloned()) {
        if at.elapsed() < GH_ORIGIN_TTL {
            return repo;
        }
    }
    let repo = hidden_cmd("git")
        .args(["remote", "get-url", "origin"])
        .current_dir(cwd)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|out| gh_repo_from_remote_url(&String::from_utf8_lossy(&out.stdout)));
    if let Ok(mut m) = cache.lock() {
        m.insert(cwd.to_string(), (repo.clone(), Instant::now()));
    }
    repo
}

/// Whether `origin` is on a GitHub Enterprise host — which the Settings
/// sign-in (github.com only) does not cover.
pub(crate) fn origin_is_enterprise(cwd: &str) -> bool {
    gh_origin_repo(cwd).is_some_and(|r| r.enterprise_host().is_some())
}

/// Whether one of `cwd`'s remotes points at `repo`. Read from `git remote -v`,
/// which applies `url.*.insteadOf` rewrites as `git remote get-url` and `gh`
/// do (raw `remote.*.url` config does not).
fn gh_repo_is_a_remote(cwd: &str, repo: &GhRepo) -> bool {
    let Ok(out) = hidden_cmd("git")
        .args(["remote", "-v"])
        .current_dir(cwd)
        .output()
    else {
        return false;
    };
    let want = repo.selector();
    let needle = repo.nwo.to_ascii_lowercase();
    let stdout = String::from_utf8_lossy(&out.stdout);
    // `<name>\t<url> (fetch|push)`. Only URLs naming the repo are parsed (each
    // once), so other forges' remotes cost no `ssh -G` / `gh auth status`.
    let mut urls: Vec<&str> = stdout
        .lines()
        .filter_map(|line| line.split_once('\t'))
        .filter_map(|(_, rest)| rest.rsplit_once(' '))
        .map(|(url, _)| url)
        .filter(|url| url.to_ascii_lowercase().contains(&needle))
        .collect();
    urls.dedup();
    urls.into_iter().any(|url| {
        gh_repo_from_remote_url(url).is_some_and(|r| r.selector().eq_ignore_ascii_case(&want))
    })
}

/// `owner/name` of the `parent` in a `gh repo view --json isFork,parent`
/// response, when the repo is a fork.
fn fork_parent_nwo(v: &serde_json::Value) -> Option<String> {
    if !v.get("isFork").and_then(|b| b.as_bool()).unwrap_or(false) {
        return None;
    }
    let p = v.get("parent")?;
    let owner = p
        .get("owner")
        .and_then(|o| o.get("login"))
        .and_then(|s| s.as_str())
        .filter(|s| !s.is_empty())?;
    let name = p
        .get("name")
        .and_then(|s| s.as_str())
        .filter(|s| !s.is_empty())?;
    Some(format!("{}/{}", owner, name))
}

/// `gh repo view` of `origin` (or of `gh`'s own pick when there is no usable
/// `origin`), with the given `--json` fields. Not yet run.
fn gh_repo_view_cmd(cwd: &str, fields: &str) -> std::process::Command {
    let origin = gh_origin_repo(cwd);
    let mut cmd = gh_host_cmd(origin.as_ref());
    cmd.args(["repo", "view"]);
    if let Some(o) = origin {
        cmd.arg(o.selector());
    }
    cmd.args(["--json", fields]).current_dir(cwd);
    cmd
}

/// How long a fork lookup is reused. A repo's fork parent practically never
/// changes; the cache is what keeps the half-dozen `gh` calls behind one PR
/// detail (and the Launchpad's poll) from each paying a `gh repo view`.
const GH_FORK_PARENT_TTL: Duration = Duration::from_secs(600);

/// One `origin`'s fork lookup: the parent (`None`: not a fork) and its fetch
/// time, `None` until answered. Its own lock, held across the lookup, makes
/// concurrent callers for the same `origin` wait for one `gh repo view`
/// instead of each running their own; the lookup is bounded by `GH_TIMEOUT`.
type ForkParentSlot = std::sync::Arc<Mutex<Option<(Option<String>, Instant)>>>;

fn gh_fork_parent_slot(key: &str) -> ForkParentSlot {
    static MAP: OnceLock<Mutex<HashMap<String, ForkParentSlot>>> = OnceLock::new();
    let mut map = match MAP.get_or_init(|| Mutex::new(HashMap::new())).lock() {
        Ok(m) => m,
        Err(p) => p.into_inner(),
    };
    map.entry(key.to_string()).or_default().clone()
}

/// Fork parent of `origin`, `Ok(None)` when it is not a fork. Only answers
/// are cached; a failed lookup is an error, retried on the next call.
fn gh_fork_parent(cwd: &str, origin: &GhRepo) -> Result<Option<String>, String> {
    let key = origin.selector();
    let slot = gh_fork_parent_slot(&key);
    let mut entry = match slot.lock() {
        Ok(e) => e,
        Err(p) => p.into_inner(),
    };
    if let Some((parent, at)) = entry.as_ref() {
        if at.elapsed() < GH_FORK_PARENT_TTL {
            return Ok(parent.clone());
        }
    }
    let mut cmd = gh_host_cmd(Some(origin));
    cmd.args(["repo", "view", &key, "--json", "isFork,parent"])
        .current_dir(cwd);
    let out = output_with_timeout(cmd, GH_TIMEOUT).map_err(|e| {
        format!(
            "Failed to run gh repo view (is GitHub CLI installed?): {}",
            e
        )
    })?;
    if !out.status.success() {
        return Err(format!(
            "gh repo view {} failed: {}",
            key,
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    let v: serde_json::Value = serde_json::from_slice(&out.stdout)
        .map_err(|e| format!("Failed to parse gh repo view output: {}", e))?;
    let parent = fork_parent_nwo(&v);
    *entry = Some((parent.clone(), Instant::now()));
    Ok(parent)
}

/// The repo PRs are listed from and act on: the fork parent when `origin` is
/// a fork, else `origin` itself — what `github_api`'s REST path uses.
///
/// `Ok(None)` without a usable `origin`: the caller lets `gh` choose, as
/// before #298. A failed fork lookup is an error rather than a guess: a PR
/// number from the parent's list, sent to the fork (or the reverse), would
/// merge or mark ready a different pull request.
pub(crate) fn gh_base_repo(cwd: &str) -> Result<Option<GhRepo>, String> {
    let Some(origin) = gh_origin_repo(cwd) else {
        return Ok(None);
    };
    Ok(Some(match gh_fork_parent(cwd, &origin)? {
        Some(nwo) => origin.sibling(nwo),
        None => origin,
    }))
}

/// A `gh` command for `repo`'s host: `GH_HOST` set (github.com included, so
/// a `GH_HOST` in the user's environment cannot redirect a github.com repo).
/// What `gh api` needs — it reads its host from `GH_HOST`, not `GH_REPO`; the
/// repo itself is in the request path.
fn gh_host_cmd(repo: Option<&GhRepo>) -> std::process::Command {
    let mut cmd = hidden_cmd("gh");
    if let Some(r) = repo {
        cmd.env("GH_HOST", r.host());
    }
    cmd
}

/// A `gh` command aimed at `repo` through `GH_REPO` (see the section comment
/// for why not `--repo`) and at its host; `None` leaves the choice to `gh`.
pub(crate) fn gh_cmd(repo: Option<&GhRepo>) -> std::process::Command {
    let mut cmd = gh_host_cmd(repo);
    if let Some(r) = repo {
        cmd.env("GH_REPO", r.selector());
    }
    cmd
}

/// A `gh` command aimed at the base repo (`gh_base_repo`): every PR command.
pub(crate) fn gh_base_cmd(cwd: &str) -> Result<std::process::Command, String> {
    Ok(gh_cmd(gh_base_repo(cwd)?.as_ref()))
}

/// A `gh api` command for `cwd`'s host (see `gh_host_cmd`). Commands that
/// make several calls resolve the repo once and use `gh_host_cmd` instead.
fn gh_api_cmd(cwd: &str) -> std::process::Command {
    gh_host_cmd(gh_origin_repo(cwd).as_ref())
}

/// The `gh pr merge` command for the base repo. `GH_REPO` keeps `gh`'s local
/// cleanup (`--delete-branch` deletes the local branch and, when it is checked
/// out, switches to the base branch), but that switch needs a remote for the
/// base repo, looked up after the merge: without one, `gh` exits with an error
/// although the pull request is merged. For a base repo that is not a remote
/// (a fork cloned with only `origin`), `--repo` instead, which skips the local
/// cleanup. `args` are the `pr merge …` arguments; `--repo` goes after them.
fn gh_merge_cmd(cwd: &str, args: &[&str]) -> Result<std::process::Command, String> {
    let base = gh_base_repo(cwd)?;
    match base.as_ref() {
        Some(b) if !gh_repo_is_a_remote(cwd, b) => {
            let mut cmd = gh_host_cmd(Some(b));
            cmd.args(args).args(["--repo", &b.selector()]);
            Ok(cmd)
        }
        _ => {
            let mut cmd = gh_cmd(base.as_ref());
            cmd.args(args);
            Ok(cmd)
        }
    }
}

/// `owner/repo` that `gh` itself would pick, for the no-`origin` fallback of
/// the `gh api repos/{nwo}/…` paths below. `None` on any failure.
fn gh_inferred_nwo(cwd: &str) -> Option<String> {
    let out = hidden_cmd("gh")
        .args([
            "repo",
            "view",
            "--json",
            "nameWithOwner",
            "--jq",
            ".nameWithOwner",
        ])
        .current_dir(cwd)
        .output()
        .ok()
        .filter(|o| o.status.success())?;
    let nwo = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!nwo.is_empty()).then_some(nwo)
}

const UNRESOLVED_REPO: &str = "Could not resolve the GitHub owner/repo of this repository";

/// The base repo (see `gh_base_repo`) and the `owner/repo` for its
/// `gh api repos/{nwo}/…` paths — `gh`'s own pick when there is no usable
/// `origin`. For commands that make several calls: resolve once, then
/// `gh_cmd(repo)` / `gh_host_cmd(repo)` for each.
fn gh_base_target(cwd: &str) -> Result<(Option<GhRepo>, String), String> {
    match gh_base_repo(cwd)? {
        Some(r) => {
            let nwo = r.nwo.clone();
            Ok((Some(r), nwo))
        }
        None => gh_inferred_nwo(cwd)
            .map(|nwo| (None, nwo))
            .ok_or_else(|| UNRESOLVED_REPO.to_string()),
    }
}

/// `owner/repo` for a `gh api repos/{nwo}/…` path that addresses a PR: the
/// base repo (see `gh_base_repo`).
fn gh_base_nwo(cwd: &str) -> Result<String, String> {
    gh_base_target(cwd).map(|(_, nwo)| nwo)
}

/// Resolve whether the current viewer can merge this PR, and whether the base
/// repository allows forge-side auto-merge, off the **same** `gh api
/// repos/{nwo}` response. A PR merges into its **base** repository, which,
/// for a fork, is the upstream repo and not the fork the working copy points
/// at. So both checks are made against the base repo (parsed from the PR
/// url), not `cwd`'s origin: owning a fork grants ADMIN on the fork but no
/// merge rights (and no auto-merge setting) on upstream.
///
/// Previously this fetched `--jq '.permissions.push'` alone; auto-merge
/// support needs `.allow_auto_merge` off the same object, and fetching the
/// full JSON once serves both rather than adding a second `gh api` round
/// trip per PR detail open.
///
/// `push` access on the base repo means the viewer can merge. `can_merge` is
/// `None` on any failure so the UI falls back to error-only gating;
/// `auto_merge_support` fails closed to "unsupported" via `gh_auto_merge_support`
/// on the same failure (an absent/unreadable field must never read as
/// available).
fn gh_viewer_can_merge_and_auto_merge_support(
    cwd: &str,
    pr_url: &str,
) -> (Option<bool>, crate::types::AutoMergeSupport) {
    let fail_closed = || gh_auto_merge_support(&serde_json::Value::Null);
    let Some(nwo) = github_nwo_from_pr_url(pr_url) else {
        return (None, fail_closed());
    };
    let output = gh_api_cmd(cwd)
        .args(["api", &format!("repos/{}", nwo)])
        .current_dir(cwd)
        .output();
    let Ok(output) = output else {
        return (None, fail_closed());
    };
    if !output.status.success() {
        return (None, fail_closed());
    }
    let Ok(v) = serde_json::from_slice::<serde_json::Value>(&output.stdout) else {
        return (None, fail_closed());
    };
    let can_merge = v
        .get("permissions")
        .and_then(|p| p.get("push"))
        .and_then(|b| b.as_bool());
    // REST's `allow_auto_merge` is the same repository setting exposed as
    // `autoMergeAllowed` on GitHub's GraphQL `Repository` type, reachable via
    // `gh api graphql` (NOT `gh repo view --json autoMergeAllowed`, which
    // `gh repo view` rejects with "Unknown JSON field"); translate it into
    // the shape `gh_auto_merge_support` already expects and is tested
    // against, rather than teaching that function a second field name.
    let support = gh_auto_merge_support(&serde_json::json!({
        "autoMergeAllowed": v.get("allow_auto_merge")
    }));
    (can_merge, support)
}

/// Extract `owner/repo` from a GitHub PR url such as
/// `https://github.com/owner/repo/pull/123`.
fn github_nwo_from_pr_url(url: &str) -> Option<String> {
    // `https://<host>/owner/repo/pull/N`, github.com or an Enterprise host
    // (whose `gh api` host comes from `origin`, see `gh_api_cmd`).
    let rest = url.split_once("://").map_or(url, |(_, r)| r);
    let mut parts = rest.split('/').skip(1);
    let owner = parts.next().filter(|s| !s.is_empty())?;
    let repo = parts.next().filter(|s| !s.is_empty())?;
    (parts.next() == Some("pull")).then(|| format!("{}/{}", owner, repo))
}

fn gh_pr_diff_inner(cwd: String, number: i64) -> Result<String, String> {
    if let Some(r) = github_api::with_rest(&cwd, |tok| github_api::rest_pr_diff(&cwd, number, tok))
    {
        return r;
    }
    let num = number.to_string();
    let mut cmd = gh_base_cmd(&cwd)?;
    cmd.args(["pr", "diff", &num]);
    let output = cmd
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("gh pr diff: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "gh pr diff failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Get the diff of a PR using `gh` CLI.
#[tauri::command]
pub(crate) async fn gh_pr_diff(cwd: String, number: i64) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || gh_pr_diff_inner(cwd, number))
        .await
        .map_err(|e| e.to_string())?
}

fn gh_pr_checks_inner(cwd: String, number: i64) -> Result<Vec<CICheck>, String> {
    if let Some(r) =
        github_api::with_rest(&cwd, |tok| github_api::rest_pr_checks(&cwd, number, tok))
    {
        return r;
    }
    // Resolve the canonical repo NWO (upstream for forks, own for regular repos).
    let (base, nwo) = gh_base_target(&cwd)?;

    // Step 1 — head commit SHA for this PR.
    let pr_out = gh_host_cmd(base.as_ref())
        .args([
            "api",
            &format!("repos/{}/pulls/{}", nwo, number),
            "--jq",
            ".head.sha",
        ])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("gh api pr head sha: {}", e))?;
    // Errors are errors, not "no checks": see rest_pr_checks.
    if !pr_out.status.success() {
        return Err(format!(
            "gh api pr head sha: {}",
            String::from_utf8_lossy(&pr_out.stderr).trim()
        ));
    }
    let sha = String::from_utf8_lossy(&pr_out.stdout)
        .trim()
        .trim_matches('"')
        .to_string();
    if sha.is_empty() || sha == "null" {
        return Ok(Vec::new());
    }

    // Step 2 — check-runs for that commit.
    let runs_out = gh_host_cmd(base.as_ref())
        .args([
            "api",
            &format!("repos/{}/commits/{}/check-runs?per_page=100", nwo, sha),
        ])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("gh api check-runs: {}", e))?;
    if !runs_out.status.success() {
        let err = format!(
            "gh api check-runs: {}",
            String::from_utf8_lossy(&runs_out.stderr).trim()
        );
        // Refused for good (see checks_unavailable): no checks to show.
        if github_api::checks_unavailable(&err) {
            return Ok(Vec::new());
        }
        return Err(err);
    }
    let v: serde_json::Value = serde_json::from_slice(&runs_out.stdout)
        .map_err(|e| format!("gh api check-runs: {}", e))?;
    let runs = v
        .get("check_runs")
        .and_then(|r| r.as_array())
        .cloned()
        .unwrap_or_default();
    let checks = runs
        .iter()
        .map(|run| {
            let js = |k: &str| {
                run.get(k)
                    .and_then(|s| s.as_str())
                    .unwrap_or("")
                    .to_string()
            };
            let status = js("status").to_uppercase();
            let conclusion = js("conclusion");
            CICheck {
                name: js("name"),
                state: if status == "COMPLETED" {
                    conclusion.clone()
                } else {
                    status
                },
                conclusion,
                details_url: js("html_url"),
                commit_sha: sha.clone(),
            }
        })
        .collect();
    Ok(checks)
}

/// Get CI checks for a PR using `gh api` (mirrors REST path and dev-server).
///
/// `gh pr checks --json` is unreliable across gh CLI versions and its field
/// names differ from the GitHub REST API. Instead we call the check-runs
/// REST endpoint via `gh api`, exactly like `rest_pr_checks` and the dev-server
/// do, to guarantee consistent field names and output.
#[tauri::command]
pub(crate) async fn gh_pr_checks(cwd: String, number: i64) -> Result<Vec<CICheck>, String> {
    tauri::async_runtime::spawn_blocking(move || gh_pr_checks_inner(cwd, number))
        .await
        .map_err(|e| e.to_string())?
}

fn gh_pr_comments_inner(cwd: String, number: i64) -> Result<Vec<serde_json::Value>, String> {
    if let Some(r) =
        github_api::with_rest(&cwd, |tok| github_api::rest_pr_comments(&cwd, number, tok))
    {
        return r;
    }
    let nwo = gh_base_nwo(&cwd)?;
    let json = gh_api_json(
        &cwd,
        &format!("repos/{}/pulls/{}/comments?per_page=100", nwo, number),
    )?;
    Ok(github_api::map_comments(&json, false))
}

/// List inline review comments (anchored to diff lines) for a PR.
/// Token present → REST; otherwise `gh api`.
#[tauri::command]
pub(crate) async fn gh_pr_comments(
    cwd: String,
    number: i64,
) -> Result<Vec<serde_json::Value>, String> {
    tauri::async_runtime::spawn_blocking(move || gh_pr_comments_inner(cwd, number))
        .await
        .map_err(|e| e.to_string())?
}

fn gh_pr_issue_comments_inner(cwd: String, number: i64) -> Result<Vec<serde_json::Value>, String> {
    if let Some(r) = github_api::with_rest(&cwd, |tok| {
        github_api::rest_pr_issue_comments(&cwd, number, tok)
    }) {
        return r;
    }
    let nwo = gh_base_nwo(&cwd)?;
    let json = gh_api_json(
        &cwd,
        &format!("repos/{}/issues/{}/comments?per_page=100", nwo, number),
    )?;
    Ok(github_api::map_comments(&json, true))
}

/// List issue-level (conversation) comments for a PR.
/// Token present → REST; otherwise `gh api`.
#[tauri::command]
pub(crate) async fn gh_pr_issue_comments(
    cwd: String,
    number: i64,
) -> Result<Vec<serde_json::Value>, String> {
    tauri::async_runtime::spawn_blocking(move || gh_pr_issue_comments_inner(cwd, number))
        .await
        .map_err(|e| e.to_string())?
}

fn gh_pr_reviews_inner(cwd: String, number: i64) -> Result<Vec<serde_json::Value>, String> {
    if let Some(r) =
        github_api::with_rest(&cwd, |tok| github_api::rest_pr_reviews(&cwd, number, tok))
    {
        return r;
    }
    let nwo = gh_base_nwo(&cwd)?;
    let json = gh_api_json(
        &cwd,
        &format!("repos/{}/pulls/{}/reviews?per_page=100", nwo, number),
    )?;
    Ok(github_api::map_reviews(&json))
}

/// List submitted reviews (Approve / Request changes / Comment verdicts) for a PR.
/// Token present → REST; otherwise `gh api`.
#[tauri::command]
pub(crate) async fn gh_pr_reviews(
    cwd: String,
    number: i64,
) -> Result<Vec<serde_json::Value>, String> {
    tauri::async_runtime::spawn_blocking(move || gh_pr_reviews_inner(cwd, number))
        .await
        .map_err(|e| e.to_string())?
}

/// Run `gh api <path>` in `cwd` and parse stdout as JSON. Shared by the
/// comment-list fallbacks when no token is configured.
fn gh_api_json(cwd: &str, path: &str) -> Result<serde_json::Value, String> {
    gh_api_json_accept(cwd, path, None)
}

/// The error of a failed `gh api` call. `gh` prints GitHub's JSON answer on
/// stdout and only "Validation Failed (HTTP 422)" on stderr: when stdout holds
/// the answer, it is worded like the REST path's (`map_api_error`), field
/// details included.
fn gh_api_failure(what: &str, stderr: &str, stdout: &str) -> String {
    let answer = serde_json::from_str::<serde_json::Value>(stdout.trim()).ok();
    let status = stderr
        .rsplit_once("(HTTP ")
        .and_then(|(_, rest)| rest.split(')').next())
        .and_then(|n| n.trim().parse::<i32>().ok());
    match (answer.filter(|a| a.get("message").is_some()), status) {
        (Some(_), Some(code)) => github_api::map_api_error(code, stdout),
        _ => format!("{}: {}", what, stderr.trim()),
    }
}

/// A finished `gh api` call: its stderr as the error on failure, else stdout
/// parsed as JSON — `empty` when there is none (a 204, an empty list).
fn gh_api_parse(
    output: std::process::Output,
    what: &str,
    empty: serde_json::Value,
) -> Result<serde_json::Value, String> {
    if !output.status.success() {
        return Err(gh_api_failure(
            what,
            &String::from_utf8_lossy(&output.stderr),
            &String::from_utf8_lossy(&output.stdout),
        ));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        return Ok(empty);
    }
    serde_json::from_str(trimmed).map_err(|e| format!("parse {} response: {}", what, e))
}

/// [`gh_api_json`] with an `Accept` media type (e.g. [`github_api::HTML_ACCEPT`]).
fn gh_api_json_accept(
    cwd: &str,
    path: &str,
    accept: Option<&str>,
) -> Result<serde_json::Value, String> {
    let mut cmd = gh_api_cmd(cwd);
    cmd.arg("api");
    if let Some(a) = accept {
        cmd.args(["-H", &format!("Accept: {}", a)]);
    }
    let output = cmd
        .arg(path)
        .current_dir(cwd)
        .output()
        .map_err(|e| format!("gh api: {}", e))?;
    gh_api_parse(
        output,
        "gh api failed",
        serde_json::Value::Array(Vec::new()),
    )
}

/// `gh api -X {method} {path}` on `repo`'s host, `stdin` sent as the request
/// body (`--input -`) when given — never in argv, where any local user can read
/// it. The answer parsed as JSON (`Null` when empty).
pub(crate) fn gh_api_on(
    cwd: &str,
    repo: &GhRepo,
    method: &str,
    path: &str,
    stdin: Option<String>,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    let mut cmd = gh_host_cmd(Some(repo));
    cmd.args(["api", "-X", method, path]).current_dir(cwd);
    if stdin.is_some() {
        cmd.args(["--input", "-"]);
    }
    let output = crate::git::output_with_timeout_input(cmd, timeout, stdin)
        .map_err(|e| format!("gh api: {}", e))?;
    gh_api_parse(
        output,
        &format!("gh api {} {}", method, path),
        serde_json::Value::Null,
    )
}

/// Run a mutating `gh api` call (`POST`/`DELETE`) with optional `-f key=value` fields.
/// Returns the parsed JSON body, or `Null` for 204 No Content responses.
fn gh_api_write(
    cwd: &str,
    method: &str,
    path: &str,
    fields: &[(&str, &str)],
) -> Result<serde_json::Value, String> {
    let mut cmd = gh_api_cmd(cwd);
    cmd.args(["api", "-X", method, path]);
    for (k, v) in fields {
        cmd.args(["-f", &format!("{}={}", k, v)]);
    }
    let output = cmd
        .current_dir(cwd)
        .output()
        .map_err(|e| format!("gh api write: {}", e))?;
    gh_api_parse(
        output,
        &format!("gh api {}", method),
        serde_json::Value::Null,
    )
}

fn reactions_api_path(nwo: &str, target_type: &str, target_id: i64) -> String {
    match target_type {
        "pr" => format!("repos/{}/issues/{}/reactions", nwo, target_id),
        "review_comment" => format!("repos/{}/pulls/comments/{}/reactions", nwo, target_id),
        _ => format!("repos/{}/issues/comments/{}/reactions", nwo, target_id),
    }
}

/// gh CLI's own auth token, used to drive the GraphQL-only review-reaction path
/// through the shared `github_api` helpers when no GitWand token is configured.
pub(crate) fn gh_auth_token() -> Option<String> {
    let out = hidden_cmd("gh").args(["auth", "token"]).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let tok = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if tok.is_empty() {
        None
    } else {
        Some(tok)
    }
}

/// Token for reaction calls: the GitWand token if configured, else (only for the
/// GraphQL-only `"review"` target) the gh CLI's own token. Other targets fall
/// back to the plain `gh api` path below when this returns `None`.
///
/// `None` means: take the plain `gh api` path. An organization that refuses the
/// GitWand token is handled by [`github_api::with_rest`].
fn with_reaction_token<T>(
    cwd: &str,
    target_type: &str,
    call: impl Fn(&str) -> Result<T, String>,
) -> Option<Result<T, String>> {
    if let Some(r) = github_api::with_rest(cwd, &call) {
        return Some(r);
    }
    if target_type == "review" {
        return gh_auth_token().map(|tok| call(&tok));
    }
    None
}

fn gh_list_reactions_inner(
    cwd: String,
    number: i64,
    target_type: String,
    target_id: i64,
) -> Result<Vec<serde_json::Value>, String> {
    if let Some(r) = with_reaction_token(&cwd, &target_type, |tok| {
        github_api::rest_list_reactions(&cwd, number, &target_type, target_id, tok)
    }) {
        return r;
    }
    let nwo = gh_base_nwo(&cwd)?;
    let path = reactions_api_path(&nwo, &target_type, target_id);
    let json = gh_api_json(&cwd, &path)?;
    Ok(json
        .as_array()
        .map(|a| a.iter().map(github_api::map_reaction).collect())
        .unwrap_or_default())
}

/// List reactions on a PR or one of its comments.
/// `target_type`: `"pr"` | `"review_comment"` | `"issue_comment"`.
/// `target_id`: PR number for `"pr"`, comment id otherwise.
#[tauri::command]
pub(crate) async fn gh_list_reactions(
    cwd: String,
    number: i64,
    target_type: String,
    target_id: i64,
) -> Result<Vec<serde_json::Value>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        gh_list_reactions_inner(cwd, number, target_type, target_id)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn gh_add_reaction_inner(
    cwd: String,
    number: i64,
    target_type: String,
    target_id: i64,
    content: String,
) -> Result<serde_json::Value, String> {
    if let Some(r) = with_reaction_token(&cwd, &target_type, |tok| {
        github_api::rest_add_reaction(&cwd, number, &target_type, target_id, &content, tok)
    }) {
        return r;
    }
    let nwo = gh_base_nwo(&cwd)?;
    let path = reactions_api_path(&nwo, &target_type, target_id);
    gh_api_write(&cwd, "POST", &path, &[("content", &content)])
}

/// Add a reaction to a PR or comment.
#[tauri::command]
pub(crate) async fn gh_add_reaction(
    cwd: String,
    number: i64,
    target_type: String,
    target_id: i64,
    content: String,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        gh_add_reaction_inner(cwd, number, target_type, target_id, content)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn gh_delete_reaction_inner(
    cwd: String,
    number: i64,
    target_type: String,
    target_id: i64,
    reaction_id: i64,
) -> Result<(), String> {
    if let Some(r) = with_reaction_token(&cwd, &target_type, |tok| {
        github_api::rest_delete_reaction(&cwd, number, &target_type, target_id, reaction_id, tok)
    }) {
        return r;
    }
    let nwo = gh_base_nwo(&cwd)?;
    let path = format!(
        "{}/{}",
        reactions_api_path(&nwo, &target_type, target_id),
        reaction_id
    );
    gh_api_write(&cwd, "DELETE", &path, &[])?;
    Ok(())
}

/// Delete a reaction from a PR or comment.
#[tauri::command]
pub(crate) async fn gh_delete_reaction(
    cwd: String,
    number: i64,
    target_type: String,
    target_id: i64,
    reaction_id: i64,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        gh_delete_reaction_inner(cwd, number, target_type, target_id, reaction_id)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn gh_fork_info_inner(cwd: String) -> Result<ForkInfo, String> {
    if let Some(r) = github_api::with_rest(&cwd, |tok| github_api::rest_fork_info(&cwd, tok)) {
        return r;
    }
    // `origin` and its cached fork lookup (`gh_fork_parent`), shared with the
    // PR commands.
    if let Some(origin) = gh_origin_repo(&cwd) {
        let parent = gh_fork_parent(&cwd, &origin)?;
        return Ok(ForkInfo {
            is_fork: parent.is_some(),
            origin: origin.nwo,
            parent: parent.unwrap_or_default(),
        });
    }
    // No usable `origin`: ask `gh` about the repo it picks itself.
    let output = gh_repo_view_cmd(&cwd, "isFork,parent,nameWithOwner")
        .output()
        .map_err(|e| format!("gh repo view (fork info): {}", e))?;
    if !output.status.success() {
        return Err(format!(
            "gh repo view failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    let v: serde_json::Value = serde_json::from_slice(&output.stdout).map_err(|e| e.to_string())?;
    let parent = fork_parent_nwo(&v);
    Ok(ForkInfo {
        is_fork: parent.is_some(),
        origin: v
            .get("nameWithOwner")
            .and_then(|s| s.as_str())
            .unwrap_or("")
            .to_string(),
        parent: parent.unwrap_or_default(),
    })
}

/// Report the current repo's fork relationship so the PR create view can offer
/// "open against upstream". Token present → REST; otherwise `gh repo view`.
#[tauri::command]
pub(crate) async fn gh_fork_info(cwd: String) -> Result<ForkInfo, String> {
    tauri::async_runtime::spawn_blocking(move || gh_fork_info_inner(cwd))
        .await
        .map_err(|e| e.to_string())?
}

/// Get check-run annotations for a PR (v2.18 — Inline CI Check Annotations).
///
/// Flow:
///   1. `gh pr view --json headRefOid` → head commit SHA
///   2. `gh api repos/{nwo}/commits/{sha}/check-runs` → runs with
///      `output.annotations_count`, `{nwo}` being the base repo (`gh_base_repo`)
///   3. For each run with annotations: `gh api .../check-runs/{id}/annotations`
///
/// A repo without checks/annotations returns `[]`; only a failed lookup of
/// the base repo is an error.
///
/// Offloaded with `spawn_blocking` like its siblings: it was a sync command,
/// so its `gh` round trips ran on the main thread.
#[tauri::command]
pub(crate) async fn gh_check_annotations(
    cwd: String,
    number: i64,
) -> Result<Vec<CIAnnotation>, String> {
    tauri::async_runtime::spawn_blocking(move || gh_check_annotations_inner(cwd, number))
        .await
        .map_err(|e| e.to_string())?
}

fn gh_check_annotations_inner(cwd: String, number: i64) -> Result<Vec<CIAnnotation>, String> {
    // The base repo, resolved once and named on every call (#298). A failed
    // fork lookup is an error, as in the sibling commands (the panel treats
    // it as "no annotations").
    let (base, nwo) = gh_base_target(&cwd)?;
    let mut cmd = gh_cmd(base.as_ref());

    // 1. Head SHA of the PR.
    let output = cmd
        .args(["pr", "view", &number.to_string(), "--json", "headRefOid"])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("gh pr view: {}", e))?;
    if !output.status.success() {
        return Ok(Vec::new());
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let sha = match extract_json_string(stdout.trim(), "headRefOid") {
        Some(s) if !s.is_empty() => s,
        _ => return Ok(Vec::new()),
    };

    // 2. Check-runs for that commit (id + annotations_count).
    let output = gh_host_cmd(base.as_ref())
        .args([
            "api",
            &format!("repos/{}/commits/{}/check-runs?per_page=100", nwo, sha),
        ])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("gh api check-runs: {}", e))?;
    if !output.status.success() {
        return Ok(Vec::new());
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let parsed: serde_json::Value =
        serde_json::from_str(stdout.trim()).unwrap_or(serde_json::Value::Null);
    let runs = parsed
        .get("check_runs")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    // 3. Fetch annotations for runs that have any. Cap the number of runs
    //    queried so a pathological CI setup can't fan out dozens of API calls.
    const MAX_ANNOTATED_RUNS: usize = 20;
    let mut annotations = Vec::new();
    for run in runs
        .iter()
        .filter(|r| {
            r.get("output")
                .and_then(|o| o.get("annotations_count"))
                .and_then(|c| c.as_i64())
                .unwrap_or(0)
                > 0
        })
        .take(MAX_ANNOTATED_RUNS)
    {
        let run_id = match run.get("id").and_then(|v| v.as_i64()) {
            Some(id) => id,
            None => continue,
        };
        let check_name = run
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let output = gh_host_cmd(base.as_ref())
            .args([
                "api",
                &format!(
                    "repos/{}/check-runs/{}/annotations?per_page=100",
                    nwo, run_id
                ),
            ])
            .current_dir(&cwd)
            .output();
        let output = match output {
            Ok(o) if o.status.success() => o,
            _ => continue, // annotations gone (e.g. expired) — skip this run
        };
        let stdout = String::from_utf8_lossy(&output.stdout);
        let arr: serde_json::Value =
            serde_json::from_str(stdout.trim()).unwrap_or(serde_json::Value::Array(vec![]));
        let Some(items) = arr.as_array() else {
            continue;
        };

        for a in items {
            let s = |k: &str| a.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
            let n = |k: &str| a.get(k).and_then(|v| v.as_i64()).unwrap_or(0);
            // GitHub levels are already our canonical set.
            let level = match s("annotation_level").as_str() {
                "failure" => "failure",
                "warning" => "warning",
                _ => "notice",
            };
            annotations.push(CIAnnotation {
                check_name: check_name.clone(),
                path: s("path"),
                start_line: n("start_line"),
                end_line: n("end_line").max(n("start_line")),
                level: level.to_string(),
                title: s("title"),
                message: s("message"),
            });
        }
    }

    Ok(annotations)
}

fn gh_list_issues_inner(
    cwd: String,
    filter: String,
    limit: Option<i64>,
) -> Result<Vec<crate::types::Issue>, String> {
    let lim = limit.unwrap_or(100).max(1);

    // Settings-managed OAuth token present → tokenless REST path (no `gh`).
    if let Some(r) = github_api::with_rest(&cwd, |tok| {
        let me = match filter.as_str() {
            "assigned" | "created" | "mentioned" => {
                github_api::rest_current_user(tok).unwrap_or_default()
            }
            _ => String::new(),
        };
        github_api::rest_list_issues(&cwd, &filter, &me, lim, tok)
    }) {
        return r;
    }

    // Fallback: shell `gh issue list` (mirrors workspace_issues_all gh path).
    // The base repo, as for `gh_issue_detail`.
    let mut cmd = gh_base_cmd(&cwd)?;
    cmd.args([
        "issue",
        "list",
        "--state",
        "open",
        "--json",
        "number,title,state,author,assignees,labels,url,createdAt,updatedAt,milestone",
        "--limit",
        &lim.to_string(),
    ]);
    match filter.as_str() {
        "assigned" => {
            cmd.args(["--assignee", "@me"]);
        }
        "created" => {
            cmd.args(["--author", "@me"]);
        }
        "mentioned" => {
            cmd.args(["--search", "mentions:@me"]);
        }
        _ => {}
    }
    let output = cmd
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("gh not available: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("gh issue list failed: {}", stderr.trim()));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    crate::git::parse::parse_gh_issue_json(&stdout)
}

#[tauri::command]
pub(crate) async fn gh_list_issues(
    cwd: String,
    filter: String,
    limit: Option<i64>,
) -> Result<Vec<crate::types::Issue>, String> {
    tauri::async_runtime::spawn_blocking(move || gh_list_issues_inner(cwd, filter, limit))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod gh_list_issues_tests {
    use crate::git::parse::parse_gh_issue_json;

    #[test]
    fn parses_gh_issue_list_json_into_issues() {
        let json = r#"[
            {"number":7,"title":"Bug","state":"OPEN",
             "author":{"login":"alice"},
             "assignees":[{"login":"bob"}],
             "labels":[{"name":"bug"}],
             "url":"https://github.com/o/r/issues/7",
             "createdAt":"2026-01-01T00:00:00Z",
             "updatedAt":"2026-01-02T00:00:00Z",
             "milestone":{"title":"v1"}}
        ]"#;
        let issues = parse_gh_issue_json(json).expect("parses");
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].number, 7);
        assert_eq!(issues[0].author, "alice");
        assert_eq!(issues[0].assignees, vec!["bob".to_string()]);
        assert_eq!(issues[0].milestone, "v1");
    }
}

#[cfg(test)]
mod gh_pr_freshness_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn top_pr_from_cli_json_reads_first_entry() {
        let raw = vec![json!({"number": 12, "updatedAt": "2026-07-09T09:00:00Z"})];
        assert_eq!(
            top_pr_from_cli_json(&raw),
            Some((12, "2026-07-09T09:00:00Z".to_string()))
        );
    }

    #[test]
    fn top_pr_from_cli_json_empty_list_is_none() {
        assert_eq!(top_pr_from_cli_json(&[]), None);
    }

    #[test]
    fn top_pr_from_cli_json_missing_updated_at_is_none() {
        let raw = vec![json!({"number": 12})];
        assert_eq!(top_pr_from_cli_json(&raw), None);
    }
}

#[cfg(test)]
mod gh_should_fetch_origin_tests {
    use super::*;

    #[test]
    fn throttles_repeated_calls_for_the_same_repo() {
        let cwd = "/tmp/gitwand-test-gh-throttle-unique-abc";
        assert!(gh_should_fetch_origin(cwd));
        assert!(!gh_should_fetch_origin(cwd));
    }

    #[test]
    fn does_not_throttle_a_different_repo() {
        let a = "/tmp/gitwand-test-gh-throttle-unique-def";
        let b = "/tmp/gitwand-test-gh-throttle-unique-ghi";
        assert!(gh_should_fetch_origin(a));
        assert!(gh_should_fetch_origin(b));
    }
}

/// Per-PR auto-merge state from a `gh pr list` / `gh pr view` JSON object.
///
/// `autoMergeRequest` is a flat node: present and non-null when a merge is
/// queued, explicitly `null` otherwise. GitHub has no per-PR precondition
/// beyond the repository setting, so `available` is unconditionally true
/// here; whether the repository allows it at all is `gh_auto_merge_support`.
pub(crate) fn gh_auto_merge_state(pr: &serde_json::Value) -> crate::types::AutoMergeState {
    crate::types::AutoMergeState {
        armed: pr.get("autoMergeRequest").is_some_and(|v| !v.is_null()),
        available: true,
        reason: None,
    }
}

/// Repository-level capability from `autoMergeAllowed` on GitHub's GraphQL
/// `Repository` type, reachable via `gh api graphql` (NOT `gh repo view
/// --json autoMergeAllowed`, which `gh repo view` rejects with "Unknown JSON
/// field").
///
/// Fails closed: a missing or non-boolean field reads as unsupported. An
/// older `gh`, or a shape we did not anticipate, must hide the button rather
/// than offer one that cannot work.
pub(crate) fn gh_auto_merge_support(
    repo_view: &serde_json::Value,
) -> crate::types::AutoMergeSupport {
    if repo_view
        .get("autoMergeAllowed")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
    {
        crate::types::AutoMergeSupport {
            supported: true,
            reason: None,
        }
    } else {
        crate::types::AutoMergeSupport {
            supported: false,
            reason: Some("Auto-merge is disabled in this repository's settings.".to_string()),
        }
    }
}

#[cfg(test)]
mod gh_auto_merge_tests {
    use super::{gh_auto_merge_state, gh_auto_merge_support};

    #[test]
    fn a_pr_with_auto_merge_queued_is_armed() {
        let v: serde_json::Value = serde_json::from_str(
            r#"{"number": 7, "autoMergeRequest": {"enabledAt": "2026-09-14T10:00:00Z"}}"#,
        )
        .unwrap();
        let s = gh_auto_merge_state(&v);
        assert!(s.armed);
        assert!(s.available);
        assert_eq!(s.reason, None);
    }

    #[test]
    fn a_pr_without_auto_merge_is_not_armed_but_is_available() {
        let v: serde_json::Value = serde_json::from_str(r#"{"number": 7}"#).unwrap();
        let s = gh_auto_merge_state(&v);
        assert!(!s.armed);
        assert!(
            s.available,
            "GitHub has no per-PR precondition beyond the repo setting"
        );
    }

    #[test]
    fn an_explicit_null_auto_merge_request_is_not_armed() {
        // `gh pr list --json autoMergeRequest` emits an explicit null, not an
        // absent key, which is a different JSON shape from the test above.
        let v: serde_json::Value =
            serde_json::from_str(r#"{"number": 7, "autoMergeRequest": null}"#).unwrap();
        assert!(!gh_auto_merge_state(&v).armed);
    }

    #[test]
    fn a_repo_with_auto_merge_disabled_is_unsupported_with_a_reason() {
        let v: serde_json::Value = serde_json::from_str(r#"{"autoMergeAllowed": false}"#).unwrap();
        let s = gh_auto_merge_support(&v);
        assert!(!s.supported);
        assert_eq!(
            s.reason.as_deref(),
            Some("Auto-merge is disabled in this repository's settings.")
        );
    }

    #[test]
    fn a_repo_with_auto_merge_allowed_is_supported() {
        let v: serde_json::Value = serde_json::from_str(r#"{"autoMergeAllowed": true}"#).unwrap();
        let s = gh_auto_merge_support(&v);
        assert!(s.supported);
        assert_eq!(s.reason, None);
    }

    #[test]
    fn a_missing_field_is_treated_as_unsupported_not_as_allowed() {
        // An older `gh`, or a response shape we did not anticipate, must fail
        // closed: offering a button that cannot work is worse than hiding one
        // that could.
        let v: serde_json::Value = serde_json::from_str(r#"{}"#).unwrap();
        assert!(!gh_auto_merge_support(&v).supported);
    }
}

#[cfg(test)]
mod repo_targeting_tests {
    use super::*;

    /// Parse with an `ssh -G` that knows `aliases` (`None` = no `ssh`; an
    /// unknown host is echoed back, as `ssh -G` does) and a `gh` signed in to
    /// `gh_hosts`.
    fn parse_with(
        url: &str,
        aliases: Option<&[(&str, &str)]>,
        gh_hosts: &[&str],
    ) -> Option<(String, String)> {
        gh_repo_from_url_with(
            url,
            |host| {
                aliases.map(|a| {
                    a.iter()
                        .find(|(k, _)| *k == host)
                        .map_or(host.to_string(), |(_, v)| v.to_string())
                })
            },
            |host| gh_hosts.contains(&host),
        )
        .map(|r| (r.selector(), r.nwo))
    }

    fn parse(url: &str) -> Option<(String, String)> {
        parse_with(url, Some(&[]), &[])
    }

    fn gh_repo(url: &str, gh_hosts: &[&str]) -> GhRepo {
        gh_repo_from_url_with(url, |_| None, |h| gh_hosts.contains(&h)).unwrap()
    }

    fn pair(sel: &str, nwo: &str) -> Option<(String, String)> {
        Some((sel.to_string(), nwo.to_string()))
    }

    #[test]
    fn github_com_remotes_need_no_host() {
        for url in [
            "https://github.com/me/project.git",
            "https://github.com/me/project",
            "https://github.com/me/project/",
            "https://user@github.com/me/project.git",
            "git@github.com:me/project.git",
            "alice@github.com:me/project.git",
            "org-123@github.com:me/project.git",
            "github.com:me/project.git",
            "ssh://git@github.com/me/project.git",
            "ssh://git@ssh.github.com:443/me/project.git",
            "git+ssh://git@github.com/me/project.git",
            "https://github.com/me/project.git\n",
        ] {
            assert_eq!(parse(url), pair("me/project", "me/project"), "{url}");
        }
    }

    #[test]
    fn an_ssh_alias_is_resolved_like_gh_does() {
        let cfg: &[(&str, &str)] = &[
            ("github.com-work", "github.com"),
            ("gh-perso", "github.com"),
            ("work", "github.acme.corp"),
        ];
        let hosts = &["github.acme.corp"];
        assert_eq!(
            parse_with("git@github.com-work:me/project.git", Some(cfg), hosts),
            pair("me/project", "me/project")
        );
        assert_eq!(
            parse_with("git@gh-perso:me/project.git", Some(cfg), hosts),
            pair("me/project", "me/project")
        );
        // An alias for an Enterprise host keeps that host.
        assert_eq!(
            parse_with("git@work:team/app.git", Some(cfg), hosts),
            pair("github.acme.corp/team/app", "team/app")
        );
        assert_eq!(
            parse_with("ssh://git@work:2222/team/app.git", Some(cfg), hosts),
            pair("github.acme.corp/team/app", "team/app")
        );
    }

    /// A host that is neither github.com nor one `gh` is signed in to is not
    /// a GitHub remote: `gh` would not use it either.
    #[test]
    fn a_host_gh_does_not_know_is_not_a_github_remote() {
        // An alias `ssh` has no entry for (echoed back) or cannot be asked about.
        assert_eq!(parse("git@github.com-work:me/project.git"), None);
        assert_eq!(parse_with("git@gh-perso:me/project.git", None, &[]), None);
        // A plain git server, GitLab.
        assert_eq!(parse("git@gitserver:team/app.git"), None);
        assert_eq!(parse("https://gitlab.com/team/app.git"), None);
        assert_eq!(parse("git@github.company.com:team/app.git"), None);
    }

    #[test]
    fn an_enterprise_host_is_named_in_the_selector_only() {
        let hosts = &[
            "github.acme.corp",
            "acme.ghe.com",
            "github.company.com",
            "ghe",
        ];
        for (url, sel) in [
            (
                "https://github.acme.corp/team/app.git",
                "github.acme.corp/team/app",
            ),
            ("git@acme.ghe.com:team/app.git", "acme.ghe.com/team/app"),
            // Names that merely contain "github.com" are Enterprise hosts too.
            (
                "git@github.company.com:team/app.git",
                "github.company.com/team/app",
            ),
            ("https://ghe/team/app.git", "ghe/team/app"),
            ("https://user@ghe/team/app.git", "ghe/team/app"),
        ] {
            assert_eq!(
                parse_with(url, Some(&[]), hosts),
                pair(sel, "team/app"),
                "{url}"
            );
        }
    }

    #[test]
    fn an_unparseable_remote_resolves_to_nothing() {
        assert_eq!(parse(""), None);
        assert_eq!(parse("/srv/git/project.git"), None);
        assert_eq!(parse("./relative:odd/path"), None);
        assert_eq!(parse("C:\\repos\\project"), None);
        assert_eq!(parse("file:///srv/git/me/project.git"), None);
        assert_eq!(parse("https://github.com/only-owner"), None);
    }

    #[test]
    fn a_fork_parent_is_read_only_for_a_fork() {
        let fork = serde_json::json!({
            "isFork": true,
            "parent": { "owner": { "login": "up" }, "name": "project" }
        });
        assert_eq!(fork_parent_nwo(&fork), Some("up/project".to_string()));
        let not_fork = serde_json::json!({ "isFork": false, "parent": null });
        assert_eq!(fork_parent_nwo(&not_fork), None);
        let broken = serde_json::json!({ "isFork": true, "parent": null });
        assert_eq!(fork_parent_nwo(&broken), None);
    }

    #[test]
    fn a_sibling_keeps_the_host() {
        let origin = gh_repo("https://github.acme.corp/me/app.git", &["github.acme.corp"]);
        let parent = origin.sibling("team/app".to_string());
        assert_eq!(parent.selector(), "github.acme.corp/team/app");
        assert_eq!(parent.enterprise_host(), Some("github.acme.corp"));
    }

    fn env_of(cmd: &std::process::Command, key: &str) -> Option<String> {
        cmd.get_envs()
            .find(|(k, _)| *k == std::ffi::OsStr::new(key))
            .and_then(|(_, v)| v.map(|v| v.to_string_lossy().to_string()))
    }

    #[test]
    fn gh_cmd_names_the_repo_and_host_through_the_environment_not_a_flag() {
        let ghe = gh_repo("https://github.acme.corp/me/app.git", &["github.acme.corp"]);
        let cmd = gh_cmd(Some(&ghe));
        assert_eq!(
            env_of(&cmd, "GH_REPO").as_deref(),
            Some("github.acme.corp/me/app")
        );
        assert_eq!(env_of(&cmd, "GH_HOST").as_deref(), Some("github.acme.corp"));
        // `gh pr merge` skips its local cleanup whenever --repo is given.
        assert_eq!(cmd.get_args().count(), 0);

        // github.com is named too, so a `GH_HOST` in the user's environment
        // cannot redirect a github.com repo.
        let dotcom = gh_repo("git@github.com:me/app.git", &[]);
        let cmd = gh_cmd(Some(&dotcom));
        assert_eq!(env_of(&cmd, "GH_REPO").as_deref(), Some("me/app"));
        assert_eq!(env_of(&cmd, "GH_HOST").as_deref(), Some("github.com"));
        assert_eq!(env_of(&gh_host_cmd(Some(&dotcom)), "GH_REPO"), None);
        assert_eq!(env_of(&gh_cmd(None), "GH_REPO"), None);
        assert_eq!(env_of(&gh_cmd(None), "GH_HOST"), None);
    }

    #[test]
    fn a_cached_fork_answer_needs_no_gh_call() {
        let origin = gh_repo("git@github.com:cache-test/fork.git", &[]);
        *gh_fork_parent_slot(&origin.selector()).lock().unwrap() =
            Some((Some("cache-test/parent".to_string()), Instant::now()));
        // A cwd where any `gh` spawn would fail: the answer must come from the cache.
        assert_eq!(
            gh_fork_parent("/nonexistent-gitwand-298", &origin),
            Ok(Some("cache-test/parent".to_string()))
        );
    }

    /// A throwaway repo with the given remotes; removed on drop.
    struct TempRepo(std::path::PathBuf);

    impl TempRepo {
        fn new(tag: &str, remotes: &[(&str, &str)]) -> TempRepo {
            let dir = std::env::temp_dir().join(format!("gw-298-{}-{}", tag, std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            let repo = TempRepo(dir);
            repo.git(&["init", "-q"]);
            for (name, url) in remotes {
                repo.git(&["remote", "add", name, url]);
            }
            repo
        }
        fn git(&self, args: &[&str]) {
            let ok = hidden_cmd("git")
                .args(args)
                .current_dir(&self.0)
                .status()
                .unwrap()
                .success();
            assert!(ok, "git {:?}", args);
        }
        fn cwd(&self) -> String {
            self.0.to_string_lossy().to_string()
        }
    }

    impl Drop for TempRepo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// #298: an unrelated `upstream` remote must not pull the target away
    /// from `origin` (`gh` alone would pick `upstream` first).
    #[test]
    fn origin_wins_over_an_upstream_remote() {
        let repo = TempRepo::new(
            "origin",
            &[
                ("upstream", "https://github.com/other/unrelated.git"),
                ("origin", "git@github.com:me/project.git"),
            ],
        );
        assert_eq!(
            gh_origin_repo(&repo.cwd()).map(|r| r.selector()),
            Some("me/project".to_string())
        );
    }

    #[test]
    fn a_pr_url_gives_its_repo_on_any_host() {
        assert_eq!(
            github_nwo_from_pr_url("https://github.com/up/project/pull/12"),
            Some("up/project".to_string())
        );
        assert_eq!(
            github_nwo_from_pr_url("https://github.acme.corp/team/app/pull/5"),
            Some("team/app".to_string())
        );
        assert_eq!(
            github_nwo_from_pr_url("https://github.com/up/project"),
            None
        );
        assert_eq!(github_nwo_from_pr_url(""), None);
    }

    #[test]
    fn a_positive_host_answer_is_kept_and_a_negative_one_asked_again() {
        let kept = "test:kept-298".to_string();
        assert_eq!(
            cached_host_answer(kept.clone(), || Some("a".into())),
            Some("a".into())
        );
        assert_eq!(
            cached_host_answer(kept, || Some("b".into())),
            Some("a".into())
        );

        let fresh_miss = "test:miss-298".to_string();
        assert_eq!(cached_host_answer(fresh_miss.clone(), || None), None);
        // Within the negative TTL the miss is reused…
        assert_eq!(cached_host_answer(fresh_miss, || Some("late".into())), None);
        // …and once it is older, asked again.
        let stale_miss = "test:stale-298".to_string();
        let old = Instant::now()
            .checked_sub(HOST_NEGATIVE_TTL + Duration::from_secs(1))
            .unwrap();
        host_answer_cache()
            .lock()
            .unwrap()
            .insert(stale_miss.clone(), (None, old));
        assert_eq!(
            cached_host_answer(stale_miss, || Some("now".into())),
            Some("now".into())
        );
    }

    #[test]
    fn a_remote_is_read_after_its_insteadof_rewrite() {
        let repo = TempRepo::new("insteadof", &[]);
        repo.git(&["config", "url.https://github.com/.insteadOf", "gh:"]);
        repo.git(&["remote", "add", "origin", "gh:me/project"]);
        let me = gh_repo("https://github.com/me/project", &[]);
        assert!(gh_repo_is_a_remote(&repo.cwd(), &me));
    }

    #[test]
    fn a_base_repo_is_a_remote_only_when_one_points_at_it() {
        let repo = TempRepo::new(
            "remote",
            &[
                ("origin", "git@github.com:me/fork.git"),
                ("upstream", "https://github.com/Up/Project.git"),
            ],
        );
        let cwd = repo.cwd();
        let as_repo = |nwo: &str| gh_repo(&format!("https://github.com/{nwo}"), &[]);
        assert!(gh_repo_is_a_remote(&cwd, &as_repo("up/project")));
        assert!(gh_repo_is_a_remote(&cwd, &as_repo("me/fork")));
        assert!(!gh_repo_is_a_remote(&cwd, &as_repo("someone/else")));
    }
}

#[cfg(test)]
mod gh_api_failure_tests {
    use super::gh_api_failure;

    #[test]
    fn gh_api_failure_keeps_githubs_validation_details() {
        let stdout =
            r#"{"message":"Validation Failed","errors":[{"field":"assignees","code":"invalid"}]}"#;
        assert_eq!(
            gh_api_failure(
                "gh api POST repos/o/r/issues",
                "gh: Validation Failed (HTTP 422)\n",
                stdout
            ),
            "GitHub API error (422): Validation Failed (assignees: invalid)"
        );
    }

    #[test]
    fn gh_api_failure_without_a_json_answer_keeps_stderr() {
        assert_eq!(
            gh_api_failure("gh api GET x", "error connecting to api.github.com\n", ""),
            "gh api GET x: error connecting to api.github.com"
        );
    }
}

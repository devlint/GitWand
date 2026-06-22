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

use crate::git::*;
use crate::types::*;
use crate::commands::github_api;
use serde_json;

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
    if let Some(tok) = github_api::settings_github_token() {
        let st = if state.is_empty() { "open" } else { &state };
        return github_api::rest_list_prs(&cwd, st, limit.unwrap_or(10), offset.unwrap_or(0), &tok);
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

    // For forks, `gh pr list` without --repo targets the fork itself (0 PRs).
    // Resolve the upstream parent so the list matches the OAuth/REST path.
    let target_repo = gh_fork_upstream(&cwd);

    // GH_TOKEN propagation is handled centrally by `hidden_cmd` (cf. git/cmd.rs).
    let mut cmd = hidden_cmd("gh");
    cmd.args([
        "pr", "list",
        "--state", st,
        "--json", "number,title,state,author,headRefName,baseRefName,isDraft,createdAt,updatedAt,url,labels,assignees,mergeStateStatus,statusCheckRollup",
        "--limit", &total,
    ]);
    if let Some(ref nwo) = target_repo {
        cmd.args(["--repo", nwo]);
    }
    let output = cmd
        .current_dir(&cwd)
        .output()
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
    // Fetch remote branches once so numstat can resolve origin/branch refs.
    if !prs.is_empty() && off == 0 {
        let _ = hidden_cmd("git").args(["fetch", "origin"]).current_dir(&cwd).output();
    }
    for pr in &mut prs {
        let (adds, dels) = github_api::diff_numstat(&cwd, &pr.branch, &pr.base);
        pr.additions = adds;
        pr.deletions = dels;
    }

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
    if let Some(tok) = github_api::settings_github_token() {
        return github_api::rest_pr_count(&cwd, &state, &tok);
    }
    let st = state.to_lowercase();
    let states_expr = match st.as_str() {
        "closed" => "[CLOSED]",
        "merged" => "[MERGED]",
        "all"    => "[OPEN, CLOSED, MERGED]",
        _        => "[OPEN]",
    };

    // Resolve owner/name once via `gh repo view`. `nameWithOwner` is the
    // canonical "org/repo" slug — splittable by '/' without ambiguity.
    // v2.17: include isFork and parent to correctly count PRs in the base repo
    // (the target repo that `gh pr list` would use by default).
    let view = hidden_cmd("gh")
        .args(["repo", "view", "--json", "nameWithOwner,isFork,parent"])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("gh repo view (for pr count): {}", e))?;
    if !view.status.success() {
        return Err(format!(
            "gh repo view failed: {}",
            String::from_utf8_lossy(&view.stderr)
        ));
    }

    let v: serde_json::Value = serde_json::from_slice(&view.stdout).map_err(|e| e.to_string())?;
    let is_fork = v.get("isFork").and_then(|b| b.as_bool()).unwrap_or(false);
    let nwo = if is_fork {
        v.get("parent")
            .and_then(|p| {
                let owner = p.get("owner").and_then(|o| o.get("login")).and_then(|s| s.as_str())?;
                let name = p.get("name").and_then(|s| s.as_str())?;
                Some(format!("{}/{}", owner, name))
            })
            .or_else(|| v.get("nameWithOwner").and_then(|s| s.as_str()).map(|s| s.to_string()))
            .unwrap_or_default()
    } else {
        v.get("nameWithOwner").and_then(|s| s.as_str()).unwrap_or("").to_string()
    };

    let (owner, name) = match nwo.split_once('/') {
        Some((o, n)) if !o.is_empty() && !n.is_empty() => (o.to_string(), n.to_string()),
        _ => return Err(format!("Unexpected nameWithOwner format: {}", nwo)),
    };

    // GraphQL query — single edge, no nested objects beyond totalCount.
    let query = format!(
        "query($owner:String!,$name:String!) {{ repository(owner:$owner,name:$name) {{ pullRequests(states:{}) {{ totalCount }} }} }}",
        states_expr
    );
    let out = hidden_cmd("gh")
        .args([
            "api", "graphql",
            "-F", &format!("owner={}", owner),
            "-F", &format!("name={}", name),
            "-f", &format!("query={}", query),
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
    let start = stdout.find(key)
        .ok_or_else(|| format!("totalCount missing from response: {}", stdout))?;
    let after = &stdout[start + key.len()..];
    let colon = after.find(':').ok_or_else(|| "malformed totalCount".to_string())?;
    let tail = after[colon + 1..].trim_start();
    let end = tail.find(|c: char| !c.is_ascii_digit()).unwrap_or(tail.len());
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
/// after resolving `owner/name` via `gh repo view --json nameWithOwner`.
/// Both calls are cheap (<200 ms) and avoid expanding the PR objects.
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

fn gh_create_pr_inner(
    cwd: String,
    title: String,
    body: String,
    base: String,
    base_repo: Option<String>,
    draft: bool,
    reviewers: Option<Vec<String>>,
) -> Result<PullRequest, String> {
    if let Some(tok) = github_api::settings_github_token() {
        return github_api::rest_create_pr(&cwd, title, body, base, base_repo, draft, reviewers, &tok);
    }
    let mut args = vec![
        "pr".to_string(),
        "create".to_string(),
        "--title".to_string(),
        title,
        "--body".to_string(),
        body,
    ];

    // Cross-fork target: `gh pr create --repo owner/repo` opens the PR against
    // that repo, using the current fork branch as head automatically.
    if let Some(repo) = base_repo {
        if !repo.trim().is_empty() {
            args.push("--repo".to_string());
            args.push(repo.trim().to_string());
        }
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
    let output = hidden_cmd("gh")
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
            "--json", "number,title,state,author,headRefName,baseRefName,isDraft,createdAt,updatedAt,url,additions,deletions,labels,assignees,reviewRequests,reviewDecision,mergeStateStatus,statusCheckRollup",
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
    // Discover owner/repo from the current repo.
    let view = hidden_cmd("gh")
        .args(["repo", "view", "--json", "owner,name"])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to inspect repo: {}", e))?;
    if !view.status.success() {
        return Err(format!(
            "gh repo view failed: {}",
            String::from_utf8_lossy(&view.stderr)
        ));
    }
    #[derive(serde::Deserialize)]
    struct OwnerLogin { login: String }
    #[derive(serde::Deserialize)]
    struct RepoView { owner: OwnerLogin, name: String }
    let repo: RepoView = serde_json::from_slice(&view.stdout)
        .map_err(|e| format!("Failed to parse repo view: {}", e))?;
    let endpoint = format!("/repos/{}/{}/assignees", repo.owner.login, repo.name);

    // Fetch up to ~300 candidates (3 pages of 100). Plenty for typical repos.
    let output = hidden_cmd("gh")
        .args([
            "api",
            "--paginate",
            "-H", "Accept: application/vnd.github+json",
            &endpoint,
            "--jq", "[.[] | {login: .login, name: .name, avatar_url: .avatar_url}]",
        ])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to list reviewer candidates: {}", e))?;
    if !output.status.success() {
        return Err(format!(
            "gh api assignees failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    // --paginate concatenates JSON arrays page-by-page (one per line).
    // Parse each non-empty line as a JSON array and flatten.
    let raw = String::from_utf8_lossy(&output.stdout);
    let mut all: Vec<ReviewerCandidate> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for chunk in raw.split('\n') {
        let trimmed = chunk.trim();
        if trimmed.is_empty() { continue; }
        // gh might return either a single array per chunk (--jq with array wrapper)
        // or NDJSON of arrays. Try to parse as Value and walk.
        let value: serde_json::Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if let Some(arr) = value.as_array() {
            for item in arr {
                let login = item.get("login").and_then(|v| v.as_str()).unwrap_or("");
                if login.is_empty() || !seen.insert(login.to_string()) { continue; }
                all.push(ReviewerCandidate {
                    login: login.to_string(),
                    name: item.get("name").and_then(|v| v.as_str()).map(|s| s.to_string()),
                    avatar_url: item.get("avatar_url").and_then(|v| v.as_str()).map(|s| s.to_string()),
                });
            }
        }
    }
    // Sort alphabetically by login for stable UX.
    all.sort_by(|a, b| a.login.to_lowercase().cmp(&b.login.to_lowercase()));
    Ok(all)
}

/// List candidate reviewers for the current repo using `gh` CLI.
///
/// Calls `gh api /repos/:owner/:repo/assignees` (paginated) which returns
/// users with push access — exactly the set GitHub allows as reviewers.
#[tauri::command]
pub(crate) async fn gh_list_reviewer_candidates(cwd: String) -> Result<Vec<ReviewerCandidate>, String> {
    tauri::async_runtime::spawn_blocking(move || gh_list_reviewer_candidates_inner(cwd))
        .await
        .map_err(|e| e.to_string())?
}

fn gh_checkout_pr_inner(cwd: String, number: i64) -> Result<(), String> {
    if github_api::settings_github_token().is_some() {
        return github_api::rest_checkout_pr(&cwd, number);
    }
    let output = hidden_cmd("gh")
        .args(["pr", "checkout", &number.to_string()])
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
    if let Some(tok) = github_api::settings_github_token() {
        return github_api::rest_merge_pr(&cwd, number, &method, &tok);
    }
    let merge_flag = match method.as_str() {
        "squash" => "--squash",
        "rebase" => "--rebase",
        _ => "--merge",
    };

    let output = hidden_cmd("gh")
        .args(["pr", "merge", &number.to_string(), merge_flag, "--delete-branch"])
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

fn gh_pr_ready_inner(cwd: String, number: i64) -> Result<(), String> {
    if let Some(tok) = github_api::settings_github_token() {
        return github_api::rest_pr_ready(&cwd, number, &tok);
    }
    let output = hidden_cmd("gh")
        .args(["pr", "ready", &number.to_string()])
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

fn gh_pr_detail_inner(cwd: String, number: i64) -> Result<PullRequestDetail, String> {
    if let Some(tok) = github_api::settings_github_token() {
        return github_api::rest_pr_detail(&cwd, number, &tok);
    }
    let upstream = gh_fork_upstream(&cwd);
    let num = number.to_string();
    let mut cmd = hidden_cmd("gh");
    cmd.args([
        "pr", "view", &num,
        "--json", "number,title,body,state,author,headRefName,baseRefName,isDraft,createdAt,updatedAt,mergedAt,url,additions,deletions,changedFiles,comments,reviewRequests,labels,reviews,mergeable,statusCheckRollup",
    ]);
    if let Some(ref nwo) = upstream {
        cmd.args(["--repo", nwo]);
    }
    let output = cmd
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("gh pr view: {}", e))?;

    if !output.status.success() {
        return Err(format!("gh pr view failed: {}", String::from_utf8_lossy(&output.stderr)));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let raw: GhPrDetailRaw = serde_json::from_str(stdout.trim())
        .map_err(|e| format!("Failed to parse gh pr view output: {}", e))?;

    let mut detail = gh_pr_detail_raw_to_detail(raw);
    detail.can_merge = gh_viewer_can_merge(&cwd, &detail.url);
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
    if let Some(tok) = github_api::settings_github_token() {
        return github_api::rest_issue_detail(&cwd, number, &tok);
    }
    let num = number.to_string();
    let output = hidden_cmd("gh")
        .args([
            "issue", "view", &num,
            "--json", "number,title,body,state,author,assignees,labels,url,createdAt,updatedAt,milestone,comments",
        ])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("gh issue view: {}", e))?;
    if !output.status.success() {
        return Err(format!("gh issue view failed: {}", String::from_utf8_lossy(&output.stderr)));
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
    if let Some(tok) = github_api::settings_github_token() {
        return github_api::rest_issue_comments(&cwd, number, &tok);
    }
    let nwo = gh_current_nwo(&cwd).ok_or_else(|| "Could not resolve owner/repo".to_string())?;
    let path = format!("repos/{}/issues/{}/comments?per_page=100", nwo, number);
    let output = hidden_cmd("gh")
        .args(["api", &path])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("gh api issue comments: {}", e))?;
    if !output.status.success() {
        return Err(format!("gh api issue comments failed: {}", String::from_utf8_lossy(&output.stderr)));
    }
    let v: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("parse issue comments: {}", e))?;
    Ok(github_api::map_comments(&v, true))
}

/// List conversation comments on an issue.
#[tauri::command]
pub(crate) async fn gh_issue_comments(cwd: String, number: i64) -> Result<Vec<serde_json::Value>, String> {
    tauri::async_runtime::spawn_blocking(move || gh_issue_comments_inner(cwd, number))
        .await
        .map_err(|e| e.to_string())?
}

fn gh_issue_add_comment_inner(cwd: String, number: i64, body: String) -> Result<serde_json::Value, String> {
    if let Some(tok) = github_api::settings_github_token() {
        return github_api::rest_issue_add_comment(&cwd, number, &body, &tok);
    }
    let nwo = gh_current_nwo(&cwd).ok_or_else(|| "Could not resolve owner/repo".to_string())?;
    let path = format!("repos/{}/issues/{}/comments", nwo, number);
    let field = format!("body={}", body);
    let output = hidden_cmd("gh")
        .args(["api", &path, "-X", "POST", "-f", &field])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("gh api add comment: {}", e))?;
    if !output.status.success() {
        return Err(format!("gh api add comment failed: {}", String::from_utf8_lossy(&output.stderr)));
    }
    let v: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("parse created comment: {}", e))?;
    Ok(github_api::map_comment(&v, true))
}

/// Add a comment to an issue. Returns the created comment (mapped shape).
#[tauri::command]
pub(crate) async fn gh_issue_add_comment(cwd: String, number: i64, body: String) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || gh_issue_add_comment_inner(cwd, number, body))
        .await
        .map_err(|e| e.to_string())?
}

fn gh_issue_set_state_inner(cwd: String, number: i64, state: String) -> Result<(), String> {
    if let Some(tok) = github_api::settings_github_token() {
        return github_api::rest_issue_set_state(&cwd, number, &state, &tok);
    }
    let num = number.to_string();
    // "closed" → `gh issue close`, anything else → `gh issue reopen`.
    let sub = if state == "closed" { "close" } else { "reopen" };
    let output = hidden_cmd("gh")
        .args(["issue", sub, &num])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("gh issue {}: {}", sub, e))?;
    if !output.status.success() {
        return Err(format!("gh issue {} failed: {}", sub, String::from_utf8_lossy(&output.stderr)));
    }
    Ok(())
}

/// Close (`state="closed"`) or reopen (`state="open"`) an issue.
#[tauri::command]
pub(crate) async fn gh_issue_set_state(cwd: String, number: i64, state: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || gh_issue_set_state_inner(cwd, number, state))
        .await
        .map_err(|e| e.to_string())?
}

// ─── Private sync helpers ────────────────────────────────────────────────────

/// When `cwd` is a GitHub fork, returns the upstream parent `owner/repo` slug.
/// Returns `None` for regular (non-fork) repos or on any failure — callers
/// fall back to `gh`'s default repo inference, which is correct for non-forks.
fn gh_fork_upstream(cwd: &str) -> Option<String> {
    let out = hidden_cmd("gh")
        .args(["repo", "view", "--json", "isFork,parent"])
        .current_dir(cwd)
        .output()
        .ok()
        .filter(|o| o.status.success())?;
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).ok()?;
    if !v.get("isFork").and_then(|b| b.as_bool()).unwrap_or(false) {
        return None;
    }
    v.get("parent").and_then(|p| {
        let owner = p.get("owner").and_then(|o| o.get("login")).and_then(|s| s.as_str())?;
        let name = p.get("name").and_then(|s| s.as_str())?;
        Some(format!("{}/{}", owner, name))
    })
}

/// Resolve the current repo's `owner/repo` via `gh repo view`. Used as the
/// fallback for non-fork repos instead of the literal placeholder string
/// `"{owner}/{repo}"`: that string only "works" because `gh api` happens to
/// expand `{owner}`/`{repo}` templates from the cwd, which is fragile and
/// reads like unfinished code. Returns `None` on any failure.
fn gh_current_nwo(cwd: &str) -> Option<String> {
    let out = hidden_cmd("gh")
        .args(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"])
        .current_dir(cwd)
        .output()
        .ok()
        .filter(|o| o.status.success())?;
    let nwo = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if nwo.is_empty() { None } else { Some(nwo) }
}

/// Resolve whether the current viewer can merge this PR. A PR merges into its
/// **base** repository — which, for a fork, is the upstream repo and not the
/// fork the working copy points at. So permission must be checked against the
/// base repo (parsed from the PR url), not `cwd`'s origin: owning a fork grants
/// ADMIN on the fork but no merge rights on upstream.
///
/// `push` access on the base repo means the viewer can merge. Returns `None` on
/// any failure so the UI falls back to error-only gating.
fn gh_viewer_can_merge(cwd: &str, pr_url: &str) -> Option<bool> {
    let nwo = github_nwo_from_pr_url(pr_url)?;
    let output = hidden_cmd("gh")
        .args(["api", &format!("repos/{}", nwo), "--jq", ".permissions.push"])
        .current_dir(cwd)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    match String::from_utf8_lossy(&output.stdout).trim() {
        "true" => Some(true),
        "false" => Some(false),
        _ => None,
    }
}

/// Extract `owner/repo` from a GitHub PR url such as
/// `https://github.com/owner/repo/pull/123`.
fn github_nwo_from_pr_url(url: &str) -> Option<String> {
    let rest = url.split("github.com/").nth(1)?;
    let mut parts = rest.split('/');
    let owner = parts.next().filter(|s| !s.is_empty())?;
    let repo = parts.next().filter(|s| !s.is_empty())?;
    Some(format!("{}/{}", owner, repo))
}

fn gh_pr_diff_inner(cwd: String, number: i64) -> Result<String, String> {
    if let Some(tok) = github_api::settings_github_token() {
        return github_api::rest_pr_diff(&cwd, number, &tok);
    }
    let upstream = gh_fork_upstream(&cwd);
    let num = number.to_string();
    let mut cmd = hidden_cmd("gh");
    cmd.args(["pr", "diff", &num]);
    if let Some(ref nwo) = upstream {
        cmd.args(["--repo", nwo]);
    }
    let output = cmd
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("gh pr diff: {}", e))?;

    if !output.status.success() {
        return Err(format!("gh pr diff failed: {}", String::from_utf8_lossy(&output.stderr)));
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
    if let Some(tok) = github_api::settings_github_token() {
        return github_api::rest_pr_checks(&cwd, number, &tok);
    }
    // Resolve the canonical repo NWO (upstream for forks, own for regular repos).
    let nwo = gh_fork_upstream(&cwd)
        .or_else(|| gh_current_nwo(&cwd))
        .unwrap_or_else(|| "{owner}/{repo}".to_string());

    // Step 1 — head commit SHA for this PR.
    let pr_out = hidden_cmd("gh")
        .args(["api", &format!("repos/{}/pulls/{}", nwo, number), "--jq", ".head.sha"])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("gh api pr head sha: {}", e))?;
    if !pr_out.status.success() {
        return Ok(Vec::new()); // non-fatal: no checks surfaced
    }
    let sha = String::from_utf8_lossy(&pr_out.stdout)
        .trim()
        .trim_matches('"')
        .to_string();
    if sha.is_empty() || sha == "null" {
        return Ok(Vec::new());
    }

    // Step 2 — check-runs for that commit.
    let runs_out = hidden_cmd("gh")
        .args(["api", &format!("repos/{}/commits/{}/check-runs?per_page=100", nwo, sha)])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("gh api check-runs: {}", e))?;
    if !runs_out.status.success() {
        return Ok(Vec::new());
    }
    let v: serde_json::Value = match serde_json::from_slice(&runs_out.stdout) {
        Ok(v) => v,
        Err(_) => return Ok(Vec::new()),
    };
    let runs = v.get("check_runs").and_then(|r| r.as_array()).cloned().unwrap_or_default();
    let checks = runs.iter().map(|run| {
        let js = |k: &str| run.get(k).and_then(|s| s.as_str()).unwrap_or("").to_string();
        let status = js("status").to_uppercase();
        let conclusion = js("conclusion");
        CICheck {
            name: js("name"),
            state: if status == "COMPLETED" { conclusion.clone() } else { status },
            conclusion,
            details_url: js("html_url"),
        }
    }).collect();
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
    if let Some(tok) = github_api::settings_github_token() {
        return github_api::rest_pr_comments(&cwd, number, &tok);
    }
    let nwo = gh_fork_upstream(&cwd)
        .or_else(|| gh_current_nwo(&cwd))
        .unwrap_or_else(|| "{owner}/{repo}".to_string());
    let json = gh_api_json(
        &cwd,
        &format!("repos/{}/pulls/{}/comments?per_page=100", nwo, number),
    )?;
    Ok(github_api::map_comments(&json, false))
}

/// List inline review comments (anchored to diff lines) for a PR.
/// Token present → REST; otherwise `gh api`.
#[tauri::command]
pub(crate) async fn gh_pr_comments(cwd: String, number: i64) -> Result<Vec<serde_json::Value>, String> {
    tauri::async_runtime::spawn_blocking(move || gh_pr_comments_inner(cwd, number))
        .await
        .map_err(|e| e.to_string())?
}

fn gh_pr_issue_comments_inner(cwd: String, number: i64) -> Result<Vec<serde_json::Value>, String> {
    if let Some(tok) = github_api::settings_github_token() {
        return github_api::rest_pr_issue_comments(&cwd, number, &tok);
    }
    let nwo = gh_fork_upstream(&cwd)
        .or_else(|| gh_current_nwo(&cwd))
        .unwrap_or_else(|| "{owner}/{repo}".to_string());
    let json = gh_api_json(
        &cwd,
        &format!("repos/{}/issues/{}/comments?per_page=100", nwo, number),
    )?;
    Ok(github_api::map_comments(&json, true))
}

/// List issue-level (conversation) comments for a PR.
/// Token present → REST; otherwise `gh api`.
#[tauri::command]
pub(crate) async fn gh_pr_issue_comments(cwd: String, number: i64) -> Result<Vec<serde_json::Value>, String> {
    tauri::async_runtime::spawn_blocking(move || gh_pr_issue_comments_inner(cwd, number))
        .await
        .map_err(|e| e.to_string())?
}

fn gh_pr_reviews_inner(cwd: String, number: i64) -> Result<Vec<serde_json::Value>, String> {
    if let Some(tok) = github_api::settings_github_token() {
        return github_api::rest_pr_reviews(&cwd, number, &tok);
    }
    let nwo = gh_fork_upstream(&cwd)
        .or_else(|| gh_current_nwo(&cwd))
        .unwrap_or_else(|| "{owner}/{repo}".to_string());
    let json = gh_api_json(
        &cwd,
        &format!("repos/{}/pulls/{}/reviews?per_page=100", nwo, number),
    )?;
    Ok(github_api::map_reviews(&json))
}

/// List submitted reviews (Approve / Request changes / Comment verdicts) for a PR.
/// Token present → REST; otherwise `gh api`.
#[tauri::command]
pub(crate) async fn gh_pr_reviews(cwd: String, number: i64) -> Result<Vec<serde_json::Value>, String> {
    tauri::async_runtime::spawn_blocking(move || gh_pr_reviews_inner(cwd, number))
        .await
        .map_err(|e| e.to_string())?
}

/// Run `gh api <path>` in `cwd` and parse stdout as JSON. Shared by the
/// comment-list fallbacks when no token is configured.
fn gh_api_json(cwd: &str, path: &str) -> Result<serde_json::Value, String> {
    let output = hidden_cmd("gh")
        .args(["api", path])
        .current_dir(cwd)
        .output()
        .map_err(|e| format!("gh api: {}", e))?;
    if !output.status.success() {
        return Err(format!("gh api failed: {}", String::from_utf8_lossy(&output.stderr)));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        return Ok(serde_json::Value::Array(Vec::new()));
    }
    serde_json::from_str(trimmed).map_err(|e| format!("parse gh api response: {}", e))
}

/// Run a mutating `gh api` call (`POST`/`DELETE`) with optional `-f key=value` fields.
/// Returns the parsed JSON body, or `Null` for 204 No Content responses.
fn gh_api_write(cwd: &str, method: &str, path: &str, fields: &[(&str, &str)]) -> Result<serde_json::Value, String> {
    let mut cmd = hidden_cmd("gh");
    cmd.args(["api", "-X", method, path]);
    for (k, v) in fields {
        cmd.args(["-f", &format!("{}={}", k, v)]);
    }
    let output = cmd.current_dir(cwd).output().map_err(|e| format!("gh api write: {}", e))?;
    if !output.status.success() {
        return Err(format!("gh api {}: {}", method, String::from_utf8_lossy(&output.stderr)));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let trimmed = stdout.trim();
    if trimmed.is_empty() { return Ok(serde_json::Value::Null); }
    serde_json::from_str(trimmed).map_err(|e| format!("parse gh api write response: {}", e))
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
fn gh_auth_token() -> Option<String> {
    let out = hidden_cmd("gh").args(["auth", "token"]).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let tok = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if tok.is_empty() { None } else { Some(tok) }
}

/// Token for reaction calls: the GitWand token if configured, else (only for the
/// GraphQL-only `"review"` target) the gh CLI's own token. Other targets fall
/// back to the plain `gh api` path below when this returns `None`.
fn reaction_token(target_type: &str) -> Option<String> {
    github_api::settings_github_token().or_else(|| (target_type == "review").then(gh_auth_token).flatten())
}

fn gh_list_reactions_inner(cwd: String, number: i64, target_type: String, target_id: i64) -> Result<Vec<serde_json::Value>, String> {
    if let Some(tok) = reaction_token(&target_type) {
        return github_api::rest_list_reactions(&cwd, number, &target_type, target_id, &tok);
    }
    let nwo = gh_fork_upstream(&cwd).unwrap_or_else(|| "{owner}/{repo}".to_string());
    let path = reactions_api_path(&nwo, &target_type, target_id);
    let json = gh_api_json(&cwd, &path)?;
    Ok(json.as_array().map(|a| a.iter().map(|r| github_api::map_reaction(r)).collect()).unwrap_or_default())
}

/// List reactions on a PR or one of its comments.
/// `target_type`: `"pr"` | `"review_comment"` | `"issue_comment"`.
/// `target_id`: PR number for `"pr"`, comment id otherwise.
#[tauri::command]
pub(crate) async fn gh_list_reactions(cwd: String, number: i64, target_type: String, target_id: i64) -> Result<Vec<serde_json::Value>, String> {
    tauri::async_runtime::spawn_blocking(move || gh_list_reactions_inner(cwd, number, target_type, target_id))
        .await
        .map_err(|e| e.to_string())?
}

fn gh_add_reaction_inner(cwd: String, number: i64, target_type: String, target_id: i64, content: String) -> Result<serde_json::Value, String> {
    if let Some(tok) = reaction_token(&target_type) {
        return github_api::rest_add_reaction(&cwd, number, &target_type, target_id, &content, &tok);
    }
    let nwo = gh_fork_upstream(&cwd).unwrap_or_else(|| "{owner}/{repo}".to_string());
    let path = reactions_api_path(&nwo, &target_type, target_id);
    gh_api_write(&cwd, "POST", &path, &[("content", &content)])
}

/// Add a reaction to a PR or comment.
#[tauri::command]
pub(crate) async fn gh_add_reaction(cwd: String, number: i64, target_type: String, target_id: i64, content: String) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || gh_add_reaction_inner(cwd, number, target_type, target_id, content))
        .await
        .map_err(|e| e.to_string())?
}

fn gh_delete_reaction_inner(cwd: String, number: i64, target_type: String, target_id: i64, reaction_id: i64) -> Result<(), String> {
    if let Some(tok) = reaction_token(&target_type) {
        return github_api::rest_delete_reaction(&cwd, number, &target_type, target_id, reaction_id, &tok);
    }
    let nwo = gh_fork_upstream(&cwd).unwrap_or_else(|| "{owner}/{repo}".to_string());
    let path = format!("{}/{}", reactions_api_path(&nwo, &target_type, target_id), reaction_id);
    gh_api_write(&cwd, "DELETE", &path, &[])?;
    Ok(())
}

/// Delete a reaction from a PR or comment.
#[tauri::command]
pub(crate) async fn gh_delete_reaction(cwd: String, number: i64, target_type: String, target_id: i64, reaction_id: i64) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || gh_delete_reaction_inner(cwd, number, target_type, target_id, reaction_id))
        .await
        .map_err(|e| e.to_string())?
}

fn gh_fork_info_inner(cwd: String) -> Result<ForkInfo, String> {
    if let Some(tok) = github_api::settings_github_token() {
        return github_api::rest_fork_info(&cwd, &tok);
    }
    let output = hidden_cmd("gh")
        .args(["repo", "view", "--json", "isFork,parent,nameWithOwner"])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("gh repo view (fork info): {}", e))?;
    if !output.status.success() {
        return Err(format!(
            "gh repo view failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    let v: serde_json::Value =
        serde_json::from_slice(&output.stdout).map_err(|e| e.to_string())?;
    let origin = v.get("nameWithOwner").and_then(|s| s.as_str()).unwrap_or("").to_string();
    let is_fork = v.get("isFork").and_then(|b| b.as_bool()).unwrap_or(false);
    let parent = v
        .get("parent")
        .and_then(|p| {
            let owner = p.get("owner").and_then(|o| o.get("login")).and_then(|s| s.as_str())?;
            let name = p.get("name").and_then(|s| s.as_str())?;
            Some(format!("{}/{}", owner, name))
        })
        .unwrap_or_default();
    Ok(ForkInfo { is_fork, origin, parent })
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
///   2. `gh api repos/{owner}/{repo}/commits/{sha}/check-runs` → runs with
///      `output.annotations_count` (gh resolves `{owner}/{repo}` from cwd)
///   3. For each run with annotations: `gh api .../check-runs/{id}/annotations`
///
/// Non-fatal everywhere: a repo without checks/annotations returns `[]`.
#[tauri::command]
pub(crate) fn gh_check_annotations(cwd: String, number: i64) -> Result<Vec<CIAnnotation>, String> {
    // 1. Head SHA of the PR.
    let output = hidden_cmd("gh")
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
    let output = hidden_cmd("gh")
        .args([
            "api",
            &format!("repos/{{owner}}/{{repo}}/commits/{}/check-runs?per_page=100", sha),
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

        let output = hidden_cmd("gh")
            .args([
                "api",
                &format!("repos/{{owner}}/{{repo}}/check-runs/{}/annotations?per_page=100", run_id),
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
        let Some(items) = arr.as_array() else { continue };

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
    if let Some(tok) = github_api::settings_github_token() {
        let me = match filter.as_str() {
            "assigned" | "created" | "mentioned" => {
                github_api::rest_current_user(&tok).unwrap_or_default()
            }
            _ => String::new(),
        };
        return github_api::rest_list_issues(&cwd, &filter, &me, lim, &tok);
    }

    // Fallback: shell `gh issue list` (mirrors workspace_issues_all gh path).
    let mut cmd = hidden_cmd("gh");
    cmd.args([
        "issue", "list",
        "--state", "open",
        "--json", "number,title,state,author,assignees,labels,url,createdAt,updatedAt,milestone",
        "--limit", &lim.to_string(),
    ]);
    match filter.as_str() {
        "assigned" => { cmd.args(["--assignee", "@me"]); }
        "created" => { cmd.args(["--author", "@me"]); }
        "mentioned" => { cmd.args(["--search", "mentions:@me"]); }
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

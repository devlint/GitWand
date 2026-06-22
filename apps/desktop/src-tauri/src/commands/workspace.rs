//! Workspace Tauri commands (§3.4 migration).
//!
//! Two families:
//!   1. File I/O — `workspace_read` / `workspace_write` handle the
//!      `.gitwand-workspace.json` config descriptor (a named collection
//!      of repo paths).
//!   2. Aggregates — `workspace_*_all` walk every repo in parallel (rayon
//!      via P3.2) and call the libgit2 helpers in `crate::git::libgit2`
//!      (extracted in P3.3a) to produce status / WIP / PR / issue digests
//!      without spawning a single `git` subprocess in the read paths.
//!
//! See `src/git/libgit2.rs` for the per-repo helpers used here.

use crate::commands::github_api;
use crate::git::*;
use crate::types::*;
use rayon::prelude::*;

/// Read a `.gitwand-workspace.json` from the given directory.
#[tauri::command]
pub(crate) async fn workspace_read(path: String) -> Result<WorkspaceConfig, String> {
    let dir = std::path::Path::new(&path);
    let file = dir.join(".gitwand-workspace.json");
    if !file.exists() {
        return Err(format!("No workspace file found at {}", file.display()));
    }
    let content = std::fs::read_to_string(&file)
        .map_err(|e| format!("Failed to read workspace: {}", e))?;
    serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse workspace: {}", e))
}

/// Write a `.gitwand-workspace.json` to the given directory.
#[tauri::command]
pub(crate) async fn workspace_write(path: String, workspace: WorkspaceConfig) -> Result<(), String> {
    let dir = std::path::Path::new(&path);
    let file = dir.join(".gitwand-workspace.json");
    std::fs::create_dir_all(dir)
        .map_err(|e| format!("Failed to create directory: {}", e))?;
    let content = serde_json::to_string_pretty(&workspace)
        .map_err(|e| format!("Failed to serialize workspace: {}", e))?;
    std::fs::write(&file, content)
        .map_err(|e| format!("Failed to write workspace: {}", e))
}

/// Check whether `rel`, resolved under `cwd`, exists on disk.
///
/// Validates the path through `safe_repo_path()` (rejecting traversal /
/// escaping paths by returning `false` rather than erroring). Used by the
/// monorepo scope feature (v2.21.0) to validate a persisted scope still exists.
#[tauri::command]
pub(crate) async fn path_exists(cwd: String, rel: String) -> Result<bool, String> {
    match safe_repo_path(&cwd, &rel) {
        Ok(p) => Ok(p.exists()),
        // An escaping / invalid path simply doesn't count as existing.
        Err(_) => Ok(false),
    }
}

/// Get the status of all repos in a workspace (branch, ahead/behind, modified count).
///
/// Each repo runs through libgit2 (P3.3a) with rayon parallelism (P3.2).
/// Order is preserved by `into_par_iter().map(...).collect::<Vec<_>>()`
/// because `Vec<T>::into_par_iter()` is an `IndexedParallelIterator`.
#[tauri::command]
pub(crate) async fn workspace_status_all(repos: Vec<WorkspaceRepo>) -> Vec<WorkspaceRepoStatus> {
    repos.into_par_iter().map(|repo| {
        let path = repo.path.clone();
        let name = repo.name.clone();

        let (branch, ahead, behind, no_upstream) = libgit2_branch_ab(&path);
        let modified = libgit2_modified_count(&path);

        WorkspaceRepoStatus {
            path,
            name,
            branch,
            ahead,
            behind,
            has_upstream: !no_upstream,
            modified,
            conflicted: 0, // non calculé dans la vue workspace (libgit2 ne distingue pas les conflits ici)
            error: None,
        }
    }).collect()
}

/// Run `git fetch` on all repos in a workspace (best-effort; errors captured per-repo).
///
/// Network operations parallelized via rayon (P3.2): for a workspace with
/// N repos, total wall-clock is ~max(per-repo) instead of sum(per-repo).
#[tauri::command]
pub(crate) async fn workspace_fetch_all(repos: Vec<WorkspaceRepo>) -> Vec<WorkspaceRepoStatus> {
    repos.par_iter().for_each(|repo| {
        let _ = git_cmd()
            .args(["fetch", "--all", "--prune"])
            .current_dir(&repo.path)
            .output();
    });
    workspace_status_all(repos).await
}

/// Run `git pull --ff-only` on all repos (best-effort).
///
/// Parallelized via rayon (P3.2). Each repo's pull is independent — different
/// remotes, different working dirs — so concurrent execution is safe.
#[tauri::command]
pub(crate) async fn workspace_pull_all(repos: Vec<WorkspaceRepo>) -> Vec<WorkspaceRepoStatus> {
    repos.par_iter().for_each(|repo| {
        let _ = git_cmd()
            .args(["pull", "--ff-only"])
            .current_dir(&repo.path)
            .output();
    });
    workspace_status_all(repos).await
}

/// Get detailed WIP status for all repos in a workspace.
/// Returns staged/unstaged/untracked counts, last commit timestamp, and upstream presence.
///
/// P3.3: every git subprocess (4 per repo) replaced by libgit2 in-process calls.
/// Combined with rayon parallelization (P3.2), a 5-repo workspace listing
/// went from ~750 ms wall-clock to ~30 ms in the typical case.
#[tauri::command]
pub(crate) async fn workspace_wip_all(repos: Vec<WorkspaceRepo>) -> Vec<WorkspaceWipItem> {
    repos.into_par_iter().map(|repo| {
        let path = repo.path.clone();
        let name = repo.name.clone();

        let (branch, ahead, behind, has_no_upstream) = libgit2_branch_ab(&path);
        let (staged_count, unstaged_count, untracked_count, changed_files) =
            libgit2_wip_status(&path);
        let last_commit_at = libgit2_last_commit_at(&path);

        WorkspaceWipItem {
            path,
            name,
            branch,
            ahead,
            behind,
            staged_count,
            unstaged_count,
            untracked_count,
            last_commit_at,
            has_no_upstream,
            error: None,
            changed_files,
        }
    })
    .collect()
}

/// Aggregate open PRs from all repos in a workspace (via `gh pr list`).
/// Best-effort: gh failures per repo are captured in the `error` field.
///
/// Parallelized via rayon (P3.2). Each repo's `gh pr list` is independent.
/// Note: GitHub API rate-limits per token; in practice 5–20 concurrent calls
/// from a single user fit well within the 5000 req/h authenticated budget.
#[tauri::command]
pub(crate) async fn workspace_prs_all(repos: Vec<WorkspaceRepo>) -> Vec<WorkspaceRepoPrs> {
    // OAuth/REST path (#73): when a Settings-managed GitHub token exists, drive
    // the Launchpad through the REST API instead of spawning `gh` — so users who
    // signed in via Settings > Accounts (and have no `gh` binary installed) get a
    // working dashboard instead of "gh not available" on every row. Mirrors the
    // routing rule used by the sidebar `gh_*` commands (see `github_api`).
    let rest_token = github_api::settings_github_token();

    repos.into_par_iter().map(|repo| {
        let repo_path = repo.path.clone();
        let repo_name = repo.name.clone();

        if let Some(tok) = rest_token.as_deref() {
            // `rest_list_prs` returns the same enriched `Vec<PullRequest>` the
            // notification diff consumes (CI rollup + mergeable state). Per-repo
            // errors (non-GitHub remote, network) are captured, not fatal.
            return match github_api::rest_list_prs(&repo_path, "open", 10, 0, tok) {
                Ok(prs) => WorkspaceRepoPrs { repo_path, repo_name, prs, error: None },
                Err(e) => WorkspaceRepoPrs { repo_path, repo_name, prs: vec![], error: Some(e) },
            };
        }

        // GH_TOKEN propagation: centralized in `hidden_cmd` (cf. git/cmd.rs).
        // v2.16: the Launchpad notification diff (useLaunchpadNotifications)
        // needs CI / review / comment fields to detect flips, review requests
        // and new comments. We re-enrich the workspace PR list here — unlike
        // the sidebar `gh_list_prs` (kept light for boot perf), this path runs
        // on the background Launchpad poller (~60 s), so the extra cost is
        // acceptable. `statusCheckRollup`/`reviewDecision`/`reviewRequests`/
        // `comments` are exactly the diff inputs.
        let output = hidden_cmd("gh")
            .args([
                "pr", "list",
                "--state", "open",
                "--json", "number,title,state,author,headRefName,baseRefName,isDraft,createdAt,updatedAt,url,labels,assignees,reviewRequests,reviewDecision,mergeStateStatus,statusCheckRollup,comments",
                "--limit", "10",
            ])
            .current_dir(&repo_path)
            .output();

        match output {
            Err(e) => WorkspaceRepoPrs {
                repo_path,
                repo_name,
                prs: vec![],
                error: Some(format!("gh not available: {}", e)),
            },
            Ok(out) if !out.status.success() => {
                let stderr = String::from_utf8_lossy(&out.stderr);
                WorkspaceRepoPrs {
                    repo_path,
                    repo_name,
                    prs: vec![],
                    error: Some(format!("gh pr list failed: {}", stderr.trim())),
                }
            }
            Ok(out) => {
                let stdout = String::from_utf8_lossy(&out.stdout);
                match parse_gh_pr_json(&stdout) {
                    Ok(prs) => WorkspaceRepoPrs { repo_path, repo_name, prs, error: None },
                    Err(e) => WorkspaceRepoPrs {
                        repo_path,
                        repo_name,
                        prs: vec![],
                        error: Some(e),
                    },
                }
            }
        }
    })
    .collect()
}

/// Aggregate open GitHub Issues from all repos in a workspace (via `gh issue list`).
/// TypeScript wrapper: `workspaceIssuesAll` in `backend.ts`.
/// `filter` controls which issues are fetched:
///   ""          — all open issues (no additional flag)
///   "assigned"  — issues assigned to the authenticated user (--assignee @me)
///   "mentioned" — issues mentioning the user (--search mentions:@me)
///   "created"   — issues created by the user (--author @me)
/// Best-effort: gh failures per repo are captured in the `error` field.
///
/// Parallelized via rayon (P3.2). `filter` is captured by-ref and read-only
/// so it's safe to share across threads.
#[tauri::command]
pub(crate) async fn workspace_issues_all(repos: Vec<WorkspaceRepo>, filter: String) -> Vec<WorkspaceRepoIssues> {
    // OAuth/REST path (#73): same routing rule as `workspace_prs_all`. The
    // assigned/created/mentioned filters map `@me` to a concrete login, so we
    // resolve the authenticated user once (a single REST round-trip) and pass it
    // into every per-repo call rather than re-resolving N times.
    let rest_token = github_api::settings_github_token();
    if let Some(tok) = rest_token.as_deref() {
        let me = match filter.as_str() {
            "assigned" | "created" | "mentioned" => {
                github_api::rest_current_user(tok).unwrap_or_default()
            }
            _ => String::new(),
        };
        return repos.into_par_iter().map(|repo| {
            let repo_path = repo.path.clone();
            let repo_name = repo.name.clone();
            match github_api::rest_list_issues(&repo_path, &filter, &me, 100, tok) {
                Ok(issues) => WorkspaceRepoIssues {
                    repo_path, repo_name, issues, filter: filter.clone(), error: None,
                },
                Err(e) => WorkspaceRepoIssues {
                    repo_path, repo_name, issues: vec![], filter: filter.clone(), error: Some(e),
                },
            }
        }).collect();
    }

    repos.into_par_iter().map(|repo| {
        let repo_path = repo.path.clone();
        let repo_name = repo.name.clone();

        let mut args: Vec<String> = vec![
            "issue".to_string(), "list".to_string(),
            "--state".to_string(), "open".to_string(),
            "--json".to_string(),
            "number,title,state,author,assignees,labels,url,createdAt,updatedAt,milestone".to_string(),
            "--limit".to_string(), "100".to_string(),
        ];
        match filter.as_str() {
            "assigned" => {
                args.push("--assignee".to_string());
                args.push("@me".to_string());
            }
            "created" => {
                args.push("--author".to_string());
                args.push("@me".to_string());
            }
            "mentioned" => {
                args.push("--search".to_string());
                args.push("mentions:@me".to_string());
            }
            _ => {} // "" or unknown = no extra filter
        }

        let output = hidden_cmd("gh")
            .args(&args)
            .current_dir(&repo_path)
            .output();

        match output {
            Err(e) => WorkspaceRepoIssues {
                repo_path,
                repo_name,
                issues: vec![],
                filter: filter.clone(),
                error: Some(format!("gh not available: {}", e)),
            },
            Ok(out) if !out.status.success() => {
                let stderr = String::from_utf8_lossy(&out.stderr);
                WorkspaceRepoIssues {
                    repo_path,
                    repo_name,
                    issues: vec![],
                    filter: filter.clone(),
                    error: Some(format!("gh issue list failed: {}", stderr.trim())),
                }
            }
            Ok(out) => {
                let stdout = String::from_utf8_lossy(&out.stdout);
                match parse_gh_issue_json(&stdout) {
                    Ok(issues) => WorkspaceRepoIssues {
                        repo_path,
                        repo_name,
                        issues,
                        filter: filter.clone(),
                        error: None,
                    },
                    Err(e) => WorkspaceRepoIssues {
                        repo_path,
                        repo_name,
                        issues: vec![],
                        filter: filter.clone(),
                        error: Some(e),
                    },
                }
            }
        }
    })
    .collect()
}

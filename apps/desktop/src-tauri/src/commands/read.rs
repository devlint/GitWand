//! Git read-only Tauri commands (§3.4h migration).
//!
//! Ten Tauri commands grouped here because they share parsers, helpers and
//! all live on the read side of git (no working-tree mutation):
//!
//!   - `git_status` — porcelain v2 via libgit2 fast path + CLI fallback.
//!   - `git_diff` — per-file diff (working tree or staged).
//!   - `git_log` — commit list (with branch / author filter).
//!   - `git_repo_state` — rebase / merge / cherry-pick / revert detection.
//!   - `git_show` — multi-file diff for a single commit.
//!   - `git_file_log` / `git_file_log_pickaxe` / `git_file_log_range` —
//!     per-file history with --follow + pickaxe + -L line ranges.
//!   - `git_blame` — porcelain blame, capped at 10 000 entries.
//!   - `preview_merge` — Phase 8.1 dry-run merge using `git merge-file`.
//!   - `preview_rebase` / `preview_cherry_pick` — v2.20.0 Conflict Predictor
//!     extension: side-effect-free 3-way previews for rebase / cherry-pick,
//!     returning the same `FileMergePreview` shape as `preview_merge`.
//!
//! Private helpers kept alongside their only callers:
//!   - `git_status_libgit2` / `libgit2_branch_status` / `libgit2_file_statuses`
//!     / `compute_push_remote_via_cli` — feed `git_status`.
//!   - `git_status_cli` — parity reference, also fallback for `git_status`.
//!   - `merge_file_preview` — three-way merge driver for the preview commands.
//!   - `build_3way_preview` / `rev_parse_verify` — shared by the rebase /
//!     cherry-pick predictors.
//!
//! All helpers (git_cmd, git_binary, hidden_cmd, resolve_git_dir,
//! read_git_*, has_unresolved_conflicts, parse_diff_hunks,
//! parse_file_log_output, git_changed_files) live in `crate::git::*` and
//! are reached via the glob below.

use crate::git::*;
use crate::types::*;

// ─── Git status ───────────────────────────────────────────
//
// The user-facing Tauri command tries the libgit2 implementation first
// (avoids 1-3 git subprocess spawns per call — `git status` was the
// 2-second poll's hottest IPC). On any libgit2 error it falls back to
// the CLI parser, which remains the parity-test reference.
//
// Robustness: libgit2 occasionally chokes on edge-case repo layouts
// (partial clones, exotic submodule configs, malformed configs). The
// fallback ensures we never regress vs. the v2.8 baseline.

#[tauri::command]
pub(crate) async fn git_status(
    cwd: String,
    pathspec: Option<String>,
) -> Result<GitStatus, String> {
    // When a pathspec is provided, skip the libgit2 fast path and use the CLI
    // directly — libgit2's status API does not accept a pathspec filter the
    // same way `git status -- <path>` does.
    if let Some(ref p) = pathspec {
        let p = p.trim();
        if !p.is_empty() {
            return git_status_cli(cwd, Some(p.to_string()));
        }
    }
    // No pathspec: try libgit2 fast-path, fall back to CLI (parity reference).
    match git_status_libgit2(&cwd) {
        Ok(s) => Ok(s),
        Err(e) => {
            // Soft-fail: log but keep going. Don't surface libgit2 errors
            // to the UI when CLI works.
            eprintln!("[git_status] libgit2 fast path failed ({}); falling back to CLI", e);
            git_status_cli(cwd, None)
        }
    }
}

/// libgit2 implementation of git_status. Mirrors the GitStatus shape that
/// `git_status_cli` produces from `git status --porcelain=v2 --branch`.
///
/// What it covers in-process:
///   - Current branch (HEAD shorthand)
///   - Upstream tracking branch (`origin/main` etc.)
///   - Ahead/behind via `repo.graph_ahead_behind`
///   - Staged / unstaged / untracked / conflicted file lists with
///     rename detection enabled to match porcelain v2 behavior
///
/// What it delegates to git CLI:
///   - Push remote detection (`@{push}`) and ahead-of-push count.
///     This is a rare path (only fires when a triangular workflow is
///     configured) and `@{push}` syntax is git-CLI-only — libgit2 has
///     no direct equivalent. Calling git here for the few users with
///     triangular setups is acceptable; the common case is unaffected.
pub(crate) fn git_status_libgit2(cwd: &str) -> Result<GitStatus, String> {
    let repo = git2::Repository::open(cwd)
        .map_err(|e| format!("git2 open: {}", e))?;

    // ── Branch + upstream + ahead/behind ────────────────────────────────
    let (branch, ahead, behind, remote, remote_branch_exists) = libgit2_branch_status(&repo);

    // ── File status buckets ─────────────────────────────────────────────
    let (staged, unstaged, untracked, conflicted) = libgit2_file_statuses(&repo)?;

    // ── Push remote (triangular workflow) — CLI fallback ────────────────
    let (push_remote, ahead_push) =
        compute_push_remote_via_cli(cwd, remote.as_deref());

    let main_commit_count = compute_main_commit_count(cwd, &branch);

    Ok(GitStatus {
        branch,
        remote,
        remote_branch_exists,
        ahead,
        behind,
        main_commit_count,
        push_remote,
        ahead_push,
        staged,
        unstaged,
        untracked,
        conflicted,
    })
}

/// Branch shorthand + ahead/behind + upstream name (e.g. "origin/main") +
/// whether a matching remote-tracking branch exists.
///
/// Returns ("unknown", 0, 0, None, false) on any failure path so the caller
/// can still produce a valid GitStatus. The trailing bool is
/// `remote_branch_exists`: true whenever an upstream is configured, or — when
/// none is — a remote-tracking ref matching the branch name was found.
fn libgit2_branch_status(repo: &git2::Repository) -> (String, i32, i32, Option<String>, bool) {
    let head = match repo.head() {
        Ok(h) => h,
        Err(_) => return (String::from("unknown"), 0, 0, None, false),
    };
    let branch = head.shorthand().unwrap_or("").to_string();
    let local_oid = match head.target() {
        Some(o) => o,
        None => return (branch, 0, 0, None, false),
    };
    // Detached HEAD (or shorthand resolves to "HEAD") → no local branch object,
    // therefore no upstream. CLI returns the same in that case.
    let local_branch = match repo.find_branch(&branch, git2::BranchType::Local) {
        Ok(b) => b,
        Err(_) => return (branch, 0, 0, None, false),
    };
    let upstream = match local_branch.upstream() {
        Ok(u) => u,
        // No configured upstream. The branch may still live on a remote
        // (pushed without --set-upstream, `gh pr checkout`, fork checkout…).
        // Probe for a matching remote-tracking ref so the UI doesn't offer to
        // "publish" an already-published branch. `remote` stays None (no
        // `@{u}` — a first push still needs --set-upstream), but ahead/behind
        // are computed against the discovered ref and the bool flips to true.
        Err(_) => return detect_untracked_remote_branch(repo, &branch, local_oid),
    };
    // upstream.name() returns Result<Option<&str>>: None when the ref name
    // is non-UTF-8 (extremely rare). Keep ahead/behind=0 in that case.
    let upstream_name = upstream
        .name()
        .ok()
        .flatten()
        .map(|s| s.to_string());
    let upstream_oid = match upstream.get().target() {
        Some(o) => o,
        None => return (branch, 0, 0, upstream_name, true),
    };
    let (a, b) = match repo.graph_ahead_behind(local_oid, upstream_oid) {
        Ok(pair) => pair,
        Err(_) => return (branch, 0, 0, upstream_name, true),
    };
    (branch, a as i32, b as i32, upstream_name, true)
}

/// When no upstream is configured, look for a remote-tracking branch whose
/// short name is "<remote>/<branch>" (origin preferred). On a match, returns
/// ahead/behind against it with `remote_branch_exists = true`; `remote` is
/// kept None because there is no `@{u}` to push to yet. No match → all-zero
/// counts and false.
fn detect_untracked_remote_branch(
    repo: &git2::Repository,
    branch: &str,
    local_oid: git2::Oid,
) -> (String, i32, i32, Option<String>, bool) {
    if branch.is_empty() {
        return (branch.to_string(), 0, 0, None, false);
    }
    for candidate in remote_tracking_candidates(repo, branch) {
        if let Ok(rb) = repo.find_branch(&candidate, git2::BranchType::Remote) {
            if let Some(remote_oid) = rb.get().target() {
                let (a, b) = repo.graph_ahead_behind(local_oid, remote_oid).unwrap_or((0, 0));
                return (branch.to_string(), a as i32, b as i32, None, true);
            }
        }
    }
    (branch.to_string(), 0, 0, None, false)
}

/// Candidate remote-tracking short names for `branch`, origin first so the
/// canonical remote wins when several carry the same branch name.
fn remote_tracking_candidates(repo: &git2::Repository, branch: &str) -> Vec<String> {
    let mut candidates = vec![format!("origin/{}", branch)];
    if let Ok(remotes) = repo.remotes() {
        for name in remotes.iter().flatten() {
            if name == "origin" {
                continue;
            }
            candidates.push(format!("{}/{}", name, branch));
        }
    }
    candidates
}

/// Build (staged, unstaged, untracked, conflicted) from `repo.statuses()`.
/// Mirrors the porcelain v2 logic in `git_status_cli`: a single file with
/// both index and worktree changes appears in BOTH `staged` and `unstaged`.
fn libgit2_file_statuses(
    repo: &git2::Repository,
) -> Result<(Vec<FileChange>, Vec<FileChange>, Vec<String>, Vec<String>), String> {
    let mut opts = git2::StatusOptions::new();
    opts.include_untracked(true)
        .include_ignored(false)
        .renames_head_to_index(true)
        .renames_index_to_workdir(true)
        .renames_from_rewrites(true);

    let statuses = repo
        .statuses(Some(&mut opts))
        .map_err(|e| format!("git2 statuses: {}", e))?;

    let mut staged: Vec<FileChange> = Vec::new();
    let mut unstaged: Vec<FileChange> = Vec::new();
    let mut untracked: Vec<String> = Vec::new();
    let mut conflicted: Vec<String> = Vec::new();

    for entry in statuses.iter() {
        let s = entry.status();
        let path = entry.path().unwrap_or("").to_string();
        if path.is_empty() {
            continue;
        }

        // Conflicted is mutually exclusive with the other buckets in the CLI
        // output (porcelain v2 emits `u` lines that the CLI parser routes to
        // `conflicted`, never to staged/unstaged).
        if s.contains(git2::Status::CONFLICTED) {
            conflicted.push(path);
            continue;
        }

        if s.contains(git2::Status::WT_NEW) {
            // Untracked. CLI also uses a separate bucket here.
            untracked.push(path);
            continue;
        }

        // Index (staged) side — pick the most specific status, with the same
        // priority order the CLI parser applies:
        //   A > M > D > R > TypeChange (mapped to "modified")
        let staged_kind = if s.contains(git2::Status::INDEX_NEW) {
            Some("added")
        } else if s.contains(git2::Status::INDEX_MODIFIED) {
            Some("modified")
        } else if s.contains(git2::Status::INDEX_DELETED) {
            Some("deleted")
        } else if s.contains(git2::Status::INDEX_RENAMED) {
            Some("renamed")
        } else if s.contains(git2::Status::INDEX_TYPECHANGE) {
            Some("modified")
        } else {
            None
        };

        if let Some(kind) = staged_kind {
            let old_path = if kind == "renamed" {
                entry
                    .head_to_index()
                    .and_then(|d| d.old_file().path().map(|p| p.to_string_lossy().to_string()))
            } else {
                None
            };
            staged.push(FileChange {
                path: path.clone(),
                status: kind.to_string(),
                old_path,
            });
        }

        // Worktree (unstaged) side — same priority logic.
        let unstaged_kind = if s.contains(git2::Status::WT_MODIFIED) {
            Some("modified")
        } else if s.contains(git2::Status::WT_DELETED) {
            Some("deleted")
        } else if s.contains(git2::Status::WT_RENAMED) {
            Some("renamed")
        } else if s.contains(git2::Status::WT_TYPECHANGE) {
            Some("modified")
        } else {
            None
        };

        if let Some(kind) = unstaged_kind {
            let old_path = if kind == "renamed" {
                entry
                    .index_to_workdir()
                    .and_then(|d| d.old_file().path().map(|p| p.to_string_lossy().to_string()))
            } else {
                None
            };
            unstaged.push(FileChange {
                path,
                status: kind.to_string(),
                old_path,
            });
        }
    }

    Ok((staged, unstaged, untracked, conflicted))
}

/// Triangular-workflow detection — uses git CLI for `@{push}` resolution
/// since libgit2 has no first-class equivalent. Returns (push_remote_ref,
/// ahead_count) only when the push remote differs from the upstream;
/// otherwise (None, 0) so the UI shows a single ahead badge.
fn compute_push_remote_via_cli(cwd: &str, upstream: Option<&str>) -> (Option<String>, i32) {
    let push_out = git_cmd()
        .args(["rev-parse", "--abbrev-ref", "@{push}"])
        .current_dir(cwd)
        .output();
    let push_ref = match push_out {
        Ok(p) if p.status.success() => String::from_utf8_lossy(&p.stdout).trim().to_string(),
        _ => return (None, 0),
    };
    if push_ref.is_empty() || Some(push_ref.as_str()) == upstream {
        return (None, 0);
    }
    let count_out = git_cmd()
        .args(["rev-list", "--count", &format!("{}..HEAD", push_ref)])
        .current_dir(cwd)
        .output();
    let ahead_push = match count_out {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout)
            .trim()
            .parse()
            .unwrap_or(0),
        _ => 0,
    };
    (Some(push_ref), ahead_push)
}

/// CLI-backed implementation of `git_status`. Kept as the reference for the
/// parity tests (`tests/parity/git-status.test.mjs` compares Rust output
/// against the Node dev-server, both calling `git status --porcelain=v2`).
///
/// The user-facing Tauri command `git_status` (above) routes to the libgit2
/// implementation `git_status_libgit2` instead, with this CLI version as a
/// fallback on libgit2 errors.
pub(crate) fn git_status_cli(cwd: String, pathspec: Option<String>) -> Result<GitStatus, String> {
    let mut args: Vec<String> = vec![
        "status".to_string(),
        "--porcelain=v2".to_string(),
        "--branch".to_string(),
    ];
    if let Some(ref p) = pathspec {
        let p = p.trim();
        if !p.is_empty() {
            args.push("--".to_string());
            args.push(p.to_string());
        }
    }
    let output = git_cmd()
        .args(&args)
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to run git status: {}", e))?;

    if !output.status.success() {
        return Err("git status failed".to_string());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut branch = String::from("unknown");
    let mut remote: Option<String> = None;
    let mut ahead: i32 = 0;
    let mut behind: i32 = 0;
    let mut staged: Vec<FileChange> = Vec::new();
    let mut unstaged: Vec<FileChange> = Vec::new();
    let mut untracked: Vec<String> = Vec::new();
    let mut conflicted: Vec<String> = Vec::new();

    for line in stdout.lines() {
        if line.starts_with("# branch.head ") {
            branch = line.strip_prefix("# branch.head ").unwrap_or("unknown").to_string();
        } else if line.starts_with("# branch.ab ") {
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() >= 4 {
                ahead = parts[2].strip_prefix('+').unwrap_or("0").parse().unwrap_or(0);
                behind = parts[3].strip_prefix('-').unwrap_or("0").parse().unwrap_or(0);
            }
        } else if line.starts_with("# branch.oid ") {
            // track oid if needed
        } else if line.starts_with("# branch.upstream ") {
            remote = Some(line.strip_prefix("# branch.upstream ").unwrap_or("").to_string());
        } else if line.starts_with("u ") {
            // unmerged (conflicted) — porcelain v2 format:
            // u <xy> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
            // All fields separated by spaces (no tabs)
            let parts: Vec<&str> = line.splitn(11, ' ').collect();
            if parts.len() >= 11 {
                conflicted.push(parts[10].to_string());
            }
        } else if line.starts_with("1 ") {
            // ordinary changed entry — porcelain v2 format:
            // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
            // All fields separated by spaces (no tabs)
            let fields: Vec<&str> = line.splitn(9, ' ').collect();
            if fields.len() < 9 {
                continue;
            }
            let xy = fields[1];
            let path = fields[8].to_string();

            if xy.len() < 2 {
                continue;
            }

            let staged_char = xy.chars().next().unwrap();
            let unstaged_char = xy.chars().nth(1).unwrap();

            // Staged changes
            if staged_char != '.' {
                let status = match staged_char {
                    'A' => "added",
                    'M' => "modified",
                    'D' => "deleted",
                    'R' => "renamed",
                    _ => "modified",
                }
                .to_string();
                staged.push(FileChange {
                    path: path.clone(),
                    status,
                    old_path: None,
                });
            }

            // Unstaged changes
            if unstaged_char != '.' {
                let status = match unstaged_char {
                    'M' => "modified",
                    'D' => "deleted",
                    _ => "modified",
                }
                .to_string();
                unstaged.push(FileChange {
                    path,
                    status,
                    old_path: None,
                });
            }
        } else if line.starts_with("2 ") {
            // renamed/copied entry — porcelain v2 format:
            // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <Xscore> <path>\t<origPath>
            // Fields separated by spaces, but path and origPath separated by tab
            let tab_idx = line.find('\t');
            let meta_part = if let Some(idx) = tab_idx { &line[..idx] } else { line };
            let fields: Vec<&str> = meta_part.split_whitespace().collect();
            if fields.len() < 10 {
                continue;
            }
            let xy = fields[1];
            let path = fields[9].to_string();
            let old_path = tab_idx.map(|idx| line[idx + 1..].to_string());

            if xy.len() < 2 {
                continue;
            }

            let staged_char = xy.chars().next().unwrap();
            let unstaged_char = xy.chars().nth(1).unwrap();

            // Staged changes
            if staged_char != '.' {
                let status = match staged_char {
                    'A' => "added",
                    'M' => "modified",
                    'D' => "deleted",
                    'R' => "renamed",
                    _ => "modified",
                }
                .to_string();
                staged.push(FileChange {
                    path: path.clone(),
                    status,
                    old_path: old_path.clone(),
                });
            }

            // Unstaged changes
            if unstaged_char != '.' {
                let status = match unstaged_char {
                    'M' => "modified",
                    'D' => "deleted",
                    _ => "modified",
                }
                .to_string();
                unstaged.push(FileChange {
                    path,
                    status,
                    old_path,
                });
            }
        } else if line.starts_with("? ") {
            // untracked
            let path = line.strip_prefix("? ").unwrap_or("").to_string();
            if !path.is_empty() {
                untracked.push(path);
            }
        }
    }

    // If upstream exists but ahead/behind are 0, try rev-list as fallback
    if remote.is_some() && ahead == 0 && behind == 0 {
        if let Ok(rev_output) = git_cmd()
            .args(["rev-list", "--left-right", "--count", "HEAD...@{upstream}"])
            .current_dir(&cwd)
            .output()
        {
            if rev_output.status.success() {
                let rev_str = String::from_utf8_lossy(&rev_output.stdout);
                let nums: Vec<i32> = rev_str
                    .trim()
                    .split_whitespace()
                    .filter_map(|s| s.parse().ok())
                    .collect();
                if nums.len() >= 2 {
                    ahead = nums[0];
                    behind = nums[1];
                }
            }
        }
    }

    // ── Remote branch existence (no upstream configured) ─────────────────────
    // Mirror the libgit2 path: when there is no `@{u}`, the branch may still be
    // on a remote. Detect a matching remote-tracking ref and compute ahead/
    // behind against it so the UI doesn't offer to "publish" an already-pushed
    // branch. `remote` stays None — a first push still needs --set-upstream.
    let mut remote_branch_exists = remote.is_some();
    if remote.is_none() && !branch.is_empty() && branch != "unknown" {
        if let Some(remote_ref) = find_untracked_remote_ref_cli(&cwd, &branch) {
            remote_branch_exists = true;
            if let Ok(rl) = git_cmd()
                .args([
                    "rev-list",
                    "--left-right",
                    "--count",
                    &format!("{}...HEAD", remote_ref),
                ])
                .current_dir(&cwd)
                .output()
            {
                if rl.status.success() {
                    let nums: Vec<i32> = String::from_utf8_lossy(&rl.stdout)
                        .trim()
                        .split_whitespace()
                        .filter_map(|s| s.parse().ok())
                        .collect();
                    if nums.len() >= 2 {
                        // left = commits on the remote ref not in HEAD (behind),
                        // right = commits on HEAD not on the remote ref (ahead).
                        behind = nums[0];
                        ahead = nums[1];
                    }
                }
            }
        }
    }

    // ── Triangular / fork workflow ───────────────────────────────────────────
    // When push.default = "upstream" or a fork is set up, the push remote may
    // differ from the upstream (fetch) remote. Detect this and compute a
    // separate ahead count so the UI can show two distinct badges.
    let mut push_remote: Option<String> = None;
    let mut ahead_push: i32 = 0;

    let push_ref_out = git_cmd()
        .args(["rev-parse", "--abbrev-ref", "@{push}"])
        .current_dir(&cwd)
        .output();

    if let Ok(p) = push_ref_out {
        if p.status.success() {
            let push_ref = String::from_utf8_lossy(&p.stdout).trim().to_string();
            let upstream_ref = remote.as_deref().unwrap_or("");
            // Only proceed if push remote is set AND differs from upstream
            if !push_ref.is_empty() && push_ref != upstream_ref {
                // ahead of push remote (how many commits would be pushed)
                let rl = git_cmd()
                    .args(["rev-list", "--count", &format!("{}..HEAD", push_ref)])
                    .current_dir(&cwd)
                    .output();
                if let Ok(o) = rl {
                    if o.status.success() {
                        ahead_push = String::from_utf8_lossy(&o.stdout)
                            .trim().parse().unwrap_or(0);
                    }
                }
                push_remote = Some(push_ref);
            }
        }
    }

    let main_commit_count = compute_main_commit_count(&cwd, &branch);

    Ok(GitStatus {
        branch,
        remote,
        remote_branch_exists,
        ahead,
        behind,
        main_commit_count,
        push_remote,
        ahead_push,
        staged,
        unstaged,
        untracked,
        conflicted,
    })
}

/// Find a remote-tracking ref "<remote>/<branch>" (origin preferred) when no
/// upstream is configured. Returns the short ref name (e.g.
/// "origin/feature") or None. Uses exact `rev-parse --verify` lookups so a
/// branch named "x" never matches an unrelated "remote/foo/x".
fn find_untracked_remote_ref_cli(cwd: &str, branch: &str) -> Option<String> {
    let remotes_out = git_cmd()
        .args(["remote"])
        .current_dir(cwd)
        .output()
        .ok()?;
    if !remotes_out.status.success() {
        return None;
    }
    let remotes_raw = String::from_utf8_lossy(&remotes_out.stdout);
    let names: Vec<String> = remotes_raw
        .lines()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();

    // origin first, then the rest in declared order.
    let ordered = std::iter::once("origin")
        .filter(|o| names.iter().any(|n| n == o))
        .map(|s| s.to_string())
        .chain(names.iter().filter(|n| *n != "origin").cloned());

    for remote_name in ordered {
        let candidate = format!("{}/{}", remote_name, branch);
        if let Ok(o) = git_cmd()
            .args([
                "rev-parse",
                "--verify",
                "--quiet",
                &format!("refs/remotes/{}", candidate),
            ])
            .current_dir(cwd)
            .output()
        {
            if o.status.success() {
                return Some(candidate);
            }
        }
    }
    None
}

/// Helper to compute the number of commits the *remote-tracking* branch
/// (origin/branch) is ahead of the "main" branch. Used to disable
/// merge/rebase actions when the branch is fresh/empty (v2.15).
///
/// Checks in order: main, master, origin/main, origin/master.
fn compute_main_commit_count(cwd: &str, branch: &str) -> i32 {
    let remote_ref = format!("origin/{}", branch);
    for base in ["main", "master", "origin/main", "origin/master"] {
        if let Ok(output) = git_cmd()
            .args(["rev-list", "--count", &format!("{}..{}", base, remote_ref)])
            .current_dir(cwd)
            .output()
        {
            if output.status.success() {
                let s = String::from_utf8_lossy(&output.stdout);
                if let Ok(count) = s.trim().parse::<i32>() {
                    return count;
                }
            }
        }
    }
    // Default to 1 so we don't accidentally disable actions if we can't
    // find a base branch to compare against, or if the remote branch doesn't exist yet.
    1
}

// ─── Git diff ────────────────────────────────────────────────

#[tauri::command]
pub(crate) async fn git_diff(cwd: String, path: String, staged: bool) -> Result<GitDiff, String> {
    let mut cmd = git_cmd();
    if staged {
        cmd.arg("diff").arg("--cached");
    } else {
        cmd.arg("diff");
    }
    cmd.arg("--").arg(&path).current_dir(&cwd);

    let output = cmd
        .output()
        .map_err(|e| format!("Failed to run git diff: {}", e))?;

    // Defensive truncation. We slice at the last newline within the cap so
    // we never split a hunk header mid-line.
    let original_size = output.stdout.len();
    let truncated_from_bytes: Option<u64> = if original_size > DIFF_TRUNCATE_BYTES {
        Some(original_size as u64)
    } else {
        None
    };
    let stdout_slice: &[u8] = if truncated_from_bytes.is_some() {
        let mut cut = DIFF_TRUNCATE_BYTES;
        // Walk back to the last \n so the parser sees complete lines.
        while cut > 0 && output.stdout[cut - 1] != b'\n' {
            cut -= 1;
        }
        &output.stdout[..cut]
    } else {
        &output.stdout
    };
    let stdout = String::from_utf8_lossy(stdout_slice);
    let (mut hunks, mut status) = parse_diff_hunks(&stdout);

    // Untracked (not-yet-staged) files produce no output from `git diff`.
    // Fall back to `git diff --no-index -- /dev/null <path>` which generates
    // a proper "new file" diff with every line shown as an addition.
    // Note: --no-index always exits with code 1 when files differ, so we
    // ignore the exit status and only look at stdout.
    //
    // Guard: only fall back for genuinely UNTRACKED files. A tracked file
    // whose change is already staged also yields an empty unstaged `git diff`;
    // without this check the --no-index fallback would render the entire file
    // as an addition (all green) instead of showing no unstaged change.
    let is_untracked = !staged
        && hunks.is_empty()
        && truncated_from_bytes.is_none()
        && !git_cmd()
            .args(["ls-files", "--error-unmatch", "--", &path])
            .current_dir(&cwd)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);

    if is_untracked {
        if let Ok(fb) = git_cmd()
            .args(["diff", "--no-index", "--", "/dev/null", &path])
            .current_dir(&cwd)
            .output()
        {
            let fb_stdout = String::from_utf8_lossy(&fb.stdout);
            let (fb_hunks, fb_status) = parse_diff_hunks(&fb_stdout);
            if !fb_hunks.is_empty() {
                hunks = fb_hunks;
                status = fb_status.or(Some("added".to_string()));
            }
        }
    }

    Ok(GitDiff {
        path,
        hunks,
        status,
        old_path: None,
        truncated_from_bytes,
    })
}

// ─── Git log ─────────────────────────────────────────────────

#[tauri::command]
pub(crate) async fn git_log(
    cwd: String,
    count: Option<i32>,
    all: Option<bool>,
    author: Option<String>,
    offset: Option<i32>,
    branch: Option<String>,
    pathspec: Option<String>,
) -> Result<Vec<GitLogEntry>, String> {
    let limit = count.unwrap_or(100);
    let skip  = offset.unwrap_or(0).max(0);
    // Default: current branch only (like `git log`). Pass `all: true` to include all refs.
    let include_all = all.unwrap_or(false);

    // Use unit separator (ASCII 0x1f) to delimit fields
    let format = "%h%x1f%H%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%b%x1f%P%x1f%D%x1e";

    let mut args: Vec<String> = vec!["log".to_string()];
    if include_all {
        args.push("--all".to_string());
    }
    if let Some(ref author_filter) = author {
        if !author_filter.is_empty() {
            args.push(format!("--author={}", author_filter));
        }
    }
    if skip > 0 {
        args.push(format!("--skip={}", skip));
    }
    args.push(format!("-n{}", limit));
    if let Some(ref b) = branch {
        if !b.is_empty() {
            args.push(b.clone());
        }
    }
    args.push(format!("--format={}", format));

    // stash@{1+} are only in the reflog, not reachable via --all alone.
    // Add every stash commit hash as an extra starting point so all stashes appear.
    if include_all {
        if let Ok(stash_out) = git_cmd()
            .args(["stash", "list", "--format=%H"])
            .current_dir(&cwd)
            .output()
        {
            for hash in String::from_utf8_lossy(&stash_out.stdout).lines() {
                let hash = hash.trim();
                if !hash.is_empty() {
                    args.push(hash.to_string());
                }
            }
        }
    }

    // Pathspec: append `-- <path>` as discrete args (no string interpolation).
    if let Some(ref p) = pathspec {
        let p = p.trim();
        if !p.is_empty() {
            args.push("--".to_string());
            args.push(p.to_string());
        }
    }

    let output = git_cmd()
        .args(&args)
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to run git log: {}", e))?;

    if !output.status.success() {
        return Err("git log failed".to_string());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut entries: Vec<GitLogEntry> = Vec::new();

    // Split by record separator (0x1e)
    for record in stdout.split('\x1e') {
        let record = record.trim();
        if record.is_empty() {
            continue;
        }

        let fields: Vec<&str> = record.split('\x1f').collect();
        if fields.len() < 9 {
            continue;
        }

        let parents: Vec<String> = fields[7]
            .trim()
            .split_whitespace()
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .collect();

        entries.push(GitLogEntry {
            hash: fields[0].to_string(),
            hash_full: fields[1].to_string(),
            author: fields[2].to_string(),
            email: fields[3].to_string(),
            date: fields[4].to_string(),
            message: fields[5].to_string(),
            body: fields[6].trim().to_string(),
            parents,
            refs: fields[8].trim().to_string(),
        });
    }

    entries.retain(|e| !e.message.starts_with("index on ") && !e.message.starts_with("untracked files on "));

    Ok(entries)
}

// ─── Git rev count ───────────────────────────────────────────

/// Count reachable commits, mirroring git_log's ref selection.
///
/// - `all: Some(true)` → `--all`
/// - `branch: Some(b)` → specific branch ref; otherwise HEAD
/// - `pathspec: Some(p)` → limit to commits touching that sub-tree via `-- <p>`
///
/// Returns the commit count as a `usize`. Stash commits are excluded (they are
/// unreachable from normal refs / --all without explicit reflog traversal).
#[tauri::command]
pub(crate) async fn git_rev_count(
    cwd: String,
    branch: Option<String>,
    all: Option<bool>,
    pathspec: Option<String>,
) -> Result<usize, String> {
    let include_all = all.unwrap_or(false);

    let mut args: Vec<String> = vec![
        "rev-list".to_string(),
        "--count".to_string(),
    ];

    if include_all {
        args.push("--all".to_string());
    } else if let Some(ref b) = branch {
        if !b.is_empty() {
            args.push(b.clone());
        } else {
            args.push("HEAD".to_string());
        }
    } else {
        args.push("HEAD".to_string());
    }

    // Pathspec: discrete args, never interpolated
    if let Some(ref p) = pathspec {
        let p = p.trim();
        if !p.is_empty() {
            args.push("--".to_string());
            args.push(p.to_string());
        }
    }

    let output = git_cmd()
        .args(&args)
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to run git rev-list --count: {}", e))?;

    if !output.status.success() {
        // On an empty repo git rev-list HEAD fails; treat as 0
        return Ok(0);
    }

    let count_str = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let count: usize = count_str.parse().unwrap_or(0);
    Ok(count)
}

// ─── Git repo state (rebase / merge in progress) ─────────────

/// Returns the current operation state of the repository by inspecting the
/// .git directory directly — more reliable than parsing locale-dependent
/// `git status` messages.
#[tauri::command]
pub(crate) async fn git_repo_state(cwd: String) -> Result<RepoOperationState, String> {
    let git_dir = resolve_git_dir(&cwd)?;

    // ── Plain or interactive rebase (git >= 2.26: rebase-merge dir) ───────
    let rebase_merge = git_dir.join("rebase-merge");
    if rebase_merge.exists() {
        let is_interactive = rebase_merge.join("interactive").exists();
        let step  = read_git_u32(&rebase_merge.join("msgnum"));
        let total = read_git_u32(&rebase_merge.join("end"));
        let head  = read_git_file(&git_dir.join("REBASE_HEAD"));
        let branch = read_git_file(&rebase_merge.join("head-name"))
            .map(|s| s.trim_start_matches("refs/heads/").to_string());
        return Ok(RepoOperationState {
            state: if is_interactive { "rebase_interactive".into() } else { "rebase".into() },
            has_conflict: has_unresolved_conflicts(&cwd),
            operation_head: head,
            target_branch: branch,
            step,
            total,
        });
    }

    // ── Old-style rebase-apply (git am / old --apply) ─────────────────────
    let rebase_apply = git_dir.join("rebase-apply");
    if rebase_apply.exists() {
        let step  = read_git_u32(&rebase_apply.join("next"));
        let total = read_git_u32(&rebase_apply.join("last"));
        let head  = read_git_file(&git_dir.join("REBASE_HEAD"));
        let branch = read_git_file(&rebase_apply.join("head-name"))
            .map(|s| s.trim_start_matches("refs/heads/").to_string());
        return Ok(RepoOperationState {
            state: "rebase".into(),
            has_conflict: has_unresolved_conflicts(&cwd),
            operation_head: head,
            target_branch: branch,
            step,
            total,
        });
    }

    // ── Merge in progress ─────────────────────────────────────────────────
    let merge_head = git_dir.join("MERGE_HEAD");
    if merge_head.exists() {
        return Ok(RepoOperationState {
            state: "merge".into(),
            has_conflict: has_unresolved_conflicts(&cwd),
            operation_head: read_git_file(&merge_head),
            target_branch: None,
            step: 0,
            total: 0,
        });
    }

    // ── Cherry-pick in progress ───────────────────────────────────────────
    let cherry_head = git_dir.join("CHERRY_PICK_HEAD");
    if cherry_head.exists() {
        return Ok(RepoOperationState {
            state: "cherry_pick".into(),
            has_conflict: has_unresolved_conflicts(&cwd),
            operation_head: read_git_file(&cherry_head),
            target_branch: None,
            step: 0,
            total: 0,
        });
    }

    // ── Revert in progress ────────────────────────────────────────────────
    let revert_head = git_dir.join("REVERT_HEAD");
    if revert_head.exists() {
        return Ok(RepoOperationState {
            state: "revert".into(),
            has_conflict: has_unresolved_conflicts(&cwd),
            operation_head: read_git_file(&revert_head),
            target_branch: None,
            step: 0,
            total: 0,
        });
    }

    // ── Clean ─────────────────────────────────────────────────────────────
    Ok(RepoOperationState {
        state: "clean".into(),
        has_conflict: false,
        operation_head: None,
        target_branch: None,
        step: 0,
        total: 0,
    })
}

// ─── Git show (commit diff) ──────────────────────────────────

#[tauri::command]
pub(crate) async fn git_show(cwd: String, hash: String) -> Result<Vec<GitDiff>, String> {
    let output = git_cmd()
        .args(["show", "-m", "--first-parent", "--format=", &hash])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to run git show: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut diffs: Vec<GitDiff> = Vec::new();
    let mut current_path: Option<String> = None;
    let mut current_hunk: Option<DiffHunk> = None;
    let mut old_line_no = 0;
    let mut new_line_no = 0;
    let mut current_hunks: Vec<DiffHunk> = Vec::new();
    // Extended-header state tracked per file, captured before any @@ hunk and
    // flushed alongside the file's hunks when the next `diff --git` appears.
    let mut current_status: Option<String> = None;
    let mut current_old_path: Option<String> = None;

    for line in stdout.lines() {
        if line.starts_with("diff --git ") {
            // Save previous file diff
            if let Some(hunk) = current_hunk.take() {
                current_hunks.push(hunk);
            }
            if let Some(path) = current_path.take() {
                diffs.push(GitDiff {
                    path,
                    hunks: std::mem::take(&mut current_hunks),
                    status: current_status.take(),
                    old_path: current_old_path.take(),
                    // P2.4 — multi-file commit diff parsing has no per-file
                    // cap (the caller is `git_show`/`git_log_with_diff`,
                    // not the polled `git_diff` that `pollStatus` re-fires).
                    // Truncation is only meaningful for the per-file diff
                    // command. Set None unconditionally here.
                    truncated_from_bytes: None,
                });
            }
            current_status = None;
            current_old_path = None;

            // Extract file path from "diff --git a/path b/path"
            let parts: Vec<&str> = line.split(" b/").collect();
            if parts.len() >= 2 {
                current_path = Some(parts[1].to_string());
            }
        } else if line.starts_with("new file mode") {
            current_status = Some("added".to_string());
        } else if line.starts_with("deleted file mode") {
            current_status = Some("deleted".to_string());
        } else if let Some(rest) = line.strip_prefix("rename from ") {
            current_status = Some("renamed".to_string());
            current_old_path = Some(rest.to_string());
        } else if line.starts_with("rename to ") {
            if current_status.is_none() {
                current_status = Some("renamed".to_string());
            }
        } else if line.starts_with("@@") {
            if let Some(hunk) = current_hunk.take() {
                current_hunks.push(hunk);
            }

            let header = line.to_string();
            let parts: Vec<&str> = line.split_whitespace().collect();
            let mut old_start = 0;
            let mut old_count = 1;
            let mut new_start = 0;
            let mut new_count = 1;

            if parts.len() >= 3 {
                let old_range = parts[1].strip_prefix('-').unwrap_or("0");
                let new_range = parts[2].strip_prefix('+').unwrap_or("0");

                if let Some(comma_idx) = old_range.find(',') {
                    old_start = old_range[..comma_idx].parse().unwrap_or(0);
                    old_count = old_range[comma_idx + 1..].parse().unwrap_or(1);
                } else {
                    old_start = old_range.parse().unwrap_or(0);
                }

                if let Some(comma_idx) = new_range.find(',') {
                    new_start = new_range[..comma_idx].parse().unwrap_or(0);
                    new_count = new_range[comma_idx + 1..].parse().unwrap_or(1);
                } else {
                    new_start = new_range.parse().unwrap_or(0);
                }
            }

            old_line_no = old_start;
            new_line_no = new_start;

            current_hunk = Some(DiffHunk {
                header,
                old_start,
                old_count,
                new_start,
                new_count,
                lines: Vec::new(),
            });
        } else if let Some(ref mut hunk) = current_hunk {
            if line.starts_with('+') && !line.starts_with("+++") {
                hunk.lines.push(DiffLine {
                    r#type: "add".to_string(),
                    content: line[1..].to_string(),
                    old_line_no: None,
                    new_line_no: Some(new_line_no),
                });
                new_line_no += 1;
            } else if line.starts_with('-') && !line.starts_with("---") {
                hunk.lines.push(DiffLine {
                    r#type: "delete".to_string(),
                    content: line[1..].to_string(),
                    old_line_no: Some(old_line_no),
                    new_line_no: None,
                });
                old_line_no += 1;
            } else if line.starts_with(' ') {
                // Only accept lines that start with a literal space as context.
                // Empty strings (from split on blank separator lines or trailing
                // EOF newline) must NOT be classified as context — doing so adds
                // a phantom zero-length context line to the hunk, which makes
                // `git apply` reject the patch with "depends on old contents"
                // for new-file hunks (header becomes `-0,1` instead of `-0,0`).
                hunk.lines.push(DiffLine {
                    r#type: "context".to_string(),
                    content: line[1..].to_string(),
                    old_line_no: Some(old_line_no),
                    new_line_no: Some(new_line_no),
                });
                old_line_no += 1;
                new_line_no += 1;
            }
        }
    }

    // Save last file diff
    if let Some(hunk) = current_hunk.take() {
        current_hunks.push(hunk);
    }
    if let Some(path) = current_path.take() {
        diffs.push(GitDiff {
            path,
            hunks: current_hunks,
            status: current_status.take(),
            old_path: current_old_path.take(),
            truncated_from_bytes: None, // see P2.4 note above
        });
    }

    Ok(diffs)
}

// ─── File log (v1.9) — pickaxe + line-range ──────────────

#[tauri::command]
pub(crate) async fn git_file_log(cwd: String, path: String, count: Option<u32>) -> Result<Vec<FileLogEntry>, String> {
    let n = count.unwrap_or(50).to_string();
    let fmt = "%H\n%h\n%an\n%aI\n%s\n%b\n---END---";
    let output = git_cmd()
        .args(["log", "--follow", "-n", &n, &format!("--format={}", fmt), "--", &path])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("git log failed: {}", e))?;
    if !output.status.success() {
        return Err(format!("git log failed: {}", String::from_utf8_lossy(&output.stderr)));
    }
    Ok(parse_file_log_output(&String::from_utf8_lossy(&output.stdout)))
}

/// Pickaxe: find commits that added or removed `search` string.
/// mode: "S" (literal string) | "G" (regex)
#[tauri::command]
pub(crate) async fn git_file_log_pickaxe(cwd: String, path: String, search: String, mode: String) -> Result<Vec<FileLogEntry>, String> {
    let flag = if mode == "G" { "-G" } else { "-S" };
    let fmt = "%H\n%h\n%an\n%aI\n%s\n%b\n---END---";
    let output = git_cmd()
        .args(["log", "--follow", flag, &search, &format!("--format={}", fmt), "--", &path])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("git log pickaxe failed: {}", e))?;
    if !output.status.success() {
        return Err(format!("git log pickaxe failed: {}", String::from_utf8_lossy(&output.stderr)));
    }
    Ok(parse_file_log_output(&String::from_utf8_lossy(&output.stdout)))
}

/// Line-range history: commits that touched lines [start..end] in path.
/// Uses git log -L <start>,<end>:<path> (no --follow; incompatible with -L).
#[tauri::command]
pub(crate) async fn git_file_log_range(cwd: String, path: String, start_line: u32, end_line: u32) -> Result<Vec<FileLogEntry>, String> {
    let range = format!("{},{}:{}", start_line, end_line, path);
    let fmt = "%H\n%h\n%an\n%aI\n%s\n%b\n---END---";
    let output = git_cmd()
        .args(["log", "-L", &range, &format!("--format={}", fmt)])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("git log -L failed: {}", e))?;
    if !output.status.success() {
        return Err(format!("git log -L failed: {}", String::from_utf8_lossy(&output.stderr)));
    }
    Ok(parse_file_log_output(&String::from_utf8_lossy(&output.stdout)))
}

/// Run `git blame --porcelain` on a file.
/// algorithm: "histogram" | "patience" | "minimal" | "myers" (default "histogram").
#[tauri::command]
pub(crate) async fn git_blame(cwd: String, path: String, algorithm: Option<String>) -> Result<Vec<BlameLine>, String> {
    let algo = algorithm.as_deref().unwrap_or("histogram");
    let diff_algo_flag = format!("--diff-algorithm={}", algo);
    let output = git_cmd()
        .args(["blame", "--porcelain", &diff_algo_flag, "--", &path])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to run git blame: {}", e))?;
    if !output.status.success() {
        return Err(format!("git blame failed: {}", String::from_utf8_lossy(&output.stderr)));
    }
    let raw = String::from_utf8_lossy(&output.stdout);
    let lines: Vec<&str> = raw.lines().collect();
    let mut blame_lines: Vec<BlameLine> = Vec::new();
    // Limit to 10 000 blame entries to cap memory & runtime on huge files.
    const BLAME_MAX_ENTRIES: usize = 10_000;
    let mut i = 0;
    while i < lines.len() && blame_lines.len() < BLAME_MAX_ENTRIES {
        // Header: <40-char-sha> <orig-line> <final-line> [<num-lines-in-group>]
        let parts: Vec<&str> = lines[i].split_whitespace().collect();
        if parts.len() < 3 || parts[0].len() != 40 {
            i += 1;
            continue;
        }
        let hash_full = parts[0].to_string();
        let hash = hash_full[..7].to_string();
        let orig_line: u32 = parts[1].parse().unwrap_or(0);
        let final_line: u32 = parts[2].parse().unwrap_or(0);
        i += 1;
        let mut author = String::new();
        let mut author_date = String::new();
        let mut summary = String::new();
        let mut content = String::new();
        while i < lines.len() && !lines[i].starts_with('\t') {
            if lines[i].starts_with("author ") {
                author = lines[i][7..].to_string();
            } else if lines[i].starts_with("author-time ") {
                author_date = lines[i][12..].to_string();
            } else if lines[i].starts_with("summary ") {
                summary = lines[i][8..].to_string();
            }
            i += 1;
        }
        if i < lines.len() && lines[i].starts_with('\t') {
            content = lines[i][1..].to_string();
            i += 1;
        }
        blame_lines.push(BlameLine { hash, hash_full, final_line, orig_line, author, author_date, summary, content });
    }
    Ok(blame_lines)
}

// ─── Merge Preview (Phase 8.1) ───────────────────────────
//
// Calcule un aperçu "sans effet de bord" de ce qui se passerait
// si on mergait `source_branch` dans HEAD.
//
// Algorithme :
//   1. git merge-base HEAD <branch>  → ancêtre commun
//   2. git diff --name-only <base> HEAD   → fichiers modifiés côté ours
//   3. git diff --name-only <base> <branch> → fichiers modifiés côté theirs
//   4. intersection → fichiers potentiellement en conflit
//   5. Pour chaque fichier : git show <ref>:<file> pour les 3 versions
//   6. git merge-file -p (dans un répertoire temp) → contenu avec marqueurs
//   7. Retourner la liste brute — le résolveur tourne côté frontend (TypeScript)

#[tauri::command]
pub(crate) async fn preview_merge(cwd: String, source_branch: String) -> Result<Vec<FileMergePreview>, String> {
    let git = git_binary();

    // 1. Merge-base
    let base_out = hidden_cmd(&git)
        .args(["merge-base", "HEAD", &source_branch])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("merge-base failed: {}", e))?;
    if !base_out.status.success() {
        return Err(format!(
            "Cannot find merge-base: {}",
            String::from_utf8_lossy(&base_out.stderr)
        ));
    }
    let base = String::from_utf8_lossy(&base_out.stdout).trim().to_string();

    // 2. Fichiers modifiés dans HEAD depuis base
    let ours_files = git_changed_files(&git, &cwd, &base, "HEAD")?;
    // 3. Fichiers modifiés dans source_branch depuis base
    let theirs_files = git_changed_files(&git, &cwd, &base, &source_branch)?;

    // 4. Intersection : modifiés des deux côtés
    let ours_set: std::collections::HashSet<&String> = ours_files.iter().collect();
    let both_modified: Vec<&String> = theirs_files.iter().filter(|f| ours_set.contains(f)).collect();

    // 5. Fichiers supprimés/ajoutés unilatéralement
    let theirs_set: std::collections::HashSet<&String> = theirs_files.iter().collect();
    let only_ours: Vec<&String> = ours_files.iter().filter(|f| !theirs_set.contains(f)).collect();
    let only_theirs: Vec<&String> = theirs_files.iter().filter(|f| !ours_set.contains(f)).collect();

    let tmp = std::env::temp_dir();
    let mut results: Vec<FileMergePreview> = Vec::new();

    // 6. Pour chaque fichier modifié des deux côtés → tenter git merge-file
    for file_path in both_modified {
        let preview = merge_file_preview(&git, &cwd, &base, "HEAD", &source_branch, file_path, &tmp);
        results.push(preview);
    }

    // Fichiers seulement modifiés côté ours → pas de conflit
    for file_path in only_ours {
        results.push(FileMergePreview {
            file_path: file_path.clone(),
            conflict_content: String::new(),
            has_conflicts: false,
            is_add_delete: false,
        });
    }

    // Fichiers seulement modifiés côté theirs → pas de conflit (theirs gagne)
    for file_path in only_theirs {
        results.push(FileMergePreview {
            file_path: file_path.clone(),
            conflict_content: String::new(),
            has_conflicts: false,
            is_add_delete: false,
        });
    }

    // Trier : conflits en premier, puis par chemin
    results.sort_by(|a, b| {
        b.has_conflicts.cmp(&a.has_conflicts)
            .then(a.file_path.cmp(&b.file_path))
    });

    Ok(results)
}

// ─── Conflict Predictor — rebase & cherry-pick (v2.20.0) ──
//
// Generalize the side-effect-free predictor to simulate a rebase and a
// cherry-pick without mutating the working tree. Both return the same
// `Vec<FileMergePreview>` shape as `preview_merge` so the frontend resolver
// path is reused verbatim; the per-operation risk level is derived frontend-side.
//
// Implementation reuses `merge_file_preview` with the operation's ancestor:
//   - rebase: 3-way preview against merge-base(HEAD, onto)
//   - cherry-pick: 3-way merge with `commit^` as ancestor, HEAD ours, commit theirs
//
// Scaffolding stubs — see design spec
// docs/superpowers/specs/2026-06-16-v2.20.0-scratch-worktree-design.md

/// Resolve a ref to a full commit SHA, returning a clear error if unknown.
/// Used by the rebase / cherry-pick predictors to fail fast on bad refs.
fn rev_parse_verify(git: &str, cwd: &str, rev: &str) -> Result<String, String> {
    // `<rev>^{commit}` forces resolution to a commit object and fails on
    // tags pointing at non-commits, on missing refs, etc.
    let spec = format!("{}^{{commit}}", rev);
    let out = hidden_cmd(git)
        .args(["rev-parse", "--verify", "--quiet", &spec])
        .current_dir(cwd)
        .output()
        .map_err(|e| format!("rev-parse failed: {}", e))?;
    if !out.status.success() {
        return Err(format!("Unknown or invalid ref: {}", rev));
    }
    let sha = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if sha.is_empty() {
        return Err(format!("Unknown or invalid ref: {}", rev));
    }
    Ok(sha)
}

/// Run the per-file 3-way preview over the intersection of changed files,
/// then append the unilaterally-changed files (no conflict) — mirroring the
/// structure of `preview_merge` so the frontend resolver contract is identical.
///
/// `ancestor` is the merge base / common ancestor, `ours_ref` is the side the
/// work lands on, `theirs_ref` is the side being applied.
fn build_3way_preview(
    git: &str,
    cwd: &str,
    ancestor: &str,
    ours_ref: &str,
    theirs_ref: &str,
) -> Result<Vec<FileMergePreview>, String> {
    let ours_files = git_changed_files(git, cwd, ancestor, ours_ref)?;
    let theirs_files = git_changed_files(git, cwd, ancestor, theirs_ref)?;

    let ours_set: std::collections::HashSet<&String> = ours_files.iter().collect();
    let theirs_set: std::collections::HashSet<&String> = theirs_files.iter().collect();

    let both_modified: Vec<&String> = theirs_files.iter().filter(|f| ours_set.contains(f)).collect();
    let only_ours: Vec<&String> = ours_files.iter().filter(|f| !theirs_set.contains(f)).collect();
    let only_theirs: Vec<&String> = theirs_files.iter().filter(|f| !ours_set.contains(f)).collect();

    let tmp = std::env::temp_dir();
    let mut results: Vec<FileMergePreview> = Vec::new();

    for file_path in both_modified {
        results.push(merge_file_preview(git, cwd, ancestor, ours_ref, theirs_ref, file_path, &tmp));
    }
    for file_path in only_ours {
        results.push(FileMergePreview {
            file_path: file_path.clone(),
            conflict_content: String::new(),
            has_conflicts: false,
            is_add_delete: false,
        });
    }
    for file_path in only_theirs {
        results.push(FileMergePreview {
            file_path: file_path.clone(),
            conflict_content: String::new(),
            has_conflicts: false,
            is_add_delete: false,
        });
    }

    results.sort_by(|a, b| {
        b.has_conflicts.cmp(&a.has_conflicts)
            .then(a.file_path.cmp(&b.file_path))
    });

    Ok(results)
}

/// Simulate rebasing HEAD onto `onto` without modifying the working tree.
///
/// Orientation: `git rebase` replays HEAD's commits on top of `onto`. During a
/// real rebase, the index being built starts from `onto`, and each replayed
/// commit from HEAD is applied on top — so on a conflict git labels the `onto`
/// side as "ours" (HEAD of the rebased-onto state) and the replayed commit as
/// "theirs". We mirror that here per commit:
///   - ancestor = parent of the commit being replayed
///   - ours  = onto  (the target base the work lands on)
///   - theirs = commit (the individual commit being replayed)
///
/// Each commit in the stack `merge_base..HEAD` is replayed individually
/// (oldest-first via `rev-list --reverse`). If the same file appears in
/// multiple commits, the entry with the most conflicts is kept so that
/// intermediate conflicts are not silently dropped.
#[tauri::command]
pub(crate) async fn preview_rebase(cwd: String, onto: String) -> Result<Vec<FileMergePreview>, String> {
    let git = git_binary();

    // Fail fast on an unknown / invalid `onto` ref.
    let onto_sha = rev_parse_verify(&git, &cwd, &onto)?;
    let head_sha = rev_parse_verify(&git, &cwd, "HEAD")?;

    // Common ancestor of the current branch and the rebase target.
    let base_out = hidden_cmd(&git)
        .args(["merge-base", &head_sha, &onto_sha])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("merge-base failed: {}", e))?;
    if !base_out.status.success() {
        return Err(format!(
            "Cannot find merge-base between HEAD and {}: {}",
            onto,
            String::from_utf8_lossy(&base_out.stderr).trim()
        ));
    }
    let merge_base = String::from_utf8_lossy(&base_out.stdout).trim().to_string();
    if merge_base.is_empty() {
        return Err(format!("No common ancestor between HEAD and {}", onto));
    }

    // Get commits oldest-first: merge_base..HEAD
    let rev_range = format!("{}..{}", merge_base, head_sha);
    let commits_out = hidden_cmd(&git)
        .args(["rev-list", "--reverse", &rev_range])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("rev-list failed: {}", e))?;
    if !commits_out.status.success() {
        return Err(format!(
            "rev-list failed: {}",
            String::from_utf8_lossy(&commits_out.stderr).trim()
        ));
    }
    let commits_str = String::from_utf8_lossy(&commits_out.stdout);
    let commits: Vec<&str> = commits_str
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .collect();

    // Replay each commit individually. ours = onto, theirs = commit.
    // Accumulate all per-commit previews, then deduplicate by file path,
    // keeping the entry with the most conflicts for each file.
    let mut all_previews: Vec<FileMergePreview> = Vec::new();
    for commit in &commits {
        let parent_spec = format!("{}^", commit);
        let parent = match rev_parse_verify(&git, &cwd, &parent_spec) {
            Ok(p) => p,
            Err(_) => continue, // root commit — skip (no parent to diff against)
        };
        let mut per_commit = build_3way_preview(&git, &cwd, &parent, &onto_sha, commit)?;
        all_previews.append(&mut per_commit);
    }

    // Deduplicate: for each file path keep the entry with the most conflicts.
    // Conflicting entries (has_conflicts=true) beat clean ones.
    let mut by_file: std::collections::HashMap<String, FileMergePreview> =
        std::collections::HashMap::new();
    for preview in all_previews {
        let key = preview.file_path.clone();
        let keep = match by_file.get(&key) {
            None => true,
            Some(existing) => {
                // Prefer the entry with more conflict signal:
                // is_add_delete > has_conflicts (with markers) > clean.
                let new_score = if preview.is_add_delete { 2u8 }
                    else if preview.has_conflicts { 1 }
                    else { 0 };
                let old_score = if existing.is_add_delete { 2u8 }
                    else if existing.has_conflicts { 1 }
                    else { 0 };
                new_score > old_score
            }
        };
        if keep {
            by_file.insert(key, preview);
        }
    }

    let mut results: Vec<FileMergePreview> = by_file.into_values().collect();
    results.sort_by(|a, b| {
        b.has_conflicts.cmp(&a.has_conflicts)
            .then(a.file_path.cmp(&b.file_path))
    });

    Ok(results)
}

/// Simulate cherry-picking `commit` onto HEAD without modifying the working tree.
///
/// Orientation matches `git cherry-pick`: it applies the diff `commit^..commit`
/// onto HEAD. The 3-way is therefore:
///   - ancestor = commit^ (the cherry-picked commit's parent)
///   - ours  = HEAD   (where it is being applied)
///   - theirs = commit (the change being picked)
#[tauri::command]
pub(crate) async fn preview_cherry_pick(cwd: String, commit: String) -> Result<Vec<FileMergePreview>, String> {
    let git = git_binary();

    // Resolve the commit and ensure HEAD exists (clear error on a fresh repo).
    let commit_sha = rev_parse_verify(&git, &cwd, &commit)?;
    rev_parse_verify(&git, &cwd, "HEAD")?;

    // Parent of the cherry-picked commit. A root commit has no parent — we
    // cannot compute a 3-way ancestor, so report a clear error.
    let parent_spec = format!("{}^", commit_sha);
    let parent = rev_parse_verify(&git, &cwd, &parent_spec).map_err(|_| {
        format!(
            "Cannot preview cherry-pick of root commit {} (no parent to diff against)",
            commit
        )
    })?;

    // ancestor = commit^, ours = HEAD, theirs = commit.
    build_3way_preview(&git, &cwd, &parent, "HEAD", &commit_sha)
}

/// Tente de merger les trois versions d'un fichier avec git merge-file.
/// Retourne le contenu résultant (avec ou sans marqueurs de conflit).
fn merge_file_preview(
    git: &str,
    cwd: &str,
    base_ref: &str,
    ours_ref: &str,
    theirs_ref: &str,
    file_path: &str,
    tmp: &std::path::Path,
) -> FileMergePreview {
    /// Lire le contenu d'un fichier à une révision donnée. Retourne None si absent.
    fn git_show_file(git: &str, cwd: &str, rev: &str, path: &str) -> Option<Vec<u8>> {
        let spec = format!("{}:{}", rev, path);
        let out = hidden_cmd(git)
            .args(["show", &spec])
            .current_dir(cwd)
            .output()
            .ok()?;
        if out.status.success() { Some(out.stdout) } else { None }
    }

    let base_bytes = git_show_file(git, cwd, base_ref, file_path);
    let ours_bytes = git_show_file(git, cwd, ours_ref, file_path);
    let theirs_bytes = git_show_file(git, cwd, theirs_ref, file_path);

    // Si un côté n'a pas le fichier → add/delete conflict
    match (&ours_bytes, &theirs_bytes) {
        (None, _) | (_, None) => {
            return FileMergePreview {
                file_path: file_path.to_string(),
                conflict_content: String::new(),
                has_conflicts: true,
                is_add_delete: true,
            };
        }
        _ => {}
    }

    // Écrire les trois versions dans des fichiers temporaires
    let prefix = file_path.replace(['/', '\\', '.'], "_");
    let tmp_base  = tmp.join(format!("{}_base.tmp", prefix));
    let tmp_ours  = tmp.join(format!("{}_ours.tmp", prefix));
    let tmp_theirs = tmp.join(format!("{}_theirs.tmp", prefix));

    let write_or_empty = |path: &std::path::Path, bytes: &Option<Vec<u8>>| {
        let content = bytes.as_deref().unwrap_or(b"");
        std::fs::write(path, content)
    };

    if write_or_empty(&tmp_base, &base_bytes).is_err()
        || write_or_empty(&tmp_ours, &ours_bytes).is_err()
        || write_or_empty(&tmp_theirs, &theirs_bytes).is_err()
    {
        return FileMergePreview {
            file_path: file_path.to_string(),
            conflict_content: String::new(),
            has_conflicts: true,
            is_add_delete: false,
        };
    }

    // git merge-file -p <ours> <base> <theirs>  (note: ordre ours/base/theirs)
    let merge_out = git_cmd()
        .args([
            "merge-file",
            "-p",
            "--diff3",
            tmp_ours.to_str().unwrap_or(""),
            tmp_base.to_str().unwrap_or(""),
            tmp_theirs.to_str().unwrap_or(""),
        ])
        .output();

    // Nettoyer
    let _ = std::fs::remove_file(&tmp_base);
    let _ = std::fs::remove_file(&tmp_ours);
    let _ = std::fs::remove_file(&tmp_theirs);

    match merge_out {
        Ok(out) => {
            let content = String::from_utf8_lossy(&out.stdout).to_string();
            // git merge-file retourne exit code 1 si conflit, 0 si merge propre
            let has_conflicts = !out.status.success() || content.contains("<<<<<<<");
            FileMergePreview {
                file_path: file_path.to_string(),
                conflict_content: content,
                has_conflicts,
                is_add_delete: false,
            }
        }
        Err(_) => FileMergePreview {
            file_path: file_path.to_string(),
            conflict_content: String::new(),
            has_conflicts: true,
            is_add_delete: false,
        },
    }
}

// ─── v2.12 Branch Management & Identity ──────────────────────────────────────

/// Return the names of local branches fully merged into the repo's default branch.
/// Excludes the current branch and the default branch itself.
/// Equivalent to `git branch --merged <default_branch> --format="%(refname:short)"`.
#[tauri::command]
pub(crate) async fn git_branch_merged(cwd: String) -> Result<Vec<String>, String> {
    use crate::git::cmd::git_cmd;

    // Resolve default branch (main / master / trunk / …)
    let default_out = git_cmd()
        .args(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])
        .current_dir(&cwd)
        .output();
    let default_branch = match default_out {
        Ok(out) if out.status.success() => {
            // e.g. "origin/main" → "main"
            let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
            s.splitn(2, '/').nth(1).unwrap_or("main").to_string()
        }
        _ => "main".to_string(),
    };

    // Current branch name (to exclude)
    let cur_out = git_cmd()
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(&cwd)
        .output()
        .map_err(|e| e.to_string())?;
    let current_branch = String::from_utf8_lossy(&cur_out.stdout).trim().to_string();

    let output = git_cmd()
        .args([
            "branch",
            "--merged",
            &default_branch,
            "--format=%(refname:short)",
        ])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("git branch --merged failed: {}", e))?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    let merged: Vec<String> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|name| !name.is_empty() && name != &default_branch && name != &current_branch)
        .collect();

    Ok(merged)
}

/// Return the effective git user.name and user.email for the given repo.
#[tauri::command]
pub(crate) async fn git_config_identity(cwd: String) -> Result<(String, String), String> {
    use crate::git::cmd::git_cmd;

    let name_out = git_cmd()
        .args(["config", "user.name"])
        .current_dir(&cwd)
        .output()
        .map_err(|e| e.to_string())?;
    let email_out = git_cmd()
        .args(["config", "user.email"])
        .current_dir(&cwd)
        .output()
        .map_err(|e| e.to_string())?;

    let name = String::from_utf8_lossy(&name_out.stdout).trim().to_string();
    let email = String::from_utf8_lossy(&email_out.stdout).trim().to_string();

    if name.is_empty() || email.is_empty() {
        return Err("git user.name or user.email is not configured".to_string());
    }
    Ok((name, email))
}

/// Return the absolute path of the commit.template configured for the repo,
/// with ~ expanded to the home directory. Returns null (None) if not set.
#[tauri::command]
pub(crate) async fn git_commit_template_path(cwd: String) -> Result<Option<String>, String> {
    use crate::git::cmd::git_cmd;

    let output = git_cmd()
        .args(["config", "commit.template"])
        .current_dir(&cwd)
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Ok(None); // Not configured — not an error
    }

    let raw = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if raw.is_empty() {
        return Ok(None);
    }

    // Expand leading ~
    let expanded = if raw.starts_with('~') {
        let home = std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .unwrap_or_default();
        format!("{}{}", home, &raw[1..])
    } else {
        raw
    };

    Ok(Some(expanded))
}

// ─── Tests — Conflict Predictor (rebase / cherry-pick) ───────────────
//
// Per AGENTS.md these run against REAL temporary git repositories (no git
// layer mocking). They exercise the sync helpers (`rev_parse_verify`,
// `build_3way_preview`) that the async Tauri commands delegate to, on repos
// with a *known* rebase conflict and a *known* cherry-pick conflict, and they
// assert the working tree is left untouched.
#[cfg(test)]
mod predictor_tests {
    use super::*;
    use std::path::PathBuf;
    use std::process::Command;
    use std::sync::atomic::{AtomicU64, Ordering};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

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
        fn new() -> Self {
            let n = COUNTER.fetch_add(1, Ordering::SeqCst);
            let pid = std::process::id();
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let dir = std::env::temp_dir().join(format!("gitwand-predictor-test-{}-{}-{}", pid, n, nanos));
            std::fs::create_dir_all(&dir).unwrap();
            let repo = TempRepo { path: dir };
            repo.git(&["init", "-q", "-b", "main"]);
            // Deterministic identity so commits succeed in CI.
            repo.git(&["config", "user.name", "Test"]);
            repo.git(&["config", "user.email", "test@example.com"]);
            repo.git(&["config", "commit.gpgsign", "false"]);
            repo
        }

        fn cwd(&self) -> &str {
            self.path.to_str().unwrap()
        }

        fn git(&self, args: &[&str]) -> std::process::Output {
            let out = Command::new(git_binary())
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

        fn write(&self, rel: &str, content: &str) {
            let p = self.path.join(rel);
            if let Some(parent) = p.parent() {
                std::fs::create_dir_all(parent).unwrap();
            }
            std::fs::write(p, content).unwrap();
        }

        fn read(&self, rel: &str) -> String {
            std::fs::read_to_string(self.path.join(rel)).unwrap()
        }

        fn commit_all(&self, msg: &str) {
            self.git(&["add", "-A"]);
            self.git(&["commit", "-q", "-m", msg]);
        }

        fn head_sha(&self) -> String {
            let out = self.git(&["rev-parse", "HEAD"]);
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        }
    }

    /// Snapshot the working-tree state via `git status --porcelain` so tests can
    /// assert the predictor never mutated anything.
    fn porcelain(repo: &TempRepo) -> String {
        let out = repo.git(&["status", "--porcelain"]);
        String::from_utf8_lossy(&out.stdout).to_string()
    }

    fn conflicting(previews: &[FileMergePreview]) -> Vec<String> {
        let mut v: Vec<String> = previews
            .iter()
            .filter(|p| p.has_conflicts)
            .map(|p| p.file_path.clone())
            .collect();
        v.sort();
        v
    }

    fn ref_sha(repo: &TempRepo, r: &str) -> String {
        let out = repo.git(&["rev-parse", r]);
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    fn merge_base(repo: &TempRepo, a: &str, b: &str) -> String {
        let out = repo.git(&["merge-base", a, b]);
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    // ── rebase ────────────────────────────────────────────────

    #[test]
    fn preview_rebase_predicts_known_conflict() {
        let repo = TempRepo::new();
        repo.write("shared.txt", "line1\nline2\nline3\n");
        repo.commit_all("base");

        // feature branch (HEAD) edits line2 one way.
        repo.git(&["checkout", "-q", "-b", "feature"]);
        repo.write("shared.txt", "line1\nFEATURE\nline3\n");
        repo.commit_all("feature edit");

        // main edits line2 a conflicting way.
        repo.git(&["checkout", "-q", "main"]);
        repo.write("shared.txt", "line1\nMAIN\nline3\n");
        repo.commit_all("main edit");

        // Rebase feature (HEAD) onto main.
        repo.git(&["checkout", "-q", "feature"]);
        let head_before = repo.head_sha();
        let status_before = porcelain(&repo);

        let git = git_binary();
        let cwd = repo.cwd();
        rev_parse_verify(&git, cwd, "main").unwrap();
        let base = merge_base(&repo, "HEAD", "main");
        // Orientation: ours = onto (main), theirs = HEAD (feature).
        let previews = build_3way_preview(&git, cwd, &base, "main", "HEAD").unwrap();

        assert_eq!(
            conflicting(&previews),
            vec!["shared.txt".to_string()],
            "expected shared.txt to be predicted as conflicting"
        );

        // Working tree + HEAD must be untouched.
        assert_eq!(repo.head_sha(), head_before, "HEAD moved during preview");
        assert_eq!(porcelain(&repo), status_before, "working tree mutated during preview");
        assert_eq!(repo.read("shared.txt"), "line1\nFEATURE\nline3\n");
    }

    #[test]
    fn preview_rebase_no_conflict_on_disjoint_changes() {
        let repo = TempRepo::new();
        repo.write("a.txt", "a\n");
        repo.write("b.txt", "b\n");
        repo.commit_all("base");

        repo.git(&["checkout", "-q", "-b", "feature"]);
        repo.write("a.txt", "a-feature\n");
        repo.commit_all("feature edits a");

        repo.git(&["checkout", "-q", "main"]);
        repo.write("b.txt", "b-main\n");
        repo.commit_all("main edits b");

        repo.git(&["checkout", "-q", "feature"]);
        let git = git_binary();
        let cwd = repo.cwd();
        let base = merge_base(&repo, "HEAD", "main");
        let previews = build_3way_preview(&git, cwd, &base, "main", "HEAD").unwrap();

        assert!(
            conflicting(&previews).is_empty(),
            "disjoint changes must not be predicted as conflicting: {:?}",
            conflicting(&previews)
        );
    }

    #[test]
    fn preview_rebase_unknown_ref_errors() {
        let repo = TempRepo::new();
        repo.write("a.txt", "a\n");
        repo.commit_all("base");

        let git = git_binary();
        let err = rev_parse_verify(&git, repo.cwd(), "does-not-exist");
        assert!(err.is_err(), "unknown ref should produce an Err");
    }

    /// Two commits on the feature branch each modify `shared.txt` in ways that
    /// conflict with `main`. The per-commit replay must surface the conflict even
    /// though both commits touch the same file. A squash of the two commits would
    /// produce the same net diff, so this test validates that the per-commit loop
    /// fires `build_3way_preview` twice and the deduplication keeps the
    /// conflicting entry.
    #[test]
    fn preview_rebase_two_commit_stack_reports_conflict() {
        let repo = TempRepo::new();
        repo.write("shared.txt", "line1\nline2\nline3\n");
        repo.commit_all("base");

        // Build a 2-commit feature branch, each touching shared.txt differently.
        repo.git(&["checkout", "-q", "-b", "feature"]);
        repo.write("shared.txt", "line1\nFEATURE-A\nline3\n");
        repo.commit_all("feature commit 1");
        repo.write("shared.txt", "line1\nFEATURE-B\nline3\n");
        repo.commit_all("feature commit 2");

        // main conflicts on the same line.
        repo.git(&["checkout", "-q", "main"]);
        repo.write("shared.txt", "line1\nMAIN\nline3\n");
        repo.commit_all("main edit");

        // HEAD is now on feature (2 commits ahead of merge-base).
        repo.git(&["checkout", "-q", "feature"]);
        let head_before = repo.head_sha();
        let status_before = porcelain(&repo);

        let git = git_binary();
        let cwd = repo.cwd();
        // Simulate: gitwand preview_rebase --onto main
        let head_sha = rev_parse_verify(&git, cwd, "HEAD").unwrap();
        let onto_sha = rev_parse_verify(&git, cwd, "main").unwrap();
        let base_out = Command::new(git_binary())
            .args(["merge-base", &head_sha, &onto_sha])
            .current_dir(&repo.path)
            .output()
            .unwrap();
        assert!(base_out.status.success(), "merge-base failed");
        let merge_base = String::from_utf8_lossy(&base_out.stdout).trim().to_string();

        // Collect commits oldest-first and replay.
        let rev_range = format!("{}..{}", merge_base, head_sha);
        let commits_out = Command::new(git_binary())
            .args(["rev-list", "--reverse", &rev_range])
            .current_dir(&repo.path)
            .output()
            .unwrap();
        let commits_str = String::from_utf8_lossy(&commits_out.stdout);
        let commits: Vec<&str> = commits_str.lines().map(|l| l.trim()).filter(|l| !l.is_empty()).collect();
        assert_eq!(commits.len(), 2, "should have exactly 2 commits in the stack");

        let mut all_previews: Vec<FileMergePreview> = Vec::new();
        for commit in &commits {
            let parent_spec = format!("{}^", commit);
            let parent = rev_parse_verify(&git, cwd, &parent_spec).unwrap();
            let mut pp = build_3way_preview(&git, cwd, &parent, &onto_sha, commit).unwrap();
            all_previews.append(&mut pp);
        }
        // At least one entry for shared.txt must have has_conflicts = true.
        let conflict_files: Vec<String> = all_previews.iter()
            .filter(|p| p.has_conflicts)
            .map(|p| p.file_path.clone())
            .collect();
        assert!(
            conflict_files.iter().any(|f| f == "shared.txt"),
            "2-commit stack: shared.txt must be predicted conflicting; got: {:?}",
            conflict_files
        );

        // Repo must be completely untouched.
        assert_eq!(repo.head_sha(), head_before, "HEAD moved during preview");
        assert_eq!(porcelain(&repo), status_before, "working tree mutated");
    }

    // ── cherry-pick ───────────────────────────────────────────

    #[test]
    fn preview_cherry_pick_predicts_known_conflict() {
        let repo = TempRepo::new();
        repo.write("shared.txt", "x\ncommon\nz\n");
        repo.commit_all("base");

        // topic branch: a commit that rewrites `common`.
        repo.git(&["checkout", "-q", "-b", "topic"]);
        repo.write("shared.txt", "x\nTOPIC\nz\n");
        repo.commit_all("topic edit");
        let topic_commit = repo.head_sha();

        // main diverges, editing the same line differently.
        repo.git(&["checkout", "-q", "main"]);
        repo.write("shared.txt", "x\nMAIN\nz\n");
        repo.commit_all("main edit");

        let head_before = repo.head_sha();
        let status_before = porcelain(&repo);

        let git = git_binary();
        let cwd = repo.cwd();
        // ancestor = topic^, ours = HEAD (main), theirs = topic commit.
        let parent = ref_sha(&repo, &format!("{}^", topic_commit));
        let previews = build_3way_preview(&git, cwd, &parent, "HEAD", &topic_commit).unwrap();

        assert_eq!(
            conflicting(&previews),
            vec!["shared.txt".to_string()],
            "expected shared.txt to be predicted as conflicting on cherry-pick"
        );

        assert_eq!(repo.head_sha(), head_before, "HEAD moved during preview");
        assert_eq!(porcelain(&repo), status_before, "working tree mutated during preview");
        assert_eq!(repo.read("shared.txt"), "x\nMAIN\nz\n");
    }

    #[test]
    fn preview_cherry_pick_clean_when_no_overlap() {
        let repo = TempRepo::new();
        repo.write("a.txt", "a\n");
        repo.commit_all("base");

        repo.git(&["checkout", "-q", "-b", "topic"]);
        repo.write("newfile.txt", "brand new\n");
        repo.commit_all("topic adds a new file");
        let topic_commit = repo.head_sha();

        repo.git(&["checkout", "-q", "main"]);
        repo.write("a.txt", "a-changed\n");
        repo.commit_all("main edits a");

        let git = git_binary();
        let cwd = repo.cwd();
        let parent = ref_sha(&repo, &format!("{}^", topic_commit));
        let previews = build_3way_preview(&git, cwd, &parent, "HEAD", &topic_commit).unwrap();

        assert!(
            conflicting(&previews).is_empty(),
            "non-overlapping cherry-pick must be clean: {:?}",
            conflicting(&previews)
        );
    }

    #[test]
    fn rev_parse_verify_root_commit_has_no_parent() {
        let repo = TempRepo::new();
        repo.write("a.txt", "a\n");
        repo.commit_all("root");
        let root = repo.head_sha();

        let git = git_binary();
        let parent_spec = format!("{}^", root);
        // The very first commit has no parent — predictor must surface an error.
        assert!(
            rev_parse_verify(&git, repo.cwd(), &parent_spec).is_err(),
            "root commit parent must not resolve"
        );
    }
}

// ─── Tests: Steps 3, 4, 5 (git_log pathspec, git_rev_count, scoped git_status) ─

#[cfg(test)]
mod pathspec_tests {
    use super::*;
    use std::path::PathBuf;
    use std::process::Command;
    use std::sync::atomic::{AtomicU64, Ordering};

    static COUNTER2: AtomicU64 = AtomicU64::new(0);

    struct TempRepo {
        path: PathBuf,
    }

    impl Drop for TempRepo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    impl TempRepo {
        fn new() -> Self {
            let n = COUNTER2.fetch_add(1, Ordering::SeqCst);
            let pid = std::process::id();
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let dir = std::env::temp_dir()
                .join(format!("gitwand-pathspec-test-{}-{}-{}", pid, n, nanos));
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
            let out = Command::new(git_binary())
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

        fn write(&self, rel: &str, content: &str) {
            let p = self.path.join(rel);
            if let Some(parent) = p.parent() {
                std::fs::create_dir_all(parent).unwrap();
            }
            std::fs::write(p, content).unwrap();
        }

        fn commit_all(&self, msg: &str) {
            self.git(&["add", "-A"]);
            self.git(&["commit", "-q", "-m", msg]);
        }
    }

    // ── Step 3: git_log pathspec ──────────────────────────────

    #[test]
    fn git_log_pathspec_filters_correctly() {
        let repo = TempRepo::new();

        // Commit touching packages/a
        repo.write("packages/a/file.txt", "hello");
        repo.commit_all("add packages/a");

        // Commit touching packages/b
        repo.write("packages/b/file.txt", "world");
        repo.commit_all("add packages/b");

        // Commit touching both
        repo.write("packages/a/other.txt", "more");
        repo.write("packages/b/other.txt", "more");
        repo.commit_all("touch both");

        let all_entries = tauri::async_runtime::block_on(git_log(
            repo.cwd(),
            None, None, None, None, None, None,
        ))
        .expect("git_log(all) failed");

        let scoped_a = tauri::async_runtime::block_on(git_log(
            repo.cwd(),
            None, None, None, None, None,
            Some("packages/a".to_string()),
        ))
        .expect("git_log(pathspec=a) failed");

        let scoped_b = tauri::async_runtime::block_on(git_log(
            repo.cwd(),
            None, None, None, None, None,
            Some("packages/b".to_string()),
        ))
        .expect("git_log(pathspec=b) failed");

        // All: 3 commits
        assert_eq!(all_entries.len(), 3, "expected 3 unscoped commits");
        // packages/a: commits 1 (add a) + 3 (touch both) = 2
        assert_eq!(scoped_a.len(), 2, "expected 2 commits for packages/a, got {:?}",
            scoped_a.iter().map(|e| &e.message).collect::<Vec<_>>());
        // packages/b: commits 2 (add b) + 3 (touch both) = 2
        assert_eq!(scoped_b.len(), 2, "expected 2 commits for packages/b, got {:?}",
            scoped_b.iter().map(|e| &e.message).collect::<Vec<_>>());
    }

    #[test]
    fn git_log_no_pathspec_returns_all() {
        let repo = TempRepo::new();
        repo.write("root.txt", "root");
        repo.commit_all("root commit");

        let entries = tauri::async_runtime::block_on(git_log(
            repo.cwd(),
            None, None, None, None, None, None,
        ))
        .expect("git_log failed");

        assert_eq!(entries.len(), 1);
    }

    // ── Step 4: git_rev_count ──────────────────────────────────

    #[test]
    fn git_rev_count_matches_git_log_len() {
        let repo = TempRepo::new();
        repo.write("a.txt", "1");
        repo.commit_all("c1");
        repo.write("a.txt", "2");
        repo.commit_all("c2");
        repo.write("a.txt", "3");
        repo.commit_all("c3");

        let count = tauri::async_runtime::block_on(git_rev_count(
            repo.cwd(), None, None, None,
        ))
        .expect("git_rev_count failed");

        let log = tauri::async_runtime::block_on(git_log(
            repo.cwd(),
            Some(1000), None, None, None, None, None,
        ))
        .expect("git_log failed");

        assert_eq!(count, log.len(), "rev_count ({}) should match log len ({})", count, log.len());
    }

    #[test]
    fn git_rev_count_scoped_matches_scoped_log() {
        let repo = TempRepo::new();
        // 2 commits only in packages/a
        repo.write("packages/a/f.txt", "v1");
        repo.commit_all("a1");
        repo.write("packages/a/f.txt", "v2");
        repo.commit_all("a2");
        // 1 commit only in packages/b
        repo.write("packages/b/f.txt", "b1");
        repo.commit_all("b1");

        let count_a = tauri::async_runtime::block_on(git_rev_count(
            repo.cwd(), None, None, Some("packages/a".to_string()),
        ))
        .expect("git_rev_count(a) failed");

        let log_a = tauri::async_runtime::block_on(git_log(
            repo.cwd(),
            Some(1000), None, None, None, None,
            Some("packages/a".to_string()),
        ))
        .expect("git_log(a) failed");

        assert_eq!(count_a, log_a.len(),
            "scoped rev_count ({}) should match scoped log len ({})", count_a, log_a.len());
        assert_eq!(count_a, 2, "packages/a has 2 commits");
    }

    #[test]
    fn git_rev_count_empty_repo_returns_zero() {
        let repo = TempRepo::new();
        // fresh repo — HEAD doesn't exist yet
        let count = tauri::async_runtime::block_on(git_rev_count(
            repo.cwd(), None, None, None,
        ))
        .expect("git_rev_count on empty repo failed");
        assert_eq!(count, 0);
    }

    // ── Step 5: scoped git_status ─────────────────────────────

    #[test]
    fn git_status_scoped_reports_only_subtree_changes() {
        let repo = TempRepo::new();
        // Initial commit so HEAD exists
        repo.write("root.txt", "root");
        repo.commit_all("root");

        // Dirty files in packages/a and packages/b (unstaged)
        repo.write("packages/a/dirty.txt", "dirty a");
        repo.write("packages/b/dirty.txt", "dirty b");

        // Scoped to packages/a: should see only packages/a/dirty.txt
        let status_a = git_status_cli(repo.cwd(), Some("packages/a".to_string()))
            .expect("git_status_cli(a) failed");

        let untracked_a: Vec<&str> = status_a.untracked.iter().map(|s| s.as_str()).collect();
        assert!(
            untracked_a.iter().any(|p| p.contains("packages/a")),
            "expected packages/a in untracked: {:?}", untracked_a
        );
        assert!(
            !untracked_a.iter().any(|p| p.contains("packages/b")),
            "packages/b should NOT appear in packages/a scope: {:?}", untracked_a
        );
    }

    #[test]
    fn git_status_no_pathspec_reports_all() {
        let repo = TempRepo::new();
        repo.write("root.txt", "root");
        repo.commit_all("root");
        repo.write("packages/a/dirty.txt", "dirty a");
        repo.write("packages/b/dirty.txt", "dirty b");

        let status = git_status_cli(repo.cwd(), None)
            .expect("git_status_cli(None) failed");

        let all_paths: Vec<&str> = status.untracked.iter().map(|s| s.as_str()).collect();
        // Both subtrees should appear
        let has_a = all_paths.iter().any(|p| p.contains("packages/a") || p.contains("packages/"));
        assert!(has_a, "unscoped status should show all changes: {:?}", all_paths);
    }

    // ── Remote branch existence without configured upstream ───────
    //
    // Reproduces the "GitWand offers to publish an already-published branch"
    // bug: a branch that lives on the remote but lost its `@{u}` tracking
    // config (pushed without -u, `gh pr checkout`, fork checkout…).

    /// Create a bare repo to act as `origin`. Returns its path; caller removes.
    fn init_bare_remote() -> PathBuf {
        let n = COUNTER2.fetch_add(1, Ordering::SeqCst);
        let pid = std::process::id();
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir()
            .join(format!("gitwand-bare-remote-{}-{}-{}", pid, n, nanos));
        let out = Command::new(git_binary())
            .args(["init", "--bare", "-q", "-b", "main"])
            .arg(&dir)
            .output()
            .expect("git init --bare failed to spawn");
        assert!(out.status.success(), "git init --bare failed");
        dir
    }

    #[test]
    fn git_status_detects_remote_branch_when_upstream_unset() {
        let repo = TempRepo::new();
        repo.write("a.txt", "1");
        repo.commit_all("c1");

        let bare = init_bare_remote();
        repo.git(&["remote", "add", "origin", bare.to_str().unwrap()]);
        // Publish, then drop the tracking config — the exact user scenario.
        repo.git(&["push", "-q", "-u", "origin", "main"]);
        repo.git(&["branch", "--unset-upstream"]);
        // One local commit ahead of what the remote ref points at.
        repo.write("b.txt", "2");
        repo.commit_all("c2");

        // libgit2 fast path
        let s = tauri::async_runtime::block_on(git_status(repo.cwd(), None))
            .expect("git_status failed");
        assert_eq!(s.remote, None, "no upstream should be configured");
        assert!(s.remote_branch_exists, "remote-tracking ref should be detected");
        assert_eq!(s.ahead, 1, "one local commit ahead of origin/main");
        assert_eq!(s.behind, 0);

        // CLI fallback path must agree.
        let c = git_status_cli(repo.cwd(), None).expect("git_status_cli failed");
        assert_eq!(c.remote, None);
        assert!(c.remote_branch_exists, "CLI path should also detect the remote ref");
        assert_eq!(c.ahead, 1);
        assert_eq!(c.behind, 0);

        let _ = std::fs::remove_dir_all(&bare);
    }

    #[test]
    fn git_status_no_remote_branch_means_unpublished() {
        let repo = TempRepo::new();
        repo.write("a.txt", "1");
        repo.commit_all("c1");

        let bare = init_bare_remote();
        repo.git(&["remote", "add", "origin", bare.to_str().unwrap()]);
        // A branch that was never pushed: genuinely "to publish".
        repo.git(&["checkout", "-q", "-b", "feature/new"]);
        repo.write("c.txt", "3");
        repo.commit_all("c2");

        let s = tauri::async_runtime::block_on(git_status(repo.cwd(), None))
            .expect("git_status failed");
        assert_eq!(s.remote, None);
        assert!(!s.remote_branch_exists, "unpushed branch must not look published");

        let c = git_status_cli(repo.cwd(), None).expect("git_status_cli failed");
        assert!(!c.remote_branch_exists, "CLI path agrees: branch is unpublished");

        let _ = std::fs::remove_dir_all(&bare);
    }

    #[test]
    fn git_status_tracked_branch_reports_remote_exists() {
        let repo = TempRepo::new();
        repo.write("a.txt", "1");
        repo.commit_all("c1");

        let bare = init_bare_remote();
        repo.git(&["remote", "add", "origin", bare.to_str().unwrap()]);
        repo.git(&["push", "-q", "-u", "origin", "main"]); // keeps upstream

        let s = tauri::async_runtime::block_on(git_status(repo.cwd(), None))
            .expect("git_status failed");
        assert_eq!(s.remote.as_deref(), Some("origin/main"));
        assert!(s.remote_branch_exists, "configured upstream implies it exists");

        let _ = std::fs::remove_dir_all(&bare);
    }
}

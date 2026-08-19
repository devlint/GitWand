//! libgit2 helpers — in-process replacements for `git CLI` invocations
//! on the workspace hot paths (§3.3a). Each function opens its own
//! `git2::Repository` and returns safe defaults on any error so a
//! single broken repo never poisons a whole workspace listing.
//!
//! Used by `commands::workspace::*_all` Tauri commands. Deliberately
//! NOT used by the user-facing `git_status` command — that path keeps
//! a CLI implementation for parity-test compatibility.

/// Read branch name + ahead/behind via libgit2. Returns
/// `(branch, ahead, behind, has_no_upstream)`. All fields default to safe
/// values on any libgit2 error so a single broken repo can't poison a
/// whole workspace listing.
pub(crate) fn libgit2_branch_ab(path: &str) -> (String, u32, u32, bool) {
    let repo = match git2::Repository::open(path) {
        Ok(r) => r,
        Err(_) => return (String::new(), 0, 0, true),
    };

    // Current branch — empty string for detached HEAD or unborn HEAD.
    let branch = match repo.head() {
        Ok(h) => h.shorthand().unwrap_or("").to_string(),
        Err(_) => String::new(),
    };

    // Ahead/behind vs upstream. We resolve HEAD → local branch → upstream
    // branch → graph_ahead_behind. Any step failing means "no upstream".
    let (ahead, behind, no_upstream) = (|| -> Option<(u32, u32, bool)> {
        let head = repo.head().ok()?;
        let local_oid = head.target()?;
        let local_branch = head.shorthand()?;
        let branch_ref = repo
            .find_branch(local_branch, git2::BranchType::Local)
            .ok()?;
        let upstream = match branch_ref.upstream() {
            Ok(u) => u,
            Err(_) => return Some((0, 0, true)), // valid local branch, just no upstream
        };
        let upstream_oid = upstream.get().target()?;
        let (a, b) = repo.graph_ahead_behind(local_oid, upstream_oid).ok()?;
        Some((a as u32, b as u32, false))
    })()
    .unwrap_or((0, 0, true));

    (branch, ahead, behind, no_upstream)
}

/// Count tracked files with worktree or index changes (excluding untracked
/// and ignored). Mirrors `git status --porcelain --untracked-files=no`.
pub(crate) fn libgit2_modified_count(path: &str) -> u32 {
    let repo = match git2::Repository::open(path) {
        Ok(r) => r,
        Err(_) => return 0,
    };
    let mut opts = git2::StatusOptions::new();
    opts.include_untracked(false).include_ignored(false);
    repo.statuses(Some(&mut opts))
        .map(|s| s.len() as u32)
        .unwrap_or(0)
}

/// Detailed WIP counts split between staged / unstaged / untracked, plus
/// the list of changed file paths (excluding untracked). Used by
/// workspace_wip_all.
pub(crate) fn libgit2_wip_status(path: &str) -> (u32, u32, u32, Vec<String>) {
    let repo = match git2::Repository::open(path) {
        Ok(r) => r,
        Err(_) => return (0, 0, 0, Vec::new()),
    };
    let mut opts = git2::StatusOptions::new();
    opts.include_untracked(true).include_ignored(false);
    let statuses = match repo.statuses(Some(&mut opts)) {
        Ok(s) => s,
        Err(_) => return (0, 0, 0, Vec::new()),
    };

    let staged_mask = git2::Status::INDEX_NEW
        | git2::Status::INDEX_MODIFIED
        | git2::Status::INDEX_DELETED
        | git2::Status::INDEX_RENAMED
        | git2::Status::INDEX_TYPECHANGE;
    let unstaged_mask = git2::Status::WT_MODIFIED
        | git2::Status::WT_DELETED
        | git2::Status::WT_RENAMED
        | git2::Status::WT_TYPECHANGE;

    let mut staged_count = 0u32;
    let mut unstaged_count = 0u32;
    let mut untracked_count = 0u32;
    let mut changed_files = std::collections::HashSet::<String>::new();

    for entry in statuses.iter() {
        let status = entry.status();
        let path_str = entry.path().unwrap_or("").to_string();
        if status.contains(git2::Status::WT_NEW) {
            untracked_count += 1;
            continue; // don't list untracked in changed_files (parity with old behavior)
        }
        if status.intersects(staged_mask) {
            staged_count += 1;
        }
        if status.intersects(unstaged_mask) {
            unstaged_count += 1;
        }
        if status.intersects(staged_mask | unstaged_mask) && !path_str.is_empty() {
            changed_files.insert(path_str);
        }
    }

    let mut files: Vec<String> = changed_files.into_iter().collect();
    files.sort();
    (staged_count, unstaged_count, untracked_count, files)
}

/// ISO 8601 committer date of HEAD (`%cI` equivalent). Empty string on
/// error or unborn HEAD.
pub(crate) fn libgit2_last_commit_at(path: &str) -> String {
    (|| -> Option<String> {
        let repo = git2::Repository::open(path).ok()?;
        let head = repo.head().ok()?;
        let oid = head.target()?;
        let commit = repo.find_commit(oid).ok()?;
        let time = commit.time();
        // git2 returns Time in seconds since epoch + offset minutes from UTC.
        // chrono would give us a clean ISO 8601, but the project doesn't depend
        // on chrono, so we format manually using the `time` crate's primitives
        // — except we don't have `time` either. Fall back to a simple offset
        // string compatible with %cI: "YYYY-MM-DDTHH:MM:SS+ZZ:ZZ".
        let secs = time.seconds();
        let offset_min = time.offset_minutes();
        // Use UTC base + offset in tag, like git's --date=iso-strict.
        let dt = format_iso8601(secs, offset_min);
        Some(dt)
    })()
    .unwrap_or_default()
}

/// Format Unix timestamp + UTC offset (in minutes) as ISO 8601 with offset.
/// Pure-stdlib so we don't pull a date crate just for one format string.
fn format_iso8601(secs: i64, offset_min: i32) -> String {
    // Apply offset to get local wall clock seconds, then break into Y-M-D h:m:s.
    let local_secs = secs + (offset_min as i64) * 60;
    let (y, mo, d, h, mi, s) = unix_to_ymdhms(local_secs);
    let sign = if offset_min >= 0 { '+' } else { '-' };
    let off_abs = offset_min.unsigned_abs();
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}{}{:02}:{:02}",
        y,
        mo,
        d,
        h,
        mi,
        s,
        sign,
        off_abs / 60,
        off_abs % 60
    )
}

/// Decompose Unix timestamp into (Y, M, D, h, m, s). Algorithm from Howard
/// Hinnant's "date algorithms" — works for any reasonable epoch and handles
/// leap years correctly. Range: years 1970-9999, ample for git timestamps.
fn unix_to_ymdhms(t: i64) -> (i32, u32, u32, u32, u32, u32) {
    let days = t.div_euclid(86_400);
    let time_of_day = t.rem_euclid(86_400);
    let h = (time_of_day / 3600) as u32;
    let mi = ((time_of_day % 3600) / 60) as u32;
    let s = (time_of_day % 60) as u32;
    // Days since 1970-01-01, shifted to 0000-03-01-based era.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = (yoe as i64) + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = if m <= 2 { y + 1 } else { y };
    (y as i32, m, d, h, mi, s)
}

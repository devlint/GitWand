//! libgit2 helpers — in-process replacements for `git CLI` invocations
//! on the workspace hot paths (§3.3a). Each function opens its own
//! `git2::Repository` and returns safe defaults on any error so a
//! single broken repo never poisons a whole workspace listing.
//!
//! Used by `commands::workspace::*_all` Tauri commands. Deliberately
//! NOT used by the user-facing `git_status` command — that path keeps
//! a CLI implementation for parity-test compatibility.

use super::cmd::safe_repo_path;

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

/// Render `git diff [--cached] -- <path>` as unified-diff text, in process.
///
/// Deliberately produces *text* rather than `DiffHunk`s: the caller feeds it to
/// the same `parse_diff_hunks` the CLI output goes through, so the two paths
/// cannot drift in hunk shaping, line classification, or the leading-space
/// context-line rule (AGENTS.md "Diff Parsing").
pub(crate) fn libgit2_diff_patch(cwd: &str, path: &str, staged: bool) -> Result<String, String> {
    let repo = git2::Repository::open(cwd).map_err(|e| format!("git2 open: {e}"))?;

    // A path with an unmerged (conflicted) index entry has no single "index"
    // version to diff against: `diff_index_to_workdir`/`diff_tree_to_index`
    // silently produce a useless patch (or none at all) for it, while the CLI
    // renders the real combined `diff --cc` conflict-marker diff. Bail out so
    // the caller (`git_diff`) falls back to the CLI, which is what the
    // conflict-resolution UI needs to render.
    let index = repo.index().map_err(|e| format!("git2 index: {e}"))?;
    let has_conflict = [1, 2, 3]
        .iter()
        .any(|stage| index.get_path(std::path::Path::new(path), *stage).is_some());
    if has_conflict {
        return Err(format!("{path} has an unmerged conflict"));
    }

    let mut opts = git2::DiffOptions::new();
    opts.pathspec(path);
    // Match the CLI defaults `git diff` uses for the UI: 3 lines of context,
    // no rename detection on a single-path diff.
    opts.context_lines(3);
    opts.include_untracked(false);

    let diff = if staged {
        // HEAD tree to index. An unborn HEAD has no tree: diff against nothing.
        let head_tree = repo.head().ok().and_then(|h| h.peel_to_tree().ok());
        repo.diff_tree_to_index(head_tree.as_ref(), None, Some(&mut opts))
            .map_err(|e| format!("git2 diff_tree_to_index: {e}"))?
    } else {
        repo.diff_index_to_workdir(None, Some(&mut opts))
            .map_err(|e| format!("git2 diff_index_to_workdir: {e}"))?
    };

    let mut out = String::new();
    diff.print(git2::DiffFormat::Patch, |_delta, _hunk, line| {
        match line.origin() {
            // Content lines carry their origin char separately from the text.
            '+' | '-' | ' ' => out.push(line.origin()),
            _ => {}
        }
        out.push_str(&String::from_utf8_lossy(line.content()));
        true
    })
    .map_err(|e| format!("git2 diff print: {e}"))?;

    Ok(out)
}

/// In-process `git blame --porcelain`. Uses libgit2's default diff algorithm
/// (`git2::BlameOptions` exposes no `--diff-algorithm` knob: internally it's
/// bundled libgit2's `xdiff`, unconfigured, i.e. Myers), which has no
/// `--diff-algorithm` equivalent: the caller must only use this for the
/// default (`histogram`) setting and fall back to the CLI otherwise.
///
/// Accuracy note (adversarial review of PR #178, Priority 5): a plain diff
/// between Myers and histogram *can* produce differently-shaped hunks around
/// a moved block with duplicate separator lines nearby (verified by hand —
/// see the `blame_attribution_matches_the_cli_on_a_moved_block` fixture
/// below). Blame attribution held up anyway: unlike a diff, blame doesn't
/// need to agree on *how* a change is hunked, only on which single commit
/// last touched each surviving line, and both algorithms still resolve that
/// the same way once a line's content is otherwise unambiguous. Real
/// divergence would require genuinely duplicate, indistinguishable line
/// content with more than one plausible origin commit — a case that is
/// inherently ambiguous for the CLI's own blame too, algorithm choice aside.
/// If a future fixture does show a real attribution divergence, follow the
/// plan's original fallback: gate `git_blame`'s libgit2 fast path off
/// entirely and go back to CLI-only for blame (independent of `git_diff`'s
/// libgit2 path, which stays put).
pub(crate) fn libgit2_blame(
    cwd: &str,
    path: &str,
    max_entries: usize,
) -> Result<Vec<crate::types::BlameLine>, String> {
    let repo = git2::Repository::open(cwd).map_err(|e| format!("git2 open: {e}"))?;
    let committed_blame = repo
        .blame_file(std::path::Path::new(path), None)
        .map_err(|e| format!("git2 blame: {e}"))?;

    let safe_path = safe_repo_path(cwd, path)?;
    let content = std::fs::read_to_string(&safe_path)
        .map_err(|e| format!("failed to read {path}: {e}"))?;
    let file_lines: Vec<&str> = content.split('\n').collect();

    // Re-blame against the actual working-tree buffer. `blame_file` alone only
    // knows about the committed content: on a dirty file its hunks are shaped
    // for the committed line count, so reading `content` (the on-disk buffer)
    // by those line numbers either drifts onto the wrong commit or silently
    // drops uncommitted lines entirely. `blame_buffer` re-diffs against the
    // buffer and marks changed lines with the zero OID, matching what
    // `git blame --porcelain` reports as "Not Committed Yet".
    let blame = committed_blame
        .blame_buffer(content.as_bytes())
        .map_err(|e| format!("git2 blame_buffer: {e}"))?;

    // One commit lookup per distinct OID, not per line.
    let mut meta: std::collections::HashMap<git2::Oid, (String, String, String)> =
        std::collections::HashMap::new();

    let mut out: Vec<crate::types::BlameLine> = Vec::new();
    for hunk in blame.iter() {
        let oid = hunk.final_commit_id();
        let (author, author_date, summary) = if oid.is_zero() {
            // Matches the CLI porcelain convention for uncommitted lines:
            // `author Not Committed Yet`, current time, and a synthesized
            // summary of `Version of <path> from <path>` (verified against
            // real `git blame --porcelain` output on a dirty file).
            (
                "Not Committed Yet".to_string(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs().to_string())
                    .unwrap_or_default(),
                format!("Version of {path} from {path}"),
            )
        } else {
            meta.entry(oid)
                .or_insert_with(|| match repo.find_commit(oid) {
                    Ok(c) => (
                        c.author().name().unwrap_or("").to_string(),
                        // The CLI path stores git's raw `author-time` epoch
                        // seconds as a string (commands/read.rs). Match it
                        // exactly.
                        c.author().when().seconds().to_string(),
                        c.summary().unwrap_or("").to_string(),
                    ),
                    Err(_) => (String::new(), String::new(), String::new()),
                })
                .clone()
        };

        let hash_full = oid.to_string();
        let hash = hash_full[..7].to_string();
        let start = hunk.final_start_line();
        let orig_start = hunk.orig_start_line();
        for i in 0..hunk.lines_in_hunk() {
            if out.len() >= max_entries {
                return Ok(out);
            }
            let final_line = (start + i) as u32;
            // `orig_start_line()` is 0 for a zero-OID (uncommitted) hunk, so
            // `orig_start + i` would collide with real line numbers starting
            // at 0/1/2... The CLI porcelain output sets `orig_line ==
            // final_line` for uncommitted lines (verified against real
            // `git blame --porcelain` output); match that.
            let orig_line = if oid.is_zero() {
                final_line
            } else {
                (orig_start + i) as u32
            };
            out.push(crate::types::BlameLine {
                hash: hash.clone(),
                hash_full: hash_full.clone(),
                final_line,
                orig_line,
                author: author.clone(),
                author_date: author_date.clone(),
                summary: summary.clone(),
                content: file_lines
                    .get(final_line as usize - 1)
                    .map(|s| s.to_string())
                    .unwrap_or_default(),
            });
        }
    }
    Ok(out)
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn temp_repo(label: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("gw-lg2-{}-{}", label, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let run = |args: &[&str]| {
            Command::new("git").args(args).current_dir(&dir).output().unwrap();
        };
        run(&["init", "-q"]);
        run(&["config", "user.email", "t@example.com"]);
        run(&["config", "user.name", "T"]);
        std::fs::write(dir.join("a.txt"), "one\ntwo\nthree\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "-qm", "init"]);
        dir
    }

    fn cli_diff(dir: &std::path::Path, path: &str, staged: bool) -> String {
        let mut args = vec!["diff"];
        if staged { args.push("--cached"); }
        args.push("--");
        args.push(path);
        let out = Command::new("git").args(&args).current_dir(dir).output().unwrap();
        String::from_utf8_lossy(&out.stdout).to_string()
    }

    /// The libgit2 patch must parse into the same hunks the CLI patch does.
    #[test]
    fn unstaged_patch_matches_the_cli_hunks() {
        let dir = temp_repo("unstaged");
        std::fs::write(dir.join("a.txt"), "one\nTWO\nthree\n").unwrap();

        let lg2 = libgit2_diff_patch(dir.to_str().unwrap(), "a.txt", false).unwrap();
        let cli = cli_diff(&dir, "a.txt", false);

        let (lg2_hunks, _) = crate::git::parse::parse_diff_hunks(&lg2);
        let (cli_hunks, _) = crate::git::parse::parse_diff_hunks(&cli);
        assert_eq!(lg2_hunks.len(), cli_hunks.len());
        assert_eq!(lg2_hunks[0].old_start, cli_hunks[0].old_start);
        assert_eq!(lg2_hunks[0].new_start, cli_hunks[0].new_start);
        assert_eq!(
            lg2_hunks[0].lines.iter().map(|l| (l.r#type.clone(), l.content.clone())).collect::<Vec<_>>(),
            cli_hunks[0].lines.iter().map(|l| (l.r#type.clone(), l.content.clone())).collect::<Vec<_>>(),
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn staged_patch_matches_the_cli_hunks() {
        let dir = temp_repo("staged");
        std::fs::write(dir.join("a.txt"), "one\nTWO\nthree\n").unwrap();
        Command::new("git").args(["add", "a.txt"]).current_dir(&dir).output().unwrap();

        let lg2 = libgit2_diff_patch(dir.to_str().unwrap(), "a.txt", true).unwrap();
        let cli = cli_diff(&dir, "a.txt", true);
        let (lg2_hunks, _) = crate::git::parse::parse_diff_hunks(&lg2);
        let (cli_hunks, _) = crate::git::parse::parse_diff_hunks(&cli);
        assert_eq!(lg2_hunks.len(), cli_hunks.len());
        assert!(!lg2_hunks.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn clean_file_yields_an_empty_patch() {
        let dir = temp_repo("clean");
        let lg2 = libgit2_diff_patch(dir.to_str().unwrap(), "a.txt", false).unwrap();
        assert!(lg2.trim().is_empty(), "expected empty patch, got: {lg2}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn untracked_file_yields_an_empty_patch_like_the_cli() {
        let dir = temp_repo("untracked");
        std::fs::write(dir.join("new.txt"), "hello\n").unwrap();
        let lg2 = libgit2_diff_patch(dir.to_str().unwrap(), "new.txt", false).unwrap();
        assert!(lg2.trim().is_empty());
        assert!(cli_diff(&dir, "new.txt", false).trim().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Regression test: a path with an unmerged (conflicted) index entry must
    /// NOT be diffed via libgit2: `diff_index_to_workdir` silently emits no
    /// patch at all for such a path, while the CLI's `git diff` renders the
    /// real combined `diff --cc` conflict-marker diff. `git_diff` must fall
    /// back to the CLI here, so `libgit2_diff_patch` must return an `Err`.
    #[test]
    fn conflicted_path_falls_back_to_cli() {
        let dir = temp_repo("conflict");
        let run = |args: &[&str]| {
            Command::new("git").args(args).current_dir(&dir).output().unwrap()
        };
        let base_branch_out = Command::new("git")
            .args(["symbolic-ref", "--short", "HEAD"])
            .current_dir(&dir)
            .output()
            .unwrap();
        let base_branch = String::from_utf8_lossy(&base_branch_out.stdout).trim().to_string();
        run(&["checkout", "-qb", "feat"]);
        std::fs::write(dir.join("a.txt"), "one\ntwo\nFEAT\n").unwrap();
        run(&["commit", "-qam", "feat change"]);
        run(&["checkout", "-q", &base_branch]);
        std::fs::write(dir.join("a.txt"), "one\ntwo\nMAIN\n").unwrap();
        run(&["commit", "-qam", "main change"]);
        // Expected to exit non-zero (conflict), that's the point.
        let _ = run(&["merge", "feat", "-q", "--no-edit"]);

        let cli = cli_diff(&dir, "a.txt", false);
        assert!(
            cli.contains("<<<<<<<"),
            "fixture must actually be conflicted, got: {cli}"
        );

        let result = libgit2_diff_patch(dir.to_str().unwrap(), "a.txt", false);
        assert!(
            result.is_err(),
            "expected an Err (triggering the CLI fallback) for a conflicted path, got: {result:?}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Regression test for the dirty-file blame misattribution bug: without
    /// re-blaming against the actual working-tree buffer, `blame_file` only
    /// knows about the committed content, so uncommitted lines either get
    /// mapped to the wrong commit (line-number drift) or are silently
    /// dropped. The CLI's `git blame --porcelain` marks such lines with the
    /// zero OID and `author = "Not Committed Yet"`; libgit2_blame must match.
    #[test]
    fn dirty_lines_are_attributed_to_not_committed_yet() {
        let dir = temp_repo("dirty");
        // Prepend a new line and edit an existing one, without committing.
        std::fs::write(dir.join("a.txt"), "ZERO\none\ntwo\nTHREE\n").unwrap();

        let lg2 = libgit2_blame(dir.to_str().unwrap(), "a.txt", 10_000).unwrap();
        assert_eq!(lg2.len(), 4, "expected all 4 working-tree lines, got: {lg2:?}");

        assert_eq!(lg2[0].content, "ZERO");
        assert!(
            lg2[0].hash_full.chars().all(|c| c == '0'),
            "uncommitted line must carry the zero OID, got {}",
            lg2[0].hash_full
        );
        assert_eq!(lg2[0].author, "Not Committed Yet");
        assert_eq!(lg2[0].summary, "Version of a.txt from a.txt");
        // orig_start_line() is 0 for a zero-OID hunk; must not collide with
        // real line numbers, so it must mirror final_line instead.
        assert_eq!(lg2[0].orig_line, lg2[0].final_line);

        // Untouched lines still resolve to the real commit.
        assert_eq!(lg2[1].content, "one");
        assert!(!lg2[1].hash_full.chars().all(|c| c == '0'));
        assert_ne!(lg2[1].author, "Not Committed Yet");

        assert_eq!(lg2[3].content, "THREE");
        assert!(
            lg2[3].hash_full.chars().all(|c| c == '0'),
            "edited line must carry the zero OID, got {}",
            lg2[3].hash_full
        );
        assert_eq!(lg2[3].author, "Not Committed Yet");
        assert_eq!(lg2[3].summary, "Version of a.txt from a.txt");
        assert_eq!(lg2[3].orig_line, lg2[3].final_line);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Go/no-go gate for the blame fast path: libgit2's attribution must match
    /// `git blame --porcelain --diff-algorithm=histogram` line for line on a
    /// multi-commit file. If this fails, blame stays on the CLI (see the plan's
    /// Open Decisions).
    #[test]
    fn blame_attribution_matches_the_cli_on_a_multi_commit_file() {
        use std::process::Command;
        let dir = temp_repo("blame");
        let run = |args: &[&str]| {
            Command::new("git").args(args).current_dir(&dir).output().unwrap();
        };
        std::fs::write(dir.join("a.txt"), "one\ntwo\nTHREE\n").unwrap();
        run(&["config", "user.name", "Second"]);
        run(&["commit", "-qam", "change three"]);
        std::fs::write(dir.join("a.txt"), "one\nTWO\nTHREE\nfour\n").unwrap();
        run(&["config", "user.name", "Third"]);
        run(&["commit", "-qam", "change two, add four"]);

        let lg2 = libgit2_blame(dir.to_str().unwrap(), "a.txt", 10_000).unwrap();

        let out = Command::new("git")
            .args(["blame", "--porcelain", "--diff-algorithm=histogram", "--", "a.txt"])
            .current_dir(&dir)
            .output()
            .unwrap();
        let raw = String::from_utf8_lossy(&out.stdout);
        let cli_shas: Vec<String> = raw
            .lines()
            .filter_map(|l| {
                let parts: Vec<&str> = l.split_whitespace().collect();
                if parts.len() >= 3 && parts[0].len() == 40 { Some(parts[0].to_string()) } else { None }
            })
            .collect();

        assert_eq!(lg2.len(), cli_shas.len(), "line count differs");
        for (i, line) in lg2.iter().enumerate() {
            assert_eq!(line.hash_full, cli_shas[i], "attribution differs at line {}", i + 1);
        }
        assert_eq!(lg2[0].content, "one");
        assert_eq!(lg2[3].content, "four");
        assert_eq!(lg2[0].hash.len(), 7);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Go/no-go gate, moved-block variant (adversarial review of PR #178,
    /// Priority 5): the sequential-edit fixture above doesn't exercise a
    /// reordered block. This one reorders a block *and* edits another line in
    /// the very same commit, with duplicate `X` separator lines around each
    /// block — confirmed (via `git diff --diff-algorithm=myers` vs
    /// `=histogram` on this exact content) to actually produce differently
    /// shaped hunks between the two algorithms, unlike a plain block move
    /// with no nearby duplicate lines. If libgit2's default diffing (Myers,
    /// no `histogram`/`patience` flag — `xdiff`'s default) disagreed with the
    /// CLI's histogram output on *attribution*, this is where it would show,
    /// even though the two algorithms already disagree on hunk shape here.
    #[test]
    fn blame_attribution_matches_the_cli_on_a_moved_block() {
        use std::process::Command;
        let dir = temp_repo("blame-moved-block");
        let run = |args: &[&str]| {
            Command::new("git").args(args).current_dir(&dir).output().unwrap();
        };

        std::fs::write(
            dir.join("a.txt"),
            "X\nA1\nA2\nX\nB1\nB2\nX\nC1\nC2\nX\n",
        )
        .unwrap();
        run(&["config", "user.name", "Blocks"]);
        run(&["commit", "-qam", "three blocks: A B C"]);

        // Move block C to the front AND edit A2 in the same commit — this
        // combination is what makes Myers and histogram pick genuinely
        // different hunk boundaries (verified by hand against plain `git
        // diff` on this content), unlike an isolated pure reorder.
        std::fs::write(
            dir.join("a.txt"),
            "X\nC1\nC2\nX\nAA2\nX\nB1\nB2\nX\n",
        )
        .unwrap();
        run(&["config", "user.name", "Mover"]);
        run(&["commit", "-qam", "move block C to the front, edit A2 -> AA2"]);

        let lg2 = libgit2_blame(dir.to_str().unwrap(), "a.txt", 10_000).unwrap();

        let out = Command::new("git")
            .args(["blame", "--porcelain", "--diff-algorithm=histogram", "--", "a.txt"])
            .current_dir(&dir)
            .output()
            .unwrap();
        let raw = String::from_utf8_lossy(&out.stdout);
        let cli_shas: Vec<String> = raw
            .lines()
            .filter_map(|l| {
                let parts: Vec<&str> = l.split_whitespace().collect();
                if parts.len() >= 3 && parts[0].len() == 40 { Some(parts[0].to_string()) } else { None }
            })
            .collect();

        assert_eq!(lg2.len(), cli_shas.len(), "line count differs");
        let mismatches: Vec<usize> = (0..lg2.len())
            .filter(|&i| lg2[i].hash_full != cli_shas[i])
            .collect();
        assert!(
            mismatches.is_empty(),
            "attribution differs at lines {mismatches:?} (0-indexed); \
             lg2={:?} cli={:?}",
            lg2.iter().map(|l| &l.hash).collect::<Vec<_>>(),
            cli_shas.iter().map(|s| &s[..7]).collect::<Vec<_>>(),
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Security regression: `libgit2_blame` must route its working-tree read
    /// through `safe_repo_path()` like every other filesystem call site. A
    /// symlink committed inside the tracked tree that points outside the
    /// workdir must not be followed to read arbitrary files on disk.
    #[test]
    fn blame_on_a_symlink_escaping_the_workdir_is_rejected() {
        use std::process::Command;
        let dir = temp_repo("blame-symlink-escape");
        let run = |args: &[&str]| {
            Command::new("git").args(args).current_dir(&dir).output().unwrap();
        };

        let secret_dir = std::env::temp_dir().join(format!(
            "gw-lg2-blame-secret-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&secret_dir);
        std::fs::create_dir_all(&secret_dir).unwrap();
        let secret_file = secret_dir.join("secret.txt");
        std::fs::write(&secret_file, "top-secret-contents\n").unwrap();

        #[cfg(unix)]
        std::os::unix::fs::symlink(&secret_file, dir.join("link.txt")).unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_file(&secret_file, dir.join("link.txt")).unwrap();

        run(&["add", "link.txt"]);
        run(&["commit", "-qm", "add escaping symlink"]);

        let result = libgit2_blame(dir.to_str().unwrap(), "link.txt", 10_000);
        assert!(
            result.is_err(),
            "expected an Err for a symlink escaping the workdir, got: {result:?}"
        );

        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&secret_dir);
    }
}

//! Scratch worktree commands (v2.20.0).
//!
//! A "scratch worktree" is a temporary, isolated git worktree
//! (`gitwand-scratch-<timestamp>`) created as a sibling of the repo so the user
//! can resolve conflicts without touching the active checkout, then bring the
//! result back in one click — with automatic cleanup on merge-back or discard.
//!
//! Builds on the existing worktree plumbing in `commands::ops`
//! (`git_worktree_add` / `git_worktree_remove` / `git_worktree_prune`).
//!
//! Security: every user-supplied path MUST go through `safe_repo_path()` and
//! every git invocation MUST pass discrete `.args([...])` — never string
//! interpolation (see AGENTS.md).

use crate::git::{git_cmd, repo_lock, safe_repo_path};
use crate::types::ScratchWorktree;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Run a git command in `dir`, returning trimmed stdout on success or a
/// formatted error (stderr) on failure. All args are passed discretely — never
/// interpolated — per AGENTS.md.
fn git_in(dir: &Path, args: &[&str]) -> Result<String, String> {
    let output = git_cmd()
        .args(args)
        .current_dir(dir)
        .output()
        .map_err(|e| format!("git {:?} failed to spawn: {}", args, e))?;
    if !output.status.success() {
        return Err(format!(
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Validate a `cwd` string and return its canonical absolute path. We reuse
/// `safe_repo_path` (with `"."` as the relative component) so the same
/// canonicalisation / traversal guard that protects file ops also protects the
/// repo root we operate on here.
fn canonical_cwd(cwd: &str) -> Result<PathBuf, String> {
    safe_repo_path(cwd, ".")
}

/// Validate that `scratch_path` is a real, on-disk scratch worktree belonging to
/// THIS repo, defending against path traversal / arbitrary-path removal.
///
/// Rather than inlining a bespoke `..` check, we cross-check the caller-supplied
/// path against the authoritative worktree registration list reported by git for
/// `cwd`. A path is only accepted if (a) it canonicalises, (b) git lists it as a
/// worktree of this repo, and (c) its basename matches the `gitwand-scratch-*`
/// naming convention. This makes it impossible to remove a worktree that does
/// not belong to the repo or that GitWand did not create.
fn validate_scratch_path(cwd: &Path, scratch_path: &str) -> Result<PathBuf, String> {
    if scratch_path.trim().is_empty() {
        return Err("scratch_path must not be empty".to_string());
    }
    let candidate = Path::new(scratch_path)
        .canonicalize()
        .map_err(|e| format!("scratch_path does not resolve: {}", e))?;

    // Basename must follow the gitwand-scratch-* convention we create.
    let name = candidate
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("scratch_path has no basename")?;
    if !name.starts_with("gitwand-scratch-") {
        return Err(format!(
            "refusing to operate on a non-scratch worktree: {}",
            name
        ));
    }

    // Must be registered as a worktree of this repo (porcelain output lists the
    // absolute path on each `worktree ` line).
    let list = git_in(cwd, &["worktree", "list", "--porcelain"])?;
    let registered = list
        .lines()
        .filter_map(|l| l.strip_prefix("worktree "))
        .any(|p| {
            Path::new(p)
                .canonicalize()
                .map(|c| c == candidate)
                .unwrap_or(false)
        });
    if !registered {
        return Err(format!(
            "scratch_path is not a registered worktree of this repo: {}",
            candidate.display()
        ));
    }

    Ok(candidate)
}

/// Turn a user-supplied AI-task name into a git-ref-safe slug. Lowercases,
/// replaces every run of non-alphanumeric characters with a single `-`, and
/// trims leading/trailing dashes. Returns `None` when nothing usable remains
/// (e.g. an empty or all-punctuation name) so the caller can fall back to the
/// timestamp. Capped at 48 chars to keep directory/branch names sane.
fn slugify_task_name(name: &str) -> Option<String> {
    let mut slug = String::new();
    let mut prev_dash = false;
    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch.to_ascii_lowercase());
            prev_dash = false;
        } else if !prev_dash && !slug.is_empty() {
            slug.push('-');
            prev_dash = true;
        }
    }
    let slug = slug.trim_end_matches('-');
    let slug: String = slug.chars().take(48).collect();
    let slug = slug.trim_end_matches('-').to_string();
    if slug.is_empty() {
        None
    } else {
        Some(slug)
    }
}

/// Create a sibling worktree based on `source_branch` (defaults to the current
/// HEAD when `None`). The branch/dir is named `gitwand-scratch-<slug>` from the
/// supplied `name`, falling back to `gitwand-scratch-<timestamp>` when no usable
/// name is given. The `gitwand-scratch-` prefix is always preserved so the
/// validation + cleanup paths keep recognising it. Does NOT touch the active
/// checkout. Returns the created scratch descriptor.
#[tauri::command]
pub(crate) async fn scratch_worktree_create(
    cwd: String,
    source_branch: Option<String>,
    name: Option<String>,
) -> Result<ScratchWorktree, String> {
    scratch_worktree_create_impl(cwd, source_branch, name)
}

/// Synchronous core of `scratch_worktree_create` (git work is blocking; the
/// async command is a thin shim so tests can call this without a runtime).
fn scratch_worktree_create_impl(
    cwd: String,
    source_branch: Option<String>,
    name: Option<String>,
) -> Result<ScratchWorktree, String> {
    let repo_root = canonical_cwd(&cwd)?;

    // Resolve the base ref: explicit source_branch, or the current HEAD symbolic
    // ref name (falling back to the HEAD sha if detached).
    let base_ref = match source_branch {
        Some(b) if !b.trim().is_empty() => b,
        _ => match git_in(&repo_root, &["symbolic-ref", "--short", "-q", "HEAD"]) {
            Ok(b) if !b.is_empty() => b,
            _ => git_in(&repo_root, &["rev-parse", "HEAD"])?,
        },
    };

    // SECURITY: `base_ref` may come straight from the frontend (`source_branch`).
    // Before passing it to `git worktree add`, verify it actually resolves to a
    // commit. This rejects a leading-dash value (e.g. "--no-checkout", "--detach")
    // — which git would otherwise treat as a flag — as `fatal: invalid reference`.
    // The trailing `--` separator below is a second, defence-in-depth guard.
    if git_in(
        &repo_root,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("{}^{{commit}}", base_ref),
        ],
    )
    .is_err()
    {
        return Err(format!(
            "source ref does not resolve to a commit: {}",
            base_ref
        ));
    }

    // Timestamp generated Rust-side so the frontend never has to.
    let created_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| format!("clock error: {}", e))?
        .as_secs();

    // Sibling directory of the repo root (same parent dir as the "New task"
    // worktree flow in commands::ops::git_worktree_add).
    let parent = repo_root
        .parent()
        .ok_or("repo root has no parent directory")?;

    // Prefer a slug from the user-supplied name; otherwise fall back to the
    // timestamp. The `gitwand-scratch-` prefix is mandatory (validation +
    // cleanup match on it). If the slugged directory already exists, append the
    // timestamp to keep the worktree path unique without surprising the user.
    let slug = name.as_deref().and_then(slugify_task_name);
    let (scratch_branch, scratch_dir) = match slug {
        Some(s) => {
            let preferred = format!("gitwand-scratch-{}", s);
            let preferred_dir = parent.join(&preferred);
            if preferred_dir.exists() {
                let unique = format!("gitwand-scratch-{}-{}", s, created_at);
                let unique_dir = parent.join(&unique);
                (unique, unique_dir)
            } else {
                (preferred, preferred_dir)
            }
        }
        None => {
            let b = format!("gitwand-scratch-{}", created_at);
            let d = parent.join(&b);
            (b, d)
        }
    };
    let scratch_path = scratch_dir.to_string_lossy().to_string();

    // Reuse the exact git-worktree add invocation pattern from
    // commands::ops::git_worktree_add: `worktree add -b <new> <path> <base>`.
    // This creates a NEW branch in a NEW directory based on `base_ref` without
    // touching the active checkout.
    let output = git_cmd()
        .arg("worktree")
        .arg("add")
        .arg("-b")
        .arg(&scratch_branch)
        .arg(&scratch_path)
        // `--` separates the commit-ish from the option list so a leading-dash
        // `base_ref` can never be parsed as a flag (argument-injection guard).
        .arg("--")
        .arg(&base_ref)
        .current_dir(&repo_root)
        .output()
        .map_err(|e| format!("Failed to add scratch worktree: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "git worktree add failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }

    Ok(ScratchWorktree {
        path: scratch_path,
        branch: scratch_branch,
        source_branch: base_ref,
        created_at,
    })
}

/// Bring the task's changes from the scratch worktree back into the main
/// checkout, then remove + prune the scratch.
///
/// Mechanism: the scratch worktree shares the repo's object database. We commit
/// the outstanding work in the scratch (so its tree is a real object in the
/// shared DB), then — without switching the main checkout's branch — check out
/// only the paths that differ between the main checkout's `HEAD` and the
/// scratch branch, and remove the ones the task deleted. The result lands as
/// uncommitted (staged) changes for the user to review.
///
/// Until v3.12.x this overlaid the whole scratch tree (`checkout <branch> -- .`
/// after `git rm`-ing everything absent from it). Once `main` had moved, that
/// reverted what `main` changed, deleted what it added and overwrote
/// uncommitted edits. Every guard below runs before the main checkout is
/// touched, so a refusal changes nothing there:
///
/// - no unmerged index entries (an in-progress merge/rebase);
/// - the main checkout's `HEAD` is in the scratch branch's history, so the
///   `HEAD..scratch` diff is exactly the task's work and nothing of `main`'s;
/// - no uncommitted edit or untracked file on a path the task changes.
///
/// A Time Machine snapshot (`merge-back`) is taken right before applying,
/// unless `snapshots_enabled` is `Some(false)`.
#[tauri::command]
pub(crate) async fn scratch_worktree_merge_back(
    cwd: String,
    scratch_path: String,
    snapshots_enabled: Option<bool>,
) -> Result<(), String> {
    let _repo = repo_lock::write(&cwd);
    scratch_worktree_merge_back_impl(cwd, scratch_path, snapshots_enabled)
}

/// Run a git command in `dir` and return stdout untouched: `-z` output must
/// not be trimmed (a porcelain status line starts with a space).
fn git_raw(dir: &Path, args: &[&str]) -> Result<String, String> {
    let output = git_cmd()
        .args(args)
        .current_dir(dir)
        .output()
        .map_err(|e| format!("git {:?} failed to spawn: {}", args, e))?;
    if !output.status.success() {
        return Err(format!(
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Run `git <command> [opts] -- <paths>` in `dir`, in chunks so a large change
/// set stays under the OS argument limit. `--literal-pathspecs` keeps a path
/// containing `*` or `:` from being read as a glob or pathspec magic.
fn git_on_paths(dir: &Path, command: &[&str], paths: &[&str]) -> Result<(), String> {
    for chunk in paths.chunks(200) {
        let mut args = vec!["--literal-pathspecs"];
        args.extend_from_slice(command);
        args.push("--");
        args.extend_from_slice(chunk);
        git_in(dir, &args)?;
    }
    Ok(())
}

fn scratch_worktree_merge_back_impl(
    cwd: String,
    scratch_path: String,
    snapshots_enabled: Option<bool>,
) -> Result<(), String> {
    let repo_root = canonical_cwd(&cwd)?;
    let scratch = validate_scratch_path(&repo_root, &scratch_path)?;

    // `XY path` entries of the main checkout, untracked files included.
    let main_status = git_raw(
        &repo_root,
        &[
            "status",
            "--porcelain",
            "-z",
            "--no-renames",
            "--untracked-files=all",
        ],
    )?;
    let main_entries: Vec<(&str, &str)> = main_status
        .split('\0')
        .filter(|e| e.len() > 3)
        .map(|e| (&e[..2], &e[3..]))
        .collect();

    // GUARD: refuse if the main checkout has unmerged (conflicting) entries.
    const CONFLICT_CODES: &[&str] = &["UU", "AA", "DD", "AU", "UA", "DU", "UD"];
    if main_entries
        .iter()
        .any(|(xy, _)| CONFLICT_CODES.contains(xy))
    {
        return Err(
            "the main checkout has unresolved conflicting changes; resolve or abort them before merging back the scratch worktree"
                .to_string(),
        );
    }

    let scratch_branch = git_in(&scratch, &["symbolic-ref", "--short", "HEAD"])?;

    // GUARD: the main checkout's HEAD must be in the task's history. Otherwise
    // `main` moved since the task was created (or the task started from another
    // branch), and applying the scratch tree would undo `main`'s side.
    if git_in(
        &repo_root,
        &["merge-base", "--is-ancestor", "HEAD", &scratch_branch],
    )
    .is_err()
    {
        return Err(format!(
            "the main checkout moved since {b} was created (or {b} started from another branch); nothing was changed. Merge or rebase {b} instead",
            b = scratch_branch
        ));
    }

    // Commit any outstanding work in the scratch so its tree is a durable
    // object in the shared DB. If there is nothing to commit, that's fine.
    git_in(&scratch, &["add", "-A"])?;
    let scratch_status = git_in(&scratch, &["status", "--porcelain"])?;
    if !scratch_status.trim().is_empty() {
        git_in(
            &scratch,
            &["commit", "-q", "-m", "gitwand: scratch resolution"],
        )?;
    }

    // The task's change set, as `STATUS\0path\0` pairs.
    let diff = git_raw(
        &repo_root,
        &[
            "diff",
            "--name-status",
            "-z",
            "--no-renames",
            "HEAD",
            &scratch_branch,
        ],
    )?;
    let mut fields = diff.split('\0').filter(|f| !f.is_empty());
    let mut deleted: Vec<&str> = Vec::new();
    let mut updated: Vec<&str> = Vec::new();
    while let (Some(status), Some(path)) = (fields.next(), fields.next()) {
        if status == "D" {
            deleted.push(path);
        } else {
            updated.push(path);
        }
    }

    // GUARD: never overwrite an uncommitted edit or an untracked file.
    let touched: HashSet<&str> = deleted.iter().chain(updated.iter()).copied().collect();
    let mut clobbered: Vec<&str> = main_entries
        .iter()
        .map(|(_, p)| *p)
        .filter(|p| touched.contains(p))
        .collect();
    if !clobbered.is_empty() {
        clobbered.sort_unstable();
        return Err(format!(
            "the main checkout has uncommitted changes on files {} also changes; nothing was changed. Commit or stash them first: {}",
            scratch_branch,
            clobbered.join(", ")
        ));
    }

    let root = repo_root.to_string_lossy();
    crate::commands::ops::snapshot_before(
        &root,
        snapshots_enabled,
        "merge-back",
        &format!("Merge back {}", scratch_branch),
    );

    if !deleted.is_empty() {
        git_on_paths(&repo_root, &["rm", "-q", "--ignore-unmatch"], &deleted)?;
    }
    if !updated.is_empty() {
        git_on_paths(&repo_root, &["checkout", &scratch_branch], &updated)?;
    }

    // Cleanup: remove the scratch worktree and prune any dangling registration.
    let _ = git_in(
        &repo_root,
        &["worktree", "remove", "--force", &scratch.to_string_lossy()],
    )?;
    // Best-effort delete of the now-unused scratch branch, then prune.
    let _ = git_in(&repo_root, &["branch", "-D", &scratch_branch]);
    git_in(&repo_root, &["worktree", "prune"])?;

    Ok(())
}

/// Abandon the scratch worktree: `git worktree remove --force` + `git worktree
/// prune`. Leaves no dangling worktree registration.
#[tauri::command]
pub(crate) async fn scratch_worktree_discard(
    cwd: String,
    scratch_path: String,
) -> Result<(), String> {
    scratch_worktree_discard_impl(cwd, scratch_path)
}

fn scratch_worktree_discard_impl(cwd: String, scratch_path: String) -> Result<(), String> {
    let repo_root = canonical_cwd(&cwd)?;
    let scratch = validate_scratch_path(&repo_root, &scratch_path)?;

    // Capture the branch name before removal so we can delete it afterwards.
    let scratch_branch = git_in(&scratch, &["symbolic-ref", "--short", "-q", "HEAD"]).ok();

    git_in(
        &repo_root,
        &["worktree", "remove", "--force", &scratch.to_string_lossy()],
    )?;
    if let Some(branch) = scratch_branch {
        if branch.starts_with("gitwand-scratch-") {
            let _ = git_in(&repo_root, &["branch", "-D", &branch]);
        }
    }
    git_in(&repo_root, &["worktree", "prune"])?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::git_binary;
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
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            // Nest under a dedicated parent dir so sibling scratch worktrees are
            // created inside our temp sandbox, not the real system temp root.
            let parent =
                std::env::temp_dir().join(format!("gitwand-scr-test-{}-{}-{}", pid, n, nanos));
            std::fs::create_dir_all(&parent).unwrap();
            let dir = parent.join("repo");
            std::fs::create_dir_all(&dir).unwrap();
            let repo = TempRepo { path: dir };
            repo.git(&["init", "-q", "-b", "main"]);
            repo.git(&["config", "user.name", "Test"]);
            repo.git(&["config", "user.email", "test@example.com"]);
            repo.git(&["config", "commit.gpgsign", "false"]);
            repo
        }

        fn cwd(&self) -> String {
            self.path.to_string_lossy().to_string()
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

        fn worktree_list(&self) -> String {
            let out = self.git(&["worktree", "list", "--porcelain"]);
            String::from_utf8_lossy(&out.stdout).to_string()
        }
    }

    #[test]
    fn create_then_merge_back_brings_resolution_and_cleans_up() {
        let repo = TempRepo::new();
        repo.write("file.txt", "original\n");
        repo.write("stale.txt", "to be deleted\n");
        repo.commit_all("base");

        // Create the scratch worktree off the current HEAD.
        let scratch =
            scratch_worktree_create_impl(repo.cwd(), None, None).expect("create should succeed");

        assert!(scratch.branch.starts_with("gitwand-scratch-"));
        assert_eq!(scratch.source_branch, "main");
        assert!(Path::new(&scratch.path).exists(), "scratch dir must exist");
        // Sibling of the repo, not inside it.
        assert_ne!(scratch.path, repo.cwd());

        // The main checkout is untouched.
        assert_eq!(repo.read("file.txt"), "original\n");

        // Write a "resolution" inside the scratch worktree: edit a file, add a
        // new file, and DELETE a tracked file — the deletion must propagate.
        let scratch_dir = PathBuf::from(&scratch.path);
        std::fs::write(scratch_dir.join("file.txt"), "resolved\n").unwrap();
        std::fs::write(scratch_dir.join("new.txt"), "added\n").unwrap();
        std::fs::remove_file(scratch_dir.join("stale.txt")).unwrap();

        // Merge back.
        scratch_worktree_merge_back_impl(repo.cwd(), scratch.path.clone(), None)
            .expect("merge_back should succeed");

        // The main checkout received the resolution.
        assert_eq!(repo.read("file.txt"), "resolved\n");
        assert_eq!(repo.read("new.txt"), "added\n");
        // The deletion was transferred: the stale file is gone from the main
        // checkout (working tree) — merge-back is a faithful tree transfer.
        assert!(
            !repo.path.join("stale.txt").exists(),
            "file deleted in the scratch must be removed from the main checkout"
        );

        // The scratch directory is gone.
        assert!(
            !Path::new(&scratch.path).exists(),
            "scratch dir must be removed"
        );

        // No dangling worktree registration remains.
        // The scratch worktree must no longer be registered. (We check branch
        // refs rather than substring-matching the porcelain paths, because the
        // test's own temp parent dir is named "gitwand-scratch-test-…".)
        let list = repo.worktree_list();
        assert!(
            !list
                .lines()
                .any(|l| l.starts_with("branch refs/heads/gitwand-scratch-")),
            "no scratch worktree should remain registered, got: {}",
            list
        );
    }

    #[test]
    fn merge_back_refused_when_main_has_conflict() {
        let repo = TempRepo::new();
        repo.write("file.txt", "base\n");
        repo.commit_all("base");

        // Build a real unmerged index in the main checkout via a conflicting merge.
        repo.git(&["checkout", "-q", "-b", "other"]);
        repo.write("file.txt", "other-change\n");
        repo.commit_all("other");
        repo.git(&["checkout", "-q", "main"]);
        repo.write("file.txt", "main-change\n");
        repo.commit_all("main");
        // This merge conflicts and leaves unmerged entries (non-zero exit expected).
        let _ = Command::new(git_binary())
            .args(["merge", "other"])
            .current_dir(&repo.path)
            .output()
            .unwrap();

        let scratch =
            scratch_worktree_create_impl(repo.cwd(), None, None).expect("create should succeed");

        let err = scratch_worktree_merge_back_impl(repo.cwd(), scratch.path.clone(), None)
            .expect_err("merge_back must be refused on a conflicted main checkout");
        assert!(
            err.contains("conflicting"),
            "error should mention the conflicting state, got: {}",
            err
        );

        // Clean up the scratch we created.
        let _ = scratch_worktree_discard_impl(repo.cwd(), scratch.path);
    }

    #[test]
    fn create_then_discard_leaves_clean_state() {
        let repo = TempRepo::new();
        repo.write("file.txt", "original\n");
        repo.commit_all("base");

        let scratch =
            scratch_worktree_create_impl(repo.cwd(), None, None).expect("create should succeed");
        assert!(Path::new(&scratch.path).exists());

        scratch_worktree_discard_impl(repo.cwd(), scratch.path.clone())
            .expect("discard should succeed");

        // Directory removed, no dangling registration.
        assert!(!Path::new(&scratch.path).exists());
        // The scratch worktree must no longer be registered. (We check branch
        // refs rather than substring-matching the porcelain paths, because the
        // test's own temp parent dir is named "gitwand-scratch-test-…".)
        let list = repo.worktree_list();
        assert!(
            !list
                .lines()
                .any(|l| l.starts_with("branch refs/heads/gitwand-scratch-")),
            "no scratch worktree should remain registered, got: {}",
            list
        );
        // Main checkout untouched.
        assert_eq!(repo.read("file.txt"), "original\n");
    }

    #[test]
    fn slugify_produces_ref_safe_names_or_none() {
        assert_eq!(
            slugify_task_name("Fix login bug"),
            Some("fix-login-bug".to_string())
        );
        assert_eq!(
            slugify_task_name("  Refactor!! API  "),
            Some("refactor-api".to_string())
        );
        assert_eq!(
            slugify_task_name("feature/foo@bar"),
            Some("feature-foo-bar".to_string())
        );
        // All-punctuation / empty → no usable slug.
        assert_eq!(slugify_task_name("   "), None);
        assert_eq!(slugify_task_name("!!!"), None);
        assert_eq!(slugify_task_name(""), None);
        // Length cap, with no trailing dash left behind.
        let long = "a".repeat(80);
        let slug = slugify_task_name(&long).unwrap();
        assert_eq!(slug.len(), 48);
        assert!(!slug.ends_with('-'));
    }

    #[test]
    fn create_with_name_uses_slug_in_branch_and_dir() {
        let repo = TempRepo::new();
        repo.write("file.txt", "original\n");
        repo.commit_all("base");

        let scratch =
            scratch_worktree_create_impl(repo.cwd(), None, Some("Fix Login Bug".to_string()))
                .expect("create should succeed");

        assert_eq!(scratch.branch, "gitwand-scratch-fix-login-bug");
        let base = Path::new(&scratch.path)
            .file_name()
            .unwrap()
            .to_str()
            .unwrap();
        assert_eq!(base, "gitwand-scratch-fix-login-bug");

        // Still recognised + removable by the validated cleanup path.
        scratch_worktree_discard_impl(repo.cwd(), scratch.path.clone())
            .expect("discard should succeed");
    }

    #[test]
    fn create_with_colliding_name_appends_timestamp() {
        let repo = TempRepo::new();
        repo.write("file.txt", "original\n");
        repo.commit_all("base");

        let first = scratch_worktree_create_impl(repo.cwd(), None, Some("dupe".to_string()))
            .expect("first create");
        assert_eq!(first.branch, "gitwand-scratch-dupe");

        let second = scratch_worktree_create_impl(repo.cwd(), None, Some("dupe".to_string()))
            .expect("second create");
        assert_ne!(second.branch, first.branch);
        assert!(second.branch.starts_with("gitwand-scratch-dupe-"));

        let _ = scratch_worktree_discard_impl(repo.cwd(), first.path);
        let _ = scratch_worktree_discard_impl(repo.cwd(), second.path);
    }

    #[test]
    fn discard_rejects_non_scratch_and_traversal_paths() {
        let repo = TempRepo::new();
        repo.write("file.txt", "original\n");
        repo.commit_all("base");

        // A path that is not a registered worktree must be rejected.
        let bogus = repo.path.parent().unwrap().to_string_lossy().to_string();
        assert!(scratch_worktree_discard_impl(repo.cwd(), bogus).is_err());

        // The repo root itself is not a gitwand-scratch worktree.
        assert!(scratch_worktree_discard_impl(repo.cwd(), repo.cwd()).is_err());
    }

    /// Write `content` to `rel` inside the scratch worktree.
    fn write_in(scratch: &ScratchWorktree, rel: &str, content: &str) {
        std::fs::write(Path::new(&scratch.path).join(rel), content).unwrap();
    }

    #[test]
    fn merge_back_refused_when_main_moved_since_the_task_was_created() {
        // The 2026-10-08 audit reproduction: fork, advance main, commit in the
        // scratch, merge back. The old overlay reverted `shared.txt` and deleted
        // `main-only.txt`.
        let repo = TempRepo::new();
        repo.write("shared.txt", "v1\n");
        repo.write("task.txt", "v1\n");
        repo.commit_all("base");

        let scratch = scratch_worktree_create_impl(repo.cwd(), None, None).expect("create");

        repo.write("shared.txt", "v2 from main\n");
        repo.write("main-only.txt", "added on main\n");
        repo.commit_all("main moves on");

        write_in(&scratch, "task.txt", "agent edit\n");
        let scratch_dir = PathBuf::from(&scratch.path);
        Command::new(git_binary())
            .args(["commit", "-qam", "agent"])
            .current_dir(&scratch_dir)
            .output()
            .unwrap();

        let err = scratch_worktree_merge_back_impl(repo.cwd(), scratch.path.clone(), Some(false))
            .expect_err("merge-back must refuse once main has moved");
        assert!(
            err.contains(&scratch.branch),
            "error should name the task branch: {}",
            err
        );

        // Nothing was touched: main keeps its commit, the task keeps its work.
        assert_eq!(repo.read("shared.txt"), "v2 from main\n");
        assert_eq!(repo.read("main-only.txt"), "added on main\n");
        assert_eq!(repo.read("task.txt"), "v1\n");
        assert!(
            scratch_dir.join("task.txt").exists(),
            "scratch must be kept"
        );

        let _ = scratch_worktree_discard_impl(repo.cwd(), scratch.path);
    }

    #[test]
    fn merge_back_keeps_unrelated_uncommitted_edits() {
        let repo = TempRepo::new();
        repo.write("mine.txt", "v1\n");
        repo.write("task.txt", "v1\n");
        repo.commit_all("base");

        let scratch = scratch_worktree_create_impl(repo.cwd(), None, None).expect("create");
        repo.write("mine.txt", "my unsaved edit\n");
        repo.write("notes.txt", "untracked, unrelated\n");
        write_in(&scratch, "task.txt", "agent edit\n");

        scratch_worktree_merge_back_impl(repo.cwd(), scratch.path.clone(), Some(false))
            .expect("merge-back should succeed");

        assert_eq!(repo.read("task.txt"), "agent edit\n");
        assert_eq!(repo.read("mine.txt"), "my unsaved edit\n");
        assert_eq!(repo.read("notes.txt"), "untracked, unrelated\n");
    }

    #[test]
    fn merge_back_refused_when_an_uncommitted_edit_overlaps() {
        let repo = TempRepo::new();
        repo.write("task.txt", "v1\n");
        repo.commit_all("base");

        let scratch = scratch_worktree_create_impl(repo.cwd(), None, None).expect("create");
        repo.write("task.txt", "my unsaved edit\n");
        write_in(&scratch, "task.txt", "agent edit\n");

        let err = scratch_worktree_merge_back_impl(repo.cwd(), scratch.path.clone(), Some(false))
            .expect_err("merge-back must not overwrite an uncommitted edit");
        assert!(
            err.contains("task.txt"),
            "error should list the path: {}",
            err
        );
        assert_eq!(repo.read("task.txt"), "my unsaved edit\n");

        let _ = scratch_worktree_discard_impl(repo.cwd(), scratch.path);
    }

    #[test]
    fn merge_back_refused_when_an_untracked_file_would_be_overwritten() {
        let repo = TempRepo::new();
        repo.write("base.txt", "v1\n");
        repo.commit_all("base");

        let scratch = scratch_worktree_create_impl(repo.cwd(), None, None).expect("create");
        repo.write("new.txt", "mine, untracked\n");
        write_in(&scratch, "new.txt", "agent's\n");

        let err = scratch_worktree_merge_back_impl(repo.cwd(), scratch.path.clone(), Some(false))
            .expect_err("merge-back must not overwrite an untracked file");
        assert!(
            err.contains("new.txt"),
            "error should list the path: {}",
            err
        );
        assert_eq!(repo.read("new.txt"), "mine, untracked\n");

        let _ = scratch_worktree_discard_impl(repo.cwd(), scratch.path);
    }

    #[test]
    fn merge_back_takes_a_snapshot_first_unless_disabled() {
        use crate::git::snapshot::list_snapshots_inner;

        let repo = TempRepo::new();
        repo.write("task.txt", "v1\n");
        repo.commit_all("base");

        let scratch = scratch_worktree_create_impl(repo.cwd(), None, None).expect("create");
        write_in(&scratch, "task.txt", "agent edit\n");
        scratch_worktree_merge_back_impl(repo.cwd(), scratch.path, None).expect("merge-back");

        let snaps = list_snapshots_inner(&repo.cwd()).unwrap();
        assert_eq!(snaps.len(), 1);
        assert_eq!(snaps[0].kind, "merge-back");

        repo.commit_all("take the task");
        let scratch = scratch_worktree_create_impl(repo.cwd(), None, None).expect("create");
        write_in(&scratch, "task.txt", "second edit\n");
        scratch_worktree_merge_back_impl(repo.cwd(), scratch.path, Some(false))
            .expect("merge-back");
        assert_eq!(list_snapshots_inner(&repo.cwd()).unwrap().len(), 1);
    }
}

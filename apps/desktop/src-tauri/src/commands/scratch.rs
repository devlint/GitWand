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
/// checkout, then (unless `keep_worktree`) remove + prune the scratch.
///
/// Mechanism: the scratch worktree shares the repo's object database. Once the
/// guards below pass, we commit the outstanding work in the scratch — which
/// also concludes a merge the user resolved there ("Resolve in scratch") — then
/// squash-merge the scratch branch into the main checkout. The result lands as
/// staged, uncommitted changes for the user to review.
///
/// Until v3.12.x this overlaid the whole scratch tree (`checkout <branch> -- .`
/// after `git rm`-ing everything absent from it). Once `main` had moved, that
/// reverted what `main` changed, deleted what it added and overwrote
/// uncommitted edits. Now the main checkout is never written unless all of the
/// following holds. All but the last are checked before anything is written,
/// the scratch included, so those refusals leave the agent's work in progress
/// as it was. The last needs the scratch committed, so a refusal there leaves
/// that commit in the scratch, which loses nothing.
///
/// - no unmerged index entries, and no rebase, merge, cherry-pick, revert or
///   bisect in progress, in the main checkout;
/// - the main checkout's `HEAD` is in the scratch branch's history (or in the
///   scratch's pending `MERGE_HEAD`), so the squash is a fast-forward carrying
///   exactly the task's work;
/// - no conflict marker left in the scratch's unmerged files;
/// - git itself accepts the squash. `git merge` checks the whole change set
///   before writing anything, so it refuses — changing nothing — when an
///   uncommitted edit, an untracked file, an ignored file
///   (`--no-overwrite-ignore`; Time Machine cannot restore those), a
///   file/directory swap or a case-only rename would lose data.
///
/// A Time Machine snapshot (`merge-back`) is taken right before the squash,
/// unless `snapshots_enabled` is `Some(false)` or there is nothing to bring.
/// Running it again on the same scratch is safe: with nothing new it is a
/// no-op, otherwise it brings only what was written since.
#[tauri::command]
pub(crate) async fn scratch_worktree_merge_back(
    cwd: String,
    scratch_path: String,
    snapshots_enabled: Option<bool>,
    keep_worktree: Option<bool>,
) -> Result<(), String> {
    let _repo = repo_lock::write(&cwd);
    scratch_worktree_merge_back_impl(
        cwd,
        scratch_path,
        snapshots_enabled,
        keep_worktree.unwrap_or(false),
    )
}

/// `git status --porcelain` XY codes of an unmerged (conflicted) path.
const CONFLICT_CODES: &[&str] = &["UU", "AA", "DD", "AU", "UA", "DU", "UD"];

fn has_unmerged_entries(dir: &Path) -> Result<bool, String> {
    Ok(git_in(dir, &["status", "--porcelain"])?
        .lines()
        .any(|l| l.len() >= 2 && CONFLICT_CODES.contains(&&l[..2])))
}

/// Unmerged files in `dir` whose working copy still has a conflict marker line.
/// Scanned as bytes, so a non-UTF-8 text file is checked too; a binary file
/// (one holding a NUL byte) can't hold markers and is taken as resolved.
fn files_with_conflict_markers(dir: &Path) -> Result<Vec<String>, String> {
    let output = git_cmd()
        .args(["diff", "--name-only", "--diff-filter=U", "-z"])
        .current_dir(dir)
        .output()
        .map_err(|e| format!("git diff failed to spawn: {}", e))?;
    if !output.status.success() {
        return Err(format!(
            "git diff failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let mut found: Vec<String> = String::from_utf8_lossy(&output.stdout)
        .split('\0')
        .filter(|p| !p.is_empty())
        .filter(|p| {
            std::fs::read(dir.join(p)).is_ok_and(|bytes| {
                !bytes.contains(&0)
                    && bytes
                        .split(|b| *b == b'\n')
                        .any(|l| l.starts_with(b"<<<<<<<") || l.starts_with(b">>>>>>>"))
            })
        })
        .map(str::to_string)
        .collect();
    found.dedup();
    Ok(found)
}

/// The git operation in progress in `dir`, if any, from the state files git
/// keeps for it. `--git-path` resolves them for linked worktrees too.
fn operation_in_progress(dir: &Path) -> Result<Option<&'static str>, String> {
    const STATES: &[(&str, &str)] = &[
        ("rebase-merge", "a rebase"),
        ("rebase-apply", "a rebase"),
        ("MERGE_HEAD", "a merge"),
        ("CHERRY_PICK_HEAD", "a cherry-pick"),
        ("REVERT_HEAD", "a revert"),
        ("BISECT_LOG", "a bisect"),
    ];
    for (name, op) in STATES {
        let path = git_in(dir, &["rev-parse", "--git-path", name])?;
        if dir.join(path).exists() {
            return Ok(Some(op));
        }
    }
    Ok(None)
}

fn scratch_worktree_merge_back_impl(
    cwd: String,
    scratch_path: String,
    snapshots_enabled: Option<bool>,
    keep_worktree: bool,
) -> Result<(), String> {
    let repo_root = canonical_cwd(&cwd)?;
    let scratch = validate_scratch_path(&repo_root, &scratch_path)?;

    // GUARD: refuse if the main checkout has unmerged (conflicting) entries.
    if has_unmerged_entries(&repo_root)? {
        return Err(
            "the main checkout has unresolved conflicting changes; resolve or abort them before merging back the scratch worktree"
                .to_string(),
        );
    }

    // GUARD: no operation in progress in the main checkout, even one without
    // unmerged entries (a rebase paused at `edit` or on a failed `exec`): the
    // task would be folded into whatever that operation commits next.
    if let Some(op) = operation_in_progress(&repo_root)? {
        return Err(format!(
            "the main checkout is in the middle of {}; finish or abort it before merging back the scratch worktree",
            op
        ));
    }

    let scratch_branch = git_in(&scratch, &["symbolic-ref", "--short", "HEAD"])?;

    // GUARD: the main checkout's HEAD must be in the task's history. Otherwise
    // `main` moved since the task was created (or the scratch started from
    // another branch and the current one was never merged into it), and
    // bringing the scratch tree over would undo `main`'s side. A merge pending
    // in the scratch counts: the commit concluding it has MERGE_HEAD as parent.
    // Checked before anything is written, the scratch included: a refusal must
    // not commit the agent's work in progress.
    let head = git_in(&repo_root, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    let in_task_history =
        |rev: &str| git_in(&repo_root, &["merge-base", "--is-ancestor", "HEAD", rev]).is_ok();
    let scratch_merge_head = git_in(&scratch, &["rev-parse", "-q", "--verify", "MERGE_HEAD"]).ok();
    if !in_task_history(&scratch_branch)
        && !scratch_merge_head.as_deref().is_some_and(in_task_history)
    {
        return Err(format!(
            "{h} is not in the history of {b}: {h} moved since {b} was created, or {b} started from another branch. Nothing was changed. Merge {h} into {b} first, then merge back",
            h = head,
            b = scratch_branch
        ));
    }

    // GUARD: no conflict markers left in the scratch's unmerged files. Read
    // from disk rather than staged and checked: undoing an `add` with `reset`
    // would end the user's merge in the scratch.
    let markers = files_with_conflict_markers(&scratch)?;
    if !markers.is_empty() {
        return Err(format!(
            "{} still has conflict markers; nothing was changed. Resolve them first: {}",
            scratch_branch,
            markers.join(", ")
        ));
    }

    // Commit any outstanding work in the scratch so its tree is a durable
    // object in the shared DB. A pending merge is concluded even when the
    // index shows no change (the user kept only the scratch side): left open,
    // the scratch branch lacks HEAD and the squash would be a real 3-way merge.
    // That commit records the user's choice, so the squash then does undo
    // HEAD's side of the conflict, as they resolved it. It is GitWand's own
    // bookkeeping: no hooks (a reformatting hook would change what is brought
    // back), no signing (it could prompt or fail).
    git_in(&scratch, &["add", "-A"])?;
    let scratch_status = git_in(&scratch, &["status", "--porcelain"])?;
    if !scratch_status.trim().is_empty() || scratch_merge_head.is_some() {
        git_in(
            &scratch,
            &[
                "-c",
                "commit.gpgsign=false",
                "commit",
                "--no-verify",
                "-q",
                "-m",
                "gitwand: scratch resolution",
            ],
        )?;
    }

    // Nothing to bring: the task changed nothing, or its tree is already in
    // the main index (a second run after the agent was stopped, with no late
    // write). Either way, no snapshot.
    let nothing_to_bring = git_in(&repo_root, &["diff", "--quiet", "HEAD", &scratch_branch])
        .is_ok()
        || git_in(
            &repo_root,
            &["diff", "--cached", "--quiet", &scratch_branch],
        )
        .is_ok();
    if !nothing_to_bring {
        crate::commands::ops::snapshot_before(
            &repo_root.to_string_lossy(),
            snapshots_enabled,
            "merge-back",
            &format!("Merge back {}", scratch_branch),
        );

        // Explicit flags so the user's merge config can't change the meaning:
        // `--ff-only` (merge.ff=false would reject --squash; and should the
        // scratch move between the guard and here — the agent may still be
        // running — git refuses rather than run a 3-way merge), `--no-autostash`
        // (merge.autoStash would move their edits aside and replay them),
        // `--no-verify-signatures` (the scratch commit is never signed).
        let output = git_cmd()
            .args([
                "merge",
                "--squash",
                "--ff-only",
                "--no-autostash",
                "--no-verify-signatures",
                "--no-overwrite-ignore",
                "--quiet",
                &scratch_branch,
            ])
            .current_dir(&repo_root)
            .output()
            .map_err(|e| format!("git merge failed to spawn: {}", e))?;
        if !output.status.success() {
            return Err(format!(
                "merge-back refused, nothing was changed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
    }

    if keep_worktree {
        return Ok(());
    }

    // Cleanup: remove the scratch worktree and prune any dangling registration.
    let _ = git_in(
        &repo_root,
        &["worktree", "remove", "--force", &scratch.to_string_lossy()],
    )?;
    // Best-effort delete of the now-unused scratch branch, then prune. Only a
    // branch GitWand created: the user may have switched the scratch to theirs.
    if scratch_branch.starts_with("gitwand-scratch-") {
        let _ = git_in(&repo_root, &["branch", "-D", &scratch_branch]);
    }
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
        scratch_worktree_merge_back_impl(repo.cwd(), scratch.path.clone(), None, false)
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

        let err = scratch_worktree_merge_back_impl(repo.cwd(), scratch.path.clone(), None, false)
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

        let err =
            scratch_worktree_merge_back_impl(repo.cwd(), scratch.path.clone(), Some(false), false)
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

        scratch_worktree_merge_back_impl(repo.cwd(), scratch.path.clone(), Some(false), false)
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

        let err =
            scratch_worktree_merge_back_impl(repo.cwd(), scratch.path.clone(), Some(false), false)
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

        let err =
            scratch_worktree_merge_back_impl(repo.cwd(), scratch.path.clone(), Some(false), false)
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
        scratch_worktree_merge_back_impl(repo.cwd(), scratch.path, None, false)
            .expect("merge-back");

        let snaps = list_snapshots_inner(&repo.cwd()).unwrap();
        assert_eq!(snaps.len(), 1);
        assert_eq!(snaps[0].kind, "merge-back");

        repo.commit_all("take the task");
        let scratch = scratch_worktree_create_impl(repo.cwd(), None, None).expect("create");
        write_in(&scratch, "task.txt", "second edit\n");
        scratch_worktree_merge_back_impl(repo.cwd(), scratch.path, Some(false), false)
            .expect("merge-back");
        assert_eq!(list_snapshots_inner(&repo.cwd()).unwrap().len(), 1);
    }

    #[test]
    fn merge_back_refused_when_an_ignored_file_would_be_overwritten() {
        // Time Machine skips ignored files, so a clobbered one is gone for good.
        let repo = TempRepo::new();
        repo.write(".gitignore", "secret.env\n");
        repo.commit_all("base");
        repo.write("secret.env", "real secret\n");

        let scratch = scratch_worktree_create_impl(repo.cwd(), None, None).expect("create");
        write_in(&scratch, ".gitignore", "");
        write_in(&scratch, "secret.env", "TEMPLATE\n");

        scratch_worktree_merge_back_impl(repo.cwd(), scratch.path.clone(), Some(false), false)
            .expect_err("merge-back must not overwrite an ignored file");
        assert_eq!(repo.read("secret.env"), "real secret\n");
        assert_eq!(repo.read(".gitignore"), "secret.env\n", "all or nothing");

        let _ = scratch_worktree_discard_impl(repo.cwd(), scratch.path);
    }

    #[test]
    fn merge_back_refused_when_a_directory_with_untracked_files_would_become_a_file() {
        let repo = TempRepo::new();
        repo.write("foo/a.txt", "tracked\n");
        repo.commit_all("base");
        repo.write("foo/notes.txt", "mine, untracked\n");

        let scratch = scratch_worktree_create_impl(repo.cwd(), None, None).expect("create");
        let scratch_dir = PathBuf::from(&scratch.path);
        std::fs::remove_dir_all(scratch_dir.join("foo")).unwrap();
        write_in(&scratch, "foo", "now a file\n");

        scratch_worktree_merge_back_impl(repo.cwd(), scratch.path.clone(), Some(false), false)
            .expect_err("merge-back must not delete untracked files under a replaced directory");
        assert_eq!(repo.read("foo/notes.txt"), "mine, untracked\n");

        let _ = scratch_worktree_discard_impl(repo.cwd(), scratch.path);
    }

    #[test]
    fn merge_back_refused_when_an_untracked_file_would_become_a_directory() {
        let repo = TempRepo::new();
        repo.write("base.txt", "v1\n");
        repo.commit_all("base");
        repo.write("cfg", "mine, untracked\n");

        let scratch = scratch_worktree_create_impl(repo.cwd(), None, None).expect("create");
        std::fs::create_dir_all(Path::new(&scratch.path).join("cfg")).unwrap();
        write_in(&scratch, "cfg/x.toml", "agent's\n");

        scratch_worktree_merge_back_impl(repo.cwd(), scratch.path.clone(), Some(false), false)
            .expect_err("merge-back must not replace an untracked file with a directory");
        assert_eq!(repo.read("cfg"), "mine, untracked\n");

        let _ = scratch_worktree_discard_impl(repo.cwd(), scratch.path);
    }

    #[test]
    fn merge_back_never_overwrites_an_untracked_file_differing_only_in_case() {
        // On a case-insensitive filesystem (macOS, Windows) `notes.md` and
        // `NOTES.md` are the same file: merge-back must refuse. On a
        // case-sensitive one both coexist. Either way, ours is intact.
        let repo = TempRepo::new();
        repo.write("base.txt", "v1\n");
        repo.commit_all("base");
        repo.write("NOTES.md", "mine, untracked\n");

        let scratch = scratch_worktree_create_impl(repo.cwd(), None, None).expect("create");
        write_in(&scratch, "notes.md", "agent's\n");

        let res =
            scratch_worktree_merge_back_impl(repo.cwd(), scratch.path.clone(), Some(false), false);
        assert_eq!(repo.read("NOTES.md"), "mine, untracked\n");
        if res.is_err() {
            let _ = scratch_worktree_discard_impl(repo.cwd(), scratch.path);
        }
    }

    #[test]
    fn merge_back_concludes_a_merge_resolved_but_not_committed_in_the_scratch() {
        // "Resolve in scratch": the scratch starts from the previewed branch,
        // the user merges the current branch into it and resolves, then merges
        // back without committing.
        let repo = TempRepo::new();
        repo.write("shared.txt", "base\n");
        repo.commit_all("base");
        repo.git(&["checkout", "-q", "-b", "feature"]);
        repo.write("shared.txt", "feature\n");
        repo.write("feature.txt", "feature only\n");
        repo.commit_all("feature");
        repo.git(&["checkout", "-q", "main"]);
        repo.write("shared.txt", "main\n");
        repo.write("main.txt", "main only\n");
        repo.commit_all("main");

        let scratch = scratch_worktree_create_impl(repo.cwd(), Some("feature".to_string()), None)
            .expect("create");
        let scratch_dir = PathBuf::from(&scratch.path);
        // Conflicts, as expected: non-zero exit.
        let _ = Command::new(git_binary())
            .args(["merge", "main"])
            .current_dir(&scratch_dir)
            .output()
            .unwrap();
        write_in(&scratch, "shared.txt", "resolved\n");

        scratch_worktree_merge_back_impl(repo.cwd(), scratch.path.clone(), Some(false), false)
            .expect("merge-back should conclude the pending merge and apply it");
        assert_eq!(repo.read("shared.txt"), "resolved\n");
        assert_eq!(repo.read("feature.txt"), "feature only\n");
        assert_eq!(repo.read("main.txt"), "main only\n");
    }

    #[test]
    fn merge_back_keeps_an_unrelated_staged_edit() {
        let repo = TempRepo::new();
        repo.write("mine.txt", "v1\n");
        repo.write("task.txt", "v1\n");
        repo.commit_all("base");

        let scratch = scratch_worktree_create_impl(repo.cwd(), None, None).expect("create");
        repo.write("mine.txt", "staged edit\n");
        repo.git(&["add", "mine.txt"]);
        write_in(&scratch, "task.txt", "agent edit\n");

        scratch_worktree_merge_back_impl(repo.cwd(), scratch.path.clone(), Some(false), false)
            .expect("merge-back should succeed");
        assert_eq!(repo.read("task.txt"), "agent edit\n");
        assert_eq!(repo.read("mine.txt"), "staged edit\n");
        let staged = repo.git(&["diff", "--cached", "--name-only"]);
        assert!(String::from_utf8_lossy(&staged.stdout).contains("mine.txt"));
    }

    #[test]
    fn merge_back_with_nothing_to_bring_takes_no_snapshot() {
        use crate::git::snapshot::list_snapshots_inner;

        let repo = TempRepo::new();
        repo.write("task.txt", "v1\n");
        repo.commit_all("base");

        let scratch = scratch_worktree_create_impl(repo.cwd(), None, None).expect("create");
        scratch_worktree_merge_back_impl(repo.cwd(), scratch.path.clone(), None, false)
            .expect("merge-back");
        assert!(list_snapshots_inner(&repo.cwd()).unwrap().is_empty());
        assert!(
            !Path::new(&scratch.path).exists(),
            "scratch still cleaned up"
        );
    }

    #[test]
    fn merge_back_can_keep_the_worktree_for_the_caller_to_discard() {
        // The AI-task flow stops the agent's terminal only once the merge-back
        // succeeded, then discards the worktree itself.
        let repo = TempRepo::new();
        repo.write("task.txt", "v1\n");
        repo.commit_all("base");

        let scratch = scratch_worktree_create_impl(repo.cwd(), None, None).expect("create");
        write_in(&scratch, "task.txt", "agent edit\n");
        scratch_worktree_merge_back_impl(repo.cwd(), scratch.path.clone(), Some(false), true)
            .expect("merge-back");
        assert_eq!(repo.read("task.txt"), "agent edit\n");
        assert!(Path::new(&scratch.path).exists(), "worktree kept");

        scratch_worktree_discard_impl(repo.cwd(), scratch.path.clone()).expect("discard");
        assert!(!Path::new(&scratch.path).exists());
    }

    #[test]
    fn merge_back_refused_when_the_scratch_still_has_conflict_markers() {
        let repo = TempRepo::new();
        repo.write("shared.txt", "base\n");
        repo.commit_all("base");
        repo.git(&["checkout", "-q", "-b", "feature"]);
        repo.write("shared.txt", "feature\n");
        repo.commit_all("feature");
        repo.git(&["checkout", "-q", "main"]);
        repo.write("shared.txt", "main\n");
        repo.commit_all("main");

        let scratch = scratch_worktree_create_impl(repo.cwd(), Some("feature".to_string()), None)
            .expect("create");
        let _ = Command::new(git_binary())
            .args(["merge", "main"])
            .current_dir(&scratch.path)
            .output()
            .unwrap();

        let err =
            scratch_worktree_merge_back_impl(repo.cwd(), scratch.path.clone(), Some(false), false)
                .expect_err("conflict markers must not reach the main checkout");
        assert!(err.contains("conflict markers"), "got: {}", err);
        assert_eq!(repo.read("shared.txt"), "main\n");
        // The refusal must not end the user's merge in the scratch.
        assert_eq!(
            scratch_state(&scratch),
            ("UU shared.txt".to_string(), true),
            "the scratch's merge must still be in progress"
        );

        let _ = scratch_worktree_discard_impl(repo.cwd(), scratch.path);
    }

    #[test]
    fn merge_back_ignores_the_users_merge_config() {
        let repo = TempRepo::new();
        repo.write("mine.txt", "v1\n");
        repo.write("task.txt", "v1\n");
        repo.commit_all("base");
        repo.git(&["config", "merge.ff", "false"]);
        repo.git(&["config", "merge.autoStash", "true"]);

        let scratch = scratch_worktree_create_impl(repo.cwd(), None, None).expect("create");
        repo.write("mine.txt", "my unsaved edit\n");
        write_in(&scratch, "task.txt", "agent edit\n");

        scratch_worktree_merge_back_impl(repo.cwd(), scratch.path.clone(), Some(false), false)
            .expect("merge-back should succeed whatever merge.ff says");
        assert_eq!(repo.read("task.txt"), "agent edit\n");
        assert_eq!(repo.read("mine.txt"), "my unsaved edit\n");
        let stashes = repo.git(&["stash", "list"]);
        assert!(stashes.stdout.is_empty(), "nothing left in the stash");
    }

    /// `git status --porcelain` of the scratch, and whether a merge is pending.
    fn scratch_state(scratch: &ScratchWorktree) -> (String, bool) {
        let dir = Path::new(&scratch.path);
        let status = git_in(dir, &["status", "--porcelain"]).unwrap();
        let merging = git_in(dir, &["rev-parse", "-q", "--verify", "MERGE_HEAD"]).is_ok();
        (status, merging)
    }

    #[test]
    fn merge_back_refusal_leaves_the_scratch_untouched() {
        // A refused merge-back must not commit the agent's work in progress.
        let repo = TempRepo::new();
        repo.write("task.txt", "v1\n");
        repo.commit_all("base");

        let scratch = scratch_worktree_create_impl(repo.cwd(), None, None).expect("create");
        repo.write("main.txt", "main moves on\n");
        repo.commit_all("main moves on");
        write_in(&scratch, "task.txt", "work in progress\n");

        let dir = Path::new(&scratch.path);
        let head_before = git_in(dir, &["rev-parse", "HEAD"]).unwrap();
        scratch_worktree_merge_back_impl(repo.cwd(), scratch.path.clone(), Some(false), false)
            .expect_err("main moved");
        assert_eq!(git_in(dir, &["rev-parse", "HEAD"]).unwrap(), head_before);
        assert_eq!(scratch_state(&scratch), ("M task.txt".to_string(), false));

        let _ = scratch_worktree_discard_impl(repo.cwd(), scratch.path);
    }

    /// Two branches that conflict on `f.txt`: `feature` and `main` (checked out).
    fn conflicting_branches(repo: &TempRepo, base: &[u8], feature: &[u8], main: &[u8]) {
        std::fs::write(repo.path.join("f.txt"), base).unwrap();
        repo.commit_all("base");
        repo.git(&["checkout", "-q", "-b", "feature"]);
        std::fs::write(repo.path.join("f.txt"), feature).unwrap();
        repo.commit_all("feature");
        repo.git(&["checkout", "-q", "main"]);
        std::fs::write(repo.path.join("f.txt"), main).unwrap();
        repo.commit_all("main");
    }

    fn git_at(dir: &str, args: &[&str]) -> std::process::Output {
        Command::new(git_binary())
            .args(args)
            .current_dir(dir)
            .output()
            .unwrap()
    }

    #[test]
    fn merge_back_concludes_a_pending_merge_with_no_visible_change() {
        // "Resolve in scratch" keeping only the scratch side: the index equals
        // HEAD, but MERGE_HEAD is there. Unconcluded, the squash became a real
        // 3-way merge that left conflict markers in the main checkout.
        let repo = TempRepo::new();
        conflicting_branches(&repo, b"base\n", b"feature side\n", b"main side\n");

        let scratch = scratch_worktree_create_impl(repo.cwd(), Some("feature".to_string()), None)
            .expect("create");
        let _ = git_at(&scratch.path, &["merge", "--no-commit", "main"]);
        git_at(&scratch.path, &["checkout", "--ours", "--", "f.txt"]);
        git_at(&scratch.path, &["add", "f.txt"]);
        assert_eq!(scratch_state(&scratch), (String::new(), true));

        scratch_worktree_merge_back_impl(repo.cwd(), scratch.path.clone(), Some(false), false)
            .expect("merge-back should conclude the merge and apply it");
        assert_eq!(repo.read("f.txt"), "feature side\n");
        let status = repo.git(&["status", "--porcelain"]);
        assert!(
            !String::from_utf8_lossy(&status.stdout).contains("UU"),
            "no conflict left in the main checkout"
        );
    }

    #[test]
    fn merge_back_finds_conflict_markers_in_a_non_utf8_file() {
        let repo = TempRepo::new();
        conflicting_branches(
            &repo,
            b"caf\xe9\nbase\n",
            b"caf\xe9\nfeat\n",
            b"caf\xe9\nmain\n",
        );

        let scratch = scratch_worktree_create_impl(repo.cwd(), Some("feature".to_string()), None)
            .expect("create");
        let _ = git_at(&scratch.path, &["merge", "main"]);

        let err =
            scratch_worktree_merge_back_impl(repo.cwd(), scratch.path.clone(), Some(false), false)
                .expect_err("markers in a Latin-1 file must be caught");
        assert!(err.contains("conflict markers"), "got: {}", err);
        assert_eq!(
            std::fs::read(repo.path.join("f.txt")).unwrap(),
            b"caf\xe9\nmain\n"
        );

        let _ = scratch_worktree_discard_impl(repo.cwd(), scratch.path);
    }

    #[test]
    fn merge_back_refused_while_main_is_mid_rebase() {
        let repo = TempRepo::new();
        repo.write("a.txt", "v1\n");
        repo.commit_all("c1");
        repo.write("a.txt", "v2\n");
        repo.commit_all("c2");

        let scratch = scratch_worktree_create_impl(repo.cwd(), None, None).expect("create");
        write_in(&scratch, "task.txt", "agent\n");

        // A rebase stopped by a failing exec: in progress, no unmerged entry.
        let _ = git_at(&repo.cwd(), &["rebase", "-x", "exit 1", "HEAD~1"]);
        assert!(
            repo.path.join(".git/rebase-merge").exists(),
            "rebase paused"
        );

        let err =
            scratch_worktree_merge_back_impl(repo.cwd(), scratch.path.clone(), Some(false), false)
                .expect_err("merge-back must not land inside a paused rebase");
        assert!(err.contains("rebase"), "should name the operation: {}", err);
        assert!(!repo.path.join("task.txt").exists());

        let _ = git_at(&repo.cwd(), &["rebase", "--abort"]);
        let _ = scratch_worktree_discard_impl(repo.cwd(), scratch.path);
    }

    #[test]
    fn merge_back_skips_commit_hooks_and_signing_in_the_scratch() {
        let repo = TempRepo::new();
        repo.write("task.txt", "v1\n");
        repo.commit_all("base");
        // Hooks live in the common git dir: they also run in the scratch.
        let hook = repo.path.join(".git/hooks/pre-commit");
        std::fs::write(&hook, "#!/bin/sh\nexit 1\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        repo.git(&["config", "commit.gpgsign", "true"]);
        repo.git(&["config", "gpg.program", "gitwand-no-such-gpg"]);

        let scratch = scratch_worktree_create_impl(repo.cwd(), None, None).expect("create");
        write_in(&scratch, "task.txt", "agent edit\n");

        scratch_worktree_merge_back_impl(repo.cwd(), scratch.path.clone(), Some(false), false)
            .expect("the internal scratch commit must not run hooks or sign");
        assert_eq!(repo.read("task.txt"), "agent edit\n");
    }

    #[test]
    fn merge_back_keeps_a_branch_that_is_not_a_scratch_branch() {
        let repo = TempRepo::new();
        repo.write("task.txt", "v1\n");
        repo.commit_all("base");

        let scratch = scratch_worktree_create_impl(repo.cwd(), None, None).expect("create");
        git_at(&scratch.path, &["checkout", "-q", "-b", "my-work"]);
        write_in(&scratch, "task.txt", "agent edit\n");

        scratch_worktree_merge_back_impl(repo.cwd(), scratch.path.clone(), Some(false), false)
            .expect("merge-back");
        assert!(
            git_at(&repo.cwd(), &["rev-parse", "--verify", "-q", "my-work"])
                .status
                .success(),
            "the user's own branch must survive the cleanup"
        );
    }

    #[test]
    fn merge_back_twice_is_idempotent_and_snapshots_once() {
        // The AI-task close runs merge-back again after stopping the agent, to
        // catch its late writes. With nothing new, the second run is a no-op.
        use crate::git::snapshot::list_snapshots_inner;

        let repo = TempRepo::new();
        repo.write("task.txt", "v1\n");
        repo.commit_all("base");

        let scratch = scratch_worktree_create_impl(repo.cwd(), None, None).expect("create");
        write_in(&scratch, "task.txt", "agent edit\n");
        scratch_worktree_merge_back_impl(repo.cwd(), scratch.path.clone(), None, true)
            .expect("first");
        scratch_worktree_merge_back_impl(repo.cwd(), scratch.path.clone(), None, true)
            .expect("second");
        assert_eq!(repo.read("task.txt"), "agent edit\n");
        assert_eq!(list_snapshots_inner(&repo.cwd()).unwrap().len(), 1);

        // A late write is picked up by the second run.
        write_in(&scratch, "late.txt", "written after\n");
        scratch_worktree_merge_back_impl(repo.cwd(), scratch.path.clone(), None, true)
            .expect("third");
        assert_eq!(repo.read("late.txt"), "written after\n");
        assert_eq!(repo.read("task.txt"), "agent edit\n");

        let _ = scratch_worktree_discard_impl(repo.cwd(), scratch.path);
    }
}

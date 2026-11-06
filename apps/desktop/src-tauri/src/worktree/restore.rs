//! Restore a snapshot as a new worktree (spec §9): a removed worktree, or a
//! task as it was before its merge-back, comes back next to the main
//! checkout without touching it.
//!
//! The new worktree is `<dir>/<name>-restored` on `restore/<name>`, started
//! from the snapshot's HEAD by the worktree service (so `include` runs and
//! it is recorded as a task, with the original base when the snapshot has
//! it). The snapshot's working tree, index and merge state then go on top,
//! with the same mechanics as the in-place restore. `setup` is the
//! frontend's, as for any new worktree.

use crate::git::snapshot::{apply_snapshot_state, list_snapshots_inner};
use crate::worktree::create::{create_worktree, CreateRequest, CreatedWorktree};
use crate::worktree::record::{self, Kind};
use crate::worktree::slug;
use std::path::Path;
use std::time::Duration;

/// The snapshot kinds that come from a worktree GitWand removed or merged.
pub(crate) const RESTORABLE_KINDS: &[&str] = &["removal", "merge-back-task"];

fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    let out = crate::git::git_cmd()
        .args(args)
        .current_dir(dir)
        .output()
        .map_err(|e| format!("cannot run git: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

pub(crate) fn restore_as_worktree(
    repo: &Path,
    id: &str,
    name: Option<&str>,
    fetch_timeout: Duration,
) -> Result<CreatedWorktree, String> {
    let main = crate::commands::worktree_trust::main_worktree_root(&repo.to_string_lossy())?;
    let snap = list_snapshots_inner(&main.to_string_lossy())?
        .into_iter()
        .find(|s| s.id == id)
        .ok_or_else(|| format!("Snapshot {id} not found."))?;
    let wt = match (
        &snap.worktree,
        RESTORABLE_KINDS.contains(&snap.kind.as_str()),
    ) {
        (Some(wt), true) => wt.clone(),
        _ => return Err("This snapshot was not taken from a worktree GitWand removed.".into()),
    };
    let wanted = name
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .unwrap_or(&wt.name);
    let slug = slug::slugify(wanted)
        .ok_or_else(|| "The name needs at least one letter or digit.".to_string())?;

    // `restore/<name>`, or the smallest free suffix.
    let free = |b: &str| {
        git(
            &main,
            &[
                "show-ref",
                "--verify",
                "--quiet",
                &format!("refs/heads/{b}"),
            ],
        )
        .is_err()
    };
    let mut branch = format!("restore/{slug}");
    let mut n = 1;
    while !free(&branch) {
        n += 1;
        branch = format!("restore/{slug}-{n}");
    }

    let mut created = create_worktree(
        &main,
        CreateRequest {
            name: format!("{slug}-restored"),
            base: Some(snap.head_sha.clone()),
            branch: Some(branch.clone()),
            path: None,
            kind: Kind::Task,
        },
        fetch_timeout,
    )?;
    let path = Path::new(&created.path).to_path_buf();
    let common = record::common_dir(&main)?;

    // The original base, so merge-back and the "merged" rule see the task as
    // it was, not as starting from its own last state. A snapshot without one
    // (taken before v3.13 recorded it) gets where the task left the main
    // checkout's branch.
    let (base_ref, base_commit) = match snap.worktree_base.clone() {
        Some(b) => (b.base_ref, b.base_commit),
        None => {
            let on =
                git(&main, &["symbolic-ref", "--quiet", "--short", "HEAD"]).unwrap_or_default();
            let fork = git(&main, &["merge-base", "HEAD", &snap.head_sha])
                .unwrap_or(snap.head_sha.clone());
            (if on.is_empty() { fork.clone() } else { on }, fork)
        }
    };
    let restored = apply_snapshot_state(&created.path, &snap).and_then(|_| {
        if let Some(mut rec) = record::find(&common, &path) {
            rec.base_ref = base_ref.clone();
            rec.base_commit = base_commit.clone();
            record::upsert(&common, rec)?;
        }
        // Read by the scratch merge-back guard, like those `create` wrote.
        git(
            &main,
            &[
                "config",
                &format!("branch.{branch}.gitwandBase"),
                &base_commit,
            ],
        )?;
        git(
            &main,
            &[
                "config",
                &format!("branch.{branch}.gitwandSource"),
                &base_ref,
            ],
        )?;
        Ok(())
    });
    if let Err(e) = restored {
        let _ = git(&main, &["worktree", "remove", "--force", &created.path]);
        let _ = git(&main, &["worktree", "prune"]);
        let _ = git(&main, &["branch", "-D", &branch]);
        let _ = record::remove(&common, &path);
        return Err(format!("The snapshot could not be restored: {e}"));
    }
    created.base.base_ref = base_ref;
    created.base.commit = base_commit;
    created.base.fetched_at = None;
    created.base.fallback_reason = None;
    created.base.fallback_detail = None;
    Ok(created)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::snapshot::create_snapshot_inner;
    use crate::process_tree::ProcInfo;
    use crate::worktree::remove::{prepare_removal, remove_worktree, RemoveOptions};
    use crate::worktree::test_support::{git_at, TempRepo};
    use std::path::PathBuf;

    const T: Duration = Duration::from_secs(20);

    fn task(repo: &TempRepo, name: &str) -> PathBuf {
        let c = create_worktree(
            &repo.path,
            CreateRequest {
                name: name.into(),
                base: None,
                branch: None,
                path: None,
                kind: Kind::Task,
            },
            T,
        )
        .unwrap();
        PathBuf::from(c.path)
    }

    fn none(_: &Path) -> Result<Vec<ProcInfo>, String> {
        Ok(vec![])
    }

    /// Removes `wt` the way the app does and returns the removal snapshot id.
    fn remove(repo: &TempRepo, wt: &Path) -> String {
        let id = prepare_removal(&repo.path, wt, none)
            .unwrap()
            .snapshot
            .unwrap()
            .id;
        let opts = RemoveOptions {
            snapshot_id: Some(id.clone()),
            delete_branch: true,
            ..Default::default()
        };
        remove_worktree(&repo.path, wt, &opts, |_| vec![]).unwrap();
        id
    }

    #[test]
    fn restore_as_worktree_round_trip() {
        let repo = TempRepo::new();
        repo.write(".gitignore", ".env\n");
        repo.write(".gitwandrc", r#"{"worktree":{"include":[".env"]}}"#);
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-q", "-m", "config"]);
        repo.write(".env", "SECRET=1\n");
        let wt = task(&repo, "fix");
        std::fs::write(wt.join("README.md"), "agent edit\n").unwrap();
        std::fs::write(wt.join("staged.txt"), "staged\n").unwrap();
        git_at(&wt, &["add", "staged.txt"]);
        std::fs::write(wt.join("new.txt"), "untracked\n").unwrap();
        let common = record::common_dir(&repo.path).unwrap();
        let original = record::find(&common, &wt).unwrap();
        repo.commit("main.txt", "main moves\n", "main moves");
        let id = remove(&repo, &wt);
        assert!(!wt.exists());

        let c = restore_as_worktree(&repo.path, &id, None, T).unwrap();
        let path = PathBuf::from(&c.path);
        assert!(c.path.ends_with("fix-restored"), "{}", c.path);
        assert_eq!(c.branch, "restore/fix");
        assert_eq!(
            std::fs::read_to_string(path.join("README.md")).unwrap(),
            "agent edit\n"
        );
        assert_eq!(
            std::fs::read_to_string(path.join("new.txt")).unwrap(),
            "untracked\n"
        );
        assert_eq!(
            git_at(&path, &["diff", "--cached", "--name-only"]),
            "staged.txt"
        );
        assert_eq!(git_at(&path, &["rev-parse", "HEAD"]), original.base_commit);
        // `include` ran again: ignored files are not in snapshots.
        assert_eq!(
            std::fs::read_to_string(path.join(".env")).unwrap(),
            "SECRET=1\n"
        );
        let rec = record::find(&common, &path).unwrap();
        assert_eq!(rec.kind, Kind::Task);
        assert_eq!(
            (rec.base_ref, rec.base_commit),
            (original.base_ref, original.base_commit)
        );
    }

    #[test]
    fn a_restored_task_with_commits_can_still_be_merged_back() {
        let repo = TempRepo::new();
        let wt = task(&repo, "agent");
        std::fs::write(wt.join("work.txt"), "agent\n").unwrap();
        git_at(&wt, &["add", "-A"]);
        git_at(&wt, &["commit", "-q", "-m", "agent work"]);
        let id = remove(&repo, &wt);
        let c = restore_as_worktree(&repo.path, &id, None, T).unwrap();
        let common = record::common_dir(&repo.path).unwrap();
        let rec = record::find(&common, Path::new(&c.path)).unwrap();
        assert_eq!(
            c.base.commit, rec.base_commit,
            "the frontend sees the recorded base"
        );
        assert_eq!(
            repo.git(&[
                "config",
                "--get",
                &format!("branch.{}.gitwandBase", c.branch)
            ]),
            rec.base_commit
        );
        crate::commands::scratch::scratch_worktree_merge_back_impl(
            repo.path.to_string_lossy().to_string(),
            c.path.clone(),
            Some(false),
        )
        .expect("merge-back from main");
        assert_eq!(
            std::fs::read_to_string(repo.path.join("work.txt")).unwrap(),
            "agent\n"
        );
    }

    #[test]
    fn without_a_recorded_base_the_base_is_where_the_task_left_main() {
        let repo = TempRepo::new();
        let start = repo.git(&["rev-parse", "HEAD"]);
        let wt = task(&repo, "old");
        std::fs::write(wt.join("w.txt"), "w").unwrap();
        git_at(&wt, &["add", "-A"]);
        git_at(&wt, &["commit", "-q", "-m", "w"]);
        // A snapshot without `worktreeBase` (taken before it existed).
        let common = record::common_dir(&repo.path).unwrap();
        record::remove(&common, &wt).unwrap();
        let id = remove(&repo, &wt);
        let c = restore_as_worktree(&repo.path, &id, None, T).unwrap();
        let rec = record::find(&common, Path::new(&c.path)).unwrap();
        assert_eq!(
            (rec.base_ref.as_str(), rec.base_commit.as_str()),
            ("main", start.as_str())
        );
    }

    #[test]
    fn restoring_twice_picks_free_names() {
        let repo = TempRepo::new();
        let wt = task(&repo, "fix");
        std::fs::write(wt.join("a.txt"), "a").unwrap();
        let id = remove(&repo, &wt);
        let a = restore_as_worktree(&repo.path, &id, None, T).unwrap();
        let b = restore_as_worktree(&repo.path, &id, None, T).unwrap();
        assert_eq!(b.branch, "restore/fix-2");
        assert_ne!(a.path, b.path);
        let c = restore_as_worktree(&repo.path, &id, Some("Other Name"), T).unwrap();
        assert_eq!(c.branch, "restore/other-name");
    }

    #[test]
    fn restore_refuses_a_snapshot_not_taken_from_a_worktree() {
        let repo = TempRepo::new();
        let snap = create_snapshot_inner(&repo.path.to_string_lossy(), "manual", "m")
            .unwrap()
            .unwrap();
        assert!(restore_as_worktree(&repo.path, &snap.id, None, T).is_err());
        assert!(restore_as_worktree(&repo.path, "123-nope", None, T).is_err());
        assert_eq!(repo.git(&["worktree", "list"]).lines().count(), 1);
    }
}

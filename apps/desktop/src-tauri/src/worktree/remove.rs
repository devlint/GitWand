//! Removing a worktree (spec §7.2), in two halves around the teardown,
//! which the frontend runs in a read-only terminal tab:
//!
//! - `prepare_removal`: guards, stop the processes, snapshot (steps 1–3);
//! - `remove_worktree`: guards again, the teardown gate, `git worktree
//!   remove` (with `--force` only once the snapshot exists), prune, the
//!   branch, the record (steps 1 and 5–7).
//!
//! The snapshot comes before the teardown, since a teardown may delete
//! files, or the worktree itself.

use crate::git::snapshot::{create_snapshot_full, SnapshotBase, SnapshotMeta, SnapshotWorktree};
use crate::process_tree::ProcInfo;
use crate::worktree::guard::{self, refuse_untouchable};
use crate::worktree::record::{self, Kind};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Serialize, Debug)]
pub struct Prepared {
    /// Processes still running in the worktree. Non-empty: nothing was
    /// snapshotted, removal is blocked until they are gone.
    pub survivors: Vec<ProcInfo>,
    pub snapshot: Option<SnapshotMeta>,
}

#[derive(Deserialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct RemoveOptions {
    /// The snapshot `prepare_removal` took: allows `--force`.
    pub snapshot_id: Option<String>,
    /// Teardown's exit code, when it ran.
    pub teardown_code: Option<i32>,
    /// The user chose "Skip hooks this time".
    pub teardown_skipped: bool,
    /// The user confirmed "Remove anyway" after a failed teardown.
    pub remove_anyway: bool,
    /// "Also delete branch".
    pub delete_branch: bool,
    /// The user confirmed removing a worktree GitWand did not create.
    pub confirm_not_owned: bool,
}

#[derive(Serialize, Debug, Default, PartialEq, Eq)]
pub struct RemoveOutcome {
    pub branch_deleted: Option<String>,
    /// What failed after the worktree was gone (branch, record).
    pub warnings: Vec<String>,
}

fn name_of(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default()
}

/// Steps 1–3. `stop` stops the worktree's processes and returns the
/// survivors (`worktree_processes::stop_processes_in` outside tests).
pub(crate) fn prepare_removal(
    repo: &Path,
    worktree: &Path,
    stop: impl FnOnce(&Path) -> Result<Vec<ProcInfo>, String>,
) -> Result<Prepared, String> {
    let report = guard::guard(repo, worktree)?;
    refuse_untouchable(&report, worktree)?;
    let entry = guard::listed(repo, worktree)?;
    let survivors = stop(&entry.path)?;
    if !survivors.is_empty() {
        return Ok(Prepared {
            survivors,
            snapshot: None,
        });
    }
    let name = name_of(&entry.path);
    let base = guard::record_for(repo, &entry.path).map(|r| SnapshotBase {
        base_ref: r.base_ref,
        base_commit: r.base_commit,
    });
    let snapshot = create_snapshot_full(
        &entry.path.to_string_lossy(),
        "removal",
        &format!("Remove worktree {name}"),
        Some(SnapshotWorktree {
            path: entry.path.to_string_lossy().to_string(),
            branch: entry.branch,
            name,
        }),
        base,
    )?;
    Ok(Prepared {
        survivors: vec![],
        snapshot,
    })
}

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

/// The snapshot exists, under an id shaped like the ones GitWand writes.
fn snapshot_exists(repo: &Path, id: &str) -> bool {
    let well_formed = !id.is_empty()
        && id
            .chars()
            .all(|c| c.is_ascii_hexdigit() || c.is_ascii_digit() || c == '-');
    well_formed
        && git(
            repo,
            &[
                "rev-parse",
                "--verify",
                "--quiet",
                &format!("refs/gitwand/snapshots/{id}"),
            ],
        )
        .is_ok()
}

/// Steps 1 and 5–7. `running` lists the processes still in the worktree
/// (`worktree_processes::still_running` outside tests).
pub(crate) fn remove_worktree(
    repo: &Path,
    worktree: &Path,
    opts: &RemoveOptions,
    running: impl FnOnce(&Path) -> Vec<ProcInfo>,
) -> Result<RemoveOutcome, String> {
    let report = guard::guard(repo, worktree)?;
    refuse_untouchable(&report, worktree)?;
    let entry = guard::listed(repo, worktree)?;
    let path = entry.path;
    if !report.owned && !opts.confirm_not_owned {
        return Err(format!(
            "not-owned: {} was not created by GitWand; confirm to remove it.",
            path.display()
        ));
    }
    let teardown_done =
        opts.teardown_skipped || opts.teardown_code == Some(0) || opts.remove_anyway;
    if report.teardown_required && !teardown_done {
        return Err(match opts.teardown_code {
            Some(code) => format!("teardown: it exited with code {code}; the worktree is kept."),
            None => "teardown: it has not run; the worktree is kept.".to_string(),
        });
    }

    let rec = guard::record_for(repo, &path);
    let main = crate::commands::worktree_trust::main_worktree_root(&repo.to_string_lossy())?;

    if path.exists() {
        let left = running(&path);
        if !left.is_empty() {
            let names: Vec<String> = left
                .iter()
                .map(|p| format!("{} ({})", p.name, p.pid))
                .collect();
            return Err(format!(
                "processes: still running in this worktree: {}",
                names.join(", ")
            ));
        }
        let force = opts
            .snapshot_id
            .as_deref()
            .is_some_and(|id| snapshot_exists(&main, id));
        let path_arg = path.to_string_lossy().to_string();
        let mut args = vec!["worktree", "remove"];
        if force {
            args.push("--force");
        }
        args.push(&path_arg);
        git(&main, &args).map_err(|e| format!("git worktree remove failed: {e}"))?;
    }
    // Also unregisters a worktree whose directory a teardown deleted.
    let _ = git(&main, &["worktree", "prune"]);

    let mut outcome = RemoveOutcome::default();
    if let Some(branch) = entry.branch {
        let merged_task = rec.as_ref().is_some_and(|r| r.kind == Kind::Task) && {
            let target = rec
                .as_ref()
                .and_then(|r| r.source_branch.clone())
                .map(|b| format!("refs/heads/{b}"))
                .unwrap_or_else(|| "HEAD".to_string());
            git(
                &main,
                &[
                    "merge-base",
                    "--is-ancestor",
                    &format!("refs/heads/{branch}"),
                    &target,
                ],
            )
            .is_ok()
        };
        if opts.delete_branch || merged_task {
            match git(&main, &["branch", "-D", &branch]) {
                Ok(_) => outcome.branch_deleted = Some(branch),
                Err(e) => outcome.warnings.push(format!("branch {branch} kept: {e}")),
            }
        }
    }
    if rec.is_some() {
        if let Err(e) = record::common_dir(&main).and_then(|c| record::remove(&c, &path)) {
            outcome.warnings.push(format!("record kept: {e}"));
        }
    }
    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::worktree::record::WorktreeRecord;
    use crate::worktree::test_support::{git_at, TempRepo};
    use std::path::PathBuf;

    fn none(_: &Path) -> Result<Vec<ProcInfo>, String> {
        Ok(vec![])
    }
    fn nothing(_: &Path) -> Vec<ProcInfo> {
        vec![]
    }

    /// A recorded task worktree on `task/<name>` under `<sandbox>/wt/`.
    fn task(repo: &TempRepo, name: &str) -> PathBuf {
        let path = repo.sandbox.join("wt").join(name);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let branch = format!("task/{name}");
        repo.git(&[
            "worktree",
            "add",
            "-q",
            "-b",
            &branch,
            path.to_str().unwrap(),
        ]);
        let path = path.canonicalize().unwrap();
        let common = record::common_dir(&repo.path).unwrap();
        record::upsert(
            &common,
            WorktreeRecord {
                path: path.to_string_lossy().to_string(),
                branch,
                base_ref: "main".into(),
                base_commit: repo.git(&["rev-parse", "HEAD"]),
                created_at: 1,
                kind: Kind::Task,
                source_branch: Some("main".into()),
            },
        )
        .unwrap();
        path
    }

    fn branch_exists(repo: &TempRepo, b: &str) -> bool {
        !repo.git(&["branch", "--list", b]).is_empty()
    }

    fn with_teardown(repo: &TempRepo) {
        repo.write(".gitwandrc", r#"{"worktree":{"teardown":"exit 1"}}"#);
    }

    #[test]
    fn removal_refused_while_teardown_failed() {
        let repo = TempRepo::new();
        with_teardown(&repo);
        let wt = task(&repo, "a");
        let failed = RemoveOptions {
            teardown_code: Some(1),
            ..Default::default()
        };
        let err = remove_worktree(&repo.path, &wt, &failed, nothing).unwrap_err();
        assert!(err.starts_with("teardown:"), "{err}");
        assert!(wt.exists());
        let never = RemoveOptions::default();
        assert!(remove_worktree(&repo.path, &wt, &never, nothing)
            .unwrap_err()
            .starts_with("teardown:"));
        let anyway = RemoveOptions {
            teardown_code: Some(1),
            remove_anyway: true,
            ..Default::default()
        };
        remove_worktree(&repo.path, &wt, &anyway, nothing).unwrap();
        assert!(!wt.exists());

        for opts in [
            RemoveOptions {
                teardown_skipped: true,
                ..Default::default()
            },
            RemoveOptions {
                teardown_code: Some(0),
                ..Default::default()
            },
        ] {
            let wt = task(&repo, "b");
            remove_worktree(&repo.path, &wt, &opts, nothing).unwrap();
            assert!(!wt.exists());
        }
    }

    #[test]
    fn removal_refused_for_locked_and_keep_file() {
        let repo = TempRepo::new();
        let locked = task(&repo, "locked");
        repo.git(&["worktree", "lock", locked.to_str().unwrap()]);
        let kept = task(&repo, "kept");
        std::fs::write(kept.join(guard::KEEP_FILE), "").unwrap();
        let opts = RemoveOptions {
            delete_branch: true,
            remove_anyway: true,
            confirm_not_owned: true,
            ..Default::default()
        };
        for wt in [&locked, &kept] {
            assert!(prepare_removal(&repo.path, wt, none)
                .unwrap_err()
                .starts_with("untouchable:"));
            assert!(remove_worktree(&repo.path, wt, &opts, nothing)
                .unwrap_err()
                .starts_with("untouchable:"));
            assert!(wt.exists());
        }
        assert!(kept.join(guard::KEEP_FILE).exists());
        assert!(branch_exists(&repo, "task/locked") && branch_exists(&repo, "task/kept"));
    }

    #[test]
    fn removal_refused_for_unowned_without_confirmation() {
        let repo = TempRepo::new();
        let wt = repo.sandbox.join("plain");
        repo.git(&["worktree", "add", "-q", "-b", "plain", wt.to_str().unwrap()]);
        let err = remove_worktree(&repo.path, &wt, &RemoveOptions::default(), nothing).unwrap_err();
        assert!(err.starts_with("not-owned:"), "{err}");
        let ok = RemoveOptions {
            confirm_not_owned: true,
            ..Default::default()
        };
        remove_worktree(&repo.path, &wt, &ok, nothing).unwrap();
        assert!(!wt.exists());
        // Not a task, not asked: the branch stays.
        assert!(branch_exists(&repo, "plain"));
    }

    #[test]
    fn removal_snapshots_dirty_work_then_forces() {
        let repo = TempRepo::new();
        let wt = task(&repo, "dirty");
        std::fs::write(wt.join("README.md"), "changed\n").unwrap();
        std::fs::write(wt.join("new.txt"), "untracked\n").unwrap();
        let prepared = prepare_removal(&repo.path, &wt, none).unwrap();
        let snap = prepared.snapshot.expect("a snapshot");
        assert_eq!(snap.kind, "removal");
        let meta = snap.worktree.as_ref().unwrap();
        assert_eq!(meta.name, "dirty");
        assert_eq!(meta.branch.as_deref(), Some("task/dirty"));
        let opts = RemoveOptions {
            snapshot_id: Some(snap.id.clone()),
            ..Default::default()
        };
        remove_worktree(&repo.path, &wt, &opts, nothing).unwrap();
        assert!(!wt.exists());
        // The work is in the snapshot, which outlives the worktree.
        let tree = repo.git(&[
            "ls-tree",
            "--name-only",
            &format!("{}^{{tree}}", snap.commit),
        ]);
        assert!(tree.contains("new.txt"), "{tree}");
        assert_eq!(
            repo.git(&["show", &format!("{}:README.md", snap.commit)]),
            "changed"
        );
    }

    #[test]
    fn removal_without_snapshot_keeps_a_dirty_worktree() {
        let repo = TempRepo::new();
        let wt = task(&repo, "dirty");
        std::fs::write(wt.join("README.md"), "changed\n").unwrap();
        let forged = RemoveOptions {
            snapshot_id: Some("123-deadbeef".into()),
            ..Default::default()
        };
        for opts in [RemoveOptions::default(), forged] {
            let err = remove_worktree(&repo.path, &wt, &opts, nothing).unwrap_err();
            assert!(err.contains("git worktree remove failed"), "{err}");
            assert!(wt.join("README.md").exists());
        }
    }

    #[test]
    fn removal_after_teardown_deleted_the_directory() {
        let repo = TempRepo::new();
        with_teardown(&repo);
        let wt = task(&repo, "gone");
        repo.git(&["commit", "-q", "--allow-empty", "-m", "main moves"]);
        std::fs::remove_dir_all(&wt).unwrap();
        let opts = RemoveOptions {
            teardown_code: Some(0),
            delete_branch: true,
            ..Default::default()
        };
        let out = remove_worktree(&repo.path, &wt, &opts, nothing).unwrap();
        assert_eq!(out.branch_deleted.as_deref(), Some("task/gone"));
        assert!(!repo.git(&["worktree", "list"]).contains("gone"));
        let common = record::common_dir(&repo.path).unwrap();
        assert!(record::find(&common, &wt).is_none());
    }

    #[test]
    fn removal_deletes_a_merged_task_branch_only() {
        let repo = TempRepo::new();
        let merged = task(&repo, "merged");
        let ahead = task(&repo, "ahead");
        git_at(
            &ahead,
            &["commit", "-q", "--allow-empty", "-m", "agent work"],
        );
        let opts = RemoveOptions::default();
        let out = remove_worktree(&repo.path, &merged, &opts, nothing).unwrap();
        assert_eq!(out.branch_deleted.as_deref(), Some("task/merged"));
        let out = remove_worktree(&repo.path, &ahead, &opts, nothing).unwrap();
        assert_eq!(out.branch_deleted, None);
        assert!(branch_exists(&repo, "task/ahead"));
    }

    #[test]
    fn removal_drops_the_record() {
        let repo = TempRepo::new();
        let wt = task(&repo, "r");
        let common = record::common_dir(&repo.path).unwrap();
        assert!(record::find(&common, &wt).is_some());
        remove_worktree(&repo.path, &wt, &RemoveOptions::default(), nothing).unwrap();
        assert!(record::find(&common, &wt).is_none());
    }

    #[test]
    fn removal_refused_while_a_process_runs_there() {
        let repo = TempRepo::new();
        let wt = task(&repo, "busy");
        let busy = |_: &Path| {
            vec![ProcInfo {
                pid: 4242,
                ppid: 1,
                name: "vite".into(),
            }]
        };
        let err = remove_worktree(&repo.path, &wt, &RemoveOptions::default(), busy).unwrap_err();
        assert!(
            err.starts_with("processes:") && err.contains("vite (4242)"),
            "{err}"
        );
        assert!(wt.exists());
        let survivors = |_: &Path| Ok(busy(Path::new("")));
        let prepared = prepare_removal(&repo.path, &wt, survivors).unwrap();
        assert_eq!(prepared.survivors.len(), 1);
        assert!(prepared.snapshot.is_none());
    }
}

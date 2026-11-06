//! Bringing a task's work back (spec §6.1), around the v3.11 preview → apply
//! flow, which the frontend drives:
//!
//! - `check` (steps 1–2, read-only): the task branch, the target, and
//!   whether the main checkout can take the work right now;
//! - `prepare` (steps 3–5): check again, stop the task's processes, commit
//!   its outstanding work, snapshot both sides;
//! - `squash` and `fast_forward`: the two git steps the generic apply
//!   primitives do not cover (`merge --squash`, and the final `merge
//!   --ff-only` after a rebase).
//!
//! Merge and rebase themselves go through `git_merge --no-ff` and
//! `git_rebase_onto`, with the engine resolving what git leaves.

use crate::commands::scratch::{has_unmerged_entries, operation_in_progress};
use crate::git::snapshot::{
    create_snapshot_inner, create_snapshot_with, SnapshotMeta, SnapshotWorktree,
};
use crate::process_tree::ProcInfo;
use crate::worktree::guard;
use serde::Serialize;
use std::collections::BTreeSet;
use std::path::Path;

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct Refusal {
    /// `untouchable`, `not-owned`, `detached`, `unknown-target`,
    /// `wrong-branch`, `main-in-progress`, `task-in-progress`, `overlap`,
    /// `nothing`.
    pub code: String,
    pub message: String,
    /// The overlapping files, for `overlap`.
    pub paths: Vec<String>,
}

#[derive(Serialize, Debug, Clone)]
pub struct MergeBackCheck {
    pub task_branch: String,
    pub task_path: String,
    pub name: String,
    pub target: String,
    pub default_target: String,
    pub main_path: String,
    /// `None` when the main checkout's HEAD is detached.
    pub main_branch: Option<String>,
    /// No change at all in the main checkout: switching it is possible.
    pub main_clean: bool,
    /// Commits on the task branch that the target lacks.
    pub task_commits: u32,
    /// Uncommitted changes in the task worktree, committed by `prepare`.
    pub task_dirty: bool,
    /// The target already contains the task branch (a merge or rebase is
    /// done; an aborted one is not).
    pub task_merged: bool,
    /// The main checkout has staged changes (what a squash leaves).
    pub main_staged: bool,
    pub refusal: Option<Refusal>,
}

#[derive(Serialize, Debug)]
pub struct Prepared {
    pub check: MergeBackCheck,
    /// Non-empty: nothing was committed or snapshotted.
    pub survivors: Vec<ProcInfo>,
    pub task_snapshot: Option<SnapshotMeta>,
    pub main_snapshot: Option<SnapshotMeta>,
    /// The outstanding task work was committed as a `wip(...)` commit.
    pub committed_wip: bool,
}

/// git with raw stdout: porcelain output must keep its leading spaces.
fn git_raw(dir: &Path, args: &[&str]) -> Result<String, String> {
    let out = crate::git::git_cmd()
        .args(args)
        .current_dir(dir)
        .output()
        .map_err(|e| format!("cannot run git: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    git_raw(dir, args).map(|s| s.trim().to_string())
}

fn ok(dir: &Path, args: &[&str]) -> bool {
    git_raw(dir, args).is_ok()
}

/// Paths `git status` reports as changed or untracked (not ignored), both
/// sides of a rename.
fn changed_paths(dir: &Path) -> Result<BTreeSet<String>, String> {
    let raw = git_raw(
        dir,
        &["status", "--porcelain", "-z", "--untracked-files=all"],
    )?;
    let mut out = BTreeSet::new();
    let mut tokens = raw.split('\0').filter(|t| !t.is_empty());
    while let Some(t) = tokens.next() {
        if t.len() < 4 {
            continue;
        }
        let code = &t[..2];
        out.insert(t[3..].to_string());
        if code.starts_with('R') || code.starts_with('C') {
            if let Some(old) = tokens.next() {
                out.insert(old.to_string());
            }
        }
    }
    Ok(out)
}

fn local_branch_exists(dir: &Path, b: &str) -> bool {
    !b.is_empty()
        && ok(
            dir,
            &[
                "show-ref",
                "--verify",
                "--quiet",
                &format!("refs/heads/{b}"),
            ],
        )
}

fn refusal(code: &str, message: String) -> Option<Refusal> {
    Some(Refusal {
        code: code.to_string(),
        message,
        paths: vec![],
    })
}

/// Where the work goes by default (spec §6.1 step 1).
fn default_target(
    main: &Path,
    task_branch: &str,
    rec: Option<&crate::worktree::record::WorktreeRecord>,
    main_branch: Option<&str>,
) -> String {
    if let Some(src) = rec.and_then(|r| r.source_branch.clone()) {
        if local_branch_exists(main, &src) {
            return src;
        }
    }
    if let Ok(src) = git(
        main,
        &[
            "config",
            "--get",
            &format!("branch.{task_branch}.gitwandSource"),
        ],
    ) {
        if local_branch_exists(main, &src) {
            return src;
        }
    }
    if let Some(base) = rec.map(|r| r.base_ref.clone()) {
        let local = base
            .split_once('/')
            .map(|(_, b)| b.to_string())
            .unwrap_or(base.clone());
        for candidate in [base, local] {
            if candidate != task_branch && local_branch_exists(main, &candidate) {
                return candidate;
            }
        }
    }
    main_branch.unwrap_or("").to_string()
}

pub(crate) fn check(
    repo: &Path,
    worktree: &Path,
    target: Option<&str>,
) -> Result<MergeBackCheck, String> {
    let report = guard::guard(repo, worktree)?;
    let entry = guard::listed(repo, worktree)?;
    let task_path = entry.path.clone();
    let main = crate::commands::worktree_trust::main_worktree_root(&repo.to_string_lossy())?;
    let main_branch = git(&main, &["symbolic-ref", "--quiet", "--short", "HEAD"])
        .ok()
        .filter(|b| !b.is_empty());
    let task_branch = entry.branch.clone().unwrap_or_default();
    let rec = guard::record_for(repo, &task_path);
    let default_target = default_target(&main, &task_branch, rec.as_ref(), main_branch.as_deref());
    let target = target
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| default_target.clone());
    let main_changes = changed_paths(&main)?;
    let task_changes = changed_paths(&task_path)?;
    let name = task_path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();

    let mut out = MergeBackCheck {
        task_branch: task_branch.clone(),
        task_path: crate::worktree::hooks::display_path(&task_path),
        name,
        target: target.clone(),
        default_target,
        main_path: crate::worktree::hooks::display_path(&main),
        main_branch: main_branch.clone(),
        main_clean: main_changes.is_empty(),
        task_commits: 0,
        task_dirty: !task_changes.is_empty(),
        task_merged: false,
        main_staged: !ok(&main, &["diff", "--cached", "--quiet"]),
        refusal: None,
    };

    if report.untouchable {
        out.refusal = refusal(
            "untouchable",
            format!(
                "This worktree is protected ({}).",
                report.reasons.join(", ")
            ),
        );
        return Ok(out);
    }
    if !report.owned {
        out.refusal = refusal("not-owned", "GitWand did not create this worktree.".into());
        return Ok(out);
    }
    if task_branch.is_empty() {
        out.refusal = refusal("detached", "The task worktree is not on a branch.".into());
        return Ok(out);
    }
    if target == task_branch || !local_branch_exists(&main, &target) {
        out.refusal = refusal(
            "unknown-target",
            format!("{target} is not a local branch to merge into."),
        );
        return Ok(out);
    }
    out.task_merged = ok(
        &main,
        &[
            "merge-base",
            "--is-ancestor",
            &format!("refs/heads/{task_branch}"),
            &format!("refs/heads/{target}"),
        ],
    );
    out.task_commits = git(
        &main,
        &[
            "rev-list",
            "--count",
            &format!("refs/heads/{target}..refs/heads/{task_branch}"),
        ],
    )?
    .parse()
    .unwrap_or(0);
    if main_branch.as_deref() != Some(target.as_str()) {
        let on = main_branch
            .clone()
            .unwrap_or_else(|| "a detached HEAD".into());
        out.refusal = refusal(
            "wrong-branch",
            format!("The main checkout is on {on}, not {target}."),
        );
        return Ok(out);
    }
    if let Some(op) = operation_in_progress(&main)? {
        out.refusal = refusal(
            "main-in-progress",
            format!("The main checkout is in the middle of {op}."),
        );
        return Ok(out);
    }
    if has_unmerged_entries(&main)? {
        out.refusal = refusal(
            "main-in-progress",
            "The main checkout has unresolved conflicts.".into(),
        );
        return Ok(out);
    }
    if operation_in_progress(&task_path)?.is_some() || has_unmerged_entries(&task_path)? {
        out.refusal = refusal(
            "task-in-progress",
            "The task worktree is in the middle of a git operation.".into(),
        );
        return Ok(out);
    }
    if out.task_commits == 0 && !out.task_dirty {
        out.refusal = refusal(
            "nothing",
            format!("{task_branch} has nothing that {target} lacks."),
        );
        return Ok(out);
    }
    let base = git(
        &main,
        &[
            "merge-base",
            &format!("refs/heads/{target}"),
            &format!("refs/heads/{task_branch}"),
        ],
    )?;
    // `--no-renames`: a renamed file's source is changed too.
    let committed = git_raw(
        &main,
        &[
            "diff",
            "--no-renames",
            "--name-only",
            "-z",
            &base,
            &format!("refs/heads/{task_branch}"),
        ],
    )?;
    let task_files: BTreeSet<String> = committed
        .split('\0')
        .filter(|p| !p.is_empty())
        .map(str::to_string)
        .chain(task_changes)
        .collect();
    // Ignored files in main are in no snapshot: a merge overwriting one could
    // not be undone. `--directory` keeps an ignored tree to one entry.
    let ignored_raw = git_raw(
        &main,
        &[
            "ls-files",
            "-o",
            "-i",
            "--exclude-standard",
            "--directory",
            "-z",
        ],
    )?;
    let ignored: Vec<&str> = ignored_raw.split('\0').filter(|p| !p.is_empty()).collect();
    let mut overlap: BTreeSet<String> = main_changes.intersection(&task_files).cloned().collect();
    for f in &task_files {
        if ignored
            .iter()
            .any(|i| i == f || (i.ends_with('/') && f.starts_with(i)))
        {
            overlap.insert(f.clone());
        }
    }
    let overlap: Vec<String> = overlap.into_iter().collect();
    if !overlap.is_empty() {
        out.refusal = Some(Refusal {
            code: "overlap".into(),
            message: "The main checkout has changes to files the task also changes.".into(),
            paths: overlap,
        });
    }
    Ok(out)
}

fn refuse(c: &MergeBackCheck) -> Result<(), String> {
    match &c.refusal {
        Some(r) => Err(format!("{}: {}", r.code, r.message)),
        None => Ok(()),
    }
}

/// Steps 3–5. `stop` stops the task's processes and returns the survivors.
pub(crate) fn prepare(
    repo: &Path,
    worktree: &Path,
    target: &str,
    stop: impl FnOnce(&Path) -> Result<Vec<ProcInfo>, String>,
) -> Result<Prepared, String> {
    let c = check(repo, worktree, Some(target))?;
    refuse(&c)?;
    let task = Path::new(&c.task_path).to_path_buf();
    let survivors = stop(&task)?;
    if !survivors.is_empty() {
        return Ok(Prepared {
            check: c,
            survivors,
            task_snapshot: None,
            main_snapshot: None,
            committed_wip: false,
        });
    }
    // GitWand's own bookkeeping: no hooks, no signing (they could rewrite,
    // block or prompt), as the scratch merge-back always did.
    git(&task, &["add", "-A"])?;
    let committed_wip = !changed_paths(&task)?.is_empty();
    if committed_wip {
        let message = format!("wip({}): uncommitted work at merge-back", c.name);
        git(
            &task,
            &[
                "-c",
                "commit.gpgsign=false",
                "-c",
                "core.hooksPath=/dev/null",
                "commit",
                "--no-verify",
                "-q",
                "-m",
                &message,
            ],
        )?;
    }
    let task_snapshot = create_snapshot_with(
        &c.task_path,
        "merge-back-task",
        &format!("Merge back {} (task)", c.name),
        Some(SnapshotWorktree {
            path: c.task_path.clone(),
            branch: Some(c.task_branch.clone()),
            name: c.name.clone(),
        }),
    )?;
    let main_snapshot = create_snapshot_inner(
        &c.main_path,
        "merge-back",
        &format!("Merge back {} into {}", c.name, c.target),
    )?;
    let c = check(repo, worktree, Some(target))?;
    Ok(Prepared {
        check: c,
        survivors: vec![],
        task_snapshot,
        main_snapshot,
        committed_wip,
    })
}

#[derive(Serialize, Debug, PartialEq, Eq)]
pub struct StepResult {
    /// git stopped on conflicts: the engine and the user take over.
    pub conflicts: bool,
}

/// The main checkout, when it is still on `target`.
fn main_on(repo: &Path, target: &str) -> Result<std::path::PathBuf, String> {
    let main = crate::commands::worktree_trust::main_worktree_root(&repo.to_string_lossy())?;
    let on = git(&main, &["symbolic-ref", "--quiet", "--short", "HEAD"]).unwrap_or_default();
    if on != target {
        return Err(format!(
            "wrong-branch: the main checkout is no longer on {target}."
        ));
    }
    Ok(main)
}

/// Squash mode: the task's changes staged on the target, uncommitted.
pub(crate) fn squash(repo: &Path, worktree: &Path, target: &str) -> Result<StepResult, String> {
    let entry = guard::listed(repo, worktree)?;
    let branch = entry
        .branch
        .ok_or("detached: the task worktree is not on a branch.")?;
    let main = main_on(repo, target)?;
    let out = crate::git::git_cmd()
        .args([
            "merge",
            "--squash",
            "--no-autostash",
            "--no-verify-signatures",
            &format!("refs/heads/{branch}"),
        ])
        .current_dir(&main)
        .output()
        .map_err(|e| format!("cannot run git: {e}"))?;
    if out.status.success() {
        return Ok(StepResult { conflicts: false });
    }
    if has_unmerged_entries(&main)? {
        return Ok(StepResult { conflicts: true });
    }
    Err(format!(
        "git refused the squash: {}",
        String::from_utf8_lossy(&out.stderr).trim()
    ))
}

/// Rebase mode, last step: the target fast-forwards to the rebased task.
pub(crate) fn fast_forward(
    repo: &Path,
    worktree: &Path,
    target: &str,
) -> Result<StepResult, String> {
    let entry = guard::listed(repo, worktree)?;
    let branch = entry
        .branch
        .ok_or("detached: the task worktree is not on a branch (is its rebase still running?).")?;
    if operation_in_progress(&entry.path)?.is_some() {
        return Err("task-in-progress: finish the rebase in the task worktree first.".into());
    }
    let main = main_on(repo, target)?;
    git(
        &main,
        &[
            "merge",
            "--ff-only",
            "--no-autostash",
            &format!("refs/heads/{branch}"),
        ],
    )
    .map_err(|e| format!("git refused to fast-forward {target}: {e}"))?;
    Ok(StepResult { conflicts: false })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::worktree::create::{create_worktree, CreateRequest};
    use crate::worktree::record::Kind;
    use crate::worktree::test_support::{git_at, TempRepo};
    use std::path::PathBuf;
    use std::time::Duration;

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
            Duration::from_secs(20),
        )
        .unwrap();
        PathBuf::from(c.path)
    }

    fn commit_in(dir: &Path, file: &str, content: &str) {
        std::fs::write(dir.join(file), content).unwrap();
        git_at(dir, &["add", "-A"]);
        git_at(dir, &["commit", "-q", "-m", file]);
    }

    fn none(_: &Path) -> Result<Vec<ProcInfo>, String> {
        Ok(vec![])
    }

    fn code(c: &MergeBackCheck) -> Option<&str> {
        c.refusal.as_ref().map(|r| r.code.as_str())
    }

    #[test]
    fn check_defaults_to_the_source_branch_and_accepts_a_moved_main() {
        let repo = TempRepo::new();
        let wt = task(&repo, "a");
        commit_in(&wt, "task.txt", "agent\n");
        repo.commit("main.txt", "main moved\n", "main moves");
        let c = check(&repo.path, &wt, None).unwrap();
        assert_eq!(c.default_target, "main");
        assert_eq!(c.target, "main");
        assert_eq!(c.task_branch, "task/a");
        assert_eq!(c.task_commits, 1);
        assert_eq!(c.refusal, None, "main moving on no longer blocks");
    }

    #[test]
    fn check_refuses_the_wrong_branch_and_says_whether_main_can_switch() {
        let repo = TempRepo::new();
        let wt = task(&repo, "a");
        commit_in(&wt, "task.txt", "agent\n");
        repo.git(&["checkout", "-q", "-b", "other"]);
        let c = check(&repo.path, &wt, None).unwrap();
        assert_eq!(code(&c), Some("wrong-branch"));
        assert!(c.main_clean);
        repo.write("dirty.txt", "x");
        assert!(!check(&repo.path, &wt, None).unwrap().main_clean);
        assert_eq!(
            code(&check(&repo.path, &wt, Some("nope")).unwrap()),
            Some("unknown-target")
        );
    }

    #[test]
    fn check_refuses_while_main_is_mid_merge() {
        let repo = TempRepo::new();
        let wt = task(&repo, "a");
        commit_in(&wt, "task.txt", "agent\n");
        repo.git(&["checkout", "-q", "-b", "side"]);
        repo.commit("README.md", "side\n", "side");
        repo.git(&["checkout", "-q", "main"]);
        repo.commit("README.md", "main\n", "main");
        let _ = std::process::Command::new(crate::git::git_binary())
            .args(["merge", "side"])
            .current_dir(&repo.path)
            .output();
        assert_eq!(
            code(&check(&repo.path, &wt, None).unwrap()),
            Some("main-in-progress")
        );
    }

    #[test]
    fn check_refuses_an_overlap_but_not_an_unrelated_change() {
        let repo = TempRepo::new();
        let wt = task(&repo, "a");
        commit_in(&wt, "README.md", "agent\n");
        std::fs::write(wt.join("new.txt"), "wip").unwrap();
        repo.write("unrelated.txt", "mine");
        assert_eq!(check(&repo.path, &wt, None).unwrap().refusal, None);
        repo.write("README.md", "my edit\n");
        let c = check(&repo.path, &wt, None).unwrap();
        assert_eq!(code(&c), Some("overlap"));
        assert_eq!(c.refusal.unwrap().paths, vec!["README.md"]);
        repo.git(&["checkout", "--", "README.md"]);
        repo.write("new.txt", "mine too");
        assert_eq!(
            code(&check(&repo.path, &wt, None).unwrap()),
            Some("overlap")
        );
    }

    #[test]
    fn check_overlap_sees_rename_sources_and_ignored_files() {
        let repo = TempRepo::new();
        repo.commit("a.ts", "export const a = 1;\n", "a");
        repo.commit(".gitignore", "local.json\n", "ignore");
        let wt = task(&repo, "a");
        git_at(&wt, &["mv", "a.ts", "b.ts"]);
        git_at(&wt, &["commit", "-q", "-m", "rename"]);
        repo.write("a.ts", "export const a = 2;\n");
        let c = check(&repo.path, &wt, None).unwrap();
        assert_eq!(code(&c), Some("overlap"));
        assert!(c.refusal.unwrap().paths.contains(&"a.ts".to_string()));
        repo.git(&["checkout", "--", "a.ts"]);

        // The task commits a path main ignores and holds locally: a merge
        // would overwrite it, and snapshots do not keep ignored files.
        git_at(&wt, &["add", "-f", "-N", "."]);
        std::fs::write(wt.join("local.json"), "task").unwrap();
        git_at(&wt, &["add", "-f", "local.json"]);
        git_at(&wt, &["commit", "-q", "-m", "local"]);
        repo.write("local.json", "mine");
        let c = check(&repo.path, &wt, None).unwrap();
        assert_eq!(code(&c), Some("overlap"));
        assert_eq!(c.refusal.unwrap().paths, vec!["local.json"]);
    }

    #[test]
    fn check_says_whether_the_target_holds_the_task() {
        let repo = TempRepo::new();
        let wt = task(&repo, "a");
        commit_in(&wt, "t.txt", "t");
        let c = check(&repo.path, &wt, None).unwrap();
        assert!(!c.task_merged && !c.main_staged);
        repo.git(&["merge", "-q", "--no-ff", "--no-edit", "task/a"]);
        assert!(check(&repo.path, &wt, None).unwrap().task_merged);

        let wt2 = task(&repo, "b");
        commit_in(&wt2, "u.txt", "u");
        squash(&repo.path, &wt2, "main").unwrap();
        let c = check(&repo.path, &wt2, None).unwrap();
        assert!(c.main_staged && !c.task_merged);
    }

    #[test]
    fn check_refuses_when_there_is_nothing_to_bring_back() {
        let repo = TempRepo::new();
        let wt = task(&repo, "a");
        assert_eq!(
            code(&check(&repo.path, &wt, None).unwrap()),
            Some("nothing")
        );
        std::fs::write(wt.join("x.txt"), "x").unwrap();
        assert_eq!(check(&repo.path, &wt, None).unwrap().refusal, None);
    }

    #[test]
    fn check_refuses_a_locked_or_unowned_worktree() {
        let repo = TempRepo::new();
        let wt = task(&repo, "a");
        commit_in(&wt, "t.txt", "t");
        repo.git(&["worktree", "lock", wt.to_str().unwrap()]);
        assert_eq!(
            code(&check(&repo.path, &wt, None).unwrap()),
            Some("untouchable")
        );
        let plain = repo.sandbox.join("plain");
        repo.git(&[
            "worktree",
            "add",
            "-q",
            "-b",
            "plain",
            plain.to_str().unwrap(),
        ]);
        assert_eq!(
            code(&check(&repo.path, &plain, Some("main")).unwrap()),
            Some("not-owned")
        );
    }

    #[test]
    fn prepare_commits_wip_without_hooks_and_snapshots_both_sides() {
        let repo = TempRepo::new();
        let wt = task(&repo, "a");
        commit_in(&wt, "t.txt", "t");
        std::fs::write(wt.join("wip.txt"), "unsaved").unwrap();
        // A hook that would fail the commit: it must not run.
        let hooks = repo.sandbox.join("hooks");
        std::fs::create_dir_all(&hooks).unwrap();
        std::fs::write(hooks.join("pre-commit"), "#!/bin/sh\nexit 1\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(
                hooks.join("pre-commit"),
                std::fs::Permissions::from_mode(0o755),
            )
            .unwrap();
        }
        repo.git(&["config", "core.hooksPath", hooks.to_str().unwrap()]);
        let p = prepare(&repo.path, &wt, "main", none).unwrap();
        assert!(p.committed_wip);
        assert_eq!(
            git_at(&wt, &["log", "-1", "--format=%s"]),
            "wip(a): uncommitted work at merge-back"
        );
        assert!(git_at(&wt, &["status", "--porcelain"]).is_empty());
        let ts = p.task_snapshot.unwrap();
        assert_eq!(ts.kind, "merge-back-task");
        assert_eq!(ts.worktree.unwrap().branch.as_deref(), Some("task/a"));
        assert_eq!(p.main_snapshot.unwrap().kind, "merge-back");
        assert_eq!(p.check.task_commits, 2);
    }

    #[test]
    fn prepare_stops_on_survivors_and_refuses_a_refusal() {
        let repo = TempRepo::new();
        let wt = task(&repo, "a");
        std::fs::write(wt.join("wip.txt"), "unsaved").unwrap();
        let busy = |_: &Path| {
            Ok(vec![ProcInfo {
                pid: 7,
                ppid: 1,
                name: "agent".into(),
            }])
        };
        let p = prepare(&repo.path, &wt, "main", busy).unwrap();
        assert_eq!(p.survivors.len(), 1);
        assert!(!p.committed_wip && p.task_snapshot.is_none());
        assert!(wt.join("wip.txt").exists());
        assert!(!git_at(&wt, &["status", "--porcelain"]).is_empty());
        repo.git(&["checkout", "-q", "-b", "other"]);
        assert!(prepare(&repo.path, &wt, "main", none)
            .unwrap_err()
            .starts_with("wrong-branch:"));
    }

    #[test]
    fn squash_stages_the_task_and_reports_conflicts() {
        let repo = TempRepo::new();
        let wt = task(&repo, "a");
        commit_in(&wt, "t.txt", "task\n");
        repo.commit("m.txt", "main\n", "main moves");
        assert_eq!(
            squash(&repo.path, &wt, "main").unwrap(),
            StepResult { conflicts: false }
        );
        assert_eq!(repo.git(&["diff", "--cached", "--name-only"]), "t.txt");
        repo.git(&["commit", "-q", "-m", "squashed"]);

        let wt2 = task(&repo, "b");
        commit_in(&wt2, "README.md", "task side\n");
        repo.commit("README.md", "main side\n", "main side");
        assert_eq!(
            squash(&repo.path, &wt2, "main").unwrap(),
            StepResult { conflicts: true }
        );
        assert!(repo
            .git(&["status", "--porcelain"])
            .contains("UU README.md"));
    }

    #[test]
    fn fast_forward_refuses_mid_rebase_then_moves_the_target() {
        let repo = TempRepo::new();
        let wt = task(&repo, "a");
        commit_in(&wt, "README.md", "task side\n");
        repo.commit("README.md", "main side\n", "main side");
        let _ = std::process::Command::new(crate::git::git_binary())
            .args(["rebase", "main"])
            .current_dir(&wt)
            .output();
        assert!(fast_forward(&repo.path, &wt, "main").is_err());
        std::fs::write(wt.join("README.md"), "resolved\n").unwrap();
        git_at(&wt, &["add", "README.md"]);
        let _ = std::process::Command::new(crate::git::git_binary())
            .args(["-c", "core.editor=true", "rebase", "--continue"])
            .current_dir(&wt)
            .output();
        fast_forward(&repo.path, &wt, "main").unwrap();
        assert_eq!(
            repo.git(&["rev-parse", "main"]),
            git_at(&wt, &["rev-parse", "HEAD"])
        );
        assert_eq!(
            std::fs::read_to_string(repo.path.join("README.md")).unwrap(),
            "resolved\n"
        );
    }
}

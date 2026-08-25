//! Repo snapshots (v3.8 Time Machine).
//!
//! A snapshot is a restorable capture of HEAD + index (including conflict
//! stages) + working tree (including untracked, gitignore-respecting) files,
//! written with git plumbing and anchored under `refs/gitwand/snapshots/`.
//!
//! Shape (mirrors `git stash create`, plus untracked files and stages):
//!
//! ```text
//! refs/gitwand/snapshots/<id> ── snapshotCommit   tree = worktreeTree
//!                                 ├─ parent 1 = pre-op HEAD
//!                                 └─ parent 2 = metaCommit  tree = { index-info }
//! ```
//!
//! Discipline: every function here is lock-free. Callers that are already
//! inside a `#[tauri::command]` hold the `repo_lock` write guard; taking a
//! second guard for the same cwd would deadlock.

use super::cmd::git_cmd;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

/// Ref namespace for snapshots. Excluded from every `--all` traversal
/// (see `commands/read.rs` and `dev-server.mjs`) so snapshots never show up
/// in the Git Tree, and never pushed by the default refspec.
pub(crate) const SNAPSHOT_REF_PREFIX: &str = "refs/gitwand/snapshots";

/// One snapshot, as stored in the snapshot commit's message (JSON) and
/// returned to the frontend.
///
/// camelCase on the wire: the same serde impl serialises the commit message
/// AND the IPC payload, so the TS `SnapshotMeta` and the dev-server route
/// need no hand-written mapping layer.
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotMeta {
    /// Sortable id, also the ref leaf: `<unix_ms>-<short sha>`.
    pub id: String,
    /// Full sha of the snapshot commit.
    pub commit: String,
    /// What triggered it: "manual" | "discard" | "reset" | "checkout" |
    /// "resolution" | "pre-restore".
    pub kind: String,
    /// Short human label ("Discard 3 files").
    pub label: String,
    pub timestamp_ms: u64,
    /// HEAD sha before the operation.
    pub head_sha: String,
    /// Branch short name, or `None` when HEAD was detached.
    pub head_ref: Option<String>,
    /// MERGE_HEAD sha when the snapshot was taken mid-merge.
    pub merge_head: Option<String>,
}

/// Run a git command in `cwd` and return trimmed stdout, or the stderr as Err.
fn run(cwd: &str, args: &[&str]) -> Result<String, String> {
    let out = git_cmd()
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|e| format!("failed to run git {:?}: {}", args, e))?;
    if !out.status.success() {
        return Err(format!(
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Same as `run`, but with `GIT_INDEX_FILE` pointed at a scratch index.
fn run_with_index(cwd: &str, index: &Path, args: &[&str]) -> Result<String, String> {
    let out = git_cmd()
        .args(args)
        .env("GIT_INDEX_FILE", index)
        .current_dir(cwd)
        .output()
        .map_err(|e| format!("failed to run git {:?}: {}", args, e))?;
    if !out.status.success() {
        return Err(format!(
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Last timestamp handed out by `stamp_ms`, so ids stay strictly increasing.
static LAST_STAMP_MS: AtomicU64 = AtomicU64::new(0);

/// A snapshot timestamp that never repeats within this process.
///
/// The id (`<ts>-<short sha>`) is what the timeline sorts on. Two snapshots
/// created inside the same millisecond would sort by sha, i.e. arbitrarily,
/// and a bulk operation can plausibly do that. Bumping to `last + 1` costs at
/// most a few milliseconds of drift on the recorded time and buys a stable
/// creation order.
fn stamp_ms() -> u64 {
    let now = now_ms();
    loop {
        let last = LAST_STAMP_MS.load(Ordering::SeqCst);
        let next = if now > last { now } else { last + 1 };
        if LAST_STAMP_MS
            .compare_exchange(last, next, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
        {
            return next;
        }
    }
}

/// Absolute path of the git dir for `cwd`. For a linked worktree this is
/// `.git/worktrees/<name>`, which is exactly where that worktree's index and
/// MERGE_HEAD live, so scratch files land in the right place by construction.
fn git_dir(cwd: &str) -> Result<PathBuf, String> {
    Ok(PathBuf::from(run(
        cwd,
        &["rev-parse", "--absolute-git-dir"],
    )?))
}

/// A scratch path under the git dir. Never place scratch files inside the
/// working tree: `git add -A .` would add the scratch file to the snapshot.
fn scratch(dir: &Path, tag: &str) -> PathBuf {
    dir.join(format!(
        "gitwand-snapshot-{}-{}-{}",
        tag,
        std::process::id(),
        now_ms()
    ))
}

/// Capture the current repo state. Returns `Ok(None)` when there is no HEAD
/// (freshly `git init`-ed repo): there is nothing to anchor a snapshot to.
///
/// Lock-free by design, see the module doc.
pub(crate) fn create_snapshot_inner(
    cwd: &str,
    kind: &str,
    label: &str,
) -> Result<Option<SnapshotMeta>, String> {
    let head_sha = match run(cwd, &["rev-parse", "HEAD"]) {
        Ok(s) if !s.is_empty() => s,
        _ => return Ok(None),
    };
    let head_ref = run(cwd, &["symbolic-ref", "--quiet", "--short", "HEAD"])
        .ok()
        .filter(|s| !s.is_empty());
    let merge_head = run(cwd, &["rev-parse", "--quiet", "--verify", "MERGE_HEAD"])
        .ok()
        .filter(|s| !s.is_empty());

    let dir = git_dir(cwd)?;

    // ── 1. worktreeTree: a copy of the real index, then `add -A`.
    let tmp_index = scratch(&dir, "index");
    let real_index = dir.join("index");
    if real_index.exists() {
        std::fs::copy(&real_index, &tmp_index)
            .map_err(|e| format!("failed to copy index: {}", e))?;
    }
    let worktree_tree = (|| -> Result<String, String> {
        run_with_index(cwd, &tmp_index, &["add", "-A", "."])?;
        run_with_index(cwd, &tmp_index, &["write-tree"])
    })();
    let _ = std::fs::remove_file(&tmp_index);
    let worktree_tree = worktree_tree?;

    // ── 2. metaTree: { "index-info": <blob of `git ls-files -s`> }.
    //    `write-tree` cannot be used on the real index here: it errors out on
    //    a conflicted index ("a.txt: unmerged"). `ls-files -s` round-trips
    //    stages 1/2/3 through `update-index --index-info` on restore.
    let info_path = scratch(&dir, "info");
    let info = run(cwd, &["ls-files", "-s"])?;
    std::fs::write(&info_path, format!("{}\n", info))
        .map_err(|e| format!("failed to write index-info: {}", e))?;
    let info_blob = run(
        cwd,
        &["hash-object", "-w", info_path.to_str().unwrap_or_default()],
    );
    let _ = std::fs::remove_file(&info_path);
    let info_blob = info_blob?;

    let meta_index = scratch(&dir, "meta");
    let meta_tree = (|| -> Result<String, String> {
        run_with_index(
            cwd,
            &meta_index,
            &[
                "update-index",
                "--add",
                "--cacheinfo",
                &format!("100644,{},index-info", info_blob),
            ],
        )?;
        run_with_index(cwd, &meta_index, &["write-tree"])
    })();
    let _ = std::fs::remove_file(&meta_index);
    let meta_tree = meta_tree?;
    let meta_commit = run(
        cwd,
        &["commit-tree", &meta_tree, "-m", "gitwand-snapshot-meta"],
    )?;

    // ── 3. snapshotCommit + ref.
    let timestamp_ms = stamp_ms();
    let mut meta = SnapshotMeta {
        id: String::new(),
        commit: String::new(),
        kind: kind.to_string(),
        label: label.to_string(),
        timestamp_ms,
        head_sha: head_sha.clone(),
        head_ref,
        merge_head,
    };
    let message = serde_json::to_string(&meta).map_err(|e| e.to_string())?;
    let commit = run(
        cwd,
        &[
            "commit-tree",
            &worktree_tree,
            "-p",
            &head_sha,
            "-p",
            &meta_commit,
            "-m",
            &message,
        ],
    )?;

    let id = format!("{}-{}", timestamp_ms, &commit[..commit.len().min(8)]);
    run(
        cwd,
        &[
            "update-ref",
            &format!("{}/{}", SNAPSHOT_REF_PREFIX, id),
            &commit,
        ],
    )?;

    meta.id = id;
    meta.commit = commit;
    Ok(Some(meta))
}

/// All snapshots for `cwd`, newest first.
pub(crate) fn list_snapshots_inner(cwd: &str) -> Result<Vec<SnapshotMeta>, String> {
    // Unit separator between fields, record separator between refs: the
    // commit body is JSON and may contain anything but these control chars.
    let raw = run(
        cwd,
        &[
            "for-each-ref",
            "--format=%(refname:lstrip=3)%1f%(objectname)%1f%(contents:subject)%1e",
            SNAPSHOT_REF_PREFIX,
        ],
    )?;

    let mut out: Vec<SnapshotMeta> = Vec::new();
    for record in raw.split('\u{1e}') {
        let record = record.trim_matches(['\n', '\r']);
        if record.is_empty() {
            continue;
        }
        let mut parts = record.split('\u{1f}');
        let (id, commit, subject) = match (parts.next(), parts.next(), parts.next()) {
            (Some(a), Some(b), Some(c)) => (a, b, c),
            _ => continue,
        };
        // A ref whose message is not our JSON is ignored rather than fatal:
        // the namespace is user-visible and could hold hand-made refs.
        let Ok(mut meta) = serde_json::from_str::<SnapshotMeta>(subject) else {
            continue;
        };
        meta.id = id.to_string();
        meta.commit = commit.to_string();
        out.push(meta);
    }

    out.sort_by(|a, b| b.timestamp_ms.cmp(&a.timestamp_ms).then(b.id.cmp(&a.id)));
    Ok(out)
}

/// Restore the repo to the state captured by snapshot `id`.
///
/// A `pre-restore` snapshot is taken first, so the restore is itself
/// undoable: the returned meta is the redo target.
///
/// Uses plumbing (`update-ref` / `read-tree`) rather than `checkout`, so it
/// cannot refuse on a dirty tree, which is the whole point of an undo.
///
/// Lock-free by design, see the module doc.
pub(crate) fn restore_snapshot_inner(cwd: &str, id: &str) -> Result<SnapshotMeta, String> {
    let target = list_snapshots_inner(cwd)?
        .into_iter()
        .find(|s| s.id == id)
        .ok_or_else(|| format!("snapshot {} not found", id))?;

    let redo = create_snapshot_inner(cwd, "pre-restore", &format!("before restoring {}", id))?
        .ok_or_else(|| "cannot snapshot current state before restore".to_string())?;

    // ── 1. HEAD. Move the ref, never `checkout`: the worktree is fixed in
    //    step 2 anyway, and `checkout` would refuse on a dirty tree.
    //
    //    Every ref move here is labelled with `-m`. Without it git writes a
    //    reflog entry with an EMPTY message, which shows up as a blank row in
    //    the Time Machine timeline and, worse, as an unexplained line in the
    //    user's own `git reflog`. Caught in manual QA.
    let reason = format!("gitwand: restore snapshot {}", id);
    match target.head_ref.as_deref() {
        Some(branch) => {
            let full = format!("refs/heads/{}", branch);
            run(cwd, &["update-ref", "-m", &reason, &full, &target.head_sha])?;
            run(cwd, &["symbolic-ref", "-m", &reason, "HEAD", &full])?;
        }
        None => {
            run(
                cwd,
                &[
                    "update-ref",
                    "-m",
                    &reason,
                    "--no-deref",
                    "HEAD",
                    &target.head_sha,
                ],
            )?;
        }
    }

    // ── 2. Working tree + index from the snapshot's tree.
    run(
        cwd,
        &[
            "read-tree",
            "-u",
            "--reset",
            &format!("{}^{{tree}}", target.commit),
        ],
    )?;

    // ── 3. Exact index, including conflict stages 1/2/3.
    //
    //    Built in a SCRATCH index and moved into place only once
    //    `update-index` has succeeded. Emptying the live index first and
    //    repopulating it in place is the obvious shape, but it leaves the
    //    repo with a wiped index whenever the second step fails (truncated
    //    meta blob, a mode git rejects, an aggressive `gc --prune=now`,
    //    disk full): every tracked file then reads as deleted-from-index,
    //    with no rollback and no obvious recovery for the user.
    //
    //    A scratch `GIT_INDEX_FILE` that does not exist yet starts out empty,
    //    so no explicit `read-tree --empty` is needed. The final `rename` is
    //    within the git dir, hence same-filesystem and atomic. It bypasses
    //    git's `index.lock` protocol, which is acceptable here because the
    //    caller holds the repo write guard for the whole restore; the
    //    alternative (`write-tree` on the scratch index) is not available,
    //    since `write-tree` refuses an index carrying conflict stages.
    let dir = git_dir(cwd)?;
    let info_path = scratch(&dir, "restore");
    let staged_index = scratch(&dir, "restore-index");
    let info = run(
        cwd,
        &[
            "cat-file",
            "blob",
            &format!("{}^2:index-info", target.commit),
        ],
    )?;
    std::fs::write(&info_path, format!("{}\n", info))
        .map_err(|e| format!("failed to write index-info: {}", e))?;
    let applied = (|| -> Result<(), String> {
        let file = std::fs::File::open(&info_path)
            .map_err(|e| format!("failed to open index-info: {}", e))?;
        let out = git_cmd()
            .args(["update-index", "--index-info"])
            .env("GIT_INDEX_FILE", &staged_index)
            .stdin(Stdio::from(file))
            .current_dir(cwd)
            .output()
            .map_err(|e| format!("failed to run git update-index: {}", e))?;
        if !out.status.success() {
            return Err(format!(
                "git update-index --index-info failed: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
        std::fs::rename(&staged_index, dir.join("index"))
            .map_err(|e| format!("failed to install the restored index: {}", e))
    })();
    let _ = std::fs::remove_file(&info_path);
    let _ = std::fs::remove_file(&staged_index);
    applied?;

    // ── 4. Merge state, made to MATCH the snapshot in both directions.
    //
    //    `read-tree` restores index stages but knows nothing about MERGE_HEAD,
    //    so this has to be driven explicitly. Writing it when the snapshot had
    //    one is the obvious half; clearing it when the snapshot did NOT is the
    //    half that matters just as much. Rewinding past the start of a merge
    //    while leaving MERGE_HEAD on disk makes `git status` report "you are
    //    still merging" over a tree that no longer contains the merge, and
    //    turns the next commit into a merge commit that silently re-merges the
    //    branch the user just undid.
    let merge_head_path = dir.join("MERGE_HEAD");
    match target.merge_head {
        Some(ref mh) => {
            std::fs::write(&merge_head_path, format!("{}\n", mh))
                .map_err(|e| format!("failed to restore MERGE_HEAD: {}", e))?;
        }
        None => {
            if merge_head_path.exists() {
                std::fs::remove_file(&merge_head_path)
                    .map_err(|e| format!("failed to clear MERGE_HEAD: {}", e))?;
            }
            // MERGE_MSG is git's prefilled merge commit message. Left behind,
            // it silently becomes the default message for the user's next,
            // unrelated commit.
            let merge_msg_path = dir.join("MERGE_MSG");
            if merge_msg_path.exists() {
                std::fs::remove_file(&merge_msg_path)
                    .map_err(|e| format!("failed to clear MERGE_MSG: {}", e))?;
            }
        }
    }

    Ok(redo)
}

/// Delete snapshot refs older than `max_age_days` or beyond `max_count`,
/// newest kept. Returns the number of refs deleted.
///
/// Only refs are deleted; the objects are reclaimed by git's own `gc`, which
/// is why a snapshot costs nothing once pruned.
pub(crate) fn prune_snapshots_inner(
    cwd: &str,
    max_age_days: u32,
    max_count: usize,
) -> Result<usize, String> {
    // Refuse the degenerate retention rather than obey it. A 0-day or 0-count
    // cap means "delete every snapshot", which is never what someone
    // configuring a safety net intends, and this is the last layer before the
    // refs actually go. The frontend clamps at the input and guards again in
    // `useSnapshots.prune`; both of those are one edit away from regressing,
    // and a hand-edited settings file bypasses them entirely.
    if max_age_days < 1 || max_count < 1 {
        return Err(format!(
            "refusing a retention that would delete every snapshot \
             (max_age_days={}, max_count={})",
            max_age_days, max_count
        ));
    }

    let all = list_snapshots_inner(cwd)?; // newest first
    let cutoff = now_ms().saturating_sub(u64::from(max_age_days) * 86_400_000);

    let mut deleted = 0usize;
    for (idx, snap) in all.iter().enumerate() {
        let too_many = idx >= max_count;
        let too_old = snap.timestamp_ms < cutoff;
        if !too_many && !too_old {
            continue;
        }
        run(
            cwd,
            &[
                "update-ref",
                "-d",
                &format!("{}/{}", SNAPSHOT_REF_PREFIX, snap.id),
            ],
        )?;
        deleted += 1;
    }
    Ok(deleted)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::cmd::git_binary;
    use std::path::PathBuf;
    use std::process::Command;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static COUNTER: AtomicUsize = AtomicUsize::new(0);

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
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let dir = std::env::temp_dir().join(format!(
                "gitwand-snapshot-test-{}-{}-{}",
                std::process::id(),
                n,
                nanos
            ));
            std::fs::create_dir_all(&dir).unwrap();
            let repo = TempRepo { path: dir };
            repo.git(&["init", "-q", "-b", "main"]);
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

        /// Like `git`, but with `GIT_INDEX_FILE` pointed at a scratch index.
        fn git_with_index(&self, index: &std::path::Path, args: &[&str]) -> String {
            let out = Command::new(git_binary())
                .args(args)
                .env("GIT_INDEX_FILE", index)
                .current_dir(&self.path)
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "git {:?} failed: {}",
                args,
                String::from_utf8_lossy(&out.stderr)
            );
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        }

        /// Like `git`, but tolerates a non-zero exit (merge conflicts).
        fn git_may_fail(&self, args: &[&str]) {
            let _ = Command::new(git_binary())
                .args(args)
                .current_dir(&self.path)
                .output();
        }

        fn write(&self, rel: &str, content: &str) {
            let p = self.path.join(rel);
            if let Some(parent) = p.parent() {
                std::fs::create_dir_all(parent).unwrap();
            }
            std::fs::write(p, content).unwrap();
        }
    }

    #[test]
    fn create_captures_untracked_and_unstaged() {
        let repo = TempRepo::new();
        repo.write("a.txt", "v1\n");
        repo.git(&["add", "."]);
        repo.git(&["commit", "-qm", "c1"]);
        repo.write("a.txt", "v2\n");
        repo.write("u.txt", "untracked\n");

        let meta = create_snapshot_inner(repo.cwd(), "manual", "test")
            .expect("snapshot failed")
            .expect("expected a snapshot");

        assert_eq!(meta.kind, "manual");
        assert_eq!(meta.head_ref.as_deref(), Some("main"));

        // Both the modified tracked file and the untracked file are in the tree.
        let listing = String::from_utf8_lossy(
            &repo
                .git(&[
                    "ls-tree",
                    "--name-only",
                    &format!("{}^{{tree}}", meta.commit),
                ])
                .stdout,
        )
        .to_string();
        assert!(listing.contains("a.txt"), "listing: {}", listing);
        assert!(listing.contains("u.txt"), "listing: {}", listing);

        // No temp index leaked into the tree.
        assert!(
            !listing.contains("gitwand-snapshot"),
            "listing: {}",
            listing
        );
    }

    #[test]
    fn create_works_on_a_conflicted_index() {
        let repo = TempRepo::new();
        repo.write("a.txt", "base\n");
        repo.git(&["add", "."]);
        repo.git(&["commit", "-qm", "base"]);
        repo.git(&["checkout", "-qb", "feat"]);
        repo.write("a.txt", "theirs\n");
        repo.git(&["commit", "-qam", "theirs"]);
        repo.git(&["checkout", "-q", "main"]);
        repo.write("a.txt", "ours\n");
        repo.git(&["commit", "-qam", "ours"]);
        repo.git_may_fail(&["merge", "feat"]);

        let meta = create_snapshot_inner(repo.cwd(), "resolution", "pre-resolve")
            .expect("snapshot failed on conflicted index")
            .expect("expected a snapshot");

        assert!(meta.merge_head.is_some(), "MERGE_HEAD should be recorded");

        // The meta commit carries the three unmerged stages verbatim.
        let info = String::from_utf8_lossy(
            &repo
                .git(&["cat-file", "blob", &format!("{}^2:index-info", meta.commit)])
                .stdout,
        )
        .to_string();
        assert!(info.contains(" 1\ta.txt"), "info: {}", info);
        assert!(info.contains(" 2\ta.txt"), "info: {}", info);
        assert!(info.contains(" 3\ta.txt"), "info: {}", info);
    }

    #[test]
    fn create_on_repo_without_head_returns_none() {
        let repo = TempRepo::new();
        repo.write("a.txt", "v1\n");
        assert_eq!(
            create_snapshot_inner(repo.cwd(), "manual", "x").unwrap(),
            None
        );
    }

    #[test]
    fn list_returns_newest_first() {
        let repo = TempRepo::new();
        repo.write("a.txt", "v1\n");
        repo.git(&["add", "."]);
        repo.git(&["commit", "-qm", "c1"]);

        repo.write("a.txt", "v2\n");
        let first = create_snapshot_inner(repo.cwd(), "discard", "one")
            .unwrap()
            .unwrap();
        repo.write("a.txt", "v3\n");
        let second = create_snapshot_inner(repo.cwd(), "reset", "two")
            .unwrap()
            .unwrap();

        let list = list_snapshots_inner(repo.cwd()).unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].id, second.id);
        assert_eq!(list[0].label, "two");
        assert_eq!(list[1].id, first.id);
        assert_eq!(list[1].kind, "discard");
    }

    #[test]
    fn restore_brings_back_worktree_untracked_and_deleted_files() {
        let repo = TempRepo::new();
        repo.write("a.txt", "v1\n");
        repo.write("k.txt", "keep\n");
        repo.git(&["add", "."]);
        repo.git(&["commit", "-qm", "c1"]);
        repo.write("a.txt", "dirty\n");
        repo.write("u.txt", "untracked\n");

        let snap = create_snapshot_inner(repo.cwd(), "manual", "before")
            .unwrap()
            .unwrap();

        // Destructive op: clobber the tracked file, delete both the untracked
        // file and a tracked one.
        repo.write("a.txt", "clobbered\n");
        std::fs::remove_file(repo.path.join("u.txt")).unwrap();
        std::fs::remove_file(repo.path.join("k.txt")).unwrap();

        let redo = restore_snapshot_inner(repo.cwd(), &snap.id).unwrap();
        assert_eq!(redo.kind, "pre-restore");

        assert_eq!(
            std::fs::read_to_string(repo.path.join("a.txt")).unwrap(),
            "dirty\n"
        );
        assert_eq!(
            std::fs::read_to_string(repo.path.join("u.txt")).unwrap(),
            "untracked\n"
        );
        assert_eq!(
            std::fs::read_to_string(repo.path.join("k.txt")).unwrap(),
            "keep\n"
        );
    }

    #[test]
    fn restore_rebuilds_conflict_stages() {
        let repo = TempRepo::new();
        repo.write("a.txt", "base\n");
        repo.git(&["add", "."]);
        repo.git(&["commit", "-qm", "base"]);
        repo.git(&["checkout", "-qb", "feat"]);
        repo.write("a.txt", "theirs\n");
        repo.git(&["commit", "-qam", "theirs"]);
        repo.git(&["checkout", "-q", "main"]);
        repo.write("a.txt", "ours\n");
        repo.git(&["commit", "-qam", "ours"]);
        repo.git_may_fail(&["merge", "feat"]);

        let snap = create_snapshot_inner(repo.cwd(), "resolution", "pre-resolve")
            .unwrap()
            .unwrap();

        // Simulate an auto-resolution: clean content, staged, stages gone.
        repo.write("a.txt", "resolved\n");
        repo.git(&["add", "a.txt"]);
        assert!(
            String::from_utf8_lossy(&repo.git(&["ls-files", "-u"]).stdout)
                .trim()
                .is_empty()
        );

        restore_snapshot_inner(repo.cwd(), &snap.id).unwrap();

        let staged = String::from_utf8_lossy(&repo.git(&["ls-files", "-u"]).stdout).to_string();
        assert!(staged.contains(" 1\ta.txt"), "stages: {}", staged);
        assert!(staged.contains(" 2\ta.txt"), "stages: {}", staged);
        assert!(staged.contains(" 3\ta.txt"), "stages: {}", staged);

        let content = std::fs::read_to_string(repo.path.join("a.txt")).unwrap();
        assert!(content.contains("<<<<<<<"), "content: {}", content);
    }

    #[test]
    fn restore_clears_a_merge_started_after_the_snapshot() {
        let repo = TempRepo::new();
        repo.write("a.txt", "base\n");
        repo.git(&["add", "."]);
        repo.git(&["commit", "-qm", "base"]);
        repo.git(&["checkout", "-qb", "feat"]);
        repo.write("a.txt", "theirs\n");
        repo.git(&["commit", "-qam", "theirs"]);
        repo.git(&["checkout", "-q", "main"]);
        repo.write("a.txt", "ours\n");
        repo.git(&["commit", "-qam", "ours"]);

        // Snapshot taken with NO merge in progress.
        let snap = create_snapshot_inner(repo.cwd(), "manual", "before merge")
            .unwrap()
            .unwrap();
        assert!(snap.merge_head.is_none());

        // The user then starts a merge that conflicts.
        repo.git_may_fail(&["merge", "feat"]);
        let dir = repo.path.join(".git");
        assert!(
            dir.join("MERGE_HEAD").exists(),
            "setup: merge should be in progress"
        );

        restore_snapshot_inner(repo.cwd(), &snap.id).unwrap();

        // Rewinding past the merge must also rewind the merge STATE. Leaving
        // MERGE_HEAD behind makes `git status` say "you are still merging" and
        // turns the next commit into a merge commit that silently re-merges
        // the branch the user just undid.
        assert!(
            !dir.join("MERGE_HEAD").exists(),
            "MERGE_HEAD survived a restore to a pre-merge snapshot"
        );
        assert!(!dir.join("MERGE_MSG").exists(), "MERGE_MSG survived too");
        assert_eq!(
            std::fs::read_to_string(repo.path.join("a.txt")).unwrap(),
            "ours\n"
        );
    }

    #[test]
    fn restore_brings_back_a_merge_that_was_concluded() {
        let repo = TempRepo::new();
        repo.write("a.txt", "base\n");
        repo.git(&["add", "."]);
        repo.git(&["commit", "-qm", "base"]);
        repo.git(&["checkout", "-qb", "feat"]);
        repo.write("a.txt", "theirs\n");
        repo.git(&["commit", "-qam", "theirs"]);
        repo.git(&["checkout", "-q", "main"]);
        repo.write("a.txt", "ours\n");
        repo.git(&["commit", "-qam", "ours"]);
        repo.git_may_fail(&["merge", "feat"]);

        // Snapshot taken mid-merge, then the user concludes the merge.
        let snap = create_snapshot_inner(repo.cwd(), "resolution", "mid-merge")
            .unwrap()
            .unwrap();
        assert!(snap.merge_head.is_some());
        repo.write("a.txt", "resolved\n");
        repo.git(&["add", "a.txt"]);
        repo.git(&["commit", "-qm", "merged"]);
        let dir = repo.path.join(".git");
        assert!(!dir.join("MERGE_HEAD").exists(), "setup: merge concluded");

        restore_snapshot_inner(repo.cwd(), &snap.id).unwrap();

        assert!(
            dir.join("MERGE_HEAD").exists(),
            "restoring a mid-merge snapshot must put the merge back in progress"
        );
    }

    #[test]
    fn restore_moves_head_back_after_a_reset() {
        let repo = TempRepo::new();
        repo.write("a.txt", "v1\n");
        repo.git(&["add", "."]);
        repo.git(&["commit", "-qm", "c1"]);
        repo.write("a.txt", "v2\n");
        repo.git(&["commit", "-qam", "c2"]);
        let before = String::from_utf8_lossy(&repo.git(&["rev-parse", "HEAD"]).stdout)
            .trim()
            .to_string();

        let snap = create_snapshot_inner(repo.cwd(), "reset", "before reset")
            .unwrap()
            .unwrap();
        repo.git(&["reset", "--hard", "HEAD~1"]);

        restore_snapshot_inner(repo.cwd(), &snap.id).unwrap();

        let after = String::from_utf8_lossy(&repo.git(&["rev-parse", "HEAD"]).stdout)
            .trim()
            .to_string();
        assert_eq!(after, before);
        // Still on the branch, not detached.
        let head_ref =
            String::from_utf8_lossy(&repo.git(&["symbolic-ref", "--short", "HEAD"]).stdout)
                .trim()
                .to_string();
        assert_eq!(head_ref, "main");
    }

    #[test]
    fn a_failing_index_restore_leaves_the_live_index_intact() {
        let repo = TempRepo::new();
        repo.write("a.txt", "v1\n");
        repo.write("b.txt", "v1\n");
        repo.git(&["add", "."]);
        repo.git(&["commit", "-qm", "c1"]);
        repo.write("b.txt", "staged edit\n");
        repo.git(&["add", "b.txt"]);
        let before = String::from_utf8_lossy(&repo.git(&["ls-files", "-s"]).stdout).to_string();
        assert!(!before.trim().is_empty(), "setup: index must not be empty");

        // Hand-build a snapshot whose meta blob is NOT valid index-info, which
        // is what a truncated blob or an aggressive `gc --prune=now` looks
        // like from the restore's point of view.
        let worktree_tree = String::from_utf8_lossy(&repo.git(&["write-tree"]).stdout)
            .trim()
            .to_string();
        repo.write("garbage-info", "this is not index-info\n");
        let bad_blob =
            String::from_utf8_lossy(&repo.git(&["hash-object", "-w", "garbage-info"]).stdout)
                .trim()
                .to_string();
        std::fs::remove_file(repo.path.join("garbage-info")).unwrap();
        let meta_index = repo.path.join(".git").join("test-meta-index");
        repo.git_with_index(
            &meta_index,
            &[
                "update-index",
                "--add",
                "--cacheinfo",
                &format!("100644,{},index-info", bad_blob),
            ],
        );
        let meta_tree = repo.git_with_index(&meta_index, &["write-tree"]);
        let _ = std::fs::remove_file(&meta_index);
        let meta_commit =
            String::from_utf8_lossy(&repo.git(&["commit-tree", &meta_tree, "-m", "meta"]).stdout)
                .trim()
                .to_string();
        let head = String::from_utf8_lossy(&repo.git(&["rev-parse", "HEAD"]).stdout)
            .trim()
            .to_string();
        let meta_json = format!(
            r#"{{"id":"","commit":"","kind":"manual","label":"bad","timestampMs":1,"headSha":"{}","headRef":"main","mergeHead":null}}"#,
            head
        );
        let bad_commit = String::from_utf8_lossy(
            &repo
                .git(&[
                    "commit-tree",
                    &worktree_tree,
                    "-p",
                    &head,
                    "-p",
                    &meta_commit,
                    "-m",
                    &meta_json,
                ])
                .stdout,
        )
        .trim()
        .to_string();
        repo.git(&[
            "update-ref",
            "refs/gitwand/snapshots/1-deadbeef",
            &bad_commit,
        ]);

        let res = restore_snapshot_inner(repo.cwd(), "1-deadbeef");
        assert!(
            res.is_err(),
            "restore should fail on an unusable index-info"
        );

        // The live index must be untouched. Emptying it first and repopulating
        // in place would leave every tracked file looking deleted, with no
        // rollback and no obvious way for the user to recover.
        let after = String::from_utf8_lossy(&repo.git(&["ls-files", "-s"]).stdout).to_string();
        assert_eq!(after, before, "the failed restore wiped the live index");
    }

    #[test]
    fn prune_respects_count_cap_and_keeps_newest() {
        let repo = TempRepo::new();
        repo.write("a.txt", "v1\n");
        repo.git(&["add", "."]);
        repo.git(&["commit", "-qm", "c1"]);

        let mut ids = Vec::new();
        for i in 0..5 {
            repo.write("a.txt", &format!("v{}\n", i));
            ids.push(
                create_snapshot_inner(repo.cwd(), "manual", "x")
                    .unwrap()
                    .unwrap()
                    .id,
            );
        }

        let deleted = prune_snapshots_inner(repo.cwd(), 365, 2).unwrap();
        assert_eq!(deleted, 3);

        let list = list_snapshots_inner(repo.cwd()).unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].id, ids[4]);
        assert_eq!(list[1].id, ids[3]);
    }

    #[test]
    fn prune_refuses_a_retention_that_would_delete_everything() {
        let repo = TempRepo::new();
        repo.write("a.txt", "v1\n");
        repo.git(&["add", "."]);
        repo.git(&["commit", "-qm", "c1"]);
        create_snapshot_inner(repo.cwd(), "manual", "keep me")
            .unwrap()
            .unwrap();

        for (days, count) in [(0u32, 200usize), (14, 0), (0, 0)] {
            assert!(
                prune_snapshots_inner(repo.cwd(), days, count).is_err(),
                "days={} count={} should be refused",
                days,
                count
            );
        }
        assert_eq!(
            list_snapshots_inner(repo.cwd()).unwrap().len(),
            1,
            "the refused prune must not have deleted anything"
        );
    }

    #[test]
    fn prune_respects_age_cap() {
        let repo = TempRepo::new();
        repo.write("a.txt", "v1\n");
        repo.git(&["add", "."]);
        repo.git(&["commit", "-qm", "c1"]);
        create_snapshot_inner(repo.cwd(), "manual", "x")
            .unwrap()
            .unwrap();

        // Backdate the snapshot's ref message so it reads as older than the
        // cap, rather than using a 0-day cap, which is now refused outright.
        let snaps = list_snapshots_inner(repo.cwd()).unwrap();
        let old_meta = format!(
            r#"{{"id":"","commit":"","kind":"manual","label":"old","timestampMs":1,"headSha":"{}","headRef":"main","mergeHead":null}}"#,
            snaps[0].head_sha
        );
        let tree = format!("{}^{{tree}}", snaps[0].commit);
        let backdated = String::from_utf8_lossy(
            &repo
                .git(&[
                    "commit-tree",
                    &tree,
                    "-p",
                    &snaps[0].head_sha,
                    "-m",
                    &old_meta,
                ])
                .stdout,
        )
        .trim()
        .to_string();
        repo.git(&[
            "update-ref",
            "-d",
            &format!("refs/gitwand/snapshots/{}", snaps[0].id),
        ]);
        repo.git(&["update-ref", "refs/gitwand/snapshots/1-oldsnap", &backdated]);

        let deleted = prune_snapshots_inner(repo.cwd(), 1, 100).unwrap();
        assert_eq!(deleted, 1);
        assert!(list_snapshots_inner(repo.cwd()).unwrap().is_empty());
    }
}

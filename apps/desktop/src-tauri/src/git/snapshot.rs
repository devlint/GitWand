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

// Transitional: the engine lands before the Tauri commands that consume it
// (`commands/snapshots.rs`) and before the `ops.rs` hooks. Clippy runs with
// `-D warnings`, so without this the intermediate commits are red on dead
// code alone. Removed once every function below has a caller.
#![allow(dead_code)]

use super::cmd::git_cmd;
use std::path::{Path, PathBuf};
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
    let timestamp_ms = now_ms();
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
}

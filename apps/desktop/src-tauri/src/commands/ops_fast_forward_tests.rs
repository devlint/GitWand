//! Real-repo tests for `git_fast_forward_to_upstream` (opt-in auto fast-forward).
//!
//! Every refused condition must name its reason AND leave HEAD and the working
//! tree exactly as they were.

use super::ops::{
    fast_forward_to_upstream_locked, git_fast_forward_to_upstream, FastForwardResult,
};
use crate::git::cmd::git_binary;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};

static COUNTER: AtomicU64 = AtomicU64::new(0);

/// A bare remote, a teammate clone and `me`, the clone under test.
struct Fixture {
    root: PathBuf,
    me: PathBuf,
    teammate: PathBuf,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn git(dir: &Path, args: &[&str]) -> std::process::Output {
    Command::new(git_binary())
        .args(args)
        .current_dir(dir)
        .env("GIT_AUTHOR_NAME", "Test")
        .env("GIT_AUTHOR_EMAIL", "t@example.com")
        .env("GIT_COMMITTER_NAME", "Test")
        .env("GIT_COMMITTER_EMAIL", "t@example.com")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_SYSTEM", "/dev/null")
        .env("GIT_EDITOR", "true")
        .output()
        .unwrap()
}

fn git_ok(dir: &Path, args: &[&str]) -> String {
    let out = git(dir, args);
    assert!(
        out.status.success(),
        "git {:?}: {}",
        args,
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).to_string()
}

fn commit(dir: &Path, file: &str, content: &str, msg: &str) {
    std::fs::write(dir.join(file), content).unwrap();
    git_ok(dir, &["add", file]);
    git_ok(dir, &["commit", "-q", "-m", msg]);
}

/// `me` is `behind` commits behind origin/main, already fetched.
fn fixture(behind: usize) -> Fixture {
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let root = std::env::temp_dir().join(format!(
        "gitwand-autoff-{}-{}-{}",
        std::process::id(),
        n,
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let remote = root.join("remote.git");
    let teammate = root.join("teammate");
    let me = root.join("me");
    let (r, t, m) = (
        remote.to_str().unwrap(),
        teammate.to_str().unwrap(),
        me.to_str().unwrap(),
    );
    git_ok(&root, &["init", "-q", "--bare", "-b", "main", r]);
    git_ok(&root, &["clone", "-q", r, t]);
    commit(&teammate, "f", "a\nb\nc\n", "base");
    git_ok(&teammate, &["push", "-q", "origin", "main"]);
    git_ok(&root, &["clone", "-q", r, m]);
    for i in 0..behind {
        commit(&teammate, &format!("t{i}"), "x\n", &format!("t{i}"));
    }
    git_ok(&teammate, &["push", "-q", "origin", "main"]);
    git_ok(&me, &["fetch", "-q"]);
    Fixture { root, me, teammate }
}

fn run(fx: &Fixture) -> FastForwardResult {
    fast_forward_to_upstream_locked(fx.me.to_str().unwrap()).unwrap()
}

fn head(dir: &Path) -> String {
    git_ok(dir, &["rev-parse", "HEAD"])
}

fn status(dir: &Path) -> String {
    git_ok(dir, &["status", "--porcelain"])
}

/// The refusal must name `reason` and leave HEAD and the tree untouched.
fn assert_refused(fx: &Fixture, reason: &str) {
    let (h, s) = (head(&fx.me), status(&fx.me));
    let r = run(fx);
    assert!(!r.fast_forwarded, "should not fast-forward: {:?}", r);
    assert_eq!(r.reason.as_deref(), Some(reason), "{:?}", r);
    assert_eq!(head(&fx.me), h, "HEAD moved");
    assert_eq!(status(&fx.me), s, "working tree changed");
}

/// Two commits touching the same line: `other` and a local `main` edit.
fn conflicting_commits(fx: &Fixture) {
    git_ok(&fx.me, &["checkout", "-q", "-b", "other"]);
    commit(&fx.me, "f", "a\nOTHER\nc\n", "other");
    git_ok(&fx.me, &["checkout", "-q", "main"]);
    commit(&fx.me, "f", "a\nMAIN\nc\n", "main-edit");
}

#[test]
fn purely_behind_fast_forwards_without_a_merge_commit() {
    let fx = fixture(2);
    let r = run(&fx);
    assert!(r.fast_forwarded, "{:?}", r);
    assert_eq!(r.behind, 2);
    assert_eq!(r.branch.as_deref(), Some("main"));
    assert_eq!(head(&fx.me), git_ok(&fx.me, &["rev-parse", "origin/main"]));
    assert_eq!(
        git_ok(&fx.me, &["rev-list", "--merges", "--count", "HEAD"]).trim(),
        "0"
    );
}

#[test]
fn command_wrapper_validates_cwd_and_fast_forwards() {
    let fx = fixture(1);
    let r = tauri::async_runtime::block_on(git_fast_forward_to_upstream(
        fx.me.to_str().unwrap().to_string(),
    ))
    .unwrap();
    assert!(r.fast_forwarded);
    assert!(
        tauri::async_runtime::block_on(git_fast_forward_to_upstream("relative/path".into()))
            .is_err()
    );
}

#[test]
fn untracked_files_do_not_block() {
    let fx = fixture(1);
    std::fs::write(fx.me.join("scratch.txt"), "x").unwrap();
    assert!(run(&fx).fast_forwarded);
}

#[test]
fn up_to_date_is_a_noop() {
    let fx = fixture(0);
    assert_refused(&fx, "upToDate");
}

#[test]
fn detached_head_is_refused() {
    let fx = fixture(1);
    git_ok(&fx.me, &["checkout", "-q", "--detach"]);
    assert_refused(&fx, "detached");
}

#[test]
fn no_upstream_is_refused() {
    let fx = fixture(1);
    git_ok(&fx.me, &["checkout", "-q", "-b", "local-only"]);
    assert_refused(&fx, "noUpstream");
}

#[test]
fn local_commits_are_refused_and_never_merged() {
    let fx = fixture(1);
    commit(&fx.me, "mine", "m\n", "mine");
    assert_refused(&fx, "localCommits");
}

#[test]
fn unstaged_tracked_edit_is_refused() {
    let fx = fixture(1);
    std::fs::write(fx.me.join("f"), "edited\n").unwrap();
    assert_refused(&fx, "trackedEdits");
}

#[test]
fn staged_edit_is_refused() {
    let fx = fixture(1);
    std::fs::write(fx.me.join("f"), "edited\n").unwrap();
    git_ok(&fx.me, &["add", "f"]);
    assert_refused(&fx, "trackedEdits");
}

#[test]
fn merge_in_progress_is_refused() {
    let fx = fixture(1);
    conflicting_commits(&fx);
    let _ = git(&fx.me, &["merge", "other"]);
    assert_refused(&fx, "operation");
}

#[test]
fn cherry_pick_in_progress_is_refused() {
    let fx = fixture(1);
    conflicting_commits(&fx);
    let _ = git(&fx.me, &["cherry-pick", "other"]);
    assert_refused(&fx, "operation");
}

#[test]
fn rebase_in_progress_is_refused() {
    let fx = fixture(1);
    conflicting_commits(&fx);
    let _ = git(&fx.me, &["rebase", "other"]);
    assert_refused(&fx, "operation");
}

#[test]
fn bisect_in_progress_is_refused() {
    let fx = fixture(1);
    git_ok(&fx.me, &["bisect", "start"]);
    assert_refused(&fx, "operation");
}

#[test]
fn conflicts_without_an_operation_marker_are_refused() {
    let fx = fixture(1);
    conflicting_commits(&fx);
    let _ = git(&fx.me, &["merge", "other"]);
    // Drop the marker, keep the unmerged index entries: only the status
    // check can still see them.
    let _ = std::fs::remove_file(fx.me.join(".git").join("MERGE_HEAD"));
    assert_refused(&fx, "conflicts");
}

#[test]
fn git_refusal_is_reported_with_its_stderr() {
    // An untracked file the fast-forward would overwrite: every fact looks
    // ready, git itself says no, and the file survives.
    let fx = fixture(0);
    commit(&fx.teammate, "newfile", "remote\n", "adds newfile");
    git_ok(&fx.teammate, &["push", "-q", "origin", "main"]);
    git_ok(&fx.me, &["fetch", "-q"]);
    std::fs::write(fx.me.join("newfile"), "precious\n").unwrap();
    let h = head(&fx.me);
    let r = run(&fx);
    assert!(!r.fast_forwarded);
    assert_eq!(r.reason.as_deref(), Some("gitRefused"));
    assert!(
        r.stderr.as_deref().is_some_and(|s| !s.is_empty()),
        "{:?}",
        r
    );
    assert_eq!(head(&fx.me), h);
    assert_eq!(
        std::fs::read_to_string(fx.me.join("newfile")).unwrap(),
        "precious\n"
    );
}

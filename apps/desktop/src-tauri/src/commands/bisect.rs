//! Guided bisect (design: docs/superpowers/specs/2026-11-26-guided-bisect-design.md).
//!
//! Everything is read from git's machine state (`refs/bisect/*`, the
//! `BISECT_*` files, `rev-list --bisect-vars`), never from its messages,
//! which are translated.

use crate::git::*;
use crate::types::BisectStatus;
use std::process::Output;

fn run(cwd: &str, args: &[&str]) -> Result<Output, String> {
    git_cmd()
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|e| format!("Failed to run git {}: {}", args.first().unwrap_or(&""), e))
}

/// stdout of a git call that must succeed, else its stderr as the error.
fn run_ok(cwd: &str, args: &[&str]) -> Result<String, String> {
    let out = run(cwd, args)?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if err.is_empty() {
            format!("git {} failed", args.join(" "))
        } else {
            err
        });
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

fn is_bisecting(cwd: &str) -> Result<bool, String> {
    Ok(resolve_git_dir(cwd)?.join("BISECT_LOG").exists())
}

/// (bad term, good term): `BISECT_TERMS` when a bisect set custom terms.
fn terms(cwd: &str) -> Result<(String, String), String> {
    let path = resolve_git_dir(cwd)?.join("BISECT_TERMS");
    if let Ok(text) = std::fs::read_to_string(path) {
        let mut lines = text.lines().map(str::trim).filter(|l| !l.is_empty());
        if let (Some(bad), Some(good)) = (lines.next(), lines.next()) {
            return Ok((bad.to_string(), good.to_string()));
        }
    }
    Ok(("bad".to_string(), "good".to_string()))
}

fn read_status(cwd: &str) -> Result<BisectStatus, String> {
    let git_dir = resolve_git_dir(cwd)?;
    let (bad_term, good_term) = terms(cwd)?;
    let start = std::fs::read_to_string(git_dir.join("BISECT_START"))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let current = run(cwd, &["rev-parse", "--verify", "-q", "HEAD"])
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());

    let mut bad = None;
    let mut good = Vec::new();
    let mut skipped = Vec::new();
    let refs = run_ok(
        cwd,
        &[
            "for-each-ref",
            "--format=%(refname) %(objectname)",
            "refs/bisect/",
        ],
    )?;
    let bad_ref = format!("refs/bisect/{bad_term}");
    let good_prefix = format!("refs/bisect/{good_term}-");
    for line in refs.lines() {
        let Some((name, hash)) = line.split_once(' ') else {
            continue;
        };
        if name == bad_ref {
            bad = Some(hash.to_string());
        } else if name.starts_with(&good_prefix) {
            good.push(hash.to_string());
        } else if name.starts_with("refs/bisect/skip-") {
            skipped.push(hash.to_string());
        }
    }

    let mut remaining = None;
    let mut steps = None;
    let mut candidates = Vec::new();
    if let (Some(bad), false) = (&bad, good.is_empty()) {
        let mut args = vec!["rev-list", "--bisect-vars", bad.as_str(), "--not"];
        args.extend(good.iter().map(String::as_str));
        let vars = run_ok(cwd, &args)?;
        let var = |key: &str| -> Option<u32> {
            vars.lines()
                .find_map(|l| l.strip_prefix(&format!("{key}=")))
                .and_then(|v| v.trim().trim_matches('\'').parse().ok())
        };
        remaining = var("bisect_nr");
        steps = var("bisect_steps");

        // The commits that can still be the first bad one: when every one
        // but `bad` is skipped (or there is none), git cannot narrow further.
        let mut args = vec!["rev-list", bad.as_str(), "--not"];
        args.extend(good.iter().map(String::as_str));
        let range: Vec<String> = run_ok(cwd, &args)?.lines().map(str::to_string).collect();
        let untested: Vec<&String> = range.iter().filter(|h| !skipped.contains(h)).collect();
        if untested.len() == 1 && untested[0] == bad {
            candidates = range;
        }
    }

    Ok(BisectStatus {
        current,
        start,
        bad,
        good,
        skipped,
        remaining,
        steps,
        candidates,
        terms: (bad_term, good_term),
    })
}

fn is_full_or_short_hash(s: &str) -> bool {
    (7..=64).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// The bisect in progress, read from git's state.
#[tauri::command]
pub(crate) async fn git_bisect_status(cwd: String) -> Result<BisectStatus, String> {
    let _repo = repo_lock::read(&cwd);
    read_status(&cwd)
}

/// Start a bisect between `good` (an ancestor) and `bad`. Refused on tracked
/// changes, during another operation, or when `good` is not an ancestor.
#[tauri::command]
pub(crate) async fn git_bisect_start(
    cwd: String,
    bad: String,
    good: String,
) -> Result<BisectStatus, String> {
    if !is_full_or_short_hash(&bad) || !is_full_or_short_hash(&good) {
        return Err("A bisect starts from two commit hashes.".to_string());
    }
    let state = crate::commands::read::git_repo_state(cwd.clone()).await?;
    let _repo = repo_lock::write(&cwd);
    if state.state != "clean" || is_bisecting(&cwd)? {
        return Err(
            "Another operation is in progress; finish it before starting a bisect.".to_string(),
        );
    }
    let dirty = run_ok(&cwd, &["status", "--porcelain", "--untracked-files=no"])?;
    if !dirty.trim().is_empty() {
        return Err(
            "Commit or stash your uncommitted changes before starting a bisect.".to_string(),
        );
    }
    let ancestor = run(&cwd, &["merge-base", "--is-ancestor", &good, &bad])?;
    if !ancestor.status.success() {
        return Err("The good commit must be an ancestor of the bad one.".to_string());
    }
    run_ok(&cwd, &["bisect", "start", &bad, &good])?;
    read_status(&cwd)
}

/// Mark the commit under test: `good`, `bad` (mapped to the bisect's own
/// terms) or `skip`.
#[tauri::command]
pub(crate) async fn git_bisect_mark(cwd: String, verdict: String) -> Result<BisectStatus, String> {
    let _repo = repo_lock::write(&cwd);
    let (bad_term, good_term) = terms(&cwd)?;
    let term = match verdict.as_str() {
        "good" => good_term,
        "bad" => bad_term,
        "skip" => "skip".to_string(),
        _ => return Err(format!("Unknown bisect verdict: {verdict}")),
    };
    if !is_bisecting(&cwd)? {
        return Err("No bisect is in progress.".to_string());
    }
    if let Err(err) = run_ok(&cwd, &["bisect", &term]) {
        // git exits non-zero when only skipped commits are left: the mark is
        // recorded and the candidates are known, which is a result, not a
        // failure.
        let status = read_status(&cwd)?;
        if status.candidates.is_empty() {
            return Err(err);
        }
        return Ok(status);
    }
    read_status(&cwd)
}

/// End the bisect and check out what it started from.
#[tauri::command]
pub(crate) async fn git_bisect_reset(cwd: String) -> Result<(), String> {
    let _repo = repo_lock::write(&cwd);
    run_ok(&cwd, &["bisect", "reset"])?;
    if is_bisecting(&cwd)? {
        return Err("git could not end the bisect.".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::git_binary;
    use std::path::PathBuf;
    use std::process::Command;
    use std::sync::atomic::{AtomicU64, Ordering};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    struct TempRepo {
        path: PathBuf,
    }

    impl Drop for TempRepo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    impl TempRepo {
        /// A repo with commits c1..=cn on main, each changing `a.txt`.
        fn linear(n: u32) -> Self {
            let k = COUNTER.fetch_add(1, Ordering::SeqCst);
            let dir = std::env::temp_dir().join(format!(
                "gitwand-bisect-test-{}-{}-{}",
                std::process::id(),
                k,
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            std::fs::create_dir_all(&dir).unwrap();
            let repo = TempRepo { path: dir };
            repo.git(&["init", "-q", "-b", "main"]);
            repo.git(&["config", "user.name", "Test"]);
            repo.git(&["config", "user.email", "test@example.com"]);
            repo.git(&["config", "commit.gpgsign", "false"]);
            for i in 1..=n {
                repo.write("a.txt", &format!("v{i}\n"));
                repo.git(&["add", "-A"]);
                repo.git(&["commit", "-q", "-m", &format!("c{i}")]);
            }
            repo
        }

        fn cwd(&self) -> String {
            self.path.to_str().unwrap().to_string()
        }

        fn git(&self, args: &[&str]) -> String {
            let out = Command::new(git_binary())
                .args(args)
                .current_dir(&self.path)
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "git {:?}: {}",
                args,
                String::from_utf8_lossy(&out.stderr)
            );
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        }

        fn write(&self, rel: &str, content: &str) {
            std::fs::write(self.path.join(rel), content).unwrap();
        }

        /// Full hash of the commit whose subject is `subject`.
        fn sha(&self, subject: &str) -> String {
            self.git(&[
                "log",
                "--all",
                "--format=%H",
                &format!("--grep=^{subject}$"),
            ])
        }

        fn head(&self) -> String {
            self.git(&["rev-parse", "HEAD"])
        }

        fn bisecting(&self) -> bool {
            self.path.join(".git/BISECT_LOG").exists()
        }
    }

    fn block<T>(f: impl std::future::Future<Output = T>) -> T {
        tauri::async_runtime::block_on(f)
    }

    fn status(repo: &TempRepo) -> BisectStatus {
        block(git_bisect_status(repo.cwd())).expect("status")
    }

    #[test]
    fn status_counts_and_estimate() {
        let repo = TempRepo::linear(8);
        let (c1, c8) = (repo.sha("c1"), repo.sha("c8"));
        let st = block(git_bisect_start(repo.cwd(), c8.clone(), c1.clone())).expect("start");
        let vars = repo.git(&["rev-list", "--bisect-vars", &c8, "--not", &c1]);
        let var = |k: &str| -> u32 {
            vars.lines()
                .find_map(|l| l.strip_prefix(&format!("{k}=")))
                .unwrap()
                .trim_matches('\'')
                .parse()
                .unwrap()
        };
        assert_eq!(st.bad.as_deref(), Some(c8.as_str()));
        assert_eq!(st.good, vec![c1.clone()]);
        assert_eq!(st.remaining, Some(var("bisect_nr")));
        assert_eq!(st.steps, Some(var("bisect_steps")));
        assert!(st.candidates.is_empty());
        assert_eq!(st.current.as_deref(), Some(repo.head().as_str()));
        assert_eq!(st.start.as_deref(), Some("main"));
        assert_eq!(st.terms, ("bad".to_string(), "good".to_string()));
    }

    #[test]
    fn status_before_both_ends_has_no_estimate() {
        let repo = TempRepo::linear(4);
        repo.git(&["bisect", "start"]);
        let st = status(&repo);
        assert_eq!(st.remaining, None);
        assert_eq!(st.steps, None);
        assert_eq!(st.bad, None);
        assert!(st.good.is_empty());
        assert!(st.candidates.is_empty());
    }

    #[test]
    fn mark_until_culprit() {
        let repo = TempRepo::linear(8);
        let (c1, c5, c8) = (repo.sha("c1"), repo.sha("c5"), repo.sha("c8"));
        let mut st = block(git_bisect_start(repo.cwd(), c8, c1)).expect("start");
        for _ in 0..10 {
            if st.candidates.len() == 1 {
                break;
            }
            // The bug is in c5 and every later commit.
            let head = repo.head();
            let is_bad = Command::new(git_binary())
                .args(["merge-base", "--is-ancestor", &c5, &head])
                .current_dir(&repo.path)
                .status()
                .unwrap()
                .success();
            let verdict = if is_bad { "bad" } else { "good" };
            st = block(git_bisect_mark(repo.cwd(), verdict.to_string())).expect("mark");
        }
        assert_eq!(st.candidates, vec![c5]);
    }

    #[test]
    fn status_lists_candidates_when_only_skips_remain() {
        let repo = TempRepo::linear(4);
        let (c1, c2, c3, c4) = (
            repo.sha("c1"),
            repo.sha("c2"),
            repo.sha("c3"),
            repo.sha("c4"),
        );
        let mut st = block(git_bisect_start(repo.cwd(), c4.clone(), c1)).expect("start");
        for _ in 0..5 {
            if !st.candidates.is_empty() {
                break;
            }
            st = block(git_bisect_mark(repo.cwd(), "skip".to_string())).expect("skip");
        }
        assert!(st.candidates.len() > 1, "{:?}", st.candidates);
        for c in [&c2, &c3, &c4] {
            assert!(
                st.candidates.contains(c),
                "{c} missing from {:?}",
                st.candidates
            );
        }
    }

    #[test]
    fn status_reads_custom_terms() {
        let repo = TempRepo::linear(8);
        let (c1, c8) = (repo.sha("c1"), repo.sha("c8"));
        repo.git(&[
            "bisect",
            "start",
            "--term-new=broken",
            "--term-old=fixed",
            &c8,
            &c1,
        ]);
        let st = status(&repo);
        assert_eq!(st.terms, ("broken".to_string(), "fixed".to_string()));
        assert_eq!(st.bad.as_deref(), Some(c8.as_str()));
        assert_eq!(st.good, vec![c1]);
        assert!(st.remaining.is_some());
    }

    #[test]
    fn mark_good_uses_old_term() {
        let repo = TempRepo::linear(8);
        let (c1, c8) = (repo.sha("c1"), repo.sha("c8"));
        repo.git(&[
            "bisect",
            "start",
            "--term-new=broken",
            "--term-old=fixed",
            &c8,
            &c1,
        ]);
        let head = repo.head();
        block(git_bisect_mark(repo.cwd(), "good".to_string())).expect("mark");
        assert_eq!(
            repo.git(&["rev-parse", &format!("refs/bisect/fixed-{head}")]),
            head
        );
    }

    #[test]
    fn start_refuses_tracked_changes() {
        let repo = TempRepo::linear(4);
        let (c1, c4) = (repo.sha("c1"), repo.sha("c4"));
        repo.write("a.txt", "dirty\n");
        let err = block(git_bisect_start(repo.cwd(), c4.clone(), c1.clone())).unwrap_err();
        assert!(err.contains("uncommitted"), "{err}");
        assert!(!repo.bisecting());
        repo.git(&["checkout", "--", "a.txt"]);
        repo.write("untracked.txt", "x");
        block(git_bisect_start(repo.cwd(), c4, c1)).expect("untracked alone is fine");
    }

    #[test]
    fn start_refuses_when_good_is_not_ancestor() {
        let repo = TempRepo::linear(8);
        let (c2, c8) = (repo.sha("c2"), repo.sha("c8"));
        repo.git(&["checkout", "-q", "-b", "side", &c2]);
        repo.write("b.txt", "side\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-q", "-m", "side"]);
        let side = repo.head();
        repo.git(&["checkout", "-q", "main"]);
        let err = block(git_bisect_start(repo.cwd(), c8, side)).unwrap_err();
        assert!(err.contains("ancestor"), "{err}");
        assert!(!repo.bisecting());
    }

    #[test]
    fn start_refuses_during_another_operation() {
        let repo = TempRepo::linear(4);
        let (c1, c4) = (repo.sha("c1"), repo.sha("c4"));
        repo.git(&["bisect", "start"]);
        assert!(block(git_bisect_start(repo.cwd(), c4, c1)).is_err());
    }

    #[test]
    fn start_rejects_non_hex() {
        let repo = TempRepo::linear(4);
        let c4 = repo.sha("c4");
        assert!(block(git_bisect_start(repo.cwd(), c4, "--foo".to_string())).is_err());
        assert!(!repo.bisecting());
    }

    #[test]
    fn mark_rejects_unknown_verdict() {
        let repo = TempRepo::linear(4);
        let (c1, c4) = (repo.sha("c1"), repo.sha("c4"));
        block(git_bisect_start(repo.cwd(), c4, c1)).expect("start");
        let head = repo.head();
        assert!(block(git_bisect_mark(repo.cwd(), "maybe".to_string())).is_err());
        assert_eq!(repo.head(), head);
    }

    #[test]
    fn reset_returns_to_start_branch() {
        let repo = TempRepo::linear(8);
        let (c1, c8) = (repo.sha("c1"), repo.sha("c8"));
        block(git_bisect_start(repo.cwd(), c8, c1)).expect("start");
        block(git_bisect_mark(repo.cwd(), "good".to_string())).expect("mark");
        block(git_bisect_reset(repo.cwd())).expect("reset");
        assert!(!repo.bisecting());
        assert_eq!(repo.git(&["symbolic-ref", "--short", "HEAD"]), "main");
    }

    #[test]
    fn reset_fails_and_keeps_bisect_when_start_branch_is_gone() {
        let repo = TempRepo::linear(8);
        let (c1, c8) = (repo.sha("c1"), repo.sha("c8"));
        repo.git(&["checkout", "-q", "-b", "tmp"]);
        block(git_bisect_start(repo.cwd(), c8, c1)).expect("start");
        repo.git(&["update-ref", "-d", "refs/heads/tmp"]);
        assert!(block(git_bisect_reset(repo.cwd())).is_err());
        assert!(repo.bisecting());
    }
}

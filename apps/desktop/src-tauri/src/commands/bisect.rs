//! Guided bisect (design: docs/superpowers/specs/2026-11-26-guided-bisect-design.md).
//!
//! Everything is read from git's machine state (`refs/bisect/*`, the
//! `BISECT_*` files, `rev-list --bisect-vars`), never from its messages,
//! which are translated.

use crate::git::*;
use crate::types::{BisectCommit, BisectStatus};
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

/// A rebase, merge, cherry-pick or revert in progress (what `git_repo_state`
/// reports ahead of a bisect), read under the caller's lock.
fn other_operation(cwd: &str) -> Result<bool, String> {
    let dir = resolve_git_dir(cwd)?;
    Ok([
        "rebase-merge",
        "rebase-apply",
        "MERGE_HEAD",
        "CHERRY_PICK_HEAD",
        "REVERT_HEAD",
    ]
    .iter()
    .any(|f| dir.join(f).exists()))
}

/// `merge-base --is-ancestor`: exit 0 yes, 1 no; anything else (an unknown
/// or ambiguous hash) is an error carrying git's stderr.
fn is_ancestor(cwd: &str, ancestor: &str, of: &str) -> Result<bool, String> {
    let out = run(cwd, &["merge-base", "--is-ancestor", ancestor, of])?;
    match out.status.code() {
        Some(0) => Ok(true),
        Some(1) => Ok(false),
        _ => {
            let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
            Err(if err.is_empty() {
                format!("git could not compare {ancestor} and {of}")
            } else {
                err
            })
        }
    }
}

/// The words of a `BISECT_NAMES` file: git writes them shell-quoted
/// (`'--' 'a.txt' 'it'\''s'`), the paths after a leading `--`.
fn parse_sq_quoted(text: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut chars = text.chars().peekable();
    loop {
        while chars.peek().is_some_and(|c| c.is_whitespace()) {
            chars.next();
        }
        if chars.peek().is_none() {
            break;
        }
        let mut word = String::new();
        while let Some(&c) = chars.peek() {
            if c.is_whitespace() {
                break;
            }
            chars.next();
            match c {
                '\'' => {
                    for q in chars.by_ref() {
                        if q == '\'' {
                            break;
                        }
                        word.push(q);
                    }
                }
                '\\' => {
                    if let Some(n) = chars.next() {
                        word.push(n);
                    }
                }
                _ => word.push(c),
            }
        }
        words.push(word);
    }
    words
}

/// How the bisect walks history, as git does: `--first-parent` and the
/// paths it was limited to (`git bisect start … -- <paths>`).
struct Scope {
    first_parent: bool,
    paths: Vec<String>,
}

fn scope(git_dir: &std::path::Path) -> Scope {
    let mut paths = std::fs::read_to_string(git_dir.join("BISECT_NAMES"))
        .map(|t| parse_sq_quoted(&t))
        .unwrap_or_default();
    if paths.first().is_some_and(|w| w == "--") {
        paths.remove(0);
    }
    Scope {
        first_parent: git_dir.join("BISECT_FIRST_PARENT").exists(),
        paths,
    }
}

/// `git rev-list [extra] [--first-parent] <bad> --not <goods> [-- <paths>]`.
fn rev_list(
    cwd: &str,
    scope: &Scope,
    extra: &[&str],
    bad: &str,
    good: &[String],
) -> Result<String, String> {
    let mut args = vec!["rev-list"];
    args.extend_from_slice(extra);
    if scope.first_parent {
        args.push("--first-parent");
    }
    args.push(bad);
    args.push("--not");
    args.extend(good.iter().map(String::as_str));
    if !scope.paths.is_empty() {
        args.push("--");
        args.extend(scope.paths.iter().map(String::as_str));
    }
    run_ok(cwd, &args)
}

/// Subject, author and date of each hash, in one `git log`.
fn describe(cwd: &str, hashes: &[String]) -> Vec<BisectCommit> {
    if hashes.is_empty() {
        return Vec::new();
    }
    let mut args = vec![
        "log",
        "--no-walk=unsorted",
        "--format=%H%x1f%s%x1f%an%x1f%aI",
    ];
    args.extend(hashes.iter().map(String::as_str));
    let Ok(out) = run_ok(cwd, &args) else {
        return Vec::new();
    };
    out.lines()
        .filter_map(|l| {
            let mut f = l.split('\x1f');
            Some(BisectCommit {
                hash: f.next()?.to_string(),
                subject: f.next()?.to_string(),
                author: f.next()?.to_string(),
                date: f.next()?.to_string(),
            })
        })
        .collect()
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
    // `--no-checkout` bisects move BISECT_HEAD, not HEAD.
    let head_ref = if git_dir.join("BISECT_HEAD").exists() {
        "BISECT_HEAD"
    } else {
        "HEAD"
    };
    let current = run(cwd, &["rev-parse", "--verify", "-q", head_ref])
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
        let scope = scope(&git_dir);
        let vars = rev_list(cwd, &scope, &["--bisect-vars"], bad, &good)?;
        steps = vars
            .lines()
            .find_map(|l| l.strip_prefix("bisect_steps="))
            .and_then(|v| v.trim().trim_matches('\'').parse().ok());

        // The commits git can still check out: the range, walked as git
        // walks it, minus `bad` and the skipped commits. `bisect_nr` ignores
        // skips; a skip ref can also point outside the range once later
        // marks narrowed it, so only skips inside it count.
        let range: Vec<String> = rev_list(cwd, &scope, &[], bad, &good)?
            .lines()
            .map(str::to_string)
            .collect();
        let untested = range
            .iter()
            .filter(|h| *h != bad && !skipped.contains(h))
            .count();
        remaining = Some(untested as u32);

        // Nothing left to test: `bad` is the first bad commit, or, when
        // skipped commits remain in the range, one of them may be.
        if untested == 0 {
            candidates.push(bad.clone());
            candidates.extend(
                range
                    .into_iter()
                    .filter(|h| h != bad && skipped.contains(h)),
            );
        }
    }

    let marked = |h: &String| bad.as_ref() == Some(h) || good.contains(h) || skipped.contains(h);
    let pending_checkout = candidates.is_empty()
        && remaining.is_some_and(|n| n > 0)
        && current.as_ref().is_some_and(marked);

    let mut to_describe: Vec<String> = current.iter().cloned().collect();
    to_describe.extend(
        candidates
            .iter()
            .filter(|c| Some(*c) != current.as_ref())
            .cloned(),
    );
    let commits = describe(cwd, &to_describe);

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
        commits,
        pending_checkout,
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

/// Start a bisect between two commits, one an ancestor of the other: the
/// ancestor is the good end, whichever way they are passed (the Git Tree's
/// row order is not ancestry). Refused on tracked changes, during another
/// operation, or when neither is an ancestor of the other.
#[tauri::command]
pub(crate) async fn git_bisect_start(
    cwd: String,
    bad: String,
    good: String,
) -> Result<BisectStatus, String> {
    if !is_full_or_short_hash(&bad) || !is_full_or_short_hash(&good) {
        return Err("A bisect starts from two commit hashes.".to_string());
    }
    let _repo = repo_lock::write(&cwd);
    if other_operation(&cwd)? || is_bisecting(&cwd)? {
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
    let (bad, good) = if is_ancestor(&cwd, &good, &bad)? {
        (bad, good)
    } else if is_ancestor(&cwd, &bad, &good)? {
        (good, bad)
    } else {
        return Err(
            "One of the two commits must be an ancestor of the other: they are on separate branches."
                .to_string(),
        );
    };
    run_ok(&cwd, &["bisect", "start", &bad, &good])?;
    read_status(&cwd)
}

/// Mark the commit under test: `good`, `bad` (mapped to the bisect's own
/// terms) or `skip`; or `next`, which checks out the next commit to test
/// after a mark git recorded but could not move on from (`pending_checkout`).
#[tauri::command]
pub(crate) async fn git_bisect_mark(cwd: String, verdict: String) -> Result<BisectStatus, String> {
    let _repo = repo_lock::write(&cwd);
    let (bad_term, good_term) = terms(&cwd)?;
    let term = match verdict.as_str() {
        "good" => good_term,
        "bad" => bad_term,
        "skip" | "next" => verdict.clone(),
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
        // Commits still untested: the range minus the known-bad end.
        let range: u32 = repo
            .git(&["rev-list", "--count", &c8, "--not", &c1])
            .parse()
            .unwrap();
        assert_eq!(st.remaining, Some(range - 1));
        assert_eq!(st.steps, Some(var("bisect_steps")));
        assert!(st.candidates.is_empty());
        assert_eq!(st.current.as_deref(), Some(repo.head().as_str()));
        assert_eq!(st.start.as_deref(), Some("main"));
        assert_eq!(st.terms, ("bad".to_string(), "good".to_string()));
    }

    #[test]
    fn remaining_leaves_out_skipped_commits() {
        let repo = TempRepo::linear(8);
        let (c1, c8) = (repo.sha("c1"), repo.sha("c8"));
        let st = block(git_bisect_start(repo.cwd(), c8, c1)).expect("start");
        let before = st.remaining.unwrap();
        let st = block(git_bisect_mark(repo.cwd(), "skip".to_string())).expect("skip");
        assert_eq!(st.remaining, Some(before - 1));
    }

    #[test]
    fn status_describes_the_commit_under_test_and_the_culprit() {
        let repo = TempRepo::linear(8);
        let (c1, c8) = (repo.sha("c1"), repo.sha("c8"));
        let st = block(git_bisect_start(repo.cwd(), c8, c1)).expect("start");
        let head = repo.head();
        let subject = repo.git(&["log", "-1", "--format=%s", &head]);
        let info = st
            .commits
            .iter()
            .find(|c| c.hash == head)
            .expect("current described");
        assert_eq!(info.subject, subject);
        assert_eq!(info.author, "Test");
        assert!(!info.date.is_empty());
    }

    #[test]
    fn start_orders_the_ends_by_ancestry() {
        let repo = TempRepo::linear(8);
        let (c1, c8) = (repo.sha("c1"), repo.sha("c8"));
        // Passed the wrong way round (as a Git Tree whose rows are out of
        // order would): the ancestor is still the good end.
        let st = block(git_bisect_start(repo.cwd(), c1.clone(), c8.clone())).expect("start");
        assert_eq!(st.bad.as_deref(), Some(c8.as_str()));
        assert_eq!(st.good, vec![c1]);
    }

    #[test]
    fn a_mark_whose_checkout_fails_is_kept_and_next_moves_on() {
        let repo = TempRepo::linear(8);
        let (c1, c8) = (repo.sha("c1"), repo.sha("c8"));
        block(git_bisect_start(repo.cwd(), c8, c1)).expect("start");
        let tested = repo.head();
        // A tracked edit every other commit's a.txt would overwrite.
        repo.write("a.txt", "local edit\n");
        let err = block(git_bisect_mark(repo.cwd(), "good".to_string())).unwrap_err();
        assert!(!err.is_empty());
        let st = status(&repo);
        assert!(st.good.contains(&tested), "the mark was recorded");
        assert_eq!(repo.head(), tested);
        assert!(st.pending_checkout, "HEAD is a commit already marked");
        repo.git(&["checkout", "--", "a.txt"]);
        let st = block(git_bisect_mark(repo.cwd(), "next".to_string())).expect("next");
        assert_ne!(st.current.as_deref(), Some(tested.as_str()));
        assert!(!st.pending_checkout);
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
    fn remaining_ignores_skips_that_later_marks_left_out_of_the_range() {
        let repo = TempRepo::linear(8);
        let (c1, c8) = (repo.sha("c1"), repo.sha("c8"));
        block(git_bisect_start(repo.cwd(), c8.clone(), c1)).expect("start");
        let skipped = repo.head();
        let mut st = block(git_bisect_mark(repo.cwd(), "skip".to_string())).expect("skip");
        let mut left_out = false;
        for _ in 0..3 {
            if !st.candidates.is_empty() {
                break;
            }
            st = block(git_bisect_mark(repo.cwd(), "good".to_string())).expect("good");
            let mut args = vec!["rev-list", c8.as_str(), "--not"];
            args.extend(st.good.iter().map(String::as_str));
            let range = repo.git(&args);
            let range: Vec<&str> = range.lines().collect();
            left_out |= !range.contains(&skipped.as_str());
            let untested = range
                .iter()
                .filter(|h| **h != c8 && !st.skipped.iter().any(|s| s == *h))
                .count() as u32;
            assert_eq!(st.remaining, Some(untested), "range {range:?}");
        }
        assert!(
            left_out,
            "a good mark put the skipped commit out of the range"
        );
    }

    #[test]
    fn status_follows_a_pathspec_bisect_to_its_culprit() {
        let repo = TempRepo::linear(1);
        let commit = |file: &str, content: &str, subject: &str| {
            repo.write(file, content);
            repo.git(&["add", "-A"]);
            repo.git(&["commit", "-q", "-m", subject]);
        };
        commit("b.txt", "1\n", "c2");
        for i in 3..=8 {
            if i == 6 {
                commit("b.txt", "2\n", "c6");
            } else {
                commit("a.txt", &format!("v{i}\n"), &format!("c{i}"));
            }
        }
        let (c2, c6, c8) = (repo.sha("c2"), repo.sha("c6"), repo.sha("c8"));
        repo.git(&["bisect", "start", &c8, &c2, "--", "b.txt"]);
        let mut st = status(&repo);
        for _ in 0..5 {
            if !st.candidates.is_empty() {
                break;
            }
            st = block(git_bisect_mark(repo.cwd(), "bad".to_string())).expect("bad");
        }
        assert_eq!(st.candidates, vec![c6]);
        assert_eq!(st.remaining, Some(0));
    }

    #[test]
    fn status_follows_a_first_parent_bisect() {
        let repo = TempRepo::linear(1);
        let c1 = repo.sha("c1");
        repo.git(&["checkout", "-q", "-b", "side"]);
        for s in ["s1", "s2"] {
            repo.write("side.txt", s);
            repo.git(&["add", "-A"]);
            repo.git(&["commit", "-q", "-m", s]);
        }
        repo.git(&["checkout", "-q", "main"]);
        repo.write("a.txt", "v2\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-q", "-m", "c2"]);
        repo.git(&["merge", "-q", "--no-ff", "-m", "m", "side"]);
        let (c2, m) = (repo.sha("c2"), repo.head());
        repo.git(&["bisect", "start", "--first-parent", &m, &c1]);
        let st = status(&repo);
        // The side branch is not walked: only c2 is left to test.
        assert_eq!(st.remaining, Some(1));
        let st = block(git_bisect_mark(repo.cwd(), "bad".to_string())).expect("bad");
        assert_eq!(st.candidates, vec![c2]);
    }

    #[test]
    fn status_reads_the_commit_under_test_of_a_no_checkout_bisect() {
        let repo = TempRepo::linear(8);
        let (c1, c8) = (repo.sha("c1"), repo.sha("c8"));
        repo.git(&["bisect", "start", "--no-checkout", &c8, &c1]);
        let tested = repo.git(&["rev-parse", "BISECT_HEAD"]);
        assert_ne!(tested, repo.head());
        assert_eq!(status(&repo).current.as_deref(), Some(tested.as_str()));
    }

    #[test]
    fn start_reports_an_unknown_commit_as_such() {
        let repo = TempRepo::linear(4);
        let c1 = repo.sha("c1");
        let missing = "0123456789abcdef0123456789abcdef01234567".to_string();
        let err = block(git_bisect_start(repo.cwd(), missing, c1)).unwrap_err();
        assert!(!err.contains("separate branches"), "{err}");
        assert!(!is_bisecting(&repo.cwd()).unwrap());
    }

    #[test]
    fn bisect_names_are_unquoted() {
        assert_eq!(
            parse_sq_quoted("'--' 'a.txt' 'it'\\''s b.txt'\n"),
            vec!["--", "a.txt", "it's b.txt"]
        );
        assert!(parse_sq_quoted("\n").is_empty());
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

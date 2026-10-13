//! Tracked files that now match an ignore rule.
//!
//! A path committed before its `.gitignore` rule existed stays tracked, so the
//! rule silently does nothing for it. `git ls-files -ci --exclude-standard`
//! lists exactly those paths; `git rm --cached` untracks them while keeping the
//! files on disk. Both commands are exposed here, mirrored by
//! `/api/git-tracked-ignored` and `/api/git-untrack-paths` in `dev-server.mjs`.

use crate::git::*;
use serde::Serialize;
use std::io::Write;
use std::process::Stdio;

/// Paths returned to the UI. Past this, only the total is reported so a repo
/// with a vendored build directory committed cannot flood the IPC channel.
pub(crate) const TRACKED_IGNORED_CAP: usize = 500;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TrackedIgnored {
    /// At most `TRACKED_IGNORED_CAP` repo-relative paths, in git's index order.
    pub paths: Vec<String>,
    /// How many tracked paths match an ignore rule, cap or not.
    pub total: usize,
    /// True when `paths` is shorter than `total`.
    pub truncated: bool,
}

/// Split `git ls-files -z` output. Entries that are not valid UTF-8 are
/// dropped: they cannot round-trip through JSON, so offering them to the UI
/// would only produce an untrack that fails.
pub(crate) fn parse_nul_list(raw: &[u8]) -> Vec<String> {
    raw.split(|b| *b == 0)
        .filter(|s| !s.is_empty())
        .filter_map(|s| std::str::from_utf8(s).ok().map(str::to_string))
        .collect()
}

pub(crate) fn cap_paths(all: Vec<String>) -> TrackedIgnored {
    let total = all.len();
    let paths: Vec<String> = all.into_iter().take(TRACKED_IGNORED_CAP).collect();
    TrackedIgnored {
        truncated: paths.len() < total,
        paths,
        total,
    }
}

/// Tracked paths matching an ignore rule (`.gitignore` at any level,
/// `.git/info/exclude`, `core.excludesFile`).
#[tauri::command]
pub(crate) async fn git_tracked_ignored(cwd: String) -> Result<TrackedIgnored, String> {
    let _repo = repo_lock::read(&cwd);
    let output = git_cmd()
        .args(["ls-files", "-z", "-c", "-i", "--exclude-standard"])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to run git ls-files: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git ls-files failed: {}", stderr));
    }
    Ok(cap_paths(parse_nul_list(&output.stdout)))
}

/// Lexical check of a repo-relative pathspec handed to `git rm --cached`.
///
/// Deliberately NOT `safe_repo_path`: that one canonicalizes, so a tracked
/// symlink pointing outside the repo (or a dangling one) would be refused and
/// fail the whole batch, although `git rm --cached` only touches the index
/// entry and never follows the link. The path never reaches the filesystem
/// here, so a lexical test is the right one: non-empty, no NUL, not absolute
/// and no `..` component. On Windows `\` is a separator too and a drive or
/// UNC prefix counts as absolute; elsewhere `\` and `:` are ordinary file
/// name characters git can track, so they are left alone.
pub(crate) fn validate_pathspec(p: &str) -> Result<(), String> {
    if p.trim().is_empty() {
        return Err("path must not be empty".to_string());
    }
    if p.contains('\0') {
        return Err("path must not contain NUL".to_string());
    }
    let windows = cfg!(windows);
    let b = p.as_bytes();
    let absolute = p.starts_with('/')
        || std::path::Path::new(p).is_absolute()
        || (windows
            && (p.starts_with('\\')
                || (b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':')));
    if absolute {
        return Err(format!("path must be relative to the repo (got: {})", p));
    }
    let dotdot = if windows {
        p.split(['/', '\\']).any(|c| c == "..")
    } else {
        p.split('/').any(|c| c == "..")
    };
    if dotdot {
        return Err(format!("path must not contain `..` (got: {})", p));
    }
    Ok(())
}

/// Untrack `paths` (`git rm --cached`): the files stay on disk, their removal
/// is staged. Paths travel on stdin, NUL-separated, so a long list cannot hit
/// the argv limit; `--literal-pathspecs` stops `*`, `?` or `[` in a file name
/// from being read as a glob. `--ignore-unmatch` keeps a stale selection (a
/// path already untracked since the list was computed) from failing the batch.
#[tauri::command]
pub(crate) async fn git_untrack_paths(cwd: String, paths: Vec<String>) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }
    // The repo itself goes through the shared guard (absolute, resolves).
    safe_repo_path(&cwd, ".")?;
    let mut stdin_buf: Vec<u8> = Vec::new();
    for p in &paths {
        validate_pathspec(p)?;
        stdin_buf.extend_from_slice(p.as_bytes());
        stdin_buf.push(0);
    }

    let _repo = repo_lock::write(&cwd);
    let mut child = git_cmd()
        .args([
            "--literal-pathspecs",
            "rm",
            "--cached",
            "--quiet",
            "--ignore-unmatch",
            "--pathspec-from-file=-",
            "--pathspec-file-nul",
        ])
        .current_dir(&cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to run git rm: {}", e))?;
    if let Some(mut stdin) = child.stdin.take() {
        // A broken pipe means git already bailed out; its stderr says why.
        let _ = stdin.write_all(&stdin_buf);
    }
    let output = child
        .wait_with_output()
        .map_err(|e| format!("Failed to wait for git rm: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git rm --cached failed: {}", stderr));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::process::Command;
    use std::sync::atomic::{AtomicU32, Ordering};

    static SEQ: AtomicU32 = AtomicU32::new(0);

    /// A real temporary repo, removed on drop.
    struct TempRepo(PathBuf);

    impl TempRepo {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!(
                "gw-tracked-ignored-{}-{}",
                std::process::id(),
                SEQ.fetch_add(1, Ordering::SeqCst)
            ));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            let dir = std::fs::canonicalize(&dir).unwrap();
            let repo = TempRepo(dir);
            repo.git(&["init", "-q"]);
            repo.git(&["config", "user.email", "t@example.com"]);
            repo.git(&["config", "user.name", "T"]);
            repo.git(&["config", "commit.gpgsign", "false"]);
            repo
        }
        fn cwd(&self) -> String {
            self.0.to_string_lossy().to_string()
        }
        fn git(&self, args: &[&str]) -> String {
            let out = Command::new("git")
                .args(args)
                .current_dir(&self.0)
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "git {:?}: {}",
                args,
                String::from_utf8_lossy(&out.stderr)
            );
            String::from_utf8_lossy(&out.stdout).to_string()
        }
        fn write(&self, rel: &str, content: &str) {
            let p = self.0.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, content).unwrap();
        }
        fn commit_all(&self, msg: &str) {
            self.git(&["add", "-A"]);
            self.git(&["commit", "-qm", msg]);
        }
    }

    impl Drop for TempRepo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn run<T>(f: impl std::future::Future<Output = T>) -> T {
        tauri::async_runtime::block_on(f)
    }

    #[test]
    fn parse_nul_list_splits_on_nul_and_drops_empties() {
        assert_eq!(
            parse_nul_list(b"a b.txt\0dir/\xc3\xa9.txt\0\0"),
            vec!["a b.txt".to_string(), "dir/é.txt".to_string()]
        );
        assert!(parse_nul_list(b"").is_empty());
        // Non-UTF-8 entry is skipped, neighbours survive.
        assert_eq!(parse_nul_list(b"ok\0bad\xff\0fine\0"), vec!["ok", "fine"]);
    }

    #[test]
    fn cap_paths_reports_total_beyond_the_cap() {
        let all: Vec<String> = (0..TRACKED_IGNORED_CAP + 7)
            .map(|i| format!("f{i}"))
            .collect();
        let r = cap_paths(all);
        assert_eq!(r.paths.len(), TRACKED_IGNORED_CAP);
        assert_eq!(r.total, TRACKED_IGNORED_CAP + 7);
        assert!(r.truncated);
        let small = cap_paths(vec!["x".into()]);
        assert!(!small.truncated);
        assert_eq!(small.total, 1);
    }

    #[test]
    fn detects_committed_file_later_matched_by_new_ignore_rule() {
        let repo = TempRepo::new();
        repo.write("keep.txt", "k\n");
        repo.write("build/out.js", "x\n");
        repo.write("sub/deep/app.log", "log\n");
        repo.commit_all("init");
        assert_eq!(run(git_tracked_ignored(repo.cwd())).unwrap().total, 0);

        repo.write(".gitignore", "build/\n*.log\n");
        let r = run(git_tracked_ignored(repo.cwd())).unwrap();
        assert_eq!(r.total, 2);
        assert!(!r.truncated);
        let mut paths = r.paths.clone();
        paths.sort();
        assert_eq!(paths, vec!["build/out.js", "sub/deep/app.log"]);
    }

    #[test]
    fn nested_gitignore_and_info_exclude_are_honoured() {
        let repo = TempRepo::new();
        repo.write("pkg/gen.txt", "g\n");
        repo.write("secret.env", "s\n");
        repo.write("ok.txt", "o\n");
        repo.commit_all("init");
        repo.write("pkg/.gitignore", "gen.txt\n");
        repo.write(".git/info/exclude", "secret.env\n");
        let mut paths = run(git_tracked_ignored(repo.cwd())).unwrap().paths;
        paths.sort();
        assert_eq!(paths, vec!["pkg/gen.txt", "secret.env"]);
    }

    #[test]
    fn untracked_ignored_files_are_not_reported() {
        let repo = TempRepo::new();
        repo.write("a.txt", "a\n");
        repo.write(".gitignore", "*.log\n");
        repo.commit_all("init");
        repo.write("never-added.log", "l\n");
        let r = run(git_tracked_ignored(repo.cwd())).unwrap();
        assert_eq!(r.total, 0);
        assert!(r.paths.is_empty());
    }

    #[test]
    fn handles_spaces_and_unicode_paths_unquoted() {
        let repo = TempRepo::new();
        repo.write("dossier é/mon fichier.log", "l\n");
        repo.write("日本語/ログ.log", "l\n");
        repo.commit_all("init");
        repo.write(".gitignore", "*.log\n");
        let mut paths = run(git_tracked_ignored(repo.cwd())).unwrap().paths;
        paths.sort();
        assert_eq!(paths, vec!["dossier é/mon fichier.log", "日本語/ログ.log"]);
    }

    #[test]
    fn untrack_keeps_file_on_disk_and_stages_removal() {
        let repo = TempRepo::new();
        repo.write("a b.log", "l\n");
        repo.write("[x]-star.log", "l\n");
        repo.write("keep.txt", "k\n");
        repo.commit_all("init");
        repo.write(".gitignore", "*.log\n");

        run(git_untrack_paths(
            repo.cwd(),
            vec!["a b.log".into(), "[x]-star.log".into()],
        ))
        .unwrap();

        assert!(repo.0.join("a b.log").exists());
        assert!(repo.0.join("[x]-star.log").exists());
        let staged = repo.git(&["diff", "--cached", "--name-status", "-z"]);
        assert!(staged.contains("D\0a b.log\0"), "{staged:?}");
        assert!(staged.contains("D\0[x]-star.log\0"), "{staged:?}");
        assert!(!staged.contains("keep.txt"));
        // And the notice would now be gone.
        assert_eq!(run(git_tracked_ignored(repo.cwd())).unwrap().total, 0);
    }

    #[test]
    fn untrack_is_literal_not_a_glob() {
        let repo = TempRepo::new();
        repo.write("one.log", "1\n");
        repo.write("two.log", "2\n");
        repo.commit_all("init");
        repo.write(".gitignore", "*.log\n");
        run(git_untrack_paths(repo.cwd(), vec!["*.log".into()])).unwrap();
        // `*.log` names no tracked file, so nothing is untracked.
        assert_eq!(run(git_tracked_ignored(repo.cwd())).unwrap().total, 2);
    }

    #[test]
    fn untrack_tolerates_stale_paths_and_rejects_escapes() {
        let repo = TempRepo::new();
        repo.write("a.log", "l\n");
        repo.commit_all("init");
        repo.write(".gitignore", "*.log\n");
        assert!(run(git_untrack_paths(
            repo.cwd(),
            vec!["gone.log".into(), "a.log".into()]
        ))
        .is_ok());
        assert!(run(git_untrack_paths(repo.cwd(), vec!["../etc/passwd".into()])).is_err());
        assert!(run(git_untrack_paths(repo.cwd(), vec!["".into()])).is_err());
        assert!(run(git_untrack_paths(repo.cwd(), vec![])).is_ok());
    }

    #[test]
    fn validate_pathspec_is_lexical() {
        for ok in [
            "a.log",
            "dir/b.log",
            "a..b",
            "..hidden",
            "dir/...",
            "[x]*?.log",
            "é/ログ",
        ] {
            assert!(validate_pathspec(ok).is_ok(), "{ok:?} should pass");
        }
        for bad in [
            "",
            "   ",
            "..",
            "../x",
            "dir/../../x",
            "dir/..",
            "/etc/passwd",
            "/",
            "a\0b",
        ] {
            assert!(validate_pathspec(bad).is_err(), "{bad:?} should fail");
        }
        if cfg!(windows) {
            for bad in ["..\\x", "dir\\..\\x", "C:\\x", "C:x", "\\\\srv\\share"] {
                assert!(validate_pathspec(bad).is_err(), "{bad:?} should fail");
            }
        } else {
            // Ordinary file name characters off Windows.
            assert!(validate_pathspec("a\\b").is_ok());
            assert!(validate_pathspec("c:d").is_ok());
        }
    }

    #[test]
    fn untrack_rejects_absolute_and_parent_paths_without_touching_the_index() {
        let repo = TempRepo::new();
        repo.write("a.log", "l\n");
        repo.commit_all("init");
        repo.write(".gitignore", "*.log\n");
        let abs = repo.0.join("a.log").to_string_lossy().to_string();
        for bad in [abs, "../x".to_string(), "sub/../../x".to_string()] {
            // The bad path rides with a good one: the batch fails as a whole.
            let r = run(git_untrack_paths(
                repo.cwd(),
                vec!["a.log".into(), bad.clone()],
            ));
            assert!(r.is_err(), "{bad:?} should be refused");
        }
        assert_eq!(run(git_tracked_ignored(repo.cwd())).unwrap().total, 1);
    }

    #[test]
    fn untrack_rejects_a_relative_or_missing_cwd() {
        assert!(run(git_untrack_paths("relative/dir".into(), vec!["a".into()])).is_err());
        assert!(run(git_untrack_paths(
            "/definitely/not/a/gitwand/repo".into(),
            vec!["a".into()]
        ))
        .is_err());
    }

    #[cfg(unix)]
    #[test]
    fn untrack_accepts_a_tracked_symlink_pointing_outside_the_repo() {
        let outside = TempRepo::new(); // just a directory outside `repo`
        outside.write("target.txt", "t\n");
        let repo = TempRepo::new();
        repo.write("keep.txt", "k\n");
        std::os::unix::fs::symlink(outside.0.join("target.txt"), repo.0.join("link.log")).unwrap();
        std::os::unix::fs::symlink("/nonexistent/gitwand/dangling", repo.0.join("dangling.log"))
            .unwrap();
        repo.commit_all("init");
        repo.write(".gitignore", "*.log\n");
        let mut listed = run(git_tracked_ignored(repo.cwd())).unwrap().paths;
        listed.sort();
        assert_eq!(listed, vec!["dangling.log", "link.log"]);

        run(git_untrack_paths(repo.cwd(), listed)).unwrap();

        assert_eq!(run(git_tracked_ignored(repo.cwd())).unwrap().total, 0);
        // The links are still there, the target untouched.
        assert!(repo
            .0
            .join("link.log")
            .symlink_metadata()
            .unwrap()
            .file_type()
            .is_symlink());
        assert!(repo.0.join("dangling.log").symlink_metadata().is_ok());
        assert_eq!(
            std::fs::read_to_string(outside.0.join("target.txt")).unwrap(),
            "t\n"
        );
        let staged = repo.git(&["diff", "--cached", "--name-status", "-z"]);
        assert!(staged.contains("D\0link.log\0"), "{staged:?}");
        assert!(staged.contains("D\0dangling.log\0"), "{staged:?}");
    }

    #[test]
    fn untrack_handles_a_list_too_long_for_argv() {
        let repo = TempRepo::new();
        let n = 3000;
        let name = |i: usize| format!("gen/some-long-directory-name-{i:05}/file.log");
        for i in 0..n {
            repo.write(&name(i), "l\n");
        }
        repo.commit_all("init");
        repo.write(".gitignore", "gen/\n");
        let all = run(git_tracked_ignored(repo.cwd())).unwrap();
        assert_eq!(all.total, n);
        assert_eq!(all.paths.len(), TRACKED_IGNORED_CAP);
        assert!(all.truncated);
        let full: Vec<String> = (0..n).map(name).collect();
        run(git_untrack_paths(repo.cwd(), full)).unwrap();
        assert_eq!(run(git_tracked_ignored(repo.cwd())).unwrap().total, 0);
    }
}

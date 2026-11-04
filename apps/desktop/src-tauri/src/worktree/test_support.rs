//! Real git repositories for the worktree service tests.

use crate::git::git_binary;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};

static COUNTER: AtomicU64 = AtomicU64::new(0);

/// A repo at `<sandbox>/repo` with one commit on `main`. The sandbox (its
/// parent) is removed on drop, so sibling `repo.worktrees/` goes too.
pub(crate) struct TempRepo {
    pub sandbox: PathBuf,
    pub path: PathBuf,
}

impl Drop for TempRepo {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.sandbox);
    }
}

pub(crate) fn git_at(dir: &Path, args: &[&str]) -> String {
    let out = Command::new(git_binary())
        .args(args)
        .current_dir(dir)
        .output()
        .unwrap_or_else(|e| panic!("git {args:?}: {e}"));
    assert!(
        out.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

impl TempRepo {
    pub(crate) fn new() -> Self {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let sandbox = std::env::temp_dir().join(format!(
            "gitwand-wt-test-{}-{}-{}",
            std::process::id(),
            n,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&sandbox).unwrap();
        let sandbox = sandbox.canonicalize().unwrap();
        let path = sandbox.join("repo");
        std::fs::create_dir_all(&path).unwrap();
        let repo = TempRepo { sandbox, path };
        repo.git(&["init", "-q", "-b", "main"]);
        repo.git(&["config", "user.name", "Test"]);
        repo.git(&["config", "user.email", "test@example.com"]);
        repo.git(&["config", "commit.gpgsign", "false"]);
        repo.write("README.md", "hello\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-q", "-m", "init"]);
        repo
    }

    pub(crate) fn git(&self, args: &[&str]) -> String {
        git_at(&self.path, args)
    }

    pub(crate) fn write(&self, rel: &str, content: &str) {
        let p = self.path.join(rel);
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(p, content).unwrap();
    }

    pub(crate) fn commit(&self, rel: &str, content: &str, msg: &str) -> String {
        self.write(rel, content);
        self.git(&["add", "-A"]);
        self.git(&["commit", "-q", "-m", msg]);
        self.git(&["rev-parse", "HEAD"])
    }

    /// A bare clone at `<sandbox>/remote.git`, added as `origin` and fetched.
    pub(crate) fn add_bare_origin(&self) -> PathBuf {
        let bare = self.sandbox.join("remote.git");
        git_at(
            &self.sandbox,
            &[
                "clone",
                "-q",
                "--bare",
                self.path.to_str().unwrap(),
                "remote.git",
            ],
        );
        self.git(&["remote", "add", "origin", bare.to_str().unwrap()]);
        self.git(&["fetch", "-q", "origin"]);
        self.git(&["remote", "set-head", "origin", "main"]);
        bare
    }
}

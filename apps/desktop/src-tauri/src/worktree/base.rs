//! The base a new worktree starts from (spec §5.2): the freshly fetched
//! remote default branch, falling back to the local tracking ref, then to
//! the local `HEAD`, with the reason shown to the user.

use serde::Serialize;
use std::io::Read;
use std::path::Path;
use std::process::Stdio;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct BaseResolution {
    pub base_ref: String,
    pub commit: String,
    /// Unix seconds of the fetch, when the base was just fetched.
    pub fetched_at: Option<u64>,
    /// `no-remote`, `no-default-branch` or `fetch-failed`.
    pub fallback_reason: Option<String>,
    /// git's message, for `fetch-failed`.
    pub fallback_detail: Option<String>,
}

fn git_ok(root: &Path, args: &[&str]) -> Option<String> {
    let out = crate::git::git_cmd()
        .args(args)
        .current_dir(root)
        .output()
        .ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn commit_of(root: &Path, rev: &str) -> Option<String> {
    git_ok(
        root,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("{rev}^{{commit}}"),
        ],
    )
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// The current branch's remote if it has one, else `origin`, if listed.
fn pick_remote(root: &Path) -> Option<String> {
    let remotes: Vec<String> = git_ok(root, &["remote"])?
        .lines()
        .map(str::to_string)
        .collect();
    let configured = git_ok(root, &["symbolic-ref", "--short", "-q", "HEAD"])
        .and_then(|b| git_ok(root, &["config", "--get", &format!("branch.{b}.remote")]));
    configured
        .filter(|r| remotes.contains(r))
        .or_else(|| remotes.iter().find(|r| *r == "origin").cloned())
}

fn default_branch(root: &Path, remote: &str) -> Option<String> {
    let head = format!("refs/remotes/{remote}/HEAD");
    if let Some(target) = git_ok(root, &["symbolic-ref", "-q", &head]) {
        let prefix = format!("refs/remotes/{remote}/");
        if let Some(b) = target.strip_prefix(&prefix) {
            return Some(b.to_string());
        }
    }
    ["main", "master"]
        .into_iter()
        .find(|b| {
            git_ok(
                root,
                &[
                    "show-ref",
                    "--verify",
                    "--quiet",
                    &format!("refs/remotes/{remote}/{b}"),
                ],
            )
            .is_some()
        })
        .map(str::to_string)
}

/// `git fetch --quiet --no-tags <remote> <branch>`, never prompting and
/// killed after `timeout`. Err carries git's message.
///
/// A transport can leave a process holding stderr after git is gone (ssh
/// waiting on a dead host, a credential helper's window): on timeout the
/// whole process group is killed and the reader thread is left to finish
/// on its own, never joined (same rule as `git::output_with_timeout`).
fn fetch(root: &Path, remote: &str, branch: &str, timeout: Duration) -> Result<(), String> {
    let mut cmd = crate::git::git_cmd();
    cmd.args(["fetch", "--quiet", "--no-tags", remote, branch])
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "never")
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    // ssh must not prompt either, and must give up on a dead host before the
    // deadline; unless the user configured their own ssh command.
    let own_ssh = std::env::var_os("GIT_SSH_COMMAND").is_some()
        || std::env::var_os("GIT_SSH").is_some()
        || git_ok(root, &["config", "--get", "core.sshCommand"]).is_some();
    if !own_ssh {
        cmd.env(
            "GIT_SSH_COMMAND",
            "ssh -o BatchMode=yes -o ConnectTimeout=10",
        );
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("cannot run git fetch: {e}"))?;
    let mut stderr = child.stderr.take();
    let reader = std::thread::spawn(move || {
        let mut s = String::new();
        if let Some(e) = stderr.as_mut() {
            let _ = e.read_to_string(&mut s);
        }
        s
    });
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let message = reader.join().unwrap_or_default().trim().to_string();
                return if status.success() {
                    Ok(())
                } else {
                    Err(message)
                };
            }
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                #[cfg(unix)]
                if let Ok(pgid) = libc::pid_t::try_from(child.id()) {
                    // SAFETY: signals the group this child leads (process_group(0)).
                    unsafe {
                        libc::kill(-pgid, libc::SIGKILL);
                    }
                }
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "git fetch timed out after {} s",
                    timeout.as_secs_f32().ceil() as u64
                ));
            }
        }
    }
}

fn local_head(root: &Path, reason: &str, detail: Option<String>) -> Result<BaseResolution, String> {
    let commit = commit_of(root, "HEAD").ok_or("This repository has no commit yet.")?;
    let base_ref = git_ok(root, &["symbolic-ref", "--short", "-q", "HEAD"])
        .filter(|b| !b.is_empty())
        .unwrap_or_else(|| "HEAD".to_string());
    Ok(BaseResolution {
        base_ref,
        commit,
        fetched_at: None,
        fallback_reason: Some(reason.to_string()),
        fallback_detail: detail,
    })
}

pub(crate) fn resolve_default_base(
    main_root: &Path,
    fetch_timeout: Duration,
) -> Result<BaseResolution, String> {
    let Some(remote) = pick_remote(main_root) else {
        return local_head(main_root, "no-remote", None);
    };
    let Some(branch) = default_branch(main_root, &remote) else {
        return local_head(main_root, "no-default-branch", None);
    };
    let tracking = format!("{remote}/{branch}");
    match fetch(main_root, &remote, &branch, fetch_timeout) {
        Ok(()) => match commit_of(main_root, &format!("refs/remotes/{tracking}")) {
            Some(commit) => Ok(BaseResolution {
                base_ref: tracking,
                commit,
                fetched_at: Some(now()),
                fallback_reason: None,
                fallback_detail: None,
            }),
            None => local_head(main_root, "no-default-branch", None),
        },
        Err(detail) => match commit_of(main_root, &format!("refs/remotes/{tracking}")) {
            Some(commit) => Ok(BaseResolution {
                base_ref: tracking,
                commit,
                fetched_at: None,
                fallback_reason: Some("fetch-failed".to_string()),
                fallback_detail: Some(detail),
            }),
            None => local_head(main_root, "fetch-failed", Some(detail)),
        },
    }
}

/// A base the user picked: any commit-ish, never an option.
pub(crate) fn resolve_explicit_base(root: &Path, base: &str) -> Result<BaseResolution, String> {
    let base = base.trim();
    if base.is_empty() || base.starts_with('-') {
        return Err(format!("Not a valid base: {base}"));
    }
    let commit = commit_of(root, base).ok_or_else(|| format!("Not a valid base: {base}"))?;
    Ok(BaseResolution {
        base_ref: base.to_string(),
        commit,
        fetched_at: None,
        fallback_reason: None,
        fallback_detail: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::worktree::test_support::{git_at, TempRepo};

    const T: Duration = Duration::from_secs(20);

    #[test]
    fn no_remote_uses_local_head() {
        let repo = TempRepo::new();
        let b = resolve_default_base(&repo.path, T).unwrap();
        assert_eq!(b.base_ref, "main");
        assert_eq!(b.commit, repo.git(&["rev-parse", "HEAD"]));
        assert_eq!(b.fallback_reason.as_deref(), Some("no-remote"));
        assert_eq!(b.fetched_at, None);
    }

    #[test]
    fn fetches_the_remote_default_branch() {
        let repo = TempRepo::new();
        let bare = repo.add_bare_origin();
        // The remote moves on; the local tracking ref does not know yet.
        let other = repo.sandbox.join("other");
        git_at(
            &repo.sandbox,
            &["clone", "-q", bare.to_str().unwrap(), "other"],
        );
        git_at(&other, &["config", "user.email", "t@e.x"]);
        git_at(&other, &["config", "user.name", "T"]);
        std::fs::write(other.join("n.txt"), "n").unwrap();
        git_at(&other, &["add", "-A"]);
        git_at(&other, &["commit", "-q", "-m", "remote"]);
        git_at(&other, &["push", "-q", "origin", "main"]);
        let remote_head = git_at(&other, &["rev-parse", "HEAD"]);

        let b = resolve_default_base(&repo.path, T).unwrap();
        assert_eq!(b.base_ref, "origin/main");
        assert_eq!(b.commit, remote_head);
        assert!(b.fetched_at.is_some());
        assert_eq!(b.fallback_reason, None);
        // The local branch is untouched.
        assert_ne!(repo.git(&["rev-parse", "main"]), remote_head);
    }

    #[test]
    fn fetch_failure_falls_back_to_tracking_ref() {
        let repo = TempRepo::new();
        repo.add_bare_origin();
        let tracking = repo.git(&["rev-parse", "origin/main"]);
        repo.commit("local.txt", "l", "local only");
        let missing = repo.sandbox.join("gone.git");
        repo.git(&["remote", "set-url", "origin", missing.to_str().unwrap()]);

        let b = resolve_default_base(&repo.path, T).unwrap();
        assert_eq!(b.base_ref, "origin/main");
        assert_eq!(b.commit, tracking);
        assert_eq!(b.fallback_reason.as_deref(), Some("fetch-failed"));
        assert!(b.fallback_detail.is_some());
        assert_eq!(b.fetched_at, None);
    }

    /// A transport that leaves a grandchild holding stderr (ssh waiting on a
    /// dead host, a credential helper window) must not hold creation past
    /// the timeout.
    #[cfg(unix)]
    #[test]
    fn fetch_timeout_is_not_held_by_a_grandchild() {
        use std::os::unix::fs::PermissionsExt;
        let repo = TempRepo::new();
        repo.add_bare_origin();
        let script = repo.sandbox.join("slow-upload-pack");
        std::fs::write(&script, "#!/bin/sh\nsleep 30 &\nexec sleep 30\n").unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        repo.git(&[
            "config",
            "remote.origin.uploadpack",
            script.to_str().unwrap(),
        ]);
        let started = std::time::Instant::now();
        let b = resolve_default_base(&repo.path, Duration::from_millis(500)).unwrap();
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "took {:?}",
            started.elapsed()
        );
        assert_eq!(b.fallback_reason.as_deref(), Some("fetch-failed"));
        assert_eq!(b.base_ref, "origin/main");
    }

    #[test]
    fn explicit_base_refuses_options() {
        let repo = TempRepo::new();
        assert!(resolve_explicit_base(&repo.path, "--detach").is_err());
        assert!(resolve_explicit_base(&repo.path, "nope").is_err());
        let b = resolve_explicit_base(&repo.path, "main").unwrap();
        assert_eq!(b.base_ref, "main");
        assert_eq!(b.commit, repo.git(&["rev-parse", "HEAD"]));
    }
}

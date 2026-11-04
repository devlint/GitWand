//! v3.13 — stop the processes running in a linked worktree (spec §8), before
//! it is removed or merged back.
//!
//! 1. GitWand's own terminal sessions in the worktree are closed, with
//!    their whole session (`close_session_ids`).
//! 2. After 500 ms, the processes whose working directory is still inside
//!    the worktree are swept. Those GitWand started (same session as a
//!    closed one, or a descendant of GitWand) get SIGTERM, then SIGKILL
//!    after 2 s. The others are only listed, unless the user clicked
//!    "Stop all" (`kill_foreign`).
//!
//! What is returned is what still runs there. Windows has no sweep (see
//! `process_tree`): its Job Objects cover what GitWand started.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use super::terminal::{close_session_ids, sessions_under};
use crate::process_tree::{self, ProcInfo};

#[tauri::command]
pub(crate) async fn worktree_stop_processes(
    cwd: String,
    path: String,
    kill_foreign: bool,
) -> Result<Vec<ProcInfo>, String> {
    let repo =
        crate::git::safe_repo_path(cwd.trim(), ".").map_err(|e| format!("invalid cwd: {e}"))?;
    tauri::async_runtime::spawn_blocking(move || {
        stop_processes_in(&repo, Path::new(path.trim()), kill_foreign)
    })
    .await
    .map_err(|e| format!("worktree process stop failed: {e}"))?
}

/// Grace between closing the sessions and the sweep (spec §8 step 3).
const SWEEP_DELAY: Duration = Duration::from_millis(500);
/// SIGTERM → SIGKILL (spec §8 step 3).
const KILL_AFTER: Duration = Duration::from_secs(2);

fn stop_processes_in(
    repo: &Path,
    worktree: &Path,
    kill_foreign: bool,
) -> Result<Vec<ProcInfo>, String> {
    let worktree = linked_worktree(repo, worktree)?;

    let mut own = close_session_ids(&sessions_under(&worktree));
    let me = std::process::id();
    own.insert(me);
    std::thread::sleep(SWEEP_DELAY);

    let procs = process_tree::list_processes();
    let targets: Vec<u32> = process_tree::pids_with_cwd_under(&worktree)
        .into_iter()
        .filter(|&pid| pid > 1 && pid != me)
        .filter(|&pid| {
            kill_foreign
                || process_tree::session_of(pid).is_some_and(|sid| own.contains(&sid))
                || process_tree::is_descendant(pid, &own, &procs)
        })
        .collect();
    terminate(&targets);

    let procs = process_tree::list_processes();
    Ok(process_tree::pids_with_cwd_under(&worktree)
        .into_iter()
        .filter(|&pid| pid != me)
        .map(|pid| {
            procs
                .iter()
                .find(|p| p.pid == pid)
                .cloned()
                .unwrap_or(ProcInfo {
                    pid,
                    ppid: 0,
                    name: "?".to_string(),
                })
        })
        .collect())
}

/// `worktree`, canonical, when it is a linked worktree of `repo`: never the
/// main worktree, never a path git does not list.
fn linked_worktree(repo: &Path, worktree: &Path) -> Result<PathBuf, String> {
    let refuse = || {
        format!(
            "Not a linked worktree of this repository: {}",
            worktree.display()
        )
    };
    let canon = worktree.canonicalize().map_err(|_| refuse())?;
    let out = crate::git::git_cmd()
        .args(["worktree", "list", "--porcelain"])
        .current_dir(repo)
        .output()
        .map_err(|e| format!("cannot run git: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let linked = text
        .split("\n\n")
        .skip(1) // the main worktree
        .filter_map(|block| block.lines().find_map(|l| l.strip_prefix("worktree ")))
        .filter_map(|p| Path::new(p).canonicalize().ok())
        .any(|p| p == canon);
    if linked {
        Ok(canon)
    } else {
        Err(refuse())
    }
}

/// SIGTERM, then SIGKILL after `KILL_AFTER` for those still alive. Pids
/// only, never a group: GitWand's own group is never signalled.
#[cfg(unix)]
fn terminate(pids: &[u32]) {
    let pids: Vec<libc::pid_t> = pids
        .iter()
        .filter_map(|&p| libc::pid_t::try_from(p).ok())
        .filter(|&p| p > 1)
        .collect();
    let alive = |p: libc::pid_t| {
        // SAFETY: signal 0 only checks the pid exists; EPERM is alive.
        let probed = unsafe { libc::kill(p, 0) };
        probed == 0 || std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
    };
    for &p in &pids {
        // SAFETY: plain syscall.
        unsafe { libc::kill(p, libc::SIGTERM) };
    }
    let deadline = Instant::now() + KILL_AFTER;
    let mut left = pids;
    while !left.is_empty() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
        left.retain(|&p| alive(p));
    }
    for &p in &left {
        // SAFETY: plain syscall.
        unsafe { libc::kill(p, libc::SIGKILL) };
    }
}

/// Windows: the sweep lists nothing (see `process_tree`), so there is
/// nothing to terminate here; the Job Objects already took the sessions.
#[cfg(not(unix))]
fn terminate(_pids: &[u32]) {}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::commands::terminal::{spawn_session, SpawnKind, SpawnSpec};
    use std::collections::HashMap;

    struct Repo {
        root: PathBuf,
        main: PathBuf,
        linked: PathBuf,
    }

    impl Repo {
        fn new(name: &str) -> Repo {
            let root =
                std::env::temp_dir().join(format!("gitwand-wtproc-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&root);
            std::fs::create_dir_all(root.join("main")).unwrap();
            let root = root.canonicalize().unwrap();
            let main = root.join("main");
            let git = |dir: &Path, args: &[&str]| {
                let out = crate::git::git_cmd()
                    .args(args)
                    .current_dir(dir)
                    .output()
                    .unwrap();
                assert!(
                    out.status.success(),
                    "git {args:?}: {}",
                    String::from_utf8_lossy(&out.stderr)
                );
            };
            git(&main, &["init", "-q", "-b", "main"]);
            git(&main, &["config", "user.name", "Test"]);
            git(&main, &["config", "user.email", "t@example.com"]);
            git(&main, &["config", "commit.gpgsign", "false"]);
            std::fs::write(main.join("a.txt"), "a").unwrap();
            git(&main, &["add", "."]);
            git(&main, &["commit", "-q", "-m", "init"]);
            let linked = root.join("linked wt");
            git(
                &main,
                &[
                    "worktree",
                    "add",
                    "-q",
                    "-b",
                    "task",
                    linked.to_str().unwrap(),
                ],
            );
            std::fs::create_dir_all(root.join("outside")).unwrap();
            Repo { root, main, linked }
        }
    }

    impl Drop for Repo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn alive(pid: u32) -> bool {
        // SAFETY: signal 0 only checks the pid exists.
        unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
    }

    fn wait_gone(pid: u32) -> bool {
        let deadline = Instant::now() + Duration::from_secs(5);
        while alive(pid) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        !alive(pid)
    }

    #[test]
    fn refuses_main_worktree_and_non_worktree() {
        let r = Repo::new("refuse");
        let err = stop_processes_in(&r.main, &r.main, true).unwrap_err();
        assert!(err.contains("Not a linked worktree"), "{err}");
        assert!(stop_processes_in(&r.main, Path::new("/"), true).is_err());
        assert!(stop_processes_in(&r.main, &r.root.join("outside"), true).is_err());
        assert!(stop_processes_in(&r.main, &r.root.join("missing"), true).is_err());
    }

    #[test]
    fn foreign_process_is_listed_not_killed() {
        let r = Repo::new("foreign");
        // The sleep is reparented away from us once `sh` exits.
        let out = std::process::Command::new("sh")
            .args(["-c", "sleep 300 >/dev/null 2>&1 & echo $!"])
            .current_dir(&r.linked)
            .output()
            .unwrap();
        let sleep_pid: u32 = String::from_utf8_lossy(&out.stdout).trim().parse().unwrap();
        let left = stop_processes_in(&r.main, &r.linked, false).unwrap();
        assert!(left.iter().any(|p| p.pid == sleep_pid), "{left:?}");
        assert!(alive(sleep_pid));
        let left = stop_processes_in(&r.main, &r.linked, true).unwrap();
        assert!(left.is_empty(), "{left:?}");
        assert!(wait_gone(sleep_pid));
    }

    #[test]
    fn own_session_in_worktree_is_stopped() {
        let r = Repo::new("own");
        let id = spawn_session(
            SpawnSpec {
                cwd: r.linked.clone(),
                kind: SpawnKind::Command {
                    command: "sleep 300 & sleep 300".into(),
                    shell: Some("/bin/sh".into()),
                },
                env: HashMap::new(),
                cols: 80,
                rows: 24,
            },
            Box::new(|_| true),
            Box::new(|_| {}),
        )
        .unwrap();
        let _ = id;
        std::thread::sleep(Duration::from_millis(300));
        let before = crate::process_tree::pids_with_cwd_under(&r.linked);
        assert!(!before.is_empty());
        let left = stop_processes_in(&r.main, &r.linked, false).unwrap();
        assert!(left.is_empty(), "{left:?}");
        assert!(before.iter().all(|&p| wait_gone(p)));
    }
}

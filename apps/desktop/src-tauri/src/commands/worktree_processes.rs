//! v3.13 — stop the processes running in a linked worktree (spec §8), before
//! it is removed or merged back.
//!
//! 1. GitWand's own terminal sessions in the worktree are closed, with
//!    their whole session (`close_session_ids`).
//! 2. After 500 ms, the processes whose working directory is still inside
//!    the worktree are swept. Those GitWand started (in the session of one
//!    it spawned there, open or ended, or a descendant of GitWand) get SIGTERM, then SIGKILL
//!    after 2 s. The others are only listed, unless the user clicked
//!    "Stop all" (`kill_foreign`).
//!
//! What is returned is what still runs there. Windows has no sweep (see
//! `process_tree`): its Job Objects cover what GitWand started.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use super::terminal::{close_session_ids, recorded_sessions_under, sessions_under};
use crate::process_tree::{self, ProcInfo};

#[tauri::command]
pub(crate) async fn worktree_stop_processes(
    cwd: String,
    path: String,
    kill_foreign: bool,
) -> Result<Vec<ProcInfo>, String> {
    let repo =
        crate::git::safe_repo_path(cwd.trim(), ".").map_err(|e| format!("invalid cwd: {e}"))?;
    // The single audited path guard (AGENTS.md); `linked_worktree` then
    // narrows it to a worktree git lists for this repository.
    let worktree =
        crate::git::safe_repo_path(path.trim(), ".").map_err(|e| format!("invalid path: {e}"))?;
    tauri::async_runtime::spawn_blocking(move || stop_processes_in(&repo, &worktree, kill_foreign))
        .await
        .map_err(|e| format!("worktree process stop failed: {e}"))?
}

/// Grace between closing the sessions and the sweep (spec §8 step 3).
const SWEEP_DELAY: Duration = Duration::from_millis(500);
/// SIGTERM → SIGKILL (spec §8 step 3).
const KILL_AFTER: Duration = Duration::from_secs(2);

/// GitWand and its ancestors (the shell, `pnpm`, `cargo` it was started
/// from, maybe inside this very worktree): never signalled, never listed.
fn self_and_ancestors(me: u32, procs: &[ProcInfo]) -> HashSet<u32> {
    let mut chain = HashSet::from([me]);
    let mut current = me;
    while let Some(p) = procs.iter().find(|p| p.pid == current) {
        if p.ppid <= 1 || !chain.insert(p.ppid) {
            break;
        }
        current = p.ppid;
    }
    chain
}

/// The swept pids to stop: owned ones (in a session GitWand spawned, or a
/// descendant of `own`), plus every other one when `kill_foreign` — never
/// pid ≤ 1, GitWand or its ancestors.
fn select_targets(
    candidates: &[u32],
    me: u32,
    own: &HashSet<u32>,
    procs: &[ProcInfo],
    kill_foreign: bool,
    session_of: impl Fn(u32) -> Option<u32>,
) -> Vec<u32> {
    let spared = self_and_ancestors(me, procs);
    candidates
        .iter()
        .copied()
        .filter(|&pid| pid > 1 && !spared.contains(&pid))
        .filter(|&pid| {
            kill_foreign
                || session_of(pid).is_some_and(|sid| own.contains(&sid))
                || process_tree::is_descendant(pid, own, procs)
        })
        .collect()
}

/// What to report as still running: the swept pids, minus pid ≤ 1, GitWand
/// and its ancestors (which "Stop all" would not stop either).
fn listed(candidates: &[u32], me: u32, procs: &[ProcInfo]) -> Vec<u32> {
    let spared = self_and_ancestors(me, procs);
    candidates
        .iter()
        .copied()
        .filter(|&pid| pid > 1 && !spared.contains(&pid))
        .collect()
}

fn stop_processes_in(
    repo: &Path,
    worktree: &Path,
    kill_foreign: bool,
) -> Result<Vec<ProcInfo>, String> {
    let worktree = linked_worktree(repo, worktree)?;

    let mut own = close_session_ids(&sessions_under(&worktree));
    own.extend(recorded_sessions_under(&worktree));
    let me = std::process::id();
    own.insert(me);
    std::thread::sleep(SWEEP_DELAY);

    let procs = process_tree::list_processes();
    let swept = process_tree::pids_with_cwd_under(&worktree);
    let targets = select_targets(
        &swept,
        me,
        &own,
        &procs,
        kill_foreign,
        process_tree::session_of,
    );
    terminate(&targets);

    let procs = process_tree::list_processes();
    let swept = process_tree::pids_with_cwd_under(&worktree);
    Ok(listed(&swept, me, &procs)
        .into_iter()
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
    use std::collections::{HashMap, HashSet};

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
    fn stop_all_never_targets_gitwand_or_its_ancestors() {
        let p = |pid, ppid| ProcInfo {
            pid,
            ppid,
            name: "x".into(),
        };
        // 1 → 50 (user's shell) → 60 (pnpm) → 70 (GitWand) → 80 (a git child);
        // 90 is foreign. All have their cwd in the worktree.
        let procs = [p(1, 0), p(50, 1), p(60, 50), p(70, 60), p(80, 70), p(90, 1)];
        let candidates = [1, 50, 60, 70, 80, 90];
        let own = HashSet::from([70]);
        let none = |_| None;
        assert_eq!(
            select_targets(&candidates, 70, &own, &procs, true, none),
            vec![80, 90]
        );
        assert_eq!(
            select_targets(&candidates, 70, &own, &procs, false, none),
            vec![80]
        );
        assert_eq!(listed(&candidates, 70, &procs), vec![80, 90]);
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

    /// An interactive shell's background job (its own group, with job
    /// control) outlives the shell, keeping the ended session's id: GitWand
    /// started it, so it is stopped without "Stop all".
    #[test]
    fn job_left_by_an_ended_session_is_still_owned() {
        let r = Repo::new("ended");
        let (tx, rx) = std::sync::mpsc::channel::<String>();
        let (etx, erx) = std::sync::mpsc::channel();
        spawn_session(
            SpawnSpec {
                cwd: r.linked.clone(),
                kind: SpawnKind::Command {
                    command: "set -m; sleep 300 </dev/null >/dev/null 2>&1 & echo BG:$!".into(),
                    shell: Some("/bin/sh".into()),
                },
                env: HashMap::new(),
                cols: 80,
                rows: 24,
            },
            Box::new(move |c| tx.send(c).is_ok()),
            Box::new(move |code| {
                let _ = etx.send(code);
            }),
        )
        .unwrap();
        erx.recv_timeout(Duration::from_secs(10))
            .expect("session ends");
        let out: String = rx.try_iter().collect();
        let bg: u32 = out
            .split("BG:")
            .nth(1)
            .map(|r| {
                r.chars()
                    .take_while(char::is_ascii_digit)
                    .collect::<String>()
            })
            .and_then(|d| d.parse().ok())
            .unwrap_or_else(|| panic!("no BG pid in {out:?}"));
        std::thread::sleep(Duration::from_millis(500));
        assert!(alive(bg), "the job outlives its shell");
        let left = stop_processes_in(&r.main, &r.linked, false).unwrap();
        assert!(left.is_empty(), "{left:?}");
        assert!(wait_gone(bg));
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

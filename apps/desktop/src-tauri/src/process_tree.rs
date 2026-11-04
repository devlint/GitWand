//! Read-only view of the machine's processes (v3.13): parent, session and
//! working directory, for stopping what runs inside a worktree. Shells out to
//! `ps` / `lsof` (macOS) or reads `/proc` (Linux), never through a shell.
//! Windows has no working-directory sweep: every function returns nothing.

#![allow(dead_code)] // consumed by worktree stopping (Tasks 3 and 4)

use std::collections::HashSet;
use std::path::Path;

use serde::Serialize;

#[derive(Clone, Debug, Serialize, PartialEq)]
pub(crate) struct ProcInfo {
    pub pid: u32,
    pub ppid: u32,
    pub name: String,
}

/// Every process: `ps -A -o pid=,ppid=,comm=`. Empty on Windows, or when
/// `ps` fails.
pub(crate) fn list_processes() -> Vec<ProcInfo> {
    #[cfg(unix)]
    {
        let Ok(out) = std::process::Command::new("ps")
            .args(["-A", "-o", "pid=,ppid=,comm="])
            .output()
        else {
            return Vec::new();
        };
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .filter_map(parse_ps_line)
            .collect()
    }
    #[cfg(not(unix))]
    Vec::new()
}

/// `"  123   1 /usr/bin/some name"` → pid, ppid, then the rest as the name
/// (macOS prints the executable's path, which may hold spaces).
fn parse_ps_line(line: &str) -> Option<ProcInfo> {
    let line = line.trim_start();
    let (pid, rest) = line.split_once(char::is_whitespace)?;
    let rest = rest.trim_start();
    let (ppid, name) = rest.split_once(char::is_whitespace).unwrap_or((rest, ""));
    Some(ProcInfo {
        pid: pid.parse().ok()?,
        ppid: ppid.parse().ok()?,
        name: name.trim().to_string(),
    })
}

/// The session id of `pid` (`getsid`). `None` when the process is gone, on
/// error, and on Windows.
pub(crate) fn session_of(pid: u32) -> Option<u32> {
    #[cfg(unix)]
    {
        let pid = libc::pid_t::try_from(pid).ok()?;
        // SAFETY: plain syscall, no memory is shared with it.
        let sid = unsafe { libc::getsid(pid) };
        u32::try_from(sid).ok()
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        None
    }
}

/// The processes whose working directory is `root` or inside it, compared
/// component-wise after resolving symlinks on both sides. Unreadable entries
/// are skipped. Empty on Windows (reading another process's working
/// directory needs its PEB).
pub(crate) fn pids_with_cwd_under(root: &Path) -> Vec<u32> {
    let Ok(root) = root.canonicalize() else {
        return Vec::new();
    };
    let under = |cwd: &Path| {
        cwd.canonicalize()
            .map(|c| c.starts_with(&root))
            .unwrap_or(false)
    };
    let mut pids: Vec<u32> = cwds()
        .into_iter()
        .filter(|(_, c)| under(c))
        .map(|(p, _)| p)
        .collect();
    pids.sort_unstable();
    pids.dedup();
    pids
}

/// (pid, working directory) for every process we can read.
#[cfg(target_os = "macos")]
fn cwds() -> Vec<(u32, std::path::PathBuf)> {
    // lsof exits 1 when some processes are unreadable: parse stdout anyway.
    let Ok(out) = std::process::Command::new("lsof")
        .args(["-a", "-d", "cwd", "-F", "pn"])
        .output()
    else {
        return Vec::new();
    };
    let mut result = Vec::new();
    let mut pid: Option<u32> = None;
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        if let Some(p) = line.strip_prefix('p') {
            pid = p.parse().ok();
        } else if let (Some(n), Some(p)) = (line.strip_prefix('n'), pid) {
            result.push((p, std::path::PathBuf::from(n)));
        }
    }
    result
}

#[cfg(all(unix, not(target_os = "macos")))]
fn cwds() -> Vec<(u32, std::path::PathBuf)> {
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter_map(|e| {
            let pid: u32 = e.file_name().to_str()?.parse().ok()?;
            let cwd = std::fs::read_link(e.path().join("cwd")).ok()?;
            Some((pid, cwd))
        })
        .collect()
}

#[cfg(not(unix))]
fn cwds() -> Vec<(u32, std::path::PathBuf)> {
    Vec::new()
}

/// Whether `pid` is one of `ancestors` or descends from one, following
/// `ppid` links. Stops at pid 0/1, at an unknown pid and on a cycle.
pub(crate) fn is_descendant(pid: u32, ancestors: &HashSet<u32>, procs: &[ProcInfo]) -> bool {
    let mut seen = HashSet::new();
    let mut current = pid;
    loop {
        if ancestors.contains(&current) {
            return true;
        }
        if current <= 1 || !seen.insert(current) {
            return false;
        }
        match procs.iter().find(|p| p.pid == current) {
            Some(p) => current = p.ppid,
            None => return false,
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::process::CommandExt;
    use std::process::{Child, Command};

    struct Killed(Child);
    impl Drop for Killed {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    fn scratch(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("gitwand-ptree-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d.canonicalize().unwrap()
    }

    #[test]
    fn lists_a_spawned_child_with_its_parent() {
        let child = Killed(Command::new("sleep").arg("30").spawn().unwrap());
        let pid = child.0.id();
        let found = list_processes().into_iter().find(|p| p.pid == pid);
        let found = found.expect("child listed");
        assert_eq!(found.ppid, std::process::id());
        assert!(found.name.contains("sleep"), "{found:?}");
    }

    #[test]
    fn session_of_a_setsid_child_is_its_own_pid() {
        let mut cmd = Command::new("sleep");
        cmd.arg("30");
        // SAFETY: setsid is async-signal-safe.
        unsafe {
            cmd.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
        let child = Killed(cmd.spawn().unwrap());
        let pid = child.0.id();
        assert_eq!(session_of(pid), Some(pid));
        assert_ne!(session_of(std::process::id()), Some(pid));
    }

    #[test]
    fn cwd_sweep_matches_symlinked_and_spaced_paths() {
        let base = scratch("sweep");
        let dir = base.join("wt with space");
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::create_dir_all(base.join("wt")).unwrap();
        let link = base.join("link");
        std::os::unix::fs::symlink(&dir, &link).unwrap();
        let child = Killed(
            Command::new("sleep")
                .arg("30")
                .current_dir(dir.join("sub"))
                .spawn()
                .unwrap(),
        );
        let pid = child.0.id();
        // The child may not have reached exec yet: retry briefly.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        while !pids_with_cwd_under(&link).contains(&pid) && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        assert!(pids_with_cwd_under(&link).contains(&pid));
        assert!(pids_with_cwd_under(&dir).contains(&pid));
        assert!(!pids_with_cwd_under(&base.join("wt")).contains(&pid));
        drop(child);
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn is_descendant_walks_the_ppid_chain() {
        let p = |pid, ppid| ProcInfo {
            pid,
            ppid,
            name: "x".into(),
        };
        let procs = [p(1, 0), p(10, 1), p(11, 10), p(12, 11), p(20, 20)];
        assert!(is_descendant(12, &HashSet::from([10]), &procs));
        assert!(is_descendant(11, &HashSet::from([11]), &procs));
        assert!(!is_descendant(10, &HashSet::from([11]), &procs));
        assert!(
            !is_descendant(20, &HashSet::from([10]), &procs),
            "cycle stops"
        );
        assert!(
            !is_descendant(99, &HashSet::from([10]), &procs),
            "unknown pid"
        );
    }
}

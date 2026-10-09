//! Terminal PTY intégré : spawn de shells interactifs dans des PTY,
//! streaming d'output vers le frontend via `tauri::ipc::Channel`.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use tauri::ipc::Channel;

use crate::git::safe_repo_path;
use crate::types::CLAUDE_AUTH_OVERRIDE_ENV;

/// Une session PTY vivante. Le thread lecteur est détaché ; il sort sur EOF.
struct PtyHandle {
    /// Master PTY wrapped in Arc<Mutex> so terminal_resize can clone the Arc,
    /// release the global sessions lock, then call .resize() outside the lock —
    /// preventing the resize ioctl from blocking concurrent terminal_write calls
    /// for all other sessions (fix for the mutex-held-across-ioctl bug).
    master: Arc<Mutex<Box<dyn portable_pty::MasterPty + Send>>>,
    /// Writer wrappé dans son propre Arc<Mutex> pour découpler les I/O du verrou du registre.
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
}

fn sessions() -> &'static Mutex<HashMap<u64, PtyHandle>> {
    static S: OnceLock<Mutex<HashMap<u64, PtyHandle>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Verrouille le registre global de sessions en gérant proprement le poison.
fn lock_sessions() -> std::sync::MutexGuard<'static, HashMap<u64, PtyHandle>> {
    sessions().lock().unwrap_or_else(|e| e.into_inner())
}

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

/// Résout le shell à lancer : override explicite, sinon $SHELL (Unix) /
/// %ComSpec% ou powershell (Windows).
///
/// Fix 2 — Shell path validation: a relative path with directory components
/// (e.g. `../../bin/evil`) could otherwise reach `CommandBuilder` verbatim.
/// We accept:
///   - bare names like `"zsh"` or `"bash"` (no path separator)
///   - absolute paths like `"/bin/zsh"` or `"C:\\Windows\\System32\\cmd.exe"`
///
/// We reject (fall back to default) any path that contains a separator
/// but is not absolute, to prevent directory-traversal attacks via settings.
fn resolve_shell(shell: &Option<String>) -> String {
    fn default_shell() -> String {
        #[cfg(windows)]
        {
            std::env::var("ComSpec").unwrap_or_else(|_| "powershell.exe".to_string())
        }
        #[cfg(not(windows))]
        {
            std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
        }
    }

    if let Some(s) = shell {
        let shell = s.trim();
        if !shell.is_empty() {
            let p = std::path::Path::new(shell);
            // Reject relative paths that have directory components (e.g. "../../evil").
            // Bare names (no separator) and absolute paths are both acceptable.
            if p.components().count() > 1 && !p.is_absolute() {
                return default_shell();
            }
            return shell.to_string();
        }
    }
    default_shell()
}

/// Login-shell flag for the resolved shell, if it supports one.
///
/// `-l` is **not** universal: it is correct for the POSIX family
/// (bash/zsh/sh/dash/ksh/fish/tcsh/csh), but other shells (nushell,
/// powershell, xonsh, elvish…) reject it with `unknown option '-l'`,
/// which kills the PTY immediately. For anything we don't recognise we
/// skip the flag — the shell still launches, just not as a login shell.
#[cfg(not(windows))]
fn login_flag(shell_path: &str) -> Option<&'static str> {
    let name = std::path::Path::new(shell_path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match name.as_str() {
        "bash" | "zsh" | "sh" | "dash" | "ksh" | "fish" | "tcsh" | "csh" => Some("-l"),
        _ => None,
    }
}

#[tauri::command]
pub(crate) fn terminal_open(
    cwd: String,
    shell: Option<String>,
    agent: Option<String>,
    cols: u16,
    rows: u16,
    on_output: Channel<String>,
) -> Result<u64, String> {
    // Validate and canonicalize cwd through the single audited guard (AGENTS.md:
    // "every file-system operation on user-supplied paths must go through
    // safe_repo_path()"). Using "." as the relative component mirrors the
    // pattern in scratch.rs:canonical_cwd — safe_repo_path(cwd, ".") resolves
    // and traversal-guards the directory itself, keeping this in sync with any
    // future improvements to the shared guard.
    let canon = safe_repo_path(cwd.trim(), ".").map_err(|e| format!("invalid cwd: {e}"))?;
    if !canon.is_dir() {
        return Err("cwd is not a directory".to_string());
    }

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty failed: {e}"))?;

    // First-class agent vs shell resolution. Each agent is resolved via its
    // dedicated binary resolver (same logic as detect_*_cli) rather than
    // relying on the PTY's PATH, which may not include user-local install
    // paths (e.g. ~/.opencode/bin, ~/.claude/local, ~/.local/bin).
    let agent_kind = agent.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let program = match agent_kind {
        Some("claude") => super::ai::resolve_claude_binary()
            .ok_or_else(|| "Binaire `claude` introuvable. Installez-le avec `npm install -g @anthropic-ai/claude-code`.".to_string())?,
        Some("codex") => super::ai::resolve_codex_binary()
            .ok_or_else(|| "Binaire `codex` introuvable. Installez-le avec `npm install -g @openai/codex`.".to_string())?,
        Some("opencode") => super::ai::resolve_opencode_binary()
            .ok_or_else(|| "Binaire `opencode` introuvable. Installez-le avec `npm install -g opencode-ai` ou via `curl -fsSL https://opencode.ai/install | bash`.".to_string())?,
        Some("antigravity") => super::ai::resolve_antigravity_binary()
            .ok_or_else(|| "Binaire `agy` introuvable. Installez-le avec `curl -fsSL https://antigravity.google/cli/install.sh | bash`.".to_string())?,
        _ => resolve_shell(&shell),
    };
    let mut cmd = CommandBuilder::new(&program);
    // Login shell sur Unix pour charger le profil utilisateur (PATH, aliases…).
    // Seulement pour les shells qui acceptent `-l` (cf. login_flag) — sinon
    // le PTY meurt avec `unknown option '-l'`. Un agent n'est jamais un login shell.
    #[cfg(not(windows))]
    if agent_kind.is_none() {
        if let Some(flag) = login_flag(&program) {
            cmd.arg(flag);
        }
    }
    cmd.cwd(&canon);
    // Strip GitWand's sensitive auth env vars before handing over an interactive
    // PTY. Mirrors strip_claude_auth_env (ai.rs) / claudeSpawnEnv (dev-server):
    // keeps API keys held by the GitWand process from leaking into the terminal,
    // and lets the `claude` agent fall back to its OAuth session instead of being
    // hijacked by a stale ANTHROPIC_API_KEY.
    for var in CLAUDE_AUTH_OVERRIDE_ENV {
        cmd.env_remove(var);
    }
    // PATH enrichment (Homebrew / MacPorts) — shares hidden_cmd's single source
    // of truth so the PTY resolves tools from the same prefixes as every other
    // GitWand subprocess (no divergent copy that drops /usr/local/sbin etc.).
    #[cfg(target_os = "macos")]
    if let Some(extra) = crate::git::macos_enriched_path() {
        cmd.env("PATH", extra);
    }

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn shell failed: {e}"))?;

    // Obtain the reader and writer BEFORE inserting into the registry. If either
    // step fails after spawn_command() succeeded we must kill the child — otherwise
    // it becomes an orphaned process holding a PTY slave indefinitely.
    let mut reader = match pair.master.try_clone_reader() {
        Ok(r) => r,
        Err(e) => {
            let _ = child.kill();
            return Err(format!("clone reader failed: {e}"));
        }
    };
    let writer = match pair.master.take_writer() {
        Ok(w) => w,
        Err(e) => {
            let _ = child.kill();
            return Err(format!("take writer failed: {e}"));
        }
    };

    let id = NEXT_ID.fetch_add(1, Ordering::SeqCst);
    let master_arc: Arc<Mutex<Box<dyn portable_pty::MasterPty + Send>>> =
        Arc::new(Mutex::new(pair.master));
    let writer_arc: Arc<Mutex<Box<dyn Write + Send>>> = Arc::new(Mutex::new(writer));

    lock_sessions().insert(
        id,
        PtyHandle {
            master: master_arc,
            writer: writer_arc,
            child,
        },
    );

    // Thread lecteur : pousse les chunks vers le frontend.
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        let mut carry: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break, // EOF : shell terminé
                Ok(n) => {
                    // Prepend carry bytes from the previous iteration.
                    let data: Vec<u8> = if carry.is_empty() {
                        buf[..n].to_vec()
                    } else {
                        let mut v = std::mem::take(&mut carry);
                        v.extend_from_slice(&buf[..n]);
                        v
                    };

                    // Find the last valid UTF-8 boundary.
                    let (chunk, remainder) = match std::str::from_utf8(&data) {
                        Ok(s) => (s.to_string(), vec![]),
                        Err(e) => {
                            let valid_end = e.valid_up_to();
                            (
                                String::from_utf8_lossy(&data[..valid_end]).to_string(),
                                data[valid_end..].to_vec(),
                            )
                        }
                    };

                    carry = remainder;
                    if !chunk.is_empty() && on_output.send(chunk).is_err() {
                        break; // frontend parti
                    }
                }
                Err(_) => break,
            }
        }
        // Flush any remaining carry bytes on EOF.
        if !carry.is_empty() {
            let _ = on_output.send(String::from_utf8_lossy(&carry).to_string());
        }
        // Nettoyage : retirer la session du registre quand le PTY se ferme.
        lock_sessions().remove(&id);
    });

    Ok(id)
}

#[tauri::command]
pub(crate) fn terminal_write(id: u64, data: String) -> Result<(), String> {
    // Clone l'Arc sous le verrou du registre, puis relâche immédiatement ce verrou
    // avant d'effectuer l'écriture bloquante, évitant de bloquer toutes les autres
    // commandes terminal si le buffer PTY du noyau est plein.
    let writer_arc = {
        let map = lock_sessions();
        map.get(&id)
            .map(|h| Arc::clone(&h.writer))
            .ok_or("session not found")?
    };
    let mut writer = writer_arc.lock().unwrap_or_else(|e| e.into_inner());
    writer
        .write_all(data.as_bytes())
        .map_err(|e| format!("write failed: {e}"))?;
    writer.flush().map_err(|e| format!("flush failed: {e}"))
}

#[tauri::command]
pub(crate) fn terminal_resize(id: u64, cols: u16, rows: u16) -> Result<(), String> {
    // Clone the Arc under the sessions lock, then release the lock before the
    // resize ioctl. This mirrors terminal_write's pattern: holding the global
    // sessions lock across a blocking kernel call would stall terminal_write
    // (and any other command) for ALL sessions during every resize event.
    let master_arc = {
        let map = lock_sessions();
        map.get(&id)
            .map(|h| Arc::clone(&h.master))
            .ok_or("session not found")?
    };
    let result = master_arc
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("resize failed: {e}"));
    result
}

/// Async, with the shutdown on a blocking thread: it waits for the processes.
#[tauri::command]
pub(crate) async fn terminal_close(id: u64) -> Result<(), String> {
    let handle = lock_sessions().remove(&id);
    if let Some(h) = handle {
        tauri::async_runtime::spawn_blocking(move || close_sessions(vec![h], true))
            .await
            .map_err(|e| format!("terminal close failed: {e}"))?;
    }
    Ok(())
}

/// Tue toutes les sessions (appelé au quit de l'app, sur le thread de la
/// boucle d'événements) : grâce SIGHUP courte (100 ms au total, pas par
/// session), sans attendre les leaders ensuite.
pub(crate) fn terminal_close_all() {
    let handles: Vec<PtyHandle> = lock_sessions().drain().map(|(_, h)| h).collect();
    close_sessions(handles, false);
}

/// Stop sessions' processes, not only their leaders, and reap the leaders:
/// once this returns they no longer write anywhere (merge-back of an AI task
/// reads the scratch right after). SIGHUP first, as a terminal hanging up
/// does, so shells save their history and agents their session; SIGKILL for
/// whatever is left after a grace period. `wait_leaders` then waits for the
/// leaders, bounded, for a process stuck in an uninterruptible syscall. On
/// Windows only the leader is killed.
fn close_sessions(mut handles: Vec<PtyHandle>, wait_leaders: bool) {
    #[cfg(unix)]
    {
        let groups: Vec<libc::pid_t> = handles.iter().flat_map(session_groups).collect();
        let grace = Duration::from_millis(if wait_leaders { 500 } else { 100 });
        stop_groups(&groups, grace, || {
            // Reap the leaders, so a zombie doesn't keep its group alive.
            for h in &mut handles {
                let _ = h.child.try_wait();
            }
        });
    }
    // Windows: the leader is all we kill. On Unix the group SIGKILL above
    // already reached it.
    #[cfg(not(unix))]
    for h in &mut handles {
        let _ = h.child.kill();
    }
    if !wait_leaders {
        return;
    }
    let deadline = Instant::now() + Duration::from_secs(2);
    for h in &mut handles {
        while matches!(h.child.try_wait(), Ok(None)) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

/// The process groups of a session. The leader runs in its own session and
/// group (portable-pty `setsid`s it); what it spawns stays in that group,
/// except jobs an interactive shell moves to their own, of which the
/// foreground one is the terminal's group — taken only while its leader is
/// still in this session, so a stale, reused id is never signalled. Survive:
/// a background job of the shell, a process that called `setsid`, and a
/// foreground job whose leader already exited.
#[cfg(unix)]
fn session_groups(h: &PtyHandle) -> Vec<libc::pid_t> {
    let Some(leader) = h.child.process_id().map(|p| p as libc::pid_t) else {
        return Vec::new();
    };
    let mut groups = vec![leader];
    let foreground = h.master.lock().ok().and_then(|m| m.process_group_leader());
    if let Some(fg) = foreground {
        // SAFETY: plain syscall, no memory is shared with it.
        if fg != leader && unsafe { libc::getsid(fg) } == leader {
            groups.push(fg);
        }
    }
    groups
}

/// SIGHUP `groups`, give them up to `grace` to empty, then SIGKILL the ones
/// still populated. Every member counts, not only the leaders: an agent
/// still saving its session after its shell exited gets the whole grace
/// period. `reap` runs before each check, for the caller to reap its own
/// children. An emptied group is not signalled again: its id is free for
/// reuse once its leader is reaped.
#[cfg(unix)]
fn stop_groups(groups: &[libc::pid_t], grace: Duration, mut reap: impl FnMut()) {
    signal_groups(groups, libc::SIGHUP);
    let deadline = Instant::now() + grace;
    let mut alive: Vec<libc::pid_t> = groups.to_vec();
    loop {
        reap();
        alive.retain(|&g| group_alive(g));
        if alive.is_empty() || Instant::now() >= deadline {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    signal_groups(&alive, libc::SIGKILL);
}

#[cfg(unix)]
fn group_alive(pgid: libc::pid_t) -> bool {
    // SAFETY: signal 0 only checks the group has a member. Only ESRCH means
    // empty: EPERM (a setuid member, `sudo`) is a member still running.
    let probed = unsafe { libc::killpg(pgid, 0) };
    probed == 0 || std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
}

#[cfg(unix)]
fn signal_groups(groups: &[libc::pid_t], signal: libc::c_int) {
    for &pgid in groups {
        // Never 0 (our own group), 1 (init's) or GitWand's own group.
        // SAFETY: plain syscalls, no memory is shared with them.
        if pgid > 1 && pgid != unsafe { libc::getpgrp() } {
            unsafe {
                libc::killpg(pgid, signal);
            }
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::io::BufRead;
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};

    fn alive(pid: libc::pid_t) -> bool {
        // SAFETY: signal 0 only checks the pid exists.
        unsafe { libc::kill(pid, 0) == 0 }
    }

    /// A leader in its own group, with a child that outlives a plain kill of
    /// the leader, like an agent's subprocess. Returns (leader, child pid).
    fn spawn_group(script: &str) -> (std::process::Child, libc::pid_t) {
        let mut leader = Command::new("sh")
            .args(["-c", script])
            .process_group(0)
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut line = String::new();
        std::io::BufReader::new(leader.stdout.take().unwrap())
            .read_line(&mut line)
            .unwrap();
        let child: libc::pid_t = line.trim().parse().unwrap();
        assert!(alive(child));
        (leader, child)
    }

    fn wait_gone(pid: libc::pid_t) -> bool {
        // An orphan is reaped by init, asynchronously.
        let deadline = Instant::now() + Duration::from_secs(5);
        while alive(pid) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        !alive(pid)
    }

    #[test]
    fn stopping_the_group_takes_the_leaders_children_too() {
        // The child ignores SIGHUP: only the SIGKILL that follows stops it.
        let (mut leader, child) = spawn_group("(trap '' HUP; sleep 30) & echo $!; wait");
        let leader_pid = leader.id() as libc::pid_t;

        stop_groups(&[leader_pid], Duration::from_millis(500), || {
            let _ = leader.try_wait();
        });
        leader.wait().unwrap();
        assert!(wait_gone(child), "the leader's child must be killed too");
    }

    #[test]
    fn stopping_the_group_gives_children_the_grace_period_too() {
        // The leader exits at once on SIGHUP; its child needs 200 ms to
        // "save" before exiting, like an agent writing its session.
        let marker =
            std::env::temp_dir().join(format!("gitwand-term-grace-{}", std::process::id()));
        // The child prints its pid only once its trap is set.
        let script = format!(
            r#"sh -c 'trap "sleep 0.2; echo saved > {}; exit 0" HUP; echo $$; while :; do sleep 0.05; done' & trap 'exit 0' HUP; wait"#,
            marker.display()
        );
        let (mut leader, child) = spawn_group(&script);
        let leader_pid = leader.id() as libc::pid_t;

        stop_groups(&[leader_pid], Duration::from_millis(500), || {
            let _ = leader.try_wait();
        });
        let _ = leader.wait();
        assert!(wait_gone(child));
        assert_eq!(
            std::fs::read_to_string(&marker).unwrap_or_default(),
            "saved\n",
            "the child must get to finish before SIGKILL"
        );
        let _ = std::fs::remove_file(marker);
    }

    #[test]
    fn stopping_the_group_hangs_up_before_killing() {
        let marker = std::env::temp_dir().join(format!("gitwand-term-hup-{}", std::process::id()));
        let script = format!(
            "trap 'echo hup > {}; exit 0' HUP; sleep 30 & echo $!; wait",
            marker.display()
        );
        let (mut leader, child) = spawn_group(&script);
        let leader_pid = leader.id() as libc::pid_t;

        let mut status = None;
        stop_groups(&[leader_pid], Duration::from_millis(500), || {
            if status.is_none() {
                status = leader.try_wait().unwrap();
            }
        });
        let status = status.or_else(|| leader.wait().ok()).unwrap();
        assert!(status.success(), "the leader exits on its own on SIGHUP");
        assert_eq!(std::fs::read_to_string(&marker).unwrap(), "hup\n");
        assert!(wait_gone(child));
        let _ = std::fs::remove_file(marker);
    }
}

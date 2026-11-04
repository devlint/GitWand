//! Terminal PTY intégré : spawn de shells interactifs dans des PTY,
//! streaming d'output vers le frontend via `tauri::ipc::Channel`.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::Serialize;
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
    /// The session's working directory, canonical: what a worktree's
    /// processes are matched by.
    #[allow(dead_code)] // TASK4: used by worktree_stop_processes
    cwd: PathBuf,
    /// The leader's pid, which is also its session id on Unix.
    leader: Option<u32>,
    /// Windows: the Job Object the session's tree runs in.
    #[cfg(windows)]
    job: Option<job::Job>,
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

/// The only environment variables a caller may add to a session (spec §10.2).
/// Anything else is refused: an added variable can then never bring back a
/// secret `CLAUDE_AUTH_OVERRIDE_ENV` stripped.
pub(crate) const WORKTREE_ENV_ALLOWLIST: [&str; 5] = [
    "GITWAND_WORKTREE_NAME",
    "GITWAND_WORKTREE_PATH",
    "GITWAND_WORKTREE_BRANCH",
    "GITWAND_WORKTREE_BASE",
    "GITWAND_REPO_ROOT",
];

/// What a session runs.
#[allow(dead_code)] // `Command` is built by the worktree hook runner (v3.13 PR 3).
pub(crate) enum SpawnKind {
    /// An interactive shell: the override, or the user's default shell.
    Shell(Option<String>),
    /// A first-class agent CLI (`claude`, `codex`, …), resolved by name.
    Agent(String),
    /// A command line run by the user's shell (`$SHELL [-l] -c`, `cmd /C`).
    /// Rust-internal: no IPC command takes one, so that repository commands
    /// only run through the hook trust gate (`assert_hooks_trusted`).
    Command {
        command: String,
        shell: Option<String>,
    },
}

pub(crate) struct SpawnSpec {
    /// Already validated and canonical (`safe_repo_path`).
    pub cwd: PathBuf,
    pub kind: SpawnKind,
    /// Checked against `WORKTREE_ENV_ALLOWLIST`.
    pub env: HashMap<String, String>,
    pub cols: u16,
    pub rows: u16,
}

/// Sent once on `terminal_open`'s `on_exit` channel (a separate channel, so
/// `on_output` stays a plain stream of strings), after the last output
/// chunk. `code` is `None` when the session was closed by GitWand, or the
/// status could not be read.
#[derive(Serialize, Clone, Debug)]
pub struct TerminalExit {
    pub code: Option<i32>,
}

/// Opens a PTY session and starts streaming its output. `on_chunk` gets each
/// UTF-8 chunk and returns false once its consumer is gone; `on_exit` is
/// called exactly once, after the last chunk.
pub(crate) fn spawn_session(
    spec: SpawnSpec,
    mut on_chunk: Box<dyn FnMut(String) -> bool + Send>,
    on_exit: Box<dyn FnOnce(Option<i32>) + Send>,
) -> Result<u64, String> {
    if let Some(key) = spec
        .env
        .keys()
        .find(|k| !WORKTREE_ENV_ALLOWLIST.contains(&k.as_str()))
    {
        return Err(format!(
            "environment variable not allowed for a terminal session: {key}"
        ));
    }

    // First-class agent vs shell resolution. Each agent is resolved via its
    // dedicated binary resolver (same logic as detect_*_cli) rather than
    // relying on the PTY's PATH, which may not include user-local install
    // paths (e.g. ~/.opencode/bin, ~/.claude/local, ~/.local/bin).
    let mut cmd = match &spec.kind {
        SpawnKind::Agent(agent) => {
            let program = match agent.as_str() {
                "claude" => super::ai::resolve_claude_binary()
                    .ok_or_else(|| "Binaire `claude` introuvable. Installez-le avec `npm install -g @anthropic-ai/claude-code`.".to_string())?,
                "codex" => super::ai::resolve_codex_binary()
                    .ok_or_else(|| "Binaire `codex` introuvable. Installez-le avec `npm install -g @openai/codex`.".to_string())?,
                "opencode" => super::ai::resolve_opencode_binary()
                    .ok_or_else(|| "Binaire `opencode` introuvable. Installez-le avec `npm install -g opencode-ai` ou via `curl -fsSL https://opencode.ai/install | bash`.".to_string())?,
                "antigravity" => super::ai::resolve_antigravity_binary()
                    .ok_or_else(|| "Binaire `agy` introuvable. Installez-le avec `curl -fsSL https://antigravity.google/cli/install.sh | bash`.".to_string())?,
                // Unknown agent names keep the historical behavior: a shell.
                _ => return spawn_session(
                    SpawnSpec { kind: SpawnKind::Shell(None), ..spec },
                    on_chunk,
                    on_exit,
                ),
            };
            // An agent is never a login shell.
            CommandBuilder::new(&program)
        }
        SpawnKind::Shell(shell) => {
            let program = resolve_shell(shell);
            #[allow(unused_mut)]
            let mut cmd = CommandBuilder::new(&program);
            // Login shell sur Unix pour charger le profil utilisateur (PATH, aliases…).
            // Seulement pour les shells qui acceptent `-l` (cf. login_flag) — sinon
            // le PTY meurt avec `unknown option '-l'`.
            #[cfg(not(windows))]
            if let Some(flag) = login_flag(&program) {
                cmd.arg(flag);
            }
            cmd
        }
        SpawnKind::Command { command, shell } => {
            #[cfg(windows)]
            {
                let _ = shell;
                let mut cmd = CommandBuilder::new("cmd");
                cmd.args(["/C", command.as_str()]);
                cmd
            }
            #[cfg(not(windows))]
            {
                let program = resolve_shell(shell);
                let mut cmd = CommandBuilder::new(&program);
                if let Some(flag) = login_flag(&program) {
                    cmd.arg(flag);
                }
                cmd.args(["-c", command.as_str()]);
                cmd
            }
        }
    };

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: spec.rows,
            cols: spec.cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty failed: {e}"))?;

    cmd.cwd(&spec.cwd);
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
    // Allow-listed above; applied after the stripping.
    for (k, v) in &spec.env {
        cmd.env(k, v);
    }

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn shell failed: {e}"))?;
    // Drop our copy of the slave, so the reader sees EOF once the child's
    // side is closed.
    drop(pair.slave);

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
    let leader = child.process_id();
    #[cfg(windows)]
    let job = leader.and_then(|pid| match job::Job::assign(pid) {
        Ok(j) => Some(j),
        Err(e) => {
            eprintln!("[terminal] Job Object not set up, closing kills the leader only: {e}");
            None
        }
    });
    let master_arc: Arc<Mutex<Box<dyn portable_pty::MasterPty + Send>>> =
        Arc::new(Mutex::new(pair.master));
    let writer_arc: Arc<Mutex<Box<dyn Write + Send>>> = Arc::new(Mutex::new(writer));

    lock_sessions().insert(
        id,
        PtyHandle {
            master: master_arc,
            writer: writer_arc,
            child,
            cwd: spec.cwd,
            leader,
            #[cfg(windows)]
            job,
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
                    if !chunk.is_empty() && !on_chunk(chunk) {
                        break; // frontend parti
                    }
                }
                Err(_) => break, // EIO on Linux once the slave side is closed
            }
        }
        // Flush any remaining carry bytes on EOF.
        if !carry.is_empty() {
            let _ = on_chunk(String::from_utf8_lossy(&carry).to_string());
        }
        // Nettoyage : retirer la session du registre quand le PTY se ferme,
        // puis lire le code de sortie du leader. Si `terminal_close` l'a déjà
        // retirée, GitWand l'a arrêtée : pas de code.
        let handle = lock_sessions().remove(&id);
        let code = handle.and_then(|mut h| exit_code(&mut *h.child));
        on_exit(code);
    });

    Ok(id)
}

/// The leader's exit code, waiting at most 2 s: the PTY reached EOF, so the
/// leader has exited or is about to, unless a process it left behind closed
/// the terminal last.
fn exit_code(child: &mut (dyn portable_pty::Child + Send + Sync)) -> Option<i32> {
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Some(status.exit_code() as i32),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
            _ => return None,
        }
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
    on_exit: Channel<TerminalExit>,
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
    let kind = match agent.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(a) => SpawnKind::Agent(a.to_string()),
        None => SpawnKind::Shell(shell),
    };
    spawn_session(
        SpawnSpec {
            cwd: canon,
            kind,
            env: HashMap::new(),
            cols,
            rows,
        },
        Box::new(move |chunk| on_output.send(chunk).is_ok()),
        Box::new(move |code| {
            let _ = on_exit.send(TerminalExit { code });
        }),
    )
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

/// The open sessions whose working directory is `root` or inside it
/// (component-wise).
#[allow(dead_code)] // TASK4: used by worktree_stop_processes
pub(crate) fn sessions_under(root: &std::path::Path) -> Vec<u64> {
    let root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let mut ids: Vec<u64> = lock_sessions()
        .iter()
        .filter(|(_, h)| h.cwd.starts_with(&root))
        .map(|(id, _)| *id)
        .collect();
    ids.sort_unstable();
    ids
}

/// Closes these sessions like `terminal_close`, and returns their leaders'
/// pids (their session ids on Unix).
#[allow(dead_code)] // TASK4: used by worktree_stop_processes
pub(crate) fn close_session_ids(ids: &[u64]) -> std::collections::HashSet<u32> {
    let handles: Vec<PtyHandle> = {
        let mut map = lock_sessions();
        ids.iter().filter_map(|id| map.remove(id)).collect()
    };
    let leaders = handles.iter().filter_map(|h| h.leader).collect();
    close_sessions(handles, true);
    leaders
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
/// leaders, bounded, for a process stuck in an uninterruptible syscall.
///
/// Unix: besides the groups, every process still in a leader's session is
/// signalled one by one, which reaches the shell's background jobs (their
/// own group) and an orphaned foreground job; only a process that called
/// `setsid` itself escapes, and the worktree sweep catches it by cwd.
/// Windows: the session's Job Object is terminated, which takes its whole
/// tree; without one (assignment failed), only the leader is killed.
fn close_sessions(mut handles: Vec<PtyHandle>, wait_leaders: bool) {
    if handles.is_empty() {
        return;
    }
    #[cfg(unix)]
    {
        let groups: Vec<libc::pid_t> = handles.iter().flat_map(session_groups).collect();
        let members = session_members(&handles);
        let grace = Duration::from_millis(if wait_leaders { 500 } else { 100 });
        stop_groups(&groups, &members, grace, || {
            // Reap the leaders, so a zombie doesn't keep its group alive.
            for h in &mut handles {
                let _ = h.child.try_wait();
            }
        });
    }
    #[cfg(windows)]
    for h in &mut handles {
        if let Some(job) = &h.job {
            job.terminate();
        }
        let _ = h.child.kill();
    }
    #[cfg(not(any(unix, windows)))]
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

/// The processes still in the sessions' sessions, leaders excluded (their
/// group already covers them). Never pid ≤ 1, GitWand itself or a member of
/// GitWand's group.
#[cfg(unix)]
fn session_members(handles: &[PtyHandle]) -> Vec<libc::pid_t> {
    let leaders: std::collections::HashSet<u32> = handles.iter().filter_map(|h| h.leader).collect();
    if leaders.is_empty() {
        return Vec::new();
    }
    let own = std::process::id();
    // SAFETY: plain syscall.
    let own_group = unsafe { libc::getpgrp() };
    crate::process_tree::list_processes()
        .into_iter()
        .map(|p| p.pid)
        .filter(|&pid| pid > 1 && pid != own && !leaders.contains(&pid))
        .filter(|&pid| {
            crate::process_tree::session_of(pid).is_some_and(|sid| leaders.contains(&sid))
        })
        .filter_map(|pid| libc::pid_t::try_from(pid).ok())
        // SAFETY: plain syscall.
        .filter(|&pid| unsafe { libc::getpgid(pid) } != own_group)
        .collect()
}

/// SIGHUP `groups` and `pids`, give them up to `grace` to be gone, then
/// SIGKILL what is left. Every group member counts, not only the leaders: an
/// agent still saving its session after its shell exited gets the whole
/// grace period. `reap` runs before each check, for the caller to reap its
/// own children. An emptied group, or a pid gone, is not signalled again:
/// its id is free for reuse.
#[cfg(unix)]
fn stop_groups(
    groups: &[libc::pid_t],
    pids: &[libc::pid_t],
    grace: Duration,
    mut reap: impl FnMut(),
) {
    signal_groups(groups, libc::SIGHUP);
    signal_pids(pids, libc::SIGHUP);
    let deadline = Instant::now() + grace;
    let mut alive: Vec<libc::pid_t> = groups.to_vec();
    let mut alive_pids: Vec<libc::pid_t> = pids.to_vec();
    loop {
        reap();
        alive.retain(|&g| group_alive(g));
        alive_pids.retain(|&p| pid_alive(p));
        if (alive.is_empty() && alive_pids.is_empty()) || Instant::now() >= deadline {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    signal_groups(&alive, libc::SIGKILL);
    signal_pids(&alive_pids, libc::SIGKILL);
}

#[cfg(unix)]
fn pid_alive(pid: libc::pid_t) -> bool {
    // SAFETY: signal 0 only checks the pid exists. EPERM is a live process.
    let probed = unsafe { libc::kill(pid, 0) };
    probed == 0 || std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
}

#[cfg(unix)]
fn signal_pids(pids: &[libc::pid_t], signal: libc::c_int) {
    let own = std::process::id() as libc::pid_t;
    for &pid in pids {
        // Never 0/-1 (groups, everyone), init or GitWand itself.
        if pid > 1 && pid != own {
            // SAFETY: plain syscall, no memory is shared with it.
            unsafe {
                libc::kill(pid, signal);
            }
        }
    }
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

/// A Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`: every process the
/// session's leader starts stays in it, and terminating or closing it kills
/// the whole tree, grandchildren included (spec §8).
#[cfg(windows)]
mod job {
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
    };

    pub(super) struct Job(HANDLE);

    // SAFETY: a job handle is a kernel object reference, usable from any thread.
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    impl Job {
        /// Creates a kill-on-close job and puts `pid` in it.
        pub(super) fn assign(pid: u32) -> Result<Job, String> {
            // SAFETY: plain Win32 calls; every handle opened here is closed
            // on each path (the job's by `Drop`).
            unsafe {
                let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if handle.is_null() {
                    return Err(format!(
                        "CreateJobObjectW: {}",
                        std::io::Error::last_os_error()
                    ));
                }
                let job = Job(handle);
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                if SetInformationJobObject(
                    job.0,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const core::ffi::c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                ) == 0
                {
                    return Err(format!(
                        "SetInformationJobObject: {}",
                        std::io::Error::last_os_error()
                    ));
                }
                let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
                if process.is_null() {
                    return Err(format!("OpenProcess: {}", std::io::Error::last_os_error()));
                }
                let assigned = AssignProcessToJobObject(job.0, process);
                let err = std::io::Error::last_os_error();
                CloseHandle(process);
                if assigned == 0 {
                    return Err(format!("AssignProcessToJobObject: {err}"));
                }
                Ok(job)
            }
        }

        pub(super) fn terminate(&self) {
            // SAFETY: the handle is open until `Drop`.
            unsafe {
                TerminateJobObject(self.0, 1);
            }
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            // SAFETY: closed once, here. Kill-on-close ends what is left.
            unsafe {
                CloseHandle(self.0);
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

    pub(crate) fn scratch_dir(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("gitwand-term-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d.canonicalize().unwrap()
    }

    fn spec(cwd: &std::path::Path, kind: SpawnKind, env: HashMap<String, String>) -> SpawnSpec {
        SpawnSpec {
            cwd: cwd.to_path_buf(),
            kind,
            env,
            cols: 80,
            rows: 24,
        }
    }

    fn sh(command: &str) -> SpawnKind {
        SpawnKind::Command {
            command: command.into(),
            shell: Some("/bin/sh".into()),
        }
    }

    /// Runs a session to its end: (all output, exit code).
    fn run(name: &str, kind: SpawnKind, env: HashMap<String, String>) -> (String, Option<i32>) {
        let dir = scratch_dir(name);
        let out = Arc::new(Mutex::new(String::new()));
        let sink = Arc::clone(&out);
        let (tx, rx) = std::sync::mpsc::channel();
        spawn_session(
            spec(&dir, kind, env),
            Box::new(move |c| {
                sink.lock().unwrap().push_str(&c);
                true
            }),
            Box::new(move |code| {
                let _ = tx.send(code);
            }),
        )
        .unwrap();
        let code = rx.recv_timeout(Duration::from_secs(10)).expect("no exit");
        let out = out.lock().unwrap().clone();
        (out, code)
    }

    #[test]
    fn command_exit_code_arrives_after_output() {
        let (out, code) = run("exit3", sh("printf hello; exit 3"), HashMap::new());
        assert!(out.contains("hello"), "output: {out:?}");
        assert_eq!(code, Some(3));
        let (_, code) = run("exit7", sh("exit 7"), HashMap::new());
        assert_eq!(code, Some(7));
    }

    #[test]
    fn command_sees_allowlisted_env() {
        let env = HashMap::from([("GITWAND_WORKTREE_NAME".to_string(), "fix login".to_string())]);
        let (out, code) = run("env", sh("printf %s \"$GITWAND_WORKTREE_NAME\""), env);
        assert!(out.contains("fix login"), "output: {out:?}");
        assert_eq!(code, Some(0));
    }

    #[test]
    fn env_outside_allowlist_is_refused() {
        let dir = scratch_dir("env-refused");
        let env = HashMap::from([("ANTHROPIC_API_KEY".to_string(), "x".to_string())]);
        let err = spawn_session(
            spec(&dir, sh("true"), env),
            Box::new(|_| true),
            Box::new(|_| {}),
        )
        .unwrap_err();
        assert!(err.contains("ANTHROPIC_API_KEY"), "{err}");
    }

    #[test]
    fn session_records_canonical_cwd_and_leader() {
        let dir = scratch_dir("leader");
        let id = spawn_session(
            spec(&dir, sh("sleep 5"), HashMap::new()),
            Box::new(|_| true),
            Box::new(|_| {}),
        )
        .unwrap();
        let handle = lock_sessions().remove(&id).expect("session registered");
        assert_eq!(handle.cwd, dir);
        assert!(handle.leader.is_some());
        close_sessions(vec![handle], true);
    }

    #[test]
    fn close_kills_background_job_in_own_group() {
        let dir = scratch_dir("bgjob");
        let (tx, rx) = std::sync::mpsc::channel::<String>();
        let id = spawn_session(
            spec(
                &dir,
                sh("set -m; sleep 300 & echo BG:$!; wait"),
                HashMap::new(),
            ),
            Box::new(move |c| tx.send(c).is_ok()),
            Box::new(|_| {}),
        )
        .unwrap();
        let mut out = String::new();
        let deadline = Instant::now() + Duration::from_secs(10);
        let bg: libc::pid_t = loop {
            if let Some(rest) = out.split("BG:").nth(1) {
                let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
                if rest.len() > digits.len() && !digits.is_empty() {
                    break digits.parse().unwrap();
                }
            }
            assert!(Instant::now() < deadline, "no BG pid in {out:?}");
            if let Ok(c) = rx.recv_timeout(Duration::from_millis(100)) {
                out.push_str(&c);
            }
        };
        let leader = lock_sessions().get(&id).unwrap().leader.unwrap() as libc::pid_t;
        assert!(alive(bg));
        // SAFETY: plain syscall.
        assert_ne!(
            unsafe { libc::getpgid(bg) },
            leader,
            "job control must move it"
        );

        let leaders = close_session_ids(&[id]);
        assert!(leaders.contains(&(leader as u32)));
        assert!(wait_gone(bg), "the background job must be stopped too");
    }

    #[test]
    fn sessions_under_matches_by_cwd() {
        let a = scratch_dir("under-a");
        let ab = scratch_dir("under-a-b");
        let open = |d: &std::path::Path| {
            spawn_session(
                spec(d, sh("sleep 30"), HashMap::new()),
                Box::new(|_| true),
                Box::new(|_| {}),
            )
            .unwrap()
        };
        let (ia, iab) = (open(&a), open(&ab));
        assert_eq!(sessions_under(&a), vec![ia]);
        assert_eq!(sessions_under(&ab), vec![iab]);
        close_session_ids(&[ia, iab]);
        assert!(sessions_under(&a).is_empty());
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

        stop_groups(&[leader_pid], &[], Duration::from_millis(500), || {
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

        stop_groups(&[leader_pid], &[], Duration::from_millis(500), || {
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
        stop_groups(&[leader_pid], &[], Duration::from_millis(500), || {
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

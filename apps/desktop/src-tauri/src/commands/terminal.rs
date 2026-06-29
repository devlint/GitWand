//! Terminal PTY intégré : spawn de shells interactifs dans des PTY,
//! streaming d'output vers le frontend via `tauri::ipc::Channel`.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

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
/// We reject (fall back to default) any path that contains a separator
/// but is not absolute, to prevent directory-traversal attacks via settings.
fn resolve_shell(shell: &Option<String>) -> String {
    fn default_shell() -> String {
        #[cfg(windows)]
        { std::env::var("ComSpec").unwrap_or_else(|_| "powershell.exe".to_string()) }
        #[cfg(not(windows))]
        { std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string()) }
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
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
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
        Err(e) => { let _ = child.kill(); return Err(format!("clone reader failed: {e}")); }
    };
    let writer = match pair.master.take_writer() {
        Ok(w) => w,
        Err(e) => { let _ = child.kill(); return Err(format!("take writer failed: {e}")); }
    };

    let id = NEXT_ID.fetch_add(1, Ordering::SeqCst);
    let master_arc: Arc<Mutex<Box<dyn portable_pty::MasterPty + Send>>> =
        Arc::new(Mutex::new(pair.master));
    let writer_arc: Arc<Mutex<Box<dyn Write + Send>>> = Arc::new(Mutex::new(writer));

    lock_sessions().insert(
        id,
        PtyHandle { master: master_arc, writer: writer_arc, child },
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
        map.get(&id).map(|h| Arc::clone(&h.master)).ok_or("session not found")?
    };
    let result = master_arc
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| format!("resize failed: {e}"));
    result
}

#[tauri::command]
pub(crate) fn terminal_close(id: u64) -> Result<(), String> {
    if let Some(mut h) = lock_sessions().remove(&id) {
        let _ = h.child.kill();
    }
    Ok(())
}

/// Tue toutes les sessions (appelé au quit de l'app).
pub(crate) fn terminal_close_all() {
    let mut map = lock_sessions();
    for (_, mut h) in map.drain() {
        let _ = h.child.kill();
    }
}


//! Terminal PTY intégré : spawn de shells interactifs dans des PTY,
//! streaming d'output vers le frontend via `tauri::ipc::Channel`.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use tauri::ipc::Channel;

/// Une session PTY vivante. Le thread lecteur est détaché ; il sort sur EOF.
struct PtyHandle {
    master: Box<dyn portable_pty::MasterPty + Send>,
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

#[tauri::command]
pub(crate) fn terminal_open(
    cwd: String,
    shell: Option<String>,
    cols: u16,
    rows: u16,
    on_output: Channel<String>,
) -> Result<u64, String> {
    if cwd.trim().is_empty() {
        return Err("cwd must not be empty".to_string());
    }
    // Fix 1 — CWD validation (safe_repo_path applicability note).
    //
    // `safe_repo_path(cwd, rel_path)` validates that `rel_path` resolves
    // inside `cwd`; it requires a second argument and is designed for
    // file-within-repo access, not for validating the working directory
    // itself. It cannot be called here with just `cwd`.
    //
    // Instead we apply the same defence-in-depth steps manually:
    //   (a) reject relative paths — only absolute cwd accepted
    //   (b) canonicalize to resolve symlinks and eliminate `..` components
    //   (c) check is_dir() — must be an existing directory
    //
    // This mirrors AGENTS.md's intent: every user-supplied filesystem path
    // must be resolved canonically before use, with no hand-crafted join
    // that could be escaped via `..` traversal.
    let cwd_path = std::path::Path::new(cwd.trim());
    if !cwd_path.is_absolute() {
        return Err(format!("cwd must be absolute (got: {})", cwd));
    }
    let canon = cwd_path
        .canonicalize()
        .map_err(|e| format!("invalid cwd: {e}"))?;
    if !canon.is_dir() {
        return Err("cwd is not a directory".to_string());
    }

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| format!("openpty failed: {e}"))?;

    let shell_path = resolve_shell(&shell);
    let mut cmd = CommandBuilder::new(&shell_path);
    // Login shell sur Unix pour charger le profil utilisateur (PATH, aliases…).
    #[cfg(not(windows))]
    cmd.arg("-l");
    cmd.cwd(&canon);
    // On NE propage PAS de tokens GitWand : le shell charge ses propres creds.
    // Enrichissement PATH (Homebrew / npm global) repris de hidden_cmd.
    if let Some(extra) = enriched_path() {
        cmd.env("PATH", extra);
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn shell failed: {e}"))?;

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("clone reader failed: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("take writer failed: {e}"))?;

    let id = NEXT_ID.fetch_add(1, Ordering::SeqCst);
    let writer_arc: Arc<Mutex<Box<dyn Write + Send>>> = Arc::new(Mutex::new(writer));

    lock_sessions().insert(
        id,
        PtyHandle { master: pair.master, writer: writer_arc, child },
    );

    // Thread lecteur : pousse les chunks vers le frontend.
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break, // EOF : shell terminé
                Ok(n) => {
                    let chunk = String::from_utf8_lossy(&buf[..n]).to_string();
                    if on_output.send(chunk).is_err() {
                        break; // frontend parti
                    }
                }
                Err(_) => break,
            }
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
    let map = lock_sessions();
    let h = map.get(&id).ok_or("session not found")?;
    h.master
        .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| format!("resize failed: {e}"))
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

/// PATH enrichi (Homebrew / chemins usuels) — mirror minimal de hidden_cmd.
/// Retourne None si rien à ajouter.
fn enriched_path() -> Option<String> {
    let current = std::env::var("PATH").unwrap_or_default();
    #[cfg(target_os = "macos")]
    {
        let extras = ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin"];
        let mut added = false;
        let mut path = current.clone();
        for e in extras {
            if !current.split(':').any(|p| p == e) {
                path = format!("{e}:{path}");
                added = true;
            }
        }
        if added {
            return Some(path);
        }
        return None;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = current;
        None
    }
}

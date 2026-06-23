//! Terminal PTY intégré : spawn de shells interactifs dans des PTY,
//! streaming d'output vers le frontend via `tauri::ipc::Channel`.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use tauri::ipc::Channel;

/// Une session PTY vivante. Le thread lecteur est détaché ; il sort sur EOF.
struct PtyHandle {
    master: Box<dyn portable_pty::MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
}

fn sessions() -> &'static Mutex<HashMap<u64, PtyHandle>> {
    static S: OnceLock<Mutex<HashMap<u64, PtyHandle>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(HashMap::new()))
}

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

/// Résout le shell à lancer : override explicite, sinon $SHELL (Unix) /
/// %ComSpec% ou powershell (Windows).
fn resolve_shell(shell: &Option<String>) -> String {
    if let Some(s) = shell {
        if !s.trim().is_empty() {
            return s.clone();
        }
    }
    #[cfg(windows)]
    {
        std::env::var("ComSpec").unwrap_or_else(|_| "powershell.exe".to_string())
    }
    #[cfg(not(windows))]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
    }
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
    // Validation du cwd : doit être un dossier existant et résolu (anti-traversal).
    let canon = std::fs::canonicalize(&cwd).map_err(|e| format!("invalid cwd: {e}"))?;
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

    sessions().lock().unwrap().insert(
        id,
        PtyHandle { master: pair.master, writer, child },
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
        sessions().lock().unwrap().remove(&id);
    });

    Ok(id)
}

#[tauri::command]
pub(crate) fn terminal_write(id: u64, data: String) -> Result<(), String> {
    let mut map = sessions().lock().unwrap();
    let h = map.get_mut(&id).ok_or("session not found")?;
    h.writer
        .write_all(data.as_bytes())
        .map_err(|e| format!("write failed: {e}"))?;
    h.writer.flush().map_err(|e| format!("flush failed: {e}"))
}

#[tauri::command]
pub(crate) fn terminal_resize(id: u64, cols: u16, rows: u16) -> Result<(), String> {
    let map = sessions().lock().unwrap();
    let h = map.get(&id).ok_or("session not found")?;
    h.master
        .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| format!("resize failed: {e}"))
}

#[tauri::command]
pub(crate) fn terminal_close(id: u64) -> Result<(), String> {
    if let Some(mut h) = sessions().lock().unwrap().remove(&id) {
        let _ = h.child.kill();
    }
    Ok(())
}

/// Tue toutes les sessions (appelé au quit de l'app).
pub(crate) fn terminal_close_all() {
    let mut map = sessions().lock().unwrap();
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
        let mut path = current.clone();
        for e in extras {
            if !current.split(':').any(|p| p == e) {
                path = format!("{e}:{path}");
            }
        }
        return Some(path);
    }
    #[allow(unreachable_code)]
    {
        let _ = current;
        None
    }
}

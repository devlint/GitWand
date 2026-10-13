//! Linux software-rendering fallback.
//!
//! GitWand renders with the GPU. On some setups (VMs, older Mesa, some
//! native-Wayland sessions — #135, #139) WebKitGTK cannot get an EGL display
//! and aborts the whole process before any window is shown:
//! `Could not create default EGL display: EGL_BAD_PARAMETER. Aborting...`.
//! A `.desktop` launch shows nothing, so the user just sees "app won't open".
//!
//! Instead of forcing software rendering on everyone, a launch sentinel
//! detects that failure: it is written before the webview is created and
//! removed once the page has loaded. A sentinel still present at the next
//! start means the previous launch died during startup, so this launch — and
//! every later one, until the user turns it off in Settings — applies the
//! software env. The user can also turn it on by hand. Both are marker files
//! next to `install_id` (`<data_local_dir>/gitwand/`), because they must be
//! read before the webview, and so localStorage, exists.
//!
//! DEPRECATION: this is a compatibility shim. Recent WebKitGTK (2.54 tested)
//! no longer aborts without EGL — it falls back on its own. It is not tied to
//! Ubuntu 22.04: #135 was reported on Ubuntu 26.04 and #139 on Mint 22, so
//! dropping 22.04 as a build host does not retire it. Remove this module, its
//! commands and its Settings row once the EGL abort is no longer reported.

use std::path::{Path, PathBuf};

/// Env applied in software-rendering mode. Each one is set only when the user
/// has not set it, so an explicit value always wins.
#[cfg(target_os = "linux")]
const SOFTWARE_ENV: [(&str, &str); 3] = [
    // Stop WebKitGTK from compositing through GL.
    ("WEBKIT_DISABLE_COMPOSITING_MODE", "1"),
    // Use Mesa's software rasterizer once an EGL context exists.
    ("LIBGL_ALWAYS_SOFTWARE", "1"),
    // Skip native-Wayland EGL platform display negotiation, where #135 failed.
    ("GDK_BACKEND", "x11"),
];

/// Marker content when the sentinel turned the fallback on, as opposed to the
/// user (empty file).
const AUTO_MARKER: &[u8] = b"auto";

fn state_dir() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("gitwand")
}

// Dev builds get their own files: a `tauri dev` killed mid-startup must not
// switch the installed app to software rendering.
#[cfg(debug_assertions)]
const SUFFIX: &str = "-dev";
#[cfg(not(debug_assertions))]
const SUFFIX: &str = "";

fn software_marker(dir: &Path) -> PathBuf {
    dir.join(format!("software-rendering{SUFFIX}"))
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn launch_sentinel(dir: &Path) -> PathBuf {
    dir.join(format!("launch-pending{SUFFIX}"))
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
/// Reads the previous launch's sentinel, records a failed start, and arms the
/// sentinel for this launch. Returns whether software rendering is on.
///
/// The sentinel holds the PID of the launch that armed it. A sentinel whose
/// process is still a running GitWand belongs to an instance that is still
/// starting (two quick launches — there is no single-instance guard), not to a
/// failed one. Our own PID never counts: under a PID namespace every launch
/// can get the same one.
fn begin_launch(dir: &Path, pid: u32, is_alive: impl Fn(u32) -> bool) -> bool {
    let marker = software_marker(dir);
    let sentinel = launch_sentinel(dir);
    let _ = std::fs::create_dir_all(dir);
    if let Ok(content) = std::fs::read_to_string(&sentinel) {
        let still_starting = content
            .trim()
            .parse::<u32>()
            .is_ok_and(|other| other != pid && is_alive(other));
        if !still_starting && !marker.exists() {
            eprintln!(
                "[gitwand] previous launch did not finish starting; \
                 switching to software rendering (Settings → General to undo)"
            );
            let _ = std::fs::write(&marker, AUTO_MARKER);
        }
    }
    let _ = std::fs::write(&sentinel, pid.to_string());
    marker.exists()
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
/// Clears the sentinel — only if it is still this launch's: a concurrent
/// instance may have re-armed it since, and is not done starting yet.
fn finish_launch(dir: &Path, pid: u32) {
    let sentinel = launch_sentinel(dir);
    if std::fs::read_to_string(&sentinel).is_ok_and(|c| c.trim() == pid.to_string()) {
        let _ = std::fs::remove_file(sentinel);
    }
}

/// Whether `pid` is a running GitWand, not just any process: after a reboot
/// or PID wrap, an aborted launch's PID can belong to another program.
/// Compared by `comm` rather than `exe`, which differs between two AppImage
/// instances (each mounts its own copy).
#[cfg(target_os = "linux")]
fn gitwand_running(pid: u32) -> bool {
    let comm = |p: &str| std::fs::read_to_string(format!("/proc/{p}/comm")).ok();
    matches!((comm(&pid.to_string()), comm("self")), (Some(a), Some(b)) if a == b)
}

/// Called first thing in `run()`, before the webview exists.
#[cfg(target_os = "linux")]
pub(crate) fn prepare_launch() {
    if !begin_launch(&state_dir(), std::process::id(), gitwand_running) {
        return;
    }
    for (key, value) in SOFTWARE_ENV {
        if std::env::var_os(key).is_none() {
            std::env::set_var(key, value);
        }
    }
}

/// Called when the page has finished loading: the webview came up, so this
/// launch did not hit the EGL abort.
pub(crate) fn launch_succeeded() {
    #[cfg(target_os = "linux")]
    finish_launch(&state_dir(), std::process::id());
}

#[derive(serde::Serialize)]
pub(crate) struct SoftwareRenderingState {
    /// Only Linux has the fallback; the Settings row is hidden elsewhere.
    pub supported: bool,
    pub enabled: bool,
    /// Turned on by the launch sentinel rather than by the user.
    pub auto_enabled: bool,
}

#[tauri::command]
pub(crate) async fn software_rendering_get_state() -> Result<SoftwareRenderingState, String> {
    let marker = software_marker(&state_dir());
    let content = std::fs::read(&marker).ok();
    Ok(SoftwareRenderingState {
        supported: cfg!(target_os = "linux"),
        enabled: content.is_some(),
        auto_enabled: content.as_deref() == Some(AUTO_MARKER),
    })
}

/// Takes effect at the next launch: the env must be set before the webview.
#[tauri::command]
pub(crate) async fn software_rendering_set_enabled(enabled: bool) -> Result<(), String> {
    let dir = state_dir();
    let marker = software_marker(&dir);
    let err = |e: std::io::Error| format!("Failed to update rendering setting: {}", e);
    if enabled {
        std::fs::create_dir_all(&dir).map_err(err)?;
        std::fs::write(&marker, b"").map_err(err)
    } else {
        match std::fs::remove_file(&marker) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(err(e)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("gitwand-render-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    const ME: u32 = 1000;
    const OTHER: u32 = 2000;

    fn dead(_: u32) -> bool {
        false
    }

    #[test]
    fn clean_launches_stay_on_gpu() {
        let dir = temp_dir("clean");
        assert!(!begin_launch(&dir, ME, dead));
        finish_launch(&dir, ME);
        assert!(!begin_launch(&dir, ME, dead));
        assert!(!software_marker(&dir).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn failed_launch_switches_next_one_to_software() {
        let dir = temp_dir("failed");
        assert!(!begin_launch(&dir, OTHER, dead));
        // No finish_launch: the process aborted during startup.
        assert!(begin_launch(&dir, ME, dead));
        assert_eq!(std::fs::read(software_marker(&dir)).unwrap(), AUTO_MARKER);
        // Sticks after a successful software launch.
        finish_launch(&dir, ME);
        assert!(begin_launch(&dir, ME, dead));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn concurrent_launch_is_not_a_failure() {
        let dir = temp_dir("concurrent");
        // OTHER is still starting when ME launches (double-click).
        assert!(!begin_launch(&dir, OTHER, dead));
        assert!(!begin_launch(&dir, ME, |pid| pid == OTHER));
        assert!(!software_marker(&dir).exists());
        // OTHER finishing must not clear ME's sentinel, which ME then clears.
        finish_launch(&dir, OTHER);
        assert!(launch_sentinel(&dir).exists());
        finish_launch(&dir, ME);
        assert!(!launch_sentinel(&dir).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn own_pid_in_sentinel_counts_as_failed() {
        // PID namespaces: the aborted launch had the same PID as this one.
        let dir = temp_dir("own-pid");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(launch_sentinel(&dir), ME.to_string()).unwrap();
        assert!(begin_launch(&dir, ME, |_| true));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn legacy_empty_sentinel_counts_as_failed() {
        let dir = temp_dir("legacy");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(launch_sentinel(&dir), b"").unwrap();
        assert!(begin_launch(&dir, ME, |_| true));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn user_choice_is_not_relabelled_auto() {
        let dir = temp_dir("user");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(software_marker(&dir), b"").unwrap();
        std::fs::write(launch_sentinel(&dir), OTHER.to_string()).unwrap();
        assert!(begin_launch(&dir, ME, dead));
        assert_eq!(std::fs::read(software_marker(&dir)).unwrap(), b"");
        let _ = std::fs::remove_dir_all(&dir);
    }
}

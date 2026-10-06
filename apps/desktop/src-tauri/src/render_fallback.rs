//! Linux WebKitGTK rendering mode: hardware by default, software as a fallback.
//!
//! Some Linux setups (VMs, older Mesa, missing GPU passthrough, native-Wayland
//! EGL negotiation failures) abort the whole process with `Could not create
//! default EGL display: EGL_BAD_PARAMETER` before any window shows (#135,
//! #139). Forcing software rendering avoids that — but forcing it on *every*
//! Linux machine made the whole UI CPU-rasterized (llvmpipe, no compositing,
//! XWayland), which is what made the integrated terminal crawl on capable GPUs.
//!
//! So the software path is now a fallback, chosen once and remembered:
//!   - a `launch-pending` marker is written before the webview is created and
//!     removed when the first page finishes loading ([`mark_launch_ok`]);
//!   - if the marker is still there at the next start, that launch died before
//!     showing anything — switch to software rendering and persist the choice
//!     in a `software-render` flag file;
//!   - `GITWAND_SOFTWARE_RENDER=1|0` forces the mode either way and wins over
//!     the remembered choice (the escape hatch when a launch was merely
//!     interrupted, e.g. Ctrl+C during `pnpm dev`).
//!
//! Must run before `tauri::Builder` creates the webview: WebKitGTK and Mesa
//! read these variables at that point.

use std::path::PathBuf;

const OVERRIDE_ENV: &str = "GITWAND_SOFTWARE_RENDER";
const PENDING_FILE: &str = "launch-pending";
const STICKY_FILE: &str = "software-render";

/// Why software rendering was (or was not) chosen.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Mode {
    Hardware,
    /// Forced on by `GITWAND_SOFTWARE_RENDER`.
    SoftwareForced,
    /// Remembered from an earlier failed launch.
    SoftwareRemembered,
    /// The previous launch never finished loading its page.
    SoftwareAfterCrash,
}

impl Mode {
    fn is_software(&self) -> bool {
        !matches!(self, Mode::Hardware)
    }
}

/// Pure decision: `env_override` is the raw `GITWAND_SOFTWARE_RENDER` value.
pub(crate) fn decide(env_override: Option<&str>, remembered: bool, previous_crashed: bool) -> Mode {
    match env_override.map(|v| v.trim().to_ascii_lowercase()) {
        Some(v) if matches!(v.as_str(), "1" | "true" | "yes" | "on") => return Mode::SoftwareForced,
        Some(v) if matches!(v.as_str(), "0" | "false" | "no" | "off") => return Mode::Hardware,
        _ => {}
    }
    if remembered {
        Mode::SoftwareRemembered
    } else if previous_crashed {
        Mode::SoftwareAfterCrash
    } else {
        Mode::Hardware
    }
}

fn state_dir() -> Option<PathBuf> {
    dirs::state_dir()
        .or_else(dirs::data_local_dir)
        .map(|d| d.join("com.gitwand.desktop"))
}

fn set_if_unset(key: &str, value: &str) {
    // Never override a value the user or environment already set deliberately.
    if std::env::var_os(key).is_none() {
        std::env::set_var(key, value);
    }
}

/// Pick the rendering mode and export the matching WebKitGTK / Mesa / GDK
/// variables. Call once, before the Tauri builder.
pub(crate) fn apply() {
    // DMA-BUF sharing is the usual cause of blank/white windows on NVIDIA and
    // some Wayland compositors. Disabling it keeps GPU rendering, so it costs
    // little — keep it in both modes.
    set_if_unset("WEBKIT_DISABLE_DMABUF_RENDERER", "1");

    let dir = state_dir();
    let pending = dir.as_ref().map(|d| d.join(PENDING_FILE));
    let sticky = dir.as_ref().map(|d| d.join(STICKY_FILE));
    let previous_crashed = pending.as_ref().is_some_and(|p| p.exists());
    let remembered = sticky.as_ref().is_some_and(|p| p.exists());

    let mode = decide(
        std::env::var(OVERRIDE_ENV).ok().as_deref(),
        remembered,
        previous_crashed,
    );

    if mode == Mode::SoftwareAfterCrash {
        if let Some(sticky) = &sticky {
            let _ = std::fs::write(sticky, b"");
        }
    }

    if mode.is_software() {
        set_if_unset("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
        // The compositing switch only steers WebKitGTK; EGL display acquisition
        // can still fail earlier — Mesa's software rasterizer covers that.
        set_if_unset("LIBGL_ALWAYS_SOFTWARE", "1");
        // Native-Wayland EGL negotiation failures (#135 follow-up) — XWayland
        // sidesteps them, at the cost of fractional scaling and input latency.
        set_if_unset("GDK_BACKEND", "x11");
        let reason = match mode {
            Mode::SoftwareForced => format!("{OVERRIDE_ENV} is set"),
            _ => "a previous launch failed to start".to_string(),
        };
        let retry = sticky
            .as_ref()
            .map(|p| format!("delete {} or set {OVERRIDE_ENV}=0", p.display()))
            .unwrap_or_else(|| format!("set {OVERRIDE_ENV}=0"));
        eprintln!("GitWand: software rendering enabled ({reason}). To retry GPU rendering, {retry}.");
    }

    if let (Some(dir), Some(pending)) = (&dir, &pending) {
        let _ = std::fs::create_dir_all(dir);
        let _ = std::fs::write(pending, b"");
    }
}

/// The first page finished loading: the webview came up, so this launch did
/// not hit the EGL abort. Clear the pending marker.
pub(crate) fn mark_launch_ok() {
    if let Some(pending) = state_dir().map(|d| d.join(PENDING_FILE)) {
        let _ = std::fs::remove_file(pending);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hardware_by_default() {
        assert_eq!(decide(None, false, false), Mode::Hardware);
    }

    #[test]
    fn software_after_a_launch_that_never_loaded() {
        assert_eq!(decide(None, false, true), Mode::SoftwareAfterCrash);
    }

    #[test]
    fn remembered_choice_sticks() {
        assert_eq!(decide(None, true, false), Mode::SoftwareRemembered);
    }

    #[test]
    fn env_override_wins_both_ways() {
        assert_eq!(decide(Some("1"), false, false), Mode::SoftwareForced);
        assert_eq!(decide(Some(" TRUE "), false, false), Mode::SoftwareForced);
        assert_eq!(decide(Some("0"), true, true), Mode::Hardware);
        assert_eq!(decide(Some("off"), true, false), Mode::Hardware);
    }

    #[test]
    fn unknown_override_value_is_ignored() {
        assert_eq!(decide(Some("maybe"), false, true), Mode::SoftwareAfterCrash);
        assert_eq!(decide(Some(""), false, false), Mode::Hardware);
    }
}

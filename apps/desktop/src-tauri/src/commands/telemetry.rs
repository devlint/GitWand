//! Launch-telemetry opt-out.
//!
//! The launch event fires from the Rust `setup` hook, before the webview has
//! loaded any setting, so the preference cannot live in localStorage: it is a
//! marker file next to `install_id` (`<data_local_dir>/gitwand/`). Its
//! presence means "do not send". The `DO_NOT_TRACK` convention and
//! `GITWAND_NO_TELEMETRY` are honoured too, for managed / enterprise machines
//! that set policy through the environment rather than per-user settings.

use std::path::PathBuf;

fn opt_out_marker() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("gitwand")
        .join("telemetry-disabled")
}

/// Whether an env value reads as "set" (`1`, `true`, `yes`, any case).
fn env_flag_set(v: Option<String>) -> bool {
    matches!(
        v.as_deref()
            .map(|s| s.trim().to_ascii_lowercase())
            .as_deref(),
        Some("1" | "true" | "yes")
    )
}

/// Whether the environment opts this machine out, whatever the user setting.
fn env_opt_out() -> bool {
    env_flag_set(std::env::var("DO_NOT_TRACK").ok())
        || env_flag_set(std::env::var("GITWAND_NO_TELEMETRY").ok())
}

/// Whether the launch event may be sent. Only called by the `telemetry` build.
#[cfg_attr(not(feature = "telemetry"), allow(dead_code))]
pub(crate) fn telemetry_allowed() -> bool {
    !env_opt_out() && !opt_out_marker().exists()
}

#[derive(serde::Serialize)]
pub(crate) struct TelemetryState {
    /// The user setting.
    pub enabled: bool,
    /// True when the environment forces it off (the toggle is moot).
    pub forced_off_by_env: bool,
}

#[tauri::command]
pub(crate) async fn telemetry_get_state() -> Result<TelemetryState, String> {
    Ok(TelemetryState {
        enabled: !opt_out_marker().exists(),
        forced_off_by_env: env_opt_out(),
    })
}

#[tauri::command]
pub(crate) async fn telemetry_set_enabled(enabled: bool) -> Result<(), String> {
    let marker = opt_out_marker();
    if enabled {
        match std::fs::remove_file(&marker) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("Failed to update telemetry setting: {}", e)),
        }
    } else {
        if let Some(parent) = marker.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to update telemetry setting: {}", e))?;
        }
        std::fs::write(&marker, b"")
            .map_err(|e| format!("Failed to update telemetry setting: {}", e))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_flag_parsing() {
        assert!(env_flag_set(Some("1".into())));
        assert!(env_flag_set(Some(" TRUE ".into())));
        assert!(env_flag_set(Some("yes".into())));
        assert!(!env_flag_set(Some("0".into())));
        assert!(!env_flag_set(Some("".into())));
        assert!(!env_flag_set(None));
    }
}

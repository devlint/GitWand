//! MCP catalog Tauri commands (§6.3-6.4, fixed §6.7).
//!
//! Four commands:
//!   - `mcp_detect_configs`   — discover MCP config files on disk (Claude Desktop,
//!     Claude Code, Cursor, Windsurf) with full server_keys list.
//!   - `mcp_read_config`      — parse a config file and return its current `mcpServers`
//!     map as a JSON string.
//!   - `mcp_install_server`   — merge a server fragment into one or more config files.
//!   - `mcp_uninstall_server` — remove a server key from one or more config files.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpConfigFile {
    /// Human-readable label shown in the Install modal.
    pub label: String,
    /// Absolute path on disk.
    pub path: String,
    /// Whether the file currently exists.
    pub exists: bool,
    /// Keys currently present under `mcpServers` in this config (empty when
    /// the file doesn't exist or has no `mcpServers` key).
    pub server_keys: Vec<String>,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn home_dir() -> Option<PathBuf> {
    std::env::var("HOME")
        .ok()
        .map(PathBuf::from)
        .or_else(dirs_path)
}

fn dirs_path() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        std::env::var("USERPROFILE").ok().map(PathBuf::from)
    }
    #[cfg(not(target_os = "windows"))]
    {
        None
    }
}

/// Read a JSON file from disk, returning `Value::Null` if it does not exist.
fn read_json(path: &PathBuf) -> Result<Value, String> {
    if !path.exists() {
        return Ok(Value::Null);
    }
    let raw = std::fs::read_to_string(path)
        .map_err(|e| format!("Failed to read {}: {}", path.display(), e))?;
    serde_json::from_str(&raw).map_err(|e| format!("Failed to parse {}: {}", path.display(), e))
}

/// Return all keys under `mcpServers` in the given JSON value.
fn mcp_server_keys(value: &Value) -> Vec<String> {
    value
        .get("mcpServers")
        .and_then(|v| v.as_object())
        .map(|m| m.keys().cloned().collect())
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Known config locations
// ---------------------------------------------------------------------------

fn known_configs(home: &Path) -> Vec<(String, PathBuf)> {
    let mut list = vec![
        (
            "Claude Desktop".to_string(),
            // macOS; also works on Linux since the file won't exist there
            home.join("Library/Application Support/Claude/claude_desktop_config.json"),
        ),
        (
            "Claude Code (global)".to_string(),
            // Claude Code stores global settings (including mcpServers) in ~/.claude.json
            home.join(".claude.json"),
        ),
        ("Cursor (global)".to_string(), home.join(".cursor/mcp.json")),
        (
            "Windsurf (global)".to_string(),
            home.join(".windsurf/mcp.json"),
        ),
    ];

    // Linux: XDG path for Claude Desktop
    #[cfg(target_os = "linux")]
    {
        if let Ok(xdg) = std::env::var("XDG_CONFIG_HOME") {
            list.push((
                "Claude Desktop (Linux)".to_string(),
                PathBuf::from(xdg).join("Claude/claude_desktop_config.json"),
            ));
        } else {
            list.push((
                "Claude Desktop (Linux)".to_string(),
                home.join(".config/Claude/claude_desktop_config.json"),
            ));
        }
    }

    // Windows paths
    if let Ok(appdata) = std::env::var("APPDATA") {
        let appdata = PathBuf::from(appdata);
        list.push((
            "Claude Desktop (Windows)".to_string(),
            appdata.join("Claude/claude_desktop_config.json"),
        ));
    }

    list
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Return the list of known MCP config file locations with their current state,
/// including the full list of already-configured server keys per file.
#[tauri::command]
pub(crate) async fn mcp_detect_configs() -> Result<Vec<McpConfigFile>, String> {
    let home = home_dir().ok_or("Cannot determine home directory")?;
    let configs = known_configs(&home);
    let mut result = Vec::new();

    for (label, path) in configs {
        let exists = path.exists();

        // Skip platform-specific entries that don't apply to the current OS.
        if !exists {
            #[cfg(target_os = "windows")]
            if label.contains("Linux") {
                continue;
            }
            #[cfg(target_os = "linux")]
            if label.contains("Windows") {
                continue;
            }
            #[cfg(target_os = "macos")]
            if label.contains("Windows") || label.contains("Linux") {
                continue;
            }
        }

        let server_keys = if exists {
            read_json(&path)
                .map(|v| mcp_server_keys(&v))
                .unwrap_or_default()
        } else {
            Vec::new()
        };

        result.push(McpConfigFile {
            label,
            path: path.to_string_lossy().into_owned(),
            exists,
            server_keys,
        });
    }
    Ok(result)
}

/// Read the `mcpServers` map from a config file as a JSON string.
/// Returns `"{}"` when the file doesn't exist or has no mcpServers key.
#[tauri::command]
pub(crate) async fn mcp_read_config(path: String) -> Result<String, String> {
    let p = PathBuf::from(&path);
    let value = read_json(&p)?;
    let servers = value
        .get("mcpServers")
        .cloned()
        .unwrap_or(Value::Object(Map::new()));
    serde_json::to_string(&servers).map_err(|e| format!("Failed to serialize mcpServers: {}", e))
}

/// Merge a server entry into each specified config file.
///
/// `server_key`   — the key under `mcpServers`, e.g. `"gitwand"`.
/// `server_json`  — JSON object describing the server entry, e.g.:
///                  `{"command":"npx","args":["-y","@gitwand/mcp","--cwd","/repo"]}`.
/// `config_paths` — list of absolute paths to write to.
///
/// Each file is created (with parent dirs) if it does not yet exist.
/// Existing `mcpServers` entries for other servers are left untouched.
#[tauri::command]
pub(crate) async fn mcp_install_server(
    server_key: String,
    server_json: String,
    config_paths: Vec<String>,
) -> Result<(), String> {
    let fragment: Value =
        serde_json::from_str(&server_json).map_err(|e| format!("Invalid server JSON: {}", e))?;

    for path_str in &config_paths {
        let path = PathBuf::from(path_str);

        let mut root: Value = if path.exists() {
            read_json(&path)?
        } else {
            Value::Object(Map::new())
        };

        if !root.is_object() {
            root = Value::Object(Map::new());
        }
        if root.get("mcpServers").is_none() {
            root["mcpServers"] = Value::Object(Map::new());
        }

        root["mcpServers"][&server_key] = fragment.clone();

        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create dirs for {}: {}", path_str, e))?;
        }
        let pretty = serde_json::to_string_pretty(&root)
            .map_err(|e| format!("Failed to serialize config: {}", e))?;
        std::fs::write(&path, pretty)
            .map_err(|e| format!("Failed to write {}: {}", path_str, e))?;
    }
    Ok(())
}

/// Remove a server key from the `mcpServers` map in each specified config file.
/// No-ops gracefully when the file or key doesn't exist.
#[tauri::command]
pub(crate) async fn mcp_uninstall_server(
    server_key: String,
    config_paths: Vec<String>,
) -> Result<(), String> {
    for path_str in &config_paths {
        let path = PathBuf::from(path_str);
        if !path.exists() {
            continue;
        }
        let mut root = read_json(&path)?;
        if root.is_null() {
            continue;
        }
        if let Some(servers) = root.get_mut("mcpServers").and_then(|v| v.as_object_mut()) {
            servers.remove(&server_key);
        }
        let pretty = serde_json::to_string_pretty(&root)
            .map_err(|e| format!("Failed to serialize config: {}", e))?;
        std::fs::write(&path, pretty)
            .map_err(|e| format!("Failed to write {}: {}", path_str, e))?;
    }
    Ok(())
}

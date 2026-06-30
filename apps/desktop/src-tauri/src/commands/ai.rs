//! AI CLI provider Tauri commands (§3.4f migration).
//!
//! Wraps two external CLIs:
//!   - Anthropic's Claude Code (`claude`) — OAuth-via-subscription auth
//!   - OpenAI's Codex (`codex`) — OAuth via ChatGPT or `OPENAI_API_KEY`
//!
//! Both providers expose the same shape of commands:
//!   - `detect_*_cli` — find the binary, query version, ping to test auth
//!   - `*_cli_prompt` — run a one-shot prompt and return the response
//!
//! Plus a Claude-specific `claude_cli_login` that opens the user's native
//! terminal so they can complete the OAuth dance interactively.
//!
//! No PTY. These are one-shot non-interactive prompts; the CLI flush
//! stdout when done and we just collect it.

use crate::git::*;
use crate::types::*;
use std::path::PathBuf;

// ─── Claude binary resolution + env hygiene ──────────────────────────────

/// Apply the API-key env strip to a `std::process::Command` before spawning.
///
/// When the user explicitly picks the "Claude Code CLI" provider in GitWand,
/// they've asked to use their Max/Pro subscription. Stale `ANTHROPIC_API_KEY`
/// or similar env vars in the shell would hijack the call back to API-key
/// auth — strip them so the OAuth session takes precedence.
fn strip_claude_auth_env(cmd: &mut std::process::Command) {
    for var in CLAUDE_AUTH_OVERRIDE_ENV {
        cmd.env_remove(var);
    }
}

/// Resolve the path to the `claude` binary, checking the usual install
/// locations on macOS / Linux / Windows in addition to PATH.
pub(crate) fn resolve_claude_binary() -> Option<String> {
    // 1) Try PATH first via `which` / `where`.
    let which_cmd = if cfg!(windows) { "where" } else { "which" };
    if let Ok(out) = hidden_cmd(which_cmd).arg("claude").output() {
        if out.status.success() {
            let raw = String::from_utf8_lossy(&out.stdout);
            let first = raw.lines().next().unwrap_or("").trim();
            if !first.is_empty() && std::path::Path::new(first).exists() {
                return Some(first.to_string());
            }
        }
    }

    // 2) Fall back to common install locations.
    let home = dirs::home_dir();
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(h) = home.as_ref() {
        candidates.push(h.join(".claude/local/claude"));
        candidates.push(h.join(".local/bin/claude"));
        candidates.push(h.join(".npm-global/bin/claude"));
        // Windows npm global
        candidates.push(h.join("AppData/Roaming/npm/claude.cmd"));
        candidates.push(h.join("AppData/Roaming/npm/claude"));
    }
    candidates.push(PathBuf::from("/opt/homebrew/bin/claude"));
    candidates.push(PathBuf::from("/usr/local/bin/claude"));
    candidates.push(PathBuf::from("/usr/bin/claude"));

    for c in candidates {
        if c.exists() {
            return Some(c.to_string_lossy().to_string());
        }
    }
    None
}

// ─── Codex binary resolution ─────────────────────────────────────────────

pub(crate) fn resolve_codex_binary() -> Option<String> {
    // 1) PATH first
    let which_cmd = if cfg!(windows) { "where" } else { "which" };
    if let Ok(out) = hidden_cmd(which_cmd).arg("codex").output() {
        if out.status.success() {
            let raw = String::from_utf8_lossy(&out.stdout);
            let first = raw.lines().next().unwrap_or("").trim();
            if !first.is_empty() && std::path::Path::new(first).exists() {
                return Some(first.to_string());
            }
        }
    }

    // 2) Common npm install locations
    let home = dirs::home_dir();
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(h) = home.as_ref() {
        candidates.push(h.join(".local/bin/codex"));
        candidates.push(h.join(".npm-global/bin/codex"));
        candidates.push(h.join("AppData/Roaming/npm/codex.cmd"));
        candidates.push(h.join("AppData/Roaming/npm/codex"));
    }
    candidates.push(PathBuf::from("/opt/homebrew/bin/codex"));
    candidates.push(PathBuf::from("/usr/local/bin/codex"));
    candidates.push(PathBuf::from("/usr/bin/codex"));

    for c in candidates {
        if c.exists() {
            return Some(c.to_string_lossy().to_string());
        }
    }
    None
}

// ─── Claude commands ─────────────────────────────────────────────────────

/// Detect Claude Code CLI presence and version — WITHOUT sending an AI
/// prompt to verify auth.
///
/// Historically this also ran `claude -p ping` to test that the user
/// was logged in. That had three problems:
///   1. It sent a real prompt to Claude — billed to the user's account
///      even if they never asked GitWand to use Claude (issue #6).
///   2. On Windows, the spawn produced a visible console window flash
///      before the CREATE_NO_WINDOW fix landed.
///   3. It blocked the Settings panel mount for the prompt's RTT.
///
/// We now skip the ping. Auth is verified implicitly on the first real
/// prompt the user makes through GitWand — if it fails, the CLI's
/// stderr surfaces a clear "please log in" message that the calling
/// command (`claude_cli_prompt`) propagates as an error.
#[tauri::command]
pub(crate) async fn detect_claude_cli() -> Result<ClaudeCliInfo, String> {
    let binary = match resolve_claude_binary() {
        Some(b) => b,
        None => {
            return Ok(ClaudeCliInfo {
                found: false,
                path: String::new(),
                version: String::new(),
                logged_in: false,
                status: "not_found".to_string(),
                detail: "Binaire `claude` introuvable. Installez-le avec `npm install -g @anthropic-ai/claude-code`."
                    .to_string(),
            });
        }
    };

    // Query version only — no auth ping.
    let version = hidden_cmd(&binary)
        .arg("--version")
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();

    Ok(ClaudeCliInfo {
        found: true,
        path: binary,
        version,
        // logged_in stays false because we have NOT verified — the UI
        // should treat `status == "detected"` distinctly from
        // `not_logged_in` and not show a "please log in" hint.
        logged_in: false,
        status: "detected".to_string(),
        detail: String::new(),
    })
}

/// Run `claude -p <prompt>` and return stdout.
///
/// The CLI already handles auth via the user's subscription — we just pipe
/// text in and get text back.
#[tauri::command]
pub(crate) async fn claude_cli_prompt(
    prompt: String,
    system_prompt: Option<String>,
    cwd: Option<String>,
    output_format: Option<String>,
    model: Option<String>,
) -> Result<String, String> {
    let binary = resolve_claude_binary()
        .ok_or_else(|| "Binaire `claude` introuvable".to_string())?;

    // Compose the full prompt: if a system prompt is provided, prepend it
    // as a Markdown-delimited section. `claude -p` doesn't expose a separate
    // system/user channel, so this is the simplest portable shape.
    let full_prompt = match system_prompt {
        Some(sys) if !sys.trim().is_empty() => {
            format!(
                "# System\n{}\n\n# User\n{}",
                sys.trim(),
                prompt.trim()
            )
        }
        _ => prompt,
    };

    let fmt = output_format.unwrap_or_else(|| "text".to_string());

    // The prompt is passed as a CLI argument, and spawning a process with an
    // interior NUL byte fails with "nul byte found in provided data". Binary
    // or malformed content can leak a `\0` into the prompt via diffs or file
    // snapshots, so strip NULs defensively before building the command.
    let full_prompt = full_prompt.replace('\0', "");

    let mut cmd = hidden_cmd(&binary);
    cmd.args(["-p", &full_prompt, "--output-format", &fmt]);
    // v2.17 — explicit per-provider model selection. When empty, the CLI
    // falls back to its own configured default.
    if let Some(m) = model.as_ref() {
        if !m.trim().is_empty() {
            cmd.args(["--model", m.trim()]);
        }
    }
    strip_claude_auth_env(&mut cmd);
    if let Some(dir) = cwd {
        if !dir.trim().is_empty() {
            cmd.current_dir(dir);
        }
    }

    let output = cmd
        .output()
        .map_err(|e| format!("Failed to run claude CLI: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let detail = if stderr.is_empty() { stdout } else { stderr };
        return Err(if detail.is_empty() {
            "Claude CLI a échoué sans message".to_string()
        } else {
            detail
        });
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

// ─── Codex commands ──────────────────────────────────────────────────────
//
// OpenAI Codex CLI integration — mirrors the Claude Code CLI flow but
// shells out to `codex exec "<prompt>"` instead of `claude -p`. `codex
// exec` is the official non-interactive entry point (the REPL-style
// `codex` without subcommand would hang waiting for user input). No
// `--quiet` flag — it doesn't exist on `codex exec` and adding one
// fails with `unexpected argument '--quiet'`.
//
// Auth: either OAuth via `codex login` (uses ChatGPT subscription) or
// `OPENAI_API_KEY` env var. The CLI surfaces a clear error at first call
// when neither is set, so detection matches the Claude pattern: tiny ping
// prompt that exits 0 when auth works.

/// Detect Codex CLI presence and version — same privacy stance as
/// `detect_claude_cli`: no `codex exec ping` to avoid billing the user
/// for a prompt they never asked for. Auth verifies implicitly on the
/// first real prompt via `codex_cli_prompt`.
#[tauri::command]
pub(crate) async fn detect_codex_cli() -> Result<CodexCliInfo, String> {
    let binary = match resolve_codex_binary() {
        Some(b) => b,
        None => {
            return Ok(CodexCliInfo {
                found: false,
                path: String::new(),
                version: String::new(),
                logged_in: false,
                status: "not_found".to_string(),
                detail: "Binaire `codex` introuvable. Installez-le avec `npm install -g @openai/codex`."
                    .to_string(),
            });
        }
    };

    let version = hidden_cmd(&binary)
        .arg("--version")
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();

    Ok(CodexCliInfo {
        found: true,
        path: binary,
        version,
        logged_in: false,
        status: "detected".to_string(),
        detail: String::new(),
    })
}

#[tauri::command]
pub(crate) async fn codex_cli_prompt(
    prompt: String,
    system_prompt: Option<String>,
    cwd: Option<String>,
    model: Option<String>,
) -> Result<String, String> {
    let binary = resolve_codex_binary()
        .ok_or_else(|| "Binaire `codex` introuvable".to_string())?;

    // Codex CLI doesn't expose separate system/user channels; prepend the
    // system prompt as a Markdown section, same shape as the Claude flow.
    let full_prompt = match system_prompt {
        Some(sys) if !sys.trim().is_empty() => {
            format!("# System\n{}\n\n# User\n{}", sys.trim(), prompt.trim())
        }
        _ => prompt,
    };

    // Strip NUL bytes — the prompt is passed as a CLI argument and an interior
    // `\0` makes the spawn fail with "nul byte found in provided data".
    let full_prompt = full_prompt.replace('\0', "");

    let mut cmd = hidden_cmd(&binary);
    cmd.arg("exec");
    // v2.17 — explicit model. Flags must precede the positional prompt on
    // `codex exec`, so push `--model <m>` before the prompt argument.
    if let Some(m) = model.as_ref() {
        if !m.trim().is_empty() {
            cmd.args(["--model", m.trim()]);
        }
    }
    cmd.arg(&full_prompt);
    if let Some(dir) = cwd {
        if !dir.trim().is_empty() {
            cmd.current_dir(dir);
        }
    }

    let output = cmd
        .output()
        .map_err(|e| format!("Failed to run codex CLI: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let detail = if stderr.is_empty() { stdout } else { stderr };
        return Err(if detail.is_empty() {
            "Codex CLI a échoué sans message".to_string()
        } else {
            detail
        });
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

// ─── opencode CLI provider (v2.17) ───────────────────────────────────────
//
// opencode (sst/opencode) is a terminal AI coding agent. Like Claude Code
// and Codex it has a non-interactive entry point:
//   - `opencode run [--model provider/model] "<prompt>"` — one-shot run
//   - `opencode models [provider]`                        — enumerate models
//   - `opencode auth login`                               — provider auth
//
// ─── Antigravity binary resolution ──────────────────────────────────────────
// Antigravity CLI (google-antigravity/antigravity-cli). The binary is named
// `agy` and defaults to ~/.local/bin/agy (curl installer).

pub(crate) fn resolve_antigravity_binary() -> Option<String> {
    // 1) PATH first
    let which_cmd = if cfg!(windows) { "where" } else { "which" };
    if let Ok(out) = hidden_cmd(which_cmd).arg("agy").output() {
        if out.status.success() {
            let raw = String::from_utf8_lossy(&out.stdout);
            let first = raw.lines().next().unwrap_or("").trim();
            if !first.is_empty() && std::path::Path::new(first).exists() {
                return Some(first.to_string());
            }
        }
    }

    // 2) Common install locations (curl installer → ~/.local/bin)
    let home = dirs::home_dir();
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(h) = home.as_ref() {
        candidates.push(h.join(".local/bin/agy"));
        candidates.push(h.join(".npm-global/bin/agy"));
        candidates.push(h.join("AppData/Roaming/npm/agy.cmd"));
        candidates.push(h.join("AppData/Roaming/npm/agy"));
    }
    candidates.push(PathBuf::from("/opt/homebrew/bin/agy"));
    candidates.push(PathBuf::from("/usr/local/bin/agy"));
    candidates.push(PathBuf::from("/usr/bin/agy"));

    for c in candidates {
        if c.exists() {
            return Some(c.to_string_lossy().to_string());
        }
    }
    None
}

/// Detect Antigravity CLI presence and version. Same privacy stance as the
/// Claude / Codex / opencode / Copilot detectors: no prompt is sent to verify
/// auth — that is confirmed implicitly on the first real `antigravity_cli_prompt`.
#[tauri::command]
pub(crate) fn detect_antigravity_cli() -> Result<AntigravityCliInfo, String> {
    let binary = match resolve_antigravity_binary() {
        Some(b) => b,
        None => {
            return Ok(AntigravityCliInfo {
                found: false,
                path: String::new(),
                version: String::new(),
                logged_in: false,
                status: "not_found".to_string(),
                detail: "Binaire `agy` introuvable. Installez-le avec `curl -fsSL https://antigravity.google/cli/install.sh | bash`."
                    .to_string(),
            });
        }
    };

    let version = hidden_cmd(&binary)
        .arg("--version")
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();

    Ok(AntigravityCliInfo {
        found: true,
        path: binary,
        version,
        logged_in: false,
        status: "detected".to_string(),
        detail: String::new(),
    })
}

/// Run a one-shot prompt through the local Antigravity CLI (`agy -p`).
///
/// Antigravity exposes no separate system channel, so the system prompt is
/// prepended as a Markdown section — same portable shape as the Claude /
/// Codex / opencode / Copilot flows. Auth is managed by Antigravity itself.
#[tauri::command]
pub(crate) fn antigravity_cli_prompt(
    prompt: String,
    system_prompt: Option<String>,
    cwd: Option<String>,
    model: Option<String>,
) -> Result<String, String> {
    let binary = resolve_antigravity_binary()
        .ok_or_else(|| "Binaire `agy` introuvable".to_string())?;

    let full_prompt = match system_prompt {
        Some(sys) if !sys.trim().is_empty() => {
            format!("# System\n{}\n\n# User\n{}", sys.trim(), prompt.trim())
        }
        _ => prompt,
    };

    // Strip NUL bytes — the prompt is passed as a CLI argument and an interior
    // `\0` makes the spawn fail with "nul byte found in provided data".
    let full_prompt = full_prompt.replace('\0', "");

    let mut cmd = hidden_cmd(&binary);
    // Flags precede the positional prompt passed via `-p`.
    if let Some(m) = model.as_ref() {
        if !m.trim().is_empty() {
            cmd.args(["--model", m.trim()]);
        }
    }
    cmd.args(["-p", full_prompt.as_str()]);
    if let Some(dir) = cwd {
        if !dir.trim().is_empty() {
            cmd.current_dir(dir);
        }
    }

    let output = cmd
        .output()
        .map_err(|e| format!("Failed to run antigravity CLI: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let detail = if stderr.is_empty() { stdout } else { stderr };
        return Err(if detail.is_empty() {
            "Antigravity CLI a échoué sans message".to_string()
        } else {
            detail
        });
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

// ─── opencode CLI provider (v2.17) ───────────────────────────────────────

// Models are advertised in `provider/model` form (e.g. `anthropic/claude-…`),
// which is exactly the string `--model` expects. Auth is provider-scoped and
// stored by opencode itself, so GitWand just shells out — same trick as the
// other two CLIs.

pub(crate) fn resolve_opencode_binary() -> Option<String> {
    // 1) PATH first
    let which_cmd = if cfg!(windows) { "where" } else { "which" };
    if let Ok(out) = hidden_cmd(which_cmd).arg("opencode").output() {
        if out.status.success() {
            let raw = String::from_utf8_lossy(&out.stdout);
            let first = raw.lines().next().unwrap_or("").trim();
            if !first.is_empty() && std::path::Path::new(first).exists() {
                return Some(first.to_string());
            }
        }
    }

    // 2) Common install locations (curl installer → ~/.opencode/bin, npm global)
    let home = dirs::home_dir();
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(h) = home.as_ref() {
        candidates.push(h.join(".opencode/bin/opencode"));
        candidates.push(h.join(".local/bin/opencode"));
        candidates.push(h.join(".npm-global/bin/opencode"));
        candidates.push(h.join("AppData/Roaming/npm/opencode.cmd"));
        candidates.push(h.join("AppData/Roaming/npm/opencode"));
    }
    candidates.push(PathBuf::from("/opt/homebrew/bin/opencode"));
    candidates.push(PathBuf::from("/usr/local/bin/opencode"));
    candidates.push(PathBuf::from("/usr/bin/opencode"));

    for c in candidates {
        if c.exists() {
            return Some(c.to_string_lossy().to_string());
        }
    }
    None
}

/// Detect opencode CLI presence and version. Same privacy stance as the
/// Claude / Codex detectors: no prompt is sent to verify auth — that is
/// confirmed implicitly on the first real `opencode_cli_prompt`.
#[tauri::command]
pub(crate) async fn detect_opencode_cli() -> Result<OpencodeCliInfo, String> {
    let binary = match resolve_opencode_binary() {
        Some(b) => b,
        None => {
            return Ok(OpencodeCliInfo {
                found: false,
                path: String::new(),
                version: String::new(),
                logged_in: false,
                status: "not_found".to_string(),
                detail: "Binaire `opencode` introuvable. Installez-le avec `npm install -g opencode-ai` ou via `curl -fsSL https://opencode.ai/install | bash`."
                    .to_string(),
            });
        }
    };

    let version = hidden_cmd(&binary)
        .arg("--version")
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();

    Ok(OpencodeCliInfo {
        found: true,
        path: binary,
        version,
        logged_in: false,
        status: "detected".to_string(),
        detail: String::new(),
    })
}

#[tauri::command]
pub(crate) async fn opencode_cli_prompt(
    prompt: String,
    system_prompt: Option<String>,
    cwd: Option<String>,
    model: Option<String>,
) -> Result<String, String> {
    let binary = resolve_opencode_binary()
        .ok_or_else(|| "Binaire `opencode` introuvable".to_string())?;

    // opencode run takes the message as a positional arg and has no separate
    // system channel — prepend the system prompt as a Markdown section, same
    // shape as the Claude / Codex flows.
    let full_prompt = match system_prompt {
        Some(sys) if !sys.trim().is_empty() => {
            format!("# System\n{}\n\n# User\n{}", sys.trim(), prompt.trim())
        }
        _ => prompt,
    };

    // Strip NUL bytes — the prompt is passed as a CLI argument and an interior
    // `\0` makes the spawn fail with "nul byte found in provided data".
    let full_prompt = full_prompt.replace('\0', "");

    let mut cmd = hidden_cmd(&binary);
    cmd.arg("run");
    // Model is `provider/model` form; flags precede the positional message.
    if let Some(m) = model.as_ref() {
        if !m.trim().is_empty() {
            cmd.args(["--model", m.trim()]);
        }
    }
    cmd.arg(&full_prompt);
    if let Some(dir) = cwd {
        if !dir.trim().is_empty() {
            cmd.current_dir(dir);
        }
    }

    let output = cmd
        .output()
        .map_err(|e| format!("Failed to run opencode CLI: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let detail = if stderr.is_empty() { stdout } else { stderr };
        return Err(if detail.is_empty() {
            "opencode CLI a échoué sans message".to_string()
        } else {
            detail
        });
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Enumerate the models opencode knows about (`opencode models`). Each line
/// is a `provider/model` identifier. Returns an empty list (not an error)
/// when the binary is missing or the command fails, so the UI can fall back
/// to free-text entry gracefully.
#[tauri::command]
pub(crate) async fn opencode_list_models() -> Result<Vec<String>, String> {
    let binary = match resolve_opencode_binary() {
        Some(b) => b,
        None => return Ok(Vec::new()),
    };

    let output = match hidden_cmd(&binary).arg("models").output() {
        Ok(o) => o,
        Err(_) => return Ok(Vec::new()),
    };

    if !output.status.success() {
        return Ok(Vec::new());
    }

    let models: Vec<String> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty() && l.contains('/'))
        .collect();

    Ok(models)
}

// ─── GitHub Copilot CLI provider ─────────────────────────────────────────
//
// GitHub Copilot CLI (`copilot`) is an AI coding agent. Like the other CLIs
// it exposes a non-interactive entry point:
//   - `copilot -p "<prompt>" [--model <m>]` — run one prompt, print the
//     response to stdout and exit. The trailing stats footer (credits /
//     tokens) is written to stderr, so stdout stays clean.
//
// We deliberately run Copilot text-only: `--deny-tool=shell`,
// `--deny-tool=write` and `--no-ask-user` block file edits, shell exec and
// interactive prompts, and `COPILOT_ALLOW_ALL` is stripped from the child
// env. The prompt we send is self-contained (it carries the full conflict
// hunk), so the model only needs to produce text — never tools.
//
// Auth is handled by Copilot itself (`copilot` login / GitHub subscription),
// stored on the user's machine — GitWand just shells out, same trick as the
// other three CLIs.

fn resolve_copilot_binary() -> Option<String> {
    // 1) PATH first
    let which_cmd = if cfg!(windows) { "where" } else { "which" };
    if let Ok(out) = hidden_cmd(which_cmd).arg("copilot").output() {
        if out.status.success() {
            let raw = String::from_utf8_lossy(&out.stdout);
            let first = raw.lines().next().unwrap_or("").trim();
            if !first.is_empty() && std::path::Path::new(first).exists() {
                return Some(first.to_string());
            }
        }
    }

    // 2) Common install locations (npm global, homebrew, local bin)
    let home = dirs::home_dir();
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(h) = home.as_ref() {
        candidates.push(h.join(".copilot/bin/copilot"));
        candidates.push(h.join(".local/bin/copilot"));
        candidates.push(h.join(".npm-global/bin/copilot"));
        candidates.push(h.join("AppData/Roaming/npm/copilot.cmd"));
        candidates.push(h.join("AppData/Roaming/npm/copilot"));
    }
    candidates.push(PathBuf::from("/opt/homebrew/bin/copilot"));
    candidates.push(PathBuf::from("/usr/local/bin/copilot"));
    candidates.push(PathBuf::from("/usr/bin/copilot"));

    for c in candidates {
        if c.exists() {
            return Some(c.to_string_lossy().to_string());
        }
    }
    None
}

/// Detect GitHub Copilot CLI presence and version. Same privacy stance as the
/// Claude / Codex / opencode detectors: no prompt is sent to verify auth —
/// that is confirmed implicitly on the first real `copilot_cli_prompt`.
#[tauri::command]
pub(crate) fn detect_copilot_cli() -> Result<CopilotCliInfo, String> {
    let binary = match resolve_copilot_binary() {
        Some(b) => b,
        None => {
            return Ok(CopilotCliInfo {
                found: false,
                path: String::new(),
                version: String::new(),
                logged_in: false,
                status: "not_found".to_string(),
                detail: "Binaire `copilot` introuvable. Installez-le avec `npm install -g @github/copilot`."
                    .to_string(),
            });
        }
    };

    let version = hidden_cmd(&binary)
        .arg("--version")
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();

    Ok(CopilotCliInfo {
        found: true,
        path: binary,
        version,
        logged_in: false,
        status: "detected".to_string(),
        detail: String::new(),
    })
}

#[tauri::command]
pub(crate) fn copilot_cli_prompt(
    prompt: String,
    system_prompt: Option<String>,
    cwd: Option<String>,
    model: Option<String>,
) -> Result<String, String> {
    let binary = resolve_copilot_binary()
        .ok_or_else(|| "Binaire `copilot` introuvable".to_string())?;

    // Copilot CLI doesn't expose a separate system channel — prepend the
    // system prompt as a Markdown section, same shape as the other flows.
    let full_prompt = match system_prompt {
        Some(sys) if !sys.trim().is_empty() => {
            format!("# System\n{}\n\n# User\n{}", sys.trim(), prompt.trim())
        }
        _ => prompt,
    };

    // Strip NUL bytes — the prompt is passed as a CLI argument and an interior
    // `\0` makes the spawn fail with "nul byte found in provided data".
    let full_prompt = full_prompt.replace('\0', "");

    let mut cmd = hidden_cmd(&binary);
    // `--no-color` keeps stdout free of ANSI escapes. Flags precede the
    // positional prompt passed via `-p`.
    cmd.arg("--no-color");
    // Safety: GitWand only wants a text answer back. Deny the tools that
    // could mutate the user's machine (shell exec, file writes) and disable
    // the interactive `ask_user` tool so a one-shot run can never block
    // waiting for input. `COPILOT_ALLOW_ALL` is stripped from the inherited
    // env so a stray variable can't silently re-enable every tool.
    cmd.env_remove("COPILOT_ALLOW_ALL");
    cmd.args(["--deny-tool=shell", "--deny-tool=write", "--no-ask-user"]);
    if let Some(m) = model.as_ref() {
        if !m.trim().is_empty() {
            cmd.args(["--model", m.trim()]);
        }
    }
    cmd.args(["-p", full_prompt.as_str()]);
    if let Some(dir) = cwd {
        if !dir.trim().is_empty() {
            cmd.current_dir(dir);
        }
    }

    let output = cmd
        .output()
        .map_err(|e| format!("Failed to run copilot CLI: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let detail = if stderr.is_empty() { stdout } else { stderr };
        return Err(if detail.is_empty() {
            "Copilot CLI a échoué sans message".to_string()
        } else {
            detail
        });
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

// ─── Claude OAuth login (opens a native terminal) ────────────────────────

/// Launch `claude login` in the user's native terminal emulator. We don't
/// embed a PTY because this is a one-shot setup flow: the user validates
/// in their browser and comes back to GitWand.
#[tauri::command]
pub(crate) async fn claude_cli_login() -> Result<(), String> {
    let binary = resolve_claude_binary()
        .ok_or_else(|| "Binaire `claude` introuvable. Installez-le d'abord.".to_string())?;

    #[cfg(target_os = "macos")]
    {
        // Open Terminal.app with the login command. `osascript` keeps the
        // window focused so the user sees the OAuth prompt in the browser
        // that Claude Code opens automatically.
        let script = format!(
            "tell application \"Terminal\" to do script \"{} login\"",
            binary.replace('"', "\\\"")
        );
        std::process::Command::new("osascript")
            .args(["-e", &script])
            .spawn()
            .map_err(|e| format!("Failed to open Terminal: {}", e))?;
        return Ok(());
    }

    #[cfg(target_os = "windows")]
    {
        // cmd /k keeps the window open after login completes so the user
        // can read any status message.
        std::process::Command::new("cmd")
            .args(["/c", "start", "cmd", "/k", &format!("\"{}\" login", binary)])
            .spawn()
            .map_err(|e| format!("Failed to open cmd: {}", e))?;
        return Ok(());
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        // Try the common Linux terminal emulators in order of popularity.
        // Each entry's last slot is where the shell command gets appended.
        let candidates: [&[&str]; 6] = [
            &["gnome-terminal", "--", "sh", "-c"],
            &["konsole", "-e", "sh", "-c"],
            &["xfce4-terminal", "-e"],
            &["kitty", "sh", "-c"],
            &["alacritty", "-e", "sh", "-c"],
            &["x-terminal-emulator", "-e", "sh", "-c"],
        ];
        let inner = format!("{} login; echo; read -p 'Press enter to close...'", binary);
        for args in candidates.iter() {
            let (prog, rest) = args.split_first().unwrap();
            let mut cmd = std::process::Command::new(prog);
            for a in rest.iter() {
                cmd.arg(a);
            }
            cmd.arg(&inner);
            if cmd.spawn().is_ok() {
                return Ok(());
            }
        }
        return Err(
            "Aucun terminal compatible trouvé. Ouvrez un terminal et tapez: claude login"
                .to_string(),
        );
    }

    #[allow(unreachable_code)]
    Err("Plateforme non supportée".to_string())
}

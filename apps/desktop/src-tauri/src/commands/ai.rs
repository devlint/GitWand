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

// ─── Reasoning effort ────────────────────────────────────────────────────

/// Effort levels any of the CLIs accept. The value is passed as its own
/// argument (never interpolated into a shell string), but it still comes from
/// the frontend, so anything outside this list is dropped rather than
/// forwarded.
const EFFORT_LEVELS: &[&str] = &[
    "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra",
];

/// The effort to forward, or `None` when it is empty or not a known level —
/// in which case the CLI keeps its own default.
fn valid_effort(effort: Option<&String>) -> Option<&'static str> {
    let e = effort?.trim();
    EFFORT_LEVELS.iter().copied().find(|l| *l == e)
}

// ─── AI CLI env isolation ────────────────────────────────────────────────
//
// The AI CLIs are agents: they can read files and, depending on their own
// config, run commands. Their prompt carries untrusted text (diffs, PR bodies
// written by other people), so a prompt injection is a realistic path to
// "print your environment". `hidden_cmd` alone would hand them every variable
// the login-shell preload imported (`shell_env.rs`: AWS_*, AZURE_*, …) plus the
// forge tokens it forwards explicitly (GH_TOKEN, GITLAB_TOKEN). `ai_cmd`
// starts from an empty environment instead and re-adds only what a CLI needs
// to locate its own config, reach the network through a corporate proxy, and
// authenticate with its *own* provider.

/// Which AI CLI a command is being built for — selects the provider-specific
/// part of the env allowlist.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub(crate) enum AiCli {
    Claude,
    Codex,
    Opencode,
    Copilot,
    Antigravity,
}

/// Variables every AI CLI may inherit: user identity / home / locale / temp,
/// proxy + CA bundle (corporate networks), and the Windows system variables a
/// process needs to start at all. Nothing here carries a credential.
const AI_ENV_BASE: &[&str] = &[
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TERM",
    "LANG",
    "LANGUAGE",
    "TZ",
    "TMPDIR",
    "TMP",
    "TEMP",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "XDG_STATE_HOME",
    "XDG_RUNTIME_DIR",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
    "all_proxy",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
    "REQUESTS_CA_BUNDLE",
    // Windows
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "USERPROFILE",
    "USERNAME",
    "USERDOMAIN",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMDATA",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "HOMEDRIVE",
    "HOMEPATH",
    "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE",
    "OS",
];

/// Forge tokens `hidden_cmd` sets explicitly on every command. They are for
/// `git` / `gh` / `glab`, never for an AI agent.
const FORGE_TOKEN_ENV: &[&str] = &[
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GITLAB_TOKEN",
    "GITLAB_ACCESS_TOKEN",
];

/// Claude Code's documented configuration variables: config location,
/// gateway, models, the Bedrock / Vertex / Foundry switches and endpoints,
/// its OAuth token and mTLS client certificate, output and traffic settings.
/// Cloud credentials are not here: see `ai_env_allowed_for`.
const CLAUDE_CONFIG_ENV: &[&str] = &[
    "CLAUDE_CONFIG_DIR",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_CUSTOM_HEADERS",
    "ANTHROPIC_MODEL",
    "ANTHROPIC_SMALL_FAST_MODEL",
    "ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "ANTHROPIC_BEDROCK_BASE_URL",
    "ANTHROPIC_VERTEX_BASE_URL",
    "ANTHROPIC_VERTEX_PROJECT_ID",
    "ANTHROPIC_FOUNDRY_BASE_URL",
    "ANTHROPIC_FOUNDRY_RESOURCE",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
    "CLAUDE_CODE_SKIP_VERTEX_AUTH",
    "CLAUDE_CODE_SKIP_FOUNDRY_AUTH",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_CLIENT_CERT",
    "CLAUDE_CODE_CLIENT_KEY",
    "CLAUDE_CODE_CLIENT_KEY_PASSPHRASE",
    "CLAUDE_CODE_MAX_OUTPUT_TOKENS",
    "CLAUDE_CODE_SUBAGENT_MODEL",
    "CLAUDE_CODE_API_KEY_HELPER_TTL_MS",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
    "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS",
    "CLAUDE_CODE_PROXY_RESOLVES_HOSTS",
    // Windows: where Git Bash lives — Claude Code will not start without it
    // when it is not in the default location.
    "CLAUDE_CODE_GIT_BASH_PATH",
    "CLAUDE_CODE_SHELL",
    "CLAUDE_CODE_MAX_RETRIES",
    "CLAUDE_CODE_DISABLE_TERMINAL_TITLE",
    "API_TIMEOUT_MS",
    "ANTHROPIC_BETAS",
    "DISABLE_COST_WARNINGS",
    "MAX_THINKING_TOKENS",
    "DISABLE_TELEMETRY",
    "DISABLE_ERROR_REPORTING",
    "DISABLE_AUTOUPDATER",
    "DISABLE_PROMPT_CACHING",
    "DISABLE_NON_ESSENTIAL_MODEL_CALLS",
];

/// What the user's own CLI configuration says about the variables a CLI
/// needs beyond its fixed allowlist. Built from GitWand's environment and the
/// CLIs' *user-level* config files only — never from a file inside the
/// repository, whose content is as untrusted as the prompt.
#[derive(Default, Debug, PartialEq, Eq)]
pub(crate) struct AiEnvContext {
    /// Claude Code is set up for Amazon Bedrock (`CLAUDE_CODE_USE_BEDROCK`):
    /// the AWS credential chain must reach it.
    claude_bedrock: bool,
    /// Claude Code is set up for Google Vertex AI (`CLAUDE_CODE_USE_VERTEX`).
    claude_vertex: bool,
    /// Claude Code is set up for Microsoft Foundry (`CLAUDE_CODE_USE_FOUNDRY`).
    claude_foundry: bool,
    /// Variable names the user's own config points the CLI at — Codex
    /// `env_key` (custom providers), opencode `{env:NAME}`.
    config_refs: Vec<String>,
}

/// A truthy flag value as Claude Code reads it (`1`, `true`, …).
fn env_flag_set(v: Option<&str>) -> bool {
    v.map(|v| v.trim())
        .is_some_and(|v| !v.is_empty() && v != "0" && !v.eq_ignore_ascii_case("false"))
}

/// A plausible environment variable name — the only shape of config
/// reference that is ever forwarded.
fn is_env_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Cloud switches found in a Claude Code settings file.
#[derive(Default, Debug, PartialEq, Eq, Clone, Copy)]
struct ClaudeCloud {
    bedrock: bool,
    vertex: bool,
    foundry: bool,
}

/// Cloud switches in the `env` block of a Claude Code settings file (user
/// `settings.json` or the managed, system-wide one), where Bedrock / Vertex /
/// Foundry setups usually live rather than in the shell.
fn parse_claude_settings_flags(text: &str) -> ClaudeCloud {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(text) else {
        return ClaudeCloud::default();
    };
    let flag = |k: &str| {
        let val = v.get("env").and_then(|e| e.get(k));
        env_flag_set(
            val.and_then(|x| x.as_str())
                .or_else(|| {
                    val.and_then(|x| x.as_bool())
                        .map(|b| if b { "1" } else { "0" })
                })
                .or_else(|| {
                    val.and_then(|x| x.as_i64())
                        .map(|n| if n != 0 { "1" } else { "0" })
                }),
        )
    };
    ClaudeCloud {
        bedrock: flag("CLAUDE_CODE_USE_BEDROCK"),
        vertex: flag("CLAUDE_CODE_USE_VERTEX"),
        foundry: flag("CLAUDE_CODE_USE_FOUNDRY"),
    }
}

/// Claude Code's managed (system-wide, admin-deployed) settings files: the
/// platform's `managed-settings.json` and the `*.json` drop-ins of its
/// `managed-settings.d` directory. Read-only, and never repository content.
fn claude_managed_settings_files() -> Vec<PathBuf> {
    let dirs: &[&str] = if cfg!(target_os = "macos") {
        &["/Library/Application Support/ClaudeCode"]
    } else if cfg!(windows) {
        &[r"C:\Program Files\ClaudeCode", r"C:\ProgramData\ClaudeCode"]
    } else {
        &["/etc/claude-code"]
    };
    let mut files = Vec::new();
    for d in dirs {
        let d = PathBuf::from(d);
        files.push(d.join("managed-settings.json"));
        if let Ok(rd) = std::fs::read_dir(d.join("managed-settings.d")) {
            let mut dropins: Vec<PathBuf> = rd
                .filter_map(|e| e.ok().map(|e| e.path()))
                .filter(|p| p.extension().is_some_and(|x| x == "json"))
                .collect();
            dropins.sort();
            files.extend(dropins);
        }
    }
    files
}

/// Variable names a Codex `config.toml` points at: every `env_key` (custom
/// model providers name the variable holding their key this way) and the
/// values of `env_http_headers` tables, wherever they sit — provider tables,
/// inline tables, dotted keys, profiles. Parsed as TOML; only names shaped
/// like variable names are kept, and they are then allowlisted.
fn parse_codex_env_keys(text: &str) -> Vec<String> {
    fn walk(v: &toml::Value, out: &mut Vec<String>) {
        match v {
            toml::Value::Table(t) => {
                for (k, v) in t {
                    match (k.as_str(), v) {
                        ("env_key", toml::Value::String(name)) => out.push(name.clone()),
                        ("env_http_headers", toml::Value::Table(h)) => {
                            out.extend(h.values().filter_map(|n| n.as_str().map(str::to_string)))
                        }
                        _ => walk(v, out),
                    }
                }
            }
            toml::Value::Array(a) => a.iter().for_each(|v| walk(v, out)),
            _ => {}
        }
    }
    let Ok(table) = text.parse::<toml::Table>() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    walk(&toml::Value::Table(table), &mut out);
    out.retain(|n| is_env_name(n));
    out
}

/// `{env:NAME}` substitutions of an opencode config file.
fn parse_opencode_env_refs(text: &str) -> Vec<String> {
    text.match_indices("{env:")
        .filter_map(|(i, m)| {
            let rest = &text[i + m.len()..];
            let name = &rest[..rest.find('}')?];
            is_env_name(name).then(|| name.to_string())
        })
        .collect()
}

/// Build the context for `cli` from `env` (GitWand's environment) and the
/// user-level / system-level config files it locates.
fn ai_env_context(cli: AiCli, env: &dyn Fn(&str) -> Option<String>) -> AiEnvContext {
    let managed = if cli == AiCli::Claude {
        claude_managed_settings_files()
    } else {
        Vec::new()
    };
    ai_env_context_with(cli, env, &managed)
}

/// `ai_env_context` from GitWand's environment, cached per CLI for a few
/// seconds: one generation spawns the CLI several times (`--help` probe,
/// `--version`, the run), and each would otherwise re-read the config files
/// and list the managed-settings directory. A config change is seen on the
/// next generation.
fn cached_ai_env_context(cli: AiCli) -> std::sync::Arc<AiEnvContext> {
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex, OnceLock};
    use std::time::{Duration, Instant};
    const TTL: Duration = Duration::from_secs(10);
    type Entry = (Instant, Arc<AiEnvContext>);
    static CACHE: OnceLock<Mutex<HashMap<AiCli, Entry>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some((at, ctx)) = cache.lock().ok().and_then(|m| m.get(&cli).cloned()) {
        if at.elapsed() < TTL {
            return ctx;
        }
    }
    let ctx = Arc::new(ai_env_context(cli, &|k| std::env::var(k).ok()));
    if let Ok(mut m) = cache.lock() {
        m.insert(cli, (Instant::now(), ctx.clone()));
    }
    ctx
}

/// `ai_env_context` with the Claude managed settings files given explicitly.
fn ai_env_context_with(
    cli: AiCli,
    env: &dyn Fn(&str) -> Option<String>,
    claude_managed: &[PathBuf],
) -> AiEnvContext {
    let read = |p: PathBuf| std::fs::read_to_string(p).ok();
    let home = env("HOME")
        .or_else(|| env("USERPROFILE"))
        .filter(|h| !h.trim().is_empty())
        .map(PathBuf::from);
    let mut ctx = AiEnvContext::default();
    match cli {
        AiCli::Claude => {
            ctx.claude_bedrock = env_flag_set(env("CLAUDE_CODE_USE_BEDROCK").as_deref());
            ctx.claude_vertex = env_flag_set(env("CLAUDE_CODE_USE_VERTEX").as_deref());
            ctx.claude_foundry = env_flag_set(env("CLAUDE_CODE_USE_FOUNDRY").as_deref());
            let dir = env("CLAUDE_CONFIG_DIR")
                .filter(|d| !d.trim().is_empty())
                .map(PathBuf::from)
                .or_else(|| home.as_ref().map(|h| h.join(".claude")));
            let files = dir
                .map(|d| d.join("settings.json"))
                .into_iter()
                .chain(claude_managed.iter().cloned());
            for text in files.filter_map(read) {
                let cloud = parse_claude_settings_flags(&text);
                ctx.claude_bedrock |= cloud.bedrock;
                ctx.claude_vertex |= cloud.vertex;
                ctx.claude_foundry |= cloud.foundry;
            }
        }
        AiCli::Codex => {
            let dir = env("CODEX_HOME")
                .filter(|d| !d.trim().is_empty())
                .map(PathBuf::from)
                .or_else(|| home.as_ref().map(|h| h.join(".codex")));
            if let Some(text) = dir.and_then(|d| read(d.join("config.toml"))) {
                ctx.config_refs = parse_codex_env_keys(&text);
            }
        }
        AiCli::Opencode => {
            let mut files: Vec<PathBuf> = Vec::new();
            if let Some(f) = env("OPENCODE_CONFIG").filter(|f| !f.trim().is_empty()) {
                files.push(PathBuf::from(f));
            }
            let config_home = env("XDG_CONFIG_HOME")
                .filter(|d| !d.trim().is_empty())
                .map(PathBuf::from)
                .or_else(|| home.as_ref().map(|h| h.join(".config")));
            if let Some(dir) = config_home.map(|d| d.join("opencode")) {
                for name in ["opencode.json", "opencode.jsonc", "config.json"] {
                    files.push(dir.join(name));
                }
            }
            for f in files {
                if let Some(text) = read(f) {
                    ctx.config_refs.extend(parse_opencode_env_refs(&text));
                }
            }
        }
        AiCli::Copilot | AiCli::Antigravity => {}
    }
    ctx
}

/// Provider-specific variables: each CLI's own config location and its own
/// provider's auth. Cloud credentials (AWS_*, Google ADC) only reach Claude
/// Code when the user set it up for Bedrock / Vertex; forge tokens (GH_TOKEN,
/// GITLAB_TOKEN) reach no CLI unless the user's own CLI config names them.
fn ai_env_allowed_for(cli: AiCli, key: &str, ctx: &AiEnvContext) -> bool {
    if ctx.config_refs.iter().any(|r| r == key) {
        return true;
    }
    match cli {
        // ANTHROPIC_API_KEY & co. are left out on purpose: the user picked the
        // CLI provider to use their subscription (see CLAUDE_AUTH_OVERRIDE_ENV,
        // also stripped by `strip_claude_auth_env`). The rest is Claude Code's
        // documented configuration, by name — not whole ANTHROPIC_* /
        // CLAUDE_CODE_* families, which would also let through unrelated
        // secrets such as an ANTHROPIC_ADMIN_KEY.
        AiCli::Claude => {
            if CLAUDE_AUTH_OVERRIDE_ENV.contains(&key) {
                return false;
            }
            CLAUDE_CONFIG_ENV.contains(&key)
                || (ctx.claude_bedrock && key.starts_with("AWS_"))
                || (ctx.claude_vertex
                    && (matches!(
                        key,
                        "CLOUD_ML_REGION"
                            | "GOOGLE_APPLICATION_CREDENTIALS"
                            | "GOOGLE_CLOUD_PROJECT"
                            | "GOOGLE_CLOUD_QUOTA_PROJECT"
                            | "GCLOUD_PROJECT"
                    ) || key.starts_with("VERTEX_REGION_")
                        || key.starts_with("CLOUDSDK_")))
                || (ctx.claude_foundry && key == "ANTHROPIC_FOUNDRY_API_KEY")
        }
        AiCli::Codex => {
            key.starts_with("CODEX_")
                || matches!(
                    key,
                    "OPENAI_API_KEY"
                        | "OPENAI_BASE_URL"
                        | "OPENAI_ORGANIZATION"
                        | "OPENAI_PROJECT"
                        // The documented Azure provider's `env_key`, for
                        // setups that define it in a profile file.
                        | "AZURE_OPENAI_API_KEY"
                )
        }
        AiCli::Opencode => {
            key.starts_with("OPENCODE_")
                || matches!(
                    key,
                    "ANTHROPIC_API_KEY"
                        | "OPENAI_API_KEY"
                        | "GEMINI_API_KEY"
                        | "GOOGLE_GENERATIVE_AI_API_KEY"
                        | "OPENROUTER_API_KEY"
                        | "GROQ_API_KEY"
                        | "MISTRAL_API_KEY"
                        | "DEEPSEEK_API_KEY"
                        | "XAI_API_KEY"
                )
        }
        // GH_TOKEN is not forwarded: it is the user's forge token, usually with
        // repo scopes. Copilot authenticates through its own `/login` keychain
        // entry or a dedicated COPILOT_GITHUB_TOKEN.
        AiCli::Copilot => key.starts_with("COPILOT_") && key != "COPILOT_ALLOW_ALL",
        AiCli::Antigravity => matches!(
            key,
            "GEMINI_API_KEY"
                | "GOOGLE_API_KEY"
                | "GOOGLE_CLOUD_PROJECT"
                | "GOOGLE_CLOUD_LOCATION"
                | "GOOGLE_GENAI_USE_VERTEXAI"
        ),
    }
}

/// Whether `key` from GitWand's own environment may reach `cli`.
fn ai_env_allowed(cli: AiCli, key: &str, ctx: &AiEnvContext) -> bool {
    // Windows env names are case-insensitive; compare the base list that way.
    let upper = key.to_ascii_uppercase();
    AI_ENV_BASE.iter().any(|b| *b == key || *b == upper)
        || key.starts_with("LC_")
        || ai_env_allowed_for(cli, key, ctx)
}

/// `hidden_cmd` for an AI CLI, with an allowlisted environment (see above).
///
/// Keeps what `hidden_cmd` set explicitly — the enriched macOS PATH and the
/// AppImage library-path fixes — except the forge tokens, then re-adds the
/// allowlisted variables from GitWand's own environment.
pub(crate) fn ai_cmd(binary: &str, cli: AiCli) -> std::process::Command {
    let mut cmd = hidden_cmd(binary);
    let explicit: Vec<(std::ffi::OsString, std::ffi::OsString)> = cmd
        .get_envs()
        .filter_map(|(k, v)| v.map(|v| (k.to_owned(), v.to_owned())))
        .collect();
    cmd.env_clear();
    let mut has_path = false;
    for (k, v) in explicit {
        let name = k.to_string_lossy();
        if FORGE_TOKEN_ENV.contains(&name.as_ref()) {
            continue;
        }
        has_path |= name.eq_ignore_ascii_case("PATH");
        cmd.env(&k, &v);
    }
    if !has_path {
        if let Some(path) = std::env::var_os("PATH") {
            cmd.env("PATH", path);
        }
    }
    let ctx = cached_ai_env_context(cli);
    for (k, v) in std::env::vars_os() {
        if let Some(name) = k.to_str() {
            if ai_env_allowed(cli, name, &ctx) {
                cmd.env(&k, &v);
            }
        }
    }
    cmd
}

/// Run `cmd` with `input` written to its stdin, collecting stdout/stderr.
///
/// Used to hand a prompt to a CLI that reads it from stdin, so the prompt —
/// which holds repository content — never appears in the process argv, where
/// any local user can read it with `ps`. The write happens on its own thread:
/// a CLI that starts printing before it has drained stdin would otherwise
/// deadlock against a full stdout pipe.
fn output_with_stdin(
    mut cmd: std::process::Command,
    input: String,
) -> std::io::Result<std::process::Output> {
    use std::io::Write;
    use std::process::Stdio;
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn()?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| std::io::Error::other("failed to open stdin"))?;
    let writer = std::thread::spawn(move || {
        // A CLI that exits without reading closes the pipe; that is its
        // answer to report, not a write error to surface.
        let _ = stdin.write_all(input.as_bytes());
    });
    let out = child.wait_with_output();
    let _ = writer.join();
    out
}

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
    tauri::async_runtime::spawn_blocking(detect_claude_cli_inner)
        .await
        .map_err(|e| e.to_string())?
}

fn detect_claude_cli_inner() -> Result<ClaudeCliInfo, String> {
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
    let version = ai_cmd(&binary, AiCli::Claude)
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
    effort: Option<String>,
) -> Result<String, String> {
    // The body spawns a process and blocks on `.output()`. Inside the async
    // runtime that pins one of tokio's worker threads for the whole model
    // call, which is seconds to minutes, and a batch of them starves every
    // other IPC command. `spawn_blocking` puts it on the blocking pool
    // instead, which is what `ops.rs` already does for git subprocesses.
    tauri::async_runtime::spawn_blocking(move || {
        claude_cli_prompt_inner(prompt, system_prompt, cwd, output_format, model, effort)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Built-in tools denied by name, on top of `--tools ""`: the safety net for a
/// Claude Code too old to know `--tools`, where only a deny list exists. Every
/// tool that reads, writes, runs or fetches — reading matters too, an
/// injected "quote ~/.aws/credentials" lands in the generated text — plus
/// `Task` / `Agent` (sub-agents), so the denial cannot be sidestepped through
/// a delegated run. Names a given version lacks (`MultiEdit`, `LS`… in 2.x)
/// only draw a warning on stderr.
const CLAUDE_DENIED_TOOLS: &[&str] = &[
    "Bash",
    "BashOutput",
    "KillBash",
    "KillShell",
    "Edit",
    "MultiEdit",
    "Write",
    "NotebookEdit",
    "NotebookRead",
    "Read",
    "Glob",
    "Grep",
    "LS",
    "WebFetch",
    "WebSearch",
    "Task",
    "Agent",
    "TodoWrite",
    "SlashCommand",
    "Skill",
];

/// Which lockdown flags the installed `claude` understands, read from its
/// `--help`. An unknown flag makes the CLI refuse to run at all, so each one
/// is only passed when listed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
struct ClaudeCaps {
    /// `--tools ""` — no tool at all (Claude Code 2.x).
    tools: bool,
    /// `--setting-sources user` — ignore the project's `.claude/settings*.json`.
    setting_sources: bool,
    /// `--strict-mcp-config` — no MCP server unless `--mcp-config` names one.
    strict_mcp: bool,
}

fn parse_claude_caps(help: &str) -> ClaudeCaps {
    let has = |flag: &str| {
        help.split(|c: char| c.is_whitespace() || c == ',')
            .any(|w| w == flag)
    };
    ClaudeCaps {
        tools: has("--tools"),
        setting_sources: has("--setting-sources"),
        strict_mcp: has("--strict-mcp-config"),
    }
}

/// Run `cmd` (stdin closed, stderr dropped) and return its stdout when it
/// exits successfully within `timeout`; `None` on failure or timeout, after
/// killing it. stdout is drained on its own thread so a large output cannot
/// stall the child against a full pipe.
fn stdout_within(mut cmd: std::process::Command, timeout: std::time::Duration) -> Option<String> {
    use std::io::Read;
    use std::process::Stdio;
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut out = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = out.read_to_end(&mut buf);
        buf
    });
    let deadline = std::time::Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break Some(st),
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(std::time::Duration::from_millis(20))
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };
    let buf = reader.join().ok()?;
    status
        .filter(|s| s.success())
        .map(|_| String::from_utf8_lossy(&buf).into_owned())
}

/// Identity of a binary for the capability cache: path, size and mtime, so an
/// upgraded CLI in place is probed again.
fn binary_identity(binary: &str) -> (String, u64, Option<std::time::SystemTime>) {
    let meta = std::fs::metadata(binary).ok();
    (
        binary.to_string(),
        meta.as_ref().map(|m| m.len()).unwrap_or(0),
        meta.and_then(|m| m.modified().ok()),
    )
}

/// `parse_claude_caps` of `binary --help` (10 s at most), cached per binary
/// identity. A failed, timed-out or empty probe is not cached: the next run
/// probes again rather than staying on the most restrictive guess.
fn claude_caps(binary: &str) -> ClaudeCaps {
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};
    type Key = (String, u64, Option<std::time::SystemTime>);
    static CACHE: OnceLock<Mutex<HashMap<Key, ClaudeCaps>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let key = binary_identity(binary);
    if let Some(c) = cache.lock().ok().and_then(|m| m.get(&key).copied()) {
        return c;
    }
    let mut cmd = ai_cmd(binary, AiCli::Claude);
    cmd.arg("--help");
    let Some(help) = stdout_within(cmd, std::time::Duration::from_secs(10)) else {
        return ClaudeCaps::default();
    };
    if help.trim().is_empty() {
        return ClaudeCaps::default();
    }
    let caps = parse_claude_caps(&help);
    if let Ok(mut m) = cache.lock() {
        m.insert(key, caps);
    }
    caps
}

/// Private working directory for the AI CLIs that must not run inside the
/// repository: under the user's own cache directory (`~/Library/Caches`,
/// `~/.cache`, `%LOCALAPPDATA%`), never the shared system temp dir — on Linux
/// `/tmp` is world-writable, and another local user could plant a
/// `.claude/settings.json`, `opencode.json` or `.codex/config.toml` there.
fn ai_neutral_dir() -> Result<PathBuf, String> {
    let base = dirs::cache_dir()
        .or_else(dirs::home_dir)
        .ok_or_else(|| "No per-user directory to run the AI CLI in".to_string())?;
    prepare_neutral_dir(&base.join("gitwand").join("ai-cwd"))
}

/// Create `dir` if needed and check it is a real directory (not a symlink)
/// only its owner can enter (0700 on Unix; setting the mode fails unless we
/// own it). It is made an empty git repository so `codex exec` accepts it,
/// and since nobody trusted it, Codex loads no project config from it.
fn prepare_neutral_dir(dir: &std::path::Path) -> Result<PathBuf, String> {
    let fail = |what: &str, e: &dyn std::fmt::Display| {
        format!("AI working directory {}: {} ({})", dir.display(), what, e)
    };
    std::fs::create_dir_all(dir).map_err(|e| fail("cannot create", &e))?;
    let meta = std::fs::symlink_metadata(dir).map_err(|e| fail("cannot inspect", &e))?;
    if meta.file_type().is_symlink() || !meta.is_dir() {
        return Err(fail("is not a plain directory", &"symlink or file"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| fail("cannot restrict permissions", &e))?;
        let mode = std::fs::symlink_metadata(dir)
            .map_err(|e| fail("cannot inspect", &e))?
            .permissions()
            .mode();
        if mode & 0o077 != 0 {
            return Err(fail("is accessible to other users", &format!("{:o}", mode)));
        }
    }
    if !dir.join(".git").exists() {
        let ok = git_cmd()
            .args(["init", "-q"])
            .current_dir(dir)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if !ok {
            return Err(fail("cannot initialise", &"git init failed"));
        }
    }
    Ok(dir.to_path_buf())
}

/// Flags that confine a `claude -p` run to producing text. The prompt carries
/// untrusted repo content, so nothing may act on the machine, read it, or
/// reach the network, whatever the user's Claude settings allow:
///
/// - `--tools ""`: no tool at all — these one-shot generations need none.
/// - `--setting-sources user`: the repository's `.claude/settings.json` /
///   `settings.local.json` are not loaded. `-p` skips the workspace-trust
///   prompt, so without it a cloned repo's `SessionStart` /
///   `UserPromptSubmit` hook ran on "generate commit message" — verified live
///   on Claude Code 2.1.296, as is the fix.
/// - `--strict-mcp-config` without `--mcp-config`: no MCP server.
/// - the `CLAUDE_DENIED_TOOLS` deny list, for a CLI without `--tools`.
fn claude_lockdown_args(caps: ClaudeCaps) -> Vec<&'static str> {
    let mut args = Vec::new();
    if caps.tools {
        args.extend(["--tools", ""]);
    }
    if caps.setting_sources {
        args.extend(["--setting-sources", "user"]);
    }
    if caps.strict_mcp {
        args.push("--strict-mcp-config");
    }
    args.push("--disallowedTools");
    args.extend(CLAUDE_DENIED_TOOLS);
    args
}

/// Directory to run `claude -p` in. The repository when its project settings
/// can be ignored (`--setting-sources`); otherwise the private neutral
/// directory (`ai_neutral_dir`), so an older CLI cannot pick up the
/// repository's hooks — the prompt already carries the content it needs.
fn claude_run_dir(
    caps: ClaudeCaps,
    cwd: Option<&str>,
    neutral: &dyn Fn() -> Result<PathBuf, String>,
) -> Result<Option<PathBuf>, String> {
    if caps.setting_sources {
        Ok(cwd.filter(|d| !d.trim().is_empty()).map(PathBuf::from))
    } else {
        neutral().map(Some)
    }
}

fn claude_cli_prompt_inner(
    prompt: String,
    system_prompt: Option<String>,
    cwd: Option<String>,
    output_format: Option<String>,
    model: Option<String>,
    effort: Option<String>,
) -> Result<String, String> {
    let binary =
        resolve_claude_binary().ok_or_else(|| "Binaire `claude` introuvable".to_string())?;

    // Compose the full prompt: if a system prompt is provided, prepend it
    // as a Markdown-delimited section. `claude -p` doesn't expose a separate
    // system/user channel, so this is the simplest portable shape.
    let full_prompt = match system_prompt {
        Some(sys) if !sys.trim().is_empty() => {
            format!("# System\n{}\n\n# User\n{}", sys.trim(), prompt.trim())
        }
        _ => prompt,
    };

    let fmt = output_format.unwrap_or_else(|| "text".to_string());

    // Binary or malformed content can leak a `\0` into the prompt via diffs or
    // file snapshots; strip NULs defensively before handing it to the CLI.
    let full_prompt = full_prompt.replace('\0', "");

    let mut cmd = ai_cmd(&binary, AiCli::Claude);
    // `-p` with no positional prompt reads it from stdin: the prompt holds
    // repository content and must stay out of the argv (see output_with_stdin).
    cmd.args(["-p", "--output-format", &fmt]);
    // v2.17 — explicit per-provider model selection. When empty, the CLI
    // falls back to its own configured default.
    if let Some(m) = model.as_ref() {
        if !m.trim().is_empty() {
            cmd.args(["--model", m.trim()]);
        }
    }
    if let Some(e) = valid_effort(effort.as_ref()) {
        cmd.args(["--effort", e]);
    }
    let caps = claude_caps(&binary);
    cmd.args(claude_lockdown_args(caps));
    strip_claude_auth_env(&mut cmd);
    if let Some(dir) = claude_run_dir(caps, cwd.as_deref(), &ai_neutral_dir)? {
        cmd.current_dir(dir);
    }

    let output = output_with_stdin(cmd, full_prompt)
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
    tauri::async_runtime::spawn_blocking(detect_codex_cli_inner)
        .await
        .map_err(|e| e.to_string())?
}

fn detect_codex_cli_inner() -> Result<CodexCliInfo, String> {
    let binary = match resolve_codex_binary() {
        Some(b) => b,
        None => {
            return Ok(CodexCliInfo {
                found: false,
                path: String::new(),
                version: String::new(),
                logged_in: false,
                status: "not_found".to_string(),
                detail:
                    "Binaire `codex` introuvable. Installez-le avec `npm install -g @openai/codex`."
                        .to_string(),
            });
        }
    };

    let version = ai_cmd(&binary, AiCli::Codex)
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
    effort: Option<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        codex_cli_prompt_inner(prompt, system_prompt, cwd, model, effort)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn codex_cli_prompt_inner(
    prompt: String,
    system_prompt: Option<String>,
    cwd: Option<String>,
    model: Option<String>,
    effort: Option<String>,
) -> Result<String, String> {
    let binary = resolve_codex_binary().ok_or_else(|| "Binaire `codex` introuvable".to_string())?;

    // Codex CLI doesn't expose separate system/user channels; prepend the
    // system prompt as a Markdown section, same shape as the Claude flow.
    let full_prompt = match system_prompt {
        Some(sys) if !sys.trim().is_empty() => {
            format!("# System\n{}\n\n# User\n{}", sys.trim(), prompt.trim())
        }
        _ => prompt,
    };

    // Strip NUL bytes defensively — binary content can leak them into a diff.
    let full_prompt = full_prompt.replace('\0', "");

    let mut cmd = ai_cmd(&binary, AiCli::Codex);
    cmd.arg("exec");
    // GitWand only wants a text answer, and the prompt carries untrusted repo
    // content: pin the sandbox to read-only (no writes, no network) whatever
    // the user's own Codex config says.
    cmd.args(["--sandbox", "read-only"]);
    // v2.17 — explicit model. Flags must precede the positional `-` on
    // `codex exec`, so push `--model <m>` before it.
    if let Some(m) = model.as_ref() {
        if !m.trim().is_empty() {
            cmd.args(["--model", m.trim()]);
        }
    }
    // `codex exec` has no effort flag; the config override is the
    // documented way to set it for one run.
    if let Some(e) = valid_effort(effort.as_ref()) {
        cmd.args(["-c", &format!("model_reasoning_effort={}", e)]);
    }
    // `-` makes `codex exec` read the prompt from stdin, keeping repository
    // content out of the argv (see output_with_stdin).
    cmd.arg("-");
    // Never the repository: a project `.codex/config.toml` is loaded once the
    // user has trusted the folder in Codex, and its MCP servers are commands
    // Codex starts — a cloned repo's server ran on "generate", verified live
    // on codex-cli 0.147 with a trusted project. `-c mcp_servers={}` does not
    // remove them (it merges). The prompt carries the content; Codex needs no
    // repository to answer.
    let _ = cwd;
    cmd.current_dir(ai_neutral_dir()?);

    let output = output_with_stdin(cmd, full_prompt)
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

/// Enumerate the models Antigravity offers (`agy models`). Each line is
/// `<id>\t<display name>`; the effort level is baked into the id
/// (`gemini-3.8-flash-high`), so there is no separate effort to pick. Returns
/// an empty list — never an error — when the binary is missing or the command
/// fails, so the Settings picker falls back to free-text entry.
#[tauri::command]
pub(crate) async fn antigravity_list_models() -> Result<Vec<AntigravityModel>, String> {
    tauri::async_runtime::spawn_blocking(antigravity_list_models_inner)
        .await
        .map_err(|e| e.to_string())?
}

fn antigravity_list_models_inner() -> Result<Vec<AntigravityModel>, String> {
    let binary = match resolve_antigravity_binary() {
        Some(b) => b,
        None => return Ok(Vec::new()),
    };

    let output = match ai_cmd(&binary, AiCli::Antigravity).arg("models").output() {
        Ok(o) => o,
        Err(_) => return Ok(Vec::new()),
    };

    if !output.status.success() {
        return Ok(Vec::new());
    }

    Ok(parse_antigravity_models(&String::from_utf8_lossy(
        &output.stdout,
    )))
}

/// Parse `agy models` stdout. Lines without a tab (the "Fetching available
/// models..." banner) are skipped.
fn parse_antigravity_models(stdout: &str) -> Vec<AntigravityModel> {
    stdout
        .lines()
        .filter_map(|l| {
            let (id, name) = l.split_once('\t')?;
            let id = id.trim();
            if id.is_empty() {
                return None;
            }
            let name = name.trim();
            Some(AntigravityModel {
                id: id.to_string(),
                name: if name.is_empty() {
                    id.to_string()
                } else {
                    name.to_string()
                },
            })
        })
        .collect()
}

// ─── opencode CLI provider (v2.17) ───────────────────────────────────────
//
// opencode (sst/opencode) is a terminal AI coding agent. Like Claude Code
// and Codex it has a non-interactive entry point:
//   - `opencode run [--model provider/model] "<prompt>"` — one-shot run
//   - `opencode models [provider]`                        — enumerate models
//   - `opencode auth login`                               — provider auth
//
/// Enumerate Codex's model catalog (`codex debug models`, JSON). Codex
/// refreshes it from the backend when it can and falls back to the catalog
/// bundled with the binary, so this works logged out too. Hidden models
/// (`visibility != "list"`) are dropped, the rest kept in Codex's own
/// priority order. Returns an empty list — never an error — when the binary
/// is missing or the output does not parse, so the Settings picker falls
/// back to free-text entry.
#[tauri::command]
pub(crate) async fn codex_list_models() -> Result<Vec<CodexModel>, String> {
    tauri::async_runtime::spawn_blocking(codex_list_models_inner)
        .await
        .map_err(|e| e.to_string())?
}

fn codex_list_models_inner() -> Result<Vec<CodexModel>, String> {
    let binary = match resolve_codex_binary() {
        Some(b) => b,
        None => return Ok(Vec::new()),
    };

    let output = match ai_cmd(&binary, AiCli::Codex)
        .args(["debug", "models"])
        .output()
    {
        Ok(o) => o,
        Err(_) => return Ok(Vec::new()),
    };

    if !output.status.success() {
        return Ok(Vec::new());
    }

    Ok(parse_codex_models(&String::from_utf8_lossy(&output.stdout)))
}

fn parse_codex_models(json: &str) -> Vec<CodexModel> {
    let catalog: serde_json::Value = match serde_json::from_str(json) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let Some(entries) = catalog.get("models").and_then(|m| m.as_array()) else {
        return Vec::new();
    };

    let mut listed: Vec<(i64, CodexModel)> = entries
        .iter()
        .filter(|m| {
            m.get("visibility")
                .and_then(|v| v.as_str())
                .unwrap_or("list")
                == "list"
        })
        .filter_map(|m| {
            let id = m.get("slug")?.as_str()?.trim();
            if id.is_empty() {
                return None;
            }
            let name = m
                .get("display_name")
                .and_then(|n| n.as_str())
                .filter(|n| !n.trim().is_empty())
                .unwrap_or(id);
            let efforts = m
                .get("supported_reasoning_levels")
                .and_then(|l| l.as_array())
                .map(|levels| {
                    levels
                        .iter()
                        .filter_map(|l| l.get("effort")?.as_str())
                        .filter(|e| EFFORT_LEVELS.contains(e))
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default();
            let priority = m
                .get("priority")
                .and_then(|p| p.as_i64())
                .unwrap_or(i64::MAX);
            Some((
                priority,
                CodexModel {
                    id: id.to_string(),
                    name: name.trim().to_string(),
                    efforts,
                },
            ))
        })
        .collect();
    listed.sort_by_key(|(priority, _)| *priority);
    listed.into_iter().map(|(_, m)| m).collect()
}

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
pub(crate) async fn detect_antigravity_cli() -> Result<AntigravityCliInfo, String> {
    tauri::async_runtime::spawn_blocking(detect_antigravity_cli_inner)
        .await
        .map_err(|e| e.to_string())?
}

fn detect_antigravity_cli_inner() -> Result<AntigravityCliInfo, String> {
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

    let version = ai_cmd(&binary, AiCli::Antigravity)
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
pub(crate) async fn antigravity_cli_prompt(
    prompt: String,
    system_prompt: Option<String>,
    cwd: Option<String>,
    model: Option<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        antigravity_cli_prompt_inner(prompt, system_prompt, cwd, model)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn antigravity_cli_prompt_inner(
    prompt: String,
    system_prompt: Option<String>,
    cwd: Option<String>,
    model: Option<String>,
) -> Result<String, String> {
    let binary =
        resolve_antigravity_binary().ok_or_else(|| "Binaire `agy` introuvable".to_string())?;

    let full_prompt = match system_prompt {
        Some(sys) if !sys.trim().is_empty() => {
            format!("# System\n{}\n\n# User\n{}", sys.trim(), prompt.trim())
        }
        _ => prompt,
    };

    // Strip NUL bytes — the prompt is passed as a CLI argument and an interior
    // `\0` makes the spawn fail with "nul byte found in provided data".
    let full_prompt = full_prompt.replace('\0', "");

    let mut cmd = ai_cmd(&binary, AiCli::Antigravity);
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
    tauri::async_runtime::spawn_blocking(detect_opencode_cli_inner)
        .await
        .map_err(|e| e.to_string())?
}

fn detect_opencode_cli_inner() -> Result<OpencodeCliInfo, String> {
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

    let version = ai_cmd(&binary, AiCli::Opencode)
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
    tauri::async_runtime::spawn_blocking(move || {
        opencode_cli_prompt_inner(prompt, system_prompt, cwd, model)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn opencode_cli_prompt_inner(
    prompt: String,
    system_prompt: Option<String>,
    cwd: Option<String>,
    model: Option<String>,
) -> Result<String, String> {
    let binary =
        resolve_opencode_binary().ok_or_else(|| "Binaire `opencode` introuvable".to_string())?;

    // opencode run takes the message as a positional arg and has no separate
    // system channel — prepend the system prompt as a Markdown section, same
    // shape as the Claude / Codex flows.
    let full_prompt = match system_prompt {
        Some(sys) if !sys.trim().is_empty() => {
            format!("# System\n{}\n\n# User\n{}", sys.trim(), prompt.trim())
        }
        _ => prompt,
    };

    // Strip NUL bytes defensively — binary content can leak them into a diff.
    let full_prompt = full_prompt.replace('\0', "");

    // `opencode run` with no positional message reads it from stdin (when
    // stdin is not a TTY — verified on opencode 1.17), keeping repository
    // content out of the argv. There is no argv fallback: an opencode too old
    // to read stdin fails visibly (see `opencode_result`) instead of quietly
    // putting the repository content back on the command line.
    // Never in the repository: opencode loads `opencode.json` and
    // `.opencode/plugin/*` from its working directory — a cloned repo's local
    // MCP server and plugin both ran on "generate", verified live on opencode
    // 1.17.11. OPENCODE_DISABLE_PROJECT_CONFIG stops the former but not the
    // plugin, hence the neutral directory. The prompt carries the content.
    let _ = cwd;
    let output = output_with_stdin(
        opencode_run_cmd(&binary, model.as_ref(), &ai_neutral_dir()?),
        full_prompt,
    )
    .map_err(|e| format!("Failed to run opencode CLI: {}", e))?;
    opencode_result(&output)
}

/// The answer of an `opencode run`, or the error to show. An empty answer is
/// an error too: an opencode that ignored the stdin prompt may exit 0 with
/// nothing to say, which must not pass for a generated text.
fn opencode_result(output: &std::process::Output) -> Result<String, String> {
    const STDIN_HINT: &str =
        "opencode n'a pas lu le prompt sur stdin (version trop ancienne ?) — mettez opencode à jour";
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if output.status.success() && !stdout.trim().is_empty() {
        return Ok(stdout);
    }
    if format!("{}{}", stderr, stdout).contains("You must provide a message") {
        return Err(STDIN_HINT.to_string());
    }
    // Provider, auth or rate-limit errors land on stderr, whatever the exit.
    if !stderr.is_empty() {
        return Err(stderr);
    }
    if output.status.success() {
        // Exit 0, nothing on either stream: an opencode that ignored stdin.
        return Err(STDIN_HINT.to_string());
    }
    let stdout = stdout.trim().to_string();
    Err(if stdout.is_empty() {
        "opencode CLI a échoué sans message".to_string()
    } else {
        stdout
    })
}

/// `opencode run`, locked down; the prompt goes on stdin.
fn opencode_run_cmd(
    binary: &str,
    model: Option<&String>,
    run_dir: &std::path::Path,
) -> std::process::Command {
    let mut cmd = ai_cmd(binary, AiCli::Opencode);
    cmd.arg("run");
    // GitWand only wants a text answer, and the prompt carries untrusted repo
    // content: deny the tools that act on the machine or reach the network.
    // `OPENCODE_PERMISSION` is merged over the user's config by opencode; set
    // after `ai_cmd`, so an inherited value cannot loosen it.
    cmd.env(
        "OPENCODE_PERMISSION",
        r#"{"edit":"deny","bash":"deny","webfetch":"deny"}"#,
    );
    // Belt and braces with the neutral directory (see opencode_cli_prompt_inner).
    cmd.env("OPENCODE_DISABLE_PROJECT_CONFIG", "1");
    // Model is `provider/model` form; flags precede the positional message.
    if let Some(m) = model {
        if !m.trim().is_empty() {
            cmd.args(["--model", m.trim()]);
        }
    }
    cmd.current_dir(run_dir);
    cmd
}

/// Enumerate the models opencode knows about (`opencode models`). Each line
/// is a `provider/model` identifier. Returns an empty list (not an error)
/// when the binary is missing or the command fails, so the UI can fall back
/// to free-text entry gracefully.
#[tauri::command]
pub(crate) async fn opencode_list_models() -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(opencode_list_models_inner)
        .await
        .map_err(|e| e.to_string())?
}

fn opencode_list_models_inner() -> Result<Vec<String>, String> {
    let binary = match resolve_opencode_binary() {
        Some(b) => b,
        None => return Ok(Vec::new()),
    };

    let output = match ai_cmd(&binary, AiCli::Opencode).arg("models").output() {
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
pub(crate) async fn detect_copilot_cli() -> Result<CopilotCliInfo, String> {
    tauri::async_runtime::spawn_blocking(detect_copilot_cli_inner)
        .await
        .map_err(|e| e.to_string())?
}

fn detect_copilot_cli_inner() -> Result<CopilotCliInfo, String> {
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

    let version = ai_cmd(&binary, AiCli::Copilot)
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
pub(crate) async fn copilot_cli_prompt(
    prompt: String,
    system_prompt: Option<String>,
    cwd: Option<String>,
    model: Option<String>,
    effort: Option<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        copilot_cli_prompt_inner(prompt, system_prompt, cwd, model, effort)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn copilot_cli_prompt_inner(
    prompt: String,
    system_prompt: Option<String>,
    cwd: Option<String>,
    model: Option<String>,
    effort: Option<String>,
) -> Result<String, String> {
    let binary =
        resolve_copilot_binary().ok_or_else(|| "Binaire `copilot` introuvable".to_string())?;

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

    let mut cmd = ai_cmd(&binary, AiCli::Copilot);
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
    if let Some(e) = valid_effort(effort.as_ref()) {
        cmd.args(["--reasoning-effort", e]);
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

/// Enumerate the models Copilot accepts. Copilot has no `models` command;
/// the list lives in `copilot help config`, under the `model` setting, one
/// `- "<id>"` line per model. Returns an empty list — never an error — when
/// the binary is missing or the section cannot be found, so the Settings
/// picker falls back to free-text entry.
#[tauri::command]
pub(crate) async fn copilot_list_models() -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(copilot_list_models_inner)
        .await
        .map_err(|e| e.to_string())?
}

fn copilot_list_models_inner() -> Result<Vec<String>, String> {
    let binary = match resolve_copilot_binary() {
        Some(b) => b,
        None => return Ok(Vec::new()),
    };

    let output = match ai_cmd(&binary, AiCli::Copilot)
        .args(["help", "config"])
        .output()
    {
        Ok(o) => o,
        Err(_) => return Ok(Vec::new()),
    };

    if !output.status.success() {
        return Ok(Vec::new());
    }

    Ok(parse_copilot_models(&String::from_utf8_lossy(
        &output.stdout,
    )))
}

/// Extract the `- "<id>"` lines that follow the `` `model`: `` heading of
/// `copilot help config`, stopping at the first line that is not one.
fn parse_copilot_models(help: &str) -> Vec<String> {
    help.lines()
        .skip_while(|l| !l.trim_start().starts_with("`model`:"))
        .skip(1)
        .map_while(|l| {
            let id = l.trim().strip_prefix("- \"")?.strip_suffix('"')?;
            (!id.is_empty()).then(|| id.to_string())
        })
        .collect()
}

// ─── Claude OAuth login (opens a native terminal) ────────────────────────

/// Launch `claude login` in the user's native terminal emulator. We don't
/// embed a PTY because this is a one-shot setup flow: the user validates
/// in their browser and comes back to GitWand.
#[tauri::command]
pub(crate) async fn claude_cli_login() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(claude_cli_login_inner)
        .await
        .map_err(|e| e.to_string())?
}

fn claude_cli_login_inner() -> Result<(), String> {
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

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::{Duration, Instant};

    /// The name of the measurement test, as libtest addresses it. `module_path!`
    /// carries the crate name in front, which the test filter does not use.
    fn measurement_test_name() -> String {
        let module = module_path!()
            .split_once("::")
            .map(|(_, rest)| rest)
            .unwrap();
        format!("{module}::ai_call_does_not_occupy_the_calling_runtime")
    }

    /// Writes a deliberately slow stand-in for the `claude` binary and returns
    /// its directory. The real CLI takes seconds to minutes per call, which is
    /// the entire reason these commands must not run on a runtime worker; a
    /// fake reproduces that without spending a model call, and keeps the test
    /// meaningful on CI, where no provider CLI is installed.
    fn write_fake_claude() -> PathBuf {
        static COUNTER: AtomicUsize = AtomicUsize::new(0);
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "gitwand-ai-blocking-{}-{}-{}",
            std::process::id(),
            n,
            nanos
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let bin = dir.join("claude");
        std::fs::write(&bin, "#!/bin/sh\nsleep 1\necho OK\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        dir
    }

    /// Issue #196: clicking the AI action froze the whole app until the model
    /// answered. The body of these commands spawns a process and blocks on
    /// `.output()`, so running it on a runtime worker pins that worker for the
    /// length of a model call, and a batch of them starves every other IPC
    /// command the app makes.
    ///
    /// This is the parent half. It cannot put the fake binary on its own PATH:
    /// `set_var` mutates process-wide state while the rest of this suite is
    /// spawning `git` from other threads. So the measurement runs in a child
    /// process that inherits a PATH built with `Command::env`, which touches
    /// nothing outside that child.
    #[test]
    fn ai_call_does_not_block_other_ipc() {
        let dir = write_fake_claude();
        let path = format!(
            "{}:{}",
            dir.display(),
            std::env::var("PATH").unwrap_or_default()
        );
        let out = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", &measurement_test_name(), "--nocapture"])
            .env("GITWAND_AI_BLOCKING_CHILD", "1")
            .env("PATH", path)
            .output()
            .unwrap();
        std::fs::remove_dir_all(&dir).ok();
        assert!(
            out.status.success(),
            "the measurement failed:\n{}\n{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
    }

    /// The child half, and the actual measurement. Inert unless the parent
    /// above started it, so a plain `cargo test` run does not execute it twice
    /// (and never without the fake binary on PATH).
    ///
    /// The runtime has ONE worker on purpose: that is the sharpest form of the
    /// property. Three calls are put in flight, then a plain 50ms timer is
    /// awaited on that same runtime. If the calls were running on the worker,
    /// the timer could not fire until all three had finished, so the elapsed
    /// time would be the three seconds they take, not the fifty milliseconds
    /// it asks for.
    #[test]
    fn ai_call_does_not_occupy_the_calling_runtime() {
        if std::env::var("GITWAND_AI_BLOCKING_CHILD").is_err() {
            return;
        }

        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .enable_all()
            .build()
            .unwrap();

        let (elapsed, answers) = rt.block_on(async {
            let started = Instant::now();
            let calls: Vec<_> = (0..3)
                .map(|_| {
                    tokio::spawn(claude_cli_prompt(
                        "ping".to_string(),
                        None,
                        None,
                        None,
                        None,
                        None,
                    ))
                })
                .collect();
            tokio::time::sleep(Duration::from_millis(50)).await;
            let elapsed = started.elapsed();
            let mut answers = Vec::new();
            for call in calls {
                answers.push(call.await.unwrap());
            }
            (elapsed, answers)
        });

        assert!(
            elapsed < Duration::from_millis(600),
            "a 50ms timer took {elapsed:?} to fire while three AI calls were in flight: \
             the calls are holding the runtime worker instead of the blocking pool"
        );
        for answer in answers {
            assert_eq!(answer.unwrap().trim(), "OK");
        }
    }

    #[test]
    fn valid_effort_keeps_known_levels_only() {
        assert_eq!(valid_effort(Some(&"high".to_string())), Some("high"));
        assert_eq!(valid_effort(Some(&" xhigh ".to_string())), Some("xhigh"));
        assert_eq!(valid_effort(Some(&"".to_string())), None);
        assert_eq!(valid_effort(Some(&"--model=x".to_string())), None);
        assert_eq!(valid_effort(None), None);
    }

    #[test]
    fn parse_antigravity_models_skips_banner() {
        let out = "Fetching available models...\n\
                   gemini-3.8-flash-high\tGemini 3.8 Flash (High)\n\
                   claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\n";
        let models = parse_antigravity_models(out);
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "gemini-3.8-flash-high");
        assert_eq!(models[0].name, "Gemini 3.8 Flash (High)");
        assert_eq!(models[1].id, "claude-sonnet-4-6");
    }

    #[test]
    fn parse_copilot_models_reads_the_model_section_only() {
        let help = "  `logLevel`: log level\n\
                    \n\
                    \x20 `model`: AI model to use for Copilot CLI\n\
                    \x20   - \"claude-sonnet-5\"\n\
                    \x20   - \"gpt-5.5\"\n\
                    \n\
                    \x20 `contextTier`: context window tier\n\
                    \x20   - \"default\"\n";
        assert_eq!(
            parse_copilot_models(help),
            vec!["claude-sonnet-5", "gpt-5.5"]
        );
        assert!(parse_copilot_models("no model section").is_empty());
    }

    #[test]
    fn parse_codex_models_keeps_listed_models_in_priority_order() {
        let json = r#"{"models":[
            {"slug":"gpt-6-astra","display_name":"GPT-6-Astra","visibility":"list","priority":2,
             "supported_reasoning_levels":[{"effort":"low"},{"effort":"ultra"},{"effort":"bogus"}]},
            {"slug":"gpt-hidden","display_name":"Hidden","visibility":"hide","priority":0},
            {"slug":"gpt-6.1-sol","display_name":"GPT-6.1-Sol","visibility":"list","priority":1}
        ]}"#;
        let models = parse_codex_models(json);
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "gpt-6.1-sol");
        assert!(models[0].efforts.is_empty());
        assert_eq!(models[1].name, "GPT-6-Astra");
        assert_eq!(models[1].efforts, vec!["low", "ultra"]);
        assert!(parse_codex_models("not json").is_empty());
    }
}

#[cfg(test)]
mod env_isolation_tests {
    use super::*;
    use std::collections::HashMap;

    /// `ai_env_allowed` with no user config in play.
    fn allowed(cli: AiCli, key: &str) -> bool {
        ai_env_allowed(cli, key, &AiEnvContext::default())
    }

    /// A fresh, empty directory under the system temp dir.
    fn temp_dir(tag: &str) -> PathBuf {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static N: AtomicUsize = AtomicUsize::new(0);
        let d = std::env::temp_dir().join(format!(
            "gw-ai-env-{}-{}-{}",
            tag,
            std::process::id(),
            N.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn ctx_for(cli: AiCli, vars: &[(&str, String)]) -> AiEnvContext {
        let map: HashMap<String, String> = vars
            .iter()
            .map(|(k, v)| (k.to_string(), v.clone()))
            .collect();
        // No managed settings: the machine running the tests may have some.
        ai_env_context_with(cli, &|k| map.get(k).cloned(), &[])
    }

    #[test]
    fn claude_gets_its_own_config_families_but_never_the_api_key_overrides() {
        for k in [
            "ANTHROPIC_BASE_URL",
            "ANTHROPIC_VERTEX_PROJECT_ID",
            "ANTHROPIC_MODEL",
            "CLAUDE_CODE_USE_BEDROCK",
            "CLAUDE_CODE_USE_VERTEX",
            "CLAUDE_CODE_OAUTH_TOKEN",
        ] {
            assert!(allowed(AiCli::Claude, k), "{k} should pass");
        }
        for k in CLAUDE_AUTH_OVERRIDE_ENV {
            assert!(!allowed(AiCli::Claude, k), "{k} must stay stripped");
        }
        // Not whole families: unrelated secrets sharing the prefix stay out.
        for k in [
            "ANTHROPIC_ADMIN_KEY",
            "ANTHROPIC_FOUNDRY_API_KEY",
            "CLAUDE_CODE_DEPLOY_TOKEN",
            "ANTHROPIC_SOMETHING_SECRET",
        ] {
            assert!(!allowed(AiCli::Claude, k), "{k} leaked");
        }
        let foundry = AiEnvContext {
            claude_foundry: true,
            ..Default::default()
        };
        assert!(ai_env_allowed(
            AiCli::Claude,
            "ANTHROPIC_FOUNDRY_API_KEY",
            &foundry
        ));
    }

    #[test]
    fn cloud_credentials_reach_claude_only_when_it_is_set_up_for_that_cloud() {
        let bedrock = AiEnvContext {
            claude_bedrock: true,
            ..Default::default()
        };
        let vertex = AiEnvContext {
            claude_vertex: true,
            ..Default::default()
        };
        for k in [
            "AWS_PROFILE",
            "AWS_REGION",
            "AWS_ACCESS_KEY_ID",
            "AWS_SESSION_TOKEN",
        ] {
            assert!(ai_env_allowed(AiCli::Claude, k, &bedrock), "{k}");
            assert!(!ai_env_allowed(AiCli::Claude, k, &vertex), "{k}");
            assert!(!allowed(AiCli::Claude, k), "{k}");
        }
        for k in [
            "CLOUD_ML_REGION",
            "GOOGLE_APPLICATION_CREDENTIALS",
            "VERTEX_REGION_CLAUDE_4_0_OPUS",
        ] {
            assert!(ai_env_allowed(AiCli::Claude, k, &vertex), "{k}");
            assert!(!ai_env_allowed(AiCli::Claude, k, &bedrock), "{k}");
        }
        // Never to another CLI, whatever Claude's setup.
        assert!(!ai_env_allowed(AiCli::Codex, "AWS_ACCESS_KEY_ID", &bedrock));
        // Forge tokens stay out even for a Bedrock setup.
        assert!(!ai_env_allowed(AiCli::Claude, "GH_TOKEN", &bedrock));
    }

    #[test]
    fn claude_cloud_setup_is_read_from_env_or_user_settings_json() {
        assert!(ctx_for(AiCli::Claude, &[("CLAUDE_CODE_USE_BEDROCK", "1".into())]).claude_bedrock);
        assert!(!ctx_for(AiCli::Claude, &[("CLAUDE_CODE_USE_BEDROCK", "0".into())]).claude_bedrock);

        let dir = temp_dir("claude");
        std::fs::write(
            dir.join("settings.json"),
            r#"{"env":{"CLAUDE_CODE_USE_VERTEX":"1","AWS_PROFILE":"x"}}"#,
        )
        .unwrap();
        let ctx = ctx_for(
            AiCli::Claude,
            &[("CLAUDE_CONFIG_DIR", dir.to_string_lossy().into_owned())],
        );
        assert!(ctx.claude_vertex);
        assert!(!ctx.claude_bedrock);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn claude_cloud_setup_is_read_from_managed_settings_too() {
        let dir = temp_dir("claude-managed");
        let managed = dir.join("managed-settings.json");
        std::fs::write(&managed, r#"{"env":{"CLAUDE_CODE_USE_BEDROCK":"true"}}"#).unwrap();
        let dropin = dir.join("10-foundry.json");
        std::fs::write(&dropin, r#"{"env":{"CLAUDE_CODE_USE_FOUNDRY":1}}"#).unwrap();
        let ctx = ai_env_context_with(
            AiCli::Claude,
            &|k| (k == "HOME").then(|| dir.join("nohome").to_string_lossy().into_owned()),
            &[managed, dropin, dir.join("missing.json")],
        );
        assert!(ctx.claude_bedrock);
        assert!(ctx.claude_foundry);
        assert!(!ctx.claude_vertex);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn managed_settings_locations_are_system_paths() {
        for f in claude_managed_settings_files() {
            assert!(f.is_absolute(), "{}", f.display());
            assert!(
                f.to_string_lossy().contains("ClaudeCode")
                    || f.to_string_lossy().contains("claude-code"),
                "{}",
                f.display()
            );
        }
    }

    #[test]
    fn codex_custom_provider_env_key_is_forwarded() {
        let dir = temp_dir("codex");
        std::fs::write(
            dir.join("config.toml"),
            "model_provider = \"azure\"\n[model_providers.azure]\nname = \"Azure\"\nenv_key = \"MY_AZURE_KEY\" # comment\n[model_providers.bad]\nenv_key = \"$(rm -rf)\"\n",
        )
        .unwrap();
        let ctx = ctx_for(
            AiCli::Codex,
            &[("CODEX_HOME", dir.to_string_lossy().into_owned())],
        );
        assert_eq!(ctx.config_refs, vec!["MY_AZURE_KEY".to_string()]);
        assert!(ai_env_allowed(AiCli::Codex, "MY_AZURE_KEY", &ctx));
        assert!(allowed(AiCli::Codex, "AZURE_OPENAI_API_KEY"));
        assert!(!allowed(AiCli::Codex, "MY_AZURE_KEY"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn opencode_env_substitutions_from_user_config_are_forwarded() {
        let home = temp_dir("opencode");
        let cfg = home.join(".config").join("opencode");
        std::fs::create_dir_all(&cfg).unwrap();
        std::fs::write(
            cfg.join("opencode.json"),
            r#"{"provider":{"corp":{"options":{"apiKey":"{env:CORP_LLM_KEY}","baseURL":"{env:bad name}"}}}}"#,
        )
        .unwrap();
        let ctx = ctx_for(
            AiCli::Opencode,
            &[("HOME", home.to_string_lossy().into_owned())],
        );
        assert_eq!(ctx.config_refs, vec!["CORP_LLM_KEY".to_string()]);
        assert!(ai_env_allowed(AiCli::Opencode, "CORP_LLM_KEY", &ctx));
        assert!(!ai_env_allowed(
            AiCli::Claude,
            "CORP_LLM_KEY",
            &AiEnvContext::default()
        ));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn config_parsers_only_yield_env_names() {
        // Every TOML spelling of a provider's env_key: table, inline table,
        // dotted key, profile; plus env_http_headers values. `env_key_x` and
        // names that are not variable names are ignored.
        let toml = r#"
model_providers.dotted.env_key = "DOTTED_KEY"
model_providers.inline = { name = "x", env_key = "INLINE_KEY" }

[model_providers.table]
env_key = 'TABLE_KEY'
env_key_x = "NOT_ME"
env_http_headers = { "X-Org" = "ORG_HEADER_VAR" }

[profiles.p.model_providers.q]
env_key = "PROFILE_KEY"

[model_providers.bad]
env_key = "$(curl evil)"
"#;
        let mut keys = parse_codex_env_keys(toml);
        keys.sort();
        assert_eq!(
            keys,
            [
                "DOTTED_KEY",
                "INLINE_KEY",
                "ORG_HEADER_VAR",
                "PROFILE_KEY",
                "TABLE_KEY"
            ]
            .map(String::from)
        );
        assert!(parse_codex_env_keys("not = [valid toml").is_empty());
        assert_eq!(
            parse_opencode_env_refs("{env:X} {env:Y-Z} {env:"),
            vec!["X".to_string()]
        );
        assert_eq!(
            parse_claude_settings_flags("not json"),
            ClaudeCloud::default()
        );
        assert_eq!(
            parse_claude_settings_flags(r#"{"env":{"CLAUDE_CODE_USE_BEDROCK":true}}"#),
            ClaudeCloud {
                bedrock: true,
                ..Default::default()
            }
        );
    }

    #[test]
    fn base_allowlist_admits_home_locale_and_proxy() {
        for k in [
            "HOME",
            "LANG",
            "LC_ALL",
            "HTTPS_PROXY",
            "https_proxy",
            "NODE_EXTRA_CA_CERTS",
        ] {
            assert!(allowed(AiCli::Claude, k), "{k} should pass");
        }
        // Windows names are case-insensitive.
        assert!(allowed(AiCli::Codex, "SystemRoot"));
    }

    #[test]
    fn credentials_never_reach_any_cli() {
        let secrets = [
            "GH_TOKEN",
            "GITHUB_TOKEN",
            "GITLAB_TOKEN",
            "AWS_ACCESS_KEY_ID",
            "AWS_SECRET_ACCESS_KEY",
            "AZURE_CLIENT_SECRET",
            "AZURE_DEVOPS_EXT_PAT",
            "GOOGLE_APPLICATION_CREDENTIALS",
            "NPM_TOKEN",
        ];
        for cli in [
            AiCli::Claude,
            AiCli::Codex,
            AiCli::Opencode,
            AiCli::Copilot,
            AiCli::Antigravity,
        ] {
            for k in secrets {
                assert!(!allowed(cli, k), "{k} leaked to {cli:?}");
            }
        }
    }

    #[test]
    fn each_cli_gets_only_its_own_provider_auth() {
        assert!(allowed(AiCli::Codex, "OPENAI_API_KEY"));
        assert!(!allowed(AiCli::Claude, "OPENAI_API_KEY"));
        assert!(!allowed(AiCli::Claude, "ANTHROPIC_API_KEY"));
        assert!(allowed(AiCli::Antigravity, "GEMINI_API_KEY"));
        assert!(!allowed(AiCli::Codex, "GEMINI_API_KEY"));
        assert!(allowed(AiCli::Copilot, "COPILOT_GITHUB_TOKEN"));
        assert!(!allowed(AiCli::Copilot, "COPILOT_ALLOW_ALL"));
    }

    #[test]
    fn ai_cmd_drops_forge_tokens_set_by_hidden_cmd() {
        let cmd = ai_cmd("true", AiCli::Codex);
        let names: Vec<String> = cmd
            .get_envs()
            .filter(|(_, v)| v.is_some())
            .map(|(k, _)| k.to_string_lossy().into_owned())
            .collect();
        for t in FORGE_TOKEN_ENV {
            assert!(!names.iter().any(|n| n == t), "{t} forwarded");
        }
        assert!(
            names.iter().any(|n| n.eq_ignore_ascii_case("PATH")),
            "PATH missing"
        );
    }

    #[cfg(unix)]
    #[test]
    fn output_with_stdin_feeds_the_prompt_off_argv() {
        let mut cmd = std::process::Command::new("cat");
        cmd.env_clear()
            .env("PATH", std::env::var_os("PATH").unwrap_or_default());
        let out = output_with_stdin(cmd, "hello\nworld".to_string()).unwrap();
        assert!(out.status.success());
        assert_eq!(String::from_utf8_lossy(&out.stdout), "hello\nworld");
    }
}

#[cfg(test)]
mod lockdown_tests {
    use super::*;

    fn neutral() -> Result<PathBuf, String> {
        Ok(PathBuf::from("/neutral"))
    }

    const HELP_2_1: &str = "  --strict-mcp-config   Only use MCP servers from --mcp-config\n  \
        --setting-sources <sources>   Comma-separated list\n  \
        --tools <tools...>   Specify the list of available tools\n  \
        --allowedTools, --allowed-tools <tools...>\n";

    #[test]
    fn caps_are_read_from_help_by_exact_flag() {
        assert_eq!(
            parse_claude_caps(HELP_2_1),
            ClaudeCaps {
                tools: true,
                setting_sources: true,
                strict_mcp: true
            }
        );
        // `--allowedTools` / `--mcp-config` must not pass for `--tools` / strict.
        assert_eq!(
            parse_claude_caps("  --allowedTools <t>\n  --mcp-config <c>\n"),
            ClaudeCaps::default()
        );
    }

    #[test]
    fn a_current_cli_gets_no_tools_and_no_project_settings() {
        let caps = parse_claude_caps(HELP_2_1);
        let args = claude_lockdown_args(caps);
        let joined = args.join(" ");
        assert!(args.windows(2).any(|w| w == ["--tools", ""]), "{joined}");
        assert!(
            args.windows(2).any(|w| w == ["--setting-sources", "user"]),
            "{joined}"
        );
        assert!(args.contains(&"--strict-mcp-config"));
        // The deny list rides along, reads and MultiEdit included.
        for t in [
            "Read",
            "Glob",
            "Grep",
            "MultiEdit",
            "Bash",
            "WebFetch",
            "Task",
        ] {
            assert!(args.contains(&t), "{t} not denied");
        }
        // The repository may stay the cwd: its settings are not loaded.
        assert_eq!(
            claude_run_dir(caps, Some("/repo"), &neutral),
            Ok(Some(PathBuf::from("/repo")))
        );
    }

    #[test]
    fn an_old_cli_runs_outside_the_repository() {
        let caps = ClaudeCaps::default();
        let args = claude_lockdown_args(caps);
        assert!(!args.contains(&"--tools"));
        assert!(!args.contains(&"--setting-sources"));
        assert!(!args.contains(&"--strict-mcp-config"));
        assert!(args.contains(&"--disallowedTools") && args.contains(&"Read"));
        // Without --setting-sources the repo's hooks would load: neutral cwd.
        assert_eq!(
            claude_run_dir(caps, Some("/repo"), &neutral),
            Ok(Some(PathBuf::from("/neutral")))
        );
        // No neutral directory: refuse rather than fall back to the repo.
        assert!(claude_run_dir(caps, Some("/repo"), &|| Err("no".into())).is_err());
    }

    #[cfg(unix)]
    fn output(code: i32, stdout: &str, stderr: &str) -> std::process::Output {
        use std::os::unix::process::ExitStatusExt;
        std::process::Output {
            status: std::process::ExitStatus::from_raw(code << 8),
            stdout: stdout.as_bytes().to_vec(),
            stderr: stderr.as_bytes().to_vec(),
        }
    }

    #[cfg(unix)]
    #[test]
    fn opencode_empty_or_refused_prompt_is_an_error() {
        assert_eq!(
            opencode_result(&output(0, "feat: x\n", "")).unwrap(),
            "feat: x\n"
        );
        // An old opencode that ignored stdin: exit 0, nothing said.
        assert!(opencode_result(&output(0, "  \n", "")).is_err());
        let err =
            opencode_result(&output(1, "", "You must provide a message or a command")).unwrap_err();
        assert!(err.contains("stdin"), "{err}");
        assert_eq!(opencode_result(&output(2, "", "boom")).unwrap_err(), "boom");
        // Exit 0, empty answer, but a provider error on stderr: show that.
        assert_eq!(
            opencode_result(&output(0, "", "Error: rate limited\n")).unwrap_err(),
            "Error: rate limited"
        );
        assert_eq!(
            opencode_result(&output(3, "", "")).unwrap_err(),
            "opencode CLI a échoué sans message"
        );
    }
}

#[cfg(test)]
mod neutral_dir_tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("gw-neutral-{}-{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    #[cfg(unix)]
    #[test]
    fn neutral_dir_is_private_and_a_git_repository() {
        use std::os::unix::fs::PermissionsExt;
        let d = scratch("ok").join("ai-cwd");
        let got = prepare_neutral_dir(&d).unwrap();
        assert_eq!(got, d);
        let mode = std::fs::metadata(&d).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o700);
        assert!(d.join(".git").is_dir());
        // Idempotent, and tightens a directory left group/world-accessible.
        std::fs::set_permissions(&d, std::fs::Permissions::from_mode(0o777)).unwrap();
        prepare_neutral_dir(&d).unwrap();
        assert_eq!(
            std::fs::metadata(&d).unwrap().permissions().mode() & 0o777,
            0o700
        );
        let _ = std::fs::remove_dir_all(d.parent().unwrap());
    }

    #[cfg(unix)]
    #[test]
    fn neutral_dir_refuses_a_symlink() {
        let root = scratch("link");
        let target = root.join("elsewhere");
        std::fs::create_dir_all(&target).unwrap();
        let link = root.join("ai-cwd");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        assert!(prepare_neutral_dir(&link).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn neutral_dir_is_per_user_not_the_shared_temp_dir() {
        let d = ai_neutral_dir().unwrap();
        assert!(!d.starts_with("/tmp"), "{}", d.display());
        assert!(d.ends_with(std::path::Path::new("gitwand").join("ai-cwd")));
    }

    #[test]
    fn opencode_runs_in_the_given_dir_without_project_config() {
        let cmd = opencode_run_cmd("opencode", None, std::path::Path::new("/neutral"));
        assert_eq!(
            cmd.get_current_dir(),
            Some(std::path::Path::new("/neutral"))
        );
        let env: Vec<(String, String)> = cmd
            .get_envs()
            .filter_map(|(k, v)| {
                Some((
                    k.to_string_lossy().into_owned(),
                    v?.to_string_lossy().into_owned(),
                ))
            })
            .collect();
        assert!(env.contains(&(
            "OPENCODE_DISABLE_PROJECT_CONFIG".to_string(),
            "1".to_string()
        )));
    }

    #[cfg(unix)]
    #[test]
    fn stdout_within_returns_output_and_kills_on_timeout() {
        let mut ok = std::process::Command::new("sh");
        ok.args(["-c", "echo hello"]);
        assert_eq!(
            stdout_within(ok, std::time::Duration::from_secs(5)).as_deref(),
            Some("hello\n")
        );
        let mut slow = std::process::Command::new("sleep");
        slow.arg("5");
        let t = std::time::Instant::now();
        assert!(stdout_within(slow, std::time::Duration::from_millis(200)).is_none());
        assert!(t.elapsed() < std::time::Duration::from_secs(3));
        let mut fails = std::process::Command::new("sh");
        fails.args(["-c", "echo x; exit 1"]);
        assert!(stdout_within(fails, std::time::Duration::from_secs(5)).is_none());
    }

    #[test]
    fn claude_gets_its_platform_and_timeout_settings() {
        for k in [
            "CLAUDE_CODE_GIT_BASH_PATH",
            "API_TIMEOUT_MS",
            "CLAUDE_CODE_MAX_RETRIES",
            "ANTHROPIC_BETAS",
        ] {
            assert!(
                ai_env_allowed(AiCli::Claude, k, &AiEnvContext::default()),
                "{k}"
            );
        }
    }
}

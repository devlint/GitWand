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
    /// MCP servers the user's opencode config declares, disabled for
    /// GitWand's runs (`opencode_config_content`).
    opencode_mcp: Vec<String>,
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

/// JSON from JSONC (opencode accepts both): `//` and `/* */` comments and
/// trailing commas dropped, strings left as they are.
fn jsonc_to_json(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    let mut in_string = false;
    while let Some(c) = chars.next() {
        if in_string {
            out.push(c);
            if c == '\\' {
                if let Some(n) = chars.next() {
                    out.push(n);
                }
            } else if c == '"' {
                in_string = false;
            }
            continue;
        }
        match c {
            '"' => {
                in_string = true;
                out.push(c);
            }
            '/' if chars.peek() == Some(&'/') => {
                for n in chars.by_ref() {
                    if n == '\n' {
                        out.push('\n');
                        break;
                    }
                }
            }
            '/' if chars.peek() == Some(&'*') => {
                chars.next();
                let mut prev = ' ';
                for n in chars.by_ref() {
                    if prev == '*' && n == '/' {
                        break;
                    }
                    prev = n;
                }
            }
            _ => out.push(c),
        }
    }
    // Trailing commas: a `,` followed (after blanks) by `}` or `]`.
    let mut cleaned = String::with_capacity(out.len());
    let bytes: Vec<char> = out.chars().collect();
    let mut in_string = false;
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i];
        if in_string {
            cleaned.push(c);
            if c == '\\' && i + 1 < bytes.len() {
                cleaned.push(bytes[i + 1]);
                i += 2;
                continue;
            }
            if c == '"' {
                in_string = false;
            }
        } else if c == '"' {
            in_string = true;
            cleaned.push(c);
        } else if c == ',' {
            let next = bytes[i + 1..].iter().find(|n| !n.is_whitespace());
            if !matches!(next, Some('}') | Some(']')) {
                cleaned.push(c);
            }
        } else {
            cleaned.push(c);
        }
        i += 1;
    }
    cleaned
}

/// The MCP servers an opencode config (JSON or JSONC) declares under `mcp`.
fn opencode_mcp_names(text: &str) -> Vec<String> {
    serde_json::from_str::<serde_json::Value>(&jsonc_to_json(text))
        .ok()
        .and_then(|v| {
            v.get("mcp")?
                .as_object()
                .map(|o| o.keys().cloned().collect())
        })
        .unwrap_or_default()
}

/// `OPENCODE_CONFIG_CONTENT` for a GitWand run: the user's own inline config
/// (`inherited`, kept) with every MCP server it or the config files declare
/// (`names`) disabled. opencode merges it over the files (checked on 1.17.11:
/// a server so disabled is not even started).
fn opencode_config_content(inherited: Option<&str>, names: &[String]) -> String {
    let mut base = inherited
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&jsonc_to_json(t)).ok())
        .filter(|v| v.is_object())
        .unwrap_or_else(|| serde_json::json!({}));
    let mut all: Vec<String> = names.to_vec();
    if let Some(own) = base.get("mcp").and_then(|m| m.as_object()) {
        all.extend(own.keys().cloned());
    }
    all.sort();
    all.dedup();
    let obj = base.as_object_mut().expect("an object");
    // No tool at all (MCP ones included): GitWand wants a text answer.
    // opencode takes `"*"` as a glob over tool names.
    let tools = obj.entry("tools").or_insert_with(|| serde_json::json!({}));
    if !tools.is_object() {
        *tools = serde_json::json!({});
    }
    tools
        .as_object_mut()
        .expect("an object")
        .insert("*".to_string(), serde_json::Value::Bool(false));
    let mcp = obj.entry("mcp").or_insert_with(|| serde_json::json!({}));
    if !mcp.is_object() {
        *mcp = serde_json::json!({});
    }
    let mcp = mcp.as_object_mut().expect("an object");
    for name in all {
        let entry = mcp.entry(name).or_insert_with(|| serde_json::json!({}));
        if !entry.is_object() {
            *entry = serde_json::json!({});
        }
        entry
            .as_object_mut()
            .expect("an object")
            .insert("enabled".to_string(), serde_json::Value::Bool(false));
    }
    base.to_string()
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
                    ctx.opencode_mcp.extend(opencode_mcp_names(&text));
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
        claude_cli_prompt_inner(prompt, system_prompt, output_format, model, effort)
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
    /// `--no-session-persistence` — no transcript written for the run.
    no_session_persistence: bool,
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
        no_session_persistence: has("--no-session-persistence"),
    }
}

/// Run `cmd` (stdin closed, stderr dropped) and return its stdout when it
/// exits successfully within `timeout`; `None` on failure or timeout.
///
/// On timeout the whole process tree is killed, not just the direct child: a
/// wrapper (`claude.cmd` → `cmd.exe` → `node` on Windows, a shell script that
/// does not `exec` on Unix) leaves a grandchild holding stdout open, and
/// waiting for EOF would then hang the generation. On Unix the child leads
/// its own process group, killed as a whole; on Windows `taskkill /T /F`
/// kills the tree. The reader thread is never waited on past a short grace
/// period either: if something still holds the pipe, it is left behind.
fn stdout_within(cmd: std::process::Command, timeout: std::time::Duration) -> Option<String> {
    output_within(cmd, timeout, false)
}

/// `stdout_within`, with stderr read into the same text when `with_stderr`
/// (a CLI printing its `--help` there, like agy).
fn output_within(
    mut cmd: std::process::Command,
    timeout: std::time::Duration,
    with_stderr: bool,
) -> Option<String> {
    use std::io::Read;
    use std::process::Stdio;
    use std::time::{Duration, Instant};
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(if with_stderr {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .spawn()
        .ok()?;
    // Windows: a kill-on-close Job Object holds the child and everything it
    // starts from now on. Closing it (end of this function) kills a
    // grandchild that outlived the child, which `taskkill /T` cannot find
    // once the child has exited. A process started in the instant before the
    // assignment escapes it; std cannot spawn suspended.
    #[cfg(windows)]
    let job = crate::commands::terminal::job::Job::assign(child.id()).ok();
    // Read incrementally into a shared buffer, so what arrived is usable even
    // if EOF never comes (a grandchild still holding the pipe).
    let collected = std::sync::Arc::new(std::sync::Mutex::new(Vec::<u8>::new()));
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    let mut readers = 0;
    let mut spawn_reader = |mut pipe: Box<dyn Read + Send>| {
        let collected = collected.clone();
        let tx = tx.clone();
        readers += 1;
        std::thread::spawn(move || {
            let mut chunk = [0u8; 8192];
            while let Ok(n) = pipe.read(&mut chunk) {
                if n == 0 {
                    break;
                }
                if let Ok(mut c) = collected.lock() {
                    c.extend_from_slice(&chunk[..n]);
                }
            }
            let _ = tx.send(());
        });
    };
    spawn_reader(Box::new(child.stdout.take()?));
    if let Some(err) = child.stderr.take() {
        spawn_reader(Box::new(err));
    }
    drop(tx);
    // Every reader at EOF within `wait` (counting those already done).
    let mut finished = 0;
    let mut all_done = |wait: Duration| {
        let until = Instant::now() + wait;
        while finished < readers {
            if rx
                .recv_timeout(until.saturating_duration_since(Instant::now()))
                .is_err()
            {
                return false;
            }
            finished += 1;
        }
        true
    };
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break Some(st),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                kill_tree(&mut child);
                break None;
            }
        }
    };
    // Exited (or killed). Its stdout reaches EOF unless a grandchild still
    // holds it: then kill what is left of the group too — whatever the exit
    // status, so no helper leaks — and keep the output already received. The
    // reader thread is never joined: at worst it is left behind, blocked.
    if !all_done(Duration::from_secs(2)) {
        // Only while the group still has members: its id cannot have been
        // reused then. On Windows the child is reaped by now and its pid may
        // be reused, so taskkill is not retried (see kill_tree).
        #[cfg(unix)]
        if let Ok(pgid) = libc::pid_t::try_from(child.id()) {
            // SAFETY: plain syscalls; signal 0 only probes the group.
            unsafe {
                if libc::killpg(pgid, 0) == 0 {
                    libc::killpg(pgid, libc::SIGKILL);
                }
            }
        }
        // The job still holds the grandchild: end it, the pipe closes.
        #[cfg(windows)]
        if let Some(job) = job.as_ref() {
            job.terminate();
        }
        let _ = all_done(Duration::from_secs(1));
    }
    // A `--help` read with stderr is wanted whatever the exit status (some
    // CLIs exit non-zero after printing it); other reads only on success.
    // A run killed at the timeout gives nothing either way.
    let status = status?;
    if !with_stderr && !status.success() {
        return None;
    }
    let buf = collected.lock().ok()?.clone();
    (!buf.is_empty()).then(|| String::from_utf8_lossy(&buf).into_owned())
}

/// `flag` as a whole option name in `help`: `--mode` is not found in
/// `--model`, nor in `--modes`.
fn help_has_flag(help: &str, flag: &str) -> bool {
    let is_name = |c: char| c.is_ascii_alphanumeric() || c == '-' || c == '_';
    help.match_indices(flag).any(|(i, _)| {
        let before = help[..i].chars().next_back();
        let after = help[i + flag.len()..].chars().next();
        !before.is_some_and(is_name) && !after.is_some_and(is_name)
    })
}

/// Whether `binary <help_args>` (stdout or stderr, 10 s at most) mentions every
/// flag of `flags`: the options a lockdown relies on. Cached per binary
/// identity (path, size, mtime), so `agy update` / `copilot update` in place
/// is seen at once. `None` when the probe itself failed or timed out (not
/// cached): the caller says so rather than ask for an update.
fn help_mentions(binary: &str, cli: AiCli, help_args: &[&str], flags: &[&str]) -> Option<bool> {
    use std::sync::Mutex;
    type Key = ((String, u64, Option<std::time::SystemTime>), String);
    static SEEN: Mutex<Vec<(Key, bool)>> = Mutex::new(Vec::new());
    let key: Key = (
        binary_identity(binary),
        format!("{} | {}", help_args.join(" "), flags.join(" ")),
    );
    if let Some((_, ok)) = SEEN
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .iter()
        .find(|(k, _)| *k == key)
    {
        return Some(*ok);
    }
    let mut cmd = ai_cmd(binary, cli);
    cmd.args(help_args);
    // No answer: `None`, not cached.
    let help = output_within(cmd, std::time::Duration::from_secs(10), true)?;
    let ok = flags.iter().all(|f| help_has_flag(&help, f));
    SEEN.lock()
        .unwrap_or_else(|p| p.into_inner())
        .push((key, ok));
    Some(ok)
}

/// `Ok` when `binary <help_args>` lists every flag a lockdown needs;
/// `too_old` when it does not; a distinct error when the probe could not run
/// (a slow start, a busy machine), which a retry may fix.
fn require_lockdown_flags(
    binary: &str,
    cli: AiCli,
    help_args: &[&str],
    flags: &[&str],
    too_old: &str,
) -> Result<(), String> {
    match help_mentions(binary, cli, help_args, flags) {
        Some(true) => Ok(()),
        Some(false) => Err(too_old.to_string()),
        None => Err(format!(
            "Could not check the AI CLI's options (`{} {}` did not answer within 10 s): try again",
            std::path::Path::new(binary)
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| binary.to_string()),
            help_args.join(" ")
        )),
    }
}

/// Kill `child` and everything it started (see `stdout_within`).
fn kill_tree(child: &mut std::process::Child) {
    #[cfg(unix)]
    {
        // The child leads its own group (`process_group(0)`): its pid is the
        // group id. SAFETY: plain syscall on a pid we own; no memory involved.
        if let Ok(pgid) = libc::pid_t::try_from(child.id()) {
            unsafe {
                libc::killpg(pgid, libc::SIGKILL);
            }
        }
    }
    // Windows: `taskkill /T` walks the tree from the child, so it only reaches
    // the grandchildren while the child is still alive (the timeout path).
    // Once the child has exited, `stdout_within`'s Job Object ends what is
    // left (see there).
    #[cfg(windows)]
    {
        let _ = hidden_cmd("taskkill")
            .args(["/T", "/F", "/PID", &child.id().to_string()])
            .output();
    }
    let _ = child.kill();
    let _ = child.wait();
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
/// identity. A failed, timed-out or empty probe is cached as a failure for
/// 5 minutes only: retried later rather than kept on the most restrictive
/// guess forever, without costing 10 s on every generation meanwhile.
fn claude_caps(binary: &str) -> ClaudeCaps {
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};
    use std::time::{Duration, Instant};
    const RETRY_FAILED_AFTER: Duration = Duration::from_secs(5 * 60);
    type Key = (String, u64, Option<std::time::SystemTime>);
    #[derive(Clone, Copy)]
    enum Probe {
        Known(ClaudeCaps),
        Failed(Instant),
    }
    static CACHE: OnceLock<Mutex<HashMap<Key, Probe>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let key = binary_identity(binary);
    match cache.lock().ok().and_then(|m| m.get(&key).copied()) {
        Some(Probe::Known(c)) => return c,
        Some(Probe::Failed(at)) if at.elapsed() < RETRY_FAILED_AFTER => {
            return ClaudeCaps::default()
        }
        _ => {}
    }
    let mut cmd = ai_cmd(binary, AiCli::Claude);
    cmd.arg("--help");
    let probe = match stdout_within(cmd, Duration::from_secs(10)) {
        Some(help) if !help.trim().is_empty() => Probe::Known(parse_claude_caps(&help)),
        _ => Probe::Failed(Instant::now()),
    };
    if let Ok(mut m) = cache.lock() {
        m.insert(key, probe);
    }
    match probe {
        Probe::Known(c) => c,
        Probe::Failed(_) => ClaudeCaps::default(),
    }
}
/// Base of the private working directories: the user's own cache directory
/// (`~/Library/Caches`, `$XDG_CACHE_HOME` if absolute else `~/.cache`,
/// `%LOCALAPPDATA%`), the home directory failing that — never the shared
/// system temp dir: on Linux `/tmp` is world-writable, and another local user
/// could plant a `.claude/settings.json`, `opencode.json` or
/// `.codex/config.toml` there.
fn neutral_dir_base() -> Option<PathBuf> {
    dirs::cache_dir().or_else(dirs::home_dir)
}

/// Stale-run cutoff for the sweep done when the base is (re)prepared — not
/// before each run, so a run in progress is never swept by its own process.
/// Generous, because another GitWand process starting up sweeps too and has
/// no way to know which runs are still live.
const STALE_RUN_AGE: std::time::Duration = std::time::Duration::from_secs(24 * 60 * 60);

/// Where the per-run directories are created. Prepared once per process
/// (see `prepare_runs_base`), stale leftovers swept then; prepared again if
/// it has disappeared since (a cache cleaner). A failure is not remembered:
/// the next run tries again. Unit tests use a per-process directory under the
/// temp dir, so they neither touch the real cache nor collide with another
/// user's or process's test run.
fn ai_runs_base() -> Result<PathBuf, String> {
    use std::sync::Mutex;
    static BASE: Mutex<Option<PathBuf>> = Mutex::new(None);
    #[cfg(not(test))]
    let root = neutral_dir_base();
    #[cfg(test)]
    let root =
        Some(std::env::temp_dir().join(format!("gitwand-test-cache-{}", std::process::id())));
    ai_runs_base_in(&BASE, root)
}

/// `ai_runs_base` with its cache and root given explicitly.
fn ai_runs_base_in(
    cache: &std::sync::Mutex<Option<PathBuf>>,
    root: Option<PathBuf>,
) -> Result<PathBuf, String> {
    let mut cached = cache.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(b) = cached.as_ref() {
        if b.is_dir() {
            return Ok(b.clone());
        }
    }
    let root = root.ok_or_else(|| "No per-user directory to run the AI CLI in".to_string())?;
    let base = prepare_runs_base(&root.join("gitwand").join("ai-runs"))?;
    sweep_stale_run_dirs(&base, STALE_RUN_AGE);
    *cached = Some(base.clone());
    Ok(base)
}
/// Create the base if needed and require it to be a real directory (not a
/// symlink) owned by the current user — hard requirements. Its mode is set to
/// 0700; on a filesystem that ignores Unix modes (NFS/SMB, exFAT) that may not
/// stick, and the setup then goes on with a single warning: the base still
/// belongs to the user inside their own cache directory, and what runs there
/// is a fresh directory per run, created 0700 and removed afterwards, so
/// nothing a run leaves behind is ever picked up by another (see `AiRunDir`).
fn prepare_runs_base(dir: &std::path::Path) -> Result<PathBuf, String> {
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
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        // SAFETY: getuid has no preconditions and cannot fail.
        let uid = unsafe { libc::getuid() };
        if meta.uid() != uid {
            return Err(fail("belongs to another user", &meta.uid()));
        }
        if let Err(e) = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700)) {
            eprintln!("[ai] cannot restrict {}: {}", dir.display(), e);
        }
        let mode = std::fs::symlink_metadata(dir)
            .map(|m| m.permissions().mode())
            .unwrap_or(0o777);
        if mode & 0o077 != 0 {
            eprintln!(
                "[ai] {} keeps mode {:o} (filesystem ignores Unix modes?); per-run directories still apply",
                dir.display(),
                mode & 0o777
            );
        }
    }
    Ok(dir.to_path_buf())
}

/// A fresh, private, empty working directory for one AI CLI run, removed when
/// dropped (on success, error or timeout alike).
///
/// Every run gets its own: a prompt-injected run could otherwise leave a
/// `.opencode/plugin/x.js`, `.claude/settings.json` or `.codex/config.toml`
/// behind for the next run of another CLI to load. Created exclusively with
/// mode 0700 under `ai_runs_base`, with a random name — creation fails on any
/// existing entry, symlinks included. Made an empty git repository when the
/// CLI insists on one (`codex exec`); nobody trusted it, so Codex loads no
/// project config from it.
pub(crate) struct AiRunDir {
    path: PathBuf,
}

impl AiRunDir {
    fn create(base: &std::path::Path, git_repo: bool) -> Result<AiRunDir, String> {
        let path = base.join(format!("run-{}", random_token()));
        let mut builder = std::fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(&path).map_err(|e| {
            format!(
                "AI working directory {}: cannot create ({})",
                path.display(),
                e
            )
        })?;
        let dir = AiRunDir { path };
        if git_repo {
            let ok = git_cmd()
                .args(["init", "-q"])
                .current_dir(&dir.path)
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false);
            if !ok {
                return Err(format!(
                    "AI working directory {}: git init failed",
                    dir.path.display()
                ));
            }
        }
        Ok(dir)
    }

    fn path(&self) -> &std::path::Path {
        &self.path
    }
}

impl Drop for AiRunDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

/// An unpredictable name component: OS-seeded hasher keys, the time and a
/// counter. Unpredictability is a bonus — creation is exclusive anyway.
fn random_token() -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let mut h = RandomState::new().build_hasher();
    h.write_u64(COUNTER.fetch_add(1, Ordering::Relaxed));
    h.write_u128(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0),
    );
    h.write_u32(std::process::id());
    format!("{:016x}{:08x}", h.finish(), std::process::id())
}

/// Past this age a run directory is swept even when a process with its
/// owner's pid is alive: that pid has been reused.
const OWNED_RUN_MAX_AGE: std::time::Duration = std::time::Duration::from_secs(7 * 24 * 60 * 60);

/// The pid a run directory's name ends with (`run-<16 hex><8 hex pid>`, see
/// `random_token`), or `None` for any other name.
fn run_dir_owner_pid(name: &str) -> Option<u32> {
    let token = name.strip_prefix("run-")?;
    if token.len() != 24 || !token.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    u32::from_str_radix(&token[16..], 16).ok()
}

/// True when a process with this pid exists. A reused pid keeps a stale
/// directory a while longer, which is harmless; a live run is never removed.
#[cfg(unix)]
fn process_alive(pid: u32) -> bool {
    let Ok(pid) = libc::pid_t::try_from(pid) else {
        return false;
    };
    if pid <= 0 {
        return false;
    }
    // SAFETY: signal 0 only checks the pid exists. EPERM is a live process.
    let probed = unsafe { libc::kill(pid, 0) };
    probed == 0 || std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
}

#[cfg(windows)]
fn process_alive(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    const STILL_ACTIVE: u32 = 259;
    // SAFETY: plain Win32 calls; the handle is closed before returning.
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            // Access denied still means the process exists.
            return std::io::Error::last_os_error().raw_os_error() == Some(5);
        }
        let mut code: u32 = 0;
        let ok = GetExitCodeProcess(handle, &mut code) != 0;
        CloseHandle(handle);
        !ok || code == STILL_ACTIVE
    }
}

/// Remove `run-*` directories older than `max_age` — leftovers of a run whose
/// process was killed before its `AiRunDir` was dropped. Called when the base
/// is prepared (`ai_runs_base`). Symlinks are removed as links, never followed.
/// A directory whose owner process (the pid in its name) is still alive is
/// kept whatever its age: another GitWand process may have a run in it that
/// has lasted longer than `max_age`.
fn sweep_stale_run_dirs(base: &std::path::Path, max_age: std::time::Duration) {
    let Ok(entries) = std::fs::read_dir(base) else {
        return;
    };
    for e in entries.flatten() {
        if !e.file_name().to_string_lossy().starts_with("run-") {
            continue;
        }
        let Ok(meta) = std::fs::symlink_metadata(e.path()) else {
            continue;
        };
        let old = meta
            .modified()
            .ok()
            .and_then(|m| m.elapsed().ok())
            .is_some_and(|age| age > max_age);
        if !old {
            continue;
        }
        let name = e.file_name().to_string_lossy().into_owned();
        // A live owner keeps it, up to `OWNED_RUN_MAX_AGE`: past that, the pid
        // has been reused (a reboot) rather than a run lasting a week.
        let young = meta
            .modified()
            .ok()
            .and_then(|m| m.elapsed().ok())
            .is_some_and(|age| age < OWNED_RUN_MAX_AGE);
        if young && run_dir_owner_pid(&name).is_some_and(process_alive) {
            continue;
        }
        if meta.file_type().is_dir() {
            let _ = std::fs::remove_dir_all(e.path());
        } else {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

/// `ai_cmd` for a prompt run, in the given working directory.
fn ai_prompt_cmd_in(binary: &str, cli: AiCli, dir: &std::path::Path) -> std::process::Command {
    let mut cmd = ai_cmd(binary, cli);
    cmd.current_dir(dir);
    cmd
}

/// `ai_cmd` for a prompt run: every AI CLI runs in a fresh private directory
/// of its own (`AiRunDir`), never in the repository. The CLIs load
/// configuration from their working directory — project hooks for Claude,
/// `opencode.json` MCP servers and `.opencode/plugin/*` for opencode, a
/// trusted project's `.codex/config.toml` MCP servers for Codex, all verified
/// live to run a repository's commands — and the prompt already carries the
/// content they need. Keep the returned `AiRunDir` alive until the process has
/// exited; dropping it removes the directory. Fails rather than fall back to
/// the repository.
fn ai_prompt_cmd(binary: &str, cli: AiCli) -> Result<(std::process::Command, AiRunDir), String> {
    let run = AiRunDir::create(&ai_runs_base()?, cli == AiCli::Codex)?;
    Ok((ai_prompt_cmd_in(binary, cli, run.path()), run))
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
/// - `--no-session-persistence`: no transcript under `~/.claude/projects` —
///   every run has a fresh working directory, so each would otherwise leave a
///   session file (holding the prompt, i.e. repository content) in a project
///   folder of its own. Verified on 2.1.296: the transcript is gone; an empty
///   project folder is still created per run.
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
    if caps.no_session_persistence {
        args.push("--no-session-persistence");
    }
    args.push("--disallowedTools");
    args.extend(CLAUDE_DENIED_TOOLS);
    args
}

fn claude_cli_prompt_inner(
    prompt: String,
    system_prompt: Option<String>,
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

    // `_run_dir` lives until the end of the function: the CLI has exited.
    let (mut cmd, _run_dir) = ai_prompt_cmd(&binary, AiCli::Claude)?;
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
    model: Option<String>,
    effort: Option<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        codex_cli_prompt_inner(prompt, system_prompt, model, effort)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn codex_cli_prompt_inner(
    prompt: String,
    system_prompt: Option<String>,
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

    // `--ignore-user-config` (below) is what keeps the user's MCP servers
    // out: a Codex without it is refused rather than run without it.
    require_lockdown_flags(
        &binary,
        AiCli::Codex,
        &["exec", "--help"],
        &["--ignore-user-config"],
        "This Codex CLI cannot run without your config.toml: update it (`npm i -g @openai/codex` or your package manager)",
    )?;

    // `_run_dir` lives until the end of the function: the CLI has exited.
    let (mut cmd, _run_dir) = ai_prompt_cmd(&binary, AiCli::Codex)?;
    cmd.arg("exec");
    // GitWand only wants a text answer, and the prompt carries untrusted repo
    // content: pin the sandbox to read-only (no writes, no network) whatever
    // the user's own Codex config says.
    cmd.args(["--sandbox", "read-only"]);
    // No user config: its MCP servers and plugins would be callable by a
    // prompt-injected diff, and `-c mcp_servers.X.enabled=false` cannot
    // reach the servers the ChatGPT app adds (checked on codex-cli 0.147).
    // Auth still comes from CODEX_HOME; a custom provider or profile in
    // config.toml no longer applies to GitWand's calls.
    cmd.arg("--ignore-user-config");
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
    // Runs in a fresh private directory (ai_prompt_cmd): a trusted project's
    // `.codex/config.toml` MCP servers ran from the repository, verified live
    // on codex-cli 0.147. `-c mcp_servers={}` does not remove them (it merges).

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

/// Deadline for a model-listing command. The Settings picker gives up after
/// 30 s; ending the child a little earlier means it never outlives the
/// question it was answering.
const MODEL_LIST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(25);

/// Stdout of a model-listing command that succeeded within
/// `MODEL_LIST_TIMEOUT`, `None` otherwise ("no list" for the callers). On
/// expiry the whole process tree is killed (`stdout_within`): an npm-installed
/// CLI is a node shim, `copilot.cmd` runs cmd.exe then node.
fn list_models_output(binary: &str, cli: AiCli, args: &[&str]) -> Option<String> {
    let mut cmd = ai_cmd(binary, cli);
    cmd.args(args);
    stdout_within(cmd, MODEL_LIST_TIMEOUT)
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

    let Some(stdout) = list_models_output(&binary, AiCli::Antigravity, &["models"]) else {
        return Ok(Vec::new());
    };

    Ok(parse_antigravity_models(&stdout))
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

    let Some(stdout) = list_models_output(&binary, AiCli::Codex, &["debug", "models"]) else {
        return Ok(Vec::new());
    };

    Ok(parse_codex_models(&stdout))
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
///
/// The prompt holds repository content: it goes on stdin, as one
/// `stream-json` turn, never on the argv where any local user can read it.
/// The run is in `plan` mode: a headless run cannot ask, so `agy` denies
/// terminal commands, file edits and URL fetches there, where its default
/// (Auto) mode would run a command a prompt-injected diff asked for.
#[tauri::command]
pub(crate) async fn antigravity_cli_prompt(
    prompt: String,
    system_prompt: Option<String>,
    model: Option<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        antigravity_cli_prompt_inner(prompt, system_prompt, model)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// `agy` arguments for a headless prompt read from stdin, in plan mode.
fn antigravity_prompt_args(model: Option<&str>) -> Vec<String> {
    let mut args: Vec<String> = [
        "--mode",
        "plan",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    if let Some(m) = model.map(str::trim).filter(|m| !m.is_empty()) {
        args.push("--model".to_string());
        args.push(m.to_string());
    }
    // An empty `-p` value: the turn comes from stdin. Last, so `-p` never
    // takes a flag as its prompt.
    args.push("-p=".to_string());
    args
}

/// The single `stream-json` turn `agy` reads from stdin.
fn antigravity_stream_input(prompt: &str) -> String {
    format!(
        "{}\n",
        serde_json::json!({ "event": "user", "message": { "content": prompt } })
    )
}

/// The answer in `agy`'s `stream-json` output: its `result` event.
fn antigravity_stream_result(stdout: &str) -> Result<String, String> {
    let result = stdout
        .lines()
        .filter_map(|l| serde_json::from_str::<serde_json::Value>(l.trim()).ok())
        .rfind(|v| v["event"] == "result")
        .ok_or_else(|| "Antigravity CLI gave no result".to_string())?;
    let r = &result["result"];
    if r["status"] == "SUCCESS" {
        return Ok(r["response"].as_str().unwrap_or_default().to_string());
    }
    Err(r["error"]
        .as_str()
        .filter(|e| !e.is_empty())
        .unwrap_or("Antigravity CLI failed")
        .to_string())
}

fn antigravity_cli_prompt_inner(
    prompt: String,
    system_prompt: Option<String>,
    model: Option<String>,
) -> Result<String, String> {
    let binary =
        resolve_antigravity_binary().ok_or_else(|| "Binaire `agy` introuvable".to_string())?;
    require_lockdown_flags(
        &binary,
        AiCli::Antigravity,
        &["--help"],
        &["--input-format", "--mode"],
        "This Antigravity CLI cannot read a prompt from stdin nor run in plan mode: update it with `agy update`",
    )?;

    let full_prompt = match system_prompt {
        Some(sys) if !sys.trim().is_empty() => {
            format!("# System\n{}\n\n# User\n{}", sys.trim(), prompt.trim())
        }
        _ => prompt,
    };

    // `_run_dir` lives until the end of the function: the CLI has exited.
    let (mut cmd, _run_dir) = ai_prompt_cmd(&binary, AiCli::Antigravity)?;
    cmd.args(antigravity_prompt_args(model.as_deref()));

    let output = output_with_stdin(cmd, antigravity_stream_input(&full_prompt))
        .map_err(|e| format!("Failed to run antigravity CLI: {}", e))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    if output.status.success() {
        return antigravity_stream_result(&stdout);
    }
    // A failed run: the result event's error first, then stderr.
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(antigravity_stream_result(&stdout)
        .err()
        .filter(|e| e != "Antigravity CLI gave no result")
        .or_else(|| (!stderr.is_empty()).then_some(stderr))
        .unwrap_or_else(|| "Antigravity CLI a échoué sans message".to_string()))
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
    model: Option<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        opencode_cli_prompt_inner(prompt, system_prompt, model)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn opencode_cli_prompt_inner(
    prompt: String,
    system_prompt: Option<String>,
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
    // Runs in a fresh private directory: a repository's `opencode.json` MCP
    // server and `.opencode/plugin/*` both ran on "generate", verified live on
    // opencode 1.17.11. OPENCODE_DISABLE_PROJECT_CONFIG stops the former but
    // not the plugin.
    let run_dir = AiRunDir::create(&ai_runs_base()?, false)?;
    let output = output_with_stdin(
        opencode_run_cmd(&binary, model.as_ref(), run_dir.path()),
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
    if !output.status.success() {
        let detail = if stderr.is_empty() {
            stdout.trim().to_string()
        } else {
            stderr
        };
        return Err(if detail.is_empty() {
            "opencode CLI a échoué sans message".to_string()
        } else {
            detail
        });
    }
    // Exit 0 with an empty answer. A provider, auth or quota error on stderr
    // is the message to show; log or update lines are not, and the stdin
    // hint stays — with the end of stderr, in case it helps.
    if stderr_looks_like_error(&stderr) {
        return Err(stderr);
    }
    let tail: Vec<&str> = stderr.lines().rev().take(5).collect();
    Err(if tail.is_empty() {
        STDIN_HINT.to_string()
    } else {
        let tail: Vec<&str> = tail.into_iter().rev().collect();
        format!("{}\n{}", STDIN_HINT, tail.join("\n"))
    })
}

/// Whether CLI stderr reads like an error report rather than log noise,
/// judged line by line once ANSI colour codes are stripped:
///
/// - an `ERROR` / `FATAL` level token (whole word, in capitals);
/// - a word ending in `Error:` / `error:` (`Error: …`, `ProviderAuthError: …`);
/// - an HTTP auth / quota / server status: `HTTP/1.1 429`, or 401/403/429/5xx
///   right after `status`, `http` or `code` (`status=401`);
/// - a JSON error object, `"name":"…Error"`;
/// - a few unambiguous phrases (permission denied, rate limit, …).
///
/// A lowercase `error` inside a word (`error-reporter`) or without a colon
/// (`Error reporting enabled`) is not enough; when unsure the caller shows the
/// stdin hint with the stderr tail.
fn stderr_looks_like_error(stderr: &str) -> bool {
    const STATUS: &[&str] = &["401", "403", "429", "500", "502", "503", "504"];
    const PHRASES: &[&str] = &[
        "permission denied",
        "unauthorized",
        "forbidden",
        "rate limit",
        "rate-limited",
        "quota exceeded",
        "insufficient_quota",
        "invalid api key",
        "invalid_api_key",
        "authentication failed",
    ];
    let is_error_status = |t: &str| {
        t.len() == 3
            && (t.starts_with('4') || t.starts_with('5'))
            && t.bytes().all(|b| b.is_ascii_digit())
    };
    strip_ansi(stderr).lines().any(|line| {
        let tokens: Vec<&str> = line
            .split(|c: char| !c.is_ascii_alphanumeric() && c != '_')
            .filter(|t| !t.is_empty())
            .collect();
        let words: Vec<&str> = line.split_whitespace().collect();
        let lower = line.to_ascii_lowercase();
        tokens.iter().any(|t| matches!(*t, "ERROR" | "FATAL"))
            // Lowercase `error …` at line start (`error sending request …`);
            // the capitalised prose `Error reporting enabled` is not one.
            || line.trim_start().starts_with("error ")
            || words
                .iter()
                .any(|w| w.ends_with("Error:") || w.ends_with("error:"))
            || words
                .windows(2)
                .any(|w| w[0].starts_with("HTTP/") && is_error_status(w[1]))
            || tokens.windows(2).any(|w| {
                matches!(
                    w[0].to_ascii_lowercase().as_str(),
                    "status" | "http" | "code"
                ) && STATUS.contains(&w[1])
            })
            || json_error_name(line)
            || PHRASES.iter().any(|p| lower.contains(p))
    })
}

/// `"name": "…Error"` somewhere in `line` (a serialised error object).
fn json_error_name(line: &str) -> bool {
    line.match_indices("\"name\"").any(|(i, m)| {
        let rest = line[i + m.len()..].trim_start();
        let Some(rest) = rest.strip_prefix(':') else {
            return false;
        };
        let Some(rest) = rest.trim_start().strip_prefix('"') else {
            return false;
        };
        rest.split('"').next().is_some_and(|v| v.ends_with("Error"))
    })
}

/// `s` without ANSI escape sequences (CSI `ESC [ … final`, and lone `ESC x`).
fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        if chars.peek() == Some(&'[') {
            chars.next();
            for c in chars.by_ref() {
                if ('\u{40}'..='\u{7e}').contains(&c) {
                    break;
                }
            }
        } else {
            chars.next();
        }
    }
    out
}
/// `opencode run`, locked down; the prompt goes on stdin.
fn opencode_run_cmd(
    binary: &str,
    model: Option<&String>,
    run_dir: &std::path::Path,
) -> std::process::Command {
    let mut cmd = ai_prompt_cmd_in(binary, AiCli::Opencode, run_dir);
    cmd.arg("run");
    // GitWand only wants a text answer, and the prompt carries untrusted repo
    // content: deny the tools that act on the machine or reach the network.
    // `OPENCODE_PERMISSION` is merged over the user's config by opencode; set
    // after `ai_cmd`, so an inherited value cannot loosen it.
    cmd.env(
        "OPENCODE_PERMISSION",
        r#"{"edit":"deny","bash":"deny","webfetch":"deny"}"#,
    );
    // Belt and braces with the per-run directory (see opencode_cli_prompt_inner).
    cmd.env("OPENCODE_DISABLE_PROJECT_CONFIG", "1");
    // The user's MCP servers would be callable by a prompt-injected diff:
    // disabled by name, over their own inline config if they have one. The
    // names come from opencode's resolved config (every source it reads:
    // OPENCODE_CONFIG_DIR, a remote config…) and from the files GitWand
    // reads itself.
    let ctx = cached_ai_env_context(AiCli::Opencode);
    let inherited = std::env::var("OPENCODE_CONFIG_CONTENT").ok();
    let mut names = ctx.opencode_mcp.clone();
    names.extend(opencode_resolved_mcp_names(binary, run_dir));
    cmd.env(
        "OPENCODE_CONFIG_CONTENT",
        opencode_config_content(inherited.as_deref(), &names),
    );
    // Model is `provider/model` form; flags precede the positional message.
    if let Some(m) = model {
        if !m.trim().is_empty() {
            cmd.args(["--model", m.trim()]);
        }
    }
    cmd
}

/// The MCP servers in opencode's resolved config (`opencode debug config`,
/// 15 s at most), read in the run's directory with the run's environment
/// (project config off, the user's inline config). Empty when it cannot be
/// read: the config files GitWand reads itself then decide.
fn opencode_resolved_mcp_names(binary: &str, run_dir: &std::path::Path) -> Vec<String> {
    use std::sync::Mutex;
    use std::time::{Duration, Instant};
    // One read per binary for a minute: a batch of generations does not pay
    // an opencode start-up each. A config change is seen within that minute.
    const TTL: Duration = Duration::from_secs(60);
    type Entry = (
        (String, u64, Option<std::time::SystemTime>),
        Instant,
        Vec<String>,
    );
    static CACHE: Mutex<Vec<Entry>> = Mutex::new(Vec::new());
    let id = binary_identity(binary);
    if let Some((_, _, names)) = CACHE
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .iter()
        .find(|(k, at, _)| *k == id && at.elapsed() < TTL)
    {
        return names.clone();
    }
    let mut cmd = ai_prompt_cmd_in(binary, AiCli::Opencode, run_dir);
    cmd.env("OPENCODE_DISABLE_PROJECT_CONFIG", "1");
    cmd.args(["debug", "config"]);
    let Some(out) = output_within(cmd, Duration::from_secs(15), false) else {
        return Vec::new(); // not cached: the next run tries again
    };
    let names = opencode_debug_config_mcp_names(&out);
    let mut cache = CACHE.lock().unwrap_or_else(|p| p.into_inner());
    cache.retain(|(k, _, _)| *k != id);
    cache.push((id, Instant::now(), names.clone()));
    names
}

/// The `mcp` keys of `opencode debug config`'s output (a JSON object, after
/// whatever opencode prints before it).
fn opencode_debug_config_mcp_names(out: &str) -> Vec<String> {
    out.find('{')
        .map(|i| opencode_mcp_names(&out[i..]))
        .unwrap_or_default()
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

    let Some(stdout) = list_models_output(&binary, AiCli::Opencode, &["models"]) else {
        return Ok(Vec::new());
    };

    let models: Vec<String> = stdout
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
    model: Option<String>,
    effort: Option<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        copilot_cli_prompt_inner(prompt, system_prompt, model, effort)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// What `copilot -p` is told: the prompt itself is in a file of the run's
/// private directory (Copilot 1.0 reads no prompt from stdin outside
/// `--fleet`), which it reads with its `view` tool.
const COPILOT_PROMPT_FILE: &str = "prompt.md";
const COPILOT_INSTRUCTION: &str =
    "Read the file prompt.md in the current directory and do exactly what it asks. Reply with your answer only.";

/// `copilot` arguments for a one-shot prompt, locked down. The prompt carries
/// untrusted repo content; GitWand only wants a text answer:
///
/// - `--available-tools view`: the model sees one tool, the file viewer it
///   needs for `prompt.md` (file access is confined to the run's directory
///   and the temp directory). No shell, no write, no `web_fetch`, no MCP tool.
/// - `--deny-tool` shell / write / url, should a later version add a tool
///   `--available-tools` does not filter.
/// - `--disable-builtin-mcps`: no GitHub MCP server, a way to post anywhere.
/// - `--no-custom-instructions`, `--no-ask-user`, `-s` (the answer only).
///
/// Checked on Copilot CLI 1.0.117: a prompt asking for `touch` and a
/// `web_fetch` ran neither.
fn copilot_prompt_args(model: Option<&str>, effort: Option<&str>) -> Vec<String> {
    let mut args: Vec<String> = [
        "--no-color",
        "-s",
        "--no-ask-user",
        "--no-custom-instructions",
        "--disable-builtin-mcps",
        "--available-tools",
        "view",
        "--deny-tool=shell",
        "--deny-tool=write",
        "--deny-tool=url",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    if let Some(m) = model.map(str::trim).filter(|m| !m.is_empty()) {
        args.push("--model".to_string());
        args.push(m.to_string());
    }
    if let Some(e) = effort {
        args.push("--reasoning-effort".to_string());
        args.push(e.to_string());
    }
    args.push("-p".to_string());
    args.push(COPILOT_INSTRUCTION.to_string());
    args
}

fn copilot_cli_prompt_inner(
    prompt: String,
    system_prompt: Option<String>,
    model: Option<String>,
    effort: Option<String>,
) -> Result<String, String> {
    let binary =
        resolve_copilot_binary().ok_or_else(|| "Binaire `copilot` introuvable".to_string())?;
    require_lockdown_flags(
        &binary,
        AiCli::Copilot,
        &["--help"],
        &["--available-tools", "--disable-builtin-mcps"],
        "This Copilot CLI cannot restrict its tools: update it with `copilot update`",
    )?;

    // Copilot CLI doesn't expose a separate system channel — prepend the
    // system prompt as a Markdown section, same shape as the other flows.
    let full_prompt = match system_prompt {
        Some(sys) if !sys.trim().is_empty() => {
            format!("# System\n{}\n\n# User\n{}", sys.trim(), prompt.trim())
        }
        _ => prompt,
    };

    // `run_dir` lives until the end of the function: the CLI has exited.
    let (mut cmd, run_dir) = ai_prompt_cmd(&binary, AiCli::Copilot)?;
    // The prompt (repository content) in the private run directory, never
    // on the argv where any local user can read it.
    std::fs::write(run_dir.path().join(COPILOT_PROMPT_FILE), full_prompt)
        .map_err(|e| format!("Failed to write the Copilot prompt: {e}"))?;
    // A stray variable must not re-enable every tool.
    cmd.env_remove("COPILOT_ALLOW_ALL");
    cmd.args(copilot_prompt_args(
        model.as_deref(),
        valid_effort(effort.as_ref()),
    ));

    let output = cmd
        .stdin(std::process::Stdio::null())
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

    let Some(stdout) = list_models_output(&binary, AiCli::Copilot, &["help", "config"]) else {
        return Ok(Vec::new());
    };

    Ok(parse_copilot_models(&stdout))
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

    const HELP_2_1: &str = "  --strict-mcp-config   Only use MCP servers from --mcp-config\n  \
        --setting-sources <sources>   Comma-separated list\n  \
        --tools <tools...>   Specify the list of available tools\n  \
        --allowedTools, --allowed-tools <tools...>\n  \
        --no-session-persistence   Disable session persistence\n";

    #[test]
    fn caps_are_read_from_help_by_exact_flag() {
        assert_eq!(
            parse_claude_caps(HELP_2_1),
            ClaudeCaps {
                tools: true,
                setting_sources: true,
                strict_mcp: true,
                no_session_persistence: true,
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
        assert!(args.contains(&"--no-session-persistence"));
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
    }

    #[test]
    fn an_old_cli_runs_outside_the_repository() {
        let caps = ClaudeCaps::default();
        let args = claude_lockdown_args(caps);
        assert!(!args.contains(&"--tools"));
        assert!(!args.contains(&"--setting-sources"));
        assert!(!args.contains(&"--strict-mcp-config"));
        assert!(args.contains(&"--disallowedTools") && args.contains(&"Read"));
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
        let hint = |e: &str| e.contains("stdin");
        assert_eq!(
            opencode_result(&output(0, "feat: x\n", "")).unwrap(),
            "feat: x\n"
        );
        // An old opencode that ignored stdin: exit 0, nothing said.
        assert!(hint(&opencode_result(&output(0, "  \n", "")).unwrap_err()));
        let err =
            opencode_result(&output(1, "", "You must provide a message or a command")).unwrap_err();
        assert!(hint(&err), "{err}");
        // Non-zero exit: stderr is the message.
        assert_eq!(opencode_result(&output(2, "", "boom")).unwrap_err(), "boom");
        assert_eq!(
            opencode_result(&output(3, "", "")).unwrap_err(),
            "opencode CLI a échoué sans message"
        );
        // Exit 0, empty answer, a provider error on stderr: show that.
        assert_eq!(
            opencode_result(&output(0, "", "Error: rate limited\n")).unwrap_err(),
            "Error: rate limited"
        );
        // Line / level based: an ERROR level token or an HTTP status counts…
        for e in [
            "2026-10-10 ERROR provider call failed",
            "request failed status=401",
            "HTTP 429 Too Many Requests",
            "rate limit reached",
        ] {
            assert!(stderr_looks_like_error(e), "{e}");
            assert_eq!(opencode_result(&output(0, "", e)).unwrap_err(), e);
        }
        // …log noise that merely contains the words does not.
        for e in [
            // ANSI colours stripped first (opencode's own error output).
            "\u{1b}[91m\u{1b}[1mError: \u{1b}[0mOpenCode's free tier can only be used from within OpenCode",
            "ProviderAuthError: missing key",
            "fatal: Permission denied (publickey)",
            "< HTTP/1.1 503 Service Unavailable",
            r#"{"name":"APIError","data":{"message":"bad"}}"#,
            r#"{"name": "ProviderModelNotFoundError"}"#,
            "error sending request for url (https://api.example/v1)",
        ] {
            assert!(stderr_looks_like_error(e), "{e}");
        }
        for noise in [
            "INFO loaded error-reporter plugin",
            "DEBUG invalid cache entry skipped",
            "update available: 1.18 (401 changes)",
            "errors: 0",
            "Error reporting enabled",
            "\u{1b}[2mINFO\u{1b}[0m service=bus type=session.updated",
            r#"{"name":"session","error":null}"#,
            "HTTP/1.1 200 OK",
        ] {
            assert!(!stderr_looks_like_error(noise), "{noise}");
        }
        // Exit 0, empty answer, only log noise on stderr: keep the hint,
        // with the end of stderr.
        let err =
            opencode_result(&output(0, "", "INFO starting\nupdate available: 1.18")).unwrap_err();
        assert!(hint(&err), "{err}");
        assert!(err.ends_with("update available: 1.18"), "{err}");
    }
}

#[cfg(test)]
mod neutral_dir_tests {
    use super::*;

    /// A per-test scratch directory, removed when dropped.
    struct Scratch(PathBuf);
    impl Scratch {
        fn new(tag: &str) -> Scratch {
            let d = std::env::temp_dir().join(format!("gw-runs-{}-{}", tag, random_token()));
            std::fs::create_dir_all(&d).unwrap();
            Scratch(d)
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[cfg(unix)]
    #[test]
    fn each_run_gets_a_fresh_private_dir_removed_afterwards() {
        use std::os::unix::fs::PermissionsExt;
        let scratch = Scratch::new("fresh");
        let base = prepare_runs_base(&scratch.0.join("ai-runs")).unwrap();
        let a = AiRunDir::create(&base, false).unwrap();
        let b = AiRunDir::create(&base, true).unwrap();
        assert_ne!(a.path(), b.path());
        assert_eq!(
            std::fs::metadata(a.path()).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert!(!a.path().join(".git").exists());
        assert!(b.path().join(".git").is_dir(), "Codex needs a repository");
        // What a run leaves behind is gone with its directory.
        std::fs::create_dir_all(a.path().join(".opencode/plugin")).unwrap();
        std::fs::write(a.path().join(".opencode/plugin/x.js"), "x").unwrap();
        let (pa, pb) = (a.path().to_path_buf(), b.path().to_path_buf());
        drop(a);
        drop(b);
        assert!(!pa.exists() && !pb.exists());
    }

    #[cfg(unix)]
    #[test]
    fn run_dir_creation_never_reuses_an_existing_entry() {
        let scratch = Scratch::new("excl");
        let base = prepare_runs_base(&scratch.0.join("ai-runs")).unwrap();
        // A planted symlink with a run- name is not followed or reused.
        let target = scratch.0.join("elsewhere");
        std::fs::create_dir_all(&target).unwrap();
        std::os::unix::fs::symlink(&target, base.join("run-planted")).unwrap();
        let run = AiRunDir::create(&base, false).unwrap();
        assert!(std::fs::symlink_metadata(run.path()).unwrap().is_dir());
        assert!(!std::fs::symlink_metadata(run.path())
            .unwrap()
            .file_type()
            .is_symlink());
    }

    #[test]
    fn stale_run_dirs_are_swept_fresh_ones_kept() {
        let scratch = Scratch::new("sweep");
        let base = prepare_runs_base(&scratch.0.join("ai-runs")).unwrap();
        std::fs::create_dir_all(base.join("run-old/.claude")).unwrap();
        std::fs::create_dir_all(base.join("keep-me")).unwrap();
        let fresh = AiRunDir::create(&base, false).unwrap();
        // Everything counts as stale with a zero max age, except non-run names
        // and runs whose process is alive (this one's, here).
        std::thread::sleep(std::time::Duration::from_millis(20));
        sweep_stale_run_dirs(&base, std::time::Duration::from_millis(1));
        assert!(!base.join("run-old").exists());
        assert!(base.join("keep-me").exists());
        assert!(fresh.path().exists());
        // With an hour's grace, a live run is left alone.
        let live = AiRunDir::create(&base, false).unwrap();
        sweep_stale_run_dirs(&base, std::time::Duration::from_secs(3600));
        assert!(live.path().exists());
    }

    #[test]
    fn jsonc_becomes_json_without_touching_strings() {
        let text = r#"{
  // a comment
  "a": "http://x // not a comment", /* block */ /*/ "a": "commented out" */
  "b": [1, 2,],
  "c": { "d": "e\" , }", },
}"#;
        let v: serde_json::Value = serde_json::from_str(&jsonc_to_json(text)).unwrap();
        assert_eq!(v["a"], "http://x // not a comment");
        assert_eq!(v["b"], serde_json::json!([1, 2]));
        assert_eq!(v["c"]["d"], "e\" , }");
    }

    #[test]
    fn opencode_mcp_servers_are_read_and_disabled_by_name() {
        let cfg = r#"{
  // servers
  "mcp": { "fs": { "type": "local", "command": ["x"] }, "web": { "type": "remote", "url": "https://x" }, },
  "model": "anthropic/claude",
}"#;
        assert_eq!(opencode_mcp_names(cfg), ["fs", "web"]);
        assert!(opencode_mcp_names("not json").is_empty());
        assert!(opencode_mcp_names(r#"{"model":"m"}"#).is_empty());

        // The user's inline config is kept, its own servers disabled too.
        let inherited = r#"{"model":"openai/x","mcp":{"inline":{"type":"local","command":["y"]}}}"#;
        let out: serde_json::Value = serde_json::from_str(&opencode_config_content(
            Some(inherited),
            &["fs".to_string(), "web".to_string()],
        ))
        .unwrap();
        assert_eq!(out["model"], "openai/x");
        for name in ["fs", "web", "inline"] {
            assert_eq!(out["mcp"][name]["enabled"], false, "{name}");
        }
        assert_eq!(out["mcp"]["inline"]["command"], serde_json::json!(["y"]));

        // Nothing inherited (or unreadable): only the disables.
        let bare: serde_json::Value =
            serde_json::from_str(&opencode_config_content(Some("{oops"), &["fs".to_string()]))
                .unwrap();
        assert_eq!(
            bare,
            serde_json::json!({"tools": {"*": false}, "mcp": {"fs": {"enabled": false}}})
        );
        let empty: serde_json::Value =
            serde_json::from_str(&opencode_config_content(None, &[])).unwrap();
        assert_eq!(empty, serde_json::json!({"tools": {"*": false}, "mcp": {}}));
        assert_eq!(
            opencode_debug_config_mcp_names("\u{1b}[0m\n{\"mcp\":{\"b\":{\"type\":\"local\"}}}"),
            ["b"]
        );
        assert!(opencode_debug_config_mcp_names("Error: nothing").is_empty());
    }

    #[test]
    fn the_opencode_run_carries_the_mcp_disables() {
        let dir = std::env::temp_dir();
        let cmd = opencode_run_cmd("opencode", None, &dir);
        let content = cmd
            .get_envs()
            .find(|(k, _)| *k == "OPENCODE_CONFIG_CONTENT")
            .and_then(|(_, v)| v.map(|v| v.to_string_lossy().into_owned()))
            .expect("OPENCODE_CONFIG_CONTENT is set");
        let v: serde_json::Value = serde_json::from_str(&content).unwrap();
        assert!(v["mcp"].is_object());
    }

    #[test]
    fn copilot_sees_only_its_file_viewer_and_never_the_prompt() {
        let args = copilot_prompt_args(Some(" gpt-5 "), Some("high"));
        let at = |flag: &str| args.iter().position(|a| a == flag).unwrap();
        assert_eq!(args[at("--available-tools") + 1], "view");
        for flag in [
            "--disable-builtin-mcps",
            "--no-custom-instructions",
            "--no-ask-user",
            "--deny-tool=shell",
            "--deny-tool=write",
            "--deny-tool=url",
            "-s",
        ] {
            assert!(args.iter().any(|a| a == flag), "{flag}");
        }
        assert_eq!(args[at("--model") + 1], "gpt-5");
        assert_eq!(args[at("--reasoning-effort") + 1], "high");
        // `-p` last, with the fixed instruction: the prompt is in prompt.md.
        assert_eq!(&args[args.len() - 2..], ["-p", COPILOT_INSTRUCTION]);
        assert!(COPILOT_INSTRUCTION.contains(COPILOT_PROMPT_FILE));
        assert!(!copilot_prompt_args(Some(" "), None)
            .iter()
            .any(|a| a == "--model" || a == "--reasoning-effort"));
    }

    #[test]
    fn antigravity_reads_its_prompt_from_stdin_in_plan_mode() {
        let args = antigravity_prompt_args(Some(" gemini-3-pro "));
        assert_eq!(
            args,
            [
                "--mode",
                "plan",
                "--input-format",
                "stream-json",
                "--output-format",
                "stream-json",
                "--model",
                "gemini-3-pro",
                "-p="
            ]
        );
        assert_eq!(antigravity_prompt_args(Some("  ")).last().unwrap(), "-p=");
        // The prompt is in the stdin turn, escaped, never in the arguments.
        let secret = "diff --git a/x\n\"quoted\" \u{0}line";
        let input = antigravity_stream_input(secret);
        assert!(input.ends_with('\n') && input.lines().count() == 1);
        let v: serde_json::Value = serde_json::from_str(input.trim()).unwrap();
        assert_eq!(v["event"], "user");
        assert_eq!(v["message"]["content"], secret);
        assert!(!args.iter().any(|a| a.contains("diff --git")));
    }

    #[test]
    fn antigravity_answers_come_from_the_result_event() {
        let ok = concat!(
            "{\"event\":\"init\",\"init\":{}}\n",
            "{\"event\":\"step_update\",\"step_update\":{\"text_delta\":\"O\"}}\n",
            "{\"event\":\"result\",\"result\":{\"status\":\"SUCCESS\",\"response\":\"OK\\n\"}}\n"
        );
        assert_eq!(antigravity_stream_result(ok).unwrap(), "OK\n");
        let failed = "{\"event\":\"result\",\"result\":{\"status\":\"ERROR\",\"response\":\"\",\"error\":\"quota\"}}";
        assert_eq!(antigravity_stream_result(failed).unwrap_err(), "quota");
        assert!(antigravity_stream_result("warning: nothing\n").is_err());
    }

    #[test]
    fn an_old_run_dir_is_kept_while_its_process_lives() {
        let scratch = Scratch::new("sweep-owner");
        let base = prepare_runs_base(&scratch.0.join("ai-runs")).unwrap();
        // A run of a live process (this one) and one of a process that has
        // exited (a child we reaped), both past the max age.
        let live = format!("run-{:016x}{:08x}", 1u64, std::process::id());
        let mut child = std::process::Command::new(if cfg!(windows) { "cmd" } else { "true" });
        if cfg!(windows) {
            child.args(["/C", "exit"]);
        }
        let mut child = child.spawn().unwrap();
        let dead_pid = child.id();
        child.wait().unwrap();
        let dead = format!("run-{:016x}{:08x}", 2u64, dead_pid);
        std::fs::create_dir_all(base.join(&live)).unwrap();
        std::fs::create_dir_all(base.join(&dead)).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        sweep_stale_run_dirs(&base, std::time::Duration::from_millis(1));
        assert!(base.join(&live).exists(), "a live process's run was swept");
        assert!(
            !base.join(&dead).exists(),
            "an exited process's run was kept"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_week_old_run_dir_is_swept_even_with_a_live_pid() {
        let scratch = Scratch::new("sweep-reused-pid");
        let base = prepare_runs_base(&scratch.0.join("ai-runs")).unwrap();
        // This process's pid, as a reused pid would look after a reboot.
        let old = format!("run-{:016x}{:08x}", 3u64, std::process::id());
        std::fs::create_dir_all(base.join(&old)).unwrap();
        let eight_days = std::time::Duration::from_secs(8 * 24 * 60 * 60);
        std::fs::File::open(base.join(&old))
            .unwrap()
            .set_modified(std::time::SystemTime::now() - eight_days)
            .unwrap();
        sweep_stale_run_dirs(&base, std::time::Duration::from_secs(3600));
        assert!(!base.join(&old).exists());
    }

    #[test]
    fn run_dir_names_give_their_owner_pid() {
        assert_eq!(run_dir_owner_pid("run-0123456789abcdef0000002a"), Some(42));
        assert_eq!(run_dir_owner_pid("run-old"), None);
        assert_eq!(run_dir_owner_pid("keep-me"), None);
        assert_eq!(run_dir_owner_pid("run-0123456789abcdef0000002g"), None);
        let scratch = Scratch::new("pid-name");
        let base = prepare_runs_base(&scratch.0.join("ai-runs")).unwrap();
        let made = AiRunDir::create(&base, false).unwrap();
        let name = made
            .path()
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        assert_eq!(run_dir_owner_pid(&name), Some(std::process::id()));
    }

    #[test]
    fn concurrent_runs_get_distinct_dirs() {
        let scratch = Scratch::new("race");
        let base = prepare_runs_base(&scratch.0.join("ai-runs")).unwrap();
        let handles: Vec<_> = (0..8)
            .map(|_| {
                let base = base.clone();
                std::thread::spawn(move || {
                    let r = AiRunDir::create(&base, true).unwrap();
                    assert!(r.path().join(".git").is_dir());
                    r.path().to_path_buf()
                })
            })
            .collect();
        let mut paths: Vec<PathBuf> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        paths.sort();
        paths.dedup();
        assert_eq!(paths.len(), 8);
    }

    #[cfg(unix)]
    #[test]
    fn runs_base_refuses_a_symlink() {
        let scratch = Scratch::new("link");
        let target = scratch.0.join("elsewhere");
        std::fs::create_dir_all(&target).unwrap();
        let link = scratch.0.join("ai-runs");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        assert!(prepare_runs_base(&link).is_err());
    }

    #[test]
    fn runs_base_is_prepared_again_after_being_deleted() {
        let scratch = Scratch::new("reprep");
        let cache = std::sync::Mutex::new(None);
        // A failure is not remembered.
        assert!(ai_runs_base_in(&cache, None).is_err());
        let base = ai_runs_base_in(&cache, Some(scratch.0.clone())).unwrap();
        std::fs::remove_dir_all(&base).unwrap();
        let again = ai_runs_base_in(&cache, Some(scratch.0.clone())).unwrap();
        assert_eq!(again, base);
        assert!(again.is_dir());
        let run = AiRunDir::create(&again, false).unwrap();
        assert!(run.path().is_dir());
    }

    #[test]
    fn runs_base_is_per_user_not_the_shared_temp_dir() {
        // Location only: nothing is created in the real cache directory.
        if let Some(base) = neutral_dir_base() {
            assert!(
                !base.starts_with(std::env::temp_dir()),
                "{}",
                base.display()
            );
            if let Some(home) = dirs::home_dir() {
                assert!(base.starts_with(home), "{}", base.display());
            }
        }
        // Unit tests themselves use a directory under temp.
        let d = ai_runs_base().unwrap();
        assert!(d.starts_with(std::env::temp_dir()));
        assert!(d.ends_with(std::path::Path::new("gitwand").join("ai-runs")));
    }

    #[test]
    fn prompt_commands_each_run_in_their_own_dir() {
        let cmd = ai_prompt_cmd_in("claude", AiCli::Claude, std::path::Path::new("/run"));
        assert_eq!(cmd.get_current_dir(), Some(std::path::Path::new("/run")));
        let mut seen = Vec::new();
        for cli in [
            AiCli::Claude,
            AiCli::Codex,
            AiCli::Opencode,
            AiCli::Copilot,
            AiCli::Antigravity,
        ] {
            let (cmd, run) = ai_prompt_cmd("x", cli).unwrap();
            assert_eq!(cmd.get_current_dir(), Some(run.path()));
            assert!(run.path().starts_with(ai_runs_base().unwrap()));
            seen.push(run.path().to_path_buf());
        }
        seen.dedup();
        assert_eq!(seen.len(), 5);
    }

    /// Whether process `pid` still exists (signal 0 probes without killing).
    #[cfg(unix)]
    fn alive(pid: i32) -> bool {
        // SAFETY: signal 0 only checks for existence.
        unsafe { libc::kill(pid, 0) == 0 }
    }

    #[cfg(unix)]
    #[test]
    fn a_probe_never_hangs_or_leaks_on_a_grandchild_holding_stdout() {
        let scratch = Scratch::new("probe");
        let pidfile = scratch.0.join("pid");
        // Timeout with a wrapper that does not `exec`: the whole group dies.
        let mut wrapper = std::process::Command::new("sh");
        wrapper.args([
            "-c",
            &format!("sleep 30 & echo $! > '{}'; sleep 30", pidfile.display()),
        ]);
        let t = std::time::Instant::now();
        assert!(stdout_within(wrapper, std::time::Duration::from_millis(500)).is_none());
        assert!(
            t.elapsed() < std::time::Duration::from_secs(5),
            "{:?}",
            t.elapsed()
        );
        let pid: i32 = std::fs::read_to_string(&pidfile)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(200));
        assert!(!alive(pid), "timed-out probe left its grandchild running");

        // Successful exit, grandchild still holding stdout: the output is
        // kept (not a failure) and the grandchild is killed.
        let mut leaky = std::process::Command::new("sh");
        leaky.args(["-c", "sleep 30 & echo $!"]);
        let t = std::time::Instant::now();
        let out = stdout_within(leaky, std::time::Duration::from_secs(5)).expect("output kept");
        assert!(
            t.elapsed() < std::time::Duration::from_secs(8),
            "{:?}",
            t.elapsed()
        );
        let pid: i32 = out.trim().parse().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(200));
        assert!(!alive(pid), "probe left its grandchild running");
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
    fn lockdown_flags_are_checked_and_a_failed_probe_is_not_called_too_old() {
        use std::os::unix::fs::PermissionsExt;
        let scratch = Scratch::new("lockdown-flags");
        let script = |name: &str, body: &str| {
            let p = scratch.0.join(name);
            std::fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
            p.to_string_lossy().into_owned()
        };
        let new = script(
            "new-cli",
            "echo '  --available-tools  --disable-builtin-mcps'",
        );
        let old = script("old-cli", "echo '  --available-toolset'");
        let flags = ["--available-tools", "--disable-builtin-mcps"];
        assert!(
            require_lockdown_flags(&new, AiCli::Copilot, &["--help"], &flags, "too old").is_ok()
        );
        assert_eq!(
            require_lockdown_flags(&old, AiCli::Copilot, &["--help"], &flags, "too old"),
            Err("too old".to_string())
        );
        let missing = scratch.0.join("absent").to_string_lossy().into_owned();
        let err = require_lockdown_flags(&missing, AiCli::Copilot, &["--help"], &flags, "too old")
            .unwrap_err();
        assert!(err.starts_with("Could not check"), "{err}");
    }

    #[test]
    fn help_flags_match_whole_option_names() {
        let help = "  --model <m>   the model\n  --input-format=text\n  -p, --print\n";
        assert!(!help_has_flag(help, "--mode"));
        assert!(help_has_flag(help, "--model"));
        assert!(help_has_flag(help, "--input-format"));
        assert!(help_has_flag(help, "--print"));
        assert!(help_has_flag("--mode plan", "--mode"));
        assert!(!help_has_flag("--modes", "--mode"));
    }

    #[cfg(unix)]
    #[test]
    fn output_within_reads_stderr_when_asked() {
        let cmd = || {
            let mut c = std::process::Command::new("sh");
            c.args([
                "-c",
                "echo --mode on stdout; echo --input-format on stderr >&2",
            ]);
            c
        };
        let both = output_within(cmd(), std::time::Duration::from_secs(5), true).unwrap();
        assert!(
            both.contains("--mode") && both.contains("--input-format"),
            "{both}"
        );
        let out = stdout_within(cmd(), std::time::Duration::from_secs(5)).unwrap();
        assert!(!out.contains("--input-format"));
        // A help printed by a CLI that then exits non-zero is still read.
        let mut failing = std::process::Command::new("sh");
        failing.args(["-c", "echo --mode >&2; exit 2"]);
        let help = output_within(failing, std::time::Duration::from_secs(5), true).unwrap();
        assert!(help.contains("--mode"));
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

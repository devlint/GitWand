//! AI provider HTTP transport — Anthropic API, OpenAI-compatible endpoints,
//! Ollama.
//!
//! These calls used to be `fetch()`es from the webview, with the API key kept
//! in plain text in the settings blob in localStorage (on disk, unencrypted,
//! in the WebView data directory). They now go through `ai_http_request`:
//!
//! - The API key lives in the OS keychain under `AI_KEY_SERVICE`. The webview
//!   can store or clear it, and read a masked hint, but never read it back —
//!   `credentials::get_credential` refuses that service.
//! - The key is injected here, through curl's `--config -` on stdin, together
//!   with the URL and the request body (which carries repository content), so
//!   none of it lands in the curl argv.
//! - The key is bound to the origin of the endpoint it was entered for
//!   (`StoredKey::origin`). `ai_http_request` attaches it to a request for that
//!   origin only: without the binding, a script running in the webview could
//!   not read the key, but could still have it sent to a host of its choosing
//!   — which amounts to the same thing. Only someone who knows the key can
//!   bind it (`ai_api_key_set` takes the key and the endpoint together), so
//!   changing the endpoint means entering the key again.
//! - Because the webview no longer talks to arbitrary AI hosts itself, the CSP
//!   `connect-src` can be limited to a short list of fixed hosts.
//! - A request without the key (`auth: "none"`: Ollama, a keyless
//!   OpenAI-compatible server) carries repository content too, so it is not a
//!   way around that CSP either: it may go to a loopback host, or to an origin
//!   the user allowed in a native dialog shown by this module (the webview
//!   cannot answer it), remembered in `{data_local_dir}/gitwand/ai-open-endpoints.json`.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::commands::curl_util::{curl_transport_check, quote_config, run_curl, RequestBody};

/// Keychain service holding the AI provider API key. Backend-only: see
/// `credentials::BACKEND_ONLY_SERVICES`.
pub(crate) const AI_KEY_SERVICE: &str = "gitwand:ai";
const AI_KEY_ACCOUNT: &str = "api-key";

/// Ceiling for a request that names no timeout of its own — the completion
/// calls. A local model on CPU (Ollama) or a long generation can take many
/// minutes; this only stops a request that would otherwise never end.
const COMPLETION_TIMEOUT_SECS: u64 = 30 * 60;
/// Time allowed to establish the connection, whatever the overall timeout:
/// an unreachable host fails fast even under the generous completion ceiling.
const CONNECT_TIMEOUT_SECS: u64 = 30;

#[derive(serde::Serialize, Debug)]
pub(crate) struct AiHttpResponse {
    pub status: i32,
    pub body: String,
}

/// What the webview may know about the stored key.
#[derive(serde::Serialize, Debug, PartialEq, Eq)]
pub(crate) struct AiKeyInfo {
    /// Masked form, see `key_hint`.
    pub hint: String,
    /// Origin the key is bound to; `None` for a key stored before the binding
    /// existed, which no request may use until it is entered again.
    pub origin: Option<String>,
}

/// Keychain payload: the key and the origin it may be sent to, stored as one
/// JSON value so the two can never be updated separately.
#[derive(serde::Serialize, serde::Deserialize, Debug, PartialEq, Eq)]
struct StoredKey {
    key: String,
    origin: Option<String>,
}

impl StoredKey {
    /// Parse a keychain value. A value that is not our JSON is a bare key
    /// written before the binding existed: usable for nothing but its hint.
    fn parse(raw: &str) -> Option<StoredKey> {
        let stored = match serde_json::from_str::<StoredKey>(raw) {
            Ok(s) => s,
            Err(_) => StoredKey {
                key: raw.to_string(),
                origin: None,
            },
        };
        let key = stored.key.trim().to_string();
        (!key.is_empty()).then_some(StoredKey {
            key,
            origin: stored.origin,
        })
    }

    fn info(&self) -> AiKeyInfo {
        AiKeyInfo {
            hint: key_hint(&self.key),
            origin: self.origin.clone(),
        }
    }
}

fn key_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(AI_KEY_SERVICE, AI_KEY_ACCOUNT)
        .map_err(|e| format!("keyring init failed: {}", e))
}

fn read_key() -> Option<StoredKey> {
    StoredKey::parse(&key_entry().ok()?.get_password().ok()?)
}

/// Parse an AI endpoint URL: http(s) with a host, nothing else. The
/// serialisation of the result is what curl is handed, so the origin checked
/// here and the host curl connects to come from the same parse.
fn parse_endpoint(url: &str) -> Result<tauri::Url, String> {
    if url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("AI endpoint contains whitespace or control characters".to_string());
    }
    let parsed = tauri::Url::parse(url).map_err(|_| "AI endpoint must be an http(s) URL")?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err("AI endpoint must be an http(s) URL".to_string());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("AI endpoint must not carry credentials".to_string());
    }
    Ok(parsed)
}

/// `scheme://host[:port]` of an endpoint — what a stored key is bound to.
fn endpoint_origin(url: &str) -> Result<String, String> {
    Ok(parse_endpoint(url.trim())?.origin().ascii_serialization())
}

/// Refuse to attach the key to a request for any origin but its own.
fn check_key_binding(bound: Option<&str>, target: &tauri::Url) -> Result<(), String> {
    let target = target.origin().ascii_serialization();
    match bound {
        Some(b) if b == target => Ok(()),
        Some(b) => Err(format!(
            "The stored AI API key is tied to {}; enter it again in Settings to use it with {}",
            b, target
        )),
        None => Err(
            "The stored AI API key is not tied to an endpoint; enter it again in Settings"
                .to_string(),
        ),
    }
}

/// Loopback hosts take unauthenticated requests without asking: a local
/// Ollama (the default `http://localhost:11434`) is no exfiltration channel.
fn is_loopback(target: &tauri::Url) -> bool {
    let host = target.host_str().unwrap_or("");
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    host.trim_start_matches('[')
        .trim_end_matches(']')
        .parse::<std::net::IpAddr>()
        .map(|ip| ip.is_loopback())
        .unwrap_or(false)
}

fn open_endpoints_path() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("gitwand")
        .join("ai-open-endpoints.json")
}

/// Origins allowed for unauthenticated requests. A missing or unreadable file
/// allows none.
fn load_open_endpoints(path: &Path) -> Vec<String> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn save_open_endpoints(path: &Path, origins: &[String]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
    }
    let text = serde_json::to_string_pretty(origins).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(|e| format!("cannot write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("cannot write {}: {e}", path.display()))
}

/// Serialises the check-ask-remember sequence, so two requests to the same
/// new origin ask once.
static OPEN_ENDPOINTS_LOCK: Mutex<()> = Mutex::new(());

/// Gate for an unauthenticated request: loopback passes, any other origin
/// must have been allowed by the user, `ask` showing the question when it was
/// not. `ask` gets the origin and answers whether the user allowed it.
fn check_open_endpoint(
    target: &tauri::Url,
    store: &Path,
    ask: impl FnOnce(&str) -> bool,
) -> Result<(), String> {
    if is_loopback(target) {
        return Ok(());
    }
    let origin = target.origin().ascii_serialization();
    let _guard = OPEN_ENDPOINTS_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut allowed = load_open_endpoints(store);
    if allowed.iter().any(|o| o == &origin) {
        return Ok(());
    }
    if !ask(&origin) {
        return Err(format!(
            "AI requests to {} were not allowed. Allow them when GitWand asks, or use a local endpoint.",
            origin
        ));
    }
    allowed.push(origin);
    save_open_endpoints(store, &allowed)
}

/// Text of the native question, in the app's language (`locale` only picks
/// the language; the origin shown is the one the request goes to).
struct OpenEndpointPrompt {
    title: &'static str,
    body: &'static str,
    allow: &'static str,
    deny: &'static str,
}

fn open_endpoint_prompt(locale: Option<&str>) -> OpenEndpointPrompt {
    match locale.unwrap_or("en") {
        "fr" => OpenEndpointPrompt {
            title: "Autoriser ce serveur d'IA ?",
            body: "GitWand va envoyer du contenu de votre dépôt (diffs, conflits) sans clé d'API à :\n\n{origin}\n\nAutorisez-le seulement si c'est votre serveur Ollama ou compatible OpenAI. Ce choix est retenu.",
            allow: "Autoriser",
            deny: "Refuser",
        },
        "es" => OpenEndpointPrompt {
            title: "¿Permitir este servidor de IA?",
            body: "GitWand va a enviar contenido de tu repositorio (diffs, conflictos) sin clave de API a:\n\n{origin}\n\nPermítelo solo si es tu servidor Ollama o compatible con OpenAI. La decisión se recuerda.",
            allow: "Permitir",
            deny: "Rechazar",
        },
        "pt-BR" => OpenEndpointPrompt {
            title: "Permitir este servidor de IA?",
            body: "O GitWand vai enviar conteúdo do seu repositório (diffs, conflitos) sem chave de API para:\n\n{origin}\n\nPermita apenas se for o seu servidor Ollama ou compatível com OpenAI. A escolha fica salva.",
            allow: "Permitir",
            deny: "Recusar",
        },
        "zh-CN" => OpenEndpointPrompt {
            title: "允许此 AI 服务器？",
            body: "GitWand 将在不使用 API 密钥的情况下，把仓库内容（差异、冲突）发送到：\n\n{origin}\n\n仅当它是你的 Ollama 或 OpenAI 兼容服务器时才允许。此选择会被记住。",
            allow: "允许",
            deny: "拒绝",
        },
        _ => OpenEndpointPrompt {
            title: "Allow this AI server?",
            body: "GitWand is about to send repository content (diffs, conflicts) without an API key to:\n\n{origin}\n\nAllow it only if this is your Ollama or OpenAI-compatible server. Your choice is remembered.",
            allow: "Allow",
            deny: "Deny",
        },
    }
}

/// Ask in a native dialog, which the webview can neither draw nor answer.
/// Runs on a blocking thread (`ai_http_request` is in `spawn_blocking`).
fn ask_open_endpoint(app: &tauri::AppHandle, locale: Option<&str>, origin: &str) -> bool {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    let p = open_endpoint_prompt(locale);
    app.dialog()
        .message(p.body.replace("{origin}", origin))
        .title(p.title)
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            p.allow.to_string(),
            p.deny.to_string(),
        ))
        .blocking_show()
}

/// Masked form shown in Settings: enough to recognise which key is stored,
/// never enough to use it.
fn key_hint(key: &str) -> String {
    let chars: Vec<char> = key.chars().collect();
    if chars.len() <= 8 {
        return "••••••••".to_string();
    }
    let head: String = chars[..4].iter().collect();
    let tail: String = chars[chars.len() - 4..].iter().collect();
    format!("{}••••{}", head, tail)
}

/// Keychain value for `key` bound to `endpoint`'s origin.
fn stored_value(key: &str, endpoint: Option<&str>) -> Result<String, String> {
    let endpoint = endpoint
        .filter(|e| !e.trim().is_empty())
        .ok_or_else(|| "An AI endpoint is required to store the API key".to_string())?;
    let stored = StoredKey {
        key: key.to_string(),
        origin: Some(endpoint_origin(endpoint)?),
    };
    serde_json::to_string(&stored).map_err(|e| e.to_string())
}

/// Store the AI API key in the keychain, bound to the origin of `endpoint`
/// (an empty key clears it). Returns what the webview may know of what is now
/// stored, `None` when nothing is.
#[tauri::command]
pub(crate) async fn ai_api_key_set(
    key: String,
    endpoint: Option<String>,
) -> Result<Option<AiKeyInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let key = key.trim().to_string();
        let entry = key_entry()?;
        if key.is_empty() {
            return match entry.delete_password() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(None),
                Err(e) => Err(format!("Failed to delete AI API key: {}", e)),
            };
        }
        let value = stored_value(&key, endpoint.as_deref())?;
        entry
            .set_password(&value)
            .map_err(|e| format!("Failed to store AI API key: {}", e))?;
        Ok(StoredKey::parse(&value).map(|s| s.info()))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Masked hint and bound origin of the stored AI API key, `None` when none is
/// configured.
#[tauri::command]
pub(crate) async fn ai_api_key_hint() -> Result<Option<AiKeyInfo>, String> {
    tauri::async_runtime::spawn_blocking(|| Ok(read_key().map(|k| k.info())))
        .await
        .map_err(|e| e.to_string())?
}

/// Auth headers for `auth` ("anthropic" | "bearer" | "none"), with the key.
fn auth_headers(auth: &str, key: Option<&str>) -> Result<Vec<String>, String> {
    match auth {
        "none" => Ok(vec![]),
        "anthropic" | "bearer" => {
            let key = key.ok_or_else(|| "No AI API key configured".to_string())?;
            Ok(if auth == "anthropic" {
                vec![
                    format!("x-api-key: {}", key),
                    "anthropic-version: 2023-06-01".to_string(),
                ]
            } else {
                vec![format!("Authorization: Bearer {}", key)]
            })
        }
        other => Err(format!("Unknown AI auth scheme: {}", other)),
    }
}

/// Validate the request and build the curl config fed on stdin. `url` is the
/// serialisation of a `parse_endpoint` result.
fn build_request_config(
    method: &str,
    url: &tauri::Url,
    body: Option<&RequestBody>,
    headers: &[String],
) -> Result<String, String> {
    if !matches!(method, "GET" | "POST") {
        return Err(format!("Unsupported method: {}", method));
    }
    let mut cfg = format!("url = {}\n", quote_config(url.as_str()));
    for h in headers {
        cfg.push_str(&format!("header = {}\n", quote_config(h)));
    }
    if let Some(b) = body {
        cfg.push_str("header = \"Content-Type: application/json\"\n");
        cfg.push_str(&b.config_line());
    }
    Ok(cfg)
}

/// Perform one AI provider HTTP request. `auth` selects how the stored key is
/// attached: `"anthropic"` (x-api-key), `"bearer"`, or `"none"` (Ollama). The
/// key is only ever attached to a request for the origin it is bound to; a
/// request without it goes to a loopback host or to an origin the user
/// allowed (`check_open_endpoint`). `locale` is the app's language, for that
/// question. `timeout_secs` caps the whole request; without it, the generous
/// completion ceiling applies (`COMPLETION_TIMEOUT_SECS`).
#[tauri::command]
pub(crate) async fn ai_http_request(
    app: tauri::AppHandle,
    method: String,
    url: String,
    body: Option<String>,
    auth: String,
    timeout_secs: Option<u64>,
    locale: Option<String>,
) -> Result<AiHttpResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let open_gate = |target: &tauri::Url| {
            check_open_endpoint(target, &open_endpoints_path(), |origin| {
                ask_open_endpoint(&app, locale.as_deref(), origin)
            })
        };
        ai_http_request_inner(
            &method,
            &url,
            body.as_deref(),
            &auth,
            timeout_secs,
            open_gate,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

fn ai_http_request_inner(
    method: &str,
    url: &str,
    body: Option<&str>,
    auth: &str,
    timeout_secs: Option<u64>,
    open_gate: impl FnOnce(&tauri::Url) -> Result<(), String>,
) -> Result<AiHttpResponse, String> {
    const MARKER: &str = "\n__GW_HTTP_STATUS__";
    let target = parse_endpoint(url)?;
    if auth == "none" {
        open_gate(&target)?;
    }
    let stored = if auth == "none" { None } else { read_key() };
    let headers = auth_headers(auth, stored.as_ref().map(|s| s.key.as_str()))?;
    if let Some(s) = stored.as_ref() {
        check_key_binding(s.origin.as_deref(), &target)?;
    }
    // Kept alive until curl has exited: it reads the body from this file.
    let body_file = body.map(RequestBody::new).transpose()?;
    let cfg = build_request_config(method, &target, body_file.as_ref(), &headers)?;
    let timeout = timeout_secs
        .unwrap_or(COMPLETION_TIMEOUT_SECS)
        .clamp(1, COMPLETION_TIMEOUT_SECS);
    let args: Vec<String> = vec![
        "-s".to_string(),
        "-S".to_string(),
        "-X".to_string(),
        method.to_string(),
        // http(s) only, and no redirects (no `-L`): the request goes to the
        // origin the key binding was checked against, nowhere else.
        "--proto".to_string(),
        "=http,https".to_string(),
        "--connect-timeout".to_string(),
        CONNECT_TIMEOUT_SECS.min(timeout).to_string(),
        "--max-time".to_string(),
        timeout.to_string(),
        "-H".to_string(),
        "Accept: application/json".to_string(),
        "--config".to_string(),
        "-".to_string(),
        "-w".to_string(),
        format!("{}%{{http_code}}", MARKER),
    ];
    let output = run_curl(&args, Some(&cfg))?;
    curl_transport_check(
        output.status.success(),
        output.status.code(),
        &String::from_utf8_lossy(&output.stderr),
    )?;
    let combined = String::from_utf8_lossy(&output.stdout).into_owned();
    let (body, status) = match combined.rsplit_once(MARKER) {
        Some((b, s)) => (b.to_string(), s.trim().parse::<i32>().unwrap_or(0)),
        None => (combined, 0),
    };
    Ok(AiHttpResponse { status, body })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quoting_cannot_break_out_of_the_string() {
        let hostile = "a\"\nurl = \"https://evil.example\"\\";
        let q = quote_config(hostile);
        // One logical line, opening and closing quote only.
        assert!(!q.contains('\n'));
        assert_eq!(q, "\"a\\\"\\nurl = \\\"https://evil.example\\\"\\\\\"");
    }

    fn url(u: &str) -> tauri::Url {
        parse_endpoint(u).unwrap()
    }

    #[test]
    fn config_carries_url_headers_and_body() {
        let body = RequestBody::new("{\"a\":\"b\\nc\"}").unwrap();
        let cfg = build_request_config(
            "POST",
            &url("https://api.anthropic.com/v1/messages"),
            Some(&body),
            &["x-api-key: k".to_string()],
        )
        .unwrap();
        assert!(cfg.contains("url = \"https://api.anthropic.com/v1/messages\"\n"));
        assert!(cfg.contains("header = \"x-api-key: k\"\n"));
        // `RequestBody` decides inline vs file: curl 7.x drops a config line
        // of 100 KiB or more, and a prompt carrying a diff easily gets there.
        assert!(cfg.ends_with(&body.config_line()));
    }

    #[test]
    fn rejects_bad_method_scheme_and_control_chars() {
        assert!(build_request_config("DELETE", &url("https://x"), None, &[]).is_err());
        assert!(parse_endpoint("file:///etc/passwd").is_err());
        assert!(parse_endpoint("https://x/\nheader").is_err());
        assert!(parse_endpoint("https://x/ y").is_err());
        assert!(parse_endpoint("api.anthropic.com").is_err());
        assert!(parse_endpoint("https://user:pw@api.anthropic.com").is_err());
    }

    #[test]
    fn origin_ignores_path_and_default_port_but_not_host_scheme_or_port() {
        let o = endpoint_origin("https://api.anthropic.com").unwrap();
        assert_eq!(o, "https://api.anthropic.com");
        assert_eq!(
            endpoint_origin("https://API.anthropic.com:443/v1/messages?x=1").unwrap(),
            o
        );
        assert_ne!(endpoint_origin("http://api.anthropic.com").unwrap(), o);
        assert_ne!(
            endpoint_origin("https://api.anthropic.com:8443").unwrap(),
            o
        );
        assert_eq!(
            endpoint_origin("http://localhost:11434/v1").unwrap(),
            "http://localhost:11434"
        );
    }

    #[test]
    fn key_is_only_attached_to_its_own_origin() {
        let bound = Some("https://api.anthropic.com");
        assert!(check_key_binding(bound, &url("https://api.anthropic.com/v1/models")).is_ok());
        for hostile in [
            "https://evil.example/v1/messages",
            "http://api.anthropic.com/v1/messages",
            "https://api.anthropic.com.evil.example/v1",
            "https://api.anthropic.com:444/v1",
            // Path tricks that a prefix check would let through.
            "https://evil.example/https://api.anthropic.com",
            "https://evil.example\\@api.anthropic.com/",
        ] {
            let Ok(target) = parse_endpoint(hostile) else {
                continue; // refused before any binding question
            };
            let err = check_key_binding(bound, &target).unwrap_err();
            assert!(err.contains("enter it again"), "{hostile}: {err}");
        }
        // Userinfo is refused outright: `https://api.anthropic.com@evil/`
        // would otherwise read as Anthropic to a human and connect to evil.
        assert!(parse_endpoint("https://api.anthropic.com@evil.example/").is_err());
        // A key stored before the binding existed is usable nowhere.
        assert!(check_key_binding(None, &url("https://api.anthropic.com")).is_err());
    }

    #[test]
    fn stored_value_binds_the_key_to_the_endpoint_origin() {
        let v = stored_value("sk-ant-x", Some("https://api.anthropic.com/v1")).unwrap();
        let s = StoredKey::parse(&v).unwrap();
        assert_eq!(s.key, "sk-ant-x");
        assert_eq!(s.origin.as_deref(), Some("https://api.anthropic.com"));
        assert!(stored_value("sk", None).is_err());
        assert!(stored_value("sk", Some("  ")).is_err());
        assert!(stored_value("sk", Some("ftp://x")).is_err());
    }

    #[test]
    fn a_bare_legacy_value_parses_as_an_unbound_key() {
        let s = StoredKey::parse("  sk-legacy  ").unwrap();
        assert_eq!(s.key, "sk-legacy");
        assert_eq!(s.origin, None);
        assert!(StoredKey::parse("   ").is_none());
        assert!(StoredKey::parse(r#"{"key":"  ","origin":"https://x"}"#).is_none());
        assert_eq!(
            StoredKey::parse(r#"{"key":"sk","origin":"https://x"}"#)
                .unwrap()
                .info(),
            AiKeyInfo {
                hint: "••••••••".to_string(),
                origin: Some("https://x".to_string())
            }
        );
    }

    #[test]
    fn auth_requires_a_key_and_known_scheme() {
        assert!(auth_headers("anthropic", None).is_err());
        assert!(auth_headers("basic", Some("k")).is_err());
        assert!(auth_headers("none", None).unwrap().is_empty());
        assert_eq!(
            auth_headers("bearer", Some("k")).unwrap(),
            vec!["Authorization: Bearer k".to_string()]
        );
    }

    fn scratch_store(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("gitwand-ai-open-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d.join("ai-open-endpoints.json")
    }

    #[test]
    fn loopback_hosts_pass_without_asking() {
        let store = scratch_store("loopback");
        for u in [
            "http://localhost:11434/api/chat",
            "http://LOCALHOST:11434",
            "http://127.0.0.1:11434",
            "http://127.0.0.2:8080",
            "http://[::1]:11434/api/chat",
        ] {
            check_open_endpoint(&url(u), &store, |_| panic!("asked for {u}")).unwrap();
        }
        assert!(!store.exists(), "nothing is remembered for loopback");
        for u in [
            "http://localhost.evil.example",
            "http://192.168.1.10:11434",
            "https://ollama.example.com",
            "http://0.0.0.0:11434",
        ] {
            assert!(!is_loopback(&url(u)), "{u}");
        }
    }

    #[test]
    fn another_origin_is_asked_once_then_remembered() {
        let store = scratch_store("remember");
        let target = url("http://192.168.1.10:11434/api/chat");
        let mut asked = None;
        check_open_endpoint(&target, &store, |o| {
            asked = Some(o.to_string());
            true
        })
        .unwrap();
        assert_eq!(asked.as_deref(), Some("http://192.168.1.10:11434"));
        // Same origin, other path: no second question.
        check_open_endpoint(&url("http://192.168.1.10:11434/v1/models"), &store, |_| {
            panic!("asked twice")
        })
        .unwrap();
        // Another port is another origin.
        assert!(check_open_endpoint(&url("http://192.168.1.10:8080"), &store, |_| false).is_err());
    }

    #[test]
    fn a_refusal_blocks_the_request_and_is_not_remembered() {
        let store = scratch_store("refuse");
        let target = url("https://evil.example/collect");
        let err = check_open_endpoint(&target, &store, |_| false).unwrap_err();
        assert!(err.contains("https://evil.example"), "{err}");
        assert!(load_open_endpoints(&store).is_empty());
        // Asked again next time rather than refused silently.
        let mut asked = false;
        check_open_endpoint(&target, &store, |_| {
            asked = true;
            true
        })
        .unwrap();
        assert!(asked);
    }

    #[test]
    fn an_unauthenticated_request_is_gated_before_anything_runs() {
        let err = ai_http_request_inner(
            "POST",
            "https://evil.example/collect",
            Some("{}"),
            "none",
            Some(1),
            |_| Err("refused".to_string()),
        )
        .unwrap_err();
        assert_eq!(err, "refused");
    }

    #[test]
    fn every_prompt_shows_the_origin() {
        for l in [
            None,
            Some("en"),
            Some("fr"),
            Some("es"),
            Some("pt-BR"),
            Some("zh-CN"),
            Some("de"),
        ] {
            let p = open_endpoint_prompt(l);
            assert!(p.body.contains("{origin}"), "{l:?}");
            assert!(!p.allow.is_empty() && !p.deny.is_empty() && !p.title.is_empty());
        }
    }

    #[test]
    fn hint_never_reveals_the_middle() {
        assert_eq!(key_hint("short"), "••••••••");
        assert_eq!(key_hint("sk-ant-api03-SECRETSECRET-wxyz"), "sk-a••••wxyz");
    }
}

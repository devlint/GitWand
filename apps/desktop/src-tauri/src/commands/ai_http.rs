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
//!   OpenAI-compatible server) carries repository content too, and so does a
//!   request with a key bound to a server that does not check keys. Every
//!   request passes `check_open_endpoint`: a loopback host, a known
//!   provider, or an origin the user allowed in a native dialog
//!   shown by this module (the webview cannot answer it), remembered in the
//!   keychain next to the key (`OPEN_ENDPOINTS_ACCOUNT`, out of reach of the
//!   webview's credential and file commands). This narrows what a
//!   compromised webview can do with these two commands; it does not make the
//!   webview trusted (see the IPC scoping follow-up in ROADMAP.md).

use std::sync::{Condvar, Mutex};

use crate::commands::curl_util::{curl_transport_check, quote_config, run_curl, RequestBody};

/// Keychain service holding the AI provider API key. Backend-only: see
/// `credentials::BACKEND_ONLY_SERVICES`.
pub(crate) const AI_KEY_SERVICE: &str = "gitwand:ai";
const AI_KEY_ACCOUNT: &str = "api-key";
/// Keychain account, under the same backend-only service, holding the origins
/// the user allowed (`check_open_endpoint`), as a JSON array.
const OPEN_ENDPOINTS_ACCOUNT: &str = "open-endpoints";

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

/// Loopback hosts pass the gate without asking: a local Ollama (the default
/// `http://localhost:11434`) is no exfiltration channel.
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

/// The hosted providers GitWand defaults to pass the gate too: what reaches
/// them is not readable by whoever chose the endpoint (a script in the
/// webview with a key of its own could still read back an OpenAI completion
/// stored with `store: true`, the residual risk of a compromised webview).
const KNOWN_PROVIDER_ORIGINS: &[&str] = &["https://api.anthropic.com", "https://api.openai.com"];

/// Where the origins the user allowed are kept.
trait OriginStore {
    /// The allowed origins. Nothing stored yet is an empty list; an
    /// unreadable or corrupt value is an error, so that it is never
    /// overwritten with a single new origin.
    fn load(&self) -> Result<Vec<String>, String>;
    fn save(&self, origins: &[String]) -> Result<(), String>;
}

/// The app's store: a keychain entry under the backend-only `AI_KEY_SERVICE`,
/// which the webview can neither read nor write (`credentials`), unlike a
/// file in the data directory (`write_file` accepts any path inside a git
/// work tree, and a dotfiles repository can hold that directory).
struct KeychainOrigins;

impl KeychainOrigins {
    fn entry() -> Result<keyring::Entry, String> {
        keyring::Entry::new(AI_KEY_SERVICE, OPEN_ENDPOINTS_ACCOUNT)
            .map_err(|e| format!("keyring init failed: {}", e))
    }
}

impl OriginStore for KeychainOrigins {
    fn load(&self) -> Result<Vec<String>, String> {
        match Self::entry()?.get_password() {
            Ok(t) => serde_json::from_str(&t)
                .map_err(|e| format!("cannot parse the allowed AI endpoints: {e}")),
            Err(keyring::Error::NoEntry) => Ok(Vec::new()),
            Err(e) => Err(format!("cannot read the allowed AI endpoints: {e}")),
        }
    }

    fn save(&self, origins: &[String]) -> Result<(), String> {
        let text = serde_json::to_string(origins).map_err(|e| e.to_string())?;
        Self::entry()?
            .set_password(&text)
            .map_err(|e| format!("cannot store the allowed AI endpoints: {e}"))
    }
}

/// In-process state of the gate.
struct GateState {
    /// Origins whose question is on screen: a second request to one of them
    /// waits for that answer instead of asking again. Requests to other
    /// origins do not wait.
    asking: Vec<String>,
    /// One entry per request waiting on a question, by origin (lets a test
    /// know a request is waiting rather than sleep).
    waiting: Vec<String>,
    /// Origins allowed during this run, so an allowed origin keeps working
    /// when the store cannot be written (read-only data dir, corrupt file).
    session: Vec<String>,
}

static GATE: Mutex<GateState> = Mutex::new(GateState {
    asking: Vec::new(),
    waiting: Vec::new(),
    session: Vec::new(),
});
static GATE_ANSWERED: Condvar = Condvar::new();

fn lock_gate() -> std::sync::MutexGuard<'static, GateState> {
    GATE.lock().unwrap_or_else(|p| p.into_inner())
}

/// Ends a question however `ask` returns, a panic included (the dialog
/// plugin unwraps a channel that can close while a window goes away): the
/// origin leaves `asking` and the waiting requests wake up, rather than
/// waiting forever on an answer that will never come.
struct QuestionOpen<'a> {
    origin: &'a str,
}

impl Drop for QuestionOpen<'_> {
    fn drop(&mut self) {
        lock_gate().asking.retain(|o| o != self.origin);
        GATE_ANSWERED.notify_all();
    }
}

/// Error for a request the gate stops: `probe` when no question was shown
/// (a background load), so the message says how to get one.
fn not_allowed(locale: Option<&str>, origin: &str, probe: bool) -> String {
    let p = open_endpoint_prompt(locale);
    let text = if probe { p.not_yet } else { p.refused };
    text.replace("{origin}", origin)
}

/// The gate every AI request passes before repository content can go to
/// `target`, whatever its auth (a key works with a server that does not check
/// it, and keys bound before this gate existed were never asked about):
/// loopback and the known providers pass; any other origin must have been
/// allowed by the user. When it has not, `ask` shows the question (it gets
/// the origin and answers whether the user allowed it), or, with `ask` =
/// `None` (a background probe), the request is refused without one. A
/// refusal is not remembered: the next request asks again, but the requests
/// that were waiting on that question share its answer. `locale` is the
/// language of the refusal message.
fn check_open_endpoint(
    target: &tauri::Url,
    store: &dyn OriginStore,
    ask: Option<&dyn Fn(&str) -> bool>,
    locale: Option<&str>,
) -> Result<(), String> {
    let origin = target.origin().ascii_serialization();
    if is_loopback(target) || KNOWN_PROVIDER_ORIGINS.contains(&origin.as_str()) {
        return Ok(());
    }
    let mut state = lock_gate();
    let mut waited = false;
    loop {
        if state.session.contains(&origin) || store.load().is_ok_and(|l| l.contains(&origin)) {
            return Ok(());
        }
        if state.asking.contains(&origin) {
            state.waiting.push(origin.clone());
            state = GATE_ANSWERED.wait(state).unwrap_or_else(|p| p.into_inner());
            if let Some(i) = state.waiting.iter().position(|o| o == &origin) {
                state.waiting.remove(i);
            }
            waited = true;
            continue;
        }
        if waited {
            // The question this request waited on was answered no.
            return Err(not_allowed(locale, &origin, false));
        }
        break;
    }
    let Some(ask) = ask else {
        return Err(not_allowed(locale, &origin, true));
    };
    state.asking.push(origin.clone());
    drop(state);

    let allowed = {
        let _open = QuestionOpen { origin: &origin };
        let allowed = ask(&origin);
        if allowed {
            // Recorded before the question closes, so the requests it wakes
            // find the origin allowed.
            let mut state = lock_gate();
            state.session.push(origin.clone());
            // Persist; a store that cannot be read is left as it is.
            // Read again right before writing: another GitWand process may
            // have allowed an origin since this request loaded the list.
            let saved = store.load().and_then(|mut list| {
                if !list.contains(&origin) {
                    list.push(origin.clone());
                }
                store.save(&list)
            });
            if let Err(e) = saved {
                eprintln!("[gitwand] {origin} allowed for this session only: {e}");
            }
        }
        allowed
    };
    if allowed {
        Ok(())
    } else {
        Err(not_allowed(locale, &origin, false))
    }
}

/// Text of the native question, in the app's language (`locale` only picks
/// the language; the origin shown is the one the request goes to).
struct OpenEndpointPrompt {
    title: &'static str,
    body: &'static str,
    allow: &'static str,
    deny: &'static str,
    /// Error returned to the request the user did not allow.
    refused: &'static str,
    /// Error returned to a background load, which never asks.
    not_yet: &'static str,
}

fn open_endpoint_prompt(locale: Option<&str>) -> OpenEndpointPrompt {
    match locale.unwrap_or("en") {
        "fr" => OpenEndpointPrompt {
            title: "Autoriser ce serveur d'IA ?",
            body: "GitWand va envoyer du contenu de votre dépôt (diffs, conflits) à :\n\n{origin}\n\nAutorisez-le seulement si c'est le serveur d'IA que vous avez configuré. S'il est autorisé, GitWand ne le redemandera pas.",
            allow: "Autoriser",
            deny: "Refuser",
            refused: "Les requêtes d'IA vers {origin} ont été refusées. GitWand redemandera à la prochaine requête.",
            not_yet: "{origin} n'est pas encore autorisé : utilisez Tester ou Actualiser dans Réglages > IA pour l'autoriser.",
        },
        "es" => OpenEndpointPrompt {
            title: "¿Permitir este servidor de IA?",
            body: "GitWand va a enviar contenido de tu repositorio (diffs, conflictos) a:\n\n{origin}\n\nPermítelo solo si es el servidor de IA que configuraste. Si lo permites, GitWand no volverá a preguntar.",
            allow: "Permitir",
            deny: "Rechazar",
            refused: "Las solicitudes de IA a {origin} fueron rechazadas. GitWand volverá a preguntar en la próxima solicitud.",
            not_yet: "{origin} aún no está permitido: usa Probar o Actualizar en Ajustes > IA para permitirlo.",
        },
        "pt-BR" => OpenEndpointPrompt {
            title: "Permitir este servidor de IA?",
            body: "O GitWand vai enviar conteúdo do seu repositório (diffs, conflitos) para:\n\n{origin}\n\nPermita apenas se for o servidor de IA que você configurou. Se permitido, o GitWand não perguntará de novo.",
            allow: "Permitir",
            deny: "Recusar",
            refused: "As solicitações de IA para {origin} foram recusadas. O GitWand perguntará de novo na próxima solicitação.",
            not_yet: "{origin} ainda não está permitido: use Testar ou Atualizar em Configurações > IA para permiti-lo.",
        },
        "zh-CN" => OpenEndpointPrompt {
            title: "允许此 AI 服务器？",
            body: "GitWand 将把仓库内容（差异、冲突）发送到：\n\n{origin}\n\n仅当它是你配置的 AI 服务器时才允许。允许后，GitWand 不会再次询问。",
            allow: "允许",
            deny: "拒绝",
            refused: "已拒绝向 {origin} 发送 AI 请求。下次请求时 GitWand 会再次询问。",
            not_yet: "{origin} 尚未获得允许：请在 设置 > AI 中使用“测试”或“刷新”来允许它。",
        },
        _ => OpenEndpointPrompt {
            title: "Allow this AI server?",
            body: "GitWand is about to send repository content (diffs, conflicts) to:\n\n{origin}\n\nAllow it only if this is the AI server you configured. Once allowed, GitWand does not ask again.",
            allow: "Allow",
            deny: "Deny",
            refused: "AI requests to {origin} were refused. GitWand asks again on the next request.",
            not_yet: "{origin} is not allowed yet: use Test or Refresh in Settings > AI to allow it.",
        },
    }
}

/// Ask in a native dialog, which the webview can neither draw nor answer,
/// attached to the window the request came from so that it opens in front of
/// it (on Windows a dialog without a parent can open behind the app). Runs on
/// a blocking thread (`ai_http_request` is in `spawn_blocking`).
fn ask_open_endpoint(window: &tauri::WebviewWindow, locale: Option<&str>, origin: &str) -> bool {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    let p = open_endpoint_prompt(locale);
    window
        .dialog()
        .message(p.body.replace("{origin}", origin))
        .parent(window)
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
/// stored, `None` when nothing is. The requests that use it still pass
/// `check_open_endpoint`.
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
/// key is only ever attached to a request for the origin it is bound to, and
/// every request passes `check_open_endpoint`. `locale` is the app's
/// language, for that question; `interactive: false` (a background probe)
/// refuses an origin not yet allowed instead of asking. `timeout_secs` caps
/// the whole request; without it, the generous completion ceiling applies
/// (`COMPLETION_TIMEOUT_SECS`).
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub(crate) async fn ai_http_request(
    window: tauri::WebviewWindow,
    method: String,
    url: String,
    body: Option<String>,
    auth: String,
    timeout_secs: Option<u64>,
    locale: Option<String>,
    interactive: Option<bool>,
) -> Result<AiHttpResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let ask = |o: &str| ask_open_endpoint(&window, locale.as_deref(), o);
        let ask: Option<&dyn Fn(&str) -> bool> = match interactive {
            Some(false) => None,
            _ => Some(&ask),
        };
        let open_gate = |target: &tauri::Url| {
            check_open_endpoint(target, &KeychainOrigins, ask, locale.as_deref())
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
    let stored = if auth == "none" { None } else { read_key() };
    let headers = auth_headers(auth, stored.as_ref().map(|s| s.key.as_str()))?;
    if let Some(s) = stored.as_ref() {
        check_key_binding(s.origin.as_deref(), &target)?;
    }
    // Kept alive until curl has exited: it reads the body from this file.
    let body_file = body.map(RequestBody::new).transpose()?;
    let cfg = build_request_config(method, &target, body_file.as_ref(), &headers)?;
    // Last, whatever the auth: only a request that would actually go out
    // asks the user (and gets its origin remembered).
    open_gate(&target)?;
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

    use std::path::{Path, PathBuf};

    /// A file-backed store for the tests (the app uses the keychain).
    fn load_open_endpoints(path: &Path) -> Result<Vec<String>, String> {
        match std::fs::read_to_string(path) {
            Ok(t) => serde_json::from_str(&t).map_err(|e| e.to_string()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
            Err(e) => Err(e.to_string()),
        }
    }

    impl OriginStore for PathBuf {
        fn load(&self) -> Result<Vec<String>, String> {
            load_open_endpoints(self)
        }
        fn save(&self, origins: &[String]) -> Result<(), String> {
            std::fs::create_dir_all(self.parent().unwrap()).map_err(|e| e.to_string())?;
            std::fs::write(self, serde_json::to_string(origins).unwrap()).map_err(|e| e.to_string())
        }
    }

    fn scratch_store(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("gitwand-ai-open-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d.join("ai-open-endpoints.json")
    }

    fn yes(_: &str) -> bool {
        true
    }
    fn no(_: &str) -> bool {
        false
    }
    fn never(o: &str) -> bool {
        panic!("asked for {o}")
    }

    // The gate's session memory is process-wide: every test below uses
    // origins of its own.

    #[test]
    fn loopback_and_known_providers_pass_without_asking() {
        let store = scratch_store("loopback");
        for u in [
            "http://localhost:11434/api/chat",
            "http://LOCALHOST:11434",
            "http://127.0.0.1:11434",
            "http://127.0.0.2:8080",
            "http://[::1]:11434/api/chat",
            "https://api.anthropic.com/v1/messages",
            "https://api.openai.com/v1/models",
        ] {
            check_open_endpoint(&url(u), &store, Some(&never), None).unwrap();
            check_open_endpoint(&url(u), &store, None, None).unwrap();
        }
        assert!(!store.exists(), "nothing is remembered for them");
        for u in [
            "http://localhost.evil.example",
            "http://192.168.1.10:11434",
            "https://ollama.example.com",
            "http://0.0.0.0:11434",
        ] {
            assert!(!is_loopback(&url(u)), "{u}");
        }
        // Another scheme or port is another origin.
        assert!(check_open_endpoint(&url("http://api.openai.com"), &store, None, None).is_err());
    }

    #[test]
    fn another_origin_is_asked_once_then_remembered() {
        let store = scratch_store("remember");
        let asked = std::cell::RefCell::new(Vec::new());
        let ask = |o: &str| {
            asked.borrow_mut().push(o.to_string());
            true
        };
        check_open_endpoint(
            &url("http://10.0.0.1:11434/api/chat"),
            &store,
            Some(&ask),
            None,
        )
        .unwrap();
        assert_eq!(*asked.borrow(), vec!["http://10.0.0.1:11434".to_string()]);
        // Same origin, other path: no second question.
        check_open_endpoint(
            &url("http://10.0.0.1:11434/v1/models"),
            &store,
            Some(&never),
            None,
        )
        .unwrap();
        assert_eq!(
            load_open_endpoints(&store).unwrap(),
            vec!["http://10.0.0.1:11434".to_string()]
        );
        // Another port is another origin.
        assert!(
            check_open_endpoint(&url("http://10.0.0.1:8080"), &store, Some(&no), None).is_err()
        );
    }

    #[test]
    fn a_refusal_blocks_the_request_and_is_not_remembered() {
        let store = scratch_store("refuse");
        let target = url("https://refused.example/collect");
        let err = check_open_endpoint(&target, &store, Some(&no), None).unwrap_err();
        assert!(err.contains("https://refused.example"), "{err}");
        assert!(load_open_endpoints(&store).unwrap().is_empty());
        let asked = std::cell::Cell::new(false);
        let ask = |_: &str| {
            asked.set(true);
            true
        };
        check_open_endpoint(&target, &store, Some(&ask), None).unwrap();
        assert!(asked.get(), "asked again next time");
    }

    #[test]
    fn a_background_probe_is_refused_without_a_question() {
        let store = scratch_store("probe");
        let target = url("http://10.0.0.2:11434/api/tags");
        assert!(check_open_endpoint(&target, &store, None, None).is_err());
        check_open_endpoint(&target, &store, Some(&yes), None).unwrap();
        check_open_endpoint(&target, &store, None, None).unwrap();
    }

    #[test]
    fn a_corrupt_store_is_left_alone_and_the_origin_allowed_for_the_session() {
        let store = scratch_store("corrupt");
        std::fs::create_dir_all(store.parent().unwrap()).unwrap();
        std::fs::write(&store, "[\"http://10.0.0.3:1\", trunc").unwrap();
        assert!(load_open_endpoints(&store).is_err());
        let target = url("http://10.0.0.4:11434");
        check_open_endpoint(&target, &store, Some(&yes), None).unwrap();
        assert_eq!(
            std::fs::read_to_string(&store).unwrap(),
            "[\"http://10.0.0.3:1\", trunc"
        );
        check_open_endpoint(&target, &store, Some(&never), None).unwrap();
    }

    /// Block until a request is waiting on `origin`'s question.
    fn wait_until_waiting(origin: &str) {
        let start = std::time::Instant::now();
        while !lock_gate().waiting.iter().any(|o| o == origin) {
            assert!(
                start.elapsed() < std::time::Duration::from_secs(10),
                "never waited"
            );
            std::thread::yield_now();
        }
    }

    #[test]
    fn requests_waiting_on_a_question_share_its_answer() {
        use std::sync::mpsc;
        let store = scratch_store("concurrent");
        let (opened_tx, opened_rx) = mpsc::channel::<()>();
        let (answer_tx, answer_rx) = mpsc::channel::<bool>();
        let s1 = store.clone();
        let first = std::thread::spawn(move || {
            let ask = move |_: &str| {
                opened_tx.send(()).unwrap();
                answer_rx.recv().unwrap()
            };
            check_open_endpoint(&url("http://10.0.0.5:11434"), &s1, Some(&ask), None)
        });
        opened_rx.recv().unwrap();
        // Another origin does not wait for that question.
        assert!(check_open_endpoint(&url("http://10.0.0.6:11434"), &store, None, None).is_err());
        // The same origin waits, without a question of its own.
        let s2 = store.clone();
        let second = std::thread::spawn(move || {
            check_open_endpoint(
                &url("http://10.0.0.5:11434/api/chat"),
                &s2,
                Some(&never),
                None,
            )
        });
        wait_until_waiting("http://10.0.0.5:11434");
        answer_tx.send(false).unwrap();
        assert!(first.join().unwrap().is_err());
        assert!(second.join().unwrap().is_err(), "shares the refusal");
    }

    #[test]
    fn a_question_that_panics_does_not_block_the_next_request() {
        let store = scratch_store("panic");
        let target = url("http://10.0.0.7:11434");
        let boom = |_: &str| -> bool { panic!("dialog channel closed") };
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            check_open_endpoint(&target, &store, Some(&boom), None)
        }));
        assert!(r.is_err());
        assert!(!lock_gate()
            .asking
            .iter()
            .any(|o| o == "http://10.0.0.7:11434"));
        check_open_endpoint(&target, &store, Some(&yes), None).unwrap();
    }

    #[test]
    fn the_refusal_is_in_the_app_language() {
        let store = scratch_store("locale");
        let probe =
            check_open_endpoint(&url("http://10.0.0.8:1"), &store, None, Some("fr")).unwrap_err();
        assert!(
            probe.starts_with("http://10.0.0.8:1 n'est pas encore autorisé"),
            "{probe}"
        );
        let refused = check_open_endpoint(&url("http://10.0.0.8:1"), &store, Some(&no), Some("fr"))
            .unwrap_err();
        assert!(
            refused.starts_with("Les requêtes d'IA vers http://10.0.0.8:1 ont été refusées"),
            "{refused}"
        );
    }

    #[test]
    fn a_request_that_cannot_go_out_never_reaches_the_gate() {
        let err = ai_http_request_inner(
            "DELETE",
            "https://collector.example/v1/chat/completions",
            None,
            "none",
            Some(1),
            |_| panic!("asked for a request that fails anyway"),
        )
        .unwrap_err();
        assert!(err.contains("Unsupported method"), "{err}");
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
            assert!(p.refused.contains("{origin}"), "{l:?}");
            assert!(p.not_yet.contains("{origin}"), "{l:?}");
            assert!(!p.allow.is_empty() && !p.deny.is_empty() && !p.title.is_empty());
        }
    }

    #[test]
    fn hint_never_reveals_the_middle() {
        assert_eq!(key_hint("short"), "••••••••");
        assert_eq!(key_hint("sk-ant-api03-SECRETSECRET-wxyz"), "sk-a••••wxyz");
    }
}

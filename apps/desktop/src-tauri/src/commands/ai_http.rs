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
//! - Because the webview no longer talks to arbitrary AI hosts itself, the CSP
//!   `connect-src` can be limited to a short list of fixed hosts.

use crate::commands::curl_util::{curl_transport_check, run_curl};

/// Keychain service holding the AI provider API key. Backend-only: see
/// `credentials::BACKEND_ONLY_SERVICES`.
pub(crate) const AI_KEY_SERVICE: &str = "gitwand:ai";
const AI_KEY_ACCOUNT: &str = "api-key";

const DEFAULT_TIMEOUT_SECS: u64 = 120;
const MAX_TIMEOUT_SECS: u64 = 600;

#[derive(serde::Serialize)]
pub(crate) struct AiHttpResponse {
    pub status: i32,
    pub body: String,
}

fn key_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(AI_KEY_SERVICE, AI_KEY_ACCOUNT)
        .map_err(|e| format!("keyring init failed: {}", e))
}

fn read_key() -> Option<String> {
    let v = key_entry().ok()?.get_password().ok()?;
    let v = v.trim().to_string();
    (!v.is_empty()).then_some(v)
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

/// Store the AI API key in the keychain (an empty key clears it). Returns the
/// masked hint of what is now stored, `None` when nothing is.
#[tauri::command]
pub(crate) async fn ai_api_key_set(key: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let key = key.trim().to_string();
        let entry = key_entry()?;
        if key.is_empty() {
            return match entry.delete_password() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(None),
                Err(e) => Err(format!("Failed to delete AI API key: {}", e)),
            };
        }
        entry
            .set_password(&key)
            .map_err(|e| format!("Failed to store AI API key: {}", e))?;
        Ok(Some(key_hint(&key)))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Masked hint of the stored AI API key, `None` when none is configured.
#[tauri::command]
pub(crate) async fn ai_api_key_hint() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(|| Ok(read_key().map(|k| key_hint(&k))))
        .await
        .map_err(|e| e.to_string())?
}

/// Quote a value for a curl config file. Inside double quotes curl recognises
/// `\\`, `\"`, `\n`, `\r`, `\t`; escaping exactly those means no value — a
/// prompt full of quotes and newlines included — can close the string and
/// inject a directive of its own.
fn quote_config(v: &str) -> String {
    let mut out = String::with_capacity(v.len() + 2);
    out.push('"');
    for c in v.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            _ => out.push(c),
        }
    }
    out.push('"');
    out
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

/// Validate the request and build the curl config fed on stdin.
fn build_request_config(
    method: &str,
    url: &str,
    body: Option<&str>,
    headers: &[String],
) -> Result<String, String> {
    if !matches!(method, "GET" | "POST") {
        return Err(format!("Unsupported method: {}", method));
    }
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("AI endpoint must be an http(s) URL".to_string());
    }
    if url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("AI endpoint contains whitespace or control characters".to_string());
    }
    let mut cfg = format!("url = {}\n", quote_config(url));
    for h in headers {
        cfg.push_str(&format!("header = {}\n", quote_config(h)));
    }
    if let Some(b) = body {
        cfg.push_str("header = \"Content-Type: application/json\"\n");
        // `data-raw`, not `data`/`data-binary`: a leading `@` is never read as
        // a file name.
        cfg.push_str(&format!("data-raw = {}\n", quote_config(b)));
    }
    Ok(cfg)
}

/// Perform one AI provider HTTP request. `auth` selects how the stored key is
/// attached: `"anthropic"` (x-api-key), `"bearer"`, or `"none"` (Ollama).
#[tauri::command]
pub(crate) async fn ai_http_request(
    method: String,
    url: String,
    body: Option<String>,
    auth: String,
    timeout_secs: Option<u64>,
) -> Result<AiHttpResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        ai_http_request_inner(&method, &url, body.as_deref(), &auth, timeout_secs)
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
) -> Result<AiHttpResponse, String> {
    const MARKER: &str = "\n__GW_HTTP_STATUS__";
    let key = if auth == "none" { None } else { read_key() };
    let headers = auth_headers(auth, key.as_deref())?;
    let cfg = build_request_config(method, url, body, &headers)?;
    let timeout = timeout_secs
        .unwrap_or(DEFAULT_TIMEOUT_SECS)
        .clamp(1, MAX_TIMEOUT_SECS);
    let args: Vec<String> = vec![
        "-s".to_string(),
        "-S".to_string(),
        "-X".to_string(),
        method.to_string(),
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

    #[test]
    fn config_carries_url_headers_and_body() {
        let cfg = build_request_config(
            "POST",
            "https://api.anthropic.com/v1/messages",
            Some("{\"a\":\"b\\nc\"}"),
            &["x-api-key: k".to_string()],
        )
        .unwrap();
        assert!(cfg.contains("url = \"https://api.anthropic.com/v1/messages\"\n"));
        assert!(cfg.contains("header = \"x-api-key: k\"\n"));
        assert!(cfg.contains("data-raw = \"{\\\"a\\\":\\\"b\\\\nc\\\"}\"\n"));
    }

    #[test]
    fn rejects_bad_method_scheme_and_control_chars() {
        assert!(build_request_config("DELETE", "https://x", None, &[]).is_err());
        assert!(build_request_config("GET", "file:///etc/passwd", None, &[]).is_err());
        assert!(build_request_config("GET", "https://x/\nheader", None, &[]).is_err());
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

    #[test]
    fn hint_never_reveals_the_middle() {
        assert_eq!(key_hint("short"), "••••••••");
        assert_eq!(key_hint("sk-ant-api03-SECRETSECRET-wxyz"), "sk-a••••wxyz");
    }
}

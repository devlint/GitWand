//! Shared curl transport helpers for the forge command modules.

use crate::git::hidden_cmd;
use std::io::Write;

/// Build curl `--config -` file contents for an `Authorization` header,
/// keeping the credential off the process argv.
///
/// `scheme` is e.g. `"Bearer"` or `"Basic"`, `credential` is the pre-encoded
/// token or base64 value. Callers that need Basic auth should base64-encode
/// `"user:pass"` before passing it here.
pub(crate) fn auth_header_config(scheme: &str, credential: &str) -> String {
    format!("header = \"Authorization: {} {}\"\n", scheme, credential)
}

/// Build a Bearer-token curl config-file string.
pub(crate) fn bearer_config(tok: &str) -> String {
    auth_header_config("Bearer", tok)
}

/// Spawn `curl` with `args`, feeding `stdin_config` to its stdin when
/// provided (used with `--config -` so secrets stay off argv).
pub(crate) fn run_curl(
    args: &[String],
    stdin_config: Option<&str>,
) -> Result<std::process::Output, String> {
    use std::process::Stdio;
    let mut cmd = hidden_cmd("curl");
    cmd.args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(match stdin_config {
            Some(_) => Stdio::piped(),
            None    => Stdio::null(),
        });
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("curl not found or failed to spawn: {}", e))?;
    if let Some(cfg) = stdin_config {
        // Config is tiny; curl drains stdin before producing output, so a
        // synchronous write here can't deadlock against the stdout pipe.
        child
            .stdin
            .take()
            .ok_or_else(|| "failed to open curl stdin".to_string())?
            .write_all(cfg.as_bytes())
            .map_err(|e| format!("failed to write curl config: {}", e))?;
    }
    child
        .wait_with_output()
        .map_err(|e| format!("curl failed: {}", e))
}

/// Decide whether a finished `curl` invocation represents a transport failure
/// and, if so, build a user-facing error.
///
/// curl exits non-zero only on *transport* problems (DNS, connection, TLS,
/// library-load failures) — an HTTP 4xx/5xx still exits 0 and is handled by the
/// caller via the response status. The empty-diagnostic branch is the AppImage
/// bundled-library case from issue #48: without this, an empty body fell
/// through to `serde_json` as a cryptic "EOF while parsing" error.
///
/// `code` is the process exit code (`None` if killed by a signal); `stderr` is
/// curl's captured standard error (populated thanks to `--show-error`).
fn curl_transport_check(success: bool, code: Option<i32>, stderr: &str) -> Result<(), String> {
    if success {
        return Ok(());
    }
    let code_str = code.map(|c| c.to_string()).unwrap_or_else(|| "signal".to_string());
    let detail = stderr.trim();
    if detail.is_empty() {
        Err(format!(
            "curl request failed (exit {code_str}) with no diagnostic output — \
             this often means a bundled-library conflict in the packaged app"
        ))
    } else {
        Err(format!("curl request failed (exit {code_str}): {detail}"))
    }
}

/// Execute a curl request and return `(http_status, body_text)`.
///
/// Appends `-w "\n__GW_HTTP_STATUS__%{http_code}"` so the HTTP status is
/// extracted from the output without a second request. `auth_config`, when
/// present, is fed to curl via `--config -` (stdin) so secrets stay off argv.
/// `extra_headers` carries forge-specific static headers (e.g. `User-Agent`,
/// API-version headers). `accept` is the MIME type for the `Accept` header.
pub(crate) fn curl_with_status(
    method: &str,
    url: &str,
    auth_config: Option<&str>,
    body_json: Option<&str>,
    extra_headers: &[&str],
    accept: &str,
) -> Result<(i32, String), String> {
    const MARKER: &str = "\n__GW_HTTP_STATUS__";
    let mut args: Vec<String> = vec![
        "-s".to_string(),
        "-S".to_string(), // --show-error: keep stderr diagnostics under -s
        "-X".to_string(), method.to_string(),
        "-H".to_string(), format!("Accept: {}", accept),
    ];
    for h in extra_headers {
        args.push("-H".to_string());
        args.push(h.to_string());
    }
    if auth_config.is_some() {
        args.push("--config".to_string());
        args.push("-".to_string());
    }
    if let Some(b) = body_json {
        args.push("-H".to_string());
        args.push("Content-Type: application/json".to_string());
        args.push("-d".to_string());
        args.push(b.to_string());
    }
    args.push("-w".to_string());
    args.push(format!("{}%{{http_code}}", MARKER));
    args.push(url.to_string());

    let output = run_curl(&args, auth_config)?;
    // A non-zero curl exit is a transport failure (DNS/TLS/connection/library
    // load) — surface it instead of letting an empty body reach the JSON
    // parser as a cryptic "EOF" error.
    curl_transport_check(
        output.status.success(),
        output.status.code(),
        &String::from_utf8_lossy(&output.stderr),
    )?;
    // Consume the Vec<u8> in-place — zero copy on the valid-UTF-8 fast path.
    let combined = String::from_utf8(output.stdout)
        .map_err(|e| format!("curl returned invalid UTF-8: {}", e))?;
    let (body, status) = match combined.rsplit_once(MARKER) {
        Some((b, s)) => (b.to_string(), s.trim().parse::<i32>().unwrap_or(0)),
        None => (combined, 0),
    };
    Ok((status, body))
}

/// Like [`curl_with_status`], but also dumps the response headers (`-D -`) so the
/// caller can read values such as `ETag`. Returns `(status, headers, body)` where
/// `headers` maps lowercased header names to their values (case-insensitive
/// lookup). Works across curl versions — no dependency on newer `%header{}` /
/// `%{header_json}` write-out variables.
///
/// We don't follow redirects (no `-L`), so exactly one header block precedes the
/// body; the trailing status marker is stripped before splitting the two.
pub(crate) fn curl_with_headers(
    method: &str,
    url: &str,
    auth_config: Option<&str>,
    body_json: Option<&str>,
    extra_headers: &[&str],
    accept: &str,
) -> Result<(i32, std::collections::HashMap<String, String>, String), String> {
    const MARKER: &str = "\n__GW_HTTP_STATUS__";
    let mut args: Vec<String> = vec![
        "-s".to_string(),
        "-S".to_string(),
        "-D".to_string(), "-".to_string(), // dump response headers to stdout
        "-X".to_string(), method.to_string(),
        "-H".to_string(), format!("Accept: {}", accept),
    ];
    for h in extra_headers {
        args.push("-H".to_string());
        args.push(h.to_string());
    }
    if auth_config.is_some() {
        args.push("--config".to_string());
        args.push("-".to_string());
    }
    if let Some(b) = body_json {
        args.push("-H".to_string());
        args.push("Content-Type: application/json".to_string());
        args.push("-d".to_string());
        args.push(b.to_string());
    }
    args.push("-w".to_string());
    args.push(format!("{}%{{http_code}}", MARKER));
    args.push(url.to_string());

    let output = run_curl(&args, auth_config)?;
    curl_transport_check(
        output.status.success(),
        output.status.code(),
        &String::from_utf8_lossy(&output.stderr),
    )?;
    let combined = String::from_utf8(output.stdout)
        .map_err(|e| format!("curl returned invalid UTF-8: {}", e))?;
    let (head_and_body, status) = match combined.rsplit_once(MARKER) {
        Some((hb, s)) => (hb, s.trim().parse::<i32>().unwrap_or(0)),
        None => (combined.as_str(), 0),
    };
    // Header block is terminated by a blank line; the body is everything after.
    let (headers_raw, body) = head_and_body
        .split_once("\r\n\r\n")
        .or_else(|| head_and_body.split_once("\n\n"))
        .unwrap_or(("", head_and_body));
    let headers = parse_response_headers(headers_raw);
    Ok((status, headers, body.to_string()))
}

/// Parse a raw HTTP header block into a lowercased-key map. The `HTTP/…` status
/// line and any malformed (colon-less) lines are skipped.
fn parse_response_headers(raw: &str) -> std::collections::HashMap<String, String> {
    let mut map = std::collections::HashMap::new();
    for line in raw.lines() {
        let line = line.trim_end();
        if line.is_empty() || line.starts_with("HTTP/") {
            continue;
        }
        if let Some((k, v)) = line.split_once(':') {
            map.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
        }
    }
    map
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_headers_lowercases_and_skips_status_line() {
        let raw = "HTTP/2 200\r\nETag: \"abc123\"\r\nContent-Type: application/json";
        let h = parse_response_headers(raw);
        assert_eq!(h.get("etag").map(String::as_str), Some("\"abc123\""));
        assert_eq!(h.get("content-type").map(String::as_str), Some("application/json"));
        assert!(!h.contains_key("http/2 200"));
    }

    #[test]
    fn transport_ok_when_curl_succeeds() {
        assert!(curl_transport_check(true, Some(0), "").is_ok());
        // A non-empty stderr is irrelevant when curl exited successfully.
        assert!(curl_transport_check(true, Some(0), "Note: using HTTP/2").is_ok());
    }

    #[test]
    fn transport_error_surfaces_curl_stderr() {
        let err = curl_transport_check(
            false,
            Some(35),
            "curl: (35) OpenSSL/3.0: error:0A000086:SSL routines",
        )
        .unwrap_err();
        assert!(err.contains("exit 35"), "got: {err}");
        assert!(err.contains("error:0A000086"), "got: {err}");
    }

    #[test]
    fn transport_error_explains_empty_diagnostic() {
        // The AppImage bundled-library case: curl dies with no stderr at all.
        let err = curl_transport_check(false, Some(127), "  \n").unwrap_err();
        assert!(err.contains("exit 127"), "got: {err}");
        assert!(err.contains("bundled-library"), "got: {err}");
    }

    #[test]
    fn transport_error_handles_signal_kill() {
        let err = curl_transport_check(false, None, "").unwrap_err();
        assert!(err.contains("signal"), "got: {err}");
    }
}

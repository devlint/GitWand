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
            None => Stdio::null(),
        });
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("curl not found or failed to spawn: {}", e))?;
    if let Some(cfg) = stdin_config {
        // curl reads the whole config (auth header, request body) before it
        // sends anything, so a synchronous write can't deadlock against the
        // stdout pipe.
        let written = match child.stdin.take() {
            Some(mut stdin) => stdin.write_all(cfg.as_bytes()),
            None => Err(std::io::Error::other("failed to open curl stdin")),
        };
        if let Err(e) = written {
            // curl stopped reading (a bad config, an early exit): reap it and
            // report its own diagnostic rather than the broken pipe.
            let stderr = child
                .wait_with_output()
                .ok()
                .map(|o| String::from_utf8_lossy(&o.stderr).trim().to_string())
                .filter(|s| !s.is_empty());
            return Err(match stderr {
                Some(diag) => format!("curl failed: {}", diag),
                None => format!("failed to write curl config: {}", e),
            });
        }
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
pub(crate) fn curl_transport_check(
    success: bool,
    code: Option<i32>,
    stderr: &str,
) -> Result<(), String> {
    if success {
        return Ok(());
    }
    let code_str = code
        .map(|c| c.to_string())
        .unwrap_or_else(|| "signal".to_string());
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

/// Quote a value for a curl config file. Inside double quotes curl recognises
/// `\\`, `\"`, `\n`, `\r`, `\t`; escaping exactly those means no value — a
/// prompt or an issue body full of quotes and newlines included — can close
/// the string and inject a directive of its own. Shared by every curl caller
/// that writes a config (forge requests, AI HTTP providers).
pub(crate) fn quote_config(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Bodies up to this many bytes go inline in the stdin config; larger ones
/// through a file. Escaping at most doubles a byte, so an inline line stays
/// below the 100 KiB curl 7.x accepts.
const INLINE_MAX: usize = 48 * 1024;

/// A request body for curl's stdin config, never on argv (visible to other
/// processes, capped on Windows).
///
/// Up to [`INLINE_MAX`] it goes inline (`data-raw`). Beyond, through a file
/// (`data-binary = "@path"`): curl before 8.x silently drops a config line of
/// 100 KiB or more and sends the request with no body (exit 0). The file is
/// private to the user (0600 on Unix) and removed on drop, so keep the value
/// alive until curl has exited. Inline is the default because a file path
/// curl cannot open (a non-ASCII temp dir on an old Windows curl) would fail
/// every write, not just the rare large one.
pub(crate) struct RequestBody {
    line: String,
    path: Option<std::path::PathBuf>,
}

impl RequestBody {
    pub(crate) fn new(body: &str) -> Result<Self, String> {
        if body.len() <= INLINE_MAX {
            return Ok(RequestBody {
                // `data-raw`: a leading `@` is never read as a file name.
                line: format!("data-raw = {}\n", quote_config(body)),
                path: None,
            });
        }
        use std::sync::atomic::{AtomicU64, Ordering};
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let path = std::env::temp_dir().join(format!(
            "gitwand-body-{}-{}-{}",
            std::process::id(),
            nanos,
            SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut opts, 0o600);
        let fail = |e: std::io::Error| format!("failed to write the request body: {}", e);
        // Owned (and so removed on drop) only once this call created it.
        let mut f = opts.open(&path).map_err(fail)?;
        let file = RequestBody {
            line: format!(
                "data-binary = {}\n",
                quote_config(&format!("@{}", path.display()))
            ),
            path: Some(path),
        };
        f.write_all(body.as_bytes()).map_err(fail)?;
        Ok(file)
    }

    /// The file the body was written to, if it was too large to go inline.
    #[cfg(test)]
    pub(crate) fn path(&self) -> Option<&std::path::Path> {
        self.path.as_deref()
    }

    /// The config line that makes curl send the body as it is.
    pub(crate) fn config_line(&self) -> String {
        self.line.clone()
    }
}

impl Drop for RequestBody {
    fn drop(&mut self) {
        if let Some(p) = &self.path {
            let _ = std::fs::remove_file(p);
        }
    }
}

/// Written after the body by curl's `-w` and split off by the parsers: one
/// constant, so the writer and the readers cannot drift apart.
const MARKER: &str = "\n__GW_HTTP_STATUS__";

/// How a [`curl_request`] reads its answer and how long it may take.
#[derive(Clone, Copy, Default)]
pub(crate) struct RequestOpts {
    /// Dump the response headers to stdout (`-D -`).
    pub(crate) dump_headers: bool,
    /// curl `--max-time`; `None` leaves the duration unbounded.
    pub(crate) max_time_secs: Option<u32>,
    /// Follow redirects (`-L`). Off by default: a write must not be re-sent
    /// to another address.
    pub(crate) follow_redirects: bool,
}

/// The curl argv and `--config -` stdin for a request. The auth header and the
/// request body both go through the stdin config, never argv: a body can be
/// long (Windows caps a command line at 32 767 characters) and carries user
/// text any local user could read with `ps` while curl runs.
fn curl_request(
    method: &str,
    url: &str,
    auth_config: Option<&str>,
    body: Option<&RequestBody>,
    extra_headers: &[&str],
    accept: &str,
    opts: RequestOpts,
) -> (Vec<String>, Option<String>) {
    let RequestOpts {
        dump_headers,
        max_time_secs,
        follow_redirects,
    } = opts;
    let mut args: Vec<String> = vec![
        "-s".to_string(),
        "-S".to_string(), // --show-error: keep stderr diagnostics under -s
        "--connect-timeout".to_string(),
        "20".to_string(),
    ];
    if follow_redirects {
        args.push("-L".to_string());
    }
    if let Some(secs) = max_time_secs {
        // Only where the caller asks: a forge write (a large merge) may
        // legitimately take longer than any fixed limit.
        args.push("--max-time".to_string());
        args.push(secs.to_string());
    }
    if dump_headers {
        args.push("-D".to_string());
        args.push("-".to_string()); // dump response headers to stdout
    }
    args.extend([
        "-X".to_string(),
        method.to_string(),
        "-H".to_string(),
        format!("Accept: {}", accept),
    ]);
    for h in extra_headers {
        args.push("-H".to_string());
        args.push(h.to_string());
    }
    let mut config = auth_config.unwrap_or_default().to_string();
    if let Some(b) = body {
        args.push("-H".to_string());
        args.push("Content-Type: application/json".to_string());
        config.push_str(&b.config_line());
    }
    let stdin = (!config.is_empty()).then_some(config);
    if stdin.is_some() {
        args.push("--config".to_string());
        args.push("-".to_string());
    }
    args.push("-w".to_string());
    args.push(format!("{}%{{http_code}}", MARKER));
    args.push(url.to_string());
    (args, stdin)
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
    curl_with_status_bounded(
        method,
        url,
        auth_config,
        body_json,
        extra_headers,
        accept,
        RequestOpts::default(),
    )
}

/// [`curl_with_status`] with [`RequestOpts`]: a duration bound, redirects.
pub(crate) fn curl_with_status_bounded(
    method: &str,
    url: &str,
    auth_config: Option<&str>,
    body_json: Option<&str>,
    extra_headers: &[&str],
    accept: &str,
    opts: RequestOpts,
) -> Result<(i32, String), String> {
    let body = body_json.map(RequestBody::new).transpose()?;
    let (args, stdin) = curl_request(
        method,
        url,
        auth_config,
        body.as_ref(),
        extra_headers,
        accept,
        RequestOpts {
            dump_headers: false,
            ..opts
        },
    );
    let output = run_curl(&args, stdin.as_deref())?;
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
/// Bounded by curl `--max-time` when `max_time_secs` is set (`None`: unbounded).
pub(crate) fn curl_with_headers(
    method: &str,
    url: &str,
    auth_config: Option<&str>,
    body_json: Option<&str>,
    extra_headers: &[&str],
    accept: &str,
    max_time_secs: Option<u32>,
) -> Result<(i32, std::collections::HashMap<String, String>, String), String> {
    let body = body_json.map(RequestBody::new).transpose()?;
    let (args, stdin) = curl_request(
        method,
        url,
        auth_config,
        body.as_ref(),
        extra_headers,
        accept,
        RequestOpts {
            dump_headers: true,
            max_time_secs,
            ..RequestOpts::default()
        },
    );
    let output = run_curl(&args, stdin.as_deref())?;
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
        assert_eq!(
            h.get("content-type").map(String::as_str),
            Some("application/json")
        );
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

    #[test]
    fn a_small_body_stays_inline_with_no_file() {
        let body = RequestBody::new("{\"a\":\"@x\"}").unwrap();
        assert!(body.path().is_none());
        // `data-raw`: a leading `@` is never read as a file name.
        assert_eq!(
            body.config_line(),
            "data-raw = \"{\\\"a\\\":\\\"@x\\\"}\"\n"
        );
    }

    #[test]
    fn a_large_body_goes_through_a_private_file_removed_on_drop() {
        let body = format!("{{\"b\":\"{}\"}}", "é — 日本 \\\" $HOME\\n".repeat(5000));
        let file = RequestBody::new(&body).unwrap();
        let path = file.path().unwrap().to_path_buf();
        assert_eq!(std::fs::read(&path).unwrap(), body.as_bytes());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        assert_eq!(
            file.config_line(),
            format!(
                "data-binary = {}\n",
                quote_config(&format!("@{}", path.display()))
            )
        );
        drop(file);
        assert!(!path.exists());
    }

    #[test]
    fn the_inline_limit_keeps_config_lines_under_curls_100_kib() {
        // The largest inline body still makes a line well below 100 KiB, even
        // when every character needs escaping.
        let worst = "\"".repeat(INLINE_MAX);
        let line = RequestBody::new(&worst).unwrap().config_line();
        assert!(line.len() < 100 * 1024, "{}", line.len());
        // One byte more and it goes to a file.
        assert!(RequestBody::new(&"x".repeat(INLINE_MAX + 1))
            .unwrap()
            .path()
            .is_some());
    }

    #[test]
    fn two_body_files_never_share_a_path() {
        let big = "x".repeat(INLINE_MAX + 1);
        let a = RequestBody::new(&big).unwrap();
        let b = RequestBody::new(&big).unwrap();
        assert_ne!(a.path(), b.path());
    }

    /// curl before 8.x silently drops a config line of 100 KiB or more (the
    /// request then goes out with no body and curl exits 0): the body is read
    /// from a file, so no config line grows with it.
    #[test]
    fn request_body_goes_through_a_body_file_not_argv_or_a_config_line() {
        let body = format!("{{\"body\":\"{}\"}}", "secret ".repeat(30_000));
        let file = RequestBody::new(&body).unwrap();
        let (args, cfg) = curl_request(
            "POST",
            "https://api.github.com/x",
            Some("header = \"Authorization: Bearer t\"\n"),
            Some(&file),
            &[],
            "application/json",
            RequestOpts::default(),
        );
        assert!(args.iter().all(|a| !a.contains("secret")), "{:?}", args);
        assert!(args.windows(2).any(|w| w[0] == "--config" && w[1] == "-"));
        let cfg = cfg.unwrap();
        assert!(cfg.starts_with("header = \"Authorization: Bearer t\"\n"));
        assert!(!cfg.contains("secret"));
        assert!(cfg.ends_with(&file.config_line()));
        assert!(cfg.lines().all(|l| l.len() < 1024), "{cfg}");
    }

    #[test]
    fn body_without_auth_still_uses_stdin_config() {
        let file = RequestBody::new("{}").unwrap();
        let (args, cfg) = curl_request(
            "POST",
            "u",
            None,
            Some(&file),
            &[],
            "a",
            RequestOpts::default(),
        );
        assert!(args.windows(2).any(|w| w[0] == "--config" && w[1] == "-"));
        assert_eq!(cfg, Some(file.config_line()));
    }

    #[test]
    fn no_body_no_auth_no_stdin() {
        let (args, cfg) = curl_request("GET", "u", None, None, &[], "a", RequestOpts::default());
        assert!(!args.iter().any(|a| a == "--config"));
        assert!(cfg.is_none());
    }

    #[test]
    fn config_quoting_escapes_what_curl_unescapes() {
        assert_eq!(
            quote_config("a\\b\"c\nd\re\tf"),
            "\"a\\\\b\\\"c\\nd\\re\\tf\""
        );
    }

    #[test]
    fn header_dump_flag_only_when_asked() {
        let (with, _) = curl_request(
            "GET",
            "u",
            None,
            None,
            &[],
            "a",
            RequestOpts {
                dump_headers: true,
                ..RequestOpts::default()
            },
        );
        let (without, _) = curl_request("GET", "u", None, None, &[], "a", RequestOpts::default());
        assert!(with.windows(2).any(|w| w[0] == "-D" && w[1] == "-"));
        assert!(!without.iter().any(|a| a == "-D"));
    }

    /// Real curl against a local server: the body curl sends is byte-for-byte
    /// what was given (quotes, backslashes, newlines, `$`, `--flag` lines,
    /// non-ASCII), at a size whose inline config line (> 100 KiB) curl 7.x
    /// would have dropped without a word.
    #[test]
    fn curl_sends_the_body_verbatim() {
        use std::io::{Read, Write as _};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut sock, _) = listener.accept().unwrap();
            let mut buf = Vec::new();
            let mut chunk = [0u8; 65536];
            loop {
                let n = sock.read(&mut chunk).unwrap();
                buf.extend_from_slice(&chunk[..n]);
                // Bytes, not text: a read may end inside a UTF-8 sequence.
                if let Some(end) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                    let head = String::from_utf8_lossy(&buf[..end]).to_ascii_lowercase();
                    let len: usize = head
                        .lines()
                        .find_map(|l| l.strip_prefix("content-length:"))
                        .map(|v| v.trim().parse().unwrap())
                        .unwrap_or(0);
                    let body = &buf[end + 4..];
                    if body.len() >= len {
                        let _ = sock.write_all(
                            b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}",
                        );
                        return String::from_utf8(body[..len].to_vec()).unwrap();
                    }
                }
                if n == 0 {
                    return String::new();
                }
            }
        });
        let payload = serde_json::json!({
            "title": "t",
            "body": "a \"q\" \\ $HOME\n--flag\r\n\té — 日本\n".repeat(4000),
        })
        .to_string();
        assert!(quote_config(&payload).len() > 100 * 1024);
        let (status, _) = curl_with_status(
            "POST",
            &format!("http://127.0.0.1:{}/x", port),
            None,
            Some(&payload),
            &[],
            "application/json",
        )
        .unwrap();
        assert_eq!(status, 200);
        assert_eq!(server.join().unwrap(), payload);
    }

    #[test]
    fn every_request_bounds_its_connection_and_only_asked_ones_their_duration() {
        let has = |args: &[String], flag: &str, v: &str| {
            args.windows(2).any(|w| w[0] == flag && w[1] == v)
        };
        let (get, _) = curl_request("GET", "u", None, None, &[], "a", RequestOpts::default());
        let file = RequestBody::new("{}").unwrap();
        let (post, _) = curl_request(
            "POST",
            "u",
            None,
            Some(&file),
            &[],
            "a",
            RequestOpts::default(),
        );
        let (bounded, _) = curl_request(
            "POST",
            "u",
            None,
            Some(&file),
            &[],
            "a",
            RequestOpts {
                max_time_secs: Some(60),
                ..RequestOpts::default()
            },
        );
        assert!(has(&get, "--connect-timeout", "20"));
        assert!(has(&post, "--connect-timeout", "20"));
        // Only a caller that asks is bounded: a forge write (a large merge)
        // may legitimately take longer than any fixed limit.
        assert!(!post.iter().any(|a| a == "--max-time"));
        assert!(has(&bounded, "--max-time", "60"));
        assert!(!post.iter().any(|a| a == "-L"));
        let follow = RequestOpts {
            follow_redirects: true,
            ..RequestOpts::default()
        };
        let (followed, _) = curl_request("GET", "u", None, None, &[], "a", follow);
        assert!(followed.iter().any(|a| a == "-L"));
    }
}

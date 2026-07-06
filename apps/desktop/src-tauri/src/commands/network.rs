//! Connectivity probe for the Mode hors-ligne (F1) feature.
//!
//! Exposes a single Tauri command — [`check_remote_reachable`] — that returns
//! `true` when a TCP connection to the host extracted from a git remote URL
//! succeeds within `timeout_ms`, `false` otherwise.
//!
//! We deliberately do NOT add an HTTP client dependency (no `reqwest`,
//! `ureq`, etc.). A bare TCP connect to host:port is enough to tell apart
//! "the server is reachable" from "no network / firewalled / DNS down":
//!
//!   - **HTTPS remote** (`https://host[:port]/path`)  → connect to `host:443`
//!     (or the explicit `:port` if present). Any successful TCP handshake
//!     counts as reachable — we don't care whether the HTTP layer would
//!     return 401/403/200, only whether the network path exists.
//!   - **SSH remote** (`git@host:owner/repo.git` or `ssh://[user@]host[:port]/…`)
//!     → connect to `host:22` (or the explicit port).
//!   - **git://** protocol → connect to `host:9418`.
//!   - Any unrecognised scheme falls back to a best-effort parse; if no host
//!     can be extracted we return `false` rather than guess.
//!
//! This is browser-safe (no `packages/core` impact) and adds zero dependencies.
//! The probe runs synchronously in the Tauri command thread; `TcpStream::
//! connect_timeout` bounds the wait so a dropped wifi connection cannot
//! freeze the UI.
//!
//! (This module still adds no direct HTTP dependency; an HTTP client only
//! exists transitively via the Aptabase telemetry plugin.)

use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::time::Duration;

/// Parsed (host, port) pair from a git remote URL. Returned by
/// [`parse_remote_host_port`] for the unit-testable extraction step.
#[derive(Debug, PartialEq, Eq)]
struct HostPort {
    host: String,
    port: u16,
}

/// Extract `(host, port)` from a git remote URL.
///
/// Returns `None` when the input is empty, contains no usable host, or uses
/// a scheme we don't recognise. Whitespace is trimmed off the input first
/// because `git remote get-url` sometimes returns a trailing newline.
fn parse_remote_host_port(url: &str) -> Option<HostPort> {
    let url = url.trim();
    if url.is_empty() {
        return None;
    }

    // SCP-style SSH: `git@host:owner/repo[.git]`
    //   - the bit before the colon is `[user@]host`
    //   - port is always 22 (SCP syntax has no port slot)
    // We check this BEFORE the scheme-based branches because `git@host:…`
    // does not start with `git://` and would otherwise hit the "unknown"
    // fallback. The marker is "`@` before a `:` AND no `://`".
    if !url.contains("://") {
        if let Some(colon_idx) = url.find(':') {
            let userhost = &url[..colon_idx];
            // Strip optional `user@`
            let host = match userhost.rfind('@') {
                Some(at) => &userhost[at + 1..],
                None => userhost,
            };
            if !host.is_empty() {
                return Some(HostPort {
                    host: host.to_string(),
                    port: 22,
                });
            }
        }
    }

    // URL-style: scheme://[user@]host[:port]/path
    let (scheme, rest) = url.split_once("://")?;
    let scheme_lc = scheme.to_ascii_lowercase();
    let default_port: u16 = match scheme_lc.as_str() {
        "https" => 443,
        "http" => 80,
        "ssh" => 22,
        "git" => 9418,
        _ => return None,
    };
    // Drop the path / query / fragment.
    let authority = rest
        .split(|c: char| c == '/' || c == '?' || c == '#')
        .next()
        .unwrap_or("");
    // Strip optional `user[:password]@`.
    let host_port = match authority.rfind('@') {
        Some(at) => &authority[at + 1..],
        None => authority,
    };
    if host_port.is_empty() {
        return None;
    }
    // IPv6 literals: `[::1]:443` — split on the closing bracket if present,
    // otherwise on the last colon.
    let (host, port) = if let Some(stripped) = host_port.strip_prefix('[') {
        match stripped.find(']') {
            Some(end) => {
                let host = &stripped[..end];
                let after = &stripped[end + 1..];
                let port = after
                    .strip_prefix(':')
                    .and_then(|s| s.parse::<u16>().ok())
                    .unwrap_or(default_port);
                (host.to_string(), port)
            }
            None => return None,
        }
    } else {
        match host_port.rsplit_once(':') {
            Some((h, p)) => {
                let port = p.parse::<u16>().unwrap_or(default_port);
                (h.to_string(), port)
            }
            None => (host_port.to_string(), default_port),
        }
    };
    if host.is_empty() {
        return None;
    }
    Some(HostPort { host, port })
}

/// Try to open a TCP connection to `host:port` within the timeout.
/// Returns `true` only if the handshake completes successfully.
fn tcp_probe(host: &str, port: u16, timeout: Duration) -> bool {
    // Resolve the host (DNS). `to_socket_addrs` may itself block, but it
    // honours the system resolver timeout; in practice this returns fast
    // on a working network and fast-fails on no-network.
    let addrs: Vec<SocketAddr> = match (host, port).to_socket_addrs() {
        Ok(it) => it.collect(),
        Err(_) => return false,
    };
    for addr in addrs {
        if TcpStream::connect_timeout(&addr, timeout).is_ok() {
            return true;
        }
    }
    false
}

/// Probe whether the host behind a git remote URL is reachable.
///
/// Returns `Ok(true)` when a TCP connection to the parsed host:port succeeds
/// before `timeout_ms` elapses, `Ok(false)` otherwise.  Never returns `Err`
/// — connectivity failures are an expected operating mode, not an exception.
///
/// `timeout_ms = 0` is normalised to a small floor (250 ms) so the caller
/// cannot accidentally turn the probe into a zero-wait fast-fail.
#[tauri::command]
pub(crate) async fn check_remote_reachable(url: String, timeout_ms: u64) -> Result<bool, String> {
    let parsed = match parse_remote_host_port(&url) {
        Some(p) => p,
        None => return Ok(false),
    };
    let ms = timeout_ms.max(250);
    let timeout = Duration::from_millis(ms);

    // Connectivity philosophy: we want to know whether the user can reach
    // the host at all, not whether the specific protocol they use for git
    // is open. Corporate networks (Dendreo, many enterprise VPNs) routinely
    // block outbound port 22 while letting HTTPS through, so SSH remotes
    // would falsely report "Offline" even though `git fetch` works through
    // a proxy or tunnel. Probe HTTPS/443 first — it's universally open
    // anywhere there's internet — and fall back to the URL-derived port
    // only if 443 fails (catches enterprise SSH-only hosts).
    const HTTPS_PORT: u16 = 443;
    if tcp_probe(&parsed.host, HTTPS_PORT, timeout) {
        return Ok(true);
    }
    if parsed.port != HTTPS_PORT && tcp_probe(&parsed.host, parsed.port, timeout) {
        return Ok(true);
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_https_with_default_port() {
        let p = parse_remote_host_port("https://github.com/foo/bar.git").unwrap();
        assert_eq!(p.host, "github.com");
        assert_eq!(p.port, 443);
    }

    #[test]
    fn parses_https_with_explicit_port() {
        let p = parse_remote_host_port("https://git.example.com:8443/foo/bar.git").unwrap();
        assert_eq!(p.host, "git.example.com");
        assert_eq!(p.port, 8443);
    }

    #[test]
    fn parses_https_with_credentials() {
        let p = parse_remote_host_port("https://user:tok@git.example.com/foo/bar").unwrap();
        assert_eq!(p.host, "git.example.com");
        assert_eq!(p.port, 443);
    }

    #[test]
    fn parses_scp_ssh_form() {
        let p = parse_remote_host_port("git@github.com:foo/bar.git").unwrap();
        assert_eq!(p.host, "github.com");
        assert_eq!(p.port, 22);
    }

    #[test]
    fn parses_ssh_url_with_port() {
        let p = parse_remote_host_port("ssh://git@github.com:2222/foo/bar.git").unwrap();
        assert_eq!(p.host, "github.com");
        assert_eq!(p.port, 2222);
    }

    #[test]
    fn parses_git_protocol() {
        let p = parse_remote_host_port("git://github.com/foo/bar.git").unwrap();
        assert_eq!(p.host, "github.com");
        assert_eq!(p.port, 9418);
    }

    #[test]
    fn parses_ipv6() {
        let p = parse_remote_host_port("https://[::1]:8443/foo.git").unwrap();
        assert_eq!(p.host, "::1");
        assert_eq!(p.port, 8443);
    }

    #[test]
    fn empty_or_blank_returns_none() {
        assert!(parse_remote_host_port("").is_none());
        assert!(parse_remote_host_port("   ").is_none());
    }

    #[test]
    fn unknown_scheme_returns_none() {
        assert!(parse_remote_host_port("ftp://example.com/foo").is_none());
    }

    #[test]
    fn check_remote_reachable_invalid_url_returns_false() {
        // Empty string is a valid input from the caller's point of view but
        // we can't extract a host, so it must short-circuit to false rather
        // than block on DNS or surface an error.
        let r = tauri::async_runtime::block_on(check_remote_reachable("".to_string(), 250)).unwrap();
        assert!(!r);
    }

    #[test]
    fn check_remote_reachable_unreachable_host_returns_false_within_timeout() {
        // RFC 5737 reserved range — guaranteed to never route. Even with a
        // 250ms timeout we expect a clean `false`, not a hang.
        let r = tauri::async_runtime::block_on(check_remote_reachable(
            "https://192.0.2.1/foo.git".to_string(),
            250,
        ))
        .unwrap();
        assert!(!r);
    }
}

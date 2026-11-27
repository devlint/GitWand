//! `gwimg:` — remote images (avatars, README badges, images in a PR the
//! user accepted) fetched by the backend instead of the webview, so the CSP
//! can keep `img-src` to `'self' data: blob:` and this scheme instead of any
//! `https:`/`http:` host. The forge hosts that serve avatars cannot be listed
//! up front (self-hosted GitLab, Gitea, Azure DevOps Server…), and Tauri's
//! CSP is fixed at build time.
//!
//! The page asks for `gwimg://localhost/?u=<encoded url>` (Windows:
//! `http://gwimg.localhost/?u=…`, what `convertFileSrc` builds). The backend
//! fetches it with curl: http(s) only, at most 3 redirects (http(s) too),
//! 5 MiB and 20 s at most, the URL given on stdin (a signed attachment URL
//! stays off the process list), no cookie and no credential. Only an
//! `image/*` answer is served; anything else is a 502 and the page falls
//! back (initials for an avatar). Answers are kept in a small in-memory cache.
//!
//! Requests are what the webview made itself before: no new reach.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use crate::commands::curl_util::{curl_transport_check, quote_config, run_curl};

pub(crate) const SCHEME: &str = "gwimg";

/// Largest image served.
const MAX_IMAGE_BYTES: usize = 5 * 1024 * 1024;
/// Whole request, redirects included.
const FETCH_TIMEOUT_SECS: u64 = 20;
const CONNECT_TIMEOUT_SECS: u64 = 10;
/// Cache bounds: entries and total bytes, oldest dropped first.
const CACHE_MAX_ENTRIES: usize = 256;
const CACHE_MAX_BYTES: usize = 32 * 1024 * 1024;

const MARKER: &[u8] = b"\n__GW_IMG__";

/// A served image: its media type and bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Image {
    pub content_type: String,
    pub bytes: Vec<u8>,
}

/// The remote URL a `gwimg:` request asks for: the `u` query parameter, an
/// absolute http(s) URL without credentials or control characters.
pub(crate) fn requested_url(uri: &str) -> Result<String, String> {
    // The URI may be absolute (`gwimg://localhost/?u=…`) or a path (`/?u=…`).
    let parsed = tauri::Url::parse(uri)
        .or_else(|_| tauri::Url::parse(&format!("http://localhost{uri}")))
        .map_err(|_| "malformed image request".to_string())?;
    let url = parsed
        .query_pairs()
        .find(|(k, _)| k == "u")
        .map(|(_, v)| v.into_owned())
        .ok_or_else(|| "no image URL".to_string())?;
    if url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("image URL contains whitespace or control characters".to_string());
    }
    let target = tauri::Url::parse(&url).map_err(|_| "image URL is not a URL".to_string())?;
    if !matches!(target.scheme(), "http" | "https") || target.host_str().is_none() {
        return Err("image URL must be http(s)".to_string());
    }
    if !target.username().is_empty() || target.password().is_some() {
        return Err("image URL must not carry credentials".to_string());
    }
    Ok(target.to_string())
}

/// `image/png; charset=…` → `image/png`, for an `image/*` type only.
pub(crate) fn image_type(content_type: &str) -> Option<String> {
    let t = content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let sub = t.strip_prefix("image/")?;
    (!sub.is_empty()
        && sub
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"+-.".contains(&b)))
    .then_some(t)
}

/// Split curl's output (body, then the `-w` trailer) into the body, the
/// HTTP status and the content type.
pub(crate) fn split_output(out: &[u8]) -> Option<(&[u8], u16, &str)> {
    let at = out.windows(MARKER.len()).rposition(|w| w == MARKER)?;
    let body = &out[..at];
    let trailer = std::str::from_utf8(&out[at + MARKER.len()..]).ok()?;
    let (status, ctype) = trailer
        .trim()
        .split_once(' ')
        .unwrap_or((trailer.trim(), ""));
    Some((body, status.parse().ok()?, ctype))
}

/// Fetch `url` with curl and keep it only when it is an image.
fn fetch(url: &str) -> Result<Image, String> {
    let cfg = format!("url = {}\n", quote_config(url));
    let args: Vec<String> = [
        "-s",
        "-S",
        "-L",
        "--max-redirs",
        "3",
        "--proto",
        "=http,https",
        "--proto-redir",
        "=http,https",
        "--max-filesize",
        &MAX_IMAGE_BYTES.to_string(),
        "--connect-timeout",
        &CONNECT_TIMEOUT_SECS.to_string(),
        "--max-time",
        &FETCH_TIMEOUT_SECS.to_string(),
        "-H",
        "Accept: image/*",
        "--config",
        "-",
        "-o",
        "-",
        "-w",
        "\n__GW_IMG__%{http_code} %{content_type}",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    let output = run_curl(&args, Some(&cfg))?;
    curl_transport_check(
        output.status.success(),
        output.status.code(),
        &String::from_utf8_lossy(&output.stderr),
    )?;
    let (body, status, ctype) =
        split_output(&output.stdout).ok_or_else(|| "unreadable curl output".to_string())?;
    if !(200..300).contains(&status) {
        return Err(format!("image request answered {status}"));
    }
    let content_type = image_type(ctype).ok_or_else(|| format!("not an image ({ctype})"))?;
    if body.is_empty() || body.len() > MAX_IMAGE_BYTES {
        return Err("empty or oversized image".to_string());
    }
    Ok(Image {
        content_type,
        bytes: body.to_vec(),
    })
}

/// Recently served images, newest last.
struct Cache {
    entries: VecDeque<(String, Arc<Image>)>,
    bytes: usize,
}

static CACHE: Mutex<Cache> = Mutex::new(Cache {
    entries: VecDeque::new(),
    bytes: 0,
});

fn lock_cache() -> std::sync::MutexGuard<'static, Cache> {
    CACHE.lock().unwrap_or_else(|p| p.into_inner())
}

impl Cache {
    fn get(&mut self, url: &str) -> Option<Arc<Image>> {
        let i = self.entries.iter().position(|(u, _)| u == url)?;
        let entry = self.entries.remove(i)?;
        let image = entry.1.clone();
        self.entries.push_back(entry);
        Some(image)
    }

    fn put(&mut self, url: String, image: Arc<Image>) {
        if let Some(i) = self.entries.iter().position(|(u, _)| *u == url) {
            if let Some((_, old)) = self.entries.remove(i) {
                self.bytes -= old.bytes.len();
            }
        }
        self.bytes += image.bytes.len();
        self.entries.push_back((url, image));
        while self.entries.len() > CACHE_MAX_ENTRIES || self.bytes > CACHE_MAX_BYTES {
            match self.entries.pop_front() {
                Some((_, old)) => self.bytes -= old.bytes.len(),
                None => break,
            }
        }
    }
}

/// The image `uri` asks for, from the cache or fetched.
pub(crate) fn serve(uri: &str) -> Result<Arc<Image>, String> {
    let url = requested_url(uri)?;
    if let Some(hit) = lock_cache().get(&url) {
        return Ok(hit);
    }
    // Fetched outside the lock: other images are served meanwhile.
    let image = Arc::new(fetch(&url)?);
    lock_cache().put(url, image.clone());
    Ok(image)
}

/// The HTTP response for a `gwimg:` request.
pub(crate) fn respond(uri: &str) -> tauri::http::Response<Vec<u8>> {
    let builder = tauri::http::Response::builder()
        .header("X-Content-Type-Options", "nosniff")
        .header("Access-Control-Allow-Origin", "*");
    match serve(uri) {
        Ok(image) => builder
            .status(200)
            .header("Content-Type", image.content_type.as_str())
            .header("Cache-Control", "max-age=3600")
            .body(image.bytes.clone()),
        Err(e) => builder
            .status(502)
            .header("Content-Type", "text/plain; charset=utf-8")
            .body(e.into_bytes()),
    }
    .unwrap_or_else(|_| tauri::http::Response::new(Vec::new()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;
    use std::time::{Duration, Instant};

    #[test]
    fn reads_the_requested_url() {
        let enc = "https%3A%2F%2Favatars.example%2Fu%2F1%3Fs%3D48";
        assert_eq!(
            requested_url(&format!("gwimg://localhost/?u={enc}")).unwrap(),
            "https://avatars.example/u/1?s=48"
        );
        assert_eq!(
            requested_url(&format!("http://gwimg.localhost/?u={enc}")).unwrap(),
            "https://avatars.example/u/1?s=48"
        );
        assert_eq!(
            requested_url(&format!("/?u={enc}")).unwrap(),
            "https://avatars.example/u/1?s=48"
        );
    }

    #[test]
    fn refuses_what_is_not_an_http_image_url() {
        for bad in [
            "gwimg://localhost/",
            "gwimg://localhost/?u=file%3A%2F%2F%2Fetc%2Fpasswd",
            "gwimg://localhost/?u=https%3A%2F%2Fuser%3Apw%40host.example%2Fa.png",
            "gwimg://localhost/?u=https%3A%2F%2Fhost.example%2Fa%0Ab.png",
            "gwimg://localhost/?u=not%20a%20url",
        ] {
            assert!(requested_url(bad).is_err(), "{bad} was accepted");
        }
    }

    #[test]
    fn keeps_image_types_only() {
        assert_eq!(image_type("image/png").as_deref(), Some("image/png"));
        assert_eq!(
            image_type("Image/SVG+XML; charset=utf-8").as_deref(),
            Some("image/svg+xml")
        );
        assert_eq!(image_type("text/html"), None);
        assert_eq!(image_type("image/"), None);
        assert_eq!(image_type("image/png\r\nX-Evil: 1"), None);
        assert_eq!(image_type(""), None);
    }

    #[test]
    fn splits_body_and_trailer_even_when_the_body_holds_the_marker() {
        let mut out = b"PNG\x00\n__GW_IMG__fake".to_vec();
        out.extend_from_slice(b"\n__GW_IMG__200 image/png");
        let (body, status, ctype) = split_output(&out).unwrap();
        assert_eq!(body, b"PNG\x00\n__GW_IMG__fake");
        assert_eq!((status, ctype), (200, "image/png"));
        assert!(split_output(b"no trailer").is_none());
    }

    #[test]
    fn the_cache_drops_the_oldest_beyond_its_bounds() {
        let mut c = Cache {
            entries: VecDeque::new(),
            bytes: 0,
        };
        let img = |n: usize| {
            Arc::new(Image {
                content_type: "image/png".into(),
                bytes: vec![0; n],
            })
        };
        for i in 0..CACHE_MAX_ENTRIES + 3 {
            c.put(format!("u{i}"), img(1));
        }
        assert_eq!(c.entries.len(), CACHE_MAX_ENTRIES);
        assert!(c.get("u0").is_none());
        assert!(c.get(&format!("u{}", CACHE_MAX_ENTRIES + 2)).is_some());
        c.put("big".into(), img(CACHE_MAX_BYTES));
        assert!(c.bytes <= CACHE_MAX_BYTES);
        assert!(c.get("big").is_some());
        // Replacing an entry does not count it twice.
        c.put("big".into(), img(10));
        assert_eq!(c.bytes, 10);
    }

    /// A one-shot local server answering `reply` to whatever it is asked.
    /// Gives up after 10 s so a failing test never hangs the suite.
    fn serve_once(reply: Vec<u8>) -> (u16, std::thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        listener.set_nonblocking(true).unwrap();
        let handle = std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(10);
            let mut stream = loop {
                match listener.accept() {
                    Ok((s, _)) => break s,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        if Instant::now() > deadline {
                            return;
                        }
                        std::thread::sleep(Duration::from_millis(20));
                    }
                    Err(e) => panic!("accept: {e}"),
                }
            };
            stream.set_nonblocking(false).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(10)))
                .unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                    break;
                }
            }
            let _ = stream.write_all(&reply);
        });
        (port, handle)
    }

    fn http(status: &str, ctype: &str, body: &[u8]) -> Vec<u8> {
        let mut r = format!(
            "HTTP/1.1 {status}\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        )
        .into_bytes();
        r.extend_from_slice(body);
        r
    }

    fn uri_for(port: u16, path: &str) -> String {
        let url = format!("http://127.0.0.1:{port}{path}");
        let enc: String = url
            .bytes()
            .map(|b| {
                if b.is_ascii_alphanumeric() {
                    (b as char).to_string()
                } else {
                    format!("%{b:02X}")
                }
            })
            .collect();
        format!("gwimg://localhost/?u={enc}")
    }

    #[test]
    fn serves_an_image_and_refuses_anything_else() {
        let png = b"\x89PNG\r\n\x1a\nbinary\x00bytes".to_vec();
        let (port, h) = serve_once(http("200 OK", "image/png", &png));
        let r = respond(&uri_for(port, "/a.png"));
        h.join().unwrap();
        assert_eq!(r.status(), 200);
        assert_eq!(r.headers()["content-type"], "image/png");
        assert_eq!(r.body(), &png);

        let (port, h) = serve_once(http("200 OK", "text/html", b"<script>x</script>"));
        let r = respond(&uri_for(port, "/page"));
        h.join().unwrap();
        assert_eq!(r.status(), 502);

        let (port, h) = serve_once(http("404 Not Found", "image/png", b"x"));
        let r = respond(&uri_for(port, "/missing.png"));
        h.join().unwrap();
        assert_eq!(r.status(), 502);
    }
}

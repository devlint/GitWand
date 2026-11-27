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

use crate::commands::curl_util::{curl_command, curl_transport_check, quote_config};

pub(crate) const SCHEME: &str = "gwimg";

/// Largest image served.
const MAX_IMAGE_BYTES: usize = 5 * 1024 * 1024;
/// Whole request, redirects included.
const FETCH_TIMEOUT_SECS: u64 = 20;
const CONNECT_TIMEOUT_SECS: u64 = 10;
/// Cache bounds: entries and total bytes, oldest dropped first.
const CACHE_MAX_ENTRIES: usize = 2048;
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

/// Environment variables the image fetch passes on to curl (compared in
/// upper case): nothing else of GitWand's environment reaches it.
const CURL_ENV: &[&str] = &[
    "PATH",
    "SYSTEMROOT",
    "WINDIR",
    "TEMP",
    "TMP",
    "TMPDIR",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "CURL_CA_BUNDLE",
];

/// Room for curl's `-w` trailer past the largest image.
const TRAILER_SLACK: usize = 1024;

/// Run curl (`-q` first, config on stdin) and read its stdout as it comes,
/// killing it once more than `cap` bytes arrived: `--max-filesize` only
/// stops a transfer whose size is announced, and a chunked answer would
/// otherwise be buffered whole for up to `FETCH_TIMEOUT_SECS`.
fn run_curl_capped(
    args: &[String],
    cfg: &str,
    cap: usize,
) -> Result<(Vec<u8>, bool, Option<i32>, String), String> {
    use std::io::{Read, Write};
    use std::process::Stdio;
    let mut cmd = curl_command(args);
    // Only what curl needs (AGENTS.md: no secrets in a child's environment):
    // its path, the proxy and CA settings, Windows' system variables.
    cmd.env_clear();
    for (key, value) in std::env::vars_os() {
        let k = key.to_string_lossy().to_ascii_uppercase();
        if CURL_ENV.contains(&k.as_str()) {
            cmd.env(&key, value);
        }
    }
    let mut child = cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("curl not found or failed to spawn: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        // Read whole before anything is sent: no deadlock against stdout.
        let _ = stdin.write_all(cfg.as_bytes());
    }
    let mut stderr_pipe = child.stderr.take();
    let stderr_reader = std::thread::spawn(move || {
        let mut text = String::new();
        if let Some(e) = stderr_pipe.as_mut() {
            let _ = e.take(64 * 1024).read_to_string(&mut text);
        }
        text
    });
    let mut out = Vec::new();
    let mut over = false;
    if let Some(mut stdout) = child.stdout.take() {
        let mut chunk = [0u8; 16 * 1024];
        loop {
            match stdout.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    out.extend_from_slice(&chunk[..n]);
                    if out.len() > cap {
                        over = true;
                        let _ = child.kill();
                        break;
                    }
                }
            }
        }
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    let stderr = stderr_reader.join().unwrap_or_default();
    if over {
        return Err("image larger than 5 MiB".to_string());
    }
    Ok((out, status.success(), status.code(), stderr))
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
    let (stdout, ok, code, stderr) = run_curl_capped(&args, &cfg, MAX_IMAGE_BYTES + TRAILER_SLACK)?;
    curl_transport_check(ok, code, &stderr)?;
    let (body, status, ctype) =
        split_output(&stdout).ok_or_else(|| "unreadable curl output".to_string())?;
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

/// How long a failed URL answers its failure without being fetched again
/// (a 404 avatar shown in every row of a list).
const FAILURE_TTL: std::time::Duration = std::time::Duration::from_secs(60);
/// Fetches running at once; the others wait their turn.
const MAX_FETCHES: usize = 6;

type Outcome = Result<Arc<Image>, String>;

/// One fetch, shared by every request for its URL that arrives meanwhile.
struct Flight {
    outcome: Mutex<Option<Outcome>>,
    done: std::sync::Condvar,
}

struct Fetching {
    flights: Vec<(String, Arc<Flight>)>,
    failures: Vec<(String, std::time::Instant, String)>,
    running: usize,
}

static FETCHING: Mutex<Fetching> = Mutex::new(Fetching {
    flights: Vec::new(),
    failures: Vec::new(),
    running: 0,
});
static SLOT_FREED: std::sync::Condvar = std::sync::Condvar::new();

fn lock_fetching() -> std::sync::MutexGuard<'static, Fetching> {
    FETCHING.lock().unwrap_or_else(|p| p.into_inner())
}

/// The image `uri` asks for: from the cache, from a fetch of the same URL
/// already running, from a recent failure, or fetched (at most `MAX_FETCHES`
/// at once).
pub(crate) fn serve(uri: &str) -> Result<Arc<Image>, String> {
    let url = requested_url(uri)?;
    serve_with(&url, fetch)
}

fn serve_with(url: &str, fetch: impl FnOnce(&str) -> Result<Image, String>) -> Outcome {
    if let Some(hit) = lock_cache().get(url) {
        return Ok(hit);
    }
    let flight = {
        let mut f = lock_fetching();
        f.failures.retain(|(_, at, _)| at.elapsed() < FAILURE_TTL);
        if let Some((_, _, e)) = f.failures.iter().find(|(u, _, _)| u == url) {
            return Err(e.clone());
        }
        if let Some((_, flight)) = f.flights.iter().find(|(u, _)| u == url) {
            let flight = flight.clone();
            drop(f);
            let mut outcome = flight.outcome.lock().unwrap_or_else(|p| p.into_inner());
            while outcome.is_none() {
                outcome = flight.done.wait(outcome).unwrap_or_else(|p| p.into_inner());
            }
            return outcome
                .clone()
                .unwrap_or_else(|| Err("image fetch lost".into()));
        }
        let flight = Arc::new(Flight {
            outcome: Mutex::new(None),
            done: std::sync::Condvar::new(),
        });
        f.flights.push((url.to_string(), flight.clone()));
        while f.running >= MAX_FETCHES {
            f = SLOT_FREED.wait(f).unwrap_or_else(|p| p.into_inner());
        }
        f.running += 1;
        flight
    };
    // Whatever happens next, a panic in the fetch included, the slot is
    // freed and the requests waiting on this flight get an answer.
    let mut landing = Landing {
        url,
        flight: &flight,
        outcome: Err("image fetch failed".to_string()),
    };
    // Fetched outside every lock: other images are served meanwhile.
    landing.outcome = fetch(url).map(Arc::new);
    match &landing.outcome {
        Ok(image) => lock_cache().put(url.to_string(), image.clone()),
        // Only a definitive answer is remembered: a timeout, a dropped
        // connection or a 5xx is fetched again at the next request.
        Err(e) if is_definitive(e) => {
            lock_fetching()
                .failures
                .push((url.to_string(), std::time::Instant::now(), e.clone()))
        }
        Err(_) => {}
    }
    landing.outcome.clone()
}

/// A failure that the same request would get again: the server's 4xx, an
/// answer that is not an image, an oversized or empty one.
fn is_definitive(error: &str) -> bool {
    error.starts_with("image request answered 4")
        || error.starts_with("not an image")
        || error.contains("larger than 5 MiB")
        || error.starts_with("empty or oversized")
        || error.contains("(63)")
}

/// Ends a flight when dropped: frees its fetch slot, removes it, and hands
/// its outcome (a failure unless set) to the requests waiting on it.
struct Landing<'a> {
    url: &'a str,
    flight: &'a Flight,
    outcome: Outcome,
}

impl Drop for Landing<'_> {
    fn drop(&mut self) {
        {
            let mut f = lock_fetching();
            f.running = f.running.saturating_sub(1);
            f.flights.retain(|(u, _)| u != self.url);
        }
        SLOT_FREED.notify_one();
        *self
            .flight
            .outcome
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = Some(self.outcome.clone());
        self.flight.done.notify_all();
    }
}

/// Workers answering `gwimg:` requests: a few dedicated threads, so images
/// waiting for a fetch slot never hold the shared blocking pool that Tauri
/// commands run on.
const WORKERS: usize = 8;

type Job = Box<dyn FnOnce() + Send>;

/// Queue `uri` and hand its response to `reply` from a worker. A panic while
/// serving it still answers (502), so no image request stays open.
pub(crate) fn enqueue(
    uri: String,
    reply: impl FnOnce(tauri::http::Response<Vec<u8>>) + Send + 'static,
) {
    use std::sync::mpsc::{channel, Sender};
    use std::sync::OnceLock;
    static QUEUE: OnceLock<Mutex<Sender<Job>>> = OnceLock::new();
    let queue = QUEUE.get_or_init(|| {
        let (tx, rx) = channel::<Job>();
        let rx = Arc::new(Mutex::new(rx));
        for _ in 0..WORKERS {
            let rx = rx.clone();
            std::thread::spawn(move || loop {
                let job = match rx.lock().unwrap_or_else(|p| p.into_inner()).recv() {
                    Ok(job) => job,
                    Err(_) => return,
                };
                job();
            });
        }
        Mutex::new(tx)
    });
    let job: Job = Box::new(move || {
        let response = std::panic::catch_unwind(|| respond(&uri))
            .unwrap_or_else(|_| failure("image request failed".to_string()));
        reply(response);
    });
    let _ = queue.lock().unwrap_or_else(|p| p.into_inner()).send(job);
}

fn failure(message: String) -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .status(502)
        .header("X-Content-Type-Options", "nosniff")
        .header("Content-Type", "text/plain; charset=utf-8")
        .body(message.into_bytes())
        .unwrap_or_else(|_| tauri::http::Response::new(Vec::new()))
}

/// The HTTP response for a `gwimg:` request.
pub(crate) fn respond(uri: &str) -> tauri::http::Response<Vec<u8>> {
    // No CORS header: an `<img>` needs none, and the bytes are not for a
    // script of any origin to read back.
    // An SVG opened as a document (not as an `<img>`) runs no script.
    let builder = tauri::http::Response::builder()
        .header("X-Content-Type-Options", "nosniff")
        .header(
            "Content-Security-Policy",
            "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        );
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

    #[test]
    fn concurrent_requests_for_a_url_share_one_fetch_and_a_failure_is_kept() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static FETCHES: AtomicUsize = AtomicUsize::new(0);
        let url = "https://share.example/a.png";
        let handles: Vec<_> = (0..8)
            .map(|_| {
                std::thread::spawn(move || {
                    serve_with(url, |_| {
                        FETCHES.fetch_add(1, Ordering::SeqCst);
                        std::thread::sleep(Duration::from_millis(200));
                        Ok(Image {
                            content_type: "image/png".into(),
                            bytes: vec![1, 2, 3],
                        })
                    })
                })
            })
            .collect();
        for h in handles {
            assert_eq!(h.join().unwrap().unwrap().bytes, [1, 2, 3]);
        }
        assert_eq!(FETCHES.load(Ordering::SeqCst), 1);

        // A transient failure is fetched again at the next request.
        let flaky = "https://share.example/flaky.png";
        let _ = serve_with(flaky, |_| {
            Err("curl request failed (exit 28): timeout".into())
        });
        let again = serve_with(flaky, |_| {
            Ok(Image {
                content_type: "image/png".into(),
                bytes: vec![9],
            })
        });
        assert_eq!(again.unwrap().bytes, [9]);

        // A definitive failure answers the next requests without a new fetch.
        let bad = "https://share.example/missing.png";
        let err = serve_with(bad, |_| Err("image request answered 404".into())).unwrap_err();
        assert!(err.contains("404"));
        let again = serve_with(bad, |_| panic!("fetched again within the failure TTL"));
        assert_eq!(again.unwrap_err(), err);
    }

    #[test]
    fn queued_requests_are_answered_by_the_workers() {
        let (tx, rx) = std::sync::mpsc::channel();
        for _ in 0..20 {
            let tx = tx.clone();
            enqueue("gwimg://localhost/".to_string(), move |r| {
                let _ = tx.send(r.status().as_u16());
            });
        }
        for _ in 0..20 {
            assert_eq!(rx.recv_timeout(Duration::from_secs(10)).unwrap(), 502);
        }
    }

    #[test]
    fn a_bracket_range_in_the_url_is_one_request() {
        // With globbing, `[1-3]` would be three requests; the one-shot server
        // answers the first and curl would fail on the others.
        let (port, h) = serve_once(http("200 OK", "image/png", b"\x89PNG-one"));
        let r = respond(&uri_for(port, "/[1-3].png"));
        h.join().unwrap();
        assert_eq!(r.status(), 200);
        assert_eq!(r.body(), b"\x89PNG-one");
    }

    #[test]
    fn a_panicking_fetch_frees_its_slot_and_answers_its_waiters() {
        let url = "https://panic.example/a.png";
        let waiter = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(50));
            serve_with(url, |_| panic!("not the waiter's fetch"))
        });
        let first = std::thread::spawn(move || {
            serve_with(url, |_| {
                std::thread::sleep(Duration::from_millis(200));
                panic!("fetch blew up")
            })
        });
        assert!(first.join().is_err());
        // The waiter got an answer rather than hanging.
        assert!(waiter.join().unwrap().is_err());
        assert!(lock_fetching().flights.iter().all(|(u, _)| u != url));
    }

    #[test]
    fn a_streamed_body_past_the_cap_is_cut_short() {
        // No Content-Length: curl's --max-filesize cannot stop it.
        let mut reply =
            b"HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nConnection: close\r\n\r\n".to_vec();
        reply.extend(std::iter::repeat_n(0u8, MAX_IMAGE_BYTES + 64 * 1024));
        let (port, h) = serve_once(reply);
        let r = respond(&uri_for(port, "/huge.png"));
        h.join().unwrap();
        assert_eq!(r.status(), 502);
        // A recent curl stops it itself (exit 63); an older one is cut by the cap.
        let msg = String::from_utf8_lossy(r.body()).into_owned();
        assert!(
            msg.contains("larger than 5 MiB") || msg.contains("(63)"),
            "got: {msg}"
        );
    }

    #[test]
    fn the_cap_kills_curl_whatever_curl_itself_enforces() {
        let mut reply =
            b"HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nConnection: close\r\n\r\n".to_vec();
        reply.extend(std::iter::repeat_n(0u8, 256 * 1024));
        let (port, h) = serve_once(reply);
        // No --max-filesize here: only the cap can stop it.
        let args: Vec<String> = ["-s", "-S", "--config", "-", "-o", "-"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let cfg = format!(
            "url = {}\n",
            quote_config(&format!("http://127.0.0.1:{port}/big.png"))
        );
        let err = run_curl_capped(&args, &cfg, 16 * 1024).unwrap_err();
        h.join().unwrap();
        assert!(err.contains("larger than 5 MiB"), "got: {err}");
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
        assert!(r.headers().get("access-control-allow-origin").is_none());
        assert!(r.headers()["content-security-policy"]
            .to_str()
            .unwrap()
            .contains("sandbox"));
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

//! Gitea / Forgejo REST v1 Tauri commands.
//!
//! ## Why this module looks different from its neighbours
//!
//! Every other forge module has a constant API base (`api.bitbucket.org`,
//! `dev.azure.com`). Gitea has none: it is self-hosted, so the host comes from
//! the account the user configured in Settings > Accounts and is resolved per
//! call from `GiteaCtx`.
//!
//! ## Auth
//!
//! Personal access token, stored as:
//!   service = "gitwand:gitea"
//!   account = "<host>:<username>"
//!   value   = "<token>"
//!
//! The token is injected through `curl --config -` (stdin) as
//! `Authorization: token <pat>`, Gitea's documented scheme. It never reaches
//! argv, a log line, or the frontend.

use super::curl_util::{auth_header_config, curl_with_status};
use crate::git::{hidden_cmd, parse_remote_owner_repo};
use crate::types::*;

/// Keychain service for a Settings-managed Gitea token.
pub(crate) const GITEA_SERVICE: &str = "gitwand:gitea";

/// Everything a Gitea call needs: where the server is, which repo, and how to
/// authenticate. Resolved once per command from `cwd`.
pub(crate) struct GiteaCtx {
    pub base: String,
    pub owner: String,
    pub repo: String,
    pub auth: String,
}

impl GiteaCtx {
    /// `https://<host>/api/v1/repos/<owner>/<repo>`
    fn repo_api(&self) -> String {
        format!("{}/api/v1/repos/{}/{}", self.base, self.owner, self.repo)
    }
}

/// Normalise a user-entered server URL to an origin (plus any subpath).
///
/// Adds `https://` when no scheme is present, then strips a trailing slash and
/// a trailing `/api/v1`, which users paste surprisingly often.
fn normalize_base_url(raw: &str) -> String {
    let trimmed = raw.trim();
    let with_scheme = if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        trimmed.to_string()
    } else {
        format!("https://{}", trimmed)
    };
    let mut out = with_scheme.trim_end_matches('/').to_string();
    if let Some(stripped) = out.strip_suffix("/api/v1") {
        out = stripped.trim_end_matches('/').to_string();
    }
    out
}

/// Read the origin remote URL of `cwd`.
fn origin_url(cwd: &str) -> Result<String, String> {
    let output = hidden_cmd("git")
        .args(["remote", "get-url", "origin"])
        .current_dir(cwd)
        .output()
        .map_err(|e| format!("git remote get-url: {}", e))?;
    if !output.status.success() {
        return Err("No 'origin' remote found in this repo.".to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Resolve the Gitea context for a repo: host from the remote, owner/repo from
/// the remote, token from the keychain entry whose account key starts with that
/// host.
fn gitea_ctx(cwd: &str) -> Result<GiteaCtx, String> {
    let url = origin_url(cwd)?;
    let host = crate::git::extract_remote_host(&url)
        .ok_or_else(|| format!("Could not read a host from the remote URL: {}", url))?;
    let (owner, repo) = parse_remote_owner_repo(&url);
    if owner.is_empty() || repo.is_empty() {
        return Err(format!("Could not read owner/repo from the remote URL: {}", url));
    }
    let token = gitea_token_for_host(&host)?;
    Ok(GiteaCtx {
        base: normalize_base_url(&host),
        owner,
        repo,
        auth: auth_header_config("token", &token),
    })
}

/// Look up the stored token for `host`.
///
/// The keychain account key is `"<host>:<username>"`, and the username is not
/// known here, so the frontend stores a second entry keyed by host alone
/// pointing at the active username (see `backend-gitea.ts`). This reads that
/// pointer, then the token itself.
fn gitea_token_for_host(host: &str) -> Result<String, String> {
    let pointer = keyring::Entry::new(GITEA_SERVICE, host)
        .map_err(|e| format!("keyring: {}", e))?
        .get_password()
        .map_err(|_| {
            format!(
                "No Gitea account configured for {host}. \
                 Add one in Settings > Accounts."
            )
        })?;
    // The pointer holds the active username for this host.
    keyring::Entry::new(GITEA_SERVICE, &format!("{}:{}", host, pointer))
        .map_err(|e| format!("keyring: {}", e))?
        .get_password()
        .map_err(|_| {
            format!(
                "Gitea credential for {host} is missing or unreadable. \
                 Re-add the account in Settings > Accounts."
            )
        })
}

// ─── HTTP transport ─────────────────────────────────────────────────────────

fn gitea_curl_raw(
    method: &str,
    url: &str,
    body: Option<&str>,
    auth: &str,
    accept: &str,
) -> Result<(i32, String), String> {
    curl_with_status(method, url, Some(auth), body, &[], accept)
}

/// JSON call. HTTP >= 400 maps to an error, preferring Gitea's `message` field.
/// An empty body (DELETE) returns `Null`.
fn gitea_curl(
    method: &str,
    url: &str,
    body: Option<&str>,
    auth: &str,
) -> Result<serde_json::Value, String> {
    let (status, text) = gitea_curl_raw(method, url, body, auth, "application/json")?;
    if status >= 400 {
        let msg = serde_json::from_str::<serde_json::Value>(text.trim())
            .ok()
            .and_then(|v| v.get("message").and_then(|m| m.as_str()).map(String::from))
            .unwrap_or_else(|| format!("HTTP {}", status));
        return Err(format!("Gitea API error: {}", msg));
    }
    if text.trim().is_empty() {
        return Ok(serde_json::Value::Null);
    }
    serde_json::from_str(text.trim()).map_err(|e| {
        format!(
            "Failed to parse Gitea response: {} (raw: {})",
            e,
            &text[..text.len().min(300)]
        )
    })
}

// ─── Commands ───────────────────────────────────────────────────────────────

/// Login of the authenticated user on the server behind this repo's remote.
#[tauri::command]
pub(crate) async fn gitea_current_user(cwd: String) -> Result<String, String> {
    let ctx = gitea_ctx(&cwd)?;
    let v = gitea_curl("GET", &format!("{}/api/v1/user", ctx.base), None, &ctx.auth)?;
    Ok(v.get("login")
        .and_then(|s| s.as_str())
        .unwrap_or("")
        .to_string())
}

/// Validate a host/token pair before the account is saved, returning the login.
///
/// Takes the token directly rather than reading the keychain: at call time
/// nothing is stored yet. Same IPC exposure as `set_credential`, which already
/// carries the secret once on the way to the keychain.
#[tauri::command]
pub(crate) async fn gitea_validate_token(host: String, token: String) -> Result<String, String> {
    let base = normalize_base_url(&host);
    let auth = auth_header_config("token", &token);
    let v = gitea_curl("GET", &format!("{}/api/v1/user", base), None, &auth)?;
    let login = v.get("login").and_then(|s| s.as_str()).unwrap_or("");
    if login.is_empty() {
        return Err("The server answered without a login. Check the URL points at a Gitea or Forgejo instance.".to_string());
    }
    Ok(login.to_string())
}

#[cfg(test)]
mod gitea_base_url_tests {
    use super::normalize_base_url;

    #[test]
    fn adds_https_when_the_scheme_is_missing() {
        assert_eq!(normalize_base_url("git.acme.io"), "https://git.acme.io");
    }

    #[test]
    fn keeps_an_explicit_port() {
        assert_eq!(normalize_base_url("http://git.acme.io:3000"), "http://git.acme.io:3000");
    }

    #[test]
    fn strips_a_trailing_slash_and_an_api_suffix() {
        assert_eq!(normalize_base_url("https://git.acme.io/"), "https://git.acme.io");
        assert_eq!(normalize_base_url("https://git.acme.io/api/v1"), "https://git.acme.io");
        assert_eq!(normalize_base_url("https://git.acme.io/api/v1/"), "https://git.acme.io");
    }

    #[test]
    fn keeps_a_subpath_install() {
        // Gitea can be mounted under a path prefix. Dropping it would 404
        // every call, so only the api suffix and trailing slashes come off.
        assert_eq!(normalize_base_url("https://acme.io/gitea/"), "https://acme.io/gitea");
    }
}

# Gitea Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user sign in to a self-hosted Gitea or Forgejo server in Settings > Accounts and get a working PR tab and Today panel, closing issue #193.

**Architecture:** A sixth `ForgeProvider` backed by a new Rust module `commands/gitea.rs` that calls Gitea's `/api/v1` REST API through `curl`, with a personal access token read from the OS keychain. Unlike every existing forge, there is no constant API base: the host comes from the account that matched the remote. Detection is two-layered, a pure substring arm in `detect_provider()` plus an account-host match in the `gitRemoteInfo` frontend wrapper.

**Tech Stack:** Rust (Tauri 2, `serde_json`, `keyring`, `curl` subprocess), TypeScript, Vue 3 `<script setup>`, Vitest, `cargo test`.

**Spec:** `docs/superpowers/specs/2026-09-15-gitea-support-design.md`

## Global Constraints

- Package manager is **pnpm only**. Never npm, never yarn.
- Never build a git command through string interpolation. Use `.args([...])`.
- Never put a token in process argv. Tokens go to `curl` through `--config -` on stdin, using `auth_header_config` from `commands/curl_util.rs`. Gitea's scheme is `token`, not `Bearer`.
- Never log a token, and never return one to the frontend.
- Never edit a version field by hand. `./scripts/bump-version.sh X.Y.Z` owns them.
- Every user-visible string needs a key in all 5 locales: `en`, `fr`, `es`, `pt-BR`, `zh-CN`. No hardcoded text in components.
- Never call `invoke()` from a component or composable. Every Tauri command gets a typed wrapper in `src/utils/backend*.ts`.
- Secondary Rust binaries go under `[[example]]`, never `[[bin]]`. This plan adds none.
- Tests use real temporary git repos, never a mocked git layer.
- No em dash in any generated text, including commit messages and code comments.
- Release framing: this is the fourth lot of **v3.11.0**. Do not tag, do not bump a version.

---

## File Structure

| File | Responsibility |
|---|---|
| `apps/desktop/src-tauri/src/commands/gitea.rs` | Credential lookup, base-URL resolution, `curl` transport, JSON mapping, 21 commands |
| `apps/desktop/src-tauri/src/commands/mod.rs` | `pub(crate) mod gitea;` |
| `apps/desktop/src-tauri/src/lib.rs` | `invoke_handler` registration |
| `apps/desktop/src-tauri/src/git/parse.rs` | `detect_provider()` Gitea arm plus its tests |
| `apps/desktop/dev-server.mjs` | Gitea arm in `/api/git-remote-info`, 8 read routes |
| `apps/desktop/src/utils/backend-gitea.ts` | Typed wrappers, Tauri and dev:web paths |
| `apps/desktop/src/utils/backend.ts` | Re-export, account-host override in `gitRemoteInfo` |
| `apps/desktop/src/utils/forgeUrls.ts` | Gitea commit URL from the remote host |
| `apps/desktop/src/composables/useAccounts.ts` | `giteaHosts()` helper |
| `apps/desktop/src/composables/forge/GiteaProvider.ts` | `ForgeProvider` implementation |
| `apps/desktop/src/composables/forge/types.ts` | `ForgeName` gains `"gitea"` |
| `apps/desktop/src/composables/forge/useForge.ts`, `index.ts` | Provider registration |
| `apps/desktop/src/components/SettingsAccountsTab.vue` | Gitea account form |
| `apps/desktop/src/locales/*.ts` | Account form keys, forge labels |
| `apps/desktop/tests/parity/gitea-remote-info.test.mjs` | Detection parity |

Task order is dependency order. Tasks 1 to 6 are Rust and can be reviewed independently of the frontend. Task 7 bridges. Tasks 8 and 9 are frontend. Task 10 is bookkeeping.

---

### Task 1: Rust foundation, credentials and transport

**Files:**
- Create: `apps/desktop/src-tauri/src/commands/gitea.rs`
- Modify: `apps/desktop/src-tauri/src/commands/mod.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs` (the `invoke_handler` list, next to the `commands::bitbucket::*` block at :758)

**Interfaces:**
- Consumes: `auth_header_config`, `curl_with_status` from `commands/curl_util.rs`; `parse_remote_owner_repo`, `extract_remote_host` from `crate::git` (re-exported by `git/mod.rs:9`); `hidden_cmd` from `crate::git`.
- Produces, used by every later Rust task:
  - `fn normalize_base_url(raw: &str) -> String`
  - `struct GiteaCtx { base: String, owner: String, repo: String, auth: String }`
  - `fn gitea_ctx(cwd: &str) -> Result<GiteaCtx, String>`
  - `fn gitea_curl(method: &str, url: &str, body: Option<&str>, auth: &str) -> Result<serde_json::Value, String>`
  - `fn gitea_curl_raw(method: &str, url: &str, body: Option<&str>, auth: &str, accept: &str) -> Result<(i32, String), String>`
  - commands `gitea_current_user(cwd: String) -> Result<String, String>` and `gitea_validate_token(host: String, token: String) -> Result<String, String>`

- [ ] **Step 1: Write the failing tests**

Append to `apps/desktop/src-tauri/src/commands/gitea.rs` (create the file with just this test module first):

```rust
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/desktop/src-tauri && cargo test gitea_base_url -- --nocapture`
Expected: FAIL to compile, `cannot find function normalize_base_url`.

- [ ] **Step 3: Write the module**

Write the rest of `apps/desktop/src-tauri/src/commands/gitea.rs` above the test module:

```rust
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
```

Register the module in `commands/mod.rs` next to the other forge modules:

```rust
pub(crate) mod gitea;
```

Register both commands in `lib.rs`, directly after the `commands::bitbucket::*` block:

```rust
            commands::gitea::gitea_current_user,
            commands::gitea::gitea_validate_token,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/desktop/src-tauri && cargo test gitea_base_url`
Expected: PASS, 4 tests.

Run: `cd apps/desktop/src-tauri && cargo build`
Expected: builds clean, no warnings about unused imports.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/commands/gitea.rs apps/desktop/src-tauri/src/commands/mod.rs apps/desktop/src-tauri/src/lib.rs
git commit -m "feat(desktop): Gitea REST transport, credentials and current-user command"
```

---

### Task 2: Detection layer 1, pure and mirrored

**Files:**
- Modify: `apps/desktop/src-tauri/src/git/parse.rs:625` (`detect_provider`) and its `mod remote_provider_tests` at :1852
- Modify: `apps/desktop/dev-server.mjs:6554-6561` (the mirrored if/else chain)
- Create: `apps/desktop/tests/parity/gitea-remote-info.test.mjs`
- Modify: `apps/desktop/tests/parity/fixtures.mjs`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `detect_provider()` returns `"gitea"` for Gitea-shaped hosts; `fixtureGiteaRemote()` in `fixtures.mjs`.

- [ ] **Step 1: Write the failing tests**

Add to `mod remote_provider_tests` in `apps/desktop/src-tauri/src/git/parse.rs`:

```rust
    #[test]
    fn detects_gitea_and_forgejo_hosts() {
        assert_eq!(detect_provider("https://codeberg.org/acme/checkout.git"), "gitea");
        assert_eq!(detect_provider("https://gitea.com/acme/checkout.git"), "gitea");
        assert_eq!(detect_provider("git@gitea.acme.io:acme/checkout.git"), "gitea");
        assert_eq!(detect_provider("https://forgejo.acme.io/acme/checkout.git"), "gitea");
    }

    #[test]
    fn leaves_a_bare_self_hosted_host_unknown() {
        // A self-hosted Gitea on a neutral hostname cannot be recognised from
        // the URL alone. It resolves in the frontend against the configured
        // accounts (see the gitRemoteInfo wrapper), so the pure function must
        // stay honest rather than guess.
        assert_eq!(detect_provider("https://git.acme.io/acme/checkout.git"), "unknown");
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/desktop/src-tauri && cargo test remote_provider_tests`
Expected: FAIL, `detects_gitea_and_forgejo_hosts` asserts `"unknown" == "gitea"`.

- [ ] **Step 3: Add the arm, in both places**

In `parse.rs`, insert after the `bitbucket` arm and before `azure`:

```rust
    } else if url.contains("codeberg.org") || url.contains("gitea") || url.contains("forgejo") {
        "gitea"
```

In `dev-server.mjs`, insert the identical arm in the same position, keeping the branch order identical:

```js
        else if (remoteUrl.includes("codeberg.org") || remoteUrl.includes("gitea") || remoteUrl.includes("forgejo")) provider = "gitea";
```

Add the fixture to `apps/desktop/tests/parity/fixtures.mjs`, following the shape of `fixtureCursorOriginRemote`:

```js
/** A repo whose origin is a Gitea host recognisable from the URL alone. */
export function fixtureGiteaRemote() {
  return makeRepoWithRemote("https://codeberg.org/acme/checkout.git");
}
```

(If `makeRepoWithRemote` is not the helper name in that file, reuse whatever `fixtureCursorOriginRemote` calls, with the Gitea URL above.)

Create `apps/desktop/tests/parity/gitea-remote-info.test.mjs`:

```js
/**
 * Parity: Gitea detection, Rust `detect_provider` vs the dev-server chain.
 *
 * The substring chain is duplicated word for word between the two. This test
 * is what stops a forge added on one side only from producing a different
 * provider in `pnpm dev:web` than in the packaged app.
 */

import { describe, it, beforeAll, afterAll } from "vitest";
import { startDevServer } from "./dev-server-runner.mjs";
import { assertParity } from "./harness.mjs";
import { fixtureGiteaRemote } from "./fixtures.mjs";

describe("parity: gitea-remote-info", () => {
  /** @type {Awaited<ReturnType<typeof startDevServer>>} */
  let dev;

  beforeAll(async () => {
    dev = await startDevServer();
  }, 15_000);

  afterAll(async () => {
    await dev?.stop();
  });

  it("a codeberg.org remote reads as provider `gitea` on both sides", async () => {
    const cwd = fixtureGiteaRemote();
    await assertParity(dev, {
      command: "git-remote-info",
      args: { cwd },
      httpPath: `/api/git-remote-info?cwd=${encodeURIComponent(cwd)}`,
    });
  });
});
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/desktop/src-tauri && cargo test remote_provider_tests`
Expected: PASS.

Run: `cd apps/desktop && pnpm test:parity`
Expected: PASS, including the new `parity: gitea-remote-info`.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/git/parse.rs apps/desktop/dev-server.mjs apps/desktop/tests/parity/
git commit -m "feat(desktop): detect Gitea and Forgejo remotes, with parity coverage"
```

---

### Task 3: PR listing, detail, diff and CI status

**Files:**
- Modify: `apps/desktop/src-tauri/src/commands/gitea.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: `GiteaCtx`, `gitea_ctx`, `gitea_curl`, `gitea_curl_raw` from Task 1.
- Produces: `fn map_pr(v: &serde_json::Value) -> PullRequest`, `fn map_pr_detail(v: &serde_json::Value) -> PullRequestDetail`, `fn map_status(v: &serde_json::Value) -> Vec<CICheck>`, and commands `gitea_list_prs(cwd, state, limit, offset)`, `gitea_pr_count(cwd, state)`, `gitea_get_pr(cwd, index)`, `gitea_pr_diff(cwd, index)`, `gitea_pr_status(cwd, index)`, `gitea_pr_files(cwd, index)`.

- [ ] **Step 1: Write the failing tests**

Add to `gitea.rs`:

```rust
#[cfg(test)]
mod gitea_mapping_tests {
    use super::{map_pr, map_pr_detail, map_status};

    fn pr_json() -> serde_json::Value {
        serde_json::from_str(
            r#"{
              "id": 99001,
              "number": 42,
              "title": "Add the thing",
              "state": "open",
              "draft": true,
              "user": {"login": "alice"},
              "head": {"ref": "feat/thing", "sha": "abc123"},
              "base": {"ref": "main"},
              "created_at": "2026-09-01T10:00:00Z",
              "updated_at": "2026-09-02T10:00:00Z",
              "merged_at": null,
              "html_url": "https://git.acme.io/acme/app/pulls/42",
              "additions": 12,
              "deletions": 3,
              "changed_files": 2,
              "comments": 5,
              "mergeable": true,
              "labels": [{"name": "bug"}],
              "assignees": [{"login": "bob"}],
              "requested_reviewers": [{"login": "carol"}]
            }"#,
        )
        .unwrap()
    }

    #[test]
    fn uses_the_pr_index_not_the_global_id() {
        // Gitea's `id` is a database-wide id. Using it would address the wrong
        // PR on every follow-up call.
        assert_eq!(map_pr(&pr_json()).number, 42);
        assert_eq!(map_pr_detail(&pr_json()).number, 42);
    }

    #[test]
    fn maps_the_list_shape() {
        let pr = map_pr(&pr_json());
        assert_eq!(pr.title, "Add the thing");
        assert_eq!(pr.author, "alice");
        assert_eq!(pr.branch, "feat/thing");
        assert_eq!(pr.base, "main");
        assert!(pr.draft, "draft comes from the boolean, not a title prefix");
        assert_eq!(pr.labels, vec!["bug".to_string()]);
        assert_eq!(pr.assignees, vec!["bob".to_string()]);
        assert_eq!(pr.review_requested, vec!["carol".to_string()]);
        assert_eq!(pr.url, "https://git.acme.io/acme/app/pulls/42");
    }

    #[test]
    fn maps_mergeable_boolean_onto_the_string_contract() {
        let mut v = pr_json();
        assert_eq!(map_pr_detail(&v).mergeable, "MERGEABLE");
        v["mergeable"] = serde_json::Value::Bool(false);
        assert_eq!(map_pr_detail(&v).mergeable, "CONFLICTING");
        v["mergeable"] = serde_json::Value::Null;
        assert_eq!(map_pr_detail(&v).mergeable, "", "absent means unknown, never a guess");
    }

    #[test]
    fn carries_the_head_sha_for_the_status_call() {
        assert_eq!(map_pr_detail(&pr_json()).head_sha, "abc123");
    }

    #[test]
    fn maps_the_combined_status_into_checks() {
        let v: serde_json::Value = serde_json::from_str(
            r#"{"state": "success", "statuses": [
                 {"context": "build", "status": "success", "target_url": "https://ci/1"},
                 {"context": "lint", "status": "pending", "target_url": ""}
               ]}"#,
        )
        .unwrap();
        let checks = map_status(&v);
        assert_eq!(checks.len(), 2);
        assert_eq!(checks[0].name, "build");
        assert_eq!(checks[0].conclusion, "success");
        assert_eq!(checks[0].details_url, "https://ci/1");
        assert_eq!(checks[1].state, "pending");
    }

    #[test]
    fn tolerates_a_status_response_with_no_statuses_array() {
        let v: serde_json::Value = serde_json::from_str(r#"{"state": "pending"}"#).unwrap();
        assert!(map_status(&v).is_empty(), "no statuses means no checks, not a panic");
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/desktop/src-tauri && cargo test gitea_mapping`
Expected: FAIL to compile, `cannot find function map_pr`.

- [ ] **Step 3: Write the mappers and the commands**

Add to `gitea.rs`:

```rust
// ─── JSON helpers ───────────────────────────────────────────────────────────

fn jstr(v: &serde_json::Value, key: &str) -> String {
    v.get(key).and_then(|s| s.as_str()).unwrap_or("").to_string()
}

fn jnum(v: &serde_json::Value, key: &str) -> i64 {
    v.get(key).and_then(|n| n.as_i64()).unwrap_or(0)
}

fn jlogin(v: &serde_json::Value, key: &str) -> String {
    v.get(key)
        .and_then(|u| u.get("login"))
        .and_then(|s| s.as_str())
        .unwrap_or("")
        .to_string()
}

/// Collect `login` from an array of users, or `name` from an array of labels.
fn jnames(v: &serde_json::Value, key: &str, field: &str) -> Vec<String> {
    v.get(key)
        .and_then(|a| a.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|e| e.get(field).and_then(|s| s.as_str()).map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

/// `head.ref` / `base.ref` style lookups.
fn jref(v: &serde_json::Value, side: &str, leaf: &str) -> String {
    v.get(side)
        .and_then(|s| s.get(leaf))
        .and_then(|s| s.as_str())
        .unwrap_or("")
        .to_string()
}

/// Gitea's `mergeable` is a boolean; our contract is a string, with "" for
/// unknown so the UI never disables merge on a missing field.
fn mergeable_str(v: &serde_json::Value) -> String {
    match v.get("mergeable").and_then(|m| m.as_bool()) {
        Some(true) => "MERGEABLE".to_string(),
        Some(false) => "CONFLICTING".to_string(),
        None => String::new(),
    }
}

fn map_pr(v: &serde_json::Value) -> PullRequest {
    PullRequest {
        // `number` is the per-repo index. `id` is a global database id and
        // addressing a PR by it hits the wrong resource.
        number: jnum(v, "number"),
        title: jstr(v, "title"),
        state: jstr(v, "state"),
        author: jlogin(v, "user"),
        branch: jref(v, "head", "ref"),
        base: jref(v, "base", "ref"),
        draft: v.get("draft").and_then(|d| d.as_bool()).unwrap_or(false),
        created_at: jstr(v, "created_at"),
        updated_at: jstr(v, "updated_at"),
        url: jstr(v, "html_url"),
        additions: jnum(v, "additions"),
        deletions: jnum(v, "deletions"),
        labels: jnames(v, "labels", "name"),
        assignees: jnames(v, "assignees", "login"),
        review_requested: jnames(v, "requested_reviewers", "login"),
        review_decision: String::new(),
        merge_state_status: String::new(),
        checks_rollup: String::new(),
        auto_merge: AutoMergeState::default(),
        comment_count: jnum(v, "comments"),
    }
}

fn map_pr_detail(v: &serde_json::Value) -> PullRequestDetail {
    PullRequestDetail {
        number: jnum(v, "number"),
        title: jstr(v, "title"),
        body: jstr(v, "body"),
        state: jstr(v, "state"),
        author: jlogin(v, "user"),
        branch: jref(v, "head", "ref"),
        base: jref(v, "base", "ref"),
        draft: v.get("draft").and_then(|d| d.as_bool()).unwrap_or(false),
        created_at: jstr(v, "created_at"),
        updated_at: jstr(v, "updated_at"),
        merged_at: jstr(v, "merged_at"),
        url: jstr(v, "html_url"),
        additions: jnum(v, "additions"),
        deletions: jnum(v, "deletions"),
        changed_files: jnum(v, "changed_files"),
        comments: jnum(v, "comments"),
        review_comments: 0,
        labels: jnames(v, "labels", "name"),
        reviewers: jnames(v, "requested_reviewers", "login"),
        mergeable: mergeable_str(v),
        checks_status: String::new(),
        // Gitea exposes no cheap per-viewer merge permission here. `None` means
        // unknown, which the UI must read as "allowed, gate on errors".
        can_merge: None,
        head_sha: jref(v, "head", "sha"),
        auto_merge: AutoMergeState::default(),
        auto_merge_support: gitea_auto_merge_support(),
    }
}

/// Gitea does support `merge_when_checks_succeed`, but wiring it is a follow-up
/// (see the spec, section 2). Report it unsupported and say what still works,
/// following the Bitbucket precedent.
fn gitea_auto_merge_support() -> AutoMergeSupport {
    AutoMergeSupport {
        supported: false,
        reason: Some(
            "GitWand does not queue auto-merge on Gitea yet. Merging immediately still works."
                .to_string(),
        ),
    }
}

fn map_status(v: &serde_json::Value) -> Vec<CICheck> {
    v.get("statuses")
        .and_then(|a| a.as_array())
        .map(|arr| {
            arr.iter()
                .map(|s| CICheck {
                    name: jstr(s, "context"),
                    state: jstr(s, "status"),
                    conclusion: jstr(s, "status"),
                    details_url: jstr(s, "target_url"),
                })
                .collect()
        })
        .unwrap_or_default()
}

// ─── Commands ───────────────────────────────────────────────────────────────

/// Gitea states: `open`, `closed`, `all`. Anything else reads as `open`.
fn gitea_state(state: &str) -> &'static str {
    match state.to_lowercase().as_str() {
        "closed" | "merged" => "closed",
        "all" => "all",
        _ => "open",
    }
}

#[tauri::command]
pub(crate) async fn gitea_list_prs(
    cwd: String,
    state: String,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<Vec<PullRequest>, String> {
    let ctx = gitea_ctx(&cwd)?;
    let per_page = limit.unwrap_or(10).max(1);
    let off = offset.unwrap_or(0).max(0);
    // Gitea pages are 1-indexed. Ask for one page big enough to cover the
    // offset, then drop the entries before it.
    let page = (off / per_page) + 1;
    let extra = off % per_page;
    let url = format!(
        "{}/pulls?state={}&limit={}&page={}",
        ctx.repo_api(),
        gitea_state(&state),
        per_page + extra,
        page
    );
    let resp = gitea_curl("GET", &url, None, &ctx.auth)?;
    let arr = resp.as_array().cloned().unwrap_or_default();
    Ok(arr
        .iter()
        .skip(extra as usize)
        .take(per_page as usize)
        .map(map_pr)
        .collect())
}

#[tauri::command]
pub(crate) async fn gitea_pr_count(cwd: String, state: String) -> Result<i64, String> {
    let ctx = match gitea_ctx(&cwd) {
        Ok(c) => c,
        Err(_) => return Ok(0),
    };
    let url = format!(
        "{}/pulls?state={}&limit=50&page=1",
        ctx.repo_api(),
        gitea_state(&state)
    );
    let resp = gitea_curl("GET", &url, None, &ctx.auth).unwrap_or(serde_json::Value::Null);
    Ok(resp.as_array().map(|a| a.len() as i64).unwrap_or(0))
}

#[tauri::command]
pub(crate) async fn gitea_get_pr(cwd: String, index: i64) -> Result<PullRequestDetail, String> {
    let ctx = gitea_ctx(&cwd)?;
    let url = format!("{}/pulls/{}", ctx.repo_api(), index);
    let resp = gitea_curl("GET", &url, None, &ctx.auth)?;
    let mut detail = map_pr_detail(&resp);
    if !detail.head_sha.is_empty() {
        let status_url = format!("{}/commits/{}/status", ctx.repo_api(), detail.head_sha);
        if let Ok(s) = gitea_curl("GET", &status_url, None, &ctx.auth) {
            detail.checks_status = jstr(&s, "state");
        }
    }
    Ok(detail)
}

/// Unified diff. `/pulls/{index}.diff` is the documented suffix form; some
/// deployments only answer `/pulls/{index}/patch`, so fall back to it rather
/// than surfacing a 404 as "no diff".
#[tauri::command]
pub(crate) async fn gitea_pr_diff(cwd: String, index: i64) -> Result<String, String> {
    let ctx = gitea_ctx(&cwd)?;
    let primary = format!("{}/pulls/{}.diff", ctx.repo_api(), index);
    let (status, body) = gitea_curl_raw("GET", &primary, None, &ctx.auth, "*/*")?;
    if status < 400 {
        return Ok(body);
    }
    let fallback = format!("{}/pulls/{}/patch", ctx.repo_api(), index);
    let (status2, body2) = gitea_curl_raw("GET", &fallback, None, &ctx.auth, "*/*")?;
    if status2 >= 400 {
        return Err(format!(
            "Gitea diff failed (HTTP {} on .diff, HTTP {} on /patch)",
            status, status2
        ));
    }
    Ok(body2)
}

#[tauri::command]
pub(crate) async fn gitea_pr_status(cwd: String, index: i64) -> Result<Vec<CICheck>, String> {
    let ctx = gitea_ctx(&cwd)?;
    let pr = gitea_curl("GET", &format!("{}/pulls/{}", ctx.repo_api(), index), None, &ctx.auth)?;
    let sha = jref(&pr, "head", "sha");
    if sha.is_empty() {
        return Ok(Vec::new());
    }
    let url = format!("{}/commits/{}/status", ctx.repo_api(), sha);
    let resp = gitea_curl("GET", &url, None, &ctx.auth)?;
    Ok(map_status(&resp))
}

#[tauri::command]
pub(crate) async fn gitea_pr_files(cwd: String, index: i64) -> Result<Vec<String>, String> {
    let ctx = gitea_ctx(&cwd)?;
    let url = format!("{}/pulls/{}/files?limit=100", ctx.repo_api(), index);
    let resp = gitea_curl("GET", &url, None, &ctx.auth)?;
    Ok(resp
        .as_array()
        .map(|arr| arr.iter().map(|f| jstr(f, "filename")).collect())
        .unwrap_or_default())
}
```

Register all six in `lib.rs` next to the two from Task 1.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/desktop/src-tauri && cargo test gitea`
Expected: PASS, the 4 base-URL tests plus the 6 mapping tests.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/commands/gitea.rs apps/desktop/src-tauri/src/lib.rs
git commit -m "feat(desktop): Gitea PR listing, detail, diff and CI status"
```

---

### Task 4: Comments, reviews, issues, reviewer candidates, branches

**Files:**
- Modify: `apps/desktop/src-tauri/src/commands/gitea.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: everything from Tasks 1 and 3.
- Produces: `fn map_comment(v: &serde_json::Value) -> serde_json::Value`, `fn map_review(v: &serde_json::Value) -> serde_json::Value`, `fn map_issue(v: &serde_json::Value) -> Issue`, and commands `gitea_pr_comments(cwd, index)`, `gitea_create_comment(cwd, index, body)`, `gitea_update_comment(cwd, comment_id, body)`, `gitea_delete_comment(cwd, comment_id)`, `gitea_list_reviews(cwd, index)`, `gitea_list_issues(cwd, limit)`, `gitea_reviewer_candidates(cwd)`, `gitea_branches(cwd)`.

Comments and reviews are returned as `serde_json::Value` shaped to the frontend's `PrReviewComment` / `PrReview` interfaces, following the `gl_mr_notes` precedent (`backend-gitlab.ts:274` receives `unknown[]`). The shaping happens here so the shape is unit-testable in Rust.

- [ ] **Step 1: Write the failing tests**

```rust
#[cfg(test)]
mod gitea_comment_tests {
    use super::{map_comment, map_issue, map_review};

    #[test]
    fn maps_an_issue_comment_onto_the_frontend_shape() {
        let v: serde_json::Value = serde_json::from_str(
            r#"{
              "id": 7,
              "body": "looks good",
              "user": {"login": "alice"},
              "created_at": "2026-09-01T10:00:00Z",
              "updated_at": "2026-09-01T11:00:00Z",
              "html_url": "https://git.acme.io/acme/app/pulls/42#issuecomment-7"
            }"#,
        )
        .unwrap();
        let c = map_comment(&v);
        assert_eq!(c["id"], 7);
        assert_eq!(c["author"], "alice");
        assert_eq!(c["body"], "looks good");
        // Conversation comments are not anchored to a diff line. The panel
        // keys off `path` being empty to keep the inline affordances hidden.
        assert_eq!(c["path"], "");
        assert!(c["line"].is_null());
        assert_eq!(c["side"], "RIGHT");
    }

    #[test]
    fn maps_review_states_onto_the_shared_vocabulary() {
        let mk = |state: &str| {
            serde_json::from_str::<serde_json::Value>(&format!(
                r#"{{"id": 3, "state": "{state}", "body": "b",
                     "user": {{"login": "carol"}},
                     "submitted_at": "2026-09-01T10:00:00Z",
                     "html_url": "https://git.acme.io/r/1"}}"#
            ))
            .unwrap()
        };
        assert_eq!(map_review(&mk("APPROVED"))["state"], "APPROVED");
        assert_eq!(map_review(&mk("REQUEST_CHANGES"))["state"], "CHANGES_REQUESTED");
        assert_eq!(map_review(&mk("COMMENT"))["state"], "COMMENTED");
        assert_eq!(map_review(&mk("PENDING"))["state"], "PENDING");
        assert_eq!(map_review(&mk("APPROVED"))["user"]["login"], "carol");
    }

    #[test]
    fn maps_a_repo_issue() {
        let v: serde_json::Value = serde_json::from_str(
            r#"{
              "number": 12, "title": "Crash on save", "state": "open",
              "user": {"login": "dave"},
              "assignees": [{"login": "erin"}],
              "labels": [{"name": "bug"}],
              "html_url": "https://git.acme.io/acme/app/issues/12",
              "created_at": "2026-09-01T10:00:00Z",
              "updated_at": "2026-09-02T10:00:00Z",
              "milestone": {"title": "v2"}
            }"#,
        )
        .unwrap();
        let i = map_issue(&v);
        assert_eq!(i.number, 12);
        assert_eq!(i.author, "dave");
        assert_eq!(i.assignees, vec!["erin".to_string()]);
        assert_eq!(i.labels, vec!["bug".to_string()]);
        assert_eq!(i.milestone, "v2");
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/desktop/src-tauri && cargo test gitea_comment`
Expected: FAIL to compile, `cannot find function map_comment`.

- [ ] **Step 3: Write the mappers and the commands**

```rust
/// Shape a Gitea issue comment into the frontend's `PrReviewComment`.
///
/// Gitea's issue-comment endpoint carries no diff anchor, so `path` is empty
/// and `line` is null. `usePrPanel` reads that as "conversation comment" and
/// keeps the inline-comment affordances hidden.
fn map_comment(v: &serde_json::Value) -> serde_json::Value {
    serde_json::json!({
        "id": jnum(v, "id"),
        "body": jstr(v, "body"),
        "author": jlogin(v, "user"),
        "created_at": jstr(v, "created_at"),
        "updated_at": jstr(v, "updated_at"),
        "path": "",
        "line": serde_json::Value::Null,
        "original_line": serde_json::Value::Null,
        "side": "RIGHT",
        "start_line": serde_json::Value::Null,
        "start_side": serde_json::Value::Null,
        "in_reply_to_id": serde_json::Value::Null,
        "diff_hunk": "",
        "url": jstr(v, "html_url"),
    })
}

/// Gitea review states are `APPROVED`, `REQUEST_CHANGES`, `COMMENT`, `PENDING`.
/// The shared vocabulary uses `CHANGES_REQUESTED` and `COMMENTED`.
fn map_review(v: &serde_json::Value) -> serde_json::Value {
    let state = match jstr(v, "state").to_uppercase().as_str() {
        "APPROVED" => "APPROVED",
        "REQUEST_CHANGES" | "REQUEST_REVIEW" => "CHANGES_REQUESTED",
        "COMMENT" => "COMMENTED",
        "PENDING" => "PENDING",
        other if !other.is_empty() => "COMMENTED",
        _ => "",
    };
    serde_json::json!({
        "id": jnum(v, "id"),
        "state": state,
        "body": jstr(v, "body"),
        "user": { "login": jlogin(v, "user"), "avatar_url": "" },
        "submitted_at": jstr(v, "submitted_at"),
        "html_url": jstr(v, "html_url"),
    })
}

fn map_issue(v: &serde_json::Value) -> Issue {
    Issue {
        number: jnum(v, "number"),
        title: jstr(v, "title"),
        state: jstr(v, "state"),
        author: jlogin(v, "user"),
        assignees: jnames(v, "assignees", "login"),
        labels: jnames(v, "labels", "name"),
        url: jstr(v, "html_url"),
        created_at: jstr(v, "created_at"),
        updated_at: jstr(v, "updated_at"),
        milestone: v
            .get("milestone")
            .and_then(|m| m.get("title"))
            .and_then(|s| s.as_str())
            .unwrap_or("")
            .to_string(),
    }
}

#[tauri::command]
pub(crate) async fn gitea_pr_comments(
    cwd: String,
    index: i64,
) -> Result<Vec<serde_json::Value>, String> {
    let ctx = gitea_ctx(&cwd)?;
    let url = format!("{}/issues/{}/comments", ctx.repo_api(), index);
    let resp = gitea_curl("GET", &url, None, &ctx.auth)?;
    Ok(resp
        .as_array()
        .map(|arr| arr.iter().map(map_comment).collect())
        .unwrap_or_default())
}

#[tauri::command]
pub(crate) async fn gitea_create_comment(
    cwd: String,
    index: i64,
    body: String,
) -> Result<serde_json::Value, String> {
    let ctx = gitea_ctx(&cwd)?;
    let url = format!("{}/issues/{}/comments", ctx.repo_api(), index);
    let payload = serde_json::json!({ "body": body }).to_string();
    let resp = gitea_curl("POST", &url, Some(&payload), &ctx.auth)?;
    Ok(map_comment(&resp))
}

#[tauri::command]
pub(crate) async fn gitea_update_comment(
    cwd: String,
    comment_id: i64,
    body: String,
) -> Result<(), String> {
    let ctx = gitea_ctx(&cwd)?;
    let url = format!("{}/issues/comments/{}", ctx.repo_api(), comment_id);
    let payload = serde_json::json!({ "body": body }).to_string();
    gitea_curl("PATCH", &url, Some(&payload), &ctx.auth)?;
    Ok(())
}

#[tauri::command]
pub(crate) async fn gitea_delete_comment(cwd: String, comment_id: i64) -> Result<(), String> {
    let ctx = gitea_ctx(&cwd)?;
    let url = format!("{}/issues/comments/{}", ctx.repo_api(), comment_id);
    gitea_curl("DELETE", &url, None, &ctx.auth)?;
    Ok(())
}

#[tauri::command]
pub(crate) async fn gitea_list_reviews(
    cwd: String,
    index: i64,
) -> Result<Vec<serde_json::Value>, String> {
    let ctx = gitea_ctx(&cwd)?;
    let url = format!("{}/pulls/{}/reviews", ctx.repo_api(), index);
    let resp = gitea_curl("GET", &url, None, &ctx.auth)?;
    Ok(resp
        .as_array()
        .map(|arr| arr.iter().map(map_review).collect())
        .unwrap_or_default())
}

#[tauri::command]
pub(crate) async fn gitea_list_issues(cwd: String, limit: Option<i64>) -> Result<Vec<Issue>, String> {
    let ctx = gitea_ctx(&cwd)?;
    // `type=issues` keeps PRs out: Gitea's issue endpoint returns both.
    let url = format!(
        "{}/issues?state=open&type=issues&limit={}",
        ctx.repo_api(),
        limit.unwrap_or(30).max(1)
    );
    let resp = gitea_curl("GET", &url, None, &ctx.auth)?;
    Ok(resp
        .as_array()
        .map(|arr| arr.iter().map(map_issue).collect())
        .unwrap_or_default())
}

#[tauri::command]
pub(crate) async fn gitea_reviewer_candidates(cwd: String) -> Result<Vec<ReviewerCandidate>, String> {
    let ctx = gitea_ctx(&cwd)?;
    let url = format!("{}/collaborators?limit=100", ctx.repo_api());
    let resp = gitea_curl("GET", &url, None, &ctx.auth)?;
    Ok(resp
        .as_array()
        .map(|arr| {
            arr.iter()
                .map(|u| ReviewerCandidate {
                    login: jstr(u, "login"),
                    name: Some(jstr(u, "full_name")).filter(|s| !s.is_empty()),
                    avatar_url: Some(jstr(u, "avatar_url")).filter(|s| !s.is_empty()),
                })
                .collect()
        })
        .unwrap_or_default())
}

#[tauri::command]
pub(crate) async fn gitea_branches(cwd: String) -> Result<Vec<String>, String> {
    let ctx = gitea_ctx(&cwd)?;
    let url = format!("{}/branches?limit=100", ctx.repo_api());
    let resp = gitea_curl("GET", &url, None, &ctx.auth)?;
    Ok(resp
        .as_array()
        .map(|arr| arr.iter().map(|b| jstr(b, "name")).collect())
        .unwrap_or_default())
}
```

Register all eight in `lib.rs`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/desktop/src-tauri && cargo test gitea`
Expected: PASS, all three test modules.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/commands/gitea.rs apps/desktop/src-tauri/src/lib.rs
git commit -m "feat(desktop): Gitea comments, reviews, issues, collaborators and branches"
```

---

### Task 5: Write commands, create, merge, checkout, draft to ready

**Files:**
- Modify: `apps/desktop/src-tauri/src/commands/gitea.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: everything above.
- Produces: `fn merge_payload(method: &str, use_legacy_field: bool) -> String`, and commands `gitea_create_pr(cwd, title, body, source_branch, target_branch)`, `gitea_merge_pr(cwd, index, method)`, `gitea_checkout_pr(cwd, index)`, `gitea_convert_draft_to_ready(cwd, index)`.

The merge endpoint's field name differs across versions (`Do` in older Gitea, `merge_method` in current docs). The command sends the documented field first and retries with the legacy one on a 4xx, which is the version tolerance the spec calls for in section 7.1.

- [ ] **Step 1: Write the failing tests**

```rust
#[cfg(test)]
mod gitea_merge_payload_tests {
    use super::merge_payload;

    #[test]
    fn sends_the_documented_field_first() {
        let body = merge_payload("squash", false);
        assert!(body.contains("\"merge_method\":\"squash\""), "got {body}");
        assert!(!body.contains("\"Do\""));
    }

    #[test]
    fn falls_back_to_the_legacy_field() {
        let body = merge_payload("rebase", true);
        assert!(body.contains("\"Do\":\"rebase\""), "got {body}");
    }

    #[test]
    fn defaults_an_unknown_method_to_merge() {
        // The forge contract allows "merge" | "squash" | "rebase". Anything
        // else is a caller bug; a plain merge is the safe reading.
        assert!(merge_payload("octopus", false).contains("\"merge_method\":\"merge\""));
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/desktop/src-tauri && cargo test gitea_merge_payload`
Expected: FAIL to compile, `cannot find function merge_payload`.

- [ ] **Step 3: Write the commands**

```rust
/// Build the merge request body. `use_legacy_field` swaps `merge_method` for
/// `Do`, which older Gitea versions require.
fn merge_payload(method: &str, use_legacy_field: bool) -> String {
    let m = match method {
        "squash" => "squash",
        "rebase" => "rebase",
        _ => "merge",
    };
    let key = if use_legacy_field { "Do" } else { "merge_method" };
    serde_json::json!({ key: m }).to_string()
}

#[tauri::command]
pub(crate) async fn gitea_create_pr(
    cwd: String,
    title: String,
    body: String,
    source_branch: String,
    target_branch: String,
) -> Result<PullRequest, String> {
    let ctx = gitea_ctx(&cwd)?;
    let head = if source_branch.is_empty() {
        let out = hidden_cmd("git")
            .args(["rev-parse", "--abbrev-ref", "HEAD"])
            .current_dir(&cwd)
            .output()
            .map_err(|e| format!("git rev-parse: {}", e))?;
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    } else {
        source_branch
    };
    if head.is_empty() {
        return Err("Could not resolve the source branch.".to_string());
    }
    let base = if target_branch.is_empty() {
        "main".to_string()
    } else {
        target_branch
    };
    let payload = serde_json::json!({
        "title": title,
        "body": body,
        "head": head,
        "base": base,
    })
    .to_string();
    let resp = gitea_curl("POST", &format!("{}/pulls", ctx.repo_api()), Some(&payload), &ctx.auth)?;
    Ok(map_pr(&resp))
}

#[tauri::command]
pub(crate) async fn gitea_merge_pr(
    cwd: String,
    index: i64,
    method: Option<String>,
) -> Result<(), String> {
    let ctx = gitea_ctx(&cwd)?;
    let url = format!("{}/pulls/{}/merge", ctx.repo_api(), index);
    let m = method.unwrap_or_else(|| "merge".to_string());

    let payload = merge_payload(&m, false);
    let (status, body) = gitea_curl_raw("POST", &url, Some(&payload), &ctx.auth, "application/json")?;
    if status < 400 {
        return Ok(());
    }
    // Older Gitea rejects `merge_method` and wants `Do`. Retry once before
    // reporting, so the user never sees a version mismatch as a merge failure.
    let legacy = merge_payload(&m, true);
    let (status2, body2) =
        gitea_curl_raw("POST", &url, Some(&legacy), &ctx.auth, "application/json")?;
    if status2 < 400 {
        return Ok(());
    }
    Err(format!(
        "Gitea merge failed (HTTP {}: {}); retry with the legacy field also failed (HTTP {}: {})",
        status,
        body.trim(),
        status2,
        body2.trim()
    ))
}

/// Fetch the PR head into a local branch and check it out.
///
/// Gitea exposes PR refs as `refs/pull/{index}/head`, same as GitHub.
#[tauri::command]
pub(crate) async fn gitea_checkout_pr(cwd: String, index: i64) -> Result<(), String> {
    let branch = format!("pr-{}", index);
    let refspec = format!("refs/pull/{}/head:{}", index, branch);
    let fetch = hidden_cmd("git")
        .args(["fetch", "origin", &refspec])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("git fetch: {}", e))?;
    if !fetch.status.success() {
        return Err(format!(
            "git fetch failed: {}",
            String::from_utf8_lossy(&fetch.stderr).trim()
        ));
    }
    let checkout = hidden_cmd("git")
        .args(["checkout", &branch])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("git checkout: {}", e))?;
    if !checkout.status.success() {
        return Err(format!(
            "git checkout failed: {}",
            String::from_utf8_lossy(&checkout.stderr).trim()
        ));
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn gitea_convert_draft_to_ready(cwd: String, index: i64) -> Result<(), String> {
    let ctx = gitea_ctx(&cwd)?;
    let url = format!("{}/pulls/{}", ctx.repo_api(), index);
    let payload = serde_json::json!({ "draft": false }).to_string();
    gitea_curl("PATCH", &url, Some(&payload), &ctx.auth)?;
    Ok(())
}
```

Register all four in `lib.rs`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/desktop/src-tauri && cargo test gitea`
Expected: PASS, all four test modules.

Run: `cd apps/desktop/src-tauri && cargo clippy --all-targets 2>&1 | tail -20`
Expected: no new warnings from `gitea.rs`.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/commands/gitea.rs apps/desktop/src-tauri/src/lib.rs
git commit -m "feat(desktop): Gitea create, merge, checkout and draft-to-ready"
```

---

### Task 6: TypeScript wrappers and the dev-server read routes

**Files:**
- Create: `apps/desktop/src/utils/backend-gitea.ts`
- Modify: `apps/desktop/src/utils/backend.ts` (re-export block)
- Modify: `apps/desktop/dev-server.mjs`

**Interfaces:**
- Consumes: every `gitea_*` command from Tasks 1, 3, 4 and 5.
- Produces, used by Task 7: `giteaCurrentUser(cwd)`, `giteaValidateToken(host, token)`, `giteaListPrs(cwd, state, limit, offset)`, `giteaPrCount(cwd, state)`, `giteaGetPr(cwd, index)`, `giteaPrDiff(cwd, index)`, `giteaPrStatus(cwd, index)`, `giteaPrFiles(cwd, index)`, `giteaListIssues(cwd, limit)`, `giteaPrComments(cwd, index)`, `giteaCreateComment(cwd, index, body)`, `giteaUpdateComment(cwd, commentId, body)`, `giteaDeleteComment(cwd, commentId)`, `giteaListReviews(cwd, index)`, `giteaCreatePr(cwd, title, body, sourceBranch, targetBranch)`, `giteaMergePr(cwd, index, method)`, `giteaCheckoutPr(cwd, index)`, `giteaConvertDraftToReady(cwd, index)`, `giteaReviewerCandidates(cwd)`, `giteaBranches(cwd)`.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/utils/__tests__/backend-gitea.test.ts`:

```ts
/**
 * The read wrappers must work in browser mode (dev:web) and the write wrappers
 * must refuse it loudly, which is the split the spec fixes for this forge.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../backend-core", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../backend-core");
  return { ...actual, isTauri: () => false, tauriInvoke: vi.fn() };
});

import { giteaListPrs, giteaMergePr } from "../backend-gitea";

describe("backend-gitea in browser mode", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [{ number: 1, title: "t", state: "open" }],
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("routes a read through the dev-server", async () => {
    const prs = await giteaListPrs("/repo", "open", 10, 0);
    expect(prs).toHaveLength(1);
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/gitea-list-prs"),
      expect.anything(),
    );
  });

  it("refuses a write with a message that names the mode", async () => {
    await expect(giteaMergePr("/repo", 1, "merge")).rejects.toThrow(/requires Tauri/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/desktop && pnpm vitest run src/utils/__tests__/backend-gitea.test.ts`
Expected: FAIL, cannot resolve `../backend-gitea`.

- [ ] **Step 3: Write the wrappers and the routes**

Create `apps/desktop/src/utils/backend-gitea.ts`:

```ts
/**
 * @file backend-gitea.ts
 *
 * Typed wrappers over the `gitea_*` Tauri commands.
 *
 * Read paths also work in `dev:web` through dev-server routes, which is a
 * deliberate departure from GitLab/Bitbucket/Azure (all Tauri-only). It is what
 * makes the Gitea panel testable without a packaged build.
 *
 * Write paths stay Tauri-only and throw in browser mode.
 */

import { isTauri, tauriInvoke, DEV_SERVER } from "./backend-core";
import type { PullRequest, PullRequestDetail, CICheck, PrReviewComment, PrReview, Issue, ReviewerCandidate } from "./backend-pr";

async function devGet<T>(route: string, params: Record<string, string>): Promise<T> {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${DEV_SERVER}/api/${route}?${qs}`, { method: "GET" });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`dev-server ${route} failed: ${detail}`);
  }
  return (await res.json()) as T;
}

// ─── Reads (Tauri + dev:web) ────────────────────────────────────────────────

export async function giteaCurrentUser(cwd: string): Promise<string> {
  if (isTauri()) return tauriInvoke<string>("gitea_current_user", { cwd });
  return devGet<string>("gitea-current-user", { cwd });
}

export async function giteaListPrs(
  cwd: string,
  state = "open",
  limit = 10,
  offset = 0,
): Promise<PullRequest[]> {
  if (isTauri()) return tauriInvoke<PullRequest[]>("gitea_list_prs", { cwd, state, limit, offset });
  return devGet<PullRequest[]>("gitea-list-prs", {
    cwd,
    state,
    limit: String(limit),
    offset: String(offset),
  });
}

export async function giteaPrCount(cwd: string, state = "open"): Promise<number> {
  if (isTauri()) return tauriInvoke<number>("gitea_pr_count", { cwd, state });
  return devGet<number>("gitea-pr-count", { cwd, state });
}

export async function giteaGetPr(cwd: string, index: number): Promise<PullRequestDetail> {
  if (isTauri()) return tauriInvoke<PullRequestDetail>("gitea_get_pr", { cwd, index });
  return devGet<PullRequestDetail>("gitea-get-pr", { cwd, index: String(index) });
}

export async function giteaPrDiff(cwd: string, index: number): Promise<string> {
  if (isTauri()) return tauriInvoke<string>("gitea_pr_diff", { cwd, index });
  return devGet<string>("gitea-pr-diff", { cwd, index: String(index) });
}

export async function giteaPrStatus(cwd: string, index: number): Promise<CICheck[]> {
  if (isTauri()) return tauriInvoke<CICheck[]>("gitea_pr_status", { cwd, index });
  return devGet<CICheck[]>("gitea-pr-status", { cwd, index: String(index) });
}

export async function giteaPrComments(cwd: string, index: number): Promise<PrReviewComment[]> {
  if (isTauri()) return tauriInvoke<PrReviewComment[]>("gitea_pr_comments", { cwd, index });
  return devGet<PrReviewComment[]>("gitea-pr-comments", { cwd, index: String(index) });
}

export async function giteaListIssues(cwd: string, limit = 30): Promise<Issue[]> {
  if (isTauri()) return tauriInvoke<Issue[]>("gitea_list_issues", { cwd, limit });
  return devGet<Issue[]>("gitea-list-issues", { cwd, limit: String(limit) });
}

// ─── Reads (Tauri only) ─────────────────────────────────────────────────────

export async function giteaPrFiles(cwd: string, index: number): Promise<string[]> {
  if (!isTauri()) return [];
  return tauriInvoke<string[]>("gitea_pr_files", { cwd, index });
}

export async function giteaListReviews(cwd: string, index: number): Promise<PrReview[]> {
  if (!isTauri()) return [];
  return tauriInvoke<PrReview[]>("gitea_list_reviews", { cwd, index });
}

export async function giteaReviewerCandidates(cwd: string): Promise<ReviewerCandidate[]> {
  if (!isTauri()) return [];
  return tauriInvoke<ReviewerCandidate[]>("gitea_reviewer_candidates", { cwd });
}

export async function giteaBranches(cwd: string): Promise<string[]> {
  if (!isTauri()) return [];
  return tauriInvoke<string[]>("gitea_branches", { cwd });
}

// ─── Writes (Tauri only) ────────────────────────────────────────────────────

export async function giteaValidateToken(host: string, token: string): Promise<string> {
  if (!isTauri()) throw new Error("giteaValidateToken requires Tauri");
  return tauriInvoke<string>("gitea_validate_token", { host, token });
}

export async function giteaCreatePr(
  cwd: string,
  title: string,
  body: string,
  sourceBranch: string,
  targetBranch: string,
): Promise<PullRequest> {
  if (!isTauri()) throw new Error("giteaCreatePr requires Tauri");
  return tauriInvoke<PullRequest>("gitea_create_pr", {
    cwd,
    title,
    body,
    sourceBranch,
    targetBranch,
  });
}

export async function giteaMergePr(cwd: string, index: number, method?: string): Promise<void> {
  if (!isTauri()) throw new Error("giteaMergePr requires Tauri");
  return tauriInvoke<void>("gitea_merge_pr", { cwd, index, method });
}

export async function giteaCheckoutPr(cwd: string, index: number): Promise<void> {
  if (!isTauri()) throw new Error("giteaCheckoutPr requires Tauri");
  return tauriInvoke<void>("gitea_checkout_pr", { cwd, index });
}

export async function giteaConvertDraftToReady(cwd: string, index: number): Promise<void> {
  if (!isTauri()) throw new Error("giteaConvertDraftToReady requires Tauri");
  return tauriInvoke<void>("gitea_convert_draft_to_ready", { cwd, index });
}

export async function giteaCreateComment(
  cwd: string,
  index: number,
  body: string,
): Promise<PrReviewComment> {
  if (!isTauri()) throw new Error("giteaCreateComment requires Tauri");
  return tauriInvoke<PrReviewComment>("gitea_create_comment", { cwd, index, body });
}

export async function giteaUpdateComment(
  cwd: string,
  commentId: number,
  body: string,
): Promise<void> {
  if (!isTauri()) throw new Error("giteaUpdateComment requires Tauri");
  return tauriInvoke<void>("gitea_update_comment", { cwd, commentId, body });
}

export async function giteaDeleteComment(cwd: string, commentId: number): Promise<void> {
  if (!isTauri()) throw new Error("giteaDeleteComment requires Tauri");
  return tauriInvoke<void>("gitea_delete_comment", { cwd, commentId });
}
```

Re-export from `backend.ts` next to the other forge re-exports (`export * from "./backend-gitlab";` and friends):

```ts
export * from "./backend-gitea";
```

Add the 8 read routes to `dev-server.mjs`, near the other `/api/` handlers. Write one helper plus the routes:

```js
    // ── Gitea read routes ──────────────────────────────────────────────────
    //
    // NOTE, and this is a real difference, not an oversight: the Rust commands
    // read the token from the OS keychain, which this process cannot do. These
    // routes read GITWAND_GITEA_TOKEN instead, so the auth path in dev:web is
    // NOT the same code path as the packaged app. Everything after auth (URL
    // shape, response mapping) is the same. See the v3.11.0 dev-server drift
    // audit lot.
    if (url.pathname.startsWith("/api/gitea-")) {
      const token = process.env.GITWAND_GITEA_TOKEN;
      if (!token) {
        return jsonResponse(req, res, {
          error: "GITWAND_GITEA_TOKEN is not set. Export it before `pnpm dev:web` to exercise Gitea routes.",
        }, 400);
      }
      const cwd = url.searchParams.get("cwd") || "";
      let remote = "";
      try {
        remote = execFileSync("git", ["remote", "get-url", "origin"], { cwd }).toString().trim();
      } catch {
        return jsonResponse(req, res, { error: "No 'origin' remote found in this repo." }, 400);
      }
      const host = remote.startsWith("git@")
        ? remote.slice(4).split(":")[0]
        : new URL(remote).host;
      const path = remote.startsWith("git@")
        ? remote.split(":")[1]
        : new URL(remote).pathname.replace(/^\//, "");
      const [owner, repoRaw] = path.replace(/\.git$/, "").split("/");
      const repoApi = `https://${host}/api/v1/repos/${owner}/${repoRaw}`;
      const headers = { Authorization: `token ${token}`, Accept: "application/json" };
      const index = url.searchParams.get("index");

      const call = async (suffix, asText = false) => {
        const r = await fetch(`${repoApi}${suffix}`, { headers });
        if (!r.ok) throw new Error(`Gitea API error: HTTP ${r.status}`);
        return asText ? r.text() : r.json();
      };

      try {
        switch (url.pathname) {
          case "/api/gitea-current-user": {
            const r = await fetch(`https://${host}/api/v1/user`, { headers });
            const u = await r.json();
            return jsonResponse(req, res, u.login || "");
          }
          case "/api/gitea-list-prs": {
            const state = url.searchParams.get("state") || "open";
            const limit = url.searchParams.get("limit") || "10";
            return jsonResponse(req, res, await call(`/pulls?state=${state}&limit=${limit}&page=1`));
          }
          case "/api/gitea-pr-count": {
            const state = url.searchParams.get("state") || "open";
            const list = await call(`/pulls?state=${state}&limit=50&page=1`);
            return jsonResponse(req, res, Array.isArray(list) ? list.length : 0);
          }
          case "/api/gitea-get-pr":
            return jsonResponse(req, res, await call(`/pulls/${index}`));
          case "/api/gitea-pr-diff":
            return jsonResponse(req, res, await call(`/pulls/${index}.diff`, true));
          case "/api/gitea-pr-status": {
            const pr = await call(`/pulls/${index}`);
            const sha = pr?.head?.sha;
            if (!sha) return jsonResponse(req, res, []);
            return jsonResponse(req, res, await call(`/commits/${sha}/status`));
          }
          case "/api/gitea-pr-comments":
            return jsonResponse(req, res, await call(`/issues/${index}/comments`));
          case "/api/gitea-list-issues": {
            const limit = url.searchParams.get("limit") || "30";
            return jsonResponse(req, res, await call(`/issues?state=open&type=issues&limit=${limit}`));
          }
          default:
            return jsonResponse(req, res, { error: "Unknown Gitea route" }, 404);
        }
      } catch (err) {
        return jsonResponse(req, res, { error: err.message }, 502);
      }
    }
```

If `execFileSync` is not already imported in `dev-server.mjs`, reuse whatever child-process helper the neighbouring routes use rather than adding a second import.

The raw Gitea payloads returned by `-list-prs`, `-get-pr`, `-pr-status`, `-pr-comments` and `-list-issues` are not the mapped shapes the Rust commands return. That is a known, deliberate limit of this browser path: it exercises transport and auth, not mapping. State it in a comment above the switch so nobody reads it as parity.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/desktop && pnpm vitest run src/utils/__tests__/backend-gitea.test.ts`
Expected: PASS, 2 tests.

Run: `cd apps/desktop && pnpm build`
Expected: `vue-tsc --noEmit` clean.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/utils/backend-gitea.ts apps/desktop/src/utils/backend.ts apps/desktop/src/utils/__tests__/backend-gitea.test.ts apps/desktop/dev-server.mjs
git commit -m "feat(desktop): Gitea IPC wrappers and dev-server read routes"
```

---

### Task 7: GiteaProvider and registry wiring

**Files:**
- Create: `apps/desktop/src/composables/forge/GiteaProvider.ts`
- Create: `apps/desktop/src/composables/forge/__tests__/GiteaProvider.test.ts`
- Modify: `apps/desktop/src/composables/forge/types.ts` (the `ForgeName` union)
- Modify: `apps/desktop/src/composables/forge/useForge.ts` (pre-warm block)
- Modify: `apps/desktop/src/composables/forge/index.ts` (barrel export)

**Interfaces:**
- Consumes: every wrapper from Task 6.
- Produces: `class GiteaProvider implements ForgeProvider`, `const giteaProvider`, and `ForgeName` including `"gitea"`.

- [ ] **Step 1: Write the failing tests**

Create `apps/desktop/src/composables/forge/__tests__/GiteaProvider.test.ts`:

```ts
/**
 * GiteaProvider: the implemented surface delegates to the backend wrappers,
 * and the unimplemented surface throws ForgeNotImplementedError so the UI
 * hides the affordance instead of showing a button that does nothing.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const giteaCurrentUser = vi.fn();
const giteaListPrs = vi.fn();
const giteaGetPr = vi.fn();
const giteaPrDiff = vi.fn();
const giteaPrStatus = vi.fn();
const giteaPrComments = vi.fn();
const giteaCreateComment = vi.fn();
const giteaListReviews = vi.fn();
const giteaMergePr = vi.fn();
const giteaListIssues = vi.fn();

vi.mock("../../../utils/backend", () => ({
  giteaCurrentUser: (...a: unknown[]) => giteaCurrentUser(...a),
  giteaListPrs: (...a: unknown[]) => giteaListPrs(...a),
  giteaGetPr: (...a: unknown[]) => giteaGetPr(...a),
  giteaPrDiff: (...a: unknown[]) => giteaPrDiff(...a),
  giteaPrStatus: (...a: unknown[]) => giteaPrStatus(...a),
  giteaPrComments: (...a: unknown[]) => giteaPrComments(...a),
  giteaCreateComment: (...a: unknown[]) => giteaCreateComment(...a),
  giteaListReviews: (...a: unknown[]) => giteaListReviews(...a),
  giteaMergePr: (...a: unknown[]) => giteaMergePr(...a),
  giteaListIssues: (...a: unknown[]) => giteaListIssues(...a),
  giteaPrCount: vi.fn(),
  giteaPrFiles: vi.fn(),
  giteaCreatePr: vi.fn(),
  giteaCheckoutPr: vi.fn(),
  giteaConvertDraftToReady: vi.fn(),
  giteaUpdateComment: vi.fn(),
  giteaDeleteComment: vi.fn(),
  giteaReviewerCandidates: vi.fn(),
  giteaBranches: vi.fn(),
  ghPrConflictPreview: vi.fn(),
  ghPrHotspots: vi.fn(),
}));

import { GiteaProvider } from "../GiteaProvider";
import { ForgeNotImplementedError } from "../types";

describe("GiteaProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports its forge name", () => {
    expect(new GiteaProvider().name).toBe("gitea");
  });

  it("detects the hosts the pure Rust arm also detects", () => {
    const p = new GiteaProvider();
    expect(p.detectFromRemote("https://codeberg.org/acme/app.git")).toBe(true);
    expect(p.detectFromRemote("git@gitea.acme.io:acme/app.git")).toBe(true);
    expect(p.detectFromRemote("https://forgejo.acme.io/acme/app.git")).toBe(true);
    expect(p.detectFromRemote("https://github.com/acme/app.git")).toBe(false);
  });

  it("delegates listPRs with the state it was given", async () => {
    giteaListPrs.mockResolvedValue([]);
    await new GiteaProvider().listPRs("/repo", { state: "open", limit: 25, offset: 0 });
    expect(giteaListPrs).toHaveBeenCalledWith("/repo", "open", 25, 0);
  });

  it("delegates getPR, getPRDiff and getCIChecks", async () => {
    giteaGetPr.mockResolvedValue({ number: 1 });
    giteaPrDiff.mockResolvedValue("diff");
    giteaPrStatus.mockResolvedValue([]);
    const p = new GiteaProvider();
    await p.getPR("/repo", 1);
    await p.getPRDiff("/repo", 1);
    await p.getCIChecks("/repo", 1);
    expect(giteaGetPr).toHaveBeenCalledWith("/repo", 1);
    expect(giteaPrDiff).toHaveBeenCalledWith("/repo", 1);
    expect(giteaPrStatus).toHaveBeenCalledWith("/repo", 1);
  });

  it("returns no check annotations rather than failing", async () => {
    await expect(new GiteaProvider().getCheckAnnotations("/repo", 1)).resolves.toEqual([]);
  });

  it("throws ForgeNotImplementedError for auto-merge", async () => {
    const p = new GiteaProvider();
    await expect(p.enableAutoMerge("/repo", 1)).rejects.toBeInstanceOf(ForgeNotImplementedError);
    await expect(p.disableAutoMerge("/repo", 1)).rejects.toBeInstanceOf(ForgeNotImplementedError);
  });

  it("omits dismissReview entirely so the capability check hides the action", () => {
    // Defined-but-throwing would pass `typeof forge.dismissReview === "function"`
    // and render a button that silently fails. Same reasoning as GitLab.
    expect(new GiteaProvider().dismissReview).toBeUndefined();
  });

  it("throws ForgeNotImplementedError from submitReview", async () => {
    await expect(
      new GiteaProvider().submitReview("/repo", 1, { event: "APPROVE" }),
    ).rejects.toBeInstanceOf(ForgeNotImplementedError);
  });

  it("returns an empty file history rather than inventing one", async () => {
    await expect(new GiteaProvider().getFileHistory("/repo", ["a.ts"])).resolves.toEqual({});
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/desktop && pnpm vitest run src/composables/forge/__tests__/GiteaProvider.test.ts`
Expected: FAIL, cannot resolve `../GiteaProvider`.

- [ ] **Step 3: Write the provider and wire the registry**

In `forge/types.ts`, extend the union:

```ts
export type ForgeName = "github" | "gitlab" | "bitbucket" | "azure" | "cursor" | "gitea" | "unknown";
```

Create `apps/desktop/src/composables/forge/GiteaProvider.ts`:

```ts
/**
 * @file forge/GiteaProvider.ts
 *
 * Gitea / Forgejo implementation of ForgeProvider.
 *
 * Talks to `/api/v1` through the `gitea_*` Tauri commands. Auth is a personal
 * access token in the OS keychain, configured in Settings > Accounts, and the
 * server host comes from that account rather than from a constant.
 *
 * Deliberately unimplemented in this first pass (issue #193): auto-merge,
 * submitting and dismissing reviews, check annotations, file history. Reading
 * reviews IS implemented, so verdicts still render.
 */

import {
  giteaCurrentUser,
  giteaListPrs,
  giteaPrCount,
  giteaGetPr,
  giteaPrDiff,
  giteaPrStatus,
  giteaPrFiles,
  giteaListIssues,
  giteaPrComments,
  giteaCreateComment,
  giteaUpdateComment,
  giteaDeleteComment,
  giteaListReviews,
  giteaCreatePr,
  giteaMergePr,
  giteaCheckoutPr,
  giteaConvertDraftToReady,
  giteaReviewerCandidates,
  giteaBranches,
  ghPrConflictPreview,
  ghPrHotspots,
} from "../../utils/backend";

import {
  ForgeNotImplementedError,
  type ForgeProvider,
  type ForgeName,
  type ListPRsOptions,
  type ListIssuesOptions,
  type CreatePRInput,
  type SubmitReviewOptions,
  type PullRequest,
  type PullRequestDetail,
  type CICheck,
  type CIAnnotation,
  type PrReviewComment,
  type CreatePrCommentParams,
  type PrReview,
  type PrConflictPreview,
  type PrHotspot,
  type PrFileHistory,
  type ReviewerCandidate,
  type Issue,
  type Account,
} from "./types";

export class GiteaProvider implements ForgeProvider {
  readonly name: ForgeName = "gitea";

  private _account: Account | null = null;

  setAccount(account: Account | null): void {
    this._account = account;
  }

  /**
   * Only the hosts the pure Rust arm also recognises. A self-hosted instance on
   * a neutral hostname is resolved by the account-host match in
   * `gitRemoteInfo`, not here, so this stays a mirror of `detect_provider`.
   */
  detectFromRemote(remoteUrl: string): boolean {
    const u = remoteUrl.toLowerCase();
    return u.includes("codeberg.org") || u.includes("gitea") || u.includes("forgejo");
  }

  // ── Discovery ─────────────────────────────────────────────────────────────

  getCurrentUser(cwd: string): Promise<string> {
    return giteaCurrentUser(cwd);
  }

  listReviewerCandidates(cwd: string): Promise<ReviewerCandidate[]> {
    return giteaReviewerCandidates(cwd);
  }

  listBranches(cwd: string): Promise<string[]> {
    return giteaBranches(cwd);
  }

  // ── Listing ───────────────────────────────────────────────────────────────

  listPRs(cwd: string, opts?: ListPRsOptions): Promise<PullRequest[]> {
    return giteaListPrs(cwd, opts?.state ?? "open", opts?.limit ?? 10, opts?.offset ?? 0);
  }

  listIssues(cwd: string, opts?: ListIssuesOptions): Promise<Issue[]> {
    return giteaListIssues(cwd, opts?.limit ?? 30);
  }

  getPRCount(cwd: string, state = "open"): Promise<number> {
    return giteaPrCount(cwd, state);
  }

  getPRFiles(cwd: string, prNumber: number): Promise<string[]> {
    return giteaPrFiles(cwd, prNumber);
  }

  // ── Detail ────────────────────────────────────────────────────────────────

  getPR(cwd: string, number: number): Promise<PullRequestDetail> {
    return giteaGetPr(cwd, number);
  }

  getPRDiff(cwd: string, number: number): Promise<string> {
    return giteaPrDiff(cwd, number);
  }

  getCIChecks(cwd: string, number: number): Promise<CICheck[]> {
    return giteaPrStatus(cwd, number);
  }

  /** Gitea has no check-annotation concept GitWand can read. Empty, not an error. */
  async getCheckAnnotations(_cwd: string, _number: number): Promise<CIAnnotation[]> {
    return [];
  }

  // ── Actions ───────────────────────────────────────────────────────────────

  createPR(cwd: string, input: CreatePRInput): Promise<PullRequest> {
    return giteaCreatePr(cwd, input.title, input.body, "", input.base ?? "");
  }

  mergePR(cwd: string, number: number, method?: "merge" | "squash" | "rebase"): Promise<void> {
    return giteaMergePr(cwd, number, method ?? "merge");
  }

  async enableAutoMerge(): Promise<void> {
    throw new ForgeNotImplementedError("gitea", "enableAutoMerge");
  }

  async disableAutoMerge(): Promise<void> {
    throw new ForgeNotImplementedError("gitea", "disableAutoMerge");
  }

  checkoutPR(cwd: string, number: number): Promise<void> {
    return giteaCheckoutPr(cwd, number);
  }

  convertDraftToReady(cwd: string, number: number): Promise<void> {
    return giteaConvertDraftToReady(cwd, number);
  }

  // ── Comments ──────────────────────────────────────────────────────────────

  listComments(cwd: string, prNumber: number): Promise<PrReviewComment[]> {
    return giteaPrComments(cwd, prNumber);
  }

  listIssueComments(cwd: string, prNumber: number): Promise<PrReviewComment[]> {
    return giteaPrComments(cwd, prNumber);
  }

  createComment(
    cwd: string,
    prNumber: number,
    params: CreatePrCommentParams,
  ): Promise<PrReviewComment> {
    return giteaCreateComment(cwd, prNumber, params.body);
  }

  updateComment(cwd: string, commentId: number, body: string): Promise<void> {
    return giteaUpdateComment(cwd, commentId, body);
  }

  deleteComment(cwd: string, commentId: number): Promise<void> {
    return giteaDeleteComment(cwd, commentId);
  }

  // ── Reviews ───────────────────────────────────────────────────────────────

  listReviews(cwd: string, prNumber: number): Promise<PrReview[]> {
    return giteaListReviews(cwd, prNumber);
  }

  async submitReview(
    _cwd: string,
    _prNumber: number,
    _opts: SubmitReviewOptions,
  ): Promise<PrReview> {
    throw new ForgeNotImplementedError("gitea", "submitReview");
  }

  // `dismissReview` and `requestReviewers` are intentionally absent, not
  // defined-and-throwing: `usePrPanel` capability-checks with
  // `typeof forge.dismissReview === "function"` to hide the action.

  // ── Intelligence (local git, forge-agnostic) ──────────────────────────────

  getConflictPreview(cwd: string, prNumber: number): Promise<PrConflictPreview> {
    return ghPrConflictPreview(cwd, prNumber);
  }

  getHotspots(cwd: string, paths: string[]): Promise<PrHotspot[]> {
    return ghPrHotspots(cwd, paths);
  }

  /** No cheap Gitea source for per-file review history. Empty beats invented. */
  async getFileHistory(
    _cwd: string,
    _paths: string[],
  ): Promise<Record<string, PrFileHistory>> {
    return {};
  }
}

export const giteaProvider = new GiteaProvider();
```

In `useForge.ts`, add the pre-warm import next to the others:

```ts
import("./GiteaProvider").then((m) => _cache.set("gitea", m.giteaProvider));
```

In `forge/index.ts`, add the barrel export:

```ts
export { GiteaProvider, giteaProvider } from "./GiteaProvider";
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/desktop && pnpm vitest run src/composables/forge/__tests__/GiteaProvider.test.ts`
Expected: PASS, 9 tests.

Run: `cd apps/desktop && pnpm build`
Expected: `vue-tsc` fails on any `Record<ForgeName, string>` that now misses a `gitea` key. Task 8 fills them; if the build is red only on those, proceed to Task 8 and commit both together.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/composables/forge/
git commit -m "feat(desktop): GiteaProvider and forge registry wiring"
```

---

### Task 8: Accounts UI, detection layer 2, URLs and i18n

**Files:**
- Modify: `apps/desktop/src/composables/useAccounts.ts`
- Modify: `apps/desktop/src/utils/backend.ts:2447` (`gitRemoteInfo`)
- Modify: `apps/desktop/src/components/SettingsAccountsTab.vue`
- Modify: `apps/desktop/src/composables/useCredentials.ts`
- Modify: `apps/desktop/src/utils/forgeUrls.ts`
- Modify: `apps/desktop/src/locales/{en,fr,es,pt-BR,zh-CN}.ts`
- Create: `apps/desktop/src/composables/__tests__/useAccounts-gitea.test.ts`

**Interfaces:**
- Consumes: `giteaValidateToken` (Task 6), `ForgeName` (Task 7).
- Produces: `giteaHosts(): string[]` on `useAccounts`, `saveGiteaCredential(host, username, token)` on `useCredentials`, and a `gitRemoteInfo` that rewrites `unknown` to `gitea` on an account-host match.

- [ ] **Step 1: Write the failing tests**

Create `apps/desktop/src/composables/__tests__/useAccounts-gitea.test.ts`:

```ts
/**
 * Detection layer 2: a self-hosted Gitea on a neutral hostname is recognised
 * because the user configured an account for that host, not because the URL
 * says so.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { useAccounts } from "../useAccounts";
import { giteaProviderHostMatches } from "../../utils/backend";

describe("Gitea account hosts", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("exposes the hosts of configured Gitea accounts", () => {
    const { addAccount, giteaHosts } = useAccounts();
    addAccount({
      forge: "gitea",
      label: "work",
      username: "alice",
      tokenKey: "gitwand:gitea/git.acme.io:alice",
    });
    expect(giteaHosts()).toEqual(["git.acme.io"]);
  });

  it("matches a remote host against the configured hosts", () => {
    expect(giteaProviderHostMatches("https://git.acme.io/acme/app.git", ["git.acme.io"])).toBe(true);
    expect(giteaProviderHostMatches("git@git.acme.io:acme/app.git", ["git.acme.io"])).toBe(true);
    expect(giteaProviderHostMatches("https://git.other.io/acme/app.git", ["git.acme.io"])).toBe(false);
    expect(giteaProviderHostMatches("https://git.acme.io/acme/app.git", [])).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/desktop && pnpm vitest run src/composables/__tests__/useAccounts-gitea.test.ts`
Expected: FAIL, `giteaHosts is not a function`.

- [ ] **Step 3: Implement**

In `useAccounts.ts`, add inside the returned object:

```ts
  /**
   * Hosts of every configured Gitea account, parsed out of `tokenKey`
   * (`"gitwand:gitea/<host>:<username>"`). Feeds detection layer 2 in
   * `gitRemoteInfo`.
   */
  function giteaHosts(): string[] {
    return accounts.value
      .filter((a) => a.forge === "gitea")
      .map((a) => a.tokenKey.split("/")[1]?.split(":")[0] ?? "")
      .filter((h) => h.length > 0);
  }
```

and export `giteaHosts` from `useAccounts()`.

In `backend.ts`, add the matcher and apply it in `gitRemoteInfo`:

```ts
/**
 * Whether `remoteUrl`'s host is one of `hosts`.
 *
 * Detection layer 2 for Gitea: a self-hosted instance on a neutral hostname is
 * unrecognisable from the URL alone, so the configured accounts are the
 * evidence. Exported for its unit test.
 */
export function giteaProviderHostMatches(remoteUrl: string, hosts: string[]): boolean {
  if (hosts.length === 0) return false;
  const host = remoteUrl.startsWith("git@")
    ? remoteUrl.slice(4).split(":")[0]
    : remoteUrl.split("://")[1]?.split("/")[0]?.split("@").pop()?.split(":")[0] ?? "";
  return host.length > 0 && hosts.includes(host);
}
```

Then, in `gitRemoteInfo`, wrap both return paths through one resolver so the Tauri and dev:web branches behave identically:

```ts
function applyGiteaAccountOverride(info: RemoteInfo): RemoteInfo {
  if (info.provider !== "unknown" || !info.url) return info;
  // Imported lazily: useAccounts touches localStorage, which must not be a
  // module-load side effect of backend.ts.
  const { useAccounts } = require("../composables/useAccounts") as typeof import("../composables/useAccounts");
  const hosts = useAccounts().giteaHosts();
  return giteaProviderHostMatches(info.url, hosts) ? { ...info, provider: "gitea" } : info;
}
```

If `require` is not available in this module (it is an ESM build), use a top-level `import { useAccounts } from "../composables/useAccounts";` instead and verify `pnpm build` stays clean; the composable's module body only defines refs, so a static import is safe. Prefer the static import and delete the comment if so.

Apply it at both `return` sites in `gitRemoteInfo`:

```ts
    return applyGiteaAccountOverride(await tauriInvoke<RemoteInfo>("git_remote_info", { cwd }));
```

and

```ts
    return applyGiteaAccountOverride((await res.json()) as RemoteInfo);
```

In `useCredentials.ts`, next to `saveBitbucketCredential`:

```ts
  const GITEA_SERVICE = "gitwand:gitea";

  /**
   * Store a Gitea token plus the host pointer the Rust side reads.
   *
   * Two entries: `<host>` holds the active username, `<host>:<username>` holds
   * the token. Rust knows the host from the remote but not the username, so the
   * pointer is what makes a keychain lookup possible.
   */
  async function saveGiteaCredential(
    host: string,
    username: string,
    token: string,
  ): Promise<boolean> {
    const ok = await saveCredential(GITEA_SERVICE, `${host}:${username}`, token);
    if (!ok) return false;
    return saveCredential(GITEA_SERVICE, host, username);
  }
```

Export it from `useCredentials()`.

In `SettingsAccountsTab.vue`:

```ts
// script setup additions
const formServerUrl = ref("");

function giteaHostFromUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  const withScheme = /^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    return new URL(withScheme).host;
  } catch {
    return "";
  }
}
```

In `submitForm`, before the `addAccount` call:

```ts
  if (formForge.value === "gitea") {
    const host = giteaHostFromUrl(formServerUrl.value);
    if (!host) { formError.value = t('settings.accountsGiteaUrlInvalid'); return; }
    if (!formToken.value.trim()) { formError.value = t('settings.accountsGiteaTokenRequired'); return; }
    let login = "";
    try {
      login = await giteaValidateToken(host, formToken.value.trim());
    } catch (e) {
      formError.value = e instanceof Error ? e.message : String(e);
      return;
    }
    const username = formUsername.value.trim() || login;
    const ok = await saveGiteaCredential(host, username, formToken.value.trim());
    if (!ok) { formError.value = credError.value ?? "Failed to save credential."; return; }
    tokenKey = `gitwand:gitea/${host}:${username}`;
    formUsername.value = username;
  }
```

Template additions, after the Bitbucket `<template>` block:

```html
        <template v-else-if="formForge === 'gitea'">
          <div class="sa-field">
            <label class="sa-label">{{ t('settings.accountsGiteaUrlLabel') }}</label>
            <input v-model="formServerUrl" type="text" class="sa-input" placeholder="https://git.acme.io" />
          </div>
          <div class="sa-field">
            <label class="sa-label">{{ t('settings.accountsGiteaTokenLabel') }}</label>
            <input v-model="formToken" type="password" class="sa-input" autocomplete="new-password" />
            <p class="sa-note">{{ t('settings.accountsGiteaTokenHint') }}</p>
          </div>
        </template>
```

Add the `<option value="gitea">Gitea / Forgejo</option>` to the forge select, add `"gitea"` to `forgeOrder`, and add `gitea: "Gitea / Forgejo"` to the `forgeLabel` record.

In `forgeUrls.ts`, add a `gitea` case to `forgeCommitUrl` before the `default`:

```ts
    case "gitea": {
      // Self-hosted: the host must come from the remote, never a constant.
      const host = url.startsWith("git@")
        ? url.slice(4).split(":")[0]
        : url.split("://")[1]?.split("/")[0] ?? "";
      if (!host) return null;
      return `https://${host}/${owner}/${repo}/commit/${sha}`;
    }
```

i18n, in all five locale files. English values, with the other four translated:

```ts
    accountsGiteaUrlLabel: "Server URL",
    accountsGiteaTokenLabel: "Access token",
    accountsGiteaTokenHint: "Gitea: Settings > Applications > Generate Token. Scopes: repository and issue read and write.",
    accountsGiteaUrlInvalid: "Enter a valid server URL, for example https://git.acme.io",
    accountsGiteaTokenRequired: "An access token is required.",
```

French: `"URL du serveur"`, `"Jeton d'accès"`, `"Gitea : Paramètres > Applications > Générer un jeton. Portées : lecture et écriture sur les dépôts et les tickets."`, `"Saisissez une URL de serveur valide, par exemple https://git.acme.io"`, `"Un jeton d'accès est requis."`

Spanish: `"URL del servidor"`, `"Token de acceso"`, `"Gitea: Configuración > Aplicaciones > Generar token. Permisos: lectura y escritura de repositorios e incidencias."`, `"Introduce una URL de servidor válida, por ejemplo https://git.acme.io"`, `"Se requiere un token de acceso."`

Portuguese (Brazil): `"URL do servidor"`, `"Token de acesso"`, `"Gitea: Configurações > Aplicativos > Gerar token. Escopos: leitura e escrita de repositórios e issues."`, `"Informe uma URL de servidor válida, por exemplo https://git.acme.io"`, `"Um token de acesso é obrigatório."`

Chinese (Simplified): `"服务器地址"`, `"访问令牌"`, `"Gitea：设置 > 应用 > 生成令牌。权限：仓库和工单的读写。"`, `"请输入有效的服务器地址，例如 https://git.acme.io"`, `"需要访问令牌。"`

Also add `gitea: "Gitea / Forgejo"` to the `forgeConnect` block in all five locales (`en.ts:1860` and its counterparts).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/desktop && pnpm vitest run src/composables/__tests__/useAccounts-gitea.test.ts`
Expected: PASS, 2 tests.

Run: `cd apps/desktop && pnpm test`
Expected: PASS, whole suite.

Run: `cd apps/desktop && pnpm build`
Expected: clean, every `Record<ForgeName, …>` now exhaustive.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/composables/ apps/desktop/src/components/SettingsAccountsTab.vue apps/desktop/src/utils/ apps/desktop/src/locales/
git commit -m "feat(desktop): Gitea accounts, account-host detection, URLs and locales"
```

---

### Task 9: Manual QA against a real server

**Files:** none. This task produces a verified behaviour report, not a diff. Do not skip it: it is where the two version-dependent unknowns from the spec get settled.

- [ ] **Step 1: Get a server**

Either a real Gitea the user already runs, or a throwaway:

```bash
docker run -d --name gitwand-gitea -p 3000:3000 gitea/gitea:latest
```

Complete the web installer at `http://localhost:3000`, create a user, create a repo with one branch and one open PR, and generate a token at Settings > Applications.

- [ ] **Step 2: Drive it in dev:web**

```bash
cd apps/desktop
export GITWAND_GITEA_TOKEN=<the token>
pnpm dev:web
```

Open a clone of the Gitea repo in the app. Confirm: the PR tab lists the PR, the detail loads, the diff renders, CI status appears (empty is a valid answer on a fresh server), and the comments load.

- [ ] **Step 3: Drive the write paths in the packaged app**

```bash
cd apps/desktop && pnpm dev
```

Add the account in Settings > Accounts (server URL, username, token) and confirm validation rejects a wrong token with a readable message. Then: create a PR, comment on it, convert a draft to ready, merge it, and check out a PR branch.

- [ ] **Step 4: Record what the server actually answered**

Write down which merge field the server accepted (`merge_method` or `Do`) and whether `.diff` answered without the `/patch` fallback. If the fallbacks never fire on a current Gitea, keep them anyway and note in `gitea.rs` which version was tested.

- [ ] **Step 5: Commit any fix the QA turned up**

```bash
git add -A
git commit -m "fix(desktop): Gitea behaviour corrections from manual QA"
```

If QA turned up nothing, skip the commit and say so in the PR description.

---

### Task 10: Roadmap, changelog, and the PR

**Files:**
- Modify: `roadmap.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/superpowers/specs/2026-09-15-gitea-support-design.md` (only if QA changed a documented decision)

- [ ] **Step 1: Add the lot to the roadmap**

In `roadmap.md`, under `### v3.11.0`, in the "Remaining before the tag" list, add a fourth bullet:

```markdown
- **Gitea / Forgejo support** (issue #193): account sign-in with a personal access token, remote detection from the configured server host, and the PR/Today surface: list, detail, diff, CI status, comments, read-only reviews, create, merge, checkout, draft to ready. Design: `docs/superpowers/specs/2026-09-15-gitea-support-design.md`
```

In `### Later (unscheduled)`, add:

```markdown
- **Gitea follow-ups** (deferred from the v3.11.0 Gitea lot): forge-side auto-merge via the merge endpoint's `merge_when_checks_succeed`, submitting and dismissing reviews, check annotations, per-file review history, and cross-fork PR creation. None of them blocks the sign-in flow issue #193 asked for.
```

- [ ] **Step 2: Add the changelog entry**

Under `## [Unreleased]`, in an `### Added` block:

```markdown
- **Gitea and Forgejo support** (#193): sign in with a personal access token in Settings > Accounts, and get the PR tab and Today on any self-hosted Gitea or Forgejo server. Remote detection resolves the server from the configured account, so an instance on a neutral hostname is recognised. Auto-merge and review submission are not covered in this first pass.
```

- [ ] **Step 3: Run everything one last time**

```bash
cd apps/desktop/src-tauri && cargo test
cd apps/desktop && pnpm test && pnpm test:parity && pnpm build
```

Expected: all green. Paste the actual output into the PR description rather than asserting it passed.

- [ ] **Step 4: Commit and open the PR**

```bash
git add roadmap.md CHANGELOG.md docs/
git commit -m "docs: record the Gitea lot in the roadmap and changelog"
git push -u origin feat/193-gitea-support
gh pr create --title "feat(desktop): Gitea and Forgejo support (#193)" --body "<see below>"
```

PR body must state: what works, what throws `ForgeNotImplementedError` and why, which Gitea version the manual QA ran against, which merge field and diff path that server accepted, and the fact that the dev-server routes authenticate from `GITWAND_GITEA_TOKEN` rather than the keychain. Close with `Closes #193`.

- [ ] **Step 5: Check the main CI run after merge**

The bundle smoke build is skipped on PRs, so a green PR is not a green `main`. This change touches `src-tauri`, so watch the post-merge run.

```bash
gh run list --branch main --limit 3
```

---

## Self-Review

**Spec coverage.** Section 3.1 transport, Task 1. Section 3.2 detection, Tasks 2 and 8. Section 3.3 Forgejo, Tasks 2, 7 and 8. Section 3.4 dev:web routes, Task 6. Section 4 file map, all tasks. Section 5 auth and accounts, Tasks 1 and 8. Section 6 detection, Tasks 2 and 8. Section 7 command surface, Tasks 1, 3, 4 and 5. Section 7.1 version unknowns, Tasks 5 and 9. Section 8 data mapping, Tasks 3 and 4. Section 9 testing, every task plus Task 9. Section 10 risks, Tasks 6 and 9. Section 11 bookkeeping, Task 10.

**One addition to the spec:** `gitea_validate_token` is a 21st command, not in the spec's section 7 tables. It exists because the account form validates before the credential is stored, which section 5 requires. Add it to the spec's Discovery table when this plan is committed.

**Type consistency.** `GiteaCtx` fields (`base`, `owner`, `repo`, `auth`) are used identically in Tasks 1, 3, 4 and 5. `map_pr` / `map_pr_detail` / `map_status` / `map_comment` / `map_review` / `map_issue` are defined once and referenced by the exact same names. Every `gitea_*` command name in the Rust tasks matches the string passed to `tauriInvoke` in Task 6, and every wrapper name in Task 6 matches the imports in Task 7. Rust commands take `index` for the PR number and the wrappers pass `index`; the `ForgeProvider` interface calls it `number` or `prNumber`, and the provider is where that rename happens.

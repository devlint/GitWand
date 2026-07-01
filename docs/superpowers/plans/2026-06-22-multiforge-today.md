# Multi-forge "Today" Aggregation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make GitWand's "Today" view aggregate open PRs/MRs across GitHub, GitLab, Bitbucket and Azure, and open Issues across GitHub, GitLab and Bitbucket — by dispatching per repo through the existing `ForgeProvider` abstraction instead of the GitHub-only Rust aggregator.

**Architecture:** Approach B (frontend aggregation over `ForgeProvider`). The two Today composables (`useLaunchpadPrs`, `useLaunchpadIssues`) resolve a provider per repo via `useForge(cwd)` and call `provider.listPRs()` / a new `provider.listIssues()`, aggregating with `Promise.all` into the existing per-repo container shapes (`WorkspaceRepoPrs[]` / `WorkspaceRepoIssues[]`). Three new per-repo issue-list backend commands back the GitHub/GitLab/Bitbucket providers. Forges the user has not connected are surfaced as a discreet "connect" banner, never a red error.

**Tech Stack:** Tauri 2 + Rust (backend commands), Vue 3 `<script setup>` + TypeScript (composables/UI), Vitest (jsdom) for frontend tests, `keyring`/`curl`/`glab`/`gh` for forge auth (existing patterns).

## Global Constraints

- **Package manager:** pnpm only (never npm/yarn).
- **IPC rule:** every new `#[tauri::command]` gets a typed wrapper in `apps/desktop/src/utils/backend.ts` (or `backend-pr.ts`) AND a `dev-server.mjs` mock route, in the same task. Never call `invoke()` from components/composables.
- **`packages/core` = zero Node.js** — not touched by this plan.
- **i18n:** every user-visible string has a key in all 5 locales: `en.ts`, `fr.ts`, `es.ts`, `pt-BR.ts`, `zh-CN.ts`. `en.ts` is the canonical shape; others are `Locale`-typed and fail to compile if a key is missing.
- **Diff-parsing gotcha:** N/A here (no diff parsing).
- **Tests use real temp git repos** (no mocking the git layer) for backend tests; frontend composable tests mock the `backend.ts`/provider layer.
- **Version files:** do not hand-edit; not bumped in this plan.
- **Issue type (camelCase end-to-end):** Rust `Issue` struct uses `#[serde(rename_all = "camelCase")]`; the TS `Issue` interface (`backend.ts:2460`) is already camelCase — issue-list wrappers need **no snake→camel mapping** (unlike `ghListPrs`).
- **Filter set:** Today's issue filters are `"" | "assigned" | "mentioned" | "created"`. A forge that can't express a filter falls back to all-open for that repo (never an error).

---

## File Structure

**Created:**
- (none — all changes extend existing files)

**Modified — Backend (Rust):**
- `apps/desktop/src-tauri/src/commands/gh.rs` — add `gh_list_issues` command (+ inner).
- `apps/desktop/src-tauri/src/commands/gitlab.rs` — add `gl_list_issues` command + `gl_issue_to_issue` mapper.
- `apps/desktop/src-tauri/src/commands/bitbucket.rs` — add `bb_list_issues` command + `bb_issue_to_issue` mapper.
- `apps/desktop/src-tauri/src/lib.rs` — register the three commands.

**Modified — Frontend (TS/Vue):**
- `apps/desktop/src/utils/backend.ts` — add `ghListIssues`, `glListIssues`, `bbListIssues` wrappers.
- `apps/desktop/dev-server.mjs` — add 3 mock routes.
- `apps/desktop/src/composables/forge/types.ts` — add `ListIssuesOptions` + optional `listIssues?` to `ForgeProvider`.
- `apps/desktop/src/composables/forge/GitHubProvider.ts` / `GitLabProvider.ts` / `BitbucketProvider.ts` — implement `listIssues`.
- `apps/desktop/src/composables/forge/useForge.ts` — add `isForgeConnected(forge)` + `forgeForRepo(cwd)` helpers.
- `apps/desktop/src/composables/useLaunchpadPrs.ts` — per-repo provider dispatch + connection gating.
- `apps/desktop/src/composables/useLaunchpadIssues.ts` — per-repo provider dispatch + connection gating.
- `apps/desktop/src/components/LaunchpadView.vue` — not-connected banner.
- `apps/desktop/src/locales/{en,fr,es,pt-BR,zh-CN}.ts` — `forgeConnect` key group.

**Modified — Tests:**
- `apps/desktop/src/composables/__tests__/useLaunchpadPrs.test.ts`
- `apps/desktop/src/composables/__tests__/useLaunchpadIssues.test.ts`

**Connection-gating rule (used by Tasks 7–9):** a forge is "connected" when `hasAccounts(forge)` is true, **except `github`**, which is always attempted (it resolves via gh CLI / ambient token / OAuth keychain downstream, and the #73 fix already makes the OAuth path work without `gh`). Non-GitHub repos on a not-connected forge are not fetched; they feed the "connect" banner.

---

## Task 1: Backend — `gh_list_issues` command

**Files:**
- Modify: `apps/desktop/src-tauri/src/commands/gh.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs` (register)

**Interfaces:**
- Consumes: `github_api::settings_github_token()`, `github_api::rest_list_issues(cwd, filter, me, limit, token) -> Result<Vec<Issue>, String>` (added for #73), `github_api::rest_current_user(token)`, `crate::git::hidden_cmd`, `crate::git::parse::parse_gh_issue_json`.
- Produces: `gh_list_issues(cwd: String, filter: String, limit: Option<i64>) -> Result<Vec<Issue>, String>`.

- [ ] **Step 1: Write the failing parse test**

Add to `apps/desktop/src-tauri/src/commands/gh.rs` (in its `#[cfg(test)] mod tests`, or create one):

```rust
#[cfg(test)]
mod gh_list_issues_tests {
    use crate::git::parse::parse_gh_issue_json;

    #[test]
    fn parses_gh_issue_list_json_into_issues() {
        let json = r#"[
            {"number":7,"title":"Bug","state":"OPEN",
             "author":{"login":"alice"},
             "assignees":[{"login":"bob"}],
             "labels":[{"name":"bug"}],
             "url":"https://github.com/o/r/issues/7",
             "createdAt":"2026-01-01T00:00:00Z",
             "updatedAt":"2026-01-02T00:00:00Z",
             "milestone":{"title":"v1"}}
        ]"#;
        let issues = parse_gh_issue_json(json).expect("parses");
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].number, 7);
        assert_eq!(issues[0].author, "alice");
        assert_eq!(issues[0].assignees, vec!["bob".to_string()]);
        assert_eq!(issues[0].milestone, "v1");
    }
}
```

- [ ] **Step 2: Run it to verify it fails to compile/find the symbol**

Run: `cd apps/desktop/src-tauri && cargo test gh_list_issues_tests 2>&1 | tail -20`
Expected: PASS if `parse_gh_issue_json` is already `pub(crate)` (it is, per `git/parse.rs:474`). If it fails to resolve, make `parse_gh_issue_json` `pub(crate)`. This test guards the mapper contract the command relies on.

- [ ] **Step 3: Add the `gh_list_issues` command**

In `apps/desktop/src-tauri/src/commands/gh.rs`, mirror `gh_list_prs_inner`/`gh_list_prs`. Add near the other issue commands:

```rust
fn gh_list_issues_inner(
    cwd: String,
    filter: String,
    limit: Option<i64>,
) -> Result<Vec<crate::types::Issue>, String> {
    let lim = limit.unwrap_or(100).max(1);

    // Settings-managed OAuth token present → tokenless REST path (no `gh`).
    if let Some(tok) = github_api::settings_github_token() {
        let me = match filter.as_str() {
            "assigned" | "created" | "mentioned" => {
                github_api::rest_current_user(&tok).unwrap_or_default()
            }
            _ => String::new(),
        };
        return github_api::rest_list_issues(&cwd, &filter, &me, lim, &tok);
    }

    // Fallback: shell `gh issue list` (mirrors workspace_issues_all gh path).
    let mut cmd = hidden_cmd("gh");
    cmd.args([
        "issue", "list",
        "--state", "open",
        "--json", "number,title,state,author,assignees,labels,url,createdAt,updatedAt,milestone",
        "--limit", &lim.to_string(),
    ]);
    match filter.as_str() {
        "assigned" => { cmd.args(["--assignee", "@me"]); }
        "created" => { cmd.args(["--author", "@me"]); }
        "mentioned" => { cmd.args(["--search", "mentions:@me"]); }
        _ => {}
    }
    let output = cmd
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("gh not available: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("gh issue list failed: {}", stderr.trim()));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    crate::git::parse::parse_gh_issue_json(&stdout)
}

#[tauri::command]
pub(crate) async fn gh_list_issues(
    cwd: String,
    filter: String,
    limit: Option<i64>,
) -> Result<Vec<crate::types::Issue>, String> {
    tauri::async_runtime::spawn_blocking(move || gh_list_issues_inner(cwd, filter, limit))
        .await
        .map_err(|e| e.to_string())?
}
```

(If `gh.rs` already imports `Issue`/`hidden_cmd`/`github_api`, use the short paths; otherwise the fully-qualified paths above compile as-is.)

- [ ] **Step 4: Register the command in `lib.rs`**

In `apps/desktop/src-tauri/src/lib.rs`, in the `tauri::generate_handler![...]` block, after `commands::gh::gh_issue_set_state,` add:

```rust
            commands::gh::gh_list_issues,
```

- [ ] **Step 5: Compile**

Run: `cd apps/desktop/src-tauri && cargo build 2>&1 | tail -20`
Expected: `Finished` with no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src-tauri/src/commands/gh.rs apps/desktop/src-tauri/src/lib.rs
git commit -m "feat(today): gh_list_issues per-repo command (REST + gh fallback)"
```

---

## Task 2: Backend — `gl_list_issues` command (GitLab)

**Files:**
- Modify: `apps/desktop/src-tauri/src/commands/gitlab.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs` (register)

**Interfaces:**
- Consumes: `hidden_cmd("glab")`, the module's JSON helpers `js`, `ji`, `juser`, `jusernames`, `jlabels` (see `gl_mr_to_pr`).
- Produces: `gl_list_issues(cwd: String, filter: String, limit: Option<i64>) -> Result<Vec<Issue>, String>`, `gl_issue_to_issue(&serde_json::Value) -> Issue`.

GitLab `glab` exposes issues via `glab issue list --output json`. The list payload fields: `iid`, `title`, `state` (`opened`/`closed`), `author.username`, `assignees[].username`, `labels[]` (array of strings), `web_url`, `created_at`, `updated_at`, `milestone.title`.

- [ ] **Step 1: Write the failing mapper test**

Add to `gitlab.rs` test module:

```rust
#[cfg(test)]
mod gl_list_issues_tests {
    use super::gl_issue_to_issue;

    #[test]
    fn maps_gitlab_issue_json_to_issue() {
        let v: serde_json::Value = serde_json::from_str(r#"{
            "iid": 12, "title": "Crash", "state": "opened",
            "author": {"username": "alice"},
            "assignees": [{"username": "bob"}],
            "labels": ["bug","p1"],
            "web_url": "https://gitlab.com/o/r/-/issues/12",
            "created_at": "2026-01-01T00:00:00Z",
            "updated_at": "2026-01-02T00:00:00Z",
            "milestone": {"title": "M1"}
        }"#).unwrap();
        let i = gl_issue_to_issue(&v);
        assert_eq!(i.number, 12);
        assert_eq!(i.state, "open");
        assert_eq!(i.author, "alice");
        assert_eq!(i.assignees, vec!["bob".to_string()]);
        assert_eq!(i.labels, vec!["bug".to_string(), "p1".to_string()]);
        assert_eq!(i.milestone, "M1");
        assert_eq!(i.url, "https://gitlab.com/o/r/-/issues/12");
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/desktop/src-tauri && cargo test gl_list_issues_tests 2>&1 | tail -20`
Expected: FAIL — `cannot find function gl_issue_to_issue`.

- [ ] **Step 3: Add the mapper + command**

In `gitlab.rs`. The `gl_state` helper already maps `opened`→`open`; reuse it. GitLab labels in the list payload are plain strings, so map directly (do not use `jlabels`, which expects objects — verify and use whichever matches; the list endpoint returns string labels).

```rust
fn gl_issue_to_issue(v: &serde_json::Value) -> crate::types::Issue {
    let labels = v
        .get("labels")
        .and_then(|l| l.as_array())
        .map(|arr| arr.iter().filter_map(|x| x.as_str().map(String::from)).collect())
        .unwrap_or_default();
    let milestone = v.get("milestone").map(|m| js(m, "title")).unwrap_or_default();
    crate::types::Issue {
        number: ji(v, "iid"),
        title: js(v, "title"),
        state: gl_state(&js(v, "state")),
        author: juser(v, "author"),
        assignees: jusernames(v, "assignees"),
        labels,
        url: js(v, "web_url"),
        created_at: js(v, "created_at"),
        updated_at: js(v, "updated_at"),
        milestone,
    }
}

#[tauri::command]
pub(crate) async fn gl_list_issues(
    cwd: String,
    filter: String,
    limit: Option<i64>,
) -> Result<Vec<crate::types::Issue>, String> {
    let lim = limit.unwrap_or(100).max(1).to_string();
    let mut args: Vec<String> = vec![
        "issue".into(), "list".into(),
        "--state".into(), "opened".into(),
        "--per-page".into(), lim,
        "--output".into(), "json".into(),
    ];
    // glab filter flags: --assignee / --author accept usernames or "@me".
    match filter.as_str() {
        "assigned" => { args.push("--assignee".into()); args.push("@me".into()); }
        "created"  => { args.push("--author".into());   args.push("@me".into()); }
        // "mentioned" has no native glab flag → fall back to all-open.
        _ => {}
    }
    let output = hidden_cmd("glab")
        .args(&args)
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("glab not available: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("glab issue list failed: {}", stderr.trim()));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let raw: serde_json::Value = serde_json::from_str(stdout.trim())
        .map_err(|e| format!("Failed to parse glab issue list output: {}", e))?;
    let arr = raw.as_array().cloned().unwrap_or_default();
    Ok(arr.iter().map(gl_issue_to_issue).collect())
}
```

- [ ] **Step 4: Run the mapper test to verify it passes**

Run: `cd apps/desktop/src-tauri && cargo test gl_list_issues_tests 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 5: Register in `lib.rs`**

After `commands::gitlab::gl_list_mrs,` add:

```rust
            commands::gitlab::gl_list_issues,
```

- [ ] **Step 6: Compile + commit**

```bash
cd apps/desktop/src-tauri && cargo build 2>&1 | tail -5
cd ../../.. && git add apps/desktop/src-tauri/src/commands/gitlab.rs apps/desktop/src-tauri/src/lib.rs
git commit -m "feat(today): gl_list_issues per-repo command (glab issue list)"
```

---

## Task 3: Backend — `bb_list_issues` command (Bitbucket)

**Files:**
- Modify: `apps/desktop/src-tauri/src/commands/bitbucket.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs` (register)

**Interfaces:**
- Consumes: `parse_workspace_slug(cwd)`, `get_bb_creds(cwd)`, `basic_auth_config(user, pass)`, `bb_curl(method, url, body, auth)`, `repo_api(ws, slug)`, helpers `js`/`ji`/`jnested`, `bb_current_user`.
- Produces: `bb_list_issues(cwd: String, filter: String, limit: Option<i64>) -> Result<Vec<Issue>, String>`, `bb_issue_to_issue(&serde_json::Value) -> Issue`.

Bitbucket issues: `GET /repositories/{ws}/{slug}/issues?q=state="new" OR state="open"&pagelen=N`. Fields: `id`, `title`, `state` (`new`/`open`/`resolved`/...), `reporter.nickname`, `assignee.nickname`, `content`, `links.html.href`, `created_on`, `updated_on`. Bitbucket issues have **no labels/milestone array** in the same shape — map `labels: []` and `milestone: ""`. The issue tracker is opt-in: a 404 ⇒ empty list.

- [ ] **Step 1: Write the failing mapper test**

Add to `bitbucket.rs` test module:

```rust
#[cfg(test)]
mod bb_list_issues_tests {
    use super::bb_issue_to_issue;

    #[test]
    fn maps_bitbucket_issue_json_to_issue() {
        let v: serde_json::Value = serde_json::from_str(r#"{
            "id": 5, "title": "Broken", "state": "new",
            "reporter": {"nickname": "alice"},
            "assignee": {"nickname": "bob"},
            "created_on": "2026-01-01T00:00:00Z",
            "updated_on": "2026-01-02T00:00:00Z",
            "links": {"html": {"href": "https://bitbucket.org/o/r/issues/5"}}
        }"#).unwrap();
        let i = bb_issue_to_issue(&v);
        assert_eq!(i.number, 5);
        assert_eq!(i.state, "new");
        assert_eq!(i.author, "alice");
        assert_eq!(i.assignees, vec!["bob".to_string()]);
        assert_eq!(i.url, "https://bitbucket.org/o/r/issues/5");
        assert!(i.labels.is_empty());
        assert_eq!(i.milestone, "");
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/desktop/src-tauri && cargo test bb_list_issues_tests 2>&1 | tail -20`
Expected: FAIL — `cannot find function bb_issue_to_issue`.

- [ ] **Step 3: Add the mapper + command**

```rust
fn bb_issue_to_issue(v: &serde_json::Value) -> crate::types::Issue {
    let assignee = jnested(v, "assignee", "nickname");
    let assignees = if assignee.is_empty() { vec![] } else { vec![assignee] };
    crate::types::Issue {
        number: ji(v, "id"),
        title: js(v, "title"),
        state: js(v, "state"),
        author: jnested(v, "reporter", "nickname"),
        assignees,
        labels: vec![],
        url: jnested(v, "links", "html"), // see note: html is an object {href}
        created_at: js(v, "created_on"),
        updated_at: js(v, "updated_on"),
        milestone: String::new(),
    }
}
```

NOTE on the URL: `links.html` is `{ "href": ... }`. If `jnested(v, "links", "html")` returns the object rather than the string, extract `href` explicitly:

```rust
let url = v.get("links")
    .and_then(|l| l.get("html"))
    .and_then(|h| h.get("href"))
    .and_then(|s| s.as_str())
    .unwrap_or("")
    .to_string();
```

Use this explicit form in the mapper (replace the `url:` line accordingly) so the test's `links.html.href` assertion passes.

Then the command:

```rust
#[tauri::command]
pub(crate) async fn bb_list_issues(
    cwd: String,
    filter: String,
    limit: Option<i64>,
) -> Result<Vec<crate::types::Issue>, String> {
    let (workspace, slug) = parse_workspace_slug(&cwd)?;
    let (username, app_password) = get_bb_creds(&cwd)?;
    let auth_config = basic_auth_config(&username, &app_password);
    let pagelen = limit.unwrap_or(100).max(1);

    // Open Bitbucket issue states are "new" and "open".
    let mut url = format!(
        "{}/issues?q=(state=\"new\" OR state=\"open\")&pagelen={}&sort=-updated_on",
        repo_api(&workspace, &slug), pagelen
    );
    // Resolve "me" once for assigned/created filters.
    let me = match filter.as_str() {
        "assigned" | "created" => bb_current_user(cwd.clone()).await.unwrap_or_default(),
        _ => String::new(),
    };
    if !me.is_empty() {
        match filter.as_str() {
            "assigned" => url = format!("{} AND assignee.nickname=\"{}\"", url, me),
            "created"  => url = format!("{} AND reporter.nickname=\"{}\"", url, me),
            _ => {}
        }
    }

    let resp = match bb_curl("GET", &url, None, &auth_config) {
        Ok(v) => v,
        // Issue tracker disabled for this repo ⇒ treat as empty, not an error.
        Err(e) if e.contains("404") || e.to_lowercase().contains("not found") => {
            return Ok(vec![]);
        }
        Err(e) => return Err(e),
    };
    let values = resp.get("values").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    Ok(values.iter().map(bb_issue_to_issue).collect())
}
```

If `bb_curl` maps 404 to a message that does not contain "404"/"not found", adjust the guard to match the actual error text produced by `bb_curl` for a 404 (inspect `bb_curl`'s error formatting and match its exact substring).

- [ ] **Step 4: Run the mapper test to verify it passes**

Run: `cd apps/desktop/src-tauri && cargo test bb_list_issues_tests 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 5: Register in `lib.rs`**

After `commands::bitbucket::bb_list_prs,` add:

```rust
            commands::bitbucket::bb_list_issues,
```

- [ ] **Step 6: Compile + commit**

```bash
cd apps/desktop/src-tauri && cargo build 2>&1 | tail -5
cd ../../.. && git add apps/desktop/src-tauri/src/commands/bitbucket.rs apps/desktop/src-tauri/src/lib.rs
git commit -m "feat(today): bb_list_issues per-repo command (404 tracker-off => empty)"
```

---

## Task 4: IPC wrappers — `ghListIssues` / `glListIssues` / `bbListIssues`

**Files:**
- Modify: `apps/desktop/src/utils/backend.ts`

**Interfaces:**
- Consumes: `isTauri()`, `tauriInvoke<T>(cmd, args)`, `devFetch`, `DEV_SERVER`, the `Issue` interface (`backend.ts:2460`).
- Produces: `ghListIssues(cwd, filter, limit?)`, `glListIssues(cwd, filter, limit?)`, `bbListIssues(cwd, filter, limit?)`, each `Promise<Issue[]>`.

The `Issue` struct is camelCase end-to-end, so the Tauri branch is a direct cast (no mapping), mirroring `workspaceIssuesAll`.

- [ ] **Step 1: Add the three wrappers**

In `apps/desktop/src/utils/backend.ts`, just after `workspaceIssuesAll` (ends ~line 2687):

```typescript
// ─── Per-repo issue lists (multi-forge Today) ──────────────────────────────
// Issue is camelCase end-to-end (Rust #[serde(rename_all = "camelCase")]),
// so the Tauri branch is a direct cast — no snake→camel mapping (unlike PRs).

/** Open GitHub issues for one repo. `filter`: "" | "assigned" | "mentioned" | "created". */
export async function ghListIssues(cwd: string, filter: string, limit = 100): Promise<Issue[]> {
  if (isTauri()) {
    return tauriInvoke<Issue[]>("gh_list_issues", { cwd, filter, limit });
  }
  const res = await devFetch(
    `${DEV_SERVER}/api/gh-list-issues?cwd=${encodeURIComponent(cwd)}&filter=${encodeURIComponent(filter)}&limit=${limit}`,
  );
  if (!res.ok) throw new Error(`gh_list_issues failed: ${res.status}`);
  return res.json();
}

/** Open GitLab issues for one repo. */
export async function glListIssues(cwd: string, filter: string, limit = 100): Promise<Issue[]> {
  if (isTauri()) {
    return tauriInvoke<Issue[]>("gl_list_issues", { cwd, filter, limit });
  }
  const res = await devFetch(
    `${DEV_SERVER}/api/gl-list-issues?cwd=${encodeURIComponent(cwd)}&filter=${encodeURIComponent(filter)}&limit=${limit}`,
  );
  if (!res.ok) throw new Error(`gl_list_issues failed: ${res.status}`);
  return res.json();
}

/** Open Bitbucket issues for one repo (empty if the tracker is disabled). */
export async function bbListIssues(cwd: string, filter: string, limit = 100): Promise<Issue[]> {
  if (isTauri()) {
    return tauriInvoke<Issue[]>("bb_list_issues", { cwd, filter, limit });
  }
  const res = await devFetch(
    `${DEV_SERVER}/api/bb-list-issues?cwd=${encodeURIComponent(cwd)}&filter=${encodeURIComponent(filter)}&limit=${limit}`,
  );
  if (!res.ok) throw new Error(`bb_list_issues failed: ${res.status}`);
  return res.json();
}
```

- [ ] **Step 2: Type-check**

Run: `cd apps/desktop && pnpm exec vue-tsc --noEmit 2>&1 | tail -20`
Expected: no new errors referencing `backend.ts`.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/utils/backend.ts
git commit -m "feat(today): backend.ts wrappers for per-repo issue lists"
```

---

## Task 5: dev:web mock routes for the three issue commands

**Files:**
- Modify: `apps/desktop/dev-server.mjs`

**Interfaces:**
- Consumes: `jsonResponse(req, res, data, status?)`, `execSync`, `resolve`, route dispatch via `url.pathname` + `req.method`.
- Produces: 3 GET routes returning camelCase `Issue[]`.

Mirror the `/api/workspace-issues-all` handler (dev-server.mjs:4710) but per-repo and per-forge. GitHub uses real `gh` (matches existing mock behaviour); GitLab/Bitbucket return a small static mock array (no `glab`/curl in dev) so `pnpm dev:web` renders multi-forge Today without real creds.

- [ ] **Step 1: Add the GitHub issue route (real gh, mirrors existing)**

In `apps/desktop/dev-server.mjs`, near the other forge routes:

```javascript
    // GET /api/gh-list-issues?cwd=<path>&filter=<""|assigned|mentioned|created>&limit=<n>
    if (url.pathname === "/api/gh-list-issues" && req.method === "GET") {
      const cwd = url.searchParams.get("cwd");
      const filter = url.searchParams.get("filter") || "";
      const limit = url.searchParams.get("limit") || "100";
      if (!cwd) return jsonResponse(req, res, { error: "Missing cwd param" }, 400);
      try {
        let cmd = `gh issue list --state open --json number,title,state,author,assignees,labels,url,createdAt,updatedAt,milestone --limit ${parseInt(limit)}`;
        if (filter === "assigned") cmd += " --assignee @me";
        else if (filter === "created") cmd += " --author @me";
        else if (filter === "mentioned") cmd += " --search mentions:@me";
        const raw = execSync(cmd, { cwd: resolve(cwd), encoding: "utf-8" });
        const ghIssues = JSON.parse(raw || "[]");
        const issues = ghIssues.map((issue) => ({
          number: issue.number,
          title: issue.title ?? "",
          state: issue.state ?? "",
          author: issue.author?.login ?? "",
          assignees: (issue.assignees ?? []).map((a) => a.login).filter(Boolean),
          labels: (issue.labels ?? []).map((l) => l.name),
          url: issue.url ?? "",
          createdAt: issue.createdAt ?? "",
          updatedAt: issue.updatedAt ?? "",
          milestone: issue.milestone?.title ?? "",
        }));
        return jsonResponse(req, res, issues);
      } catch (err) {
        return jsonResponse(req, res, { error: err.stderr?.toString() || err.message }, 500);
      }
    }
```

- [ ] **Step 2: Add the GitLab + Bitbucket mock routes (static)**

```javascript
    // GET /api/gl-list-issues — dev mock (no glab in dev:web)
    if (url.pathname === "/api/gl-list-issues" && req.method === "GET") {
      return jsonResponse(req, res, [
        {
          number: 101, title: "[mock] GitLab issue", state: "open", author: "devuser",
          assignees: ["devuser"], labels: ["mock"], url: "https://gitlab.com/mock/repo/-/issues/101",
          createdAt: "2026-06-01T00:00:00Z", updatedAt: "2026-06-20T00:00:00Z", milestone: "",
        },
      ]);
    }

    // GET /api/bb-list-issues — dev mock (no curl creds in dev:web)
    if (url.pathname === "/api/bb-list-issues" && req.method === "GET") {
      return jsonResponse(req, res, [
        {
          number: 5, title: "[mock] Bitbucket issue", state: "new", author: "devuser",
          assignees: [], labels: [], url: "https://bitbucket.org/mock/repo/issues/5",
          createdAt: "2026-06-01T00:00:00Z", updatedAt: "2026-06-19T00:00:00Z", milestone: "",
        },
      ]);
    }
```

- [ ] **Step 3: Verify dev server boots**

Run: `cd apps/desktop && node -e "import('./dev-server.mjs').catch(e=>{console.error(e);process.exit(1)})" 2>&1 | tail -5` (or start it via the preview tooling and hit the routes). Expected: no syntax error on load.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/dev-server.mjs
git commit -m "feat(today): dev:web mock routes for per-repo issue lists"
```

---

## Task 6: `ForgeProvider.listIssues` + connection helpers

**Files:**
- Modify: `apps/desktop/src/composables/forge/types.ts`
- Modify: `apps/desktop/src/composables/forge/GitHubProvider.ts`
- Modify: `apps/desktop/src/composables/forge/GitLabProvider.ts`
- Modify: `apps/desktop/src/composables/forge/BitbucketProvider.ts`
- Modify: `apps/desktop/src/composables/forge/useForge.ts`

**Interfaces:**
- Consumes: `Issue` from `../../utils/backend`; `ghListIssues`/`glListIssues`/`bbListIssues` (Task 4); `useForge(cwd)`, `forgeFromRemoteInfo`, `useAccounts().hasAccounts`.
- Produces:
  - `ListIssuesOptions { filter?: "" | "assigned" | "mentioned" | "created"; limit?: number }`
  - `ForgeProvider.listIssues?(cwd, opts?): Promise<Issue[]>` (optional)
  - `isForgeConnected(forge: ForgeName): boolean`
  - `forgeForRepo(cwd: string): Promise<ForgeProvider>` (thin alias over `useForge`)

- [ ] **Step 1: Add the interface members**

In `apps/desktop/src/composables/forge/types.ts`, add the `Issue` import (alongside the existing `PullRequest` import from `../../utils/backend`), then add the options type near `ListPRsOptions` (line 50):

```typescript
export interface ListIssuesOptions {
  filter?: "" | "assigned" | "mentioned" | "created";
  limit?: number;
}
```

And inside the `ForgeProvider` interface, right after the `listPRs(...)` line (118):

```typescript
  /**
   * Open issues for the repo. Optional: forges without an issue concept
   * (Azure → Work Items) omit it; callers treat absence as "unsupported".
   */
  listIssues?(cwd: string, opts?: ListIssuesOptions): Promise<Issue[]>;
```

- [ ] **Step 2: Implement in GitHubProvider**

In `GitHubProvider.ts`: add `ghListIssues` to the backend import block, add `Issue` + `ListIssuesOptions` to type imports, and add the method right after `listPRs`:

```typescript
  listIssues(cwd: string, opts: ListIssuesOptions = {}): Promise<Issue[]> {
    return ghListIssues(cwd, opts.filter ?? "", opts.limit ?? 100);
  }
```

- [ ] **Step 3: Implement in GitLabProvider**

In `GitLabProvider.ts`: add `glListIssues` import + types, add after `listPRs`:

```typescript
  listIssues(cwd: string, opts: ListIssuesOptions = {}): Promise<Issue[]> {
    return glListIssues(cwd, opts.filter ?? "", opts.limit ?? 100);
  }
```

- [ ] **Step 4: Implement in BitbucketProvider**

In `BitbucketProvider.ts`: add `bbListIssues` import + types, add after `listPRs`:

```typescript
  listIssues(cwd: string, opts: ListIssuesOptions = {}): Promise<Issue[]> {
    return bbListIssues(cwd, opts.filter ?? "", opts.limit ?? 100);
  }
```

(AzureProvider is intentionally left without `listIssues`.)

- [ ] **Step 5: Add connection + repo-forge helpers in useForge.ts**

In `apps/desktop/src/composables/forge/useForge.ts`, add:

```typescript
import { useAccounts } from "../useAccounts";

/**
 * Whether Today should attempt to fetch from `forge`.
 * GitHub is always attempted (gh CLI / ambient token / OAuth keychain resolve
 * downstream). Other forges require an explicit in-app account.
 */
export function isForgeConnected(forge: ForgeName): boolean {
  if (forge === "github") return true;
  return useAccounts().hasAccounts(forge);
}

/** Resolve the ForgeProvider for a local repo (thin alias over useForge). */
export async function forgeForRepo(cwd: string): Promise<ForgeProvider> {
  return useForge(cwd);
}
```

Export both from the re-export block at the bottom if the file uses an explicit export list.

- [ ] **Step 6: Type-check**

Run: `cd apps/desktop && pnpm exec vue-tsc --noEmit 2>&1 | tail -20`
Expected: no new errors.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/composables/forge/
git commit -m "feat(today): ForgeProvider.listIssues + isForgeConnected/forgeForRepo helpers"
```

---

## Task 7: `useLaunchpadPrs` — per-repo provider dispatch + connection gating

**Files:**
- Modify: `apps/desktop/src/composables/useLaunchpadPrs.ts`
- Test: `apps/desktop/src/composables/__tests__/useLaunchpadPrs.test.ts`

**Interfaces:**
- Consumes: `forgeForRepo(cwd)`, `isForgeConnected(forge)` (Task 6); existing `WorkspaceRepo`, `WorkspaceRepoPrs`, `PullRequest` types.
- Produces: unchanged public surface `{ repos, allPrs, snoozedPrs, loading, error, refresh }` **plus** `needsConnection: Ref<ForgeName[]>` (forges with ≥1 repo but not connected).

The `repos` ref keeps the `WorkspaceRepoPrs[]` shape (so `allPrs`/`snoozedPrs`/per-repo error display are unchanged). `refresh` now builds it per repo via providers.

- [ ] **Step 1: Write the failing test**

Replace/extend `useLaunchpadPrs.test.ts`. Mock the forge layer:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

const listPRs = vi.fn();
vi.mock("../forge/useForge", () => ({
  forgeForRepo: vi.fn(async (cwd: string) => ({
    name: cwd.includes("gl") ? "gitlab" : cwd.includes("bb") ? "bitbucket" : "github",
    listPRs,
  })),
  isForgeConnected: vi.fn((forge: string) => forge !== "bitbucket"), // bb NOT connected
}));
vi.mock("../useLaunchpadPins", () => ({
  useLaunchpadPins: () => ({ isPinned: () => false, isSnoozed: () => false }),
}));

import { useLaunchpadPrs } from "../useLaunchpadPrs";

describe("useLaunchpadPrs multi-forge", () => {
  beforeEach(() => {
    listPRs.mockReset();
    listPRs.mockImplementation(async (cwd: string) => [
      { number: 1, title: `PR for ${cwd}`, state: "open", author: "me", branch: "f",
        base: "main", draft: false, createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z", url: `https://x/${cwd}/1`, additions: 0,
        deletions: 0, labels: [], assignees: [], reviewRequested: [], reviewDecision: "",
        mergeStateStatus: "", checksRollup: "", commentCount: 0 },
    ]);
  });

  it("aggregates PRs from connected forges and skips not-connected ones", async () => {
    const lp = useLaunchpadPrs();
    await lp.refresh([
      { path: "/repo-gh", name: "gh" },
      { path: "/repo-gl", name: "gl" },
      { path: "/repo-bb", name: "bb" }, // bitbucket → not connected → skipped
    ] as any);
    // github + gitlab fetched; bitbucket skipped
    expect(listPRs).toHaveBeenCalledTimes(2);
    expect(lp.allPrs.value).toHaveLength(2);
    expect(lp.needsConnection.value).toContain("bitbucket");
  });

  it("captures a per-repo error without failing the whole refresh", async () => {
    listPRs.mockImplementationOnce(async () => { throw new Error("boom"); });
    const lp = useLaunchpadPrs();
    await lp.refresh([
      { path: "/repo-gh", name: "gh" },
      { path: "/repo-gl", name: "gl" },
    ] as any);
    const errored = lp.repos.value.find((r) => r.error);
    expect(errored).toBeTruthy();
    expect(lp.error.value).toBeNull(); // top-level error stays null
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/desktop && pnpm vitest run src/composables/__tests__/useLaunchpadPrs.test.ts 2>&1 | tail -25`
Expected: FAIL — `needsConnection` undefined / `forgeForRepo` not used yet.

- [ ] **Step 3: Rewrite the composable**

Replace the body of `useLaunchpadPrs.ts` (keep the `PrWithRepo` interface and computed props):

```typescript
import { ref, computed } from "vue";
import type { WorkspaceRepoPrs, WorkspaceRepo, PullRequest } from "../utils/backend";
import { forgeForRepo, isForgeConnected } from "../forge/useForge";
import type { ForgeName } from "../forge/types";
import { useLaunchpadPins } from "./useLaunchpadPins";

export type { WorkspaceRepoPrs };

export interface PrWithRepo extends PullRequest {
  repoName: string;
  repoPath: string;
}

export function useLaunchpadPrs() {
  const repos = ref<WorkspaceRepoPrs[]>([]);
  const needsConnection = ref<ForgeName[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);

  const { isPinned, isSnoozed } = useLaunchpadPins();

  const allPrs = computed<PrWithRepo[]>(() =>
    repos.value
      .flatMap((r) => r.prs.map((pr) => ({ ...pr, repoName: r.repoName, repoPath: r.repoPath })))
      .filter((pr) => !isSnoozed(pr.url))
      .sort((a, b) => {
        const aPinned = isPinned(a.url) ? 0 : 1;
        const bPinned = isPinned(b.url) ? 0 : 1;
        if (aPinned !== bPinned) return aPinned - bPinned;
        return b.createdAt.localeCompare(a.createdAt);
      })
  );

  const snoozedPrs = computed<PrWithRepo[]>(() =>
    repos.value
      .flatMap((r) => r.prs.map((pr) => ({ ...pr, repoName: r.repoName, repoPath: r.repoPath })))
      .filter((pr) => isSnoozed(pr.url))
  );

  async function refresh(workspaceRepos: WorkspaceRepo[]): Promise<void> {
    loading.value = true;
    error.value = null;
    const unconnected = new Set<ForgeName>();
    try {
      const results = await Promise.all(
        workspaceRepos.map(async (repo): Promise<WorkspaceRepoPrs | null> => {
          const provider = await forgeForRepo(repo.path);
          const forge = provider.name as ForgeName;
          if (!isForgeConnected(forge)) {
            unconnected.add(forge);
            return null;
          }
          try {
            const prs = await provider.listPRs(repo.path, { state: "open", limit: 10 });
            return { repoPath: repo.path, repoName: repo.name, prs, error: null };
          } catch (e) {
            return {
              repoPath: repo.path, repoName: repo.name, prs: [],
              error: (e as Error).message ?? String(e),
            };
          }
        })
      );
      repos.value = results.filter((r): r is WorkspaceRepoPrs => r !== null);
      needsConnection.value = [...unconnected];
    } catch (e) {
      error.value = (e as Error).message ?? String(e);
    } finally {
      loading.value = false;
    }
  }

  return { repos, allPrs, snoozedPrs, needsConnection, loading, error, refresh };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/desktop && pnpm vitest run src/composables/__tests__/useLaunchpadPrs.test.ts 2>&1 | tail -15`
Expected: PASS (both new cases + any preserved ones).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/composables/useLaunchpadPrs.ts apps/desktop/src/composables/__tests__/useLaunchpadPrs.test.ts
git commit -m "feat(today): multi-forge PR aggregation via ForgeProvider"
```

---

## Task 8: `useLaunchpadIssues` — per-repo provider dispatch + Azure/unsupported skip

**Files:**
- Modify: `apps/desktop/src/composables/useLaunchpadIssues.ts`
- Test: `apps/desktop/src/composables/__tests__/useLaunchpadIssues.test.ts`

**Interfaces:**
- Consumes: `forgeForRepo(cwd)`, `isForgeConnected(forge)`; existing `WorkspaceRepoIssues`, `WorkspaceRepo`, `Issue`.
- Produces: unchanged public surface plus `needsConnection: Ref<ForgeName[]>`. Repos whose provider has no `listIssues` (Azure) are skipped silently (not a connection issue).

- [ ] **Step 1: Write the failing test**

Extend `useLaunchpadIssues.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

const listIssues = vi.fn();
vi.mock("../forge/useForge", () => ({
  forgeForRepo: vi.fn(async (cwd: string) => {
    if (cwd.includes("az")) return { name: "azure" }; // no listIssues → skipped
    return { name: cwd.includes("gl") ? "gitlab" : "github", listIssues };
  }),
  isForgeConnected: vi.fn(() => true),
}));
vi.mock("../useLaunchpadPins", () => ({
  useLaunchpadPins: () => ({ isPinned: () => false, isSnoozed: () => false }),
}));

import { useLaunchpadIssues } from "../useLaunchpadIssues";

describe("useLaunchpadIssues multi-forge", () => {
  beforeEach(() => {
    listIssues.mockReset();
    listIssues.mockImplementation(async (cwd: string) => [
      { number: 1, title: `issue ${cwd}`, state: "open", author: "me", assignees: [],
        labels: [], url: `https://x/${cwd}/1`, createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z", milestone: "" },
    ]);
  });

  it("aggregates issues from forges that support listIssues and skips Azure", async () => {
    const li = useLaunchpadIssues();
    await li.refresh([
      { path: "/repo-gh", name: "gh" },
      { path: "/repo-gl", name: "gl" },
      { path: "/repo-az", name: "az" }, // azure → no listIssues → skipped
    ] as any);
    // 2 forges × 3 filters (assigned/mentioned/created) = 6 calls
    expect(listIssues).toHaveBeenCalledTimes(6);
    li.activeFilter.value = "assigned";
    expect(li.allIssues.value.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/desktop && pnpm vitest run src/composables/__tests__/useLaunchpadIssues.test.ts 2>&1 | tail -25`
Expected: FAIL — still importing `workspaceIssuesAll`.

- [ ] **Step 3: Rewrite the `refresh` (and imports) of `useLaunchpadIssues.ts`**

Replace the import line and the `refresh` function. Keep everything else (the `reposByFilter` ref, computed props, `totalCount`) intact. New imports:

```typescript
import { ref, computed } from "vue";
import type { WorkspaceRepoIssues, WorkspaceRepo, Issue } from "../utils/backend";
import { forgeForRepo, isForgeConnected } from "../forge/useForge";
import type { ForgeName } from "../forge/types";
import { useLaunchpadPins } from "./useLaunchpadPins";
```

Add `const needsConnection = ref<ForgeName[]>([]);` next to the other refs, include it in the returned object, and replace `refresh`:

```typescript
  async function refresh(workspaceRepos: WorkspaceRepo[]): Promise<void> {
    loading.value = true;
    error.value = null;
    const unconnected = new Set<ForgeName>();
    try {
      // Resolve each repo's provider once, then fetch all three filters per repo.
      const resolved = await Promise.all(
        workspaceRepos.map(async (repo) => ({ repo, provider: await forgeForRepo(repo.path) }))
      );

      async function listFor(filter: ConcreteFilter): Promise<WorkspaceRepoIssues[]> {
        const out = await Promise.all(
          resolved.map(async ({ repo, provider }): Promise<WorkspaceRepoIssues | null> => {
            const forge = provider.name as ForgeName;
            if (!isForgeConnected(forge)) {
              unconnected.add(forge);
              return null;
            }
            if (typeof provider.listIssues !== "function") return null; // Azure: unsupported
            try {
              const issues = await provider.listIssues(repo.path, { filter, limit: 100 });
              return { repoPath: repo.path, repoName: repo.name, issues, filter, error: null };
            } catch (e) {
              return {
                repoPath: repo.path, repoName: repo.name, issues: [], filter,
                error: (e as Error).message ?? String(e),
              };
            }
          })
        );
        return out.filter((r): r is WorkspaceRepoIssues => r !== null);
      }

      const [assigned, mentioned, created] = await Promise.all([
        listFor("assigned"),
        listFor("mentioned"),
        listFor("created"),
      ]);
      reposByFilter.value = { assigned, mentioned, created };
      needsConnection.value = [...unconnected];
    } catch (e) {
      error.value = (e as Error).message ?? String(e);
    } finally {
      loading.value = false;
    }
  }
```

Ensure `Issue` stays imported (used by the `flatten`/types) and remove the now-unused `workspaceIssuesAll` import.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/desktop && pnpm vitest run src/composables/__tests__/useLaunchpadIssues.test.ts 2>&1 | tail -15`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/composables/useLaunchpadIssues.ts apps/desktop/src/composables/__tests__/useLaunchpadIssues.test.ts
git commit -m "feat(today): multi-forge issue aggregation via ForgeProvider (Azure skipped)"
```

---

## Task 9: Not-connected banner in `LaunchpadView.vue` + i18n

**Files:**
- Modify: `apps/desktop/src/components/LaunchpadView.vue`
- Modify: `apps/desktop/src/locales/{en,fr,es,pt-BR,zh-CN}.ts`

**Interfaces:**
- Consumes: `needsConnection` from `useLaunchpadPrs`/`useLaunchpadIssues`; `t(...)` from `useI18n`.
- Produces: a `forgeConnect` i18n key group; a banner rendered above the inbox list.

- [ ] **Step 1: Add the `forgeConnect` group to `en.ts`**

In `apps/desktop/src/locales/en.ts`, add a new top-level group (alphabetical placement per file convention):

```typescript
  forgeConnect: {
    banner: "Connect your {0} account to see {1} more repositories →",
    bannerOne: "Connect your {0} account to see 1 more repository →",
    gitlab: "GitLab",
    bitbucket: "Bitbucket",
    azure: "Azure DevOps",
    action: "Open Settings",
  },
```

- [ ] **Step 2: Mirror the group into the 4 other locales**

Add the same keys, translated, to `fr.ts`, `es.ts`, `pt-BR.ts`, `zh-CN.ts`. French values:

```typescript
  forgeConnect: {
    banner: "Connectez votre compte {0} pour voir {1} dépôts de plus →",
    bannerOne: "Connectez votre compte {0} pour voir 1 dépôt de plus →",
    gitlab: "GitLab",
    bitbucket: "Bitbucket",
    azure: "Azure DevOps",
    action: "Ouvrir les Réglages",
  },
```

es.ts:

```typescript
  forgeConnect: {
    banner: "Conecta tu cuenta de {0} para ver {1} repositorios más →",
    bannerOne: "Conecta tu cuenta de {0} para ver 1 repositorio más →",
    gitlab: "GitLab",
    bitbucket: "Bitbucket",
    azure: "Azure DevOps",
    action: "Abrir Ajustes",
  },
```

pt-BR.ts:

```typescript
  forgeConnect: {
    banner: "Conecte sua conta {0} para ver mais {1} repositórios →",
    bannerOne: "Conecte sua conta {0} para ver mais 1 repositório →",
    gitlab: "GitLab",
    bitbucket: "Bitbucket",
    azure: "Azure DevOps",
    action: "Abrir Configurações",
  },
```

zh-CN.ts:

```typescript
  forgeConnect: {
    banner: "连接你的 {0} 账户以查看另外 {1} 个仓库 →",
    bannerOne: "连接你的 {0} 账户以查看另外 1 个仓库 →",
    gitlab: "GitLab",
    bitbucket: "Bitbucket",
    azure: "Azure DevOps",
    action: "打开设置",
  },
```

- [ ] **Step 3: Render the banner in `LaunchpadView.vue`**

In `LaunchpadView.vue`, expose `needsConnection` from the PRs composable (it already destructures `useLaunchpadPrs()` — add `needsConnection: prNeedsConnection`). Compute per-forge repo counts from the workspace + a forge resolver, or simply render one banner per forge in `prNeedsConnection`. Insert in the inbox panel, right after the error/loading blocks (around line 417, before the inbox summary):

```vue
      <!-- Per-forge "connect your account" banners (multi-forge Today) -->
      <div
        v-for="forge in prNeedsConnection"
        :key="forge"
        class="launchpad-view__forge-banner"
        @click="openSettingsAccounts()"
      >
        <span>{{ t("forgeConnect.banner", forgeLabel(forge), forgeRepoCount(forge)) }}</span>
        <button class="launchpad-view__forge-banner-action">{{ t("forgeConnect.action") }}</button>
      </div>
```

Add to `<script setup>`:

```typescript
import { isForgeConnected } from "../composables/forge/useForge";
import type { ForgeName } from "../composables/forge/types";

function forgeLabel(forge: ForgeName): string {
  return t(`forgeConnect.${forge}` as any);
}
// Count workspace repos on a given forge. `props.repos` already holds the
// workspace repo list; resolve forge by remote provider already attached, or
// fall back to 0 when unknown.
function forgeRepoCount(_forge: ForgeName): number {
  // Minimal: the banner is informational; show the count if available, else "".
  return 0; // replaced below if a per-forge count source is wired
}
function openSettingsAccounts(): void {
  // Route to Settings → Accounts. Use the existing settings-open mechanism in
  // this component (see how other "open settings" actions are wired) — emit or
  // call the same handler used elsewhere in LaunchpadView.
}
```

NOTE: `forgeRepoCount` and `openSettingsAccounts` must be wired to real data/handlers present in `LaunchpadView.vue`. Before implementing, grep `LaunchpadView.vue` for how the workspace repo list and the Settings-open action are already exposed (e.g. a `props.repos` and an existing `emit('open-settings')` or a settings store call), and use those. If a per-forge count is not cheaply available, use `t("forgeConnect.banner", forgeLabel(forge), "")` style or switch to a count-less string — keep the banner informative without inventing a data source.

- [ ] **Step 4: Add minimal banner styles**

In the component `<style scoped>`:

```css
.launchpad-view__forge-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 14px;
  margin: 6px 0;
  border: 1px solid var(--gw-border-soft, #2a2a3a);
  border-radius: 8px;
  background: var(--gw-bg-elev, rgba(255,255,255,0.03));
  font-size: 13px;
  cursor: pointer;
}
.launchpad-view__forge-banner-action {
  white-space: nowrap;
}
```

- [ ] **Step 5: Type-check + run all Launchpad tests**

Run:
```bash
cd apps/desktop && pnpm exec vue-tsc --noEmit 2>&1 | tail -20
pnpm vitest run src/composables/__tests__/useLaunchpad src/components/__tests__/LaunchpadView.test.ts 2>&1 | grep -v certificate | tail -15
```
Expected: no type errors; all Launchpad tests pass.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/components/LaunchpadView.vue apps/desktop/src/locales/
git commit -m "feat(today): not-connected forge banner + 5-locale strings"
```

---

## Task 10: Verification pass (dev:web + full suites)

**Files:** none (verification only).

- [ ] **Step 1: Frontend suite**

Run: `cd apps/desktop && pnpm test 2>&1 | grep -v certificate | tail -25`
Expected: all pass (no regressions in Launchpad or elsewhere).

- [ ] **Step 2: Backend build + tests**

Run: `cd apps/desktop/src-tauri && cargo build 2>&1 | tail -5 && cargo test 2>&1 | tail -25`
Expected: build clean; new mapper tests pass.

- [ ] **Step 3: dev:web smoke (multi-forge renders)**

Start the web dev server and open Today; confirm the Issues/PRs tabs render and a not-connected forge shows the banner (use the preview tooling). Capture the console for errors.
Expected: no console errors; mock GitLab/Bitbucket issues appear under their filters; banner shows for a forge with no account.

- [ ] **Step 4: Final commit (if any verification fixups)**

```bash
git add -A
git commit -m "test(today): multi-forge verification fixups"
```

---

## Self-Review

**Spec coverage:**
- PRs across 4 forges → Task 7 (dispatch) + existing per-forge `listPRs` (GitHub/GitLab/Bitbucket/Azure). ✓
- Issues across GitHub/GitLab/Bitbucket → Tasks 1–3 (commands), 4–5 (IPC/dev), 6 (provider), 8 (dispatch). ✓
- Azure Issues deferred → Task 6 omits Azure `listIssues`; Task 8 skips providers without `listIssues`. ✓
- Not-connected forge → invitation banner → Task 6 `isForgeConnected`, Tasks 7/8 `needsConnection`, Task 9 banner. ✓
- No red errors for missing auth → connection gating skips the backend call entirely. ✓
- Notifications keep working (read composable state) → unchanged; `allPrs` shape preserved in Task 7. ✓
- Team stays GitHub-only → untouched. ✓
- IPC + dev:web parity per command → Tasks 4 & 5. ✓
- i18n ×5 → Task 9. ✓
- Tests (frontend multi-forge + not-connected; backend mappers) → Tasks 1–3, 7, 8, 10. ✓

**Open implementation detail flagged for the implementer (not a placeholder):** Task 9's `forgeRepoCount`/`openSettingsAccounts` must be wired to the real workspace-repo list and Settings-open mechanism already present in `LaunchpadView.vue`; the task says exactly what to grep for and how to fall back. The banner string supports both count and count-less forms (`banner` / `bannerOne`).

**Type consistency:** `listIssues(cwd, opts?)` signature is identical across types.ts and the three providers; `ghListIssues/glListIssues/bbListIssues(cwd, filter, limit)` identical across backend.ts, providers, and the Rust command param names (`cwd`, `filter`, `limit`); `Issue` is camelCase end-to-end (no mapping); `needsConnection: Ref<ForgeName[]>` consistent across both composables and the view.

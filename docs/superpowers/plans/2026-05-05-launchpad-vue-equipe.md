# Launchpad Vue Équipe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a fourth "Équipe" tab to the Launchpad showing colleagues' open PRs grouped by author, with file-level overlap detection against the current user's WIP changes.

**Architecture:** New `useLaunchpadTeam` composable (fresh-per-call, same contract as `useLaunchpadPrs`) calls `workspacePrsAll` (reused), `workspaceWipAll` (extended with `changedFiles`), and a new `prFiles()` backend wrapper. Identity resolved once via `ghCurrentUser()` (module-level cache). All changes land in `LaunchpadView.vue` as a fourth conditional panel.

**Tech Stack:** Vue 3 `<script setup>`, Vitest (jsdom), Rust/Tauri `#[tauri::command]`, `gh` CLI, TypeScript.

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Modify | `apps/desktop/src-tauri/src/lib.rs` | Add `changed_files` to `WorkspaceWipItem`; add `gh_current_user` + `pr_files` commands; register both |
| Modify | `apps/desktop/src/utils/backend.ts` | Add `changedFiles` to `WorkspaceWipItem` interface; add `ghCurrentUser()` + `prFiles()` wrappers |
| Modify | `apps/desktop/dev-server.mjs` | Extend WIP mock with `changed_files`; add 2 new mock routes |
| Modify | `apps/desktop/src/composables/__tests__/useLaunchpadWip.test.ts` | Add `changedFiles: []` to existing mock objects |
| Create | `apps/desktop/src/composables/useLaunchpadTeam.ts` | Team activity composable (overlap detection, grouping, sorting) |
| Create | `apps/desktop/src/composables/__tests__/useLaunchpadTeam.test.ts` | 6 Vitest tests |
| Modify | `apps/desktop/src/locales/en.ts` | 8 new `launchpad.*` keys |
| Modify | `apps/desktop/src/locales/fr.ts` | 8 new keys (French) |
| Modify | `apps/desktop/src/locales/es.ts` | 8 new keys (Spanish) |
| Modify | `apps/desktop/src/locales/pt-BR.ts` | 8 new keys (Portuguese) |
| Modify | `apps/desktop/src/locales/zh-CN.ts` | 8 new keys (Chinese) |
| Modify | `apps/desktop/src/components/LaunchpadView.vue` | 4th tab + team panel markup + CSS |

---

## Task 1: Extend WorkspaceWipItem with changedFiles

**Files:**
- Modify: `apps/desktop/src-tauri/src/lib.rs` (struct `WorkspaceWipItem` ~line 4606, command `workspace_wip_all` ~line 4847)
- Modify: `apps/desktop/src/utils/backend.ts` (`WorkspaceWipItem` interface + `workspaceWipAll` dev-server mapping)
- Modify: `apps/desktop/dev-server.mjs` (workspace-wip-all route ~line 3241)
- Modify: `apps/desktop/src/composables/__tests__/useLaunchpadWip.test.ts` (update mock objects)

- [ ] **Step 1: Add `changed_files` to the Rust `WorkspaceWipItem` struct**

In `apps/desktop/src-tauri/src/lib.rs`, find the `WorkspaceWipItem` struct (search for `pub struct WorkspaceWipItem`). Add the new field at the end, before the closing brace:

```rust
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceWipItem {
    pub path: String,
    pub name: String,
    pub branch: String,
    pub ahead: u32,
    pub behind: u32,
    pub staged_count: u32,
    pub unstaged_count: u32,
    pub untracked_count: u32,
    pub last_commit_at: String,
    pub has_no_upstream: bool,
    pub error: Option<String>,
    /// Relative paths of staged and unstaged changed files (excludes untracked).
    pub changed_files: Vec<String>,
}
```

- [ ] **Step 2: Populate `changed_files` in `workspace_wip_all`**

In the same file, find the `workspace_wip_all` function. The variable `status_out` is already computed (it contains the output of `git status --porcelain`). Add the `changed_files` extraction immediately after `status_out` is defined, and add the field to the `WorkspaceWipItem { ... }` struct literal:

```rust
// Add this block right after:
//   let (staged_count, unstaged_count, untracked_count) = parse_wip_status(&status_out);
let changed_files: Vec<String> = {
    let mut seen = std::collections::HashSet::new();
    for line in status_out.lines() {
        if line.len() < 4 { continue; }
        if &line[0..2] == "??" { continue; } // skip untracked
        let path_part = &line[3..];
        // Handle renames ("old -> new") — take the new path
        let path = if path_part.contains(" -> ") {
            path_part.split(" -> ").last().unwrap_or(path_part).trim()
        } else {
            path_part.trim()
        };
        if !path.is_empty() {
            seen.insert(path.to_string());
        }
    }
    let mut v: Vec<String> = seen.into_iter().collect();
    v.sort();
    v
};
```

Then in the `WorkspaceWipItem { ... }` struct literal at the bottom of the per-repo closure, add:
```rust
WorkspaceWipItem {
    path, name, branch,
    ahead, behind,
    staged_count, unstaged_count, untracked_count,
    last_commit_at,
    has_no_upstream,
    error: None,
    changed_files,   // ← add this line
}
```

- [ ] **Step 3: Add `changedFiles` to the TypeScript `WorkspaceWipItem` interface**

In `apps/desktop/src/utils/backend.ts`, search for `export interface WorkspaceWipItem`. Add the new field at the end:

```typescript
export interface WorkspaceWipItem {
  path: string;
  name: string;
  branch: string;
  ahead: number;
  behind: number;
  stagedCount: number;
  unstagedCount: number;
  untrackedCount: number;
  lastCommitAt: string;
  hasNoUpstream: boolean;
  error: string | null;
  changedFiles: string[];   // ← add this line
}
```

- [ ] **Step 4: Map `changed_files` in the `workspaceWipAll` dev-server path**

In `backend.ts`, find the `workspaceWipAll` function (around line 2894). In the `raw.map(...)` block that maps snake_case → camelCase, add the new field:

```typescript
return raw.map((item) => ({
  path: (item.path as string) ?? "",
  name: (item.name as string) ?? "",
  branch: (item.branch as string) ?? "",
  ahead: (item.ahead as number) ?? 0,
  behind: (item.behind as number) ?? 0,
  stagedCount: (item.staged_count as number) ?? 0,
  unstagedCount: (item.unstaged_count as number) ?? 0,
  untrackedCount: (item.untracked_count as number) ?? 0,
  lastCommitAt: (item.last_commit_at as string) ?? "",
  hasNoUpstream: (item.has_no_upstream as boolean) ?? false,
  error: (item.error as string | null) ?? null,
  changedFiles: (item.changed_files as string[]) ?? [],   // ← add this line
}));
```

- [ ] **Step 5: Extend the dev-server `workspace-wip-all` route**

In `apps/desktop/dev-server.mjs`, find the `workspace-wip-all` route (search for `"/api/workspace-wip-all"`). The route already computes `statusOut`. Add `changed_files` extraction and include it in the returned object.

Add this block after the existing `staged_count`/`unstaged_count`/`untracked_count` loop (after line ~3267):

```javascript
const changed_files = [];
const _seenFiles = new Set();
for (const line of statusOut.split("\n")) {
  if (line.length < 4) continue;
  if (line[0] === "?" && line[1] === "?") continue; // skip untracked
  const pathPart = line.slice(3).trim();
  const filePath = pathPart.includes(" -> ")
    ? pathPart.split(" -> ").pop()
    : pathPart;
  if (filePath && !_seenFiles.has(filePath)) {
    _seenFiles.add(filePath);
    changed_files.push(filePath);
  }
}
changed_files.sort();
```

Then in the return object (around line 3274), add `changed_files`:
```javascript
return {
  path: repo.path, name: repo.name, branch,
  ahead, behind,
  staged_count, unstaged_count, untracked_count,
  last_commit_at, has_no_upstream,
  changed_files,   // ← add this line
  error: null,
};
```

Also update the error-case return object to include `changed_files: []`:
```javascript
return {
  path: repo.path, name: repo.name, branch: "",
  ahead: 0, behind: 0,
  staged_count: 0, unstaged_count: 0, untracked_count: 0,
  last_commit_at: "", has_no_upstream: false,
  changed_files: [],   // ← add this line
  error: e.message,
};
```

- [ ] **Step 6: Update mock objects in existing WIP tests**

Open `apps/desktop/src/composables/__tests__/useLaunchpadWip.test.ts`. Any mock `WorkspaceWipItem` object must now include `changedFiles: []`. Search for objects in that file that have `stagedCount` or `unstagedCount` fields and add `changedFiles: []` to each.

- [ ] **Step 7: Verify compilation and existing tests pass**

```bash
cd apps/desktop/src-tauri && cargo check 2>&1 | tail -20
```
Expected: no errors.

```bash
cd apps/desktop && pnpm test --run 2>&1 | tail -20
```
Expected: all existing tests pass (65+ tests, 0 failures).

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src-tauri/src/lib.rs \
        apps/desktop/src/utils/backend.ts \
        apps/desktop/dev-server.mjs \
        apps/desktop/src/composables/__tests__/useLaunchpadWip.test.ts
git commit -m "feat(wip): add changedFiles to WorkspaceWipItem (Rust + TS + mock)"
```

---

## Task 2: New backend commands — ghCurrentUser + prFiles

**Files:**
- Modify: `apps/desktop/src-tauri/src/lib.rs` (add 2 new commands + register in `generate_handler!`)
- Modify: `apps/desktop/src/utils/backend.ts` (add 2 new exported functions)
- Modify: `apps/desktop/dev-server.mjs` (add 2 new routes)

- [ ] **Step 1: Add the `gh_current_user` Tauri command**

In `apps/desktop/src-tauri/src/lib.rs`, add this function near the other `gh`-related commands (search for `workspace_prs_all` and add nearby):

```rust
/// Returns the GitHub login of the authenticated user via `gh api user`.
#[tauri::command]
fn gh_current_user() -> Result<String, String> {
    let output = std::process::Command::new("gh")
        .args(["api", "user", "--jq", ".login"])
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}
```

- [ ] **Step 2: Add the `pr_files` Tauri command**

In the same file, add immediately after `gh_current_user`:

```rust
/// Returns the list of file paths changed by a given PR number.
/// Calls `gh pr view <pr_number> --json files --jq '[.files[].path]'`.
#[tauri::command]
fn pr_files(repo_path: String, pr_number: u32) -> Result<Vec<String>, String> {
    let output = std::process::Command::new("gh")
        .args([
            "pr", "view", &pr_number.to_string(),
            "--json", "files",
            "--jq", "[.files[].path]",
        ])
        .current_dir(&repo_path)
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    let json = String::from_utf8_lossy(&output.stdout);
    serde_json::from_str::<Vec<String>>(json.trim())
        .map_err(|e| e.to_string())
}
```

- [ ] **Step 3: Register both commands in `generate_handler!`**

In `lib.rs`, search for `generate_handler![` (or `tauri::generate_handler!`). Find the line containing `workspace_wip_all,` and add the two new commands right after `workspace_issues_all,`:

```rust
workspace_wip_all,
workspace_prs_all,
workspace_issues_all,
gh_current_user,    // ← add
pr_files,           // ← add
```

- [ ] **Step 4: Add `ghCurrentUser` wrapper to `backend.ts`**

In `apps/desktop/src/utils/backend.ts`, add after the `workspaceWipAll` function (around line 2918):

```typescript
// Module-level identity cache — one `gh api user` call per app session.
let _currentUserCache: string | null = null;

/** Returns the GitHub login of the authenticated CLI user. Result is cached. */
export async function ghCurrentUser(): Promise<string> {
  if (_currentUserCache) return _currentUserCache;
  if (isTauri()) {
    _currentUserCache = await tauriInvoke<string>("gh_current_user");
  } else {
    const res = await devFetch(`${DEV_SERVER}/api/gh-current-user`);
    if (!res.ok) throw new Error(`Failed to get current user: ${res.status}`);
    _currentUserCache = (await res.json()) as string;
  }
  return _currentUserCache;
}
```

- [ ] **Step 5: Add `prFiles` wrapper to `backend.ts`**

Immediately after `ghCurrentUser`:

```typescript
/** Returns the list of file paths changed by a PR (lazy — call only when needed). */
export async function prFiles(repoPath: string, prNumber: number): Promise<string[]> {
  if (isTauri()) {
    return tauriInvoke<string[]>("pr_files", { repoPath, prNumber });
  }
  const res = await devFetch(
    `${DEV_SERVER}/api/pr-files?repo=${encodeURIComponent(repoPath)}&pr=${prNumber}`
  );
  if (!res.ok) throw new Error(`Failed to get PR files: ${res.status}`);
  return res.json() as Promise<string[]>;
}
```

- [ ] **Step 6: Add mock routes to `dev-server.mjs`**

In `dev-server.mjs`, find the section containing the workspace routes. Add these two routes near the other workspace routes (before the final `else` / 404 handler):

```javascript
// GET /api/gh-current-user
if (url.pathname === "/api/gh-current-user" && req.method === "GET") {
  try {
    const { execFileSync } = await import("node:child_process");
    const login = execFileSync("gh", ["api", "user", "--jq", ".login"], { encoding: "utf-8" }).trim();
    return jsonResponse(req, res, login);
  } catch (err) {
    return jsonResponse(req, res, { error: err.message }, 500);
  }
}

// GET /api/pr-files?repo=<path>&pr=<number>
if (url.pathname === "/api/pr-files" && req.method === "GET") {
  try {
    const repoPath = url.searchParams.get("repo");
    const prNumber = url.searchParams.get("pr");
    if (!repoPath || !prNumber) {
      return jsonResponse(req, res, { error: "Missing repo or pr parameter" }, 400);
    }
    const raw = execFileSync(
      "gh",
      ["pr", "view", prNumber, "--json", "files", "--jq", "[.files[].path]"],
      { cwd: repoPath, encoding: "utf-8" }
    );
    return jsonResponse(req, res, JSON.parse(raw.trim() || "[]"));
  } catch (err) {
    return jsonResponse(req, res, { error: err.message }, 500);
  }
}
```

Note: `execFileSync` is already imported at the top of `dev-server.mjs` — do not add a duplicate import.

- [ ] **Step 7: Verify Rust compiles and tests pass**

```bash
cd apps/desktop/src-tauri && cargo check 2>&1 | tail -20
```
Expected: no errors.

```bash
cd apps/desktop && pnpm test --run 2>&1 | tail -20
```
Expected: all tests pass.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src-tauri/src/lib.rs \
        apps/desktop/src/utils/backend.ts \
        apps/desktop/dev-server.mjs
git commit -m "feat(backend): add gh_current_user + pr_files commands and wrappers"
```

---

## Task 3: useLaunchpadTeam composable (TDD)

**Files:**
- Create: `apps/desktop/src/composables/__tests__/useLaunchpadTeam.test.ts`
- Create: `apps/desktop/src/composables/useLaunchpadTeam.ts`

- [ ] **Step 1: Create the test file with all 6 failing tests**

Create `apps/desktop/src/composables/__tests__/useLaunchpadTeam.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WorkspaceRepo } from "../../utils/backend";

vi.mock("../../utils/backend", () => ({
  workspacePrsAll: vi.fn(),
  workspaceWipAll: vi.fn(),
  ghCurrentUser: vi.fn(),
  prFiles: vi.fn(),
}));

import {
  workspacePrsAll,
  workspaceWipAll,
  ghCurrentUser,
  prFiles,
} from "../../utils/backend";
import { useLaunchpadTeam, _resetTeamForTesting } from "../useLaunchpadTeam";

const mockPrsAll = vi.mocked(workspacePrsAll);
const mockWipAll = vi.mocked(workspaceWipAll);
const mockCurrentUser = vi.mocked(ghCurrentUser);
const mockPrFiles = vi.mocked(prFiles);

const REPOS: WorkspaceRepo[] = [{ path: "/repo/a", name: "alpha" }];

const BASE_PR = {
  number: 1,
  title: "PR title",
  state: "OPEN",
  branch: "feat/x",
  base: "main",
  draft: false,
  createdAt: "2026-05-01T10:00:00Z",
  updatedAt: "2026-05-02T10:00:00Z",
  url: "https://github.com/org/alpha/pull/1",
  additions: 5,
  deletions: 2,
  labels: [],
  assignees: [],
  reviewRequested: [],
  reviewDecision: "",
  mergeStateStatus: "CLEAN",
  checksRollup: "SUCCESS",
};

const EMPTY_WIP = [
  {
    path: "/repo/a",
    name: "alpha",
    branch: "main",
    ahead: 0,
    behind: 0,
    stagedCount: 0,
    unstagedCount: 0,
    untrackedCount: 0,
    lastCommitAt: "2026-05-01T10:00:00Z",
    hasNoUpstream: false,
    error: null,
    changedFiles: [],
  },
];

beforeEach(() => {
  _resetTeamForTesting();
  mockCurrentUser.mockResolvedValue("me");
  mockWipAll.mockResolvedValue(EMPTY_WIP);
  mockPrsAll.mockResolvedValue([]);
  mockPrFiles.mockResolvedValue([]);
});

describe("useLaunchpadTeam", () => {
  it("excludes PRs authored by the current user", async () => {
    mockPrsAll.mockResolvedValue([
      {
        repoPath: "/repo/a",
        repoName: "alpha",
        prs: [
          { ...BASE_PR, number: 1, author: "me", url: "https://github.com/org/alpha/pull/1" },
          { ...BASE_PR, number: 2, author: "alice", url: "https://github.com/org/alpha/pull/2" },
        ],
        error: null,
      },
    ]);

    const { teamActivity, refresh } = useLaunchpadTeam();
    await refresh(REPOS);

    expect(teamActivity.value).toHaveLength(1);
    expect(teamActivity.value[0].login).toBe("alice");
    expect(teamActivity.value[0].prs.every((pr) => pr.author !== "me")).toBe(true);
  });

  it("groups colleague PRs by author login, sorted by createdAt descending", async () => {
    mockPrsAll.mockResolvedValue([
      {
        repoPath: "/repo/a",
        repoName: "alpha",
        prs: [
          {
            ...BASE_PR,
            number: 1,
            author: "alice",
            createdAt: "2026-05-01T10:00:00Z",
            url: "https://github.com/org/alpha/pull/1",
          },
          {
            ...BASE_PR,
            number: 2,
            author: "alice",
            createdAt: "2026-05-03T10:00:00Z",
            url: "https://github.com/org/alpha/pull/2",
          },
          {
            ...BASE_PR,
            number: 3,
            author: "bob",
            createdAt: "2026-05-02T10:00:00Z",
            url: "https://github.com/org/alpha/pull/3",
          },
        ],
        error: null,
      },
    ]);

    const { teamActivity, refresh } = useLaunchpadTeam();
    await refresh(REPOS);

    const alice = teamActivity.value.find((m) => m.login === "alice")!;
    expect(alice.prs).toHaveLength(2);
    // PR#2 (2026-05-03) must come before PR#1 (2026-05-01)
    expect(alice.prs[0].number).toBe(2);
    expect(alice.prs[1].number).toBe(1);
    expect(teamActivity.value.find((m) => m.login === "bob")).toBeDefined();
  });

  it("detects overlap between WIP files and colleague PR files", async () => {
    mockWipAll.mockResolvedValue([
      { ...EMPTY_WIP[0], changedFiles: ["src/auth.ts", "src/utils.ts"] },
    ]);
    mockPrsAll.mockResolvedValue([
      {
        repoPath: "/repo/a",
        repoName: "alpha",
        prs: [
          { ...BASE_PR, number: 1, author: "alice", url: "https://github.com/org/alpha/pull/1" },
        ],
        error: null,
      },
    ]);
    mockPrFiles.mockResolvedValue(["src/auth.ts", "src/login.ts"]);

    const { teamActivity, refresh } = useLaunchpadTeam();
    await refresh(REPOS);

    const alice = teamActivity.value[0];
    expect(alice.overlappingPrs).toHaveLength(1);
    expect(alice.overlappingPrs[0].overlappingFiles).toEqual(["src/auth.ts"]);
    expect(alice.overlappingPrs[0].myContext).toBe("wip");
  });

  it("uses branch files when WIP is empty (myContext: 'branch')", async () => {
    // WIP empty; I have PR#1, colleague alice has PR#2
    mockPrsAll.mockResolvedValue([
      {
        repoPath: "/repo/a",
        repoName: "alpha",
        prs: [
          { ...BASE_PR, number: 1, author: "me", url: "https://github.com/org/alpha/pull/1" },
          { ...BASE_PR, number: 2, author: "alice", url: "https://github.com/org/alpha/pull/2" },
        ],
        error: null,
      },
    ]);
    // First prFiles call = my PR#1, second = alice's PR#2
    mockPrFiles
      .mockResolvedValueOnce(["src/auth.ts"])
      .mockResolvedValueOnce(["src/auth.ts"]);

    const { teamActivity, refresh } = useLaunchpadTeam();
    await refresh(REPOS);

    const alice = teamActivity.value[0];
    expect(alice.overlappingPrs).toHaveLength(1);
    expect(alice.overlappingPrs[0].myContext).toBe("branch");
  });

  it("sorts members with overlaps before members without", async () => {
    mockWipAll.mockResolvedValue([
      { ...EMPTY_WIP[0], changedFiles: ["src/auth.ts"] },
    ]);
    mockPrsAll.mockResolvedValue([
      {
        repoPath: "/repo/a",
        repoName: "alpha",
        prs: [
          { ...BASE_PR, number: 1, author: "alice", url: "https://github.com/org/alpha/pull/1" },
          { ...BASE_PR, number: 2, author: "bob", url: "https://github.com/org/alpha/pull/2" },
        ],
        error: null,
      },
    ]);
    // alice's PR: no overlap; bob's PR: overlap
    mockPrFiles
      .mockResolvedValueOnce([])                // alice PR#1 — no overlap
      .mockResolvedValueOnce(["src/auth.ts"]);  // bob PR#2 — overlap

    const { teamActivity, refresh } = useLaunchpadTeam();
    await refresh(REPOS);

    // bob (overlap) must come before alice (no overlap)
    expect(teamActivity.value[0].login).toBe("bob");
    expect(teamActivity.value[1].login).toBe("alice");
  });

  it("calls ghCurrentUser only once across multiple refresh() calls", async () => {
    const { refresh } = useLaunchpadTeam();
    await refresh(REPOS);
    await refresh(REPOS);
    await refresh(REPOS);

    expect(mockCurrentUser).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the tests — confirm all 6 fail**

```bash
cd apps/desktop && pnpm test --run src/composables/__tests__/useLaunchpadTeam.test.ts 2>&1 | tail -30
```
Expected: 6 test failures with "Cannot find module" or similar — the composable doesn't exist yet.

- [ ] **Step 3: Create `useLaunchpadTeam.ts`**

Create `apps/desktop/src/composables/useLaunchpadTeam.ts`:

```typescript
import { ref } from "vue";
import {
  workspacePrsAll,
  workspaceWipAll,
  ghCurrentUser,
  prFiles,
} from "../utils/backend";
import type { WorkspaceRepo } from "../utils/backend";
import type { PrWithRepo } from "./useLaunchpadPrs";

export interface OverlappingPr extends PrWithRepo {
  overlappingFiles: string[];
  myContext: "wip" | "branch";
}

export interface TeamMemberActivity {
  login: string;
  prs: PrWithRepo[];
  overlappingPrs: OverlappingPr[];
}

// Module-level cache — survives across refresh() calls within the same page session.
let _currentUser: string | null = null;

/** Reset identity cache. Call in tests between each test case. */
export function _resetTeamForTesting(): void {
  _currentUser = null;
}

/**
 * Composable for the Launchpad Team panel.
 * Aggregates colleagues' open PRs from all repos, detects file-level overlap
 * with the current user's WIP changes or open branches.
 * Each call returns a fresh reactive scope — no shared singleton.
 */
export function useLaunchpadTeam() {
  const teamActivity = ref<TeamMemberActivity[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);

  async function refresh(repos: WorkspaceRepo[]): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      // 1. Identity (cached)
      if (!_currentUser) _currentUser = await ghCurrentUser();
      const me = _currentUser;

      // 2. Fetch PRs — split into mine and colleagues'
      const allRepoPrs = await workspacePrsAll(repos);
      const flat: PrWithRepo[] = allRepoPrs.flatMap((r) =>
        r.prs.map((pr) => ({ ...pr, repoName: r.repoName, repoPath: r.repoPath }))
      );
      const myPrs = flat.filter((pr) => pr.author === me);
      const colleaguePrs = flat.filter((pr) => pr.author !== me);

      // 3. Collect my changed files from WIP
      const wipData = await workspaceWipAll(repos);
      let myFiles: string[] = wipData.flatMap((w) => w.changedFiles);
      let myContext: "wip" | "branch" = "wip";

      // 4. Branch fallback: if WIP is empty and I have open PRs, use their file lists
      if (myFiles.length === 0 && myPrs.length > 0) {
        const myPrFileLists = await Promise.all(
          myPrs.map((pr) => prFiles(pr.repoPath, pr.number).catch(() => []))
        );
        myFiles = [...new Set(myPrFileLists.flat())];
        myContext = "branch";
      }

      // 5. Fetch file lists for all colleague PRs in parallel
      const colleagueFileLists = await Promise.all(
        colleaguePrs.map((pr) => prFiles(pr.repoPath, pr.number).catch(() => []))
      );

      // 6. Build TeamMemberActivity map
      const memberMap = new Map<
        string,
        { prs: PrWithRepo[]; overlappingPrs: OverlappingPr[] }
      >();
      for (let i = 0; i < colleaguePrs.length; i++) {
        const pr = colleaguePrs[i];
        const files = colleagueFileLists[i];
        const overlapping = myFiles.filter((f) => files.includes(f));
        const login = pr.author;
        if (!memberMap.has(login)) {
          memberMap.set(login, { prs: [], overlappingPrs: [] });
        }
        const member = memberMap.get(login)!;
        member.prs.push(pr);
        if (overlapping.length > 0) {
          member.overlappingPrs.push({ ...pr, overlappingFiles: overlapping, myContext });
        }
      }

      // 7. Sort PRs within each member by createdAt desc, then sort members
      teamActivity.value = Array.from(memberMap.entries())
        .map(([login, data]) => ({
          login,
          prs: data.prs.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
          overlappingPrs: data.overlappingPrs,
        }))
        .sort((a, b) => {
          const aHas = a.overlappingPrs.length > 0 ? 0 : 1;
          const bHas = b.overlappingPrs.length > 0 ? 0 : 1;
          if (aHas !== bHas) return aHas - bHas;
          return a.login.localeCompare(b.login);
        });
    } catch (e) {
      error.value = (e as Error).message ?? String(e);
    } finally {
      loading.value = false;
    }
  }

  return { teamActivity, loading, error, refresh };
}
```

- [ ] **Step 4: Run the tests — confirm all 6 pass**

```bash
cd apps/desktop && pnpm test --run src/composables/__tests__/useLaunchpadTeam.test.ts 2>&1 | tail -20
```
Expected: `Tests  6 passed (6)`.

- [ ] **Step 5: Run the full test suite — confirm no regressions**

```bash
cd apps/desktop && pnpm test --run 2>&1 | tail -10
```
Expected: all existing tests + 6 new = 71+ tests, 0 failures.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/composables/useLaunchpadTeam.ts \
        apps/desktop/src/composables/__tests__/useLaunchpadTeam.test.ts
git commit -m "feat(launchpad): add useLaunchpadTeam composable with overlap detection"
```

---

## Task 4: i18n — 8 keys × 5 locales

**Files:**
- Modify: `apps/desktop/src/locales/en.ts`
- Modify: `apps/desktop/src/locales/fr.ts`
- Modify: `apps/desktop/src/locales/es.ts`
- Modify: `apps/desktop/src/locales/pt-BR.ts`
- Modify: `apps/desktop/src/locales/zh-CN.ts`

- [ ] **Step 1: Add 8 keys to `en.ts`**

In `apps/desktop/src/locales/en.ts`, find the `launchpad` block and add after the last existing key (`issueMenuLabel`):

```typescript
    teamTab: "Team",
    noTeamActivity: "No team activity on this workspace.",
    teamOverlaps: "Overlaps ({0})",
    teamMembers: "Team",
    teamOverlapFiles: "{0} shared file(s)",
    teamOverlapViaWip: "via WIP",
    teamOverlapViaBranch: "via branch",
    teamPrCount: "{0} PR(s)",
```

- [ ] **Step 2: Add 8 keys to `fr.ts`**

```typescript
    teamTab: "Équipe",
    noTeamActivity: "Aucune activité d'équipe sur ce workspace.",
    teamOverlaps: "Chevauchements ({0})",
    teamMembers: "Équipe",
    teamOverlapFiles: "{0} fichier(s) en commun",
    teamOverlapViaWip: "via WIP",
    teamOverlapViaBranch: "via branche",
    teamPrCount: "{0} PR(s)",
```

- [ ] **Step 3: Add 8 keys to `es.ts`**

```typescript
    teamTab: "Equipo",
    noTeamActivity: "Sin actividad del equipo en este workspace.",
    teamOverlaps: "Solapamientos ({0})",
    teamMembers: "Equipo",
    teamOverlapFiles: "{0} archivo(s) en común",
    teamOverlapViaWip: "vía WIP",
    teamOverlapViaBranch: "vía rama",
    teamPrCount: "{0} PR(s)",
```

- [ ] **Step 4: Add 8 keys to `pt-BR.ts`**

```typescript
    teamTab: "Equipe",
    noTeamActivity: "Nenhuma atividade da equipe neste workspace.",
    teamOverlaps: "Sobreposições ({0})",
    teamMembers: "Equipe",
    teamOverlapFiles: "{0} arquivo(s) em comum",
    teamOverlapViaWip: "via WIP",
    teamOverlapViaBranch: "via branch",
    teamPrCount: "{0} PR(s)",
```

- [ ] **Step 5: Add 8 keys to `zh-CN.ts`**

```typescript
    teamTab: "团队",
    noTeamActivity: "此工作区无团队活动。",
    teamOverlaps: "文件冲突 ({0})",
    teamMembers: "团队",
    teamOverlapFiles: "{0} 个共同文件",
    teamOverlapViaWip: "来自 WIP",
    teamOverlapViaBranch: "来自分支",
    teamPrCount: "{0} 个 PR",
```

- [ ] **Step 6: Verify tests still pass**

```bash
cd apps/desktop && pnpm test --run 2>&1 | tail -10
```
Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/locales/en.ts \
        apps/desktop/src/locales/fr.ts \
        apps/desktop/src/locales/es.ts \
        apps/desktop/src/locales/pt-BR.ts \
        apps/desktop/src/locales/zh-CN.ts
git commit -m "feat(i18n): add 8 team-view keys to all 5 locales"
```

---

## Task 5: LaunchpadView.vue — 4th tab + team panel

**Files:**
- Modify: `apps/desktop/src/components/LaunchpadView.vue`

This task adds the Team tab to the existing `LaunchpadView.vue`. No new `.vue` file is created.

- [ ] **Step 1: Import `useLaunchpadTeam` and extend the `Tab` type**

In `apps/desktop/src/components/LaunchpadView.vue`, find the `<script setup>` section.

Add the import after the existing composable imports:
```typescript
import { useLaunchpadTeam } from "../composables/useLaunchpadTeam";
import type { TeamMemberActivity } from "../composables/useLaunchpadTeam";
```

Change the `Tab` type union:
```typescript
// Before:
type Tab = "wip" | "prs" | "issues";
// After:
type Tab = "wip" | "prs" | "issues" | "team";
```

- [ ] **Step 2: Wire `useLaunchpadTeam` into the script setup**

In the script setup, add after the `useLaunchpadPins` destructuring:
```typescript
const {
  teamActivity,
  loading: teamLoading,
  error: teamError,
  refresh: refreshTeam,
} = useLaunchpadTeam();
```

Add the expanded-state ref and helper functions after the existing `showSnoozedIssues` ref:
```typescript
const expandedTeamMembers = ref<Set<string>>(new Set());

function initExpandedMembers(members: TeamMemberActivity[]): void {
  expandedTeamMembers.value = new Set(
    members.filter((m) => m.overlappingPrs.length > 0).map((m) => m.login)
  );
}

function toggleTeamMember(login: string): void {
  const next = new Set(expandedTeamMembers.value);
  if (next.has(login)) next.delete(login);
  else next.add(login);
  expandedTeamMembers.value = next;
}

const TEAM_AVATAR_COLORS = [
  "#cba6f7", "#89b4fa", "#a6e3a1", "#fab387", "#f38ba8", "#94e2d5",
] as const;

function teamAvatarColor(login: string): string {
  let hash = 0;
  for (let i = 0; i < login.length; i++) {
    hash = (hash * 31 + login.charCodeAt(i)) & 0xffff;
  }
  return TEAM_AVATAR_COLORS[hash % TEAM_AVATAR_COLORS.length];
}
```

- [ ] **Step 3: Update `isLoading`, `handleRefresh`, and `onMounted`**

Update `isLoading` to include the team tab:
```typescript
const isLoading = () =>
  wipLoading.value || prsLoading.value || issuesLoading.value || teamLoading.value;
```

Update `handleRefresh` to handle the team tab. Find the existing `handleRefresh` function and add the team case:
```typescript
function handleRefresh() {
  if (activeTab.value === "wip") refreshWip(props.repos);
  else if (activeTab.value === "prs") refreshPrs(props.repos);
  else if (activeTab.value === "issues") refreshIssues(props.repos, issueFilter.value);
  else if (activeTab.value === "team") {
    refreshTeam(props.repos).then(() => initExpandedMembers(teamActivity.value));
  }
}
```

Update `onMounted` to also start the team fetch:
```typescript
onMounted(() => {
  refreshWip(props.repos);
  refreshPrs(props.repos);
  refreshIssues(props.repos);
  refreshTeam(props.repos).then(() => initExpandedMembers(teamActivity.value));
});
```

- [ ] **Step 4: Add the Team tab button to the tab bar**

In the template, find the Issues tab button. Add the Team tab button immediately after it:

```html
<button
  class="launchpad-view__tab"
  :class="{ 'launchpad-view__tab--active': activeTab === 'team' }"
  @click="setTab('team')"
  :aria-label="t('launchpad.teamTab')"
>
  {{ t("launchpad.teamTab") }}
</button>
```

- [ ] **Step 5: Add the Team panel to the template**

Find the Issues panel's closing `</div>` tag and add the Team panel immediately after it:

```html
<!-- ── Team panel ─────────────────────────────────────────── -->
<div v-if="activeTab === 'team'" class="launchpad-view__panel">
  <!-- Loading -->
  <div v-if="teamLoading" class="launchpad-view__empty">
    {{ t("launchpad.loading") }}
  </div>

  <!-- Error -->
  <div v-else-if="teamError" class="launchpad-view__error">
    {{ t("launchpad.errorFetch", teamError) }}
  </div>

  <!-- Empty state -->
  <div v-else-if="teamActivity.length === 0" class="launchpad-view__empty">
    {{ t("launchpad.noTeamActivity") }}
  </div>

  <!-- Content -->
  <template v-else>
    <!-- Overlaps section -->
    <div
      v-if="teamActivity.some((m) => m.overlappingPrs.length > 0)"
      class="launchpad-view__team-section"
    >
      <div class="launchpad-view__team-section-header launchpad-view__team-section-header--overlap">
        ⚠
        {{
          t(
            "launchpad.teamOverlaps",
            teamActivity.filter((m) => m.overlappingPrs.length > 0).length
          )
        }}
      </div>
      <div
        v-for="member in teamActivity.filter((m) => m.overlappingPrs.length > 0)"
        :key="member.login"
        class="launchpad-view__team-member launchpad-view__team-member--overlap"
      >
        <div
          class="launchpad-view__team-member-header"
          @click="toggleTeamMember(member.login)"
          role="button"
          tabindex="0"
          @keydown.enter="toggleTeamMember(member.login)"
          @keydown.space.prevent="toggleTeamMember(member.login)"
        >
          <span
            class="launchpad-view__team-avatar"
            :style="{ background: teamAvatarColor(member.login) }"
            aria-hidden="true"
          >{{ member.login[0].toUpperCase() }}</span>
          <span
            class="launchpad-view__team-login"
            :style="{ color: teamAvatarColor(member.login) }"
          >{{ member.login }}</span>
          <span class="launchpad-view__team-pr-count">
            {{ t("launchpad.teamPrCount", member.prs.length) }}
          </span>
          <span class="launchpad-view__team-chevron">
            {{ expandedTeamMembers.has(member.login) ? "▾" : "▸" }}
          </span>
        </div>
        <div v-if="expandedTeamMembers.has(member.login)" class="launchpad-view__team-prs">
          <div
            v-for="pr in member.prs"
            :key="pr.url"
            class="launchpad-view__team-pr-row"
          >
            <span class="launchpad-view__repo-badge">{{ pr.repoName }}</span>
            <a :href="pr.url" class="launchpad-view__pr-title" target="_blank">
              #{{ pr.number }} {{ pr.title }}
            </a>
            <template v-if="member.overlappingPrs.find((op) => op.url === pr.url) as OverlappingPr | undefined">
              <div class="launchpad-view__overlap-badge">
                <span>⚠</span>
                <span>{{
                  t(
                    "launchpad.teamOverlapFiles",
                    (member.overlappingPrs.find((op) => op.url === pr.url) as OverlappingPr).overlappingFiles.length
                  )
                }}</span>
                <span>{{
                  (member.overlappingPrs.find((op) => op.url === pr.url) as OverlappingPr).myContext === "wip"
                    ? t("launchpad.teamOverlapViaWip")
                    : t("launchpad.teamOverlapViaBranch")
                }}</span>
              </div>
            </template>
          </div>
        </div>
      </div>
    </div>

    <!-- Team section (no overlap) -->
    <div
      v-if="teamActivity.some((m) => m.overlappingPrs.length === 0)"
      class="launchpad-view__team-section"
    >
      <div class="launchpad-view__team-section-header">
        {{ t("launchpad.teamMembers") }}
      </div>
      <div
        v-for="member in teamActivity.filter((m) => m.overlappingPrs.length === 0)"
        :key="member.login"
        class="launchpad-view__team-member"
      >
        <div
          class="launchpad-view__team-member-header"
          @click="toggleTeamMember(member.login)"
          role="button"
          tabindex="0"
          @keydown.enter="toggleTeamMember(member.login)"
          @keydown.space.prevent="toggleTeamMember(member.login)"
        >
          <span
            class="launchpad-view__team-avatar"
            :style="{ background: teamAvatarColor(member.login) }"
            aria-hidden="true"
          >{{ member.login[0].toUpperCase() }}</span>
          <span
            class="launchpad-view__team-login"
            :style="{ color: teamAvatarColor(member.login) }"
          >{{ member.login }}</span>
          <span class="launchpad-view__team-pr-count">
            {{ t("launchpad.teamPrCount", member.prs.length) }}
          </span>
          <span class="launchpad-view__team-chevron">
            {{ expandedTeamMembers.has(member.login) ? "▾" : "▸" }}
          </span>
        </div>
        <div v-if="expandedTeamMembers.has(member.login)" class="launchpad-view__team-prs">
          <div
            v-for="pr in member.prs"
            :key="pr.url"
            class="launchpad-view__team-pr-row"
          >
            <span class="launchpad-view__repo-badge">{{ pr.repoName }}</span>
            <a :href="pr.url" class="launchpad-view__pr-title" target="_blank">
              #{{ pr.number }} {{ pr.title }}
            </a>
          </div>
        </div>
      </div>
    </div>
  </template>
</div>
```

Note: `OverlappingPr` is already imported from `useLaunchpadTeam` at Step 1.

- [ ] **Step 6: Add CSS for the team panel**

In the `<style scoped>` section of `LaunchpadView.vue`, add at the end:

```css
/* ── Team panel ──────────────────────────────────────────── */
.launchpad-view__team-section {
  margin-bottom: 16px;
}

.launchpad-view__team-section-header {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #6c7086;
  margin-bottom: 8px;
}

.launchpad-view__team-section-header--overlap {
  color: #f38ba8;
}

.launchpad-view__team-member {
  border: 1px solid #313244;
  border-radius: 6px;
  margin-bottom: 6px;
  overflow: hidden;
  background: #1e1e2e;
}

.launchpad-view__team-member--overlap {
  border-color: #f38ba8;
  background: #2a1e2e;
}

.launchpad-view__team-member-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  cursor: pointer;
  user-select: none;
}

.launchpad-view__team-member-header:hover {
  background: rgba(255, 255, 255, 0.04);
}

.launchpad-view__team-avatar {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  color: #1e1e2e;
  font-weight: 700;
  flex-shrink: 0;
}

.launchpad-view__team-login {
  font-weight: 600;
  font-size: 13px;
}

.launchpad-view__team-pr-count {
  color: #6c7086;
  font-size: 11px;
}

.launchpad-view__team-chevron {
  margin-left: auto;
  color: #6c7086;
  font-size: 11px;
}

.launchpad-view__team-prs {
  padding: 0 10px 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.launchpad-view__team-pr-row {
  display: flex;
  align-items: flex-start;
  flex-wrap: wrap;
  gap: 4px;
  padding: 4px 8px;
  background: rgba(0, 0, 0, 0.2);
  border-radius: 4px;
  font-size: 12px;
}

.launchpad-view__overlap-badge {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: #f38ba8;
  margin-top: 2px;
  flex-basis: 100%;
}
```

- [ ] **Step 7: Run the full test suite**

```bash
cd apps/desktop && pnpm test --run 2>&1 | tail -10
```
Expected: 71+ tests, 0 failures.

- [ ] **Step 8: Type-check**

```bash
cd /Users/laurent/Documents/GitHub/GitWand && pnpm --filter @gitwand/core build 2>&1 | tail -5
cd apps/desktop && pnpm exec vue-tsc --noEmit 2>&1 | head -20
```
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add apps/desktop/src/components/LaunchpadView.vue
git commit -m "feat(launchpad): add Vue Équipe tab — team activity + overlap detection"
```

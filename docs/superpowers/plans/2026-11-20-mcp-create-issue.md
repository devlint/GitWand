# MCP `gitwand_create_issue` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An MCP tool that previews (by default) or files a GitHub issue on the repository's `origin` or its fork parent, through `gh`, after a secrets scan.

**Architecture:** `scanReportBody` moves into `@gitwand/core` so desktop and MCP share it. A new `packages/mcp/src/tools/create_issue.ts` holds the tool definition, the origin-URL parser, target resolution (`gh api repos/…`) and creation (`gh issue create`), all spawned with `execFileSync`, array args and an env allow-list. `tools/index.ts` registers and dispatches it.

**Tech Stack:** TypeScript, Node 22, vitest, `gh` CLI.

**Spec:** `docs/superpowers/specs/2026-11-20-mcp-create-issue-design.md`

## Global Constraints

- `packages/core` stays browser-safe: no Node module in the moved scan code.
- `dry_run` defaults to **true**; only `dry_run === false` creates.
- Title trimmed, 1–256 characters; body ≤ 65,536 characters; no comma in a label or assignee.
- `blockAt: "medium"` always; scan always on; `.gitwandrc` `secrets.patterns`, `secrets.ignore`, `secrets.entropyThreshold` (default 4.0) apply.
- `gh` spawned with `execFileSync`, array args, timeout 30 000 ms, env allow-list + `GH_PROMPT_DISABLED=1`, `GH_NO_UPDATE_NOTIFIER=1`, `NO_COLOR=1`; never `GH_HOST`/`GH_REPO`.
- Errors: `{ content:[{type:"text", text: JSON.stringify({ error, message })}], isError: true }`, never a bare throw.
- Tests: real temp git repo; fake `gh` on `PATH`.

## Review Focus

1. A `gh api` answer for a fork whose parent JSON lacks `has_issues` → parent treated as without issues, not a crash (Task 2 test `parent without has_issues`).
2. Origin URL forms: `https://host/o/r.git`, `https://user@host/o/r`, `git@host:o/r.git`, `ssh://git@host:22/o/r.git`, trailing slash → same `{host, owner, repo}`; anything else → `null` (Task 2 parser tests).
3. A secret only in the title blocks (Task 3 test `title secret blocks`).
4. `gh` exits non-zero on create (unknown label) → `create_failed` with gh's stderr, no partial success (Task 3 test).
5. A GitHub Enterprise origin → `gh api --hostname host` and `--repo host/o/r` (Task 2/3 tests assert argv).

---

### Task 1: Move `scanReportBody` to core

**Files:**
- Create: `packages/core/src/secrets/report.ts` (body of `apps/desktop/src/utils/reportGuard.ts`, unchanged, importing `scanSecrets` and types locally)
- Modify: `packages/core/src/index.ts` (export `scanReportBody`, type `ReportScan`)
- Modify: `apps/desktop/src/utils/reportGuard.ts` → `export { scanReportBody, type ReportScan } from "@gitwand/core";` with its header comment kept
- Move test: `apps/desktop/src/utils/__tests__/reportGuard.test.ts` → `packages/core/src/__tests__/secrets/report.test.ts` (import from `../../secrets/report.js`); keep a one-test smoke file in desktop asserting the re-export is the core function.

**Interfaces:**
- Produces: `scanReportBody(body: string, opts: { extraPatterns: SecretPattern[]; entropyThreshold: number; blockAt: "medium" | "never"; ignore?: string[] }): ReportScan` from `@gitwand/core`.

- [ ] Step 1: move the test file to core; run `pnpm --filter @gitwand/core exec vitest run src/__tests__/secrets/report.test.ts` → FAIL (module not found).
- [ ] Step 2: create `report.ts`, export from index; rerun → PASS.
- [ ] Step 3: desktop re-export + smoke test `reportGuard re-exports core's scanReportBody` (`expect(scanReportBody).toBe(core.scanReportBody)`); `pnpm --filter @gitwand/core build` then `cd apps/desktop && pnpm vitest run src/utils src/composables/__tests__/useCreateIssue-report-scan.test.ts` → PASS.
- [ ] Step 4: commit `refactor(core): share the report secrets scan (#301)`.

### Task 2: Origin parsing and issue targets

**Files:**
- Create: `packages/mcp/src/tools/create_issue.ts`
- Test: `packages/mcp/src/__tests__/create-issue.test.ts` (+ helper `packages/mcp/src/__tests__/fake-gh.ts`)

**Interfaces:**
- Produces:
  - `parseRemoteUrl(url: string): { host: string; owner: string; repo: string } | null`
  - `interface IssueTarget { repo: string; hasIssues: boolean; isOrigin: boolean }`
  - `targetsFrom(json: unknown): IssueTarget[]` (origin, then `parent` when `fork === true`; `hasIssues = has_issues === true && archived !== true`)
  - `ghEnv(): NodeJS.ProcessEnv`
  - `runGh(args: string[], cwd: string, input?: string): { ok: true; stdout: string } | { ok: false; missing: boolean; stderr: string }`
- Fake gh (`fake-gh.ts`): `installFakeGh(dir, answers: { api?: {stdout?:string; code?:number; stderr?:string}; create?: {...} })` writes an executable `gh` (sh script) that appends `argv` (one JSON line) and stdin to `calls.log` in its dir and answers by first arg (`api` / `issue`); tests prepend its dir to `process.env.PATH` and restore it after.

- [ ] Step 1: tests — `parseRemoteUrl` on the five forms of Review Focus 2 plus `"/local/path"` → null; `targetsFrom` on origin-only, fork with parent with issues, fork with archived parent, parent without `has_issues` (Review Focus 1); `ghEnv` keeps `GH_TOKEN`, drops `AWS_SECRET_ACCESS_KEY` and `GH_REPO`, sets `GH_PROMPT_DISABLED=1`. Run `pnpm --filter @gitwand/mcp test` → FAIL.
- [ ] Step 2: implement. Env allow-list: `PATH HOME USER LOGNAME USERPROFILE HOMEDRIVE HOMEPATH APPDATA LOCALAPPDATA SystemRoot windir TMPDIR TEMP TMP LANG LC_ALL XDG_CONFIG_HOME XDG_STATE_HOME XDG_DATA_HOME XDG_CACHE_HOME GH_CONFIG_DIR GH_TOKEN GITHUB_TOKEN GH_ENTERPRISE_TOKEN GITHUB_ENTERPRISE_TOKEN HTTPS_PROXY HTTP_PROXY NO_PROXY https_proxy http_proxy no_proxy SSL_CERT_FILE SSL_CERT_DIR`. Run → PASS.
- [ ] Step 3: commit `feat(mcp): issue target helpers for gitwand_create_issue (#301)`.

### Task 3: The tool

**Files:**
- Modify: `packages/mcp/src/tools/create_issue.ts` (add `createIssueToolDefinition`, `handleCreateIssue(cwd: string, args: Record<string, unknown>)`)
- Modify: `packages/mcp/src/tools/index.ts` (header list, `registerTools`, `handleToolCall` case)
- Test: `packages/mcp/src/__tests__/create-issue.test.ts`

**Interfaces:**
- Consumes: Task 1 `scanReportBody`; Task 2 helpers; `parseGitwandrc` from `@gitwand/core` for secrets config (as `packages/cli/src/commands/scan.ts` `loadSecretsConfig`).
- Produces: output shapes and error codes of the spec: `not_a_repo`, `no_origin`, `unsupported_remote`, `gh_missing`, `target_lookup_failed`, `no_issue_target`, `repo_not_allowed`, `issues_disabled`, `invalid_title`, `invalid_body`, `invalid_list`, `secrets_found`, `create_failed`.

Order of checks: arguments → origin → `gh api` → target → secrets → (preview | create). Title scanned as line 0: scan `title + "\n" + body`, report lines minus 1 so body lines keep their numbers and the title is line 0.

- [ ] Step 1: tests through `handleToolCall('gitwand_create_issue', …, cwd)` on a temp repo with `origin` = `https://github.com/me/proj.git`:
  - preview by default: `dryRun: true`, `repo: "me/proj"`, `canCreate: true`, and `calls.log` has no `issue create`;
  - `dry_run: false` creates: argv `["issue","create","--repo","github.com/me/proj","--title","T","--body-file","-","--label","bug"]`, stdin = body, result `{ created: true, number: 12, url }` from stdout `https://github.com/me/proj/issues/12\n`;
  - fork with issues off → default target is the parent;
  - `repo` not a target → `repo_not_allowed`; target without issues → `issues_disabled`;
  - `title secret blocks` (a `ghp_` token in the title) → preview `canCreate: false`, and `dry_run:false` → `secrets_found` with no create call;
  - body of 65,537 chars → `invalid_body`; empty title → `invalid_title`; label `"a,b"` → `invalid_list`;
  - no origin → `no_origin`; gh missing (PATH without fake) → `gh_missing`;
  - create exits 1 with stderr `could not add label` → `create_failed` containing it;
  - GHE origin `git@ghe.corp:me/proj.git` → api argv includes `--hostname ghe.corp`, create `--repo ghe.corp/me/proj`.
  Run → FAIL.
- [ ] Step 2: implement; description text must say: previews by default, show the preview to the user and call again with `dry_run: false` only after they agree; target rule; secrets refusal. Run `pnpm --filter @gitwand/mcp test` and `pnpm --filter @gitwand/mcp build` → PASS.
- [ ] Step 3: commit `feat(mcp): gitwand_create_issue tool (#301)`.

### Task 4: Docs

**Files:** `packages/mcp/CLAUDE.md`, `packages/mcp/README.md`, `README.md` (MCP tools table), `website/guide/mcp.md` (new section), `website/public/.well-known/mcp/server-card.json` (tool entry), `CHANGELOG.md` `[Unreleased]` → Added.

- [ ] Step 1: write them; `node -e "JSON.parse(require('fs').readFileSync('website/public/.well-known/mcp/server-card.json'))"` → no error.
- [ ] Step 2: commit `docs(mcp): document gitwand_create_issue (#301)`.

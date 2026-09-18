# Command-route registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every Tauri command the frontend invokes declare either its dev-server route or why it has none, and make a test fail when that stops being true.

**Architecture:** A data file (`commandRegistry.ts`) holds one entry per invoked command. A vitest guard parses `backend.ts`, `backend-core.ts` and `dev-server.mjs` as text and cross-checks them against that file. The parse is specified rather than left to the implementer, because a naive regex was measured to under-count invocations by 18.

**Tech Stack:** TypeScript, Vitest (node environment — this test reads files, it does not touch the DOM), Node `fs`.

**Spec:** `docs/superpowers/specs/2026-09-18-command-route-registry-design.md`

## Global Constraints

- **Package manager is pnpm only.** Never `npm`, never `yarn`.
- **`packages/core` stays browser-compatible.** Nothing in this plan touches it; the registry and its guard live in `apps/desktop`.
- **Vitest environment is `node` by default.** The guard reads files with `fs` and must NOT add `// @vitest-environment jsdom` — it never imports `backend.ts`, it reads it as text. Importing it would pull in `window` and force jsdom for no reason.
- **Never edit version fields by hand.** Nothing here touches them.
- **Type-check needs core built:** run `pnpm --filter @gitwand/core build` once before `vue-tsc`, or dozens of `Cannot find module '@gitwand/core'` bury the real errors.
- **Test commands:** whole desktop suite `pnpm --filter @gitwand/desktop test`; one file `pnpm --filter @gitwand/desktop exec vitest run <path>`.
- **Measured facts this plan relies on** (taken on `main` at `f33f9f1`): 139 commands invoked by the frontend, 169 dev-server routes, all 171 route declarations of the form `url.pathname === "/api/…"`.

---

### Task 1: The parser, and the proof it does not under-count

The guard is only worth having if it finds every invocation. A regex over the type parameter does not: `tauriInvoke<?[^>]*>?\(\s*"(\w+)"` misses `tauriInvoke<Array<{ hash_full: string; … }>>("git_log", …)` and 17 others. This task builds the parser and pins that exact failure so nobody reintroduces it.

**Files:**
- Create: `apps/desktop/src/utils/__tests__/commandRegistry-parse.test.ts`
- Create: `apps/desktop/src/utils/commandRegistryParse.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `findInvokedCommands(source: string): { commands: string[]; dynamic: string[] }` — `commands` are the string-literal command names, sorted and deduplicated; `dynamic` holds a one-line excerpt for each `tauriInvoke` call whose first argument is not a string literal.
  - `findDevServerRoutes(source: string): string[]` — route paths including the `/api/` prefix, sorted and deduplicated.

  Task 2 and Task 3 both consume these.

- [ ] **Step 1: Write the failing test**

```typescript
/**
 * The parser behind the command-route guard.
 *
 * It exists as its own unit because the guard is worthless if it under-counts:
 * a guard that misses an invocation passes while the audit it claims to
 * perform is incomplete. The nested-generic case below is not hypothetical —
 * it is how `git_status`, `git_diff`, `git_log` and `git_blame` escaped the
 * first measurement (design §1).
 */
import { describe, it, expect } from "vitest";

import {
  findInvokedCommands,
  findDevServerRoutes,
} from "../commandRegistryParse";

describe("findInvokedCommands", () => {
  it("finds a plain invocation", () => {
    const src = `await tauriInvoke("git_status", { cwd });`;
    expect(findInvokedCommands(src).commands).toEqual(["git_status"]);
  });

  it("finds one behind a simple type parameter", () => {
    const src = `return tauriInvoke<string>("git_show", { cwd });`;
    expect(findInvokedCommands(src).commands).toEqual(["git_show"]);
  });

  it("finds one behind a nested generic", () => {
    // The regression that motivated this parser.
    const src = `return tauriInvoke<Array<{ hash_full: string; hash: string }>>("git_log", { cwd });`;
    expect(findInvokedCommands(src).commands).toEqual(["git_log"]);
  });

  it("ignores the declaration of tauriInvoke itself", () => {
    const src = `export async function tauriInvoke<T>(cmd: string, args?: X): Promise<T> {}`;
    expect(findInvokedCommands(src).commands).toEqual([]);
    expect(findInvokedCommands(src).dynamic).toEqual([]);
  });

  it("ignores a mention inside a comment", () => {
    // backend-core.ts really contains this line.
    const src = ` * Timeout presets for tauriInvoke.`;
    expect(findInvokedCommands(src).commands).toEqual([]);
    expect(findInvokedCommands(src).dynamic).toEqual([]);
  });

  it("ignores an import", () => {
    const src = `import { isTauri, tauriInvoke, devFetch } from './backend-core';`;
    expect(findInvokedCommands(src).commands).toEqual([]);
    expect(findInvokedCommands(src).dynamic).toEqual([]);
  });

  it("reports an invocation whose name is not a string literal", () => {
    const src = `await tauriInvoke(commandName, { cwd });`;
    const res = findInvokedCommands(src);
    expect(res.commands).toEqual([]);
    expect(res.dynamic).toHaveLength(1);
    expect(res.dynamic[0]).toContain("commandName");
  });

  it("deduplicates and sorts", () => {
    const src = `tauriInvoke("git_status", {}); tauriInvoke("git_blame", {}); tauriInvoke("git_status", {});`;
    expect(findInvokedCommands(src).commands).toEqual(["git_blame", "git_status"]);
  });
});

describe("findDevServerRoutes", () => {
  it("finds a route declaration", () => {
    const src = `if (url.pathname === "/api/git-status" && req.method === "GET") {`;
    expect(findDevServerRoutes(src)).toEqual(["/api/git-status"]);
  });

  it("deduplicates a route declared for two methods", () => {
    const src = `url.pathname === "/api/git-stash"\nurl.pathname === "/api/git-stash"`;
    expect(findDevServerRoutes(src)).toEqual(["/api/git-stash"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @gitwand/desktop exec vitest run src/utils/__tests__/commandRegistry-parse.test.ts
```

Expected: FAIL — `Cannot find module '../commandRegistryParse'`.

- [ ] **Step 3: Write the implementation**

Create `apps/desktop/src/utils/commandRegistryParse.ts`:

```typescript
/**
 * Text parsing for the command-route guard.
 *
 * Deliberately not a regex over the whole call: a type parameter can contain
 * a nested generic (`tauriInvoke<Array<{ a: string }>>("git_log", …)`), and
 * `[^>]*` stops at the first `>`. That mistake cost 18 undetected commands in
 * the first measurement (design §1), so the scan walks from the identifier to
 * its opening parenthesis instead of trying to match the whole call.
 */

/**
 * Is this `tauriInvoke` occurrence something other than a call we can read?
 *
 * Judged on the **current line only**. Looking at a window of preceding
 * characters does not work: with 200 characters, the `export async function …`
 * that encloses a call matches the import/export test, and 119 of 139 real
 * invocations get rejected. The floor assertion in Step 5 is what catches
 * this, so do not widen the window to "be safe".
 */
function isNonCall(linePrefix: string): boolean {
  const trimmed = linePrefix.trimStart();
  return (
    // Its own declaration: `export async function tauriInvoke<T>(…)`.
    /\bfunction\s+$/.test(linePrefix) ||
    // A named import or re-export list that happens to contain the identifier.
    /^\s*(import|export)\b/.test(linePrefix) ||
    // Prose in a comment: ` * Timeout presets for tauriInvoke.`
    trimmed.startsWith("//") ||
    trimmed.startsWith("*") ||
    trimmed.startsWith("/*")
  );
}

export function findInvokedCommands(source: string): {
  commands: string[];
  dynamic: string[];
} {
  const commands = new Set<string>();
  const dynamic: string[] = [];
  let i = -1;
  while ((i = source.indexOf("tauriInvoke", i + 1)) !== -1) {
    const lineStart = source.lastIndexOf("\n", i) + 1;
    if (isNonCall(source.slice(lineStart, i))) continue;
    const paren = source.indexOf("(", i);
    if (paren === -1) continue;
    const after = source.slice(paren + 1).replace(/^\s+/, "");
    const literal = after.match(/^"([a-z0-9_]+)"/);
    if (literal) {
      commands.add(literal[1]!);
    } else {
      dynamic.push(source.slice(i, i + 80).split("\n")[0]!);
    }
  }
  return { commands: [...commands].sort(), dynamic };
}

export function findDevServerRoutes(source: string): string[] {
  const routes = new Set<string>();
  for (const m of source.matchAll(/url\.pathname === "(\/api\/[a-z0-9-]+)"/g)) {
    routes.add(m[1]!);
  }
  return [...routes].sort();
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm --filter @gitwand/desktop exec vitest run src/utils/__tests__/commandRegistry-parse.test.ts
```

Expected: 10 passed.

- [ ] **Step 5: Pin the parser against the real files**

The unit tests above prove the parser on snippets. They cannot prove it does
not under-count the real thing — which is exactly the failure that happened.
`tsx` is not installed in this workspace, so this is an assertion in the same
test file rather than a script. Append to
`src/utils/__tests__/commandRegistry-parse.test.ts`:

```typescript
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("the parser against the real sources", () => {
  const root = resolve(__dirname, "../../..");
  const read = (p: string) => readFileSync(resolve(root, p), "utf-8");

  it("finds at least as many invocations as the design measured", () => {
    // A floor, not an equality: commands get added, and this test should not
    // fail for that. What it catches is the parser regressing — the first
    // measurement said 122 because a regex stopped at the first `>`, and a
    // guard that under-counts passes while auditing nothing (design §1).
    const src = read("src/utils/backend.ts") + "\n" + read("src/utils/backend-core.ts");
    const { commands, dynamic } = findInvokedCommands(src);
    expect(commands.length).toBeGreaterThanOrEqual(139);
    expect(dynamic).toEqual([]);
  });

  it("finds at least as many routes as the design measured", () => {
    expect(findDevServerRoutes(read("dev-server.mjs")).length).toBeGreaterThanOrEqual(169);
  });
});
```

Run it:

```bash
pnpm --filter @gitwand/desktop exec vitest run src/utils/__tests__/commandRegistry-parse.test.ts
```

Expected: 12 passed. If the invocation count comes out **below** 139, the
parser is wrong — stop and report which commands it stopped seeing, rather than
lowering the floor.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/utils/commandRegistryParse.ts apps/desktop/src/utils/__tests__/commandRegistry-parse.test.ts
git commit -m "feat(desktop): a parser for the command-route guard that does not under-count"
```

---

### Task 2: The registry table

**Files:**
- Create: `apps/desktop/src/utils/commandRegistry.ts`

**Interfaces:**
- Consumes: `findInvokedCommands`, `findDevServerRoutes` (Task 1) — used by the throwaway seeding script, not by the table itself.
- Produces:
  - `export interface CommandRegistryEntry { route?: string; desktopOnly?: string; cliPathOnly?: string }`
  - `export const COMMAND_REGISTRY: Record<string, CommandRegistryEntry>` — 139 entries.

  Task 3 asserts against both.

**Context.** The table is data, not logic: no test drives its contents directly, because "is this entry right?" is a question about the repository, not about code. Task 3's guard is what proves it correct.

- [ ] **Step 1: Write the file header and types**

Create `apps/desktop/src/utils/commandRegistry.ts`:

```typescript
/**
 * Which dev-server route stands in for each Tauri command the frontend calls —
 * or why none does.
 *
 * `pnpm dev:web` runs `dev-server.mjs`, not the Rust backend. A command whose
 * route is missing or differs makes manual QA test something other than what
 * ships: that is how `gl_merge_mr`'s broken `glab` flag survived, and how
 * `read_file` disagreed with Rust on non-UTF-8 input while agreeing on
 * everything else (design §1).
 *
 * There is no rule mapping a command name to a route name — `get_conflicted_files`
 * is served by `/api/conflicted-files`, `git_add_to_gitignore` by
 * `/api/git-gitignore` — so the correspondence is declared here rather than
 * inferred, and `commandRegistry.test.ts` fails when this file stops matching
 * reality.
 */

export interface CommandRegistryEntry {
  /** The dev-server route that stands in for this command, e.g. "/api/git-merge". */
  route?: string;
  /**
   * Why this command has no route, in prose. Mandatory when `route` is absent:
   * an entry that says "desktop only" without saying why is worth no more than
   * a missing route, because the next reader still cannot tell a deliberate
   * choice from an oversight.
   */
  desktopOnly?: string;
  /**
   * The route exists but implements only one of the command's two paths — in
   * practice, the dev-server shells out to a CLI where the Rust command uses a
   * REST API once a token is configured. Documentation, not behaviour: the
   * route keeps answering exactly as it does today (design §6).
   */
  cliPathOnly?: string;
}

export const COMMAND_REGISTRY: Record<string, CommandRegistryEntry> = {
  // filled in by Step 2
};
```

- [ ] **Step 2: Seed the table**

Write a throwaway script (do **not** commit it) that pairs each invoked command with a route of the same name, transformed `_` → `-`:

```bash
cd /Users/laurent/Projects/GitWand && node -e '
const fs = require("fs");
const src = fs.readFileSync("apps/desktop/src/utils/backend.ts","utf8") + fs.readFileSync("apps/desktop/src/utils/backend-core.ts","utf8");
const cmds = new Set(); let i = -1;
while ((i = src.indexOf("tauriInvoke", i + 1)) !== -1) {
  const before = src.slice(Math.max(0, i-200), i);
  if (/function\s+$|\bimport\b[^;]*$|\bexport\b[^;]*$|(^|\n)\s*(\/\/|\*)[^\n]*$/.test(before)) continue;
  const p = src.indexOf("(", i); if (p === -1) continue;
  const lit = src.slice(p+1).replace(/^\s+/,"").match(/^"([a-z0-9_]+)"/);
  if (lit) cmds.add(lit[1]);
}
const dev = fs.readFileSync("apps/desktop/dev-server.mjs","utf8");
const routes = new Set([...dev.matchAll(/url\.pathname === "(\/api\/[a-z0-9-]+)"/g)].map(m=>m[1]));
const paired = [], unpaired = [];
for (const c of [...cmds].sort()) {
  const guess = "/api/" + c.replace(/_/g, "-");
  if (routes.has(guess)) paired.push(`  ${c}: { route: "${guess}" },`);
  else unpaired.push(c);
}
console.log(paired.join("\n"));
console.log("\n// UNPAIRED — resolve each by hand:");
unpaired.forEach(c => console.log("//   " + c));
'
```

Paste the paired lines into `COMMAND_REGISTRY`.

- [ ] **Step 3: Resolve every unpaired command by hand**

This is the audit the lot is named after. For each unpaired command, in order:

1. **Search the dev-server for a route under a different name.** Known cases that the script will not pair: `get_conflicted_files` → `/api/conflicted-files`, `get_tree_conflicts` → `/api/tree-conflicts`, `git_add_to_gitignore` → `/api/git-gitignore`, `watch_repo_start` → `/api/watch-repo`, `gh_issue_set_state` → `/api/gh-issue-state`. Search with:

   ```bash
   grep -o '"/api/[a-z0-9-]*"' apps/desktop/dev-server.mjs | sort -u | grep <a distinctive word from the command name>
   ```

   Found → `{ route: "/api/…" }`.

2. **No route: decide whether that is deliberate.** A command is legitimately `desktopOnly` when a Node process cannot do what it does — the OS keychain, an Entra device flow, MCP client configs on disk, spawning a terminal. Write the reason as a sentence naming the obstacle. Known examples:

   ```typescript
   az_merge_pr: { desktopOnly: "Azure sign-in is an Entra device flow held in the OS keychain; a Node dev-server process cannot reach it." },
   shell_exec: { desktopOnly: "Spawns the user's terminal emulator, which only the packaged app has a window to attach to." },
   ```

3. **No route and not deliberate → that is a finding.** Do not invent a `desktopOnly` reason to make the guard pass. Record it as `desktopOnly` with the reason `"GAP: no dev-server route, and no reason it could not have one."` and list it in the PR description. `gl_merge_mr` and `bb_merge_pr` are expected to land here: the design cites `gl_merge_mr` as the likely reason a broken `glab` flag went unnoticed.

4. **Mark the forge commands that only implement the CLI path.** Every `gh_*`, `gl_*` and `gitea_*` command that has a route gets `cliPathOnly` with the reason: `"The dev-server always shells out to the CLI; the Rust command uses the REST API whenever a token is configured."`

- [ ] **Step 4: Type-check**

```bash
pnpm --filter @gitwand/core build
pnpm --filter @gitwand/desktop exec vue-tsc --noEmit -p tsconfig.json
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/utils/commandRegistry.ts
git commit -m "feat(desktop): declare the Tauri command to dev-server route correspondence"
```

---

### Task 3: The guard

**Files:**
- Create: `apps/desktop/src/utils/__tests__/commandRegistry.test.ts`

**Interfaces:**
- Consumes: `findInvokedCommands`, `findDevServerRoutes` (Task 1); `COMMAND_REGISTRY`, `CommandRegistryEntry` (Task 2).
- Produces: nothing importable. It is the invariant.

**Context.** Each assertion below states, in its failure message, what the reader should *do* — a guard whose failure sends someone hunting is a guard people delete.

- [ ] **Step 1: Write the test**

```typescript
/**
 * The invariant: every Tauri command the frontend invokes declares either its
 * dev-server route or why it has none.
 *
 * This is not a unit test of anything — it is the thing that keeps
 * `commandRegistry.ts` true as commands are added. See
 * docs/superpowers/specs/2026-09-18-command-route-registry-design.md §4.
 *
 * Environment: `node`. This file reads sources with `fs` and never imports
 * `backend.ts`, which would pull in `window` and force jsdom for no reason.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { COMMAND_REGISTRY } from "../commandRegistry";
import {
  findInvokedCommands,
  findDevServerRoutes,
} from "../commandRegistryParse";

const root = resolve(__dirname, "../../..");
const read = (p: string) => readFileSync(resolve(root, p), "utf-8");

const frontendSource =
  read("src/utils/backend.ts") + "\n" + read("src/utils/backend-core.ts");
const { commands: invoked, dynamic } = findInvokedCommands(frontendSource);
const routes = new Set(findDevServerRoutes(read("dev-server.mjs")));

describe("command registry", () => {
  it("has an entry for every command the frontend invokes", () => {
    const missing = invoked.filter((c) => !(c in COMMAND_REGISTRY));
    expect(
      missing,
      `These commands are invoked but absent from commandRegistry.ts. Add an ` +
        `entry naming the dev-server route, or saying why the command cannot ` +
        `have one: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("declares exactly one of route or desktopOnly for every entry", () => {
    const bad = Object.entries(COMMAND_REGISTRY)
      .filter(([, e]) => Boolean(e.route) === Boolean(e.desktopOnly))
      .map(([c]) => c);
    expect(
      bad,
      `An entry names a route or explains why it has none — never both, never ` +
        `neither: ${bad.join(", ")}`,
    ).toEqual([]);
  });

  it("gives a real reason wherever it claims desktop-only or CLI-only", () => {
    // A one-word reason is the same as no reason: the next reader still cannot
    // tell a deliberate choice from an oversight.
    const thin = Object.entries(COMMAND_REGISTRY)
      .filter(([, e]) => {
        const reason = e.desktopOnly ?? e.cliPathOnly;
        return reason !== undefined && reason.trim().split(/\s+/).length < 5;
      })
      .map(([c]) => c);
    expect(thin, `Reason too short to be useful: ${thin.join(", ")}`).toEqual([]);
  });

  it("names only routes the dev-server actually serves", () => {
    const phantom = Object.entries(COMMAND_REGISTRY)
      .filter(([, e]) => e.route && !routes.has(e.route))
      .map(([c, e]) => `${c} → ${e.route}`);
    expect(
      phantom,
      `These entries name a route dev-server.mjs does not declare. Either the ` +
        `route was renamed, or the entry was written from a guess: ${phantom.join(", ")}`,
    ).toEqual([]);
  });

  it("has no entry for a command nothing invokes any more", () => {
    const invokedSet = new Set(invoked);
    const stale = Object.keys(COMMAND_REGISTRY).filter((c) => !invokedSet.has(c));
    expect(
      stale,
      `These entries describe commands the frontend no longer invokes. Delete ` +
        `them — a registry that keeps stale rows stops being readable as the ` +
        `list of what the app calls: ${stale.join(", ")}`,
    ).toEqual([]);
  });

  it("refuses an invocation whose command name is not a string literal", () => {
    expect(
      dynamic,
      `tauriInvoke was called with a non-literal command name. The registry ` +
        `cannot see such a call, so the audit would be wrong rather than ` +
        `merely incomplete. Use a literal: ${dynamic.join(" | ")}`,
    ).toEqual([]);
  });

  it("cliPathOnly is only ever set on an entry that has a route", () => {
    const bad = Object.entries(COMMAND_REGISTRY)
      .filter(([, e]) => e.cliPathOnly && !e.route)
      .map(([c]) => c);
    expect(
      bad,
      `cliPathOnly qualifies how an existing route behaves; without a route ` +
        `it says nothing: ${bad.join(", ")}`,
    ).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test**

```bash
pnpm --filter @gitwand/desktop exec vitest run src/utils/__tests__/commandRegistry.test.ts
```

Expected: 7 passed. A failure here is a real finding about the registry written in Task 2 — fix the registry, not the test. The one exception: if "has an entry for every command" fails with commands you have never seen, re-run Task 1 Step 5 first; the parser and the table must agree on what "invoked" means.

- [ ] **Step 3: Run the whole desktop suite**

```bash
pnpm --filter @gitwand/desktop test
```

Expected: all green, with 17 more tests than before (10 from Task 1, 7 here).

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/utils/__tests__/commandRegistry.test.ts
git commit -m "test(desktop): fail when a command has no declared dev-server route"
```

---

### Task 4: Write down the rule the guard enforces

A guard nobody expects is a guard that gets deleted the first time it fails. The contributor-facing docs must say the rule before someone meets it as a red test.

**Files:**
- Modify: `AGENTS.md` (§ IPC — Tauri Commands)
- Modify: `apps/desktop/CLAUDE.md` (§ Architecture IPC)

**Interfaces:**
- Consumes: the guard from Task 3.
- Produces: nothing. This is the last task.

- [ ] **Step 1: Extend the IPC rule in `AGENTS.md`**

`AGENTS.md` currently ends its IPC section with "When adding a new `#[tauri::command]` in Rust, add its typed wrapper in `backend.ts` in the same PR. Never call `invoke()` directly from a component or composable — always go through `backend.ts`." Append:

```markdown
A command the frontend invokes must also have an entry in
`apps/desktop/src/utils/commandRegistry.ts`, naming either its dev-server route
or the reason it cannot have one. `commandRegistry.test.ts` fails otherwise.

This is not bookkeeping: `pnpm dev:web` runs `dev-server.mjs`, not the Rust
backend, so a command with no route means manual QA silently tests something
other than what ships. A broken `glab` flag survived in `gl_merge_mr` for
exactly that reason.

Invoke with a string literal — `tauriInvoke("git_status", …)`. A name built at
runtime is invisible to the registry, and the guard refuses it.
```

- [ ] **Step 2: Cross-reference from `apps/desktop/CLAUDE.md`**

In the "Architecture IPC" section, after the sentence about adding the TS wrapper in the same PR, add:

```markdown
Et son entrée dans `src/utils/commandRegistry.ts` : route dev-server équivalente,
ou raison documentée de son absence. `commandRegistry.test.ts` échoue sinon —
voir AGENTS.md § IPC.
```

- [ ] **Step 3: Commit**

```bash
git add AGENTS.md apps/desktop/CLAUDE.md
git commit -m "docs: a frontend-invoked command declares its dev-server route"
```

---

## After the plan

- [ ] Add a line to `CHANGELOG.md` under `## [Unreleased]`, `### Changed`, describing the registry, the guard, and — with their names — any command that landed in Task 2 Step 3 case 3 as a genuine gap.
- [ ] Open the PR against `main` from `feat/command-route-registry`. List the `GAP:` entries explicitly; they are the audit's actual output and the reason the lot existed.
- [ ] Update the `ROADMAP.md` v3.11.0 entry for this lot: the registry half is done, and failure parity for the 35 write commands is the remaining half, with its own spec and plan.

Failure parity for the write commands (spec §5) is **not** in this plan. It is a separate deliverable with its own plan, sequenced after this one so its volume can be judged against a real measurement of the parity suite rather than an estimate.

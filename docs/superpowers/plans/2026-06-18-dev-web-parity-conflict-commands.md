# dev:web Parity for Conflict Commands — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make the tree-conflict and markerless-content-reconstruction features work in `pnpm dev:web` (the primary GitWand dev workflow), by adding `dev-server.mjs` routes that mirror the tested Rust commands and pointing the `backend.ts` wrappers at them.

**Architecture:** `dev-server.mjs` is a Node dev backend that shells real git. Add three routes mirroring the Rust logic exactly (`get_tree_conflicts`, `resolve_tree_conflict`, `reconstruct_conflict`), then change the three `backend.ts` wrappers' `!isTauri()` branches from stubs (`[]`/throw) to `fetch` calls against those routes. No Rust change, no `packages/core` change.

**Tech Stack:** Node (`dev-server.mjs`, `node:child_process` `spawnSync`, `node:fs`), TypeScript (`backend.ts`), pnpm.

## Global Constraints

- `dev-server.mjs` is a dev-only Node script — it may shell git (it is NOT `packages/core`). Use `spawnSync(GIT, [args], {cwd})` (args arrays, no shell-string interpolation).
- The JS route logic MUST match the Rust semantics exactly (the Rust is the tested source of truth):
  - tree-conflict filter: a path is a tree conflict iff `!(hasOurs && hasTheirs)`.
  - porcelain v2 `u` line fields after `"u "`: `XY sub m1 m2 m3 mW h1 h2 h3 path` → `hasBase=m1≠"000000"`, `hasOurs=m2≠"000000"`, `hasTheirs=m3≠"000000"` (note the `mW` worktree-mode field between m3 and h1).
  - resolve: `ours`→`git checkout --ours -- <path>`+`git add -- <path>`; `theirs`→`--theirs`+add; `delete`→`git rm -f -- <path>`.
  - reconstruct: `git show :1:/:2:/:3:<path>` (bytes), `git merge-file -p --diff3 -L ours -L base -L theirs <ours> <base> <theirs>`; only merge-file exit 255 is an error; `wtMatchesSide` = working-tree bytes byte-equal to stage-2 OR stage-3; temp files always cleaned up.
- No Rust / `packages/core` / version-file change. No `invoke()` outside `backend.ts`.
- The wrapper TS shapes are unchanged: `getTreeConflicts → TreeConflict[]` (`{path, code, hasBase, hasOurs, hasTheirs}`), `reconstructConflict → { content, wtMatchesSide }`, `resolveTreeConflict → void`.
- `dev-server.mjs` conventions: GET uses `url.searchParams.get("cwd")` + `resolve(cwd)`; POST uses `const {…} = await readBody(req)`; respond via `jsonResponse(req, res, data, status?)`; `GIT` is the git-binary constant; routes are added to the `if (...) { }` chain in the request handler (near `/api/conflicted-files`, ~line 693).

---

### Task 1: dev-server.mjs routes (tree-conflicts, resolve, reconstruct)

**Files:**
- Modify: `apps/desktop/dev-server.mjs` (add 3 routes near `/api/conflicted-files`, ~line 693; add `node:fs`/`node:os` imports if needed)

**Interfaces:**
- Produces HTTP routes:
  - `GET /api/tree-conflicts?cwd=` → `{ cwd, conflicts: Array<{path,code,hasBase,hasOurs,hasTheirs}> }`
  - `POST /api/resolve-tree-conflict` `{cwd, path, choice}` → `{ ok: true }`
  - `POST /api/reconstruct-conflict` `{cwd, path}` → `{ content, wtMatchesSide }`

- [ ] **Step 1: Add the three routes**

In `dev-server.mjs`, inside the request-handler `try { ... }` chain (alongside `/api/conflicted-files`), add. (Confirm `spawnSync`/`execFileSync` and `GIT` are already imported/defined at the top — they are; add `readFileSync`, `writeFileSync`, `mkdtempSync`, `rmSync` from `node:fs` and `tmpdir` from `node:os` to the existing imports if not already present.)

```js
    // GET /api/tree-conflicts?cwd=/path/to/repo  — mirrors Rust collect_tree_conflicts
    if (url.pathname === "/api/tree-conflicts" && req.method === "GET") {
      const cwd = url.searchParams.get("cwd");
      if (!cwd) return jsonResponse(req, res, { error: "Missing cwd param" }, 400);
      const resolvedCwd = resolve(cwd);
      const out = spawnSync(GIT, ["status", "--porcelain=v2", "--untracked-files=no"], {
        cwd: resolvedCwd, encoding: "utf-8",
      });
      if (out.status !== 0) return jsonResponse(req, res, { cwd: resolvedCwd, conflicts: [] });
      const conflicts = [];
      for (const line of (out.stdout || "").split("\n")) {
        if (!line.startsWith("u ")) continue;
        const rest = line.slice(2);
        // u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
        const parts = rest.split(" ");
        if (parts.length < 10) continue;
        const code = parts[0];
        const m1 = parts[2], m2 = parts[3], m3 = parts[4];
        const path = parts.slice(9).join(" ");
        if (!path) continue;
        const hasBase = m1 !== "000000";
        const hasOurs = m2 !== "000000";
        const hasTheirs = m3 !== "000000";
        if (hasOurs && hasTheirs) continue; // content conflict (UU/AA) — not a tree conflict
        conflicts.push({ path, code, hasBase, hasOurs, hasTheirs });
      }
      return jsonResponse(req, res, { cwd: resolvedCwd, conflicts });
    }

    // POST /api/resolve-tree-conflict {cwd, path, choice}  — mirrors Rust resolve_tree_conflict
    if (url.pathname === "/api/resolve-tree-conflict" && req.method === "POST") {
      const { cwd, path, choice } = await readBody(req);
      if (!cwd || !path) return jsonResponse(req, res, { error: "Missing cwd or path" }, 400);
      const resolvedCwd = resolve(cwd);
      const run = (args) => {
        const r = spawnSync(GIT, args, { cwd: resolvedCwd, encoding: "utf-8" });
        if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr || ""}`);
      };
      try {
        if (choice === "ours") { run(["checkout", "--ours", "--", path]); run(["add", "--", path]); }
        else if (choice === "theirs") { run(["checkout", "--theirs", "--", path]); run(["add", "--", path]); }
        else if (choice === "delete") { run(["rm", "-f", "--", path]); }
        else return jsonResponse(req, res, { error: `unknown choice: ${choice}` }, 400);
      } catch (e) {
        return jsonResponse(req, res, { error: String(e.message || e) }, 500);
      }
      return jsonResponse(req, res, { ok: true });
    }

    // POST /api/reconstruct-conflict {cwd, path}  — mirrors Rust reconstruct_conflict
    if (url.pathname === "/api/reconstruct-conflict" && req.method === "POST") {
      const { cwd, path } = await readBody(req);
      if (!cwd || !path) return jsonResponse(req, res, { error: "Missing cwd or path" }, 400);
      const resolvedCwd = resolve(cwd);
      const blob = (stage) => {
        const r = spawnSync(GIT, ["show", `:${stage}:${path}`], { cwd: resolvedCwd, encoding: "buffer" });
        return r.status === 0 ? r.stdout : Buffer.alloc(0);
      };
      const base = blob(1), ours = blob(2), theirs = blob(3);
      if (ours.length === 0 && theirs.length === 0) {
        return jsonResponse(req, res, { error: `no index stages for ${path}` }, 404);
      }
      const dir = mkdtempSync(join(tmpdir(), "gitwand-recon-"));
      let content = "";
      try {
        const oursP = join(dir, "ours"), baseP = join(dir, "base"), theirsP = join(dir, "theirs");
        writeFileSync(oursP, ours); writeFileSync(baseP, base); writeFileSync(theirsP, theirs);
        const r = spawnSync(GIT, ["merge-file", "-p", "--diff3", "-L", "ours", "-L", "base", "-L", "theirs", oursP, baseP, theirsP], { cwd: resolvedCwd, encoding: "utf-8" });
        if (r.status === 255) return jsonResponse(req, res, { error: `git merge-file error: ${r.stderr || ""}` }, 500);
        content = r.stdout || "";
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
      let wt = Buffer.alloc(0);
      try { wt = readFileSync(join(resolvedCwd, path)); } catch { /* absent */ }
      const wtMatchesSide = (ours.length > 0 && Buffer.compare(wt, ours) === 0) ||
                            (theirs.length > 0 && Buffer.compare(wt, theirs) === 0);
      return jsonResponse(req, res, { content, wtMatchesSide });
    }
```

If `join`, `tmpdir`, `mkdtempSync`, `rmSync`, `readFileSync`, `writeFileSync` are not already imported, add them: `import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";` `import { tmpdir } from "node:os";` `import { join, resolve } from "node:path";` (extend existing imports; `resolve` and `join` are likely already imported — do not duplicate).

- [ ] **Step 2: Boot the dev server to confirm it parses**

Run: `cd apps/desktop && node --check dev-server.mjs && echo "syntax OK"`
Expected: `syntax OK` (no parse error).

- [ ] **Step 3: Manual route verification against a real temp repo**

Create a throwaway repo with a modify/delete conflict and a markerless content conflict, start the dev server, and curl the routes. Run this script (bash) and confirm the asserted output:

```bash
cd "$(mktemp -d)"; git init -q -b main; git config user.email t@t; git config user.name t
printf 'a\nb\nc\n' > f.txt; printf 'orig\n' > del.txt; git add -A; git commit -qm base
git checkout -qb feature; printf 'a\nFEAT\nc\n' > f.txt; printf 'feat\n' > del.txt; git add -A; git commit -qm feat
git checkout -q main; printf 'a\nMAIN\nc\n' > f.txt; git rm -q del.txt; git commit -qm main
git checkout -q feature; git merge --no-edit main || true
git checkout --ours -- f.txt   # f.txt: UU but markers removed, WT==ours; del.txt: modify/delete
REPO=$(pwd)
# (start the dev server separately: `cd apps/desktop && pnpm dev:server &` then:)
curl -s "http://localhost:<PORT>/api/tree-conflicts?cwd=$REPO"          # expect del.txt with hasOurs:true,hasTheirs:false
curl -s -X POST "http://localhost:<PORT>/api/reconstruct-conflict" -H 'content-type: application/json' -d "{\"cwd\":\"$REPO\",\"path\":\"f.txt\"}"  # expect content with <<<<<<< and wtMatchesSide:true
```
Expected: `/api/tree-conflicts` returns `del.txt` (hasOurs true, hasTheirs false, code `UD` or `DU` depending on direction); `/api/reconstruct-conflict` for `f.txt` returns `content` containing `<<<<<<<` and `wtMatchesSide: true`. (Find the dev server port from its startup log.) If you cannot run a background server in this environment, state that and rely on the `node --check` + code review; the user will verify in dev:web.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/dev-server.mjs
git commit -m "feat(desktop): dev-server routes for tree-conflict + reconstruct (dev:web parity)"
```

---

### Task 2: Point the `backend.ts` wrappers at the dev-server routes

**Files:**
- Modify: `apps/desktop/src/utils/backend.ts`

**Interfaces:**
- Consumes the Task 1 routes. Changes the `!isTauri()` branch of `getTreeConflicts`, `resolveTreeConflict`, `reconstructConflict` from stubs to `fetch` calls. Return shapes unchanged.

- [ ] **Step 1: Replace the three dev branches**

`getTreeConflicts` — replace `return [];` with a fetch:
```ts
export async function getTreeConflicts(cwd: string): Promise<TreeConflict[]> {
  if (isTauri()) {
    return tauriInvoke<TreeConflict[]>("get_tree_conflicts", { cwd });
  }
  const res = await fetch(`${DEV_SERVER}/api/tree-conflicts?cwd=${encodeURIComponent(cwd)}`);
  if (!res.ok) throw new Error(`Dev server error: ${res.status}`);
  const data = await res.json();
  return data.conflicts;
}
```

`resolveTreeConflict` — replace the `throw` with a POST:
```ts
export async function resolveTreeConflict(
  cwd: string,
  path: string,
  choice: "ours" | "theirs" | "delete",
): Promise<void> {
  if (isTauri()) {
    await tauriInvoke("resolve_tree_conflict", { cwd, path, choice });
    return;
  }
  const res = await devFetch(`${DEV_SERVER}/api/resolve-tree-conflict`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, path, choice }),
  });
  if (!res.ok) throw new Error(`Failed to resolve tree conflict: ${res.status}`);
}
```

`reconstructConflict` — replace the `throw` with a POST:
```ts
export async function reconstructConflict(
  cwd: string,
  path: string,
): Promise<ReconstructedConflict> {
  if (isTauri()) {
    return tauriInvoke<ReconstructedConflict>("reconstruct_conflict", { cwd, path });
  }
  const res = await devFetch(`${DEV_SERVER}/api/reconstruct-conflict`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, path }),
  });
  if (!res.ok) throw new Error(`Failed to reconstruct conflict: ${res.status}`);
  return res.json();
}
```

(Use `devFetch` for the POSTs if that is the helper used by the other POST wrappers — e.g. `gitStage`/`gitMerge` use `devFetch`; match whichever the file uses for POST. For the GET, `fetch` matches `getConflictedFiles`. Confirm by reading neighbouring wrappers.)

- [ ] **Step 2: Typecheck + tests**

Run: `cd apps/desktop && pnpm build && pnpm test`
Expected: PASS — vue-tsc clean, Vitest suite green. (The `llm-fallback-integration.test.ts` mock already stubs these wrappers, so the real fetch path is not exercised in unit tests — that's fine; behavior is verified via dev:web.)

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/utils/backend.ts
git commit -m "feat(desktop): wire conflict-command wrappers to dev-server routes (dev:web parity)"
```

---

### Task 3: Verification

**Files:** none.

- [ ] **Step 1: Build + tests**

Run: `cd apps/desktop && pnpm build && pnpm test`
Expected: PASS.

- [ ] **Step 2: Confirm no Rust / core / version change**

Run: `git diff --stat <task1-base>..HEAD -- packages/core apps/desktop/src-tauri 'apps/desktop/**/Cargo.toml'`
Expected: empty.

- [ ] **Step 3: Manual dev:web verification**

`cd apps/desktop && pnpm dev:web`, open the Dendreo repo with the merge in progress. Confirm: `details_participants.blade.php` (modify/delete) now shows the "deleted" badge + tree panel with Keep/Delete actions; `reset.blade.php` (markerless content) now shows real hunks (reconstructed) or the markerless choice panel — both resolvable, no more "0 conflit" dead-end.

---

## Self-Review

**Spec coverage:** 3 dev-server routes mirroring the 3 Rust commands (Task 1), 3 wrapper dev-branches repointed (Task 2), verification incl. dev:web (Task 3). ✓
**Placeholder scan:** Full JS/TS code given; the one adaptation note (devFetch vs fetch for POST) is explicit and bounded. ✓
**Type/semantics consistency:** Route field names (`hasBase/hasOurs/hasTheirs/code/path`, `content/wtMatchesSide`) match the `TreeConflict`/`ReconstructedConflict` TS interfaces and the Rust camelCase output. Filter `!(hasOurs && hasTheirs)`, porcelain field offsets (m1/m2/m3 at split indices 2/3/4, path at 9+), merge-file arg order (ours base theirs), and 255-only error handling all mirror the reviewed Rust. ✓

# File-Level Bulk Resolution + Auto-Applied Memorized Rule — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user resolve an entire conflicted file in one click — via global "accept current/incoming/both" actions and via auto-applying a memorized rule to every hunk — closing the "I never re-click" loop.

**Architecture:** A single pure engine in `useGitWand.ts` (`resolveAllConflictBlocks`) walks the conflict markers once and replaces every block via a per-block resolver callback. Two thin composable methods drive it: `resolveFileBulk(path, choice)` (ours/theirs/both) and `applyMemoryToFile(path, entry)` (uses the existing `applyMemory`). `MergeEditor.vue` gains file-header bulk buttons, an actionable memory banner, and a file-level "memorize?" offer; `App.vue` wires the two new events. No `packages/core` change — the generated-file warning reads the existing `hunk.type === "generated_file"`.

**Tech Stack:** Vue 3 `<script setup>` (Composition API), TypeScript, Vitest (jsdom), pnpm. Frontend-only (`apps/desktop/src`), no Rust/IPC change.

## Global Constraints

- **pnpm only** (never npm/yarn).
- **No `packages/core` change** — preserves Rust↔TS parity. Do not add patterns, resolvers, or exports.
- **No new Tauri command** — pure frontend logic over already-parsed hunks; do not call `invoke()` directly anywhere.
- **Composition API only** — `<script setup>`. Business logic in composables, components stay thin.
- **i18n**: every user-visible string must have a key in all 5 locales (`en.ts`, `fr.ts`, `es.ts`, `pt-BR.ts`, `zh-CN.ts`). Never hardcode UI text. Interpolation is positional: `{0}`, `{1}`. `t(key, ...args)`.
- **Modal CSS**: never prefix `.bm-btn` (keep specificity `(0,1,0)`). New buttons here use their own `me-bulk-*` classes, not `.bm-btn`.
- **Diff parsing**: detect context lines with `line.startsWith(' ')`, never `!line.startsWith('\\')`.
- **Tests**: do not mock the git layer. The new logic is a pure string transform — test it directly with conflict-marker fixtures (no git repo needed).
- Run from `apps/desktop/`: `pnpm test` (Vitest), `pnpm build` (vue-tsc typecheck + vite build).

---

### Task 1: Pure conflict-block resolver engine

The risky logic (walk markers, replace every block, count applied/total, preserve diff3 markers on skip). Pure function, fully unit-tested. Mirrors the proven parser in `resolveHunkManual` (`useGitWand.ts:560-643`) but generalizes from "one target hunk" to "every hunk via callback".

**Files:**
- Modify: `apps/desktop/src/composables/useGitWand.ts` (add exported pure function near `buildPartialContent`, ~line 553)
- Test: `apps/desktop/src/composables/__tests__/useGitWand-bulk.test.ts` (create)

**Interfaces:**
- Produces:
  ```ts
  export function resolveAllConflictBlocks(
    content: string,
    resolver: (
      block: { oursLines: string[]; baseLines: string[]; theirsLines: string[] },
      index: number,
    ) => string | null,
  ): { content: string; applied: number; total: number }
  ```
  `resolver` returns the replacement text for a block, or `null` to leave that block unresolved (markers kept). `applied` counts non-null replacements; `total` counts all blocks.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/composables/__tests__/useGitWand-bulk.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { resolveAllConflictBlocks } from "../useGitWand";

const THREE = [
  "head",
  "<<<<<<< ours",
  "ours1",
  "=======",
  "theirs1",
  ">>>>>>> theirs",
  "mid",
  "<<<<<<< ours",
  "ours2",
  "=======",
  "theirs2",
  ">>>>>>> theirs",
  "<<<<<<< ours",
  "ours3",
  "=======",
  "theirs3",
  ">>>>>>> theirs",
  "tail",
].join("\n");

const DIFF3 = [
  "<<<<<<< ours",
  "ours1",
  "||||||| base",
  "base1",
  "=======",
  "theirs1",
  ">>>>>>> theirs",
].join("\n");

describe("resolveAllConflictBlocks", () => {
  it("applies 'theirs' to every block and removes all markers", () => {
    const r = resolveAllConflictBlocks(THREE, (b) => b.theirsLines.join("\n"));
    expect(r.total).toBe(3);
    expect(r.applied).toBe(3);
    expect(r.content).toBe(["head", "theirs1", "mid", "theirs2", "theirs3", "tail"].join("\n"));
    expect(r.content).not.toContain("<<<<<<<");
  });

  it("applies 'both' as ours then theirs", () => {
    const r = resolveAllConflictBlocks(THREE, (b) => [...b.oursLines, ...b.theirsLines].join("\n"));
    expect(r.applied).toBe(3);
    expect(r.content).toContain("ours1\ntheirs1");
  });

  it("keeps markers for blocks the resolver skips (returns null)", () => {
    const r = resolveAllConflictBlocks(THREE, (_b, i) => (i === 1 ? null : _b.theirsLines.join("\n")));
    expect(r.total).toBe(3);
    expect(r.applied).toBe(2);
    // block 1 still conflicted, blocks 0 and 2 resolved
    expect(r.content).toContain("<<<<<<< ours\nours2\n=======\ntheirs2\n>>>>>>> theirs");
    expect(r.content).toContain("theirs1");
    expect(r.content).toContain("theirs3");
  });

  it("passes parsed ours/base/theirs lines to the resolver", () => {
    const seen: any[] = [];
    resolveAllConflictBlocks(DIFF3, (b) => { seen.push(b); return null; });
    expect(seen[0]).toEqual({ oursLines: ["ours1"], baseLines: ["base1"], theirsLines: ["theirs1"] });
  });

  it("preserves diff3 base markers when a block is skipped", () => {
    const r = resolveAllConflictBlocks(DIFF3, () => null);
    expect(r.content).toContain("||||||| base");
    expect(r.content).toContain("base1");
    expect(r.applied).toBe(0);
  });

  it("treats an empty replacement as deleting the block's lines", () => {
    const r = resolveAllConflictBlocks(DIFF3, () => "");
    expect(r.applied).toBe(1);
    expect(r.content).toBe("");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && pnpm test -- useGitWand-bulk`
Expected: FAIL — `resolveAllConflictBlocks is not a function` / import error.

- [ ] **Step 3: Write minimal implementation**

In `apps/desktop/src/composables/useGitWand.ts`, add this exported function immediately after `buildPartialContent` (after line 552, before `resolveHunkManual`). It must be module-scoped/exported (not inside `useGitWand()`), so the test can import it directly:

```ts
/**
 * Walk a file's conflict markers once and replace every block via `resolver`.
 * Returns the new content plus counts. A resolver returning `null` leaves that
 * block conflicted (markers kept, diff3 base preserved). Generalizes the
 * single-hunk parser used by resolveHunkManual to the whole-file case.
 */
export function resolveAllConflictBlocks(
  content: string,
  resolver: (
    block: { oursLines: string[]; baseLines: string[]; theirsLines: string[] },
    index: number,
  ) => string | null,
): { content: string; applied: number; total: number } {
  const lines = content.split("\n");
  const newLines: string[] = [];
  let conflictIdx = 0;
  let applied = 0;
  let total = 0;
  let inConflict = false;
  let oursLines: string[] = [];
  let baseLines: string[] = [];
  let theirsLines: string[] = [];
  let hasBase = false;
  let inBase = false;
  let inTheirs = false;

  for (const line of lines) {
    if (line.startsWith("<<<<<<<")) {
      inConflict = true;
      hasBase = false;
      inBase = false;
      inTheirs = false;
      oursLines = [];
      baseLines = [];
      theirsLines = [];
    } else if (line.startsWith("|||||||") && inConflict) {
      inBase = true;
      hasBase = true;
    } else if (line.startsWith("=======") && inConflict) {
      inBase = false;
      inTheirs = true;
    } else if (line.startsWith(">>>>>>>") && inConflict) {
      total++;
      const replacement = resolver({ oursLines, baseLines, theirsLines }, conflictIdx);
      if (replacement !== null) {
        applied++;
        if (replacement.length > 0) {
          newLines.push(...replacement.split("\n"));
        }
      } else {
        newLines.push("<<<<<<< ours");
        newLines.push(...oursLines);
        if (hasBase) {
          newLines.push("||||||| base");
          newLines.push(...baseLines);
        }
        newLines.push("=======");
        newLines.push(...theirsLines);
        newLines.push(">>>>>>> theirs");
      }
      conflictIdx++;
      inConflict = false;
      inTheirs = false;
    } else if (inConflict) {
      if (inTheirs) theirsLines.push(line);
      else if (inBase) baseLines.push(line);
      else oursLines.push(line);
    } else {
      newLines.push(line);
    }
  }

  return { content: newLines.join("\n"), applied, total };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && pnpm test -- useGitWand-bulk`
Expected: PASS — 6 tests green.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/composables/useGitWand.ts apps/desktop/src/composables/__tests__/useGitWand-bulk.test.ts
git commit -m "feat(desktop): pure resolveAllConflictBlocks engine for file-level resolution"
```

---

### Task 2: Composable methods + App.vue wiring

Wrap the engine in two stateful composable methods and wire them through `App.vue`. Verified by typecheck (vue-tsc) — no unit harness exists for the `useGitWand` singleton, and AGENTS.md forbids mocking git.

**Files:**
- Modify: `apps/desktop/src/composables/useGitWand.ts` (add methods + imports + return block ~line 753)
- Modify: `apps/desktop/src/App.vue` (destructure new methods ~line 124, add handlers ~line 589, bind events ~line 2313)

**Interfaces:**
- Consumes: `resolveAllConflictBlocks` (Task 1); `applyMemory`, `ResolutionMemoryEntry` from `./useResolutionMemory`; `ConflictHunk` from `@gitwand/core`.
- Produces (added to `useGitWand()` return):
  ```ts
  resolveFileBulk(path: string, choice: "ours" | "theirs" | "both"): { applied: number; total: number }
  applyMemoryToFile(path: string, entry: ResolutionMemoryEntry): { applied: number; total: number }
  ```

- [ ] **Step 1: Add imports at the top of `useGitWand.ts`**

Find the existing import of `readFile` and the core import. Add these imports (place near the other `@gitwand/core` / composable imports at the top of the file):

```ts
import type { ConflictHunk } from "@gitwand/core";
import { applyMemory, type ResolutionMemoryEntry } from "./useResolutionMemory";
```

(If `ConflictHunk` is already imported, do not duplicate — extend the existing import instead.)

- [ ] **Step 2: Add the two methods inside `useGitWand()`**

Insert immediately after `resolveHunkCustom` (after line 667, before `saveFile`):

```ts
  /**
   * Resolve EVERY hunk in a file with a single choice (ours/theirs/both),
   * including complex/low-confidence hunks. Distinct from `resolveFile`
   * (which only applies the core's safe auto-resolutions). Reversible via undo.
   */
  function resolveFileBulk(
    path: string,
    choice: "ours" | "theirs" | "both",
  ): { applied: number; total: number } {
    const file = files.value.find((f) => f.path === path);
    if (!file) return { applied: 0, total: 0 };

    const { content: newContent, applied, total } = resolveAllConflictBlocks(
      file.content,
      (b) => {
        if (choice === "ours") return b.oursLines.join("\n");
        if (choice === "theirs") return b.theirsLines.join("\n");
        return [...b.oursLines, ...b.theirsLines].join("\n");
      },
    );

    if (newContent !== file.content) {
      pushUndo();
      const idx = files.value.indexOf(file);
      files.value[idx] = {
        ...file,
        content: newContent,
        result: resolve(newContent, file.path, resolveOptions.value),
      };
    }
    return { applied, total };
  }

  /**
   * Apply a memorized resolution rule to every hunk in a file. Hunks where the
   * rule can't apply (e.g. "date-latest" but content is no longer a date) keep
   * their conflict markers and are reported via the returned counts.
   */
  function applyMemoryToFile(
    path: string,
    entry: ResolutionMemoryEntry,
  ): { applied: number; total: number } {
    const file = files.value.find((f) => f.path === path);
    if (!file) return { applied: 0, total: 0 };

    const { content: newContent, applied, total } = resolveAllConflictBlocks(
      file.content,
      (b) =>
        applyMemory(entry, {
          oursLines: b.oursLines,
          theirsLines: b.theirsLines,
        } as ConflictHunk),
    );

    if (newContent !== file.content) {
      pushUndo();
      const idx = files.value.indexOf(file);
      files.value[idx] = {
        ...file,
        content: newContent,
        result: resolve(newContent, file.path, resolveOptions.value),
      };
    }
    return { applied, total };
  }
```

(`applyMemory` only reads `oursLines`/`theirsLines`, so the minimal object cast is safe.)

- [ ] **Step 3: Export the methods**

In the `return { ... }` block (~line 753), add after `resolveHunkCustom,`:

```ts
    resolveFileBulk,
    applyMemoryToFile,
```

- [ ] **Step 4: Wire `App.vue`**

(a) In the `useGitWand()` destructure (~line 124, after `resolveHunkCustom,`):

```ts
  resolveFileBulk,
  applyMemoryToFile,
```

(b) Import the entry type — add to App.vue's `<script setup>` imports:

```ts
import type { ResolutionMemoryEntry } from "./composables/useResolutionMemory";
```

(c) Add handlers after `handleResolveHunkCustom` (~line 596):

```ts
function handleResolveFileBulk(path: string, choice: "ours" | "theirs" | "both") {
  resolveFileBulk(path, choice);
}

function handleApplyFileMemory(path: string, entry: ResolutionMemoryEntry) {
  applyMemoryToFile(path, entry);
}
```

(d) Bind the new events on the `<MergeEditor>` tag (~line 2313-2315), extending the existing bindings:

```vue
              <MergeEditor v-if="showingMergeEditor && mergeSelectedFile" :file="mergeSelectedFile"
                @resolve="handleResolveFile" @resolve-hunk="(path, idx, choice) => handleResolveHunk(path, idx, choice)"
                @resolve-hunk-custom="(path, idx, content) => handleResolveHunkCustom(path, idx, content)"
                @resolve-file-bulk="(path, choice) => handleResolveFileBulk(path, choice)"
                @apply-file-memory="(path, entry) => handleApplyFileMemory(path, entry)" />
```

- [ ] **Step 5: Typecheck**

Run: `cd apps/desktop && pnpm build`
Expected: PASS — vue-tsc reports no type errors, vite build completes. (The MergeEditor emits used here are added in Task 4; if you run this step before Task 4, expect a "type X is not assignable" on the two new bindings — that resolves once Task 4 lands. To keep tasks independently green, run Step 5 after Task 4, or temporarily verify with `pnpm test` only here.)

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/composables/useGitWand.ts apps/desktop/src/App.vue
git commit -m "feat(desktop): resolveFileBulk + applyMemoryToFile composable methods wired in App"
```

---

### Task 3: i18n keys in all 5 locales

Add the UI strings before the templates reference them — `LocaleKey` is derived from `en.ts`, so a `t('merge.bulkOurs')` in a template won't typecheck until `en.ts` has the key, and AGENTS.md requires every key in all 5 locales.

**Files:**
- Modify: `apps/desktop/src/locales/en.ts`, `fr.ts`, `es.ts`, `pt-BR.ts`, `zh-CN.ts`

**Interfaces:**
- Produces these keys (English source values; translate per locale):
  - `merge.bulkLabel` = `"Accept all:"`
  - `merge.bulkOurs` = `"Current"`
  - `merge.bulkTheirs` = `"Incoming"`
  - `merge.bulkBoth` = `"Both"`
  - `merge.bulkGeneratedWarning` = `"⚠ Concatenating may break a generated file"`
  - `mergeEditor.memoryApplyAll` = `"Apply rule to {0} hunks"`
  - `mergeEditor.memoryApplyAllPartial` = `"{0} to review"`
  - `mergeEditor.memorizeFileOffer` = `"Remember this rule for {0}?"`

- [ ] **Step 1: Invoke the i18n-sync skill**

Use the `i18n-sync` skill to add the 8 keys above into all 5 locale files in the correct namespaces (`merge.*` near `resolveAuto`, `mergeEditor.*` near `memoryBannerHint`), with proper translations for fr/es/pt-BR/zh-CN. Keep the French values aligned with the design wording (e.g. `bulkLabel` → `"Tout accepter :"`, `bulkOurs` → `"Courante"`, `bulkTheirs` → `"Entrante"`, `bulkBoth` → `"Les deux"`, `bulkGeneratedWarning` → `"⚠ Concaténer peut casser un fichier généré"`, `memoryApplyAll` → `"Appliquer la règle à {0} hunks"`, `memoryApplyAllPartial` → `"{0} à vérifier"`, `memorizeFileOffer` → `"Mémoriser cette règle pour {0} ?"`).

- [ ] **Step 2: Typecheck the locale index**

Run: `cd apps/desktop && pnpm build`
Expected: PASS — the locale `index.ts` type-merges with no "missing key" / shape-mismatch errors across locales.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/locales
git commit -m "i18n: bulk resolution + file-memory keys across 5 locales"
```

---

### Task 4: MergeEditor — file-header bulk actions (A) + memorize offer (B)

Add the three global buttons in the file header, the non-blocking generated-file warning on "Both", the new emits, and the file-level "memorize this rule?" offer shown after a bulk action.

**Files:**
- Modify: `apps/desktop/src/components/MergeEditor.vue` (emits ~line 34, script state ~line 164-216, template header ~line 590-644)

**Interfaces:**
- Consumes: `t`, `emit`, `hunks` (computed, line 264), `saveMemory`, `ResolutionStrategy`, `ResolutionMemoryEntry`.
- Produces: emits `resolveFileBulk: [path, "ours"|"theirs"|"both"]` and `applyFileMemory: [path, ResolutionMemoryEntry]` (the latter consumed in Task 5's banner, declared here so both emits land together).

- [ ] **Step 1: Extend the type import**

In the `useResolutionMemory` import block (lines 12-17), add `ResolutionMemoryEntry`:

```ts
import {
  useResolutionMemory,
  detectPattern,
  applyMemory,
  type ResolutionStrategy,
  type ResolutionMemoryEntry,
} from "../composables/useResolutionMemory";
```

- [ ] **Step 2: Add the new emits**

In `defineEmits` (lines 34-40), add two entries:

```ts
const emit = defineEmits<{
  resolve: [path: string];
  resolveHunk: [path: string, hunkIndex: number, choice: ManualChoice];
  resolveHunkCustom: [path: string, hunkIndex: number, content: string];
  resolveFileBulk: [path: string, choice: "ours" | "theirs" | "both"];
  applyFileMemory: [path: string, entry: ResolutionMemoryEntry];
  /** Custom automation ran and committed; parent should refresh status */
  automationDone: [commitHash: string];
}>();
```

- [ ] **Step 3: Add bulk-action + file-memory-offer script state**

After the existing memory functions (after `dismissMemoryOffer`, ~line 190), add:

```ts
// ─── File-level bulk resolution + memorize offer ────────
/** Strategy offered for memorization after a file-level bulk action. */
const fileMemoryOfferStrategy = ref<ResolutionStrategy | null>(null);

/** True when the core flagged any hunk as a generated (build) file. */
const isGeneratedFileLocal = computed(() =>
  hunks.value.some((h) => h.type === "generated_file"),
);

function bulkResolve(choice: "ours" | "theirs" | "both") {
  emit("resolveFileBulk", props.file.path, choice);
  // ours/theirs/both are all valid memorizable strategies
  setTimeout(() => { fileMemoryOfferStrategy.value = choice; }, 200);
}

function acceptFileMemoryOffer() {
  if (!fileMemoryOfferStrategy.value) return;
  const label = `${fileMemoryOfferStrategy.value} — ${props.file.path.split("/").pop()}`;
  saveMemory(props.file.path, fileMemoryOfferStrategy.value, label, null);
  fileMemoryOfferStrategy.value = null;
}

function dismissFileMemoryOffer() {
  fileMemoryOfferStrategy.value = null;
}
```

Note: `hunks` is defined at line 264, *after* this insertion point. `computed` callbacks are lazy, so referencing `hunks.value` inside `isGeneratedFileLocal` is safe even though `hunks` is declared below — it is only read when accessed in the template. (If vue-tsc complains about use-before-declaration, move the `isGeneratedFileLocal` computed to just after the `hunks` definition at line 264.)

- [ ] **Step 4: Reset the offer when the active file changes**

The component already has `watch(() => props.file.path, ...)` at lines 46-52 (resets editing state). Add one line inside that watcher's callback:

```ts
    fileMemoryOfferStrategy.value = null;
```

- [ ] **Step 5: Add the bulk-action buttons to the header**

In the template, inside `.editor-header` (after the `resolveAuto` button, before the closing `</div>` at line 601), add:

```vue
      <div class="me-bulk-actions" v-if="file.result.stats.totalConflicts > 0">
        <span class="me-bulk-label muted">{{ t('merge.bulkLabel') }}</span>
        <button class="me-bulk-btn" @click="bulkResolve('ours')">{{ t('merge.bulkOurs') }}</button>
        <button class="me-bulk-btn" @click="bulkResolve('theirs')">{{ t('merge.bulkTheirs') }}</button>
        <button class="me-bulk-btn" @click="bulkResolve('both')">{{ t('merge.bulkBoth') }}</button>
        <span v-if="isGeneratedFileLocal" class="me-bulk-warn">{{ t('merge.bulkGeneratedWarning') }}</span>
      </div>
```

- [ ] **Step 6: Add the file-level memorize-offer banner**

After the existing per-hunk memory offer toast (after line 644), add:

```vue
    <!-- File-level memorize offer (after a bulk action) -->
    <div v-if="fileMemoryOfferStrategy !== null" class="me-memory-offer">
      <span>{{ t("mergeEditor.memorizeFileOffer", file.path.split('/').pop() || file.path) }}</span>
      <button class="me-memory-btn me-memory-btn--save" @click="acceptFileMemoryOffer">{{ t("mergeEditor.memorySave") }}</button>
      <button class="me-memory-btn" @click="dismissFileMemoryOffer">{{ t("common.close") }}</button>
    </div>
```

- [ ] **Step 7: Add minimal styles**

In the component's `<style>` block (near `.me-memory-banner` ~line 1518), add:

```css
.me-bulk-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.me-bulk-label {
  font-size: 12px;
}
.me-bulk-btn {
  font-size: 12px;
  padding: 2px 8px;
  border: 1px solid var(--border-color, #d0d0d0);
  border-radius: 4px;
  background: transparent;
  cursor: pointer;
}
.me-bulk-btn:hover {
  background: var(--hover-bg, rgba(0, 0, 0, 0.05));
}
.me-bulk-warn {
  font-size: 11px;
  color: var(--warning-color, #b8860b);
}
```

(Use existing CSS variables if the component already defines a palette; match neighbouring rules. Do not touch `.bm-btn`.)

- [ ] **Step 8: Typecheck + build**

Run: `cd apps/desktop && pnpm build`
Expected: PASS — no type errors. The `App.vue` bindings from Task 2 now match the declared emits.

- [ ] **Step 9: Commit**

```bash
git add apps/desktop/src/components/MergeEditor.vue
git commit -m "feat(desktop): file-level accept-all buttons + memorize offer in MergeEditor"
```

---

### Task 5: MergeEditor — actionable memorized-rule banner (C)

Turn the informational "Saved rule" banner into a one-click "apply to all hunks" affordance, with an applicability count.

**Files:**
- Modify: `apps/desktop/src/components/MergeEditor.vue` (script ~line 171-199, template banner ~line 632-637)

**Interfaces:**
- Consumes: `fileMemory` (computed, line 171), `hunks` (line 264), `applyMemory`, `markUsed`, emit `applyFileMemory` (declared in Task 4).

- [ ] **Step 1: Add applicability count + apply handler**

After `applyFileMemory` (the existing per-hunk function ending ~line 199), add:

```ts
/** How many of this file's hunks the saved rule can actually resolve. */
const memoryApplicableCount = computed(() => {
  const mem = fileMemory.value;
  if (!mem) return 0;
  return hunks.value.reduce(
    (n, h) => (applyMemory(mem, h) !== null ? n + 1 : n),
    0,
  );
});

/** Apply the saved rule to every hunk in the file (one click). */
function applyMemoryToWholeFile() {
  if (!fileMemory.value) return;
  emit("applyFileMemory", props.file.path, fileMemory.value);
  markUsed(fileMemory.value.id);
}
```

- [ ] **Step 2: Make the banner actionable**

Replace the existing memory banner (lines 632-637) with:

```vue
    <!-- Resolution Memory suggestion banner (actionable) -->
    <div v-if="fileMemory && !matchingRule" class="me-memory-banner">
      <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
        <path d="M8 1a7 7 0 100 14A7 7 0 008 1zm.75 10.5h-1.5v-1.5h1.5v1.5zm0-3h-1.5V4.5h1.5V8.5z"/>
      </svg>
      <span class="me-memory-text">{{ t("mergeEditor.memoryBannerHint", fileMemory.description) }}</span>
      <button
        v-if="memoryApplicableCount > 0"
        class="me-memory-btn me-memory-btn--save"
        @click="applyMemoryToWholeFile"
      >
        {{ t("mergeEditor.memoryApplyAll", memoryApplicableCount) }}
      </button>
      <span v-if="memoryApplicableCount < hunks.length" class="muted">
        {{ t("mergeEditor.memoryApplyAllPartial", hunks.length - memoryApplicableCount) }}
      </span>
    </div>
```

- [ ] **Step 3: Typecheck + build**

Run: `cd apps/desktop && pnpm build`
Expected: PASS — no type errors.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/components/MergeEditor.vue
git commit -m "feat(desktop): one-click apply of memorized rule to whole file"
```

---

### Task 6: Full verification

Confirm the whole feature with the real test suites and the running app, and confirm `packages/core` parity is untouched.

**Files:** none (verification only)

- [ ] **Step 1: Run the desktop unit tests**

Run: `cd apps/desktop && pnpm test`
Expected: PASS — including the 6 `useGitWand-bulk` tests. No regressions.

- [ ] **Step 2: Confirm parity is untouched**

Run: `cd apps/desktop && pnpm test:parity`
Expected: PASS — we made no `packages/core` change, so Rust↔TS parity must remain green. (If this needs a Rust toolchain not present, confirm instead via `git diff --stat origin/main -- packages/core` showing zero changed files.)

- [ ] **Step 3: Build the whole frontend**

Run: `cd apps/desktop && pnpm build`
Expected: PASS — vue-tsc + vite build clean.

- [ ] **Step 4: Manual verification in the running app**

Start: `cd apps/desktop && pnpm dev:web`. Open a repo with a multi-hunk conflicted file (e.g. a manifest-style JSON), then verify:
1. File header shows `Accept all: Current · Incoming · Both`.
2. Clicking **Incoming** resolves *all* hunks (including the ones "Resolve auto" left behind) — file shows as fully resolved.
3. After the bulk action, the `Remember this rule for <file>?` banner appears; clicking **Save** stores it.
4. Re-open / re-trigger the same conflict → the green saved-rule banner now shows an **Apply rule to N hunks** button; one click resolves the file.
5. For a file detected as generated, the `⚠ Concatenating may break a generated file` hint shows next to **Both**.

Capture a screenshot of the file header with the bulk actions as proof.

- [ ] **Step 5: Final commit (if any verification fixes were needed)**

```bash
git add -A
git commit -m "test(desktop): verify file-level bulk resolution end-to-end"
```

---

## Self-Review

**Spec coverage:**
- A — file-level bulk actions (ours/theirs/both, all hunks) → Task 1 (engine), Task 2 (`resolveFileBulk`), Task 4 (buttons). ✓
- A — generated-file `Both` warning → Task 4 Step 3/5 (`isGeneratedFileLocal` + `me-bulk-warn`). ✓
- B — memorize from bulk action → Task 4 (`bulkResolve` → `fileMemoryOfferStrategy` → `acceptFileMemoryOffer`). ✓
- C — actionable memorized-rule banner, 1-click, applicability count → Task 2 (`applyMemoryToFile`), Task 5 (banner + `memoryApplicableCount`). ✓
- C — graceful skip of inapplicable hunks + `N to review` count → Task 1 (null skip), Task 5 (`memoryApplyAllPartial`). ✓
- Reversibility via undo → `pushUndo()` in both methods (Task 2). ✓
- Multi-hunk offset safety → single-pass rebuild, no `replaceConflictByIndex` looping (Task 1). ✓
- i18n in 5 locales → Task 3. ✓
- No `packages/core` change / parity intact → Task 6 Step 2. ✓
- `.bm-btn` untouched → Task 4 uses `me-bulk-*` classes. ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code; test code is concrete. ✓

**Type consistency:** `resolveFileBulk(path, "ours"|"theirs"|"both")` and `applyMemoryToFile(path, ResolutionMemoryEntry)` are identical across useGitWand definition, return block, App.vue destructure/handlers, and MergeEditor emits. `resolveAllConflictBlocks` signature identical in Task 1 definition, test import, and Task 2 callers. Event names `resolve-file-bulk`/`resolveFileBulk` and `apply-file-memory`/`applyFileMemory` follow Vue's kebab/camel auto-mapping (as the existing `resolve-hunk`/`resolveHunk` pair does). ✓

# AI Hunk Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make per-hunk AI resolution non-blocking and collision-free, and add a bounded "Resolve all with AI" that stages suggestions for review.

**Architecture:** A new `useAiHunkQueue` composable owns per-hunk AI state (`idle | queued | loading | ready | error`) and a bounded worker pool, so a response can only ever be written to the hunk it was requested for. `MergeEditor.vue` renders from it instead of holding a single shared index. On the Rust side the eight async commands in `commands/ai.rs` move their blocking process work onto `spawn_blocking`, so a batch cannot starve the tokio workers every other IPC command shares.

**Tech Stack:** Vue 3 `<script setup>`, TypeScript, Vitest, Rust (Tauri 2, `tauri::async_runtime::spawn_blocking`).

**Spec:** `docs/superpowers/specs/2026-09-17-ai-hunk-queue-design.md`

## Global Constraints

- pnpm only. Never npm, never yarn.
- Business logic goes in `apps/desktop/src/composables/`; components orchestrate and render.
- All new components and edits use `<script setup>` (Composition API).
- Every user-visible string needs a key in all five locales: `en`, `fr`, `es`, `pt-BR`, `zh-CN`. Never hardcode user-facing text in a template.
- Never call `invoke()` outside `src/utils/backend*.ts`.
- No em dash (the "—" character) anywhere, including comments and commit messages. Grep your own diff before committing.
- Never edit a version field by hand. No version bump, no tag.
- Suggestions are STAGED, never auto-applied. Nothing in this plan writes model output into merged content without the user confirming.
- Run `cargo fmt` before committing any Rust change. CI fails on `cargo fmt --check`, and it has caught this twice already.

---

## File Structure

| File | Responsibility |
|---|---|
| `apps/desktop/src-tauri/src/commands/ai.rs` | Existing AI commands; blocking bodies move onto `spawn_blocking` |
| `apps/desktop/src/composables/useAiHunkQueue.ts` | New: per-hunk AI state machine and bounded queue |
| `apps/desktop/src/composables/__tests__/useAiHunkQueue.test.ts` | New: queue, concurrency, failure, cancel |
| `apps/desktop/src/components/MergeEditor.vue` | Renders from the queue; per-hunk loading and disabled actions; bulk entry |
| `apps/desktop/src/components/__tests__/MergeEditor-ai-queue.test.ts` | New: per-hunk rendering and disabled state |
| `apps/desktop/src/locales/{en,fr,es,pt-BR,zh-CN}.ts` | New keys for the batch entry, progress, summary, apply and discard |
| `ROADMAP.md`, `CHANGELOG.md` | Bookkeeping and the deferred hard-cancel follow-up |

Task order is dependency order. Task 1 is independent of the frontend and can be reviewed on its own.

---

### Task 1: Move the AI commands off the runtime threads

**Files:**
- Modify: `apps/desktop/src-tauri/src/commands/ai.rs`

**Interfaces:**
- Consumes: nothing.
- Produces: no signature changes. Every command keeps its exact name, parameters, return type and error strings. Only where the work runs changes.

**Context.** The eight `pub(crate) async fn` commands in this file (`detect_claude_cli:127`, `claude_cli_prompt:168`, `detect_codex_cli:249`, `codex_cli_prompt:283`, `detect_opencode_cli:524`, `opencode_cli_prompt:557`, `opencode_list_models:618`, `claude_cli_login:801`) each call `.output()` on a spawned process directly inside the async body, 16 call sites in total, with zero uses of `spawn_blocking`. `.output()` blocks the thread it runs on, and Tauri's runtime is a default multi-threaded tokio (11 workers on a typical dev machine), so a batch of concurrent AI calls blocks workers that every other IPC command needs. `commands/ops.rs` already uses `tauri::async_runtime::spawn_blocking` four times for exactly this reason; follow that pattern.

- [ ] **Step 1: Read the existing pattern before changing anything**

Run: `grep -n "spawn_blocking" -B 4 -A 8 apps/desktop/src-tauri/src/commands/ops.rs | head -40`

You are copying this shape: the blocking body moves into a closure, the command awaits the join handle, and the join error is mapped to a string.

- [ ] **Step 2: Convert one command and prove it still compiles**

Start with `claude_cli_prompt`, the command behind the reported button. The body moves wholesale; nothing inside it changes.

```rust
#[tauri::command]
pub(crate) async fn claude_cli_prompt(
    prompt: String,
    system_prompt: Option<String>,
    cwd: Option<String>,
    output_format: Option<String>,
    model: Option<String>,
) -> Result<String, String> {
    // The body spawns a process and blocks on `.output()`. Inside the async
    // runtime that pins one of tokio's worker threads for the whole model
    // call, which is seconds to minutes, and a batch of them starves every
    // other IPC command. `spawn_blocking` puts it on the blocking pool
    // instead, which is what `ops.rs` already does for git subprocesses.
    tauri::async_runtime::spawn_blocking(move || {
        claude_cli_prompt_inner(prompt, system_prompt, cwd, output_format, model)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn claude_cli_prompt_inner(
    prompt: String,
    system_prompt: Option<String>,
    cwd: Option<String>,
    output_format: Option<String>,
    model: Option<String>,
) -> Result<String, String> {
    // ... the entire existing body, unchanged ...
}
```

Run: `cd apps/desktop/src-tauri && cargo build --lib`
Expected: builds clean.

- [ ] **Step 3: Convert the remaining seven the same way**

`detect_claude_cli`, `detect_codex_cli`, `codex_cli_prompt`, `detect_opencode_cli`, `opencode_cli_prompt`, `opencode_list_models`, `claude_cli_login`. Each gets a `_inner` function holding its current body verbatim and an async shell that spawns it. Do not change any error string, any argument handling, or any of the `strip_claude_auth_env` / `hidden_cmd` calls.

- [ ] **Step 4: Verify nothing changed but the threading**

Run: `cd apps/desktop/src-tauri && cargo test --lib ai`
Expected: PASS, the existing AI tests still green.

Run: `cd apps/desktop/src-tauri && cargo fmt && cargo fmt --check && cargo clippy --lib 2>&1 | grep -cE "^warning|^error"`
Expected: `cargo fmt --check` silent, clippy count 0.

Run: `cd apps/desktop/src-tauri && cargo test --lib 2>&1 | grep "^test result"`
Expected: the same pass count as before your change, with the two known `commands::watcher::tests` fsevents failures and nothing else.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/commands/ai.rs
git commit -m "fix(desktop): run the AI CLI calls on the blocking pool, not the runtime threads"
```

---

### Task 2: The per-hunk queue composable

**Files:**
- Create: `apps/desktop/src/composables/useAiHunkQueue.ts`
- Test: `apps/desktop/src/composables/__tests__/useAiHunkQueue.test.ts`

**Interfaces:**
- Consumes: `useAIProvider()` from `../composables/useAIProvider`, specifically `suggest(ctx: ConflictContext): Promise<AISuggestion>`. `AISuggestion` is `{ resolvedContent: string; explanation: string; confidence: "high" | "medium" | "low" }`. `ConflictContext` is `{ filePath: string; base: string; ours: string; theirs: string }`.
- Produces, used by Tasks 3 and 4:
  - `AI_HUNK_CONCURRENCY: number` (value 3)
  - `type HunkAiState = "idle" | "queued" | "loading" | "ready" | "error"`
  - `useAiHunkQueue(filePath: () => string)` returning `{ stateFor(i: number): HunkAiState; suggestionFor(i: number): AISuggestion | null; errorFor(i: number): string | null; inFlight: Ref<number>; pending: ComputedRef<number>; isRunning: ComputedRef<boolean>; summary: ComputedRef<{ ready: number; error: number }>; request(i: number, hunk: ConflictHunk): Promise<void>; requestAll(items: Array<{ index: number; hunk: ConflictHunk }>): void; cancelAll(): void; dismiss(i: number): void; reset(): void }`

- [ ] **Step 1: Write the failing tests**

Create `apps/desktop/src/composables/__tests__/useAiHunkQueue.test.ts`:

```ts
/**
 * The queue exists because a single shared "which hunk is the AI working on"
 * ref let a second request overwrite the first, so the first response was
 * applied to the wrong hunk (MergeEditor.vue:91, before this change). Keying
 * everything by hunk index removes that by construction, and the bounded pool
 * is what keeps "Resolve all with AI" from firing N calls at once.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ConflictHunk } from "@gitwand/core";

const suggest = vi.fn();
vi.mock("../useAIProvider", () => ({
  useAIProvider: () => ({ suggest }),
}));

import { useAiHunkQueue, AI_HUNK_CONCURRENCY } from "../useAiHunkQueue";

function hunk(n: number): ConflictHunk {
  return {
    baseLines: [`base${n}`],
    oursLines: [`ours${n}`],
    theirsLines: [`theirs${n}`],
    startLine: n,
    type: "complex",
    confidence: { score: 20, label: "low", dimensions: {}, boosters: [], penalties: [] },
    explanation: "",
    trace: { steps: [], selected: "complex", summary: "", hasBase: true },
  } as unknown as ConflictHunk;
}

/** A promise plus the handles to settle it, so a test can hold calls open. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const answer = (text: string) => ({ resolvedContent: text, explanation: "why", confidence: "high" as const });

describe("useAiHunkQueue", () => {
  beforeEach(() => { suggest.mockReset(); });

  it("moves a hunk from idle to loading to ready", async () => {
    const d = deferred<ReturnType<typeof answer>>();
    suggest.mockReturnValue(d.promise);
    const q = useAiHunkQueue(() => "a.ts");

    expect(q.stateFor(0)).toBe("idle");
    const done = q.request(0, hunk(0));
    expect(q.stateFor(0)).toBe("loading");

    d.resolve(answer("merged"));
    await done;
    expect(q.stateFor(0)).toBe("ready");
    expect(q.suggestionFor(0)?.resolvedContent).toBe("merged");
  });

  it("writes a response to the hunk it was requested for, not the most recent one", async () => {
    const first = deferred<ReturnType<typeof answer>>();
    const second = deferred<ReturnType<typeof answer>>();
    suggest.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const q = useAiHunkQueue(() => "a.ts");

    const a = q.request(0, hunk(0));
    const b = q.request(1, hunk(1));
    // Second one answers first, which is exactly the interleaving that used
    // to put hunk 1's content into hunk 0's editor.
    second.resolve(answer("for-1"));
    await b;
    first.resolve(answer("for-0"));
    await a;

    expect(q.suggestionFor(0)?.resolvedContent).toBe("for-0");
    expect(q.suggestionFor(1)?.resolvedContent).toBe("for-1");
  });

  it("ignores a second request for a hunk already in flight", async () => {
    const d = deferred<ReturnType<typeof answer>>();
    suggest.mockReturnValue(d.promise);
    const q = useAiHunkQueue(() => "a.ts");

    const a = q.request(0, hunk(0));
    await q.request(0, hunk(0));
    expect(suggest).toHaveBeenCalledTimes(1);

    d.resolve(answer("x"));
    await a;
  });

  it("never exceeds the concurrency limit", async () => {
    const pendings: Array<ReturnType<typeof deferred<ReturnType<typeof answer>>>> = [];
    let peak = 0;
    let live = 0;
    suggest.mockImplementation(() => {
      live += 1;
      peak = Math.max(peak, live);
      const d = deferred<ReturnType<typeof answer>>();
      pendings.push(d);
      return d.promise.finally(() => { live -= 1; });
    });

    const q = useAiHunkQueue(() => "a.ts");
    q.requestAll(Array.from({ length: 10 }, (_, i) => ({ index: i, hunk: hunk(i) })));
    await Promise.resolve();

    expect(peak).toBeLessThanOrEqual(AI_HUNK_CONCURRENCY);
    expect(q.pending.value).toBeGreaterThan(0);

    for (const d of pendings.slice()) d.resolve(answer("ok"));
    await vi.waitFor(() => expect(q.isRunning.value).toBe(false));
    expect(suggest).toHaveBeenCalledTimes(10);
  });

  it("keeps going when one hunk fails, and reports the split", async () => {
    suggest.mockImplementation((ctx: { ours: string }) =>
      ctx.ours === "ours1" ? Promise.reject(new Error("model said no")) : Promise.resolve(answer("ok")),
    );
    const q = useAiHunkQueue(() => "a.ts");
    q.requestAll([0, 1, 2].map((i) => ({ index: i, hunk: hunk(i) })));
    await vi.waitFor(() => expect(q.isRunning.value).toBe(false));

    expect(q.stateFor(0)).toBe("ready");
    expect(q.stateFor(1)).toBe("error");
    expect(q.errorFor(1)).toBe("model said no");
    expect(q.stateFor(2)).toBe("ready");
    expect(q.summary.value).toEqual({ ready: 2, error: 1 });
  });

  it("discards a result that arrives after a cancel", async () => {
    const d = deferred<ReturnType<typeof answer>>();
    suggest.mockReturnValue(d.promise);
    const q = useAiHunkQueue(() => "a.ts");

    const a = q.request(0, hunk(0));
    q.cancelAll();
    expect(q.stateFor(0)).toBe("idle");
    expect(q.isRunning.value).toBe(false);

    d.resolve(answer("too late"));
    await a;
    expect(q.stateFor(0)).toBe("idle");
    expect(q.suggestionFor(0)).toBeNull();
  });

  it("drops queued work on cancel without starting it", async () => {
    const held: Array<ReturnType<typeof deferred<ReturnType<typeof answer>>>> = [];
    suggest.mockImplementation(() => { const d = deferred<ReturnType<typeof answer>>(); held.push(d); return d.promise; });
    const q = useAiHunkQueue(() => "a.ts");

    q.requestAll(Array.from({ length: 9 }, (_, i) => ({ index: i, hunk: hunk(i) })));
    await Promise.resolve();
    expect(suggest).toHaveBeenCalledTimes(AI_HUNK_CONCURRENCY);

    q.cancelAll();
    for (const d of held) d.resolve(answer("x"));
    await vi.waitFor(() => expect(q.pending.value).toBe(0));
    expect(suggest).toHaveBeenCalledTimes(AI_HUNK_CONCURRENCY);
  });

  it("skips hunks that already have an answer when the batch runs again", async () => {
    suggest.mockResolvedValue(answer("ok"));
    const q = useAiHunkQueue(() => "a.ts");
    await q.request(0, hunk(0));
    expect(q.stateFor(0)).toBe("ready");

    q.requestAll([0, 1].map((i) => ({ index: i, hunk: hunk(i) })));
    await vi.waitFor(() => expect(q.isRunning.value).toBe(false));
    expect(suggest).toHaveBeenCalledTimes(2);
  });

  it("passes the file path and the hunk's three sides to the provider", async () => {
    suggest.mockResolvedValue(answer("ok"));
    const q = useAiHunkQueue(() => "src/thing.ts");
    await q.request(4, hunk(4));
    expect(suggest).toHaveBeenCalledWith({
      filePath: "src/thing.ts",
      base: "base4",
      ours: "ours4",
      theirs: "theirs4",
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/desktop && pnpm vitest run src/composables/__tests__/useAiHunkQueue.test.ts`
Expected: FAIL, cannot resolve `../useAiHunkQueue`.

- [ ] **Step 3: Write the composable**

Create `apps/desktop/src/composables/useAiHunkQueue.ts`:

```ts
/**
 * @file useAiHunkQueue.ts
 *
 * Per-hunk AI resolution state, and a bounded queue for resolving many hunks
 * at once (issue #196).
 *
 * Why this exists rather than living in MergeEditor: the component used to
 * hold a single `aiSuggestionHunkIndex` ref, so a second AI request
 * overwrote the first and the first response was applied to whichever hunk
 * was clicked last. Everything here is keyed by hunk index, which removes
 * that by construction, and the bounded pool is what stops "Resolve all with
 * AI" from firing one model call per hunk simultaneously.
 *
 * Suggestions are STAGED. Nothing here writes into merged content; the
 * component decides what to show and the user confirms.
 */

import { computed, ref, type ComputedRef, type Ref } from "vue";
import type { ConflictHunk } from "@gitwand/core";
import { useAIProvider, type AISuggestion, type ConflictContext } from "./useAIProvider";

/**
 * How many model calls may be in flight at once.
 *
 * Not a runtime limit: once the Rust side runs these on the blocking pool,
 * tokio's workers are no longer the constraint. This is politeness toward the
 * provider, which is either a CLI spawning a real process per call or an API
 * with a rate limit. Exported so a future setting can drive it.
 */
export const AI_HUNK_CONCURRENCY = 3;

export type HunkAiState = "idle" | "queued" | "loading" | "ready" | "error";

interface Entry {
  state: HunkAiState;
  suggestion: AISuggestion | null;
  error: string | null;
}

export interface AiHunkRequest {
  index: number;
  hunk: ConflictHunk;
}

const EMPTY: Entry = { state: "idle", suggestion: null, error: null };

export function useAiHunkQueue(filePath: () => string) {
  const { suggest } = useAIProvider();

  const entries = ref<Record<number, Entry>>({});
  const queue = ref<AiHunkRequest[]>([]);
  const inFlight = ref(0);

  /**
   * Bumped by `cancelAll` and `reset`. A run whose generation no longer
   * matches discards its result instead of writing it: a request already
   * handed to the provider cannot be unsubscribed, so this is what makes the
   * cancel correct rather than cosmetic.
   */
  let generation = 0;

  function entryFor(index: number): Entry {
    return entries.value[index] ?? EMPTY;
  }

  function patch(index: number, next: Partial<Entry>): void {
    entries.value = { ...entries.value, [index]: { ...entryFor(index), ...next } };
  }

  function stateFor(index: number): HunkAiState {
    return entryFor(index).state;
  }

  function suggestionFor(index: number): AISuggestion | null {
    return entryFor(index).suggestion;
  }

  function errorFor(index: number): string | null {
    return entryFor(index).error;
  }

  const pending = computed(() => queue.value.length);
  const isRunning = computed(() => inFlight.value > 0 || queue.value.length > 0);

  const summary = computed(() => {
    let ready = 0;
    let error = 0;
    for (const e of Object.values(entries.value)) {
      if (e.state === "ready") ready += 1;
      else if (e.state === "error") error += 1;
    }
    return { ready, error };
  });

  /** Resolvers for the promises handed back by `request`. */
  const settlers = new Map<number, Array<() => void>>();

  function settle(index: number): void {
    const list = settlers.get(index);
    if (!list) return;
    settlers.delete(index);
    for (const fn of list) fn();
  }

  function request(index: number, hunk: ConflictHunk): Promise<void> {
    const current = stateFor(index);
    if (current === "queued" || current === "loading") {
      return new Promise<void>((resolve) => {
        settlers.set(index, [...(settlers.get(index) ?? []), resolve]);
      });
    }
    const done = new Promise<void>((resolve) => {
      settlers.set(index, [...(settlers.get(index) ?? []), resolve]);
    });
    patch(index, { state: "queued", error: null });
    queue.value = [...queue.value, { index, hunk }];
    pump();
    return done;
  }

  function requestAll(items: AiHunkRequest[]): void {
    for (const item of items) {
      // A hunk that already has an answer is not asked again: running the
      // batch twice should not re-buy suggestions already staged.
      if (stateFor(item.index) === "ready") continue;
      void request(item.index, item.hunk);
    }
  }

  function pump(): void {
    while (inFlight.value < AI_HUNK_CONCURRENCY && queue.value.length > 0) {
      const [next, ...rest] = queue.value;
      queue.value = rest;
      void run(next);
    }
  }

  async function run(item: AiHunkRequest): Promise<void> {
    const gen = generation;
    inFlight.value += 1;
    patch(item.index, { state: "loading" });

    const ctx: ConflictContext = {
      filePath: filePath(),
      base: item.hunk.baseLines?.join("\n") ?? "",
      ours: item.hunk.oursLines.join("\n"),
      theirs: item.hunk.theirsLines.join("\n"),
    };

    try {
      const suggestion = await suggest(ctx);
      if (gen !== generation) return;
      patch(item.index, { state: "ready", suggestion, error: null });
    } catch (err: unknown) {
      if (gen !== generation) return;
      patch(item.index, {
        state: "error",
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      // A cancelled run does not touch the counter: `cancelAll` already zeroed
      // it, and decrementing here would drive it negative and leave
      // `isRunning` wrong for the next batch.
      if (gen === generation) {
        inFlight.value -= 1;
        pump();
      }
      settle(item.index);
    }
  }

  function cancelAll(): void {
    generation += 1;
    queue.value = [];
    inFlight.value = 0;
    const next: Record<number, Entry> = { ...entries.value };
    for (const [key, e] of Object.entries(next)) {
      if (e.state === "queued" || e.state === "loading") {
        next[Number(key)] = { state: "idle", suggestion: null, error: null };
      }
    }
    entries.value = next;
    for (const index of [...settlers.keys()]) settle(index);
  }

  function dismiss(index: number): void {
    patch(index, { state: "idle", suggestion: null, error: null });
  }

  function reset(): void {
    generation += 1;
    queue.value = [];
    inFlight.value = 0;
    entries.value = {};
    for (const index of [...settlers.keys()]) settle(index);
  }

  return {
    stateFor,
    suggestionFor,
    errorFor,
    inFlight: inFlight as Ref<number>,
    pending: pending as ComputedRef<number>,
    isRunning: isRunning as ComputedRef<boolean>,
    summary,
    request,
    requestAll,
    cancelAll,
    dismiss,
    reset,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/desktop && pnpm vitest run src/composables/__tests__/useAiHunkQueue.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/composables/useAiHunkQueue.ts apps/desktop/src/composables/__tests__/useAiHunkQueue.test.ts
git commit -m "feat(desktop): per-hunk AI queue with a bounded pool and a real cancel"
```

---

### Task 3: Wire the merge editor to the queue

**Files:**
- Modify: `apps/desktop/src/components/MergeEditor.vue` (the AI block at `:85-118`, the inline action row at `:1030-1095`)
- Test: `apps/desktop/src/components/__tests__/MergeEditor-ai-queue.test.ts`

**Interfaces:**
- Consumes: everything `useAiHunkQueue` produces in Task 2.
- Produces: nothing new for later tasks beyond the queue instance being in scope, which Task 4's bulk bar uses.

**Context.** `MergeEditor.vue` currently holds `aiSuggestionHunkIndex`, `aiSuggestionContent` and `aiSuggestionExplanation` as single refs (`:86-88`) and `requestAISuggestion` (`:91`) writes into them, then sets `editContent` and `editingHunkIndex` so the inline editor opens pre-filled. Keep that single-hunk behaviour: clicking AI on one hunk should still open its editor with the suggestion in it. What changes is that the state is keyed per hunk, and that a hunk which is queued or loading has its own actions disabled.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/components/__tests__/MergeEditor-ai-queue.test.ts`:

```ts
// @vitest-environment jsdom
/**
 * Issue #196: the AI action gave almost no feedback while it ran, and nothing
 * stopped a second click landing on another hunk mid-flight. This guards the
 * two visible halves of the fix: a hunk that is working shows it and refuses
 * further clicks, and a suggestion lands in the hunk it belongs to.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createApp, nextTick, type App } from "vue";
import type { ConflictFile } from "../../composables/useGitWand";
import type { ConflictHunk } from "@gitwand/core";

const suggest = vi.fn();
vi.mock("../../composables/useAIProvider", () => ({
  useAIProvider: () => ({
    isAvailable: { value: true },
    isLoading: { value: false },
    lastError: { value: null },
    suggest,
  }),
}));

import MergeEditor from "../MergeEditor.vue";

function complexHunk(n: number): ConflictHunk {
  return {
    baseLines: [`base${n}`],
    oursLines: [`ours${n}`],
    theirsLines: [`theirs${n}`],
    startLine: n + 1,
    type: "complex",
    confidence: {
      score: 20,
      label: "low",
      dimensions: { typeClassification: 20, dataRisk: 80, scopeImpact: 0, fileFrequency: 0, baseAvailability: 0 },
      boosters: [],
      penalties: [],
    },
    explanation: "manual resolution required",
    trace: { steps: [], selected: "complex", summary: "test", hasBase: true },
  } as unknown as ConflictHunk;
}

/**
 * Build the same `ConflictFile` shape the other MergeEditor tests use. Copy
 * the fixture from `MergeEditor-ai-sparkle.test.ts` rather than inventing a
 * new one, so all the merge-editor tests fail together if that shape changes.
 */
function fileWith(hunks: ConflictHunk[]): ConflictFile {
  // See MergeEditor-ai-sparkle.test.ts for the full fixture this mirrors.
  throw new Error("replace with the fixture copied from MergeEditor-ai-sparkle.test.ts");
}

describe("MergeEditor AI queue", () => {
  let app: App | null = null;
  let host: HTMLDivElement;

  beforeEach(() => {
    suggest.mockReset();
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  afterEach(() => {
    app?.unmount();
    app = null;
    host.remove();
  });

  it("disables a hunk's AI action while that hunk is working", async () => {
    let release!: (v: unknown) => void;
    suggest.mockReturnValue(new Promise((res) => { release = res; }));

    app = createApp(MergeEditor, { file: fileWith([complexHunk(0), complexHunk(1)]), cwd: "/repo" });
    app.mount(host);
    await nextTick();

    const aiLinks = [...host.querySelectorAll(".inline-action--ai")] as HTMLElement[];
    expect(aiLinks.length).toBeGreaterThanOrEqual(2);

    aiLinks[0].click();
    await nextTick();

    expect(aiLinks[0].className).toContain("inline-action--loading");
    expect(aiLinks[0].getAttribute("aria-disabled")).toBe("true");
    // A second click on the same hunk must not reach the provider again.
    aiLinks[0].click();
    await nextTick();
    expect(suggest).toHaveBeenCalledTimes(1);

    release({ resolvedContent: "merged", explanation: "why", confidence: "high" });
  });
});
```

Note on the fixture: `fileWith` throws on purpose in this draft. Your first action in Step 3 is to replace it with the real fixture, copied from `MergeEditor-ai-sparkle.test.ts`, which already builds a valid `ConflictFile` around `complexHunk()`. Do not invent a different shape.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/desktop && pnpm vitest run src/components/__tests__/MergeEditor-ai-queue.test.ts`
Expected: FAIL on the fixture placeholder, then, once the fixture is real, FAIL on the missing `aria-disabled`.

- [ ] **Step 3: Replace the AI state block in the component**

Remove `aiSuggestionHunkIndex`, `aiSuggestionContent`, `aiSuggestionExplanation` and the body of `requestAISuggestion` (`MergeEditor.vue:86-113`). Replace with:

```ts
const aiQueue = useAiHunkQueue(() => props.file.path);

// A different file means different hunk indices; keeping the old map would
// show one file's suggestions against another's conflicts.
watch(() => props.file.path, () => aiQueue.reset());

async function requestAISuggestion(hunkIndex: number, hunk: ConflictHunk) {
  const state = aiQueue.stateFor(hunkIndex);
  if (state === "queued" || state === "loading") return;

  await aiQueue.request(hunkIndex, hunk);

  // Single-hunk behaviour is unchanged: the editor opens pre-filled so the
  // user reviews before confirming. The batch deliberately does NOT do this,
  // since only one hunk can be open at a time.
  const suggestion = aiQueue.suggestionFor(hunkIndex);
  if (suggestion && aiQueue.stateFor(hunkIndex) === "ready") {
    editContent.value = suggestion.resolvedContent;
    editingHunkIndex.value = hunkIndex;
  }
}

function dismissAISuggestion(hunkIndex: number) {
  aiQueue.dismiss(hunkIndex);
}
```

Add the import beside the other composable imports:

```ts
import { useAiHunkQueue } from "../composables/useAiHunkQueue";
```

- [ ] **Step 4: Update the template bindings**

In the inline action row (`MergeEditor.vue:1033-1045`), replace every `aiLoading && aiSuggestionHunkIndex === seg.hunkIndex` with the hunk's own state, and stop the click when it is busy:

```html
<a
  class="inline-action inline-action--ai"
  :class="{ 'inline-action--loading': aiBusy(seg.hunkIndex!) }"
  :aria-disabled="aiBusy(seg.hunkIndex!) ? 'true' : 'false'"
  href="#"
  @click.prevent="requestAISuggestion(seg.hunkIndex!, hunkForSegment(seg)!)"
>
  <AiSparkle :size="12" :animated="aiBusy(seg.hunkIndex!)" />
  {{ aiBusy(seg.hunkIndex!) ? t('mergeEditor.aiLoading') : t('mergeEditor.aiButton') }}
</a>
```

with this helper next to the others in the script block:

```ts
function aiBusy(hunkIndex: number): boolean {
  const s = aiQueue.stateFor(hunkIndex);
  return s === "queued" || s === "loading";
}
```

The error banner at `:1080` and the explanation banner at `:1086` switch from the shared refs to `aiQueue.errorFor(seg.hunkIndex!)` and `aiQueue.suggestionFor(seg.hunkIndex!)?.explanation`. The label at `:1108` uses `aiQueue.stateFor(seg.hunkIndex!) === 'ready'` in place of the index comparison.

Add a rule so a busy hunk's whole action row reads as unavailable:

```css
.inline-action[aria-disabled="true"] {
  opacity: 0.55;
  pointer-events: none;
}
```

- [ ] **Step 5: Run the tests**

Run: `cd apps/desktop && pnpm vitest run src/components/__tests__/MergeEditor-ai-queue.test.ts src/components/__tests__/MergeEditor-ai-sparkle.test.ts`
Expected: PASS both. The sparkle test must still pass: it guards the icon binding, which this task rewrites.

Run: `cd apps/desktop && pnpm test && pnpm build`
Expected: full suite green, `vue-tsc` clean.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/components/MergeEditor.vue apps/desktop/src/components/__tests__/MergeEditor-ai-queue.test.ts
git commit -m "fix(desktop): key AI suggestions to their own hunk and show per-hunk progress"
```

---

### Task 4: Resolve all with AI

**Files:**
- Modify: `apps/desktop/src/components/MergeEditor.vue` (the bulk bar at `:786-792`)
- Modify: `apps/desktop/src/locales/{en,fr,es,pt-BR,zh-CN}.ts`
- Test: `apps/desktop/src/components/__tests__/MergeEditor-ai-queue.test.ts` (extend)

**Interfaces:**
- Consumes: the `aiQueue` instance from Task 3.
- Produces: nothing for later tasks.

**Context.** The bulk bar currently holds three buttons calling `bulkResolve('ours' | 'theirs' | 'both')` (`:786-792`), each emitting `resolveFileBulk`. The AI entry does NOT emit that: it stages suggestions and applies nothing, per the spec's section 3.1.

- [ ] **Step 1: Write the failing test**

Append to `MergeEditor-ai-queue.test.ts`:

```ts
  it("stages every unresolved hunk and applies nothing", async () => {
    suggest.mockResolvedValue({ resolvedContent: "merged", explanation: "why", confidence: "high" });

    const file = fileWith([complexHunk(0), complexHunk(1), complexHunk(2)]);
    app = createApp(MergeEditor, { file, cwd: "/repo" });
    app.mount(host);
    await nextTick();

    const bulkAi = host.querySelector(".me-bulk-btn--ai") as HTMLElement;
    expect(bulkAi).toBeTruthy();
    bulkAi.click();
    await vi.waitFor(() => expect(suggest).toHaveBeenCalledTimes(3));

    // Staged, not applied: the file's merged content is untouched.
    expect(file.result.merged).toBe(fileWith([complexHunk(0)]).result.merged);
  });

  it("offers a cancel while the batch runs", async () => {
    suggest.mockReturnValue(new Promise(() => {}));
    app = createApp(MergeEditor, { file: fileWith([complexHunk(0), complexHunk(1)]), cwd: "/repo" });
    app.mount(host);
    await nextTick();

    (host.querySelector(".me-bulk-btn--ai") as HTMLElement).click();
    await nextTick();

    const btn = host.querySelector(".me-bulk-btn--ai") as HTMLElement;
    expect(btn.textContent).toContain("Cancel");
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/desktop && pnpm vitest run src/components/__tests__/MergeEditor-ai-queue.test.ts`
Expected: FAIL, `.me-bulk-btn--ai` does not exist.

- [ ] **Step 3: Add the bulk entry**

In the bulk bar, after the Both button:

```html
<button
  v-if="aiAvailable"
  class="me-bulk-btn me-bulk-btn--ai"
  @click="aiQueue.isRunning.value ? aiQueue.cancelAll() : resolveAllWithAi()"
>
  <AiSparkle :size="12" :animated="aiQueue.isRunning.value" />
  {{ aiQueue.isRunning.value
      ? `${t('merge.bulkAiCancel')} (${aiBatchProgress})`
      : t('merge.bulkAi') }}
</button>
<span v-if="aiBatchSummary" class="me-bulk-ai-summary muted">{{ aiBatchSummary }}</span>
```

and in the script block:

```ts
/** Unresolved hunks only: a hunk already staged or resolved is not re-asked. */
function resolveAllWithAi() {
  const items = hunks.value
    .map((hunk, index) => ({ index, hunk }))
    .filter(({ index }) => aiQueue.stateFor(index) !== "ready");
  aiQueue.requestAll(items);
}

const aiBatchProgress = computed(() => {
  const total = hunks.value.length;
  const left = aiQueue.pending.value + aiQueue.inFlight.value;
  return t("merge.bulkAiProgress", [String(total - left), String(total)]);
});

/** Shown once a batch has finished and at least one hunk failed. */
const aiBatchSummary = computed(() => {
  if (aiQueue.isRunning.value) return "";
  const { ready, error } = aiQueue.summary.value;
  if (error === 0) return "";
  return t("merge.bulkAiSummary", [String(ready), String(error)]);
});
```

- [ ] **Step 4: Add the locale keys**

In each of the five locale files, in the `merge:` section next to `bulkBoth`:

```ts
    bulkAi: "AI",
    bulkAiCancel: "Cancel",
    bulkAiProgress: "{0} of {1}",
    bulkAiSummary: "{0} resolved, {1} failed",
```

French: `"IA"`, `"Annuler"`, `"{0} sur {1}"`, `"{0} résolus, {1} en échec"`.
Spanish: `"IA"`, `"Cancelar"`, `"{0} de {1}"`, `"{0} resueltos, {1} con error"`.
Portuguese (Brazil): `"IA"`, `"Cancelar"`, `"{0} de {1}"`, `"{0} resolvidos, {1} com erro"`.
Chinese (Simplified): `"AI"`, `"取消"`, `"{0} / {1}"`, `"{0} 个已解决，{1} 个失败"`.

- [ ] **Step 5: Run everything**

Run: `cd apps/desktop && pnpm vitest run src/components/__tests__/MergeEditor-ai-queue.test.ts`
Expected: PASS, 4 tests.

Run: `cd apps/desktop && pnpm test && pnpm build`
Expected: full suite green, `vue-tsc` clean.

Run: `grep -c "bulkAi" src/locales/*.ts`
Expected: 4 in every one of the five files.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/components/MergeEditor.vue apps/desktop/src/components/__tests__/MergeEditor-ai-queue.test.ts apps/desktop/src/locales/
git commit -m "feat(desktop): resolve all conflicts with AI, staged for review"
```

---

### Task 5: Manual check and bookkeeping

**Files:**
- Modify: `ROADMAP.md`, `CHANGELOG.md`

- [ ] **Step 1: Drive it against a real provider**

```bash
cd apps/desktop && pnpm dev:web
```

Open a repo with at least four conflicted hunks in one file. Click AI on one hunk: it greys out, the sparkle animates, the editor opens pre-filled when it answers. Click AI on hunk A and immediately on hunk B: each answer lands in its own hunk, which is the bug this fixes. Run "AI" in the bulk bar: progress counts up, at most three calls are in flight (watch the provider or the network panel), the button offers Cancel, and cancelling leaves no hunk stuck in a loading state. Confirm the app stays responsive throughout: switch views, let the sidebar refresh.

Record what you saw in the commit message or the PR body. If the app does NOT stay responsive during a batch, stop and report: that contradicts the spec's reasoning and the design needs revisiting rather than patching.

- [ ] **Step 2: Update the roadmap**

Under "Later (unscheduled)", add:

```markdown
- **Hard cancel for an in-flight AI call** (deferred from the issue #196 work): cancelling a hunk or a batch marks the entries idle and discards late results, but an already-spawned `claude -p` keeps running to completion. Killing it needs a Rust command holding the process handle plus a way to address it from the frontend, which is its own piece of work.
```

- [ ] **Step 3: Update the changelog**

Under `## [Unreleased]`, in `### Fixed`:

```markdown
- **AI conflict resolution no longer collides with itself** (#196). Requesting a suggestion for a second hunk while the first was still running overwrote a single shared index, so the first answer was applied to the wrong hunk. State is now keyed per hunk, a hunk that is working greys out and refuses further clicks, and the eight AI commands run on the blocking pool instead of pinning tokio workers that every other IPC call shares.
```

and in `### Added`:

```markdown
- **Resolve all conflicts with AI** (#196). A fourth entry in the "Accept all:" bar asks the model for every unresolved hunk in the file, at most three at a time, with progress and a cancel. Suggestions are staged for review rather than applied: the confidence stance the engine is built on does not change because the request came in a batch.
```

- [ ] **Step 4: Commit**

```bash
git add ROADMAP.md CHANGELOG.md
git commit -m "docs: record the AI hunk queue work and its deferred hard cancel"
```

---

## Self-Review

**Spec coverage.** Section 1's threading finding is Task 1. Section 3.1 staging is Task 4 (the bulk entry applies nothing) and Task 3 (single-hunk keeps the review-before-confirm editor). Section 3.2 composable extraction is Task 2. Section 3.3 concurrency of 3 is `AI_HUNK_CONCURRENCY` in Task 2, asserted by its test. Section 3.4 soft cancel is the generation counter in Task 2 and the cancel button in Task 4. Section 4.1's contract is Task 2's return object. Section 4.2's skip-if-ready is in `requestAll` and its test. Section 5's per-hunk disabling is Task 3, the bulk bar and progress are Task 4. Section 5's partial-failure line is `aiBatchSummary` in Task 4. Section 6's per-hunk errors are covered by Task 2's failure test. Section 7's manual check is Task 5. The collision bug from section 1 is covered by Task 2's "writes a response to the hunk it was requested for" test.

**Placeholder scan.** One deliberate placeholder remains: `fileWith` in Task 3's test throws with an instruction to copy the fixture from `MergeEditor-ai-sparkle.test.ts`. That is intentional rather than a gap, because duplicating a 60-line `ConflictFile` fixture into this plan would rot the moment the shape changes, and the instruction names the exact file to copy from. Every other step carries its real content.

**Type consistency.** `stateFor`, `suggestionFor`, `errorFor`, `request`, `requestAll`, `cancelAll`, `dismiss`, `reset`, `inFlight`, `pending`, `isRunning` and `summary` are named identically in the spec's section 4.1, Task 2's interface block, Task 2's implementation, and their uses in Tasks 3 and 4. `HunkAiState` values (`idle`, `queued`, `loading`, `ready`, `error`) match across the same four places. `AISuggestion` is used with the field `resolvedContent` everywhere, matching `useAIProvider.ts:102`.

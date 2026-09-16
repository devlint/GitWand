# AI hunk resolution: responsiveness and batch: design

**Date:** 2026-09-17
**Issue:** [#196](https://github.com/devlint/GitWand/issues/196) ("Resolve PR chunk with AI freeze the app until it finish", plus its "Resolve All with AI" follow-up)
**Out of scope:** [#197](https://github.com/devlint/GitWand/issues/197) (abort merge does nothing) is a separate bug with its own investigation.

---

## 1. What the issue reports, and what the code actually shows

The report says clicking the AI button on a conflict hunk freezes the app until the model answers, and asks for three things: run it in the background, disable the other buttons while it runs, and grey out the section with a loading animation. A second section proposes a "Resolve All with AI" entry in the existing "Accept all:" bar.

I could not reproduce a whole-app freeze, and the design is built on what is actually there rather than on the word "freeze".

**There is no frontend blocking mechanism.** `aiLoading` is consumed in exactly one place, `MergeEditor.vue:1037-1042`, where it styles one button and swaps its label. Nothing is disabled, there is no overlay, and no other component reads it.

**One blocked worker cannot stall the app.** Tauri's async runtime is a default multi-threaded tokio (`TokioRuntime::new()` in `tauri-2.11.5/src/async_runtime.rs:223`), which is 11 worker threads on the development machine. A single blocking AI call occupies one of them.

**But the blocking pattern is real.** All eight async commands in `commands/ai.rs` call `.output()` inline (16 call sites, zero `spawn_blocking`, against four in `ops.rs`). `claude_cli_prompt` (`ai.rs:168`) is the one behind the reported button. One at a time is survivable. N at a time is not, and N at a time is exactly what the batch feature introduces: at 11 concurrent calls every worker is blocked and every other IPC command, git status and refresh included, queues behind them. The freeze the issue describes is latent today and would become real the moment "Resolve All" ships on the current code.

**There is a genuine bug next to the report.** `requestAISuggestion` (`MergeEditor.vue:91`) has no guard against a second invocation, and `aiSuggestionHunkIndex` is a single ref. Clicking the AI button on hunk B while hunk A is in flight overwrites the index, so A's response is applied to B: it fills `editContent` and opens the editor on the wrong hunk. This is probably part of what the reporter experienced, and it is fixed by the same per-hunk state the batch needs.

So the perceived freeze is a long wait with weak feedback (a 12px sparkle), no way to cancel, and a result that can land on the wrong hunk. The actual freeze is a threading defect waiting for a batch to trigger it.

## 2. Scope

**In scope.** Per-hunk AI state so requests cannot collide; visible per-hunk loading with the hunk's own actions disabled while it runs; a soft cancel; the `spawn_blocking` fix across `commands/ai.rs`; and "Resolve All with AI" as a fourth entry in the "Accept all:" bar, staging suggestions for review.

**Out of scope.** Issue #197. Hard cancellation that kills an in-flight CLI process. Auto-applying AI output. Any change to prompt content, provider selection or response parsing.

## 3. Decisions

### 3.1 Suggestions are staged, never auto-applied

The issue asks for a trigger that "automatically accepts the responses". This design stages instead: each hunk receives its suggestion in its edit area, marked as an AI proposal, and the user confirms per hunk or with the existing Accept All. One extra click, and it keeps the stance the rest of the app is built on, where `minConfidenceScore`, the label gate and the v3.11 per-hunk opt-out all exist to stop unreviewed content entering a merge.

Rejected: applying every suggestion directly with an undo (puts unreviewed model output into a merge); applying above a confidence threshold (the right shape eventually, but the AI path produces no score comparable to the engine's today, so the gate would be decorative).

### 3.2 The state machine lives in a composable, not the component

`MergeEditor.vue` is 1974 lines. The queue, the per-hunk state and the failure handling go in a new `composables/useAiHunkQueue.ts`, which the component renders from. This follows the repo's own rule that business logic lives in composables, and it makes the cases that matter testable without a DOM: three of ten failing, a cancel mid-flight, a second request for a hunk already in flight.

Rejected: inline in the component (grows a file that is already too large, and the interesting states are then reachable only through the DOM); batching in Rust (prompt building, provider selection and parsing are all in TypeScript, so this moves logic across the IPC boundary for no user-visible gain).

### 3.3 Three concurrent requests by default

Once `spawn_blocking` lands, the tokio workers are no longer the constraint and the limit exists for the provider: the CLI providers spawn a real process per call, and the API providers have rate limits. Three is low enough to be polite to both and high enough to feel parallel. The constant is named and exported so a future setting can drive it, but no setting is added now.

### 3.4 Cancel is soft

Cancelling marks queued hunks idle, stops the queue from starting more, and discards results that arrive afterwards. It does not kill an in-flight `claude -p`. Real cancellation needs a Rust command that holds a process handle and kills it, which is its own piece of work; it goes to the roadmap as a follow-up rather than riding along here.

## 4. Architecture

| Layer | File | Change |
|---|---|---|
| Rust | `src-tauri/src/commands/ai.rs` | The blocking body of each of the 8 async commands moves into `tauri::async_runtime::spawn_blocking` |
| Composable | `src/composables/useAiHunkQueue.ts` | New: per-hunk state machine and bounded queue |
| Component | `src/components/MergeEditor.vue` | Renders from the composable; per-hunk loading and disabled actions; "AI" entry in the bulk bar; batch progress |
| i18n | `src/locales/{en,fr,es,pt-BR,zh-CN}.ts` | New keys for the batch entry, progress, partial failure and cancel |
| Tests | `src/composables/__tests__/useAiHunkQueue.test.ts` | New: queue, concurrency, failures, cancel |
| Tests | `src/components/__tests__/MergeEditor-ai-queue.test.ts` | New: per-hunk rendering and disabled state |

### 4.1 The composable's contract

```ts
type HunkAiState = "idle" | "queued" | "loading" | "ready" | "error";

interface AiHunkQueue {
  stateFor(hunkIndex: number): HunkAiState;
  suggestionFor(hunkIndex: number): AISuggestion | null;
  errorFor(hunkIndex: number): string | null;
  inFlight: Ref<number>;
  pending: Ref<number>;
  isRunning: ComputedRef<boolean>;
  request(hunkIndex: number, hunk: ConflictHunk): void;
  requestAll(hunks: Array<{ index: number; hunk: ConflictHunk }>): void;
  cancelAll(): void;
  dismiss(hunkIndex: number): void;
}
```

Everything is keyed by hunk index, which is what removes the collision in section 1: a response is written to the entry it was requested for, never to "the current one". `request` on a hunk already `queued` or `loading` is a no-op rather than a second call.

### 4.2 The queue

A bounded pool with `AI_HUNK_CONCURRENCY = 3`. `requestAll` marks every unresolved hunk `queued` and starts up to three; each completion starts the next. A hunk that is already `ready` is skipped, so running the batch twice does not re-ask for answers already staged.

Cancellation is a generation counter: `cancelAll` increments it, and a result whose generation no longer matches is discarded. That is what makes the soft cancel correct rather than merely cosmetic, because a promise that has already been handed to the provider cannot be unsubscribed.

## 5. Interface

**Per hunk.** The action row for a hunk that is `queued` or `loading` is greyed and its actions are disabled, including its own AI entry, so a hunk cannot be requested twice and the user cannot accept a hunk whose suggestion is still arriving. The animated sparkle already exists and stays. `error` shows the existing error banner with a retry.

**Bulk bar.** A fourth button next to Current, Incoming and Both. While a batch runs it becomes a cancel, with progress beside it ("4 of 12"). The button is absent when no provider is configured, matching the per-hunk `aiAvailable` check.

**Partial failure.** The batch never aborts on a failure. When it finishes, hunks that failed keep their error banner, and a single line reports the split ("9 resolved, 3 failed"). The user retries individually.

## 6. Error handling

A provider error fails one hunk, never the batch. The error text is the provider's own, as today. A provider that is entirely unavailable is already handled upstream by `aiAvailable`, which hides the affordance.

The `spawn_blocking` change is a pure threading move: the same errors surface with the same strings, since only where the work runs changes.

## 7. Testing

- `useAiHunkQueue.test.ts`, with a mocked `suggest`: a single request transitions idle to loading to ready; two requests for the same hunk call the provider once; a batch of ten with a concurrency of three never exceeds three in flight; a mid-batch failure leaves that hunk in `error` and the rest completing; `cancelAll` discards results that arrive after it and leaves no hunk in `loading`; a result from a cancelled generation is not written.
- `MergeEditor-ai-queue.test.ts`: a loading hunk renders disabled actions; a ready hunk pre-fills its own edit area and no other.
- Rust: no new tests. The change is a threading move with no behavioural surface of its own, and the existing AI command tests still cover the commands.
- Manual check in `pnpm dev:web` against a real provider, watching that the app stays responsive during a batch of at least four.

## 8. Risks

- **The freeze may not be what the reporter meant.** The evidence says the single-hunk case cannot stall the app, so if the responsiveness complaint survives this change, the next suspect is the provider call itself being slow rather than blocking, and the answer is cancellation rather than concurrency.
- **Cost.** A batch of twelve hunks is twelve model calls. The progress indicator makes that visible before it is paid for, but nothing caps it.
- **`spawn_blocking` is untested by construction.** Worker starvation appears only under concurrency with a slow provider, which no test in this repo can stage. The argument for it is the convention already followed in `ops.rs`, not a failing test.

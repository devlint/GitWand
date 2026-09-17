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

/**
 * Maps each of `keys` to the index it carries after a resolution consumed
 * `appliedIndices`.
 *
 * Same arithmetic as `useResolutionSelection.remapAfterApply`, and the same
 * rules: the surviving conflict blocks keep their relative order, so an old
 * index becomes its rank among the survivors, and a key whose own hunk was
 * consumed has nothing left to point at and is absent from the result rather
 * than allowed to land on its neighbour.
 *
 * Pure and exported so it is testable without a component, and so the
 * component can renumber its own index-keyed sets (the AI batch's membership)
 * with the very same function the queue uses on its entries.
 */
export function remapHunkIndices(
  keys: Iterable<number>,
  appliedIndices: Iterable<number>,
): Map<number, number> {
  const applied = [...appliedIndices];
  const consumed = new Set(applied);
  const out = new Map<number, number>();
  for (const key of keys) {
    if (consumed.has(key)) continue;
    let shift = 0;
    for (const a of applied) if (a < key) shift += 1;
    out.set(key, key - shift);
  }
  return out;
}

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
   * Bumped by `cancelAll`, `reset` and `remapAfterApply`. A run whose
   * generation no longer matches discards its result instead of writing it:
   * a request already handed to the provider cannot be unsubscribed, so this
   * is what makes the cancel correct rather than cosmetic, and what makes a
   * renumbering safe.
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

  /**
   * Resolves once every hunk this call queued has settled, one way or
   * another, including when `cancelAll` settles them early. The caller needs
   * that edge to know when its batch is over, rather than watching a derived
   * "is anything still running" flag that a later unrelated request can
   * re-raise.
   */
  function requestAll(items: AiHunkRequest[]): Promise<void> {
    const started: Array<Promise<void>> = [];
    for (const item of items) {
      // A hunk that already has an answer is not asked again: running the
      // batch twice should not re-buy suggestions already staged.
      if (stateFor(item.index) === "ready") continue;
      started.push(request(item.index, item.hunk));
    }
    return Promise.all(started).then(() => undefined);
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
      // A cancelled run touches nothing: `cancelAll` already zeroed the
      // counter (decrementing here would drive it negative and leave
      // `isRunning` wrong for the next batch) and already settled every
      // outstanding promise. Settling from here too would resolve whatever
      // resolver a NEWER request for the same index registered in the
      // meantime, so its caller would wake up on a stale answer, read the
      // hunk as still loading and give up: the retry would never open.
      if (gen === generation) {
        inFlight.value -= 1;
        pump();
        settle(item.index);
      }
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

  /**
   * Renumber after a resolution consumed `appliedIndices`, instead of
   * discarding everything.
   *
   * Settled entries (`ready` and `error`) are what survives: they are plain
   * data about a hunk that is still there, only under a new index. Anything
   * still in flight is discarded, conservatively: a run already handed to the
   * provider captured its index in its closure, so after the renumbering its
   * answer would be written onto the wrong hunk. Bumping the generation is
   * exactly how `cancelAll` already makes those answers land nowhere, so this
   * reuses that rather than adding an indirection layer between a run and the
   * hunk it is for. Keeping in-flight work alive across a renumbering is a
   * separate change (the run would have to carry a token the queue resolves
   * to an index at write time).
   *
   * Still a strict improvement on `reset`, which drops staged answers the
   * user already paid for along with the in-flight ones.
   */
  function remapAfterApply(appliedIndices: number[]): void {
    generation += 1;
    queue.value = [];
    inFlight.value = 0;

    const moved = remapHunkIndices(
      Object.keys(entries.value).map(Number),
      appliedIndices,
    );
    const next: Record<number, Entry> = {};
    for (const [old, fresh] of moved) {
      const entry = entryFor(old);
      if (entry.state === "ready" || entry.state === "error") next[fresh] = entry;
    }
    entries.value = next;

    for (const index of [...settlers.keys()]) settle(index);
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
    remapAfterApply,
    reset,
  };
}

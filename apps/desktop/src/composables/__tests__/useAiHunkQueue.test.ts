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

import { useAiHunkQueue, AI_HUNK_CONCURRENCY, remapHunkIndices } from "../useAiHunkQueue";

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

    const first = q.request(0, hunk(0));
    // A duplicate while the first is in flight must not reach the provider. It
    // joins the original rather than starting a second call, so it cannot be
    // awaited before the original is allowed to settle.
    const duplicate = q.request(0, hunk(0));
    expect(suggest).toHaveBeenCalledTimes(1);

    d.resolve(answer("x"));
    await Promise.all([first, duplicate]);
    expect(q.stateFor(0)).toBe("ready");
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

    // `pump` dispatches synchronously, so the bound is already observable.
    expect(peak).toBe(AI_HUNK_CONCURRENCY);
    expect(q.pending.value).toBe(10 - AI_HUNK_CONCURRENCY);

    // Each completion starts the next queued call, so the pending list refills
    // as it drains. Resolving a one-time snapshot would strand the rest.
    for (let guard = 0; guard < 50 && (pendings.length > 0 || q.isRunning.value); guard += 1) {
      for (const d of pendings.splice(0)) d.resolve(answer("ok"));
      await Promise.resolve();
      await Promise.resolve();
    }

    expect(suggest).toHaveBeenCalledTimes(10);
    expect(q.isRunning.value).toBe(false);
    expect(peak).toBeLessThanOrEqual(AI_HUNK_CONCURRENCY);
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

  it("does not let a cancelled run settle a later request for the same hunk", async () => {
    // The user cancels, then asks again for the same hunk. The first call is
    // already with the provider and cannot be unsubscribed, so it answers
    // while the second is still in flight. Its answer must land nowhere: if
    // it settles the SECOND request's promise, the caller wakes up, reads the
    // hunk as still loading and gives up, and the retry never opens.
    const stale = deferred<ReturnType<typeof answer>>();
    const fresh = deferred<ReturnType<typeof answer>>();
    suggest.mockReturnValueOnce(stale.promise).mockReturnValueOnce(fresh.promise);
    const q = useAiHunkQueue(() => "a.ts");

    const cancelled = q.request(0, hunk(0));
    q.cancelAll();
    await cancelled;

    const retry = q.request(0, hunk(0));
    let retrySettled = false;
    void retry.then(() => { retrySettled = true; });

    stale.resolve(answer("stale"));
    for (let i = 0; i < 5; i += 1) await Promise.resolve();

    expect(retrySettled, "the stale run must not settle the retry").toBe(false);
    expect(q.stateFor(0)).toBe("loading");

    fresh.resolve(answer("fresh"));
    await retry;
    expect(q.stateFor(0)).toBe("ready");
    expect(q.suggestionFor(0)?.resolvedContent).toBe("fresh");
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

/**
 * Resolving one conflict renumbers every later one under the same path, so
 * per-hunk state that is merely carried over is attributed to the wrong hunk
 * (which is why the whole queue used to be dropped instead). Same semantics
 * as `useResolutionSelection.remapAfterApply`: survivors keep their relative
 * order, an old index becomes its rank among the survivors, and a key whose
 * own hunk was consumed is dropped rather than left pointing at a neighbour.
 */
describe("remapHunkIndices", () => {
  it("renumbers survivors and drops the consumed key", () => {
    // 1 was consumed: 0 is below it and does not move, 3 and 5 are above it
    // and each slide down by one.
    expect([...remapHunkIndices([0, 1, 3, 5], [1])]).toEqual([
      [0, 0],
      [3, 2],
      [5, 4],
    ]);
  });

  it("counts every consumed index below a survivor, not just one", () => {
    expect([...remapHunkIndices([4], [0, 2])]).toEqual([[4, 2]]);
  });

  it("changes nothing when no hunk was consumed", () => {
    expect([...remapHunkIndices([0, 2], [])]).toEqual([
      [0, 0],
      [2, 2],
    ]);
  });
});

describe("useAiHunkQueue.remapAfterApply", () => {
  beforeEach(() => { suggest.mockReset(); });

  it("keeps settled suggestions, renumbered, when an earlier hunk is resolved", async () => {
    suggest.mockImplementation((ctx: { ours: string }) => Promise.resolve(answer(`for ${ctx.ours}`)));
    const q = useAiHunkQueue(() => "a.ts");
    q.requestAll([0, 1, 2].map((i) => ({ index: i, hunk: hunk(i) })));
    await vi.waitFor(() => expect(q.isRunning.value).toBe(false));

    q.remapAfterApply([0]);

    expect(q.suggestionFor(0)?.resolvedContent, "old index 1 is the new index 0").toBe("for ours1");
    expect(q.suggestionFor(1)?.resolvedContent).toBe("for ours2");
    // The resolved hunk's own answer is gone, not shifted onto its neighbour.
    expect(q.stateFor(2)).toBe("idle");
    expect(q.summary.value).toEqual({ ready: 2, error: 0 });
  });

  it("carries a failed hunk's error across the renumbering", async () => {
    suggest.mockImplementation((ctx: { ours: string }) =>
      ctx.ours === "ours1" ? Promise.reject(new Error("model said no")) : Promise.resolve(answer("ok")),
    );
    const q = useAiHunkQueue(() => "a.ts");
    q.requestAll([0, 1].map((i) => ({ index: i, hunk: hunk(i) })));
    await vi.waitFor(() => expect(q.isRunning.value).toBe(false));

    q.remapAfterApply([0]);

    expect(q.stateFor(0)).toBe("error");
    expect(q.errorFor(0)).toBe("model said no");
  });

  it("discards work still in flight, since its answer would land on the wrong hunk", async () => {
    const d = deferred<ReturnType<typeof answer>>();
    suggest.mockReturnValue(d.promise);
    const q = useAiHunkQueue(() => "a.ts");

    const pending = q.request(1, hunk(1));
    q.remapAfterApply([0]);

    // A run already handed to the provider captured index 1 in its closure,
    // so after the renumbering it has nothing it can safely write to.
    expect(q.stateFor(0)).toBe("idle");
    expect(q.isRunning.value).toBe(false);

    d.resolve(answer("too late"));
    await pending;
    expect(q.stateFor(0)).toBe("idle");
    expect(q.suggestionFor(0)).toBeNull();
    expect(q.stateFor(1)).toBe("idle");
  });
});

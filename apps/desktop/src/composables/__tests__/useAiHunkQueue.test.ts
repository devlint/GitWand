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

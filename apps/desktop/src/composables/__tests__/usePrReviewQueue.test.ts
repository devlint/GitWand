/**
 * Task C3 (v3.6.0) — bounded, cancellable, visibility-gated queue.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { usePrReviewQueue } from "../usePrReviewQueue";
import type { GitDiff } from "../../utils/backend";
import type { ReviewFinding } from "../usePrPreReview";

function file(path: string): GitDiff {
  return { path, hunks: [] };
}

function finding(path: string): ReviewFinding {
  return { id: path, path, line: 1, side: "RIGHT", severity: "nit", confidence: 50, title: path, detail: "" };
}

function setHidden(hidden: boolean) {
  Object.defineProperty(document, "hidden", { value: hidden, configurable: true });
}

describe("usePrReviewQueue", () => {
  afterEach(() => {
    setHidden(false);
  });

  it("processes files sequentially — analyzeOne never overlaps", async () => {
    const order: string[] = [];
    let concurrent = 0;
    let maxConcurrent = 0;
    const analyzeOne = vi.fn(async (f: GitDiff) => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      order.push(f.path);
      await new Promise((r) => setTimeout(r, 1));
      concurrent--;
      return [finding(f.path)];
    });
    const { run } = usePrReviewQueue();
    const controller = new AbortController();
    const found: ReviewFinding[] = [];
    await run([file("a.ts"), file("b.ts"), file("c.ts")], analyzeOne, {
      onFinding: (f) => found.push(f),
      signal: controller.signal,
    });
    expect(order).toEqual(["a.ts", "b.ts", "c.ts"]);
    expect(maxConcurrent).toBe(1);
    expect(found.map((f) => f.path)).toEqual(["a.ts", "b.ts", "c.ts"]);
  });

  it("aborts mid-run when the signal fires", async () => {
    const controller = new AbortController();
    const analyzeOne = vi.fn(async (f: GitDiff) => {
      if (f.path === "b.ts") controller.abort();
      return [finding(f.path)];
    });
    const { run, done } = usePrReviewQueue();
    const found: ReviewFinding[] = [];
    await run([file("a.ts"), file("b.ts"), file("c.ts")], analyzeOne, {
      onFinding: (f) => found.push(f),
      signal: controller.signal,
    });
    expect(analyzeOne).toHaveBeenCalledTimes(2); // a.ts, b.ts — never reaches c.ts
    expect(found.map((f) => f.path)).toEqual(["a.ts"]); // b.ts's finding is discarded post-abort
    expect(done.value).toBe(1);
  });

  it("pauses while document.hidden and resumes once resume() is called", async () => {
    setHidden(true);
    const analyzeOne = vi.fn(async (f: GitDiff) => [finding(f.path)]);
    const { run, resume, done } = usePrReviewQueue();
    const controller = new AbortController();
    const found: ReviewFinding[] = [];

    const runPromise = run([file("a.ts")], analyzeOne, {
      onFinding: (f) => found.push(f),
      signal: controller.signal,
    });

    // Give the microtask queue a beat — the run loop should be blocked on
    // `document.hidden`, not have called analyzeOne yet.
    await new Promise((r) => setTimeout(r, 5));
    expect(analyzeOne).not.toHaveBeenCalled();
    expect(done.value).toBe(0);

    setHidden(false);
    resume();
    await runPromise;

    expect(analyzeOne).toHaveBeenCalledTimes(1);
    expect(found.map((f) => f.path)).toEqual(["a.ts"]);
  });

  it("an abort while paused on document.hidden unblocks the wait", async () => {
    setHidden(true);
    const analyzeOne = vi.fn(async (f: GitDiff) => [finding(f.path)]);
    const { run } = usePrReviewQueue();
    const controller = new AbortController();

    const runPromise = run([file("a.ts")], analyzeOne, {
      onFinding: () => {},
      signal: controller.signal,
    });
    await new Promise((r) => setTimeout(r, 5));
    controller.abort();
    await runPromise; // must resolve, not hang forever

    expect(analyzeOne).not.toHaveBeenCalled();
  });
});

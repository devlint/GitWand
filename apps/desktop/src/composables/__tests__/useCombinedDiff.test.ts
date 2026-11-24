/**
 * useCombinedDiff: loading → data, errors surfaced verbatim, stale responses
 * dropped. The fetcher is injected (the git layer is covered by the backend
 * tests); backend.ts is never mocked.
 */
import { describe, it, expect } from "vitest";
import { nextTick, ref } from "vue";
import { useCombinedDiff, type CombinedRequest } from "../useCombinedDiff";
import type { CombinedDiff, GitDiff } from "../../utils/backend";

const combined = (tag: string): CombinedDiff => ({
  base: null,
  commits: [{ hash: tag.padEnd(40, "0"), shortHash: tag, subject: `s ${tag}`, author: "A", date: "2026-01-01T00:00:00Z" }],
  diffs: [{ path: `${tag}.txt`, hunks: [], status: "modified" } as unknown as GitDiff],
  steps: [[]],
  fallback: [],
  truncated: false,
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); await nextTick(); };

describe("useCombinedDiff", () => {
  it("loads, then exposes data and entries", async () => {
    const d = deferred<CombinedDiff>();
    const calls: unknown[][] = [];
    const req = ref<CombinedRequest | null>({ hashes: ["a", "b"], paths: ["x"] });
    const c = useCombinedDiff(ref("/r"), req, (...a) => { calls.push(a); return d.promise; });
    expect(c.loading.value).toBe(true);
    expect(calls[0]).toEqual(["/r", ["a", "b"], ["x"]]);
    d.resolve(combined("aaa"));
    await flush();
    expect(c.loading.value).toBe(false);
    expect(c.data.value?.commits[0].shortHash).toBe("aaa");
    expect(c.entries.value).toHaveLength(1);
    expect(c.error.value).toBeNull();
  });

  it("surfaces the error message verbatim", async () => {
    const c = useCombinedDiff(ref("/r"), ref({ hashes: ["a", "b"] }), async () => { throw new Error("Unknown commit: abc1234"); });
    await flush();
    expect(c.error.value).toBe("Unknown commit: abc1234");
    expect(c.data.value).toBeNull();
    expect(c.loading.value).toBe(false);
  });

  it("surfaces a string rejection verbatim", async () => {
    const c = useCombinedDiff(ref("/r"), ref({ hashes: ["a", "b"] }), () => Promise.reject("Unknown commit: abc1234"));
    await flush();
    expect(c.error.value).toBe("Unknown commit: abc1234");
  });

  it("discards a stale response when the request changed", async () => {
    const first = deferred<CombinedDiff>();
    const second = deferred<CombinedDiff>();
    const queue = [first, second];
    const req = ref<CombinedRequest | null>({ hashes: ["a", "b"] });
    const c = useCombinedDiff(ref("/r"), req, () => queue.shift()!.promise);
    req.value = { hashes: ["c", "d"] };
    await nextTick();
    second.resolve(combined("new"));
    await flush();
    first.resolve(combined("old"));
    await flush();
    expect(c.data.value?.commits[0].shortHash).toBe("new");
  });

  it("a stale error does not clobber a fresh result", async () => {
    const first = deferred<CombinedDiff>();
    const second = deferred<CombinedDiff>();
    const queue = [first, second];
    const req = ref<CombinedRequest | null>({ hashes: ["a", "b"] });
    const c = useCombinedDiff(ref("/r"), req, () => queue.shift()!.promise);
    req.value = { hashes: ["c", "d"] };
    await nextTick();
    second.resolve(combined("new"));
    await flush();
    first.reject(new Error("late"));
    await flush();
    expect(c.error.value).toBeNull();
    expect(c.data.value?.commits[0].shortHash).toBe("new");
  });

  it("reload refetches and clears the error", async () => {
    let n = 0;
    const c = useCombinedDiff(ref("/r"), ref({ hashes: ["a", "b"] }), async () => {
      if (n++ === 0) throw new Error("boom");
      return combined("ok");
    });
    await flush();
    expect(c.error.value).toBe("boom");
    c.reload();
    await flush();
    expect(c.error.value).toBeNull();
    expect(c.data.value?.commits[0].shortHash).toBe("ok");
  });

  it("a null request clears everything and fetches nothing", async () => {
    let calls = 0;
    const req = ref<CombinedRequest | null>({ hashes: ["a", "b"] });
    const c = useCombinedDiff(ref("/r"), req, async () => { calls++; return combined("a"); });
    await flush();
    req.value = null;
    await flush();
    expect(c.data.value).toBeNull();
    expect(calls).toBe(1);
  });
  it("a remount with the same repo and request reuses the last result (no replay)", async () => {
    let calls = 0;
    const fetcher = async () => { calls++; return combined("c1"); };
    const first = useCombinedDiff(ref("/r"), ref({ hashes: ["a", "b"], paths: ["x"] }), fetcher);
    await flush();
    expect(first.data.value?.commits[0].shortHash).toBe("c1");
    const again = useCombinedDiff(ref("/r"), ref({ hashes: ["a", "b"], paths: ["x"] }), fetcher);
    expect(again.loading.value).toBe(false);
    expect(again.data.value?.commits[0].shortHash).toBe("c1");
    await flush();
    expect(calls).toBe(1);
  });

  it("reload, another request or another repo fetches again", async () => {
    let calls = 0;
    const fetcher = async () => { calls++; return combined(`c${calls}`); };
    const c = useCombinedDiff(ref("/r"), ref({ hashes: ["a", "b"] }), fetcher);
    await flush();
    c.reload();
    await flush();
    expect(calls).toBe(2);
    expect(c.data.value?.commits[0].shortHash).toBe("c2");
    useCombinedDiff(ref("/r"), ref({ hashes: ["a", "c"] }), fetcher);
    await flush();
    expect(calls).toBe(3);
    useCombinedDiff(ref("/other"), ref({ hashes: ["a", "c"] }), fetcher);
    await flush();
    expect(calls).toBe(4);
    // Switching repo dropped the cache of the first one.
    useCombinedDiff(ref("/r"), ref({ hashes: ["a", "c"] }), fetcher);
    await flush();
    expect(calls).toBe(5);
  });

  it("an error is not cached", async () => {
    let calls = 0;
    const fetcher = async () => { calls++; throw new Error("boom"); };
    useCombinedDiff(ref("/r"), ref({ hashes: ["e", "f"] }), fetcher);
    await flush();
    useCombinedDiff(ref("/r"), ref({ hashes: ["e", "f"] }), fetcher);
    await flush();
    expect(calls).toBe(2);
  });
});

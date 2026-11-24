/**
 * The load sequence of `useCombinedDiff`, with plain promises standing in
 * for the request: a result fills the state and the cache, a newer load or
 * `dispose()` (the view closed) makes the one in flight stale — its result
 * then never reaches the state nor the cache.
 */
import { describe, it, expect } from "vitest";
import { combinedLoader, type CombinedLoadState } from "../combinedLoader";
import { combinedResultCache } from "../combinedCache";
import type { CombinedDiff } from "../backend";

const combined = (tag: string): CombinedDiff => ({
  base: null,
  commits: [{ hash: tag.padEnd(40, "0"), shortHash: tag, subject: `s ${tag}`, author: "A", date: "2026-01-01T00:00:00Z" }],
  diffs: [],
  steps: [[]],
  fallback: [],
  truncated: false,
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const last = <T,>(xs: T[]): T | undefined => xs[xs.length - 1];

function setup() {
  const cache = combinedResultCache();
  const pending: Array<ReturnType<typeof deferred<CombinedDiff>>> = [];
  const states: CombinedLoadState[] = [];
  const loader = combinedLoader(
    () => {
      const d = deferred<CombinedDiff>();
      pending.push(d);
      return d.promise;
    },
    cache,
    (s) => states.push(s),
  );
  return { cache, pending, states, loader };
}

const req = { hashes: ["a", "b"] };

describe("combinedLoader", () => {
  it("a result fills the state and the cache", async () => {
    const { cache, pending, states, loader } = setup();
    const done = loader.load("/r", req);
    expect(last(states)).toEqual({ data: null, loading: true, error: null });
    pending[0].resolve(combined("c1"));
    await done;
    expect(last(states)?.data?.commits[0].shortHash).toBe("c1");
    expect(last(states)?.loading).toBe(false);
    expect(cache.get("/r", req)?.commits[0].shortHash).toBe("c1");
  });

  it("a result settling after dispose() reaches neither the state nor the cache", async () => {
    const { cache, pending, states, loader } = setup();
    const done = loader.load("/r", req);
    const seen = states.length;
    loader.dispose();
    pending[0].resolve(combined("late"));
    await done;
    expect(states.length).toBe(seen);
    expect(cache.get("/r", req)).toBeNull();
  });

  it("an error settling after dispose() is dropped too", async () => {
    const { pending, states, loader } = setup();
    const done = loader.load("/r", req);
    const seen = states.length;
    loader.dispose();
    pending[0].reject(new Error("boom"));
    await done;
    expect(states.length).toBe(seen);
  });

  it("a load after dispose() does nothing", async () => {
    const { pending, states, loader } = setup();
    loader.dispose();
    await loader.load("/r", req);
    expect(pending).toHaveLength(0);
    expect(states).toHaveLength(0);
  });

  it("a newer load makes the one in flight stale", async () => {
    const { cache, pending, states, loader } = setup();
    const first = loader.load("/r", req);
    const second = loader.load("/r", { hashes: ["a", "c"] });
    pending[0].resolve(combined("old"));
    await first;
    expect(cache.get("/r", req)).toBeNull();
    pending[1].resolve(combined("new"));
    await second;
    expect(last(states)?.data?.commits[0].shortHash).toBe("new");
    expect(cache.get("/r", { hashes: ["a", "c"] })?.commits[0].shortHash).toBe("new");
  });

  it("an error is reported verbatim, nothing cached", async () => {
    const { cache, pending, states, loader } = setup();
    const done = loader.load("/r", req);
    pending[0].reject("Unknown commit: abcdef1");
    await done;
    expect(last(states)).toEqual({ data: null, loading: false, error: "Unknown commit: abcdef1" });
    expect(cache.get("/r", req)).toBeNull();
  });

  it("a cached result is reused without a request; force bypasses it", async () => {
    const { cache, pending, states, loader } = setup();
    cache.set("/r", req, combined("kept"));
    await loader.load("/r", req);
    expect(pending).toHaveLength(0);
    expect(last(states)?.data?.commits[0].shortHash).toBe("kept");
    const done = loader.load("/r", req, true);
    expect(pending).toHaveLength(1);
    pending[0].resolve(combined("fresh"));
    await done;
    expect(cache.get("/r", req)?.commits[0].shortHash).toBe("fresh");
  });

  it("a null request clears the state and the cache", async () => {
    const { cache, states, loader } = setup();
    cache.set("/r", req, combined("kept"));
    await loader.load("/r", null);
    expect(last(states)).toEqual({ data: null, loading: false, error: null });
    expect(cache.get("/r", req)).toBeNull();
  });
});

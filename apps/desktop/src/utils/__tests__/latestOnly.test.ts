/**
 * latestOnly — only the latest run settles; an earlier one, or one cancelled,
 * reports itself stale. Plain promises, no backend.
 */
import { describe, it, expect } from "vitest";
import { latestOnly } from "../latestOnly";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("latestOnly", () => {
  it("settles the latest run with its value", async () => {
    const g = latestOnly();
    expect(await g.settle(Promise.resolve(42))).toEqual({ stale: false, ok: true, value: 42 });
  });

  it("settles the latest run with its error", async () => {
    const g = latestOnly();
    const err = new Error("boom");
    expect(await g.settle(Promise.reject(err))).toEqual({ stale: false, ok: false, error: err });
  });

  it("an earlier run that resolves after a later one is stale", async () => {
    const g = latestOnly();
    const first = deferred<string>();
    const second = deferred<string>();
    const a = g.settle(first.promise);
    const b = g.settle(second.promise);
    second.resolve("new");
    first.resolve("old");
    expect(await b).toEqual({ stale: false, ok: true, value: "new" });
    expect(await a).toEqual({ stale: true });
  });

  it("an earlier run's late error is stale too", async () => {
    const g = latestOnly();
    const first = deferred<string>();
    const a = g.settle(first.promise);
    const b = g.settle(Promise.resolve("new"));
    first.reject(new Error("late"));
    expect(await a).toEqual({ stale: true });
    expect(await b).toEqual({ stale: false, ok: true, value: "new" });
  });

  it("cancel makes the in-flight run stale", async () => {
    const g = latestOnly();
    const p = deferred<number>();
    const a = g.settle(p.promise);
    g.cancel();
    p.resolve(1);
    expect(await a).toEqual({ stale: true });
  });

  it("two guards are independent", async () => {
    const g1 = latestOnly();
    const g2 = latestOnly();
    const a = g1.settle(Promise.resolve("a"));
    g2.cancel();
    expect(await a).toEqual({ stale: false, ok: true, value: "a" });
  });
});

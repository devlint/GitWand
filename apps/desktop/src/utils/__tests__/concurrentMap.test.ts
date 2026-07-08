import { describe, it, expect } from "vitest";
import { concurrentMap, createSemaphore } from "../concurrentMap";

describe("concurrentMap", () => {
  it("resolves all items in order, respecting the concurrency limit", async () => {
    let active = 0;
    let maxActive = 0;
    const results = await concurrentMap(
      [1, 2, 3, 4, 5],
      async (n) => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        return n * 10;
      },
      2,
    );
    expect(results).toEqual([10, 20, 30, 40, 50]);
    expect(maxActive).toBeLessThanOrEqual(2);
  });
});

describe("createSemaphore", () => {
  it("runs at most `limit` callbacks concurrently", async () => {
    const sem = createSemaphore(2);
    let active = 0;
    let maxActive = 0;
    const runOne = () =>
      sem.run(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        return active;
      });
    await Promise.all([runOne(), runOne(), runOne(), runOne(), runOne()]);
    expect(maxActive).toBeLessThanOrEqual(2);
  });

  it("propagates the wrapped function's return value and rejection", async () => {
    const sem = createSemaphore(1);
    await expect(sem.run(async () => 42)).resolves.toBe(42);
    await expect(sem.run(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
  });
});

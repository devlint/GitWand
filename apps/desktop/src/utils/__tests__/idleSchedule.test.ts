import { describe, it, expect, vi, afterEach } from "vitest";
import { whenIdle } from "../idleSchedule";

describe("whenIdle", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resolves via requestIdleCallback when available", async () => {
    const ric = vi.fn((cb: () => void) => cb());
    vi.stubGlobal("requestIdleCallback", ric);
    await whenIdle();
    expect(ric).toHaveBeenCalledTimes(1);
  });

  it("falls back to setTimeout when requestIdleCallback is unavailable", async () => {
    vi.stubGlobal("requestIdleCallback", undefined);
    await expect(whenIdle()).resolves.toBeUndefined();
  });
});

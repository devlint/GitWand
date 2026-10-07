import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { effectScope, nextTick, ref } from "vue";
import { useStickyWidth } from "../useStickyWidth";

const DELAY = 1500;

function setup(initial = 100, holding = false) {
  const raw = ref(initial);
  const hold = ref(holding);
  const scope = effectScope();
  const width = scope.run(() => useStickyWidth(raw, hold, DELAY))!;
  return { raw, hold, width, scope };
}

describe("useStickyWidth", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts at the raw value", () => {
    const { width, scope } = setup(84);
    expect(width.value).toBe(84);
    scope.stop();
  });

  it("grows immediately", async () => {
    const { raw, width, scope } = setup(100);
    raw.value = 160;
    await nextTick();
    expect(width.value).toBe(160);
    scope.stop();
  });

  it("does not move on a refresh dip that recovers within the delay", async () => {
    const { raw, width, scope } = setup(160);
    // Refresh reloads only the first page: fewer lanes...
    raw.value = 100;
    await nextTick();
    vi.advanceTimersByTime(DELAY - 1);
    expect(width.value).toBe(160);
    // ...then pagination brings the lanes back.
    raw.value = 160;
    await nextTick();
    vi.advanceTimersByTime(DELAY * 2);
    expect(width.value).toBe(160);
    scope.stop();
  });

  it("shrinks once the smaller width has held for the delay", async () => {
    const { raw, width, scope } = setup(160);
    raw.value = 100;
    await nextTick();
    vi.advanceTimersByTime(DELAY - 1);
    expect(width.value).toBe(160);
    vi.advanceTimersByTime(1);
    expect(width.value).toBe(100);
    scope.stop();
  });

  it("restarts the countdown on every change and adopts the latest value", async () => {
    const { raw, width, scope } = setup(200);
    raw.value = 150;
    await nextTick();
    vi.advanceTimersByTime(1000);
    raw.value = 120;
    await nextTick();
    vi.advanceTimersByTime(1000);
    expect(width.value).toBe(200);
    vi.advanceTimersByTime(DELAY - 1000);
    expect(width.value).toBe(120);
    scope.stop();
  });

  it("never shrinks while held, and arms the delay when the hold drops", async () => {
    const { raw, hold, width, scope } = setup(160, true);
    raw.value = 100;
    await nextTick();
    vi.advanceTimersByTime(DELAY * 3);
    expect(width.value).toBe(160);

    hold.value = false;
    await nextTick();
    vi.advanceTimersByTime(DELAY - 1);
    expect(width.value).toBe(160);
    vi.advanceTimersByTime(1);
    expect(width.value).toBe(100);
    scope.stop();
  });

  it("cancels a pending shrink when a page starts loading", async () => {
    const { raw, hold, width, scope } = setup(160);
    raw.value = 100;
    await nextTick();
    vi.advanceTimersByTime(DELAY - 100);
    hold.value = true;
    await nextTick();
    vi.advanceTimersByTime(DELAY * 3);
    expect(width.value).toBe(160);
    scope.stop();
  });

  it("drops the pending shrink when the scope is disposed", async () => {
    const { raw, width, scope } = setup(160);
    raw.value = 100;
    await nextTick();
    scope.stop();
    vi.advanceTimersByTime(DELAY * 2);
    expect(width.value).toBe(160);
  });
});

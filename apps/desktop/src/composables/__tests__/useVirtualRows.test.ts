/**
 * Task A2 (v3.6.0) — `useVirtualRows` wiring test. jsdom has no real layout,
 * so this asserts the virtualizer is constructed/reconfigured correctly, not
 * pixel output.
 */
import { describe, it, expect, vi } from "vitest";
import { ref } from "vue";

const setOptions = vi.fn();
const getVirtualItems = vi.fn(() => [{ index: 0, key: 0, start: 0, size: 40 }]);
const getTotalSize = vi.fn(() => 400);
const measureElement = vi.fn();

function makeVirtualizerInstance(options: Record<string, unknown>) {
  return {
    options,
    setOptions: (next: Record<string, unknown>) => {
      Object.assign(options, next);
      setOptions(next);
    },
    getVirtualItems,
    getTotalSize,
    measureElement,
  };
}

vi.mock("@tanstack/vue-virtual", () => ({
  useVirtualizer: vi.fn((options: Record<string, unknown>) => ref(makeVirtualizerInstance(options))),
}));

import { useVirtualizer } from "@tanstack/vue-virtual";
import { useVirtualRows } from "../useVirtualRows";

describe("useVirtualRows", () => {
  it("constructs the virtualizer with the given count/estimateSize/overscan", () => {
    const count = ref(10);
    const estimateSize = (i: number) => 40 + i;
    useVirtualRows({ count, getScrollElement: () => null, estimateSize, overscan: 4 });

    expect(useVirtualizer).toHaveBeenCalledWith(
      expect.objectContaining({ count: 10, estimateSize, overscan: 4 }),
    );
  });

  it("defaults overscan to 8 when not provided", () => {
    const count = ref(1);
    useVirtualRows({ count, getScrollElement: () => null, estimateSize: () => 40 });
    expect(useVirtualizer).toHaveBeenCalledWith(expect.objectContaining({ overscan: 8 }));
  });

  it("recomputes the virtualizer's count when the reactive count changes", async () => {
    const count = ref(3);
    useVirtualRows({ count, getScrollElement: () => null, estimateSize: () => 40 });
    setOptions.mockClear();

    count.value = 7;
    await Promise.resolve();
    await Promise.resolve();

    expect(setOptions).toHaveBeenCalledWith(expect.objectContaining({ count: 7 }));
  });

  it("exposes virtualItems/totalSize/measure delegating to the virtualizer", () => {
    const count = ref(1);
    const { virtualItems, totalSize, measure } = useVirtualRows({
      count, getScrollElement: () => null, estimateSize: () => 40,
    });

    expect(totalSize.value).toBe(400);
    expect(virtualItems.value).toEqual([{ index: 0, key: 0, start: 0, size: 40 }]);

    const el = {} as Element;
    measure(el);
    expect(measureElement).toHaveBeenCalledWith(el);
    measure(null);
    expect(measureElement).toHaveBeenCalledTimes(1);
  });
});

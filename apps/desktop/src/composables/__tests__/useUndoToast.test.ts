import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useUndoToast } from "../useUndoToast";

describe("useUndoToast", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useUndoToast().dismiss();
  });
  afterEach(() => vi.useRealTimers());

  it("show publishes an offer", () => {
    const toast = useUndoToast();
    toast.show("Discarded 3 file(s)");
    expect(toast.offer.value?.message).toBe("Discarded 3 file(s)");
  });

  it("auto-dismisses after the timeout", () => {
    const toast = useUndoToast();
    toast.show("Discarded 3 file(s)");
    vi.advanceTimersByTime(8_000);
    expect(toast.offer.value).toBeNull();
  });

  it("a second offer replaces the first and resets the timer", () => {
    const toast = useUndoToast();
    toast.show("first");
    vi.advanceTimersByTime(7_000);
    toast.show("second");
    expect(toast.offer.value?.message).toBe("second");
    // The first offer's timer must not clear the second.
    vi.advanceTimersByTime(2_000);
    expect(toast.offer.value?.message).toBe("second");
    vi.advanceTimersByTime(6_000);
    expect(toast.offer.value).toBeNull();
  });

  it("each offer gets a fresh id so the component re-animates", () => {
    const toast = useUndoToast();
    toast.show("first");
    const first = toast.offer.value!.id;
    toast.show("first");
    expect(toast.offer.value!.id).not.toBe(first);
  });

  it("dismiss clears immediately", () => {
    const toast = useUndoToast();
    toast.show("x");
    toast.dismiss();
    expect(toast.offer.value).toBeNull();
  });

  it("dismiss cancels the pending timer, so a later offer survives", () => {
    const toast = useUndoToast();
    toast.show("first");
    toast.dismiss();
    toast.show("second");
    vi.advanceTimersByTime(7_000);
    expect(toast.offer.value?.message).toBe("second");
  });
});

// @vitest-environment jsdom
/**
 * useSelectionPublisher — several diff views can each hold a selection; the
 * shortcut files the most recent one still shown (#301).
 */
import { describe, it, expect } from "vitest";
import { createApp, defineComponent, h, nextTick, ref, shallowRef, type Ref } from "vue";
import { useSelectionPublisher, createSelectionRegistry } from "../useCreateIssue";
import type { DiffSelection } from "../../utils/issuePrefill";

const sel = (path: string): DiffSelection => ({
  path,
  lines: [{ type: "add", content: "x", newLineNo: 1 }],
  source: { kind: "pr", number: 1, url: "u", headSha: null },
});

function view(api: any, source: Ref<DiffSelection | null>, rank?: () => unknown) {
  return defineComponent({
    setup() {
      useSelectionPublisher(api, () => source.value, rank);
      return () => h("div");
    },
  });
}

describe("useSelectionPublisher", () => {
  it("falls back to another view's selection when the latest one goes away", async () => {
    const activeSelection = shallowRef<DiffSelection | null>(null);
    const api = { available: ref(true), activeSelection, publishSelection: createSelectionRegistry(activeSelection) };
    const a = ref<DiffSelection | null>(null);
    const b = ref<DiffSelection | null>(null);
    const appA = createApp(view(api, a));
    const appB = createApp(view(api, b));
    appA.mount(document.createElement("div"));
    appB.mount(document.createElement("div"));
    a.value = sel("a");
    await nextTick();
    b.value = sel("b");
    await nextTick();
    expect(api.activeSelection.value?.path).toBe("b");
    b.value = null;
    await nextTick();
    expect(api.activeSelection.value?.path).toBe("a");
    b.value = sel("b2");
    await nextTick();
    appB.unmount();
    expect(api.activeSelection.value?.path).toBe("a");
    appA.unmount();
    expect(api.activeSelection.value).toBeNull();
  });

  it("a selection rebuilt without a new pick keeps its rank", async () => {
    const activeSelection = shallowRef<DiffSelection | null>(null);
    const api = { available: ref(true), activeSelection, publishSelection: createSelectionRegistry(activeSelection) };
    const a = ref<DiffSelection | null>(null);
    const b = ref<DiffSelection | null>(null);
    const pickA = ref(0);
    createApp(view(api, a, () => pickA.value)).mount(document.createElement("div"));
    createApp(view(api, b)).mount(document.createElement("div"));
    a.value = sel("a");
    await nextTick();
    b.value = sel("b");
    await nextTick();
    // A background refresh rebuilds A's object, same pick.
    a.value = sel("a");
    await nextTick();
    expect(api.activeSelection.value?.path).toBe("b");
    // A new pick in A does take over.
    pickA.value++;
    a.value = sel("a2");
    await nextTick();
    expect(api.activeSelection.value?.path).toBe("a2");
  });
});

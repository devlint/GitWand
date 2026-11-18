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

function view(api: any, source: Ref<DiffSelection | null>) {
  return defineComponent({
    setup() {
      useSelectionPublisher(api, () => source.value);
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
});

// @vitest-environment jsdom
/**
 * StackBadge.vue — the branch-row badge (v3.14 stacked branches).
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { createApp, h, type App } from "vue";
import StackBadge from "../StackBadge.vue";
import type { StackLayerStatus } from "../../utils/backend";
import type { BridgeOffer } from "../../composables/useStacks";

let app: App | null = null;
let container: HTMLElement;

afterEach(() => {
  app?.unmount();
  app = null;
  container?.remove();
});

function layer(over: Partial<StackLayerStatus> = {}): StackLayerStatus {
  return {
    branch: "step-2",
    parent: "step-1",
    base: "abc",
    parent_tip: "def",
    state: "out_of_date",
    inherited: false,
    actionable: true,
    merge_signal: null,
    merged_pr: null,
    parent_behind_upstream: 0,
    top: "step-2",
    ...over,
  };
}

function mountBadge(props: { layer: StackLayerStatus | null; offer: BridgeOffer | null }, on: Record<string, () => void> = {}) {
  container = document.createElement("div");
  document.body.appendChild(container);
  app = createApp({ render: () => h(StackBadge, { ...props, ...on }) });
  app.mount(container);
  return container;
}

describe("StackBadge", () => {
  it("shows the parent, the state and a Restack button that emits restack", () => {
    const onRestack = vi.fn();
    const el = mountBadge({ layer: layer(), offer: null }, { onRestack });
    expect(el.textContent).toContain("↳ step-1");
    expect(el.textContent).toContain("out of date");
    const btn = el.querySelector("button");
    expect(btn?.textContent?.trim()).toBe("Restack");
    btn!.click();
    expect(onRestack).toHaveBeenCalledTimes(1);
  });

  it("renders no state and no button when up to date", () => {
    const el = mountBadge({ layer: layer({ state: "up_to_date", actionable: false }), offer: null });
    expect(el.textContent).toContain("↳ step-1");
    expect(el.textContent).not.toContain("out of date");
    expect(el.querySelector("button")).toBeNull();
  });

  it("shows no Restack button when the layer is not actionable", () => {
    const el = mountBadge({ layer: layer({ actionable: false }), offer: null });
    expect(el.textContent).toContain("out of date");
    expect(el.querySelector("button")).toBeNull();
  });

  it("reads an inherited layer as out of date", () => {
    const el = mountBadge({ layer: layer({ state: "up_to_date", inherited: true, actionable: false }), offer: null });
    expect(el.textContent).toContain("out of date");
  });

  it("renders a bridge offer with Stack and Dismiss", () => {
    const onAcceptOffer = vi.fn();
    const onDismissOffer = vi.fn();
    const el = mountBadge(
      { layer: null, offer: { branch: "step-2", parent: "step-1", pr: 7 } },
      { onAcceptOffer, onDismissOffer },
    );
    expect(el.textContent).toContain("Stack step-2 on step-1?");
    const [accept, dismiss] = Array.from(el.querySelectorAll("button"));
    expect(accept.textContent?.trim()).toBe("Stack");
    expect(dismiss.textContent?.trim()).toBe("Dismiss");
    accept.click();
    dismiss.click();
    expect(onAcceptOffer).toHaveBeenCalledTimes(1);
    expect(onDismissOffer).toHaveBeenCalledTimes(1);
  });
});

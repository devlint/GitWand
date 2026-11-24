// @vitest-environment jsdom
/**
 * MergePreviewPanel.vue — `movingRefs` (v3.14 restack).
 *
 * The block is only for a restack. A merge/rebase preview (prop absent or
 * empty) must render exactly as before: no wrapper element at all.
 */

import { describe, it, expect, afterEach } from "vitest";
import { createApp, h, type App } from "vue";
import MergePreviewPanel from "../MergePreviewPanel.vue";
import type { MergePreviewSummary } from "../../composables/useMergePreview";

const summary: MergePreviewSummary = {
  sourceBranch: "step-2…step-3 → step-1",
  files: [],
  conflictingFiles: 0,
  autoResolvableFiles: 0,
  manualFiles: 0,
  cleanFiles: 1,
  fullyAutoMergeable: false,
};

let app: App | null = null;
let container: HTMLElement;

afterEach(() => {
  app?.unmount();
  app = null;
  container?.remove();
});

function mountPanel(extra: Record<string, unknown>) {
  container = document.createElement("div");
  document.body.appendChild(container);
  app = createApp({
    render: () =>
      h(MergePreviewPanel, {
        loading: false,
        error: null,
        summary,
        conflictingFiles: [],
        ...extra,
      } as never),
  });
  app.mount(container);
}

describe("MergePreviewPanel — movingRefs", () => {
  it("lists every branch and flags only the ones outside the stack", () => {
    mountPanel({
      movingRefs: [
        { branch: "step-2", inStack: true },
        { branch: "side-branch", inStack: false },
      ],
    });
    const rows = [...container.querySelectorAll(".preview-moving__row")];
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("step-2");
    expect(rows[0].textContent).not.toContain("(not in the stack)");
    expect(rows[1].textContent).toContain("side-branch");
    expect(rows[1].textContent).toContain("(not in the stack)");
    expect(container.querySelector(".preview-moving__title")?.textContent).toBe(
      "Branches that will move",
    );
  });

  it("renders no block when the prop is absent", () => {
    mountPanel({});
    expect(container.querySelector(".preview-moving")).toBeNull();
  });

  it("renders no block when the array is empty", () => {
    mountPanel({ movingRefs: [] });
    expect(container.querySelector(".preview-moving")).toBeNull();
  });
});

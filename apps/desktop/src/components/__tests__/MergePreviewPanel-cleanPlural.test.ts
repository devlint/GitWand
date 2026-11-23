// @vitest-environment jsdom
/**
 * MergePreviewPanel.vue — the "clean" chip picks a singular or plural key
 * (QA minor: it read "3 propre(s)"). Same `<key>One` convention as the branch
 * selector's stats (`header.<kind>One`).
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { createApp, h, type App } from "vue";

vi.mock("../../composables/useI18n", () => ({
  useI18n: () => ({ t: (key: string, ...args: unknown[]) => (args.length ? `${key}:${args.join(",")}` : key) }),
}));

import MergePreviewPanel from "../MergePreviewPanel.vue";
import type { MergePreviewSummary } from "../../composables/useMergePreview";

let app: App | null = null;
let container: HTMLElement;

afterEach(() => {
  app?.unmount();
  app = null;
  container?.remove();
});

function chip(cleanFiles: number): string {
  const summary: MergePreviewSummary = {
    sourceBranch: "a → b",
    files: [],
    conflictingFiles: 0,
    autoResolvableFiles: 0,
    manualFiles: 0,
    cleanFiles,
    fullyAutoMergeable: false,
  };
  container = document.createElement("div");
  document.body.appendChild(container);
  app = createApp({
    render: () => h(MergePreviewPanel, { loading: false, error: null, summary, conflictingFiles: [] } as never),
  });
  app.mount(container);
  return container.querySelector(".stat--clean")?.textContent?.trim() ?? "";
}

describe("MergePreviewPanel — clean chip", () => {
  it("uses the singular key for one clean file", () => {
    expect(chip(1)).toBe("1 mergePreview.cleanOne");
  });

  it("uses the plural key for several clean files", () => {
    expect(chip(3)).toBe("3 mergePreview.clean");
  });
});

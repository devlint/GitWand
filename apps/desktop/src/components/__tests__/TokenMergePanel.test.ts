/**
 * TokenMergePanel.vue — accept/reject action UI for proposed token-level merges.
 *
 * Mounted with native `createApp` into jsdom (no @vue/test-utils dep) and a
 * real `useI18n` (default locale → English keys), mirroring LlmTracePanel.test.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createApp, nextTick, type App } from "vue";
import TokenMergePanel from "../TokenMergePanel.vue";
import type { TokenMergeTrace } from "@gitwand/core";

const trace: TokenMergeTrace = {
  mergedLines: ['<div class="a2 b2">'],
  pass1Count: 0,
  pass2Count: 1,
  lineDetails: [
    { lineIndex: 0, resolvedBy: "pass2", resolvedLine: '<div class="a2 b2">', oursTokenIndices: [2], theirsTokenIndices: [4] },
  ],
};

let app: App | null = null;
let container: HTMLElement;

function mount(props: Record<string, unknown>) {
  container = document.createElement("div");
  document.body.appendChild(container);
  app = createApp(TokenMergePanel, {
    trace,
    hunkId: 3,
    ...props,
  });
  app.mount(container);
}

beforeEach(() => {
  localStorage.clear(); // ensure default (English) locale
});

afterEach(() => {
  app?.unmount();
  app = null;
  container?.remove();
});

describe("TokenMergePanel actions", () => {
  it("shows the Accept button (not the badge) when not accepted", () => {
    mount({ accepted: false });
    expect(container.querySelector(".token-merge-panel__btn--accept")).not.toBeNull();
    expect(container.querySelector(".token-merge-panel__accepted-badge")).toBeNull();
  });

  it("displays the pass1/pass2 line counts", () => {
    mount({ accepted: false });
    expect(container.textContent).toContain("1"); // pass2Count: 1
  });

  it("swaps the Accept/Reject buttons for a badge when accepted", () => {
    mount({ accepted: true });
    expect(container.querySelector(".token-merge-panel__accepted-badge")).not.toBeNull();
    expect(container.querySelector(".token-merge-panel__btn--accept")).toBeNull();
    expect(container.querySelector(".token-merge-panel__btn--reject")).toBeNull();
  });

  it("emits `accept` with the hunk id when Accept is clicked", async () => {
    const onAccept = vi.fn();
    mount({ accepted: false, onAccept });
    container
      .querySelector<HTMLButtonElement>(".token-merge-panel__btn--accept")!
      .click();
    await nextTick();
    expect(onAccept).toHaveBeenCalledWith(3);
  });

  it("emits `reject` with the hunk id when Reject is clicked", async () => {
    const onReject = vi.fn();
    mount({ accepted: false, onReject });
    container
      .querySelector<HTMLButtonElement>(".token-merge-panel__btn--reject")!
      .click();
    await nextTick();
    expect(onReject).toHaveBeenCalledWith(3);
  });
});

/**
 * ResolutionPreviewPanel.vue — accept/reject action UI for any hunk the core
 * already auto-resolved (non_overlapping, one_side_change, whitespace_only, …).
 *
 * Mounted with native `createApp` into jsdom (no @vue/test-utils dep) and a
 * real `useI18n` (default locale → English keys), mirroring TokenMergePanel.test.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createApp, nextTick, type App } from "vue";
import ResolutionPreviewPanel from "../ResolutionPreviewPanel.vue";

const resolvedLines = ['<div class="flex items-baseline space-x-2 mr-2">', '<label class="font-bold">'];

let app: App | null = null;
let container: HTMLElement;

function mount(props: Record<string, unknown>) {
  container = document.createElement("div");
  document.body.appendChild(container);
  app = createApp(ResolutionPreviewPanel, {
    resolvedLines,
    hunkId: 3,
    explanation: "Les deux branches ont modifié des zones différentes du même bloc.",
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

describe("ResolutionPreviewPanel actions", () => {
  it("shows the Accept button (not the badge) when not accepted", () => {
    mount({ accepted: false });
    expect(container.querySelector(".resolution-preview-panel__btn--accept")).not.toBeNull();
    expect(container.querySelector(".resolution-preview-panel__accepted-badge")).toBeNull();
  });

  it("displays the resolved content and the explanation", () => {
    mount({ accepted: false });
    expect(container.textContent).toContain("space-x-2");
    expect(container.textContent).toContain("modifié des zones différentes");
  });

  it("swaps the Accept/Reject buttons for a badge when accepted", () => {
    mount({ accepted: true });
    expect(container.querySelector(".resolution-preview-panel__accepted-badge")).not.toBeNull();
    expect(container.querySelector(".resolution-preview-panel__btn--accept")).toBeNull();
    expect(container.querySelector(".resolution-preview-panel__btn--reject")).toBeNull();
  });

  it("emits `accept` with the hunk id when Accept is clicked", async () => {
    const onAccept = vi.fn();
    mount({ accepted: false, onAccept });
    container
      .querySelector<HTMLButtonElement>(".resolution-preview-panel__btn--accept")!
      .click();
    await nextTick();
    expect(onAccept).toHaveBeenCalledWith(3);
  });

  it("emits `reject` with the hunk id when Reject is clicked", async () => {
    const onReject = vi.fn();
    mount({ accepted: false, onReject });
    container
      .querySelector<HTMLButtonElement>(".resolution-preview-panel__btn--reject")!
      .click();
    await nextTick();
    expect(onReject).toHaveBeenCalledWith(3);
  });
});

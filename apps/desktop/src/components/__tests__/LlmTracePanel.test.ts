/**
 * LlmTracePanel.vue — accept/reject action UI.
 *
 * Regression guard for the "Accepter does nothing" bug: the parent's
 * `acceptedLlmHunks` state was write-only (never read), so accepting a hunk
 * produced no visible effect. The panel now swaps the Accept button for a
 * non-interactive "✓ Accepted" badge when `accepted` is true, and clicking
 * Accept must emit `accept` with the hunk id.
 *
 * Mounted with native `createApp` into jsdom (no @vue/test-utils dep) and a
 * real `useI18n` (default locale → English keys), mirroring LaunchpadView.test.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createApp, nextTick, type App } from "vue";
import LlmTracePanel from "../LlmTracePanel.vue";
import type { LlmTrace } from "@gitwand/core";

const trace = {
  model: "claude-sonnet-4-6",
  validationScore: 100,
  calledAt: "2026-06-22T15:35:33Z",
  latencyMs: 8805,
  promptHash: "9e7d9265abcdef",
  rawResponseTruncated: "",
  accepted: false,
} as unknown as LlmTrace;

let app: App | null = null;
let container: HTMLElement;

function mount(props: Record<string, unknown>) {
  container = document.createElement("div");
  document.body.appendChild(container);
  app = createApp(LlmTracePanel, {
    trace,
    filePath: "src/foo.ts",
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

describe("LlmTracePanel actions", () => {
  it("shows the Accept button (not the badge) when not accepted", () => {
    mount({ accepted: false });
    expect(container.querySelector(".llm-trace__btn--primary")).not.toBeNull();
    expect(container.querySelector(".llm-trace__accepted")).toBeNull();
  });

  it("swaps the Accept button for a non-interactive badge when accepted", () => {
    mount({ accepted: true });
    const badge = container.querySelector(".llm-trace__accepted");
    expect(badge).not.toBeNull();
    expect(badge!.tagName).toBe("SPAN"); // non-interactive, not a <button>
    // Accept button is gone; Reject (manual fallback) stays available.
    expect(container.querySelector(".llm-trace__btn--primary")).toBeNull();
    expect(container.querySelector(".llm-trace__btn--secondary")).not.toBeNull();
  });

  it("emits `accept` with the hunk id when Accept is clicked", async () => {
    const onAccept = vi.fn();
    mount({ accepted: false, onAccept });
    container
      .querySelector<HTMLButtonElement>(".llm-trace__btn--primary")!
      .click();
    await nextTick();
    expect(onAccept).toHaveBeenCalledWith(3);
  });
});

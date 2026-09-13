// @vitest-environment jsdom
/**
 * MergePreviewPanel.vue — the confidence bar (v3.11.0).
 *
 * Two things the panel must get right, because both are ways of lying to the
 * user about a merge that has not happened yet:
 *
 *  - a hunk held back by the bar is NOT the same as a hunk the engine refused.
 *    The first is a consequence of a setting the user can lower; the second is
 *    not. Rendering them identically would tell someone that relaxing the bar
 *    would auto-resolve a `complex` hunk.
 *  - the score is shown only where it is actionable. Every row carries its
 *    score in a tooltip and a coloured bar, but the number itself appears only
 *    on the rows the bar is holding back.
 *
 * Mounted with native `createApp` into jsdom (no @vue/test-utils dep).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createApp, defineComponent, h, reactive, nextTick, type App } from "vue";
import MergePreviewPanel from "../MergePreviewPanel.vue";
import type { MergePreviewSummary, PreviewHunk } from "../../composables/useMergePreview";

const hunk = (over: Partial<PreviewHunk>): PreviewHunk => ({
  startLine: 1,
  type: "value_only_change",
  autoResolved: true,
  confidenceScore: 83,
  confidenceLabel: "high",
  reason: "version bump resolved to the highest semver",
  ...over,
});

function summaryWith(hunks: PreviewHunk[]): MergePreviewSummary {
  return {
    sourceBranch: "topic",
    files: [
      {
        filePath: "package.json",
        status: "partial",
        totalConflicts: hunks.length,
        autoResolved: hunks.filter((h) => h.autoResolved).length,
        conflictTypes: ["value_only_change"],
        hunks,
      },
    ],
    conflictingFiles: 1,
    autoResolvableFiles: 0,
    manualFiles: 1,
    cleanFiles: 0,
    fullyAutoMergeable: false,
  };
}

let app: App | null = null;
let container: HTMLElement;

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  app?.unmount();
  app = null;
  container?.remove();
});

function mountPanel(props: Record<string, unknown>) {
  const state = reactive({ ...props });
  const Wrapper = defineComponent({
    setup() {
      return () =>
        h(MergePreviewPanel, {
          loading: false,
          error: null,
          ...state,
          "onUpdate:threshold": (v: number) => {
            (state as { threshold?: number }).threshold = v;
          },
        } as never);
    },
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  app = createApp(Wrapper);
  app.mount(container);
  return state;
}

/** Expand the single file row so its hunks render. */
async function expandFile() {
  container.querySelector<HTMLButtonElement>(".preview-file")!.click();
  await nextTick();
}

describe("MergePreviewPanel — confidence bar", () => {
  const base = (threshold: number) => {
    const s = summaryWith([
      hunk({ startLine: 1, confidenceScore: 83, confidenceLabel: "high" }),
      hunk({ startLine: 9, confidenceScore: 100, confidenceLabel: "certain" }),
      hunk({
        startLine: 20,
        autoResolved: false,
        type: "complex",
        confidenceScore: 60,
        confidenceLabel: "medium",
        reason: "no automatic heuristic applies",
      }),
    ]);
    return {
      summary: s,
      conflictingFiles: s.files,
      threshold,
      estimatedAutoResolutions: threshold > 83 ? 1 : 2,
      heldByThreshold: threshold > 83 ? 1 : 0,
      manualHunks: 1,
    };
  };

  it("shows a confidence bar on every hunk, coloured by label", async () => {
    mountPanel(base(0));
    await expandFile();
    const bars = container.querySelectorAll(".ph-confidence");
    expect(bars.length).toBe(3);
    expect(bars[0].className).toContain("ph-confidence--high");
    expect(bars[1].className).toContain("ph-confidence--certain");
    expect(bars[2].className).toContain("ph-confidence--medium");
  });

  it("puts the score and the reason in the tooltip of every row", async () => {
    mountPanel(base(0));
    await expandFile();
    const row = container.querySelector<HTMLElement>(".preview-hunk")!;
    expect(row.title).toContain("83%");
    expect(row.title).toContain("high");
    expect(row.title).toContain("version bump");
  });

  it("shows no number at a bar of 0: it would not be actionable", async () => {
    mountPanel(base(0));
    await expandFile();
    const rows = Array.from(container.querySelectorAll(".preview-hunk"));
    expect(rows.some((r) => r.className.includes("preview-hunk--held"))).toBe(false);
    expect(container.textContent).not.toContain("83%");
  });

  it("marks only the held-back row, and shows ITS score", async () => {
    mountPanel(base(90));
    await expandFile();
    const rows = Array.from(container.querySelectorAll(".preview-hunk"));

    expect(rows[0].className, "83 < 90 is held back").toContain("preview-hunk--held");
    expect(rows[1].className, "100 >= 90 still applies").toContain("preview-hunk--auto");
    // The engine refused this one: no bar can rescue it, so it must not be
    // dressed up as "held back by your setting".
    expect(rows[2].className, "complex stays manual").toContain("preview-hunk--manual");
    expect(rows[2].className).not.toContain("preview-hunk--held");

    expect(rows[0].textContent).toContain("83");
  });

  it("renders the five stops and marks the active one", async () => {
    mountPanel(base(90));
    const stops = Array.from(container.querySelectorAll<HTMLButtonElement>(".preview-bar__stop"));
    expect(stops.length, "Off / 60 / 75 / 90 / 95").toBe(5);
    const active = stops.filter((b) => b.getAttribute("aria-pressed") === "true");
    expect(active.length).toBe(1);
    expect(active[0].textContent?.trim()).toBe("90%");
  });

  it("emits the new bar when a stop is clicked", async () => {
    const state = mountPanel(base(0));
    const stops = Array.from(container.querySelectorAll<HTMLButtonElement>(".preview-bar__stop"));
    stops[3].click(); // 90%
    await nextTick();
    expect((state as { threshold?: number }).threshold).toBe(90);
  });

  it("reports applied, held-back and manual counts separately", async () => {
    mountPanel(base(90));
    const line = container.querySelector(".preview-bar__summary")!.textContent ?? "";
    // 1 auto-resolvable, 1 held back, 1 manual.
    expect(line).toMatch(/\b1\b/);
    expect(line.match(/\b1\b/g)?.length).toBe(3);
  });
});

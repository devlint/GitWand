/**
 * Issue #133 (sub-issues 2 & 3) — the per-hunk "AI" resolve button used a
 * bespoke inline SVG + text label ("AI" / "AI…") with only a subtle opacity
 * pulse as loading feedback, inconsistent with the app-wide `AiSparkle` icon
 * (already used in 13+ places, including its `animated` prop built exactly
 * for "AI action in progress" states).
 *
 * This guards that the AI-suggest inline action now renders `AiSparkle`
 * bound to the hunk's own loading condition (`aiLoading &&
 * aiSuggestionHunkIndex === seg.hunkIndex`), so the icon both matches the
 * rest of the app and visibly animates while busy.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createApp, type App } from "vue";
import MergeEditor from "../MergeEditor.vue";
import type { ConflictFile } from "../../composables/useGitWand";
import type { ConflictHunk } from "@gitwand/core";

function complexHunk(): ConflictHunk {
  return {
    baseLines: ["line1"],
    oursLines: ["line1-ours"],
    theirsLines: ["line1-theirs"],
    startLine: 2,
    type: "complex",
    confidence: {
      score: 20,
      label: "low",
      dimensions: { typeClassification: 20, dataRisk: 80, scopeImpact: 0, fileFrequency: 0, baseAvailability: 0 },
      boosters: [],
      penalties: [],
    },
    explanation: "Both sides changed incompatible things — manual resolution required.",
    trace: { steps: [], selected: "complex", summary: "test", hasBase: true },
  } as unknown as ConflictHunk;
}

function complexFile(): ConflictFile {
  const hunk = complexHunk();
  const content = [
    "line before",
    "<<<<<<< ours",
    "line1-ours",
    "=======",
    "line1-theirs",
    ">>>>>>> theirs",
    "line after",
  ].join("\n");
  return {
    path: "src/foo.ts",
    content,
    result: {
      filePath: "src/foo.ts",
      mergedContent: null,
      hunks: [hunk],
      resolutions: [{ hunk, resolvedLines: null, autoResolved: false, resolutionReason: "test" }],
      stats: { totalConflicts: 1, autoResolved: 0, byType: { complex: 1 } },
      validation: { valid: true, errors: [] },
    } as unknown as ConflictFile["result"],
  };
}

let app: App | null = null;
let container: HTMLElement;

beforeEach(() => {
  // aiAvailable (useAIProvider.isAvailable) reads settings from localStorage —
  // configure a provider that needs no API key so the AI inline actions render.
  localStorage.setItem(
    "gitwand-settings",
    JSON.stringify({ aiEnabled: true, aiProvider: "ollama" }),
  );
});

afterEach(() => {
  app?.unmount();
  app = null;
  container?.remove();
  localStorage.clear();
});

function mount(file: ConflictFile) {
  container = document.createElement("div");
  document.body.appendChild(container);
  app = createApp(MergeEditor, { file });
  app.mount(container);
}

describe("MergeEditor : AI-suggest button uses AiSparkle", () => {
  it("renders the shared AiSparkle icon (not a bespoke inline SVG) for the AI-suggest action", () => {
    mount(complexFile());
    const aiAction = container.querySelector(".inline-action--ai");
    expect(aiAction).not.toBeNull();
    expect(aiAction!.querySelector(".ai-sparkle")).not.toBeNull();
    // The old bespoke SVG used a 4-arrow "sparkle" path with a plain circle —
    // that markup must be gone from this action now.
    expect(aiAction!.querySelector("svg.ai-icon")).toBeNull();
  });

  it("does not mark the icon animated before any AI suggestion is requested", () => {
    mount(complexFile());
    const icon = container.querySelector(".inline-action--ai .ai-sparkle");
    expect(icon).not.toBeNull();
    expect(icon!.classList.contains("ai-sparkle--animated")).toBe(false);
  });

  it("animates AiSparkle while the AI suggestion for that hunk is loading", async () => {
    mount(complexFile());
    const aiAction = container.querySelector<HTMLAnchorElement>(".inline-action--ai")!;
    aiAction.click();
    await Promise.resolve();
    await Promise.resolve();

    const icon = container.querySelector(".inline-action--ai .ai-sparkle");
    expect(icon).not.toBeNull();
    expect(icon!.classList.contains("ai-sparkle--animated")).toBe(true);
    expect(aiAction.classList.contains("inline-action--loading")).toBe(true);
  });
});

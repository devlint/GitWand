/**
 * MergeEditor.vue — minimap ResizeObserver regression guard.
 *
 * `contentEl` (the scroll container the minimap observes) lives behind
 * `v-if="!file.tree && !file.markerless"`. If the component mounts while the
 * file is still markerless/tree-conflicted, a mount-only ResizeObserver
 * attach (`onMounted`) never fires again once the guard flips to show the
 * editor body — the minimap silently stops redrawing on resize for that
 * file's lifetime. Same bug class fixed in CommitGraph.vue (656ae01c): the
 * observer must (re)attach via a `watch` on the ref, not `onMounted`.
 *
 * Mounted with native `createApp` into jsdom (no @vue/test-utils dep),
 * mirroring LlmTracePanel.test / LaunchpadView.test.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createApp, defineComponent, h, reactive, nextTick, type App } from "vue";
import MergeEditor from "../MergeEditor.vue";
import type { ConflictFile } from "../../composables/useGitWand";
import type { ConflictHunk, HunkResolution } from "@gitwand/core";

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  observedElements: Element[] = [];
  disconnected = false;
  constructor(_cb: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this);
  }
  observe(el: Element) {
    this.observedElements.push(el);
  }
  unobserve() {}
  disconnect() {
    this.disconnected = true;
  }
}

function markerlessFile(): ConflictFile {
  return {
    path: "src/foo.ts",
    content: "irrelevant while markerless",
    result: {
      filePath: "src/foo.ts",
      mergedContent: null,
      hunks: [],
      resolutions: [],
      stats: { totalConflicts: 0, autoResolved: 0 },
      validation: { valid: true, errors: [] },
    } as unknown as ConflictFile["result"],
    markerless: { reconstructed: "reconstructed content" },
  };
}

function resolvedFile(): ConflictFile {
  return {
    path: "src/foo.ts",
    content: "line one\nline two\n",
    result: {
      filePath: "src/foo.ts",
      mergedContent: "line one\nline two\n",
      hunks: [],
      resolutions: [],
      stats: { totalConflicts: 0, autoResolved: 0 },
      validation: { valid: true, errors: [] },
    } as unknown as ConflictFile["result"],
  };
}

let app: App | null = null;
let container: HTMLElement;
let originalRO: typeof ResizeObserver | undefined;

beforeEach(() => {
  localStorage.clear();
  FakeResizeObserver.instances = [];
  originalRO = (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
  (globalThis as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver;
});

afterEach(() => {
  app?.unmount();
  app = null;
  container?.remove();
  (globalThis as { ResizeObserver: unknown }).ResizeObserver = originalRO;
});

/** Wrapper so `file` can be swapped after mount (createApp props are static). */
function mountWithFile(initial: ConflictFile) {
  const state = reactive({ file: initial });
  const Wrapper = defineComponent({
    setup() {
      return () => h(MergeEditor, { file: state.file });
    },
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  app = createApp(Wrapper);
  app.mount(container);
  return state;
}

describe("MergeEditor minimap ResizeObserver", () => {
  it("attaches the observer once the editor body appears after mounting markerless", async () => {
    const state = mountWithFile(markerlessFile());

    // Editor body is hidden behind the markerless panel at mount time.
    expect(container.querySelector(".editor-content")).toBeNull();
    expect(FakeResizeObserver.instances).toHaveLength(0);

    // File becomes resolvable → merge-body (and contentEl) appears.
    state.file = resolvedFile();
    await nextTick();
    await nextTick();

    const contentEl = container.querySelector(".editor-content");
    expect(contentEl).not.toBeNull();
    expect(FakeResizeObserver.instances).toHaveLength(1);
    expect(FakeResizeObserver.instances[0].observedElements).toContain(contentEl);
  });
});

// ─── token_level_merge panel ──────────────────────────────────────────

function tokenMergeHunk(): ConflictHunk {
  return {
    baseLines: ['<div class="a b">'],
    oursLines: ['<div class="a2 b">'],
    theirsLines: ['<div class="a b2">'],
    startLine: 2,
    type: "token_level_merge",
    confidence: {
      score: 62,
      label: "medium",
      dimensions: { typeClassification: 70, dataRisk: 38, scopeImpact: 0, fileFrequency: 0, baseAvailability: 0 },
      boosters: [],
      penalties: [],
    },
    explanation: "Fusion proposée : 0 ligne résolue ligne par ligne, 1 ligne fusionnée token par token.",
    trace: {
      steps: [],
      selected: "token_level_merge",
      summary: "test",
      hasBase: true,
      tokenMergeTrace: {
        mergedLines: ['<div class="a2 b2">'],
        pass1Count: 0,
        pass2Count: 1,
        lineDetails: [{ lineIndex: 0, resolvedBy: "pass2", resolvedLine: '<div class="a2 b2">' }],
      },
    },
  };
}

function tokenMergeFile(): ConflictFile {
  const content = [
    "line before",
    "<<<<<<< ours",
    '<div class="a2 b">',
    "|||||||",
    '<div class="a b">',
    "=======",
    '<div class="a b2">',
    ">>>>>>> theirs",
    "line after",
  ].join("\n");
  return {
    path: "src/foo.html",
    content,
    result: {
      filePath: "src/foo.html",
      mergedContent: null,
      hunks: [tokenMergeHunk()],
      resolutions: [{ hunk: tokenMergeHunk(), resolvedLines: null, autoResolved: false, resolutionReason: "test" }],
      stats: { totalConflicts: 1, autoResolved: 0 },
      validation: { valid: true, errors: [] },
    } as unknown as ConflictFile["result"],
  };
}

/** Direct mount (bypasses mountWithFile's reactive wrapper) so `onXxx` emit listeners can be passed. */
function mountDirect(file: ConflictFile, extraProps: Record<string, unknown> = {}) {
  container = document.createElement("div");
  document.body.appendChild(container);
  app = createApp(MergeEditor, { file, ...extraProps });
  app.mount(container);
}

describe("MergeEditor : panneau token_level_merge", () => {
  it("affiche TokenMergePanel pour un hunk token_level_merge", () => {
    mountDirect(tokenMergeFile());
    expect(container.querySelector(".token-merge-panel")).not.toBeNull();
  });

  it("émet resolveHunkCustom avec les mergedLines au clic sur Accepter", async () => {
    let emitted: unknown[] | null = null;
    mountDirect(tokenMergeFile(), {
      onResolveHunkCustom: (...args: unknown[]) => { emitted = args; },
    });
    container
      .querySelector<HTMLButtonElement>(".token-merge-panel__btn--accept")!
      .click();
    await nextTick();
    expect(emitted).toEqual(["src/foo.html", 0, '<div class="a2 b2">']);
  });

  it("rejeter masque le panneau et bascule vers l'affichage manuel", async () => {
    mountDirect(tokenMergeFile());
    container
      .querySelector<HTMLButtonElement>(".token-merge-panel__btn--reject")!
      .click();
    await nextTick();
    expect(container.querySelector(".token-merge-panel")).toBeNull();
  });
});

// ─── baseEnriched banner ──────────────────────────────────────────────

function baseEnrichedFile(): ConflictFile {
  return {
    path: "src/foo.ts",
    content: "line one\nline two\n",
    result: {
      filePath: "src/foo.ts",
      mergedContent: "line one\nline two\n",
      hunks: [],
      resolutions: [],
      stats: { totalConflicts: 0, autoResolved: 0 },
      validation: { valid: true, errors: [] },
    } as unknown as ConflictFile["result"],
    baseEnriched: true,
  };
}

describe("MergeEditor : bandeau baseEnriched", () => {
  it("affiche le bandeau quand baseEnriched est true", async () => {
    mountWithFile(baseEnrichedFile());
    await nextTick();
    expect(container.querySelector(".me-base-enriched-banner")).not.toBeNull();
  });

  it("n'affiche pas le bandeau quand baseEnriched est absent", async () => {
    mountWithFile(resolvedFile());
    await nextTick();
    expect(container.querySelector(".me-base-enriched-banner")).toBeNull();
  });
});

// ─── ResolutionPreviewPanel (non_overlapping et autres types déjà auto-résolus) ──

function nonOverlappingHunk(): ConflictHunk {
  return {
    baseLines: ["line1", "line2"],
    oursLines: ["line1-changed", "line2"],
    theirsLines: ["line1", "line2-changed"],
    startLine: 2,
    type: "non_overlapping",
    confidence: {
      score: 90,
      label: "high",
      dimensions: { typeClassification: 90, dataRisk: 20, scopeImpact: 0, fileFrequency: 0, baseAvailability: 100 },
      boosters: [],
      penalties: [],
    },
    explanation: "Les deux branches ont modifié des zones différentes du même bloc. Fusion automatique possible.",
    trace: { steps: [], selected: "non_overlapping", summary: "test", hasBase: true },
  };
}

function nonOverlappingResolution(): HunkResolution {
  return {
    hunk: nonOverlappingHunk(),
    resolvedLines: ["line1-changed", "line2-changed"], // le vrai merge LCS — PAS ours+theirs concaténés
    autoResolved: true,
    resolutionReason: "Merge LCS 3-way réussi.",
  };
}

function nonOverlappingFile(): ConflictFile {
  const content = [
    "<<<<<<< ours",
    "line1-changed",
    "line2",
    "|||||||",
    "line1",
    "line2",
    "=======",
    "line1",
    "line2-changed",
    ">>>>>>> theirs",
  ].join("\n");
  return {
    path: "src/config.ts",
    content,
    result: {
      filePath: "src/config.ts",
      mergedContent: null,
      hunks: [nonOverlappingHunk()],
      resolutions: [nonOverlappingResolution()],
      stats: { totalConflicts: 1, autoResolved: 1 },
      validation: { valid: true, errors: [] },
    } as unknown as ConflictFile["result"],
  };
}

describe("MergeEditor : panneau de résolution générique (non_overlapping)", () => {
  it("affiche ResolutionPreviewPanel pour un hunk auto-résolu (non_overlapping)", () => {
    mountDirect(nonOverlappingFile());
    expect(container.querySelector(".resolution-preview-panel")).not.toBeNull();
  });

  it("masque la barre d'actions classique quand le panneau est affiché", () => {
    mountDirect(nonOverlappingFile());
    expect(container.querySelector(".inline-actions")).toBeNull();
  });

  it("émet resolveHunkCustom avec le VRAI resolvedLines (pas une concaténation ours+theirs)", async () => {
    let emitted: unknown[] | null = null;
    mountDirect(nonOverlappingFile(), {
      onResolveHunkCustom: (...args: unknown[]) => { emitted = args; },
    });
    container
      .querySelector<HTMLButtonElement>(".resolution-preview-panel__btn--accept")!
      .click();
    await nextTick();
    // resolvedLines réel : ["line1-changed", "line2-changed"] — PAS
    // ["line1-changed", "line2", "line1", "line2-changed"] (ce que ferait l'ancienne
    // concaténation ours+theirs de resolveHunkManual("both")).
    expect(emitted).toEqual(["src/config.ts", 0, "line1-changed\nline2-changed"]);
  });

  it("un hunk token_level_merge n'obtient pas ce panneau (a déjà le sien, TokenMergePanel)", () => {
    const file = tokenMergeFile(); // type token_level_merge — exclu explicitement dans showResolutionPreviewFor
    mountDirect(file);
    expect(container.querySelector(".resolution-preview-panel")).toBeNull();
  });
});

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

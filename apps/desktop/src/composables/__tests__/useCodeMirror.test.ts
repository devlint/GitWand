// @vitest-environment jsdom
/**
 * v3.11.0 — the extracted CodeMirror layer, against the real library.
 *
 * Mounting CodeMirror 6 in this repo's jsdom works with no shim, which was
 * checked before this file was written rather than assumed. One thing does
 * not: `Range.prototype.getClientRects` is `undefined` here, so anything that
 * measures layout throws. `coordsAtPos` is the practical casualty. Everything
 * asserted below (mount, document round trip, facets, gutters, compartment
 * reconfiguration, teardown) is in the working set, and nothing here should
 * start measuring coordinates. If a later test genuinely needs to, the shim
 * goes in a local `src/test-utils/` helper imported by that file alone, never
 * in `src/test-setup.ts`, which runs for all 139 test files including the
 * node-environment ones and must not touch `document`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ref, nextTick } from "vue";
import { useCodeMirror } from "../useCodeMirror";
import {
  loadCodeMirror,
  peekCodeMirror,
  detectLanguageExtension,
  __resetCodeMirrorCachesForTests,
} from "../../utils/codemirrorLibs";

let host: HTMLElement;

beforeEach(() => {
  localStorage.clear();
  host = document.createElement("div");
  document.body.appendChild(host);
});

afterEach(() => {
  host.remove();
});

describe("codemirrorLibs", () => {
  it("memoizes the load: two calls share one resolved object", async () => {
    const [a, b] = await Promise.all([loadCodeMirror(), loadCodeMirror()]);
    expect(a).toBe(b);
    expect(a.EditorView).toBeTypeOf("function");
    expect(a.basicSetup).toBeDefined();
  });

  it("peek is null before the load resolves and populated after", async () => {
    __resetCodeMirrorCachesForTests();
    expect(peekCodeMirror()).toBeNull();
    await loadCodeMirror();
    expect(peekCodeMirror()).not.toBeNull();
  });

  it("resolves a grammar for a known extension and nothing for an unknown one", async () => {
    expect(await detectLanguageExtension("src/a.ts")).toHaveLength(1);
    expect(await detectLanguageExtension("src/a.zzz")).toEqual([]);
  });

  it("memoizes per extension, not per path", async () => {
    // Every tab used to re-import language-data and re-load the grammar.
    const first = detectLanguageExtension("src/one.ts");
    const second = detectLanguageExtension("deeply/nested/two.ts");
    expect(first).toBe(second);
  });

  it("never throws on a path with no extension", async () => {
    await expect(detectLanguageExtension("Makefile")).resolves.toBeDefined();
  });
});

describe("useCodeMirror", () => {
  it("mounts a live view holding the seeded document", async () => {
    const hostRef = ref<HTMLElement | null>(host);
    const cm = useCodeMirror({ host: hostRef });
    await cm.open("hello\nworld", "a.txt");

    expect(cm.view.value).not.toBeNull();
    expect(cm.getDoc()).toBe("hello\nworld");
    expect(host.querySelector(".cm-editor")).not.toBeNull();
    expect(host.querySelector(".cm-gutters"), "basicSetup brings line numbers").not.toBeNull();
    cm.destroy();
  });

  it("fires onDocChange exactly once per change, with the new text", async () => {
    const onDocChange = vi.fn();
    const hostRef = ref<HTMLElement | null>(host);
    const cm = useCodeMirror({ host: hostRef, onDocChange });
    await cm.open("abc", null);

    cm.view.value!.dispatch({ changes: { from: 0, insert: "X" } });

    expect(onDocChange).toHaveBeenCalledTimes(1);
    expect(onDocChange).toHaveBeenCalledWith("Xabc");
    cm.destroy();
  });

  it("setDoc replaces the document, and is a no-op when already equal", async () => {
    const onDocChange = vi.fn();
    const hostRef = ref<HTMLElement | null>(host);
    const cm = useCodeMirror({ host: hostRef, onDocChange });
    await cm.open("first", null);

    cm.setDoc("second");
    expect(cm.getDoc()).toBe("second");
    expect(onDocChange).toHaveBeenCalledTimes(1);

    // The no-op is what keeps CodeEditor's v-model round trip from looping.
    cm.setDoc("second");
    expect(onDocChange, "identical text dispatches nothing").toHaveBeenCalledTimes(1);
    cm.destroy();
  });

  it("reflects the editable ref, and reacts when it flips", async () => {
    const editable = ref(false);
    const hostRef = ref<HTMLElement | null>(host);
    const cm = useCodeMirror({ host: hostRef, editable });
    await cm.open("locked", null);
    const libs = await loadCodeMirror();

    expect(cm.view.value!.state.facet(libs.EditorView.editable)).toBe(false);

    editable.value = true;
    await nextTick();
    expect(cm.view.value!.state.facet(libs.EditorView.editable)).toBe(true);
    cm.destroy();
  });

  it("re-asserts editability onto a state built before the flag changed", async () => {
    // The File Explorer caches an EditorState per tab; a cached state can
    // predate the panel-wide lock toggle, so mounting must re-assert it.
    const editable = ref(true);
    const hostRef = ref<HTMLElement | null>(host);
    const cm = useCodeMirror({ host: hostRef, editable });
    const stale = await cm.buildState("cached", null);

    editable.value = false;
    cm.mount(stale);

    const libs = await loadCodeMirror();
    expect(cm.view.value!.state.facet(libs.EditorView.editable)).toBe(false);
    cm.destroy();
  });

  it("swaps theme without losing the document", async () => {
    const hostRef = ref<HTMLElement | null>(host);
    const cm = useCodeMirror({ host: hostRef });
    await cm.open("keep me", null);

    cm.applyTheme();
    expect(cm.getDoc()).toBe("keep me");
    cm.destroy();
  });

  it("reconfigures a caller-owned compartment, so the blame gutter stays out of here", async () => {
    const libs = await loadCodeMirror();
    const mine = new libs.Compartment();
    const hostRef = ref<HTMLElement | null>(host);
    const cm = useCodeMirror({ host: hostRef, extraExtensions: [mine.of([])] });
    await cm.open("x", null);

    const before = host.querySelectorAll(".cm-gutterElement").length;
    cm.reconfigure(mine, libs.gutter({ class: "cm-test-gutter" }));
    await nextTick();

    expect(host.querySelector(".cm-test-gutter")).not.toBeNull();
    expect(host.querySelectorAll(".cm-gutterElement").length).toBeGreaterThanOrEqual(before);
    cm.destroy();
  });

  it("mounting a second state reuses the view rather than stacking editors", async () => {
    const hostRef = ref<HTMLElement | null>(host);
    const cm = useCodeMirror({ host: hostRef });
    await cm.open("tab one", null);
    const first = cm.view.value;

    cm.mount(await cm.buildState("tab two", null));

    expect(cm.view.value, "same view, new state").toBe(first);
    expect(cm.getDoc()).toBe("tab two");
    expect(host.querySelectorAll(".cm-editor")).toHaveLength(1);
    cm.destroy();
  });

  it("destroy empties the host and clears the view", async () => {
    const hostRef = ref<HTMLElement | null>(host);
    const cm = useCodeMirror({ host: hostRef });
    await cm.open("bye", null);

    cm.destroy();

    expect(cm.view.value).toBeNull();
    expect(host.childElementCount).toBe(0);
  });
});

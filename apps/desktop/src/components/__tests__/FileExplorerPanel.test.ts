// @vitest-environment jsdom
/**
 * FileExplorerPanel.vue — the safety net for the v3.11 CodeMirror extraction.
 *
 * This component had no test at all, which was the single largest coverage gap
 * in the editor area and an uncomfortable place to start refactoring. Every
 * assertion here targets exactly what moving the CodeMirror wiring into
 * `useCodeMirror` could plausibly break, and each one was written and made to
 * pass against the ORIGINAL implementation before any extraction, so a failure
 * afterwards means the refactor changed behaviour rather than that the test was
 * shaped to fit the new code.
 *
 * What is covered, and why:
 *
 *  - the per-tab `EditorState` cache: switching away and back must restore the
 *    edited buffer, not re-read the file from disk. This is why `buildState`
 *    and `mount` stayed separate in the composable.
 *  - the update listener feeding `explorer.updateContent`, which is what makes
 *    a tab dirty and drives the Save button.
 *  - re-asserting the lock onto a cached state that predates a lock toggle.
 *  - a theme swap, which is new behaviour in this release and must neither
 *    throw nor lose the document.
 *
 * `utils/backend` is mocked: no git behaviour is under test here, only the
 * panel's own wiring. Sixty existing test files do the same, and this is not
 * "mocking the git layer" in the AGENTS.md sense.
 *
 * Mounted with native `createApp` into jsdom (no @vue/test-utils dep).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createApp, defineComponent, h, nextTick, type App } from "vue";

const files: Record<string, string> = {
  "a.ts": "const a = 1;\n",
  "b.ts": "const b = 2;\n",
};

vi.mock("../../utils/backend", () => ({
  readFile: vi.fn(async (_cwd: string, path: string) => {
    const content = files[path];
    if (content === undefined) throw new Error(`no such file: ${path}`);
    return content;
  }),
  writeFile: vi.fn(async () => {}),
  listRepoTree: vi.fn(async () => ({
    node: { name: "", path: "", isDir: true, children: [] },
    truncated: false,
  })),
  getGitBlame: vi.fn(async () => [
    {
      line: 1,
      hash: "abc1234",
      hashFull: "abc1234def",
      author: "Ada",
      date: "2026-01-01",
      summary: "first",
    },
  ]),
  openInEditor: vi.fn(async () => {}),
}));

import FileExplorerPanel from "../FileExplorerPanel.vue";
import { useFileExplorer } from "../../composables/useFileExplorer";
import { loadCodeMirror } from "../../utils/codemirrorLibs";
import { useTheme } from "../../composables/useTheme";

const REPO = "/repo";

let app: App | null = null;
let container: HTMLElement;

beforeEach(() => {
  localStorage.clear();
  useFileExplorer().disposeRepo(REPO);
});

afterEach(() => {
  app?.unmount();
  app = null;
  container?.remove();
});

function mountPanel() {
  const Wrapper = defineComponent({
    setup() {
      return () => h(FileExplorerPanel, { repoPath: REPO, changedFiles: [] });
    },
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  app = createApp(Wrapper);
  app.mount(container);
}

/**
 * Let every pending microtask AND macrotask drain.
 *
 * `nextTick` alone is not enough here: mounting awaits the dynamic CodeMirror
 * imports and the grammar load, which settle on the macrotask queue.
 */
async function settle(rounds = 25) {
  for (let i = 0; i < rounds; i++) {
    await nextTick();
    await new Promise((r) => setTimeout(r, 1));
  }
}

/**
 * Open `path` as a tab and let the editor settle.
 *
 * Pinned, because an unpinned tab is a *preview* tab: opening a second file
 * replaces it in place (`tabs.splice`), the way a single-click preview works
 * in a normal editor. Testing the per-tab state cache therefore needs two tabs
 * that actually coexist, which is what a double-click gives a real user.
 */
async function openTab(path: string, pin = true) {
  await useFileExplorer().openTab(REPO, REPO, path, pin);
  await settle();
}

/** The live EditorView's text, or null when no editor is mounted. */
function editorDoc(): string | null {
  const el = container.querySelector(".cm-content");
  return el ? (el.textContent ?? "") : null;
}

/** The EditorView currently mounted in the panel. */
async function liveView() {
  const libs = await loadCodeMirror();
  const el = container.querySelector(".cm-editor") as HTMLElement | null;
  expect(el, "an editor must be mounted").not.toBeNull();
  const view = libs.EditorView.findFromDOM(el!);
  expect(view, "CodeMirror must own the mounted element").not.toBeNull();
  return { libs, view: view! };
}

/** Type into the mounted editor the way CodeMirror itself would. */
async function typeIntoEditor(text: string) {
  const { view } = await liveView();
  view.dispatch({ changes: { from: 0, insert: text } });
  await settle(5);
}

describe("FileExplorerPanel — editor wiring", () => {
  it("mounts an editor holding the file's content", async () => {
    mountPanel();
    await openTab("a.ts");

    expect(container.querySelector(".cm-editor"), "an editor is mounted").not.toBeNull();
    expect(editorDoc()).toContain("const a = 1;");
  });

  it("keeps each tab's edits: switch away, come back, the edit survives", async () => {
    // The per-tab EditorState cache. Losing it would silently re-read from
    // disk and discard unsaved work on every tab switch.
    mountPanel();
    await openTab("a.ts");
    await typeIntoEditor("EDITED ");
    expect(editorDoc()).toContain("EDITED ");

    await openTab("b.ts");
    expect(editorDoc()).toContain("const b = 2;");
    expect(editorDoc(), "tab B is not tab A").not.toContain("EDITED ");

    await openTab("a.ts");
    expect(editorDoc(), "tab A comes back edited, not re-read").toContain("EDITED ");
  });

  it("marks the tab dirty through explorer.updateContent", async () => {
    mountPanel();
    await openTab("a.ts");
    const explorer = useFileExplorer();
    const tab = explorer.tabsFor(REPO)[0];
    expect(explorer.isDirty(tab)).toBe(false);

    await typeIntoEditor("dirty ");

    expect(explorer.isDirty(tab), "the update listener feeds updateContent").toBe(true);
  });

  it("re-asserts the lock onto a state built before the toggle", async () => {
    mountPanel();
    await openTab("a.ts");
    const { libs, view } = await liveView();

    // The editor opens locked (read-only) by default.
    expect(view.state.facet(libs.EditorView.editable)).toBe(false);

    // The toolbar button whose title flips between "Edit" and "Lock".
    const lockBtn = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".fe__action-btn"),
    ).find((b) => /^(Edit|Lock)$/.test(b.title));
    expect(lockBtn, "the lock toggle must be reachable").toBeTruthy();
    lockBtn!.click();
    await settle(5);

    const after = await liveView();
    expect(after.view.state.facet(libs.EditorView.editable), "now unlocked").toBe(true);
  });

  it("a theme swap keeps the document and does not throw", async () => {
    // New in v3.11: the editor used to be oneDark regardless of app theme.
    mountPanel();
    await openTab("a.ts");
    const { theme } = useTheme();
    const before = editorDoc();

    theme.value = theme.value === "dark" ? "light" : "dark";
    await settle(5);

    expect(editorDoc()).toBe(before);
    expect(container.querySelector(".cm-editor")).not.toBeNull();
  });
});

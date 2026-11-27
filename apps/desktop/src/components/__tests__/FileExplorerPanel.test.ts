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
import { createApp, defineComponent, h, KeepAlive, nextTick, reactive, type App } from "vue";
import en from "../../locales/en";
import fr from "../../locales/fr";
import es from "../../locales/es";
import ptBR from "../../locales/pt-BR";
import zhCN from "../../locales/zh-CN";
import type { RepoDirEntry } from "../../utils/backend";
import type { RepoFileEntry } from "../../composables/useGitRepo";

const files: Record<string, string> = {
  "a.ts": "const a = 1;\n",
  "b.ts": "const b = 2;\n",
};

const FS: Record<string, RepoDirEntry[]> = {
  "": [
    { name: "lib", path: "lib", kind: "dir", ignored: false, size: 0 },
    { name: "a.ts", path: "a.ts", kind: "file", ignored: false, size: 13 },
    { name: "b.ts", path: "b.ts", kind: "file", ignored: false, size: 13 },
  ],
  lib: [{ name: "c.ts", path: "lib/c.ts", kind: "file", ignored: false, size: 1 }],
};

const HUNK = { header: "@@ -1 +1 @@", oldStart: 1, oldCount: 1, newStart: 1, newCount: 1, lines: [] };

vi.mock("../../utils/backend", () => ({
  readFile: vi.fn(async (_cwd: string, path: string) => {
    const content = files[path];
    if (content === undefined) throw new Error(`no such file: ${path}`);
    return content;
  }),
  writeFile: vi.fn(async () => {}),
  listRepoDir: vi.fn(async (_cwd: string, dir: string) => {
    const entries = FS[dir];
    if (!entries) throw new Error(`Directory not found: ${dir}`);
    return { entries, truncated: false };
  }),
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
  revealInFileManager: vi.fn(async () => {}),
  clipboardWriteText: vi.fn(async () => {}),
  pathExists: vi.fn(async () => false),
  workspaceRead: vi.fn(async () => {
    throw new Error("no workspace file");
  }),
  workspaceWrite: vi.fn(async () => {}),
  getGitDiff: vi.fn(async (_cwd: string, path: string, staged: boolean) => ({
    path: staged ? `${path}@index` : path,
    hunks: [HUNK],
  })),
  readFileAtRevision: vi.fn(async () => ({ bytesBase64: "", byteLength: 0, mime: "text/plain", absent: false })),
}));
// jsdom has no layout: a virtualizer that renders every row (a UI-library stand-in).
vi.mock("@tanstack/vue-virtual", async () => {
  const { shallowRef, triggerRef } = await import("vue");
  return {
    useVirtualizer: (options: { count: number }) => {
      const inst = {
        options,
        setOptions(next: { count: number }) {
          Object.assign(inst.options, next);
          triggerRef(r);
        },
        getVirtualItems: () =>
          Array.from({ length: inst.options.count }, (_, i) => ({ index: i, key: i, start: i * 24, size: 24 })),
        getTotalSize: () => inst.options.count * 24,
        measureElement: () => {},
        scrollToIndex: () => {},
      };
      const r = shallowRef(inst);
      return r;
    },
  };
});

// DiffViewer's rendering is its own concern: a stub that shows which diff it got and re-emits.
vi.mock("../DiffViewer.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    default: defineComponent({
      props: { diff: Object, filePath: String, diffMode: String },
      emits: ["open-file-history", "open-in-editor", "update:diffMode"],
      setup: (p, { emit }) => () =>
        h("div", { class: "stub-diff", "data-path": (p.diff as { path?: string } | undefined)?.path ?? "" }, [
          h("button", { class: "stub-history", onClick: () => emit("open-file-history", p.filePath) }),
          h("button", { class: "stub-editor", onClick: () => emit("open-in-editor", p.filePath) }),
        ]),
    }),
  };
});

import FileExplorerPanel from "../FileExplorerPanel.vue";
import { useFileExplorer } from "../../composables/useFileExplorer";
import { useWorkspaceScope } from "../../composables/useWorkspaceScope";
import { useLogs } from "../../composables/useLogs";
import { loadCodeMirror } from "../../utils/codemirrorLibs";
import { useTheme } from "../../composables/useTheme";
import { clipboardWriteText, getGitDiff, listRepoDir, pathExists, readFile, revealInFileManager, writeFile } from "../../utils/backend";

const REPO = "/repo";
const OTHER = "/other";
const REVEAL_LABELS: string[] = [en.filesView.ctxRevealMac, en.filesView.ctxRevealWindows, en.filesView.ctxRevealLinux];

let app: App | null = null;
let container: HTMLElement;

beforeEach(() => {
  localStorage.clear();
  // Back to each vi.fn's own implementation, "once" queues included.
  vi.resetAllMocks();
  useFileExplorer().disposeRepo(REPO);
  useFileExplorer().disposeRepo(OTHER);
  useWorkspaceScope().activeScope.value = null;
  useLogs().clearLogs();
});

afterEach(() => {
  app?.unmount();
  app = null;
  container?.remove();
  useWorkspaceScope().activeScope.value = null;
  files["a.ts"] = "const a = 1;\n";
});

/**
 * Mount the panel behind a reactive state, so a test can change the repo, the
 * changed files or the panel's visibility the way App.vue does. `keepAlive`
 * wraps it in a KeepAlive like App.vue:4585.
 */
function mountPanel(changedFiles: RepoFileEntry[] = [], opts: { keepAlive?: boolean } = {}) {
  const state = reactive({ repoPath: REPO, changedFiles, shown: true });
  const events: Array<[string, ...unknown[]]> = [];
  const on = (name: string) => (...args: unknown[]) => {
    events.push([name, ...args]);
  };
  const panel = () =>
    state.shown
      ? h(FileExplorerPanel, {
          repoPath: state.repoPath,
          changedFiles: state.changedFiles,
          onOpenInEditor: on("open-in-editor"),
          onOpenMergeEditor: on("open-merge-editor"),
          onOpenFileHistory: on("open-file-history"),
        })
      : null;
  const Wrapper = defineComponent({
    setup: () => () => (opts.keepAlive ? h(KeepAlive, null, { default: panel }) : panel()),
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  app = createApp(Wrapper);
  app.mount(container);
  return { state, events };
}

const rows = () => [...container.querySelectorAll<HTMLElement>("[role=treeitem]")];
const row = (name: string) => rows().find((r) => r.querySelector(".ftp__name")?.textContent === name)!;
const tree = () => container.querySelector<HTMLElement>("[role=tree]")!;
const key = (k: string) => tree().dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
const menuItems = () => [...document.querySelectorAll<HTMLElement>("[role=menuitem]")];
const menuItem = (label: string) => menuItems().find((b) => b.textContent?.trim() === label)!;
const lastLog = () => {
  const logs = useLogs().entries.value;
  return logs[logs.length - 1];
};

const MOD_A: RepoFileEntry = { path: "a.ts", status: "modified", section: "unstaged" };
const MOD_B: RepoFileEntry = { path: "b.ts", status: "modified", section: "unstaged" };
const radio = (label: string) =>
  [...container.querySelectorAll<HTMLElement>("[role=radio]")].find((b) => b.textContent?.trim() === label)!;
const diffPath = () => container.querySelector(".stub-diff")?.getAttribute("data-path") ?? null;
const editorShown = () => (container.querySelector(".fe__content") as HTMLElement).style.display !== "none";
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
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
  // CodeMirror is a lazy chunk: the first test of the file pays for its cold
  // import, which a fixed number of ticks did not always cover under the
  // full suite's load. Await the same cached promise the panel awaits, then
  // wait for the editor of a readable file to show it.
  await loadCodeMirror();
  await settle();
  const content = files[path];
  if (content !== undefined) await untilEditorShows(content.trimEnd());
}

/**
 * Wait, up to `ms`, for the mounted editor to hold `text`, or for the tab to
 * show its diff instead (no editor text to wait for then). Well under the
 * 5 s test timeout, so a missing editor fails on the test's own assertion,
 * not on a timeout.
 */
async function untilEditorShows(text: string, ms = 1_500) {
  const deadline = Date.now() + ms;
  const done = () =>
    (editorDoc() ?? "").includes(text) || container.querySelector(".fe__diff") !== null;
  while (!done() && Date.now() < deadline) {
    await settle(1);
  }
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

describe("FileExplorerPanel — tree (v3.11.2)", () => {
  it("lists the root through listRepoDir and a folder only when it is opened", async () => {
    mountPanel();
    await settle();
    expect(listRepoDir).toHaveBeenCalledWith(REPO, "", false);
    expect(listRepoDir).not.toHaveBeenCalledWith(REPO, "lib", false);
    row("lib").click();
    await settle();
    expect(listRepoDir).toHaveBeenCalledWith(REPO, "lib", false);
    expect(row("c.ts")).toBeTruthy();
  });

  it("shows a deleted file struck through and never opens it", async () => {
    mountPanel([{ path: "lib/gone.ts", status: "deleted", section: "unstaged" }]);
    await settle();
    row("lib").click();
    await settle();
    const gone = row("gone.ts");
    expect(gone.classList.contains("ftp__row--deleted")).toBe(true);
    expect(gone.querySelector(".ftp__sr")?.textContent).toBe(en.filesView.statusDeleted);
    vi.mocked(readFile).mockClear();
    gone.click();
    gone.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await settle();
    expect(readFile).not.toHaveBeenCalled();
    expect(useFileExplorer().tabsFor(REPO)).toHaveLength(0);
  });

  it("a click opens the preview tab and a double click pins it", async () => {
    mountPanel();
    await settle();
    row("a.ts").click();
    await settle();
    expect(useFileExplorer().tabsFor(REPO).map((t) => [t.path, t.pinned])).toEqual([["a.ts", false]]);
    row("a.ts").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await settle();
    expect(useFileExplorer().tabsFor(REPO).map((t) => [t.path, t.pinned])).toEqual([["a.ts", true]]);
  });

  it("Enter opens the file under the cursor; the arrow keys alone open nothing", async () => {
    mountPanel();
    await settle();
    key("ArrowDown"); // lib
    key("ArrowDown"); // a.ts
    await settle();
    expect(useFileExplorer().tabsFor(REPO)).toHaveLength(0);
    key("Enter");
    await settle();
    expect(useFileExplorer().tabsFor(REPO).map((t) => [t.path, t.pinned])).toEqual([["a.ts", false]]);
  });

  it("retries a folder that failed to list when its error row is clicked", async () => {
    vi.mocked(listRepoDir).mockImplementationOnce(async () => ({ entries: FS[""]!, truncated: false }));
    vi.mocked(listRepoDir).mockRejectedValueOnce(new Error("denied"));
    mountPanel();
    await settle();
    row("lib").click();
    await settle();
    const err = rows().find((r) => r.textContent?.includes("denied"))!;
    expect(err).toBeTruthy();
    vi.mocked(listRepoDir).mockClear();
    err.click();
    await settle();
    expect(listRepoDir).toHaveBeenCalledWith(REPO, "lib", false);
    expect(row("c.ts")).toBeTruthy();
  });

  it("highlights the active tab's file, also when the tab is chosen from the tab bar", async () => {
    mountPanel();
    await settle();
    await openTab("a.ts");
    await openTab("b.ts");
    const tabs = useFileExplorer().tabsFor(REPO);
    useFileExplorer().setActive(REPO, tabs.find((t) => t.path === "a.ts")!.id);
    await settle();
    expect(row("a.ts").getAttribute("aria-selected")).toBe("true");
    expect(row("b.ts").getAttribute("aria-selected")).toBe("false");
  });

  it("persists the expansion under the panel's own key", async () => {
    mountPanel();
    await settle();
    row("lib").click();
    await settle();
    expect(localStorage.getItem(`gitwand-explorer-tree:${REPO}`)).not.toBeNull();
  });

  it("Show ignored re-lists the tree with ignored entries", async () => {
    mountPanel();
    await settle();
    const box = container.querySelector<HTMLInputElement>(".ftp__ignored input")!;
    box.checked = true;
    box.dispatchEvent(new Event("change"));
    await settle();
    expect(listRepoDir).toHaveBeenCalledWith(REPO, "", true);
  });
});

describe("FileExplorerPanel — context menu (v3.11.2)", () => {
  async function openMenuOn(name: string) {
    mountPanel();
    await settle();
    row(name).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    await nextTick();
  }

  it("Open in editor hands the file to App's external editor", async () => {
    const { events } = mountPanel();
    await settle();
    row("a.ts").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    await nextTick();
    menuItem(en.filesView.ctxOpenInEditor).click();
    expect(events[events.length - 1]).toEqual(["open-in-editor", "a.ts"]);
  });

  it("Copy path writes the repo-relative path", async () => {
    await openMenuOn("a.ts");
    menuItem(en.filesView.ctxCopyPath).click();
    await settle();
    expect(clipboardWriteText).toHaveBeenCalledWith("a.ts");
  });

  it("logs a failed Copy path instead of rejecting unhandled", async () => {
    vi.mocked(clipboardWriteText).mockRejectedValueOnce(new Error("denied"));
    await openMenuOn("a.ts");
    menuItem(en.filesView.ctxCopyPath).click();
    await settle();
    expect(lastLog()).toMatchObject({
      level: "error",
      message: en.filesView.copyPathFailed.replace("{0}", "a.ts").replace("{1}", "denied"),
    });
  });

  it("Reveal hands the path to the file manager, and logs a failure", async () => {
    vi.mocked(revealInFileManager).mockRejectedValueOnce(new Error("Path not found: a.ts"));
    await openMenuOn("a.ts");
    menuItems().find((b) => REVEAL_LABELS.includes(b.textContent?.trim() ?? ""))!.click();
    await settle();
    expect(revealInFileManager).toHaveBeenCalledWith(REPO, "a.ts");
    expect(lastLog()).toMatchObject({
      level: "error",
      message: en.filesView.revealFailed.replace("{0}", "a.ts").replace("{1}", "Path not found: a.ts"),
    });
  });
});

describe("FileExplorerPanel — scope (v3.11.2)", () => {
  it("'Scope here' sets the workspace scope and re-roots the tree on it", async () => {
    mountPanel();
    await settle();
    row("lib").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    await nextTick();
    menuItem(en.filesView.ctxScopeHere).click();
    await settle();
    expect(useWorkspaceScope().activeScope.value).toBe("lib");
    expect(listRepoDir).toHaveBeenLastCalledWith(REPO, "lib", false);
    expect(row("c.ts")).toBeTruthy();
    expect(container.querySelector(".fe__scope")?.textContent).toContain(en.scope.active.replace("{0}", "lib"));
  });

  it("roots the tree at the active scope, and 'Whole repo' clears it", async () => {
    useWorkspaceScope().activeScope.value = "lib";
    mountPanel();
    await settle();
    expect(listRepoDir).toHaveBeenCalledWith(REPO, "lib", false);
    expect(row("a.ts")).toBeUndefined();
    [...container.querySelectorAll<HTMLButtonElement>(".fe__scope button")]
      .find((b) => b.textContent?.trim() === en.scope.wholeRepo)!
      .click();
    await settle();
    expect(useWorkspaceScope().activeScope.value).toBeNull();
    expect(listRepoDir).toHaveBeenLastCalledWith(REPO, "", false);
    expect(container.querySelector(".fe__scope")).toBeNull();
  });

  it("'Whole repo' hands focus to the tree, since the button it was on is gone", async () => {
    useWorkspaceScope().activeScope.value = "lib";
    mountPanel();
    await settle();
    const button = [...container.querySelectorAll<HTMLButtonElement>(".fe__scope button")]
      .find((b) => b.textContent?.trim() === en.scope.wholeRepo)!;
    button.focus();
    button.click();
    await settle();
    expect(document.activeElement).toBe(container.querySelector("[role=tree]"));
  });

  it("falls back to the whole repo, with a notice, when the scope folder is gone", async () => {
    useWorkspaceScope().activeScope.value = "gone";
    mountPanel();
    await settle();
    expect(pathExists).toHaveBeenCalledWith(REPO, "gone");
    expect(useWorkspaceScope().activeScope.value).toBeNull();
    expect(container.textContent).toContain(en.filesView.scopeGone.replace("{0}", "gone"));
    expect(listRepoDir).toHaveBeenLastCalledWith(REPO, "", false);
  });

  it("keeps the scope when its folder exists but cannot be listed", async () => {
    vi.mocked(pathExists).mockResolvedValue(true);
    useWorkspaceScope().activeScope.value = "gone";
    mountPanel();
    await settle();
    expect(useWorkspaceScope().activeScope.value).toBe("gone");
    expect(rows()[0]?.textContent).toContain("Directory not found: gone");
  });
});

describe("FileExplorerPanel — Diff | File (v3.11.2)", () => {
  it("a changed file opens on its diff", async () => {
    mountPanel([MOD_A]);
    await settle();
    row("a.ts").click();
    await settle();
    expect(getGitDiff).toHaveBeenCalledWith(REPO, "a.ts", false);
    expect(diffPath()).toBe("a.ts");
    expect(editorShown()).toBe(false);
    expect(radio(en.filesView.viewDiff).getAttribute("aria-checked")).toBe("true");
  });

  it("an unchanged file opens in the editor, with no toggle", async () => {
    mountPanel([MOD_A]);
    await settle();
    row("b.ts").click();
    await settle();
    expect(editorShown()).toBe(true);
    expect(editorDoc()).toContain("const b = 2;");
    expect(container.querySelector("[role=radio]")).toBeNull();
    expect(getGitDiff).not.toHaveBeenCalled();
  });

  it("Diff | File switches to the editor and back", async () => {
    mountPanel([MOD_A]);
    await settle();
    row("a.ts").click();
    await settle();
    radio(en.filesView.viewFile).click();
    await settle();
    expect(diffPath()).toBeNull();
    expect(editorShown()).toBe(true);
    expect(editorDoc()).toContain("const a = 1;");
    radio(en.filesView.viewDiff).click();
    await settle();
    expect(diffPath()).toBe("a.ts");
    expect(getGitDiff).toHaveBeenCalledTimes(2);
  });

  it("the Diff side is disabled while the buffer has unsaved edits", async () => {
    mountPanel([MOD_A]);
    await settle();
    row("a.ts").click();
    await settle();
    radio(en.filesView.viewFile).click();
    await settle();
    await typeIntoEditor("EDITED ");
    const diffBtn = radio(en.filesView.viewDiff);
    expect(diffBtn.getAttribute("aria-disabled")).toBe("true");
    expect(diffBtn.getAttribute("title")).toBe(en.filesView.diffNeedsSave);
    diffBtn.click();
    await settle();
    expect(diffPath()).toBeNull();
    expect(editorShown()).toBe(true);
    expect(editorDoc()).toContain("EDITED ");
  });

  it("offers Working tree | Index for a file both staged and modified", async () => {
    mountPanel([
      { path: "a.ts", status: "modified", section: "staged" },
      { path: "a.ts", status: "modified", section: "unstaged" },
    ]);
    await settle();
    row("a.ts").click();
    await settle();
    expect(diffPath()).toBe("a.ts");
    radio(en.filesView.preview.sideIndex).click();
    await settle();
    expect(getGitDiff).toHaveBeenLastCalledWith(REPO, "a.ts", true);
    expect(diffPath()).toBe("a.ts@index");
  });

  it("a conflicted file shows the merge-editor banner, never a diff", async () => {
    const { events } = mountPanel([{ path: "a.ts", status: "modified", section: "conflicted" }]);
    await settle();
    row("a.ts").click();
    await settle();
    expect(getGitDiff).not.toHaveBeenCalled();
    expect(container.textContent).toContain(en.filesView.preview.conflicted);
    [...container.querySelectorAll<HTMLButtonElement>(".fe__diff button")]
      .find((b) => b.textContent?.trim() === en.filesView.preview.openMergeEditor)!
      .click();
    expect(events[events.length - 1]).toEqual(["open-merge-editor", "a.ts"]);
  });

  it("a failed diff shows an inline error with Retry", async () => {
    vi.mocked(getGitDiff).mockRejectedValueOnce(new Error("boom"));
    mountPanel([MOD_A]);
    await settle();
    row("a.ts").click();
    await settle();
    expect(container.querySelector(".fe__diff")?.textContent).toContain(en.filesView.preview.error.replace("{0}", "boom"));
    [...container.querySelectorAll<HTMLButtonElement>(".fe__diff button")]
      .find((b) => b.textContent?.trim() === en.filesView.retry)!
      .click();
    await settle();
    expect(diffPath()).toBe("a.ts");
  });

  it("re-emits the diff's open-in-editor and file-history requests", async () => {
    const { events } = mountPanel([MOD_A]);
    await settle();
    row("a.ts").click();
    await settle();
    container.querySelector<HTMLButtonElement>(".stub-editor")!.click();
    expect(events[events.length - 1]).toEqual(["open-in-editor", "a.ts"]);
    container.querySelector<HTMLButtonElement>(".stub-history")!.click();
    expect(events[events.length - 1]).toEqual(["open-file-history", "a.ts"]);
  });

  it("a File tab stays on File when its file becomes changed", async () => {
    const { state } = mountPanel([]);
    await settle();
    row("b.ts").click();
    await settle();
    state.changedFiles = [MOD_B];
    await settle();
    expect(radio(en.filesView.viewFile).getAttribute("aria-checked")).toBe("true");
    expect(diffPath()).toBeNull();
    expect(editorShown()).toBe(true);
    expect(getGitDiff).not.toHaveBeenCalled();
  });

  it("an untracked file over 5 MB shows the too-large placeholder without diffing it", async () => {
    FS[""].push({ name: "big.log", path: "big.log", kind: "file", ignored: false, size: 6 * 1024 * 1024 });
    try {
      mountPanel([{ path: "big.log", status: "added", section: "untracked" }]);
      await settle();
      row("big.log").click();
      await settle();
      expect(getGitDiff).not.toHaveBeenCalled();
      expect(container.textContent).toContain(en.filesView.preview.tooLarge.replace("{0}", "6.0 MB"));
    } finally {
      FS[""].pop();
    }
  });

  it("a diff that resolves after switching to File is dropped", async () => {
    const late = deferred<unknown>();
    vi.mocked(getGitDiff).mockImplementationOnce(() => late.promise as never);
    mountPanel([MOD_A]);
    await settle();
    row("a.ts").click();
    await settle();
    radio(en.filesView.viewFile).click();
    await settle();
    late.resolve({ path: "late", hunks: [HUNK] });
    await settle();
    expect(diffPath()).toBeNull();
    expect(editorShown()).toBe(true);
    radio(en.filesView.viewDiff).click();
    await settle();
    expect(diffPath()).toBe("a.ts");
  });

  it("a diff for an earlier tab is dropped", async () => {
    const late = deferred<unknown>();
    vi.mocked(getGitDiff).mockImplementationOnce(() => late.promise as never);
    mountPanel([MOD_A, MOD_B]);
    await settle();
    row("a.ts").click();
    await settle();
    row("b.ts").click();
    await settle();
    late.resolve({ path: "late-a", hunks: [HUNK] });
    await settle();
    expect(diffPath()).toBe("b.ts");
  });

  it("survives a repo switch inside KeepAlive: the new repo's tree and tabs, never the old repo's late diff", async () => {
    const late = deferred<unknown>();
    vi.mocked(getGitDiff).mockImplementationOnce(() => late.promise as never);
    const { state } = mountPanel([MOD_A], { keepAlive: true });
    await settle();
    await useFileExplorer().openTab(OTHER, OTHER, "a.ts", false);
    row("a.ts").click();
    await settle();
    state.shown = false; // KeepAlive deactivates the panel; it is not unmounted
    await settle();
    state.repoPath = OTHER;
    state.shown = true;
    await settle();
    expect(listRepoDir).toHaveBeenCalledWith(OTHER, "", false);
    expect(getGitDiff).toHaveBeenLastCalledWith(OTHER, "a.ts", false);
    late.resolve({ path: "late-from-repo", hunks: [HUNK] });
    await settle();
    expect(diffPath()).toBe("a.ts");
  });

  it("keeps a tab's chosen side across a repo switch and back", async () => {
    const { state } = mountPanel([MOD_A]);
    await settle();
    row("a.ts").click();
    await settle();
    radio(en.filesView.viewFile).click();
    await settle();
    state.repoPath = OTHER;
    await settle();
    state.repoPath = REPO;
    await settle();
    expect(radio(en.filesView.viewFile).getAttribute("aria-checked")).toBe("true");
    expect(diffPath()).toBeNull();
  });

  it("a tab opened before its repo's status arrives still lands on its diff", async () => {
    const { state } = mountPanel([]);
    await settle();
    await useFileExplorer().openTab(OTHER, OTHER, "a.ts", false);
    state.repoPath = OTHER; // changedFiles still holds the previous repo's (empty) status
    await settle();
    state.changedFiles = [MOD_A];
    await settle();
    expect(diffPath()).toBe("a.ts");
    expect(radio(en.filesView.viewDiff).getAttribute("aria-checked")).toBe("true");
  });

  it("locks Lock/Edit while the diff shows", async () => {
    mountPanel([MOD_A]);
    await settle();
    row("a.ts").click();
    await settle();
    const lock = () =>
      [...container.querySelectorAll<HTMLButtonElement>(".fe__header-actions .fe__action-btn")].find(
        (b) => b.textContent?.includes(en.files.toolbarLock) || b.textContent?.includes(en.files.toolbarEdit),
      )!;
    expect(lock().disabled).toBe(true);
    radio(en.filesView.viewFile).click();
    await settle();
    expect(lock().disabled).toBe(false);
  });

  it("has the toggle's strings in all five locales", () => {
    for (const loc of [en, fr, es, ptBR, zhCN]) {
      expect(loc.filesView.viewLabel).toBeTruthy();
      expect(loc.filesView.viewDiff).toBeTruthy();
      expect(loc.filesView.viewFile).toBeTruthy();
      expect(loc.filesView.diffNeedsSave).toBeTruthy();
      expect(loc.filesView.preview.noTextDiff).not.toContain("{0}");
    }
  });
});

describe("FileExplorerPanel — Diff | File lifecycle (v3.11.2)", () => {
  it("switching to File re-reads a clean tab from disk", async () => {
    mountPanel([MOD_A]);
    await settle();
    row("a.ts").click();
    await settle();
    files["a.ts"] = "const a = 42;\n"; // changed on disk while the tab showed its diff
    radio(en.filesView.viewFile).click();
    await settle();
    expect(editorDoc()).toContain("const a = 42;");
    expect(editorDoc()).not.toContain("const a = 1;");
  });

  it("a save after the switch writes the fresh buffer, not the stale one", async () => {
    mountPanel([MOD_A]);
    await settle();
    row("a.ts").click();
    await settle();
    files["a.ts"] = "const a = 42;\n";
    radio(en.filesView.viewFile).click();
    await settle();
    await typeIntoEditor("// edit\n");
    const explorer = useFileExplorer();
    const tab = explorer.tabsFor(REPO)[0];
    await explorer.saveTab(REPO, REPO, tab.id);
    expect(vi.mocked(writeFile)).toHaveBeenCalledWith(REPO, "a.ts", "// edit\nconst a = 42;\n");
  });

  it("keeps the diff on screen, and the editor locked out, until the File read lands", async () => {
    mountPanel([MOD_A]);
    await settle();
    row("a.ts").click();
    await settle();
    files["a.ts"] = "const a = 42;\n";
    const gate = deferred<string>();
    vi.mocked(readFile).mockImplementationOnce(() => gate.promise);
    radio(en.filesView.viewFile).click();
    await settle(3);
    expect(diffPath()).toBe("a.ts");
    expect(editorShown()).toBe(false);
    gate.resolve("const a = 42;\n");
    await settle();
    expect(diffPath()).toBeNull();
    expect(editorShown()).toBe(true);
    expect(editorDoc()).toContain("const a = 42;");
    expect(editorDoc()).not.toContain("const a = 1;");
  });

  it("File then Diff during a pending read: the tab stays on Diff", async () => {
    mountPanel([MOD_A]);
    await settle();
    row("a.ts").click();
    await settle();
    const gate = deferred<string>();
    vi.mocked(readFile).mockImplementationOnce(() => gate.promise);
    radio(en.filesView.viewFile).click();
    await settle(3);
    radio(en.filesView.viewDiff).click();
    await settle(3);
    gate.resolve("const a = 1;\n");
    await settle();
    expect(diffPath()).toBe("a.ts");
    expect(editorShown()).toBe(false);
    expect(radio(en.filesView.viewDiff).getAttribute("aria-checked")).toBe("true");
  });

  it("a repo switch during the pending read neither flips the new repo to File nor remounts it", async () => {
    const { state } = mountPanel([MOD_A]);
    await settle();
    await useFileExplorer().openTab(OTHER, OTHER, "b.ts", false);
    row("a.ts").click();
    await settle();
    const gate = deferred<string>();
    vi.mocked(readFile).mockImplementationOnce(() => gate.promise);
    radio(en.filesView.viewFile).click();
    await settle(3);
    state.repoPath = OTHER;
    await settle();
    expect(editorDoc()).toContain("const b = 2;");
    gate.resolve("const a = 1;\n");
    await settle();
    expect(editorDoc()).toContain("const b = 2;");
    state.repoPath = REPO;
    await settle();
    // the old repo's tab was not switched by the stale continuation
    expect(radio(en.filesView.viewDiff).getAttribute("aria-checked")).toBe("true");
    expect(diffPath()).toBe("a.ts");
  });

  it("refreshes the tab that was reloaded, even when the user switched tabs while the read was pending", async () => {
    mountPanel([MOD_A]);
    await settle();
    await openTab("b.ts");
    await openTab("a.ts");
    const explorer = useFileExplorer();
    const tabA = explorer.tabsFor(REPO).find((t) => t.path === "a.ts")!;
    const tabB = explorer.tabsFor(REPO).find((t) => t.path === "b.ts")!;
    expect(diffPath()).toBe("a.ts");
    files["a.ts"] = "const a = 42;\n";
    const gate = deferred<string>();
    vi.mocked(readFile).mockImplementationOnce(() => gate.promise);
    radio(en.filesView.viewFile).click();
    await settle(3);
    explorer.setActive(REPO, tabB.id); // the user moves on while the read is pending
    await settle();
    expect(editorDoc()).toContain("const b = 2;");
    gate.resolve("const a = 42;\n");
    await settle();
    expect(editorDoc()).toContain("const b = 2;"); // B stays on screen
    explorer.setActive(REPO, tabA.id);
    await settle();
    expect(editorDoc()).toContain("const a = 42;");
    expect(editorDoc()).not.toContain("const a = 1;");
  });

  it("falls back to the editor when its file becomes unchanged, and stays there when it changes again", async () => {
    const { state } = mountPanel([MOD_A]);
    await settle();
    row("a.ts").click();
    await settle();
    expect(diffPath()).toBe("a.ts");
    state.changedFiles = []; // committed or discarded elsewhere
    await settle();
    expect(diffPath()).toBeNull();
    expect(editorShown()).toBe(true);
    expect(container.querySelector("[role=radio]")).toBeNull();
    state.changedFiles = [MOD_A];
    await settle();
    expect(radio(en.filesView.viewFile).getAttribute("aria-checked")).toBe("true");
    expect(diffPath()).toBeNull();
  });

  it("falling back to File because the diff is gone: no stale editor until the re-read lands", async () => {
    const { state } = mountPanel([MOD_A]);
    await settle();
    const btn = (title: string) =>
      [...container.querySelectorAll<HTMLButtonElement>(".fe__header-actions .fe__action-btn")].find(
        (b) => b.title === title,
      )!;
    // Unlock on an unchanged tab (Lock/Edit is panel-wide), then open the changed one on its diff.
    await openTab("b.ts");
    btn(en.files.toolbarEdit).click();
    await settle(5);
    await openTab("a.ts");
    expect(diffPath()).toBe("a.ts");
    files["a.ts"] = "const a = 42;\n"; // e.g. the change was discarded in Changes
    const gate = deferred<string>();
    vi.mocked(readFile).mockImplementationOnce(() => gate.promise);
    state.changedFiles = []; // no diff any more: the watcher falls back to File
    await settle(3);
    expect(diffPath()).toBeNull();
    expect(editorShown()).toBe(false);
    expect(container.querySelector(".fe__editor-pane [aria-busy=true]")).not.toBeNull();
    expect(btn(en.files.toolbarSave).disabled).toBe(true);
    expect(btn(en.files.toolbarUndo).disabled).toBe(true);
    expect(btn(en.files.toolbarLock).disabled).toBe(true);
    expect(btn(en.files.toolbarBlame).disabled).toBe(true);
    gate.resolve("const a = 42;\n");
    await settle();
    expect(container.querySelector(".fe__editor-pane [aria-busy=true]")).toBeNull();
    expect(editorShown()).toBe(true);
    expect(editorDoc()).toContain("const a = 42;");
    expect(editorDoc()).not.toContain("const a = 1;");
    expect(btn(en.files.toolbarUndo).disabled).toBe(false);
  });

  it("⌘S does nothing while the fallback re-read is pending", async () => {
    const { state } = mountPanel([MOD_A]);
    await settle();
    await openTab("a.ts");
    const gate = deferred<string>();
    vi.mocked(readFile).mockImplementationOnce(() => gate.promise);
    const explorer = useFileExplorer();
    const tab = explorer.tabsFor(REPO)[0];
    state.changedFiles = [];
    await settle(3);
    explorer.updateContent(REPO, tab.id, "stale edit\n"); // the old buffer turns dirty mid-read
    container
      .querySelector<HTMLElement>(".fe")!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "s", metaKey: true, ctrlKey: true, bubbles: true, cancelable: true }));
    await settle(3);
    expect(vi.mocked(writeFile)).not.toHaveBeenCalled();
    gate.resolve("const a = 1;\n");
    await settle();
  });

  it("says Deleted from disk and keeps the buffer", async () => {
    const { state } = mountPanel([MOD_A]);
    await settle();
    row("a.ts").click();
    await settle();
    state.changedFiles = [{ path: "a.ts", status: "deleted", section: "unstaged" }];
    await settle();
    expect(container.querySelector(".fe__notice")?.textContent).toContain(en.filesView.preview.gone);
    expect(diffPath()).toBeNull();
    expect(container.querySelector("[role=radio]")).toBeNull();
    expect(editorShown()).toBe(true);
    expect(editorDoc()).toContain("const a = 1;");
  });
});

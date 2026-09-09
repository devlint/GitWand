// @vitest-environment jsdom
/**
 * Issue #183 — the folder panel in `DiffViewer`, for the two shapes a
 * directory path can take: a plain untracked folder, whose files are listed,
 * and an untracked nested git repo, which git never looks inside.
 *
 * Mounted with the native `createApp` (no @vue/test-utils dep), mirroring
 * `DiffViewer-findings.test.ts`.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createApp, nextTick, type App } from "vue";
import DiffViewer from "../DiffViewer.vue";
import type { GitDiff } from "../../utils/backend";

/** What the backend returns for a plain untracked folder. */
function folderDiff(): GitDiff {
  return {
    path: "newfolder/",
    hunks: [],
    isDirectory: true,
    newFiles: ["newfolder/a.txt", "newfolder/sub/b.txt"],
  };
}

/** What the backend returns for an untracked nested git repo. */
function nestedRepoDiff(): GitDiff {
  return {
    path: "libs/inner/",
    hunks: [],
    isDirectory: true,
    nestedRepo: true,
    newFiles: [],
  };
}

interface MountResult {
  app: App;
  container: HTMLDivElement;
  vm: any;
}

function mountDiff(props: Record<string, unknown>): MountResult {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const app = createApp(DiffViewer as any, props);
  const vm = app.mount(container);
  return { app, container, vm };
}

function unmount({ app, container }: MountResult) {
  app.unmount();
  if (container.parentNode) container.parentNode.removeChild(container);
}

describe("DiffViewer — untracked directory panel", () => {
  let mounted: MountResult | null = null;

  afterEach(() => {
    if (mounted) unmount(mounted);
    mounted = null;
  });

  it("lists the files of a plain untracked folder", async () => {
    mounted = mountDiff({ diff: folderDiff(), filePath: "newfolder/", diffMode: "inline" });
    await nextTick();

    expect(mounted.container.querySelectorAll(".diff-dir-file").length).toBe(2);
    expect(mounted.container.querySelector(".diff-nested-repo")).toBeNull();
  });

  it("shows the nested-repo panel instead of an empty file list", async () => {
    mounted = mountDiff({ diff: nestedRepoDiff(), filePath: "libs/inner/", diffMode: "inline" });
    await nextTick();

    const panel = mounted.container.querySelector(".diff-nested-repo");
    expect(panel).not.toBeNull();
    // The path is what identifies which folder the panel is about.
    expect(panel!.textContent).toContain("libs/inner/");
    // No file rows: those files belong to the other repo, and a row for the
    // directory itself would just reopen this panel.
    expect(mounted.container.querySelectorAll(".diff-dir-file").length).toBe(0);
  });

  it("emits open-repo-tab with the directory path", async () => {
    let opened: string | null = null;
    mounted = mountDiff({
      diff: nestedRepoDiff(),
      filePath: "libs/inner/",
      diffMode: "inline",
      onOpenRepoTab: (path: string) => {
        opened = path;
      },
    });
    await nextTick();

    mounted.container.querySelector<HTMLButtonElement>(".diff-nested-repo-open")!.click();
    expect(opened).toBe("libs/inner/");
  });

  it("emits add-to-gitignore with the directory path", async () => {
    let ignored: string | null = null;
    mounted = mountDiff({
      diff: nestedRepoDiff(),
      filePath: "libs/inner/",
      diffMode: "inline",
      onAddToGitignore: (path: string) => {
        ignored = path;
      },
    });
    await nextTick();

    mounted.container.querySelector<HTMLButtonElement>(".diff-nested-repo-ignore")!.click();
    expect(ignored).toBe("libs/inner/");
  });

  it("renders no hardcoded French copy in the folder panel", async () => {
    // The panel used to hardcode "Nouveau dossier" and "fichier(s)", which
    // AGENTS.md forbids: every user-visible string needs a locale key.
    mounted = mountDiff({ diff: folderDiff(), filePath: "newfolder/", diffMode: "inline" });
    await nextTick();

    const text = mounted.container.querySelector(".diff-new-dir")!.textContent ?? "";
    expect(text).not.toContain("Nouveau dossier");
    expect(text).not.toContain("fichier");
  });
});

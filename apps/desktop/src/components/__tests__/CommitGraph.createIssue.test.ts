// @vitest-environment jsdom
/**
 * CommitGraph.vue — "Create issue from commit" in a commit's context menu
 * (#301): offered only when the repository can take an issue, and it hands
 * the commit to the parent.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { createApp, h, nextTick, type App } from "vue";
import CommitGraph from "../CommitGraph.vue";
import type { GitLogEntry } from "../../utils/backend";

vi.mock("../../composables/useI18n", () => ({
  useI18n: () => ({ t: (key: string, ...args: unknown[]) => (args.length ? `${key}:${args.join(",")}` : key) }),
}));

const COMMIT: GitLogEntry = {
  hash: "aaa1111",
  hashFull: "aaa1111".padEnd(40, "0"),
  author: "Dev",
  email: "dev@example.com",
  date: "2026-08-01T00:00:00Z",
  message: "fix: thing",
  body: "",
  parents: [],
  refs: "HEAD -> main",
};

let app: App | null = null;
let container: HTMLElement | null = null;

afterEach(() => {
  app?.unmount();
  app = null;
  container?.remove();
  container = null;
  document.body.innerHTML = "";
});

async function openMenu(canCreateIssue: boolean) {
  container = document.createElement("div");
  document.body.appendChild(container);
  const onCreateIssue = vi.fn();
  app = createApp({
    setup() {
      return () =>
        h(CommitGraph as any, {
          commits: [COMMIT],
          currentBranch: "main",
          branches: [],
          cwd: "/repo",
          canCreateIssue,
          onCreateIssue,
        });
    },
  });
  app.mount(container);
  await nextTick();
  const row = document.querySelector<HTMLElement>(".cg-row");
  if (!row) throw new Error("commit row not rendered");
  row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
  await nextTick();
  return { onCreateIssue };
}

function menuItem(label: string): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>(".commit-ctx-menu-item")].find(
    (el) => el.textContent?.trim() === label,
  );
}

describe("CommitGraph — create issue from commit", () => {
  it("offers the action and emits the commit when the repository can take an issue", async () => {
    const { onCreateIssue } = await openMenu(true);
    const item = menuItem("commitCtx.createIssue");
    expect(item).toBeDefined();
    item!.click();
    expect(onCreateIssue).toHaveBeenCalledWith(COMMIT);
  });

  it("hides the action otherwise", async () => {
    await openMenu(false);
    expect(menuItem("commitCtx.viewOnForge")).toBeDefined();
    expect(menuItem("commitCtx.createIssue")).toBeUndefined();
  });
});

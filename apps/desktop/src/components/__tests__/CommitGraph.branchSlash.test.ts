/**
 * CommitGraph.vue — ref-classification regression for #137.
 *
 * `git branch test/some_experiment` then switching away leaves the branch
 * decorated in `git log` as the bare name `test/some_experiment` (no
 * `HEAD -> ` prefix). At that instant `props.branches` can be empty/stale
 * (e.g. right after a repo/tab switch resets branch state in useGitRepo.ts,
 * per the bug report) — commitRefs() then has no ground-truth match to fix
 * the ref's type. It used to fall back to whatever parseRefs() guessed,
 * which classified any name containing `/` as `type: "remote"` on the
 * assumption it must be `<remote>/<branch>`. Two context-menu actions then
 * stripped everything up to the first `/`, assuming it was a remote prefix,
 * truncating the local branch name to `some_experiment` for both checkout
 * and delete.
 *
 * commitRefs() must now default an unmatched ref to `"branch"` (a local
 * branch), not `"remote"` — so the full name survives into both the
 * "Checkout branch…" and "Delete branch…" context-menu actions.
 *
 * Mounted with native `createApp` into jsdom (no @vue/test-utils dep),
 * mirroring LaunchpadView.test / LlmTracePanel.test. useI18n is mocked to
 * the identity function so menu items can be matched by translation key
 * rather than locale-specific English strings.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { createApp, h, nextTick, type App } from "vue";
import CommitGraph from "../CommitGraph.vue";
import type { GitLogEntry } from "../../utils/backend";

vi.mock("../../composables/useI18n", () => ({
  useI18n: () => ({ t: (key: string, ...args: unknown[]) => (args.length ? `${key}:${args.join(",")}` : key) }),
}));

const commits: GitLogEntry[] = [
  {
    hash: "abc1234",
    hashFull: "abc1234000000000000000000000000000000",
    author: "Dev",
    email: "dev@example.com",
    date: "2026-08-01T00:00:00Z",
    message: "on main",
    body: "",
    parents: [],
    refs: "HEAD -> main",
  },
  {
    hash: "def5678",
    hashFull: "def5678000000000000000000000000000000",
    author: "Dev",
    email: "dev@example.com",
    date: "2026-07-30T00:00:00Z",
    message: "experiment work",
    body: "",
    parents: [],
    // Not checked out — decorated as the bare (possibly slash-containing) name.
    refs: "test/some_experiment",
  },
];

let app: App | null = null;
let container: HTMLElement | null = null;

function mount(propsOverride: Record<string, unknown> = {}) {
  container = document.createElement("div");
  document.body.appendChild(container);
  const emitted: Record<string, unknown[][]> = {};
  app = createApp({
    setup() {
      return () =>
        h(CommitGraph, {
          commits,
          currentBranch: "main",
          branches: [],
          onCheckoutBranch: (...a: unknown[]) => {
            (emitted["checkout-branch"] ??= []).push(a);
          },
          onDeleteBranch: (...a: unknown[]) => {
            (emitted["delete-branch"] ??= []).push(a);
          },
          ...propsOverride,
        });
    },
  });
  app.mount(container);
  return { emitted };
}

function findRefBadge(name: string): HTMLElement {
  const badge = Array.from(document.querySelectorAll<HTMLElement>(".cg-ref")).find(
    (el) => el.getAttribute("title") === name,
  );
  if (!badge) throw new Error(`ref badge "${name}" not found`);
  return badge;
}

function rightClick(el: HTMLElement) {
  const evt = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 });
  el.dispatchEvent(evt);
}

function findMenuItemByKey(key: string): HTMLElement {
  const items = Array.from(document.querySelectorAll<HTMLElement>(".commit-ctx-menu-item"));
  const item = items.find((el) => el.textContent?.includes(key));
  if (!item) throw new Error(`menu item "${key}" not found`);
  return item;
}

afterEach(() => {
  app?.unmount();
  app = null;
  container?.remove();
  container = null;
});

describe("CommitGraph — slash-named local branch (#137)", () => {
  it("classifies the unmatched slash-named ref as a local branch, not remote", async () => {
    mount();
    await nextTick();
    const badge = findRefBadge("test/some_experiment");
    expect(badge.className).toContain("cg-ref--branch");
    expect(badge.className).not.toContain("cg-ref--remote");
  });

  it("emits the full branch name (not truncated) on checkout from the context menu", async () => {
    const { emitted } = mount();
    await nextTick();
    rightClick(findRefBadge("test/some_experiment"));
    await nextTick();
    const checkoutItem = findMenuItemByKey("commitCtx.checkoutBranch");
    checkoutItem.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await nextTick();
    expect(emitted["checkout-branch"]?.[0]?.[0]).toBe("test/some_experiment");
  });

  it("emits the full branch name (not truncated) on delete from the context menu", async () => {
    const { emitted } = mount();
    await nextTick();
    rightClick(findRefBadge("test/some_experiment"));
    await nextTick();
    const deleteItem = findMenuItemByKey("branchMenu.deleteLabel");
    deleteItem.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await nextTick();
    expect(emitted["delete-branch"]?.[0]?.[0]).toBe("test/some_experiment");
  });

  it("still classifies a genuine remote-tracking branch as remote", async () => {
    const remoteCommits: GitLogEntry[] = [
      {
        hash: "aaa1111",
        hashFull: "aaa1111000000000000000000000000000000",
        author: "Dev",
        email: "dev@example.com",
        date: "2026-08-01T00:00:00Z",
        message: "on origin/main",
        body: "",
        parents: [],
        refs: "origin/main",
      },
    ];
    mount({
      commits: remoteCommits,
      branches: [
        {
          name: "origin/main",
          isCurrent: false,
          isRemote: true,
          upstream: null,
          ahead: 0,
          behind: 0,
          mainCommitCount: 1,
          lastCommit: "aaa1111",
          lastCommitDate: "2026-08-01T00:00:00Z",
        },
      ],
    });
    await nextTick();
    const badge = findRefBadge("origin/main");
    expect(badge.className).toContain("cg-ref--remote");
  });

  it("still classifies a tag correctly", async () => {
    const taggedCommits: GitLogEntry[] = [
      {
        hash: "bbb2222",
        hashFull: "bbb2222000000000000000000000000000000",
        author: "Dev",
        email: "dev@example.com",
        date: "2026-08-01T00:00:00Z",
        message: "tagged commit",
        body: "",
        parents: [],
        refs: "tag: v1.0.0",
      },
    ];
    mount({ commits: taggedCommits, branches: [] });
    await nextTick();
    const badge = findRefBadge("v1.0.0");
    expect(badge.className).toContain("cg-ref--tag");
  });
});

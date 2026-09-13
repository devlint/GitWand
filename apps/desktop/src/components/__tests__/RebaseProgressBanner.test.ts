// @vitest-environment jsdom
/**
 * RebaseProgressBanner.vue — the split affordance (#128 follow-up, v3.11.0).
 *
 * v3.6.0 made an interactive-rebase conflict non-blocking by closing the
 * `RebaseEditor` modal and handing off to this banner. That took the
 * "Split this commit…" action with it: for the rest of the rebase the user had
 * only Continue, Skip and Abort, even on a commit they had explicitly marked
 * to split. The banner outlives the editor, so the action belongs here.
 *
 * The `!hasConflict` gate is the load-bearing assertion. It is a correctness
 * condition, not a tidiness one: `gitSplitCommit` runs `reset --mixed HEAD^`,
 * so HEAD has to BE the commit being split. Probed against real git before
 * this was written: at an `edit` stop HEAD is the freshly created commit,
 * which is right, but at a conflict stop the commit does not exist yet and
 * HEAD is its parent, so offering Split there would split the PREVIOUS commit.
 *
 * Mounted with native `createApp` into jsdom (no @vue/test-utils dep).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createApp, defineComponent, h, nextTick, type App } from "vue";

vi.mock("../../utils/backend", () => ({
  gitRebaseAction: vi.fn(async () => {}),
  gitExec: vi.fn(async () => ""),
  gitInteractiveRebase: vi.fn(async () => ({ conflict: false })),
}));

import RebaseProgressBanner from "../RebaseProgressBanner.vue";

let app: App | null = null;
let container: HTMLElement;
const emitted: string[] = [];

const repoState = (over: Record<string, unknown> = {}) => ({
  state: "rebase_interactive",
  hasConflict: false,
  operationHead: "abcdef1",
  targetBranch: "feature/topic",
  done: 1,
  total: 3,
  ...over,
});

beforeEach(() => {
  localStorage.clear();
  emitted.length = 0;
});

afterEach(() => {
  app?.unmount();
  app = null;
  container?.remove();
});

function mountBanner(props: Record<string, unknown>) {
  const Wrapper = defineComponent({
    setup() {
      return () =>
        h(RebaseProgressBanner, {
          cwd: "/repo",
          repoState: repoState(),
          ...props,
          onSplit: () => emitted.push("split"),
        } as never);
    },
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  app = createApp(Wrapper);
  app.mount(container);
}

const splitBtn = () => container.querySelector<HTMLButtonElement>(".rpm-btn--split");
const buttonTexts = () =>
  [...container.querySelectorAll(".rpm-actions .rpm-btn")].map((b) => b.textContent!.trim());

describe("RebaseProgressBanner — split affordance", () => {
  it("offers Split at a clean halt on a commit marked for splitting", () => {
    mountBanner({ pendingSplit: true });
    expect(splitBtn(), "the affordance #128 lost is back").not.toBeNull();
  });

  it("does NOT offer Split at a conflict halt, where HEAD is the wrong commit", () => {
    // The whole reason the gate exists: splitting here would reset past the
    // parent and split the previous commit.
    mountBanner({ pendingSplit: true, repoState: repoState({ hasConflict: true }) });
    expect(splitBtn(), "must not offer to split the wrong commit").toBeNull();
  });

  it("does not offer Split when the commit was never marked", () => {
    mountBanner({ pendingSplit: false });
    expect(splitBtn()).toBeNull();
  });

  it("treats an absent pendingSplit prop as 'no split', not as truthy", () => {
    mountBanner({});
    expect(splitBtn()).toBeNull();
  });

  it("emits split exactly once per click", async () => {
    mountBanner({ pendingSplit: true });
    splitBtn()!.click();
    await nextTick();
    expect(emitted).toEqual(["split"]);
  });

  it("is disabled while another rebase action is in flight", () => {
    // Overlapping git operations on the same repo is exactly what the shared
    // busy flag exists to prevent.
    mountBanner({ pendingSplit: true, autoResolving: true });
    expect(splitBtn()!.disabled).toBe(true);
  });

  it("demotes Continue while Split is offered, so two primaries do not compete", () => {
    mountBanner({ pendingSplit: true });
    const primaries = [...container.querySelectorAll(".rpm-actions .rpm-btn--primary")];
    expect(primaries, "Split is the only primary").toHaveLength(1);
    expect(primaries[0].className).toContain("rpm-btn--split");
  });

  it("leaves Continue primary when there is no split to offer", () => {
    mountBanner({ pendingSplit: false });
    const primaries = [...container.querySelectorAll(".rpm-actions .rpm-btn--primary")];
    expect(primaries).toHaveLength(1);
    expect(primaries[0].className).not.toContain("rpm-btn--split");
  });

  it("keeps Continue disabled while conflicted, as it always was", () => {
    // Guarding the pre-existing behaviour the new class binding sits on top of.
    mountBanner({ pendingSplit: false, repoState: repoState({ hasConflict: true }) });
    const all = [...container.querySelectorAll<HTMLButtonElement>(".rpm-actions .rpm-btn")];
    const cont = all[all.length - 1];
    expect(cont!.disabled).toBe(true);
  });

  it("still renders Abort, Skip and Continue alongside Split", () => {
    mountBanner({ pendingSplit: true });
    expect(buttonTexts().length, "Split is additive, not a replacement").toBeGreaterThanOrEqual(4);
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ref, nextTick } from "vue";

// `listPRs` must be created via `vi.hoisted()`: usePrPanel.ts's import chain is
// long enough that Vitest evaluates the "../forge/useForge" mock factory before
// a plain top-level `const listPRs = vi.fn()` in this file would have run,
// throwing "Cannot access 'listPRs' before initialization". `vi.hoisted()`
// guarantees the initializer runs first regardless of import graph shape.
const { listPRs } = vi.hoisted(() => ({ listPRs: vi.fn() }));

vi.mock("../../utils/backend", () => ({
  gitRemoteInfo: vi.fn(async () => null),
  gitFileCount: vi.fn(async () => 0),
  ghForkInfo: vi.fn(async () => ({ isFork: false, origin: "", parent: "" })),
}));

vi.mock("../forge/useForge", () => ({
  forgeFromRemoteInfo: vi.fn(() => ({ name: "github", listPRs })),
  githubProvider: { name: "github", listPRs },
}));

import { usePrPanel } from "../usePrPanel";
import { _resetPrCacheForTesting } from "../usePrCache";

function makePr(n: number) {
  return {
    number: n, title: `PR ${n}`, state: "open", author: "me", branch: `feat-${n}`,
    base: "main", draft: false, createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z", url: `https://x/${n}`, additions: 0,
    deletions: 0, labels: [], assignees: [], reviewRequested: [], reviewDecision: "",
    mergeStateStatus: "", checksRollup: "", commentCount: 0,
  };
}

/** Simulates the Rust layer's naive `offset+limit` pagination over `total` PRs. */
function pagedListPRs(total: number) {
  return vi.fn(async (_cwd: string, opts: { limit: number; offset: number }) => {
    const { limit, offset } = opts;
    if (offset >= total) return [];
    const count = Math.min(limit, total - offset);
    return Array.from({ length: count }, (_, i) => makePr(offset + i + 1));
  });
}

describe("usePrPanel — background prefetch drain", () => {
  beforeEach(() => {
    localStorage.clear();
    _resetPrCacheForTesting();
    listPRs.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("drains beyond the first PAGE_SIZE=10 page in the background", async () => {
    listPRs.mockImplementation(pagedListPRs(45));
    const panel = usePrPanel(ref("/repo"));
    await panel.ensurePrsLoaded();
    expect(panel.prs.value).toHaveLength(10);
    expect(panel.hasMore.value).toBe(true);

    await vi.advanceTimersByTimeAsync(40); // one whenIdle() tick → a BG_PAGE=100 hop

    expect(panel.prs.value).toHaveLength(45);
    expect(panel.hasMore.value).toBe(false);
  });

  it("stops the drain when the repo changes mid-prefetch", async () => {
    listPRs.mockImplementation(pagedListPRs(500));
    const cwd = ref("/repo-a");
    const panel = usePrPanel(cwd);
    await panel.ensurePrsLoaded();
    expect(panel.prs.value).toHaveLength(10);
    expect(listPRs).toHaveBeenCalledTimes(1);

    cwd.value = "/repo-b";
    await nextTick(); // let the cwd watcher reset state before the drain resumes
    await vi.advanceTimersByTimeAsync(40);

    // The stale prefetch for /repo-a must not issue a second call.
    expect(listPRs).toHaveBeenCalledTimes(1);
  });
});

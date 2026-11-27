/**
 * #234 — a background read racing a save must not put the old title or
 * description back. The read (PR detail, PR list) starts before the edit is
 * written and lands after it: the edit is laid over what it brings. A read
 * started after the edit is the forge's own answer and is taken as is.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ref } from "vue";

const ghPrDetail = vi.fn();
const ghPrComments = vi.fn();
const ghPrIssueComments = vi.fn();
const ghPrListReviews = vi.fn();
const ghListPrs = vi.fn();
const ghPrEdit = vi.fn();

vi.mock("@/utils/backend", async () => {
  const actual = await vi.importActual<typeof import("@/utils/backend")>("@/utils/backend");
  return {
    ...actual,
    gitRemoteInfo: vi.fn(async () => ({ url: "", host: "github.com", owner: "o", repo: "r" })),
    ghForkInfo: vi.fn(async () => ({ isFork: false, origin: "", parent: "" })),
    ghPrDetail: (...a: unknown[]) => ghPrDetail(...a),
    ghPrChecks: vi.fn(async () => []),
    ghPrComments: (...a: unknown[]) => ghPrComments(...a),
    ghPrIssueComments: (...a: unknown[]) => ghPrIssueComments(...a),
    ghPrListReviews: (...a: unknown[]) => ghPrListReviews(...a),
    gitFileCount: vi.fn(async () => 0),
    ghPrDiff: vi.fn(async () => ""),
    ghListPrs: (...a: unknown[]) => ghListPrs(...a),
    ghPrEdit: (...a: unknown[]) => ghPrEdit(...a),
  };
});
vi.mock("../../utils/networkGuard", () => ({ requireOnline: vi.fn(async () => true) }));

import { usePrPanel } from "../usePrPanel";

function detail(over: Record<string, unknown> = {}) {
  return {
    number: 1, title: "old title", body: "old body", state: "open", author: "a", branch: "b",
    base: "main", draft: false, createdAt: "", updatedAt: "", mergedAt: "", url: "", additions: 0,
    deletions: 0, changedFiles: 0, comments: 0, reviewComments: 0, labels: [], reviewers: [],
    mergeable: "MERGEABLE", checksStatus: "success", canMerge: true, headSha: "abc", ...over,
  };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("usePrPanel — a read racing a save (#234)", () => {
  beforeEach(() => {
    ghPrDetail.mockReset().mockResolvedValue(detail());
    ghPrComments.mockReset().mockResolvedValue([]);
    ghPrIssueComments.mockReset().mockResolvedValue([]);
    ghPrListReviews.mockReset().mockResolvedValue([]);
    ghListPrs.mockReset().mockResolvedValue([detail()]);
    ghPrEdit.mockReset().mockResolvedValue(undefined);
  });

  it("a detail revalidation started before the save keeps the saved title and body", async () => {
    const p = usePrPanel(ref("/repo"));
    await p.selectPr({ number: 1 } as any);
    expect(p.prDetail.value?.title).toBe("old title");

    // A background revalidation reads the PR, then is held.
    const held = deferred<unknown>();
    ghPrDetail.mockReturnValueOnce(held.promise);
    const revalidation = p.revalidateOpenDetail();

    expect(await p.updatePr(1, { title: "new title", body: "new body" })).toBe(true);
    expect(p.prDetail.value).toMatchObject({ title: "new title", body: "new body" });

    // Its answer, read before the save, lands after it.
    held.resolve(detail());
    await revalidation;
    expect(p.prDetail.value).toMatchObject({ title: "new title", body: "new body" });
  });

  it("a detail read started after the save is taken as the forge answers", async () => {
    const p = usePrPanel(ref("/repo"));
    await p.selectPr({ number: 1 } as any);
    await p.updatePr(1, { title: "new title" });

    // Someone renames it again on the forge: a later read shows that.
    ghPrDetail.mockResolvedValueOnce(detail({ title: "renamed on the forge" }));
    await p.revalidateOpenDetail();
    expect(p.prDetail.value?.title).toBe("renamed on the forge");
  });

  it("a next-page load started before the save keeps the saved title", async () => {
    // A full first page, so there is a next one to load.
    ghListPrs.mockResolvedValueOnce(Array.from({ length: 10 }, (_, i) => detail({ number: 100 + i })));
    const p = usePrPanel(ref("/repo"));
    await p.loadPrs();
    await p.selectPr({ number: 1 } as any);

    const held = deferred<unknown>();
    ghListPrs.mockReturnValueOnce(held.promise);
    const more = p.loadMorePrs();
    await flush();

    await p.updatePr(1, { title: "new title" });
    held.resolve([detail()]);
    await more;
    expect(p.prs.value.find((pr) => pr.number === 1)?.title).toBe("new title");
  });

  it("a list load started before the save keeps the saved title", async () => {
    const p = usePrPanel(ref("/repo"));
    await p.loadPrs();
    await p.selectPr({ number: 1 } as any);

    const held = deferred<unknown>();
    ghListPrs.mockReturnValueOnce(held.promise);
    const load = p.loadPrs();
    await flush();

    await p.updatePr(1, { title: "new title" });
    held.resolve([detail()]);
    await load;
    expect(p.prs.value.find((pr) => pr.number === 1)?.title).toBe("new title");
  });
});

/**
 * Task F2 (v3.6.0) — Azure comment edit/delete capability.
 *
 * `usePrPanel` exposes `forgeSupportsCommentEdit`/`forgeSupportsCommentDelete`
 * computeds so the UI (PrCommentThread, via PrInlineDiff) can hide the edit/
 * delete affordance instead of calling into a forge that throws
 * `ForgeNotImplementedError`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ref } from "vue";

const gitRemoteInfo = vi.fn();
const ghPrDetail = vi.fn();
const ghPrComments = vi.fn();
const azPrDetail = vi.fn();
const azPrComments = vi.fn();

vi.mock("@/utils/backend", async () => {
  const actual = await vi.importActual<typeof import("@/utils/backend")>("@/utils/backend");
  return {
    ...actual,
    gitRemoteInfo: (...a: unknown[]) => gitRemoteInfo(...a),
    ghForkInfo: vi.fn(async () => ({ isFork: false, origin: "", parent: "" })),
    ghPrDetail: (...a: unknown[]) => ghPrDetail(...a),
    ghPrComments: (...a: unknown[]) => ghPrComments(...a),
    azPrDetail: (...a: unknown[]) => azPrDetail(...a),
    azPrComments: (...a: unknown[]) => azPrComments(...a),
  };
});

import { usePrPanel } from "../usePrPanel";
import { ForgeNotImplementedError } from "../forge/types";

function fakeDetail() {
  return {
    number: 1, title: "t", body: "", state: "open", author: "a", branch: "b", base: "main",
    draft: false, createdAt: "", updatedAt: "", mergedAt: "", url: "", additions: 0, deletions: 0,
    changedFiles: 0, comments: 0, reviewComments: 0, labels: [], reviewers: [], mergeable: "MERGEABLE",
    checksStatus: "success", canMerge: true, headSha: "sha1",
  };
}

describe("usePrPanel — comment edit/delete capability (F2)", () => {
  beforeEach(() => {
    gitRemoteInfo.mockReset().mockResolvedValue({ url: "", host: "github.com", provider: "github", owner: "o", repo: "r" });
    ghPrDetail.mockReset().mockResolvedValue(fakeDetail());
    ghPrComments.mockReset().mockResolvedValue([]);
    azPrDetail.mockReset().mockResolvedValue(fakeDetail());
    azPrComments.mockReset().mockResolvedValue([]);
  });

  it("is true for GitHub", async () => {
    const p = usePrPanel(ref("/repo"));
    await p.selectPr({ number: 1 } as any);
    expect(p.forgeSupportsCommentEdit.value).toBe(true);
    expect(p.forgeSupportsCommentDelete.value).toBe(true);
  });

  it("is false for Azure", async () => {
    gitRemoteInfo.mockResolvedValue({ url: "https://dev.azure.com/o/r", host: "dev.azure.com", provider: "azure", owner: "o", repo: "r" });
    const p = usePrPanel(ref("/repo"));
    await p.loadRemote();
    await p.selectPr({ number: 1 } as any);
    expect(p.forge.value.name).toBe("azure");
    expect(p.forgeSupportsCommentEdit.value).toBe(false);
    expect(p.forgeSupportsCommentDelete.value).toBe(false);
  });

  it("handleEditComment swallows ForgeNotImplementedError without setting `error`", async () => {
    const p = usePrPanel(ref("/repo"));
    await p.selectPr({ number: 1 } as any);
    (p.forge.value as any).updateComment = vi.fn().mockRejectedValue(new ForgeNotImplementedError("azure", "updateComment"));
    await p.handleEditComment(1, "new body");
    expect(p.error.value).toBeNull();
  });

  it("handleDeleteComment swallows ForgeNotImplementedError without setting `error`", async () => {
    const p = usePrPanel(ref("/repo"));
    await p.selectPr({ number: 1 } as any);
    (p.forge.value as any).deleteComment = vi.fn().mockRejectedValue(new ForgeNotImplementedError("azure", "deleteComment"));
    await p.handleDeleteComment(1);
    expect(p.error.value).toBeNull();
  });

  it("handleDeleteComment on a thread root keeps its replies, which the forge keeps too", async () => {
    const p = usePrPanel(ref("/repo"));
    await p.selectPr({ number: 1 } as any);
    const c = (id: number, in_reply_to_id: number | null) =>
      ({ id, in_reply_to_id, path: "a.ts", body: "", user: "u", created_at: "", updated_at: "" }) as any;
    p.prComments.value = [c(1, null), c(2, 1), c(3, 1)];
    p.prDetail.value!.reviewComments = 3;
    (p.forge.value as any).deleteComment = vi.fn().mockResolvedValue(undefined);
    await p.handleDeleteComment(1);
    expect(p.prComments.value.map((x: any) => x.id)).toEqual([2, 3]);
    expect(p.prDetail.value!.reviewComments).toBe(2);
  });

  it("handleReplyComment counts the reply in reviewComments", async () => {
    const p = usePrPanel(ref("/repo"));
    await p.selectPr({ number: 1 } as any);
    p.prDetail.value!.reviewComments = 1;
    (p.forge.value as any).createComment = vi.fn().mockResolvedValue(
      { id: 9, in_reply_to_id: 1, path: "a.ts", body: "r", user: "u", created_at: "", updated_at: "" },
    );
    expect(await p.handleReplyComment(1, "r")).toBe(true);
    expect(p.prDetail.value!.reviewComments).toBe(2);
  });
});

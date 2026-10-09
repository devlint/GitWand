import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ScratchWorktree } from "../../utils/backend";

vi.mock("../../utils/backend", () => ({
  scratchWorktreeCreate: vi.fn(),
  scratchWorktreeMergeBack: vi.fn(),
  scratchWorktreeDiscard: vi.fn(),
}));

import {
  scratchWorktreeCreate,
  scratchWorktreeMergeBack,
  scratchWorktreeDiscard,
} from "../../utils/backend";
import { useScratchWorktree } from "../useScratchWorktree";

const mockCreate = vi.mocked(scratchWorktreeCreate);
const mockMergeBack = vi.mocked(scratchWorktreeMergeBack);
const mockDiscard = vi.mocked(scratchWorktreeDiscard);

const WT: ScratchWorktree = {
  path: "/repos/gitwand-scratch-123",
  branch: "gitwand-scratch-123",
  source_branch: "feature",
  created_at: 123,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useScratchWorktree", () => {
  it("creates with the current cwd and exposes the active worktree", async () => {
    mockCreate.mockResolvedValue(WT);
    const { active, create } = useScratchWorktree(() => "/repos/main");

    const wt = await create("feature");

    expect(wt).toEqual(WT);
    expect(active.value).toEqual(WT);
    expect(mockCreate).toHaveBeenCalledWith("/repos/main", "feature");
  });

  it("merge-back targets the ORIGIN cwd captured at create time, not the current cwd", async () => {
    mockCreate.mockResolvedValue(WT);
    mockMergeBack.mockResolvedValue({ cleanup_warning: null });

    // The getter starts on the main repo, then flips to the scratch path —
    // simulating the user switching to the scratch tab after creation.
    let currentCwd = "/repos/main";
    const { create, mergeBack } = useScratchWorktree(() => currentCwd);

    await create("feature");
    currentCwd = "/repos/gitwand-scratch-123"; // tab switched to the scratch

    const ok = await mergeBack();

    expect(ok).toBe(true);
    // Critical: must use the captured origin, NOT the now-active scratch cwd.
    // Third arg: the snapshotsEnabled setting (default on).
    expect(mockMergeBack).toHaveBeenCalledWith("/repos/main", WT.path, true);
  });

  it("merge-back that merged but could not remove the scratch succeeds with a warning", async () => {
    mockCreate.mockResolvedValue(WT);
    mockMergeBack.mockResolvedValue({ cleanup_warning: "worktree is locked" });
    const { active, error, cleanupWarning, create, mergeBack } = useScratchWorktree(() => "/repos/main");

    await create("feature");
    const ok = await mergeBack();

    expect(ok).toBe(true);
    expect(active.value).toBeNull();
    expect(error.value).toBeNull();
    expect(cleanupWarning.value).toBe("worktree is locked");

    // The next operation starts clean.
    await create("feature");
    expect(cleanupWarning.value).toBeNull();
  });

  it("discard targets the ORIGIN cwd and clears state", async () => {
    mockCreate.mockResolvedValue(WT);
    mockDiscard.mockResolvedValue(undefined);

    let currentCwd = "/repos/main";
    const { active, create, discard } = useScratchWorktree(() => currentCwd);

    await create();
    currentCwd = "/repos/gitwand-scratch-123";

    const ok = await discard();

    expect(ok).toBe(true);
    expect(mockDiscard).toHaveBeenCalledWith("/repos/main", WT.path);
    expect(active.value).toBeNull();
  });

  it("merge-back / discard are no-ops with no active scratch", async () => {
    const { mergeBack, discard } = useScratchWorktree(() => "/repos/main");

    expect(await mergeBack()).toBe(false);
    expect(await discard()).toBe(false);
    expect(mockMergeBack).not.toHaveBeenCalled();
    expect(mockDiscard).not.toHaveBeenCalled();
  });

  it("surfaces a create failure as an error and leaves no active scratch", async () => {
    mockCreate.mockRejectedValue(new Error("worktree add failed"));
    const { active, error, create } = useScratchWorktree(() => "/repos/main");

    const wt = await create();

    expect(wt).toBeNull();
    expect(active.value).toBeNull();
    expect(error.value).toMatch(/worktree add failed/);
  });
});

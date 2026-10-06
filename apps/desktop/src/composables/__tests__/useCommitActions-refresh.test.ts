// @vitest-environment jsdom
//
// `useCommitActions` reaches `../../utils/backend`, which reads `window` at
// import time (apps/desktop/src/CLAUDE.md § Tests Vitest).
/**
 * Reset / checkout to a commit must force the log reload.
 *
 * The canonical (all-refs) log keeps its current entries when the top commit
 * is unchanged. A reset that leaves `origin/<branch>` on the newest commit does
 * exactly that, so an unforced reload kept the old branch/HEAD labels in the
 * Git Tree until the next periodic fetch (up to 30 s later).
 *
 * The git layer is not mocked: `src/utils/backend` is, which is the IPC
 * wrapper module.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ref } from "vue";

// useAIProvider probes the Claude CLI at import time and chains `.then` on it.
vi.mock("../../utils/backend", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../utils/backend")>();
  const mocked = Object.fromEntries(
    Object.entries(mod).map(([k, v]) => [k, typeof v === "function" ? vi.fn() : v]),
  );
  return {
    ...mocked,
    detectClaudeCli: vi.fn(async () => ({ found: false, logged_in: false })),
  };
});

import { useCommitActions } from "../useCommitActions";
import { gitResetToCommit, gitCheckoutCommit, type GitLogEntry } from "../../utils/backend";

const ENTRY = { hash: "abc1234", hashFull: "abc1234" + "0".repeat(33) } as GitLogEntry;

function makeActions() {
  const repoRefresh = vi.fn(async (_forceLog?: boolean) => {});
  const actions = useCommitActions({
    repoFolderPath: ref("/repos/alpha"),
    repoError: ref(null),
    loadBranches: vi.fn(),
    repoRefresh,
    cherryPick: vi.fn(async () => {}),
    deleteBranch: vi.fn(async () => {}),
    deleteRemoteBranch: vi.fn(async () => {}),
    deleteTag: vi.fn(async () => {}),
    deleteRemoteTag: vi.fn(async () => {}),
  });
  return { actions, repoRefresh };
}

beforeEach(() => {
  vi.mocked(gitResetToCommit).mockReset().mockResolvedValue(null);
  vi.mocked(gitCheckoutCommit).mockReset().mockResolvedValue(null);
});

describe("useCommitActions — refresh after HEAD moves", () => {
  it.each(["soft", "mixed", "hard"] as const)("reset --%s forces the log reload", async (mode) => {
    const { actions, repoRefresh } = makeActions();
    actions.handleResetToCommit(ENTRY, mode);
    await vi.waitFor(() => expect(repoRefresh).toHaveBeenCalled());
    expect(gitResetToCommit).toHaveBeenCalledWith("/repos/alpha", ENTRY.hashFull, mode, expect.anything());
    expect(repoRefresh).toHaveBeenCalledWith(true);
  });

  it("checkout of a commit forces the log reload", async () => {
    const { actions, repoRefresh } = makeActions();
    actions.handleCheckoutCommit(ENTRY);
    await actions.confirmCheckoutCommit();
    expect(gitCheckoutCommit).toHaveBeenCalled();
    expect(repoRefresh).toHaveBeenCalledWith(true);
  });
});

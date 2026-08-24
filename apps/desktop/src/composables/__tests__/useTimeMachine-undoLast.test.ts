import { describe, it, expect, vi, beforeEach } from "vitest";

const backend = vi.hoisted(() => ({
  snapshotCreate: vi.fn(),
  snapshotList: vi.fn(),
  snapshotRestore: vi.fn(),
  snapshotPrune: vi.fn(),
  gitExec: vi.fn(),
}));

vi.mock("../../utils/backend", () => backend);

import { useTimeMachine } from "../useTimeMachine";

const snap = (id: string, kind = "discard") => ({
  id,
  commit: "a".repeat(40),
  kind,
  label: `label ${id}`,
  timestampMs: Number(id.split("-")[0]),
  headSha: "b".repeat(40),
  headRef: "main",
  mergeHead: null,
});

describe("useTimeMachine.undoLast", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // No reflog: `git reflog` output is empty.
    backend.gitExec.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
  });

  it("refreshes before choosing a target, so a backend-side snapshot is seen", async () => {
    // The regression: discard/reset/checkout create their snapshot in Rust,
    // never through `capture()`, so the frontend list is stale until
    // something refreshes it. Without this, ⌘Z reported "nothing to undo"
    // for the very operation it was meant to undo.
    backend.snapshotList.mockResolvedValue([snap("2000-abcdabcd")]);
    backend.snapshotRestore.mockResolvedValue(snap("3000-eeeeeeee", "pre-restore"));

    const tm = useTimeMachine();
    expect(tm.timeline.value).toHaveLength(0); // nothing cached yet

    const did = await tm.undoLast("/repo");

    expect(did).toBe(true);
    expect(backend.snapshotRestore).toHaveBeenCalledWith("/repo", "2000-abcdabcd");
  });

  it("reports false when there is genuinely nothing restorable", async () => {
    backend.snapshotList.mockResolvedValue([]);
    const tm = useTimeMachine();
    expect(await tm.undoLast("/repo")).toBe(false);
    expect(backend.snapshotRestore).not.toHaveBeenCalled();
  });
});

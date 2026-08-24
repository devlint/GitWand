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

const HEAD_AT_SNAPSHOT = "b048e483588a0571efd0b945bd685e324c337571";

const snap = () => ({
  id: "2000-abcdabcd",
  commit: "a".repeat(40),
  kind: "discard",
  label: "Discard 1 file(s)",
  timestampMs: 2000,
  headSha: HEAD_AT_SNAPSHOT,
  headRef: "main",
  mergeHead: null,
});

/** One reflog line, in useUndoStack's `%h\t%gd\t%gs\t%cr\t%ct` shape. */
function reflog(shortHash: string, subject: string) {
  return `${shortHash}\tHEAD@{0}\t${subject}\t1 minute ago\t1787598000`;
}

describe("useTimeMachine.restoreSnapshotById", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    backend.snapshotList.mockResolvedValue([snap()]);
    backend.snapshotRestore.mockResolvedValue({ ...snap(), kind: "pre-restore" });
  });

  it("restores when the repo is still where the snapshot left it", async () => {
    backend.gitExec.mockResolvedValue({
      exitCode: 0,
      stdout: reflog(HEAD_AT_SNAPSHOT.slice(0, 7), "commit: earlier work"),
      stderr: "",
    });
    const tm = useTimeMachine();
    expect(await tm.restoreSnapshotById("/repo", "2000-abcdabcd")).toBe("restored");
    expect(backend.snapshotRestore).toHaveBeenCalledWith("/repo", "2000-abcdabcd");
  });

  it("refuses once HEAD has moved past the snapshot", async () => {
    // Restoring a snapshot rewinds HEAD to where it was, so it would also
    // drop a commit made after it. That is fine from the Time Machine, which
    // confirms first; it is not fine from a one-click toast.
    backend.gitExec.mockResolvedValue({
      exitCode: 0,
      stdout: reflog("deadbee", "commit: made after the snapshot"),
      stderr: "",
    });
    const tm = useTimeMachine();
    expect(await tm.restoreSnapshotById("/repo", "2000-abcdabcd")).toBe("moved");
    expect(backend.snapshotRestore).not.toHaveBeenCalled();
  });

  it("reports a snapshot that is no longer there", async () => {
    backend.snapshotList.mockResolvedValue([]);
    backend.gitExec.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    const tm = useTimeMachine();
    expect(await tm.restoreSnapshotById("/repo", "gone")).toBe("missing");
    expect(backend.snapshotRestore).not.toHaveBeenCalled();
  });
});

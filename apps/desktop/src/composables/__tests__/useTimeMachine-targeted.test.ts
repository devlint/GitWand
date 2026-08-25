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

/** Seconds, as git reports them. The snapshot sits between the two. */
const BEFORE = 1_787_598_000;
const SNAPSHOT_MS = 1_787_598_500_000;
const AFTER = 1_787_599_000;

const snap = (kind = "discard") => ({
  id: "2000-abcdabcd",
  commit: "a".repeat(40),
  kind,
  label: "Discard 1 file(s)",
  timestampMs: SNAPSHOT_MS,
  headSha: "b048e483588a0571efd0b945bd685e324c337571",
  headRef: "main",
  mergeHead: null,
});

/** One reflog line, in useUndoStack's `%h\t%gd\t%gs\t%cr\t%ct` shape. */
function reflog(shortHash: string, subject: string, ct: number) {
  return `${shortHash}\tHEAD@{0}\t${subject}\t1 minute ago\t${ct}`;
}

describe("useTimeMachine.restoreSnapshotById", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    backend.snapshotList.mockResolvedValue([snap()]);
    backend.snapshotRestore.mockResolvedValue({ ...snap(), kind: "pre-restore" });
  });

  it("restores when nothing has happened since the snapshot", async () => {
    backend.gitExec.mockResolvedValue({
      exitCode: 0,
      stdout: reflog("aaaaaaa", "commit: earlier work", BEFORE),
      stderr: "",
    });
    const tm = useTimeMachine();
    expect(await tm.restoreSnapshotById("/repo", "2000-abcdabcd")).toBe("restored");
    expect(backend.snapshotRestore).toHaveBeenCalledWith("/repo", "2000-abcdabcd");
  });

  it("still restores after a reset, whose own operation moved HEAD", async () => {
    // reset / checkout / branch-switch move HEAD themselves, so the snapshot's
    // recorded headSha is by definition not where HEAD sits afterwards.
    // Treating that alone as "the repo moved on" would leave the toast dead
    // for three of its four paths.
    backend.snapshotList.mockResolvedValue([snap("reset")]);
    backend.gitExec.mockResolvedValue({
      exitCode: 0,
      stdout: reflog("0000fff", "reset: moving to HEAD~1", AFTER),
      stderr: "",
    });
    const tm = useTimeMachine();
    expect(await tm.restoreSnapshotById("/repo", "2000-abcdabcd")).toBe("restored");
  });

  it("refuses once a commit has landed on top of the snapshot", async () => {
    // Restoring rewinds HEAD to where the snapshot recorded it, so it would
    // drop that commit. Fine from the Time Machine, which confirms first; not
    // fine from a one-click toast whose label only promised to undo a discard.
    backend.gitExec.mockResolvedValue({
      exitCode: 0,
      stdout: reflog("deadbee", "commit: made after the snapshot", AFTER),
      stderr: "",
    });
    const tm = useTimeMachine();
    expect(await tm.restoreSnapshotById("/repo", "2000-abcdabcd")).toBe("moved");
    expect(backend.snapshotRestore).not.toHaveBeenCalled();
  });

  it("refuses after a merge, which also creates a commit", async () => {
    backend.gitExec.mockResolvedValue({
      exitCode: 0,
      stdout: reflog("deadbee", "merge feat: Merge made by the 'ort' strategy.", AFTER),
      stderr: "",
    });
    const tm = useTimeMachine();
    expect(await tm.restoreSnapshotById("/repo", "2000-abcdabcd")).toBe("moved");
  });

  it("reports a snapshot that is no longer there", async () => {
    backend.snapshotList.mockResolvedValue([]);
    backend.gitExec.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    const tm = useTimeMachine();
    expect(await tm.restoreSnapshotById("/repo", "gone")).toBe("missing");
    expect(backend.snapshotRestore).not.toHaveBeenCalled();
  });
});

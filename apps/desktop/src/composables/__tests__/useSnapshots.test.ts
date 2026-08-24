import { describe, it, expect, vi, beforeEach } from "vitest";

const backend = vi.hoisted(() => ({
  snapshotCreate: vi.fn(),
  snapshotList: vi.fn(),
  snapshotRestore: vi.fn(),
  snapshotPrune: vi.fn(),
}));

vi.mock("../../utils/backend", () => backend);

import { useSnapshots } from "../useSnapshots";

const meta = (id: string, kind = "manual") => ({
  id,
  commit: "a".repeat(40),
  kind,
  label: `label ${id}`,
  timestampMs: Number(id),
  headSha: "b".repeat(40),
  headRef: "main",
  mergeHead: null,
});

describe("useSnapshots", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Module-level state is shared by design (one active repo), so each test
    // starts from a known list rather than inheriting the previous one's.
    backend.snapshotList.mockResolvedValue([]);
  });

  it("refresh loads the list", async () => {
    backend.snapshotList.mockResolvedValue([meta("2"), meta("1")]);
    const s = useSnapshots();
    await s.refresh("/repo");
    expect(s.snapshots.value.map((x) => x.id)).toEqual(["2", "1"]);
    expect(s.lastError.value).toBeNull();
  });

  it("refresh surfaces a backend failure instead of throwing", async () => {
    backend.snapshotList.mockRejectedValue(new Error("not a repo"));
    const s = useSnapshots();
    await expect(s.refresh("/repo")).resolves.toBeUndefined();
    expect(s.lastError.value).toContain("not a repo");
  });

  it("capture prepends the new snapshot without a round-trip", async () => {
    backend.snapshotList.mockResolvedValue([meta("1")]);
    backend.snapshotCreate.mockResolvedValue(meta("2", "resolution"));
    const s = useSnapshots();
    await s.refresh("/repo");
    const created = await s.capture("/repo", "resolution", "before apply");
    expect(created?.id).toBe("2");
    expect(s.snapshots.value.map((x) => x.id)).toEqual(["2", "1"]);
    expect(backend.snapshotList).toHaveBeenCalledTimes(1);
  });

  it("capture on a repo with no HEAD adds nothing", async () => {
    backend.snapshotList.mockResolvedValue([meta("1")]);
    backend.snapshotCreate.mockResolvedValue(null);
    const s = useSnapshots();
    await s.refresh("/repo");
    expect(await s.capture("/repo", "manual", "x")).toBeNull();
    expect(s.snapshots.value.map((x) => x.id)).toEqual(["1"]);
  });

  it("capture failure is swallowed and surfaced, never thrown", async () => {
    backend.snapshotCreate.mockRejectedValue(new Error("disk full"));
    const s = useSnapshots();
    await expect(s.capture("/repo", "manual", "x")).resolves.toBeNull();
    expect(s.lastError.value).toContain("disk full");
  });

  it("restore stores the returned pre-restore snapshot as the redo target", async () => {
    backend.snapshotRestore.mockResolvedValue(meta("9", "pre-restore"));
    backend.snapshotList.mockResolvedValue([meta("9", "pre-restore"), meta("1")]);
    const s = useSnapshots();
    await s.restore("/repo", "1");
    expect(s.redoTarget.value?.id).toBe("9");
    expect(backend.snapshotList).toHaveBeenCalledWith("/repo");
  });

  it("restore rethrows so callers can show a modal", async () => {
    backend.snapshotRestore.mockRejectedValue(new Error("not found"));
    const s = useSnapshots();
    await expect(s.restore("/repo", "nope")).rejects.toThrow("not found");
    expect(s.lastError.value).toContain("not found");
  });

  it("prune only re-lists when something was actually deleted", async () => {
    const s = useSnapshots();

    backend.snapshotPrune.mockResolvedValue(0);
    expect(await s.prune("/repo", 14, 200)).toBe(0);
    expect(backend.snapshotList).not.toHaveBeenCalled();

    backend.snapshotPrune.mockResolvedValue(3);
    expect(await s.prune("/repo", 14, 200)).toBe(3);
    expect(backend.snapshotList).toHaveBeenCalledTimes(1);
  });
});

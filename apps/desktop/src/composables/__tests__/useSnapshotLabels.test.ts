import { describe, it, expect, vi, beforeEach } from "vitest";

const backend = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
}));
const ai = vi.hoisted(() => ({
  rawPrompt: vi.fn(),
  isAvailable: { value: true },
}));

vi.mock("../../utils/backend", () => backend);
vi.mock("../useAIProvider", () => ({ useAIProvider: () => ai }));

import { useSnapshotLabels } from "../useSnapshotLabels";

const snap = {
  id: "1700000000000-abcd1234",
  commit: "a".repeat(40),
  kind: "discard" as const,
  label: "Discard 2 file(s)",
  timestampMs: 1_700_000_000_000,
  headSha: "b".repeat(40),
  headRef: "main",
  mergeHead: null,
};

describe("useSnapshotLabels", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ai.isAvailable.value = true;
    backend.readFile.mockResolvedValue("{}");
  });

  it("load tolerates a missing sidecar file", async () => {
    backend.readFile.mockRejectedValue(new Error("ENOENT"));
    const l = useSnapshotLabels();
    await l.load("/repo");
    expect(l.labels.value).toEqual({});
  });

  it("load tolerates a corrupt sidecar file", async () => {
    backend.readFile.mockResolvedValue("{not json");
    const l = useSnapshotLabels();
    await l.load("/repo");
    expect(l.labels.value).toEqual({});
  });

  it("generate stores the model's one-liner and persists it", async () => {
    ai.rawPrompt.mockResolvedValue("Discarded the half-finished parser rewrite\n");
    const l = useSnapshotLabels();
    await l.load("/repo");
    const text = await l.generate("/repo", snap);
    expect(text).toBe("Discarded the half-finished parser rewrite");
    expect(l.labels.value[snap.id]).toBe("Discarded the half-finished parser rewrite");
    expect(backend.writeFile).toHaveBeenCalledTimes(1);
  });

  it("keeps only the first line of a chatty model answer", async () => {
    ai.rawPrompt.mockResolvedValue("Rewound the parser work\n\nLet me know if…");
    const l = useSnapshotLabels();
    await l.load("/repo");
    expect(await l.generate("/repo", snap)).toBe("Rewound the parser work");
  });

  it("returns the cached label without calling the model twice", async () => {
    backend.readFile.mockResolvedValue(JSON.stringify({ [snap.id]: "cached" }));
    const l = useSnapshotLabels();
    await l.load("/repo");
    expect(await l.generate("/repo", snap)).toBe("cached");
    expect(ai.rawPrompt).not.toHaveBeenCalled();
  });

  it("returns null when no AI provider is configured", async () => {
    ai.isAvailable.value = false;
    const l = useSnapshotLabels();
    await l.load("/repo");
    expect(await l.generate("/repo", snap)).toBeNull();
    expect(ai.rawPrompt).not.toHaveBeenCalled();
  });

  it("clears the pending flag even when the model fails", async () => {
    ai.rawPrompt.mockRejectedValue(new Error("rate limited"));
    const l = useSnapshotLabels();
    await l.load("/repo");
    expect(await l.generate("/repo", snap)).toBeNull();
    expect(l.pending.value.has(snap.id)).toBe(false);
  });
});

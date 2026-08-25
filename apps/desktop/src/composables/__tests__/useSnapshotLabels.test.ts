// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

const ai = vi.hoisted(() => ({
  rawPrompt: vi.fn(),
  isAvailable: { value: true },
}));

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
    localStorage.clear();
  });

  it("load starts empty when nothing was stored", async () => {
    const l = useSnapshotLabels();
    await l.load("/repo");
    expect(l.labels.value).toEqual({});
  });

  it("load tolerates a corrupt store entry", async () => {
    localStorage.setItem("gitwand-snapshot-labels", "{not json");
    const l = useSnapshotLabels();
    await l.load("/repo");
    expect(l.labels.value).toEqual({});
  });

  it("keeps each repo's labels separate", async () => {
    ai.rawPrompt.mockResolvedValue("label for repo A\n");
    const l = useSnapshotLabels();
    await l.load("/repo-a");
    await l.generate("/repo-a", snap);
    expect(l.labels.value[snap.id]).toBe("label for repo A");

    await l.load("/repo-b");
    expect(l.labels.value).toEqual({});

    await l.load("/repo-a");
    expect(l.labels.value[snap.id]).toBe("label for repo A");
  });

  it("persists across a reload of the composable state", async () => {
    ai.rawPrompt.mockResolvedValue("persisted\n");
    const l = useSnapshotLabels();
    await l.load("/repo");
    await l.generate("/repo", snap);
    // Simulate a fresh session reading the same store.
    l.labels.value = {};
    await l.load("/repo");
    expect(l.labels.value[snap.id]).toBe("persisted");
  });

  it("generate stores the model's one-liner and persists it", async () => {
    ai.rawPrompt.mockResolvedValue("Discarded the half-finished parser rewrite\n");
    const l = useSnapshotLabels();
    await l.load("/repo");
    const text = await l.generate("/repo", snap);
    expect(text).toBe("Discarded the half-finished parser rewrite");
    expect(l.labels.value[snap.id]).toBe("Discarded the half-finished parser rewrite");
  });

  it("keeps only the first line of a chatty model answer", async () => {
    ai.rawPrompt.mockResolvedValue("Rewound the parser work\n\nLet me know if…");
    const l = useSnapshotLabels();
    await l.load("/repo");
    expect(await l.generate("/repo", snap)).toBe("Rewound the parser work");
  });

  it("returns the cached label without calling the model twice", async () => {
    localStorage.setItem(
      "gitwand-snapshot-labels",
      JSON.stringify({ "/repo": { [snap.id]: "cached" } }),
    );
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

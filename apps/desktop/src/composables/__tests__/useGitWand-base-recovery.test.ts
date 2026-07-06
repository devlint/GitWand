import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  OURS_LINE,
  THEIRS_LINE,
  CONTENT_2WAY,
  RECONSTRUCTED_DIFF3,
  mockReconstructConflict,
  mockGetConflictedFiles,
} = vi.hoisted(() => {
  const OURS_LINE = '<div class="flex items-baseline gap-x-3 mr-2">'; // changed from base
  const THEIRS_LINE = '<div class="flex items-baseline gap-x-2 mr-2">'; // == base, unchanged
  const CONTENT_2WAY = [
    "before",
    "<<<<<<< ours",
    OURS_LINE,
    "=======",
    THEIRS_LINE,
    ">>>>>>> theirs",
    "after",
  ].join("\n");
  const RECONSTRUCTED_DIFF3 = [
    "before",
    "<<<<<<< ours",
    OURS_LINE,
    "||||||| base",
    THEIRS_LINE, // base matches theirs → one_side_change (ours changed)
    "=======",
    THEIRS_LINE,
    ">>>>>>> theirs",
    "after",
  ].join("\n");
  return {
    OURS_LINE,
    THEIRS_LINE,
    CONTENT_2WAY,
    RECONSTRUCTED_DIFF3,
    mockReconstructConflict: vi.fn(),
    mockGetConflictedFiles: vi.fn(async () => ["src/foo.html"]),
  };
});

vi.mock("@/utils/backend", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/backend")>();
  return {
    ...actual,
    pickFolder: vi.fn(),
    getConflictedFiles: mockGetConflictedFiles,
    readFile: vi.fn(async () => CONTENT_2WAY),
    writeFile: vi.fn(),
    readGitwandrc: vi.fn(async () => ""),
    getTreeConflicts: vi.fn(async () => []),
    resolveTreeConflict: vi.fn(),
    reconstructConflict: mockReconstructConflict,
    gitStage: vi.fn(),
  };
});

import { useGitWand } from "../useGitWand";

beforeEach(() => {
  mockReconstructConflict.mockClear();
  mockReconstructConflict.mockImplementation(async () => ({
    content: RECONSTRUCTED_DIFF3,
    wtMatchesSide: false,
  }));
  mockGetConflictedFiles.mockClear();
  mockGetConflictedFiles.mockImplementation(async () => ["src/foo.html"]);
});

describe("useGitWand : récupération de base pour conflits 2-way", () => {
  it("enrichit un fichier dont le hunk n'a pas de base et marque baseEnriched", async () => {
    const gw = useGitWand();
    await gw.openPath("/repo");

    expect(mockReconstructConflict).toHaveBeenCalledWith("/repo", "src/foo.html");
    const file = gw.files.value[0];
    expect(file.baseEnriched).toBe(true);
    expect(file.content).toBe(RECONSTRUCTED_DIFF3);
    expect(file.result.hunks[0].type).not.toBe("complex");
    expect(file.result.hunks[0].baseLines.length).toBeGreaterThan(0);
  });
});

describe("useGitWand : garde-fou — abandon si ours/theirs divergent", () => {
  it("n'enrichit pas si la base reconstruite ne correspond pas au working tree", async () => {
    mockReconstructConflict.mockResolvedValueOnce({
      content: [
        "before",
        "<<<<<<< ours",
        "SOMETHING ELSE ENTIRELY", // diverges from CONTENT_2WAY's ours line
        "||||||| base",
        THEIRS_LINE,
        "=======",
        THEIRS_LINE,
        ">>>>>>> theirs",
        "after",
      ].join("\n"),
      wtMatchesSide: false,
    });
    const gw = useGitWand();
    await gw.openPath("/repo");

    const file = gw.files.value[0];
    expect(file.baseEnriched).toBeUndefined();
    expect(file.content).toBe(CONTENT_2WAY);
  });
});

describe("useGitWand : reconstructConflict échoue (add/add) → fallback propre", () => {
  it("garde le résultat non enrichi sans planter si reconstructConflict rejette", async () => {
    mockReconstructConflict.mockRejectedValueOnce(new Error("no index stages for src/foo.html"));
    const gw = useGitWand();
    await gw.openPath("/repo");

    const file = gw.files.value[0];
    expect(file.baseEnriched).toBeUndefined();
    expect(file.content).toBe(CONTENT_2WAY);
    expect(gw.error.value).toBeNull();
  });
});

describe("useGitWand : concurrence de reconstructConflict limitée", () => {
  it("ne lance jamais plus de 4 reconstructConflict en vol simultanément", async () => {
    // 10 fichiers, chacun sans base → chacun déclenche un appel reconstructConflict.
    const manyPaths = Array.from({ length: 10 }, (_, i) => `src/file${i}.html`);
    mockGetConflictedFiles.mockResolvedValueOnce(manyPaths);

    let active = 0;
    let maxActive = 0;
    mockReconstructConflict.mockImplementation(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return { content: RECONSTRUCTED_DIFF3, wtMatchesSide: false };
    });

    const gw = useGitWand();
    await gw.openPath("/repo");

    expect(maxActive).toBeLessThanOrEqual(4);
    expect(mockReconstructConflict).toHaveBeenCalledTimes(10);
  });
});

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

// Spy that delegates to the real implementation — lets tests assert call
// COUNT (the perf property being guarded) without faking resolution logic.
vi.mock("@gitwand/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@gitwand/core")>();
  return {
    ...actual,
    resolveAsync: vi.fn((...args: Parameters<typeof actual.resolveAsync>) => actual.resolveAsync(...args)),
  };
});

import { useGitWand } from "../useGitWand";
import { resolveAsync } from "@gitwand/core";

beforeEach(() => {
  mockReconstructConflict.mockClear();
  mockReconstructConflict.mockImplementation(async () => ({
    content: RECONSTRUCTED_DIFF3,
    wtMatchesSide: false,
  }));
  mockGetConflictedFiles.mockClear();
  mockGetConflictedFiles.mockImplementation(async () => ["src/foo.html"]);
  vi.mocked(resolveAsync).mockClear();
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

  it("n'appelle resolveAsync qu'une seule fois quand l'enrichissement réussit (pas de double classification)", async () => {
    const gw = useGitWand();
    await gw.openPath("/repo");

    // Avant l'optimisation : un premier resolveAsync sur le contenu brut
    // (aucun hunk n'a de base → complex/llm_proposed), puis un second sur le
    // contenu reconstruit — le premier était entièrement superflu puisque le
    // pré-parse sait déjà qu'aucun pattern diff3-only ne peut matcher sans base.
    expect(vi.mocked(resolveAsync)).toHaveBeenCalledTimes(1);
    expect(gw.files.value[0].baseEnriched).toBe(true);
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
    // Fallback path: one attempt on the reconstructed content (rejected by the
    // guard) + one plain classification of the original content — unchanged
    // from before the optimization, since this path was never the wasteful one.
    expect(vi.mocked(resolveAsync)).toHaveBeenCalledTimes(2);
  });
});

describe("useGitWand : garde-fou — contexte hors conflit modifié manuellement", () => {
  it("n'enrichit pas si une ligne hors marqueurs diffère entre le working tree et la reconstruction, même si ours/theirs matchent", async () => {
    // Le hunk ours/theirs est identique à RECONSTRUCTED_DIFF3 (même si1 sameOursTheirs
    // passerait), mais l'utilisateur a édité la ligne "before" hors conflit dans le
    // working tree après coup — reconstructConflict() la reconstruit depuis git,
    // donc sans cette édition. Il ne faut PAS écraser le working tree.
    const editedContent = [
      "before — édité manuellement",
      "<<<<<<< ours",
      OURS_LINE,
      "=======",
      THEIRS_LINE,
      ">>>>>>> theirs",
      "after",
    ].join("\n");
    const { readFile } = await import("@/utils/backend");
    vi.mocked(readFile).mockResolvedValueOnce(editedContent);

    const gw = useGitWand();
    await gw.openPath("/repo");

    const file = gw.files.value[0];
    expect(file.baseEnriched).toBeUndefined();
    expect(file.content).toBe(editedContent);
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

describe("useGitWand : agrégat tier stats câblé sur loadRealFiles", () => {
  it("enregistre les stats du fichier chargé, sans double comptage au refresh", async () => {
    const { useTierStats, __resetTierStatsForTests } = await import("../useTierStats");
    localStorage.clear();
    __resetTierStatsForTests();

    const gw = useGitWand();
    await gw.openPath("/repo");
    const after1 = useTierStats().tierStats.value.totalHunks;
    expect(after1).toBeGreaterThan(0);

    await gw.openPath("/repo"); // même repo, mêmes conflits → dédupliqué
    expect(useTierStats().tierStats.value.totalHunks).toBe(after1);
  });
});
